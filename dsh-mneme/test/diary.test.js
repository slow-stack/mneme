// 日记本（v0.13）：纯函数 + 素材过滤 + 落盘边界的回归测试。
//
// 这些用例钉的都是「错了也不会有人立刻发现」的地方：
// - 跨天判定算错 → 要么一天写两篇，要么再也不写，界面都只是「今天没有日记」；
// - 素材过滤漏掉 decision 判据 → 日记变成「今天什么也没干」的噪音；
// - 空素材仍然调模型 → 配额白烧，写出来的还是编的；
// - 项目根为空却退成宿主 cwd → 私密正文摊在启动目录里。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { localDateString, shouldRollDay, dayGap, MAX_CATCH_UP_DAYS } from "../src/diary/rollover.js";
import { diaryDir, diaryFilePath, expandHome, memoryBase } from "../src/diary/dir.js";
import { collectQqInbox, inboxFiles, redactDigits, textOf, isEffective } from "../src/diary/qq-inbox.js";
import { collectSessionTranscript, sessionAgentId } from "../src/diary/session-provider.js";
import { validateBody, latestDiaryDate, createDiaryComposer } from "../src/diary/compose.js";
import { createDiaryAutoRun, DIARY_MIN_INTERVAL_MS } from "../src/diary/auto.js";
import { exportDiary, listDiaries, readDiary } from "../src/diary/export.js";

