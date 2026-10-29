// Regression for issue #9, extended by issue #135 (建议 3/4/5):
//  - B: dreamMaxTokens cap widened (min 256, max 131072) so large memory
//    libraries no longer starve the consolidation output. #135 raises the
//    DEFAULT to 131072 too — 32768 was exactly what thinking-model reasoning
//    burnt, leaving an empty body.
//  - A: dreamReasoningEffort / sleepReasoningEffort pass-through. Explicit
//    'none' omits the reasoningEffort field entirely (provider default
//    applies); low/medium/high are forwarded verbatim on every dream /
//    sleep LLM call. #135: UNSET now resolves to the LOWEST effort the model
//    declares (the old default 'none' let the harness substitute the model's
//    defaultEffort, burning the budget on reasoning). Asserted by capturing
//    the options each llm.stream() sees.
import test from "node:test";
import assert from "node:assert/strict";
import { Config } from "../src/config.js";
import { createDreamScheduler, parseReceipt } from "../src/dream.js";
import { runSleep } from "../src/dream/sleep.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";
import { createEntityStreamAdapter } from "../src/index.js";

const embedder = {
  embedSingle: async () => [1, 0, 0],
  embed: async () => [1, 0, 0],
  schedule: () => {},
  modelHash: "mock#1",
  dimension: 3
};

// ---------------------------------------------------------------- config schema

test("issue#135: dreamMaxTokens defaults to 131072 and accepts values up to 131072", () => {
  assert.equal(Config({}).dreamMaxTokens, 131072, "old default 32768 was exactly what thinking-model reasoning burnt (Issue #135 建议 3)");
  assert.equal(Config({ dreamMaxTokens: 131072 }).dreamMaxTokens, 131072, "upper bound accepted");
  assert.equal(Config({ dreamMaxTokens: 65536 }).dreamMaxTokens, 65536, "intermediate value accepted");
});

test("issue#9: dreamMaxTokens clamps to [256, 131072], out-of-range values are rejected", () => {
  assert.equal(Config({ dreamMaxTokens: 256 }).dreamMaxTokens, 256, "lower bound accepted");
  assert.equal(Config({ dreamMaxTokens: 100000 }).dreamMaxTokens, 100000, "raised default tier accepted");
  assert.throws(() => Config({ dreamMaxTokens: 255 }), "below min rejected");
  assert.throws(() => Config({ dreamMaxTokens: 131073 }), "above max rejected");
  assert.throws(() => Config({ dreamMaxTokens: 0 }), "zero rejected");
});

test("issue#135: reasoningEffort unset = undefined (auto-lowest at resolve time); explicit values preserved", () => {
  const cfg = Config({});
  assert.equal(cfg.dreamReasoningEffort, undefined, "unset must be distinguishable from explicit 'none'");
  assert.equal(cfg.sleepReasoningEffort, undefined);
  // issue #315: the distill knob defaults to 'none' (entity-extraction shape,
  // no auto-lowest resolution — distill keeps its current behavior until the
  // user opts in).
  assert.equal(cfg.summarizeReasoningEffort, "none", "distill effort defaults to 'none'");
  assert.equal(Config({ summarizeReasoningEffort: "off" }).summarizeReasoningEffort, "off");
  assert.equal(Config({ dreamReasoningEffort: "none" }).dreamReasoningEffort, "none", "explicit 'none' kept");
  assert.equal(Config({ dreamReasoningEffort: "off" }).dreamReasoningEffort, "off", "'off' now a valid explicit choice");
  assert.equal(Config({ sleepReasoningEffort: "medium" }).sleepReasoningEffort, "medium");
  assert.throws(() => Config({ dreamReasoningEffort: "bogus" }), "invalid effort rejected");
  assert.throws(() => Config({ sleepReasoningEffort: "ultra" }), "invalid effort rejected");
  assert.throws(() => Config({ summarizeReasoningEffort: "max" }), "invalid distill effort rejected");
});

// ---------------------------------------------------------------- dream passthrough

