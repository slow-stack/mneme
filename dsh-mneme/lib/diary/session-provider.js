/**
 * 素材来源之二：当前会话自己的转录（**主来源**）。
 *
 * 需求原话是「与人格注入绑定，当前的拥有人格的 agent 写日记」——那就意味着日记的
 * 素材首先得是**这个 agent 自己这一天经历过的对话**，而不是 QQ 收件箱里别人的消息。
 * QQ inbox 只是没有会话上下文时（启动补写）的兜底来源。
 *
 * 口径与 summarize.js 的蒸馏转录**刻意同源**（那里已把隐私边界定完，不重写第二份）：
 * - 只认 `user/message` 与 `assistant/message`；
 * - 机器注入内容（AGENTS.md、skill 正文、文件变更通知）按 `source.kind` 挡掉；
 * - assistant 的 reasoning 私有思考块不采集（textOf 只认 `type:"text"`）；
 * - 工具调用/结果不进日记（那是过程，不是这一天发生的事）。
 *
 * 这个模块是纯的：会话对象由调用方给，时间由事件带，不读盘、不联网、不碰 ctx。
 */
import { localDateString } from "./rollover.js";
import { redactDigits } from "./qq-inbox.js";

/** 单条消息进 prompt 的上限：一条超长粘贴不该把整篇日记的预算吃掉。 */
export const MAX_ITEM_CHARS = 1200;

/**
 * 会话身份（决定用哪张人格卡）。与 `src/inject.js:311-336` 同一口径。
 *
 * ⚠️ 不能先读 `requestHeader()`：那返回的是请求级模型路由头，会把 `agentPreset`
 * 遮蔽成空（scope.js 里记着本地 web 实测踩中过）。身份只在 `session.header` 里。
 */
export function sessionAgentId(session) {
  try {
    const header = session?.header ?? null;
    const preset = header?.agentPreset;
    return typeof preset === "string" && preset.trim() ? preset.trim() : null;
  } catch {
    return null;
  }
}

/** 会话事件里可选的时间字段。三个都试是因为宿主各版本用过不同的名字。 */
function eventTimeMs(event) {
  for (const key of ["at", "time", "ts"]) {
    const v = event?.[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim()) {
      const parsed = Date.parse(v);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (typeof block === "string" ? block : block && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** 事件里有没有**可公开的会话正文**。与 summarize.js 的 publicTranscriptParts 同一套判据。 */
function bodyOf(event) {
  const data = event?.data ?? {};
  const kind = data?.source?.kind;
  if (event?.type === "user/message") {
    // 机器注入内容（kind 非 user）不进素材：那不是「你们今天聊的」。
    if (kind !== undefined && kind !== "user") return null;
    const text = textOf(data?.content).trim();
    return text ? { role: "user", text } : null;
  }
  if (event?.type === "assistant/message") {
    const text = textOf(data?.message?.content).trim();
    return text ? { role: "assistant", text } : null;
  }
  return null;
}

/**
 * 采当前会话的转录。
 *
 * `dateLocal` 为 null 时取**全部**事件（手动按钮的语义：「就把现在这段写下来」，
 * 不按自然日切）。给日期时只留那一天的事件——事件没有时间戳的一律丢弃：无法证明
 * 它属于今天，就不能把它写进今天。
 *
 * 返回 `{items, scanned, ignored}`（items 可以为空）或 `{error}`。
 */
export function collectSessionTranscript({ session, dateLocal = null, maxItems = 400, maxChars = MAX_ITEM_CHARS } = {}) {
  if (!session) return { error: "no-session" };
  let events = null;
  try {
    events = typeof session.snapshotEvents === "function" ? session.snapshotEvents() : session.events;
  } catch {
    events = session?.events ?? null;
  }
  if (!Array.isArray(events)) return { error: "session-unreadable" };

  const items = [];
  let scanned = 0;
  let ignored = 0;
  for (const event of events) {
    const body = bodyOf(event);
    if (!body) {
      // 工具调用/系统事件占了绝对多数，数进 ignored 会让「忽略」这个词失真。
      // 只把它们跳过，不计入 ignored。
      continue;
    }
    scanned += 1;
    const ts = eventTimeMs(event);
    if (dateLocal !== null && dateLocal !== undefined) {
      if (ts === null || localDateString(new Date(ts)) !== dateLocal) {
        // 别的日子不算「忽略」，无时间戳才算读不懂。
        if (ts === null) ignored += 1;
        continue;
      }
    }
    items.push({
      ts,
      role: body.role,
      text: redactDigits(body.text).slice(0, maxChars)
    });
  }
  return { items: items.slice(-maxItems), scanned, ignored };
}
