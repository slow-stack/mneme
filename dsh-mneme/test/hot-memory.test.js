import test from "node:test";
import assert from "node:assert/strict";
import { createHotMemory, estimateTokens, roundsFromEvents } from "../src/hot-memory.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";

// --- hot memory buffer ---

test("hot memory keeps the latest rounds within maxRounds", () => {
  const hot = createHotMemory({ maxRounds: 2, maxTokens: 10000 });
  hot.add({ query: "第一轮", response: "答一" });
  hot.add({ query: "第二轮", response: "答二" });
  hot.add({ query: "第三轮", response: "答三" });
  assert.equal(hot.rounds().length, 2);
  assert.ok(hot.getContext().includes("第三轮"));
  assert.ok(!hot.getContext().includes("第一轮"));
});

test("hot memory enforces the token budget", () => {
  const hot = createHotMemory({ maxRounds: 10, maxTokens: 30 });
  hot.add({ query: "很长的第一轮问题".repeat(10), response: "很长的回答".repeat(10) });
  hot.add({ query: "第二轮", response: "答二" });
  // The first round alone blows the budget; the newest round survives and
  // the buffer never empties completely.
  const rounds = hot.rounds();
  assert.ok(rounds.length >= 1);
  assert.equal(rounds[rounds.length - 1].query, "第二轮");
});

test("hot memory getContext uses the Q/A round format", () => {
  const hot = createHotMemory({ maxRounds: 5, maxTokens: 10000 });
  hot.add({ query: "Q1", response: "A1" });
  hot.add({ query: "Q2", response: "A2" });
  assert.equal(hot.getContext(), "Q: Q1\nA: A1\n\nQ: Q2\nA: A2");
});

test("hot memory ignores empty rounds and clears", () => {
  const hot = createHotMemory({ maxRounds: 5, maxTokens: 10000 });
  hot.add({ query: "", response: "x" });
  hot.add(null);
  assert.equal(hot.rounds().length, 0);
  hot.add({ query: "q" });
  hot.clear();
  assert.equal(hot.getContext(), "");
});

test("estimateTokens counts CJK heavier than ASCII", () => {
  assert.ok(estimateTokens("中文内容") > estimateTokens("abcd"));
});

// --- service-level: BM25 fusion + semantic dedup + selective injection ---

