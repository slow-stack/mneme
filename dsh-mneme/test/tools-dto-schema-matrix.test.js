// issue #195：全工具矩阵的「DTO 键集 ⊆ output schema」系统性断言——防 #184 类漂移。
//
// 背景：#184 是 memory_get 的内联 output schema 漏声明了 v0.8.1 新增的 scope 来源
// 三键，而 schema 是 `additionalProperties: false`——toApiList 条件展开的键一旦没被
// 声明，宿主 in-process 校验直接拒收（"invalid output"），表现为「个别 id 必失败、
// 多数正常」。单点回归（tools-memory-get-schema.test.js）只护住了 memory_get 一个
// 工具：换一个工具、换一个键，同类事故可以原样重演。
//
// 这里把护栏提到矩阵层，四层断言各管一段：
//   A 实跑：9 个工具每个可安全触达的分支，拿**真实 execute 的返回值**过生产同款校验器
//      （validateJsonSchemaValue）——不写手抄的期望值，让运行时自己说话；
//   B 产地：DTO 的唯一产地 service.toApiList 在全形态数据下的输出 ⊆ MEMORY_ITEM_SCHEMA，
//      并反向要求声明里的每个键都被至少一种形态真实产出（声明了却永不出现的键＝死声明，
//      会在下一次 schema 增键时立刻暴露）；
//   C 结构：每个工具的 schema 必须闭合（additionalProperties:false）、required ⊆ properties、
//      每项都带 type——否则 A/B 两层会因为校验器形同虚设而静默失效；
//   D 负例锁：故意注入一个未声明键，断言校验器必须报错。没有这一层，上面三层可以一起
//      绿着却毫无保护力（校验器被换掉、schema 被放开都会静默通过）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools, MEMORY_ITEM_SCHEMA } from "../src/tools.js";

// 矩阵清单：新增工具必须同时补进本文件的分支表，否则下面第一条断言会先失败提醒
// ——这是「系统性」的含义：漏一个工具不会静默通过。
const TOOL_NAMES = [
  "memory_save",
  "memory_search",
  "memory_list",
  "memory_get",
  "memory_update",
  "memory_delete",
  "memory_forget",
  "memory_archive",
  "memory_register_document",
  "memory_runtime",
  "set_scope_state"
];

function setup(config = {}) {
  const store = createStore(":memory:");
  // config 同时喂 service 与 tools：#230 起 registerDocument 的闸在 service
  // 侧读同一个 config，只喂 tools 会让注册工具在矩阵里永远抛 disabled。
  const service = createService({ store, mirror: null, config });
  const registered = [];
  const ctx = {
    tools: {
      register(def) {
        registered.push(def);
        return () => {};
      }
    }
  };
  createTools(ctx, service, config, undefined);
  const byName = Object.fromEntries(registered.map((def) => [def.name, def]));
  return { store, service, byName };
}

// 驱动一个工具并立刻用它自己声明的 schema 校验真实返回值。
// 返回 { value }：调用方需要时再对值做语义断言。
async function drive(byName, name, args = [], exec) {
  const tool = byName[name];
  assert.ok(tool, `工具 ${name} 未注册`);
  const value = await tool.execute(args, exec);
  assertMatches(byName, name, value, `args=${JSON.stringify(args)}`);
  return value;
}

// 真实返回值必须被声明 schema 完全覆盖；失败时把违规明细一起抛出，定位更快。
function assertMatches(byName, name, value, label) {
  const errors = validateJsonSchemaValue(byName[name].output.schema, value);
  assert.deepEqual(
    errors,
    [],
    `${name} 的真实返回未被 output schema 覆盖（${label}）：${JSON.stringify(errors)}\n返回键：${JSON.stringify(Object.keys(value ?? {}))}`
  );
}

