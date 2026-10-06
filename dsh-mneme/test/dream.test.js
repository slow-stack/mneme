import test from "node:test";
import assert from "node:assert/strict";
import { validateDecisions, applyDecisions, createDreamScheduler } from "../src/dream.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { mockCtx } from "./helpers/dream-mock.js";

function snapshot(ids, type = "project") {
  return new Map(ids.map((id, i) => [id, { id, type, title: `t${i}`, content: `c${i}`, importance: 3, archived: false, forgotten: false }]));
}

test("valid decision list passes", () => {
  const snap = snapshot(["a", "b", "c"]);
  const decisions = [
    { action: "keep", ids: ["a"], reason: "ok" },
    { action: "merge", ids: ["b", "c"], title: "bc", content: "merged", importance: 4, keepSource: "b" }
  ];
  const { ok, errors } = validateDecisions(decisions, snap);
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
});

test("unknown id rejects whole list", () => {
  const snap = snapshot(["a"]);
  const { ok, errors } = validateDecisions([{ action: "archive", ids: ["zzz"], reason: "x" }], snap);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("zzz")));
});

// --- Issue #135: 唯一前缀解析 -------------------------------------------------
// 模型常把 36 位 UUID 回填成前缀（报告实测 78/78 个 8 位前缀都能唯一对应窗口内
// 真实记忆，且 few-shot 示例的 "m1"/"m2" 占位符在诱导这种缩写）。校验前的唯一
// 前缀解析把它们还原成完整 id，而不是逐条 unknown id 后被覆盖率闸整单拒绝。

test("Issue #135: unique short prefixes resolve to full ids (ids + keepSource)", () => {
  const idA = "f77a0d17-2586-41fe-a789-d69f4d1cee83";
  const idB = "bc17c9ed-e84c-4b9f-bc36-48f8e9a6b3e0";
  const snap = snapshot([idA, idB]);
  const decisions = [
    { action: "merge", ids: ["f77a0d17", "bc17c9ed"], title: "合并", content: "合并后的内容", importance: 4, keepSource: "f77a0d17" }
  ];
  const { ok, errors, resolvedShortIds } = validateDecisions(decisions, snap);
  assert.equal(ok, true, JSON.stringify(errors));
  assert.equal(resolvedShortIds, 3, "two ids + keepSource resolved");
  assert.deepEqual(decisions[0].ids, [idA, idB], "ids rewritten in place");
  assert.equal(decisions[0].keepSource, idA, "keepSource rewritten");
});

test("Issue #135: conflict winner/loser short prefixes resolve", () => {
  const idA = "f77a0d17-2586-41fe-a789-d69f4d1cee83";
  const idB = "bc17c9ed-e84c-4b9f-bc36-48f8e9a6b3e0";
  const snap = snapshot([idA, idB]);
  const decisions = [{ action: "conflict", winner: "f77a0d17", loser: "bc17c9ed", reason: "内容矛盾" }];
  const { ok, errors, resolvedShortIds } = validateDecisions(decisions, snap);
  assert.equal(ok, true, JSON.stringify(errors));
  assert.equal(resolvedShortIds, 2);
  assert.equal(decisions[0].winner, idA, "winner rewritten");
  assert.equal(decisions[0].loser, idB, "loser rewritten");
});

test("Issue #135: ambiguous prefix stays unresolved and reports unknown id", () => {
  const snap = snapshot([
    "aaaaaaaa-1111-4111-8111-111111111111",
    "aaaaaaaa-2222-4222-8222-222222222222"
  ]);
  const { ok, errors, resolvedShortIds } = validateDecisions([{ action: "archive", ids: ["aaaaaaaa"] }], snap);
  assert.equal(ok, false);
  assert.equal(resolvedShortIds, 0, "ambiguous prefix is never guessed");
  assert.ok(errors.some((e) => e.includes("unknown id")), JSON.stringify(errors));
});

test("Issue #135: unmatched prefix is left for the validator to report", () => {
  const snap = snapshot(["f77a0d17-2586-41fe-a789-d69f4d1cee83"]);
  const { ok, errors, resolvedShortIds } = validateDecisions([{ action: "archive", ids: ["deadbeef"] }], snap);
  assert.equal(ok, false);
  assert.equal(resolvedShortIds, 0, "no match means no rewrite");
  assert.ok(errors.some((e) => e.includes("deadbeef")), JSON.stringify(errors));
});

test("invalid action rejects", () => {
  const snap = snapshot(["a"]);
  const { ok } = validateDecisions([{ action: "explode", ids: ["a"] }], snap);
  assert.equal(ok, false);
});

test("merge keepSource must be in ids", () => {
  const snap = snapshot(["a", "b"]);
  const { ok } = validateDecisions([{ action: "merge", ids: ["a"], keepSource: "b", title: "t", content: "c" }], snap);
  assert.equal(ok, false);
});

test("conflict winner and loser must exist and differ", () => {
  const snap = snapshot(["a", "b"]);
  const { ok } = validateDecisions([{ action: "conflict", winner: "a", loser: "a" }], snap);
  assert.equal(ok, false);
  const { ok: ok2 } = validateDecisions([{ action: "conflict", winner: "a", loser: "zzz" }], snap);
  assert.equal(ok2, false);
});

test("duplicate primary ids across decisions reject", () => {
  const snap = snapshot(["a", "b"]);
  const { ok } = validateDecisions([
    { action: "archive", ids: ["a"] },
    { action: "keep", ids: ["a"] }
  ], snap);
  assert.equal(ok, false, "a claimed twice");
});

test("archived or summary entries cannot be decision targets", () => {
  const snap = new Map([["arch", { id: "arch", type: "project", title: "t", content: "c", importance: 3, archived: true, forgotten: false }]]);
  const { ok } = validateDecisions([{ action: "archive", ids: ["arch"] }], snap);
  assert.equal(ok, false);
});

test("empty decision list is a no-op success (model: nothing to consolidate)", () => {
  // 合法 JSON [] 是模型完整评估后确认无需操作（CONSOLIDATION_PROMPT 允许空输出），
  // 不是空体/截断——显式短路 ok，避免隐式 keep 的覆盖率检查误判 0% 为失败。
  const { ok, errors, skipped } = validateDecisions([], snapshot(["a"]));
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
  assert.deepEqual(skipped, []);
});

test("empty ids rejects", () => {
  const { ok } = validateDecisions([{ action: "archive", ids: [] }], snapshot(["a"]));
  assert.equal(ok, false);
});

test("merge requires non-empty title and content", () => {
  const snap = snapshot(["a"]);
  const base = { action: "merge", ids: ["a"], keepSource: "a" };
  for (const [title, content] of [["", "x"], ["t", ""], [undefined, "x"], ["t", undefined]]) {
    const { ok } = validateDecisions([{ ...base, title, content }], snap);
    assert.equal(ok, false, `title=${JSON.stringify(title)} content=${JSON.stringify(content)}`);
  }
});

test("summary entries cannot be decision targets", () => {
  const snap = new Map([["s", { id: "s", type: "summary", title: "t", content: "c", importance: 3, archived: false, forgotten: false }]]);
  const { ok } = validateDecisions([{ action: "archive", ids: ["s"] }], snap);
  assert.equal(ok, false);
});

test("uncovered snapshot memories are auto-filled with keep (implicit keep, v0.4.4)", () => {
  const snap = snapshot(["a", "b"]);
  const decisions = [{ action: "keep", ids: ["a"] }];
  const { ok, errors } = validateDecisions(decisions, snap);
  assert.equal(ok, true, errors.join("; "));
  assert.equal(decisions.length, 2, "keep appended for the uncovered snapshot id");
  assert.ok(decisions.some((d) => d.action === "keep" && d.ids.includes("b")), "b auto-kept");
});

test("dreamImplicitKeep=false keeps the strict full-coverage validation", () => {
  const snap = snapshot(["a", "b"]);
  const decisions = [{ action: "keep", ids: ["a"] }];
  const { ok, errors } = validateDecisions(decisions, snap, { dreamImplicitKeep: false });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("missing from decisions")));
});

test("duplicate ids within one decision reject", () => {
  const { ok } = validateDecisions([{ action: "keep", ids: ["a", "a"] }], snapshot(["a"]));
  assert.equal(ok, false);
});