/** dream ctx that records every llm.stream() call's options for inspection. */
function dreamCtx({ onConsolidation, summaryText = "记忆库总览：用户偏好中文。", captured = [] } = {}) {
  return {
    logger: { warn: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock-model" }) },
    llm: {
      async *stream(options) {
        captured.push(options);
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        if (userText.includes("| type=")) {
          yield { type: "text-delta", index: 0, text: onConsolidation ? onConsolidation(userText, options.purpose) : "[]" };
        } else {
          yield { type: "text-delta", index: 0, text: summaryText };
        }
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
}

test("issue#135: dream omits reasoningEffort when unset without a capability API and still consolidates (applied>0)", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const captured = [];
  const ctx = dreamCtx({
    captured,
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "插件总览", content: "合并内容", importance: 4 }
    ])
  });
  const result = await dream.runDream(ctx, service, {});
  assert.equal(result.ok, true);
  assert.ok(result.applied > 0, "end-to-end dream run still lands changes");
  assert.equal(captured.length, 2, "consolidation + summary both hit the LLM");
  for (const options of captured) {
    assert.equal("reasoningEffort" in options, false, `unset without capability API must not forward reasoningEffort (${options.purpose})`);
  }
  store.close();
});

test("issue#135: unset effort resolves to the LOWEST supported effort, never the poison default", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const captured = [];
  const ctx = dreamCtx({
    captured,
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "插件总览", content: "合并内容", importance: 4 }
    ])
  });
  // v4-flash 系能力报告：声明 off/low/high/max、defaultEffort=high。旧默认
  // （省略字段）让 harness 顶上 high → 推理烧光预算返回空体；现在未配置应
  // 自动取最低档 off，而不是服务商默认。
  ctx.llm.resolveModelInfo = async (provider, model) => ({
    provider,
    model,
    reasoning: { efforts: [{ id: "high" }, { id: "off" }, { id: "low" }, { id: "max" }], defaultEffort: "high" }
  });
  const result = await dream.runDream(ctx, service, {});
  assert.equal(result.ok, true);
  assert.ok(result.applied > 0, "consolidation lands changes");
  assert.equal(captured.length, 2, "consolidation + summary both hit the LLM");
  for (const options of captured) {
    assert.equal(options.reasoningEffort, "off", `unset resolves to the lowest declared effort on ${options.purpose}`);
  }
  store.close();
});

test("issue#135: explicit 'none' still omits the field even when the capability API is available", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const captured = [];
  const ctx = dreamCtx({
    captured,
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "插件总览", content: "合并内容", importance: 4 }
    ])
  });
  ctx.llm.resolveModelInfo = async (provider, model) => ({
    provider,
    model,
    reasoning: { efforts: [{ id: "off" }, { id: "low" }], defaultEffort: "high" }
  });
  const result = await dream.runDream(ctx, service, { dreamReasoningEffort: "none" });
  assert.equal(result.ok, true);
  for (const options of captured) {
    assert.equal("reasoningEffort" in options, false, `explicit 'none' is a user decision to omit (${options.purpose})`);
  }
  store.close();
});

test("issue#9: dream forwards dreamReasoningEffort on both LLM calls", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const captured = [];
  const ctx = dreamCtx({
    captured,
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "插件总览", content: "合并内容", importance: 4 }
    ])
  });
  const result = await dream.runDream(ctx, service, { dreamReasoningEffort: "high" });
  assert.equal(result.ok, true);
  assert.equal(captured.length, 2);
  for (const options of captured) {
    assert.equal(options.reasoningEffort, "high", `reasoningEffort forwarded on ${options.purpose}`);
  }
  store.close();
});

test("issue#9: dreamMaxTokens is forwarded as maxTokens on consolidation and summary calls", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const captured = [];
  const ctx = dreamCtx({
    captured,
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "插件总览", content: "合并内容", importance: 4 }
    ])
  });
  const result = await dream.runDream(ctx, service, { dreamMaxTokens: 100000 });
  assert.equal(result.ok, true);
  assert.equal(captured.length, 2, "consolidation + summary both hit the LLM");
  for (const options of captured) {
    assert.equal(options.maxTokens, 100000, `raised budget forwarded on ${options.purpose}`);
  }
  store.close();
});

test("issue#9: thinking-model empty body (no text emitted, budget burnt on reasoning) fails as no json array", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const ctx = dreamCtx({ onConsolidation: () => "" }); // 思考型模型把预算烧光 → 无正文
  const result = await dream.runDream(ctx, service, { dreamMaxTokens: 32768 });
  assert.equal(result.ok, false, "empty body is a hard failure, never faked ok");
  assert.match(result.error, /no json array/);
  const run = store.listDreamRuns()[0];
  assert.equal(run.status, "failed", "audit row records failed");
  assert.match(run.error, /no json array/, "audit error_message carries the empty-body cause");
  assert.equal(parseReceipt(run.receipt).status, "failed", "receipt records failed");
  store.close();
});