// 全形态种子：toApiList 的 7 个条件键只在对应列非 undefined 时展开，所以每种形态
// 都要真实落一行，否则 B 层会（正确地）报「声明了却从未产出」。
function seedShapes(store) {
  const rows = [];
  const push = (over) => {
    const memory = {
      type: "project",
      title: `shape-${rows.length}`,
      content: `形态 ${rows.length} 的正文`,
      source: "test",
      ...over
    };
    // #230：document 走存储层唯一铸造口（通用 save 拒绝 document）。
    rows.push(memory.type === "document" ? store.saveDocument(memory) : store.save(memory));
  };
  push({}); // 极简形态：只有基础键
  push({ sensitivity: "personal" });
  push({ occurred_at: "2026-09-15T00:00:00Z" });
  push({ agent_scope: "coder", workspace_scope: "proj-alpha" });
  push({
    // 全量标注：#184 的原始触发形态
    agent_scope: "coder",
    agent_scope_source: "auto",
    workspace_scope: "proj-alpha",
    workspace_scope_source: "explicit",
    scope_decided_at: "2026-09-15T00:00:00Z",
    sensitivity: "personal",
    occurred_at: "2026-09-14T12:00:00Z",
    tags: ["shape", "annotated"],
    importance: 5
  });
  // #230：document 指针行——doc_path 是 toApiList 的条件键，必须有一行真的产出它。
  push({ type: "document", title: "shape-doc", content: "指针行摘要", doc_path: "X:\\seed\\doc.md", evidence: [] });
  return rows;
}

test("工具矩阵与 TOOL_NAMES 清单一致（新增工具必须补进矩阵）", () => {
  const { byName } = setup();
  assert.deepEqual(Object.keys(byName).sort(), [...TOOL_NAMES].sort());
});

