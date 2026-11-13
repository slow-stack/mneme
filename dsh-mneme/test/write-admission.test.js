import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";
import {
  createWriteAdmission,
  extractTopicKeys,
  informationlessReason,
  ADMISSION_DENY_BLANK,
  ADMISSION_DENY_NOISE,
  ADMISSION_OPERATION_TYPE,
  ADMISSION_TRIGGER_SOURCE
} from "../src/write-admission.js";
import { POSITIVE_SAMPLES, NEGATIVE_SAMPLES, SAMPLE_VALUES, referenceScan } from "./helpers/write-admission-samples.js";
// #164 A2 的真判据 + 真配置：这一组测的是**接线**（index.js 那条路径的等价物），
// 判据自己的验收在 test/sensitive-scan.test.js。config 用真 schema 而不是手搓对象，
// 钉住「键名/嵌套形状与生产一致」——手搓的 `{ sensitiveScanEnabled: true }` 在键名
// 写错时照样过，真 config 才会红。
import { Config } from "../src/config.js";
import { createSensitiveScan } from "../src/sensitive-scan.js";
import { bootstrapFromDirectory } from "../src/bootstrap.js";
import { createDreamScheduler } from "../src/dream.js";
import { mockCtx } from "./helpers/dream-mock.js";
import { testConfig } from "./helpers/test-config.js";

// #254 写入准入（第一阶段：只计量，不拦截）。
// 本批次没有阈值、没有拦截分支，验收看两件事：默认路径零行为变化（无会话身份的
// 写入与未接线的服务都不记行），以及两个闸门的测量点可查（g1 会话写入预算按行聚
// 合、g2 同话题重复带间隔）。第二阶段的拦截（memory_save({confirm:true})）不在这
// 里锁——现在还没有那个分支。

function setup({ wired = true, now, admissionConfig } = {}) {
  const store = createStore(":memory:");
  const writeAdmission = wired ? createWriteAdmission({ store, now, config: admissionConfig }) : null;
  const service = createService({ store, mirror: null, config: testConfig({}), writeAdmission });
  return { store, service, writeAdmission };
}

function admissionRows(store, sessionKey) {
  return store.listLlmAudits({ sessionKey }).filter((r) => r.operation_type === ADMISSION_OPERATION_TYPE);
}

test("无会话身份的写入不进预算，也不写准入行", () => {
  const { store, service } = setup();
  const created = service.saveWithDedupe({ type: "project", title: "T", content: "正文内容一段" });
  assert.equal(created.action, "created");
  assert.equal(store.listLlmAudits().length, 0, "系统写入（dream / summarize / import / organize）不记准入行");

  // 未接线写入准入的服务（老调用方 / 单测）同样零变化
  const bare = createService({ store, mirror: null, config: testConfig({}) });
  assert.equal(bare.saveWithDedupe({ type: "project", title: "T2", content: "另一段内容" }).action, "created");
  assert.equal(store.listLlmAudits().length, 0, "未接线时不产生任何审计行");
});

test("g1：会话内每个新建行记一行，合并行不记", () => {
  const { store, service } = setup();
  const s = { _sessionKey: "sess-1" };
  service.saveWithDedupe({ ...s, type: "project", title: "A", content: "第一段内容" });
  service.saveWithDedupe({ ...s, type: "project", title: "A", content: "追加的第二段" });
  service.saveWithDedupe({ ...s, type: "project", title: "B", content: "另一件事" });

  const rows = admissionRows(store, "sess-1");
  assert.equal(rows.length, 2, "两个新建行 = 两行；并入已有行不算新增（维护者拍板第 2 项）");
  for (const row of rows) {
    assert.equal(row.trigger_source, ADMISSION_TRIGGER_SOURCE);
    assert.equal(row.status, "skipped", "阶段一不拦截，沿用既有 skip 口径");
    assert.equal(row.metadata.gate, "g1");
    assert.equal(row.session_key, "sess-1");
    assert.equal(row.model_id, "-", "不是模型调用，占位串避免混进路由花费统计");
  }
  // 行上的会话键可等值查询：按会话聚合即得「会话内新建条数」分布
  assert.equal(store.countLlmAudits({ sessionKey: "sess-1" }), 2);
  assert.equal(store.countLlmAudits({ sessionKey: "sess-2" }), 0);
});

test("pinned 类型（constraint / preference）不进预算，穿透频率仍可观测", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ _sessionKey: "s", type: "constraint", title: "C", content: "边界条件" });
  service.saveWithDedupe({ _sessionKey: "s", type: "preference", title: "P", content: "用户偏好" });
  service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "T", content: "普通记录" });

  const rows = admissionRows(store, "s");
  assert.equal(rows.length, 3, "穿透口也记行——否则「预算为什么没算它」不可观测");
  assert.deepEqual(
    rows.map((r) => r.metadata.exempt ?? null).sort(),
    [null, "pinned", "pinned"]
  );
});

