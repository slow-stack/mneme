import test from "node:test";
import assert from "node:assert/strict";
import { Config } from "../src/config.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createDreamScheduler } from "../src/dream.js";

// ---------------------------------------------------------------------------
// conflict freeze (冲突冻结) — 测试用例由 Kimi K2.7 设计，覆盖 config/store/
// service/dream 单测 + runDream 端到端（mock LLM 输出 conflict）。
// 核心约定：freeze 默认关闭（自动裁决行为完全不变）；开启后 conflict 不自动
// 裁决、存入 conflict_pending 待人工确认，outcome 标 conflict-pending。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------- config

test("config: conflictFreezeEnabled 默认关闭", () => {
  const cfg = Config({});
  assert.equal(cfg.conflictFreezeEnabled, false, "freeze 默认不开启");
});

test("config: conflictFreezeEnabled 可显式开启", () => {
  const cfg = Config({ conflictFreezeEnabled: true });
  assert.equal(cfg.conflictFreezeEnabled, true);
});

test("config: conflictFreezeMaxPending 默认为 100 且为整数", () => {
  const cfg = Config({});
  assert.equal(cfg.conflictFreezeMaxPending, 100);
  assert.ok(Number.isInteger(cfg.conflictFreezeMaxPending));
});

test("config: conflictFreezeMaxPending 可显式覆盖", () => {
  const cfg = Config({ conflictFreezeMaxPending: 5 });
  assert.equal(cfg.conflictFreezeMaxPending, 5);
});

test("config: freeze 配置项不影响其它字段", () => {
  const base = Config({});
  const tuned = Config({ conflictFreezeEnabled: true, conflictFreezeMaxPending: 7 });
  assert.equal(tuned.rerankEnabled, base.rerankEnabled, "rerank 不受影响");
  assert.equal(tuned.autoDream, base.autoDream, "autoDream 不受影响");
});

// ---------------------------------------------------------------- store

function openStore() {
  return createStore(":memory:");
}

test("store: saveConflictPending 插入后 listConflictPending 读回", () => {
  const store = openStore();
  const pending = store.saveConflictPending({ run_id: "run-1", memory_a: "a", memory_b: "b", reason: "日期矛盾" });
  assert.ok(pending.id, "有 id");
  assert.equal(pending.run_id, "run-1");
  assert.equal(pending.reason, "日期矛盾");
  assert.ok(pending.created_at, "有 created_at");
  assert.equal(pending.resolved_at, undefined, "未决行没有 resolved_at");

  const list = store.listConflictPending();
  assert.equal(list.length, 1);
  assert.ok([list[0].memory_a, list[0].memory_b].includes("a"), "pair 包含双方");
  assert.ok([list[0].memory_a, list[0].memory_b].includes("b"));
  store.close();
});

test("store: 对序归一化去重 —— 同一对不管顺序只存一次", () => {
  const store = openStore();
  const p1 = store.saveConflictPending({ memory_a: "a", memory_b: "b", reason: "r1" });
  const p2 = store.saveConflictPending({ memory_a: "b", memory_b: "a", reason: "r2" });
  assert.equal(p2.id, p1.id, "反序重报返回同一条 pending");
  assert.equal(p2.reason, "r1", "保留首次 reason");
  assert.equal(store.countConflictPending(), 1, "绝不重复入队");
  store.close();
});

test("store: 不同对不去重", () => {
  const store = openStore();
  store.saveConflictPending({ memory_a: "a", memory_b: "b", reason: "ab" });
  store.saveConflictPending({ memory_a: "a", memory_b: "c", reason: "ac" });
  assert.equal(store.countConflictPending(), 2);
  store.close();
});

