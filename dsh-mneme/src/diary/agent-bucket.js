/**
 * #613 §2：Agent 身份的解析与**落定**。
 *
 * 「一个 Agent 一本」的键不是 sessionId（live 库实测：同一个 bot 名下 24 个会话，
 * 按 sessionId 分区一个 bot 会散成 N 本），也不是项目键——是「这是谁」。
 *
 * 解析三级：
 * 1. **已落定**：sessions.json 里记过的会话，首次写入时就定了，不再变；
 * 2. **标题「·」前缀**：`source === "user"` 的标题取「·」前缀，且前缀必须命中
 *    已知名单（人格卡的名字）。`fallback` 整句标题绝不当 id——「可以生图吧？……」
 *   这种标题造出一个目录，等于让不存在的 Agent 有一本日记；
 * 3. **header.agentPreset**：有就认（它与人格卡的寻址同一来源）；
 * 4. 都没有 → `_unnamed`。冷行（插件从没见过的会话）默认也进 `_unnamed`；
 *    `diaryBackfillColdAgents` 打开且宿主给了会话标题投影时才尝试解冷行，
 *    且解的是标题的 source.kind（user/fallback），不是 agent 归属——命中不了
 *    名单仍然留 `_unnamed`。
 *
 * 落定纪律（#613 评审补充）：**agentId 只在会话首次被写入时落定**。之后用户改
 * 标题（哪怕改回了另一个 bot 的前缀）只更新展示名，不动目录——否则改一次标题，
 * 那本日记就多出一本、旧的那本变成孤儿。
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../pipeline-nudge.js";
import { sessionAgentId } from "./session-provider.js";
import { isBucketName } from "./dir.js";

export const UNNAMED_AGENT = "_unnamed";

/** 会话标题与来源。snapshotEvents 尾部最后一个 title 事件是当前标题。 */
export function sessionTitleOf(session) {
  try {
    const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : session?.events;
    if (!Array.isArray(events)) return null;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e?.type === "session/title") {
        const title = typeof e.data?.title === "string" ? e.data.title.trim() : "";
        const kind = typeof e.data?.source === "string" ? e.data.source : "";
        return title || kind ? { title, kind } : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 标题「·」前缀（「Amarre · 记忆研究」→ "Amarre"）。没有「·」返回空串。 */
export function titlePrefix(title) {
  const s = String(title ?? "");
  const at = s.indexOf("·");
  return at > 0 ? s.slice(0, at).trim() : "";
}

/** 已知名单：人格卡的名字与键（byAgent 键本身也是身份候选）。全小写比较，返回原样名字。 */
export function personaAgentNames(settings) {
  const names = new Map();
  try {
    const p = typeof settings?.getPersona === "function" ? settings.getPersona() : null;
    if (p) {
      if (p.default && typeof p.default.name === "string" && p.default.name.trim()) {
        names.set(p.default.name.toLowerCase(), p.default.name.trim());
      }
      for (const [k, card] of Object.entries(p.byAgent ?? {})) {
        if (typeof k === "string" && k.trim()) names.set(k.toLowerCase(), k.trim());
        if (card && typeof card.name === "string" && card.name.trim()) names.set(card.name.toLowerCase(), card.name.trim());
      }
    }
  } catch {
    // 人格读不到就是空名单：全部会话落到 preset 或 _unnamed，不阻断日记。
  }
  return names;
}

/**
 * 解析（不落盘）。`mapping` 是已落定的表（sessionId → agentId）；命中的直接返回，
 * 没命中的走三级解析。
 */
export function resolveAgentId({ session, knownNames, mapping }) {
  const id = typeof session?.id === "string" ? session.id : "";
  const settled = mapping && typeof mapping === "object" ? mapping[id] : null;
  if (settled && typeof settled.agent === "string" && settled.agent) return settled.agent;
  const title = sessionTitleOf(session);
  if (title && title.kind === "user") {
    const prefix = titlePrefix(title.title).toLowerCase();
    if (prefix && knownNames instanceof Map && knownNames.has(prefix)) {
      return knownNames.get(prefix);
    }
  }
  const preset = sessionAgentId(session);
  if (preset && isBucketName(preset)) return preset;
  return UNNAMED_AGENT;
}

/** agents/sessions.json 的读与写。形状 {v:1, bySession: {id: {agent, title, source}}}。 */
export function readAgentSessions(root) {
  try {
    const raw = JSON.parse(readFileSync(join(root, "sessions.json"), "utf8"));
    return raw && typeof raw === "object" && raw.bySession && typeof raw.bySession === "object" && !Array.isArray(raw.bySession)
      ? raw.bySession
      : {};
  } catch {
    return {};
  }
}

export function writeAgentSessions(root, bySession) {
  // 首次落定发生在目录还不存在时（agent 桶尚未有任何日记）：先建 agents/ 再写。
  mkdirSync(root, { recursive: true });
  writeFileAtomic(join(root, "sessions.json"), JSON.stringify({ v: 1, bySession }, null, 2) + "\n");
}

/** 某个 agent 名下（已落定的）全部会话 id。 */
export function agentSessionIds(bySession, agentId) {
  const out = [];
  for (const [id, row] of Object.entries(bySession)) {
    if (row && row.agent === agentId && id) out.push(id);
  }
  return out;
}

/**
 * 落定并返回 {agentId, sessionIds}。
 *
 * - 会话已有落定 → 原样返回（顺带更新展示标题，不动 agent）；
 * - 没有落定 → 解析一次并写进索引（**首次写入落定**：调用方是 compose 触发前）。
 * 返回的 sessionIds 是这个 agent 名下全部会话 id（含本次这条）——素材查询的输入。
 */
export function settleAgent({ root, session, knownNames }) {
  const map = readAgentSessions(root);
  const id = typeof session?.id === "string" ? session.id.trim() : "";
  const title = sessionTitleOf(session);
  const known = id && map[id] ? map[id] : null;
  if (known && typeof known.agent === "string" && known.agent) {
    if (title && title.title !== known.title) {
      known.title = title.title;
      known.source = title.kind;
      map[id] = known;
      writeAgentSessions(root, map);
    }
    return { agentId: known.agent, sessionIds: agentSessionIds(map, known.agent) };
  }
  const agentId = resolveAgentId({ session, knownNames, mapping: {} });
  if (id) {
    map[id] = { agent: agentId, title: title?.title ?? "", source: title?.kind ?? "" };
    writeAgentSessions(root, map);
  }
  return { agentId, sessionIds: agentSessionIds(map, agentId) };
}

/**
 * 冷行回填（diaryBackfillColdAgents=true 时）：对索引里没有的会话，尝试从宿主的
 * 会话标题投影里拿标题做解析。投影没有公开形状约束，这里对三种可能的读取口逐一
 * 试（list / snapshot / entries），全都没有就是空——冷行留在 `_unnamed`，那正是
 * 验收里「命中不了名单仍留 _unnamed」的结局。
 */
export function backfillColdSessions({ ctx, root, knownNames }) {
  const proj = ctx?.sessionProjections ?? null;
  if (!proj || typeof proj !== "object") return 0;
  const map = readAgentSessions(root);
  let rows = null;
  for (const name of ["list", "snapshot", "entries"]) {
    try {
      const v = typeof proj[name] === "function" ? proj[name]() : null;
      if (Array.isArray(v) && v.length) {
        rows = v;
        break;
      }
    } catch {
      // 某个口不存在换下一个。
    }
  }
  if (!rows) return 0;
  let settled = 0;
  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (!id || map[id]) continue;
    const title = typeof row.title === "string" ? row.title.trim() : "";
    const kind = typeof row.source === "string" ? row.source : "";
    if (!title) continue;
    if (kind !== "user") continue; // fallback 整句标题不认，同 resolveAgentId 的口径
    const prefix = titlePrefix(title).toLowerCase();
    if (!prefix || !knownNames.has(prefix)) continue;
    map[id] = { agent: knownNames.get(prefix), title, source: kind };
    settled += 1;
  }
  if (settled) writeAgentSessions(root, map);
  return settled;
}
