// #230：document 型记忆——注册校验 / 摘要+doc_path 落库 / C2 去重 / supersede
// 记账 / 注入档位与预算 / 写入权分离守卫。口径基线 = #164 设计稿评审线
// （discussioncomment-18495098 + 维护者对账 18502150）。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store.js";
import { createService, PINNED_MEMORY_TYPES } from "../src/service.js";
import { createDocumentRegistrar } from "../src/document.js";
import { MEMORY_ITEM_SCHEMA } from "../src/tools.js";
import { TYPE_DECAY_DEFAULTS } from "../src/heat.js";

function makeService(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service, close: () => store.close() };
}

async function makeDocDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-mneme-doc-"));
  const writeDoc = async (name, content = "# Doc\n\nbody text") => {
    const p = path.join(dir, name);
    await writeFile(p, content, "utf8");
    return p;
  };
  return { dir, writeDoc, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** 单元级 registrar：注入假 embedQuery，隔离 vector 档行为。 */
function makeRegistrar(store, config = {}, embedQuery = async () => null, { pinnedTypes = PINNED_MEMORY_TYPES } = {}) {
  const finalized = [];
  const register = createDocumentRegistrar({
    store,
    config,
    embedQuery,
    // 与 service.js 的 pushContentHistory 同形（FIFO cap 20）
    pushContentHistory: (existing, source) => [
      { content: existing?.content ?? "", source, updated_at: new Date().toISOString() },
      ...(Array.isArray(existing?.content_history) ? existing.content_history : [])
    ].slice(0, 20),
    transaction: (fn) => fn(),
    finalize: (rows) => finalized.push(...rows),
    // #275 拍板 5：service.js 注入的 #249 逐字保真池（这里同款注入，保持行为一致）
    pinnedTypes
  });
  return { register, finalized };
}

// ============================================================ 注册校验（DoD 1）

test("registration is refused while the feature flag is off", async () => {
  const { service, close } = makeService({});
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const p = await writeDoc("a.md");
    await assert.rejects(
      () => service.registerDocument({ path: p, title: "T", summary: "S" }),
      /documentMemoryEnabled/
    );
  } finally {
    cleanup();
    close();
  }
});

test("path validation: required / absolute-only / existing non-empty regular file", async () => {
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { dir, writeDoc, cleanup } = await makeDocDir();
  try {
    await assert.rejects(
      () => service.registerDocument({ title: "T", summary: "S" }),
      /path is required/
    );
    await assert.rejects(
      () => service.registerDocument({ path: "rel.md", title: "T", summary: "S" }),
      /must be absolute/
    );
    await assert.rejects(
      () => service.registerDocument({ path: path.join(dir, "missing.md"), title: "T", summary: "S" }),
      /not found or empty/
    );
    await assert.rejects(
      () => service.registerDocument({ path: dir, title: "T", summary: "S" }),
      /not found or empty/
    );
    const empty = await writeDoc("empty.md", "");
    await assert.rejects(
      () => service.registerDocument({ path: empty, title: "T", summary: "S" }),
      /not found or empty/
    );
  } finally {
    cleanup();
    close();
  }
});

test("~ paths expand to the real home and register", async () => {
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const p = await writeDoc("tilde.md");
    const rel = path.relative(os.homedir(), p);
    const res = await service.registerDocument({
      path: `~/${rel.split(path.sep).join("/")}`,
      title: "TildeDoc",
      summary: "S"
    });
    assert.equal(res.action, "created");
    assert.equal(res.memory.doc_path, p);
  } finally {
    cleanup();
    close();
  }
});

test("evidence intersection: valid subset kept, unknown dropped + degraded tag, all-fabricated rejected", async () => {
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const a = service.saveWithDedupe({ type: "preference", title: "P1", content: "c1" }).memory;
    const b = service.saveWithDedupe({ type: "decision", title: "D1", content: "c2" }).memory;
    const p = await writeDoc("r.md");

    const partial = await service.registerDocument({
      path: p, title: "R", summary: "S", evidence: [a.id, "nope-1", b.id]
    });
    assert.equal(partial.action, "created");
    assert.deepEqual(partial.memory.evidence, [a.id, b.id]);
    assert.equal(partial.evidence_kept, 2);
    assert.equal(partial.evidence_dropped, 1);
    assert.equal(partial.degraded, true);
    assert.ok(partial.memory.tags.includes("evidence_degraded"));

    await assert.rejects(
      () => service.registerDocument({ path: p, title: "T2", summary: "S", evidence: ["nope-2"] }),
      /fabricated evidence is rejected/
    );

    const clean = await service.registerDocument({ path: await writeDoc("clean.md"), title: "T3", summary: "S" });
    assert.equal(clean.degraded, false);
    assert.deepEqual(clean.memory.evidence, []);
    assert.ok(!clean.memory.tags.includes("evidence_degraded"));
  } finally {
    cleanup();
    close();
  }
});

