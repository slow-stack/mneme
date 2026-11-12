import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";
import { FAKE_API_TOKEN } from "./helpers/fake-auth-values.js";

// /api/dsh-mneme/nudge 的接线锁。三件事分开守，因为它们混在一起时各自的失败长得一样：
//   1. policy 是 token-write —— GET 免 token（面板每刷一次就 GET 一次），POST 要 token（会写盘）；
//   2. 「读不到」与「确实没有」必须回不同状态码（503 vs 200），否则故障会被当成答案；
//   3. GET 是预览、不许落盘 —— 这一条是接线时发现真 bug 的地方：nudgeFromSessions
//      原先只要算得出项目键就无条件写提议，而面板刷新一次就是一次 GET。

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "mneme-nudge-route-"));
}

async function withDir(fn) {
  const dir = tmpDir();
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 一行会话日志，形状照 DSH 会话文件：data.message.content[] 里是 tool-call。 */
function sessionLine(calls) {
  const content = calls.map((c) => ({ type: "tool-call", name: c.name, arguments: JSON.stringify(c.args || {}) }));
  return JSON.stringify({ time: 1700000000000, data: { turn: 1, message: { content } } });
}

/** 造一份会话日志：sessions/<桶>/<会话>/session.v4.jsonl.zstd，头行带 cwd。 */
function writeSession(dshHome, { bucket, sessionId, cwd, calls }) {
  const sub = join(dshHome, "sessions", bucket, sessionId);
  mkdirSync(sub, { recursive: true });
  const head = JSON.stringify({ time: 1700000000000, cwd });
  const body = sessionLine(calls);
  writeFileSync(join(sub, "session.v4.jsonl.zstd"), zlib.zstdCompressSync(Buffer.from([head, body].join("\n"), "utf8")));
}

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

/**
 * POST 分支返回的是「已排进微任务的 promise」，不是自己的 promise：handler 直接
 * `return;`（src/api.js:2069-2075）。所以拿到 FakeRes 不够，必须等它真的 end，
 * 否则断言跑在正文还没写之前——第一次写这个文件就是在这里被 200 !== 400 骗了。
 */
function awaitEnd(res) {
  return new Promise((resolve) => res.once("end", resolve));
}

function req(path, method = "GET", body = null, headers = {}) {
  const r = new EventEmitter();
  r.url = path;
  r.method = method;
  r.headers = headers;
  if (body !== null) {
    process.nextTick(() => {
      r.emit("data", Buffer.from(JSON.stringify(body)));
      r.emit("end");
    });
  }
  return r;
}

function setup({ apiToken = "", memoryDir = null } = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const commands = { add: () => {}, remove: () => {}, list: () => [] };
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, commands, null, undefined, apiToken, { memoryDir });
  const route = routes.find((r) => r.path === "/api/dsh-mneme/nudge");
  assert.ok(route, "路由没注册");
  return { route, store };
}

test("/nudge：policy 是 token-write —— GET 免 token，POST 要 token", async () => {
  const { route } = setup({ apiToken: FAKE_API_TOKEN });

  // GET 是预览（只读），与 /pipeline、/candidates 同级：不带 token 也要能读。
  // 面板每次展开 M.O. 都会 GET 一次，要 token 等于让预览永远 401。
  const get = new FakeRes();
  await route.handler(req("/api/dsh-mneme/nudge?project=relative"), get);
  assert.notEqual(get.statusCode, 401, "GET 不该要 token");

  // POST 会真写盘（落提议），一律受门控。没有这道闸，任何能打开面板的页面
  // 都能往记忆库里塞文件。
  const post = new FakeRes();
  await route.handler(req("/api/dsh-mneme/nudge?project=relative", "POST", {}), post);
  assert.equal(post.statusCode, 401);
  assert.equal(JSON.parse(post.body).error, "unauthorized");

  // 带 token 才放行到业务判断（这里 project 是相对路径，应当由业务层回 400）。
  const ok = new FakeRes();
  const okDone = awaitEnd(ok);
  route.handler(req("/api/dsh-mneme/nudge?project=relative", "POST", {}, { authorization: `Bearer ${FAKE_API_TOKEN}` }), ok);
  await okDone;
  assert.equal(ok.statusCode, 400);
});

