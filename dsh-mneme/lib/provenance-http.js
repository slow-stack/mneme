// 记忆级溯源读出口的 HTTP 口径 —— 唯一实现。
//
// 为什么要单独一个模块：这张脸有两个入口——宿主内的面板路由（src/api.js 的
// /api/dsh-mneme/memory/provenance）与 Bearer 数据面（src/api-standalone.js 的
// /memory/provenance）。两者底下是同一份 service（provenanceFor + distillRecordsFor），
// 差别只在鉴权与路径。历史上（#509 第一版）它们是整段复制的，于是「改一边忘一边」
// 在结构上就可能发生——#411 已经为 reclaim / share 各踩过一次，本模块照那次的结论办。
//
// 口径（错误码、两种「空」的区分、窗口形状）现在只写在这里，两个入口都调它。
// 真要再写第二份，test/provenance-http.test.js 的静态锁会直接转红。
//
// 这里只做协议层的事：解析 id、判开关、组装窗口、区分「用户关了」「没接线」与
// 「没有来源」。一行数据都不改——读取在 src/store.js，透传在 src/service.js。
//
// 状态码阶梯（自前而后，先匹配的先回）：
//   401 未鉴权      ——两个壳各自的门（api.js 的 register 包装 / standalone 的
//                     isAuthorized），在本模块之前，不在这里重复。
//   400 缺 id       ——语法畸形，与服务端状态无关，所以排在功能开关之前；与
//                     reclaim 的 invalid-json 同档（reclaim-http.js:30-33 立的是
//                     「503 要赢过**字段校验**的 400」，缺 id 不是字段校验而是请求
//                     本身不成立，所以不适用那条）。判断在壳里
//                     （parseProvenanceQuery），走到本模块时 id 一定非空。
//                     ⚠ 将来要加**语义类** 400（如 limit 越界、id 格式不合法），
//                     必须挪到接线检查之后——那条 reclaim 口径正是为它立的。
//   409 功能关了    ——distillRecords.enabled !== true。回的是「端点的属性」，
//                     与 src/api.js:525 的 profileExtractEnabled 同构：用户关了
//                     某功能 = 409，装配坏了 = 503，两者必须是可区分的答案
//                     （src/index.js:589-591 的设计原话）。
//   503 装配没接线  ——service 上没有 provenanceFor / distillRecordsFor。
//   读（200 / 500）
// 刻意不用 404：本端点永远不就「这条记忆是否存在」作断言（缺 id 是 400、未知 id
// 是 200 + 空 windows），404 在本仓另有稳定含义——未知路由与资源不存在
// （src/api-standalone.js:506/515、src/api.js:1367/1445）。把「功能关了」塞进
// 404，调用方会在状态码这个唯一被代理 / 监控 / 重试逻辑读取的通道上，把它读成
// 「这条记忆不存在」。

/**
 * 「溯源能力没接线」的错误码。headless / 旧装配下 service 上没有 provenanceFor 或
 * distillRecordsFor，那是装配坏了，不是「这条记忆没有来源」——两种空必须分开读数，
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
 * 解析 ?id。空 / 缺失 → 400；其余原样交给 service（id 不存在时返回空 windows，
 * 那是有效答案，不是错误——读端点不替调用方判断记忆是否存在）。
 *
 * @returns {{ok: true, id: string} | {ok: false, status: 400, error: string}}
 */
export function parseProvenanceQuery(raw) {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) return { ok: false, status: 400, error: "missing-id" };
  return { ok: true, id };
}

/**
 * 组装答复：一个链接一个窗口（区间 + 区间内原文行，按 seq 升序）。
 *
 * 顺序敏感（阶梯全貌见文件头）：409 功能关了 → 503 装配没接线 → 读。
 * 503 要赢过空结果——装配没接线时报「这条记忆没有来源」是误导，与 reclaimReply 的
 * maintenance-unavailable 同构；而 409 要赢过 503——「用户关了」比「装配坏了」更
 * 具体，把前者报成后者会让人去查一个没坏的部署。
 *
 * @param {{service: object, id: string, config?: object|null, warn?: Function}} args
 *   config 缺省即关（fail-closed），见 isDistillRecordsEnabled。
 * @returns {{status: number, body: object}}
 */
export function provenanceReply({ service, id, config = null, warn = null }) {
  if (!isDistillRecordsEnabled(config)) {
    return { status: 409, body: { error: DISTILL_RECORDS_DISABLED } };
  }
  if (typeof service?.provenanceFor !== "function" || typeof service?.distillRecordsFor !== "function") {
    return { status: 503, body: { error: PROVENANCE_UNAVAILABLE } };
  }
  try {
    const links = service.provenanceFor(id);
    const windows = links.map((link) => ({
      session_id: link.session_id,
      seq_start: link.seq_start,
      seq_end: link.seq_end,
      created_at: link.created_at,
      // 到期裁剪后区间可能变空：链接刻意保留并指向空区间（clearDistillRecords 的
      // 语义），面板据此显示「原文已过期」而非「没有来源」。
      records: service.distillRecordsFor(link.session_id, link.seq_start, link.seq_end)
    }));
    return { status: 200, body: { memoryId: id, windows } };
  } catch (error) {
    warn?.(provenanceWarnMessage(error));
    return { status: 500, body: { error: "internal" } };
  }
}
