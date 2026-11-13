import test from "node:test";
import assert from "node:assert/strict";
import { applyDecisions, hashDecisionInput, createDreamScheduler } from "../src/dream.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { testConfig } from "./helpers/test-config.js";

// --- helpers -------------------------------------------------------------

function openStore() {
  const store = createStore(":memory:");
  return { store, close: () => store.close() };
}

function fullReceipt(over = {}) {
  return {
    run_id: "run-1",
    record_id: "rec-a",
    kind: "merge",
    input_digest: "d".repeat(64),
    verdict: "live",
    count_before: 2,
    count_after: 1,
    policy_epoch: 3,
    sources: ["rec-a", "rec-b"],
    ...over
  };
}

function serviceSetup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  return { store, service };
}

function snapshotFrom(service) {
  return service.all()
    .filter((m) => !m.archived && m.type !== "summary")
    .reduce((map, m) => map.set(m.id, m), new Map());
}

// A runDream ctx whose LLM yields the given decisions first, then a summary.
function mockCtx(decisions, logger) {
  let calls = 0;
  return {
    llm: {
      stream: async function* () {
        calls++;
        const text = calls === 1
          ? JSON.stringify(decisions)
          : "记忆库总览摘要文本";
        yield { type: "text-delta", text };
        yield { type: "finish", reason: { kind: "ok" } };
      }
    },
    logger: logger ?? { warn: () => {} }
  };
}

function dreamConfig(over = {}) {
  return {
    dreamProvider: "deepseek",
    dreamModel: "deepseek-chat",
    reflectionUpdateMinAgeHours: 0,
    reflectionUpdateMaxPerRun: 2,
    ...over
  };
}

// === store layer: receipt_chain CRUD + upsert idempotency ================

test("store saveReceipt→getReceipt round trip preserves fields and parses sources JSON", () => {
  const { store, close } = openStore();
  const saved = store.saveReceipt(fullReceipt({
    receipt_id: "r-1",
    winner_id: "rec-a",
    loser_id: "rec-b",
    keep_source: "rec-a",
    sources: ["rec-a", "rec-b", "偏好：中文", "with \"quotes\"\nand 换行"]
  }));
  assert.equal(saved.receipt_id, "r-1");
  const got = store.getReceipt("r-1");
  assert.ok(got, "receipt readable");
  assert.equal(got.receipt_id, "r-1");
  assert.equal(got.run_id, "run-1");
  assert.equal(got.record_id, "rec-a");
  assert.equal(got.kind, "merge");
  assert.equal(got.input_digest, "d".repeat(64));
  assert.equal(got.winner_id, "rec-a");
  assert.equal(got.loser_id, "rec-b");
  assert.equal(got.keep_source, "rec-a");
  assert.equal(got.verdict, "live");
  assert.equal(got.count_before, 2);
  assert.equal(got.count_after, 1);
  assert.equal(got.policy_epoch, 3);
  assert.ok(got.created_at, "has created_at");
  assert.deepEqual(got.sources, ["rec-a", "rec-b", "偏好：中文", "with \"quotes\"\nand 换行"], "sources JSON round-trips");
  close();
});

test("store sources: empty array round-trips as [] and undefined defaults to []", () => {
  const { store, close } = openStore();
  store.saveReceipt(fullReceipt({ receipt_id: "r-e", sources: [] }));
  assert.deepEqual(store.getReceipt("r-e").sources, []);
  store.saveReceipt(fullReceipt({ receipt_id: "r-u", sources: undefined }));
  assert.deepEqual(store.getReceipt("r-u").sources, [], "missing sources default to empty array, not null");
  close();
});

test("store saveReceipt auto-generates receipt_id and getReceipt finds it", () => {
  const { store, close } = openStore();
  const saved = store.saveReceipt(fullReceipt({ receipt_id: undefined }));
  assert.ok(saved.receipt_id, "id generated");
  assert.equal(store.getReceipt(saved.receipt_id).kind, "merge");
  close();
});

