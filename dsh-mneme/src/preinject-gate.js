// Issue #380：注入前判定（preInjectGate）——意见/立场记忆先判定后处置。
//
// 为什么是注入面：E 系列收口（E13a/E13b/E13c）实测写入、巩固管理、检索预算三面
// 对内容毒均无防线，唯一过预注册判据的机制是 E12 的注入前判定（D1：FR 26.9% →
// 2.5%，−24.4pp）。判定协议用「意见/立场」框架而非「与 query 冲突」框架——E3 读数 2
// 的机制结论是 FR 跟随池内是否存在意见内容，query 相关性是更窄的目标；E2/E3 已证明
// 「给模型看标记」的整条线为负，所以处置只有一种：被标记者不注入（enforce）。
//
// 两级语义与 #254 writeAdmission 同构（enabled 观察档 / enforce 真拦截）：
//   enabled 开 + enforce 关 → 判定照跑、被标记者照常注入（仅审计，先看误杀面）
//   enabled 开 + enforce 开 → 被标记者从注入集剔除
//   两者都关（默认）        → 零 LLM 调用、零行为变化（平价锁测试）
//
// 同步约束：注入渲染是同步回调（systemPrompt contexts 不支持异步 text），判定
// 调用只能在上一轮异步预取、本轮读缓存——与 inject.js 的 queryVectorCache 同款
// 模式。首轮无缓存时降级为全量照常注入（防线失效绝不丢注入功能），判定结果对
// 下一轮生效。
import { langOf } from "./lang.js";

// 审计口径（llm_audit_logs 的既有列，write-admission.js 同款 bookkeeping）：
// trigger_source = 组件名；status='skipped' = 本行没有产生任何 LLM 花费。
export const PREINJECT_TRIGGER_SOURCE = "preInjectGate";
export const PREINJECT_OPERATION_TYPE = "preinject_gate";

// 池级判定协议（E12 口径：1 次调用判整池，不是逐条判）。输出 JSON 数组的 id 列表，
// 只标「携带意见/立场」的条目；中性事实（可验证的客观陈述）不算。
function preinjectPrompt(entries, language) {
  if (language === "en") {
    return [
      "You are the memory injection gate. Below are memory candidates (id=... | title=... | content) considered for injection into the agent's context.",
      "Identify entries that carry an OPINION or STANCE — subjective positions, endorsements, corrections asserting a claim with conviction, or pushy recommendations. Neutral, verifiable facts (preferences, decisions with context, dates, numbers) are NOT opinions.",
      'Output only a JSON array of ids that carry opinions, e.g. ["id1","id2"]. Empty array if none. No other text.'
    ].join("\n");
  }
  return [
    "你是记忆注入闸门。下面是候选注入的记忆条目（id=... | title=... | 内容）。",
    "找出携带「意见/立场」的条目——主观观点、背书、带自信断言的更正、倾向性建议。中性可验证的事实（偏好、带上下文的决策、日期、数字）不算意见。",
    "只输出携带意见的 id 的 JSON 数组，如 [\"id1\",\"id2\"]；没有则输出 []。不要输出任何其他文字。"
  ].join("\n");
}

// 条目列表的渲染：与 dream 快照行同款「id=... | title=... | 内容」格式。
function renderEntries(entries) {
  return entries
    .map((m) => `id=${m.id} | title=${m.title ?? ""} | ${String(m.content ?? "")}`)
    .join("\n");
}

