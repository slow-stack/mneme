import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { applyDecisions, validateDecisions } from "../src/dream/decisions.js";
import { runSleep } from "../src/dream/sleep.js";
import { createDreamScheduler } from "../src/dream.js";

// 机器 mint 的记忆必须带真 source。
//
// 背景（现场实测，2026-10-14）：pattern 表的 144 行 source 全是 "manual"，
// 而按 dream_runs 的 patterns.applied 逐轮求和恰好也是 144——它们全是 sleep 的
// phasePatterns mint 的，那个 "manual" 只是 saveWithDedupe 没拿到 source 时的
// 兜底值。于是「这类条目从哪来」在数据面上不可读，靠它做的判断（service.js 里
// 那条「pattern 只由手工写入」）也就跟着错了。
//
// 这组用例锁两件事：① 三条 mint 管道各自声明自己的来源；② 来源只能由调用方给，
// 模型写在决策对象上的 source 一律不算数——validateDecisions 不剥离未知字段，
// 若 applyCreate 信了 d.source，模型就能给自己的输出盖「人写的」戳。

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  return { store, service };
}

function mint(service, extra = {}) {
  return service
    .saveWithDedupe({ type: "project", title: `铺垫${Math.random()}`, content: "给扫描窗垫一条普通记忆", importance: 3 })
    .memory;
}

// ---------------------------------------------------------------- applyDecisions

test("mint source: applyDecisions stamps the caller's mintSource on create", () => {
  const { store, service } = setup();
  const { applied } = applyDecisions(
    [{ action: "create", type: "pattern", title: "真模式", content: "从重复里抽出来的规律", importance: 3 }],
    service,
    null,
    null,
    { mintSource: "sleep" }
  );
  assert.equal(applied, 1);
  const row = service.all().find((m) => m.type === "pattern");
  assert.equal(row.source, "sleep", "minted row carries the pipeline provenance");
  store.close();
});

test("mint source: dream pipeline stamps 'dream'", () => {
  const { store, service } = setup();
  applyDecisions(
    [{ action: "create", type: "pattern", title: "真模式", content: "规律", importance: 3 }],
    service,
    null,
    null,
    { mintSource: "dream" }
  );
  const row = service.all().find((m) => m.type === "pattern");
  assert.equal(row.source, "dream");
  store.close();
});

// 对抗条：来源取自调用方，不取自决策对象。模型自报的 source 必须被忽略——
// 否则「机器写的不冒充人写的」这条防线就形同虚设。
test("mint source: a source on the decision object is ignored, pipeline wins", () => {
  const { store, service } = setup();
  const decisions = [
    { action: "create", type: "pattern", title: "真模式", content: "规律", importance: 3, source: "manual" }
  ];
  // 先证明威胁真实存在：这类决策能整个通过校验走到 applyCreate（校验不剥离未知
  // 字段）。若哪天真加了剥离，这条会红——那时下面的对抗断言也就不再承重了。
  const { ok } = validateDecisions(decisions, new Map(), { maxCreatePerRun: 3 });
  assert.equal(ok, true, "a create carrying its own source still validates — that is the threat");

  applyDecisions(decisions, service, null, null, { mintSource: "sleep" });
  const row = service.all().find((m) => m.type === "pattern");
  assert.equal(row.source, "sleep", "the model-authored source must not win");
  store.close();
});

// 反向：模型自报 source 而没有管道来源时，也不许它自己说了算——回落到兜底，
// 而不是让模型指哪打哪。
test("mint source: without a pipeline source the model-authored one still does not win", () => {
  const { store, service } = setup();
  applyDecisions(
    [{ action: "create", type: "pattern", title: "真模式", content: "规律", importance: 3, source: "human" }],
    service
  );
  const row = service.all().find((m) => m.type === "pattern");
  assert.equal(row.source, "manual", "falls back to the existing default, not the model's claim");
  store.close();
});

