import { createStore } from "./store.js";
import { createMirror, TYPE_FILE } from "./mirror.js";
import { createDocumentIndex } from "./document-index.js";
import { resolveDocumentDir } from "./document.js";
import { createService } from "./service.js";
// #254 写入准入（第一阶段只计量，不拦截）：见 src/write-admission.js 的文件头。
import { createWriteAdmission } from "./write-admission.js";
// #164 A2：写入边界的密钥 / PII 判据，注入给上面的写入准入。
import { createSensitiveScan } from "./sensitive-scan.js";
import { createTools } from "./tools.js";
import { createInjector, setPreinjectCallLLM } from "./inject.js";
import { createContinuityRescue } from "./continuity.js";
import { createSummarizer } from "./summarize.js";
import { createDreamScheduler } from "./dream.js";
import { createSleepScheduler, runSleep } from "./dream/sleep.js";
import { createApi } from "./api.js";
import { createStandaloneApi } from "./api-standalone.js";
// #275 存储生命周期第一批：无损回收（手动入口，不挂启动路径）。
import { createMaintenance } from "./maintenance.js";
import { createSettings } from "./settings.js";
import { createCommandManager } from "./commands.js";
import { createVectorIndex } from "./vector-index.js";
// semantic(embedder/reranker/boot 回填)纯搬移至 src/semantic.js(PR2):宿主与
// daemon(dsh-mneme-serve,#363)共用同一套装配,原文件保留 barrel 出口。
import { createSemantic } from "./semantic.js";
import { Config, applyLightModePreset, injectChildEnabled } from "./config.js";
import { langOf } from "./lang.js";
import { extractEntities } from "./entities/extractor.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const name = "dsh-mneme";
// webServer 在 inject 声明中：cordis 会等宿主 webServer 服务激活后才 apply 本
// 插件，保证 apply 时路由注册不落时序（v0.7.23 曾移出 inject 想支持 headless，
// 结果 cordis 不再等待，apply 时宿主 webServer 未就绪 → 桌面端 "cannot get
// property without inject" 崩溃）。守卫用 ctx.reflect.get（免 inject 读取，
// 未提供返回 undefined）而非 if (ctx.webServer)：直接访问未注入属性在 cordis
// Proxy 下会抛错而非返回 undefined。
export const inject = ["tools", "systemPrompt", "llm", "agentDefaultModel", "commands", "webServer"];
export { Config };