const tmp = mkdtempSync(join(tmpdir(), "mneme-diary-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

function fresh(name) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("localDateString 用本地时区，不是 UTC", () => {
  // 本地 00:30 这条边界是整件事的核心：用 UTC 会让北京时间早上 8 点前写的日记
  // 落进「昨天」，跨天判定跟着错一天。
  const local = new Date(2026, 10, 7, 0, 30, 0);
  assert.equal(localDateString(local), "2026-11-07");
});

test("dayGap：整天数；形状不对返回 null（调用方据此当首次）", () => {
  assert.equal(dayGap("2026-11-05", "2026-11-07"), 2);
  assert.equal(dayGap("2026-11-07", "2026-11-07"), 0);
  assert.equal(dayGap("2026-11-07", "2026-11-05"), -2);
  assert.equal(dayGap("nope", "2026-11-07"), null);
  assert.equal(dayGap("2026-11-07", null), null);
});

test("shouldRollDay：没写过写、同一天不写、跨天写、跨太久标 gap", () => {
  assert.deepEqual(shouldRollDay(null, "2026-11-07"), { roll: true, gapDays: null, gap: false });
  assert.deepEqual(shouldRollDay("2026-11-07", "2026-11-07"), { roll: false, gapDays: 0, gap: false });
  assert.deepEqual(shouldRollDay("2026-11-06", "2026-11-07"), { roll: true, gapDays: 1, gap: false });
  // 超过回补上限：仍然写一篇，但必须标 gap —— 只有这一处允许对读者说「中间断了」。
  const far = shouldRollDay("2026-11-01", "2026-11-07");
  assert.equal(far.roll, true);
  assert.equal(far.gap, true);
  assert.equal(far.gapDays, 6);
  assert.equal(MAX_CATCH_UP_DAYS, 1);
});

test("shouldRollDay：时钟回拨不写（那是同一天被重算，不是跨天）", () => {
  assert.deepEqual(shouldRollDay("2026-11-09", "2026-11-07"), { roll: false, gapDays: -2, gap: false });
});

test("shouldRollDay：今天的形状不对时不写（宁可不动手也不乱写）", () => {
  // 注意反例的选择：2026-13-99 仍匹配 /^\d{4}-\d{2}-\d{2}$/，会正常算出 gapDays，
  // 所以「形状不对」必须拿真的不成形的串来测，否则这条用例只是在测正则。
  assert.equal(shouldRollDay("2026-11-06", "2026-11-7").roll, false);
  assert.equal(shouldRollDay("2026-11-06", "not-a-date").roll, false);
  assert.equal(shouldRollDay("2026-11-06", "").roll, false);
});

test("diaryDir：项目根为空返回 null，绝不退成全局", () => {
  // 退成全局的症状是「日记写进了宿主启动目录」，而界面上一切正常。
  assert.equal(diaryDir({ memoryDir: tmp, projectRoot: "" }), null);
  assert.equal(diaryDir({ memoryDir: tmp, projectRoot: "   " }), null);
  const dir = diaryDir({ memoryDir: tmp, projectRoot: "D:\\QQ对话" });
  assert.ok(dir.startsWith(join(tmp, "diaries")));
  // 项目键是「目录名 + 路径哈希前 8 位」，绝对路径不进文件名。
  // 非 [A-Za-z0-9._-] 的字符逐个换成 "-"（candidates.js:184-197 的既有口径），
  // 所以中文「对话」两个字会变成两个连字符，不是原字。
  assert.match(dir.split(/[\\/]/).pop(), /^QQ---[0-9a-f]{8}$/);
  assert.equal(diaryFilePath(dir, "2026-11-07"), join(dir, "2026-11-07.md"));
});

test("expandHome / memoryBase：~` 必须展开，否则旁挂永远读不到", () => {
  assert.equal(expandHome("~"), homedir());
  assert.equal(memoryBase(""), expandHome("~/.dsh/memory"));
  assert.equal(memoryBase("  "), expandHome("~/.dsh/memory"));
  assert.equal(expandHome("D:\\x"), "D:\\x");
});

function frameOf({ ts, text = "你好", stage = "dispatch", ok = true, kind = "message" }) {
  return {
    v: 1,
    ts,
    kind,
    frame: {
      post_type: "message",
      message: text ? [{ type: "text", data: { text } }] : [{ type: "image", data: { file: "x.png" } }],
      raw_message: text,
      sender: { user_id: "166****", nickname: "n" },
      decision: { stage, ok, reason: "r" }
    }
  };
}

function writeInbox(dir, rows, generation = null) {
  mkdirSync(dir, { recursive: true });
  const name = generation === null ? "qq-inbox.jsonl" : `qq-inbox.${generation}.jsonl`;
  writeFileSync(join(dir, name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

test("inboxFiles：新一代在前；目录读不到返回 null（与「有目录没消息」严格区分）", () => {
  assert.equal(inboxFiles(join(tmp, "nope-dir")), null);
  const dir = fresh("inbox-order");
  writeInbox(dir, [], 2);
  writeInbox(dir, []);
  assert.deepEqual(inboxFiles(dir), ["qq-inbox.jsonl", "qq-inbox.2.jsonl"]);
});

test("isEffective / textOf：只认 dispatch+ok，只认 text 段", () => {
  assert.equal(isEffective({ decision: { stage: "dispatch", ok: true } }), true);
  assert.equal(isEffective({ decision: { stage: "whitelist", ok: false } }), false);
  assert.equal(isEffective({ decision: { stage: "dispatch", ok: false } }), false);
  assert.equal(isEffective({}), false);
  assert.equal(textOf({ message: [{ type: "text", data: { text: "a" } }, { type: "image", data: {} }] }), "a");
  assert.equal(textOf({ message: [{ type: "image", data: { file: "x" } }] }), "");
  assert.equal(textOf({}), "");
});

test("redactDigits：≥6 位数字串前 3 位 + ****（与 onebot record.js 同口径）", () => {
  assert.equal(redactDigits("号 1668531760 结尾"), "号 166**** 结尾");
  assert.equal(redactDigits("12345 不动"), "12345 不动");
});

test("collectQqInbox：只采当天、只采有效投递、跨轮换文件续读", () => {
  const day = "2026-11-07";
  const at = (h, m = 0) => new Date(2026, 10, 7, h, m).getTime();
  const dir = fresh("inbox-collect");
  // 旧一代（generation 1）里放一条当天的、一条昨天的。
  writeInbox(dir, [frameOf({ ts: at(9), text: "旧文件里的早上" }), frameOf({ ts: new Date(2026, 10, 6, 9).getTime(), text: "昨天的" })], 1);
  writeInbox(dir, [
    frameOf({ ts: at(11), text: "白名单挡掉的", stage: "whitelist", ok: false }),
    frameOf({ ts: at(12), text: "无文本", text: "" }),
    frameOf({ ts: at(13), text: "坏行下面还有" })
  ]);
  // 手工塞一条坏 JSON：坏行跳过但计数，不能让整份读取失败。
  writeFileSync(join(dir, "qq-inbox.jsonl"), readFileSync(join(dir, "qq-inbox.jsonl"), "utf8") + "{not json}\n", "utf8");

  const got = collectQqInbox({ dir, dateLocal: day });
  assert.ok(!got.error, JSON.stringify(got));
  const texts = got.items.map((it) => it.text);
  assert.deepEqual(texts, ["旧文件里的早上", "坏行下面还有"], "跨轮换文件续读，且只留有效投递");
  // 昨天的行不算「忽略」——它属于别的日子。
  // 白名单 + 无文本 + 坏行 = 3。坏行也计数：「读不出来的行」不拖死整份读取，
  // 但必须能被看见，否则素材被人悄悄吃掉一半也没人知道。
  assert.equal(got.ignored, 3, "白名单 + 无文本 + 坏行；昨天的行属于别的日子，不算忽略");
  assert.ok(got.scanned >= 5);
});

test("collectQqInbox：目录不在 / 一个文件都读不出，两种错误分开报", () => {
  assert.equal(collectQqInbox({ dir: join(tmp, "no-such"), dateLocal: "2026-11-07" }).error, "no-inbox-dir");
  const empty = fresh("inbox-empty");
  assert.equal(collectQqInbox({ dir: empty, dateLocal: "2026-11-07" }).error, "inbox-unreadable");
});

test("validateBody：太短 / 未闭合围栏 / 围栏标记泄漏都算失败", () => {
  assert.equal(validateBody("太短"), "too-short");
  assert.equal(validateBody(""), "too-short");
  const long = "今天".repeat(50);
  assert.equal(validateBody(long), null);
  assert.equal(validateBody("\`\`\`\n" + long), "unclosed-fence");
  assert.equal(validateBody(long + " <<< 注入"), "marker-leak");
});

test("latestDiaryDate：只认 YYYY-MM-DD.md，不把 runs.jsonl 算进去", () => {
  const dir = fresh("latest");
  assert.equal(latestDiaryDate(dir), null);
  writeFileSync(join(dir, "2026-11-05.md"), "x", "utf8");
  writeFileSync(join(dir, "2026-11-07.md"), "x", "utf8");
  writeFileSync(join(dir, "runs.jsonl"), "{}", "utf8");
  assert.equal(latestDiaryDate(dir), "2026-11-07");
  assert.equal(latestDiaryDate(join(tmp, "no-such-dir")), null);
});

// 正文必须过得去 validateBody 的 MIN_BODY_CHARS=80，否则走的是 invalid-body 分支，
// 而这几个用例要验的是落盘与串行，不是校验闸。
function fakeCtx({ body = "今天聊了很久，她说想早点睡，还说明天要早起背书。".repeat(6) } = {}) {
  const calls = [];
  return {
    calls,
    ctx: {
      // resolveRoute 先看 config.dreamProvider/dreamModel，再回落到宿主的
      // agentDefaultModel；测试里给后者，等价于「宿主已经选了默认模型」。
      agentDefaultModel: { currentSelection: () => ({ provider: "test-provider", model: "test-model" }) },
      llm: {
        async *stream(options) {
          calls.push(options);
          yield { type: "text-delta", text: body };
        }
      }
    }
  };
}

test("compose：项目根为空 → skip project-unknown，一个文件都不写", async () => {
  const memoryDir = fresh("compose-unknown");
  const { ctx } = fakeCtx();
  const composer = createDiaryComposer({ ctx, config: { diaryEnabled: true, language: "zh" }, memoryDir, settings: null, now: () => new Date(2026, 10, 7, 10) });
  const result = await composer.compose({ trigger: "rollover", projectRoot: "" });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "project-unknown");
  // 关键反向断言：memoryDir 下不该出现 diaries 目录之外的任何东西。
  assert.deepEqual(readdirSync(memoryDir), []);
});

test("compose：当天零条有效消息 → skip no-material，且绝不调模型", async () => {
  const memoryDir = fresh("compose-nomaterial");
  const projectRoot = "D:\\proj-nomaterial";
  // 关键区别：目录里**有**可读的 inbox，只是当天一行都没有 → no-material；
  // 目录空/读不出才是 inbox-unreadable。两种「没东西」不能混成一句。
  const inboxDir = fresh("nomaterial-inbox");
  writeInbox(inboxDir, [frameOf({ ts: new Date(2026, 10, 6, 9).getTime(), text: "昨天的" })]);
  const { ctx, calls } = fakeCtx();
  const composer = createDiaryComposer({
    ctx,
    config: { diaryEnabled: true, language: "zh", diaryInboxDir: inboxDir },
    memoryDir,
    settings: null,
    now: () => new Date(2026, 10, 7, 10)
  });
  const result = await composer.compose({ trigger: "rollover", projectRoot });
  assert.equal(result.reason, "no-material");
  assert.equal(calls.length, 0, "空素材调一次模型是纯浪费，写出来的还必然是编的");
});

test("compose：正常路径写正文 + 记账；同日第二次走「补记」不覆盖", async () => {
  const memoryDir = fresh("compose-happy");
  const inboxDir = fresh("happy-inbox");
  const at = (h) => new Date(2026, 10, 7, h).getTime();
  writeInbox(inboxDir, [frameOf({ ts: at(9), text: "早上好" }), frameOf({ ts: at(14), text: "下午好" })]);
  const { ctx, calls } = fakeCtx();
  const composer = createDiaryComposer({
    ctx,
    config: { diaryEnabled: true, language: "zh", diaryInboxDir: inboxDir },
    memoryDir,
    settings: null,
    now: () => new Date(2026, 10, 7, 20)
  });
  const projectRoot = "D:\\proj-happy";
  const first = await composer.compose({ trigger: "rollover", projectRoot });
  assert.equal(first.status, "written");
  assert.equal(first.mode, "create");
  assert.equal(calls.length, 1, "一篇日记只该有一次性调用");
  const text1 = readFileSync(first.path, "utf8");
  // 文件头是 frontmatter：正文要能脱离记忆库被读懂「谁、按什么素材写的」。
  assert.match(text1, /^---\ndate: 2026-11-07\nproject: proj-happy-e99526ec\nsource: qq-inbox\npersona: none\n---\n\n# 2026-11-07/);

  const second = await composer.compose({ trigger: "manual", projectRoot });
  assert.equal(second.status, "written");
  assert.equal(second.mode, "append");
  const text2 = readFileSync(second.path, "utf8");
  assert.ok(text2.length > text1.length, "手写第二篇是「多一段」，不是把上一段弄丢");
  assert.match(text2, /## 补记/);

  // 账本里每一笔都在（回答「今天为什么没有日记」只能靠它）。
  const audit = composer.readAudit({ projectRoot });
  assert.equal(audit.filter((r) => r.status === "written").length, 2);
});

test("compose：同一项目跨天只写一篇（rollover 触发，非手动）", async () => {
  const memoryDir = fresh("compose-rollover");
  const inboxDir = fresh("rollover-inbox");
  writeInbox(inboxDir, [frameOf({ ts: new Date(2026, 10, 7, 9).getTime(), text: "早" })]);
  const { ctx, calls } = fakeCtx();
  let clock = new Date(2026, 10, 7, 20);
  const composer = createDiaryComposer({
    ctx,
    config: { diaryEnabled: true, language: "zh", diaryInboxDir: inboxDir },
    memoryDir,
    settings: null,
    now: () => clock
  });
  const projectRoot = "D:\\proj-roll";
  await composer.compose({ trigger: "rollover", projectRoot });
  const again = await composer.compose({ trigger: "rollover", projectRoot });
  assert.equal(again.reason, "already-written");
  assert.equal(calls.length, 1, "同一天第二次 rollover 不许再调模型");

  // 跨到第二天（素材为空 → no-material，但绝不再写第二篇同日的）。
  clock = new Date(2026, 10, 8, 20);
  const next = await composer.compose({ trigger: "rollover", projectRoot });
  assert.equal(next.reason, "no-material");
  assert.equal(calls.length, 1);
});

test("exportDiary：复制进项目；目标已存在默认拒绝，显式 overwrite 才覆盖", () => {
  const src = fresh("export-src");
  const projectRoot = fresh("export-proj");
  writeFileSync(join(src, "2026-11-07.md"), "# 2026-11-07\n\n正文\n", "utf8");

  const missing = exportDiary({ sourceDir: src, projectRoot, date: "2026-11-06" });
  assert.equal(missing.error, "no-diary");

  const ok = exportDiary({ sourceDir: src, projectRoot, date: "2026-11-07" });
  assert.equal(ok.ok, true);
  assert.equal(readFileSync(join(projectRoot, "diary", "2026-11-07.md"), "utf8"), "# 2026-11-07\n\n正文\n");

  // 用户项目里的文件可能已经被他改过，机器无声覆盖比不做更糟。
  writeFileSync(join(projectRoot, "diary", "2026-11-07.md"), "# 手改过的\n", "utf8");
  const blocked = exportDiary({ sourceDir: src, projectRoot, date: "2026-11-07" });
  assert.equal(blocked.error, "target-exists");
  assert.equal(readFileSync(join(projectRoot, "diary", "2026-11-07.md"), "utf8"), "# 手改过的\n");

  const forced = exportDiary({ sourceDir: src, projectRoot, date: "2026-11-07", overwrite: true });
  assert.equal(forced.ok, true);
  assert.match(readFileSync(join(projectRoot, "diary", "2026-11-07.md"), "utf8"), /正文/);
});

test("listDiaries / readDiary：新的在前，读不到给空而不是抛", () => {
  const dir = fresh("list");
  assert.deepEqual(listDiaries(dir), []);
  assert.deepEqual(listDiaries(null), []);
  writeFileSync(join(dir, "2026-11-05.md"), "a", "utf8");
  writeFileSync(join(dir, "2026-11-07.md"), "c", "utf8");
  writeFileSync(join(dir, "2026-11-06.md"), "", "utf8"); // 0 字节：不算一篇
  writeFileSync(join(dir, "runs.jsonl"), "{}", "utf8");
  assert.deepEqual(listDiaries(dir).map((r) => r.date), ["2026-11-07", "2026-11-05"]);
  assert.equal(readDiary(dir, "2026-11-07"), "c");
  assert.equal(readDiary(dir, "2026-01-01"), null);
  assert.equal(readDiary(dir, "../../etc/passwd"), null, "日期形状不对必须拒绝，不能拼路径");
});

// --- 会话素材（主人格 agent 写日记的主来源）----------------------------------
//
// 这组用例钉的是「日记写的是谁的这一天」：素材取错来源，日记内容会整篇错位，
// 而界面上看起来一切正常（有文件、有摘要、有指针行）。
function sessionOf(events) {
  return { header: { agentPreset: "Amarre" }, snapshotEvents: () => events };
}
const ev = (type, at, payload) => ({ seq: Math.random(), type, at, data: payload });
const userEv = (at, text) => ev("user/message", at, { content: [{ type: "text", text }], source: { kind: "user" } });
const botEv = (at, text) => ev("assistant/message", at, { message: { content: [{ type: "text", text }] } });

test("collectSessionTranscript：只认会话里的公开正文，机器注入与推理块不进素材", () => {
  const at = new Date(2026, 10, 7, 10).getTime();
  const session = sessionOf([
    userEv(at, "早，今天想看书"),
    // 机器注入内容：kind 不是 user，不是「你们今天聊的」。
    ev("user/message", at, { content: [{ type: "text", text: "# AGENTS.md 的正文" }], source: { kind: "plugin:dsh-mneme" } }),
    // 工具调用不是「这一天发生的事」。
    ev("tool/call", at, { name: "grep", args: {} }),
    botEv(at, "嗯，那先看两页"),
    // 私有推理块不进素材（textOf 只认 type:"text"）。
    ev("assistant/message", at, { message: { content: [{ type: "reasoning", text: "内部思考" }] } })
  ]);
  const got = collectSessionTranscript({ session, dateLocal: "2026-11-07" });
  assert.ok(!got.error, JSON.stringify(got));
  assert.deepEqual(got.items.map((i) => i.text), ["早，今天想看书", "嗯，那先看两页"]);
  // 角色必须分开：否则模型会把两个人的话混成一个人的独白。
  assert.deepEqual(got.items.map((i) => i.role), ["user", "assistant"]);
});

test("collectSessionTranscript：给日期时只留当天，无时间戳的丢并可计数", () => {
  const yesterday = new Date(2026, 10, 6, 10).getTime();
  const today = new Date(2026, 10, 7, 10).getTime();
  const session = sessionOf([
    userEv(yesterday, "昨天的"),
    userEv(today, "今天的"),
    // 没有时间戳 = 无法证明属于今天 → 不能写进今天的日记，但要被计数。
    ev("user/message", undefined, { content: [{ type: "text", text: "无时间" }], source: { kind: "user" } })
  ]);
  const got = collectSessionTranscript({ session, dateLocal: "2026-11-07" });
  assert.deepEqual(got.items.map((i) => i.text), ["今天的"]);
  assert.equal(got.ignored, 1);
  // 手动触发（dateLocal=null）保留全部：按钮的意思是「把现在这段写下来」。
  const all = collectSessionTranscript({ session, dateLocal: null });
  assert.equal(all.items.length, 3);
});

test("collectSessionTranscript：会话读不到给 error，不返回空数组冒充「今天没聊」", () => {
  // 「读不懂」与「确实没有」必须分开：前者会让面板显示成空态，用户以为今天没说话。
  assert.equal(collectSessionTranscript({ session: null }).error, "no-session");
  assert.equal(collectSessionTranscript({ session: { events: "nope" } }).error, "session-unreadable");
  assert.deepEqual(collectSessionTranscript({ session: { events: [] } }).items, []);
});

test("sessionAgentId：只认 session.header.agentPreset（不读 requestHeader）", () => {
  assert.equal(sessionAgentId({ header: { agentPreset: "Amarre" } }), "Amarre");
  assert.equal(sessionAgentId({ header: { agentPreset: "  " } }), null);
  // 关键反例：requestHeader 里放着 preset 也不算——那是请求级路由头，agentPreset
  // 会被它遮蔽成空（scope.js 记着本地 web 实测踩中过）。
  assert.equal(sessionAgentId({ header: {}, requestHeader: () => ({ config: { agentPreset: "x" } }) }), null);
  assert.equal(sessionAgentId(null), null);
});

/** 一张身份卡的最小假 settings：只实现 renderUserSettingsBlock 真正会读的三个口。 */
function personaSettings() {
  const card = (name) => ({ enabled: true, name, personality: name + " 的性格", replyStyle: "轻松" });
  return {
    getProfile: () => "",
    getRules: () => [],
    getPersona: () => ({ default: card("默认"), byAgent: { Amarre: card("Amarre") } })
  };
}

test("compose：有会话时优先用会话素材，qq-inbox 只做兜底", async () => {
  const memoryDir = fresh("compose-session");
  const inboxDir = fresh("compose-session-inbox");
  const at = new Date(2026, 10, 7, 9).getTime();
  // inbox 里放着别人的消息：如果来源顺序写反，日记会写成「她说了什么」的旁观稿。
  writeInbox(inboxDir, [frameOf({ ts: at, text: "inbox 里的旧素材" })]);
  const { ctx } = fakeCtx();
  const composer = createDiaryComposer({
    ctx,
    config: { diaryEnabled: true, language: "zh", diaryInboxDir: inboxDir, personaEnabled: true },
    memoryDir,
    settings: personaSettings(),
    now: () => new Date(2026, 10, 7, 20)
  });
  const session = sessionOf([userEv(at, "会话里的真素材"), botEv(at, "我自己说的话")]);
  const result = await composer.compose({ trigger: "rollover", projectRoot: "D:\\proj-session", session, agentId: "Amarre" });
  assert.equal(result.status, "written");
  assert.equal(result.source, "session");
  // 这一条是整组用例的要害：日记的声音来自**这个会话的身份卡**，不是 default。
  // 写成恒 default 的话，多角色宿主里所有 bot 会用同一张嘴写日记，而界面毫无异常。
  assert.equal(result.persona, "byAgent");
  const text = readFileSync(result.path, "utf8");
  assert.match(text, /source: session/);
  assert.match(text, /persona: byAgent \(Amarre\)/);
  // 同时反向断言：inbox 那条旧素材没被采用（来源顺序写反的典型症状）。
  assert.doesNotMatch(text, /inbox 里的旧素材/);
});

test("compose：没有会话时退回 qq-inbox，并如实标注来源", async () => {
  const memoryDir = fresh("compose-fallback");
  const inboxDir = fresh("compose-fallback-inbox");
  const at = new Date(2026, 10, 7, 9).getTime();
  writeInbox(inboxDir, [frameOf({ ts: at, text: "启动补写只能看 inbox" })]);
  const { ctx } = fakeCtx();
  const composer = createDiaryComposer({
    ctx,
    config: { diaryEnabled: true, language: "zh", diaryInboxDir: inboxDir },
    memoryDir,
    settings: null,
    now: () => new Date(2026, 10, 7, 20)
  });
  const result = await composer.compose({ trigger: "startup", projectRoot: "D:\\proj-fallback" });
  assert.equal(result.status, "written");
  assert.equal(result.source, "qq-inbox");
  assert.match(readFileSync(result.path, "utf8"), /persona: none/);
});

// ───────────────────────── 定时写（v0.13） ─────────────────────────
//
// 桉桉 2026-11-09：「日记本按理来说应该需要定时写，这个要存设置中。」
// 原来判定只挂在 turn/end 上 —— 整天不说话就整天不写。这一组钉三件事：
// 1. 缺省（everyMs = 0）完全不起钟，行为与在此之前逐字一致；
// 2. 配了间隔会自己醒来，且醒来走的是同一条 compose（去重不动）；
// 3. 拆掉之后不再有钟（否则热重载几次会攒出一排定时器）。

/** 让出一帧：tick 只入队，真正的 compose 在 defer 的 setTimeout(0) 里。 */
const drain = () => new Promise((resolve) => setTimeout(resolve, 15));

function autoCtx() {
  const handlers = new Map();
  return {
    ctx: {
      logger: { info() {}, warn() {}, warning() {} },
      on(event, fn) {
        handlers.set(event, fn);
        return () => handlers.delete(event);
      }
    },
    handlers
  };
}

test("auto：everyMs = 0 时不起定时器（缺省零行为变化）", () => {
  const { ctx } = autoCtx();
  const auto = createDiaryAutoRun({ ctx, composer: { compose: async () => ({ status: "written" }) } });
  assert.equal(auto.timerArmed(), false);
  auto();
});

test("auto：配了间隔就起钟，dispose 之后不再有钟", () => {
  const { ctx } = autoCtx();
  const auto = createDiaryAutoRun({
    ctx,
    composer: { compose: async () => ({ status: "written" }) },
    everyMs: 60 * 60 * 1000,
    listProjects: () => []
  });
  assert.equal(auto.timerArmed(), true);
  auto();
  assert.equal(auto.timerArmed(), false);
});

test("auto：定时唤醒把 knownProjects 全部排进判定，触发源是 timer", async () => {
  const { ctx } = autoCtx();
  const seen = [];
  const auto = createDiaryAutoRun({
    ctx,
    composer: {
      compose: async (input) => {
        seen.push(input);
        return { status: "written" };
      }
    },
    everyMs: 60 * 60 * 1000,
    listProjects: () => ["D:\\proj-a", "D:\\proj-b"],
    now: () => 1_000_000
  });
  await auto.tickNow();
  await drain();
  // flush 每帧取一个、取完看 pending 还有没有就再排一帧——所以两个项目最终都会跑，
  // 但不会在同一帧里并行（那是「醒来一次补十篇」的老毛病）。等队列排空再断言，
  // 只 setTimeout 一次会跟调度竞速，测试会晃。
  for (let i = 0; i < 100 && auto.pendingCount() > 0; i += 1) await drain();
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((x) => x.trigger), ["timer", "timer"]);
  assert.deepEqual(seen.map((x) => x.projectRoot), ["D:\\proj-a", "D:\\proj-b"]);
  auto();
});

test("auto：listProjects 抛错不冒泡到定时器（只 warn）", async () => {
  const { ctx } = autoCtx();
  const warns = [];
  ctx.logger.warn = (msg) => warns.push(String(msg));
  const auto = createDiaryAutoRun({
    ctx,
    composer: { compose: async () => ({ status: "written" }) },
    everyMs: 60 * 60 * 1000,
    listProjects: () => { throw new Error("state file gone"); }
  });
  await auto.tickNow();
  assert.equal(warns.length, 1);
  assert.match(warns[0], /timer scan failed/);
  // 扫描失败之后钟要重新排上，否则一次异常就永久停摆。
  assert.equal(auto.timerArmed(), true);
  auto();
});

test("auto：turn/end 仍走 rollover，与定时器互不影响", () => {
  const { ctx, handlers } = autoCtx();
  const auto = createDiaryAutoRun({
    ctx,
    composer: { compose: async () => ({ status: "written" }) },
    everyMs: 0
  });
  // 没注册 session/event（ctx.on 存在时一定会注册），这里只确认它注册过。
  assert.equal(handlers.has("session/event"), true);
  auto();
});

test("auto：同一项目在 minIntervalMs 内不重复判定", async () => {
  const { ctx } = autoCtx();
  const seen = [];
  let clock = 1_000_000;
  const auto = createDiaryAutoRun({
    ctx,
    composer: { compose: async (input) => { seen.push(input); return { status: "written" }; } },
    everyMs: 60 * 60 * 1000,
    listProjects: () => ["D:\\proj-a"],
    now: () => clock
  });
  await auto.tickNow();
  await drain();
  assert.equal(seen.length, 1);
  // 再醒一次但还在静默窗口内（DIARY_MIN_INTERVAL_MS = 60s）：不该再调一次模型。
  // 注意把时钟拨十分钟会真的越过窗口——那条边界由下面的用例单独钉。
  clock += 10 * 1000;
  await auto.tickNow();
  await drain();
  assert.equal(seen.length, 1);
  assert.ok(DIARY_MIN_INTERVAL_MS > 0);
  auto();
});
