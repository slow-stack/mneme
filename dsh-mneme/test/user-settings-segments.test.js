// #600 第 1 期：渲染函数产出段边界（segments），供面板按段读、按段改、按段提问。
//
// 这一期是**纯加法**，产品承诺只有两条，都是「做错了界面上看不出来」的那类：
// ① `text` 逐字节不变——注入是每帧的，多一个空格都是全库用户的行为变化；
// ② `segments` 是 `text` 的唯一真源——面板拿段拼回去必须等于注入那一串，
//    否则「按段改」改的和模型看到的不是同一份（正是 #497 那类两份实现漂掉）。
//
// 第 ① 条不靠「我看着一样」：本文件里留了一份改动前的渲染实现（legacyRender），
// 逐配置对比新旧输出。老实现的代码是历史，故意不跟着新实现重构——它就是 golden。
import test from "node:test";
import assert from "node:assert/strict";
import { STR } from "../src/lang.js";
import { renderUserSettingsBlock, escapePromptVars, resolvePersonaCard, resolveFactsCard } from "../src/user-settings.js";

// 事实段预算（与 src/user-settings.js 同值，golden 需要它复现截断）
const MAX_LINES = 40;
const MAX_CHARS = 1200;

function makeSettings({ profile = "", rules = [], persona = null, byAgent = {} } = {}) {
  return {
    getProfile: () => profile,
    getRules: () => rules,
    getPersona: () => ({ default: persona ?? { enabled: false }, byAgent })
  };
}

/**
 * 冻结副本：origin/main 041e8f3 的 resolvePersonaCard 逐字抄。
 *
 * golden 不能 import 生产函数——那样谁改坏生产，golden 跟着一起坏，两边同错
 * 仍会全绿（自证陷阱，Ephor 2026-11-07 指出）。所以这里留一份副本。
 * 代价是副本会随生产演进而过期，由文件末尾那条「漂移告警」用例负责显式失败，
 * 而不是让 golden 静默变成生产函数的镜像。
 */
function legacyResolvePersonaCard(settings, agentId, { strict = false } = {}) {
  const store = settings.getPersona();
  const id = typeof agentId === "string" && agentId.trim() ? agentId.trim() : "";
  const card = id ? store.byAgent[id] : null;
  if (card && card.enabled === true) return { card, source: "byAgent" };
  if (id && strict && Object.keys(store.byAgent).length > 0) return { card: {}, source: "none" };
  return { card: store.default, source: "default" };
}

/** 冻结副本：origin/main 041e8f3 的 resolveFactsCard 逐字抄（同上，不许 import 生产）。 */
function legacyResolveFactsCard(factsStore, agentId, { strict = false } = {}) {
  const id = typeof agentId === "string" && agentId.trim() ? agentId.trim() : "";
  const byAgent = factsStore?.byAgent ?? {};
  const card = id ? (byAgent[id] ?? null) : null;
  if (card && card.length) return { facts: card, source: "byAgent" };
  if (id && strict && Object.keys(byAgent).length > 0) return { facts: [], source: "none" };
  return { facts: factsStore?.default ?? [], source: "default" };
}

/**
 * 改动前的实现（origin/main 041e8f3 的 src/user-settings.js:88-134 原样）。
 * 只依赖 lang.js 与 escapePromptVars——这两个本期都没改。
 * 两个 resolve 用上面的冻结副本，不用生产函数（见副本注释）。
 */
