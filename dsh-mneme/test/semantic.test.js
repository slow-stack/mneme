import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";
import { testConfig } from "./helpers/test-config.js";

const DIM = 4;

// Mock embedder: maps a query to a fixed vector so tests exercise the wiring
// without downloading any model. Prefer embedSingle (local embedders); a
// legacy embed() fallback is also exercised in one test.
function mockEmbedder(overrides = {}) {
  return {
    embedSingle: async (text) => [1, 0, 0, 0],
    embed: async (texts) => texts.map(() => [1, 0, 0, 0]),
    schedule: () => {}, // legacy path: scheduleEmbed uses schedule when present, so saveWithDedupe never calls embedSingle here
    modelHash: "mock#abc",
    dimension: DIM,
    ...overrides
  };
}

function setup(embedder = mockEmbedder()) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const vectorIndex = createVectorIndex({ store });
  service.setEmbedder(embedder);
  service.setVectorIndex(vectorIndex);
  return { store, service, vectorIndex };
}

test("vector-index stores and searches embeddings with model metadata", async () => {
  const { store, service, vectorIndex } = setup();
  const m1 = service.saveWithDedupe({ type: "preference", title: "猫", content: "喜欢猫" });
  vectorIndex.saveEmbedding(m1.memory.id, [1, 0, 0, 0]);
  const m2 = service.saveWithDedupe({ type: "preference", title: "狗", content: "喜欢狗" });
  vectorIndex.saveEmbedding(m2.memory.id, [0, 1, 0, 0]);

  const hits = vectorIndex.search([1, 0, 0, 0], { threshold: 0.5 });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].id, m1.memory.id, "best vector match ranks first");

  vectorIndex.markModel("mock#abc", DIM);
  const stats = vectorIndex.getStats();
  assert.equal(stats.modelHash, "mock#abc");
  assert.equal(stats.dimension, DIM);
  assert.equal(stats.embeddedCount, 2);

  vectorIndex.deleteEmbedding(m2.memory.id);
  assert.equal(vectorIndex.getEmbedding(m2.memory.id), undefined);
});

test("searchMemories auto = keyword first + vector fill", async () => {
  const { service } = setup();
  const m1 = service.saveWithDedupe({ type: "preference", title: "猫", content: "喜欢猫" });
  const m2 = service.saveWithDedupe({ type: "preference", title: "狗狗", content: "喜欢狗和猫" });

  const rows = await service.searchMemories("猫", { mode: "auto", topK: 10 });
  assert.ok(rows.some((m) => m.id === m1.memory.id), "keyword hit present");
  assert.ok(rows.some((m) => m.id === m2.memory.id), "vector fill present");
});

test("searchMemories hybrid = vector leads, keyword fills", async () => {
  const { service, vectorIndex } = setup();
  // "狗" is semantically stored under the vector; literal query misses it.
  const mDog = service.saveWithDedupe({ type: "preference", title: "金毛", content: "金毛是狗" });
  vectorIndex.saveEmbedding(mDog.memory.id, [1, 0, 0, 0]);
  const mCat = service.saveWithDedupe({ type: "preference", title: "猫", content: "喜欢猫" });
  vectorIndex.saveEmbedding(mCat.memory.id, [0, 0, 1, 0]);

  const rows = await service.searchMemories("狗", { mode: "hybrid", topK: 10 });
  // mock vector always returns the fixed [1,0,0,0] vector, which matches the
  // dog embedding above → dog should surface even though keyword matches "金毛".
  assert.ok(rows.some((m) => m.id === mDog.memory.id), "vector lead surfaces dog");
});

test("searchMemories keyword mode never touches the embedder", async () => {
  let called = 0;
  const { service } = setup(mockEmbedder({
    embedSingle: async () => { called++; return [1, 0, 0, 0]; }
  }));
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文交流" });
  const rows = await service.searchMemories("中文", { mode: "keyword", topK: 10 });
  assert.equal(rows.length, 1);
  assert.equal(called, 0, "embedder must not be called in keyword mode");
});

test("searchMemories reranks merged candidates when a reranker is installed", async () => {
  const { service } = setup();
  const a = service.saveWithDedupe({ type: "preference", title: "猫", content: "喜欢猫" });
  const b = service.saveWithDedupe({ type: "preference", title: "猫猫", content: "猫粮" });
  // b is newer, so keyword order is [b, a]. The reranker reverses scores so
  // the last candidate (a) wins — asserting the rerank actually reordered.
  const reranker = {
    rerank: async (query, candidates) =>
      candidates.map((c, i) => ({ id: c.id, score: i })).sort((x, y) => y.score - x.score)
  };
  service.setReranker(reranker);

  const rows = await service.searchMemories("猫", { mode: "keyword", topK: 10 });
  assert.equal(rows[0].title, "猫", "rerank reorders to the higher score");
  assert.equal(typeof rows[0].score, "number", "reranked rows carry a score");
});

test("searchMemories survives a throwing embedder (degrades to keyword)", async () => {
  const { service } = setup(mockEmbedder({
    embedSingle: async () => { throw new Error("model unavailable"); }
  }));
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文交流" });
  const rows = await service.searchMemories("中文", { mode: "auto", topK: 10 });
  assert.equal(rows.length, 1, "keyword fallback still works");
});

test("legacy embedder (embed-only) is adapted by searchMemories", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const legacy = { embed: async (q) => [1, 0, 0, 0] };
  service.setEmbedder(legacy); // no embedSingle, no vectorIndex
  service.saveWithDedupe({ type: "preference", title: "猫", content: "喜欢猫" });
  store.setEmbedding(service.all()[0].id, [1, 0, 0, 0]);

  const rows = await service.searchMemories("猫", { mode: "vector", topK: 10 });
  assert.ok(rows.some((m) => m.title === "猫"), "legacy embed() path works");
});