test("merge importance out of range rejects", () => {
  const snap = snapshot(["a", "b"]);
  for (const importance of [0, 6, 99, 1.5, "4"]) {
    const { ok, errors } = validateDecisions([
      { action: "merge", ids: ["a", "b"], keepSource: "a", title: "t", content: "c", importance }
    ], snap);
    assert.equal(ok, false, `importance=${JSON.stringify(importance)} rejected`);
    assert.ok(errors.some((e) => e.includes("importance")), `importance error present for ${JSON.stringify(importance)}`);
  }
  const { ok } = validateDecisions([
    { action: "merge", ids: ["a", "b"], keepSource: "a", title: "t", content: "c", importance: 5 }
  ], snap);
  assert.equal(ok, true, "importance 5 accepted");
});

test("merge across types rejects", () => {
  const snap = new Map([
    ["p", { id: "p", type: "preference", title: "语言", content: "中文", importance: 3, archived: false, forgotten: false }],
    ["j", { id: "j", type: "project", title: "插件", content: "内容", importance: 3, archived: false, forgotten: false }]
  ]);
  const { ok, errors } = validateDecisions([
    { action: "merge", ids: ["p", "j"], keepSource: "p", title: "合并", content: "合并内容", importance: 4 }
  ], snap);
  assert.equal(ok, false, "cross-type merge rejected");
  assert.ok(errors.some((e) => e.includes("multiple types")), "multi-type error present");
});

function dreamSetup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  return { store, service };
}

test("applyDecisions merges: keepSource updated, others archived", () => {
  const { store, service } = dreamSetup();
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const { applied } = applyDecisions([
    { action: "merge", ids: [a.id, b.id], title: "插件总览", content: "合并内容", importance: 5, keepSource: b.id }
  ], service);
  assert.equal(applied, 1);
  const keeper = store.getById(b.id);
  assert.equal(keeper.content, "合并内容");
  assert.equal(keeper.title, "插件总览");
  assert.equal(keeper.importance, 5);
  assert.equal(store.getById(a.id).archived, true, "source archived");
});

test("applyDecisions conflict: winner kept, loser archived with provenance", () => {
  const { store, service } = dreamSetup();
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  applyDecisions([{ action: "conflict", winner: w.id, loser: l.id, reason: "更新" }], service);
  assert.equal(store.getById(l.id).archived, true);
  const winner = store.getById(w.id);
  assert.ok(winner.content.includes("8月20日"), "winner content intact");
  assert.ok(winner.content.includes("已否决旧信息"), "provenance note appended");
});

test("applyDecisions archive and keep", () => {
  const { store, service } = dreamSetup();
  const { memory: k } = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "废弃", content: "过时" });
  applyDecisions([
    { action: "keep", ids: [k.id] },
    { action: "archive", ids: [a.id], reason: "过时" }
  ], service);
  assert.equal(store.getById(k.id).archived, false);
  assert.equal(store.getById(a.id).archived, true);
});

test("applyDecisions returns count and never throws on unknown id (skip)", () => {
  const { store, service } = dreamSetup();
  const { memory: k } = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const { applied } = applyDecisions([{ action: "archive", ids: ["ghost"], reason: "x" }], service);
  assert.equal(applied, 0);
  assert.equal(store.getById(k.id).archived, false);
});

test("applyDecisions catch path: throwing decision is skipped, logged, and later decisions still apply", () => {
  const { store, service } = dreamSetup();
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "会炸", content: "x" });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "正常", content: "y" });
  const originalSetArchived = service.setArchived;
  let calls = 0;
  service.setArchived = (id, archived) => {
    calls++;
    if (calls === 1) throw new Error("boom");
    return originalSetArchived.call(service, id, archived);
  };
  const warnings = [];
  const logger = { warn: (msg) => warnings.push(msg) };
  const { applied, failures } = applyDecisions([
    { action: "archive", ids: [a.id], reason: "x" },
    { action: "archive", ids: [b.id], reason: "y" }
  ], service, logger);
  assert.equal(applied, 1, "throwing decision not counted, surviving decision counted");
  assert.equal(failures.length, 1, "thrown decision reported as a failure");
  assert.equal(store.getById(a.id).archived, false, "throwing decision left no partial effect");
  assert.equal(store.getById(b.id).archived, true, "later decision still applied");
  assert.equal(warnings.length, 1, "logger called once");
  assert.match(warnings[0], /failed to apply archive at index 0: boom/);
});

test("applyDecisions conflict with missing loser skips cleanly", () => {
  const { store, service } = dreamSetup();
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const { applied } = applyDecisions([{ action: "conflict", winner: w.id, loser: "ghost", reason: "x" }], service);
  assert.equal(applied, 0);
  assert.equal(store.getById(w.id).archived, false, "winner untouched");
  assert.ok(!store.getById(w.id).content.includes("已否决"), "no provenance note appended");
});

test("applyDecisions merge with missing keeper skips cleanly", () => {
  const { store, service } = dreamSetup();
  const { applied } = applyDecisions([
    { action: "merge", ids: ["ghost"], keepSource: "ghost", title: "t", content: "c" }
  ], service);
  assert.equal(applied, 0);
  assert.equal(store.getById("ghost"), undefined);
});

test("applyDecisions merge without importance falls back to max source importance", () => {
  const { store, service } = dreamSetup();
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const { applied } = applyDecisions([
    { action: "merge", ids: [a.id, b.id], title: "插件总览", content: "合并内容", keepSource: b.id }
  ], service);
  assert.equal(applied, 1);
  assert.equal(store.getById(b.id).importance, 4, "keeper keeps max of source importances");
  assert.equal(store.getById(a.id).archived, true, "source archived");
});

test("maybeSchedule triggers when count exceeds threshold", () => {
  const { store, service } = dreamSetup();
  let runs = 0;
  const dream = createDreamScheduler({
    onRun: async () => { runs++; },
    thresholdCount: 3,
    thresholdChars: 5000,
    delayMs: 0
  });
  for (let i = 0; i < 3; i++) service.saveWithDedupe({ type: "project", title: `m${i}`, content: "x".repeat(100) });
  const pending = dream.maybeSchedule(service);
  assert.equal(pending, true, "scheduled");
  assert.equal(runs, 0, "not run yet (async)");
  store.close();
});

test("maybeSchedule does not trigger below threshold", () => {
  const { store, service } = dreamSetup();
  const dream = createDreamScheduler({ onRun: async () => {}, thresholdCount: 10, thresholdChars: 5000, delayMs: 0 });
  service.saveWithDedupe({ type: "project", title: "only", content: "x" });
  assert.equal(dream.maybeSchedule(service), false);
  store.close();
});

test("scheduler fires async and resets baseline", async () => {
  const { store, service } = dreamSetup();
  let runs = 0;
  const dream = createDreamScheduler({
    onRun: async () => { runs++; return { ok: true }; },
    thresholdCount: 2, thresholdChars: 5000, delayMs: 5
  });
  for (let i = 0; i < 2; i++) service.saveWithDedupe({ type: "project", title: `m${i}`, content: "x".repeat(50) });
  dream.maybeSchedule(service);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(runs, 1, "ran once");
  // still above threshold but baseline reset → no immediate re-trigger
  assert.equal(dream.maybeSchedule(service), false, "baseline prevents loop");
  store.close();
});

test("failed run does not refresh baseline: next write re-triggers", async () => {
  const { store, service } = dreamSetup();
  let calls = 0;
  const dream = createDreamScheduler({
    onRun: async () => {
      calls++;
      return { ok: false, error: "llm failed" };
    },
    thresholdCount: 2, thresholdChars: 5000, delayMs: 5,
    logger: { warn: () => {} }
  });
  service.saveWithDedupe({ type: "project", title: "a", content: "x".repeat(10) });
  service.saveWithDedupe({ type: "project", title: "b", content: "y".repeat(10) });
  assert.equal(dream.maybeSchedule(service), true, "scheduled");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 1, "run attempted once");
  // baseline NOT refreshed on failure → the same write volume still triggers
  assert.equal(dream.maybeSchedule(service), true, "failed run keeps baseline, re-schedules");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 2, "retried after failure");
  store.close();
});

test("noop run (nothing changed) does not refresh baseline: next write re-triggers", async () => {
  const { store, service } = dreamSetup();
  let calls = 0;
  const dream = createDreamScheduler({
    onRun: async () => { calls++; return { ok: false, status: "noop", applied: 0, summary: false }; },
    thresholdCount: 2, thresholdChars: 5000, delayMs: 5,
    logger: { warn: () => {} }
  });
  service.saveWithDedupe({ type: "project", title: "a", content: "x".repeat(10) });
  service.saveWithDedupe({ type: "project", title: "b", content: "y".repeat(10) });
  assert.equal(dream.maybeSchedule(service), true, "scheduled");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 1, "run attempted once");
  // a noop is not a success: the baseline stays put so the accumulated writes
  // are still owed and the next write re-schedules instead of being absorbed
  assert.equal(dream.maybeSchedule(service), true, "noop keeps baseline, re-schedules");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 2, "retried after noop");
  store.close();
});

