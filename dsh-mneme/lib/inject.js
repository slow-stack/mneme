import { createScopeResolver, sessionOf } from "./scope.js";
import { createHotMemory, roundsFromEvents } from "./hot-memory.js";
import { STR, langOf } from "./lang.js";
import { escapePromptVars as escapePromptVarsWithConfig, renderUserSettingsBlock } from "./user-settings.js";
import { MEMORY_GUIDE_SECTION } from "./guide.js";
import { adaptiveInjectBudget } from "./search/adaptive.js";
import { injectChildEnabled } from "./config.js";
import { safeSlice } from "./safe-slice.js";

// Issue #179：注入预览的数据底座。systemPrompt 渲染是同步回调，面板只能事后
// 拉取，所以在这里旁路缓存「最近一帧组装」——快照就是本次渲染用过的同一份
// candidates/hotText/body，不重新检索、不二次组装，零额外开销。模块级单例：
// 注入器全局唯一（index.js 仅在 autoInject 开启时注册一个），面板经 api.js 的
// 只读 getter 读取；autoInject 关闭时注入器不存在，快照保持 null——「预览
// 不可用」本身就是「注入关闭」的诚实呈现。
let injectionSnapshot = null;
export function getInjectionSnapshot() {
  return injectionSnapshot;
}

// 「模型可见事件 seq」集合：宿主在 session.surface.nodes 维护可见面——rewind 的
// surfaceOp replace 与 compact 的隐藏替换都作用在这层（dsh-rewind 插件即据此计算
// 替换区间）。拿不到（老版本宿主）返回 null，调用方退回「全量事件」的旧行为。
// 读取必须在 try 内：`surface.nodes` 是宿主 getter，其 _assertProjections 在消息投影
// 所属插件被移除时会 throw（dsh-session lib/types/surface.js）。抛出等同于「没有
// 可见面」，绝不能让整块热记忆消失——那是比旧偏差更糟的退化。
function visibleSeqsOf(session) {
  try {
    const nodes = session?.surface?.nodes;
    return Array.isArray(nodes) ? new Set(nodes) : null;
  } catch {
    return null;
  }
}

// Best-effort extraction of the current user's latest message text from the
// live session, for semantic-first injection (Bug4). The system-prompt
// interpolator renders synchronously, so this walks the already-materialized
// session event log (same event shape summarize.js consumes) and returns the
// most recent human message. Any failure degrades to "" — the injector then
// falls back to the legacy rule-based pick, never breaking the render.
//
// v0.9.0：导出给 tools.js 的 memory_update 用。失败记录表的 query 与注入
// 候选问的是同一件事——「当时到底想干什么」；这条取原话的路只该有一份实现。
// 复制一份的代价本仓库付过几次（src/lib 平价、snapshotEvents 兼容层），所以
// 这里只加 export，不改行为。
//
// #617：多带一个 seq——注入器要拿它判断「待认领票据是否比事件流更新」（见
// createInjector 的 pendingQueries）。seq 是宿主事件序号，取不到时为 null
// （老版本宿主 / 测试夹具），调用方按 null 参与相等比较，不做真假推断。
export function lastUserMessageInfo(ctx) {
  try {
    const session = ctx?.agent?.session;
    // DSH ≥0.1.2-rc only exposes events via snapshotEvents(); older builds
    // still have the .events property, so fall back to it.
    const events = session?.snapshotEvents?.() ?? session?.events;
    if (!Array.isArray(events) || events.length === 0) return { text: "", seq: null };
    const visibleSeqs = visibleSeqsOf(session);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      // 被撤回/被压缩遮蔽的事件不算「最近一条用户消息」（与 extractRounds 同口径）。
      if (visibleSeqs && !visibleSeqs.has(event?.seq)) continue;
      if (event?.type !== "user/message") continue;
      const kind = event.data?.source?.kind;
      if (kind !== undefined && kind !== "user") continue;
      const parts = event.data?.content;
      if (!Array.isArray(parts) || parts.length === 0) continue;
      return {
        text: safeSlice(
          parts
            .map((p) => (typeof p === "string" ? p : p?.text ?? ""))
            .filter(Boolean)
            .join("\n"),
          500
        ),
        seq: event?.seq ?? null
      };
    }
  } catch { /* session internals unavailable: degrade to no query */ }
  return { text: "", seq: null };
}

export function lastUserQuery(ctx) {
  return lastUserMessageInfo(ctx).text;
}

