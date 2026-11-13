import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";
import { testConfig } from "./helpers/test-config.js";

// Mock embedder from the pipeline spec: every query maps to the fixed vector
// [1,0,0], so vector recall surfaces any row embedded at [1,0,0] (cosine 1)
// and ignores rows embedded elsewhere (cosine 0).
const embedder = {
  embedSingle: async () => [1, 0, 0],
  embed: async () => [1, 0, 0],
  schedule: () => {}, // legacy path: scheduleEmbed uses schedule when present, so saveWithDedupe never calls embedSingle here
  modelHash: "mock#1",
  dimension: 3
};

// Mock reranker: scores candidates by their merge order (0,1,2,...) then sorts
// descending — i.e. it reverses the incoming order. Deterministic, so tests can
// assert the on/off difference precisely.
const reranker = {
  rerank: async (q, cands) =>
    cands.map((c, i) => ({ id: c.id, score: i })).sort((a, b) => b.score - a.score)
};

// Real store + service, wired with the mock embedder and a vector index over
// the same store (the service's vector path prefers vectorIndex when set).
// The v0.5.0 recall fusion extras (BM25 third path, search-time semantic
// dedup) are disabled per-test when the assertion targets the legacy blend
// mechanics — the toy embedder pins every vector hit to the same [1,0,0],
// which semantic dedup would legitimately collapse.
function setup({ withEmbedder = true, config = {} } = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig(config) });
  const vectorIndex = createVectorIndex({ store });
  if (withEmbedder) {
    service.setEmbedder(embedder);
    service.setVectorIndex(vectorIndex);
  }
  return { store, service, vectorIndex };
}

test("hybrid merges vector + keyword recalls and dedups shared memories", async () => {
  const { service, vectorIndex } = setup();
  // keyword-only hit: literal query in the title, embedding far from [1,0,0].
  const kw = service.saveWithDedupe({ type: "preference", title: "量子计算", content: "量子计算入门", importance: 5 });
  vectorIndex.saveEmbedding(kw.memory.id, [0, 1, 0]);
  // vector-only hit: no literal match, but embedded exactly at the query vector.
  const vec = service.saveWithDedupe({ type: "project", title: "猫", content: "喜欢猫" });
  vectorIndex.saveEmbedding(vec.memory.id, [1, 0, 0]);
  // both: literal match AND embedded at [1,0,0] -> must appear exactly once.
  const both = service.saveWithDedupe({ type: "decision", title: "量子计算笔记", content: "量子计算实践" });
  vectorIndex.saveEmbedding(both.memory.id, [1, 0, 0]);

  const rows = await service.searchMemories("量子计算", { mode: "hybrid", topK: 10 });
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(vec.memory.id), "vector recall surfaces the semantic-only hit");
  assert.ok(ids.includes(kw.memory.id), "keyword recall surfaces the literal hit");
  assert.equal(ids.filter((id) => id === both.memory.id).length, 1, "overlap row is deduped to a single entry");
  assert.ok(rows.some((m) => m.id === both.memory.id && m.vector), "shared row is flagged as a vector hit");
  assert.equal(ids[0], vec.memory.id, "vector leads the hybrid blend");
});

test("hybrid blend honors configured vector/keyword weights", async () => {
  const { service, vectorIndex } = setup();
  const both = service.saveWithDedupe({ type: "preference", title: "量子计算", content: "量子计算入门" });
  vectorIndex.saveEmbedding(both.memory.id, [1, 0, 0]);

  // Title hit scores 1 * (0.5 + 3/10) = 0.8; vector cosine = 1.0.
  // Default weights (0.6/0.4) -> 0.6 + 0.32 = 0.92.
  const defaults = await service.searchMemories("量子计算", { mode: "hybrid", topK: 10 });
  const d = defaults.find((m) => m.id === both.memory.id);
  assert.ok(Math.abs(d.score - 0.92) < 1e-9, `default blend ${d.score}`);

  // Even 0.5/0.5 -> 0.5 + 0.4 = 0.9.
  const store = createStore(":memory:");
  const tuned = createService({ store, mirror: null, config: testConfig({ hybridSearchVectorWeight: 0.5, hybridSearchKeywordWeight: 0.5 }) });
  const vi = createVectorIndex({ store });
  tuned.setEmbedder(embedder);
  tuned.setVectorIndex(vi);
  const m = tuned.saveWithDedupe({ type: "preference", title: "量子计算", content: "量子计算入门" });
  vi.saveEmbedding(m.memory.id, [1, 0, 0]);
  const rows = await tuned.searchMemories("量子计算", { mode: "hybrid", topK: 10 });
  const t = rows.find((r) => r.id === m.memory.id);
  assert.ok(Math.abs(t.score - 0.9) < 1e-9, `tuned blend ${t.score}`);
});