function legacyRender({ settings, config, agentId = null, factsProvider = null }) {
  const language = config?.language === "en" ? "en" : "zh";
  const profile = settings.getProfile().trim();
  const rules = settings.getRules();
  const enabled = config?.personaEnabled === true;
  const resolved = enabled
    ? legacyResolvePersonaCard(settings, agentId, { strict: config?.personaStrictAddressing === true })
    : { card: {}, source: "default" };
  const persona = resolved.card;
  const personaLines = persona?.enabled === true
    ? [
        ...(typeof persona.name === "string" && persona.name.trim() ? [STR.personaNameLine[language](persona.name.trim())] : []),
        ...(typeof persona.personality === "string" && persona.personality.trim() ? [STR.personaPersonalityLine[language](persona.personality.trim())] : []),
        ...(typeof persona.replyStyle === "string" && persona.replyStyle.trim() ? [STR.personaReplyStyleLine[language](persona.replyStyle.trim())] : [])
      ]
    : [];
  // 事实解析用冻结副本。曾有一版是内联重写的，抄错了「先查卡命中还是先判 strict」的
  // 顺序（Ephor 2026-11-07 复核指出，实测 3/5 情形与生产不一致）；改成直接调生产
  // 函数又落进自证陷阱。冻结副本是第三条路：顺序与 origin/main 一致，且不随生产漂。
  const factsResolved = config?.profileFactsEnabled === true && typeof factsProvider === "function"
    ? legacyResolveFactsCard(factsProvider(), agentId, { strict: config?.personaStrictAddressing === true })
    : { facts: [], source: "none" };
  const factLines = [];
  if (factsResolved.facts.length) {
    let chars = 0;
    let shown = 0;
    for (const fact of factsResolved.facts) {
      const line = STR.profileFactLine[language](String(fact));
      if (shown >= MAX_LINES || chars + line.length > MAX_CHARS) break;
      factLines.push(line);
      chars += line.length;
      shown += 1;
    }
    const remaining = factsResolved.facts.length - shown;
    if (remaining > 0) factLines.push(STR.profileFactsTruncated[language](remaining));
    if (factLines.length) factLines.unshift(STR.profileFactsHeader[language](factsResolved.facts.length));
  }
  const id = typeof agentId === "string" && agentId.trim() ? agentId.trim() : null;
  if (!profile && !rules.length && !personaLines.length && !factLines.length) {
    return { text: "", source: resolved.source, agent: id, configGate: enabled };
  }
  const lines = [STR.userSettingsHeader[language]];
  lines.push(...personaLines);
  if (profile) lines.push(STR.profileLine[language](profile));
  lines.push(...factLines);
  for (const rule of rules) lines.push(STR.ruleLine[language](rule));
  return { text: escapePromptVars(config, lines.join("\n")), source: resolved.source, agent: id, configGate: enabled };
}

// ---- ① text 逐字节不变 -------------------------------------------------------

