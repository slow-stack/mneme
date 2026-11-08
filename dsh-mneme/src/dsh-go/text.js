// Labels, flag metadata and small formatting helpers shared by the panel pages.
export const TYPE_LABELS = {
  preference: "偏好",
  project: "项目",
  decision: "决策",
  history: "历史",
  rejected_solution: "弃用方案",
  pitfall: "教训",
  constraint: "约束",
  summary: "摘要",
  document: "文档",
  fact: "事实",
  pattern: "模式",
};

// 编辑器只提供常用的几类（写库层接受更多，但新建表单不必铺满）。
export const TYPE_OPTIONS = [
  "preference",
  "project",
  "decision",
  "constraint",
  "pitfall",
  "history",
  "rejected_solution",
  "summary",
];

// 筛选要覆盖写库层接受的全部类型（store.TYPES 的 10 个）：只给 8 个的话，
// 库里已有的 pattern / document 条目在面板上筛不出来（评审 #11）。
export const FILTER_TYPE_OPTIONS = [
  "preference",
  "project",
  "decision",
  "history",
  "summary",
  "pattern",
  "rejected_solution",
  "pitfall",
  "constraint",
  "document",
];

const TYPE_TONES = {
  preference: "info",
  decision: "good",
  constraint: "warn",
  pitfall: "bad",
  project: "info",
  history: "muted",
};

const TYPE_ICONS = {
  preference: "star",
  project: "folder",
  decision: "check",
  constraint: "flag",
  pitfall: "warning",
  history: "clock",
  rejected_solution: "remove",
  summary: "note",
  document: "book",
  fact: "pin",
  pattern: "repeat",
};

// Entity types come from extraction, so this is a best-effort mapping with a
// neutral fallback rather than a closed enum.
const ENTITY_ICONS = {
  person: "user",
  people: "user",
  agent: "robot",
  project: "folder",
  workspace: "workspace",
  repo: "code",
  technology: "code",
  tech: "code",
  tool: "wrench",
  library: "puzzle",
  concept: "lightbulb",
  topic: "note",
  event: "calendar",
  place: "globe",
  location: "globe",
  organization: "team",
  org: "team",
  team: "team",
  document: "book",
};

// Entity types are free-form (the extractor invents them), so unknown ones fall
// back to what the store returned instead of being hidden.
const ENTITY_TYPE_LABELS = {
  person: "人物",
  people: "人物",
  agent: "智能体",
  project: "项目",
  workspace: "工作区",
  repo: "仓库",
  technology: "技术",
  tech: "技术",
  tool: "工具",
  library: "库",
  concept: "概念",
  topic: "主题",
  event: "事件",
  place: "地点",
  location: "地点",
  organization: "组织",
  org: "组织",
  team: "团队",
  document: "文档",
};

export const entityIcon = (type) => ENTITY_ICONS[String(type ?? "").toLowerCase()] ?? "link";
export const entityTypeLabel = (type) => ENTITY_TYPE_LABELS[String(type ?? "").toLowerCase()] ?? String(type ?? "实体");

export const typeLabel = (type) => TYPE_LABELS[type] ?? String(type ?? "其它");
export const typeTone = (type) => TYPE_TONES[type];
export const typeIcon = (type) => TYPE_ICONS[type];

const TIME = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function fmtTime(iso) {
  if (typeof iso !== "string" || iso === "") return "—";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "—";
  return TIME.format(when);
}

