import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createMirror } from "../src/mirror.js";

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  return { store, service };
}

test("saveWithDedupe adds new memory when no similar exists", () => {
  const { store, service } = setup();
  const result = service.saveWithDedupe({
    type: "project",
    title: "记忆插件",
    content: "正在开发 dsh-mneme，SQLite+Markdown",
    importance: 4
  });
  assert.equal(result.action, "created");
  assert.equal(store.count(), 1);
});

test("saveWithDedupe merges into existing on exact title match", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ type: "project", title: "记忆插件", content: "旧内容", importance: 3 });
  const result = service.saveWithDedupe({ type: "project", title: "记忆插件", content: "新内容", importance: 5 });
  assert.equal(result.action, "merged");
  assert.equal(store.count(), 1);
  const all = store.all();
  // Bug5: same-title merge appends under a timestamped `---` separator instead
  // of overwriting; the previous content is archived into content_history.
  assert.ok(all[0].content.includes("旧内容"), "old content preserved in appended body");
  assert.ok(all[0].content.includes("新内容"), "new content appended");
  assert.ok(all[0].content.includes("---"), "timestamped separator present");
  assert.equal(all[0].importance, 5, "importance takes the max of both");
  assert.equal(all[0].content_history.length, 1, "old content archived to history");
  assert.equal(all[0].content_history[0].content, "旧内容");
  assert.equal(all[0].content_history[0].source, "auto_merge");
});

test("injectCandidates returns preferences + high-importance items within limit", () => {
  const { service } = setup();
  for (let i = 0; i < 3; i++) service.saveWithDedupe({ type: "preference", title: `p${i}`, content: "偏好" });
  service.saveWithDedupe({ type: "project", title: "low", content: "低", importance: 2 });
  service.saveWithDedupe({ type: "project", title: "high", content: "高", importance: 5 });
  service.saveWithDedupe({ type: "history", title: "h", content: "历史", importance: 5 });
  const candidates = service.injectCandidates({ maxItems: 5, threshold: 4 });
  const types = candidates.map((c) => c.type);
  assert.ok(types.includes("preference"), "preferences included");
  assert.ok(types.includes("project"), "high-importance project included");
  // #369：history 曾被注入白名单挡在门外，现按「注入侧收编」进池（理由与实测数字
  // 见 src/service.js 的 INJECT_TYPES 注释）。这里从「锁排除」改成「锁收编」——
  // 白名单日后若被收窄，这条会红，而不是静默把两成条目关回不可注入。
  assert.ok(types.includes("history"), "history included since #369");
  assert.ok(candidates.length <= 5, "respects maxItems");
});

test("mergeHumanEdits applies human content over machine", () => {
  const { store, service } = setup();
  const saved = service.saveWithDedupe({ type: "preference", title: "语言", content: "机器内容" });
  const edits = [{ id: saved.memory.id, title: "语言", content: "人类编辑内容" }];
  service.mergeHumanEdits("preference", edits);
  const got = store.getById(saved.memory.id);
  assert.equal(got.content, "人类编辑内容");
});

test("toApiList maps store rows to wire DTOs", () => {
  const { service } = setup();
  const saved = service.saveWithDedupe({ type: "decision", title: "选型", content: "node:sqlite", importance: 3 });
  const dto = service.toApiList([saved.memory]);
  assert.deepEqual(Object.keys(dto[0]).sort(), ["id", "type", "title", "content", "tags", "importance", "source", "created_at", "updated_at"].sort());
  assert.equal(dto[0].id, saved.memory.id);
  assert.equal(dto[0].type, "decision");
  assert.equal(dto[0].title, "选型");
  assert.equal(dto[0].content, "node:sqlite");
  assert.equal(dto[0].importance, 3);
});

test("mergeHumanEdits skips edits without id and keeps applying the rest", () => {
  const { store, service } = setup();
  const first = service.saveWithDedupe({ type: "preference", title: "语言", content: "机器内容" });
  const second = service.saveWithDedupe({ type: "preference", title: "主题", content: "机器内容" });
  const edits = [
    { content: "缺少 id 的损坏条目" },
    { id: first.memory.id, title: "语言", content: "人类编辑内容" },
    { id: second.memory.id, title: "主题", content: "第二个人类编辑" }
  ];
  const applied = service.mergeHumanEdits("preference", edits);
  assert.equal(applied, 2, "returns count of applied edits, not input length");
  assert.equal(store.getById(first.memory.id).content, "人类编辑内容");
  assert.equal(store.getById(second.memory.id).content, "第二个人类编辑");
});

