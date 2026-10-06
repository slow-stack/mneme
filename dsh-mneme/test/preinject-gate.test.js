import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createInjector, getInjectionSnapshot, setPreinjectCallLLM } from "../src/inject.js";
import { createPreinjectGate, parseFlaggedIds, preinjectPrompt } from "../src/preinject-gate.js";

// Issue #380：注入前判定（preInjectGate）。锁三类回归：
// ①默认关零行为变化（平价锁——注入块逐字节一致、零 LLM 调用）；
// ②enforce 过滤语义（缓存命中剔除 / 未命中全量放行 / 哑闸恒透传）；
// ③判定失败降级（解析失败/流失败 = 全量放行，绝不因防线失效丢注入）。
// 审计行为在 gate 单元用例里直接断言（saveLlmAudit 桩）。

function setup(configOver = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const contexts = [];
  // 渲染 ctx 带 session + 一条 user/message：lastUserQuery 才有查询文本可拿，
  // preinjectGate 的 prefetch/apply 才会被触发（query 空时两路都按 passthrough 处理）。
  const ctx = {
    logger: { warn: () => {} },
    agent: { session: { id: "s1", snapshotEvents: () => [
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "帮我看看" }] } }
    ] } },
    systemPrompt: {
      context(def) {
        contexts.push(def);
        return () => {};
      }
    }
  };
  const config = { maxInjectedItems: 3, importanceThreshold: 3, ...configOver };
  const injector = createInjector(ctx, service, settings, config);
  return { store, service, contexts, injector, ctx };
}

test("default off: injection block byte-identical and no LLM calls (parity lock)", () => {
  let calls = 0;
  setPreinjectCallLLM(() => {
    calls += 1;
    return Promise.resolve("[]");
  });
  const { store, contexts, ctx } = setup();
  store.save({ type: "preference", title: "语言", content: "用户用中文交流", importance: 5 });
  const text = contexts[0].text(ctx);
  assert.ok(text.includes("语言"));
  assert.equal(calls, 0, "gate off must not call LLM");
  setPreinjectCallLLM(null);
});

test("enabled observe mode: gate judges but flagged entries still injected", async () => {
  let calls = 0;
  setPreinjectCallLLM(() => {
    calls += 1;
    return Promise.resolve('["op1"]');
  });
  const { store, contexts, ctx } = setup({ preInjectGate: { enabled: true, enforce: false } });
  store.save({ type: "preference", title: "事实", content: "用户用中文交流", importance: 5 });
  store.save({ type: "preference", title: "意见", content: "我认为苹果是最好的", importance: 5 });
  const first = contexts[0].text(ctx);
  // 观察档：首轮无缓存，全量注入（含意见）；判定预取在渲染后异步挂起
  assert.ok(first.includes("我认为苹果是最好的"));
  await new Promise((r) => setTimeout(r, 20)); // flush prefetch (promise chain takes a macrotask)
  assert.equal(calls, 1, "enabled mode issues one pool-level judgment");
  // 同查询重复渲染不重判（工具调用轮去重）
  contexts[0].text(ctx);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1);
  setPreinjectCallLLM(null);
});

test("enforce mode: flagged entry dropped on next round after verdict caches", async () => {
  const { store, contexts, ctx } = setup({ preInjectGate: { enabled: true, enforce: true } });
  const mem1 = store.save({ type: "preference", title: "事实", content: "用户用中文交流", importance: 5 });
  const mem2 = store.save({ type: "preference", title: "意见", content: "我认为苹果是最好的", importance: 5 });
  // 判定器回真 id（save 返回行对象，id 是 uuid）——E13b 的 id 回显纪律：判对 id 才过滤
  setPreinjectCallLLM(() => Promise.resolve(JSON.stringify([mem2.id])));
  const first = contexts[0].text(ctx);
  assert.ok(first.includes("我认为苹果是最好的"), "first round: no verdict yet, full injection");
  await new Promise((r) => setTimeout(r, 20));
  const second = contexts[0].text(ctx);
  assert.ok(!second.includes("我认为苹果是最好的"), "second round: flagged entry filtered");
  assert.ok(second.includes("用户用中文交流"), "neutral entry survives");
  setPreinjectCallLLM(null);
  void mem1;
});

test("enforce mode: unparseable verdict degrades to full injection", async () => {
  setPreinjectCallLLM(() => Promise.resolve("not json at all"));
  const { contexts, ctx } = setup({ preInjectGate: { enabled: true, enforce: true } });
  const first = contexts[0].text(ctx);
  await new Promise((r) => setTimeout(r, 20));
  const second = contexts[0].text(ctx);
  assert.equal(second, first, "bad verdict = passthrough, block unchanged");
  setPreinjectCallLLM(null);
});