test("throwing run does not refresh baseline and is logged", async () => {
  const { store, service } = dreamSetup();
  const warnings = [];
  let calls = 0;
  const dream = createDreamScheduler({
    onRun: async () => {
      calls++;
      throw new Error("boom");
    },
    thresholdCount: 1, thresholdChars: 0, delayMs: 5,
    logger: { warn: (msg) => warnings.push(msg) }
  });
  service.saveWithDedupe({ type: "project", title: "a", content: "x" });
  assert.equal(dream.maybeSchedule(service), true, "scheduled");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 1, "run attempted once");
  assert.ok(warnings.some((m) => m.includes("run failed")), "throw logged");
  assert.equal(dream.maybeSchedule(service), true, "throw keeps baseline, re-schedules");
  store.close();
});

test("maybeSchedule returns false while a run is in flight", async () => {
  const { store, service } = dreamSetup();
  let release;
  const gate = new Promise((r) => { release = r; });
  let entered = false;
  const dream = createDreamScheduler({
    onRun: async () => { entered = true; await gate; },
    thresholdCount: 1, thresholdChars: 0, delayMs: 0,
    logger: { warn: () => {} }
  });
  service.saveWithDedupe({ type: "project", title: "a", content: "x" });
  assert.equal(dream.maybeSchedule(service), true, "first schedule accepted");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(entered, true, "run started");
  assert.equal(dream.maybeSchedule(service), false, "no schedule while running");
  release();
  await new Promise((r) => setTimeout(r, 10)); // let the run finish + baseline refresh
  store.close();
});

test("dispose clears pending timer and blocks future scheduling", async () => {
  const { store, service } = dreamSetup();
  let runs = 0;
  const dream = createDreamScheduler({
    onRun: async () => { runs++; },
    thresholdCount: 1, thresholdChars: 0, delayMs: 5,
    logger: { warn: () => {} }
  });
  service.saveWithDedupe({ type: "project", title: "a", content: "x" });
  assert.equal(dream.maybeSchedule(service), true, "scheduled");
  dream.dispose();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runs, 0, "pending run cancelled by dispose");
  assert.equal(dream.maybeSchedule(service), false, "disposed scheduler never schedules");
  store.close();
});

test("dispose awaits an in-flight run so the store can close safely", async () => {
  const { store, service } = dreamSetup();
  let release;
  const gate = new Promise((r) => { release = r; });
  let entered = false;
  let finished = false;
  const dream = createDreamScheduler({
    onRun: async () => { entered = true; await gate; finished = true; },
    thresholdCount: 1, thresholdChars: 0, delayMs: 0,
    logger: { warn: () => {} }
  });
  service.saveWithDedupe({ type: "project", title: "a", content: "x" });
  assert.equal(dream.maybeSchedule(service), true, "scheduled");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(entered, true, "run started");

  const disposeP = dream.dispose();
  let settled = false;
  disposeP.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false, "dispose must not resolve while a run is in flight");
  assert.equal(finished, false, "run still pending");

  release();
  await disposeP;
  assert.equal(finished, true, "run completed before dispose resolved");
  store.close();
});

test("runDream stores summary and applies decisions", async () => {
  const { store, service } = dreamSetup();
  // seed 2 memories so snapshot is non-empty and decisions cover them
  const a = service.saveWithDedupe({ type: "project", title: "旧1", content: "第一段内容" });
  const b = service.saveWithDedupe({ type: "project", title: "旧2", content: "第二段内容" });
  let calls = 0;
  const ctx = {
    llm: {
      stream: async function* () {
        calls++;
        if (calls === 1) {
          const text = JSON.stringify([
            { action: "merge", ids: [a.memory.id, b.memory.id], title: "合并标题", content: "合并后的内容", importance: 4, keepSource: a.memory.id }
          ]);
          yield { type: "text-delta", text };
        } else {
          yield { type: "text-delta", text: "记忆库总览摘要文本" };
        }
        yield { type: "finish", reason: { kind: "ok" } };
      }
    },
    logger: { warn: () => {} }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat" });
  assert.equal(result.ok, true);
  assert.equal(result.applied, 1, "merge decision applied");
  assert.equal(result.summary, true, "summary stored");
  const keeper = store.getById(a.memory.id);
  assert.equal(keeper.title, "合并标题", "keeper title updated");
  assert.equal(keeper.content, "合并后的内容", "keeper content updated");
  assert.equal(keeper.importance, 4, "keeper importance updated");
  assert.equal(store.getById(b.memory.id).archived, true, "merged source archived");
  const summary = store.all().find((m) => m.type === "summary");
  assert.ok(summary, "summary created");
  assert.equal(summary.title, "记忆库总览");
  // 常驻状态条（#164 对齐）：叙述正文 + 快照口径脚注
  assert.ok(summary.content.startsWith("记忆库总览摘要文本"));
  assert.ok(summary.content.includes("〔口径：基于整理后"), "scope footer present");
  assert.ok(summary.content.includes("条记忆快照"), "scope footer carries input count");
  store.close();
});

test("runDream fails safe on invalid decisions", async () => {
  const { store, service } = dreamSetup();
  const saved = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  let calls = 0;
  const warnings = [];
  const ctx = {
    llm: {
      stream: async function* () {
        calls++;
        yield { type: "text-delta", text: calls === 1 ? "not json at all" : "summary" };
        yield { type: "finish", reason: { kind: "ok" } };
      }
    },
    logger: { warn: (msg) => warnings.push(msg) }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat" });
  assert.equal(result.ok, false, "invalid decisions rejected");
  assert.equal(result.summary, false, "no summary flag on failure");
  assert.equal(store.all().filter((m) => m.type === "summary").length, 0, "no summary on failure");
  const lang = store.getById(saved.memory.id);
  assert.ok(lang, "original memory still present");
  assert.equal(lang.archived, false, "original memory not archived");
  assert.equal(lang.content, "中文", "original memory content untouched");
  assert.ok(warnings.length >= 1, "failure was logged");
  store.close();
});

test("Issue #135: failed validation persists { _validationFailed, errors, skipped } into the run row", async () => {
  const { store, service } = dreamSetup();
  const saved = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  let calls = 0;
  const ctx = {
    llm: {
      stream: async function* () {
        calls++;
        yield { type: "text-delta", text: calls === 1 ? JSON.stringify([{ action: "archive", ids: ["deadbeef"] }]) : "summary" };
        yield { type: "finish", reason: { kind: "ok" } };
      }
    },
    logger: { warn: () => {}, info: () => {} }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat" });
  assert.equal(result.ok, false, "coverage gate rejects (0% explicit coverage)");
  assert.ok(Array.isArray(result.decisions) && result.decisions[0]?._validationFailed === true,
    "failure result carries the validation detail");
  assert.ok(result.decisions[0].skipped.some((s) => s.error.includes("deadbeef")),
    "skipped keeps the per-item reason");
  // 落库验证：dream_runs.decisions 不再是 NULL，事后可离线定位失败原因。
  const run = store.getDreamRun(result.runId);
  assert.ok(run?.decisions?.[0]?._validationFailed === true, "detail persisted in dream_runs.decisions");
  assert.ok(run.decisions[0].skipped.length >= 1);
  const lang = store.getById(saved.memory.id);
  assert.equal(lang.archived, false, "unknown-id decision must not touch real memories");
  store.close();
});

// --- item ①: CAS guard against concurrent edits ----------------------------

test("applyDecisions CAS: merge onto a concurrently-edited target is skipped as a conflict, not applied", () => {
  const { store, service } = dreamSetup();
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  // snapshot captured before the "LLM call"; a concurrent edit lands meanwhile
  const snapshot = new Map([a.id, b.id].map((id) => [id, store.getById(id)]));
  service.update(a.id, { content: "并发编辑" });
  const { applied, conflicts, committed } = applyDecisions([
    { action: "merge", ids: [a.id, b.id], title: "插件总览", content: "合并内容", importance: 5, keepSource: b.id }
  ], service, null, snapshot);
  assert.equal(applied, 0, "decision skipped entirely");
  assert.equal(conflicts.length, 1, "recorded as a CAS conflict");
  assert.equal(committed.length, 0, "nothing committed");
  assert.equal(store.getById(a.id).content, "并发编辑", "concurrent edit preserved");
  assert.equal(store.getById(b.id).archived, false, "source not archived");
  assert.equal(store.getById(b.id).title, "插件2", "keeper untouched");
  store.close();
});

test("applyDecisions CAS: update to a concurrently-edited memory is skipped as a conflict", () => {
  const { store, service } = dreamSetup();
  const { memory: m } = service.saveWithDedupe({ type: "preference", title: "语言", content: "喜欢 Python" });
  const snapshot = new Map([[m.id, store.getById(m.id)]]);
  service.update(m.id, { content: "并发改动" });
  const { applied, conflicts } = applyDecisions(
    [{ action: "update", ids: [m.id], content: "喜欢 Rust" }],
    service, null, snapshot
  );
  assert.equal(applied, 0);
  assert.equal(conflicts.length, 1);
  assert.equal(store.getById(m.id).content, "并发改动", "concurrent edit wins");
  store.close();
});

test("applyDecisions without a snapshot skips the CAS guard (replay path unchanged)", () => {
  const { store, service } = dreamSetup();
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  service.update(a.id, { content: "并发编辑" }); // concurrent edit
  const { applied, conflicts } = applyDecisions([
    { action: "archive", ids: [a.id], reason: "x" }
  ], service);
  assert.equal(applied, 1, "snapshotless replay applies (no CAS guard)");
  assert.equal(conflicts.length, 0);
  assert.equal(store.getById(a.id).archived, true);
  store.close();
});

// --- item ②: per-decision transaction atomicity ----------------------------

test("applyDecisions merge is atomic: a throwing archive step rolls back the keeper update too", () => {
  const { store, service } = dreamSetup();
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "甲", content: "旧甲", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "乙", content: "旧乙", importance: 4 });
  const originalSetArchived = service.setArchived;
  service.setArchived = (id, archived) => {
    if (id === a.id) throw new Error("archive boom");
    return originalSetArchived.call(service, id, archived);
  };
  const warnings = [];
  const { applied, failures, committed } = applyDecisions([
    { action: "merge", ids: [a.id, b.id], title: "甲乙", content: "合并", importance: 4, keepSource: b.id }
  ], service, { warn: (m) => warnings.push(m) });
  assert.equal(applied, 0, "merge not committed");
  assert.equal(failures.length, 1, "reported as a failure");
  assert.equal(committed.length, 0, "outcome must not claim a merge that rolled back");
  assert.equal(store.getById(b.id).title, "乙", "keeper title untouched by the rolled-back update");
  assert.equal(store.getById(b.id).content, "旧乙", "keeper content untouched");
  assert.equal(store.getById(a.id).archived, false, "source not archived");
  assert.ok(warnings.length >= 1, "failure logged");
  store.close();
});

// --- conflict freeze: manual review instead of auto-adjudication ----------

function freezeCtx({ conflicts, includes = [], summaryText = "记忆库总览摘要" }) {
  let calls = 0;
  const warnings = [];
  const ctx = {
    warnings,
    llm: {
      stream: async function* () {
        calls++;
        const list = [...includes, ...conflicts];
        yield { type: "text-delta", text: calls === 1 ? JSON.stringify(list) : summaryText };
        yield { type: "finish", reason: { kind: "ok" } };
      }
    },
    logger: { warn: (m) => warnings.push(m) }
  };
  return ctx;
}

test("runDream with conflictFreezeEnabled parks conflicts instead of adjudicating", async () => {
  const { store, service } = dreamSetup();
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  const ctx = freezeCtx({ conflicts: [{ action: "conflict", winner: w.id, loser: l.id, reason: "日期更新，候选取新" }] });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, {
    dreamProvider: "deepseek", dreamModel: "deepseek-chat", conflictFreezeEnabled: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.applied, 0, "no conflict applied");
  assert.equal(result.frozen, 1, "one conflict frozen");
  // pending row recorded for human review
  const pending = store.listConflictPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].reason, "日期更新，候选取新");
  // neither side was auto-adjudicated
  assert.equal(store.getById(l.id).archived, false, "loser NOT archived");
  assert.equal(store.getById(w.id).archived, false, "winner NOT archived");
  assert.ok(!store.getById(w.id).content.includes("已否决旧信息"), "no provenance note appended");
  // audit outcome marks both sides pending
  const run = store.listDreamRuns()[0];
  assert.equal(run.outcome.byId[w.id], "conflict-pending");
  assert.equal(run.outcome.byId[l.id], "conflict-pending");
  assert.equal(run.status, "ok", "summary stored + freeze landed → ok");
  assert.equal(store.listReceipts().length, 0, "no conflict receipt for a frozen (unapplied) conflict");
  store.close();
});

