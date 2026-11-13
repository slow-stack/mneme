import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createMirror, TYPE_FILE } from "../src/mirror.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";
import { testConfig } from "./helpers/test-config.js";

/**
 * F-NEW-03 回归测试（mirror sync 持久 dirty 状态）。
 *
 * peer 要求最低修复门槛：
 *  ① 持久记录 mirror dirty/error/last_attempt（与 DB decision receipt 分离）
 *  ② 启动时检测 dirty 并安全重渲染（recoverMirror）
 *  ③ 有界重试（最多 3 次）或人工 reconcile
 *  ④ API/health 暴露状态，恢复后清 dirty
 *  ⑤ 持续失败 → 关闭重开 → 恢复写能力后无需业务写即收敛的真实回归
 *
 * 测试点由 Kimi K2.7 设计。
 */

const MIRROR_ERR = "No space left on device";

function mirrorPath(dir, type) {
  return join(dir, TYPE_FILE[type]);
}

/**
 * 可切换失败/成功的 mirror.sync 桩，带调用计数。
 * mode: "ok" | "fail"。fail 时抛 code=ENOSPC 的 Error。
 */
function makeSyncMock() {
  const state = { mode: "ok", calls: 0, syncCounts: { total: 0 } };
  state.sync = () => {
    state.calls += 1;
    state.syncCounts.total += 1;
    if (state.mode === "fail") {
      const err = new Error(MIRROR_ERR);
      err.code = "ENOSPC";
      throw err;
    }
  };
  return state;
}

function setup({ dbPath, mirrorDir } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-fnew03-"));
  const mDir = mirrorDir ?? join(dir, "mirror");
  const store = createStore(dbPath ?? ":memory:");
  const mirror = createMirror(mDir);
  const service = createService({ store, mirror, config: testConfig({}) });
  return { dir, mirrorDir: mDir, store, mirror, service };
}

/** 触发一次 syncMirror 失败并返回记录的 dirty 状态。 */
function triggerDirty(service, store, mock) {
  mock.mode = "fail";
  service.saveWithDedupe({ type: "project", title: "脏标记", content: "镜像未同步", importance: 3 });
  const state = store.getMirrorState();
  assert.equal(state.dirty, true, "前置：syncMirror 失败必须记录 dirty");
  return state;
}

// ── ① dirty 持久化（store 层）─────────────────────────────────────────────

