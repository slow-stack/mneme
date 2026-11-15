// 运行时目录契约（issue #131 / PR-A）
//
// 背景：@huggingface/transformers 及其原生闭包（onnxruntime-node 解包 210 MB、
// onnxruntime-web 128 MB、sharp 19 MB）只要留在插件的 dependencies 里，就会进
// 宿主 profile 的安装图。profile 是所有插件共用的依赖图，于是「装任何插件都要替
// 它重走一遍这条链」，弱网下直接把安装卡死。本模块定义插件自管运行时的落地契约，
// 让这份运行时与宿主依赖图解耦。
//
// 只有三件事是稳定契约，其余实现都可以换：
//
//   <runtimeDir>/<payloadId>/mneme-runtime.json   来源与版本清单
//   <runtimeDir>/<payloadId>/node_modules/        扁平依赖闭包（与 hoisted 同形）
//   <runtimeDir>/<payloadId>/node_modules/@huggingface/transformers/dist/transformers.node.mjs
//
// 为什么必须是「扁平 node_modules」：transformers.node.mjs 内部全是裸导入
// （`import sharp from "sharp"`、`import * as ONNX_NODE from "onnxruntime-node"`），
// 它们相对该文件自身位置解析。所以只要把闭包按扁平结构放好，再用绝对 file URL
// import 入口，整套就能跑起来——不需要动宿主的 node_modules，也不需要 overrides。
//
// @module dsh-mneme/runtime/layout
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveModelCacheDir, resolveRuntimeDir } from "../paths.js";

/** 运行时清单文件名，与 payload 目录同级。 */
export const RUNTIME_MANIFEST = "mneme-runtime.json";
/** 唯一会被本插件 import 的入口：transformers 的 Node 构建。 */
export const TRANSFORMERS_ENTRY =
  "node_modules/@huggingface/transformers/dist/transformers.node.mjs";
/**
 * 结构检查要求的包。三个都是硬要求：
 * - @huggingface/transformers 是入口本身；
 * - onnxruntime-node 被 Node 构建顶层 import；
 * - sharp 也被 Node 构建顶层 `import sharp from "sharp"`，缺了入口 import 就抛。
 */
export const REQUIRED_PACKAGES = ["@huggingface/transformers", "onnxruntime-node", "sharp"];
/** 认可的 transformers 版本区间：peer 提案的 >=4.2.0 <5（见 issue #131）。 */
export const TRANSFORMERS_MIN = [4, 2, 0];
export const TRANSFORMERS_MAX_MAJOR = 5;

/**
 * 解析 major.minor.patch。解析不出来返回 null —— 这里刻意不抛错，
 * 让调用方把「版本读不懂」当成一条可报告的失败，而不是异常。
 * @param {unknown} value - 版本字符串。
 * @returns {number[]|null} [major, minor, patch] 或 null。
 */
function parseVersion(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ""));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 三元版本比较：a < b 返回负数。 */
function compareVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * 版本是否落在认可区间内。
 *
 * 刻意只实现「>=TRANSFORMERS_MIN <TRANSFORMERS_MAX_MAJOR」这一条区间，
 * 不是通用 semver —— 运行时要认的只有 transformers 一个包，写通用实现
 * 反而引入没被使用、也没被测试的分支。
 * @param {unknown} version - 待检查版本。
 * @returns {boolean} 是否认可。
 */
export function transformersVersionOk(version) {
  const v = parseVersion(version);
  if (v === null) return false;
  if (v[0] >= TRANSFORMERS_MAX_MAJOR) return false;
  return compareVersion(v, TRANSFORMERS_MIN) >= 0;
}

/**
 * 运行时根目录的默认位置。与 embedModelCacheDir 的既有约定保持一致
 * （都挂在 mneme 的中性家下，便于用户整个删掉重来）。
 *
 * 家目录不再是 .dsh：见 src/paths.js 的说明。运行时是**缓存**，所以兼容规则
 * 简单——旧家下有现成的 payload 就继续用它，避免白下 200MB；没有才用新家。
 *
 * `env` 单独一个参数是为了让「旧家在哪」跟着宿主的 DSH_HOME 走（把 DSH_HOME 指到
 * 别处的人，缓存不该被当成不存在而重下）；测试传假 home 时顺手传 `{}` 就能把
 * 机器的 DSH_HOME 挡在外面，不必依赖字段恰好为空。
 * @param {string} [home] - 家目录，测试时可注入。
 * @param {object} [env] - 环境变量表，测试时可注入。
 * @returns {string} 运行时根目录。
 */
