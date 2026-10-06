import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { STR, langOf } from "./lang.js";
// Issue #315：蒸馏链路的 effort 降级复用巩固侧的 withEffortFallback（拒绝
// 重试一次不带 effort 字段）与 describeStreamFailure（流失败原因归一）——
// 三条链路同一降级语义，不另造第二份实现。
import { withEffortFallback, describeStreamFailure, EFFORT_REJECT_RE } from "./dream.js";

// 编码记忆蒸馏 prompt（codingRetrospect 开启时启用）：在通用记忆之外，额外提取
// 三类编码专属记忆，专治重复踩坑 / 遗忘被否决方案 / 丢失工程约束。字段仍沿用
// title/content 单列结构（store 无结构化字段），信息浓缩进 content。
/** 解析 LLM 输出中的 JSON 数组，并保留数组是否有效的结果。 */
// 蒸馏产物的事件时间锚定（SimpleMem，arXiv 2601.02553：抽取与时间锚定在同一次
// 生成里完成，消融去掉后时间类问题 F1 掉 56.7%）。归一放在解析层而不是交给
// store.normalizeOccurredAt：后者只判「可解析就 UTC ISO、否则 NULL」，拦不住模型
// 编造的未来时间——而未来时间的记忆会污染注入侧的时间排序与 memory_search 的
// occurred_from 过滤。未知/无法换算的相对时间必须整条省略字段，不能落 null。
// 纯函数：唯一外部输入是显式入参 nowMs（测试注入假时钟即可确定性复现）。
const OCCURRED_AT_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;
function normalizeDistilledOccurredAt(raw, nowMs = Date.now()) {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return undefined;
  // 容忍 1 天：模型给的绝对时间可能略晚于当下（时区/时钟偏移），超出即视为瞎填。
  if (ms - nowMs > OCCURRED_AT_FUTURE_TOLERANCE_MS) return undefined;
  try {
    return new Date(ms).toISOString();
  } catch {
    return undefined;
  }
}

function parseSummaryJsonResult(raw) {
  const text = String(raw ?? "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return { ok: false, entries: [] };
  let arr;
  let salvaged = false;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    // issue #339 / E8 实测：10-20% 的窗口输出了含记忆条目的完整对象，只因中段
    // 一处语法错误被整窗 JSON.parse 拒收；而失败路径的生产行为是游标不推进 +
    // 温度 0 重试同文同错 = 该窗口记忆静默丢失。这里做失败路径修复：括号配对
    // 扫描截出完整的顶层对象逐个 parse，救活多少算多少；截出 0 个不视为「模型
    // 显式说无内容」（那是 ok:true 专属于真实空数组的语义）。
    arr = salvageArrayItems(text.slice(start, end + 1));
    salvaged = true;
  }
  if (!Array.isArray(arr)) return { ok: false, entries: [] };
  const VALID = new Set(["preference", "project", "decision", "history", "rejected_solution", "pitfall", "constraint"]);
  const entries = arr.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      VALID.has(item.type) &&
      typeof item.title === "string" &&
      item.title.trim() &&
      typeof item.content === "string" &&
      item.content.trim()
  ).map((item) => {
    const occurredAt = normalizeDistilledOccurredAt(item.occurred_at);
    return {
      type: item.type,
      title: item.title.trim(),
      content: item.content.trim(),
      importance: Number.isInteger(item.importance) ? Math.min(5, Math.max(1, item.importance)) : 3,
      // 不可解析 / 未来时间：省略该键（不写 null、不写空串），让「模型没给」与
      // 「给了但站不住」在库里同为「无时间锚」，避免下游把空值当成已锚定。
      ...(occurredAt !== undefined ? { occurred_at: occurredAt } : {})
    };
  });
  // 空数组表示模型明确判断本轮没有可沉淀内容；非空数组若全部无效，
  // 则不能消费窗口，否则无效输出会永久推进 seq 游标。salvage 路径
  // 没有「显式空数组」可言——ok 只看是否救回了条目。
  return {
    ok: salvaged ? entries.length > 0 : (arr.length === 0 || entries.length > 0),
    entries,
    salvaged
  };
}

/**
 * Salvage scanner for malformed JSON arrays (issue #339): extracts every
 * complete top-level {...} span, parsing each independently. Two passes,
 * merged with de-duplication:
 *  - pass 1 is string-aware (handles valid objects whose string values
 *    legitimately contain braces);
 *  - pass 2 ignores string state entirely — E8 现场的坏对象带奇数个引号
 *    （stray quote），pass 1 的奇偶失配会把后续对象的收尾 } 吞进字符串里，
 *    盲扫按括号深度截取反而能救回它们。坏对象两种扫法都 parse 失败，自然
 *    被丢弃；两遍的去重靠序列化键。
 */
function salvageArrayItems(chunk) {
  const out = [];
  const seen = new Set();
  const push = (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    const key = JSON.stringify(obj);
    if (!seen.has(key)) { seen.add(key); out.push(obj); }
  };
  for (const obj of scanBraceSpans(chunk, true)) push(obj);
  for (const obj of scanBraceSpans(chunk, false)) push(obj);
  return out;
}

