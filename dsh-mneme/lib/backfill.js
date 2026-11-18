// 导入会话的批量回填（DeepSeek APP 导出 → DSH 会话，一次几百条）。
//
// 为什么需要它：DSH 0.2.2-rc.3 的 @deepseek-ai/dsh-deepseek-chat-import 只把导出的
// 会话写成**普通 DSH 会话**——不做压缩、不做摘要、header 里连一个「导入」标记都不写
// （插件 lib/index.js:1355-1377 的 writeSession 只有 version/id/createdAt/cwd/
// isSeeded）。蒸馏链只在新的 `turn/end` 事件上被唤醒（src/summarize.js:1620-1627），
// 历史事件永远不会再触发它，于是这些会话永远不会进记忆库，几百条会话就是几百条
// 空白的 turn——这正是维护者 2026-11-14 说的「又没压缩又要做记忆整理，很麻烦」。
//
// 边界（维护者 2026-11-14 拍板）：
//   - 不碰注入：注入是读侧，回填只写库。
//   - 不占 dream 预算：dream 与蒸馏各有一套 run 表与节流键，这里不碰 dream 的任何计数。
//   - 不新建表：`distill_cursors`（按 session.id 记消费到哪）、`distill_records`
//     （主键 (session_id, seq) 吃重跑）、`distill_runs`（run_type 已留 manual 槽）
//     三张现成的就够断点续跑与去重——重跑安全这条比什么都重要。
//   - 不加第二套抽取语义：沿用同一条 summarize 链、同一份提示词、同一套去重，
//     只把「每窗条数」压到 5 条（`summarizeMaxEntriesPerRun` 的同一条闸门）。
//
// 入口形态（第一期）：手动触发 + dry-run 优先。dry-run 一个 token 都不花，只报数字：
// 扫到多少条导入会话、多少条超出窗口、估算要跑多少次调用。面板按钮第二期再说。
import { readFile } from "node:fs/promises";

import { findSessionFiles, forEachFrame, resolveSessionDir } from "./session-usage.js";
// 判据本身住在 imported-session.js：蒸馏（src/summarize.js）也要用它，而那条路径
// 每轮 turn/end 都会走一次，不该为了一个纯函数把本文件的 fs 扫描链拖进热路径。
// 这里保留 export 是为了不打断既有调用方与测试的 import 路径。
import { IMPORT_ERROR_PREFIX, IMPORT_PROVIDER, isImportedSession } from "./imported-session.js";

export { IMPORT_ERROR_PREFIX, IMPORT_PROVIDER, isImportedSession };

export const DEFAULT_LIMIT = 50;
export const DEFAULT_DAYS = 90;
export const DEFAULT_ROUNDS = 20;
export const DEFAULT_MAX_ENTRIES = 5;

/**
 * 只保留最近 `maxTurns` 轮（`turn/start` 起算），更早的事件整段丢掉。
 *
 * 为什么按轮不按条：一轮的边界是 `turn/start`…`turn/end`，按条切会把工具调用和
 * 它的结果劈开——那比少截一点更糟。`maxTurns <= 0` 表示不截。
 */
export function recentTurns(events, maxTurns = DEFAULT_ROUNDS) {
  const list = Array.isArray(events) ? events : [];
  if (!(maxTurns > 0)) return list;
  const starts = [];
  for (let index = 0; index < list.length; index += 1) {
    if (list[index]?.type === "turn/start") starts.push(index);
  }
  if (starts.length <= maxTurns) return list;
  return list.slice(starts[starts.length - maxTurns]);
}

/**
 * 把一帧帧解码出来的 JSONL 文本拼成事件数组。
 *
 * 磁盘上的事件**带 seq**（实测 19/20 条有；`session` header 那一条没有），所以优先
 * 用文件里的 seq，缺了就按行号补——蒸馏链只认 `Number.isSafeInteger(event.seq)`
 * （src/summarize.js:380-382），没有 seq 的事件会被当「无法证明是新增」而丢掉。
 */
