// #557：dream_runs 重载列的启动期裁剪（dreamRunsTrimDays）。
//
// 这张表此前是四个 *RetentionDays 都不覆盖的无界增长大户：单行 input 快照体量
// 随记忆数涨、轮数随天数涨，两个因子相乘超线性（报告库占约 43% 的页）。拍板 3
// 的边界是「裁列同意、删行不同意」，所以本批锁三件事：
// 1. 行为锁——窗口外的行被裁掉三列、行还在；窗口内不动；organize 整体豁免。
// 2. 幂等锁——重跑一次 changes 为 0，不重复改写（启动期每次都会调）。
// 3. 接线锁——index.js 读装配后的 cfg、opt-in（0 不裁）、失败只 warn 不挡启动。
//    启动期清理只在运维时才跑到，运行时冒烟测不到「这一行被挪回装配之前了」，
//    所以用源码文本断言（与 failure-retention / recall-retention 同款）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "../src/config.js";
import { createStore } from "../src/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcText = (name) => readFileSync(join(here, "..", "src", name), "utf8");
const DAY = 86400000;
const NOW = Date.parse("2026-11-12T00:00:00.000Z");
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();

function seedRun(store, id, createdAt, overrides = {}) {
  store.saveDreamRun({
    id,
    created_at: createdAt,
    status: "ok",
    snapshot_hash: `h-${id}`,
    input_count: 1,
    input: JSON.stringify([{ id: "m1", type: "project", title: "t", content: "x".repeat(400) }]),
    decisions: JSON.stringify([{ action: "keep", ids: ["m1"] }]),
    outcome: JSON.stringify({ byId: { m1: "keep" } }),
    receipt: `dsh-mneme:run:${id}:ok:h-${id}`,
    ...overrides,
  });
}

const raw = (store, id) =>
  store.db.prepare("SELECT input, decisions, outcome, status, snapshot_hash, receipt, run_type, applied FROM dream_runs WHERE id = ?").get(id);
const allIds = (store) =>
  store.db.prepare("SELECT id FROM dream_runs ORDER BY id").all().map((r) => r.id);

test("裁列：窗口外的 run 三列置空、行与骨架列完好；窗口内一行不动", () => {
  const store = createStore(":memory:");
  seedRun(store, "old", daysAgo(200));
  seedRun(store, "fresh", daysAgo(1));
  const before = raw(store, "old");

  const changed = store.trimDreamRunPayloads(daysAgo(90));
  assert.equal(changed, 1, "只有窗口外那一行被裁");

  const oldRow = raw(store, "old");
  assert.equal(oldRow.input, null);
  assert.equal(oldRow.decisions, null);
  assert.equal(oldRow.outcome, null);
  // 删行不同意的形状锁：行还在，骨架与 receipt 一列不动（离线回放降级为骨架级，
  // 不是「这一轮没跑过」）。
  assert.deepEqual(allIds(store), ["fresh", "old"], "行永不删");
  for (const col of ["status", "snapshot_hash", "receipt", "run_type", "applied"]) {
    assert.equal(oldRow[col], before[col], `${col} 是骨架列，裁列不许动它`);
  }
  // 窗口内完全不动
  const freshRow = raw(store, "fresh");
  assert.notEqual(freshRow.input, null);
  assert.notEqual(freshRow.decisions, null);
  assert.notEqual(freshRow.outcome, null);
  store.close();
});

test("organize 行整体豁免：input 是 apply 的重放载荷，窗口外也不许裁", () => {
  const store = createStore(":memory:");
  seedRun(store, "organize-old", daysAgo(200), {
    run_type: "organize",
    input: JSON.stringify([{ index: 0, candidate: { type: "project", title: "候选", content: "正文" } }]),
    outcome: JSON.stringify({ dry_run_id: "organize-old" }),
  });
  seedRun(store, "auto-old", daysAgo(200));

  assert.equal(store.trimDreamRunPayloads(daysAgo(90)), 1, "只裁 auto 行");
  const org = raw(store, "organize-old");
  assert.notEqual(org.input, null, "organize 的 input 必须留下（否则 apply 静默空转）");
  assert.notEqual(org.outcome, null, "organize 的 outcome 挂着 dry_run_id / applied_at 链");
  assert.equal(raw(store, "auto-old").input, null);
  store.close();
});