function scanBraceSpans(chunk, respectStrings) {
  // 修订（CodeRabbit review on #350）：只接受「最外层数组的直接子对象」——
  // 候选 { 必须满足 arrayDepth===1 && objDepth===0 且前一非空白 token 是 [ 或
  // ,。否则 (a) 嵌套子数组里的对象会被误捞成顶层记忆；(b) 盲扫遇到字符串值
  // 里的 } 会提前断 span，把属性值对象当独立记忆落库。误拦的代价只是少救回
  // （安全侧），误捞的代价是写进假记忆。
  const items = [];
  let arrayDepth = 0;
  let objDepth = 0;
  let inString = false;
  let escape = false;
  let objStart = -1;
  let prev = "";
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i];
    if (respectStrings && inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (respectStrings && ch === '"') { inString = true; continue; }
    if (ch === "[") {
      arrayDepth++;
      prev = "[";
      continue;
    }
    if (ch === "]") {
      arrayDepth = Math.max(0, arrayDepth - 1);
      prev = "]";
      continue;
    }
    if (ch === "{") {
      if (arrayDepth === 1 && objDepth === 0 && (prev === "[" || prev === ",")) {
        objStart = i;
      }
      objDepth++;
      prev = "{";
      continue;
    }
    if (ch === "}") {
      objDepth = Math.max(0, objDepth - 1);
      if (objDepth === 0 && objStart !== -1) {
        try { items.push(JSON.parse(chunk.slice(objStart, i + 1))); } catch { /* 坏对象跳过 */ }
        objStart = -1;
      }
      prev = "}";
      continue;
    }
    if (ch === ",") { prev = ","; continue; }
    if (!/\s/.test(ch)) prev = ch;
  }
  return items;
}

/** Extract a JSON array from LLM output that may contain prose around it. */
export function parseSummaryJson(raw) {
  return parseSummaryJsonResult(raw).entries;
}

// The dsh-llm StreamChunk protocol BlockAssembler.push() consumes:
// block-start {index, blockType}, text-delta {index, text},
// block-end {index, block}, finish {reason}. Some consumers observe a
// looser shape ({block} / {delta} / {kind}); normalize before pushing so
// both real adapter streams and shape-tolerant test doubles assemble.
const STREAM_CHUNK_TYPES = new Set([
  "block-start",
  "text-delta",
  "reasoning-delta",
  "tool-call-delta",
  "block-end",
  "usage",
  "finish"
]);

function toProtocolChunk(chunk) {
  switch (chunk.type) {
    case "block-start":
      return { type: "block-start", index: chunk.index ?? 0, blockType: chunk.blockType ?? chunk.block?.type ?? "text" };
    case "text-delta":
      return { type: "text-delta", index: chunk.index ?? 0, text: chunk.text ?? chunk.delta ?? "" };
    case "reasoning-delta":
      return { type: "reasoning-delta", index: chunk.index ?? 0, text: chunk.text ?? chunk.delta ?? "" };
    case "block-end":
      return { type: "block-end", index: chunk.index ?? 0, block: chunk.block ?? { type: "text" } };
    case "finish":
      return {
        type: "finish",
        reason: chunk.reason ?? { kind: chunk.kind === "error" ? "error" : "stop" },
        replayState: chunk.replayState
      };
    default:
      return chunk;
  }
}

// Only direct human prompts are summarized: plugin-injected context
// (AGENTS.md, skill bodies, file-change notices) and other machine-originated
// events must not leak into the memory store. Events without a data payload
// (minimal test doubles) pass the kind check and are handled by the content
// check below.
//
// codingRetrospect: each new distill window contains the complete available
// transcript for that window — user prompts plus assistant public replies, tool
// calls + results and code dispatch output — so the summarizer can see tool
// errors and extract pitfall root causes, not just what the user typed. The same
// filtering stays: only source.kind === "user" prompts enter (plugin/machine
// content is excluded). The result is a single text transcript passed to the
// LLM as one user message (SUMMARY_PROMPT already says "根据下面的会话内容").
//
// Privacy: assistant `reasoning` (private thought) blocks are deliberately NOT
// collected — distilled memories must never sink private reasoning chains.
// Only public text blocks (type "text") reach the summarizer.
function eventSeq(event) {
  return Number.isSafeInteger(event?.seq) ? event.seq : undefined;
}

const SUBAGENT_MESSAGE_KINDS = new Set(["agent-message", "subagent-settled"]);

// DSH 0.1.2-rc.1 起 Session 改用 snapshotEvents()，兼容旧版 .events。
// snapshotEvents 的范围参数按 seq 传入；再做一次事件级过滤，是为了兼容
// 旧实现忽略参数、或把边界解释为闭区间的情况，同时避免用数组下标充当游标。
function snapshotSessionEvents(session, afterSeq, throughSeq) {
  let events;
  if (typeof session?.snapshotEvents === "function") {
    events = afterSeq === undefined && throughSeq === undefined
      ? session.snapshotEvents()
      : session.snapshotEvents(afterSeq, throughSeq);
  } else {
    events = session?.events ?? [];
  }
  if (!Array.isArray(events)) events = session?.events ?? [];
  if (!Array.isArray(events)) return [];
  return events.filter((event) => {
    const seq = eventSeq(event);
    // 一旦已有 seq 游标，没有 seq 的事件就无法证明是新增事件，不能重新打开
    // 已经成功消费过的窗口。
    if (afterSeq !== undefined && (seq === undefined || seq <= afterSeq)) return false;
    if (throughSeq !== undefined && seq !== undefined && seq > throughSeq) return false;
    return true;
  });
}

