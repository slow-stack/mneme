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
 * F-NEW-03 回归测试（audit peer 发现的：syncMirror 失败无持久 dirty 状态）。
 *
 * 修复内容：
 *  - store.js 新增 mirror_state 表 + set/getMirrorState + markMirrorDirty/Clean
 *  - service.syncMirror 失败写 dirty（dirty=1+last_error+last_attempt）、成功写
 *    clean（dirty=0+last_error=null+success_at）；状态写入各自 try/catch 不向外抛
 *  - service.recoverMirror() 启动时 dirty 则做有界重试（最多 3 次）收敛镜像，
 *    仍失败保持 dirty 下次再试；返回 { recovered, error }，绝不向外抛
 *  - service.getMirrorHealth() 供 api.js /api/dsh-mneme/health 使用
 *  - index.js 启动时调 recoverMirror()
 *
 * 测试点由 Kimi K2.7 设计（TC-F-03-001~011）。
 * 注意：getMirrorState().dirty 是布尔（row.dirty===1 转换），不是 1。
 */

function setup({ dbPath } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-dirty-"));
  const mirrorDir = join(dir, "mirror");
  const store = createStore(dbPath ?? ":memory:");
  const mirror = createMirror(mirrorDir);
  const warns = [];
  const logger = { warn: (...a) => warns.push(a.join(" ")) };
  const service = createService({ store, mirror, config: testConfig({}), logger });
  return { dir, mirrorDir, store, mirror, service, warns };
}

function mirrorPath(dir, type) {
  return join(dir, TYPE_FILE[type]);
}

/** mock mirror.sync 抛错（沿用 fnew-0112 的 throwingMirrorSync 模式） */
function throwingMirrorSync(mirror, message = "No space left on device") {
  const original = mirror.sync.bind(mirror);
  const err = new Error(message);
  err.code = "ENOSPC";
  mirror.sync = () => { throw err; };
  return { original, err };
}

/** 包一层计数 + 透传的 mirror.sync */
function countingSync(mirror) {
  let calls = 0;
  const original = mirror.sync.bind(mirror);
  mirror.sync = (...args) => { calls++; return original(...args); };
  return { calls: () => calls, restore: () => { mirror.sync = original; } };
}

// ── TC-F-03-001：getMirrorState 的 dirty 是布尔契约 ─────────────────────────

