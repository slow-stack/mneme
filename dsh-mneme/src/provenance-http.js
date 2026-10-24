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
// 这里只做协议层的事：解析 id、组装窗口、区分「没接线」与「没有来源」。一行数据
// 都不改——读取在 src/store.js，透传在 src/service.js。

/**
 * 「溯源能力没接线」的错误码。headless / 旧装配下 service 上没有 provenanceFor 或
 * distillRecordsFor，那是装配坏了，不是「这条记忆没有来源」——两种空必须分开读数，
 * 否则调用方看到一个空 windows 会以为拿到了答案。
 */
export const PROVENANCE_UNAVAILABLE = "provenance-unavailable";

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
 * 顺序敏感：503 要赢过空结果——装配没接线时报「这条记忆没有来源」是误导，
 * 与 reclaimReply 的 maintenance-unavailable 同构。
 *
 * @param {{service: object, id: string, warn?: Function}} args
 * @returns {{status: number, body: object}}
 */
export function provenanceReply({ service, id, warn = null }) {
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
