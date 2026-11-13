import test from "node:test";
import assert from "node:assert/strict";
import { backfillMissingEmbeddings } from "../src/index.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";
import { testConfig } from "./helpers/test-config.js";

// Issue #128：boot 回填曾被模型指纹门短路——任意一条嵌入成功写入 vector_meta
// 指纹后，指纹匹配的每次启动都在门上直接 return，写入时嵌入失败（embedder 未
// 就绪 / 服务商限流）的活跃行从此永远补不上（报告实测 88 条活跃记忆长期缺失，
// /vector-reindex 的配额还被归档死行吃掉）。

test("Issue #128: fingerprint match no longer blocks backfill; archived rows are skipped", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
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
  const service = createService({ store, mirror: null, config: testConfig({}) });
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
  const service = createService({ store, mirror: null, config: testConfig({}) });
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
  const service = createService({ store, mirror: null, config: testConfig({}) });
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
  const service = createService({ store, mirror: null, config: testConfig({}) });
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
  const service = createService({ store, mirror: null, config: testConfig({}) });
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
  const service = createService({ store, mirror: null, config: testConfig({}) });
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
  // 这里抛错，按失败种类归 `errored`（provider 不可达，值得重试）而不是
  // `stalled`（死行，重试无意义）。本条用例真正要锁的是「它会停」——
  // 调用次数与退出行为不因分档而变，重试策略由调度器决定。
  assert.equal(summary.finishReason, "errored");
  assert.equal(summary.stalled, false);
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
  const service = createService({ store, mirror: null, config: testConfig({}) });
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
  const service = createService({ store, mirror: null, config: testConfig({}) });
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

test("#604: a whole batch of transient failures reports 'errored', not 'stalled'", async () => {
  // 10 条全是好行，但这一轮恰好全撞上 503。indexed === 0，如果只按「没进展」
  // 判 stalled，重试就被推到下次启动——而 provider 一秒后已经好了。
  // 判据在 failureReasons：抛错落 `error:` 桶（瞬时），null 向量落
  // `empty-vector`（对该行是永久性）。
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  for (let i = 0; i < 10; i++) {
    service.saveWithDedupe({ type: "preference", title: `好行${i}`, content: `good-${i}` });
  }
  const vectorIndex = createVectorIndex({ store });
  let calls = 0;
  const embedder = {
    embedSingle: async () => {
      calls++;
      throw new Error("503 Service Unavailable");
    },
    modelHash: "h#1", dimension: 3
  };

  const summary = await backfillMissingEmbeddings({
    store, embedder, vectorIndex, logger: { info() {} },
    maxTotal: 500, batchSize: 10, rateLimitMs: 0
  });

  assert.equal(summary.indexed, 0);
  assert.equal(
    summary.finishReason, "errored",
    "a throw is a provider problem, not a dead row — the scheduler retries it on a short leash"
  );
  assert.equal(summary.stalled, false, "'stalled' must keep meaning 'no retry will help'");
  assert.ok(
    Object.keys(summary.failureReasons).some((r) => r.startsWith("error:")),
    "the transient reason is named, not folded into a generic bucket"
  );
  assert.equal(store.needsEmbeddingFor("h#1", 100).length, 10, "nothing was lost");
  store.close();
});

test("#604: permanent failures still report 'stalled' even mixed with the same count", async () => {
  // 与上一条同样的形状（10 条、一条没嵌上），唯一区别是失败形态：null 而不是抛错。
  // 两条并列，锁住「分档看的是失败种类，不是数量」。
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  for (let i = 0; i < 10; i++) {
    service.saveWithDedupe({ type: "preference", title: `坏行${i}`, content: `bad-${i}` });
  }
  const vectorIndex = createVectorIndex({ store });
  const embedder = {
    embedSingle: async () => null,
    modelHash: "h#1", dimension: 3
  };

  const summary = await backfillMissingEmbeddings({
    store, embedder, vectorIndex, logger: { info() {} },
    maxTotal: 500, batchSize: 10, rateLimitMs: 0
  });

  assert.equal(summary.indexed, 0);
  assert.equal(summary.finishReason, "stalled", "nothing transient here: retrying now is pointless");
  assert.equal(summary.stalled, true);
  assert.deepEqual(summary.failureReasons, { "empty-vector": 10 });
  store.close();
});

test("#604: a detailed adapter turns a provider outage into 'errored' on the legacy path", async () => {
  // 这台机器实际跑的是 legacy OpenAI 兼容适配器（embedProvider 默认 openai）。
  // 它的 embedSingle() 只回向量、把原因丢掉，所以 provider 挂掉与「这行坏了」
  // 在旧路径上是同一个 null。embedSingleDetailed() 把原因带出来，回填才能分档。
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  for (let i = 0; i < 10; i++) {
    service.saveWithDedupe({ type: "preference", title: `行${i}`, content: `legacy-${i}` });
  }
  const vectorIndex = createVectorIndex({ store });
  let detailedCalls = 0;
  const embedder = {
    // Deliberately present and returning null: if the backfill ever prefers it
    // over embedSingleDetailed, the run degrades to `stalled` and this fails.
    embedSingle: async () => null,
    embedSingleDetailed: async () => {
      detailedCalls++;
      return { vector: null, reason: "http-503" };
    },
    modelHash: "h#1", dimension: 3
  };

  const summary = await backfillMissingEmbeddings({
    store, embedder, vectorIndex, logger: { info() {} },
    maxTotal: 500, batchSize: 10, rateLimitMs: 0
  });

  assert.equal(detailedCalls, 10, "the detailed adapter is the one that gets called");
  assert.equal(summary.indexed, 0);
  assert.equal(
    summary.finishReason, "errored",
    "an http-503 is the provider's problem, so the scheduler retries it in-boot"
  );
  assert.deepEqual(summary.failureReasons, { "error:http-503": 10 });
  assert.equal(store.needsEmbeddingFor("h#1", 100).length, 10, "nothing was lost");
  store.close();
});

test("#604: a detailed adapter keeps an unembeddable row permanent", async () => {
  // 同一个详细适配器、同样的条数，只把 reason 换成永久的那一类。分档必须跟着
  // 原因走，而不是跟着「有没有 detailed 方法」走。
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  for (let i = 0; i < 10; i++) {
    service.saveWithDedupe({ type: "preference", title: `行${i}`, content: `bad-${i}` });
  }
  const vectorIndex = createVectorIndex({ store });
  const embedder = {
    embedSingle: async () => null,
    embedSingleDetailed: async () => ({ vector: null, reason: "response-no-vector" }),
    modelHash: "h#1", dimension: 3
  };

  const summary = await backfillMissingEmbeddings({
    store, embedder, vectorIndex, logger: { info() {} },
    maxTotal: 500, batchSize: 10, rateLimitMs: 0
  });

  assert.equal(summary.finishReason, "stalled");
  assert.deepEqual(summary.failureReasons, { "error:response-no-vector": 10 });
  store.close();
});

test("#604: a missing config field is permanent, so it must not buy error retries", async () => {
  // config-incomplete 也以 error: 开头，但它每次都会以同样方式失败。若按前缀
  // 一律算瞬时，配置不全的机器会在每次启动时空跑 1+3 轮。
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  for (let i = 0; i < 10; i++) {
    service.saveWithDedupe({ type: "preference", title: `行${i}`, content: `cfg-${i}` });
  }
  const vectorIndex = createVectorIndex({ store });
  const embedder = {
    embedSingle: async () => null,
    embedSingleDetailed: async () => ({ vector: null, reason: "config-incomplete:apiKey" }),
    modelHash: "h#1", dimension: 3
  };

  const summary = await backfillMissingEmbeddings({
    store, embedder, vectorIndex, logger: { info() {} },
    maxTotal: 500, batchSize: 10, rateLimitMs: 0
  });

  assert.equal(
    summary.finishReason, "stalled",
    "an incomplete config is not an outage; retrying it only burns the error budget"
  );
  assert.equal(summary.stalled, true);
  store.close();
});

test("#604: a run with no failures can reach 'drained' even with a nonzero budget", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
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
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const r = service.saveWithDedupe({ type: "preference", title: "出身", content: "丁" }).memory;

  store.setEmbedding(r.id, [1, 0, 0], "m#1");
  assert.equal(store.embeddingModelBreakdown()[0].model, "m#1");

  store.setEmbedding(r.id, null);
  const row = store.db.prepare("SELECT embedding, embedding_model FROM memories WHERE id = ?").get(r.id);
  assert.equal(row.embedding, null);
  assert.equal(row.embedding_model, null, "a cleared vector never keeps a stale model name");
  store.close();
});