function collectMessages(session, maxChars = 8000, language = "zh", afterSeq, throughSeq) {
  const events = snapshotSessionEvents(session, afterSeq, throughSeq);
  const lines = [];
  const seenSubagentMessages = new Set();
  // 兼容严格形状 [{type:"text",text}] 与宽松形状 ["字符串", ...]（lib-smoke 用例
  // 直接传字符串数组）。只取公开文本块；reasoning 私有推理块不进蒸馏上下文。
  const textOf = (content) => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((block) => (typeof block === "string" ? block : (block && block.type === "text" && typeof block.text === "string" ? block.text : "")))
      .filter((s) => s)
      .join("\n");
  };
  const trim = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : s);
  const trimTranscript = (s, n) => {
    if (typeof s !== "string" || s.length <= n) return s;
    if (n <= 1) return "…".slice(0, n);
    return `…${s.slice(-(n - 1))}`;
  };
  const appendSubagentMessage = (message) => {
    const kind = message?.source?.kind;
    if (!SUBAGENT_MESSAGE_KINDS.has(kind)) return;
    const text = textOf(message?.content);
    if (!text.trim()) return;
    const key = typeof message?.id === "string" && message.id
      ? `id:${message.id}`
      : `content:${kind}:${text}`;
    if (seenSubagentMessages.has(key)) return;
    seenSubagentMessages.add(key);
    lines.push(STR.transcriptAgent[language](text));
  };
  for (const event of events) {
    const data = event?.data ?? {};
    const kind = data?.source?.kind;
    switch (event.type) {
      case "user/message": {
        if (kind !== undefined && kind !== "user" && !SUBAGENT_MESSAGE_KINDS.has(kind)) break;
        const text = textOf(data?.content);
        if (!text.trim()) break;
        if (SUBAGENT_MESSAGE_KINDS.has(kind)) appendSubagentMessage(data);
        else lines.push(STR.transcriptUser[language](text));
        break;
      }
      case "agent/inbox/spliced": {
        const inserted = Array.isArray(data?.inserted) ? data.inserted : [];
        for (const message of inserted) appendSubagentMessage(message);
        break;
      }
      case "assistant/message": {
        const msg = data?.message;
        const blocks = Array.isArray(msg?.content) ? msg.content : [];
        const text = textOf(blocks);
        if (text.trim()) lines.push(STR.transcriptAssistant[language](text));
        // 私有推理块（reasoning）刻意不采集：蒸馏记忆不得沉淀模型私有思考链。
        break;
      }
      case "tool/call": {
        const args = typeof data.arguments === "string"
          ? data.arguments
          : data.arguments ? JSON.stringify(data.arguments) : "";
        lines.push(STR.transcriptToolCall[language](data.name ?? "?", trim(args, 300)));
        break;
      }
      case "tool/result": {
        // 工具结果有两种形状：旧形状把载荷与 isError 装在 content 内的
        // `type:"tool-result"` 块上；DSH 0.2.x 起内核改为直接投递 `role:"tool"`
        // 消息本身，content 里只有 `type:"text"` 块、isError 挂在消息上。只认
        // 旧块形状时新形状落进 undefined 分支，工具输出与工具报错被静默丢弃。
        const message = data?.message;
        const blocks = Array.isArray(message?.content) ? message.content : [];
        const legacy = blocks.find((block) => block?.type === "tool-result");
        const result = legacy ?? (message?.role === "tool" ? message : undefined);
        const out = textOf(result?.content);
        const status = result?.isError === true ? STR.statusFail[language] : STR.statusOk[language];
        lines.push(STR.transcriptToolResult[language](status, trim(out, 500)));
        break;
      }
      case "tool/code-dispatch": {
        const out = textOf(data.content);
        const status = data.isError === true ? STR.statusFail[language] : STR.statusOk[language];
        lines.push(STR.transcriptCode[language](status, trim(out, 500)));
        break;
      }
      default:
        break;
    }
  }
  const lastSeq = events.reduce((max, event) => {
    const seq = eventSeq(event);
    if (seq === undefined) return max;
    return max === undefined ? seq : Math.max(max, seq);
  }, undefined);
  return {
    messages: lines.length
      ? [createUserMessage({ content: [{ type: "text", text: trimTranscript(lines.join("\n"), maxChars) }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } })]
      : [],
    hasEvents: events.length > 0,
    lastSeq
  };
}

// ── 智能调速器（429 保护）─────────────────────────────────────────────
// 对话一多时 turn/end 会批量触发蒸馏，多个 LLM 请求"一拥而上"正是 429 的
// 来源。这里借鉴机场安检的思路：所有蒸馏调用进同一个全局串行队列，按间隔
// distillRateLimitIntervalMs 分批放行；命中 429 时按 distillRateLimitBaseDelayMs
// 指数退避（1s→2s→4s…）自动重试 distillRateLimitRetries 次，全程对用户透明，
// 不把 429 错误码直接抛出去。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRateLimited(error) {
  const status = error?.status ?? error?.statusCode ?? error?.response?.status;
  if (status === 429) return true;
  const msg = String(error?.message ?? error ?? "");
  return /429|rate.?limit|too many requests|请求过于频繁/i.test(msg);
}