test("mutations through passthroughs sync mirror; forgotten entries stay out of it", () => {
  const store = createStore(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-service-"));
  const mirror = createMirror(dir);
  const service = createService({ store, mirror, config: {} });
  try {
    const saved = service.saveWithDedupe({ type: "project", title: "A", content: "a", importance: 4 });
    assert.ok(existsSync(join(dir, "projects.md")), "mirror written on save");

    service.update(saved.memory.id, { content: "a2" });
    assert.match(readFileSync(join(dir, "projects.md"), "utf8"), /a2/, "update re-syncs mirror");

    service.setForget(saved.memory.id, true);
    assert.ok(!existsSync(join(dir, "projects.md")), "forgotten entry removed from mirror");

    const second = service.saveWithDedupe({ type: "project", title: "B", content: "b", importance: 2 });
    assert.ok(existsSync(join(dir, "projects.md")), "mirror rewritten after re-save");
    service.remove(second.memory.id);
    assert.ok(!existsSync(join(dir, "projects.md")), "remove re-syncs mirror");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveWithDedupe created branch keeps forgotten entries out of mirror", () => {
  const store = createStore(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-service-"));
  const mirror = createMirror(dir);
  const service = createService({ store, mirror, config: {} });
  try {
    const a = service.saveWithDedupe({ type: "project", title: "A", content: "a", importance: 4 });
    service.setForget(a.memory.id, true);
    service.saveWithDedupe({ type: "project", title: "B", content: "b", importance: 2 });
    const text = readFileSync(join(dir, "projects.md"), "utf8");
    assert.ok(!text.includes(a.memory.id), "forgotten A must not reappear in mirror");
    assert.ok(!text.includes("## A"), "forgotten A entry absent from mirror");
    assert.match(text, /## B/, "non-forgotten B present in mirror");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("injectCandidates excludes archived entries", () => {
  const { store, service } = setup();
  const saved = service.saveWithDedupe({ type: "preference", title: "旧偏好", content: "old", importance: 5 });
  store.setArchived(saved.memory.id, true);
  const candidates = service.injectCandidates({ maxItems: 5, threshold: 3 });
  assert.ok(!candidates.some((c) => c.id === saved.memory.id), "archived excluded");
});

test("summary memory is a candidate at top priority", () => {
  const { service } = setup();
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文", importance: 5 });
  service.saveWithDedupe({ type: "summary", title: "记忆库总览", content: "总览内容", importance: 5 });
  const candidates = service.injectCandidates({ maxItems: 5, threshold: 3 });
  assert.equal(candidates[0]?.type, "summary", "summary first even with competing high-importance preference");
});

test("write methods invoke onWrite hook when provided", () => {
  const { store } = setup();
  let called = 0;
  const svc = createService({ store, mirror: null, config: {}, onWrite: () => { called++; } });
  svc.saveWithDedupe({ type: "project", title: "a", content: "x" });
  assert.equal(called, 1, "saveWithDedupe hooks");
  svc.update(svc.all()[0].id, { content: "y" });
  assert.equal(called, 2, "update hooks");
  svc.setArchived(svc.all()[0].id, true);
  assert.equal(called, 2, "setArchived does not hook (not a content write)");
});

// --- transactions (item ②) + compare-and-set (item ①/③) --------------------

test("service.transaction rolls back every step when the body throws", () => {
  const { store, service } = setup();
  let threw = false;
  try {
    service.transaction(() => {
      service.saveWithDedupe({ type: "project", title: "原子A", content: "x" });
      service.saveWithDedupe({ type: "project", title: "原子B", content: "y" });
      throw new Error("boom");
    });
  } catch { threw = true; }
  assert.equal(threw, true, "error propagates");
  assert.equal(store.count(), 0, "no partial writes after rollback");
  assert.ok(!store.all().some((m) => m.title === "原子A"), "step A rolled back");
  assert.ok(!store.all().some((m) => m.title === "原子B"), "step B rolled back");
  store.close();
});

test("service.transaction commits all steps atomically on success", () => {
  const { store, service } = setup();
  service.transaction(() => {
    service.saveWithDedupe({ type: "project", title: "甲", content: "x" });
    service.saveWithDedupe({ type: "project", title: "乙", content: "y" });
  });
  assert.equal(store.count(), 2, "both steps committed");
  store.close();
});

test("service.compareAndUpdate rejects a stale version token (no lost update)", () => {
  const { store, service } = setup();
  const { memory: m } = service.saveWithDedupe({ type: "history", title: "计数器", content: "count=0" });
  const baseline = service.getById(m.id);
  const first = service.compareAndUpdate(m.id, baseline.updated_at, { content: "count=1" });
  assert.ok(first, "current version CAS succeeds");
  const stale = service.compareAndUpdate(m.id, baseline.updated_at, { content: "count=2" });
  assert.equal(stale, undefined, "stale version CAS misses without writing");
  assert.equal(service.getById(m.id).content, "count=1", "increment not lost");
  store.close();
});

// --- Bug4: injectCandidates semantic-first recall (query) --------------------

test("Bug4: injectCandidates with an empty query keeps the legacy rule-based selection", () => {
  const { service } = setup();
  service.saveWithDedupe({ type: "preference", title: "p0", content: "偏好" });
  service.saveWithDedupe({ type: "preference", title: "p1", content: "偏好" });
  service.saveWithDedupe({ type: "project", title: "low", content: "低", importance: 2 });
  service.saveWithDedupe({ type: "project", title: "high", content: "高", importance: 5 });
  service.saveWithDedupe({ type: "history", title: "h", content: "历史", importance: 5 });
  service.saveWithDedupe({ type: "summary", title: "记忆库总览", content: "总览", importance: 5 });
  const legacy = service.injectCandidates({ maxItems: 5, threshold: 4 });
  const noQuery = service.injectCandidates({ maxItems: 5, threshold: 4, query: "" });
  const blankQuery = service.injectCandidates({ maxItems: 5, threshold: 4, query: "   " });
  assert.deepEqual(noQuery.map((c) => c.id), legacy.map((c) => c.id), "empty query behaves identically to the old logic");
  assert.deepEqual(blankQuery.map((c) => c.id), legacy.map((c) => c.id), "whitespace-only query degrades too");
  assert.equal(legacy[0].type, "summary", "summary still leads");
  // #369 收编后 history 可进池；本用例的重心是「空查询与旧规则路逐字节同序」，
  // 这条只确认收编没有撼动优先级分层——summary 仍打头。
  assert.ok(legacy.some((c) => c.type === "history"), "history included since #369");
});

test("Bug4: injectCandidates ignores the query when hybridInject is disabled", () => {
  const { store } = setup();
  const svc = createService({ store, mirror: null, config: { hybridInject: false } });
  svc.saveWithDedupe({ type: "preference", title: "p0", content: "偏好" });
  svc.saveWithDedupe({ type: "summary", title: "记忆库总览", content: "总览", importance: 5 });
  const noQuery = svc.injectCandidates({ maxItems: 5, threshold: 3 });
  const withQuery = svc.injectCandidates({ maxItems: 5, threshold: 3, query: "中文" });
  assert.deepEqual(withQuery.map((c) => c.id), noQuery.map((c) => c.id), "hybridInject off keeps rule-based ordering");
});

// --- Bug5: content_history FIFO + human-edited direct overwrite --------------

test("Bug5: content_history grows FIFO across repeated same-title merges (capped at 20)", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ type: "project", title: "流水", content: "v0" });
  for (let i = 1; i <= 25; i++) {
    service.saveWithDedupe({ type: "project", title: "流水", content: `v${i}` });
  }
  const row = store.all()[0];
  assert.ok(Array.isArray(row.content_history), "content_history is an array");
  assert.equal(row.content_history.length, 20, "FIFO cap of 20 respected");
  assert.ok(row.content_history[0].content.includes("v24"), "newest archived body kept at index 0");
  assert.ok(row.content_history[19].content.includes("v5"), "oldest kept entry");
  assert.ok(!row.content_history[19].content.includes("v6"), "entries older than the cap dropped");
  assert.ok(row.content.includes("v25"), "latest merge still appended to the live body");
});

test("Bug5: _humanEdited overwrite replaces content directly and archives the old version", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "语言", content: "机器内容" });
  const result = service.saveWithDedupe({ type: "preference", title: "语言", content: "人工修正", _humanEdited: true });
  const row = store.getById(result.memory.id);
  assert.equal(row.content, "人工修正", "direct overwrite, no appended --- block");
  assert.ok(!row.content.includes("机器内容"), "old content not in the live body");
  assert.equal(row.content_history.length, 1);
  assert.equal(row.content_history[0].content, "机器内容");
  assert.equal(row.content_history[0].source, "human_override");
});

