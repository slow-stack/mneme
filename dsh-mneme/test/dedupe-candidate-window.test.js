// Issue #505：saveWithDedupe 的去重候选窗口固定 100 条，库一变大就静默不再合并。
//
// 根因：候选集是 store.list({ type, limit: 100 })，order 默认 importance
// ⇒「该类型最重要的 100 行」，与「找出同标题的那一行」无关。某类型里 importance
// 高于待写行的行数一旦超过窗口，同标题行与待写行双双落在窗口外，find 恒不命中，
// 于是走创建分支：不报错、不告警，合并语义随库增长而失效。
//
// 这组用例刻意复刻报告里的实测形状（类型 1047 行、其中 importance=5 有 180 行），
// 但用更小的数字达成同样的窗口溢出，避免测试本身变慢。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

function freshService() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  return { store, service };
}

// 往某个类型里灌 n 条 importance=5 的行，把窗口挤满。
function crowdType(store, type, n) {
  for (let i = 0; i < n; i++) {
    store.save({
      type,
      title: `crowd-${type}-${i}`,
      content: `padding row ${i}`,
      importance: 5
    });
  }
}

test("#505: 同类型 importance 更高的行超过窗口后，同标题第二次写入仍然合并", () => {
  const { store, service } = freshService();
  // 窗口是 100。灌 120 条 importance=5，保证待写行（importance=3）与它的同标题
  // 行都排不进前 100。
  crowdType(store, "project", 120);

  const payload = {
    type: "project",
    title: "dedupe-target",
    content: "first content",
    importance: 3
  };
  const first = service.saveWithDedupe(payload);
  assert.equal(first.action, "created", "第一次写入应当是新建");

  const second = service.saveWithDedupe({ ...payload, content: "second content" });
  assert.equal(
    second.action,
    "merged",
    "第二次同标题写入必须并入已有行；返回 created 说明候选窗口把同标题行挡在窗口外（#505 静默降级）"
  );
  assert.equal(second.memory.id, first.memory.id, "合并必须落在同一行");

  const rows = store.list({ type: "project", limit: null })
    .filter((m) => m.title.trim() === "dedupe-target");
  assert.equal(rows.length, 1, "同标题只应存在一行");
});

test("#505: 定向候选不受 importance 分布影响（低 importance 的同标题行也能命中）", () => {
  const { store, service } = freshService();
  // 先写一条 importance=1 的目标行，再用大量 importance=5 的行把它挤出窗口。
  const first = service.saveWithDedupe({
    type: "pattern",
    title: "low-importance-target",
    content: "seed",
    importance: 1
  });
  assert.equal(first.action, "created");

  crowdType(store, "pattern", 120);

  const second = service.saveWithDedupe({
    type: "pattern",
    title: "low-importance-target",
    content: "merged later",
    importance: 1
  });
  assert.equal(second.action, "merged", "低 importance 的同标题行同样必须能被找到");
  assert.equal(second.memory.id, first.memory.id);
});

test("#505: 标题首尾空白不影响去重命中（入库不 trim，比较 trim）", () => {
  const { store, service } = freshService();
  crowdType(store, "constraint", 120);

  const first = service.saveWithDedupe({
    type: "constraint",
    title: "  spaced title  ",
    content: "seed",
    importance: 3
  });
  assert.equal(first.action, "created");

  // 同一个标题、首尾空白写法不同——按 trim 口径应当命中同一行。
  const second = service.saveWithDedupe({
    type: "constraint",
    title: "spaced title",
    content: "merged",
    importance: 3
  });
  assert.equal(second.action, "merged", "trim 后同标题必须合并，否则存量带空白的标题会退回静默降级");
  assert.equal(second.memory.id, first.memory.id);
});

test("#505: 定向候选不跨类型命中", () => {
  const { store, service } = freshService();
  crowdType(store, "project", 120);

  const a = service.saveWithDedupe({
    type: "project",
    title: "same-title-different-type",
    content: "in project",
    importance: 3
  });
  const b = service.saveWithDedupe({
    type: "preference",
    title: "same-title-different-type",
    content: "in preference",
    importance: 3
  });
  assert.equal(a.action, "created");
  assert.equal(b.action, "created", "不同 type 的同标题行不得合并");
  assert.notEqual(a.memory.id, b.memory.id);
});

test("#505: 归档行不作为合并目标（口径与 list 默认一致）", () => {
  const { store, service } = freshService();
  crowdType(store, "decision", 120);

  const first = service.saveWithDedupe({
    type: "decision",
    title: "archived-target",
    content: "seed",
    importance: 3
  });
  // 归档必须走 store.setArchived——store.update 的 SET 子句里没有 archived 列，
  // 用 update({archived:true}) 根本不会归档，测试会假绿。
  store.setArchived(first.memory.id, true);

  const second = service.saveWithDedupe({
    type: "decision",
    title: "archived-target",
    content: "after archive",
    importance: 3
  });
  assert.equal(second.action, "created", "已归档行不该被当作活跃合并目标");
  assert.notEqual(second.memory.id, first.memory.id);
});


// #505 把「取该类型前 100 条」换成「按 type + TRIM(title) 精确取」：窗口没了、静默不
// 合并也没了，但 SQL 形状变了——代价随最大类型的行数线性长（20000 行时 4.6ms 一次，
// 每存一条付一次），所以 store.js 里配了 (type, TRIM(title)) 表达式索引。这条用例不测
// 快慢（机器有关节，数字不可复现），测的是**那条索引真的被这条查询选中**：表达式写歪
// 一点（漏 TRIM、列序不对）优化器就静默退回扫整个类型，而本文件其余用例全绿。
test("#505: 定向候选那条 SQL 命中表达式索引，而不是扫完整个类型", () => {
  const dir = mkdtempSync(join(tmpdir(), "mneme-dedupe-idx-"));
  const file = join(dir, "m.db");
  const store = createStore(file);
  store.save({ type: "project", title: "  spaced  ", content: "x", importance: 3 });
  store.close();
  const db = new DatabaseSync(file);
  try {
    // WHERE 与 store.js 的 activeByTypeAndTitle 逐字同形，只把列表换成单列。
    const plan = db.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM memories WHERE type = ? AND TRIM(title) = ? AND forgotten = 0 AND archived = 0"
    ).all("project", "spaced").map((r) => r.detail).join(" ");
    assert.match(plan, /idx_memories_type_trimmed_title/,
      `定向候选必须走 (type, TRIM(title)) 表达式索引，实得：${plan}`);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
