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

test("#604: a permanently failing row is tried once, not once per batch", async () => {
  // A failed row is never written, so it stays stale and the next pick() hands
  // it straight back. Measured on the old loop: 9 of 20 budget slots burned on
  // one bad row, and the summary still said "capped" — as if the budget had run
  // out with other work waiting behind it.
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  for (let i = 0; i < 12; i++) {
    service.saveWithDedupe({ type: "preference", title: `记忆${i}`, content: `内容${i}` });
  }
  const bad = "记忆11\n内容11";
  const calls = [];
  const embedder = {
    embedSingle: async (text) => {
      calls.push(text);
      return text === bad ? null : [1, 0, 0]; // legacy adapters signal failure by returning null
    },
    modelHash: "h#1",
    dimension: 3
  };
  const vectorIndex = createVectorIndex({ store });

  const summary = await backfillMissingEmbeddings({
    store, embedder, vectorIndex,
    logger: { info() {} },
    maxTotal: 20, batchSize: 10, rateLimitMs: 0
  });

  const badCalls = calls.filter((t) => t === bad).length;
  assert.equal(badCalls, 1, "the bad row is attempted exactly once");
  assert.equal(summary.indexed, 11, "every healthy row still gets embedded");
  assert.equal(summary.failed, 1, "one failure counted, not nine");
  assert.equal(summary.finishReason, "stalled", "queue is not empty but nothing is left to try");
  assert.deepEqual(summary.failureReasons, { "empty-vector": 1 });
  store.close();
});

test("#604: maxTotal: 0 with a permanently failing row terminates", async () => {
  // The old loop used `unlimited || done < maxTotal`, so with maxTotal: 0 the
  // counter never bounded anything and a failing row kept the queue non-empty
  // forever. Measured: still running after 25s, embedSingle called in a tight
  // loop. This must return, and return quickly.
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  for (let i = 0; i < 4; i++) {
    service.saveWithDedupe({ type: "preference", title: `行${i}`, content: `C${i}` });
  }
  let calls = 0;
  const embedder = {
    embedSingle: async () => { calls++; throw new Error("provider down"); },
    modelHash: "h#1",
    dimension: 3
  };
  const vectorIndex = createVectorIndex({ store });

  const summary = await backfillMissingEmbeddings({
    store, embedder, vectorIndex,
    logger: { info() {} },
    maxTotal: 0, batchSize: 10, rateLimitMs: 0
  });

  assert.equal(calls, 4, "each row attempted once, then the run stops");
  assert.equal(summary.indexed, 0);
  assert.equal(summary.failed, 4);
  assert.equal(summary.finishReason, "stalled");
  assert.equal(summary.stillStale, true, "the rows are still stale — they will be retried next boot");
  assert.deepEqual(summary.failureReasons, { "error:Error: provider down": 4 });
  store.close();
});

test("#604: a dead prefix at the queue head does not starve the healthy tail", async () => {
  // pick() is ORDER BY updated_at DESC and a failed row is never written, so a
  // block of permanently failing rows sits at the head forever. With a fixed
  // batchSize window the filter removed the whole batch every round and the run
  // ended `stalled` without trying a single healthy row behind them — measured
  // on this code: okCalls 0, indexed 0, 20 rows still stale.
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  // Written first ⇒ older updated_at ⇒ BEHIND the failing block under DESC.
  for (let i = 0; i < 10; i++) {
    service.saveWithDedupe({ type: "preference", title: `好行${i}`, content: `good-${i}` });
  }
  // Written last ⇒ newest updated_at ⇒ the queue head.
  for (let i = 0; i < 10; i++) {
    service.saveWithDedupe({ type: "preference", title: `坏行${i}`, content: `bad-${i}` });
  }
  let okCalls = 0;
  let badCalls = 0;
  const embedder = {
    embedSingle: async (text) => {
      if (String(text).includes("bad-")) { badCalls++; return null; }
      okCalls++; return [1, 0, 0];
    },
    modelHash: "h#1",
    dimension: 3
  };
  const vectorIndex = createVectorIndex({ store });

  const summary = await backfillMissingEmbeddings({
    store, embedder, vectorIndex,
    logger: { info() {} },
    maxTotal: 500, batchSize: 10, rateLimitMs: 0
  });

  assert.equal(okCalls, 10, "every healthy row behind the dead prefix is attempted");
  assert.equal(summary.indexed, 10, "and actually embedded");
  assert.equal(badCalls, 10, "each failing row is still tried exactly once");
  assert.equal(summary.failed, 10);
  assert.equal(store.needsEmbeddingFor("h#1", 100).length, 10, "only the failing rows remain stale");
  store.close();
});

test("#604: a dead prefix deeper than the pick window reports 'stalled', not 'capped'", async () => {
  // The window widening above has a bound (maxWindow = 500). A dead prefix at
  // least that deep fills every round's window, so `rows` is never empty, the
  // loop exits on the budget, and `stalled` never gets set — the run used to
  // report "capped" with indexed 0, and the scheduler re-ran it 21 times:
  // 10,500 provider calls, nothing embedded. "capped" must mean work is left
  // AND the budget stopped us; a run that embedded nothing made no progress
  // and has to say so, so the next boot becomes the retry point.
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  for (let i = 0; i < 10; i++) {
    service.saveWithDedupe({ type: "preference", title: `好行${i}`, content: `good-${i}` });
  }
  for (let i = 0; i < 500; i++) {
    service.saveWithDedupe({ type: "preference", title: `坏行${i}`, content: `bad-${i}` });
  }
  let okCalls = 0;
  const embedder = {
    embedSingle: async (text) => {
      if (String(text).includes("bad-")) return null;
      okCalls++; return [1, 0, 0];
    },
    modelHash: "h#1",
    dimension: 3
  };
  const vectorIndex = createVectorIndex({ store });

  const summary = await backfillMissingEmbeddings({
    store, embedder, vectorIndex,
    logger: { info() {} },
    maxTotal: 500, batchSize: 10, rateLimitMs: 0
  });

  assert.equal(summary.indexed, 0, "the dead prefix consumed the whole budget");
  assert.equal(summary.failed, 500);
  assert.equal(
    summary.finishReason, "stalled",
    "no progress means stalled — 'capped' would make the scheduler burn the same rows again"
  );
  assert.equal(okCalls, 0, "the healthy tail is simply out of reach this run");
  store.close();
});

test("#604: a run with no failures can reach 'drained' even with a nonzero budget", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  for (let i = 0; i < 3; i++) {
    service.saveWithDedupe({ type: "preference", title: `行${i}`, content: `C${i}` });
  }
  const embedder = { embedSingle: async () => [1, 0, 0], modelHash: "h#1", dimension: 3 };
  const vectorIndex = createVectorIndex({ store });

  const summary = await backfillMissingEmbeddings({
    store, embedder, vectorIndex, logger: { info() {} },
    maxTotal: 100, batchSize: 10, rateLimitMs: 0
  });
  assert.equal(summary.finishReason, "drained");
  assert.equal(summary.stalled, false);
  assert.equal(summary.failureReasons, null, "no failure map when nothing failed");
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
