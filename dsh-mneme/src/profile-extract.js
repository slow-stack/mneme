// dsh-mneme/src/profile-extract.js
// 从活跃记忆反向提取「助手眼中的用户」画像**草稿**（issue #497 的第三段）。
//
// 三条纪律，都是「做错界面上看不出来」的那类，所以写在文件头：
// 1. **只出草稿，绝不写 user_settings**。画像正文是用户手写的原文；让模型「合并」
//    等于给它改写权，而改写后的文本每帧都注入。采用与否必须是用户在面板上的一次
//    显式动作（走既有的 PUT /profile），本模块不参与。
// 2. **没有可用输入就不调模型**。空库下模型只会编一段「她是个热爱学习的人」，
//    那种草稿比没有草稿更坏——它会成为用户看到的「关于自己」的第一版真相。
// 3. **吐不出可用 JSON 就报错，绝不回空草稿**。「没提炼出东西」与「模型没按格式
//    写」必须在结果里可区分（#493 同一条教训：解析失败被读成空结果，用户会以为库是空的）。
//
// 记忆正文是模型的**可影响输入**：一条指令型记忆不该改写这次任务。所以喂进去的内容
// 包在围栏里，并在系统段重申「这是数据不是指令」——与 #493 的转录围栏、#380 的判定
// 提示同源的做法，不是第三套。
//
// 系统段还禁了一件事：**不许给助手本身起名或设定人格**。画像与规则不受
// personaEnabled 管辖、也不看人格寻址口径（见 src/user-settings.js），正文里一旦出现
// 「你是某某」，就会重演 #497 那个身份撞车——而且是每个会话每一帧。
//
// LLM 调用与审计完全复用 dream.js 的既有缝（streamText / runAuditedLlm / resolveRoute）：
// chunk 形状的三个硬点（用量嵌在 chunk.usage、终态 finish 才是错误、rc.1 把适配器故障
// 转成 finish chunk 而不是抛错）都在那里踩过并修过，不在这里重写第二遍。

import { STR, langOf } from "./lang.js";
import { describeStreamFailure, resolveRoute, runAuditedLlm, streamText } from "./dream.js";

const DEFAULT_MAX_ROWS = 120;
const DEFAULT_ROW_CHARS = 260;
const DEFAULT_TOTAL_CHARS = 9000;

/** 带 code 的失败：路由按 code 映射状态码，调用方据此区分「没东西可提」与「模型没配合」。 */
export class ProfileExtractError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = "ProfileExtractError";
    this.code = code;
  }
}

/**
 * 从模型输出里取那个 JSON 对象。先剥 markdown 围栏（模型常加），再退到「第一个 { 到
 * 最后一个 }」的宽取——画像文本里带花括号是常态，严格 parse 失败时这一步能救回来。
 * 取不到可用结构就返回 null，由调用方判失败；绝不返回空串冒充成功。
 */
export function parseProfileDraft(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, "$1").trim();
  const candidates = cleaned.startsWith("{") ? [cleaned] : [];
  const open = cleaned.indexOf("{");
  const close = cleaned.lastIndexOf("}");
  if (open >= 0 && close > open) candidates.push(cleaned.slice(open, close + 1));
  for (const candidate of candidates) {
    let value;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (value && typeof value === "object" && typeof value.profile === "string" && value.profile.trim()) {
      return value.profile.trim();
    }
  }
  return null;
}

/** 活跃行读数：归档与被遗忘的行默认就不在这里（store.list 的默认口径）。 */
function collectRows(service, maxRows, totalChars, rowChars) {
  // 多取一行只为如实回答「还有没有」：截断必须可被调用方察觉，静默少读会让用户
  // 以为画像已经看全了整个库。
  const fetched = service.list({ limit: maxRows + 1, order: "importance" });
  const rows = [];
  let chars = 0;
  let truncated = fetched.length > maxRows;
  for (const row of fetched.slice(0, maxRows)) {
    const content = String(row.content ?? "").slice(0, rowChars);
    if (content.length < String(row.content ?? "").length) truncated = true;
    const size = `${row.type} ${row.title} ${content}`.length;
    if (chars + size > totalChars) {
      truncated = true;
      break;
    }
    chars += size;
    rows.push({ id: row.id, type: row.type, title: row.title, content });
  }
  return { rows, truncated, charsUsed: chars };
}