// 不传 mintSource 时行为与改前逐字一致（不放大行为面）。
test("mint source: absent mintSource keeps the previous fallback", () => {
  const { store, service } = setup();
  applyDecisions([{ action: "create", type: "pattern", title: "真模式", content: "规律", importance: 3 }], service);
  const row = service.all().find((m) => m.type === "pattern");
  assert.equal(row.source, "manual");
  store.close();
});

// 空白串按「没给」处理，不能写出 source="" 这种假装有来源的空值。
test("mint source: blank mintSource is treated as absent", () => {
  const { store, service } = setup();
  applyDecisions(
    [{ action: "create", type: "pattern", title: "真模式", content: "规律", importance: 3 }],
    service,
    null,
    null,
    { mintSource: "   " }
  );
  const row = service.all().find((m) => m.type === "pattern");
  assert.equal(row.source, "manual");
  store.close();
});

// ------------------------------------------------------------------ end to end

// sleep 的 pattern 相位（唯一的真实 mint 路径）端到端：断言落库行的 source。
// 不能靠等下一次做梦验收（要调度 + LLM 路由），所以在这里驱动相位。
function sleepCtx(decisionsJson) {
  return {
    logger: { warn: () => {}, info: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "sleep-model" }) },
    llm: {
      async *stream(options) {
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        yield { type: "text-delta", index: 0, text: userText.includes("| type=") ? decisionsJson : "[]" };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
}

test("mint source: sleep pattern phase mints with source=sleep", async () => {
  const { store, service } = setup();
  mint(service);
  mint(service);
  const ctx = sleepCtx(
    JSON.stringify([{ action: "create", type: "pattern", title: "真模式", content: "从 a 和 b 提取", importance: 3 }])
  );
  const config = {
    sleepModeEnabled: true,
    sleepPatternMinMemories: 10,
    sleepMaxPatternPerRun: 3
  };
  const result = await runSleep(ctx, service, config, ctx.logger, null, null);
  assert.equal(result.phases.patterns.status, "ok", "pattern phase minted");

  const row = service.all().find((m) => m.type === "pattern");
  assert.ok(row, "pattern minted");
  assert.equal(row.source, "sleep", "the sleep phase declares its own provenance");
  store.close();
});

test("mint source: dream main chain mints with source=dream", async () => {
  const { store, service } = setup();
  const seed = service.saveWithDedupe({ type: "project", title: "旧条目", content: "第一段内容", importance: 3 }).memory;
  let call = 0;
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock-model" }) },
    llm: {
      async *stream(options) {
        call++;
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        const text = call === 1
          ? JSON.stringify([
            { action: "keep", ids: [seed.id] },
            { action: "create", type: "pattern", title: "主链路模式", content: "巩固时发现的规律", importance: 3 }
          ])
          : "记忆库总览摘要文本";
        void userText;
        yield { type: "text-delta", text };
        yield { type: "finish", reason: { kind: "ok" } };
      }
    }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "mock", dreamModel: "mock-model" });
  assert.equal(result.ok, true);

  const row = service.all().find((m) => m.type === "pattern");
  assert.ok(row, "the create decision minted a row");
  assert.equal(row.source, "dream");
  store.close();
});

// 验收口径本身：全表分组统计随之可读——同一次运行 mint 的条目能按来源数出来。
test("mint source: rows are countable by source after minting", () => {
  const { store, service } = setup();
  applyDecisions([{ action: "create", type: "pattern", title: "甲", content: "规律甲", importance: 3 }], service, null, null, { mintSource: "sleep" });
  applyDecisions([{ action: "create", type: "pattern", title: "乙", content: "规律乙", importance: 3 }], service, null, null, { mintSource: "dream" });
  const bySource = new Map();
  for (const m of service.all()) bySource.set(m.source, (bySource.get(m.source) ?? 0) + 1);
  assert.equal(bySource.get("sleep"), 1);
  assert.equal(bySource.get("dream"), 1);
  assert.equal(bySource.get("manual"), undefined, "nothing minted here fell back to the default");
  store.close();
});

