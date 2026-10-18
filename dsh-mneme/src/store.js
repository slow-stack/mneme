import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { contentHashOf } from "./content-hash.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',
  importance  INTEGER NOT NULL DEFAULT 3,
  forgotten   INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  -- Issue #275 第二批：归档时刻的精确列。archived 是标志位，updated_at 只是
  -- 「最后一次写」——对已归档行做一次 update 就会刷它，代理口径因此高估归档
  -- 净增速率。本列只在「从活跃面进入归档面」那一次落值，取消归档置 NULL。
  archived_at TEXT,
  source      TEXT,
  content_history TEXT,
  content_hash TEXT,
  embedding   TEXT,
  epistemic_status TEXT NOT NULL DEFAULT 'subjective',
  last_accessed_at  TEXT,
  _full_content     TEXT,
  evidence    TEXT,
  doc_path    TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
-- Issue #202：all()/list() 按 updated_at 排序，无索引时走临时 B 树全表排序
-- （5k 行实测 all() 231ms → 135ms）。IF NOT EXISTS 幂等，存量库启动即建。
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);

-- autoDream audit trail: one row per consolidation run, capturing the exact
-- input snapshot digest + the LLM decision list + per-id outcome + a compact
-- receipt. This makes every decision replayable so silent consolidation errors
-- (high pass rate but wrong merge/conflict) can be located after the fact.
CREATE TABLE IF NOT EXISTS dream_runs (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  status         TEXT NOT NULL,          -- ok | noop | degraded | reconcile | failed
  error          TEXT,
  provider       TEXT,
  model          TEXT,
  snapshot_hash  TEXT NOT NULL,
  input_count    INTEGER NOT NULL,
  input          TEXT,                   -- JSON: full input snapshot (id/type/title/content/importance/updated_at)
  decisions      TEXT,                   -- JSON: raw LLM decision list
  outcome        TEXT,                   -- JSON: { byId: {id: action} }
  applied        INTEGER NOT NULL DEFAULT 0,
  summary_stored INTEGER NOT NULL DEFAULT 0,
  receipt        TEXT NOT NULL,
  policy_epoch   INTEGER NOT NULL DEFAULT 0,  -- 裁决规则版本：规则升级后旧裁决降级为历史证据
  run_type       TEXT NOT NULL DEFAULT 'auto', -- auto | sleep | organize：周期审计的类别区分
  skipped        TEXT,                    -- JSON: degraded 轮被跳过的逐条明细（index/action/ids/error）
  -- Issue #89（基线半边）：本轮成功刷新后的活跃记忆「条数 / 正文字符数」——阈值判定的
  -- 基线原本只活在调度器闭包内存里，进程重启归零 → 库里记忆多于阈值时，重启后第一条
  -- 写入就绕过阈值开跑整轮（#291 只持久化了 lastRunAt 那半边）。成功轮才落这两列，
  -- 失败/降级不推进基线的既有语义不变；两列同时有值或同时为 NULL。
  store_count    INTEGER,
  store_chars    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dream_runs_created ON dream_runs(created_at);

-- recall_runs: recall-layer receipt. One row per retrieval scene — the query,
-- mode, top-k, threshold and the exact candidate list (id/title/content/score/
-- source) that was returned — so retrieval behavior can be audited and
-- replayed after the fact. Sibling of the dream judgment-layer audit trail.
CREATE TABLE IF NOT EXISTS recall_runs (
  id          TEXT PRIMARY KEY,
  query       TEXT NOT NULL,
  mode        TEXT NOT NULL,
  top_k       INTEGER,
  threshold   REAL,
  candidates  TEXT NOT NULL,   -- JSON: 召回候选数组（含 id/title/content/score/source）
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recall_runs_created ON recall_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_recall_runs_query ON recall_runs(query);

-- recall_evals: retrieval evaluation/test snapshots, kept SEPARATE from the
-- recall_runs production audit so test runs never inflate the production trail.
-- One row per evaluateRetrieval call that opted into persistence
-- (config.evalPersistTestResults): the query, the expected ids the operator
-- marked relevant, the actual ids retrieval returned, and the computed
-- metrics (precision/recall/mrr). recall_run_id optionally links to the
-- recall_runs audit row that captured the same retrieval scene (null when the
-- eval did not also record a run). Bookkeeping like the other audit tables: it
-- never triggers write hooks.
CREATE TABLE IF NOT EXISTS recall_evals (
  id            TEXT PRIMARY KEY,
  recall_run_id TEXT,                -- FK → recall_runs.id (optional linkage)
  query         TEXT NOT NULL,
  expected_ids  TEXT NOT NULL,       -- JSON: relevant ids expected by the evaluator
  actual_ids    TEXT NOT NULL,       -- JSON: ids actually retrieved
  metrics       TEXT NOT NULL,       -- JSON: { precision, recall, mrr, hit_count }
  eval_type     TEXT NOT NULL DEFAULT 'manual',
  created_at    TEXT NOT NULL,
  FOREIGN KEY (recall_run_id) REFERENCES recall_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_recall_evals_created ON recall_evals(created_at);
CREATE INDEX IF NOT EXISTS idx_recall_evals_run ON recall_evals(recall_run_id);

-- failure_memories: records user corrections / reflection failures. Captures
-- what a memory was (actual) vs what the user changed it to (expected)
-- so later reflection passes can mine recurring correction patterns.
-- before holds a JSON snapshot of the pre-change title/content/importance,
-- so a title-only or importance-only correction is still traceable.
CREATE TABLE IF NOT EXISTS failure_memories (
  id           TEXT PRIMARY KEY,
  query        TEXT,
  expected     TEXT,
  actual       TEXT,
  before       TEXT,
  failure_type TEXT NOT NULL,
  memory_id    TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_failure_memories_created ON failure_memories(created_at);
CREATE INDEX IF NOT EXISTS idx_failure_memories_type ON failure_memories(failure_type);

-- receipt_chain: per-record receipt chain. One row per mutable verdict
-- (merge/conflict/update), carrying the input digest (the basis of the
-- decision, content-addressed) and the idempotency check counters
-- count_before → count_after. Replaying the same decision must reproduce the
-- same result; a digest match with a divergent outcome pinpoints drift to the
-- specific record/run. Sibling of the run-level dream audit trail.
CREATE TABLE IF NOT EXISTS receipt_chain (
  receipt_id   TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  record_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,         -- merge | conflict | update
  input_digest TEXT NOT NULL,
  winner_id    TEXT,
  loser_id     TEXT,
  keep_source  TEXT,
  sources      TEXT,                  -- JSON: merge 全部参与 id 数组
  verdict      TEXT NOT NULL,         -- live | revoked | historical
  count_before INTEGER NOT NULL,
  count_after  INTEGER NOT NULL,
  policy_epoch INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipt_chain_record ON receipt_chain(record_id);
CREATE INDEX IF NOT EXISTS idx_receipt_chain_run ON receipt_chain(run_id);

-- conflict_pending: conflicts parked for manual review (conflict freeze mode,
-- opt-in via config.conflictFreezeEnabled). When enabled, the dream layer does
-- NOT auto-adjudicate winner/loser — the conflicting pair is parked here until
-- a human reviews it. resolveConflictPending stamps resolved_at (plus the chosen
-- winner) so the review action stays auditable. Like the other audit tables this
-- is bookkeeping: it never triggers write hooks.
CREATE TABLE IF NOT EXISTS conflict_pending (
  id              TEXT PRIMARY KEY,
  run_id          TEXT,
  memory_a        TEXT NOT NULL,
  memory_b        TEXT NOT NULL,
  reason          TEXT,
  created_at      TEXT NOT NULL,
  resolved_at     TEXT,
  resolved_winner TEXT
);
CREATE INDEX IF NOT EXISTS idx_conflict_pending_unresolved ON conflict_pending(resolved_at);

-- scope_changes: v0.8.1 底座（issue #170）scope 归属的人工修正审计。显式声明
-- （memory_save/memory_update 的 scope 参数、面板编辑）每次改变某条记忆的
-- agent/workspace 归属都落一行：改动前后值 + 来源 + actor（tool=模型侧 /
-- panel=人工侧）。与 conflict_pending 同款的 bookkeeping 表：只做审计，
-- 不触发 write hooks。放宽可见性（label→global）的候选筛选与回放都靠它。
CREATE TABLE IF NOT EXISTS scope_changes (
  id                    TEXT PRIMARY KEY,
  memory_id             TEXT NOT NULL,
  actor                 TEXT NOT NULL,
  prev_agent_scope      TEXT,
  prev_workspace_scope  TEXT,
  next_agent_scope      TEXT,
  next_workspace_scope  TEXT,
  agent_scope_source    TEXT,
  workspace_scope_source TEXT,
  decided_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scope_changes_memory ON scope_changes(memory_id);

-- llm_audit_logs: every background LLM call (autoDream consolidation + summary,
-- autoSummarize compression) is recorded here — tokens in/out, duration, status
-- and the trigger that caused it (Bug8). Failures are captured as status='error'
-- and never block the calling feature. retentionDays is enforced by a boot-time
-- purge (deleteOldLlmAudits). Bookkeeping like the other audit tables: it never
-- triggers write hooks.
CREATE TABLE IF NOT EXISTS llm_audit_logs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp         TEXT NOT NULL,
  trigger_source    TEXT NOT NULL,          -- autoDream | autoSummarize | manual ...
  operation_type    TEXT NOT NULL,          -- dream_consolidate | dream_summarize | summarize_compress ...
  model_id          TEXT NOT NULL,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,          -- success | error | skipped
  error_message     TEXT,
  related_memory_ids TEXT,                  -- JSON: ids the call operated on
  metadata          TEXT,                   -- JSON: free-form extras
  session_key       TEXT                    -- #254 写入准入的会话键（LLM 调用行恒 NULL）
);
CREATE INDEX IF NOT EXISTS idx_llm_audit_timestamp ON llm_audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_llm_audit_source ON llm_audit_logs(trigger_source);

-- autoSummarize 的增量蒸馏游标：按 session.id 持久化最近一次成功消费的事件序。
-- 游标是蒸馏窗口的恢复事实，不与 user_settings 或记忆内容混用。
CREATE TABLE IF NOT EXISTS distill_cursors (
  session_id TEXT PRIMARY KEY,
  last_seq   INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

-- #399 蒸馏窗口的原始公开记录（凭证）。蒸馏此前只把会话压成记忆、原文随即消失，
-- 于是「这句原文没进任何记忆」永远不可测——留存一份原始副本，蒸馏就从「替换」
-- 降级成「叠加索引」（arXiv 2609.36059 §3 Eq.1：与原文并存的旁路索引不丢信息）。
-- 主键 (session_id, seq) 承担幂等：额度耗尽 / 宿主重启后会重跑同一 seq 窗口
-- （summarize.js 的 max-runs 门刻意不消费游标），重跑必须不产生重复记录。
-- 落盘文本不受 distillMaxChars / trim() 三刀约束——留存的意义就是整段原文。
-- 刻意不加 sensitivity 列：机密级是**记忆级**判断，写记录那一刻它还不存在
-- （一个窗口里什么都有），加了就是往 schema 里写一个做不到的承诺。
CREATE TABLE IF NOT EXISTS distill_records (
  session_id   TEXT    NOT NULL,
  seq          INTEGER NOT NULL,
  role         TEXT    NOT NULL,   -- user | assistant | agent（lang.js 的三种公开形态）
  text         TEXT    NOT NULL,   -- 未截断的公开正文
  window_id    TEXT,
  distilled_at TEXT    NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_distill_records_window ON distill_records(window_id);
-- 到期裁剪按 distilled_at 扫（与 llm_audit_logs.timestamp 同一口径）。
CREATE INDEX IF NOT EXISTS idx_distill_records_distilled_at ON distill_records(distilled_at);

-- #399 记忆级溯源：一条记忆由哪个蒸馏窗口的哪个 seq 区间派生。归因用**区间**而非
-- 逐事件外键——蒸馏窗口本身就是连续 seq 段，窗口级归因第一步够用。
-- 删除语义：到期裁剪只删 distill_records，本表保留并指向空区间（面板/CLI 显示
-- 「来源已过期」），绝不级联删记忆；删记忆只清链接、记录保留——一个窗口的凭证
-- 不该因删掉其中一条派生记忆而消失。
-- memory_id 是 TEXT 而非 issue 草稿里的 INTEGER：memories.id 是 TEXT 主键，
-- 类型必须与父表一致（否则 join 恒空）。
-- ON DELETE CASCADE 在本库**不生效**——store.js 从不打开 PRAGMA foreign_keys，
-- 全库唯一那条 REFERENCES 也一直是惰性的。与其为一个新表翻转全局 pragma
-- （会同时改变既有 recall_events 的写入行为），不如在 remove() 里显式清链接：
-- 语义相同、影响面只在本表。见 remove() 的注释。
CREATE TABLE IF NOT EXISTS memory_provenance (
  memory_id  TEXT    NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  session_id TEXT    NOT NULL,
  seq_start  INTEGER NOT NULL,
  seq_end    INTEGER NOT NULL,
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_provenance_memory ON memory_provenance(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_provenance_session ON memory_provenance(session_id);
-- issue 草稿没有唯一约束，但重跑同一窗口会重复插同一链接（幂等测试锁 1 会挂）。
-- 同一 (记忆, 会话, 区间) 只有一条事实，用唯一索引 + ON CONFLICT DO NOTHING 表达。
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_provenance_link
  ON memory_provenance(memory_id, session_id, seq_start, seq_end);

-- entity gene (v0.3.0): named entities mentioned across memories, with
-- time-boxed attributes (valid_from → valid_until) and typed relations.
-- Attributes follow the snapshot style: saveAttr invalidates the previous
-- value for the same entity+key before inserting a new row, so the current
-- value is always the row with valid_until IS NULL.
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  mention_count INTEGER DEFAULT 1,
  canonical_memory_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);

CREATE TABLE IF NOT EXISTS entity_attrs (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  attr_key TEXT NOT NULL,
  attr_value TEXT NOT NULL,
  memory_id TEXT,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  confidence REAL DEFAULT 1.0,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_attrs_entity ON entity_attrs(entity_id);
CREATE INDEX IF NOT EXISTS idx_attrs_key ON entity_attrs(attr_key);
CREATE INDEX IF NOT EXISTS idx_attrs_valid ON entity_attrs(valid_from, valid_until);
CREATE INDEX IF NOT EXISTS idx_attrs_memory ON entity_attrs(memory_id);

CREATE TABLE IF NOT EXISTS entity_relations (
  id TEXT PRIMARY KEY,
  from_entity TEXT NOT NULL,
  to_entity TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  memory_id TEXT,
  created_at TEXT NOT NULL,
  metadata TEXT,
  -- issue #24 块2（权重演化）：边权重 + 建边来源。初值按 source 映射
  -- （manual 1.0 / confirmed 保持 / tag 0.3 / llm 0.4），演化只经
  -- bumpRelationWeight（只加不减、封顶），触达侧由 touch 门控驱动。
  weight REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL DEFAULT 'manual'
);
CREATE INDEX IF NOT EXISTS idx_relations_from ON entity_relations(from_entity);
CREATE INDEX IF NOT EXISTS idx_relations_to ON entity_relations(to_entity);
CREATE INDEX IF NOT EXISTS idx_relations_type ON entity_relations(relation_type);
-- Issue #219：图召回轴按 memory_id 反查关系行，无索引时退化为全表扫描。
CREATE INDEX IF NOT EXISTS idx_relations_memory ON entity_relations(memory_id);

-- mirror 渲染状态 (F-NEW-03): 单行持久记录 mirror 同步失败/成功状态，使
-- syncMirror 失败不再只靠瞬时 console.warn —— dirty=1 提示镜像脏了需重渲染，
-- last_error/last_attempt 记录失败原因与最近尝试，success_at 记录最近成功。
-- 上层可据此在启动时重试、提供人工 reconcile 入口与健康状态查询。
-- v0.3.6: 新增 generation/applied_generation/type_status —— desired-applied
-- 建模镜像债务：generation 是期望同步轮次，applied_generation 是已成功应用
-- 轮次（成功清 dirty 必须 CAS/fence 到具体轮次，旧 worker 不能清新故障），
-- type_status 逐 type 记录部分成功状态。旧库经 PRAGMA table_info 检查后
-- ALTER 补列，幂等且不丢数据。
CREATE TABLE IF NOT EXISTS mirror_state (
  id TEXT PRIMARY KEY,               -- 单一状态行（用 'main'）
  dirty INTEGER NOT NULL DEFAULT 0,  -- 1=镜像脏了需重渲染
  last_error TEXT,                   -- 最近失败原因
  last_attempt TEXT,                 -- 最近尝试时间（ISO）
  success_at TEXT,                   -- 最近成功时间（ISO）
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0 AND generation <= 9007199254740991 AND generation = CAST(generation AS INTEGER)),         -- 期望的同步轮次（desired）
  applied_generation INTEGER NOT NULL DEFAULT 0 CHECK (applied_generation >= 0 AND applied_generation <= 9007199254740991 AND applied_generation = CAST(applied_generation AS INTEGER)), -- 已成功应用的轮次
  type_status TEXT                               -- JSON: 逐 type 状态 {type: {dirty, applied_gen, last_error}}
);

-- #249 N3（压缩边缘双落点）：连续性提案。压缩边缘只落**提案**行，不进 memories
-- ——边缘产出若直接进记忆库，一个长会话就会攒出第 N 条同主题条目，正是 #275 记的
-- 失败形态；转正通道与 #254 的二次确认共用一套，阶段二才打开，本批只写 pending。
-- 唯一键 (session_id, kind) 就是形态约定里的「同一会话同一类只留一条」：再次触发
-- 是刷新同一行，不是新增一行。status 为转正通道预留（pending → promoted/discarded）：
-- 「实际触发率」= 提案行数、「采纳率」= promoted/总数，都能就地统计（#249 §8）。
-- 时间戳是 ISO（与 memories 同款），created_at 在刷新时不动，updated_at 记最近边缘。
CREATE TABLE IF NOT EXISTS continuity_proposals (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  kind           TEXT NOT NULL,
  current_work   TEXT,
  next_step      TEXT,
  open_questions TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  edge_seq       INTEGER,            -- 触发本次刷新的压缩事件 seq（证据/复现用）
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_continuity_session_kind ON continuity_proposals(session_id, kind);
CREATE INDEX IF NOT EXISTS idx_continuity_status ON continuity_proposals(status, updated_at);
`;

// Exported for API-layer type validation (standalone API POST /memories and
// the /status byType breakdown); the set itself stays the single source of
// truth for what store.save accepts.
export const TYPES = new Set(["preference", "project", "decision", "history", "summary", "pattern", "rejected_solution", "pitfall", "constraint",
  // #230：agent 产长文档的指针行（摘要 + doc_path + evidence）。铸造口唯一
  // （registerDocument）——saveWithDedupe/updateMemory 另有守卫拒绝旁路铸造。
  "document"]);

// #249 N3：连续性提案的 pending 队列上限。「队列满则弃新」是形态约定的一半——满时丢
// 掉本次触发，**不是**淘汰旧行：旧行是别的会话还没转正的活状态，用"更近的边缘"把它挤
// 掉，等于让长会话的噪音吃掉短会话的真实工作状态。这个数是存储侧策略，与抽取/注入的
// 截断上限（continuity.js）是两件事。
const MAX_CONTINUITY_PENDING = 200;

// Epistemic status: what kind of evidence a memory rests on. Defaults to
// 'subjective' so legacy rows (and rows without any signal) stay compatible.
const EPISTEMIC_STATUSES = new Set(["observation", "subjective", "inferred"]);
// Rule-based inference markers, checked in priority order (observation >
// inferred > subjective). The default fallback is 'subjective'.
const OBSERVATION_RE = /实测|观察到|观测|测得|测量|结果表明|数据显示|实验|统计|结果/;
const INFERRED_RE = /推断|推测出|推导|推论|由此可|据此|综上|意味着|所以|因此/;
const SUBJECTIVE_RE = /我推测|我猜|我觉得|我感觉|可能|大概|也许|认为|猜想|似乎|猜测|感觉/;

/**
 * Heuristically infer a memory's epistemic status from its content (and the
 * AI-generated types). summary/pattern entries are always 'inferred' (derived
 * from other memories); otherwise content markers decide. Pure rule-based, so
 * it never throws and always returns a value in EPISTEMIC_STATUSES.
 */
function inferEpistemicStatus(memory) {
  if (memory.type === "summary" || memory.type === "pattern") return "inferred";
  const text = `${memory.title ?? ""} ${memory.content ?? ""}`;
  if (OBSERVATION_RE.test(text)) return "observation";
  if (INFERRED_RE.test(text)) return "inferred";
  if (SUBJECTIVE_RE.test(text)) return "subjective";
  return "subjective";
}

/** Resolve a requested epistemic_status: explicit valid value wins, otherwise
 *  re-infer from (possibly updated) content. Never returns an invalid value. */
function resolveEpistemicStatus(memory, patch) {
  if (patch?.epistemic_status !== undefined) {
    return EPISTEMIC_STATUSES.has(patch.epistemic_status) ? patch.epistemic_status : "subjective";
  }
  // Re-infer whenever any signal that feeds the heuristic changed: content
  // (marker words), title (marker words), or type (summary/pattern are always
  // inferred). Otherwise keep the stored status.
  const changed = ["content", "title", "type"].some(
    (k) => patch?.[k] !== undefined && patch[k] !== memory?.[k]
  );
  if (changed) {
    return inferEpistemicStatus({ ...memory, ...patch });
  }
  return memory?.epistemic_status ?? "subjective";
}

// Per-type mirror sync receipts (peer blocker 4): a type is either committed
// (file written + fence applied), failed (last sync round errored for it), or
// pending (still owed a write).
const VALID_TYPE_STATUS = new Set(["committed", "failed", "pending"]);

// Pure helpers: no shared module state.

function sanitizePage(limit, offset, defaultLimit) {
  const lim = Number.isInteger(limit) && limit > 0 ? limit : defaultLimit;
  const off = Number.isInteger(offset) && offset > 0 ? offset : 0;
  return { limit: lim, offset: off };
}

function escapeLike(q) {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// 日期过滤参数归一化（list/count 共用，保证分页 total 与行同过滤）：接受 ISO
// 日期（"2026-09-01"）或完整时间戳，返回闭区间的 UTC ISO 边界。date-only 的
// updatedFrom 按当天 00:00:00.000Z 起、updatedTo 按当天 23:59:59.999Z 收；非
// 法值一律返回 undefined → 不进 WHERE（忽略而非报错：面板传坏参数时宁可放宽
// 过滤也不要白屏）。updated_at 列是 toISOString 产生的 UTC "Z" 字符串，字典
// 序与时间序一致，SQL 里可直接比较。
// v0.8.0 A2：导出复用——occurred_at 时间过滤（service 的搜索后置过滤）与
// updated_at 过滤共用同一套边界归一化，坏参数口径一致。
export function updatedAtBounds(updatedFrom, updatedTo) {
  const norm = (raw, endOfDay) => {
    if (typeof raw !== "string" || !raw.trim()) return undefined;
    const s = raw.trim();
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
    const ms = Date.parse(dateOnly ? `${s}T00:00:00.000Z` : s);
    if (Number.isNaN(ms)) return undefined;
    if (dateOnly && endOfDay) return `${s}T23:59:59.999Z`;
    return new Date(ms).toISOString();
  };
  return { from: norm(updatedFrom, false), to: norm(updatedTo, true) };
}

function parseTags(raw) {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// scope 列（agent_scope/workspace_scope/sensitivity）写入归一化：非空 trim 字符串
// 原样收下，其余（undefined/null/空串/非字符串）一律 NULL。存储层不做枚举校验——
// scope 值是宿主身份标签（agentPreset id / 目录路径 / 自由 sensitivity 标签），
// 语义由调用方负责；这里只保证「脏输入落 NULL，绝不阻塞写入」。
function normalizeScopeText(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return s ? s : null;
}

// scope 来源列（issue #170 底座）：'auto'=载体自动标注，'explicit'=显式声明。
// 只认这两个枚举值，其余（含 NULL）落 NULL——NULL 语义是「未标注，或 0.8.1
// 之前落库的存量标注（视为 auto 的软效力，第 3 步语义收窄时按此口径读）」。
function normalizeScopeSource(raw) {
  return raw === "auto" || raw === "explicit" ? raw : null;
}

// occurred_at：事件发生时间（区别于 created_at 的入库时间）。可解析的时间戳
// 统一归一到 UTC ISO（A2 的时间过滤要按字典序直接比较）；解析失败落 NULL，
// 同样不阻塞写入。
function normalizeOccurredAt(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const ms = Date.parse(raw.trim());
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

function toRow(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.content,
    content_hash: row.content_hash ?? undefined,
    tags: parseTags(row.tags),
    importance: row.importance,
    forgotten: row.forgotten === 1,
    archived: row.archived === 1,
    // Issue #275 第二批：NULL（存量归档行、或落地前的历史数据）读作 undefined，
    // 与 sensitivity/occurred_at 同款——调用方必须显式处理「时刻不可知」，不能
    // 顺手 `?? updated_at` 把代理口径捡回来。
    archived_at: row.archived_at ?? undefined,
    source: row.source ?? undefined,
    content_history: parseJsonArray(row.content_history),
    evidence: parseJsonArray(row.evidence),
    doc_path: row.doc_path ?? undefined,
    quality_score: row.quality_score !== null && row.quality_score !== undefined ? Number(row.quality_score) : undefined,
    epistemic_status: row.epistemic_status ?? "subjective",
    agent_scope: row.agent_scope ?? undefined,
    workspace_scope: row.workspace_scope ?? undefined,
    agent_scope_source: row.agent_scope_source ?? undefined,
    workspace_scope_source: row.workspace_scope_source ?? undefined,
    scope_decided_at: row.scope_decided_at ?? undefined,
    sensitivity: row.sensitivity ?? undefined,
    occurred_at: row.occurred_at ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_accessed_at: row.last_accessed_at ?? undefined,
    _full_content: row._full_content ?? undefined
  };
}

function toDreamRun(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    created_at: row.created_at,
    status: row.status,
    error: row.error ?? undefined,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    snapshot_hash: row.snapshot_hash,
    input_count: row.input_count,
    input: row.input ? JSON.parse(row.input) : undefined,
    decisions: row.decisions ? JSON.parse(row.decisions) : undefined,
    outcome: row.outcome ? JSON.parse(row.outcome) : undefined,
    applied: row.applied,
    summary_stored: row.summary_stored === 1,
    receipt: row.receipt,
    policy_epoch: row.policy_epoch ?? 0,
    run_type: row.run_type ?? "auto",
    // Issue #104：degraded 轮的逐条跳过明细（JSON 列，NULL = 该轮无跳过项）。
    skipped: row.skipped ? JSON.parse(row.skipped) : undefined,
    // Issue #89（基线半边）：成功轮落下的阈值基线（NULL = 该轮没有推进基线）。
    store_count: row.store_count ?? undefined,
    store_chars: row.store_chars ?? undefined
  };
}

function toReceipt(row) {
  if (!row) return undefined;
  return {
    receipt_id: row.receipt_id,
    run_id: row.run_id,
    record_id: row.record_id,
    kind: row.kind,
    input_digest: row.input_digest,
    winner_id: row.winner_id ?? undefined,
    loser_id: row.loser_id ?? undefined,
    keep_source: row.keep_source ?? undefined,
    sources: parseJsonArray(row.sources),
    verdict: row.verdict,
    count_before: row.count_before,
    count_after: row.count_after,
    policy_epoch: row.policy_epoch ?? 0,
    created_at: row.created_at
  };
}

function toConflictPending(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    run_id: row.run_id ?? undefined,
    memory_a: row.memory_a,
    memory_b: row.memory_b,
    reason: row.reason ?? undefined,
    created_at: row.created_at,
    resolved_at: row.resolved_at ?? undefined,
    resolved_winner: row.resolved_winner ?? undefined
  };
}

function toScopeChange(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    memory_id: row.memory_id,
    actor: row.actor,
    prev_agent_scope: row.prev_agent_scope ?? undefined,
    prev_workspace_scope: row.prev_workspace_scope ?? undefined,
    next_agent_scope: row.next_agent_scope ?? undefined,
    next_workspace_scope: row.next_workspace_scope ?? undefined,
    agent_scope_source: row.agent_scope_source ?? undefined,
    workspace_scope_source: row.workspace_scope_source ?? undefined,
    decided_at: row.decided_at
  };
}

function toRecallRun(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    query: row.query,
    mode: row.mode,
    topK: row.top_k,
    threshold: row.threshold,
    candidates: parseJsonArray(row.candidates),
    created_at: row.created_at
  };
}

// issue #24 块2：建边来源 → 初值权重映射。tag 延续 LLM 偏差取低起步，
// llm 抽取自动建边取中低，manual 全权（1.0 是满权，不含演化余量的上限）。
export const RELATION_SOURCE_DEFAULTS = Object.freeze({
  manual: 1.0,
  confirmed: 1.0, // manual_confirmed：已人工确认，维持满权
  tag: 0.3,
  llm: 0.4
});

function toRecallEval(row) {
  if (!row) return undefined;
  let metrics;
  if (row.metrics != null) {
    try { metrics = JSON.parse(row.metrics); } catch { metrics = undefined; }
  }
  return {
    id: row.id,
    recall_run_id: row.recall_run_id ?? undefined,
    query: row.query,
    expected_ids: parseJsonArray(row.expected_ids),
    actual_ids: parseJsonArray(row.actual_ids),
    metrics,
    eval_type: row.eval_type,
    created_at: row.created_at
  };
}

function toEntity(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    type: row.type ?? undefined,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    mention_count: row.mention_count,
    canonical_memory_id: row.canonical_memory_id ?? undefined
  };
}

function toAttr(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    entity_id: row.entity_id,
    attr_key: row.attr_key,
    attr_value: row.attr_value,
    memory_id: row.memory_id ?? undefined,
    valid_from: row.valid_from,
    valid_until: row.valid_until ?? undefined,
    confidence: row.confidence,
    source: row.source ?? undefined
  };
}

function toRelation(row) {
  if (!row) return undefined;
  let metadata;
  if (row.metadata != null) {
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      metadata = row.metadata;
    }
  }
  return {
    id: row.id,
    from_entity: row.from_entity,
    to_entity: row.to_entity,
    relation_type: row.relation_type,
    memory_id: row.memory_id ?? undefined,
    created_at: row.created_at,
    weight: row.weight ?? 1.0,
    source: row.source ?? "manual",
    metadata
  };
}

function toLlmAudit(row) {
  if (!row) return undefined;
  let metadata;
  if (row.metadata != null) {
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      metadata = row.metadata;
    }
  }
  return {
    id: row.id,
    timestamp: row.timestamp,
    trigger_source: row.trigger_source,
    operation_type: row.operation_type,
    model_id: row.model_id,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    total_tokens: row.total_tokens,
    cost_usd: row.cost_usd,
    duration_ms: row.duration_ms,
    status: row.status,
    error_message: row.error_message ?? undefined,
    related_memory_ids: parseJsonArray(row.related_memory_ids),
    metadata,
    // #254 写入准入的会话键；LLM 调用行恒 NULL。
    session_key: row.session_key ?? undefined
  };
}

function toMirrorState(row) {
  if (!row) {
    return {
      dirty: false,
      last_error: null,
      last_attempt: null,
      success_at: null,
      generation: 0,
      applied_generation: 0,
      type_status: {}
    };
  }
  let typeStatus = {};
  if (row.type_status) {
    try {
      typeStatus = JSON.parse(row.type_status) || {};
    } catch {
      typeStatus = {};
    }
  }
  return {
    id: row.id,
    dirty: row.dirty === 1,
    last_error: row.last_error,
    last_attempt: row.last_attempt,
    success_at: row.success_at,
    generation: Number(row.generation) || 0,
    applied_generation: Number(row.applied_generation) || 0,
    type_status: typeStatus
  };
}

function parseJsonArray(raw) {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function createStore(path) {
  const db = new DatabaseSync(path);
  // Set busy_timeout BEFORE the journal-mode switch (audit peer: 8-process WAL
  // init). Switching a fresh DB to WAL takes an exclusive lock; when several
  // processes open the same path simultaneously, that lock can fail with
  // SQLITE_BUSY before the timeout is armed. With the timeout installed first,
  // the WAL transition (and every later write) blocks and retries instead of
  // failing outright, so concurrent init converges to a stable 447/447.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);

  // Schema migrations for legacy databases (idempotent). Each ADD COLUMN is
  // also race-safe: two concurrently-opening processes can both pass the
  // PRAGMA table_info check before either ALTERs, so the ALTER itself is
  // guarded against the "duplicate column name" error SQLite raises when the
  // other process won the race (SQLite has no ADD COLUMN IF NOT EXISTS).
  const addColumn = (table, column, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) {
      try {
        db.exec(ddl);
      } catch (e) {
        if (!/duplicate column name/i.test(String(e?.message ?? e))) throw e;
      }
    }
  };

  addColumn("memories", "archived", "ALTER TABLE memories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  // Issue #275 第二批：归档时刻精确列。可空不带 DEFAULT——存量库的已归档行
  // 零重写，读侧 NULL = 「本列落地前归档，时刻不可追溯」。刻意不回填：用
  // updated_at 回填等于把被推翻的代理口径重新固化进列里，偏差（偏高）会从
  // 「已知的口径差」变成「看不见的脏数据」。
  addColumn("memories", "archived_at", "ALTER TABLE memories ADD COLUMN archived_at TEXT");
  addColumn("memories", "embedding", "ALTER TABLE memories ADD COLUMN embedding TEXT");
  addColumn("memories", "last_accessed_at", "ALTER TABLE memories ADD COLUMN last_accessed_at TEXT");
  addColumn("memories", "_full_content", "ALTER TABLE memories ADD COLUMN _full_content TEXT");
  // 叙述条证据链（#164 对齐）：[{memory_id, op, at}] JSON 数组——叙述/模式类
  // 记忆回链其支撑原子记忆，写入前与候选集求交防模型捏造。
  addColumn("memories", "evidence", "ALTER TABLE memories ADD COLUMN evidence TEXT");
  // #230：document 指针行的文件定位。只有 registerDocument 写它，普通行恒 NULL。
  addColumn("memories", "doc_path", "ALTER TABLE memories ADD COLUMN doc_path TEXT");
  addColumn("memories", "epistemic_status", "ALTER TABLE memories ADD COLUMN epistemic_status TEXT NOT NULL DEFAULT 'subjective'");
  addColumn("memories", "content_history", "ALTER TABLE memories ADD COLUMN content_history TEXT");
  addColumn("memories", "quality_score", "ALTER TABLE memories ADD COLUMN quality_score REAL");

  // v0.8.0 A1（issue #17）scope 隔离存储层：四列全部可空、不带 DEFAULT——存量行
  // 零重写，读侧把 NULL 视为未标注（= 全局可见）。是否落值由 scopeEnabled 门控
  // （service/tools 层），存储层只负责归一化（normalizeScopeText/normalizeOccurredAt）。
  addColumn("memories", "agent_scope", "ALTER TABLE memories ADD COLUMN agent_scope TEXT");
  addColumn("memories", "workspace_scope", "ALTER TABLE memories ADD COLUMN workspace_scope TEXT");
  addColumn("memories", "sensitivity", "ALTER TABLE memories ADD COLUMN sensitivity TEXT");
  addColumn("memories", "occurred_at", "ALTER TABLE memories ADD COLUMN occurred_at TEXT");

  // v0.8.1 底座（issue #170）：scope 标注的来源与决策时间。三列全部可空不带
  // DEFAULT（与 A1 同款零重写迁移）。来源拆成 agent/workspace 各一列而非单列
  // scope_source：混合来源（agent 维显式 + workspace 维自动）必须可表达——否则
  // 「提升回全局」之后遗留的自动 workspace 标签会在效力收窄时被一并当成显式，
  // 恰好复活 issue #170 抱怨的「自动标签吃硬过滤」问题。存量标注行三列皆 NULL，
  // 读侧按 auto（软效力）口径解释。
  addColumn("memories", "agent_scope_source", "ALTER TABLE memories ADD COLUMN agent_scope_source TEXT");
  addColumn("memories", "workspace_scope_source", "ALTER TABLE memories ADD COLUMN workspace_scope_source TEXT");
  addColumn("memories", "scope_decided_at", "ALTER TABLE memories ADD COLUMN scope_decided_at TEXT");

  // #254 计量信号：内容归一化哈希（口径与动机写在 content-hash.js 的文件头）。派生
  // 列，不参与任何判定——只给「同一内容又被写了一次」当等值锚。索引建在加列之后：
  // 老库打开时 SCHEMA 的 CREATE TABLE 对既有表不生效，列还不存在，把索引写进 SCHEMA
  // 会直接报 no such column（与下方 llm_audit_logs.session_key 同理）。
  addColumn("memories", "content_hash", "ALTER TABLE memories ADD COLUMN content_hash TEXT");
  // 每条向量的出身（行级 model hash，如 `qwen3.7-text-embedding-flash#17a6a0b1`）。
  // 为什么必须行级：vector_meta 只有一个 model_hash，它记的是「最后一次成功写入
  // 的模型」，换模型时被整表覆盖——于是上一代模型产出的向量在元数据上看起来完全
  // 合规，实际与新模型的查询向量不可比。没有这一列，「这条向量是不是当前模型产
  // 的」就无从判断（content_hash 是内容归一化哈希，与向量模型无关；dimension 在
  // 同为 1024 维的模型间也区分不出来）。
  // 存量行的值是 NULL，且**不推断**：按 updated_at 猜出的模型名会变成日后审计信
  // 以为真的证据。NULL 一律读作「出身未知」，等价的补法是重算，不是猜。
  addColumn("memories", "embedding_model", "ALTER TABLE memories ADD COLUMN embedding_model TEXT");
  // issue #24 块2（权重演化）：entity_relations 加 weight + source。存量关系
  // 行缺列 → 默认 manual 1.0（最保守：既有语义不因迁移而变弱）。
  addColumn("entity_relations", "weight", "ALTER TABLE entity_relations ADD COLUMN weight REAL NOT NULL DEFAULT 1.0");
  addColumn("entity_relations", "source", "ALTER TABLE entity_relations ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
  // 列序是 content_hash 打头：哈希几乎唯一，等值 seek 就已收窄到候选行，type 只当同
  // 一次 seek 里的第二列过滤；反过来（type 打头）下面的存量回填就得全表扫——每次打开
  // 都要把全部正文读一遍。
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash, type)");
  // 存量回填：老库（含归档区）的行都没有值，而「归档行纳入去重候选集」这条口径正是
  // 要靠既有归档行出数据。只算 NULL 行、幂等；改口径不是补 NULL 能修好的，要整列重算
  // （见 content-hash.js 的文件头）。空标题空正文的行算不出锚，跳过不写——否则每次
  // 打开都要为这些行再跑一遍 UPDATE。
  {
    const updates = db
      .prepare("SELECT id, title, content FROM memories WHERE content_hash IS NULL")
      .all()
      .map((row) => [contentHashOf(row), row.id])
      .filter(([hash]) => hash);
    if (updates.length) {
      const stmt = db.prepare("UPDATE memories SET content_hash = ? WHERE id = ? AND content_hash IS NULL");
      // 一个事务包住整批：逐条自动提交是每行一次 WAL 提交，几千行的存量库上纯属浪费。
      runAtomically(() => {
        for (const [hash, id] of updates) stmt.run(hash, id);
      });
    }
  }

  // Legacy dream_runs without policy_epoch → backfill with the default epoch.
  addColumn("dream_runs", "policy_epoch", "ALTER TABLE dream_runs ADD COLUMN policy_epoch INTEGER NOT NULL DEFAULT 0");
  addColumn("dream_runs", "run_type", "ALTER TABLE dream_runs ADD COLUMN run_type TEXT NOT NULL DEFAULT 'auto'");
  // Issue #104：degraded（合法子集已应用）轮被跳过的决策明细。此前只进 logger.warn，
  // 离线回放 dream_runs 无法定位 degraded 成因（跨类型 merge / update 保护期 / unknown id）。
  addColumn("dream_runs", "skipped", "ALTER TABLE dream_runs ADD COLUMN skipped TEXT");
  // Issue #89（基线半边）：阈值基线跨重启持久化。存量行两列皆 NULL——历史行反推不出
  // 「那轮结束时库有多大」（input_count 是窗口条数，不是库规模），所以升级后第一次
  // 成功轮之前播种端拿不到基线，行为与升级前一致；跑过一轮之后闸门即跨重启生效。
  addColumn("dream_runs", "store_count", "ALTER TABLE dream_runs ADD COLUMN store_count INTEGER");
  addColumn("dream_runs", "store_chars", "ALTER TABLE dream_runs ADD COLUMN store_chars INTEGER");

  // Legacy mirror_state without v0.3.6 generation columns → add each missing
  // column idempotently (old DBs open cleanly, no data loss).
  addColumn("mirror_state", "generation", "ALTER TABLE mirror_state ADD COLUMN generation INTEGER NOT NULL DEFAULT 0");
  addColumn("mirror_state", "applied_generation", "ALTER TABLE mirror_state ADD COLUMN applied_generation INTEGER NOT NULL DEFAULT 0");
  addColumn("mirror_state", "type_status", "ALTER TABLE mirror_state ADD COLUMN type_status TEXT");

  // #254 写入准入（第一阶段只计量）：准入决策行按会话聚合——「会话内新建了几行」
  // 与「同话题重复间隔」都靠它算出来，所以会话键必须是可等值查询的列，而不是塞在
  // metadata 里做 JSON 匹配。列可空且不带 DEFAULT（存量行零重写）。索引建在加列
  // 之后：老库打开时列还不存在（SCHEMA 的 CREATE TABLE 只对新建库生效）。
  addColumn("llm_audit_logs", "session_key", "ALTER TABLE llm_audit_logs ADD COLUMN session_key TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_llm_audit_session ON llm_audit_logs(session_key);");

  // Audit peer F: a legacy DB may hold a non-integer generation/applied_generation
  // (pre-v0.3.9 the JS gate truncated with Math.trunc and SQLite's CHECK only
  // enforced >= 0). Such a value is ambiguous — it cannot map to a real applied
  // round — so surface it as a hard error on open instead of silently reading it
  // as a coherent generation. Fail-closed: the operator must repair or reset the
  // state row rather than continue with a lie.
  for (const col of ["generation", "applied_generation"]) {
    const bad = db.prepare(
      `SELECT id FROM mirror_state WHERE ${col} IS NOT NULL AND ${col} != CAST(${col} AS INTEGER) LIMIT 1`
    ).get();
    if (bad) {
      throw new RangeError(
        `mirror_state.${col} holds a non-integer value (legacy dirty state); ` +
        `repair or reset the row before opening this database`
      );
    }
  }

  // Issue #202：embedding 解析缓存。检索路径此前每次调用都对全部带向量行
  // JSON.parse（993 × 512 维 ≈ 48 ms/次，且 SQL 拖着 10 MB 的 TEXT），余弦本身
  // 只占 3%。向量只经 setEmbedding 写入（单一失效点），把解析结果按 id 缓存，
  // 命中即零解析；上限 FIFO 驱逐防大库内存无界（4000 × 512 维 double ≈ 16 MB）。
  const embeddingCache = new Map();
  const EMBEDDING_CACHE_MAX = 4000;

  function cacheEmbedding(id, vector) {
    if (embeddingCache.size >= EMBEDDING_CACHE_MAX && !embeddingCache.has(id)) {
      const oldest = embeddingCache.keys().next().value;
      embeddingCache.delete(oldest);
    }
    embeddingCache.set(id, vector);
  }

  /** Parsed embedding for one id (cache-first); undefined when none/parse
   *  failure. Single read path shared by searchVector / getEmbedding(s). */
  function getParsedEmbedding(id) {
    const cached = embeddingCache.get(id);
    if (cached) return cached;
    const row = db.prepare("SELECT embedding FROM memories WHERE id = ?").get(id);
    if (!row?.embedding) return undefined;
    try {
      const v = JSON.parse(row.embedding);
      if (Array.isArray(v) && v.length) {
        cacheEmbedding(id, v);
        return v;
      }
    } catch { /* corrupt embedding text: treated as absent */ }
    return undefined;
  }

  // all()/list() 的显式列清单：从实际 schema 派生（迁移后），只排除 embedding
  // 列——consolidation/sleep/inject 的消费方都不读向量，而它是全表里最重的一列
  // （5k 行库 ≈ 9.4 MB TEXT），每次全表调用都白搬。经 PRAGMA 派生而非硬编码，
  // schema 演进时自动跟随。
  const memoryColumns = db.prepare("PRAGMA table_info(memories)").all()
    .map((c) => c.name)
    .filter((n) => n !== "embedding");
  const memoryColumnList = memoryColumns.join(", ");

  // Per-instance monotonic timestamp guard: consecutive writes within the same
  // millisecond must still produce strictly increasing timestamps (test asserts
  // updated_at != created_at). State lives in the store closure, not module scope.
  let lastTs = "";  function nowIso() {
    let ts = new Date().toISOString();
    if (lastTs && ts <= lastTs) {
      const d = new Date(lastTs);
      d.setMilliseconds(d.getMilliseconds() + 1);
      ts = d.toISOString();
    }
    lastTs = ts;
    return ts;
  }

  /** 返回指定会话持久化的 autoSummarize 游标；不存在时返回 undefined。 */
  function getDistillCursor(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
    const row = db.prepare(
      "SELECT session_id, last_seq, updated_at FROM distill_cursors WHERE session_id = ?"
    ).get(sessionId);
    return row
      ? { session_id: row.session_id, last_seq: Number(row.last_seq), updated_at: row.updated_at }
      : undefined;
  }

  /**
   * 单调持久化会话游标。调用方若同时写入记忆，必须放在外层 SQLite 事务内。
   */
  function setDistillCursor(sessionId, lastSeq) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("setDistillCursor: sessionId must be a non-empty string");
    }
    if (!Number.isSafeInteger(lastSeq)) {
      throw new TypeError("setDistillCursor: lastSeq must be a safe integer");
    }
    db.prepare(`
      INSERT INTO distill_cursors (session_id, last_seq, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        last_seq = MAX(distill_cursors.last_seq, excluded.last_seq),
        updated_at = excluded.updated_at
    `).run(sessionId, lastSeq, nowIso());
    return getDistillCursor(sessionId);
  }

  function count(type, { minImportance = null, source = null, includeForgotten = false, includeArchived = false, onlyArchived = false, depositedOnly = false, updatedFrom = null, updatedTo = null, occurredFrom = null, occurredTo = null, visibility = null } = {}) {
    const clauses = [];
    const params = [];
    if (type !== undefined) {
      clauses.push("type = ?");
      params.push(type);
    }
    // Same filters as list() so a paged caller's total matches its rows.
    if (minImportance != null) {
      clauses.push("importance >= ?");
      params.push(minImportance);
    }
    if (source != null) {
      clauses.push("source = ?");
      params.push(source);
    }
    // updated_at 闭区间：与 list() 共用 updatedAtBounds 归一化，非法值被忽略
    // （不进 WHERE），total 才能和行保持同过滤。
    const bounds = updatedAtBounds(updatedFrom, updatedTo);
    if (bounds.from) {
      clauses.push("updated_at >= ?");
      params.push(bounds.from);
    }
    if (bounds.to) {
      clauses.push("updated_at <= ?");
      params.push(bounds.to);
    }
    // occurred_at 闭区间：与 list() 同口径（COALESCE 回退 created_at），
    // memory_list 的 total 才能和过滤后的行保持一致。
    const occurred = updatedAtBounds(occurredFrom, occurredTo);
    if (occurred.from) {
      clauses.push("COALESCE(occurred_at, created_at) >= ?");
      params.push(occurred.from);
    }
    if (occurred.to) {
      clauses.push("COALESCE(occurred_at, created_at) <= ?");
      params.push(occurred.to);
    }
    // occurred_at 闭区间：与 list() 同过滤（visibility 同口径），memory_list
    // 的 total 才能和过滤后的行保持一致。
    if (visibility) {
      // v0.8.1 第 3 步（issue #170 4.3）：硬过滤只认显式声明——与
      // service.isVisibleInScope 同口径。IS NOT 是 NULL 安全比较：来源为
      // auto/NULL（v0.8.0 存量自动标注）的行不吃硬墙，只走 A2 软加权。
      if (visibility.agentScope != null) {
        clauses.push("(agent_scope IS NULL OR agent_scope_source IS NOT 'explicit' OR agent_scope = ?)");
        params.push(visibility.agentScope);
      } else {
        clauses.push("(agent_scope IS NULL OR agent_scope_source IS NOT 'explicit')");
      }
      if (visibility.workspaceScope != null) {
        clauses.push("(workspace_scope IS NULL OR workspace_scope_source IS NOT 'explicit' OR workspace_scope = ?)");
        params.push(visibility.workspaceScope);
      } else {
        clauses.push("(workspace_scope IS NULL OR workspace_scope_source IS NOT 'explicit')");
      }
    }
    if (!includeForgotten) {
      clauses.push("forgotten = 0");
    }
    // 与 list() 同过滤：total 才能和归档列表的行保持一致。
    if (onlyArchived) {
      clauses.push("archived = 1");
    } else if (!includeArchived) {
      clauses.push("archived = 0");
    }
    // 与 list() 同过滤：deposited 视图的 total 才能和行保持一致。
    if (depositedOnly) {
      clauses.push(
        "(id IN (SELECT record_id FROM receipt_chain WHERE kind IN ('merge', 'update') AND verdict = 'live') OR source = 'dream')"
      );
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`SELECT count(*) AS c FROM memories ${where}`).get(...params).c;
  }

  function getById(id) {
    const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    return toRow(row);
  }

  // #230 写入权分离（存储层唯一铸造口，CodeRabbit 复核最终形态）：document
  // 行只能经 saveDocument 铸造，通用 save 整类拒绝。doc_path 是任意调用方
  // 都能捏造的字符串——「必带 doc_path」挡不住绕过注册校验（flag 闸 / 文件
  // 存在 / 路径归一化 / evidence 可见性 / scope 匹配 / supersede 探测）的直
  // 铸，必须整类拒绝；受控通道是独立方法而不是隐藏旗标（旗标可被载荷携带，
  // 方法名在 DI 合同里可审计）。
  function save(memory) {
    if (memory?.type === "document") {
      throw new Error("document rows are minted only via store.saveDocument (registerDocument)");
    }
    return insertMemoryRow(memory);
  }

  function saveDocument(memory) {
    // 指针行结构不变量：doc_path 是 document 的存在依据（无指针 = 死行）。
    if (!(typeof memory?.doc_path === "string" && memory.doc_path.trim())) {
      throw new Error("document rows are pointer rows: doc_path is required");
    }
    return insertMemoryRow(memory);
  }

  function insertMemoryRow(memory) {
    const id = memory.id ?? randomUUID();
    const type = memory.type;
    if (!TYPES.has(type)) throw new Error(`invalid memory type: ${type}`);
    if (memory.tags !== undefined && !Array.isArray(memory.tags)) {
      throw new Error("tags must be an array");
    }
    const now = nowIso();
    const tags = JSON.stringify(memory.tags ?? []);
    const importance = Number.isInteger(memory.importance) ? memory.importance : 3;
    const evidence = Array.isArray(memory.evidence) ? JSON.stringify(memory.evidence) : null;
    const docPath = typeof memory.doc_path === "string" && memory.doc_path.trim() ? memory.doc_path : null;
    // #254 计量锚：由本行的 title/content 派生，调用方传什么都以这里算出的为准。
    const contentHash = contentHashOf(memory);
    const embedding = Array.isArray(memory.embedding) && memory.embedding.length
      ? JSON.stringify(memory.embedding)
      : null;
    // Explicit valid status wins; otherwise infer from content/type. Falls back
    // to 'subjective' (the column default) so legacy callers never break.
    const epistemicStatus = EPISTEMIC_STATUSES.has(memory.epistemic_status)
      ? memory.epistemic_status
      : inferEpistemicStatus(memory);
    runAtomically(() => {
      db.prepare(
        `INSERT INTO memories (id, type, title, content, tags, importance, forgotten, archived, archived_at, source, content_history, quality_score, embedding, epistemic_status, agent_scope, workspace_scope, agent_scope_source, workspace_scope_source, scope_decided_at, sensitivity, occurred_at, evidence, doc_path, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        type,
        memory.title,
        memory.content,
        tags,
        importance,
        memory.archived ? 1 : 0,
        // 铸造即归档的行（store.save({archived:true})）：归档时刻就是入库时刻。
        // 不写这一格的话，archived=1 而 archived_at=NULL 会落在「存量行」语义里，
        // 精确口径读侧只能把它当不可追溯——明明是当下发生的归档，白丢一条记录。
        memory.archived ? now : null,
        memory.source ?? null,
        JSON.stringify(memory.content_history ?? []),
        Number.isFinite(memory.quality_score) ? memory.quality_score : null,
        embedding,
        epistemicStatus,
        normalizeScopeText(memory.agent_scope),
        normalizeScopeText(memory.workspace_scope),
        normalizeScopeSource(memory.agent_scope_source),
        normalizeScopeSource(memory.workspace_scope_source),
        normalizeOccurredAt(memory.scope_decided_at),
        normalizeScopeText(memory.sensitivity),
        normalizeOccurredAt(memory.occurred_at),
        evidence,
        docPath,
        contentHash,
        now,
        now
      );
      // desired generation bumped in the same transaction as the write: once
      // this commits, generation > applied_generation, so a crash right after
      // (before syncMirror) is caught by recoverMirror on restart (peer
      // blocker 1). ROLLBACK on error rolls this back with the write.
      incrementGeneration();
    });
    return getById(id);
  }

  /**
   * #254 计量：与本次写入「归一化内容哈希」相同的既有行（去重候选集）。
   * 结构化锚先收窄成本：按哈希等值 seek（走 idx_memories_content_hash，哈希几乎唯
   * 一，落在候选集上的行只有几条），再按 type 与 scope 三维过滤——不是全表扫、也不
   * 逐行比哈希。scope 用 IS 比（NULL 安全）：未标注行互相匹配、与已标注行不匹配，
   * 与 service.js 去重键（scopeKeyOf）同口径；入参先按 store 自己的 normalizeScopeText
   * 归一，免得调用方传 " foo " 就漏配。
   * 归档行与已遗忘行都在集内：#275 的分界是「出口止体积、不止重复」——被质量闸归档
   * 的同一个事实必须仍能判成重复，否则同样的内容再写一次又是一条新行（#254 拍板：
   * 归档行纳入去重候选集）。
   * 排序即取舍：活跃行排在归档/遗忘行之前，再按 updated_at 倒序。LIMIT 先于调用方的
   * 「活区优先」判断执行，而归档动作本身会顶 updated_at——纯按时间倒序时，同键命中一
   * 旦超过窗口宽度，活跃行就被归档行挤出候选集，调用方只能看到归档命中，把「活跃重复」
   * 误报成「归档重复」，恰好把这条信号要分流的两类弄反。
   * @returns {Array<{id: string, archived: boolean, forgotten: boolean}>} 活跃行优先，其后按最近写入
   */
  function findContentHashMatches({ type, hash, agent_scope: agentScope, workspace_scope: workspaceScope, sensitivity, limit = 10 } = {}) {
    if (!hash || !type) return [];
    const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10;
    const rows = db.prepare(
      `SELECT id, archived, forgotten FROM memories
       WHERE type = ? AND content_hash = ?
         AND agent_scope IS ? AND workspace_scope IS ? AND sensitivity IS ?
       ORDER BY archived ASC, forgotten ASC, updated_at DESC, id LIMIT ?`
    ).all(
      type,
      hash,
      normalizeScopeText(agentScope),
      normalizeScopeText(workspaceScope),
      normalizeScopeText(sensitivity),
      lim
    );
    return rows.map((row) => ({ id: row.id, archived: row.archived === 1, forgotten: row.forgotten === 1 }));
  }

  function update(id, patch) {
    const existing = getById(id);
    if (!existing) throw new Error(`memory not found: ${id}`);
    const type = patch.type ?? existing.type;
    if (!TYPES.has(type)) throw new Error(`invalid memory type: ${type}`);
    // #230：type 不许改入/改出 document——铸造与退役都只经 registerDocument
    // （摘要修复走同 type 的 content/title 更新，doc_path 不在本 UPDATE 的
    // SET 里，天然保持不变）。
    if ((existing.type === "document") !== (type === "document")) {
      throw new Error("memory type cannot be changed to or from 'document' (registerDocument is the only mint path)");
    }
    if (patch.tags !== undefined && !Array.isArray(patch.tags)) {
      throw new Error("tags must be an array");
    }
    const now = nowIso();
    const embedding = patch.embedding !== undefined
      ? (Array.isArray(patch.embedding) && patch.embedding.length ? JSON.stringify(patch.embedding) : null)
      : existing.embedding ?? null;
    const epistemicStatus = resolveEpistemicStatus(existing, patch);
    const contentHistory = Array.isArray(patch.content_history)
      ? JSON.stringify(patch.content_history)
      : (Array.isArray(existing.content_history) ? JSON.stringify(existing.content_history) : null);
    const qualityScore = patch.quality_score !== undefined && Number.isFinite(patch.quality_score)
      ? patch.quality_score
      : (existing.quality_score ?? null);
    // 证据链只在本 patch 显式携带时才改写（undefined=保留既有）。
    const evidence = patch.evidence !== undefined
      ? (Array.isArray(patch.evidence) ? JSON.stringify(patch.evidence) : null)
      : (existing.evidence?.length ? JSON.stringify(existing.evidence) : null);
    // v0.8.1 底座（issue #170）：scope 列只在本 patch 显式携带该键时才改写
    // （undefined=不动；null=清空为未标注/global）。来源列只认 auto|explicit。
    const nextAgentScope = patch.agent_scope !== undefined
      ? normalizeScopeText(patch.agent_scope)
      : (existing.agent_scope ?? null);
    const nextWorkspaceScope = patch.workspace_scope !== undefined
      ? normalizeScopeText(patch.workspace_scope)
      : (existing.workspace_scope ?? null);
    const nextAgentSource = patch.agent_scope_source !== undefined
      ? normalizeScopeSource(patch.agent_scope_source)
      : (existing.agent_scope_source ?? null);
    const nextWorkspaceSource = patch.workspace_scope_source !== undefined
      ? normalizeScopeSource(patch.workspace_scope_source)
      : (existing.workspace_scope_source ?? null);
    const nextDecidedAt = patch.scope_decided_at !== undefined
      ? normalizeOccurredAt(patch.scope_decided_at)
      : (existing.scope_decided_at ?? null);
    // #254：标题或正文变了，锚跟着重算——它是当前内容的派生物，留旧值等于让「这行
    // 现在装的什么」和标记对不上。
    const nextTitle = patch.title ?? existing.title;
    const nextContent = patch.content ?? existing.content;
    const contentHash = contentHashOf({ title: nextTitle, content: nextContent });
    runAtomically(() => {
      db.prepare(
        `UPDATE memories SET type=?, title=?, content=?, tags=?, importance=?, source=?, content_history=?, quality_score=?, embedding=?, epistemic_status=?, agent_scope=?, workspace_scope=?, agent_scope_source=?, workspace_scope_source=?, scope_decided_at=?, evidence=?, content_hash=?, updated_at=? WHERE id=?`
      ).run(
        type,
        nextTitle,
        nextContent,
        JSON.stringify(patch.tags ?? existing.tags),
        Number.isInteger(patch.importance) ? patch.importance : existing.importance,
        patch.source !== undefined ? patch.source : (existing.source ?? null),
        contentHistory,
        qualityScore,
        embedding,
        epistemicStatus,
        nextAgentScope,
        nextWorkspaceScope,
        nextAgentSource,
        nextWorkspaceSource,
        nextDecidedAt,
        evidence,
        contentHash,
        now,
        id
      );
      // Issue #202：update 可直写 embedding（patch.embedding），缓存条目失效，
      // 下次读取按库值重解析。宁滥勿缺——即便本 patch 未含 embedding，丢一条
      // 缓存只多一次点查重解析。
      embeddingCache.delete(id);
      // Desired generation bumped in the same transaction as the update (peer
      // blocker 1: crash between write and sync must still be recoverable).
      incrementGeneration();
    });
    return getById(id);
  }

  function remove(id) {
    runAtomically(() => {
      // #399：memory_provenance 的 ON DELETE CASCADE 在本库是惰性的（createStore
      // 从不打开 PRAGMA foreign_keys），所以链接在这里显式清。不用翻转全局 pragma
      // 换这一条级联：那会同时激活 recall_events 那条既有的 REFERENCES，改变一个
      // 与 #399 无关的写入路径。记录本身（distill_records）不删——删掉一条派生记忆
      // 不该让整个窗口的原文凭证消失。
      db.prepare("DELETE FROM memory_provenance WHERE memory_id = ?").run(id);
      db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      // Mirror sync must reflect the deletion; bump desired generation so a
      // crash between the delete and syncMirror leaves a recoverable debt.
      incrementGeneration();
    });
  }

  /**
   * Atomic compare-and-set update: applies `patch` only when the row still
   * carries `expectedUpdatedAt` (the version token read by the caller). Returns
   * the updated memory on success, or undefined when the row changed since the
   * caller read it — the caller must re-read and retry. The version guard lives
   * in the UPDATE's WHERE clause, so a concurrent read-modify-write across
   * connections cannot silently overwrite a newer value (lost update).
   */
  function compareAndUpdate(id, expectedUpdatedAt, patch) {
    const existing = getById(id);
    if (!existing) throw new Error(`memory not found: ${id}`);
    const type = patch.type ?? existing.type;
    if (!TYPES.has(type)) throw new Error(`invalid memory type: ${type}`);
    // 同 update：document 类型转换在这里同样封死（CAS 路径绕过 updateMemory
    // 的 service 守卫，必须在存储层兜住）。
    if ((existing.type === "document") !== (type === "document")) {
      throw new Error("memory type cannot be changed to or from 'document' (registerDocument is the only mint path)");
    }
    if (patch.tags !== undefined && !Array.isArray(patch.tags)) {
      throw new Error("tags must be an array");
    }
    const now = nowIso();
    const embedding = patch.embedding !== undefined
      ? (Array.isArray(patch.embedding) && patch.embedding.length ? JSON.stringify(patch.embedding) : null)
      : existing.embedding ?? null;
    const epistemicStatus = resolveEpistemicStatus(existing, patch);
    const contentHistory = Array.isArray(patch.content_history)
      ? JSON.stringify(patch.content_history)
      : (Array.isArray(existing.content_history) ? JSON.stringify(existing.content_history) : null);
    const qualityScore = patch.quality_score !== undefined && Number.isFinite(patch.quality_score)
      ? patch.quality_score
      : (existing.quality_score ?? null);
    // The CAS UPDATE and the desired-generation bump must commit together (audit
    // peer A): if the UPDATE autocommits first and the process dies before the
    // increment, the store is mutated while generation == applied_generation and
    // dirty == false — recoverMirror sees no debt and the mirror stays stale.
    // Wrapping both in one transaction means a CAS miss rolls back cleanly too
    // (no write, no generation bump).
    // 同 update：#254 的锚随标题/正文重算（CAS 路径也改这两列）。
    const nextTitle = patch.title ?? existing.title;
    const nextContent = patch.content ?? existing.content;
    const contentHash = contentHashOf({ title: nextTitle, content: nextContent });
    let applied = false;
    runAtomically(() => {
      const result = db.prepare(
        `UPDATE memories SET type=?, title=?, content=?, tags=?, importance=?, source=?, content_history=?, quality_score=?, embedding=?, epistemic_status=?, content_hash=?, updated_at=?
         WHERE id=? AND updated_at=?`
      ).run(
        type,
        nextTitle,
        nextContent,
        JSON.stringify(patch.tags ?? existing.tags),
        Number.isInteger(patch.importance) ? patch.importance : existing.importance,
        patch.source !== undefined ? patch.source : (existing.source ?? null),
        contentHistory,
        qualityScore,
        embedding,
        epistemicStatus,
        contentHash,
        now,
        id,
        expectedUpdatedAt
      );
      if (result.changes === 0) return; // CAS miss: a concurrent write won
      // Issue #202：同 update——CAS 命中即可能改写 embedding，失效缓存条目。
      embeddingCache.delete(id);
      // Only bump desired generation on a successful CAS — a miss writes nothing.
      incrementGeneration();
      applied = true;
    });
    if (!applied) return undefined;
    return getById(id);
  }

  function setForget(id, forgotten) {
    runAtomically(() => {
      db.prepare("UPDATE memories SET forgotten = ?, updated_at = ? WHERE id = ?")
        .run(forgotten === true || forgotten === 1 ? 1 : 0, nowIso(), id);
      incrementGeneration();
    });
    return getById(id);
  }

  // Issue #275 第二批：archived_at 是「从活跃面进入归档面」那一刻的精确记录。
  // updated_at 照旧刷新（本函数自 v0.2 起的既有语义，其他读侧依赖它——面板排序、
  // 快照哈希、CAS），两列职责分开：updated_at = 最后一次写，archived_at = 归档时刻。
  // 幂等：已是归档态再调 archived=true，不刷新 archived_at（重复归档不是新一次
  // 归档，否则「重复调 setArchived」又变成一次净增——那正是代理口径被推翻的原因）。
  function setArchived(id, archived) {
    const next = archived ? 1 : 0;
    runAtomically(() => {
      // nowIso 在事务内取（与改动前一致）：单调顶推的时间戳不该被一次回滚白白消耗。
      const now = nowIso();
      // CASE 里的 archived 是**更新前**的值（SQLite UPDATE 表达式语义）：
      //   活跃 → 归档：落当前时刻；已归档 → 归档：保留原值（含存量 NULL，不回填）；
      //   任意 → 取消归档：清 NULL。
      // 幂等刻意选「重复归档不刷新时刻」：否则「对同一行重复调 setArchived(true)」
      // 会再被算成本窗口新进——那正是本批要消灭的代理口径偏高，换个入口复活而已。
      db.prepare(
        `UPDATE memories SET archived = ?,
           archived_at = CASE WHEN ? = 1 AND archived = 0 THEN ? WHEN ? = 0 THEN NULL ELSE archived_at END,
           updated_at = ?
         WHERE id = ?`
      ).run(next, next, now, next, now, id);
      incrementGeneration();
    });
    return getById(id);
  }

  // --- sleep-mode storage support (v0.4.0) ---------------------------------
  // touchLastAccess stamps the read time on recall/inject paths. It deliberately
  // does NOT bump the mirror generation: reads must not mark the mirror dirty.
  function touchLastAccess(id, at) {
    if (!getById(id)) return false;
    db.prepare("UPDATE memories SET last_accessed_at = ? WHERE id = ?")
      .run(at ?? nowIso(), id);
    return true;
  }

  // Shrink an aged memory to `summary`, parking its full body in _full_content.
  // Idempotent: an already-demoted memory (non-null _full_content) is left
  // untouched. minRefTimeMs guards the fast path — if last_accessed_at moved
  // after the caller's snapshot (>= minRefTimeMs), the memory is hot again and
  // is skipped. Returns the updated memory, or undefined when skipped/absent.
  function demoteToSummary(id, summary, { minRefTimeMs } = {}) {
    let changed = false;
    runAtomically(() => {
      const row = db.prepare("SELECT title, last_accessed_at, content, _full_content FROM memories WHERE id = ?").get(id);
      if (!row || row._full_content) return;
      if (minRefTimeMs !== undefined && row.last_accessed_at) {
        const lastMs = Date.parse(row.last_accessed_at);
        if (lastMs >= minRefTimeMs) return; // touched after snapshot — still hot
      }
      db.prepare(
        "UPDATE memories SET content = ?, _full_content = ?, content_hash = ?, updated_at = ? WHERE id = ?"
      ).run(summary, row.content, contentHashOf({ title: row.title, content: summary }), nowIso(), id);
      incrementGeneration();
      changed = true;
    });
    return changed ? getById(id) : undefined;
  }

  // Undo demoteToSummary: pull the parked body back into content.
  function restoreContent(id) {
    let changed = false;
    runAtomically(() => {
      const row = db.prepare("SELECT title, content, _full_content FROM memories WHERE id = ?").get(id);
      if (!row || !row._full_content) return;
      db.prepare(
        "UPDATE memories SET content = ?, _full_content = NULL, content_hash = ?, updated_at = ? WHERE id = ?"
      ).run(row._full_content, contentHashOf({ title: row.title, content: row._full_content }), nowIso(), id);
      incrementGeneration();
      changed = true;
    });
    return changed ? getById(id) : undefined;
  }

  // Live memories that have not been touched since `cutMs` (never-touched ones
  // fall back to created_at). Ordered by last access ascending — the coldest
  // first. Used by sleep phase 2 to pick archival-demotion candidates.
  // #230: document pointer rows are excluded — they are heat-immune by design
  // (λ=0) and their "unread" state is normal (full text lives outside the DB),
  // so the cold scan must never demote/archive them for lacking access.
  function getUnrecalledSince(cutMs, { limit = 500 } = {}) {
    const cutIso = new Date(cutMs).toISOString();
    const rows = db.prepare(
      `SELECT * FROM memories
       WHERE forgotten = 0 AND archived = 0
         AND type <> 'document'
         AND (last_accessed_at IS NULL OR last_accessed_at < ?)
       ORDER BY COALESCE(last_accessed_at, created_at) ASC, id
       LIMIT ?`
    ).all(cutIso, limit);
    return rows.map(toRow);
  }

  function list({ type, excludeTypes = null, limit = 50, offset = 0, order = "importance", includeForgotten = false, includeArchived = false, onlyArchived = false, depositedOnly = false, minImportance = null, source = null, updatedFrom = null, updatedTo = null, occurredFrom = null, occurredTo = null, visibility = null } = {}) {
    const clauses = [];
    const params = [];
    if (type) {
      clauses.push("type = ?");
      params.push(type);
    }
    // #230：整类排除必须在 LIMIT 之前做——sleep 的模式扫描池（limit 200 +
    // sleepPatternMinMemories 门槛）若先截断后过滤，document 行一多就会把
    // 普通记忆挤出窗口，池子被饿空。
    if (Array.isArray(excludeTypes) && excludeTypes.length) {
      clauses.push(`type NOT IN (${excludeTypes.map(() => "?").join(", ")})`);
      params.push(...excludeTypes);
    }
    // Optional server-side filters: importance floor and exact source match.
    // Both stay out of the query when unset so existing callers are unaffected.
    if (minImportance != null) {
      clauses.push("importance >= ?");
      params.push(minImportance);
    }
    if (source) {
      clauses.push("source = ?");
      params.push(source);
    }
    // Optional updated_at closed range (date-only "to" is normalized to the
    // end of that day). Same helper as count() so total matches the rows.
    const bounds = updatedAtBounds(updatedFrom, updatedTo);
    if (bounds.from) {
      clauses.push("updated_at >= ?");
      params.push(bounds.from);
    }
    if (bounds.to) {
      clauses.push("updated_at <= ?");
      params.push(bounds.to);
    }
    // v0.8.0 A2（issue #17）：occurred_at 闭区间过滤——按「事件发生时间」检索。
    // 未标注 occurred_at 的行（含全部存量）回退 created_at 比较（COALESCE），
    // 否则过滤器对旧库近乎不可用；边界归一化与 updated_at 共用 updatedAtBounds。
    const occurred = updatedAtBounds(occurredFrom, occurredTo);
    if (occurred.from) {
      clauses.push("COALESCE(occurred_at, created_at) >= ?");
      params.push(occurred.from);
    }
    if (occurred.to) {
      clauses.push("COALESCE(occurred_at, created_at) <= ?");
      params.push(occurred.to);
    }
    // v0.8.0 A3（issue #17）：strictScope 硬过滤（memory_list 分页路径）。
    // SQL 与 service.isVisibleInScope 同口径：未标注(NULL)恒可见；v0.8.1 起
    // 硬墙只认 explicit 来源（4.3），当前维度解析不到时该维度只放行未标注/
    // 非显式行（fail-closed 收窄）。只有显式传 visibility 的用户面调用才
    // 过滤——dream/质量过滤等内部 store.list 调用不受影响。
    if (visibility) {
      // v0.8.1 第 3 步（issue #170 4.3）：硬过滤只认显式声明——与
      // service.isVisibleInScope 同口径。IS NOT 是 NULL 安全比较：来源为
      // auto/NULL（v0.8.0 存量自动标注）的行不吃硬墙，只走 A2 软加权。
      if (visibility.agentScope != null) {
        clauses.push("(agent_scope IS NULL OR agent_scope_source IS NOT 'explicit' OR agent_scope = ?)");
        params.push(visibility.agentScope);
      } else {
        clauses.push("(agent_scope IS NULL OR agent_scope_source IS NOT 'explicit')");
      }
      if (visibility.workspaceScope != null) {
        clauses.push("(workspace_scope IS NULL OR workspace_scope_source IS NOT 'explicit' OR workspace_scope = ?)");
        params.push(visibility.workspaceScope);
      } else {
        clauses.push("(workspace_scope IS NULL OR workspace_scope_source IS NOT 'explicit')");
      }
    }
    if (!includeForgotten) {
      clauses.push("forgotten = 0");
    }
    // onlyArchived：只看归档（状态页的归档列表用）；与 includeArchived（含
    // 归档混看）互斥，同时给时归档视图优先。
    if (onlyArchived) {
      clauses.push("archived = 1");
    } else if (!includeArchived) {
      clauses.push("archived = 0");
    }
    // depositedOnly：只看 autoDream 巩固过的记忆——receipt_chain 的 merge /
    // update live verdict（record_id 即保留/更新目标）∪ source="dream" 的
    // 直写沉淀（记忆库总览）。conflict 不算沉淀：两侧只被仲裁，内容未落。
    if (depositedOnly) {
      clauses.push(
        "(id IN (SELECT record_id FROM receipt_chain WHERE kind IN ('merge', 'update') AND verdict = 'live') OR source = 'dream')"
      );
    }
    // limit == null = 无界（#230 注册器的精确 supersede 全量扫描用——同路径/
    // 同标题判定不允许窗口截断）。其余调用传数字，走 sanitizePage 默认档。
    const unbounded = limit == null;
    const { limit: lim, offset: off } = sanitizePage(limit, offset, 50);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    // "chrono" is pure newest-first — the stable order paged browsing (month
    // tree, infinite scroll) needs; importance ordering would interleave
    // months across pages.
    // #430：chrono 的 **无界档** 不再追加 id 平局键。updated_at 上有 #202 建的
    // 索引，而带 id 的第二项排序键用不上它——5k 行实测同一份 SQL 只差这一项：
    // 100.6ms（带 id，EXPLAIN 多一个 USE TEMP B-TREE）对 23.4ms（纯 updated_at，
    // 直接走 idx_memories_updated）。分页档位必须留平局键（跨页拼接要求稳定，
    // 同刻两行在新旧页之间可能漏一条或重复一条）；无界档没有跨页拼接，今天唯一
    // 的调用方 syncMirror 只用它算覆盖集，与顺序无关。
    const orderBy = order === "chrono"
      ? (unbounded ? "updated_at DESC" : "updated_at DESC, id DESC")
      : "importance DESC, updated_at DESC, id";
    // Issue #430：与 all() 共用同一份显式列清单（memoryColumns 由 PRAGMA 派生，
    // 排除 embedding）。toRow 本就不输出向量，SELECT * 只是把全表最重的列拖进
    // 内存再丢弃——无界档实测 5k 行 263ms → 117ms，窗口档 50ms → 41ms，本函数
    // 的全部调用方（分页浏览、document 索引、sleep 池、注册器全量扫描）一起受益。
    const projected = `SELECT ${memoryColumnList} FROM memories`;
    const rows = unbounded
      ? db.prepare(`${projected} ${where} ORDER BY ${orderBy}`).all(...params)
      : db.prepare(
          `${projected} ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
        ).all(...params, lim, off);
    return rows.map(toRow);
  }

  function all() {
    // Issue #202：显式列清单排除 embedding——toRow 本就不输出向量，SELECT *
    // 纯属把全表最重的列（9.4 MB TEXT/5k 行）拖进内存再丢弃。
    const rows = db.prepare(`SELECT ${memoryColumnList} FROM memories ORDER BY updated_at DESC`).all();
    return rows.map(toRow);
  }

  // Issue #430：写路径要的「最近若干条正文」。质量过滤的近重复判定只读 content
  // 这一列 + 前 20 行，此前写成 all().slice(0, 20) —— 全表逐行 toRow（27 字段、
  // 三次 JSON 解析）之后只截前 20 条正文；5k 行实测 100ms 级 → 0.06ms 级。
  // 口径与 all() 的前 N 条严格一致：不加 WHERE（archived/forgotten 仍参与近重复
  // 判定）、updated_at DESC、同刻顺序未定义。limit 走 sanitizePage，非正整数
  // 落回 20，调用方不必自己防 0/undefined。
  function recentContents(limit = 20) {
    const { limit: lim } = sanitizePage(limit, 0, 20);
    const rows = db.prepare("SELECT content FROM memories ORDER BY updated_at DESC LIMIT ?").all(lim);
    return rows.map((row) => row.content ?? "");
  }

  /** Set (or clear with null) the embedding vector of a memory.
   *  `modelHash` records which model produced THIS vector (see the
   *  embedding_model migration note). Clearing the vector clears the
   *  provenance with it, so a NULL vector is never paired with a stale model
   *  name; omitting modelHash leaves the column untouched (callers that
   *  predate the column still work, their rows simply read as unknown). */
  function setEmbedding(id, vector, modelHash) {
    const json = Array.isArray(vector) && vector.length ? JSON.stringify(vector) : null;
    if (json) {
      if (modelHash !== undefined) {
        db.prepare("UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?")
          .run(json, modelHash === null ? null : String(modelHash), id);
      } else {
        db.prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(json, id);
      }
    } else {
      db.prepare("UPDATE memories SET embedding = NULL, embedding_model = NULL WHERE id = ?").run(id);
    }
    // Issue #202：单一写入口即单一失效点——重写缓存条目（向量在手上不必重解析），
    // 清空则移除，删除过的 id 不会被下一次 searchVector 的 id 集合选中。
    if (json) {
      try {
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed) && parsed.length) cacheEmbedding(id, parsed);
        else embeddingCache.delete(id);
      } catch { embeddingCache.delete(id); }
    } else {
      embeddingCache.delete(id);
    }
  }

  /** Batch fetch stored embeddings by id (v0.5.0 search-time semantic dedup).
   *  Returns a Map(id → number[]); rows without a parseable embedding are
   *  simply absent from the map. */
  function getEmbeddings(ids) {
    const out = new Map();
    const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
    for (const id of list) {
      // Issue #202：走同一解析缓存（语义去重的批量读也免重复 parse）。
      const vec = getParsedEmbedding(id);
      if (vec) out.set(id, vec);
    }
    return out;
  }

  function embeddedCount() {
    // Active rows only — getStats pairs this with count() as the status card's
    // "indexed N / M" denominator, and count() defaults exclude forgotten and
    // archived memories. Unfiltered, archived rows inflate N past M.
    return db.prepare(
      "SELECT count(*) AS c FROM memories WHERE embedding IS NOT NULL AND embedding != '' AND forgotten = 0 AND archived = 0"
    ).get().c;
  }

  /**
   * Candidate rows still missing an embedding, for incremental re-indexing.
   * Issue #128: active rows only — archived/forgotten rows never participate in
   * recall or dream clustering, so backfill quota must not be eaten by them
   * (report measured 25/50 reindex slots landing on archived rows while 88
   * active rows stayed un-embedded). Same 口径 as embeddedCount()/count().
   */
  function needsEmbedding(limit = 50) {
    return db.prepare(
      `SELECT id, title, content FROM memories
       WHERE (embedding IS NULL OR embedding = '')
         AND forgotten = 0 AND archived = 0
       ORDER BY updated_at DESC LIMIT ?`
    ).all(limit);
  }

  /**
   * Rows whose vector is missing OR was produced by a different model than
   * `modelHash` — the selector the backfill should use whenever the caller
   * knows which model the vectors are supposed to come from.
   *
   * Why `needsEmbedding` alone is not enough: it only matches empty vectors,
   * so after a model switch every vector written by the previous model stays
   * eligible for "has a vector" forever, while its similarity to the current
   * query embedding is meaningless. Those rows keep inflating the status
   * card's coverage while semantic recall silently degrades.
   *
   * `embedding_model IS NULL` counts as stale on purpose: NULL means "written
   * before per-row provenance existed, producing model unknown", and an
   * unknown origin cannot be proven to match. Those rows get re-embedded
   * rather than assumed correct.
   *
   * When `modelHash` is falsy (embedder unconfigured / no fingerprint yet)
   * this degrades to the plain missing-only selector instead of re-embedding
   * the whole table against nothing.
   */
  function needsEmbeddingFor(modelHash, limit = 50) {
    if (!modelHash) return needsEmbedding(limit);
    return db.prepare(
      `SELECT id, title, content, embedding_model FROM memories
       WHERE ((embedding IS NULL OR embedding = '')
              OR embedding_model IS NULL
              OR embedding_model != ?)
         AND forgotten = 0 AND archived = 0
       ORDER BY updated_at DESC LIMIT ?`
    ).all(String(modelHash), limit);
  }

  /** True when any active row would be picked by needsEmbeddingFor(). */
  function hasStaleEmbedding(modelHash) {
    return needsEmbeddingFor(modelHash, 1).length > 0;
  }

  /** Per-model provenance counts over active rows ('' = unknown origin). */
  function embeddingModelBreakdown() {
    return db.prepare(
      `SELECT COALESCE(embedding_model, '') AS model, count(*) AS c
         FROM memories
        WHERE embedding IS NOT NULL AND embedding != ''
          AND forgotten = 0 AND archived = 0
        GROUP BY COALESCE(embedding_model, '')`
    ).all();
  }

  function search(query, { limit = 20, includeArchived = false } = {}) {
    const q = String(query).trim();
    if (!q) return [];
    // Plain LIKE substring scan over title/content/tags (wildcards escaped so
    // user input matches literally). No FTS5: CJK substring matching needs
    // LIKE, and typical memory stores are small enough that a scan is fine.
    const like = `%${escapeLike(q)}%`;
    const { limit: lim } = sanitizePage(limit, 0, 20);
    const archivedFilter = includeArchived ? "" : "archived = 0 AND ";
    const rows = db.prepare(
      `SELECT * FROM memories
       WHERE ${archivedFilter}forgotten = 0 AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')
       ORDER BY
         CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
         importance DESC,
         updated_at DESC,
         id
       LIMIT ?`
    ).all(like, like, like, like, lim);
    return rows.map(toRow);
  }

  // --- vector search ------------------------------------------------------

  function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /**
   * Brute-force cosine similarity over embedded rows. Returns rows decorated
   * with a `score` (0..1). Only rows with a stored embedding participate.
   */
  function searchVector(vector, { limit = 20, includeArchived = false, threshold = 0 } = {}) {
    if (!Array.isArray(vector) || !vector.length) return [];
    const archivedFilter = includeArchived ? "" : "archived = 0 AND ";
    // Issue #202：只取 id 列（~40 KB）而非 SELECT *（~11 MB）——向量从缓存取，
    // 缓存未命中时按 id 点查 embedding 再解析回填。SQL 里保留 embedding 的
    // IS NOT NULL 过滤，保证「有向量的行」集合始终以库为准（删除/清空即时生效）。
    const rows = db.prepare(
      `SELECT id FROM memories
       WHERE ${archivedFilter}forgotten = 0 AND embedding IS NOT NULL AND embedding != ''`
    ).all();
    const scored = [];
    for (const row of rows) {
      const v = getParsedEmbedding(row.id);
      if (!v) continue;
      // distill-tx-embed-gap 顺带修：维度不匹配的行按维度分流，直接跳过。旧路径
      // 喂进 cosine 不等长就 return 0，换了模型/维度的旧向量以 0 分混进结果尾部
      // （threshold 默认 0 时照样入选），检索方拿到的分数是跨向量空间的假值。
      // 不等长的向量对本次查询没有可比分数，跳过是唯一诚实的处置。
      if (v.length !== vector.length) continue;
      const score = cosine(vector, v);
      if (score >= threshold) scored.push({ row: { id: row.id }, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const { limit: lim } = sanitizePage(limit, 0, 20);
    // Top-N 回表：只对入选行取完整字段（主键点查 ≤ lim 行），评分别拖着正文走。
    const getFull = db.prepare("SELECT * FROM memories WHERE id = ?");
    const out = [];
    for (const { row, score } of scored.slice(0, lim)) {
      const full = getFull.get(row.id);
      if (full) out.push({ ...toRow(full), score });
    }
    return out;
  }

  // --- autoDream audit trail ----------------------------------------------

  /**
   * Persist one autoDream run. The audit row is machine-verifiable but never
   * triggers write hooks (it is bookkeeping, not a memory mutation): dream
   * records its own runs, and a notify here would loop back into the dream
   * scheduler. Writes are idempotent on run id (replay overwrites, never
   * duplicates) so the same logical run can be re-applied for verification.
   */
  function saveDreamRun(run) {
    const id = run.id ?? randomUUID();
    const now = nowIso();
    const policyEpoch = Number.isInteger(run.policy_epoch) ? run.policy_epoch : 0;
    const runType = run.run_type ?? "auto";
    // Issue #104：degraded 轮的跳过明细（JSON）。与 decisions/outcome 同为可选
    // 载荷，未提供时落 NULL（而不是 "[]"），审计行只记真实发生过的跳过。
    const skipped = run.skipped !== undefined ? JSON.stringify(run.skipped) : null;
    // Issue #89（基线半边）：只有成功刷新过基线的 run 才带这两个值。非法/缺失一律落
    // NULL——播种端以「两列同时有值」为唯一认账条件，半个基线（只有条数没有字符数）
    // 会让阈值按 0 字符起算，比不认还糟。
    const baselineKnown =
      Number.isInteger(run.store_count) && run.store_count >= 0 &&
      Number.isInteger(run.store_chars) && run.store_chars >= 0;
    const storeCount = baselineKnown ? run.store_count : null;
    const storeChars = baselineKnown ? run.store_chars : null;
    db.prepare(
      `INSERT INTO dream_runs (id, created_at, status, error, provider, model, snapshot_hash,
        input_count, input, decisions, outcome, applied, summary_stored, receipt, policy_epoch, run_type, skipped,
        store_count, store_chars)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         created_at=excluded.created_at, status=excluded.status, error=excluded.error,
         provider=excluded.provider, model=excluded.model, snapshot_hash=excluded.snapshot_hash,
         input_count=excluded.input_count, input=excluded.input, decisions=excluded.decisions,
         outcome=excluded.outcome, applied=excluded.applied, summary_stored=excluded.summary_stored,
         receipt=excluded.receipt, policy_epoch=excluded.policy_epoch, run_type=excluded.run_type,
         skipped=excluded.skipped, store_count=excluded.store_count, store_chars=excluded.store_chars`
    ).run(
      id,
      run.created_at ?? now,
      run.status,
      run.error ?? null,
      run.provider ?? null,
      run.model ?? null,
      run.snapshot_hash,
      run.input_count,
      run.input !== undefined ? JSON.stringify(run.input) : null,
      run.decisions !== undefined ? JSON.stringify(run.decisions) : null,
      run.outcome !== undefined ? JSON.stringify(run.outcome) : null,
      run.applied ?? 0,
      run.summary_stored ? 1 : 0,
      run.receipt,
      policyEpoch,
      runType,
      skipped,
      storeCount,
      storeChars
    );
    return getDreamRun(id);
  }

  function getDreamRun(id) {
    const row = db.prepare("SELECT * FROM dream_runs WHERE id = ?").get(id);
    return toDreamRun(row);
  }

  function listDreamRuns({ limit = 50, offset = 0 } = {}) {
    const { limit: lim, offset: off } = sanitizePage(limit, offset, 50);
    const rows = db.prepare(
      "SELECT * FROM dream_runs ORDER BY created_at DESC, id LIMIT ? OFFSET ?"
    ).all(lim, off);
    return rows.map(toDreamRun);
  }

  // Issue #89：上次实际开跑时刻（epoch ms），从审计表恢复——调度器的 lastRunAt
  // 只活在内存里，进程重启即归零，闸门对新实例放行 → 重启后立刻连发。审计表
  // 本来就逐 run 落库（failed/degraded 也算 run），直接读它就是事实源，零迁移。
  function lastDreamRunAt(runType = null) {
    const row = runType
      ? db.prepare(
          "SELECT created_at FROM dream_runs WHERE run_type = ? ORDER BY created_at DESC, id LIMIT 1"
        ).get(runType)
      : db.prepare(
          "SELECT created_at FROM dream_runs ORDER BY created_at DESC, id LIMIT 1"
        ).get();
    if (!row?.created_at) return 0;
    const ms = Date.parse(row.created_at);
    return Number.isFinite(ms) ? ms : 0;
  }

  // Issue #89（基线半边）：上次成功刷新后的阈值基线（活跃条数 / 正文字符数）。与
  // lastDreamRunAt 同源——审计表就是事实源，不另开一份状态；差别只在只认「推进过
  // 基线」的行（两列同时非 NULL = 那一轮是 ok）。按 run_type 隔离：sleep/organize
  // 的轮次不参与 auto 的阈值判定，混用会让其余模块的库规模假扮成巩固基线。
  // 认不出行时返回 null，调用方退回零基线（= 升级前行为），绝不假装知道基线。
  function lastDreamBaseline(runType = null) {
    const where = "store_count IS NOT NULL AND store_chars IS NOT NULL";
    const row = runType
      ? db.prepare(
          `SELECT store_count, store_chars FROM dream_runs
            WHERE run_type = ? AND ${where}
            ORDER BY created_at DESC, id LIMIT 1`
        ).get(runType)
      : db.prepare(
          `SELECT store_count, store_chars FROM dream_runs
            WHERE ${where} ORDER BY created_at DESC, id LIMIT 1`
        ).get();
    if (!row) return null;
    return { count: row.store_count, chars: row.store_chars };
  }

  /**
   * Latest ruling-rule version seen on the audit trail. policy_epoch is a config
   * value stamped onto each run by the caller; reading the newest row's epoch
   * gives the current effective version, falling back to 0 (default) when the
   * trail is empty. Rules upgrades leave older runs with their original epoch,
   * so those decisions can be demoted to historical evidence.
   */
  function getLatestPolicyEpoch() {
    const row = db.prepare(
      "SELECT policy_epoch FROM dream_runs ORDER BY created_at DESC, id LIMIT 1"
    ).get();
    return row ? (row.policy_epoch ?? 0) : 0;
  }

  // --- per-record receipt chain --------------------------------------------

  /**
   * Persist one per-record receipt (a single merge/conflict/update verdict).
   * The run-level dream audit trail answers "did this run happen and with what
   * input"; the receipt chain drills down to each mutable verdict, carrying the
   * input digest (decision basis) plus count_before → count_after idempotency
   * checkpoints so replay drift can be located to the exact record/run. Like
   * the dream trail this is bookkeeping: it never triggers write hooks. Writes
   * are idempotent on receipt id (replay overwrites, never duplicates).
   */
  function saveReceipt(run) {
    const id = run.receipt_id ?? randomUUID();
    const now = nowIso();
    const policyEpoch = Number.isInteger(run.policy_epoch) ? run.policy_epoch : 0;
    db.prepare(
      `INSERT INTO receipt_chain (receipt_id, run_id, record_id, kind, input_digest,
        winner_id, loser_id, keep_source, sources, verdict, count_before, count_after,
        policy_epoch, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(receipt_id) DO UPDATE SET
         run_id=excluded.run_id, record_id=excluded.record_id, kind=excluded.kind,
         input_digest=excluded.input_digest, winner_id=excluded.winner_id,
         loser_id=excluded.loser_id, keep_source=excluded.keep_source,
         sources=excluded.sources, verdict=excluded.verdict,
         count_before=excluded.count_before, count_after=excluded.count_after,
         policy_epoch=excluded.policy_epoch, created_at=excluded.created_at`
    ).run(
      id,
      run.run_id,
      run.record_id,
      run.kind,
      run.input_digest,
      run.winner_id ?? null,
      run.loser_id ?? null,
      run.keep_source ?? null,
      JSON.stringify(run.sources ?? []),
      run.verdict,
      run.count_before,
      run.count_after,
      policyEpoch,
      run.created_at ?? now
    );
    return getReceipt(id);
  }

  function getReceipt(id) {
    const row = db.prepare("SELECT * FROM receipt_chain WHERE receipt_id = ?").get(id);
    return toReceipt(row);
  }

  function listReceipts({ limit = 50, offset = 0, run_id } = {}) {
    const { limit: lim, offset: off } = sanitizePage(limit, offset, 50);
    const clauses = [];
    const params = [];
    if (run_id) {
      clauses.push("run_id = ?");
      params.push(run_id);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(
      `SELECT * FROM receipt_chain ${where} ORDER BY created_at DESC, receipt_id LIMIT ? OFFSET ?`
    ).all(...params, lim, off);
    return rows.map(toReceipt);
  }

  // --- recall-layer audit trail -------------------------------------------

  /**
   * Persist one recall run (the retrieval scene: query/mode/top-k/threshold +
   * the exact candidate list handed to the caller). Like the dream audit trail
   * this is bookkeeping, so it never triggers write hooks — a notify here would
   * loop back into search itself. Writes are idempotent on run id (replay
   * overwrites, never duplicates), matching saveDreamRun.
   */
  function saveRecallRun(run) {
    const id = run.id ?? randomUUID();
    db.prepare(
      `INSERT INTO recall_runs (id, query, mode, top_k, threshold, candidates, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         query=excluded.query, mode=excluded.mode, top_k=excluded.top_k,
         threshold=excluded.threshold, candidates=excluded.candidates,
         created_at=excluded.created_at`
    ).run(
      id,
      run.query,
      run.mode,
      run.topK ?? null,
      run.threshold ?? null,
      JSON.stringify(run.candidates ?? []),
      run.created_at ?? nowIso()
    );
    return getRecallRun(id);
  }

  function getRecallRun(id) {
    const row = db.prepare("SELECT * FROM recall_runs WHERE id = ?").get(id);
    return toRecallRun(row);
  }

  function listRecallRuns({ limit = 50, offset = 0, query } = {}) {
    const { limit: lim, offset: off } = sanitizePage(limit, offset, 50);
    const clauses = [];
    const params = [];
    if (query) {
      clauses.push("query LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(String(query))}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(
      `SELECT * FROM recall_runs ${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`
    ).all(...params, lim, off);
    return rows.map(toRecallRun);
  }

  /**
   * Window scan for the recall-stats aggregation (#217): every recall_runs row
   * created at/after sinceIso, oldest first (rows[0].created_at = earliest
   * coverage marker), plus the untruncated window total so the caller can flag
   * a capped scan instead of silently undercounting. Read-only; `limit` exists
   * so tests can exercise the cap path without a 50k-row fixture.
   */
  function listRecallRunsSince(sinceIso, { limit = 50000 } = {}) {
    const total = db.prepare(
      "SELECT count(*) AS c FROM recall_runs WHERE created_at >= ?"
    ).get(sinceIso).c;
    const rows = db.prepare(
      "SELECT * FROM recall_runs WHERE created_at >= ? ORDER BY created_at ASC, id LIMIT ?"
    ).all(sinceIso, limit).map(toRecallRun);
    return { rows, total };
  }

  // --- recall evaluation trail (方案 B: separate from the production audit) -

  /**
   * Rolling purge of the recall_runs production audit (v0.7.0): with recordRecall
   * defaulting ON, the table would otherwise grow unboundedly on a busy store.
   * Drop rows older than `days` (config.recallRetentionDays, default 90).
   * created_at is an ISO TEXT string, so the ISO bound compares lexicographically.
   * Returns the number of rows deleted (bookkeeping — never throws on empty).
   *
   * 2026-10-14 找回：这一对（本函数 + index.js 的启动调用）在 dd0ed78「release:
   * v0.7.12 + 编码记忆(codingRetrospect)蒸馏/…（合并 #73 与 #74）」里被整块弄丢。
   * 该提交不是 merge（单亲 cb5ec63），store.js 是从一个没有这段的版本重建的，
   * 于是函数与调用一起蒸发，而配置键 recallRetentionDays、README.md 与
   * docs/CONFIGURATION.md 的「recall_runs 滚动清理保留天数」一直留到今天。
   * 实测后果（2026-10-14 快照）：本机 recall_runs 18,442 行、跨度 2026-09-08 →
   * 2026-10-13，即从那一天起只增不减。注意这张表是**活的、只增的**：同一个 10-13
   * 当天 14:43Z 是 18,442 行、20:47Z 已是 20,029 行，几小时就差一千五——所以任何
   * 行数只在测它的那一刻成立，引用时必须带时刻，否则日后对不上会被误读成出了错。
   * 这份审计里现在装的是用户原话，不是无信息的空串。
   */
  function purgeRecallRunsOlderThan(days) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const result = db.prepare("DELETE FROM recall_runs WHERE created_at < ?").run(cutoff);
    return result.changes;
  }

  /**
   * Persist one retrieval-evaluation snapshot into recall_evals — the test/eval
   * sibling of recall_runs, deliberately stored apart so eval snapshots never
   * inflate the production recall audit. Like the other audit tables this is
   * bookkeeping: it never triggers write hooks. Writes are idempotent on id
   * (replay overwrites, never duplicates), matching saveRecallRun. recall_run_id
   * optionally links the eval to the recall_runs row that captured the same
   * retrieval scene (FK-referenced, null when no run was recorded).
   */
  function saveRecallEval(evalRow) {
    const id = evalRow.id ?? randomUUID();
    db.prepare(
      `INSERT INTO recall_evals (id, recall_run_id, query, expected_ids, actual_ids, metrics, eval_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         recall_run_id=excluded.recall_run_id, query=excluded.query,
         expected_ids=excluded.expected_ids, actual_ids=excluded.actual_ids,
         metrics=excluded.metrics, eval_type=excluded.eval_type,
         created_at=excluded.created_at`
    ).run(
      id,
      evalRow.recall_run_id ?? null,
      evalRow.query,
      JSON.stringify(evalRow.expected_ids ?? []),
      JSON.stringify(evalRow.actual_ids ?? []),
      JSON.stringify(evalRow.metrics ?? {}),
      evalRow.eval_type ?? "manual",
      evalRow.created_at ?? nowIso()
    );
    return getRecallEval(id);
  }

  function getRecallEval(id) {
    const row = db.prepare("SELECT * FROM recall_evals WHERE id = ?").get(id);
    return toRecallEval(row);
  }

  function listRecallEvals({ limit = 50, offset = 0, query } = {}) {
    const { limit: lim, offset: off } = sanitizePage(limit, offset, 50);
    const clauses = [];
    const params = [];
    if (query) {
      clauses.push("query LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(String(query))}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(
      `SELECT * FROM recall_evals ${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`
    ).all(...params, lim, off);
    return rows.map(toRecallEval);
  }

  // --- llm audit trail (Bug8) ---------------------------------------------

  /**
   * Persist one LLM audit row (a background call's token/time/status receipt).
   * Bookkeeping like the other audit tables: it never triggers write hooks, so
   * recording a call can never loop back into the scheduler that made it. The
   * call itself is wrapped so a failure is captured (status='error') instead of
   * blocking the feature — only a throwing saveLlmAudit is swallowed, never the
   * LLM call.
   */
  function saveLlmAudit(entry) {
    const now = nowIso();
    const inTokens = Number.isFinite(entry.input_tokens) ? entry.input_tokens : 0;
    const outTokens = Number.isFinite(entry.output_tokens) ? entry.output_tokens : 0;
    db.prepare(
      `INSERT INTO llm_audit_logs (timestamp, trigger_source, operation_type, model_id,
        input_tokens, output_tokens, total_tokens, cost_usd, duration_ms, status,
        error_message, related_memory_ids, metadata, session_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.timestamp ?? now,
      entry.trigger_source,
      entry.operation_type,
      entry.model_id,
      inTokens,
      outTokens,
      Number.isFinite(entry.total_tokens) ? entry.total_tokens : inTokens + outTokens,
      Number.isFinite(entry.cost_usd) ? entry.cost_usd : 0,
      Number.isFinite(entry.duration_ms) ? entry.duration_ms : 0,
      entry.status ?? "success",
      entry.error_message ?? null,
      JSON.stringify(entry.related_memory_ids ?? []),
      entry.metadata !== undefined
        ? (typeof entry.metadata === "string" ? entry.metadata : JSON.stringify(entry.metadata))
        : null,
      entry.session_key ?? null
    );
    return toLlmAudit(db.prepare("SELECT * FROM llm_audit_logs ORDER BY id DESC LIMIT 1").get());
  }

  function listLlmAudits({ limit = 50, offset = 0, source, sessionKey } = {}) {
    const { limit: lim, offset: off } = sanitizePage(limit, offset, 50);
    const clauses = [];
    const params = [];
    if (source) {
      clauses.push("trigger_source = ?");
      params.push(source);
    }
    // #254 写入准入：会话内的话题回填只需要该会话的行（走 idx_llm_audit_session）。
    if (sessionKey) {
      clauses.push("session_key = ?");
      params.push(sessionKey);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(
      `SELECT * FROM llm_audit_logs ${where} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`
    ).all(...params, lim, off);
    return rows.map(toLlmAudit);
  }

  function countLlmAudits({ source, sessionKey } = {}) {
    const clauses = [];
    const params = [];
    if (source) {
      clauses.push("trigger_source = ?");
      params.push(source);
    }
    if (sessionKey) {
      clauses.push("session_key = ?");
      params.push(sessionKey);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`SELECT count(*) AS c FROM llm_audit_logs ${where}`).get(...params).c;
  }

  /**
   * Aggregate LLM spend over the last `days`: total calls/tokens/duration/cost,
   * broken down by trigger_source, by status, by operation_type and by day.
   * Used by the API's /llm-audit/stats endpoint so the Web panel can show
   * where budget goes.
   *
   * by_operation / by_day exist because by_source is too coarse for the
   * "where did the tokens go" panel: trigger_source merges dream_consolidate
   * and dream_summarize into one autoDream bucket, hiding the single largest
   * cost item (37% of 7-day tokens in the 2026-10 audit). by_day feeds the
   * 7-day trend bars. Both are additive — by_source/by_status keep their
   * shape (two tests assert on them).
   */
  function getLlmAuditStats({ days = 7 } = {}) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const total = db.prepare(
      `SELECT count(*) AS c,
              COALESCE(SUM(input_tokens), 0) AS i,
              COALESCE(SUM(output_tokens), 0) AS o,
              COALESCE(SUM(total_tokens), 0) AS t,
              COALESCE(SUM(duration_ms), 0) AS d,
              COALESCE(SUM(cost_usd), 0) AS cst
       FROM llm_audit_logs WHERE timestamp >= ?`
    ).get(since);
    const bySource = db.prepare(
      `SELECT trigger_source AS source, count(*) AS c,
              COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM llm_audit_logs WHERE timestamp >= ?
       GROUP BY trigger_source ORDER BY total_tokens DESC`
    ).all(since);
    const byStatus = db.prepare(
      "SELECT status, count(*) AS c FROM llm_audit_logs WHERE timestamp >= ? GROUP BY status"
    ).all(since);
    const byOperation = db.prepare(
      `SELECT operation_type AS operation, count(*) AS c,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM llm_audit_logs WHERE timestamp >= ?
       GROUP BY operation_type ORDER BY total_tokens DESC`
    ).all(since);
    const byDay = db.prepare(
      `SELECT date(timestamp) AS day, count(*) AS c,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM llm_audit_logs WHERE timestamp >= ?
       GROUP BY date(timestamp) ORDER BY day ASC`
    ).all(since);
    return {
      days,
      since,
      total_calls: total.c,
      input_tokens: total.i,
      output_tokens: total.o,
      total_tokens: total.t,
      total_duration_ms: total.d,
      total_cost_usd: Number(total.cst),
      by_source: bySource,
      by_status: byStatus,
      by_operation: byOperation,
      by_day: byDay
    };
  }

  /** Delete audit rows older than `before` (ISO string). Returns count removed. */
  function deleteOldLlmAudits(before) {
    return db.prepare("DELETE FROM llm_audit_logs WHERE timestamp < ?").run(before).changes;
  }

  // --- 蒸馏原始记录与记忆级溯源（#399）-------------------------------------

  /**
   * 落盘一个蒸馏窗口的公开记录（#399）。
   *
   * `INSERT OR IGNORE` 而非 OR REPLACE：主键 (session_id, seq) 的冲突只可能来自
   * **同一窗口的重跑**（max-runs 门耗尽额度、宿主重启都会重跑同一 seq 段，见
   * summarize.js 里「max-runs 刻意不消费游标」的注释），而重跑必须幂等——同一
   * seq 的原文没有第二次「更真」的版本，保留首次落盘时间才诚实。
   * @param {Array<{seq:number, role:string, text:string, windowId?:string, distilledAt:string}>} records
   * @returns {number} 实际插入行数（被忽略的冲突不计）
   */
  function saveDistillRecords(records) {
    if (!Array.isArray(records) || records.length === 0) return 0;
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO distill_records (session_id, seq, role, text, window_id, distilled_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    let inserted = 0;
    for (const r of records) {
      inserted += stmt.run(r.sessionId, r.seq, r.role, r.text, r.windowId ?? null, r.distilledAt).changes;
    }
    return inserted;
  }

  /**
   * 到期记录统计（#275 回收报告口径，dry-run 用）。`bytes` 是列文本大小上界。
   * @returns {{rows: number, bytes: number}}
   */
  function distillRecordStats(before) {
    const row = db.prepare(
      `SELECT count(*) AS c, COALESCE(SUM(LENGTH(text)), 0) AS b
         FROM distill_records WHERE distilled_at < ?`
    ).get(before);
    return { rows: row.c, bytes: row.b };
  }

  /**
   * 删除到期原始记录。返回实际删除行数。
   *
   * 只删 distill_records——memory_provenance 的链接**刻意保留**并从此指向空区间，
   * 面板/CLI 显示「来源已过期」。级联删链接会把「这条记忆有来源、只是来源到期」
   * 降级成「这条记忆无来源」，把可观测性削成不可观测（#399 删除语义）。
   */
  function clearDistillRecords(before) {
    return db.prepare("DELETE FROM distill_records WHERE distilled_at < ?").run(before).changes;
  }

  /**
   * 记一条记忆级溯源链接（#399）：某条记忆派生自某会话的 seq 区间。
   *
   * `ON CONFLICT DO NOTHING` 配合 idx_memory_provenance_link 唯一索引吸收同窗口
   * 重跑的重复链接（否则幂等测试锁会挂）。
   * @returns {number} 实际插入行数
   */
  function saveMemoryProvenance({ memoryId, sessionId, seqStart, seqEnd, createdAt }) {
    return db.prepare(
      `INSERT INTO memory_provenance (memory_id, session_id, seq_start, seq_end, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`
    ).run(memoryId, sessionId, seqStart, seqEnd, createdAt).changes;
  }

  /** 一条记忆的全部溯源链接（#399 面板/CLI 读取面）。 */
  function provenanceFor(memoryId) {
    return db.prepare(
      `SELECT memory_id, session_id, seq_start, seq_end, created_at
         FROM memory_provenance WHERE memory_id = ? ORDER BY created_at, session_id, seq_start`
    ).all(memoryId);
  }

  // --- 存储生命周期：无损回收（#275 第一批）--------------------------------
  //
  // 两项都零价值判断、零条数变化：行数不变，只把不可重建/不可达的内容丢掉。
  // 删行不在本模块里（维护者拍板 3：裁列同意、删行不同意）——dream_runs 的骨架、
  // LLM 决策原文与 receipt 永不删。

  /**
   * 历史 run 的输入快照统计（#275 A 项，dry-run 用）。
   *
   * `input` 这一列的含义**按 run_type 分叉**：auto / sleep 的 run 存的是当时的记忆库
   * 快照（可由记忆库重建），organize 的 run 存的是 apply 的重放载荷——`organize.js`
   * 的 apply 直接读它（`snapshot = Array.isArray(report.input) ? report.input : []`），
   * 置空会让 apply 找不到候选、静默什么都不做却照写回执并盖上 applied_at，那份报告
   * 从此永远重放不了。所以 organize 行不在可清范围里（同一列，两种语义，只能按 type 分）。
   *
   * `bytes` 是列文本大小，只作上界（真实释放看 VACUUM 前后）。
   * @returns {{runs: number, bytes: number}}
   */
  function dreamRunInputStats(before) {
    const row = db.prepare(
      `SELECT count(*) AS c, COALESCE(SUM(LENGTH(input)), 0) AS b
         FROM dream_runs
        WHERE input IS NOT NULL AND created_at < ? AND run_type != 'organize'`
    ).get(before);
    return { runs: row.c, bytes: row.b };
  }

  /** 置空历史 run 的输入快照（organize 的重放载荷除外）。返回实际改动的行数。 */
  function clearDreamRunInputs(before) {
    return db.prepare(
      `UPDATE dream_runs SET input = NULL
        WHERE input IS NOT NULL AND created_at < ? AND run_type != 'organize'`
    ).run(before).changes;
  }

  /**
   * 归档行仍带的向量统计（#275 B 项）。检索 SQL 恒带 `archived = 0`，所以这部分
   * 向量按定义不可达，清掉不改变任何检索结果。
   * @returns {{rows: number, bytes: number}}
   */
  function archivedEmbeddingStats() {
    const row = db.prepare(
      `SELECT count(*) AS c, COALESCE(SUM(LENGTH(embedding)), 0) AS b
         FROM memories WHERE archived = 1 AND embedding IS NOT NULL`
    ).get();
    return { rows: row.c, bytes: row.b };
  }

  /** 清掉归档行的向量。返回实际改动行数。 */
  function clearArchivedEmbeddings() {
    const changed = db.prepare(
      "UPDATE memories SET embedding = NULL WHERE archived = 1 AND embedding IS NOT NULL"
    ).run().changes;
    // Issue #202 的单条失效点在 setEmbedding 里，批量清走不到它——整表清缓存最省事，
    // 代价只是活跃行下次检索多解析一次（FIFO 上限 4000，自愈）。
    if (changed > 0) embeddingCache.clear();
    return changed;
  }

  /**
   * 库文件与页统计（#275 报告口径）：回收收益按 VACUUM 前后体积量，不按列字节估——
   * 实际释放来自溢出页与索引页的回收，列文本大小只是上界。
   *
   * 体积是**磁盘足迹**：WAL 模式下主文件之外还有 `-wal` / `-shm`，只量主文件会把
   * 「刚清完还没落盘」的那部分算漏（实测过：VACUUM 后主文件可能一动不动，要等一次
   * checkpoint）。所以三份一起量；`:memory:` 库没有文件。
   */
  function storageStats() {
    const pageSize = db.prepare("PRAGMA page_size").get().page_size;
    const pageCount = db.prepare("PRAGMA page_count").get().page_count;
    const freelistCount = db.prepare("PRAGMA freelist_count").get().freelist_count;
    const sizeOf = (p) => {
      try {
        return statSync(p).size;
      } catch {
        return 0;
      }
    };
    let fileBytes = null;
    if (typeof path === "string" && path !== ":memory:") {
      fileBytes = sizeOf(path) + sizeOf(`${path}-wal`) + sizeOf(`${path}-shm`);
    }
    return { path: typeof path === "string" ? path : null, pageSize, pageCount, freelistCount, fileBytes };
  }

  /**
   * 整库 VACUUM（#275 的手动步骤）：代价 O(库大小) 且需要排他写锁，所以只在显式
   * 入口里跑，绝不挂启动路径、也不开 auto_vacuum。
   *
   * 收尾补一次 `wal_checkpoint(TRUNCATE)`：WAL 模式下 VACUUM 重排的是主文件里的页，
   * 已回收的空间可能还挂在 WAL 里，不 checkpoint 就量不到体积下降——报告口径要的是
   * 真实释放量，量不到等于没做（评审实测：VACUUM 后主文件长度不变，checkpoint 后才降）。
   */
  function vacuum() {
    const started = Date.now();
    db.exec("VACUUM");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return { duration_ms: Date.now() - started };
  }

  // --- failure memories ----------------------------------------------------

  /**
   * Persist one failure record (user correction, failed expectation, etc.).
   * Like the dream audit trail this is bookkeeping: it never triggers write
   * hooks, so reflection mining of failures cannot loop back into the writer.
   */
  function saveFailure({ id, query, expected, actual, before, failure_type, memory_id }) {
    const now = nowIso();
    const beforeJson = before && typeof before === "object" ? JSON.stringify(before) : (before ?? null);
    db.prepare(
      `INSERT INTO failure_memories (id, query, expected, actual, before, failure_type, memory_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id ?? randomUUID(), query ?? null, expected ?? null, actual ?? null, beforeJson, failure_type, memory_id ?? null, now);
    return { id, query, expected, actual, before: before ?? null, failure_type, memory_id, created_at: now };
  }

  function listFailures({ limit = 50, offset = 0, since, memory_id, failure_type } = {}) {
    const clauses = [];
    const params = [];
    if (since) { clauses.push("created_at >= ?"); params.push(since); }
    if (memory_id) { clauses.push("memory_id = ?"); params.push(memory_id); }
    if (failure_type) { clauses.push("failure_type = ?"); params.push(failure_type); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const lim = Number.isInteger(limit) && limit > 0 ? limit : 50;
    const off = Number.isInteger(offset) && offset > 0 ? offset : 0;
    return db.prepare(`SELECT * FROM failure_memories ${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`).all(...params, lim, off)
      .map((row) => {
        let before;
        try { before = row.before ? JSON.parse(row.before) : null; } catch { before = null; }
        return { ...row, before };
      });
  }

  /** Delete failure rows older than `before` (ISO string). Returns count removed. */
  function deleteOldFailures(before) {
    return db.prepare("DELETE FROM failure_memories WHERE created_at < ?").run(before).changes;
  }

  // --- conflict freeze: pending manual review ------------------------------

  /**
   * Park a detected conflict for human review (conflict freeze mode). The pair
   * order is normalized (sorted by id) so the same two memories are only ever
   * pending once — a re-detection in a later dream run is a no-op, never a
   * duplicate queue entry. Returns the pending row (freshly inserted, or the
   * existing unresolved row when the pair is already pending), or undefined
   * when the re-detection is suppressed.
   *
   * v0.8.1（issue #170 复核项 4）：人工已裁决过的对（resolved_at 非空）不再
   * 反复入队——除非任一侧在裁决之后又被改过（updated_at 晚于 resolved_at）。
   * 否则跨 scope 对每轮 sleep 都原样回来，把「保留双方」的决定变成噪声。
   * updated_at 是宽松代理（任何字段更新都会触发重新评审）——宁可多看一眼，
   * 不静音真冲突。
   */
  function saveConflictPending({ run_id, memory_a, memory_b, reason }) {
    const [a, b] = [memory_a, memory_b].sort();
    const existing = db.prepare(
      "SELECT * FROM conflict_pending WHERE memory_a = ? AND memory_b = ? AND resolved_at IS NULL LIMIT 1"
    ).get(a, b);
    if (existing) return toConflictPending(existing);
    const reviewed = db.prepare(
      "SELECT * FROM conflict_pending WHERE memory_a = ? AND memory_b = ? AND resolved_at IS NOT NULL ORDER BY resolved_at DESC, rowid DESC LIMIT 1"
    ).get(a, b);
    if (reviewed) {
      const touched = db.prepare(
        "SELECT count(*) AS c FROM memories WHERE id IN (?, ?) AND updated_at > ?"
      ).get(a, b, reviewed.resolved_at).c;
      if (touched === 0) return undefined;
    }
    const id = randomUUID();
    const now = nowIso();
    db.prepare(
      `INSERT INTO conflict_pending (id, run_id, memory_a, memory_b, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, run_id ?? null, a, b, reason ?? null, now);
    return toConflictPending(db.prepare("SELECT * FROM conflict_pending WHERE id = ?").get(id));
  }

  /**
   * List pending conflicts, newest first. Unresolved rows only by default;
   * pass includeResolved to include resolved ones (audit view).
   */
  function listConflictPending({ limit = 50, offset = 0, includeResolved = false } = {}) {
    const { limit: lim, offset: off } = sanitizePage(limit, offset, 50);
    const clauses = [];
    const params = [];
    if (!includeResolved) clauses.push("resolved_at IS NULL");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(
      `SELECT * FROM conflict_pending ${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`
    ).all(...params, lim, off);
    return rows.map(toConflictPending);
  }

  /**
   * Mark a pending conflict as reviewed. winner (optional) records which side
   * the human chose, keeping the resolution auditable. Returns the updated row,
   * or undefined for an unknown id.
   */
  function resolveConflictPending(id, { winner } = {}) {
    const row = db.prepare("SELECT * FROM conflict_pending WHERE id = ?").get(id);
    if (!row) return undefined;
    db.prepare("UPDATE conflict_pending SET resolved_at = ?, resolved_winner = ? WHERE id = ?")
      .run(nowIso(), winner ?? null, id);
    return toConflictPending(db.prepare("SELECT * FROM conflict_pending WHERE id = ?").get(id));
  }

  /** Number of unresolved (awaiting review) pending conflicts. */
  function countConflictPending() {
    return db.prepare(
      "SELECT count(*) AS c FROM conflict_pending WHERE resolved_at IS NULL"
    ).get().c;
  }

  /**
   * v0.8.1 底座（issue #170）：scope 归属人工修正的审计行。record 描述「一次
   * 决策后的完整状态」（prev_* 为改前、next_* 为改后，NULL=global/未标注），
   * 由调用方（service.updateMemory）在 store.update 成功后写入；本函数不做
   * 业务校验，只保证审计落库失败不反噬主写入（异常上抛由调用方吞掉记 warn）。
   */
  function saveScopeChange({ memory_id, actor, prev_agent_scope, prev_workspace_scope, next_agent_scope, next_workspace_scope, agent_scope_source, workspace_scope_source, decided_at }) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO scope_changes (id, memory_id, actor, prev_agent_scope, prev_workspace_scope, next_agent_scope, next_workspace_scope, agent_scope_source, workspace_scope_source, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      memory_id,
      actor === "panel" ? "panel" : "tool",
      normalizeScopeText(prev_agent_scope),
      normalizeScopeText(prev_workspace_scope),
      normalizeScopeText(next_agent_scope),
      normalizeScopeText(next_workspace_scope),
      normalizeScopeSource(agent_scope_source),
      normalizeScopeSource(workspace_scope_source),
      normalizeOccurredAt(decided_at) ?? nowIso()
    );
    return toScopeChange(db.prepare("SELECT * FROM scope_changes WHERE id = ?").get(id));
  }

  /** Scope 修正审计（单条记忆，新→旧）。审计回放与候选复核用。 */
  function listScopeChanges(memoryId, { limit = 50 } = {}) {
    const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
    // tiebreaker 用 rowid（追加写入的单调序）而非 id：decided_at 只有毫秒精度，
    // 连续两次修正落在同一毫秒时 UUID 排序是随机的（CI windows/node24 抓到的
    // 真实 flake）——审计回放要求「最新一条」确定。
    const rows = db.prepare(
      "SELECT * FROM scope_changes WHERE memory_id = ? ORDER BY decided_at DESC, rowid DESC LIMIT ?"
    ).all(memoryId, lim);
    return rows.map(toScopeChange);
  }

  function getFailureStats({ since } = {}) {
    const clause = since ? "WHERE created_at >= ?" : "";
    const params = since ? [since] : [];
    const rows = db.prepare(
      `SELECT failure_type, count(*) AS c FROM failure_memories ${clause} GROUP BY failure_type`
    ).all(...params);
    const stats = {};
    for (const row of rows) stats[row.failure_type] = row.c;
    return stats;
  }

  // --- entity gene: named entities + time-boxed attrs + relations (v0.3.0) --

  /**
   * Create a named entity. A fresh mention always records first_seen = now;
   * repeated sightings should call updateEntity (which bumps mention_count and
   * refreshes last_seen) rather than creating duplicate rows.
   */
  function createEntity({ name, type }) {
    const id = randomUUID();
    const now = nowIso();
    db.prepare(
      `INSERT INTO entities (id, name, type, first_seen, last_seen, mention_count, canonical_memory_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, name, type ?? null, now, now, 1, null);
    return toEntity(db.prepare("SELECT * FROM entities WHERE id = ?").get(id));
  }

  function findEntityByName(name) {
    return toEntity(db.prepare("SELECT * FROM entities WHERE name = ?").get(name));
  }

  function findEntityById(id) {
    return toEntity(db.prepare("SELECT * FROM entities WHERE id = ?").get(id));
  }

  /**
   * Apply a partial update to an entity, always refreshing last_seen. The
   * mention counter increments on every sighting unless the caller overrides
   * it explicitly via patch.mention_count (e.g. to correct a count).
   */
  function updateEntity(id, patch) {
    const old = findEntityById(id);
    if (!old) return undefined;
    const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
    const name = has("name") ? patch.name : old.name;
    const type = has("type") ? patch.type : old.type;
    const canonical_memory_id = has("canonical_memory_id")
      ? patch.canonical_memory_id
      : old.canonical_memory_id;
    const mention_count = has("mention_count")
      ? patch.mention_count
      : (old.mention_count ?? 1) + 1;
    const now = nowIso();
    db.prepare(
      `UPDATE entities SET name = ?, type = ?, last_seen = ?, mention_count = ?, canonical_memory_id = ? WHERE id = ?`
    ).run(name, type ?? null, now, mention_count, canonical_memory_id ?? null, id);
    return findEntityById(id);
  }

  /**
   * Record an attribute value for an entity. The previous value for the same
   * entity+key is invalidated (valid_until = now) before the new row is
   * inserted, so exactly one row per entity+key is current (valid_until IS NULL).
   */
  function saveAttr({ entity_id, attr_key, attr_value, memory_id, confidence, source }) {
    const now = nowIso();
    invalidateOldAttr(entity_id, attr_key, now);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO entity_attrs (id, entity_id, attr_key, attr_value, memory_id, valid_from, valid_until, confidence, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, entity_id, attr_key, attr_value, memory_id ?? null, now, null, confidence ?? 1.0, source ?? null);
    return toAttr(db.prepare("SELECT * FROM entity_attrs WHERE id = ?").get(id));
  }

  /** Mark every currently-valid attr row for entityId+attrKey as expired. Returns rows changed. */
  function invalidateOldAttr(entityId, attrKey, now) {
    return db.prepare(
      `UPDATE entity_attrs SET valid_until = ? WHERE entity_id = ? AND attr_key = ? AND valid_until IS NULL`
    ).run(now, entityId, attrKey).changes;
  }

  /** Only the live value per attr_key (valid_until IS NULL). */
  function getCurrentAttrs(entityId) {
    return db.prepare(
      "SELECT * FROM entity_attrs WHERE entity_id = ? AND valid_until IS NULL"
    ).all(entityId).map(toAttr);
  }

  /** Full history per attr_key, oldest first. */
  function getAttrHistory(entityId) {
    return db.prepare(
      "SELECT * FROM entity_attrs WHERE entity_id = ? ORDER BY valid_from"
    ).all(entityId).map(toAttr);
  }

  /**
   * All attr rows carrying a reference to the given memory (any valid state),
   * oldest first. Used by autoDream's update path to record what an update
   * superseded (v0.3.0 Phase 4 / 4.3.1).
   */
  function getAttrsByMemory(memoryId) {
    return db.prepare(
      "SELECT * FROM entity_attrs WHERE memory_id = ? ORDER BY valid_from ASC"
    ).all(memoryId).map(toAttr);
  }

  /**
   * 一条记忆关联到的实体（记忆详情侧栏用）：entity_attrs.memory_id 反查实体，
   * 一条 JOIN 完成。同一记忆对同一实体的多次提及（多条 attr 行）按 name 去重，
   * 每个实体只出现一次，按提及次数降序。只取 name/type——attr 详情走
   * entity-attrs 端点。无关联（或记忆不存在）返回空数组。
   */
  function entitiesForMemory(memoryId) {
    const rows = db.prepare(
      `SELECT e.id, e.name, e.type, e.mention_count, e.last_seen
       FROM entity_attrs ea JOIN entities e ON e.id = ea.entity_id
       WHERE ea.memory_id = ?
       GROUP BY e.id
       ORDER BY e.mention_count DESC, e.last_seen DESC, e.name ASC`
    ).all(memoryId ?? "");
    const seen = new Set();
    const out = [];
    for (const row of rows) {
      if (seen.has(row.name)) continue;
      seen.add(row.name);
      out.push({ name: row.name, type: row.type ?? null });
    }
    return out;
  }

  /**
   * Memories carrying a currently-valid attr matching key=value (deduped).
   * When value is empty/undefined, the attr_value filter is dropped and every
   * currently-valid memory for that attr_key is returned — the "attr:key"
   * (no =value) contract, v0.3.0. Only live rows (valid_until IS NULL) with a
   * memory reference participate, and each memory appears at most once.
   */
  function findMemoriesByAttr(key, value) {
    const empty = value === undefined || value === null || value === "";
    const sql = empty
      ? `SELECT DISTINCT memory_id FROM entity_attrs
         WHERE attr_key = ? AND valid_until IS NULL
           AND memory_id IS NOT NULL AND memory_id != ''`
      : `SELECT DISTINCT memory_id FROM entity_attrs
         WHERE attr_key = ? AND attr_value = ? AND valid_until IS NULL
           AND memory_id IS NOT NULL AND memory_id != ''`;
    const params = empty ? [key] : [key, value];
    const rows = db.prepare(sql).all(...params);
    const memories = [];
    const stmt = db.prepare("SELECT * FROM memories WHERE id = ?");
    for (const { memory_id } of rows) {
      const row = stmt.get(memory_id);
      if (row) memories.push(toRow(row));
    }
    return memories;
  }

  /**
   * Record a typed relation between two entities. metadata (optional) is a
   * free-form JSON blob describing the relation. Relations are append-only.
   *
   * issue #24 块2（权重演化）：source 决定边初值——manual 1.0 / confirmed
   * 保持 / tag 0.3 / llm 0.4；显式传入 weight 时优先于 source 映射（manual
   * 建边可自带权重）。哲学「关系是用出来的，不是建出来的」：初值只反映来源
   * 偏见，真正的抬升留给 bumpRelationWeight（touch 门控驱动）。
   */
  function saveRelation({ from_entity, to_entity, relation_type, memory_id, metadata, weight, source }) {
    const id = randomUUID();
    const now = nowIso();
    const metaStr = metadata === undefined
      ? null
      : typeof metadata === "string"
        ? metadata
        : JSON.stringify(metadata);
    const src = source ?? "manual";
    // 只认映射表的自有键：src="constructor"/"toString" 会命中原型链上的函数，直接查表
    // 拿到的是函数而非权重（绑进 SQL 就是整条写入抛错），必须回退默认 1.0。
    const w = weight ?? (Object.hasOwn(RELATION_SOURCE_DEFAULTS, src) ? RELATION_SOURCE_DEFAULTS[src] : 1.0);
    db.prepare(
      `INSERT INTO entity_relations (id, from_entity, to_entity, relation_type, memory_id, created_at, metadata, weight, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, from_entity, to_entity, relation_type, memory_id ?? null, now, metaStr, w, src);
    return toRelation(db.prepare("SELECT * FROM entity_relations WHERE id = ?").get(id));
  }

  /**
   * 边权重演化（issue #24 块2）。只加不减、封顶 1.0——权重只能靠「被用」抬升、
   * 不能靠被人为敲低，封顶防触达过频把边吹到无意义大。
   * 下界守在这里而不是调用方：增量为负/非有限数一律拒绝（返回 false）。限幅只留
   * 上界、把「只加不减」托付给配置范围，等于把存储接口的契约挂在调用方自觉上。
   * 读改写合并成单条 UPDATE（MIN(1.0, weight + ?)）：memoryDir 可被多进程共用，
   * 先 SELECT 再 UPDATE 会丢并发增量，还会拿旧值把别人已抬升的权重压回去。
   * 幂等（缺行 changes=0 → false）；delta 默认 0.1，由调用方（touch 门控）决定
   * 何时算一次有效触达。**作用在关系行**，与 memories 的 last_accessed_at 是两码
   * 事：这条是针对「这条边被激活了」的演化。
   */
  function bumpRelationWeight(id, delta = 0.1) {
    if (!Number.isFinite(delta) || delta < 0) return false;
    const result = db.prepare(
      "UPDATE entity_relations SET weight = MIN(1.0, weight + ?) WHERE id = ?"
    ).run(delta, id);
    return result.changes > 0;
  }

  /**
   * Re-point every attr row whose memory_id is fromMemoryId to toMemoryId
   * (autoDream merge migration, v0.3.0 Phase 4 / 4.3.2). When the keeper
   * already carries a live attr for the same entity+key, the source row is
   * superseded and invalidated instead (the keeper's value wins). Returns
   * { migrated, invalidated }.
   */
  function migrateAttrsToMemory(fromMemoryId, toMemoryId, now) {
    let migrated = 0;
    let invalidated = 0;
    const attrs = db.prepare(
      "SELECT * FROM entity_attrs WHERE memory_id = ?"
    ).all(fromMemoryId);
    for (const attr of attrs) {
      // 仅当 keeper 已有同 entity+key 的当前有效属性才视为被替代（限定 memory_id，
      // 避免把 loser 自身的 live 行误判为 keeper 行）。
      const keeperLive = db.prepare(
        "SELECT id FROM entity_attrs WHERE entity_id = ? AND attr_key = ? AND valid_until IS NULL AND memory_id = ?"
      ).get(attr.entity_id, attr.attr_key, toMemoryId);
      if (keeperLive) {
        db.prepare(
          "UPDATE entity_attrs SET valid_until = ? WHERE id = ?"
        ).run(now, attr.id);
        invalidated++;
      } else {
        db.prepare(
          "UPDATE entity_attrs SET memory_id = ? WHERE id = ?"
        ).run(toMemoryId, attr.id);
        migrated++;
      }
    }
    return { migrated, invalidated };
  }

  /** Relations where the entity appears on either side (from or to). */
  function getRelations(entityId) {
    return db.prepare(
      "SELECT * FROM entity_relations WHERE from_entity = ? OR to_entity = ?"
    ).all(entityId, entityId).map(toRelation);
  }

  /**
  /**
   * 批量邻接（issue #24 · 块1 锚定层级联）：给定多条实体 id，一并取全部关系行
   * 并归并成「每个实体 → 相邻实体 id 去重列表」的邻接表。供 anchoring.js 的
   * cascadeDepths 使用——多实体一族只需要一次 SQL（IN 查询），比逐实体调
   * getRelations 的 N 次往返省。邻接是无向的（from/to 双向），往返不重复。
   * 返回 Map<entityId, Array<entityId>>；未命中的实体缺省为 absent（级联视为
   * 无邻居，Map 里不放键同行，null 同等对待）。
   */
  function getEntityNeighbors(entityIds) {
    const out = new Map();
    const ids = Array.isArray(entityIds) ? entityIds.filter(Boolean) : [];
    if (!ids.length) return out;
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT from_entity, to_entity FROM entity_relations
       WHERE from_entity IN (${placeholders}) OR to_entity IN (${placeholders})`
    ).all(...ids, ...ids);
    for (const r of rows) {
      addNeighbor(out, r.from_entity, r.to_entity, ids);
      addNeighbor(out, r.to_entity, r.from_entity, ids);
    }
    return out;
  }

  function addNeighbor(out, anchor, neighbor, queryIds) {
    if (!queryIds.includes(anchor)) return; // 只以查询过的实体为锚
    if (neighbor === anchor) return;        // 自环不构成扩散边
    if (!out.has(anchor)) out.set(anchor, []);
    const list = out.get(anchor);
    if (!list.includes(neighbor)) list.push(neighbor);
  }

  /**
   * 按记忆反查关联边（issue #24 块4 被动确认）：一条记忆被召回/注入（触达）
   * 时，挂在同一记忆上的关系行即「这条关系被用过了」的证据——正常触达视为
   * 被动确认，调用方据此 bumpRelationWeight。返回 toRelation 行（含 weight/
   * source）。索引 idx_relations_memory 已建（#219）。
   */
  function getRelationsByMemory(memoryId) {
    if (!memoryId) return [];
    return db.prepare(
      "SELECT * FROM entity_relations WHERE memory_id = ?"
    ).all(memoryId).map(toRelation);
  }

  /** All entities (optionally name-filtered, newest first). Used by sleep phase 4
   *  orphan detection: an entity with zero relations is a candidate for relation
   *  completion. */
  function listEntities({ limit = 1000 } = {}) {
    const rows = db.prepare(
      "SELECT * FROM entities ORDER BY last_seen DESC, name ASC LIMIT ?"
    ).all(limit);
    return rows.map(toEntity);
  }

  // --- 图召回轴（issue #219）-------------------------------------------------

  /**
   * 找出名称出现在文本中的实体（图召回的查询侧匹配）。大小写折叠在 JS 侧做
   * （SQLite lower() 只折 ASCII，JS toLowerCase 覆盖全 Unicode）；名称长度
   * 下限 2，防单字符实体把任意查询吃成万金油命中。entities 表量级小（千级），
   * 线性扫描的查询期成本可忽略。返回按名称长度降序的 {id, name}——更具体的
   * 长名字优先占 limit 名额。
   */
  function findEntitiesMentionedIn(text, { limit = 5 } = {}) {
    const hay = String(text ?? "").toLowerCase();
    if (!hay) return [];
    const rows = db.prepare("SELECT id, name FROM entities WHERE length(name) >= 2").all();
    const hits = [];
    for (const row of rows) {
      if (hay.includes(row.name.toLowerCase())) hits.push({ id: row.id, name: row.name });
    }
    hits.sort((a, b) => b.name.length - a.name.length);
    return hits.slice(0, limit);
  }

  /**
   * 给定实体 id 集合，反查挂联的记忆 id，带连接层级（图召回的候选侧）。
   * tier "attr" = 当前有效属性行直接挂的记忆（与 searchByEntity 同口径，
   * valid_until IS NULL）；tier "relation" = 实体作为 from/to 出现的关系行
   * 所挂记忆。两层都排除空 memory_id；同一记忆两条边都有时取更强的 attr。
   * 返回 Map<memory_id, "attr" | "relation">。
   */
  function getLinkedMemoryIds(entityIds) {
    const out = new Map();
    if (!Array.isArray(entityIds) || !entityIds.length) return out;
    const placeholders = entityIds.map(() => "?").join(",");
    const attrRows = db.prepare(
      `SELECT DISTINCT memory_id FROM entity_attrs
       WHERE valid_until IS NULL AND memory_id IS NOT NULL AND memory_id != ''
         AND entity_id IN (${placeholders})`
    ).all(...entityIds);
    for (const r of attrRows) out.set(r.memory_id, "attr");
    const relRows = db.prepare(
      `SELECT DISTINCT memory_id FROM entity_relations
       WHERE memory_id IS NOT NULL AND memory_id != ''
         AND (from_entity IN (${placeholders}) OR to_entity IN (${placeholders}))`
    ).all(...entityIds, ...entityIds);
    for (const r of relRows) if (!out.has(r.memory_id)) out.set(r.memory_id, "relation");
    return out;
  }

  // --- mirror sync state (F-NEW-03) -----------------------------------------

  /**
   * Upsert the single mirror_state row (id='main'). patch accepts
   * {dirty?, last_error?, last_attempt?, success_at?, generation?,
   * applied_generation?, type_status?} — only the keys present on the object
   * are written, everything else is left untouched (partial upsert). type_status
   * is stored as JSON text (objects are serialized on write), generation /
   * applied_generation are coerced to non-negative integers. Returns the freshly
   * read state row (default shape when absent).
   */
  function setMirrorState(patch) {
    const ALLOWED = new Set([
      "dirty",
      "last_error",
      "last_attempt",
      "success_at",
      "generation",
      "applied_generation",
      "type_status"
    ]);
    const keys = Object.keys(patch).filter(
      (key) => ALLOWED.has(key) && Object.prototype.hasOwnProperty.call(patch, key)
    );
    if (keys.length === 0) {
      db.prepare(
        "INSERT INTO mirror_state (id) VALUES ('main') ON CONFLICT(id) DO NOTHING"
      ).run();
      return getMirrorState();
    }
    // 列同时出现在 INSERT 与 ON CONFLICT 里（excluded.*），保证首次插入也写入
    // patch 值，而不只是默认值；未传入的列保持不变（partial upsert）。
    const cols = [];
    const values = [];
    const updates = [];
    for (const key of keys) {
      let value = patch[key];
      if (key === "dirty") {
        value = value ? 1 : 0;
      } else if (key === "generation" || key === "applied_generation") {
        // Fail-closed integer enforcement (audit peer F): never truncate. A
        // fractional value like 1.5 previously passed the JS gate via
        // Math.trunc while SQLite's CHECK (>= 0) silently accepted it too, so a
        // dirty legacy row could carry a non-integer generation that reads as a
        // coherent applied round. Reject non-integers outright — the caller must
        // pass a whole number, and a stale dirty value stays visible instead of
        // being "repaired" into a misleading clean integer.
        value = Number(value);
        if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
          throw new RangeError(`mirror_state.${key} out of range: ${value}`);
        }
      } else if (key === "type_status" && value != null && typeof value !== "string") {
        value = JSON.stringify(value);
      }
      cols.push(key);
      values.push(value);
      updates.push(`${key} = excluded.${key}`);
    }
    const placeholders = cols.map(() => "?").join(", ");
    db.prepare(
      `INSERT INTO mirror_state (id, ${cols.join(", ")}) VALUES ('main', ${placeholders})
       ON CONFLICT(id) DO UPDATE SET ${updates.join(", ")}`
    ).run(...values);
    return getMirrorState();
  }

  /** Current mirror state; default {dirty:0, last_error:null, last_attempt:null, success_at:null, generation:0, applied_generation:0, type_status:{}} when absent. */
  function getMirrorState() {
    const row = db.prepare("SELECT * FROM mirror_state WHERE id = 'main'").get();
    return toMirrorState(row);
  }

  /**
   * Mark the mirror dirty after a failed sync (dirty=1 + last_error +
   * last_attempt). v0.3.6: also bumps the desired generation so the debt is
   * bound to a specific sync round; applied_generation is left untouched
   * (the round was NOT applied). A stale worker that started earlier cannot
   * clear this newer debt — only a clean fenced to a generation at least as
   * recent as this one may.
   */
  function markMirrorDirty(error, now) {
    // Bump the desired generation atomically first — the new debt must be bound
    // to a fresh round so a stale worker cannot fence-clean it. Even if this
    // write fails (peer blocker 2), generation still advanced, so recoverMirror
    // sees generation > applied_generation and retries rather than false-clean.
    incrementGeneration();
    return setMirrorState({
      dirty: 1,
      last_error: error,
      last_attempt: now ?? nowIso()
    });
  }

  /**
   * Fenced clean (CAS): mark the mirror clean for a specific generation.
   * First records that generation `gen` has been applied
   * (applied_generation = MAX(applied_generation, gen)), then clears dirty only
   * when the current desired generation has not advanced past gen — a stale
   * worker cleaning an older round must not wipe a newer failure's debt.
   * Returns the resulting state (dirty stays set when the fence holds).
   */
  function markMirrorCleanForGeneration(gen, now) {
    const current = getMirrorState();
    const applied = Math.max(current.applied_generation || 0, gen);
    const patch = { applied_generation: applied };
    if (applied >= gen && (current.generation || 0) <= gen) {
      patch.dirty = 0;
      patch.last_error = null;
      patch.success_at = now ?? nowIso();
    }
    return setMirrorState(patch);
  }

  /** Convenience: mark the mirror clean for the current desired generation (backward-compatible with pre-v0.3.6 callers). */
  function markMirrorClean(now) {
    const current = getMirrorState();
    return markMirrorCleanForGeneration(current.generation || 0, now);
  }

  /** Convenience: clear only the dirty flag + last_error, leaving success_at untouched (manual reconcile / retry path). */
  function clearMirrorDirty() {
    return setMirrorState({ dirty: 0, last_error: null });
  }

  /**
   * Record per-type mirror status (partial success bookkeeping). `status` is a
   * patch {status: 'committed'|'failed'|'pending', applied_gen?, last_error?}
   * replacing the entry for `type` (other types untouched). Standardizing on an
   * explicit status gives per-type committed/failed/pending receipts — a type
   * whose file was written while a sibling failed is recorded as such, not
   * collapsed into a bulk "dirty" (peer blocker 4). Returns the updated state.
   */
  function setTypeStatus(type, status) {
    if (!VALID_TYPE_STATUS.has(status?.status)) {
      throw new TypeError(`setTypeStatus: status must be one of committed|failed|pending, got ${status?.status}`);
    }
    const current = getMirrorState();
    const statuses = current.type_status || {};
    statuses[type] = {
      status: status.status,
      ...(status.applied_gen !== undefined ? { applied_gen: status.applied_gen } : {}),
      ...(status.last_error !== undefined ? { last_error: status.last_error } : {})
    };
    return setMirrorState({ type_status: JSON.stringify(statuses) });
  }

  /** Per-type mirror status map {type: {dirty, applied_gen, last_error}}, {} when unset. */
  function getTypeStatus() {
    const current = getMirrorState();
    return current.type_status || {};
  }

  /** Run fn atomically: when the connection is already inside a transaction
   *  (service.transaction's BEGIN), just run it — the outer COMMIT covers us.
   *  Otherwise wrap in BEGIN/COMMIT so a memory write and its desired-generation
   *  bump commit together: a crash between them can never leave a mutated store
   *  with generation == applied (audit peer blocker 1, "crash window"). */
  // --- #249 N3：压缩边缘的连续性提案（唯一写入口 = 压缩边缘监听器） -------------
  /** Upsert one continuity proposal. (session_id, kind) is the形态约定「同一会话同一类
   *  只留一条」：命中即刷新（created_at 不动、updated_at 记最近边缘），不新增行。
   *  Queue full → drop the new one and say so (dropped: true) instead of throwing: an edge
   *  that cannot be recorded must not break the host's step. Returns {id, created, dropped}. */
  function saveContinuityProposal({
    sessionId, kind, currentWork = null, nextStep = null, openQuestions = null, edgeSeq = null,
    maxPending = MAX_CONTINUITY_PENDING
  } = {}) {
    if (!sessionId || !kind) throw new TypeError("continuity proposal needs sessionId and kind");
    const now = new Date().toISOString();
    const existing = db.prepare("SELECT id FROM continuity_proposals WHERE session_id = ? AND kind = ?").get(sessionId, kind);
    if (!existing) {
      const pending = db.prepare("SELECT COUNT(*) AS c FROM continuity_proposals WHERE status = 'pending'").get().c;
      if (pending >= maxPending) return { id: null, created: false, dropped: true };
    }
    // 写入本身是一条 UPSERT：唯一索引 (session_id, kind) 是并发的裁决者。两个宿主共用
    // memoryDir 时（AGENTS.md 的多进程 WAL 场景）先查后插会有一个撞 SQLITE_CONSTRAINT，
    // 而这里只该有一条语句决定成不成功。上面的 SELECT 只用于「队列满」与 created 标记。
    // created_at 与 status 刻意不在 SET 里：命中只刷新内容与最近边缘时刻，不把已转正的行打回 pending。
    const id = randomUUID();
    db.prepare(`
      INSERT INTO continuity_proposals (id, session_id, kind, current_work, next_step, open_questions, status, edge_seq, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      ON CONFLICT(session_id, kind) DO UPDATE SET
        current_work = excluded.current_work,
        next_step = excluded.next_step,
        open_questions = excluded.open_questions,
        edge_seq = excluded.edge_seq,
        updated_at = excluded.updated_at
    `).run(id, sessionId, kind, currentWork, nextStep, openQuestions, edgeSeq, now, now);
    const row = db.prepare("SELECT id FROM continuity_proposals WHERE session_id = ? AND kind = ?").get(sessionId, kind);
    return { id: row?.id ?? id, created: !existing, dropped: false };
  }

  /** The single proposal for (session, kind), or null. */
  function getContinuityProposal(sessionId, kind) {
    return db.prepare("SELECT * FROM continuity_proposals WHERE session_id = ? AND kind = ?").get(sessionId, kind) ?? null;
  }

  /** Newest-first proposals, optionally filtered by status (转正通道的读侧预置)。 */
  function listContinuityProposals({ status, limit = 50 } = {}) {
    const bounded = Number.isSafeInteger(limit) && limit > 0 ? limit : 50;
    return status
      ? db.prepare("SELECT * FROM continuity_proposals WHERE status = ? ORDER BY updated_at DESC, id LIMIT ?").all(status, bounded)
      : db.prepare("SELECT * FROM continuity_proposals ORDER BY updated_at DESC, id LIMIT ?").all(bounded);
  }

  function countContinuityProposals({ status } = {}) {
    return status
      ? db.prepare("SELECT COUNT(*) AS c FROM continuity_proposals WHERE status = ?").get(status).c
      : db.prepare("SELECT COUNT(*) AS c FROM continuity_proposals").get().c;
  }

  function runAtomically(fn) {
    if (db.isTransaction) return fn();
    db.exec("BEGIN");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* connection may be closed */ }
      throw error;
    }
  }

  /** Bump the desired generation atomically (SQLite single-statement increment,
   *  no SELECT-then-UPSERT race: peer blocker 3 lost 10 of 91 concurrent
   *  increments under an 8-process probe). Returns the new mirror state.
   *  Guards the upper bound: generation must stay within MAX_SAFE_INTEGER so
   *  reads never hit ERR_OUT_OF_RANGE (peer blocker 6). */
  function incrementGeneration() {
    return runAtomically(() => {
      // Ensure the singleton row exists before incrementing (UPDATE alone would
      // match nothing on a fresh DB).
      db.prepare("INSERT OR IGNORE INTO mirror_state (id) VALUES ('main')").run();
      const row = db.prepare(
        "UPDATE mirror_state SET generation = generation + 1 WHERE id = 'main' AND generation < ? RETURNING generation"
      ).get(Number.MAX_SAFE_INTEGER);
      if (!row) throw new RangeError("mirror_state.generation exceeded MAX_SAFE_INTEGER");
      return getMirrorState();
    });
  }

  return {
    db,
    count,
    getById,
    save,
    // document 唯一铸造口（#230 写入权分离）：registerDocument 专用，通用
    // save/update/CAS 均拒绝 document 创建或类型转换。
    saveDocument,
    update,
    compareAndUpdate,
    // #254：写入准入的内容哈希候选集（只读）。
    findContentHashMatches,
    remove,
    setForget,
    setArchived,
    touchLastAccess,
    demoteToSummary,
    restoreContent,
    getUnrecalledSince,
    list,
    all,
    // #430：有界单列读，写路径（质量过滤）用。
    recentContents,
    search,
    setEmbedding,
    getEmbeddings,
    getParsedEmbedding,
    embeddedCount,
    needsEmbedding,
    needsEmbeddingFor,
    hasStaleEmbedding,
    embeddingModelBreakdown,
    searchVector,
    saveDreamRun,
    lastDreamRunAt,
    lastDreamBaseline,
    getDreamRun,
    listDreamRuns,
    getLatestPolicyEpoch,
    saveReceipt,
    getReceipt,
    listReceipts,
    saveRecallRun,
    getRecallRun,
    listRecallRuns,
    listRecallRunsSince,
    purgeRecallRunsOlderThan,
    saveRecallEval,
    getRecallEval,
    listRecallEvals,
    saveLlmAudit,
    getDistillCursor,
    setDistillCursor,
    listLlmAudits,
    countLlmAudits,
    getLlmAuditStats,
    deleteOldLlmAudits,
    // 蒸馏原始记录与记忆级溯源（#399）：窗口凭证的写入/统计/裁剪，链接的读写。
    saveDistillRecords,
    distillRecordStats,
    clearDistillRecords,
    saveMemoryProvenance,
    provenanceFor,
    // 存储生命周期（#275 第一批）：无损回收的统计、清理与体积口径。
    dreamRunInputStats,
    clearDreamRunInputs,
    archivedEmbeddingStats,
    clearArchivedEmbeddings,
    storageStats,
    vacuum,
    saveFailure,
    listFailures,
    getFailureStats,
    deleteOldFailures,
    saveConflictPending,
    listConflictPending,
    resolveConflictPending,
    countConflictPending,
    saveScopeChange,
    listScopeChanges,
    createEntity,
    findEntityByName,
    findEntityById,
    listEntities,
    updateEntity,
    saveAttr,
    invalidateOldAttr,
    getCurrentAttrs,
    getAttrHistory,
    getAttrsByMemory,
    entitiesForMemory,
    findMemoriesByAttr,
    findEntitiesMentionedIn,
    getLinkedMemoryIds,
    saveRelation,
    bumpRelationWeight,
    migrateAttrsToMemory,
    getRelations,
    getEntityNeighbors,
    getRelationsByMemory,
    setMirrorState,
    getMirrorState,
    markMirrorDirty,
    markMirrorClean,
    markMirrorCleanForGeneration,
    clearMirrorDirty,
    setTypeStatus,
    getTypeStatus,
    incrementGeneration,
    // #249 N3：压缩边缘的连续性提案（落提案、转正才进 memories）。
    saveContinuityProposal,
    getContinuityProposal,
    listContinuityProposals,
    countContinuityProposals,
    close() {
      db.close();
    }
  };
}