test("A 实跑：11 个工具每个可安全触达的分支，真实返回 ⊆ 声明的 output schema", async () => {
  const { store, service, byName } = setup({ documentMemoryEnabled: true });
  const shapes = seedShapes(store);
  const annotated = shapes[shapes.length - 1];
  const plain = shapes[0];
  const driven = new Set();

  const note = (name) => driven.add(name);

  // --- memory_save：created 与 merged 两条分支 ---
  await drive(byName, "memory_save", { type: "project", title: "save-new", content: "首次写入" });
  note("memory_save");
  await drive(byName, "memory_save", { type: "project", title: "save-new", content: "同键再写 → merged" });
  // 显式 scope + 敏感度 + 事件时间：把「条件展开的键」真的写进库（#184 的真实入口）
  const scopedSave = await drive(byName, "memory_save", {
    type: "preference",
    title: "save-scoped",
    content: "带显式 scope 的写入",
    agent_scope: "global",
    workspace_scope: "proj-beta",
    sensitivity: "personal",
    occurred_at: "2026-09-16T00:00:00Z"
  });
  assert.ok(scopedSave.id, "memory_save 必须回传 id");

  // --- memory_search：命中 / 空结果 / 显式 keyword 档 ---
  const hit = await drive(byName, "memory_search", { query: "形态" });
  assert.ok(hit.items.length > 0, "关键词检索应当命中种子行");
  await drive(byName, "memory_search", { query: "绝不存在的检索词-195" });
  await drive(byName, "memory_search", { query: "形态", mode: "keyword", limit: 2 });
  // occurred 时间窗分支（tools.js 的 occurredWindow 接线）
  await drive(byName, "memory_search", { query: "形态", occurred_from: "2026-01-01", occurred_to: "2026-12-31" });
  note("memory_search");

  // --- memory_list：默认 / 类型过滤 / 含归档 / 分页 / occurred 窗口 ---
  await drive(byName, "memory_list", {});
  await drive(byName, "memory_list", { type: "project", limit: 1, offset: 1 });
  await drive(byName, "memory_list", { include_archived: true });
  await drive(byName, "memory_list", { occurred_from: "2026-01-01", occurred_to: "2026-12-31" });
  note("memory_list");

  // --- memory_get：极简行 / 全量标注行（#184 的原始现场） ---
  await drive(byName, "memory_get", { id: plain.id });
  await drive(byName, "memory_get", { id: annotated.id });
  note("memory_get");

  // --- memory_update：字段修正 + 显式 scope 纠正（另一条会展开条件键的写路径） ---
  await drive(byName, "memory_update", { id: plain.id, title: "shape-0 renamed", importance: 4 });
  await drive(byName, "memory_update", {
    id: plain.id,
    content: "改过的正文",
    agent_scope: "global",
    workspace_scope: "proj-gamma",
    reason: "issue #195 矩阵覆盖"
  });
  note("memory_update");

  // --- memory_delete：删得掉 / 删不掉（不存在 → false，不抛错） ---
  const doomed = store.save({ type: "history", title: "doomed", content: "待删", source: "test" });
  const deleted = await drive(byName, "memory_delete", { id: doomed.id });
  assert.equal(deleted.deleted, true);
  const notDeleted = await drive(byName, "memory_delete", { id: "no-such-id-195" });
  assert.equal(notDeleted.deleted, false);
  note("memory_delete");

  // --- memory_forget / memory_archive：两个方向的分支 ---
  const forgetTarget = store.save({ type: "history", title: "forget-me", content: "待遗忘", source: "test" });
  assert.equal((await drive(byName, "memory_forget", { id: forgetTarget.id })).memory.forgotten, true);
  assert.equal((await drive(byName, "memory_forget", { id: forgetTarget.id, forgotten: false })).memory.forgotten, false);
  note("memory_forget");

  const archiveTarget = store.save({ type: "history", title: "archive-me", content: "待归档", source: "test" });
  assert.equal((await drive(byName, "memory_archive", { id: archiveTarget.id })).memory.archived, true);
  assert.equal((await drive(byName, "memory_archive", { id: archiveTarget.id, archived: false })).memory.archived, false);
  note("memory_archive");

  // --- set_scope_state（#471）：两个方向的分支——按下与松开各驱动一次 ---
  const pressed = await drive(byName, "set_scope_state", { dimension: "workspace", scope_value: "proj-alpha", state: "paused" });
  assert.equal(pressed.scope.state, "paused");
  assert.equal(pressed.scope.scope_value, "proj-alpha");
  const released = await drive(byName, "set_scope_state", { dimension: "workspace", scope_value: "proj-alpha", state: "active" });
  assert.equal(released.scope.state, "active");
  note("set_scope_state");

  // --- memory_runtime：只驱动只读与「无载荷早退」两条分支 ---
  // provision 会联网下载数十至上百 MB（且可能 adopt 本机载荷、硬链接数以百 MB 计），
  // verify 命中载荷时会真实加载模型——两者都不属于单元测试该做的事。status 与其
  // 「无载荷」早退分支已覆盖该 schema 的 summary/status/cost/payloadId/packages/reason
  // 六个键；provision 侧的 strategy/files/bytes 与 verify 侧的 dimension 由 C 层
  // 结构断言兜底（声明合规），分支行为本身留给 e2e/人工验证。
  const emptyRuntimeDir = mkdtempSync(join(tmpdir(), "mneme-195-runtime-"));
  try {
    const rt = setup({ runtimeDir: emptyRuntimeDir });
    await drive(rt.byName, "memory_runtime", { action: "status" });
    await drive(rt.byName, "memory_runtime", { action: "verify" });
    assert.ok(service, "service 保留引用，避免未使用变量告警");
    note("memory_runtime");
  } finally {
    rmSync(emptyRuntimeDir, { recursive: true, force: true });
  }

  // --- memory_register_document（#230）：created 分支 + evidence 求交（含丢弃）。
  // superseded 分支由 document.test.js 覆盖；flag 关闭的拒绝路径同样在那边。
  const docDir = mkdtempSync(join(tmpdir(), "mneme-230-doc-"));
  const docFile = join(docDir, "report.md");
  try {
    writeFileSync(docFile, "# report\n\nbody", "utf8");
    const reg = await drive(byName, "memory_register_document", {
      path: docFile,
      title: "matrix-doc",
      summary: "指针行摘要",
      tags: ["matrix"],
      evidence: [plain.id, "fabricated-230"]
    });
    assert.equal(reg.action, "created");
    assert.equal(reg.evidence_kept, 1);
    assert.equal(reg.evidence_dropped, 1);
    assert.equal(reg.degraded, true);
    note("memory_register_document");
  } finally {
    rmSync(docDir, { recursive: true, force: true });
  }

  assert.deepEqual([...driven].sort(), [...TOOL_NAMES].sort(), "每个工具都必须至少被驱动一次（矩阵不允许空缺）");
});

test("A' 未命中 id 的三个工具按契约抛错（而不是返回半截对象）", async () => {
  const { byName } = setup();
  await assert.rejects(() => byName.memory_get.execute({ id: "missing-195" }), /memory not found/);
  await assert.rejects(() => byName.memory_forget.execute({ id: "missing-195" }), /memory not found/);
  await assert.rejects(() => byName.memory_archive.execute({ id: "missing-195" }), /memory not found/);
});

