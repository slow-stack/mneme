import test from "node:test";
import assert from "node:assert/strict";
import { createSleepScheduler, runSleep } from "../src/dream/sleep.js";
import { Config } from "../src/config.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";

// Mock embedder: every query maps to [1,0,0] so vectors are identical unless a
// test pre-seeds a custom vector via vectorIndex.saveEmbedding.
const embedder = {
  embedSingle: async () => [1, 0, 0],
  embed: async () => [1, 0, 0],
  schedule: () => {},
  modelHash: "mock#1",
  dimension: 3
};

// Deterministic LLM: onConsolidation(userText) => decisions JSON string.
function mockCtx(onConsolidation, selection = { provider: "mock", model: "sleep-model" }) {
  return {
    logger: { warn: () => {}, info: () => {} },
    agentDefaultModel: { currentSelection: () => selection },
    llm: {
      async *stream(options) {
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        const reply = onConsolidation ? onConsolidation(userText) : "[]";
        yield { type: "text-delta", index: 0, text: reply };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
}

function baseConfig(overrides = {}) {
  return {
    sleepModeEnabled: true,
    sleepIdleMinutes: 5,
    sleepMinIntervalHours: 8,
    sleepConflictStrictness: "normal",
    sleepArchiveDays: 30,
    sleepCompressDays: 90,
    sleepPatternMinMemories: 100,
    sleepMaxPatternPerRun: 3,
    ...overrides
  };
}

// v0.7.0 heat 双保护默认保守：默认 heatTypeDecay 下 project 记忆 40 天热值
// ≈0.55、100 天 ≈0.28，始终高于 sleepHeatThreshold(0.05)，demotion 不触发。
// 降级语义测试把 project 的 λ 调快到 0.02（40 天热值≈0.03），复现"时间窗冷态
// 即降级"的旧路径；默认保守语义由 sleep-heat.test.js 单独覆盖。
function demotionConfig(overrides = {}) {
  return baseConfig({ heatTypeDecay: { project: 0.02 }, ...overrides });
}

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const vectorIndex = createVectorIndex({ store });
  service.setEmbedder(embedder);
  service.setVectorIndex(vectorIndex);
  return { store, service, vectorIndex };
}

function makeMemory(service, title, content, type = "project") {
  return service.saveWithDedupe({ type, title, content, importance: 3 }).memory;
}

// ------------------------------------------------------------ scheduler

test("sleep: scheduler does not run when disabled", () => {
  const { service, store } = setup();
  const sched = createSleepScheduler({
    service, config: baseConfig({ sleepModeEnabled: false }), logger: { warn: () => {} },
    onRun: async () => ({ ok: true }),
    now: () => 1_000_000, setTimeoutFn: () => 1, clearTimeoutFn: () => {}
  });
  assert.equal(sched.shouldRun(1_000_000 + 60 * 60000), false, "disabled never schedules");
  store.close();
});

test("sleep: scheduler fires once idle window elapses", () => {
  const { service, store } = setup();
  const sched = createSleepScheduler({
    service, config: baseConfig(), logger: { warn: () => {} },
    onRun: async () => ({ ok: true }),
    now: () => 1_000_000, setTimeoutFn: () => 1, clearTimeoutFn: () => {}
  });
  assert.equal(sched.shouldRun(1_000_000 + 4 * 60000), false, "still within idle window");
  assert.equal(sched.shouldRun(1_000_000 + 6 * 60000), true, "idle window elapsed");
  store.close();
});

test("sleep: noteWrite resets the idle clock (stale-timer guard)", () => {
  const { service, store } = setup();
  let now = 1_000_000;
  const sched = createSleepScheduler({
    service, config: baseConfig(), logger: { warn: () => {} },
    onRun: async () => ({ ok: true }),
    now: () => now, setTimeoutFn: () => 1, clearTimeoutFn: () => {}
  });
  assert.equal(sched.shouldRun(now + 6 * 60000), true, "idle after 6min");
  now = 1_000_000 + 6 * 60000;
  sched.noteWrite();
  assert.equal(sched.shouldRun(now), false, "write resets idle clock");
  assert.equal(sched.shouldRun(now + 4 * 60000), false, "still idle-pending after reset");
  assert.equal(sched.shouldRun(now + 6 * 60000), true, "idle again after fresh window");
  store.close();
});

test("sleep: first-ever run is not blocked by min interval (lastRunAt=0)", () => {
  const { service, store } = setup();
  const sched = createSleepScheduler({
    service, config: baseConfig(), logger: { warn: () => {} },
    onRun: async () => ({ ok: true }),
    now: () => 1_000_000, setTimeoutFn: () => 1, clearTimeoutFn: () => {}
  });
  assert.equal(sched.shouldRun(1_000_000 + 6 * 60000), true, "first run allowed");
  store.close();
});

test("sleep: min interval blocks a re-run within the window, allows after", async () => {
  const { service, store } = setup();
  let now = 1_000_000;
  const sched = createSleepScheduler({
    service, config: baseConfig(), logger: { warn: () => {} },
    onRun: async () => ({ ok: true }),
    now: () => now, setTimeoutFn: () => 1, clearTimeoutFn: () => {}
  });
  now = 1_000_000 + 6 * 60000; // idle satisfied
  const ok = await sched.maybeSchedule();
  assert.equal(ok, true, "first run executed");
  assert.equal(sched.shouldRun(now + 1 * 3600000), false, "1h later still inside 8h min interval");
  assert.equal(sched.shouldRun(now + 9 * 3600000), true, "9h later past min interval → allowed");
  store.close();
});

test("sleep: maybeSchedule enqueues via service and serializes with other work", async () => {
  const { service, store } = setup();
  const config = baseConfig();
  let now = 1_000_000;
  let order = [];
  const sched = createSleepScheduler({
    service, config, logger: { warn: () => {} },
    onRun: async () => { order.push("sleep"); return { ok: true, applied: 7 }; },
    now: () => now, setTimeoutFn: () => 1, clearTimeoutFn: () => {}
  });
  now = 1_000_000 + 6 * 60000;
  const p1 = service.enqueue(async () => { order.push("a"); });
  const p2 = sched.maybeSchedule();
  await p1;
  const result = await p2;
  assert.equal(result, true, "run result propagated through enqueue");
  assert.deepEqual(order, ["a", "sleep"], "sleep run serialized behind queued work");
  store.close();
});

test("sleep: dispose clears the timer and prevents further runs", async () => {
  const { service, store } = setup();
  let cleared = false;
  const sched = createSleepScheduler({
    service, config: baseConfig(), logger: { warn: () => {} },
    onRun: async () => ({ ok: true }),
    now: () => 1_000_000,
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => { cleared = true; }
  });
  // #187 起构造即挂表——dispose 必须能清掉这张（以及 noteWrite 重挂过的任何）表。
  assert.equal(cleared, false, "timer armed at construction, not yet cleared");
  await sched.dispose();
  assert.equal(cleared, true, "idle timer cleared on dispose");
  assert.equal(sched.shouldRun(1_000_000 + 6 * 60000), false, "disposed never runs");
  store.close();
});

// ------------------------------------------------------------ runSleep phases

test("sleep: demotion shrinks cold memory to summary, keeps _full_content", async () => {
  const { service, store } = setup();
  const now = Date.now();
  const m = makeMemory(service, "cold", "原内容".repeat(60), "project");
  service.touchLastAccess(m.id, new Date(now - 40 * 86400000).toISOString());
  const ctx = mockCtx(() => "[]");
  const result = await runSleep(ctx, service, demotionConfig(), ctx.logger, null, null);
  const after = service.getById(m.id);
  assert.equal(result.status, "ok");
  assert.ok(after._full_content && after._full_content.length > 0, "full body preserved");
  assert.ok(after.content.length < "原内容".repeat(60).length, "content shrank to summary");
  assert.equal(after.archived, false, "not fully archived at 40 days");
  store.close();
});

test("sleep: demotion fully archives memory past sleepCompressDays", async () => {
  const { service, store } = setup();
  const now = Date.now();
  const m = makeMemory(service, "ancient", "很老的记忆", "project");
  service.touchLastAccess(m.id, new Date(now - 100 * 86400000).toISOString());
  const ctx = mockCtx(() => "[]");
  const result = await runSleep(ctx, service, demotionConfig(), ctx.logger, null, null);
  const after = service.getById(m.id);
  assert.equal(result.status, "ok");
  assert.equal(after.archived, true, "past compress days → archived");
  store.close();
});

test("sleep: demoteToSummary minRefTimeMs skips a memory touched after snapshot", () => {
  const { service, store } = setup();
  const now = Date.now();
  const m = makeMemory(service, "touched", "内容".repeat(60), "project");
  service.touchLastAccess(m.id, new Date(now - 40 * 86400000).toISOString());
  const snapshotCut = now - 1 * 86400000;
  service.touchLastAccess(m.id, new Date(snapshotCut + 60000).toISOString());
  const updated = service.demoteToSummary(m.id, "摘要", { minRefTimeMs: snapshotCut });
  assert.equal(updated, undefined, "touched-after-snapshot memory is not demoted");
  assert.equal(service.getById(m.id)._full_content ?? null, null, "no demotion happened");
  store.close();
});

test("sleep: demotion demotes a memory still cold after snapshot", () => {
  const { service, store } = setup();
  const now = Date.now();
  const m = makeMemory(service, "stillcold", "内容".repeat(60), "project");
  service.touchLastAccess(m.id, new Date(now - 40 * 86400000).toISOString());
  const snapshotCut = now - 1 * 86400000;
  const updated = service.demoteToSummary(m.id, "摘要", { minRefTimeMs: snapshotCut });
  assert.ok(updated && updated._full_content, "cold memory demoted to summary");
  store.close();
});

test("sleep: pattern discovery filters fabricated evidence ids", async () => {
  const { service, store } = setup();
  const a = makeMemory(service, "模式A", "反复出现的模式A", "project");
  const b = makeMemory(service, "模式B", "反复出现的模式B", "project");
  const ctx = mockCtx(() =>
    JSON.stringify([
      { action: "create", type: "pattern", title: "真模式", content: "从 a 和 b 提取", importance: 3, evidence: [a.id, "fake-zzz", b.id] }
    ])
  );
  const result = await runSleep(ctx, service, baseConfig({ sleepPatternMinMemories: 10 }), ctx.logger, null, null);
  assert.ok(!JSON.stringify(result.phases.patterns).includes("fake-zzz"), "fabricated evidence filtered before apply");
  const pattern = service.all().find((x) => x.type === "pattern");
  assert.ok(pattern, "pattern minted");
  store.close();
});

test("sleep: relation completion links orphan entities co-occurring in a memory", async () => {
  const { service, store } = setup();
  const alpha = service.createEntity({ name: "Alpha", type: "project" });
  const beta = service.createEntity({ name: "Beta", type: "project" });
  makeMemory(service, "协作", "Alpha 与 Beta 一起干活", "project");
  const ctx = mockCtx(() => "[]");
  const result = await runSleep(ctx, service, baseConfig(), ctx.logger, null, null);
  assert.equal(result.phases.relations.status, "ok", "relations phase ran");
  const rels = service.getRelations(alpha.id);
  assert.ok(rels.length >= 1, "orphan Alpha gained a relation");
  assert.ok(rels.some((r) => r.to_entity === beta.id || r.from_entity === beta.id), "relation targets Beta");
  store.close();
});

test("sleep: runSleep writes an audit receipt with run_type='sleep'", async () => {
  const { service, store } = setup();
  const now = Date.now();
  const m = makeMemory(service, "cold", "内容".repeat(60), "project");
  service.touchLastAccess(m.id, new Date(now - 40 * 86400000).toISOString());
  const ctx = mockCtx(() => "[]");
  const result = await runSleep(ctx, service, baseConfig(), ctx.logger, null, null);
  const runs = service.listDreamRuns();
  const last = runs[runs.length - 1];
  assert.equal(last.run_type, "sleep", "audit row tagged sleep");
  assert.equal(result.runId, last.id, "run id matches audit row");
  assert.ok(typeof result.receipt === "string" && result.receipt.startsWith("dsh-mneme:run:"), "receipt is the audit string");
  store.close();
});

test("sleep: a failing phase does not block the others (fail-safe)", async () => {
  const { service, store } = setup();
  service.setEmbedder({
    embed: async () => { throw new Error("embed down"); },
    embedSingle: async () => { throw new Error("embed down"); },
    modelHash: "x", dimension: 3
  });
  const now = Date.now();
  const m = makeMemory(service, "cold", "内容".repeat(60), "project");
  service.touchLastAccess(m.id, new Date(now - 40 * 86400000).toISOString());
  const ctx = mockCtx(() => "[]");
  const result = await runSleep(ctx, service, demotionConfig(), ctx.logger, null, null);
  assert.equal(result.phases.conflicts.status, "skipped", "conflicts phase degraded gracefully (no usable vectors)");
  assert.equal(result.phases.demotion.status, "ok", "demotion still ran");
  assert.equal(result.status, "ok", "overall run still ok despite conflicts degrading");
  assert.ok(service.getById(m.id)._full_content, "cold memory still demoted despite conflicts failure");
  store.close();
});

test("sleep: no LLM route skips LLM phases but demotion still runs", async () => {
  const { service, store } = setup();
  const now = Date.now();
  const m = makeMemory(service, "cold", "内容".repeat(60), "project");
  service.touchLastAccess(m.id, new Date(now - 40 * 86400000).toISOString());
  const ctx = mockCtx(() => "[]", null); // currentSelection() → null, no route
  const result = await runSleep(ctx, service, demotionConfig(), ctx.logger, null, null);
  assert.equal(result.phases.conflicts.status, "skipped", "no llm route → conflicts skipped");
  assert.equal(result.phases.patterns.status, "skipped", "no llm route → patterns skipped");
  assert.equal(result.phases.demotion.status, "ok", "demotion is LLM-free and runs");
  store.close();
});

// ------------------------------------------------------------ conflict strictness

function seedConflictPair(service, vectorIndex, sim) {
  const a = makeMemory(service, "主题X", "内容A 关于主题X", "project");
  const b = makeMemory(service, "主题X副本", "内容B 关于主题X", "project");
  const sin = Math.sqrt(Math.max(0, 1 - sim * sim));
  vectorIndex.saveEmbedding(a.id, [1, 0, 0]);
  vectorIndex.saveEmbedding(b.id, [sim, sin, 0]);
  return { a, b };
}

test("sleep: conflict strictness gentle ignores sim 0.88 pairs", async () => {
  const { service, store, vectorIndex } = setup();
  seedConflictPair(service, vectorIndex, 0.88);
  const config = baseConfig({ sleepConflictStrictness: "gentle", conflictFreezeEnabled: true });
  const ctx = mockCtx(() => "[]");
  const result = await runSleep(ctx, service, config, ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.status, "skipped", "0.88 below gentle 0.92 → no conflicts");
  store.close();
});

test("sleep: conflict strictness normal resolves sim 0.88 pairs", async () => {
  const { service, store, vectorIndex } = setup();
  seedConflictPair(service, vectorIndex, 0.88);
  const config = baseConfig({ sleepConflictStrictness: "normal", conflictFreezeEnabled: true });
  const ctx = mockCtx(() => "[]");
  const result = await runSleep(ctx, service, config, ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.status, "ok", "0.88 above normal 0.85 → conflicts found");
  assert.ok(result.phases.conflicts.frozen >= 1, "pairs frozen for review");
  store.close();
});

test("sleep: conflict strictness aggressive adjudicates low-confidence pairs", async () => {
  const { service, store, vectorIndex } = setup();
  seedConflictPair(service, vectorIndex, 0.80);
  const config = baseConfig({ sleepConflictStrictness: "aggressive", conflictFreezeEnabled: true });
  const ctx = mockCtx(() => "[]");
  const result = await runSleep(ctx, service, config, ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.status, "ok", "0.80 above aggressive 0.75 → conflicts found");
  assert.ok(result.phases.conflicts.frozen >= 1, "pairs frozen");
  store.close();
});

test("sleep: conflict LLM arbitration applies winner/loser", async () => {
  const { service, store, vectorIndex } = setup();
  const { a, b } = seedConflictPair(service, vectorIndex, 1.0);
  const ctx = mockCtx(() =>
    JSON.stringify([{ action: "conflict", winner: a.id, loser: b.id, reason: "重复覆盖" }])
  );
  const result = await runSleep(ctx, service, baseConfig(), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.status, "ok", "conflict resolved");
  assert.equal(service.getById(b.id).archived, true, "loser archived by arbitration");
  store.close();
});

test("sleep: runSleep is abortable via signal between phases", async () => {
  const { service, store } = setup();
  const now = Date.now();
  const m = makeMemory(service, "cold", "内容".repeat(60), "project");
  service.touchLastAccess(m.id, new Date(now - 40 * 86400000).toISOString());
  const ctrl = new AbortController();
  ctrl.abort(); // pre-aborted
  const ctx = mockCtx(() => "[]");
  const result = await runSleep(ctx, service, baseConfig(), ctx.logger, null, ctrl.signal);
  assert.equal(result.phases.conflicts, undefined, "aborted before any phase ran");
  store.close();
});

// Issue #257：冲突/模式两阶段的输出预算原硬编码 2048——sleepActionSet=full
// 实测 24 对需约 6967 token，截断即 invalid decisions json 整轮失败。两阶段
// 必须读取 sleepMaxTokens 配置并透传到 ctx.llm.stream 的 options。
test("issue#257 conflict and pattern phases forward configured sleepMaxTokens", async () => {
  const { service, store, vectorIndex } = setup();
  const { a, b } = seedConflictPair(service, vectorIndex, 1.0);
  const seen = [];
  const ctx = mockCtx((userText) =>
    JSON.stringify([{ action: "conflict", winner: a.id, loser: b.id, reason: "重复覆盖" }])
  );
  const origStream = ctx.llm.stream.bind(ctx.llm);
  ctx.llm.stream = async function* (options) {
    if (options?.purpose === "sleep-conflict" || options?.purpose === "sleep-pattern") {
      seen.push({ purpose: options.purpose, maxTokens: options.maxTokens });
    }
    if (options?.purpose === "sleep-pattern") {
      // pattern 阶段喂确定性空结果（no patterns found → skipped），
      // 不复用 conflict 决策（宽松模式下会被当 Fabricated 静默跳过）。
      yield { type: "text-delta", index: 0, text: "[]" };
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    yield* origStream(options);
  };
  const result = await runSleep(ctx, service, baseConfig({ sleepMaxTokens: 6967 }), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.status, "ok", "run completes with the configured budget");
  assert.ok(seen.some((s) => s.purpose === "sleep-conflict" && s.maxTokens === 6967), "conflict phase reads sleepMaxTokens");
  assert.ok(seen.some((s) => s.purpose === "sleep-pattern" && s.maxTokens === 6967), "pattern phase reads sleepMaxTokens");
  store.close();
});

test("issue#257 schema default for sleepMaxTokens is 8192 (was hardcoded 2048)", () => {
  const cfg = Config({});
  assert.equal(cfg.sleepMaxTokens, 8192, "schema default covers the measured full-set peak (6967)");
});

// ------------------------------------------- sleep LLM accounting (issue #250)
// Bug8 给 dream 与 summarize 接记账时漏了 sleep：src/dream/sleep.js 有一份自己的
// streamText，签名里没有 onUsage，两条 LLM 链路（conflict 裁决 / pattern 挖掘）的
// token 与状态从未进 llm_audit_logs——面板因此只看到两条链路，回答不了「sleep 花了
// 多少」。下面两条用例锁定「审计行落库 + token 数值来自 usage chunk」。
// 两条链路共用同一处 streamText 改动，故放在同一轮 red-green 里。

/** 在 base ctx 的流里、finish 之前插入一个 usage chunk（形态同 llm-audit.test.js）。 */
function withUsageChunk(base, usageChunk) {
  return {
    ...base,
    llm: {
      async *stream(options) {
        for await (const chunk of base.llm.stream(options)) {
          if (chunk.type === "finish") yield usageChunk;
          yield chunk;
        }
      }
    }
  };
}

test("issue#250 sleep conflict phase writes an llm_audit row with the streamed tokens", async () => {
  const { service, store, vectorIndex } = setup();
  const { a, b } = seedConflictPair(service, vectorIndex, 1.0);
  const ctx = withUsageChunk(
    mockCtx(() => JSON.stringify([{ action: "conflict", winner: a.id, loser: b.id, reason: "重复覆盖" }])),
    { type: "usage", usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 } }
  );
  const result = await runSleep(ctx, service, baseConfig(), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.status, "ok", "conflict resolved");

  const conflict = service.listLlmAudits({ source: "sleep" }).find((r) => r.operation_type === "sleep_conflict");
  assert.ok(conflict, "sleep_conflict audit row present");
  assert.equal(conflict.trigger_source, "sleep");
  assert.equal(conflict.status, "success");
  assert.equal(conflict.model_id, "mock:sleep-model", "route actually used is recorded");
  assert.equal(conflict.input_tokens, 1200, "input tokens come from chunk.usage");
  assert.equal(conflict.output_tokens, 300, "output tokens come from chunk.usage");
  assert.equal(conflict.total_tokens, 1500);
  assert.ok(typeof conflict.duration_ms === "number" && conflict.duration_ms >= 0);
  store.close();
});

test("issue#250 sleep pattern phase writes an llm_audit row with the streamed tokens", async () => {
  const { service, store } = setup();
  const a = makeMemory(service, "模式A", "反复出现的模式A", "project");
  const b = makeMemory(service, "模式B", "反复出现的模式B", "project");
  const ctx = withUsageChunk(
    mockCtx(() => JSON.stringify([
      { action: "create", type: "pattern", title: "真模式", content: "从 a 和 b 提取", importance: 3, evidence: [a.id, b.id] }
    ])),
    { type: "usage", usage: { inputTokens: 900, outputTokens: 250, totalTokens: 1150 } }
  );
  const result = await runSleep(ctx, service, baseConfig({ sleepPatternMinMemories: 10 }), ctx.logger, null, null);
  assert.ok(result.phases.patterns, "pattern phase ran");

  const pattern = service.listLlmAudits({ source: "sleep" }).find((r) => r.operation_type === "sleep_pattern");
  assert.ok(pattern, "sleep_pattern audit row present");
  assert.equal(pattern.trigger_source, "sleep");
  assert.equal(pattern.status, "success");
  assert.equal(pattern.input_tokens, 900, "input tokens come from chunk.usage");
  assert.equal(pattern.output_tokens, 250, "output tokens come from chunk.usage");
  assert.equal(pattern.total_tokens, 1150);
  store.close();
});

// 审计诚实性（issue #250）：流式成功但输出里没有 JSON 数组时，phase 报 failed，
// 审计行也必须记 error——不能一个调用在两表里自相矛盾。
test("issue#250 sleep conflict parse failure is audited as status=error, not fake success", async () => {
  const { service, store, vectorIndex } = setup();
  const { a, b } = seedConflictPair(service, vectorIndex, 1.0);
  const ctx = mockCtx(() => "抱歉，我无法把裁决整理成 JSON。");
  const result = await runSleep(ctx, service, baseConfig(), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.status, "failed", "the phase reports the failure");

  const row = service.listLlmAudits({ source: "sleep" }).find((r) => r.operation_type === "sleep_conflict");
  assert.ok(row, "the failed call is still audited");
  assert.equal(row.status, "error", "a stream that returned unusable output is not a success");
  assert.match(row.error_message, /no json array in llm output/);
  store.close();
});

test("issue#250 sleep pattern parse failure is audited as status=error, not fake success", async () => {
  const { service, store } = setup();
  makeMemory(service, "模式A", "反复出现的模式A", "project");
  makeMemory(service, "模式B", "反复出现的模式B", "project");
  const ctx = mockCtx(() => "这不是 JSON 数组");
  const result = await runSleep(ctx, service, baseConfig({ sleepPatternMinMemories: 10 }), ctx.logger, null, null);
  // pattern 阶段对不可解析输出的既定语义是 skipped（"no patterns found"）——那是
  // 「有没有铸造出模式」的结论，不是「这次调用成没成功」的结论，此处不改上游语义。
  assert.equal(result.phases.patterns.status, "skipped", "the phase keeps its existing semantics");

  const row = service.listLlmAudits({ source: "sleep" }).find((r) => r.operation_type === "sleep_pattern");
  assert.ok(row, "the call still consumed tokens and is still audited");
  assert.equal(row.status, "error", "the audit records the call's truth, not the phase's conclusion");
  assert.match(row.error_message, /no json array in llm output/);
  store.close();
});

// 回归护栏：llmAudit.enabled === false 时 auditedSleepLlm 整段早退，auditError 钩子
// 不会被调用。所以两个 phase 的控制流必须各自解析输出、不能依赖那个钩子的副作用
// ——dream 的 runAuditedLlm 正是那样踩了（关掉审计 flag 会让 autoDream 直接失效）。
test("issue#250 sleep still adjudicates normally when llmAudit.enabled === false", async () => {
  const { service, store, vectorIndex } = setup();
  const { a, b } = seedConflictPair(service, vectorIndex, 1.0);
  const ctx = mockCtx(() =>
    JSON.stringify([{ action: "conflict", winner: a.id, loser: b.id, reason: "重复覆盖" }])
  );
  const config = baseConfig({ llmAudit: { enabled: false } });
  const result = await runSleep(ctx, service, config, ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.status, "ok", "turning the audit off must not break sleep");
  assert.equal(service.getById(b.id).archived, true, "the arbitration still applied");
  assert.equal(service.listLlmAudits().length, 0, "no audit rows when disabled");
  store.close();
});
// ------------------------------------------------------------ issue #529: input budget

// seedSimilarPairs：造 n 条同类型、两两相似度都不低于阈值的记忆，且每条只可能与
// 一条配成对（相似度按 i 递减）。用来验证「池子大于单批上限」时分批是否真的分开了。
// 这些向量不是正交的——cosine 只在 [1,0,0] 与 [s, sin, 0] 之间算，因此给每对单独
// 一个角度，与 seedConflictPair 同一套构造。
function seedSimilarPairs(service, vectorIndex, n) {
  const mems = [];
  for (let i = 0; i < n; i++) {
    const m = makeMemory(service, `主题${i}`, `内容${i}`, "project");
    mems.push(m);
  }
  // 全部推到同一个方向附近：任意两条的 cosine 都 ≈ 1（> 0.85），findPotentialConflicts
  // 会生成 C(n,2) 对，去重阶段按相似度留下 n/2 对（每记忆至多一对）。
  for (const m of mems) vectorIndex.saveEmbedding(m.id, [1, 0, 0]);
  return mems;
}

// 记录**冲突相位**每次往返送进去的候选对数（user 消息里每个候选行以 "id=" 开头）。
// 必须按 purpose 过滤：同一轮里 pattern 相位也会调 LLM，把它的往返算进来会让
// 「送了几批」这个断言凭空多一批。
function countingCtx(responder, batchSizes = []) {
  let call = 0;
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "sleep-model" }) },
    llm: {
      async *stream(options) {
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        let reply = "[]";
        if (options.purpose === "sleep-conflict") {
          batchSizes.push((userText.match(/id=/g) ?? []).length);
          reply = responder(userText, ++call);
        }
        yield { type: "text-delta", index: 0, text: reply };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
  return { ctx, batchSizes, calls: () => call };
}

test("issue#529 conflict pairs are sent in bounded batches, not one giant prompt", async () => {
  const { service, store, vectorIndex } = setup();
  seedSimilarPairs(service, vectorIndex, 8);
  const { ctx, batchSizes } = countingCtx(() => "[]");
  const config = baseConfig({ sleepConflictMaxPairs: 2, sleepConflictMaxPairsPerRun: 8 });
  const result = await runSleep(ctx, service, config, ctx.logger, { embedder, vectorIndex }, null);
  assert.ok(batchSizes.length > 1, `expected several batches, got ${batchSizes.length}`);
  assert.ok(batchSizes.every((n) => n > 0 && n <= 4), `每批不超过 2 对（每对 2 个 id）: ${JSON.stringify(batchSizes)}`);
  assert.deepEqual(batchSizes.slice(-2), [4, 4], "每对 2 个 id ⇒ 2 对 = 4 个 id 行");
  assert.equal(result.phases.conflicts.batches, batchSizes.length, "审计里的批次数与真实往返次数一致");
  store.close();
});

test("issue#529 a failing batch does not kill the whole run (degraded, not failed)", async () => {
  const { service, store, vectorIndex } = setup();
  seedSimilarPairs(service, vectorIndex, 8);
  const { ctx } = countingCtx((_text, n) => {
    // 第一批吐空（stream 正常结束但无文本 ⇒ llm failed），后面的批正常。
    return n === 1 ? "" : "[]";
  });
  const config = baseConfig({ sleepConflictMaxPairs: 2, sleepConflictMaxPairsPerRun: 8 });
  const result = await runSleep(ctx, service, config, ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.status, "degraded", "坏批只记 degraded，不判死整轮");
  assert.ok(result.phases.conflicts.batches > 1, "后面的批照样跑完了");
  store.close();
});

test("issue#529 a judged pair is not re-sent while neither side changed (keep leaves a trace)", async () => {
  const { service, store, vectorIndex } = setup();
  const { a, b } = seedConflictPair(service, vectorIndex, 1.0);
  const config = baseConfig();
  // 第一轮：判 keep（= 模型说这两条不冲突）。这曾经是彻底的 no-op。
  const first = await runSleep(mockCtx(() => "[]"), service, config, { warn: () => {} }, { embedder, vectorIndex }, null);
  assert.equal(first.phases.conflicts.status, "noop", "没有动作 ⇒ noop");
  const ledger = service.listConflictReviewed();
  assert.equal(ledger.length, 1, "判 keep 也要在台账里留一行");
  assert.equal(ledger[0].outcome, "keep");
  assert.deepEqual([ledger[0].memory_a, ledger[0].memory_b].sort(), [a.id, b.id].sort());

  // 第二轮：两侧都没动 ⇒ 这对已经在台账里，不该再送 LLM。
  const secondCtx = countingCtx(() => "[]");
  const second = await runSleep(secondCtx.ctx, service, config, secondCtx.ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(secondCtx.calls(), 0, "同一对、两侧都没更新 ⇒ 不再送审");
  assert.equal(second.phases.conflicts.ledgerSkipped, 1);

  // 第三轮：动一下其中一侧（内容更新 ⇒ updated_at 前进），它就该重新入池。
  // service.update 会把该行的向量作废并异步重算；测试里的 mock embedder 只支持
  // 「一条一条 embed」的形式（embedSingle），批量 embed 的返回形状不是它覆盖的范围，
  // 所以这里按既有夹具的做法手工补一次向量——被测的是台账判据，不是回填路径。
  service.update(b.id, { content: "内容B 关于主题X（改）" });
  vectorIndex.saveEmbedding(b.id, [1, 0, 0]);
  const thirdCtx = countingCtx(() => "[]");
  const third = await runSleep(thirdCtx.ctx, service, config, thirdCtx.ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(thirdCtx.calls(), 1, "任一侧更新过 ⇒ 重新送审");
  assert.equal(third.phases.conflicts.ledgerSkipped, 0);
  store.close();
});

test("issue#529 per-run cap bounds the pairs adjudicated in one run", async () => {
  const { service, store, vectorIndex } = setup();
  seedSimilarPairs(service, vectorIndex, 12);
  const { ctx, calls } = countingCtx(() => "[]");
  const config = baseConfig({ sleepConflictMaxPairs: 2, sleepConflictMaxPairsPerRun: 4 });
  const result = await runSleep(ctx, service, config, ctx.logger, { embedder, vectorIndex }, null);
  assert.ok(calls() <= 2, `每轮最多 4 对 ÷ 每批 2 对 = 2 次往返，实际 ${calls()}`);
  assert.ok(result.phases.conflicts.perRunSkipped > 0, "超出本轮预算的对要被记下来");
  store.close();
});

test("issue#529 user activity between batches aborts instead of reporting noop", async () => {
  const { service, store, vectorIndex } = setup();
  seedSimilarPairs(service, vectorIndex, 12);
  const controller = new AbortController();
  // 第一批返回之后用户恢复活动（noteWrite → abort）。此时第二、三批根本没送出去，
  // 把它们算成「看过、没冲突」（noop）是这一相位最容易犯的谎。
  const { ctx } = countingCtx(() => {
    controller.abort();
    return "[]";
  });
  const config = baseConfig({ sleepConflictMaxPairs: 1, sleepConflictMaxPairsPerRun: 12 });
  const result = await runSleep(ctx, service, config, ctx.logger, { embedder, vectorIndex }, controller.signal);
  assert.equal(result.phases.conflicts.status, "aborted", "中途被打断不是 noop");
  assert.equal(result.phases.conflicts.batches, 6, "计划批次数照实记（不是实际送出的批次数）");
  // 整轮层也要如实：deriveStatus 此前只认 failed/error，aborted 相位会被静默折成
  // noop，审计行于是把「没跑完」记成「跑过、没什么事」——与相位层同一个谎。
  assert.equal(result.status, "aborted", "整轮状态沿用相位的 aborted，不折回 noop");
  store.close();
});

test("issue#529 failed batches still report pairs/batches (audit used to lose them)", async () => {
  const { service, store, vectorIndex } = setup();
  seedSimilarPairs(service, vectorIndex, 4);
  const { ctx } = countingCtx(() => "");
  const config = baseConfig({ sleepConflictMaxPairs: 2, sleepConflictMaxPairsPerRun: 4 });
  const result = await runSleep(ctx, service, config, ctx.logger, { embedder, vectorIndex }, null);
  const phase = result.phases.conflicts;
  assert.equal(phase.status, "failed", "全部批次失败 ⇒ 整轮 failed");
  assert.ok(Number.isInteger(phase.pairs) && phase.pairs > 0, "失败轮也带 pairs");
  assert.ok(Number.isInteger(phase.batches) && phase.batches > 0, "失败轮也带 batches");
  store.close();
});

