import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { Config } from "../src/config.js";
import { triagePair, recordLedgerTriage, LEDGER_TIERS } from "../src/dream/triage.js";

// Issue #641（beta 第一阶段）：冲突分诊账本。锁三件事，防的回归是：
//   ① 分诊判据漂移：四档的时间/相似度边界被「顺手调一下」而没有任何记录——
//      shadow 期分布与真实库 46/20/5/27 的可比性全靠判据稳定，边界一动，
//      shadow 周就白跑（每条边界用例的注释都写明它锚的真实库依据）；
//   ② 账本不幂等/首见时刻被刷新：同一对每轮重写 first_seen_at，挂账时长与
//      同召率统计全部失真；
//   ③ 记账反噬相位或误入人工队列：shadow 档的写入是纯测量，抛错必须只计
//      failed、绝不打断巩固，也绝不涨 countConflictPending 的面板徽标。

const mem = (id, over = {}) => ({
  id,
  title: `t-${id}`,
  content: `c-${id}`,
  created_at: "2026-11-01T00:00:00.000Z",
  agent_scope: undefined,
  workspace_scope: undefined,
  ...over
});

const HOUR = 3_600_000;
const DAY = 86_400_000;

// ---- triagePair：四档判据与边界 ----

test("issue#641 跨作用域对判 cross-scope-dup（任一维键不同即算，#170 口径）", () => {
  const r1 = triagePair(mem("a", { agent_scope: "x" }), mem("b", { agent_scope: "y" }), 0.9);
  assert.equal(r1.tier, "cross-scope-dup");
  assert.equal(r1.signals.crossScope, true);
  // workspace 单维不同也算——与 sleep.js isCrossScopePair 同一判据
  const r2 = triagePair(mem("a", { workspace_scope: "w1" }), mem("b", { workspace_scope: "w2" }), 0.86);
  assert.equal(r2.tier, "cross-scope-dup");
});

test("issue#641 两侧都未标注不算跨作用域，但 annotated=false 显式落账（#616 的洞在测量层可见）", () => {
  const r = triagePair(mem("a"), mem("b"), 0.91, { now: Date.UTC(2026, 10, 1, 2) });
  assert.equal(r.tier, "dup");
  assert.equal(r.signals.crossScope, false);
  assert.equal(r.signals.annotated, false);
  // 一侧标注一侧未标注：scopeKeyOf(null) !== scopeKeyOf("x") → 跨作用域
  const r2 = triagePair(mem("a", { agent_scope: "x" }), mem("b"), 0.86);
  assert.equal(r2.tier, "cross-scope-dup");
  assert.equal(r2.signals.annotated, false);
});

test("issue#641 同日双录（<24h）+ sim≥dupMin 判 dup；真实库 76% 的对落这一档的依据", () => {
  const a = mem("a", { created_at: "2026-11-01T00:00:00.000Z" });
  const b = mem("b", { created_at: "2026-11-01T02:00:00.000Z" });
  const r = triagePair(a, b, 0.91, { now: Date.UTC(2026, 10, 1) });
  assert.equal(r.tier, "dup");
  assert.equal(r.signals.gapDays, 0.083, "gapDays 落账时四舍五入到 3 位（audit JSON 保持干净）");
});

test("issue#641 dup 边界：sim 恰在 dupMin 判 dup（>=），低一分保守归 conflict", () => {
  const a = mem("a", { created_at: "2026-11-01T00:00:00.000Z" });
  const b = mem("b", { created_at: "2026-11-01T01:00:00.000Z" });
  assert.equal(triagePair(a, b, 0.9, { now: Date.UTC(2026, 10, 1) }).tier, "dup");
  assert.equal(triagePair(a, b, 0.899, { now: Date.UTC(2026, 10, 1) }).tier, "conflict");
});

test("issue#641 时间边界：差恰好 24h 不算 dup（1-7 天的模糊带宁保守归 conflict）；≥7 天判 evolution", () => {
  const a = mem("a", { created_at: "2026-11-01T00:00:00.000Z" });
  const day1 = mem("b", { created_at: "2026-11-02T00:00:00.000Z" });
  assert.equal(triagePair(a, day1, 0.95, { now: Date.UTC(2026, 10, 1) }).tier, "conflict");
  const day30 = mem("b", { created_at: "2026-12-01T00:00:00.000Z" });
  // evolution 的判据只有时间——sim 再高也先走取代链候选（enforce 阶段接线）
  const r = triagePair(a, day30, 0.99, { now: Date.UTC(2026, 10, 1) });
  assert.equal(r.tier, "evolution");
});

test("issue#641 created_at 缺失不下结论：归 conflict、gapDays=null，不编造时间信号", () => {
  const r = triagePair(mem("a", { created_at: undefined }), mem("b"), 0.91);
  assert.equal(r.tier, "conflict");
  assert.equal(r.signals.gapDays, null);
});

