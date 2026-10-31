// #539 逐会话无痕闸门：总开关关闭时保留既有行为；每个消费点读取同一份配置，
// 因此配置对象更新后，下一次操作即按新值判定。
export function createSessionGate(config) {
  // 已观察到的子会话 id。作用只有一个：日志扫描只拿得到一个 id 与一段**可能解析
  // 不出 header** 的帧，那时没有活会话对象可问。上限与会话日志扫描的批次无关，
  // 纯粹是防「长驻宿主跑上几百个子代理后这张表只涨不落」——本机 641 个真实会
  // 话里 455 个是子代理，不设界等于把每个子代理 id 永久留在内存里。淘汰最旧的
  // 是安全的：淘汰只影响「header 解析不出时的那次日志过滤」，活路径一律直接用
  // 会话对象判定，不查这张表。
  const MAX_TRACKED_SESSIONS = 512;
  const childSessions = new Set();

  const read = (target, key) => {
    try {
      return target?.[key];
    } catch {
      return undefined;
    }
  };

  const headerOf = (session) => {
    const header = read(session, "header");
    if (header && typeof header === "object") return header;
    try {
      const requestHeader = read(session, "requestHeader");
      const request = typeof requestHeader === "function" ? requestHeader.call(session) : null;
      const fallback = read(request, "config");
      return fallback && typeof fallback === "object" ? fallback : null;
    } catch {
      return null;
    }
  };

  /**
   * 子会话判据：**只看宿主自己的委派标记**。
   *
   * 刻意不把 `parentSession` 当判据。它是「有父会话」而不是「是子代理」：
   * `dsh-session` 的 `sessions.fork()` 造出来的**主会话分支**同样写它
   * （`@deepseek-ai/dsh-session/lib/index.js` 的 fork 只写 cwd / parentSession /
   * isSeeded，不写 origin、不写 delegationDepth），而宿主对
   * `origin` 的取值校验只有一个合法值 "subagent"。本机 641 个真实会话头实测：
   * origin/delegationDepth 命中 455 个子代理、零漏检；parentSession 对子代理
   * 识别零贡献，只额外判出 3 个 fork 出来的主会话（那些会话里各有 74–136 条
   * 用户消息、694 次工具调用，不是空壳）。把它们一起关掉 = 普通主会话突然失忆。
   *
   * `parentSessionId` 是 #539 描述的兼容别名，641 个真实头里一次都没出现过；
   * 这里同样不读——留着它当判据只会把同一个误判换个键名再犯一次。
   */
  const isChild = (session) => {
    const header = headerOf(session);
    const origin = read(header, "origin") ?? read(session, "origin");
    if (origin === "subagent") return true;
    const depth = read(header, "delegationDepth") ?? read(session, "delegationDepth");
    return Number(depth) > 0;
  };

  const idOf = (sessionOrId) => {
    if (typeof sessionOrId === "string") return sessionOrId || null;
    const id = read(sessionOrId, "id");
    return typeof id === "string" && id.length > 0 ? id : null;
  };

  const observe = (session) => {
    const id = idOf(session);
    if (!id || !isChild(session)) return;
    if (!childSessions.has(id) && childSessions.size >= MAX_TRACKED_SESSIONS) {
      // 与 src/continuity.js:193 的边缘表同一手法：Map/Set 保持插入序，淘汰最旧。
      childSessions.delete(childSessions.values().next().value);
    }
    childSessions.add(id);
  };

  const isEnabled = () => read(config, "sessionGateEnabled") === true;

  const isOff = (sessionOrId) => {
    if (!isEnabled()) return false;
    // id 只服务两件事：手动名单的精确匹配、已观察子会话的记账查询。它**不是**
    // 判定子会话的前提——#539 明写「子会话在首个 session/event 之前就可能组装
    // 上下文」，那时过去只有会话对象、未必有可用 id。以前在这里 `if (!id) return
    // false` 早退，等于把这类会话整个放过去，而下面的 isChild 本来就是为这个
    // 场景准备的。
    const id = idOf(sessionOrId);
    const sessions = read(config, "sessionGateSessions");
    if (id && Array.isArray(sessions) && sessions.includes(id)) return true;
    if (read(config, "sessionGateSubagents") === false) return false;
    if (id && childSessions.has(id)) return true;
    return typeof sessionOrId === "object" && sessionOrId !== null && isChild(sessionOrId);
  };

  return { observe, isEnabled, isOff };
}
