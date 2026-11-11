import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createApi } from "../src/api.js";
import { createVectorIndex } from "../src/vector-index.js";
import { runSleep } from "../src/dream/sleep.js";
import { supersedeInfoFirstPair } from "../src/dream/decisions.js";
import { createDreamScheduler, parseReceipt } from "../src/dream.js";

// Issue #641（beta 第二阶段，enforce 档）：确定性处置接线。锁五件事，防的回归是：
//   ① enforce 假成功——枚举里加了档位但没人消费（#616 的教训），所以每条用例都
//     直接断言库里发生了什么（谁被归档、谁没动），而不是只看返回值；
//   ② 人审队列复活——enforce 的承诺是 conflict_pending 恒空，任何路径往队列塞行
//     都算破约；
//   ③ freeze 共存打架——#616 点名的父子绑定不允许换一种形式回来，enforce 与
//     freeze 同开必须降级 + warn，且降级后 freeze 语义完整保留；
//   ④ 信息量优先漂移——helper 的三级兜底被改掉（比如有人顺手改成「留新的」），
//     #616 实测 55-57% 的新条反而更短，留新条 = 归档掉更完整的那条；
//   ⑤ 败者向量泄漏——supersede 独立于 applyList 落地，索引清理不跟上就是
//     「检索看得见、库里已归档」的幽灵行。

const embedder = {
  embedSingle: async () => [1, 0, 0],
  embed: async () => [1, 0, 0],
  schedule: () => {},
  modelHash: "mock#1",
  dimension: 3
};

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const vectorIndex = createVectorIndex({ store });
  service.setEmbedder(embedder);
  service.setVectorIndex(vectorIndex);
  return { store, service, vectorIndex };
}

function makeMemory(service, title, content, type = "project") {
  return service.saveWithDedupe({ type, title, content, importance: 3 }).memory;
}

function baseConfig(overrides = {}) {
  return {
    sleepModeEnabled: true,
    sleepIdleMinutes: 5,
    sleepMinIntervalHours: 8,
    sleepConflictStrictness: "normal",
    sleepArchiveDays: 30,
    sleepCompressDays: 90,
    sleepPatternMinMemories: 100,
    sleepMaxPatternPerRun: 3,
    ...overrides
  };
}

