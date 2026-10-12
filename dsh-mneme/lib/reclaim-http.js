// 存储回收（maintenance/reclaim）的 HTTP 口径 —— 唯一实现。
//
// 为什么要单独一个模块：这张脸有两个入口——宿主内的面板路由（src/api.js 的
// /api/dsh-mneme/maintenance/reclaim）与 Bearer 数据面（src/api-standalone.js 的
// /maintenance/reclaim）。两者底下是**同一份** src/maintenance.js，差别只在鉴权与
// 路径。历史上它们是整段复制的，于是 #410 修好面板侧的上界与兜错之后，数据面还停在
// 旧形态（#411）——复制粘贴漂移不是设计，是缺陷。
//
// 口径（错误码字符串、默认值、报告形状）现在只写在这里，两个入口都调它。这样
// 「改一边忘一边」在结构上就不可能发生；真要再写第二份，test/reclaim-http.test.js
// 的静态锁会直接转红。
//
// 这里只做协议层的事：解析、校验、把 maintenance.reclaim 的结果包成答复。一行数据
// 都不改——真正的丢弃逻辑在 src/maintenance.js。

/**
 * 回收窗口上界。整数校验挡不住量级：1e20 也是整数，而 maintenance 会拿它算
 * `now() - days * 86400000` 再 toISOString()，抛 RangeError；GET 侧 400 位十进制
 * 字面量还会化成 Infinity，被当成畸形输入静默落回默认窗口 7——调用方要一个巨大
 * 窗口，实际只清了 7 天外的东西，而报告上写着 7 看不出异样。
 *
 * 取值与 config.js 的 llmAudit.retentionDays / recallRetentionDays 同一条线
 * （3650 天 = 10 年）：回收窗口比审计保留期还长没有意义，那之后的东西本来也不在。
 */
export const MAX_RECLAIM_WINDOW_DAYS = 3650;

/** 拒执行时的提示。两个入口必须逐字一致——它是给调用方看的下一步动作。 */
export const RECLAIM_CONFIRM_HINT = "先看 dry-run 报告，确认后带 {\"dryRun\":false,\"confirm\":true} 再发";

/**
 * 「维护能力没接线」的错误码。两个入口各有一次**顺序敏感**的显式检查（503 要赢过
 * 400：端点整个没接线时，报「窗口不合法」是误导），所以这条不能只藏在 reclaimReply
 * 里；但也必须是同一份字符串，否则两张皮又能各写各的。
 */
export const RECLAIM_UNAVAILABLE = "maintenance-unavailable";

/** 回收失败的 warn 文案。两条路径共用，日志里不会出现两种拼法。 */
export function reclaimWarnMessage(error) {
  return `[dsh-mneme] storage reclaim failed: ${String(error)}`;
}

/**
 * 解析 GET 的 ?olderThanDays（searchParams.get 的原始字符串）。
 *
 * query 是字符串域：只收十进制整数字面量，缺省才落默认窗口。**不能用 Number()**
 * ——它把 ""/[]/" " 都化成 0，而 0 在这里是「清掉全部快照」，最坏解释绝不能从一个
 * 畸形输入静默拿到（POST 侧收 JSON 数字，口径不同，见 readReclaimFields）。
 *
 * @returns {{ok: true, olderThanDays: number|undefined} | {ok: false, error: string}}
 */
export function parseReclaimQuery(raw) {
  if (raw === null) return { ok: true, olderThanDays: undefined };
  if (!/^\d+$/.test(raw)) return { ok: false, error: "invalid-older-than-days" };
  const olderThanDays = Number(raw);
  // 十进制字面量不保证是个能算日期的数：400 位数字会化成 Infinity。
  if (!Number.isFinite(olderThanDays) || olderThanDays > MAX_RECLAIM_WINDOW_DAYS) {
    return { ok: false, error: "invalid-older-than-days" };
  }
  return { ok: true, olderThanDays };
}

