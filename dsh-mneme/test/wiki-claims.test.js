// claims 粒度的失效判定（借 openwiki 的 Grounded Claims，issue #607 后续）。
//
// 锁的是「结论失准 vs 锚点错位」这条分界线：把 shifted 混进 touched，面板就会对一堆
// 只是行号偏了几行的结论喊「要重写」，喊几次就没人信了——这是本模块存在的全部理由。
// 还锁三种「算不出来」不许冒充「没事」：基线认不出、git 目录不可读、空 diff。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseDiffRanges, assessClaims, summarizeClaims, diffSince } from "../src/wiki/claims.js";

const DIFF = [
  "diff --git a/src/a.js b/src/a.js",
  "--- a/src/a.js",
  "+++ b/src/a.js",
  "@@ -7,3 +7,4 @@ export function x() {",
  "-old",
  "+new",
  "+extra",
  "diff --git a/src/gone.js b/src/gone.js",
  "--- a/src/gone.js",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-a",
  "-b",
].join("\n");

test("parseDiffRanges：hunk 头取新旧两侧坐标，/dev/null 进 deleted", () => {
  const d = parseDiffRanges(DIFF);
  assert.deepEqual([...d.files.keys()], ["src/a.js"]);
  assert.deepEqual(d.files.get("src/a.js"), [{ oldStart: 7, oldCount: 3, newStart: 7, newCount: 4 }]);
  assert.deepEqual(d.deleted, ["src/gone.js"]);
  // `@@ -c +c @@` 不带计数时按 1 算（`+c` 与 `+c,1` 同义；只有显式 `,0` 才是纯增删）。
  const one = parseDiffRanges("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3 +3,2 @@\n-a\n+b\n+c\n");
  assert.deepEqual(one.files.get("x"), [{ oldStart: 3, oldCount: 1, newStart: 3, newCount: 2 }]);
});

test("assessClaims：touched / shifted / deleted / unverifiable 四档分开，未变的不报", () => {
  const d = parseDiffRanges(DIFF);
  const claims = [
    { id: 1, statement: "A", sourcePath: "src/a.js", startLine: 8, endLine: 9, pageSlug: "p1" },
    { id: 2, statement: "B", sourcePath: "src/a.js", startLine: 2, endLine: 3, pageSlug: "p1" },
    { id: 3, statement: "C", sourcePath: "src/gone.js", startLine: 1, endLine: 1, pageSlug: "p2" },
    { id: 4, statement: "D", sourcePath: "src/a.js", pageSlug: "p1" },
    { id: 5, statement: "E", sourcePath: "src/untouched.js", startLine: 1, endLine: 1, pageSlug: "p3" },
  ];
  const out = assessClaims(claims, d);
  assert.deepEqual(out.map((c) => [c.id, c.reason]), [
    [1, "touched"],
    [2, null],
    [3, "deleted"],
    [4, "unverifiable"],
    [5, null],
  ]);
  assert.equal(out[0].shift, 0, "相交时 shift 记的是「相交之前累计了多少行");
});

test("assessClaims：区间没被碰但上方有增删 → shifted 带 shift，不升级成 touched", () => {
  // 第 2 行插了一行 → 第 10 行的结论内容还在，只是行号往后挪 1。
  const diff = parseDiffRanges("diff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -2,0 +3,1 @@\n+inserted\n");
  const [c] = assessClaims([{ id: 9, statement: "S", sourcePath: "y", startLine: 10, endLine: 11, pageSlug: "p" }], diff);
  assert.equal(c.reason, "shifted");
  assert.equal(c.shift, 1);
});

