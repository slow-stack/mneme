import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDreamScheduler,
  hashSnapshot,
  hashDecisionInput,
  buildReceipt,
  parseReceipt,
  buildOutcome
} from "../src/dream.js";
import { applyDecisions } from "../src/dream/decisions.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

// ---------------------------------------------------------------- helpers

/**
 * Minimal DSH-like ctx whose LLM distinguishes the two dream calls by the user
 * prompt shape: consolidation prompts start with "id=…", summary prompts with
 * "- title: content". `onConsolidation` receives the raw list text and returns
 * a decisions JSON string; `summaryText` (or a throw) drives the summary call.
 */
function mockCtx({ onConsolidation, summaryText = "记忆库总览：用户偏好中文。" } = {}) {
  return {
    logger: { warn: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock-model" }) },
    llm: {
      async *stream(options) {
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        if (userText.includes("| type=")) {
          yield { type: "block-start", index: 0, blockType: "text" };
          yield { type: "text-delta", index: 0, text: onConsolidation ? onConsolidation(userText, options.purpose) : "[]" };
          yield { type: "block-end", index: 0, block: { type: "text" } };
          yield { type: "finish", reason: { kind: "stop" } };
          return;
        }
        if (typeof summaryText === "string") {
          yield { type: "text-delta", index: 0, text: summaryText };
          yield { type: "finish", reason: { kind: "stop" } };
        } else {
          throw summaryText instanceof Error ? summaryText : new Error(String(summaryText));
        }
      }
    }
  };
}

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  return { store, service, dream };
}

// ---------------------------------------------------------------- audit rows

test("successful runDream writes an audit row with receipt, decisions and outcome", async () => {
  const { store, service, dream } = setup();
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const ctx = mockCtx({
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "插件总览", content: "合并内容", importance: 4 }
    ])
  });
  const result = await dream.runDream(ctx, service, {});
  assert.equal(result.ok, true);
  assert.equal(result.applied, 1);

  const runs = store.listDreamRuns();
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.status, "ok");
  assert.equal(run.input_count, 2);
  assert.equal(run.applied, 1);
  assert.equal(run.summary_stored, true);
  assert.equal(run.provider, "mock");
  assert.match(run.receipt, /^dsh-mneme:run:/);

  // receipt round-trips and correlates with the audit row
  const parsed = parseReceipt(run.receipt);
  assert.deepEqual(parsed, {
    runId: run.id,
    status: "ok",
    snapshotHash: run.snapshot_hash.slice(0, 12),
    inputCount: 2,
    applied: 1,
    summaryStored: true
  });

  // per-id outcome is derived correctly
  assert.equal(run.outcome.byId[a.id], "merge-archived");
  assert.equal(run.outcome.byId[b.id], "merge-keep");
  // raw decisions are stored for replay
  assert.equal(run.decisions.length, 1);
  assert.equal(run.decisions[0].action, "merge");
  // full input snapshot is persisted and its digest matches — the audit row
  // alone can rebuild the exact arbitration input offline
  assert.equal(run.input.length, 2);
  assert.deepEqual(run.input.map((m) => m.title).sort(), ["插件", "插件2"]);
  assert.equal(hashSnapshot(run.input), run.snapshot_hash, "input snapshot digest matches stored snapshot_hash");
  store.close();
});

// ---------------------------------------------------------------- per-record receipt chain

test("hashDecisionInput is deterministic, order-independent and content-addressed", () => {
  const mk = (id, title, content = "c") => ({ id, title, content, importance: 3 });
  const a = mk("a", "t1");
  const b = mk("b", "t2");
  assert.equal(hashDecisionInput([a, b]), hashDecisionInput([b, a]), "order independent");
  assert.equal(hashDecisionInput([a, b]), hashDecisionInput([{ ...a }, { ...b }]), "clone independent");
  assert.notEqual(hashDecisionInput([a, b]), hashDecisionInput([a, { ...b, content: "changed" }]), "content change flips digest");
  assert.match(hashDecisionInput([]), /^[0-9a-f]{64}$/, "empty input hashes stably");
});

