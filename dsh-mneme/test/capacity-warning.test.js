// #275 容量预警（空间维度）回归：store 行数口径 → service 判级与 fail-safe →
// /health 的 capacity 挂载。三层各锁各的：
//   store.capacityStats —— 活跃/归档两格，setArchived 翻位即反映；
//   getCapacityHealth —— 阈值判级（>= 过线、0 = 关）、:memory: 的缺席语义、
//     fail-safe（读坏显式 unknown，绝不伪装 ok）；
//   /health —— capacity 与 mirror 同面但互相独立，且不带库文件路径（半张对外面
//     不泄露本机布局）。
// 面板卡在 lib/client.js（无 src 对应物），由 test/client.test.js 的字符串锁兜住。
// 阈值配置一律在 createService 时传入：createService 闭包持有 config，事后改
// service.config 属性够不着判级读的那份（闭包变量），改了也是假绿。
// 判级用例用裸 config（{}）：memoryQualityFilter 解析默认开，短正文样例会被静默
// 归档，行数断言就全歪了——裸 config 下该闸不参与，这正是这些用例要的写入面。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";
import { Config, CAPACITY_WARNING_DEFAULTS } from "../src/config.js";
import { testConfig } from "./helpers/test-config.js";

function seed(service, n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const res = service.saveWithDedupe({
      type: "project", title: `容量样例 ${i}`, content: `容量样例正文 ${i}，长度足够不被过滤`, importance: 3
    });
    ids.push(res.memory.id);
  }
  return ids;
}

// ── store.capacityStats ───────────────────────────────────────────────────────

test("capacityStats 分活跃/归档两格；归档与还原都即时反映", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  try {
    const ids = seed(service, 3);
    assert.deepEqual(store.capacityStats(), { active: 3, archived: 0 });
    store.setArchived(ids[0], true);
    store.setArchived(ids[1], true);
    assert.deepEqual(store.capacityStats(), { active: 1, archived: 2 });
    // 还原（memory_archive 的出口）回到活跃：占比口径要跟着翻回去
    store.setArchived(ids[0], false);
    assert.deepEqual(store.capacityStats(), { active: 2, archived: 1 });
  } finally {
    store.close();
  }
});

// ── schema：阈值默认值与边界 ──────────────────────────────────────────────────

test("capacityWarning schema：默认值锚定议题形态区间，边界与部分覆盖语义钉死", () => {
  const cfg = Config({});
  assert.deepEqual(
    { ...cfg.capacityWarning },
    { dbSizeWarnMb: 256, archivedRowsWarn: 5000, archivedRatioWarn: 0.95 },
    "解析默认必须与 CAPACITY_WARNING_DEFAULTS 一致（service 的裸 config 回退也用这份）"
  );
  assert.deepEqual(
    { ...CAPACITY_WARNING_DEFAULTS },
    { dbSizeWarnMb: 256, archivedRowsWarn: 5000, archivedRatioWarn: 0.95 }
  );
  // 部分覆盖时其余键落默认（.default({}) 的内层默认语义）
  assert.equal(Config({ capacityWarning: { dbSizeWarnMb: 0 } }).capacityWarning.archivedRowsWarn, 5000);
  // 越界一律拒（负数、浮点 MB、占比 > 1）
  assert.throws(() => Config({ capacityWarning: { dbSizeWarnMb: -1 } }));
  assert.throws(() => Config({ capacityWarning: { dbSizeWarnMb: 1.5 } }));
  assert.throws(() => Config({ capacityWarning: { archivedRowsWarn: -3 } }));
  assert.throws(() => Config({ capacityWarning: { archivedRatioWarn: 1.5 } }));
});

// ── service.getCapacityHealth ────────────────────────────────────────────────

