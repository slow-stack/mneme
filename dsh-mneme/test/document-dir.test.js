import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDocumentIndex } from "../src/document-index.js";
import { isManagedDocumentPath, resolveDocumentDir } from "../src/document.js";
import { createMirror } from "../src/mirror.js";
import { createService } from "../src/service.js";
import { createStore } from "../src/store.js";
import { testConfig } from "./helpers/test-config.js";

// 回归（issue #296 第二批）：document 的落盘目录与归属。
// ①`documentDir` 默认跟随 memoryDir 的 `<memoryDir>/documents/`，`~` 与相对路径
//   按 memoryDir 同一套解析；②managed / external 的边界（目录内的文件是机器产物
//   的一部分，目录外只登记指针行）；③`index.md` 整文件机器所有、可从库重建；
//   ④镜像侧 documents.md 是只读指针视图（另见 test/mirror-types.test.js）。

function tempDir() {
  return mkdtempSync(join(tmpdir(), "dsh-mneme-docdir-"));
}

test("#296: documentDir 默认为 memoryDir 下的 documents，三种路径写法都可解析", () => {
  const memoryDir = join(tmpdir(), "dsh-mneme-memory");
  assert.equal(resolveDocumentDir(memoryDir, ""), resolve(memoryDir, "documents"), "空 = 跟随 memoryDir");
  assert.equal(resolveDocumentDir(memoryDir), resolve(memoryDir, "documents"), "缺省同空串");
  assert.equal(resolveDocumentDir(memoryDir, "./notes"), resolve(memoryDir, "notes"), "相对路径落在 memoryDir 下");
  assert.equal(resolveDocumentDir(memoryDir, "docs"), resolve(memoryDir, "docs"));
  assert.equal(resolveDocumentDir(memoryDir, join(tmpdir(), "elsewhere")), resolve(join(tmpdir(), "elsewhere")), "绝对路径原样用");
  assert.equal(resolveDocumentDir(memoryDir, "~/docs"), resolve(homedir(), "docs"), "~ 展开到 home");
});

test("#296: managed 判定只认目录内的路径（前缀相像的不算）", () => {
  const base = join(tmpdir(), "dsh-mneme-docroot");
  const dir = join(base, "documents");
  assert.equal(isManagedDocumentPath(dir, join(dir, "report.md")), true);
  assert.equal(isManagedDocumentPath(dir, join(dir, "sub", "deep.md")), true, "子目录也算 managed");
  assert.equal(isManagedDocumentPath(dir, dir), true);
  assert.equal(isManagedDocumentPath(dir, join(base, "documents-old", "x.md")), false, "前缀相像的兄弟目录不是 managed");
  assert.equal(isManagedDocumentPath(dir, join(base, "other.md")), false);
  assert.equal(isManagedDocumentPath(dir, ""), false);
  assert.equal(isManagedDocumentPath(dir, undefined), false);
});

