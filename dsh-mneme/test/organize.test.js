// #231：agent 主动整理接口——dryRun 比对报告 → agent 判断 → apply；筛除项进归档
// 不删；调用全程复用 dream_runs 的 receipt 语义（不新建审计面）。维护者口径：
// 功能本体落在 service 层并带测试，不进工具列表、不加独立 opt-in 开关。

import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createOrganizer } from "../src/organize.js";
import { parseReceipt } from "../src/dream.js";
import { testConfig } from "./helpers/test-config.js";

const preference = (title, content = "内容", extra = {}) =>
  ({ type: "preference", title, content, importance: 5, ...extra });

/** 单元级 organizer：假 embedQuery 隔离向量档，写路径复用真 service。 */
function makeOrganizer(embedQuery = async () => null, config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig(config) });
  const finalizeCalls = [];
  const { organize } = createOrganizer({
    store,
    embedQuery,
    saveWithDedupe: service.saveWithDedupe,
    transaction: service.transaction,
    finalize: (rows) => finalizeCalls.push(rows)
  });
  return { store, service, organize, finalizeCalls };
}

test("#231: dryRun writes no memory and leaves one organize receipt", async () => {
  const { store, service, organize } = makeOrganizer();
  const seeded = service.saveWithDedupe(preference("偏好X", "既有内容")).memory;
  const report = await organize({
    mode: "dryRun",
    candidates: [preference("偏好X", "同一标题的新内容"), { type: "decision", title: "全新决定", content: "库里没有" }]
  });
  assert.equal(report.items[0].verdict, "exact");
  assert.equal(report.items[0].match.id, seeded.id);
  assert.equal(report.items[1].verdict, "new");
  assert.equal(report.counts.total, 2);
  // 比对是报告不是动作：记忆表仍然只有种子那一行。
  assert.equal(store.list({ limit: null }).length, 1);
  const run = store.getDreamRun(report.run_id);
  assert.equal(run.run_type, "organize");
  assert.equal(run.status, "ok");
  assert.equal(run.applied, 0);
  assert.equal(parseReceipt(run.receipt).runId, report.run_id, "receipt 复用 dream 的既有格式");
});

test("#231: dryRun reports near duplicates with similarity (vector layer)", async () => {
  const { store, service, organize } = makeOrganizer(async () => [0.99, 0.1, 0]);
  const seeded = service.saveWithDedupe({ type: "decision", title: "令牌桶限流方案", content: "旧记录" }).memory;
  store.setEmbedding(seeded.id, [1, 0, 0]);
  const report = await organize({
    mode: "dryRun",
    candidates: [{ type: "decision", title: "限流方案选型", content: "内容相近但换了标题" }]
  });
  assert.equal(report.items[0].verdict, "near");
  assert.equal(report.items[0].match.id, seeded.id);
  assert.ok(report.items[0].match.sim > 0.9, "相似度带回报告，供 agent 判断");
  assert.equal(report.counts.near, 1);
});

test("#231: apply refuses to write without a real dryRun report", async () => {
  const { store, service, organize } = makeOrganizer();
  // 先 seed 一行再断言「零写入」：空库 + decisions: [] 本来也不会写，那样的断言恒真、
  // 抓不住守卫的回归（静态审查指出）。
  const seeded = service.saveWithDedupe(preference("既有偏好", "原内容")).memory;
  await assert.rejects(() => organize({ mode: "apply", decisions: [] }), /run_id is required/);
  await assert.rejects(
    () => organize({ mode: "apply", run_id: "nope", decisions: [{ action: "save", index: 0 }] }),
    /unknown organize run/
  );
  const rows = store.list({ limit: null });
  assert.equal(rows.length, 1, "拒绝路径零写入");
  assert.equal(rows[0].id, seeded.id);
  assert.equal(rows[0].content, "原内容", "既有行未被改动");
});