// ============================ 升格吸收的 evidence 归档（#275 拍板 5，同事务）

// 拍板原文：registerDocument 成功后同一事务把 absorbed 的 evidence 行翻 archived
// （可恢复、审计全留），带 opt-out；pinned（constraint / preference）永不自动归档；
// supersede 的 loser 行同样翻 archived（后者本来就是本模块既有行为，这里一并锁住）。

test("absorbed evidence rows are archived with the document; pinned rows are exempt", async () => {
  const { store, service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const pinned = service.saveWithDedupe({ type: "constraint", title: "C", content: "边界条件" }).memory;
    const decision = service.saveWithDedupe({ type: "decision", title: "D", content: "一个决定" }).memory;
    const p = await writeDoc("absorb.md");

    const res = await service.registerDocument({
      path: p, title: "Absorb", summary: "summary", evidence: [pinned.id, decision.id]
    });

    assert.equal(res.evidence_kept, 2, "引用本身照旧全留下：doc 行的 evidence 数组是正向链");
    assert.equal(res.evidence_archived, 1, "只有非 pinned 的那条被动");
    const after = service.getById(decision.id);
    assert.equal(after.archived, true, "被吸收的行退出活跃面（「21 行不是 1 行」）");
    assert.equal(after.content, "一个决定", "只翻标志位：内容与审计全留（可恢复）");
    assert.equal(service.getById(pinned.id).archived, false, "#249 的逐字保真池，升格不能绕过");
    assert.equal(store.list().some((m) => m.id === decision.id), false, "默认面不再列出吸收行");
  } finally {
    cleanup();
    close();
  }
});

test("archiveEvidence: false（工具侧 keep_evidence_active）保留吸收行的活跃面", async () => {
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const d = service.saveWithDedupe({ type: "decision", title: "D", content: "c" }).memory;
    const res = await service.registerDocument(
      { path: await writeDoc("optout.md"), title: "OptOut", summary: "s", evidence: [d.id] },
      { archiveEvidence: false }
    );
    assert.equal(res.evidence_kept, 1);
    assert.equal(res.evidence_archived, 0, "opt-out 时不归档");
    assert.equal(service.getById(d.id).archived, false);
  } finally {
    cleanup();
    close();
  }
});

test("re-registering a document whose evidence was absorbed keeps the references", async () => {
  // 这条防的是「补丁把常规路径打坏」：吸收行一旦归档，重注册同一份文档（出新版）
  // 时同一批 evidence 会全落 dropped，进而撞上捏造判据——最常规的路径反而报错。
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const d = service.saveWithDedupe({ type: "decision", title: "D", content: "c" }).memory;
    const p = await writeDoc("ver.md");
    const first = await service.registerDocument({ path: p, title: "Ver", summary: "v1", evidence: [d.id] });
    assert.equal(first.evidence_archived, 1);

    const second = await service.registerDocument({ path: p, title: "Ver", summary: "v2", evidence: [d.id] });
    assert.equal(second.action, "superseded");
    assert.deepEqual(second.memory.evidence, [d.id], "吸收行仍为它所属的那份文档背书");
    assert.equal(second.evidence_kept, 1);
    assert.equal(second.degraded, false, "不误报成捏造证据");
    // 认回是窄口径的：已归档行只为**吸收它的那份**文档背书。别的文档（新注册、无
    // 同名目标）拿它当证据，照旧走既有的捏造判据——不因为这条补丁放宽。
    const other = await writeDoc("other.md");
    await assert.rejects(
      () => service.registerDocument({ path: other, title: "Other", summary: "s", evidence: [d.id] }),
      /fabricated evidence is rejected/
    );
  } finally {
    cleanup();
    close();
  }
});

