import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createInjector } from "../src/inject.js";
import { createSettings } from "../src/settings.js";
import { createVectorIndex } from "../src/vector-index.js";
import { testConfig } from "./helpers/test-config.js";

// #683 回归。两处都来自 #620 评论区承诺过、但没合进 0.14.0 的后续：
//
// ① 预取向量在被用掉之前没人等它。这里要顺带钉住一个**结论性事实**：宿主的
//    preStep 是 claim → assemble → 才派发 agent/pre-step（dsh-agent-loop 的
//    src/agent.ts:301 与 :303），所以在 agent/pre-step 里等是等不到的，唯一还能
//    改装配结果的位置是 system-prompt/assemble 这条异步瀑布。
// ② 余弦缺失时被当成 0 分，把「词法精确命中但没有 embedding」的老行系统性压到
//    「意思像但只有向量」的行之下。

const userMessage = (text) => ({ type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text }] } });
const claimed = (text) => ({ content: [{ type: "text", text }], source: { kind: "user" }, id: "m1" });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// --- 组 1：装配前等在飞的预取 ------------------------------------------------
//
// 夹具刻意保留宿主的两条真实约束：context 的 text 是**同步**的（等不了），
// assemble 瀑布是**异步**的（唯一能等的地方）。任何把等待写进 text 的改法都会
// 让这里同步返回、断言直接挂掉。
function setupAssembly(embedImpl, over = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const settings = createSettings(store.db);
  const contexts = [];
  const handlers = new Map();
  const ctx = {
    on(event, fn) {
      handlers.set(event, fn);
      return () => handlers.delete(event);
    },
    systemPrompt: {
      context(def) { contexts.push(def); return () => {}; }
    }
  };
  // 查询向量是这条链路唯一能被直接观测的产物：记下每次 injectCandidates 拿到什么。
  const renders = [];
  const orig = service.injectCandidates.bind(service);
  service.injectCandidates = (args) => {
    renders.push({ query: args.query, queryVector: args.queryVector });
    return orig(args);
  };
  const calls = [];
  service.setEmbedder({
    embedSingle: async (text) => {
      calls.push(text);
      return embedImpl(text);
    }
  });
  const injector = createInjector(ctx, service, settings, { maxInjectedItems: 3, importanceThreshold: 3, ...over });
  const memoryDef = contexts.find((def) => def.name === "memory");
  const fireClaim = (message, session) => handlers.get("agent/inbox/claimed")?.({ message, agent: { session } });
  // 复刻宿主的一次装配：先同步求值各 context，再走异步瀑布。
  const assemble = async (session) => {
    const promptCtx = { agent: { session } };
    const assembly = {
      contexts: contexts.map((def) => ({ name: def.name, text: def.text(promptCtx) }))
    };
    const waterfall = handlers.get("system-prompt/assemble");
    if (waterfall) await waterfall(assembly, promptCtx, () => Promise.resolve(assembly));
    return assembly;
  };
  return { store, service, contexts, injector, calls, renders, fireClaim, handlers, memoryDef, assemble };
}

const session = (id) => ({ id, events: [], snapshotEvents() { return this.events; } });

test("#683-1: 装配时若预取还在飞，等它并重算记忆块（远程 embedding 的 Step 1）", async () => {
  const { renders, fireClaim, assemble } = setupAssembly(async () => {
    await tick(20); // 模拟远程 HTTP 往返
    return [1, 0, 0];
  });
  const s = session("w1");
  fireClaim(claimed("夜航App令牌桶限流方案怎么设计"), s);
  const assembly = await assemble(s);

  const first = renders[0];
  assert.equal(first.query, "夜航App令牌桶限流方案怎么设计", "Step 1 的查询文本由认领票据补齐");
  assert.equal(first.queryVector, undefined, "夹具前提：第一次求值时向量还没回来");
  assert.equal(renders.length, 2, "等到了向量就要重算一次，不能带着空向量交差");
  assert.deepEqual(renders[1].queryVector, [1, 0, 0], "重算必须带着刚回来的向量");
  const memory = assembly.contexts.find((entry) => entry.name === "memory");
  assert.ok(memory, "重算的落点是装配结果里的记忆块");
});

test("#683-1: 没有在飞的预取时，装配不等（不拖慢正常步）", async () => {
  const { renders, assemble } = setupAssembly(async () => [1, 0, 0]);
  const s = session("w2");
  const started = Date.now();
  await assemble(s);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 100, `没有预取就不该有等待，实测 ${elapsed}ms`);
  assert.equal(renders.length, 1, "没等到向量就不该重算");
});

