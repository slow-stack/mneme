import test from "node:test";
import assert from "node:assert/strict";
import { validateDecisions, applyDecisions } from "../src/dream/decisions.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { testConfig } from "./helpers/test-config.js";

// snapshot helper: memories eligible for consolidation (non-archived, non-summary)
function makeSnapshot(store) {
  const snap = new Map();
  for (const m of store.all()) {
    if (!m.archived && m.type !== "summary") snap.set(m.id, m);
  }
  return snap;
}

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  return { store, service };
}

/** Insert a memory and backdate created_at to `hoursAgo`. */
function seedMemory(service, store, fields, hoursAgo = 48) {
  const created = service.saveWithDedupe(fields);
  const mem = created.memory;
  if (hoursAgo) {
    const old = new Date(Date.now() - hoursAgo * 3600000).toISOString();
    store.db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(old, mem.id);
  }
  return store.getById(mem.id);
}

// --- update validation ---------------------------------------------------

test("update validation rejects multiple ids", () => {
  const { store } = setup();
  const snap = makeSnapshot(store);
  const { ok, errors } = validateDecisions(
    [{ action: "update", ids: ["a", "b"], content: "new" }], snap
  );
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("exactly one id")));
});

test("update validation rejects no actual change", () => {
  const { store, service } = setup();
  const mem = seedMemory(service, store, { type: "preference", title: "语言", content: "喜欢 Python" });
  const snap = makeSnapshot(store);
  const { ok, errors } = validateDecisions(
    [{ action: "update", ids: [mem.id], content: "喜欢 Python" }], snap
  );
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("change at least one field")));
});

test("update validation rejects summary type", () => {
  const { store, service } = setup();
  const mem = seedMemory(service, store, { type: "summary", title: "总览", content: "overview" });
  const snap = makeSnapshot(store);
  // summary is excluded from snapshot, so also test direct: simulate by forcing it in
  snap.set(mem.id, mem);
  const { ok, errors } = validateDecisions(
    [{ action: "update", ids: [mem.id], content: "new overview" }], snap
  );
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("summary") || e.includes("not eligible")));
});

test("update validation rejects too-young memory (< minAgeHours)", () => {
  const { store, service } = setup();
  const mem = seedMemory(service, store, { type: "preference", title: "新", content: "新记忆" }, 1); // 1 hour old
  const snap = makeSnapshot(store);
  const { ok, errors } = validateDecisions(
    [{ action: "update", ids: [mem.id], content: "修正" }], snap, { minAgeHours: 24 }
  );
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("too young")));
});

test("update validation respects configurable minAgeHours", () => {
  const { store, service } = setup();
  const mem = seedMemory(service, store, { type: "preference", title: "新", content: "新记忆" }, 1);
  const snap = makeSnapshot(store);
  // minAgeHours=0 disables the age guard -> update of a 1h-old memory passes
  const { ok, errors } = validateDecisions(
    [{ action: "update", ids: [mem.id], content: "修正" }], snap, { minAgeHours: 0 }
  );
  assert.equal(ok, true, errors.join("; "));
});

test("update validation rejects > maxUpdatePerRun updates", () => {
  const { store, service } = setup();
  const a = seedMemory(service, store, { type: "preference", title: "A", content: "a" });
  const b = seedMemory(service, store, { type: "preference", title: "B", content: "b" });
  const c = seedMemory(service, store, { type: "preference", title: "C", content: "c" });
  const snap = makeSnapshot(store);
  const { ok, errors } = validateDecisions([
    { action: "update", ids: [a.id], content: "a2" },
    { action: "update", ids: [b.id], content: "b2" },
    { action: "update", ids: [c.id], content: "c2" }
  ], snap, { maxUpdatePerRun: 2 });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("too many update")));
});

test("update validation passes a single valid update", () => {
  const { store, service } = setup();
  const mem = seedMemory(service, store, { type: "preference", title: "语言", content: "喜欢 Python" });
  const snap = makeSnapshot(store);
  const { ok, errors } = validateDecisions(
    [{ action: "update", ids: [mem.id], content: "喜欢 Rust" }], snap
  );
  assert.equal(ok, true, errors.join("; "));
});

// --- update application --------------------------------------------------

test("update application changes the memory content", () => {
  const { store, service } = setup();
  const mem = seedMemory(service, store, { type: "preference", title: "语言", content: "喜欢 Python" });
  const snap = makeSnapshot(store);
  const decisions = [{ action: "update", ids: [mem.id], content: "喜欢 Rust" }];
  assert.equal(validateDecisions(decisions, snap).ok, true);
  const { applied } = applyDecisions(decisions, service);
  assert.equal(applied, 1);
  const updated = store.getById(mem.id);
  assert.equal(updated.content, "喜欢 Rust");
});