test("B DTO 产地：toApiList 全形态输出 ⊆ MEMORY_ITEM_SCHEMA，且声明键全部被真实产出", () => {
  const { store, service } = setup();
  seedShapes(store);
  const rows = service.toApiList(service.list({ limit: 100 }));
  assert.ok(rows.length >= 5, "种子行应当全部可读回");

  const observed = new Set();
  for (const dto of rows) {
    const errors = validateJsonSchemaValue(MEMORY_ITEM_SCHEMA, dto);
    assert.deepEqual(errors, [], `toApiList 产出的 DTO 未被 MEMORY_ITEM_SCHEMA 覆盖：${JSON.stringify(errors)}`);
    for (const key of Object.keys(dto)) observed.add(key);
  }

  // 反向：声明的每个键都必须有形态真的产出它。这条让 schema 与种子互相咬合——
  // 以后给 toApiList 增键却忘了补种子，会在这里失败并提醒补形态。
  const declared = Object.keys(MEMORY_ITEM_SCHEMA.properties);
  const neverProduced = declared.filter((key) => !observed.has(key));
  assert.deepEqual(neverProduced, [], `MEMORY_ITEM_SCHEMA 声明了但矩阵从未产出的键（补种子形态或删死声明）：${neverProduced.join(", ")}`);
});

test("B' search / list / get 三个消费方共用同一份 item schema（#184 的根因是有人另抄了一份）", () => {
  const { byName } = setup();
  const itemSchemaOf = (name) => {
    const props = byName[name].output.schema.properties;
    return name === "memory_get" ? props.memory : props.items.items;
  };
  const search = itemSchemaOf("memory_search");
  const list = itemSchemaOf("memory_list");
  const get = itemSchemaOf("memory_get");
  const keys = (s) => Object.keys(s.properties).sort();

  assert.deepEqual(keys(search), keys(MEMORY_ITEM_SCHEMA));
  assert.deepEqual(keys(list), keys(search));
  assert.deepEqual(keys(get), keys(search));
  for (const [name, schema] of [["search", search], ["list", list], ["get", get]]) {
    assert.equal(schema.additionalProperties, false, `${name} 的 item schema 必须闭合`);
  }
});

test("C 结构：全部 11 个工具的 output schema 闭合、required ⊆ properties、每项带 type", () => {
  const { byName } = setup();
  for (const name of TOOL_NAMES) {
    const schema = byName[name].output.schema;
    assert.ok(schema, `${name} 必须声明 output.schema`);
    assert.equal(schema.additionalProperties, false, `${name} 的 schema 必须闭合（否则未声明键不会被拒收）`);
    assert.equal(schema.type, "object", `${name} 的顶层 schema 必须是 object`);
    for (const key of schema.required ?? []) {
      assert.ok(schema.properties?.[key], `${name}.required 里的 ${key} 不在 properties 中`);
    }
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      assert.ok(prop.type, `${name}.${key} 缺 type——没有 type 的声明校验器无法真正约束它`);
    }
  }
});

test("D 负例锁：注入未声明键时校验器必须报错（否则 A/B/C 三层都是空转）", () => {
  const { store, service, byName } = setup();
  const row = store.save({ type: "project", title: "negative-control", content: "负例", source: "test" });
  const dto = service.toApiList([store.getById(row.id)])[0];

  // 正例：干净 DTO 必须通过
  assert.deepEqual(validateJsonSchemaValue(MEMORY_ITEM_SCHEMA, dto), []);
  assert.deepEqual(validateJsonSchemaValue(byName.memory_get.output.schema, { memory: dto }), []);

  // 负例：多一个键就必须被拒——这正是 #184 的形状
  const poisoned = { ...dto, agent_scope_source_new: "auto" };
  assert.notDeepEqual(
    validateJsonSchemaValue(MEMORY_ITEM_SCHEMA, poisoned),
    [],
    "未声明键必须被拒收：#184 类漂移就是靠这条被抓出来的"
  );
  assert.notDeepEqual(
    validateJsonSchemaValue(byName.memory_get.output.schema, { memory: poisoned }),
    [],
    "memory_get 的 schema 同样必须拒收未声明键"
  );
});