const CASES = [
  ["空库全空", makeSettings(), {}],
  ["只有画像", makeSettings({ profile: "用户是规划背景" }), {}],
  ["只有规则", makeSettings({ rules: ["不提及用户名", "先结论后展开"] }), {}],
  ["画像+规则", makeSettings({ profile: "用户是规划背景", rules: ["不提及用户名"] }), {}],
  [
    "人格三行齐（default 卡）",
    // name 里刻意放 {{x}}：人格段若被提前转义，转义是幂等的，下面的
    // 「转义后等于 text」断言抓不到（CodeRabbit 2026-11-07 指出）。
    makeSettings({ profile: "画像原文", rules: ["规则一"], persona: { enabled: true, name: "Amarre {{x}}", personality: "轻松幽默", replyStyle: "先结论" } }),
    { personaEnabled: true }
  ],
  [
    "人格卡只填 name（另两行不出现）",
    makeSettings({ profile: "画像", rules: [], persona: { enabled: true, name: "Amarre" } }),
    { personaEnabled: true }
  ],
  [
    "人格卡 enabled:false（整段不渲染）",
    makeSettings({ profile: "画像", rules: [], persona: { enabled: false, name: "Amarre" } }),
    { personaEnabled: true }
  ],
  [
    "byAgent 命中",
    makeSettings({ profile: "画像", rules: [], byAgent: { zephyr: { enabled: true, name: "泽菲尔", personality: "冷危" } } }),
    { personaEnabled: true, agentId: "zephyr" }
  ],
  [
    "strict + 未命中（source=none）",
    makeSettings({ profile: "画像", rules: [], byAgent: { zephyr: { enabled: true, name: "泽菲尔" } } }),
    { personaEnabled: true, personaStrictAddressing: true, agentId: "ghost" }
  ],
  [
    "总闸关着（人格行整段不出现，画像照出）",
    makeSettings({ profile: "画像", rules: ["规则一"], persona: { enabled: true, name: "Amarre" } }),
    { personaEnabled: false }
  ],
  ["英文 locale", makeSettings({ profile: "profile", rules: ["rule one"] }), { language: "en" }],
  ["转义关掉", makeSettings({ profile: "画像 {{x}}", rules: ["规则 {{y}}"] }), { escapePromptVariables: false }],
  ["转义默认开（裸 {{ 要插反斜杠）", makeSettings({ profile: "画像 {{x}}", rules: ["规则 }}y{{"] }), {}],
  [
    "事实段（未截断）",
    makeSettings({ profile: "画像", rules: ["规则一"] }),
    { profileFactsEnabled: true, factsProvider: () => ({ default: ["事实甲", "事实乙"], byAgent: {} }) }
  ],
  [
    "事实段（超 40 行帽，截断）",
    makeSettings({ profile: "画像", rules: [] }),
    { profileFactsEnabled: true, factsProvider: () => ({ default: Array.from({ length: 50 }, (_, i) => `事实${i}`), byAgent: {} }) }
  ],
  [
    "事实段（超 1200 字符帽，截断）",
    makeSettings({ profile: "画像", rules: [] }),
    { profileFactsEnabled: true, factsProvider: () => ({ default: Array.from({ length: 30 }, () => "字".repeat(100)), byAgent: {} }) }
  ],
  [
    "事实段开关关着（与无 provider 同源）",
    makeSettings({ profile: "画像", rules: [] }),
    { profileFactsEnabled: false, factsProvider: () => ({ default: ["事实甲"], byAgent: {} }) }
  ],
  [
    "事实段 strict 未命中（整段不渲染）",
    makeSettings({ profile: "画像", rules: [] }),
    { profileFactsEnabled: true, personaStrictAddressing: true, agentId: "ghost", factsProvider: () => ({ default: ["默认卡"], byAgent: { botA: ["botA 卡"] } }) }
  ],
  [
    "事实段 byAgent 命中",
    makeSettings({ profile: "画像", rules: [] }),
    { profileFactsEnabled: true, agentId: "botA", factsProvider: () => ({ default: ["默认卡"], byAgent: { botA: ["botA 卡"] } }) }
  ],
  [
    "事实里的 {{ }} 要转义",
    makeSettings({ profile: "画像", rules: [] }),
    { profileFactsEnabled: true, factsProvider: () => ({ default: ["模板 {{x}} 事实"], byAgent: {} }) }
  ],
  // 下面三条覆盖 resolveFactsCard 的四条出口：golden 曾把事实解析内联重写，
  // 抄错了「先查本卡命中还是先判 strict」的顺序，而这 20 个用例当时全绿——说明
  // 分歧路径没被覆盖。Ephor 2026-11-07 复核指出后补齐（实测内联版 3/5 分歧）。
  [
    "事实段 strict 开着但本卡命中（命中优先于 strict，不许判 none）",
    makeSettings({ profile: "画像", rules: [] }),
    { profileFactsEnabled: true, personaStrictAddressing: true, agentId: "botA", factsProvider: () => ({ default: ["默认卡"], byAgent: { botA: ["botA 卡"] } }) }
  ],
  [
    "事实段 strict 关着且本卡未命中（落 default，不许判 byAgent 空）",
    makeSettings({ profile: "画像", rules: [] }),
    { profileFactsEnabled: true, agentId: "ghost", factsProvider: () => ({ default: ["默认卡"], byAgent: { botA: ["botA 卡"] } }) }
  ],
  [
    "事实段 strict 开着但 byAgent 整体为空（#587 例外，仍落 default）",
    makeSettings({ profile: "画像", rules: [] }),
    { profileFactsEnabled: true, personaStrictAddressing: true, agentId: "botA", factsProvider: () => ({ default: ["默认卡"], byAgent: {} }) }
  ]
];