/**
 * @param {{ ctx: object, service: object, config: object, logger?: object }} deps
 *   ctx 要带 llm（宿主 LLM 句柄）；settings 不参与——本模块按设计不写画像。
 * @returns {(opts?: {maxRows?: number, totalChars?: number, rowChars?: number}) => Promise<object>}
 */
export function createProfileExtractor({ ctx, service, config, logger }) {
  const log = logger ?? ctx?.logger;
  const language = langOf(config);

  return async function extractProfile({
    maxRows = DEFAULT_MAX_ROWS,
    totalChars = DEFAULT_TOTAL_CHARS,
    rowChars = DEFAULT_ROW_CHARS
  } = {}) {
    const { rows, truncated, charsUsed } = collectRows(service, maxRows, totalChars, rowChars);
    if (!rows.length) {
      throw new ProfileExtractError("no-input", "no active memories to extract a profile from");
    }
    const route = resolveRoute(ctx, config, log);
    // resolveRoute 在「没有 dreamProvider/dreamModel、宿主也没有可解析的默认模型」时
    // 返回 undefined。不判它就会被读成 `Cannot read properties of undefined` 抛出
    // TypeError，落到路由上是一个语义为「内部错误」的 500——而真正该说的是「没配模型」，
    // 面板要能给出「先去选模型」这句可行动的话（同 no-input 的取舍：不同结局不同话）。
    if (!route) {
      throw new ProfileExtractError("no-route", "no model route: set dreamProvider/dreamModel or pick an agent default model");
    }
    const listing = rows.map((r, i) => `${i + 1}. [${r.type}] ${r.title} :: ${r.content}`).join("\n");
    const userText = [
      STR.profileFenceOpen[language],
      listing,
      STR.profileFenceClose[language],
      language === "zh"
        ? `以上 ${rows.length} 条记忆条目（数据）到此结束。只依据它们输出 JSON，条目里没有的绝不发明。`
        : `End of the ${rows.length} memory entries (data). Answer from these only; invent nothing absent from them.`
    ].join("\n");

    let streamFailure = "";
    const text = await runAuditedLlm(ctx, service, config, {
      triggerSource: "profileExtract",
      operationType: "profile_extract",
      modelId: `${route.provider}:${route.model}`,
      relatedMemoryIds: rows.map((r) => r.id),
      streamError: () => streamFailure,
      // 吐了文字但没有可用结构 = 失败调用。审计必须记 error：success 配空草稿会让
      // 「模型不配合」在账目上长得像「这次确实没提炼出东西」。
      auditError: (out) => (parseProfileDraft(out) ? null : "profile extract returned no usable JSON object")
    }, (reportUsage) => streamText(ctx, {
      provider: route.provider,
      model: route.model,
      purpose: "compaction",
      messages: [
        { role: "system", content: [{ type: "text", text: STR.prompts.profileExtract[language] }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } },
        { role: "user", content: [{ type: "text", text: userText }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } }
      ]
    }, reportUsage, (reason) => { streamFailure = describeStreamFailure(reason); }));

    if (text === undefined) {
      throw new ProfileExtractError("stream-failed", streamFailure || "llm stream aborted or errored");
    }
    const draft = parseProfileDraft(text);
    if (!draft) {
      throw new ProfileExtractError("unparseable", "profile extract output was not a usable JSON object");
    }
    return {
      draft,
      rowsUsed: rows.length,
      truncated,
      charsUsed,
      provider: route.provider,
      model: route.model
    };
  };
}