test("store upsert idempotent: same receipt_id overwrites, never duplicates", () => {
  const { store, close } = openStore();
  store.saveReceipt(fullReceipt({ receipt_id: "r-x", count_after: 1 }));
  store.saveReceipt(fullReceipt({ receipt_id: "r-x", count_after: 2 }));
  store.saveReceipt(fullReceipt({ receipt_id: "r-x", count_after: 3 }));
  const all = store.listReceipts();
  assert.equal(all.length, 1, "replay overwrites in place");
  assert.equal(all[0].count_after, 3, "latest payload wins");
  assert.equal(store.getReceipt("r-x").count_after, 3);
  close();
});

test("store listReceipts filters by run_id and returns [] on miss or empty table", () => {
  const { store, close } = openStore();
  assert.deepEqual(store.listReceipts(), [], "empty table -> []");
  assert.deepEqual(store.listReceipts({ run_id: "nope" }), []);
  store.saveReceipt(fullReceipt({ receipt_id: "r-1", run_id: "run-a" }));
  store.saveReceipt(fullReceipt({ receipt_id: "r-2", run_id: "run-b" }));
  const onlyA = store.listReceipts({ run_id: "run-a" });
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0].run_id, "run-a");
  assert.deepEqual(store.listReceipts({ run_id: "run-miss" }), []);
  close();
});

test("store getReceipt miss returns undefined without throwing", () => {
  const { store, close } = openStore();
  assert.equal(store.getReceipt("no-such-receipt"), undefined);
  close();
});

test("store policy_epoch: default 0, explicit value preserved", () => {
  const { store, close } = openStore();
  store.saveReceipt(fullReceipt({ receipt_id: "r-0", policy_epoch: undefined }));
  assert.equal(store.getReceipt("r-0").policy_epoch, 0);
  store.saveReceipt(fullReceipt({ receipt_id: "r-7", policy_epoch: 7 }));
  assert.equal(store.getReceipt("r-7").policy_epoch, 7);
  close();
});

// === decisions layer: count_before/count_after on committed verdicts =====

test("decisions merge committed carries count_before = ids.length (sources+1), count_after = 1", () => {
  const { store, service } = serviceSetup();
  const a = service.saveWithDedupe({ type: "project", title: "甲", content: "旧甲" });
  const b = service.saveWithDedupe({ type: "project", title: "乙", content: "旧乙" });
  const c = service.saveWithDedupe({ type: "project", title: "丙", content: "旧丙" });
  const { committed } = applyDecisions([{
    action: "merge", ids: [a.memory.id, b.memory.id, c.memory.id], title: "总览", content: "合并", importance: 4, keepSource: b.memory.id
  }], service);
  const merge = committed.find((x) => x.action === "merge");
  assert.ok(merge, "merge committed");
  assert.equal(merge.count_before, 3, "before = ids.length = sources.length + 1");
  assert.equal(merge.count_after, 1);
  store.close();
});

test("decisions conflict committed carries 2→1, update committed carries 1→1", () => {
  const { store, service } = serviceSetup();
  const w = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日" });
  const l = service.saveWithDedupe({ type: "decision", title: "旧截止", content: "8月15日" });
  const u = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const { committed } = applyDecisions([
    { action: "conflict", winner: w.memory.id, loser: l.memory.id, reason: "更新" },
    { action: "update", ids: [u.memory.id], content: "中英双语" }
  ], service);
  const conflict = committed.find((x) => x.action === "conflict");
  const update = committed.find((x) => x.action === "update");
  assert.deepEqual([conflict.count_before, conflict.count_after], [2, 1]);
  assert.deepEqual([update.count_before, update.count_after], [1, 1]);
  store.close();
});

test("decisions keep/archive committed entries carry no count fields (not receipt candidates)", () => {
  const { store, service } = serviceSetup();
  const k = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const a = service.saveWithDedupe({ type: "project", title: "废弃", content: "过时" });
  const { committed } = applyDecisions([
    { action: "keep", ids: [k.memory.id] },
    { action: "archive", ids: [a.memory.id], reason: "过时" }
  ], service);
  assert.ok(committed.length >= 2, "keep + archive recorded");
  for (const c of committed) {
    assert.equal(c.count_before, undefined, `${c.action} has no count_before`);
    assert.equal(c.count_after, undefined, `${c.action} has no count_after`);
  }
  store.close();
});

test("decisions skipped decisions never enter committed", () => {
  const { store, service } = serviceSetup();
  const { committed } = applyDecisions([{ action: "archive", ids: ["ghost"], reason: "x" }], service);
  assert.equal(committed.length, 0, "unknown id skipped, not committed");
  store.close();
});