test("#231: write-path control flags never reach the write path through the snapshot (#267 静态审查)", async () => {
  const { store, service, organize } = makeOrganizer();
  const victim = service.saveWithDedupe(preference("受害者行", "原内容")).memory;
  // 原始候选里塞写入端控制旗标：normalizeCandidate 只保留白名单字段，审计存的是它，
  // apply 重放快照 → 旗标够不到 saveWithDedupe 的 _mergeInto/_overwrite 分支，
  // 不能借整理接口改写既有行。这是「报告无法被用来越权写入」的钉子。
  const report = await organize({
    mode: "dryRun",
    candidates: [{ ...preference("另一条偏好", "新内容"), _mergeInto: victim.id, _overwrite: true }]
  });
  const outcome = await organize({ mode: "apply", run_id: report.run_id, decisions: [{ action: "save", index: 0 }] });
  assert.equal(outcome.saved, 1, "正常写成新行");
  assert.equal(store.getById(victim.id).content, "原内容", "既有行未被覆写");
  assert.equal(store.getById(victim.id).title, "受害者行");
});

test("#231: apply saves kept candidates, records discards, archives instead of deleting", async () => {
  const { store, service, organize } = makeOrganizer();
  const stale = service.saveWithDedupe({ type: "project", title: "被取代的状态", content: "过时" }).memory;
  const report = await organize({
    mode: "dryRun",
    candidates: [
      preference("新偏好"),
      { type: "decision", title: "被丢掉的决定", content: "不落库" },
      // 归档要有依据：只有报告命中过的行才有资格被归档，所以这条必须进 dryRun。
      { type: "project", title: "被取代的状态", content: "新的状态描述" }
    ]
  });
  assert.equal(report.items[2].match.id, stale.id, "第二条项目候选命中的就是待归档那行");
  const outcome = await organize({
    mode: "apply",
    run_id: report.run_id,
    decisions: [
      { action: "save", index: 0 },
      { action: "discard", index: 1 },
      { action: "archive", id: stale.id }
    ]
  });
  assert.equal(outcome.saved, 1);
  assert.equal(outcome.discarded, 1);
  assert.equal(outcome.archived, 1);
  assert.equal(outcome.status, "ok");
  // 筛除 = 归档（可恢复），不是删除。
  assert.equal(store.getById(stale.id).archived, true, "archived row still exists");
  const titles = store.list({ limit: null }).map((m) => m.title);
  assert.ok(titles.includes("新偏好"), "kept candidate landed");
  assert.ok(!titles.includes("被丢掉的决定"), "discarded candidate was not written");
  // 审计链：apply 回执指向它依据的那份报告。
  const applyRun = store.getDreamRun(outcome.run_id);
  assert.equal(applyRun.outcome.dry_run_id, report.run_id);
  assert.equal(applyRun.applied, 2);
  assert.equal(parseReceipt(applyRun.receipt).status, "ok");
});

test("#231: the source columns do not split the match key (#267 评审第二轮)", async () => {
  const { store, service, organize } = makeOrganizer();
  const seeded = service.saveWithDedupe({
    ...preference("同标题的约束"),
    agent_scope: "agent-b",
    agent_scope_source: "auto"
  }).memory;
  // 只差 agent_scope_source（auto vs explicit）：saveWithDedupe 的去重键不含来源两列，
  // 所以这必须判成「命中既有行」。比对键里多带来源就会报 new，而 apply 却合并——错位。
  const report = await organize({
    mode: "dryRun",
    candidates: [{ ...preference("同标题的约束"), agent_scope: "agent-b", agent_scope_source: "explicit" }]
  });
  assert.equal(report.items[0].verdict, "exact");
  assert.equal(report.items[0].match.id, seeded.id);
  const outcome = await organize({ mode: "apply", run_id: report.run_id, decisions: [{ action: "save", index: 0 }] });
  assert.equal(outcome.merged, 1, "报告与写入同口径：命中既有行");
  assert.equal(outcome.saved, 0);
  assert.equal(store.list({ limit: null }).length, 1);
});

test("#231: dryRun compares in the candidate's own scope, not the payload's (#267 评审 1)", async () => {
  const { service, organize } = makeOrganizer();
  const seeded = service.saveWithDedupe({ ...preference("同标题的约束"), agent_scope: "agent-b" }).memory;
  // 载荷级不给 scope，只在候选上给：报告必须按候选自己的 scope 看库，否则同一个
  // scope 里明明已有同标题行也会报 "new"——报告 scope 与写入 scope 就此错位。
  const report = await organize({
    mode: "dryRun",
    candidates: [{ ...preference("同标题的约束"), agent_scope: "agent-b" }]
  });
  assert.equal(report.items[0].verdict, "exact");
  assert.equal(report.items[0].match.id, seeded.id);
  // 反向：默认 scope 的候选看不到 agent-b 的行（跨 scope 永不互判，防泄漏）。
  const other = await organize({ mode: "dryRun", candidates: [preference("同标题的约束")] });
  assert.equal(other.items[0].verdict, "new");
});