test("g2：同会话内同话题锚重复新建时记一行，带间隔", () => {
  let clock = 1_000_000;
  const { store, service } = setup({ now: () => clock });
  service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "开工", content: "先把 #254 的准入做完" });
  assert.equal(admissionRows(store, "s").length, 1, "话题首次出现不算重复");

  clock += 90_000;
  service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "换了个标题", content: "接着做 #254，另起一段" });
  const rows = admissionRows(store, "s");
  assert.equal(rows.length, 2, "一行一个新建行，g2 是这一行上的附加信号，不另起一行");
  assert.equal(rows[0].metadata.gate, "g1");
  assert.equal(rows[0].metadata.g2.topic, "#254");
  assert.equal(rows[0].metadata.g2.gap_ms, 90_000, "间隔按会话内最近一次同话题新建行算");
  assert.equal(rows[1].metadata.g2, undefined, "首次出现没有 g2");
  assert.equal(rows[0].status, "skipped");
});

test("g2：并入已有行不算同话题重写", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "同一标题", content: "看 #254" });
  service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "同一标题", content: "再看 #254" });
  const rows = admissionRows(store, "s");
  assert.equal(rows.length, 1, "合并是去重机制在正常工作，既不进预算也不产生 g2");
});

// #254 内容哈希（exact duplicate）：判据是归一化后逐字节相同，不是相似度；候选集把
// 归档行一起纳入——归档行不在 saveWithDedupe 的候选集里（store.list 默认排除归档），
// 同一个事实再写一次就是新行，这正是这条信号要量的穿透。
test("dup：命中归档行的重复写入被记下来（归档行在候选集内）", () => {
  const { store, service } = setup();
  const first = service.saveWithDedupe({ type: "project", title: "归档事实", content: "同一件事的正文" });
  store.setArchived(first.memory.id, true);
  const second = service.saveWithDedupe({
    _sessionKey: "sess-dup",
    type: "project",
    title: "归档事实",
    content: "同一件事的正文"
  });
  assert.equal(second.action, "created", "归档行不在去重候选集里，所以确实新建了一行");

  const rows = admissionRows(store, "sess-dup");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].metadata.dup, { memory_id: first.memory.id, archived: true, forgotten: false });
});

test("dup：只差格式（大小写/空白/标点）的重复也算命中", () => {
  const { store, service } = setup();
  const first = service.saveWithDedupe({ type: "project", title: "Task A", content: "Line1.\n\nLine2" });
  // 标题只差大小写 → saveWithDedupe 的精确标题匹配落空 → 走新建路径
  const second = service.saveWithDedupe({
    _sessionKey: "sess-fmt",
    type: "project",
    title: "task a",
    content: "line1 line2"
  });
  assert.equal(second.action, "created");
  const rows = admissionRows(store, "sess-fmt");
  assert.deepEqual(rows[0].metadata.dup, { memory_id: first.memory.id, archived: false, forgotten: false });
});

test("dup：同内容既有活跃行又有归档行时报活跃那条（活区优先，而不是谁最近被改过）", () => {
  // 回归点（单盲审查 L2）：候选集按 updated_at 倒序返回，直接取第一条会把「命中归档
  // 区」这个信号盖掉（归档动作刚刷过 updated_at）。口径：有活跃命中就报它。
  const { store, service } = setup();
  const active = store.save({ type: "project", title: "Task A", content: "同一件事" });
  const archived = store.save({ type: "project", title: "task a", content: "同一件事" });
  store.setArchived(archived.id, true);
  const created = service.saveWithDedupe({
    _sessionKey: "sess-both", type: "project", title: "TASK a", content: "同一件事"
  });
  assert.equal(created.action, "created", "标题只差大小写 → 精确标题匹配落空，走新建路径");
  assert.deepEqual(admissionRows(store, "sess-both")[0].metadata.dup, { memory_id: active.id, archived: false, forgotten: false });
});

test("dup：只剩已遗忘未归档的命中时，不把它记成活区命中", () => {
  // 回归（自动评审 #311 write-admission.js:158）：只回 archived 会把遗忘区命中写成
  // archived:false，读审计的人会以为存在活跃重复；而 saveWithDedupe 的候选集本来就排除
  // 遗忘行（store.list 默认 includeForgotten=false），这类命中同样是穿透。两个出口分字段记。
  // 两条行同标题同正文：遗忘之后标题候选集里已经没有它，第二次写入自然走新建路径。
  const { store, service } = setup();
  const first = service.saveWithDedupe({ type: "project", title: "遗忘事实", content: "同一段遗忘正文" });
  store.setForget(first.memory.id, true);
  const second = service.saveWithDedupe({
    _sessionKey: "sess-forgot", type: "project", title: "遗忘事实", content: "同一段遗忘正文"
  });
  assert.equal(second.action, "created", "遗忘行不在去重候选集里，所以确实新建了一行");
  assert.deepEqual(admissionRows(store, "sess-forgot")[0].metadata.dup, {
    memory_id: first.memory.id, archived: false, forgotten: true
  });
});

test("dup：不同内容不记 dup（负样本，免得信号恒真）", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "T1", content: "第一件事的正文" });
  service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "T2", content: "另一件事的正文" });
  const rows = admissionRows(store, "s");
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.metadata.dup, undefined);
});

