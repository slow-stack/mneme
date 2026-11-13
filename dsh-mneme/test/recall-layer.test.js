import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";
import { testConfig } from "./helpers/test-config.js";

// Mock embedder: every query maps to the fixed vector [1,0,0], so vector recall
// surfaces any row embedded at [1,0,0] (cosine 1) and excludes orthogonal ones
// (cosine 0) once the search passes a threshold > 0.
const embedder = {
  embedSingle: async () => [1, 0, 0],
  embed: async () => [1, 0, 0],
  schedule: () => {}, // legacy path: scheduleEmbed uses schedule when present, so saveWithDedupe never calls embedSingle here
  modelHash: "recall#mock",
  dimension: 3
};

// Real store + service wired with the mock embedder and a vector index over the
// same store (the service's vector path prefers vectorIndex when set).
function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const vectorIndex = createVectorIndex({ store });
  service.setEmbedder(embedder);
  service.setVectorIndex(vectorIndex);
  return { store, service, vectorIndex };
}

function saveMemory(service, vectorIndex, { title, content, embedding }) {
  const mem = service.saveWithDedupe({ type: "preference", title, content, importance: 5 });
  if (embedding) vectorIndex.saveEmbedding(mem.memory.id, embedding);
  return mem.memory;
}

test("recordRecall=true invokes the recorder once with the full recall scene", async () => {
  const { service } = setup();
  const seen = [];
  service.setRecallRecorder((r) => seen.push(r));
  saveMemory(service, null, { title: "量子计算", content: "入门" });
  const rows = await service.searchMemories("量子", { mode: "keyword", topK: 5, threshold: 0.4, recordRecall: true });

  assert.equal(seen.length, 1, "recorder called exactly once");
  const rec = seen[0];
  assert.equal(rec.query, "量子");
  assert.equal(rec.mode, "keyword");
  assert.equal(rec.topK, 5);
  assert.equal(rec.threshold, 0.4);
  assert.ok(typeof rec.createdAt === "string" && rec.createdAt.length > 0, "createdAt is an ISO string");
  assert.equal(rec.candidates.length, rows.length, "candidates mirror the returned rows");
});

test("recorded candidates carry id/title/content/score/source and match the return value", async () => {
  const { service } = setup();
  const seen = [];
  service.setRecallRecorder((r) => seen.push(r));
  const a = saveMemory(service, null, { title: "量子计算入门", content: "叠加态" });
  const b = saveMemory(service, null, { title: "量子纠缠", content: "贝尔态" });
  const rows = await service.searchMemories("量子", { mode: "keyword", topK: 5, recordRecall: true });

  const cands = seen[0].candidates;
  assert.deepEqual(cands.map((c) => c.id), rows.map((r) => r.id), "candidate ids equal returned ids");
  for (const c of cands) {
    assert.ok(typeof c.id === "string" && c.id, "id present");
    assert.ok("title" in c && "content" in c, "title/content present");
    assert.equal(typeof c.score, "number", "score is numeric");
    assert.equal(c.source, "keyword", "keyword-mode candidates are marked 'keyword'");
  }
  // Exact candidate rows must deep-equal the returned memory rows.
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const c of cands) {
    const row = byId.get(c.id);
    assert.equal(c.title, row.title);
    assert.equal(c.content, row.content);
    assert.equal(c.score, row.score);
  }
  assert.ok(cands.some((c) => c.id === a.id), "first memory recorded");
  assert.ok(cands.some((c) => c.id === b.id), "second memory recorded");
});

test("recordRecall defaults to on (recallRecordDefault) — explicit false opts out", async () => {
  const { service } = setup();
  let calls = 0;
  service.setRecallRecorder(() => calls++);
  saveMemory(service, null, { title: "量子计算", content: "入门" });
  await service.searchMemories("量子", { mode: "keyword" });
  assert.equal(calls, 1, "unset recordRecall records by default (recallRecordDefault)");
  await service.searchMemories("量子", { mode: "keyword", recordRecall: false });
  assert.equal(calls, 1, "explicit false opts out of recording");
});

