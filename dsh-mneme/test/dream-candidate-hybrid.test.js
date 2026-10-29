import test from "node:test";
import assert from "node:assert/strict";
import { createDreamScheduler } from "../src/dream.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";
import { parseEntries } from "./helpers/dream-mock.js";

// Issue #125：候选集构造从"纯时间窗口"扩成"窗口 ∪ 向量翻出的高相似组"。
// 实测背景：45 对「双方活跃且 sim≥0.85」里 0 对能同时进窗口（窗口覆盖率 11.7%）,
// 纯时间窗口让"该合并的一对"几乎永远碰不到面。
//
// 观察点统一用 mock LLM 收到的候选列表（listText 里的 id=/title= 行）——那就是
// snapshot 的真实内容，比读内部变量更接近"LLM 实际看到了什么"。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const vectorIndex = createVectorIndex({ store });
  const embedder = {
    embedSingle: async () => [1, 0, 0],
    embed: async (texts) => texts.map(() => [1, 0, 0]),
    schedule: () => {},
    modelHash: "mock#1",
    dimension: 3
  };
  service.setEmbedder(embedder);
  service.setVectorIndex(vectorIndex);
  return { store, service, vectorIndex, embedder };
}

/** Save a memory with a pinned embedding. */
function seed(service, vectorIndex, title, vec) {
  const m = service.saveWithDedupe({ type: "project", title, content: `${title} 的内容`, importance: 3 }).memory;
  vectorIndex.saveEmbedding(m.id, vec);
  return m;
}

/** Capture the candidate titles the LLM was handed. */
// 注：helpers 的 mockCtx 过去靠 userText.startsWith("id=") 区分阶段，semantic 预分组把清单
// 头换成「# 聚类 N」就误判成 summary；#501/#493 把它的判据换成了清单形状（includes("| type=")），
// 这里改用 system prompt 判定，与 listText 的形态解耦。
function stubCtx(consolidationReply) {
  const seen = { titles: [] };
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock-model" }) },
    llm: {
      async *stream(options) {
        const sys = options.messages.find((m) => m.role === "system")?.content?.[0]?.text ?? "";
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        const isConsolidation = sys.includes("记忆巩固");
        if (isConsolidation) {
          seen.titles = parseEntries(userText).map((e) => e.title);
          yield { type: "text-delta", index: 0, text: typeof consolidationReply === "function" ? consolidationReply() : consolidationReply };
        } else {
          yield { type: "text-delta", index: 0, text: "记忆库总览：测试桩。" };
        }
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
  return { ctx, seen };
}

function capture() {
  return stubCtx("[]");
}

function scheduler(config, semantic) {
  return createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0, semantic });
}

const baseCfg = { dreamProvider: "mock", dreamModel: "mock-model" };

test("issue#125 window (default): candidates are exactly the newest dreamMaxSnapshotSize entries", async () => {
  const { store, service } = setup();
  // 同毫秒保存会让 updated_at 并列、排序退化到 id（UUID 随机）——插小延时保证严格递增。
  for (let i = 0; i < 5; i++) {
    service.saveWithDedupe({ type: "project", title: `记忆${i}`, content: `内容${i}`, importance: 3 });
    await sleep(3);
  }
  const { ctx, seen } = capture();
  await scheduler().runDream(ctx, service, { ...baseCfg, dreamMaxSnapshotSize: 3 });
  assert.deepEqual(seen.titles, ["记忆4", "记忆3", "记忆2"], "newest three, updated_at desc — 与 v0.7.31 逐条一致");
  store.close();
});

test("issue#125 hybrid: a highly similar pair sitting outside the window is pulled in", async () => {
  const { store, service, vectorIndex, embedder } = setup();
  // 窗口外（最老）：一对高相似（同向量 → cos 1.0）
  const a = seed(service, vectorIndex, "老旧方案A", [1, 0, 0]);
  await sleep(3);
  const b = seed(service, vectorIndex, "老旧方案B", [1, 0, 0]);
  await sleep(3);
  // 窗口内（最新 3 条）：彼此不相似（正交）
  seed(service, vectorIndex, "近期甲", [0, 1, 0]);
  await sleep(3);
  seed(service, vectorIndex, "近期乙", [0, 0, 1]);
  await sleep(3);
  seed(service, vectorIndex, "近期丙", [0.5, 0.5, 0.7]);

  const semantic = { embedder, vectorIndex };
  const { ctx, seen } = capture();
  await scheduler({}, semantic).runDream(ctx, service, {
    ...baseCfg, dreamMaxSnapshotSize: 3, dreamCandidateMode: "hybrid"
  });
  assert.ok(seen.titles.includes(a.title) && seen.titles.includes(b.title),
    "the out-of-window similar pair reached the candidate list");
  store.close();
});

