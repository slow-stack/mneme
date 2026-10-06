import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createInjector, getInjectionSnapshot } from "../src/inject.js";
import { createSettings } from "../src/settings.js";
import { createTools } from "../src/tools.js";
import { createDreamScheduler } from "../src/dream.js";
import { createVectorIndex } from "../src/vector-index.js";
import { Config } from "../src/config.js";
import { mockCtx } from "./helpers/dream-mock.js";

// --- 状态追踪回归集（issue #218 前置）----------------------------------------
//
// 读侧形状锁：一次 supersede 之后的终态必须同时满足三条互相牵制的性质——
//   (a) 检索链（service.searchMemories / store.search / memory_search 工具）
//       不得返回被取代的行、也不得返回它的旧值正文；
//   (b) 注入链（src/inject.js 的 candidates 选择 + render）不得把旧值渲染进
//       系统提示；
//   (c) 旧值仍可通过 memory_get 按 id 取回——supersede 是「归档」不是「删除」。
//
// 防的回归类型：读侧的归档过滤被绕过。具体有三个已知的绕过面——
//   1) 某条召回支路（keyword SQL / vector / BM25 / entity）忘了带
//      `archived = 0`，旧值借那条支路回到候选池；
//   2) 注入候选池忘了过滤 archived（或只过滤 forgotten），旧值被渲染进
//      每一轮的系统提示，模型此后持续引用一个已被取代的旧状态；
//   3) 有人为了让「归档旧值可查阅」更好用，顺手把 memory_get 之外的口子
//      （search/list）也放开——(a)(b) 与 (c) 是一组：只放开任意一条就会
//      在这里变红。这就是「保留旧记忆锚」策略的前置条件：保留 ≠ 可召回。
//
// 支路形状锁（第 (d)(e) 两条用例）：前三 (a)(b)(c) 跑在 config:{}（无 embedder）
// 上，mode=auto 实际只落 keyword + BM25，语义支路一次都没被走到。后两条装上
// 确定性假 embedder（纯函数、零网络、无真实模型）与向量索引，把同一个回归
// 类型钉到语义支路上：
//   (d) 真索引：mode=vector/hybrid/auto 经 vectorIndex → store.searchVector 时，
//       SQL 的 `archived = 0` 是这条支路唯一的墙——src/service.js 的向量结果
//       没有 JS 层 archived 复查，拆掉 SQL 过滤旧值立刻借向量回到候选池；
//   (e) 故障注入型假索引：刻意让「源侧失守」（直接返回带 archived 的行），压
//       src/service.js:1583（向量命中池）与 :1594（lastSemanticRecall 语义
//       缓存池）两处 JS 层 `!m.archived` 兜底——源侧正常时本就滤过归档，只有
//       源侧失守才轮到这两行承重（同形状的 :1607 是 BM25 兜底，其上游
//       bm25Recall 已在 src/service.js:472 按 JS 滤过 archived，属非承重保险）。
//
// 夹具刻意不手改数据库字段：走 dream 的 consolidation 决策 →
// validateDecisions → applySupersede，拿到的是仓库真实的 supersede 终态
// （loser 追加取代注记后被 setArchived(true)，winner 正文一字不动）。

const OLD_TITLE = "缓存池配置 v1";
const NEW_TITLE = "缓存池配置 v2";
// 正文里放两个互不包含的唯一令牌——只用「20 条 / 200 条」这类前缀相同的
// 数字做子串断言会自己咬到自己（"20 条" 是 "200 条" 的子串吗？边界上极易
// 写错），令牌化之后 includes 的语义没有歧义。
const OLD_MARK = "ALPHA-7721";
const NEW_MARK = "BETA-9930";
// 两个版本共享的查询词：keyword 支路靠它把参与 supersede 的两行都捞进候选，
// 于是「旧值不在结果里」只能是归档过滤干的事，而不是「压根没匹配上」。
const QUERY = "缓存池配置";
// 语义支路专用的探针查询：只出现在假 embedder 的映射规则里，正文与标题都不含
// 它，因此 keyword / BM25 / entity 三条词法支路对它必然空手——命中只能来自
// 向量支路，压的正是 vectorIndex → store.searchVector 这条链。
const PROBE = "SEM-PROBE-4477";

