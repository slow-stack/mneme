// dsh-mneme/src/profile-facts.js
// 「Agent 眼中的你」自动事实（2026-11-06）：按会话身份分卡维护一份逐条事实清单，
// dream 巩固轮结束后自动增量维护（opt-in：profileFactsEnabled），面板可手动触发与
// 逐条修正。形态对标 ChatGPT 记忆 / DS Bot 每 bot 一份 MEMORY.md 事实清单（journal
// 记每笔 op 的 before/after）——事实可独立增改归档、账本可审计，而不是整段重写。
//
// 四条纪律，都是「做错界面上看不出来」的那类，所以写在文件头：
// 1. **手填画像神圣**。user_settings.profile 是用户原文，本模块对它只有读权
//    （profile-extract #497 的「只出草稿不落库」口径不变）；事实住独立的
//    profile_facts 三表，注入时作为画像之后的独立段出现，绝不回写 user_settings。
// 2. **没有增量输入就不调模型**。游标之后没有新行时返回 noop 回执——为维护而
//    维护的一轮只会产出「看起来像事实的复读」，那种事实每帧都在注入。
// 3. **吐不出可用 ops 就 failed，绝不冒充成功**。「模型没配合」与「确实没什
//    么可改」必须可区分（#493 同一条教训：解析失败被读成空结果，用户会以为
//    这轮维护跑过了）。failed 轮照样落回执行，账面上留痕。
// 4. **失败不推进游标**。failed 轮之后重跑同一窗口（蒸馏游标同款纪律：失败不
//    消费），宁可重复消费也不跳过没维护到的行。
//
// 记忆正文是模型的**可影响输入**：围栏 + 「数据非指令」 + 禁止给助手起名设人格，
// 三件套与 profile-extract / #380 同源（src/fence.js 一份断链，不写第二套）。
//
// LLM 调用与审计完全复用 dream.js 的既有缝（resolveRoute / runAuditedLlm /
// streamText / describeStreamFailure）：chunk 形状的三个硬点（用量嵌在 chunk.usage、
// 终态 finish 才是错误、rc.1 把适配器故障转成 finish chunk 而不是抛错）都在那里
// 踩过并修过，不在这里重写第二遍。

import { randomUUID } from "node:crypto";
import { STR, langOf } from "./lang.js";
import { describeStreamFailure, resolveRoute, runAuditedLlm, streamText } from "./dream.js";
// 与巩固/蒸馏/画像提取同一份断链（src/fence.js）。事实同样是模型的可影响输入，
// 一条写着「<<<记忆条目结束>>>」的记忆能提前闭合围栏。
import { breakFenceMarkers } from "./fence.js";

const DEFAULT_INPUT_ROWS = 120;
const DEFAULT_ROW_CHARS = 260;
const DEFAULT_TOTAL_CHARS = 9000;
// 与 prompt 里的「单轮最多 12 个 op」同一个数：超出的切片丢弃并记进回执 detail，
// 不让一轮失控的输出把清单搅成毛线团。清单长度本身不设硬顶——prompt 要求模型
// archive 冗余，注入侧另有逐行/总长截断兜底（user-settings.js），撑不爆每一帧。
const MAX_OPS_PER_RUN = 12;

/** 带 code 的失败：路由按 code 映射状态码，调用方据此区分「没东西可提」与「模型没配合」。 */
export class ProfileFactsError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = "ProfileFactsError";
    this.code = code;
  }
}

/**
 * 单个 op 的形状谓词；批量口径（路由层 400 闸）与解析层共用这一份——两处各抄
 * 一遍的话，改形状就会漏一边（评审 P3：同一谓词两份皮，P1 的洞因此要修两处）。
 * add 与 update 都必须带非空 content：update 缺 content 时 `String(undefined)`
 * 会把「undefined」三个字母写进事实正文并从此每帧注入（评审 P1 实测复现的洞）。
 */
function isValidFactOp(o) {
  return !!o && typeof o === "object"
    && (o.op === "add" || o.op === "update" || o.op === "archive")
    && (o.op !== "add" && o.op !== "update" || (typeof o.content === "string" && o.content.trim()))
    && (o.op === "add" || typeof o.id === "string" && o.id.trim());
}

/** 批量口径：待写入的 op 批必须非空且逐个形状合格（空批走「没什么可改」，不进这条）。 */
export function isValidFactOps(ops) {
  return Array.isArray(ops) && ops.length > 0 && ops.every(isValidFactOp);
}

