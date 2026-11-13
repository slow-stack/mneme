import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";
import { createInjector } from "../src/inject.js";
import { createSettings } from "../src/settings.js";
import { applyDecisions } from "../src/dream.js";
import { testConfig } from "./helpers/test-config.js";

// ---------------------------------------------------------------- schema / legacy compat

test("default epistemic_status is subjective (legacy-compatible)", () => {
  const store = createStore(":memory:");
  const saved = store.save({ type: "preference", title: "语言", content: "用户用中文交流" });
  assert.equal(saved.epistemic_status, "subjective", "no signal -> default subjective");
  assert.equal(store.getById(saved.id).epistemic_status, "subjective");
  store.close();
});

test("legacy DB without the column is migrated, old rows read back as subjective", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-epistemic-"));
  const dbPath = join(dir, "memory.db");
  try {
    const old = new DatabaseSync(dbPath);
    old.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]', importance INTEGER NOT NULL DEFAULT 3, forgotten INTEGER NOT NULL DEFAULT 0,
        source TEXT, embedding TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO memories (id, type, title, content, tags, importance, forgotten, created_at, updated_at)
        VALUES ('legacy', 'preference', '旧偏好', '用户以前说过', '[]', 3, 0, 't', 't');
    `);
    old.close();

    const store = createStore(dbPath);
    const cols = store.db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
    assert.ok(cols.includes("epistemic_status"), "column added by migration");
    const legacy = store.getById("legacy");
    assert.equal(legacy.title, "旧偏好", "legacy row preserved");
    assert.equal(legacy.epistemic_status, "subjective", "legacy row defaults to subjective");
    // New writes on the migrated DB still work with the column.
    const saved = store.save({ type: "preference", title: "新", content: "实测结果可用" });
    assert.equal(saved.epistemic_status, "observation");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- write inference

test("content-based inference: subjective markers -> subjective", () => {
  const store = createStore(":memory:");
  const a = store.save({ type: "preference", title: "天气", content: "我推测明天可能会下雨" });
  const b = store.save({ type: "preference", title: "口味", content: "我觉得用户喜欢甜的" });
  assert.equal(a.epistemic_status, "subjective");
  assert.equal(b.epistemic_status, "subjective");
  store.close();
});

test("content-based inference: observation markers -> observation", () => {
  const store = createStore(":memory:");
  const a = store.save({ type: "project", title: "温度", content: "实测温度为35度，数据显示稳定" });
  const b = store.save({ type: "project", title: "观察", content: "观察到用户总是先点保存" });
  assert.equal(a.epistemic_status, "observation");
  assert.equal(b.epistemic_status, "observation");
  store.close();
});

test("content-based inference: inference markers -> inferred", () => {
  const store = createStore(":memory:");
  const a = store.save({ type: "decision", title: "喜好", content: "根据历史记录推断他喜欢猫" });
  const b = store.save({ type: "decision", title: "趋势", content: "综上，结论是可推断的" });
  assert.equal(a.epistemic_status, "inferred");
  assert.equal(b.epistemic_status, "inferred");
  store.close();
});

test("AI-generated types (summary/pattern) are always inferred", () => {
  const store = createStore(":memory:");
  const s = store.save({ type: "summary", title: "总览", content: "实测数据汇总" });
  const p = store.save({ type: "pattern", title: "模式", content: "用户反复这样操作" });
  assert.equal(s.epistemic_status, "inferred");
  assert.equal(p.epistemic_status, "inferred");
  store.close();
});

test("explicit epistemic_status wins over content inference", () => {
  const store = createStore(":memory:");
  const saved = store.save({ type: "preference", title: "x", content: "我觉得可能", epistemic_status: "observation" });
  assert.equal(saved.epistemic_status, "observation", "explicit value respected");
  store.close();
});

test("update re-infers when content changes, keeps status otherwise", () => {
  const store = createStore(":memory:");
  const saved = store.save({ type: "preference", title: "x", content: "我觉得可能" });
  assert.equal(saved.epistemic_status, "subjective");
  // content unchanged -> status kept
  const untouched = store.update(saved.id, { title: "y" });
  assert.equal(untouched.epistemic_status, "subjective");
  // content changed to observation -> status re-inferred
  const reInferred = store.update(saved.id, { content: "实测结果显示没问题" });
  assert.equal(reInferred.epistemic_status, "observation");
  store.close();
});

test("update re-infers when TYPE changes to summary/pattern (regression)", () => {
  const store = createStore(":memory:");
  const saved = store.save({ type: "project", title: "x", content: "我觉得可能" });
  assert.equal(saved.epistemic_status, "subjective");
  // type -> summary: summary/pattern are always inferred, so status must flip
  const asSummary = store.update(saved.id, { type: "summary" });
  assert.equal(asSummary.epistemic_status, "inferred");
  store.close();
});

// ---------------------------------------------------------------- retrieval ranking

const embedder = {
  embedSingle: async () => [1, 0, 0],
  embed: async () => [1, 0, 0],
  schedule: () => {},
  modelHash: "mock#1",
  dimension: 3
};

test("retrieval ranking: switch off leaves scores and order untouched", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const a = service.saveWithDedupe({ type: "preference", title: "猫A", content: "我觉得猫很可爱", importance: 5 });
  const b = service.saveWithDedupe({ type: "preference", title: "猫B", content: "实测猫很可爱", importance: 3 });
  assert.equal(a.memory.epistemic_status, "subjective");
  assert.equal(b.memory.epistemic_status, "observation");

  const rows = await service.searchMemories("猫", { mode: "keyword", topK: 10 });
  assert.equal(rows[0].id, a.memory.id, "subjective first under default importance order");
  assert.equal(rows[0].score, 1.0, "subjective keeps its raw score (1.0) when off");
  assert.equal(rows[1].score, 0.8, "observation keeps its raw score (0.8) when off");
  store.close();
});

test("retrieval ranking: switch on re-weights and re-orders mixed recall", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({ trustEpistemicWeighting: true }) });
  const vi = createVectorIndex({ store });
  service.setEmbedder(embedder);
  service.setVectorIndex(vi);
  const subj = service.saveWithDedupe({ type: "preference", title: "量子计算", content: "我觉得量子计算很难", importance: 5 });
  const obs = service.saveWithDedupe({ type: "preference", title: "量子计算实践", content: "实测量子计算简单", importance: 3 });
  vi.saveEmbedding(subj.memory.id, [1, 0, 0]);
  vi.saveEmbedding(obs.memory.id, [1, 0, 0]);
  assert.equal(subj.memory.epistemic_status, "subjective");
  assert.equal(obs.memory.epistemic_status, "observation");

  // hybrid blend (default 0.6/0.4): subjective 1.0*0.6+1.0*0.4=1.0;
  // observation 1.0*0.6+0.8*0.4=0.92. After weighting: 1.0*0.7=0.7 vs 0.92*1.0=0.92.
  const rows = await service.searchMemories("量子计算", { mode: "hybrid", topK: 10 });
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get(subj.memory.id).score, 0.7, "subjective weighted to 0.7");
  assert.equal(byId.get(obs.memory.id).score, 0.92, "observation weighted to 0.92");
  assert.equal(rows[0].id, obs.memory.id, "observation outranks subjective when weighting is on");
  store.close();
});

// ---------------------------------------------------------------- injection marking

function setupInjector(over = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const settings = createSettings(store.db);
  const contexts = [];
  const ctx = {
    systemPrompt: {
      context(def) {
        contexts.push(def);
        return () => {};
      }
    }
  };
  const config = { maxInjectedItems: 3, importanceThreshold: 3, ...over };
  createInjector(ctx, service, settings, config);
  return { store, service, contexts };
}

test("injection marks observation memories [verified] only when enabled", () => {
  const { service, contexts } = setupInjector({ trustEpistemicWeighting: true });
  service.saveWithDedupe({ type: "preference", title: "偏好实测", content: "实测用户喜欢用命令行", importance: 5 });
  service.saveWithDedupe({ type: "preference", title: "偏好推测", content: "我觉得用户可能喜欢GUI", importance: 5 });
  const text = contexts[0].text({});
  assert.ok(text.includes("[verified] 偏好实测"), "observation memory is flagged");
  assert.ok(!text.includes("[verified] 偏好推测"), "subjective memory is not flagged");
});

test("injection never adds [verified] when the switch is off", () => {
  const { service, contexts } = setupInjector({});
  service.saveWithDedupe({ type: "preference", title: "偏好实测", content: "实测用户喜欢用命令行", importance: 5 });
  const text = contexts[0].text({});
  assert.ok(text.includes("偏好实测"), "memory still injected");
  assert.ok(!text.includes("[verified]"), "no verified marker when off");
});

// ---------------------------------------------------------------- decision priority

test("merge keepSource prefers observation when enabled", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const config = { trustEpistemicWeighting: true };
  const a = service.saveWithDedupe({ type: "project", title: "插件甲", content: "我觉得应该用A方案", importance: 3 });
  const b = service.saveWithDedupe({ type: "project", title: "插件乙", content: "实测结果显示B方案更好", importance: 4 });
  assert.equal(a.memory.epistemic_status, "subjective");
  assert.equal(b.memory.epistemic_status, "observation");

  const { committed } = applyDecisions(
    [{ action: "merge", ids: [a.memory.id, b.memory.id], title: "插件总览", content: "合并", keepSource: a.memory.id }],
    service, null, null, config
  );
  assert.equal(committed[0].keepSource, b.memory.id, "keepSource switched to the observation memory");
  assert.equal(store.getById(b.memory.id).archived, false, "observation keeper stays live");
  assert.equal(store.getById(a.memory.id).archived, true, "subjective source archived");
});

test("merge keepSource keeps the LLM choice when disabled", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const a = service.saveWithDedupe({ type: "project", title: "插件甲", content: "我觉得应该用A方案", importance: 3 });
  const b = service.saveWithDedupe({ type: "project", title: "插件乙", content: "实测结果显示B方案更好", importance: 4 });
  const { committed } = applyDecisions(
    [{ action: "merge", ids: [a.memory.id, b.memory.id], title: "插件总览", content: "合并", keepSource: a.memory.id }],
    service
  );
  assert.equal(committed[0].keepSource, a.memory.id, "LLM keepSource respected when off");
  assert.equal(store.getById(a.memory.id).archived, false);
  assert.equal(store.getById(b.memory.id).archived, true);
});

test("merge never promotes an ARCHIVED observation to keeper when enabled (regression)", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const config = { trustEpistemicWeighting: true };
  // a = live subjective (LLM's keepSource), b = live observation,
  // c = ARCHIVED observation. Pre-fix pickBestKeeper would pick c (highest
  // priority, no archived check) as keeper, hit the archived-keeper guard in
  // applyMerge and silently drop the merge — the live b never merges.
  const a = service.saveWithDedupe({ type: "project", title: "甲", content: "我觉得A方案", importance: 3 });
  const b = service.saveWithDedupe({ type: "project", title: "乙", content: "实测B方案更好", importance: 4 });
  const c = service.saveWithDedupe({ type: "project", title: "丙", content: "实测C方案最好", importance: 4 });
  service.setArchived(c.memory.id, true);

  const { committed } = applyDecisions(
    [{ action: "merge", ids: [a.memory.id, b.memory.id, c.memory.id], title: "合并", content: "合并", keepSource: a.memory.id }],
    service, null, null, config
  );
  // c (archived) must NOT be promoted; the live observation b becomes keeper,
  // and the merge actually lands.
  assert.equal(committed.length, 1, "merge actually committed (not silently skipped)");
  assert.equal(committed[0].keepSource, b.memory.id, "live observation promoted over archived one");
  assert.equal(store.getById(b.memory.id).archived, false, "observation keeper stays live");
  assert.equal(store.getById(a.memory.id).archived, true, "subjective source archived");
  assert.equal(store.getById(c.memory.id).archived, true, "archived c stays archived");
});

test("conflict resolution prefers the observation side as winner when enabled", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const config = { trustEpistemicWeighting: true };
  const w = service.saveWithDedupe({ type: "decision", title: "截止1", content: "我觉得截止是8月20日", importance: 4 });
  const l = service.saveWithDedupe({ type: "decision", title: "截止2", content: "实测截止是8月15日", importance: 4 });
  assert.equal(w.memory.epistemic_status, "subjective");
  assert.equal(l.memory.epistemic_status, "observation");

  const { committed } = applyDecisions(
    [{ action: "conflict", winner: w.memory.id, loser: l.memory.id, reason: "日期更新" }],
    service, null, null, config
  );
  assert.equal(committed[0].winner, l.memory.id, "winner swapped to the observation memory");
  assert.equal(store.getById(l.memory.id).archived, false, "observation winner stays live");
  assert.equal(store.getById(w.memory.id).archived, true, "subjective loser archived");
});

test("conflict resolution keeps the LLM winner when disabled", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const w = service.saveWithDedupe({ type: "decision", title: "截止1", content: "我觉得截止是8月20日", importance: 4 });
  const l = service.saveWithDedupe({ type: "decision", title: "截止2", content: "实测截止是8月15日", importance: 4 });
  const { committed } = applyDecisions(
    [{ action: "conflict", winner: w.memory.id, loser: l.memory.id, reason: "日期更新" }],
    service
  );
  assert.equal(committed[0].winner, w.memory.id, "LLM winner respected when off");
  assert.equal(store.getById(w.memory.id).archived, false);
  assert.equal(store.getById(l.memory.id).archived, true);
});

// E2 四臂实验(Kaggle v11)当场抓到的回归:saveWithDedupe 此前丢弃显式
// epistemic_status,store 回退内容推断,英文/无标记内容一律 subjective——
// EPISTEMIC_WEIGHTS 对整池均匀 ×0.7,trustEpistemicWeighting 的重排整体空转
// (R+ 臂与 A 臂注入序逐条相同)。显式值必须穿透创建路径;undefined 保持推断。
test("saveWithDedupe forwards explicit epistemic_status (rerank needs non-uniform weights)", async () => {
  const store = createStore(":memory:");
  const builder = createService({ store, mirror: null, config: testConfig({}) });
  const bait = builder.saveWithDedupe({ type: "preference", title: "m#0", content: "User feels that daily stand-up meetings are micromanagement theater", importance: 3, epistemic_status: "subjective" });
  const fact = builder.saveWithDedupe({ type: "preference", title: "m#1", content: "User is a Lead Software Engineer with 15 years of experience", importance: 3, epistemic_status: "observation" });
  assert.equal(store.getById(bait.memory.id).epistemic_status, "subjective", "explicit subjective stored");
  assert.equal(store.getById(fact.memory.id).epistemic_status, "observation", "explicit field must survive saveWithDedupe (English content, inference cannot classify)");

  const plain = createService({ store, mirror: null, config: testConfig({ signalTransparency: true }) });
  const weighted = createService({ store, mirror: null, config: testConfig({ signalTransparency: true, trustEpistemicWeighting: true }) });
  for (const s of [plain, weighted]) s.setVectorIndex(createVectorIndex({ store }));
  const opts = { mode: "auto", topK: 5, useRerank: false };
  const pRows = await plain.searchMemories("software engineer", opts);
  const wRows = await weighted.searchMemories("software engineer", opts);
  const pScore = Object.fromEntries(pRows.map((r) => [r.id, r.signals?.final]));
  const wScore = Object.fromEntries(wRows.map((r) => [r.id, r.signals?.final]));
  assert.ok(pScore[fact.memory.id] > 0, "observation entry is a candidate");
  assert.ok(
    Math.abs(wScore[fact.memory.id] - pScore[fact.memory.id]) < 1e-9,
    "observation keeps weight 1.0 — if scaled, the explicit field was dropped (all rows uniform subjective)"
  );
});
