// #613 日记本 v2 的验收红线（issue 正文 10 条，逐条落成可跑的断言）。
//
// 这些用例钉的全是「错了也不会有人立刻发现」的静默病：
// - 漏 COALESCE：365 条素材塌到 7 条，结果仍是个正常数字；
// - 阈值法挡不住 -480 偏移带（854 条全在 12h 以内），还会误伤真跨 12h 的回忆；
// - source 两形只认一形：每个会话各漏 7-8 条，且不报错；
// - LIMIT 400 砍掉的正好是晚上那段：不报错，日记系统性漏掉晚上做的事。
//
// 时区断言全部用 localDateString 与被测代码同函数计算期望值——在任何时区的
// CI 上都成立，不写死 +8。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { createStore } from "../src/store.js";
import { localDateString } from "../src/diary/rollover.js";
import { diaryAgentDir, agentsRoot } from "../src/diary/dir.js";
import {
  resolveAgentId,
  sessionTitleOf,
  settleAgent,
  readAgentSessions,
  writeAgentSessions,
  backfillColdSessions,
  personaAgentNames,
  UNNAMED_AGENT
} from "../src/diary/agent-bucket.js";
import { collectMemoryMaterial, localTzOffsetMinutes } from "../src/diary/memory-provider.js";
import { mergeSameHashBuckets, listDiaryLibrary } from "../src/diary/library.js";
import { createDiaryComposer } from "../src/diary/compose.js";

