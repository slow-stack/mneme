import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMirror } from "../src/mirror.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { testConfig } from "./helpers/test-config.js";

const TYPE_FILE = { preference: "preferences.md", project: "projects.md", decision: "decisions.md", history: "history.md" };

function tempDir() {
  return mkdtempSync(join(tmpdir(), "dsh-mneme-mirror-"));
}

function sampleMemory(type, over = {}) {
  return {
    id: "m1", type, title: "标题", content: "内容",
    tags: ["a"], importance: 3, forgotten: false,
    source: undefined, created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z", ...over
  };
}

test("mirror writes one markdown file per type on sync", () => {
  const dir = tempDir();
  try {
    const mirror = createMirror(dir);
    mirror.sync([
      sampleMemory("preference"),
      sampleMemory("project")
    ]);
    assert.ok(mirror.filePath("preference").endsWith("preferences.md"));
    for (const type of ["preference", "project"]) {
      const text = readFileSync(join(dir, TYPE_FILE[type]), "utf8");
      assert.ok(text.includes("m1"), `${type} file contains id`);
      assert.ok(text.includes("标题"), `${type} file contains title`);
      assert.ok(text.includes("内容"), `${type} file contains content`);
    }
    assert.ok(mirror.filePath("decision").includes("decisions"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mirror groups multiple memories newest-first with header", () => {
  const dir = tempDir();
  try {
    const mirror = createMirror(dir);
    mirror.sync([
      sampleMemory("project", { id: "old", updated_at: "2026-01-01T00:00:00.000Z" }),
      sampleMemory("project", { id: "new", updated_at: "2026-02-01T00:00:00.000Z" })
    ]);
    const text = readFileSync(join(dir, "projects.md"), "utf8");
    const iNew = text.indexOf("new");
    const iOld = text.indexOf("old");
    assert.ok(iNew !== -1 && iOld !== -1 && iNew < iOld, "newest first");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("human edit wins on next sync (bidirectional, human-first)", () => {
  const dir = tempDir();
  try {
    const mirror = createMirror(dir);
    mirror.sync([sampleMemory("preference", { id: "m1", content: "机器内容" })]);
    // human edits the mirror file
    const file = join(dir, "preferences.md");
    const edited = readFileSync(file, "utf8").replace("机器内容", "人类编辑内容");
    writeFileSync(file, edited, "utf8");
    const humanEdits = mirror.readHumanEdits();
    assert.ok(Array.isArray(humanEdits));
    const m1 = humanEdits.find((e) => e.id === "m1");
    assert.ok(m1, "detects human edit for m1");
    assert.equal(m1.content, "人类编辑内容");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readHumanEdits content is not polluted by file header", () => {
  const dir = tempDir();
  try {
    const mirror = createMirror(dir);
    mirror.sync([sampleMemory("preference", { id: "m1", content: "机器内容" })]);
    const m1 = mirror.readHumanEdits("preference").find((e) => e.id === "m1");
    assert.ok(m1, "detects m1");
    assert.equal(m1.content, "机器内容");
    assert.ok(!m1.content.includes("#"), "no H1 header in content");
    assert.ok(!m1.content.includes("dsh-mneme 镜像"), "no mirror banner in content");
    assert.ok(!m1.content.includes("<!--"), "no html comment in content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("body containing '---' survives round-trip (no silent truncation)", () => {
  const dir = tempDir();
  try {
    const mirror = createMirror(dir);
    const content = "第一段\n\n---\n\n第二段";
    mirror.sync([sampleMemory("project", { id: "p1", content })]);
    const p1 = mirror.readHumanEdits("project").find((e) => e.id === "p1");
    assert.ok(p1, "detects p1");
    assert.equal(p1.content, content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("body lines resembling metadata are preserved", () => {
  const dir = tempDir();
  try {
    const mirror = createMirror(dir);
    const content = "- **ID**: 假条目\n- **重要性**: 5（正文里写的）";
    mirror.sync([sampleMemory("preference", { id: "m1", content })]);
    const m1 = mirror.readHumanEdits("preference").find((e) => e.id === "m1");
    assert.ok(m1, "detects m1");
    assert.equal(m1.content, content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("body line in machine ID format does not split entry or create ghost entry", () => {
  const dir = tempDir();
  try {
    const mirror = createMirror(dir);
    const content = "- **ID**: `phantom`\n- **重要性**: 5（正文里写的）";
    mirror.sync([sampleMemory("preference", { id: "m1", content })]);
    const edits = mirror.readHumanEdits("preference");
    const m1 = edits.find((e) => e.id === "m1");
    assert.ok(m1, "detects m1");
    assert.equal(m1.content, content);
    assert.ok(!edits.some((e) => e.id === "phantom"), "no ghost entry for phantom");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync with empty array deletes stale mirror files", () => {
  const dir = tempDir();
  try {
    const mirror = createMirror(dir);
    mirror.sync([
      sampleMemory("preference"),
      sampleMemory("project"),
      sampleMemory("decision"),
      sampleMemory("history")
    ]);
    for (const type of Object.keys(TYPE_FILE)) {
      assert.ok(existsSync(join(dir, TYPE_FILE[type])), `${type} file exists`);
    }
    mirror.sync([]);
    for (const type of Object.keys(TYPE_FILE)) {
      assert.ok(!existsSync(join(dir, TYPE_FILE[type])), `${type} file removed`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup merge keeps human edits across multiple type files (read-all-then-merge)", () => {
  const dir = tempDir();
  try {
    const store = createStore(join(dir, "memory.db"));
    const mirror = createMirror(dir);
    const service = createService({ store, mirror, config: testConfig({}) });
    service.saveWithDedupe({ type: "preference", title: "语言", content: "机器内容" });
    service.saveWithDedupe({ type: "project", title: "项目", content: "机器内容" });
    // human edits BOTH mirror files before the startup merge
    for (const [file, to] of [["preferences.md", "人工偏好"], ["projects.md", "人工项目"]]) {
      const p = join(dir, file);
      writeFileSync(p, readFileSync(p, "utf8").replace("机器内容", to), "utf8");
    }
    // replicate index.js startup: read EVERY type's edits first, then merge
    // (a per-type read-then-merge loop would let the first syncMirror
    // overwrite the unread type's file and lose the edit)
    const byType = new Map();
    for (const type of Object.keys(TYPE_FILE)) byType.set(type, mirror.readHumanEdits(type));
    for (const [type, edits] of byType) if (edits.length) service.mergeHumanEdits(type, edits);
    const prefs = service.list({ type: "preference", includeForgotten: true });
    const projects = service.list({ type: "project", includeForgotten: true });
    assert.ok(prefs.some((m) => m.content.includes("人工偏好")), "preference edit survives");
    assert.ok(projects.some((m) => m.content.includes("人工项目")), "project edit survives");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- item ④: runtime human edits are reconciled on sync (not only at startup)

test("runtime human edit survives the next sync (human wins, no silent overwrite)", () => {
  const dir = tempDir();
  try {
    const store = createStore(join(dir, "memory.db"));
    const mirror = createMirror(dir);
    const service = createService({ store, mirror, config: testConfig({}) });
    service.saveWithDedupe({ type: "preference", title: "语言", content: "机器内容" });
    // human edits the mirror file AFTER the initial sync
    const file = join(dir, "preferences.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("机器内容", "人类编辑内容"), "utf8");
    // the next unrelated store write triggers syncMirror → must merge the edit back
    service.saveWithDedupe({ type: "project", title: "无关", content: "x" });
    const prefs = service.list({ type: "preference", includeArchived: true });
    const m = prefs.find((p) => p.title === "语言");
    assert.equal(m.content, "人类编辑内容", "human edit merged back into the store");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent human edit + store update produces a three-way conflict marker, no side lost", () => {
  const dir = tempDir();
  try {
    const store = createStore(join(dir, "memory.db"));
    const mirror = createMirror(dir);
    const service = createService({ store, mirror, config: testConfig({}) });
    const { memory: m } = service.saveWithDedupe({ type: "preference", title: "语言", content: "机器内容" });
    // human edits the file…
    const file = join(dir, "preferences.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("机器内容", "人类编辑内容"), "utf8");
    // …while the store is concurrently updated → next sync sees both sides changed
    service.update(m.id, { content: "并发机器版本" });
    const updated = service.getById(m.id);
    assert.ok(updated.content.includes("人类编辑内容"), "human edit is kept as the head");
    assert.ok(updated.content.includes("并发机器版本"), "store's concurrent version is preserved");
    assert.ok(updated.content.includes("并发冲突"), "conflict marker appended");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readHumanEdits records the machine-written updated_at as the version token", () => {
  const dir = tempDir();
  try {
    const mirror = createMirror(dir);
    mirror.sync([sampleMemory("preference", { id: "m1", content: "机器内容", updated_at: "2026-03-01T00:00:00.000Z" })]);
    const m1 = mirror.readHumanEdits("preference").find((e) => e.id === "m1");
    assert.ok(m1, "detects m1");
    assert.equal(m1.updated_at, "2026-03-01T00:00:00.000Z", "updated_at captured for three-way merge");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
