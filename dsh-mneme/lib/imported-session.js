// 「这条会话是导入器写的」判据的唯一定义处。
//
// 单独成文件、且不 import 任何别的东西：两个消费方的冷热差别很大——回填
// （src/backfill.js）本来就要拉 fs 与 session-usage，而蒸馏（src/summarize.js）
// 在每一轮 turn/end 都被调用。判定函数不该把整条扫描链带进热路径。

/** 导入器给每条 assistant 消息盖的 provider 戳（插件 lib/index.js:181-185、621-633）。 */
export const IMPORT_PROVIDER = "deepseek-chat-export";
/** 导入器给「这条回复进不了模型历史」的会话留的错误码前缀（插件 lib/index.js:191-195）。 */
export const IMPORT_ERROR_PREFIX = "DEEPSEEK_EXPORT_";

/**
 * 这一组事件是不是导入器写的会话。
 *
 * **纯函数**：输入事件数组，输出 bool，不读盘、不看状态。以后 DSH 改了戳法，
 * 只改这一个函数（与它的一条测试），不用翻扫描循环。
 *
 * 两条信号取并集，主判据是消息 source（DSH 自己从不产生这个 provider 字符串）；
 * `turn/end` 的错误码只用来兜「整条会话的回复全被排除、一条 assistant/message
 * 都没有」的那种会话（TEMPLATE_RESPONSE / EMPTY_REPLY / NO_REPLY / WIP /
 * FAILED / TIMEOUT / CONTEXT_LENGTH_EXCEEDED / INCOMPLETE）。
 *
 * 不用 header、不用 session/title：前者没有标记，后者正常会话同样有。
 */
export function isImportedSession(events) {
  if (!Array.isArray(events)) return false;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.type === "assistant/message") {
      const provider = event.data?.message?.source?.provider;
      if (provider === IMPORT_PROVIDER) return true;
      continue;
    }
    if (event.type === "turn/end") {
      const code = event.data?.reason?.error?.code;
      if (typeof code === "string" && code.startsWith(IMPORT_ERROR_PREFIX)) return true;
    }
  }
  return false;
}