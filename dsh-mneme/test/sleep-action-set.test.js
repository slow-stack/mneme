import test from "node:test";
import assert from "node:assert/strict";
import { applyDecisions, validateDecisions } from "../src/dream/decisions.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";
import { runSleep } from "../src/dream/sleep.js";
import { buildOutcome } from "../src/dream.js";
import { STR } from "../src/lang.js";

// Issue #126：sleep 冲突阶段的动作集扩展。默认档（sleepActionSet="conflict"）保持
// 只有 conflict/keep 的窄语义；"full" 开放六分支，让演进型（supersede）与互补型
// （differentiate）重复各得其所，不再被强行"输赢化"。

const embedder = {
  embedSingle: async () => [1, 0, 0],
  embed: async () => [1, 0, 0],
  schedule: () => {},
  modelHash: "mock#1",
  dimension: 3
};

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

/** Snapshot the decision targets the way a real run does before the LLM call. */
function snapshotOf(store, ...mems) {
  return new Map(mems.map((m) => [m.id, store.getById(m.id)]));
}

// --------------------------------------------------------- action semantics

test("issue#126 supersede: the note lands on the loser, the winner body stays clean", () => {
  const { service, store } = setup();
  const oldMem = makeMemory(service, "部署方式 v1", "用 pm2 常驻启动");
  const newMem = makeMemory(service, "部署方式 v2", "改用 systemd 托管");
  const snapshot = snapshotOf(store, oldMem, newMem);
  const { applied } = applyDecisions(
    [{ action: "supersede", winner: newMem.id, loser: oldMem.id, reason: "版本演进" }],
    service, null, snapshot, {}
  );
  assert.equal(applied, 1, "decision committed");
  // #126 的核心诉求：conflict 会把注记写进赢家正文，supersede 必须写在被取代的一侧。
  assert.equal(service.getById(newMem.id).content, "改用 systemd 托管", "winner body untouched");
  const loser = service.getById(oldMem.id);
  assert.equal(loser.archived, true, "loser archived");
  assert.ok(loser.content.includes("已被取代"), "supersession note appended to the loser");
  assert.ok(loser.content.includes("部署方式 v2"), "note names the superseding entry");
  store.close();
});

test("issue#126 supersede: replay is idempotent (archived loser, single note)", () => {
  const { service, store } = setup();
  const oldMem = makeMemory(service, "端口 v1", "内网 22");
  const newMem = makeMemory(service, "端口 v2", "内网 2222");
  const snapshot = snapshotOf(store, oldMem, newMem);
  const decision = { action: "supersede", winner: newMem.id, loser: oldMem.id, reason: "演进" };
  applyDecisions([decision], service, null, snapshot, {});
  const second = applyDecisions([{ ...decision }], service, null, snapshot, {});
  assert.equal(second.applied, 0, "replay commits nothing");
  assert.equal(second.committed.length, 0);
  const notes = service.getById(oldMem.id).content.match(/已被取代/g) ?? [];
  assert.equal(notes.length, 1, "the note is never appended twice");
  store.close();
});

test("issue#533 differentiate: both entries survive, bodies untouched, the pair lands in the ledger", () => {
  const { service, store } = setup();
  const a = makeMemory(service, "内网 SSH 端口", "内网走 22");
  const b = makeMemory(service, "外网 SSH 端口", "外网映射 2222");
  // 两侧各自追加注记会让共享后缀把向量拉近——先记下原始正文，事后逐字节比对。
  const before = { [a.id]: service.getById(a.id).content, [b.id]: service.getById(b.id).content };
  const snapshot = snapshotOf(store, a, b);
  const { applied } = applyDecisions(
    [{ action: "differentiate", ids: [a.id, b.id], distinctions: ["内网直连", "外网映射"] }],
    service, null, snapshot, {}
  );
  assert.equal(applied, 1);
  for (const m of [a, b]) {
    const after = service.getById(m.id);
    assert.equal(after.archived, false, "differentiate never archives");
    assert.equal(after.content, before[m.id], "the body is left byte-identical");
    assert.ok(!after.content.includes("差异注记"), "no note is written into the body");
  }
  const record = service.findDifferentiatedPair(a.id, b.id);
  assert.ok(record, "the verdict is recorded as a pair, not as body text");
  assert.deepEqual(record.distinctions, ["内网直连", "外网映射"], "the model's distinctions survive for audit");
  store.close();
});

