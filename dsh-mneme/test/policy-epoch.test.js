import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "../src/config.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createDreamScheduler, parseReceipt } from "../src/dream.js";

// ---------------------------------------------------------------- helpers

function openMemory() {
  return createStore(":memory:");
}

// Minimal valid dream_runs row for store-level tests.
function run(id, policyEpoch, createdAt) {
  const r = {
    id,
    created_at: createdAt,
    status: "ok",
    snapshot_hash: `hash-${id}`,
    input_count: 1,
    decisions: [{ action: "keep", ids: ["x"] }],
    outcome: { byId: { x: "keep" } },
    applied: 0,
    summary_stored: false,
    receipt: `dsh-mneme:run:${id}:ok:${`hash-${id}`.slice(0, 12)}:1:0:0`
  };
  if (policyEpoch !== undefined) r.policy_epoch = policyEpoch;
  return r;
}

/**
 * Minimal DSH-like ctx whose LLM distinguishes the two dream calls by the user
 * prompt shape: consolidation prompts start with "id=…", summary prompts with
 * "- title: content". Mirrors audit.test.js.
 */
function mockCtx({ onConsolidation, summaryText = "记忆库总览：用户偏好中文。" } = {}) {
  return {
    logger: { warn: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock-model" }) },
    llm: {
      async *stream(options) {
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        if (userText.includes("| type=")) {
          yield { type: "block-start", index: 0, blockType: "text" };
          yield { type: "text-delta", index: 0, text: onConsolidation ? onConsolidation(userText, options.purpose) : "[]" };
          yield { type: "block-end", index: 0, block: { type: "text" } };
          yield { type: "finish", reason: { kind: "stop" } };
          return;
        }
        if (typeof summaryText === "string") {
          yield { type: "text-delta", index: 0, text: summaryText };
          yield { type: "finish", reason: { kind: "stop" } };
        } else {
          throw summaryText instanceof Error ? summaryText : new Error(String(summaryText));
        }
      }
    }
  };
}

// ---------------------------------------------------------------- config

test("policyEpoch defaults to 0 when config omits it", () => {
  const cfg = Config({});
  assert.equal(cfg.policyEpoch, 0);
});

test("policyEpoch accepts in-range integers including both boundaries", () => {
  assert.equal(Config({ policyEpoch: 42 }).policyEpoch, 42, "mid-range accepted");
  assert.equal(Config({ policyEpoch: 0 }).policyEpoch, 0, "min boundary accepted");
  assert.equal(Config({ policyEpoch: 1000000 }).policyEpoch, 1000000, "max boundary accepted");
});

test("policyEpoch rejects out-of-range / non-integer / wrong-type values", () => {
  assert.throws(() => Config({ policyEpoch: -1 }), /expected number >= 0/, "below min rejected");
  assert.throws(() => Config({ policyEpoch: 1000001 }), /expected number <= 1000000/, "above max rejected");
  assert.throws(() => Config({ policyEpoch: 1.5 }), /expected number multiple of 1/, "non-integer rejected");
  assert.throws(() => Config({ policyEpoch: "5" }), /expected number/, "string type rejected");
});

// ---------------------------------------------------------------- store

test("saveDreamRun stores policy_epoch and getDreamRun reads it back", () => {
  const store = openMemory();
  const saved = store.saveDreamRun(run("r-epoch-7", 7));
  assert.equal(saved.policy_epoch, 7, "write path returns epoch");
  assert.equal(store.getDreamRun("r-epoch-7").policy_epoch, 7, "read path returns epoch");
  store.close();
});

test("saveDreamRun without policy_epoch defaults to 0", () => {
  const store = openMemory();
  const saved = store.saveDreamRun(run("r-no-epoch"));
  assert.equal(saved.policy_epoch, 0);
  assert.equal(store.getDreamRun("r-no-epoch").policy_epoch, 0);
  store.close();
});

test("saveDreamRun falls back to 0 for non-integer policy_epoch", () => {
  const store = openMemory();
  for (const bad of [1.5, undefined, "7", null]) {
    store.saveDreamRun(run(`r-bad-${String(bad)}`, bad));
    assert.equal(store.getDreamRun(`r-bad-${String(bad)}`).policy_epoch, 0, `policy_epoch=${String(bad)} coerced to 0`);
  }
  store.close();
});

test("migration: legacy dream_runs without policy_epoch column gets it backfilled to 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-epoch-migrate-"));
  const dbPath = join(dir, "legacy.db");
  try {
    // Legacy dream_runs DDL (pre-policy_epoch) + one existing row.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE dream_runs (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
      provider TEXT, model TEXT, snapshot_hash TEXT NOT NULL, input_count INTEGER NOT NULL,
      input TEXT, decisions TEXT, outcome TEXT, applied INTEGER NOT NULL DEFAULT 0,
      summary_stored INTEGER NOT NULL DEFAULT 0, receipt TEXT NOT NULL
    );`);
    legacy.exec(`CREATE INDEX idx_dream_runs_created ON dream_runs(created_at);`);
    legacy.prepare(
      `INSERT INTO dream_runs (id, created_at, status, snapshot_hash, input_count, receipt)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("legacy-run", "2026-08-01T00:00:00.000Z", "ok", "h", 1, "dsh-mneme:run:legacy-run:ok:h:1:0:0");
    legacy.close();

    const store = createStore(dbPath);
    const cols = store.db.prepare("PRAGMA table_info(dream_runs)").all().map((c) => c.name);
    assert.ok(cols.includes("policy_epoch"), "policy_epoch column added");
    assert.equal(store.getDreamRun("legacy-run").policy_epoch, 0, "existing row backfilled to default 0");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration is idempotent: reopening a migrated store does not error or lose data", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-epoch-idem-"));
  const dbPath = join(dir, "epoch.db");
  try {
    const s1 = createStore(dbPath);
    s1.saveDreamRun(run("r1", 5));
    s1.close();
    // Reopen over the already-migrated schema — must not re-ALTER or throw.
    const s2 = createStore(dbPath);
    assert.equal(s2.getDreamRun("r1").policy_epoch, 5, "data intact across reopen");
    const cols = s2.db.prepare("PRAGMA table_info(dream_runs)").all().map((c) => c.name);
    assert.equal(cols.filter((c) => c === "policy_epoch").length, 1, "column not duplicated");
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getLatestPolicyEpoch returns the newest run's epoch by created_at", () => {
  const store = openMemory();
  store.saveDreamRun(run("epoch-1", 1, "2026-08-01T00:00:00.000Z"));
  assert.equal(store.getLatestPolicyEpoch(), 1, "only row wins");
  store.saveDreamRun(run("epoch-2", 2, "2026-08-02T00:00:00.000Z"));
  assert.equal(store.getLatestPolicyEpoch(), 2, "newer row wins");
  store.saveDreamRun(run("epoch-5", 5, "2026-08-03T00:00:00.000Z"));
  assert.equal(store.getLatestPolicyEpoch(), 5, "newest row wins over mixed epochs");
  store.close();
});