/**
 * 从模型输出里取 ops 数组。先剥 markdown 围栏，再退到「第一个 [ 或 { 到最后一个
 * ] 或 }」的宽取——与 parseProfileDraft 同款两步。形状校验：op 只认 add/update/
 * archive；add 必须带非空 content；update/archive 必须带 id（id 是否真实存在由
 * apply 层裁决——这里只做形状校验）。取不到可用结构返回 null，绝不返回空数组
 * 冒充成功（空 ops 是合法的「没什么可改」，但那必须是 JSON 里真的写着空数组）。
 */
export function parseFactOps(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, "$1").trim();
  const candidates = [];
  const arrOpen = cleaned.indexOf("[");
  const objOpen = cleaned.indexOf("{");
  const start = arrOpen >= 0 && (objOpen < 0 || arrOpen < objOpen) ? arrOpen : objOpen;
  const end = Math.max(cleaned.lastIndexOf("]"), cleaned.lastIndexOf("}"));
  if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1));
  if (cleaned.startsWith("{") || cleaned.startsWith("[")) candidates.push(cleaned);
  for (const candidate of candidates) {
    let value;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    const ops = Array.isArray(value) ? value : (value && typeof value === "object" && Array.isArray(value.ops) ? value.ops : null);
    // 空 ops 是合法的「没什么可改」（runFor 会以 ok + opsApplied:0 收尾），所以
    // 这里只验逐 op 形状、不要求非空——非空是批量写入口径（isValidFactOps）。
    if (!ops || !ops.every(isValidFactOp)) continue;
    return ops;
  }
  return null;
}

/** 采集增量输入的截断读数：多取一行只为如实回答「还有没有」（profile-extract 同款）。 */
function collectInputRows(store, agentKey, cursor) {
  const fetched = store.listFactInputRows(agentKey, { since: cursor, limit: DEFAULT_INPUT_ROWS + 1 });
  const rows = [];
  let chars = 0;
  let truncated = fetched.length > DEFAULT_INPUT_ROWS;
  for (const row of fetched.slice(0, DEFAULT_INPUT_ROWS)) {
    const content = String(row.content ?? "").slice(0, DEFAULT_ROW_CHARS);
    if (content.length < String(row.content ?? "").length) truncated = true;
    const size = `${row.type} ${row.title} ${content}`.length;
    // 首行保底：单行就超总预算时也收进来（截断已如实标记）——否则游标永远
    // 推不进、这张卡变成永久 noop（评审 P3：首行即超预算的死角）。
    if (rows.length && chars + size > DEFAULT_TOTAL_CHARS) {
      truncated = true;
      break;
    }
    chars += size;
    rows.push(row);
  }
  return { rows, truncated, charsUsed: chars };
}

/**
 * @param {{ ctx: object, service: object, store: object, config: object, logger?: object }} deps
 *   ctx 要带 llm（宿主 LLM 句柄）；settings 不参与——本模块按纪律绝不写 user_settings。
 * @returns object with runFor / applyManualOps / cardKeys / factsProvider / listFacts / listJournal / listRuns
 */