test("getCapacityHealth ok 态：检查齐全、占比归零；:memory: 库无体积检查（缺席≠伪装 ok）", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  try {
    seed(service, 1);
    const cap = service.getCapacityHealth();
    assert.equal(cap.status, "ok");
    // :memory: 没有磁盘足迹：file_bytes 为 null，db_size 检查**缺席**而不是 ok
    assert.equal(cap.file_bytes, null);
    assert.equal(cap.checks.some((c) => c.key === "db_size"), false);
    // 行数与占比检查在（total > 0）
    assert.equal(cap.active_rows, 1);
    assert.equal(cap.archived_rows, 0);
    assert.equal(cap.archived_ratio, 0);
    const rows = cap.checks.find((c) => c.key === "archived_rows");
    assert.equal(rows.status, "ok");
    assert.equal(rows.value, 0);
    assert.equal(rows.threshold, 5000, "裸 config（未解析）也要落到同一份默认阈值");
    const ratio = cap.checks.find((c) => c.key === "archived_ratio");
    assert.equal(ratio.status, "ok");
    // freelist 是页数 × 页大小：:memory: 也有页，给数字而不是 null
    assert.equal(typeof cap.freelist_bytes, "number");
    assert.ok(cap.freelist_bytes >= 0);
  } finally {
    store.close();
  }
});

test("getCapacityHealth 判级：archived_rows 到阈值 → warn，值/阈值能对上；低一格回 ok", () => {
  const store = createStore(":memory:");
  try {
    const mk = (threshold) => createService({
      store, mirror: null,
      config: testConfig({ capacityWarning: { dbSizeWarnMb: 0, archivedRowsWarn: threshold, archivedRatioWarn: 0 } })
    });
    const ids = seed(mk(2), 3);
    store.setArchived(ids[0], true);
    store.setArchived(ids[1], true);
    // 0 = 显式关掉另外两条，只剩条数检查——每条检查能被独立开关是判级的前提
    const cap = mk(2).getCapacityHealth();
    assert.equal(cap.status, "warn");
    assert.deepEqual(cap.checks.map((c) => c.key), ["archived_rows"]);
    assert.equal(cap.checks[0].status, "warn");
    assert.equal(cap.checks[0].value, 2);
    assert.equal(cap.checks[0].threshold, 2);
    // 阈值之下一格就回到 ok
    assert.equal(mk(3).getCapacityHealth().status, "ok");
  } finally {
    store.close();
  }
});

test("getCapacityHealth 判级：archived_ratio 过线 → warn，值按千分位取整", () => {
  const store = createStore(":memory:");
  const service = createService({
    store, mirror: null,
    config: testConfig({ capacityWarning: { dbSizeWarnMb: 0, archivedRowsWarn: 0, archivedRatioWarn: 0.5 } })
  });
  try {
    const ids = seed(service, 3);
    store.setArchived(ids[0], true);
    store.setArchived(ids[1], true);
    const cap = service.getCapacityHealth();
    assert.equal(cap.status, "warn");
    const ratio = cap.checks.find((c) => c.key === "archived_ratio");
    assert.equal(ratio.status, "warn");
    assert.equal(ratio.value, 0.667, "2/3 取整到千分位");
    assert.equal(ratio.threshold, 0.5);
  } finally {
    store.close();
  }
});