function captureCtx(reply, warnings = []) {
  const seen = [];
  return {
    seen,
    warnings,
    logger: { warn: (m) => warnings.push(m), info: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "sleep-model" }) },
    llm: {
      async *stream(options) {
        seen.push(options.messages.find((m) => m.role === "system")?.content?.[0]?.text ?? "");
        yield { type: "text-delta", index: 0, text: reply };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
}

// 成对播种：A 固定 [1,0,0]，B 按 sim 取 [sim, sin, 0]——两行向量不同，余弦恰为 sim。
// 两行存同一向量的话余弦恒为 1，sim 参数就成了摆设。
function seedVectorPair(vectorIndex, memA, memB, sim = 1.0) {
  const sin = Math.sqrt(Math.max(0, 1 - sim * sim));
  vectorIndex.saveEmbedding(memA.id, [1, 0, 0]);
  vectorIndex.saveEmbedding(memB.id, [sim, sin, 0]);
}

// ---- sleep enforce：e2e ----

test("issue#641 enforce：T1 dup 走信息量优先 supersede——败者归档、胜者正文不动、队列恒空、LLM 零调用", async () => {
  const { service, store, vectorIndex } = setup();
  // 内容长短 deliberately 不等：信息量优先必须选长的那条，与 mint 顺序无关
  const long = makeMemory(service, "长条目", "这是一段明显更长的内容，用来做信息量优先的胜者侧");
  const short = makeMemory(service, "短条目", "短内容");
  seedVectorPair(vectorIndex, long, short, 1.0);
  const ctx = captureCtx("");
  const result = await runSleep(ctx, service, baseConfig({ conflictLedgerMode: "enforce" }), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.status, "ok", "T1 resolved");
  assert.deepEqual(result.phases.conflicts.enforced, { t1Resolved: 1, t1Failed: 0, t3Chained: 0 });
  assert.equal(result.phases.conflicts.ledgerTriage.dup, 1, "分诊统计随相位结果透出");
  const winner = service.getById(long.id);
  const loser = service.getById(short.id);
  assert.equal(loser.archived, true, "短的那条是败者（信息量优先，不是新者优先）");
  assert.equal(winner.archived, false);
  assert.equal(winner.content, "这是一段明显更长的内容，用来做信息量优先的胜者侧", "胜者正文一字不动（泄漏通道不存在）");
  assert.ok(loser.content.includes("已被取代"), "可追溯注记落在被归档侧");
  assert.equal(store.listConflictPending().length, 0, "enforce 的人审队列恒空");
  assert.ok(!ctx.seen.some((p) => p.includes("冲突仲裁")), "冲突相位零 LLM 调用");
  const row = store.listConflictLedger()[0];
  assert.equal(row.status, "superseded", "账本状态推进");
  assert.equal(row.tier, "dup");
  assert.ok(store.listConflictReviewed().some((r) => r.outcome === "supersede"), "机器台账照记");
  assert.ok(!vectorIndex.getEmbedding(loser.id), "败者向量已清（幽灵行不进检索）");
  store.close();
});

test("issue#641 enforce：T4 真矛盾只记账——两条都活着、零处置、零 LLM、零停车", async () => {
  const { service, store, vectorIndex } = setup();
  const a = makeMemory(service, "矛盾甲", "甲侧的记载");
  const b = makeMemory(service, "矛盾乙", "乙侧的记载");
  // sim 0.86 < dupMin 0.9，同日双录 → 真矛盾档（保守残余）
  seedVectorPair(vectorIndex, a, b, 0.86);
  const ctx = captureCtx("");
  const result = await runSleep(ctx, service, baseConfig({ conflictLedgerMode: "enforce" }), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.status, "noop", "无 T1 可处置");
  assert.deepEqual(result.phases.conflicts.enforced, { t1Resolved: 0, t1Failed: 0, t3Chained: 0 });
  assert.equal(result.phases.conflicts.ledgerTriage.conflict, 1);
  assert.equal(service.getById(a.id).archived, false, "两侧都活着");
  assert.equal(service.getById(b.id).archived, false);
  assert.equal(store.listConflictPending().length, 0);
  assert.ok(!ctx.seen.some((p) => p.includes("冲突仲裁")), "真矛盾也不送 LLM（分类已由分诊完成）");
  const row = store.listConflictLedger()[0];
  assert.equal(row.tier, "conflict");
  assert.equal(row.status, "open", "T4 保持 open，等检索时消解（后续 PR）");
  store.close();
});

test("issue#641 enforce 与 freeze 同开：freeze 让位降级 shadow + warn，冻结语义完整保留", async () => {
  const { service, store, vectorIndex } = setup();
  const a = makeMemory(service, "共存甲", "共存甲的内容");
  const b = makeMemory(service, "共存乙", "共存乙的内容");
  seedVectorPair(vectorIndex, a, b, 1.0);
  const warnings = [];
  const ctx = captureCtx("", warnings);
  const result = await runSleep(ctx, service, baseConfig({ conflictLedgerMode: "enforce", conflictFreezeEnabled: true }), ctx.logger, { embedder, vectorIndex }, null);
  assert.ok(warnings.some((m) => m.includes("degrading to shadow")), "共存必须 warn");
  assert.equal(result.phases.conflicts.frozen, 1, "freeze 语义保留：停车待审");
  assert.equal(service.getById(a.id).archived, false, "降级后无自动归档");
  assert.equal(service.getById(b.id).archived, false);
  assert.equal(store.listConflictPending().length, 1);
  assert.equal(store.listConflictLedger().length, 1, "shadow 照记账本");
  assert.equal(store.listConflictLedger()[0].status, "open");
  assert.ok(!("enforced" in result.phases.conflicts), "降级轮不报 enforce 统计");
  store.close();
});

// ---- decisions.js：supersedeInfoFirstPair 契约 ----

function rowOf(store, mem) {
  return store.getById(mem.id);
}

// ---- T3 取代链（beta 第三阶段）----

test("issue#641 enforce：T3 演进走取代链——旧行 superseded_by 指向新行，双双存活不归档", async () => {
  const { service, store, vectorIndex } = setup();
  const oldMem = makeMemory(service, "旧方案", "旧方案的内容");
  const newMem = makeMemory(service, "新方案", "新方案改用了新路径");
  // 造 30 天间隔：saveWithDedupe 不收时间，store 直改（测试专用）
  store.db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run("2026-09-01T00:00:00.000Z", oldMem.id);
  seedVectorPair(vectorIndex, oldMem, newMem, 1.0);
  const updatedBefore = service.getById(oldMem.id).updated_at;
  const ctx = captureCtx("");
  const result = await runSleep(ctx, service, baseConfig({ conflictLedgerMode: "enforce" }), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.status, "ok");
  assert.deepEqual(result.phases.conflicts.enforced, { t1Resolved: 0, t1Failed: 0, t3Chained: 1 });
  const older = service.getById(oldMem.id);
  const newer = service.getById(newMem.id);
  assert.equal(older.superseded_by, newMem.id, "旧行指向取代它的新行");
  assert.ok(older.superseded_at, "取代时刻落列");
  assert.equal(older.updated_at, updatedBefore, "纯元数据标注不 bump updated_at（「已审过」代理判定不被污染）");
  assert.equal(older.archived, false, "演进不是输赢：不归档");
  assert.equal(newer.archived, false);
  assert.ok(vectorIndex.getEmbedding(older.id), "行还活着，向量保留（降权在检索侧做）");
  assert.equal(store.listConflictPending().length, 0);
  const row = store.listConflictLedger()[0];
  assert.equal(row.status, "superseded");
  store.close();
});

test("issue#641 supersedeChain：幽灵行不落链，换指向以最后一次为准", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const a = makeMemory(service, "A", "甲");
  const b = makeMemory(service, "B", "乙");
  const c = makeMemory(service, "C", "丙");
  service.setArchived(b.id, true);
  assert.equal(service.supersedeChain(b.id, a.id), false, "已归档行不再落链（给幽灵记账没有意义）");
  assert.equal(service.supersedeChain(a.id, b.id), true);
  assert.equal(service.supersedeChain(a.id, c.id), true, "换指向以最后一次为准");
  assert.equal(store.getById(a.id).superseded_by, c.id);
  store.close();
});

