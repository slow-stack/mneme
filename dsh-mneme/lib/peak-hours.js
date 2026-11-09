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
// 绝不该因为写错格式把蒸馏/巩固停掉。
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

export function parsePeakSpec(spec) {
  if (typeof spec !== "string" || spec.trim() === "") return null;
  let rest = spec.trim();
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

// --- 可观测性（issue #622）：解析失败不许静默 ---------------------------------
//
// 上面的失败语义（整串视为未配置）是对的——排程是省钱手段，绝不该因为写错格式
// 把蒸馏/巩固停掉。但它的代价是：**配置写错的唯一症状是「功能悄悄没生效」**——
// 用户明明写了 summarizePeakHours / dreamPeakHours，排程却回到全天候，日志、
// 面板、审计里没有任何痕迹（#424 主楼的排查只能靠「高峰期还在巩固」倒推）。
// 归一化类补救（PR #621 的全角等价）收得掉一小类，但 24:00 越界、点号当冒号这类
// 只能靠告警——归一化不救错，静默失效面永远存在。本节只补**可见性**，不动语义：
// helper 只转述 parsePeakSpec 的话，解析口径变了（如 #621 落地）告警面自动跟随，
// 两批无需联动。
//
// 两个键名单独成表：告警点（index.js 启动装配）与提示点（/features 答复、面板
// 输入行）都要认同一份「哪些键是时段键」，不各写一份字符串数组然后各自漂移。
export const PEAK_SPEC_KEYS = ["summarizePeakHours", "dreamPeakHours"];

/**
 * 找出「非空且解析失败」的时段配置。空串是合法的「未配置」（调用方用 `?? ""`
 * 兜底），不进结果——否则每个没配错峰的用户开机都被警告一遍（#622 验收第 2 条）。
 * 非法串映射 key → 原串：告警要带原串才能对上配置文件里那一行；/features 答复
 * 只取 Object.keys（面板只需要「哪个键坏了」，不需要回显值）。
 */
export function invalidPeakSpecs(cfg) {
  const out = {};
  if (!cfg || typeof cfg !== "object") return out;
  for (const key of PEAK_SPEC_KEYS) {
    const spec = cfg[key];
    if (typeof spec === "string" && spec.trim() !== "" && parsePeakSpec(spec) === null) {
      out[key] = spec;
    }
  }
  return out;
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