/**
 * 解析 POST body（已读成文本）的结构。只判 JSON 与顶层形状，字段在
 * readReclaimFields 里读——两步分开是为了让调用方保住「invalid-json → invalid-body
 * → maintenance 是否接线 → 字段」这个顺序，这个顺序是既有的对外行为。
 *
 * 不用 parseBody：它把坏 JSON 吞成 {}，而 invalid-json 与 invalid-body 是两个不同
 * 的错（前者是调用方发坏了，后者是发成了数组/null）。
 *
 * @returns {{ok: true, body: object} | {ok: false, error: string}}
 */
export function parseReclaimJson(text) {
  let body;
  try {
    body = JSON.parse(text || "{}");
  } catch {
    return { ok: false, error: "invalid-json" };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid-body" };
  }
  return { ok: true, body };
}

/**
 * 读 POST 的字段并归一化。
 *
 * @returns {{ok: true, dryRun: boolean, olderThanDays: number|undefined, vacuum: boolean,
 *            confirm: boolean} | {ok: false, error: string}}
 */
export function readReclaimFields(body) {
  const dryRun = body.dryRun !== false;
  // 只收 JSON 数字：Number() 会把 ""/[]/false 都化成 0，而 0 在这里是「清掉全部
  // 快照」——最坏解释绝不能让一个畸形输入静默拿到。
  const olderThanDays = body.olderThanDays === undefined || body.olderThanDays === null
    ? undefined
    : body.olderThanDays;
  if (olderThanDays !== undefined
    && (!Number.isInteger(olderThanDays) || olderThanDays < 0 || olderThanDays > MAX_RECLAIM_WINDOW_DAYS)) {
    return { ok: false, error: "invalid-older-than-days" };
  }
  if (body.vacuum !== undefined && typeof body.vacuum !== "boolean") {
    return { ok: false, error: "invalid-vacuum" };
  }
  return {
    ok: true,
    dryRun,
    olderThanDays,
    vacuum: body.vacuum === true,
    confirm: body.confirm === true
  };
}

/**
 * 把一次回收请求变成 { status, body }。调用方只管 sendJson，不自己拼答复。
 *
 * 报告一律不加包装层（就是 maintenance.reclaim 的原样返回）：面板与数据面都直接读
 * planned/cleared/vacuum 这几格。
 *
 * confirm-required 分支里那份 dry-run 报告是**在这里**算的。它曾经写在 readBody 的
 * 回调里，而外层 try 那时已经退栈——抛出去就是一个没人接的 rejection，客户端拿到的
 * 不是 500 而是「一个字节都没回」（#410 实测）。所以本地兜住，与执行路径给出同一个
 * 500 internal。
 *
 * @param {{maintenance: object|null, dryRun: boolean, olderThanDays?: number,
 *          vacuum?: boolean, confirm?: boolean, warn?: ((msg: string) => void)|null}} input
 * @returns {{status: number, body: object}}
 */
export function reclaimReply({ maintenance, dryRun, olderThanDays, vacuum = false, confirm = false, warn = null }) {
  if (!maintenance) return { status: 503, body: { error: RECLAIM_UNAVAILABLE } };
  if (!dryRun && confirm !== true) {
    // 拒执行，但把 dry-run 报告一并回给调用方：确认的依据就是这份数字。报告必须描述
    // **将要执行的那个动作**，所以 vacuum 原样带上——否则调用方看到的是「不 VACUUM」
    // 的数字，却带着 vacuum 去执行。
    let report;
    try {
      report = maintenance.reclaim({ olderThanDays, vacuum, dryRun: true });
    } catch (error) {
      warn?.(reclaimWarnMessage(error));
      return { status: 500, body: { error: "internal" } };
    }
    return { status: 400, body: { error: "confirm-required", hint: RECLAIM_CONFIRM_HINT, report } };
  }
  try {
    return { status: 200, body: maintenance.reclaim({ olderThanDays, vacuum, dryRun }) };
  } catch (error) {
    warn?.(reclaimWarnMessage(error));
    return { status: 500, body: { error: "internal" } };
  }
}