const tmp = mkdtempSync(join(tmpdir(), "mneme-diary-agent-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

function fresh(name) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 直插一条记忆（saveWithDedupe 的相似度/黑名单都不该挡住日记素材的夹具）。 */
function insertMemory(store, { id, type = "project", title, content, source, created, occurred = null }) {
  store.db.prepare(
    `INSERT INTO memories (id, type, title, content, importance, source, created_at, occurred_at, updated_at, forgotten, archived, epistemic_status)
     VALUES (?, ?, ?, ?, 3, ?, ?, ?, ?, 0, 0, 'subjective')`
  ).run(id, type, title, content, source, created, occurred, created);
}

/** session 的最小形状：id + 标题事件 + header。 */
function fakeSession(id, { title = "", titleSource = "user", preset = null } = {}) {
  const events = [];
  if (title) events.push({ type: "session/title", data: { title, source: titleSource } });
  return {
    id,
    header: preset ? { agentPreset: preset } : {},
    snapshotEvents: () => events
  };
}

// ---------------------------------------------------------------- 红线 1-5：
// store.diaryMaterial 的四条口径（两形 source / 本地日 / COALESCE / -480）+ LIMIT。

function materialFixture(store) {
  const tz = localTzOffsetMinutes();
  // 夹具一律按**本地墙钟**构造（localIso），不按 UTC 字面量：本机时区从 UTC-11 到
  // UTC+14 都成立。红线 1 要钉的正是「用本地日而非 UTC 日」——m-tz 落在本地 11-09
  // 的 00:15，UTC+8 下它的 UTC 日期还是 11-08，只认 UTC 日的实现会把它归错日。
  insertMemory(store, {
    id: "m-tz", type: "project", title: "跨日素材", content: "刚过午夜写下的东西",
    source: "session:session-s1", created: localIso(DAY_B, 0, 15)
  });
  // 红线 3：occurred_at 带整时区的「本地时间被当 UTC 写入」偏移（UTC+8 上是 -480±10
  // 分带，854 条实测量）。偏移与修正带都按本机 tz 推导，东半球是负、西半球是正，
  // 公式对两者同时成立：修正后落点 = created 的本地日。
  insertMemory(store, {
    id: "m-480", type: "project", title: "批量写入的行", content: "外部导入造成的整时区偏移",
    source: "session:session-s1", created: localIso(DAY_A, 10, 21, 15),
    occurred: new Date(Date.parse(localIso(DAY_A, 10, 21, 15)) - tz * 60000 - 60000).toISOString()
  });
  // 红线 2：occurred_at 为 NULL（占活跃行 54.4%）→ COALESCE 到 created 的本地日。
  insertMemory(store, {
    id: "m-null", type: "decision", title: "没有 occurred 的行", content: "COALESCE 是必需项",
    source: "session:s2", created: localIso(DAY_A, 14, 0)
  });
  // 两形 source：同一 uuid 的两种写法都要被认出来（红线 4）。
  insertMemory(store, {
    id: "m-bare", type: "project", title: "裸形 source", content: "另一台宿主写出的形状",
    source: "session:s1", created: localIso(DAY_A, 9, 0)
  });
}

const dayOf = (utc) => localDateString(new Date(utc));
/** 某一天的查询窗口（与 compose agentMode 传参同口径：本地墙钟字符串）。 */
const windowOf = (day) => ({ dayStart: `${day} 00:00:00`, dayEnd: `${day} 23:59:59` });

// 偏移与修正带一律由本机时区推导，跟生产路径（memory-provider.js:66-68）同一套
// 公式。写死 480 会让断言在 UTC runner 上必然挂：CI 不是东八区。
const tzNow = localTzOffsetMinutes();

// 夹具用到的两个本地日。分开写是为了让「跨日」这件事有地方可钉：素材必须落回
// 自己的本地日，不能因为 UTC 日期不同就被挪走。
const DAY_A = "2026-11-08";
const DAY_B = "2026-11-09";

/**
 * 本地墙钟 → UTC ISO。`localIso("2026-11-08", 23, 45)` 在任何时区都是「本地 11-08
 * 23:45」，它的 UTC 日期可能已经是次日或前一日——这正是要测的东西。
 * 用 Date(y, m-1, d, ...) 而不是手算偏移，因为那样夏令时会算错。
 */
function localIso(day, hh = 12, mm = 0, ss = 0) {
  const [y, mo, d] = day.split("-").map(Number);
  return new Date(y, mo - 1, d, hh, mm, ss).toISOString();
}

test("#613 红线1-4：两形 source、本地日、COALESCE、-480 修正全部生效", () => {
  const store = createStore(":memory:");
  materialFixture(store);
  const q = (day, extra = {}) => store.diaryMaterial({
    ids: ["s1", "s2"], limit: 400, excludeTypes: [],
    bandLo: -tzNow - 10, bandHi: -tzNow + 10, offsetMinutes: tzNow,
    ...windowOf(day), ...extra
  });

  // DAY_A：m-480（-480 修正拉回 created 的本地日）、m-null（COALESCE 到 created）、
  // m-bare（裸形 source）三条，且**只有**这三条。
  const gotA = q(DAY_A).rows.map((r) => r.title).sort();
  assert.deepEqual(gotA, ["裸形 source", "批量写入的行", "没有 occurred 的行"].sort(),
    "两形 source + COALESCE + -480 修正缺一不可");

  // DAY_B：只有 00:15 那条。它按 UTC 日期在 UTC+8 下属于 DAY_A，必须被归到 DAY_B。
  const gotB = q(DAY_B).rows.map((r) => r.title);
  assert.deepEqual(gotB, ["跨日素材"], "localIso(DAY_B, 0, 15) 必须落在本地 DAY_B");

  store.close();
});

// 上面那条在所有时区都成立，但它证明不了「用的是本地日而不是 UTC 日」——UTC runner
// 上两者恰好相等。跨日的语义只能钉在一个确定的时区里，所以另起一个子进程带
// TZ=Asia/Shanghai 跑：20:30Z 必须是 11-09，而不是 11-08。
test("#613 红线1（时区）：UTC+8 下 20:30Z 落在本地次日 11-09", () => {
  const url = (p) => new URL(p, import.meta.url).href;
  const script = `
import assert from "node:assert/strict";
import { createStore } from ${JSON.stringify(url("../src/store.js"))};
import { localDateString } from ${JSON.stringify(url("../src/diary/rollover.js"))};
import { localTzOffsetMinutes } from ${JSON.stringify(url("../src/diary/memory-provider.js"))};

assert.equal(process.env.TZ, "Asia/Shanghai", "子进程环境没带上 TZ");
const tz = localTzOffsetMinutes();
assert.equal(tz, 480, "TZ=Asia/Shanghai 下的偏移必须是 480，实际 " + tz);

const store = createStore(":memory:");
store.db.prepare(
  "INSERT INTO memories (id, type, title, content, importance, source, created_at, occurred_at, updated_at, forgotten, archived, epistemic_status)" +
  " VALUES (?, ?, ?, ?, 3, ?, ?, NULL, ?, 0, 0, 'subjective')"
).run("m-tz", "project", "跨日素材", "晚上八点半之后写下的东西", "session:session-s1",
      "2026-11-08T20:30:00.000Z", "2026-11-08T20:30:00.000Z");

const q = (day) => store.diaryMaterial({
  ids: ["s1"], limit: 400, excludeTypes: [],
  bandLo: -tz - 10, bandHi: -tz + 10, offsetMinutes: tz,
  dayStart: day + " 00:00:00", dayEnd: day + " 23:59:59"
});

assert.equal(localDateString(new Date("2026-11-08T20:30:00.000Z")), "2026-11-09", "20:30Z 的本地日是次日");
const nd = q("2026-11-09").rows.map((r) => r.title);
assert.deepEqual(nd, ["跨日素材"], "UTC+8 下必须落在 11-09，实际 " + JSON.stringify(nd));
const same = q("2026-11-08").rows.map((r) => r.title);
assert.deepEqual(same, [], "绝不能再出现在 UTC 的 11-08，实际 " + JSON.stringify(same));
store.close();
`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, TZ: "Asia/Shanghai" },
    stdio: "pipe",
    encoding: "utf8"
  });
});

