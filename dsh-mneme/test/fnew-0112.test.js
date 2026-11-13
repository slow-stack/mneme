import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createStore } from "../src/store.js";
import { createMirror, TYPE_FILE } from "../src/mirror.js";
import { createService } from "../src/service.js";
import { applyDecisions } from "../src/dream.js";
import { testConfig } from "./helpers/test-config.js";

/**
 * F-NEW-01 / F-NEW-02 回归测试（audit peer 新阻断项）。
 *
 * F-NEW-01 启动回灌静默改回：mergeHumanEdits 必须按 last-rendered digest 判定
 *   "无人触碰的旧机器镜像"（digest 匹配 → 机器 wins，保留 DB 的 New）与
 *   "人工动过的镜像"（digest 缺失/不匹配 → 覆盖）。
 * F-NEW-02 transaction mirror 失败误报未提交：COMMIT 后 syncMirror 抛错不得
 *   外抛、不得把已提交事务当失败（applied/committed 必须如实反映真实提交）。
 *
 * 测试点由 Kimi K2.7 设计。
 */

const CONFLICT_MARKER = "并发冲突";

function digestOf(title, content) {
  return createHash("sha256").update(`${title}\x00${content}`).digest("hex");
}

function mirrorPath(dir, type) {
  return join(dir, TYPE_FILE[type]);
}

function setup({ dbPath } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-fnew-"));
  const mirrorDir = join(dir, "mirror");
  const store = createStore(dbPath ?? ":memory:");
  const mirror = createMirror(mirrorDir);
  const service = createService({ store, mirror, config: testConfig({}) });
  return { dir, mirrorDir, store, mirror, service };
}

function stripDigestComment(text) {
  return text.replace(/<!--\s*mirror-digest: [a-f0-9]+ -->\n?/g, "");
}

/**
 * 构造"DB 已提交 New + 镜像仍为旧渲染"的真实状态：先用 service 保存 Old
 * （渲染出带有效 digest 的旧镜像），再绕过 service 直接写 store 为 New，
 * 模拟镜像同步失败后 DB 与镜像分叉。
 */
function seedStaleMirror(service, store, { type, title, old, next }) {
  const { memory } = service.saveWithDedupe({ type, title, content: old, importance: 3 });
  store.update(memory.id, { content: next });
  assert.equal(store.getById(memory.id).content, next, "前置：DB 必须为 New");
  return memory;
}

// ── F-NEW-01：启动回灌 digest 判定 ──────────────────────────────────────────

