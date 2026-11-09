import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createInjector } from "../src/inject.js";
import { createSettings } from "../src/settings.js";
import { createVectorIndex } from "../src/vector-index.js";

// #617 回归。三条缺陷各自独立成组，组内都用「一正一反」两把尺子：正向锁
// 「改对了」，反向（关掉对应开关 / 换成对照配方）锁「这条断言真的是在测那条
// 通路」，免得断言退化成常量真。

// --- 组 1：Step 1 的当轮查询（根因 A）-------------------------------------
//
// 宿主 agent-loop 的每个 step 是 claim() → assemble() → step()，而 user/message
// 要到 step() 末尾才 append。注入的 text 回调在 assemble 里求值，所以只看事件流
// 必然慢一拍：Step 1 拿到 ""，第 N 轮的 Step 1 拿到第 N-1 轮的旧输入。
// 票据（agent/inbox/claimed）在 claim 那一刻记原文，渲染时事件流还没长就用它。
function setupInjector(over = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const contexts = [];
  const handlers = new Map();
  const ctx = {
    // 真实宿主 ctx 有 on()；旧夹具没有，所以旧夹具永远测不到这条路径。
    on(event, fn) {
      handlers.set(event, fn);
      return () => handlers.delete(event);
    },
    systemPrompt: {
      context(def) {
        contexts.push(def);
        return () => {};
      }
    }
  };
  const config = { maxInjectedItems: 3, importanceThreshold: 3, ...over };
  const injector = createInjector(ctx, service, settings, config);
  // 查询词是注入链路里唯一能直接观测的输入：包一层记下每次渲染实际传了什么。
  const queries = [];
  const orig = service.injectCandidates.bind(service);
  service.injectCandidates = (args) => {
    queries.push(args.query);
    return orig(args);
  };
  const fireClaim = (message, session) => handlers.get("agent/inbox/claimed")?.({ message, agent: { session } });
  return { store, service, contexts, injector, queries, fireClaim, handlers };
}

const userMessage = (text) => ({ type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text }] } });
const claimed = (text) => ({ content: [{ type: "text", text }], source: { kind: "user" }, id: "m1" });

test("#617-A: Step 1 在 user/message 落盘之前，用认领票据拿到当轮输入", () => {
  const { contexts, queries, fireClaim } = setupInjector();
  const session = { id: "s-617", events: [], snapshotEvents() { return this.events; } };
  // claim 发生在 assemble 之前，此刻事件流里还没有本轮消息
  fireClaim(claimed("夜航App令牌桶限流方案怎么设计"), session);
  assert.equal(session.events.length, 0, "夹具前提：认领时 user/message 尚未落盘");
  contexts[0].text({ agent: { session } });
  assert.equal(queries.at(-1), "夜航App令牌桶限流方案怎么设计", "Step 1 必须拿到当轮输入，而不是空串");
});

test("#617-A: claim 与 assemble 之间插入无关事件，票据不得提前退休", () => {
  // 宿主 preStep 的顺序是 claim() → await tools.resolve() → assemble()。中间那个
  // await 给了别的插件追加事件的机会；若按「事件条数变多」判票据失效，Step 1 就
  // 又退回空串——正是本 issue 要修的那一拍。判据必须是文本，不是条数。
  const { contexts, queries, fireClaim } = setupInjector();
  const session = { id: "s-617i", events: [], snapshotEvents() { return this.events; } };
  session.events.push(userMessage("上一轮的问题"));
  fireClaim(claimed("这一轮的新问题"), session);
  // tools.resolve 期间，别的插件追加了一个与用户消息无关的事件
  session.events.push({ type: "system/message", data: { content: [{ type: "text", text: "插件上下文" }] } });
  contexts[0].text({ agent: { session } });
  assert.equal(queries.at(-1), "这一轮的新问题", "无关事件不得让票据提前失效");
});

test("#617-A: 事件流长过票据记录后，票据退休、以事件流为准", () => {
  const { contexts, queries, fireClaim } = setupInjector();
  const session = { id: "s-617b", events: [], snapshotEvents() { return this.events; } };
  fireClaim(claimed("第一个问题"), session);
  contexts[0].text({ agent: { session } });
  assert.equal(queries.at(-1), "第一个问题");
  // step() 末尾 append → 事件流变长
  session.events.push(userMessage("第一个问题"));
  contexts[0].text({ agent: { session } });
  assert.equal(queries.at(-1), "第一个问题", "落盘后两者一致（此轮无差异）");
  // 下一轮：新的 claim 覆盖票据，事件流里仍是上一轮的文本
  fireClaim(claimed("第二个问题"), session);
  contexts[0].text({ agent: { session } });
  assert.equal(queries.at(-1), "第二个问题", "新一轮的 Step 1 不得拿到上一轮的旧输入");
});

