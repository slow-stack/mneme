// 高峰时段（peak hours）解析与判定——纯函数模块，零依赖。
//
// 从 summarize.js 抽出（PR #320 review）：#316 之后 summarize.js 反向依赖
// dream.js（withEffortFallback 复用），dream 镜像错峰时再 import summarize
// 会成真循环。时段调度本来就不是蒸馏的私有语义，独立成模块后两侧都从这里
// import，循环消失。re-export 兼容留在 summarize.js，调用方零改动。
//
// Issue #239（第 4 项，错峰队列）：高峰时段解析与判定。纯函数、可单测——排程
// 判断不绑死真实时钟，测试才能确定性地覆盖跨零点、多段、星期过滤与非法写法。
// spec 语法：`[<星期> ]<时段>[,<时段>...]`，星期前缀可省（省 = 每天）：
//   "09:00-18:00"                        每天 09:00-18:00
//   "mon-fri 08:00-12:00,14:00-18:00"    工作日两段（ISO 1=周一…7=周日，也认 mon..sun）
//   "sat,sun 23:00-06:00"                周末跨零点段
// 时间取宿主本地时区。任一写法非法 → 整串视为未配置（返回 null）：排程是省钱手段，
// 绝不该因为写错格式把蒸馏/巩固停掉。全角等价符号在解析前归一成半角（#424），
// 见 parsePeakSpec 上方的 normalizeFullwidth。
const DAY_NAMES = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

function parseDayToken(token) {
  const days = new Set();
  const normalize = (value) => (/^\d$/.test(value) ? Number(value) : DAY_NAMES[value] ?? null);
  for (const piece of token.split(",")) {
    const matched = /^([a-z]{3}|\d)(?:-([a-z]{3}|\d))?$/.exec(piece.trim().toLowerCase());
    if (!matched) return null;
    const from = normalize(matched[1]);
    const to = matched[2] === undefined ? from : normalize(matched[2]);
    if (from === null || to === null || from < 1 || from > 7 || to < 1 || to > 7) return null;
    // 支持跨周环绕（fri-mon）：从 from 起逐天推进到 to，最多绕一圈。
    for (let day = from; ; day = (day % 7) + 1) {
      days.add(day);
      if (day === to) break;
    }
  }
  return days.size > 0 ? [...days].sort((a, b) => a - b) : null;
}

/** JS 的 getDay() 是 0=周日…6=周六；这里统一成 ISO（1=周一…7=周日）。 */
function isoDay(date) {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

// #424：全角等价符号归一。中文输入法下写时段串，逗号/冒号/数字跟着输入法走成全角
// 是常态（#424 实测的失败写法里全角类占四种）；而解析失败的语义是「未配置 =
// 不限制」（见文件头），错一个字符整串静默失效 = 错峰闸门悄悄关掉、巩固回到
// 全天候——这正是 #424 报的现象。这里只做**等价映射**，不做救错：
//   * U+FF01–FF5D（全角！到全角－）与 ASCII 0x21–0x7D 恒差 0xFEE0，整段一起折，
//     覆盖 ，：０-９－与全角字母（星期前缀一起受益）；
//   * 全角～（U+FF5E）**不**走区间折叠——折回半角是 `~`，而 `~` 是既有契约里
//     故意非法的连接号写法；波浪号无论全半形都当范围连接号，映成 '-'。
//     〜（U+301C，波浪号的另一半）同理。
// 合法写法只含 ASCII，归一前合法的串归一后逐字节不变，语义零漂移；
// `24:00` 这类**值本身写错**的串仍按非法处理（跨零点的正写是 `04:00-00:00`），
// 归一化不背救错的锅。
const FULLWIDTH_EQUIVALENTS = /[\uFF01-\uFF5E]/g;
const FULLWIDTH_TILDE = 0xff5e;
const WAVE_DASH = /\u301C/g;

function normalizeFullwidth(spec) {
  return spec
    .replace(FULLWIDTH_EQUIVALENTS, (ch) => {
      const code = ch.charCodeAt(0);
      if (code === FULLWIDTH_TILDE) return "-";
      return String.fromCharCode(code - 0xfee0);
    })
    .replace(WAVE_DASH, "-");
}

export function parsePeakSpec(spec) {
  if (typeof spec !== "string" || spec.trim() === "") return null;
  let rest = normalizeFullwidth(spec).trim();
  let days = null;
  // 星期前缀 = 第一个空白之前的部分，但**头段含冒号就不是前缀**（那是时段本身，
  // 例如 "09:00-12:00, 14:00-18:00" 里的逗号空格）。前缀解析失败一律按未配置处理，
  // 不做猜测——宁可不省，也不能误停。
  const sep = rest.search(/\s/);
  if (sep > 0) {
    const head = rest.slice(0, sep);
    if (!head.includes(":")) {
      days = parseDayToken(head);
      if (days === null) return null;
      rest = rest.slice(sep).trim();
    }
  }
  const windows = [];
  for (const part of rest.split(",")) {
    const matched = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(part);
    if (!matched) return null;
    const [sh, sm, eh, em] = [Number(matched[1]), Number(matched[2]), Number(matched[3]), Number(matched[4])];
    if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    if (start === end) return null;
    windows.push({ start, end });
  }
  return windows.length > 0 ? { days, windows } : null;
}

/**
 * 该时刻是否落在高峰内。跨零点段（start > end）按「窗口所属的那一天」认星期：
 * `mon-fri 23:00-06:00` 的周六 02:00 属于周五开的那个窗口，仍算高峰。
 */
export function isInPeakWindow(date, spec) {
  const parsed = parsePeakSpec(spec);
  if (!parsed) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  const today = isoDay(date);
  const yesterday = today === 1 ? 7 : today - 1;
  const allowed = (day) => !parsed.days || parsed.days.includes(day);
  return parsed.windows.some(({ start, end }) => {
    if (start < end) return minutes >= start && minutes < end && allowed(today);
    return (minutes >= start && allowed(today)) || (minutes < end && allowed(yesterday));
  });
}

/**
 * 高峰内则返回「距当前最近的一个高峰结束时刻」（择时补跑用），否则 null。
 * 落在多个时段重叠处时取最早结束的那个——早跑不亏，晚跑才亏。
 */
export function nextOffPeakAt(date, spec) {
  const parsed = parsePeakSpec(spec);
  if (!parsed) return null;
  const minutes = date.getHours() * 60 + date.getMinutes();
  const today = isoDay(date);
  const yesterday = today === 1 ? 7 : today - 1;
  const allowed = (day) => !parsed.days || parsed.days.includes(day);
  let bestDelta = null;
  const consider = (delta) => {
    if (bestDelta === null || delta < bestDelta) bestDelta = delta;
  };
  for (const { start, end } of parsed.windows) {
    if (start < end) {
      if (minutes >= start && minutes < end && allowed(today)) consider(end - minutes);
      continue;
    }
    if (minutes >= start && allowed(today)) consider((1440 - minutes) + end);
    else if (minutes < end && allowed(yesterday)) consider(end - minutes);
  }
  if (bestDelta === null) return null;
  const at = new Date(date.getTime());
  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + bestDelta);
  return at;
}
