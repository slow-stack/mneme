// dsh-mneme/src/user-settings.js
// 「用户设置」注入块（人格 / 画像 / 自动画像事实 / 规则）的唯一渲染处。
//
// 为什么要单独成模块：面板「Agent 眼中的画像」那张卡原本自己在前端拼了一份 profile +
// rules 的列表，注释写着「注入生效文本」——但它没有表头、没有「- 用户画像：」前缀，
// 也完全没有人格三行。两处渲染代码各写各的，就一定会漂；而漂了没人报错，因为两边都
// 「看着像」。现在注入器与预览路由调同一个函数，前端只显示后端给的文本。
//
// 顺序是设计口径（人格设计稿⑥）：特化指令（人格）先出，画像与规则后出、后写覆盖占
// 上风，rules 恒最硬。改这个顺序等于改提示词权重，别顺手调。自动画像事实（2026-11-06，
// src/profile-facts.js）插在画像之后、规则之前——它是「画像的 agent 侧补充」，与
// 手填画像物理分离（模型对 user_settings.profile 永远只有读权）。

import { STR, langOf } from "./lang.js";

// 事实段的注入预算（本块此前无任何截断机制——它是「身份文本」，从不轮换）。
// 不设上限的话，一次失控的维护轮能把每帧 systemPrompt 撑爆；行数与总字符双帽，
// 截断不静默（尾注如实说还剩几条，与 #164① 同一纪律）。
const PROFILE_FACTS_MAX_LINES = 40;
const PROFILE_FACTS_MAX_CHARS = 1200;

/**
 * 提示词变量转义：宿主模板插值对 `{{`/`}}` 会按变量名解析并在缺失时抛错，整轮崩掉。
 * 所以把 2 个以上连续花括号逐字符插 `\`，让任何 `{{`/`}}` 子串都不残留；转换幂等，
 * 单花括号原样通过。`config.escapePromptVariables === false` 时退回原文。
 *
 * 住在这里是刻意的：预览必须与注入共用同一个转义，否则「同源」又是假的。
 * `src/inject.js` 的同名闭包函数只是薄薄一层委托，其余调用点不动。
 */
export function escapePromptVars(config, text) {
  if (config?.escapePromptVariables === false) return String(text);
  return String(text).replace(/[{}]{2,}/g, (run) => run.split("").join("\\"));
}

/**
 * 按会话身份取人格卡。返回 `{ card, source }`，`source` 是给面板解释「用的哪张卡」的
 * 读数，不参与判定。
 *
 * `strict`（config.personaStrictAddressing，默认关）决定「有身份、没这张身份的卡」
 * 与「这张卡被显式关掉」这两种情况：
 * - 关（现状）：落 default 卡。default 于是变成「所有没建卡的 agent 都能拿到它」，
 *   包括宿主里跑的外部 bot——它自带身份与设定，两处「你是谁」撞在同一帧里。
 * - 开：不注入人格（`source: "none"`）。default 退回它的本意：只兜「这一帧解析不到
 *   身份」的会话（无名会话本来就是 default 卡的受众）。
 * 默认关是有意的：这是一次口径变更，不能让老用户的注入文本在升级后静默变化。
 *
 * 严格模式有一格例外（#587）：`byAgent` **整体为空**时仍回落 default。两种处境必须
 * 分开——「建了卡、只是没这张身份的卡」是真该按 none 处理（否则关掉一张卡等于没关），
 * 而「一张身份卡都没建」时 default 是用户手里唯一的一张卡，按 none 处理等于把它永久
 * 废掉，且面板不报错。DS Bot 这类宿主里所有 bot 会话共用 `agentPreset: "standard"`
 * （`ds-bot/src/host/roster.js:72-80` 强制写入），用户按 bot 名字建卡永远不会命中，
 * 于是必然落进后一种处境：开了严格寻址就把唯一那张卡静默关死。
 */
export function resolvePersonaCard(settings, agentId, { strict = false } = {}) {
  const store = settings.getPersona();
  const id = typeof agentId === "string" && agentId.trim() ? agentId.trim() : "";
  const card = id ? store.byAgent[id] : null;
  if (card && card.enabled === true) return { card, source: "byAgent" };
  // 严格模式只在「确实建过身份卡」时才拒绝兜底：一张都没建时兜底是唯一的出路。
  if (id && strict && Object.keys(store.byAgent).length > 0) return { card: {}, source: "none" };
  return { card: store.default, source: "default" };
}

/**
 * 按会话身份取自动事实卡（resolvePersonaCard 的镜像，形状不同：facts 没有
 * enabled 位，「卡存在」就是非空数组）。strict 语义与人格一致：有身份但没这张
 * 身份的卡时不落 default——两个 bot 对用户的认知不互串是 store 层分区（输入行）
 * 与本层寻址（输出注入）共同守住的边界。与人格同一条例外（#587）：`byAgent` 整体
 * 为空时仍落 default，「一张都没建」不等于「这一张没建」。
 */
export function resolveFactsCard(factsStore, agentId, { strict = false } = {}) {
  const id = typeof agentId === "string" && agentId.trim() ? agentId.trim() : "";
  const byAgent = factsStore?.byAgent ?? {};
  const card = id ? (byAgent[id] ?? null) : null;
  if (card && card.length) return { facts: card, source: "byAgent" };
  if (id && strict && Object.keys(byAgent).length > 0) return { facts: [], source: "none" };
  return { facts: factsStore?.default ?? [], source: "default" };
}

/**
 * 渲染整块「用户设置」。`agentId` 是会话身份（解析不到传 null → 走 default 兜底）。
 * `factsProvider` 是 profile-facts 域的读口（返回 `{ default: [...], byAgent: {...} }`），
 * 可选；**开关与 provider 双闸**——profileFactsEnabled 关着时连 provider 都不调，
 * 「关」必须是零读数而不是「读了不渲染」。返回 `{ text, source, agent, configGate }`：
 * `text` 为最终注入文本（全空时 ""），`configGate` 是 personaEnabled 的现值——面板
 * 要靠它解释「卡开着为什么没生效」。
 */
export function renderUserSettingsBlock({ settings, config, agentId = null, factsProvider = null }) {
  const language = langOf(config);
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
  // 事实段：开关关 / 无 provider / 该卡没事实三种情况都不渲染，注入文本与
  // 未启用事实时逐字节一致（老用户零变化）。
  const factsResolved = config?.profileFactsEnabled === true && typeof factsProvider === "function"
    ? resolveFactsCard(factsProvider(), agentId, { strict: config?.personaStrictAddressing === true })
    : { facts: [], source: "none" };
  const factLines = [];
  if (factsResolved.facts.length) {
    let chars = 0;
    let shown = 0;
    for (const fact of factsResolved.facts) {
      const line = STR.profileFactLine[language](String(fact));
      if (shown >= PROFILE_FACTS_MAX_LINES || chars + line.length > PROFILE_FACTS_MAX_CHARS) break;
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