test("#617-A: 非人类消息（source.kind 非 user）不产生票据", () => {
  const { contexts, queries, fireClaim } = setupInjector();
  const session = { id: "s-617c", events: [], snapshotEvents() { return this.events; } };
  fireClaim({ content: [{ type: "text", text: "插件注入的上下文" }], source: { kind: "system" } }, session);
  contexts[0].text({ agent: { session } });
  assert.equal(queries.at(-1), "", "插件自己的话不得被当成用户问题");
});

test("#617-A: 卸载后摘掉 claimed 监听，不再写票据", () => {
  const { contexts, injector, queries, fireClaim, handlers } = setupInjector();
  const session = { id: "s-617d", events: [], snapshotEvents() { return this.events; } };
  assert.ok(handlers.has("agent/inbox/claimed"), "挂载时注册监听");
  injector();
  assert.equal(handlers.has("agent/inbox/claimed"), false, "卸载即摘，不留孤儿监听");
  fireClaim(claimed("卸载后不该记"), session);
  // 注入器已卸载，context 也不再生效；这里只确认没有票据泄漏到下一次装配
  assert.equal(queries.length, 0);
  void contexts;
});

// --- 组 2：prefetch 去重与失败冷却（根因 B）-------------------------------
//
// 旧实现用 lastPrefetched 字符串去重，且置位在 await 之前 —— 同一条查询第一次
// 失败（模型没下好、超时）之后永不重试，而那恰好是最需要重试的一次。
function setupPrefetch(embedImpl) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const contexts = [];
  const ctx = { systemPrompt: { context(def) { contexts.push(def); return () => {}; } } };
  const calls = [];
  service.setEmbedder({
    embedSingle: async (text) => {
      calls.push(text);
      return embedImpl(text);
    }
  });
  const injector = createInjector(ctx, service, settings, { maxInjectedItems: 3, importanceThreshold: 3 });
  return { store, service, contexts, injector, calls };
}

const renderWith = (contexts, session) => contexts[0].text({ agent: { session } });
const tick = () => new Promise((r) => setTimeout(r, 0));

test("#617-B: 同一步的两次求值（assemble + refreshContext）只嵌一次", async () => {
  const { contexts, calls } = setupPrefetch(async () => [1, 0, 0]);
  const session = { id: "p1", events: [userMessage("查询文本")], snapshotEvents() { return this.events; } };
  renderWith(contexts, session); // 第一次求值：发起 inflight
  renderWith(contexts, session); // 第二次求值：必须复用 inflight，不再嵌
  await tick();
  renderWith(contexts, session); // 第三次：命中缓存
  assert.equal(calls.length, 1, "同一条查询只应嵌入一次");
});

test("#617-B: 失败后进入冷却期，不在同一帧反复撞模型", async () => {
  const { contexts, calls } = setupPrefetch(async () => { throw new Error("model not ready"); });
  const session = { id: "p2", events: [userMessage("失败查询")], snapshotEvents() { return this.events; } };
  renderWith(contexts, session);
  await tick();
  renderWith(contexts, session);
  await tick();
  renderWith(contexts, session);
  assert.equal(calls.length, 1, "冷却期内不得重试（15s 内）");
});

test("#617-B: 冷却按查询分别计，别的查询照常嵌入", async () => {
  const { contexts, calls } = setupPrefetch(async (text) => {
    if (text.includes("失败")) throw new Error("boom");
    return [1, 0, 0];
  });
  const s1 = { id: "p3", events: [userMessage("失败查询")], snapshotEvents() { return this.events; } };
  renderWith(contexts, s1);
  await tick();
  renderWith(contexts, s1);
  const s2 = { id: "p4", events: [userMessage("另一条查询")], snapshotEvents() { return this.events; } };
  renderWith(contexts, s2);
  await tick();
  assert.equal(calls.length, 2, "一条查询的失败冷却不应连坐其它查询");
});

// --- 组 3：向量路与 BM25 路并存（根因 C，前半）----------------------------
function seedStalePreferences(service, n = 8) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push(service.saveWithDedupe({
      type: "preference",
      title: `旧偏好条目${i}`,
      content: `用户喜欢深色界面与紧凑排版，这是第${i}条历史偏好存档`,
      importance: 5
    }).memory.id);
  }
  return ids;
}

function setupDualPath(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service };
}

