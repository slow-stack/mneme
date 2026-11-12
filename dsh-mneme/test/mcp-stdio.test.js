// #181：stdio MCP server（bin/dsh-mneme-mcp.mjs）测试。
// 集成路径：spawn 真进程、真 standalone API（同 standalone-api.test.js 的
// 内存库 harness）、真 JSON-RPC 帧往返；平价路径：MCP_TOOLS 与 src/tools.js
// 的六件套逐字对齐（名称/描述/参数 type+enum+items+required），锁漂移。

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createStandaloneApi } from "../src/api-standalone.js";
import { createTools } from "../src/tools.js";
import { MCP_TOOLS, resolveMcpConfig } from "../bin/dsh-mneme-mcp.mjs";
import { fakeToken } from "./helpers/fake-auth-values.js";

const FILE_TOKEN = fakeToken("file");
const ENV_TOKEN = fakeToken("env");

const MCP_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "dsh-mneme-mcp.mjs");

async function setupApi() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const api = createStandaloneApi({ service, store, config: {}, settings, logger: null, port: 0 });
  await api.ready;
  return {
    service,
    base: `http://127.0.0.1:${api.port}`,
    token: api.token,
    close: () => {
      api.server.closeIdleConnections?.();
      api.server.close();
      store.close();
    }
  };
}

/** spawn 一个 MCP server 子进程，返回按 id 配对的 request/notify 句柄。 */
function startMcp(env = {}) {
  const child = spawn(process.execPath, [MCP_BIN], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const pending = new Map();
  const rawListeners = new Set();
  let buffer = "";
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const resolver = pending.get(msg.id);
      if (resolver) {
        pending.delete(msg.id);
        resolver(msg);
      }
      for (const listener of rawListeners) listener(msg);
    }
  });
  // 原始帧监听（协议错误测试用——-32700 的 id 是 null，进不了按 id 配对的 pending）。
  const onMessage = (fn) => {
    rawListeners.add(fn);
    return () => rawListeners.delete(fn);
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 10_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })}\n`);
  });
  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) })}\n`);
  };
  const stop = () => {
    child.stdin.end();
    return new Promise((resolve) => child.on("exit", resolve));
  };
  return { child, request, notify, onMessage, stop };
}

const textOf = (msg) => msg?.result?.content?.[0]?.text;

async function initialize(mcp) {
  const res = await mcp.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "node:test", version: "0" }
  });
  mcp.notify("notifications/initialized");
  return res.result;
}

// --- 协议 ---------------------------------------------------------------------

test("initialize handshake: supported protocol version echoed, tools capability advertised", async () => {
  const api = await setupApi();
  const mcp = startMcp({ DSH_MNEME_URL: api.base, DSH_MNEME_TOKEN: api.token });
  try {
    const result = await initialize(mcp);
    assert.ok(["2024-11-05", "2025-03-26", "2025-06-18"].includes(result.protocolVersion), "echoes a supported version");
    assert.equal(result.serverInfo.name, "dsh-mneme");
    assert.ok(result.serverInfo.version, "server version present");
    assert.ok(result.capabilities.tools, "tools capability advertised");

    const ping = await mcp.request("ping");
    assert.deepEqual(ping.result, {});
  } finally {
    await mcp.stop();
    api.close();
  }
});