// --- Bug7: memory quality filter ---------------------------------------------

function qualitySetup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: { memoryQualityFilter: { enabled: true, ...config } } });
  return { store, service };
}

test("Bug7: meta-memory is scored below the degrade threshold but still stored", () => {
  const { store, service } = qualitySetup();
  const result = service.saveWithDedupe({ type: "project", title: "记忆系统规则", content: "我需要记住用户喜欢中文阅读长篇小说和散文" });
  assert.equal(result.action, "created");
  assert.ok(result.memory.quality_score < 60, `meta-memory degraded, got ${result.memory.quality_score}`);
  assert.ok(result.memory.quality_score >= 30, "still above the archive threshold");
  assert.equal(result.memory.archived, false, "not archived");
  assert.equal(store.count(), 1, "still stored and searchable");
});

test("Bug7: short content is archived and tagged low_quality", () => {
  const { store, service } = qualitySetup();
  const result = service.saveWithDedupe({ type: "project", title: "备忘", content: "x" });
  const row = store.getById(result.memory.id);
  assert.equal(row.archived, true, "short content archived");
  assert.ok(row.tags.includes("low_quality"), "low_quality tag added");
  assert.ok(row.quality_score < 30, `score below archive threshold: ${row.quality_score}`);
});

test("Bug7: near-duplicate content is archived and tagged low_quality", () => {
  const { store, service } = qualitySetup();
  const base = "今天下午去操场跑步三圈然后回来洗澡";
  service.saveWithDedupe({ type: "history", title: "记录A", content: base });
  const result = service.saveWithDedupe({ type: "history", title: "记录B", content: `${base}${base}${base}` });
  const row = store.getById(result.memory.id);
  assert.equal(row.archived, true, "near-duplicate archived");
  assert.ok(row.tags.includes("low_quality"), "low_quality tag added");
  assert.ok(row.quality_score < 30, `score below archive threshold: ${row.quality_score}`);
});

