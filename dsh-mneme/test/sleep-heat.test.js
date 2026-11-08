import test from "node:test";
import assert from "node:assert/strict";
import { runSleep } from "../src/dream/sleep.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

// v0.7.0 待办③ sleep 降级热联合判定：
//   降级需同时满足 时间窗 + heat<sleepHeatThreshold + importance<5 三条件；
//   λ=0 的免疫类型 heat 恒 1.0 天然豁免；importance≥5 紧要记忆无论多冷都保留。
// 默认 λ 下（H=exp(-λΔt)，issue #218 广义指数）：history(0.006) 约 21 天后热值
// 跌破 0.05，project(0.0008) 约 156 天，decision(0.002) 约 62 天 —— 整体取向
// 保守，突出"冷但重要"与"热但低值"都不降级。

const DAY = 86400000;

function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service };
}

function saveMemory(service, title, content, type = "project", importance = 3) {
  return service.saveWithDedupe({ type, title, content, importance }).memory;
}

function sleepConfig(overrides = {}) {
  return {
    sleepModeEnabled: true,
    // 本组测试全部验证 heat 保护语义 → 必须显式开启（v0.7.20 起默认关）。
    heatEnabled: true,
    sleepConflictStrictness: "normal",
    sleepArchiveDays: 30,   // 30-90 天窗口 → 压缩为摘要
    sleepCompressDays: 90,  // >=90 天 → 直接归档
    sleepPatternMinMemories: 100, // 记忆数不足 → pattern 阶段跳过
    sleepMaxPatternPerRun: 3,
    ...overrides
  };
}