// Issue #603 第 2 层：排序键从 created_at 换成相似度。原键在同一次 sleep 轮次里
// 全同（实测 60 条落在 60ms 内），队列在面板上等于随机——而「先看哪对」的唯一
// 客观信号就是相似度。这组用例锁三件事：相似度真的落库、排序真的按它、以及
// NULL（没记过）排在最后而不是被当成 0。
test("#603 store: similarity is persisted and read back", () => {
  const store = openStore();
  const row = store.saveConflictPending({ memory_a: "a", memory_b: "b", reason: "r", similarity: 0.87 });
  assert.equal(row.similarity, 0.87, "fresh row carries the similarity it was parked with");
  const [read] = store.listConflictPending();
  assert.equal(read.similarity, 0.87, "listConflictPending reads the column back");
  store.close();
});

test("#603 store: the queue is ordered by similarity, newest only as a tiebreak", () => {
  const store = openStore();
  // 写入顺序与相似度顺序相反：如果仍按 created_at 排，结果会是 low → high。
  const low = store.saveConflictPending({ memory_a: "a", memory_b: "b", reason: "low", similarity: 0.61 });
  const high = store.saveConflictPending({ memory_a: "c", memory_b: "d", reason: "high", similarity: 0.94 });
  const mid = store.saveConflictPending({ memory_a: "e", memory_b: "f", reason: "mid", similarity: 0.78 });
  const order = store.listConflictPending().map((r) => r.id);
  assert.deepEqual(order, [high.id, mid.id, low.id], "most similar first, regardless of insertion order");
  store.close();
});

test("#603 store: rows without a similarity sort last, they are not 'zero similar'", () => {
  const store = openStore();
  // 存量行（加列之前入队的）与 LLM 裁决路径（只有理由文本）都没有相似度。
  const unknown = store.saveConflictPending({ memory_a: "a", memory_b: "b", reason: "no number" });
  const known = store.saveConflictPending({ memory_a: "c", memory_b: "d", reason: "r", similarity: 0.7 });
  assert.equal(unknown.similarity, undefined, "an unmeasured row must not report a number");
  const order = store.listConflictPending().map((r) => r.id);
  assert.deepEqual(order, [known.id, unknown.id], "unknown similarity goes after every measured row");
  store.close();
});

test("#603 store: an out-of-range or non-numeric similarity is stored as unknown", () => {
  const store = openStore();
  for (const bad of [1.5, -0.2, Number.NaN, "0.9", null]) {
    const row = store.saveConflictPending({ memory_a: `a${String(bad)}`, memory_b: `b${String(bad)}`, reason: "r", similarity: bad });
    assert.equal(row.similarity, undefined, `similarity ${String(bad)} must not be stored as a number`);
  }
  store.close();
});

test("store: resolveConflictPending 标 resolved + winner，默认列表不再返回", () => {
  const store = openStore();
  const pending = store.saveConflictPending({ memory_a: "a", memory_b: "b", reason: "r" });
  const resolved = store.resolveConflictPending(pending.id, { winner: "a" });
  assert.ok(resolved.resolved_at, "resolved_at 已盖章");
  assert.equal(resolved.resolved_winner, "a");
  assert.equal(store.listConflictPending().length, 0, "已解决默认排除");
  const all = store.listConflictPending({ includeResolved: true });
  assert.equal(all.length, 1, "includeResolved 可见");
  assert.equal(all[0].resolved_winner, "a");
  store.close();
});

test("store: resolveConflictPending 未知 id 返回 undefined", () => {
  const store = openStore();
  assert.equal(store.resolveConflictPending("ghost"), undefined);
  store.close();
});

test("store: countConflictPending 只统计未决行", () => {
  const store = openStore();
  store.saveConflictPending({ memory_a: "a", memory_b: "b", reason: "ab" });
  const p2 = store.saveConflictPending({ memory_a: "b", memory_b: "c", reason: "bc" });
  assert.equal(store.countConflictPending(), 2);
  store.resolveConflictPending(p2.id, { winner: "b" });
  assert.equal(store.countConflictPending(), 1, "已解决不再计入");
  store.close();
});

