// issue #534：[0.9.5] dream 决策层 19 轮里 17 轮整轮判定无效，两轮 ok 也 applied=0，
// 失败时不落原始决策。作者报的是三件互相独立的观测缺口，本文件各锁一条：
//
// 1. 失败的轮次只剩「N errors」这个结论，模型原文随日志滚掉，事后无法复现；
//    → dream_runs.raw_output（不入 decisions 列：那一列的语义是「可重放决策数组」，
//      applyDecisions 直接吃它，塞非决策对象会污染重放者）。
// 2. skipped 里只有 index/action/ids/error 四键，看不出这条决策是「缺 title」
//    还是「缺 content」——都是同一个 error 串里的不同分支；
//    → 逐条补 has_keepSource / has_title / has_content 三个布尔。
// 3. 审计算 95% 成功率、真实整轮只有 10.5%：两套账没有共同分母。
//    → llm_audit_logs.metadata.decision_validation（verdict + 三个计数 + 动作名），
//      不改 status/token/timestamp（那是调用层事实，改写等于伪造账本）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createDreamScheduler,
  rawOutputPayload,
  decisionValidationMeta,
  validateDecisions
} from "../src/dream.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { mockCtx } from "./helpers/dream-mock.js";

function snapshot(ids) {
  return new Map(ids.map((id) => [id, {
    id, type: "project", title: `t-${id}`, content: `c-${id}`, importance: 3, archived: false, forgotten: false
  }]));
}

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  return { store, service, dream };
}

function consolidateAudits(service) {
  return service.listLlmAudits({ limit: 20 }).filter((a) => a.operation_type === "dream_consolidate");
}

function metaOf(row) {
  const meta = row.metadata;
  return typeof meta === "string" ? JSON.parse(meta) : meta;
}

// ---------------------------------------------------------------- 建议 2 载荷

test("#534: rawOutputPayload 只留头尾，空文本整键不写", () => {
  assert.equal(rawOutputPayload(""), undefined, "空文本不许落空壳对象冒充「有原文」");
  assert.equal(rawOutputPayload(undefined), undefined);
  assert.equal(rawOutputPayload(null), undefined);

  const short = rawOutputPayload("抱歉，我无法处理这个任务");
  assert.equal(short.raw_len, 12);
  assert.equal(short.raw_has_bracket, false, "有没有 '[' 是区分「没按格式写」与「格式对但救不回来」的判据");
  assert.equal("raw_tail" in short, false, "短文本不补 tail：tail 是给跑飞的长输出定位收尾的");

  const long = `起手 ${"填".repeat(600)} 收尾段落`;
  const payload = rawOutputPayload(long);
  assert.equal(payload.raw_len, long.length);
  assert.equal(payload.raw_head, long.slice(0, 300), "头部固定 300 字，口径沿用 #504");
  assert.equal(payload.raw_tail, long.slice(-200), "仅 >500 字时补末 200 字");
  assert.equal(payload.raw_has_bracket, false);

  assert.equal(rawOutputPayload("[{").raw_has_bracket, true);
});

test("#534: 拒收轮与合法子集的载荷形状一致，只是 verdict 不同", () => {
  const rejected = decisionValidationMeta({ verdict: "rejected", errors: ["e1", "e2"], skipped: [{ action: "merge" }, { action: "merge" }, { action: "archive" }], survivorCount: 0 });
  assert.deepEqual(rejected.decision_validation, {
    verdict: "rejected",
    error_count: 2,
    skipped_count: 3,
    survivor_count: 0,
    invalid_actions: ["merge", "archive"]
  });
  const ok = decisionValidationMeta({ verdict: "ok", errors: [], skipped: [], survivorCount: 4 });
  assert.equal(ok.decision_validation.verdict, "ok");
  assert.deepEqual(ok.decision_validation.invalid_actions, []);
  assert.equal(ok.decision_validation.survivor_count, 4);
});

// ---------------------------------------------------------------- 建议 1 三布尔