// 负偏移必须单独钉：CI 跑在 UTC 上，offsetMinutes=0 时符号分支根本没被走到——
// 当年那个「'+' 拼负数 → SQLite 判非法 → datetime() 返回 NULL → 整天素材静默为空」
// 的 bug，在 UTC runner 上是绿的。这条子进程带 TZ=America/New_York（-300）跑。
test("#613 红线1（负偏移）：UTC 以西时区的素材不被静默清空", () => {
  const url = (p) => new URL(p, import.meta.url).href;
  const script = `
import assert from "node:assert/strict";
import { createStore } from ${JSON.stringify(url("../src/store.js"))};
import { localTzOffsetMinutes } from ${JSON.stringify(url("../src/diary/memory-provider.js"))};

assert.equal(process.env.TZ, "America/New_York", "子进程环境没带上 TZ");
const tz = localTzOffsetMinutes();
assert.ok(tz < 0, "西半球的偏移必须是负数，实际 " + tz);

const store = createStore(":memory:");
// 2026-11-08T18:00Z 在纽约是 13:00（同一天），窗口取本地 11-08 全天。
store.db.prepare(
  "INSERT INTO memories (id, type, title, content, importance, source, created_at, occurred_at, updated_at, forgotten, archived, epistemic_status)" +
  " VALUES (?, ?, ?, ?, 3, ?, ?, NULL, ?, 0, 0, 'subjective')"
).run("m-neg", "project", "西半球素材", "不该被清空", "session:s1",
      "2026-11-08T18:00:00.000Z", "2026-11-08T18:00:00.000Z");

const res = store.diaryMaterial({
  ids: ["s1"], limit: 400, excludeTypes: [],
  bandLo: -tz - 10, bandHi: -tz + 10, offsetMinutes: tz,
  dayStart: "2026-11-08 00:00:00", dayEnd: "2026-11-08 23:59:59"
});
assert.equal(res.total, 1, "负偏移下窗口不能恒为空");
assert.equal(res.rows.length, 1);
assert.equal(res.rows[0].localTs, "2026-11-08 13:00:00", "local_ts 是本地墙钟");
store.close();
`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, TZ: "America/New_York" },
    stdio: "pipe",
    encoding: "utf8"
  });
});

test("#613 红线5：LIMIT 截断不静默——total 照实、used 照实、truncated 照实", () => {
  const store = createStore(":memory:");
  for (let i = 0; i < 5; i += 1) {
    insertMemory(store, {
      id: "m" + i, type: "project", title: "素材" + i, content: "第 " + i + " 条",
      source: "session:s9", created: localIso(DAY_A, i, 0)
    });
  }
  const day = DAY_A;
  const res = store.diaryMaterial({
    ids: ["s9"], dayStart: `${day} 00:00:00`, dayEnd: `${day} 23:59:59`,
    excludeTypes: [], limit: 3, bandLo: -tzNow - 10, bandHi: -tzNow + 10, offsetMinutes: tzNow
  });
  assert.equal(res.total, 5, "窗口内全部素材数照实");
  assert.equal(res.rows.length, 3, "rows 只带 LIMIT 条");
  assert.equal(res.truncated === undefined, true, "截断判定由 provider 层给，store 只给两个数");
  store.close();
});

// ---------------------------------------------------------------- 红线 2（续）：
// provider 层的黑名单与截断三元组。