// 假 embedder：确定性纯函数替身——零网络、零真实模型、零随机。含任一语义令牌
// 的文本（两条项目记忆各含自己的令牌，探针查询即 PROBE）都映到 [1,0,0]，其余
// 落 [0,1,0]：老/新两行在向量空间里完全同向，旧值若浮出只可能是归档过滤失守，
// 而不是「它压根没被嵌入」。
//
// `schedule` 把写入路径排进一个队列（真实 embedder 也是异步写回），由夹具在
// dream 之后用 `flush(store)` 显式排空——这样嵌入写入是确定的、没有悬空异步。
// 这一步不是可有可无的：service.update 改正文时会先落空向量再重排嵌入（正文
// 变了旧向量即失效），supersede 恰好 update 了 loser 的正文（追加取代注记），
// 所以 loser 的向量是「重嵌入」补回来的——排空队列后 loser 才真的带着向量躺在
// 归档态里，向量支路的 archived 过滤也才真的被压到。
function semanticEmbedder() {
  const pending = [];
  const lit = (text) =>
    String(text).includes(PROBE) || String(text).includes(OLD_MARK) || String(text).includes(NEW_MARK);
  const one = async (text) => (lit(text) ? [1, 0, 0] : [0, 1, 0]);
  return {
    embedSingle: one,
    embed: async (texts) => texts.map((t) => (lit(t) ? [1, 0, 0] : [0, 1, 0])),
    schedule: (memory) => {
      pending.push(memory);
    },
    async flush(store) {
      for (const memory of pending.splice(0)) {
        const text = [memory.title, memory.content].filter(Boolean).join("\n");
        const vector = await one(text);
        store.setEmbedding(memory.id, vector);
      }
    },
    modelHash: "mock#supersede-state-tracking",
    dimension: 3
  };
}

async function supersededFixture({ embedder = null } = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const vectorIndex = embedder ? createVectorIndex({ store }) : null;
  if (embedder) {
    service.setEmbedder(embedder);
    service.setVectorIndex(vectorIndex);
  }
  const legacy = service.saveWithDedupe({
    type: "project",
    title: OLD_TITLE,
    content: `缓存池上限 20 条；旧值令牌 ${OLD_MARK}`,
    importance: 4
  }).memory;
  const current = service.saveWithDedupe({
    type: "project",
    title: NEW_TITLE,
    content: `缓存池上限 200 条；现值令牌 ${NEW_MARK}`,
    importance: 5
  }).memory;

  // 建索引必须在 dream 之前：store.needsEmbedding（src/store.js:1545）只认
  // archived = 0 的行，归档之后再 rebuild 根本不会给 loser 补向量，那样「旧值
  // 不在向量结果里」就成了「上游压根没索引它」的平凡结论，压不到 archived 过滤。
  // 归档本身不清向量（只有 reclaim 会清，src/store.js:2107），所以 loser 带着
  // 向量活到 supersede 之后，两条路（SQL 过滤 / JS 兜底）才有得压。
  if (vectorIndex) await vectorIndex.rebuildIndex(embedder);

  const ctx = mockCtx({
    onConsolidation: () => JSON.stringify([
      { action: "supersede", winner: current.id, loser: legacy.id, reason: "版本演进" }
    ])
  });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "mock", dreamModel: "mock-model" });
  // 排空嵌入队列：supersede 的 service.update(loser, {content}) 会让 loser 的旧
  // 向量失效并重排一次嵌入，走的就是 embedder.schedule 这条真实异步路径。
  // 不排空的话 loser 归档后没有向量，向量支路的 archived 过滤根本没被压到。
  if (embedder && typeof embedder.flush === "function") await embedder.flush(store);

  // 夹具自检（不是被测性质）：确认真的走到了 supersede 终态，且旧行是被归档
  // 而不是被删。这两条不成立时后面的绿/红都没有意义。
  assert.equal(result.status, "ok", `dream 路径未走通：${result.error ?? JSON.stringify(result)}`);
  const archived = store.getById(legacy.id);
  assert.ok(archived, "被取代的行必须还在库里（归档非删除）");
  assert.equal(archived.archived, true, "真实路径必须把 loser 置为 archived");
  assert.ok(
    archived.content.includes(OLD_MARK),
    "归档行的正文（连同旧值）应原样保留，只是被隐藏"
  );
  assert.ok(
    archived.content.includes(NEW_TITLE),
    "取代注记应写在 loser 上并指向 winner（issue #126 口径）"
  );
  assert.equal(store.getById(current.id).content.includes(OLD_MARK), false, "winner 正文不得掺入旧值");
  if (vectorIndex) {
    // 夹具自检：loser 必须带着向量进入归档态。否则「旧值不在向量结果里」只是
    // 它没有向量，向量支路的 archived 过滤根本没被压到。
    assert.ok(
      store.getParsedEmbedding(legacy.id),
      "loser 归档后仍须带向量，语义支路用例才有意义"
    );
  }

  return { store, service, legacy, current, result, vectorIndex };
}