test("runDream freeze keeps auto-adjudication when disabled (default)", async () => {
  const { store, service } = dreamSetup();
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  const ctx = freezeCtx({ conflicts: [{ action: "conflict", winner: w.id, loser: l.id, reason: "更新" }] });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat" });
  assert.equal(result.ok, true);
  assert.equal(result.applied, 1, "conflict auto-adjudicated when freeze is off");
  assert.equal(result.frozen, 0);
  assert.equal(store.getById(l.id).archived, true, "loser archived");
  assert.ok(store.getById(w.id).content.includes("已否决旧信息"), "provenance note appended");
  assert.equal(store.listConflictPending().length, 0, "no pending rows in auto mode");
  store.close();
});

test("runDream freeze applies non-conflict decisions while parking conflicts", async () => {
  const { store, service } = dreamSetup();
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  const ctx = freezeCtx({
    includes: [{ action: "merge", ids: [a.id, b.id], title: "插件总览", content: "合并内容", importance: 5, keepSource: b.id }],
    conflicts: [{ action: "conflict", winner: w.id, loser: l.id, reason: "日期更新" }]
  });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, {
    dreamProvider: "deepseek", dreamModel: "deepseek-chat", conflictFreezeEnabled: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.applied, 1, "merge applied normally");
  assert.equal(result.frozen, 1, "conflict frozen");
  assert.equal(store.getById(b.id).title, "插件总览", "merge keeper updated");
  assert.equal(store.getById(a.id).archived, true, "merge source archived");
  assert.equal(store.getById(l.id).archived, false, "conflict loser untouched by the merge run");
  const pending = store.listConflictPending();
  assert.equal(pending.length, 1);
  assert.ok(pending[0].reason.includes("日期更新"));
  store.close();
});

test("runDream freeze respects conflictFreezeMaxPending cap and skips overflow", async () => {
  const { store, service } = dreamSetup();
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  const ctx = freezeCtx({ conflicts: [{ action: "conflict", winner: w.id, loser: l.id, reason: "x" }] });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, {
    dreamProvider: "deepseek", dreamModel: "deepseek-chat",
    conflictFreezeEnabled: true, conflictFreezeMaxPending: 0
  });
  assert.equal(result.frozen, 0, "nothing frozen at capacity");
  assert.equal(store.listConflictPending().length, 0, "no pending rows");
  assert.ok(ctx.warnings.some((m) => m.includes("freeze queue full")), "capacity warning logged");
  store.close();
});

test("runDream freeze store failure never blocks the run (fail-safe)", async () => {
  const { store, service } = dreamSetup();
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  service.saveConflictPending = () => { throw new Error("pending store boom"); };
  service.countConflictPending = () => { throw new Error("count boom"); };
  const ctx = freezeCtx({ conflicts: [{ action: "conflict", winner: w.id, loser: l.id, reason: "x" }] });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, {
    dreamProvider: "deepseek", dreamModel: "deepseek-chat", conflictFreezeEnabled: true
  });
  assert.equal(result.ok, true, "run completes despite freeze store failure");
  assert.equal(result.frozen, 0, "nothing frozen");
  assert.ok(ctx.warnings.length >= 1, "freeze failure logged");
  assert.equal(store.getById(l.id).archived, false, "no side effects on memories");
  assert.equal(store.getById(w.id).content, "8月20日", "winner untouched");
  store.close();
});

// --- v0.4.4: 大记忆量 autoDream（滑动窗口 + 隐式 keep）回归 -----------------