test("issue#641 注入侧：被取代的行不进注入候选（继任者携带现状，旧值不值得名额）", () => {
  const { service, store } = setup();
  const oldMem = makeMemory(service, "注入旧", "注入旧的内容");
  const newMem = makeMemory(service, "注入新", "注入新的内容");
  assert.equal(service.supersedeChain(oldMem.id, newMem.id), true);
  const candidates = service.injectCandidates({ query: "", maxItems: 5 });
  const ids = candidates.map((m) => m.id);
  assert.ok(!ids.includes(oldMem.id), "被取代的行不进注入");
  assert.ok(ids.includes(newMem.id), "继任者照常注入");
  store.close();
});

test("issue#641 注入侧：矛盾对同批时 enforce 下互相标注、可信度优先排位（#537 教训落地）", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: { conflictLedgerMode: "enforce" } });
  const a = makeMemory(service, "矛盾注入甲", "矛盾注入甲的内容");
  const b = makeMemory(service, "矛盾注入乙", "矛盾注入乙的内容");
  service.saveConflictLedgerEntry({ memory_a: a.id, memory_b: b.id, tier: "conflict" });
  // 同为 subjective（默认）→ 平手退回服务器时钟新者：b 后铸，preferred = b
  const candidates = service.injectCandidates({ query: "", maxItems: 5 }).filter((m) => m.id === a.id || m.id === b.id);
  assert.equal(candidates.length, 2, "两条都在注入批里");
  assert.ok(candidates[0].id === b.id, "新者排前（时钟平手规则）");
  assert.match(candidates[0].conflictNote, /以其为准/, "preferred 的标注写明以它为准");
  assert.match(candidates[1].conflictNote, /以那条为准/, "secondary 的标注指向 preferred");
  store.close();
});