// #593 遗留缺口（#593 把 pin 从「按类型推断」改成显式存储后新出现的旁路）：
// 上一版只问 pinnedTypes.has(row.type)，于是被显式钉住的 pattern / decision 在升格
// 吸收时仍被 setArchived —— 用户钉过的行被文档悄悄收走，pin 语义（「这条我要长期
// 带着」）当场失效。这条锁住「显式 pin 表是第二判据」，且用 pattern 类型（它不在
// PINNED_MEMORY_TYPES 里），否则用例会被类型口径顺手护住、测不到缺口。
test("explicitly pinned evidence rows survive absorption even when their type is not in the pinned pool", async () => {
  const { store, service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const pinnedPattern = service.saveWithDedupe({ type: "pattern", title: "P", content: "用户反复这样操作" }).memory;
    const plainPattern = service.saveWithDedupe({ type: "pattern", title: "P2", content: "另一条没钉的模式" }).memory;
    store.pinMemory(pinnedPattern.id, { note: "显式钉住" });
    const p = await writeDoc("pin-survives.md");

    const res = await service.registerDocument({
      path: p, title: "PinSurvives", summary: "s", evidence: [pinnedPattern.id, plainPattern.id]
    });

    assert.equal(res.evidence_kept, 2);
    assert.equal(res.evidence_archived, 1, "只收走没被钉的那条");
    assert.equal(
      service.getById(pinnedPattern.id).archived,
      false,
      "被显式 pin 的行不能被升格吸收静默归档（pin 表是第二判据，不能只按类型猜）"
    );
    assert.equal(service.getById(plainPattern.id).archived, true, "没钉的同类型行照旧被吸收（补丁不放宽口径）");
  } finally {
    cleanup();
    close();
  }
});

test("registrar without the pinned pool wiring archives nothing (fail-safe)", async () => {
  // 拿不到 pinned 集合就不做这一步：宁可少做，也不能把保真池当普通行收走。
  const store = createStore(":memory:");
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const d = store.save({ type: "decision", title: "D", content: "c" });
    const { register } = makeRegistrar(store, { documentMemoryEnabled: true }, async () => null, { pinnedTypes: null });
    const res = await register({ path: await writeDoc("noset.md"), title: "NoSet", summary: "s", evidence: [d.id] });
    assert.equal(res.evidence_archived, 0);
    assert.equal(store.getById(d.id).archived, false);
  } finally {
    cleanup();
    store.close();
  }
});

test("自有生命周期的类型不被吸收：document 行保持活跃，同 path 的 supersede 链不断", async () => {
  // 回归点（单盲审查 H1）：把另一份 document 行当 evidence 时，若照普通行吸收，它会
  // 被静默归档——走不到 loser 分支（没有 [superseded by] 指针与 content_history），
  // 而 supersede 探测只看活跃行，于是重注册同 path 会再铸一行、同一个文件留下两行。
  const { store, service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const pA = await writeDoc("a.md");
    const docA = (await service.registerDocument({ path: pA, title: "DocA", summary: "v1" })).memory;
    const docB = await service.registerDocument({
      path: await writeDoc("b.md"), title: "DocB", summary: "grounded in A", evidence: [docA.id]
    });
    assert.equal(docB.evidence_archived, 0, "document 行不参与吸收");
    assert.equal(service.getById(docA.id).archived, false, "被引用不改变它的活跃状态");

    const again = await service.registerDocument({ path: pA, title: "DocA", summary: "v2" });
    assert.equal(again.action, "superseded", "指针行仍能被 supersede 探测看到");
    assert.equal(again.superseded.id, docA.id);
    assert.ok(again.superseded.content.includes(again.memory.id), "旧行拿到 [superseded by] 指针");
    assert.equal(store.all().filter((m) => m.doc_path === pA).length, 2, "同一 path 一行新版 + 一行带指针的旧版，没有多余的第三行");
  } finally {
    cleanup();
    close();
  }
});

test("自有生命周期的类型不被吸收：summary（dream 总览）保持活跃，不会被当成不存在重铸", async () => {
  // 回归点：summary 按 source 身份去重（dream 总览）且按注入档位常驻。被吸收归档后
  // 去重候选集（store.list 默认排除归档）看不到它 → 下一次做梦会再铸一行同源总览。
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const digest = service.saveWithDedupe({
      type: "summary", title: "当前项目状态", content: "resident digest", source: "dream", importance: 5
    }).memory;
    const res = await service.registerDocument({
      path: await writeDoc("with-digest.md"), title: "DocW", summary: "s", evidence: [digest.id]
    });
    assert.equal(res.evidence_archived, 0, "summary 不参与吸收");
    assert.equal(service.getById(digest.id).archived, false);

    const again = service.saveWithDedupe({
      type: "summary", title: "当前项目状态", content: "resident digest v2", source: "dream", importance: 5
    });
    assert.equal(again.action, "merged", "下一次做梦仍认得出这行，不会铸出第二行同源总览");
    assert.equal(again.memory.id, digest.id);
  } finally {
    cleanup();
    close();
  }
});