test("autoDream with 650 memories: sliding window truncates snapshot + implicit keep fills uncovered ids", async () => {
  const { store, service } = dreamSetup();
  // seed 650 memories — the size that used to produce 677 "missing from
  // decisions" errors and applied=0 under the strict full-coverage check
  for (let i = 0; i < 650; i++) {
    service.saveWithDedupe({ type: "project", title: `主题${i}`, content: `内容${i}`, importance: 3 });
  }
  // mock LLM claims only a small subset (20 archives) and never emits keeps
  // for the rest — implicit keep must auto-fill the uncovered snapshot ids
  const ctx = mockCtx({
    onConsolidation: (listText) => {
      const ids = [...listText.matchAll(/id=([^\s|]+)\s*\|\s*type=(\w+)\s*\|\s*importance=\d+/g)]
        .map((m) => m[1]);
      return JSON.stringify(ids.slice(0, 20).map((id) => ({ action: "archive", ids: [id], reason: "stale" })));
    }
  });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, {
    dreamProvider: "deepseek", dreamModel: "deepseek-chat", dreamMaxSnapshotSize: 200,
    // mock only claims 20/200 = 10%; the implicit-keep coverage floor must be
    // lowered so this deliberate "tiny explicit claim" scenario still passes
    // (it exercises the window + keep-fill, not the coverage guard). Same for
    // the archive cap: 20 mock archives exceed the default 8 — #104 方向 2.
    dreamMinExplicitCoverage: 0.1,
    dreamMaxArchivePerRun: 20
  });
  assert.equal(result.ok, true, "run succeeds instead of 677-error rejection");
  assert.ok(result.applied > 0, "archive decisions applied");
  // snapshot capped at the sliding window
  const run = store.listDreamRuns()[0];
  assert.equal(run.input_count, 200, "snapshot truncated to dreamMaxSnapshotSize");
  // decisions cover exactly the snapshot window, with implicit keeps
  assert.equal(result.decisions.length, 200, "decisions count = snapshot count");
  assert.equal(result.decisions.filter((d) => d.action === "archive").length, 20, "claimed subset present");
  assert.equal(result.decisions.filter((d) => d.action === "keep").length, 180, "uncovered ids auto-kept");
  assert.equal(store.getById(result.decisions.find((d) => d.action === "archive").ids[0]).archived, true, "an archive landed");
  store.close();
});

// --- v0.4.4 fix: 残缺输出防洗白（显式覆盖率下限） + 严格模式透传 --------------

test("validateDecisions degrades a low-coverage valid output (Issue #104 方向 1)", () => {
  const snap = snapshot(["a", "b", "c", "d"]);
  const decisions = [{ action: "keep", ids: ["a"] }]; // claims 1/4 = 25%
  const { ok, errors, coverageShortfall } = validateDecisions(decisions, snap, { dreamMinExplicitCoverage: 0.5 });
  assert.equal(ok, true, "valid subset applies — coverage shortfall degrades instead of rejecting");
  assert.deepEqual(errors, [], "shortfall is not a per-decision error");
  assert.match(
    String(coverageShortfall),
    /explicit decision coverage 25% < minimum 50%/,
    `coverage reason surfaced, got: ${coverageShortfall}`
  );
  assert.equal(decisions.length, 4, "implicit keeps fill the unclaimed ids");
});

test("validateDecisions covers the whole snapshot when explicit coverage meets the floor", () => {
  const snap = snapshot(["a", "b", "c", "d"]);
  const decisions = [{ action: "archive", ids: ["a", "b"], reason: "stale" }]; // claims 2/4 = 50%
  const { ok, errors } = validateDecisions(decisions, snap, { dreamMinExplicitCoverage: 0.5 });
  assert.equal(ok, true, errors.join("; "));
  assert.equal(decisions.length, 3, "archive + 2 implicit keeps for c/d");
  assert.equal(decisions.filter((d) => d.action === "keep").length, 2);
});

test("runDream with dreamImplicitKeep=false rejects a partial mock output (missing from decisions)", async () => {
  const { store, service } = dreamSetup();
  for (let i = 0; i < 3; i++) {
    service.saveWithDedupe({ type: "project", title: `主题${i}`, content: `内容${i}`, importance: 3 });
  }
  // mock only claims the first snapshot id, misses the rest — strict mode must
  // reject the whole run instead of auto-keeping the uncovered ids
  const warnings = [];
  const ctx = {
    warnings,
    logger: { warn: (m) => warnings.push(m) },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "stress-model" }) },
    llm: {
      async *stream(options) {
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        if (userText.startsWith("id=")) {
          const ids = [...userText.matchAll(/id=([^\s|]+)\s*\|\s*type=(\w+)\s*\|\s*importance=\d+/g)].map((m) => m[1]);
          yield { type: "text-delta", index: 0, text: JSON.stringify(ids.slice(0, 1).map((id) => ({ action: "archive", ids: [id], reason: "stale" }))) };
        } else {
          yield { type: "text-delta", index: 0, text: "记忆库总览摘要" };
        }
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, {
    dreamProvider: "deepseek", dreamModel: "deepseek-chat",
    dreamImplicitKeep: false
  });
  assert.equal(result.ok, false, "strict mode rejects the partial output");
  assert.match(result.error, /invalid decisions: \d+ errors/);
  assert.ok(warnings.some((m) => m.includes("missing from decisions")), "warned which ids are missing");
  assert.equal(store.listDreamRuns()[0].status, "failed", "run audited as failed");
  store.close();
});

test("runDream sliding window keeps the newest N memories and excludes the oldest", async () => {
  const { store, service } = dreamSetup();
  // seed 5 memories, backdate updated_at so i=0 is oldest (5h ago), i=4 newest (1h ago)
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const { memory } = service.saveWithDedupe({ type: "project", title: `主题${i}`, content: `内容${i}`, importance: 3 });
    ids.push(memory.id);
  }
  for (let i = 0; i < 5; i++) {
    const old = new Date(Date.now() - (5 - i) * 3600000).toISOString();
    store.db.prepare("UPDATE memories SET updated_at = ?, created_at = ? WHERE id = ?").run(old, old, ids[i]);
  }
  const ctx = mockCtx({
    onConsolidation: (listText) => {
      const inWindow = [...listText.matchAll(/id=([^\s|]+)\s*\|\s*type=(\w+)\s*\|\s*importance=\d+/g)]
        .map((m) => m[1]);
      return JSON.stringify(inWindow.map((id) => ({ action: "keep", ids: [id] })));
    }
  });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, {
    dreamProvider: "deepseek", dreamModel: "deepseek-chat", dreamMaxSnapshotSize: 3
  });
  const run = store.listDreamRuns()[0];
  assert.equal(run.input_count, 3, "window capped at dreamMaxSnapshotSize");
  const windowIds = run.input.map((m) => m.id).sort();
  const expected = [ids[2], ids[3], ids[4]].sort(); // newest 3 by updated_at
  assert.deepEqual(windowIds, expected, "window contains the newest 3 memories");
  assert.ok(!windowIds.includes(ids[0]), "oldest memory excluded from the window");
  assert.equal(result.decisions.length, 3, "decisions cover exactly the window");
  store.close();
});

// --- v0.4.4 fix: 决策 JSON schema 固化（kimi 等模型输出合规） -----------------

