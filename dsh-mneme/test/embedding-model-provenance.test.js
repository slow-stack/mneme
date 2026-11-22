import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";
import { maintainIndexAfterDream, reEmbedMemory } from "../src/dream.js";
import { testConfig } from "./helpers/test-config.js";

// ==================================================== embedding-model provenance
// Issue #765：一份向量属于哪个模型，必须和向量一起落库。
//
// 缺陷现场：本地 embedder（local-embedder.js）没有 `schedule()`，所以每一笔写入
// 都走 service.js 的 `embedSingle` 分支，而那两个分支只调 store.setEmbedding(id, vec)
// ——store 的第三参 `modelHash` 是 undefined，于是 embedding_model 留空。6008 条
// 正常行有指纹、239 条（切到 local 之后的全部新写入）是 NULL，切得不留痕。
//
// 后果不是"显示不好看"：store.needsEmbeddingFor() 的 WHERE 里写着
// `embedding_model IS NULL OR`，NULL 恒被判 stale。也就是说真正丢了指纹的行，
// 会被当成"每轮都该重嵌"的欠账，状态页的 stale 计数从此永远说不清。
//
// 这里锁四件事：
//   1. embedSingle 分支写入时把 embedder 的指纹一起写进 embedding_model；
//   2. 指纹在**发请求之前**取快照——await 期间模型换了，落库的仍是产出这条向量
//      的那个模型（回来再读就把旧向量盖上新名字，比留空更糟：失配的索引会看起来
//      "已经对齐"，从此不再重建）；
//   3. ready-gate 的排队分支（flushEmbedPending）同样带指纹，不能只有一条路径修了；
//   4. 存量 NULL 行依旧被判 stale —— 这条锁的是 issue 里那个"别拿 vector_meta 兜底"
//      的取舍：兜底会把旧向量错标成新模型，NULL 反而诚实。

function makeService(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig(config) });
  return { store, service };
}

function modelOf(store, id) {
  return store.db.prepare("SELECT embedding_model FROM memories WHERE id = ?").get(id)?.embedding_model;
}

function vecOf(store, id) {
  const raw = store.db.prepare("SELECT embedding FROM memories WHERE id = ?").get(id)?.embedding;
  return raw ? JSON.parse(raw) : null;
}

test("#765: embedSingle writes carry the embedder's model fingerprint", async () => {
  const { store, service } = makeService();
  // 没有 schedule()，只有 embedSingle —— 与 local-embedder.js 同形，
  // 这正是 issue 里所有受害行走过的路径。
  service.setEmbedder({
    modelHash: "Xenova/bge-small-zh-v1.5@cls#dd63bfc1",
    embedSingle: async () => new Array(8).fill(0.25)
  });

  const { memory } = service.saveWithDedupe({ type: "preference", title: "指纹要跟着向量走", content: "x" });
  // saveWithDedupe 内部 scheduleEmbed 走异步 .then，等一拍让写回落库。
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(vecOf(store, memory.id)?.length, 8, "vector landed");
  assert.equal(
    modelOf(store, memory.id),
    "Xenova/bge-small-zh-v1.5@cls#dd63bfc1",
    "embedding_model must record the model that produced this vector, not NULL"
  );
  store.close();
});

test("#765: the fingerprint is snapshotted before the request, not read after the await", async () => {
  const { store, service } = makeService();
  let release;
  const gate = new Promise((r) => { release = r; });
  const embedder = {
    modelHash: "model-A",
    embedSingle: async () => {
      await gate; // 请求悬在半空——切换发生在这段时间里
      return new Array(8).fill(0.5);
    }
  };
  service.setEmbedder(embedder);

  const { memory } = service.saveWithDedupe({ type: "preference", title: "切模型竞态", content: "x" });
  embedder.modelHash = "model-B"; // 用户在这一刻换了 provider
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(
    modelOf(store, memory.id),
    "model-A",
    "the vector was produced by model-A, so it must be filed under model-A"
  );
  store.close();
});

test("#765: the ready-gate queue (flushEmbedPending) also carries the fingerprint", async () => {
  const { store, service } = makeService();
  const embedder = {
    ready: false, // 异步初始化的 embedder：写入先排队
    modelHash: "queued-model",
    embedSingle: async () => new Array(8).fill(0.75)
  };
  service.setEmbedder(embedder);

  const { memory } = service.saveWithDedupe({ type: "preference", title: "排队后补跑", content: "x" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(vecOf(store, memory.id), null, "not ready yet: nothing written while queued");

  embedder.ready = true; // init 落地，下一次轮询会 flush
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(vecOf(store, memory.id)?.length, 8, "queued entry flushed after ready");
  assert.equal(
    modelOf(store, memory.id),
    "queued-model",
    "the flush path must pass the fingerprint too — fixing only scheduleEmbed leaves half the writes NULL"
  );
  store.close();
});

test("#765: vector-index.saveEmbedding forwards the fingerprint to the column", () => {
  const store = createStore(":memory:");
  const vi = createVectorIndex({ store, logger: null });
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const { memory } = service.saveWithDedupe({ type: "preference", title: "索引层传参", content: "x" });

  vi.saveEmbedding(memory.id, new Array(8).fill(0.1), "dream-model-hash");
  assert.equal(modelOf(store, memory.id), "dream-model-hash", "dropping the third argument here silently reverts #765");

  store.close();
});

test("#765: dream's index rebuild files vectors under the embedding model, not the void", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const vectorIndex = createVectorIndex({ store, logger: null });

  const a = service.saveWithDedupe({ type: "preference", title: "合并保留方", content: "x" }).memory;
  const b = service.saveWithDedupe({ type: "preference", title: "被合并方", content: "y" }).memory;

  // maintainIndexAfterDream 的 merge 分支：删掉被并方的向量、给保留方重建。
  // 这条路径与 service 的写入路径完全独立，dream.js 自己调 saveEmbedding。
  await maintainIndexAfterDream(
    [{ action: "merge", ids: [a.id, b.id], keepSource: a.id }],
    service,
    {
      embedder: { modelHash: "dream-model-hash", dimension: 8, embedSingle: async () => new Array(8).fill(0.4) },
      vectorIndex
    }
  );

  assert.equal(vecOf(store, a.id)?.length, 8, "keeper re-embedded");
  assert.equal(
    modelOf(store, a.id),
    "dream-model-hash",
    "dream's re-embed must file the vector under the model that produced it"
  );
  store.close();
});

test("#765: dream's narrative re-embed files the vector under the embedding model", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const vectorIndex = createVectorIndex({ store, logger: null });
  const memory = service.saveWithDedupe({ type: "summary", title: "叙述条", content: "z" }).memory;

  await reEmbedMemory(
    { embedder: { modelHash: "narrative-model", dimension: 8, embedSingle: async () => new Array(8).fill(0.6) }, vectorIndex },
    memory,
    null
  );

  assert.equal(vecOf(store, memory.id)?.length, 8, "narrative re-embedded");
  assert.equal(modelOf(store, memory.id), "narrative-model", "reEmbedMemory must pass the fingerprint too");
  store.close();
});