test("#534: skipped 逐条带 has_keepSource / has_title / has_content，能区分缺哪一项", () => {
  const ids = ["a", "b"];
  const snap = snapshot(ids);
  // ① merge 什么都不给 → 三个布尔全 false（keepSource 不在 ids 里、title/content 空）
  const bare = validateDecisions([{ action: "merge", ids }], snap, { skipInvalid: true });
  assert.equal(bare.skipped.length, 1);
  const skippedBare = bare.skipped[0];
  assert.deepEqual(Object.keys(skippedBare).sort(), ["action", "error", "has_content", "has_keepSource", "has_title", "ids", "index"],
    "既有四键保留，只加三个布尔——不塞原文");
  assert.equal(skippedBare.has_keepSource, false);
  assert.equal(skippedBare.has_title, false);
  assert.equal(skippedBare.has_content, false);

  // ② 三项都给但 keepSource 不指向自家人 → 仍被拒，但三布尔能看出「字段是齐的」
  const full = validateDecisions([{
    action: "merge", ids, keepSource: "zzz", title: "合并标题", content: "合并正文", importance: 4
  }], snap, { skipInvalid: true });
  assert.equal(full.skipped.length, 1);
  assert.equal(full.skipped[0].has_keepSource, true, "写了 keepSource 就要看清「写了但不合法」");
  assert.equal(full.skipped[0].has_title, true);
  assert.equal(full.skipped[0].has_content, true);
  assert.match(full.skipped[0].error, /keepSource/, "具体不合法的点仍在 error 里，布尔只补形状");

  // ③ 空白字符串不算「有」：模型常把缺省值写成空串
  const blank = validateDecisions([{ action: "merge", ids, keepSource: "a", title: "   ", content: "\n" }], snap, { skipInvalid: true });
  assert.equal(blank.skipped[0].has_title, false);
  assert.equal(blank.skipped[0].has_content, false);
});

// ---------------------------------------------------------------- 建议 2 落库（端到端）

test("#534: 解析失败轮把模型原文写进 raw_output，decisions 仍然不落库", async () => {
  const { store, service, dream } = setup();
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const prose = "抱歉，我无法处理这个任务";
  const result = await dream.runDream(mockCtx({ onConsolidation: () => prose }), service, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /no json array/);

  const run = store.getDreamRun(result.runId);
  assert.equal(run.decisions, undefined, "回归锁：decisions 列仍只承载「可重放决策数组」");
  assert.ok(run.raw_output, "失败轮必须留下原文读数（此前只有一条会滚掉的 warn）");
  assert.equal(run.raw_output.raw_len, prose.length);
  assert.equal(run.raw_output.raw_head, prose, "原文本身要能在库外复现模型到底吐了什么");
  assert.equal(run.raw_output.raw_has_bracket, false);
  store.close();
});

test("#534: 校验整单拒绝轮同样落 raw_output（原文是有效的 JSON 数组）", async () => {
  const { store, service, dream } = setup();
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const decisions = JSON.stringify([{ action: "archive", ids: ["deadbeef"] }]);
  const result = await dream.runDream(mockCtx({ onConsolidation: () => decisions }), service, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /invalid decisions/);

  const run = store.getDreamRun(result.runId);
  assert.equal(run.decisions[0]._validationFailed, true, "既有哨兵不变（#135 锁）");
  assert.equal(run.raw_output.raw_len, decisions.length);
  assert.equal(run.raw_output.raw_head, decisions, "被拒但格式合法的轮次，原文最有价值：能离线重跑校验");
  assert.equal(run.raw_output.raw_has_bracket, true, "区分「格式对但内容不合法」与「压根没写 JSON」");
  store.close();
});

test("#534: 流错误（没有文本可留）落 NULL，不许写空壳对象", async () => {
  const { store, service, dream } = setup();
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    llm: {
      async *stream() {
        yield { type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "429" } } };
      }
    }
  };
  const result = await dream.runDream(ctx, service, {});
  assert.equal(result.ok, false);
  const run = store.getDreamRun(result.runId);
  assert.equal(run.raw_output, undefined, "提供方错误时模型没吐过正文，落 NULL 而不是 {raw_len:0}");
  store.close();
});

// ---------------------------------------------------------------- 建议 3 分账

