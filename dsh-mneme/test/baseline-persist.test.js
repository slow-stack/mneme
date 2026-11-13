import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createDreamScheduler } from "../src/dream.js";
import { testConfig } from "./helpers/test-config.js";

// 回归（issue #89 基线半边）：阈值基线 baseline{count,chars} 只活在调度器闭包里，
// 进程重启归零。库里记忆远多于阈值时，重启后第一条写入（更新类写入同样计入
// notifyWrite）就让 overBase 成立，绕过阈值开跑一整轮巩固——0.8.11 实测四次重启
// 分别只新增 6/7/0/8 条记忆（阈值 10 条 / 5000 字符），每轮约 16 万 tokens。
// #291 只持久化了 lastRunAt（时间闸门那半边），本文件锁另一半：
//   1. lastDreamBaseline 只认「成功轮落下的完整基线」，按 run_type 隔离；
//   2. 播种后重启不再绕过阈值——同库同写入的无种子对照组仍触发，锁的正是这个差异；
//   3. 播种不妨碍阈值正常累积（计数长到 +10 仍然触发）；
//   4. runDream 成功轮把基线落库并回给调度器（进程内刷新与跨重启播种同一份数字）；
//   5. 老库两列由幂等迁移补上，存量行认不出基线 → 退回零基线（升级前行为）。

/** 与阈值判定同口径的活跃库规模（测试侧独立实现，避免与被测代码共用一份过滤条件）。 */
function activeSize(store) {
  const rows = store.all().filter((m) => !m.archived && m.type !== "summary" && m.type !== "document");
  return {
    count: rows.length,
    chars: rows.reduce((sum, m) => sum + m.title.length + m.content.length, 0)
  };
}

function seedMemories(service, n, tag = "a") {
  // 标题必须全局唯一：saveWithDedupe 的去重键是 type+title+scope，同名会被合并成
  // 同一条（条数不增长），「累计到阈值」的断言就会假失败。
  for (let i = 0; i < n; i++) {
    service.saveWithDedupe({ type: "history", title: `${tag}-${i}`, content: "x".repeat(300), importance: 3 });
  }
}

test("issue#89: store.lastDreamBaseline reads the last baseline-advancing run only", () => {
  const store = createStore(":memory:");
  assert.equal(store.lastDreamBaseline(), null, "empty trail → null (never ran)");
  // 非 ok 轮不推进基线（既有语义）→ 不落这两列，播种端必须无视它
  store.saveDreamRun({ status: "failed", snapshot_hash: "h0", input_count: 1, receipt: "r0", created_at: "2026-09-30T10:00:00.000Z", run_type: "auto" });
  assert.equal(store.lastDreamBaseline("auto"), null, "failed run carries no baseline");
  store.saveDreamRun({ status: "ok", snapshot_hash: "h1", input_count: 1, receipt: "r1", created_at: "2026-09-30T10:01:00.000Z", run_type: "auto", store_count: 4, store_chars: 400 });
  assert.deepEqual(store.lastDreamBaseline("auto"), { count: 4, chars: 400 });
  // sleep/organize 的轮次不参与 auto 的阈值判定
  store.saveDreamRun({ status: "ok", snapshot_hash: "h2", input_count: 1, receipt: "r2", created_at: "2026-09-30T10:02:00.000Z", run_type: "sleep", store_count: 9, store_chars: 900 });
  assert.deepEqual(store.lastDreamBaseline("auto"), { count: 4, chars: 400 }, "sleep rows are filtered out of the auto baseline");
  assert.deepEqual(store.lastDreamBaseline("sleep"), { count: 9, chars: 900 });
  // 半个基线（只有条数没有字符数）写入侧就该拒绝：否则阈值会按 0 字符起算
  store.saveDreamRun({ status: "ok", snapshot_hash: "h3", input_count: 1, receipt: "r3", created_at: "2026-09-30T10:03:00.000Z", run_type: "auto", store_count: 7 });
  assert.deepEqual(store.lastDreamBaseline("auto"), { count: 4, chars: 400 }, "half a baseline is not accepted");
  store.close();
});

