// 冲突处置两个开关的唯一解析处（src/conflict-mode.js）。
//
// 这组测试存在的理由：同一份配置此前被三个消费方各解析一次，给出三种答案
// （dream 判 enforce 让位、sleep 降 shadow、注入侧完全不看 freeze）。把解析收成
// 纯函数之后，这里锁两件事：
//   ① 解析表本身（四态，只有 freeze+enforce 一档降级）；
//   ② 三个消费方真的都走这个函数——不是「新加了一个函数，旧的三处照旧读 cfg」。
// ② 用源码守卫实现：那两个键名一旦在消费方文件里再次出现（读 cfg 的那种），
// 说明有人又开了一份解析，测试立刻红。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Config } from "../src/config.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { testConfig } from "./helpers/test-config.js";
import {
  FREEZE_WINS,
  resolveConflictMode,
  warnConflictModeDegraded,
  resetConflictModeWarnings
} from "../src/conflict-mode.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

// ---------------------------------------------------------------- 解析表

test("#641 resolveConflictMode：freeze 关时档位原样透传，不产生降级", () => {
  for (const mode of ["off", "shadow", "enforce"]) {
    const got = resolveConflictMode({ conflictFreezeEnabled: false, conflictLedgerMode: mode });
    assert.deepEqual(got, { freeze: false, ledgerMode: mode, degraded: null },
      `freeze 关、档位 ${mode} 时必须原样透传`);
  }
});

test("#641 resolveConflictMode：freeze 开 + off/shadow 是正常叠加，不算降级", () => {
  // off/shadow 本身就不处置，freeze 再停车只是两条路通向同一个队列。
  // 这里刻意不报 degraded：报了就说明「你以为配置坏了」，其实没有。
  for (const mode of ["off", "shadow"]) {
    const got = resolveConflictMode({ conflictFreezeEnabled: true, conflictLedgerMode: mode });
    assert.deepEqual(got, { freeze: true, ledgerMode: mode, degraded: null },
      `freeze 开、档位 ${mode} 不构成降级`);
  }
});

test("#641 resolveConflictMode：freeze 开 + enforce 降成 shadow，且标明原因", () => {
  const got = resolveConflictMode({ conflictFreezeEnabled: true, conflictLedgerMode: "enforce" });
  assert.deepEqual(got, { freeze: true, ledgerMode: "shadow", degraded: FREEZE_WINS });
  assert.equal(got.ledgerMode, "shadow",
    "降级目标是 shadow 不是 off：记账是零风险测量，停掉会断掉切 enforce 前的分布证据");
  assert.equal(got.freeze, true, "freeze 胜出——停车行为保留");
});

test("#641 resolveConflictMode：缺配置时按默认值（off、不冻结）", () => {
  assert.deepEqual(resolveConflictMode(undefined), { freeze: false, ledgerMode: "off", degraded: null });
  assert.deepEqual(resolveConflictMode({}), { freeze: false, ledgerMode: "off", degraded: null });
  // 只有真正的 true/false 才算开关值：字符串 "true" 不该被当成开着（配置文件里
  // 写错类型 zod 会拦，但面板 kv 是 JSON，历史上真有存成字符串的键）。
  assert.equal(resolveConflictMode({ conflictFreezeEnabled: "true" }).freeze, false,
    "只认 === true，字符串不算开");
});

// ---------------------------------------------------------------- 告警去重

test("#641 降级告警：同一原因每进程只打一条，dream 与 sleep 各调一次也只出一条", () => {
  resetConflictModeWarnings();
  const lines = [];
  const logger = { warn: (msg) => lines.push(msg) };
  const mode = resolveConflictMode({ conflictFreezeEnabled: true, conflictLedgerMode: "enforce" });

  assert.equal(warnConflictModeDegraded(logger, mode, "dream"), true, "第一次要真的写日志");
  assert.equal(warnConflictModeDegraded(logger, mode, "sleep"), false, "第二个消费方不再重复");
  assert.equal(lines.length, 1, `旧代码是两行方向相反的 warn，现在收敛成一条（got ${lines.length}）`);
  assert.match(lines[0], /degrading to shadow/, "措辞要说明降到 shadow，不是「让位」这种含糊说法");
  assert.match(lines[0], /\[dream\]/, "带上首个触发点，方便定位");

  resetConflictModeWarnings();
  assert.equal(warnConflictModeDegraded(logger, mode, "sleep"), true, "reset 之后重新可告警");
  resetConflictModeWarnings();
});