test("store: 已解决的同一对在内容变化后才可再次 pending（issue #170 复核项 4）", async () => {
  const store = openStore();
  const a = store.save({ type: "project", title: "对A", content: "内容A" });
  const b = store.save({ type: "project", title: "对B", content: "内容B" });
  const p1 = store.saveConflictPending({ memory_a: a.id, memory_b: b.id, reason: "r" });
  store.resolveConflictPending(p1.id, { winner: "a" });
  // 内容未变 → 已裁决对不重新入队：「保留双方」是有效决定，不是待办。
  const suppressed = store.saveConflictPending({ memory_a: b.id, memory_b: a.id, reason: "again" });
  assert.equal(suppressed, undefined, "未变化的已裁决对被抑制");
  assert.equal(store.countConflictPending(), 0);
  // 任一侧被改过（updated_at 晚于 resolved_at）→ 重新入队产生新 pending。
  // 留真实时间间隔：updated_at/resolved_at 毫秒精度，同毫秒算未变。
  await new Promise((resolve) => setTimeout(resolve, 5));
  store.update(a.id, { content: "内容A（改）" });
  const p2 = store.saveConflictPending({ memory_a: b.id, memory_b: a.id, reason: "changed" });
  assert.ok(p2, "内容变化后的对重新入队");
  assert.notEqual(p2.id, p1.id, "新 pending 是新行");
  assert.equal(p2.resolved_at, undefined);
  assert.equal(store.countConflictPending(), 1);
  store.close();
});

// ---------------------------------------------------------------- service passthrough

function openService() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  return { store, service };
}

test("service: 4 个 conflict freeze passthrough 委托到 store", () => {
  const { store, service } = openService();
  const saved = service.saveConflictPending({ run_id: "run-1", memory_a: "a", memory_b: "b", reason: "r" });
  assert.equal(store.countConflictPending(), 1, "save 落到 store");
  assert.equal(service.countConflictPending(), 1, "count 读回一致");
  assert.equal(service.listConflictPending().length, 1, "list 读回一致");
  const resolved = service.resolveConflictPending(saved.id, { winner: "a" });
  assert.ok(resolved.resolved_at, "resolve 落到 store");
  assert.equal(service.listConflictPending().length, 0, "已解决从默认列表消失");
  store.close();
});

test("service: passthrough 透传 store 异常", () => {
  const { store, service } = openService();
  const original = store.countConflictPending;
  store.countConflictPending = () => { throw new Error("db boom"); };
  assert.throws(() => service.countConflictPending(), /db boom/);
  store.countConflictPending = original;
  store.close();
});

// ---------------------------------------------------------------- dream: runDream 端到端

function dreamSetup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  return { store, service };
}

// mock LLM：第一次调用返回 consolidation decisions，第二次返回 summary。
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

const BASE_CONFIG = { dreamProvider: "deepseek", dreamModel: "deepseek-chat" };

test("dream: freeze=false（默认）conflict 仍自动裁决（回归）", async () => {
  const { store, service } = dreamSetup();
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  const ctx = freezeCtx({ conflicts: [{ action: "conflict", winner: w.id, loser: l.id, reason: "日期更新" }] });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, BASE_CONFIG);
  assert.equal(result.ok, true);
  assert.equal(result.applied, 1, "conflict 被自动裁决");
  assert.equal(result.frozen, 0, "无冻结");
  assert.equal(store.getById(l.id).archived, true, "loser 被归档");
  assert.ok(store.getById(w.id).content.includes("已否决旧信息"), "winner 附带来源批注");
  assert.equal(store.listConflictPending().length, 0, "freeze 关闭不产生 pending");
  store.close();
});