test("dup：pinned 行不查候选集（整个不在闸门里，与 g2 的不当基准同口径）", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ _sessionKey: "s", type: "constraint", title: "边界 X", content: "同一段边界" });
  service.saveWithDedupe({ _sessionKey: "s", type: "constraint", title: "边界 x", content: "同一段边界" });
  const rows = admissionRows(store, "s");
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.metadata.exempt, "pinned");
    assert.equal(row.metadata.dup, undefined, "穿透口不发候选集查询，也不记 dup");
  }
});

test("话题表由审计行重建：新实例（进程重启）仍能认出同话题", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "A", content: "#99 的记录" });

  // 新实例 = 进程重启：内存视图为空，只能从审计行回填
  const revived = createWriteAdmission({ store });
  const service2 = createService({ store, mirror: null, config: testConfig({}), writeAdmission: revived });
  service2.saveWithDedupe({ _sessionKey: "s", type: "project", title: "B", content: "#99 又记了一笔" });

  const g2 = admissionRows(store, "s").filter((r) => r.metadata.g2);
  assert.equal(g2.length, 1, "审计行是唯一真相源，重启不回退");
  assert.equal(g2[0].metadata.g2.topic, "#99");
});

test("pinned 行不推进同话题基准（它整个不在闸门里）", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ _sessionKey: "s", type: "constraint", title: "边界", content: "见 #254" });
  service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "记录", content: "见 #254 的另一段" });
  assert.equal(
    admissionRows(store, "s").filter((r) => r.metadata.g2).length,
    0,
    "穿透行不当基准，g2 样本不掺穿透流量"
  );
});

test("llmAudit 关掉时一行都不写（那个开关同时关掉了审计行的保留期清理）", () => {
  const { store, service } = setup({ admissionConfig: { llmAudit: { enabled: false } } });
  service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "T", content: "内容 #254" });
  assert.equal(store.listLlmAudits().length, 0, "审计关掉时不得在无保留期的表里按写入频次增长");
});

test("话题锚只取机械可判的两类：issue 引用与文件路径", () => {
  assert.deepEqual(
    extractTopicKeys({ title: "修 #254，#254 已经报过", content: "见 src/service.js 与 docs/handbook/02-write-path.md" }),
    ["#254", "docs/handbook/02-write-path.md", "src/service.js"],
    "去重 + 排序 + 小写归一（同话题必须逐字节相等才能等值比较）"
  );
  assert.deepEqual(extractTopicKeys({ title: "SRC/Service.JS", content: "大小写不该造出两个话题" }), ["src/service.js"]);
  assert.deepEqual(
    extractTopicKeys({ title: "路径", content: "src\\service.js 与 src/service.js 是同一处" }),
    ["src/service.js"],
    "分隔符归一：同一个文件不能因为写法不同变成两个话题"
  );
  // 误报样本：Markdown 标题（###1）、比值（3.5/2.0）、版本号（v1.2.3）都不该成为话题锚
  assert.deepEqual(extractTopicKeys({ title: "###1 小节", content: "比例约 3.5/2.0，版本 v1.2.3" }), []);
  assert.deepEqual(extractTopicKeys({ title: "普通记录", content: "没有任何锚点的一段话" }), []);
  assert.deepEqual(extractTopicKeys({}), []);
});

test("计量失败不反噬写入（旁路，只 warn）", () => {
  const store = createStore(":memory:");
  const throwing = createService({
    store,
    mirror: null,
    config: testConfig({}),
    writeAdmission: {
      evaluate() { throw new Error("evaluate boom"); },
      record() { throw new Error("record boom"); }
    }
  });
  assert.equal(
    throwing.saveWithDedupe({ _sessionKey: "s", type: "project", title: "T", content: "内容" }).action,
    "created",
    "evaluate 抛错不能挡下写入"
  );

  // evaluate 成功、record 抛错：写入照常返回
  const real = createWriteAdmission({ store });
  const halfBroken = createService({
    store,
    mirror: null,
    config: testConfig({}),
    writeAdmission: { evaluate: real.evaluate, record() { throw new Error("record boom"); } }
  });
  assert.equal(
    halfBroken.saveWithDedupe({ _sessionKey: "s", type: "project", title: "T2", content: "内容二" }).action,
    "created",
    "record 抛错不能反噬写入"
  );
});

test("接线：memory_save 把会话键交给写入准入，缺会话身份的宿主落 null", async () => {
  const store = createStore(":memory:");
  const writeAdmission = createWriteAdmission({ store });
  const service = createService({ store, mirror: null, config: testConfig({}), writeAdmission });
  const registered = [];
  createTools({ tools: { register(def) { registered.push(def); return () => {}; } } }, service, {}, null);
  const save = registered.find((t) => t.name === "memory_save");
  assert.ok(save, "memory_save 应已注册");

  await save.execute(
    { type: "project", title: "T", content: "记录 #254" },
    { agent: { session: { id: "sess-9", header: { agentPreset: "coder", cwd: "D:\\proj" } } } }
  );
  assert.equal(store.countLlmAudits({ sessionKey: "sess-9" }), 1, "工具层要真的把会话键传下去");

  await save.execute({ type: "project", title: "T2", content: "无会话身份" }, {});
  assert.equal(store.countLlmAudits(), 1, "缺会话身份时既不记行也不报错");
});

