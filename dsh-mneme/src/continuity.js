import { createUserMessage } from "@deepseek-ai/dsh-llm";

// #249 N3（压缩边缘双落点）：上下文即将大幅精简前，抢救「正在做什么」。
//
// 为什么是这个形状（#249 §4.4 / §6.2 / §11；维护者 2026-09-24 拍板「都同意，开工」）：
//
// 1. **必须双落点**。宿主的压缩摘要器只看对话里的内容：压缩时宿主按固定字段模板
//    重建对话，只放系统提示段的东西不进这次重建，等于白写。所以除了落库，还要把同
//    一条连续性快照追加成靠近序列末尾的消息。DSH 没有 in-memory 消息改写钩子
//    （§7 已核），因此这是「注入 + 序号引用寻址」，不是改写历史。
// 2. **落库落成提案，不落成记忆行**。边缘产出直接进 memories，长会话会攒出第 N 条
//    同主题条目（#275 记的失败形态）；转正通道与 #254 的二次确认共用一套、阶段二才
//    打开，本批只写 pending 行。
// 3. **全程不调模型**。三个字段是确定性抽取 + 截断（口径见 deriveContinuity），判定
//    也只用本地字符串比较；门控成本为零。
// 4. **触发器就是宿主真的压缩**，不自定一套阈值。宿主在 `agent/pre-step`（压力）与
//    `agent/request-error`（溢出）两处触发压缩，我们只订阅压缩事件
//    （`compaction/start|summary|end`，都在 @deepseek-ai/dsh-session 的事件白名单里
//     `lib/types/known-event-types.js:31-34`）。自定阈值会与宿主口径漂移，还多一份没
//    人校准的参数；「压缩边缘」本来就有宿主自己下的定义。
//
// 落点顺序（为什么 pre-step 里挂得住）：宿主的压缩插件在它自己的 pre-step 监听器里先
// `await compactIfNeeded(...)` 再 `return next()`，所以我们的监听器拿到 `next()` 结果
// 时压缩事件已经落库；而我们返回的 `decision.messages` 由宿主在本步末尾以
// `surfaceOp: "append"` 追加（`@deepseek-ai/dsh-agent-loop/lib/index.js:1046`），晚于
// 压缩的 `surfaceOp: "replace"`（`dsh-compaction-basic/lib/index.js:649`）——落点天然
// 在压缩之后、靠近序列末尾。两条注册顺序都成立（谁先谁后，我们的 `await next()` 都在
// 压缩工作之后返回）。

/** 提案的 kind（唯一键的一半）：一次会话里"压缩边缘"这一类只留一条。 */
export const CONTINUITY_KIND = "compaction-edge";
/** 注入消息的统一前缀：机械校验与「不变不重复」判重都靠它（#249 §6.3）。 */
export const CONTINUITY_NOTICE_PREFIX = "[dsh-mneme continuity]";
/** 单字段字符上限：抽取是截断，不是摘要（改口径不需要动调用方）。 */
export const CONTINUITY_FIELD_MAX = 200;
/** 整条注入消息的字符上限。比 §6.3 的 160B 单行提醒宽：它是结构化快照，不是一句话提醒。 */
export const CONTINUITY_NOTICE_MAX = 900;
/** 边缘表的兜底上限：只留序号、且有界——压缩完就没有下一次 pre-step 的会话不走消费路径。 */
const MAX_TRACKED_EDGES = 50;

const EDGE_EVENT_TYPES = new Set(["compaction/start", "compaction/summary", "compaction/end"]);

// 与 summarize.js 的 collectMessages 同一个口径：只取公开文本块，reasoning 私有推理
// 不进快照（快照可能被宿主重建进摘要）。刻意副本而不是导出——那边是会话蒸馏的内部
// 细节，两边取文本的理由不同。
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (typeof block === "string" ? block : (block?.type === "text" && typeof block.text === "string" ? block.text : "")))
    .filter((s) => s)
    .join("\n");
}