test("runDream writes one per-record receipt per committed merge/conflict/update", async () => {
  const { store, service, dream } = setup();
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  const { memory: u } = service.saveWithDedupe({ type: "preference", title: "语言", content: "喜欢 Python" });
  const ctx = mockCtx({
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "插件总览", content: "合并内容", importance: 4 },
      { action: "conflict", winner: w.id, loser: l.id, reason: "更新" },
      { action: "update", ids: [u.id], content: "喜欢 Rust" }
    ])
  });
  // Backdate the update target so the update age guard (minAgeHours) sees a
  // settled record rather than a sub-second-old one — store.nowIso() can drift
  // a few ms ahead of the wall clock when seeds land in the same millisecond.
  store.db.prepare("UPDATE memories SET created_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 3600000).toISOString(), u.id);
  const result = await dream.runDream(ctx, service, { reflectionUpdateMinAgeHours: 0, policyEpoch: 3 });
  assert.equal(result.status, "ok");

  const receipts = store.listReceipts({ run_id: result.runId });
  assert.equal(receipts.length, 3, "one receipt per mutable verdict, none for keep/archive");

  const byKind = Object.fromEntries(receipts.map((r) => [r.kind, r]));
  assert.deepEqual(Object.keys(byKind).sort(), ["conflict", "merge", "update"]);

  const merge = byKind.merge;
  assert.equal(merge.run_id, result.runId);
  assert.equal(merge.record_id, b.id, "merge receipt keyed on keepSource");
  assert.equal(merge.keep_source, b.id);
  assert.deepEqual(merge.sources, [a.id, b.id], "merge sources = full id array");
  assert.equal(merge.count_before, 2);
  assert.equal(merge.count_after, 1);
  assert.equal(merge.verdict, "live");
  assert.equal(merge.policy_epoch, 3, "policy epoch stamped from config");
  assert.equal(merge.input_digest, hashDecisionInput([a, b]), "digest over the pre-apply basis memories");
  assert.match(merge.created_at, /^2\d{3}-/, "created_at is an ISO timestamp");

  const conflict = byKind.conflict;
  assert.equal(conflict.record_id, w.id, "conflict receipt keyed on winner");
  assert.equal(conflict.winner_id, w.id);
  assert.equal(conflict.loser_id, l.id);
  assert.equal(conflict.keep_source, undefined, "no keep_source on a conflict");
  assert.equal(conflict.count_before, 2);
  assert.equal(conflict.count_after, 1);
  assert.equal(conflict.input_digest, hashDecisionInput([w, l]), "digest over winner+loser");

  const update = byKind.update;
  assert.equal(update.record_id, u.id);
  assert.equal(update.winner_id, undefined, "no winner/loser on an update");
  assert.equal(update.count_before, 1);
  assert.equal(update.count_after, 1);
  assert.equal(update.input_digest, hashDecisionInput([u]), "digest over the pre-update target");
  store.close();
});

test("a throwing per-record receipt writer never breaks the run (bookkeeping fails safe)", async () => {
  const { store, service, dream } = setup();
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "甲", content: "A", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "乙", content: "B", importance: 4 });
  service.saveReceipt = () => { throw new Error("receipt store boom"); };
  const ctx = mockCtx({
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "甲乙", content: "合并", importance: 4 }
    ])
  });
  const result = await dream.runDream(ctx, service, {});
  assert.equal(result.ok, true, "consolidation unaffected by receipt failure");
  assert.equal(result.applied, 1);
  const run = store.listDreamRuns()[0];
  assert.equal(run.status, "ok", "audit row still written");
  assert.equal(store.getById(b.id).title, "甲乙", "merge still applied");
  assert.equal(store.getById(a.id).archived, true, "merge source still archived");
  assert.equal(store.listReceipts().length, 0, "no receipts persisted");
  store.close();
});

