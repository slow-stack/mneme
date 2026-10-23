// dsh-mneme/src/organize.js
// agent 主动整理接口（issue #231，口径基线 = #164 的「第三腿触发」）：dryRun
// 出比对报告 → agent 判断 → apply 落库；筛除项进归档不删；调用全程留审计回执。
//
// 只做功能本体（维护者口径，issue #231）：落在 service 层并带测试。**调用入口在
// 第二批**（#231：`tools.js` 的 `memory_organize` + `organizeEnabled` 默认关）——
// 本模块至今不读任何配置键，闸门与 scope 盖章都在调用方那一侧，所以本体语义与
// 第一批逐字节相同。
//
// 独立成模块（AGENTS.md 尺寸约定，同 document.js / recall-stats.js 先例）：
// service.js 只做依赖注入 + barrel 出口，调用方零改动。
//
// 四条硬规则，都是「宁可什么都不做」的形态：
// 1. dryRun 不写记忆表：它只读 + 写一行审计（dream_runs）。比对是报告，不是动作。
// 2. apply 必须引用一次真实 dryRun——run_id 且 run_type='organize'，且不是 apply
//    自己的回执（靠 outcome.dry_run_id 区分）、也不是 failed 的报告，且**还没落地过**
//    （报告行上的 outcome.applied_at，同一份报告只认一次，挡掉重放）。没有比对过的
//    候选一律不落库，堵死「跳过报告直接写」这条绕过路径。
// 3. apply 只重放 dryRun 校验过的那份规范化快照，且只认快照里的索引：被 dryRun
//    跳过的候选没有资格落库；scope 比对按**候选自己的** scope（candidate ?? payload），
//    不会出现「报告按 scope A 比对、落地却写成 scope B」的错位。
// 3b. archive 只认报告里命中过的 id（item.match.id，落在报告的 decisions 列）：报告
//    是唯一的判断依据，整理接口不能变成第二条「按 id 改库」的通道。
// 4. 筛除 = 归档（store.setArchived），绝不物理删除：归档可恢复，删除不可逆。
//
// 宽容形态（仓库红线 4，同 issue #89）只管**输入**：单条非法候选/决策跳过 + 应用
// 合法子集 + run 记 degraded，不整单拒绝。基础设施错误（嵌入器抛错、存储异常）
// 相反——记 failed 并原样上抛，绝不静默降级成「没找到重复」。审计口径复用
// dream_runs 的 receipt 语义（buildReceipt / parseReceipt 同一格式），不新建审计面。

import { createHash, randomUUID } from "node:crypto";
import { scopeKeyOf } from "./scope.js";
// 比对池要先剔掉外来行：报告里的 item.match.id 既给出「命中」结论，也是 apply 的
// archive 动作唯一许可的目标集（硬规则 3b），而 archive 直接 store.setArchived，
// 不经 saveWithDedupe 那道闸门——留着外来行，整理接口就能替别人决定归档面。
import { isImportedRow } from "./memory-source.js";
import { cosineSimilarity } from "./dream/clustering.js";
import { buildReceipt } from "./dream.js";

// 与 document 的 C2 档（#230）和 findSessionDuplicate 的 vector 档同源：同一份
// 「近重复」语义只有一个阈值，不在第三个地方另发明一个。
const MIN_SIM = 0.92;
// 向量比对对象的上限（document.js 同口径：精确层全量、向量层有界）。精确层
// 不能截断——同标题漏检会让报告给出错误的 verdict。
const CANDIDATE_LIMIT = 200;
// 单次 dryRun 的候选硬上限：主场景是「长段工作收尾整理」，不是批量导入；不设界
// 的话一次调用会把整库拉进比对。
const MAX_ITEMS = 50;
// scope 标注只做搬运（判定在 store / service 侧），省得整理接口成为第二条绕过
// scope 治理的写入通道。载荷级给的值是候选级的缺省——比对按它判 scope，落地就必须
// 带上它，否则报告与写入落在两个 scope 里。
const SCOPE_KEYS = ["sensitivity", "agent_scope", "workspace_scope", "agent_scope_source", "workspace_scope_source"];
// 比对键必须与 saveWithDedupe 的去重键**同口径**：`src/service.js` 的 scopeMatches 只比
// sensitivity / agent_scope / workspace_scope 三列，来源两列不进键（它们是元数据，合并时
// 还会把被并入行的 auto 来源升级成 explicit）。比对键里多带来源，就会出现「dryRun 报 new、
// apply 却把它并进既有行」——报告与写入错位，正是本模块硬规则 3 要挡的那类不一致。
const MATCH_SCOPE_KEYS = ["sensitivity", "agent_scope", "workspace_scope"];