test("decisions empty list -> empty committed, no side effects", () => {
  const { store, service } = serviceSetup();
  assert.deepEqual(applyDecisions([], service).committed, []);
  store.close();
});

test("decisions mixed batch: each verdict carries its own independent counts", () => {
  const { store, service } = serviceSetup();
  const a = service.saveWithDedupe({ type: "project", title: "甲", content: "c1" });
  const b = service.saveWithDedupe({ type: "project", title: "乙", content: "c2" });
  const w = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日" });
  const l = service.saveWithDedupe({ type: "decision", title: "旧", content: "8月15日" });
  const u = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const { committed } = applyDecisions([
    { action: "merge", ids: [a.memory.id, b.memory.id], title: "总", content: "合", keepSource: a.memory.id },
    { action: "conflict", winner: w.memory.id, loser: l.memory.id },
    { action: "update", ids: [u.memory.id], content: "中英双语" }
  ], service);
  assert.equal(committed.length, 3);
  assert.deepEqual(committed.map((c) => [c.action, c.count_before, c.count_after]), [
    ["merge", 2, 1],
    ["conflict", 2, 1],
    ["update", 1, 1]
  ]);
  store.close();
});

// === dream E2E: buildRecordReceipts writes the receipt_chain =============

test("E2E runDream writes one receipt per committed merge/conflict/update verdict", async () => {
  const { store, service } = serviceSetup();
  const a = service.saveWithDedupe({ type: "project", title: "插件", content: "旧" });
  const b = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节" });
  const w = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日" });
  const l = service.saveWithDedupe({ type: "decision", title: "旧截止", content: "8月15日" });
  const u = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const decisions = [
    { action: "merge", ids: [a.memory.id, b.memory.id], title: "插件总览", content: "合并内容", importance: 5, keepSource: a.memory.id },
    { action: "conflict", winner: w.memory.id, loser: l.memory.id, reason: "更新" },
    { action: "update", ids: [u.memory.id], content: "中英双语" }
  ];
  // Backdate the update target: with reflectionUpdateMinAgeHours=0 the age guard
  // is `ageHours < 0`, and the store's monotonic timestamp guard can push a
  // just-created memory's created_at a few ms into the "future", spuriously
  // rejecting it as too young (a real timing-dependent edge). An established
  // memory sidesteps that and makes the update path deterministic.
  store.db.prepare("UPDATE memories SET created_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 3600_000).toISOString(), u.memory.id);
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(mockCtx(decisions), service, dreamConfig({ policyEpoch: 5 }));
  assert.equal(result.ok, true);
  assert.equal(result.applied, 3, "all three verdicts applied");

  const receipts = store.listReceipts();
  assert.equal(receipts.length, 3, "exactly 3 per-record receipts");
  const byKind = Object.fromEntries(receipts.map((r) => [r.kind, r]));
  for (const kind of ["merge", "conflict", "update"]) {
    const r = byKind[kind];
    assert.ok(r, `${kind} receipt exists`);
    assert.equal(r.verdict, "live", `${kind} verdict live`);
    assert.equal(r.policy_epoch, 5, `${kind} carries run policy_epoch`);
    assert.equal(r.run_id, result.runId, `${kind} tied to the run`);
    assert.match(r.input_digest, /^[0-9a-f]{64}$/, `${kind} digest is sha256 hex`);
  }
  assert.equal(byKind.merge.record_id, a.memory.id, "merge receipt on keepSource");
  assert.equal(byKind.merge.keep_source, a.memory.id);
  assert.deepEqual(byKind.merge.sources, [a.memory.id, b.memory.id], "merge sources = ids");
  assert.deepEqual([byKind.merge.count_before, byKind.merge.count_after], [2, 1]);
  assert.equal(byKind.conflict.record_id, w.memory.id, "conflict receipt on winner");
  assert.equal(byKind.conflict.winner_id, w.memory.id);
  assert.equal(byKind.conflict.loser_id, l.memory.id);
  assert.deepEqual([byKind.conflict.count_before, byKind.conflict.count_after], [2, 1]);
  assert.equal(byKind.update.record_id, u.memory.id, "update receipt on target");
  assert.deepEqual([byKind.update.count_before, byKind.update.count_after], [1, 1]);
  store.close();
});

test("E2E receipt input_digest reproduces hashDecisionInput of the run snapshot", async () => {
  const { store, service } = serviceSetup();
  const a = service.saveWithDedupe({ type: "project", title: "插件", content: "旧" });
  const b = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节" });
  const w = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日" });
  const l = service.saveWithDedupe({ type: "decision", title: "旧截止", content: "8月15日" });
  const before = snapshotFrom(service); // the exact input the run will arbitrate against
  const decisions = [
    { action: "merge", ids: [a.memory.id, b.memory.id], title: "总", content: "合", importance: 4, keepSource: a.memory.id },
    { action: "conflict", winner: w.memory.id, loser: l.memory.id }
  ];
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  await dream.runDream(mockCtx(decisions), service, dreamConfig());

  const receipts = store.listReceipts();
  const merge = receipts.find((r) => r.kind === "merge");
  const conflict = receipts.find((r) => r.kind === "conflict");
  assert.equal(merge.input_digest, hashDecisionInput([before.get(a.memory.id), before.get(b.memory.id)]), "merge digest = hash of its sources");
  assert.equal(conflict.input_digest, hashDecisionInput([before.get(w.memory.id), before.get(l.memory.id)]), "conflict digest = hash of winner+loser");
  store.close();
});

test("E2E keep + archive decisions produce no receipts", async () => {
  const { store, service } = serviceSetup();
  const k = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const a = service.saveWithDedupe({ type: "project", title: "合并", content: "旧" });
  const b = service.saveWithDedupe({ type: "project", title: "合并2", content: "新" });
  const x = service.saveWithDedupe({ type: "project", title: "废弃", content: "过时" });
  const decisions = [
    { action: "keep", ids: [k.memory.id] },
    { action: "merge", ids: [a.memory.id, b.memory.id], title: "总", content: "合", importance: 4, keepSource: a.memory.id },
    { action: "archive", ids: [x.memory.id], reason: "过时" }
  ];
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(mockCtx(decisions), service, dreamConfig());
  assert.equal(result.ok, true, "full list applied");
  const receipts = store.listReceipts();
  assert.equal(receipts.length, 1, "only the merge verdict produced a receipt");
  assert.equal(receipts[0].kind, "merge");
  store.close();
});

test("E2E rerun of already-applied decisions writes no duplicate receipts", async () => {
  const { store, service } = serviceSetup();
  const a = service.saveWithDedupe({ type: "project", title: "甲", content: "旧" });
  const b = service.saveWithDedupe({ type: "project", title: "乙", content: "旧2" });
  const decisions = [
    { action: "merge", ids: [a.memory.id, b.memory.id], title: "总", content: "合", importance: 4, keepSource: a.memory.id }
  ];
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const first = await dream.runDream(mockCtx(decisions), service, dreamConfig());
  assert.equal(first.applied, 1);
  assert.equal(store.listReceipts().length, 1);
  // Re-running the identical raw LLM output is prevented before apply: the
  // merge source is already archived, so validation rejects it — either way,
  // no second receipt may appear (the chain stays one row per verdict).
  const second = await dream.runDream(mockCtx(decisions), service, dreamConfig());
  assert.equal(second.ok, false, "re-application rejected by validation");
  assert.equal(store.listReceipts().length, 1, "receipt count did not grow");
  store.close();
});

test("E2E audit run row is written alongside receipts under the same run_id", async () => {
  const { store, service } = serviceSetup();
  const a = service.saveWithDedupe({ type: "project", title: "甲", content: "旧" });
  const b = service.saveWithDedupe({ type: "project", title: "乙", content: "旧2" });
  const decisions = [
    { action: "merge", ids: [a.memory.id, b.memory.id], title: "总", content: "合", importance: 4, keepSource: a.memory.id }
  ];
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(mockCtx(decisions), service, dreamConfig());
  const runRow = store.db.prepare("SELECT * FROM dream_runs WHERE id = ?").get(result.runId);
  assert.ok(runRow, "audit row persisted");
  const receipts = store.listReceipts({ run_id: result.runId });
  assert.equal(receipts.length, 1, "receipts filterable by the run");
  store.close();
});

// === fail-safe: receipt writes never block consolidation =================

test("fail-safe: saveReceipt throwing does not block runDream, warns, and memories still consolidate", async () => {
  const { store, service } = serviceSetup();
  const a = service.saveWithDedupe({ type: "project", title: "甲", content: "旧" });
  const b = service.saveWithDedupe({ type: "project", title: "乙", content: "旧2" });
  const warnings = [];
  const originalSaveReceipt = service.saveReceipt;
  service.saveReceipt = (r) => {
    throw new Error("disk full");
  };
  const decisions = [
    { action: "merge", ids: [a.memory.id, b.memory.id], title: "总", content: "合", importance: 4, keepSource: a.memory.id }
  ];
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(mockCtx(decisions, { warn: (m) => warnings.push(m) }), service, dreamConfig());
  service.saveReceipt = originalSaveReceipt;
  assert.equal(result.ok, true, "runDream still ok when receipt write fails");
  assert.equal(result.applied, 1, "consolidation applied despite receipt failure");
  assert.equal(store.getById(a.memory.id).title, "总", "keeper updated despite receipt failure");
  assert.equal(store.getById(b.memory.id).archived, true, "source archived despite receipt failure");
  assert.ok(warnings.some((m) => m.includes("per-record receipt")), "receipt failure logged");
  assert.equal(store.listReceipts().length, 0, "no partial receipt rows");
  store.close();
});

test("fail-safe: saveReceipt throwing still writes the run audit row", async () => {
  const { store, service } = serviceSetup();
  const a = service.saveWithDedupe({ type: "project", title: "甲", content: "旧" });
  const b = service.saveWithDedupe({ type: "project", title: "乙", content: "旧2" });
  service.saveReceipt = () => { throw new Error("boom"); };
  const decisions = [
    { action: "merge", ids: [a.memory.id, b.memory.id], title: "总", content: "合", importance: 4, keepSource: a.memory.id }
  ];
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(mockCtx(decisions), service, dreamConfig());
  const runRow = store.db.prepare("SELECT * FROM dream_runs WHERE id = ?").get(result.runId);
  assert.ok(runRow, "audit trail survives receipt failure");
  store.close();
});

// === input_digest content addressing =====================================

test("hashDecisionInput is deterministic and order-independent", () => {
  const memories = [
    { id: "a", title: "标题", content: "内容", importance: 3 },
    { id: "b", title: "t", content: "c", importance: 4 }
  ];
  const d1 = hashDecisionInput(memories);
  const d2 = hashDecisionInput([...memories].reverse());
  assert.equal(d1, d2, "same inputs in any order hash the same");
  assert.match(d1, /^[0-9a-f]{64}$/, "sha256 hex digest");
});

test("hashDecisionInput is sensitive: any field change yields a different digest", () => {
  const base = { id: "a", title: "标题", content: "内容", importance: 3 };
  const d = hashDecisionInput([base]);
  assert.notEqual(hashDecisionInput([{ ...base, content: "内容X" }]), d, "content change");
  assert.notEqual(hashDecisionInput([{ ...base, title: "标题X" }]), d, "title change");
  assert.notEqual(hashDecisionInput([{ ...base, importance: 4 }]), d, "importance change");
  assert.notEqual(hashDecisionInput([{ ...base, id: "b" }]), d, "id change");
});

test("hashDecisionInput empty input is stable and distinct from any non-empty input", () => {
  const empty = hashDecisionInput([]);
  const empty2 = hashDecisionInput([]);
  assert.equal(empty, empty2, "empty is deterministic");
  assert.notEqual(empty, hashDecisionInput([{ id: "a", title: "", content: "", importance: 1 }]));
  assert.notEqual(empty, hashDecisionInput([{ id: "a", title: "x", content: "y", importance: 1 }]));
});

test("E2E receipts never double for same record across one run (one row per verdict)", async () => {
  const { store, service } = serviceSetup();
  const w = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日" });
  const l = service.saveWithDedupe({ type: "decision", title: "旧", content: "8月15日" });
  const decisions = [{ action: "conflict", winner: w.memory.id, loser: l.memory.id }];
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  await dream.runDream(mockCtx(decisions), service, dreamConfig());
  const receipts = store.listReceipts();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].kind, "conflict");
  assert.equal(receipts[0].verdict, "live");
  store.close();
});