test("旧库（llm_audit_logs 无 session_key）打开自动补列，准入行照常落", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-admission-"));
  const dbPath = join(dir, "memory.db");
  try {
    // 用裸 DatabaseSync 构造带 #254 之前表结构的旧库
    const old = new DatabaseSync(dbPath);
    old.exec(`
      CREATE TABLE llm_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        trigger_source TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        model_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        error_message TEXT,
        related_memory_ids TEXT,
        metadata TEXT
      );
      INSERT INTO llm_audit_logs (timestamp, trigger_source, operation_type, model_id, status, metadata)
        VALUES ('2026-01-01T00:00:00.000Z', 'autoDream', 'dream_consolidate', 'm', 'success', '{"old":1}');
    `);
    old.close();

    let store = createStore(dbPath);
    const cols = store.db.prepare("PRAGMA table_info(llm_audit_logs)").all().map((c) => c.name);
    assert.ok(cols.includes("session_key"), "旧库打开必须自动补 session_key 列");
    assert.equal(store.listLlmAudits().length, 1, "存量审计行保留");
    assert.equal(store.listLlmAudits()[0].session_key, undefined, "存量行该列为空");

    const admission = createWriteAdmission({ store });
    const memory = { title: "开工", content: "#254 的准入" };
    admission.record({
      sessionKey: "s1",
      verdict: admission.evaluate({ memory, sessionKey: "s1" }),
      memoryId: "m1"
    });
    assert.equal(store.countLlmAudits({ sessionKey: "s1" }), 1, "迁移后的库上准入行可落可查");

    // 重复打开幂等：列不重复、既有行不丢
    store.close();
    store = createStore(dbPath);
    assert.equal(store.countLlmAudits({ sessionKey: "s1" }), 1, "重复打开不丢数据");
    assert.equal(store.countLlmAudits(), 2, "既有的 LLM 审计行与准入行都在");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 第 1 级确定性拒绝（#254 第二阶段） ----------------------------------------
// 判据面按 09-21 / 09-22 两轮收窄到两类：空白 / 纯噪声 + 注入进来的密钥 / PII。
// 去重键命中**不**在这里（归 write-update 放行），G1/G2 阈值也只是计量。
//
// 两个开关都默认关，所以这一组测试的第一件事是证明「关掉时逐字段等于只计量那一
// 阶段」。拦截面本身要证明三件事：拒了（真的没落库）、可解释（审计行里有 reason）、
// 不误杀（正常文本一条不动）。

function level1Store(opts = {}) {
  const { enabled = false, enforce = false, sensitiveScan = null, now } = opts;
  const store = createStore(":memory:");
  const writeAdmission = createWriteAdmission({
    store,
    now,
    config: testConfig({ writeAdmission: { enabled, enforce } }),
    sensitiveScan
  });
  const service = createService({ store, mirror: null, config: testConfig({}), writeAdmission });
  return { store, service, writeAdmission };
}

/** 落库行数（含归档 / 遗忘：被拒的写入一条都不该多）。 */
function rowCount(store) {
  return store.list({ limit: 500, includeArchived: true, includeForgotten: true }).length;
}

test("信息量判据：blank 与 noise 分开报，正常文本不命中", () => {
  assert.equal(informationlessReason({ title: "", content: "" }), "blank");
  assert.equal(informationlessReason({ title: "   ", content: "\n\t " }), "blank", "纯空白折掉之后什么都没写");
  assert.equal(informationlessReason({ title: "标题", content: "" }), null, "有一边有内容就不是空写入");
  assert.equal(informationlessReason({ title: "!!!", content: "--- ..." }), "noise", "只有标点 = 归一化后什么都不剩");
  assert.equal(informationlessReason({ title: "a", content: "..." }), null, "只剩一个字母也算有信息");
  // 两种 reason 分开报是为了可解释：blank 是提交了空表单，noise 是只填了标点，修法不同。
  assert.notEqual(ADMISSION_DENY_BLANK, ADMISSION_DENY_NOISE);
});

test("默认关：enabled 关时判据根本不跑，连 enforce 开着也没用", () => {
  const { store, service } = level1Store({ enabled: false, enforce: true });
  const result = service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "", content: "   " });
  assert.equal(result.action, "created", "判据没开就不该有任何拒绝分支");
  assert.equal(rowCount(store), 1);
  const rows = admissionRows(store, "s");
  assert.equal(rows.length, 1, "只计量那一阶段的行为逐字段保留");
  // 验收第 1 条是「默认路径逐字节一致」，所以这里断言的是**整个 metadata**与只计量
  // 阶段相同：连一个恒为 "allow" 的 decision 键都不该多出来。多一个键就意味着
  // 「默认关零行为变化」从事实变成了需要解释的说法。
  assert.deepEqual(rows[0].metadata, { gate: "g1", topics: [] });
  assert.equal(rows[0].metadata.deny, undefined, "判据没跑就不该有拒绝面");
});