// Arrow (not function declaration): cordis 4 treats any apply with a
// prototype as a class constructor (`new apply(...)`) and discards its return
// value, so a `function apply` disposer would never run on unload. An arrow
// has no prototype, is called normally, and its returned disposer is collected
// and run by the fiber on unload.
// Entity-extraction LLM adapter (issue #108/#109): maps the extractor's
// options (provider/model override + reasoningEffort) onto a real dsh-llm
// stream route and retries once without the effort when the first attempt is
// rejected. Extracted from apply() so the effort-fallback branch is
// unit-testable; the extractor only ever sees a callLLM(messages, options)
// => Promise<string>. The route always carries a real provider/model (dsh-llm
// GenerateOptions requires both) — never a bare stream.
//
// Issue #250: it also accounts for itself. Entity extraction is the background
// LLM path that runs on every memory write, yet it never reached
// llm_audit_logs — the adapter only ever held an llm handle, so it had no way
// to call service.saveLlmAudit. It now takes service (+ config for the shared
// llmAudit.enabled gate) and writes one row per stream attempt, matching the
// contract of runAuditedLlm in dream.js: a rejected effort attempt records its
// own error row and the retry records its own success row.
export function createEntityStreamAdapter({ llm, agentDefaultModel, logger, service, config }) {
  return async function streamEntityText(messages, options = {}) {
    let route = {};
    if (options.provider) route.provider = options.provider;
    if (options.model) route.model = options.model;
    if (!route.provider || !route.model) {
      try {
        const sel = agentDefaultModel?.currentSelection?.();
        if (sel?.provider && sel?.model) {
          route.provider ??= sel.provider;
          route.model ??= sel.model;
        }
      } catch { /* fall through to whatever route we already have */ }
    }
    const effort = options.reasoningEffort;
    // 没有解析出 provider/model 就没有可归属的模型——与 dream 的 resolveRoute
    // 无路由早退同口径，那种情况不写审计行。
    const modelId = route.provider && route.model ? `${route.provider}:${route.model}` : "";
    const tryStream = (withEffort) => {
      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;
      const startedAt = Date.now();
      const timestamp = new Date(startedAt).toISOString();
      // 记账是 best-effort：写审计行失败只 warn，绝不反噬抽取本身（CONTRIBUTING
      // 的 fail-safe 硬约定）。
      const writeAudit = (status, errorMessage) => {
        if (config?.llmAudit?.enabled === false || typeof service?.saveLlmAudit !== "function") return;
        // #372: modelId 为空 = 路由解析失败——此前整个 writeAudit 静默 return，
        // llm.stream 抛错也留不下任何行，正是 #108 要消灭的「零实体零日志」同款盲区。
        // 空路由无法记账，但至少要留一条可解释的 warn，别让失败面完全不可见。
        if (!modelId) {
          if (status !== "ok") logger?.warn?.(`dsh-mneme: entity extraction ${status} without audit row (llm route unresolved: ${errorMessage ?? "no route"})`);
          return;
        }
        try {
          service.saveLlmAudit({
            timestamp,
            trigger_source: "entityExtract",
            operation_type: "entity_extract",
            model_id: modelId,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
            cost_usd: 0,
            duration_ms: Date.now() - startedAt,
            status,
            error_message: errorMessage,
            related_memory_ids: []
          });
        } catch (auditError) {
          logger?.warn?.(`dsh-mneme: entity extraction llm audit write failed: ${String(auditError)}`);
        }
      };
      return (async () => {
        for await (const chunk of llm.stream({
          ...route,
          maxTokens: 4096,
          ...(withEffort && effort ? { reasoningEffort: effort } : {}),
          messages
        })) {
          if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
          // DSH 的 StreamChunk 契约把用量嵌在 chunk.usage（TokenUsage）；兼容直接
          // 平铺在 chunk 上的旧形态。归一放在这里，下面只需认平铺形状——与
          // dream.js 的 streamText 同一处理。
          if (chunk.type === "usage") {
            const u = chunk.usage ?? chunk;
            const i = u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? u.promptTokens;
            const o = u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? u.completionTokens;
            if (Number.isFinite(i)) inputTokens = i;
            if (Number.isFinite(o)) outputTokens = o;
          }
          if (chunk.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) {
            writeAudit("error", "llm stream aborted or errored");
            return undefined;
          }
        }
        writeAudit("success", null);
        return text;
      })().catch((err) => {
        logger?.warn?.(`[dsh-mneme] entity extraction llm stream failed: ${String(err)}`);
        writeAudit("error", String(err?.message ?? err));
        return undefined;
      });
    };
    let text = await tryStream(true);
    if (text === undefined && effort) {
      // Mirror dream's effort fallback: a provider rejecting the reasoning
      // effort must not sink the whole extraction — retry once without it.
      logger?.warn?.(`[dsh-mneme] entity extraction: reasoningEffort "${effort}" rejected, retrying without it`);
      text = await tryStream(false);
    }
    return text;
  };
}

// backfillMissingEmbeddings 已随语义装配整体搬至 src/semantic.js(纯搬移);
// 保留 barrel 再出口 —— test/reindex-backfill.test.js 仍从本模块 import,调用方零改动。
export { backfillMissingEmbeddings } from "./semantic.js";