test("#534: 校验判决补回同一行的 metadata，调用层事实不动", async () => {
  const { store, service, dream } = setup();
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  await dream.runDream(mockCtx({ onConsolidation: () => "抱歉，我无法处理这个任务" }), service, {});
  const row = consolidateAudits(service).find((a) => a.status === "error");
  assert.ok(row, "调用层仍按既有口径记 error（吐了正文却不是 JSON 数组）");
  const meta = metaOf(row);
  assert.deepEqual(meta.decision_validation, {
    verdict: "unparsed",
    error_count: 0,
    skipped_count: 0,
    survivor_count: 0,
    invalid_actions: []
  }, "「没解析出数组」是判决的第四种状态，不能跟「整单拒绝」混成一个");
  assert.equal(meta.parse_failure, true, "#504 的解析失败读数必须保留（dream-fence 锁）");
  assert.equal(row.status, "error", "补注不许改写调用层 status");
  assert.ok(row.total_tokens >= 0, "token 计数原样保留");
  store.close();
});

test("#534: 调用成功但决策被整单拒绝 → 同一行同时读出两层结论", async () => {
  const { store, service, dream } = setup();
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  await dream.runDream(mockCtx({
    onConsolidation: () => JSON.stringify([{ action: "archive", ids: ["deadbeef"] }])
  }), service, {});
  const rows = consolidateAudits(service);
  const row = rows[0];
  assert.equal(row.status, "success", "调用是真的成功了——这是作者说的「审计 95% 成功率」那一侧");
  const meta = metaOf(row);
  assert.equal(meta.decision_validation.verdict, "rejected", "整轮无效在这一侧才看得见（真实 10.5%）");
  assert.equal(meta.decision_validation.skipped_count, 1);
  assert.deepEqual(meta.decision_validation.invalid_actions, ["archive"]);
  assert.ok(meta.decision_validation.error_count >= 1, "all-invalid 的整单错误串要计入 error_count");
  store.close();
});

test("#534: 合法子集（degraded）的 verdict 与 survivor_count 对得上", async () => {
  const { store, service, dream } = setup();
  const { memory: m } = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  await dream.runDream(mockCtx({
    onConsolidation: () => JSON.stringify([
      { action: "keep", ids: [m.id] },
      { action: "archive", ids: ["deadbeef"] }
    ])
  }), service, {});
  const row = consolidateAudits(service)[0];
  assert.equal(row.status, "success");
  const meta = metaOf(row);
  assert.equal(meta.decision_validation.verdict, "degraded");
  assert.equal(meta.decision_validation.skipped_count, 1);
  // 校验器就地 splice 掉被跳过的条目，所以存活数就是校验后的 decisions 长度：
  // 这里 1 条 keep 存活、1 条 archive 被跳过（隐式 keep 不会重复补已 claim 的 id）。
  assert.equal(meta.decision_validation.survivor_count, 1, "存活数是校验后真正会被消费的条目数");
  store.close();
});

test("#534: 全部合法的轮次 verdict=ok，metadata 不因补注长出多余键", async () => {
  const { store, service, dream } = setup();
  const { memory: m } = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const result = await dream.runDream(mockCtx({
    onConsolidation: () => JSON.stringify([{ action: "keep", ids: [m.id] }])
  }), service, {});
  assert.equal(result.ok, true);
  const row = consolidateAudits(service)[0];
  const meta = metaOf(row);
  assert.equal(meta.decision_validation.verdict, "ok");
  assert.equal(meta.decision_validation.skipped_count, 0);
  assert.equal(meta.parse_failure, undefined, "成功轮不许带解析失败读数");
  store.close();
});

