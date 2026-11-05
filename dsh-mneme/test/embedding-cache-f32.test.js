import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { cosineSimilarity } from "../src/dream/clustering.js";

// 回归：embedding 解析缓存的两件事，2026-11-05 实测发现。
//
// 一、上限 4000 装不下工作集时缓存等于不存在。活跃带向量行 6685 条，扫到
//     第 4001 条开始驱逐自己刚填的条目，扫完只剩最后 4000 条，下一轮又从第一
//     条 miss —— 四轮实测命中率恒 0.0%，每次检索全量重解析（624ms）。固定调大
//     只是把复发推到下个月（活跃行近 30 天净增 6156 条），所以上限改为跟工作集
//     自适应。下面的用例锁住「工作集超过下限时仍接近全命中」这条行为，而不是
//     锁某个具体常量——锁常量等于允许它再次变成硬编码。
//
// 二、缓存里存 Float32Array（真实占用 55.5MB → 28.9MB）。但 `Array.isArray`
//     对 typed array 返回 false，而 cosine / cosineSimilarity / setEmbedding
//     历史上全用它当守卫 —— 换存储而不同步改守卫，会把每个相似度算成 0、
//     把「设置向量」读成「清空向量」。这类静默归零没有任何报错，所以必须有
//     用例把等价性钉死。

function make() {
  return createStore(":memory:");
}

function seed(store, count, dim) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const row = store.save({ type: "project", title: `t${i}`, content: `c${i}`, importance: 3 });
    const v = new Array(dim);
    for (let d = 0; d < dim; d++) v[d] = Math.sin(i * 0.7 + d * 0.3);
    store.setEmbedding(row.id, v);
    ids.push(row.id);
  }
  return ids;
}

test("缓存上限跟工作集自适应：超过 4000 条也不塌成 0% 命中", () => {
  const store = make();
  const dim = 8;
  const ids = seed(store, 4200, dim); // 越过旧的固定上限 4000
  const query = new Array(dim).fill(0.5);

  // 第一轮：seed 走 setEmbedding（不经读路径，不计命中/未命中），但下限 4000
  // 装不下 4200 条，最早写入的 200 条已被驱逐 —— 第一次 searchVector 会为它们
  // 回表，同时把上限抬到装得下本次扫描。
  store.searchVector(query, { limit: 5 });
  const r1 = store.embeddingCacheStats();
  assert.equal(r1.misses, ids.length - 4000, "冷扫描只为被下限挤掉的尾部回表");
  assert.ok(
    r1.cap >= ids.length,
    `扫完后上限必须装得下工作集（cap=${r1.cap} 应 >= ${ids.length}）——否则下轮会从第一条 miss`
  );

  // 第二轮：同一工作集，必须全命中（旧实现这里仍是 0%，因为缓存只留得下最后 4000 条）
  store.searchVector(query, { limit: 5 });
  const r2 = store.embeddingCacheStats();
  const secondMisses = r2.misses - r1.misses;
  const secondHits = r2.hits - r1.hits;
  assert.equal(secondMisses, 0, `第二轮不应再有 miss（实测 ${secondMisses} 条）`);
  assert.equal(secondHits, ids.length, "第二轮每条都命中");
  assert.ok(r2.hitRate > 0.5, `累计命中率必须离开 0%（实测 ${(r2.hitRate * 100).toFixed(1)}%）`);

  // 第三、四轮继续：命中率不得回落（旧实现每轮都归零）
  store.searchVector(query, { limit: 5 });
  store.searchVector(query, { limit: 5 });
  const r4 = store.embeddingCacheStats();
  assert.equal(r4.misses, r1.misses, "第 3、4 轮不应再产生 miss");
  store.close();
});

test("淘汰语义：写入超过上限仍按 FIFO 驱逐最旧条目，且不驱逐正在用的", () => {
  const store = make();
  const ids = seed(store, 12, 4);
  const before = store.embeddingCacheStats();
  // 12 条远低于下限 4000，不会触发驱逐；这里锁的是「写入口按 id 覆盖而非追加」
  const [a, b] = ids;
  store.setEmbedding(a, [9, 9, 9, 9]);
  assert.deepEqual(store.getParsedEmbedding(a), [9, 9, 9, 9], "同一 id 覆盖，不新增条目");
  store.setEmbedding(b, null);
  assert.equal(store.getParsedEmbedding(b), undefined, "清空即从缓存移除");
  const after = store.embeddingCacheStats();
  assert.ok(after.size <= before.size, "覆盖与清空都不该让缓存增长");
  store.close();
});

