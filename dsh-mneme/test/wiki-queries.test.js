// queries.js 的回归锁（M1 读侧）。全部用例走真实 T0（fixture 仓库 apply）建数据，
// 不手插 DB 行——读侧的契约是「DB 索引 × 磁盘真源」的对账，手插行测不出盘上缺页
// 这类真实故障。锁的点：slug 白名单解析（查不到返回 null，绝不拿用户输入拼路径）、
// 盘上缺页如实报 page-missing、检索分节与行号、repo 解析的歧义处理。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runChoroT0 } from "../src/wiki/t0.js";
import { createStore } from "../src/store.js";
import { createChoroQueries } from "../src/wiki/queries.js";

const FIXED_NOW = () => "2026-11-05T00:00:00.000Z";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "choro-queries-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "qfix", scripts: { test: "node --test" } }, null, 2) + "\n", "utf8");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.js"), 'import { b } from "./b.js";\nimport h from "left-pad";\nexport const a = () => b();\n', "utf8");
  writeFileSync(join(root, "src", "b.js"), 'import { b2 } from "./b2.js";\nexport const b = () => b2();\n', "utf8");
  writeFileSync(join(root, "src", "b2.js"), "export const b2 = () => 1;\n", "utf8");
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init", "--no-gpg-sign"], { cwd: root, stdio: "pipe" });
  return root;
}

function rmTempBestEffort(dir) {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  console.warn(`[wiki-queries.test] 临时目录清理未完成：${dir}`);
}

function setup() {
  const root = makeFixture();
  const store = createStore(":memory:");
  runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW });
  return { root, store, q: createChoroQueries({ store }) };
}

