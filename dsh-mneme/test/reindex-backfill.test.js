import test from "node:test";
import assert from "node:assert/strict";
import { backfillMissingEmbeddings } from "../src/index.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";

// Issue #128：boot 回填曾被模型指纹门短路——任意一条嵌入成功写入 vector_meta
// 指纹后，指纹匹配的每次启动都在门上直接 return，写入时嵌入失败（embedder 未
// 就绪 / 服务商限流）的活跃行从此永远补不上（报告实测 88 条活跃记忆长期缺失，
// /vector-reindex 的配额还被归档死行吃掉）。

test("Issue #128: fingerprint match no longer blocks backfill; archived rows are skipped", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const active = service.saveWithDedupe({ type: "preference", title: "活跃", content: "内容" }).memory;
  const dead = service.saveWithDedupe({ type: "preference", title: "死行", content: "内容" }).memory;
  store.setArchived(dead.id, true);

  // 指纹已与 embedder 一致 —— 旧的早退条件在此成立，旧实现会整场不回填。
  const vectorIndex = createVectorIndex({ store });
  vectorIndex.markModel("mock-model#abc", 3);
  const embedded = [];
  const embedder = {
    embedSingle: async (text) => { embedded.push(text); return [1, 0, 0]; },
    modelHash: "mock-model#abc",
    dimension: 3
  };

  const logs = [];
  const summary = await backfillMissingEmbeddings({
    store, embedder, vectorIndex,
    logger: { info: (m) => logs.push(m) },
    rateLimitMs: 0
  });

  assert.equal(summary.indexed, 1, "the active row is backfilled despite the matching fingerprint");
  assert.equal(store.getEmbeddings([active.id]).get(active.id)?.length, 3, "active row now carries a vector");
  assert.equal(store.getEmbeddings([dead.id]).get(dead.id), undefined, "archived row is skipped");
  assert.equal(vectorIndex.modelHash(), "mock-model#abc", "fingerprint unchanged (markModel idempotent)");
  assert.ok(logs.some((m) => m.includes("backfilled 1")), "boot log records the backfill");
  store.close();
});

test("Issue #128: backfill is bounded by maxTotal; the rest stays queued", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  for (let i = 0; i < 5; i++) {
    service.saveWithDedupe({ type: "preference", title: `记忆${i}`, content: `内容${i}` });
  }
  const embedder = { embedSingle: async () => [1, 0, 0], modelHash: "h#1", dimension: 3 };
  const vectorIndex = createVectorIndex({ store });

  const summary = await backfillMissingEmbeddings({
    store, embedder, vectorIndex,
    logger: { info() {} },
    maxTotal: 4, batchSize: 2, rateLimitMs: 0
  });
  assert.equal(summary.indexed, 4, "stops at the maxTotal bound");
  // A capped run must SAY it was capped. The old bare-count return made a
  // capped run indistinguishable from a run that drained the backlog.
  assert.equal(summary.finishReason, "capped");
  assert.equal(summary.stillStale, true, "reports that work remains");
  assert.equal(store.needsEmbedding(10).length, 1, "remaining rows stay queued for the next boot");
  store.close();
});

test("maxTotal: 0 drains the whole backlog in one run", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  for (let i = 0; i < 5; i++) {
    service.saveWithDedupe({ type: "preference", title: `记忆${i}`, content: `内容${i}` });
  }
  const embedder = { embedSingle: async () => [1, 0, 0], modelHash: "h#1", dimension: 3 };
  const vectorIndex = createVectorIndex({ store });

  const summary = await backfillMissingEmbeddings({
    store, embedder, vectorIndex,
    logger: { info() {} },
    maxTotal: 0, batchSize: 2, rateLimitMs: 0
  });
  assert.equal(summary.indexed, 5, "no cap: every row is embedded");
  assert.equal(summary.finishReason, "drained");
  assert.equal(summary.stillStale, false, "nothing left behind");
  store.close();
});

test("a full-model switch re-embeds old vectors, not just the empty ones", async () => {
  // The old selector only matched NULL/'' — vectors from the previous model
  // stayed "present" forever and were never re-embedded, so they kept
  // inflating coverage while being incomparable to the new query embedding.
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const a = service.saveWithDedupe({ type: "preference", title: "旧向量", content: "甲" }).memory;
  const b = service.saveWithDedupe({ type: "preference", title: "无向量", content: "乙" }).memory;
  store.setEmbedding(a.id, [1, 0, 0], "old-model#aaa");
  // b stays empty.

  const embedder = { embedSingle: async () => [0, 1, 0], modelHash: "new-model#bbb", dimension: 3 };
  const vectorIndex = createVectorIndex({ store });
  const summary = await backfillMissingEmbeddings({
    store, embedder, vectorIndex, logger: { info() {} }, rateLimitMs: 0
  });

  assert.equal(summary.indexed, 2, "both the stale-model row and the empty row are re-embedded");
  assert.equal(summary.finishReason, "drained");
  assert.equal(store.needsEmbeddingFor("new-model#bbb", 10).length, 0, "nothing stale remains");
  const breakdown = store.embeddingModelBreakdown();
  assert.equal(breakdown.length, 1, "every vector now carries the new model");
  assert.equal(breakdown[0].model, "new-model#bbb");
  assert.equal(breakdown[0].c, 2);
  store.close();
});

test("rows with unknown provenance (NULL embedding_model) count as stale", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const r = service.saveWithDedupe({ type: "preference", title: "存量", content: "丙" }).memory;
  // Simulate a pre-migration row: vector present, provenance unknown.
  store.setEmbedding(r.id, [1, 0, 0]);

  assert.equal(store.needsEmbedding(10).length, 0, "old selector sees nothing to do");
  assert.equal(store.needsEmbeddingFor("new-model#bbb", 10).length, 1, "new selector flags unknown origin");
  assert.equal(store.hasStaleEmbedding("new-model#bbb"), true);
  store.close();
});

test("setEmbedding records provenance and clearing the vector clears it", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const r = service.saveWithDedupe({ type: "preference", title: "出身", content: "丁" }).memory;

  store.setEmbedding(r.id, [1, 0, 0], "m#1");
  assert.equal(store.embeddingModelBreakdown()[0].model, "m#1");

  store.setEmbedding(r.id, null);
  const row = store.db.prepare("SELECT embedding, embedding_model FROM memories WHERE id = ?").get(r.id);
  assert.equal(row.embedding, null);
  assert.equal(row.embedding_model, null, "a cleared vector never keeps a stale model name");
  store.close();
});
