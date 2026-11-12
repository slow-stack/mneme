import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

// #617 审计 O2 回归：BM25 语料索引按 mirror_state.generation 缓存。
//
// 断言观测点选语料取数（store.listBm25Corpus）的调用次数，不选耗时——耗时在 CI
// 上抖动大，而「这一轮到底有没有重新取语料并对齐索引」是确定性事实。
//
// 一正一反两把尺子：正向锁「缓存真的命中了」，反向（写入 / 归档 / 开关）锁
// 「该失效的时候真的失效了」——只有正向会让「永不失效」的实现也全绿。

function setup(over = {}) {
  const store = createStore(":memory:");
  const config = { entitySearchEnabled: false, bm25SearchEnabled: true, ...over };
  const service = createService({ store, mirror: null, config, logger: null });
  // 只数语料取数：searchMemories 里还有别的 list 调用，只挂钩语料那一个口。
  let corpusLoads = 0;
  const origCorpus = store.listBm25Corpus.bind(store);
  store.listBm25Corpus = () => {
    corpusLoads += 1;
    return origCorpus();
  };
  return { store, service, loads: () => corpusLoads };
}

// auto 且不装 embedder：向量路不启动，词法结果按 blend 的 auto 分支领位后由
// BM25 补位——这条路径下 BM25 命中真的会进返回值，断言才钉在用户可见的行为上，
// 而不是「索引建了但没人用」。
const recall = (service, q) => service.searchMemories(q, { mode: "auto", topK: 5, useRerank: false, recordRecall: false });

test("#617-O2: 同一水位下多条查询共用一份语料索引，不重复重建", async () => {
  const { store, service, loads } = setup();
  store.save({ type: "project", title: "异步并发模式", content: "async runtime 选用 tokio", importance: 3 });

  const first = await recall(service, "rust 异步");
  assert.equal(loads(), 1, "首查要建一次索引");
  assert.ok(first.length > 0, "夹具前提：这条查询本来就有命中");

  // 换一条查询：索引是按语料缓存的，不该因为 query 变了就重建。
  await recall(service, "tokio");
  await recall(service, "完全不相干的词");
  assert.equal(loads(), 1, "语料没变，三次查询只该取一次语料");
});

test("#617-O2: 写入新记忆后索引失效，新行立刻可召回", async () => {
  const { store, service, loads } = setup();
  store.save({ type: "project", title: "夜间 ETL 脚本", content: "离线批处理", importance: 3 });
  await recall(service, "离线批处理");
  assert.equal(loads(), 1);

  const fresh = store.save({ type: "project", title: "令牌桶限流", content: "ratelimit 令牌桶", importance: 3 });
  const ids = (await recall(service, "令牌桶")).map((r) => r.id);
  assert.equal(loads(), 2, "写了新行，语料变了，必须重建");
  assert.ok(ids.includes(fresh.id), "重建后新行必须能被词法召回（陈旧索引会漏掉它）");
});

test("#617-O2: 归档后索引失效，归档行退出词法召回", async () => {
  const { store, service, loads } = setup();
  const m = store.save({ type: "project", title: "令牌桶限流", content: "ratelimit 令牌桶", importance: 3 });
  assert.ok((await recall(service, "令牌桶")).some((r) => r.id === m.id), "夹具前提：归档前能召回");

  store.setArchived(m.id, true);
  const ids = (await recall(service, "令牌桶")).map((r) => r.id);
  assert.equal(loads(), 2, "可见性变了要重建");
  assert.ok(!ids.includes(m.id), "归档行不得留在索引里");
});

test("#617-O2: 触达与重嵌不改语料，不该让索引失效", async () => {
  const { store, service, loads } = setup();
  const m = store.save({ type: "project", title: "异步并发模式", content: "async runtime 选用 tokio", importance: 3 });
  await recall(service, "rust 异步");
  assert.equal(loads(), 1);

  // 这两类写入刻意不 bump generation（store.js：reads must not mark the mirror
  // dirty），也不改 title+content。缓存若跟着它们失效，就等于每轮注入都白重建
  // ——正是 O2 要消除的成本。
  store.touchLastAccess(m.id);
  store.setEmbedding(m.id, [0.1, 0.2, 0.3]);
  await recall(service, "rust 异步");
  assert.equal(loads(), 1, "触达 / 重嵌不构成语料变化");
});