test("unknown protocol version falls back to the server's latest", async () => {
  const api = await setupApi();
  const mcp = startMcp({ DSH_MNEME_URL: api.base, DSH_MNEME_TOKEN: api.token });
  try {
    const res = await mcp.request("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal(res.result.protocolVersion, "2025-06-18");
  } finally {
    await mcp.stop();
    api.close();
  }
});

test("tools/list advertises exactly the six-tool surface", async () => {
  const api = await setupApi();
  const mcp = startMcp({ DSH_MNEME_URL: api.base, DSH_MNEME_TOKEN: api.token });
  try {
    await initialize(mcp);
    const res = await mcp.request("tools/list");
    assert.deepEqual(
      res.result.tools.map((t) => t.name),
      ["memory_save", "memory_search", "memory_list", "memory_get", "memory_update", "memory_delete"]
    );
    for (const tool of res.result.tools) {
      assert.ok(tool.description, `${tool.name} has a description`);
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(tool.inputSchema.properties, `${tool.name} declares properties`);
    }
  } finally {
    await mcp.stop();
    api.close();
  }
});

test("unknown tool → -32602; unknown method → -32601", async () => {
  const api = await setupApi();
  const mcp = startMcp({ DSH_MNEME_URL: api.base, DSH_MNEME_TOKEN: api.token });
  try {
    await initialize(mcp);
    const unknownTool = await mcp.request("tools/call", { name: "memory_explode", arguments: {} });
    assert.equal(unknownTool.error.code, -32602);
    const unknownMethod = await mcp.request("prompts/list");
    assert.equal(unknownMethod.error.code, -32601);
  } finally {
    await mcp.stop();
    api.close();
  }
});

test("malformed JSON line answers -32700 with null id", async () => {
  const api = await setupApi();
  const mcp = startMcp({ DSH_MNEME_URL: api.base, DSH_MNEME_TOKEN: api.token });
  try {
    const parseError = new Promise((resolve) => {
      const off = mcp.onMessage((msg) => {
        if (msg.id === null && msg.error?.code === -32700) {
          off();
          resolve(msg);
        }
      });
      mcp.child.stdin.write("this is not json\n");
    });
    const msg = await parseError;
    assert.equal(msg.error.code, -32700);
    assert.equal(msg.id, null);

    // 合法 JSON 但不是有效请求（{}、数组）：-32600 Invalid Request，取不到 id 用 null。
    const invalidRequest = new Promise((resolve) => {
      const off = mcp.onMessage((msg2) => {
        if (msg2.error?.code === -32600) {
          off();
          resolve(msg2);
        }
      });
      mcp.child.stdin.write("{}\n");
    });
    const invalid = await invalidRequest;
    assert.equal(invalid.error.code, -32600);
    assert.equal(invalid.id, null);
  } finally {
    await mcp.stop();
    api.close();
  }
});

// --- 工具生命周期 -------------------------------------------------------------

test("six-tool lifecycle over the API: save/merge/search/get/update/list/delete", async () => {
  const api = await setupApi();
  const mcp = startMcp({ DSH_MNEME_URL: api.base, DSH_MNEME_TOKEN: api.token });
  try {
    await initialize(mcp);

    const save = await mcp.request("tools/call", {
      name: "memory_save",
      arguments: { type: "preference", title: "交流语言", content: "始终用中文回复", importance: 4, tags: ["交流"] }
    });
    assert.ok(!save.result.isError, `save succeeds: ${textOf(save)}`);
    assert.match(textOf(save), /^memory created: /);
    const id = textOf(save).replace(/^memory created: /, "").trim();

    const merge = await mcp.request("tools/call", {
      name: "memory_save",
      arguments: { type: "preference", title: "交流语言", content: "始终用简体中文回复" }
    });
    assert.match(textOf(merge), /^memory merged: /);

    const search = await mcp.request("tools/call", { name: "memory_search", arguments: { query: "中文回复" } });
    assert.match(textOf(search), /^Found 1 memory entry:/, "dedupe leaves one entry");
    assert.match(textOf(search), /ID: /);

    const got = await mcp.request("tools/call", { name: "memory_get", arguments: { id } });
    assert.ok(!got.result.isError);
    assert.match(textOf(got), /^交流语言\nID: /);
    assert.ok(textOf(got).includes("始终用简体中文回复"), "get returns the merged content");

    const update = await mcp.request("tools/call", {
      name: "memory_update",
      arguments: { id, content: "始终用简体中文回复（含标点）", reason: "用户补充" }
    });
    assert.match(textOf(update), /^Updated memory /);

    const list = await mcp.request("tools/call", { name: "memory_list", arguments: { type: "preference" } });
    assert.match(textOf(list), /^1 memory entries \(of 1\):/);

    const del = await mcp.request("tools/call", { name: "memory_delete", arguments: { id } });
    assert.equal(textOf(del), "Memory deleted.");
    const delAgain = await mcp.request("tools/call", { name: "memory_delete", arguments: { id } });
    assert.equal(textOf(delAgain), "Memory not found.", "missing delete mirrors the DSH deleted=false path");
  } finally {
    await mcp.stop();
    api.close();
  }
});

test("memory_get unknown id → isError 'memory not found' (no existence leak)", async () => {
  const api = await setupApi();
  const mcp = startMcp({ DSH_MNEME_URL: api.base, DSH_MNEME_TOKEN: api.token });
  try {
    await initialize(mcp);
    const res = await mcp.request("tools/call", { name: "memory_get", arguments: { id: "no-such-id" } });
    assert.equal(res.result.isError, true);
    assert.equal(textOf(res), "memory not found");
  } finally {
    await mcp.stop();
    api.close();
  }
});

test("wrong token → isError with the unauthorized hint", async () => {
  const api = await setupApi();
  const mcp = startMcp({ DSH_MNEME_URL: api.base, DSH_MNEME_TOKEN: fakeToken("wrong") });
  try {
    await initialize(mcp);
    const res = await mcp.request("tools/call", {
      name: "memory_save",
      arguments: { type: "preference", title: "t", content: "c" }
    });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res), /^unauthorized:/);
  } finally {
    await mcp.stop();
    api.close();
  }
});