test("legal empty decision list [] is a no-op success, not a failure", async () => {
  // 真实模型在记忆无冗余时合法输出 []（CONSOLIDATION_PROMPT 允许"无问题无需输出"），
  // 此前被 validateDecisions 判 failed → 审计表反复失败。现在应 ok:true、applied 0、
  // 审计记 ok，且 summary 照常产出。
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  service.saveWithDedupe({ type: "project", title: "插件", content: "内容", importance: 3 });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const ctx = dreamCtx({ onConsolidation: () => "[]" }); // 模型：无需合并
  const result = await dream.runDream(ctx, service, { dreamMaxTokens: 32768 });
  assert.equal(result.ok, true, "empty [] is a valid no-op, never failed");
  assert.equal(result.applied, 0, "no decisions to apply");
  assert.equal(result.summary, true, "summary still produced");
  const run = store.listDreamRuns()[0];
  assert.equal(run.status, "ok", "audit row records ok, not failed");
  assert.equal(parseReceipt(run.receipt).status, "ok", "receipt records ok");
  store.close();
});

test("issue#25: dreamProvider/dreamModel config wins over the agentDefaultModel route", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const captured = [];
  const ctx = dreamCtx({
    captured,
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "插件总览", content: "合并内容", importance: 4 }
    ])
  });
  // dreamCtx's agentDefaultModel resolves (mock:mock-model), but the explicit
  // config route must win — otherwise dreamProvider/dreamModel is dead code in
  // a standard DSH install and the dream can never be moved off a thinking model.
  const result = await dream.runDream(ctx, service, { dreamProvider: "volcano", dreamModel: "deepseek-v3" });
  assert.equal(result.ok, true);
  assert.ok(captured.length >= 2, "consolidation + summary both hit the LLM");
  for (const options of captured) {
    assert.equal(options.provider, "volcano");
    assert.equal(options.model, "deepseek-v3", "config route wins over agentDefaultModel (mock:mock-model)");
  }
  store.close();
});

