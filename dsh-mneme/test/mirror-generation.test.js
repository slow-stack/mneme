import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../src/store.js";
import { createMirror } from "../src/mirror.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";
import { fakeToken } from "./helpers/fake-auth-values.js";

/**
 * v0.3.6 回归测试（audit peer 4 类阻断）。
 *
 * 覆盖（测试点由 Kimi K2.7 设计）：
 *  A. 崩溃窗口：DB 已提交但 dirty 状态未写（generation > applied 且 dirty=false）→
 *     recoverMirror 仍能捕获并收敛
 *  B. markMirrorDirty 自身失败 fail-safe：状态写失败不抛，generation 债务仍在，
 *     recoverMirror 仍能捕获
 *  C. 全局状态 / 双 worker 交织：旧 gen 的 markMirrorCleanForGeneration 不能清新故障
 *  D. 逐 type 部分成功：setTypeStatus 记录/合并/收敛
 *  E. /health 鉴权 + 脱敏 + fail-closed
 *  F. 迁移幂等：旧库打开自动加列不丢数据
 */

const MIRROR_ERR = "No space left on device";

function setup({ dbPath } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-gen-"));
  const mirrorDir = join(dir, "mirror");
  const store = createStore(dbPath ?? ":memory:");
  const mirror = createMirror(mirrorDir);
  const warns = [];
  const logger = { warn: (...a) => warns.push(a.join(" ")) };
  const service = createService({ store, mirror, config: {}, logger });
  return { dir, mirrorDir, store, mirror, service, warns };
}

function makeSyncMock() {
  const state = { mode: "ok", calls: 0 };
  state.sync = () => {
    state.calls += 1;
    if (state.mode === "fail") {
      const err = new Error(MIRROR_ERR);
      err.code = "ENOSPC";
      throw err;
    }
  };
  return state;
}

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function healthRouteSetup(store, service, apiToken = "") {
  const settings = createSettings(store.db);
  const commands = {
    add: (def) => settings.addCommand(def),
    remove: (id) => settings.removeCommand(id),
    list: () => settings.listCommands()
  };
  const routes = [];
  const ctx = {
    webServer: { register(route) { routes.push(route); return () => {}; } }
  };
  createApi(ctx, service, settings, commands, undefined, undefined, apiToken);
  const health = routes.find((r) => r.path === "/api/dsh-mneme/health");
  assert.ok(health, "必须注册 /api/dsh-mneme/health");
  return health;
}

// ── C. 全局状态 / 双 worker 交织（store 层 CAS/fence）─────────────────────

