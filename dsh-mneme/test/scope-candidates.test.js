import test from "node:test";
import assert from "node:assert/strict";
import { runSleep } from "../src/dream/sleep.js";
import { createDreamScheduler } from "../src/dream.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";

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
  const service = createService({ store, mirror: null, config: {} });
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