test("#613 黑名单类型不进素材；provider 暴露 total/used/truncated 三元组", () => {
  const store = createStore(":memory:");
  insertMemory(store, {
    id: "m-c", type: "constraint", title: "长期成立的规则", content: "不该进日记",
    source: "session:s1", created: localIso(DAY_A, 10, 0)
  });
  insertMemory(store, {
    id: "m-p", type: "project", title: "真素材", content: "该进日记的那条",
    source: "session:s1", created: localIso(DAY_A, 11, 0)
  });
  const service = { diaryMaterial: (p) => store.diaryMaterial(p) };
  const day = DAY_A;
  const res = collectMemoryMaterial({
    service,
    sessionIds: ["s1"],
    dateLocal: day,
    maxItems: 400,
    excludeTypes: ["constraint", "preference"]
  });
  assert.equal(res.total, 1, "黑名单类型不进窗口");
  assert.equal(res.items.length, 1);
  assert.match(res.items[0].text, /真素材/);
  assert.equal(res.truncated, false);
  store.close();
});

// ---------------------------------------------------------------- 红线 6/7/8：
// agentId 解析三级 + 冷行回填。

test("#613 红线6/7：名单外的标题与 fallback 标题都落 _unnamed，绝不冒出同名目录", () => {
  const known = personaAgentNames({
    getPersona: () => ({
      default: { name: "Ephor" },
      byAgent: { amarre: { name: "Amarre" } }
    })
  });
  assert.ok(known.has("amarre") && known.has("ephor"), "名单 = 卡名 + 卡键");

  // 红线 6：用户手改的标题（source=user）带「·」但前缀不在名单 → _unnamed。
  const odd = fakeSession("s-odd", { title: "公共管理复习", titleSource: "user" });
  assert.equal(resolveAgentId({ session: odd, knownNames: known, mapping: {} }), UNNAMED_AGENT);
  // 同款形状但前缀在名单里 → 认。
  const hit = fakeSession("s-hit", { title: "Amarre · 记忆研究", titleSource: "user" });
  assert.equal(resolveAgentId({ session: hit, knownNames: known, mapping: {} }), "Amarre");
  // 红线 7：fallback 整句标题不认——哪怕它长着「·」。
  const fb = fakeSession("s-fb", { title: "可以生图吧？@专家团：…… · 附议", titleSource: "fallback" });
  assert.equal(resolveAgentId({ session: fb, knownNames: known, mapping: {} }), UNNAMED_AGENT);
});

test("#613 红线8：落定之后改标题不分叉；冷行回填只解 source.kind", () => {
  const root = fresh("settle-root");
  const known = personaAgentNames({ getPersona: () => ({ byAgent: { amarre: { name: "Amarre" } } }) });
  const s1 = fakeSession("s1", { title: "Amarre · 记忆研究", titleSource: "user" });
  const first = settleAgent({ root, session: s1, knownNames: known });
  assert.equal(first.agentId, "Amarre");
  // 之后标题被改成名单外的句子：落定不变（改一次标题多出一本孤儿书是验收点名的分叉）。
  const renamed = fakeSession("s1", { title: "随便改的新名字", titleSource: "user" });
  const second = settleAgent({ root, session: renamed, knownNames: known });
  assert.equal(second.agentId, "Amarre", "agentId 首次写入落定，不再随标题漂");
  const bySession = readAgentSessions(root);
  assert.equal(bySession.s1.title, "随便改的新名字", "展示名更新");
  assert.equal(bySession.s1.agent, "Amarre", "归属不变");

  // 冷行回填：投影里 user 标题命中名单 → 归位；命中不了 → 留 _unnamed。
  const root2 = fresh("backfill-root");
  const settled = backfillColdSessions({
    ctx: { sessionProjections: { list: () => [
      { id: "cold-1", title: "Amarre · 记忆研究", source: "user" },
      { id: "cold-2", title: "公共管理复习", source: "user" },
      { id: "cold-3", title: "可以生图吧？", source: "fallback" }
    ] } },
    root: root2,
    knownNames: known
  });
  assert.equal(settled, 1, "只有命中名单的 user 标题被解");
  const map = readAgentSessions(root2);
  assert.equal(map["cold-1"].agent, "Amarre");
  assert.equal(map["cold-2"], undefined, "名单外的冷行不解——留在 _unnamed");
  assert.equal(map["cold-3"], undefined, "fallback 冷行不解");
});

// ---------------------------------------------------------------- 红线 9：
// 同 hash 两桶自动归并：不重叠全归位；重叠不静默覆盖（conflict 副本）。

