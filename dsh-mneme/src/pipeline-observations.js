/**
 * P3 的两个产出：观察旁挂（丙方案）与 tool 不符检出。
 *
 * ## 背景（一句话）
 *
 * 自动归属被实测否决（14.2%，第三方复核 74% 变体唯一），所以写账由人确认；
 * 而人确认时说「这一步做了」，可与本次**实际观察到的业务动作**对不上——
 * 「声明是 npm test，这次一次 npm test 都没看到」。这个矛盾是步骤表过时的信号，
 * 就是 P3 要捕的东西（设计见 mneme-research/mo-foundations/10 号）。
 *
 * ## 丙方案：观察为什么不进账本、要旁挂
 *
 * 账本 `.runs.jsonl` 是**已发布的数据契约**（v0.9.0 发出去的形状），为 P3 加字段
 * 是「动已发布契约」，代价与风险都不必要。所以观察走旁挂文件：
 *
 *     <memoryDir>/observations/<项目键>/<工作流id>.jsonl
 *
 * 这在这个仓库有**三次同构先例**：candidates / proposals / 本目录。
 * 共同纪律：**项目键分桶、只增不改（append-only）、不进仓库、坏行跳过但计数**。
 *
 * ## 🔴 隐私
 *
 * 观察清单的每一项都来自 `pipeline-activities` 的产物——那一层已经**剥掉了位置参数**
 * （完整命令行含绝对路径，路径含本机用户名）。本模块**只存 `{key, count, flags}`**，
 * 拒收任何带命令原文的形状。这是第二道闸：即使上游改了，这里也不放行。
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 观察旁挂的目录：`<memoryDir>/observations/<项目键>/`。与 candidates/proposals 同构。 */
export function observationDir({ memoryDir, projectKey } = {}) {
  if (!projectKey || String(projectKey).trim() === "") return null;
  const base = memoryDir && String(memoryDir).trim() ? memoryDir : "~/.dsh/memory";
  return join(base, "observations", projectKey);
}

/** 观察行的形状闸：只认 {key, count}（flags 可选且必须是旗标数组）。多一个字段都拒。 */
export function validateObservationLine(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "not-object" };
  if (typeof raw.key !== "string" || raw.key.trim() === "") return { ok: false, reason: "bad-key" };
  if (!Number.isInteger(raw.count) || raw.count < 1) return { ok: false, reason: "bad-count" };
  if (raw.flags !== undefined && !Array.isArray(raw.flags)) return { ok: false, reason: "bad-flags" };
  if (raw.command !== undefined || raw.args !== undefined || raw.segments !== undefined) {
    // 🔴 命令原文（或其片段）不许出现在观察行里——那是位置参数泄露的口子
    return { ok: false, reason: "forbidden-field" };
  }
  return { ok: true };
}

/**
 * 落盘一次确认时的观察清单（append-only，幂等键 = confirmAt）。
 *
 * 返回 `{ok, file, lines}`；传 `dryRun: true` 时只校验不写（测试与预览用）。
 */
export function saveObservations({ dir, pipelineId, confirmAt, activities, dryRun = false } = {}) {
  if (!dir) return { ok: false, reason: "no-dir" };
  if (!pipelineId || typeof pipelineId !== "string") return { ok: false, reason: "no-pipeline-id" };
  if (typeof confirmAt !== "string" || confirmAt.trim() === "") return { ok: false, reason: "no-confirm-at" };
  if (!Array.isArray(activities)) return { ok: false, reason: "bad-activities" };

  const valid = [];
  for (const a of activities) {
    // 🔴 先验**原始输入**再构造：多带 command/args/segments 的行要**大声拒**，
    // 不是悄悄剥掉——静默剥离会把上游的形状 bug 藏进一次"成功"的写入里。
    const v0 = validateObservationLine(a);
    if (!v0.ok) return { ok: false, reason: "invalid-line:" + v0.reason, file: null, lines: 0 };
    const line = { key: a.key, count: a.count, ...(Array.isArray(a.flags) && a.flags.length ? { flags: a.flags } : {}) };
    valid.push(line);
  }

  const record = { contract: "mneme.observations/v1", pipelineId, confirmAt, activities: valid };
  const file = join(dir, `${pipelineId}.jsonl`);

  // 幂等：同一 confirmAt 已写过就不重复（confirm 保留待确认状态重答的场景会重放）
  if (existsSync(file)) {
    const seen = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    for (const l of seen) {
      try { if (JSON.parse(l).confirmAt === confirmAt) return { ok: true, file, lines: 0, duplicate: true }; }
      catch { /* 坏行：与读侧同一纪律，跳过但不出声 */ }
    }
  }

  if (dryRun) return { ok: true, file, lines: valid.length, dryRun: true };
  mkdirSync(dir, { recursive: true });
  appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  return { ok: true, file, lines: valid.length };
}

