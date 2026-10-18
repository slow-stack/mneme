import test from "node:test";
import assert from "node:assert/strict";
import { embedText, embedTextDetailed, createEmbedder } from "../src/embedding.js";

// distill-tx-embed-gap 的"坏了为什么看不出来"半边：embedText 此前把「配置缺」
// 「网络挂」「超时」「HTTP 4xx/5xx」「响应不是 JSON」「响应没有向量」全部压成
// null，回执账本只能统一写 embedding-request-returned-no-vector——分诊不可能。
// embedTextDetailed 把失败模式拆开；embedText 保留旧 null 契约（调用方不变）。

const FULL = {
  enabled: true,
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "text-embedding-3-small"
};

async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("detailed: 成功时 reason 为 null，vector 与旧契约一致", async () => {
  await withFetch(async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1, 2, 3] }] }) }), async () => {
    const out = await embedTextDetailed(FULL, "猫咪");
    assert.deepEqual(out.vector, [1, 2, 3]);
    assert.equal(out.reason, null);
    // 旧包装的 null 契约不变
    assert.deepEqual(await embedText(FULL, "猫咪"), [1, 2, 3]);
  });
});

test("detailed: 配置缺失时逐字段点名，不伪装成网络故障", async () => {
  assert.match((await embedTextDetailed({ ...FULL, model: "" }, "x")).reason, /^config-incomplete:model$/);
  assert.match((await embedTextDetailed({ ...FULL, apiKey: "" }, "x")).reason, /^config-incomplete:apiKey$/);
  assert.match((await embedTextDetailed({ ...FULL, baseUrl: "" }, "x")).reason, /^config-incomplete:baseUrl$/);
  assert.match(await embedTextDetailed(FULL, "").then((o) => o.reason), /config-incomplete:text/);
});

test("detailed: HTTP 状态码进 reason（401 钥匙 / 404 路径 / 429 限流）", async () => {
  await withFetch(async () => ({ ok: false, status: 404, text: async () => "Not Found" }), async () => {
    const out = await embedTextDetailed(FULL, "x");
    assert.equal(out.vector, null);
    assert.equal(out.reason, "http-404:Not Found");
  });
  await withFetch(async () => ({ ok: false, status: 429, text: async () => "" }), async () => {
    const out = await embedTextDetailed(FULL, "x");
    assert.equal(out.reason, "http-429", "空响应体不拼尾巴");
  });
  // 旧包装在这些场景全部 null，不抛
  await withFetch(async () => ({ ok: false, status: 401, text: async () => "denied" }), async () => {
    assert.equal(await embedText(FULL, "x"), null);
  });
});

test("detailed: 超时与网络错误分型，不混为一谈", async () => {
  await withFetch(async () => {
    const err = new Error("socket hang up");
    err.name = "TypeError";
    throw err;
  }, async () => {
    const out = await embedTextDetailed(FULL, "x");
    assert.match(out.reason, /^request-failed:network:socket hang up/);
  });
  await withFetch(async () => {
    const err = new Error("The operation was aborted");
    err.name = "TimeoutError";
    throw err;
  }, async () => {
    const out = await embedTextDetailed(FULL, "x");
    assert.match(out.reason, /^request-failed:timeout:/, "慢和不通是两种病");
  });
});

test("detailed: 响应不是 JSON 与响应没有向量各自有名", async () => {
  await withFetch(async () => ({ ok: true, json: async () => { throw new Error("bad"); } }), async () => {
    const out = await embedTextDetailed(FULL, "x");
    assert.equal(out.reason, "response-not-json");
  });
  await withFetch(async () => ({ ok: true, json: async () => ({ data: [] }) }), async () => {
    const out = await embedTextDetailed(FULL, "x");
    assert.equal(out.reason, "response-no-vector");
  });
});

test("embedFor 回执账本带上可区分 reason（不再是统一的 no-vector）", async () => {
  const receipts = [];
  const embedder = createEmbedder({
    store: { setEmbedding() {} },
    settings: { getVectorConfig: () => FULL },
    logger: { info() {}, warn() {} }
  });
  // embedReceipts 在账本上；rejection 已在 schedule() 内消化，这里直接等 schedule promise。
  await withFetch(async () => ({ ok: false, status: 404, text: async () => "no route" }), async () => {
    const r = await embedder.schedule({ id: "m1", title: "t", content: "c" });
    assert.equal(r.status, "failed");
    assert.equal(r.reason, "http-404:no route");
  });
  await withFetch(async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1, 2, 3] }] }) }), async () => {
    const r = await embedder.schedule({ id: "m2", title: "t", content: "c" });
    assert.equal(r.status, "ok");
    assert.equal(r.dim, 3);
  });
  const snap = embedder.embedReceipts();
  assert.equal(snap.totals.failed, 1);
  assert.equal(snap.totals.ok, 1);
  assert.equal(snap.lastFailReason, "http-404:no route", "账本记的是分诊后的原因");
});