test("issue#641 dupMin 可经 opts 覆盖（配置键 conflictLedgerDupMinSimilarity 的直通口）", () => {
  const a = mem("a", { created_at: "2026-11-01T00:00:00.000Z" });
  const b = mem("b", { created_at: "2026-11-01T01:00:00.000Z" });
  assert.equal(triagePair(a, b, 0.87, { now: Date.UTC(2026, 10, 1), dupMinSimilarity: 0.86 }).tier, "dup");
});

// ---- recordLedgerTriage：best-effort 记账 ----

test("issue#641 分诊记账：逐对落账、tally 与档位计数一致", async () => {
  const saved = [];
  const service = { saveConflictLedgerEntry: (r) => saved.push(r) };
  const pairs = [
    { a: mem("a", { created_at: "2026-11-01T00:00:00.000Z" }), b: mem("b", { created_at: "2026-11-01T01:00:00.000Z" }), similarity: 0.91 },
    { a: mem("c", { agent_scope: "x" }), b: mem("d", { agent_scope: "y" }), similarity: 0.86 },
    { a: mem("e", { created_at: "2026-10-01T00:00:00.000Z" }), b: mem("f", { created_at: "2026-11-01T00:00:00.000Z" }), similarity: 0.8 },
    { a: mem("g", { created_at: "2026-11-02T00:00:00.000Z" }), b: mem("h", { created_at: "2026-11-01T00:00:00.000Z" }), similarity: 0.86 }
  ];
  const tally = await recordLedgerTriage(service, "run-1", pairs, { now: Date.UTC(2026, 10, 1) });
  assert.deepEqual(tally, { dup: 1, "cross-scope-dup": 1, evolution: 1, conflict: 1, recorded: 4, failed: 0, truncatedAt: null });
  assert.equal(saved.length, 4);
  assert.equal(saved[0].tier, "dup");
  assert.equal(saved[0].run_id, "run-1");
});

test("issue#641 记账失败只计 failed 不打断：纯测量绝不反噬巩固相位", async () => {
  let calls = 0;
  const service = {
    saveConflictLedgerEntry: () => {
      calls++;
      if (calls === 2) throw new Error("db busy");
    }
  };
  const pairs = [1, 2, 3].map((i) => ({ a: mem(`a${i}`), b: mem(`b${i}`), similarity: 0.91 }));
  const warns = [];
  const tally = await recordLedgerTriage(service, "run-1", pairs, {
    now: Date.UTC(2026, 10, 1),
    logger: { warn: (m) => warns.push(m) }
  });
  assert.equal(tally.recorded, 2);
  assert.equal(tally.failed, 1);
  assert.equal(warns.length, 1, "失败要留下 warn，不是静默吞");
});

test("issue#641 记账分块：大池逐块落账不丢样本（shadow 分母必须完整）", async () => {
  const saved = [];
  const service = { saveConflictLedgerEntry: (r) => saved.push(r) };
  const pairs = Array.from({ length: 120 }, (_, i) => ({
    a: mem(`a${i}`, { created_at: "2026-11-01T00:00:00.000Z" }),
    b: mem(`b${i}`, { created_at: "2026-11-01T01:00:00.000Z" }),
    similarity: 0.91
  }));
  const tally = await recordLedgerTriage(service, "run-1", pairs, { now: Date.UTC(2026, 10, 1) });
  assert.equal(tally.recorded, 120, "跨三块全部落账，无截断");
  assert.equal(tally.dup, 120);
  assert.equal(tally.truncatedAt, null);
  assert.equal(saved.length, 120);
});

test("issue#641 记账分块：取消即停、truncatedAt 可见，绝不静默截断观察样本", async () => {
  const service = { saveConflictLedgerEntry: () => {} };
  const pairs = Array.from({ length: 120 }, (_, i) => ({
    a: mem(`a${i}`, { created_at: "2026-11-01T00:00:00.000Z" }),
    b: mem(`b${i}`, { created_at: "2026-11-01T01:00:00.000Z" }),
    similarity: 0.91
  }));
  // 首块前取消：零写入，truncatedAt=0
  const stopAtStart = await recordLedgerTriage(service, "run-1", pairs, { now: Date.UTC(2026, 10, 1), signal: { aborted: true } });
  assert.equal(stopAtStart.recorded, 0, "取消在首块前生效");
  assert.equal(stopAtStart.truncatedAt, 0);
  // 中途取消：getter 在首块（50 条）落完后翻转 → 第二块前停，块内不弃样本
  const saved = [];
  let flipped = false;
  const midService = {
    saveConflictLedgerEntry: (r) => {
      saved.push(r);
      if (saved.length >= 10) flipped = true;
    }
  };
  const mid = await recordLedgerTriage(midService, "run-2", pairs, {
    now: Date.UTC(2026, 10, 1),
    signal: { get aborted() { return flipped; } }
  });
  assert.equal(mid.recorded, 50, "第一块完整落账（块内不检查取消）");
  assert.equal(mid.truncatedAt, 50, "取消点对可见，余下的对下一轮重见");
});

