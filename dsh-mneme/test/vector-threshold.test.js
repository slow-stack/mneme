// #713: vectorSearchThreshold had no consumer at all.
//
// With adaptive thresholds disabled and no explicit `threshold` from the
// caller, the vector fetch fell back to `threshold ?? 0` — an unconditional
// "no cutoff", so every query returned the full top-K and the documented
// fixed cutoff (and the config key itself) did nothing.
//
// The contract these tests pin down:
//   - adaptive off, no explicit threshold  → config.vectorSearchThreshold
//     (or its documented default 0.65 when the key is unset)
//   - an explicit threshold always wins, including an explicit 0, which the
//     internal full-scan paths (hot refresh, backfill) rely on
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";
import { testConfig } from "./helpers/test-config.js";

// Every query embeds to [1,0,0]; the stored row sits at cosine 0.5 to it.
const embedder = {
  embedSingle: async () => [1, 0, 0],
  embed: async () => [1, 0, 0],
  schedule: () => {},
  modelHash: "mock#1",
  dimension: 3
};

const HALF_COSINE = [0.5, Math.sqrt(0.75), 0];

// 6 chars: adaptive would land on its 0.65 default, and there is no literal
// overlap with the row, so only the vector path can surface it.
const QUERY = "量子计算入门";

function setup(config) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig(config) });
  const vectorIndex = createVectorIndex({ store });
  service.setEmbedder(embedder);
  service.setVectorIndex(vectorIndex);
  const row = service.saveWithDedupe({ type: "project", title: "猫", content: "喜欢猫" });
  vectorIndex.saveEmbedding(row.memory.id, HALF_COSINE);
  return { service, id: row.memory.id };
}

test("adaptive off falls back to the configured cutoff instead of no cutoff", async () => {
  const { service } = setup({ adaptiveThresholdEnabled: false, vectorSearchThreshold: 0.65 });
  const rows = await service.searchMemories(QUERY, { mode: "vector", topK: 10 });
  assert.equal(rows.length, 0, "cosine 0.5 is below the configured 0.65");
});

test("the configured cutoff is really consumed", async () => {
  const { service, id } = setup({ adaptiveThresholdEnabled: false, vectorSearchThreshold: 0.4 });
  const rows = await service.searchMemories(QUERY, { mode: "vector", topK: 10 });
  assert.deepEqual(rows.map((r) => r.id), [id], "cosine 0.5 clears a configured 0.4");
});

test("an unset key falls back to the documented 0.65 default", async () => {
  const { service } = setup({ adaptiveThresholdEnabled: false });
  const rows = await service.searchMemories(QUERY, { mode: "vector", topK: 10 });
  assert.equal(rows.length, 0);
});

test("an explicit threshold still wins, including 0 for a full scan", async () => {
  const { service, id } = setup({ adaptiveThresholdEnabled: false, vectorSearchThreshold: 0.65 });
  const rows = await service.searchMemories(QUERY, { mode: "vector", topK: 10, threshold: 0 });
  assert.deepEqual(rows.map((r) => r.id), [id], "explicit 0 means no cutoff");
});