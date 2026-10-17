/**
 * 把宿主的会话事件，翻成归属规则认得的**观察**。
 *
 * ## 为什么需要这一层（接线前实测出来的事实）
 *
 * 会话日志里的工具调用长这样：`name:"pwsh"`，`arguments:'{"command":"npm test"}'`。
 * 而工作流里人写的 `tool` 是**命令行**：`"npm test"`、`"git push <tag>"`。
 * **两者不重叠**——直接拿 `name` 去比，一条都对不上（实测 400 个会话里
 * `pwsh` 1399 次、`read` 1709 次、`glob` 183 次，而工作流写的是 npm/git/gh 命令）。
 *
 * 唯一能对上的是：**命令跑在哪个工具里**。所以这一层的职责就是把它抽出来——
 * `{name:"pwsh", arguments:{command:"npm test"}}` → `{command:"npm test"}`。
 *
 * ## 为什么只抽「命令执行器」，其余一律不给观察
 *
 * 真实工作流 19 步的 `tool` 全是 shell 命令（git / gh / npm / node）。而 `read`、`write`、
 * `glob`、`grep` 这些是**代理的日常动作**，不是任何工作流的一步。硬把
 * `read C:\…\file.js` 拼成一个「命令行」去参与匹配，只会制造噪声——而噪声的代价是
 * 把某一步凭空染色。所以认不出来命令执行器，就**不产观察**（返回 null），
 * 由上游记进 skipped 桶：**「不是工作流的动作」与「认不出是哪一步」是两件事。**
 *
 * ## 成败的三态
 *
 * `tool/result` 带 `message.isError`。只认 true/false 两个值，取不到时留 `null`
 * ——把「不知道」折叠成「失败」会给这一步打上不该有的 refuted 标记。
 */

/** 命令执行器：只有跑在这些工具里的调用，才可能是工作流写成的那种命令行。 */
const COMMAND_TOOLS = new Set(["pwsh", "bash", "sh", "shell", "cmd", "run_command", "terminal"]);

/** 参数里哪个字段是命令行。按工具名给，取不到就退回常见字段名。 */
const COMMAND_KEYS = ["command", "cmd", "script", "commandLine"];

function parseArgs(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 这次工具调用是不是一条工作流命令。是就给出命令行，不是给 `null`。
 *
 * 返回 `{tool, command}`；`command` 已去掉首尾空白（比较由归属规则负责）。
 */
export function commandFromToolCall(name, args) {
  const tool = typeof name === "string" ? name.trim() : "";
  if (tool === "" || !COMMAND_TOOLS.has(tool.toLowerCase())) return null;
  const parsed = parseArgs(args);
  if (!parsed) return null;
  for (const key of COMMAND_KEYS) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim() !== "") {
      return { tool, command: value.trim() };
    }
  }
  // 是命令执行器但参数里没有命令行（形状变了）：不猜，给 null。
  return null;
}

/** `tool/result` 的成败：只认布尔，拿不到留 null（「不知道」不许折叠成「失败」）。 */
export function outcomeOfToolResult(event) {
  const message = event?.data?.message;
  if (!message || typeof message !== "object") return null;
  if (message.isError === true) return false;
  if (message.isError === false) return true;
  // 旧形状把 isError 挂在 content 的 tool-result 块上；两种都不认时留 null。
  const blocks = Array.isArray(message.content) ? message.content : [];
  const legacy = blocks.find((b) => b && b.type === "tool-result");
  if (legacy && typeof legacy.isError === "boolean") return legacy.isError !== true;
  return null;
}

/**
 * 把一串会话事件配对成观察列表（纯函数，便于测试与批处理）。
 *
 * 配对靠 `callId`：`tool/call` 先到、`tool/result` 后到。**只有拿到结果的调用才产观察**
 * ——结果决定了成败，而「调了但没结果」既不是成功也不是失败（可能被中断），
 * 拿它当一次成功使用是编造。
 *
 * 另外两条纪律：
 * - 认不出命令执行器的调用**直接丢**（进 `notCommands` 计数），不产观察
 * - 有调用没结果的，如实进 `dangling`，不产观察也不假装失败
 */
export function pairObservations(events) {
  const pending = new Map(); // callId -> {tool, command, at}
  const observations = [];
  const dangling = [];
  let notCommands = 0;

  for (const event of events || []) {
    const type = event?.type;
    if (type === "tool/call") {
      const data = event.data ?? {};
      const extracted = commandFromToolCall(data.name, data.arguments);
      if (!extracted) {
        notCommands += 1;
        continue;
      }
      const callId = data.callId ?? null;
      const entry = { ...extracted, at: event.at ?? null };
      if (callId === null) {
        // 没有 callId 就无法配对結果；不硬凑，如实记下。
        dangling.push({ ...entry, why: "调用没有 callId，无法与结果配对" });
        continue;
      }
      pending.set(callId, entry);
      continue;
    }

    if (type === "tool/result") {
      const callId = event?.data?.callId ?? event?.callId ?? null;
      if (callId === null || !pending.has(callId)) continue;
      const entry = pending.get(callId);
      pending.delete(callId);
      observations.push({
        tool: entry.tool,
        command: entry.command,
        ok: outcomeOfToolResult(event),
        at: entry.at
      });
    }
  }

  for (const entry of pending.values()) dangling.push({ ...entry, why: "调用没有等到结果" });

  return { observations, dangling, notCommands };
}