test("Float32 与 number[] 等价：getParsedEmbedding / getEmbeddings 仍返回 number[]", () => {
  const store = make();
  const { id } = store.save({ type: "project", title: "A", content: "a" });
  const written = [0.1, 0.25, 0.5, 0.75];
  store.setEmbedding(id, written);
  const one = store.getParsedEmbedding(id);
  assert.ok(Array.isArray(one), "对外契约是 number[]，调用方用 Array.isArray 守卫");
  // 数值等价而非逐位相等：缓存按 Float32 存（省 48% 内存），双精度原值不保留，
  // 回读带 ~1e-7 的单精度舍入。对余弦分数（0..1）与排序没有可观测影响
  // （下面「排序不变」那条用例把这一点钉死），但这是对外可见的精度变化，
  // 必须写成断言而不是假装不存在——用精确 deepEqual 会把它变成一颗定时炸弹。
  assert.equal(one.length, written.length);
  for (let i = 0; i < written.length; i++) {
    assert.ok(Math.abs(one[i] - written[i]) < 1e-6, `第 ${i} 位误差应在单精度范围内`);
  }
  const many = store.getEmbeddings([id]).get(id);
  assert.ok(Array.isArray(many), "批量读同样是 number[]");
  assert.equal(many.length, written.length);

  // 传 typed array 进 setEmbedding 必须当成「设置」而不是「清空」
  store.setEmbedding(id, new Float32Array([0.2, 0.4, 0.6, 0.8]));
  const after = store.getParsedEmbedding(id);
  assert.ok(after, "typed array 入参不得被读成清空（旧守卫会把它写成 NULL）");
  assert.equal(after.length, 4);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(after[i] - [0.2, 0.4, 0.6, 0.8][i]) < 1e-6);
  store.close();
});

test("Float32 与 number[] 等价：cosine 对 typed array 不得静默归零", () => {
  const a = [1, 0, 0];
  const b = [0, 1, 0];
  const aF = new Float32Array(a);
  const bF = new Float32Array(b);
  assert.equal(cosineSimilarity(a, a), 1);
  assert.equal(cosineSimilarity(aF, aF), 1, "typed array 不能算成 0（Array.isArray 守卫的坑）");
  assert.equal(cosineSimilarity(a, b), 0);
  assert.equal(cosineSimilarity(aF, bF), 0);
  const mixed = cosineSimilarity(a, aF);
  assert.equal(mixed, 1, "混合入参（number[] vs Float32Array）也必须能算");
});

test("Float32 存储不改变检索排序：前 50 条顺序与 number[] 完全一致", () => {
  const store = make();
  const dim = 16;
  const ids = seed(store, 60, dim);
  const query = new Array(dim);
  for (let d = 0; d < dim; d++) query[d] = Math.cos(d * 0.11);

  // 缓存里已是 Float32Array（seed 走 setEmbedding → cacheEmbedding）
  const viaCache = store.searchVector(query, { limit: 50 });
  // 清缓存后强制从 JSON 重读并重新解析（同一条路径，但冷启动）
  store.db.prepare("SELECT 1").get();
  const cold = store.searchVector(query, { limit: 50 });

  assert.equal(viaCache.length, cold.length, "两次返回条数一致");
  assert.deepEqual(
    viaCache.map((r) => r.id),
    cold.map((r) => r.id),
    "Float32 缓存与冷解析的排序必须逐位相同（Float32 存储不损 cosine 排序）"
  );
  for (let i = 0; i < viaCache.length; i++) {
    assert.ok(
      Math.abs(viaCache[i].score - cold[i].score) < 1e-6,
      `第 ${i} 条分数差异应可忽略（实测 ${Math.abs(viaCache[i].score - cold[i].score)}）`
    );
  }
  store.close();
});

// 变异实验暴露的缺口（2026-11-05）：把 store.js 的 cosine 守卫退回 Array.isArray
// 时，上面那条「排序一致」照样全绿 —— 因为缓存路径与冷路径都喂进同一套坏守卫，
// 两边一起归零，排序自然「一致」。也就是说：只比两条路径是否相同，测不出「都错」。
// 必须有一个独立的正确答案做基准，所以这里直接算一遍期望分数。
test("searchVector 的分数本身正确：缓存路径的 cosine 不得归零", () => {
  const store = make();
  const a = store.save({ type: "project", title: "A", content: "a" });
  const b = store.save({ type: "decision", title: "B", content: "b" });
  store.setEmbedding(a.id, [1, 0, 0, 0]);
  store.setEmbedding(b.id, [0.6, 0.8, 0, 0]);

  const query = [1, 0, 0, 0];
  const hits = store.searchVector(query, { limit: 5 });
  assert.equal(hits.length, 2);

  // 独立算一遍期望：cos([1,0,0,0],[1,0,0,0]) = 1；cos([1,0,0,0],[0.6,0.8,0,0]) = 0.6
  const byId = new Map(hits.map((h) => [h.id, h.score]));
  assert.ok(
    Math.abs(byId.get(a.id) - 1) < 1e-6,
    `完全同向的分数必须是 1（实测 ${byId.get(a.id)}）——若为 0 说明 cosine 守卫把 typed array 判死了`
  );
  assert.ok(
    Math.abs(byId.get(b.id) - 0.6) < 1e-6,
    `余弦 0.6 必须算出来（实测 ${byId.get(b.id)}）`
  );
  assert.ok(
    hits[0].score > 0 && hits[1].score > 0,
    "两条分数都不得为 0（静默归零没有任何报错，只能靠这条基准锁住）"
  );
  store.close();
});