test("text 逐字节不变：新实现与改动前的实现，23 种配置下输出完全一致", () => {
  // 逐个比对并把**所有**分歧收集完再断言：循环里直接 assert 会在第一条分歧处
  // 抛出，后面几条根本没跑到（Ephor 2026-11-07 复核时暴露出这一点——把 golden
  // 换回内联版只报 1 条，实际有 3 条分歧路径）。
  const bad = [];
  for (const [name, settings, extra] of CASES) {
    const { agentId = null, ...config } = extra;
    const args = { settings, config, agentId, factsProvider: config.factsProvider };
    const before = legacyRender(args).text;
    const after = renderUserSettingsBlock(args).text;
    if (after !== before) bad.push(`「${name}」\n  改动前: ${JSON.stringify(before)}\n  改动后: ${JSON.stringify(after)}`);
  }
  assert.equal(bad.length, 0, `${bad.length} 种配置的注入文本变了：\n${bad.join("\n")}`);
});

// ---- ② segments 是 text 的唯一真源 ------------------------------------------

test("segments 拼回去等于未转义的整串，转义后等于 text（同源，不是第二份实现）", () => {
  for (const [name, settings, extra] of CASES) {
    const { agentId = null, ...config } = extra;
    const out = renderUserSettingsBlock({ settings, config, agentId, factsProvider: config.factsProvider });
    const joined = out.segments.map((s) => s.text).join("\n");
    // 段必须是**未转义**的原文：只比「转义后等于 text」抓不到「某段被提前转义」——
    // escapePromptVars 幂等（/[{}]{2,}/g 只在连续花括号前插反斜杠，已插过的串不再匹配），
    // 提前转义一遍再整体转义一遍，结果与只转义一遍逐字节相同。
    // 所以另取一份独立基线：同一套配置把转义关掉跑 golden，段拼装必须等于它。
    const rawBefore = legacyRender({
      settings,
      config: { ...config, escapePromptVariables: false },
      agentId,
      factsProvider: config.factsProvider
    }).text;
    assert.equal(joined, rawBefore, `配置「${name}」：段拼装必须等于未转义原文（某段被提前转义就会在这里红）`);
    assert.equal(escapePromptVars(config, joined), out.text, `配置「${name}」：转义后的段拼装必须等于 text`);
    if (config.escapePromptVariables === false) {
      assert.equal(joined, out.text, `配置「${name}」：转义关掉时段拼装与 text 直接相等`);
    }
  }
});

test("段顺序：表头恒第一 → 人格 → 画像 → 事实 → 规则（设计稿⑥的顺序，改它就是改提示词权重）", () => {
  const settings = makeSettings({
    profile: "画像原文",
    rules: ["规则一", "规则二"],
    persona: { enabled: true, name: "Amarre", personality: "轻松幽默", replyStyle: "先结论" }
  });
  const out = renderUserSettingsBlock({
    settings,
    config: { language: "zh", personaEnabled: true, profileFactsEnabled: true },
    agentId: null,
    factsProvider: () => ({ default: ["事实甲"], byAgent: {} })
  });
  assert.deepEqual(
    out.segments.map((s) => s.kind),
    ["header", "personaName", "personaPersonality", "personaReplyStyle", "profile", "factsHeader", "fact", "rule", "rule"]
  );
});

test("人格段带 field，面板据此走字段级写回（不是整卡覆盖）", () => {
  const settings = makeSettings({ persona: { enabled: true, name: "Amarre", personality: "轻松幽默", replyStyle: "先结论" } });
  const out = renderUserSettingsBlock({ settings, config: { language: "zh", personaEnabled: true }, agentId: null });
  const fields = out.segments.filter((s) => s.kind.startsWith("persona")).map((s) => s.field);
  assert.deepEqual(fields, ["name", "personality", "replyStyle"]);
});