test("#613 红线9a：同 hash 不同日期的两桶归并成一个，两篇都在", () => {
  const root = fresh("merge-nooverlap");
  const w = (bucket, date, body) => {
    mkdirSync(join(root, bucket), { recursive: true });
    writeFileSync(join(root, bucket, `${date}.md`), `---\ndate: ${date}\n---\n\n${body}\n`);
  };
  w("X-aaaa1111", "2026-11-07", "第一天的日记");
  w("Y-aaaa1111", "2026-11-08", "第二天的日记");
  mergeSameHashBuckets(root);
  // 目标选择是确定性的：没有 runs.jsonl 且条目数相同时取名字排序第一个（X）。
  assert.ok(!existsSync(join(root, "Y-aaaa1111")), "源桶被清空后删除");
  assert.ok(existsSync(join(root, "X-aaaa1111", "2026-11-07.md")), "day1 原地不动");
  assert.ok(existsSync(join(root, "X-aaaa1111", "2026-11-08.md")), "day2 归位");
});

test("#613 红线9b：同 hash 同日期的两桶不静默覆盖——conflict 副本两份都在", () => {
  const root = fresh("merge-conflict");
  const w = (bucket, date, body) => {
    mkdirSync(join(root, bucket), { recursive: true });
    writeFileSync(join(root, bucket, `${date}.md`), `---\ndate: ${date}\n---\n\n${body}\n`);
  };
  w("X-aaaa1111", "2026-11-07", "X 写的那篇");
  w("Y-aaaa1111", "2026-11-07", "Y 写的那篇");
  mergeSameHashBuckets(root);
  // 目标 = 排序第一的 X：X 的留原名，Y 的降级为 conflict 副本——绝不静默覆盖。
  const dir = readdirSync(join(root, "X-aaaa1111"));
  const originals = dir.filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n));
  const conflicts = dir.filter((n) => n.includes(".conflict-"));
  assert.equal(originals.length, 1, "目标桶那篇留原名");
  assert.equal(conflicts.length, 1, "源桶那篇降级为 conflict 副本");
  const both = readFileSync(join(root, "X-aaaa1111", originals[0]), "utf8")
    + readFileSync(join(root, "X-aaaa1111", conflicts[0]), "utf8");
  assert.match(both, /X 写的那篇/);
  assert.match(both, /Y 写的那篇/, "两份内容都在盘上");
});

// ---------------------------------------------------------------- 红线 5（续）+ 10：
// agentMode compose 全链路：素材来自记忆库、截断写进正文与账本、黑名单生效。

test("#613 compose agentMode：素材来自记忆库，截断写进正文与账本", async () => {
  const memoryDir = fresh("compose-agent");
  const store = createStore(":memory:");
  for (let i = 0; i < 5; i += 1) {
    insertMemory(store, {
      id: "am" + i, type: "project", title: "素材" + i, content: "agent 当天第 " + i + " 条痕迹",
      source: i % 2 === 0 ? "session:session-a1" : "session:a1",
      created: localIso(DAY_A, 10 + i, 0)
    });
  }
  // 黑名单类型：不该进素材。
  insertMemory(store, {
    id: "am-x", type: "constraint", title: "规则类", content: "不进日记",
    source: "session:a1", created: localIso(DAY_A, 15, 0)
  });
  const service = { diaryMaterial: (p) => store.diaryMaterial(p) };
  const { ctx } = fakeBodyCtx();
  const composer = createDiaryComposer({
    ctx,
    config: {
      diaryEnabled: true, language: "zh",
      diaryMemoryExcludeTypes: ["constraint", "preference"],
      documentMemoryEnabled: false
    },
    memoryDir,
    service,
    settings: null,
    now: () => new Date(2026, 10, 8, 20)
  });
  // 会话索引：a1 已落定到 Amarre（生产路径里由 auto 的 settleAgent 写）。
  writeAgentSessions(agentsRoot({ memoryDir }), { a1: { agent: "Amarre", title: "Amarre · 记忆研究", source: "user" } });
  const result = await composer.compose({ trigger: "manual", agentMode: true, agentId: "Amarre" });
  assert.equal(result.status, "written");
  const day = DAY_A;
  const dir = diaryAgentDir({ memoryDir, agentId: "Amarre" });
  assert.ok(dir && dir.includes(join("agents", "Amarre")), "落点是 agents/<agentId>/");
  const file = readdirSync(dir).find((n) => n.startsWith(day));
  assert.ok(file, "当天那篇存在");
  const text = readFileSync(join(dir, file), "utf8");
  assert.match(text, /source: memories/, "frontmatter 如实标注素材来源");
  assert.doesNotMatch(text, /规则类/, "黑名单类型不进素材");
  assert.equal(result.diaryTruncated, undefined, "素材 5 条未触 400 上限，不出现截断注记");
  const audit = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim().split("\n").pop());
  assert.equal(audit.status, "written");
  assert.equal(audit.agent, "Amarre");
  assert.equal(audit.source, "memories");
  store.close();
});