test("issue#641 注入侧：shadow 档只记账零处置——矛盾对不标注（负例）", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: { conflictLedgerMode: "shadow" } });
  const a = makeMemory(service, "影子甲", "影子甲的内容");
  const b = makeMemory(service, "影子乙", "影子乙的内容");
  service.saveConflictLedgerEntry({ memory_a: a.id, memory_b: b.id, tier: "conflict" });
  const candidates = service.injectCandidates({ query: "", maxItems: 5 }).filter((m) => m.id === a.id || m.id === b.id);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].conflictNote, undefined, "shadow 不标注——只记账零处置");
  assert.equal(candidates[1].conflictNote, undefined);
  store.close();
});

test("issue#641 GET /conflicts/ledger：token 门 + 只读面（分诊分布 + 行）", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, { add: () => {}, remove: () => {}, list: () => [] }, null, undefined, "", {});
  const route = routes.find((r) => r.path === "/api/dsh-mneme/conflicts/ledger");
  assert.ok(route, "ledger route must be registered");
  assert.equal(route.policy, "token", "账本带标题级信息，与 /conflicts 同级（gated read）");
  service.saveConflictLedgerEntry({ memory_a: "a", memory_b: "b", tier: "dup" });
  const res = { statusCode: 0, body: "", setHeader() {}, writeHead(code) { this.statusCode = code; }, end(b) { this.body = b || ""; } };
  route.handler({ method: "GET", url: "/api/dsh-mneme/conflicts/ledger?limit=10", headers: {} }, res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.total, 1);
  assert.equal(data.counts.dup, 1);
  assert.equal(data.items[0].tier, "dup");
  assert.equal(data.items[0].status, "open");
  store.close();
});

test("issue#641 检索降权：被取代的行排在其继任者之后（fuseRecall 的 T3 检索侧）", async () => {
  const { service, store } = setup();
  const oldMem = makeMemory(service, "部署方式旧", "部署方式用 systemd 托管服务");
  const newMem = makeMemory(service, "部署方式新", "部署方式已切换 systemd 托管并加了自动重启");
  assert.equal(service.supersedeChain(oldMem.id, newMem.id), true);
  const rows = await service.searchMemories("部署方式 systemd", { mode: "auto", recordRecall: false });
  const oldIdx = rows.findIndex((r) => r.id === oldMem.id);
  const newIdx = rows.findIndex((r) => r.id === newMem.id);
  assert.ok(oldIdx >= 0, "被取代的行仍可见（降权不是隐藏）");
  assert.ok(newIdx >= 0, "继任者在场");
  assert.ok(newIdx < oldIdx, "继任者必须排在被取代行之前");
  // 未落链的行不受影响：那条排序乘数只对链上的行生效
  const unrelated = makeMemory(service, "无关条目", "完全无关的部署笔记");
  const rows2 = await service.searchMemories("无关条目 部署", { mode: "auto", recordRecall: false });
  assert.ok(rows2.some((r) => r.id === unrelated.id), "未链行照常召回");
  store.close();
});

test("issue#641 supersedeInfoFirstPair：长度优先（与 mint 顺序无关）", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const a = rowOf(store, makeMemory(service, "A", "短"));
  const b = rowOf(store, makeMemory(service, "B", "长得多的内容——信息量优先胜者"));
  const res = supersedeInfoFirstPair({ a, b }, service, null, {});
  assert.equal(res.applied, true);
  assert.equal(res.winnerId, b.id, "长的那条赢，哪怕它是后 mint 的 b");
  assert.equal(store.getById(b.id).archived, false);
  assert.equal(store.getById(a.id).archived, true);
  store.close();
});

test("issue#641 supersedeInfoFirstPair：等长退 updated_at，再退 id（三级兜底，重放不翻面）", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const a = rowOf(store, makeMemory(service, "A", "等长内容"));
  const b = rowOf(store, makeMemory(service, "B", "等长内容"));
  // 单调时钟：B 晚于 A → 等长时 B 赢
  const r1 = supersedeInfoFirstPair({ a: b, b: a }, service, null, {});
  assert.equal(r1.winnerId, b.id, "等长 → 新 updated_at 赢，且与传入顺序无关");
  // updated_at 也相同 → id 大者赢（确定性，重放同判）
  const patched = {
    a: { ...a, updated_at: "2026-11-01T00:00:00.000Z", content: "等长" },
    b: { ...b, updated_at: "2026-11-01T00:00:00.000Z", content: "等长" }
  };
  const r2 = supersedeInfoFirstPair(patched, service, null, {});
  assert.equal(r2.winnerId, patched.a.id > patched.b.id ? patched.a.id : patched.b.id, "id 大者赢");
  store.close();
});