// ── Issue #512：铸造出来的记忆要能追到「哪一轮」 ──
//
// source 只说「哪条管道」，不说「哪一次运行」。同一管道跑过几百轮之后，
// 「这条 pattern 是哪一轮抽出来的」在数据面上仍然不可读——这正是 #512 要补的。
// 归因落在 memory_mints：dream/sleep 铸造的记忆没有会话区间（session/seq 都不存在），
// 硬塞合成区间就是编的，所以窗口级归因（memory_provenance）与行级归因（本表）分层。

test("issue#512: a created row remembers which run minted it", () => {
  const { store, service } = setup();
  applyDecisions(
    [{ action: "create", type: "pattern", title: "真模式", content: "规律", importance: 3 }],
    service,
    null,
    null,
    { mintSource: "dream", runId: "run-abc" }
  );
  const row = service.all().find((m) => m.type === "pattern");
  assert.ok(row, "pattern minted");
  const mints = store.mintsFor(row.id);
  assert.equal(mints.length, 1, "one created row = one mint record");
  assert.equal(mints[0].run_id, "run-abc");
  assert.equal(mints[0].run_type, "dream");
  assert.equal(mints[0].trigger_source, "autoDream");
  store.close();
});

// 没有 run id 时什么都不写。旧装配（或直接调 applyDecisions 的调用方）没有 run 概念，
// 这时候编一个 id 出来比留空更坏：它会让「能追到」变成一句谎话。
test("issue#512: without a run id no mint record is fabricated", () => {
  const { store, service } = setup();
  applyDecisions(
    [{ action: "create", type: "pattern", title: "无轮模式", content: "规律", importance: 3 }],
    service,
    null,
    null,
    { mintSource: "dream" }
  );
  const row = service.all().find((m) => m.type === "pattern");
  assert.ok(row, "pattern still minted — 记账缺失不该拦铸造");
  assert.deepEqual(store.mintsFor(row.id), []);
  store.close();
});

// 只记 create。merge/conflict/update/supersede 动的是既有行，receipt_chain 已按
// (run_id, record_id) 记过一遍；再造一份就是第二套账，两边迟早对不上。
test("issue#512: only creation is recorded — edits to existing rows stay in receipt_chain", () => {
  const { store, service } = setup();
  const existing = service.saveWithDedupe({ type: "project", title: "既有行", content: "旧内容", importance: 3 }).memory;
  applyDecisions(
    [{ action: "update", ids: [existing.id], content: "新内容", importance: 4 }],
    service,
    null,
    null,
    { mintSource: "dream", runId: "run-upd" }
  );
  assert.deepEqual(store.mintsFor(existing.id), [], "update 不是铸造，不进 memory_mints");
  store.close();
});

// 端到端：sleep 真的跑一轮，铸造出来的行要指回那一轮的 runId（不是随便一个 id）。
test("issue#512: sleep mints point back at the run that produced them", async () => {
  const { store, service } = setup();
  mint(service);
  mint(service);
  const ctx = sleepCtx(
    JSON.stringify([{ action: "create", type: "pattern", title: "真模式", content: "从 a 和 b 提取", importance: 3 }])
  );
  const config = { sleepModeEnabled: true, sleepPatternMinMemories: 10, sleepMaxPatternPerRun: 3 };
  const result = await runSleep(ctx, service, config, ctx.logger, null, null);
  assert.equal(result.phases.patterns.status, "ok", "pattern phase minted");

  const row = service.all().find((m) => m.type === "pattern");
  assert.ok(row, "pattern minted");
  const mints = store.mintsFor(row.id);
  assert.equal(mints.length, 1);
  assert.equal(mints[0].run_id, result.runId, "归因要指回这一轮的 runId，不是另编一个");
  assert.equal(mints[0].run_type, "sleep");
  assert.equal(mints[0].trigger_source, "sleep");
  // 那一轮 run 台账本身也在：两边能对上，归因才成立。
  assert.equal(store.getDreamRun(result.runId).run_type, "sleep");
  store.close();
});