test("Bug7: repetitive (trigram > 0.7) content is scored into the degraded band", () => {
  const { store, service } = qualitySetup();
  const result = service.saveWithDedupe({ type: "history", title: "唠叨", content: "好好好好好好好好好好好好好好好好好好" });
  const row = store.getById(result.memory.id);
  assert.ok(row.quality_score >= 30 && row.quality_score < 60, `repetitive-only degraded, got ${row.quality_score}`);
  assert.equal(row.archived, false, "not archived (only a single non-meta signal)");
});

test("Bug7: memoryQualityFilter.enabled=false skips scoring entirely", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: { memoryQualityFilter: { enabled: false } } });
  const result = service.saveWithDedupe({ type: "project", title: "记忆系统规则", content: "我需要记住用户喜欢中文阅读长篇小说和散文" });
  const row = store.getById(result.memory.id);
  assert.ok(row.quality_score == null, "no quality_score written");
  assert.equal(row.archived, false, "not archived");
  assert.ok(!(row.tags ?? []).includes("low_quality"), "no low_quality tag");
});

test("Bug7: injection ranking re-weights by quality_score (degraded memories rank lower)", () => {
  const { store } = setup();
  const svc = createService({ store, mirror: null, config: { memoryQualityFilter: { enabled: true } } });
  svc.saveWithDedupe({ type: "preference", title: "高质量", content: "用户喜欢读科幻小说和散文" });
  svc.saveWithDedupe({ type: "preference", title: "元记忆", content: "我需要记住用户偏好的完整清单防止忘记" });
  const candidates = svc.injectCandidates({ maxItems: 5, threshold: 3 });
  assert.equal(candidates[0].title, "高质量", "100-quality preference leads the degraded one");
  assert.equal(candidates[1].title, "元记忆");
});

