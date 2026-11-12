// #532 × #650 取代链的接缝：继任者被**遗忘**时，被取代的旧行不许回潮。
//
// #650 给 supersededIds 加过一个守卫：继任者归档/遗忘/删除时自动恢复旧行可见
// 性，理由是「数据在库里却永远不再出现是一种沉默的不可逆失效」。那条理由对
// **归档**成立（整理面退场、可恢复、常是合并落点），对**遗忘**不成立——
// memory_forget 的语义是「我不要再记得这个内容」，继任者退场的理由是用户主动
// 要求，把被取代的旧值摆回注入面等于让用户明确抛弃的答案趁虚回潮，正是 #532
// 报的现象（更正行被忘掉，新对话答回更正前的旧值）。
//
// 本文件锁四件事：
//   ① 遗忘继任者后，被取代的旧行仍在 supersededIds 里 → 注入面继续排除它；
//   ② 旧行没有消失：显式搜索仍能读到（降权 0.5 而非摘除）——不是沉默失效；
//   ③ 归档继任者仍按 #650 恢复旧行可见性（不许顺手改掉那条语义）；
//   ④ memory_forget 回执报连带面（predecessors），且恢复时不报。
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";

function chainFixture() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  // 旧值行（两行都被新行取代，用来验回执的计数与「都保持隐藏」）
  const oldColor = service.saveWithDedupe({
    type: "preference", title: "纸模工具的收纳",
    content: "纸模工具放在雾蓝色收纳盒里", importance: 3
  }).memory;
  const oldTime = service.saveWithDedupe({
    type: "preference", title: "纸模工具的整理时间",
    content: "纸模工具每周三晚上八点整理一次", importance: 3
  }).memory;
  // 更正后的新值行（#532 的对话 B 产物：颜色与时间合流一行）
  const fresh = service.saveWithDedupe({
    type: "preference", title: "收纳盒颜色与整理时间的更正",
    content: "收纳盒换成浅橙色，整理时间改为每周六上午九点", importance: 3
  }).memory;
  // #641 enforce 档在真实库上落的就是这两条链（supersedeChain 是唯一写入口）
  assert.equal(store.supersedeChain(oldColor.id, fresh.id), true);
  assert.equal(store.supersedeChain(oldTime.id, fresh.id), true);
  return { store, service, oldColor, oldTime, fresh };
}

test("遗忘继任者：被取代的旧行保持抑制（#532 的旧值回潮不许复活）", async () => {
  const { store, service, oldColor, oldTime, fresh } = chainFixture();
  try {
    // 前提：链生效时两行都在 superseded 集合里
    assert.deepEqual(store.supersededIds().sort(), [oldColor.id, oldTime.id].sort());

    service.setForget(fresh.id, true);

    // ① 关键断言：继任者被遗忘 ≠ 继任者失效。旧值仍是过时值，不许重回注入面。
    assert.deepEqual(store.supersededIds().sort(), [oldColor.id, oldTime.id].sort(),
      "forgotten 的继任者仍算有效的取代者（#532 修正，覆盖 #650 的 forgotten=0 条件）");
    const injected = service.injectCandidates({ query: "", maxItems: 20 });
    assert.ok(!injected.some((m) => m.id === oldColor.id || m.id === oldTime.id),
      "旧的雾蓝色 / 周三 20:00 不许进注入面——否则就是 #532 报的那句话");

    // ② 不是沉默失效：显式搜索仍读得到（降权不摘除，#650 的契约）
    const found = await service.searchMemories("纸模工具", { mode: "auto", topK: 10, useRerank: false, recordRecall: false });
    assert.ok(found.some((r) => r.id === oldColor.id || r.id === oldTime.id),
      "被取代的旧行必须仍可被显式搜索读到（可核查、可恢复）");

    // ③ 继任者仍活着（只是被抑制）时，把遗忘撤掉，旧行照旧隐藏
    service.setForget(fresh.id, false);
    assert.deepEqual(store.supersededIds().sort(), [oldColor.id, oldTime.id].sort());
  } finally {
    store.close();
  }
});

test("归档继任者仍恢复旧行可见性（#650 的语义不许被这条修正顺手改掉）", () => {
  const { store, service, oldColor, oldTime, fresh } = chainFixture();
  try {
    service.setArchived(fresh.id, true);
    assert.deepEqual(store.supersededIds(), [],
      "归档 = 整理面退场（可恢复、常是合并落点）→ 旧行恢复可见，与遗忘分流");
    const injected = service.injectCandidates({ query: "", maxItems: 20 });
    assert.ok(injected.some((m) => m.id === oldColor.id || m.id === oldTime.id),
      "归档继任者后旧行回到注入面（#650 原有行为）");
  } finally {
    store.close();
  }
});

test("memory_forget 回执报取代链连带面：抑制时说明有几条旧行保持隐藏", async () => {
  const { store, service, oldColor, oldTime, fresh } = chainFixture();
  try {
    const registered = [];
    const ctx = { tools: { register(def) { registered.push(def); return () => {}; } } };
    createTools(ctx, service, {}, undefined);
    const forget = registered.find((d) => d.name === "memory_forget");
    assert.ok(forget, "memory_forget 必须注册");

    const out = await forget.execute({ id: fresh.id, forgotten: true });
    assert.equal(out.chain.predecessors, 2, "两行更早的记忆被这行取代");
    assert.equal(out.chain.supersededBy, undefined, "这行不是别人的继任者，不编造指向");
    const text = forget.output.render({ id: fresh.id }, out);
    const rendered = typeof text === "string" ? text : JSON.stringify(text);
    assert.match(rendered, /supersedes 2 older entries/,
      "回执必须说清连带面，否则模型会以为旧值会回来或把它当成当前答案");
    assert.match(rendered, /must not be treated as the current value/);

    // 恢复时不报连带面：那句话只在「抑制」语义下成立
    const restored = await forget.execute({ id: fresh.id, forgotten: false });
    const restoredText = forget.output.render({ id: fresh.id }, restored);
    assert.doesNotMatch(typeof restoredText === "string" ? restoredText : JSON.stringify(restoredText), /supersedes/);
    assert.equal(restored.chain.predecessors, 2, "恢复回执仍带链读数（事实不变，只是不渲染那句话）");

    // 无链的普通行：没有 chain 键，渲染退化为原句
    const plain = service.saveWithDedupe({ type: "project", title: "无关条目", content: "与链无关" }).memory;
    const plainOut = await forget.execute({ id: plain.id, forgotten: true });
    assert.equal(plainOut.chain.predecessors, 0);
    const plainText = forget.output.render({ id: plain.id }, plainOut);
    assert.doesNotMatch(typeof plainText === "string" ? plainText : JSON.stringify(plainText), /supersedes/);
  } finally {
    store.close();
  }
});

test("supersedeContext：不存在的行返回 null，计数只认指向本行的行", () => {
  const { store, oldColor, fresh } = chainFixture();
  try {
    assert.equal(store.supersedeContext("no-such-id"), null);
    assert.deepEqual(store.supersedeContext(fresh.id), { supersededBy: null, predecessors: 2 });
    assert.deepEqual(store.supersedeContext(oldColor.id), { supersededBy: fresh.id, predecessors: 0 });
  } finally {
    store.close();
  }
});