test("getCapacityHealth 判级：db_size 过线 → warn（文件库，足迹含主文件 + WAL）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-cap-"));
  try {
    const store = createStore(join(dir, "memory.db"));
    const service = createService({
      store, mirror: null,
      config: testConfig({ capacityWarning: { dbSizeWarnMb: 1, archivedRowsWarn: 0, archivedRatioWarn: 0 } })
    });
    // 单条 2MB 正文把库顶过 1 MB 预警线——dbSizeWarnMb 是整数 MB，比它小的只有关 (0)
    service.saveWithDedupe({ type: "project", title: "大块头", content: "x".repeat(2 * 1048576), importance: 3 });
    const cap = service.getCapacityHealth();
    assert.equal(cap.status, "warn");
    const size = cap.checks.find((c) => c.key === "db_size");
    assert.equal(size.status, "warn");
    assert.ok(size.value_bytes >= size.threshold_bytes, "file_bytes 含主文件 + WAL，必须真的过线");
    assert.equal(size.threshold_bytes, 1048576);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getCapacityHealth fail-safe：store 关掉后不抛、显式 unknown、绝不伪装 ok", () => {
  const store = createStore(":memory:");
  const warns = [];
  const service = createService({ store, mirror: null, config: testConfig({}), logger: { warn: (...a) => warns.push(a) } });
  seed(service, 1);
  store.close();
  const cap = service.getCapacityHealth();
  assert.equal(cap.status, "unknown");
  assert.equal(cap.file_bytes, null);
  assert.equal(cap.archived_rows, null);
  assert.deepEqual(cap.checks, []);
  assert.ok(warns.some((w) => String(w[0]).includes("getCapacityHealth failed")), "失败必须走 logger.warn");
});

// ── /health 挂载 ─────────────────────────────────────────────────────────────

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function makeHealthRoute(store, service) {
  const settings = createSettings(store.db);
  const commands = {
    add: (def) => settings.addCommand(def),
    remove: (id) => settings.removeCommand(id),
    list: () => settings.listCommands()
  };
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, commands, undefined, undefined, "");
  const route = routes.find((r) => r.path === "/api/dsh-mneme/health");
  assert.ok(route, "必须注册 /health 路由");
  return route;
}

test("/health 挂 capacity：与 mirror 同面、数字可读、不带库文件路径", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-cap-"));
  try {
    const store = createStore(join(dir, "memory.db"));
    const service = createService({ store, mirror: null, config: testConfig({}) });
    seed(service, 1);
    const route = makeHealthRoute(store, service);
    const res = new FakeRes();
    await route.handler({ url: "/api/dsh-mneme/health", method: "GET", headers: {} }, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.mirror, "镜像块不动");
    assert.ok(body.capacity, "capacity 块必须在");
    assert.equal(body.capacity.status, "ok");
    assert.equal(typeof body.capacity.file_bytes, "number", "文件库要给磁盘足迹");
    assert.equal(body.capacity.active_rows, 1);
    assert.ok(Array.isArray(body.capacity.checks) && body.capacity.checks.length === 3, "文件库三道检查齐全");
    // /health 是半张对外面：数字可以给，本机文件系统布局不能给
    assert.ok(!res.body.includes(dir), "响应不得携带临时目录路径");
    assert.ok(!res.body.includes("memory.db"), "响应不得携带库文件名");
    // 库关掉后两个半张各自 fail-closed：mirror 既有语义不动，capacity 显式 unknown
    store.close();
    const resBroken = new FakeRes();
    await route.handler({ url: "/api/dsh-mneme/health", method: "GET", headers: {} }, resBroken);
    const broken = JSON.parse(resBroken.body);
    assert.equal(broken.mirror.status, "unknown");
    assert.equal(broken.capacity.status, "unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/health：没接线 getCapacityHealth 的 service → capacity 显式 null，不编造形状", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  try {
    seed(service, 1);
    const route = makeHealthRoute(store, service);
    const res = new FakeRes();
    await route.handler({ url: "/api/dsh-mneme/health", method: "GET", headers: {} }, res);
    assert.equal(JSON.parse(res.body).capacity.status, "ok");
    // 老 mock / 旧版本 service 没有这个方法：handler 不得炸，capacity 落 null
    // （面板渲染成「未知」，不冒充正常）
    delete service.getCapacityHealth;
    const resOld = new FakeRes();
    await route.handler({ url: "/api/dsh-mneme/health", method: "GET", headers: {} }, resOld);
    assert.equal(resOld.statusCode, 200);
    assert.equal(JSON.parse(resOld.body).capacity, null);
  } finally {
    store.close();
  }
});