test("consolidation prompt pins the decision schema (action field, single-string winner/loser, single claim per id)", async () => {
  const { store, service } = dreamSetup();
  service.saveWithDedupe({ type: "project", title: "a", content: "x" });
  let systemText = "";
  const ctx = {
    logger: { warn: () => {} },
    llm: {
      async *stream(options) {
        // 只捕获第一次调用（consolidation）的 system 文本：空数组现在走 no-op 成功、
        // summary 会照常跑并覆盖 systemText，所以最后一次调用捕获到的是 SUMMARY_PROMPT。
        if (!systemText) systemText = options.messages.find((m) => m.role === "system")?.content?.[0]?.text ?? "";
        yield { type: "text-delta", text: "[]" };
        yield { type: "finish", reason: { kind: "ok" } };
      }
    }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat" });
  // 字段名必须写死为 action（kimi 曾输出 "type" 导致整单拒绝）
  assert.match(systemText, /"action"/, "prompt names the action field");
  assert.match(systemText, /严禁写成\s*type/, "prompt forbids the type field name");
  // conflict winner/loser 是单个 id 字符串而非数组
  assert.match(systemText, /"winner"/, "prompt names the winner field");
  assert.match(systemText, /"loser"/, "prompt names the loser field");
  assert.match(systemText, /单个 id 字符串/, "winner/loser must be a single id string");
  assert.match(systemText, /不是数组|绝不是数组/, "winner/loser must not be an array");
  // 同一 id 不可被多个决策重复 claim
  assert.match(systemText, /最多被 claim 一次/, "each memory claimed at most once");
  // 决策 JSON 示例块
  assert.match(systemText, /决策 JSON 示例/, "prompt includes a canonical example block");
  store.close();
});

// --- Bug8: llm_audit_logs trail ----------------------------------------------

test("Bug8: runDream records llm_audit_logs rows for consolidation and summary", async () => {
  const { store, service } = dreamSetup();
  service.saveWithDedupe({ type: "project", title: "旧1", content: "第一段内容" });
  service.saveWithDedupe({ type: "project", title: "旧2", content: "第二段内容" });
  const ctx = mockCtx({
    onConsolidation: (listText) => JSON.stringify([{ action: "keep", ids: [listText.match(/id=([^\s|]+)/)[1]] }])
  });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat" });
  assert.equal(result.ok, true, "run succeeds");
  const rows = store.listLlmAudits();
  assert.equal(rows.length, 2, "consolidation + summary both audited");
  assert.deepEqual(rows.map((r) => r.trigger_source), ["autoDream", "autoDream"]);
  assert.deepEqual(rows.map((r) => r.operation_type).sort(), ["dream_consolidate", "dream_summarize"]);
  const consolidate = rows.find((r) => r.operation_type === "dream_consolidate");
  assert.equal(consolidate.related_memory_ids.length, 2, "consolidation audit links the snapshot ids");
  const summarize = rows.find((r) => r.operation_type === "dream_summarize");
  assert.deepEqual(summarize.related_memory_ids, [], "summary audit has no related ids");
  for (const row of rows) {
    assert.equal(row.status, "success");
    assert.equal(row.model_id, "deepseek:deepseek-chat", "config-first route (Issue #25): dreamProvider/dreamModel wins");
    assert.ok(Number.isInteger(row.duration_ms) && row.duration_ms >= 0, "duration recorded");
    assert.equal(row.input_tokens, 0);
    assert.equal(row.output_tokens, 0);
  }
  store.close();
});

test("Bug8: a failed LLM call is recorded with status=error and does not block the run", async () => {
  const { store, service } = dreamSetup();
  service.saveWithDedupe({ type: "project", title: "主题", content: "内容" });
  const ctx = {
    logger: { warn: () => {} },
    llm: {
      stream: async function* () {
        yield { type: "finish", reason: { kind: "error" } };
      }
    }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat" });
  assert.equal(result.ok, false, "failed run reported");
  const rows = store.listLlmAudits();
  assert.equal(rows.length, 1, "one audit row for the failed consolidation call");
  assert.equal(rows[0].operation_type, "dream_consolidate");
  assert.equal(rows[0].status, "error", "LLM failure status=error");
  assert.ok(rows[0].error_message, "error message recorded");
  store.close();
});

// --- Issue #89 回归修复：v0.6.9（Issue #26）的 skipInvalid 宽容路径在 v0.7.11
// 重写中丢失，弱模型（如 qwen3.8-flash）单条非法决策导致整单拒绝、合法子集
// 全部白烧。以下单测自 v0.6.9 测试原样移植，锁定恢复后的行为。-------------

test("validateDecisions skipInvalid: a single invalid decision is skipped, valid subset survives", () => {
  const snap = new Map([
    ["p", { id: "p", type: "preference", title: "语言", content: "中文", importance: 3, archived: false, forgotten: false }],
    ["j", { id: "j", type: "project", title: "插件", content: "内容", importance: 3, archived: false, forgotten: false }],
    ["a", { id: "a", type: "project", title: "旧A", content: "过时A", importance: 3, archived: false, forgotten: false }],
    ["b", { id: "b", type: "project", title: "旧B", content: "过时B", importance: 3, archived: false, forgotten: false }]
  ]);
  const decisions = [
    { action: "merge", ids: ["p", "j"], keepSource: "p", title: "跨类型", content: "不应合并", importance: 4 },
    { action: "archive", ids: ["a"], reason: "stale" },
    { action: "archive", ids: ["b"], reason: "stale" }
  ];
  const { ok, errors, skipped } = validateDecisions(decisions, snap, { skipInvalid: true });
  assert.equal(ok, true, `valid subset should survive, got: ${errors.join("; ")}`);
  assert.equal(skipped.length, 1, "cross-type merge recorded as skipped");
  assert.equal(skipped[0].index, 0, "the skipped one is the cross-type merge");
  assert.match(skipped[0].error, /multiple types/, "skip reason mentions types");
  // invalid merge spliced out of the caller's array; valid archives + implicit
  // keeps for p/j survive (p/j were left unclaimed by the skipped merge)
  assert.deepEqual(decisions.map((d) => d.action), ["archive", "archive", "keep", "keep"]);
  assert.deepEqual(decisions[0].ids, ["a"]);
  assert.ok(decisions.some((d) => d.action === "keep" && d.ids.includes("p")), "p auto-kept");
  assert.ok(decisions.some((d) => d.action === "keep" && d.ids.includes("j")), "j auto-kept");
});

test("validateDecisions skipInvalid: an all-invalid batch still rejects (zero-survivor guard, #104 方向 1 重审后保留)", () => {
  const snap = new Map([
    ["p", { id: "p", type: "preference", title: "语言", content: "中文", importance: 3, archived: false, forgotten: false }],
    ["j", { id: "j", type: "project", title: "插件", content: "内容", importance: 3, archived: false, forgotten: false }],
    ["d1", { id: "d1", type: "decision", title: "决定", content: "内容D", importance: 3, archived: false, forgotten: false }],
    ["b", { id: "b", type: "project", title: "旧B", content: "过时B", importance: 3, archived: false, forgotten: false }]
  ]);
  // both decisions are cross-type merges → both skipped → valid claims = 0
  const decisions = [
    { action: "merge", ids: ["p", "j"], keepSource: "p", title: "跨类型", content: "不应合并", importance: 4 },
    { action: "merge", ids: ["d1", "b"], keepSource: "d1", title: "跨类型2", content: "不应合并", importance: 4 }
  ];
  const { ok, errors, skipped } = validateDecisions(decisions, snap, { skipInvalid: true });
  assert.equal(ok, false, "no valid decisions left → whole batch rejected");
  assert.equal(skipped.length, 2);
  assert.ok(errors.some((e) => e.includes("nothing valid survived")), "zero-survivor guard error present");
  assert.equal(decisions.length, 2, "rejected batch left untouched (splice only on the success path)");
});

test("validateDecisions skipInvalid: runaway update count still rejects the whole batch (global cap)", () => {
  const snap = new Map([
    ["a", { id: "a", type: "project", title: "A", content: "旧A", importance: 3, archived: false, forgotten: false, created_at: "2020-01-01T00:00:00.000Z" }],
    ["b", { id: "b", type: "project", title: "B", content: "旧B", importance: 3, archived: false, forgotten: false, created_at: "2020-01-01T00:00:00.000Z" }],
    ["c", { id: "c", type: "project", title: "C", content: "旧C", importance: 3, archived: false, forgotten: false, created_at: "2020-01-01T00:00:00.000Z" }]
  ]);
  const decisions = [
    { action: "update", ids: ["a"], content: "新A" },
    { action: "update", ids: ["b"], content: "新B" },
    { action: "update", ids: ["c"], content: "新C" }
  ];
  const { ok, errors } = validateDecisions(decisions, snap, { skipInvalid: true });
  assert.equal(ok, false, "3 updates > default cap 2 → still rejects");
  assert.ok(errors.some((e) => e.includes("too many update decisions")), "global cap error present");
});

test("validateDecisions allowCrossTypeMerge: cross-type merge is allowed when the flag is on", () => {
  const snap = new Map([
    ["p", { id: "p", type: "preference", title: "语言", content: "中文", importance: 3, archived: false, forgotten: false }],
    ["j", { id: "j", type: "project", title: "插件", content: "内容", importance: 3, archived: false, forgotten: false }]
  ]);
  const decisions = [
    { action: "merge", ids: ["p", "j"], keepSource: "p", title: "合并", content: "合并内容", importance: 4 }
  ];
  const { ok, errors } = validateDecisions(decisions, snap, { allowCrossTypeMerge: true });
  assert.equal(ok, true, `cross-type merge allowed with the flag, got: ${errors.join("; ")}`);
  assert.equal(decisions.length, 1, "no keep appended (both snapshot ids claimed)");
});

test("validateDecisions default (no options) stays strict — sleep passes unchanged", () => {
  const snap = new Map([
    ["a", { id: "a", type: "project", title: "A", content: "旧A", importance: 3, archived: false, forgotten: false }],
    ["b", { id: "b", type: "project", title: "B", content: "旧B", importance: 3, archived: false, forgotten: false }]
  ]);
  const { ok, skipped } = validateDecisions([{ action: "archive", ids: ["zzz"], reason: "x" }], snap);
  assert.equal(ok, false, "strict rejection without skipInvalid");
  assert.deepEqual(skipped, [], "no skipped bookkeeping in strict mode");
});

test("issue#89: dream run with a skipped invalid decision lands the valid subset and is marked degraded", async () => {
  const { store, service } = dreamSetup();
  const a = service.saveWithDedupe({ type: "project", title: "旧A", content: "过时A" }).memory;
  const b = service.saveWithDedupe({ type: "project", title: "旧B", content: "过时B" }).memory;
  const pref = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" }).memory;
  const c = service.saveWithDedupe({ type: "project", title: "旧C", content: "过时C" }).memory;
  const warnings = [];
  const ctx = {
    logger: { warn: (m) => warnings.push(String(m)) },
    llm: {
      async *stream(options) {
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        if (userText.startsWith("id=")) {
          // 一条跨类型 merge（非法 → 跳过）+ 两条合法 archive（覆盖 2/4 快照，
  // 高于 50% 显式覆盖率下限）
          yield { type: "text-delta", index: 0, text: JSON.stringify([
            { action: "merge", ids: [pref.id, a.id], keepSource: pref.id, title: "跨类型", content: "不应合并", importance: 4 },
            { action: "archive", ids: [b.id], reason: "stale" },
            { action: "archive", ids: [c.id], reason: "stale" }
          ]) };
        } else {
          yield { type: "text-delta", index: 0, text: "记忆库总览：弱模型的个别非法决策不再拖垮整轮巩固。" };
        }
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "mock", dreamModel: "mock-model" });
  assert.equal(result.ok, true, "valid subset absorbed (ok for the baseline)");
  assert.equal(result.status, "degraded", "run marked degraded, not faked ok");
  assert.equal(store.getById(b.id).archived, true, "valid archive applied");
  assert.equal(store.getById(pref.id).archived, false, "invalid merge did not touch its targets");
  assert.ok(warnings.some((w) => w.includes("skipped") && w.includes("multiple types")), "skip reason logged");
  store.close();
});

// Issue #104（跟进 #137 失败路径）：degraded（合法子集已应用）轮的跳过明细此前只进
// logger.warn，splice 之后就地从 decisions 里消失，落库的已是幸存列表——离线回放
// dream_runs 无法判断被跳的是跨类型 merge、update 保护期还是 unknown id。这里断言
// 明细进了独立的 skipped 列（而非内联进 decisions），且携带可定位的逐条原因。
test("issue#104: degraded run persists the skipped decision detail into dream_runs.skipped", async () => {
  const { store, service } = dreamSetup();
  const a = service.saveWithDedupe({ type: "project", title: "旧A", content: "过时A" }).memory;
  const b = service.saveWithDedupe({ type: "project", title: "旧B", content: "过时B" }).memory;
  const pref = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" }).memory;
  const c = service.saveWithDedupe({ type: "project", title: "旧C", content: "过时C" }).memory;
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    llm: {
      async *stream(options) {
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        if (userText.startsWith("id=")) {
          // 一条跨类型 merge（非法 → 跳过）+ 两条合法 archive（显式覆盖 2/4，过 50% 下限）
          yield { type: "text-delta", index: 0, text: JSON.stringify([
            { action: "merge", ids: [pref.id, a.id], keepSource: pref.id, title: "跨类型", content: "不应合并", importance: 4 },
            { action: "archive", ids: [b.id], reason: "stale" },
            { action: "archive", ids: [c.id], reason: "stale" }
          ]) };
        } else {
          yield { type: "text-delta", index: 0, text: "记忆库总览：degraded 轮的跳过明细可从审计行回放。" };
        }
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "mock", dreamModel: "mock-model" });
  assert.equal(result.status, "degraded", "run degrades on the skipped decision");
  // 落库验证：skipped 列不再是 NULL，逐条带 index/action/error，事后无需重跑即可定位成因。
  const run = store.getDreamRun(result.runId);
  assert.ok(Array.isArray(run?.skipped) && run.skipped.length === 1, "skipped detail persisted in dream_runs.skipped");
  assert.equal(run.skipped[0].index, 0, "the skipped entry is the cross-type merge");
  assert.equal(run.skipped[0].action, "merge");
  assert.match(run.skipped[0].error, /multiple types/, "per-item skip reason is kept");
  // 独立字段，不污染按「决策数组」消费 decisions 的下游读者。
  assert.ok(!run.decisions.some((d) => d && d._skipped !== undefined), "decisions stays free of inline markers");
  store.close();
});

test("issue#89: dreamSkipInvalid:false restores the whole-batch strict rejection", async () => {
  const { store, service } = dreamSetup();
  const a = service.saveWithDedupe({ type: "project", title: "旧A", content: "过时A" }).memory;
  const b = service.saveWithDedupe({ type: "project", title: "旧B", content: "过时B" }).memory;
  const pref = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" }).memory;
  const ctx = {
    logger: { warn: () => {} },
    llm: {
      async *stream(options) {
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        if (userText.startsWith("id=")) {
          yield { type: "text-delta", index: 0, text: JSON.stringify([
            { action: "merge", ids: [pref.id, a.id], keepSource: pref.id, title: "跨类型", content: "不应合并", importance: 4 },
            { action: "archive", ids: [b.id], reason: "stale" }
          ]) };
        } else {
          yield { type: "text-delta", index: 0, text: "记忆库总览。" };
        }
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "mock", dreamModel: "mock-model", dreamSkipInvalid: false });
  assert.equal(result.ok, false, "strict mode rejects the batch");
  assert.equal(result.error, "invalid decisions: 1 errors");
  assert.equal(store.getById(b.id).archived, false, "nothing applied under strict rejection");
  store.close();
});

test("issue#89: minIntervalMs throttles re-triggering regardless of run outcome", async () => {
  const { store, service } = dreamSetup();
  let runs = 0;
  const dream = createDreamScheduler({
    onRun: async () => { runs++; return { ok: false, error: "llm failed" }; },
    thresholdCount: 1, thresholdChars: 0, delayMs: 0, minIntervalMs: 80,
    logger: { warn: () => {} }
  });
  service.saveWithDedupe({ type: "project", title: "a", content: "x" });
  assert.equal(dream.maybeSchedule(service), true, "first trigger scheduled");
  await new Promise((r) => setTimeout(r, 20)); // delayMs 0 → run already dispatched and finished
  assert.equal(runs, 1, "ran once");
  assert.equal(dream.maybeSchedule(service), false, "inside the min interval, even after a failed run");
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(dream.maybeSchedule(service), true, "interval elapsed → eligible again (baseline unmoved by failure)");
  store.close();
});

// --- Issue #126：新动作（supersede / differentiate）在 dream 路径也必须产 receipt ---
// buildRecordReceipts 此前只认 merge/conflict/update，新动作会静默不产 receipt，让
// receipt_chain 留洞。dream 的 consolidation prompt 虽然不含这两个动作，但校验器
// 的 ACTIONS 是共用的——模型自由发挥（或将来把动作集扩到 dream）时审计不能丢。

test("issue#126: a supersede decision on the dream path produces a supersede receipt", async () => {
  const { store, service } = dreamSetup();
  const oldMem = service.saveWithDedupe({ type: "project", title: "方案 v1", content: "用 pm2 常驻" }).memory;
  const newMem = service.saveWithDedupe({ type: "project", title: "方案 v2", content: "改用 systemd" }).memory;
  const ctx = mockCtx({
    onConsolidation: () => JSON.stringify([
      { action: "supersede", winner: newMem.id, loser: oldMem.id, reason: "版本演进" }
    ])
  });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "mock", dreamModel: "mock-model" });
  assert.equal(result.status, "ok", "supersede applied and the summary landed");
  assert.equal(store.getById(oldMem.id).archived, true, "older entry archived");
  assert.equal(store.getById(newMem.id).content, "改用 systemd", "winner body untouched");
  const receipts = store.listReceipts();
  const supersedeReceipt = receipts.find((r) => r.kind === "supersede");
  assert.ok(supersedeReceipt, "supersede receipt lands in receipt_chain");
  assert.equal(supersedeReceipt.record_id, oldMem.id, "receipt records the superseded side");
  assert.equal(supersedeReceipt.winner_id, newMem.id);
  assert.equal(supersedeReceipt.loser_id, oldMem.id);
  store.close();
});

test("issue#126: a differentiate decision on the dream path produces one receipt per entry", async () => {
  const { store, service } = dreamSetup();
  const a = service.saveWithDedupe({ type: "project", title: "内网端口", content: "内网走 22" }).memory;
  const b = service.saveWithDedupe({ type: "project", title: "外网端口", content: "外网映射 2222" }).memory;
  const ctx = mockCtx({
    onConsolidation: () => JSON.stringify([
      { action: "differentiate", ids: [a.id, b.id], distinctions: ["内网直连", "外网映射"] }
    ])
  });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "mock", dreamModel: "mock-model" });
  assert.equal(result.status, "ok", "differentiate applied and the summary landed");
  assert.equal(store.getById(a.id).archived, false, "neither side is archived");
  assert.equal(store.getById(b.id).archived, false);
  const receipts = store.listReceipts().filter((r) => r.kind === "differentiate");
  assert.equal(receipts.length, 2, "one receipt per differentiated entry");
  assert.deepEqual(receipts.map((r) => r.record_id).sort(), [a.id, b.id].sort());
  assert.ok(receipts.every((r) => r.count_before === 1 && r.count_after === 1), "no count change for differentiate");
  store.close();
});