// 从 LLM 回复里抽 id 数组。只认「出现在候选 id 集合里」的 id——模型编造的 id
// 直接丢弃（E13b 的 id 回显脆弱性：抄错 id 不能放大成误杀）。
function parseFlaggedIds(text, candidateIds) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return null;
    const known = new Set(candidateIds);
    const out = [];
    for (const id of arr) {
      if (typeof id === "string" && known.has(id) && !out.includes(id)) out.push(id);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * 创建注入前判定器。
 * callLLM(messages, options) => Promise<string|undefined>：与 entity extractor
 * 同款适配器合同（index.js 装配，路由解析/token 记账都在适配器里）。undefined =
 * 流失败。service 需要暴露 saveLlmAudit（llmAudit.enabled 关时适配器本就不写）。
 *
 * 返回 { prefetch, apply, dispose }：
 *   prefetch(ctx, candidates) — 渲染后异步触发下一轮的池级判定（fire-and-forget）。
 *   apply(candidates)         — 同步消费上一轮的判定缓存：enforce 时剔除被标记者。
 *   dispose()                 — 卸载时清缓存，防跨生命周期存留。
 */
export function createPreinjectGate(gateDeps) {
  // gateDeps.callLLM 按调用时读取（不解构捕获）：注入器先于 index.js 的适配器装配
  // 创建，立即取值会永远捕获 null（适配器经 setPreinjectCallLLM 后到）。
  const { service, config, logger } = gateDeps;
  const callLLMOf = () => gateDeps.callLLM;
  const language = langOf(config);
  // 每查询一份判定结果（id 数组）。有界缓存：与 inject.js 的 QUERY_VECTOR_CACHE_MAX
  // 同一上限口径，长会话不无界增长。
  const CACHE_MAX = 8;
  const verdicts = new Map(); // query -> string[] (flagged ids)
  let disposed = false;

  function cachedVerdict(query) {
    if (!query) return undefined;
    return verdicts.get(query);
  }

  function prefetch(query, candidates) {
    if (disposed || !query || !candidates?.length) return;
    if (verdicts.has(query)) return; // 同查询的重复渲染（工具调用轮）不重判
    if (typeof callLLMOf() !== "function") return;
    const candidateIds = candidates.map((m) => m.id);
    const entriesText = renderEntries(candidates);
    const prompt = preinjectPrompt(candidates, language);
    const startedAt = Date.now();
    callLLMOf()(
      [
        { role: "system", content: [{ type: "text", text: prompt }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } },
        { role: "user", content: [{ type: "text", text: entriesText }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } }
      ],
      {}
    )
      .then((text) => {
        if (disposed) return;
        // 审计行：判定即计量，与 E12 的「enabled 档先看分布」口径一致。失败
        // （text undefined / 解析失败）也落一行 status=error，可观测不过账。
        // callLLM 的适配器已写自己的流级审计行（entity adapter 同款），这里的
        // 行只补判定语义层：标记了谁、解析结果如何。related_memory_ids =
        // 被标记 id（不是候选全量——审计读数看的是「意见占比」，候选规模在
        // metadata 里）。
        const flagged = text == null ? null : parseFlaggedIds(text, candidateIds);
        const status = flagged == null ? "error" : "success";
        if (status === "success") {
          if (verdicts.size >= CACHE_MAX) verdicts.delete(verdicts.keys().next().value);
          verdicts.set(query, flagged);
        }
        try {
          if (typeof service?.saveLlmAudit === "function" && config?.llmAudit?.enabled !== false) {
            service.saveLlmAudit({
              timestamp: new Date(startedAt).toISOString(),
              trigger_source: PREINJECT_TRIGGER_SOURCE,
              operation_type: PREINJECT_OPERATION_TYPE,
              model_id: "preinject", // 路由/用量由 callLLM 适配器的审计行记账；本行是判定语义回执
              duration_ms: Date.now() - startedAt,
              status,
              error_message: flagged == null ? (text == null ? "llm stream failed" : "unparseable verdict") : null,
              related_memory_ids: flagged ?? [],
              metadata: { candidates: candidateIds.length, query_chars: query.length }
            });
          }
        } catch (e) {
          logger?.warn?.(`[dsh-mneme] preinject gate audit failed: ${String(e)}`);
        }
      })
      .catch((err) => {
        // callLLM 本身拒绝（适配器已落 error 审计行）；这里只保证不冒泡。
        logger?.warn?.(`[dsh-mneme] preinject gate failed: ${String(err)}`);
      });
  }

  function apply(query, candidates) {
    const enforce = config?.preInjectGate?.enforce === true;
    const enabled = config?.preInjectGate?.enabled === true;
    if (!enabled || !enforce || !query || !candidates?.length) return candidates;
    const flagged = cachedVerdict(query);
    // 无缓存（首轮/判定失败）= 全量放行：防线失效绝不丢注入功能（#380 口径）。
    if (!flagged || !flagged.length) return candidates;
    const flaggedSet = new Set(flagged);
    return candidates.filter((m) => !flaggedSet.has(m.id));
  }

  function dispose() {
    disposed = true;
    verdicts.clear();
  }

  return { prefetch, apply, dispose };
}

// STR 已经太大，判定 prompt 放本文件（只有本模块用）；langOf 复用。
export { preinjectPrompt, parseFlaggedIds };
