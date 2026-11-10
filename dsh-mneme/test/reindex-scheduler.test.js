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

// settle() 只要求「连续三次读到同一个状态」，对几百行的长跑会提前返回 running。
// 需要终态的场景用这个：等到 state 变成 finished / error 再返回。
async function waitForFinished(statusOf, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = statusOf();
    if (now && (now.state === "finished" || now.state === "error")) return now;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`scheduler never reached a terminal state within ${timeoutMs}ms`);
}

// 续排场景下「第一个终态」不是答案：第一轮 errored 之后还会再排一轮。
// 需要等到某个具体的 finishReason 出现才算数。
async function waitForReason(statusOf, reason, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const now = statusOf();
    if (now) last = now;
    if (now && now.state === "finished" && now.finishReason === reason) return now;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `scheduler never reported "${reason}" within ${timeoutMs}ms (last=${JSON.stringify(last)})`
  );
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
  // 全行永久失败 → finishReason stalled。立刻再排只会把同几行再烧一遍，
  // 所以正确行为是停手，把重试留给下一次启动（与 #128 的契约一致）。
  // 用 null 向量（empty-vector，对该行是永久性）而不是抛错：抛错属于
  // `error:` 桶，是瞬时故障，走 errored 那条更短的续排路径，见下面两个用例。
  const { store, vectorIndex, cfg } = setup({ count: 4, batchSize: 10, maxPerBoot: 100 });
  let calls = 0;
  const embedder = {
    embedSingle: async () => { calls++; return null; },
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

test("#604: a dead prefix deeper than the pick window stops the scheduler instead of spinning", async () => {
  // 回归 Ephor 实测的那条悬崖：死前缀 >= maxWindow(500) 时，每轮窗口都被死行
  // 占满、被 attempted 截断，rows 永远非空、indexed 恒 0，于是 finishReason 落到
  // capped、调度器继续续排。默认配置连跑 21 轮：每轮 indexed=0 / failed=500，
  // 累计 provider 调用 10500 次，好行 0/10 嵌入。
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  for (let i = 0; i < 10; i++) {
    service.saveWithDedupe({ type: "preference", title: `好行${i}`, content: `good-${i}` });
  }
  for (let i = 0; i < 500; i++) {
    service.saveWithDedupe({ type: "preference", title: `坏行${i}`, content: `bad-${i}` });
  }
  const vectorIndex = createVectorIndex({ store });
  const cfg = {
    autoReindexOnBoot: true,
    reindexMaxPerBoot: 500,
    reindexBatchSize: 10,
    reindexRateLimitMs: 0
  };
  let calls = 0;
  const embedder = {
    embedSingle: async (text) => {
      calls++;
      return String(text).includes("bad-") ? null : [1, 0, 0];
    },
    modelHash: "m#1",
    dimension: 3
  };

  const scheduler = scheduleBootBackfill({
    store, vectorIndex, cfg,
    logger: { info() {}, warn() {} },
    getEmbedder: () => embedder,
    timing: { initialDelayMs: 0, continueDelayMs: 0 }
  });

  const status = await waitForFinished(() => scheduler.status());
  scheduler.dispose();
  assert.equal(status.finishReason, "stalled", "no progress is reported honestly");
  assert.equal(status.continuation, 0, "no continuation: the next boot is the retry point");
  assert.equal(calls, 500, "one run, one attempt per row — not 21 rounds of the same 500");
  assert.equal(store.needsEmbeddingFor("m#1", 5000).length, 510, "everything stays queued");
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

test("#604: a transient provider outage retries inside the boot instead of waiting for the next start", async () => {
  // 一轮 batch 10 刚好全撞上 503：indexed === 0，但这是运气不好，不是死行。
  // 判成 stalled 会把重试推到下次启动（可能几小时后），而 provider 一秒后就好了。
  // 判据在 failureReasons 里：抛错落在 `error:` 桶（瞬时），null 向量落在
  // `empty-vector`（对该行是永久性）。
  const { store, vectorIndex, cfg } = setup({ count: 10, batchSize: 10, maxPerBoot: 500 });
  let calls = 0;
  const embedder = {
    embedSingle: async () => {
      calls++;
      // 第一轮的 10 次全挂，之后恢复。
      if (calls <= 10) throw new Error("503 Service Unavailable");
      return [1, 0, 0];
    },
    modelHash: "m#1",
    dimension: 3
  };

  const scheduler = scheduleBootBackfill({
    store, vectorIndex, cfg,
    logger: { info() {}, warn() {} },
    getEmbedder: () => embedder,
    timing: { initialDelayMs: 0, continueDelayMs: 0 }
  });

  const status = await waitForReason(() => scheduler.status(), "drained");
  scheduler.dispose();

  assert.equal(status.finishReason, "drained", "the retry rode out the outage and finished");
  assert.ok(status.continuation >= 1, "a retry actually happened inside this boot");
  assert.equal(store.needsEmbeddingFor("m#1", 100).length, 0, "every row ended up embedded");
  store.close();
});

test("#604: a provider that stays down stops after the small error budget", async () => {
  // 反面：provider 一直挂。errored 值得重试，但不能用 capped 的 20 轮预算陪跑，
  // 否则「瞬时」这个借口就变成了另一个活锁。
  // 断言必须看「排了几轮」，不能只看「调用次数有没有超」——后者在调用一多就
  // dispose，分辨不出 4 轮和 20 轮（变异自证时确实漏过这条）。
  const { store, vectorIndex, cfg } = setup({ count: 10, batchSize: 10, maxPerBoot: 500 });
  let calls = 0;
  let runs = 0;
  const embedder = {
    embedSingle: async () => {
      calls++;
      throw new Error("503 Service Unavailable");
    },
    modelHash: "m#1",
    dimension: 3
  };

  const scheduler = scheduleBootBackfill({
    store, vectorIndex, cfg,
    logger: { info() {}, warn() {} },
    getEmbedder: () => embedder,
    onStatus: (s) => { if (s.state === "running") runs++; },
    timing: { initialDelayMs: 0, continueDelayMs: 0, maxErrorContinuations: 3 }
  });

  // 等到调用数不再增长（调度器真的停手），而不是等到某个固定上限。
  const deadline = Date.now() + 10000;
  let lastCalls = -1;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    if (calls !== lastCalls) { lastCalls = calls; quietSince = Date.now(); }
    else if (Date.now() - quietSince > 300) break;
  }
  const status = scheduler.status();
  scheduler.dispose();

  assert.equal(status.finishReason, "errored", "an unreachable provider is not a dead row");
  // 1 次初始 + 3 次重试 = 4 轮。若走 maxContinuations(20) 这里会是 21。
  assert.equal(runs, 4, `the error budget is 3 retries, not the 20-round cap (runs=${runs})`);
  assert.equal(calls, 40, `4 rounds × 10 rows (calls=${calls})`);
  assert.equal(store.needsEmbeddingFor("m#1", 100).length, 10, "everything stays queued");
  store.close();
});