test("#641 降级告警：没有降级时一条都不打", () => {
  resetConflictModeWarnings();
  const lines = [];
  const logger = { warn: (msg) => lines.push(msg) };
  const mode = resolveConflictMode({ conflictFreezeEnabled: true, conflictLedgerMode: "shadow" });
  assert.equal(warnConflictModeDegraded(logger, mode, "dream"), false);
  assert.equal(lines.length, 0, "没降级就别吓人");
  // logger 缺席不能抛（测试与部分宿主路径没有 logger）
  assert.equal(warnConflictModeDegraded(null, mode, "sleep"), false);
});

// ---------------------------------------------------------------- 消费方守卫

// 源码守卫：这三个文件是消费方，只许调 resolveConflictMode，不许自己读 cfg 判断。
// 变异的典型形态就是「helper 加了，但某个文件还留着自己那行」——那行会让同一份
// 配置在三处继续算出不同答案，而行为测试未必覆盖得到（比如只在特定档位组合下）。
test("#641 三个消费方都走唯一解析处，没有第二份 cfg 判断", () => {
  const consumers = [
    ["dream.js", join(srcDir, "dream.js")],
    ["dream/sleep.js", join(srcDir, "dream", "sleep.js")],
    ["service.js", join(srcDir, "service.js")]
  ];
  for (const [label, path] of consumers) {
    const source = readFileSync(path, "utf8");
    // 去掉行注释再检查：注释里提到键名是解释，不是解析。
    const code = source.split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    assert.equal(code.includes("config.conflictLedgerMode"), false,
      `${label} 不许再读 config.conflictLedgerMode —— 改调 resolveConflictMode()`);
    assert.equal(code.includes("config.conflictFreezeEnabled"), false,
      `${label} 不许再读 config.conflictFreezeEnabled —— 改调 resolveConflictMode()`);
    assert.equal(code.includes("config?.conflictLedgerMode"), false,
      `${label} 不许再读 config?.conflictLedgerMode —— 改调 resolveConflictMode()`);
    assert.equal(code.includes("config?.conflictFreezeEnabled"), false,
      `${label} 不许再读 config?.conflictFreezeEnabled —— 改调 resolveConflictMode()`);
    assert.ok(source.includes("conflict-mode.js"),
      `${label} 必须 import 唯一解析处`);
  }
});

// ---------------------------------------------------------------- 行为：注入侧同源

// 这条是「改前必然红」的那一条。
//
// 旧代码 `src/service.js` 只判 `config.conflictLedgerMode === "enforce"`、完全不看
// freeze；sleep 侧同开时把档位降成 shadow（只记账零处置）。于是同一份配置下：
// 处置侧一次都不跑，注入侧却照样给矛盾对挂 conflictNote —— 注入文本比处置更乐观，
// 用户看到「以其为准」，而实际上没有任何一件事被处置过。
//
// 归一之后两边同源回答 shadow：不标注。这条用例用真实 store/service 与真实
// injectCandidates 断言，不走源码正则；把 service.js 的门改回旧写法，它立刻红。
test("#641 注入侧与处置侧同源：freeze+enforce 时不再挂矛盾标注（旧代码此条必红）", async () => {
  const store = createStore(":memory:");
  // 冻结 + enforce 同时打开——正是配置文件里可能留下的双开状态
  const service = createService({
    store,
    mirror: null,
    config: testConfig({ conflictFreezeEnabled: true, conflictLedgerMode: "enforce" })
  });
  const a = service.saveWithDedupe({ type: "project", title: "矛盾注入甲", content: "矛盾注入甲的内容", importance: 3 }).memory;
  const b = service.saveWithDedupe({ type: "project", title: "矛盾注入乙", content: "矛盾注入乙的内容", importance: 3 }).memory;
  service.saveConflictLedgerEntry({ memory_a: a.id, memory_b: b.id, tier: "conflict" });

  const candidates = service.injectCandidates({ query: "", maxItems: 5 })
    .filter((m) => m.id === a.id || m.id === b.id);
  assert.equal(candidates.length, 2, "两条都还在注入候选里（冻结只管停车，不踢出注入）");
  assert.equal(candidates[0].conflictNote, undefined,
    "freeze 胜出时档位实际是 shadow，注入侧不许再挂标注——处置侧一次都没跑");
  assert.equal(candidates[1].conflictNote, undefined);

  // 对照：纯 enforce（freeze 关）照旧标注，说明门是按解析结果开的，不是被整个关掉
  const store2 = createStore(":memory:");
  const service2 = createService({ store: store2, mirror: null, config: testConfig({ conflictLedgerMode: "enforce" }) });
  const c = service2.saveWithDedupe({ type: "project", title: "纯enforce甲", content: "纯enforce甲的内容", importance: 3 }).memory;
  const d = service2.saveWithDedupe({ type: "project", title: "纯enforce乙", content: "纯enforce乙的内容", importance: 3 }).memory;
  service2.saveConflictLedgerEntry({ memory_a: c.id, memory_b: d.id, tier: "conflict" });
  const enforced = service2.injectCandidates({ query: "", maxItems: 5 }).filter((m) => m.id === c.id || m.id === d.id);
  assert.ok(enforced.some((m) => typeof m.conflictNote === "string"),
    "纯 enforce 档必须照旧标注，否则这条测试只是把功能关掉了");

  store.close();
  store2.close();
});