// ============================================================ supersede 记账（DoD 2）

test("re-registering the same path supersedes: old row archived + traceable, file untouched", async () => {
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const p = await writeDoc("v.md");
    const v1 = await service.registerDocument({ path: p, title: "T1", summary: "summary v1", tags: ["doc"] });
    const v2 = await service.registerDocument({ path: p, title: "T2", summary: "summary v2" });

    assert.equal(v2.action, "superseded");
    assert.equal(v2.superseded.id, v1.memory.id);
    assert.equal(v2.memory.doc_path, p);

    const old = service.getById(v1.memory.id);
    assert.equal(old.archived, true, "old row archived (no physical delete)");
    assert.ok(old.content.includes(`[superseded by ${v2.memory.id}]`), "loser carries the pointer note");
    assert.equal(old.content_history[0].source, "superseded");
    assert.equal(old.content_history[0].content, "summary v1", "old summary traceable via content_history");
    assert.equal(old.doc_path, p, "old pointer preserved");

    const fresh = service.getById(v2.memory.id);
    assert.equal(fresh.archived, false);
    assert.equal(fresh.content, "summary v2");
  } finally {
    cleanup();
    close();
  }
});

test("same title on a different path also supersedes (new version of the moved doc)", async () => {
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const p1 = await writeDoc("old.md");
    const p2 = await writeDoc("new.md");
    const v1 = await service.registerDocument({ path: p1, title: "Same", summary: "s1" });
    const v2 = await service.registerDocument({ path: p2, title: "Same", summary: "s2" });
    assert.equal(v2.action, "superseded");
    assert.equal(v2.superseded.id, v1.memory.id);
    assert.equal(service.getById(v1.memory.id).archived, true);
    assert.equal(service.getById(v2.memory.id).doc_path, p2);
  } finally {
    cleanup();
    close();
  }
});

// ============================================================ C2 去重（DoD 6 前半）

test("vector near-duplicate on a different path/title is rejected (agent decides, no silent supersede)", async () => {
  const { writeDoc, cleanup } = await makeDocDir();
  const store = createStore(":memory:");
  try {
    store.saveDocument({
      type: "document", title: "Alpha", content: "existing summary",
      doc_path: "X:\\elsewhere\\a.md", embedding: [1, 0, 0], source: "tool"
    });
    const b = await writeDoc("b.md");
    const c = await writeDoc("c.md");
    const { register } = makeRegistrar(store, { documentMemoryEnabled: true }, async () => [1, 0, 0]);
    await assert.rejects(
      () => register({ path: b, title: "Beta", summary: "similar summary" }),
      /near duplicate/
    );
    // 正交向量 = 无近重复 → 正常创建。
    const { register: register2 } = makeRegistrar(store, { documentMemoryEnabled: true }, async () => [0, 1, 0]);
    const res = await register2({ path: c, title: "Gamma", summary: "unrelated summary" });
    assert.equal(res.action, "created");
  } finally {
    cleanup();
    store.close();
  }
});

test("embedder unavailable: dedupe degrades to path/title tiers, writes still land", async () => {
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const p1 = await writeDoc("d1.md");
    const p2 = await writeDoc("d2.md");
    const r1 = await service.registerDocument({ path: p1, title: "A", summary: "identical summary text" });
    const r2 = await service.registerDocument({ path: p2, title: "B", summary: "identical summary text" });
    assert.equal(r1.action, "created");
    assert.equal(r2.action, "created", "no vector signal = no near-dup verdict, write is never blocked");
  } finally {
    cleanup();
    close();
  }
});

// ============================================================ 写入权分离守卫（DoD 1/3 旁路防护）

test("saveWithDedupe refuses to mint document rows", () => {
  const { service, close } = makeService({});
  try {
    assert.throws(
      () => service.saveWithDedupe({ type: "document", title: "x", content: "y" }),
      /registerDocument/
    );
  } finally {
    close();
  }
});

