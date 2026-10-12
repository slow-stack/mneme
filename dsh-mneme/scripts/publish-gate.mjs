// 发布闸门：publish 步之后**必须**确认这个版本真的能被 registry 看见，看不见就整轮失败。
//
// 为什么需要它：原先这一步是
//   echo "Published: $(npm view "@modusensus/dsh-mneme@${V}" version)"
// 命令替换里的失败**不会**让 `set -e` 退出。v0.8.16 那次日志白纸黑字写着
// `npm error code E404 / 404 No match found for version 0.8.16`，step 与 job 却都是绿的。
// 也就是说「真发不出去」（token 失效、权限不足、npm 侧拒绝）与「发出去了」在 CI 上是同一种
// 颜色，只有人翻日志才看得出来 —— 闸门的意义恰恰是没人翻日志的时候。
//
// 为什么是轮询而不是一次性查询：registry 有传播延迟，v0.8.16 实测 publish 到可见约 4.5 分钟
// （11:15:52Z → 11:20:22Z）。一次性查询只有两种结局：忽略失败（就是现在的假绿），或者拿传播
// 延迟当发布失败（假红）。幂等跳过那条路径（版本已存在）**首次探测即通过**，所以只有真发新版
// 才付等待成本。
//
// 为什么探测走 registry 公开 HTTP 面而不是 `npm view`：不依赖 .npmrc 里的 token、不依赖 npm CLI
// 的 E404 语义，而且能把「还没传播」与「网络异常」分开报出来 —— 两种都重试，但日志里要能区分，
// 否则排障时又得靠猜。
//
// 与 scripts/changelog-prep.mjs 同一个理由：逻辑收在可注入的模块里才测得到（probe/sleep/now 全
// 可注入，单测零网络零等待），入口只负责读参数与决定退出码。

import { pathToFileURL } from "node:url";

export const PACKAGE_NAME = "@modusensus/dsh-mneme";
export const REGISTRY_ORIGIN = "https://registry.npmjs.org";

/** 默认 10 分钟：实测传播 ~4.5 分钟，留一倍余量；超时=发布失败，宁可红也不许假绿。 */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** 默认 15 秒：一次发布最多 40 次探测，日志行数与 registry 负载都可接受。 */
export const DEFAULT_INTERVAL_MS = 15 * 1000;
/** 单次探测的 HTTP 超时：挂死的请求必须自己失败，不能吃掉整段预算。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 15 * 1000;

/**
 * 单版本的 registry URL。scoped 包名必须整体 encodeURIComponent（`@scope/name` → `%40scope%2Fname`）：
 * 直接拼裸 `/` 会被当成路径分隔符，registry 回 404 —— 那正是「闸门自己造成的假红」。
 */