/** 读一个工作流攒下的全部观察（按 confirmAt 升序，坏行跳过并计数）。 */
export function loadObservations(dir, pipelineId) {
  if (!dir || !pipelineId) return { records: [], unreadable: 0 };
  const file = join(dir, `${pipelineId}.jsonl`);
  if (!existsSync(file)) return { records: [], unreadable: 0 };
  const records = [];
  let unreadable = 0;
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      if (r?.contract === "mneme.observations/v1" && Array.isArray(r.activities)) records.push(r);
      else unreadable += 1;
    } catch { unreadable += 1; }
  }
  return { records, unreadable };
}

/**
 * 批量读多个工作流的观察，压成 readPipelineDoc 要的形状：
 *   { [pipelineId]: { latest: { activities } } }
 *
 * `latest` 取最后一条记录（confirmAt 升序写入，末条即最近一次确认）。
 * 没有观察的 id 不出现在结果里——读侧用 `?? null` 降级，不制造空壳。
 */
export function loadObservationsById(dir, pipelineIds) {
  const out = {};
  for (const id of pipelineIds || []) {
    if (typeof id !== "string" || id.trim() === "") continue;
    const { records, unreadable } = loadObservations(dir, id);
    if (records.length === 0) {
      // 有文件但全坏也如实记一条空 latest？——不。空 = 没有观察，与坏文件同形处理，
      //  unreadable 的计数只在单工作流读取时暴露，批量视图里降级为「没有」。
      continue;
    }
    const last = records[records.length - 1];
    out[id] = { latest: { activities: last.activities }, unreadable };
  }
  return out;
}

/**
 * 🔴 核心判据：从「人确认的执行集」与「本次观察到的动作」里算出 tool 不符。
 *
 * - `pipeline.steps[].tool`：人手写的声明（可能是 `git push`，或 `a / b` 多锚点）
 * - `confirmedDone`：人说了 done 的 stepId 集合
 * - `activities`：本次观察到的业务动作（`{key, count}`）——**只认 key，不认命令原文**
 *
 * 返回不符清单。**unsure 与没答不进判据**（那不是「做了但没看到」，是「没确认」）。
 * `declared` 原样带出，不含路径（tool 是作者手写的，且没有经过本模块之外的清洗——
 * 若作者把路径写进 tool，那是步骤表自己的内容，应由步骤表校验层管，不在这里扩大职责）。
 */
export function toolMismatches({ pipeline, confirmedDone, activities } = {}) {
  if (!pipeline || !Array.isArray(pipeline.steps)) return { ok: false, reason: "no-pipeline", items: [] };
  if (!(confirmedDone instanceof Set)) return { ok: false, reason: "bad-confirmed", items: [] };
  if (!Array.isArray(activities)) return { ok: false, reason: "bad-activities", items: [] };

  const seen = new Set(activities.map((a) => String(a?.key ?? "").toLowerCase()).filter(Boolean));
  const items = [];
  for (const step of pipeline.steps) {
    if (!confirmedDone.has(step.id)) continue;
    const declared = typeof step.tool === "string" ? step.tool.trim() : "";
    if (declared === "") continue;              // 纯人判步骤（无 tool 声明）无从矛盾
    const anchors = declared.split("/").map((t) => t.trim().toLowerCase()).filter(Boolean);
    // 多锚点（`a / b`）任一出现即算对上——它们是作者声明的同义做法
    const hit = anchors.some((a) => seen.has(a));
    if (!hit) {
      items.push({
        stepId: step.id,
        title: step.title,
        declared,
        observedTop: activities
          .slice()
          .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
          .slice(0, 3)
          .map((a) => `${a.key} ×${a.count}`)
      });
    }
  }
  return { ok: true, items };
}
