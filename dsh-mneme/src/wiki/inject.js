// dsh-mneme/src/wiki/inject.js
// chorography 的注入面（M3）：会话开局往 systemPrompt 里塞一小块「仓库地志提纲」。
//
// 三条边界（spec §7 / P24–P33）：
// 1. **只注标题级**——模块名 + 文件数 + 页状态 + 页相对路径，不读页正文。正文要
//    模型自己用 choro_read_page 取，那不是「开局就该付的成本」。
// 2. **不上热路径的硬活**——不 fork git、不 stat 磁盘、不解析 markdown。这里只吃
//    DB 里已有的行；过期判定留给 /choro（人主动触发，付得起一次 git rev-parse）。
// 3. **绝不抛**——本块折在既有的 memory context 里，一个附属信息块把整轮
//    systemPrompt 搞崩是不成比例的失败。任何异常都退化成空串（= 本帧不注入，
//    宿主契约里空文本会被过滤，不占位）。
import { escapePromptVars } from "../user-settings.js";
import { STR } from "../lang.js";

/** 档位枚举（与 config.js 的 chorographyInject 同一份取值，配置闸门在 settings.js）。 */
export const INJECT_TIERS = Object.freeze(["off", "light", "full"]);

/**
 * light 档最多列几个模块。
 *
 * 定 6 是照着 spec §7 的「≤8 行」倒推的：块头 1 行 + 模块行 6 行 + 「还有 N 个」
 * 1 行 = 8 行。多给两行要挤掉「还有 N 个」那句，读者就不知道清单被截断了——
 * 静默截断比明说「还有 30 个」更坏。
 */
export const LIGHT_MODULE_LIMIT = 6;

/** 各档字符硬上限。宿主侧没有任何体积预算（V3 实测），所以上限只能自己兜。 */
export const MAX_BLOCK_CHARS = Object.freeze({ light: 900, full: 6000 });

/**
 * 配置 → 档位。纯函数，无副作用，供注入侧与 /choro 共用同一份判据。
 *
 * 轻量档（lightMode）在这里被压成 off 而不是进 LIGHT_MODE_OFF：那张表对平铺键
 * 一律赋 false，枚举键塞进去会得到与 schema 不符的 false，而 false !== "off"
 * 时注入照样渲染——比不关更糟（P26）。
 */
export function resolveInjectTier(config) {
  if (!config || config.chorographyEnabled !== true) return "off";
  if (config.lightMode === true) return "off";
  const raw = config.chorographyInject;
  return INJECT_TIERS.includes(raw) ? raw : "light";
}

/** 页状态 → 标签。skeleton 不出标签（那是默认态，全标一遍等于没标）。 */
function statusLabel(status, language) {
  if (status === "enriched") return STR.choroStatusEnriched[language];
  if (status === "failed") return STR.choroStatusFailed[language];
  if (status === "stale") return STR.choroStatusStale[language];
  return "";
}

/**
 * light 档取哪些模块。
 *
 * 按文件数降序、同数按 slug 升序——**不是**取字母序前 6 个：字母序会永远只显示
 * 同一批（通常还是 src 这种大而空的目录页），而大模块是「被问到的概率」最高的
 * 那批。排序里带 slug 是为了同一份库每次渲染字节一致（缓存与测试都靠它）。
 */
function pickModules(modules, tier) {
  // 两档用同一份排序：light 与 full 若各按各的排，同一份地志在两个档位下会给出
  // 不同次序，读起来像「刚才那份被重扫过了」。大模块在前对两档都成立——
  // 被问到的概率最高的那批，本来就该排前面。
  const ordered = [...modules].sort((a, b) => {
    const d = (b.fileCount ?? 0) - (a.fileCount ?? 0);
    if (d !== 0) return d;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  if (tier === "full") return { shown: ordered, rest: 0 };
  return { shown: ordered.slice(0, LIGHT_MODULE_LIMIT), rest: Math.max(0, ordered.length - LIGHT_MODULE_LIMIT) };
}

/** 生成时间只留日期部分：注入块里精确到毫秒没有信息量，只挤体积。 */
function dateOnly(iso) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso ?? ""));
  return match ? match[1] : String(iso ?? "");
}