test("issue#9: rejected reasoningEffort retries once without it and still consolidates", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const calls = [];
  const ctx = {
    logger: { warn: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock-model" }) },
    llm: {
      async *stream(options) {
        calls.push(options);
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        if (userText.includes("| type=")) {
          // First attempt forwards reasoningEffort: the provider rejects it.
          if (options.reasoningEffort) {
            throw new Error("UNSUPPORTED_REASONING_EFFORT: DeepSeek does not support reasoning effort \"low\"");
          }
          yield { type: "text-delta", index: 0, text: JSON.stringify([
            { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "合并标题", content: "合并内容", importance: 4 }
          ]) };
        } else {
          yield { type: "text-delta", index: 0, text: "记忆库总览：用户偏好中文。" };
        }
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
  const result = await dream.runDream(ctx, service, { dreamReasoningEffort: "low" });
  assert.equal(result.ok, true, "run survives the effort rejection via the fallback retry");
  assert.ok(result.applied > 0, "consolidation still lands changes");
  assert.equal(calls.length, 3, "consolidation tried (rejected) + retried without effort + summary");
  assert.equal(calls[0].reasoningEffort, "low", "first consolidation attempt forwards the effort");
  assert.equal("reasoningEffort" in calls[1], false, "retry omits the rejected effort field");
  store.close();
});

// ---------------------------------------------------------------- sleep passthrough

function sleepSetup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const vectorIndex = createVectorIndex({ store });
  service.setEmbedder(embedder);
  service.setVectorIndex(vectorIndex);
  return { store, service, vectorIndex };
}

function baseConfig(overrides = {}) {
  return {
    sleepModeEnabled: true,
    sleepIdleMinutes: 5,
    sleepMinIntervalHours: 8,
    sleepConflictStrictness: "normal",
    sleepArchiveDays: 30,
    sleepCompressDays: 90,
    sleepPatternMinMemories: 10,
    sleepMaxPatternPerRun: 3,
    ...overrides
  };
}

/** sleep ctx that records every llm.stream() call's options. */
function sleepCtx(onConsolidation, selection = { provider: "mock", model: "sleep-model" }, captured = []) {
  return {
    logger: { warn: () => {}, info: () => {} },
    agentDefaultModel: { currentSelection: () => selection },
    llm: {
      async *stream(options) {
        captured.push(options);
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        yield { type: "text-delta", index: 0, text: onConsolidation ? onConsolidation(userText, options.purpose) : "[]" };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
}

test("issue#9: sleep forwards sleepReasoningEffort on its LLM passes", async () => {
  const { store, service, vectorIndex } = sleepSetup();
  const a = service.saveWithDedupe({ type: "project", title: "主题X", content: "内容A 关于主题X", importance: 3 }).memory;
  const b = service.saveWithDedupe({ type: "project", title: "主题X副本", content: "内容B 关于主题X", importance: 3 }).memory;
  vectorIndex.saveEmbedding(a.id, [1, 0, 0]);
  vectorIndex.saveEmbedding(b.id, [1, 0, 0]);
  const captured = [];
  const ctx = sleepCtx(
    (userText, purpose) => purpose === "sleep-conflict"
      ? JSON.stringify([{ action: "conflict", winner: a.id, loser: b.id, reason: "重复覆盖" }])
      : "[]",
    { provider: "mock", model: "sleep-model" },
    captured
  );
  const result = await runSleep(ctx, service, baseConfig({ sleepReasoningEffort: "medium" }), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.status, "ok");
  assert.ok(captured.length >= 2, "conflict + pattern passes both hit the LLM");
  for (const options of captured) {
    assert.equal(options.reasoningEffort, "medium", `reasoningEffort forwarded on ${options.purpose}`);
  }
  store.close();
});

test("issue#135: sleep unset effort also resolves to the lowest supported", async () => {
  const { store, service, vectorIndex } = sleepSetup();
  const a = service.saveWithDedupe({ type: "project", title: "主题X", content: "内容A 关于主题X", importance: 3 }).memory;
  const b = service.saveWithDedupe({ type: "project", title: "主题X副本", content: "内容B 关于主题X", importance: 3 }).memory;
  vectorIndex.saveEmbedding(a.id, [1, 0, 0]);
  vectorIndex.saveEmbedding(b.id, [1, 0, 0]);
  const captured = [];
  const ctx = sleepCtx(
    (userText, purpose) => purpose === "sleep-conflict"
      ? JSON.stringify([{ action: "conflict", winner: a.id, loser: b.id, reason: "重复覆盖" }])
      : "[]",
    { provider: "mock", model: "sleep-model" },
    captured
  );
  ctx.llm.resolveModelInfo = async (provider, model) => ({
    provider,
    model,
    reasoning: { efforts: [{ id: "low" }, { id: "high" }], defaultEffort: "high" }
  });
  const result = await runSleep(ctx, service, baseConfig(), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.status, "ok");
  assert.ok(captured.length >= 2, "conflict + pattern passes both hit the LLM");
  for (const options of captured) {
    assert.equal(options.reasoningEffort, "low", `unset sleep effort resolves to the lowest declared (${options.purpose})`);
  }
  store.close();
});

// ------------------------------------------------------------------ stream-level rejection
// dsh-llm rc.1 converts adapter-stage failures (including the provider's
// UNSUPPORTED_REASONING_EFFORT throw from resolveCallWithInfo) into a terminal
// error finish chunk inside adapterStream — the rejection NEVER reaches our
// catch. The v0.7.16 throw-based fallback was therefore dead code for the
// stream path; these tests pin the finish-chunk-based fallback.

test("rc.1 stream-level effort rejection (error finish chunk) also triggers the no-effort retry", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const calls = [];
  const warnings = [];
  const ctx = {
    logger: { warn: (m) => warnings.push(String(m)) },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock-model" }) },
    llm: {
      async *stream(options) {
        calls.push(options);
        if (options.reasoningEffort) {
          yield {
            type: "finish",
            reason: {
              kind: "error",
              failure: {
                code: "UNSUPPORTED_REASONING_EFFORT",
                message: 'provider "mock" model "mock-model" does not support reasoning effort "low"'
              }
            }
          };
          return;
        }
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        if (userText.includes("| type=")) {
          yield { type: "text-delta", index: 0, text: JSON.stringify([
            { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "合并标题", content: "合并内容", importance: 4 }
          ]) };
        } else {
          yield { type: "text-delta", index: 0, text: "记忆库总览：用户偏好中文。" };
        }
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
  const result = await dream.runDream(ctx, service, { dreamReasoningEffort: "low" });
  assert.equal(result.ok, true, "run survives the stream-level effort rejection");
  assert.ok(result.applied > 0, "consolidation still lands changes");
  assert.equal(calls[0].reasoningEffort, "low", "first attempt forwards the effort");
  assert.equal("reasoningEffort" in calls[1], false, "retry omits the rejected effort field");
  assert.ok(warnings.some((w) => w.includes("rejected via stream")), "the stream-level rejection is logged");
  store.close();
});

test("non-effort stream failures are not retried and the finish-chunk cause reaches the audit row", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  service.saveWithDedupe({ type: "project", title: "主题", content: "内容" });
  const calls = [];
  const ctx = {
    logger: { warn: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock-model" }) },
    llm: {
      async *stream(options) {
        calls.push(options);
        yield { type: "finish", reason: { kind: "error", failure: { code: "PROVIDER_GONE", message: "provider mock is not registered" } } };
      }
    }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamReasoningEffort: "low" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "llm failed", "the run error stays the stable short string");
  assert.equal(calls.length, 1, "no blind retry when the stream failure is not an effort rejection");
  const row = service.listLlmAudits().find((r) => r.operation_type === "dream_consolidate");
  assert.ok(row && row.status === "error", "failed consolidation still audited");
  assert.ok(
    String(row.error_message).includes("PROVIDER_GONE") && String(row.error_message).includes("provider mock is not registered"),
    "audit error_message carries the finish-chunk cause"
  );
  store.close();
});

test("sleep passes the stream failure accessor so a stream-level effort rejection retries", async () => {
  const { store, service, vectorIndex } = sleepSetup();
  const a = service.saveWithDedupe({ type: "project", title: "主题X", content: "内容A 关于主题X", importance: 3 }).memory;
  const b = service.saveWithDedupe({ type: "project", title: "主题X副本", content: "内容B 关于主题X", importance: 3 }).memory;
  vectorIndex.saveEmbedding(a.id, [1, 0, 0]);
  vectorIndex.saveEmbedding(b.id, [1, 0, 0]);
  const captured = [];
  const ctx = sleepCtx(null, { provider: "mock", model: "sleep-model" }, captured);
  ctx.llm.stream = async function* (options) {
    captured.push(options);
    if (options.reasoningEffort) {
      yield {
        type: "finish",
        reason: { kind: "error", failure: { code: "UNSUPPORTED_REASONING_EFFORT", message: 'provider "mock" model "sleep-model" does not support reasoning effort "low"' } }
      };
      return;
    }
    const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
    yield { type: "text-delta", index: 0, text: options.purpose === "sleep-conflict"
      ? JSON.stringify([{ action: "conflict", winner: a.id, loser: b.id, reason: "重复覆盖" }])
      : "[]" };
    yield { type: "finish", reason: { kind: "stop" } };
  };
  const result = await runSleep(ctx, service, baseConfig({ sleepReasoningEffort: "low" }), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.status, "ok", "sleep survives the stream-level effort rejection");
  assert.equal(captured[0].reasoningEffort, "low", "first conflict attempt forwards the effort");
  assert.equal("reasoningEffort" in captured[1], false, "conflict retry omits the rejected effort field");
  store.close();
});

// ------------------------------------------------------------------ defaultEffort trap
// DSH Desktop's volcano-engine adapter declares reasoning.defaultEffort="low"
// for a model that rejects "low", so omitting the field is NOT a safe retry —
// the harness substitutes the poison default and fails again. resolveDreamEffort
// queries resolveModelInfo up front and forwards a value that is actually in
// the model's declared efforts, so the first attempt already carries a
// supported effort and never trips UNSUPPORTED_REASONING_EFFORT.

test("defaultEffort trap: configured 'low' remapped to the first supported effort when default is poison", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const captured = [];
  const infoCalls = [];
  const ctx = dreamCtx({
    captured,
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "合并标题", content: "合并内容", importance: 4 }
    ])
  });
  // The adapter's capability report: defaultEffort "low" is NOT in efforts
  // (the model rejects it) — exactly the volcano-engine/deepseek-v4-flash trap.
  ctx.llm.resolveModelInfo = async (provider, model) => {
    infoCalls.push([provider, model]);
    return {
      provider,
      model,
      reasoning: {
        efforts: [{ id: "medium" }, { id: "high" }],
        defaultEffort: "low"
      }
    };
  };
  const result = await dream.runDream(ctx, service, { dreamReasoningEffort: "low" });
  assert.equal(result.ok, true, "run succeeds without ever tripping the poison default");
  assert.ok(result.applied > 0, "consolidation lands changes");
  assert.deepEqual(infoCalls[0], ["mock", "mock-model"], "capability queried for the exact dream route");
  assert.equal(captured[0].reasoningEffort, "medium", "poison 'low' remapped to the first supported effort");
  assert.equal(captured[1].reasoningEffort, "medium", "summary pass uses the same resolved effort");
  store.close();
});

test("defaultEffort trap: model with no reasoning capability omits the field entirely", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const captured = [];
  const ctx = dreamCtx({
    captured,
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "合并标题", content: "合并内容", importance: 4 }
    ])
  });
  // Non-thinking model (e.g. deepseek-v4-flash): adapter reports no reasoning
  // capability, so ANY explicit effort would be rejected — the helper must
  // drop it, which is the harness's safe "no reasoning" path.
  ctx.llm.resolveModelInfo = async () => ({ provider: "mock", model: "mock-model", reasoning: undefined });
  const result = await dream.runDream(ctx, service, { dreamReasoningEffort: "high" });
  assert.equal(result.ok, true);
  for (const options of captured) {
    assert.equal("reasoningEffort" in options, false, "no reasoning capability -> effort omitted, never rejected");
  }
  store.close();
});

