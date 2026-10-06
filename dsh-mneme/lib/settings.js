// User-configurable settings: profile (user self-description), rules (behavior
// rules the agent must follow), and custom slash commands. Stored in the same
// SQLite database via dedicated tables, isolated from the memories store.
import { randomUUID } from "node:crypto";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS custom_commands (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  instruction TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`;

// DSH command names must match this (lowercase, start with a letter).
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/;

/** Parse a JSON array out of a stored string, tolerant of corruption. */
function parseList(raw) {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

// --- feature flags（功能开关）白名单 -----------------------------------------
// 面板可逐项开关的后端能力。设计约束：
// 1. 键名与类型必须和 config.js schema 同名同型，这份白名单是唯一校验源
//    （api.js 复用它计算 effective），schema 增删能力键时要同步改这里。
// 2. 持久化（kv "feature_flags"）只落白名单键；读到未知键、类型损坏或越界的
//    值一律丢弃而不是报错——kv 会残留旧版本写入的键，读路径必须向前兼容。
// 3. 写入是逐键校验的合并写：未知键/类型/范围不符抛 TypeError（消息含键名，
//    供 API 透传给前端定位），校验不通过不落库，坏值永远进不了 kv。
const FEATURE_FLAG_BOOLEANS = [
  "autoInject",
  "autoSummarize",
  "hotMemoryEnabled",
  // Issue #34（v0.7.2 引入；v0.7.11 误删后随 #333 恢复）：对话开始注入当前时间。
  // 顶层扁平键，随白名单回面板（FEATURE_GROUPS 的 group.core）。
  "injectTimePrefix",
  // Issue #239 第 5 项：注入条数的查询自适应（确定性强则收缩注入条数，默认关）。
  "injectUncertaintyAdaptive",
  // Issue #249：能力说明（工具描述判断指引 + order 150 总则段）。第二批起它是
  // 注入父开关 autoInject 的子项、默认开（父关时不生效，闸门见 config.js）。
  "injectGuidanceEnabled",
  // Issue #249 N3：压缩边缘双落点——上下文即将精简前落一条连续性提案 + 往
  // 序列末尾追加同一份快照。默认关（新注入表面，见 config.js），父开关 autoInject。
  "continuityRescueEnabled",
  "entityExtractionEnabled",
  // Issue #219：图召回轴——查询命中实体名时把挂联记忆并入检索融合池
  // （默认关；依赖实体抽取产出，lightMode 强制关闭）。
  "entityRecallEnabled",
  // Issue #24 块1：图谱锚定层级联——命中实体作种子、沿关系表向邻居扩散
  // （默认关；依赖实体抽取产出，lightMode 强制关闭）。
  "graphAnchoringEnabled",
  // Issue #24 块2：边权重演化总闸——关着时任何触达都不改边权（默认关；
  // 依赖实体抽取产出，lightMode 强制关闭）。块4 的被动确认是它底下的一个通道。
  "graphWeightEnabled",
  // Issue #24 块3：关联提示防幻觉——图召回线索行以「[检索线索]」标注进注入
  // （默认关=线索只参与排序不进块；依赖实体抽取产出，lightMode 强制关闭）。
  "graphInjectHint",
  // Issue #24 块4：被动确认通道——正常触达即对该记忆挂联的边 bump 一格
  // （默认关；需总闸 graphWeightEnabled 同开）。
  "graphPassiveConfirm",
  // Issue #164：叙述条——dream 期间按 tag 主题簇合成叙述落库（source=
  // narrative，evidence 回链簇内记忆；按需检索不常驻注入；默认关）。
  "dreamNarrativeEnabled",
  // Issue #230：document 型记忆——agent 产长文档的指针行（注册校验/摘要+
  // doc_path 落库/C2 去重/supersede 记账；全文归 agent；默认关，lightMode 强制关）。
  "documentMemoryEnabled",
  "codingRetrospect",
  "autoDream",
  // Issue #292：autoDream 连续失败退避（默认关）。基数是 dreamMinIntervalMinutes，
  // 有效间隔 = 基数 × 2^连续失败数（成功清零），封顶 30 分钟；面板可启停。
  "autoDreamFailureBackoff",
  "sleepModeEnabled",
  "heatEnabled",
  // issue #218 / E5：注入侧 heat 独立开关（默认关，老用户 injectHeatEnabled=true 回滚）。
  "injectHeatEnabled",
  "hybridInject",
  "selectiveInjectEnabled",
  "searchSemanticDedup",
  "rerankEnabled",
  "resilientModelDownload",
  "adaptiveThresholdEnabled",
  "reflectionUpdateEnabled",
  "reflectionFailureTracking",
  "bm25SearchEnabled",
  "conflictFreezeEnabled",
  "trustEpistemicWeighting",
  // Plan #2: attach per-source {keyword, vector, bm25, final} signals to each
  // search result for transparency/debugging. Default off, purely decorative.
  "signalTransparency",
  // Issue #89：宽容校验回归（默认开）+ 跨类型合并显式放宽（默认关）。
  "dreamSkipInvalid",
  "allowCrossTypeMerge",
  // Issue #339 / E8：guarded 类型 merge 护栏（默认开）——合并对象命中
  // 长保留类型的 merge 决策整条跳过。关掉 = guarded 类型的 merge 不再被跳过，
  // 「更精炼的摘要」重新成为约束失真的主通道（面板可关，供需要旧行为的库回退）。
  "dreamMergeGuard",
  // Issue #17（v0.8.0 A1）：scope 隔离存储层总开关。开启后写入标注
  // agent_scope/workspace_scope、去重键扩展（含 sensitivity）；检索侧过滤在
  // A2/A3。默认关=行为与 A1 前逐字节一致。
  "scopeEnabled",
  // Issue #17（v0.8.0 A3）：strictScope 硬过滤——他 scope 完全不可见（关闭时
  // 为 A2 软隔离：降权保留可见）。
  "strictScope",
  // 工具暴露开关（v0.8.5）：记忆已每轮自动注入，memory_search/memory_archive
  // 在慢/轻量模型上是多余往返，面板可关（默认关=行为不变）。
  "disableMemorySearch",
  "disableMemoryArchive",
  // 嵌套对象开关：config.js 里是 memoryQualityFilter / llmAudit 对象的 enabled
  // 子字段。kv 按点号键平铺存（"memoryQualityFilter.enabled": false），index.js
  // 合并时展开回嵌套对象，api.js 的 effective 从对象子字段取值。
  "memoryQualityFilter.enabled",
  "llmAudit.enabled",
  // Issue #254：写入准入（第 1 级确定性拒绝）。两个键分层——enabled 跑判据、
  // enforce 真拦；都默认关。同上，点号键平铺存、合并时展开回
  // writeAdmission 对象。
  "writeAdmission.enabled",
  "writeAdmission.enforce",
  // Issue #380：注入前判定（意见/立场记忆先判定后处置）。两个键分层与 #254 同构
  // ——enabled 跑判定（观察档，只审计）、enforce 真过滤；都默认关。点号键平铺
  // 存、合并时展开回 preInjectGate 对象。
  "preInjectGate.enabled",
  "preInjectGate.enforce",
  // Issue #164 A2：写入边界的密钥 / PII 判据（src/sensitive-scan.js）。与上面两个
  // 键分层——本键决定「这类判据参不参与」（默认关），命中之后是仅告警还是真拦仍由
  // writeAdmission.enforce 决定（#164 口径：默认仅告警、拦截 opt-in）。
  "sensitiveScanEnabled"
];
// 整数开关的闭区间，与 config.js 里 z.natural().min().max() 对齐。
const FEATURE_FLAG_INT_RANGES = {
  distillRateLimitIntervalMs: [0, 60000],
  distillRateLimitRetries: [0, 10],
  distillRateLimitBaseDelayMs: [100, 60000],
  distillMaxChars: [1000, 200000],
  codingBoostFactor: [1, 5],
  dreamMinIntervalMinutes: [0, 10080],
  dreamMaxTokens: [256, 131072],
  // Issue #127：autoSummarize 节流三键（0 = 零行为变化，等同现状）。
  summarizeMinIntervalMinutes: [0, 10080],
  summarizeMaxEntriesPerRun: [0, 50],
  summarizeDedupeWindowHours: [0, 168],
  // Issue #239：蒸馏零 LLM 预判（窗口最小字符数）与每会话 run 预算（0 = 零行为变化）。
  summarizeMinWindowChars: [0, 100000],
  summarizeMaxRunsPerSession: [0, 1000],
  // Issue #239 第 4 项：高峰顺延上限（分钟，0 = 不设上限）。
  summarizePeakMaxDeferMinutes: [0, 1440],
  // Issue #239 第 4 项镜像到巩固：同一口径（分钟，0 = 不设上限）。
  dreamPeakMaxDeferMinutes: [0, 1440],
  // Issue #125：hybrid 候选量上限（0 = 复用 dreamMaxSnapshotSize）。
  dreamCandidateMax: [0, 5000],
  // Issue #164①：注入单条正文截断上限（默认 300 = 既有行为）。
  injectContentMaxChars: [60, 4000],
  // Issue #164：叙述条成簇门槛（共享同一 tag 的记忆数下限）。
  dreamNarrativeMinCluster: [2, 20],
  // Issue #230：document 摘要行的注入预算（次优先档内最多几条指针行）。
  documentInjectBudget: [1, 5],
  // Issue #249 第一批：B1 pin 池（约束/偏好）的独立条数预算（0 = 关闭/现状）。
  pinnedInjectBudget: [0, 5],
  // Issue #257：sleep 冲突/模式阶段的 LLM 输出预算（原硬编码 2048，实测不足）。
  sleepMaxTokens: [256, 131072],
  // Issue #258：总览（dream_summarize）输入条数硬上限（0 = 不设上限）。
  dreamSummaryMaxInputs: [0, 100000],
  // Issue #24 块1：锚定种子上限与级联深度（闭区间与 config.js 的 z.natural() 对齐）。
  graphSeedCap: [1, 30],
  graphCascadeDepth: [1, 3],
  // Issue #24 块3：图线索行的独立注入预算（0 = 线索不进块）。
  graphInjectBudget: [0, 5]
};
// 浮点开关的闭区间（与 config.js 的 z.number().min().max() 对齐）。与整数开关
// 分开：面板的整数控件要求 Number.isInteger，而余弦相似度阈值必须允许小数。
const FEATURE_FLAG_NUMBER_RANGES = {
  // Issue #127：vector 去重档的并入阈值。
  summarizeDedupeMinSim: [0.5, 0.99],
  // Issue #125：hybrid 判"高相似"的阈值。
  dreamCandidateMinSim: [0.5, 0.99],
  // Issue #24 块2：单次有效触达的边权抬升幅度（与 config.js 的闭区间对齐）。
  graphWeightDelta: [0, 1]
};
// 自由字符串开关（与 config.js 的 z.string() 同名同型）：trim 后 ≤200 字符，
// 空串合法（= 跟随主对话模型/默认路径，面板显示 placeholder）。
const FEATURE_FLAG_STRINGS = [
  "dreamProvider",
  "dreamModel",
  // 睡眠侧专用路由（sleep.js 的 config-first 第三层）：面板下拉随
  // /llm-providers 端点一起提供，留空 = 用巩固模型或当前模型。
  "sleepProvider",
  "sleepModel",
  // 实体抽取侧专用路由（issue #109）：provider/model 显式指定，
  // 留空 = 用当前默认模型。
  "entityExtractionProvider",
  "entityExtractionModel",
  // Issue #258：总览（dream_summarize）专用路由，留空 = 用巩固模型。
  "dreamSummaryProvider",
  "dreamSummaryModel",
  "localEmbedModel",
  "ollamaModel",
  // Issue #239 第 4 项：高峰时段串（"09:00-18:00"，空串 = 关闭）。
  "summarizePeakHours",
  // Issue #239 第 4 项镜像到巩固：同一份时段语法，空串 = 关闭（行为与现状一致）。
  "dreamPeakHours"
];
// URL 字符串开关：trim 后必须为空或合法 http/https URL（new URL() 校验协议，
// 拒绝其余协议——这是 SSRF 防线的一部分）。
const FEATURE_FLAG_URLS = ["ollamaBaseUrl"];
// 枚举开关（与 config.js 的 z.union(z.const(...)) 对齐）：仅允许列出的值。
const FEATURE_FLAG_ENUMS = {
  embedProvider: ["openai", "local", "ollama"],
  // Plan #1: recall fusion recipe. blend = legacy (default); rrf / minmax are
  // rank/scale-aware alternatives selected by the panel.
  recallFusion: ["blend", "rrf", "minmax"],
  // 实体抽取思考强度（issue #109）：与 dreamReasoningEffort 枚举对齐。
  entityExtractionReasoning: ["low", "medium", "high", "none"],
  // 蒸馏思考强度（issue #315）：与 entityExtractionReasoning 枚举对齐，
  // 多一个 off（显式关思考，思考型模型蒸馏防推理烧预算）。
  summarizeReasoningEffort: ["off", "low", "medium", "high", "none"],
  // Issue #127：落库前去重档位（off 默认，等同现状）。
  summarizeDedupeMode: ["off", "title", "vector"],
  // Issue #126：sleep 冲突阶段的动作集（conflict 默认 = 现状；full = 六分支）。
  sleepActionSet: ["conflict", "full"],
    // Issue #125：dream 候选集构造方式（window 默认 = 现状；hybrid 并入向量组）。
    dreamCandidateMode: ["window", "hybrid"],
    // 本地嵌入池化：auto = 按模型族判定（BGE → cls），可显式覆盖为 cls / mean。
    localEmbedPooling: ["auto", "cls", "mean"]
};
const FEATURE_FLAG_STRING_MAX = 200;

// 供 api.js 复用同一份白名单（effective 只在白名单键上计算）。
export const FEATURE_FLAG_SPEC = {
  booleans: FEATURE_FLAG_BOOLEANS,
  ints: FEATURE_FLAG_INT_RANGES,
  numbers: FEATURE_FLAG_NUMBER_RANGES,
  strings: FEATURE_FLAG_STRINGS,
  urls: FEATURE_FLAG_URLS,
  enums: FEATURE_FLAG_ENUMS
};

/** ollamaBaseUrl 的协议白名单：只接受 http/https（SSRF 防线的一部分）。 */
function isHttpUrl(value) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** 校验单个开关值；不合法抛 TypeError（消息含键名）。 */
function validateFlag(key, value) {
  if (FEATURE_FLAG_BOOLEANS.includes(key)) {
    if (typeof value !== "boolean") {
      throw new TypeError(`feature flag "${key}" must be a boolean`);
    }
    return value;
  }
  const range = FEATURE_FLAG_INT_RANGES[key];
  if (range) {
    const [min, max] = range;
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new TypeError(`feature flag "${key}" must be an integer in [${min}, ${max}]`);
    }
    return value;
  }
  const numRange = FEATURE_FLAG_NUMBER_RANGES[key];
  if (numRange) {
    const [min, max] = numRange;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw new TypeError(`feature flag "${key}" must be a number in [${min}, ${max}]`);
    }
    return value;
  }
  if (FEATURE_FLAG_STRINGS.includes(key)) {
    if (typeof value !== "string") {
      throw new TypeError(`feature flag "${key}" must be a string`);
    }
    const trimmed = value.trim();
    if (trimmed.length > FEATURE_FLAG_STRING_MAX) {
      throw new TypeError(`feature flag "${key}" must be at most ${FEATURE_FLAG_STRING_MAX} characters`);
    }
    return trimmed; // 空串合法 = 跟随默认
  }
  if (FEATURE_FLAG_URLS.includes(key)) {
    if (typeof value !== "string") {
      throw new TypeError(`feature flag "${key}" must be a string`);
    }
    const trimmed = value.trim();
    if (trimmed && !isHttpUrl(trimmed)) {
      throw new TypeError(`feature flag "${key}" must be empty or a valid http(s) URL`);
    }
    return trimmed; // 空串合法 = 跟随默认
  }
  const allowed = FEATURE_FLAG_ENUMS[key];
  if (allowed) {
    if (typeof value !== "string" || !allowed.includes(value)) {
      throw new TypeError(`feature flag "${key}" must be one of: ${allowed.join(", ")}`);
    }
    return value;
  }
  throw new TypeError(`unknown feature flag "${key}"`);
}

/** 清洗已存的 feature_flags 对象：只保留白名单键，类型/范围损坏的键丢弃。 */
function sanitizeFlags(raw) {
  const out = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const key of FEATURE_FLAG_BOOLEANS) {
    if (typeof raw[key] === "boolean") out[key] = raw[key];
  }
  for (const [key, [min, max]] of Object.entries(FEATURE_FLAG_INT_RANGES)) {
    if (Number.isInteger(raw[key]) && raw[key] >= min && raw[key] <= max) out[key] = raw[key];
  }
  for (const [key, [min, max]] of Object.entries(FEATURE_FLAG_NUMBER_RANGES)) {
    if (typeof raw[key] === "number" && Number.isFinite(raw[key]) && raw[key] >= min && raw[key] <= max) {
      out[key] = raw[key];
    }
  }
  for (const key of FEATURE_FLAG_STRINGS) {
    if (typeof raw[key] === "string" && raw[key].trim().length <= FEATURE_FLAG_STRING_MAX) {
      out[key] = raw[key].trim();
    }
  }
  for (const key of FEATURE_FLAG_URLS) {
    if (typeof raw[key] === "string") {
      const trimmed = raw[key].trim();
      if (!trimmed || isHttpUrl(trimmed)) out[key] = trimmed;
    }
  }
  for (const [key, allowed] of Object.entries(FEATURE_FLAG_ENUMS)) {
    if (allowed.includes(raw[key])) out[key] = raw[key];
  }
  return out;
}

export function createSettings(db) {
  db.exec(SCHEMA);

  function getSetting(key) {
    const row = db.prepare("SELECT value FROM user_settings WHERE key = ?").get(key);
    return row?.value ?? undefined;
  }

  function setSetting(key, value) {
    db.prepare(
      `INSERT INTO user_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value);
  }

  function toCommand(row) {
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      instruction: row.instruction,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  return {
    /** The user's self-description (free text) or "" when unset. */
    getProfile() {
      return getSetting("profile") ?? "";
    },
    setProfile(text) {
      setSetting("profile", String(text ?? ""));
    },

    /** Behavior rules as an array of strings. */
    getRules() {
      return parseList(getSetting("rules") ?? "[]").filter((r) => typeof r === "string");
    },
    setRules(rules) {
      const list = Array.isArray(rules) ? rules.filter((r) => typeof r === "string") : [];
      setSetting("rules", JSON.stringify(list));
    },

    /** All custom commands, sorted by name. */
    listCommands() {
      const rows = db.prepare("SELECT * FROM custom_commands ORDER BY name ASC").all();
      return rows.map(toCommand);
    },

    /**
     * Add or replace a custom command by name.
     * @returns the stored command.
     * @throws when name is invalid or does not match DSH's command-name grammar.
     */
    addCommand({ name, description = "", instruction }) {
      const cmdName = String(name ?? "").trim();
      if (!COMMAND_NAME.test(cmdName)) {
        throw new Error(`invalid command name "${cmdName}": must match /^[a-z][a-z0-9_-]*$/`);
      }
      if (typeof instruction !== "string" || !instruction.trim()) {
        throw new Error("command instruction must be a non-empty string");
      }
      const now = new Date().toISOString();
      const existing = db.prepare("SELECT id FROM custom_commands WHERE name = ?").get(cmdName);
      if (existing) {
        db.prepare(
          "UPDATE custom_commands SET description = ?, instruction = ?, updated_at = ? WHERE id = ?"
        ).run(String(description ?? ""), instruction, now, existing.id);
        return toCommand(db.prepare("SELECT * FROM custom_commands WHERE id = ?").get(existing.id));
      }
      const id = randomUUID();
      db.prepare(
        `INSERT INTO custom_commands (id, name, description, instruction, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, cmdName, String(description ?? ""), instruction, now, now);
      return toCommand(db.prepare("SELECT * FROM custom_commands WHERE id = ?").get(id));
    },

    /** Remove a custom command by id; returns true when removed. */
    removeCommand(id) {
      const result = db.prepare("DELETE FROM custom_commands WHERE id = ?").run(id);
      return result.changes > 0;
    },

    /** Vector-search provider config (OpenAI-compatible embeddings endpoint). */
    getVectorConfig() {
      const raw = getSetting("vector");
      if (!raw) return undefined;
      try {
        const cfg = JSON.parse(raw);
        return typeof cfg === "object" && cfg !== null ? cfg : undefined;
      } catch {
        return undefined;
      }
    },
    setVectorConfig({ enabled, baseUrl, apiKey, model }) {
      const cfg = {
        enabled: enabled === true || enabled === 1,
        baseUrl: String(baseUrl ?? "").trim().replace(/\/+$/, ""),
        apiKey: String(apiKey ?? "").trim(),
        model: String(model ?? "").trim()
      };
      setSetting("vector", JSON.stringify(cfg));
      return cfg;
    },

    /**
     * Standalone external API settings (kv "external_api"): {enabled, port,
     * token}. The Bearer token is auto-generated on first boot and persisted
     * here. Partial writes preserve the keys they don't mention.
     */
    getExternalApi() {
      const raw = getSetting("external_api");
      if (!raw) return undefined;
      try {
        const cfg = JSON.parse(raw);
        return typeof cfg === "object" && cfg !== null ? cfg : undefined;
      } catch {
        return undefined;
      }
    },
    setExternalApi(patch = {}) {
      const prev = this.getExternalApi() ?? {};
      const port = Number(patch.port ?? prev.port);
      const host = typeof patch.host === "string" && patch.host.trim() ? patch.host.trim() : (prev.host ?? "127.0.0.1");
      const cfg = {
        enabled: patch.enabled !== undefined ? patch.enabled === true : prev.enabled === true,
        port: Number.isInteger(port) && port > 0 ? port : 8790,
        host,
        token: String(patch.token ?? prev.token ?? "")
      };
      setSetting("external_api", JSON.stringify(cfg));
      return cfg;
    },

    /**
     * Web panel mode (kv "panel_mode"): "light" (low-resource preset) or
     * "standard" (full feature set). Unset reads as "standard".
     */
    getPanelMode() {
      return getSetting("panel_mode") === "light" ? "light" : "standard";
    },
    setPanelMode(mode) {
      setSetting("panel_mode", mode === "light" ? "light" : "standard");
    },

    /**
     * Feature flags（kv "feature_flags"）：面板对后端能力的显式覆盖。读取只
     * 返回白名单内的合法键（默认 {}），写入是逐键校验后的合并持久化。
     */
    getFeatureFlags() {
      const raw = getSetting("feature_flags");
      if (!raw) return {};
      try {
        return sanitizeFlags(JSON.parse(raw));
      } catch {
        return {};
      }
    },
    setFeatureFlags(patch) {
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        throw new TypeError("feature flags patch must be a plain object");
      }
      const merged = this.getFeatureFlags();
      for (const [key, value] of Object.entries(patch)) {
        merged[key] = validateFlag(key, value);
      }
      setSetting("feature_flags", JSON.stringify(merged));
      return merged;
    }
  };
}