function toyVec(text) {
  const v = new Array(64).fill(0);
  for (const t of String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    let h = 0;
    for (const ch of t) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    v[h % 64] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function setup(overrides = {}) {
  const store = createStore(":memory:");
  const config = {
    entitySearchEnabled: false,
    bm25SearchEnabled: true,
    adaptiveThresholdEnabled: false,
    searchSemanticDedup: true,
    selectiveInjectEnabled: true,
    ...overrides
  };
  const service = createService({ store, mirror: null, config, logger: null });
  service.setVectorIndex(createVectorIndex({ store, logger: null }));
  service.setEmbedder({ embedSingle: async (t) => toyVec(t) });
  return { store, service };
}

test("searchMemories fuses BM25: scattered-term queries recall both rows", async () => {
  const { store, service } = setup();
  const a = store.save({ type: "project", title: "异步并发模式", content: "async runtime 选用 tokio", importance: 3 });
  const b = store.save({ type: "decision", title: "语言迁移", content: "编译模块迁移到 Rust", importance: 3 });
  store.save({ type: "project", title: "无关", content: "夜间 ETL 脚本", importance: 3 });

  // "rust 异步" is not a substring of either row — LIKE misses both; BM25
  // must surface both rows in the merged result.
  const results = await service.searchMemories("rust 异步", { mode: "auto", topK: 5 });
  const ids = results.map((r) => r.id);
  assert.ok(ids.includes(a.id), "async row must be recalled via BM25");
  assert.ok(ids.includes(b.id), "rust row must be recalled via BM25");
  assert.equal(results.find((r) => r.id === a.id)?.source, "bm25");
});

test("bm25SearchEnabled=false restores the two-path behavior", async () => {
  const { store, service } = setup({ bm25SearchEnabled: false });
  const a = store.save({ type: "project", title: "异步并发模式", content: "async runtime 选用 tokio", importance: 3 });
  const results = await service.searchMemories("rust 异步", { mode: "auto", topK: 5 });
  assert.ok(!results.some((r) => r.id === a.id), "no BM25 → scattered-term miss is back");
});

test("search-time semantic dedup drops near-identical embeddings", async () => {
  const { store, service } = setup();
  const a = store.save({ type: "project", title: "偏好 A", content: "用户喜欢深色主题编辑器", importance: 3 });
  const b = store.save({ type: "project", title: "偏好 A 备份", content: "用户喜欢深色主题编辑器（备份）", importance: 3 });
  store.setEmbedding(a.id, toyVec("用户喜欢深色主题编辑器"));
  store.setEmbedding(b.id, toyVec("用户喜欢深色主题编辑器"));

  // auto (not keyword): keyword mode is the documented text-only path and is
  // exempt from dedup by design; auto exercises the dedup the way production
  // searches run.
  const results = await service.searchMemories("深色主题", { mode: "auto", topK: 5 });
  const ids = results.map((r) => r.id);
  assert.ok(ids.includes(a.id) !== ids.includes(b.id), "one of the near-duplicate pair is dropped");
});

test("searchSemanticDedup=false keeps duplicate embeddings", async () => {
  const { store, service } = setup({ searchSemanticDedup: false });
  const a = store.save({ type: "project", title: "偏好 A", content: "用户喜欢深色主题编辑器", importance: 3 });
  const b = store.save({ type: "project", title: "偏好 A 备份", content: "用户喜欢深色主题编辑器（备份）", importance: 3 });
  store.setEmbedding(a.id, toyVec("用户喜欢深色主题编辑器"));
  store.setEmbedding(b.id, toyVec("用户喜欢深色主题编辑器"));
  const results = await service.searchMemories("深色主题", { mode: "keyword", topK: 5 });
  assert.equal(results.length, 2);
});

test("selective injection re-orders candidates by query similarity", () => {
  const { store, service } = setup();
  const thesis = store.save({ type: "project", title: "湿地论文", content: "毕业论文研究城市湿地公园", importance: 5 });
  const plugin = store.save({ type: "project", title: "插件项目", content: "dsh-mneme 记忆插件开发", importance: 5 });
  store.setEmbedding(thesis.id, toyVec("毕业论文研究城市湿地公园"));
  store.setEmbedding(plugin.id, toyVec("dsh-mneme 记忆插件开发"));

  // Rule-based order would put both at equal importance; the query vector is
  // about the thesis, so topic ranking must put the thesis memory first.
  const picked = service.injectCandidates({
    query: "论文写作",
    queryVector: toyVec("毕业论文研究城市湿地公园"),
    maxItems: 2,
    threshold: 3
  });
  assert.equal(picked[0].id, thesis.id);
  assert.ok(picked.some((m) => m.id === plugin.id));
});

// --- roundsFromEvents：surface 投影（rewind 撤回内容不得回流热记忆） ---

function userEvent(seq, text, kind) {
  return { seq, type: "user/message", data: { source: kind ? { kind } : undefined, content: [text] } };
}
function assistantEvent(seq, text) {
  return { seq, type: "assistant/message", data: { message: { content: [{ type: "text", text }] } } };
}

test("roundsFromEvents pairs user/assistant rounds and keeps the trailing pending query", () => {
  const events = [
    userEvent(1, "第一问"),
    assistantEvent(2, "第一答"),
    userEvent(3, "第二问")
  ];
  const rounds = roundsFromEvents(events, 5);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].query, "第一问");
  assert.equal(rounds[0].response, "第一答");
  assert.equal(rounds[1].query, "第二问");
  assert.equal(rounds[1].response, "");
});

test("roundsFromEvents excludes events shadowed off the surface (rewind/compact)", () => {
  // append-only 日志里被撤回的轮次仍在，但 surface 只剩可见 seq——
  // 热记忆必须与模型同源，被遮蔽的轮次不得回流。
  const events = [
    userEvent(1, "已被撤回的问题"),
    assistantEvent(2, "已被撤回的回答"),
    { seq: 3, type: "user/message", data: { source: { kind: "dsh-rewind" }, content: [""] } },
    userEvent(4, "撤回后的新问题"),
    assistantEvent(5, "撤回后的新回答")
  ];
  const visible = new Set([3, 4, 5]);
  const rounds = roundsFromEvents(events, 5, visible);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].query, "撤回后的新问题");
  assert.equal(rounds[0].response, "撤回后的新回答");
  assert.ok(!JSON.stringify(rounds).includes("已被撤回"));
});

