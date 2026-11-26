import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createInjector } from "../src/inject.js";
import { createSettings } from "../src/settings.js";
import { testConfig } from "./helpers/test-config.js";

// #786 回归：装配时等查询向量预取的上限原先是写死的 250ms。
//
// 本地 ONNX 是进程内前向，250ms 够用；远程 OpenAI 兼容 embedding 的 RTT 实测
// 400~600ms（抖动到 1s），于是 step 1 几乎每次都在超时后落空、退回纯 BM25 或
// 规则兜底，只有 step 2 才用得上向量——单步问答整轮没有语义召回。
//
// 这里锁三件事：
//  ① 远程路线（embedProvider="openai"）默认放宽到 1200ms，能等到 500ms 的往返；
//  ② 本地/ollama 路线维持 250ms，不为快端点增加延迟；
//  ③ 显式 prefetchWaitMs 一档压过路线判据（含比默认更小的值）。

const claimed = (text) => ({ content: [{ type: "text", text }], source: { kind: "user" }, id: "m1" });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// 与 #683 的夹具同形：保留宿主的两条真实约束（context 同步、assemble 异步瀑布）。
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
    systemPrompt: { context(def) { contexts.push(def); return () => {}; } }
  };
  const renders = [];
  const orig = service.injectCandidates.bind(service);
  service.injectCandidates = (args) => {
    renders.push({ query: args.query, queryVector: args.queryVector });
    return orig(args);
  };
  service.setEmbedder({ embedSingle: async (text) => embedImpl(text) });
  createInjector(ctx, service, settings, { maxInjectedItems: 3, importanceThreshold: 3, ...over });
  const fireClaim = (message, session) => handlers.get("agent/inbox/claimed")?.({ message, agent: { session } });
  const assemble = async (session) => {
    const promptCtx = { agent: { session } };
    const assembly = {
      contexts: contexts.map((def) => ({ name: def.name, text: def.text(promptCtx) }))
    };
    const waterfall = handlers.get("system-prompt/assemble");
    if (waterfall) await waterfall(assembly, promptCtx, () => Promise.resolve(assembly));
    return assembly;
  };
  return { renders, fireClaim, assemble };
}

const session = (id) => ({ id, events: [], snapshotEvents() { return this.events; } });
// 500ms 恰好落在两个默认档之间：本地档（250）等不到，远程档（1200）等得到。
const REMOTE_RTT_MS = 500;

test("#786: 远程 embedding 路线默认等到 1200ms，step 1 不再落空", async () => {
  const { renders, fireClaim, assemble } = setupAssembly(async () => {
    await tick(REMOTE_RTT_MS);
    return [1, 0, 0];
  }, { embedProvider: "openai" });
  const s = session("remote1");
  fireClaim(claimed("远程向量这一步要等回来"), s);
  const started = Date.now();
  await assemble(s);
  const elapsed = Date.now() - started;
  assert.equal(renders.length, 2, "向量回来了就要重算，不能退回纯词法");
  assert.deepEqual(renders[1].queryVector, [1, 0, 0], "重算必须带着刚回来的向量");
  assert.ok(elapsed >= REMOTE_RTT_MS - 100, `应当真的等到了那趟往返，实测 ${elapsed}ms`);
});

test("#786: 本地/ollama 路线仍是 250ms，不为快端点加延迟", async () => {
  const { renders, fireClaim, assemble } = setupAssembly(async () => {
    await tick(REMOTE_RTT_MS);
    return [1, 0, 0];
  }, { embedProvider: "local" });
  const s = session("local1");
  fireClaim(claimed("本地路线不该等这么久"), s);
  const started = Date.now();
  await assemble(s);
  const elapsed = Date.now() - started;
  assert.equal(renders.length, 1, "超过 250ms 的本地预取照旧放弃");
  assert.ok(elapsed < REMOTE_RTT_MS - 100, `本地档必须早于 500ms 放手，实测 ${elapsed}ms`);
});

test("#786: 显式 prefetchWaitMs 一档压过路线判据", async () => {
  const { renders, fireClaim, assemble } = setupAssembly(async () => {
    await tick(REMOTE_RTT_MS);
    return [1, 0, 0];
  }, { embedProvider: "openai", prefetchWaitMs: 100 });
  const s = session("explicit1");
  fireClaim(claimed("显式调小就该按小的来"), s);
  const started = Date.now();
  await assemble(s);
  const elapsed = Date.now() - started;
  assert.equal(renders.length, 1, "显式 100ms 比 500ms 的往返短，必须放弃");
  assert.ok(elapsed < 400, `显式上限要真的生效，实测 ${elapsed}ms`);
});