export function defaultRuntimeDir(home = homedir(), env = process.env) {
  return resolveRuntimeDir({ home, env });
}

/**
 * 本机 libc —— 且只在**能正面确认**时给出答案，否则 null。
 *
 * 用来在下载闭包时剔掉另一套 libc 的变体（linux-x64 上 `@img/sharp-linuxmusl-x64` 与
 * `sharp-libvips-linuxmusl-x64` 加起来十几 MB，glibc 机器一辈子用不到；评审建议做，
 * 收益真实）。
 *
 * 为什么只认「正面确认的 glibc」：Node 的 report 里 glibcVersionRuntime 为空时无法区分
 * 「musl」与「这份 Node 没报」，而猜错的方向（把 glibc 变体滤掉、装上 musl 变体）会得到
 * 一份必然 import 不起来的运行时，且本仓库没有 Linux 机器能验证这条路径。所以拿不到证据
 * 就不过滤：Alpine 用户多下十几兆，但没人会因此装坏。
 * @param {string} [platform] - 目标平台；只在「就是本机且是 linux」时才可能给出答案。
 * @returns {"glibc"|null} 确认到的 libc。
 */
export function detectLibc(platform = process.platform) {
  // 目标平台不是本机（比如在 win32 上为 linux 生成/统计）时，本机 report 毫无意义。
  if (platform !== "linux" || platform !== process.platform) return null;
  try {
    const glibc = process.report?.getReport?.()?.header?.glibcVersionRuntime;
    return typeof glibc === "string" && glibc !== "" ? "glibc" : null;
  } catch {
    return null;
  }
}

/**
 * 本地模型的默认缓存目录。
 *
 * 收在这里是因为它必须**唯一**：embedder、reranker、verify 三方若各写一份字面量，
 * 一旦漂移，verify 就会拿另一份模型去验证，验证结果不再是运行时的真实证据。
 * @param {string} [home] - 家目录，测试时可注入。
 * @param {object} [env] - 环境变量表，测试时可注入（见 defaultRuntimeDir）。
 * @returns {string} 模型缓存目录。
 */
export function defaultModelCacheDir(home = homedir(), env = process.env) {
  return resolveModelCacheDir({ home, env });
}

/**
 * 一个 payload 的目录名。带平台与架构，因此多份可以共存，
 * 加载器按平台挑一份可用的即可。
 * @param {{version: string, platform?: string, arch?: string}} opts - 版本与平台。
 * @returns {string} 形如 transformers-4.2.0-node-win32-x64。
 */
export function payloadId({ version, platform = process.platform, arch = process.arch }) {
  return `transformers-${version}-node-${platform}-${arch}`;
}

/** payload 目录。@param {string} runtimeDir @param {string} id @returns {string} */
export function payloadDir(runtimeDir, id) {
  return join(runtimeDir, id);
}

/** payload 内的扁平依赖目录。@param {string} dir @returns {string} */
export function nodeModulesDir(dir) {
  return join(dir, "node_modules");
}

/** 清单文件路径。@param {string} dir @returns {string} */
export function runtimeManifestPath(dir) {
  return join(dir, RUNTIME_MANIFEST);
}

/**
 * 读取 JSON，读不到或解析失败都返回 undefined（结构检查不应因缺文件而抛错）。
 * @param {string} file - 文件路径。
 * @returns {any|undefined} 解析结果。
 */
export function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * 归一清单里记下的完整性结论。
 *
 * 为什么要有这一处：这个字段有两种形态 —— 下载通道写的是 `{status, checked, detail}` 对象，
 * 而收编来的历史清单根本没有它。判据（verify）与投影（loader）各自猜形状就出过真事故
 * （issue #268：判据只认 `"sha512-matched"`，下载档写的 `"verified"` 进去恒判失败，
 * 而 loader 又把那个对象直接当字符串外发）。形状归一收在这里，两边都只调它。
 *
 * 它只回答「清单里声称什么」，不重新验算 —— 原始 tarball 落盘后就没了，重算无从谈起。
 *
 * 形状非法（`false` / `0` / `[]` / `{}` / `{status: 5}` 这类）给 `"malformed"`：判据不认
 * 它，于是 fail-closed。这类值既不能证明一致、也不是「没记录过」，按 ok:true 放行等于把
 * 形状错误读成「已经验过了」（#269 评审）。
 *
 * @param {unknown} recorded - 清单里的 integrity 字段。
 * @returns {{status: string, detail: string|null}} 状态词；缺失（null/undefined）为 "unverified"。
 */