test("roundsFromEvents with no surface info keeps the legacy full-log behavior", () => {
  const events = [userEvent(1, "旧宿主问题"), assistantEvent(2, "旧宿主回答")];
  const rounds = roundsFromEvents(events, 5, null);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].query, "旧宿主问题");
  assert.equal(rounds[0].response, "旧宿主回答");
});

test("roundsFromEvents skips rewind markers as queries even when on the surface", () => {
  const events = [
    { seq: 1, type: "user/message", data: { source: { kind: "dsh-rewind" }, content: [""] } },
    userEvent(2, "标记后的第一问"),
    assistantEvent(3, "标记后的第一答")
  ];
  const visible = new Set([1, 2, 3]);
  const rounds = roundsFromEvents(events, 5, visible);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].query, "标记后的第一问");
});

test("roundsFromEvents with an empty surface yields no rounds (model sees nothing)", () => {
  const events = [userEvent(1, "问题"), assistantEvent(2, "回答")];
  assert.equal(roundsFromEvents(events, 5, new Set()).length, 0);
});

// --- Issue #637：omitPendingRound —— 注入侧不回放「正在组装的这一轮」 ---

test("omitPendingRound drops the trailing in-flight round (the #637 empty-A churn source)", () => {
  // 本轮刚开了头（提问已落日志、回答还没来）：默认行为渲染空 A: 行——
  // 宿主「文本变了就追加快照」的契机会让回答落地后这一行抖成正文、再多追一份。
  const events = [userEvent(1, "第一问"), assistantEvent(2, "第一答"), userEvent(3, "第二问")];
  const rounds = roundsFromEvents(events, 5, null, { omitPendingRound: true });
  assert.equal(rounds.length, 1, "the in-flight round is not replayed");
  assert.equal(rounds[0].query, "第一问");
  assert.ok(!JSON.stringify(rounds).includes("第二问"), "the current turn's query never reaches hot memory");
});

test("omitPendingRound keeps a closed round — the block changes exactly once per turn", () => {
  // 回答落地（轮闭合）是热块在一轮内唯一该变化的时刻：此前所有组装看到同一份
  // 文本，此刻变成「历史轮 + 刚闭合的轮」→ 宿主恰好追一份快照。
  const open = [userEvent(1, "第一问"), assistantEvent(2, "第一答"), userEvent(3, "第二问")];
  const closed = [userEvent(1, "第一问"), assistantEvent(2, "第一答"), userEvent(3, "第二问"), assistantEvent(4, "第二答")];
  const before = roundsFromEvents(open, 5, null, { omitPendingRound: true });
  const after = roundsFromEvents(closed, 5, null, { omitPendingRound: true });
  assert.equal(before.length, 1);
  assert.equal(after.length, 2);
  assert.deepEqual(after[1], { query: "第二问", response: "第二答" });
  // 轮与轮之间（下一轮开头的组装）块不再变：第三轮的提问此刻是 pending，被省略。
  const nextTurn = roundsFromEvents([...closed, userEvent(5, "第三问")], 5, null, { omitPendingRound: true });
  assert.deepEqual(nextTurn, after, "the block is stable across the turn boundary — no extra snapshot");
});

test("omitPendingRound only touches the tail — mid-log abandoned rounds still render empty A", () => {
  // 双发消息（第二问把第一问顶掉）：第一问是已被放弃的历史提问，渲染成空 A:
  // 是既有语义，不属于「正在组装的这一轮」。
  const events = [userEvent(1, "被顶掉的问题"), userEvent(2, "第二轮的问题"), assistantEvent(3, "第二轮的回答"), userEvent(4, "第三问")];
  const rounds = roundsFromEvents(events, 5, null, { omitPendingRound: true });
  assert.deepEqual(rounds, [
    { query: "被顶掉的问题", response: "" },
    { query: "第二轮的问题", response: "第二轮的回答" }
  ]);
});

test("omitPendingRound works with the surface projection (rewind-shadowed tail not special)", () => {
  // 撤回遮蔽过的事件不参与配对，也不影响「尾部 pending」的判定：可见面上最后
  // 一条 user/message 是第二问，它才是本轮。
  const events = [userEvent(1, "已被撤回的问题"), assistantEvent(2, "已被撤回的回答"), userEvent(3, "第一问"), assistantEvent(4, "第一答"), userEvent(5, "第二问")];
  const visible = new Set([3, 4, 5]);
  const rounds = roundsFromEvents(events, 5, visible, { omitPendingRound: true });
  assert.deepEqual(rounds, [{ query: "第一问", response: "第一答" }]);
});