export function clip(text, max) {
  const str = typeof text === "string" ? text : String(text ?? "");
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1)}…`;
}

export function splitTags(value) {
  if (typeof value !== "string") return [];
  return value
    .split(/[,，]/u)
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

export function joinTags(tags) {
  return Array.isArray(tags) ? tags.join(", ") : "";
}

/** Error text short enough for a 32 KiB panel payload. */
export function errorText(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return clip(raw, 600);
}

/** True for a dotted flag key, used as a nested `data.flags.*` binding path. */
export const flagPath = (key) => `data.flags.${key}`;

/** One action id per switch: the app only tells us which action fired. */
export const flagAction = (key) => `flag.${key.replace(/[^A-Za-z0-9_-]/gu, "_")}`;

// Mirrors mneme's own settings page grouping (lib/client.js FEATURE_GROUPS),
// trimmed to the switches this panel can flip on a phone.
export const FLAG_GROUPS = [
  {
    key: "basic",
    label: "常用",
    note: "先动这几个总开关。",
    items: [
      ["autoInject", "每轮自动带上相关记忆"],
      ["autoSummarize", "对话结束自动提炼成记忆"],
      ["autoDream", "后台自动合并、去重"],
    ],
  },
  {
    key: "record",
    label: "记录",
    note: "它记住什么、写多细。",
    items: [
      ["hotMemoryEnabled", "带上最近几轮原话"],
      ["injectTimePrefix", "注入当天日期"],
      ["injectGuidanceEnabled", "教 Agent 怎么用记忆"],
      ["continuityRescueEnabled", "压缩前先存快照"],
      ["memoryQualityFilter.enabled", "滤掉低质量条目"],
      ["sensitiveScanEnabled", "写入前扫描敏感内容"],
      ["documentMemoryEnabled", "长文档只存摘要卡"],
      ["profileFactsEnabled", "自动维护「Agent 眼中的你」"],
      ["codingRetrospect", "编码过程也沉淀"],
      ["distillRecords.enabled", "保留蒸馏原文"],
    ],
  },
  {
    key: "write",
    label: "写入",
    note: "它什么时候主动写。",
    items: [
      ["entityExtractionEnabled", "抽取人物与项目"],
      ["writeAdmission.enabled", "写入准入判定"],
      ["writeAdmission.enforce", "准入不通过就拦下"],
      ["preInjectGate.enabled", "注入前判定"],
      ["preInjectGate.enforce", "判定不通过就不注入"],
      ["profileExtractEnabled", "画像提取草稿"],
    ],
  },
  {
    key: "workflow",
    label: "工作流",
    note: "后台整理与人格。",
    items: [
      ["sleepModeEnabled", "空闲时整理记忆"],
      ["actionPipelineEnabled", "M.O. 动作图谱"],
      ["actionNudgeEnabled", "自动沉淀工作流"],
      ["personaEnabled", "注入人格卡"],
      ["personaStrictAddressing", "严格人格寻址"],
      ["llmAudit.enabled", "记录后台模型用量"],
      ["rerankEnabled", "召回结果精排"],
      ["chorographyEnabled", "代码库地志（chorography）"],
    ],
  },
  {
    key: "retrieval",
    label: "检索",
    note: "它怎么把记忆找回来。",
    items: [
      ["hybridInject", "关键词 + 语义两路"],
      ["selectiveInjectEnabled", "选择性注入"],
      ["adaptiveThresholdEnabled", "自适应阈值"],
      ["bm25SearchEnabled", "BM25 检索"],
      ["searchSemanticDedup", "语义去重"],
      ["heatEnabled", "热度衰减"],
      ["conflictFreezeEnabled", "矛盾记忆先冻结"],
      ["trustEpistemicWeighting", "可信度加权"],
      ["reflectionUpdateEnabled", "反思式更新"],
    ],
  },
  {
    key: "scope",
    label: "作用域",
    note: "不同会话之间怎么隔离。",
    items: [
      ["scopeEnabled", "按会话作用域标注"],
      ["strictScope", "严格按作用域过滤"],
      ["scopeState.enabled", "作用域级暂停"],
      ["scopeState.enforce", "暂停后真的不注入"],
    ],
  },
  {
    key: "extra",
    label: "其它",
    // 上游不断加开关：这里按 /features 的 effective 动态列出「我们还没给中文名」
    // 的布尔项，避免新功能在手机面板上静默消失（视图结构不能靠数据分支，所以
    // 用 list + 数据行，点一行翻转一项）。
    note: "上游新增的开关，面板还没有中文名；点一行即可切换。",
    items: [],
  },
];

// 枚举型旗标（不是开关，得用下拉）：PUT /features 认字符串值。
export const ENUM_FLAGS = [
  {
    key: "chorographyInject",
    label: "地志注入档位",
    hint: "每轮往系统提示里塞多少代码库提纲：轻量只放前 6 个模块，完整放全部，关闭则一轮都不放。",
    options: [
      { label: "轻量", value: "light" },
      { label: "完整", value: "full" },
      { label: "关闭", value: "off" },
    ],
  },
];

export const FLAG_LABELS = new Map();
for (const group of FLAG_GROUPS) {
  for (const [key, label] of group.items) FLAG_LABELS.set(key, label);
}
for (const flag of ENUM_FLAGS) FLAG_LABELS.set(flag.key, flag.label);

export const MODE_OPTIONS = [
  { label: "标准", value: "standard" },
  { label: "轻量", value: "light" },
];

// ---- memory list filters (mirrors mneme's own filter bar) -------------------
export const RANGE_OPTIONS = [
  { label: "全部时间", value: "all" },
  { label: "近 7 天", value: "7d" },
  { label: "近 30 天", value: "30d" },
  { label: "近 90 天", value: "90d" },
];

export const MINIMP_OPTIONS = [
  { label: "不限重要度", value: "0" },
  { label: "★3 以上", value: "3" },
  { label: "★4 以上", value: "4" },
  { label: "仅 ★5", value: "5" },
];

export const SCOPE_OPTIONS = [
  { label: "全部来源", value: "all" },
  { label: "仅已沉淀", value: "deposited" },
  { label: "仅已归档", value: "archived" },
  { label: "仅外部导入", value: "foreign" },
];

export const VIEW_OPTIONS = [
  { label: "平铺", value: "flat" },
  { label: "按月", value: "month" },
];

export const RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90 };

const MONTH = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" });
const DAY = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" });

/** `2026-11` group label for the month view. */
export function fmtMonth(iso) {
  if (typeof iso !== "string" || iso === "") return "未知时间";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "未知时间";
  return MONTH.format(when).replace(/\//gu, "-");
}

/** `07-12` for charts. */
export function fmtDay(iso) {
  if (typeof iso !== "string" || iso === "") return "—";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "—";
  return DAY.format(when);
}

/** 归属 line for a memory row (agent/workspace scope). */
export function scopeText(memo) {
  const parts = [];
  if (typeof memo?.agent_scope === "string" && memo.agent_scope !== "") parts.push(`Agent ${memo.agent_scope}`);
  if (typeof memo?.workspace_scope === "string" && memo.workspace_scope !== "")
    parts.push(`工作区 ${memo.workspace_scope}`);
  return parts.length === 0 ? "全局" : parts.join(" · ");
}