test("#617-O2: bm25SearchEnabled=false 时根本不取语料", async () => {
  const { store, service, loads } = setup({ bm25SearchEnabled: false });
  store.save({ type: "project", title: "异步并发模式", content: "async runtime 选用 tokio", importance: 3 });
  const rows = await recall(service, "rust 异步");
  assert.equal(loads(), 0, "开关关着连语料都不该取");
  assert.ok(!rows.some((r) => r.source === "bm25"));
});

test("#617-O2: 空库不缓存空索引，后续写入仍可召回", async () => {
  const { store, service, loads } = setup();
  assert.deepEqual(await recall(service, "令牌桶"), [], "夹具前提：空库没有命中");

  const m = store.save({ type: "project", title: "令牌桶限流", content: "ratelimit 令牌桶", importance: 3 });
  const ids = (await recall(service, "令牌桶")).map((r) => r.id);
  assert.ok(ids.includes(m.id), "空库那一轮不得留下「空索引」这种缓存");
  assert.equal(loads(), 2);
});

test("#617-O2: 水位偶发读不到时，不拿旧索引冒充当前语料", async () => {
  const { store, service, loads } = setup();
  store.save({ type: "project", title: "夜间 ETL 脚本", content: "离线批处理", importance: 3 });
  await recall(service, "离线批处理");
  assert.equal(loads(), 1, "夹具前提：正常路径已经缓存了一份索引");

  // 模拟 mirror_state 读不出来（库锁 / 迁移窗口）。此时无法证明缓存新鲜，必须
  // 退回重建，而不是把 generation 当成 null 去和缓存里的旧值比对后命中。
  const realGet = store.getMirrorState.bind(store);
  store.getMirrorState = () => { throw new Error("mirror_state unavailable"); };
  const fresh = store.save({ type: "project", title: "令牌桶限流", content: "ratelimit 令牌桶", importance: 3 });
  const ids = (await recall(service, "令牌桶")).map((r) => r.id);
  assert.ok(ids.includes(fresh.id), "水位不可读时仍要看到新写入的行");
  assert.equal(loads(), 2);

  // 恢复可读：期间确实写过，水位已经变了，于是再重建一次拿到的才是与水位对齐
  // 的索引——宁可多建一次，也不能让缓存条目声称自己代表某个它没见过的版本。
  store.getMirrorState = realGet;
  await recall(service, "令牌桶");
  assert.equal(loads(), 3, "水位已前进，恢复后须重建一次把条目对齐到新水位");

  // 对齐之后再查就不该再重建了。
  await recall(service, "离线批处理");
  assert.equal(loads(), 3, "对齐后回到正常缓存路径");
});

test("#617-O2: 水位读不到但期间没有写入时，恢复后直接命中旧索引", async () => {
  const { store, service, loads } = setup();
  store.save({ type: "project", title: "夜间 ETL 脚本", content: "离线批处理", importance: 3 });
  await recall(service, "离线批处理");
  assert.equal(loads(), 1);

  // 读失败但语料没变：此时丢掉缓存纯属白干。保留上一份「已知有效 generation」
  // 的条目，恢复后水位一致就直接命中。
  const realGet = store.getMirrorState.bind(store);
  store.getMirrorState = () => { throw new Error("mirror_state unavailable"); };
  await recall(service, "离线批处理");
  assert.equal(loads(), 2, "读不到水位只能重建（无法证明缓存新鲜）");

  store.getMirrorState = realGet;
  await recall(service, "离线批处理");
  assert.equal(loads(), 2, "期间无写入，恢复后不该再白建一次");
});
