import test from "node:test";
import assert from "node:assert/strict";
import { scheduleBootBackfill } from "../src/semantic.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";

// #604：boot 回填的续排此前完全没有用例覆盖 —— createSemantic 只被 index.js /
// serve.js 引用，闭包里的调度逻辑既测不到也看不见，于是「一次启动只跑一轮、撞
// cap 就停」活了很久：日志里写着 capped，没有任何出口能说明「它不会再自己跑」。
// 这里直接驱动调度器，用压缩后的等待时间，断言排了几轮、为什么停。

function setup({ count = 6, batchSize = 2, maxPerBoot = 2 } = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  for (let i = 0; i < count; i++) {
    service.saveWithDedupe({ type: "preference", title: `记忆${i}`, content: `内容${i}` });
  }
  const vectorIndex = createVectorIndex({ store });
  const cfg = {
    autoReindexOnBoot: true,
    reindexMaxPerBoot: maxPerBoot,
    reindexBatchSize: batchSize,
    reindexRateLimitMs: 0
  };
  return { store, vectorIndex, cfg };
}

// 调度器用 setTimeout 串联，delay 压到 0 之后仍然要等事件循环转几圈。
// 轮询到状态稳定（连续两次读到同一个终态）或超时为止。
async function settle(statusOf, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let stable = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
    const now = JSON.stringify(statusOf() ?? null);
    if (now === last) {
      stable++;
      if (stable >= 3) return JSON.parse(now);
    } else {
      stable = 0;
      last = now;
    }
  }
  throw new Error(`scheduler did not settle within ${timeoutMs}ms (last=${last})`);
}

test("#604: a capped run continues inside the same boot until the backlog drains", async () => {
  // 6 行、每轮最多 2 行 → 需要 3 轮。旧实现只跑第一轮就永久停手。
  const { store, vectorIndex, cfg } = setup({ count: 6, batchSize: 2, maxPerBoot: 2 });
  const embedder = { embedSingle: async () => [1, 0, 0], modelHash: "m#1", dimension: 3 };

  const scheduler = scheduleBootBackfill({
    store, vectorIndex, logger: { info() {}, warn() {} }, cfg,
    getEmbedder: () => embedder,
    timing: { initialDelayMs: 0, continueDelayMs: 0 }
  });

  const status = await settle(() => scheduler.status());
  scheduler.dispose();

  assert.equal(store.needsEmbeddingFor("m#1").length, 0, "the whole backlog is cleared in one boot");
  assert.equal(status.state, "finished");
  assert.equal(status.finishReason, "drained", "the last run reports why it stopped");
  assert.equal(status.continuation, 2, "two continuations after the first run (3 runs total)");
  store.close();
});

test("#604: continuations stop at the cap instead of looping forever", async () => {
  // 12 行、每轮 2 行、上限 2 次续排 → 只跑 3 轮（6 行），剩下的留到下次启动。
  const { store, vectorIndex, cfg } = setup({ count: 12, batchSize: 2, maxPerBoot: 2 });
  const embedder = { embedSingle: async () => [1, 0, 0], modelHash: "m#1", dimension: 3 };
  const warnings = [];

  const scheduler = scheduleBootBackfill({
    store, vectorIndex, cfg,
    logger: { info() {}, warn: (m) => warnings.push(m) },
    getEmbedder: () => embedder,
    timing: { initialDelayMs: 0, continueDelayMs: 0, maxContinuations: 2 }
  });

  const status = await settle(() => scheduler.status());
  scheduler.dispose();

  assert.equal(status.finishReason, "capped");
  assert.equal(status.continuation, 2, "the cap counts continuations, not runs");
  assert.equal(store.needsEmbeddingFor("m#1").length, 6, "exactly the remainder is left queued");
  assert.ok(
    warnings.some((m) => m.includes("continuation limit")),
    "hitting the cap is logged, not silent"
  );
  store.close();
});

