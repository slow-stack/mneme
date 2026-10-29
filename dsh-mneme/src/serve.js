// src/serve.js —— 独立服务(daemon)运行时:mneme 在 DSH 宿主之外常驻的最小装配面
// (#363 承诺的「官方推荐第三方挂载姿势」)。bin/dsh-mneme-serve.mjs 是它的 CLI 壳,
// Mneme Bridge 这类第三方也可直接 import 本模块自行托管生命周期。
//
// 与宿主装配(src/index.js apply)的关系:只搬数据面 + 语义管线两块,每步注释锚定
// index.js 来源行号。刻意不抽公共装配函数——apply 的其余环节(注入/工具/dream)与
// 宿主 ctx 纠缠,防御段纪律是「最后动或不动」;本文件的漂移风险由 serve-bin 测试的
// 多进程共存用例兜底(两侧真开同一个库互写互读)。
//
// 无 LLM:巩固(autoDream)与蒸馏(autoSummarize)结构上不在这里——巩固只属于 DSH
// 宿主进程,这就是 daemon 与宿主「单写者」的机械保证(AGENTS.md 的 externalApi/
// autoDream 单侧纪律),不依赖用户自觉。语义检索(PR2 起)与宿主共用 src/semantic.js
// 的同一份装配;daemon 不参与做梦,但向量检索/语义去重与宿主同质。
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.js";
import { createSettings } from "./settings.js";
import { createMirror, TYPE_FILE } from "./mirror.js";
import { langOf } from "./lang.js";
import { createService } from "./service.js";
import { createMaintenance } from "./maintenance.js";
import { createStandaloneApi } from "./api-standalone.js";
import { createSemantic } from "./semantic.js";
import { createVectorIndex } from "./vector-index.js";
import { provisionRuntime } from "./runtime/provision.js";
import { defaultRuntimeDir, listPayloadDirs } from "./runtime/layout.js";

const EMBED_PROVIDERS = new Set(["off", "local", "ollama", "openai"]);

/**
 * 组装并启动一个独立数据面(含语义管线)。
 * @param {object} opts
 *   memoryDir  — 数据目录;缺省与宿主同默认 ~/.dsh/memory(config.js:9),支持前导 ~。
 *   port/host  — 透传 createStandaloneApi;缺省走 kv external_api 持久值 > 8790/127.0.0.1。
 *   logger     — console 形状(info/warn/error,收单字符串);缺省 null(全链路容缺)。
 *   strictPort — 默认 true:配置端口被占即失败(第三方把 URL 写死,顺延=静默打到
 *                错误端口)。显式 port=0(测试/OS 分配)不受影响。
 *   embed      — "local"(默认,自管 runtime 取件 + ONNX 嵌入)|"ollama"|"openai"
 *                (读宿主面板配的 vector-config)|"off"(纯关键词 + BM25)。
 *   embedder/reranker — 注入式覆盖(测试/宿主方自管):给了就跳过 createSemantic,
 *                直接 setEmbedder/setReranker;仅 embed="off" 之外有意为之。
 * @returns {api, store, service, settings, maintenance, semantic, tokenExisted, dispose}
 *   tokenExisted — 启动前 kv 里是否已有 token;false 时本次为首次生成,入口层可提示。
 */