test("仅告警档：enabled 开、enforce 关 → 写入成功，审计行带拒绝面", () => {
  const { store, service } = level1Store({ enabled: true, enforce: false });
  const result = service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "!!", content: "..." });
  assert.equal(result.action, "created", "只开检测不拦写入");
  assert.equal(rowCount(store), 1);
  const rows = admissionRows(store, "s");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].metadata.decision, "allow", "仅告警档的决策仍是放行");
  assert.deepEqual(rows[0].metadata.deny, { reason: "noise", enforced: false });
  // 「deny 非空但 decision=allow」就是仅告警档的指纹，不必再读配置才能解释这一行。
});

test("硬拒：enabled + enforce → 不落库、返回 reason、审计行标 enforced", () => {
  const { store, service } = level1Store({ enabled: true, enforce: true });
  const result = service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "   ", content: "" });
  assert.equal(result.action, "denied");
  assert.equal(result.reason, "blank");
  assert.equal(result.memory, null, "被拒的写入没有行可返回");
  assert.equal(rowCount(store), 0, "store.save 在拒绝时根本没有被调用");

  const rows = admissionRows(store, "s");
  assert.equal(rows.length, 1, "拒绝面必须留审计（验收第 2 条：可解释、不静默丢弃）");
  assert.equal(rows[0].related_memory_ids.length, 0, "没有产生任何行，不能挂一个不存在的 id");
  assert.equal(rows[0].metadata.decision, "deny");
  assert.deepEqual(rows[0].metadata.deny, { reason: "blank", enforced: true });

  // 标题有内容就不是空写入：标题有信息（去重键就是它），归一化后非空不该被拒。
  const titled = service.saveWithDedupe({ _sessionKey: "s2", type: "project", title: "标题", content: "" });
  assert.equal(titled.action, "created", "title 有内容 = 有信息，不能判成 blank");
});

test("被拦下的写入不推进话题基准（它没进库，不能成为下一次 g2 的基准）", () => {
  const { store, service } = level1Store({
    enabled: true, enforce: true, sensitiveScan: referenceScan, now: () => 1_000_000
  });
  // 用密钥类而不是空白类来测这件事：空白/噪声行**不可能**带话题锚（锚是 `#254` /
  // 路径这类含数字或字母的串，normalizeForHash 之后仍非空，所以它在第 1 级根本不
  // 会命中）——这条回归只有在 sensitive 那一档才可复现，而密钥行通常也写着上下文。
  const denied = service.saveWithDedupe({
    _sessionKey: "s",
    type: "project",
    title: "见 #254",
    content: `token 是 ${SAMPLE_VALUES.githubPat}`
  });
  assert.equal(denied.action, "denied");
  assert.equal(denied.deny.kind, "github_token");
  // 同一话题再来一条正常写入：如果被拒那条推进了基准，这里就会凭空多出一个 g2。
  service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "记录", content: "#254 的正文" });
  const g2 = admissionRows(store, "s").filter((r) => r.metadata.g2);
  assert.equal(g2.length, 0, "拒绝行不能造出一条不存在的时间线");
  assert.equal(rowCount(store), 1, "只有第二条真的落库了");
});

test("硬拒在 pinned 豁免之前：写着空内容的 constraint 一样被拒", () => {
  // pinned 豁免的是**预算与冷却**（constraint / preference 是逐字保真池，不该被会话
  // 预算拦），不是「这条能不能落库」。顺序反了就会出现「pinned 行绕过第 1 级」。
  const { store, service } = level1Store({ enabled: true, enforce: true });
  const result = service.saveWithDedupe({ _sessionKey: "s", type: "constraint", title: "...", content: "" });
  assert.equal(result.action, "denied");
  assert.equal(result.reason, "noise");
  assert.equal(rowCount(store), 0);
  assert.equal(admissionRows(store, "s")[0].metadata.deny.reason, "noise");
});

test("sensitiveScan 注入：正样本一条都不漏放（密钥 + PII）", () => {
  const { store, service } = level1Store({ enabled: true, enforce: true, sensitiveScan: referenceScan });
  for (const sample of POSITIVE_SAMPLES) {
    const result = service.saveWithDedupe({
      _sessionKey: `sess-${sample.id}`,
      type: "project",
      title: sample.title,
      content: sample.content
    });
    assert.equal(result.action, "denied", `${sample.id} 被漏放（${sample.why}）`);
    assert.equal(result.reason, "sensitive", `${sample.id} 的 reason 该是 sensitive`);
    const deny = admissionRows(store, `sess-${sample.id}`)[0].metadata.deny;
    assert.equal(deny.kind, sample.kind, `${sample.id} 的 kind 要落进审计，enforce 前的分布才可按类看`);
    assert.equal(deny.enforced, true);
  }
  assert.equal(rowCount(store), 0, "正样本一条都不该落库");
});