test("issue#126 differentiate: replay does not stack the note again", () => {
  const { service, store } = setup();
  const a = makeMemory(service, "场景 A", "内容 A");
  const b = makeMemory(service, "场景 B", "内容 B");
  const decision = { action: "differentiate", ids: [a.id, b.id], distinctions: ["甲面", "乙面"] };
  applyDecisions([decision], service, null, snapshotOf(store, a, b), {});
  const afterFirst = service.getById(a.id).content;
  const second = applyDecisions([{ ...decision }], service, null, snapshotOf(store, a, b), {});
  assert.equal(second.applied, 0, "replay is a clean no-op");
  assert.equal(service.getById(a.id).content, afterFirst, "content is not re-appended");
  store.close();
});

test("issue#126 differentiate: a concurrently edited target is reported as a CAS conflict", () => {
  const { service, store } = setup();
  const a = makeMemory(service, "并发 A", "内容 A");
  const b = makeMemory(service, "并发 B", "内容 B");
  const snapshot = snapshotOf(store, a, b);
  service.update(a.id, { content: "并发编辑后的内容" });
  const { applied, conflicts } = applyDecisions(
    [{ action: "differentiate", ids: [a.id, b.id], distinctions: ["甲", "乙"] }],
    service, null, snapshot, {}
  );
  assert.equal(applied, 0, "stale decision is not applied");
  assert.equal(conflicts.length, 1, "surfaced as a CAS conflict (existing semantics)");
  assert.equal(service.getById(a.id).content, "并发编辑后的内容", "concurrent edit preserved");
  store.close();
});

// ------------------------------------------------------------------ validation

test("issue#126 validate: supersede requires distinct winner/loser", () => {
  const { service, store } = setup();
  const a = makeMemory(service, "甲", "内容甲");
  const snapshot = snapshotOf(store, a);
  const bad = validateDecisions([{ action: "supersede", winner: a.id, loser: a.id }], snapshot, {});
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes("supersede needs distinct winner and loser")), "explicit message");
  store.close();
});

test("issue#126 validate: differentiate needs two ids and a non-empty distinctions array", () => {
  const { service, store } = setup();
  const a = makeMemory(service, "甲", "内容甲");
  const b = makeMemory(service, "乙", "内容乙");
  const snapshot = snapshotOf(store, a, b);
  assert.equal(validateDecisions([{ action: "differentiate", ids: [a.id], distinctions: ["x"] }], snapshot, {}).ok, false);
  assert.equal(validateDecisions([{ action: "differentiate", ids: [a.id, b.id], distinctions: [] }], snapshot, {}).ok, false);
  assert.equal(validateDecisions([{ action: "differentiate", ids: [a.id, b.id], distinctions: ["", "  "] }], snapshot, {}).ok, false,
    "blank-only distinctions are rejected");
  assert.equal(validateDecisions([{ action: "differentiate", ids: [a.id, b.id], distinctions: ["甲面", "乙面"] }], snapshot, {}).ok, true);
  store.close();
});

test("issue#126 validate: differentiate is allowed across types while merge is not", () => {
  const { service, store } = setup();
  const a = makeMemory(service, "项目端口", "项目用 8080", "project");
  const b = makeMemory(service, "偏好端口", "偏好 8080", "preference");
  const snapshot = snapshotOf(store, a, b);
  const merge = validateDecisions(
    [{ action: "merge", ids: [a.id, b.id], keepSource: a.id, title: "t", content: "c" }],
    snapshot, { skipInvalid: true }
  );
  assert.equal(merge.skipped.length, 1, "cross-type merge is skipped");
  assert.match(merge.skipped[0].error, /multiple types/);
  // 互补型本来就常跨类型（同一个事实的项目侧与偏好侧），不该套用 merge 的类型边界。
  assert.equal(validateDecisions([{ action: "differentiate", ids: [a.id, b.id], distinctions: ["项目侧", "偏好侧"] }], snapshot, {}).ok, true);
  store.close();
});

// --------------------------------------------------------------- end to end

