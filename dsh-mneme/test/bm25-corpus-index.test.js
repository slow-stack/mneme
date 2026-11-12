import test from "node:test";
import assert from "node:assert/strict";
import { createBM25Index, createCorpusIndex } from "../src/search/bm25.js";

// createCorpusIndex 是 service.js 词法召回用的增量索引。它必须与 createBM25Index
// 给出同一批命中、同一个分数——两条通路共用 tokenizer 与打分式，一旦漂移，同一条
// 记忆会因「走哪条索引」而得到不同名次，那是隐性不一致而不是性能问题。

const docs = [
  { id: "a", title: "异步并发模式", content: "async runtime 选用 tokio 与 work stealing" },
  { id: "b", title: "令牌桶限流", content: "ratelimit 令牌桶 漏桶 计数器" },
  { id: "c", title: "离线批处理", content: "夜间 ETL 脚本 离线 批处理" },
  { id: "d", title: "向量索引", content: "embedding 向量 索引 cosine 相似度" },
  { id: "e", title: "空行", content: "" },
];

const queries = ["异步", "tokio", "令牌桶", "离线 批处理", "embedding 向量 索引", "完全不相干的词", "ratelimit 令牌桶"];

test("createCorpusIndex: 与 createBM25Index 命中与分数逐条一致", () => {
  const incremental = createCorpusIndex();
  for (const d of docs) incremental.upsert(d);
  const batch = createBM25Index(docs);
  for (const q of queries) {
    const a = incremental.search(q, { limit: 10 });
    const b = batch.search(q, { limit: 10 });
    assert.deepEqual(a.map((h) => h.id), b.map((h) => h.id), `命中次序必须一致：${q}`);
    for (let i = 0; i < a.length; i++) {
      assert.equal(a[i].score, b[i].score, `分数必须一致：${q} #${i}`);
    }
  }
});

test("createCorpusIndex: 同 id 重复 upsert 不重复计入 df，分数与单次 upsert 相同", () => {
  const once = createCorpusIndex();
  for (const d of docs) once.upsert(d);
  const twice = createCorpusIndex();
  for (const d of docs) twice.upsert(d);
  twice.upsert(docs[0]);
  twice.upsert(docs[0]);

  assert.equal(twice.size(), docs.length, "重复 upsert 不该增加文档数");
  const a = once.search("异步 tokio", { limit: 10 });
  const b = twice.search("异步 tokio", { limit: 10 });
  assert.deepEqual(b, a, "重复 upsert 不能污染 df 或文档长度");
});

test("createCorpusIndex: remove 之后不再命中，且其它文档的分数回到「从没插过它」的状态", () => {
  const withIt = createCorpusIndex();
  for (const d of docs) withIt.upsert(d);
  assert.ok(withIt.has("b"));
  assert.equal(withIt.remove("b"), true);
  assert.equal(withIt.has("b"), false);
  assert.equal(withIt.size(), docs.length - 1);

  const withoutIt = createCorpusIndex();
  for (const d of docs) if (d.id !== "b") withoutIt.upsert(d);

  // df 回退错了会让 idf 偏高/偏低，表现为分数漂移；逐条比对才抓得住。
  for (const q of queries) {
    assert.deepEqual(withIt.search(q, { limit: 10 }), withoutIt.search(q, { limit: 10 }), `删掉 b 后应与从没插过它一致：${q}`);
  }
});

test("createCorpusIndex: 更新同一 id 的内容后按新内容命中、按旧内容不再命中", () => {
  const index = createCorpusIndex();
  for (const d of docs) index.upsert(d);
  index.upsert({ id: "c", title: "改写后的标题", content: "哨兵词 quokka-cipher" });

  assert.ok(index.search("quokka-cipher", { limit: 5 }).some((h) => h.id === "c"), "新内容要能被召回");
  assert.ok(!index.search("离线批处理", { limit: 5 }).some((h) => h.id === "c"), "旧词不该还挂在它身上");
  assert.equal(index.size(), docs.length, "替换不是新增");
});

test("createCorpusIndex: limit 生效，按分数降序返回 id 与归一化分数", () => {
  const index = createCorpusIndex();
  for (const d of docs) index.upsert(d);
  const hits = index.search("令牌桶 批处理 向量", { limit: 2 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].score, 1, "最高分归一化为 1");
  assert.ok(hits[0].score >= hits[1].score);
  for (const h of hits) {
    assert.equal(typeof h.id, "string");
    assert.ok(h.score > 0 && h.score <= 1);
  }
});

test("createCorpusIndex: 空索引与空查询都返回空数组，不抛错", () => {
  const index = createCorpusIndex();
  assert.deepEqual(index.search("任何东西", { limit: 5 }), []);
  index.upsert({ id: "x", title: "只有标题", content: "" });
  assert.deepEqual(index.search("   ", { limit: 5 }), []);
  assert.deepEqual(index.search("", { limit: 5 }), []);
});
