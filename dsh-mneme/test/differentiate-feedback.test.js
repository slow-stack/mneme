// Issue #533：differentiate 的正反馈死循环回归护栏。
//
// 现象（issue #533 实测）：sleepActionSet="full" 下，一对高相似记忆被判成
// differentiate，旧实现把**同一段**差异注记同时追加到两侧正文，指望"注记进
// embedding 后下一轮不再判重复"。离线复现证明恰好相反——两侧共享同一段后缀会让
// 向量同向靠拢（0.876 → 0.960 只用 5 轮，把注记截到 0 字照样往上爬，因为推高相似
// 度的是共享前缀本身而不是注记长短），于是下一轮又被判重复、又追加一段，实测单条
// 堆到 19 段、正文 150 字膨胀到 2200+ 字。
//
// 现在的契约：differentiate **不改正文**，裁决落 differentiated_pairs 账本；候选
// 构造阶段读账本，已裁决且两侧正文未变就不送模型。本文件锁的就是这两件事——
// 「正文不变」和「第二轮不再花钱」。
import test from "node:test";
import assert from "node:assert/strict";
import { applyDecisions, validateDecisions } from "../src/dream/decisions.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";
import { runSleep } from "../src/dream/sleep.js";

const embedder = {
  // 批量接口要按输入条数返回（向量回填走这一条），返回单个向量会让 usable 判空。
  embedSingle: async () => [1, 0, 0],
  embed: async (texts) => (Array.isArray(texts) ? texts.map(() => [1, 0, 0]) : [1, 0, 0]),
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

function snapshotOf(store, ...mems) {
  return new Map(mems.map((m) => [m.id, store.getById(m.id)]));
}

function captureCtx(reply) {
  const seen = [];
  return {
    seen,
    logger: { warn: () => {}, info: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "sleep-model" }) },
    llm: {
      async *stream(options) {
        seen.push(options.messages.find((m) => m.system ?? m.role === "system")?.content?.[0]?.text ?? "");
        yield { type: "text-delta", index: 0, text: typeof reply === "function" ? reply() : reply };
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

function seedPair(service, vectorIndex, t1, t2, sim = 1.0) {
  const a = makeMemory(service, t1, `${t1} 的内容`);
  const b = makeMemory(service, t2, `${t2} 的内容`);
  const sin = Math.sqrt(Math.max(0, 1 - sim * sim));
  vectorIndex.saveEmbedding(a.id, [1, 0, 0]);
  vectorIndex.saveEmbedding(b.id, [sim, sin, 0]);
  return { a, b };
}

// ---------------------------------------------------------------- 正文不变

test("issue#533: repeated differentiate with drifting wording never grows the bodies", () => {
  const { service, store } = setup();
  const a = makeMemory(service, "内网 SSH 端口", "内网走 22");
  const b = makeMemory(service, "外网 SSH 端口", "外网映射 2222");
  const before = { [a.id]: service.getById(a.id).content, [b.id]: service.getById(b.id).content };
  // 模型每轮换一种说法——这正是字面 includes 幂等失效的场景，也是 issue 里单条堆到
  // 19 段的真实成因。账本口径下措辞漂移不再产生任何正文副作用。
  const wordings = [
    ["内网直连", "外网映射"],
    ["走内网", "走外网映射"],
    ["内网那台直连", "外网那台做映射"],
    ["内网的机器直连", "外网的机器走映射"],
    ["内网直连（22）", "外网映射（2222）"]
  ];
  let appliedRounds = 0;
  for (const distinctions of wordings) {
    const snapshot = snapshotOf(store, service.getById(a.id), service.getById(b.id));
    const { applied } = applyDecisions(
      [{ action: "differentiate", ids: [a.id, b.id], distinctions }],
      service, null, snapshot, {}
    );
    appliedRounds += applied;
  }
  assert.equal(appliedRounds, 1, "only the first round is a real verdict; the rest are idempotent");
  // 这一条是 #533 的核心断言：无论判多少轮，正文长度一个字节都不许变。
  assert.equal(service.getById(a.id).content, before[a.id], "side A body is byte-identical");
  assert.equal(service.getById(b.id).content, before[b.id], "side B body is byte-identical");
  assert.equal(service.getById(a.id).content.length, "内网走 22".length, "no note accumulates");
  store.close();
});

test("issue#533: the ledger keeps one row per pair and refreshes the distinctions", () => {
  const { service, store } = setup();
  const a = makeMemory(service, "甲", "内容甲");
  const b = makeMemory(service, "乙", "内容乙");
  for (const distinctions of [["第一版"], ["第二版", "补充版"]]) {
    applyDecisions(
      [{ action: "differentiate", ids: [a.id, b.id], distinctions }],
      service, null, snapshotOf(store, service.getById(a.id), service.getById(b.id)), {}
    );
  }
  // 顺序归一：不管送审时谁在前，账本只有一行。
  assert.equal(store.listDifferentiatedPairs().length, 1, "one pair, one row");
  const record = service.findDifferentiatedPair(b.id, a.id);
  assert.deepEqual(record.distinctions, ["第一版"], "an unchanged body keeps the original verdict");
  store.close();
});

// -------------------------------------------------------------- 三层幂等

test("issue#533: a body edited after the verdict re-opens the pair", () => {
  const { service, store } = setup();
  const a = makeMemory(service, "甲", "内容甲");
  const b = makeMemory(service, "乙", "内容乙");
  applyDecisions(
    [{ action: "differentiate", ids: [a.id, b.id], distinctions: ["甲面", "乙面"] }],
    service, null, snapshotOf(store, service.getById(a.id), service.getById(b.id)), {}
  );
  // 原样重放 → 幂等。
  const replay = applyDecisions(
    [{ action: "differentiate", ids: [a.id, b.id], distinctions: ["甲面", "乙面"] }],
    service, null, snapshotOf(store, service.getById(a.id), service.getById(b.id)), {}
  );
  assert.equal(replay.applied, 0, "an unchanged pair is idempotent");
  // 一侧被改写 → 结论可能不再成立，必须能重新裁决（宁可再判一次，不静音真的演化）。
  service.update(a.id, { content: "内容甲被改写" });
  const reopened = applyDecisions(
    [{ action: "differentiate", ids: [a.id, b.id], distinctions: ["甲面", "乙面", "改写后"] }],
    service, null, snapshotOf(store, service.getById(a.id), service.getById(b.id)), {}
  );
  assert.equal(reopened.applied, 1, "an edited side re-opens the pair");
  assert.deepEqual(
    service.findDifferentiatedPair(a.id, b.id).distinctions, ["甲面", "乙面", "改写后"],
    "the refreshed verdict replaces the stale one"
  );
  store.close();
});

test("issue#533: legacy rows that still carry the old note are treated as adjudicated", () => {
  const { service, store } = setup();
  // 旧版本写进正文的注记块原样造出来（升级不清账：这些行没有账本行）。
  const a = makeMemory(service, "甲", "内容甲\n\n（差异注记：甲面；乙面）");
  const b = makeMemory(service, "乙", "内容乙\n\n（差异注记：甲面；乙面）");
  const { applied } = applyDecisions(
    [{ action: "differentiate", ids: [a.id, b.id], distinctions: ["甲面", "乙面"] }],
    service, null, snapshotOf(store, service.getById(a.id), service.getById(b.id)), {}
  );
  assert.equal(applied, 0, "no ledger row is needed once both sides carry the note");
  assert.equal(service.getById(a.id).content, "内容甲\n\n（差异注记：甲面；乙面）", "the legacy body is untouched");
  store.close();
});

test("issue#533: a bare service without the ledger degrades to skipped, never throws", () => {
  // 人工确认路径（service.js 的裸 applyService）没有账本透传——此时「正文不变」本身
  // 就是全部副作用，没有账本就没有可写之处，只能是 skipped，不能算 applied。
  const mems = new Map();
  const bare = {
    getById: (id) => mems.get(id) ?? null,
    update: (id, patch) => { mems.set(id, { ...mems.get(id), ...patch }); },
    setArchived: () => {},
    transaction: (fn) => fn()
  };
  mems.set("a", { id: "a", title: "甲", content: "内容甲", archived: false });
  mems.set("b", { id: "b", title: "乙", content: "内容乙", archived: false });
  const { applied, failures } = applyDecisions(
    [{ action: "differentiate", ids: ["a", "b"], distinctions: ["甲面", "乙面"] }],
    bare, null, null, {}
  );
  assert.equal(applied, 0, "nothing to record, nothing applied");
  assert.equal(failures.length, 0, "degrades cleanly");
  assert.equal(mems.get("a").content, "内容甲", "still never touches the body");
});

// ------------------------------------------------------- 候选构造阶段抑制

test("issue#533: a second sleep cycle does not pay for an already-adjudicated pair", async () => {
  const { service, store, vectorIndex } = setup();
  const { a, b } = seedPair(service, vectorIndex, "甲端口", "乙端口");
  const reply = () => JSON.stringify([
    { action: "differentiate", ids: [a.id, b.id], distinctions: ["甲面", "乙面"] }
  ]);
  const ctx1 = captureCtx(reply);
  const first = await runSleep(ctx1, service, baseConfig({ sleepActionSet: "full" }), ctx1.logger, { embedder, vectorIndex }, null);
  assert.equal(first.phases.conflicts.applied, 1, "the first cycle adjudicates the pair");
  const callsAfterFirst = ctx1.seen.length;
  assert.ok(service.findDifferentiatedPair(a.id, b.id), "the verdict landed in the ledger");

  // 第二轮：同一对、同一相似度，账本命中且两侧正文未变 → 候选在送 LLM 之前就被压掉。
  const ctx2 = captureCtx(reply);
  const second = await runSleep(ctx2, service, baseConfig({ sleepActionSet: "full" }), ctx2.logger, { embedder, vectorIndex }, null);
  assert.equal(second.phases.conflicts.status, "noop", "the phase has nothing left to adjudicate");
  assert.equal(second.phases.conflicts.suppressed, 1, "the pair is accounted for, not silently dropped");
  // 只数冲突阶段那次调用：patterns 阶段与本题无关，别把它的调用算进来。
  assert.equal(ctx2.seen.filter((p) => p.includes("冲突仲裁")).length, 0,
    "no LLM call is made for a settled pair");

  // 但这不等于「永远不再判」：一侧被改写后必须重新回到候选里。
  service.update(a.id, { content: "甲端口 的内容被改写" });
  const ctx3 = captureCtx(reply);
  const third = await runSleep(ctx3, service, baseConfig({ sleepActionSet: "full" }), ctx3.logger, { embedder, vectorIndex }, null);
  assert.ok(ctx3.seen.some((p) => p.includes("冲突仲裁")), "an edited pair is re-sent to the model");
  assert.ok(third.phases.conflicts, "the phase still runs");
  store.close();
});

test("issue#533: the audit row reports suppressed separately from 'no conflicts found'", async () => {
  const { service, store, vectorIndex } = setup();
  const { a, b } = seedPair(service, vectorIndex, "甲端口", "乙端口");
  // 先手工记一笔账（正文与相似度都没变），第二轮应报 noop + suppressed。
  applyDecisions(
    [{ action: "differentiate", ids: [a.id, b.id], distinctions: ["甲面", "乙面"] }],
    service, null, snapshotOf(store, service.getById(a.id), service.getById(b.id)), {}
  );
  const ctx = captureCtx(JSON.stringify([]));
  const result = await runSleep(ctx, service, baseConfig({ sleepActionSet: "full" }), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.status, "noop");
  assert.equal(result.phases.conflicts.reason, "all candidate pairs already differentiated");
  assert.equal(result.phases.conflicts.suppressed, 1);
  assert.equal(result.phases.conflicts.pairs, undefined, "no pair is reported as pending work");
  store.close();
});
