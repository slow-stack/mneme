import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { fakeToken } from "./helpers/fake-auth-values.js";

// serve bin 冒烟 + 多进程共存锁(daemon 唯一的真新风险点):daemon 子进程与测试进程
// 同时打开同一 memory.db(WAL + busy_timeout 本就为此设计),互写互读。spawn 必须
// 异步(maintenance.test.js 的教训:同步 spawn 会堵住本进程事件循环);Windows 下
// child.kill() 是硬终止,不断言信号路径,只断言可达性与退出。

const BIN = fileURLToPath(new URL("../bin/dsh-mneme-serve.mjs", import.meta.url));

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
    await wait(150);
  }
  throw new Error(`timeout waiting for ${what}: ${lastErr?.message ?? lastErr}`);
}

test("serve bin: 值旗标缺值直接报错退出(--port 后无值不能落成 Number(true)=1)", { timeout: 30000 }, async () => {
  // CodeRabbit on #364:--port 紧跟另一个旗标或结束时,旧解析把它存成 true,
  // Number(true)=1 通过校验 → 静默改绑端口 1(EACCES 误导排错方向)。
  const child = spawn(process.execPath, [BIN, "--memory-dir", mkdtempSync(join(tmpdir(), "mneme-serve-arg-")), "--port"], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const [code] = await new Promise((resolve) => {
    child.on("exit", (c) => resolve([c]));
  });
  assert.notEqual(code, 0, "missing value must exit non-zero");
  assert.ok(stderr.includes("缺少参数值"), `stderr should name the missing value, got: ${stderr.slice(-200)}`);
});

test("serve bin: spawn 冒烟;daemon 与宿主进程同库互写互读", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mneme-serve-bin-"));

  // 预置 token:测试进程先开一次库写进 kv external_api,daemon 复用之 —— 同时验证
  // 「与宿主面板/CLI 共用同一凭证」这条零配置承诺在真子进程里成立。
  const seedStore = createStore(join(dir, "memory.db"));
  const seedSettings = createSettings(seedStore.db);
  const TOKEN = fakeToken("serve-bin");
  seedSettings.setExternalApi({ token: TOKEN });
  const peer = createService({ store: seedStore, mirror: null, config: {} });
  peer.saveWithDedupe({ type: "project", title: "peer 进程直写", content: "测试进程经 createStore 写入", importance: 3 });

  // --embed off:CI 无 runtime payload,绝不能触发取件;多进程共存与语义无关
  const child = spawn(process.execPath, [BIN, "--memory-dir", dir, "--port", "0", "--embed", "off"], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });

  try {
    // stdout 唯一机器可读行:listening 行(解析实际端口)
    await waitFor(() => {
      if (child.exitCode !== null) {
        throw new Error(`daemon exited early (code ${child.exitCode}): ${stderr.slice(-400)}`);
      }
      if (!stdout.includes("listening on http://")) throw new Error("no listening line yet");
      return true;
    }, 20000, "listening line");
    const port = Number(stdout.match(/:(\d+)/)[1]);
    const base = `http://127.0.0.1:${port}`;
    const auth = { authorization: `Bearer ${TOKEN}` };

    await waitFor(async () => {
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 200);
      return true;
    }, 10000, "daemon /health");

    // 双向可见性 ①:测试进程直写 → daemon HTTP 检索可见
    await waitFor(async () => {
      const res = await fetch(`${base}/search?q=${encodeURIComponent("peer 进程直写")}`, { headers: auth });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok((body.items ?? []).some((m) => m.title === "peer 进程直写"));
      return true;
    }, 10000, "peer write visible via daemon");

    // 双向可见性 ②:daemon HTTP 写 → 测试进程 service 同步检索可见
    const save = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "project", title: "daemon HTTP 写入", content: "serve 进程经数据面写入", importance: 3 })
    });
    assert.ok(save.status === 201 || save.status === 200, `daemon save status ${save.status}`);
    assert.ok(
      peer.search("daemon HTTP 写入", { limit: 5 }).some((m) => m.title === "daemon HTTP 写入"),
      "daemon-side write must be visible to the other process immediately"
    );
  } finally {
    child.kill();
    await new Promise((r) => {
      if (child.exitCode !== null) r();
      else child.on("exit", r);
    });
    try { seedStore.close(); } catch { /* 同上 */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* win 文件锁偶发,残留临时目录无害 */ }
  }
});