// 认领消息 → 查询文本。#617 的补位票据就是这里算出来的字符串：判定口径与
// user/message 事件同源（content parts + source.kind），于是「插件注入的上下文」
// 这类非人类消息照样被跳过，票据不会拿插件自己的话当用户问题。
function inboxMessageQuery(message) {
  try {
    const parts = message?.content ?? message?.data?.content;
    if (!Array.isArray(parts) || parts.length === 0) return "";
    const kind = message?.source?.kind ?? message?.data?.source?.kind;
    if (kind !== undefined && kind !== "user") return "";
    return safeSlice(
      parts
        .map((p) => (typeof p === "string" ? p : p?.text ?? ""))
        .filter(Boolean)
        .join("\n"),
      500
    );
  } catch {
    return "";
  }
}

// Hot-memory round extraction (v0.5.0 1.3): pairs each user/message with the
// next assistant reply. The pairing lives in hot-memory.js (roundsFromEvents)
// so it can be unit-tested directly; this adapter only resolves the session's
// raw event log and the model-visible seq set (session.surface.nodes — see
// visibleSeqsOf). Rewind-shadowed / compacted events are thereby excluded:
// hot memory and the model see the same conversation. Best-effort: returns []
// on any failure, and the hot block simply does not render.
function extractRounds(ctx, maxRounds) {
  try {
    const session = ctx?.agent?.session;
    // DSH ≥0.1.2-rc only exposes events via snapshotEvents(); older builds
    // still have the .events property, so fall back to it.
    const events = session?.snapshotEvents?.() ?? session?.events;
    if (!Array.isArray(events) || events.length === 0) return [];
    return roundsFromEvents(events, maxRounds, visibleSeqsOf(session));
  } catch {
    return [];
  }
}