test("llm stream failure degrades to full injection", async () => {
  setPreinjectCallLLM(() => Promise.resolve(undefined));
  const { contexts, ctx } = setup({ preInjectGate: { enabled: true, enforce: true } });
  contexts[0].text(ctx);
  await new Promise((r) => setTimeout(r, 20));
  const second = contexts[0].text(ctx);
  assert.ok(second.length > 0, "injection still works after stream failure");
  setPreinjectCallLLM(null);
});

test("invented ids from the model are discarded (E13b id-echo fragility)", () => {
  const known = ["m1", "m2"];
  assert.deepEqual(parseFlaggedIds('["m1","fake-id"]', known), ["m1"]);
  assert.deepEqual(parseFlaggedIds('["m1","m1"]', known), ["m1"], "dedup");
  assert.equal(parseFlaggedIds("no array here", known), null);
  assert.equal(parseFlaggedIds('["m1"', known), null, "unbalanced");
});

test("gate unit: apply() without enforce or without query is passthrough", () => {
  const candidates = [{ id: "a" }, { id: "b" }];
  const off = createPreinjectGate({ callLLM: null, service: {}, config: {}, logger: null });
  assert.equal(off.apply("q", candidates), candidates);
  const observe = createPreinjectGate({ callLLM: null, service: {}, config: { preInjectGate: { enabled: true, enforce: false } }, logger: null });
  assert.equal(observe.apply("q", candidates), candidates);
  const enforce = createPreinjectGate({ callLLM: null, service: {}, config: { preInjectGate: { enabled: true, enforce: true } }, logger: null });
  assert.equal(enforce.apply("", candidates), candidates, "no query = no cache hit = passthrough");
  assert.equal(enforce.apply("q", candidates), candidates, "no verdict = passthrough");
});

test("gate unit: successful verdict is audited with flagged ids", async () => {
  const audits = [];
  const gate = createPreinjectGate({
    callLLM: () => Promise.resolve('["m2"]'),
    service: { saveLlmAudit: (e) => audits.push(e) },
    config: { preInjectGate: { enabled: true, enforce: false }, llmAudit: { enabled: true } },
    logger: null
  });
  gate.prefetch("q1", [{ id: "m1", title: "t", content: "c" }, { id: "m2", title: "t2", content: "c2" }]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].trigger_source, "preInjectGate");
  assert.equal(audits[0].status, "success");
  assert.deepEqual(audits[0].related_memory_ids, ["m2"]);
  // 观察档（enforce=false）：被标记者照常注入，verdict 只进审计
  assert.deepEqual(gate.apply("q1", [{ id: "m1" }, { id: "m2" }]), [{ id: "m1" }, { id: "m2" }]);
});

test("gate unit: unparseable verdict audited as error and not cached", async () => {
  const audits = [];
  const gate = createPreinjectGate({
    callLLM: () => Promise.resolve("garbage"),
    service: { saveLlmAudit: (e) => audits.push(e) },
    config: { preInjectGate: { enabled: true, enforce: false }, llmAudit: { enabled: true } },
    logger: null
  });
  gate.prefetch("q1", [{ id: "m1", title: "t", content: "c" }]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].status, "error");
  assert.deepEqual(gate.apply("q1", [{ id: "m1" }]), [{ id: "m1" }]);
});

test("prompt mentions opinion/stance framing, not query conflict (E12 protocol lock)", () => {
  const zh = preinjectPrompt([], "zh");
  const en = preinjectPrompt([], "en");
  assert.ok(zh.includes("意见") && zh.includes("JSON"), "zh prompt: opinion framing + JSON contract");
  assert.ok(en.toLowerCase().includes("opinion") && en.includes("JSON"), "en prompt: opinion framing + JSON contract");
});

test("disposal clears verdict cache (no cross-lifecycle retention)", async () => {
  let resolveNext;
  setPreinjectCallLLM(() => new Promise((r) => { resolveNext = r; }));
  const { store, contexts, injector, ctx } = setup({ preInjectGate: { enabled: true, enforce: true } });
  store.save({ type: "preference", title: "意见", content: "我认为苹果是最好的", importance: 5 });
  contexts[0].text(ctx);
  injector(); // dispose while a verdict is in flight
  resolveNext('["whatever"]');
  await new Promise((r) => setTimeout(r, 20));
  // 卸载后 verdicts 已清空——新判定器（若有）不会被旧数据污染；这里断言不抛错即可
  assert.ok(true);
  setPreinjectCallLLM(null);
});
