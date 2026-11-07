// 知识库第二层的接线回归锁（契约 §3.4 / §3.6）。
//
// A 线只负责「把已经写好的 kb 子系统接上闸与两条出口」——所以这里锁的是**闸的
// 分叉形状**，不是 kb 内部功能（那在 kb 自己的测试里）。两条闸必须可区分：
// 503 = 这个宿主没装配 kb；409 = 用户没开开关。两者混成一个状态码，面板就没法
// 分辨「去设置里打开」和「这台宿主不支持」。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";
import { createKb } from "../src/kb/index.js";
import { createTools } from "../src/tools.js";

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function req(path, method = "GET") {
  const r = new EventEmitter();
  r.url = path;
  r.method = method;
  r.headers = {};
  return r;
}

// 注意实参顺序：kb 是第 12 参，必须显式补到位置（facts 用 undefined 占位）。
function setup({ config = null, kb = null } = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, { add: () => {}, remove: () => false, list: () => [] },
    null, undefined, "", config, null, null, null, undefined, kb);
  return { routes, store };
}

async function invoke(route, path) {
  const res = new FakeRes();
  await route.handler(req(path), res);
  return { status: res.statusCode, body: JSON.parse(res.body || "{}") };
}

test("kb 未装配 → 503 unavailable；装了但开关没开 → 409 disabled（两条闸不许混）", async () => {
  const missing = setup({ config: { kbEnabled: true } });
  const off = setup({ config: { kbEnabled: false }, kb: createKb({ store: missing.store }) });
  try {
    const a = await invoke(missing.routes.find((r) => r.path === "/api/dsh-mneme/kb/collections"), "/api/dsh-mneme/kb/collections");
    assert.equal(a.status, 503);
    assert.equal(a.body.error, "unavailable");

    const b = await invoke(off.routes.find((r) => r.path === "/api/dsh-mneme/kb/collections"), "/api/dsh-mneme/kb/collections");
    assert.equal(b.status, 409);
    assert.equal(b.body.error, "disabled");
    assert.equal(b.body.reason, "kb-not-enabled");
  } finally {
    missing.store.close();
    off.store.close();
  }
});

test("开关开 + 已装配 → kb 六条路由全在册且 200 通", async () => {
  const s = setup({ config: { kbEnabled: true }, kb: createKb({ store: createStore(":memory:") }) });
  try {
    const paths = [
      "/api/dsh-mneme/kb/collections",
      "/api/dsh-mneme/kb/docs",
      "/api/dsh-mneme/kb/doc",
      "/api/dsh-mneme/kb/ingest",
      "/api/dsh-mneme/kb/search"
    ];
    for (const p of paths) assert.ok(s.routes.find((r) => r.path === p), `${p} 在册`);

    // 同一路径上混了 GET/POST，policy 只能声明一个，取更严的 token-write。
    // 这条锁防的是「为了省事把集合路径拆成两条」——registrar 会直接抛重复路径。
    const collections = s.routes.find((r) => r.path === "/api/dsh-mneme/kb/collections");
    assert.equal(collections.policy, "token-write");

    const list = await invoke(collections, "/api/dsh-mneme/kb/collections");
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.collections), "空知识库也要回空数组，面板靠它渲染空态而不是报错");
  } finally {
    s.store.close();
  }
});

// 用 tools.get(name) 逐个探存在性：宿主注册表没有 list()，而 wiki-tools 里 choro
// 三工具也是这么断言的（同一套探法，避免两处对「怎么算注册了」有两种理解）。
async function toolPresence(config, kb, names) {
  const ctx = new Context();
  const prompt = await ctx.plugin(SystemPrompt);
  const runtime = await ctx.plugin(ToolRuntime);
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const registry = ctx.get("tools");
  createTools({ tools: registry }, service, config, null, null, null, kb);
  const present = Object.fromEntries(names.map((n) => [n, Boolean(registry.get(n))]));
  runtime.dispose(); prompt.dispose(); store.close();
  return present;
}

test("kb 三工具：默认不注册，开关打开且装配到位才可见", async () => {
  const KB_TOOLS = ["kb_list_collections", "kb_search", "kb_read_doc"];
  const store = createStore(":memory:");
  const kb = createKb({ store });

  // 默认（kbEnabled 缺省 false）：模型看不到就不会调——与 choro 三工具同款反向语义。
  const off = await toolPresence({}, kb, KB_TOOLS);
  for (const name of KB_TOOLS) assert.equal(off[name], false, `${name} 默认不该注册`);

  // 开了但装配缺件：同样不可见。可区分性归路由层（503 / 409），模型侧不需要
  // 看见一个调了必抛的半个知识库。
  const noKb = await toolPresence({ kbEnabled: true }, null, KB_TOOLS);
  for (const name of KB_TOOLS) assert.equal(noKb[name], false, `${name} 装配缺件时不该注册`);

  const on = await toolPresence({ kbEnabled: true }, kb, KB_TOOLS);
  for (const name of KB_TOOLS) assert.equal(on[name], true, `${name} 开关开 + 装配到位时必须注册`);

  store.close();
});