test("update application is idempotent on replay", () => {
  const { store, service } = setup();
  const mem = seedMemory(service, store, { type: "preference", title: "语言", content: "喜欢 Python" });
  const snap = makeSnapshot(store);
  const decisions = [{ action: "update", ids: [mem.id], content: "喜欢 Rust" }];
  applyDecisions(decisions, service);
  const appliedAgain = applyDecisions(decisions, service);
  assert.equal(appliedAgain.applied, 0, "replay of an already-applied update should be a no-op");
});

test("update application preserves unspecified fields", () => {
  const { store, service } = setup();
  const mem = seedMemory(service, store, { type: "preference", title: "语言", content: "喜欢 Python", importance: 3 });
  const snap = makeSnapshot(store);
  const decisions = [{ action: "update", ids: [mem.id], content: "喜欢 Rust" }];
  applyDecisions(decisions, service);
  const updated = store.getById(mem.id);
  assert.equal(updated.content, "喜欢 Rust");
  assert.equal(updated.title, "语言", "title preserved");
  assert.equal(updated.importance, 3, "importance preserved");
});

// --- failure tracking ----------------------------------------------------

test("user correction records a failure_memories row", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({ reflectionFailureTracking: true }) });
  const mem = seedMemory(service, store, { type: "preference", title: "语言", content: "喜欢 Python" });
  service.update(mem.id, { content: "喜欢 Rust" });
  const failures = store.listFailures();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].failure_type, "user_correction");
  assert.equal(failures[0].memory_id, mem.id);
  assert.equal(failures[0].actual, "喜欢 Python");
  assert.equal(failures[0].expected, "喜欢 Rust");
});

test("user correction records failure when only title changes", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({ reflectionFailureTracking: true }) });
  const mem = seedMemory(service, store, { type: "preference", title: "语言", content: "喜欢 Python" });
  service.update(mem.id, { title: "编程语言" }); // title change, content same
  const failures = store.listFailures();
  assert.equal(failures.length, 1, "title-only change should still record a failure");
  assert.equal(failures[0].failure_type, "user_correction");
});

test("user correction records query context when provided", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({ reflectionFailureTracking: true }) });
  const mem = seedMemory(service, store, { type: "preference", title: "语言", content: "喜欢 Python" });
  service.update(mem.id, { content: "喜欢 Rust" }, { query: "用户说：不对，我喜欢 Rust" });
  const failures = store.listFailures();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].query, "用户说：不对，我喜欢 Rust");
});

test("user correction skips failure when nothing meaningful changes", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({ reflectionFailureTracking: true }) });
  const mem = seedMemory(service, store, { type: "preference", title: "语言", content: "喜欢 Python", importance: 3 });
  service.update(mem.id, { title: "语言", content: "喜欢 Python", importance: 3 }); // identical
  assert.equal(store.listFailures().length, 0, "no meaningful change -> no failure");
});

test("deleteOldFailures removes rows older than the cutoff", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({ reflectionFailureTracking: true }) });
  const mem = seedMemory(service, store, { type: "preference", title: "语言", content: "喜欢 Python" });
  service.update(mem.id, { content: "喜欢 Rust" });
  assert.equal(store.listFailures().length, 1);
  // cutoff in the future: everything is older, so all rows get deleted
  const removed = store.deleteOldFailures(new Date(Date.now() + 86400000).toISOString());
  assert.equal(removed, 1);
  assert.equal(store.listFailures().length, 0);
});

test("failure tracking disabled by config", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({ reflectionFailureTracking: false }) });
  const mem = seedMemory(service, store, { type: "preference", title: "语言", content: "喜欢 Python" });
  service.update(mem.id, { content: "喜欢 Rust" });
  assert.equal(store.listFailures().length, 0);
});

test("listFailures and getFailureStats work", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({ reflectionFailureTracking: true }) });
  const a = seedMemory(service, store, { type: "preference", title: "A", content: "x1" });
  const b = seedMemory(service, store, { type: "preference", title: "B", content: "y1" });
  service.update(a.id, { content: "x2" });
  service.update(b.id, { content: "y2" });
  const failures = store.listFailures();
  assert.equal(failures.length, 2);
  const stats = store.getFailureStats();
  assert.equal(stats.user_correction, 2);
});
