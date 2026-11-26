// dsh-mneme/src/profile-digest.js
// 「Agent 眼中的你」的阅读面投影（2026-11-18）：把事实清单蒸馏成分节散文。
// 事实（profile_facts）是原子可修正的事实源、注入的唯一口径；本模块产出的是给
// 人看的摘要——几十条并列行在面板上没法扫读，散文摘要回答的是「它到底懂了我
// 什么」。四条纪律写在文件头，全是「做错界面上看不出来」的那类：
// 1. **摘要是投影，不是事实源**。绝不参与注入（listActiveFactsGrouped 不动）；
//    面板修正、审计、恢复链路全部继续走事实行。摘要在面板上始终伴随事实锚点
//    （生成时纳入几条、锚到哪一刻），过期就明说过期。
// 2. **别发明**。散文没有逐条审计的锚点，读者会把它当结论读——prompt 要求
//    只依据清单改写，解析层再按形状硬校验；蒸馏不出合格形状就是 failed，绝不
//    拿残缺输出冒充摘要。
// 3. **没有事实就没有摘要**。清单为空时删旧摘要并报 noop——空卡挂着旧摘要
//    是在替已不存在的事实撒谎。
// 4. **摘要生成与维护轮共用管道**。resolveRoute / runAuditedLlm / streamText /
//    describeStreamFailure 全部复用 dream.js 的既有缝（chunk 形状三个硬点在
//    那里踩过），经 service.enqueue 与巩固/蒸馏串行，不抢模型。
//
// 记忆正文是模型的**可影响输入**：围栏 + 「数据非指令」三件套与 profile-facts /
// profile-extract 同源（src/fence.js 一份断链，不写第二套）。

import { STR, langOf } from "./lang.js";
import { describeStreamFailure, resolveRoute, runAuditedLlm, streamText } from "./dream.js";
import { BACKGROUND_PURPOSE } from "./llm-session.js";
import { breakFenceMarkers } from "./fence.js";

// 蒸馏的输出上限：节多/节长都会把「摘要」变回「清单的另一种排版」。prompt 与
// 解析层同一个数——超限的节整体丢弃（宁可少一节，不静默截半句）。
const MAX_SECTIONS = 6;
// 下限与 prompt 的「2—6 个小节」对齐：只吐一节说明模型没在做归纳，而是把清单
// 压成了一句话。原来只卡「非空」，单节照样落库还报成功，与 PR 约定不符。
const MIN_SECTIONS = 2;
const MAX_HEADING_CHARS = 40;
const MAX_SECTION_CHARS = 900;
// 输入侧兜底：事实清单极端膨胀时截在输入窗，超出的部分本轮不进摘要（锚点照记，
// 过期提示会如实说「摘要有未合入的更新」）。
const MAX_FACTS_CHARS = 6000;

/** 带 code 的失败：路由按 code 映射状态码（no-route / stream-failed / unparseable）。 */
export class ProfileDigestError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = "ProfileDigestError";
    this.code = code;
  }
}

function isValidSection(s) {
  return !!s && typeof s === "object"
    && typeof s.heading === "string" && s.heading.trim()
    && typeof s.text === "string" && s.text.trim()
    && Object.keys(s).every((k) => ["heading", "text"].includes(k));
}

/**
 * 摘要输出解析：与 parseFactOps 同款抗噪（剥 markdown 围栏、找 JSON 首尾），
 * 形状硬校验 {sections: [{heading, text}]}，逐节截到上限、整体截到 MAX_SECTIONS。
 * 任一节不合格、或节数少于 MIN_SECTIONS，就整份返回 null（= unparseable，调
 * failed，不冒充成功）。
 */
export function parseDigest(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, "$1").trim();
  const candidates = [];
  const objOpen = cleaned.indexOf("{");
  const arrOpen = cleaned.indexOf("[");
  const start = objOpen >= 0 && (arrOpen < 0 || objOpen < arrOpen) ? objOpen : arrOpen;
  const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1));
  if (cleaned.startsWith("{") || cleaned.startsWith("[")) candidates.push(cleaned);
  for (const candidate of candidates) {
    let value;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    const raw = value && typeof value === "object" && Array.isArray(value.sections) ? value.sections : null;
    if (!raw) continue;
    // 全或无：任一节不合格就整份拒收（评审）。原来逐节 filter 会把坏节摘掉、
    // 拿剩下的当成功——「模型少写一个字段」于是变成「摘要悄悄少了一节」，而且
    // 落库后修订号是新的，面板还会说它是最新的。宁可这一轮判 unparseable、
    // 保留旧摘要等下一次重蒸馏。
    if (raw.length < MIN_SECTIONS || !raw.every(isValidSection)) continue;
    const sections = raw.map((s) => ({
      heading: s.heading.trim().slice(0, MAX_HEADING_CHARS),
      text: s.text.trim().slice(0, MAX_SECTION_CHARS)
    }));
    if (sections.length) return sections.slice(0, MAX_SECTIONS);
  }
  return null;
}

