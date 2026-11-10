import { URL } from "node:url";
import { isAbsolute } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { timingSafeEqual, randomBytes } from "node:crypto";

import { TYPES } from "./store.js";
import { TYPE_FILE, renderMirrorText, renderFileHeader, parseHumanEdits, MIRROR_READONLY_TYPES } from "./mirror.js";
import { langOf } from "./lang.js";
// issue #607：面板空态要显示「能直接粘贴就跑」的命令，而面板 bundle 拿不到
// CLI 入口路径（独立 bundle 不能 import src）——所以由这条路由把命令算好发给它。
import { choroCliCommandFrom } from "./wiki/cli-hint.js";
// op 形状谓词单一份（评审 P3：两份皮会让形状修洞漏一边）。
import { isValidFactOps } from "./profile-facts.js";
import { computeHeat } from "./heat.js";
import { EFFORT_REJECT_RE, describeStreamFailure, resolveRoute, withEffortFallback } from "./dream.js";
// Issue #521：面板要按归一化原因显示 skipped，归一化只有一份实现（住在
// decisions.js，与产生这些 error 的校验器同一文件，避免措辞漂移）。
import { summarizeSkipped } from "./dream/decisions.js";
import { getInjectionSnapshot } from "./inject.js";
import { invalidPeakSpecs } from "./peak-hours.js";
import { renderUserSettingsBlock } from "./user-settings.js";
import { parseProvenanceSelector, provenanceReply } from "./provenance-http.js";
import { describeLocalRuntime, publicRuntimeStatus } from "./runtime/loader.js";
import { hostModulesDir, provisionRuntime } from "./runtime/provision.js";
import { classify, fetchLatestVersion, PACKAGE_VERSION } from "./version-check.js";
import { parseReclaimQuery, parseReclaimJson, readReclaimFields, reclaimReply, RECLAIM_UNAVAILABLE } from "./reclaim-http.js";
// Issue #386 第 6 条：从目录引导（bootstrap）在面板侧也要有入口。协议层口径只在
// bootstrap-http.js 里写一份，与 Bearer 数据面共用（#411 那条纪律：两张皮只许剩
// 鉴权与路径不同）。
import { parseBootstrapJson, readBootstrapDir, bootstrapReply, BOOTSTRAP_UNAVAILABLE } from "./bootstrap-http.js";
import { bootstrapFromDirectory } from "./bootstrap.js";
// Issue #386 第 7 条：面板能改的键 vs schema 里存在的键，两份清单的唯一算法在这里。
// 这里引的是同一份（不是照抄），谁改白名单都对得上。
import { describeConfigKeys, flagKeysFromSpec } from "./config-keys.js";
import { parseShareBody, shareReply, shareFilename, parseReceiveBody, receiveReply, parseUndoBody, undoReply } from "./share-http.js";
// 知识库第二层（契约 §3.6）：路径表与 handler 全在 kb/routes.js 里，本文件只负责
// 把 kbGate 与基础设施递进去。**不在这里登记任何 /kb/* 路径**——registrar 对重复的
// kind+path 直接抛，插件会起不来。
import { registerKbRoutes } from "./kb/routes.js";
import { readPipelineDoc, loadPipelines, projectPipelineDir } from "./pipeline.js";
import { loadRunsById, runsDir, RUNS_SUFFIX } from "./pipeline-runs.js";
import { observationDir, loadObservationsById } from "./pipeline-observations.js";
import { projectKey } from "./candidates.js";
// 日记本（v0.13）：读侧三件（列表/正文/账本）在 diary/index.js 里都是纯函数级的小实现，
// 路由只做参数校验与闸门——把口径写在这里会让「面板与 CLI 读的是同一份」破功。
import {
  diaryDir, listDiaries, readDiary, exportDiary,
  // 跨桶清单（左侧「ta 的日记」面板）：它拿不到当前会话的项目，只能整体读。
  // isBucketName 也走同一处：清单与单篇读取必须用同一道判据，否则会出现
  // 「列得出来、点进去 400」。
  listDiaryLibrary, readLibraryEntry, isBucketName
} from "./diary/index.js";
import { readCandidateDoc } from "./candidates.js";
// M.O. 自动沉淀：/nudge 是 pipeline-nudge.js 的第一个运行时消费者（此前它只有测试在用，
// 是个孤儿模块——「不能自动沉淀工作流」的根因）。
import {
  resolveProjectSessionDir,
  nudgeForProject,
  NUDGE_BOUNDARIES,
  NUDGE_AUTO_BUDGET_MS
} from "./pipeline-nudge.js";

// 面板空态与 409 hint 共用的 CLI 命令串（#607）：本文件在 src/ 与 lib/ 同一层，
// 模块加载时推导一次。推导不出时为 null，两处各自退回通用说法。
const CHORO_CLI = choroCliCommandFrom(import.meta.url, "<repo>");

// headers：少数端点（/export 附件下载）需要追加 Content-Disposition 等响应头。
function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(payload));
}

// 附件下载响应（导出端点）：Content-Type 与文件名（含日期后缀）由调用方给定。
function sendAttachment(res, status, contentType, filename, body) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${filename}"`
  });
  res.end(body);
}

// 版本号统一从 version-check.js 取（同一份读 package.json 逻辑，读取失败
// 同样降级 "unknown"）——/info 与 /version-check 两个路由共用，不再各写一份。

// Defaults for the standalone external API — keep in step with the schema
// defaults in config.js (externalApiPort / externalApiHost).
const EXTERNAL_API_DEFAULTS = { enabled: false, port: 8790, host: "127.0.0.1" };

// 请求体上限（防御，不是功能）：readBody 只累加字符串，不设上限时一个超大 body
// 就能把进程内存拉到 Content-Length 那个量级。4 MiB 远高于任何真实写入（记忆
// 正文、导入的 markdown、面板 patch 都远小于它）。
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
// 分页上界（防御）：list/search 的参数直接进 SQL LIMIT，无上界时
// ?limit=100000 会让一次免鉴权 GET 把全库序列化出来（2026-10 审计：免鉴权读面
// + 浏览器简单请求 = 廉价 DoS）。1000/200 远高于面板与 CLI 的任何真实用法。
const MAX_PAGE_LIMIT = 1000;
const MAX_SEARCH_TOP_K = 200;

/** Merge persisted external-api kv over the defaults for client display. */
function fullExternalConfig(kv = {}) {
  return {
    enabled: kv.enabled === true,
    port: Number.isInteger(kv.port) && kv.port > 0 ? kv.port : EXTERNAL_API_DEFAULTS.port,
    host: kv.host || EXTERNAL_API_DEFAULTS.host,
    token: kv.token || ""
  };
}

/**
 * Mask an API key for client display: keep a recognizable prefix and suffix,
 * hide the middle. Empty keys stay empty; short keys are fully hidden.
 * The mask only exists in the API layer — storage keeps the real key.
 */
function maskApiKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "***";
  return `${key.slice(0, 3)}***${key.slice(-4)}`;
}

/** True when the request carries the configured apiToken (or no token is set). */
function isAuthorized(req, apiToken) {
  if (!apiToken) return true;
  const raw = req.headers?.authorization ?? req.headers?.["x-dsh-mneme-token"] ?? "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw.trim();
  if (token === "" || token.length !== apiToken.length) return false;
  // Constant-time comparison: avoid leaking the token via timing when the API
  // is exposed beyond loopback.
  return timingSafeEqual(Buffer.from(token), Buffer.from(apiToken));
}

/**
 * 路由鉴权策略（2026-10 审计的结构性修法）。三条：
 *   open        永不鉴权——「公开读面」，必须写进 SECURITY.md 的安全模型表
 *   token       配置了 apiToken 就整条要带（写路由 + 敏感读）
 *   token-write 只有非 GET/HEAD 才要 token（面板要读、只有写才有副作用）
 *
 * 少声明不是「默认开放」：register 直接抛错，插件起不来。这是本方案的要点——
 * 「新增路由忘了加鉴权」从运行期静默漏洞变成装配期硬失败，不依赖谁记得写、也
 * 不依赖测试有没有覆盖到（/export 就是这么漏的，见 2026-10 审计 P0）。
 */
export const ROUTE_POLICIES = Object.freeze(["open", "token", "token-write"]);

/** True when this request must present the apiToken under the route's policy. */
function needsToken(req, policy, apiToken) {
  if (policy === "open") return false;
  const method = String(req.method || "GET").toUpperCase();
  if (policy === "token-write" && (method === "GET" || method === "HEAD")) return false;
  return !isAuthorized(req, apiToken);
}

/**
 * 唯一的登记入口：校验 policy、拒绝重复路径、把 handler 包上鉴权。
 * 返回的 count() 供 createApi 汇报真实路由数（此前的字面量 36 已经和现实脱节）。
 */
export function createRouteRegistrar(webServer, apiToken, disposers) {
  const seen = new Set();
  const register = (route) => {
    if (!ROUTE_POLICIES.includes(route.policy)) {
      throw new Error(
        `[dsh-mneme] 路由 ${route.path} 必须声明 policy（${ROUTE_POLICIES.join(" / ")}），` +
        `实际是 ${JSON.stringify(route.policy)}。先想清楚它属于哪一类，再同步 SECURITY.md 的安全模型表。`
      );
    }
    const key = `${route.kind}:${route.path}`;
    if (seen.has(key)) throw new Error(`[dsh-mneme] 路由 ${key} 被重复登记`);
    seen.add(key);
    const inner = route.handler;
    const handler = (req, res) => {
      if (!needsToken(req, route.policy, apiToken)) return inner(req, res);
      sendJson(res, 401, { error: "unauthorized" });
      return undefined;
    };
    disposers.push(webServer.register({ ...route, handler }));
  };
  return { register, count: () => seen.size };
}


/**
 * Collect the request body as text, or null when it exceeds the cap.
 *
 * 超限时**必须回 null 而不是空串**：空串经 parseBody 变成 {}，而 /profile、
 * /rules、/persona 的 PUT 会把「字段缺失」当成「用户要清空」——一个 5 MiB 的
 * 请求就能把画像/规则/人格静默清掉。返回 null 让调用点在碰任何 store 之前
 * 直接 413（2026-10 评审指出的数据损坏路径）。
 * 连接不 destroy：调用方要能收到明确的 413，而不是被掐断。
 */