test("F-NEW-03: markMirrorDirty → getMirrorState().dirty 是布尔 true，字段齐全", () => {
  const { dir, store, mirror, service } = setup();
  try {
    const now = new Date().toISOString();
    store.markMirrorDirty("probe error", now);
    const state = service.getMirrorState();
    assert.equal(typeof state.dirty, "boolean", "dirty 必须是布尔（不是 1）");
    assert.equal(state.dirty, true);
    assert.equal(state.last_error, "probe error");
    assert.equal(state.last_attempt, now);
    assert.equal(state.success_at, null, "失败后不得写 success_at");
    // 空表默认形状
    store.clearMirrorDirty();
    const clean = store.getMirrorState();
    assert.equal(clean.dirty, false);
    assert.equal(clean.last_error, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── TC-F-03-003：syncMirror 失败持久化 dirty，且不向外抛 ────────────────────

test("F-NEW-03: syncMirror 失败 → dirty=1+last_error+last_attempt，不抛", () => {
  const { dir, store, mirror, service, warns } = setup();
  try {
    const { original, err } = throwingMirrorSync(mirror);
    try {
      assert.doesNotThrow(() => {
        service.saveWithDedupe({ type: "project", title: "写脏", content: "x", importance: 3 });
      }, "syncMirror 失败不得向外抛");
      const state = service.getMirrorState();
      assert.equal(state.dirty, true, "失败必须持久 dirty");
      assert.equal(state.last_error, err.message, "last_error 必须记录错误消息");
      assert.ok(state.last_attempt, "last_attempt 必须有值");
      assert.ok(Number.isFinite(new Date(state.last_attempt).getTime()), "last_attempt 须为合法时间");
      assert.equal(state.success_at, null, "失败不得写 success_at");
      assert.ok(warns.length >= 1, "失败应走 logger.warn");
    } finally {
      mirror.sync = original;
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── TC-F-03-002：syncMirror 成功清 dirty 并记录 success_at ──────────────────

test("F-NEW-03: syncMirror 成功 → dirty=0+last_error=null+success_at，镜像收敛", () => {
  const { dir, mirrorDir, store, mirror, service } = setup();
  try {
    // 先制造 dirty
    const { original } = throwingMirrorSync(mirror);
    const { memory } = service.saveWithDedupe({ type: "project", title: "收敛目标", content: "第一版", importance: 3 });
    assert.equal(service.getMirrorState().dirty, true, "前置：必须 dirty");
    // 恢复 sync，下一次写应清 dirty 且镜像收敛
    mirror.sync = original;
    service.saveWithDedupe({ type: "project", title: "后续", content: "第二版", importance: 2 });
    const state = service.getMirrorState();
    assert.equal(state.dirty, false, "成功后必须清 dirty");
    assert.equal(state.last_error, null, "last_error 必须清空");
    assert.ok(state.success_at, "success_at 必须有值");
    assert.ok(Number.isFinite(new Date(state.success_at).getTime()), "success_at 须为合法时间");
    const file = readFileSync(mirrorPath(mirrorDir, "project"), "utf8");
    assert.match(file, /收敛目标/, "失败后的下一次同步必须收敛镜像");
    assert.match(file, /第二版/, "后续写入也必须上镜像");
    assert.ok(store.getById(memory.id), "store 数据不受影响");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── TC-F-03-006：recoverMirror dirty+成功 → 恢复 clean，首试即中恰好一次 ────

test("F-NEW-03: recoverMirror dirty→成功恢复 clean，首试即中、镜像收敛、返回 recovered", () => {
  const { dir, mirrorDir, store, mirror, service } = setup();
  try {
    // 制造 dirty（失败一次）
    const { original } = throwingMirrorSync(mirror);
    service.saveWithDedupe({ type: "project", title: "启动恢复", content: "Dirty 数据", importance: 3 });
    assert.equal(service.getMirrorState().dirty, true, "前置：必须 dirty");
    // 恢复后包计数，recoverMirror 首次尝试即成功 → sync 恰好一次
    mirror.sync = original;
    const counter = countingSync(mirror);
    const result = service.recoverMirror();
    assert.equal(result.recovered, true, "恢复成功必须返回 recovered=true");
    assert.equal(result.error, null);
    assert.equal(counter.calls(), 1, "首试即中：sync 必须只调一次");
    const state = service.getMirrorState();
    assert.equal(state.dirty, false, "恢复成功必须清 dirty");
    assert.equal(state.last_error, null);
    assert.ok(state.success_at, "恢复成功应写 success_at");
    const file = readFileSync(mirrorPath(mirrorDir, "project"), "utf8");
    assert.match(file, /启动恢复/, "recover 后镜像必须与 store 收敛");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── TC-F-03-007：recoverMirror 失败保持 dirty，有界重试后放弃，不抛 ─────────

test("F-NEW-03: recoverMirror 仍失败 → dirty 保持、返回 recovered=false+error，不抛", () => {
  const { dir, store, mirror, service } = setup();
  try {
    const { original } = throwingMirrorSync(mirror);
    try {
      service.saveWithDedupe({ type: "project", title: "再失败", content: "x", importance: 3 });
      const dirtyState = service.getMirrorState();
      assert.equal(dirtyState.dirty, true, "前置：必须 dirty");
      const counter = countingSync(mirror); // 包装的仍是抛错 mock → 每次尝试都失败
      assert.doesNotThrow(() => service.recoverMirror(), "recoverMirror 失败也不得抛");
      const after = service.getMirrorState();
      assert.equal(after.dirty, true, "失败后 dirty 必须保持，供下次启动再试");
      assert.ok(after.last_error, "last_error 须有值");
      assert.ok(after.last_attempt >= dirtyState.last_attempt, "last_attempt 须更新");
      assert.equal(after.success_at, null);
      // 有界性：失败路径最多重试 MAX_ATTEMPTS(3) 次后放弃，不得无限循环
      assert.ok(counter.calls() <= 3, `recover 失败必须是有界重试，实际 ${counter.calls()} 次`);
    } finally {
      mirror.sync = original;
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 有界性（Kimi 风险点 3）：recoverMirror 重试次数精确 ≤3 ──────────────────

test("F-NEW-03: recoverMirror 失败路径恰好重试 3 次后放弃（有界不无限）", () => {
  const { dir, store, mirror, service } = setup();
  try {
    const { original } = throwingMirrorSync(mirror);
    try {
      service.saveWithDedupe({ type: "project", title: "有界", content: "x", importance: 3 });
      assert.equal(service.getMirrorState().dirty, true, "前置：必须 dirty");
      const counter = countingSync(mirror);
      const result = service.recoverMirror();
      assert.equal(counter.calls(), 3, "失败路径必须恰好尝试 3 次（MAX_ATTEMPTS）");
      assert.equal(result.recovered, false, "3 次耗尽仍失败 → recovered=false");
      assert.ok(result.error, "必须携带失败原因 error");
      assert.equal(service.getMirrorState().dirty, true, "放弃后 dirty 保持，下次启动再试");
    } finally {
      mirror.sync = original;
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── TC-F-03-008：recoverMirror 不 dirty 时 no-op ────────────────────────────

test("F-NEW-03: recoverMirror 不 dirty → 不重渲染、状态不变、返回 recovered=true", () => {
  const { dir, store, mirror, service } = setup();
  try {
    const counter = countingSync(mirror);
    const result = service.recoverMirror();
    assert.equal(counter.calls(), 0, "不 dirty 时必须 no-op，不调 sync");
    assert.equal(result.recovered, true, "本来干净 → recovered=true 且不调 sync");
    const state = service.getMirrorState();
    assert.equal(state.dirty, false, "状态不得改变");
    // 已有数据但 dirty=0 同样 no-op（saveWithDedupe 自身会同步一次，记录基线）
    service.saveWithDedupe({ type: "project", title: "干净数据", content: "x", importance: 3 });
    assert.equal(service.getMirrorState().dirty, false);
    const before = counter.calls();
    service.recoverMirror();
    assert.equal(counter.calls(), before, "干净状态下 recoverMirror 不得触发同步");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── TC-F-03-009：持久化跨重开（真实 DB 文件）───────────────────────────────

test("F-NEW-03: markMirrorDirty 后关闭/重开 store → dirty 仍持久", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-dirty-"));
  const dbPath = join(dir, "memory.db");
  const mirrorDir = join(dir, "mirror");
  try {
    const store = createStore(dbPath);
    store.markMirrorDirty("persist error", "2026-08-16T00:00:00.000Z");
    store.close();

    const reopened = createStore(dbPath);
    const state = reopened.getMirrorState();
    assert.equal(state.dirty, true, "重开后 dirty 必须仍为 true");
    assert.equal(state.last_error, "persist error");
    assert.equal(state.last_attempt, "2026-08-16T00:00:00.000Z");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F-NEW-03: 重开后 recoverMirror 从持久 dirty 恢复 → clean 且再次重开仍 clean", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-dirty-"));
  const dbPath = join(dir, "memory.db");
  const mirrorDir = join(dir, "mirror");
  try {
    // 第一次"启动"：写失败 → dirty 持久化
    let store = createStore(dbPath);
    let mirror = createMirror(mirrorDir);
    let service = createService({ store, mirror, config: testConfig({}) });
    const { original } = throwingMirrorSync(mirror);
    service.saveWithDedupe({ type: "summary", title: "总览", content: "Dirty 内容", importance: 3 });
    assert.equal(service.getMirrorState().dirty, true);
    store.close();

    // 第二次"启动"：index.js 同款 recoverMirror() → 恢复成功
    store = createStore(dbPath);
    mirror = createMirror(mirrorDir);
    service = createService({ store, mirror, config: testConfig({}) });
    assert.equal(service.getMirrorState().dirty, true, "重开必须先看到 dirty");
    service.recoverMirror();
    assert.equal(service.getMirrorState().dirty, false, "recover 后必须清 dirty");
    assert.ok(service.getMirrorState().success_at);
    const file = readFileSync(mirrorPath(mirrorDir, "summary"), "utf8");
    assert.match(file, /Dirty 内容/, "镜像必须收敛");
    store.close();

    // 第三次打开：clean 状态持久
    store = createStore(dbPath);
    assert.equal(store.getMirrorState().dirty, false, "clean 也必须持久");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── TC-F-03-010 / 011：health 端点反映真实 mirror 状态 ──────────────────────

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function apiSetup(store, service) {
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
  const health = routes.find((r) => r.path === "/api/dsh-mneme/health");
  return { health };
}

test("F-NEW-03: health 端点 dirty 时返回 dirty=true 及 last_error/last_attempt", () => {
  const { dir, store, mirror, service } = setup();
  try {
    const { health } = apiSetup(store, service);
    assert.ok(health, "必须注册 /api/dsh-mneme/health");
    const { original } = throwingMirrorSync(mirror);
    try {
      service.saveWithDedupe({ type: "project", title: "脏", content: "x", importance: 3 });
    } finally {
      mirror.sync = original;
    }
    assert.equal(service.getMirrorState().dirty, true, "前置：必须 dirty");
    const res = new FakeRes();
    health.handler({ url: "/api/dsh-mneme/health", method: "GET", headers: {} }, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.mirror.dirty, true, "health 必须反映真实 dirty（布尔）");
    assert.equal(body.mirror.status, "degraded", "dirty 时 health 必须为 degraded");
    // v0.3.6 脱敏：只回脱敏错误码，不回显原始 last_error
    assert.equal(body.mirror.last_error, "no-space", "last_error 必须脱敏为 no-space");
    assert.ok(!body.mirror.last_error.includes("No space left on device"),
      "原始错误串不得出现在 health 响应中");
    assert.ok(body.mirror.last_attempt, "last_attempt 须返回");
    assert.equal(body.mirror.success_at, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F-NEW-03: health 端点 clean 后返回 dirty=false 且 success_at 有值", () => {
  const { dir, store, mirror, service } = setup();
  try {
    const { health } = apiSetup(store, service);
    // 制造 dirty 后恢复成功 → clean
    const { original } = throwingMirrorSync(mirror);
    service.saveWithDedupe({ type: "project", title: "清", content: "x", importance: 3 });
    mirror.sync = original;
    service.saveWithDedupe({ type: "project", title: "清2", content: "y", importance: 2 });
    assert.equal(service.getMirrorState().dirty, false, "前置：必须 clean");
    const res = new FakeRes();
    health.handler({ url: "/api/dsh-mneme/health", method: "GET", headers: {} }, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.mirror.dirty, false, "health 必须反映 clean");
    assert.equal(body.mirror.last_error, null);
    assert.ok(body.mirror.success_at, "success_at 须返回");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── TC-F-03-004/005：状态写入自身失败 → syncMirror 仍不抛 ───────────────────

test("F-NEW-03: markMirrorDirty 自身抛错 → syncMirror 不抛、只 warn", () => {
  const { dir, store, mirror, service, warns } = setup();
  try {
    const { original } = throwingMirrorSync(mirror);
    const origDirty = store.markMirrorDirty.bind(store);
    try {
      store.markMirrorDirty = () => { throw new Error("db locked"); };
      assert.doesNotThrow(() => {
        service.saveWithDedupe({ type: "project", title: "fail-safe", content: "x", importance: 3 });
      }, "markMirrorDirty 失败不得使 syncMirror 外抛");
      assert.ok(warns.some((w) => /markMirrorDirty failed|db locked/.test(w)), "应走 logger.warn");
      assert.equal(store.count(), 1, "store 写入不受影响");
    } finally {
      store.markMirrorDirty = origDirty;
      mirror.sync = original;
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F-NEW-03: markMirrorCleanForGeneration 自身抛错 → syncMirror 不抛、只 warn", () => {
  const { dir, store, mirror, service, warns } = setup();
  try {
    const { original } = throwingMirrorSync(mirror);
    const origClean = store.markMirrorCleanForGeneration.bind(store);
    try {
      // 制造 dirty
      service.saveWithDedupe({ type: "project", title: "前置脏", content: "x", importance: 3 });
      assert.equal(service.getMirrorState().dirty, true, "前置：必须 dirty");
      // 恢复 sync + 让 markMirrorCleanForGeneration 抛错（v0.3.6 成功路径的 CAS 写）
      mirror.sync = original;
      store.markMirrorCleanForGeneration = () => { throw new Error("clean write fail"); };
      assert.doesNotThrow(() => {
        service.saveWithDedupe({ type: "project", title: "成功路径", content: "y", importance: 2 });
      }, "markMirrorCleanForGeneration 失败不得使 syncMirror 外抛");
      assert.ok(warns.some((w) => /markMirrorCleanForGeneration failed|clean write fail/.test(w)), "应走 logger.warn");
      assert.equal(store.count(), 2, "store 写入不受影响");
    } finally {
      store.markMirrorCleanForGeneration = origClean;
      mirror.sync = original;
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