test("/nudge：project 必须是绝对路径，相对路径拒掉而不是静默退成全局", async () => {
  // 与 /pipeline、/candidates 同一条规矩。忽略相对路径会静默退成「全局」，
  // 而全局看起来一切正常——那是最难查的一类错。
  return withDir((dir) => {
    const { route } = setup({ memoryDir: join(dir, "memory") });
    const res = new FakeRes();
    route.handler(req("/api/dsh-mneme/nudge?project=dsh-mneme", "GET"), res);
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, "project-not-absolute");
  });
});

test("/nudge：「读不到会话」回 503，「这个项目确实没有」回 200", async () => {
  // 两者在候选列表上都表现为空。混成一个状态码，调用方就只能瞎猜是「没东西」还是「坏了」。
  await withDir((dir) => {
    const projectRoot = join(dir, "proj");
    mkdirSync(projectRoot, { recursive: true });
    const { route } = setup({ memoryDir: join(dir, "memory") });

    const prev = process.env.DSH_HOME;
    // 会话根根本不存在 → 新机器 / 路径配错，是**环境问题**。
    process.env.DSH_HOME = join(dir, "home-missing");
    try {
      const broken = new FakeRes();
      route.handler(req("/api/dsh-mneme/nudge?project=" + encodeURIComponent(projectRoot), "GET"), broken);
      assert.equal(broken.statusCode, 503);
      const brokenDoc = JSON.parse(broken.body);
      assert.equal(brokenDoc.error, "nudge-sessions-unreadable");
      assert.equal(brokenDoc.skipped, true);
      assert.equal(brokenDoc.counts.candidates, 0);

      // 有一个桶，但 cwd 指向别处 → 关于这个项目的**答案**：它还没跑过会话。
      const home = join(dir, "home-other");
      writeSession(home, {
        bucket: "other-bucket",
        sessionId: "sess-x",
        cwd: join(dir, "somewhere-else"),
        calls: [{ name: "skill", args: { name: "alpha" } }]
      });
      process.env.DSH_HOME = home;
      const none = new FakeRes();
      route.handler(req("/api/dsh-mneme/nudge?project=" + encodeURIComponent(projectRoot), "GET"), none);
      assert.equal(none.statusCode, 200);
      const noneDoc = JSON.parse(none.body);
      assert.equal(noneDoc.skipped, true);
      assert.equal(noneDoc.skippedReason, "no-session-attribution");
      assert.equal(noneDoc.attribution.reason, "no-bucket");
      // 跳过与跑完必须是同一句边界话术（同一个 NUDGE_BOUNDARIES 常量）。
      assert.equal(noneDoc.boundaries.autoActivate, false);
      assert.equal(noneDoc.boundaries.writesOnlyDrafts, true);
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prev;
    }
  });
});