test("issue#641 supersedeInfoFirstPair：trustEpistemicWeighting 开着也不换位（自动处置承诺必须确定）", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const a = makeMemory(service, "主观长条", "主观但更完整的长内容");
  const b = makeMemory(service, "观察短条", "短");
  // 手工把 b 抬成 observation（可信度高）、a 留 subjective：若 helper 泄漏了
  // epistemic 换位，胜者会被换成 b——契约因此锁死。
  service.update(b.id, { epistemic_status: "observation" });
  const ra = rowOf(store, a);
  const rb = rowOf(store, b);
  const res = supersedeInfoFirstPair({ a: ra, b: rb }, service, null, { trustEpistemicWeighting: true });
  assert.equal(res.winnerId, ra.id, "长度判胜者，epistemic 不参与（与 sleep 自动档同一契约）");
  assert.equal(store.getById(ra.id).archived, false);
  assert.equal(store.getById(rb.id).archived, true);
  store.close();
});

// ---- dream 主链路：conflict 决策的 enforce 闸 ----

const BASE_DREAM_CONFIG = { dreamProvider: "deepseek", dreamModel: "deepseek-chat" };

function dreamCtx({ conflicts, warnings = [] }) {
  let calls = 0;
  return {
    warnings,
    llm: {
      stream: async function* () {
        calls++;
        yield { type: "text-delta", text: calls === 1 ? JSON.stringify(conflicts) : "记忆库总览摘要" };
        yield { type: "finish", reason: { kind: "ok" } };
      }
    },
    logger: { warn: (m) => warnings.push(m), info: () => {} }
  };
}

test("issue#641 dream enforce：conflict 决策只落账本——败者不归档、不停车、正文不污染", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止新", content: "8月20日", importance: 4 });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  // 无 semantic → pairSimilarity 空 → triagePair 无相似度 → 真矛盾档（同日）
  const ctx = dreamCtx({ conflicts: [{ action: "conflict", winner: w.id, loser: l.id, reason: "日期更新" }] });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { ...BASE_DREAM_CONFIG, conflictLedgerMode: "enforce" });
  assert.equal(result.ok, true);
  assert.equal(result.frozen, 0, "不停车");
  assert.equal(service.getById(l.id).archived, false, "LLM 的 winner/loser 不落地——E13b：它不可信");
  assert.ok(!service.getById(w.id).content.includes("已否决旧信息"), "胜者正文零污染（泄漏通道不存在）");
  assert.equal(store.listConflictPending().length, 0);
  const row = store.listConflictLedger()[0];
  assert.equal(row.tier, "conflict");
  assert.equal(row.status, "open");
  assert.deepEqual(JSON.parse(row.signals).annotated, false);
  store.close();
});

test("issue#641 dream enforce 与 freeze 同开：freeze 让位（conflict 照旧停车），不出现两套处置", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "截止新", content: "8月20日", importance: 4 });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "截止旧", content: "8月15日", importance: 4 });
  const warnings = [];
  const ctx = dreamCtx({ conflicts: [{ action: "conflict", winner: w.id, loser: l.id, reason: "日期更新" }], warnings });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { ...BASE_DREAM_CONFIG, conflictLedgerMode: "enforce", conflictFreezeEnabled: true });
  assert.equal(result.ok, true);
  assert.ok(warnings.some((m) => m.includes("degrading to freeze")), "共存必须 warn");
  assert.equal(result.frozen, 1, "freeze 语义保留");
  assert.equal(store.listConflictLedger().length, 0, "降级轮不写账本处置");
  store.close();
});

// ---- #650 评审必修：取代链单向门 / 幂等 / 回执口径 ----