test("#683-1: 预取失败时装配照常返回，不重算也不抛", async () => {
  const { renders, fireClaim, assemble } = setupAssembly(async () => {
    await tick(5);
    throw new Error("embedding 端点不通");
  });
  const s = session("w3");
  fireClaim(claimed("换一条查询看失败路径"), s);
  const assembly = await assemble(s);
  assert.equal(renders.length, 1, "拿不到向量就没有重算的理由");
  assert.ok(assembly.contexts.some((entry) => entry.name === "memory"), "记忆块本身仍在装配结果里");
});

test("#683-1: 预取超过等待上限时放弃等待，装配不被卡住", async () => {
  const { renders, fireClaim, assemble } = setupAssembly(async () => {
    await tick(900); // 比 PREFETCH_WAIT_MS（250ms）长得多
    return [1, 0, 0];
  });
  const s = session("w4");
  fireClaim(claimed("这条路会超时的查询"), s);
  const started = Date.now();
  await assemble(s);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 700, `等待必须有上限，实测 ${elapsed}ms`);
  assert.equal(renders.length, 1, "没等到就别重算");
});

// --- 组 2：余弦缺失的中性基线 -------------------------------------------------
//
// 两把尺子：同一个库、同一条查询，只改「词法命中的那行有没有向量」。
// 两条路各排出一份名单，两边的第 1 名都拿到 1/(60+1) 的 RRF 分，归一化后各贡献
// 0.25；余弦只占剩下的一半权重。于是词法命中那行的融合分是
//   0.5×(余弦或基线) + 0.25
// 旧行为把它当 0 分（0.25），新行为给中性基线（0.5），而纯向量命中的那行由
// 0.5×余弦 + 0.25 决定——余弦落在 (0, 0.5) 区间时，两者正好换位。
function seedFusionPair(service) {
  const vecOnly = service.saveWithDedupe({
    type: "project", title: "星图渲染重构", content: "绘制管线迁移与图层合并", importance: 3
  }).memory;
  const lexHit = service.saveWithDedupe({
    type: "decision", title: "夜航限流选型", content: "决定采用令牌桶做夜航App的限流方案", importance: 3
  }).memory;
  return { vecOnly, lexHit };
}

// 余弦 0.42：旧行为下词法命中 0.25 < 纯向量 0.46；新行为下 0.5 > 0.46。
const VEC_ONLY_SIM = 0.42;
const vecOnlyEmbedding = () => [VEC_ONLY_SIM, Math.sqrt(1 - VEC_ONLY_SIM ** 2), 0];

test("#683-2: 余弦缺失按中性基线算，词法精确命中不再被判 0 分", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const { vecOnly, lexHit } = seedFusionPair(service);
  const vectorIndex = createVectorIndex({ store });
  service.setVectorIndex(vectorIndex);
  vectorIndex.saveEmbedding(vecOnly.id, vecOnlyEmbedding());

  const picked = service.injectCandidates({
    query: "夜航App令牌桶限流方案怎么设计的", maxItems: 5, threshold: 3, queryVector: [1, 0, 0]
  });
  assert.equal(picked[0].id, lexHit.id, "没有 embedding 不是「这一路零分」，不该把词法精确命中压下去");
  assert.ok(picked.some((m) => m.id === vecOnly.id), "纯向量命中仍在池内，融合不是二选一");
  store.close();
});

test("#683-2: 两路都缺的候选仍沉底（中性基线不得复活无信号行）", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const { vecOnly, lexHit } = seedFusionPair(service);
  const noise = service.saveWithDedupe({
    type: "project", title: "无关存档", content: "与这次查询既不同词也不同义的一段记录", importance: 5
  }).memory;
  const vectorIndex = createVectorIndex({ store });
  service.setVectorIndex(vectorIndex);
  vectorIndex.saveEmbedding(vecOnly.id, vecOnlyEmbedding());

  const picked = service.injectCandidates({
    query: "夜航App令牌桶限流方案怎么设计的", maxItems: 3, threshold: 3, queryVector: [1, 0, 0]
  });
  const order = picked.map((m) => m.id);
  assert.ok(order.includes(lexHit.id), "词法命中在池内");
  assert.ok(order.includes(vecOnly.id), "向量命中在池内");
  assert.ok(!order.includes(noise.id) || order.indexOf(noise.id) > order.indexOf(lexHit.id),
    "两路都没有的行不能被中性基线抬到有信号的行之前");
  store.close();
});