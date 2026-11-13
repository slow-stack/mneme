import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createDreamScheduler, parseReceipt } from "../src/dream.js";
import { applyDecisions } from "../src/dream/decisions.js";
import {
  sessionDecisions,
  arbitrationDecisions,
  mockCtx
} from "./helpers/dream-mock.js";
import { testConfig } from "./helpers/test-config.js";

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  return { store, service, dream };
}

function tmpPath(prefix) {
  return join(mkdtempSync(join(tmpdir(), prefix)), "memory.db");
}

// ---------------------------------------------------------------- 轴线 1

test("long-session stress: Recall@k stays high, stale residual drops to zero", async () => {
  const { store, service, dream } = setup();
  const ctx = mockCtx({ onConsolidation: sessionDecisions });
  const topics = 5;
  const rounds = 3;

  const gt = [];
  for (let t = 1; t <= topics; t++) {
    const title = `主题${String(t).padStart(2, "0")}`;
    const { memory } = service.saveWithDedupe({ type: "project", title, content: `${title} 规范内容`, importance: 5 });
    gt.push({ title, id: memory.id });
  }
  for (let r = 1; r <= rounds; r++) {
    for (let t = 1; t <= topics; t++) {
      service.saveWithDedupe({
        type: "project",
        title: `主题${String(t).padStart(2, "0")}·变体${r}`,
        content: "旧变体",
        importance: 3
      });
    }
    const result = await dream.runDream(ctx, service, {});
    assert.equal(result.ok, true);
  }

  let hits = 0;
  for (const { title, id } of gt) {
    if (service.search(title, { limit: 5 }).some((m) => m.id === id)) hits++;
  }
  assert.equal(hits, topics, "every canonical memory recalled in top-5 after 3 consolidation rounds");

  const all = store.all();
  const variants = all.filter((m) => m.type === "project" && m.title.includes("变体"));
  assert.equal(variants.filter((m) => !m.archived).length, 0, "no stale variants remain active");
  assert.equal(store.listDreamRuns().length, rounds, "every run written to the audit trail");
  store.close();
});

// ---------------------------------------------------------------- 轴线 2

test("arbitration set is replayable: deterministic, correct, idempotent replay", async () => {
  const { store, service, dream } = setup();
  const ctx = mockCtx({ onConsolidation: arbitrationDecisions });
  const sets = [
    { w: { type: "decision", title: "截止", content: "8月20日", importance: 5 }, l: { type: "decision", title: "截止(旧)", content: "8月15日", importance: 3 } },
    { w: { type: "preference", title: "语言", content: "简体中文", importance: 5 }, l: { type: "preference", title: "语言(旧)", content: "繁体中文", importance: 2 } }
  ];
  for (const s of sets) {
    service.saveWithDedupe({ ...s.l });
    service.saveWithDedupe({ ...s.w });
  }

  const run = await dream.runDream(ctx, service, {});
  assert.equal(run.ok, true);
  assert.equal(run.applied, sets.length, "one conflict per arbitration set");

  // correctness: winner kept (with provenance), loser archived
  for (const s of sets) {
    const winner = service.list({ type: s.w.type }).find((m) => m.title === s.w.title);
    const loser = store.all().find((m) => m.title === s.l.title);
    assert.ok(winner, "winner present");
    assert.ok(loser?.archived, "loser archived");
    assert.ok(winner.content.includes("已否决旧信息"), "provenance note appended");
  }

  // audit + receipt are replayable
  const audit = store.getDreamRun(run.runId);
  assert.equal(audit.status, "ok");
  const receipt = parseReceipt(audit.receipt);
  assert.equal(receipt.status, "ok");
  assert.equal(Object.keys(audit.outcome.byId).length, sets.length * 2, "outcome covers every arbitrated id");
  assert.equal(audit.decisions.length, sets.length, "raw decisions persisted");

  // re-applying the recorded decision list is a no-op (idempotent replay)
  assert.equal(applyDecisions(audit.decisions, service).applied, 0, "replay applies nothing");
  store.close();
});

// ---------------------------------------------------------------- 轴线 3

function bump(content) {
  return `count=${Number(content.match(/count=(\d+)/)[1]) + 1}`;
}

