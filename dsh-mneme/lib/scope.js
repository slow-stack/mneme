// v0.8.0 A1（issue #17）：写入端 scope 解析。
//
// 身份模型（issue #17 的核心约定）：session 只是「载体」，记忆挂在持久化身份
// 标签上——agent_scope = session header 的 agentPreset（跨会话稳定的 agent 模板
// 身份），workspace_scope = 会话工作目录（registry 反查的 canonical path 优先，
// header.cwd 兜底）。session_id 永不作为作用域键。
//
// 硬约束：解析失败绝不阻塞写入——任何一步取不到就落 NULL（读侧 NULL = 未标注
// = 全局可见），任何异常都被吞掉（registry 故障 warn 一次后降级）。
//
// v0.8.1（issue #170 复核项 2）：scopeEnabled 的闸门从解析器挪到「写标注」处
// （memory_save 的 auto 分支）。解析器恒返回会话身份（真取不到才是 null）——
// 读取侧（strictVisibility / memory_get / inject）与显式声明都依赖它：flag 关
// 只关「自动标注」，不能连读取身份一起关，否则 strictScope 硬墙被静默拆掉
// （fail-open）。

/**
 * 免 inject 读取一个可选服务。cordis 4 的 ctx 是 Proxy，裸读未在 inject 声明的
 * 属性会抛 "cannot get property ... without inject"（不是返回 undefined），所以
 * 有 reflect 时优先走 ctx.reflect.get；旧宿主没有 reflect、ctx 是普通对象，裸读
 * 此时安全——与 api.js:205 / index.js:583 的 webServer 同一形状。
 *
 * 服务缺失是合法状态（headless / 旧宿主 / 服务未激活），返回 undefined 让调用方
 * 走既有降级路径，不告警：这不是故障。
 * @param {object} ctx
 * @param {string} name
 * @returns {*}
 */
function readOptionalService(ctx, name) {
  try {
    if (typeof ctx?.reflect?.get === "function") return ctx.reflect.get(name);
    return ctx?.[name];
  } catch {
    // 无 reflect 却又是 Proxy（或 accessor 自身抛错）：按「未提供」处理。
    return undefined;
  }
}

/**
 * @param {object} deps
 * @param {object} [deps.ctx] 宿主上下文（可能带 workspaceRegistry；旧版 dsh 没有）
 * @param {object} [deps.config] 已解析配置（读 scopeEnabled）
 * @param {object} [deps.logger]
 * @returns {(exec: object) => {agent_scope: string|null, workspace_scope: string|null}|null}
 */
export function createScopeResolver({ ctx, config, logger } = {}) {
  let warned = false;
  const warnOnce = (msg) => {
    if (warned) return;
    warned = true;
    try {
      logger?.warn?.(msg);
    } catch {
      // logger 自身故障同样不能影响写入路径
    }
  };

  return function resolveWriteScope(exec) {
    const session = sessionOf(exec);

    // 持久化 header（issue #17 的身份契约）：session.header 是创建时冻结的
    // SessionHeader（含 agentPreset/cwd）。⚠️ 不能先读 requestHeader()——那返回
    // EpochHeader（请求级模型路由头，首个请求后即为真值），会把 session.header
    // 遮蔽掉，agentPreset/cwd 双双取空（本地 web 复验 2026-09-13 实测踩中）。
    // 仅当宿主没有 .header 属性时才降级尝试 requestHeader().config（旧形状）。
    let header = null;
    try {
      header = session?.header ?? session?.requestHeader?.()?.config ?? null;
    } catch {
      header = null;
    }

    // header 字段的读取要各自护住：session.header 本身取得回来，不代表它的字段
    // 取得回来——宿主可以给出会抛错的 accessor（sessionOf / sessionKeyOf 就是为
    // 同一类宿主写的）。漏在这里的异常会穿出解析器，把调用方的整段写入拖挂：
    // 蒸馏路径上是一个窗口的记忆与游标一起丢，工具路径上是一次 memory_save 直接失败。
    let agentScope = null;
    try {
      const preset = header?.agentPreset;
      if (typeof preset === "string" && preset.trim()) agentScope = preset.trim();
    } catch (e) {
      warnOnce(`[dsh-mneme] session header agentPreset lookup failed: ${String(e)}`);
    }

    // workspace：registry 反查优先（成员资格 = id 命中 + header canonical cwd
    // 校验过，path 已 realpath 归一），失败回退 header.cwd，再失败留 NULL。
    //
    // issue #487：这里曾经是裸读 ctx?.workspaceRegistry，而 workspaceRegistry 不在
    // inject 声明里（index.js:45）。cordis 4 的 ctx 是 Proxy，裸读未注入属性会抛
    // "cannot get property ... without inject" 而不返回 undefined——于是这层反查
    // 从 v0.8.0 起一直抛错走降级，canonical 归一与成员资格校验静默失效，只剩
    // header.cwd。改用免 inject 读取（同 api.js:205 / index.js:583 的 webServer
    // 先例）；不加进 inject 的理由见 index.js:39-44（v0.7.23 的 apply 阶段崩溃）。
    let workspaceScope = null;
    try {
      const list = readOptionalService(ctx, "workspaceRegistry")?.list?.();
      const sessionId = session?.id;
      if (Array.isArray(list) && sessionId != null) {
        const hit = list.find(
          (ws) => Array.isArray(ws?.sessionIds) && ws.sessionIds.includes(sessionId)
        );
        if (typeof hit?.path === "string" && hit.path.trim()) workspaceScope = hit.path.trim();
      }
    } catch (e) {
      warnOnce(
        `[dsh-mneme] workspaceRegistry lookup failed, falling back to session header cwd: ${String(e)}`
      );
    }
    if (!workspaceScope) {
      try {
        const cwd = header?.cwd;
        if (typeof cwd === "string" && cwd.trim()) workspaceScope = cwd.trim();
      } catch (e) {
        warnOnce(`[dsh-mneme] session header cwd lookup failed: ${String(e)}`);
      }
    }

    return { agent_scope: agentScope, workspace_scope: workspaceScope };
  };
}