test("issue#89: a seeded baseline survives a restart — the first write no longer bypasses the threshold", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  seedMemories(service, 12); // 条数与字符数都远超阈值（12 ≥ 10 条）
  // 上一进程的成功轮把「当时的库规模」落进审计表，然后进程重启：
  const size = activeSize(store);
  store.saveDreamRun({
    status: "ok", snapshot_hash: "h", input_count: 1, receipt: "r",
    created_at: new Date(Date.now() - 10).toISOString(), run_type: "auto",
    store_count: size.count, store_chars: size.chars
  });
  const opts = { onRun: async () => ({ ok: false }), thresholdCount: 10, thresholdChars: 5000, delayMs: 0, logger: { warn: () => {} } };
  const seeded = createDreamScheduler({ ...opts, baselineSeed: store.lastDreamBaseline("auto") });
  assert.equal(seeded.maybeSchedule(service), false, "seeded baseline blocks the first write after restart");
  // 对照组：同一个库、同一次写入，没有种子就是被修掉的那个缺陷。若哪天播种被忽略，
  // 上面那条断言会与这条同真同假——所以两条必须成对存在。
  const unseeded = createDreamScheduler(opts);
  assert.equal(unseeded.maybeSchedule(service), true, "without the seed the threshold is bypassed (the defect this test locks)");
  await unseeded.dispose(); // 清掉 0ms 待跑计时器，别让对照组真开跑
  store.close();
});

test("issue#89: a seeded baseline still lets the threshold accumulate", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  seedMemories(service, 12);
  const dream = createDreamScheduler({
    onRun: async () => ({ ok: false }), thresholdCount: 10, thresholdChars: 5000, delayMs: 0,
    baselineSeed: activeSize(store), logger: { warn: () => {} }
  });
  seedMemories(service, 5, "b");
  assert.equal(dream.maybeSchedule(service), false, "half the threshold is not enough");
  seedMemories(service, 5, "c"); // 累计 +10 条
  assert.equal(dream.maybeSchedule(service), true, "the threshold still fires once the store grew by it");
  await dream.dispose();
  store.close();
});

test("issue#89: the run-reported baseline is what the scheduler keeps (single source of truth)", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  seedMemories(service, 12);
  const reported = { count: 50, chars: 50000 };
  const dream = createDreamScheduler({
    onRun: async () => ({ ok: true, baseline: reported }),
    thresholdCount: 10, thresholdChars: 5000, delayMs: 0, logger: { warn: () => {} }
  });
  assert.equal(dream.maybeSchedule(service), true, "no seed yet → the first run is allowed");
  await new Promise((r) => setTimeout(r, 10)); // 让 run 收尾并刷新基线
  // 运行后再长 15 条：若调度器改用「现场计算」的基线（12），这里会触发；用 run
  // 自报的 50 则不触发。这条差异就是「审计行与内存基线同一份数字」的锁。
  seedMemories(service, 15, "grow");
  assert.equal(dream.maybeSchedule(service), false, "the persisted-reported baseline governs, not the live store size");
  await dream.dispose();
  store.close();
});

test("issue#89: an ok run persists its post-run store size; a failed run persists none", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const a = service.saveWithDedupe({ type: "project", title: "旧1", content: "第一段内容" });
  const b = service.saveWithDedupe({ type: "project", title: "旧2", content: "第二段内容" });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0, logger: { warn: () => {} } });

  // 失败轮（无路由）：不能留下任何基线——否则重启播种会拿到一个「没推进过」的假基线
  const failed = await dream.runDream({ llm: { stream: async function* () {} }, logger: { warn: () => {} } }, service, {});
  assert.equal(failed.ok, false, "no route → failed run");
  assert.equal(failed.baseline, undefined, "failed run reports no baseline");
  assert.equal(store.lastDreamBaseline("auto"), null, "failed run persists no baseline");

  // 成功轮：落库的数字 = 本轮结束后的活跃库规模（合并已归档一方，summary 不计入）
  let calls = 0;
  const ctx = {
    llm: {
      stream: async function* () {
        calls++;
        const text = calls === 1
          ? JSON.stringify([{ action: "merge", ids: [a.memory.id, b.memory.id], title: "合并标题", content: "合并后的内容", importance: 4, keepSource: a.memory.id }])
          : "记忆库总览摘要文本";
        yield { type: "text-delta", text };
        yield { type: "finish", reason: { kind: "ok" } };
      }
    },
    logger: { warn: () => {} }
  };
  const ok = await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat" });
  assert.equal(ok.ok, true, "run with decisions + summary is ok");
  const expected = activeSize(store);
  assert.deepEqual(ok.baseline, expected, "the run reports the post-run store size");
  assert.deepEqual(store.lastDreamBaseline("auto"), expected, "the audit row carries the same numbers");
  store.close();
});