test("dream: freeze=true conflict 不自动裁决、存入 pending、outcome 标 conflict-pending", async () => {
  const { store, service } = dreamSetup();
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  const ctx = freezeCtx({ conflicts: [{ action: "conflict", winner: w.id, loser: l.id, reason: "日期更新，候选取新" }] });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { ...BASE_CONFIG, conflictFreezeEnabled: true });
  assert.equal(result.ok, true);
  assert.equal(result.applied, 0, "conflict 未被应用");
  assert.equal(result.frozen, 1, "1 个 conflict 被冻结");
  const pending = store.listConflictPending();
  assert.equal(pending.length, 1, "pending 记录写入");
  assert.equal(pending[0].reason, "日期更新，候选取新");
  assert.equal(store.getById(l.id).archived, false, "loser 未归档");
  assert.equal(store.getById(w.id).archived, false, "winner 未归档");
  assert.ok(!store.getById(w.id).content.includes("已否决旧信息"), "无来源批注");
  const run = store.listDreamRuns()[0];
  assert.equal(run.outcome.byId[w.id], "conflict-pending", "audit outcome 标记双方 pending");
  assert.equal(run.outcome.byId[l.id], "conflict-pending");
  assert.equal(store.listReceipts().length, 0, "冻结 conflict 不写 per-record 收据");
  store.close();
});

test("dream: freeze=true 非 conflict 决策照常执行，仅 conflict 冻结", async () => {
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
  const result = await dream.runDream(ctx, service, { ...BASE_CONFIG, conflictFreezeEnabled: true });
  assert.equal(result.applied, 1, "merge 正常应用");
  assert.equal(result.frozen, 1, "conflict 被冻结");
  assert.equal(store.getById(b.id).title, "插件总览", "merge keeper 已更新");
  assert.equal(store.getById(a.id).archived, true, "merge 源已归档");
  assert.equal(store.getById(l.id).archived, false, "conflict loser 未被本次运行触碰");
  assert.equal(store.listConflictPending().length, 1);
  store.close();
});

test("dream: freeze=true 超过 conflictFreezeMaxPending 上限跳过（不抛错）", async () => {
  const { store, service } = dreamSetup();
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  const ctx = freezeCtx({ conflicts: [{ action: "conflict", winner: w.id, loser: l.id, reason: "x" }] });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, {
    ...BASE_CONFIG, conflictFreezeEnabled: true, conflictFreezeMaxPending: 0
  });
  assert.equal(result.frozen, 0, "容量 0 时无冻结");
  assert.equal(store.listConflictPending().length, 0, "无 pending 写入");
  assert.ok(ctx.warnings.some((m) => m.includes("freeze queue full")), "超限警告已记录");
  store.close();
});

test("dream: freeze=true 存 pending 失败 fail-safe 不阻断 run", async () => {
  const { store, service } = dreamSetup();
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  service.saveConflictPending = () => { throw new Error("pending store boom"); };
  service.countConflictPending = () => { throw new Error("count boom"); };
  const ctx = freezeCtx({ conflicts: [{ action: "conflict", winner: w.id, loser: l.id, reason: "x" }] });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { ...BASE_CONFIG, conflictFreezeEnabled: true });
  assert.equal(result.ok, true, "尽管 pending 存储失败，run 正常完成");
  assert.equal(result.frozen, 0, "无冻结");
  assert.ok(ctx.warnings.length >= 1, "freeze 失败已记录");
  assert.equal(store.getById(l.id).archived, false, "记忆无副作用");
  assert.equal(store.getById(w.id).content, "8月20日", "winner 未被改动");
  store.close();
});

test("dream: freeze=true 同一对跨 run 去重 —— 只保留一条 pending", async () => {
  const { store, service } = dreamSetup();
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止", content: "8月20日", importance: 4 });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const ctx = freezeCtx({ conflicts: [{ action: "conflict", winner: w.id, loser: l.id, reason: "日期矛盾" }] });
  const r1 = await dream.runDream(ctx, service, { ...BASE_CONFIG, conflictFreezeEnabled: true });
  // mock LLM 计数器按 run 重置：每次 runDream 用独立的 ctx
  const ctx2 = freezeCtx({ conflicts: [{ action: "conflict", winner: w.id, loser: l.id, reason: "日期矛盾" }] });
  const r2 = await dream.runDream(ctx2, service, { ...BASE_CONFIG, conflictFreezeEnabled: true });
  assert.equal(r1.frozen, 1);
  assert.equal(r2.frozen, 0, "第二次检出的是已在队列里的对，不算新停车（#603 第 1 层）");
  assert.equal(store.countConflictPending(), 1, "但队列只有一条 pending");
  store.close();
});