test("getLatestPolicyEpoch returns 0 on an empty store", () => {
  const store = openMemory();
  assert.equal(store.getLatestPolicyEpoch(), 0);
  store.close();
});

// ---------------------------------------------------------------- dream

function dreamSetup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  return { store, service, dream };
}

test("runDream writes audit row with policy_epoch when config.policyEpoch=5", async () => {
  const { store, service, dream } = dreamSetup();
  const a = service.saveWithDedupe({ type: "project", title: "旧1", content: "内容A" });
  const b = service.saveWithDedupe({ type: "project", title: "旧2", content: "内容B" });
  const ctx = mockCtx({
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [a.memory.id, b.memory.id], title: "合并", content: "合并内容", importance: 4, keepSource: a.memory.id }
    ])
  });
  const result = await dream.runDream(ctx, service, { policyEpoch: 5 });
  assert.equal(result.ok, true);
  const run = store.getDreamRun(result.runId);
  assert.equal(run.policy_epoch, 5, "audit row carries configured epoch");
  store.close();
});

test("runDream writes audit row with policy_epoch 0 when config omits it", async () => {
  const { store, service, dream } = dreamSetup();
  const a = service.saveWithDedupe({ type: "project", title: "旧1", content: "内容A" });
  const b = service.saveWithDedupe({ type: "project", title: "旧2", content: "内容B" });
  const ctx = mockCtx({
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [a.memory.id, b.memory.id], title: "合并", content: "合并内容", importance: 4, keepSource: a.memory.id }
    ])
  });
  const result = await dream.runDream(ctx, service, {});
  assert.equal(result.ok, true);
  const run = store.getDreamRun(result.runId);
  assert.equal(run.policy_epoch, 0, "default epoch written when config omits policyEpoch");
  store.close();
});

test("compat: receipt stays 8 segments with an epoch in use", async () => {
  const { store, service, dream } = dreamSetup();
  const a = service.saveWithDedupe({ type: "project", title: "旧1", content: "内容A" });
  const b = service.saveWithDedupe({ type: "project", title: "旧2", content: "内容B" });
  const ctx = mockCtx({
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [a.memory.id, b.memory.id], title: "合并", content: "合并内容", importance: 4, keepSource: a.memory.id }
    ])
  });
  const result = await dream.runDream(ctx, service, { policyEpoch: 5 });
  const run = store.getDreamRun(result.runId);
  assert.equal(run.receipt.split(":").length, 8, "receipt format unchanged (8 segments)");
  const parsed = parseReceipt(run.receipt);
  assert.deepEqual(parsed, {
    runId: run.id,
    status: "ok",
    snapshotHash: run.snapshot_hash.slice(0, 12),
    inputCount: 2,
    applied: 1,
    summaryStored: true
  }, "receipt round-trips with an epoch in use");
  store.close();
});

// ---------------------------------------------------------------- semantic

test("semantic: runs from different epochs stay distinguishable and the newer epoch wins", () => {
  const store = openMemory();
  // epoch 1 = old ruling-rule version (historical evidence after upgrade)
  store.saveDreamRun(run("v1-run", 1, "2026-08-01T00:00:00.000Z"));
  // epoch 2 = new ruling-rule version
  store.saveDreamRun(run("v2-run", 2, "2026-08-02T00:00:00.000Z"));
  assert.equal(store.getDreamRun("v1-run").policy_epoch, 1, "old run keeps its epoch (historical evidence)");
  assert.equal(store.getDreamRun("v2-run").policy_epoch, 2, "new run keeps its epoch");
  assert.notEqual(
    store.getDreamRun("v1-run").policy_epoch,
    store.getDreamRun("v2-run").policy_epoch,
    "epochs are distinguishable per run"
  );
  assert.equal(store.getLatestPolicyEpoch(), 2, "effective rule version reflects the upgrade");
  store.close();
});