// DSH 0.1.2-rc.1 起 Session 用 snapshotEvents()，兼容旧版 .events。这是**全量日志**
// （append-only，含已被 surfaceOp:"replace" 折叠出表面的旧事件）——抽取要的正是全量：
// 被压缩折叠掉的最后一条真实用户消息，也曾是"正在做什么"。
function sessionEvents(session) {
  let events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : session?.events;
  // 与 summarize.js 的同名兼容层同形：snapshotEvents 不可用或返回非数组时退回 .events。
  if (!Array.isArray(events)) events = session?.events;
  return Array.isArray(events) ? events : [];
}

// 「当前表面」= `session.surface.nodes`（只存活节点的 seq，事件体在上面那份日志里）。
// 判重必须按表面而不是全量日志：旧注入还在日志里、但已被折叠出表面，照日志判重会让
// 这一次压缩后该补的注入被静默跳过——双落点的 ② 就空了一次，而日志里看不出发生过。
// 宿主没有表面投影（旧版）时退回全量：宁可少追加一次，也不在表面里重复追加同一份文本。
function surfaceEvents(session) {
  const events = sessionEvents(session);
  let nodes;
  // 宿主的 `surface.nodes` 是会抛的 getter（它自己用过、之后又被移除或替换的 message
  // projection 会让宿主内部的 `_assertProjections` 抛）。判重是锦上添花的一步：读不到就
  // 退回全量，别让一个可选的抢救功能因为读宿主状态失败而把 agent 的这一步变失败。
  try {
    nodes = session?.surface?.nodes;
  } catch {
    return events;
  }
  if (!Array.isArray(nodes)) return events;
  const inSurface = new Set(nodes);
  return events.filter((event) => inSurface.has(event?.seq));
}

/**
 * 抽取连续性三字段（纯函数、无 LLM、无副作用，供测试直接钉住口径）：
 * - `currentWork`：最近一条**真实** user/message（插件注入与子代理上报不算用户指令），
 *   取头部 CONTINUITY_FIELD_MAX 字符——"正在做什么"就是最后那条指令。
 * - `nextStep`：最近一条 assistant/message 的**尾部**同长度——"下一步"活在末尾那
 *   一段/最后一句里，取头会把开场白带进来。
 * - `openQuestions`：恒 null。确定性抽取判不出「哪些问题还没解决」，硬用反引号/问号
 *   猜会给出似是而非的字段；这个字段留给转正通道与人工补（不是所有字段都必须自动
 *   填满——宁可空着，也不编造）。空字段在注入文本里如实标 (none)。
 */
export function deriveContinuity(session, fieldMax = CONTINUITY_FIELD_MAX) {
  let currentWork = null;
  let nextStep = null;
  for (const event of sessionEvents(session)) {
    const data = event?.data ?? {};
    if (event?.type === "user/message") {
      // 只认用户自己写的：source.kind 缺省（旧事件）或 "user"。插件消息（我们自己的
      // 注入、其它插件）与子代理上报都不是"当前指令"。
      const kind = data?.source?.kind;
      if (kind !== undefined && kind !== "user") continue;
      const text = textOf(data.content).trim();
      if (text) currentWork = text.slice(0, fieldMax);
    } else if (event?.type === "assistant/message") {
      const text = textOf(data?.message?.content).trim();
      if (text) nextStep = text.slice(-fieldMax);
    }
  }
  return { currentWork, nextStep, openQuestions: null };
}

/** 单行化：字段里的换行会把「靠近末尾的一条消息」摊成多行，也破坏 §6.3 的单行约定。 */
function oneLine(text) {
  return typeof text === "string" ? text.replace(/\s*\n\s*/g, " ").trim() : "";
}

/** 渲染注入文本（纯函数）：统一前缀 + 三个固定字段（#249 §6.2）。 */
export function renderContinuityNotice(fields, noticeMax = CONTINUITY_NOTICE_MAX) {
  const body = [
    `${CONTINUITY_NOTICE_PREFIX} Context compaction happened in this session; here is the continuity snapshot ` +
      "recorded so it survives outside the transcript (a proposal — not yet in the memory store):",
    `current_work: ${oneLine(fields?.currentWork) || "(none)"}`,
    `next_step: ${oneLine(fields?.nextStep) || "(none)"}`,
    `open_questions: ${oneLine(fields?.openQuestions) || "(none)"}`
  ].join("\n");
  return body.length > noticeMax ? body.slice(0, noticeMax) : body;
}

