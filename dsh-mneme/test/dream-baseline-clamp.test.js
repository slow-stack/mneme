import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createDreamScheduler } from "../src/dream.js";
import { testConfig } from "./helpers/test-config.js";

// 回归（issue #634）：阈值基线只在成功轮前进（dream_runs 落库 + 调度器闭包），而
// 归档/删除/合并把活跃量压下去——活跃量一旦跌破基线，overBase 恒为假，从此再
// 也不会巩固，且全程静默（报告实测停摆 13 天 / 22 小时零轮：末轮基线 1,475 条，
// 归档后活跃 798 条，门槛 ≥1,485 永不满足）。修法是判定口夹回：活跃量跌破基线的
// 轴取 min，阈值从新的低点重新起算，归掉的量不必重新长回来。本文件锁四个面：
//   1. 活着的调度器亲历收缩：归档压破基线后，重新增长阈值量仍能触发（停摆反例）；
//   2. 重启后旧峰值种子在第一次判定被夹回——不落库也能自愈（收缩不触发
//      notifyWrite，调度器本来就无从在归档当下得知，判定口是唯一可靠的收敛处）；
//   3. 夹回事件走 auditBaselineClamp 记账：每次收缩周期至多一次、不收缩不记；
//   4. 两轴独立夹回：只缩字符不缩条数时，条数轴的基线不动。

/** 与阈值判定同口径的活跃库规模（测试侧独立实现，避免与被测代码共用一份过滤条件）。 */
function activeSize(store) {
  const rows = store.all().filter((m) => !m.archived && m.type !== "summary" && m.type !== "document");
  return {
    count: rows.length,
    chars: rows.reduce((sum, m) => sum + m.title.length + m.content.length, 0)
  };
}

function seedMemories(service, n, tag = "a") {
  // 标题必须全局唯一（saveWithDedupe 的去重键是 type+title+scope，同名会合并成
  // 同一条），「累计到阈值」的断言才会真涨。
  for (let i = 0; i < n; i++) {
    service.saveWithDedupe({ type: "history", title: `${tag}-${i}`, content: "x".repeat(300), importance: 3 });
  }
}

/** 把「上次成功轮的库规模」落进 dream_runs——调度器重启后读到的就是这份种子。 */
function persistBaseline(store) {
  const size = activeSize(store);
  store.saveDreamRun({
    status: "ok", snapshot_hash: "h", input_count: 1, receipt: "r",
    created_at: new Date(Date.now() - 10).toISOString(), run_type: "auto",
    store_count: size.count, store_chars: size.chars
  });
  return size;
}

function makeOpts(store, overrides = {}) {
  return {
    onRun: async () => ({ ok: false }),
    thresholdCount: 10, thresholdChars: 5000, delayMs: 0,
    baselineSeed: store.lastDreamBaseline("auto"),
    logger: { warn: () => {} },
    ...overrides
  };
}

/** 把活跃行里除 excludeTag 外的前 n 条归档（归档不触发 notifyWrite，这正是 #634 的一部分）。 */
function archiveRows(service, store, n, excludeTag = null) {
  const rows = store.all().filter((m) => !m.archived && (excludeTag === null || !m.title.startsWith(excludeTag)));
  for (const m of rows.slice(0, n)) service.setArchived(m.id, true);
}

test("issue#634: a live scheduler survives an archive below the baseline (the freeze, unlocked)", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  seedMemories(service, 12);
  const baseline = persistBaseline(store);
  const dream = createDreamScheduler(makeOpts(store));
  assert.equal(dream.maybeSchedule(service), false, "no growth since the last run → no trigger");
  // 收缩发生在两次写入之间：归档 10 条，活跃 2 条 < 基线 12 条。
  archiveRows(service, store, 10);
  assert.ok(activeSize(store).count < baseline.count, "precondition: archive pulled active below the baseline");
  // 收缩后的第一次写入把基线夹回当前水平（2+1=3），此后按新的低点起算。
  seedMemories(service, 1, "g");
  assert.equal(dream.maybeSchedule(service), false, "the first post-shrink write clamps instead of triggering");
  seedMemories(service, 9, "p");
  assert.equal(dream.maybeSchedule(service), false, "+9 from the clamped level is still below the threshold");
  seedMemories(service, 1, "q"); // 夹回后的第 +10 条
  assert.equal(dream.maybeSchedule(service), true, "+10 past the clamp fires — pre-fix this stayed silent forever");
  await dream.dispose();
  store.close();
});