export function parseSessionTexts(texts) {
  const events = [];
  let index = 0;
  for (const text of texts) {
    for (const raw of String(text).split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // 末帧半行是常态（进程被杀/断电），跳过它就是「宁可少一条，不要错一条」。
        continue;
      }
      if (!event || typeof event !== "object") continue;
      if (!Number.isSafeInteger(event.seq)) event.seq = index;
      events.push(event);
      index += 1;
    }
  }
  return events;
}

/**
 * 读一条会话日志：事件、header、以及这一条最后的事件序。
 *
 * `frames`/`failed` 要带回去——解不出来的帧数不为 0 时，这条会话的「已消费」判断
 * 本来就不可靠，上层得能看见。
 */
export async function readSessionFile(file) {
  const buffer = await readFile(file);
  const texts = [];
  const { frames, failed } = forEachFrame(buffer, (text) => texts.push(text));
  const events = parseSessionTexts(texts);
  const header = events.find((event) => event?.type === "session") ?? null;
  const lastSeq = events.length > 0 ? events[events.length - 1].seq : -1;
  return { file, header, events, frames, failed, lastSeq };
}

/**
 * 扫一遍会话目录，给出「要跑哪些、为什么跳过」的账。
 *
 * 不调模型、不写库：`dryRun` 的每一条数字都来自这里，所以 dry-run 与真跑的
 * **筛选口径必须是同一份代码**——两套筛选是这类批量任务最常见的谎。
 *
 * @returns {Promise<object>} 见下方 return 里的字段名。
 */
export async function planBackfill({
  service = null,
  dshHome = undefined,
  sessionDir = undefined,
  now = Date.now(),
  days = DEFAULT_DAYS,
  limit = DEFAULT_LIMIT,
  rounds = DEFAULT_ROUNDS,
  config = null
} = {}) {
  const dir = sessionDir ?? resolveSessionDir({ dshHome });
  const scanned = findSessionFiles(dir);
  const cutoff = now - days * 86400000;
  const plan = {
    sessionDir: dir,
    present: scanned.present,
    truncated: scanned.truncated,
    unreadable: scanned.unreadable.length,
    filesScanned: scanned.files.length,
    importedSessions: 0,
    outsideWindow: 0,
    noCreatedAt: 0,
    alreadyDistilled: 0,
    unreadableFiles: 0,
    pending: 0,
    candidates: [],
    limit,
    days,
    rounds
  };
  const candidates = [];
  for (const file of scanned.files) {
    let reading;
    try {
      reading = await readSessionFile(file);
    } catch {
      plan.unreadableFiles += 1;
      continue;
    }
    if (!isImportedSession(reading.events)) continue;
    plan.importedSessions += 1;
    const createdAt = Number.isFinite(reading.header?.createdAt) ? reading.header.createdAt : null;
    if (createdAt === null) {
      plan.noCreatedAt += 1;
      continue;
    }
    if (createdAt < cutoff) {
      plan.outsideWindow += 1;
      continue;
    }
    const sessionId = typeof reading.header?.id === "string" && reading.header.id
      ? reading.header.id
      : null;
    if (!sessionId) {
      plan.unreadableFiles += 1;
      continue;
    }
    // 断点续跑：游标追上最后一条事件就不再跑（重跑安全靠这张表，不靠内存）。
    const cursor = typeof service?.getDistillCursor === "function"
      ? service.getDistillCursor(sessionId)?.last_seq
      : undefined;
    if (Number.isSafeInteger(cursor) && cursor >= reading.lastSeq) {
      plan.alreadyDistilled += 1;
      continue;
    }
    candidates.push({
      file,
      sessionId,
      createdAt,
      lastSeq: reading.lastSeq,
      cursor: Number.isSafeInteger(cursor) ? cursor : null,
      frames: reading.frames,
      failed: reading.failed
    });
  }
  // 时间倒序：先处理最近的，预算砍掉时损失最小。
  candidates.sort((left, right) => right.createdAt - left.createdAt);
  plan.pending = candidates.length;
  plan.candidates = candidates.slice(0, limit > 0 ? limit : candidates.length);
  // 一次会话一次调用（窗口都压在一轮里），所以调用数就是候选数。
  const routeConfigured = Boolean(config?.summarizeProvider && config?.summarizeModel);
  plan.routeConfigured = routeConfigured;
  plan.callsPlanned = routeConfigured ? plan.candidates.length : 0;
  return plan;
}

