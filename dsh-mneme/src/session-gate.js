// #539 逐会话无痕闸门：总开关关闭时保留既有行为；每个消费点读取同一份配置，
// 因此配置对象更新后，下一次操作即按新值判定。
export function createSessionGate(config) {
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

  const isChild = (session) => {
    const header = headerOf(session);
    const parent = read(session, "parentSession")
      ?? read(session, "parentSessionId")
      ?? read(header, "parentSession")
      ?? read(header, "parentSessionId");
    if (typeof parent === "string" && parent.length > 0) return true;
    return read(header, "origin") === "subagent" || Number(read(header, "delegationDepth")) > 0;
  };

  const idOf = (sessionOrId) => {
    if (typeof sessionOrId === "string") return sessionOrId || null;
    const id = read(sessionOrId, "id");
    return typeof id === "string" && id.length > 0 ? id : null;
  };

  const observe = (session) => {
    const id = idOf(session);
    if (id && isChild(session)) childSessions.add(id);
  };

  const isEnabled = () => read(config, "sessionGateEnabled") === true;

  const isOff = (sessionOrId) => {
    if (!isEnabled()) return false;
    const id = idOf(sessionOrId);
    if (!id) return false;
    const sessions = read(config, "sessionGateSessions");
    if (Array.isArray(sessions) && sessions.includes(id)) return true;
    if (read(config, "sessionGateSubagents") === false) return false;
    if (childSessions.has(id)) return true;
    return typeof sessionOrId === "object" && isChild(sessionOrId);
  };

  return { observe, isEnabled, isOff };
}
