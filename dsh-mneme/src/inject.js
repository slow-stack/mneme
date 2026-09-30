import { createScopeResolver } from "./scope.js";
import { createHotMemory } from "./hot-memory.js";
import { STR, langOf } from "./lang.js";
import { MEMORY_GUIDE_SECTION } from "./guide.js";
import { adaptiveInjectBudget } from "./search/adaptive.js";
import { injectChildEnabled } from "./config.js";

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

// Issue #334：UTF-16 截断切开 emoji 代理对会留下孤立代理项（如 🔴 = D83D DD34
// 在 800 处切，D83D 留下、DD34 被切走）。DSH 把它序列化成非法 UTF-8，DeepSeek
// API 对每个请求回 400 INVALID_REQUEST——而且畸形文本随注入消息被永久写进会话
// 历史，此后**每一轮**都带着它，表现为会话从某一轮起连续 400、换话题/重启都不
// 恢复（会话级不可逆损坏）。防法是「少一个字符都行，绝不留半个」：尾字符是
// 高位代理（0xD800–0xDBFF）说明它的低位搭档被切走了，把这个高位代理整个丢掉。
// （反过来尾字符是低位代理不可能孤立——它的搭档必然紧邻在前、同在切点之内。）
// ASCII-only 的文本零开销（length 相等直接短路）。
function safeSlice(text, limit) {
  const s = String(text);
  if (s.length <= limit) return s;
  let cut = s.slice(0, limit);
  const tail = cut.charCodeAt(cut.length - 1);
  if (tail >= 0xd800 && tail <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

// Best-effort extraction of the current user's latest message text from the
// live session, for semantic-first injection (Bug4). The system-prompt
// interpolator renders synchronously, so this walks the already-materialized
// session event log (same event shape summarize.js consumes) and returns the
// most recent human message. Any failure degrades to "" — the injector then
// falls back to the legacy rule-based pick, never breaking the render.
function lastUserQuery(ctx) {
  try {
    const session = ctx?.agent?.session;
    // DSH ≥0.1.2-rc only exposes events via snapshotEvents(); older builds
    // still have the .events property, so fall back to it.
    const events = session?.snapshotEvents?.() ?? session?.events;
    if (!Array.isArray(events) || events.length === 0) return "";
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event?.type !== "user/message") continue;
      const kind = event.data?.source?.kind;
      if (kind !== undefined && kind !== "user") continue;
      const parts = event.data?.content;
      if (!Array.isArray(parts) || parts.length === 0) continue;
      return safeSlice(
        parts
          .map((p) => (typeof p === "string" ? p : p?.text ?? ""))
          .filter(Boolean)
          .join("\n"),
        500
      );
    }
  } catch { /* session internals unavailable: degrade to no query */ }
  return "";
}

// Hot-memory round extraction (v0.5.0 1.3): pairs each user/message with the
// next assistant reply from the materialized session log. Tolerates shapes
// where assistant events carry a different type tag — anything whose payload
// has content parts and is not a user message counts as a reply. Best-effort:
// returns [] on any failure, and the hot block simply does not render.
function extractRounds(ctx, maxRounds) {
  try {
    const session = ctx?.agent?.session;
    const events = session?.snapshotEvents?.() ?? session?.events;
    if (!Array.isArray(events) || events.length === 0) return [];
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
      return parts
        .map((p) => {
          if (typeof p === "string") return p;
          if (p?.type && p.type !== "text") return "";
          return p?.text ?? "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
    };
    for (const event of events) {
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
    if (pendingQuery) rounds.push({ query: pendingQuery, response: "" });
    return rounds.slice(-maxRounds);
  } catch {
    return [];
  }
}

export function createInjector(ctx, service, settings, config) {
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
    if (config.escapePromptVariables === false) return String(text);
    return String(text).replace(/[{}]{2,}/g, (run) => run.split("").join("\\"));
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
  const QUERY_VECTOR_CACHE_MAX = 8;
  const queryVectorCache = new Map();
  let lastPrefetched = "";

  function prefetchQueryVector(query) {
    if (!query || query === lastPrefetched || queryVectorCache.has(query)) return;
    lastPrefetched = query;
    service.embedQuery(query).then((vec) => {
      if (Array.isArray(vec) && vec.length) {
        queryVectorCache.set(query, vec);
        if (queryVectorCache.size > QUERY_VECTOR_CACHE_MAX) {
          queryVectorCache.delete(queryVectorCache.keys().next().value);
        }
      }
    }).catch(() => { /* prefetch is best-effort */ });
  }

  // User profile + rules: injected ahead of the memory block because they are
  // always-relevant instructions the agent should follow every turn.
  function renderUserSettings() {
    const profile = settings.getProfile().trim();
    const rules = settings.getRules();
    if (!profile && !rules.length) return "";
    const lines = [STR.userSettingsHeader[language]];
    if (profile) lines.push(STR.profileLine[language](profile));
    for (const rule of rules) lines.push(STR.ruleLine[language](rule));
    return escapePromptVars(lines.join("\n"));
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
    ? ctx.systemPrompt.section({ name: "memory-guide", order: 150, text: MEMORY_GUIDE_SECTION })
    : null;

  const disposers = [
    ...(guideSection ? [guideSection] : []),
    ctx.systemPrompt.context({
      name: "memory",
      order: 90,
      text: (ctx) => {
        // Bug4: pass the latest user query so injection prefers semantically
        // relevant memories; lastUserQuery is best-effort (empty → legacy).
        // The query vector is prefetched asynchronously (cached) because the
        // render itself must stay synchronous.
        const query = lastUserQuery(ctx);
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
        const candidates = service.injectCandidates({ query, queryVector, maxItems, threshold, scope, rotate, rotateWindow: rotationTurns, pinnedStats });
        // #249：pin 条目不进轮换历史——它们每轮固定前置，记进去只会占满轮换
        // 窗口、挤掉情景候选的新鲜度（验收：pin 不参与跨轮轮换）。
        recordInjection(sessionId, query, pinnedStats.shown > 0 ? candidates.slice(pinnedStats.shown) : candidates);
        // Hot memory (v0.5.0 1.3) leads the single memory block: the agent
        // sees the short-term rounds first, then the cross-session recall —
        // the documented injection order 1→2. Folding it here (instead of a
        // separate context) keeps the prompt assembly stable at two blocks.
        const hotText = renderHotContext(ctx);
        const body = render(candidates, pinnedStats);
        // #333（issue #34 恢复）：时间前缀只在会话首轮出现（per-session 闩锁），
        // 排在整个记忆块的最前——模型先知道「今天几号」，再看热上下文与长期记忆。
        const timePrefix = renderTimePrefix(ctx);
        // 拼接次序：时间 → 热上下文 → 长期记忆（三者都可能为空，逐级判空拼接）。
        const withHot = !hotText ? body : body ? `${hotText}\n\n${body}` : hotText;
        const finalBody = !timePrefix ? withHot : withHot ? `${timePrefix}\n\n${withHot}` : timePrefix;
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
          hotChars: hotText.length,
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
      text: renderUserSettings
    })
  ];

  return () => {
    queryVectorCache.clear();
    rotationHistory.clear();
    injectionSnapshot = null; // 注入器卸载即失效：快照不得跨生命周期存留
    for (const dispose of disposers) {
      if (typeof dispose === "function") dispose();
    }
  };
}
