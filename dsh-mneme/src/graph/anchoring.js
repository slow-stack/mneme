// dsh-mneme/src/graph/anchoring.js
// 图谱锚定层（issue #24 · 块1 Activation Anchoring）。
import assert from "node:assert/strict";
// 纯函数模块：把「查询命中实体的多路激活信号」归一化、合并成种子集、再沿
// entity_relations 级联扩散。零数据库依赖——store 侧查询由调用方注入，
// 本模块只做信号处理，便于单测与与其他召回通路（BM25/向量）同等对待。
//
// 设计输入来自 #24 合议 + heptaspirit serendipity-engine 实战（#24 评论）：
//  - 归一化二分法：连续分（cos/PPR）走 min-max；匹配通路（精确/tag/别名）
//    走离散级别，不用 min-max——布尔通路用 min-max 会把「中 1 个」和「中
//    20 个」都拉平到 1.0，级别信息被压平。
//  - 级联扩散加「跳数配额」：λ/θ 只管可及性，可见性由配额决定——直接按 hop
//    深度打 0.5/0.3/0.2 权重，配桶内 round-robin，防深跳被 1-hop 完全压住。
//  - graphSeedCap：防「多锚点命中 + 模糊通路」把种子集撑爆成整库。
//  - 排序稳定：并列按实体 ID 破序（同输入两次结果不同会让 A/B 调参白做）。

/** 匹配通路的离散级别（heptaspirit 建议：布尔/计数通路不用 min-max）。 */
export const DISCRETE_LEVELS = Object.freeze({
  exact: 1.0, // 名称精确含于查询（布尔 1.0）
  title: 0.8, // 实体名匹配记忆标题（tag/别名层）
  alias: 0.6,
  tag: 0.4,   // tag 共现
  substring: 0.2, // 子串命中（最弱，纯计数不级联）
});

/** 级联每跳的权重（跳数配额：1:2:3-hop = 0.5/0.3/0.2）。 */
export const HOP_QUOTA = Object.freeze({ 1: 0.5, 2: 0.3, 3: 0.2 });

/**
 * 连续分 min-max 归一化（向量 cos 相似度、PPR 激活分等）。
 * 输入 [] 或全同值时返回原样（无尺度可压平，防除零）。
 */
export function minMax(scores) {
  const arr = Array.isArray(scores) ? scores : [];
  if (arr.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const v of arr) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < 1e-12) return arr.map(() => 1); // 平局视为满权
  return arr.map((v) => (v - min) / (max - min));
}

/**
 * 把一条检测通路的结果归一化成 0..1 的打分表。
 * path 是离散通路名（exact/tag/...）→ 查 DISCRETE_LEVELS；是连续通路
 * （continuous=true）→ min-max。返回 { path, byId: Map<id, score>, order }。
 *
 * issue #24 块1 补充：返回值带上 `path`。anchorSeeds 用它记「这个种子被哪几路
 * 激活」（`seeds[i].paths`），复核时据此判断一条边是被精确名、Tag 桥接还是向量
 * 拉进来的。此前只有 { byId, order }，`p.path ?? "?"` 把每一路都记成 "?"，
 * 通路身份在合并那一步就丢了。连续通路调用方传 `path: "vector"`（cos 相似度）。
 */
export function normalizePath(hits, { path = "exact", continuous = false } = {}) {
  const ids = Array.isArray(hits) ? hits : [];
  const byId = new Map();
  if (continuous) {
    const raw = ids.map((h) => (typeof h === "number" ? h : h?.score ?? 0));
    const norm = minMax(raw);
    ids.forEach((h, i) => {
      const id = typeof h === "object" ? h.id : h;
      byId.set(id, norm[i]);
    });
  } else {
    const level = DISCRETE_LEVELS[path] ?? DISCRETE_LEVELS.substring;
    for (const id of ids) byId.set(id, level);
  }
  return { path, byId, order: [...byId.keys()] };
}

/**
 * 合并多路激活成种子集：每路先归一化（调用方负责通路分类），再累加。
 * seedsCap 上限（graphSeedCap，默认 12）；封顶前按总分排序取前 N——保证
 * 扩散的是活跃子图而非冷启动点爆整库。
 * 返回 { id, name, score, paths: Set } 列表，按 score 降序、name 升序（稳定）。
 */
export function anchorSeeds({ paths = [], cap = 12 } = {}) {
  const score = new Map();
  const nameOf = new Map();
  const pathSet = new Map();
  for (const p of paths) {
    for (const [id, s] of p.byId ?? []) {
      score.set(id, (score.get(id) ?? 0) + s);
      if (!pathSet.has(id)) pathSet.set(id, new Set());
      pathSet.get(id).add(p.path ?? "?");
      if (p.nameOf?.has?.(id)) nameOf.set(id, p.nameOf.get(id));
    }
  }
  let seeds = [...score.entries()].map(([id, s]) => ({
    id,
    name: nameOf.get(id) ?? id,
    score: s,
    paths: pathSet.get(id) ?? new Set()
  }));
  seeds.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (cap > 0 && seeds.length > cap) seeds = seeds.slice(0, cap);
  return seeds;
}