function readBody(req, res) {
  return new Promise((resolve) => {
    let body = "";
    let bytes = 0;
    let overflow = false;
    req.on("data", (chunk) => {
      if (overflow) return;
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        overflow = true;
        body = "";
        sendJson(res, 413, { error: "payload-too-large", limit: MAX_REQUEST_BODY_BYTES });
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(overflow ? null : body));
    // 超限后再来 transport error 也必须保留超限状态：否则调用点会拿着空串
    // 继续往 store 写（PUT /persona 把 "" 解析成 {}，覆盖既有设置）。
    req.on("error", () => resolve(overflow ? null : ""));
  });
}

function parseBody(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

// maintenance 是第 9 个位置参数，默认 null：既有调用点（测试里的 14 处）全是位置传参、
// 不传它，必须继续工作——不传时 /maintenance/reclaim 回 503 maintenance-unavailable，
// 而不是把「没接线」伪装成崩溃（#386 第 4 条）。
// choro（M1）：chorography 读侧查询对象（createChoroQueries 产物）。缺省 null =
// 宿主内 API 在 headless/测试环境没有接 queries，choro 路由回 503。它与 service
// 刻意分开传——chorography 的所有权模型与记忆域相反（spec §3），不塞进 service。
// kb（第二层）：知识库装配对象（createKb 产物）。缺省 null = 这个宿主没装它，
// /kb/* 一律 503（装配缺件），与开关关着的 409（用户没开）是两件事。
// diary（v0.13）是第 14 个位置参数，缺省 null：旧调用点（测试里 14 处）继续工作，
// 不传时日记路由一律 503 diary-unavailable（装配缺件），而不是伪装成「用户没开」。
// 与 choro 同一套 503/409 分叉：#497 定下「503 = 环境缺件，409 = 用户没开」。
// 顺序是刻意的：kb 先占第 13 位（它先合进 main），diary 追加在其后，谁先合谁靠前。
export function createApi(ctx, service, settings, commands, embedder, semantic = null, apiToken = "", config = null, maintenance = null, profileExtract = null, choro = null, facts = null, kb = null, diary = null) {
  const disposers = [];

  // #182 注入状态探测：面板状态页的「极简模式下注入按宿主设计关闭」提示需要
  // 知道当前会话的 agentPreset。注入回调在 minimal 下被宿主整体压制（#175 的
  // 定论），不能作为检测源；session/event 是 preset 无关钩子（蒸馏同款），任
  // 何事件都带完整 session 对象。只记最近一次会话头——这是面板展示用的「当前
  // 会话」最佳近似，不是逐会话账本。读法与 scope.js 同源（session.header 冻结
  // 的 SessionHeader，降级 requestHeader().config；agentPreset 取不到留 null，
  // 面板对 null 静默）。任何失败静默：纯可观测性，不新增故障面。
  let lastAgentPreset = null;
  // 会话 → 身份名的账本（人格页与手动写日记用）。lastAgentPreset 只记「最近一次」，
  // 而手动写日记必须知道「这个会话是谁」，否则只能落 default 卡——那正是
  // 「设定好人格的 agent 只以这个人格的口吻写日记」这条需求的缺口。
  // 只存 id → 身份名，容量封顶：会话对象不进这里，避免把大对象挂住。
  const agentBySession = new Map();
  const AGENT_BY_SESSION_MAX = 200;
  try {
    const unsubscribe = ctx.on?.("session/event", (session) => {
      try {
        const header = session?.header ?? session?.requestHeader?.()?.config ?? null;
        const preset = header?.agentPreset;
        const name = typeof preset === "string" && preset.trim() ? preset.trim() : null;
        lastAgentPreset = name;
        const id = typeof session?.id === "string" ? session.id.trim() : "";
        if (id) {
          // 先删再插：Map 的迭代顺序即「最近活跃」，满了就淘汰最旧的键。
          agentBySession.delete(id);
          agentBySession.set(id, name);
          while (agentBySession.size > AGENT_BY_SESSION_MAX) {
            agentBySession.delete(agentBySession.keys().next().value);
          }
        }
      } catch { /* 观测失败不影响会话流 */ }
    });
    if (typeof unsubscribe === "function") disposers.push(unsubscribe);
  } catch { /* 宿主无 session/event 时面板提示退化为「未知」，不报错 */ }

  // webServer 在 index.js 的 inject 声明中（cordis 等宿主服务就绪后 apply），
  // 这里做防御性读取：cordis ctx 的 Proxy 不允许直接访问未 inject 的属性
  // （会抛 "cannot get property without inject"），用 ctx.reflect.get 免
  // inject 读取（未提供返回 undefined）；对象字面量 mock ctx（测试）没有
  // reflect，退回直接属性访问。createApi 只在有 webServer 时被调用（index.js
  // 守卫 + 测试 mock），故下方 register 用之非空。
  const webServer = typeof ctx.reflect?.get === "function" ? ctx.reflect.get("webServer") : ctx.webServer;

  // feature flags 快照（GET/PUT 共用）：overrides 是持久化的用户显式覆盖；
  // effective 是启动配置在白名单键上被 overrides 覆盖后的最终值。config 缺席
  // （旧调用方直连、未传 cfg）时只报被覆盖的键，不把不存在的默认值编造给前端。
  //
  // pendingRestart 回答的是第三个问题：「我改的开关，现在真的生效了吗？」
  // 功能开关的生效节奏与 panel_mode 相同——启动时由 index.js 合并进 cfg，运行中
  // 那份 cfg 是冻结的（见 index.js 装配处的注释）。于是面板显示「已改」不等于
  // 运行时已改：#481 实测人格总闸正是这样，面板开着、人格段却不注入，用户只能
  // 靠反复试错发现。effective 表达的是「运行时取什么值」（overrides 优先），
  // **反推不出待重启**，必须另比一次冻结值——这是本字段存在的唯一理由。
  // 只报「显式覆盖 ≠ 冻结值」的键：未被覆盖的键运行时值就是 cfg 值，不存在落差；
  // config 缺席（旧调用方直连、未传 cfg）时无从比较，返回空数组而不编造。
  // 顺序见 config-keys.js 的 flagKeysFromSpec（booleans → ints → numbers → strings
  // → urls → enums）。这张表曾经在这里手拼一遍，第 7 条把「面板能改哪些键」做成
  // 对外清单之后，两处各算一份就会立刻分歧——所以搬进模块，这里只引。
  const flagKeys = flagKeysFromSpec();
  // 嵌套键在 kv 里按点号平铺（"memoryQualityFilter.enabled"），运行时 cfg 里
  // 是嵌套对象，effective 从对象子字段取值；其余键照旧从 cfg 顶层取。
  // 这张表必须与 settings.js 白名单里的点号键一一对应：#254 加键时漏了这里，
  // effective 会静默少两个键（configFlagValue 取不到 undefined 就不写进去），
  // 面板上看不出来、PUT 也存不进去——test/api.test.js 的计数锁就是钉这件事的。
  const NESTED_FLAG_PATHS = {
    "memoryQualityFilter.enabled": ["memoryQualityFilter", "enabled"],
    "llmAudit.enabled": ["llmAudit", "enabled"],
    "writeAdmission.enabled": ["writeAdmission", "enabled"],
    "writeAdmission.enforce": ["writeAdmission", "enforce"],
    // Issue #380：注入前判定。漏登记的后果是 effective 静默缺键、面板盲——
    // 上面的 round-trip 测试专门锁这张表与白名单成对。
    "preInjectGate.enabled": ["preInjectGate", "enabled"],
    "preInjectGate.enforce": ["preInjectGate", "enforce"],
    // Issue #399：蒸馏原文留存 + 溯源。两个键都是嵌套子字段（enabled 开关 +
    // retentionDays 整数），漏登记的后果同上——effective 静默缺键。
    "distillRecords.enabled": ["distillRecords", "enabled"],
    "distillRecords.retentionDays": ["distillRecords", "retentionDays"],
    // Issue #471：政策轴——作用域级可逆闸门。两个键都是嵌套子字段，漏登记的后果
    // 同上（effective 静默缺键、面板读不到也 PUT 不进）。
    "scopeState.enabled": ["scopeState", "enabled"],
    "scopeState.enforce": ["scopeState", "enforce"],
    // #275 容量预警：三个阈值都是嵌套子字段（两个整数走 INT_RANGES、一个浮点走
    // NUMBER_RANGES），漏登记的后果同上——effective 静默缺键、面板读不到也 PUT 不进。
    "capacityWarning.dbSizeWarnMb": ["capacityWarning", "dbSizeWarnMb"],
    "capacityWarning.archivedRowsWarn": ["capacityWarning", "archivedRowsWarn"],
    "capacityWarning.archivedRatioWarn": ["capacityWarning", "archivedRatioWarn"]
    // sensitiveScanEnabled（#164 A2）是顶层扁平键，不需要进这张表——走 configFlagValue
    // 的默认分支即可。
  };
  function configFlagValue(key) {
    const path = NESTED_FLAG_PATHS[key];
    if (path) return config?.[path[0]]?.[path[1]];
    return config?.[key];
  }
  // 「显式覆盖 ≠ 冻结值」的键。用 Object.is 比而不是 !==：NaN 与 ±0 的边角上
  // 两者会给出相反的结论（Object.is(NaN, NaN) 为真、Object.is(0, -0) 为假），
  // 开关值里虽然不该出现它们，但比较语义与「值是否相同」对齐更省心。
  // 未被覆盖的键不看：它的运行时值本来就取自 cfg，不存在落差。
  function pendingRestartKeys(overrides) {
    if (!config) return [];
    const pending = [];
    for (const key of flagKeys) {
      if (overrides[key] === undefined) continue;
      if (!Object.is(overrides[key], configFlagValue(key))) pending.push(key);
    }
    return pending;
  }
  function featureSnapshot() {
    const overrides = settings.getFeatureFlags();
    const effective = {};
    for (const key of flagKeys) {
      if (overrides[key] !== undefined) effective[key] = overrides[key];
      else {
        const value = configFlagValue(key);
        if (value !== undefined) effective[key] = value;
      }
    }
    // #622 可观测性：错峰时段串解析失败的面板可见化。校验在这里（服务端）做而不在
    // 面板做——parsePeakSpec 只许有一份，面板是独立 bundle 复制一份解析器必然漂移；
    // 与 config-keys 卡「分类在服务端算好、面板只渲染」同一纪律。校验对象是
    // effective（overrides 压过 cfg 后的最终值）：输入框显示的就是它，提示行跟它
    // 对齐——改完保存（PUT 也走 featureSnapshot）提示立即跟着换。GET 与 PUT 共用
    // 本函数，两个字段自动同源。
    const invalidPeakHours = Object.keys(invalidPeakSpecs(effective));
    return { overrides, effective, invalidPeakHours, pendingRestart: pendingRestartKeys(overrides) };
  }

  // Ensure the service has an embedder when the API layer was handed one
  // (tests wire the embedder through the API instead of index.js). Without
  // this, /api/dsh-mneme/search would silently degrade to keyword-only.
  if (embedder && typeof service.setEmbedder === "function") {
    service.setEmbedder(embedder);
  }

  // 所有路由都经这一处登记：policy 必填、鉴权在这里统一判定（见 createRouteRegistrar）。
  const { register, count: countRoutes } = createRouteRegistrar(webServer, apiToken, disposers);

  // /api/dsh-mneme prefix fallback → 404 JSON for unknown sub-paths
  register({
    kind: "prefix",
    path: "/api/dsh-mneme",
    policy: "open",
    handler(req, res) {
      sendJson(res, 404, { error: "not-found" });
    }
  });

  // 反馈入口预填用的插件版本（面板「帮助与反馈」卡片拉取）。读取失败（打包
  // 环境）返回 "unknown"，链接照常可用，纯展示信息不拦截。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/info",
    policy: "open",
    handler(req, res) {
      sendJson(res, 200, { version: PACKAGE_VERSION });
    }
  });

  // 版本自检（#174 后续）：运行版本 vs npm registry latest。只读，宿主围栏
  // 统一鉴权（与 dream-status 同款，面板 apiFetch 直接可用）。registry 查询
  // 全失败时 latest=null、status=unknown——前端对 unknown 完全静默，版本提示
  // 是锦上添花，绝不因它新增故障面。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/version-check",
    policy: "open",
    handler(req, res) {
      if (req.method !== "GET") {
        sendJson(res, 404, { error: "not-found" });
        return;
      }
      fetchLatestVersion()
        .then((latest) => sendJson(res, 200, {
          version: PACKAGE_VERSION,
          latest,
          status: classify(PACKAGE_VERSION, latest),
          checkedAt: new Date().toISOString()
        }))
        .catch(() => sendJson(res, 200, { version: PACKAGE_VERSION, latest: null, status: "unknown" }));
    }
  });

  register({
    kind: "exact",
    path: "/api/dsh-mneme/list",
    policy: "open",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const type = url.searchParams.get("type") ?? undefined;
        // 上界是防御：参数直接进 SQL LIMIT（见 MAX_PAGE_LIMIT 注释）。
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), MAX_PAGE_LIMIT);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        // order=chrono: pure newest-first for paged browsing; default keeps
        // the importance-ranked order other callers rely on.
        const order = url.searchParams.get("order") ?? undefined;
        // minImportance: numeric lower bound on importance (absent/NaN → no
        // floor); source: exact match on the source column (empty → no filter).
        const minRaw = url.searchParams.get("minImportance");
        const minImportance = minRaw !== null && minRaw !== "" && !Number.isNaN(Number(minRaw))
          ? Number(minRaw)
          : undefined;
        const source = url.searchParams.get("source") || undefined;
        // updatedFrom/updatedTo：updated_at 闭区间过滤（ISO 日期或完整时间戳）。
        // 边界归一化在 store 的 updatedAtBounds（list/count 共用同一纯函数）
        // 完成，非法值在那里被忽略——这里原样透传即可。
        const updatedFrom = url.searchParams.get("updatedFrom") ?? undefined;
        const updatedTo = url.searchParams.get("updatedTo") ?? undefined;
        // archived=only：只看归档（状态页的归档列表用）。归档行不进默认列表，
        // 所以这是独立的视图开关，而不是 includeArchived 的混看模式。
        const onlyArchived = url.searchParams.get("archived") === "only";
        // deposited=only：只看 autoDream 巩固过的记忆（receipt_chain 的
        // merge/update verdict ∪ source=dream 直写）——状态页「查看全部」
        // 与记忆库的「沉淀」筛选 chip 共用这个视图。
        const depositedOnly = url.searchParams.get("deposited") === "only";
        // id: 按主键取单条（含归档行）。面板打开/保存前要拿「这一条」的最新值，
        // 分页扫列表最多只能看到前 1000 条，已归档的更不在默认视图里；扫不到就
        // 只能拿陈旧缓存去比对 updated_at，等于没有版本检查。
        const idFilter = (url.searchParams.get("id") ?? "").trim();
        const rows = idFilter === ""
          ? service.list({ type, limit, offset, order, minImportance, source, updatedFrom, updatedTo, onlyArchived, depositedOnly })
          // getById 是裸 SELECT，没有 forgotten 谓词；这条路由是 open 的，
          // 不过滤等于让本机任意进程按 id 读到已遗忘记忆的全文（评审 #1）。
          // 归档行仍要放行：归档 ≠ 遗忘，面板保存前要用它比对 updated_at。
          : [service.getById(idFilter)].filter((memo) => memo && !memo.forgotten);
        // 面板行在 wire DTO 之上补 archived/quality_score——模型工具的输出
        // schema 严格复用 toApiList，扩展只发生在 HTTP 层。
        // heat 投影（阶段二前端数据源）：仅 heatEnabled=true 时下发逐条热度
        // （heat.js 纯函数，λ=0 免疫类型恒 1.0）；字段缺省时前端徽章自动隐藏。
        const heatOn = config?.heatEnabled === true;
        const items = service.toApiList(rows).map((m, i) => ({
          ...m,
          archived: rows[i].archived === true || rows[i].archived === 1,
          quality_score: rows[i].quality_score ?? null,
          // 外来区的包号：抽屉里的「收起这个包」按 pack_id 整批删，寻址键必须由行自己带上。
          // 与 heat 同一个做法——**缺省就不带键**，面板的撤销按钮因此天然自门控。
          // /search 那一面为什么没有这一格，别说错原因：召回侧的候选行内存里带着
          // share_pack_id（searchMemories 只是把 source 盖成渠道名），toApiList 也从不透出这一列；
          // 真正的事实是这层扩展只长在 /list 的答复上，搜索面没有一处代码去补它。所以搜索态
          // 按不了撤销，那条代价写在 docs/SHARE.md 的车道 D 一节。
          // 扩展点留在 HTTP 层而不是 toApiList：模型工具严格复用后者（src/service.js:2094 与
          // MEMORY_ITEM_SCHEMA），给它们加一格没有第二个消费者，却要多改一处 schema 声明。
          ...(rows[i].share_pack_id ? { share_pack_id: rows[i].share_pack_id } : {}),
          ...(heatOn ? { heat: computeHeat(rows[i], Date.now(), config ?? {}) } : {})
        }));
        // Total honors the same filters as the rows, or the pager's
        // has-more math breaks whenever minImportance/source/updated-at
        // bounds are active. 按 id 取单条时总数就是命中的行数。
        const listCountFilters = { minImportance, source, updatedFrom, updatedTo, onlyArchived, depositedOnly };
        const total = idFilter === ""
          ? service.count(type, listCountFilters)
          : rows.length;
        // #597：全库分布（同一份筛选、**不带 type**——带 type 的页数不出其它类）。
        // 面板分类栏的数字源；按 id 取单条时 total 就是行数、分布无意义，这一格
        // 缺省（客户端据此降级回退到页内数）。
        const typeCounts = idFilter === "" ? service.countByType(listCountFilters) : undefined;
        sendJson(res, 200, { items, total, ...(typeCounts ? { typeCounts } : {}) });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // 记忆复用统计（#217，只读聚合）：Top-N 召回 + 僵尸率 + 覆盖度标注。窗口
  // 参数钳制 1-365 天（缺省 30），聚合口径见 service.recallStats；注入命中
  // 率待注入留痕口径拍板后接入。失败走既有 500 JSON 惯例，前端整卡不渲染。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/recall-stats",
    policy: "open",
    handler(req, res) {
      if (req.method !== "GET") {
        sendJson(res, 404, { error: "not-found" });
        return;
      }
      try {
        const url = new URL(req.url, "http://localhost");
        const raw = Number(url.searchParams.get("window"));
        const windowDays = Number.isInteger(raw) && raw >= 1 && raw <= 365 ? raw : 30;
        sendJson(res, 200, service.recallStats({ windowDays }));
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  register({
    kind: "exact",
    path: "/api/dsh-mneme/search",
    policy: "open",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const q = url.searchParams.get("q") ?? "";
        // 上界是防御：topK 直接进召回（见 MAX_SEARCH_TOP_K 注释）。
        const limit = Math.min(Number(url.searchParams.get("topK") ?? url.searchParams.get("limit") ?? 20), MAX_SEARCH_TOP_K);
        // mode selects the recall strategy (defaults to auto):
        //   auto    (default) keyword first, vector fills remaining slots
        //   hybrid  vector first, keyword fills remaining slots; scores of
        //           memories hit by both sides are weight-blended
        //   vector  vector only, falls back to keyword when the vector path
        //           is unavailable (no embedder or a throwing one)
        //   keyword literal text only; never queries the embedder
        // rerank=false disables the cross-encoder reorder for this request;
        // the response `mode` field reports which path actually produced rows.
        const mode = url.searchParams.get("mode") ?? "auto";
        const rerank = url.searchParams.get("rerank") !== "false";
        const query = q.trim();
        if (!query) {
          sendJson(res, 200, { items: [], mode: "keyword" });
          return;
        }
        // Route through the unified semantic pipeline; any vector/rerank
        // failure degrades to keyword results inside searchMemories. The
        // returned promise lets the test double await the async search.
        return Promise.resolve(
          service.searchMemories(query, { mode, topK: limit, useRerank: rerank })
        ).then((rows) => {
          // mode reflects what actually happened: rows marked `vector` came
          // through the semantic path, everything else is keyword fallback.
          const used = rows.some((m) => m.vector === true) ? "vector" : "keyword";
          sendJson(res, 200, { items: service.toApiList(rows), mode: used });
        }).catch(() => {
          sendJson(res, 200, { items: service.toApiList(service.search(query, { limit })), mode: "keyword" });
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- user profile ---
  register({
    kind: "exact",
    path: "/api/dsh-mneme/profile",
    policy: "token-write",
    handler(req, res) {
      try {
        if (req.method === "PUT" || req.method === "POST") {
          return readBody(req, res).then((text) => {
            if (text === null) return;
            const body = parseBody(text);
            settings.setProfile(typeof body.profile === "string" ? body.profile : "");
            sendJson(res, 200, { profile: settings.getProfile() });
          });
        }
        sendJson(res, 200, { profile: settings.getProfile() });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- 画像提取（issue #497）：一次性从活跃记忆出「助手眼中的用户」**草稿** ------
  // 语义上它是「读 + 一次模型调用」，不是写端点：草稿回给面板，采用与否是用户在那里
  // 另一次显式 PUT /profile。所以这个路由永远不碰 user_settings——画像正文是用户
  // 手写的原文，让模型合并等于给它改写权，而改写后的文本每帧都注入。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/profile/extract",
    // policy 是 `token` 而不是 `token-write`：这条路由**没有读分支**（非 POST 一律 405），
    // 声明成 token-write 会让 SECURITY.md 的开放读清单按「GET 开放」把它算进去——
    // 那张表是代码的投影，不是愿望清单（test/security-doc.test.js 就是钉这件事的）。
    policy: "token",
    handler(req, res) {
      // 方法白名单在碰任何副作用之前：#489 的教训是「只拦 POST/PUT，其余直落
      // run(null)」——那等于给带 token 的 PATCH/DELETE 开了一条静默花一次 LLM 的口子。
      // 顺序也要紧：405 若挪到 readBody 之后，一个不带 body 的方法会把请求永远挂在
      // 读体上（把这道判断改成只拦 GET 时实测卡住整条用例），等于一个免费的挂起面。
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end("");
        return undefined;
      }
      if (config?.profileExtractEnabled !== true) return sendJson(res, 409, { error: "disabled" });
      if (typeof profileExtract !== "function") return sendJson(res, 503, { error: "unavailable" });
      return readBody(req, res).then((text) => {
        if (text === null) return undefined; // 超限已在 readBody 里回过 413
        return profileExtract().then(
          (out) => sendJson(res, 200, out),
          (error) => {
            // 「没东西可提」与「模型没配合」必须能被调用方区分：把它们都压成 200 +
            // 空草稿，面板就会把故障显示成「这次没提炼出东西」（#493 同一条教训）。
            const code = typeof error?.code === "string" ? error.code : "";
            if (code === "no-input") return sendJson(res, 409, { error: code });
            // 没配模型是「环境缺东西」，与「模型不配合」两码：前者重跑也一样，后者可重试。
            if (code === "no-route") return sendJson(res, 503, { error: code });
            if (code === "unparseable" || code === "stream-failed") return sendJson(res, 502, { error: code });
            ctx.logger?.warn?.(`dsh-mneme: profile extract failed: ${String(error?.message ?? error)}`);
            return sendJson(res, 500, { error: "internal" });
          }
        );
      });
    }
  });

  // --- agent persona（人格定义页，beta） -------------------------------------
  // 形状照抄 /profile 路由（设计稿②）：写方法走 requireAuth + readBody + parseBody。
  // v1.2 多卡：GET 回全量 { default, byAgent }；PUT 双形——单对象形（旧面板）只更新
  // default 且 byAgent 保留（合并语义，settings.setPersona 内判形状），多卡形全量
  // 替换。坏体守卫：jsonOk=false 时保值回显，不清空库内现值。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/persona",
    policy: "token-write",
    handler(req, res) {
      try {
        if (req.method === "PUT" || req.method === "POST") {
          return readBody(req, res).then((text) => {
            if (text === null) return;
            // parseBody 对坏 JSON 回 {}（容错不抛），所以这里的守卫必须把
            // 「坏体解析成的 {}」与「真的传了 {persona:{}}」区分开：文本解析
            // 失败的体不该把人格清空。jsonOk=false 时保持库内现值原样回显。
            let body;
            let jsonOk = true;
            try {
              body = JSON.parse(text || "{}");
            } catch {
              body = {};
              jsonOk = false;
            }
            if (jsonOk && body && typeof body === "object") {
              settings.setPersona(body.persona && typeof body.persona === "object" ? body.persona : body);
            }
            sendJson(res, 200, { persona: settings.getPersona() });
          });
        }
        const url = new URL(req.url, "http://localhost");
        // 预览（面板「Agent 眼中的画像」用）：由注入器同一个渲染函数产出，前端只显示
        // 返回的文本——以前端自己拼列表冒充「生效文本」是这个面板最容易漂的地方。
        // ?agent=<身份> 让面板能逐张卡预览：传了就按那个身份寻址，没传按「解析不到身份」
        // 走（也就是 default 卡的受众）。?session=<会话 id>（#606）同理作用于绑会话卡，
        // 优先级高于 ?agent——与 resolvePersonaCard 的寻址次序一致，预览不许比注入更乐观。
        // 这里不加鉴权是有意的：画像、规则、人格三处在同一条开放读面上本来就能各读一次
        // （GET /profile 与 GET /persona 都无 token 可读），本字段只是把同样的内容拼成
        // 模型实际看到的形状，没有新增可达面；真要锁，配 apiToken（写面与它同源）。
        const preview = renderUserSettingsBlock({
          settings,
          config,
          agentId: url.searchParams.get("agent"),
          sessionId: url.searchParams.get("session"),
          // 父会话 id（子 agent 继承人格卡用）：面板若要复现子代理看到的那一帧，
          // 传父会话 id 即可，与注入器同一寻址次序——预览不许比注入更乐观。
          parentSessionId: url.searchParams.get("parent"),
          // 事实段与注入共用同一渲染函数（user-settings.js 的同源纪律）：装配了
          // profile-facts 就传读口，开关与有无的判定在渲染函数内部（关=零读数）。
          factsProvider: typeof facts?.factsProvider === "function" ? facts.factsProvider : null
        });
        sendJson(res, 200, { persona: settings.getPersona(), preview });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- 「Agent 眼中的你」自动事实（2026-11-06，对标 ChatGPT 记忆 / DS Bot 每 bot
  // 的 MEMORY.md 事实清单）----------------------------------------------
  // 三条路由都**不碰 user_settings**：手填画像神圣（#497 口径），事实住
  // profile_facts 独立三表，模型只在 dream 轮里增改、人在面板上逐条修正。
  // GET：卡内事实 + 账本尾 + 最近回执，一次请求喂饱面板那张卡。flag 关着也照读
  // ——历史上开过又关掉的库里事实还在，面板要能展示它（与 /profile 的 GET 同理）。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/profile-facts",
    policy: "token-write",
    handler(req, res) {
      try {
        if (typeof facts?.listFacts !== "function") return sendJson(res, 503, { error: "unavailable" });
        const url = new URL(req.url, "http://localhost");
        const raw = url.searchParams.get("agent");
        const agent = typeof raw === "string" ? raw.trim() : "";
        sendJson(res, 200, {
          cards: facts.cardKeys(),
          agent,
          facts: facts.listFacts(agent, { includeArchived: true }),
          journal: facts.listJournal(agent, { limit: 12 }),
          runs: facts.listRuns(agent, { limit: 5 })
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // POST /apply：面板的逐条人工修正（增/改/归档），actor=manual，与自动轮共用
  // 同一份 applyOps 与同一本账。flag 关着也放行——修正存量事实不需要维护轮开着。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/profile-facts/apply",
    policy: "token-write",
    handler(req, res) {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end("");
        return undefined;
      }
      if (typeof facts?.applyManualOps !== "function") return sendJson(res, 503, { error: "unavailable" });
      return readBody(req, res).then((text) => {
        if (text === null) return undefined;
        const body = parseBody(text);
        const agent = typeof body.agent === "string" ? body.agent.trim() : "";
        const ops = Array.isArray(body.ops) ? body.ops : [];
        if (!ops.length) return sendJson(res, 400, { error: "ops required" });
        // 形状谓词与解析层共用一份（isValidFactOps）：update 与 add 同样必须带
        // content——缺了会把「undefined」写进事实正文并从此每帧注入。
        if (!isValidFactOps(ops)) return sendJson(res, 400, { error: "invalid ops" });
        let result;
        try {
          result = facts.applyManualOps(agent, ops);
        } catch (error) {
          // /run 有完整的错误映射，这条写路径也不能把同步异常（SQLite I/O）裸抛
          // 给宿主——500 + 一句 internal，与 GET 分支的 try/catch 同款。
          ctx.logger?.warn?.(`dsh-mneme: profile-facts apply failed: ${String(error?.message ?? error)}`);
          return sendJson(res, 500, { error: "internal" });
        }
        sendJson(res, 200, {
          applied: result.applied,
          failures: result.failures,
          dupsSkipped: result.dupsSkipped,
          facts: facts.listFacts(agent, { includeArchived: true })
        });
        return undefined;
      });
    }
  });

  // POST /run：手动维护轮。policy `token` 与 /profile/extract 同款取舍：无读分支
  // + 一次 LLM 调用，声明成 token-write 会让开放读清单按「GET 开放」把它算进去。
  // run 本体经 service.enqueue 与 dream/sleep 串行，不与巩固轮抢模型。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/profile-facts/run",
    policy: "token",
    handler(req, res) {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end("");
        return undefined;
      }
      if (config?.profileFactsEnabled !== true) return sendJson(res, 409, { error: "disabled" });
      if (typeof facts?.runFor !== "function") return sendJson(res, 503, { error: "unavailable" });
      return readBody(req, res).then((text) => {
        if (text === null) return undefined;
        const body = parseBody(text);
        const agent = typeof body.agent === "string" ? body.agent.trim() : "";
        const queued = service?.enqueue
          ? service.enqueue(() => facts.runFor(agent, { trigger: "manual" }))
          : facts.runFor(agent, { trigger: "manual" });
        return queued.then(
          (receipt) => sendJson(res, 200, receipt),
          (error) => {
            // 「没配模型」与「模型不配合」两码（profileExtract 同款映射）：
            // 前者重跑也一样，后者可重试。noop 是正常结局（没有新记忆），200。
            const code = typeof error?.code === "string" ? error.code : "";
            if (code === "no-route") return sendJson(res, 503, { error: code });
            if (code === "unparseable" || code === "stream-failed") return sendJson(res, 502, { error: code });
            ctx.logger?.warn?.(`dsh-mneme: profile facts run failed: ${String(error?.message ?? error)}`);
            return sendJson(res, 500, { error: "internal" });
          }
        );
      });
    }
  });

  // --- dream/sleep 模型连通性 + 模型发现（settings 面板）----------------------
  // Connectivity probe for a dream/sleep model route: runs one minimal LLM call
  // through the same harness path the consolidation uses and reports success /
  // failure + latency + error. Reuses describeStreamFailure so the panel shows
  // the same error wording the audit rows carry. Optional reasoningEffort
  // mirrors what the consolidation would send — the panel can verify a model
  // actually accepts the configured effort without tripping a full run.
  //
  // 档位被拒时探针必须和真实 run 一样降级：这里是全仓唯一「接受并转发调用方档位、
  // 却此前没有兜底」的调用面——巩固/睡眠/蒸馏/总览/实体抽取都包在 withEffortFallback
  // 里，档位被拒就丢掉字段重试一次（issue #9/#109/#135）。直调 llm.stream 的其余各面
  // 要么本来就在兜底之内（dream.js/summarize.js/sleep.js 的共用辅助），要么是
  // src/index.js 的手写版兜底，要么像 pre-inject-gate 的判定池那样根本不转发档位。
  // 探针原先没有这层，于是同一份配置「后台真的跑得通、点一下测试就报红」，把用户
  // 引向「换哪家 Provider 都失败」的错误诊断（issue #215 的后续）。降级跑通后响应带
  // effortDropped:true，面板据此说明「档位不被接受、已按无档位连通」，而不是与「真的
  // 连不上」同色。
  async function testLlmConnectivity(llm, provider, model, reasoningEffort) {
    const startedAt = Date.now();
    const elapsed = () => Date.now() - startedAt;
    const modelId = `${provider}:${model}`;
    // 流级失败原因：withEffortFallback 只用它做拒收甄别，回给面板的仍是同一条
    // describeStreamFailure 文案（与审计行同口径，不制造第二套措辞）。
    let streamError = "";
    // 降级标记刻意放在 attempt 之外：fallback 里置位、attempt 里读出，结果对象
    // 据此带上 effortDropped——降级是「换个姿势跑通了」，不是失败。
    let droppedEffort = false;

    const attempt = async (effort) => {
      streamError = "";
      let reply = "";
      for await (const chunk of llm.stream({
        provider,
        model,
        purpose: "dsh-mneme-connectivity-test",
        // 给思考模型留出「思考完还有正文」的空间：16 会被 reasoning 全部吃掉，
        // reply 恒为空，「真的答了 ok」对思考模型不成立。按实际用量计费，手动
        // 按钮无放大风险。
        maxTokens: 1024,
        ...(effort && effort !== "none" ? { reasoningEffort: effort } : {}),
        // role 用 user 而非 system（#189 后续）：0.1.6-alpha.1 起适配器把 system
        // 抽成顶层参数，system-only 对话会被官方 API 以
        // 「messages: at least one message is required」整单拒绝——探测按钮 502。
        // user 消息在任何适配器下都是一条合法对话，探测从此不怕 host 演进。
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Reply with exactly one word: ok" }],
            source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" }
          }
        ]
      })) {
        if (chunk.type === "text-delta" && typeof chunk.text === "string") reply += chunk.text;
        if (chunk.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) {
          streamError = describeStreamFailure(chunk.reason);
          break;
        }
      }
      const dropped = droppedEffort ? { effortDropped: true } : {};
      if (streamError) {
        // 只在「确实带了档位」时把流级拒收交回给 withEffortFallback 的 undefined
        // 分支——rc.1 的适配器不抛错，把 provider 的拒收折叠成终止 finish chunk，
        // 不看这里那次重试就是死代码。不带档位时原样上报：探针不该因为一句文案
        // 没匹配上正则就退化成 500。
        if (effort && effort !== "none" && EFFORT_REJECT_RE.test(streamError)) return undefined;
        // 失败行不带 effortDropped：该字段只有一个含义——「连通了，但不是用你配的
        // 档位连通的」（见下方成功分支的注释），失败时它只是噪音。
        return { ok: false, durationMs: elapsed(), error: streamError, modelId };
      }
      return { ok: true, durationMs: elapsed(), modelId, reply: reply.trim().slice(0, 100), ...dropped };
    };

    try {
      const result = await withEffortFallback(
        ctx,
        reasoningEffort,
        () => attempt(reasoningEffort),
        () => { droppedEffort = true; return attempt(""); },
        () => streamError
      );
      // result === undefined 只可能来自上面那次「判据一致」的主动交还（两边用同
      // 一份 EFFORT_REJECT_RE，走到这里等于假设被推翻）：退回已捕获的流失败原
      // 因，绝不让探针 500。
      if (result === undefined) {
        return { ok: false, durationMs: elapsed(), error: streamError || "no stream result", modelId };
      }
      return result;
    } catch (error) {
      return { ok: false, durationMs: elapsed(), error: String(error?.message ?? error), modelId };
    }
  }

  // List every provider + model the host has registered, so the panel can offer
  // a dropdown over REAL models instead of free-text guesses. Read-only, no auth
  // (same as list/search). Best-effort per provider: one whose model list can't
  // be resolved yields an empty models array instead of failing the whole call.
  register({
    kind: "exact",
    path: "/api/dsh-mneme/llm-providers",
    policy: "open",
    handler(req, res) {
      try {
        const llm = ctx.llm;
        if (typeof llm?.listProviders !== "function" || typeof llm?.listModels !== "function") {
          return sendJson(res, 501, { error: "llm-unavailable" });
        }
        let providers;
        try { providers = llm.listProviders() ?? []; } catch { providers = []; }
        return Promise.all(providers.map(async (p) => {
          let models = [];
          try { models = (await llm.listModels(p.id)) ?? []; } catch { models = []; }
          return {
            provider: p.id,
            models: models.map((m) => ({ id: m.id, name: m.name ?? m.id }))
          };
        })).then((rows) => sendJson(res, 200, { providers: rows }));
      } catch {
        return sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // Connectivity test for a dream/sleep model route. Runs one tiny LLM call and
  // reports ok / failure + latency + error. Auth-gated: it spends the user's
  // API quota, so a stray local page must not be able to drain it via loopback.
  register({
    kind: "exact",
    path: "/api/dsh-mneme/test-model",
    policy: "token",
    handler(req, res) {
      try {
        if (req.method !== "POST") return sendJson(res, 404, { error: "not-found" });
        return readBody(req, res).then(async (text) => {
          if (text === null) return;
          const body = parseBody(text);
          let provider = typeof body.provider === "string" ? body.provider.trim() : "";
          let model = typeof body.model === "string" ? body.model.trim() : "";
          if ((!provider && model) || (provider && !model)) return sendJson(res, 400, { error: "missing-provider-or-model" });
          if (!provider && !model) {
            // 空 = 按巩固路由解析（dreamProvider/dreamModel > agent 默认模型），
            // 让面板一键测"当前巩固模型"而无需手填。
            const route = resolveRoute(ctx, config ?? {}, ctx.logger);
            if (!route) return sendJson(res, 400, { error: "no-route" });
            provider = route.provider;
            model = route.model;
          }
          const llm = ctx.llm;
          if (typeof llm?.stream !== "function") return sendJson(res, 501, { error: "llm-unavailable" });
          const result = await testLlmConnectivity(llm, provider, model, body.reasoningEffort);
          return sendJson(res, result.ok ? 200 : 502, result);
        });
      } catch {
        return sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- delete one memory by id ---
  // Mutation route: apiToken-gated like the profile/rules writes above. POST
  // body is JSON { id }. store.remove deletes silently, so existence is checked
  // up front to give clients a distinguishable 404 instead of a fake success.
  register({
    kind: "exact",
    path: "/api/dsh-mneme/delete",
    policy: "token",
    handler(req, res) {
      try {
        if (req.method !== "POST") {
          sendJson(res, 404, { error: "not-found" });
          return;
        }
        return readBody(req, res).then((text) => {
          if (text === null) return;
          const body = parseBody(text);
          const id = typeof body.id === "string" ? body.id.trim() : "";
          if (!id) {
            sendJson(res, 400, { error: "missing-id" });
            return;
          }
          if (!service.getById(id)) {
            sendJson(res, 404, { error: "not-found" });
            return;
          }
          service.remove(id);
          sendJson(res, 200, { ok: true });
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- 编辑/归档一条记忆（面板写路径，与 /delete 对称命名）-------------------
  // POST body {id, title?, content?, importance?, tags?, archived?}。字段校验
  // 只做类型/范围检查：字段出现（!== undefined）就必须合法，宁 400 不静默纠正
  // ——静默丢字段会让面板误以为保存成功。写入走 service 的正规更新路径：
  // updated_at 由 store 的单调时钟推进；content 被改写时旧版本按 human_override
  // 入档（与镜像人工编辑回灌 mergeHumanEdits 的语义对齐，FIFO 上限 20）；
  // archived 走 setArchived。两条路径都会触发镜像重渲染（afterSync）。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/update",
    policy: "token",
    handler(req, res) {
      try {
        if (req.method !== "POST") {
          sendJson(res, 404, { error: "not-found" });
          return;
        }
        return readBody(req, res).then((text) => {
          if (text === null) return;
          const body = parseBody(text);
          const id = typeof body.id === "string" ? body.id.trim() : "";
          if (!id) {
            sendJson(res, 400, { error: "missing-id" });
            return;
          }
          const patch = {};
          if (body.title !== undefined) {
            if (typeof body.title !== "string" || !body.title.trim()) {
              sendJson(res, 400, { error: "invalid-title" });
              return;
            }
            patch.title = body.title.trim();
          }
          if (body.content !== undefined) {
            if (typeof body.content !== "string" || !body.content.trim()) {
              sendJson(res, 400, { error: "invalid-content" });
              return;
            }
            patch.content = body.content.trim();
          }
          if (body.importance !== undefined) {
            if (!Number.isInteger(body.importance) || body.importance < 1 || body.importance > 5) {
              sendJson(res, 400, { error: "invalid-importance" });
              return;
            }
            patch.importance = body.importance;
          }
          if (body.tags !== undefined) {
            if (!Array.isArray(body.tags) || !body.tags.every((t) => typeof t === "string")) {
              sendJson(res, 400, { error: "invalid-tags" });
              return;
            }
            patch.tags = body.tags;
          }
          // v0.8.1 底座（issue #170）：显式 scope 修正。null=放宽到全局，
          // 字符串=收窄/改标；归一化（"global"/"*"/空白→NULL + explicit 章 +
          // 审计行）在 service.updateMemory 内做，路由只做形状校验。
          if (body.agent_scope !== undefined && body.agent_scope !== null && typeof body.agent_scope !== "string") {
            sendJson(res, 400, { error: "invalid-agent-scope" });
            return;
          }
          if (body.workspace_scope !== undefined && body.workspace_scope !== null && typeof body.workspace_scope !== "string") {
            sendJson(res, 400, { error: "invalid-workspace-scope" });
            return;
          }
          if (body.agent_scope !== undefined) patch.agent_scope = body.agent_scope;
          if (body.workspace_scope !== undefined) patch.workspace_scope = body.workspace_scope;
          if (body.archived !== undefined && typeof body.archived !== "boolean") {
            sendJson(res, 400, { error: "invalid-archived" });
            return;
          }
          if (Object.keys(patch).length === 0 && body.archived === undefined) {
            sendJson(res, 400, { error: "no-fields" });
            return;
          }
          const existing = service.getById(id);
          if (!existing) {
            sendJson(res, 404, { error: "not-found" });
            return;
          }
          // 内容被改写时旧版本先入档（human_override），人工修正不静默销毁旧值。
          if (patch.content !== undefined && patch.content !== existing.content) {
            const history = Array.isArray(existing.content_history) ? existing.content_history : [];
            patch.content_history = [
              { content: existing.content ?? "", source: "human_override", updated_at: new Date().toISOString() },
              ...history
            ].slice(0, 20);
          }
          if (Object.keys(patch).length) service.update(id, patch, { actor: "panel" });
          if (body.archived !== undefined) service.setArchived(id, body.archived);
          sendJson(res, 200, { memory: service.getById(id) });
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- 新建一条记忆（面板写路径，与 /update、/delete 对称命名）---------------
  // #386 第 5 条：CLI `add` 与 standalone `POST /memories` 都能建行，面板此前只
  // 能看/改/删/导入。字段与 memory_save 工具对齐（type/title/content/importance/
  // tags），走同一条 saveWithDedupe 路径——去重键仍是 (type, title, scope,
  // sensitivity)，所以「面板建」与「工具建」同标题会并入同一行，不会长出两份。
  //
  // 三处刻意的口径差异（都写在代码里，免得下一个人以为是抄漏）：
  //  1. content 要求 trim 后非空，与 /update 一致而非 standalone 的宽松版：
  //     面板是人工输入，空正文只可能是误操作；standalone 面对的是程序化调用，
  //     放宽是为了兼容「先建壳再补内容」的既有客户端。
  //  2. document 直接 400：行铸造口唯一（registerDocument，#230），saveWithDedupe
  //     会 throw，这里提前给干净错误码而不是让它落成 500。
  //  3. 不接受 scope/sensitivity 字段——面板的 scope 编辑在详情抽屉里（带放宽
  //     确认的安全阀，见 lib/client.js 的 MemoryDrawer），新建时就盖章 explicit
  //     会绕过那道确认。传了也不报错，只是不生效（与 /update 的「字段出现即校验」
  //     不同，因为这里根本没有该字段的语义）。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/create",
    policy: "token",
    handler(req, res) {
      try {
        if (req.method !== "POST") {
          sendJson(res, 404, { error: "not-found" });
          return;
        }
        return readBody(req, res).then((text) => {
          if (text === null) return;
          const body = parseBody(text);
          if (!TYPES.has(body.type)) {
            sendJson(res, 400, { error: "invalid-type" });
            return;
          }
          if (body.type === "document") {
            sendJson(res, 400, { error: "document-requires-register" });
            return;
          }
          if (typeof body.title !== "string" || !body.title.trim()) {
            sendJson(res, 400, { error: "invalid-title" });
            return;
          }
          if (typeof body.content !== "string" || !body.content.trim()) {
            sendJson(res, 400, { error: "invalid-content" });
            return;
          }
          if (body.importance !== undefined
            && (!Number.isInteger(body.importance) || body.importance < 1 || body.importance > 5)) {
            sendJson(res, 400, { error: "invalid-importance" });
            return;
          }
          if (body.tags !== undefined && (!Array.isArray(body.tags) || !body.tags.every((tag) => typeof tag === "string"))) {
            sendJson(res, 400, { error: "invalid-tags" });
            return;
          }
          try {
            const result = service.saveWithDedupe({
              type: body.type,
              title: body.title.trim(),
              content: body.content.trim(),
              importance: body.importance,
              tags: body.tags ?? [],
              // 面板不是工具也不是外部程序，来源要能在详情抽屉里一眼认出是谁写的。
              source: "panel"
            });
            // #254 写入准入在无会话身份时放行（write-admission.js 首行早退），面板
            // 路由恰好不带 _sessionKey，所以今天到不了这个分支。仍然显式写出来：
            // 将来若把会话身份接进面板，落到 toApiList([null]) 上会变成 500，把
            // 「被拒」伪装成「服务器出错」——两者的处置完全不同。
            if (result.action === "denied") {
              sendJson(res, 422, { error: "write-rejected", reason: result.reason });
              return;
            }
            // action 随行透出（created/merged）：面板据此提示「已并入同标题的既有条目」
            // 还是「新建成功」——两者对用户是不同的事实，不能都报「已保存」。
            sendJson(res, result.action === "created" ? 201 : 200, {
              ...service.toApiList([result.memory])[0],
              action: result.action
            });
          } catch (error) {
            ctx.logger?.warn?.(`[dsh-mneme] panel create failed: ${String(error)}`);
            sendJson(res, 500, { error: "internal" });
          }
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- maintenance/reclaim（#386 第 4 条：面板有了回收入口）------------------
  // 与 standalone 数据面的 POST /maintenance/reclaim 是同一能力的两张皮：口径（错误码
  // 字符串、默认值、报告形状）只写在 src/reclaim-http.js 里，这里与数据面都调它。
  // 差别只有鉴权与路径——两张皮的其余部分必须没有第二份实现（#411 的教训：以前是整段
  // 复制，于是 #410 修好这边之后那边还停在旧形态）。
  //
  // 为什么 GET 也能跑：dry-run 是只读的（src/maintenance.js 里 dry-run 与执行同一条
  // 代码路径，只是不落 UPDATE/VACUUM），面板 mount 时拿它渲染「现在能回收多少」。
  //
  // 为什么两法都要 requireAuth：这是不可逆内容丢弃的入口，不能有例外。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/maintenance/reclaim",
    policy: "token",
    handler(req, res) {
      try {
        if (req.method === "GET") {
          if (!maintenance) {
            sendJson(res, 503, { error: RECLAIM_UNAVAILABLE });
            return;
          }
          const parsed = parseReclaimQuery(new URL(req.url, "http://localhost").searchParams.get("olderThanDays"));
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const { status, body } = reclaimReply({
            maintenance,
            dryRun: true,
            olderThanDays: parsed.olderThanDays,
            warn: (msg) => ctx.logger?.warn?.(msg)
          });
          sendJson(res, status, body);
          return;
        }
        if (req.method !== "POST") {
          sendJson(res, 404, { error: "not-found" });
          return;
        }
        return readBody(req, res).then((text) => {
          if (text === null) return;
          const parsed = parseReclaimJson(text);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          if (!maintenance) {
            sendJson(res, 503, { error: RECLAIM_UNAVAILABLE });
            return;
          }
          const fields = readReclaimFields(parsed.body);
          if (!fields.ok) {
            sendJson(res, 400, { error: fields.error });
            return;
          }
          const { status, body } = reclaimReply({
            maintenance,
            dryRun: fields.dryRun,
            olderThanDays: fields.olderThanDays,
            vacuum: fields.vacuum,
            confirm: fields.confirm,
            warn: (msg) => ctx.logger?.warn?.(msg)
          });
          sendJson(res, status, body);
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- rules ---
  register({
    kind: "exact",
    path: "/api/dsh-mneme/rules",
    policy: "token-write",
    handler(req, res) {
      try {
        if (req.method === "PUT" || req.method === "POST") {
          return readBody(req, res).then((text) => {
            if (text === null) return;
            const body = parseBody(text);
            settings.setRules(Array.isArray(body.rules) ? body.rules : []);
            sendJson(res, 200, { rules: settings.getRules() });
          });
        }
        sendJson(res, 200, { rules: settings.getRules() });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- vector search config ---
  register({
    kind: "exact",
    path: "/api/dsh-mneme/vector-config",
    policy: "token",
    handler(req, res) {
      try {
        // Secret-bearing endpoint: fully protected when apiToken is set.
        if (req.method === "PUT" || req.method === "POST") {
          return readBody(req, res).then((text) => {
            if (text === null) return;
            const body = parseBody(text);
            // An empty apiKey, or one that already looks masked (round-trips
            // through maskApiKey unchanged), means "keep the existing key".
            // Only a fresh, unmasked key is treated as a real replacement.
            const prev = settings.getVectorConfig();
            const incoming = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
            const isMaskedOrEmpty = incoming === "" || maskApiKey(incoming) === incoming;
            const key = isMaskedOrEmpty
              ? (prev?.apiKey ?? "")
              : incoming;
            const cfg = settings.setVectorConfig({
              enabled: body.enabled,
              baseUrl: body.baseUrl,
              apiKey: key,
              model: body.model
            });
            sendJson(res, 200, { config: { ...cfg, apiKey: maskApiKey(cfg.apiKey) } });
          });
        }
        const cfg = settings.getVectorConfig() ?? { enabled: false, baseUrl: "", apiKey: "", model: "" };
        sendJson(res, 200, { config: { ...cfg, apiKey: maskApiKey(cfg.apiKey) } });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- vector re-index (backfill embeddings for rows missing them) ---
  register({
    kind: "exact",
    path: "/api/dsh-mneme/vector-reindex",
    policy: "token",
    handler(req, res) {
      try {
        if (!embedder) {
          sendJson(res, 200, { indexed: 0, failed: 0, skipped: 0, error: "vector-unavailable" });
          return;
        }
        const url = new URL(req.url, "http://localhost");
        const limit = Number(url.searchParams.get("limit") ?? 100);
        // Unified re-index entry: works for both the legacy OpenAI embedder and
        // the new local/ollama backends (which have no reindexMissing method).
        const viaIndex = semantic?.vectorIndex && semantic?.vectorIndex.rebuildIndex;
        const task = viaIndex
          ? semantic.vectorIndex.rebuildIndex(embedder, { limit })
          : embedder.reindexMissing ? embedder.reindexMissing(limit) : Promise.resolve({ indexed: 0, failed: 0, skipped: 0, error: "vector-unavailable" });
        // Return the chain so awaiting callers (tests/health checks) observe the
        // finished response rather than racing the async backfill.
        return task.then((result) => {
          sendJson(res, 200, result);
        }).catch(() => {
          sendJson(res, 200, { indexed: 0, failed: 0, skipped: 0, error: "vector-failed" });
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- semantic pipeline status (model, index, reranker) ---
  register({
    kind: "exact",
    path: "/api/dsh-mneme/semantic",
    policy: "open",
    handler(req, res) {
      try {
        const stats = semantic?.vectorIndex?.getStats?.() ?? null;
        // #118: expose readiness so the status card can tell "initializing /
        // unreachable" from "disabled". An embedder carrying no `ready` prop at
        // all (test doubles, third-party adapters) is assumed usable.
        // issue #135: 但「可用」和「配了」是两件事 —— legacy OpenAI embedder
        // 此前恒报 ready，于是 baseUrl/apiKey/model 全空时状态卡依然是绿的
        // （"绿色假阳性"）。下面把两者分开，并附上索引覆盖度。
        const ready = embedder ? ("ready" in embedder ? embedder.ready === true : true) : null;
        // local/ollama 的配置来自 settings 兜底，没有「未配置」态：它们的
        // ready=false 表示「还在初始化」，不是「没配」。
        const configured = embedder ? (typeof embedder.configured === "boolean" ? embedder.configured : true) : null;
        const embedded = Number(stats?.embeddedCount ?? 0);
        const total = Number(stats?.totalCount ?? 0);
        // Per-model / per-dimension provenance of stored vectors. "embedded"
        // counts rows with any vector; rows whose dimension differs from the
        // current embedder output are skipped by searchVector, so the honest
        // retrievable number is the current-dimension slice. modelBreakdown
        // groups by row-level embedding_model ('' = unknown origin).
        const dimensionBreakdown = typeof service.embeddingDimensionBreakdown === "function"
          ? service.embeddingDimensionBreakdown()
          : null;
        const currentDim = embedder?.dimension != null ? String(embedder.dimension) : null;
        const byDimension = dimensionBreakdown
          ? [...dimensionBreakdown.entries()].map(([dim, c]) => ({ dimension: dim === "" ? null : Number(dim), count: c }))
          : [];
        const unsearchable = (currentDim && dimensionBreakdown)
          ? [...dimensionBreakdown.entries()]
              .filter(([dim]) => dim !== currentDim)
              .reduce((s, [, c]) => s + c, 0)
          : 0;        const modelBreakdown = typeof service.embeddingModelBreakdown === "function"
          ? service.embeddingModelBreakdown().map((r) => ({ model: r.model === "" ? null : r.model, count: r.c }))
          : [];
        sendJson(res, 200, {
          ready,
          configured,
          // 机器可读的原因；null = 一切正常。面板按它选文案，不用猜布尔组合。
          reason: !embedder ? "no-embedder"
            : configured === false ? "not-configured"
              : ready !== true ? "initializing"
                : null,
          // 空库时 ratio 必须是 null 而非 0 —— 0 会被读成「一条都没嵌上」。
          coverage: { embedded, total, ratio: total > 0 ? embedded / total : null },
          // distill-tx-embed-gap 后续：向量「存在」≠「可检索」。unsearchable =
          // 维度与当前 embedder 输出不同的行数（searchVector 会跳过它们），
          // retrievable = 与当前维度同维、真正参与召回的行数。两者差值非零时
          // 面板必须能说出「有 N 条向量不可检索」，而不是只给一个虚高的 coverage。
          vectors: {
            byDimension,
            byModel: modelBreakdown,
            unsearchable,
            retrievable: currentDim ? (dimensionBreakdown.get(currentDim) ?? 0) : null,
          },
          // 配了、库里有东西可嵌、却一条都没嵌上 = 真的降级（本机此前长期
          // 处于 ready:true + embeddedCount:0，面板却显示正常）。
          degraded: configured === true && total > 0 && embedded === 0,
          // Explicit display name first: the legacy OpenAI-compatible embedder
          // is an object literal, so constructor.name would be "Object".
          embedProvider: embedder ? (embedder.name ?? embedder.constructor?.name ?? "unknown") : null,
          modelHash: embedder?.modelHash ?? null,
          dimension: embedder?.dimension ?? null,
          reranker: semantic?.reranker ? "ready" : null,
          index: stats,
          // #604：回填与写入两条嵌入路径的诊断。此前 backfillStatus() 与
          // embedReceipts() 都已经算好了，但没有任何出口 —— 面板能看到的只有
          // 「已索引 N 条」，看不出「上一轮撞了 cap」「最近一次嵌入为什么失败」。
          // 两个字段都是只读快照，不查库、不触发推理。
          embeddings: typeof semantic?.embeddingDiagnostics === "function"
            ? semantic.embeddingDiagnostics()
            : null,
          // issue #131 / PR-A：自管运行时的状态。无论当前 provider 是不是 local
          // 都报 —— 面板需要区分「已收编但没启用」和「要用本地却没收编」。
          // 这里只做结构检查（不跑推理），失败降级成状态对象，不会让本端点 500。
          // 必须经 publicRuntimeStatus 投影：本端点是免鉴权的，绝对路径与原始错误
          // 文本不能出去（CWE-200）。完整诊断走本机 CLI 的 status。
          localRuntime: publicRuntimeStatus(describeLocalRuntime({ runtimeDir: config?.runtimeDir ?? "" }))
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- 一键取回自管运行时（issue #131 / PR-C：三档来源）-------------------------
  // 写路径（requireAuth）：它会往 ~/.dsh/mneme/runtime/ 落一份依赖闭包。
  //
  // 第一档源固定取本 profile 的 node_modules（由插件自身路径推出），不接受客户端传源目录 ——
  // 「从任意目录往运行时目录里搬东西」没有必要成为对外能力。
  //
  // 一律回 200：请求本身合法，成不成看 body 里的 ok/status/reason。让 HTTP 码只表达
  // 「有没有鉴权/路径对不对」，结论交给 ok —— 面板要能显示「收编了但闭包缺件」这种
  // 中间状态，用一个 4xx 概括会把信息压掉。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/runtime/provision",
    policy: "token",
    handler(req, res) {
      try {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method-not-allowed" });
          return;
        }
        return readBody(req, res).then(async (text) => {
          if (text === null) return;
          const body = parseBody(text);
          const runtimeDir = config?.runtimeDir ?? "";
          // 三档来源依次尝试（收编本机 node_modules → 本地 .tgz 目录 → registry）。
          // 所以这个端点会**联网**：它可能拉一份几十到上百 MB 的闭包。
          const result = await provisionRuntime({
            hostModulesDir: hostModulesDir(import.meta.url),
            runtimeDir,
            localTarballDir: config?.runtimeTarballDir ?? "",
            mirror: config?.runtimeMirror ?? "",
            overwrite: body?.overwrite === true
          });
          // 顺手带回最新状态，面板不必再打一次 /semantic（且它走的是免鉴权投影）。
          sendJson(res, 200, {
            ...result,
            localRuntime: publicRuntimeStatus(describeLocalRuntime({ runtimeDir }))
          });
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- LLM audit trail (Bug8): paginated read + aggregate stats ---
  // Read-only endpoints, so like list/search/semantic they stay open even when
  // apiToken is set. The stats aggregate budget by source over the last N days.
  register({
    kind: "exact",
    path: "/api/dsh-mneme/semantic/llm-audit",
    policy: "open",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
        const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get("pageSize") ?? 50) || 50));
        const source = url.searchParams.get("source") ?? undefined;
        // 写入准入（#254）的 session_key 是内部计数键——session_id 不是对外的归属
        // 标识（见 scope.js 文件头），而本端点按注释在 apiToken 之下也保持开放，所以
        // 不回传它。按会话离线聚合直接读库。
        const items = (service.listLlmAudits?.({ limit: pageSize, offset: (page - 1) * pageSize, source }) ?? [])
          .map((row) => (row.session_key === undefined ? row : { ...row, session_key: undefined }));
        const total = service.countLlmAudits?.({ source }) ?? items.length;
        sendJson(res, 200, { items, total, page, pageSize });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  register({
    kind: "exact",
    path: "/api/dsh-mneme/semantic/llm-audit/stats",
    policy: "open",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days") ?? 7) || 7));
        const stats = service.getLlmAuditStats?.({ days }) ?? null;
        sendJson(res, 200, stats ?? { error: "unavailable" });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // 沉淀曲线（面板「8 周沉淀」图）：按天返回 added / merged / archived 三条序列。
  // 与 llm-audit/stats 并列但不同源——那边算的是「花了多少 token」，这边算的是
  // 「进来了多少条、真被巩固掉多少条、归档了多少条」。合并数与新增数背离时
  // （2026-10-25~10-31 那段：新增照旧、合并归零）这张图是唯一能一眼看出来的地方。
  // 窗口钳制 1-365 天（缺省 56，正好是热力图的 8 周），口径见 store.getConsolidationStats。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/semantic/consolidation-stats",
    policy: "open",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days") ?? 56) || 56));
        const stats = service.getConsolidationStats?.({ days }) ?? null;
        sendJson(res, 200, stats ?? { error: "unavailable" });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- 记忆级溯源读出口（#399 写、#421 读）-----------------------------------
  // #399 把蒸馏窗口的原文落进 distill_records、把 memory → (session, seq 区间)
  // 的归因写进 memory_provenance，但只做了写：库里有答案、service.provenanceFor
  // 能查，外部（面板 / standalone API / 脚本）拿不到，「这条记忆是从哪几句蒸出来
  // 的」只能开 sqlite 手写 JOIN。本端点补最后一段接线。
  //
  // 两个读方向共一条路径（#524）：?id=<memoryId> 是「这条记忆从哪几句蒸出来的」，
  // ?sessionId=<sid> 是「这个会话蒸出了哪几段」。两个主键互斥——都缺 400、都给
  // 400（择一意味着调用方发一个自己也不知道会被读哪个主键的请求，而两边结果形状
  // 不同）。共用路径是有意的：多一条路径就多一处要登记的地方（SECURITY.md 两张
  // 表、README 路由表、security-doc 的清单锁），而两者读的是同一批数据。
  //
  // 一个链接一个窗口：区间 + 区间里的原文行（按 seq 升序）。没有链接的记忆
  // （memory_save / 工具写入 / 冷启动）返回空 windows——「不是蒸馏来的」本身是
  // 有效答案，不是错误，所以不 404。
  //
  // policy 是 **token**，不是 open（#509 维护者评审定）：records 带的是蒸馏窗口的
  // 逐条会话原文，而 /list 是 open 且逐条带 id——两者串起来等于「先枚举 id、再按 id
  // 捞回原文」，可达结果与 /export（一次拿全库，本仓 2026-10 审计后列 gated）同量级，
  // 只是换了形状。抽稀不该靠「调用方不知道有这条路」。
  //
  // 口径只在 src/provenance-http.js 写一份，两个入口都调它（#411 的教训：两张皮
  // 整段复制必然漂移）。
  //
  // distillRecords.enabled 门（#509 评审整改）：这个读出口吃的是**写侧同一枚开关、
  // 同一个判据**（isDistillRecordsEnabled，与 src/summarize.js:988 逐字同源；本文件
  // 不重写那个表达式，静态锁盯着）。关着时回 409，错误码取共用模块导出的
  // DISTILL_RECORDS_DISABLED——「用户关了」而不是「装配坏了」（后者是 503，
  // src/index.js:589-591 立的可区分性原则），也不是 404（本端点刻意不就「这条记忆
  // 是否存在」作断言）。cfg 是启动期冻结值，所以面板改开关要到下次重启才对这里生效；
  // 该键在 settings 白名单与 NESTED_FLAG_PATHS 里都登记着，面板会显示「待重启」
  // （#481 的教训）。阶梯全貌见 provenance-http.js 文件头。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/memory/provenance",
    policy: "token",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const parsed = parseProvenanceSelector({
          memoryId: url.searchParams.get("id"),
          sessionId: url.searchParams.get("sessionId"),
          limit: url.searchParams.get("limit")
        });
        if (!parsed.ok) {
          sendJson(res, parsed.status, { error: parsed.error });
          return;
        }
        const { status, body } = provenanceReply({ service, selector: parsed.selector, config, warn: (m) => ctx.logger?.warn?.(m) });
        sendJson(res, status, body);
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- ego graph: 1-2 hop neighborhood of one entity (graph panel P1) ---
  // Read-only like list/search/semantic, so it stays open when apiToken is set.
  // BFS from the root entity over entity_relations (both directions; the
  // idx_relations_from/to indexes keep a 2-hop walk in the tens of ms even
  // for a few thousand nodes). `distance` on each node is the hop count from
  // the root so the UI can shade the frontier. The API is graph-traversal
  // only — nodes carry no attr payload; hover summaries come from
  // /semantic/graph/entity-attrs.
  register({
    kind: "exact",
    path: "/api/dsh-mneme/semantic/graph/ego",
    policy: "open",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const name = (url.searchParams.get("entity") ?? "").trim();
        if (!name) {
          sendJson(res, 400, { error: "missing-entity" });
          return;
        }
        const root = service.findEntityByName?.(name);
        if (!root) {
          sendJson(res, 404, { error: "entity-not-found" });
          return;
        }
        const depth = Math.max(1, Math.min(2, Number(url.searchParams.get("depth") ?? 1) || 1));
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 40) || 40));

        const nodes = new Map([[root.id, { ...root, distance: 0 }]]);
        let frontier = [root.id];
        for (let d = 1; d <= depth && nodes.size < limit; d++) {
          const next = [];
          for (const id of frontier) {
            for (const rel of service.getRelations?.(id) ?? []) {
              const other = rel.from_entity === id ? rel.to_entity : rel.from_entity;
              if (nodes.has(other) || nodes.size >= limit) continue;
              const entity = service.findEntityById?.(other);
              if (!entity) continue;
              nodes.set(other, { ...entity, distance: d });
              next.push(other);
            }
          }
          frontier = next;
        }

        // Collect every relation whose endpoints both survived the limit cut;
        // each edge is visited twice (once per endpoint) so dedupe by id.
        const edgeMap = new Map();
        for (const id of nodes.keys()) {
          for (const rel of service.getRelations?.(id) ?? []) {
            if (nodes.has(rel.from_entity) && nodes.has(rel.to_entity)) {
              edgeMap.set(rel.id, rel);
            }
          }
        }

        sendJson(res, 200, {
          root: { id: root.id, name: root.name, type: root.type ?? null, mention_count: root.mention_count ?? 1 },
          nodes: [...nodes.values()].map((n) => ({
            id: n.id,
            name: n.name,
            type: n.type ?? null,
            mention_count: n.mention_count ?? 1,
            distance: n.distance,
            // v0.7.0 实体热投影：实体热 = 关联记忆 heat 聚合（max），前端据此
            // 缩放节点大小/明暗。heatEnabled=false 时 entityHeat 返回 null。
            heat: service.entityHeat?.(n.id) ?? null
          })),
          edges: [...edgeMap.values()].map((e) => ({
            id: e.id,
            from: e.from_entity,
            to: e.to_entity,
            relation_type: e.relation_type,
            memory_id: e.memory_id ?? null,
            created_at: e.created_at,
            // issue #24 块4：被动确认的复核要靠这两个字段——weight 是「用出来
            // 的分」，source 决定它的起点（manual 1.0 / tag 0.3 / llm 0.4）。
            // 少了它们，「这条边被抬过」在面板上根本看不出来。取不到时给
            // 初值形状而不是 undefined，前端不必到处判空。
            weight: e.weight ?? 1.0,
            source: e.source ?? "manual",
            // #619 可见化 B：边上的 metadata 必须原样透传，否则情感边写进去的
            // emotion / attribution / sessionCount / evidence 在面板上永远取不到
            // ——数据在库里、在 store.toRelation 里（src/store.js 已 JSON.parse），
            // 只在最后一跳被这个映射丢掉，读起来就像「这个功能不存在」。
            // 不裁剪字段：情感边的 metadata 由 sleep 相位写入，形状本来就会随版本
            // 演进，在 API 层挑字段等于给未来的字段再挖一个同样的坑。
            // 无 metadata 时给 null，不伪造空对象——前端要靠 null 区分「老边（抽取器
            // 写的，本来就没有情绪）」和「有 metadata 但没有 emotion」。
            metadata: e.metadata ?? null
          }))
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- graph boosted relations: the review side of passive confirmation ---
  // issue #24 块4（被动确认）的复核出口。正常触达即 bump 边权重是安静的设计，
  // 但「抬过哪些边」必须能看见，否则「例外管理」只剩自动确认没有例外。
  // 判据是 gain = 现权 − 该 source 初值 > 0（见 store.listBoostedRelations），
  // 不另设记账表：抬升是唯一会改变检索形状的动作，它自己就是证据。
  // 只读、挂在 /semantic/graph/ 前缀下（SECURITY.md 的开放读清单已含该通配）。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/semantic/graph/boosted-relations",
    policy: "open",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 100) || 100));
        const rows = service.listBoostedRelations?.({ limit }) ?? [];
        sendJson(res, 200, {
          count: rows.length,
          // 提示「这张表为什么可能为空」：被确认抬升的边只在图真的被用过之后
          // 才出现，两个相关闸默认都关。面板据此说明而不是让人以为坏了。
          // 必须两个闸同时开才算「会继续产生新提升」——touchRecalled 里
          // passive = graphPassiveConfirm && graphWeightEnabled，只看前者会让面板
          // 说「会自动提升」而实际上一条都不会抬（评审指出）。
          passiveConfirmEnabled: config?.graphPassiveConfirm === true && config?.graphWeightEnabled === true,
          items: rows.map((r) => ({
            id: r.id,
            from: r.from_entity,
            to: r.to_entity,
            from_name: r.from_name ?? null,
            to_name: r.to_name ?? null,
            relation_type: r.relation_type,
            memory_id: r.memory_id ?? null,
            created_at: r.created_at,
            weight: r.weight,
            base_weight: r.base_weight,
            gain: r.gain,
            source: r.source
          }))
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- affective: 情绪归因一览（#619 可见化 C） ---
  // `ego` 端点只能从某个实体往外看，回答不了「这库里一共记了哪些情绪」。
  // 所以单开一条：按 person/target/emotion 聚合，occasion 与 trait 分开。
  //
  // 三处刻意的选择，都是为了让面板不撒谎：
  // - 聚键含 attribution（occasion / trait），两类不混在一条里。同一个「焦虑」
  //   在一件事上是 occasion，跨三件事才是 trait，合成一条会把「这次」说成「一贯」。
  // - trait 组带 independentSessions（跨几个独立会话）。trait 的判据本来就是会话数，
  //   面板只显示「稳定倾向」而不给数字，用户没法判断它是攒够了还是被猜测出来的。
  // - 完全读不到时返回 500 + error，不返回空列表：空列表在面板上长得跟
  //   「你还没记过任何情绪」一样，而这两件事对用户的含义完全相反。
  //   前端靠 httpStatusCode 区分，不靠 items.length。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/semantic/graph/affective",
    policy: "open",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 200) || 200));
        if (typeof service.relationsByType !== "function") {
          sendJson(res, 500, { error: "unavailable" });
          return;
        }
        const edges = service.relationsByType("affective_context", limit) ?? [];
        const groups = new Map();
        for (const e of edges) {
          const meta = e.metadata && typeof e.metadata === "object" ? e.metadata : {};
          const emotion = String(meta.emotion ?? "").trim();
          // 没有情绪名的边不进聚合：它是老版本或手工写的空壳，凑进「情绪一览」
          // 会造出一个名字为空的条目。但也不能假装它不存在——计数单列。
          const attribution = String(meta.attribution ?? "").trim() || "occasion";
          if (!emotion) continue;
          const key = `${e.from_entity}\u0000${e.to_entity}\u0000${emotion}\u0000${attribution}`;
          if (!groups.has(key)) {
            groups.set(key, {
              person: e.from_name ?? null,
              personId: e.from_entity,
              target: e.to_name ?? null,
              targetId: e.to_entity,
              emotion,
              attribution,
              promotedToTrait: meta.promotedToTrait === true,
              sessionCount: Number.isFinite(meta.sessionCount) ? meta.sessionCount : null,
              traitSessionCount: Number.isFinite(meta.traitSessionCount) ? meta.traitSessionCount : null,
              evidenceCount: Array.isArray(meta.evidence) ? meta.evidence.length : (e.memory_id ? 1 : 0),
              firstSeen: e.created_at ?? null,
              lastSeen: e.created_at ?? null,
              edgeIds: []
            });
          }
          const g = groups.get(key);
          g.edgeIds.push(e.id);
          if (e.created_at && (!g.lastSeen || e.created_at > g.lastSeen)) g.lastSeen = e.created_at;
          if (e.created_at && (!g.firstSeen || e.created_at < g.firstSeen)) g.firstSeen = e.created_at;
          if (e.from_name) g.person = e.from_name;
          if (e.to_name) g.target = e.to_name;
          if (Number.isFinite(meta.sessionCount)) {
            g.sessionCount = Math.max(g.sessionCount ?? 0, meta.sessionCount);
          }
          if (Number.isFinite(meta.traitSessionCount)) {
            g.traitSessionCount = Math.max(g.traitSessionCount ?? 0, meta.traitSessionCount);
          }
          if (meta.promotedToTrait === true) g.promotedToTrait = true;
        }
        const items = [...groups.values()].sort((a, b) => {
          // trait 在前（更值得看），同类按最近一次出现倒序。
          if ((b.attribution === "trait") !== (a.attribution === "trait")) {
            return a.attribution === "trait" ? -1 : 1;
          }
          return String(b.lastSeen ?? "").localeCompare(String(a.lastSeen ?? ""));
        });
        sendJson(res, 200, {
          items,
          // 读到了多少条原始边、其中多少条因为没情绪名没进聚合。给出来是为了
          // 让「只有 0 条」能自我解释：是库里真没有，还是有边但都不带情绪。
          totalEdges: edges.length,
          skippedEdges: edges.length - items.reduce((n, g) => n + g.edgeIds.length, 0),
          truncated: edges.length >= limit
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- entity attrs: current valid attrs for one entity (graph hover panel) ---
  // Read-only; mirrors getCurrentAttrs (valid_until IS NULL). Also used as the
  // graph panel's fallback list when the ego graph is too sparse to draw.
  register({
    kind: "exact",
    path: "/api/dsh-mneme/semantic/graph/entity-attrs",
    policy: "open",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const name = (url.searchParams.get("entity") ?? "").trim();
        if (!name) {
          sendJson(res, 400, { error: "missing-entity" });
          return;
        }
        const entity = service.findEntityByName?.(name);
        if (!entity) {
          sendJson(res, 404, { error: "entity-not-found" });
          return;
        }
        const attrs = service.getCurrentAttrs?.(entity.id) ?? [];
        sendJson(res, 200, {
          entity: { id: entity.id, name: entity.name, type: entity.type ?? null, mention_count: entity.mention_count ?? 1 },
          attrs: Array.isArray(attrs)
            ? attrs.map((a) => ({
                key: a.attr_key,
                value: a.attr_value,
                confidence: a.confidence ?? null,
                valid_from: a.valid_from ?? null
              }))
            : []
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- entity directory (entity gene v0.3.0): read-only list for the UI ---
  // Flat entity list (newest-seen first). Attributes and relations stay on
  // their own per-entity endpoints, the directory only carries the columns
  // the rail needs: name, type, mention_count, first/last seen.
  register({
    kind: "exact",
    path: "/api/dsh-mneme/entities",
    policy: "open",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 500) || 500));
        // q = 名字过滤。必须下推到 store：面板此前取回 limit 条再本地过滤，
        // 排在 limit 之后的实体永远搜不到（评审 #9）。老宿主没有这个形参时
        // 多传一个键不会报错，只是过滤失效——与 limit 的处理一致。
        const q = url.searchParams.get("q") ?? "";
        const entities = service.listEntities?.({ limit, q }) ?? [];
        // total 是**全库**实体数，不是本次切片长度：目录带 limit，面板拿它当
        // 「一共抽出多少实体」，填切片长度会让 1.6 万实体永远显示成 500。
        // 老宿主（service 上没有 countEntities）回落到切片长度，不抛。计数本身失败也
        // 只回落、不冒泡：它在外层 try 里，一抛整条响应就变成 500，已经把切片读出来的
        // 那份列表也跟着丢掉——一个装饰性的总数不该决定目录能不能显示。
        let total = entities.length;
        // totalExact 是给面板看的：计数失败或老宿主没这个方法时，total 只能退回切片
        // 长度，那已经不是「全库有多少」而只是「这次取回多少」。不回这个标记，面板
        // 会把切片长度当成全库数照常显示——正是这条路由原来那个「永远 500」的错法。
        let totalExact = false;
        if (typeof service.countEntities === "function") {
          try {
            total = service.countEntities();
            totalExact = true;
          } catch {
            total = entities.length;
            totalExact = false;
          }
        }
        sendJson(res, 200, { entities, total, totalExact });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- 一条记忆的关联实体（记忆详情侧栏）-------------------------------------
  // 只读：entity_attrs.memory_id 反查实体（store 一条 JOIN 完成，按提及去重）。
  // 与目录 /entities 不同，这里以记忆为锚点，回答"这条记忆提到了谁"。记忆不
  // 存在或无关联一律返回空数组——详情侧栏不需要区分这两种情况。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/memories/entities",
    policy: "open",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const memoryId = (url.searchParams.get("memoryId") ?? "").trim();
        if (!memoryId) {
          sendJson(res, 400, { error: "missing-memory-id" });
          return;
        }
        sendJson(res, 200, { entities: service.entitiesForMemory?.(memoryId) ?? [] });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- 导出（面板备份/迁移）---------------------------------------------------
  // 只读。json：全字段行（含 archived/forgotten，布尔化），updated_at DESC。
  // markdown：一个文档 = 文档级 frontmatter + 按类型分节。frontmatter 只放文档
  // 最前一份（分节不再各自带文件头，否则 9 个 `---` 块串在一个 .md 里，外部
  // frontmatter 解析器只认第一段、其余降级成正文），它的 coverage: all 就是一句
  // 看得见的声明：这份导出含 archived/forgotten（document 指针行除外——它两个
  // 落点都不进，见 mirror.js 的 MIRROR_EXCLUDED_TYPES）。条目块与磁盘镜像同构（共用
  // renderMirrorText 的条目渲染），所以导出文本能被 /import 原样吃回；「同构」
  // 止于条目——磁盘镜像只写活跃集，导出的行集更宽，两者的覆盖声明因此不同
  // （active-only vs all）。
  // 全量一次性取回（store.all 按 updated_at DESC）——导出是一次性备份动作，
  // 不需要流式。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/export",
    policy: "token",
    handler(req, res) {
      try {
        // 导出是「全库 + 含 archived/forgotten 的全字段」的一次读，敏感度不低于
        // 写面：它必须与写路由同门。历史漏项——这条路由长期没有鉴权分支，配了
        // apiToken 也照旧对任何调用方开放（2026-10 审计 P0）。
        const url = new URL(req.url, "http://localhost");
        const format = url.searchParams.get("format") ?? "json";
        if (format !== "json" && format !== "markdown") {
          sendJson(res, 400, { error: "invalid-format" });
          return;
        }
        const rows = service.all?.() ?? [];
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        if (format === "json") {
          sendJson(res, 200, {
            exported_at: new Date().toISOString(),
            version: PACKAGE_VERSION,
            count: rows.length,
            memories: rows
          }, { "Content-Disposition": `attachment; filename="dsh-mneme-export-${stamp}.json"` });
          return;
        }
        const byType = {};
        for (const row of rows) {
          // 没有 TYPE_FILE 条目的 type 不进 markdown 导出，只读 type（#296 的
          // document 指针行）同样不进：导出/导入是 round-trip 通道，只读视图没有
          // 可回填的正文。两个排除都在 mirror.js 那张表里（MIRROR_EXCLUDED_TYPES /
          // MIRROR_READONLY_TYPES）。json 分支是全字段导出，不受影响。
          if (TYPE_FILE[row.type] && !MIRROR_READONLY_TYPES.has(row.type)) (byType[row.type] ??= []).push(row);
        }
        const sections = [];
        for (const type of Object.keys(TYPE_FILE)) {
          if (byType[type]?.length) {
            sections.push(renderMirrorText(type, byType[type], langOf(config), { fileHeader: false }));
          }
        }
        const included = Object.values(byType).flat();
        const docHeader = renderFileHeader("memory-export", included, "all");
        sendAttachment(res, 200, "text/markdown; charset=utf-8", `dsh-mneme-export-${stamp}.md`, docHeader + sections.join("\n"));
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- 分享包（spec §4）------------------------------------------------------
  // 读侧全库口径，鉴权与 /export 同门（token）：它导出的是**脱敏后**的行集，但
  // 「谁在往外打整库」这件事本身就需要跟写路由一样登记在册。
  // GET 不开口子：这条路由的存在感来自「有人主动按分享键」，不是给面板轮询用的。
  // 判据一条都不在这里：哪些行进包、超没超限、抛错回什么码，全在 share-http.js 那份
  // 共用实现里（#411 的口径——两张皮只许剩鉴权与路径不同）。本侧独有的只有两件事：
  // Content-Disposition（sendJson 的 headers 第四参，数据面没有这个签名）和把
  // shareReply 的 warn 接到宿主 logger 上——它兜住抛错回 500，不接日志就是静默失败。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/share",
    policy: "token",
    handler(req, res) {
      try {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method-not-allowed" });
          return;
        }
        return readBody(req, res).then((text) => {
          if (text === null) return; // readBody 已经答过 413，再写一次就是双写响应
          const parsed = parseShareBody(text);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const out = shareReply({
            service,
            packageVersion: PACKAGE_VERSION,
            homeDir: homedir(),
            options: parsed.options,
            warn: (msg) => ctx.logger?.warn?.(msg)
          });
          if (out.status === 200) {
            sendJson(res, 200, out.body, {
              "Content-Disposition": `attachment; filename="${shareFilename(out.body.pack_id)}"`
            });
            return;
          }
          sendJson(res, out.status, out.body);
        }).catch(() => sendJson(res, 500, { error: "internal" }));
        // .catch 与下面的外层 try 各挡一类：外层那个只包得住同步那半，而 readBody 的回调
        // 抛出时它早已退栈。共用层从不抛（连 warn 自己坏都被守卫吞掉），所以这条链现在能被
        // 走到的只剩**面自己**写答复那一步——sendJson 的 writeHead 在真 socket 上会因
        // 「一个响应两写」抛 ERR_HTTP_HEADERS_SENT。少这一声就是 unhandled rejection +
        // 一个字节都没回（#410），而下面 /receive 两条一直带着它。
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- 分享包入库与整包退出（车道 C，spec §5）--------------------------------
  // 写库的一面（token-write：非 GET 要 Bearer）。判据一条都不在这里：包体合格不合格住在
  // share.js 的闸门（由 service 的 importSharePack 调），错误码 → 状态的映射住在
  // share-http.js 那份共用实现里——#411 的口径是两张皮只许剩鉴权与路径不同。本侧独有的
  // 只有把 warn 接到宿主 logger 上（不接就是一条静默的 500，现场只剩 internal）。
  //
  // 非 POST 一律 405。这**故意**与上面的 /maintenance/reclaim 不同（那边掉到末尾 404）：
  // 每条 receive 都有一个数据面双胞胎（C6 的 POST /receive、/receive/undo），那里只认
  // 405，状态码差一次就是第三处差别——一致性在这里比「照抄本文件的邻居」更硬。
  //
  // 外层 try 与 .catch 都要留着：外层那个在 .then 的回调里已经退栈，回调里抛出去就是没人接
  // 的 rejection，客户端拿到的不是 500 而是「一个字节都没回」（#410）。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/receive",
    policy: "token-write",
    handler(req, res) {
      try {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method-not-allowed" });
          return;
        }
        return readBody(req, res).then((text) => {
          if (text === null) return; // readBody 已经答过 413，再写一次就是双写响应
          const parsed = parseReceiveBody(text);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const out = receiveReply({
            service,
            pack: parsed.pack,
            dryRun: parsed.dryRun,
            warn: (msg) => ctx.logger?.warn?.(msg)
          });
          sendJson(res, out.status, out.body);
        }).catch(() => sendJson(res, 500, { error: "internal" }));
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // 退出按 pack_id 收起一整包（物删不归档，理由见 src/share-import.js）。dry-run 同样是
  // 缺省：没带 confirm 就只报「会删掉几条」，与 reclaim、与入库那侧同一个脾气。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/receive/undo",
    policy: "token-write",
    handler(req, res) {
      try {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method-not-allowed" });
          return;
        }
        return readBody(req, res).then((text) => {
          if (text === null) return;
          const parsed = parseUndoBody(text);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const out = undoReply({
            service,
            packId: parsed.packId,
            dryRun: parsed.dryRun,
            warn: (msg) => ctx.logger?.warn?.(msg)
          });
          sendJson(res, out.status, out.body);
        }).catch(() => sendJson(res, 500, { error: "internal" }));
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- 导入（Markdown 镜像回填）----------------------------------------------
  // 写路径（requireAuth）。body {type, markdown}：type 是镜像 TYPE_FILE 键，
  // markdown 是与镜像文件同构的文本。解析复用 readHumanEdits 的纯函数核心 parseHumanEdits（同一实现，
  // 行为一致是硬约束），合并走 mergeHumanEdits（只吃 title/content；digest 命
  // 中或无差异的条目在 service 侧自动跳过）。解析出 0 条不算错误。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/import",
    policy: "token",
    handler(req, res) {
      try {
        if (req.method !== "POST") {
          sendJson(res, 404, { error: "not-found" });
          return;
        }
        return readBody(req, res).then((text) => {
          if (text === null) return;
          const body = parseBody(text);
          if (typeof body.type !== "string" || !Object.hasOwn(TYPE_FILE, body.type)) {
            sendJson(res, 400, { error: "invalid-type" });
            return;
          }
          // 只读 type 是合法 type，只是没有可回填的正文（#296）：单独的码，调用方
          // 不会被误导去改 type 名重试。
          if (MIRROR_READONLY_TYPES.has(body.type)) {
            sendJson(res, 400, { error: "readonly-type" });
            return;
          }
          if (typeof body.markdown !== "string" || !body.markdown.trim()) {
            sendJson(res, 400, { error: "invalid-markdown" });
            return;
          }
          const edits = parseHumanEdits(body.markdown);
          service.mergeHumanEdits(body.type, edits);
          sendJson(res, 200, { merged: edits.length, type: body.type });
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- 从目录引导（bootstrap，#386 第 6 条）------------------------------------
  // 后端能力从 #220 起就在（src/bootstrap.js：六类确定性产物、零 LLM、吃
  // saveWithDedupe 的去重），但只有 Bearer 数据面一条入口，面板够不着——「用户照
  // 文档去找入口，发现产品界面里没有」。
  //
  // policy 取 token 而不是 token-write：它写记忆（虽然幂等），与 /import 同类，
  // 而 /import 就是整条要 token 的。GET 不给读分支：没有「预览一次引导会写什么」
  // 的形态，硬造一个 dryRun 等于把 bootstrap.js 拆成两半，收益不抵风险。
  //
  // 为什么不在服务端限制目录范围：插件没有「工作区根」概念（bootstrap.js 的注释
  // 写着不猜路径），而这条路由与 /export、/import 同级，本来就能读写整库；额外加
  // 一个路径白名单只会让人以为它比邻座更安全。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/bootstrap",
    policy: "token",
    handler(req, res) {
      try {
        if (req.method !== "POST") {
          sendJson(res, 404, { error: "not-found" });
          return;
        }
        return readBody(req, res).then((text) => {
          if (text === null) return;
          const parsed = parseBootstrapJson(text);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          // 顺序：先判 body 形状与 dir，再判能力是否接线。缺 dir 是调用方的问题，
          // 报「能力没接线」会把人引到错误的排查方向（reclaim 那边同一条纪律）。
          const dirResult = readBootstrapDir(parsed.body);
          if (!dirResult.ok) {
            sendJson(res, 400, { error: dirResult.error });
            return;
          }
          if (typeof service?.saveWithDedupe !== "function") {
            sendJson(res, 503, { error: BOOTSTRAP_UNAVAILABLE });
            return;
          }
          return bootstrapReply({
            bootstrapper: ({ dir }) => bootstrapFromDirectory({ service, dir, logger: ctx.logger }),
            dir: dirResult.dir,
            warn: (msg) => ctx.logger?.warn?.(msg)
          }).then(({ status, body }) => sendJson(res, status, body));
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- 配置键覆盖面（#386 第 7 条，只读）--------------------------------------
  // 面板能改的键（settings.js 白名单）与 schema 里存在的键（config.js）是两张表，
  // 从没被摆在一起对过。这条路由把它们交/差出来，回答「哪些键只能改配置文件」。
  //
  // 只回**键名与计数**，一个值都不回：apiToken 这类敏感键的名字出现在「仅配置
  // 文件」清单里正是这条 issue 想让人看见的东西（否则用户不知道它存在），但值
  // 出这道门就会成为一个新的泄漏面。
  //
  // policy 取 open：与 /inject-status、/features 的读分支同级——面板要渲染，且
  // 键名本身已经逐条写在 docs/CONFIGURATION.md 里（公开文档），不构成新秘密。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/config-keys",
    policy: "open",
    handler(req, res) {
      try {
        if (req.method !== "GET") {
          sendJson(res, 404, { error: "not-found" });
          return;
        }
        sendJson(res, 200, describeConfigKeys());
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- 巩固状态（dream 面板）--------------------------------------------------
  // 只读：最近巩固运行（最多 5 条，created_at DESC）+ 未解决冲突队列。
  // pendingMemoryIds 从未解决冲突行提取涉及的记忆 id，去重后上限 200，避免积
  // 压很大时响应失控。listDreamRuns/listConflictPending 走 service 现成的审计
  // 只读通道（bookkeeping 语义，不触发写钩子）。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/dream-status",
    policy: "open",
    handler(req, res) {
      try {
        const toRun = (r) => ({
          created_at: r.created_at,
          status: r.status,
          provider: r.provider ?? null,
          model: r.model ?? null,
          error: r.error ?? null,
          run_type: r.run_type ?? "auto",
          // sleep 审计：heat/时间分层降级决策计数（工作动态可展示"降级 N 条"）。
          // 数据来自 runSleep 写入的 decisions.demotion（{demoted,archived} 数组）。
          demotion: r.decisions?.demotion
            ? { demoted: (r.decisions.demotion.demoted ?? []).length, archived: (r.decisions.demotion.archived ?? []).length }
            : null,
          // Issue #521：degraded 轮的 skipped 明细按归一化原因聚合。status:
          // degraded + applied: 3 从外面看完全是健康轮的样子，不展开 skipped
          // 看不出「一整个 action 类型 100% 失败」——实测那个 bug 跑了一整天才
          // 被发现。这里只回聚合（原因 + 动作 + 条数），明细仍留在库里。
          skippedCount: Array.isArray(r.skipped) ? r.skipped.length : 0,
          skippedReasons: summarizeSkipped(r.skipped)
        });
        // Issue #495：organize 上线后 runs 会混进 run_type="organize"，而面板那张
        // 卡的标题是「最近巩固」——一次 agent 主动整理就会把它顶成整理回执。
        // 两条路里选了「标注」而不是过滤：runs 仍是全类型 5 条（审计面是证据，
        // 不因显示面积省略），另给一个只含 auto/sleep 的 lastConsolidation 供那张
        // 卡取数；面板再用 lastRun 是否为 organize 决定要不要标一句脚注。
        // 这里不能只靠 runs[0] 的 run_type 过滤——一次整理写两行（dryRun 报告 +
        // apply 回执），挤空 5 个名额时 runs 里可能一条巩固都没有。
        const runs = (service.listDreamRuns?.({ limit: 5 }) ?? []).map(toRun);
        const lastConsolidation = service.listDreamRuns?.({ limit: 1, excludeRunType: "organize" })?.[0];
        const pendingConflicts = service.countConflictPending?.() ?? 0;
        const ids = new Set();
        for (const row of service.listConflictPending?.({ limit: 200, includeResolved: false }) ?? []) {
          if (ids.size >= 200) break;
          if (row.memory_a) ids.add(row.memory_a);
          if (ids.size >= 200) break;
          if (row.memory_b) ids.add(row.memory_b);
        }
        sendJson(res, 200, {
          lastRun: runs[0] ?? null,
          lastConsolidation: lastConsolidation ? toRun(lastConsolidation) : null,
          runs,
          pendingConflicts,
          pendingMemoryIds: [...ids].slice(0, 200)
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- 冲突集中处理（v0.8.0）：队列 + 人工确认 --------------------------------
  // GET /conflicts：未解决冲突 + 双方当前内容（此前面板只有计数与徽章，
  // resolveConflictPending 在存储层躺着没有任何调用方）。POST /conflicts/resolve：
  // {id, winner: "a"|"b"|null, apply}——盖章审计，apply 时按 dream 非冻结
  // conflict 路径同款处置（service.resolveConflictPending 内部复用
  // applyDecisions：CAS + 事务 + 注记 + 幂等）。认证与其他写路由一致。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/conflicts",
    policy: "token",
    handler(req, res) {
      try {
        if (req.method !== "GET") {
          sendJson(res, 404, { error: "not-found" });
          return;
        }
        const url = new URL(req.url, "http://localhost");
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
        const items = service.listConflictQueue({ limit, offset });
        sendJson(res, 200, { items, total: service.countConflictPending?.() ?? items.length });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // GET /conflicts/ledger（issue #641，beta 第三阶段）：矛盾分诊账本的只读面——
  // 分诊分布（按 tier 计数）+ 最近账本行。conflict_ledger 是 bookkeeping 表，
  // 这里的行不是待办（处置由 enforce 档自动完成），面板只回答「账本里有什么、
  // 分布如何」。policy 与 /conflicts 同级（token）：行带标题级信息与检出时间，
  // 不该对未持 token 的本地进程开放。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/conflicts/ledger",
    policy: "token",
    handler(req, res) {
      try {
        if (req.method !== "GET") {
          sendJson(res, 404, { error: "not-found" });
          return;
        }
        const url = new URL(req.url, "http://localhost");
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
        const items = service.listConflictLedger({ limit, offset });
        const counts = {
          dup: service.countConflictLedger({ tier: "dup" }),
          "cross-scope-dup": service.countConflictLedger({ tier: "cross-scope-dup" }),
          evolution: service.countConflictLedger({ tier: "evolution" }),
          conflict: service.countConflictLedger({ tier: "conflict" })
        };
        sendJson(res, 200, { items, counts, total: service.countConflictLedger() });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  register({
    kind: "exact",
    path: "/api/dsh-mneme/conflicts/resolve",
    policy: "token",
    handler(req, res) {
      try {
        if (req.method !== "POST") {
          sendJson(res, 404, { error: "not-found" });
          return;
        }
        return readBody(req, res).then((text) => {
          if (text === null) return;
          let body = {};
          try { body = JSON.parse(text || "{}"); } catch { /* 坏 JSON → 走缺参分支 */ }
          const id = typeof body.id === "string" ? body.id.trim() : "";
          if (!id) {
            sendJson(res, 400, { error: "missing-id" });
            return;
          }
          const winner = body.winner === "a" || body.winner === "b" ? body.winner : null;
          const apply = body.apply !== false;
          const result = service.resolveConflictPending(id, { winner, apply });
          if (!result) {
            sendJson(res, 404, { error: "not-found" });
            return;
          }
          sendJson(res, 200, { ok: true, conflict: result });
        }).catch(() => sendJson(res, 500, { error: "internal" }));
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- health: mirror sync state (F-NEW-03 / v0.3.6) + capacity (#275) ---
  // Auth-gated; only returns a sanitized error code (never raw last_error which
  // may leak paths/token-like strings/internal hosts). On state read failure it
  // reports unknown/degraded (fail-closed) instead of a false dirty=false.
  register({
    kind: "exact",
    path: "/api/dsh-mneme/health",
    policy: "token",
    handler(req, res) {
      // 容量预警（#275 空间维度）：与镜像状态同面但**互相独立**——镜像读失败不该
      // 把容量数字一起藏掉，所以每个分支都带上。getCapacityHealth 自身 fail-safe
      // （读失败回 status:"unknown"）；?.() 兜住没接线的老 mock service（此时显式
      // capacity:null，面板渲染成「未知」，不冒充正常）。
      let capacity = null;
      try {
        capacity = service.getCapacityHealth?.() ?? null;
      } catch {
        capacity = null;
      }
      let state = null;
      try {
        state = service.getMirrorHealth?.() ?? null;
      } catch {
        // read failure is itself a health signal: do not report a false clean
        sendJson(res, 200, { mirror: { dirty: null, status: "unknown", last_error: null, last_attempt: null, success_at: null }, capacity });
        return;
      }
      if (!state) {
        sendJson(res, 200, { mirror: { dirty: null, status: "unknown", last_error: null, last_attempt: null, success_at: null }, capacity });
        return;
      }
      // Real read failure surfaces as dirty === null (peer blocker 5): report
      // unknown explicitly instead of collapsing into a false "ok"/"degraded".
      if (state.dirty === null) {
        sendJson(res, 200, {
          mirror: { dirty: null, status: "unknown", last_error: null, last_attempt: null, success_at: null },
          capacity
        });
        return;
      }
      // Sanitized: boolean dirty + coarse status only; error string is mapped to
      // a bounded code, never echoed verbatim.
      let code = null;
      if (state.last_error) {
        const e = String(state.last_error);
        code = /enospc|no space/i.test(e) ? "no-space" : /permission|eacces/i.test(e) ? "permission" : "sync-failed";
      }
      sendJson(res, 200, {
        mirror: {
          dirty: state.dirty === true,
          status: state.dirty === true ? "degraded" : (code ? "degraded" : "ok"),
          last_error: code,
          last_attempt: state.last_attempt ?? null,
          success_at: state.success_at ?? null
        },
        capacity
      });
    }
  });

  // --- panel mode (v0.7.12): light / standard -------------------------------
  // Persists the Web panel's feature preset into the settings kv
  // ("panel_mode"). PUT requires auth like every other settings write; the
  // value is validated against the enum. index.js applies the light preset on
  // the next boot (persisted mode wins over the bundle config).
  register({
    kind: "exact",
    path: "/api/dsh-mneme/mode",
    policy: "token-write",
    handler(req, res) {
      try {
        if (req.method === "PUT" || req.method === "POST") {
          return readBody(req, res).then((text) => {
            if (text === null) return;
            const body = parseBody(text);
            if (body.mode !== "light" && body.mode !== "standard") {
              sendJson(res, 400, { error: "invalid-mode" });
              return;
            }
            settings.setPanelMode(body.mode);
            sendJson(res, 200, { mode: settings.getPanelMode() });
          });
        }
        sendJson(res, 200, { mode: settings.getPanelMode() });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- external API settings (the standalone server's panel-facing config) ---
  register({
    kind: "exact",
    path: "/api/dsh-mneme/external-api",
    policy: "token",
    handler(req, res) {
      try {
        if (req.method === "PUT" || req.method === "POST") {
          return readBody(req, res).then((text) => {
            if (text === null) return;
            const body = parseBody(text);
            const patch = {};
            if (body.enabled !== undefined) patch.enabled = body.enabled === true;
            if (body.port !== undefined) {
              const port = Number(body.port);
              if (!Number.isInteger(port) || port < 1 || port > 65535) {
                sendJson(res, 400, { error: "invalid-port" });
                return;
              }
              patch.port = port;
            }
            if (body.host !== undefined) {
              const host = String(body.host).trim();
              if (!host || host.includes("://")) {
                sendJson(res, 400, { error: "invalid-host" });
                return;
              }
              patch.host = host;
            }
            sendJson(res, 200, { config: fullExternalConfig(settings.setExternalApi(patch)) });
          });
        }
        // GET 回的是能解锁整个 8790 数据面的 Bearer，敏感度等同写面：必须与
        // PUT 同门。未配置 apiToken 时 isAuthorized 恒真（既有的 fail-open 模型，
        // 见 SECURITY.md「安全模型」一节），所以默认配置下面板仍旧即装即用。
        // GET: hand back a token — the standalone server generates its own on
        // first enabled boot, but the panel displays it before that, so
        // materialize and persist one here. 只有通过上面那道门才会走到这里，
        // 否则「未鉴权的 GET 顺手写库」就是一条不需要凭证的写路径。
        const kv = settings.getExternalApi() ?? {};
        // ?token=omit：只读配置、不生成也不落库 Bearer。
        // 手机端面板（src/dsh-go）只需要 enabled/port/host 来渲染表单，而默认的
        // GET 会顺手 materialize 一个 token 写进 user_settings —— 一次纯读请求
        // 变成写路径，既污染审计也违反「面板不显示明文令牌」的承诺。带上这个
        // 参数时 token 字段一律留空；不传的老客户端行为完全不变。
        const omitToken = new URL(req.url, "http://localhost").searchParams.get("token") === "omit";
        if (!omitToken && !kv.token) {
          kv.token = randomBytes(24).toString("base64url");
          settings.setExternalApi({ token: kv.token });
        }
        sendJson(res, 200, { config: fullExternalConfig(omitToken ? { ...kv, token: "" } : kv) });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- feature flags（功能开关：面板逐项开关后端能力）-------------------------
  // 读路由保持开放（与 mode/list 一致），前端无需 token 即可渲染开关状态；PUT
  // 与其他设置写一致走 requireAuth。空/非对象 patch 直接 400：它不携带任何
  // 意图，静默成功只会掩盖前端 bug。校验失败（未知键/类型/越界）的 400 把键
  // 名放进 error，前端能直接定位写坏的开关。生效节奏与 panel_mode 相同：
  // 持久化后下次启动合并进 cfg，本次启动的运行时行为不变。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/features",
    policy: "token-write",
    handler(req, res) {
      try {
        if (req.method === "PUT" || req.method === "POST") {
          return readBody(req, res).then((text) => {
            if (text === null) return;
            const body = parseBody(text);
            if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length === 0) {
              sendJson(res, 400, { error: "invalid-patch" });
              return;
            }
            try {
              settings.setFeatureFlags(body);
            } catch (error) {
              sendJson(res, 400, { error: error.message });
              return;
            }
            sendJson(res, 200, featureSnapshot());
          });
        }
        sendJson(res, 200, featureSnapshot());
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // 注入状态（#182，只读）：面板状态页据此决定是否渲染「极简模式下注入按宿主
  // 设计关闭」提示卡。suppressed=true 需同时满足：autoInject 生效值开着（否则
  // 关注入是用户自己的选择，不是黑盒）、会话头 preset 为 minimal、且 preset 确
  // 实观测到了（null=未知会话/宿主不支持，面板静默不猜）。preset 值按字符串
  // 精确匹配 "minimal"——host bundle 的 preset id（#175 逐字证据），不做模糊。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/inject-status",
    policy: "open",
    handler(req, res) {
      try {
        if (req.method !== "GET") {
          sendJson(res, 404, { error: "not-found" });
          return;
        }
        const effective = featureSnapshot().effective;
        const autoInject = effective.autoInject === true;
        const agentPreset = lastAgentPreset;
        const suppressed = autoInject && agentPreset === "minimal";
        sendJson(res, 200, { autoInject, agentPreset, suppressed });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // 注入预览（#179，只读）：最近一帧 systemPrompt 组装的构成与体积——快照由
  // inject.js 在真实渲染路径旁路缓存（同一份 candidates，不二次检索）。null =
  // 尚未发生过渲染（新宿主/新会话）或 autoInject 关闭（注入器未注册），面板对
  // 两者都以「暂无预览」呈现，不区分也不猜。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/inject-preview",
    policy: "open",
    handler(req, res) {
      try {
        if (req.method !== "GET") {
          sendJson(res, 404, { error: "not-found" });
          return;
        }
        sendJson(res, 200, { snapshot: getInjectionSnapshot() });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- custom commands ---
  register({
    kind: "exact",
    path: "/api/dsh-mneme/commands",
    policy: "token-write",
    handler(req, res) {
      try {
        if (req.method === "POST") {
          return readBody(req, res).then((text) => {
            if (text === null) return;
            const body = parseBody(text);
            try {
              const command = commands.add({
                name: body.name,
                description: body.description,
                instruction: body.instruction
              });
              sendJson(res, 200, { command });
            } catch (error) {
              sendJson(res, 400, { error: error.message });
            }
          });
        }
        if (req.method === "DELETE") {
          const url = new URL(req.url, "http://localhost");
          const id = url.searchParams.get("id");
          const removed = id ? commands.remove(id) : false;
          sendJson(res, 200, { removed });
          return;
        }
        sendJson(res, 200, { commands: commands.list() });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- M.O.（Modus Operandi）工作流 ---
  // 只读端点，读的是**项目里**的 `<项目>/.mneme/pipelines/*.json`（文件头在
  // src/pipeline.js），项目层优先、插件包里那份降级成全局层；投影成
  // mneme.pipeline/v1 交给面板与 agent——两边读同一份，画面只是它的投影。
  // 运行账（`<id>.runs.jsonl`，文件头在 src/pipeline-runs.js）也在这里读：**没有账，
  // 读侧算不出任何状态**（`tallyRuns` 拿空数组时全体节点恒为 candidate），所以喂不喂
  // runs 决定的是「面板上有没有一句实话」，不是多一个可选装饰。
  // 刻意不做旗标闸门：旗标管的是**客户端座位**（关=一个座位都不注册），不是数据面；
  // 多一个只读端点不会让任何人看见它，而给它加闸门只会让「为什么面板打不开」多一种成因。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/pipeline",
    policy: "open",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const id = url.searchParams.get("id") || null;
        const project = url.searchParams.get("project");
        // project 是**会话工作目录**，由面板侧解析后带过来——工作目录只有客户端拿得到
        // （宿主会话头里的 header.cwd），服务端没有「当前项目」这个概念。
        // 不是绝对路径就**拒掉**，不能忽略：忽略了会静默退成「全局」，而全局看起来
        // 一切正常——那正是这版要修掉的那类错。
        if (project !== null && !isAbsolute(project)) {
          sendJson(res, 400, { error: "project-not-absolute", detail: project });
          return;
        }

        // 只读**账本目录**来定「哪些 id 有账」：最新一条 run 可能属于一条刚被删掉或
        // 还没写完的 .json，这时工作流目录里问不到它的 id，而账本还在盘上。
        // runIds 必须在 handler 级声明：下面观察旁挂块（同函数的另一个 if 分支）也按
        // 这份 id 列表取观察——之前声明在账本分支的块级作用域里，旁挂块一引用就
        // ReferenceError，被 catch 静默吞成「没有观察」（CodeRabbit #458 F1，
        // 复盘注释见下方旁挂块）。
        let runIds = [];
        let runsResult = { runsById: {}, errors: [], statesById: {} };
        if (project !== null) {
          const where = runsDir(project);
          runIds = existsSync(where)
            ? readdirSync(where)
                .filter((f) => f.endsWith(RUNS_SUFFIX))
                .sort()
                .map((f) => f.slice(0, -RUNS_SUFFIX.length))
            : [];
          if (runIds.length) {
            // step id 闸门：账本里出现「图上没有的 step id」时，credit 会落在一个没有节点的
            // 地方——**记了、数得出来、面板上永远看不见**，症状与「从没跑过」同形。
            // 这里把每条工作流的步骤表读出来当白名单，让那种行变成看得见的噪音。
            let stepIdsById = null;
            try {
              stepIdsById = Object.create(null);
              for (const p of loadPipelines(projectPipelineDir(project), { scope: "project" })) {
                stepIdsById[p.id] = p.steps.map((s) => s.id);
              }
            } catch {
              // 项目层有坏 .json 时 readPipelineDoc 会把它记进 `unreadable`；这里不重复报，
              // 也绝不因此让整个面板打不开——闸门退化成「没有白名单」，账本照读。
              stepIdsById = null;
            }
            runsResult = loadRunsById(project, runIds, { expectedStepIdsById: stepIdsById });
          }
        }
        const { runsById, errors: runsErrors, statesById } = runsResult;

        // P3 投影的燃料：观察旁挂（与 /candidates 的 memoryDir 同源同默认）。
        // 失败不连累图——旁挂是可再生的辅助数据，读不到就当没有，提议少一类而已。
        let observationsById = {};
        if (project !== null) {
          try {
            const memoryDir = (config && typeof config.memoryDir === "string" && config.memoryDir.trim() !== "")
              ? config.memoryDir
              : "~/.dsh/memory";
            const odir = observationDir({ memoryDir, projectKey: projectKey(project) });
            if (odir) {
              observationsById = loadObservationsById(odir, runIds.filter(Boolean));
            }
          } catch {
            // 读旁挂失败不算账本问题：如实降级成「没有观察」，fix-step-tool 少发而已
          }
        }

        const doc = readPipelineDoc({ projectRoot: project, id, runsById, observationsById });

        // 「读不出来」与「还没跑过」在节点状态上完全同形（都是全体 candidate），而且
        // **不带 id 的默认视图没有兜底**——那正是用户打开时看到的那一屏。所以状态按
        // pipeline 逐条显式带出去（清单行的 `runsState` 与选中那条的顶层 `runsState`），
        // 客户端不必靠顶层噪音猜。也刻意**不再**对坏账本回 500：那会让客户端把它当成
        // 「离线」，还顺手吞掉本来读得出来的那张图（账本坏了，工作流本身没坏）。
        // 没有项目根时账本层无从读起，如实给 null，而不是谎称「没有账本文件」。
        const chosenId = doc.pipeline ? doc.pipeline.id : null;
        const runsState = project !== null && chosenId !== null ? statesById[chosenId] || "absent" : null;
        const available =
          project === null
            ? doc.available
            : doc.available.map((row) => ({ ...row, runsState: statesById[row.id] || "absent" }));

        sendJson(res, 200, { ...doc, available, runsState, runsErrors });
      } catch (error) {
        // 工作流是人手写的 JSON，报错本身就是给人看的：说清哪一条、坏在哪，
        // 而不是回一句 internal 让人去翻日志。
        sendJson(res, 500, {
          error: "pipeline-unreadable",
          detail: String((error && error.message) || error)
        });
      }
    }
  });

  // --- M.O. 候选层（绕行走出来、还没进仓库的那些路） ---
  // 和 /pipeline 读的是两处不同的东西，别混：
  //   /pipeline    定稿，住**仓库**（<项目>/.mneme/pipelines/），可提交、可 review
  //   /candidates  候选，住**本地**（<memoryDir>/candidates/<项目键>/），随时长、随时扔
  // 分开是刻意的：候选是草稿，一天可能长十条死九条，进仓库就是垃圾；
  // 而定稿只放人亲手批过的东西——候选是定稿的唯一入口。
  //
  // 这一刀只给**读**：提议与批准的动作还没有落点（那要等执行侧）。
  // 契约里显式写着 boundaries.autoPromote/autoApprove/injectIntoMemory 三个 false，
  // 免得以后有人以为忘了做。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/candidates",
    policy: "open",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const project = url.searchParams.get("project");
        if (project !== null && !isAbsolute(project)) {
          sendJson(res, 400, { error: "project-not-absolute", detail: project });
          return;
        }
        // memoryDir 从 config 拿（与 store 同源）；取不到就退回默认，与 config.js 的默认值一致。
        const memoryDir = (config && typeof config.memoryDir === "string" && config.memoryDir.trim())
          ? config.memoryDir
          : "~/.dsh/memory";
        sendJson(res, 200, readCandidateDoc({ memoryDir, projectRoot: project }));
      } catch (error) {
        sendJson(res, 500, {
          error: "candidates-unreadable",
          detail: String((error && error.message) || error)
        });
      }
    }
  });

  // --- M.O. 自动沉淀（nudge）---
  // 读+写两种方法同路：GET 是**预览**（不落盘），POST 是**真跑**（落提议、可落草稿）。
  // 为什么不全放 GET：GET 会被浏览器预取、被面板刷新反复调用，而这一跑要解压几十份
  // zstd 会话日志（同步 I/O,本机实测 16.2s）。预览走 GET 时才关掉提议落盘
  // （persistProposals:false）——否则每刷一次面板就往 memoryDir 里塞一批文件。
  //
  // policy 是 token-write 而不是 open：GET 免 token（与 /pipeline、/candidates 同级的
  // 只读预览），POST 要 token——它会写盘，写盘面一律受门控。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/nudge",
    policy: "token-write",
    handler(req, res) {
      const method = String(req.method || "GET").toUpperCase();
      // 只认这四种。为什么必须在**读 body 之前**拦：下面 persistProposals 是按
      // 「不是 GET/HEAD」算的，于是 PATCH/DELETE 会被当成写动作，走进 run() 落提议；
      // 而它又不像 PUT/POST 那样读 body，等于一个不需要 body 的静默写盘口。
      // 这条 PR 自己的卖点是「GET 只预览、写动作一律要 POST」，那就得把口子堵死
      // （v0.9.3 评审抓出：带 token 的 PATCH/DELETE 会往 memoryDir 里写提议）。
      const allowed = method === "GET" || method === "HEAD" || method === "POST" || method === "PUT";
      if (!allowed) {
        sendJson(res, 405, { error: "method-not-allowed", allow: "GET, HEAD, POST, PUT" }, { Allow: "GET, HEAD, POST, PUT" });
        return;
      }
      const run = (body) => {
        try {
          const url = new URL(req.url, "http://localhost");
          const project = url.searchParams.get("project");
          // 与 /pipeline、/candidates 同一条规矩：不是绝对路径就拒掉，不能静默退成全局。
          if (project !== null && !isAbsolute(project)) {
            sendJson(res, 400, { error: "project-not-absolute", detail: project });
            return;
          }
          // 预算从**这里**起算，不是一个端点两套预算：归属解析（同步扫桶，最多 500 个）
          // 与后面的挖掘必须共用同一条截止线，否则「真卡就调 budgetMs」对前一段是空话。
          // POST（显式真跑）给三倍预算，面板预览给短预算。
          const previewMethod = method === "GET" || method === "HEAD";
          const startedAt = Date.now();
          const budgetMs = previewMethod ? NUDGE_AUTO_BUDGET_MS : NUDGE_AUTO_BUDGET_MS * 3;
          const deadline = startedAt + budgetMs;
          // 归属解析先做、单独回执：解析不到桶时要能说清是「这个项目还没跑过会话」
          // 还是「会话目录读不到」——两者在候选列表上都表现为空。
          const where = resolveProjectSessionDir({ projectRoot: project, deadline });
          if (!where.sessionDir) {
            // no-sessions-dir / unreadable / budget-exceeded / bucket-limit 都是**环境问题**
            // （读不到、没扫完、没扫全），回 503 让调用方知道这不是答案；
            // no-bucket / bad-project 是**关于这个项目的答案**，回 200。
            const envProblem = where.reason === "no-sessions-dir"
              || where.reason === "unreadable"
              || where.reason === "budget-exceeded"
              || where.reason === "bucket-limit";
            sendJson(res, envProblem ? 503 : 200, {
              error: envProblem
                ? (where.reason === "budget-exceeded"
                    ? "nudge-attribution-budget-exceeded"
                    : where.reason === "bucket-limit"
                      ? "nudge-attribution-bucket-limit"
                      : "nudge-sessions-unreadable")
                : undefined,
              contract: "mneme.nudge/v1",
              attribution: where,
              skipped: true,
              skippedReason: "no-session-attribution",
              counts: { candidates: 0, buckets: 0, sessionsWithCandidates: 0, savedProposals: 0, draftsWritten: 0 },
              available: [],
              drafts: [],
              boundaries: NUDGE_BOUNDARIES
            });
            return;
          }
          const memoryDir = (config && typeof config.memoryDir === "string" && config.memoryDir.trim())
            ? config.memoryDir
            : "~/.dsh/memory";
          const doc = nudgeForProject({
            projectRoot: project,
            // 上面已经解析过并判过 400/503，这里传进来，别再扫一遍桶。
            attribution: where,
            // now 传起算时刻：nudgeForProject 内部按 now+budgetMs 重新算截止点，这样
            // 两处算出来是同一条线（传 Date.now() 会让挖掘白拿一段已经花掉的预算）。
            now: startedAt,
            memoryDir,
            // GET 只预览：不落提议、不落草稿。写动作只认 POST/PUT——PATCH/DELETE 已在
            // 入口回 405，否则它们会落进这个「不是 GET/HEAD 就算写」的分支。
            persistProposals: method !== "GET" && method !== "HEAD",
            // 落草稿是「往仓库里塞文件」，必须显式要（body.materialize），默认不落。
            materialize: body && body.materialize === true,
            // 与归属解析共用同一条预算线：宁可少看几份并如实标 budgetExceeded，
            // 也不能让一次面板刷新把宿主主线程按住十几秒。
            budgetMs
          });
          sendJson(res, 200, doc);
        } catch (error) {
          sendJson(res, 500, {
            error: "nudge-failed",
            detail: String((error && error.message) || error)
          });
        }
      };
      if (method === "PUT" || method === "POST") {
        readBody(req, res).then((text) => {
          // readBody 已经回过 413：null 就是「别再往下走」。
          if (text === null) return;
          run(parseBody(text));
        });
        return;
      }
      run(null);
    }
  });

  // --- QQ 日记本（v0.13）-----------------------------------------------
  // 五条路由，闸门分两层：
  // - **装配缺件**（diary 参数没传 / headless 宿主）→ 503 diary-unavailable；
  // - **用户没开**（diaryEnabled=false）→ 409 disabled（#497 定下的 503/409 分叉）。
  // 读侧三条 policy "open"（与 /pipeline、/candidates 同级：只读、不写盘、宿主围栏统一
  // 鉴权）；写侧两条 "token-write"——它们会落盘：/diary/compose 调模型写正文，
  // /diary/export 往**用户项目目录**复制文件。写盘面一律受门控。
  //
  // project 参数照 /pipeline 的规矩：不是绝对路径就 400，**不能忽略**——服务端没有
  // 「当前项目」这个概念，忽略它就静默退成「全局」，而全局看起来一切正常。
  function diaryGate(req, res) {
    if (!diary) {
      sendJson(res, 503, { error: "unavailable", reason: "diary-unavailable" });
      return false;
    }
    if (!config || config.diaryEnabled !== true) {
      sendJson(res, 409, { error: "disabled", reason: "diary-not-enabled" });
      return false;
    }
    return true;
  }
  function diaryProject(req, res) {
    const project = new URL(req.url, "http://localhost").searchParams.get("project");
    if (project === null || project === "") {
      // 读侧不给 project 会退成「合并所有项目」——那正是要避免的静默全局。
      sendJson(res, 400, { error: "project-required" });
      return null;
    }
    if (!isAbsolute(project)) {
      sendJson(res, 400, { error: "project-not-absolute", detail: project });
      return null;
    }
    return project;
  }

  register({
    kind: "exact",
    path: "/api/dsh-mneme/diary",
    policy: "open",
    handler(req, res) {
      if (!diaryGate(req, res)) return;
      const project = diaryProject(req, res);
      if (!project) return;
      try {
        const dir = diaryDir({ memoryDir: config.memoryDir, projectRoot: project, configured: config.diaryDir });
        // 账本一起带走：面板要回答「今天为什么没有日记」时必须读它，不能靠猜。
        const audit = diary.readAudit({ projectRoot: project, limit: 20 });
        sendJson(res, 200, { contract: "mneme.diary/v1", project, dir, diaries: listDiaries(dir), audit });
      } catch (error) {
        sendJson(res, 500, { error: "diary-unreadable", detail: String((error && error.message) || error) });
      }
    }
  });

  register({
    kind: "exact",
    path: "/api/dsh-mneme/diary/entry",
    policy: "open",
    handler(req, res) {
      if (!diaryGate(req, res)) return;
      const project = diaryProject(req, res);
      if (!project) return;
      const date = new URL(req.url, "http://localhost").searchParams.get("date");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ""))) {
        sendJson(res, 400, { error: "date-required" });
        return;
      }
      try {
        const dir = diaryDir({ memoryDir: config.memoryDir, projectRoot: project, configured: config.diaryDir });
        const text = readDiary(dir, date);
        if (text === null) {
          // 404 而不是空串：面板据此区分「这一篇还没写」与「写了但是空的」。
          sendJson(res, 404, { error: "diary-not-found", date });
          return;
        }
        sendJson(res, 200, { contract: "mneme.diary/v1", date, path: `${dir}/${date}.md`, text });
      } catch (error) {
        sendJson(res, 500, { error: "diary-unreadable", detail: String((error && error.message) || error) });
      }
    }
  });

  register({
    kind: "exact",
    path: "/api/dsh-mneme/diary/compose",
    policy: "token-write",
    handler(req, res) {
      if (!diaryGate(req, res)) return;
      const method = String(req.method || "GET").toUpperCase();
      if (method === "GET" || method === "HEAD") {
        // 手动「写一篇」是会调模型的写动作，必须 POST——GET 会被浏览器预取、
        // 被面板刷新反复调用，等于每刷一次烧一次模型（/nudge 同款教训）。
        sendJson(res, 405, { error: "method-not-allowed", allow: "POST" }, { Allow: "POST" });
        return;
      }
      const project = diaryProject(req, res);
      if (!project) return;
      // 会话身份（「设定好人格的 agent 只以这个人格的口吻写日记」）：手动「写一篇」
      // 以前不传 agentId，于是永远落 default 卡——自动轮传了、手动轮没传，同一天
      // 从两个入口写出来的日记会用两张人格卡，这是最难发现的一类不一致。
      //
      // 身份来源只认两处，且**不带身份就不猜**：查询参数 ?agent= 是前端从会话行
      // 上读到的 agentPreset（与它算 project 用的是同一条快照），?session= 则让
      // 服务端按自己那份「会话 → 身份」账本反查。两处都空就照旧落 default 卡，
      // 但那是「不知道是谁」，不是「以为是 default」——frontmatter 的 persona 字段
      // 会如实写成 default 卡的名字，面板读得出来。
      const q = new URL(req.url, "http://localhost").searchParams;
      const rawAgent = typeof q.get("agent") === "string" ? q.get("agent").trim() : "";
      const rawSession = typeof q.get("session") === "string" ? q.get("session").trim() : "";
      const agentId = rawAgent || (rawSession ? (agentBySession.get(rawSession) || "") : "");
      Promise.resolve(diary.compose({
        trigger: "manual",
        projectRoot: project,
        agentId: agentId || null
      }))
        .then((result) => {
          // skip 不是错：already-written / no-material 都是关于这个项目的答案，回 200。
          const status = result && result.ok === false ? 500 : 200;
          sendJson(res, status, { contract: "mneme.diary/v1", ...result });
        })
        .catch((error) => {
          sendJson(res, 500, { error: "diary-compose-failed", detail: String((error && error.message) || error) });
        });
    }
  });

  register({
    kind: "exact",
    path: "/api/dsh-mneme/diary/export",
    policy: "token-write",
    handler(req, res) {
      if (!diaryGate(req, res)) return;
      const method = String(req.method || "GET").toUpperCase();
      if (method === "GET" || method === "HEAD") {
        sendJson(res, 405, { error: "method-not-allowed", allow: "POST" }, { Allow: "POST" });
        return;
      }
      const project = diaryProject(req, res);
      if (!project) return;
      readBody(req, res).then((text) => {
        if (text === null) return;
        const body = parseBody(text);
        const date = String(body.date ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          sendJson(res, 400, { error: "date-required" });
          return;
        }
        try {
          const dir = diaryDir({ memoryDir: config.memoryDir, projectRoot: project, configured: config.diaryDir });
          const result = exportDiary({ sourceDir: dir, projectRoot: project, date, overwrite: body.overwrite === true });
          const status = result.ok ? 200 : result.error === "target-exists" ? 409 : result.error === "no-diary" ? 404 : 500;
          sendJson(res, status, { contract: "mneme.diary/v1", ...result });
        } catch (error) {
          sendJson(res, 500, { error: "diary-export-failed", detail: String((error && error.message) || error) });
        }
      });
    }
  });

  // --- 日记库（左侧「ta 的日记」面板）-----------------------------------
  // 与上面五条**按项目定位**的日记路由是两件事：
  // 左侧面板长在 `main` 座位上，宿主不给它 sessionId，所以它算不出
  // 「当前会话的项目根」，也没法用 projectKey 定位单个桶。它要的是
  // 「有哪些桶、各是谁写的、各有多少篇」——那只能整体扫 diaries 根目录。
  //
  // 两条都 policy "open"：只读、不写盘、不调模型，鉴权交宿主围栏。
  // 闸门与上面同源（503 装配缺件 / 409 用户没开），否则会出现「右栏能读、
  // 左栏 404」这种看起来像坏了的分叉。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/diary/library",
    policy: "open",
    handler(req, res) {
      if (!diaryGate(req, res)) return;
      try {
        const { root, buckets } = listDiaryLibrary({
          memoryDir: config.memoryDir,
          configured: config.diaryDir
        });
        sendJson(res, 200, { contract: "mneme.diary/v1", root, buckets });
      } catch (error) {
        sendJson(res, 500, { error: "diary-unreadable", detail: String((error && error.message) || error) });
      }
    }
  });

  register({
    kind: "exact",
    path: "/api/dsh-mneme/diary/library/entry",
    policy: "open",
    handler(req, res) {
      if (!diaryGate(req, res)) return;
      const params = new URL(req.url, "http://localhost").searchParams;
      const bucket = params.get("bucket");
      const date = params.get("date");
      // 桶名与日期都要校验：这条路径直接拼文件系统路径，`..` 必须在这里挡住。
      // 用的就是 library.js 那道 `isBucketName`——两层不能各写一份规则，否则
      // 会出现「清单里列得出来、点进去 400」：历史上真有保留中文的桶
      // （`QQ对话-4f061790`），ASCII 白名单会把它列出来却读不到，用户看到的是
      // 点了没反应。真正的越界由 `readLibraryEntry` 里的真实路径解析兜底。
      if (!bucket || !isBucketName(bucket)) {
        sendJson(res, 400, { error: "bucket-required" });
        return;
      }
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        sendJson(res, 400, { error: "date-required" });
        return;
      }
      try {
        const text = readLibraryEntry({
          memoryDir: config.memoryDir,
          configured: config.diaryDir,
          bucket,
          date
        });
        if (text === null) {
          sendJson(res, 404, { error: "diary-not-found", bucket, date });
          return;
        }
        sendJson(res, 200, { contract: "mneme.diary/v1", bucket, date, text });
      } catch (error) {
        sendJson(res, 500, { error: "diary-unreadable", detail: String((error && error.message) || error) });
      }
    }
  });

  // --- chorography（仓库地志）M1 读侧路由 -------------------------------
  // spec §7 消费面的面板数据源。四条全 policy "open"：只读、宿主围栏统一鉴权
  // （与 /list、/version-check 同级）；**chorographyEnabled 关闭时一律 409
  // disabled**（#497 先例：路由挂着、逻辑层挡——面板据此渲染「未启用」空态）。
  // 仓库/模块/页面全部只从 choro_* 表与仓库磁盘读（真源是盘上的 MD），没有
  // 任何写路径；生成入口在 M2 才有（T1 生成轮同批接）。
  // choro 参数缺省 null：headless/测试环境没有 queries 时这四条路由回 503
  // unavailable（语义分叉见 #497：503 = 环境缺件，409 = 用户没开）。
  function choroGate(req, res) {
    if (!choro) {
      sendJson(res, 503, { error: "unavailable", reason: "choro-queries-unavailable" });
      return false;
    }
    if (!config || config.chorographyEnabled !== true) {
      sendJson(res, 409, { error: "disabled", reason: "chorography-not-enabled" });
      return false;
    }
    return true;
  }
  function choroResolveOr4xx(req, res) {
    const repo = choro.resolveRepo(
      new URL(req.url, "http://localhost").searchParams.get("repo")
    );
    if (!repo || repo.ambiguous) {
      sendJson(res, repo && repo.ambiguous ? 400 : 404, {
        error: repo && repo.ambiguous ? "repo-ambiguous" : "repo-not-found",
        repos: repo && repo.ambiguous ? repo.ambiguous : undefined
      });
      return null;
    }
    return repo;
  }

  // 读侧自动重跑（chorographyAutoRefresh）。面板的语义是「读地志页时发现仓库代码
  // 变了就顺手重跑一次 T0」——T0 是零模型的确定性扫描，成本只在磁盘；但它会重写
  // 仓库里的 .chorography/**，所以默认关，且一次请求最多刷一个仓库。
  //
  // 为什么失败不 500：读是主诉求、刷新是附赠。git rev-parse 偶发失败或磁盘只读时，
  // 把整张仓库列表打成 500 等于「因为顺手的事没办成，连正式的事都不给办了」。
  // 错误塞进 autoRefreshError 让面板能说清，数据照发。
  //
  // 为什么要 caller 指定 repo：一次面板加载若把 5 个 stale 仓库全扫一遍，用户只是
  // 打开一个页面却付了 5 次全仓扫描；列表路径只在 ?repo= 明确点名时才刷。
  function autoRefreshOne(repoId, facts) {
    const result = {
      autoRefreshed: false,
      autoRefreshError: undefined,
      // autoRefreshSkipped 与 autoRefreshError 是两件事：前者是「我们主动没做」，
      // 后者是「试了但失败了」。混成一个字段会让面板把一次正确的拒绝说成故障。
      autoRefreshSkipped: undefined,
      autoRefreshSkipNote: undefined,
      repo: facts
    };
    if (!config || config.chorographyAutoRefresh !== true) return result;
    if (!facts || facts.staleReason !== "git") return result;
    if (typeof choro.runT0Apply !== "function") return result;
    // 有富化页时先别动手：读侧刷新只该刷新「确定性骨架」，不该在用户点开一页时
    // 顺手把语义段（花模型调用换来的）连同 claims 一起清掉。T0 自己也会拒绝
    // （guardT1Loss），这里提前拦一道是为了给面板一句能直接显示的人话，
    // 并且不进 warn 日志——这不是异常。
    if (Number(facts.enrichedPages ?? 0) > 0) {
      result.autoRefreshSkipped = "t1-loss";
      result.autoRefreshSkipNote =
        `这个仓库有 ${facts.enrichedPages} 页已经富化过：自动刷新会退回骨架、清空语义段与结论，`
        + "所以这次没有动。代码已变这件事仍然有效，需要新快照请在面板里手动点「重建骨架」。";
      return result;
    }
    try {
      // guardT1Loss 必须显式传：库里的 enrichedPages 只是第一道提示（快、能生成人话），
      // 真正读盘判断「会丢哪几页」的是 T0 自己。不传给 T0 等于把唯一的硬守卫关掉。
      choro.runT0Apply({ repoRoot: facts.rootPath, guardT1Loss: true });
      result.autoRefreshed = true;
      // 重跑之后基线推进了，回执里的 stale 必须按新基线说话：沿用旧行的判定会让
      // 面板刚刷完就显示「代码已变」，也就是谎报一次失败。
      const fresh = typeof choro.repoFactsById === "function" ? choro.repoFactsById(repoId) : null;
      if (fresh) result.repo = fresh;
    } catch (err) {
      // would-drop-t1 是 T0 侧的同一条判断（它读盘，比这里的库计数更准）：
      // 到这一层说明库里的 enrichedPages 和磁盘上的实际情况对不上，仍按「主动跳过」
      // 处理并把人话透出去，绝不报成刷新失败。
      if (err?.code === "would-drop-t1") {
        result.autoRefreshSkipped = "t1-loss";
        result.autoRefreshSkipNote = String(err?.message ?? err);
        return result;
      }
      result.autoRefreshError = String(err?.message ?? err);
      ctx.logger?.warn?.(`dsh-mneme: choro auto refresh failed for repo ${repoId}: ${result.autoRefreshError}`);
    }
    return result;
  }

  register({
    kind: "exact",
    path: "/api/dsh-mneme/choro/repos",
    policy: "open",
    handler(req, res) {
      if (!choroGate(req, res)) return;
      // 契约 §3.2 的字段（stale / staleReason / lastRunAt / legacy / claims）由
      // queries 层的 listRepoFacts 出；这里留 fallback 是因为既有测试与工具层会
      // 用裸对象冒充 choro（只实现 runT0Apply），缺一个方法就 500 是没必要的脆。
      const repos = typeof choro.listRepoFacts === "function" ? choro.listRepoFacts() : choro.listRepos();
      const repoParam = new URL(req.url, "http://localhost").searchParams.get("repo");
      let autoRefreshed = false;
      let autoRefreshError;
      let autoRefreshSkipped;
      let autoRefreshSkipNote;
      if (repoParam !== null && repoParam !== "") {
        const target = choro.resolveRepo(repoParam);
        if (target && !target.ambiguous) {
          const idx = repos.findIndex((r) => Number(r.id) === Number(target.id));
          if (idx >= 0) {
            const refreshed = autoRefreshOne(target.id, repos[idx]);
            autoRefreshed = refreshed.autoRefreshed;
            autoRefreshError = refreshed.autoRefreshError;
            autoRefreshSkipped = refreshed.autoRefreshSkipped;
            autoRefreshSkipNote = refreshed.autoRefreshSkipNote;
            if (refreshed.repo) repos[idx] = refreshed.repo;
          }
        }
      }
      // cliCommand（#607）：面板空态直接把它贴出来，用户复制即用。推导不出
      // 入口时为 null，面板据此退回通用说法（不硬编一个假路径）。
      sendJson(res, 200, { repos, autoRefreshed, autoRefreshError, autoRefreshSkipped, autoRefreshSkipNote, cliCommand: CHORO_CLI });
    }
  });

  register({
    kind: "exact",
    path: "/api/dsh-mneme/choro/modules",
    policy: "open",
    handler(req, res) {
      if (!choroGate(req, res)) return;
      const repo = choroResolveOr4xx(req, res);
      if (!repo) return;
      const { modules, edges } = choro.moduleMap(repo.id);
      sendJson(res, 200, {
        repo: { id: repo.id, name: repo.name, gitBaseline: repo.git_baseline },
        modules,
        edges
      });
    }
  });

  register({
    kind: "exact",
    path: "/api/dsh-mneme/choro/page",
    policy: "open",
    handler(req, res) {
      if (!choroGate(req, res)) return;
      const repo = choroResolveOr4xx(req, res);
      if (!repo) return;
      const slug = new URL(req.url, "http://localhost").searchParams.get("slug");
      if (!slug) {
        sendJson(res, 400, { error: "slug-required" });
        return;
      }
      // 读页是面板的主路径，也正是「读地志页时发现代码变了就重跑」这句文案对应的
      // 那一刻——自动刷新优先挂在这里（/choro/repos 只在 ?repo= 点名时才刷）。
      // 刷新必须在 readPage 之前：T0 会重写页文件，先读后刷会把刚被替换掉的旧正文
      // 回给面板，用户下一次刷新才看到新内容，看起来就像「刷了没用」。
      const before = typeof choro.repoFactsById === "function" ? choro.repoFactsById(repo.id) : null;
      const refreshed = autoRefreshOne(repo.id, before);
      const page = choro.readPage(repo.id, slug);
      // 顶栏「代码已变」徽章读 state.repo.stale：这一份 repo 必须和 page 同源同刻，
      // 否则刚刷完还会亮着旧徽章。
      const repoNow = refreshed.repo ?? before;
      if (!page) {
        sendJson(res, 404, { error: "page-not-found", slug });
        return;
      }
      if (page.error) {
        // 409 保留已登记的页与未知 slug 的区别，恢复方式取决于文件状态。
        sendJson(res, 409, {
          error: page.error,
          slug: page.slug,
          relPath: page.relPath,
          hint: page.error === "page-missing"
            ? `run ${CHORO_CLI ? `\`${CHORO_CLI}\`` : "`dsh-mneme-choro <repo> --apply`"} to rebuild`
            : "check the local file and its permissions"
        });
        return;
      }
      sendJson(res, 200, {
        page,
        repo: repoNow ? {
          id: repoNow.id,
          name: repoNow.name,
          rootPath: repoNow.rootPath,
          stale: repoNow.stale,
          staleReason: repoNow.staleReason,
          legacy: repoNow.legacy,
          // 面板要靠它解释「为什么这次自动刷新没动」——它是主动拒绝的依据，
          // 不是内部账本，所以随读页一起回。
          enrichedPages: repoNow.enrichedPages ?? 0,
          lastRunAt: repoNow.lastRunAt
        } : { id: repo.id, name: repo.name },
        autoRefreshed: refreshed.autoRefreshed,
        autoRefreshError: refreshed.autoRefreshError,
        autoRefreshSkipped: refreshed.autoRefreshSkipped,
        autoRefreshSkipNote: refreshed.autoRefreshSkipNote
      });
    }
  });

  register({
    kind: "exact",
    path: "/api/dsh-mneme/choro/search",
    policy: "open",
    handler(req, res) {
      if (!choroGate(req, res)) return;
      const repo = choroResolveOr4xx(req, res);
      if (!repo) return;
      const url = new URL(req.url, "http://localhost");
      const hits = choro.search(repo.id, url.searchParams.get("q"), {
        moduleSlug: url.searchParams.get("module"),
        limit: Number(url.searchParams.get("limit") ?? 20)
      });
      // 向量路（收尾档 P37/P39）：embedder 可用时惰性物化 + 余弦 Top-N，独立成
      // semantic 数组——两路分数量纲不同，不混排序。embedder 缺席（CLI/测试装配）
      // → semantic: null，调用方据此退纯关键词。永不抛：向量路挂了不影响 hits。
      const embedder = choro.embedder ?? null;
      const finish = (semantic) => sendJson(res, 200, { q: url.searchParams.get("q"), hits, semantic });
      if (!embedder) { finish(null); return; }
      // 必须 return 整条链：invoke/测试是 await route.handler(...)，不 return 就
      // 会在响应发出之前返回（实测：semantic 永远缺席、body 恒空）。
      // 顺序（P37/P38）：先嵌查询拿 expectDim → 惰性物化（dim 失配全量重嵌）→
      // 本轮 semantic 用刚物化完的最新向量算。
      return Promise.resolve()
        .then(() => choro.embedQueryText(embedder, url.searchParams.get("q")))
        .then((qv) => choro.embedPageVectors(repo.id, embedder, { expectDim: qv ? qv.length : null }).then(() => qv))
        .then((qv) => choro.semanticTopN(repo.id, qv, { limit: Number(url.searchParams.get("limit") ?? 10) }))
        .then((semantic) => finish(semantic))
        .catch(() => finish(null));
    }
  });

  // Claim 粒度失效清单（借 openwiki 的 Grounded Claims）。只读、policy open，
  // 与其余 choro 读路由同级。
  //
  // 为什么不落库：判据是 git diff × claims 三列证据的纯机械比对，一次几十毫秒。
  // 落库就多一份要失效的缓存，而它唯一的消费者（面板）本来就是打开时现读。
  // 写路径一条不加，spec §4 的红线（生成只走 CLI）不动。
  //
  // 响应三态刻意分开，别让面板把「算不出来」说成「没事」：
  //   200 clean:true             基线 == HEAD，确实没变
  //   200 anchorStale:true       基线认不出 / git 不可读（附 reason）
  //   200 clean:false 且有 pages  正常算出来了，逐页看 atRisk
  // 仓库不存在 → 404；chorography 关闭 → 409；queries 未装配 → 503（由 choroGate 给）。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/choro/claims",
    policy: "open",
    handler(req, res) {
      if (!choroGate(req, res)) return;
      const repo = choroResolveOr4xx(req, res);
      if (!repo) return;
      if (typeof choro.claimDrift !== "function") {
        sendJson(res, 503, { error: "unavailable", reason: "choro-claims-unavailable" });
        return;
      }
      let drift;
      try {
        drift = choro.claimDrift(repo.id);
      } catch (err) {
        // 读盘（页面正文判 hasT1）可能撞上权限/占用：说清是哪一步炸的，
        // 不要假装「没有 claim」。
        sendJson(res, 500, { error: "claims-failed", detail: String(err?.message ?? err) });
        return;
      }
      if (!drift) {
        sendJson(res, 404, { error: "repo-not-found" });
        return;
      }
      sendJson(res, 200, drift);
    }
  });

  // 面板重建入口（收尾档 P34）：T0 apply 秒级同步回执。
  // policy token-write：写的是仓库磁盘的 .chorography/**，属数据面写。
  //
  // 扩容（契约 §3.2，607 修复）：body 支持 { repo?, path? | rootPath?, refresh? }。
  // 必须支持按**绝对路径**登记新仓库，否则「一个仓库都没登记」的空态面板永远出不来
  // ——面板没有 id 可传，只能给路径。已登记路径则复用既有 id（T0 的 upsertChoroRepo
  // 按 root_path 冲突更新，本来就不会重号）。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/choro/run",
    policy: "token-write",
    handler(req, res) {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method-not-allowed", allow: "POST" }, { Allow: "POST" });
        return;
      }
      if (!choroGate(req, res)) return;
      // return 链：同上，await route.handler 必须等到响应真的发出（nudge 同款）。
      return readBody(req, res).then((text) => {
        if (text === null) return; // readBody 已回 413
        const body = parseBody(text);
        const repoRef = body && typeof body === "object" ? body.repo : null;
        const rootInput = body && typeof body === "object"
          ? (typeof body.path === "string" ? body.path : (typeof body.rootPath === "string" ? body.rootPath : null))
          : null;
        // refresh 是「我要求重建」的意图标记，不是「需要额外再刷一次」的开关：
        // 这条路由本身就是显式重建，T0 会在自己那次 apply 里把 git 基线推进到当前
        // HEAD，之后没有第二件事可做。保留字段是为了让面板把「用户点了重建」与
        // 「读侧顺手刷新」两种来源区分开——回执里 autoRefreshed 因此恒为 false，
        // 它不是失败信号，而是「这次没人替你偷偷刷」。
        const refresh = body && typeof body === "object" ? body.refresh === true : false;

        let repoRoot;
        if (typeof rootInput === "string" && rootInput.trim() !== "") {
          // 路径必须绝对：相对路径的语义取决于宿主进程的 cwd，同一个请求在 CLI 与
          // 面板里会落到不同目录——那种「有时行有时不行」最难查。
          if (!isAbsolute(rootInput.trim())) {
            sendJson(res, 400, { error: "path-not-absolute", path: rootInput });
            return;
          }
          repoRoot = rootInput.trim();
        } else {
          const repo = choro.resolveRepo(repoRef);
          if (!repo || repo.ambiguous) {
            sendJson(res, repo && repo.ambiguous ? 400 : 404, {
              error: repo && repo.ambiguous ? "repo-ambiguous" : "repo-not-found",
              repos: repo && repo.ambiguous ? repo.ambiguous : undefined
            });
            return;
          }
          repoRoot = repo.root_path;
        }

        try {
          const receipt = choro.runT0Apply({ repoRoot });
          // autoRefreshed 恒 false：显式重建已经是最强的刷新，没有「额外自动刷新」
          // 这回事。写成常量而不是省略字段，是为了让面板的两种来源（显式 / 顺手）
          // 共用同一个回执形状，不必按路由分支判 undefined。
          sendJson(res, 200, { ok: true, autoRefreshed: false, refresh, receipt });
        } catch (err) {
          // 结构化分叉而不是 500 一锅烩：路径不存在 / 不是 git 仓库都是「用户给错了
          // 东西」，面板要能据此说人话并让他改路径，而不是显示「服务端错误，重试」。
          // 判据走 err.code 字符串（ChoroRefusal.code / PlanInvalidError.name），
          // 因为 api.js 刻意不 import src/wiki/*（不让 HTTP 面依赖编排层）。
          const code = err && typeof err.code === "string" ? err.code : null;
          if (code === "no-such-dir") {
            sendJson(res, 400, { error: "path-not-found", path: repoRoot, detail: String((err && err.message) || err) });
            return;
          }
          if (code === "not-git") {
            sendJson(res, 409, { error: "not-a-git-repo", path: repoRoot, detail: String((err && err.message) || err) });
            return;
          }
          if (err && err.name === "PlanInvalidError") {
            sendJson(res, 409, {
              error: "plan-invalid",
              path: repoRoot,
              detail: String((err && err.message) || err),
              issues: Array.isArray(err.issues) ? err.issues : undefined
            });
            return;
          }
          sendJson(res, 500, { error: "t0-failed", detail: String((err && err.message) || err) });
        }
      });
    }
  });

  // T1 后台任务（契约 §3.2 / 面板 §3.5）。**不在这里 spawn**：进程账住在
  // wiki/t1-jobs.js（api.js 不 import child_process），这里只做参数解析、闸门与
  // 409 分叉。choro.startT1Job 缺席（CLI / 测试装配）→ 503，与读侧同一条语义：
  // 503 = 环境缺件，409 = 用户没开。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/choro/t1",
    policy: "token-write",
    handler(req, res) {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method-not-allowed", allow: "POST" }, { Allow: "POST" });
        return;
      }
      if (!choroGate(req, res)) return;
      if (typeof choro.startT1Job !== "function") {
        sendJson(res, 503, { error: "unavailable", reason: "t1-jobs-unavailable" });
        return;
      }
      // T1 花模型额度，所以除了总闸之外还有一道单独的用户闸（契约 §3.1 的理由：
      // 关总闸等于整个子系统不可见，而只想关「面板能不能花钱」的人需要更细的闸）。
      if (!config || config.chorographyT1FromPanel !== true) {
        sendJson(res, 409, { error: "disabled", reason: "t1-from-panel-disabled" });
        return;
      }
      return readBody(req, res).then((text) => {
        if (text === null) return;
        const body = parseBody(text);
        const repoRef = body && typeof body === "object" ? body.repo : null;
        const repo = choro.resolveRepo(repoRef);
        if (!repo || repo.ambiguous) {
          sendJson(res, repo && repo.ambiguous ? 400 : 404, {
            error: repo && repo.ambiguous ? "repo-ambiguous" : "repo-not-found",
            repos: repo && repo.ambiguous ? repo.ambiguous : undefined
          });
          return;
        }
        const started = choro.startT1Job({
          repo,
          module: body && typeof body.module === "string" && body.module.trim() !== "" ? body.module.trim() : null,
          retryFailed: body && typeof body === "object" ? body.retryFailed === true : false
        });
        if (!started || started.started !== true) {
          // 同一仓库并发跑 T1 会把两个进程写进同一批页面（claims 交错），必须挡。
          const errCode = started && started.code === "job-running" ? "job-running" : "t1-start-failed";
          sendJson(res, errCode === "job-running" ? 409 : 500, {
            error: errCode,
            jobId: started && started.jobId ? started.jobId : undefined
          });
          return;
        }
        sendJson(res, 200, { jobId: started.jobId, started: true });
      });
    }
  });

  // 任务状态轮询（面板 2s 一次）。jobId 未知 → 404：任务记录只在内存里，宿主重启
  // 后旧 id 必然查不到，回 404 让面板回到「没有正在跑的任务」而不是假装 running。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/choro/t1/status",
    policy: "token-write",
    handler(req, res) {
      if (!choroGate(req, res)) return;
      if (typeof choro.t1JobStatus !== "function") {
        sendJson(res, 503, { error: "unavailable", reason: "t1-jobs-unavailable" });
        return;
      }
      const jobId = new URL(req.url, "http://localhost").searchParams.get("jobId");
      if (!jobId) {
        sendJson(res, 400, { error: "jobId-required" });
        return;
      }
      const job = choro.t1JobStatus(jobId);
      if (!job) {
        sendJson(res, 404, { error: "job-not-found", jobId });
        return;
      }
      sendJson(res, 200, job);
    }
  });

  // 知识库第二层（契约 §3.6）。闸与 choro 同款分叉：装配缺件 503 / 用户没开 409。
  // 这里只判开关，不判「有没有集合」——空知识库是合法状态（面板要能显示空态）。
  function kbGate(req, res) {
    if (!kb) {
      sendJson(res, 503, { error: "unavailable", reason: "kb-unavailable" });
      return false;
    }
    if (!config || config.kbEnabled !== true) {
      sendJson(res, 409, { error: "disabled", reason: "kb-not-enabled" });
      return false;
    }
    return true;
  }
  registerKbRoutes(register, { kb, cfg: config ?? {}, sendJson, readBody, parseBody, gate: kbGate });

  return {
    routes: countRoutes(),
    dispose: () => {
      for (const dispose of disposers) dispose();
    }
  };
}
