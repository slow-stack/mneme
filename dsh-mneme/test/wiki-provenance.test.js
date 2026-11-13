// ① 语义段溯源（verifiedBaseline / verifiedAt）的回归锁。
//
// 这一层要防的不是「少写一个字段」，而是两个具体的假象：
// 1. **T1 晚于 T0 的误报**：claims 的行号是 T1 那一刻的代码树，全仓 git_baseline 是 T0 的。
//    若拿全仓基线起算 diff，T1 之前就发生、claim 早已算进去的改动会被报成 touched
//    ——面板上就是「明明没动过，却催你复核」。所以起点必须是每页自己的 verified_baseline。
// 2. **T0 的确定性被污染**：verified 字段只由 T1 写。T0 一旦也写时间戳，
//    「同状态两次 apply 逐字节相同」这条不变量就破了（测试 wiki-t0.test.js 里那条）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runChoroT0, gitHead } from "../src/wiki/t0.js";
import { createStore } from "../src/store.js";
import { createChoroQueries } from "../src/wiki/queries.js";
import { createT1 } from "../src/wiki/t1.js";
import {
  FM_VERIFIED_AT,
  FM_VERIFIED_BASELINE,
  FM_VERIFIED_DIRTY,
  readFrontmatterKey,
  setFrontmatterKeys,
  T1_SECTION_START,
} from "../src/wiki/render.js";

const FIXED_NOW = () => "2026-11-05T12:00:00.000Z";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "choro-prov-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "provfix", scripts: { test: "node --test" } }, null, 2) + "\n", "utf8");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.js"), 'import { b } from "./b.js";\nexport const a = () => b();\n', "utf8");
  writeFileSync(join(root, "src", "b.js"), "export const b = () => 1;\n", "utf8");
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  commit(root, "init");
  return root;
}

function commit(root, message) {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", message, "--no-gpg-sign"], { cwd: root, stdio: "pipe" });
  return gitHead(root);
}

function rmTempBestEffort(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 留给系统清理 */ }
  }
}

const GOOD_OUTPUT = JSON.stringify({
  architecture: "src 模块承载核心导出面，a.js 依赖 b.js。",
  convention: "导出全部用 export const 函数式风格。",
  techStack: "纯 ESM，无框架。",
  setup: "npm test。",
  claims: [{ statement: "a.js 从 b.js 导入 b", kind: "architecture", sourcePath: "src/a.js", startLine: 1, endLine: 1 }],
});

// --- frontmatter 读写（页面格式层，与 T0/T1 无关的纯函数）---------------------

test("setFrontmatterKeys：无则追加、有则覆盖、空值删键、无 frontmatter 原样返回", () => {
  const page = "---\nchoro: v1\nslug: src\n---\n\n# 标题\n";
  const added = setFrontmatterKeys(page, [[FM_VERIFIED_BASELINE, "abc1234"], [FM_VERIFIED_AT, FIXED_NOW()]]);
  assert.equal(readFrontmatterKey(added, FM_VERIFIED_BASELINE), "abc1234");
  assert.equal(readFrontmatterKey(added, FM_VERIFIED_AT), FIXED_NOW());
  assert.ok(added.indexOf("---") < added.indexOf("verifiedBaseline"), "落在 frontmatter 里，不是正文");

  const overwritten = setFrontmatterKeys(added, [[FM_VERIFIED_BASELINE, "def5678"]]);
  assert.equal(readFrontmatterKey(overwritten, FM_VERIFIED_BASELINE), "def5678");
  assert.equal(overwritten.match(/^verifiedBaseline:/gm).length, 1, "覆盖而不是重复追加");

  const removed = setFrontmatterKeys(added, [[FM_VERIFIED_BASELINE, null]]);
  assert.equal(readFrontmatterKey(removed, FM_VERIFIED_BASELINE), null);
  assert.equal(/^verifiedBaseline:/m.test(removed), false, "删键不留空行——「没记下」要查得出来");

  // 人写的坏文件（没有 frontmatter）不许被凭空造一个块出来
  assert.equal(setFrontmatterKeys("# 纯正文\n", [[FM_VERIFIED_BASELINE, "x"]]), "# 纯正文\n");
  assert.equal(readFrontmatterKey("# 纯正文\n", FM_VERIFIED_BASELINE), null);
});

