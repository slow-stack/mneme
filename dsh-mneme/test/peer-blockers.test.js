import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createStore } from "../src/store.js";
import { createMirror } from "../src/mirror.js";
import { createService } from "../src/service.js";
import { testConfig } from "./helpers/test-config.js";

const execFileP = promisify(execFile);

/**
 * v0.3.8 回归测试（audit peer 6 项运行时阻断 → INSTALLATION_NOT_APPROVED）。
 *
 * 测试点：
 *  A. 崩溃窗口（真实语义）：store.save 在业务事务内原子递增 desired generation，
 *     崩溃在 COMMIT 后、syncMirror 前 → 重启 recoverMirror 仅凭
 *     generation > applied_generation 捕获并收敛（peer blocker 1）
 *  B. 业务写同事务原子性：INSERT 失败回滚时 generation 不得递增（peer blocker 1/3）
 *  C. 多进程并发原子递增：8 进程 × 10 次不丢增量（peer blocker 3）
 *  D. generation 上界/负数拒绝（peer blocker 6）
 */

function setup(dbPath) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-peer-"));
  const mirrorDir = join(dir, "mirror");
  const store = createStore(dbPath ?? ":memory:");
  const mirror = createMirror(mirrorDir);
  const warns = [];
  const logger = { warn: (...a) => warns.push(a.join(" ")) };
  const service = createService({ store, mirror, config: testConfig({}), logger });
  return { dir, mirrorDir, store, mirror, service, warns };
}