test("failed runDream records status failed with the error", async () => {
  const { store, service, dream } = setup();
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const ctx = mockCtx({ onConsolidation: () => "抱歉，我无法处理这个任务" });
  const result = await dream.runDream(ctx, service, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /no json array/);

  const run = store.listDreamRuns()[0];
  assert.equal(run.status, "failed");
  assert.equal(run.decisions, undefined);
  assert.match(run.error, /no json array/);
  const parsed = parseReceipt(run.receipt);
  assert.equal(parsed.status, "failed");
  store.close();
});

test("summary failure still records the applied decisions for replay", async () => {
  const { store, service, dream } = setup();
  const { memory: m } = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const ctx = mockCtx({
    onConsolidation: () => JSON.stringify([{ action: "keep", ids: [m.id] }]),
    summaryText: new Error("summary boom")
  });
  const result = await dream.runDream(ctx, service, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, "llm failed");

  const run = store.listDreamRuns()[0];
  assert.equal(run.status, "failed");
  assert.equal(run.decisions.length, 1, "decisions captured despite summary failure");
  assert.equal(run.outcome.byId[m.id], "keep");
  store.close();
});

test("audit rows persist across store reopen (file-backed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-audit-"));
  const path = join(dir, "memory.db");
  const s1 = createStore(path);
  s1.saveDreamRun({
    id: "run-1", status: "ok", snapshot_hash: "abc", input_count: 1,
    decisions: [{ action: "keep", ids: ["x"] }],
    outcome: { byId: { x: "keep" } }, applied: 0, summary_stored: false,
    receipt: "dsh-mneme:run:run-1:ok:abc:1:0:0"
  });
  s1.close();
  const s2 = createStore(path);
  const run = s2.getDreamRun("run-1");
  assert.equal(run.status, "ok");
  assert.equal(run.decisions[0].action, "keep");
  s2.close();
});

// ---------------------------------------------------------------- hashing & receipts

test("hashSnapshot is deterministic and order-independent", () => {
  const mk = (id, title, content = "c") => ({ id, type: "project", title, content, importance: 3, updated_at: "2026-01-01T00:00:00.000Z" });
  const a = mk("a", "t1");
  const b = mk("b", "t2");
  assert.equal(hashSnapshot([a, b]), hashSnapshot([b, a]), "order independent");
  assert.equal(hashSnapshot([a, b]), hashSnapshot([{ ...a }, { ...b }]), "field order / clone independent");
  assert.notEqual(hashSnapshot([a, b]), hashSnapshot([a, { ...b, content: "changed" }]), "content change flips hash");
});

test("receipt round-trips and malformed receipts parse to undefined", () => {
  const receipt = buildReceipt({ runId: "r1", status: "ok", snapshotHash: "0123456789abcdef", inputCount: 3, applied: 2, summaryStored: true });
  assert.deepEqual(parseReceipt(receipt), { runId: "r1", status: "ok", snapshotHash: "0123456789ab", inputCount: 3, applied: 2, summaryStored: true });
  for (const bad of ["nope", "", "dsh-mneme:run:r1", "dsh-mneme:run:r1:weird:abc:1:0:0", "dsh-mneme:run:r1:ok:abc:nan:0:0"]) {
    assert.equal(parseReceipt(bad), undefined, `rejects ${JSON.stringify(bad)}`);
  }
});

test("buildOutcome maps every decision action to per-id disposition", () => {
  const outcome = buildOutcome([
    { action: "keep", ids: ["k"] },
    { action: "archive", ids: ["a1", "a2"] },
    { action: "merge", ids: ["m1", "m2"], keepSource: "m1" },
    { action: "conflict", winner: "w", loser: "l" }
  ]);
  assert.equal(outcome.byId.k, "keep");
  assert.equal(outcome.byId.a1, "archived");
  assert.equal(outcome.byId.a2, "archived");
  assert.equal(outcome.byId.m1, "merge-keep");
  assert.equal(outcome.byId.m2, "merge-archived");
  assert.equal(outcome.byId.w, "conflict-winner");
  assert.equal(outcome.byId.l, "conflict-archived");
});