test("#613 compose agentMode：素材超限如实截断（红线5 的正文侧）", async () => {
  const memoryDir = fresh("compose-agent-trunc");
  const store = createStore(":memory:");
  for (let i = 0; i < 6; i += 1) {
    insertMemory(store, {
      id: "bt" + i, type: "project", title: "素材" + i, content: "第 " + i + " 条，白天到深夜的分布",
      source: "session:a2", created: localIso(DAY_A, 10 + i, 0)
    });
  }
  const service = { diaryMaterial: (p) => store.diaryMaterial(p) };
  const { ctx } = fakeBodyCtx();
  const composer = createDiaryComposer({
    ctx,
    config: { diaryEnabled: true, language: "zh", documentMemoryEnabled: false },
    memoryDir,
    service,
    settings: null,
    now: () => new Date(2026, 10, 8, 20)
  });
  // maxItems 是 compose 内部的 MAX_MATERIAL_ITEMS——这里直接压 provider 上限不可行，
  // 改用 spy：把 service.diaryMaterial 的 limit 钉到 4，模拟窗口内素材 6 条只用 4 条。
  const composer2 = createDiaryComposer({
    ctx,
    config: { diaryEnabled: true, language: "zh", documentMemoryEnabled: false },
    memoryDir,
    service: {
      diaryMaterial: (p) => store.diaryMaterial({ ...p, limit: Math.min(p.limit, 4) })
    },
    settings: null,
    now: () => new Date(2026, 10, 8, 20)
  });
  // 会话索引同上：素材查询按索引里的会话 id 展开。
  writeAgentSessions(agentsRoot({ memoryDir }), { a2: { agent: "Amarre", title: "", source: "user" } });
  void composer;
  const result = await composer2.compose({ trigger: "manual", agentMode: true, agentId: "Amarre" });
  assert.equal(result.status, "written");
  assert.equal(result.diaryTruncated.total, 6, "total 照实");
  assert.equal(result.diaryTruncated.used, 4, "used 照实（4 = 被钉住的上限）");
  const dir = diaryAgentDir({ memoryDir, agentId: "Amarre" });
  const file = readdirSync(dir).find((n) => n.startsWith(DAY_A));
  const text = readFileSync(join(dir, file), "utf8");
  assert.match(text, /今天素材共 6 条，本篇用了 4 条。/, "正文末尾的截断说明对读者可见");
  const audit = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim().split("\n").pop());
  assert.deepEqual(audit.diaryTruncated, { total: 6, used: 4 }, "账本同步记");
  store.close();
});

// ---------------------------------------------------------------- 红线 10：
// diaryEnabled=false 一个字不写（wiring 级：composer 压根不创建，路由回 409——
// 由 api.test 的既有用例覆盖；这里钉 compose 侧的最后防线：sessionGate 关着的
// 会话不触发，auto.js 既有用例已覆盖。此处只钉 agent 桶不越界写盘）。

test("#613 agentMode：素材服务缺失时如实 skip，不写盘不调模型", async () => {
  const memoryDir = fresh("compose-agent-nosvc");
  const { ctx, calls } = fakeBodyCtx();
  const composer = createDiaryComposer({
    ctx,
    config: { diaryEnabled: true, language: "zh" },
    memoryDir,
    service: null,
    settings: null,
    now: () => new Date(2026, 10, 8, 20)
  });
  const result = await composer.compose({ trigger: "manual", agentMode: true, agentId: "Amarre" });
  assert.equal(result.status, "skipped");
  assert.match(result.reason, /memories-unavailable/);
  assert.equal(calls.length, 0, "没素材就不调模型");
  // skip 也会审计（runs.jsonl 落在桶目录里是既有行为），断言钉的是「没有日记正文」。
  const agentDir = diaryAgentDir({ memoryDir, agentId: "Amarre" });
  const mdFiles = existsSync(agentDir) ? readdirSync(agentDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)) : [];
  assert.equal(mdFiles.length, 0, "没有内容写盘");
});

// ---------------------------------------------------------------- 工具

function fakeBodyCtx({ body = "今天她把情绪页重新排了版，稳定倾向排在前面，晚上把暗色主题也过了一遍。".repeat(4) } = {}) {
  const calls = [];
  return {
    calls,
    ctx: {
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