/**
 * 渲染地志提纲块。纯函数（入参进、字符串出），注入侧与 /choro 的「看提纲」
 * 共用这一份——两张皮在这里只剩档位与语言两个参数之差。
 *
 * @param {object|null} outline createChoroQueries().outline() 的产物
 * @param {"light"|"full"} tier 已解析的档位（off 不该调到这里）
 * @param {"zh"|"en"} language
 * @returns {string} 空串 = 不注入
 */
export function renderChoroBlock(outline, tier, language = "zh") {
  if (!outline || !Array.isArray(outline.modules) || outline.modules.length === 0) return "";
  const lang = language === "en" ? "en" : "zh";
  const cap = MAX_BLOCK_CHARS[tier] ?? MAX_BLOCK_CHARS.light;
  const picked = pickModules(outline.modules, tier);

  const lines = [
    STR.choroBlockHeader[lang](outline.repo.name, outline.modules.length, dateOnly(outline.generatedAt))
  ];
  for (const mod of picked.shown) {
    lines.push(STR.choroBlockLine[lang](mod.title, mod.fileCount ?? 0, statusLabel(mod.status, lang), mod.relPath ?? ""));
  }
  if (picked.rest > 0) lines.push(STR.choroBlockMore[lang](picked.rest));

  // 逐行累加而不是拼完再切：切在行中间会让最后一条模块行变成半句话，
  // 模型读到的「路径」就可能是断的——宁可少一行，不可半行。
  const kept = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > cap) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (kept.length <= 1) return "";
  return kept.join("\n");
}

/**
 * 注入器（给 src/inject.js 用）。
 *
 * 缓存键用 **outline.generatedAt**（页级生成时间的最大值），不是 choro_repos.
 * updated_at：T1 富化只推 choro_pages.generated_at，不动仓库行——若按仓库行做键，
 * 用户刚在终端跑完 `--t1 --apply`，注入块还写着「骨架」，而 /choro（无缓存）已经
 * 报「已富化」。两个面说同一件事却给出不同答案，比慢一点糟得多。
 * 每轮仍查一次库取提纲（一次索引查询，几十微秒，不 fork git、不 stat 磁盘），
 * 只是**渲染**走缓存——省的是拼字符串，不是正确性。
 *
 * @param {object} opts.choro createChoroQueries() 的产物（注入侧只读它）
 * @param {object} opts.config 合并后的配置
 * @param {object} [opts.logger]
 * @param {() => string} [opts.language] 语言取值器（跟随配置，不在创建时定死）
 * @returns {{ text: (cwd: string|null|undefined) => string, tier: string, dispose: () => void }}
 */
export function createChoroInject({ choro, config, logger = null, language = null } = {}) {
  const langOf = typeof language === "function" ? language : () => "zh";
  const tier = resolveInjectTier(config);
  let cache = null; // { key, text }

  function text(cwd) {
    if (tier === "off" || !choro) return "";
    try {
      const repo = typeof choro.repoByCwd === "function" ? choro.repoByCwd(cwd) : null;
      if (!repo) return "";
      const lang = langOf() === "en" ? "en" : "zh";
      const outline = typeof choro.outline === "function" ? choro.outline(repo.id) : null;
      // 键取页级生成时间：T0 重算与 T1 富化都会推进它，两种「地志变了」都命中。
      const key = tier + "|" + lang + "|" + repo.id + "|" + (outline?.generatedAt ?? repo.updated_at ?? "");
      if (cache && cache.key === key) return cache.text;
      // 转义只在这一层做：/choro 的 UI 回执也调 renderChoroBlock，但它不进宿主模板，
      // 转义了反而会显示成一串反斜杠。这里的 config 与 inject.js 同一份开关。
      const rendered = escapePromptVars(config, renderChoroBlock(outline, tier, lang));
      cache = { key, text: rendered };
      return rendered;
    } catch (error) {
      // P31：注入永远不抛。日志留一次线索，但本帧就当没有地志。
      logger?.warn?.("[dsh-mneme] chorography 注入块渲染失败，本帧跳过：" + String(error?.message ?? error));
      return "";
    }
  }

  return {
    text,
    tier,
    dispose() {
      cache = null;
    }
  };
}