test("auto = keyword leads, vector fills the remaining slots", async () => {
  const { service, vectorIndex } = setup();
  const kw = service.saveWithDedupe({ type: "preference", title: "量子计算", content: "量子计算入门" });
  vectorIndex.saveEmbedding(kw.memory.id, [0, 1, 0]);
  const vec = service.saveWithDedupe({ type: "preference", title: "猫", content: "喜欢猫" });
  vectorIndex.saveEmbedding(vec.memory.id, [1, 0, 0]);

  const rows = await service.searchMemories("量子计算", { mode: "auto", topK: 10 });
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(kw.memory.id), "keyword hit present");
  assert.ok(ids.includes(vec.memory.id), "vector fills a free slot");
  assert.equal(ids[0], kw.memory.id, "keyword stays first in auto mode");
});

test("reranker on/off: rerank reorders by score, off keeps merge order", async () => {
  const { service, vectorIndex } = setup();
  const a = service.saveWithDedupe({ type: "preference", title: "猫", content: "喜欢猫", importance: 5 });
  vectorIndex.saveEmbedding(a.memory.id, [0, 1, 0]);
  const b = service.saveWithDedupe({ type: "preference", title: "猫猫", content: "猫粮", importance: 3 });
  vectorIndex.saveEmbedding(b.memory.id, [0, 1, 0]);

  // No reranker: keyword order (importance desc) is preserved.
  const off = await service.searchMemories("猫", { mode: "keyword", topK: 10 });
  assert.equal(off[0].id, a.memory.id, "without a reranker merge order is kept");

  // Mock reranker installed: it reverses the merge order by score.
  service.setReranker(reranker);
  const on = await service.searchMemories("猫", { mode: "keyword", topK: 10 });
  assert.equal(on[0].id, b.memory.id, "rerank reorders to the highest score first");
  assert.equal(typeof on[0].score, "number", "reranked rows carry a score");

  // Clearing the reranker restores merge order.
  service.setReranker(null);
  const after = await service.searchMemories("猫", { mode: "keyword", topK: 10 });
  assert.equal(after[0].id, a.memory.id, "clearing the reranker restores original order");
});

test("keyword mode never calls the embedder", async () => {
  let calls = 0;
  const counting = { ...embedder, embedSingle: async () => { calls++; return [1, 0, 0]; } };
  const { service, vectorIndex } = setup();
  service.setEmbedder(counting);
  service.setVectorIndex(vectorIndex);
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文交流" });

  const rows = await service.searchMemories("中文", { mode: "keyword", topK: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "语言");
  assert.equal(calls, 0, "keyword mode must never embed the query");
});

test("embedder failure degrades to keyword results", async () => {
  const broken = { ...embedder, embedSingle: async () => { throw new Error("model unavailable"); } };
  const { service, vectorIndex } = setup();
  service.setEmbedder(broken);
  service.setVectorIndex(vectorIndex);
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文交流" });

  const rows = await service.searchMemories("中文", { mode: "auto", topK: 10 });
  assert.equal(rows.length, 1, "keyword fallback still returns matches");
  assert.equal(rows[0].title, "语言");
  assert.ok(!rows.some((m) => m.vector), "no rows claim the vector path after a failure");
});

test("vector mode returns semantic hits, and falls back to keyword without an embedder", async () => {
  const { service, vectorIndex } = setup();
  const hit = service.saveWithDedupe({ type: "preference", title: "猫", content: "喜欢猫" });
  vectorIndex.saveEmbedding(hit.memory.id, [1, 0, 0]);
  const rows = await service.searchMemories("猫", { mode: "vector", topK: 10 });
  assert.ok(rows.some((m) => m.id === hit.memory.id && m.vector), "vector-only recall surfaces the embedded hit");

  // No embedder/vector index: vector mode falls back to literal keyword.
  const bare = setup({ withEmbedder: false });
  const m = bare.service.saveWithDedupe({ type: "preference", title: "语言", content: "中文交流" });
  const fallback = await bare.service.searchMemories("中文", { mode: "vector", topK: 10 });
  assert.ok(fallback.some((x) => x.id === m.memory.id), "keyword fallback when vector is unavailable");
});

test("topK caps the merged result set", async () => {
  const { service, vectorIndex } = setup();
  for (let i = 0; i < 5; i++) {
    const m = service.saveWithDedupe({ type: "preference", title: `猫${i}`, content: "猫" });
    vectorIndex.saveEmbedding(m.memory.id, [1, 0, 0]);
  }
  const rows = await service.searchMemories("猫", { mode: "auto", topK: 3 });
  assert.equal(rows.length, 3, "merged list is trimmed to topK");
});