/** 表面上是否已经有同一条注入（「不变不重复」，#249 §6.5）：按前缀 + 全文比较，
 *  不做语义判定——没有改写钩子，能做的只有"同一份文本不追加第二次"。 */
function noticeAlreadyInSurface(session, text) {
  return surfaceEvents(session).some((event) => {
    if (event?.type !== "user/message") return false;
    if (event?.data?.source?.plugin !== "dsh-mneme") return false;
    const content = textOf(event?.data?.content);
    return content === text;
  });
}

/**
 * 挂两条监听（#249 §7 的 `agent/pre-step` 触发位 + 压缩事件面），返回 { dispose }。
 *
 * `store` 直接注入：本模块只写提案表、不碰检索/嵌入，没有用到 service 的任何能力。
 * 调用方负责父／子闸门（`autoInject` + `continuityRescueEnabled`）；本函数不做开关判定，
 * 保持"挂上就是开"的单一口径。
 */
export function createContinuityRescue(ctx, store) {
  // 待处理的边缘：sessionId → 压缩事件序号。压缩事件到达时置位，下一次 pre-step 消费后
  // 删除（同一个边缘绝不注入第二次）。只留序号、不留 Session：插件在宿主进程里只 apply
  // 一次、服务所有会话，握着 Session 就是握着它的全量日志不放——压缩完就收工、不再有
  // pre-step 是常见路径，这些条目永远走不到消费路径上。
  const edge = new Map();

  const unsubscribe = ctx.on("session/event", (session, event) => {
    if (!EDGE_EVENT_TYPES.has(event?.type)) return;
    if (!session?.id) return;
    if (!edge.has(session.id) && edge.size >= MAX_TRACKED_EDGES) {
      // 兜底淘汰最旧的（Map 是插入序）：这里漏掉最坏也只少一次注入，不会无界增长。
      edge.delete(edge.keys().next().value);
    }
    // 同一轮压缩会依次落 start/summary/end，后到的覆盖前一个：留着最后一个（更有
    // 信息——summary 带摘要事件 seq），序号即触发证据。
    edge.set(session.id, typeof event.seq === "number" ? event.seq : null);
  });

  const offStep = ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    // reject 是"这一步不该发生"，往里面塞消息没有意义；未知形状原样放行。
    if (decision?.kind !== "enter") return decision;
    const session = payload?.agent?.session;
    const sessionId = session?.id;
    if (!sessionId) return decision;
    if (!edge.has(sessionId)) return decision;
    const edgeSeq = edge.get(sessionId);
    edge.delete(sessionId);

    // 抽取就地用 payload 上的这个 session（与置位时同一个 id），不从边缘表里握对象引用。
    const fields = deriveContinuity(session);
    // 落库先于注入：提案是"脱离对话独立存活"的那一半。写不进去不算宿主这一步的失败——
    // 可选插件的可选能力把 agent 的一步带崩，比丢一次抢救严重得多（本函数的不变量）。
    try {
      const saved = store.saveContinuityProposal({
        sessionId,
        kind: CONTINUITY_KIND,
        currentWork: fields.currentWork,
        nextStep: fields.nextStep,
        openQuestions: fields.openQuestions,
        edgeSeq
      });
      // 弃新是"静默失效"的那一类：不报出来，运维与 §8 的触发率口径都会把它当成没触发。
      if (saved?.dropped) {
        ctx.logger?.warn?.(`[dsh-mneme] continuity: pending queue full, dropped the edge for session ${sessionId}`);
      }
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-mneme] continuity proposal not recorded: ${String(error)}`);
    }

    const text = renderContinuityNotice(fields);
    if (noticeAlreadyInSurface(session, text)) return decision;
    const messages = Array.isArray(decision.messages) ? decision.messages : [];
    return {
      ...decision,
      messages: [
        ...messages,
        createUserMessage({ content: [{ type: "text", text }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } })
      ]
    };
  });

  return {
    dispose() {
      unsubscribe?.();
      offStep?.();
      edge.clear();
    }
  };
}