test("#604: a stalled run does not reschedule — the next boot is the retry point", async () => {
  // 全行失败 → finishReason stalled。立刻再排只会把同几行再烧一遍，
  // 所以正确行为是停手，把重试留给下一次启动（与 #128 的契约一致）。
  const { store, vectorIndex, cfg } = setup({ count: 4, batchSize: 10, maxPerBoot: 100 });
  let calls = 0;
  const embedder = {
    embedSingle: async () => { calls++; throw new Error("provider down"); },
    modelHash: "m#1",
    dimension: 3
  };

  const scheduler = scheduleBootBackfill({
    store, vectorIndex, cfg,
    logger: { info() {}, warn() {} },
    getEmbedder: () => embedder,
    timing: { initialDelayMs: 0, continueDelayMs: 0 }
  });

  const status = await settle(() => scheduler.status());
  scheduler.dispose();

  assert.equal(status.finishReason, "stalled");
  assert.equal(status.continuation, 0, "no continuation was scheduled");
  assert.equal(calls, 4, "each row was attempted once, total");
  assert.equal(store.needsEmbeddingFor("m#1").length, 4, "rows stay queued for the next boot");
  store.close();
});

test("#604: dispose cancels a pending continuation (no query against a closed store)", async () => {
  // 这是 #365 CodeRabbit 记过的同一类事故：计时器没入册，卸载后还在跑。
  // 断言方式是关库之后不再有任何新调用 —— 若续排漏出去，会在这里炸。
  const { store, vectorIndex, cfg } = setup({ count: 8, batchSize: 2, maxPerBoot: 2 });
  let calls = 0;
  const embedder = {
    embedSingle: async () => { calls++; return [1, 0, 0]; },
    modelHash: "m#1",
    dimension: 3
  };

  const scheduler = scheduleBootBackfill({
    store, vectorIndex, cfg,
    logger: { info() {}, warn() {} },
    getEmbedder: () => embedder,
    timing: { initialDelayMs: 0, continueDelayMs: 60 }
  });

  // 等第一轮跑完（status 有值），此时续排已经排上但还没触发。
  const deadline = Date.now() + 2000;
  while (scheduler.status() === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const callsAtDispose = calls;
  scheduler.dispose();
  store.close();

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(calls, callsAtDispose, "no embed attempt happened after dispose");
});

test("#604: autoReindexOnBoot: false schedules nothing at all", async () => {
  const { store, vectorIndex, cfg } = setup();
  const scheduler = scheduleBootBackfill({
    store, vectorIndex, cfg: { ...cfg, autoReindexOnBoot: false },
    logger: { info() {}, warn() {} },
    getEmbedder: () => ({ embedSingle: async () => [1, 0, 0], modelHash: "m#1", dimension: 3 }),
    timing: { initialDelayMs: 0, continueDelayMs: 0 }
  });

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(scheduler.status(), null, "the switch is respected");
  assert.equal(store.needsEmbeddingFor("m#1").length, 6, "nothing was embedded");
  scheduler.dispose();
  store.close();
});

test("#604: an embedder that is not ready yet is retried before the run", async () => {
  const { store, vectorIndex, cfg } = setup({ count: 2, batchSize: 2, maxPerBoot: 10 });
  let readyChecks = 0;
  const embedder = {
    get ready() { readyChecks++; return readyChecks > 2; },
    embedSingle: async () => [1, 0, 0],
    modelHash: "m#1",
    dimension: 3
  };

  const scheduler = scheduleBootBackfill({
    store, vectorIndex, cfg,
    logger: { info() {}, warn() {} },
    getEmbedder: () => embedder,
    timing: { initialDelayMs: 0, continueDelayMs: 0, readyRetryDelayMs: 0 }
  });

  const status = await settle(() => scheduler.status());
  scheduler.dispose();

  assert.ok(readyChecks >= 3, "waited for ready instead of giving up on the first check");
  assert.equal(status.finishReason, "drained");
  assert.equal(store.needsEmbeddingFor("m#1").length, 0);
  store.close();
});

test("#604: a synchronous throw before the promise still publishes an error status", async () => {
  // 旧实现的同步 catch 只写了日志、没写 lastBackfill，于是面板读到 null，
  // 显示的是「从来没跑过」而不是「跑了但失败」—— 两种状态的含义完全不同。
  const { store, vectorIndex, cfg } = setup({ count: 2 });
  const scheduler = scheduleBootBackfill({
    store, vectorIndex, cfg,
    logger: { info() {}, warn() {} },
    getEmbedder: () => { throw new Error("embedder blew up"); },
    timing: { initialDelayMs: 0, continueDelayMs: 0, maxContinuations: 0 }
  });

  const status = await settle(() => scheduler.status());
  scheduler.dispose();

  assert.equal(status.state, "error", "the failure is visible instead of reading as never-ran");
  assert.match(status.error, /embedder blew up/);
  store.close();
});
