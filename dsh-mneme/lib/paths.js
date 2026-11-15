// 落盘路径的中性根（issue：mneme 的库不该处处挂 DSH）。
//
// 背景：插件的库、运行时、模型缓存原本全默认住在 `~/.dsh/` 下。`~/.dsh` 是
// DeepSeek Harness 的家目录，但 mneme 的记忆库本身跟 DSH 没有关系——换宿主、
// 甚至完全不装 DSH（standalone / MCP）也该能起来。所以把「家」抽成中性的一层：
//
//   MNEME_HOME（或兼容的 DSH_MNEME_HOME）→ 默认 `<home>/.mneme`
//
// 下面所有默认值都从这一层派生：`<home>/memory`、`<home>/runtime`、
// `<home>/models`。
//
// ⚠️ **存量兼容是硬约束**：现场有用户（含本机 845MB 的正式库）已经把库养在
// `~/.dsh/memory` 里。改默认值绝不能把这些人变成「全新空库」——那是数据层面的
// 灾难，而且没有任何报错。所以解析顺序是：
//
//   1. 显式配置（config.memoryDir / --memory-dir / MNEME_MEMORY_DIR）永远赢；
//   2. 否则看两个候选目录里**谁真的有库文件**（memory.db），有库的那个优先；
//   3. 两个都有库 → 按体积判一次再决定（见下），不静默搬家；
//   4. 都没有 → 用新家并新建。
//
// 第 2 条是这套兼容的全部要点：判据是「有没有 memory.db」，不是「目录在不在」。
// 目录存在但空的（例如某次误跑创建的）不该把用户的主库挡掉。
//
// 第 3 条**不能无条件用新家**：那样任何一次误建都能永久搬走主库——谁在
// `MNEME_HOME` 下跑一次 standalone 或一次测试，新家就长出一个几 MB 的库；下次
// 启动时两边都有库，静默选新的，845MB 那个再也读不到，而且一条日志都没有。
// 「已经迁完的人」和「不小心建了一个」在目录形状上完全一样，只能靠体积分：
// 新库比旧库小到 10% 以下就判为误建，继续用旧库（source=legacy + conflict 读数，
// 调用方据此告警）；体积相当或更大才是真的迁完了，用新家、旧库原地留着。
//
// @module dsh-mneme/paths
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 中性家目录名（`<user home>/<这个>`）。 */
export const MNEME_HOME_DIR = ".mneme";
/** 兼容期仍在读的旧家目录名（DSH 的家）。 */
export const LEGACY_HOME_DIR = ".dsh";
/** 库文件名：判定「这个目录里真有库」的唯一依据。 */
export const DB_FILE = "memory.db";

/** 展开前导 `~`。与 candidates/diary/pipeline-observations 三份私有实现同口径。 */
export function expandHome(p, home = homedir()) {
  const s = String(p ?? "");
  if (s === "~") return home;
  if (s.startsWith("~/") || s.startsWith("~\\")) return join(home, s.slice(2));
  return s;
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}

/**
 * 环境变量取值：按给定顺序取第一个非空的，取不到返回空串。
 *
 * 用于 `MNEME_*` 做主、`DSH_MNEME_*` 降别名的地方——写成 `envFirst("MNEME_X",
 * "DSH_MNEME_X")` 比手写 `a || b || ""` 更不容易在新旧两个名字上漏一个。
 */
export function envFirst(...names) {
  return firstNonEmpty(...names.map((name) => process.env?.[name]));
}

/**
 * 中性家目录。
 *
 * `MNEME_HOME` 是正式名；`DSH_MNEME_HOME` 降成别名（老文档/老脚本里可能出现过，
 * 且 DSH 侧确实可能想把所有 mneme 状态收在一起，两个都认、新名优先）。
 */
export function mnemeHome({ env = process.env, home = homedir() } = {}) {
  const explicit = firstNonEmpty(env?.MNEME_HOME, env?.DSH_MNEME_HOME);
  return explicit ? expandHome(explicit, home) : join(home, MNEME_HOME_DIR);
}