export function recordedIntegrity(recorded) {
  const asStatus = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
  if (recorded === undefined || recorded === null) return { status: "unverified", detail: null };
  if (typeof recorded === "string") return { status: asStatus(recorded) ?? "unverified", detail: null };
  if (typeof recorded !== "object" || Array.isArray(recorded)) {
    const shape = Array.isArray(recorded) ? "array" : typeof recorded;
    return { status: "malformed", detail: `integrity 字段形状非法（${shape}），无法据此判定` };
  }
  const status = asStatus(recorded.status);
  if (!status) return { status: "malformed", detail: "integrity 对象里没有可用的 status" };
  return { status, detail: typeof recorded.detail === "string" ? recorded.detail : null };
}

/**
 * 列出运行时根目录下所有 payload 目录（名称排序）。目录不存在返回空数组。
 * 加载器用它挑候选，再逐个 describePayload 判断可用性。
 * @param {string} runtimeDir - 运行时根目录。
 * @returns {string[]} payload 目录名。
 */
export function listPayloadDirs(runtimeDir) {
  try {
    return readdirSync(runtimeDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 结构检查：这份 payload 是否至少「该有的文件都在」。
 *
 * 它故意不做功能验证（真 import 并跑一次推理）——那一步要看运行环境，
 * 由 verify 模块负责。这里只回答「解压完整没有、版本对不对、平台对不对」，
 * 用来在下载/搬运之后立刻发现缺件。
 * @param {string} dir - payload 目录。
 * @param {{platform?: string, arch?: string}} [opts] - 目标平台。
 * @returns {{dir: string, ok: boolean, version: string|null, manifest: any, missing: string[], reasons: string[]}}
 */
export function describePayload(dir, { platform = process.platform, arch = process.arch } = {}) {
  const report = {
    dir,
    ok: false,
    version: null,
    manifest: readJsonSafe(runtimeManifestPath(dir)),
    missing: [],
    reasons: []
  };

  const nm = nodeModulesDir(dir);
  if (!existsSync(nm)) {
    report.reasons.push(`node_modules 不存在：${nm}`);
    return report;
  }

  // 1) 必需包逐个点名 —— 缺哪个报哪个，用户能照着单子手工补。
  for (const name of REQUIRED_PACKAGES) {
    if (!existsSync(join(nm, name, "package.json"))) report.missing.push(name);
  }

  // 2) 版本必须落在认可区间（装了别的 major 的闭包，行为不可预期）。
  const transformers = readJsonSafe(join(nm, "@huggingface/transformers", "package.json"));
  report.version = transformers?.version ?? null;
  if (transformers !== undefined && !transformersVersionOk(transformers.version)) {
    report.reasons.push(
      `@huggingface/transformers@${transformers.version} 不在认可区间（>=${TRANSFORMERS_MIN.join(".")} <${TRANSFORMERS_MAX_MAJOR}）`
    );
  }

  // 3) 入口文件本身（前面只确认了包目录在）。
  if (!existsSync(join(dir, TRANSFORMERS_ENTRY))) report.missing.push(TRANSFORMERS_ENTRY);

  // 4) onnxruntime-node 一个包内含多平台 × 多架构的二进制，裁剪或跨机搬运时最容易只留下
  //    别的平台/架构。必须点名到**平台 + 架构**：真实包结构是
  //    bin/napi-v6/{darwin,linux,win32}/{arm64,x64}，只查平台的话 linux-arm64 的 payload
  //    在 linux-x64 上也会通过结构检查，被 loader 选中后才在 import 原生模块时失败。
  const nativeDir = join(nm, "onnxruntime-node", "bin", "napi-v6", platform, arch);
  if (existsSync(join(nm, "onnxruntime-node")) && !existsSync(nativeDir)) {
    report.reasons.push(
      `onnxruntime-node 缺少 ${platform}/${arch} 的二进制子树（bin/napi-v6/${platform}/${arch}）`
    );
  }

  report.ok = report.missing.length === 0 && report.reasons.length === 0;
  return report;
}