test("defaultEffort trap: configured effort supported is forwarded verbatim", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const captured = [];
  const ctx = dreamCtx({
    captured,
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "合并标题", content: "合并内容", importance: 4 }
    ])
  });
  ctx.llm.resolveModelInfo = async () => ({
    provider: "mock",
    model: "mock-model",
    reasoning: { efforts: [{ id: "high" }, { id: "low" }], defaultEffort: "low" }
  });
  const result = await dream.runDream(ctx, service, { dreamReasoningEffort: "high" });
  assert.equal(result.ok, true);
  for (const options of captured) {
    assert.equal(options.reasoningEffort, "high", "supported configured value untouched");
  }
  store.close();
});

test("defaultEffort trap: capability query failure falls back to configured effort (retry still guards)", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const { memory: a } = service.saveWithDedupe({ type: "project", title: "插件", content: "旧", importance: 3 });
  const { memory: b } = service.saveWithDedupe({ type: "project", title: "插件2", content: "新细节", importance: 4 });
  const calls = [];
  const warnings = [];
  const ctx = {
    logger: { warn: (m) => warnings.push(String(m)) },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock-model" }) },
    llm: {
      async *stream(options) {
        calls.push(options);
        if (options.reasoningEffort) {
          throw new Error("UNSUPPORTED_REASONING_EFFORT: mock does not support reasoning effort \"high\"");
        }
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        if (userText.includes("| type=")) {
          yield { type: "text-delta", index: 0, text: JSON.stringify([
            { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "合并标题", content: "合并内容", importance: 4 }
          ]) };
        } else {
          yield { type: "text-delta", index: 0, text: "记忆库总览：用户偏好中文。" };
        }
        yield { type: "finish", reason: { kind: "stop" } };
      },
      // Adapter knows nothing about the model — helper must not crash, and the
      // configured effort flows through so withEffortFallback still retries.
      resolveModelInfo: async () => { throw new Error("adapter not reachable"); }
    }
  };
  const result = await dream.runDream(ctx, service, { dreamReasoningEffort: "high" });
  assert.equal(result.ok, true, "run succeeds via the no-effort retry");
  assert.equal(calls[0].reasoningEffort, "high", "configured effort forwarded when capability query fails");
  assert.equal("reasoningEffort" in calls[1], false, "rejected effort retried without the field");
  assert.ok(warnings.some((w) => w.includes("resolveModelInfo failed")), "capability-query failure is logged");
  store.close();
});