// v0.8.0 冲突集中处理：resolveConflictPending 盖章 + 处置落地（与 dream 非冻结
// conflict 同款：胜者正文追加已否决注记、败者归档），以及队列视图的联表形状。
test("resolveConflictPending applies the dream-style disposition on human confirmation", () => {
  const { store, service } = setup();
  const a = store.save({ type: "history", title: "界面暗色偏好", content: "用户当前使用暗色界面主题", importance: 3 });
  const b = store.save({ type: "history", title: "界面亮色切换", content: "用户界面亮色切换计划", importance: 3 });
  const pending = store.saveConflictPending({ memory_a: a.id, memory_b: b.id, reason: "主题偏好前后矛盾" });
  // store 会把 pair 按 id 字典序归一（防重复入队），A/B 只是排序位——
  // 人工确认前先从队列行反查「界面亮色切换」（keeper，恒为 b）落在哪一侧，
  // 再选那一侧保留；loser 恒为 a（「界面暗色偏好」），与侧位字母无关。
  const queued = service.listConflictQueue().find((q) => q.id === pending.id);
  const winnerSide = queued.memory_a.id === b.id ? "a" : "b";
  const loserId = a.id;

  const resolved = service.resolveConflictPending(pending.id, { winner: winnerSide, apply: true });
  assert.ok(resolved, "returns the stamped row");
  assert.ok(resolved.resolved_at, "stamps resolved_at");
  assert.equal(resolved.resolved_winner, b.id, "resolved_winner records the chosen memory id");
  assert.equal(resolved.disposition?.ok, true, "disposition landed");

  // 败者归档 + 胜者保留——与 dream applyConflict 同款（胜者正文由
  // applyDecisions 追加已否决注记）。
  assert.equal(store.getById(loserId).archived, true, "loser archived");
  assert.equal(store.getById(b.id).archived, false, "winner kept active");
  assert.notEqual(store.getById(b.id).content, b.content, "winner content carries the veto note");
  // 处置后队列不再返回该冲突。
  assert.equal(service.listConflictQueue().length, 0);
});

test("resolveConflictPending with winner=null only stamps (mark reviewed)", () => {
  const { store, service } = setup();
  const a = store.save({ type: "project", title: "甲", content: "内容甲" });
  const b = store.save({ type: "project", title: "乙", content: "内容乙" });
  const pending = store.saveConflictPending({ memory_a: a.id, memory_b: b.id, reason: "r" });
  const resolved = service.resolveConflictPending(pending.id, { winner: null });
  assert.ok(resolved.resolved_at);
  assert.equal(resolved.disposition, null, "no disposition applied");
  assert.equal(store.getById(a.id).archived, false);
  assert.equal(store.getById(b.id).archived, false);
});

test("resolveConflictPending unknown id returns undefined", () => {
  const { service } = setup();
  assert.equal(service.resolveConflictPending("nope", { winner: "a" }), undefined);
});

// Review 守卫（#166 时序修复）：盖章必须先于处置的**反面**契约——处置失败时
// 不得盖章。单线程下 casGuard 的 snapshot 与读取之间没有异步介入点，CAS 冲突
// 实际不可达（这是原 PR 没测它的原因），但它一旦因未来改动可达（异步 store、
// update/archive 抛错），先盖章会让行已 resolved、从队列消失却未处置。这条源码
// 断言把顺序固化下来（与 client.test.js 断言 ConflictsQueue 存在同一惯例），
// 防止未来有人再把盖章挪回处置之前。
test("resolveConflictPending stamps only after disposition succeeds (review ordering guard)", () => {
  const source = readFileSync(new URL("../src/service.js", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("function resolveConflictPending"));
  const applyAt = fn.indexOf("applyDecisions(");
  const stampAt = fn.indexOf("store.resolveConflictPending(");
  assert.ok(applyAt !== -1, "resolveConflictPending must call applyDecisions");
  assert.ok(stampAt !== -1, "resolveConflictPending must call store.resolveConflictPending");
  assert.ok(stampAt > applyAt, "stamp must happen after applyDecisions — a failed disposition must not mark the conflict resolved");
  assert.ok(fn.includes("if (failures.length)"), "apply failures must short-circuit before stamping");
});

test("listConflictQueue joins both sides and tolerates missing memories", () => {
  const { store, service } = setup();
  const a = store.save({ type: "decision", title: "现存方", content: "现存内容", importance: 4 });
  const pending = store.saveConflictPending({ memory_a: a.id, memory_b: "ghost-id", reason: "对方已被删除" });
  const queue = service.listConflictQueue();
  assert.equal(queue.length, 1);
  assert.equal(queue[0].id, pending.id);
  assert.equal(queue[0].memory_a?.title, "现存方", "side A joined from the store");
  assert.equal(queue[0].memory_a?.archived, false);
  assert.equal(queue[0].memory_b?.missing, true, "ghost side marked missing");
  assert.equal(queue[0].reason, "对方已被删除");
});