test("#617-C: 有向量命中时，BM25 的词法精确命中不再整批消失", () => {
  const { service, store } = setupDualPath();
  seedStalePreferences(service, 8);
  // 与查询词法完全不相交，但向量最近
  const vecOnly = service.saveWithDedupe({
    type: "project", title: "星图渲染重构", content: "绘制管线迁移与图层合并", importance: 3
  }).memory;
  // 词法精确命中，但没有向量（真实库里大量老行就是这样）
  const lexHit = service.saveWithDedupe({
    type: "decision", title: "夜航限流选型", content: "决定采用令牌桶做夜航App的限流方案", importance: 3
  }).memory;
  const vectorIndex = createVectorIndex({ store });
  service.setVectorIndex(vectorIndex);
  vectorIndex.saveEmbedding(vecOnly.id, [1, 0, 0]);

  const picked = service.injectCandidates({
    query: "夜航App令牌桶限流方案怎么设计的", maxItems: 5, threshold: 3, queryVector: [1, 0, 0]
  });
  assert.equal(picked[0].id, vecOnly.id, "纯余弦命中仍是首位");
  assert.ok(picked.some((m) => m.id === lexHit.id), "BM25 命中不得被向量路挤掉（旧代码：有向量则 BM25 整段跳过）");
  assert.ok(picked.length <= 5, "池子仍按 maxItems 封顶");
  store.close();
});

test("#617-C: 关掉 BM25 后同一条词法命中确实消失（反向对照）", () => {
  const { service, store } = setupDualPath({ bm25SearchEnabled: false });
  seedStalePreferences(service, 8);
  const vecOnly = service.saveWithDedupe({
    type: "project", title: "星图渲染重构", content: "绘制管线迁移与图层合并", importance: 3
  }).memory;
  const lexHit = service.saveWithDedupe({
    type: "decision", title: "夜航限流选型", content: "决定采用令牌桶做夜航App的限流方案", importance: 3
  }).memory;
  const vectorIndex = createVectorIndex({ store });
  service.setVectorIndex(vectorIndex);
  vectorIndex.saveEmbedding(vecOnly.id, [1, 0, 0]);

  const picked = service.injectCandidates({
    query: "夜航App令牌桶限流方案怎么设计的", maxItems: 5, threshold: 3, queryVector: [1, 0, 0]
  });
  assert.equal(picked[0].id, vecOnly.id);
  assert.equal(picked.some((m) => m.id === lexHit.id), false, "BM25 关 = 词法路不参与，正向用例才不是在测别的东西");
  store.close();
});

// --- 组 4：auto 不再被 keyword 覆盖（根因 C，后半）------------------------
//
// 旧代码在 fuseRecall 收尾处，只要 recipe !== "blend" 且 mode === "auto"，就用
// keyword.slice(0,lim) 覆盖 merged —— 于是配了 rrf 却拿到 keyword 的顺序，配方
// 白选。auto 的「关键词领位」语义只属于 blend。
function setupFusion(recipe) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: { recallFusion: recipe } });
  // 标题命中（keyword 第一），但没有向量
  const kwTitle = service.saveWithDedupe({
    type: "preference", title: "令牌桶限流笔记", content: "随手记的限流笔记", importance: 2
  }).memory;
  // 正文命中（keyword 第二）+ 向量第一 —— 两路都靠前
  const both = service.saveWithDedupe({
    type: "decision", title: "夜航限流选型", content: "决定采用令牌桶限流方案，阈值按等级分层", importance: 5
  }).memory;
  const vectorIndex = createVectorIndex({ store });
  service.setVectorIndex(vectorIndex);
  vectorIndex.saveEmbedding(both.id, [1, 0, 0]);
  service.setEmbedder({ embedSingle: async () => [1, 0, 0] });
  return { service, store, kwTitle, both };
}

test("#617-C: recallFusion=rrf 时 auto 用 RRF 自己的排序，不再被 keyword 覆盖", async () => {
  const { service, store, kwTitle, both } = setupFusion("rrf");
  const rows = await service.searchMemories("令牌桶限流", { mode: "auto", topK: 2, useRerank: false, recordRecall: false });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, both.id, "两路都命中的行必须排第一（keyword 只命中标题的行不该领位）");
  assert.equal(rows[1].id, kwTitle.id);
  store.close();
});

test("#617-C: blend 的 auto 关键词领位契约保持不变（反向对照）", async () => {
  const { service, store, kwTitle, both } = setupFusion("blend");
  const rows = await service.searchMemories("令牌桶限流", { mode: "auto", topK: 2, useRerank: false, recordRecall: false });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, kwTitle.id, "blend 下 keyword 领位是既有契约，本次改动不该碰它");
  assert.equal(rows[1].id, both.id);
  store.close();
});
