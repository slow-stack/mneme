// 知识库第二层（src/kb/**）的回归锁。锁五件事：
// 1) 三张 kb_* 表在空库上打开即建（幂等迁移面），且 memories 表不受影响；
// 2) 集合建/改名/删除的正确语义（删集合连带删文档与分块，不留孤儿行）；
// 3) 同一 rel_key + 同 sha256 重入库是 no-op —— 这条是幂等契约本身，回归了就是
//    「编辑器保存一次 → 全量重切块」的性能事故；
// 4) 内容变了要真替换：旧块不能残留（残留会让检索命中已删除的段落）；
// 5) 检索能命中、readDoc 能把原文逐字节还原（切块必须严格连续按行）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createStore } from "../src/store.js";
import { createKb } from "../src/kb/index.js";

// Windows 上 %TEMP% 里刚写完的文件会被 Defender 短暂持锁，rmSync 撞 EPERM 是
// 瞬时抖动不是用例失败（与 test/wiki-store.test.js 同一处踩坑）。
async function rmTempEventually(dir) {
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(200);
    }
  }
}

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "kb-test-"));
}

function writeDoc(dir, name, content) {
  const abs = join(dir, name);
  writeFileSync(abs, content, "utf8");
  return abs;
}

function newKb() {
  const store = createStore(":memory:");
  return { store, kb: createKb({ store, cfg: {} }) };
}

test("新库打开即建三张 kb_* 表，且不碰 memories 表", () => {
  const { store } = newKb();
  for (const name of ["kb_collections", "kb_docs", "kb_chunks"]) {
    const row = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
    assert.ok(row, `缺表 ${name}`);
  }
  // 物理隔离的另一半：知识库的表不得出现在记忆行池的查询里。这里锁的是「memories
  // 仍只有它自己那一份」，防止有人日后把 kb 行灌进 memories 图省事。
  const memCount = store.db.prepare("SELECT COUNT(*) AS c FROM memories").get().c;
  assert.equal(memCount, 0);
  store.close();
});

test("createKb 建/改名/列集合，计数随文档与分块变化", async () => {
  const { store, kb } = newKb();
  const dir = makeTempDir();
  try {
    kb.upsertCollection({ key: "manual", title: "手册", description: "内部手册" });
    let list = kb.listCollections();
    assert.equal(list.length, 1);
    assert.deepEqual(
      { key: list[0].key, title: list[0].title, description: list[0].description, docs: list[0].docs, chunks: list[0].chunks },
      { key: "manual", title: "手册", description: "内部手册", docs: 0, chunks: 0 }
    );

    // 同名 key 再 upsert 是「改名」不是「新建」：created_at 不动、行数不增。
    kb.upsertCollection({ key: "manual", title: "手册v2", description: "" });
    list = kb.listCollections();
    assert.equal(list.length, 1);
    assert.equal(list[0].title, "手册v2");

    const src = writeDoc(dir, "a.md", "# 标题\n\n## 安装\n跑 npm install 就行。\n");
    const r = await kb.ingest({ collection: "manual", kind: "file", source: src });
    assert.equal(r.error, undefined);
    assert.equal(r.skipped, false);
    assert.ok(r.chunks >= 1);

    list = kb.listCollections();
    assert.equal(list[0].docs, 1);
    assert.equal(list[0].chunks, r.chunks);
  } finally {
    await rmTempEventually(dir);
    store.close();
  }
});