export function createInjector(ctx, service, settings, config, gate = null, sessionGate = null, choroInject = null, factsInject = null) {
  const language = langOf(config);
  const baseMaxItems = config.maxInjectedItems ?? 5;
  const threshold = config.importanceThreshold ?? 3;
  // Issue #205：注入位跨轮轮换。rotationTurns = 最近 N 个「不同用户查询」轮次
  // 注入过的记忆本轮不再优先（0 = 关闭，保持既有行为）。历史按会话维护——
  // 新会话从零开始；同一查询的多次渲染（工具调用轮）视为同一轮，不推进窗口。
  const rotationTurns = Math.max(0, Math.floor(config.injectRotationTurns ?? 0));
  const rotationHistory = new Map(); // sessionId -> [{ query, ids: Set }]
  const ROTATION_HISTORY_MAX = 32; // 覆盖 max(20) 配置档仍有余量

  function recentInjectedIds(sessionId, query) {
    if (rotationTurns <= 0) return null;
    const deque = rotationHistory.get(sessionId);
    if (!deque || deque.length === 0) return null;
    // 只看「之前的轮次」：排除与当前查询相同的条目——同一查询的重复渲染
    // （工具调用轮）不该拿本轮自己的集合来转自己。
    const prior = query ? deque.filter((e) => e.query !== query) : deque;
    if (prior.length === 0) return null;
    const recent = new Set();
    for (const entry of prior.slice(-rotationTurns)) {
      for (const id of entry.ids) recent.add(id);
    }
    return recent.size > 0 ? recent : null;
  }

  function recordInjection(sessionId, query, candidates) {
    if (rotationTurns <= 0 || !query) return;
    const deque = rotationHistory.get(sessionId) ?? [];
    const ids = new Set(candidates.map((c) => c.id));
    const last = deque[deque.length - 1];
    if (last && last.query === query) {
      last.ids = ids; // 同一查询的重复渲染：覆盖本轮内容，不推进窗口
    } else {
      deque.push({ query, ids });
      if (deque.length > ROTATION_HISTORY_MAX) deque.shift();
      rotationHistory.set(sessionId, deque);
    }
  }
  // v0.8.0 A3（issue #17）：注入路径的会话 scope 解析——strictScope 硬过滤
  // 需要。渲染 ctx 与工具 exec 同形（agent.session），解析器直接复用。
  // logger 透传：registry 反查失败时 warnOnce 才有出口。
  const resolveSessionScope = createScopeResolver({ ctx, config, logger: ctx.logger });

  // Bug6: bound the injected memory block. Each entry's content is truncated to
  // injectContentMaxChars chars (issue #164①: configurable, was a hardcoded
  // 300); a truncated entry carries a tail hint (limit / original length /
  // memory_get id) so the cut is never silent — BUDGET_EXCEEDED principle, the
  // agent can always fetch the full text. The whole block gets a block budget
  // (scales up with the per-entry cap so raising the cap is not defeated by a
  // stale 1500) and an entry that would exceed it collapses to its title only.
  const maxContent = config.injectContentMaxChars ?? 300;
  const MAX_BLOCK = Math.max(1500, maxContent + 600);
  // #249 第一批：pin 条目的正文硬顶。逐字保真不等于无界——单条上限取
  // injectContentMaxChars 与 2000 的较大者，默认档下约束/偏好不会因常规截断
  // 失真，同时给「一条超长约束每轮吃满常驻段」留一道闸（超顶仍带截断提示）。
  const PINNED_CONTENT_MAX = Math.max(maxContent, 2000);

  // Compressed injection (v0.5.0 2.1): a sleep-demoted row carries its summary in
  // `content` with the original parked in `_full_content` — inject the summary
  // verbatim instead of re-truncating the (already short) text. 但「降级过」不等于
  // 「天然够短」：原先那条 `_full_content` 早返回的唯一效果就是**跳过 maxLength**
  // （两条分支取的都是 m.content），于是 pin 的硬顶在这一路上形同不存在（#266 评审）。
  // 现在只有一条截断路径：超限照旧带提示，原文永远可通过 memory_get 取回。
  function injectMemory(m, maxLength = maxContent) {
    const text = String(m?.content ?? "");
    if (text.length <= maxLength) return text;
    return `${safeSlice(text, maxLength)}…${STR.truncatedHint[language](maxLength, text.length, m.id)}`;
  }

  // Prompt-variable brace escaping (issue #162, restored from v0.7.4 #40):
  // DSH's interpolate() scans every injected section for `{{...}}` and throws
  // unless the variable name matches /^[a-z][a-z0-9_]*$/ — memory/profile
  // content carrying legal template syntax (docker `--format "{{.Server.Version}}"`,
  // Obsidian-style `{{hl|}}`, `{{挖空}}`, `{{关键词}}`) would hit an illegal
  // variable name and throw, crashing the whole turn. At the injection boundary
  // we escape every run of 2+ consecutive braces, inserting a `\` between each
  // pair, so no `{{`/`}}` substring survives into the prompt: `{{a}}` → `{\{a\}\}`,
  // and odd runs like `{{{a}}}` (which pair-wise escaping would leave with a
  // literal `{{`) are handled too. The text keeps its readable template form,
  // the transform is idempotent (escaped braces are single + `\`, never two
  // adjacent), and single braces pass through untouched — interpolate only
  // scans `{{`. Off via config.escapePromptVariables=false (default true).
  function escapePromptVars(text) {
    // 实现搬到 src/user-settings.js：预览路由要用同一份转义，否则「注入生效文本」的
    // 预览又是第二份实现、又会漂。这里保留同名闭包，其余调用点一字不动。
    return escapePromptVarsWithConfig(config, text);
  }

  // Time-prefix injection (issue #34，恢复于 #333): opt-in, off by default.
  // When enabled the current date/time is injected once per conversation — at
  // the first prompt assembly of a new session — so the model can sense what
  // time/day it is. A per-session latch means later assemblies in the same
  // session never re-inject; a bare render ctx (no session id) falls back to
  // once per injector lifetime.
  // v0.7.11 面板大改版（ce4658e）时这段随一次批量删除被静默移除，CHANGELOG 无
  // 登记（#162 的 escapePromptVars 同刀误删、后来恢复，本函数漏了）——用户按
  // CHANGELOG 开着开关，实际什么都不会发生。本次按 v0.7.2 语义原样恢复：键名、
  // 默认值（false）、格式 `[当前时间: YYYY-MM-DD 周X HH:MM]` 全部不变，存量
  // feature_flags 里的配置恢复即生效。
  // 已注入过时间前缀的会话集合（#335 review：单值闩锁在 A→B→A 交替渲染下会
  // 重复注入）。上限 500 防长驻进程无界增长，超限逐出最早记录。
  const timePrefixDone = new Set();
  let timePrefixBare = false;

  function renderTimePrefix(ctx) {
    if (config.injectTimePrefix !== true) return "";
    const sessionId = ctx?.agent?.session?.id;
    if (sessionId === undefined) {
      if (timePrefixBare) return "";
      timePrefixBare = true;
    } else {
      if (timePrefixDone.has(sessionId)) return "";
      if (timePrefixDone.size >= 500) timePrefixDone.delete(timePrefixDone.keys().next().value);
      timePrefixDone.add(sessionId);
    }
    const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    return escapePromptVars(`[当前时间: ${date} ${WEEKDAYS[now.getDay()]} ${time}]`);
  }

  // Hot memory (v0.5.0 1.3): the latest rounds of THIS session, rebuilt from
  // the materialized event log on every render — stateless, so it survives
  // session switches and never persists anywhere.
  const hot = createHotMemory({
    maxRounds: config.hotMemoryRounds ?? 5,
    maxTokens: config.hotMemoryMaxTokens ?? 2000
  });

  function renderHotContext(ctx) {
    if (config.hotMemoryEnabled === false) return "";
    const rounds = extractRounds(ctx, config.hotMemoryRounds ?? 5);
    if (!rounds.length) return "";
    hot.clear();
    for (const r of rounds) hot.add(r);
    const body = hot.getContext();
    if (!body) return "";
    return escapePromptVars(STR.hotHeader[language](rounds.length, body));
  }

  function render(candidates, pinnedStats = null) {
    if (!candidates.length) return "";
    const header = STR.memoryHeader[language];
    const lines = [header];
    let budget = MAX_BLOCK - header.length;
    // #249 第一批：pin 池（约束/偏好）排在块头且不参与块的塌缩预算——「与情景
    // 日志抢同一份预算后被降级」正是本议题要修的结构缺陷。单条仍有硬顶
    // （PINNED_CONTENT_MAX），超出照旧带截断提示，不静默。
    const pinnedCount = Math.max(0, Math.min(candidates.length, pinnedStats?.shown ?? 0));
    // #24 块3：图召回线索行（graphHint）——引导语插在第一个线索行之前（保持块头
    // 语义：先声明「这些不是事实」）。线索行自身按 graphHintLine 渲染（线索/ 前缀
    // 区别于普通记忆行）。
    let graphSeen = 0;
    for (let i = 0; i < candidates.length; i++) {
      const m = candidates[i];
      const pinned = i < pinnedCount;
      if (m.graphHint === true) graphSeen++;
      // Epistemic trust (v0.4.5): when enabled, measured observations are
      // flagged so the agent can weigh them above guesses/opinions.
      const verified = config.trustEpistemicWeighting === true && m.epistemic_status === "observation"
        ? STR.verified[language]
        : "";
      const title = STR.entryTitle[language](m.title, m.importance);
      const content = injectMemory(m, pinned ? PINNED_CONTENT_MAX : maxContent);
      const full = m.graphHint === true
        ? STR.graphHintLine[language](m.type, title, content)
        : STR.entryLine[language](m.type, verified, title, content);
      // 线索行引导语插在第一个线索行之前（保持块头语义：先声明「这些不是事实」）。
      if (m.graphHint === true && graphSeen === 1) {
        lines.push(STR.graphHintHeader[language]);
      }
      if (pinned) {
        // pin 不扣块预算（上面那条设计注释的落地）：pin 一条就够击穿 MAX_BLOCK
        // （PINNED_CONTENT_MAX 2000 > MAX_BLOCK 1500），照扣会把 budget 压成负数，
        // 同一轮随后的普通候选全部退化成标题行——正是本议题要修的结构缺陷。
        lines.push(full);
      } else if (budget - full.length >= 0) {
        lines.push(full);
        budget -= full.length;
      } else {
        lines.push(`- [${m.type}] ${verified}${title}`);
      }
      if (pinned && i === pinnedCount - 1) {
        const hidden = Math.max(0, pinnedStats?.suppressed ?? 0);
        if (hidden > 0) lines.push(STR.pinnedOverflow[language](hidden));
      }
    }
    return escapePromptVars(lines.join("\n"));
  }

  // Bug4: the system-prompt render is synchronous, so the semantic query vector
  // must be prefetched asynchronously and cached for the next assembly. The
  // first render after a new user message may still fall back to the rule-based
  // pick; later assemblies in the same session reuse the cached vector. Bounded
  // cache (cap 8, drop oldest) so a long session never grows it unbounded.
  //
  // #617 根因 B：旧实现用一个 lastPrefetched 字符串做去重，且它在 await 之前
  // 就置位——同一条查询第一次失败（模型没下好、超时）之后**永不重试**，而那
  // 恰好是最需要重试的一次。这里换成三件套：inflight Map 去重（渲染同一步会
  // 被求值两次：assemble 一次、refreshContext 一次，同一条查询只该嵌一次）、
  // 失败冷却 15s（失败可重试，但不许每次渲染都拿一次失败去撞模型）、返回
  // Promise（调用方/测试能等到它，而不是靠魔法延时）。
  const QUERY_VECTOR_CACHE_MAX = 8;
  const PREFETCH_FAIL_COOLDOWN_MS = 15000;
  const queryVectorCache = new Map();
  const inflightPrefetches = new Map(); // query -> Promise<vector|null>
  const prefetchFailedAt = new Map(); // query -> ms

  function prefetchQueryVector(query) {
    if (!query) return null;
    const cached = queryVectorCache.get(query);
    if (cached) return Promise.resolve(cached);
    const inflight = inflightPrefetches.get(query);
    if (inflight) return inflight;
    const failedAt = prefetchFailedAt.get(query);
    if (failedAt !== undefined && Date.now() - failedAt < PREFETCH_FAIL_COOLDOWN_MS) return null;
    const pending = service.embedQuery(query).then((vec) => {
      if (Array.isArray(vec) && vec.length) {
        queryVectorCache.set(query, vec);
        if (queryVectorCache.size > QUERY_VECTOR_CACHE_MAX) {
          queryVectorCache.delete(queryVectorCache.keys().next().value);
        }
        prefetchFailedAt.delete(query);
        return vec;
      }
      prefetchFailedAt.set(query, Date.now());
      return null;
    }).catch(() => {
      prefetchFailedAt.set(query, Date.now());
      return null; /* prefetch is best-effort */
    }).finally(() => {
      inflightPrefetches.delete(query);
    });
    inflightPrefetches.set(query, pending);
    return pending;
  }

  // #617 根因 A 的补位票据：宿主（agent-loop 0.2.x）在每个 step 的 pre-step 里
  // 先 inbox.claim()（同步 emit agent/inbox/claimed），再 assemble()，而
  // user/message 要到 step() 末尾（:865）才 append——注入的 text 回调在
  // assemble / refreshContext 里求值，**永远比当轮用户输入早一拍**：Step 1 拿到
  // ""，第 N 轮的 Step 1 只能拿到第 N-1 轮的旧文本（实测 46 个渲染点错 3 次）。
  // 票据在 claim 那一刻记下原文；渲染时若事件流里最后一条用户消息还不是它，
  // 说明本轮 user/message 尚未落盘，用票据；一旦落盘，事件流才是权威（它对
  // rewind / compact 的可见面判定更准，票据不看 surface）。
  //
  // 为什么只在 claimed 上记、不从 agent/inbox/spliced 推：claim 自己的两次
  // mutate 都落 outcome:"canceled" 的 spliced（inserted 为空），拿 removedCount
  // 当撤回信号会把每次正常认领误判成取消；claimed 只在真有消息被认领时触发，
  // 是唯一无歧义的信号源。Cancel/Rewind 穿透因此也不存在——它们不产生 claimed。
  const PENDING_QUERY_MAX = 32;
  // 票据超过这个岁数就不再采信：一个 step 的 assemble 不可能跑这么久，更久说明
  // 那条消息压根没落盘（认领后整轮被取消），票据已是过期证据。
  const PENDING_QUERY_TTL_MS = 60000;
  const pendingQueries = new Map(); // sessionId -> { text, at }
  const offClaimed = typeof ctx?.on === "function"
    ? ctx.on("agent/inbox/claimed", (payload) => {
      try {
        const message = payload?.message;
        const text = inboxMessageQuery(message);
        if (!text) return;
        const session = payload?.agent?.session;
        const sessionId = session?.id;
        if (typeof sessionId !== "string" || !sessionId) return;
        pendingQueries.delete(sessionId); // 重新插入 = 移到队尾
        pendingQueries.set(sessionId, { text, at: Date.now() });
        if (pendingQueries.size > PENDING_QUERY_MAX) {
          pendingQueries.delete(pendingQueries.keys().next().value);
        }
        // 认领即预取：embed 在 assemble→step 之间就已经在跑，Step 1 的第二次
        // 求值（refreshContext）有机会拿到向量。拿不到也无妨——查询文本已经在
        // 手上，BM25 词法路（#198）能顶上。
        prefetchQueryVector(text);
      } catch { /* the ticket is best-effort; injection must never break */ }
    })
    : null;

  // 当轮查询：票据优先于事件流（见上）。判据是**文本比对**而不是事件条数——
  // 从 claim 到 assemble 之间还夹着 await tools.resolve(...)，这期间任何插件
  // 追加一个事件都会让条数增长，按条数判会把「消息还没落盘」误判成「已落盘」，
  // 票据提前退休、Step 1 又退回空串（正是本 issue 要修的那一拍）。文本相等才是
  // 「这条消息真的进事件流了」的直接证据；连续两轮同一句话时两者相等，取哪个都对。
  function liveStepQuery(ctx) {
    const info = lastUserMessageInfo(ctx);
    let sessionId = null;
    try {
      const id = ctx?.agent?.session?.id;
      if (typeof id === "string" && id) sessionId = id;
    } catch { /* session internals unavailable */ }
    if (!sessionId) return info.text;
    const ticket = pendingQueries.get(sessionId);
    if (!ticket) return info.text;
    if (info.text === ticket.text) {
      pendingQueries.delete(sessionId); // 已落盘，票据退休（顺带保证 Map 不被历史会话撑大）
      return info.text;
    }
    if (Date.now() - ticket.at > PENDING_QUERY_TTL_MS) {
      pendingQueries.delete(sessionId); // 过期证据，不采信
      return info.text;
    }
    return ticket.text;
  }

  // 会话身份解析（v1.2 人格寻址用）：读 session.header.agentPreset——冻结的
  // SessionHeader（issue #17 身份契约）。⚠️ 不能先读 requestHeader()：那返回
  // EpochHeader（请求级头，首请求后为真），会把 session.header 遮蔽掉，身份取空
  // （scope.js 同坑，本地实测踩过）。任何失败静默 → null（落 default 卡）。
  function sessionAgentId(ctx) {
    try {
      const session = ctx?.agent?.session;
      const header = session?.header ?? null;
      const preset = header?.agentPreset;
      return typeof preset === "string" && preset.trim() ? preset.trim() : null;
    } catch {
      return null;
    }
  }

  // 会话 id 解析（#606 绑会话卡用）：session.id 在宿主里稳定可用（scope.js:97-103
  // 就是靠它反查 workspace 的）。与 agentPreset 一样各自护住——两者来自同一个
  // session 对象，但 accessor 抛错时不该互相拖累（一个取不到不影响另一个）。
  // 为什么需要第二个键：DS Bot 里 agentPreset 恒为 "standard"，按 bot 建卡分不开，
  // 只有会话 id 能分开（实测见 issue #606）。
  function sessionIdOf(ctx) {
    try {
      const id = ctx?.agent?.session?.id;
      return typeof id === "string" && id.trim() ? id.trim() : null;
    } catch {
      return null;
    }
  }

  // 父会话 id 解析（子 agent 继承人格卡用）：子代理会话的 header 里有 `parentSession`
  // （实测 518 个子代理头恒带此字段，主会话没有）。⚠️ 与 `session-gate.js` 的口径不同：
  // 那里刻意不用它判「是不是子代理」（宿主 fork 出的主会话分支同样带 parentSession），
  // 这里只把它当「自己没建卡时该继承谁」的线索，fork 出的分支继承父卡同样是正确语义。
  function parentSessionIdOf(ctx) {
    try {
      const session = ctx?.agent?.session;
      const parent = session?.header?.parentSession;
      return typeof parent === "string" && parent.trim() ? parent.trim() : null;
    } catch {
      return null;
    }
  }

  // 一次取全三个寻址键。分开取值、各自兜错：一个失败不该让另一个也丢。
  function sessionIdentity(ctx) {
    return { agentId: sessionAgentId(ctx), sessionId: sessionIdOf(ctx), parentSessionId: parentSessionIdOf(ctx) };
  }

  // User profile + rules: injected ahead of the memory block because they are
  // always-relevant instructions the agent should follow every turn.
  // 渲染整体搬到 src/user-settings.js（与面板预览共用一份，见那里的模块头注释）。
  // 口径不变：双闸门（config.personaEnabled && 卡.enabled）都开时人格行在最前，
  // 画像与规则后出、后写覆盖占上风，rules 恒最硬；任一闸关着时输出与历史版本逐字节
  // 一致（老用户零变化）。personaStrictAddressing 打开时，「有身份但没建卡」与
  // 「卡被显式关掉」都不注入人格——default 只兜「这一帧解析不到身份」的会话。
  function renderUserSettings(ctx) {
    // factsInject 是 profile-facts 域的读口（index.js 接线，面板预览路由传同一份）：
    // 开关与事实有无的判定都在 renderUserSettingsBlock 内部，「关」等于零读数。
    const { agentId, sessionId, parentSessionId } = sessionIdentity(ctx);
    return renderUserSettingsBlock({ settings, config, agentId, sessionId, parentSessionId, factsProvider: factsInject })
      .text;
  }

  // #249 能力说明的系统提示段。order 150 = 插件指引段的既有惯例
  // （ACP 的 ACP_SYSTEM_PROMPT 与 mnemon 的 routing 段都在 150）。文本是常量、
  // 同会话内不随轮次变化，故不影响其后的前缀缓存，也不逐轮复读。宿主若不提供
  // section seam 就静默跳过——#249 §3 的口径是「只用现成 seam，拿不到位的语义
  // 降级处理」：能力说明仍落在工具描述上，不算失败。
  // 走父／子闸门（#249 第二批）：注入器本身只在 `autoInject` 开时挂载，这里是
  // 第二道、也是同一个判据的显式落点——两处消费点共用 injectChildEnabled，
  // 不在各自的地方重写「父关则子不生效」。
  const guideSection = injectChildEnabled(config, "injectGuidanceEnabled") && typeof ctx.systemPrompt?.section === "function"
    ? ctx.systemPrompt.section({
      name: "memory-guide",
      order: 150,
      text: (promptCtx) => (sessionGate?.isOff(sessionOf(promptCtx)) ? "" : MEMORY_GUIDE_SECTION)
    })
    : null;

  const disposers = [
    ...(guideSection ? [guideSection] : []),
    ctx.systemPrompt.context({
      name: "memory",
      order: 90,
      text: (ctx) => {
        if (sessionGate?.isOff(sessionOf(ctx))) return "";
        // Bug4: pass the latest user query so injection prefers semantically
        // relevant memories; liveStepQuery is best-effort (empty → legacy).
        // The query vector is prefetched asynchronously (cached) because the
        // render itself must stay synchronous.
        // #617：liveStepQuery 而不是 lastUserQuery——宿主在 step 末尾才 append
        // user/message，而注入在这之前求值，只看事件流会拿到上一轮的输入。
        const query = liveStepQuery(ctx);
        if (query) prefetchQueryVector(query);
        const queryVector = queryVectorCache.get(query);
        // v0.8.0 A3：scope 随请求解析（解析器恒返回对象，身份取不到时两维为
        // null）；硬过滤与软加权的门控都在 injectCandidates 内——strict 看
        // strictScope，软加权看 scopeEnabled 且至少一维可解析（issue #339）。
        const scope = resolveSessionScope(ctx);
        // Issue #205：跨轮轮换——最近 N 个查询轮次注入过的 id 本轮不再优先。
        const sessionId = ctx?.agent?.session?.id ?? "_";
        const rotate = recentInjectedIds(sessionId, query);
        // rotateWindow 随集合一起传入：候选池按 maxItems×(N+1) 扩容——窗口要的
        // 牌比既有 maxItems×2 池多时，轮换才有新鲜牌可换（#205 补测）。
        // Issue #239（第 5 项）：注入条数的查询自适应（默认关）。确定性强的话题收缩
        // 条数、模糊话题维持上限——单向收缩，绝不越过 maxInjectedItems；判据只看查询
        // 本身，不做额外检索（先探针检索等于白付一次 fuseRecall）。
        const maxItems = config.injectUncertaintyAdaptive === true
          ? adaptiveInjectBudget(query, baseMaxItems)
          : baseMaxItems;
        // #249 第一批：pin 池统计走可选出参，不动 injectCandidates 的数组契约。
        const pinnedStats = {};
        // Issue #380：注入前判定（preInjectGate）由 injectCandidates **内部**消费——
        // 判定与滤除必须发生在它的 touchRecalled / recall 记账之前（#380 评审：与
        // strictScope 同纪律，见 service.js 的「闸门还必须在 touchRecalled 之前」）。
        // pin 池（#249 逐字保真）与 graphHint 线索行豁免由 service 侧按同口径切出。
        // 渲染同步约束 → 闸门是 async prefetch + cache、同步消费：缓存命中当帧生效
        // （enforce 滤除 / observe 记账），冷缓存首帧降级为原样注入、下一轮同 key
        // 渲染生效——防线故障永不阻塞注入。帧状态经 gateStats 出参带回（同 pinnedStats
        // 的出参口径），这里只读它做面板快照。
        const gateStats = {};
        const candidates = service.injectCandidates({ query, queryVector, maxItems, threshold, scope, rotate, rotateWindow: rotationTurns, pinnedStats, gate, gateStats });
        const pinnedShown = Math.max(0, pinnedStats.shown ?? 0);
        const gateFrame = gateStats.frame ?? null;
        // #249：pin 条目不进轮换历史——它们每轮固定前置，记进去只会占满轮换
        // 窗口、挤掉情景候选的新鲜度（验收：pin 不参与跨轮轮换）。
        recordInjection(sessionId, query, pinnedShown > 0 ? candidates.slice(pinnedShown) : candidates);
        // Hot memory (v0.5.0 1.3) leads the single memory block: the agent
        // sees the short-term rounds first, then the cross-session recall —
        // the documented injection order 1→2. Folding it here (instead of a
        // separate context) keeps the prompt assembly stable at two blocks.
        const hotText = renderHotContext(ctx);
        const body = render(candidates, pinnedStats);
        // #333（issue #34 恢复）：时间前缀只在会话首轮出现（per-session 闩锁），
        // 排在整个记忆块的最前——模型先知道「今天几号」，再看热上下文与长期记忆。
        const timePrefix = renderTimePrefix(ctx);
        // M3 仓库地志（chorography）：只注标题级提纲，档位 off/light/full。
        // cwd 用 scope.workspace_scope——那是全仓唯一的 cwd 口径（registry 反查，
        // header.cwd 兜底），另读一份就是两张皮且重犯 #487 的 Proxy 陷阱（P27）。
        // 取不到 cwd / 仓库没登记 / 渲染失败一律空串：本块在热路径上，不能抛。
        const choroText = choroInject && typeof choroInject.text === "function"
          ? choroInject.text(scope?.workspace_scope ?? null)
          : "";
        // 拼接次序：时间 → 地志 → 热上下文 → 长期记忆（四者都可能为空，逐级判空）。
        // 地志排在热上下文之前：它是「这个仓库由哪些模块组成」的稳定背景，
        // 而热上下文是「刚才聊到哪」，越靠近正文越晚——稳定的在前，易变的在后。
        const withHot = !hotText ? body : body ? `${hotText}\n\n${body}` : hotText;
        const withChoro = !choroText ? withHot : withHot ? `${choroText}\n\n${withHot}` : choroText;
        const finalBody = !timePrefix ? withChoro : withChoro ? `${timePrefix}\n\n${withChoro}` : timePrefix;
        // Issue #179：旁路缓存一帧——面板「注入预览」卡据此展示构成与体积。
        // chars 为条目内容的截断后近似值（与 render 同一函数计长），totalChars
        // 是本次实际返回块的精确长度。maxItems 反映自适应收缩后的生效值。
        injectionSnapshot = {
          at: Date.now(),
          sessionId,
          query: query || "",
          maxItems,
          threshold,
          adaptive: config.injectUncertaintyAdaptive === true,
          scoped: scope && (scope.agent_scope || scope.workspace_scope) ? scope : null,
          rotated: rotate ? rotate.size : 0,
          // Issue #380：闸门状态进快照（off/pending/observed/filtered），面板
          // 「注入预览」卡据此展示判定是否生效与标记数。
          gate: gateFrame ? { state: gateFrame.state, nFlagged: gateFrame.flaggedIds ? gateFrame.flaggedIds.size : null, judged: gateFrame.judged ?? null } : null,
          hotChars: hotText.length,
          // M3：地志块实际占的字符数（0 = 本帧没注入），面板据此区分「关」与「没匹配到仓库」。
          choroChars: choroText.length,
          entries: candidates.map((m) => ({
            id: m.id,
            type: m.type,
            title: m.title,
            importance: m.importance,
            chars: injectMemory(m).length
          })),
          totalChars: finalBody.length
        };
        return finalBody;
      }
    }),
    ctx.systemPrompt.context({
      name: "user-settings",
      order: 85,
      text: (ctx) => (sessionGate?.isOff(sessionOf(ctx)) ? "" : renderUserSettings(ctx))
    })
  ];

  return () => {
    // #617：认领票据是监听宿主事件的活句柄，卸载时必须成对摘掉，否则注入器重装
    // （面板开关、宿主热重载）会留下一个继续写 Map 的孤儿监听。
    offClaimed?.();
    pendingQueries.clear();
    inflightPrefetches.clear();
    prefetchFailedAt.clear();
    queryVectorCache.clear();
    rotationHistory.clear();
    injectionSnapshot = null; // 注入器卸载即失效：快照不得跨生命周期存留
    for (const dispose of disposers) {
      if (typeof dispose === "function") dispose();
    }
  };
}