/**
 * 级联扩散：从种子实体出发沿 adjacency 走 BFS，为每个可达实体贴最短深度。
 * depth 上界默认 2（[1,3] 配置范围）。返回 Map<entityId, minDepth>——
 * 调用方据此取 HOP_QUOTA[minDepth] 权重 + 桶内 round-robin（见 pickByHopQuota）。
 * adjacency 由调用方提供（store.getEntityNeighbors(id) 或全量邻接矩阵），
 * 本模块不感知存储。
 */
export function cascadeDepths({ seeds, adjacencyOf, maxDepth = 2 } = {}) {
  const depths = new Map();
  const idOfSeeds = (seeds ?? []).map((s) => (typeof s === "object" ? s.id : s));
  const queue = [];
  for (const id of idOfSeeds) {
    if (!depths.has(id)) {
      depths.set(id, 0);
      queue.push([id, 0]);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const [id, d] = queue[i];
    if (d >= maxDepth) continue;
    let neighbors = [];
    try {
      neighbors = typeof adjacencyOf === "function" ? adjacencyOf(id) : (adjacencyOf?.get?.(id) ?? []);
    } catch { /* single neighbor fetch failure: keep spreading from the rest */ }
    for (const nb of neighbors) {
      const nid = typeof nb === "object" ? nb.id : nb;
      if (!nid || depths.has(nid)) continue;
      depths.set(nid, d + 1);
      queue.push([nid, d + 1]);
    }
  }
  return depths;
}

/**
 * 跳数配额选取：候选实体按深度分层，层内按（分，ID）稳定排序后取额度。
 * quota 形如 { 1: 0.5, 2: 0.3, 3: 0.2 }——每层最多取 ceil(depthCap * quota[d]) 个，
 * 桶内按 score 降序（并列按 ID）。返回 { ids, scoreOf, depthOf }。
 * 这一步把「级联可及性」与「最终可见性」解耦（heptaspirit：λ/θ 只管前者）。
 */
export function pickByHopQuota({
  depths = new Map(),
  scoreOf = () => 0,
  maxDepth = 2,
  depthCap = 12
} = {}) {
  const buckets = new Map(); // depth -> [{id, score}]
  for (const [id, d] of depths) {
    if (d === 0 || d > maxDepth) continue;
    const key = Math.min(d, 3);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ id, score: scoreOf(id) ?? 0 });
  }
  const picked = [];
  for (const [d, items] of buckets) {
    items.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const quota = HOP_QUOTA[d] ?? 0.2;
    const n = Math.max(1, Math.floor(depthCap * quota));
    picked.push(...items.slice(0, n).map((x) => x.id));
  }
  // 队内稳定序：按深度升序（1-hop 优先），保证可感知的扩散次序。
  picked.sort((a, b) => (depths.get(a) - depths.get(b)) || (a < b ? -1 : a > b ? 1 : 0));
  return { ids: picked, scoreOf, depthOf: depths };
}

// Lightweight self-check (ponytail: 非平凡逻辑留一个可运行断言)。
export function _selfCheck() {
  const exact = normalizePath(["e1", "e2"], { path: "exact" });
  const tag = normalizePath(["e2", "e3"], { path: "tag" });
  assert(exact.byId.get("e1") === 1.0 && exact.byId.get("e2") === 1.0, "exact level");
  assert(tag.byId.get("e2") === 0.4 && tag.byId.get("e3") === 0.4, "tag level");
  const seeds = anchorSeeds({ paths: [exact, tag], cap: 10 });
  assert(seeds[0].id === "e2", "merged highest first"); // e2: 精确+tag = 1.4
  assert(seeds[0].score >= 1.4 - 1e-9, "score accumulates");
  const adj = new Map([
    ["e2", ["n1", "n2"]],
    ["n1", ["n2", "deep3"]],
  ]);
  const depths = cascadeDepths({ seeds, adjacencyOf: (id) => adj.get(id) ?? [], maxDepth: 2 });
  assert(depths.get("n1") === 1 && depths.get("n2") === 1 && depths.get("deep3") === 2, "bfs depth");
  const { ids } = pickByHopQuota({ depths, maxDepth: 2, depthCap: 12 });
  assert(ids.includes("n1") && ids.includes("n2") && ids.includes("deep3"), "quota picks all");
  return "anchoring self-check ok";
}