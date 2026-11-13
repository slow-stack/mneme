import test from "node:test";
import assert from "node:assert/strict";
import { runSleep } from "../src/dream/sleep.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { testConfig } from "./helpers/test-config.js";

// v0.7.0 语义修正（待办④ updated_at 不算访问）：
//  - merge/update 刷 updated_at 绝不当访问，last_accessed_at 与 updated_at 正交；
//  - sleep 降级 ref 只用 last_accessed_at ?? created_at，杜绝 autoDream 合并
//    动作把"刚更新过内容"伪装成"刚被召回"；
//  - 触达数据采集（touchRecalled）由 heatEnabled 控制，不再依赖 sleepModeEnabled。

const DAY = 86400000;

function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig(config) });
  return { store, service };
}

function saveMemory(service, title, content, type = "project") {
  return service.saveWithDedupe({ type, title, content, importance: 3 }).memory;
}

test("store.update bumps updated_at but never last_accessed_at", () => {
  const { store, service } = setup();
  const mem = saveMemory(service, "项目A", "状态：进行中");
  assert.equal(mem.last_accessed_at, undefined, "saved memory has no last_accessed_at");

  const touched = service.touchLastAccess(mem.id, new Date(Date.now() - 5 * DAY).toISOString());
  assert.equal(touched, true, "explicit touch succeeds");
  const afterTouch = store.getById(mem.id);
  assert.ok(afterTouch.last_accessed_at, "last_accessed_at set after touch");

  const updatedAtBefore = afterTouch.updated_at;
  store.update(mem.id, { content: "状态：已交付" });
  const afterUpdate = store.getById(mem.id);
  assert.notEqual(afterUpdate.updated_at, updatedAtBefore, "updated_at changed by update");
  assert.equal(
    afterUpdate.last_accessed_at,
    afterTouch.last_accessed_at,
    "last_accessed_at untouched by update (content change ≠ access)"
  );
  store.close();
});

test("search bumps last_accessed_at with heatEnabled on, and is gated off by heatEnabled=false", async () => {
  // 显式开启 heat（v0.7.20 起默认关）：last_accessed_at 被采集（与 sleep 开关解耦）。
  const a = setup({ heatEnabled: true });
  saveMemory(a.service, "量子计算", "入门");
  await a.service.searchMemories("量子", { mode: "keyword" });
  const rowA = a.store.getById(a.service.all()[0].id);
  assert.ok(rowA.last_accessed_at, "touch runs when heatEnabled is true even when sleepModeEnabled off");
  a.store.close();

  // heatEnabled=false（默认值）→ 热路径零写入。
  const b = setup({ heatEnabled: false });
  saveMemory(b.service, "量子计算", "入门");
  await b.service.searchMemories("量子", { mode: "keyword" });
  const rowB = b.store.getById(b.service.all()[0].id);
  assert.equal(rowB.last_accessed_at, undefined, "no touch when heatEnabled=false");
  b.store.close();
});

test("sleep demotion anchors on last_accessed_at — a merge-bumped updated_at does not reset the fresh clock", async () => {
  const { store, service } = setup();
  const now = Date.now();
  const idle = saveMemory(service, "冷查记忆A", "很久没被召回");
  // 模拟一次 autoDream 合并：updated_at 刷成"现在"，但真实访问在 100 天前。
  store.update(idle.id, { content: "合并带来的内容更新" });
  const wait = saveMemory(service, "冷查记忆B", "40 天未访问");

  service.touchLastAccess(idle.id, new Date(now - 100 * DAY).toISOString());
  service.touchLastAccess(wait.id, new Date(now - 40 * DAY).toISOString());

  // runSleep 的最低配置：demotion 阶段不需要 LLM/语义，其余阶段会 skip。
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "sleep-model" }) },
    llm: {
      async *stream() {
        yield { type: "text-delta", index: 0, text: "[]" };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
  const config = {
    sleepModeEnabled: true,
    sleepConflictStrictness: "normal",
    sleepArchiveDays: 30,
    sleepCompressDays: 90,
    sleepPatternMinMemories: 100,
    sleepMaxPatternPerRun: 3,
    // v0.7.0 热联合判定：project λ=0.0008 默认太慢衰减，40/100 天热值都高于
    // 阈值、被热闸保护——本测试只验证"updated_at 不算访问"的 ref 语义，故把
    // λ 调快到 0.02 打开降级路径（默认保守语义由 sleep-heat.test.js 覆盖）。
    heatTypeDecay: { project: 0.02 }
  };

  const result = await runSleep(ctx, service, config, { warn: () => {}, info: () => {} }, null, null);

  const demotion = result.phases?.["demotion"];
  assert.ok(demotion, "demotion phase ran");
  // A：last_accessed 100 天前（即使 updated_at 是"现在"）→ 越过 90 天归档线。
  assert.ok(demotion.archived.includes(idle.id), "A archived by last_accessed_at (updated_at ignored)");
  const afterA = store.getById(idle.id);
  assert.equal(afterA.archived, true, "A is archived in store");
  // B：last_accessed 40 天前 → 进入 30 天压缩窗口，被降级为摘要。
  assert.ok(demotion.demoted.includes(wait.id), "B demoted in 30d compress window");
  const afterB = store.getById(wait.id);
  assert.ok(afterB._full_content, "B full body parked in _full_content");
  store.close();
});
