import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { testConfig } from "./helpers/test-config.js";

// #217 增量（2026-09-19 拍板）：注入是曝光型访问事件，注入终选集落
// mode='inject' 审计行（跟随 recallRecordDefault；空选不记）。留痕与消费
// 解耦：heatEnabled=false 时行照写，touch（heat 消费侧）不发生。

function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig(config) });
  // 与 index.js 相同的接线：审计记账 → recall_runs（best effort）
  service.setRecallRecorder((recall) => {
    store.saveRecallRun({
      query: recall.query,
      mode: recall.mode,
      topK: recall.topK,
      threshold: recall.threshold ?? null,
      candidates: recall.candidates ?? [],
      created_at: recall.createdAt
    });
  });
  return { store, service };
}

const injectRow = (store) =>
  store.listRecallRunsSince(new Date(Date.now() - 86400000).toISOString())
    .rows.find((r) => r.mode === "inject");

test("注入落账：终选集写一行 mode='inject'，candidates 为实际注入条目", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ type: "decision", title: "甲", content: "内容甲", importance: 4 });
  service.saveWithDedupe({ type: "decision", title: "乙", content: "内容乙", importance: 3 });
  const selected = service.injectCandidates({ maxItems: 5 });
  assert.ok(selected.length >= 2);
  const row = injectRow(store);
  assert.ok(row, "注入应落一行审计");
  assert.equal(row.mode, "inject");
  // recall_runs.query 是 NOT NULL（store.js 的 recall_runs 建表语句，2026-10-14 在 :75）：
  // 调用方没给查询词时用空串而非 null
  assert.equal(row.query, "");
  assert.deepEqual(row.candidates.map((c) => c.id), selected.map((m) => m.id));
  store.close();
});

// v0.9.0：注入行此前恒写空串（2026-10-13 快照 18,231/18,231 全空，即 100%），把「当时想干什么」
// 从审计里抹掉了 —— 而 inject.js 本来就带着 lastUserQuery 传进来。这两条锁住
// 「传了要记下来」与「没传仍是空串」，同时确认下游 recallStats 按 mode 分账不受影响。
test("注入落账：调用方给了查询词就记真值（不再恒空串）", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ type: "decision", title: "甲", content: "内容甲", importance: 4 });
  const selected = service.injectCandidates({ query: "夜航App 令牌桶怎么设计的", maxItems: 5 });
  assert.ok(selected.length >= 1);
  const row = injectRow(store);
  assert.ok(row, "注入应落一行审计");
  assert.equal(row.query, "夜航App 令牌桶怎么设计的");
  // 下游安全：口径按 mode 分账，不看 query
  const stats = service.recallStats({ windowDays: 30, exemptDays: 0 });
  assert.equal(stats.injection.runs, 1);
  store.close();
});

test("注入落账：查询词两侧空白按 trim 后入账", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ type: "decision", title: "甲", content: "内容甲", importance: 4 });
  service.injectCandidates({ query: "  终端  ", maxItems: 5 });
  assert.equal(injectRow(store).query, "终端");
  store.close();
});

test("recallRecordDefault=false 不落账（与检索侧同门）", () => {
  const { store, service } = setup({ recallRecordDefault: false });
  service.saveWithDedupe({ type: "decision", title: "甲", content: "内容甲", importance: 4 });
  service.injectCandidates({ maxItems: 5 });
  assert.equal(injectRow(store), undefined);
  store.close();
});

test("空选不落账（没有访问发生）", () => {
  const { store, service } = setup();
  service.injectCandidates({ maxItems: 5 });
  assert.equal(injectRow(store), undefined);
  store.close();
});

test("留痕与消费解耦：heat 关闭时行照写、touch 不发生", () => {
  // 显式 false = 生产 config 经 resolveConfig 后的默认值；touchRecalled 的
  // 门控是 === false 才跳过（service.js:515）
  const { store, service } = setup({ heatEnabled: false });
  const m = service.saveWithDedupe({ type: "decision", title: "甲", content: "内容甲", importance: 4 }).memory;
  const before = store.getById(m.id).last_accessed_at ?? null;
  service.injectCandidates({ maxItems: 5 });
  assert.ok(injectRow(store), "heat 关闭时注入行仍照写");
  assert.equal(store.getById(m.id).last_accessed_at ?? null, before, "touch 属 heat 消费侧，不发生");
  store.close();
});