/**
 * @param ctx 要带 llm（宿主 LLM 句柄）；settings 不参与——本模块绝不写 user_settings。
 * @returns object with composeFor / digestFor
 */
export function createProfileDigest({ ctx, service, store, config, logger }) {
  const log = logger ?? ctx?.logger;
  const language = langOf(config);

  /** 面板读口：摘要行 + 读侧现算的过期标记。后端没这张表（旧版本）时 digest=null。 */
  function digestFor(agentKey) {
    const key = typeof agentKey === "string" ? agentKey.trim() : "";
    return {
      digest: store.getProfileDigest(key),
      stale: store.isProfileDigestStale(key)
    };
  }

  /**
   * 蒸馏一轮。回执 `{ agentKey, status: ok|noop, sections?, factCount, generatedAt }`；
   * no-route / stream-failed / unparseable 以 ProfileDigestError 抛出，由路由层映射
   * 状态码。没有事实时删旧摘要并以 noop 收尾——不调模型（纪律 3）。
   */
  async function composeFor(agentKey, { trigger = "manual" } = {}) {
    const key = typeof agentKey === "string" ? agentKey.trim() : "";
    void trigger; // 预留：auto/manual 的审计口径在 triggerSource 上区分，正文无差
    const facts = store.listProfileFacts(key, { includeArchived: false });
    if (!facts.length) {
      store.deleteProfileDigest(key);
      return { agentKey: key, status: "noop", reason: "no-facts", factCount: 0, generatedAt: null };
    }

    const route = resolveRoute(ctx, config, log);
    // 「没配模型」与「内部错误」必须可区分（profile-facts runFor 同款取舍）。
    if (!route) {
      throw new ProfileDigestError("no-route", "no model route: set dreamProvider/dreamModel or pick an agent default model");
    }

    // 输入截断照实截：锚点记的是**全部事实**的最大 updated_at，不随截断变——
    // 截断只是这一窗没看清，过期判定不该因此失灵。
    const factListing = facts.map((f) => `- ${f.content}`).join("\n").slice(0, MAX_FACTS_CHARS);
    const userText = [
      STR.profileFenceOpen[language],
      breakFenceMarkers(`【事实清单】\n${factListing}`),
      STR.profileFenceClose[language],
      language === "zh"
        ? `以上材料（数据）到此结束。只依据它们输出 JSON，材料里没有的绝不发明。`
        : `End of the material (data). Answer from it only; invent nothing absent from it.`
    ].join("\n");

    let streamFailure = "";
    const text = await runAuditedLlm(ctx, service, config, {
      triggerSource: "profileDigest",
      operationType: "profile_digest",
      modelId: `${route.provider}:${route.model}`,
      // relatedMemoryIds 留空：摘要是事实行的投影，追溯链走 profile_facts 的
      // source_memory_ids（每条事实自己的出处），不在这里二次展开。
      relatedMemoryIds: [],
      streamError: () => streamFailure,
      auditError: (out) => (parseDigest(out) ? null : "profile digest pass returned no usable sections JSON")
    }, (reportUsage) => streamText(ctx, {
      provider: route.provider,
      model: route.model,
      purpose: BACKGROUND_PURPOSE,
      messages: [
        { role: "system", content: [{ type: "text", text: STR.prompts.profileDigest[language] }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } },
        { role: "user", content: [{ type: "text", text: userText }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } }
      ]
    }, reportUsage, (reason) => { streamFailure = describeStreamFailure(reason); }));

    if (text === undefined) {
      throw new ProfileDigestError("stream-failed", streamFailure || "llm stream aborted or errored");
    }
    const sections = parseDigest(text);
    if (!sections) {
      throw new ProfileDigestError("unparseable", "profile digest output was not a usable sections JSON object");
    }

    const generatedAt = new Date().toISOString();
    store.upsertProfileDigest({
      agentKey: key,
      sections,
      factCount: facts.length,
      factsRevision: store.profileFactsRevision(key),
      model: `${route.provider}:${route.model}`,
      generatedAt
    });
    return { agentKey: key, status: "ok", sections, factCount: facts.length, generatedAt };
  }

  return { composeFor, digestFor };
}