/** 旧家目录（DSH）。只用于存量兼容，不用于新建。 */
export function legacyHome({ env = process.env, home = homedir() } = {}) {
  // DSH_HOME 是宿主自己声明的家；它存在时旧库就在它下面的 memory/。
  const declared = firstNonEmpty(env?.DSH_HOME);
  return declared ? expandHome(declared, home) : join(home, LEGACY_HOME_DIR);
}

/** 新默认库目录：`<mnemeHome>/memory`。 */
export function defaultMemoryDir(opts = {}) {
  return join(mnemeHome(opts), "memory");
}

/** 旧默认库目录：`<legacyHome>/memory`。 */
export function legacyMemoryDir(opts = {}) {
  return join(legacyHome(opts), "memory");
}

/** 这个目录里真的有库吗？（只看 memory.db，不猜） */
export function hasDb(dir) {
  if (typeof dir !== "string" || dir.trim() === "") return false;
  try {
    return existsSync(join(dir, DB_FILE));
  } catch {
    return false;
  }
}

/** 库文件字节数。没有库或读不到都给 0——调用方只做量级比较，不拿它当精确值。 */
export function dbBytes(dir) {
  if (typeof dir !== "string" || dir.trim() === "") return 0;
  try {
    return statSync(join(dir, DB_FILE)).size;
  } catch {
    return 0;
  }
}

/**
 * 人读的字节数（`845.9MB` / `3.2MB` / `912KB`）。
 *
 * 与 `src/runtime/model-fetch.js:327` 那份私有 `kb` 同口径（1024 进制、MB 一位小数）；
 * 分开写是因为那份在下载层内部、不对外导出，为一行格式化去牵手下载模块不值。
 */
export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1048576) return `${(v / 1048576).toFixed(1)}MB`;
  if (v >= 1024) return `${Math.round(v / 1024)}KB`;
  return `${Math.round(v)}B`;
}

/**
 * 新库小到这个比例（相对旧库）就算误建，而不是迁移。
 *
 * 10% 是个经验值：真迁过来的库至少得跟旧库同一个量级，误跑一次长出来的空库
 * 只有几 MB，对着几百 MB 的正式库差着两个数量级，10% 两头都不会误判。
 */
export const MISTAKEN_NEW_DB_RATIO = 0.1;

/**
 * 解析最终的库目录。**所有默认路径都要走这里**，别再各写一份 `"~/.dsh/memory"`。
 *
 * @param {string=} configured 显式配置（config.memoryDir / --memory-dir）
 * @param {{env?: object, home?: string}} [opts]
 * @returns {{dir: string, source: "config"|"env"|"default"|"legacy", conflict?: object}}
 *   source=legacy 时调用方应当告警一句（还住在旧目录，可迁可不迁）。
 *   conflict 存在表示两边都有库、且新库被判为误建，字段 `{nextDir, oldDir,
 *   nextBytes, oldBytes}` 供调用方把两个路径与体积一起打出来。
 */
export function resolveMemoryDir(configured, opts = {}) {
  const { env = process.env, home = homedir() } = opts;

  const fromConfig = typeof configured === "string" ? configured.trim() : "";
  if (fromConfig) return { dir: expandHome(fromConfig, home), source: "config" };

  const fromEnv = firstNonEmpty(env?.MNEME_MEMORY_DIR, env?.DSH_MNEME_MEMORY_DIR);
  if (fromEnv) return { dir: expandHome(fromEnv, home), source: "env" };

  const nextDir = defaultMemoryDir({ env, home });
  const oldDir = legacyMemoryDir({ env, home });

  const nextHas = hasDb(nextDir);
  const oldHas = hasDb(oldDir);

  if (nextHas && oldHas) {
    const nextBytes = dbBytes(nextDir);
    const oldBytes = dbBytes(oldDir);
    // 两边都有库。体积分不开「迁完了」和「不小心建了一个」就只能静默搬家，
    // 而静默搬家的后果是主库永久读不到——所以这里必须判一次。
    if (oldBytes > 0 && nextBytes < oldBytes * MISTAKEN_NEW_DB_RATIO) {
      return {
        dir: oldDir,
        source: "legacy",
        conflict: { nextDir, oldDir, nextBytes, oldBytes }
      };
    }
    return { dir: nextDir, source: "default" };
  }
  if (nextHas) return { dir: nextDir, source: "default" };
  if (oldHas) return { dir: oldDir, source: "legacy" };
  return { dir: nextDir, source: "default" };
}