test("sensitiveScan 注入：负样本一条都不误杀（含敏感词但没有值）", () => {
  const { store, service } = level1Store({ enabled: true, enforce: true, sensitiveScan: referenceScan });
  for (const sample of NEGATIVE_SAMPLES) {
    const result = service.saveWithDedupe({
      _sessionKey: `sess-${sample.id}`,
      type: "project",
      title: sample.title,
      content: sample.content
    });
    assert.equal(result.action, "created", `${sample.id} 被误杀（${sample.why}）`);
  }
  assert.equal(rowCount(store), NEGATIVE_SAMPLES.length, "负样本应当全部落库");
  // 负样本一条 deny 面都不该有——误杀面是这条闸门唯一会伤人的地方。
  for (const sample of NEGATIVE_SAMPLES) {
    for (const row of admissionRows(store, `sess-${sample.id}`)) {
      assert.equal(row.metadata.deny, undefined, `${sample.id} 不该带任何拒绝面`);
    }
  }
});

test("sensitiveScan 抛错按「未命中」处理：判据故障不能让写入变成不可用", () => {
  const { store, service } = level1Store({
    enabled: true,
    enforce: true,
    sensitiveScan() { throw new Error("scanner boom"); }
  });
  const result = service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "正常", content: "正常正文" });
  assert.equal(result.action, "created", "扫描器坏了必须放行，不能把所有写入拦死");
  assert.equal(rowCount(store), 1);
});

test("命中且 enforce 时不发候选集查询（决策已定，白花成本）", () => {
  const { store, service } = level1Store({ enabled: true, enforce: true });
  // 先落一条同内容（走正常开关），再做一次同内容写入：若还查候选集，就会带上 dup。
  store.save({ type: "project", title: "已存在", content: "已存在的正文" });
  const result = service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "...", content: "" });
  assert.equal(result.action, "denied");
  const rows = admissionRows(store, "s");
  assert.equal(rows.length, 1, "只该有拒绝那一行");
  assert.equal(rows[0].metadata.dup, undefined, "拒绝路径不查候选集");
});

test("接线：被拒时 memory_save 返回 action=denied 与可行动的 reason", async () => {
  const store = createStore(":memory:");
  const writeAdmission = createWriteAdmission({
    store,
    config: testConfig({ writeAdmission: { enabled: true, enforce: true } })
  });
  const service = createService({ store, mirror: null, config: testConfig({}), writeAdmission });
  const registered = [];
  createTools({ tools: { register(def) { registered.push(def); return () => {}; } } }, service, {}, null);
  const save = registered.find((t) => t.name === "memory_save");

  const denied = await save.execute(
    { type: "project", title: "...", content: "" },
    { agent: { session: { id: "sess-deny" } } }
  );
  assert.equal(denied.action, "denied");
  assert.equal(denied.reason, "noise");
  assert.equal(denied.id, undefined, "没有落库就不该编一个 id 出来");
  assert.equal(store.countLlmAudits({ sessionKey: "sess-deny" }), 1, "工具层拒绝也要留审计");

  // 正常写入不受影响，返回形状与既有调用方一致
  const ok = await save.execute(
    { type: "project", title: "正常标题", content: "正常正文内容" },
    { agent: { session: { id: "sess-deny" } } }
  );
  assert.equal(ok.action, "created");
  assert.ok(ok.id, "正常路径仍然返回 id");
});

// --- #164 A2 接线：判据自己的闸 × 闸门的 enforce -------------------------------
// 这一组是 index.js 那条装配路径的等价物：真 config（Config({})）+ createSensitiveScan
// 工厂 + 写入准入。三层开关的语义由此钉住——判据关（默认）不参与、判据开而 enforce 关
// 只留审计、两个都开才拦。判据本身的假阳/漏放验收在 test/sensitive-scan.test.js。

/** 用真 `Config` 解析默认值，再叠加测试要覆盖的那几个键。 */
function a2Store(overrides = {}) {
  const cfg = Config(overrides);
  const store = createStore(":memory:");
  const writeAdmission = createWriteAdmission({
    store,
    config: cfg,
    sensitiveScan: createSensitiveScan({ config: cfg })
  });
  const service = createService({ store, mirror: null, config: cfg, writeAdmission });
  return { store, service, cfg };
}

const SECRET_ROW = {
  type: "project",
  title: "调试记录",
  content: `临时代码里贴了 ${SAMPLE_VALUES.githubPat}，回头删掉`
};

test("A2 默认关：写有密钥的行照常落库，且连拒绝面都不该出现", () => {
  const { store, service } = a2Store();
  const result = service.saveWithDedupe({ ...SECRET_ROW, _sessionKey: "s" });
  assert.equal(result.action, "created", "判据默认关时这条路径与 #332 逐字段一致");
  assert.equal(rowCount(store), 1);
  // metadata 里不该多出任何 deny/decision 键——「默认关零行为变化」是验收第 1 条，
  // 多一个恒为 allow 的键就把它从事实变成需要解释的说法（同上面 #254 那条）。
  const row = admissionRows(store, "s")[0];
  assert.equal(row.metadata.deny, undefined);
  assert.equal(row.metadata.decision, undefined);
});

