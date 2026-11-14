// Recall benchmark (v0.5.0 评测体系): a self-contained harness that seeds an
// in-memory store with labelled memories, runs a standard query set through
// the real searchMemories pipeline, and reports Recall@K / MRR per case and
// in aggregate. Runs in two configurations so the BM25/third-path lift is
// visible: `legacy` (bm25 + adaptive + dedup off) vs `fused` (defaults on).
//
// Usage:
//   node scripts/benchmark-recall.js            # run both configurations
//   node scripts/benchmark-recall.js --json     # machine-readable output
// The harness exports runBenchmark()/TEST_CASES for the test suite; the CLI
// path below only executes when invoked directly.
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";

// Deterministic toy embedder: bag-of-words hashed into a fixed-dimension
// vector, so cosine similarity ≈ lexical overlap. Good enough to exercise
// the vector path mechanically — semantic quality is not under test here.
const DIM = 256;
function hashVec(text) {
  const v = new Array(DIM).fill(0);
  const tokens = String(text ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const t of tokens) {
    let h = 0;
    for (const ch of t) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    v[h % DIM] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

const SEED = [
  { id: "mem_user_pref", type: "preference", title: "编辑器偏好", content: "用户偏好 VS Code，深色主题，等宽字体 JetBrains Mono", importance: 4, tags: ["editor"] },
  { id: "mem_user_project", type: "project", title: "dsh-mneme 插件项目", content: "用户在开发 dsh-mneme 记忆插件，TypeScript 与 cordis 框架", importance: 5, tags: ["plugin"] },
  { id: "mem_rust_switch", type: "decision", title: "语言迁移决策", content: "项目编译模块从 Go 迁移到 Rust，理由是内存安全", importance: 4, tags: ["rust"] },
  { id: "mem_zfs_bug", type: "project", title: "ZFS-4421 数据损坏", content: "线上池 ZFS-4421 出现 checksum 错误，根因是 HBA 固件 bug", importance: 5, tags: ["ops"] },
  { id: "mem_city_thesis", type: "project", title: "湿地论文", content: "毕业论文研究城市湿地公园周边开发案例，ArcGIS 空间分析", importance: 4, tags: ["thesis"] },
  { id: "mem_async_pattern", type: "decision", title: "异步并发模式", content: "async runtime 选用 tokio，任务用 spawn 管理，channel 通信", importance: 3, tags: ["rust"] },
  { id: "mem_python_etl", type: "project", title: "ETL 脚本", content: "夜间 ETL 用 Python 编写，pandas 清洗，SQLite 落地", importance: 3, tags: ["etl"] },
  { id: "mem_ui_style", type: "preference", title: "界面审美", content: "喜欢编辑风 brutalism 排版，低饱和度配色，衬线标题", importance: 3, tags: ["design"] },
  // Cross-topic distractors (plan #0): memories that share keywords with a
  // target but belong to a different subject. They raise the recall bar — the
  // fused ranking must keep the true positive ahead of the distractor, which
  // is exactly what a scale-mixed blend (raw cosine + keyword score + IDF)
  // tends to get wrong.
  { id: "mem_ops_alert", type: "project", title: "存储告警", content: "Prometheus 存储告警走 zfs 池健康检查与磁盘替换流程", importance: 3, tags: ["ops"] },
  { id: "mem_rust_dep", type: "project", title: "rust 依赖", content: "Rust 项目的 cargo 依赖管理与 workspace 组织", importance: 3, tags: ["rust"] },
  { id: "mem_etl_csv", type: "project", title: "ETL CSV", content: "每日 CSV 导入脚本用 golang 而非 python，写 postgres", importance: 2, tags: ["etl"] },
  { id: "mem_ux_toolbar", type: "preference", title: "工具栏", content: "偏好 IDE 顶栏简洁，避免深色浮层遮挡代码", importance: 2, tags: ["design"] }
];

// Standard query set: each case is a query plus the ids that MUST appear in
// the top-K for the case to count as a hit. Covers the three recall paths —
// multi-term lexical (BM25's home turf), identifier lookup, and semantic.
// Optional per case: `forbidden` — ids that must NOT appear in the top-K.
// Anti-update probes (E6, #280 链；StatemenBench anti-update probes)：锁的
// 回归类是「supersede 后旧值复现」——被取代旧条靠 archived=1 从四路检索里
// **排除**（不是降权）。未来谁把任一默认检索路径改成 archived 宽容的降权、
// 或把归档行重新放回候选池，forbiddenHit 就会 >0，这里先红。
export const TEST_CASES = [
  { query: "rust 异步", expected: ["mem_async_pattern", "mem_rust_switch"], note: "scattered terms — BM25 territory" },
  { query: "ZFS-4421 checksum", expected: ["mem_zfs_bug"], note: "identifier + keyword" },
  { query: "插件 开发", expected: ["mem_user_project"], note: "multi-term CJK" },
  { query: "论文 空间分析", expected: ["mem_city_thesis"], note: "scattered CJK terms" },
  { query: "ETL 脚本", expected: ["mem_python_etl"], note: "mixed" },
  { query: "深色主题", expected: ["mem_user_pref"], note: "substring match" },
  { query: "channel 通信 任务", expected: ["mem_async_pattern"], note: "scattered terms" },
  { query: "内存安全 语言", expected: ["mem_rust_switch"], note: "scattered terms" },
  { query: "配色 审美", expected: ["mem_ui_style"], note: "scattered CJK" },
  { query: "HBA 固件", expected: ["mem_zfs_bug"], note: "scattered terms" },
  // Plan #0 additions: a distractor-dominance case (the target shares the
  // leading token with a cross-topic memory that must rank below it) and an
  // exact-token case that leans on the BM25 path.
  { query: "zfs 磁盘 替换", expected: ["mem_zfs_bug"], note: "shared-token distractor" },
  { query: "tokio spawn channel", expected: ["mem_async_pattern"], note: "exact async tokens" },
  // Anti-update probes（配 seedService 里的 supersede pair）：第二条 query 的
  // 措辞只与被取代的旧值（Go 选型）重叠——归档旧条若经任一默认路径复现，
  // forbiddenHit > 0；同时新值必须照常命中（取代后话题有活答案）。
  { query: "编译模块 语言 选型", expected: ["mem_rust_switch"], forbidden: ["mem_rust_switch_old"], note: "anti-update: winner must answer the topic" },
  { query: "Go 部署 简单", expected: ["mem_rust_switch"], forbidden: ["mem_rust_switch_old"], note: "stale-value bait: wording matches only the superseded value" }
];

export function seedService(overrides = {}) {
  const store = createStore(":memory:");
  const config = {
    bm25SearchEnabled: true,
    adaptiveThresholdEnabled: true,
    searchSemanticDedup: true,
    searchSemanticDedupThreshold: 0.95,
    selectiveInjectEnabled: true,
    entitySearchEnabled: false,
    ...overrides
  };
  const service = createService({ store, mirror: null, config, logger: null });
  const vectorIndex = createVectorIndex({ store, logger: null });
  service.setVectorIndex(vectorIndex);
  service.setEmbedder({
    embedSingle: async (text) => hashVec(text)
  });
  for (const m of SEED) {
    // store.save accepts a caller-supplied id (store.js: memory.id ?? randomUUID).
    // Passing m.id keeps the seeded id stable so TEST_CASES.expected (which
    // references mem_*) match — without it every row gets a UUID and the
    // benchmark always reports 0% recall.
    const row = store.save({ id: m.id, type: m.type, title: m.title, content: m.content, tags: m.tags, importance: m.importance, source: "seed" });
    store.setEmbedding(row.id, hashVec(`${m.title} ${m.content}`));
  }
  // Supersede pair（anti-update 探针的种子）：复刻 dream/decisions.js
  // applySupersede 留下的确切落库状态——没有独立的取代列，取代关系完全由
  // loser 的 archived=1 + 正文 (superseded by: …) 注记表达。winner 就是
  // 上面的 mem_rust_switch 种子行，让「编译语言」话题始终有活答案，
  // 归档的 Go 旧决策必须保持不可见。
  const loserContent = "项目编译模块使用 Go 语言，选型理由是部署简单\n\n(superseded by: 语言迁移决策)";
  const loser = store.save({ id: "mem_rust_switch_old", type: "decision", title: "编译模块语言（旧）", content: loserContent, importance: 4, tags: ["rust"], source: "seed" });
  store.setEmbedding(loser.id, hashVec(`编译模块语言（旧） ${loserContent}`));
  store.setArchived(loser.id, true);
  return service;
}

export async function runBenchmark({ topK = 5, mode = "auto" } = {}) {
  const configs = [
    // #713: with adaptive thresholds off and no explicit threshold, the vector
    // path now applies the configured fixed cutoff (0.65) instead of an
    // unconditional no-cutoff. This arm exists to isolate *ranking recipe*
    // differences on a toy hash embedder whose cosines are much lower than a
    // real model's, so it must ask for "no cutoff" explicitly rather than
    // inherit a fixed one it never intended.
    { name: "legacy", overrides: { bm25SearchEnabled: false, adaptiveThresholdEnabled: false, searchSemanticDedup: false, vectorSearchThreshold: 0 } },
    { name: "fused", overrides: {} }
  ];
  const runs = [];
  for (const cfg of configs) {
    const service = seedService(cfg.overrides);
    const rows = [];
    let hits = 0;
    let mrrSum = 0;
    let leaks = 0;
    for (const tc of TEST_CASES) {
      const results = await service.searchMemories(tc.query, { mode, topK, useRerank: false });
      const ids = results.map((r) => r.id);
      const metrics = service.computeRetrievalMetrics(ids, tc.expected);
      if (metrics.recall === 1) hits++;
      mrrSum += metrics.mrr;
      // forbidden 命中数：anti-update 探针的判定（见 TEST_CASES 头注释）。
      const forbiddenHit = (tc.forbidden ?? []).filter((id) => ids.includes(id)).length;
      if (forbiddenHit > 0) leaks++;
      rows.push({
        query: tc.query,
        note: tc.note,
        expected: tc.expected,
        ...(tc.forbidden ? { forbidden: tc.forbidden } : {}),
        forbiddenHit,
        got: ids,
        ...metrics
      });
    }
    runs.push({
      config: cfg.name,
      recallAtK: +(hits / TEST_CASES.length).toFixed(3),
      avgMrr: +(mrrSum / TEST_CASES.length).toFixed(3),
      forbiddenHits: leaks,
      rows
    });
  }
  return { topK, mode, runs };
}

/**
 * Fusion-recipe A/B (plan #1): runs the same seed + query set with
 * config.recallFusion forced to each of blend / rrf / minmax, so the scale
 * mismatch fix can be judged on identical data. `blend` is the legacy recipe
 * and acts as the control — the pre-fusion behavior.
 */
export async function runFusionBenchmark({ topK = 5, mode = "auto" } = {}) {
  const recipes = ["blend", "rrf", "minmax"];
  const runs = [];
  for (const recipe of recipes) {
    const service = seedService({ recallFusion: recipe });
    const rows = [];
    let hits = 0;
    let mrrSum = 0;
    let leaks = 0;
    for (const tc of TEST_CASES) {
      const results = await service.searchMemories(tc.query, { mode, topK, useRerank: false });
      const ids = results.map((r) => r.id);
      const metrics = service.computeRetrievalMetrics(ids, tc.expected);
      if (metrics.recall === 1) hits++;
      mrrSum += metrics.mrr;
      const forbiddenHit = (tc.forbidden ?? []).filter((id) => ids.includes(id)).length;
      if (forbiddenHit > 0) leaks++;
      rows.push({
        query: tc.query,
        note: tc.note,
        expected: tc.expected,
        ...(tc.forbidden ? { forbidden: tc.forbidden } : {}),
        forbiddenHit,
        got: ids,
        ...metrics
      });
    }
    runs.push({
      config: recipe,
      recallAtK: +(hits / TEST_CASES.length).toFixed(3),
      avgMrr: +(mrrSum / TEST_CASES.length).toFixed(3),
      forbiddenHits: leaks,
      rows
    });
  }
  return { topK, mode, runs };
}

function printFusionReport(report) {
  for (const run of report.runs) {
    console.log(`\n=== ${run.config} (topK=${report.topK}, mode=${report.mode}) ===`);
    for (const r of run.rows) {
      const ok = r.recall === 1 ? "PASS" : "MISS";
      const leak = r.forbiddenHit > 0 ? " LEAK" : "";
      console.log(`  [${ok}${leak}] "${r.query}" (${r.note}) recall=${r.recall} mrr=${r.mrr}`);
      if (r.recall < 1) console.log(`         expected ⊇ ${r.expected.join(", ")}  got: ${r.got.join(", ") || "—"}`);
      if (r.forbiddenHit > 0) console.log(`         forbidden hit ×${r.forbiddenHit}: ${r.got.filter((id) => r.forbidden.includes(id)).join(", ")}`);
    }
    console.log(`  → Recall@${report.topK}: ${(run.recallAtK * 100).toFixed(1)}%   avg MRR: ${run.avgMrr}` +
      (run.forbiddenHits > 0 ? `   forbiddenHits: ${run.forbiddenHits}` : ""));
  }
  const summary = report.runs.map((r) => `${r.config}=${(r.recallAtK * 100).toFixed(1)}%`).join("  ");
  console.log(`\n融合配方 A/B (Recall@${report.topK}, ${report.mode}): ${summary}`);
}

function printReport(report) {
  for (const run of report.runs) {
    console.log(`\n=== ${run.config} (topK=${report.topK}, mode=${report.mode}) ===`);
    for (const r of run.rows) {
      const ok = r.recall === 1 ? "PASS" : "MISS";
      const leak = r.forbiddenHit > 0 ? " LEAK" : "";
      console.log(`  [${ok}${leak}] "${r.query}" (${r.note}) recall=${r.recall} mrr=${r.mrr}`);
      if (r.recall < 1) console.log(`         expected ⊇ ${r.expected.join(", ")}  got: ${r.got.join(", ") || "—"}`);
      if (r.forbiddenHit > 0) console.log(`         forbidden hit ×${r.forbiddenHit}: ${r.got.filter((id) => r.forbidden.includes(id)).join(", ")}`);
    }
    console.log(`  → Recall@${report.topK}: ${(run.recallAtK * 100).toFixed(1)}%   avg MRR: ${run.avgMrr}` +
      (run.forbiddenHits > 0 ? `   forbiddenHits: ${run.forbiddenHits}` : ""));
  }
  const [legacy, fused] = report.runs;
  const lift = ((fused.recallAtK - legacy.recallAtK) * 100).toFixed(1);
  console.log(`\n三路融合 vs 旧两路: Recall@${report.topK} ${legacy.recallAtK * 100}% → ${fused.recallAtK * 100}% (${lift >= 0 ? "+" : ""}${lift}pp)`);
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "");
if (invokedDirectly) {
  const asJson = process.argv.includes("--json");
  const asFusion = process.argv.includes("--fusion");
  const report = asFusion ? await runFusionBenchmark({}) : await runBenchmark({});
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else if (asFusion) printFusionReport(report);
  else printReport(report);
}
