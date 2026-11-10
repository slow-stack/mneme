import test from "node:test";
import assert from "node:assert/strict";
import { createEmbedder } from "../src/embedding.js";

// issue #135: the legacy OpenAI-compatible embedder is an object literal with no
// async init, so api.js's generic `"ready" in embedder` branch used to fall
// through to "assume usable" — the status card stayed green while baseUrl /
// apiKey / model were all empty and not a single vector could be produced
// ("绿色假阳性"). These tests pin the real predicate and the getter semantics.

const FULL = {
  enabled: true,
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "text-embedding-3-small"
};

/** Build the embedder against a settings double + a recording store. */
function make(cfg, { live = false } = {}) {
  const writes = [];
  const box = { cfg };
  const embedder = createEmbedder({
    store: { setEmbedding: (id, vector) => writes.push({ id, vector }) },
    settings: { getVectorConfig: () => (live ? box.cfg : cfg) },
    logger: { info() {}, warn() {} }
  });
  return { embedder, writes, box };
}

test("#135 legacy OpenAI embedder reports ready/configured from the config", () => {
  const { embedder } = make(FULL);
  assert.equal(embedder.ready, true, "fully configured → ready");
  assert.equal(embedder.configured, true);

  // Any of the four fields missing → not configured. `enabled` flips to false,
  // the rest are blanked (the shape the settings panel leaves behind when the
  // user never filled the vector section in).
  for (const key of ["enabled", "baseUrl", "apiKey", "model"]) {
    const broken = { ...FULL, [key]: key === "enabled" ? false : "" };
    const { embedder: e } = make(broken);
    assert.equal(e.configured, false, `blank ${key} → not configured`);
    assert.equal(e.ready, false, `blank ${key} → not ready`);
  }

  // Defensive: a settings double returning {} (or nothing) must not throw.
  assert.equal(make({}).embedder.ready, false);
  assert.equal(make(undefined).embedder.ready, false);
});

test("#135 ready/configured are live getters, not boot-time snapshots", () => {
  // The panel writes vector-config through settings; the legacy embedder reads
  // it per call (same as embed()), so fixing the config must not need a restart.
  const { embedder, box } = make(FULL, { live: true });
  assert.equal(embedder.ready, true);
  box.cfg = { ...FULL, apiKey: "" };
  assert.equal(embedder.ready, false, "getter re-reads the live config");
  assert.equal(embedder.configured, false);
  box.cfg = FULL;
  assert.equal(embedder.ready, true, "…and recovers once the config is complete");
});