// ---------------------------------------------------------------- replayability

test("replaying a recorded decision list is idempotent", async () => {
  const { store, service, dream } = setup();
  const { memory: a } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月15日", importance: 4 });
  const { memory: b } = service.saveWithDedupe({ type: "decision", title: "截止新", content: "8月20日", importance: 5 });
  const ctx = mockCtx({
    onConsolidation: () => JSON.stringify([{ action: "conflict", winner: b.id, loser: a.id, reason: "更新" }])
  });
  const result = await dream.runDream(ctx, service, {});
  assert.equal(result.ok, true);

  const run = store.getDreamRun(result.runId);
  assert.equal(run.decisions[0].winner, b.id);
  assert.equal(run.outcome.byId[a.id], "conflict-archived");
  assert.equal(run.outcome.byId[b.id], "conflict-winner");

  // store already reflects the run
  assert.equal(store.getById(a.id).archived, true);
  assert.ok(store.getById(b.id).content.includes("已否决旧信息"), "provenance note appended");

  // replay the exact recorded decision list → no-op (idempotent)
  const replayed = applyDecisions(run.decisions, service);
  assert.equal(replayed.applied, 0, "already-applied decisions re-apply nothing");
  assert.equal(store.getById(a.id).archived, true);
  assert.equal(store.getById(b.id).content, store.getById(b.id).content);
  store.close();
});

test("re-applying a decision many times has no cumulative side effects", async () => {
  const { store, service, dream } = setup();
  const { memory: a } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月15日", importance: 4 });
  const { memory: b } = service.saveWithDedupe({ type: "decision", title: "截止新", content: "8月20日", importance: 5 });
  const { memory: m1 } = service.saveWithDedupe({ type: "project", title: "甲", content: "旧甲", importance: 3 });
  const { memory: m2 } = service.saveWithDedupe({ type: "project", title: "乙", content: "旧乙", importance: 4 });
  const decisions = [
    { action: "conflict", winner: b.id, loser: a.id, reason: "更新" },
    { action: "merge", ids: [m1.id, m2.id], keepSource: m2.id, title: "甲乙", content: "合并", importance: 4 }
  ];
  // apply 3 times (e.g. concurrent/replayed dream runs)
  for (let i = 0; i < 3; i++) applyDecisions(decisions, service);

  const winner = store.getById(b.id);
  assert.equal(winner.content.split("已否决旧信息").length - 1, 1, "provenance note appended exactly once");
  assert.equal(store.getById(a.id).archived, true);
  assert.equal(store.getById(m2.id).title, "甲乙", "keeper merged");
  assert.equal(store.getById(m1.id).archived, true, "merge source archived once");
  store.close();
});

// ---------------------------------------------------------------- reconcile (item ②)

test("runDream records status reconcile, not a fake ok, when a target changed during the run", async () => {
  const { store, service, dream } = setup();
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "旧", content: "A", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "新", content: "B", importance: 4 });
  // The "LLM call" mutates a target while producing the decision list —
  // simulating a concurrent human/agent edit inside the run window.
  const ctx = mockCtx({
    onConsolidation: () => {
      service.update(b.id, { content: "并发编辑" });
      return JSON.stringify([
        { action: "merge", ids: [a.id, b.id], title: "合并", content: "合并内容", importance: 4, keepSource: b.id }
      ]);
    }
  });
  const result = await dream.runDream(ctx, service, {});
  assert.equal(result.ok, false, "partial commit is not ok");
  assert.equal(result.status, "reconcile", "explicit reconcile status");
  assert.equal(result.applied, 0, "conflicting merge not applied");

  const run = store.listDreamRuns()[0];
  assert.equal(run.status, "reconcile", "audit row records reconcile");
  assert.equal(run.applied, 0);
  const parsed = parseReceipt(run.receipt);
  assert.equal(parsed.status, "reconcile", "receipt records reconcile, never ok");
  assert.equal(parsed.applied, 0);
  // outcome is derived from what actually committed: the merge is NOT claimed
  assert.equal(run.outcome.byId[b.id], undefined, "keeper not claimed as merge-keep");
  assert.equal(run.outcome.byId[a.id], undefined, "source not claimed as merge-archived");
  assert.equal(run.outcome.conflicts.length, 1, "conflict recorded in the audit row");
  // the concurrent edit survived
  assert.equal(store.getById(b.id).content, "并发编辑");
  store.close();
});