test("V0.3.6-C1: 双 worker 交织——旧 gen 的 markMirrorCleanForGeneration 被 fence 拦截，不能清新故障", () => {
  const { dir, store } = setup();
  try {
    // 初始干净：gen=2 已 applied
    store.setMirrorState({ dirty: 0, generation: 2, applied_generation: 2 });
    // worker B 随后失败 → 新债务：desired 前进到 3
    store.markMirrorDirty("ENOSPC: disk full", "t1");
    assert.equal(store.getMirrorState().generation, 3, "失败必须递增 desired generation");

    // worker A（旧 gen=2）晚到的 clean：必须被 fence 拦截
    const afterStale = store.markMirrorCleanForGeneration(2, "t2");
    assert.equal(afterStale.dirty, true, "旧 gen 的 CAS 必须被 fence 拦截，dirty 不能清");
    assert.equal(afterStale.last_error, "ENOSPC: disk full", "新故障的 last_error 必须保留");
    assert.equal(afterStale.applied_generation, 2, "applied 最多追到旧 gen=2");
    assert.equal(afterStale.generation, 3, "desired 仍是 3");

    // 当前 gen 的 clean 才允许通过
    const afterFresh = store.markMirrorCleanForGeneration(3, "t3");
    assert.equal(afterFresh.dirty, false, "当前 gen 的 clean 必须通过");
    assert.equal(afterFresh.last_error, null);
    assert.ok(afterFresh.success_at, "clean 必须更新 success_at");
    assert.equal(afterFresh.applied_generation, 3);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("V0.3.6-C2: markMirrorDirty 递增 desired generation，applied_generation 不动", () => {
  const { dir, store } = setup();
  try {
    const s1 = store.markMirrorDirty("boom", "t1");
    assert.equal(s1.dirty, true);
    assert.equal(s1.generation, 1);
    assert.equal(s1.applied_generation, 0, "失败不得误标 applied");
    assert.equal(s1.last_error, "boom");
    assert.ok(s1.last_attempt, "必须记录 last_attempt");

    const s2 = store.markMirrorDirty("boom2", "t2");
    assert.equal(s2.generation, 2, "连续失败必须递增 desired");
    assert.equal(s2.applied_generation, 0);
    assert.equal(s2.last_error, "boom2");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("V0.3.6-C3: incrementGeneration 每次 +1，不动 dirty/applied", () => {
  const { dir, store } = setup();
  try {
    assert.equal(store.incrementGeneration().generation, 1);
    assert.equal(store.incrementGeneration().generation, 2);
    assert.equal(store.incrementGeneration().generation, 3);
    const state = store.getMirrorState();
    assert.equal(state.applied_generation, 0, "increment 不动 applied");
    assert.equal(state.dirty, false, "increment 不改 dirty");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── D. 逐 type 部分成功（store 层 setTypeStatus）──────────────────────────

test("V0.3.6-D1: setTypeStatus 记录逐 type committed/failed/pending 回执（peer blocker 4）", () => {
  const { dir, store } = setup();
  try {
    // 状态必填且必须合法
    assert.throws(() => store.setTypeStatus("project", { applied_gen: 1 }), /status must be one of/, "缺 status 必须抛错");
    assert.throws(() => store.setTypeStatus("project", { status: "bogus" }), /status must be one of/, "非法 status 必须抛错");

    const s1 = store.setTypeStatus("project", { status: "failed", last_error: "e1" });
    assert.equal(s1.type_status.project.status, "failed");
    assert.equal(s1.type_status.project.last_error, "e1");

    const s2 = store.setTypeStatus("project", { status: "committed", applied_gen: 7, last_error: null });
    assert.equal(s2.type_status.project.status, "committed", "同 type 状态更新");
    assert.equal(s2.type_status.project.applied_gen, 7);

    const s3 = store.setTypeStatus("decision", { status: "pending" });
    assert.equal(s3.type_status.decision.status, "pending", "另一 type 独立");
    assert.equal(s3.type_status.project.status, "committed", "同 type 不受影响");

    // getTypeStatus 返回同一解析后的 map
    assert.deepEqual(store.getTypeStatus(), {
      project: { status: "committed", applied_gen: 7, last_error: null },
      decision: { status: "pending" }
    });
    // type_status 持久化为 JSON 文本
    const row = store.db.prepare("SELECT type_status FROM mirror_state WHERE id='main'").get();
    assert.ok(JSON.parse(row.type_status).project.status === "committed", "type_status 必须以 JSON 落库");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── A. 崩溃窗口（service 层 recoverMirror）────────────────────────────────

test("V0.3.6-A1: 崩溃窗口——generation>applied 且 dirty=false（DB 已提交但 dirty 未写）recoverMirror 仍恢复", () => {
  const { dir, store, mirror, service } = setup();
  try {
    const mock = makeSyncMock();
    mirror.sync = mock.sync;
    // 构造崩溃窗口：COMMIT 后、markMirrorDirty/clean 前进程退出
    store.setMirrorState({ dirty: 0, generation: 5, applied_generation: 3 });
    assert.equal(store.getMirrorState().dirty, false, "前置：dirty 未写");

    const result = service.recoverMirror();
    assert.equal(result.recovered, true, "崩溃窗口也必须判定恢复");
    assert.equal(result.error, null);
    assert.equal(mock.calls, 1, "恰好重渲染一次后收敛");
    const state = store.getMirrorState();
    assert.equal(state.dirty, false, "收敛后 dirty 清");
    assert.ok(state.generation <= state.applied_generation, "收敛后无未应用债务");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("V0.3.6-A2: 干净且无未应用债务（generation<=applied）不触发 sync", () => {
  const { dir, store, mirror, service } = setup();
  try {
    const mock = makeSyncMock();
    mirror.sync = mock.sync;
    store.setMirrorState({ dirty: 0, generation: 2, applied_generation: 5 });
    const result = service.recoverMirror();
    assert.equal(result.recovered, true);
    assert.equal(result.error, null);
    assert.equal(mock.calls, 0, "无债务不得触发任何 sync");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── B. markMirrorDirty 自身失败 fail-safe ─────────────────────────────────

test("V0.3.6-B1: markMirrorDirty 自身写失败——syncMirror 不抛、generation 债务仍在、recoverMirror 仍能捕获", () => {
  const { dir, store, mirror, service, warns } = setup();
  try {
    const mock = makeSyncMock();
    mirror.sync = mock.sync;
    mock.mode = "fail";

    // 模拟状态写入挂掉：markMirrorDirty 抛错
    const original = store.markMirrorDirty.bind(store);
    store.markMirrorDirty = () => { throw new Error("db closed"); };
    try {
      assert.doesNotThrow(
        () => service.saveWithDedupe({ type: "project", title: "fail-safe", content: "x", importance: 3 }),
        "markMirrorDirty 失败不得让 syncMirror/saveWithDedupe 向外抛"
      );
      assert.ok(warns.some((w) => w.includes("markMirrorDirty failed")), "必须走 logger.warn 记录");
      const state = store.getMirrorState();
      assert.equal(state.dirty, false, "markMirrorDirty 写失败时 dirty 落不了库");
      assert.ok(state.generation > state.applied_generation,
        "incrementGeneration 的 generation 债务仍在，是 durable 的恢复信号");
      assert.equal(store.count(), 1, "业务写不受状态写失败影响");
    } finally {
      store.markMirrorDirty = original;
    }

    // 恢复写能力后，recoverMirror 仅凭 generation>applied 也能捕获并收敛
    mock.mode = "ok";
    const result = service.recoverMirror();
    assert.equal(result.recovered, true, "generation 债务必须能被 recover 捕获");
    const finalState = store.getMirrorState();
    assert.equal(finalState.dirty, false);
    assert.ok(finalState.generation <= finalState.applied_generation, "收敛后无债务");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── D. 逐 type 部分成功（service 层 type_status 生命周期）─────────────────

test("V0.3.6-D2: syncMirror 成功时逐 type 记录 committed（applied_gen=gen）", () => {
  const { dir, store, mirror, service } = setup();
  try {
    const mock = makeSyncMock();
    mirror.sync = mock.sync;
    service.saveWithDedupe({ type: "project", title: "P", content: "x", importance: 3 });
    const ts = store.getTypeStatus();
    assert.ok(ts.project, "覆盖的 type 必须记录 type_status");
    assert.equal(ts.project.status, "committed");
    assert.equal(ts.project.last_error, null);
    assert.equal(ts.project.applied_gen, store.getMirrorState().applied_generation,
      "type_status.applied_gen 与全局 applied 一致");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("V0.3.6-D3: syncMirror 失败时逐 type 记录 failed，recoverMirror 后追到最新 applied", () => {
  const { dir, store, mirror, service } = setup();
  try {
    const mock = makeSyncMock();
    mirror.sync = mock.sync;
    // 第一次成功建立 committed type_status
    mock.mode = "ok";
    service.saveWithDedupe({ type: "project", title: "P", content: "x", importance: 3 });
    assert.equal(store.getTypeStatus().project.status, "committed");

    // 模拟一次"债务轮次"：incrementGeneration 但未成功 applied（崩溃在 type_status 层面）
    store.incrementGeneration();
    const state = store.getMirrorState();
    assert.ok(state.generation > state.applied_generation, "前置：存在未应用债务");

    const result = service.recoverMirror();
    assert.equal(result.recovered, true);
    const finalState = store.getMirrorState();
    assert.ok(finalState.generation <= finalState.applied_generation);
    const ts = store.getTypeStatus();
    assert.equal(ts.project.applied_gen, finalState.applied_generation,
      "type_status 必须追到最新 applied（部分成功债务表达并收敛）");
    assert.equal(ts.project.status, "committed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── E. /health 鉴权 + 脱敏 + fail-closed ──────────────────────────────────

test("V0.3.6-E1: apiToken 设置后未鉴权访问 /health 返回 401，正确 token 才放行", () => {
  const { dir, store, mirror, service } = setup();
  try {
    const TOKEN = fakeToken("mirror");
    const health = healthRouteSetup(store, service, TOKEN);
    const res401 = new FakeRes();
    health.handler({ url: "/api/dsh-mneme/health", method: "GET", headers: {} }, res401);
    assert.equal(res401.statusCode, 401, "无 token 必须 401");
    assert.deepEqual(JSON.parse(res401.body), { error: "unauthorized" }, "不得回显任何内部信息");

    const resWrong = new FakeRes();
    health.handler({ url: "/api/dsh-mneme/health", method: "GET", headers: { authorization: "Bearer wrong-token" } }, resWrong);
    assert.equal(resWrong.statusCode, 401, "错误 token 必须 401");

    const resOk = new FakeRes();
    health.handler({ url: "/api/dsh-mneme/health", method: "GET", headers: { authorization: `Bearer ${TOKEN}` } }, resOk);
    assert.equal(resOk.statusCode, 200, "正确 Bearer token 必须放行");

    const resHeader = new FakeRes();
    health.handler({ url: "/api/dsh-mneme/health", method: "GET", headers: { "x-dsh-mneme-token": TOKEN } }, resHeader);
    assert.equal(resHeader.statusCode, 200, "x-dsh-mneme-token 也必须放行");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("V0.3.6-E2: 未配置 apiToken 时 /health 免鉴权（向后兼容）", () => {
  const { dir, store, mirror, service } = setup();
  try {
    const health = healthRouteSetup(store, service, "");
    const res = new FakeRes();
    health.handler({ url: "/api/dsh-mneme/health", method: "GET", headers: {} }, res);
    assert.equal(res.statusCode, 200, "未配置 token 必须免鉴权");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("V0.3.6-E3: /health 只返回脱敏错误码（no-space/permission/sync-failed），不回显原始 last_error", () => {
  const { dir, store, mirror, service } = setup();
  try {
    const health = healthRouteSetup(store, service, "");
    const cases = [
      { error: "No space left on device", expect: "no-space" },
      { error: "EACCES: permission denied", expect: "permission" },
      { error: "sync exploded with internals", expect: "sync-failed" }
    ];
    for (const { error, expect } of cases) {
      store.setMirrorState({ dirty: 1, last_error: error, last_attempt: "t" });
      const res = new FakeRes();
      health.handler({ url: "/api/dsh-mneme/health", method: "GET", headers: {} }, res);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.mirror.dirty, true);
      assert.equal(body.mirror.status, "degraded");
      assert.equal(body.mirror.last_error, expect, `${error} 必须映射为 ${expect}`);
      const raw = JSON.stringify(body);
      assert.ok(!raw.includes(error.split(":")[0]), `原始错误不得出现在响应: ${error}`);
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("V0.3.6-E4: /health 读失败 fail-closed → status:unknown、dirty:null，不误报 clean", () => {
  const { dir, store, mirror, service } = setup();
  try {
    const health = healthRouteSetup(store, service, "");
    const original = service.getMirrorHealth.bind(service);

    // 抛错 → fail-closed unknown
    service.getMirrorHealth = () => { const e = new Error("SQLITE_CORRUPT"); throw e; };
    const resThrow = new FakeRes();
    health.handler({ url: "/api/dsh-mneme/health", method: "GET", headers: {} }, resThrow);
    assert.equal(resThrow.statusCode, 200);
    const bodyThrow = JSON.parse(resThrow.body);
    assert.equal(bodyThrow.mirror.status, "unknown", "读失败必须 status:unknown");
    assert.equal(bodyThrow.mirror.dirty, null, "读失败必须 dirty:null（不得谎报 clean）");
    assert.equal(bodyThrow.mirror.last_error, null);
    assert.ok(!JSON.stringify(bodyThrow).includes("SQLITE_CORRUPT"), "异常详情不得泄漏");

    // 返回 null → fail-closed unknown
    service.getMirrorHealth = () => null;
    const resNull = new FakeRes();
    health.handler({ url: "/api/dsh-mneme/health", method: "GET", headers: {} }, resNull);
    assert.equal(JSON.parse(resNull.body).mirror.status, "unknown");
    assert.equal(JSON.parse(resNull.body).mirror.dirty, null);
    service.getMirrorHealth = original;
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── F. 迁移幂等 ───────────────────────────────────────────────────────────

test("V0.3.6-F1: 旧库（v0.3.5 5 列）打开自动 ALTER 加 3 列，不丢数据，重复打开幂等", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-gen-"));
  const dbPath = join(dir, "memory.db");
  try {
    // 用裸 DatabaseSync 构造 v0.3.5 时代的旧库（mirror_state 只有 5 列）
    const old = new DatabaseSync(dbPath);
    old.exec(`
      CREATE TABLE mirror_state (
        id TEXT PRIMARY KEY,
        dirty INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_attempt TEXT,
        success_at TEXT
      );
      INSERT INTO mirror_state (id, dirty, last_error, last_attempt) VALUES ('main', 1, 'old error', 'old attempt');
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]', importance INTEGER NOT NULL DEFAULT 3, forgotten INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0, source TEXT, embedding TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO memories (id, type, title, content, tags, importance, forgotten, archived, created_at, updated_at)
        VALUES ('m1', 'project', '老数据', '必须保留', '[]', 3, 0, 0, 't', 't');
    `);
    old.close();

    let store = createStore(dbPath);
    const cols = store.db.prepare("PRAGMA table_info(mirror_state)").all().map((c) => c.name);
    assert.deepEqual(cols.sort(),
      ["applied_generation", "dirty", "generation", "id", "last_attempt", "last_error", "success_at", "type_status"],
      "旧库打开必须自动补齐 3 列");
    const state = store.getMirrorState();
    assert.equal(state.dirty, true, "旧 dirty 数据必须保留");
    assert.equal(state.last_error, "old error", "旧 last_error 必须保留");
    assert.equal(state.last_attempt, "old attempt", "旧 last_attempt 必须保留");
    assert.equal(state.generation, 0, "新列默认 0");
    assert.equal(state.applied_generation, 0);
    assert.deepEqual(state.type_status, {}, "新列默认空对象");
    assert.equal(store.count(), 1, "memories 数据必须保留");
    assert.equal(store.getById("m1").title, "老数据");

    // 重复打开幂等：不抛、列不变、数据不变
    store.close();
    store = createStore(dbPath);
    const cols2 = store.db.prepare("PRAGMA table_info(mirror_state)").all().map((c) => c.name);
    assert.deepEqual(cols2.sort(),
      ["applied_generation", "dirty", "generation", "id", "last_attempt", "last_error", "success_at", "type_status"],
      "重复打开不重复加列");
    assert.equal(store.getMirrorState().last_error, "old error", "重复打开不丢数据");
    assert.equal(store.count(), 1);

    // 新方法在迁移后的库上正常工作
    const clean = store.markMirrorCleanForGeneration(0, "t");
    assert.equal(clean.dirty, false, "迁移库上 fence clean 正常工作");
    store.setTypeStatus("project", { status: "failed", applied_gen: 0 });
    assert.equal(store.getTypeStatus().project.status, "failed", "迁移库上 setTypeStatus 正常工作");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v0.3.9-D: mirror 逐 type 物理终态——兄弟 type 失败不误标已提交 type", () => {
  const { dir, store, mirror, service } = setup();
  try {
    // 注入逐 type 故障：project 写成功、decision 抛错（模拟 EISDIR），其余 type 正常。
    // 对应审计 D：project 文件已物理提交、decision 失败，状态必须逐 type 记录——
    // 不能像旧逻辑那样整体批量标 failed。
    const original = mirror.sync.bind(mirror);
    mirror.sync = (memories) => {
      const results = original(memories);
      results.decision = { ok: false, error: "EISDIR: decision.md is a directory" };
      return results;
    };
    // project 与 decision 都有真实记忆 → 触发逐 type 渲染
    store.save({ id: "mem-project", type: "project", title: "已提交", content: "物理写入", importance: 3, tags: [] });
    store.save({ id: "mem-decision", type: "decision", title: "写失败", content: "此 type 失败", importance: 3, tags: [] });
    // 直接调 service 内部 syncMirror（通过一次写触发）
    service.saveWithDedupe({ type: "project", title: "触发", content: "sync", importance: 3 });

    const ts = store.getTypeStatus();
    // project 物理提交 → 必须 committed，不能被 decision 失败拖成 failed
    assert.equal(ts.project.status, "committed", "物理已提交的 type 必须标记 committed");
    assert.equal(ts.decision.status, "failed", "失败的 type 必须标记 failed");
    // 部分失败 = 未完全收敛 → dirty 必须持久
    assert.equal(store.getMirrorState().dirty, true, "部分 type 失败必须持久 dirty");
    // 镜像里 project 文件真实存在（物理终态已落地，不是整体失败）
    const projectFile = mirror.filePath("project");
    assert.ok(existsSync(projectFile), "project 镜像文件必须已物理写入");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