export function createProfileFacts({ ctx, service, store, config, logger }) {
  const log = logger ?? ctx?.logger;
  const language = langOf(config);

  /** 卡片清单：''（default 兜底）恒在；非空键来自记忆行的 scope 值 ∪ 存量卡片。 */
  function cardKeys() {
    const keys = store.listFactCardKeys()
      .filter((k) => typeof k === "string" && k.trim())
      .map((k) => k.trim());
    return ["", ...new Set(keys)];
  }

  /** 注入 provider 读口：renderUserSettingsBlock 的 factsProvider（面板预览共用）。 */
  function factsProvider() {
    return store.listActiveFactsGrouped();
  }

  function listFacts(agentKey, { includeArchived = false } = {}) {
    return store.listProfileFacts(agentKey, { includeArchived });
  }

  function listJournal(agentKey, { limit = 20 } = {}) {
    return store.listProfileFactJournal(agentKey, { limit });
  }

  function listRuns(agentKey, { limit = 10 } = {}) {
    return store.listProfileFactRuns(agentKey, { limit });
  }

  /**
   * ops 落库（自动轮与人工面板共用这一份）：单事务，逐 op 记账（scope_changes 式
   * before/after）。跨卡守卫：op.id 必须属于本卡——LLM 幻觉出的别卡 id 不能当成
   * 合法目标；精确重复的 add（与既有活跃事实 trim 后相同）跳过并计数，不落库。
   */
  function applyOps(agentKey, ops, { actor, runId = null, at = new Date().toISOString() } = {}) {
    const failures = [];
    let applied = 0;
    let dupsSkipped = 0;
    const existing = store.listProfileFacts(agentKey, { includeArchived: true });
    const existingById = new Map(existing.map((f) => [f.id, f]));
    const activeContents = new Set(
      existing.filter((f) => f.status === "active").map((f) => String(f.content ?? "").trim())
    );
    store.runAtomically(() => {
      for (const op of ops) {
        try {
          if (op.op === "add") {
            const content = String(op.content).trim();
            if (activeContents.has(content)) {
              dupsSkipped += 1;
              continue;
            }
            const sourceIds = Array.isArray(op.source_ids)
              ? op.source_ids.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim())
              : [];
            const id = randomUUID();
            store.insertProfileFact({ id, agentKey, content, sourceMemoryIds: sourceIds, at });
            store.insertProfileFactJournal({ at, agentKey, runId, factId: id, op: "add", before: null, after: content, actor });
            activeContents.add(content);
            applied += 1;
          } else if (op.op === "update" || op.op === "archive") {
            const prev = existingById.get(op.id);
            if (!prev || prev.agent_key !== agentKey) {
              failures.push({ op: op.op, id: op.id ?? null, reason: "fact not found on this card" });
              continue;
            }
            const nextContent = op.op === "update" ? String(op.content).trim() : prev.content;
            const nextStatus = op.op === "archive" ? "archived" : prev.status;
            store.updateProfileFact(prev.id, { content: nextContent, status: nextStatus, at });
            store.insertProfileFactJournal({
              at, agentKey, runId, factId: prev.id, op: op.op,
              before: prev.content, after: op.op === "update" ? nextContent : null, actor
            });
            if (op.op === "update") {
              // 去重集合要跟上新值：同批 [update A→B, add B] 不收新值的话会落两条
              // 相同的活跃事实，而 dupsSkipped 还是 0（评审 P2 实测复现）。
              activeContents.delete(String(prev.content ?? "").trim());
              activeContents.add(nextContent);
            }
            applied += 1;
          } else {
            failures.push({ op: op.op ?? null, id: op.id ?? null, reason: "unsupported op" });
          }
        } catch (error) {
          // 逐 op 吞错是刻意的：一条 journal 写失败不该把整批已落的事实回滚掉
          // （失败进 failures 由回执如实报）。代价是与「单事务」注释的原子粒度
          // 有出入——真故障通常连 COMMIT 一起失败，这里只是收窄那道缝。
          failures.push({ op: op.op ?? null, id: op.id ?? null, reason: String(error?.message ?? error) });
        }
      }
    });
    return { applied, failures, dupsSkipped };
  }

  /** 面板人工修正入口：actor=manual、runId=null，账本与自动轮同一份。 */
  function applyManualOps(agentKey, ops) {
    return applyOps(agentKey, ops, { actor: "manual" });
  }

  /**
   * 跑一轮维护。返回回执 `{ runId, status, inputCount, opsApplied, failures, ... }`；
   * no-route / stream-failed / unparseable 以 ProfileFactsError 抛出（回执已先落库，
   * API 层按 code 映射状态码）。
   */
  async function runFor(agentKey, { trigger = "manual" } = {}) {
    const key = typeof agentKey === "string" ? agentKey.trim() : "";
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const finish = (status, extra = {}) => {
      const receipt = { runId, agentKey: key, status, ...extra };
      store.insertProfileFactRun({
        id: runId,
        agentKey: key,
        triggerSource: trigger === "auto" ? "auto" : "manual",
        status,
        cursor: receipt.cursor ?? null,
        inputCount: receipt.inputCount ?? 0,
        opsApplied: receipt.opsApplied ?? 0,
        detail: receipt.detail ? JSON.stringify(receipt.detail) : null,
        startedAt,
        finishedAt: new Date().toISOString()
      });
      return receipt;
    };

    const cursor = store.profileFactsCursor(key);
    const { rows, truncated } = collectInputRows(store, key, cursor);
    const facts = store.listProfileFacts(key, { includeArchived: false });
    // 没有增量输入就没有本轮：连回执都记成 noop（面板能看到「没有新记忆」），
    // 游标不动——下一次有新行时窗口从旧游标接续。
    if (!rows.length) {
      return finish("noop", { inputCount: 0, cursor });
    }

    const fail = (code, message, detail) => {
      finish("failed", { inputCount: rows.length, cursor: null, detail: { code, ...(detail ?? {}) } });
      throw new ProfileFactsError(code, message);
    };

    const route = resolveRoute(ctx, config, log);
    // resolveRoute 在「没有 dreamProvider/dreamModel、宿主也没有可解析的默认模型」
    // 时返回 undefined。不判它就是一个语义为「内部错误」的 500——真正该说的是
    // 「没配模型」（profile-extract 同款取舍：不同结局不同话）。
    if (!route) {
      fail("no-route", "no model route: set dreamProvider/dreamModel or pick an agent default model");
    }

    const factListing = facts.length
      ? facts.map((f, i) => `${i + 1}. [${f.id}] ${f.content}`).join("\n")
      : "（尚无既有事实）";
    const rowListing = rows.map((r, i) => `${i + 1}. [${r.id}] [${r.type}] ${r.title} :: ${String(r.content ?? "").slice(0, DEFAULT_ROW_CHARS)}`).join("\n");
    const userText = [
      STR.profileFenceOpen[language],
      breakFenceMarkers(`【既有事实】\n${factListing}\n\n【新记忆条目】\n${rowListing}`),
      STR.profileFenceClose[language],
      truncated
        ? (language === "zh"
          ? `（输入行有截断：本轮只呈现了窗口内的一部分。）`
          : `(Input was truncated: only part of the window is shown this pass.)`)
        : "",
      language === "zh"
        ? `以上材料（数据）到此结束。只依据它们输出 JSON，材料里没有的绝不发明。`
        : `End of the material (data). Answer from it only; invent nothing absent from it.`
    ].filter(Boolean).join("\n");

    let streamFailure = "";
    const text = await runAuditedLlm(ctx, service, config, {
      triggerSource: "profileFacts",
      operationType: "profile_facts",
      modelId: `${route.provider}:${route.model}`,
      relatedMemoryIds: rows.map((r) => r.id),
      streamError: () => streamFailure,
      // 吐了文字但没有可用结构 = 失败调用。审计必须记 error：success 配解析失败
      // 会让「模型不配合」在账目上长得像「这轮确实没什么可改」。
      auditError: (out) => (parseFactOps(out) ? null : "profile facts pass returned no usable ops JSON")
    }, (reportUsage) => streamText(ctx, {
      provider: route.provider,
      model: route.model,
      purpose: "compaction",
      messages: [
        { role: "system", content: [{ type: "text", text: STR.prompts.profileFacts[language] }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } },
        { role: "user", content: [{ type: "text", text: userText }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } }
      ]
    }, reportUsage, (reason) => { streamFailure = describeStreamFailure(reason); }));

    if (text === undefined) {
      fail("stream-failed", streamFailure || "llm stream aborted or errored");
    }
    const ops = parseFactOps(text);
    if (!ops) {
      fail("unparseable", "profile facts output was not a usable ops JSON object");
    }

    const sliced = ops.length > MAX_OPS_PER_RUN ? ops.slice(0, MAX_OPS_PER_RUN) : ops;
    const { applied, failures, dupsSkipped } = applyOps(key, sliced, { actor: "auto", runId });
    // 游标取本轮实际消费到的最大 updated_at：ok 轮才推进（含「ops 为空但窗口
    // 已看过」的轮——那是合法的「没什么可改」，不重跑同一窗口）。
    const nextCursor = rows.reduce((m, r) => (String(r.updated_at ?? "") > m ? String(r.updated_at) : m), String(cursor ?? ""));
    const receipt = finish("ok", {
      cursor: nextCursor || cursor,
      inputCount: rows.length,
      opsApplied: applied,
      detail: {
        truncated,
        opsProposed: ops.length,
        opsSliced: ops.length - sliced.length,
        dupsSkipped,
        failures
      }
    });
    store.pruneProfileFactJournal(key);
    return receipt;
  }

  /** 自动轮候选（dream 成功后由 index.js 逐卡 runFor）：只列有增量输入的卡——
   *  无输入的卡连 noop 回执都不落，dream 每轮一次的自动维护不生产回执噪音。 */
  function autoPassCandidates() {
    return cardKeys().filter((key) => {
      try {
        return !!store.countFactInputRows(key, { since: store.profileFactsCursor(key) });
      } catch {
        return true; // 读数失败按「有待维护」处理，交给 runFor 的回执说话
      }
    });
  }

  return { runFor, applyManualOps, cardKeys, factsProvider, listFacts, listJournal, listRuns, autoPassCandidates };
}