/**
 * 工具 exec 上的会话对象。宿主 ctx 是 Proxy（cordis 4），裸读未 inject 的属性会
 * 抛错——所以取值恒包在 try 里，取不到返回 null。scope 解析与写入准入的会话键
 * 共用这一处取值口径。
 * @param {object} exec
 * @returns {object|null}
 */
export function sessionOf(exec) {
  try {
    return exec?.agent?.session ?? null;
  } catch {
    return null;
  }
}

/**
 * 写入准入的会话键（#254 G1 会话写入预算的计数单位）。session_id 在这里只作
 * 「同一段对话」的标识，不作为作用域键（见文件头：记忆挂在持久化身份标签上）；
 * 取不到会话身份（系统写入）返回 null = 不进预算。
 * @param {object} exec
 * @returns {string|null}
 */
export function sessionKeyOf(exec) {
  // 整个取值（含 .id）都在 try 里：宿主 session 可能是会抛错的 accessor，而这个
  // 函数在 memory_save 的保存之前被调用——抛出去就是一次工具调用直接失败。
  try {
    const id = sessionOf(exec)?.id;
    return id == null ? null : String(id);
  } catch {
    return null;
  }
}

/**
 * v0.8.1 底座（issue #170）：显式 scope 参数（memory_save / memory_update /
 * 面板编辑）的归一化。约定：
 *   - 省略（undefined，由调用方判断）= 该维不声明，回落载体自动标注；
 *   - "global"（大小写不敏感）/ "*" / 空白 = 显式声明全局 → 存储 NULL
 *     （行上的 agent_scope_source='explicit' 承担「显式全局」与「从未标注」
 *     的区分，NULL 本身继续表示全局可见）；
 *   - 其余非空 trim 字符串 = 收窄到该标签。
 * 脏输入（非字符串）落 NULL（等同声明全局）——与 resolveWriteScope 的「解析
 * 绝不阻塞写入」同一哲学：显式声明是用户意图，形状不对时宁可放宽不报错。
 *
 * @param {unknown} raw 工具/HTTP 参数原值
 * @returns {string|null} 归一化后的标签值（null=显式全局）
 */
export function normalizeExplicitScope(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s === "*" || s.toLowerCase() === "global") return null;
  return s;
}

/**
 * scope 标注的比较键（去重键/检索加权/跨 scope 配对共用口径）：非空 trim 字符串
 * 原样返回，其余（NULL/undefined/空串/非字符串）统一为 null（「未标注」）。
 * v0.8.1（issue #170 第 2 步）从 service.js 上提为共享定义——sleep 的跨 scope
 * 候选配对必须与去重键用同一把钥匙，NULL 与已标注才不会错配。
 *
 * @param {unknown} v scope 标注原值
 * @returns {string|null} 比较键（null=未标注）
 */