export const apply = (ctx, config) => {
  const rawCfg = Config(config);

  // Resolve memoryDir: expand leading "~"
  const memoryDir = rawCfg.memoryDir.startsWith("~")
    ? join(homedir(), rawCfg.memoryDir.slice(1))
    : rawCfg.memoryDir;
  mkdirSync(memoryDir, { recursive: true });

  const store = createStore(join(memoryDir, "memory.db"));
  // Prune reflection failure rows older than 90 days on boot (best-effort, so
  // the failure table never grows unbounded).
  try {
    store.deleteOldFailures(new Date(Date.now() - 90 * 86400000).toISOString());
  } catch { /* non-fatal */ }

  // User-configurable settings (profile, rules, panel mode, standalone API
  // token) share the same SQLite file in dedicated tables, isolated from
  // memories. Created before the config is finalized: the persisted
  // panel_mode participates in light-mode resolution below.
  const settings = createSettings(store.db);

  // Light mode (v0.7.12): the bundle config flag OR a persisted panel_mode of
  // "light" (the panel switch wins over the bundle config so it survives
  // config redeploys). applyLightModePreset turns every heavy background /
  // semantic feature off and keeps the core loop (autoInject, autoSummarize,
  // hot memory, quality filter).
  const lightMode = rawCfg.lightMode === true || settings.getPanelMode() === "light";
  // 功能开关合并顺序即优先级：用户显式开关（feature_flags kv，面板写入）>
  // 轻量预设（applyLightModePreset 批量置关的重型能力）> bundle 配置。预设必须
  // 先应用、用户开关后展开，否则 LIGHT_MODE_OFF 会把用户显式打开的开关再次
  // 压掉。合并结果只作用于本次启动：面板改开关后与 panel_mode 一样在下次
  // 启动生效。
  // 嵌套对象开关按首个点号拆开（kv 里平铺存的 "memoryQualityFilter.enabled" →
  // cfg.memoryQualityFilter.enabled），点号键不原样留在 cfg 顶层属性里。
  const flags = settings.getFeatureFlags();
  const flatFlags = {};
  const nestedFlags = {};
  for (const [key, value] of Object.entries(flags)) {
    const dot = key.indexOf(".");
    if (dot > 0) {
      const objKey = key.slice(0, dot);
      const subKey = key.slice(dot + 1);
      nestedFlags[objKey] = { ...(nestedFlags[objKey] ?? {}), [subKey]: value };
    } else {
      flatFlags[key] = value;
    }
  }
  const cfg = { ...applyLightModePreset({ ...rawCfg, lightMode }), ...flatFlags };
  for (const [objKey, sub] of Object.entries(nestedFlags)) {
    cfg[objKey] = { ...(cfg[objKey] ?? {}), ...sub };
  }

  // Bug8 的启动期清理放在装配之后：面板把 llmAudit.* 写进 kv、经 nestedFlags 合进
  // cfg，而写入侧（dream / summarize / 写入准入）读的都是装配后的 cfg——清理若读
  // rawCfg，面板改了保留期它不认，更糟的是「开不开审计」与写入侧可能取到不同的值
  // （raw 说关 → 不清理，cfg 说开 → 照写，审计表就无保留期地长）。保留期默认 90 天、
  // 失败只 warn，与失败表清理同款：账本清理绝不许挡住插件启动。
  try {
    if (cfg.llmAudit?.enabled !== false) {
      const retentionMs = Number.isInteger(cfg.llmAudit?.retentionDays) ? cfg.llmAudit.retentionDays : 90;
      store.deleteOldLlmAudits(new Date(Date.now() - retentionMs * 86400000).toISOString());
    }
  } catch { /* non-fatal */ }

  // 记忆语言（memory.language）：本实例逐层传入 inject / summarize / dream /
  // sleep / mirror，多实例（如 agent preset 内挂载）互不影响。
  const mirror = createMirror(memoryDir, langOf(cfg));

  // #296 第二批：managed 文档目录。解析与 memoryDir 同一套（空 = 跟随 memoryDir 的
  // <memoryDir>/documents/，~ 展开，相对路径落在 memoryDir 下）。索引对象总是建：
  // 闸关时它只承担「清掉陈旧 index.md」这一件事，与 documents.md 在闸关时被镜像删
  // 掉同一口径。建目录与写索引失败都只 warn，不阻断插件加载（它们是机器产物）。
  const documentDir = resolveDocumentDir(memoryDir, cfg.documentDir);
  const documentIndex = createDocumentIndex(documentDir, langOf(cfg));
  if (cfg.documentMemoryEnabled === true) {
    const ensured = documentIndex.ensure();
    if (!ensured.ok) {
      ctx.logger?.warn?.(`[dsh-mneme] documentDir is not writable: ${documentDir}: ${ensured.error}`);
    }
    // 启动即渲染一次：索引不该等到第一次业务写才存在（删掉它之后重启也能自愈）。
    const synced = documentIndex.sync(store.list({ type: "document", limit: null }));
    if (!synced.ok) ctx.logger?.warn?.(`[dsh-mneme] document index sync failed: ${synced.error}`);
  } else {
    documentIndex.remove();
  }

  // 写入准入实例（#254）。两个开关 writeAdmission.enabled / .enforce 都默认关；
  // 关时它的返回与只计量那一阶段逐字段一致，写入路径完全不碰。既有的
  // llmAudit.enabled 关掉时它同样既不判也不写（那个开关连审计行的启动期清理一起
  // 关掉，在无保留期的表里按写入频次增长是不能接受的）。
  //
  // sensitiveScan 是密钥 / PII 那一类判据的注入点。按 #254 验收第 4 条它是 #164 A2
  // 的判据来源，现在由 src/sensitive-scan.js 实现（维护者 09-28 把 A2 的认领转给
  // 本侧）。这里只做接线：判据开不开由它自己的键 sensitiveScanEnabled 决定，工厂在
  // 关时返回 null，闸门的行为就与 #332 合并时逐字段一致（那一版根本没有这个函数）；
  // 命中之后是仅告警还是真拦，仍是 writeAdmission.enforce 的事（#164 口径：
  // 默认仅告警、拦截 opt-in），判据不碰决策。
  const writeAdmission = createWriteAdmission({
    store,
    config: cfg,
    logger: ctx.logger,
    sensitiveScan: createSensitiveScan({ config: cfg })
  });
  const service = createService({ store, mirror, config: cfg, logger: ctx.logger, documentIndex, writeAdmission });

  // F-NEW-03: if the mirror sync failed last run (persisted dirty state), retry
  // a safe re-render at boot so a stale mirror converges without needing a
  // business write. Bounded: single attempt; on failure dirty stays for the
  // next boot. Never throws.
  service.recoverMirror();

  // Recall-layer receipt: when searchMemories runs with recordRecall=true, the
  // retrieval scene (query/mode/topK/threshold + candidates) is persisted to
  // recall_runs for audit/replay — the sibling of the dream_runs judgment trail.
  // Best-effort: a failed recall write must never break the search.
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

  // Semantic pipeline: a local/ollama embedder when configured, otherwise the
  // legacy OpenAI-compatible embedder (settings-driven). The vector index wraps
  // the store's embedding column and tracks the active model fingerprint. A
  // slow embedder init (model download) never blocks plugin boot — failures
  // degrade to keyword search.
  const vectorIndex = createVectorIndex({ store, logger: ctx.logger });
  service.setVectorIndex(vectorIndex);

  // Human edits in mirror files win on every sync; merge them back first.
  // TYPE_FILE maps each memory type to its mirror filename. Read every type's
  // edits up front: mergeHumanEdits re-renders ALL mirror files on success, so
  // a per-type read-then-merge loop would overwrite edits in files not yet read
  // (e.g. preferences.md merging would clobber unsynced projects.md edits).
  const humanEdits = new Map();
  for (const type of Object.keys(TYPE_FILE)) {
    humanEdits.set(type, mirror.readHumanEdits(type));
  }
  const applyHumanEdits = () => {
    for (const [type, edits] of humanEdits) {
      if (edits.length) service.mergeHumanEdits(type, edits);
    }
  };

  // embedder/reranker/boot 回填装配已整体搬至 src/semantic.js(纯搬移,宿主与 daemon
  // 共用):调用时序(applyHumanEdits 在各分支的触发点、#118 重试、autoReindexOnBoot)
  // 原样保留在 createSemantic 内部,这里只拿引用。init 全失败的 embedder 引用仍会进入
  // dream/sleep 的 semantic 面 —— 与搬移前一致:检索侧 setEmbedder(null) 降级关键词。
  const semantic = createSemantic({
    store, service, settings, cfg, logger: ctx.logger, vectorIndex, applyHumanEdits, lightMode
  });
  const { embedder, reranker } = semantic;

  // Custom commands: register persisted commands into the DSH command registry
  // on boot; add/remove re-register live through the API.
  let commands = null;
  if (ctx.commands) {
    commands = createCommandManager({ ctx, settings, logger: ctx.logger, language: langOf(cfg) });
    commands.sync();
  }

  // Dream scheduler: automatic consolidation + summary runs, triggered by
  // store growth. Writes through the service fire the dream hook, which asks
  // the scheduler to (re)schedule a run once absolute and since-last-run
  // thresholds are both exceeded. onRun is deferred through `dream` so the
  // closure sees the assigned scheduler; the null guard keeps a run safe even
  // if the hook fires before assignment or after dispose.
  let dream = null;
  if (cfg.autoDream) {
    dream = createDreamScheduler({
      thresholdCount: cfg.dreamThresholdCount,
      thresholdChars: cfg.dreamThresholdChars,
      delayMs: cfg.dreamDelayMs,
      minIntervalMs: (cfg.dreamMinIntervalMinutes ?? 0) * 60000,
      // Issue #292：连续失败指数退避（opt-in，默认关 = 行为不变）。
      failureBackoff: cfg.autoDreamFailureBackoff === true,
      logger: ctx.logger,
      semantic: { embedder, vectorIndex },
      lastRunAtSeed: store.lastDreamRunAt("auto"),
      // Issue #89（基线半边）：阈值基线同样跨重启恢复——只恢复 lastRunAt 的话，
      // 重启后的第一条写入仍会绕过阈值（库里记忆多于阈值时 overBase 恒成立）开跑
      // 整轮。种子取上次成功轮的库规模，口径与运行期刷新一致；读不到时调度器退回
      // 零基线（= 升级前行为）。
      baselineSeed: store.lastDreamBaseline("auto"),
      // Issue #239（第 4 项）镜像到巩固：高峰期不做梦，顺延到最近的高峰结束时刻。
      peakHours: cfg.dreamPeakHours ?? "",
      peakMaxDeferMinutes: cfg.dreamPeakMaxDeferMinutes ?? 120,
      // 跳过时的审计行在这里落地（调度器只拿到 service，拿不到 config 的
      // llmAudit 开关与巩固模型路由）。口径与 runAuditedLlm 一致：审计关掉就
      // 不写；写失败只 warn，绝不反噬调度（CONTRIBUTING 的 fail-safe 硬约定）。
      auditPeakSkip: ({ count, chars }) => {
        if (cfg?.llmAudit?.enabled === false || typeof service?.saveLlmAudit !== "function") return;
        const modelId = cfg.dreamProvider && cfg.dreamModel ? `${cfg.dreamProvider}:${cfg.dreamModel}` : "";
        service.saveLlmAudit({
          timestamp: new Date().toISOString(),
          trigger_source: "autoDream",
          operation_type: "dream_consolidate",
          model_id: modelId,
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          cost_usd: 0,
          duration_ms: 0,
          status: "skipped",
          error_message: "peak-hours",
          related_memory_ids: [],
          // 观测用：跳过时窗口里积了多少（阈值继续累积，不是丢弃）。
          metadata: JSON.stringify({ count, chars })
        });
      },
      onRun: () => (dream ? dream.runDream(ctx, service, cfg) : Promise.resolve({ ok: true, skipped: true }))
    });
    service.setDreamHook(() => dream.maybeSchedule(service));
  }

  // Sleep scheduler (v0.4.0): idle-triggered deep maintenance. Fires when the
  // store has been quiet for sleepIdleMinutes and re-arms on every write via
  // noteWrite (hooked to the service's write path). Runs go through
  // service.enqueue so they serialize with autoDream — the two never overlap.
  // Abortable on user activity; audited into dream_runs with run_type='sleep'.
  let sleep = null;
  if (cfg.sleepModeEnabled) {
    sleep = createSleepScheduler({
      service,
      config: cfg,
      logger: ctx.logger,
      lastRunAtSeed: store.lastDreamRunAt("sleep"),
      onRun: (signal) => (sleep ? runSleep(ctx, service, cfg, ctx.logger, { embedder, vectorIndex }, signal) : Promise.resolve({ ok: true, skipped: true }))
    });
    service.setSleepHook(() => sleep.noteWrite());
  }

  // Entity gene extraction (v0.3.0): wire the extractor into the service as a
  // hook so saveWithDedupe can fire-and-forget an extraction pass on fresh
  // writes. The service never sees ctx.llm — index.js adapts it here into the
  // callLLM(messages, options) => Promise<string> contract the extractor
  // expects, reusing the same ctx.llm.stream consumption pattern as dream.js.
  // Explicit opt-in only (entityExtractionEnabled defaults to false); any LLM
  // failure degrades inside the extractor to { ok:false }, never a write error.
  if (cfg.entityExtractionEnabled) {
    if (!ctx.llm) {
      // Issue #108: an enabled-but-unwired extractor failed silently before —
      // zero entities, zero llm_audit_logs, no log line anywhere. Make the
      // missing dependency visible so a user can tell "extractor not installed"
      // from "extraction failed".
      ctx.logger?.warn?.("[dsh-mneme] entityExtractionEnabled=true but ctx.llm unavailable — entity extractor NOT installed");
    } else {
      const streamEntityText = createEntityStreamAdapter({
        llm: ctx.llm,
        agentDefaultModel: ctx.agentDefaultModel,
        logger: ctx.logger,
        // Issue #250: the adapter needs service to write its llm_audit_logs row
        // (it never had it) and config for the shared llmAudit.enabled gate.
        service,
        config: cfg
      });
      service.setEntityExtractor((memory) =>
        extractEntities(memory, { store, config: cfg, callLLM: streamEntityText, logger: ctx.logger })
          .catch((err) => {
            ctx.logger?.warn?.(`[dsh-mneme] entity extraction failed: ${String(err)}`);
            return { ok: false, error: String(err) };
          })
      );
    }
  }

  const disposers = [];

  // #118: never let a pending embedder init retry fire after unload and touch
  // a torn-down context.
  disposers.push(() => semantic.dispose());   // #118 重试计时器 + boot 回填计时器(搬入 semantic.js 后由它自持)

  // Issue #380：preInjectGate 的 LLM 适配器。promptCtx（systemPrompt 注入点）没有
  // llm 句柄，注入器拿不到——这里在 apply 作用域装配（entity extractor 同款），
  // 经 setPreinjectCallLLM 转交。仅 preInjectGate.enabled 开启且 ctx.llm 存在时
  // 注入；开闸但没接上模型时 warn（#108 教训：静默不可见比失败更糟）。适配器合同
  // callLLM(messages, options) => Promise<string|undefined> 与 entity adapter 一致：
  // 路由解析（agentDefaultModel 回退）与审计记账在适配器内完成，判定器只认文本。
  if (cfg.preInjectGate?.enabled === true) {
    if (!ctx.llm) {
      ctx.logger?.warn?.("[dsh-mneme] preInjectGate.enabled=true but ctx.llm unavailable — pre-injection gate will not judge (inject proceeds unfiltered)");
    } else {
      const streamPreinjectText = createEntityStreamAdapter({
        llm: ctx.llm,
        agentDefaultModel: ctx.agentDefaultModel,
        logger: ctx.logger,
        service,
        config: cfg
      });
      setPreinjectCallLLM(streamPreinjectText);
    }
  }

  ctx.inject(["systemPrompt"], (promptCtx) => {
    if (cfg.autoInject) disposers.push(createInjector(promptCtx, service, settings, cfg));
  });

  // #249 N3：压缩边缘双落点。触发靠宿主自己落的压缩事件（订阅 + pre-step 追加），
  // 不需要 systemPrompt / tools 的任何能力，所以不塞进上面的 inject 回调；父／子
  // 闸门在挂载点判一次，与 inject.js 共用同一个 injectChildEnabled 判据。
  if (cfg.autoInject && injectChildEnabled(cfg, "continuityRescueEnabled")) {
    disposers.push(createContinuityRescue(ctx, store));
  }

  ctx.inject(["tools"], (toolsCtx) => {
    disposers.push(createTools(toolsCtx, service, cfg, embedder));
  });

  const summarizer = createSummarizer(ctx, service, cfg);
  disposers.push(summarizer.dispose);

  // webServer 可选依赖：cordis 4 的 ctx 是 Proxy，直接访问未在 inject 声明的
  // 属性会抛 "cannot get property without inject"（不会返回 undefined），所以
  // 不能用 if (ctx.webServer) 守卫。ctx.reflect.get 是 cordis 提供的免 inject
  // 读取（未提供时返回 undefined）；对象字面量 mock ctx（测试）没有 reflect，
  // 退回直接属性访问。headless/无 UI 宿主无 webServer 时跳过 API 注册，其余
  // 功能（工具/注入/dream）照常。
  const webServer = typeof ctx.reflect?.get === "function" ? ctx.reflect.get("webServer") : ctx.webServer;
  if (webServer) {
    const api = createApi(ctx, service, settings, commands ?? {
      add: () => { throw new Error("commands unavailable"); },
      remove: () => false,
      list: () => []
    }, embedder, { vectorIndex, reranker }, cfg.apiToken, cfg);
    disposers.push(api.dispose);
  }

  // #275 存储生命周期第一批：无损回收的手动入口。刻意不挂启动路径、不接定时器——
  // 这一步是不可逆的内容丢弃，只由人显式触发（`dsh-mneme reclaim`）。实例在这里建、
  // 在 standalone API 上暴露，是为了让 CLI 能在插件进程内跑（VACUUM 要排他锁，跟宿主
  // 抢锁的那条路走不通）。
  const maintenance = createMaintenance({ store, config: cfg, logger: ctx.logger });

  // Standalone external API (v0.7.12): plain node:http server for ecosystem
  // integrations outside the DSH host. Persisted external_api settings win
  // over the bundle config (enabled/port); the Bearer token lives in the same
  // kv and is auto-generated on first boot by createStandaloneApi. Binding a
  // non-loopback host is the operator's documented responsibility.
  if ((settings.getExternalApi?.()?.enabled ?? cfg.externalApiEnabled) === true) {
    // embedder 交给 /context 的查询嵌入（issue #370）：与 service.setEmbedder 同一
    // 实例（semantic.js 装配产物），lightMode 下为 null，路由侧降级规则档。
    const standalone = createStandaloneApi({ service, store, config: cfg, logger: ctx.logger, settings, maintenance, embedder });
    disposers.push(() => standalone.server.close());
    standalone.ready.catch((error) => {
      ctx.logger?.warn?.(`[dsh-mneme] standalone API failed to start: ${String(error)}`);
    });
  }

  // Async disposer: cordis awaits the returned promise on unload (runDisposable),
  // so an in-flight dream run is allowed to finish before the SQLite store is
  // closed — dream.dispose() resolves only after its current run settles.
  return async () => {
    for (const dispose of disposers) {
      if (typeof dispose === "function") dispose();
    }
    commands?.dispose();
    if (dream) await dream.dispose();
    if (sleep) sleep.dispose();
    store.close();
  };
};