// --- Issue #258: dream_summarize 独立路由 + 输入硬上限 ------------------------

test("issue#258: summarize uses dreamSummaryProvider/dreamSummaryModel when configured, falls back to dream route otherwise", async () => {
  const { store, service } = dreamSetup();
  service.saveWithDedupe({ type: "project", title: "a", content: "x" });
  const seen = [];
  const ctx = mockCtx({});
  const origStream = ctx.llm.stream.bind(ctx.llm);
  ctx.llm.stream = async function* (options) {
    seen.push(`${options.provider}:${options.model}`);
    yield* origStream(options);
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  await dream.runDream(ctx, service, { dreamProvider: "mock", dreamModel: "mock-model", dreamSummaryProvider: "openai", dreamSummaryModel: "big-ctx" });
  assert.ok(seen.includes("mock:mock-model"), "consolidation keeps the dream route");
  assert.ok(seen.includes("openai:big-ctx"), "summary takes the dedicated route");
  const summarize = store.listLlmAudits().find((r) => r.operation_type === "dream_summarize");
  assert.equal(summarize.model_id, "openai:big-ctx", "audit trail names the dedicated route");
  store.close();
});

test("issue#258: dreamSummaryMaxInputs caps summary inputs to the newest N (0 = whole library)", async () => {
  const { store, service } = dreamSetup();
  const titles = ["旧一", "旧二", "旧三", "新四", "新五"];
  const ids = titles.map((t, i) => service.saveWithDedupe({ type: "project", title: t, content: `内容${i}` }).memory.id);
  // 同毫秒保存会让 updated_at 并列、排序退化到 id（UUID 随机）——回填保证严格递增。
  ids.forEach((id, i) => {
    const at = `2026-01-01T0${i + 1}:00:00.000Z`;
    store.db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(at, id);
  });
  const seenUserText = [];
  const ctx = mockCtx({});
  const origStream = ctx.llm.stream.bind(ctx.llm);
  ctx.llm.stream = async function* (options) {
    const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
    if (!userText.startsWith("id=")) seenUserText.push(userText);
    yield* origStream(options);
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  await dream.runDream(ctx, service, { dreamProvider: "mock", dreamModel: "mock-model", dreamSummaryMaxInputs: 3 });
  const summaryText = seenUserText.at(-1);
  assert.ok(summaryText.includes("新四") && summaryText.includes("新五") && summaryText.includes("旧三"), "newest three survive the cap");
  assert.ok(!summaryText.includes("旧一") && !summaryText.includes("旧二"), "oldest two are cut");
  const overview = () => service.all().find((m) => m.type === "summary");
  assert.match(overview().content, /整理后 3 条/, "口径 footer counts the capped snapshot");
  // 未配置 = 0 = 全库，历史行为不变
  await dream.runDream(ctx, service, { dreamProvider: "mock", dreamModel: "mock-model" });
  assert.match(overview().content, /整理后 5 条/, "uncapped run covers the whole library");
  store.close();
});

// --- issue #339 / E8 考卷：merge 护栏（dreamMergeGuard，默认开）----------------
// E8 实测巩固损耗里 10/26 条被丢约束已归位 guarded 类型仍被 merge 吃掉——
// archive 护栏只挡 archive 不挡 merge。默认开（config.js）；被合并对象命中
// ARCHIVE_GUARDED_TYPES 的 merge 决策走与 archive 护栏同款通道：skipInvalid
// 时 skipped、严格时整单拒绝。单元层直接传 options，不经 config。

test("validateDecisions mergeGuard: guarded-type merge is skipped under skipInvalid", () => {
  const snap = new Map([
    ["c1", { id: "c1", type: "constraint", title: "预算", content: "$12,400", importance: 4, archived: false, forgotten: false }],
    ["c2", { id: "c2", type: "constraint", title: "预算(疑似重复)", content: "$12,450", importance: 4, archived: false, forgotten: false }],
    ["h1", { id: "h1", type: "history", title: "旧事", content: "内容", importance: 3, archived: false, forgotten: false }],
    ["h2", { id: "h2", type: "history", title: "旧事(近似)", content: "内容2", importance: 3, archived: false, forgotten: false }]
  ]);
  const decisions = [
    { action: "merge", ids: ["c1", "c2"], keepSource: "c1", title: "预算合并", content: "$12,400 上下", importance: 4 },
    { action: "merge", ids: ["h1", "h2"], keepSource: "h1", title: "旧事合并", content: "合并内容", importance: 3 }
  ];
  const { ok, skipped } = validateDecisions(decisions, snap, { skipInvalid: true, mergeGuard: true });
  assert.equal(ok, true, "history merge survives, guarded merge skipped");
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].error, /dreamMergeGuard/, "skip reason names the guard");
  assert.match(skipped[0].error, /constraint/, "skip reason names the guarded type");
  // guarded merge 被 splice 掉，history merge 与两条隐式 keep 存活。
  assert.deepEqual(decisions.map((d) => d.action), ["merge", "keep", "keep"]);
  assert.ok(decisions.some((d) => d.action === "keep" && d.ids.includes("c1")), "c1 auto-kept");
});

