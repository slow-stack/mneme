import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createStore } from "../src/store.js";
import { createMirror } from "../src/mirror.js";
import { createService } from "../src/service.js";
import { applyDecisions } from "../src/dream.js";
import { testConfig } from "./helpers/test-config.js";

const CONFLICT_MARKER = "并发冲突";

/**
 * Regression tests for the mirror-digest fix: a machine store write that has
 * not yet been re-rendered to the mirror must NOT be misread as a concurrent
 * human edit (which lost the machine write and planted a fake conflict marker).
 * Each machine-write path runs against a stale mirror file (the pre-transaction
 * render), exactly like the audited reproductions.
 */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-digest-"));
  const store = createStore(":memory:");
  const mirror = createMirror(dir);
  const service = createService({ store, mirror, config: testConfig({}) });
  return { dir, store, mirror, service };
}

function mirrorFile(dir, type) {
  return join(dir, { preference: "preferences.md", project: "projects.md", decision: "decisions.md", history: "history.md" }[type]);
}

function digestOf(title, content) {
  return createHash("sha256").update(`${title}\x00${content}`).digest("hex");
}

test("digest 匹配：直接 update 后机器写落地、无伪冲突 marker", () => {
  const { dir, store, service } = setup();
  try {
    const { memory: m } = service.saveWithDedupe({ type: "project", title: "直接更新", content: "v1", importance: 3 });
    service.update(m.id, { content: "v2" });
    // 镜像此时还是 v1 的旧渲染；digest 仍匹配 → 机器 wins
    assert.equal(store.getById(m.id).content, "v2", "机器新值必须落地");
    assert.ok(!store.getById(m.id).content.includes(CONFLICT_MARKER), "不得出现伪冲突 marker");
    const file = readFileSync(mirrorFile(dir, "project"), "utf8");
    assert.match(file, /v2/, "镜像已重渲染为新值");
    assert.ok(!file.includes(CONFLICT_MARKER), "镜像不得包含伪冲突 marker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digest 匹配：事务内 update 后机器写落地、无伪冲突 marker", () => {
  const { dir, store, service } = setup();
  try {
    const { memory: m } = service.saveWithDedupe({ type: "project", title: "事务更新", content: "tx v1", importance: 3 });
    service.transaction(() => {
      service.update(m.id, { content: "tx v2" });
    });
    assert.equal(store.getById(m.id).content, "tx v2", "事务内机器新值必须落地");
    assert.ok(!store.getById(m.id).content.includes(CONFLICT_MARKER), "不得出现伪冲突 marker");
    const file = readFileSync(mirrorFile(dir, "project"), "utf8");
    assert.match(file, /tx v2/, "镜像已重渲染为新值");
    assert.ok(!file.includes(CONFLICT_MARKER), "镜像不得包含伪冲突 marker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digest 匹配：saveWithDedupe 同标题 merge 后新值落地、无伪冲突 marker", () => {
  const { dir, store, service } = setup();
  try {
    service.saveWithDedupe({ type: "preference", title: "语言", content: "旧内容", importance: 3 });
    const result = service.saveWithDedupe({ type: "preference", title: "语言", content: "新内容", importance: 5 });
    assert.equal(result.action, "merged");
    assert.equal(store.count(), 1, "同标题合并不新增条目");
    const m = service.getById(result.memory.id);
    // Bug5: 同标题合并不是覆盖，而是追加（旧内容 + --- 分隔 + 新内容）
    assert.ok(m.content.includes("旧内容"), "合并后旧内容保留在追加正文");
    assert.ok(m.content.includes("新内容"), "合并后新值必须落地");
    assert.ok(!m.content.includes(CONFLICT_MARKER), "不得出现伪冲突 marker");
    const file = readFileSync(mirrorFile(dir, "preference"), "utf8");
    assert.match(file, /新内容/, "镜像已重渲染为新值");
    assert.ok(!file.includes(CONFLICT_MARKER), "镜像不得包含伪冲突 marker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digest 匹配：Dream merge 后 keeper 是新值、无伪冲突、source 归档", () => {
  const { dir, store, service } = setup();
  try {
    const a = service.saveWithDedupe({ type: "project", title: "DreamKeeper", content: "keep old", importance: 3 });
    const b = service.saveWithDedupe({ type: "project", title: "DreamSource", content: "src old", importance: 3 });
    // 真实 applyDecisions 路径：keeper 更新 + source 归档在同一事务里，
    // 提交时 syncMirror 读到的是事务前渲染的旧镜像 → 修复前会误判为人工编辑。
    const { applied, failures } = applyDecisions(
      [{ action: "merge", ids: [a.memory.id, b.memory.id], keepSource: a.memory.id, title: "DreamKeeper", content: "keeper new", importance: 5 }],
      service,
      null,
      null
    );
    assert.equal(applied, 1);
    assert.equal(failures.length, 0);
    const keeper = store.getById(a.memory.id);
    assert.equal(keeper.content, "keeper new", "keeper 必须是合并后的新值");
    assert.equal(keeper.title, "DreamKeeper");
    assert.ok(!keeper.content.includes(CONFLICT_MARKER), "keeper 不得出现伪冲突 marker");
    assert.equal(store.getById(b.memory.id).archived, true, "source 必须归档");
    const file = readFileSync(mirrorFile(dir, "project"), "utf8");
    assert.match(file, /keeper new/, "镜像已重渲染为新值");
    assert.ok(!file.includes(CONFLICT_MARKER), "镜像不得包含伪冲突 marker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("真实人工编辑控制组：只改文件 → 人工 wins、无 marker（store 未变）", () => {
  const { dir, store, service } = setup();
  try {
    service.saveWithDedupe({ type: "preference", title: "语言", content: "机器内容", importance: 3 });
    // 人工改文件内容，但保留 digest 注释行（digest 已不匹配）
    const file = mirrorFile(dir, "preference");
    writeFileSync(file, readFileSync(file, "utf8").replace("机器内容", "人类编辑内容"), "utf8");
    // 下一次无关 store 写触发 syncMirror → 必须合并人工编辑回 store
    service.saveWithDedupe({ type: "project", title: "无关", content: "x", importance: 3 });
    const m = service.list({ type: "preference", includeArchived: true }).find((p) => p.title === "语言");
    assert.equal(m.content, "人类编辑内容", "人工编辑必须合并回 store");
    assert.ok(!m.content.includes(CONFLICT_MARKER), "store 未变时不得出现冲突 marker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("真实人工编辑控制组：文件与 store 同时变更 → 三方合并保留双方 + marker", () => {
  const { dir, store, service } = setup();
  try {
    const { memory: m } = service.saveWithDedupe({ type: "preference", title: "语言", content: "机器内容", importance: 3 });
    // 人工改文件（digest 行保留但内容已变）
    const file = mirrorFile(dir, "preference");
    writeFileSync(file, readFileSync(file, "utf8").replace("机器内容", "人类编辑内容"), "utf8");
    // 机器并发改 store → 下一次 sync 必须三方合并，保留双方 + marker
    service.update(m.id, { content: "并发机器版本" });
    const updated = service.getById(m.id);
    assert.ok(updated.content.includes("人类编辑内容"), "人工版本必须保留为头部");
    assert.ok(updated.content.includes("并发机器版本"), "store 并发版本必须保留");
    assert.ok(updated.content.includes(CONFLICT_MARKER), "必须出现真正的冲突 marker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("老文件无 digest → 保守走三方合并（保留双方 + marker）", () => {
  const { dir, store, service } = setup();
  try {
    const { memory: m } = service.saveWithDedupe({ type: "history", title: "旧", content: "旧内容", importance: 3 });
    // 模拟修复前渲染的老文件：去掉 digest 注释行，但内容仍是旧内容
    const file = mirrorFile(dir, "history");
    const rendered = readFileSync(file, "utf8");
    writeFileSync(file, rendered.replace(/<!--\s*mirror-digest: [a-f0-9]+ -->\n?/g, ""), "utf8");
    // 机器更新 → 无 digest 必须保守视为人工动过 → 三方合并
    service.update(m.id, { content: "新机器内容" });
    const updated = service.getById(m.id);
    assert.ok(updated.content.includes("旧内容"), "老文件内容必须被保留");
    assert.ok(updated.content.includes("新机器内容"), "机器新版本必须被保留");
    assert.ok(updated.content.includes(CONFLICT_MARKER), "必须出现冲突 marker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digest 从 body 剥除：读回的 content 不含 digest 注释，digest 字段正确", () => {
  const { dir, mirror, service } = setup();
  try {
    const { memory: m } = service.saveWithDedupe({ type: "decision", title: "剥离", content: "line1\nline2", importance: 3 });
    const edits = mirror.readHumanEdits("decision");
    const edit = edits.find((e) => e.id === m.id);
    assert.ok(edit, "读到该条目");
    assert.equal(edit.title, "剥离");
    assert.equal(edit.content, "line1\nline2", "正文必须不含结构字段");
    assert.ok(!edit.content.includes("mirror-digest"), "content 不得包含 digest 注释");
    assert.ok(!edit.content.includes("<!--"), "content 不得包含任何 HTML 注释");
    assert.equal(edit.digest, digestOf("剥离", "line1\nline2"), "digest 字段暴露给 reconcile 使用");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