/**
 * 真跑（或只跑 dry-run）。
 *
 * `summarizeNow` 由 `createSummarizer` 暴露，方法体是薄薄一层：拿 `snapshotSessionEvents`
 * 组 `{id, events}` 喂进现有链路——**这里不复制任何蒸馏逻辑**。
 *
 * @param {object} options `{ service, summarizer, config, logger, dryRun, limit, days, rounds, sessionDir, dshHome, now, maxEntries }`
 * @returns {Promise<object>} dry-run 回 `{ dryRun: true, plan }`；真跑回逐会话结果。
 */
export async function runBackfill({
  service = null,
  summarizer = null,
  config = null,
  logger = null,
  dryRun = true,
  sessionDir = undefined,
  dshHome = undefined,
  now = Date.now(),
  days = DEFAULT_DAYS,
  limit = DEFAULT_LIMIT,
  rounds = DEFAULT_ROUNDS,
  maxEntries = DEFAULT_MAX_ENTRIES
} = {}) {
  const plan = await planBackfill({ service, dshHome, sessionDir, now, days, limit, rounds, config });
  if (dryRun) return { dryRun: true, plan };
  // 没配蒸馏路由时真跑没有意义：plan 已经把 `callsPlanned` 报成 0，真跑却仍会逐条
  // 调 summarizeNow，每条都因缺 provider/model 失败——50 条会话就是 50 条 failed 加
  // 50 行日志，读起来像「批量任务坏了」而不是「你没配模型」。按 plan 的同一判据直接
  // 拒绝，一条都不跑（dry-run 不受影响，它本来就不调模型）。
  if (!plan.routeConfigured) {
    return { dryRun: false, plan, error: "no-distill-route", ran: 0, failed: 0, results: [] };
  }
  if (typeof summarizer?.summarizeNow !== "function") {
    return { dryRun: false, plan, error: "summarizer-unavailable", results: [] };
  }
  const results = [];
  for (const candidate of plan.candidates) {
    let reading;
    try {
      reading = await readSessionFile(candidate.file);
    } catch (error) {
      results.push({ sessionId: candidate.sessionId, status: "unreadable", error: String(error?.message ?? error) });
      continue;
    }
    const windowed = recentTurns(reading.events, rounds);
    const trigger = windowed[windowed.length - 1];
    if (!trigger) {
      results.push({ sessionId: candidate.sessionId, status: "empty" });
      continue;
    }
    try {
      await summarizer.summarizeNow(
        // header 必须一起给：项目排除门卫读的是 session.header.cwd（创建时冻结
        // 的那份），只带 id + events 的话回填路径上 distillExcludeProjects 永远
        // 不生效——那正是「导入会话不该进库」最该守的一条。
        { id: candidate.sessionId, header: reading.header, events: windowed },
        trigger,
        // bypassImported：回填喂的正是导入会话，必须显式旁路保护层
        // （src/summarize.js 的 imported-session 门卫），否则被自己的墙挡死。
        { bypassPeak: true, bypassImported: true, maxEntries }
      );
      results.push({ sessionId: candidate.sessionId, status: "ran", events: windowed.length });
    } catch (error) {
      logger?.warn?.(`dsh-mneme: backfill ${candidate.sessionId} failed: ${String(error)}`);
      results.push({ sessionId: candidate.sessionId, status: "failed", error: String(error?.message ?? error) });
    }
  }
  const ran = results.filter((item) => item.status === "ran").length;
  return { dryRun: false, plan, ran, failed: results.length - ran, results };
}