test("updateMemory cannot retype a row into document, but document summary repair passes", async () => {
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const pref = service.saveWithDedupe({ type: "preference", title: "P", content: "c" }).memory;
    assert.throws(() => service.update(pref.id, { type: "document" }), /registerDocument/);

    const p = await writeDoc("fix.md");
    const atomic = service.saveWithDedupe({ type: "decision", title: "D", content: "c" }).memory;
    const doc = (await service.registerDocument({
      path: p, title: "Doc", summary: "s", evidence: [atomic.id, "nope"]
    })).memory;
    const updated = service.update(doc.id, { content: "repaired summary", tags: ["user-tag"] });
    assert.equal(updated.content, "repaired summary");
    assert.equal(updated.doc_path, p, "pointer untouched by summary repair");
    assert.equal(updated.archived, false);
    assert.ok(
      updated.tags.includes("evidence_degraded") && updated.tags.includes("user-tag"),
      "system signal tag survives a tags-replacing update"
    );
  } finally {
    cleanup();
    close();
  }
});

// ============================================================ 注入档位与预算（DoD 5）

function seedInjectionFixtures(service, store) {
  service.saveWithDedupe({ type: "summary", title: "当前项目状态", content: "resident digest", source: "dream", importance: 5, _overwrite: true });
  service.saveWithDedupe({ type: "summary", title: "叙述：topic", content: "narrative bar", source: "narrative", tags: ["topic-n"], importance: 3 });
  // document 行铸造口唯一：测试种子也走 store.saveDocument（saveWithDedupe
  // 有 service 守卫、store.save 有存储层守卫）。
  for (let i = 1; i <= 3; i++) {
    store.saveDocument({ type: "document", title: `Doc${i}`, content: `d${i}`, source: "tool", doc_path: `X:\\${i}.md`, importance: 3 });
  }
}

test("injection: document rows at the next-priority tier, capped by documentInjectBudget; narrative tier re-enabled", () => {
  const { store, service, close } = makeService({ documentMemoryEnabled: true, documentInjectBudget: 2, dreamNarrativeEnabled: true });
  try {
    seedInjectionFixtures(service, store);
    const picked = service.injectCandidates({});
    assert.equal(picked[0].type, "summary");
    assert.equal(picked[0].source, "dream", "resident digest keeps tier 0");
    assert.equal(picked.filter((m) => m.type === "document").length, 2, "document budget caps at 2 of 3");
    assert.ok(picked.some((m) => m.source === "narrative"), "narrative rows inject at the next-priority tier (#230 拍板)");
  } finally {
    close();
  }
});

test("injection: flags off → document and narrative rows stay out, behavior unchanged", () => {
  const { store, service, close } = makeService({});
  try {
    seedInjectionFixtures(service, store);
    const picked = service.injectCandidates({});
    assert.ok(picked.every((m) => m.type !== "document"), "document rows excluded while flag off");
    assert.ok(picked.every((m) => m.source !== "narrative"), "narrative rows excluded while dreamNarrativeEnabled off");
    assert.ok(picked.some((m) => m.type === "summary" && m.source === "dream"), "dream digest unaffected");
  } finally {
    close();
  }
});

// ============================================================ DTO / 扩展面（DoD 3）

test("toApiList exposes doc_path on pointer rows only, within MEMORY_ITEM_SCHEMA", async () => {
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const pref = service.saveWithDedupe({ type: "preference", title: "P", content: "c" }).memory;
    const p = await writeDoc("dto.md");
    const doc = (await service.registerDocument({ path: p, title: "D", summary: "s" })).memory;

    const prefDto = service.toApiList([pref])[0];
    assert.ok(!("doc_path" in prefDto), "non-pointer rows keep the pre-#230 DTO shape");
    const docDto = service.toApiList([doc])[0];
    assert.equal(docDto.doc_path, p);
    for (const key of Object.keys(docDto)) {
      assert.ok(key in MEMORY_ITEM_SCHEMA.properties, `DTO key "${key}" declared in MEMORY_ITEM_SCHEMA`);
    }
  } finally {
    cleanup();
    close();
  }
});

test("document rows are heat-immune (pointer rows do not decay)", () => {
  assert.equal(TYPE_DECAY_DEFAULTS.document, 0);
});

// ============================================================ CodeRabbit 修复回归（PR #256 review）