test("issue#89: legacy dream_runs gains the baseline columns on open (idempotent ALTER)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-baseline-migrate-"));
  const dbPath = join(dir, "legacy.db");
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE dream_runs (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
      provider TEXT, model TEXT, snapshot_hash TEXT NOT NULL, input_count INTEGER NOT NULL,
      input TEXT, decisions TEXT, outcome TEXT, applied INTEGER NOT NULL DEFAULT 0,
      summary_stored INTEGER NOT NULL DEFAULT 0, receipt TEXT NOT NULL,
      policy_epoch INTEGER NOT NULL DEFAULT 0, run_type TEXT NOT NULL DEFAULT 'auto', skipped TEXT
    );`);
    legacy.prepare(
      `INSERT INTO dream_runs (id, created_at, status, snapshot_hash, input_count, applied, summary_stored, receipt)
       VALUES ('legacy', '2026-09-30T10:00:00.000Z', 'ok', 'h', 1, 0, 0, 'r')`
    ).run();
    legacy.close();

    const store = createStore(dbPath);
    const cols = store.db.prepare("PRAGMA table_info(dream_runs)").all().map((c) => c.name);
    assert.ok(cols.includes("store_count") && cols.includes("store_chars"), "baseline columns added to legacy db");
    // 存量行两列皆 NULL：反推不出「那轮结束时库有多大」，认不出就不认——退回零基线
    assert.equal(store.lastDreamBaseline("auto"), null, "legacy rows carry no baseline");
    store.close();

    const again = createStore(dbPath); // 二次打开：ALTER 幂等，不抛 duplicate column
    assert.equal(again.lastDreamBaseline("auto"), null);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("issue#89: an unusable seed is treated as no baseline at all", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  seedMemories(service, 12);
  const opts = { onRun: async () => ({ ok: false }), thresholdCount: 10, thresholdChars: 5000, delayMs: 0, logger: { warn: () => {} } };
  // 库里的持久化值可能是老库的 NULL、或手工改坏的库：半个基线（只有条数）若被当成
  // 「12 条 0 字符」，阈值会按 0 字符起算——比不认还糟。非法种子一律退回零基线。
  for (const bad of [{ count: 12 }, { chars: 2000 }, { count: -1, chars: 2000 }, { count: 1.5, chars: 10 }, "nope"]) {
    const sched = createDreamScheduler({ ...opts, baselineSeed: bad });
    assert.equal(sched.maybeSchedule(service), true, `unusable seed ${JSON.stringify(bad)} falls back to the zero baseline`);
    sched.dispose();
  }
  store.close();
});

test("issue#89: a failing baseline read never breaks the run nor fakes a baseline", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const a = service.saveWithDedupe({ type: "project", title: "旧1", content: "第一段内容" });
  // finish 阶段读库失败（关库 / IO 故障）：必须不反噬巩固本身（审计行照写），也不
  // 写一个猜出来的基线（落 NULL → 下次重启退回零基线，而不是拿假基线抬高阈值）。
  // 故障点在「总览出文本之后」才武装：runDream 前面还要读两次库（候选集与总览输入），
  // 过早抛错会把整轮打成 failed，验的就不是收尾取证这条路了。
  const realAll = service.all.bind(service);
  let armed = false;
  let calls = 0;
  service.all = () => {
    if (armed) throw new Error("store closed");
    return realAll();
  };
  const ctx = {
    llm: {
      stream: async function* () {
        if (calls++ === 0) {
          yield { type: "text-delta", text: JSON.stringify([{ action: "keep", ids: [a.memory.id] }]) };
        } else {
          armed = true;
          yield { type: "text-delta", text: "记忆库总览摘要文本" };
        }
        yield { type: "finish", reason: { kind: "ok" } };
      }
    },
    logger: { warn: () => {} }
  };
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0, logger: { warn: () => {} } });
  const ok = await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat" });
  assert.equal(ok.ok, true, "the run still completes when the baseline read fails");
  assert.equal(ok.baseline, undefined, "no made-up baseline is reported");
  assert.ok(store.listDreamRuns({ limit: 1 })[0], "the audit row is still written");
  assert.equal(store.listDreamRuns({ limit: 1 })[0].store_count, undefined, "the audit row carries no baseline");
  store.close();
});

// --- CodeRabbit 在 #291 上的同类要求：index.js 的 seed 是单行无分支接线，仓库没有
// 插件级挂载 harness（apply 需要完整宿主 ctx），改为源码级锁——删掉该注入行即红。
// import 用 URL 相对本文件解析，不依赖测试进程 CWD。
const indexSrc = readFileSync(fileURLToPath(new URL("../src/index.js", import.meta.url)), "utf8");

test("issue#89: index.js wires the dream baseline seed from the audit trail", () => {
  assert.match(
    indexSrc,
    /baselineSeed:\s*store\.lastDreamBaseline\("auto"\)/,
    "dream scheduler must seed its threshold baseline from dream_runs (run_type='auto') — remove this line and the restart-bypass returns"
  );
});