test("buildOutcome over actually-committed sub-steps never claims a rolled-back merge", () => {
  const committed = [
    { action: "keep", ids: ["k"] },
    { action: "merge", ids: ["m1", "m2"], keepSource: "m1", title: "t", content: "c" }
  ];
  const outcome = buildOutcome(committed);
  assert.equal(outcome.byId.m1, "merge-keep");
  assert.equal(outcome.byId.m2, "merge-archived");
  assert.equal(outcome.byId.k, "keep");
});

// ---------------------------------------------------------------- noop & degraded (F-03)

test("runDream records status noop when all decisions are keep and summary is empty", async () => {
  const { store, service, dream } = setup();
  const { memory: m } = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const ctx = mockCtx({
    onConsolidation: () => JSON.stringify([{ action: "keep", ids: [m.id] }]),
    summaryText: ""
  });
  const result = await dream.runDream(ctx, service, {});
  assert.equal(result.ok, false, "no-change + empty summary is not a success");
  assert.equal(result.status, "noop", "explicit noop status");
  assert.equal(result.applied, 0);
  assert.equal(result.summary, false);

  const run = store.listDreamRuns()[0];
  assert.equal(run.status, "noop", "audit row records noop, never ok");
  assert.equal(run.applied, 0);
  assert.equal(run.summary_stored, false);
  const parsed = parseReceipt(run.receipt);
  assert.equal(parsed.status, "noop", "receipt records noop");
  assert.equal(parsed.applied, 0);
  assert.equal(parsed.summaryStored, false);
  assert.equal(run.outcome.byId[m.id], "keep", "keep disposition still recorded for replay");
  store.close();
});

test("runDream records status ok when all decisions are keep but a summary was stored", async () => {
  const { store, service, dream } = setup();
  const { memory: m } = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const ctx = mockCtx({ onConsolidation: () => JSON.stringify([{ action: "keep", ids: [m.id] }]) });
  const result = await dream.runDream(ctx, service, {});
  assert.equal(result.status, "ok", "summary refresh is substantive output");
  assert.equal(result.ok, true);
  assert.equal(result.applied, 0);
  assert.equal(result.summary, true);
  const run = store.listDreamRuns()[0];
  assert.equal(run.status, "ok");
  assert.equal(parseReceipt(run.receipt).status, "ok");
  assert.equal(parseReceipt(run.receipt).summaryStored, true);
  store.close();
});

test("runDream records status degraded when changes land but the summary is empty", async () => {
  const { store, service, dream } = setup();
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "旧", content: "A", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "新", content: "B", importance: 4 });
  const ctx = mockCtx({
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [a.id, b.id], title: "合并", content: "合并内容", importance: 4, keepSource: b.id }
    ]),
    summaryText: ""
  });
  const result = await dream.runDream(ctx, service, {});
  assert.equal(result.status, "degraded", "real changes without a summary are not a clean ok");
  assert.equal(result.ok, true, "consolidation landed so the baseline may advance");
  assert.equal(result.applied, 1);
  assert.equal(result.summary, false, "summary honestly reported missing");
  const run = store.listDreamRuns()[0];
  assert.equal(run.status, "degraded", "audit row records degraded");
  assert.equal(run.summary_stored, false);
  assert.equal(parseReceipt(run.receipt).status, "degraded");
  assert.equal(parseReceipt(run.receipt).summaryStored, false);
  store.close();
});