test("同 sha256 重入库 no-op；内容变了才重切块并清掉旧块", async () => {
  const { store, kb } = newKb();
  const dir = makeTempDir();
  try {
    kb.upsertCollection({ key: "c", title: "c" });
    const src = writeDoc(dir, "doc.md", "## 甲\n第一版正文 alpha\n");

    const first = await kb.ingest({ collection: "c", kind: "file", source: src });
    assert.equal(first.skipped, false);

    // 同一份内容（哪怕 mtime 变了）不许重切块 —— 幂等契约。
    await sleep(10);
    writeFileSync(src, "## 甲\n第一版正文 alpha\n", "utf8");
    const again = await kb.ingest({ collection: "c", kind: "file", source: src });
    assert.equal(again.skipped, true, "同 sha256 必须 skipped");
    assert.equal(again.docId, first.docId, "skipped 时 docId 应指向既有文档");
    assert.equal(again.chunks, first.chunks, "skipped 时 chunks 应是库里现有块数");
    assert.equal(store.kbChunksByDoc(first.docId).length, first.chunks);

    // 内容变了：替换，旧块不能残留（否则检索会命中已删除的段落）。
    writeFileSync(src, "## 乙\n第二版正文 beta only\n", "utf8");
    const changed = await kb.ingest({ collection: "c", kind: "file", source: src });
    assert.equal(changed.skipped, false);
    assert.equal(changed.docId, first.docId, "同一 rel_key 复用文档行");
    const texts = store.kbChunksByDoc(changed.docId).map((c) => c.text).join("\n");
    assert.ok(texts.includes("beta"), "新内容要进来");
    assert.ok(!texts.includes("alpha"), "旧分块必须被清掉");
    assert.equal(kb.search({ query: "alpha", collection: "c" }).hits.length, 0);
    assert.equal(kb.search({ query: "beta", collection: "c" }).hits.length, 1);
  } finally {
    await rmTempEventually(dir);
    store.close();
  }
});

test("检索命中带集合/相对键/节标题/行号/摘录；集合过滤生效", async () => {
  const { store, kb } = newKb();
  const dir = makeTempDir();
  try {
    kb.upsertCollection({ key: "a", title: "A" });
    kb.upsertCollection({ key: "b", title: "B" });
    const f1 = writeDoc(dir, "one.md", "# 一\n\n## 部署\n部署用 docker compose 起服务。\n\n## 回滚\n回滚走 git revert。\n");
    const f2 = writeDoc(dir, "two.md", "## 数据库\n数据库是 SQLite，用 WAL 模式。\n");
    await kb.ingest({ collection: "a", kind: "file", source: f1 });
    await kb.ingest({ collection: "b", kind: "file", source: f2 });

    const hit = kb.search({ query: "docker" });
    assert.equal(hit.hits.length, 1);
    assert.equal(hit.hits[0].collection, "a");
    assert.equal(hit.hits[0].relKey, f1);
    assert.equal(hit.hits[0].heading, "部署");
    // 块从它自己那节的 `## 部署` 行起算（第 3 行）——第一节是 "# 一" + 空行。
    assert.equal(hit.hits[0].line, 3, "命中块起始行按行连续切回算");
    assert.ok(hit.hits[0].excerpt.includes("docker"));
    assert.deepEqual(hit.unreadable, []);

    // 单集合过滤：查 B 才有的词，限定 a 应无命中。
    assert.equal(kb.search({ query: "SQLite", collection: "a" }).hits.length, 0);
    assert.equal(kb.search({ query: "SQLite", collection: "b" }).hits.length, 1);

    // 中文查询也能命中（tokenize 的 CJK bigram 路径）。
    const zh = kb.search({ query: "回滚" });
    assert.equal(zh.hits.length, 1);
    assert.equal(zh.hits[0].heading, "回滚");

    // 空 query 不报错也不返回全库。
    assert.deepEqual(kb.search({ query: "   " }), { hits: [], unreadable: [] });
  } finally {
    await rmTempEventually(dir);
    store.close();
  }
});