/**
 * 解析出的库目录（只要字符串）。旁挂目录（candidates/proposals/observations/diaries）
 * 都从这一处取基座，别再各自抄 `"~/.dsh/memory"`——抄一次，默认值就多一个漂移面。
 */
export function memoryBase(configured, opts = {}) {
  return resolveMemoryDir(configured, opts).dir;
}

/**
 * 解析结果要不要说句话？说什么？
 *
 * 消息文案放在这里而不是各入口各写一份：daemon（src/serve.js）与宿主（src/index.js）
 * 走的是同一个 `resolveMemoryDir`，同一次误建不该一个喊、一个不喊——而误建恰恰常从
 * daemon/测试那边发生，只有宿主告警等于漏掉一半现场。
 *
 * @param {{dir: string, source: string, conflict?: object}} resolved
 * @returns {{level: "warn"|"info", message: string}|null}
 */
export function explainResolution(resolved) {
  if (!resolved || typeof resolved !== "object") return null;
  if (resolved.conflict) {
    const { nextDir, oldDir, nextBytes, oldBytes } = resolved.conflict;
    return {
      level: "warn",
      message:
        `[dsh-mneme] 检测到新建的空库，仍在用旧库 ${oldDir}（${fmtBytes(oldBytes)}）。` +
        `新家那边有个 ${nextDir}（${fmtBytes(nextBytes)}），小到不像迁过来的库。` +
        "若你确实已经迁到新家，显式设 MNEME_MEMORY_DIR 或 memoryDir 指向它即可。"
    };
  }
  if (resolved.source === "legacy") {
    return {
      level: "info",
      message:
        `[dsh-mneme] 记忆库仍住在旧目录 ${resolved.dir}（这里已有 memory.db）。` +
        "迁到中性家可用 MNEME_HOME，或把 memoryDir 指过去；不迁也能正常用。"
    };
  }
  return null;
}

/**
 * 运行时/模型缓存的默认根，同样搬到中性家下。
 *
 * 这两处是**缓存**不是数据：缓存目录丢了会重下（200MB 量级），不会丢用户内容，
 * 所以兼容规则比库简单——旧目录存在就继续用它，避免白白重下；不存在才用新家。
 *
 * 名字刻意与 runtime/layout.js 的 defaultRuntimeDir / defaultModelCacheDir 区分：
 * 那两个是**对外契约**（local-embedder / reranker / verify 都从那里取），这里是
 * 它们背后的解析实现，别造第二份同名字面量。
 */
export function resolveRuntimeDir({ env = process.env, home = homedir() } = {}) {
  // 旧缓存挂在**旧家**下，而旧家可以是 DSH_HOME 指定的地方，不一定等于
  // `join(home, ".dsh")`：宿主声明了 DSH_HOME 却没给它建 junction 时，写死
  // `join(home, ".dsh")` 会让这 200MB 缓存当成不存在、白重下一遍。所以走
  // legacyHome()，与库那边同一个真源。
  const next = join(mnemeHome({ env, home }), "runtime");
  const old = join(legacyHome({ env, home }), "mneme", "runtime");
  return existsSync(old) && !existsSync(next) ? old : next;
}

export function resolveModelCacheDir({ env = process.env, home = homedir() } = {}) {
  const next = join(mnemeHome({ env, home }), "models");
  const old = join(legacyHome({ env, home }), "mneme", "models");
  return existsSync(old) && !existsSync(next) ? old : next;
}