function captureCtx(reply) {
  const seen = [];
  return {
    seen,
    logger: { warn: () => {}, info: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "sleep-model" }) },
    llm: {
      async *stream(options) {
        seen.push(options.messages.find((m) => m.role === "system")?.content?.[0]?.text ?? "");
        yield { type: "text-delta", index: 0, text: reply };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
}

function seedPair(service, vectorIndex, t1, t2, sim = 1.0) {
  const a = makeMemory(service, t1, `${t1} 的内容`);
  const b = makeMemory(service, t2, `${t2} 的内容`);
  const sin = Math.sqrt(Math.max(0, 1 - sim * sim));
  vectorIndex.saveEmbedding(a.id, [1, 0, 0]);
  vectorIndex.saveEmbedding(b.id, [sim, sin, 0]);
  return { a, b };
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

test("issue#126 sleepActionSet=conflict (default) keeps the narrow two-branch prompt", async () => {
  const { service, store, vectorIndex } = setup();
  const { a, b } = seedPair(service, vectorIndex, "默认档甲", "默认档乙");
  const ctx = captureCtx(JSON.stringify([{ action: "keep", ids: [a.id, b.id] }]));
  await runSleep(ctx, service, baseConfig(), ctx.logger, { embedder, vectorIndex }, null);
  const conflictPrompt = ctx.seen.find((p) => p.includes("冲突仲裁")) ?? "";
  assert.ok(conflictPrompt, "the conflict phase ran");
  assert.ok(!conflictPrompt.includes("supersede"), "default tier never advertises supersede");
  assert.ok(!conflictPrompt.includes("differentiate"), "default tier never advertises differentiate");
  store.close();
});

test("issue#126 sleepActionSet=full advertises the six-branch action set", async () => {
  const { service, store, vectorIndex } = setup();
  const { a, b } = seedPair(service, vectorIndex, "全量档甲", "全量档乙");
  const ctx = captureCtx(JSON.stringify([{ action: "keep", ids: [a.id, b.id] }]));
  await runSleep(ctx, service, baseConfig({ sleepActionSet: "full" }), ctx.logger, { embedder, vectorIndex }, null);
  const conflictPrompt = ctx.seen.find((p) => p.includes("冲突仲裁")) ?? "";
  for (const action of ["merge", "supersede", "differentiate", "update", "conflict", "keep"]) {
    assert.ok(conflictPrompt.includes(action), `full tier advertises ${action}`);
  }
  store.close();
});

test("issue#126 full tier: a supersede decision resolves an evolution pair end to end", async () => {
  const { service, store, vectorIndex } = setup();
  const { a, b } = seedPair(service, vectorIndex, "旧方案", "新方案");
  const ctx = captureCtx(JSON.stringify([{ action: "supersede", winner: b.id, loser: a.id, reason: "新方案取代旧方案" }]));
  const result = await runSleep(ctx, service, baseConfig({ sleepActionSet: "full" }), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.status, "ok", "supersede applied");
  assert.equal(service.getById(a.id).archived, true, "old entry archived");
  assert.equal(service.getById(b.id).content, "新方案 的内容", "new entry body untouched");
  // 注：sleep 的裁决不写 receipt_chain（既有设计——per-record receipt 只由 dream 的
  // runDream 写）。新动作的 receipt kind 由 dream 路径的测试覆盖。
  store.close();
});

test("issue#126 skipInvalid: one invalid pair no longer fails the phase, and lands in the audit row", async () => {
  const { service, store, vectorIndex } = setup();
  const good = seedPair(service, vectorIndex, "合法甲", "合法乙");
  const bad = seedPair(service, vectorIndex, "非法甲", "非法乙");
  const ctx = captureCtx(JSON.stringify([
    { action: "conflict", winner: good.a.id, loser: good.b.id, reason: "同义重复" },
    { action: "conflict", winner: "nonexistent-zzz", loser: bad.b.id, reason: "引用了不存在的 id" }
  ]));
  const result = await runSleep(ctx, service, baseConfig({ sleepActionSet: "full" }), ctx.logger, { embedder, vectorIndex }, null);
  // Issue #126 review（Copilot）：合法子集已应用但仍有余项被跳过 → degraded，不再是
  // ok —— 与 dream 的契约对齐，消费方不必去翻审计明细才能区分"整轮"与"残轮"。
  assert.equal(result.phases.conflicts.status, "degraded", "valid subset applied, run flagged degraded");
  assert.equal(result.status, "degraded", "the whole sleep run reflects the partial phase");
  assert.equal(service.getById(good.b.id).archived, true, "the valid pair still landed");
  // #104 同向：被跳过的逐对明细进审计行（此前只进日志）。
  const run = store.getDreamRun(result.runId);
  assert.ok(Array.isArray(run?.skipped) && run.skipped.length === 1, "skipped detail persisted on the sleep audit row");
  assert.equal(run.skipped[0].phase, "conflicts", "detail is tagged with its phase");
  assert.match(run.skipped[0].error, /unknown id/, "per-pair reason kept");
  store.close();
});

// ------------------------------------------------- fail-safe / boundary shapes

test("issue#126 supersede: trustEpistemicWeighting is honored on the superseding side", () => {
  const { service, store } = setup();
  const oldMem = makeMemory(service, "旧结论", "旧结论内容");
  const newMem = makeMemory(service, "新结论", "新结论内容");
  const snapshot = snapshotOf(store, oldMem, newMem);
  // 两侧可信度相同（默认 subjective）→ 保持模型给出的 winner，不凭空交换。
  const { applied } = applyDecisions(
    [{ action: "supersede", winner: newMem.id, loser: oldMem.id, reason: "演进" }],
    service, null, snapshot, { trustEpistemicWeighting: true }
  );
  assert.equal(applied, 1);
  assert.equal(service.getById(oldMem.id).archived, true, "model's loser stays the loser at equal trust");
  store.close();
});

test("issue#126 supersede: a missing target degrades to skipped instead of throwing", () => {
  const { service, store } = setup();
  const a = makeMemory(service, "有主", "内容");
  // snapshot=null 跳过 CAS 守卫，直接验证"目标不存在"的 fail-safe 分支。
  const { applied, failures } = applyDecisions(
    [{ action: "supersede", winner: a.id, loser: "missing-zzz", reason: "x" }],
    service, null, null, {}
  );
  assert.equal(applied, 0, "nothing committed");
  assert.equal(failures.length, 0, "degrades cleanly, never throws");
  store.close();
});

test("issue#126 differentiate: fewer than two live targets is a no-op", () => {
  const { service, store } = setup();
  const a = makeMemory(service, "存活", "内容甲");
  const b = makeMemory(service, "已归档", "内容乙");
  service.setArchived(b.id, true);
  const { applied } = applyDecisions(
    [{ action: "differentiate", ids: [a.id, b.id], distinctions: ["甲面", "乙面"] }],
    service, null, null, {}
  );
  assert.equal(applied, 0, "differentiate needs two live entries");
  assert.ok(!service.getById(a.id).content.includes("差异注记"), "no note is written without a pair");
  store.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// Issue #126 review（Copilot 逐条）的回归护栏：一处修复一条断言。
// ═══════════════════════════════════════════════════════════════════════════

test("issue#126r: the default tier rejects an unexpected supersede (opt-in stays opt-in)", async () => {
  const { service, store, vectorIndex } = setup();
  const { a, b } = seedPair(service, vectorIndex, "默认档甲", "默认档乙");
  // 默认档没开 full，模型却输出了 supersede —— 校验器必须挡住。只换 prompt 挡不住，
  // 这正是 Copilot 指出的 "opt-in 空话"。
  const ctx = captureCtx(JSON.stringify([{ action: "supersede", winner: b.id, loser: a.id, reason: "越档" }]));
  const result = await runSleep(ctx, service, baseConfig(), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(service.getById(a.id).archived, false, "supersede must not be applied in the default tier");
  // 全部决策越档 → 无合法决策 → 覆盖率闸整单拒绝（phase 因此没有 applied 计数）。
  // 这与 #146 之前的行为一致（那时 supersede 同样被判 invalid action）。
  assert.equal(result.phases.conflicts.applied ?? 0, 0, "nothing was applied");
  store.close();
});

test("issue#126r: the full tier still accepts the very same supersede", async () => {
  const { service, store, vectorIndex } = setup();
  const { a, b } = seedPair(service, vectorIndex, "全量档甲", "全量档乙");
  const ctx = captureCtx(JSON.stringify([{ action: "supersede", winner: b.id, loser: a.id, reason: "演进" }]));
  const result = await runSleep(ctx, service, baseConfig({ sleepActionSet: "full" }), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.applied, 1, "full tier applies it");
  assert.equal(service.getById(a.id).archived, true);
  store.close();
});

test("issue#126r: strict mode no longer rejects a valid supersede over synthetic keeps", async () => {
  const { service, store, vectorIndex } = setup();
  const { a, b } = seedPair(service, vectorIndex, "严格甲", "严格乙");
  const ctx = captureCtx(JSON.stringify([{ action: "supersede", winner: b.id, loser: a.id, reason: "演进" }]));
  // dreamSkipInvalid:false = 严格模式。covered 预填必须认 supersede 的 winner/loser，
  // 否则会补两条 keep 与它抢 claim → 整单被拒。
  const result = await runSleep(
    ctx, service,
    baseConfig({ sleepActionSet: "full", dreamSkipInvalid: false }),
    ctx.logger, { embedder, vectorIndex }, null
  );
  assert.equal(result.phases.conflicts.status, "ok", "strict mode accepts the valid supersede");
  assert.equal(service.getById(a.id).archived, true, "the supersede landed");
  store.close();
});

test("issue#126r: the English full prompt names the field the validator requires", () => {
  const en = STR.prompts.conflictFull.en;
  assert.ok(en.includes("distinctions"), "the English prompt must name `distinctions`");
  assert.ok(!en.includes("distinguish must"), "the stale `distinguish` field name is gone");
});

test("issue#126r: buildOutcome records a disposition for the new actions", () => {
  const outcome = buildOutcome([
    { action: "supersede", winner: "w1", loser: "l1" },
    { action: "differentiate", ids: ["d1", "d2"] }
  ]);
  assert.equal(outcome.byId.w1, "supersede-winner");
  assert.equal(outcome.byId.l1, "superseded-archived");
  assert.equal(outcome.byId.d1, "differentiated");
  assert.equal(outcome.byId.d2, "differentiated");
});

test("issue#533r: differentiate leaves the cached vectors alone (nothing changed to re-embed)", async () => {
  const { service, store, vectorIndex } = setup();
  const { a, b } = seedPair(service, vectorIndex, "向量甲", "向量乙");
  const beforeA = vectorIndex.getEmbedding(a.id);
  const beforeB = vectorIndex.getEmbedding(b.id);
  // 让嵌入器产出与旧向量不同的结果：若源码又悄悄重嵌，这里立刻会变。
  const fresh = { ...embedder, embedSingle: async () => [0, 1, 0] };
  service.setEmbedder(fresh);
  const ctx = captureCtx(JSON.stringify([
    { action: "differentiate", ids: [a.id, b.id], distinctions: ["甲面", "乙面"] }
  ]));
  await runSleep(ctx, service, baseConfig({ sleepActionSet: "full" }), ctx.logger, { embedder: fresh, vectorIndex }, null);
  assert.deepEqual(vectorIndex.getEmbedding(a.id), beforeA, "side A keeps its vector");
  assert.deepEqual(vectorIndex.getEmbedding(b.id), beforeB, "side B keeps its vector");
  store.close();
});

test("issue#126r: the full tier discovers cross-type pairs (differentiate would otherwise be unreachable)", async () => {
  const { service, store, vectorIndex } = setup();
  const proj = makeMemory(service, "项目端口", "项目用 8080", "project");
  const pref = makeMemory(service, "偏好端口", "偏好 8080", "preference");
  vectorIndex.saveEmbedding(proj.id, [1, 0, 0]);
  vectorIndex.saveEmbedding(pref.id, [1, 0, 0]);
  const ctx = captureCtx(JSON.stringify([
    { action: "differentiate", ids: [proj.id, pref.id], distinctions: ["项目侧", "偏好侧"] }
  ]));
  const result = await runSleep(ctx, service, baseConfig({ sleepActionSet: "full" }), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.applied, 1, "the cross-type pair was adjudicated");
  assert.ok(service.findDifferentiatedPair(proj.id, pref.id), "differentiate reached the cross-type pair");
  assert.equal(service.getById(proj.id).content, "项目用 8080", "the project body is untouched");
  store.close();
});

test("issue#126r: a throwing index maintenance degrades to a warning, never fails the phase", async () => {
  const { service, store, vectorIndex } = setup();
  const { a, b } = seedPair(service, vectorIndex, "抖动甲", "抖动乙");
  // deleteEmbedding 抛错 → maintainIndexAfterDream 抛出 → sleep 只能告警：索引维护是
  // 收尾动作，不能反过来把已经落库的决策判成失败。
  const badIndex = {
    getEmbedding: (id) => vectorIndex.getEmbedding(id),
    saveEmbedding: (id, v) => vectorIndex.saveEmbedding(id, v),
    deleteEmbedding: () => { throw new Error("index down"); }
  };
  const ctx = captureCtx(JSON.stringify([{ action: "supersede", winner: b.id, loser: a.id, reason: "演进" }]));
  const result = await runSleep(
    ctx, service, baseConfig({ sleepActionSet: "full" }),
    ctx.logger, { embedder, vectorIndex: badIndex }, null
  );
  assert.equal(service.getById(a.id).archived, true, "the decision itself still landed");
  assert.equal(result.phases.conflicts.status, "ok", "index maintenance failure is only a warning");
  store.close();
});