test("#765: local-style writes leave no stale debt behind", async () => {
  const { store, service } = makeService();
  const model = "Xenova/bge-small-zh-v1.5@cls#dd63bfc1";
  service.setEmbedder({ modelHash: model, embedSingle: async () => new Array(8).fill(0.3) });

  for (let i = 0; i < 5; i++) {
    service.saveWithDedupe({ type: "preference", title: `本地写入 ${i}`, content: "x" });
  }
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(store.count(), 5);
  assert.equal(
    store.countNeedsEmbeddingFor(model),
    0,
    "all five were embedded by `model`, so none of them is a backfill debt"
  );
  store.close();
});

test("#765: pre-existing NULL rows still read as stale (no vector_meta backfill)", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const { memory } = service.saveWithDedupe({ type: "preference", title: "存量 NULL", content: "x" });

  // 模拟修复前落库的现场：有向量、没指纹。
  store.db.prepare("UPDATE memories SET embedding = ?, embedding_model = NULL WHERE id = ?")
    .run(JSON.stringify(new Array(8).fill(0.2)), memory.id);

  assert.equal(
    store.countNeedsEmbeddingFor("Xenova/bge-small-zh-v1.5@cls#dd63bfc1"),
    1,
    "a vector without provenance is honest debt — it must not be silently adopted by the current model"
  );
  store.close();
});

test("#765: dream's update branch (memories/changed body) files the refreshed vector under the model", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const vectorIndex = createVectorIndex({ store, logger: null });
  const mem = service.saveWithDedupe({ type: "preference", title: "正文被改写", content: "旧正文" }).memory;

  // action:"update" 是「正文改过、向量必须重嵌」的分支（dream.js:955 那处）。
  // 它走的是 deleteEmbedding + saveEmbedding，与 merge 的 rebuild 是两条独立路径：
  // 只锁 merge 的话，这处第三次参数被改回两参没有任何测试会红。
  await maintainIndexAfterDream(
    [{ action: "update", ids: [mem.id] }],
    service,
    {
      embedder: { modelHash: "update-model-hash", dimension: 8, embedSingle: async () => new Array(8).fill(0.35) },
      vectorIndex
    }
  );

  assert.equal(vecOf(store, mem.id)?.length, 8, "update branch re-embedded the row");
  assert.equal(
    modelOf(store, mem.id),
    "update-model-hash",
    "the update branch must pass the fingerprint too — dropping it here silently reverts #765"
  );
  store.close();
});

test("#765: sleep's conflict-phase vector backfill files the vector under the embedding model", async () => {
  const { runSleep } = await import("../src/dream/sleep.js");
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const vectorIndex = createVectorIndex({ store, logger: null });

  // 先落两条**没有向量**的记忆：不给 service 装 embedder，否则写入时就被嵌了，
  // 冲突相位的回填分支（sleep.js:271）根本不会跑。
  const a = service.saveWithDedupe({ type: "project", title: "主题X", content: "内容A 关于主题X" }).memory;
  const b = service.saveWithDedupe({ type: "project", title: "主题X副本", content: "内容B 关于主题X" }).memory;
  assert.equal(vecOf(store, a.id), null, "precondition: no vector yet");

  const embedder = {
    modelHash: "conflict-backfill-model",
    dimension: 3,
    // 两条同向向量 → 相似度 0.99，稳过 normal 档 0.85，一定会进候选。
    embed: async (texts) => texts.map((_, i) => (i === 0 ? [1, 0, 0] : [0.99, 0.14, 0])),
    embedSingle: async () => [1, 0, 0]
  };
  const config = { sleepModeEnabled: true, sleepConflictStrictness: "normal", conflictFreezeEnabled: true };
  const ctx = { logger: { warn: () => {}, info: () => {} }, agentDefaultModel: { currentSelection: () => null }, llm: null };

  const result = await runSleep(ctx, service, config, ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.status, "ok", "conflict phase ran on the backfilled vectors");

  // 这条就是 Amarre 指出的裸路径：回填时不传第三参，两行的 embedding_model 都是 NULL，
  // 而它们的向量明明是 conflict-backfill-model 产出的。
  assert.equal(modelOf(store, a.id), "conflict-backfill-model", "backfilled vector must carry the model fingerprint");
  assert.equal(modelOf(store, b.id), "conflict-backfill-model", "backfilled vector must carry the model fingerprint");
  store.close();
});