test("A2 观察档：判据开、enforce 关 → 写入照常，审计行带 kind 与 enforced=false", () => {
  const { store, service } = a2Store({ sensitiveScanEnabled: true, writeAdmission: { enabled: true } });
  const result = service.saveWithDedupe({ ...SECRET_ROW, _sessionKey: "s" });
  assert.equal(result.action, "created", "#164 口径：默认仅告警");
  assert.equal(rowCount(store), 1);
  const deny = admissionRows(store, "s")[0].metadata.deny;
  assert.equal(deny.reason, "sensitive");
  assert.equal(deny.kind, "github_token");
  assert.equal(deny.enforced, false, "仅告警档的指纹：deny 非空、enforced=false、写入仍发生");
});

test("A2 拦截档：判据开 + enforce 开 → 拒了、没落库、审计标 enforced", () => {
  const { store, service } = a2Store({
    sensitiveScanEnabled: true,
    writeAdmission: { enabled: true, enforce: true }
  });
  const result = service.saveWithDedupe({ ...SECRET_ROW, _sessionKey: "s" });
  assert.equal(result.action, "denied");
  assert.equal(result.reason, "sensitive");
  assert.equal(rowCount(store), 0, "被拒的写入一条都不该落库");
  const deny = admissionRows(store, "s")[0].metadata.deny;
  assert.equal(deny.kind, "github_token");
  assert.equal(deny.enforced, true);
});

test("A2 与第 1 级空白判据互不依赖：只开 A2 不会把空白写入拦下", () => {
  // 两个键是两批判据的闸（空白/噪声 vs 密钥/PII），分开是为了能单独观察 A2 的
  // 命中分布——绑在一个开关上就没法只看这一类的假阳率。
  const { store, service } = a2Store({ sensitiveScanEnabled: true });
  const blank = service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "...", content: "" });
  assert.equal(blank.action, "created", "A2 开着不等于第 1 级判据也开");
  assert.equal(admissionRows(store, "s")[0].metadata.deny, undefined);
  // 反过来：只开第 1 级（writeAdmission.enabled）、A2 关，密钥行照常落库。
  const { store: s2, service: svc2 } = a2Store({ writeAdmission: { enabled: true } });
  assert.equal(svc2.saveWithDedupe({ ...SECRET_ROW, _sessionKey: "s" }).action, "created");
  assert.equal(s2.list({ limit: 10 }).length, 1);
});

test("A2 跑在闸门里：只开 sensitiveScanEnabled（闸门关）时扫描器根本不参与", () => {
  // 判据的唯一调用点是 write-admission 的 firstLevelHit，而闸门要
  // writeAdmission.enabled 打开才走第 1 级判据。所以「本键开着」不等于「会扫」——
  // 配置注释与面板文案都按这条写，否则用户以为单开本键就能拿到 A2 的命中分布。
  const { store, service } = a2Store({ sensitiveScanEnabled: true });
  const result = service.saveWithDedupe({ ...SECRET_ROW, _sessionKey: "s" });
  assert.equal(result.action, "created", "闸门没开时 A2 不参与判定");
  assert.equal(rowCount(store), 1, "写入照常落库");
  const rows = admissionRows(store, "s");
  assert.ok(rows.length > 0, "闸门仍走计量路径（去重 / g2 不受第 1 级开关影响）");
  assert.ok(rows.every((row) => row.metadata.deny === undefined), "一条 deny 审计都没有：第 1 级判据整体没跑");
});

test("A2 负样本在真装配下一条都不误杀（含敏感词但没有值）", () => {
  const { store, service } = a2Store({
    sensitiveScanEnabled: true,
    writeAdmission: { enabled: true, enforce: true }
  });
  for (const sample of NEGATIVE_SAMPLES) {
    const result = service.saveWithDedupe({
      _sessionKey: `sess-${sample.id}`,
      type: "project",
      title: sample.title,
      content: sample.content
    });
    assert.equal(result.action, "created", `${sample.id} 被误杀（${sample.why}）`);
  }
  assert.equal(rowCount(store), NEGATIVE_SAMPLES.length);
  for (const sample of NEGATIVE_SAMPLES) {
    for (const row of admissionRows(store, `sess-${sample.id}`)) {
      assert.equal(row.metadata.deny, undefined, `${sample.id} 不该带任何拒绝面`);
    }
  }
});

// --- #663 A2 覆盖面：系统写入（无 sessionKey）也过第 1 级判据 ---------------------
// 第 1 级判据管的是「这条文本能不能落库」，与会话身份无关。autoSummarize /
// dream 总览 / bootstrap 冷启动 / share 导入都没有会话，但落库的是同样的文本；
// #663 之前 evaluate 在判据之前就 return，等于这几条出口整片没判。
// 预算/话题冷却/内容哈希仍不进：它们要一条会话时间线做基准，没有会话就没有基准。

/** 无会话身份（session_key IS NULL）的准入行。 */
function systemAdmissionRows(store) {
  return store.listLlmAudits({ limit: 200 })
    .filter((r) => r.operation_type === ADMISSION_OPERATION_TYPE && r.session_key == null);
}