test("只填了 name 的人格卡：另外两个字段既不出段也不出空行", () => {
  const settings = makeSettings({ persona: { enabled: true, name: "Amarre", personality: "   ", replyStyle: "" } });
  const out = renderUserSettingsBlock({ settings, config: { language: "zh", personaEnabled: true }, agentId: null });
  assert.deepEqual(out.segments.filter((s) => s.kind.startsWith("persona")).map((s) => s.field), ["name"]);
});

// ---- ③ 事实段的 shown/total ------------------------------------------------

test("事实未截断：factsHeader 的 shown === total，且没有 factsTruncated 段", () => {
  const out = renderUserSettingsBlock({
    settings: makeSettings({ profile: "画像" }),
    config: { language: "zh", profileFactsEnabled: true },
    agentId: null,
    factsProvider: () => ({ default: ["甲", "乙", "丙"], byAgent: {} })
  });
  const header = out.segments.find((s) => s.kind === "factsHeader");
  assert.equal(header.shown, 3);
  assert.equal(header.total, 3);
  assert.equal(out.segments.filter((s) => s.kind === "fact").length, 3);
  assert.equal(out.segments.some((s) => s.kind === "factsTruncated"), false, "没截断就不许有尾注段");
});

test("事实超行帽：factsHeader.total 是总条数，shown 是实际注入数，尾注 remaining 等于差值", () => {
  const facts = Array.from({ length: 50 }, (_, i) => `事实${i}`);
  const out = renderUserSettingsBlock({
    settings: makeSettings({ profile: "画像" }),
    config: { language: "zh", profileFactsEnabled: true },
    agentId: null,
    factsProvider: () => ({ default: facts, byAgent: {} })
  });
  const header = out.segments.find((s) => s.kind === "factsHeader");
  const truncated = out.segments.find((s) => s.kind === "factsTruncated");
  assert.equal(header.total, 50, "表头报总数，不是已注入数");
  assert.equal(header.shown, 40, "行帽 40");
  assert.equal(truncated.remaining, 10, "尾注如实报被丢弃的条数");
  assert.equal(header.shown + truncated.remaining, header.total, "shown + remaining 必须配平");
  assert.equal(out.segments.filter((s) => s.kind === "fact").length, 40);
});

test("事实超字符帽：shown 由字符预算决定，remaining 仍配平（两顶帽子任一先到都算）", () => {
  const facts = Array.from({ length: 30 }, () => "字".repeat(100));
  const out = renderUserSettingsBlock({
    settings: makeSettings({ profile: "画像" }),
    config: { language: "zh", profileFactsEnabled: true },
    agentId: null,
    factsProvider: () => ({ default: facts, byAgent: {} })
  });
  const header = out.segments.find((s) => s.kind === "factsHeader");
  const truncated = out.segments.find((s) => s.kind === "factsTruncated");
  assert.ok(header.shown > 0 && header.shown < 30, `字符帽先到时 shown 应落在中间，实际 ${header.shown}`);
  assert.equal(header.shown + truncated.remaining, header.total);
});

test("事实段的 fact.index 是注入序号，从 0 连续递增（面板据此定位到行）", () => {
  const out = renderUserSettingsBlock({
    settings: makeSettings({ profile: "画像" }),
    config: { language: "zh", profileFactsEnabled: true },
    agentId: null,
    factsProvider: () => ({ default: ["甲", "乙", "丙"], byAgent: {} })
  });
  assert.deepEqual(out.segments.filter((s) => s.kind === "fact").map((s) => s.index), [0, 1, 2]);
});

// ---- ④ 早退 ----------------------------------------------------------------

test("全空：segments 是空数组（不是 undefined，也不是一个只有表头的段）", () => {
  const out = renderUserSettingsBlock({ settings: makeSettings(), config: {}, agentId: null });
  assert.equal(out.text, "");
  assert.deepEqual(out.segments, []);
});

test("只有人格段开着、画像规则事实全空：不算早退，segments 从表头开始", () => {
  const out = renderUserSettingsBlock({
    settings: makeSettings({ persona: { enabled: true, name: "Amarre" } }),
    config: { language: "zh", personaEnabled: true },
    agentId: null
  });
  assert.deepEqual(out.segments.map((s) => s.kind), ["header", "personaName"]);
});