// (a) 检索链：service.searchMemories（memory_search 的同一实现）/ store.search
//     / memory_search 工具，都不得召回被取代的旧值。
test("supersede 后检索链不得返回被取代的旧值（keyword/auto/store/工具）", async () => {
  const { store, service, legacy, current } = await supersededFixture();

  const keyword = await service.searchMemories(QUERY, { mode: "keyword", useRerank: false, recordRecall: false });
  const auto = await service.searchMemories(QUERY, { mode: "auto", useRerank: false, recordRecall: false });
  const direct = service.search(QUERY);

  const registered = [];
  createTools({ tools: { register(def) { registered.push(def); return () => {}; } } }, service, Config({}), null);
  const searchTool = registered.find((t) => t.name === "memory_search");
  const viaTool = (await searchTool.execute({ query: QUERY, rerank: false })).items;

  const chains = [
    ["searchMemories(mode=keyword)", keyword],
    ["searchMemories(mode=auto)", auto],
    ["store.search", direct],
    ["memory_search 工具", viaTool]
  ];

  for (const [name, rows] of chains) {
    // 反向对照：新值必须能被查到。否则一条「什么都查不到」的实现也能让这条
    // 测试变绿——那是假绿，不是状态追踪正确。
    assert.ok(
      rows.some((r) => r.id === current.id),
      `${name}：新值必须可检索到（否则该支路是空结果，测试无意义）`
    );
    assert.equal(
      rows.some((r) => r.id === legacy.id),
      false,
      `${name}：不得返回被取代的行 ${legacy.id}`
    );
    assert.equal(
      rows.some((r) => String(r.content ?? "").includes(OLD_MARK)),
      false,
      `${name}：不得返回被取代的旧值正文 ${OLD_MARK}`
    );
  }

  // toApiList 之后（工具出口的 DTO）同样不得残留旧值。
  assert.equal(
    service.toApiList(direct).some((r) => String(r.content ?? "").includes(OLD_MARK)),
    false,
    "toApiList 出口不得残留旧值"
  );

  store.close();
});

// (b) 注入链：src/inject.js 的候选选择 + render 不得把旧值渲染进系统提示。
test("supersede 后注入候选不得包含被取代的旧值", async () => {
  const { store, service, legacy, current } = await supersededFixture();

  const contexts = [];
  const ctx = {
    systemPrompt: {
      context(def) {
        contexts.push(def);
        return () => {};
      }
    },
    // 带上一轮真实用户查询：注入走查询驱动的候选选择（而不是退化成纯重要性
    // 兜底），才真正压到 recall → injectCandidates 这条链上。
    agent: {
      session: {
        id: "supersede-state-tracking",
        snapshotEvents: () => [
          { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: QUERY }] } }
        ]
      }
    }
  };
  createInjector(ctx, service, createSettings(store.db), { maxInjectedItems: 5, importanceThreshold: 3 });

  const memorySection = contexts.find((c) => c.name === "memory");
  assert.ok(memorySection, "注入器必须注册 memory 段");
  const text = memorySection.text(ctx);

  assert.ok(text.includes(NEW_MARK), "新值应当被注入（否则注入是空的，断言不成立）");
  assert.equal(text.includes(OLD_MARK), false, "注入正文不得包含被取代的旧值");
  assert.equal(text.includes(OLD_TITLE), false, "注入正文不得包含被取代的旧标题");

  // 注入预览快照（面板数据底座）是同一帧的另一视角：id 集合也不得含 loser，
  // 否则「预览里看得见、正文里看不见」会掩盖同一处过滤缺失。
  const snap = getInjectionSnapshot();
  assert.ok(snap, "一次渲染后应留下注入快照");
  assert.ok(snap.entries.some((e) => e.id === current.id), "快照应含新值条目");
  assert.equal(snap.entries.some((e) => e.id === legacy.id), false, "快照不得含被取代的行");

  store.close();
});