test("assessClaims：纯插入落在结论行区间内部也算 touched，插在首行之前只是 shifted", () => {
  // @@ -5,0 +6,1 @@ 表示「旧第 5 行之后插入一行」。结论占旧第 4-6 行时，新行插在
  // 第 5 与第 6 行之间——结论的原文区间被切开了，不能报「没事」。
  const inside = parseDiffRanges("diff --git a/z b/z\n--- a/z\n+++ b/z\n@@ -5,0 +6,1 @@\n+inserted\n");
  const [hit] = assessClaims([{ id: 1, statement: "S", sourcePath: "z", startLine: 4, endLine: 6, pageSlug: "p" }], inside);
  assert.equal(hit.reason, "touched", "插在结论区间内部：原文被切断");
  // 插在结论首行之前（旧第 2 行之后）只是把整个区间推下去，内容没变。
  const above = parseDiffRanges("diff --git a/z b/z\n--- a/z\n+++ b/z\n@@ -2,0 +3,1 @@\n+inserted\n");
  const [pushed] = assessClaims([{ id: 2, statement: "S", sourcePath: "z", startLine: 4, endLine: 6, pageSlug: "p" }], above);
  assert.equal(pushed.reason, "shifted");
  assert.equal(pushed.shift, 1);
  // 单行结论（start === end）边界：插在它上面一行 → shifted（内容没动，行号后移）；
  // 插在它下面 → null（既不碰到也不移动）。把「后面插」算成 shifted 会让一堆没变的
  // 结论被喊去复核。
  const [singleAbove] = assessClaims([{ id: 3, statement: "S", sourcePath: "z", startLine: 4, endLine: 4, pageSlug: "p" }], above);
  assert.equal(singleAbove.reason, "shifted", "单行结论上方插一行，内容没动只是后移");
  assert.equal(singleAbove.shift, 1);
  const [singleBelow] = assessClaims([{ id: 4, statement: "S", sourcePath: "z", startLine: 4, endLine: 4, pageSlug: "p" }], inside);
  assert.equal(singleBelow.reason, null, "单行结论下方插一行，既不碰到也不移动");
});

test("parseDiffRanges + assessClaims：git 八进制转义的中文路径要还原（否则漏判成没事）", () => {
  // core.quotepath 默认开着，中文路径在 diff 里长这样：
  //   --- "a/\344\270\255\346\226\207.js"
  // 只脱引号不解转义的话，归一出来的字符串永远对不上库里存的 source_path，
  // 这些文件上的结论就再也判不成 touched——不是报错，是静默漏判。
  const quoted = '"a/\\344\\270\\255\\346\\226\\207.js"';
  const diff = parseDiffRanges(
    "diff --git " + quoted + " " + quoted + "\n"
    + "--- " + quoted + "\n"
    + "+++ " + quoted + "\n"
    + "@@ -2,2 +2,2 @@\n-a\n+b\n"
  );
  assert.deepEqual([...diff.files.keys()], ["中文.js"], "八进制转义要还原成真文件名");
  const [c] = assessClaims([{ id: 1, statement: "S", sourcePath: "中文.js", startLine: 2, endLine: 3, pageSlug: "p" }], diff);
  assert.equal(c.reason, "touched", "中文名文件上的结论必须能判成 touched");
});