test("F-NEW-03 a: mirror.sync 失败 → dirty=true、last_error/last_attempt 记录；成功 → dirty=false、success_at", () => {
  const { dir, store, mirror, service } = setup();
  try {
    const mock = makeSyncMock();
    mirror.sync = mock.sync;

    // 失败路径
    mock.mode = "fail";
    service.saveWithDedupe({ type: "project", title: "失败样例", content: "x", importance: 3 });
    const dirty = store.getMirrorState();
    assert.equal(dirty.dirty, true, "dirty 必须为 true");
    assert.equal(dirty.last_error, MIRROR_ERR, "last_error 必须为失败原因");
    assert.ok(dirty.last_attempt, "last_attempt 必须有时间戳");

    // 成功路径：不重置 last_attempt，但 dirty 清、last_error 清、success_at 更新
    mock.mode = "ok";
    service.saveWithDedupe({ type: "project", title: "成功样例", content: "y", importance: 2 });
    const clean = store.getMirrorState();
    assert.equal(clean.dirty, false, "成功必须清 dirty");
    assert.equal(clean.last_error, null, "成功必须清 last_error");
    assert.ok(clean.success_at, "success_at 必须有值");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F-NEW-03 b: 跨重启——dirty 写入后关闭 store 重开，dirty/last_error 仍在", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-fnew03-"));
  const dbPath = join(dir, "memory.db");
  try {
    let store = createStore(dbPath);
    store.markMirrorDirty(MIRROR_ERR, "2026-08-16T00:00:00.000Z");
    assert.equal(store.getMirrorState().dirty, true);
    store.close();

    store = createStore(dbPath);
    const state = store.getMirrorState();
    assert.equal(state.dirty, true, "重开后 dirty 必须仍在");
    assert.equal(state.last_error, MIRROR_ERR, "重开后 last_error 必须保留");
    assert.equal(state.last_attempt, "2026-08-16T00:00:00.000Z", "重开后 last_attempt 必须保留");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F-NEW-03 c: markMirrorDirty→markMirrorClean→clearMirrorDirty 全链路 + clearMirrorDirty 幂等", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-fnew03-"));
  const dbPath = join(dir, "memory.db");
  try {
    const store = createStore(dbPath);
    store.markMirrorDirty("EACCES", "t1");
    assert.equal(store.getMirrorState().dirty, true);
    store.markMirrorClean("t2");
    const clean = store.getMirrorState();
    assert.equal(clean.dirty, false);
    assert.equal(clean.last_error, null);
    assert.equal(clean.success_at, "t2");
    assert.equal(clean.last_attempt, "t1", "markMirrorClean 不得清 last_attempt");
    // 幂等：重复 clear 不抛、不新增行
    assert.doesNotThrow(() => store.clearMirrorDirty());
    assert.doesNotThrow(() => store.clearMirrorDirty());
    assert.equal(store.getMirrorState().dirty, false);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mirror_state").get().n, 1, "始终单行");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F-NEW-03 d: dirty 记录与 DB decision receipt 物理分离——mirror_state 无 receipt 列", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-fnew03-"));
  const dbPath = join(dir, "memory.db");
  try {
    const store = createStore(dbPath);
    const cols = store.db.prepare("PRAGMA table_info(mirror_state)").all().map((c) => c.name);
    assert.deepEqual(cols.sort(),
      ["applied_generation", "dirty", "generation", "id", "last_attempt", "last_error", "success_at", "type_status"],
      "mirror_state 只含状态列（v0.3.6 含 generation/applied_generation/type_status），不得混入 receipt/decision 字段");
    store.markMirrorDirty("boom", "t");
    store.saveReceipt({
      run_id: "run-1", record_id: "rec-1", kind: "merge", input_digest: "d",
      verdict: "live", count_before: 1, count_after: 2
    });
    const state = store.getMirrorState();
    assert.deepEqual(Object.keys(state).sort(),
      ["applied_generation", "dirty", "generation", "id", "last_attempt", "last_error", "success_at", "type_status"],
      "dirty 状态对象不得携带 receipt 内容");
    assert.equal(state.last_error, "boom");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ② 启动检测 + ③ 有界重试（service 层）────────────────────────────────

test("F-NEW-03 e: recoverMirror 检测 dirty → 重渲染收敛、dirty 清、success_at 更新、返回 {recovered:true}", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-fnew03-"));
  const dbPath = join(dir, "memory.db");
  const mirrorDir = join(dir, "mirror");
  try {
    let { store, mirror, service } = setup({ dbPath, mirrorDir });
    const original = mirror.sync.bind(mirror);
    const mock = makeSyncMock();
    mirror.sync = mock.sync;
    triggerDirty(service, store, mock); // 1 次失败调用

    // 磁盘恢复：恢复真实 sync 并包计数，只统计 recoverMirror 期间的重渲染
    let syncCalls = 0;
    mirror.sync = (entries) => { syncCalls += 1; return original(entries); };
    const result = service.recoverMirror();
    assert.equal(result.recovered, true, "recover 必须成功");
    assert.equal(result.error, null);
    assert.equal(syncCalls, 1, "dirty 且立即成功 → 恰好 1 次重渲染");
    const state = store.getMirrorState();
    assert.equal(state.dirty, false, "收敛后必须清 dirty");
    assert.equal(state.last_error, null, "收敛后必须清 last_error");
    assert.ok(state.success_at, "收敛后 success_at 必须更新");
    assert.match(readFileSync(mirrorPath(mirrorDir, "project"), "utf8"), /脏标记/, "镜像文件必须收敛含数据");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F-NEW-03 f: 有界重试——持续失败时 recoverMirror 最多尝试 3 次就停，返回 {recovered:false, error}", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-fnew03-"));
  const dbPath = join(dir, "memory.db");
  const mirrorDir = join(dir, "mirror");
  try {
    let { store, mirror, service } = setup({ dbPath, mirrorDir });
    const mock = makeSyncMock();
    mirror.sync = mock.sync;
    triggerDirty(service, store, mock);

    mock.mode = "fail"; // 持续失败
    mock.calls = 0;
    const result = service.recoverMirror();
    assert.equal(result.recovered, false, "持续失败必须判定未恢复");
    assert.ok(result.error, "必须返回错误信息");
    assert.equal(mock.calls, 3, "最多尝试 3 次，不得无限重试");
    const state = store.getMirrorState();
    assert.equal(state.dirty, true, "失败后 dirty 必须仍为 true");
    assert.equal(state.last_error, MIRROR_ERR, "last_error 保留最近失败原因");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F-NEW-03 g: 有界重试——第 2 次尝试成功即停止（不空转满 3 次）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-fnew03-"));
  const dbPath = join(dir, "memory.db");
  const mirrorDir = join(dir, "mirror");
  try {
    let { store, mirror, service } = setup({ dbPath, mirrorDir });
    const mock = makeSyncMock();
    mirror.sync = mock.sync;
    triggerDirty(service, store, mock);

    // 第 1 次（recover 内）失败、第 2 次成功
    let attempt = 0;
    mirror.sync = () => {
      attempt += 1;
      if (attempt === 1) throw new Error(MIRROR_ERR);
    };
    const result = service.recoverMirror();
    assert.equal(result.recovered, true, "重试中成功必须收敛");
    assert.equal(result.error, null);
    assert.equal(attempt, 2, "成功后立即停止，不得空转");
    assert.equal(store.getMirrorState().dirty, false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F-NEW-03 h: 本来干净时 recoverMirror 直接视为成功且不触发重渲染", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-fnew03-"));
  const dbPath = join(dir, "memory.db");
  try {
    const store = createStore(dbPath);
    const mirror = createMirror(join(dir, "mirror"));
    const service = createService({ store, mirror, config: testConfig({}) });
    const mock = makeSyncMock();
    mirror.sync = mock.sync;
    const result = service.recoverMirror();
    assert.equal(result.recovered, true, "干净状态视为成功");
    assert.equal(result.error, null);
    assert.equal(mock.calls, 0, "干净状态不得触发任何 sync");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ④ getMirrorHealth + /health 端点 ─────────────────────────────────────

test("F-NEW-03 i: getMirrorHealth 返回 {dirty,last_error,last_attempt,success_at}，dirty 归一为 boolean", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-fnew03-"));
  const dbPath = join(dir, "memory.db");
  const mirrorDir = join(dir, "mirror");
  try {
    let { store, mirror, service } = setup({ dbPath, mirrorDir });
    const mock = makeSyncMock();
    mirror.sync = mock.sync;
    triggerDirty(service, store, mock);

    const dirty = service.getMirrorHealth();
    assert.equal(dirty.dirty, true, "dirty 必须为 boolean true");
    assert.equal(dirty.last_error, MIRROR_ERR);
    assert.ok(dirty.last_attempt);
    assert.equal(dirty.success_at, null, "未成功过则 success_at 为 null");

    mock.mode = "ok";
    service.saveWithDedupe({ type: "project", title: "恢复样例", content: "z", importance: 1 });
    const clean = service.getMirrorHealth();
    assert.equal(clean.dirty, false, "恢复后 dirty 必须为 false");
    assert.equal(clean.last_error, null);
    assert.ok(clean.success_at, "恢复后 success_at 非空");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F-NEW-03 j: /api/dsh-mneme/health 端点暴露 dirty 状态，恢复后自动变 clean", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-fnew03-"));
  const dbPath = join(dir, "memory.db");
  const mirrorDir = join(dir, "mirror");
  try {
    let { store, mirror, service } = setup({ dbPath, mirrorDir });
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
    createApi(ctx, service, settings, commands, undefined, undefined, "");
    const route = routes.find((r) => r.path === "/api/dsh-mneme/health");
    assert.ok(route, "必须注册 /health 路由");

    class FakeRes extends EventEmitter {
      constructor() { super(); this.statusCode = 200; this.body = ""; }
      writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
      end(text) { this.body = text ?? ""; this.emit("end"); return this; }
    }
    const getReq = () => ({ url: "/api/dsh-mneme/health", method: "GET", headers: {} });

    const mock = makeSyncMock();
    mirror.sync = mock.sync;
    triggerDirty(service, store, mock);
    const resDirty = new FakeRes();
    await route.handler(getReq(), resDirty);
    assert.equal(resDirty.statusCode, 200);
    assert.match(resDirty.headers["Content-Type"], /application\/json/);
    assert.equal(JSON.parse(resDirty.body).mirror.dirty, true, "dirty 时 /health 必须暴露 dirty:true");
    assert.equal(JSON.parse(resDirty.body).mirror.status, "degraded", "dirty 时 /health 必须为 degraded");
    // v0.3.6 脱敏：/health 只回脱敏错误码，不回显原始 last_error
    assert.equal(JSON.parse(resDirty.body).mirror.last_error, "no-space",
      "last_error 必须脱敏为 no-space，不得回显原始值");
    assert.ok(!JSON.parse(resDirty.body).mirror.last_error.includes(MIRROR_ERR),
      "原始错误串不得出现在 /health 响应中");

    mock.mode = "ok";
    service.recoverMirror();
    const resClean = new FakeRes();
    await route.handler(getReq(), resClean);
    const body = JSON.parse(resClean.body);
    assert.equal(body.mirror.dirty, false, "恢复后 /health 必须变 dirty:false");
    assert.equal(body.mirror.last_error, null);
    assert.ok(body.mirror.success_at, "恢复后 success_at 非空");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ⑤ 端到端真实回归 + fail-safe ─────────────────────────────────────────

test("F-NEW-03 k: 端到端——持续失败→关闭重开→恢复写能力→recoverMirror 无业务写即收敛", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-fnew03-"));
  const dbPath = join(dir, "memory.db");
  const mirrorDir = join(dir, "mirror");
  try {
    // 第一"运行周期"：写业务数据 + mirror 持续失败（ENOSPC），dirty 落库
    let store = createStore(dbPath);
    let mirror = createMirror(mirrorDir);
    let service = createService({ store, mirror, config: testConfig({}) });
    const mock = makeSyncMock();
    mirror.sync = mock.sync;
    mock.mode = "fail";
    service.saveWithDedupe({ type: "project", title: "唯一数据", content: "必须收敛", importance: 3 });
    assert.equal(store.getMirrorState().dirty, true, "前置：失败后必须 dirty");
    assert.equal(store.count(), 1, "业务写本身必须已提交到 DB");
    store.close(); // 模拟进程关闭（磁盘仍满，镜像文件未更新）

    // 第二"运行周期"：磁盘恢复（mirror.sync 为真实实现）、重开 store。
    // 不触发任何业务写，只走 index.js 启动路径的 recoverMirror()。
    store = createStore(dbPath);
    mirror = createMirror(mirrorDir);
    service = createService({ store, mirror, config: testConfig({}) });
    assert.equal(store.getMirrorState().dirty, true, "重开后 dirty 必须仍在（持久化）");
    const result = service.recoverMirror();
    assert.equal(result.recovered, true, "写能力恢复后无需业务写即可收敛");
    assert.equal(store.getMirrorState().dirty, false, "收敛后 dirty 清");
    assert.ok(store.getMirrorState().success_at, "收敛后 success_at 更新");
    assert.match(readFileSync(mirrorPath(mirrorDir, "project"), "utf8"), /必须收敛/, "镜像文件必须重新渲染包含数据");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F-NEW-03 l: fail-safe——markMirrorDirty 本身写入失败不抛（store 挂时 syncMirror 仍不抛）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-fnew03-"));
  const dbPath = join(dir, "memory.db");
  const mirrorDir = join(dir, "mirror");
  try {
    const store = createStore(dbPath);
    const mirror = createMirror(mirrorDir);
    const warns = [];
    const logger = { warn: (...a) => warns.push(a) };
    const service = createService({ store, mirror, config: testConfig({}), logger });
    const mock = makeSyncMock();
    mirror.sync = mock.sync;
    mock.mode = "fail";

    // 模拟 store 状态写入挂掉：markMirrorDirty 抛错
    const original = store.markMirrorDirty.bind(store);
    store.markMirrorDirty = () => { throw new Error("db closed"); };

    try {
      assert.doesNotThrow(
        () => service.saveWithDedupe({ type: "project", title: "fail-safe", content: "x", importance: 3 }),
        "markMirrorDirty 失败不得让 syncMirror/saveWithDedupe 向外抛"
      );
      assert.equal(store.count(), 1, "store 业务写入不受状态写入失败影响");
      assert.ok(warns.some((w) => String(w[0]).includes("markMirrorDirty failed")), "必须走 logger.warn 记录");
    } finally {
      store.markMirrorDirty = original;
    }
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