// 全局串行链：每个蒸馏任务在前一个结束后才开始，单次失败不阻塞后续。
// 相邻请求间隔按"距上一个结束不足 intervalMs 就补齐等待"实现——单次蒸馏
// 零延迟（上次结束距今已超过间隔，直接放行），只有连续批量蒸馏才触发限速。
let distillQueue = Promise.resolve();
let lastDistillEnd = 0;
function enqueueDistill(task, intervalMs = 0) {
  const run = distillQueue.then(async () => {
    if (intervalMs > 0) {
      const wait = Math.max(0, intervalMs - (Date.now() - lastDistillEnd));
      if (wait > 0) await sleep(wait);
    }
    lastDistillEnd = Date.now();
    return task();
  });
  distillQueue = run.catch(() => {});
  return run;
}

// Issue #239（第 4 项，错峰队列）：高峰时段解析与判定已抽到独立零依赖模块
// src/peak-hours.js（PR #320 review：#316 后 summarize 反向依赖 dream，dream 镜像
// 错峰再 import 本文件会成真循环；时段调度本就不是蒸馏私有语义）。这里 re-export
// 兼容既有调用方与测试（test/summarize.test.js 从本文件 import），零改动。
// 注意 re-export 不引入本地作用域——本文件 331/387 行仍调用这两个函数，
// import + re-export 两行都要。
import { parsePeakSpec, isInPeakWindow, nextOffPeakAt } from "./peak-hours.js";
export { parsePeakSpec, isInPeakWindow, nextOffPeakAt };
export function createSummarizer(ctx, service, config, deps = {}) {
  if (!config.autoSummarize) return { dispose: () => {} };

  // Issue #239（第 4 项）：时钟与定时器可注入——排程不绑死真实时钟，测试才能确定性
  // 覆盖「高峰顺延 → 非高峰补跑」。房型同 dream/sleep.js 的注入参数。
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const setTimer = typeof deps.setTimeoutFn === "function" ? deps.setTimeoutFn : setTimeout;
  const clearTimer = typeof deps.clearTimeoutFn === "function" ? deps.clearTimeoutFn : clearTimeout;

  const inFlight = new Map();
  // Issue #127：per-session 上一次实际开跑时刻（最小间隔闸门用）。与 inFlight
  // 同生命周期，dispose 时一并清空。
  const lastRunAt = new Map();
  // Issue #239：per-session 已发起的蒸馏次数（有界检查点用）。只在实际发起 LLM
  // 调用时自增，因此被零 LLM 预判挡下的窗口不消耗预算。
  const runsUsed = new Map();
  // Issue #239（第 4 项）：每会话最多挂一个待补跑定时器（错峰队列用）；dispose 时
  // 一并清理，避免插件卸载后还留着一个会调模型的定时器。
  const deferredRuns = new Map();
  // Issue #210：只在一次蒸馏完整成功后记录已消费的最后事件 seq。
  const lastDistilledSeq = new Map();
  let disposed = false;

  /** 写一条 autoSummarize 的 LLM 审计行（审计失败绝不阻塞蒸馏本身）。 */
  function writeAudit(entry) {
    if (config?.llmAudit?.enabled === false || typeof service.saveLlmAudit !== "function") return;
    try {
      service.saveLlmAudit({
        trigger_source: "autoSummarize",
        operation_type: "summarize_compress",
        related_memory_ids: [],
        ...entry
      });
    } catch (auditError) {
      ctx.logger?.warn?.(`dsh-mneme: llm audit write failed: ${String(auditError)}`);
    }
  }

  function persistCursor(sessionId, nextSeq) {
    if (!Number.isFinite(nextSeq)) return;
    if (typeof service.setDistillCursor !== "function") {
      // 第三方宿主拿旧版 service 构造时没有持久化游标能力：降级为内存游标
      // （#274 之前的行为），本进程内不重复蒸馏，重启后窗口重放由
      // saveWithDedupe 三元组兜底。方法存在但抛错仍向上传播——那是
      // 「写失败须回滚」的恰一次语义，不能吞（见 summarize.test.js 回滚用例）。
      ctx.logger?.warn?.("dsh-mneme: service.setDistillCursor unavailable, distill cursor falls back to in-memory");
      return;
    }
    service.setDistillCursor(sessionId, nextSeq);
  }

  function commitCursor(sessionId, nextSeq) {
    persistCursor(sessionId, nextSeq);
    if (Number.isFinite(nextSeq)) lastDistilledSeq.set(sessionId, nextSeq);
  }

  /**
   * Issue #239（第 4 项）：把这一轮蒸馏推迟到最近的「高峰结束」时刻。每会话只挂
   * 一个定时器（重复触发不叠加）；被 summarizePeakMaxDeferMinutes 截断时到点照跑
   * （bypassPeak），长高峰不会把蒸馏饿死。定时器 unref——不阻止宿主退出。
   */
  function scheduleDeferredRun(session) {
    if (disposed || deferredRuns.has(session.id)) return;
    const at = nextOffPeakAt(new Date(now()), config.summarizePeakHours ?? "");
    if (!at) return;
    const maxDeferMs = (config.summarizePeakMaxDeferMinutes ?? 0) * 60000;
    let delay = Math.max(0, at.getTime() - now());
    const capped = maxDeferMs > 0 && delay > maxDeferMs;
    if (capped) delay = maxDeferMs;
    const timer = setTimer(() => {
      deferredRuns.delete(session.id);
      if (disposed) return;
      // 不传触发事件：补跑要蒸的是「累积后的整窗」（从上次成功游标到最新事件），
      // 拿老 triggerEvent 反而会把窗口卡在它那个 seq 上。
      summarize(session, undefined, { bypassPeak: capped }).catch((error) => {
        if (disposed || error?.name === "AbortError") return;
        ctx.logger?.warn?.(`dsh-mneme: deferred summarization failed: ${String(error)}`);
      });
    }, delay);
    timer?.unref?.();
    deferredRuns.set(session.id, timer);
  }

  async function summarize(session, triggerEvent, opts = {}) {
    if (disposed || inFlight.has(session.id)) return;

    const header = session.requestHeader?.()?.config;
    // Config override takes priority, then session header, then nothing.
    const route = (config.summarizeProvider && config.summarizeModel)
      ? { provider: config.summarizeProvider, model: config.summarizeModel }
      : (header?.provider && header?.model)
        ? { provider: header.provider, model: header.model }
        : undefined;

    // Issue #127 间隔门：同一会话两次蒸馏之间的最小间隔（0 = 现状，不限）。进入
    // 即打点——失败/degraded 的 run 也占用间隔，与 dreamMinIntervalMinutes 语义
    // 一致，防止失败连发。被挡下的 turn/end 静默跳过，但留一行 status='skipped'
    // 审计，否则「这一轮为什么没蒸馏」对用户完全不可观测。
    const gapMs = (config.summarizeMinIntervalMinutes ?? 0) * 60000;
    const prevClaim = lastRunAt.get(session.id);
    if (gapMs > 0 && Date.now() - (prevClaim ?? 0) < gapMs) {
      writeAudit({
        timestamp: new Date().toISOString(),
        model_id: route ? `${route.provider}:${route.model}` : "unknown",
        status: "skipped",
        error_message: "min-interval"
      });
      return;
    }
    // Issue #239（有界检查点）：每会话 run 预算。放在间隔门之后，两者都命中时
    // 先报间隔——间隔是「刚刚跑过」，预算是「额度用尽」，前者信息量更大。skip
    // 仍写审计（沿用间隔门的 error_message 口径），否则「为什么不再蒸馏了」对
    // 用户不可观测。prevRuns 在这里捕获、finally 里按 aborted 回滚（同 lastRunAt）。
    // 游标刻意不消费：预算是「这个会话先不再蒸馏了」，把窗口留在原地，日后调高
    // 额度（或宿主重启）仍能蒸馏到它；这与 window-too-small 主动消费游标相反——
    // 后者是「这些事件不值得蒸馏」，留着只会每个 turn/end 重评一次。
    // Issue #239（第 4 项，错峰队列）：高峰期不调模型——只登记一行 skip 审计并择时
    // 补跑。游标刻意不消费：窗口继续累积，留到非高峰一次性蒸馏（批量比逐轮碎蒸更
    // 省）。被 maxDefer 截断后到点仍处高峰时，由 opts.bypassPeak 放行。
    if (!opts.bypassPeak && isInPeakWindow(new Date(now()), config.summarizePeakHours ?? "")) {
      writeAudit({
        timestamp: new Date(now()).toISOString(),
        model_id: route ? `${route.provider}:${route.model}` : "unknown",
        status: "skipped",
        error_message: "peak-hours"
      });
      scheduleDeferredRun(session);
      return;
    }
    const prevRuns = runsUsed.get(session.id);
    const maxRuns = config.summarizeMaxRunsPerSession ?? 0;
    if (maxRuns > 0 && (prevRuns ?? 0) >= maxRuns) {
      writeAudit({
        timestamp: new Date().toISOString(),
        model_id: route ? `${route.provider}:${route.model}` : "unknown",
        status: "skipped",
        error_message: "max-runs-per-session"
      });
      return;
    }
    const controller = new AbortController();
    inFlight.set(session.id, controller);
    // audit state for the compression call. null = no audit for this run
    // (disabled, or no LLM call was actually made). The audit row is written in
    // the finally below — once, regardless of which exit path the call took —
    // so a failed/aborted stream still leaves a status='error' trail without
    // ever blocking the summarization itself.
    let audit = null;
    let abortedRun = false;
    try {
      if (!route) return;
      const persistedCursor = typeof service.getDistillCursor === "function"
        ? service.getDistillCursor(session.id)
        : undefined;
      const previousSeq = persistedCursor?.last_seq ?? lastDistilledSeq.get(session.id);
      const triggerSeq = eventSeq(triggerEvent);
      // 只读取上次成功游标之后、当前 turn/end 之前的事件。旧版 snapshotEvents
      // 即使忽略范围参数，collectMessages 仍会按事件 seq 二次过滤。
      const collected = collectMessages(
        session,
        config.distillMaxChars ?? 24000,
        langOf(config),
        previousSeq,
        triggerSeq
      );
      const hasNewEvents = collected.hasEvents
        || (triggerSeq !== undefined && (previousSeq === undefined || triggerSeq > previousSeq));
      if (!hasNewEvents) return;

      const nextSeq = Math.max(collected.lastSeq ?? Number.NEGATIVE_INFINITY, triggerSeq ?? Number.NEGATIVE_INFINITY);
      if (!collected.messages.length) {
        // 没有可蒸馏的公开文本也算成功消费当前事件窗口，避免每个 turn/end
        // 都重新扫描同一批无内容事件；没有 seq 时则不提交不可验证的游标。
        commitCursor(session.id, nextSeq);
        return;
      }
      const messages = collected.messages;
      // Issue #239（成本感知级联第一级）：零 LLM 预判。窗口内可蒸馏文本不足阈值
      // 时直接跳过——短窗口交给模型的产出多是泛泛而谈，代价却是一次完整调用。
      // 判定纯规则（字符数），无模型参与；被挡下的窗口照常消费游标，否则每个
      // turn/end 都会重新评估同一段短文本。skip 原因进审计，作为后续按真实负载
      // 决定下一级规则的依据。
      const minWindowChars = config.summarizeMinWindowChars ?? 0;
      if (minWindowChars > 0) {
        const distillChars = messages.reduce(
          (total, message) => total + (Array.isArray(message.content) ? message.content : [])
            .reduce((n, part) => n + (typeof part?.text === "string" ? part.text.length : 0), 0),
          0
        );
        if (distillChars < minWindowChars) {
          commitCursor(session.id, nextSeq);
          writeAudit({
            timestamp: new Date().toISOString(),
            model_id: route ? `${route.provider}:${route.model}` : "unknown",
            status: "skipped",
            error_message: "window-too-small"
          });
          return;
        }
      }
      // 只有真正准备发起一次 LLM 蒸馏时才占用最小间隔与 run 预算；失败路径仍按
      // 原语义占用（调用确实发生过），aborted 则由 finally 回滚。
      lastRunAt.set(session.id, Date.now());
      runsUsed.set(session.id, (prevRuns ?? 0) + 1);

      if (config?.llmAudit?.enabled !== false && typeof service.saveLlmAudit === "function") {
        audit = {
          route,
          timestamp: new Date().toISOString(),
          startedAt: Date.now(),
          inputTokens: 0,
          outputTokens: 0,
          status: "success",
          errorMessage: null
        };
      }

      // Issue #315：蒸馏思考强度。'none'/未配置都不发送字段（服务商默认生效，
      // 行为与历史版本一致）；off/low/medium/high 原样传递。
      const summarizeEffort = config.summarizeReasoningEffort;
      const withEffort = typeof summarizeEffort === "string" && summarizeEffort !== "none";

      // 时间锚点：转录行不带时间戳，prompt 要模型把「昨天/上周」换算成绝对
      // occurred_at，就必须给基准，否则它只能编（幻觉）。锚点取本次蒸馏触发时刻
      // （可注入 now()，测试用假时钟）；锚点行同时是 prompt 里「按提示末尾给出的
      // 当前时间换算」那句的落点，改写/移动随两处一起动。
      const distillPrompt = config.codingRetrospect ? STR.prompts.codingSummary[langOf(config)] : STR.prompts.summary[langOf(config)];
      const anchoredPrompt = `${distillPrompt}${STR.distillTimeAnchor[langOf(config)](new Date(now()).toISOString())}`;

      const options = {
        provider: route.provider,
        model: route.model,
        purpose: "summarization",
        messages: [
          { role: "system", content: [{ type: "text", text: anchoredPrompt }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } },
          ...messages
        ],
        signal: controller.signal
      };
      // 智能调速器：整段蒸馏 LLM 调用进全局串行队列，按间隔分批放行；429 时
      // 指数退避自动重试，全程对用户透明，不把 429 错误码直接抛出去。
      const intervalMs = config.distillRateLimitIntervalMs ?? 1000;
      // Issue #315：流式失败原因暂存槽。蒸馏的流失败以 aborted 结果而非 throw
      // 返回，withEffortFallback 靠它甄别「effort 被拒收」型 aborted（dream 侧
      // runNarratives 的 streamFailure 同款模式）。
      let streamFailure = "";
      const runDistill = (withEffort) => {
        streamFailure = "";
        return enqueueDistill(async () => {
        const retries = config.distillRateLimitRetries ?? 3;
        const baseDelayMs = config.distillRateLimitBaseDelayMs ?? 1000;
        // 每次尝试独立拼 effort 字段：降级重试（withEffort=false）必须真的
        // 不带 reasoningEffort，不能复用带字段的同一 options 对象。
        const callOptions = withEffort && summarizeEffort
          ? { ...options, reasoningEffort: summarizeEffort }
          : options;
        for (let attempt = 0; ; attempt++) {
          // 每次尝试重置审计状态：effort 拒收/429 的失败 attempt 会把 status 置
          // error，若后续重试成功，审计必须记录最终成功而不是残留第一次的失败
          // （否则「摘要成功但审计报失败」，污染 llm_audit_logs 统计）。
          if (audit) audit.status = "success";
          const assembler = new BlockAssembler();
          let text = "";
          let aborted = false;
          try {
            for await (const chunk of ctx.llm.stream(callOptions)) {
              if (STREAM_CHUNK_TYPES.has(chunk.type)) assembler.push(toProtocolChunk(chunk));
              if (chunk.type === "text-delta") {
                text += chunk.text ?? chunk.delta ?? "";
              }
              if (chunk.type === "usage" && audit) {
                // 同 dream.js：真实协议是 {type:"usage", usage:TokenUsage}，用量不在
                // chunk 顶层；顶层读取只作为把用量平铺的替身兜底。
                const usage = chunk.usage ?? chunk;
                const i = usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens;
                const o = usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens;
                if (Number.isFinite(i)) audit.inputTokens = i;
                if (Number.isFinite(o)) audit.outputTokens = o;
              }
              if (chunk.type === "finish") {
                const reasonKind = chunk.reason?.kind ?? chunk.kind;
                if (reasonKind === "error" || reasonKind === "aborted") {
                  // 429 也可能以 finish reason error 携带 rate-limit 信息，统一
                  // 转抛错走指数退避重试。
                  if (isRateLimited(chunk.reason ?? chunk)) {
                    throw Object.assign(new Error("rate limited"), { status: 429 });
                  }
                  // Issue #315：把失败原因原样留给外层的 effort 甄别
                  // （withEffortFallback 只认「effort 被拒收」型失败）。
                  streamFailure = describeStreamFailure(chunk.reason ?? chunk);
                  if (audit) {
                    audit.status = "error";
                    audit.errorMessage = `llm stream ${reasonKind}`;
                  }
                  aborted = true;
                  break;
                }
              }
            }
            // Direct delta accumulation is the primary extraction path (it works
            // for real protocol chunks {index,text} and looser {delta} shapes
            // alike); the assembler blocks are a fallback for streams that only
            // deliver text inside block-end. This dsh-llm exposes no public
            // no-arg assemble() — blocks() is the message-level API.
            const blocks = assembler.blocks();
            const assembledText = blocks
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("");
            return { text, assembledText, aborted };
          } catch (error) {
            if (error?.name === "AbortError" || controller.signal.aborted) throw error; // dispose 中止直接放行
            if (isRateLimited(error) && attempt < retries) {
              const delay = baseDelayMs * 2 ** attempt;
              ctx.logger?.warn?.(
                `dsh-mneme: 蒸馏请求过于频繁(429)，为避免限流等待 ${delay}ms 后自动重试（第 ${attempt + 1}/${retries} 次）`
              );
              await sleep(delay);
              continue;
            }
            // 429 重试耗尽或非 429 错误：记 audit 后抛出，保持原失败路径。
            if (audit) {
              audit.status = "error";
              audit.errorMessage = String(error?.message ?? error);
            }
            throw error;
          }
        }
      }, intervalMs);
      };
      // Issue #315：effort 被拒收时自动去掉字段重试一次（dream/sleep/entity
      // 同一降级策略，withEffortFallback 共享）。蒸馏的流失败以 aborted 结果
      // 而非 throw/undefined 返回，因此甄别在这里做：effort 型失败折叠成
      // undefined，让 withEffortFallback 走 streamFailure 甄别分支触发重试；
      // 非 effort 的 aborted 原样返回，仍走既有的 abortedRun 路径。
      const result = await withEffortFallback(
        ctx,
        summarizeEffort,
        () => runDistill(withEffort).then((r) =>
          (r?.aborted && EFFORT_REJECT_RE.test(streamFailure)) ? undefined : r),
        () => runDistill(false),
        () => streamFailure
      );
      const { text, assembledText, aborted } = result ?? { text: "", assembledText: "", aborted: true };
      if (aborted) {
        abortedRun = true;
        return;
      }
      const parsedResult = parseSummaryJsonResult(text || assembledText);
      // 解析失败不推进 seq 游标，下一次 turn/end 仍会重试同一窗口。
      if (!parsedResult.ok) {
        if (audit) {
          audit.status = "error";
          audit.errorMessage = "invalid summary JSON";
        }
        return;
      }
      const parsed = parsedResult.entries;
      // Issue #127 条数上限：0 = 不限（现状）。被截断的条数与去重命中数一并进
      // 审计 metadata——此前产出条数完全由模型输出决定，用户无从自查。
      const cap = config.summarizeMaxEntriesPerRun ?? 0;
      const entries = cap > 0 ? parsed.slice(0, cap) : parsed;
      const capped = parsed.length - entries.length;
      const dedupeMode = config.summarizeDedupeMode ?? "off";
      let deduped = 0;
      let dedupeMaxSim = 0;
      const writes = [];
      for (const entry of entries) {
        // Provenance: the summarizer runs on a real session (turn/end hook), so
        // session.id is always available here — it rides the human-readable
        // source label.
        // 编码记忆类型（codingRetrospect）不带 tag：读取侧门控/加权靠 m.type
        // （rejected_solution/pitfall/constraint）区分即可，tag 体系
        // sanitizeTags 不认 `type:` 前缀反而会清空 tags 列（额外一次 UPDATE）。
        const source = `session:${session.id}`;
        // Issue #127 落库前去重（opt-in，默认 off = 现状）：命中则并入既有条目
        // （saveWithDedupe 的 _mergeInto 分支），不再新造一行。作用域 = 同会话 +
        // 时间窗；跨会话的同类事实仍交给 autoDream / sleep 的批量裁决。
        const dup = (dedupeMode !== "off" && typeof service.findSessionDuplicate === "function")
          ? await service.findSessionDuplicate(
            { ...entry, source },
            {
              mode: dedupeMode,
              minSim: config.summarizeDedupeMinSim ?? 0.92,
              windowHours: config.summarizeDedupeWindowHours ?? 24,
              source
            }
          )
          : undefined;
        if (dup) {
          deduped++;
          dedupeMaxSim = Math.max(dedupeMaxSim, dup.sim ?? 0);
        }
        writes.push({ entry, source, dup });
      }
      if (writes.length) {
        // 查询去重目标可以异步执行，但记忆写入必须在同一个事务中完成。
        // 否则第 N 条写入失败时，前 N-1 条会残留，而重试同一 seq 窗口会重复
        // 追加它们。createService 始终提供 transaction；缺失时直接失败并保留
        // 游标窗口，避免退回到不具备原子性的部分写入。
        if (typeof service.transaction !== "function") {
          throw new Error("dsh-mneme: atomic summarization writes require service.transaction");
        }
        service.transaction(() => {
          for (const { entry, source, dup } of writes) {
            service.saveWithDedupe({
              ...entry,
              source,
              ...(dup ? { _mergeInto: dup.memory.id } : {})
            });
          }
          persistCursor(session.id, nextSeq);
        });
      } else {
        // 空数组是合法成功：没有记忆写入，但本次事件窗口仍然应被持久消费。
        persistCursor(session.id, nextSeq);
      }
      if (audit && (capped > 0 || deduped > 0 || parsedResult.salvaged)) {
        audit.metadata = {
          parsed: parsed.length,
          ...(parsedResult.salvaged ? { json_salvaged: true } : {}),
          ...(capped > 0 ? { capped } : {}),
          ...(deduped > 0 ? { deduped, mode: dedupeMode, maxSim: Number(dedupeMaxSim.toFixed(4)) } : {})
        };
      }
      // 记忆写入和解析都成功后才提交窗口；流失败、中止、解析失败或写入异常
      // 都会在此之前退出，从而保留窗口供下一次重试。
      if (Number.isFinite(nextSeq)) lastDistilledSeq.set(session.id, nextSeq);
    } catch (error) {
      if (audit) {
        audit.status = "error";
        audit.errorMessage = String(error?.message ?? error);
      }
      throw error;
    } finally {
      // Issue #127：aborted（会话关闭 / 插件 dispose）不占间隔，避免误伤该会话的
      // 下一次蒸馏；其余情况（含失败）的打点保留，与 dreamMinIntervalMinutes 一致。
      if (abortedRun || controller.signal.aborted) {
        if (prevClaim === undefined) lastRunAt.delete(session.id);
        else lastRunAt.set(session.id, prevClaim);
        // Issue #239：aborted 同样不占 run 预算——调用没有真正发生，占了会误伤
        // 该会话后续的蒸馏（与上面的间隔回滚同一口径）。
        if (prevRuns === undefined) runsUsed.delete(session.id);
        else runsUsed.set(session.id, prevRuns);
      }
      if (audit) {
        try {
          service.saveLlmAudit({
            timestamp: audit.timestamp,
            trigger_source: "autoSummarize",
            operation_type: "summarize_compress",
            model_id: `${audit.route.provider}:${audit.route.model}`,
            input_tokens: audit.inputTokens,
            output_tokens: audit.outputTokens,
            total_tokens: audit.inputTokens + audit.outputTokens,
            cost_usd: 0,
            duration_ms: Date.now() - audit.startedAt,
            status: audit.status,
            error_message: audit.errorMessage,
            related_memory_ids: [],
            // Issue #127：parsed / capped / deduped 的观测数据。零 schema 变更
            // （llm_audit_logs.metadata 已存在），一条 SQL 即可验证节流是否生效。
            metadata: audit.metadata
          });
        } catch (auditError) {
          ctx.logger?.warn?.(`dsh-mneme: llm audit write failed: ${String(auditError)}`);
        }
      }
      inFlight.delete(session.id);
    }
  }

  const unsubscribe = ctx.on("session/event", (session, event) => {
    if (disposed || event.type !== "turn/end") return;
    // Return the summarization promise so awaiters observe the writes; the
    // catch keeps listener dispatch from rejecting. Dispose-initiated aborts
    // and external AbortErrors are silent.
    return summarize(session, event).catch((error) => {
      if (disposed || error?.name === "AbortError") return;
      ctx.logger?.warn?.(`dsh-mneme: summarization failed: ${String(error)}`);
    });
  });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      for (const timer of deferredRuns.values()) clearTimer(timer);
      deferredRuns.clear();
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
      lastRunAt.clear();
      lastDistilledSeq.clear();
    }
  };
}