test("幂等：重跑一次 changes 为 0（启动期每次都调，不能每次重写整批行）", () => {
  const store = createStore(":memory:");
  seedRun(store, "old", daysAgo(200));
  assert.equal(store.trimDreamRunPayloads(daysAgo(90)), 1);
  assert.equal(store.trimDreamRunPayloads(daysAgo(90)), 0, "第二次没有可裁的行");
  store.close();
});

test("统计与裁剪同口径：stats 的 runs/bytes 覆盖的全是裁得掉的行", () => {
  const store = createStore(":memory:");
  seedRun(store, "old-a", daysAgo(300));
  seedRun(store, "old-b", daysAgo(120));
  seedRun(store, "fresh", daysAgo(2));
  seedRun(store, "org", daysAgo(300), { run_type: "organize" });

  const stats = store.dreamRunsTrimStats(daysAgo(90));
  assert.equal(stats.runs, 2, "窗口外两条 auto 行；organize 与窗口内都不算");
  assert.ok(stats.bytes > 0, "字节数是三列之和，非零");
  // 报告的数字必须与执行的数字同源——否则 dry-run 里报 2 条、真跑裁 1 条
  assert.equal(store.trimDreamRunPayloads(daysAgo(90)), stats.runs);
  assert.equal(store.dreamRunsTrimStats(daysAgo(90)).runs, 0, "裁完再统计为 0");
  store.close();
});

test("空表 / 没有可裁行时返回 0 且不抛", () => {
  const store = createStore(":memory:");
  assert.equal(store.trimDreamRunPayloads(daysAgo(90)), 0);
  seedRun(store, "fresh", daysAgo(1));
  assert.equal(store.trimDreamRunPayloads(daysAgo(90)), 0);
  store.close();
});

test("配置键 dreamRunsTrimDays：opt-in 默认 0、单位是天、边界钉死", () => {
  assert.equal(Config({}).dreamRunsTrimDays, 0, "默认不裁——升级后的行为必须逐字节不变");
  assert.equal(Config({ dreamRunsTrimDays: 7 }).dreamRunsTrimDays, 7);
  assert.equal(Config({ dreamRunsTrimDays: 3650 }).dreamRunsTrimDays, 3650);
  assert.throws(() => Config({ dreamRunsTrimDays: -1 }), "负数没有意义");
  assert.throws(() => Config({ dreamRunsTrimDays: 3651 }));
  assert.throws(() => Config({ dreamRunsTrimDays: 2.5 }));
  // 形状锁：与 recallRetentionDays 一族同形（顶层扁平键 + natural + 上限 3650）。
  // 下限刻意是 0 而不是 1——0 = 关，这一族里唯一以「关」为默认值的键。
  assert.match(srcText("config.js"), /dreamRunsTrimDays: z\.natural\(\)\.min\(0\)\.max\(3650\)\.default\(0\)/);
  for (const doc of ["README.md", "docs/CONFIGURATION.md"]) {
    const text = readFileSync(join(here, "..", doc), "utf8");
    assert.ok(text.includes("`dreamRunsTrimDays`"), `${doc} 必须列出 dreamRunsTrimDays（加键不改文档正是这一族的欠账来源）`);
  }
});

test("接线锁：index.js 读装配后的 cfg、0 不裁、失败只 warn", () => {
  const index = srcText("index.js");
  const callAt = index.indexOf("store.trimDreamRunPayloads(");
  assert.ok(callAt > 0, "index.js 必须调用 store.trimDreamRunPayloads");
  // 面板/预设合进来的值只有装配后可见——这族四个键的清理全都读 cfg 而不是 rawCfg
  const cfgAt = index.indexOf("const cfg = { ...applyLightModePreset(");
  assert.ok(cfgAt > 0 && cfgAt < callAt, "裁剪必须排在 cfg 装配之后");
  const block = index.slice(callAt - 900, callAt + 400);
  assert.match(block, /cfg\.dreamRunsTrimDays/, "窗口必须取自配置键");
  assert.match(block, /dreamRunsTrimDays > 0/, "0 = 关：不许把「没配」读成「裁今天以前的」");
  assert.match(block, /Number\.isInteger\(/, "非法值要能落回默认，别让 NaN 传给 SQL");
  assert.match(block, /dreamRunsTrimDays \* 86400000/, "键的单位是天，换算在这儿");
  assert.match(block, /catch/, "失败必须兜住");
  // 「只 warn」不是修辞：这族清理唯一的事后线索就是那行日志；而 warn 必须在
  // catch 里、不能反过来挡住启动。
  assert.match(block, /logger\?\.warn\?\./, "失败要出声");
});