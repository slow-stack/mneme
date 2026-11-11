import { safeSlice } from "./safe-slice.js";
// Issue #611：图片块改用占位文本，不再落进空串（见 roundsFromEvents 里的注释）。
import { contentToText } from "./attachment-text.js";

// Session-scoped hot memory (v0.5.0 召回率优化 1.3): a short-term buffer of
// the latest dialogue rounds, kept strictly apart from the long-term memory
// store. The injector renders it ahead of the long-term recall block so the
// agent sees "what we were just talking about" without those rounds ever
// being persisted as memories. Bounded two ways: maxRounds (count) and
// maxTokens (budget) — whichever evicts first.

// CJK-aware token estimate: one Chinese character ≈ 0.6 tokens (clustering
// behavior of mainstream tokenizers), one ASCII char ≈ 0.25.
export function estimateTokens(text) {
  const s = String(text ?? "");
  let cjk = 0;
  for (const ch of s) if (ch >= "\u4e00" && ch <= "\u9fff") cjk++;
  return Math.ceil(cjk * 0.6 + (s.length - cjk) * 0.25);
}

/**
 * @param {{maxRounds?: number, maxTokens?: number}} opts
 * @returns {{add(round: {query: string, response?: string}): void,
 *            getContext(): string,
 *            rounds(): Array, clear(): void}}
 */
export function createHotMemory({ maxRounds = 5, maxTokens = 2000 } = {}) {
  const buffer = [];

  function totalTokens() {
    return buffer.reduce(
      (sum, r) => sum + estimateTokens(`Q: ${r.query}\nA: ${r.response ?? ""}`),
      0
    );
  }

  return {
    add(round) {
      if (!round?.query) return;
      buffer.push({ query: String(round.query), response: String(round.response ?? "") });
      while (buffer.length > maxRounds) buffer.shift();
      while (buffer.length > 1 && totalTokens() > maxTokens) buffer.shift();
    },
    getContext() {
      return buffer.map((r) => `Q: ${r.query}\nA: ${r.response ?? ""}`).join("\n\n");
    },
    rounds: () => [...buffer],
    clear() { buffer.length = 0; }
  };
}

// Issue：rewind（surfaceOp replace）/compact 遮蔽过的事件仍留在 append-only 事件
// 流里——热记忆若直接遍历原始流，被撤回的轮次会回流进 prompt（用户实测：一次
// 撤回 3+ 条后模型仍能复述大部分内容）。宿主在 session.surface.nodes 维护
// 「模型可见事件 seq」列表（dsh-rewind 插件即据此计算替换区间）；调用方把可见
// 集合传入本函数，只统计可见事件，热记忆与模型看到的对话因此同源。visibleSeqs
// 传 null 表示宿主未提供 surface（老版本 DSH），保持旧行为——宁可持续旧偏差，
// 绝不误删仍可见的轮次。
//
// 配对规则与 inject.js 原实现一致：user/message（source.kind 缺省或 "user"）开启
// 新一轮；下一条 assistant 起源的事件关闭该轮。tool/system 等携带正文的事件不得
// 冒充模型回复；rewind 标记（source.kind = "dsh-rewind"）不是用户提问。
//
// omitPendingRound（Issue #637）：尾部 pending 轮是「正在组装的这一轮」——它的
// 提问已经以真实 user message 出现在 prompt 里，热记忆再渲染一份只有空 `A:` 的
// 行是纯冗余；更糟的是回答落地后这一行会从空 `A:` 抖成正文，而宿主对动态
// systemPrompt context 的契约是「文本变了就追加一份快照」（旧份永久留在会话
// 历史里），于是同一轮内注入块反复变体、旧快照越积越多（报告实测 4 轮 → 10 份
// runtime-context、75% 重复率，其中记忆与设置两段是恒定的，抖动全来自热记忆）。
// 只省略尾部这一条；循环中途被新 user/message 顶掉的历史 pending 是已被放弃的
// 提问，渲染成空 `A:` 是既有语义，不动。注入侧传 true：一轮内块文本恒定，回答
// 落地时块恰好变一次 = 每轮一份快照（该机制下的理论最小值）。默认 false = 既有
// 行为逐字节不变——后台渲染与直调方（含既有测试锁的「已完成日志渲染」形状）
// 照旧拿到 pending 轮。
export function roundsFromEvents(events, maxRounds, visibleSeqs = null, { omitPendingRound = false } = {}) {
  const rounds = [];
  let pendingQuery = null;
  const textOf = (event) => {
    // user/message 的正文就在 data 上，而 assistant/message（以及 tool/result）的消息体
    // 嵌在 data.message 下 —— DSH 侧由 @deepseek-ai/dsh-session 的
    // assertMessageEventShape 一行写死：const message = type === "user/message" ? record : record?.["message"]。
    // 只读 data.content 会让每一轮的 response 恒为空（Issue #129）。
    // 这里用 ?? 兜底而不是直接改成 data.message.content：user 消息与旧的扁平形状都照旧可用。
    const parts = event?.data?.content ?? event?.data?.message?.content;
    if (!Array.isArray(parts)) return "";
    // 只取正文 part（type === "text" 或字符串），跳过 reasoning（issue #162）：
    // reasoning 里出现 Go template / Vue / Handlebars / 正则 / 日志原文的概率远高于
    // 正文，把它带进 hot memory 会让 `{{...}}` 模板片段注入 prompt。旧的扁平形状
    // （字符串 part）照旧取用，无 type 字段的兜底视为正文。
    //
    // Issue #611：图片 part 原先在这里也落进空串分支，于是「用户发了截图」这件事
    // 在 hot memory 里完全消失。改走 attachment-text 的占位口径：`[图: 名称 宽x高]`。
    // hot memory 每轮都进 prompt，占位刻意保持短——它不是描述，只是「这里有过一张
    // 图」的坐标。
    return contentToText(parts).trim();
  };
  for (const event of events) {
    // surface 投影：不在「模型可见面」上的事件（被 rewind 撤回、被 compact 替换）
    // 不参与配对。
    if (visibleSeqs && !visibleSeqs.has(event?.seq)) continue;
    const kind = event?.data?.source?.kind;
    const isUser = event?.type === "user/message" && (kind === undefined || kind === "user");
    if (isUser) {
      if (pendingQuery) rounds.push({ query: pendingQuery, response: "" });
      pendingQuery = safeSlice(textOf(event), 500);
      continue;
    }
    // Only assistant-originated events close a round; tool/system events
    // carrying text must not be mistaken for the model's reply.
    const isAssistant = typeof event?.type === "string" && event.type.includes("assistant")
      || kind === "assistant";
    const body = isAssistant ? textOf(event) : "";
    if (!body || !pendingQuery) continue;
    rounds.push({ query: pendingQuery, response: safeSlice(body, 800) });
    pendingQuery = null;
  }
  if (pendingQuery && !omitPendingRound) rounds.push({ query: pendingQuery, response: "" });
  return rounds.slice(-maxRounds);
}