test("issue#125 hybrid: dreamCandidateMax widens the cap, the window is still included", async () => {
  const { store, service, vectorIndex, embedder } = setup();
  const a = seed(service, vectorIndex, "外窗A", [1, 0, 0]);
  await sleep(3);
  const b = seed(service, vectorIndex, "外窗B", [1, 0, 0]);
  await sleep(3);
  seed(service, vectorIndex, "窗内甲", [0, 1, 0]);
  await sleep(3);
  seed(service, vectorIndex, "窗内乙", [0, 0, 1]);

  const semantic = { embedder, vectorIndex };
  const { ctx, seen } = capture();
  await scheduler({}, semantic).runDream(ctx, service, {
    ...baseCfg, dreamMaxSnapshotSize: 2, dreamCandidateMode: "hybrid", dreamCandidateMax: 4
  });
  assert.equal(seen.titles.length, 4, "candidate total capped at max(window, dreamCandidateMax)");
  assert.ok(seen.titles.includes(a.title) && seen.titles.includes(b.title), "vector group kept");
  assert.equal(new Set(seen.titles).size, seen.titles.length, "no duplicate members");
  store.close();
});

test("issue#125 hybrid: three mutually similar entries arrive as one contiguous group", async () => {
  const { store, service, vectorIndex, embedder } = setup();
  // 一簇 3 条互相相似（同向量）
  const c1 = seed(service, vectorIndex, "簇甲", [1, 0, 0]);
  await sleep(3);
  const c2 = seed(service, vectorIndex, "簇乙", [1, 0, 0]);
  await sleep(3);
  const c3 = seed(service, vectorIndex, "簇丙", [1, 0, 0]);
  await sleep(3);
  seed(service, vectorIndex, "窗外无关", [0, 1, 0]);

  const semantic = { embedder, vectorIndex };
  const { ctx, seen } = capture();
  await scheduler({}, semantic).runDream(ctx, service, {
    ...baseCfg, dreamMaxSnapshotSize: 1, dreamCandidateMode: "hybrid", dreamCandidateMax: 4
  });
  const idx = [c1.title, c2.title, c3.title].map((t) => seen.titles.indexOf(t));
  assert.ok(idx.every((i) => i >= 0), "all cluster members are candidates");
  const sorted = [...idx].sort((x, y) => x - y);
  assert.deepEqual(sorted, [sorted[0], sorted[0] + 1, sorted[0] + 2],
    "cluster members are contiguous — 一簇按一个候选单元展开，不会被拆成散落的对");
  store.close();
});

test("issue#125 hybrid without an embedder falls back to the plain window (never fails)", async () => {
  const { store, service } = setup();
  for (let i = 0; i < 4; i++) {
    service.saveWithDedupe({ type: "project", title: `回滚${i}`, content: `内容${i}`, importance: 3 });
    await sleep(3);
  }
  const { ctx, seen } = capture();
  // semantic = null → hybrid 分支不激活
  const result = await scheduler({}, null).runDream(ctx, service, {
    ...baseCfg, dreamMaxSnapshotSize: 2, dreamCandidateMode: "hybrid"
  });
  assert.equal(seen.titles.length, 2, "falls back to the window");
  assert.equal(result.ok, true, "the run still succeeds");
  assert.deepEqual(seen.titles, ["回滚3", "回滚2"]);
  store.close();
});

test("issue#125 hybrid: a similarity cluster outside the window is resolvable in one run", async () => {
  const { store, service, vectorIndex, embedder } = setup();
  const a = seed(service, vectorIndex, "旧版本", [1, 0, 0]);
  await sleep(3);
  const b = seed(service, vectorIndex, "新版本", [1, 0, 0]);
  await sleep(3);
  seed(service, vectorIndex, "近期条目", [0, 1, 0]);

  const semantic = { embedder, vectorIndex };
  // LLM 只对这一对下一道 merge 决策——它在窗口外，window 档下永远不会被看到。
  const { ctx } = stubCtx(() => JSON.stringify([
    { action: "merge", ids: [b.id, a.id], keepSource: b.id, title: "版本总览", content: "合并后", importance: 4 }
  ]));
  const result = await scheduler({}, semantic).runDream(ctx, service, {
    ...baseCfg, dreamMaxSnapshotSize: 2, dreamCandidateMode: "hybrid"
  });
  assert.equal(result.ok, true, "the out-of-window pair is adjudicated (not a whole-batch rejection)");
  assert.equal(store.getById(a.id).archived, true, "the older version was merged away");
  assert.equal(store.getById(b.id).title, "版本总览");
  store.close();
});