test("#135 unconfigured embedder never reaches the network", async () => {
  const { embedder, writes } = make({ ...FULL, apiKey: "" });
  // A real fetch here would go out with an empty bearer token.
  assert.equal(await embedder.embed("hello"), null);
  assert.equal(await embedder.embedSingle("hello"), null);

  embedder.schedule({ id: "m1", title: "t", content: "c" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(writes, [], "schedule() must not store an embedding");

  // A memory without an id is a no-op (never a store write with undefined id).
  embedder.schedule(null);
  embedder.schedule({});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(writes, []);
});

test("#135 unconfigured embedder reports no model fingerprint or dimension", () => {
  const { embedder } = make(FULL);
  assert.equal(embedder.name, "OpenAI", "explicit name for the status card");
  assert.equal(embedder.dimension, undefined, "no dimension before a first embed");
  // model#hex — same fingerprint format the local embedders use.
  assert.match(embedder.modelHash, /^text-embedding-3-small#[0-9a-f]+$/);
  assert.equal(make({ ...FULL, model: "" }).embedder.modelHash, undefined);
  assert.equal(make({ ...FULL, enabled: false }).embedder.modelHash, undefined);
});

// ── 覆盖补齐：embed 成功/降级、embedSingle 兜底、reindexMissing、schedule 成功路径 ──

/** 临时替换全局 fetch（embedText 直接调它），fn 结束后恢复。 */
async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const okResponse = (embedding) => ({
  ok: true,
  json: async () => ({ data: [{ embedding }] })
});

test("embed: 完整配置时走真实 fetch，成功返回向量并记下维度", async () => {
  const { embedder } = make(FULL);
  await withFetch(async () => okResponse([1, 2, 3, 4]), async () => {
    const vec = await embedder.embed("猫咪");
    assert.deepEqual(vec, [1, 2, 3, 4]);
    assert.equal(embedder.dimension, 4, "成功嵌入后记下维度供指纹用");
  });
});

test("embed: 网络失败 / 非 2xx / 响应不可用都降级为 null，不抛", async () => {
  const { embedder } = make(FULL);
  await withFetch(async () => { throw new Error("ECONNREFUSED"); }, async () => {
    assert.equal(await embedder.embed("x"), null);
  });
  await withFetch(async () => ({ ok: false }), async () => {
    assert.equal(await embedder.embed("x"), null);
  });
  await withFetch(async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }), async () => {
    assert.equal(await embedder.embed("x"), null);
  });
  await withFetch(async () => ({ ok: true, json: async () => ({ data: [] }) }), async () => {
    assert.equal(await embedder.embed("x"), null, "空 data 数组不可用");
  });
});

test("embedSingle: embed 缺失时兜底返回 null（统一旧接口契约）", async () => {
  const { embedder } = make(FULL);
  assert.equal(await embedder.embedSingle.call({}, "x"), null, "无 embed 方法时返回 null 而非抛错");
});

test("reindexMissing: 逐行回填并统计 indexed/skipped，有成功才记模型指纹", async () => {
  let markCalls = 0;
  const rows = [{ id: "m1", title: "t1", content: "c1" }, { id: "m2", title: "t2", content: "c2" }];
  const writes = [];
  const embedder = createEmbedder({
    store: {
      setEmbedding: (id, v) => writes.push({ id, v }),
      needsEmbedding: () => rows
    },
    settings: { getVectorConfig: () => FULL },
    vectorIndex: { markModel: () => { markCalls++; } }
  });
  let call = 0;
  await withFetch(async () => okResponse([call++, 0]), async () => {
    const result = await embedder.reindexMissing(50);
    assert.equal(result.indexed, 2);
    assert.equal(result.skipped, 0);
    assert.equal(writes.length, 2);
    assert.equal(markCalls, 1, "有成功回填才记模型指纹");
  });
});

test("reindexMissing: 未启用时直接返回 0/0，不碰 store", async () => {
  const { embedder } = make({ ...FULL, enabled: false });
  const result = await embedder.reindexMissing(50);
  assert.deepEqual(result, { indexed: 0, failed: 0, skipped: 0 });
});

test("reindexMissing: 嵌入失败的行走 failed，不算 indexed、也不算 skipped", async () => {
  // #604：`skipped = rows.length - indexed` 把「试过没拿到向量」和「压根没碰」
  // 混成一个数。每一行都被尝试过，所以 skipped 必须是 0，失败单列。
  const writes = [];
  const embedder = createEmbedder({
    store: {
      setEmbedding: (id, v) => writes.push({ id, v }),
      needsEmbedding: () => [{ id: "m1", title: "t", content: "c" }]
    },
    settings: { getVectorConfig: () => FULL }
  });
  await withFetch(async () => ({ ok: false }), async () => {
    const result = await embedder.reindexMissing(50);
    assert.equal(result.indexed, 0);
    assert.equal(result.failed, 1, "试过但没拿到向量 → failed");
    assert.equal(result.skipped, 0, "选择器选中了它，所以它没有被跳过");
  });
});

test("reindexMissing: 一行写入抛错不中断其余行，且计入 failed", async () => {
  // 注意：这里抛错的不能是 embedding 请求 —— embedTextDetailed 把网络错误吞成
  // request-failed:network，永远不抛。真正会让这个 catch 跑起来的是写库失败
  // （约束冲突、磁盘满），所以用 setEmbedding 抛。
  const writes = [];
  const embedder = createEmbedder({
    store: {
      setEmbedding: (id, v) => {
        if (id === "m1") throw new Error("SQLITE_CONSTRAINT");
        writes.push({ id, v });
      },
      needsEmbedding: () => [
        { id: "m1", title: "t1", content: "a" },
        { id: "m2", title: "t2", content: "b" }
      ]
    },
    settings: { getVectorConfig: () => FULL },
    logger: { info() {}, warn() {} }
  });
  await withFetch(async () => okResponse([1, 0]), async () => {
    const result = await embedder.reindexMissing(50);
    assert.equal(result.failed, 1, "写库失败的那行算 failed");
    assert.equal(result.indexed, 1, "后面那行仍然被处理，循环没有中断");
    assert.equal(writes.length, 1);
  });
});

test("schedule: 嵌入成功时写入 store 并记 info 日志（embedFor 成功路径）", async () => {
  const writes = [];
  let logged = 0;
  const embedder = createEmbedder({
    store: { setEmbedding: (id, v) => writes.push({ id, v }) },
    settings: { getVectorConfig: () => FULL },
    logger: { info: () => { logged++; }, warn() {} },
    vectorIndex: { markModel() {} }
  });
  await withFetch(async () => okResponse([0.1, 0.2]), async () => {
    embedder.schedule({ id: "m9", title: "t", content: "c" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(writes.length, 1);
  assert.equal(logged, 1, "成功嵌入记一行 info 日志");
});