test("concurrent agents: no duplicate merge, lost-update reproduced then fixed, crash recovery", () => {
  const path = tmpPath("dsh-mneme-stress-test-");
  const sA = createStore(path);
  const svA = createService({ store: sA, mirror: null, config: testConfig({}) });

  // duplicate merge: 20 agents save the same title → exactly one active row
  for (let i = 0; i < 20; i++) {
    svA.saveWithDedupe({ type: "preference", title: "并发任务", content: `agent-${i}` });
  }
  assert.equal(
    svA.list({ type: "preference", limit: 100 }).filter((m) => m.title === "并发任务").length,
    1,
    "no duplicate rows after concurrent same-title saves"
  );

  // lost update: two connections read the same baseline, then both write
  const sB = createStore(path);
  const svB = createService({ store: sB, mirror: null, config: testConfig({}) });
  svA.saveWithDedupe({ type: "history", title: "计数器", content: "count=0", importance: 3 });
  const id = svA.list({ type: "history" })[0].id;

  const readA = svA.getById(id).content; // count=0
  const readB = svB.getById(id).content; // count=0 (stale)
  svA.update(id, { content: bump(readA) }); // count=1
  svB.update(id, { content: bump(readB) }); // count=1 → overwrites A's increment
  assert.equal(svB.getById(id).content, "count=1", "unlocked read-modify-write loses an increment");

  // serialized fix: re-read the latest value before writing
  svA.update(id, { content: "count=0" });
  svA.update(id, { content: bump(svA.getById(id).content) }); // reads 0 → 1
  svB.update(id, { content: bump(svB.getById(id).content) }); // reads 1 → 2
  assert.equal(svB.getById(id).content, "count=2", "re-read before write keeps both increments");

  // crash recovery: committed writes survive an exception and a reopen
  svA.saveWithDedupe({ type: "project", title: "已提交", content: "x" });
  assert.throws(() => svA.update("ghost", { content: "boom" }), /not found/, "unknown-id update throws");
  sA.close();
  sB.close();

  const sR = createStore(path);
  assert.ok(sR.getById(id), "counter survives reopen");
  assert.ok(sR.all().some((m) => m.title === "已提交"), "committed write survives reopen");
  assert.equal(sR.all().filter((m) => m.title === "已提交").length, 1, "no partial residue");
  sR.close();
});

// ---------------------------------------------------------------- CAS + atomicity (item ③)

test("CAS concurrent increments: stale version rejected, retry lands both increments", () => {
  const path = tmpPath("dsh-mneme-stress-cas-");
  const sA = createStore(path);
  const svA = createService({ store: sA, mirror: null, config: testConfig({}) });
  const sB = createStore(path);
  const svB = createService({ store: sB, mirror: null, config: testConfig({}) });

  svA.saveWithDedupe({ type: "history", title: "计数器", content: "count=0", importance: 3 });
  const id = svA.list({ type: "history" })[0].id;
  svA.update(id, { content: "count=0" });
  const baseline = svA.getById(id); // updated_at=T, count=0

  const aOk = svA.compareAndUpdate(id, baseline.updated_at, { content: bump("count=0") });
  assert.ok(aOk, "current-version CAS lands");
  const bStale = svB.compareAndUpdate(id, baseline.updated_at, { content: bump("count=0") });
  assert.equal(bStale, undefined, "stale-version CAS rejected — no lost update");

  const cur = svB.getById(id);
  svB.compareAndUpdate(id, cur.updated_at, { content: bump(cur.content) });
  assert.equal(svB.getById(id).content, "count=2", "re-read + retry keeps both increments");
  sA.close();
  sB.close();
});

test("multi-step transaction is atomic: a mid-way throw rolls back every step", () => {
  const path = tmpPath("dsh-mneme-stress-atomic-");
  const s = createStore(path);
  const sv = createService({ store: s, mirror: null, config: testConfig({}) });

  assert.throws(
    () => sv.transaction(() => {
      sv.saveWithDedupe({ type: "project", title: "原子A", content: "x" });
      sv.saveWithDedupe({ type: "project", title: "原子B", content: "y" });
      throw new Error("boom");
    }),
    /boom/
  );
  assert.ok(!s.all().some((m) => m.title === "原子A"), "atomicA fully rolled back");
  assert.ok(!s.all().some((m) => m.title === "原子B"), "atomicB fully rolled back");

  // a clean transaction commits both steps
  sv.transaction(() => {
    sv.saveWithDedupe({ type: "project", title: "完整A", content: "x" });
    sv.saveWithDedupe({ type: "project", title: "完整B", content: "y" });
  });
  assert.equal(s.all().filter((m) => m.title === "完整A").length, 1, "committed step A");
  assert.equal(s.all().filter((m) => m.title === "完整B").length, 1, "committed step B");
  s.close();
});
