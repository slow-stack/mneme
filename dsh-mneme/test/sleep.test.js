import test from "node:test";
import assert from "node:assert/strict";
import { createSleepScheduler, runSleep } from "../src/dream/sleep.js";
import { Config } from "../src/config.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";
import { parseReceipt } from "../src/dream.js";

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


// ------------------------------------------- issue #536 review: CodeRabbit 三条

// 把一条记忆的 created_at / updated_at 一起回拨。update 决策有 24h 保护期，
// 台账判据比的是 updated_at——两处都要动，只改一个会让用例互相干扰。
function backdate(store, id, hours) {
  const ts = new Date(Date.now() - hours * 3600000).toISOString();
  store.db.prepare("UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, id);
}

// 造一对向量完全相同的记忆（similarity = 1）。
function seedIdenticalPair(service, vectorIndex, dir, tag) {
  const a = makeMemory(service, `${tag}A`, `${tag} 内容A`, "project");
  const b = makeMemory(service, `${tag}B`, `${tag} 内容B`, "project");
  vectorIndex.saveEmbedding(a.id, dir);
  vectorIndex.saveEmbedding(b.id, dir);
  return { a, b };
}

test("issue#536 review ①: an already-judged pair must not eat a memory's pairing slot", async () => {
  const { service, store, vectorIndex } = setup();
  // a-b 相似度 1.0，a-c 与 b-c 都是 0.9：按相似度排序先去重的旧写法会先选中 a-b，
  // 再把 a-b 当"已审"丢掉，于是 a 的名额被一个注定被过滤的对占住，a-c 进不来。
  const a = makeMemory(service, "主题X", "内容A 关于主题X", "project");
  const b = makeMemory(service, "主题X副本", "内容B 关于主题X", "project");
  const c = makeMemory(service, "主题X变体", "内容C 关于主题X", "project");
  vectorIndex.saveEmbedding(a.id, [1, 0, 0]);
  vectorIndex.saveEmbedding(b.id, [1, 0, 0]);
  vectorIndex.saveEmbedding(c.id, [0.9, Math.sqrt(1 - 0.81), 0]);
  // a-b 已经判过（keep），且两侧此后都没动过 ⇒ 本轮不该再送。
  service.saveConflictReviewed({
    run_id: "seed",
    memory_a: a.id,
    memory_b: b.id,
    outcome: "keep",
    judged_at: new Date(Date.now() + 60000).toISOString()
  });

  const { ctx, calls } = countingCtx(() => "[]");
  const result = await runSleep(ctx, service, baseConfig(), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(calls(), 1, "台账预筛必须发生在去重之前，a 要能和 c 配对送出去");
  assert.equal(result.phases.conflicts.ledgerSkipped, 1, "被台账挡下的对数照实记");
  store.close();
});

test("issue#536 review ②: reflectionUpdateMaxPerRun stays a whole-run cap across batches", async () => {
  const { service, store, vectorIndex } = setup();
  // 两对向量正交，互不干扰 ⇒ 去重后正好两对，每批一对。
  const p1 = seedIdenticalPair(service, vectorIndex, [1, 0, 0], "甲");
  const p2 = seedIdenticalPair(service, vectorIndex, [0, 1, 0], "乙");
  for (const m of [p1.a, p1.b, p2.a, p2.b]) backdate(store, m.id, 48);

  // 每批都提一条 update：整轮上限 1，所以只有先跑的那批能落地。
  const { ctx, calls } = countingCtx((text) => {
    const id = text.includes(p1.a.id) ? p1.a.id : p2.a.id;
    const next = text.includes(p1.a.id) ? "甲 内容A（更新）" : "乙 内容A（更新）";
    return JSON.stringify([{ action: "update", ids: [id], content: next, reason: "内容有误" }]);
  });
  const config = baseConfig({ sleepConflictMaxPairs: 1, sleepConflictMaxPairsPerRun: 2, reflectionUpdateMaxPerRun: 1 });
  const result = await runSleep(ctx, service, config, ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(calls(), 2, "两对各自成批，都要送");
  const updated = [p1.a, p2.a].filter((m) => service.getById(m.id).content.endsWith("（更新）"));
  assert.equal(updated.length, 1, "update 是整轮上限，不是每批上限——只能落地一条");
  assert.equal(result.phases.conflicts.batches, 2);
  store.close();
});

test("issue#536 review ③: a decision that never landed must not be recorded as judged", async () => {
  const { service, store, vectorIndex } = setup();
  const { a } = seedConflictPair(service, vectorIndex, 1.0);
  // 提一条"不改任何字段"的 update：validateDecisions 会把它跳过（skipInvalid），
  // 该条决策没有落地。若照旧把整批送审对都写进台账，这一对就会被判成"已审"
  // 而永远不再送——沉默地永久压制一个真实冲突。
  const { ctx, calls } = countingCtx(() =>
    JSON.stringify([{ action: "update", ids: [a.id], content: "内容A 关于主题X" }])
  );
  const config = baseConfig({ reflectionUpdateMinAgeHours: 0 });
  const result = await runSleep(ctx, service, config, ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(calls(), 1, "这一对确实被送出去判过");
  assert.equal(service.listConflictReviewed().length, 0, "没落地的决策不能记成已审");
  assert.ok(result.phases.conflicts.skipped.length > 0, "跳过明细照常进审计");
  store.close();
});

test("issue#536 review ④: judged_at lives in the store's clock domain, not the wall clock", async () => {
  const { service, store, vectorIndex } = setup();
  const { a, b } = seedConflictPair(service, vectorIndex, 1.0);
  // 造一次「库里的单调时钟比墙钟快」——src/store.js 的 nowIso 在同一毫秒内的连续
  // 写入上逐次 +1ms，高频写入的库完全可能领先墙钟几毫秒（CI 的 test-host-legacy
  // 腿抓到过这次真 flake）。这里直接把两侧推到墙钟之后，等价于那个状态。
  const ahead = new Date(Date.now() + 5000).toISOString();
  for (const id of [a.id, b.id]) {
    store.db.prepare("UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?").run(ahead, ahead, id);
  }

  // 第一轮判 keep ⇒ 记台账。
  const first = await runSleep(mockCtx(() => "[]"), service, baseConfig(), { warn: () => {} }, { embedder, vectorIndex }, null);
  assert.equal(first.phases.conflicts.status, "noop");
  const ledger = service.listConflictReviewed();
  assert.equal(ledger.length, 1, "判 keep 要留一行");
  assert.ok(
    ledger[0].judged_at >= ahead,
    "judged_at 不能早于被测行自己的 updated_at（" + ledger[0].judged_at + " vs " + ahead + "）"
  );

  // 第二轮：两侧确实没动过 ⇒ 不许重送。若 judged_at 取了墙钟，这里会读成
  // 「判过之后又被改过」，判 keep 的死循环原样复活。
  const second = countingCtx(() => "[]");
  await runSleep(second.ctx, service, baseConfig(), second.ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(second.calls(), 0, "时钟领先墙钟时，已审的对仍然不许重送");
  store.close();
});

test("issue#536 review ⑤: a batch that throws does not take the rest of the run with it", async () => {
  const { service, store, vectorIndex } = setup();
  // 两对正交向量 ⇒ 两批。让**第一批**的 LLM 往返直接抛（不是返回错误：返回错误那条
  // 通路本来就有失败返回，早被前面的用例覆盖了）。要验的是：adjudicateBatch 内部
  // 任何未被兜住的异常，都只折损它自己那一批，后面的批次照跑、之前的汇总不丢。
  // applyDecisions 把 service.update 的异常吞进 failures（decisions.js:532-540），
  // 所以打桩 service 的方法测不到这条守卫，必须在 LLM 这一层抛。
  const p1 = seedIdenticalPair(service, vectorIndex, [1, 0, 0], "甲");
  const p2 = seedIdenticalPair(service, vectorIndex, [0, 1, 0], "乙");
  for (const m of [p1.a, p1.b, p2.a, p2.b]) backdate(store, m.id, 48);
  const { ctx, calls } = countingCtx((text) => {
    const id = text.includes(p1.a.id) ? p1.a.id : p2.a.id;
    const next = text.includes(p1.a.id) ? "甲 内容A（更新）" : "乙 内容A（更新）";
    return JSON.stringify([{ action: "update", ids: [id], content: next, reason: "内容有误" }]);
  });
  const realStream = ctx.llm.stream;
  let thrown = false;
  ctx.llm.stream = async function* (options) {
    if (!thrown && options.purpose === "sleep-conflict") {
      thrown = true;
      throw new Error("boom inside adjudicateBatch");
    }
    yield* realStream.call(this, options);
  };
  const config = baseConfig({ sleepConflictMaxPairs: 1, sleepConflictMaxPairsPerRun: 2, reflectionUpdateMaxPerRun: 2 });
  const result = await runSleep(ctx, service, config, ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(thrown, true, "第一批确实抛了，否则这条用例什么也没验");
  assert.equal(calls(), 1, "第一批抛错后第二批仍然要跑");
  assert.notEqual(result.phases.conflicts.status, "failed", "只要有一批活下来，就不是整轮 failed");
  // 抛的是第一批（哪个 pair 先送取决于排序，所以两条都问，只要求"恰好一条活下来"）：
  // 断言落在结果上，不落在顺序上，免得排序一变这条用例就假红。
  const landed = [p1.a, p2.a].filter((m) => service.getById(m.id).content.endsWith("（更新）"));
  assert.equal(landed.length, 1, "第二批照常落地，且只落地一批");
  assert.equal(result.phases.conflicts.batches, 2, "抛错的批次不吞掉轮次的形状");
  store.close();
});

// ------------------------------------------------------------ affective (#619)

// Only the affective phase gets a real answer; every other LLM phase says "[]"
// so this file keeps testing one thing at a time.
function affectiveCtx(payload) {
  return {
    logger: { warn: () => {}, info: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "affective-model" }) },
    llm: {
      async *stream(options) {
        const reply = options.purpose === "sleep-affective"
          ? JSON.stringify(payload)
          : "[]";
        yield { type: "text-delta", index: 0, text: reply };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
}

function affectiveConfig(overrides = {}) {
  return baseConfig({ sleepAffectiveEnabled: true, sleepPatternMinMemories: 10, ...overrides });
}

function linkSession(service, memoryId, sessionId) {
  service.saveMemoryProvenance({ memoryId, sessionId, seqStart: 1, seqEnd: 2, createdAt: new Date().toISOString() });
}

test("sleep: affective phase stays off unless explicitly enabled", async () => {
  const { service, store } = setup();
  service.createEntity({ name: "桉桉", type: "person" });
  service.createEntity({ name: "答辩", type: "concept" });
  makeMemory(service, "答辩前一晚", "答辩前一晚他很焦虑");
  const ctx = affectiveCtx([]);
  const result = await runSleep(ctx, service, baseConfig(), ctx.logger, { embedder, vectorIndex: null }, null);
  assert.equal(result.phases.affective.status, "skipped");
  assert.equal(result.phases.affective.reason, "disabled");
  store.close();
});

test("sleep: a one-session emotion lands as affective_context, and a trait claim is downgraded", async () => {
  // 这条是整个 #619 的主 claim：模型说这是「稳定特质」，但证据只覆盖一个会话
  // ⇒ 必须降级成场合边，绝不能铸出「他是焦虑的人」。
  const { service, store } = setup();
  const person = service.createEntity({ name: "桉桉", type: "person" });
  const target = service.createEntity({ name: "答辩", type: "concept" });
  const mem = makeMemory(service, "答辩前一天", "明天答辩，他很焦虑");
  linkSession(service, mem.id, "session-A");
  const ctx = affectiveCtx([
    { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "trait", evidence: [mem.id], why: "提到答辩就焦虑" }
  ]);
  const result = await runSleep(ctx, service, affectiveConfig(), ctx.logger, { embedder, vectorIndex: null }, null);
  const phase = result.phases.affective;
  assert.equal(phase.status, "ok");
  assert.equal(phase.downgraded, 1, "trait claim on one session must be counted as downgraded");
  assert.equal(phase.traits, 0, "no trait pattern minted");
  assert.equal(service.all().filter((m) => m.type === "pattern").length, 0, "nothing minted as a trait");
  const rels = service.getRelations(person.id).filter((r) => r.relation_type === "affective_context");
  assert.equal(rels.length, 1, "emotion landed as a relation instead");
  assert.equal(rels[0].to_entity, target.id);
  assert.equal(rels[0].source, "llm");
  assert.equal(rels[0].metadata.attribution, "occasion");
  assert.equal(rels[0].metadata.downgradedFrom, "trait");
  store.close();
});

test("sleep: an emotion backed by enough independent sessions mints a trait pattern", async () => {
  const { service, store } = setup();
  service.createEntity({ name: "桉桉", type: "person" });
  service.createEntity({ name: "答辩", type: "concept" });
  const ids = [];
  for (const session of ["s1", "s2", "s3"]) {
    const mem = makeMemory(service, `答辩-${session}`, `第 ${session} 次答辩前都失眠`);
    linkSession(service, mem.id, session);
    ids.push(mem.id);
  }
  const ctx = affectiveCtx([
    { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "trait", evidence: ids, why: "三次独立答辩前都这样" }
  ]);
  const result = await runSleep(ctx, service, affectiveConfig(), ctx.logger, { embedder, vectorIndex: null }, null);
  const phase = result.phases.affective;
  assert.equal(phase.downgraded, 0, "three independent sessions is a real trait");
  assert.equal(phase.traits, 1);
  assert.equal(phase.applied, 1, "trait went through applyDecisions");
  const patterns = service.all().filter((m) => m.type === "pattern");
  assert.equal(patterns.length, 1, "one trait pattern minted");
  assert.match(patterns[0].title, /稳定倾向/);
  assert.match(patterns[0].title, /答辩/, "标题必须带对象，否则人对什么焦虑都看不出来");
  assert.match(patterns[0].content, /3 个相互独立/);
  store.close();
});

test("sleep: two different targets mint two patterns instead of one swallowing the other", async () => {
  // #619 / Ephor 第 5 轮：标题原本不含 target，而 applyCreate 走
  // saveWithDedupe，按 (type, title) 找同题行。于是「对答辩长期焦虑」与
  // 「对面试长期焦虑」共用同一个标题，第二条被判为重复——不报错、不进
  // failures、applied 还如实显示写入了。一条真实结论就这样静默消失，
  // 正好落在本相位「降级不丢弃」这条原则的反面。
  const { service, store } = setup();
  service.createEntity({ name: "桉桉", type: "person" });
  service.createEntity({ name: "答辩", type: "concept" });
  service.createEntity({ name: "面试", type: "concept" });
  const ids = { 答辩: [], 面试: [] };
  for (const target of ["答辩", "面试"]) {
    for (const session of ["s1", "s2", "s3"]) {
      const mem = makeMemory(service, `${target}-${session}`, `第 ${session} 次${target}前都失眠`);
      linkSession(service, mem.id, `${target}-${session}`);
      ids[target].push(mem.id);
    }
  }
  const ctx = affectiveCtx([
    { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "trait", evidence: ids.答辩, why: "三次答辩前都这样" },
    { person: "桉桉", target: "面试", emotion: "焦虑", attribution: "trait", evidence: ids.面试, why: "三次面试前都这样" }
  ]);
  const result = await runSleep(ctx, service, affectiveConfig({ sleepMaxPatternPerRun: 2 }), ctx.logger, { embedder, vectorIndex: null }, null);
  const phase = result.phases.affective;
  assert.equal(phase.traits, 2, "两条 trait 候选");
  assert.equal(phase.failures.length, 0, "没有失败");
  assert.equal(phase.applied, 2, "两条都真的落库了");
  const patterns = service.all().filter((m) => m.type === "pattern");
  assert.equal(patterns.length, 2, "两个对象各一条，第二条不许被静默合并掉");
  const titles = patterns.map((m) => m.title).sort();
  assert.ok(titles.some((t) => t.includes("答辩")), "答辩那条在");
  assert.ok(titles.some((t) => t.includes("面试")), "面试那条也在 —— 这条以前会消失");
  assert.notEqual(titles[0], titles[1], "标题必须不同，否则去重键仍会撞");
  store.close();
});

test("sleep: an occasion edge is marked when the same emotion is later confirmed as a trait", async () => {
  // #619 / Ephor 第 5 轮 C：先有 occasion 边，后来证据够了判成 trait。
  // 边不改（它表示「这次场合观察到过」，这句仍然是真的），但要标上
  // promotedToTrait——否则同一件事实在图上是「一次性」、在 pattern 里是
  // 「长期」，读归因覆盖率的人拿到两份互相矛盾的记录，而这不会自愈。
  const { service, store } = setup();
  service.createEntity({ name: "桉桉", type: "person" });
  service.createEntity({ name: "答辩", type: "concept" });
  const mem0 = makeMemory(service, "答辩前一天", "明天答辩，他很焦虑");
  linkSession(service, mem0.id, "s0");
  const ctxOccasion = affectiveCtx([
    { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "occasion", evidence: [mem0.id] }
  ]);
  const first = await runSleep(ctxOccasion, service, affectiveConfig(), ctxOccasion.logger, { embedder, vectorIndex: null }, null);
  assert.equal(first.phases.affective.relations, 1, "先落一条 occasion 边");
  const ids = [];
  for (const session of ["s1", "s2", "s3"]) {
    const mem = makeMemory(service, `答辩-${session}`, `第 ${session} 次答辩前都失眠`);
    linkSession(service, mem.id, session);
    ids.push(mem.id);
  }
  const ctxTrait = affectiveCtx([
    { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "trait", evidence: ids, why: "三次独立答辩前都这样" }
  ]);
  const second = await runSleep(ctxTrait, service, affectiveConfig(), ctxTrait.logger, { embedder, vectorIndex: null }, null);
  assert.equal(second.phases.affective.traits, 1, "够格铸 trait");
  const person = service.findEntityByName("桉桉");
  const edges = service.getRelations(person.id).filter((r) => r.relation_type === "affective_context");
  assert.equal(edges.length, 1, "仍然是同一条边");
  assert.equal(edges[0].metadata.sessionCount, 1, "边的场合数不因后来升格而改写");
  assert.equal(edges[0].metadata.promotedToTrait, true, "但必须标上升格过，否则两份记录互相打脸");
  store.close();
});

test("sleep: unknown entities and fabricated evidence are reported in dropped, not silently discarded", async () => {
  const { service, store } = setup();
  service.createEntity({ name: "桉桉", type: "person" });
  service.createEntity({ name: "答辩", type: "concept" });
  const mem = makeMemory(service, "答辩前一天", "明天答辩，他很焦虑");
  linkSession(service, mem.id, "session-A");
  const ctx = affectiveCtx([
    { person: "不存在的人", target: "答辩", emotion: "焦虑", attribution: "occasion", evidence: [mem.id] },
    { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "occasion", evidence: ["fake-zzz"] },
    { person: "桉桉", target: "答辩", emotion: "", attribution: "occasion", evidence: [mem.id] }
  ]);
  const result = await runSleep(ctx, service, affectiveConfig(), ctx.logger, { embedder, vectorIndex: null }, null);
  const phase = result.phases.affective;
  assert.equal(phase.relations, 0, "nothing landed");
  assert.equal(phase.dropped.length, 3, "every rejection is accounted for");
  const reasons = phase.dropped.map((d) => d.reason).sort();
  assert.deepEqual(reasons, ["no emotion", "no real evidence", "unknown entity"]);
  store.close();
});

test("sleep: the affective phase never adds a related_to edge", async () => {
  // 变异自证的反面：如果情感边走的是 related_to（旧兜底行为），这条会挂。
  const { service, store } = setup();
  service.createEntity({ name: "桉桉", type: "person" });
  service.createEntity({ name: "答辩", type: "concept" });
  const mem = makeMemory(service, "答辩前一天", "明天答辩，他很焦虑");
  linkSession(service, mem.id, "session-A");
  const before = service.all().map((m) => m.id).length;
  const ctx = affectiveCtx([
    { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "occasion", evidence: [mem.id] }
  ]);
  await runSleep(ctx, service, affectiveConfig(), ctx.logger, { embedder, vectorIndex: null }, null);
  const person = service.findEntityByName("桉桉");
  const rels = service.getRelations(person.id);
  assert.equal(rels.filter((r) => r.relation_type === "related_to").length, 0, "no related_to smuggled in");
  assert.equal(rels.filter((r) => r.relation_type === "affective_context").length, 1);
  assert.equal(service.all().length, before, "no memory minted for a single-occasion emotion");
  store.close();
});

test("sleep: replaying the same segment merges into the existing edge instead of stacking", async () => {
  // #619 / Ephor 第 2 条：entity_relations 没有 UNIQUE，saveRelation 每次新插。
  // 探针拿同一批段反复回放时，重复边会把 sessionCount 抬高、主指标失真。
  // 而判重不能只「丢弃」：同一场合后来又看到更多证据时，那条边上的
  // sessionCount 会永远停在第一次，将来读归因覆盖率会一直读到 1。
  const { service, store } = setup();
  service.createEntity({ name: "桉桉", type: "person" });
  service.createEntity({ name: "答辩", type: "concept" });
  const mem = makeMemory(service, "答辩前一天", "明天答辩，他很焦虑");
  linkSession(service, mem.id, "session-A");
  const ctx = affectiveCtx([
    { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "occasion", evidence: [mem.id] }
  ]);
  const first = await runSleep(ctx, service, affectiveConfig(), ctx.logger, { embedder, vectorIndex: null }, null);
  assert.equal(first.phases.affective.relations, 1, "第一轮写了一条");
  const second = await runSleep(ctx, service, affectiveConfig(), ctx.logger, { embedder, vectorIndex: null }, null);
  assert.equal(second.phases.affective.relations, 0, "第二轮不再新插边");
  assert.ok(second.phases.affective.merged >= 1, "第二轮认出了同一场合，走合并而不是丢弃");
  const person = service.findEntityByName("桉桉");
  const edges = service.getRelations(person.id).filter((r) => r.relation_type === "affective_context");
  assert.equal(edges.length, 1, "库里仍只有一条边");
  assert.equal(edges[0].metadata.sessionCount, 1, "同一会话不会把场合数吹大");
  assert.deepEqual(edges[0].metadata.evidence, [mem.id], "证据不变");
  store.close();
});

test("sleep: two memories from one session merge into one edge, not two", async () => {
  // 同一会话里的两条记忆各说一句「他很焦虑」，证据天然不相交，但它们是
  // 同一个场合。按 evidence 交集判会各写一条，把边数与场合数一起吹大。
  const { service, store } = setup();
  service.createEntity({ name: "桉桉", type: "person" });
  service.createEntity({ name: "答辩", type: "concept" });
  const m1 = makeMemory(service, "答辩前一天", "明天答辩，他很焦虑");
  const m2 = makeMemory(service, "答辩前一晚", "越想越慌，睡不着");
  linkSession(service, m1.id, "session-A");
  linkSession(service, m2.id, "session-A");
  const ctx = affectiveCtx([
    { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "occasion", evidence: [m1.id] },
    { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "occasion", evidence: [m2.id] }
  ]);
  const result = await runSleep(ctx, service, affectiveConfig(), ctx.logger, { embedder, vectorIndex: null }, null);
  assert.equal(result.phases.affective.relations, 1, "同一会话只该有一条边");
  assert.ok(result.phases.affective.merged >= 1, "第二条按同场合合并进来");
  const person = service.findEntityByName("桉桉");
  const edges = service.getRelations(person.id).filter((r) => r.relation_type === "affective_context");
  assert.equal(edges.length, 1);
  assert.equal(edges[0].metadata.sessionCount, 1, "两条记忆都在同一会话，场合数仍是 1");
  assert.deepEqual([...edges[0].metadata.evidence].sort(), [m1.id, m2.id].sort(), "证据取并集");
  store.close();
});

test("sleep: a later occasion extends the existing edge instead of being dropped", async () => {
  // 第一轮 1 个会话写边，第二轮攒到 2 个会话（含新会话）。如果判成重复丢掉，
  // 边上的 sessionCount 会冻结在 1；将来用它算归因覆盖率就一直读到 1。
  const { service, store } = setup();
  service.createEntity({ name: "桉桉", type: "person" });
  service.createEntity({ name: "答辩", type: "concept" });
  const m1 = makeMemory(service, "答辩前一天", "明天答辩，他很焦虑");
  const m2 = makeMemory(service, "第二次答辩前", "又要答辩了，还是焦虑");
  linkSession(service, m1.id, "session-A");
  linkSession(service, m2.id, "session-B");
  const first = affectiveCtx([
    { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "occasion", evidence: [m1.id] }
  ]);
  const r1 = await runSleep(first, service, affectiveConfig(), first.logger, { embedder, vectorIndex: null }, null);
  assert.equal(r1.phases.affective.relations, 1);
  const second = affectiveCtx([
    { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "occasion", evidence: [m1.id, m2.id] }
  ]);
  const r2 = await runSleep(second, service, affectiveConfig(), second.logger, { embedder, vectorIndex: null }, null);
  assert.equal(r2.phases.affective.relations, 0, "不是新边");
  assert.ok(r2.phases.affective.merged >= 1, "是合并");
  const person = service.findEntityByName("桉桉");
  const edges = service.getRelations(person.id).filter((r) => r.relation_type === "affective_context");
  assert.equal(edges.length, 1);
  assert.equal(edges[0].metadata.sessionCount, 2, "场合数跟着证据涨到 2");
  assert.deepEqual([...edges[0].metadata.evidence].sort(), [m1.id, m2.id].sort());
  store.close();
});

test("sleep: reordering the evidence list does not smuggle in a second edge", async () => {
  // 判重键如果只看 evidence[0]，模型把 [m1, m2] 写成 [m2, m1] 就会再插一条。
  // LLM 给 evidence 的顺序本来就不稳定，parseJsonArray 也不排序——同一条边
  // 换个顺序就重复写，sessionCount 会被抬得比真实场合数高，正好毁掉主指标。
  const { service, store } = setup();
  service.createEntity({ name: "桉桉", type: "person" });
  service.createEntity({ name: "答辩", type: "concept" });
  const m1 = makeMemory(service, "答辩前一天", "明天答辩，他很焦虑");
  const m2 = makeMemory(service, "答辩前一晚", "越想越慌，睡不着");
  linkSession(service, m1.id, "session-A");
  linkSession(service, m2.id, "session-A");
  const forward = affectiveCtx([
    { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "occasion", evidence: [m1.id, m2.id] }
  ]);
  const first = await runSleep(forward, service, affectiveConfig(), forward.logger, { embedder, vectorIndex: null }, null);
  assert.equal(first.phases.affective.relations, 1, "第一轮写了一条");
  const reversed = affectiveCtx([
    { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "occasion", evidence: [m2.id, m1.id] }
  ]);
  const second = await runSleep(reversed, service, affectiveConfig(), reversed.logger, { embedder, vectorIndex: null }, null);
  assert.equal(second.phases.affective.relations, 0, "只换了证据顺序，不能再写一条");
  assert.ok(second.phases.affective.merged >= 1, "认成同一场合，走合并");
  const person = service.findEntityByName("桉桉");
  const edges = service.getRelations(person.id).filter((r) => r.relation_type === "affective_context");
  assert.equal(edges.length, 1, "库里仍只有一条边");
  assert.equal(edges[0].metadata.sessionCount, 1, "同一会话，场合数仍是 1");
  assert.deepEqual([...edges[0].metadata.evidence].sort(), [m1.id, m2.id].sort(), "并集后证据不多不少");
  store.close();
});

test("sleep: two emotions in the same memory are two edges, not a duplicate", async () => {
  // 判重键如果不带情绪，「答辩前又焦虑又期待」里的第二条会被当成重复丢掉，
  // dropped 里还写着 duplicate edge——读起来像「本来就重复」，实际是丢了一条
  // 真信息。本相位的承诺是降级不丢弃，重复和丢弃不能混成一个理由。
  const { service, store } = setup();
  service.createEntity({ name: "桉桉", type: "person" });
  service.createEntity({ name: "答辩", type: "concept" });
  const mem = makeMemory(service, "答辩前一天", "明天答辩，他又焦虑又有点期待");
  linkSession(service, mem.id, "session-A");
  const ctx = affectiveCtx([
    { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "occasion", evidence: [mem.id] },
    { person: "桉桉", target: "答辩", emotion: "期待", attribution: "occasion", evidence: [mem.id] }
  ]);
  const result = await runSleep(ctx, service, affectiveConfig(), ctx.logger, { embedder, vectorIndex: null }, null);
  assert.equal(result.phases.affective.relations, 2, "两种情绪各写一条");
  assert.equal(result.phases.affective.dropped.filter((d) => d.reason === "duplicate edge").length, 0, "不许把第二种情绪当重复");
  const person = service.findEntityByName("桉桉");
  const edges = service.getRelations(person.id).filter((r) => r.relation_type === "affective_context");
  assert.deepEqual(edges.map((r) => r.metadata.emotion).sort(), ["期待", "焦虑"], "两条边各带自己的情绪词");
  store.close();
});

test("sleep: an edge write shows up in the receipt instead of reading as zero", async () => {
  // #619 / Ephor: receipt 的倒数第二位是 applied，而 affective 相位写边走
  // saveRelation、不进 applied。不改的话，一轮明明写了边，审计行却是 `:0`——
  // 「跑了但什么都没做」，探针会把有写入的轮次记成空轮。
  const { service, store } = setup();
  service.createEntity({ name: "桉桉", type: "person" });
  service.createEntity({ name: "答辩", type: "concept" });
  const mem = makeMemory(service, "答辩前一天", "明天答辩，他很焦虑");
  linkSession(service, mem.id, "session-A");
  const ctx = affectiveCtx([
    { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "occasion", evidence: [mem.id] }
  ]);
  const result = await runSleep(ctx, service, affectiveConfig(), ctx.logger, { embedder, vectorIndex: null }, null);
  assert.equal(result.phases.affective.relations, 1, "恰好一条边落地，否则这条用例没在验东西");
  assert.equal(result.phases.affective.applied, 0, "边不是 decision，applied 仍是 0");
  const parts = result.receipt.split(":");
  assert.equal(parts.length, 8, "receipt 仍是八段");
  // 段序：dsh-mneme / run / runId / status / snapshotHash / inputCount / applied / summaryFlag
  assert.equal(parts[6], "1", "写入计数必须非零，读成 0 等于谎报本轮没做过事");
  store.close();
});

test("sleep: a merge-only run also shows up in the receipt", async () => {
  // #619 / Ephor 第 4 轮：只合并的那一轮 relations 与 edgeWrites 都是 0，
  // 但它确实改了库（证据并集、sessionCount 重算）。receipt 若读成 `:0`，
  // 就是上一处修过的同一个谎——只是换了个形状。合并也算写。
  const { service, store } = setup();
  service.createEntity({ name: "桉桉", type: "person" });
  service.createEntity({ name: "答辩", type: "concept" });
  const mem = makeMemory(service, "答辩前一天", "明天答辩，他很焦虑");
  linkSession(service, mem.id, "session-A");
  const ctx = affectiveCtx([
    { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "occasion", evidence: [mem.id] }
  ]);
  const first = await runSleep(ctx, service, affectiveConfig(), ctx.logger, { embedder, vectorIndex: null }, null);
  assert.equal(first.receipt.split(":")[6], "1", "第一轮新写边，计数 1");
  const second = await runSleep(ctx, service, affectiveConfig(), ctx.logger, { embedder, vectorIndex: null }, null);
  assert.equal(second.phases.affective.relations, 0, "第二轮没有新边");
  assert.equal(second.phases.affective.edgeWrites, 0, "第二轮没有新写");
  assert.equal(second.phases.affective.merged, 1, "第二轮走的是合并");
  assert.equal(second.phases.affective.status, "ok", "合并过就是 ok，不是 noop");
  const parts = second.receipt.split(":");
  assert.equal(parts.length, 8, "receipt 仍是八段");
  assert.equal(parts[6], "1", "只合并的一轮同样改了库，必须非零");
  store.close();
});

test("sleep: an aborted affective phase reports aborted, not ok", async () => {
  // 中途被打断且已经写了边，既不能报 ok（没跑完），也不能报 noop（确实写了）。
  const { service, store } = setup();
  service.createEntity({ name: "桉桉", type: "person" });
  service.createEntity({ name: "答辩", type: "concept" });
  const mem = makeMemory(service, "答辩前一天", "明天答辩，他很焦虑");
  linkSession(service, mem.id, "session-A");
  const controller = new AbortController();
  const ctx = affectiveCtx([
    { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "occasion", evidence: [mem.id] }
  ]);
  const realStream = ctx.llm.stream;
  ctx.llm.stream = async function* (options) {
    yield* realStream.call(this, options);
    // 模型答完、写边之前用户回到电脑前
    if (options.purpose === "sleep-affective") controller.abort();
  };
  const result = await runSleep(ctx, service, affectiveConfig(), ctx.logger, { embedder, vectorIndex: null }, controller.signal);
  const phase = result.phases.affective;
  assert.equal(phase.status, "aborted", "打断不是 ok");
  assert.equal(phase.reason, "user activity");
  assert.ok(phase.edgeWrites >= 0, "打断也把已写的条数报出来");
  // 明细字段在每条返回路径上都得在。只有正常的返回带 mergedList 的话，
  // 消费方在 aborted/failed 两条路径上读明细会静默拿到 undefined，不报错。
  assert.ok(Array.isArray(phase.mergedList), "aborted 分支也要带 mergedList，缺了是静默失明");
  store.close();
});

test("sleep: a trait that clears the threshold mints exactly one pattern and counts it", async () => {
  // 这条与上一条配对：同样的三会话证据，上一条说「够格就铸」，这条看「铸了几个、
  // 计数是否如实」。Ephor 第 4 条的 `if (ok)` 缺 else 已补成 failed 分支，但那条
  // 分支在合法决策下不可达（决策是我们按合法形状拼的），不写假用例假装测过它。
  const { service, store } = setup();
  service.createEntity({ name: "桉桉", type: "person" });
  service.createEntity({ name: "答辩", type: "concept" });
  const ids = [];
  for (const session of ["s1", "s2", "s3"]) {
    const mem = makeMemory(service, `答辩-${session}`, `第 ${session} 次答辩前都失眠`);
    linkSession(service, mem.id, session);
    ids.push(mem.id);
  }
  const ctx = affectiveCtx([
    { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "trait", evidence: ids, why: "三次都一样" }
  ]);
  const result = await runSleep(ctx, service, affectiveConfig({ sleepMaxPatternPerRun: 1 }), ctx.logger, { embedder, vectorIndex: null }, null);
  const phase = result.phases.affective;
  assert.equal(phase.status, "ok");
  assert.equal(phase.traits, 1, "识别出一个 trait");
  assert.equal(phase.applied, 1, "它真的被铸出来了");
  store.close();
});

test("sleep: replaying the same trait rewrites the pattern instead of growing it", async () => {
  // #619 / Ephor 第 6 轮：trait 标题由模板拼成，同一 (人, 对象, 情绪) 天然同题。
  // applyCreate 走 saveWithDedupe，命中同题活跃行时默认 appendContent——把同一段
  // 结论再粘一遍。pattern 是注入面消费的东西，重放三轮正文就从 161 字涨到 549 字，
  // 还带一串重复的 [证据: …] 尾巴。修法：pattern 走 `_overwrite`，原地刷新。
  const { service, store } = setup();
  service.createEntity({ name: "桉桉", type: "person" });
  service.createEntity({ name: "答辩", type: "concept" });
  const ids = [];
  for (const session of ["s1", "s2", "s3"]) {
    const mem = makeMemory(service, `答辩-${session}`, `第 ${session} 次答辩前都失眠`);
    linkSession(service, mem.id, session);
    ids.push(mem.id);
  }
  const payload = (ctx) => ctx;
  const lengths = [];
  for (let round = 0; round < 3; round += 1) {
    const ctx = affectiveCtx([
      { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "trait", evidence: ids, why: "三次都一样" }
    ]);
    void payload(ctx);
    await runSleep(ctx, service, affectiveConfig({ sleepMaxPatternPerRun: 1 }), ctx.logger, { embedder, vectorIndex: null }, null);
    const patterns = service.all().filter((m) => m.type === "pattern");
    assert.equal(patterns.length, 1, `round ${round}: 仍然只有一行 pattern`);
    lengths.push(patterns[0].content.length);
  }
  assert.equal(lengths[1], lengths[0], "第二轮不许把正文再粘一遍");
  assert.equal(lengths[2], lengths[0], "第三轮同样");
  const pattern = service.all().find((m) => m.type === "pattern");
  assert.ok(!pattern.content.includes("---"), "没有 appendContent 的分隔符");
  assert.equal((pattern.content.match(/\[证据/g) ?? []).length, 1, "证据尾巴只有一条");
  store.close();
});

test("sleep: a refresh-only trait run reports refreshed, not ok with zero mints", async () => {
  // 同一批证据重放：第二轮没铸新行，只是把既有 pattern 原地刷新。这时若报
  // status:"ok" + applied:0，读审计的人会以为「说明这一轮没东西」，而实际上是
  // 一次真实写入；若报 noop，又等于说整池看过了什么都没有。给它自己的名字。
  const { service, store } = setup();
  service.createEntity({ name: "桉桉", type: "person" });
  service.createEntity({ name: "答辩", type: "concept" });
  const ids = [];
  for (const session of ["s1", "s2", "s3"]) {
    const mem = makeMemory(service, `答辩-${session}`, `第 ${session} 次答辩前都失眠`);
    linkSession(service, mem.id, session);
    ids.push(mem.id);
  }
  const payload = [
    { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "trait", evidence: ids, why: "三次都一样" }
  ];
  const first = await (async () => {
    const ctx = affectiveCtx(payload);
    return runSleep(ctx, service, affectiveConfig({ sleepMaxPatternPerRun: 1 }), ctx.logger, { embedder, vectorIndex: null }, null);
  })();
  assert.equal(first.phases.affective.status, "ok", "第一轮真的铸了");
  assert.equal(first.phases.affective.applied, 1);
  const second = await (async () => {
    const ctx = affectiveCtx(payload);
    return runSleep(ctx, service, affectiveConfig({ sleepMaxPatternPerRun: 1 }), ctx.logger, { embedder, vectorIndex: null }, null);
  })();
  const phase = second.phases.affective;
  assert.equal(phase.applied, 0, "第二轮没有新铸");
  assert.equal(phase.refreshedTraits, 1, "刷新了一条");
  assert.equal(phase.status, "refreshed", "刷新不是 noop，也不是一次新铸");
  assert.equal(second.status, "ok", "整轮仍算有产出");
  // #619 / Ephor 第七轮 ①：相位说「改了」，整轮 receipt 也必须说「改了」。此前
  // totalApplied 只加 applied + edgeWrites + merged，refreshedTraits 不在表里，
  // 于是这一轮 receipt 第 7 段是 0——「改了库读成 0」，正是上一轮刚修掉的形态。
  const parsed = parseReceipt(second.receipt);
  assert.ok(parsed, `receipt 必须可解析（实测 ${second.receipt}）`);
  assert.equal(parsed.applied, 1, "刷新一条要算一次真实写入，不能被读成 0");
  // ③ 同一个场景：刷新不是出生，不该再往 memory_mints 添一行。
  const pattern = service.all().find((m) => m.type === "pattern");
  assert.equal(store.mintsFor(pattern.id).length, 1, "两轮下来只有一条出生记录");
  store.close();
});

test("sleep: the affective prompt does not corrupt JSON while filling the threshold", async () => {
  // 占位符原来是一个裸的 `N`，而 prompt 正文里还写着「只输出 JSON 数组」。
  // replaceAll("N", …) 于是把 JSON 换成了 JSO3——模型收到的是「只输出 JSO3 数组」，
  // 而这一相位的唯一出口就是那个数组。这不是理论风险：zh 与 en 两版都中。
  const { service, store } = setup();
  service.createEntity({ name: "桉桉", type: "person" });
  service.createEntity({ name: "答辩", type: "concept" });
  makeMemory(service, "答辩前一晚", "答辩前一晚他很焦虑");
  const seen = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "affective-model" }) },
    llm: {
      async *stream(options) {
        if (options.purpose === "sleep-affective") {
          const system = options.messages.find((m) => m.role === "system")?.content?.[0]?.text ?? "";
          seen.push(system);
        }
        yield { type: "text-delta", index: 0, text: "[]" };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
  await runSleep(ctx, service, affectiveConfig(), ctx.logger, { embedder, vectorIndex: null }, null);
  assert.equal(seen.length, 1, "情感相位确实调了一次模型");
  const system = seen[0];
  assert.ok(!system.includes("JSO3"), `prompt 里的 JSON 被阈值替换吃掉了：${system.slice(0, 200)}`);
  assert.ok(system.includes("JSON"), "「只输出 JSON 数组」这句必须原样到达模型");
  assert.ok(!system.includes("{{MIN_SESSIONS}}"), "占位符必须被填掉，不能把字面量发给模型");
  assert.ok(system.includes("3"), "阈值默认 3 要出现在 prompt 里");
  store.close();
});

test("sleep: evidence without provenance still counts as the same occasion", async () => {
  // memory_save 写下的记忆没有 provenance，sessionsFor 返回空集。纯会话判据在
  // 这种情况下永远判不出「同一场合」，同一批证据会在每一轮 sleep 里再写一条边，
  // 把 sessionCount 抬得比真实场合数高。落不着会话键时退回 evidence 交集。
  const { service, store } = setup();
  const person = service.createEntity({ name: "桉桉", type: "person" });
  const target = service.createEntity({ name: "答辩", type: "concept" });
  const mem = makeMemory(service, "答辩前一晚", "答辩前一晚他很焦虑");
  const payload = [
    { person: "桉桉", target: "答辩", emotion: "焦虑", attribution: "occasion", evidence: [mem.id], why: "就这一次" }
  ];
  const run = () => {
    const ctx = affectiveCtx(payload);
    return runSleep(ctx, service, affectiveConfig(), ctx.logger, { embedder, vectorIndex: null }, null);
  };
  const first = await run();
  assert.equal(first.phases.affective.relations, 1, "第一轮写了一条边");
  const second = await run();
  assert.equal(second.phases.affective.relations, 0, "第二轮不许再写一条");
  assert.equal(second.phases.affective.merged, 1, "认成同一场合，合并进既有边");
  const rels = service.getRelations(person.id).filter((r) => r.relation_type === "affective_context");
  assert.equal(rels.length, 1, "库里仍只有一条");
  assert.equal(rels[0].to_entity, target.id);
  store.close();
});

test("sleep: trait candidates pushed out by the cap are recorded as dropped", async () => {
  // traits.slice(0, maxTraits) 把超出的候选截掉，它们既不铸、也不降级、也不进
  // dropped，而 traits 仍把它们算进候选数——读者会以为都处理过了。与边的
  // `relation cap` 同一口径记一笔。
  const { service, store } = setup();
  service.createEntity({ name: "桉桉", type: "person" });
  const payload = [];
  for (const [i, target] of ["答辩", "面试", "汇报", "截止日期"].entries()) {
    service.createEntity({ name: target, type: "concept" });
    const ids = [];
    for (const session of ["s1", "s2", "s3"]) {
      const mem = makeMemory(service, `${target}-${session}-${i}`, `第 ${session} 次${target}前都失眠`);
      linkSession(service, mem.id, `${target}-${session}`);
      ids.push(mem.id);
    }
    payload.push({ person: "桉桉", target, emotion: "焦虑", attribution: "trait", evidence: ids, why: `三次${target}前都这样` });
  }
  const ctx = affectiveCtx(payload);
  const result = await runSleep(ctx, service, affectiveConfig({ sleepMaxPatternPerRun: 2, sleepPatternMinMemories: 20 }), ctx.logger, { embedder, vectorIndex: null }, null);
  const phase = result.phases.affective;
  assert.equal(phase.traits, 4, "四条 trait 候选都被识别出来");
  assert.equal(phase.applied, 2, "上限内两条落库");
  const capped = phase.dropped.filter((d) => d.reason === "trait cap");
  assert.equal(capped.length, 2, "被上限截掉的两条必须记账，不能静默消失");
  assert.ok(capped.every((d) => typeof d.target === "string" && d.target), "每条都要能看出是哪条结论被截");
  store.close();
});