test("peer-A: 崩溃窗口——save 后（generation 已递增）不 sync 直接关闭重开，recoverMirror 捕获并收敛", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-peer-"));
  const dbPath = join(dir, "mneme.db");
  const mirrorDir = join(dir, "mirror");
  try {
    const store = createStore(dbPath);
    const mirror = createMirror(mirrorDir);
    const service = createService({ store, mirror, config: testConfig({}), logger: { warn() {} } });
    try {
      // 业务写：store.save 在事务内递增 desired generation，但不触发 mirror 渲染
      store.save({ type: "project", title: "P", content: "x", importance: 3 });
      const afterSave = store.getMirrorState();
      assert.ok(afterSave.generation > afterSave.applied_generation,
        "save 后 generation > applied（COMMIT 完成，mirror 未同步=崩溃窗口）");
    } finally {
      // 模拟崩溃：不调 syncMirror，直接关库
      store.close();
    }

    // 重启：重新打开同一 DB，recoverMirror 必须捕获债务并收敛
    const store2 = createStore(dbPath);
    const mirror2 = createMirror(mirrorDir);
    const service2 = createService({ store: store2, mirror: mirror2, config: testConfig({}), logger: { warn() {} } });
    try {
      const result = service2.recoverMirror();
      assert.equal(result.recovered, true, "崩溃窗口必须被 recover 捕获");
      assert.equal(result.error, null);
      const state = store2.getMirrorState();
      assert.equal(state.dirty, false, "收敛后 dirty 清");
      assert.ok(state.generation <= state.applied_generation, "收敛后无未应用债务");
    } finally {
      store2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("peer-B: 业务写同事务原子性——INSERT 失败回滚时 generation 不得递增", () => {
  const { dir, store } = setup();
  try {
    store.save({ id: "dup", type: "project", title: "A", content: "x", importance: 3 });
    const before = store.getMirrorState().generation;
    assert.throws(
      () => store.save({ id: "dup", type: "project", title: "B", content: "y", importance: 3 }),
      /UNIQUE|constraint/i,
      "重复主键 INSERT 必须抛错"
    );
    assert.equal(store.getMirrorState().generation, before,
      "回滚后 generation 不递增（写与 desired generation 同事务，失败一起回滚）");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("peer-C: 多进程并发原子递增——8 进程×10 次 incrementGeneration 不丢增量", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-peer-"));
  const dbPath = join(dir, "concurrent.db");
  const N = 8;
  const M = 10;
  try {
    // 子进程：静态 worker 脚本（test/helpers/peer-worker.mjs，可审查、无动态
    // 生成代码），execFile 参数数组、无 shell；DB 路径与迭代数经 argv 传入。
    const workerPath = fileURLToPath(new URL("./helpers/peer-worker.mjs", import.meta.url));
    await Promise.all(
      Array.from({ length: N }, () =>
        execFileP(process.execPath, [workerPath, dbPath, String(M)], { timeout: 30000 })
      )
    );
    const store = createStore(dbPath);
    try {
      const state = store.getMirrorState();
      assert.equal(state.generation, N * M,
        `并发 ${N} 进程 × ${M} 次必须无丢失增量，得到 ${state.generation}`);
    } finally {
      store.close();
    }
  } finally {
    // Windows：8 个 SQLite 子进程退出后 -shm/-wal 句柄延迟释放，删目录偶发 EPERM；
    // rm 带 maxRetries 自动重试（30×100ms 共 3s），仍失败则放行——清理只是收尾，
    // 并发断言正确性由上方 generation 断言保证，残留临时目录交给 OS/CI 回收，
    // 绝不让句柄释放慢把 flaky 标红。
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    } catch (err) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
    }
  }
});

test("peer-D: generation 上界与负数拒绝", () => {
  const { dir, store } = setup();
  try {
    // 负数拒绝
    assert.throws(() => store.setMirrorState({ generation: -1 }), RangeError, "负数必须拒绝");
    assert.throws(() => store.setMirrorState({ applied_generation: -5 }), RangeError, "负数 applied 必须拒绝");
    // 超 MAX_SAFE_INTEGER 拒绝
    assert.throws(
      () => store.setMirrorState({ generation: Number.MAX_SAFE_INTEGER + 1 }),
      RangeError,
      "超出 MAX_SAFE_INTEGER 必须拒绝"
    );
    // 到上界后再 increment 必须抛错（读回不会 ERR_OUT_OF_RANGE）
    store.setMirrorState({ generation: Number.MAX_SAFE_INTEGER });
    assert.throws(() => store.incrementGeneration(), /exceeded MAX_SAFE_INTEGER/, "上界后再递增必须抛错");
    // 正常递增仍工作
    store.setMirrorState({ generation: 5 });
    assert.equal(store.incrementGeneration().generation, 6, "正常递增不受影响");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v0.3.9-A: compareAndUpdate 的 CAS UPDATE 与 generation 同事务——miss 不得递增", () => {
  const { dir, store } = setup();
  try {
    const saved = store.save({ type: "project", title: "CAS 原子", content: "v0" });
    const before = store.getById(saved.id);
    const genBefore = store.getMirrorState().generation;

    // 成功 CAS：业务写入 + generation 递增必须一次提交（同事务）
    const updated = store.compareAndUpdate(saved.id, before.updated_at, { content: "v1" });
    assert.ok(updated, "当前版本 CAS 必须成功");
    const genAfterOk = store.getMirrorState().generation;
    assert.equal(genAfterOk, genBefore + 1, "成功 CAS 必须恰好递增一次 generation");

    // miss CAS：不写任何东西，generation 也不得递增
    const stale = store.getById(saved.id).updated_at; // v1 的 token
    store.compareAndUpdate(saved.id, before.updated_at, { content: "v2" }); // 用旧 token → miss
    assert.equal(store.getById(saved.id).content, "v1", "miss 不得改数据");
    assert.equal(store.getMirrorState().generation, genAfterOk,
      "CAS miss 不得递增 generation（UPDATE 与 increment 必须同事务）");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v0.3.9-F: generation 非整数必须拒绝（不得截断）", () => {
  const { dir, store } = setup();
  try {
    // 审计 peer F：1.5 这类小数此前被 Math.trunc 截断 + SQLite CHECK 接受 → 静默脏值。
    // fail-closed：JS 与 SQL 统一只接受整数。
    assert.throws(() => store.setMirrorState({ generation: 1.5 }), RangeError, "小数 generation 必须拒绝");
    assert.throws(() => store.setMirrorState({ applied_generation: -1.5 }), RangeError, "负数小数必须拒绝");
    assert.throws(() => store.setMirrorState({ generation: Number.MAX_SAFE_INTEGER + 0.5 }), RangeError, "超界小数必须拒绝");
    // 整数仍正常
    const s = store.setMirrorState({ generation: 7 });
    assert.equal(s.generation, 7, "整数 generation 正常");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
