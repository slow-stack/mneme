// dsh-mneme/src/recall-stats.js
// 记忆复用统计（#217）：对 recall_runs + memories 做只读聚合，面板「记忆复用」
// 卡与 GET /api/dsh-mneme/recall-stats 的数据源。
// 独立成模块的原因：service.js 已过 2000 行参考线（AGENTS.md 尺寸约定，#221），
// 新内聚块从第一行就落在自己的文件里，service.js 保留 barrel 出口、调用方零改动。
// 纯读不写，绝不触发任何 write hook。

import { scopeKeyOf } from "./scope.js";

/**
 * 口径（issue #217 评论 2026-09-18，锚 5bd2dab）：
 *  - Top-N：窗口内 recall_runs.candidates（最终返回集）按 id 计数，join
 *    memories 补 type/source；记忆已删的 type=null（标题/来源回退候选值）。
 *    candidates 只存最终集，「入池未中」语义（B）现有表拿不到——v1 只报
 *    零曝光（A），B 待 recordRecall 记录形状扩展。
 *  - 僵尸率：活跃（未归档未遗忘）且窗口内零候选出现；分母剔除写入不足
 *    豁免期的记忆（按当前时刻计，exemptCount 单独报数）。
 *  - 注入命中率：注入侧无留痕，待 #217 mode='inject' 口径拍板后接入。
 *  - 注入命中率：mode='inject' 行单独计数（2026-09-19 拍板），slotFillRate =
 *    注入条数 / (轮数 × maxInjectSlots，默认 5)；注入候选同时进 hits——注入是
 *    曝光型访问事件，计入 Top-N 与僵尸零曝光判定。
 *  - coverage：recallRecordDefault 开启前的窗口算不到，earliestRunAt 为
 *    null（窗口内无回执）或早于窗口起点时，前端标注可信度；扫描行数有
 *    上限，超出标 truncated（degraded 口径），不静默少算。
 *  - archive（#275 拍板的第五指标，与上面几项同位）：
 *    · total = 归档区现有行数；addedInWindow / perDay = 窗口内进入归档区的行数
 *      与其日均（净增速率）。归档时刻取 archived_at（#275 第二批落的精确列）：
 *      setArchived 只在「活跃 → 归档」那一次落值，取消归档清 NULL，重复归档不刷新。
 *      本指标 v1 曾用 updated_at 代理（setArchived 翻标志位时刷它），偏差方向是
 *      **偏高**——对已归档行做一次 memory_update、或对同一行重复调 setArchived(…,
 *      true)，都会把旧归档算成「本窗口新进」。archived_at 就是为消灭这两个假阳性
 *      而加的，别再退回 updated_at。真正的「净」增本来也要跨快照比 total（物理
 *      删除落地后，差值才会由负向变化体现）。
 *    · undated = archived_at 为 NULL 的归档行数（本列落地前就已归档的存量行，时刻
 *      不可追溯）。**刻意不计入 addedInWindow**：它们的归档时刻早于本列落地，无法
 *      证明落在窗口内还是窗口外（迁移当刻，窗口内的存量归档行同样会是 NULL）。用
 *      updated_at 顶替就是走回被推翻的代理口径；按 0 充数则是把「不知道」伪装成
 *      「没有」。单列出来让读侧自判可信度——宁少不脏。
 *    · compressible = 可压掉行数：同 type、同 scope 三维且内容哈希完全相同的归档
 *      行里，多出来的那些（每组留一行）。用内容哈希而不是向量近重复，是因为回收
 *      动作本身会清掉归档行向量（clearArchivedEmbeddings）——指标不能建在它自己
 *      的输入会被回收掉的数据上；精确重复与 #254 的计量口径同一把尺。
 *
 * @param {object} store - createStore 产物（只调用 listRecallRunsSince / all）
 * @param {{ windowDays?: number, exemptDays?: number }} [options]
 */