// ------------------------------------------------------- backfill & 降级路径

test("issue#125 hybrid: entries without a cached vector are embedded on the fly", async () => {
  const { store, service, vectorIndex, embedder } = setup();
  // 故意不预设向量：collectCandidateVectors 必须自己补齐后再比较。
  const a = service.saveWithDedupe({ type: "project", title: "无向量A", content: "内容A", importance: 3 }).memory;
  await sleep(3);
  const b = service.saveWithDedupe({ type: "project", title: "无向量B", content: "内容B", importance: 3 }).memory;
  await sleep(3);
  seed(service, vectorIndex, "窗内条目", [0, 1, 0]);
  const { ctx, seen } = capture();
  await scheduler({}, { embedder, vectorIndex }).runDream(ctx, service, {
    ...baseCfg, dreamMaxSnapshotSize: 1, dreamCandidateMode: "hybrid", dreamCandidateMax: 4
  });
  assert.ok(seen.titles.includes(a.title) && seen.titles.includes(b.title),
    "missing vectors are backfilled (embedder.embed), then the pair is compared");
  store.close();
});

test("issue#125 hybrid: cross-type pairs join only when allowCrossTypeMerge is on", async () => {
  const { store, service, vectorIndex, embedder } = setup();
  const proj = service.saveWithDedupe({ type: "project", title: "项目侧", content: "x", importance: 3 }).memory;
  vectorIndex.saveEmbedding(proj.id, [1, 0, 0]);
  await sleep(3);
  const pref = service.saveWithDedupe({ type: "preference", title: "偏好侧", content: "y", importance: 3 }).memory;
  vectorIndex.saveEmbedding(pref.id, [1, 0, 0]);
  await sleep(3);
  seed(service, vectorIndex, "窗内条目", [0, 1, 0]);
  const semantic = { embedder, vectorIndex };
  const cfg = { ...baseCfg, dreamMaxSnapshotSize: 1, dreamCandidateMode: "hybrid", dreamCandidateMax: 4 };

  const off = capture();
  await scheduler({}, semantic).runDream(off.ctx, service, cfg);
  assert.ok(!off.seen.titles.includes(pref.title), "cross-type pair stays out by default (same-type only)");

  const on = capture();
  await scheduler({}, semantic).runDream(on.ctx, service, { ...cfg, allowCrossTypeMerge: true });
  assert.ok(on.seen.titles.includes(proj.title) && on.seen.titles.includes(pref.title),
    "cross-type pair enters the candidate set once explicitly allowed");
  store.close();
});

test("issue#125 hybrid: a throwing embedder degrades to the plain window", async () => {
  const { store, service, vectorIndex } = setup();
  for (let i = 0; i < 3; i++) {
    service.saveWithDedupe({ type: "project", title: `降级${i}`, content: `内容${i}`, importance: 3 });
    await sleep(3);
  }
  const boom = {
    embedSingle: async () => { throw new Error("embed down"); },
    embed: async () => { throw new Error("embed down"); },
    schedule: () => {},
    modelHash: "x",
    dimension: 3
  };
  const { ctx, seen } = capture();
  const result = await scheduler({}, { embedder: boom, vectorIndex }).runDream(ctx, service, {
    ...baseCfg, dreamMaxSnapshotSize: 2, dreamCandidateMode: "hybrid"
  });
  assert.equal(result.ok, true, "向量层是增强而非依赖：嵌入失败不能让 run 失败");
  assert.deepEqual(seen.titles, ["降级2", "降级1"], "falls back to the plain window");
  store.close();
});

test("issue#125 hybrid: a throwing vector index degrades to the plain window", async () => {
  const { store, service, embedder } = setup();
  for (let i = 0; i < 3; i++) {
    service.saveWithDedupe({ type: "project", title: `索引坏${i}`, content: `内容${i}`, importance: 3 });
    await sleep(3);
  }
  // getEmbedding 在 hybridCandidateMembers 的 try 内抛错 → 整体回落纯窗口。
  const badIndex = {
    getEmbedding: () => { throw new Error("index down"); },
    saveEmbedding: () => {}
  };
  const { ctx, seen } = capture();
  const result = await scheduler({}, { embedder, vectorIndex: badIndex }).runDream(ctx, service, {
    ...baseCfg, dreamMaxSnapshotSize: 2, dreamCandidateMode: "hybrid"
  });
  assert.equal(result.ok, true, "run still succeeds");
  assert.deepEqual(seen.titles, ["索引坏2", "索引坏1"], "falls back to the plain window");
  store.close();
});