test("readFrontmatterKey：缩进列表项不算顶层键，带引号的值剥引号", () => {
  const page = '---\nslug: src\nsourceFiles:\n  - verifiedBaseline: 假的\nverifiedBaseline: "a:b"\n---\n';
  assert.equal(readFrontmatterKey(page, FM_VERIFIED_BASELINE), "a:b", "只认顶层键，列表里同名的行不误命中");
});

// --- T0 一个字节都不产出这两个键 ---------------------------------------------

test("T0 骨架页不含 verified 键：确定性不变量不许被溯源污染", () => {
  const root = makeFixture();
  const store = createStore(":memory:");
  try {
    runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW });
    const page = readFileSync(join(root, ".chorography", "modules", "src.md"), "utf8");
    assert.equal(page.includes(FM_VERIFIED_BASELINE), false, "骨架页没有「哪次验证的」这回事");
    assert.equal(page.includes(FM_VERIFIED_AT), false);
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

// --- T1 写下那一刻的 HEAD，且 claims 起点跟着它走 -----------------------------

test("T1 富化写下 verifiedBaseline/verifiedAt，且等于那一刻的 HEAD", async () => {
  const root = makeFixture();
  const store = createStore(":memory:");
  try {
    runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW });
    const head = commit(root, "t1 之前的一次提交");
    const t1 = createT1({ store, runSession: async () => ({ ok: true, text: GOOD_OUTPUT }), now: FIXED_NOW });
    const receipt = await t1.runT1({ repoRoot: root, moduleSlug: "src" });
    assert.equal(receipt.enriched.length, 1);
    assert.equal(receipt.enriched[0].verifiedBaseline, head, "回执里带得出来，人不用去翻文件");

    const page = readFileSync(join(root, ".chorography", "modules", "src.md"), "utf8");
    assert.equal(readFrontmatterKey(page, FM_VERIFIED_BASELINE), head);
    assert.equal(readFrontmatterKey(page, FM_VERIFIED_AT), FIXED_NOW());
    assert.ok(page.includes(T1_SECTION_START), "语义段照旧");

    const row = store.db.prepare(
      "SELECT p.verified_baseline, p.verified_at FROM choro_pages p JOIN choro_modules m ON p.module_id = m.id WHERE m.slug = 'src'"
    ).get();
    assert.equal(row.verified_baseline, head, "文件与库同源同写");
    assert.equal(row.verified_at, FIXED_NOW());

    const evidence = JSON.parse(readFileSync(join(root, ".chorography", "evidence", "src.json"), "utf8"));
    assert.equal(evidence.verifiedBaseline, head, "evidence 旁证也带起点");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("claimDrift：T1 晚于 T0 时，T1 之前的改动不误报 touched（这就是 per-page 基线的理由）", async () => {
  const root = makeFixture();
  const store = createStore(":memory:");
  try {
    runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW });
    // T0 之后、T1 之前有人改了 a.js 第 1 行——claim 读的就是改完之后的这棵树。
    writeFileSync(join(root, "src", "a.js"), 'export const a = () => 1;\n', "utf8");
    commit(root, "T0 之后、T1 之前");
    const t1 = createT1({ store, runSession: async () => ({ ok: true, text: GOOD_OUTPUT }), now: FIXED_NOW });
    await t1.runT1({ repoRoot: root, moduleSlug: "src" });

    const q = createChoroQueries({ store });
    const repo = q.resolveRepo(undefined);
    const drift = q.claimDrift(repo.id);
    assert.equal(drift.totals.claims, 1);
    assert.equal(drift.totals.atRiskClaims, 0, "拿全仓基线起算会在这里误报 touched（旧的 bug）");
    assert.equal(drift.clean, true);
    const pageDrift = drift.pages.find((p) => p.slug === "src");
    assert.equal(pageDrift.verifiedBaseline, drift.head, "起点就是 HEAD");
    assert.equal(pageDrift.baselineApprox, false);

    // 真改了 claim 锚点所在行：这时必须报出来，别因为「起点是 HEAD」就永远说干净。
    writeFileSync(join(root, "src", "a.js"), 'export const a = () => 2;\n', "utf8");
    commit(root, "真的动了锚点");
    const drift2 = q.claimDrift(repo.id);
    assert.equal(drift2.clean, false);
    assert.equal(drift2.totals.atRiskClaims, 1);
    assert.equal(drift2.pages.find((p) => p.slug === "src").atRisk[0].reason, "touched");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("claimDrift：老数据（没有逐页基线）退到全仓基线，并标明这是近似起点", () => {
  const root = makeFixture();
  const store = createStore(":memory:");
  try {
    runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW });
    const q = createChoroQueries({ store });
    const repo = q.resolveRepo(undefined);
    // 本功能之前富化的页：库里有 claims、没有 verified_baseline（迁移加列后的老行）。
    const page = store.choroPageBySlug(repo.id, "src");
    store.saveChoroPageClaims(page.id, [
      { statement: "a 依赖 b", kind: "architecture", sourcePath: "src/a.js", startLine: 2, endLine: 2, createdAt: FIXED_NOW() },
    ]);
    store.db.prepare("UPDATE choro_pages SET verified_baseline = NULL, verified_at = NULL WHERE id = ?").run(page.id);

    const drift = q.claimDrift(repo.id);
    const pageDrift = drift.pages.find((p) => p.slug === "src");
    assert.equal(pageDrift.verifiedBaseline, null, "真话：这页没记过逐页基线");
    assert.equal(pageDrift.baselineApprox, true, "退而求其次的起点要标出来");
    assert.equal(pageDrift.baselineUnknown, false, "有了保底起点就不再是「判不了」");
    assert.equal(pageDrift.diffBaseline, drift.baseline, "用的就是全仓基线");

    // 全仓基线也缺（极老的行）→ 才轮到 baselineUnknown，一条都不判。
    store.db.prepare("UPDATE choro_repos SET git_baseline = '' WHERE id = ?").run(repo.id);
    const drift2 = q.claimDrift(repo.id);
    assert.equal(drift2.pages.find((p) => p.slug === "src").baselineUnknown, true);
    assert.equal(drift2.totals.atRiskClaims, 0, "判不了就是判不了，不冒充没事");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

// --- #648：基线只有 HEAD，工作区脏时 claim 的行号来自一棵没进提交的树 -----------

test("T1 在脏工作区富化：记下脏文件清单，脏文件上的 claim 判 uncommitted（#648）", async () => {
  const root = makeFixture();
  const store = createStore(":memory:");
  try {
    runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW });
    // 未提交地改 a.js：GOOD_OUTPUT 的 claim 锚点（第 1 行）就落在这份磁盘内容上。
    writeFileSync(join(root, "src", "a.js"), 'import { b } from "./b.js";\nexport const a = () => 7;\n', "utf8");
    const head = gitHead(root);
    const t1 = createT1({ store, runSession: async () => ({ ok: true, text: GOOD_OUTPUT }), now: FIXED_NOW });
    const receipt = await t1.runT1({ repoRoot: root, moduleSlug: "src" });
    assert.equal(receipt.enriched[0].verifiedBaseline, head, "基线仍记 HEAD：claims 的行号确实从这棵树上读的");
    assert.equal(receipt.enriched[0].verifiedDirtyFiles, 1, "回执报脏文件条数，人不用翻库");

    const page = readFileSync(join(root, ".chorography", "modules", "src.md"), "utf8");
    assert.equal(readFrontmatterKey(page, FM_VERIFIED_DIRTY), "true", "页面文件写明这次验证不在干净 HEAD 上");
    assert.equal(readFrontmatterKey(page, FM_VERIFIED_BASELINE), head);

    const row = store.db.prepare(
      "SELECT p.verified_dirty_files FROM choro_pages p JOIN choro_modules m ON p.module_id = m.id WHERE m.slug = 'src'"
    ).get();
    assert.deepEqual(JSON.parse(row.verified_dirty_files), ["src/a.js"], "清单落库（不是只写在回执里）");

    const evidence = JSON.parse(readFileSync(join(root, ".chorography", "evidence", "src.json"), "utf8"));
    assert.deepEqual(evidence.verifiedDirtyFiles, ["src/a.js"], "旁证同步：复核的人才知道锚点是从哪棵树读的");

    const q = createChoroQueries({ store });
    const repo = q.resolveRepo(undefined);
    const drift = q.claimDrift(repo.id);
    assert.equal(drift.totals.claims, 1);
    assert.equal(drift.totals.uncommitted, 1, "diff 会说没事，但这段改动不在任何提交里");
    assert.equal(drift.totals.atRiskClaims, 1);
    assert.equal(drift.pages.find((p) => p.slug === "src").atRisk[0].reason, "uncommitted");
    assert.equal(drift.clean, false, "判不出来就不能说干净");

    // 提交之后不会自愈：改动发生时基线已指向提交前的树，这段永远补不回来。
    commit(root, "把那次未提交改动提交掉");
    const drift2 = q.claimDrift(repo.id);
    assert.equal(drift2.pages.find((p) => p.slug === "src").atRisk[0].reason, "uncommitted", "提交后仍是同一档");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("只有被 claim 引用的脏文件才判 uncommitted，其它脏文件不牵连整页（#648）", async () => {
  const root = makeFixture();
  const store = createStore(":memory:");
  try {
    runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW });
    // b.js 未提交地改过，但 GOOD_OUTPUT 只 claim 了 a.js：整页降级会让一个无关脏文件
    // 杀掉全部漂移检测，所以只有被引用的文件才算「无法用提交核对」。
    writeFileSync(join(root, "src", "b.js"), "export const b = () => 9;\n", "utf8");
    const t1 = createT1({ store, runSession: async () => ({ ok: true, text: GOOD_OUTPUT }), now: FIXED_NOW });
    await t1.runT1({ repoRoot: root, moduleSlug: "src" });

    // 之后真的提交一次碰了 a.js 锚点第 1 行的改动：这一条必须按 diff 判 touched。
    writeFileSync(join(root, "src", "a.js"), 'export const a = () => 3;\n', "utf8");
    commit(root, "碰了 a.js 的锚点");

    const q = createChoroQueries({ store });
    const repo = q.resolveRepo(undefined);
    const drift = q.claimDrift(repo.id);
    assert.equal(drift.totals.uncommitted, 0, "b.js 脏但没被 claim 引用，不该牵连");
    assert.equal(drift.pages.find((p) => p.slug === "src").atRisk[0].reason, "touched", "干净文件的判定照旧精确");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("老数据没有脏文件清单：不判 uncommitted，页上明说「不知道当时工作区状态」（#648）", () => {
  const root = makeFixture();
  const store = createStore(":memory:");
  try {
    runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW });
    const q = createChoroQueries({ store });
    const repo = q.resolveRepo(undefined);
    // 本列之前富化的页：有 claims、有基线，但没有脏文件清单。
    const page = store.choroPageBySlug(repo.id, "src");
    store.saveChoroPageClaims(page.id, [
      { statement: "a 依赖 b", kind: "architecture", sourcePath: "src/a.js", startLine: 2, endLine: 2, createdAt: FIXED_NOW() },
    ]);
    store.db.prepare(
      "UPDATE choro_pages SET verified_baseline = ?, verified_at = ?, verified_dirty_files = NULL WHERE id = ?"
    ).run(gitHead(root), FIXED_NOW(), page.id);

    const drift = q.claimDrift(repo.id);
    const pageDrift = drift.pages.find((p) => p.slug === "src");
    assert.equal(pageDrift.verifiedDirtyFiles, null, "NULL = 不知道，不是「当时干净」");
    assert.equal(drift.totals.uncommitted, 0, "没有清单就不编造 uncommitted");
    assert.equal(drift.totals.atRiskClaims, 0, "没被 diff 碰到就是没事");

    // 对照：清单存在且为空 → 明确的「当时干净」，与 NULL 不是一回事。
    store.db.prepare("UPDATE choro_pages SET verified_dirty_files = '[]' WHERE id = ?").run(page.id);
    const drift2 = q.claimDrift(repo.id);
    assert.deepEqual(drift2.pages.find((p) => p.slug === "src").verifiedDirtyFiles, [], "空数组是明确答案");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("老库缺 verified_dirty_files 列：打开时幂等补上，老行留 NULL（#648）", () => {
  const dir = mkdtempSync(join(tmpdir(), "choro-mig-"));
  const dbPath = join(dir, "m.db");
  try {
    const s1 = createStore(dbPath);
    s1.db.exec("ALTER TABLE choro_pages DROP COLUMN verified_dirty_files");
    assert.equal(s1.db.prepare("PRAGMA table_info(choro_pages)").all().some((c) => c.name === "verified_dirty_files"), false);
    s1.close();

    const s2 = createStore(dbPath);
    const cols2 = s2.db.prepare("PRAGMA table_info(choro_pages)").all().map((c) => c.name);
    assert.ok(cols2.includes("verified_dirty_files"), "老库重开补列");
    s2.close();

    const s3 = createStore(dbPath);
    const cols3 = s3.db.prepare("PRAGMA table_info(choro_pages)").all().map((c) => c.name);
    assert.equal(cols3.filter((c) => c === "verified_dirty_files").length, 1, "幂等：不会重复加列");
    s3.close();
  } finally {
    rmTempBestEffort(dir);
  }
});
