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
 * 改动前的实现（origin/main 041e8f3 的 src/user-settings.js:88-134 原样）。
 * 只依赖 lang.js 与 escapePromptVars——这两个本期都没改。
 */
function legacyRender({ settings, config, agentId = null, factsProvider = null }) {
  const language = config?.language === "en" ? "en" : "zh";
  const profile = settings.getProfile().trim();
  const rules = settings.getRules();
  const enabled = config?.personaEnabled === true;
  const resolved = enabled
    ? resolvePersonaCard(settings, agentId, { strict: config?.personaStrictAddressing === true })
    : { card: {}, source: "default" };
  const persona = resolved.card;
  const personaLines = persona?.enabled === true
    ? [
        ...(typeof persona.name === "string" && persona.name.trim() ? [STR.personaNameLine[language](persona.name.trim())] : []),
        ...(typeof persona.personality === "string" && persona.personality.trim() ? [STR.personaPersonalityLine[language](persona.personality.trim())] : []),
        ...(typeof persona.replyStyle === "string" && persona.replyStyle.trim() ? [STR.personaReplyStyleLine[language](persona.replyStyle.trim())] : [])
      ]
    : [];
  // 事实解析直接调生产函数 resolveFactsCard——内联重写会抄错「先查卡命中还是先判
  // strict」的顺序（Ephor 2026-11-07 复核指出，内联版实测 3/5 情形与生产不一致）。
  const factsResolved = config?.profileFactsEnabled === true && typeof factsProvider === "function"
    ? resolveFactsCard(factsProvider(), agentId, { strict: config?.personaStrictAddressing === true })
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
    makeSettings({ profile: "画像原文", rules: ["规则一"], persona: { enabled: true, name: "Amarre", personality: "轻松幽默", replyStyle: "先结论" } }),
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