test("#231: the same report cannot be applied twice (#267 评审 2)", async () => {
  const { store, organize } = makeOrganizer();
  const report = await organize({ mode: "dryRun", candidates: [preference("只应落一次")] });
  await organize({ mode: "apply", run_id: report.run_id, decisions: [{ action: "save", index: 0 }] });
  await assert.rejects(
    () => organize({ mode: "apply", run_id: report.run_id, decisions: [{ action: "save", index: 0 }] }),
    /already applied/
  );
  assert.equal(store.list({ limit: null }).filter((m) => m.title === "只应落一次").length, 1);
  const receipts = store.listDreamRuns({}).filter((r) => r.outcome?.dry_run_id === report.run_id);
  assert.equal(receipts.length, 1, "同一份报告只留一份落地回执");
  assert.ok(store.getDreamRun(report.run_id).outcome.applied_at, "报告行上留了已落地凭证");
});

test("#231: archive only accepts ids the report flagged as matches (#267 评审 3)", async () => {
  const { store, service, organize } = makeOrganizer();
  const bystander = service.saveWithDedupe({ type: "project", title: "报告没提过的项目行", content: "无关" }).memory;
  const report = await organize({ mode: "dryRun", candidates: [preference("只有偏好类")] });
  const outcome = await organize({
    mode: "apply",
    run_id: report.run_id,
    decisions: [{ action: "archive", id: bystander.id }]
  });
  assert.equal(outcome.archived, 0);
  assert.match(outcome.skipped[0].error, /not flagged as a match/);
  assert.equal(store.getById(bystander.id).archived, false, "报告没提过的行不许被动");
  assert.equal(outcome.status, "degraded");
});

test("#231: merged candidates count as merged, not as new saves (#267 评审 2)", async () => {
  const { store, service, organize } = makeOrganizer();
  service.saveWithDedupe(preference("已被记下的偏好", "旧内容"));
  const report = await organize({ mode: "dryRun", candidates: [preference("已被记下的偏好", "新内容")] });
  assert.equal(report.items[0].verdict, "exact");
  const outcome = await organize({ mode: "apply", run_id: report.run_id, decisions: [{ action: "save", index: 0 }] });
  assert.equal(outcome.saved, 0, "同键命中走合并，不是新建");
  assert.equal(outcome.merged, 1);
  assert.equal(outcome.status, "ok", "合并也是落地生效，不能记成 noop");
  assert.equal(store.list({ limit: null }).length, 1);
  assert.equal(store.getDreamRun(outcome.run_id).applied, 1);
});

test("#231: a failing audit write does not replace the original error (#267 评审 4)", async () => {
  const { store, organize } = makeOrganizer();
  const report = await organize({ mode: "dryRun", candidates: [preference("会失败的落地")] });
  // 审计整体不可用：事务内的「已落地」标记先抛 → 回滚 → 失败回执也写不进去。
  store.saveDreamRun = () => {
    throw new Error("audit unavailable");
  };
  await assert.rejects(
    () => organize({ mode: "apply", run_id: report.run_id, decisions: [{ action: "save", index: 0 }] }),
    (err) => {
      assert.match(err.message, /audit unavailable/, "原始错误原样抛出");
      assert.match(err.audit_error, /audit unavailable/, "审计的失败挂上去，不被静默吞掉");
      return true;
    }
  );
});

test("#231: apply tolerates bad decisions — legal subset lands, run is degraded", async () => {
  const { store, organize } = makeOrganizer();
  const report = await organize({ mode: "dryRun", candidates: [preference("能落的")] });
  const outcome = await organize({
    mode: "apply",
    run_id: report.run_id,
    decisions: [
      { action: "save", index: 0 },
      { action: "save", index: 9 },           // 越界
      { action: "archive", id: "m_missing" }, // 未知 id
      { action: "explode", index: 0 }         // 未知动作
    ]
  });
  assert.equal(outcome.saved, 1, "legal subset applied");
  assert.equal(outcome.skipped.length, 3);
  assert.equal(outcome.status, "degraded");
  assert.equal(outcome.degraded, true);
  assert.equal(store.getDreamRun(outcome.run_id).skipped.length, 3, "逐条跳过明细进审计");
});