test("path normalization: equivalent absolute spellings supersede instead of duplicating", async () => {
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { dir, writeDoc, cleanup } = await makeDocDir();
  try {
    const p = await writeDoc("norm.md");
    const first = await service.registerDocument({ path: p, title: "V1", summary: "s1" });
    // path.join 会把 "." 段吃掉，手工拼出等价但未归一化的写法。
    const dotted = `${dir}${path.sep}.${path.sep}norm.md`;
    const second = await service.registerDocument({ path: dotted, title: "V2", summary: "s2" });
    assert.equal(second.action, "superseded", "normalized spelling hits the same-path supersede tier");
    assert.equal(second.superseded.id, first.memory.id);
  } finally {
    cleanup();
    close();
  }
});

test("exact supersede tiers scan beyond any window (>200 active documents)", async () => {
  const { store, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    // 新注册的路径必须过文件校验——目标行（窗口外的旧版）用真实文件，其余
    // 209 行用虚构路径垫量。Bulk0 先种 = updated_at 最早 = list(DESC) 末位。
    const pathA = await writeDoc("a.md");
    const pathB = await writeDoc("b.md");
    store.saveDocument({ type: "document", title: "Bulk0", content: "c0", source: "tool", doc_path: pathA });
    for (let i = 1; i < 210; i++) {
      store.saveDocument({ type: "document", title: `Bulk${i}`, content: `c${i}`, source: "tool", doc_path: `X:\\bulk\\${i}.md` });
    }
    const oldest = store.list({ type: "document", limit: null }).at(-1);
    assert.equal(oldest.title, "Bulk0", "precondition: oldest row is outside the 200 window");
    const { register } = makeRegistrar(store, { documentMemoryEnabled: true });
    // 路径层：窗口外的同路径行必须仍被发现并 supersede。
    const byPath = await register({ path: pathA, title: "Fresh path re-register", summary: "new version" });
    assert.equal(byPath.action, "superseded");
    assert.equal(byPath.superseded.id, oldest.id);
    // 标题层：同款全量语义（Bulk0 已归档，此时窗口外最老是 Bulk1）。
    const next = store.list({ type: "document", limit: null }).at(-1);
    assert.equal(next.title, "Bulk1");
    const byTitle = await register({ path: pathB, title: next.title, summary: "another version" });
    assert.equal(byTitle.action, "superseded");
    assert.equal(byTitle.superseded.id, next.id);
  } finally {
    cleanup();
    close();
  }
});

test("sensitivity is persisted and participates in the supersede matching key", async () => {
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const p = await writeDoc("sens.md");
    const first = await service.registerDocument({ path: p, title: "S", summary: "s1", sensitivity: "personal" });
    assert.equal(first.memory.sensitivity, "personal", "sensitivity must persist (scopeKeyOf third dim)");
    // 同 path + 同 sensitivity = 显式出新版。
    const again = await service.registerDocument({ path: p, title: "S2", summary: "s2", sensitivity: "personal" });
    assert.equal(again.action, "superseded");
    // sensitivity 不同 = 另一 scope 维度，不互判（与 memory_save 的同键分离语义一致）。
    const other = await service.registerDocument({ path: p, title: "S3", summary: "s3", sensitivity: "team" });
    assert.equal(other.action, "created");
  } finally {
    cleanup();
    close();
  }
});

test("store guards: generic paths cannot mint or retype document rows", () => {
  const { store, close } = makeService({});
  try {
    // save：整类拒绝——doc_path 是任意调用方可捏造的字符串，「必带 doc_path」
    // 挡不住绕过注册校验的直铸（CodeRabbit 复核 #882）。
    assert.throws(
      () => store.save({ type: "document", title: "X", content: "c" }),
      /minted only via store\.saveDocument/
    );
    assert.throws(
      () => store.save({ type: "document", title: "X", content: "c", doc_path: "X:\\x.md" }),
      /minted only via store\.saveDocument/
    );
    // saveDocument：唯一铸造口，且保留指针行结构不变量。
    assert.throws(
      () => store.saveDocument({ type: "document", title: "X", content: "c" }),
      /doc_path is required/
    );
    const pref = store.save({ type: "preference", title: "P", content: "c" });
    const doc = store.saveDocument({ type: "document", title: "D", content: "s", doc_path: "X:\\d.md" });
    // update / CAS：type 不许改入或改出 document（CAS 绕过 service 守卫，存储层兜底）。
    assert.throws(() => store.update(pref.id, { type: "document" }), /cannot be changed to or from/);
    assert.throws(() => store.update(doc.id, { type: "preference" }), /cannot be changed to or from/);
    assert.throws(
      () => store.compareAndUpdate(pref.id, pref.updated_at, { type: "document" }),
      /cannot be changed to or from/
    );
    // 同 type 的摘要修复照常（doc_path 不在 UPDATE SET，天然保持）。
    const repaired = store.update(doc.id, { content: "repaired summary" });
    assert.equal(repaired.content, "repaired summary");
    assert.equal(repaired.doc_path, "X:\\d.md");
  } finally {
    close();
  }
});