// ---------------------------------------------------------------- zombied 死路

// 账本是测量记录，不是处置记录：一对只要还被观察到就一直住在里面。但冲突相位的
// 候选池是「未归档且未遗忘」，一侧退场之后那一对再也不会进 fresh —— 没有任何路径
// 能把它们翻走，于是永远停在 open，注入侧还会把「一侧已不在库里的对」当成活的真
// 矛盾挂标注。zombifyDeadLedgerPairs 就是把这类无从消解的行收进原本空着的 zombied。
test("#641 zombifyDeadLedgerPairs：只收「无从消解」的 open 行，不动别的状态", () => {
  const store = createStore(":memory:");
  const mk = (t) => store.save({ type: "project", title: t, content: `${t} 的正文`, importance: 3 });

  const live1 = mk("活甲"); const live2 = mk("活乙");
  const goneA = mk("退甲"); const keepB = mk("留乙");
  const keepC = mk("留丙"); const goneD = mk("退丁");
  const goneE = mk("退戊"); const goneF = mk("退己");
  const done1 = mk("终甲"); const done2 = mk("终乙");

  // 两侧都活：不该被动
  store.saveConflictLedgerEntry({ memory_a: live1.id, memory_b: live2.id, tier: "conflict" });
  // 单侧归档
  store.saveConflictLedgerEntry({ memory_a: goneA.id, memory_b: keepB.id, tier: "conflict" });
  // 单侧遗忘
  store.saveConflictLedgerEntry({ memory_a: keepC.id, memory_b: goneD.id, tier: "conflict" });
  // 两侧都退场
  store.saveConflictLedgerEntry({ memory_a: goneE.id, memory_b: goneF.id, tier: "conflict" });
  // 已经是终点的对：即使一侧退场，也不许被改写成 zombied（会抹掉「怎么结束的」）
  store.saveConflictLedgerEntry({ memory_a: done1.id, memory_b: done2.id, tier: "conflict" });
  store.setConflictLedgerStatus(done1.id, done2.id, "superseded");

  store.setArchived(goneA.id, true);
  store.setForget(goneD.id, true);
  store.setArchived(goneE.id, true);
  store.setArchived(goneF.id, true);
  store.setArchived(done1.id, true);

  assert.equal(store.openConflictPairs().length, 4, "前置：五对入账其中一对已收成 superseded，open 剩四对");
  assert.equal(store.zombifyDeadLedgerPairs(), 3, "单侧归档 / 单侧遗忘 / 两侧都退 = 三条死路");

  const alive = store.openConflictPairs().map((p) => [p.memory_a, p.memory_b].sort().join("|"));
  assert.deepEqual(alive, [[live1.id, live2.id].sort().join("|")],
    "收完之后 open 里只剩两侧都活的那一对");
  assert.equal(store.zombifyDeadLedgerPairs(), 0, "再跑一次是幂等的 no-op");

  const row = (x, y) => store.db.prepare(
    "SELECT status FROM conflict_ledger WHERE memory_a = ? AND memory_b = ?"
  ).get(...[x, y].sort());
  assert.equal(row(done1.id, done2.id).status, "superseded", "终点状态不许被覆盖");
  assert.equal(row(goneA.id, keepB.id).status, "zombied");
  assert.equal(row(goneE.id, goneF.id).status, "zombied");

  store.close();
});