test("diffSince：重命名按「删旧 + 增新」处理，旧路径上的结论判成 deleted", () => {
  const root = mkdtempSync(join(tmpdir(), "choro-claims-rename-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    // 中文名一起测：rename 与 quotepath 两条转义路径都走一遍。
    writeFileSync(join(root, "src", "旧名.js"), "export const a = 1;\nexport const b = 2;\n", "utf8");
    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init", "--no-gpg-sign"], { cwd: root, stdio: "pipe" });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    execFileSync("git", ["mv", "src/旧名.js", "src/新名.js"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "rename", "--no-gpg-sign"], { cwd: root, stdio: "pipe" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const d = diffSince(root, base, head);
    assert.equal(d.ok, true);
    // 不传 --no-renames 时 git 只输出 `rename from/to`，files 与 deleted 里都没有这条
    // 路径，结论会被静默判成 untouched（漏判）。关掉检测后旧路径必须进 deleted。
    assert.ok(d.deleted.includes("src/旧名.js"), "重命名后旧路径上的结论必须判成 deleted");
    const [c] = assessClaims([{ id: 1, statement: "S", sourcePath: "src/旧名.js", startLine: 1, endLine: 2, pageSlug: "p" }], d);
    assert.equal(c.reason, "deleted");
  } finally {
    for (let i = 0; i < 5; i++) {
      try { rmSync(root, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); }
    }
  }
});

test("summarizeClaims：按页聚合，hasT1 却零 claims 的页单独记 inconsistent", () => {
  const d = parseDiffRanges(DIFF);
  const claims = [
    { id: 1, statement: "A", sourcePath: "src/a.js", startLine: 8, endLine: 9, pageSlug: "p1", pageTitle: "P1" },
    { id: 3, statement: "C", sourcePath: "src/gone.js", startLine: 1, endLine: 1, pageSlug: "p2", pageTitle: "P2" },
  ];
  const s = summarizeClaims(claims, d, {
    pages: [
      { slug: "p1", title: "P1", hasT1: true },
      { slug: "p2", title: "P2", hasT1: true },
      { slug: "p3", title: "P3", hasT1: true },
      { slug: "p4", title: "P4", hasT1: false },
    ],
  });
  assert.deepEqual(s.pages.map((p) => p.slug), ["p1", "p2", "p3", "p4"], "有风险的排前面，干净的在后");
  assert.equal(s.totals.claims, 2);
  assert.equal(s.totals.atRiskClaims, 2);
  assert.equal(s.totals.atRiskPages, 2);
  assert.equal(s.totals.inconsistentPages, 1, "p3 有 T1 段但库里零 claims：T1 落盘非原子的残局");
  assert.equal(s.pages.find((p) => p.slug === "p4").inconsistent, false, "没 T1 段也没 claims 是正常骨架页");
});

test("summarizeClaims：diff 为 null（算不出来）时一条都不判，交回执 honesty 给调用方", () => {
  const claims = [{ id: 1, statement: "A", sourcePath: "src/a.js", startLine: 1, endLine: 1, pageSlug: "p1" }];
  const s = summarizeClaims(claims, null, { pages: [{ slug: "p1", title: "P1", hasT1: true }] });
  assert.equal(s.totals.atRiskClaims, 0, "不能把「没算」说成「有风险」");
  assert.equal(s.totals.claims, 1);
});

test("diffSince：基线非法 / 不是 git 目录 / 真 diff 三态分开", () => {
  const bad = diffSince(tmpdir(), "not-a-sha", "abc1234");
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "baseline-unreadable");

  const root = mkdtempSync(join(tmpdir(), "choro-claims-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.js"), "export const a = 1;\n", "utf8");
    // 还没 git init：必须如实报算不出来，不许返回空 diff 冒充「没变」。
    const notRepo = diffSince(root, "0123456", "0123456");
    assert.equal(notRepo.ok, false);
    assert.equal(notRepo.reason, "diff-failed");

    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init", "--no-gpg-sign"], { cwd: root, stdio: "pipe" });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    writeFileSync(join(root, "src", "a.js"), "export const a = 1;\nexport const b = 2;\n", "utf8");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-am", "more", "--no-gpg-sign"], { cwd: root, stdio: "pipe" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

    const ok = diffSince(root, base, head);
    assert.equal(ok.ok, true);
    const [c] = assessClaims([{ id: 1, statement: "A", sourcePath: "src/a.js", startLine: 2, endLine: 2, pageSlug: "p" }], ok);
    assert.equal(c.reason, "shifted", "第 1 行后追加一行 → 第 2 行结论行号后移");
    assert.equal(c.shift, 1);
  } finally {
    for (let i = 0; i < 5; i++) {
      try { rmSync(root, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); }
    }
  }
});