// ---- ⑤ 段里不许有未转义的整串 ----------------------------------------------

test("段文本本身保持原样（未转义），转义只发生在 text 这一层", () => {
  const settings = makeSettings({ profile: "画像 {{x}}" });
  const out = renderUserSettingsBlock({ settings, config: { language: "zh" }, agentId: null });
  const profileSeg = out.segments.find((s) => s.kind === "profile");
  assert.ok(profileSeg.text.includes("{{x}}"), "段里是原文，面板要显示给人看");
  assert.ok(!out.text.includes("{{x}}"), "text 里必须已转义");
});

// ---- ⑥ value：可回写的原始值（Ephor 2026-11-07 复核提出的第二期坑） ----------
//
// `text` 是带模板前缀的整行（`- 用户画像：xxx` / `  - xxx` / `- 规则：xxx`），
// 面板若直接拿它当新值回写，写一次叠一层前缀。可回写的段因此另带 `value`＝
// 原始值（无前缀、未转义）；表头、事实表头、截断尾注没有原始值，不带这个键。

test("画像段带 value＝原始画像，text 仍是带前缀的整行", () => {
  const out = renderUserSettingsBlock({ settings: makeSettings({ profile: "用户是规划背景" }), config: { language: "zh" }, agentId: null });
  const seg = out.segments.find((s) => s.kind === "profile");
  assert.equal(seg.value, "用户是规划背景", "value 必须是原始值，不带 `- 用户画像：` 前缀");
  assert.equal(seg.text, STR.profileLine.zh("用户是规划背景"), "text 仍是整行");
  assert.ok(seg.text !== seg.value, "两者不该相同，否则这条用例没测到前缀");
});

test("人格三段的 value 分别等于 name / personality / replyStyle 的原始值", () => {
  const out = renderUserSettingsBlock({
    settings: makeSettings({ persona: { enabled: true, name: "Amarre", personality: "懒洋洋", replyStyle: "先结论" } }),
    config: { language: "zh", personaEnabled: true },
    agentId: null
  });
  const byKind = Object.fromEntries(out.segments.filter((s) => s.kind.startsWith("persona")).map((s) => [s.kind, s]));
  assert.equal(byKind.personaName.value, "Amarre");
  assert.equal(byKind.personaPersonality.value, "懒洋洋");
  assert.equal(byKind.personaReplyStyle.value, "先结论");
  assert.equal(byKind.personaName.field, "name", "field 仍在，value 不取代它");
});

test("事实段的 value 是原始事实串，不带 `  - ` 前缀", () => {
  const out = renderUserSettingsBlock({
    settings: makeSettings({ profile: "画像" }),
    config: { language: "zh", profileFactsEnabled: true },
    agentId: null,
    factsProvider: () => ({ default: ["甲事实", "乙事实"], byAgent: {} })
  });
  const facts = out.segments.filter((s) => s.kind === "fact");
  assert.deepEqual(facts.map((s) => s.value), ["甲事实", "乙事实"]);
  assert.equal(facts[0].text, STR.profileFactLine.zh("甲事实"));
  assert.ok(facts[0].text !== facts[0].value);
});

test("规则段的 value 是原始规则串", () => {
  const out = renderUserSettingsBlock({ settings: makeSettings({ profile: "画像", rules: ["提交时不得有AI署名"] }), config: { language: "zh" }, agentId: null });
  const seg = out.segments.find((s) => s.kind === "rule");
  assert.equal(seg.value, "提交时不得有AI署名");
  assert.equal(seg.text, STR.ruleLine.zh("提交时不得有AI署名"));
});