/**
 * Build the organizer.
 *
 * Injected deps are service.js closure members (store / embedQuery / saveWithDedupe
 * / transaction / finalize) so this module stays free of service-internal wiring;
 * `saveWithDedupe` is the normal write path, so its own epilogue (mirror sync and
 * notify) is never duplicated here. `finalize` is the post-commit re-embed hook
 * (document.js 同款): transaction 提交后补重嵌入，见 service.js › transaction 注释。
 *
 * @returns {{ organize: (payload: object, opts?: object) => Promise<object> }}
 *   `organize({ mode: "dryRun"|"apply", ... }, opts)` — 一个入口带 mode 参数
 *   （维护者倾向的形态），内部两个具名函数各自可测。
 */
export function createOrganizer({ store, embedQuery, saveWithDedupe, transaction, finalize }) {
  const hashOf = (value) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");

  /**
   * 候选规范化。返回 `{ candidate }` 或 `{ error }`——错误在 dryRun 里进 skipped，
   * 不抛整单（红线 4）。document 刻意在此拦下：它的唯一铸造口是 registerDocument
   * （#230），service 的通用 save 路径也会拒绝，这里提前拦截只是为了报告不撒谎。
   */
  function normalizeCandidate(raw, defaults = {}) {
    const type = String(raw?.type ?? "").trim();
    const title = String(raw?.title ?? "").trim();
    const content = String(raw?.content ?? "").trim();
    if (!type || !title || !content) return { error: "type/title/content are required" };
    if (type === "document") return { error: "document rows are minted only via registerDocument (#230)" };
    const candidate = {
      type,
      title,
      content,
      importance: Number.isInteger(raw?.importance) ? Math.min(5, Math.max(1, raw.importance)) : 3,
      tags: [...new Set((Array.isArray(raw?.tags) ? raw.tags : []).map((t) => String(t ?? "").trim()).filter(Boolean))],
      source: String(raw?.source ?? "organize")
    };
    for (const key of SCOPE_KEYS) {
      const value = raw?.[key] ?? defaults[key];
      if (value !== undefined) candidate[key] = value;
    }
    return { candidate };
  }

  /** 标题归一（同 findSessionDuplicate 的 title 档）：大小写与标点不构成「不同标题」。 */
  const normalizeTitle = (s) => String(s ?? "").toLowerCase().replace(/[\s\p{P}]+/gu, "");

  /**
   * 向量档最佳命中。拿不到向量/嵌入器时返回 null（无信号 = 不判定，不是报错）；
   * 但**抛出的**错误不再吞掉——嵌入器故障下的空信号会被读成「全是新条目」，让
   * agent 把重复条写进库，比整单失败更糟，交 dryRun 记 failed 后上抛。
   */
  async function bestNear(candidate, rows, vecs) {
    if (!vecs?.size) return null;
    const probe = await embedQuery([candidate.title, candidate.content].filter(Boolean).join("\n"));
    if (!probe) return null;
    let best = null;
    for (const m of rows) {
      const v = vecs.get(m.id);
      if (!v) continue; // 无向量的既有行不参与比对
      const sim = cosineSimilarity(probe, v);
      if (sim >= MIN_SIM && (!best || sim > best.sim)) best = { memory: m, sim };
    }
    return best;
  }

  /**
   * 比对报告。**不写记忆表**；只写一行 dream_runs 审计（run_type='organize'）。
   *
   * @param {object} payload
   *   `{ candidates: Array<{type,title,content,importance?,tags?}>, agent_scope?,
   *      workspace_scope?, sensitivity? }`
   * @returns {Promise<{run_id, created_at, status, counts, items, skipped}>}
   *   items[i] = `{ index, type, title, verdict: "exact"|"near"|"new", match }`
   */
  async function dryRun(payload = {}) {
    const raws = Array.isArray(payload.candidates) ? payload.candidates : null;
    if (!raws) throw new Error("organize.dryRun: candidates must be an array");
    const bounded = raws.slice(0, MAX_ITEMS);
    const defaults = Object.fromEntries(SCOPE_KEYS.filter((k) => payload?.[k] !== undefined).map((k) => [k, payload[k]]));

    const skipped = [];
    const accepted = [];
    bounded.forEach((raw, index) => {
      const { candidate, error } = normalizeCandidate(raw, defaults);
      if (error) skipped.push({ index, error });
      else accepted.push({ index, candidate });
    });
    // 审计存规范化快照（带原始索引），不存调用方原始输入：apply 要重放的就是这份
    // ——原始输入里混着被跳过的候选，也没有随行的 payload 级 scope。
    const snapshot = accepted.map(({ index, candidate }) => ({ index, ...candidate }));

    // scope 同等才比对（跨 scope 永不互判——防泄漏，与 saveWithDedupe 的去重键
    // 「type+title+scope」同口径）。**按候选自己的 scope 比，不按载荷级**：
    // normalizeCandidate 允许逐条给 scope（raw ?? payload），若这里只看 payload，
    // 一条 agent_scope:"agent-b" 的候选就会拿默认 scope 的行去比——同一个 scope 里
    // 明明已有同标题行也报 "new"，报告 scope 与写入 scope 就此错位（硬规则 3）。
    // 行扫描与向量读取都按 (type, scope) 缓存：一批候选通常同类型同 scope，避免逐条全表扫。
    // 比对键用 MATCH_SCOPE_KEYS（三列值），搬运用 SCOPE_KEYS（五列）——两件事，别混：
    // 「怎么判同一行」跟 write 路径一致，「怎么把 scope 搬到候选上」才需要连来源一起带。
    const scopeOf = (source) => MATCH_SCOPE_KEYS.map((k) => scopeKeyOf(source?.[k])).join("\u0000");
    const scopeMatches = (m, source) => MATCH_SCOPE_KEYS.every((k) => scopeKeyOf(m[k]) === scopeKeyOf(source?.[k]));
    const cacheKey = (candidate) => `${candidate.type}\u0000${scopeOf(candidate)}`;
    const rowsByScope = new Map();
    const rowsFor = (candidate) => {
      const key = cacheKey(candidate);
      if (!rowsByScope.has(key)) {
        rowsByScope.set(
          key,
          store.list({ type: candidate.type, limit: null }).filter((m) => !isImportedRow(m) && !m.archived && scopeMatches(m, candidate))
        );
      }
      return rowsByScope.get(key);
    };
    const vecsByScope = new Map();
    const vecsFor = (candidate, rows) => {
      const key = cacheKey(candidate);
      if (!vecsByScope.has(key)) {
        vecsByScope.set(key, store.getEmbeddings(rows.slice(0, CANDIDATE_LIMIT).map((m) => m.id)));
      }
      return vecsByScope.get(key);
    };

    const runId = randomUUID();
    const createdAt = new Date().toISOString();
    // 哈希与 input 必须指向同一份东西：审计存的是规范化快照（apply 要重放它），
    // 所以哈希也算快照——否则回执里的 snapshot_hash 描述的是调用方原始输入，
    // 谁也校验不了。
    const snapshotHash = hashOf(snapshot);
    const record = (status, { error = null, decisions = items, skipped: skipList = skipped, applied = 0 } = {}) =>
      store.saveDreamRun({
        id: runId,
        created_at: createdAt,
        status,
        error,
        provider: null,
        model: null,
        snapshot_hash: snapshotHash,
        input_count: snapshot.length,
        input: snapshot,
        decisions,
        applied,
        summary_stored: 0,
        receipt: buildReceipt({ runId, status, snapshotHash, inputCount: snapshot.length, applied, summaryStored: false }),
        policy_epoch: 0,
        run_type: "organize",
        ...(skipList.length ? { skipped: skipList } : {})
      });

    const items = [];
    try {
      for (const { index, candidate } of accepted) {
        const rows = rowsFor(candidate);
        let item = { index, type: candidate.type, title: candidate.title, verdict: "new", match: null };
        const exact = rows.find((m) => normalizeTitle(m.title) === normalizeTitle(candidate.title));
        if (exact) {
          item = { ...item, verdict: "exact", match: { id: exact.id, title: exact.title, sim: null } };
        } else {
          const near = await bestNear(candidate, rows, vecsFor(candidate, rows));
          if (near) {
            item = { ...item, verdict: "near", match: { id: near.memory.id, title: near.memory.title, sim: near.sim } };
          }
        }
        items.push(item);
      }
    } catch (e) {
      // 审计先留痕、再上抛：一份没有回执的失败报告，事后无法与「没调用过」区分。
      record("failed", { error: String(e?.message ?? e) });
      throw e;
    }

    const counts = {
      total: items.length,
      exact: items.filter((i) => i.verdict === "exact").length,
      near: items.filter((i) => i.verdict === "near").length,
      new: items.filter((i) => i.verdict === "new").length,
      skipped: skipped.length,
      truncated: raws.length - bounded.length
    };
    // 有被拒的候选 → degraded（如实标记），而不是 ok 掩盖过去；一条都没报 → noop。
    const status = skipped.length ? "degraded" : items.length ? "ok" : "noop";
    record(status);
    return { run_id: runId, created_at: createdAt, status, counts, items, skipped };
  }

  /**
   * 按 agent 的判断落库。decisions 逐条：
   *   `{ action: "save", index }`     — 写候选（走 saveWithDedupe：同键自动合并）
   *   `{ action: "discard", index }`  — 不写（只进回执，不删任何东西）
   *   `{ action: "archive", id }`     — 库内被取代的行 → 归档（可恢复，不删）
   *
   * @param {object} payload `{ run_id, decisions }`
   * @param {object} [opts] `{ hiddenIds }` — 调用者 scope 看不见的行按「不存在」
   *   处理（#170 复核项 4：无存在性泄漏），与 document 的 hiddenEvidenceIds 同形：
   *   **可见性由可信调用方算好传入**（tools 层先例：register_document），不取 payload
   *   里的字段——那是调用方可自选的内容，不是授权。
   * @returns {{run_id, dry_run_id, status, saved, merged, discarded, archived, memory_ids, skipped, degraded}}
   *   `saved` 只数**新建**的行，合并进既有行的算 `merged`（两者之和 = 落地生效的条数）；
   *   `memory_ids` 含合并命中的既有行 id（它们同样需要重嵌入）。
   */
  function apply(payload = {}, { hiddenIds = [] } = {}) {
    const dryRunId = String(payload?.run_id ?? "").trim();
    if (!dryRunId) {
      throw new Error("organize.apply: run_id is required (apply must reference a dryRun report)");
    }
    const report = store.getDreamRun(dryRunId);
    if (report?.run_type !== "organize") {
      throw new Error(`organize.apply: unknown organize run "${dryRunId}"`);
    }
    // apply 回执与 dryRun 报告共用 run_type='organize'：只有 outcome.dry_run_id 能
    // 把它们分开。不查这一条，apply 的 run_id 可以被当成 dry_run_id，串成
    // apply → apply 的审计链，报告那一环就此消失。
    if (report.outcome?.dry_run_id) {
      throw new Error(`organize.apply: "${dryRunId}" is an apply receipt, not a dryRun report`);
    }
    if (report.status === "failed") {
      throw new Error(`organize.apply: dryRun "${dryRunId}" failed — re-run dryRun before applying`);
    }
    // 同一份报告只能落地一次。凭证写在**报告行**上（下面的 outcome.applied_at），
    // 与数据同事务；只看 apply 回执挡不住「重放同一 run_id」——那会各记一份收据，
    // 审计计数虚高，破坏「全留审计」的承诺。
    if (report.outcome?.applied_at) {
      throw new Error(`organize.apply: dryRun "${dryRunId}" was already applied at ${report.outcome.applied_at}`);
    }
    const decisions = Array.isArray(payload?.decisions) ? payload.decisions : null;
    if (!decisions) throw new Error("organize.apply: decisions must be an array");

    const snapshot = Array.isArray(report.input) ? report.input : [];
    const byIndex = new Map(snapshot.map((entry) => [Number(entry?.index), entry]));
    const hidden = new Set((Array.isArray(hiddenIds) ? hiddenIds : []).map((id) => String(id)));
    // 报告认定过的「库内被取代行」：dryRun 的 items 落在报告的 decisions 列里，
    // 只有那里命中过的 id 才有资格归档。不查这一条，apply 可以归档报告里根本
    // 没出现过的行（评审实测：preference-only 的报告里归档了 project 行）——
    // 整理接口就成了绕过报告的第二条改库通道。
    const matchedIds = new Set(
      (Array.isArray(report.decisions) ? report.decisions : [])
        .map((d) => (d?.match?.id != null ? String(d.match.id) : null))
        .filter(Boolean)
    );
    const skipped = [];
    const byId = {};
    const memoryIds = [];
    const savedRows = [];
    let saved = 0; // 真正新建的行
    let merged = 0; // 合并进既有行（同键命中）——不是新建，不能算进 saved
    let discarded = 0;
    let archived = 0;

    const runDecisions = () => {
      decisions.forEach((decision, i) => {
        const action = String(decision?.action ?? "").trim();
        if (action === "save") {
          const index = Number(decision?.index);
          const entry = Number.isInteger(index) ? byIndex.get(index) : undefined;
          if (!entry) {
            // 索引不在快照里 = dryRun 从没校验过它（越界，或当时就被 normalize 拒了）。
            skipped.push({ index: i, action, error: "candidate index was not accepted by this dryRun" });
            return;
          }
          const { index: _originalIndex, ...candidate } = entry;
          // 这里不吞异常：能走到这一步的候选是 dryRun 已经规范化过的合法输入，抛出
          // 来的只能是基础设施错误 → 让它冒到事务外，整批回滚 + failed（红线 4 的
          // 「单条跳过」只覆盖输入级错误，那一步在 normalizeCandidate）。
          const result = saveWithDedupe(candidate);
          if (result?.action === "created") saved++;
          else merged++;
          savedRows.push(result.memory);
          memoryIds.push(result.memory.id);
          byId[result.memory.id] = action;
          return;
        }
        if (action === "discard") {
          // 与 save 同一把尺：index 必须指向 dryRun 真的收下的候选。否则这是一条针对
          // 不存在的候选的「裁决」，记进回执就是虚账（skipped 为空、可能还报 noop）。
          const index = Number(decision?.index);
          const entry = Number.isInteger(index) ? byIndex.get(index) : undefined;
          if (!entry) {
            skipped.push({ index: i, action, error: "candidate index was not accepted by this dryRun" });
            return;
          }
          discarded++;
          return;
        }
        if (action === "archive") {
          const id = String(decision?.id ?? "").trim();
          // 可见性先于「是否被报告命中」：调用方看不见的行一律按不存在处理（不泄漏
          // 存在性，错误文案也维持「unknown, archived or out of scope」这一句）。
          const row = !id || hidden.has(id) ? null : store.getById(id);
          if (!row) {
            skipped.push({ index: i, action, ids: id ? [id] : [], error: "unknown, archived or out of scope" });
            return;
          }
          // 看得见、也存在，但报告从没把它标成命中行 → 拒绝：报告是唯一的判断依据。
          if (!matchedIds.has(id)) {
            skipped.push({ index: i, action, ids: [id], error: "id was not flagged as a match by this dryRun" });
            return;
          }
          if (row.archived) {
            byId[id] = "keep"; // 已归档 = 目标状态已达，不重复计数
            return;
          }
          store.setArchived(id, true);
          archived++;
          byId[id] = action;
          return;
        }
        skipped.push({ index: i, action, error: `unknown action "${action}"` });
      });
    };

    const applyRunId = randomUUID();
    const createdAt = new Date().toISOString();
    const snapshotHash = report.snapshot_hash;
    // 回执的 applied/byId 由调用方传入：失败路径必须报 0（事务已回滚，累积的
    // saved/archived 是尝试值，写进回执就是撒谎）。
    const record = (status, error, { byId: outcomeById = byId, applied = saved + merged + archived } = {}) => store.saveDreamRun({
      id: applyRunId,
      created_at: createdAt,
      status,
      error,
      provider: null,
      model: null,
      snapshot_hash: snapshotHash,
      input_count: snapshot.length,
      input: snapshot,
      decisions,
      // dry_run_id 是这条回执与它所指报告的连接键：审计能还原「报告 → 判断 → 落地」
      // 三步，而不用新建审计面。
      outcome: { dry_run_id: dryRunId, byId: outcomeById },
      applied,
      summary_stored: 0,
      receipt: buildReceipt({
        runId: applyRunId,
        status,
        snapshotHash,
        inputCount: snapshot.length,
        applied,
        summaryStored: false
      }),
      policy_epoch: 0,
      run_type: "organize",
      ...(skipped.length ? { skipped } : {})
    });

    let status;
    try {
      transaction(() => {
        runDecisions();
        // 给报告打「已落地」标记，与数据同事务：标记写不进去就整批回滚，不会出现
        // 「库改了、报告却还能再落地一次」的窗口。
        store.saveDreamRun({
          ...report,
          outcome: { ...(report.outcome ?? {}), applied_at: createdAt, applied_by: applyRunId }
        });
        // 只有 discard 的批次什么都没改 → noop（绝不虚报 ok）。
        status = skipped.length ? "degraded" : saved + merged + archived > 0 ? "ok" : "noop";
        // 成功回执与数据同事务：审计写不进去就一起回滚，不留「库改了却没有回执」
        // 的窗口（回执是这条链上唯一的证据）。
        record(status, null);
      });
    } catch (e) {
      // 事务已回滚 → 失败回执单独写。审计本身失败不能顶掉原始错误（调用方要处理的
      // 是原始错误那一件），但也别静默：挂到它身上，两件事都看得见。
      try {
        record("failed", String(e?.message ?? e), { byId: {}, applied: 0 });
      } catch (auditError) {
        e.audit_error = String(auditError?.message ?? auditError);
      }
      throw e;
    }

    // transaction 只负责镜像与通知，重嵌入留给调用方（service.js › transaction
    // 注释）；document.js 用同一个 finalize 先例。放在提交之后，事务里 scheduleEmbed
    // 会被 txDepth 挡掉，不补这一步新写的记忆就没有向量。
    if (savedRows.length && typeof finalize === "function") finalize(savedRows);

    return {
      run_id: applyRunId,
      dry_run_id: dryRunId,
      status,
      saved,
      merged,
      discarded,
      archived,
      memory_ids: memoryIds,
      skipped,
      degraded: skipped.length > 0
    };
  }

  /** 一个入口带 mode 参数（维护者口径）；opts 是可信调用上下文，不取 payload 里的字段。 */
  async function organize(payload = {}, opts = {}) {
    const mode = String(payload?.mode ?? "dryRun").trim();
    if (mode === "dryRun") return dryRun(payload);
    if (mode === "apply") return apply(payload, opts);
    throw new Error(`organize: unknown mode "${mode}" (dryRun | apply)`);
  }

  return { organize };
}