export function scopeKeyOf(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * 工作区维的**比较键**（#743 评审 Major）：去掉末尾分隔符后不分大小写。
 *
 * 为什么需要它：同一个工作区标签有两条来源（registry 的 realpath、header.cwd），
 * 同一台机器上大小写与末尾斜杠都可能与另一条路写出来的不一致。此前
 * `isHardWallWorkspace` 按这个口径判名单命中，写入盖章却存原始 trim 值，读取
 * 又按字面比较——结果是「名单命中了、章也盖了，但另一个会话就是看不见这条」，
 * 而这种失效不报错。写入的章与读取的比较必须用同一把钥匙，所以两端都走这里。
 *
 * 只用于 workspace 维：agent_scope 是人给的标识符，没有「路径大小写」这回事，
 * 不动它（改了会扩大影响面而换不来正确性）。
 *
 * @param {unknown} v scope 标注原值
 * @returns {string|null} 比较键（null=未标注）
 */
export function workspaceLabelKey(v) {
  const key = scopeKeyOf(v);
  if (key === null) return null;
  return key.replace(/[\\/]+$/, "").toLowerCase();
}

/**
 * 硬墙名单命中判定（2026-11-15）。名单来自 config.scopeHardWallWorkspaces，
 * 命中的工作区写入时盖 explicit 章而不是 auto——strictScope 的硬墙只认 explicit
 * （issue #170 4.3），这是让「圈一块地」真的立起来的地方。
 *
 * 比较口径：去掉末尾分隔符后不区分大小写。理由不是洁癖——workspace_scope 的
 * 值来自两条路（registry 的 realpath、header.cwd），同一台机器上大小写与末尾
 * 斜杠都可能与用户手填的名单不一致；按字面比会让墙时灵时不灵，而这种「有时
 * 拦住有时拦不住」的失效最难被发现。
 *
 * 非字符串/空/名单为空一律 false（不命中 = 不进硬墙），保持存量行为逐字节不变。
 *
 * @param {unknown} workspaceScope 解析出来的工作区标签
 * @param {unknown} list 硬墙名单
 * @returns {boolean}
 */
export function isHardWallWorkspace(workspaceScope, list) {
  const key = scopeKeyOf(workspaceScope);
  if (key === null) return false;
  if (!Array.isArray(list) || list.length === 0) return false;
  const norm = (s) => s.replace(/[\\/]+$/, "").toLowerCase();
  const target = norm(key);
  return list.some((entry) => {
    const name = scopeKeyOf(entry);
    return name !== null && norm(name) === target;
  });
}

/**
 * 一维 scope 的盖章决定（memory_save / register_document / memory_organize /
 * 蒸馏写库共用）。四路：
 *   1. 调用方显式传了参数 → 归一化 + explicit（值可以是 null = 显式全局）；
 *   2. 未显式传、自动标注可用、且命中硬墙名单 → **explicit**；
 *   3. 未显式传、自动标注可用、未命中 → auto（存量行为）；
 *   4. 都取不到 → null（该维不加字段）。
 *
 * 第 2 路是本次新增，也是唯一有风险的一路：explicit + NULL = 全局可见，等于
 * 把墙拆了。所以解析不到非空标签时**退回落 auto**，并 warn 一次——宁可这一条
 * 软隔离，也不能盖一个空墙章。
 *
 * @param {object} p
 * @param {unknown} p.explicitValue 调用方显式传的原值（undefined = 没传）
 * @param {unknown} p.autoValue 会话自动标注解析出的值
 * @param {boolean} [p.hardWall] 是否命中硬墙名单
 * @param {(msg: string) => void} [p.warn] 硬墙落空时的告警出口
 * @returns {{value: string|null, source: "explicit"|"auto"}|null}
 */
export function resolveScopeStamp({ explicitValue, autoValue, hardWall = false, warn } = {}) {
  if (explicitValue !== undefined) {
    return { value: normalizeExplicitScope(explicitValue), source: "explicit" };
  }
  const auto = scopeKeyOf(autoValue);
  if (auto === null) return null;
  if (hardWall) {
    // 走到这里 auto 已经非空，但仍按 resolveScopeStamp 的契约再确认一次：
    // 将来有人把 scopeKeyOf 换成更宽的口径，这里不能跟着静默放宽。
    const wall = scopeKeyOf(auto);
    if (wall !== null) return { value: wall, source: "explicit" };
    try {
      warn?.("[dsh-mneme] hard-wall workspace resolved no non-empty label; falling back to auto");
    } catch {
      // 告警自身故障不能拖挂写入（同 resolveWriteScope 的硬约束）
    }
  }
  return { value: auto, source: "auto" };
}

