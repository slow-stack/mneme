import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

// ============================================================ distill-tx-embed-gap
// 回归锁：此前 scheduleEmbed 在 txDepth>0 时首行直接 return（注释写 deferred，
// 实际 transaction() 从不补跑）——与 #372 的实体抽取是同一个 bug 模板，只是受害者
// 换成了嵌入：自动蒸馏（summarize 全部走 service.transaction）写入的 session:* 行
// 100% 拿不到向量，语义检索对这批行永远失明。照 #372 的修复模板改为入队、提交后
// 补跑、回滚截断。五把锁与 test/entities.test.js 的 #372 锁一一对应，锁的是
// 「commit 才补跑、回滚绝不补跑」这个契约本身——任何一侧改回丢弃或回滚也补跑，
// 这里当场红。

function makeService(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service };
}

// 8 维定值向量；schedule 分支同步写回（语义同真实 embedder：调度即含写回），
// 让整条链路确定性、无异步漂移。embedSingle 仅供 ready-gate/embedSingle 分支
// 的调用方使用，本文件的锁都走 schedule 分支。
function makeEmbedder(store, embedded) {
  return {
    schedule(memory) {
      embedded.push(memory.id);
      store.setEmbedding(memory.id, new Array(8).fill(0.5), "fake-model-hash");
    },
    embedSingle: async () => new Array(8).fill(0.5),
  };
}

test("distill-tx: embedding queued inside transaction is written exactly once after commit", () => {
  const { store, service } = makeService();
  const embedded = [];
  service.setEmbedder(makeEmbedder(store, embedded));
  const r = service.transaction(() =>
    service.saveWithDedupe({ type: "preference", title: "事务内创建", content: "x" })
  );
  const id = r.memory.id;
  // 提交后补跑恰一次：向量非空、维度等于 embedder 输出（8 维）
  assert.deepEqual(embedded, [id], "drain fires exactly once, after commit");
  const row = store.db.prepare("SELECT embedding FROM memories WHERE id = ?").get(id);
  const vec = JSON.parse(row.embedding);
  assert.equal(vec.length, 8, "vector dimension equals embedder output");
  store.close();
});

test("distill-tx: nothing schedules while txDepth > 0 (queued, not dropped, not immediate)", () => {
  const { store, service } = makeService();
  const embedded = [];
  service.setEmbedder(makeEmbedder(store, embedded));
  service.transaction(() => {
    service.saveWithDedupe({ type: "preference", title: "事务内观察", content: "x" });
    // 事务内此刻不得触发（排进队列而不是丢弃，也不是立即跑）
    assert.equal(embedded.length, 0, "no embedding while txDepth > 0");
  });
  assert.equal(embedded.length, 1, "queued entry drains after commit");
  store.close();
});

test("distill-tx: rolled-back transaction never embeds rolled-back rows", () => {
  const { store, service } = makeService();
  const embedded = [];
  service.setEmbedder(makeEmbedder(store, embedded));
  assert.throws(() => {
    service.transaction(() => {
      service.saveWithDedupe({ type: "preference", title: "会被回滚", content: "x" });
      throw new Error("boom");
    });
  }, /boom/);
  assert.equal(embedded.length, 0, "no embedding against rolled-back rows");
  assert.equal(store.count(), 0, "row itself rolled back");
  store.close();
});

// 与 #372 复审补锁同构：内层回滚截断只丢内层条目，外层提交 drain 外层条目。
test("distill-tx: inner rollback drops only inner entries; outer commit drains the rest", () => {
  const { store, service } = makeService();
  const embedded = [];
  service.setEmbedder(makeEmbedder(store, embedded));
  const ids = [];
  service.transaction(() => {
    ids.push(service.saveWithDedupe({ type: "preference", title: "外层A", content: "x" }).memory.id);
    try {
      service.transaction(() => {
        service.saveWithDedupe({ type: "preference", title: "内层回滚", content: "x" });
        throw new Error("inner boom");
      });
    } catch { /* 内层回滚，外层继续 */ }
    ids.push(service.saveWithDedupe({ type: "preference", title: "外层B", content: "x" }).memory.id);
  });
  assert.deepEqual(embedded.sort(), ids.sort(), "inner rolled-back row never embedded; outer rows drain once");
  assert.equal(store.count(), 2);
  store.close();
});

test("distill-tx: no unbounded cap — large transaction drains every entry", () => {
  const { store, service } = makeService();
  const embedded = [];
  service.setEmbedder(makeEmbedder(store, embedded));
  service.transaction(() => {
    for (let i = 0; i < 150; i++) {
      service.saveWithDedupe({ type: "preference", title: `批量${i}`, content: "x" });
    }
  });
  assert.equal(embedded.length, 150, "no silent drop at any queue cap");
  store.close();
});