test("readDoc 逐字节还原原文（切块必须严格连续、不剥空行）", async () => {
  const { store, kb } = newKb();
  const dir = makeTempDir();
  try {
    kb.upsertCollection({ key: "c", title: "c" });
    const original = [
      "# 大标题",
      "",
      "引言段落，含**markdown**。",
      "",
      "## 第一节",
      "",
      "第一段。",
      "",
      "第二段。",
      "",
    ].join("\n");
    const src = writeDoc(dir, "big.md", original);
    await kb.ingest({ collection: "c", kind: "file", source: src });

    const doc = kb.readDoc({ collection: "c", relKey: src });
    assert.ok(doc, "readDoc 应命中");
    assert.equal(doc.content, original);
    assert.equal(doc.title, "big.md");
    assert.equal(doc.status, "ok");

    // 查不到的组合返回 null（面板据此走空态），不抛。
    assert.equal(kb.readDoc({ collection: "c", relKey: "/nope.md" }), null);
    assert.equal(kb.readDoc({ collection: "nope", relKey: src }), null);
  } finally {
    await rmTempEventually(dir);
    store.close();
  }
});

test("listDocs 给出面板要的文档列表；删集合连带清文档与分块", async () => {
  const { store, kb } = newKb();
  const dir = makeTempDir();
  try {
    kb.upsertCollection({ key: "c", title: "c" });
    const src = writeDoc(dir, "x.md", "## 节\n内容 content\n");
    const r = await kb.ingest({ collection: "c", kind: "file", source: src });

    const docs = kb.listDocs({ collection: "c" });
    assert.equal(docs.length, 1);
    assert.deepEqual(Object.keys(docs[0]).sort(), ["bytes", "error", "indexedAt", "kind", "relKey", "status", "title"]);
    assert.equal(docs[0].relKey, src);
    assert.equal(docs[0].kind, "file");
    assert.equal(docs[0].status, "ok");
    assert.equal(docs[0].error, null);
    assert.ok(docs[0].bytes > 0);

    assert.equal(kb.deleteCollection("c"), true);
    assert.equal(kb.deleteCollection("c"), false, "再删一次是 false 不是抛错");
    assert.equal(kb.listCollections().length, 0);
    assert.equal(kb.listDocs({ collection: "c" }).length, 0);
    // 孤儿行是隐性占空间：文档行与分块行都要真没了。
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM kb_docs").get().c, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM kb_chunks").get().c, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM kb_docs WHERE id = ?").get(r.docId).c, 0);
  } finally {
    await rmTempEventually(dir);
    store.close();
  }
});

test("入库失败留痕不静默：来源不存在 / 集合不存在 / kind 非法都回 error", async () => {
  const { store, kb } = newKb();
  const dir = makeTempDir();
  try {
    kb.upsertCollection({ key: "c", title: "c" });

    const missing = await kb.ingest({ collection: "c", kind: "file", source: join(dir, "nope.md") });
    assert.equal(missing.error, "file-not-found");
    // 失败要能出现在面板上（否则用户看到的是「点了没反应」）。
    const docs = kb.listDocs({ collection: "c" });
    assert.equal(docs.length, 1);
    assert.equal(docs[0].status, "error");
    assert.equal(docs[0].error, "file-not-found");

    const noCol = await kb.ingest({ collection: "ghost", kind: "file", source: join(dir, "nope.md") });
    assert.equal(noCol.error, "collection-not-found");
    assert.equal(kb.listCollections().length, 1, "拼错的 key 不许凭空建集合");

    const badKind = await kb.ingest({ collection: "c", kind: "pdf", source: join(dir, "nope.md") });
    assert.equal(badKind.error, "bad-kind");
  } finally {
    await rmTempEventually(dir);
    store.close();
  }
});

test("dispose 之后不再持有索引缓存（可安全重复调用）", async () => {
  const { store, kb } = newKb();
  const dir = makeTempDir();
  try {
    kb.upsertCollection({ key: "c", title: "c" });
    const src = writeDoc(dir, "d.md", "## 节\n缓存测试 cache\n");
    await kb.ingest({ collection: "c", kind: "file", source: src });
    assert.equal(kb.search({ query: "cache" }).hits.length, 1);
    kb.dispose();
    kb.dispose();
    // 释放索引不等于丢数据：再查一次仍然命中（懒物化重建）。
    assert.equal(kb.search({ query: "cache" }).hits.length, 1);
  } finally {
    await rmTempEventually(dir);
    store.close();
  }
});
