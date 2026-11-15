/**
 * #613 §4：素材来源之三——**全局记忆**（主来源，v2 起）。
 *
 * 「一个 Agent 一本」的素材是「这个 Agent 在各会话里留下的痕迹」，不是某一段会话
 * 转录：跨项目、跨工作区、跨机器重启都还在。会话转录（session-provider）与 QQ
 * 收件箱（qq-inbox）降级为非 agent 模式的来源，agent 模式只认记忆库。
 *
 * 全部由 store.diaryMaterial 的 SQL 兑现（两形 source / 本地日 / COALESCE / -480
 * 修正的口径说明在那边），这一层只做三件事：
 * - 把本机时区换算成 SQL 需要的偏移参数（store 不读钟）；
 * - 把本地日窗口换算成墙钟字符串；
 * - 把行渲染成 compose 素材条（title：content 一条，数字脱敏同 session-provider）。
 *
 * LIMIT 截断在这里显式暴露：{total, used, truncated}——#613 验收红线「500 条只准
 * 如实说用了 400 条」，不许静默。
 */
import { redactDigits } from "./qq-inbox.js";
import { MAX_ITEM_CHARS } from "./session-provider.js";

/** 本机时区的 UTC 偏移（分钟，东八区 = 480）。store 不读钟，参数从这里给。 */
export function localTzOffsetMinutes(now = new Date()) {
  return -now.getTimezoneOffset();
}

/** 本地日的墙钟窗口：["2026-11-14 00:00:00", "2026-11-15 00:00:00"]。 */
export function localDayWindow(dateLocal) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateLocal ?? ""));
  if (!m) return { start: "", end: "" };
  const start = `${m[1]}-${m[2]}-${m[3]} 00:00:00`;
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  const ny = next.getUTCFullYear();
  const nm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const nd = String(next.getUTCDate()).padStart(2, "0");
  return { start, end: `${ny}-${nm}-${nd} 00:00:00` };
}

/**
 * 取某一天的素材。sessionIds 是「这个 agent 名下已落定的会话 id」全集（含当前的）。
 * 返回 {items, total, used, truncated} 或 {error}。ts 是真实 UTC 毫秒——SQL 给的
 * local_ts 是本地墙钟，按「墙钟当 UTC 解析再减本机偏移」还原成真 UTC，
 * renderMaterial 的 getHours()（本机时区）会把它再变回墙钟显示。
 */
export function collectMemoryMaterial({
  service,
  sessionIds,
  excludeIds = [],
  dateLocal,
  maxItems = 400,
  excludeTypes = [],
  tzOffsetMinutes = localTzOffsetMinutes()
} = {}) {
  if (!service || typeof service.diaryMaterial !== "function") return { error: "unavailable" };
  const tz = Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0;
  const ids = Array.isArray(sessionIds) ? sessionIds.filter((id) => typeof id === "string" && id) : [];
  const ex = Array.isArray(excludeIds) ? excludeIds.filter((id) => typeof id === "string" && id) : [];
  if ((!ids.length && !ex.length) || !dateLocal) return { items: [], total: 0, used: 0, truncated: false };
  const { start, end } = localDayWindow(dateLocal);
  if (!start) return { error: "bad-date" };
  const { rows, total } = service.diaryMaterial({
    ids,
    excludeIds: ex,
    dayStart: start,
    dayEnd: end,
    excludeTypes: Array.isArray(excludeTypes) ? excludeTypes : [],
    limit: maxItems,
    bandLo: -tz - 10,
    bandHi: -tz + 10,
    offsetMinutes: tz
  });
  const items = (rows ?? []).map((r) => ({
    // local_ts 是本地墙钟（"YYYY-MM-DD HH:MM:SS"）：按 UTC 解析得到「墙钟数值当
    // UTC」的毫秒，减去本机偏移才是真 UTC；renderMaterial 用本机时区取小时分钟，
    // 两次换算相抵，显示的仍是本地墙钟。
    ts: Date.parse(`${String(r.localTs ?? "").replace(" ", "T")}Z`) - tz * 60000,
    role: String(r.type ?? "memory"),
    text: redactDigits(`${String(r.title ?? "")}：${String(r.content ?? "")}`).slice(0, MAX_ITEM_CHARS)
  })).filter((it) => Number.isFinite(it.ts) && it.text.trim());
  return {
    items: items.slice(0, maxItems),
    total: Number(total) || 0,
    used: Math.min(items.length, maxItems),
    truncated: (Number(total) || 0) > items.length
  };
}
