import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createMaintenance } from "../src/maintenance.js";
import { createStandaloneApi } from "../src/api-standalone.js";

// #275 存储生命周期第一批：无损回收的手动入口。
// 这一批的验收就三条：dry-run 一个字节都不改（数字与执行出自同一处统计）；执行时只丢
// 「可由记忆库重建的输入快照」与「检索按定义不可达的归档行向量」，行数不变、决策原文
// 留住、活跃行向量留住；收益按 VACUUM 前后体积量，不按列字节估。

const NOW = Date.parse("2026-09-24T00:00:00.000Z");
const DAY = 86400000;
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.mjs");
// 服务跑在本进程里，所以子进程必须**异步**起：spawnSync 会堵住事件循环，服务就永远
// 回不了应答，CLI 只会等到自己的 10s 超时（自造死锁）。
const runCli = promisify(execFile);

function fileStore() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-reclaim-"));
  const store = createStore(join(dir, "memory.db"));
  return {
    store,
    // 闭包拿 store，不用 this：裸函数调用下 this 是 undefined，异常一旦被吞掉就会
    // 变成「库没关就删目录」的 EPERM（清理失败还说不清原因）。
    close() {
      try {
        store.close();
      } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** 两条 run（窗口外 / 窗口内）+ 一行活跃 + 一行带向量的归档行。 */
function seed(store) {
  store.saveDreamRun({
    id: "old-run",
    created_at: new Date(NOW - 30 * DAY).toISOString(),
    status: "ok",
    snapshot_hash: "h-old",
    input_count: 2,
    input: JSON.stringify([{ id: "m1", content: "x".repeat(600) }]),
    decisions: JSON.stringify([{ action: "keep", ids: ["m1"] }]),
    receipt: "dsh-mneme:run:old-run:ok:h-old"
  });
  store.saveDreamRun({
    id: "fresh-run",
    created_at: new Date(NOW - 1 * DAY).toISOString(),
    status: "ok",
    snapshot_hash: "h-new",
    input_count: 1,
    input: JSON.stringify([{ id: "m2", content: "y".repeat(600) }]),
    decisions: JSON.stringify([{ action: "keep", ids: ["m2"] }]),
    receipt: "dsh-mneme:run:fresh-run:ok:h-new"
  });
  const active = store.save({ type: "project", title: "活跃", content: "活跃内容" });
  store.setEmbedding(active.id, [0.125, 0.25, 0.5]);
  const archived = store.save({ type: "project", title: "归档", content: "归档内容" });
  store.setEmbedding(archived.id, [0.5, 0.25, 0.125]);
  store.setArchived(archived.id, true);
  // organize 的 run：同一列 `input` 存的是 apply 的重放载荷（organize.js 的 apply
  // 直接读它重建 byIndex），不是可重建的快照——它必须活过任何窗口的回收。
  store.saveDreamRun({
    id: "organize-run",
    created_at: new Date(NOW - 30 * DAY).toISOString(),
    status: "ok",
    snapshot_hash: "h-org",
    input_count: 1,
    input: JSON.stringify([{ index: 0, candidate: { type: "project", title: "整理候选", content: "候选正文" } }]),
    decisions: JSON.stringify([{ action: "save", index: 0 }]),
    receipt: "dsh-mneme:run:organize-run:ok:h-org",
    run_type: "organize"
  });
  return { active, archived };
}

const rawRun = (store, id) =>
  store.db.prepare("SELECT input, decisions, receipt, status FROM dream_runs WHERE id = ?").get(id);
const rawVec = (store, id) =>
  store.db.prepare("SELECT embedding FROM memories WHERE id = ?").get(id).embedding;
// count() 默认不含归档行，而「一条记忆都没删」要连归档一起数
const rawMemoryCount = (store) => store.db.prepare("SELECT count(*) AS c FROM memories").get().c;

function maintenanceFor(store, config = {}) {
  return createMaintenance({ store, config, logger: null, now: () => NOW });
}

test("dry-run：报出将清理的行数与列文本大小，一个字节都不改", () => {
  const { store, close } = fileStore();
  try {
    const { archived } = seed(store);
    const report = maintenanceFor(store).reclaim({ dryRun: true });

    assert.equal(report.dryRun, true);
    assert.equal(report.olderThanDays, 7, "默认保留窗口 7 天");
    assert.deepEqual(report.planned, { dream_run_inputs: 1, archived_embeddings: 1, distill_records: 0 });
    assert.deepEqual(report.cleared, { dream_run_inputs: 0, archived_embeddings: 0, distill_records: 0 });
    assert.ok(report.column_bytes.dream_run_inputs > 600, "列文本大小要给真实数字（它是上界）");
    assert.equal(typeof report.size.before_bytes, "number");
    assert.equal(report.vacuum.ran, false);

    assert.ok(rawRun(store, "old-run").input, "dry-run 不得置空 input");
    assert.ok(rawVec(store, archived.id), "dry-run 不得清向量");
    assert.equal(store.listLlmAudits().length, 0, "dry-run 不落回执");
  } finally {
    close();
  }
});

test("dry-run 与执行：蒸馏原文进报告，裁剪只删原文、溯源链接留住（#399）", () => {
  const { store, close } = fileStore();
  try {
    seed(store);
    const old = new Date(NOW - 30 * DAY).toISOString();
    const fresh = new Date(NOW - 1 * DAY).toISOString();
    store.saveDistillRecords([
      { sessionId: "s-old", seq: 1, role: "user", text: "z".repeat(600), windowId: "s-old:1", distilledAt: old },
      { sessionId: "s-fresh", seq: 1, role: "user", text: "新窗口的原文", windowId: "s-fresh:1", distilledAt: fresh }
    ]);
    const memoryId = store.all()[0].id;
    store.saveMemoryProvenance({ memoryId, sessionId: "s-old", seqStart: 1, seqEnd: 1, createdAt: old });

    // dry-run：第三项要报出真实行数与列文本大小（上界），且一个字节都不改
    const dry = maintenanceFor(store).reclaim({ dryRun: true });
    assert.equal(dry.planned.distill_records, 1, "只有窗口外那行算数");
    assert.ok(dry.column_bytes.distill_records >= 600, "蒸馏原文的列文本大小要给真实数字");
    assert.equal(store.db.prepare("SELECT count(*) AS c FROM distill_records").get().c, 2, "dry-run 不删原文");

    const applied = maintenanceFor(store).reclaim({ dryRun: false });
    assert.equal(applied.cleared.distill_records, 1);
    const rows = store.db.prepare("SELECT session_id FROM distill_records").all();
    assert.deepEqual(rows.map((r) => r.session_id), ["s-fresh"], "窗口内原文留住");
    // 裁剪只删原文：链接与记忆都留着，面板/CLI 显示「来源已过期」而不是查无此记忆。
    assert.equal(
      store.db.prepare("SELECT count(*) AS c FROM memory_provenance").get().c,
      1,
      "溯源链接刻意保留，指向已空区间"
    );
    assert.equal(rawMemoryCount(store), 2, "裁剪原文不删记忆");
  } finally {
    close();
  }
});

test("执行：只清窗口外的输入快照，run 的骨架与决策原文留住", () => {
  const { store, close } = fileStore();
  try {
    seed(store);
    const report = maintenanceFor(store).reclaim({ dryRun: false });
    assert.equal(report.cleared.dream_run_inputs, 1);

    const old = rawRun(store, "old-run");
    assert.equal(old.input, null, "窗口外的快照置空");
    assert.equal(old.status, "ok", "状态是骨架，留住");
    assert.ok(old.decisions, "LLM 决策原文不可重建，留住");
    assert.ok(old.receipt, "receipt 留住");
    assert.ok(rawRun(store, "fresh-run").input, "窗口内的快照不动");
    assert.equal(rawMemoryCount(store), 2, "一条记忆都没删（本入口止体积不止条数）");
  } finally {
    close();
  }
});

test("执行：清归档行向量、留活跃行向量", () => {
  const { store, close } = fileStore();
  try {
    const { active, archived } = seed(store);
    const report = maintenanceFor(store).reclaim({ dryRun: false });
    assert.equal(report.cleared.archived_embeddings, 1);
    assert.equal(rawVec(store, archived.id), null, "归档行向量按定义不可达，清掉");
    assert.ok(rawVec(store, active.id), "活跃行向量不许碰");
  } finally {
    close();
  }
});

test("olderThanDays=0 清掉全部快照；窗口外的行数与 dry-run 报的一致", () => {
  const { store, close } = fileStore();
  try {
    seed(store);
    const maintenance = maintenanceFor(store);
    assert.equal(maintenance.reclaim({ dryRun: true }).planned.dream_run_inputs, 1);
    const report = maintenance.reclaim({ dryRun: false, olderThanDays: 0 });
    assert.equal(report.cleared.dream_run_inputs, 2, "0 天 = 全部快照");
    assert.equal(rawRun(store, "fresh-run").input, null);
    assert.ok(rawRun(store, "fresh-run").decisions, "决策原文仍在");
  } finally {
    close();
  }
});

test("organize 的 input 是重放载荷，任何窗口都不清（清了 apply 会静默空转）", () => {
  const { store, close } = fileStore();
  try {
    seed(store);
    const maintenance = maintenanceFor(store);
    // 窗口 0 = 清全部快照，也必须绕开 organize
    assert.equal(maintenance.reclaim({ dryRun: true, olderThanDays: 0 }).planned.dream_run_inputs, 2);
    const report = maintenance.reclaim({ dryRun: false, olderThanDays: 0 });
    assert.equal(report.cleared.dream_run_inputs, 2, "只清 auto/sleep 的两个 run");
    assert.ok(rawRun(store, "organize-run").input, "organize 的重放载荷必须留住");
    assert.ok(rawRun(store, "organize-run").decisions, "决策也留住");
  } finally {
    close();
  }
});

test("VACUUM 失败不回吞：清理照做、报告与回执都带上失败原因", () => {
  const { store, close } = fileStore();
  try {
    seed(store);
    // 模拟锁被别的进程占着（SQLITE_BUSY）——这是最常见的失败，且两个 UPDATE 早已各自提交
    const maintenance = createMaintenance({
      store: {
        ...store,
        dreamRunInputStats: (b) => store.dreamRunInputStats(b),
        clearDreamRunInputs: (b) => store.clearDreamRunInputs(b),
        archivedEmbeddingStats: () => store.archivedEmbeddingStats(),
        clearArchivedEmbeddings: () => store.clearArchivedEmbeddings(),
        distillRecordStats: (b) => store.distillRecordStats(b),
        clearDistillRecords: (b) => store.clearDistillRecords(b),
        storageStats: () => store.storageStats(),
        saveLlmAudit: (e) => store.saveLlmAudit(e),
        vacuum: () => { throw new Error("SQLITE_BUSY: database is locked"); }
      },
      config: {},
      logger: null,
      now: () => NOW
    });
    const report = maintenance.reclaim({ dryRun: false, vacuum: true });
    assert.equal(report.cleared.dream_run_inputs, 1, "清理已完成");
    assert.equal(report.vacuum.ran, false);
    assert.match(report.vacuum.error, /SQLITE_BUSY/);
    assert.ok(report.receipt, "清掉了东西就必须有回执，哪怕 VACUUM 没跑成");
    assert.equal(rawRun(store, "old-run").input, null);
    assert.equal(store.listLlmAudits({ source: "maintenance" }).length, 1);
  } finally {
    close();
  }
});

test("--vacuum：体积量到真实下降、freelist 归零，库仍可读可写", () => {
  const { store, close } = fileStore();
  try {
    seed(store);
    // 撑出可回收的体积：VACUUM 的收益按前后体积量，没有真体积就量不到下降
    store.saveDreamRun({
      id: "bulk-run",
      created_at: new Date(NOW - 60 * DAY).toISOString(),
      status: "ok",
      snapshot_hash: "h-bulk",
      input_count: 1,
      input: JSON.stringify([{ id: "m9", content: "z".repeat(400_000) }]),
      decisions: "[]",
      receipt: "dsh-mneme:run:bulk-run:ok:h-bulk"
    });
    const before = store.storageStats().fileBytes;
    const report = maintenanceFor(store).reclaim({ dryRun: false, vacuum: true });
    assert.equal(report.vacuum.requested, true);
    assert.equal(report.vacuum.ran, true, report.vacuum.error ?? "");
    assert.equal(report.size.freelist_pages, 0, "VACUUM 之后没有空闲页");
    assert.ok(report.size.after_bytes < before, `体积必须真的下降：${before} → ${report.size.after_bytes}`);
    assert.equal(rawMemoryCount(store), 2);
    const after = store.save({ type: "project", title: "vacuum 之后", content: "写入照常" });
    assert.ok(store.getById(after.id), "VACUUM 后库仍可用");
  } finally {
    close();
  }
});

test("执行落一行回执；llmAudit 关掉时不落回执但清理照做", () => {
  const on = fileStore();
  try {
    seed(on.store);
    const report = maintenanceFor(on.store).reclaim({ dryRun: false });
    const rows = on.store.listLlmAudits({ source: "maintenance" });
    assert.equal(rows.length, 1, "执行留一行 receipt");
    assert.equal(rows[0].operation_type, "storage_reclaim");
    assert.equal(rows[0].model_id, "-", "不是模型调用，占位串避免混进花费统计");
    assert.equal(rows[0].metadata.cleared.dream_run_inputs, 1);
    assert.equal(rows[0].metadata.vacuum, false);
    assert.equal(report.receipt, rows[0].id);
  } finally {
    on.close();
  }

  const off = fileStore();
  try {
    seed(off.store);
    const report = maintenanceFor(off.store, { llmAudit: { enabled: false } }).reclaim({ dryRun: false });
    assert.equal(off.store.listLlmAudits().length, 0, "审计关掉时不落回执");
    assert.equal(report.cleared.dream_run_inputs, 1, "但清理照做：记不上账不等于没发生");
  } finally {
    off.close();
  }
});

test("取消归档重新排队嵌入：被回收的向量能拿回来", () => {
  const { store, close } = fileStore();
  try {
    const service = createService({ store, mirror: null, config: {} });
    const scheduled = [];
    service.setEmbedder({ ready: true, schedule: (memory) => scheduled.push(memory.id) });
    const { archived } = seed(store);
    store.clearArchivedEmbeddings();
    service.setArchived(archived.id, false);
    assert.deepEqual(scheduled, [archived.id], "还原时必须重新排队嵌入，否则回收成了单程票");

    // 判据要与 store.setArchived 的归一化同口径（真值）：API/工具传 0 也会把行放回
    // 活跃面，那条路同样得补嵌入，否则就是「还原了但没有向量」的静默降级。
    store.setArchived(archived.id, true);
    service.setArchived(archived.id, 0);
    assert.deepEqual(scheduled, [archived.id, archived.id]);
  } finally {
    close();
  }
});

test("HTTP 面：默认 dry-run；带 dryRun:false 但缺 confirm 只回报告不执行", async () => {
  const { store, close } = fileStore();
  const maintenance = maintenanceFor(store);
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const api = createStandaloneApi({ service, store, config: {}, settings, logger: null, port: 0, maintenance });
  await api.ready;
  const url = `http://127.0.0.1:${api.port}/maintenance/reclaim`;
  const post = (body) =>
    fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${api.token}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  try {
    const { archived } = seed(store);

    const dry = await post({});
    assert.equal(dry.status, 200);
    const dryBody = await dry.json();
    assert.equal(dryBody.dryRun, true);
    assert.equal(dryBody.planned.dream_run_inputs, 1);
    assert.ok(rawVec(store, archived.id), "不带 body 的默认路径不改数据");

    const refused = await post({ dryRun: false, vacuum: true });
    assert.equal(refused.status, 400);
    const refusedBody = await refused.json();
    assert.equal(refusedBody.error, "confirm-required");
    assert.equal(refusedBody.report.planned.archived_embeddings, 1, "拒绝执行时把 dry-run 报告一并回给调用方");
    assert.equal(refusedBody.report.vacuum.requested, true, "报告必须描述将要执行的那个动作（含 vacuum）");
    assert.ok(rawVec(store, archived.id), "缺 confirm 时一个字节都不改");

    const applied = await post({ dryRun: false, confirm: true });
    assert.equal(applied.status, 200);
    const appliedBody = await applied.json();
    assert.equal(appliedBody.cleared.dream_run_inputs, 1);
    assert.equal(appliedBody.cleared.archived_embeddings, 1);
    assert.equal(rawVec(store, archived.id), null);

    const badDays = await post({ olderThanDays: -1 });
    assert.equal(badDays.status, 400, "非法窗口给干净 400，不落进 SQL");
    assert.equal((await badDays.json()).error, "invalid-older-than-days");

    // `Number()` 会把 ""/[]/false 化成 0，而 0 在这里是「清全部快照」：最坏解释绝不
    // 能让畸形输入静默拿到，HTTP 面只收 JSON 数字
    for (const bogus of ["", [], false]) {
      const bad = await post({ olderThanDays: bogus });
      assert.equal(bad.status, 400, `畸形窗口必须拒：${JSON.stringify(bogus)}`);
      assert.equal((await bad.json()).error, "invalid-older-than-days");
    }
  } finally {
    api.server.closeIdleConnections?.();
    api.server.close();
    close();
  }
});

// CLI 那一层是用户真正敲的东西（`dsh-mneme reclaim`），参数语义错一步就是「以为在
// dry-run 却动了数据」这类事故，所以起真服务、真 spawn 它。

test("CLI：reclaim 默认 dry-run 报数字，--apply --vacuum 才真收", async () => {
  const { store, close } = fileStore();
  const maintenance = maintenanceFor(store);
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const api = createStandaloneApi({ service, store, config: {}, settings, logger: null, port: 0, maintenance });
  await api.ready;
  const auth = [`--url`, `http://127.0.0.1:${api.port}`, `--token`, api.token];
  const run = async (args) => {
    const { stdout, stderr } = await runCli(process.execPath, [CLI, ...args], { encoding: "utf8" });
    return { stdout, stderr };
  };
  try {
    const { archived } = seed(store);

    const dryRun = await run(["reclaim", ...auth]);
    assert.match(dryRun.stdout, /dry-run，未改动任何数据/);
    assert.match(dryRun.stdout, /将清理: dream_runs\.input 1 行 \/ 归档行向量 1 行/);
    assert.ok(rawVec(store, archived.id), "默认路径不得动数据");

    const apply = await run(["reclaim", "--apply", "--vacuum", ...auth]);
    assert.match(apply.stdout, /已执行/);
    assert.match(apply.stdout, /已清理: dream_runs\.input 1 行 \/ 归档行向量 1 行/);
    assert.match(apply.stdout, /回执: llm_audit_logs #\d+/);
    assert.equal(rawVec(store, archived.id), null);
    assert.equal(rawRun(store, "old-run").input, null);

    const asJson = await run(["reclaim", "--json", ...auth]);
    assert.equal(JSON.parse(asJson.stdout).dryRun, true);
  } finally {
    api.server.closeIdleConnections?.();
    api.server.close();
    close();
  }
});

test("CLI：--vacuum 单独用会被拒（dry-run 没有可回收的页），也不动数据", () => {
  const result = spawnSync(process.execPath, [CLI, "reclaim", "--vacuum", "--token", "x"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--vacuum 需要配 --apply/);
});

test("HTTP 面（数据面）：窗口上界与确认门里的抛错都跟面板侧同口径（#411）", async () => {
  // 这张脸曾是面板路由的整段复制，于是 #410 修好面板侧之后它停在旧形态：#508 没有
  // 上界（1e20 打进来 → maintenance 算日期抛 RangeError → 一个字节都不回），#523 的
  // confirm-required 报告也没兜错。现在两处口径都来自 src/reclaim-http.js，这条锁从
  // **数据面自己的端口**打真 HTTP，证明它真的走的是同一份。
  const { store, close } = fileStore();
  const maintenance = maintenanceFor(store);
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const api = createStandaloneApi({ service, store, config: {}, settings, logger: null, port: 0, maintenance });
  await api.ready;
  const url = `http://127.0.0.1:${api.port}/maintenance/reclaim`;
  const post = (body) =>
    fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${api.token}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  // 第二个实例：不传 maintenance（「没接线」的那一档）。在 try 之外建、在 finally 里
  // 关——它要是漏关，node --test 会挂着一个开着的 server 句柄永不退出（变异检验里
  // 一旦断言先炸就正好踩这条）。
  const unplugged = createStandaloneApi({ service, store, config: {}, settings, logger: null, port: 0 });
  await unplugged.ready;
  try {
    const { archived } = seed(store);

    // 顺序也是契约：端点整个没接线时，报「窗口不合法」是误导——调用方会去改窗口，
    // 改完照样 503。所以 503 必须赢过字段校验（面板侧同一条，见 api-routes-gaps.test.js）。
    const unpluggedRes = await fetch(`http://127.0.0.1:${unplugged.port}/maintenance/reclaim`, {
      method: "POST",
      headers: { authorization: `Bearer ${unplugged.token}`, "content-type": "application/json" },
      body: JSON.stringify({ olderThanDays: 1e20 })
    });
    assert.equal(unpluggedRes.status, 503, "没接线要赢过字段校验");
    assert.equal((await unpluggedRes.json()).error, "maintenance-unavailable");

    // 量级超界：旧形态下这一发既不改数据、也不回任何字节。
    for (const huge of [3651, 1e20]) {
      const out = await post({ dryRun: false, olderThanDays: huge });
      assert.equal(out.status, 400, `olderThanDays=${huge} 必须被拒，而不是把连接挂住`);
      assert.equal((await out.json()).error, "invalid-older-than-days");
    }
    const atLimit = await post({ olderThanDays: 3650 });
    assert.equal(atLimit.status, 200, "上界本身合法");
    assert.equal((await atLimit.json()).olderThanDays, 3650);
    assert.ok(rawVec(store, archived.id), "被拒的那几发一个字节都不能改");

    // 确认门的报告要描述「将要执行的那个动作」，且窗口是调用方问的那个。
    const refused = await post({ dryRun: false, olderThanDays: 30, vacuum: true });
    assert.equal(refused.status, 400);
    const refusedBody = await refused.json();
    assert.equal(refusedBody.error, "confirm-required");
    assert.equal(refusedBody.report.olderThanDays, 30, "报告必须说的是被问的那个窗口");
    assert.equal(refusedBody.report.vacuum.requested, true, "报告必须描述将要执行的那个动作（含 vacuum）");
    assert.ok(rawVec(store, archived.id), "缺 confirm 时一个字节都不改");

    const applied = await post({ dryRun: false, confirm: true, vacuum: true });
    assert.equal(applied.status, 200);
    const appliedBody = await applied.json();
    assert.equal(appliedBody.olderThanDays, 7, "不传窗口就是默认 7 天");
    assert.equal(appliedBody.cleared.dream_run_inputs, 1);
    assert.equal(appliedBody.vacuum.requested, true, "勾了 VACUUM 就必须真带上");
    assert.equal(appliedBody.vacuum.ran, true);
    assert.equal(rawVec(store, archived.id), null);
  } finally {
    unplugged.server.closeIdleConnections?.();
    unplugged.server.close();
    api.server.closeIdleConnections?.();
    api.server.close();
    close();
  }
});