test("#296: index.md 只列指针行、可整文件重建、内容不变不落盘", () => {
  const dir = tempDir();
  try {
    const index = createDocumentIndex(join(dir, "documents"));
    const managed = join(dir, "documents", "report.md");
    const rows = [
      { id: "d1", title: "报告", content: "第一句。第二句。", doc_path: managed, updated_at: "2026-02-01T00:00:00.000Z" },
      { id: "d2", title: "外部文档", content: "正文不必进索引。", doc_path: join(dir, "notes.md"), updated_at: "2026-01-01T00:00:00.000Z" }
    ];
    assert.equal(index.sync(rows).changed, true);
    const first = readFileSync(join(dir, "documents", "index.md"), "utf8");
    assert.ok(first.includes("整文件机器所有"), "文件头说清归属");
    assert.equal((first.match(/^- `/gm) ?? []).length, 2, "一行一个 document");
    assert.ok(first.includes("d1") && first.includes("报告") && first.includes(managed), "带定位");
    assert.ok(/\bd1\b.*managed/.test(first), "目录内的标 managed");
    assert.ok(/\bd2\b.*external/.test(first), "目录外的标 external");
    assert.ok(!first.includes("第一句"), "索引不带摘要正文（那是镜像视图的活）");
    // 重建：删掉再同步得到逐字节相同的文件（所以文件里不写生成时间）
    unlinkSync(index.filePath);
    index.sync(rows);
    assert.equal(readFileSync(index.filePath, "utf8"), first, "可从库重建，且逐字节一致");
    // 内容没变就不重写（与镜像同一条「不无谓写盘」纪律）
    assert.equal(index.sync(rows).changed, false);
    // 空集也要有一份合法的索引（不是删文件）
    assert.equal(index.sync([]).changed, true);
    assert.ok(readFileSync(index.filePath, "utf8").includes("机器所有"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#296: 索引写不进去只报失败，不抛（写失败不能连累业务写）", () => {
  const dir = tempDir();
  try {
    // 让目标目录的「父级」是一个普通文件：mkdir 必失败，且不依赖平台错误码
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");
    const index = createDocumentIndex(join(blocker, "documents"));
    const ensured = index.ensure();
    assert.equal(ensured.ok, false, "建目录失败要如实返回（调用方据此 warn）");
    assert.ok(ensured.error, "失败要带原因");
    const result = index.sync([{ id: "d1", title: "t", content: "c", doc_path: "x", updated_at: "2026-01-01T00:00:00.000Z" }]);
    assert.equal(result.ok, false, "失败要如实返回，不能假装成功");
    assert.ok(result.error, "失败要带原因");
    assert.ok(!existsSync(index.filePath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#296: index.md 删掉后从库里重建，逐字节一致", () => {
  const dir = tempDir();
  let store;
  try {
    const documentDir = join(dir, "documents");
    store = createStore(join(dir, "memory.db"));
    const index = createDocumentIndex(documentDir);
    const service = createService({
      store, mirror: createMirror(dir), config: testConfig({ documentMemoryEnabled: true }), documentIndex: index
    });
    writeFileSync(join(dir, "report.md"), "x", "utf8");
    const doc = store.saveDocument({
      type: "document", title: "报告", content: "第一句。第二句。", tags: [], importance: 3,
      source: "tool", evidence: [], doc_path: join(documentDir, "report.md")
    });
    service.saveWithDedupe({ type: "pattern", title: "触发", content: "x" });
    const first = readFileSync(index.filePath, "utf8");
    // 真删文件，再从库同步一次：读数必须一样（这才是「可从库重建」，不是拿同一份
    // 内存数组重算）
    unlinkSync(index.filePath);
    assert.ok(!existsSync(index.filePath));
    service.saveWithDedupe({ type: "pattern", title: "触发2", content: "y" });
    assert.equal(readFileSync(index.filePath, "utf8"), first, "删掉重建后逐字节一致");
    assert.ok(first.includes(doc.id) && first.includes("managed"));
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#296: managed 文件走一次完整注册往返，字节哈希不变", async () => {
  const dir = tempDir();
  let store;
  try {
    const documentDir = join(dir, "documents");
    mkdirSync(documentDir, { recursive: true });
    const docFile = join(documentDir, "report.md");
    writeFileSync(docFile, "# 报告\n\n正文由 agent 写。\n", "utf8");
    const before = createHash("sha256").update(readFileSync(docFile)).digest("hex");
    store = createStore(join(dir, "memory.db"));
    const service = createService({
      store, mirror: createMirror(dir), config: testConfig({ documentMemoryEnabled: true }),
      documentIndex: createDocumentIndex(documentDir)
    });
    const result = await service.registerDocument({ path: docFile, title: "报告", summary: "第一句。第二句。" });
    assert.equal(result.action, "created");
    assert.equal(result.memory.doc_path, resolve(docFile), "指针行落在 managed 路径上");
    assert.equal(
      createHash("sha256").update(readFileSync(docFile)).digest("hex"), before,
      "管线对正文零读零写：注册往返后 managed 文件必须逐字节不变"
    );
    // 同时也确认没有偷偷在 documentDir 里生成第二份「正文」（机器产物只有 index.md）
    assert.deepEqual(readdirSync(documentDir).sort(), ["index.md", "report.md"]);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#296: 两个落点共用 documentMemoryEnabled 闸，闸关时视图与索引一起清掉", () => {
  const dir = tempDir();
  let store;
  try {
    const documentDir = join(dir, "documents");
    store = createStore(join(dir, "memory.db"));
    const index = createDocumentIndex(documentDir);
    const on = createService({
      store, mirror: createMirror(dir), config: testConfig({ documentMemoryEnabled: true }), documentIndex: index
    });
    writeFileSync(join(dir, "outside.md"), "x", "utf8");
    const kept = store.saveDocument({
      type: "document", title: "报告", content: "第一句。第二句。", tags: [], importance: 3,
      source: "tool", evidence: [], doc_path: join(documentDir, "report.md")
    });
    store.saveDocument({
      type: "document", title: "外部", content: "另一份。", tags: [], importance: 3,
      source: "tool", evidence: [], doc_path: join(dir, "outside.md")
    });
    // 任意一次业务写触发写后语（镜像 + 索引一起）
    on.saveWithDedupe({ type: "pattern", title: "触发", content: "x" });
    assert.ok(existsSync(join(dir, "documents.md")), "闸开 → 镜像视图落盘");
    const md = readFileSync(join(dir, "documents.md"), "utf8");
    assert.ok(md.includes("报告") && md.includes(join(documentDir, "report.md")));
    assert.ok(existsSync(index.filePath), "闸开 → 索引落盘");
    assert.ok(readFileSync(index.filePath, "utf8").includes("managed"));

    // 归档一行：索引只列活跃行（与镜像的 coverage: active-only 同口径）
    store.setArchived(kept.id, true);
    on.saveWithDedupe({ type: "pattern", title: "触发1b", content: "w" });
    assert.ok(!readFileSync(index.filePath, "utf8").includes(kept.id), "已归档的行不进索引");

    // 闸关：document 行不再进渲染集 → documents.md 被既有「空 type 删文件」清掉；
    // index.md 归 syncDocumentIndex 清掉——留一份陈旧索引就是「看着还在、其实已关」
    // 的视图，正是 documents.md 在闸关时要避免的那一类。
    const off = createService({ store, mirror: createMirror(dir), config: testConfig({}), documentIndex: index });
    off.saveWithDedupe({ type: "pattern", title: "触发2", content: "y" });
    assert.ok(!existsSync(join(dir, "documents.md")), "闸关 → 镜像视图清掉");
    assert.ok(!existsSync(index.filePath), "闸关 → 索引也清掉");

    // 闸重开：下一次业务写从库重建索引（自愈，不需要手工删文件）
    const back = createService({
      store, mirror: createMirror(dir), config: testConfig({ documentMemoryEnabled: true }), documentIndex: index
    });
    back.saveWithDedupe({ type: "pattern", title: "触发3", content: "z" });
    assert.ok(readFileSync(index.filePath, "utf8").includes("外部"), "闸重开 → 索引从库重建");
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#296: 两条新文案的英文分支也要能渲染（en 实例）", () => {
  const dir = tempDir();
  try {
    // 新文案是 per-language 的 lambda：en 分支此前零调用点，缺键或笔误只在
    // memory.language=en 的实例上炸，而全量测试照样绿（审查指出）。
    const index = createDocumentIndex(join(dir, "documents"), "en");
    index.sync([{
      id: "d1", title: "Report", content: "First sentence. Second.", updated_at: "2026-01-01T00:00:00.000Z",
      doc_path: join(dir, "documents", "report.md")
    }]);
    const indexText = readFileSync(index.filePath, "utf8");
    assert.match(indexText, /document index — dsh-mneme/, "en 的索引头");
    assert.match(indexText, /Machine-owned as a whole/, "en 的归属说明");

    const mirror = createMirror(dir, "en");
    mirror.sync([{
      id: "doc1", type: "document", title: "Report", content: "First sentence. Second.", tags: [],
      importance: 3, forgotten: false, created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z", doc_path: join(dir, "documents", "report.md")
    }]);
    const docs = readFileSync(join(dir, "documents.md"), "utf8");
    assert.match(docs, /read-only view/, "en 的只读视图文件头");
    assert.match(docs, /never the full text/, "en 的只读说明");
    assert.ok(docs.includes("First sentence") && !docs.includes("Second."), "en 下同样只留摘要首句");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