test("#663 系统写入默认档：判据关时不判、不落行，写入与 #332 逐字节一致", () => {
  const { store, service } = a2Store();
  const result = service.saveWithDedupe({ ...SECRET_ROW, source: "dream" });
  assert.equal(result.action, "created");
  assert.equal(rowCount(store), 1);
  assert.deepEqual(systemAdmissionRows(store), [], "判据关时系统写入一行审计都不该多");
});

test("#663 系统写入观察档：判据跑、拒绝面留行（session_key 为 NULL）、写入照常", () => {
  const { store, service } = a2Store({ sensitiveScanEnabled: true, writeAdmission: { enabled: true } });
  const result = service.saveWithDedupe({ ...SECRET_ROW, source: "dream" });
  assert.equal(result.action, "created", "仅告警档不拦");
  const rows = systemAdmissionRows(store);
  assert.equal(rows.length, 1, "系统写入的告警不能是静默的");
  const row = rows[0];
  assert.equal(row.session_key, undefined, "落库是 NULL，读回是 undefined——不编一个假 key");
  assert.equal(row.metadata.gate, null, "不进预算就没有 g1 行");
  assert.equal(row.metadata.decision, "allow");
  assert.equal(row.metadata.deny.reason, "sensitive");
  assert.equal(row.metadata.deny.kind, "github_token");
  assert.equal(row.metadata.deny.enforced, false);
});

test("#663 系统写入拦截档：拒了、没落库、审计行标 enforced", () => {
  const { store, service } = a2Store({
    sensitiveScanEnabled: true,
    writeAdmission: { enabled: true, enforce: true }
  });
  const result = service.saveWithDedupe({ ...SECRET_ROW, source: "dream" });
  assert.equal(result.action, "denied");
  assert.equal(result.reason, "sensitive");
  assert.equal(result.memory, null);
  assert.equal(rowCount(store), 0, "被拒的系统写入一条都不该落库");
  const rows = systemAdmissionRows(store);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_key, undefined, "落库是 NULL");
  assert.equal(rows[0].metadata.deny.enforced, true);
});

test("#663 系统写入同样吃空白/噪声判据（不只是密钥）", () => {
  const { store, service } = a2Store({ writeAdmission: { enabled: true, enforce: true } });
  const blank = service.saveWithDedupe({ type: "project", title: "", content: "", source: "bootstrap" });
  assert.equal(blank.action, "denied");
  assert.equal(blank.reason, "blank");
  assert.equal(rowCount(store), 0);
  assert.equal(systemAdmissionRows(store).length, 1);
});

test("#663 bootstrap 冷启动：被拒条目报 denied 而不是混进 merged，也不解引用 null", async () => {
  const { store, service } = a2Store({
    sensitiveScanEnabled: true,
    writeAdmission: { enabled: true, enforce: true }
  });
  const root = mkdtempSync(join(tmpdir(), "mneme-663-bootstrap-"));
  try {
    writeFileSync(join(root, "README.md"), `# Demo\n\n临时贴了 ${SAMPLE_VALUES.githubPat}，回头删掉。`);
    const report = await bootstrapFromDirectory({ service, dir: root, logger: null });
    assert.equal(report.created, 0);
    assert.equal(report.merged, 0, "被拒不该记成并入");
    assert.equal(report.denied, 1);
    assert.equal(report.items[0].action, "denied");
    assert.equal(report.items[0].id, null);
    assert.equal(report.items[0].reason, "sensitive");
    assert.equal(rowCount(store), 0);
    assert.equal(systemAdmissionRows(store).length, 1, "系统出口的拒绝也要留审计");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#663 dream 总览落盘：被拒时 outcome.summary 为 false，库里没有 summary 行", async () => {
  const { store, service } = a2Store({
    sensitiveScanEnabled: true,
    writeAdmission: { enabled: true, enforce: true }
  });
  const ctx = mockCtx({ summaryText: `记忆库总览：临时密钥 ${SAMPLE_VALUES.githubPat} 待清理。` });
  // 空库时 dream 直接 skip（skipped: true），走不到 summary 阶段——先种两行让它真跑。
  // 正文要够长：质量闸会把过短的行直接归档，归档行不进 dream 快照。
  service.saveWithDedupe({ type: "project", title: "插件", content: "第一条正文，长度足够的一段内容，用于 dream 快照。".repeat(3), importance: 3 });
  service.saveWithDedupe({ type: "project", title: "插件2", content: "第二条正文，另一段足够长的内容，用于区分两条记录。".repeat(3), importance: 4 });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const outcome = await dream.runDream(ctx, service, {});
  assert.notEqual(outcome.skipped, true, "库里有候选时不该再 skip");
  assert.equal(outcome.summary, false, "被拒的总览不能报成已落盘");
  assert.equal(store.list({ type: "summary", limit: 10 }).length, 0);
  assert.ok(
    systemAdmissionRows(store).some((r) => r.metadata.deny?.kind === "github_token"),
    "dream 出口的拒绝要留一行可查"
  );
});