test("recallRecordDefault=false config turns unset recordRecall off", async () => {
  const { service } = setup({ recallRecordDefault: false });
  let calls = 0;
  service.setRecallRecorder(() => calls++);
  saveMemory(service, null, { title: "量子计算", content: "入门" });
  await service.searchMemories("量子", { mode: "keyword" });
  assert.equal(calls, 0, "config recallRecordDefault:false → unset recordRecall is off");
});

test("recordRecall=true with no recorder installed is safe and returns normally", async () => {
  const { service } = setup();
  saveMemory(service, null, { title: "量子计算", content: "入门" });
  const rows = await service.searchMemories("量子", { mode: "keyword", recordRecall: true });
  assert.ok(Array.isArray(rows) && rows.length === 1, "search still returns results");
});

test("a throwing recorder never breaks the search", async () => {
  const { service } = setup();
  service.setRecallRecorder(() => { throw new Error("recorder exploded"); });
  saveMemory(service, null, { title: "量子计算", content: "入门" });
  const rows = await service.searchMemories("量子", { mode: "keyword", recordRecall: true });
  assert.equal(rows.length, 1, "search unaffected by recorder failure");
});

test("an empty result set still records a run with an empty candidate list", async () => {
  const { service } = setup();
  const seen = [];
  service.setRecallRecorder((r) => seen.push(r));
  const rows = await service.searchMemories("不存在的记忆xyz", { mode: "keyword", recordRecall: true });
  assert.deepEqual(rows, [], "no matches");
  assert.equal(seen.length, 1, "receipt emitted even for empty recall");
  assert.deepEqual(seen[0].candidates, [], "candidates empty");
});

test("an empty query short-circuits before the recorder", async () => {
  const { service } = setup();
  const seen = [];
  service.setRecallRecorder((r) => seen.push(r));
  const rows = await service.searchMemories("   ", { mode: "keyword", recordRecall: true });
  assert.deepEqual(rows, [], "blank query returns nothing");
  assert.equal(seen.length, 0, "no receipt for blank query");
});

test("consecutive recordRecall=true searches emit one receipt each", async () => {
  const { service } = setup();
  const seen = [];
  service.setRecallRecorder((r) => seen.push(r));
  saveMemory(service, null, { title: "量子计算", content: "入门" });
  await service.searchMemories("量子", { mode: "keyword", recordRecall: true });
  await service.searchMemories("量子", { mode: "keyword", recordRecall: true });
  await service.searchMemories("量子", { mode: "keyword", recordRecall: true });
  assert.equal(seen.length, 3, "no misses, no duplicates");
});

test("reinstalling a recorder replaces the previous one", async () => {
  const { service } = setup();
  const first = [];
  const second = [];
  service.setRecallRecorder((r) => first.push(r));
  service.setRecallRecorder((r) => second.push(r));
  saveMemory(service, null, { title: "量子计算", content: "入门" });
  await service.searchMemories("量子", { mode: "keyword", recordRecall: true });
  assert.equal(first.length, 0, "old recorder dropped");
  assert.equal(second.length, 1, "new recorder receives the receipt");
});

test("vector mode marks candidates with source 'vector' (mock embedder)", async () => {
  const { service, vectorIndex } = setup();
  const seen = [];
  service.setRecallRecorder((r) => seen.push(r));
  saveMemory(service, vectorIndex, { title: "猫", content: "喜欢猫", embedding: [1, 0, 0] });
  const rows = await service.searchMemories("猫", { mode: "vector", threshold: 0.5, useRerank: false, recordRecall: true });
  assert.ok(rows.length >= 1, "vector recall hits the embedded row");
  const cands = seen[0].candidates;
  for (const c of cands) assert.equal(c.source, "vector", "vector-mode candidate source");
  assert.ok(cands.every((c) => typeof c.score === "number"), "vector scores numeric");
});

test("keyword mode marks candidates with source 'keyword' even when an embedder is installed", async () => {
  const { service, vectorIndex } = setup();
  const seen = [];
  service.setRecallRecorder((r) => seen.push(r));
  saveMemory(service, vectorIndex, { title: "量子计算", content: "入门", embedding: [1, 0, 0] });
  const rows = await service.searchMemories("量子", { mode: "keyword", useRerank: false, recordRecall: true });
  assert.ok(rows.length >= 1, "keyword recall hits the literal match");
  for (const c of seen[0].candidates) assert.equal(c.source, "keyword");
});

