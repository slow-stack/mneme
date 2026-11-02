// 记忆级溯源读出口的 HTTP 口径 —— 唯一实现。
//
// 为什么要单独一个模块：这张脸有两个入口——宿主内的面板路由（src/api.js 的
// /api/dsh-mneme/memory/provenance）与 Bearer 数据面（src/api-standalone.js 的
// /memory/provenance）。两者底下是同一份 service（provenanceFor + distillWindowsFor
// + distillRecordsFor），差别只在鉴权与路径。历史上（#509 第一版）它们是整段复制的，
// 于是「改一边忘一边」在结构上就可能发生——#411 已经为 reclaim / share 各踩过一次，
// 本模块照那次的结论办。
//
// 口径（错误码、两种「空」的区分、窗口形状、上限）现在只写在这里，两个入口都调它。
// 真要再写第二份，test/provenance-http.test.js 的静态锁会直接转红。
//
// 这里只做协议层的事：解析入参、判开关、组装窗口、区分「用户关了」「没接线」与
// 「没有来源」。一行数据都不改——读取在 src/store.js，透传在 src/service.js。
//
// 两个读方向（#421 拆成两条，方向 1 由 #509 交付、方向 2 由 #524 补上）：
//   memory: ?id=<memoryId>     一条记忆 → 派生它的那些蒸馏窗口
//   session: ?sessionId=<sid>  一个会话 → 它产出的那些蒸馏窗口
// 两个主键互斥（都缺 400、都给 400）。共用同一条路径是有意的：多一条路径就多一处
// 要登记的地方（SECURITY.md 两张表、README 路由表、security-doc 的清单锁），而这两
// 个方向读的是**同一批数据**，只是入口不同。
//
// 状态码阶梯（自前而后，先匹配的先回）：
//   401 未鉴权      ——两个壳各自的门（api.js 的 register 包装 / standalone 的
//                     isAuthorized），在本模块之前，不在这里重复。
//   400 缺参/多参   ——语法畸形，与服务端状态无关，所以排在功能开关之前；与
//                     reclaim 的 invalid-json 同档（reclaim-http.js:30-33 立的是
//                     「503 要赢过**字段校验**的 400」，缺参不是字段校验而是请求
//                     本身不成立，所以不适用那条）。判断在壳里
//                     （parseProvenanceSelector），走到本模块时选择器一定成型。
//                     limit 越界属**语义类** 400，按上面那条口径仍排在接线检查之前
//                     ——它是入参本身的形状问题，不是「服务端现在能不能读」。
//   409 功能关了    ——distillRecords.enabled !== true。回的是「端点的属性」，
//                     与 src/api.js:525 的 profileExtractEnabled 同构：用户关了
//                     某功能 = 409，装配坏了 = 503，两者必须是可区分的答案
//                     （src/index.js:589-591 的设计原话）。
//   503 装配没接线  ——service 上缺该方向要用的方法（按选择器分方向判，见
//                     REQUIRED_METHODS：只缺 session 那侧的方法时，memory 查询
//                     仍然该能用）。
//   读（200 / 500）
// 刻意不用 404：本端点永远不就「这条记忆/这个会话是否存在」作断言（缺参是 400、
// 未知 id 是 200 + 空 windows），404 在本仓另有稳定含义——未知路由与资源不存在
// （src/api-standalone.js:506/515、src/api.js:1367/1445）。把「功能关了」塞进
// 404，调用方会在状态码这个唯一被代理 / 监控 / 重试逻辑读取的通道上，把它读成
// 「这条记忆不存在」。

/**
 * 「溯源能力没接线」的错误码。headless / 旧装配下 service 上没有本方向要用的方法，
 * 那是装配坏了，不是「这条记忆没有来源」——两种空必须分开读数，
 * 否则调用方看到一个空 windows 会以为拿到了答案。
 */
export const PROVENANCE_UNAVAILABLE = "provenance-unavailable";

/**
 * 「用户把蒸馏原文留存关掉了」的错误码。distillRecords.enabled 既是写侧的总闸
 * （src/summarize.js:988）也是本读出口的总闸（#509 评审整改）：关着时盘上可能
 * 还有历史原文（保留期裁剪与写入同在 src/index.js:270 一道门里），但本端点不再
 * 把它们读出去。与 api.js:525 的 "disabled" 分开：那个面只有一个功能开关，本仓
 * 数据面上会有多个，特定码才让调用方分得清是哪一个被关。
 */
export const DISTILL_RECORDS_DISABLED = "distill-records-disabled";

/**
 * 一次答复最多带几个窗口。缺省 20。
 *
 * 为什么**必须**有上限（#524 的第 2 条前置）：按会话读是这张脸里天然最容易放大
 * 的方向——一个会话几十个窗口，每个窗口都是整段逐字原文，不限量就是「按会话导出
 * 全量转录」，与 /export（一次拿全库）同量级、只是换了形状，而它同样受门控。
 * 20 这个数的取法：本机实测一个蒸馏会话的窗口数在个位数，20 已覆盖正常排查；
 * 真要更多就带 limit 往上要，**不许**靠缺省值默默给全量。
 */