export function versionUrl(name, version, origin = REGISTRY_ORIGIN) {
  return `${origin.replace(/\/+$/, "")}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
}

/**
 * 探测一次「该版本是否已在 registry 上」。
 *
 * 永不抛错：任何异常都折成 `{ok:false, reason, detail}`，让上层的重试与超时逻辑保持单一形状。
 * `reason` 取值：`missing`(404，多半是还没传播) / `network`(请求本身失败) / `http`(非 2xx/404) /
 * `bad-json` / `mismatch`(200 但版本号对不上)。
 *
 * @param {string} version 如 "0.8.16"
 * @param {{name?: string, origin?: string, fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 * @returns {Promise<{ok: true, version: string, tarball: string} | {ok: false, reason: string, detail: string}>}
 */
export async function probeVersion(version, {
  name = PACKAGE_NAME,
  origin = REGISTRY_ORIGIN,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS
} = {}) {
  const url = versionUrl(name, version, origin);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    return { ok: false, reason: "network", detail: `请求失败：${error?.message ?? error}（${url}）` };
  }
  if (response.status === 404) {
    return { ok: false, reason: "missing", detail: `HTTP 404，registry 上还看不到（${url}）` };
  }
  if (!response.ok) {
    return { ok: false, reason: "http", detail: `HTTP ${response.status}（${url}）` };
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    return { ok: false, reason: "bad-json", detail: `响应不是 JSON：${error?.message ?? error}` };
  }
  if (body?.version !== version) {
    return { ok: false, reason: "mismatch", detail: `registry 返回的版本是 ${body?.version ?? "(缺失)"}` };
  }
  return { ok: true, version, tarball: body?.dist?.tarball ?? "" };
}

/**
 * 轮询到版本可见为止；超时即 `{ok:false, reason:"timeout"}`。
 *
 * 契约（单测锁的就是这条）：**看不见就绝不返回 ok:true**。任何把超时折叠成成功、或者把
 * 「探测失败」当成「跳过校验」的改法，都等于退回 v0.8.16 那种假绿。
 *
 * @param {string} version
 * @param {{name?: string, origin?: string, timeoutMs?: number, intervalMs?: number,
 *          now?: () => number, sleep?: (ms: number) => Promise<void>,
 *          probe?: () => Promise<{ok: boolean, detail?: string}>, log?: (line: string) => void}} [options]
 */
export async function waitForPublished(version, {
  name = PACKAGE_NAME,
  origin = REGISTRY_ORIGIN,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  probe = () => probeVersion(version, { name, origin }),
  log = () => {}
} = {}) {
  const startedAt = now();
  let attempts = 0;
  let lastError = "";
  for (;;) {
    attempts += 1;
    const result = await probe();
    // 探测成功即算通过，**不再回头比期限**：预算是「等多久才放弃」，不是「多久之后就算没发布」。
    // 单次探测自带 HTTP 超时（默认 15 秒），所以晚到的成功最多超出预算十几秒；而版本真的在
    // registry 上就等于发布成功，因为晚到几秒把它判红才是假红——这个闸门存在的理由正是消灭
    // 假绿，不该顺手制造另一种失真。反过来，探测失败仍严格按预算收口（见下）。
    if (result?.ok) {
      return { ok: true, version, attempts, waitedMs: now() - startedAt, tarball: result.tarball ?? "" };
    }
    lastError = result?.detail ?? "未知原因";
    const waitedMs = now() - startedAt;
    log(`第 ${attempts} 次探测（已等 ${Math.round(waitedMs / 1000)}s）：${lastError}`);
    if (waitedMs >= timeoutMs) {
      return { ok: false, reason: "timeout", attempts, waitedMs, lastError };
    }
    // 只睡到预算耗尽为止：最后一次探测落在超时点上，不额外多睡一整轮。
    await sleep(Math.min(intervalMs, timeoutMs - waitedMs));
  }
}

/**
 * 入口参数：位置参数是版本号，另可覆盖 `--timeout-ms` / `--interval-ms`（排障与手动跑用）。
 * 缺版本号如实回报 `missing-version`，由入口打印用法并退出 1。
 */
export function parseArgs(argv = []) {
  const out = { version: "", timeoutMs: DEFAULT_TIMEOUT_MS, intervalMs: DEFAULT_INTERVAL_MS };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--timeout-ms" || arg === "--interval-ms") {
      const key = arg === "--timeout-ms" ? "timeoutMs" : "intervalMs";
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) return { ok: false, reason: `${arg} 需要一个正数` };
      out[key] = value;
      i += 1;
      continue;
    }
    positional.push(arg);
  }
  if (positional.length !== 1) return { ok: false, reason: "missing-version" };
  out.version = positional[0];
  return { ok: true, ...out };
}

/** 入口：CI 与手动都用它；失败一律 `process.exit(1)`，绝不吞掉。 */
export async function main(argv = process.argv.slice(2), {
  log = console.log,
  error = console.error,
  wait = waitForPublished
} = {}) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    error(`用法：node scripts/publish-gate.mjs <版本号> [--timeout-ms 600000] [--interval-ms 15000]`);
    error(`参数有误：${parsed.reason}`);
    return 1;
  }
  log(`等待 ${PACKAGE_NAME}@${parsed.version} 在 registry 上可见（最多 ${parsed.timeoutMs / 1000}s）…`);
  const result = await wait(parsed.version, {
    timeoutMs: parsed.timeoutMs,
    intervalMs: parsed.intervalMs,
    log
  });
  if (!result.ok) {
    error(
      `发布闸门未通过：${PACKAGE_NAME}@${parsed.version} 在 ${Math.round(result.waitedMs / 1000)}s 内` +
      `（${result.attempts} 次探测）始终看不到 —— 最后一次：${result.lastError}`
    );
    error(`publish 步很可能失败了（token 失效 / 权限不足 / npm 侧拒绝），请翻上面 publish 步的日志。`);
    return 1;
  }
  const waitedSec = Math.round(result.waitedMs / 1000);
  log(`✓ ${PACKAGE_NAME}@${result.version} 已在 registry 上可见（第 ${result.attempts} 次探测，等了 ${waitedSec}s）`);
  if (result.tarball) log(`  tarball: ${result.tarball}`);
  return 0;
}

// import 即执行会让单测没法只 import 纯函数（changelog-prep.mjs 的同一教训），故用主模块判别。
// 比较用 pathToFileURL：手拼 `file://${argv[1]}` 在本机（Windows 盘符 + 非 ASCII 路径）拼不出合法 URL，
// 判别会恒假 —— 那样的失败是静默的：脚本什么也不做，还退出 0。
//
// 用 `process.exitCode` 而不是 `process.exit()`：刚做完 HTTP 请求就硬退，会在 Windows 上撞到
// libuv 的 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（实测 0.8.16 成功路径复现），
// 退出码变成 0xC0000409 而不是 0 —— 一个把成功报成崩溃的退出路径，正好与本次要修的假绿同类。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
