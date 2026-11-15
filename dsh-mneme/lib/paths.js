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
//   3. 两个都有库 → 用新家（用户已经迁过来了），旧目录原样留着不删；
//   4. 都没有 → 用新家并新建。
//
// 第 2 条是这套兼容的全部要点：判据是「有没有 memory.db」，不是「目录在不在」。
// 目录存在但空的（例如某次误跑创建的）不该把用户的主库挡掉。
//
// @module dsh-mneme/paths
import { existsSync } from "node:fs";
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

/**
 * 解析最终的库目录。**所有默认路径都要走这里**，别再各写一份 `"~/.dsh/memory"`。
 *
 * @param {string=} configured 显式配置（config.memoryDir / --memory-dir）
 * @param {{env?: object, home?: string}} [opts]
 * @returns {{dir: string, source: "config"|"env"|"default"|"legacy"}}
 *   source=legacy 时调用方应当告警一句（还住在旧目录，可迁可不迁）。
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

  // 两个都有库 → 用户已经迁过，用新家；旧目录留着不动（我们不删任何东西）。
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
  // 缓存只看 home，不跟 DSH_HOME 走：这是**给定 home 就要确定**的纯函数，
  // 否则测试传一个假 home 也会被机器上的 DSH_HOME 带偏。真实机器上
  // `~/.dsh` 通常就是指向 DSH 家的 junction，existsSync 照样命中。
  const next = join(mnemeHome({ env, home }), "runtime");
  const old = join(home, ".dsh", "mneme", "runtime");
  return existsSync(old) && !existsSync(next) ? old : next;
}

export function resolveModelCacheDir({ env = process.env, home = homedir() } = {}) {
  const next = join(mnemeHome({ env, home }), "models");
  const old = join(home, ".dsh", "mneme", "models");
  return existsSync(old) && !existsSync(next) ? old : next;
}