export const PROVENANCE_DEFAULT_WINDOWS = 20;

/**
 * limit 的硬上界。取值与 api.js 的 MAX_PAGE_LIMIT（1000）/ MAX_SEARCH_TOP_K（200）
 * 同一考虑：参数直接进 SQL LIMIT，上界是防御。这里比列表类接口更小，因为每个窗口
 * 带的是一整段原文而不是一行元数据——100 个窗口已经是一份不小的转录。
 */
export const PROVENANCE_MAX_WINDOWS = 100;

/**
 * 读侧唯一的开关判据，**与写侧 src/summarize.js:988 逐字同源**。
 *
 * 为什么不放在两个壳里各算一次：那句话已经是本仓第 3、第 4 份拷贝了
 * （summarize.js:988、index.js:270），而 #411 的结论就是「两张皮整段复制必然
 * 漂移」——读写两道门一旦漂移，就会出现「以为关了却还能读出去」或「开着却读不到」
 * 这两种都更难排查的状态。壳只转发 config，判据只在这里出现一次。
 *
 * fail-closed：config 缺失（null / undefined）、distillRecords 组缺失、值不是
 * 严格的 true（"true" 字符串 / 1 / undefined）一律算关。这个端点返回的是蒸馏
 * 窗口的逐字会话原文，判不出来时必须往「不读」那一侧倒。
 *
 * @param {object|null|undefined} config 启动期冻结的装配后 cfg（宿主 index.js:597
 *   的 createApi 第 8 参 / index.js:621 的 createStandaloneApi config / daemon
 *   serve.js 的最小 cfg）。
 * @returns {boolean}
 */
export function isDistillRecordsEnabled(config) {
  return config?.distillRecords?.enabled === true;
}

/** 溯源读取失败的 warn 文案。两个入口共用，日志里不会出现两种拼法。 */
export function provenanceWarnMessage(error) {
  return `[dsh-mneme] memory provenance read failed: ${String(error)}`;
}

/**
 * 按选择器分方向列出「要读必须先有哪个方法」。503 只在**该方向**缺方法时回：
 * 只补了 session 侧的装配不该让 memory 查询一起 503（那是把一个方向的问题
 * 报成整张脸坏了）。
 */
const REQUIRED_METHODS = {
  memory: ["provenanceFor", "distillRecordsFor"],
  session: ["distillWindowsFor", "distillRecordsFor"]
};

function trimmed(raw) {
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * 解析 ?limit。**只收十进制整数字面量**，缺省落默认值。
 *
 * 不用 Number()：它把 "" / " " / 十六进制 / 指数写法都化成数，于是 `?limit=`
 * 会静默变成 0 个窗口——一个畸形输入拿到最坏解释（reclaim-http.js 的
 * parseReclaimQuery 为同一理由立过这条规矩）。越界也算畸形：调用方要 1000 个
 * 窗口，实际给 100 而不说一声，比直接拒更糟。
 *
 * @returns {{ok: true, limit: number} | {ok: false, status: 400, error: string}}
 */
export function parseProvenanceLimit(raw) {
  if (raw === null || raw === undefined) return { ok: true, limit: PROVENANCE_DEFAULT_WINDOWS };
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d+$/.test(text)) return { ok: false, status: 400, error: "invalid-limit" };
  const limit = Number(text);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PROVENANCE_MAX_WINDOWS) {
    return { ok: false, status: 400, error: "invalid-limit" };
  }
  return { ok: true, limit };
}

/**
 * 解析两个互斥主键。都缺 → 400 missing-id；都给 → 400 ambiguous-id。
 *
 * 「都给时择一」是刻意不做的：择一意味着调用方可以发一个自己也不知道会被读哪个
 * 主键的请求，而两边的结果形状不同——那种静默选择只会在出事之后才被发现。
 * 400 是两个都错，比猜一个更好。
 *
 * @param {{memoryId?: string|null, sessionId?: string|null, limit?: string|null}} params
 * @returns {{ok: true, selector: {mode: "memory"|"session", memoryId?: string,
 *   sessionId?: string, limit: number}} | {ok: false, status: 400, error: string}}
 */
export function parseProvenanceSelector({ memoryId, sessionId, limit } = {}) {
  const mem = trimmed(memoryId);
  const ses = trimmed(sessionId);
  // 参数形状排在功能开关之前：请求本身不成立时报「功能关了」是误导。
  if (mem && ses) return { ok: false, status: 400, error: "ambiguous-id" };
  if (!mem && !ses) return { ok: false, status: 400, error: "missing-id" };
  const parsedLimit = parseProvenanceLimit(limit);
  if (!parsedLimit.ok) return parsedLimit;
  return {
    ok: true,
    selector: mem
      ? { mode: "memory", memoryId: mem, limit: parsedLimit.limit }
      : { mode: "session", sessionId: ses, limit: parsedLimit.limit }
  };
}