test("F-NEW-01 a: 旧镜像带有效 digest → 回灌跳过覆盖，store 保持 New、applied=0", () => {
  const { dir, mirrorDir, store, mirror, service } = setup();
  try {
    const m = seedStaleMirror(service, store, { type: "project", title: "启动回灌", old: "Old", next: "New" });
    const edits = mirror.readHumanEdits("project");
    assert.ok(edits.length >= 1, "镜像必须可读回编辑");
    assert.equal(edits.find((e) => e.id === m.id)?.digest, digestOf("启动回灌", "Old"), "digest 必须随旧渲染写入");
    const applied = service.mergeHumanEdits("project", edits);
    assert.equal(applied, 0, "digest 匹配 = 无人触碰 → 不得覆盖");
    assert.equal(store.getById(m.id).content, "New", "DB 的 New 必须保留");
    assert.ok(!store.getById(m.id).content.includes(CONFLICT_MARKER), "不得出现冲突标记");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F-NEW-01 b: 老文件无 digest → 保守覆盖成 Old（行为保留）", () => {
  const { dir, mirrorDir, store, mirror, service } = setup();
  try {
    const m = seedStaleMirror(service, store, { type: "preference", title: "老文件", old: "Old", next: "New" });
    const file = mirrorPath(mirrorDir, "preference");
    writeFileSync(file, stripDigestComment(readFileSync(file, "utf8")), "utf8");
    const edits = mirror.readHumanEdits("preference");
    const edit = edits.find((e) => e.id === m.id);
    assert.equal(edit.digest, undefined, "无 digest 字段");
    const applied = service.mergeHumanEdits("preference", edits);
    assert.equal(applied, 1, "digest 缺失 = 视为人工动过 → 覆盖");
    assert.equal(store.getById(m.id).content, "Old", "store 被覆盖为旧值");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F-NEW-01 c: 镜像被人工改（digest 不匹配）→ 覆盖成人工值", () => {
  const { dir, mirrorDir, store, mirror, service } = setup();
  try {
    const m = seedStaleMirror(service, store, { type: "decision", title: "人工改", old: "机器旧", next: "机器新" });
    const file = mirrorPath(mirrorDir, "decision");
    // 人工改内容但保留 digest 注释行（此时 digest 已不匹配）
    writeFileSync(file, readFileSync(file, "utf8").replace("机器旧", "人类编辑值"), "utf8");
    const edits = mirror.readHumanEdits("decision");
    const edit = edits.find((e) => e.id === m.id);
    assert.equal(edit.content, "人类编辑值");
    assert.notEqual(edit.digest, digestOf("人工改", "人类编辑值"), "digest 必须不匹配");
    const applied = service.mergeHumanEdits("decision", edits);
    assert.equal(applied, 1, "digest 不匹配 = 人工动过 → 覆盖");
    assert.equal(store.getById(m.id).content, "人类编辑值", "人工值必须落地");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F-NEW-01 d: 端到端启动回灌（index.js 同款读-merge 循环）→ DB New 保留且重开持久", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-fnew-"));
  const dbPath = join(dir, "memory.db");
  const mirrorDir = join(dir, "mirror");
  try {
    // 首次"启动"：保存 Old → DB 直写 New（镜像分叉）
    let { store, mirror, service } = setup({ dbPath });
    const m = seedStaleMirror(service, store, { type: "summary", title: "总览", old: "Old", next: "New" });
    store.close();

    // 第二次"启动"：完整走 index.js 的回灌循环（先读全部类型再逐类 merge）
    store = createStore(dbPath);
    mirror = createMirror(mirrorDir);
    service = createService({ store, mirror, config: testConfig({}) });
    for (const type of Object.keys(TYPE_FILE)) {
      const edits = mirror.readHumanEdits(type);
      if (edits.length) service.mergeHumanEdits(type, edits);
    }
    assert.equal(store.getById(m.id).content, "New", "重启回灌不得把 DB 静默改回 Old");
    store.close();

    // 第三次打开：确认持久化且不会再被翻转
    store = createStore(dbPath);
    assert.equal(store.getById(m.id).content, "New", "重开后 DB 仍为 New");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F-NEW-01: hasDiff 守卫——补丁与 store 相同则不覆盖、不计数、updated_at 不变", () => {
  const { dir, mirrorDir, store, mirror, service } = setup();
  try {
    const m = seedStaleMirror(service, store, { type: "project", title: "无差异", old: "Old", next: "New" });
    const file = mirrorPath(mirrorDir, "project");
    // 文件内容 == store（New），但 digest 注释是旧渲染的 → 判定走覆盖分支，
    // hasDiff 必须拦住无实际变化的 UPDATE。
    writeFileSync(file, readFileSync(file, "utf8").replace("Old", "New"), "utf8");
    const edits = mirror.readHumanEdits("project");
    assert.equal(edits.find((e) => e.id === m.id).content, "New");
    const before = store.getById(m.id).updated_at;
    const applied = service.mergeHumanEdits("project", edits);
    assert.equal(applied, 0, "无实际差异不得计入 applied");
    assert.equal(store.getById(m.id).content, "New");
    assert.equal(store.getById(m.id).updated_at, before, "不得发出无意义的 UPDATE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F-NEW-01: 混合编辑逐条独立判定（有效 digest 跳过 / 缺 digest 覆盖 / 不匹配覆盖）", () => {
  const { dir, mirrorDir, store, mirror, service } = setup();
  try {
    const a = seedStaleMirror(service, store, { type: "project", title: "A", old: "A-旧", next: "A-新" });
    const b = service.saveWithDedupe({ type: "project", title: "B", content: "B-旧", importance: 3 }).memory;
    const c = service.saveWithDedupe({ type: "project", title: "C", content: "C-旧", importance: 3 }).memory;
    store.update(b.id, { content: "B-新" });
    store.update(c.id, { content: "C-新" });
    // 手工构造编辑数组：a 有效 digest（跳过）；b 无 digest（覆盖）；c digest 不匹配（覆盖）
    const edits = [
      { id: a.id, title: "A", content: "A-旧", digest: digestOf("A", "A-旧") },
      { id: b.id, title: "B", content: "B-旧" },
      { id: c.id, title: "C", content: "C-人类", digest: digestOf("C", "C-旧") }
    ];
    const applied = service.mergeHumanEdits("project", edits);
    assert.equal(applied, 2, "只有 b、c 被覆盖");
    assert.equal(store.getById(a.id).content, "A-新", "a 保持 New");
    assert.equal(store.getById(b.id).content, "B-旧", "b 无 digest → 覆盖成旧值");
    assert.equal(store.getById(c.id).content, "C-人类", "c 人工值落地");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── F-NEW-02：transaction 已提交 + mirror 失败不得误报 ─────────────────────

function throwingMirrorSync(mirror, message = "No space left on device") {
  const original = mirror.sync.bind(mirror);
  const err = new Error(message);
  err.code = "ENOSPC";
  mirror.sync = () => { throw err; };
  return { original, err };
}

test("F-NEW-02 e: COMMIT 后 mirror.sync 抛 ENOSPC → transaction 正常返回、不抛、DB 已提交且重开持久", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-fnew-"));
  const dbPath = join(dir, "memory.db");
  const mirrorDir = join(dir, "mirror");
  try {
    const store = createStore(dbPath);
    const mirror = createMirror(mirrorDir);
    const warns = [];
    const logger = { warn: (...a) => warns.push(a) };
    const service = createService({ store, mirror, config: testConfig({}), logger });
    const { original } = throwingMirrorSync(mirror);

    let committedId;
    let result;
    assert.doesNotThrow(() => {
      result = service.transaction(() => {
        const { memory } = service.saveWithDedupe({ type: "project", title: "原子", content: "已提交", importance: 3 });
        committedId = memory.id;
        return "tx-result";
      });
    }, "syncMirror 失败不得向外抛（已 COMMIT 不得被当成未提交）");
    assert.equal(result, "tx-result", "transaction 必须返回 fn 的结果");
    assert.ok(warns.length >= 1, "fail-safe 应走 logger.warn 路径");
    assert.equal(store.count(), 1, "DB 必须已提交");
    assert.equal(service.getById(committedId).content, "已提交");

    // 恢复 mirror.sync，下一次写应能重新渲染，镜像最终与 store 一致
    mirror.sync = original;
    service.saveWithDedupe({ type: "project", title: "后续", content: "x", importance: 2 });
    const file = readFileSync(mirrorPath(mirrorDir, "project"), "utf8");
    assert.match(file, /已提交/, "失败后的下一次同步必须收敛镜像");

    // 重开验证持久化
    store.close();
    const reopened = createStore(dbPath);
    assert.equal(reopened.count(), 2, "重开后已提交数据仍在");
    assert.equal(reopened.getById(committedId).content, "已提交");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F-NEW-02 f: mirror.sync 抛错时 applyDecisions 的 applied/committed/failures 如实（不虚报 0）", () => {
  const { dir, mirrorDir, store, mirror, service } = setup();
  try {
    const { memory: m } = service.saveWithDedupe({ type: "project", title: "归档目标", content: "x", importance: 3 });
    const { original } = throwingMirrorSync(mirror);
    try {
      // 修复前：transaction finally 的 mirror 异常会向上抛 → 被 applyDecisions
      // 当成 failure → applied:0、committed:[]，receipt/outcome 虚报 reconcile。
      const { applied, conflicts, failures, committed } = applyDecisions(
        [{ action: "archive", ids: [m.id] }],
        service,
        null,
        null
      );
      assert.equal(applied, 1, "真实提交数为 1，不是 0");
      assert.equal(failures.length, 0, "已提交的决策不得被误判为失败");
      assert.equal(conflicts.length, 0);
      assert.equal(committed.length, 1, "committed 必须来自真实提交子步骤");
      assert.equal(committed[0].action, "archive");
      assert.equal(store.getById(m.id).archived, true, "DB 必须真实归档");
    } finally {
      mirror.sync = original;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F-NEW-02 g: 回滚路径——fn 抛错 → ROLLBACK + 原错误传播（mirror 失败不得掩盖）", () => {
  const { dir, mirrorDir, store, mirror, service } = setup();
  try {
    const { original } = throwingMirrorSync(mirror);
    let threw = null;
    try {
      service.transaction(() => {
        service.saveWithDedupe({ type: "project", title: "应回滚", content: "x", importance: 3 });
        throw new Error("boom");
      });
    } catch (error) {
      threw = error;
    } finally {
      mirror.sync = original;
    }
    assert.ok(threw, "必须抛错");
    assert.equal(threw.message, "boom", "必须传播原始错误，而非 mirror 的 ENOSPC");
    assert.equal(store.count(), 0, "回滚后无残留写入");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F-NEW-02: mirror 自身 fail-safe——底层 sync 抛错被吞并 console.warn，不向上抛", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-fnew-"));
  const dbPath = join(dir, "memory.db");
  const mirrorDir = join(dir, "mirror");
  try {
    const store = createStore(dbPath);
    const mirror = createMirror(mirrorDir);
    const service = createService({ store, mirror, config: testConfig({}) });
    const { original } = throwingMirrorSync(mirror, "EACCES");
    try {
      assert.doesNotThrow(() => service.saveWithDedupe({ type: "history", title: "非事务路径", content: "x", importance: 3 }),
        "事务外的写路径（saveWithDedupe→syncMirror）也必须 fail-safe");
      assert.equal(store.count(), 1, "store 写入不受 mirror 失败影响");
    } finally {
      mirror.sync = original;
    }
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
