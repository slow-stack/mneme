import { createStore } from "./store.js";
import { createMirror, TYPE_FILE } from "./mirror.js";
import { createDocumentIndex } from "./document-index.js";
import { resolveDocumentDir } from "./document.js";
// #368 v1：profile 作用域落点检测（只提示，不改行为）。
import { findProfileScopeSegment } from "./placement.js";
import { createService } from "./service.js";
// #254 写入准入（第一阶段只计量，不拦截）：见 src/write-admission.js 的文件头。
import { createWriteAdmission } from "./write-admission.js";
// #164 A2：写入边界的密钥 / PII 判据，注入给上面的写入准入。
import { createSensitiveScan } from "./sensitive-scan.js";
import { createTools } from "./tools.js";
import { createInjector } from "./inject.js";
import { createPreInjectGate } from "./pre-inject-gate.js";
import { createContinuityRescue } from "./continuity.js";
import { createSummarizer } from "./summarize.js";
import { createSessionGate } from "./session-gate.js";
import { createDreamScheduler, describeStreamFailure } from "./dream.js";
import { createSleepScheduler, runSleep } from "./dream/sleep.js";
// #622 可观测性：错峰时段串解析失败是「静默未配置」（parsePeakSpec 契约不救错），
// 启动装配后对非空且解析失败的键出一条 warn——只补可见性，不改语义。
import { invalidPeakSpecs } from "./peak-hours.js";
import { createApi } from "./api.js";
import { createStandaloneApi } from "./api-standalone.js";
// #275 存储生命周期第一批：无损回收（手动入口，不挂启动路径）。
import { createMaintenance } from "./maintenance.js";
import { createChoroQueries } from "./wiki/queries.js";
// chorography M3：开局注入块与 /choro 只读回执。两者都只吃 queries 读侧，不写任何东西。
import { createChoroInject } from "./wiki/inject.js";
import { registerChoroCommand } from "./choro-command.js";
// 收尾档：面板重建按钮走 runChoroT0（P34；T1 不上 HTTP）。
import { runChoroT0 } from "./wiki/t0.js";
// T1 后台任务账（契约 §3.2）：面板点「补语义正文」走 HTTP 起一个 spawn 子进程，
// 进程账不能住在 api.js（HTTP 面刻意不摸 child_process），装配点在这里。
import { createT1Jobs } from "./wiki/t1-jobs.js";
import { createSettings } from "./settings.js";
// 「Agent 眼中的你」自动事实（2026-11-06）：逐卡事实清单 + dream 后自动维护轮。
import { createProfileFacts } from "./profile-facts.js";
// 知识库第二层（契约 §3.4）：装配与开关无关（createKb 只建对象，读侧零 IO），
// 闸在路由与工具两层——这样「没开」与「没装配」在 HTTP 面上是两个可区分答案。
import { createKb } from "./kb/index.js";
import { createCommandManager } from "./commands.js";
import { createExecutionRecorder } from "./pipeline-runner.js";
import { registerMoRunCommand } from "./pipeline-command.js";
// M.O. 自动沉淀的触发侧（冷却 / 排队 / 兜底）。挖掘与落盘在 pipeline-nudge.js，
// 这里只管「什么时候跑」。两者分开的理由见 src/pipeline-nudge-auto.js 文件头。
import { createNudgeAutoRun } from "./pipeline-nudge-auto.js";
// QQ 日记本：合成管线（compose）与触发侧（auto）分开，理由见 src/diary/index.js 文件头。
import { createDiaryComposer, createDiaryAutoRun } from "./diary/index.js";
import { createVectorIndex } from "./vector-index.js";
// semantic(embedder/reranker/boot 回填)纯搬移至 src/semantic.js(PR2):宿主与
// daemon(dsh-mneme-serve,#363)共用同一套装配,原文件保留 barrel 出口。
import { createSemantic } from "./semantic.js";
import { Config, applyLightModePreset, injectChildEnabled } from "./config.js";
import { langOf } from "./lang.js";
import { extractEntities } from "./entities/extractor.js";
import { createProfileExtractor } from "./profile-extract.js";
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
    // #405: 审计行的 related_memory_ids 此前恒空、error_message 又被压成一句常量，
    // 于是「哪条记忆没抽到实体、为什么」在库里查不出来（主库 735 条 error 行全是
    // 同一句话）。id 由 extractor 顺 options 传下来——它只认 memory.content，不认
    // id。口径同 write-admission:350：拿不到 id 就留空，绝不挂不存在的 id 造虚账。
    const relatedMemoryIds = options.memoryId ? [options.memoryId] : [];
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
      const writeAudit = (status, errorMessage, relatedMemoryIds = []) => {
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
            related_memory_ids: relatedMemoryIds
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
            writeAudit("error", describeStreamFailure(chunk.reason) || "llm stream aborted or errored", relatedMemoryIds);
            return undefined;
          }
        }
        // 第三参必须显式传进去：writeAudit 的形参默认值 [] 是给"没有 id 可归因"
        // 留的，省略第三参等于宣称"这条成功与任何记忆无关"——实测活库 6256 条
        // success 行 100% 空数组，正是这个省略造成的。#405 只修了 error 半边。
        writeAudit("success", null, relatedMemoryIds);
        return text;
      })().catch((err) => {
        logger?.warn?.(`[dsh-mneme] entity extraction llm stream failed: ${String(err)}`);
        writeAudit("error", String(err?.message ?? err), relatedMemoryIds);
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

  // #218 末楼的实际事故：profile 被清理，落在其中的记忆库连带丢失。命中
  // profile 作用域时给一条可操作的告警（只提示、不搬库、不加配置键），启发
  // 式的边界与取舍见 src/placement.js 文件头。
  const profileScope = findProfileScopeSegment(memoryDir);
  if (profileScope) {
    ctx.logger?.warn?.(
      `[dsh-mneme] memoryDir is inside a profile scope ("${profileScope}"): ${memoryDir} — the library may be lost when the host cleans or migrates profiles. Prefer a location outside profiles/ (default: ~/.dsh/memory; config key: memoryDir).`
    );
  }

  const store = createStore(join(memoryDir, "memory.db"));

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
  // #622：错峰时段串（summarizePeakHours / dreamPeakHours）解析失败 = 静默未配置
  // （parsePeakSpec 的契约：排程是省钱手段，绝不该因写错格式停掉蒸馏/巩固）。但
  // 「不救错」不等于「不吭声」——配置写错的唯一症状是功能悄悄没生效（#424 的排查
  // 只能靠「高峰期还在巩固」倒推）。这里对**非空**且解析为 null 的键各出一条 warn：
  // 空串是合法的未配置，不告警（否则每个没配错峰的用户开机都被警告一遍）。helper
  // 只转述 parsePeakSpec：等价类归一（PR #621，评审中）落地后，救得了的写法自然
  // 不再走到这。行为零变化：只 log，不改 cfg。
  for (const [key, spec] of Object.entries(invalidPeakSpecs(cfg))) {
    ctx.logger?.warn?.(
      `[dsh-mneme] ${key} "${spec}" 不是合法的高峰时段串，将按未配置处理（错峰不生效、全天候运行）。` +
      `写法：09:00-18:00，多段用逗号分隔，可带星期前缀（mon-fri 08:00-12:00），支持跨零点；24:00 越界请写 00:00`
    );
  }
  const sessionGate = createSessionGate(cfg);

  // 失败表的启动期清理也放在装配之后（此前它在 createStore 之后、装配之前，写死
  // 90 天）。保留期现在是显式配置键 reflectionFailureRetentionDays；等它进面板
  // 白名单的那天，这里读的就是装配后的值，不用再改第二处。best-effort 语义不变：
  // 清理失败不挡启动，否则一次锁表就能让插件起不来——但「不挡启动」不等于「可以
  // 悄悄失败」：这一族的 recall_runs 清理当年就是静默蒸发，表涨到两万余行无人
  // 察觉，所以本处与 llm_audit / distill_records / recall_runs 三处一样出声。
  try {
    const failureRetentionDays = Number.isInteger(cfg.reflectionFailureRetentionDays)
      ? cfg.reflectionFailureRetentionDays
      : 90;
    store.deleteOldFailures(new Date(Date.now() - failureRetentionDays * 86400000).toISOString());
  } catch (err) {
    ctx.logger?.warn?.(`[dsh-mneme] failure-table retention purge failed: ${String(err)}`);
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
  } catch (err) {
    ctx.logger?.warn?.(`[dsh-mneme] llm_audit retention purge failed: ${String(err)}`);
  }

  // #399 的启动期裁剪：与上面同款（读装配后的 cfg，理由同上——面板写的保留期必须
  // 与写入侧取到同一个值）。不同的一点：蒸馏原文留存默认关，而「默认关」在写入侧
  // 的含义就是零写入，所以这里也只在 enabled === true 时才动手——否则一张空表被
  // 每次启动扫一遍，白付一次全表 DELETE 的代价。只裁 distill_records；链接
  // （memory_provenance）保留，指向空区间即为「来源已过期」。
  try {
    if (cfg.distillRecords?.enabled === true) {
      const retentionMs = Number.isInteger(cfg.distillRecords?.retentionDays)
        ? cfg.distillRecords.retentionDays
        : 90;
      store.clearDistillRecords(new Date(Date.now() - retentionMs * 86400000).toISOString());
    }
  } catch (err) {
    ctx.logger?.warn?.(`[dsh-mneme] distill_records retention purge failed: ${String(err)}`);
  }

  // recall_runs 的滚动清理（v0.7.0 原设计，2026-10-14 找回）：与 llm_audit 同策略，
  // 按 cfg.recallRetentionDays（默认 90 天）启动时清一次。读装配后的 cfg，理由与上面
  // 两处一致 —— 写入侧取的是 cfg，清理侧若取 rawCfg，面板改的保留期就不生效。
  // 这一对曾在 dd0ed78（v0.7.12 发布提交）里被整块弄丢，配置键与文档却一直留着，
  // 实测 2026-10-13 那天从 16,041 涨到 20,510 行（一天四千余行，只增不减；
  // 单给一个静态行数会随表腐坏，故带日期的区间才是可核对的说法）。注入行开始写真实 query 之后，这条从「表膨胀」
  // 升级为「原话无限期留存」，所以必须与那次改动同批交付。
  // 保留期语义是「天」（函数内部乘 86400000），清理失败只 warn，绝不挡插件启动。
  try {
    const recallRetentionDays = Number.isInteger(cfg.recallRetentionDays) ? cfg.recallRetentionDays : 90;
    store.purgeRecallRunsOlderThan(recallRetentionDays);
  } catch (err) {
    // 这里必须真的出声。这一对当初是**静默**蒸发的：函数与调用一起没了、没人发现，
    // 表就这么涨到两万余行。清理再失败一次而仍然不出声，同样的回归照样看不见——
    // 「只 warn」不是修辞，是这族清理唯一的事后线索。
    ctx.logger?.warn?.(`[dsh-mneme] recall_runs retention purge failed: ${String(err)}`);
  }

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
  // M.O. 执行记账器：默认 null（旗标关），开了才装配。
  let recorder = null;
  if (ctx.commands) {
    commands = createCommandManager({ ctx, settings, logger: ctx.logger, language: langOf(cfg) });
    commands.sync();
  }

  // M.O. 执行记账（v0.9.0 第二批）：`/mo-run` 显式开一次执行窗口，窗口内的命令执行
  // 才可能被记成一条 run。挂的是 `session/event`——本仓已有三处消费者（continuity /
  // summarize / api），不是新引入的宿主依赖。
  //
  // 为什么必须显式开窗：工作流的 trigger 是人话，拿它去猜「用户这句话是不是要开始走
  // 某条流程」只能猜错，而猜错会把一条从没跑过的流程记成跑过。所以窗口边界由人的
  // 显式动作划，**没开窗时一个字都不记**。
  //
  // 门控：默认关（actionRunEnabled），并且它挂热路径，轻量档也关。
  if (cfg.actionRunEnabled === true) {
    recorder = createExecutionRecorder({ ctx, logger: ctx.logger, sessionGate });
    const disposeMoRun = registerMoRunCommand({
      ctx,
      recorder,
      enabled: true,
      language: () => langOf(cfg)
    });
    if (disposeMoRun) {
      disposers.push(disposeMoRun);
    } else {
      // 注册不上（宿主没有命令注册表）时别留一个只开着窗口却没人能操作的记录器。
      recorder.dispose();
      recorder = null;
      ctx.logger?.warn?.("[dsh-mneme] actionRunEnabled=true 但宿主没有命令注册表，M.O. 记账未启用");
    }
  }

  // 「Agent 眼中的你」自动事实（2026-11-06，opt-in：profileFactsEnabled）：dream 巩固
  // 轮成功后的逐卡维护 + 面板手动轮（api.js）+ 注入事实段（factsProvider 传注入器与
  // 预览路由）。装配与开关无关——闸在消费侧（注入渲染 / 自动轮判空 / 路由 409），
  // 与 profileExtractor 同款：503 只该指装配缺失，不该被读成「用户没开」。
  // 位置必须在 dream 调度器之前：onRun 的 fire-and-forget 收尾要引用它。
  const profileFacts = createProfileFacts({ ctx, service, store, config: cfg, logger: ctx.logger });

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
      onRun: () => {
        const run = dream
          ? dream.runDream(ctx, service, cfg)
          : Promise.resolve({ ok: true, skipped: true });
        // 画像事实自动维护：挂在巩固轮之后 fire-and-forget。刻意不并进 onRun 的
        // promise——profileFacts 的失败不能被计入 dream 的失败退避
        // （autoDreamFailureBackoff 的口径是巩固轮自身）；逐卡经 service.enqueue
        // 串行，不与 sleep/下一轮巩固抢模型。单卡失败只 warn，账本已有 failed 回执。
        run.then(async (rep) => {
          if (cfg.profileFactsEnabled !== true || (rep && rep.ok === false)) return;
          for (const key of profileFacts.autoPassCandidates()) {
            try {
              await service.enqueue(() => profileFacts.runFor(key, { trigger: "auto" }));
            } catch (error) {
              ctx.logger?.warn?.(`[dsh-mneme] profile-facts auto pass failed for card "${key || "default"}": ${error?.message ?? error}`);
            }
          }
        }).catch(() => { /* dream 自身失败走调度器退避，这里不做第二遍日志 */ });
        return run;
      }
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

  try {
    const disposeSessionGate = ctx.on?.("session/event", (session) => sessionGate.observe(session));
    if (typeof disposeSessionGate === "function") disposers.push(disposeSessionGate);
  } catch {
    // 宿主没有该事件钩子时，注入、工具与蒸馏消费点仍直接检查当前 Session。
  }

  // Issue #380：注入前判定闸门。判定 LLM 走 entity adapter 同款装配（ctx.llm +
  // agentDefaultModel 回退），gate 自持 enabled/usable 判定（未启用/llm 缺席/
  // llmAudit 关闭时内部恒 off，注入行为与现状逐字节一致）。
  const preInjectGate = createPreInjectGate({
    llm: ctx.llm,
    agentDefaultModel: ctx.agentDefaultModel,
    service,
    config: cfg,
    logger: ctx.logger
  });
  disposers.push(() => preInjectGate.clear());

  // #118: never let a pending embedder init retry fire after unload and touch
  // a torn-down context.
  disposers.push(() => semantic.dispose());   // #118 重试计时器 + boot 回填计时器(搬入 semantic.js 后由它自持)

  // chorography M3：地志提纲折进 memory context（不新开 context——宿主侧同 order 无
  // 兜底排序，多一块就多一份拼装抖动；spec §7 也要求「合并成一次拼装」）。档位由
  // chorographyInject 决定，off / 未匹配到仓库 / 渲染失败一律返回空串，宿主会过滤
  // 掉空文本，整块消失且不占位。
  //
  // 预算是 0：注入块只在 memory context 里多几行，本身不做检索、不 fork git——
  // 真过期判定留给 /choro（P29）。所以这里不需要额外的「热路径」闸，chorographyEnabled
  // 与 chorographyInject 两个开关在 resolveInjectTier 里已经判完。
  const choroInject = createChoroInject({
    choro: createChoroQueries({ store }),
    config: cfg,
    logger: ctx.logger,
    language: () => langOf(cfg)
  });
  disposers.push(() => choroInject.dispose());

  ctx.inject(["systemPrompt"], (promptCtx) => {
    if (cfg.autoInject) {
      disposers.push(createInjector(promptCtx, service, settings, cfg, preInjectGate, sessionGate, choroInject, profileFacts.factsProvider));
    }
  });

  // #249 N3：压缩边缘双落点。触发靠宿主自己落的压缩事件（订阅 + pre-step 追加），
  // 不需要 systemPrompt / tools 的任何能力，所以不塞进上面的 inject 回调；父／子
  // 闸门在挂载点判一次，与 inject.js 共用同一个 injectChildEnabled 判据。
  if (cfg.autoInject && injectChildEnabled(cfg, "continuityRescueEnabled")) {
    disposers.push(createContinuityRescue(ctx, store, sessionGate));
  }

  // 知识库第二层（契约 §3.4）：装配与开关无关（createKb 只建对象，读侧零 IO），闸在
  // 路由与工具两层——这样「没开」（409）与「没装配」（503）在对外两面都是可区分的。
  // 位置必须在 tools/api 两处消费点之前：cordis 的 inject 回调可能在任一之后才触发，
  // 在消费点里现建就会造出第二份实例（两份缓存、两套 dispose）。
  const kb = createKb({ store, embedder, cfg });
  disposers.push(() => kb.dispose?.());

  ctx.inject(["tools"], (toolsCtx) => {
    // choro（M1）：只读查询对象，chorographyEnabled 关着时工具压根不注册（闸在
    // createTools 的 hiddenTools，与 organizeEnabled 同款反向语义）。
    disposers.push(createTools(toolsCtx, service, cfg, embedder, sessionGate, createChoroQueries({ store }), kb));
  });

  // chorography M3：/choro 只读回执。与 /mo-run 同形（ctx.commands.register），
  // 但这里**不持有任何状态**、不写盘、不重建——spec §2 D6「只手动触发，过期只提示」
  // 决定了这条命令只能看，不能改。位置必须在 disposers 声明之后（同 actionNudge 的
  // TDZ 注释），否则插件加载时会直接抛 ReferenceError。
  if (cfg.chorographyEnabled === true) {
    const disposeChoro = registerChoroCommand({
      ctx,
      choro: createChoroQueries({ store }),
      config: cfg,
      enabled: true,
      language: () => langOf(cfg)
    });
    if (disposeChoro) disposers.push(disposeChoro);
    else ctx.logger?.info?.("[dsh-mneme] chorographyEnabled=true 但宿主没有命令注册表，/choro 未注册");
  }

  const summarizer = createSummarizer(ctx, service, cfg, {}, sessionGate);
  disposers.push(summarizer.dispose);

  // QQ 日记本（v0.13，diaryEnabled）：构造期零副作用（只闭包住依赖，不建目录、不读盘、
  // 不调模型），所以位置可以放在这里——它必须早于下面的 createApi，面板的
  // 「写一篇」按钮要转调同一个 composer；而自动触发侧在 webServer 块之后挂（同
  // actionNudge 的 TDZ 理由）。关闸时 composer 是 null：路由回 409、座位不注册，
  // 与「装配缺失」的 503 严格区分（#497 先例）。
  const diary = cfg.diaryEnabled === true
    ? createDiaryComposer({ ctx, config: cfg, logger: ctx.logger, service, settings, memoryDir })
    : null;

  // #275 存储生命周期第一批：无损回收的手动入口。刻意不挂启动路径、不接定时器——
  // 这一步是不可逆的内容丢弃，只由人显式触发（面板的维护卡、`dsh-mneme reclaim`）。
  // 实例建在插件进程内，是为了让 CLI 也能走这条路：VACUUM 要排他锁，跟宿主抢锁的
  // 那条路走不通。
  // 位置在 webServer 块之前：面板的 in-process API（createApi）与 standalone 数据面
  // 都要用它，而 webServer 是可选的——headless 宿主不注册面板路由，构造点若留在块后
  // 就永远晚于 createApi（#386 第 4 条）。构造期无副作用（只返回 { reclaim }），前移安全。
  const maintenance = createMaintenance({ store, config: cfg, logger: ctx.logger });

  // webServer 可选依赖：cordis 4 的 ctx 是 Proxy，直接访问未在 inject 声明的
  // 属性会抛 "cannot get property without inject"（不会返回 undefined），所以
  // 不能用 if (ctx.webServer) 守卫。ctx.reflect.get 是 cordis 提供的免 inject
  // 读取（未提供时返回 undefined）；对象字面量 mock ctx（测试）没有 reflect，
  // 退回直接属性访问。headless/无 UI 宿主无 webServer 时跳过 API 注册，其余
  // 功能（工具/注入/dream）照常。
  const webServer = typeof ctx.reflect?.get === "function" ? ctx.reflect.get("webServer") : ctx.webServer;
  if (webServer) {
    // 画像提取草稿（#497）：装配与开关无关——闸在路由那一侧（关着回 409 disabled，
    // 本模块一次都不会被调用）。这样「没启用」与「没装配」在 HTTP 面上是两个可区分的
    // 答案（503 unavailable 只该出现在旧宿主/装配缺失上，不该被读成「用户没开」）。
    const extractProfileDraft = createProfileExtractor({ ctx, service, config: cfg, logger: ctx.logger });
    // chorography 读侧（M1）：与 service 刻意分开——所有权模型相反（spec §3）。
    // 闸在路由/工具两层（关着 409 / 不注册），queries 本体装配与开关无关。
    // 收尾档：choro 对象加两件 host 侧能力——embedder（向量惰性物化，P37）与
    // runT0Apply（面板重建按钮的写路径，P34；T1 不上 HTTP，CLI 仍是它的入口）。
    // T1 任务账随 choro 装配建立（与开关无关：开关在路由那侧判，没开时这些方法一次
    // 都不会被调到，符合「503=装配缺件 / 409=用户没开」的分叉）。
    const t1Jobs = createT1Jobs({ store, dbPath: join(memoryDir, "memory.db") });
    disposers.push(() => t1Jobs.dispose());
    const choro = {
      ...createChoroQueries({ store }),
      embedder,
      // guardT1Loss 只给「读侧顺手刷新」用：那条路不是用户的明确指令，不能替他
      // 丢掉花模型调用换来的语义段。手动重建（面板按钮 / CLI）不传，行为不变。
      runT0Apply: ({ repoRoot, guardT1Loss = false }) => runChoroT0({ repoRoot, store, apply: true, guardT1Loss }),
      startT1Job: (args) => t1Jobs.start(args),
      t1JobStatus: (jobId) => t1Jobs.status(jobId),
    };
    // The semantic surface handed to the API is createSemantic()'s own return
    // value, plus the vectorIndex it does not carry. Passing the bare literal
    // `{ vectorIndex, reranker }` used to drop embeddingDiagnostics, so the
    // panel's `data.embeddings` was permanently null on a real install — the
    // typeof guard in api.js fell through every time, and no test noticed
    // because none asserted on `data.embeddings`.
    const api = createApi(ctx, service, settings, commands ?? {
      add: () => { throw new Error("commands unavailable"); },
      remove: () => false,
      list: () => []
    }, embedder, { ...semantic, vectorIndex, reranker }, cfg.apiToken, cfg, maintenance, extractProfileDraft, choro, profileFacts, kb, diary);
    disposers.push(api.dispose);

    // dsh-go 原生面板：只有宿主提供 dshGo 服务（dsh-go 手机 App）时才挂载。
    // 动态 import 是刻意的——静态导入会让「没有桥就整块不加载」这句承诺落空。
    // cfg.apiToken 一并交给面板：createApi 给 token / token-write 路由包了鉴权，
    // 进程内调用不带令牌会被自家路由拦成 401，不为此在服务端开白名单。
    ctx.inject(["dshGo"], (dshCtx) => {
      import("./dsh-go/panel.js")
        .then((panel) => panel.mountDshGoPanel(dshCtx, { apiToken: cfg.apiToken }))
        .catch((error) => ctx.logger?.warn?.(`[dsh-mneme] dsh-go 面板未加载：${error?.message ?? error}`));
    });
  }

  // M.O. 自动沉淀（v0.9.3）：项目里重复走的那套动作，自动变成 memoryDir 里的一条
  // 「提议」，等人确认后才可能进仓库。默认关（actionNudgeEnabled）。
  //
  // 为什么位置在这里而不是和 M.O. 记账同段：`disposers` 声明在 :532，而记账块在它
  // 之前（TDZ）——照抄过去会在插件加载时直接抛 ReferenceError。这里已在其后。
  //
  // 为什么挂 session/event 却又要进轻量档黑名单：它读的是 zstd 会话日志（同步解压），
  // 是本插件里最重的一条后台路径；且它只产「提议」，关掉不影响记忆本身的正确性。
  if (cfg.actionNudgeEnabled === true) {
    disposers.push(createNudgeAutoRun({ ctx, memoryDir, logger: ctx.logger, sessionGate }));
  }

  // 日记的触发侧（v0.13）：turn/end 跨天判定 + 启动补写。
  //
  // 启动补写为什么在这里而不是 webServer 块里：它不依赖面板，headless 宿主也该补。
  // 补哪个项目只能靠状态文件里记过的项目根——宿主刚起来时没有任何会话，
  // 而「上次是哪个项目、哪天写的」就在那儿。补写不 await：启动路径上吊住一次
  // 模型调用，等于让整个插件加载等模型回来（本机 p90 五十秒级）。
  if (diary) {
    // diaryWriteEveryMinutes > 0 时额外起一根定时器（见 auto.js 的 tick）：日记不该
    // 取决于「谁先开口」，整天不说话也要有一篇。listProjects 用 knownProjects ——
    // 定时器唤醒时没有会话，只能靠状态文件里记过的项目根。
    const everyMinutes = Number(cfg.diaryWriteEveryMinutes) || 0;
    const diaryAuto = createDiaryAutoRun({
      ctx,
      composer: diary,
      logger: ctx.logger,
      sessionGate,
      everyMs: everyMinutes > 0 ? everyMinutes * 60 * 1000 : 0,
      listProjects: () => diary.knownProjects()
    });
    disposers.push(diaryAuto);
    const projects = diary.knownProjects();
    if (projects.length) {
      Promise.resolve(diaryAuto.catchUp(projects)).catch((error) => {
        ctx.logger?.warn?.("[dsh-mneme] diary startup catch-up failed: " + String(error));
      });
    }
  }

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
    recorder?.dispose();
    if (dream) await dream.dispose();
    if (sleep) sleep.dispose();
    store.close();
  };
};
