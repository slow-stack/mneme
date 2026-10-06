import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createInjector, getInjectionSnapshot } from "../src/inject.js";
import { createSettings } from "../src/settings.js";
import { createTools } from "../src/tools.js";
import { createDreamScheduler } from "../src/dream.js";
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

async function supersededFixture() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
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

  const ctx = mockCtx({
    onConsolidation: () => JSON.stringify([
      { action: "supersede", winner: current.id, loser: legacy.id, reason: "版本演进" }
    ])
  });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "mock", dreamModel: "mock-model" });

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

  return { store, service, legacy, current, result };
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