test("hybrid mode marks vector-only / keyword-only / both candidates correctly", async () => {
  const { service, vectorIndex } = setup();
  const seen = [];
  service.setRecallRecorder((r) => seen.push(r));
  // vector-only: no literal match, embedded exactly at the query vector.
  const vec = saveMemory(service, vectorIndex, { title: "猫", content: "喜欢猫", embedding: [1, 0, 0] });
  // keyword-only: literal match, embedding far from [1,0,0] -> excluded by threshold.
  const kw = saveMemory(service, vectorIndex, { title: "量子计算", content: "入门", embedding: [0, 1, 0] });
  // both: literal match AND embedded at [1,0,0].
  const both = saveMemory(service, vectorIndex, { title: "量子计算笔记", content: "量子实践", embedding: [1, 0, 0] });

  await service.searchMemories("量子", { mode: "hybrid", threshold: 0.5, useRerank: false, topK: 10, recordRecall: true });
  const cands = seen[0].candidates;
  const byId = new Map(cands.map((c) => [c.id, c]));
  assert.equal(byId.get(vec.id).source, "vector", "vector-only hit marked 'vector'");
  assert.equal(byId.get(kw.id).source, "keyword", "keyword-only hit marked 'keyword'");
  // Shared memory: vector leads the blend, so the merged row keeps the vector mark.
  assert.equal(byId.get(both.id).source, "vector", "both-path hit marked 'vector'");
  assert.equal(cands.length, 3, "all three rows in the receipt");
});

test("rerank overwrites the candidate source to 'rerank'", async () => {
  const { service } = setup();
  const seen = [];
  service.setRecallRecorder((r) => seen.push(r));
  service.setReranker({
    rerank: async (q, cands) => cands.map((c, i) => ({ id: c.id, score: i }))
  });
  saveMemory(service, null, { title: "量子计算", content: "入门" });
  await service.searchMemories("量子", { mode: "keyword", recordRecall: true });
  assert.equal(seen[0].candidates[0].source, "rerank", "reranked candidates are marked 'rerank'");
});

test("store: saveRecallRun round-trips through getRecallRun with candidates intact", async () => {
  const store = createStore(":memory:");
  const cands = [
    { id: "a", title: "量子计算", content: "入门\n第二行", score: 0.9, source: "vector" },
    { id: "b", title: "猫", content: "喜欢猫 \"quoted\"", score: null, source: "keyword" }
  ];
  const saved = store.saveRecallRun({
    id: "run-1", query: "量子", mode: "hybrid", topK: 5, threshold: 0.4,
    candidates: cands, created_at: "2026-08-16T01:00:00.000Z"
  });
  assert.equal(saved.id, "run-1", "save returns the persisted run");
  const got = store.getRecallRun("run-1");
  assert.equal(got.query, "量子");
  assert.equal(got.mode, "hybrid");
  assert.equal(got.topK, 5);
  assert.equal(got.threshold, 0.4);
  assert.equal(got.created_at, "2026-08-16T01:00:00.000Z");
  assert.deepEqual(got.candidates, cands, "candidates JSON survives round-trip");
});

test("store: getRecallRun returns undefined for a missing id", async () => {
  const store = createStore(":memory:");
  assert.equal(store.getRecallRun("nope"), undefined);
});

test("store: saveRecallRun is idempotent on the run id (replay overwrites)", async () => {
  const store = createStore(":memory:");
  store.saveRecallRun({ id: "r", query: "量子", mode: "keyword", topK: 5, candidates: [{ id: "a" }] });
  store.saveRecallRun({ id: "r", query: "量子", mode: "keyword", topK: 10, candidates: [{ id: "a" }, { id: "b" }] });
  const runs = store.listRecallRuns();
  assert.equal(runs.length, 1, "one row for a replayed id");
  assert.equal(runs[0].topK, 10, "replay overwrites the previous values");
  assert.equal(runs[0].candidates.length, 2);
});

test("store: saveRecallRun without an id assigns a unique id per run", async () => {
  const store = createStore(":memory:");
  const a = store.saveRecallRun({ query: "q1", mode: "keyword", topK: 5, candidates: [] });
  const b = store.saveRecallRun({ query: "q2", mode: "keyword", topK: 5, candidates: [] });
  assert.ok(a.id && b.id && a.id !== b.id, "distinct generated ids");
  assert.equal(store.listRecallRuns().length, 2, "both persisted, none overwritten");
});

