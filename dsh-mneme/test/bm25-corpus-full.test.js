import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

// #616：BM25 语料曾被固定截断在 500 行（store.list({ limit: 500 }) 的默认
// importance 排序），排在 500 名之后的记忆永远进不了词法召回。这不是慢，是静默
// 的召回缺失——用户看不到「有这条记忆但没被搜到」这个事实。
//
// 为什么查询要写成「跨字段、不连续」：searchMemories 里还有一条 LIKE 子串扫描
// （store.search），它对全表生效、不经过语料索引。只写连续子串的话，旧实现在
// LIKE 路上照样能召回目标行，用例永远绿——那是假绿。所以查询词刻意分落在标题和
// 正文里，LIKE 匹配不到，只有 BM25 分词路命中得了：这把尺子才真的量到语料范围。

function setup(over = {}) {
  const store = createStore(":memory:");
  const config = { entitySearchEnabled: false, bm25SearchEnabled: true, ...over };
  const service = createService({ store, mirror: null, config, logger: null });
  return { store, service };
}

const recall = (service, q) =>
  service.searchMemories(q, { mode: "auto", topK: 20, useRerank: false, recordRecall: false });

test("#616: 语料超过 500 行时，窗口外的记忆仍能被词法召回", async () => {
  const { store, service } = setup();
  for (let i = 0; i < 620; i++) {
    store.save({ type: "project", title: `批量主题 ${i}`, content: `填充内容 ${i} 无关词`, importance: 5 });
  }
  // importance 1 让它排在旧实现的 500 行窗口之外；查询词分落标题与正文，
  // LIKE 拼不出这个连续串，只有 BM25 能命中。
  const target = store.save({ type: "project", title: "边缘记忆", content: "哨兵词 quokka-cipher", importance: 1 });

  const ids = (await recall(service, "边缘 quokka-cipher")).map((r) => r.id);
  assert.ok(ids.includes(target.id), "第 621 行的记忆必须能被词法召回（截断在 500 的实现会漏掉它）");
});

test("#616: 语料全量取，但同一轮里多查询只取一次", async () => {
  const { store, service } = setup();
  for (let i = 0; i < 520; i++) {
    store.save({ type: "project", title: `主题 ${i}`, content: `内容 ${i}`, importance: 5 });
  }
  let corpusLoads = 0;
  const orig = store.listBm25Corpus.bind(store);
  store.listBm25Corpus = () => { corpusLoads += 1; return orig(); };

  await recall(service, "主题 1");
  await recall(service, "主题 2");
  await recall(service, "主题 3");
  assert.equal(corpusLoads, 1, "语料没变，三轮查询只该取一次");
});

test("#616: 删除记忆后它退出词法召回", async () => {
  const { store, service } = setup();
  const doomed = store.save({ type: "project", title: "将被删除", content: "哨兵词 quokka-cipher", importance: 3 });
  assert.ok((await recall(service, "将被 quokka-cipher")).some((r) => r.id === doomed.id), "夹具前提：删除前能召回");

  store.remove(doomed.id);
  const ids = (await recall(service, "将被 quokka-cipher")).map((r) => r.id);
  assert.ok(!ids.includes(doomed.id), "删掉的行不得留在索引里（删除不会在行上留痕，只能靠 id 集合差集收掉）");
});

test("#616: 更新正文后按新内容召回、旧内容不再命中该行", async () => {
  const { store, service } = setup();
  const m = store.save({ type: "project", title: "旧标题", content: "旧哨兵词 oldmarker", importance: 3 });
  assert.ok((await recall(service, "旧标题 oldmarker")).some((r) => r.id === m.id), "夹具前提");

  store.update(m.id, { title: "新标题", content: "新哨兵词 newmarker" });
  const fresh = await recall(service, "新标题 newmarker");
  assert.ok(fresh.some((r) => r.id === m.id), "改完的正文要立刻能召回");

  // 旧词只查 oldmarker：不要把「标题」这类共用词带进查询，否则更新的行照样
  // 靠 bigram 命中，断言就测不到「旧 token 有没有被换掉」。
  const stale = (await recall(service, "oldmarker")).map((r) => r.id);
  assert.ok(!stale.includes(m.id), "旧词不该还挂在这行上");
});