test("listRepos / resolveRepo：单仓自动收敛，多仓歧义要显式给键", () => {
  const { root, store, q } = setup();
  try {
    const repos = q.listRepos();
    assert.equal(repos.length, 1);
    assert.equal(repos[0].module_count, 2, "src 与 root 两个模块（1 条跨模块边不触发合并）");
    assert.equal(repos[0].page_count, 2);
    const auto = q.resolveRepo(undefined);
    assert.equal(auto.id, repos[0].id, "只有一个仓库时不带键也能解析");
    assert.ok(q.resolveRepo("qfix").id, "按显示名解析");
    assert.equal(q.resolveRepo("no-such-repo"), null);
    // 造第二个仓库让解析变歧义
    const root2 = makeFixture();
    try {
      runChoroT0({ repoRoot: root2, store, apply: true, now: FIXED_NOW });
      const amb = q.resolveRepo(undefined);
      assert.ok(amb.ambiguous, "多仓无键 → 歧义清单而不是猜一个");
      assert.equal(amb.ambiguous.length, 2);
    } finally {
      rmTempBestEffort(root2);
    }
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("moduleMap：模块、页面状态与跨模块边同源返回", () => {
  const { root, store, q } = setup();
  try {
    const repo = q.resolveRepo(undefined);
    const { modules, edges } = q.moduleMap(repo.id);
    const slugs = modules.map((m) => m.slug).sort();
    assert.deepEqual(slugs, ["root", "src"]);
    const src = modules.find((m) => m.slug === "src");
    assert.equal(src.page_status, "skeleton");
    // fixture 的引用全在 src 模块内部（a→b→b2），left-pad 是外部依赖，root 只有
    // package.json 没有代码——跨模块边应为空集。跨模块聚erge本身由 wiki-store 的
    // 整仓替换用例与 t0 的 moduleEdges 排序覆盖。
    assert.deepEqual(edges, []);
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("readPage：正文来自磁盘真源；盘上缺页如实报 page-missing；未知 slug 返回 null", () => {
  const { root, store, q } = setup();
  try {
    const repo = q.resolveRepo(undefined);
    const page = q.readPage(repo.id, "src");
    assert.equal(page.slug, "src");
    assert.ok(page.content.includes("## 文件清单"), "正文是骨架页");
    assert.equal(page.content.split("\n").length > 10, true);
    assert.equal(q.readPage(repo.id, "../../etc/passwd"), null, "未知 slug 一律 null（路径零用户输入）");
    // 盘上删页：索引还在、读侧如实报缺
    unlinkSync(join(root, ".chorography", "modules", "src.md"));
    const missing = q.readPage(repo.id, "src");
    assert.equal(missing.error, "page-missing");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("search：按节返回命中与行号，空 q 返回空数组，module 过滤生效", () => {
  const { root, store, q } = setup();
  try {
    const repo = q.resolveRepo(undefined);
    // 骨架页里必有「文件清单」节标题与 b2.js 文件名
    const hits = q.search(repo.id, "文件清单");
    assert.ok(hits.length >= 2, "两页都有文件清单节");
    assert.ok(hits.every((h) => h.line >= 1 && typeof h.section === "string"));
    const byFile = q.search(repo.id, "b2.js");
    // 命中两处是契约而非巧合：frontmatter 的 sourceFiles（节=页首）+ 正文「文件
    // 清单」表。分节让调用方能区分这两层。
    assert.equal(byFile.length, 2);
    assert.ok(byFile.every((h) => h.slug === "src"), "b2.js 只属于 src 页");
    assert.equal(byFile.filter((h) => h.section.startsWith("文件清单")).length, 1, "节名带数量后缀（文件清单（N 个）），按前缀匹配");
    assert.deepEqual(q.search(repo.id, "  "), [], "空 q 不报错返回空");
    const inRoot = q.search(repo.id, "package.json", { moduleSlug: "root" });
    assert.equal(inRoot.length, 2, "与 b2.js 同款两层命中：frontmatter（页首）+ 文件清单表");
    assert.equal(inRoot[0].slug, "root");
    assert.deepEqual(q.search(repo.id, "package.json", { moduleSlug: "src" }), [], "模块过滤真生效");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});
test("repoByCwd：祖先前缀命中、最长 root 胜出、cwd 不存在返回 null", () => {
  const { root, store, q } = setup();
  let nested = null;
  try {
    // 精确根目录
    const exact = q.repoByCwd(root);
    assert.ok(exact, "仓库根命中");
    // 子目录也要命中——真实会话的 cwd 常常是 D:/repo/src 这种
    const sub = q.repoByCwd(join(root, "src"));
    assert.equal(sub.id, exact.id, "子目录按祖先前缀命中同一个仓库");
    assert.equal(q.repoByCwd(join(root, "no-such-dir")), null, "cwd 不存在 → null（不是抛错，注入在热路径上）");
    assert.equal(q.repoByCwd(""), null);
    assert.equal(q.repoByCwd(null), null);
    // 嵌套仓库：外层先登记，内层后登记 → 内层会话必须被内层抢走（最长前缀）
    nested = makeFixture();
    runChoroT0({ repoRoot: nested, store, apply: true, now: FIXED_NOW });
    const inner = q.repoByCwd(join(nested, "src"));
    assert.equal(inner.root_path, nested, "嵌套时取最深那层，否则内层会话被外层仓库抢走");
    assert.equal(q.repoByCwd(root).root_path, root, "外层 cwd 仍落外层");
  } finally {
    store.close();
    if (nested) rmTempBestEffort(nested);
    rmTempBestEffort(root);
  }
});

test("outline：模块名 + 文件数 + 页状态 + 页相对路径，不读正文", () => {
  const { root, store, q } = setup();
  try {
    const repo = q.resolveRepo(undefined);
    const out = q.outline(repo.id);
    assert.equal(out.repo.id, repo.id);
    assert.equal(out.repo.name, "qfix");
    assert.equal(out.modules.length, 2);
    const srcMod = out.modules.find((m) => m.slug === "src");
    assert.equal(srcMod.status, "skeleton");
    assert.equal(srcMod.relPath, ".chorography/modules/src.md");
    assert.ok(srcMod.fileCount >= 3);
    assert.equal(srcMod.parentSlug, null);
    assert.ok(out.generatedAt, "生成时间由页行的 generated_at 汇总");
    // 「只注标题级」的机制锁：提纲里不许出现页正文片段（骨架页的节标题/说明行）
    const serialized = JSON.stringify(out);
    assert.equal(serialized.includes("## 文件清单"), false, "提纲不含正文节标题");
    assert.equal(serialized.includes("确定性骨架"), false, "提纲不含页内说明行");
    assert.equal(q.outline(9999), null, "未知 repo → null");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});
