import test from "node:test";
import assert from "node:assert/strict";
import { runSleep } from "../src/dream/sleep.js";
import { createDreamScheduler } from "../src/dream.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";
import { testConfig } from "./helpers/test-config.js";

// v0.8.1（issue #170 第 2 步）：sleep 冲突阶段的跨 scope 分流。
// 同一内容落在两个归属下（任一维标注键不等，含「一侧未标注=全局」）时，
// 不允许自动裁决（freeze 或 LLM）——归档败者可能销毁某归属下的唯一副本，
// 归属裁决是用户的决定。跨 scope 对一律停车到 conflict_pending（专属 reason），
// 同 scope 对维持既有路径。夹具为中性主题（构建笔记/编辑器主题）。

const embedder = {
  embedSingle: async () => [1, 0, 0],
  // 契约形状：按输入条数返回等长向量数组。update 会失效缓存并调度重嵌入，
  // sleep 的回填走 embed()——返回单向量会让回填静默失败（no usable vectors）。
  embed: async (texts) => (Array.isArray(texts) ? texts : [texts]).map(() => [1, 0, 0]),
  schedule: () => {},
  modelHash: "mock#1",
  dimension: 3
};

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const vectorIndex = createVectorIndex({ store });
  service.setEmbedder(embedder);
  service.setVectorIndex(vectorIndex);
  return { store, service, vectorIndex };
}

function baseConfig(overrides = {}) {
  return {
    sleepModeEnabled: true,
    sleepIdleMinutes: 5,
    sleepMinIntervalHours: 8,
    sleepConflictStrictness: "normal",
    sleepArchiveDays: 30,
    sleepCompressDays: 90,
    sleepPatternMinMemories: 10,
    sleepMaxPatternPerRun: 3,
    ...overrides
  };
}