function mockCtx() {
  return {
    logger: { warn: () => {}, info: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "sleep-model" }) },
    llm: {
      async *stream() {
        yield { type: "text-delta", index: 0, text: "[]" };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
}

async function run(memories, service, config) {
  const now = Date.now();
  for (const [mem, daysAgo] of memories) {
    service.touchLastAccess(mem.id, new Date(now - daysAgo * DAY).toISOString());
  }
  const result = await runSleep(mockCtx(), service, config, { warn: () => {}, info: () => {} }, null, null);
  return result.phases?.["demotion"];
}

test("cold low-importance history past the compress tier archives (heat gate open)", async () => {
  const { store, service } = setup();
  const mem = saveMemory(service, "久远的会话记录", "早期讨论内容", "history", 2);
  const demotion = await run([[mem, 120]], service, sleepConfig());
  assert.ok(demotion, "demotion phase ran");
  assert.ok(demotion.archived.includes(mem.id), "120 天 ref + 热值≈e^-17.3≈0<0.05 + importance 2 → 归档");
  assert.equal(store.getById(mem.id).archived, true);
  store.close();
});

test("importance 5 protects a memory even when the heat is icy", async () => {
  const { store, service } = setup();
  const mem = saveMemory(service, "关键决策", "不可丢失的重要结论", "decision", 5);
  const demotion = await run([[mem, 400]], service, sleepConfig());
  assert.ok(demotion, "demotion phase ran");
  // decision λ=0.002, 400 天热值≈e^-19.2≈0<0.05，但 importance=5 → 保护，绝不降级。
  assert.ok(!demotion.archived.includes(mem.id), "紧要记忆不被归档");
  assert.ok(!demotion.demoted.includes(mem.id), "紧要记忆不被压缩");
  assert.equal(store.getById(mem.id).archived, false);
  store.close();
});

test("immune preference (λ=0, heat=1.0) is never demoted even when ancient", async () => {
  const { store, service } = setup();
  const mem = saveMemory(service, "用户偏好", "喜欢简洁的总结", "preference", 3);
  const demotion = await run([[mem, 400]], service, sleepConfig());
  assert.ok(!demotion.archived.includes(mem.id), "免疫类型不归档");
  assert.ok(!demotion.demoted.includes(mem.id), "免疫类型不压缩");
  assert.equal(store.getById(mem.id).archived, false);
  store.close();
});

test("slow-decay project stays heat-protected at the compress tier (λ=0.0008)", async () => {
  const { store, service } = setup();
  const mem = saveMemory(service, "项目A", "慢衰减的进行中项目", "project", 2);
  const demotion = await run([[mem, 100]], service, sleepConfig());
  // 100 天已越过 90 天归档窗，但 project 热值≈e^-1.92≈0.15>0.05 → heat 闸拦下。
  assert.ok(!demotion.archived.includes(mem.id), "慢衰减类型热值仍高 → 不归档");
  assert.equal(store.getById(mem.id).archived, false);
  store.close();
});

test("heatEnabled=false (v0.7.20 默认) 退回纯时间分层：importance 5 冷记忆也被归档", async () => {
  const { store, service } = setup();
  const mem = saveMemory(service, "紧要决策", "v0.7.12 无 heat 保护语义", "decision", 5);
  // 显式关 heat（默认值）→ phaseDemotion 不做热联合判定，纯时间分层。
  const config = sleepConfig({ heatEnabled: false });
  const demotion = await run([[mem, 400]], service, config);
  assert.ok(demotion.archived.includes(mem.id), "heat 关 → 400 天冷记忆直接归档（无 importance 保护）");
  assert.equal(store.getById(mem.id).archived, true);
  store.close();
});

test("demote tier (30-90d) fires when the type's λ is cold enough", async () => {
  const { store, service } = setup();
  const mem = saveMemory(service, "中期会话摘要", "可压缩的历史碎片", "history", 2);
  // 调高 history 的 λ 到 0.05 → 40 天热值≈e^-48≈0<0.05，解锁 30-90 天压缩窗口。
  const config = sleepConfig({ heatTypeDecay: { history: 0.05 } });
  const demotion = await run([[mem, 40]], service, config);
  assert.ok(!demotion.archived.includes(mem.id), "40 天未到归档线");
  assert.ok(demotion.demoted.includes(mem.id), "热值足够冷 + importance 2 → 压缩为摘要");
  const after = store.getById(mem.id);
  assert.ok(after._full_content, "全文停放在 _full_content");
  store.close();
});

// Issue #603 台账虚报：phaseDemotion 原来不看 demoteToSummary 的返回值、无条件
// push，于是「已经降级过的行」每轮都被选中、空转一次事务、再被记成降级了一次。
// live 库实测 12 轮里虚报 43%–99%（有一轮报 81 条、81 条全是重复）。这里钉住两件事：
//   1. 已降级的行不再进 demoted（台账不再虚报）；
//   2. 它也不再被重复处理（省掉那 138 次空事务）。
test("#603 demotion: an already-demoted memory is not reported as demoted again", async () => {
  const { store, service } = setup();
  const mem = saveMemory(service, "旧会话记录", "可压缩的历史内容", "history", 2);
  const config = sleepConfig({ heatTypeDecay: { history: 0.05 } });

  // 第一轮：真的降级一次。
  const first = await run([[mem, 40]], service, config);
  assert.ok(first.demoted.includes(mem.id), "the first run really demotes it");
  assert.ok(store.getById(mem.id)._full_content, "full text moved to _full_content");

  // 第二轮：同一行已经降级过 → 台账里不能再出现它。
  const second = await run([[mem, 40]], service, config);
  assert.equal(second.demoted.includes(mem.id), false,
    "an already-demoted row must not be reported as demoted again");
  assert.deepEqual(second.demoted, [], "the ledger must be empty, not a replay of the same row");
  assert.equal(second.status, "noop", "nothing happened, so the phase is a noop");
  store.close();
});

// 与上一条互补：被 demoteToSummary 的 minRefTimeMs 挡下（快照之后被 recall 摸热）
// 也返回 undefined。这种「判定该降、实际没动」必须单独报出来，不能混进 demoted。
test("#603 demotion: a row the freshness guard spares is counted as skipped, not demoted", async () => {
  const { store, service } = setup();
  const mem = saveMemory(service, "刚被摸过的记录", "正文内容", "history", 2);
  const config = sleepConfig({ heatTypeDecay: { history: 0.05 } });

  // 把 demoteToSummary 包一层，模拟「事务内发现这行刚被 recall 摸热」→ 返回 undefined。
  const realDemote = service.demoteToSummary.bind(service);
  let touched = 0;
  service.demoteToSummary = (...args) => {
    touched++;
    return undefined;
  };

  const demotion = await run([[mem, 40]], service, config);
  service.demoteToSummary = realDemote;

  assert.ok(touched > 0, "the demote path was attempted");
  assert.equal(demotion.demoted.includes(mem.id), false, "nothing landed, so nothing is reported as demoted");
  assert.equal(demotion.demoteSkipped, 1, "the spared row is reported separately");
  assert.equal(demotion.status, "noop", "no work landed");
  store.close();
});