/**
 * 组装答复：一个窗口一项（区间 + 区间内原文行，按 seq 升序）。
 *
 * 顺序敏感（阶梯全貌见文件头）：409 功能关了 → 503 装配没接线 → 读。
 * 503 要赢过空结果——装配没接线时报「这条记忆没有来源」是误导，与 reclaimReply 的
 * maintenance-unavailable 同构；而 409 要赢过 503——「用户关了」比「装配坏了」更
 * 具体，把前者报成后者会让人去查一个没坏的部署。
 *
 * `truncated` 是两种模式共有的读数（#524）：撞上 limit 时把「还有更多」说出来。
 * 少了它，被截断的答复与「本来就只有这么多」逐字节相同，调用方会把半份转录
 * 当成全部——那正是这张脸最容易骗人的地方。
 *
 * @param {{service: object, selector: object, config?: object|null, warn?: Function}} args
 *   config 缺省即关（fail-closed），见 isDistillRecordsEnabled。
 * @returns {{status: number, body: object}}
 */
export function provenanceReply({ service, selector, config = null, warn = null }) {
  if (!isDistillRecordsEnabled(config)) {
    return { status: 409, body: { error: DISTILL_RECORDS_DISABLED } };
  }
  const mode = selector?.mode === "session" ? "session" : "memory";
  if (REQUIRED_METHODS[mode].some((name) => typeof service?.[name] !== "function")) {
    return { status: 503, body: { error: PROVENANCE_UNAVAILABLE } };
  }
  const limit = selector?.limit > 0 ? selector.limit : PROVENANCE_DEFAULT_WINDOWS;
  try {
    // session 侧多取一行判截断（store 侧只照 limit 取，不替调用方判断「还有没有」；
    // memory 侧 provenanceFor 本来就全量返回，按长度判即可）。
    const rows = mode === "session"
      ? service.distillWindowsFor(selector.sessionId, limit + 1)
      : service.provenanceFor(selector.memoryId);
    const truncated = rows.length > limit;
    // #512：run 是归因主体，窗口只是它的一批输入。能读到 run 就带上 run_type /
    // trigger_source / status，读不到（旧库历史链接、或 store 没这一步）就整组
    // 缺省——**不拿区间或时间戳去猜**：「看起来能追、实际是编的」比没有更坏。
    const canReadRuns = typeof service?.getDistillRun === "function";
    const windows = rows.slice(0, limit).map((link) => {
      const base = {
        session_id: link.session_id,
        seq_start: link.seq_start,
        seq_end: link.seq_end,
        created_at: link.created_at,
        // 到期裁剪后区间可能变空：链接刻意保留并指向空区间（clearDistillRecords 的
        // 语义），面板据此显示「原文已过期」而非「没有来源」。
        records: service.distillRecordsFor(link.session_id, link.seq_start, link.seq_end)
      };
      if (mode === "session") {
        // link_count 只有方向 2（session）会带：一个窗口派生出几条记忆。方向 1 的每
        // 一行本来就是「一条记忆 → 一个窗口」，这个计数恒为 1，带出去只会是噪音（用
        // ?? 兜住，免得方向 1 的答复凭空多一个 null 键）。
        return { ...base, link_count: link.link_count ?? 1 };
      }
      // 方向 2 的一行是一个窗口、可能派生多条记忆，没有单一归因主体，所以运行归因
      // 只挂在方向 1 上；要逐条查某条记忆出生自哪一轮，仍走方向 1。
      const run = canReadRuns && link.distill_run_id ? service.getDistillRun(link.distill_run_id) : undefined;
      return {
        ...base,
        // #512：distill_run_id 为 null 就是历史行为——改造之前写下的链接没有第二轮
        // 真相可查，面板据此显示「这一条没有运行归因」而不是给一个像样的空壳。
        distill_run_id: link.distill_run_id ?? null,
        run_type: run?.run_type ?? null,
        trigger_source: run?.trigger_source ?? null,
        run_status: run?.status ?? null
      };
    });
    // 行级铸造归因（#512）：这条记忆出生自哪一轮。与窗口级是两层，各自独立缺省。
    const mints = mode === "memory" && typeof service?.mintsFor === "function"
      ? service.mintsFor(selector.memoryId).map((mint) => ({
        run_id: mint.run_id,
        run_type: mint.run_type,
        trigger_source: mint.trigger_source,
        created_at: mint.created_at
      }))
      : [];
    const body = mode === "session"
      ? { sessionId: selector.sessionId, windows, truncated }
      : { memoryId: selector.memoryId, windows, truncated, mints };
    return { status: 200, body };
  } catch (error) {
    warn?.(provenanceWarnMessage(error));
    return { status: 500, body: { error: "internal" } };
  }
}
