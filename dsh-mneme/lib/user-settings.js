// dsh-mneme/src/user-settings.js
// 「用户设置」注入块（人格 / 画像 / 规则）的唯一渲染处。
//
// 为什么要单独成模块：面板「Agent 眼中的画像」那张卡原本自己在前端拼了一份 profile +
// rules 的列表，注释写着「注入生效文本」——但它没有表头、没有「- 用户画像：」前缀，
// 也完全没有人格三行。两处渲染代码各写各的，就一定会漂；而漂了没人报错，因为两边都
// 「看着像」。现在注入器与预览路由调同一个函数，前端只显示后端给的文本。
//
// 顺序是设计口径（人格设计稿⑥）：特化指令（人格）先出，画像与规则后出、后写覆盖占
// 上风，rules 恒最硬。改这个顺序等于改提示词权重，别顺手调。

import { STR, langOf } from "./lang.js";

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
 */
export function resolvePersonaCard(settings, agentId, { strict = false } = {}) {
  const store = settings.getPersona();
  const id = typeof agentId === "string" && agentId.trim() ? agentId.trim() : "";
  const card = id ? store.byAgent[id] : null;
  if (card && card.enabled === true) return { card, source: "byAgent" };
  if (id && strict) return { card: {}, source: "none" };
  return { card: store.default, source: "default" };
}

/**
 * 渲染整块「用户设置」。`agentId` 是会话身份（解析不到传 null → 走 default 兜底）。
 * 返回 `{ text, source, agent, configGate }`：`text` 为最终注入文本（全空时 ""），
 * `configGate` 是 personaEnabled 的现值——面板要靠它解释「卡开着为什么没生效」。
 */
export function renderUserSettingsBlock({ settings, config, agentId = null }) {
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
  const id = typeof agentId === "string" && agentId.trim() ? agentId.trim() : null;
  if (!profile && !rules.length && !personaLines.length) {
    return { text: "", source: resolved.source, agent: id, configGate: enabled };
  }
  const lines = [STR.userSettingsHeader[language]];
  lines.push(...personaLines);
  if (profile) lines.push(STR.profileLine[language](profile));
  for (const rule of rules) lines.push(STR.ruleLine[language](rule));
  return { text: escapePromptVars(config, lines.join("\n")), source: resolved.source, agent: id, configGate: enabled };
}
