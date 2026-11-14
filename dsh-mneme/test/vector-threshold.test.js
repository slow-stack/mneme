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

// #713（续）：`_score` 是「finalThreshold 比的那一个余弦」，调阈值的人靠它看
// 分数分布。它必须与阈值同一把尺子，且在 DTO 里以**新增键**出现。
test("_score carries the cosine the cutoff actually compared", async () => {
  const { service } = setup({ adaptiveThresholdEnabled: false, vectorSearchThreshold: 0.4 });
  const rows = await service.searchMemories(QUERY, { mode: "vector", topK: 10 });
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(rows[0]._score - 0.5) < 1e-6, `expected cosine 0.5, got ${rows[0]._score}`);
  const dto = service.toApiList(rows)[0];
  assert.ok(Math.abs(dto._score - 0.5) < 1e-6, "the HTTP/tool DTO must expose it too");
  // 现有字段与形状不受影响（_score 之外不多不少）。
  assert.equal(dto.id, rows[0].id);
  assert.equal(dto.title, "猫");
});

test("_score never survives filtering: rows the cutoff dropped carry nothing", async () => {
  const { service } = setup({ adaptiveThresholdEnabled: false, vectorSearchThreshold: 0.65 });
  const rows = await service.searchMemories(QUERY, { mode: "vector", topK: 10 });
  assert.equal(rows.length, 0, "cosine 0.5 is filtered by 0.65");
});

test("rows that never touched the vector path carry no _score key at all", async () => {
  const { service } = setup({ adaptiveThresholdEnabled: false, vectorSearchThreshold: 0.4 });
  service.saveWithDedupe({ type: "project", title: QUERY, content: "字面命中即可" });
  // keyword 模式按契约不走向量路，因此没有余弦可比。
  const rows = await service.searchMemories(QUERY, { mode: "keyword", topK: 10 });
  assert.ok(rows.length >= 1, "the literal row is found by keyword");
  for (const row of rows) assert.equal("_score" in row, false);
  for (const dto of service.toApiList(rows)) assert.equal("_score" in dto, false);
});