test("sleep cold-scan and the pattern pool exclude document rows at the query layer", () => {
  const { store, close } = makeService({});
  try {
    const proj = store.save({ type: "project", title: "Proj", content: "c" });
    const hist = store.save({ type: "history", title: "Hist", content: "c" });
    // 最新行是 document——不带排除时它会占满 LIMIT 1 的扫描窗（饿池前置条件）。
    store.saveDocument({ type: "document", title: "Doc", content: "s", source: "tool", doc_path: "X:\\d.md" });
    // 冷扫描（getUnrecalledSince，sleep phase 2 的归档降级候选）：document 豁免。
    const cold = store.getUnrecalledSince(0);
    assert.ok(cold.some((m) => m.id === proj.id) && cold.some((m) => m.id === hist.id));
    assert.ok(cold.every((m) => m.type !== "document"), "pointer rows never become archival-demotion candidates");
    // 模式扫描池：excludeTypes 在 LIMIT 之前生效。
    const plain = store.list({ limit: 1 });
    assert.equal(plain[0].type, "document", "precondition: newest row is a document");
    const pool = store.list({ limit: 1, excludeTypes: ["document"] });
    assert.notEqual(pool[0].type, "document", "ordinary memories reach the pool even under a tight limit");
    // 无界扫描（注册器精确层）：limit null = 全量。
    assert.equal(store.list({ type: "document", limit: null }).length, 1);
  } finally {
    close();
  }
});

test("hidden evidence ids (strictScope) are treated as nonexistent by the registrar", async () => {
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const a = service.saveWithDedupe({ type: "preference", title: "P", content: "c1" }).memory;
    const b = service.saveWithDedupe({ type: "decision", title: "D", content: "c2" }).memory;
    const p = await writeDoc("hidden.md");
    // 全部不可见 = 整单拒绝（与捏造同款；先测，避免先落行后又被同路径命中）。
    await assert.rejects(
      () => service.registerDocument({ path: p, title: "H", summary: "s", evidence: [b.id] }, { hiddenEvidenceIds: [b.id] }),
      /unknown, archived or out of scope/
    );
    // 混合：不可见 id 落 dropped、不进持久化 evidence，kept/dropped 计数保持诚实。
    const mixed = await service.registerDocument(
      { path: p, title: "H", summary: "s", evidence: [a.id, b.id] },
      { hiddenEvidenceIds: [b.id] }
    );
    assert.equal(mixed.evidence_kept, 1);
    assert.equal(mixed.evidence_dropped, 1);
    assert.equal(mixed.degraded, true);
    assert.deepEqual(mixed.memory.evidence, [a.id]);
  } finally {
    cleanup();
    close();
  }
});

test("narrative gate covers the semantic paths: BM25 fallback keeps narratives out while the flag is off", () => {
  const { service, close } = makeService({});
  try {
    service.saveWithDedupe({ type: "summary", title: "叙述：zebra-topic", content: "zebra-topic narrative bar", source: "narrative", importance: 5 });
    // 无 embedder 时首轮必走 BM25 兜底——此前的门只锁规则路，语义路会漏。
    const picked = service.injectCandidates({ q: "zebra-topic" });
    assert.ok(picked.every((m) => m.source !== "narrative"), "semantic-path candidates respect dreamNarrativeEnabled");
  } finally {
    close();
  }
});

test("narrative rows inject via the semantic path once dreamNarrativeEnabled is on", () => {
  const { service, close } = makeService({ dreamNarrativeEnabled: true });
  try {
    service.saveWithDedupe({ type: "summary", title: "叙述：zebra-topic", content: "zebra-topic narrative bar", source: "narrative", importance: 5 });
    const picked = service.injectCandidates({ q: "zebra-topic" });
    assert.ok(picked.some((m) => m.source === "narrative"), "BM25 path admits narratives under the same flag as the rule path");
  } finally {
    close();
  }
});