test("issue#641 supersededIds：继任者退场后旧行恢复可见（取代链不是单向门）", () => {
  const { service, store } = setup();
  const oldMem = makeMemory(service, "旧版", "旧版的内容");
  const newMem = makeMemory(service, "新版", "新版的内容");
  assert.equal(service.supersedeChain(oldMem.id, newMem.id), true);
  assert.ok(store.supersededIds().includes(oldMem.id), "继任者活着：旧行按「已有新版本」降权");
  // 继任者被归档（人删、遗忘流程、别的相位判定退场）——链还在，但替代已经不存在。
  service.setArchived(newMem.id, true);
  assert.ok(
    !store.supersededIds().includes(oldMem.id),
    "继任者退场：旧行不该再被判为「已有新版本」，否则它明明活着却永久从注入里消失"
  );
  store.close();
});

test("issue#641 supersedeChain：同一指向重放是 no-op——不刷 superseded_at、不计变更", () => {
  const { service, store } = setup();
  const a = makeMemory(service, "A", "甲的内容");
  const b = makeMemory(service, "B", "乙的内容");
  assert.equal(service.supersedeChain(a.id, b.id), true, "首次落链");
  const firstAt = store.getById(a.id).superseded_at;
  assert.equal(service.supersedeChain(a.id, b.id), false, "同一继任者重放：没有新的变更");
  assert.equal(store.getById(a.id).superseded_at, firstAt, "取代时刻不被重放刷新（挂账时长不被抹平）");
  store.close();
});

test("issue#641 enforce：回执 applied 记真实处置数（相位与整轮同一口径）", async () => {
  const { service, store, vectorIndex } = setup();
  const long = makeMemory(service, "回执长条", "一段明显更长的内容，信息量优先胜出");
  const short = makeMemory(service, "回执短条", "短");
  seedVectorPair(vectorIndex, long, short, 1.0);
  const ctx = captureCtx("");
  const result = await runSleep(ctx, service, baseConfig({ conflictLedgerMode: "enforce" }), ctx.logger, { embedder, vectorIndex }, null);
  assert.equal(result.phases.conflicts.enforced.t1Resolved, 1);
  assert.equal(
    result.phases.conflicts.applied,
    1,
    "enforce 档真归档了一条，相位回执必须记 1（缺 applied 时下游一律读成 0）"
  );
  const parsed = parseReceipt(result.receipt);
  assert.equal(parsed.applied, 1, "整轮回执同口径——库变了就必须报变");
  store.close();
});

test("issue#641 dream enforce：T1 自动 supersede 也必须在账本留痕（dream 路径不跑分诊记账）", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const vectorIndex = createVectorIndex({ store });
  service.setEmbedder(embedder);
  service.setVectorIndex(vectorIndex);
  const { memory: w } = service.saveWithDedupe({ type: "decision", title: "同日前者", content: "这是一段明显更长的内容，信息量优先胜出", importance: 4 });
  const { memory: l } = service.saveWithDedupe({ type: "decision", title: "同日后者", content: "短", importance: 4 });
  // 同一天、相似度 1.0 → 分诊判 dup → dream 侧自动 supersede（不是 conflict 记账档）
  seedVectorPair(vectorIndex, w, l, 1.0);
  const ctx = dreamCtx({ conflicts: [{ action: "conflict", winner: w.id, loser: l.id, reason: "同一天两次录入" }] });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0, semantic: { embedder, vectorIndex } });
  const result = await dream.runDream(ctx, service, { ...BASE_DREAM_CONFIG, conflictLedgerMode: "enforce" });
  assert.equal(result.ok, true);
  const loser = service.getById(l.id);
  const winner = service.getById(w.id);
  assert.equal([loser.archived, winner.archived].filter(Boolean).length, 1, "dup 档真处置了一条（此用例的前提）");
  const row = store.listConflictLedger()[0];
  assert.ok(row, "dream 路径不写分诊账本，处置前必须自己落行——否则后面那步 UPDATE 命中 0 行静默丢弃");
  assert.equal(row.status, "superseded", "状态推进落在真实存在的行上");
  store.close();
});