test("聚合：注入候选计入零曝光判定，注入口径单独报数", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ type: "decision", title: "被注入", content: "被注入候选的内容说明", importance: 4 });
  // importance 2 低于注入阈值 3：活跃但不进注入候选 → 零曝光 → 僵尸
  service.saveWithDedupe({ type: "decision", title: "没动静", content: "低重要度不进注入候选的内容", importance: 2 });
  // 回拨 created_at 避开 nowIso 同毫秒单调顶推的 1ms 豁免边界：刚写入的记忆
  // 可能比 recallStats 的 Date.now() 晚 1ms，exemptDays:0 时会落进豁免桶
  // （宁漏勿误伤），断言就变成看运气。回拨到 10 天前，判定确定性成立。
  const old = new Date(Date.now() - 10 * 86400000).toISOString();
  for (const m of store.all()) {
    store.db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(old, m.id);
  }
  service.injectCandidates({ maxItems: 5 });
  const stats = service.recallStats({ windowDays: 30, exemptDays: 0 });
  assert.equal(stats.injection.runs, 1);
  assert.ok(stats.injection.injectedCount >= 1);
  assert.equal(stats.zombie.activeCount, 2);
  assert.equal(stats.zombie.zombieCount, 1, "被注入的不算僵尸（注入=曝光），未进候选的计僵尸");
  store.close();
});

test("slotFillRate = 注入条数 / (轮数 × 槽位数)", () => {
  const { store, service } = setup();
  for (let i = 0; i < 3; i++) {
    service.saveWithDedupe({ type: "decision", title: `t${i}`, content: "x", importance: 4 });
  }
  service.injectCandidates({ maxItems: 5 });
  const stats = service.recallStats({ windowDays: 30, exemptDays: 0, maxInjectSlots: 4 });
  assert.equal(stats.injection.runs, 1);
  assert.equal(stats.injection.injectedCount, 3);
  assert.equal(stats.injection.slotFillRate, 3 / 4);
  store.close();
});

// #369：history 曾被注入白名单挡在门外（蒸馏产得出、注入收不进）。这两条断言分
// 别锁「收编生效」与「重要度闸门对 history 不豁免」——后者一旦失效，短流水账会
// 直接挤掉决策类条目，那才是这个改动真正的风险面。
test("#369: history 进注入候选池", () => {
  const { service } = setup();
  service.saveWithDedupe({ type: "history", title: "切到暗色主题", content: "用户本次会话把界面切成暗色主题", importance: 4 });
  const titles = service.injectCandidates({ maxItems: 5 }).map((m) => m.title);
  assert.ok(titles.includes("切到暗色主题"), "importance>=3 的 history 应进注入候选");
});

test("#369: 低于重要度闸门的 history 不得例外放行", () => {
  const { service } = setup();
  service.saveWithDedupe({ type: "history", title: "打开过一次终端", content: "用户中途打开过一次终端", importance: 2 });
  const titles = service.injectCandidates({ maxItems: 5 }).map((m) => m.title);
  assert.ok(!titles.includes("打开过一次终端"), "history 不是 summary/preference，闸门照样生效");
});

// pattern 早已被 dreamMergeGuard 列为长保留受保护类型，却一度被当成「只由手工写入」
// （那个判据是错的，实际是 sleep 的 phasePatterns 在 mint——见 src/service.js 的
// INJECT_TYPES 注释）。巩固层当资产护住、注入面一次不给看是同一条口径的两头
// 不一致，与作者是谁无关。这条锁它进池。
test("#369: pattern 进注入候选池（与作者是谁无关）", () => {
  const { service } = setup();
  service.saveWithDedupe({ type: "pattern", title: "重复字符串先抽共用模块", content: "多处重复的截断逻辑先收拢成共用模块，再改调用方", importance: 5 });
  const titles = service.injectCandidates({ maxItems: 5 }).map((m) => m.title);
  assert.ok(titles.includes("重复字符串先抽共用模块"), "importance>=3 的 pattern 应进注入候选");
});

// CodeRabbit on PR #404：语义缓存回填分支曾独漏重要度门槛（向量路与 BM25 路都带）。
// 一正一反：反向锁「低于闸门的行走缓存也不许进池」，正向锁「达标的照常进池」，
// 免得断言退化成常量真；缓存没被灌进来时正向那条会先红，用例不会空压。
test("#369: 语义缓存回填同样受重要度闸门约束", async () => {
  const { service } = setup();
  const low = service.saveWithDedupe({ type: "history", title: "终端开了一次", content: "用户中途打开过一次终端做检查", importance: 2 });
  const high = service.saveWithDedupe({ type: "history", title: "终端方案定案", content: "用户终端接入方案已定案并验证", importance: 4 });
  await service.searchMemories("终端", { mode: "keyword", useRerank: false, recordRecall: false });
  const ids = service.injectCandidates({ query: "终端", maxItems: 5 }).map((m) => m.id);
  assert.ok(ids.includes(high.memory.id), "i4 的 history 应经缓存回填进池（正向对照）");
  assert.equal(ids.includes(low.memory.id), false, "低于闸门的行不得借语义缓存绕开门槛");
});