export async function createServeRuntime({
  memoryDir, port, host, logger = null, strictPort = true, embed = "local", embedder = null, reranker = null
} = {}) {
  if (!EMBED_PROVIDERS.has(embed)) {
    throw new Error(`invalid embed provider: ${String(embed)}(允许 off/local/ollama/openai)`);
  }
  // index.js:192-195:~ 展开只认前导;目录不存在时 node:sqlite 直接抛,先 mkdir。
  const dir = String(memoryDir || join(homedir(), ".dsh", "memory")).replace(/^~(?=$|[\\/])/, homedir());
  mkdirSync(dir, { recursive: true });

  // 装配顺序照 index.js:197-292:store → settings → mirror → service → recoverMirror。
  const store = createStore(join(dir, "memory.db"));
  const settings = createSettings(store.db);
  // 第一期不吃宿主 config schema(schemastery 是宿主 peer 依赖,独立进程装不装随缘),
  // 配最小集,与第三方 embedded 挂载实测同形:language 参与镜像渲染与去重标题;
  // documentMemoryEnabled 关掉 document 子系统(daemon 不建 documentIndex,service
  // 内部 if-guard 安全,index.js:261 的 documentIndex 仅宿主装配)。
  const cfg = { language: "zh", documentMemoryEnabled: false };
  // #509 评审整改补的一格:GET /memory/provenance 的读门读 cfg.distillRecords.enabled
  // (判据在 src/provenance-http.js,与写侧 src/summarize.js:988 同源)。daemon 与宿主
  // 共用同一个 memory.db、同一份 feature_flags kv,所以这里把用户显式开关展开进 cfg
  // ——index.js:217-233 同款展开,只取蒸馏这一组(daemon 其余键仍刻意不吃宿主 config
  // schema)。不展开的后果:daemon 对这一面恒定回「功能关了」,哪怕用户在面板里开着、
  // 库里明明有原文——对这个端点那是一句谎话,而「两种空必须分开读数」正是本仓纪律。
  // 残留不对称(写进 docs/DAEMON.md 与 PR):只靠 bundle 配置打开、从没在面板点过的
  // 用户,宿主认、daemon 不认——daemon 结构上看不到宿主的 bundle config,这是它看不见
  // 的那一半,不是本处能补的。
  const persistedFlags = settings.getFeatureFlags?.() ?? {};
  if (typeof persistedFlags["distillRecords.enabled"] === "boolean") {
    cfg.distillRecords = { ...(cfg.distillRecords ?? {}), enabled: persistedFlags["distillRecords.enabled"] };
  }
  const mirror = createMirror(dir, langOf(cfg));
  const service = createService({ store, mirror, config: cfg, logger });

  // index.js:292:上次镜像同步失败留下的 dirty 状态,启动时安全重渲一次(内部自吞)。
  service.recoverMirror();

  // index.js:319-332:人改镜像先合并——镜像文件里的手工编辑每次启动都赢。
  // readHumanEdits 全类型一次读齐:mergeHumanEdits 成功会重渲全部镜像,逐类型读改
  // 循环会拿没读到的类型覆盖掉未合并的编辑(index.js:324-327 注释同款坑)。
  // 何时 apply 由 semantic 的分支时序契约决定(见 semantic.js 文件头),本文件只造闭包。
  const humanEdits = new Map();
  for (const type of Object.keys(TYPE_FILE)) humanEdits.set(type, mirror.readHumanEdits(type));
  const applyHumanEdits = () => {
    for (const [type, edits] of humanEdits) {
      if (edits.length) service.mergeHumanEdits(type, edits);
    }
  };

  // index.js:316-317:向量索引包住 store 的 embedding 列并跟踪活跃模型指纹。
  const vectorIndex = createVectorIndex({ store, logger });
  service.setVectorIndex(vectorIndex);

  // ---- 语义管线(PR2):三路二选一 ------------------------------------------
  let semantic = null;
  if (embedder !== null) {
    // 注入式覆盖(测试 / 宿主方自管 embedder):绕过装配,人改合并立刻做
    //(对齐宿主 openai 分支的同步语义)。
    service.setEmbedder(embedder);
    if (reranker !== null) service.setReranker(reranker);
    applyHumanEdits();
  } else if (embed === "off") {
    // 纯关键词 + BM25:对齐宿主 lightMode 分支——不建 embedder,人改合并立即。
    applyHumanEdits();
  } else {
    let semanticReady = true;
    if (embed === "local") {
      // 自管 runtime 缺失时取件:只走 download 档(宿主 adopt 推导对独立进程无意义
      // ——没有宿主 node_modules 可推)。失败不阻断 daemon:降级关键词 + 可操作提示。
      semanticReady = await ensureRuntimePayload(logger);
    }
    if (semanticReady) {
      semantic = createSemantic({
        store, service, settings,
        cfg: daemonSemanticCfg(embed),
        logger, vectorIndex, applyHumanEdits, lightMode: false
      });
    } else {
      applyHumanEdits();
    }
  }

  // index.js 的 setRecallRecorder（2026-10-14 在 :339-350）：检索回执落 recall_runs(searchMemories 的 recordRecall 默认开,
  // 第三方检索统计因此不缺数)。best-effort:回执写失败绝不影响检索本身。
  service.setRecallRecorder((recall) => {
    try {
      store.saveRecallRun({
        query: recall.query,
        mode: recall.mode,
        topK: recall.topK,
        threshold: recall.threshold ?? null,
        candidates: recall.candidates ?? [],
        created_at: recall.createdAt
      });
    } catch { /* non-fatal: recall recording is bookkeeping */ }
  });

  // index.js:636:#275 无损回收。daemon 带上它,POST /maintenance/reclaim 才有后端
  // (api-standalone 缺 maintenance 时该路由 503);同样不挂启动路径、不接定时器。
  const maintenance = createMaintenance({ store, config: cfg, logger });

  // index.js:643-649 同一工厂;差别只有 strictPort 默认开(daemon 语义,见上)。
  // token 与宿主共用同一 kv 键 external_api:首次启动自动生成并持久化
  // (api-standalone.js:203-212),DSH 面板 / CLI / daemon 三方零配置共享凭证。
  const tokenExisted = Boolean(settings.getExternalApi?.()?.token);
  // embedder 注入 /context 的查询嵌入（issue #370）：三路取当前生效的同一句柄——
  // 注入覆盖用注入值，semantic 路用它的产物，off/lightMode 为 null（路由侧降级
  // 规则档）。与 service.setEmbedder 的是同一个实例，不存在第二真相源。
  const api = createStandaloneApi({ service, store, config: cfg, logger, settings, port, host, maintenance, strictPort, embedder: embedder ?? semantic?.embedder ?? null });

  return {
    api,
    store,
    service,
    settings,
    maintenance,
    semantic,
    tokenExisted,
    /**
     * 收尾：先停收新请求、等在途请求跑完，再关库——直接同步关库会让在途的
     * PUT/POST 撞上已关的 store（500 或丢写）。closeIdleConnections 排干
     * keep-alive 空闲连接（node ≥18.2，旧版无此 API 则跳过），否则 server.close
     * 的回调要等 keep-alive 超时才触发。node:sqlite 对未 finalize 语句可能抛，
     * 吞掉——WAL 会在下次打开时回放，已提交事务不丢。
     */
    async dispose() {
      await new Promise((resolve) => {
        try {
          api.server.close(() => resolve());
          api.server.closeIdleConnections?.();
        } catch { resolve(); }
      });
      try { semantic?.dispose(); } catch { /* 同上 */ }
      try { store.close(); } catch { /* 同上 */ }
    }
  };
}