test("没有原始值的段不带 value 键（不是 undefined、不是空串）", () => {
  const out = renderUserSettingsBlock({
    settings: makeSettings({ profile: "画像", rules: ["规则一"] }),
    config: { language: "zh", profileFactsEnabled: true },
    agentId: null,
    factsProvider: () => ({ default: Array.from({ length: 50 }, (_, i) => `事实${i}`), byAgent: {} })
  });
  for (const kind of ["header", "factsHeader", "factsTruncated"]) {
    const seg = out.segments.find((s) => s.kind === kind);
    assert.ok(seg, `用例前提：应当存在 ${kind} 段`);
    assert.ok(!("value" in seg), `${kind} 段没有原始值，不该带 value 键`);
  }
});

test("回写幂等：拿 value 当新值再渲染，文本不变；拿 text 当新值会叠一层前缀", () => {
  const config = { language: "zh" };
  const original = renderUserSettingsBlock({ settings: makeSettings({ profile: "用户是规划背景" }), config, agentId: null });
  const profileValue = original.segments.find((s) => s.kind === "profile").value;
  const profileText = original.segments.find((s) => s.kind === "profile").text;

  const fromValue = renderUserSettingsBlock({ settings: makeSettings({ profile: profileValue }), config, agentId: null });
  assert.equal(fromValue.text, original.text, "用 value 回写必须幂等");

  // 用 text 当新值回写：新值里已经含 `- 用户画像：` 前缀，再渲染时模板又加一层，
  // 于是注入文本里出现两遍前缀。`value` 就是为挡这个坑存在的。
  const fromText = renderUserSettingsBlock({ settings: makeSettings({ profile: profileText }), config, agentId: null });
  const doubledLine = fromText.segments.find((s) => s.kind === "profile").text;
  assert.notEqual(fromText.text, original.text, "用 text 回写必须改变注入文本，否则这条用例没测到");
  assert.ok(
    doubledLine.startsWith("- 用户画像：- 用户画像："),
    `用 text 回写应当叠成两层前缀，实际是：${doubledLine}`
  );
  assert.equal(
    fromText.segments.find((s) => s.kind === "profile").value,
    profileText,
    "value 只如实回显存进去的东西（它就是原文），叠层发生在渲染这一步"
  );
});

test("value 也是未转义的原文（转义只在 text 这一层）", () => {
  const out = renderUserSettingsBlock({ settings: makeSettings({ profile: "画像 {{x}}" }), config: { language: "zh" }, agentId: null });
  const seg = out.segments.find((s) => s.kind === "profile");
  assert.equal(seg.value, "画像 {{x}}", "value 要能直接回写进 settings，不能带反斜杠");
  assert.ok(!out.text.includes("{{x}}"), "text 里仍必须已转义");
});

test("人格字段带前后空格时 value 已 trim（回写进去的不能是带空格的原文）", () => {
  const out = renderUserSettingsBlock({
    settings: makeSettings({ persona: { enabled: true, name: "  Amarre  ", personality: " 懒洋洋 ", replyStyle: " 先结论 " } }),
    config: { language: "zh", personaEnabled: true },
    agentId: null
  });
  const byKind = Object.fromEntries(out.segments.filter((s) => s.kind.startsWith("persona")).map((s) => [s.kind, s]));
  assert.equal(byKind.personaName.value, "Amarre", "value 要与 text 用的是同一个 trim 后的值");
  assert.equal(byKind.personaPersonality.value, "懒洋洋");
  assert.equal(byKind.personaReplyStyle.value, "先结论");
  assert.ok(!byKind.personaName.text.includes("  "), "text 里也不该有那两处空格");
});