// ---- conflict_ledger 存储契约 ----

test("issue#641 conflict_ledger：键归一化 + 读回 + 人工队列零污染", () => {
  const store = createStore(":memory:");
  store.saveConflictLedgerEntry({
    run_id: "run-1", memory_a: "b-id", memory_b: "a-id", tier: "dup",
    similarity: 0.91, signals: { crossScope: false, annotated: false, gapDays: 0.5, dupMin: 0.9, similarity: 0.91 }
  });
  const rows = store.listConflictLedger();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].memory_a, "a-id", "键按字典序归一化——反着传也是同一行");
  assert.equal(rows[0].tier, "dup");
  assert.equal(rows[0].status, "open");
  assert.deepEqual(JSON.parse(rows[0].signals), { crossScope: false, annotated: false, gapDays: 0.5, dupMin: 0.9, similarity: 0.91 });
  assert.equal(store.countConflictPending(), 0, "分诊账本是测量记录，绝不涨人工队列徽标");
  assert.equal(store.countConflictLedger(), 1);
  store.close();
});

test("issue#641 conflict_ledger：重复观察是刷新不是新行，first_* 保留首次检出", () => {
  const store = createStore(":memory:");
  store.saveConflictLedgerEntry({ run_id: "run-1", memory_a: "a", memory_b: "b", tier: "conflict", similarity: 0.86 });
  const first = store.listConflictLedger()[0];
  // 同一对后来判成 dup（两侧内容变了 tier 就该变——tier 是观察结论，不是身份）
  store.saveConflictLedgerEntry({ run_id: "run-2", memory_a: "b", memory_b: "a", tier: "dup", similarity: 0.92 });
  const rows = store.listConflictLedger();
  assert.equal(rows.length, 1, "同一对只留一行");
  assert.equal(rows[0].tier, "dup");
  assert.equal(rows[0].first_run_id, "run-1", "首见 run 保留——挂账时长锚在首次检出");
  assert.equal(rows[0].last_run_id, "run-2");
  assert.ok(rows[0].first_seen_at < rows[0].last_seen_at, "单调时钟下两次观察严格递增");
  assert.equal(typeof first.first_seen_at, "string");
  store.close();
});

test("issue#641 conflict_ledger：状态迁移合法值校验 + 未知对返回 false", () => {
  const store = createStore(":memory:");
  store.saveConflictLedgerEntry({ run_id: "run-1", memory_a: "a", memory_b: "b", tier: "conflict" });
  assert.equal(store.setConflictLedgerStatus("b", "a", "zombied"), true, "反着传也能命中（归一化）");
  assert.equal(store.listConflictLedger({ status: "zombied" }).length, 1);
  assert.throws(() => store.setConflictLedgerStatus("a", "b", "not-a-status"), /unknown status/, "非法状态是编程错误，抛错不落库");
  assert.equal(store.setConflictLedgerStatus("x", "y", "open"), false, "未知对返回 false 不抛");
  assert.throws(() => store.saveConflictLedgerEntry({ memory_a: "a", memory_b: "b", tier: "weird" }), /unknown tier/);
  store.close();
});

test("issue#641 conflict_ledger：tier/status 过滤口径（shadow 周分析的查询面）", () => {
  const store = createStore(":memory:");
  store.saveConflictLedgerEntry({ memory_a: "a", memory_b: "b", tier: "dup" });
  store.saveConflictLedgerEntry({ memory_a: "c", memory_b: "d", tier: "conflict" });
  store.saveConflictLedgerEntry({ memory_a: "e", memory_b: "f", tier: "conflict" });
  assert.equal(store.countConflictLedger({ tier: "conflict" }), 2);
  assert.equal(store.countConflictLedger({ tier: "dup" }), 1);
  assert.equal(store.listConflictLedger({ tier: "dup" })[0].memory_a, "a");
  store.close();
});

// ---- 配置面 ----

test("issue#641 conflictLedgerMode 默认 off、枚举拒绝未定义档位（不存在设了没行为的档位）", () => {
  const cfg = Config({});
  assert.equal(cfg.conflictLedgerMode, "off");
  assert.equal(cfg.conflictLedgerDupMinSimilarity, 0.9);
  // enforce 在 beta 第二阶段进枚举（处置接线），但清单之外的值仍然要被拒
  assert.throws(() => Config({ conflictLedgerMode: "yolo" }), /conflictLedgerMode/);
});

test("issue#641 LEDGER_TIERS 与 store 侧白名单一致（两处清单不许漂移）", () => {
  const store = createStore(":memory:");
  for (const tier of LEDGER_TIERS) {
    store.saveConflictLedgerEntry({ memory_a: `a-${tier}`, memory_b: `b-${tier}`, tier });
  }
  assert.equal(store.countConflictLedger(), LEDGER_TIERS.length, "triage.js 的每一档都能落账");
  store.close();
});