test("list include_archived surfaces archived rows through the MCP tool", async () => {
  const api = await setupApi();
  const mcp = startMcp({ DSH_MNEME_URL: api.base, DSH_MNEME_TOKEN: api.token });
  try {
    await initialize(mcp);
    const save = await mcp.request("tools/call", {
      name: "memory_save",
      arguments: { type: "history", title: "会被归档", content: "c" }
    });
    const id = textOf(save).replace(/^memory created: /, "").trim();
    api.service.setArchived(id, true);

    const active = await mcp.request("tools/call", { name: "memory_list", arguments: {} });
    assert.match(textOf(active), /^0 memory entries \(of 0\)\./);
    const archived = await mcp.request("tools/call", { name: "memory_list", arguments: { include_archived: true } });
    assert.match(textOf(archived), /^1 memory entries \(of 1\):/);
  } finally {
    await mcp.stop();
    api.close();
  }
});

// --- 平价锁漂移：MCP_TOOLS 与 src/tools.js 六件套逐字对齐 -----------------------

test("MCP tool surface stays in lockstep with src/tools.js (name/description/params)", () => {
  const registered = [];
  const ctx = { tools: { register: (tool) => registered.push(tool) }, logger: { warn() {} } };
  const store = createStore(":memory:");
  try {
    const service = createService({ store, mirror: null, config: {} });
    createTools(ctx, service, {}, null);
  } finally {
    store.close();
  }
  const dshTools = new Map(registered.map((t) => [t.name, t]));
  const SIX = ["memory_save", "memory_search", "memory_list", "memory_get", "memory_update", "memory_delete"];
  assert.deepEqual(MCP_TOOLS.map((t) => t.name), SIX, "MCP exposes exactly the six-tool surface in order");

  for (const mcpTool of MCP_TOOLS) {
    const dsh = dshTools.get(mcpTool.name);
    assert.ok(dsh, `${mcpTool.name} exists in src/tools.js`);
    assert.equal(mcpTool.description, dsh.description, `${mcpTool.name} description verbatim`);

    // defineTool 产出 JSON Schema 形状（{type, properties, required}）。
    const dshSchema = dsh.parameters ?? {};
    const dshProps = dshSchema.properties ?? {};
    const dshRequired = Array.isArray(dshSchema.required) ? dshSchema.required : [];
    assert.deepEqual(
      Object.keys(mcpTool.inputSchema.properties).sort(),
      Object.keys(dshProps).sort(),
      `${mcpTool.name} parameter keys match`
    );
    for (const [key, mcpProp] of Object.entries(mcpTool.inputSchema.properties)) {
      const dshProp = dshProps[key];
      assert.ok(dshProp, `${mcpTool.name}.${key} exists on the DSH side`);
      assert.equal(mcpProp.type, dshProp.type, `${mcpTool.name}.${key} type`);
      if (dshProp.enum) assert.deepEqual(mcpProp.enum, dshProp.enum, `${mcpTool.name}.${key} enum`);
      if (dshProp.items) assert.deepEqual(mcpProp.items, dshProp.items, `${mcpTool.name}.${key} items`);
      assert.equal(
        mcpTool.inputSchema.required.includes(key),
        dshRequired.includes(key),
        `${mcpTool.name}.${key} required-ness`
      );
    }
  }
});

// --- 配置解析 -----------------------------------------------------------------

test("resolveMcpConfig: env beats cli.json beats defaults", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-mneme-mcp-"));
  try {
    const configPath = path.join(dir, "cli.json");
    await writeFile(configPath, JSON.stringify({ url: "http://127.0.0.1:9999", token: FILE_TOKEN }), "utf8");

    const fromFile = resolveMcpConfig({}, configPath);
    assert.equal(fromFile.url, "http://127.0.0.1:9999");
    assert.equal(fromFile.token, FILE_TOKEN);

    const fromEnv = resolveMcpConfig({ DSH_MNEME_URL: "http://127.0.0.1:7001/", DSH_MNEME_TOKEN: ENV_TOKEN }, configPath);
    assert.equal(fromEnv.url, "http://127.0.0.1:7001", "env wins; trailing slash trimmed");
    assert.equal(fromEnv.token, ENV_TOKEN);

    const defaults = resolveMcpConfig({}, path.join(dir, "missing.json"));
    assert.equal(defaults.url, "http://127.0.0.1:8790");
    assert.equal(defaults.token, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