// ---- ④ golden 的冻结副本与生产是否还一致（漂移告警，不是等价断言）---------------
//
// golden 里那两份 resolve 副本是冻结的：生产怎么演进它们都不动，所以「text 逐字节
// 不变」这条结论始终对着一个历史基准成立。代价是副本会过期——如果生产改了判据而
// 副本没跟着改，golden 比的就不再是「改动前 vs 改动后」，而是「旧判据 vs 新判据」，
// 那批用例会开始报一些看不懂的分歧。
//
// 这条用例就是把那个时刻显式化：副本与生产一旦分歧就红，红的时候**别急着改副本**，
// 先判断生产这次改动是不是有意的——
//   · 有意改判据 → 同时更新 legacyRender 的期望，并在 CHANGELOG 记清「基准已换代」；
//   · 无意改坏 → 生产回退。
// 两种情况都不该由这条用例替你决定，它只负责让静默漂移变成一次可见的失败。
test("golden 的 resolve 冻结副本与生产实现一致（漂移告警）", () => {
  const personaCases = [
    ["无名会话", {}, null, false],
    ["无名会话 + strict", {}, null, true],
    ["default 卡", { default: { enabled: true, name: "A" } }, null, false],
    ["default 卡 + strict", { default: { enabled: true, name: "A" } }, null, true],
    ["本卡命中", { default: { enabled: true, name: "A" }, byAgent: { botA: { enabled: true, name: "B" } } }, "botA", false],
    ["本卡命中 + strict", { default: { enabled: true, name: "A" }, byAgent: { botA: { enabled: true, name: "B" } } }, "botA", true],
    ["本卡存在但关着", { default: { enabled: true, name: "A" }, byAgent: { botA: { enabled: false } } }, "botA", false],
    ["本卡存在但关着 + strict", { default: { enabled: true, name: "A" }, byAgent: { botA: { enabled: false } } }, "botA", true],
    ["建了别家的卡（未命中）", { default: { enabled: true, name: "A" }, byAgent: { botB: { enabled: true } } }, "botA", false],
    ["建了别家的卡（未命中）+ strict", { default: { enabled: true, name: "A" }, byAgent: { botB: { enabled: true } } }, "botA", true],
    ["byAgent 有键但空数组", { default: { enabled: true }, byAgent: { botA: [] } }, "botA", true],
    ["agentId 带空格", { default: { enabled: true, name: "A" }, byAgent: { botA: { enabled: true, name: "B" } } }, "  botA  ", true],
    ["agentId 空串", { default: { enabled: true, name: "A" } }, "", true]
  ];
  const factsCases = [
    ["无名会话", { default: ["d"], byAgent: {} }, null, false],
    ["无名会话 + strict", { default: ["d"], byAgent: {} }, null, true],
    ["本卡命中", { default: ["d"], byAgent: { botA: ["a"] } }, "botA", false],
    ["本卡命中 + strict", { default: ["d"], byAgent: { botA: ["a"] } }, "botA", true],
    ["本卡空数组（未命中）", { default: ["d"], byAgent: { botA: [] } }, "botA", false],
    ["本卡空数组（未命中）+ strict", { default: ["d"], byAgent: { botA: [] } }, "botA", true],
    ["建了别家的卡 + strict", { default: ["d"], byAgent: { botB: ["b"] } }, "botA", true],
    ["无 default 键", { byAgent: { botB: ["b"] } }, "botA", true],
    ["undefined 存储", undefined, "botA", true]
  ];

  const drift = [];
  for (const [name, store, agentId, strict] of personaCases) {
    const legacy = legacyResolvePersonaCard({ getPersona: () => store }, agentId, { strict });
    const real = resolvePersonaCard({ getPersona: () => store }, agentId, { strict });
    if (JSON.stringify(legacy) !== JSON.stringify(real)) {
      drift.push(`人格 / ${name}：golden=${JSON.stringify(legacy)} 生产=${JSON.stringify(real)}`);
    }
  }
  for (const [name, store, agentId, strict] of factsCases) {
    const legacy = legacyResolveFactsCard(store, agentId, { strict });
    const real = resolveFactsCard(store, agentId, { strict });
    if (JSON.stringify(legacy) !== JSON.stringify(real)) {
      drift.push(`事实 / ${name}：golden=${JSON.stringify(legacy)} 生产=${JSON.stringify(real)}`);
    }
  }
  assert.equal(
    drift.length,
    0,
    `生产判据变了，golden 的冻结副本已过期（${drift.length} 处）。先判断这次改动是否有意：\n` +
      `有意 → 更新副本并记 CHANGELOG「基准已换代」；无意 → 回退生产。\n` +
      drift.join("\n")
  );
});