test("/nudge：GET 只预览不落盘，POST 才写提议；materialize 默认关", async () => {
  // 这条是接线时抓到的真 bug：nudgeFromSessions 原先只要算得出项目键就无条件
  // 写提议，而面板每刷一次就 GET 一次 —— 等于每刷新一次往记忆库塞一批文件。
  await withDir(async (dir) => {
    const projectRoot = join(dir, "proj");
    mkdirSync(projectRoot, { recursive: true });
    const memoryDir = join(dir, "memory");
    const dshHome = join(dir, "dsh-home");
    const calls = [
      { name: "skill", args: { name: "alpha" } },
      { name: "skill", args: { name: "beta" } },
      { name: "pwsh", args: { command: "npm test" } }
    ];
    writeSession(dshHome, { bucket: "ws-bucket", sessionId: "sess-a", cwd: projectRoot, calls });
    // 两个会话走同一段序列才够 NUDGE_MIN_SUPPORT=2（数的是会话，不是次数）。
    writeSession(dshHome, { bucket: "ws-bucket", sessionId: "sess-b", cwd: projectRoot, calls });

    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = dshHome;
    try {
      const { route } = setup({ memoryDir });

      const preview = new FakeRes();
      await route.handler(req("/api/dsh-mneme/nudge?project=" + encodeURIComponent(projectRoot), "GET"), preview);
      assert.equal(preview.statusCode, 200);
      const previewDoc = JSON.parse(preview.body);
      assert.equal(previewDoc.skipped, false);
      assert.equal(previewDoc.attribution.reason, "matched");
      assert.ok(previewDoc.counts.candidates >= 1, "真数据里必须挖得出候选");
      assert.equal(previewDoc.counts.savedProposals, 0, "预览不许落提议");
      assert.equal(existsSync(join(memoryDir, "proposals")), false);

      const real = new FakeRes();
      const realDone = awaitEnd(real);
      route.handler(req("/api/dsh-mneme/nudge?project=" + encodeURIComponent(projectRoot), "POST", {}), real);
      await realDone;
      assert.equal(real.statusCode, 200);
      const realDoc = JSON.parse(real.body);
      assert.equal(realDoc.counts.savedProposals, realDoc.counts.candidates);
      assert.ok(existsSync(realDoc.proposalsDir));
      // 落草稿是「往仓库里塞文件」，必须 body.materialize===true 才做；自动跑的
      // 默认语义就是不碰仓库，端点必须与它一致。
      assert.equal(realDoc.counts.draftsWritten, 0);
      assert.equal(existsSync(join(projectRoot, ".mneme", "pipelines")), false);
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prev;
    }
  });
});

test("/nudge：PATCH/DELETE 一律 405，绝不落进「不是 GET/HEAD 就算写」的分支", async () => {
  // 这条是从评审里捞出来的真洞：persistProposals 按「method !== GET && !== HEAD」算，
  // 而方法分流只拦 PUT/POST，于是带 token 的 PATCH/DELETE 会直落 run(null)、
  // 当成写动作往 memoryDir 里落提议——一个不需要 body 的静默写盘口，正好打在
  // 这个端点「GET 只预览、写动作一律要 POST」的卖点上。
  await withDir(async (dir) => {
    const projectRoot = join(dir, "proj");
    mkdirSync(projectRoot, { recursive: true });
    const memoryDir = join(dir, "memory");
    const dshHome = join(dir, "dsh-home");
    const calls = [
      { name: "skill", args: { name: "alpha" } },
      { name: "skill", args: { name: "beta" } }
    ];
    writeSession(dshHome, { bucket: "ws-bucket", sessionId: "sess-a", cwd: projectRoot, calls });
    writeSession(dshHome, { bucket: "ws-bucket", sessionId: "sess-b", cwd: projectRoot, calls });

    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = dshHome;
    try {
      const { route } = setup({ apiToken: FAKE_API_TOKEN, memoryDir });
      for (const verb of ["PATCH", "DELETE"]) {
        const res = new FakeRes();
        // 带合法 token：证明拦住它的是方法白名单，不是鉴权。
        await route.handler(req("/api/dsh-mneme/nudge?project=" + encodeURIComponent(projectRoot), verb, {}, { authorization: `Bearer ${FAKE_API_TOKEN}` }), res);
        assert.equal(res.statusCode, 405, verb + " 必须回 405");
        const doc = JSON.parse(res.body);
        assert.equal(doc.error, "method-not-allowed");
        assert.equal(doc.allow, "GET, HEAD, POST, PUT");
        assert.equal(res.headers?.Allow, "GET, HEAD, POST, PUT", "405 要带 Allow 头");
      }
      // 最硬的一条：这里必须**一个文件都没落**。只看状态码会漏掉「先写再报错」。
      assert.equal(existsSync(join(memoryDir, "proposals")), false, "PATCH/DELETE 不许落提议");
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prev;
    }
  });
});