test("#534: 覆盖率不足（没有逐条跳过）也判 degraded，与 dream_runs.status 同源", async () => {
  // CodeRabbit on #535：coverageShortfall 同样是校验层降级。此前 verdict 只认
  // skippedInvalid，于是「模型给了合法子集、但覆盖不到半数」的轮次会落成
  // dream_runs.status="degraded" 而 metadata 写 verdict="ok"——两套账在最该
  // 对齐的一格上又对不上。这条锁把它们绑死在同一个判据上。
  const { store, service, dream } = setup();
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    ids.push(service.saveWithDedupe({ type: "project", title: `覆盖-${i}`, content: `覆盖正文-${i}`, importance: 3 }).memory.id);
  }
  const result = await dream.runDream(mockCtx({
    // 2/5 = 40% 覆盖 < 下限 50%，且没有一条被逐条跳过——降级理由只能是 coverage。
    // 必须让一条真落地（archive 掉一条）：全 keep 轮会先被 noChange 分支截走
    // （那里 status 只由 summaryStored 决定），走不到 coverage 这一格。
    onConsolidation: () => JSON.stringify([
      { action: "keep", ids: [ids[0]] },
      { action: "archive", ids: [ids[1]], reason: "重复条目" }
    ])
  }), service, { dreamImplicitKeep: true, dreamMinExplicitCoverage: 0.5 });
  const run = store.getDreamRun(result.runId);
  assert.equal(run.applied, 1, "先确认这条路径真的落地了改动（否则测的还是 noChange 分支）");
  assert.equal(run.status, "degraded", "覆盖率不足在 run 行上一直是 degraded（#104 方向 1）");
  const meta = metaOf(consolidateAudits(service)[0]);
  assert.equal(meta.decision_validation.verdict, "degraded", "审计 metadata 必须跟 run 行说同一件事");
  assert.equal(meta.decision_validation.skipped_count, 0, "这条路径没有逐条跳过，判据只能是 coverage");
  assert.equal(meta.decision_validation.survivor_count, 5, "未 claim 的 4 条被隐式 keep 补齐，全部存活");
  store.close();
});

test("#534: 审计行的 id 来自本次插入，不是「当前最大 id」", async () => {
  // CodeRabbit on #535（Major）：saveLlmAudit 原来先 INSERT 再
  // `SELECT * ORDER BY id DESC LIMIT 1`。库支持多进程共用，另一个写者插在
  // 中间就会把这行读成别人的调用，随后 annotate 把本轮判决写到别人头上。
  // 这里用「连续两次写入各自拿回自己那行」锁住回读口径。
  const { store, service } = setup();
  const first = service.saveLlmAudit({ trigger_source: "t", operation_type: "o1", model_id: "m", status: "success" });
  service.saveLlmAudit({ trigger_source: "t", operation_type: "o2", model_id: "m", status: "success" });
  const second = service.saveLlmAudit({ trigger_source: "t", operation_type: "o3", model_id: "m", status: "success" });
  assert.equal(first.operation_type, "o1", "回读的必须是自己插入的那一行");
  assert.equal(second.operation_type, "o3");
  assert.ok(second.id > first.id, "id 单调，但取值只认本次插入");

  // 判决补注同样按 id 定位：插一行噪声在后面，也不能改变目标行。
  service.saveLlmAudit({ trigger_source: "t", operation_type: "noise", model_id: "m", status: "success" });
  const updated = service.annotateLlmAudit(first.id, { decision_validation: { verdict: "rejected" } });
  assert.equal(updated.operation_type, "o1", "补注不许漂到别的行");
  const rows = service.listLlmAudits({ limit: 20 });
  assert.equal(rows.find((r) => r.operation_type === "noise").metadata, undefined, "噪声行不许被写上本轮判决");
  store.close();
});

test("#534: saveLlmAudit 不再用「取最大 id」回读（源码锁）", () => {
  const src = readFileSync(new URL("../src/store.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("function saveLlmAudit(entry)"));
  const head = body.slice(0, body.indexOf("\n  }\n"));
  // 先去注释再判：解释这条坑的注释本身会引述旧写法，不剥掉就永远命中自己。
  const code = head.replace(/^\s*\/\/.*$/gm, "");
  assert.equal(code.includes("ORDER BY id DESC LIMIT 1"), false,
    "多进程共用同一库时「取最大 id」会读成别人的行——必须用 lastInsertRowid");
  assert.match(code, /lastInsertRowid/, "回读口径锁在本次插入返回的 rowid 上");
  assert.match(code, /SELECT \* FROM llm_audit_logs WHERE id = \?/, "回读用主键定位，不用排序取首行");
});

// ---------------------------------------------------------------- 改动面守卫

test("#534: decisions 列之外没有别的写入口往那一列塞非决策对象", () => {
  // 这条锁防的是「后来有人图省事，把原文/诊断内联进 decisions」——那会同时打挂
  // applyDecisions 的重放语义与所有按决策数组消费的下游。
  const src = readFileSync(new URL("../src/dream.js", import.meta.url), "utf8");
  assert.match(src, /raw_output:\s*result\.raw_output/, "finish 必须把 raw_output 转发给 saveDreamRun");
  assert.equal(src.includes("_rawOutput"), false, "不许另起一个内联标记走 decisions 列");
});
