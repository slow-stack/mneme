// issue #502：#493 的第二种形态。JSON 是合法的，条目却被 `VALID` 全部滤掉——过去这
// 和「模型压根没写数组」共用一句 `invalid summary JSON`，而两者要修的地方完全不同，
// 更要命的是失败路径游标不推进：同一个窗口会被一遍遍重放（社区报告的实测：0.9.4 装上
// 之后 summarize 解冻了，隔 19 秒又来一条 invalid，输入 2711→输出 2047）。
// 本文件锁三层：判据分得开、读数说得出是哪一种、以及 prompt 与枚举从此一致（中英两份）。
import test from "node:test";
import assert from "node:assert/strict";
import { parseSummaryJsonResult, summarizeParseFailureAudit } from "../src/summarize.js";
import { STR } from "../src/lang.js";

const GOOD = { type: "project", title: "发布只在包目录内", content: "根目录发过坏包。" };
// 报告现场的原样形状：自造中文分类 + 多带 id/source 键
const BOGUS = [
  { id: 1, type: "环境/版本", content: "本地安装的 @modusensus/dsh-mneme 版本为 0.9.4", source: "工具结果：版本确认" },
  { id: "user_intent", type: "用户需求", content: "希望插件不再重复询问", source: "用户输入" }
];

test("filtered-empty：JSON 合法、条目全被枚举滤掉，要能报出 arr/valid 两个数", () => {
  const r = parseSummaryJsonResult(JSON.stringify(BOGUS));
  assert.equal(r.ok, false, "全被滤掉的窗口不能算成功（否则会永久推进游标）");
  assert.equal(r.failure.kind, "filtered-empty");
  assert.equal(r.failure.arrCount, 2);
  assert.deepEqual(r.failure.sampleTypes, ["环境/版本", "用户需求"],
    "把模型实际用的分类词原样带出来——不看这一眼就得去猜");

  const audit = summarizeParseFailureAudit(JSON.stringify(BOGUS), r.failure);
  assert.equal(audit.errorMessage, "no valid summary entries (arr=2, valid=0)");
  assert.equal(audit.metadata.failure_kind, "filtered-empty");
  assert.equal(audit.metadata.arr_count, 2);
  assert.equal(audit.metadata.invalid_entries, 2);
  assert.equal(audit.metadata.raw_has_bracket, true, "有方括号正是这一型的特征：它不是「没写格式」");
  assert.equal(audit.metadata.parse_failure, true);
});

test("no-array：模型在说话而不是在输出，判据与 filtered-empty 必须分开", () => {
  const raw = "我觉得这批内容挺有意思，我来点评一下：第一，版本确认很重要……";
  const r = parseSummaryJsonResult(raw);
  assert.equal(r.ok, false);
  assert.equal(r.failure.kind, "no-array");
  const audit = summarizeParseFailureAudit(raw, r.failure);
  assert.equal(audit.errorMessage, "invalid summary JSON", "这一型才该用原来那句话");
  assert.equal(audit.metadata.raw_has_bracket, false);
  assert.equal(audit.metadata.sample_types, undefined, "没有数组可言，不许编出 arr_count");
  assert.equal(audit.metadata.arr_count, undefined);
});

test("有合法条目时不产出 failure（成功路径不被诊断字段污染）", () => {
  const r = parseSummaryJsonResult(JSON.stringify([GOOD]));
  assert.equal(r.ok, true);
  assert.equal(r.failure, undefined);
  assert.equal(r.entries.length, 1);
});

test("raw_tail 只在正文确实长于头部窗口时给（短输出不重复贴一遍）", () => {
  const short = JSON.stringify(BOGUS);
  assert.equal(summarizeParseFailureAudit(short, { kind: "filtered-empty", arrCount: 2, sampleTypes: [] }).metadata.raw_tail, undefined);
  const long = JSON.stringify(BOGUS) + " ".repeat(600) + "尾巴在这里：后面其实还有半段点评";
  const meta = summarizeParseFailureAudit(long, { kind: "filtered-empty", arrCount: 2, sampleTypes: [] }).metadata;
  assert.ok(meta.raw_tail.includes("尾巴在这里"), "「先写几条合法再跑偏」的输出，只有尾巴能看出来");
  assert.ok(meta.raw_head.length <= 300);
});

// prompt 与闸门对齐（报告者的第 3 条，零行为变更）：菜单给全 7 个值、并写明不许自造。
// 中英两份都要锁——只改一种语言，另一种语言的窗口照样被滤空，而守卫看不见「两边一起过期」。
test("summary 提示词的枚举与 VALID 对齐，且中英两份都写明不许自造分类", () => {
  const all = ["preference", "project", "decision", "history", "rejected_solution", "pitfall", "constraint"];
  for (const lang of ["zh", "en"]) {
    const p = STR.prompts.summary[lang];
    for (const t of all) assert.ok(p.includes(t), `summary(${lang}) 枚举缺 ${t}`);
    assert.match(lang === "zh" ? p : p, /只能取上面枚举|must be one of the enumerated/, `summary(${lang}) 缺「不许自造分类」的约束`);
    assert.match(p, /id、source|id, source/, `summary(${lang}) 要写明不许附加 id/source 等额外键`);
  }
  // codingSummary 本来就列全了，确认没被这次批量替换改坏（它多出的说明句还在）
  assert.ok(STR.prompts.codingSummary.zh.includes("rejected_solution") && STR.prompts.codingSummary.zh.includes("pitfall"));
});