/**
 * daemon 侧语义配置:默认值逐键锚定 src/config.js(309-420),daemon 不装 schemastery
 * (宿主 peer 依赖),同值硬编码;config.js 改默认值时此处与 docs/DAEMON.md 同步。
 * 只放开 embedProvider(CLI --embed);rerank 暂不提供 CLI(默认关,与宿主同默认)。
 */
function daemonSemanticCfg(embed) {
  return {
    embedProvider: embed,                          // config.js:309(宿主默认 openai;daemon 默认 local——独立部署唯一自洽路径)
    localEmbedModel: "Xenova/bge-small-zh-v1.5",   // :312
    localEmbedDimension: 512,                      // :313
    localEmbedDevice: "cpu",                       // :314
    localEmbedBatchSize: 8,                        // :315
    localEmbedPooling: "auto",                     // :323(BGE 系 CLS 口径,改它=换向量空间)
    ollamaBaseUrl: "http://localhost:11434",       // :326
    ollamaModel: "nomic-embed-text",               // :331
    embedModelCacheDir: "",                        // :336(空=local-embedder 内部解析 ~/.dsh/mneme/models)
    embedModelMirror: "https://hf-mirror.com",     // :337
    resilientModelDownload: true,                  // :342
    runtimeDir: process.env.DSH_MNEME_RUNTIME_DIR || "",  // :348(空=defaultRuntimeDir;取件/加载同源)
    rerankEnabled: false,                          // :419
    rerankProvider: "none",                        // :420
    autoReindexOnBoot: true                        // :367
  };
}

/**
 * 本地推理 runtime 取件(download 档)。返回 payload 是否可用:
 * 已存在(含收编/早前下载)→ true 不重复取;缺失 → 取件成功 true / 失败 false(内部
 * 已打降级日志)。并发安全由 provisionRuntime 的 IN_FLIGHT 锁保证(按归一化 runtimeDir 串行)。
 */
async function ensureRuntimePayload(logger) {
  const runtimeDir = process.env.DSH_MNEME_RUNTIME_DIR || "";
  const dir = runtimeDir || defaultRuntimeDir();
  if (listPayloadDirs(dir).length > 0) return true;
  logger?.info?.("[dsh-mneme] 本地推理运行时缺失,开始取件(download 档,约 200MB;离线可用 DSH_MNEME_RUNTIME_TARBALL_DIR / DSH_MNEME_RUNTIME_MIRROR)…");
  try {
    const result = await provisionRuntime({ runtimeDir, localTarballDir: process.env.DSH_MNEME_RUNTIME_TARBALL_DIR || "", mirror: process.env.DSH_MNEME_RUNTIME_MIRROR || "" });
    if (!result.ok) throw new Error(result.reason);
    logger?.info?.(`[dsh-mneme] 运行时就绪(${result.strategy}):${result.packages} 包 / ${result.files} 文件`);
    return true;
  } catch (error) {
    logger?.warn?.(`[dsh-mneme] runtime provisioning failed, search degrades to keyword: ${String(error)}`);
    return false;
  }
}