test("defaultEffort trap: sleep conflict pass remaps a poison effort too", async () => {
  const { store, service, vectorIndex } = sleepSetup();
  const a = service.saveWithDedupe({ type: "project", title: "主题X", content: "内容A 关于主题X", importance: 3 }).memory;
  const b = service.saveWithDedupe({ type: "project", title: "主题X副本", content: "内容B 关于主题X", importance: 3 }).memory;
  vectorIndex.saveEmbedding(a.id, [1, 0, 0]);
  vectorIndex.saveEmbedding(b.id, [1, 0, 0]);
  const captured = [];
  const ctx = sleepCtx(
    (userText, purpose) => purpose === "sleep-conflict"
      ? JSON.stringify([{ action: "conflict", winner: a.id, loser: b.id, reason: "重复覆盖" }])
      : "[]",
    { provider: "mock", model: "sleep-model" },
    captured
  );
  ctx.llm.resolveModelInfo = async (provider, model) => ({
    provider,
    model,
    reasoning: { efforts: [{ id: "medium" }, { id: "high" }], defaultEffort: "low" }
  });
  const result = await runSleep(ctx, service, baseConfig({ sleepReasoningEffort: "low" }), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.status, "ok");
  assert.ok(captured.length >= 2, "conflict + pattern passes both hit the LLM");
  for (const options of captured) {
    assert.equal(options.reasoningEffort, "medium", "poison 'low' remapped on sleep passes too");
  }
  store.close();
});