test("store: listRecallRuns orders by created_at descending", async () => {
  const store = createStore(":memory:");
  store.saveRecallRun({ id: "old", query: "旧查询", mode: "keyword", topK: 5, candidates: [], created_at: "2026-08-16T01:00:00.000Z" });
  store.saveRecallRun({ id: "new", query: "新查询", mode: "vector", topK: 5, candidates: [], created_at: "2026-08-16T03:00:00.000Z" });
  store.saveRecallRun({ id: "mid", query: "中间", mode: "hybrid", topK: 5, candidates: [], created_at: "2026-08-16T02:00:00.000Z" });
  const runs = store.listRecallRuns();
  assert.deepEqual(runs.map((r) => r.id), ["new", "mid", "old"], "newest first");
});

test("store: listRecallRuns filters by query substring", async () => {
  const store = createStore(":memory:");
  store.saveRecallRun({ id: "1", query: "量子计算", mode: "keyword", topK: 5, candidates: [] });
  store.saveRecallRun({ id: "2", query: "猫咪饲养", mode: "keyword", topK: 5, candidates: [] });
  store.saveRecallRun({ id: "3", query: "量子纠缠", mode: "keyword", topK: 5, candidates: [] });
  const runs = store.listRecallRuns({ query: "量子" });
  assert.deepEqual(runs.map((r) => r.id), ["3", "1"], "only matching queries, newest first");
});

test("store: listRecallRuns honors limit/offset paging", async () => {
  const store = createStore(":memory:");
  for (let i = 0; i < 5; i++) {
    store.saveRecallRun({ id: `r${i}`, query: `查询${i}`, mode: "keyword", topK: 5, candidates: [], created_at: `2026-08-16T0${i + 1}:00:00.000Z` });
  }
  const page = store.listRecallRuns({ limit: 2, offset: 1 });
  assert.equal(page.length, 2, "page size honored");
  assert.deepEqual(page.map((r) => r.id), ["r3", "r2"], "ordered desc, offset applied");
  assert.deepEqual(store.listRecallRuns({ limit: 100, offset: 100 }), [], "offset past the end is empty");
});

test("e2e: index.js wiring — recordRecall search lands a row listRecallRuns can read back", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  // Simulate src/index.js: the recorder persists each receipt to recall_runs.
  service.setRecallRecorder((recall) => {
    store.saveRecallRun({
      query: recall.query,
      mode: recall.mode,
      topK: recall.topK,
      threshold: recall.threshold ?? null,
      candidates: recall.candidates ?? [],
      created_at: recall.createdAt
    });
  });
  service.saveWithDedupe({ type: "preference", title: "量子计算入门", content: "叠加态" });

  const rows = await service.searchMemories("量子", { mode: "keyword", topK: 3, recordRecall: true });
  const runs = store.listRecallRuns();
  assert.equal(runs.length, 1, "exactly one recall run persisted");
  const run = runs[0];
  assert.equal(run.query, "量子");
  assert.equal(run.mode, "keyword");
  assert.equal(run.topK, 3);
  assert.equal(run.threshold, null);
  assert.deepEqual(run.candidates.map((c) => c.id), rows.map((r) => r.id), "candidates match the response");
  assert.ok(run.created_at, "timestamp captured");
  // The receipt is available immediately after the awaited search returns.
  assert.equal(store.getRecallRun(run.id).query, "量子", "row readable right away");
});

test("e2e: unset recordRecall records by default; explicit false adds no row", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  service.setRecallRecorder((recall) => store.saveRecallRun({
    query: recall.query, mode: recall.mode, topK: recall.topK, threshold: recall.threshold ?? null,
    candidates: recall.candidates ?? [], created_at: recall.createdAt
  }));
  service.saveWithDedupe({ type: "preference", title: "量子计算入门", content: "叠加态" });
  await service.searchMemories("量子", { mode: "keyword" });
  assert.equal(store.listRecallRuns().length, 1, "unset recordRecall records a run by default");
  await service.searchMemories("量子", { mode: "keyword", recordRecall: false });
  assert.equal(store.listRecallRuns().length, 1, "explicit false adds no row");
});
