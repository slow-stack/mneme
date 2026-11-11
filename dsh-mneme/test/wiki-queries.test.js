// queries.js 的回归锁（M1 读侧）。全部用例走真实 T0（fixture 仓库 apply）建数据，
// 不手插 DB 行——读侧的契约是「DB 索引 × 磁盘真源」的对账，手插行测不出盘上缺页
// 这类真实故障。锁的点：slug 白名单解析（查不到返回 null，绝不拿用户输入拼路径）、
// 盘上缺页如实报 page-missing、检索分节与行号、repo 解析的歧义处理。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runChoroT0 } from "../src/wiki/t0.js";
import { createStore } from "../src/store.js";
import { createChoroQueries } from "../src/wiki/queries.js";

const FIXED_NOW = () => "2026-11-05T00:00:00.000Z";

// mark：往文件里掺一个区分串。#581 之后无 remote 的仓库按根提交哈希作身份键，
// 同一秒提交的两个内容相同的夹具会算出同一个哈希——真仓库不会（同内容 + 同秒
// 的概率趋零），但测试里往同一个库登记两个夹具的用例必须显式区分开。
function makeFixture(mark = "") {
  const root = mkdtempSync(join(tmpdir(), "choro-queries-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "qfix", scripts: { test: "node --test" } }, null, 2) + "\n", "utf8");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.js"), 'import { b } from "./b.js";\nimport h from "left-pad";\nexport const a = () => b();\n', "utf8");
  writeFileSync(join(root, "src", "b.js"), 'import { b2 } from "./b2.js";\nexport const b = () => b2();\n', "utf8");
  writeFileSync(join(root, "src", "b2.js"), "export const b2 = () => 1;\n" + mark, "utf8");
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

// stub embedder：文本含 "src" → [1,0]，否则 [0,1]（固定二维，可断言方向与失配）
function stubEmbedder(model = "stub-1") {
  return {
    model,
    embedSingle: async (text) => (/src/.test(text) ? [1, 0] : [0, 1]),
    embed: async (text) => (/src/.test(text) ? [1, 0] : [0, 1]),
  };
}

// --- 收尾档 P37–P39：向量惰性物化与检索 -------------------------------------

test("embedPageVectors：首次全嵌，generated_at 没变就跳过，变了重嵌（staleness 两维之一）", async () => {
  const { root, store, q } = setup();
  try {
    const repo = q.resolveRepo(undefined);
    const emb = stubEmbedder();
    const r1 = await q.embedPageVectors(repo.id, emb);
    assert.equal(r1.embedded, 2, "两页全嵌");
    const r2 = await q.embedPageVectors(repo.id, emb);
    assert.equal(r2.embedded, 0);
    assert.equal(r2.skipped, 2, "generated_at 没变 → 全跳过");
    // 页面内容变了（generated_at 推进）→ 只重嵌变的那页
    const pagePath = join(root, ".chorography", "modules", "src.md");
    const before = readFileSync(pagePath, "utf8");
    writeFileSync(pagePath, `${before}<!-- CHORO:HUMAN:START -->\n人工补充\n<!-- CHORO:HUMAN:END -->\n`, "utf8");
    store.db.prepare(
      "UPDATE choro_pages SET generated_at = ? WHERE generated_at IS NOT NULL AND id IN (SELECT p.id FROM choro_pages p JOIN choro_modules m ON p.module_id = m.id WHERE m.slug = 'src')"
    ).run("2026-11-06T00:00:00.000Z");
    const r3 = await q.embedPageVectors(repo.id, emb);
    assert.equal(r3.embedded, 1, "只有 src 页重嵌");
    assert.equal(r3.stale, 1, "旧向量按 stale 记账");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("dim 失配（换 embedder 模型）→ 惰性全量重嵌（P38：不锁死，代价只是几十页）", async () => {
  const { root, store, q } = setup();
  try {
    const repo = q.resolveRepo(undefined);
    await q.embedPageVectors(repo.id, stubEmbedder("stub-1"));
    // 换模型：维度从 2 → 3。expectDim 来自查询向量（路由先嵌查询再物化）
    const emb3 = {
      model: "stub-2",
      embedSingle: async () => [1, 0, 0],
      embed: async () => [1, 0, 0],
    };
    const r = await q.embedPageVectors(repo.id, emb3, { expectDim: 3 });
    assert.equal(r.embedded, 2, "维度变了 → 全部重嵌（fresh 检查被 dimDrift 压过）");
    assert.equal(r.dimMismatch, true, "失配被记账");
    const rows = store.getChoroPageVectors(repo.id);
    assert.ok(rows.every((row) => row.dim === 3 && row.model === "stub-2"), "旧维度行不复存");
    // 不给 expectDim（无查询场景）→ fresh 行照旧跳过
    const r2 = await q.embedPageVectors(repo.id, emb3);
    assert.equal(r2.embedded, 0);
    assert.equal(r2.skipped, 2);
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("searchSemantic：cosine 排序 + dim 失配行被过滤 + embedder 缺席返回 null", async () => {
  const { root, store, q } = setup();
  try {
    const repo = q.resolveRepo(undefined);
    await q.embedPageVectors(repo.id, stubEmbedder("stub-1"));
    const hits = await q.searchSemantic(repo.id, stubEmbedder("stub-1"), "src 相关的页");
    assert.ok(Array.isArray(hits) && hits.length >= 1);
    assert.equal(hits[0].slug, "src", "查询向量 [1,0] 与 src 页同向 → 排前");
    // 查询向量三维：与所有行 dim 失配 → 无可比行，返回空数组而不是抛
    const dim3 = { embedSingle: async () => [1, 0, 0], embed: async () => [1, 0, 0] };
    const empty = await q.searchSemantic(repo.id, dim3, "x");
    assert.deepEqual(empty, []);
    assert.equal(await q.searchSemantic(repo.id, null, "x"), null);
    assert.deepEqual(await q.searchSemantic(repo.id, stubEmbedder(), "  "), [], "空查询不嵌入、返回空数组");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

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
    // 造第二个仓库让解析变歧义（mark 区分：无 remote 夹具按根提交哈希作键，
    // 同一秒提交的相同内容会同键收敛成一行，歧义就造不出来了）
    const root2 = makeFixture("second-repo-mark");
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
    // 面板从地志页导入知识点时读的是 mod.relPath（契约 §3.6）；SQL 行里只有
    // page_rel_path，缺这层映射会让「选完模块点导入」永远提示请先选模块（#607）。
    // 同时锁住原 snake_case 字段还在——choro_module_map 的 render 与 CLI 都在用。
    assert.equal(typeof src.relPath, "string", "relPath 必须与 page_rel_path 同值");
    assert.equal(src.relPath, src.page_rel_path);
    assert.ok(src.relPath.endsWith(".md"), "页相对路径是磁盘上真实存在的 .md");
    assert.equal(typeof src.file_count, "number", "file_count 原字段必须保留（choro_module_map 的 render 在吃）");
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
    nested = makeFixture("inner-repo-mark");
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
// --- claim 粒度失效（Grounded Claims）:DB 索引 × git diff 的对账 --------------

test("claimDrift：基线 == HEAD 说 clean:true，改了锚点所在行 → 只有那页那条进 atRisk", () => {
  const { root, store, q } = setup();
  try {
    const repo = q.resolveRepo(undefined);
    const page = store.choroPageBySlug(repo.id, "src");
    store.saveChoroPageClaims(page.id, [
      { statement: "a 依赖 b", kind: "architecture", sourcePath: "src/a.js", startLine: 3, endLine: 3, createdAt: FIXED_NOW() },
      { statement: "b2 只是常量", kind: "architecture", sourcePath: "src/b2.js", startLine: 1, endLine: 1, createdAt: FIXED_NOW() },
    ]);

    const same = q.claimDrift(repo.id);
    assert.equal(same.clean, true, "基线就是 HEAD：确实没变，可以说没事");
    assert.equal(same.anchorStale, false);
    assert.equal(same.totals.claims, 2);
    assert.equal(same.totals.atRiskClaims, 0);

    // 改掉 a.js 第 3 行（claim 的锚点）并提交 → 基线落后 HEAD。
    writeFileSync(join(root, "src", "a.js"), 'import { b } from "./b.js";\nimport h from "left-pad";\nexport const a = () => b() + 1;\n', "utf8");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-am", "change a", "--no-gpg-sign"], { cwd: root, stdio: "pipe" });

    const drift = q.claimDrift(repo.id);
    assert.equal(drift.clean, false);
    assert.notEqual(drift.baseline, drift.head, "基线落后了");
    assert.equal(drift.totals.claims, 2);
    assert.equal(drift.totals.atRiskClaims, 1, "只有锚在 a.js 第 3 行那条受影响");
    const pageRisk = drift.pages.find((p) => p.slug === "src");
    assert.equal(pageRisk.atRisk.length, 1);
    assert.equal(pageRisk.atRisk[0].reason, "touched");
    assert.equal(pageRisk.atRisk[0].sourcePath, "src/a.js");
    // 排序契约：有风险的页排最前（面板直接顺着读，不再排一遍）。
    assert.equal(drift.pages[0].slug, "src");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("claimDrift：基线认不出时说 anchorStale，不说「都还准」也不说「全失效」", () => {
  const { root, store, q } = setup();
  try {
    const repo = q.resolveRepo(undefined);
    // force-push / 浅克隆的形态：基线 sha 合法但对象不在库里的任何一棵树上。
    store.db.prepare("UPDATE choro_repos SET git_baseline = ? WHERE id = ?").run("0123456789abcdef0123456789abcdef01234567", repo.id);
    const drift = q.claimDrift(repo.id);
    assert.equal(drift.clean, false);
    assert.equal(drift.anchorStale, true);
    assert.equal(drift.reason, "diff-failed");
    assert.equal(drift.totals.atRiskClaims, 0, "算不出来不等于有风险——一条都不许判");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("claimDrift：验证过却没记下基线（verified_at 有、verified_baseline 空）→ 判不了，不回退全仓基线", () => {
  const { root, store, q } = setup();
  try {
    const repo = q.resolveRepo(undefined);
    const page = store.choroPageBySlug(repo.id, "src");
    store.saveChoroPageClaims(page.id, [
      { statement: "a 依赖 b", kind: "architecture", sourcePath: "src/a.js", startLine: 3, endLine: 3, createdAt: FIXED_NOW() },
    ]);
    // 后半段的验证没留下凭据：T1 写了 verified_at，却没写 verified_baseline。
    store.db.prepare("UPDATE choro_pages SET verified_at = ?, verified_baseline = NULL WHERE id = ?").run(FIXED_NOW(), page.id);

    const drift = q.claimDrift(repo.id);
    const p = drift.pages.find((x) => x.slug === "src");
    // 退到全仓基线会把「富化之后才发生」的改动当成「富化之前就有」而放过——漏报。
    // 不知道起点就不装作知道：diffBaseline 必须为 null，且这一页判 baselineUnknown。
    assert.equal(p.diffBaseline, null, "没有验证点就不许回退全仓基线");
    assert.equal(p.baselineApprox, false, "这不是「老数据退而求其次」，别标成约等于");
    assert.equal(p.baselineUnknown, true);
    assert.equal(drift.totals.baselineUnknownPages, 1);
    // 基线 == HEAD 时 clean 仍可为真：一条提交都没发生过，锚点不可能被碰到，
    // 「验证点没记下」在这里不影响结论（影响的是「变了之后能不能判」）。
    assert.equal(drift.clean, true, "没变就是没变，不必因为起点没记下而说不知道");

    // 有提交之后就不一样了：起点认不出的页不许被那些提交的改动「顺带放过」。
    writeFileSync(join(root, "src", "a.js"), 'import { b } from "./b.js";\nexport const a = () => b() + 1;\n', "utf8");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-am", "change a", "--no-gpg-sign"], { cwd: root, stdio: "pipe" });
    const after = q.claimDrift(repo.id);
    assert.equal(after.clean, false, "有判不了的页，就不能说干净");
    assert.equal(after.totals.baselineUnknownPages, 1);
    assert.equal(after.totals.atRiskClaims, 0, "判不了不等于有风险，一条都不许判");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("claimDrift：repoAtHead 也不能掩盖 inconsistentPages（有语义段却没 claims 的页）", () => {
  const { root, store, q } = setup();
  try {
    const repo = q.resolveRepo(undefined);
    // 造一次「T1 落盘不完整」：页里有语义段，库里一条 claims 都没有。
    // 仓库基线仍等于 HEAD，旧实现在这里会短路成 clean:true——把残局说成没事。
    const pagePath = join(root, ".chorography", "modules", "src.md");
    writeFileSync(pagePath, readFileSync(pagePath, "utf8") + "\n<!-- CHORO:T1:START -->\n## 架构\n\na.js 是入口。\n<!-- CHORO:T1:END -->\n", "utf8");

    const drift = q.claimDrift(repo.id);
    assert.equal(drift.baseline, drift.head, "前提：仓库基线就是 HEAD（走短路分支）");
    assert.equal(drift.totals.inconsistentPages, 1, "有语义段、零 claims 的页要被数出来");
    assert.equal(drift.totals.atRiskClaims, 0, "它一条结论都没有，谈不上有风险");
    assert.equal(drift.clean, false, "残局不许被说成「全部干净」");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("claimDrift：未知仓库返回 null（调用方据此 404，不是空清单）", () => {
  const { root, store, q } = setup();
  try {
    assert.equal(q.claimDrift(999999), null);
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

// ---- #581 本机路径解析：身份行 vs 位置行 ----

test("共享库跨端：读侧按当前 host 的位置行解析本机根，未登记的机器回退身份行（#581）", () => {
  const root = makeFixture();
  // T0 前挂 remote：身份键从 URL 归一化，两台机器的同一仓库算出同一个键
  execFileSync("git", ["remote", "add", "origin", "git@github.com:slow-stack/demo.git"], { cwd: root, stdio: "pipe" });
  const store = createStore(":memory:");
  try {
    runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW });
    const row = store.db.prepare("SELECT id, root_path, portable_key FROM choro_repos").get();
    assert.equal(row.portable_key, "github.com/slow-stack/demo", "T0 登记时把身份键算出来落库");
    // 另一台机器（hostB）共享这个库，并在本机路径登记过自己的一份工作副本
    store.upsertChoroRepoPath(row.portable_key, "hostB", "/Volumes/demo", FIXED_NOW());
    const qB = createChoroQueries({ store, hostId: () => "hostB" });
    const factsB = qB.repoFromRow(store.db.prepare("SELECT * FROM choro_repos WHERE id = ?").get(row.id));
    assert.equal(factsB.rootPath, "/Volumes/demo", "hostB 解析到自己的位置行");
    // 没登记过位置行的 hostC：回退身份行 root_path——文件访问落进既有的
    // page-missing 口径（拿不到本机路径，不能拿别的机器的路径读出错误内容）
    const qC = createChoroQueries({ store, hostId: () => "hostC" });
    const factsC = qC.repoFromRow(store.db.prepare("SELECT * FROM choro_repos WHERE id = ?").get(row.id));
    assert.equal(factsC.rootPath, row.root_path, "回退身份行的 root_path");
    // 本机（跑过 T0 的这台，默认 hostId）：行为与升级前完全一致
    const qA = createChoroQueries({ store });
    assert.equal(qA.repoFromRow(store.db.prepare("SELECT * FROM choro_repos WHERE id = ?").get(row.id)).rootPath, root);
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});