test("validateDecisions mergeGuard: strict mode rejects the whole batch", () => {
  const guardedSnap = new Map([
    ["g1", { id: "g1", type: "pitfall", title: "坑", content: "内容", importance: 3, archived: false, forgotten: false }],
    ["g2", { id: "g2", type: "pitfall", title: "坑2", content: "内容2", importance: 3, archived: false, forgotten: false }]
  ]);
  const strict = validateDecisions(
    [{ action: "merge", ids: ["g1", "g2"], keepSource: "g1", title: "t", content: "c" }],
    guardedSnap,
    { skipInvalid: false, mergeGuard: true }
  );
  assert.equal(strict.ok, false, "strict mode rejects guarded merge");
  assert.ok(strict.errors.some((e) => /dreamMergeGuard/.test(e)));
});

test("validateDecisions mergeGuard: non-guarded types unaffected, guard off = legacy behavior", () => {
  const snap = new Map([
    ["c1", { id: "c1", type: "constraint", title: "预算", content: "$12,400", importance: 4, archived: false, forgotten: false }],
    ["c2", { id: "c2", type: "constraint", title: "预算(疑似重复)", content: "$12,450", importance: 4, archived: false, forgotten: false }]
  ]);
  const decisions = [{ action: "merge", ids: ["c1", "c2"], keepSource: "c1", title: "预算合并", content: "合并", importance: 4 }];
  // guard 选项缺省/false = 旧行为（merge 照常通过）；默认值由 config.js 供给，
  // 本单元层直接传 options，锁的是「不显式开就不拦」这条回退路径。
  assert.equal(validateDecisions(decisions, snap, { skipInvalid: true }).ok, true);
  // guard 开但类型非 guarded（history 用 snapshot 默认 type=project 亦非 guarded）。
  const plainSnap = snapshot(["x", "y"]);
  assert.equal(
    validateDecisions(
      [{ action: "merge", ids: ["x", "y"], keepSource: "x", title: "t", content: "c" }],
      plainSnap,
      { skipInvalid: true, mergeGuard: true }
    ).ok,
    true,
    "non-guarded merge passes under guard"
  );
});

test("validateDecisions archive guard: long-retention type without duplicate/outdated rationale is skipped (prior gap)", () => {
  const snap = new Map([
    ["c", { id: "c", type: "constraint", title: "预算", content: "$12,400", importance: 4, archived: false, forgotten: false }],
    ["p", { id: "p", type: "project", title: "项目", content: "内容", importance: 3, archived: false, forgotten: false }]
  ]);
  const { ok, skipped } = validateDecisions([
    { action: "archive", ids: ["c"], reason: "keeps the store tidy" },
    { action: "archive", ids: ["p"], reason: "outdated" }
  ], snap, { skipInvalid: true });
  assert.equal(ok, true, "project archive with stale rationale survives");
  assert.equal(skipped.length, 1, "constraint archive without rationale skipped");
  assert.match(skipped[0].error, /long-retention type/);
});