// ------------------------------------------------- entity extraction adapter (issue #108/#109)
// The streamEntityText adapter lives in index.js; it maps the extractor's
// options onto a dsh-llm stream route and retries once without the effort
// when the first attempt is rejected. These tests drive the real exported
// factory, not a mock of it.

test("issue#109: entity extraction effort rejection retries once without the effort", async () => {
  const calls = [];
  const warnings = [];
  const streamEntityText = createEntityStreamAdapter({
    llm: {
      async *stream(options) {
        calls.push(options);
        // First attempt carries the effort: the provider rejects it via an
        // error finish chunk (the realistic stream-level rejection).
        if (options.reasoningEffort) {
          yield { type: "finish", reason: { kind: "error", message: "UNSUPPORTED_REASONING_EFFORT" } };
          return;
        }
        yield { type: "text-delta", index: 0, text: "{\"entities\":[{\"name\":\"张三\",\"type\":\"person\",\"attrs\":[{\"key\":\"职业\",\"value\":\"工程师\",\"confidence\":0.9}]}],\"relations\":[]}" };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock-model" }) },
    logger: { warn: (m) => warnings.push(String(m)) }
  });
  const text = await streamEntityText(
    [{ role: "user", content: [{ type: "text", text: "记忆内容" }] }],
    { reasoningEffort: "low" }
  );
  assert.equal(calls.length, 2, "attempt (rejected) + retry without effort");
  assert.equal(calls[0].reasoningEffort, "low", "first attempt forwards the effort");
  assert.equal("reasoningEffort" in calls[1], false, "retry omits the rejected effort field");
  assert.equal(calls[0].provider, "mock", "route resolved from agentDefaultModel");
  assert.equal(calls[0].model, "mock-model", "route model from agentDefaultModel");
  assert.equal(calls[0].maxTokens, 4096, "extraction caps its output");
  assert.ok(text.includes("张三"), "retry stream text is returned");
  assert.ok(warnings.some((w) => w.includes("rejected, retrying without it")), "rejection is logged");
});

test("issue#109: entity extraction never retries blindly without an effort configured", async () => {
  const calls = [];
  const streamEntityText = createEntityStreamAdapter({
    llm: {
      async *stream(options) {
        calls.push(options);
        yield { type: "finish", reason: { kind: "error", message: "overloaded" } };
      }
    },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock-model" }) },
    logger: { warn: () => {} }
  });
  const text = await streamEntityText([{ role: "user", content: [] }], {});
  assert.equal(text, undefined, "failure yields no text");
  assert.equal(calls.length, 1, "no blind retry when no effort was requested");
});

test("issue#109: entity extraction explicit provider/model win over the default route", async () => {
  const calls = [];
  const streamEntityText = createEntityStreamAdapter({
    llm: {
      async *stream(options) {
        calls.push(options);
        yield { type: "text-delta", index: 0, text: "{}" };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    },
    agentDefaultModel: { currentSelection: () => ({ provider: "default", model: "default-model" }) },
    logger: { warn: () => {} }
  });
  await streamEntityText([{ role: "user", content: [] }], { provider: "volcano", model: "deepseek-v3" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "volcano", "explicit provider beats the default");
  assert.equal(calls[0].model, "deepseek-v3", "explicit model beats the default");
});