// (c) 归档非删除：memory_get 仍能按 id 取回旧值全文。
test("supersede 后 memory_get 仍能取到被取代的旧值（归档非删除）", async () => {
  const { store, service, legacy, current } = await supersededFixture();

  const registered = [];
  createTools({ tools: { register(def) { registered.push(def); return () => {}; } } }, service, Config({}), null);
  const getTool = registered.find((t) => t.name === "memory_get");
  assert.ok(getTool, "memory_get 必须注册");

  const out = await getTool.execute({ id: legacy.id });
  assert.ok(out.memory.content.includes(OLD_MARK), "memory_get 必须能取回旧值正文");
  assert.equal(out.memory.id, legacy.id);
  // 取回的是归档行，且带着指向 winner 的取代注记——「可查阅」与「不可召回」
  // 在这里同时成立。
  assert.ok(out.memory.content.includes(NEW_TITLE), "取回的旧值应带取代注记");
  assert.ok(out.memory.id !== current.id, "取回的是被取代方，不是新值");

  // 取回归档行不得把它「复活」成可检索状态。
  assert.equal(
    (await service.searchMemories(QUERY, { mode: "keyword", useRerank: false, recordRecall: false }))
      .some((r) => r.id === legacy.id),
    false,
    "memory_get 之后旧值仍不得被检索到"
  );

  store.close();
});

// 故障注入型假索引：刻意「源侧失守」——无视 archived 直接吐回全量行（含被取代
// 的旧值）。它本身不是被测对象，做的是把 service 推到「上游不再滤归档」的
// 位置，去压 src/service.js:1583（向量命中池）与 :1594（语义缓存池）那两处
// JS 层 `!m.archived` 兜底——源侧正常时它们不承重，源侧失守时它们是最后一道墙。
function leakyVectorIndex(store) {
  return {
    search: (_vector, { limit = 20 } = {}) =>
      store
        .list({ limit, includeForgotten: false, includeArchived: true })
        .map((m) => ({ ...m, score: 1 }))
  };
}

// (d) 语义检索链：装上真向量索引后 mode=vector/hybrid/auto 都走
//     vectorIndex → store.searchVector。老/新两行被嵌成与查询同向的向量，旧值
//     必须缺席——而 src/service.js 的向量结果没有 JS 层 archived 复查，所以
//     唯一可能是 SQL 的 `archived = 0`（src/store.js:1598）生效。
test("supersede 后 vector/hybrid/auto 语义检索不得返回被取代的旧值", async () => {
  const { store, service, legacy, current } = await supersededFixture({ embedder: semanticEmbedder() });

  const chains = [
    ["searchMemories(mode=vector)", await service.searchMemories(PROBE, { mode: "vector", useRerank: false, recordRecall: false })],
    ["searchMemories(mode=hybrid)", await service.searchMemories(PROBE, { mode: "hybrid", useRerank: false, recordRecall: false })],
    ["searchMemories(mode=auto)", await service.searchMemories(PROBE, { mode: "auto", useRerank: false, recordRecall: false })]
  ];

  for (const [name, rows] of chains) {
    // 反向对照：新值必须经向量支路可检索到。否则「语义检索恒空」的实现也能让
    // 这条测试变绿——那是假绿，不是状态追踪正确。
    const hit = rows.find((r) => r.id === current.id);
    assert.ok(hit, `${name}：新值必须能被语义支路检索到（否则是空结果假绿）`);
    assert.equal(hit.source, "vector", `${name}：新值必须来自向量支路，而非词法兜底`);
    assert.equal(rows.some((r) => r.id === legacy.id), false, `${name}：不得返回被取代的行 ${legacy.id}`);
    assert.equal(
      rows.some((r) => String(r.content ?? "").includes(OLD_MARK)),
      false,
      `${name}：不得返回被取代的旧值正文 ${OLD_MARK}`
    );
  }

  // 词法支路对 PROBE 必然空手（PROBE 只在假 embedder 的映射规则里）：这保证
  // 上面的命中确实只能来自向量支路，而不是 keyword/BM25 顺手把新值捞了回来。
  const keyword = await service.searchMemories(PROBE, { mode: "keyword", useRerank: false, recordRecall: false });
  assert.equal(keyword.length, 0, "PROBE 不得命中词法支路（否则压到的不是向量支路）");

  store.close();
});