export function recallStats(store, options = {}) {
  const rawWindow = Number(options.windowDays ?? 30);
  const windowDays = Number.isInteger(rawWindow) && rawWindow >= 1 && rawWindow <= 365 ? rawWindow : 30;
  // 豁免期天数（issue #217 建议 7 天）：option 化是给测试归零用 + 维护者
  // 调口径不留硬编码；越界值静默回默认（与 windowDays 同款宽容）。
  const rawExempt = Number(options.exemptDays ?? 7);
  const exemptDays = Number.isInteger(rawExempt) && rawExempt >= 0 && rawExempt <= 365 ? rawExempt : 7;
  // 注入槽位数（#217 增量）：slotFillRate 分母用；默认 5 与 injectCandidates
  // 的 maxItems 默认一致，option 化防调用方自定义槽位时算错填充率。
  const rawSlots = Number(options.maxInjectSlots ?? 5);
  const maxInjectSlots = Number.isInteger(rawSlots) && rawSlots >= 1 ? rawSlots : 5;
  const now = Date.now();
  const sinceMs = now - windowDays * 86400000;
  const since = new Date(sinceMs).toISOString();

  const { rows: runs, total } = store.listRecallRunsSince(since);
  const hits = new Map(); // id -> { count, title, source }
  // 注入命中率口径（#217 增量，2026-09-19 拍板）：mode='inject' 行单独计数，
  // slotFillRate = 注入条数 / (轮数 × 槽位数)；注入候选同时进 hits——注入是
  // 曝光型访问事件，计入 Top-N 与僵尸零曝光判定。
  let injectRuns = 0;
  let injectedCount = 0;
  for (const run of runs) {
    const cands = run.candidates ?? [];
    if (run.mode === "inject") {
      injectRuns += 1;
      injectedCount += cands.length;
    }
    for (const cand of cands) {
      if (!cand?.id) continue;
      const cur = hits.get(cand.id) ?? { count: 0, title: cand.title ?? null, source: cand.source ?? null };
      cur.count += 1;
      hits.set(cand.id, cur);
    }
  }

  const memories = store.all();
  const memoryIndex = new Map(memories.map((m) => [m.id, m]));
  const EXEMPT_MS = exemptDays * 86400000;
  const byType = {};
  const bySource = {};
  let activeCount = 0;
  let zombieCount = 0;
  let exemptCount = 0;
  // 第五指标（#275）：归档区一侧单独累计，分组键与 #254 的去重候选集同构
  // （type + 哈希 + scope 三维）——可压掉的必须是「本来就会被判成同一件事」的行。
  let archivedTotal = 0;
  let archivedInWindow = 0;
  let archivedUndated = 0;
  const hashGroups = new Map();
  for (const m of memories) {
    if (m.archived) {
      archivedTotal += 1;
      // 精确口径：只认 archived_at。NULL = 本列落地前的存量归档行，时刻不可追溯
      // （见文件头 undated 段）——不拿 updated_at 顶替，那正是被本批推翻的代理口径。
      const archivedMs = Date.parse(m.archived_at ?? "");
      if (Number.isFinite(archivedMs)) {
        if (archivedMs >= sinceMs) archivedInWindow += 1;
      } else {
        archivedUndated += 1;
      }
      if (m.content_hash) {
        const key = [
          m.type ?? "",
          m.content_hash,
          scopeKeyOf(m.agent_scope) ?? "",
          scopeKeyOf(m.workspace_scope) ?? "",
          scopeKeyOf(m.sensitivity) ?? ""
        ].join("\u0000");
        hashGroups.set(key, (hashGroups.get(key) ?? 0) + 1);
      }
      continue;
    }
    if (m.forgotten) continue;
    const createdMs = Date.parse(m.created_at ?? "");
    // created_at 解析不了时无法证明已过机会期 → 归入豁免，宁漏勿误伤
    if (!Number.isFinite(createdMs) || now - createdMs < EXEMPT_MS) {
      exemptCount += 1;
      continue;
    }
    activeCount += 1;
    const zombied = !hits.has(m.id);
    if (zombied) zombieCount += 1;
    const type = m.type ?? "unknown";
    const source = m.source ?? "unknown";
    if (!byType[type]) byType[type] = { active: 0, zombie: 0 };
    const t = byType[type];
    t.active += 1;
    if (zombied) t.zombie += 1;
    if (!bySource[source]) bySource[source] = { active: 0, zombie: 0 };
    const s = bySource[source];
    s.active += 1;
    if (zombied) s.zombie += 1;
  }

  const topRecalled = [...hits.entries()]
    .map(([id, h]) => {
      const m = memoryIndex.get(id);
      return { id, title: m?.title ?? h.title, type: m?.type ?? null, source: m?.source ?? h.source, count: h.count };
    })
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, 10);

  let compressibleGroups = 0;
  let compressibleRows = 0;
  for (const n of hashGroups.values()) {
    if (n < 2) continue;
    compressibleGroups += 1;
    compressibleRows += n - 1;
  }

  return {
    windowDays,
    generatedAt: new Date(now).toISOString(),
    coverage: {
      runsScanned: runs.length,
      runsTotal: total,
      truncated: total > runs.length,
      earliestRunAt: runs.length ? runs[0].created_at : null
    },
    injection: {
      runs: injectRuns,
      injectedCount,
      slotFillRate: injectRuns > 0 ? injectedCount / (injectRuns * maxInjectSlots) : null
    },
    topRecalled,
    // #275 第五指标：归档净增速率 + 可压掉行数（口径见文件头）
    archive: {
      total: archivedTotal,
      addedInWindow: archivedInWindow,
      perDay: Math.round((archivedInWindow / windowDays) * 100) / 100,
      undated: archivedUndated,
      compressible: { rows: compressibleRows, groups: compressibleGroups }
    },
    zombie: {
      activeCount,
      zombieCount,
      exemptCount,
      rate: activeCount > 0 ? zombieCount / activeCount : null,
      byType,
      bySource
    }
  };
}
