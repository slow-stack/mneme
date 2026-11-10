/**
 * 跨天判定：本机没有日历调度原语（cordis.patch.yml 没有 schedules 服务，
 * node_modules 里唯一的 scheduler 是 React 那个），所以「每天 0 点写一篇」写不出来。
 *
 * 可实现的等价形态是**跨天惰性判定**：在 turn/end 与插件启动两个既有挂载点上问
 * 「上一次写的日期是不是今天」，不是才写。差别只在于「今天一句话没说」那天没有日记
 * ——而那恰好是对的：没有素材就不该编。
 *
 * 全部是纯函数（时间由调用方注入），所以「跨 5 天只补 1 天」这类边界能被真的测出来。
 */

/** 宿主本地时区的 `YYYY-MM-DD`。刻意不用 UTC：日记的「今天」是用户感知的今天。 */
export function localDateString(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toUtcMs(dateLocal) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateLocal ?? ""));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** `to - from` 的整数天数；任一参数形状不对返回 null（调用方据此走「当作首次」）。 */
export function dayGap(fromDate, toDate) {
  const a = toUtcMs(fromDate);
  const b = toUtcMs(toDate);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86400000);
}

/** 一次最多回补几天。默认 1：睡得久一点就补一篇，不该醒来一次补十篇把模型配额烧光。 */
export const MAX_CATCH_UP_DAYS = 1;

/**
 * 今天该不该写。
 *
 * 返回 `{roll, gapDays, gap}`：
 * - `roll` 要不要写。`lastDate` 为空（从没写过）→ 写。
 * - `gapDays` 距上次写的天数（null = 没写过或日期形状不对）。
 * - `gap` 中间有没有「永久丢掉」的日子（超过回补上限）——必须如实写进日记头部，
 *   不能假装连续。这是本模块唯一允许对读者撒谎的地方，所以它必须是个返回值，
 *   不是一个可选参数。
 *
 * 时钟往回调（`lastDate` 比今天还新）时不写：那不是「跨天」，那是同一份时间被
 * 重算了一次，再写一次只会覆盖掉今天已经写好的那篇。
 */
export function shouldRollDay(lastDate, today, { maxCatchUpDays = MAX_CATCH_UP_DAYS } = {}) {
  const now = String(today ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(now)) return { roll: false, gapDays: null, gap: false };
  const last = String(lastDate ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(last)) return { roll: true, gapDays: null, gap: false };
  if (last === now) return { roll: false, gapDays: 0, gap: false };
  const gapDays = dayGap(last, now);
  if (gapDays === null || gapDays < 0) return { roll: false, gapDays, gap: false };
  const limit = Number.isFinite(maxCatchUpDays) && maxCatchUpDays >= 0 ? maxCatchUpDays : MAX_CATCH_UP_DAYS;
  return { roll: true, gapDays, gap: gapDays > limit };
}