// (e) 语义候选池的 JS 层兜底：假索引源侧失守后，注入候选池必须在 :1583
//     （向量命中）与 :1594（lastSemanticRecall 语义缓存）两处各自把旧值挡下，
//     同时不得连新值一起挡掉。
test("supersede 后注入语义候选池（向量命中 / 语义缓存）不得浮出被取代的旧值", async () => {
  const { store, service, legacy, current } = await supersededFixture({ embedder: semanticEmbedder() });
  service.setVectorIndex(leakyVectorIndex(store));

  // 先填一次语义缓存：新查询的首帧 render 没有 queryVector（src/inject.js:327
  // 的预取是异步 .then），只能吃 lastSemanticRecall。真实检索不会吐归档行，
  // 是上面的假索引在源侧失守。填缓存的这一刻已经是 supersede 之后，所以缓存
  // 条目里 loser 的 archived 是 true。
  const cached = await service.searchMemories(QUERY, { mode: "vector", useRerank: false, recordRecall: false });
  const cachedOld = cached.find((r) => r.id === legacy.id);
  // 夹具自检：确认缓存里确实躺着带 archived 标记的旧值，否则 (e) 是空压。
  assert.ok(cachedOld, "假索引必须把归档旧值喂进语义缓存（夹具自检，否则压不到 :1594）");
  assert.equal(cachedOld.archived, true, "缓存条目里的 loser 必须已带 archived 标记");

  // 向量命中池（:1583）：带了 queryVector 就直接问索引。
  const viaVector = service.injectCandidates({
    query: QUERY,
    queryVector: [1, 0, 0],
    maxItems: 5,
    threshold: 3
  });
  assert.ok(viaVector.some((c) => c.id === current.id), "向量命中池：新值必须仍在候选里（反向对照）");
  assert.equal(viaVector.some((c) => c.id === legacy.id), false, "向量命中池：不得含被取代的行");
  assert.equal(
    viaVector.some((c) => String(c.content ?? "").includes(OLD_MARK)),
    false,
    "向量命中池：候选正文不得携带旧值"
  );

  // 语义缓存池（:1594）：交付端到端——渲染一次注入，首帧无 queryVector，走缓存。
  const contexts = [];
  const ctx = {
    systemPrompt: {
      context(def) {
        contexts.push(def);
        return () => {};
      }
    },
    agent: {
      session: {
        id: "supersede-state-tracking-semantic",
        snapshotEvents: () => [
          { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: QUERY }] } }
        ]
      }
    }
  };
  createInjector(ctx, service, createSettings(store.db), { maxInjectedItems: 5, importanceThreshold: 3 });

  const memorySection = contexts.find((c) => c.name === "memory");
  assert.ok(memorySection, "注入器必须注册 memory 段");
  const text = memorySection.text(ctx);

  assert.ok(text.includes(NEW_MARK), "语义缓存池：新值应当被注入（否则注入是空的，断言不成立）");
  assert.equal(text.includes(OLD_MARK), false, "语义缓存池：注入正文不得包含被取代的旧值");
  assert.equal(text.includes(OLD_TITLE), false, "语义缓存池：注入正文不得包含被取代的旧标题");

  store.close();
});