test("issue#634: a stale peak seed from dream_runs is clamped on the first judgement after restart", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  seedMemories(service, 12);
  persistBaseline(store);
  // 收缩发生在上一进程末轮之后、重启之前（归档不 notifyWrite，调度器无从得知）：
  // dream_runs 里的种子还是那个峰值。
  archiveRows(service, store, 10);
  const dream = createDreamScheduler(makeOpts(store));
  // 重启后第一条写入：先把旧峰值种子夹回当前水平，再谈阈值。
  seedMemories(service, 1, "r");
  assert.equal(dream.maybeSchedule(service), false, "the restart write clamps the stale seed instead of bypassing");
  seedMemories(service, 9, "s");
  assert.equal(dream.maybeSchedule(service), false, "+9 from the clamped level is still below the threshold");
  seedMemories(service, 1, "t");
  assert.equal(dream.maybeSchedule(service), true, "the clamp makes the threshold reachable again without re-growing archived rows");
  await dream.dispose();
  store.close();
});

test("issue#634: the clamp is audited exactly once per shrink episode, and never without one", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const clamps = [];
  seedMemories(service, 12);
  const baseline = persistBaseline(store);
  const dream = createDreamScheduler(makeOpts(store, {
    auditBaselineClamp: ({ previous, count, chars }) => clamps.push({ previous, count, chars })
  }));
  // 不收缩的写入：正常增长（13 > 12），既不夹回也不记账。
  seedMemories(service, 1, "n");
  assert.equal(dream.maybeSchedule(service), false);
  assert.equal(clamps.length, 0, "no clamp audit without a shrink");
  // 归档压破基线（12→2），收缩后第一次判定夹回并记一次账。
  archiveRows(service, store, 10, "n-");
  seedMemories(service, 1, "p");
  assert.equal(dream.maybeSchedule(service), false);
  assert.equal(clamps.length, 1, "the shrink episode produces exactly one clamp audit");
  assert.deepEqual(clamps[0].previous, baseline, "previous = the stale peak baseline");
  assert.equal(clamps[0].count, activeSize(store).count, "count/chars = the clamped (current active) level");
  assert.equal(clamps[0].chars, activeSize(store).chars, "chars axis is clamped to the same level");
  // 同一收缩周期内活跃只增不减：不再重复记账（夹回后基线 == 活跃量）。
  seedMemories(service, 5, "u");
  assert.equal(dream.maybeSchedule(service), false, "still below the threshold from the clamped level");
  assert.equal(clamps.length, 1, "no repeated clamp audits while active only grows");
  await dream.dispose();
  store.close();
});

test("issue#634: the clamp is per-axis — a chars-only shrink leaves the count baseline alone", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  seedMemories(service, 12);
  const baseline = persistBaseline(store);
  const clamps = [];
  const dream = createDreamScheduler(makeOpts(store, {
    auditBaselineClamp: (event) => clamps.push(event)
  }));
  // 更新类写入（同 type+title+scope 命中去重键）把一条换成短内容：条数不动、字符缩。
  // 去重命中默认 appendContent（追加），只有显式 _overwrite 才替换——不加的话
  // 字符数反而变多，这条用例的前置就不成立了。
  service.saveWithDedupe({ type: "history", title: "a-0", content: "短", _overwrite: true, importance: 3 });
  assert.equal(activeSize(store).count, baseline.count, "precondition: the count axis did not move");
  assert.ok(activeSize(store).chars < baseline.chars, "precondition: the chars axis shrank");
  assert.equal(dream.maybeSchedule(service), false, "the threshold itself is not met yet");
  assert.equal(clamps.length, 1, "a chars-only shrink still clamps");
  assert.equal(clamps[0].previous.count, baseline.count, "the count baseline was intact before the clamp");
  assert.equal(clamps[0].count, baseline.count, "the count baseline survives — only the shrunken axis moves");
  assert.ok(clamps[0].chars < clamps[0].previous.chars, "the chars baseline is clamped down");
  await dream.dispose();
  store.close();
});

// --- CodeRabbit 在 #291 上的同类要求（源码级锁）：index.js 的接线是单行注入，仓库
// 没有插件级挂载 harness（apply 需要完整宿主 ctx），删掉该注入行不会让任何单测变
// 红——所以用正则锁注入本身。import 用 URL 相对本文件解析，不依赖测试进程 CWD。
const indexSrc = readFileSync(fileURLToPath(new URL("../src/index.js", import.meta.url)), "utf8");

test("issue#634: index.js wires the baseline-clamp audit into llm_audit_logs", () => {
  assert.match(
    indexSrc,
    /auditBaselineClamp:/,
    "the clamp callback must be wired at assembly — otherwise clamp events stay unobservable (the #634 silence)"
  );
  assert.match(
    indexSrc,
    /error_message:\s*"baseline-clamp"/,
    "the audit row must carry the baseline-clamp marker so it can be told apart from peak-hours skips"
  );
});