test("#231: dryRun refuses document candidates (registerDocument is the only mint)", async () => {
  const { organize } = makeOrganizer();
  const report = await organize({ mode: "dryRun", candidates: [{ type: "document", title: "长文", content: "摘要" }] });
  assert.equal(report.counts.total, 0);
  assert.equal(report.status, "degraded");
  assert.match(report.skipped[0].error, /registerDocument/);
});

test("#231: dryRun bounds the batch and reports the truncation", async () => {
  const { organize } = makeOrganizer();
  const report = await organize({
    mode: "dryRun",
    candidates: Array.from({ length: 55 }, (_, i) => preference(`偏好${i}`))
  });
  assert.equal(report.counts.total, 50);
  assert.equal(report.counts.truncated, 5);
});

test("#231: single entry point with a mode parameter, exported through the service barrel", async () => {
  const { service, organize } = makeOrganizer();
  await assert.rejects(() => organize({ mode: "wat" }), /unknown mode/);
  assert.equal(typeof service.organize, "function", "service 层 barrel 出口（调用方零改动）");
  const report = await service.organize({ mode: "dryRun", candidates: [preference("走 service 的")] });
  assert.equal(report.counts.total, 1);
});

// --- 以下为 CodeRabbit #267 复核后补的边界：报告的索引/scope 必须与落库严格一致 ---

test("#231: payload-level scope travels with the snapshot into the write", async () => {
  const { store, organize } = makeOrganizer();
  const report = await organize({
    mode: "dryRun",
    agent_scope: "agent-a",
    candidates: [preference("带 scope 的偏好")]
  });
  const run = store.getDreamRun(report.run_id);
  assert.equal(run.input[0].agent_scope, "agent-a", "审计存的是带 scope 的规范化快照");
  assert.equal(run.input[0].index, 0, "快照保留原始索引，apply 才能按索引重放");
  assert.equal(run.input[0].type, "preference");
  await organize({ mode: "apply", run_id: report.run_id, decisions: [{ action: "save", index: 0 }] });
  assert.equal(store.list({ limit: null })[0].agent_scope, "agent-a", "比对用的 scope 就是落地用的 scope");
});

test("#231: apply cannot land an index the dryRun never accepted", async () => {
  const { store, organize } = makeOrganizer();
  const report = await organize({
    mode: "dryRun",
    candidates: [preference("合法的"), { type: "document", title: "长文", content: "摘要" }]
  });
  assert.equal(report.counts.skipped, 1);
  const outcome = await organize({
    mode: "apply",
    run_id: report.run_id,
    decisions: [{ action: "save", index: 1 }] // dryRun 当时就拒了这一条
  });
  assert.equal(outcome.saved, 0);
  assert.equal(outcome.status, "degraded");
  assert.match(outcome.skipped[0].error, /not accepted by this dryRun/);
  assert.equal(store.list({ limit: null }).length, 0, "被跳过的候选没有资格落库");
});

test("#231: apply refuses an apply receipt as its dryRun reference", async () => {
  const { organize } = makeOrganizer();
  const report = await organize({ mode: "dryRun", candidates: [preference("第一条")] });
  const first = await organize({ mode: "apply", run_id: report.run_id, decisions: [{ action: "save", index: 0 }] });
  // 两者共用 run_type='organize'，只有 outcome.dry_run_id 能把回执与报告分开。
  await assert.rejects(
    () => organize({ mode: "apply", run_id: first.run_id, decisions: [{ action: "save", index: 0 }] }),
    /apply receipt/
  );
});

test("#231: a throwing embedder fails the dryRun, audits it and rethrows", async () => {
  const { store, service } = makeOrganizer(async () => {
    throw new Error("embedder offline");
  });
  const seeded = service.saveWithDedupe({ type: "preference", title: "已有向量", content: "内容" }).memory;
  store.setEmbedding(seeded.id, [1, 0, 0]);
  const seen = [];
  const observed = createOrganizer({
    store: { ...store, saveDreamRun: (row) => { seen.push(row); return store.saveDreamRun(row); } },
    embedQuery: async () => {
      throw new Error("embedder offline");
    },
    saveWithDedupe: service.saveWithDedupe,
    transaction: service.transaction
  });
  await assert.rejects(() => observed.organize({ mode: "dryRun", candidates: [preference("新的一条")] }), /embedder offline/);
  assert.equal(seen.at(-1).status, "failed", "基础设施错误留 failed 回执，不降级成「全是新条目」");
  assert.match(seen.at(-1).error, /embedder offline/);
  assert.equal(store.list({ limit: null }).length, 1, "失败路径零写入");
});