function llmCtx(captured = [], selection = { provider: "mock", model: "sleep-model" }) {
  return {
    logger: { warn: () => {}, info: () => {} },
    agentDefaultModel: { currentSelection: () => selection },
    llm: {
      async *stream(options) {
        captured.push(options);
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        yield { type: "text-delta", index: 0, text: options.purpose === "sleep-conflict" ? "[]" : "[]" };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
}

function noRouteCtx() {
  return { logger: { warn: () => {}, info: () => {} } };
}

/** 保存一对高相似记忆并预填向量。返回 [新, 旧]（updated_at DESC 序）。 */
function savePair(service, vectorIndex, titleA, titleB, scopeA, scopeB) {
  const a = service.saveWithDedupe({
    type: "project", title: titleA, content: `${titleA} 的正文`,
    ...(scopeA?.agent ? { agent_scope: scopeA.agent } : {}),
    ...(scopeA?.workspace ? { workspace_scope: scopeA.workspace } : {})
  }).memory;
  const b = service.saveWithDedupe({
    type: "project", title: titleB, content: `${titleB} 的正文`,
    ...(scopeB?.agent ? { agent_scope: scopeB.agent } : {}),
    ...(scopeB?.workspace ? { workspace_scope: scopeB.workspace } : {})
  }).memory;
  vectorIndex.saveEmbedding(a.id, [1, 0, 0]);
  vectorIndex.saveEmbedding(b.id, [1, 0, 0]);
  return [a, b];
}

test("freeze mode: cross-scope pair parks with the scope-candidate reason; same-scope pair keeps the plain reason", async () => {
  const { store, service, vectorIndex } = setup();
  // updated_at DESC 序决定贪心配对：后保存的对先配。x 对=跨 scope，y 对=同 scope。
  const [yNew, yOld] = savePair(service, vectorIndex, "构建笔记A", "构建笔记B", { agent: "coder" }, { agent: "coder" });
  const [xNew, xOld] = savePair(service, vectorIndex, "编辑器主题A", "编辑器主题B", { agent: "coder" }, { agent: "writer" });

  const result = await runSleep(llmCtx(), service, baseConfig({ conflictFreezeEnabled: true }), { warn: () => {}, info: () => {} }, { embedder, vectorIndex }, null);
  assert.equal(result.status, "ok");

  const queue = store.listConflictPending();
  assert.equal(queue.length, 2, "both pairs parked exactly once");
  const crossRow = queue.find((q) => [q.memory_a, q.memory_b].includes(xNew.id));
  const sameRow = queue.find((q) => [q.memory_a, q.memory_b].includes(yNew.id));
  assert.ok(crossRow, "cross-scope pair must be parked");
  assert.match(crossRow.reason, /跨作用域|cross-scope/, "cross pair carries the dedicated reason");
  assert.ok(sameRow, "same-scope pair still parked in freeze mode");
  assert.doesNotMatch(sameRow.reason, /跨作用域|cross-scope/, "same-scope pair keeps the plain similarity reason");

  // 再跑一轮：同一对不去重不重复入队。
  await runSleep(llmCtx(), service, baseConfig({ conflictFreezeEnabled: true }), { warn: () => {}, info: () => {} }, { embedder, vectorIndex }, null);
  assert.equal(store.countConflictPending(), 2, "pair-level dedupe survives reruns");
  store.close();
});

test("NULL (unlabeled) vs labeled counts as a cross-scope pair", async () => {
  const { store, service, vectorIndex } = setup();
  savePair(service, vectorIndex, "部署清单A", "部署清单B", {}, { agent: "coder" });
  const result = await runSleep(llmCtx(), service, baseConfig({ conflictFreezeEnabled: true }), { warn: () => {}, info: () => {} }, { embedder, vectorIndex }, null);
  assert.equal(result.status, "ok");
  const queue = store.listConflictPending();
  assert.equal(queue.length, 1);
  assert.match(queue[0].reason, /跨作用域|cross-scope/, "global(unlabeled) copy vs scoped copy is an ownership decision");
  store.close();
});

test("non-freeze without an LLM route: cross-scope pair still parks; nothing is auto-adjudicated", async () => {
  const { store, service, vectorIndex } = setup();
  const [newer, older] = savePair(service, vectorIndex, "发布流程A", "发布流程B", { agent: "coder" }, { agent: "writer" });
  const result = await runSleep(noRouteCtx(), service, baseConfig(), { warn: () => {}, info: () => {} }, { embedder, vectorIndex }, null);

  const queue = store.listConflictPending();
  assert.equal(queue.length, 1, "cross-scope pair parks even with no LLM route");
  assert.match(queue[0].reason, /跨作用域|cross-scope/);
  assert.equal(store.getById(newer.id).archived, false, "no side is auto-archived");
  assert.equal(store.getById(older.id).archived, false);
  assert.ok(queue[0].resolved_at === undefined);
  store.close();
});

test("reviewed pair does not re-queue until one of its sides changes (review item 4)", async () => {
  const { store, service, vectorIndex } = setup();
  const [newer, older] = savePair(service, vectorIndex, "备份策略A", "备份策略B", { agent: "coder" }, { agent: "writer" });
  await runSleep(llmCtx(), service, baseConfig({ conflictFreezeEnabled: true }), { warn: () => {}, info: () => {} }, { embedder, vectorIndex }, null);
  assert.equal(store.countConflictPending(), 1);

  // 人工「保留双方」（winner=null）后，内容未变 → 下一轮不再入队。
  const row = store.listConflictPending()[0];
  store.resolveConflictPending(row.id, { winner: null });
  assert.equal(store.countConflictPending(), 0);
  const rerun = await runSleep(llmCtx(), service, baseConfig({ conflictFreezeEnabled: true }), { warn: () => {}, info: () => {} }, { embedder, vectorIndex }, null);
  assert.equal(store.countConflictPending(), 0, "unchanged reviewed pair must stay dismissed");
  assert.equal(rerun.status, "noop", "suppressed parks count as noop");

  // 任一侧被改过（updated_at 晚于裁决）→ 重新入队（新决策）。
  // 留出真实时间间隔：updated_at/resolved_at 都是毫秒精度，同毫秒内
  // 「裁决后立即修改」会算作未变（生产中人为修改不可能同毫秒）。
  await new Promise((resolve) => setTimeout(resolve, 5));
  service.update(newer.id, { content: "备份策略A 的正文（改）" });
  await runSleep(llmCtx(), service, baseConfig({ conflictFreezeEnabled: true }), { warn: () => {}, info: () => {} }, { embedder, vectorIndex }, null);
  assert.equal(store.countConflictPending(), 1, "changed pair is worth a fresh review");
  store.close();
});

test("dream (non-freeze): cross-scope conflict parks for review instead of being adjudicated (review item 3)", async () => {
  const { store, service } = setup();
  const w = service.saveWithDedupe({ type: "decision", title: "发布时间", content: "8月20日", importance: 4, agent_scope: "coder", agent_scope_source: "explicit" }).memory;
  const l = service.saveWithDedupe({ type: "decision", title: "发布时间旧", content: "8月15日", importance: 4, agent_scope: "writer", agent_scope_source: "explicit" }).memory;
  const ctx = {
    llm: { stream: async function* () {
      yield { type: "text-delta", text: JSON.stringify([{ action: "conflict", winner: w.id, loser: l.id, reason: "日期更新" }]) };
      yield { type: "finish", reason: { kind: "ok" } };
    } },
    logger: { warn: () => {}, info: () => {} }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "mock", dreamModel: "mock-chat" });
  assert.equal(result.ok, true);
  assert.equal(result.applied, 0, "cross-scope conflict is NOT auto-adjudicated");
  assert.equal(result.frozen, 1, "parked pair shows up in the run summary");
  const pending = store.listConflictPending();
  assert.equal(pending.length, 1);
  assert.match(pending[0].reason, /跨作用域|cross-scope/, "dedicated reason");
  assert.equal(store.getById(l.id).archived, false, "loser NOT archived");
  assert.ok(!store.getById(w.id).content.includes("已否决旧信息"), "winner untouched");
  store.close();
});

test("dream (non-freeze): same-scope conflict is still auto-adjudicated (regression)", async () => {
  const { store, service } = setup();
  const w = service.saveWithDedupe({ type: "decision", title: "发布时间", content: "8月20日", importance: 4, agent_scope: "coder", agent_scope_source: "explicit" }).memory;
  const l = service.saveWithDedupe({ type: "decision", title: "发布时间旧", content: "8月15日", importance: 4, agent_scope: "coder", agent_scope_source: "explicit" }).memory;
  const ctx = {
    llm: { stream: async function* () {
      yield { type: "text-delta", text: JSON.stringify([{ action: "conflict", winner: w.id, loser: l.id, reason: "日期更新" }]) };
      yield { type: "finish", reason: { kind: "ok" } };
    } },
    logger: { warn: () => {}, info: () => {} }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "mock", dreamModel: "mock-chat" });
  assert.equal(result.ok, true);
  assert.equal(result.applied, 1, "same-scope conflict adjudicated as before");
  assert.equal(result.frozen, 0);
  assert.equal(store.listConflictPending().length, 0);
  assert.equal(store.getById(l.id).archived, true);
  store.close();
});

// Issue #603 第 1 层：freeze 分支此前绕过全部三个上限，且把「已在队列里的对」
// 当成新停车报进 frozen。下面三条锁住修完之后的三个性质。
test("#603 freeze: a pair already in the queue is not re-reported as a new freeze", async () => {
  const { store, service, vectorIndex } = setup();
  savePair(service, vectorIndex, "索引策略A", "索引策略B", { agent: "coder" }, { agent: "coder" });
  const logger = { warn: () => {}, info: () => {} };

  const first = await runSleep(llmCtx(), service, baseConfig({ conflictFreezeEnabled: true }), logger, { embedder, vectorIndex }, null);
  assert.equal(first.phases.conflicts.frozen, 1, "第一次是真插入");
  assert.equal(store.countConflictPending(), 1);

  const second = await runSleep(llmCtx(), service, baseConfig({ conflictFreezeEnabled: true }), logger, { embedder, vectorIndex }, null);
  assert.equal(second.phases.conflicts.frozen, 0, "第二次检出的是已入队的对，不算新停车");
  assert.equal(second.status, "noop", "没有新停车就是 noop，不是 ok");
  assert.equal(store.countConflictPending(), 1, "队列没有被重复写入");
  store.close();
});

test("#603 freeze: cap is applied after filtering already-parked pairs, so the queue keeps growing", async () => {
  const { store, service, vectorIndex } = setup();
  // 三对互不相交的高相似记忆：贪心配对每轮都能检出三对。
  savePair(service, vectorIndex, "队列A1", "队列A2", { agent: "coder" }, { agent: "coder" });
  savePair(service, vectorIndex, "队列B1", "队列B2", { agent: "coder" }, { agent: "coder" });
  savePair(service, vectorIndex, "队列C1", "队列C2", { agent: "coder" }, { agent: "coder" });
  const logger = { warn: () => {}, info: () => {} };
  // 每轮只处理一对，且远小于候选数——裸 slice 会让第一对永远占住这个名额。
  const cfg = baseConfig({ conflictFreezeEnabled: true, sleepConflictMaxPairsPerRun: 1 });

  await runSleep(llmCtx(), service, cfg, logger, { embedder, vectorIndex }, null);
  assert.equal(store.countConflictPending(), 1);
  await runSleep(llmCtx(), service, cfg, logger, { embedder, vectorIndex }, null);
  assert.equal(store.countConflictPending(), 2, "第二对必须能轮到，不能被第一对饿死");
  await runSleep(llmCtx(), service, cfg, logger, { embedder, vectorIndex }, null);
  assert.equal(store.countConflictPending(), 3, "第三对同理");

  const done = await runSleep(llmCtx(), service, cfg, logger, { embedder, vectorIndex }, null);
  assert.equal(done.phases.conflicts.frozen, 0, "全部入队后不再虚报");
  assert.equal(done.phases.conflicts.perRunSkipped, 0, "没有新对可处理，不算被截断");
  store.close();
});

test("#603 freeze: the pending queue budget stops parking and says so", async () => {
  const { store, service, vectorIndex } = setup();
  savePair(service, vectorIndex, "预算A1", "预算A2", { agent: "coder" }, { agent: "coder" });
  savePair(service, vectorIndex, "预算B1", "预算B2", { agent: "coder" }, { agent: "coder" });
  savePair(service, vectorIndex, "预算C1", "预算C2", { agent: "coder" }, { agent: "coder" });
  const warnings = [];
  const logger = { warn: (m) => warnings.push(String(m)), info: () => {} };

  const result = await runSleep(
    llmCtx(), service,
    baseConfig({ conflictFreezeEnabled: true, conflictFreezeMaxPending: 2 }),
    logger, { embedder, vectorIndex }, null
  );
  assert.equal(store.countConflictPending(), 2, "只装到队列上限为止");
  assert.equal(result.phases.conflicts.frozen, 2);
  assert.equal(result.phases.conflicts.pendingSkipped, 1, "被队列上限挡下的对要如实报出来");
  assert.ok(warnings.some((w) => /freeze queue full/.test(w)), "要留一条 warn，不能静默丢弃");

  // 队列已满：再跑一轮不会新增，也不会把「满了」报成可续排的 backlog。
  const again = await runSleep(
    llmCtx(), service,
    baseConfig({ conflictFreezeEnabled: true, conflictFreezeMaxPending: 2 }),
    logger, { embedder, vectorIndex }, null
  );
  assert.equal(store.countConflictPending(), 2);
  assert.equal(again.phases.conflicts.frozen, 0);
  assert.equal(again.phases.conflicts.perRunSkipped, 0, "队列满不是 per-run 截断，不该触发续排");
  store.close();
});

// Issue #603 第 2 层：sleep 停车时必须把候选对的相似度一起落库。此前这个数字只
// 活在 reason 文本里（「相似度 0.87」），面板靠正则回收、排序无从下手——同一轮
// 产出的对 created_at 全同，队列顺序等于随机。
test("#603 freeze: the parked row carries the similarity the detector measured", async () => {
  const { store, service, vectorIndex } = setup();
  savePair(service, vectorIndex, "排序A1", "排序A2", { agent: "coder" }, { agent: "coder" });

  await runSleep(llmCtx(), service, baseConfig({ conflictFreezeEnabled: true }), { warn: () => {}, info: () => {} }, { embedder, vectorIndex }, null);

  const [row] = store.listConflictPending();
  assert.ok(row, "the pair must be parked");
  // 两条记忆的向量都是 [1,0,0]，余弦为 1。断言「是数字且等于 1」而不是「非空」：
  // 前者能抓住「传了 undefined / 传了字符串」这类静默降级。
  assert.equal(typeof row.similarity, "number", "similarity must be a number, not a string or undefined");
  assert.equal(row.similarity, 1, "identical vectors are similarity 1");
  store.close();
});

// 与上一条互补：拿不到相似度时必须是「未知」而不是 0。0 会被排到最后，等于替
// 用户断言「这两条毫不相似」——那是编造。
test("#603 freeze: a pair parked without a measured similarity stays unknown", async () => {
  const { store, service } = setup();
  // 直接走 service 的停车口（没有向量索引参与 = 没测过相似度）。
  const a = service.saveWithDedupe({ type: "project", title: "未知A", content: "正文A" }).memory;
  const b = service.saveWithDedupe({ type: "project", title: "未知B", content: "正文B" }).memory;
  service.saveConflictPending({ run_id: "r1", memory_a: a.id, memory_b: b.id, reason: "人工停车" });

  const [row] = store.listConflictPending();
  assert.equal(row.similarity, undefined, "no measurement must read back as unknown, not 0");
  store.close();
});

// Issue #603 第 4 层：自动裁决档。相似度极高的**同 scope** 对直接保留新条、归档
// 旧条，不进人工队列；跨 scope 对永不自动（归属是用户的决定）。
test("#603 auto-resolve: a near-duplicate same-scope pair is superseded without entering the queue", async () => {
  const { store, service, vectorIndex } = setup();
  const [first, second] = savePair(service, vectorIndex, "缓存策略A", "缓存策略B", { agent: "coder" }, { agent: "coder" });

  const result = await runSleep(
    llmCtx(), service,
    baseConfig({ conflictFreezeEnabled: true, conflictAutoResolveEnabled: true, conflictAutoResolveMinSimilarity: 0.95 }),
    { warn: () => {}, info: () => {} }, { embedder, vectorIndex }, null
  );
  assert.equal(result.status, "ok");

  // 队列必须是空的：这一对根本没进人工队列。
  assert.equal(store.countConflictPending(), 0, "auto-resolved pairs must not reach the manual queue");
  // 不猜 id 顺序，用归档状态反推哪一侧被取代。
  const archivedIds = [first.id, second.id].filter((id) => store.getById(id).archived);
  assert.equal(archivedIds.length, 1, "exactly one side is archived");
  const loser = archivedIds[0];
  const survivor = [first.id, second.id].find((id) => !store.getById(id).archived);
  // 留下的那条正文一字不动（supersede 把注记写在败者侧，不污染幸存者）。
  assert.doesNotMatch(store.getById(survivor).content, /已被取代|superseded by/,
    "the survivor's body must stay clean");
  // 败者侧带可追溯注记（#126 的原设计）。
  assert.match(store.getById(loser).content, /已被取代|superseded by/,
    "traceability lives on the archived side");
  // 机器台账也要有一条：自动动作必须能事后回答「什么时候、被谁判的」。
  const reviewed = typeof store.listConflictReviewed === "function" ? store.listConflictReviewed({ limit: 10 }) : [];
  assert.ok(reviewed.length >= 1, "auto-resolve must leave a ledger row");
  assert.equal(reviewed[0].outcome, "supersede");
  store.close();
});

test("#603 auto-resolve: a cross-scope pair is never auto-adjudicated, even at similarity 1", async () => {
  const { store, service, vectorIndex } = setup();
  const [xNew, xOld] = savePair(service, vectorIndex, "部署清单A", "部署清单B", { agent: "coder" }, { agent: "writer" });

  const result = await runSleep(
    llmCtx(), service,
    baseConfig({ conflictFreezeEnabled: true, conflictAutoResolveEnabled: true, conflictAutoResolveMinSimilarity: 0.95 }),
    { warn: () => {}, info: () => {} }, { embedder, vectorIndex }, null
  );
  assert.equal(result.status, "ok");

  // 向量完全相同（余弦 1），但归属不同 → 只能停车等人判。
  assert.equal(store.countConflictPending(), 1, "cross-scope pair still goes to the manual queue");
  assert.equal(store.getById(xOld.id).archived, false, "cross-scope loser is never auto-archived");
  assert.equal(store.getById(xNew.id).archived, false, "cross-scope winner is untouched too");
  store.close();
});

test("#603 auto-resolve: with the switch off nothing is auto-adjudicated", async () => {
  const { store, service, vectorIndex } = setup();
  savePair(service, vectorIndex, "主题A", "主题B", { agent: "coder" }, { agent: "coder" });

  const result = await runSleep(
    llmCtx(), service,
    baseConfig({ conflictFreezeEnabled: true, conflictAutoResolveEnabled: false }),
    { warn: () => {}, info: () => {} }, { embedder, vectorIndex }, null
  );
  assert.equal(result.status, "ok");
  assert.equal(store.countConflictPending(), 1, "with the switch off, nothing is auto-adjudicated");
  store.close();
});

// 自动裁决保留的是**信息量更大**的那条，不是更新的那条。
// 反例来自 live 库：>=0.95 的 20 对里 11 对（55%）新条比旧条短，平均短 132 字——
// 蒸馏压缩过的一版反而更新时间更晚，按「留新的」会把更完整的那条归档掉。
test("#603 auto-resolve: the longer copy survives even when the shorter one is newer", async () => {
  const { store, service, vectorIndex } = setup();
  // 先存长的那条（更旧），再存短的那条（更新）：新条更短，正是实测里的多数情况。
  const longBody = "缓存策略要按写入频率分三档：热数据走内存、温数据走 SSD、冷数据归档到对象存储。"
    + "切换阈值由每小时访问次数决定，低于一次就降档，连续三天高于十次再升档。";
  const shortBody = "缓存策略按写入频率分档。";
  const older = service.saveWithDedupe({
    type: "project", title: "缓存分层", content: longBody
  }).memory;
  const newer = service.saveWithDedupe({
    type: "project", title: "缓存分层摘要", content: shortBody
  }).memory;
  vectorIndex.saveEmbedding(older.id, [1, 0, 0]);
  vectorIndex.saveEmbedding(newer.id, [1, 0, 0]);
  assert.ok(older.content.length > newer.content.length, "fixture: the older copy must be the longer one");

  const result = await runSleep(
    llmCtx(), service,
    baseConfig({ conflictFreezeEnabled: true, conflictAutoResolveEnabled: true, conflictAutoResolveMinSimilarity: 0.95 }),
    { warn: () => {}, info: () => {} }, { embedder, vectorIndex }, null
  );
  assert.equal(result.status, "ok");
  assert.equal(result.phases.conflicts.autoResolved, 1, "the pair is auto-adjudicated");

  // 幸存者必须是长的那条：留新的会把三档策略削成一句话。
  assert.equal(store.getById(older.id).archived, false, "the longer, older copy must survive");
  assert.equal(store.getById(newer.id).archived, true, "the shorter, newer copy is the one archived");
  store.close();
});

// 长度相同才是「信息量相当」，此时退回更新时间：新条胜出，且结论确定可重放。
test("#603 auto-resolve: equal-length copies fall back to the newer one, deterministically", async () => {
  const { store, service, vectorIndex } = setup();
  const body = "部署脚本先跑 migrate 再跑 smoke，任一步失败就回滚到上一个 tag。";
  const older = service.saveWithDedupe({ type: "project", title: "部署甲", content: body }).memory;
  const newer = service.saveWithDedupe({ type: "project", title: "部署乙", content: body }).memory;
  vectorIndex.saveEmbedding(older.id, [1, 0, 0]);
  vectorIndex.saveEmbedding(newer.id, [1, 0, 0]);

  const result = await runSleep(
    llmCtx(), service,
    baseConfig({ conflictFreezeEnabled: true, conflictAutoResolveEnabled: true, conflictAutoResolveMinSimilarity: 0.95 }),
    { warn: () => {}, info: () => {} }, { embedder, vectorIndex }, null
  );
  assert.equal(result.status, "ok");
  assert.equal(result.phases.conflicts.autoResolved, 1);
  // 等长 → 比 updated_at：后存的赢。长度相等时不至于两边都"更完整"，留新的是安全的。
  assert.equal(store.getById(newer.id).archived, false, "equal length: the newer copy survives");
  assert.equal(store.getById(older.id).archived, true);
  store.close();
});

test("#603 auto-resolve: a failed adjudication falls back to the manual queue instead of vanishing", async () => {
  const { store, service, vectorIndex } = setup();
  savePair(service, vectorIndex, "回退A", "回退B", { agent: "coder" }, { agent: "coder" });

  // 让 supersede 一定失败：把 applyDecisions 依赖的 update 打断。
  const realUpdate = service.update.bind(service);
  let calls = 0;
  service.update = (...args) => {
    calls++;
    throw new Error("write refused");
  };

  const result = await runSleep(
    llmCtx(), service,
    baseConfig({ conflictFreezeEnabled: true, conflictAutoResolveEnabled: true, conflictAutoResolveMinSimilarity: 0.95 }),
    { warn: () => {}, info: () => {} }, { embedder, vectorIndex }, null
  );
  service.update = realUpdate;

  assert.ok(calls > 0, "the auto path did try to apply");
  // 自动档没落地 → 这一对必须退回人工队列。丢掉它才是真正的静默丢失。
  assert.equal(store.countConflictPending(), 1, "a failed auto-resolve must land in the manual queue");
  assert.equal(result.status, "ok", "the run itself is not a failure");
  store.close();
});

test("non-freeze with an LLM: cross-scope pair bypasses adjudication; same-scope pair is adjudicated", async () => {
  const { store, service, vectorIndex } = setup();
  const [yNew, yOld] = savePair(service, vectorIndex, "缓存策略A", "缓存策略B", { agent: "coder" }, { agent: "coder" });
  const [xNew, xOld] = savePair(service, vectorIndex, "编辑器主题A", "编辑器主题B", { agent: "coder" }, { agent: "writer" });

  const captured = [];
  const ctx = llmCtx(captured);
  // 同 scope 对由 LLM 裁决：保留 yNew、归档 yOld。跨 scope 对绝不进 prompt。
  ctx.llm.stream = async function* (options) {
    captured.push(options);
    const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
    const isConflictPass = options.purpose === "sleep-conflict";
    const text = isConflictPass
      ? JSON.stringify([{ action: "conflict", winner: yNew.id, loser: yOld.id, reason: "同归属重复" }])
      : "[]";
    yield { type: "text-delta", index: 0, text };
    yield { type: "finish", reason: { kind: "stop" } };
  };

  const result = await runSleep(ctx, service, baseConfig(), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.status, "ok");

  // 认「哪一次是冲突裁决」改按 purpose，不再看 user 段首行：#493 追加的围栏让 user 段以
  // 角色声明开头，而败者行的溯源注释里也会出现「候选冲突」这个词——用 includes 会把模式
  // 阶段误判成冲突阶段。purpose 与 prompt 形态彻底解耦。
  const conflictPassTexts = captured
    .filter((o) => o.purpose === "sleep-conflict")
    .map((o) => o.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "");
  assert.ok(conflictPassTexts.length >= 1, "conflict pass ran for the same-scope pair");
  for (const t of conflictPassTexts) {
    assert.ok(!t.includes(xNew.id) && !t.includes(xOld.id), "cross-scope pair must never enter the LLM prompt");
    assert.ok(t.includes(yNew.id) && t.includes(yOld.id), "same-scope pair is adjudicated");
  }

  const queue = store.listConflictPending();
  assert.equal(queue.length, 1);
  assert.match(queue[0].reason, /跨作用域|cross-scope/);
  assert.equal(store.getById(xOld.id).archived, false, "cross-scope loser is NOT archived by the LLM");
  assert.equal(store.getById(yOld.id).archived, true, "same-scope loser is adjudicated as usual");
  store.close();
});