test("#231: an infrastructure write error rolls back and reports applied 0", async () => {
  const { store, service, organize } = makeOrganizer();
  const report = await organize({ mode: "dryRun", candidates: [preference("会写失败的")] });
  const seen = [];
  const failing = createOrganizer({
    store: { ...store, saveDreamRun: (row) => { seen.push(row); return store.saveDreamRun(row); } },
    embedQuery: async () => null,
    saveWithDedupe: () => {
      throw new Error("database is locked");
    },
    transaction: service.transaction
  });
  await assert.rejects(
    () => failing.organize({ mode: "apply", run_id: report.run_id, decisions: [{ action: "save", index: 0 }] }),
    /database is locked/
  );
  assert.equal(store.list({ limit: null }).length, 0, "整批回滚，零写入");
  const failed = seen.at(-1);
  assert.equal(failed.status, "failed");
  assert.equal(failed.applied, 0, "回滚后不得虚报 applied");
  assert.deepEqual(failed.outcome.byId, {});
});

test("#231: a failing success audit rolls the writes back with it", async () => {
  const { store, service, organize } = makeOrganizer();
  const report = await organize({ mode: "dryRun", candidates: [preference("回执写不进去")] });
  let auditFailures = 0;
  const audited = {
    ...store,
    saveDreamRun: (row) => {
      if (row.run_type === "organize" && row.status === "ok" && row.id !== report.run_id) {
        auditFailures++;
        throw new Error("audit table is full");
      }
      return store.saveDreamRun(row);
    }
  };
  const { organize: proxied } = createOrganizer({
    store: audited,
    embedQuery: async () => null,
    saveWithDedupe: service.saveWithDedupe,
    transaction: service.transaction
  });
  await assert.rejects(
    () => proxied({ mode: "apply", run_id: report.run_id, decisions: [{ action: "save", index: 0 }] }),
    /audit table is full/
  );
  assert.equal(auditFailures, 1);
  assert.equal(store.list({ limit: null }).length, 0, "成功回执与数据同事务：回执写不进去 → 数据也回滚");
});

test("#231: finalize runs after commit with the saved rows, and not for empty batches", async () => {
  const { store, organize, finalizeCalls } = makeOrganizer();
  const report = await organize({ mode: "dryRun", candidates: [preference("要重嵌入的")] });
  await organize({ mode: "apply", run_id: report.run_id, decisions: [{ action: "save", index: 0 }] });
  assert.equal(finalizeCalls.length, 1, "提交后补一次重嵌入（transaction 里被 txDepth 挡掉）");
  assert.equal(finalizeCalls[0][0].id, store.list({ limit: null })[0].id);
  const discardsOnly = await organize({ mode: "dryRun", candidates: [preference("只丢弃")] });
  await organize({ mode: "apply", run_id: discardsOnly.run_id, decisions: [{ action: "discard", index: 0 }] });
  assert.equal(finalizeCalls.length, 1, "noop 批次不触发 finalize");
});

test("#231: archive honours the hidden-id set from the trusted caller, not the payload", async () => {
  const { store, service, organize } = makeOrganizer();
  const outOfScope = service.saveWithDedupe({ type: "project", title: "看不见的项目", content: "内容" }).memory;
  const report = await organize({ mode: "dryRun", candidates: [preference("占位")] });
  // opts 是第二参数（document 的 hiddenEvidenceIds 同款契约）：payload 里的同名字段
  // 一律不认——那是调用方可自选的内容，不是授权。
  const outcome = await service.organize(
    { mode: "apply", run_id: report.run_id, decisions: [{ action: "archive", id: outOfScope.id }] },
    { hiddenIds: [outOfScope.id] }
  );
  assert.equal(outcome.archived, 0);
  assert.match(outcome.skipped[0].error, /out of scope/);
  assert.equal(store.getById(outOfScope.id).archived, false, "看不见的行按不存在处理，不归档");
});
