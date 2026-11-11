// choro_* 五表的存储层回归锁（实现计划 P2/P7；spec §5）。
// 锁三件事：新库/空库文件打开即建表（幂等迁移面）、整仓替换跑两遍行数不翻倍
// （「重跑必须幂等」红线 5 的库侧语义）、唯一索引真实生效（登记表按 realpath 收敛）。
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createStore } from "../src/store.js";

const CHORO_TABLES = ["choro_repos", "choro_modules", "choro_pages", "choro_claims", "choro_vectors"];

// Windows 上 %TEMP% 里刚写完的文件会被 Defender 短暂持锁，rmSync 撞 EPERM 是
// 瞬时抖动不是用例失败（最小复现：同场景单独跑必过）。清理重试 2s，还不行就
// 记警告交给系统临时目录清理——清理不在被测范围里，别让它把绿用例标红。
async function rmTempEventually(dir) {
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === 9) console.warn(`[wiki-store.test] 临时目录清理未完成（${err.code}），留给系统清理：${dir}`);
      await sleep(200);
    }
  }
}

function openMemory() {
  return createStore(":memory:");
}

test("新库打开即建五张 choro 表", () => {
  const store = openMemory();
  for (const table of CHORO_TABLES) {
    const row = store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(table);
    assert.ok(row, `${table} 存在`);
  }
  store.close();
});

test("已存在的空 db 文件（旧库形态）打开后同样补齐表（CREATE IF NOT EXISTS 幂等）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "choro-store-"));
  try {
    const dbPath = join(dir, "memory.db");
    // 空库文件（零表）：存量库升级的最简形态。刻意不造「只有 memories 一张裸表」
    // 的夹具——那不是任何发布版本的真实旧库，且 SCHEMA 的 memories 索引会因缺列
    // 拒绝打开（真实旧库带全列，不存在这条路）。
    const legacy = new DatabaseSync(dbPath);
    legacy.close();
    const store = createStore(dbPath);
    for (const table of CHORO_TABLES) {
      const row = store.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
      ).get(table);
      assert.ok(row, `存量库升级后 ${table} 存在`);
    }
    store.close();
  } finally {
    // 清理放在 finally 但不允许它遮蔽 try 里的真错（EPERM 时真错优先）。
    await rmTempEventually(dir);
  }
});

test("登记表 upsert：同名 realpath 只一行，plan/baseline 随最后一次成功 run 走", () => {
  const store = openMemory();
  const t1 = "2026-11-05T10:00:00.000Z";
  const t2 = "2026-11-05T11:00:00.000Z";
  const first = store.upsertChoroRepo("/r/mneme", "mneme", "fp1", "aaa", t1);
  assert.ok(first.created_at === t1);
  const second = store.upsertChoroRepo("/r/mneme", "mneme", "fp2", "bbb", t2);
  assert.equal(second.id, first.id, "同一 root_path 是同一行");
  assert.equal(second.created_at, t1, "created_at 只在首次插入时落");
  assert.equal(second.plan_fingerprint, "fp2");
  assert.equal(second.git_baseline, "bbb");
  const rows = store.db.prepare("SELECT COUNT(*) AS c FROM choro_repos").get();
  assert.equal(rows.c, 1);
  store.close();
});

test("整仓替换跑两遍行数不翻倍（重跑幂等，红线 5 的库侧）", () => {
  const store = openMemory();
  const repo = store.upsertChoroRepo("/r/x", "x", "fp", "base", "2026-11-05T10:00:00.000Z");
  const snapshot = {
    updatedAt: "2026-11-05T10:00:00.000Z",
    modules: [
      { slug: "src", title: "src", parentSlug: null, fileCount: 2, fingerprint: "f1" },
      { slug: "lib", title: "lib", parentSlug: null, fileCount: 1, fingerprint: "f2" },
    ],
    pages: [
      { moduleSlug: "src", relPath: ".chorography/modules/src.md", status: "skeleton", gitBaseline: "base", templateVersion: "1", generatedAt: "t", humanBlockCount: 1, claims: [] },
      { moduleSlug: "lib", relPath: ".chorography/modules/lib.md", status: "skeleton", gitBaseline: "base", templateVersion: "1", generatedAt: "t", humanBlockCount: 0, claims: [] },
    ],
  };
  store.replaceChoroGraph(repo.id, snapshot);
  store.replaceChoroGraph(repo.id, snapshot); // 重跑同一划分
  assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM choro_modules").get().c, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM choro_pages").get().c, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM choro_claims").get().c, 0);
  store.close();
});

test("划分变化不留孤儿行：旧模块的页面随模块一起被替换掉", () => {
  const store = openMemory();
  const repo = store.upsertChoroRepo("/r/y", "y", "fp", "base", "2026-11-05T10:00:00.000Z");
  const t = "2026-11-05T10:00:00.000Z";
  store.replaceChoroGraph(repo.id, {
    updatedAt: t,
    modules: [{ slug: "old-mod", title: "旧", parentSlug: null, fileCount: 1, fingerprint: "a" }],
    pages: [{ moduleSlug: "old-mod", relPath: ".chorography/modules/old-mod.md", status: "skeleton", gitBaseline: "base", templateVersion: "1", generatedAt: t, humanBlockCount: 0, claims: [] }],
  });
  store.replaceChoroGraph(repo.id, {
    updatedAt: t,
    modules: [{ slug: "new-mod", title: "新", parentSlug: null, fileCount: 1, fingerprint: "b" }],
    pages: [{ moduleSlug: "new-mod", relPath: ".chorography/modules/new-mod.md", status: "skeleton", gitBaseline: "base", templateVersion: "1", generatedAt: t, humanBlockCount: 0, claims: [] }],
  });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM choro_modules").get().c, 1);
  const slug = store.db.prepare("SELECT slug FROM choro_modules").get().slug;
  assert.equal(slug, "new-mod");
  const orphanPages = store.db.prepare(
    "SELECT COUNT(*) AS c FROM choro_pages WHERE module_id NOT IN (SELECT id FROM choro_modules)"
  ).get().c;
  assert.equal(orphanPages, 0, "没有指向已删模块的孤儿页");
  store.close();
});

test("父子链两段式落库：父在后也接得上（顺序无关）", () => {
  const store = openMemory();
  const repo = store.upsertChoroRepo("/r/z", "z", "fp", "base", "2026-11-05T10:00:00.000Z");
  store.replaceChoroGraph(repo.id, {
    updatedAt: "2026-11-05T10:00:00.000Z",
    modules: [
      { slug: "src-store", title: "store", parentSlug: "src", fileCount: 1, fingerprint: "a" },
      { slug: "src", title: "src", parentSlug: null, fileCount: 1, fingerprint: "b" },
    ],
    pages: [],
  });
  const rows = store.db.prepare("SELECT slug, parent_id FROM choro_modules ORDER BY slug").all();
  const bySlug = new Map(rows.map((r) => [r.slug, r.parent_id]));
  const idOf = (slug) => store.db.prepare("SELECT id FROM choro_modules WHERE slug=?").get(slug).id;
  assert.equal(bySlug.get("src-store"), idOf("src"), "子模块指向父模块行");
  assert.equal(bySlug.get("src"), null);
  store.close();
});

test("唯一索引真实生效：重复 (repo_id, slug) 撞库报 IntegrityError（本仓惯例：UNIQUE 走独立索引）", () => {
  const store = openMemory();
  const repo = store.upsertChoroRepo("/r/u", "u", "fp", "base", "2026-11-05T10:00:00.000Z");
  const t = "2026-11-05T10:00:00.000Z";
  store.replaceChoroGraph(repo.id, {
    updatedAt: t,
    modules: [{ slug: "a", title: "a", parentSlug: null, fileCount: 1, fingerprint: "a" }],
    pages: [],
  });
  assert.throws(() => {
    store.db.prepare(
      "INSERT INTO choro_modules (repo_id, slug, title, file_count, updated_at) VALUES (?, 'a', 'dup', 1, ?)"
    ).run(repo.id, t);
  }, /UNIQUE/);
  store.close();
});

test("claims 经 replaceChoroGraph 落库（M2 的路径，M0 只验形状）", () => {
  const store = openMemory();
  const repo = store.upsertChoroRepo("/r/c", "c", "fp", "base", "2026-11-05T10:00:00.000Z");
  store.replaceChoroGraph(repo.id, {
    updatedAt: "2026-11-05T10:00:00.000Z",
    modules: [{ slug: "m", title: "m", parentSlug: null, fileCount: 1, fingerprint: "a" }],
    pages: [{
      moduleSlug: "m", relPath: ".chorography/modules/m.md", status: "enriched",
      gitBaseline: "base", templateVersion: "1", generatedAt: "t", humanBlockCount: 0,
      claims: [{
        statement: "store.js 是唯一的手写 schema 位置",
        kind: "architecture",
        sourcePath: "src/store.js",
        startLine: 25,
        endLine: 30,
        confidence: "high",
      }],
    }],
  });
  const claim = store.db.prepare("SELECT statement, kind, source_path, start_line FROM choro_claims").get();
  assert.equal(claim.kind, "architecture");
  assert.equal(claim.source_path, "src/store.js");
  assert.equal(claim.start_line, 25);
  store.close();
});

// ---- #581 可移植身份：迁移、位置表、跨端收敛 ----

test("旧库形态补 choro_repos.portable_key 列与 choro_repo_paths 表，重开幂等（#581）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "choro-legacy-"));
  const dbPath = join(dir, "memory.db");
  try {
    // 手工建 0.14.x 形态（无 portable_key、无位置表）+ 一行存量登记
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE choro_repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, root_path TEXT NOT NULL, name TEXT NOT NULL,
      plan_fingerprint TEXT, git_baseline TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    legacy.exec("CREATE UNIQUE INDEX idx_choro_repos_root ON choro_repos(root_path)");
    legacy.prepare("INSERT INTO choro_repos (root_path, name, created_at, updated_at) VALUES (?,?,?,?)")
      .run("D:\legacy\repo", "legacy", "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
    legacy.close();

    const store = createStore(dbPath);
    const cols = store.db.prepare("PRAGMA table_info(choro_repos)").all().map((c) => c.name);
    assert.ok(cols.includes("portable_key"), "portable_key 列补齐");
    assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='choro_repo_paths'").get(),
      "位置表补建（CREATE IF NOT EXISTS 走 SCHEMA）");
    // 存量行的键留 NULL：remote 拿不到就是拿不到，不猜（防「编一个看起来能匹配的键」）
    assert.equal(store.db.prepare("SELECT portable_key FROM choro_repos").get().portable_key, null);
    store.close();
    // 幂等：重开不重复加列、不动已落盘的行
    const again = createStore(dbPath);
    assert.equal(again.db.prepare("PRAGMA table_info(choro_repos)").all().filter((c) => c.name === "portable_key").length, 1);
    assert.equal(again.db.prepare("SELECT COUNT(*) AS n FROM choro_repos").get().n, 1);
    again.close();
  } finally {
    await rmTempEventually(dir);
  }
});

test("位置表 upsert：同身份同机一行覆写，跨机各一行；空键不查不抛（#581）", () => {
  const store = openMemory();
  store.upsertChoroRepoPath("github.com/x/y", "hostA", "D:\\repo", "2026-11-10T00:00:00.000Z");
  store.upsertChoroRepoPath("github.com/x/y", "hostB", "/Volumes/repo", "2026-11-10T00:00:00.000Z");
  store.upsertChoroRepoPath("github.com/x/y", "hostA", "E:\\repo2", "2026-11-11T00:00:00.000Z");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM choro_repo_paths").get().n, 2, "同键同机只一行");
  assert.equal(store.choroRepoPathFor("github.com/x/y", "hostA").root_path, "E:\\repo2", "同机覆写取最近");
  assert.equal(store.choroRepoPathFor("github.com/x/y", "hostA").last_seen_at, "2026-11-11T00:00:00.000Z");
  assert.equal(store.choroRepoPathFor("github.com/x/y", "hostB").root_path, "/Volumes/repo");
  assert.equal(store.choroRepoPathFor("github.com/x/y", "hostC"), null);
  assert.equal(store.choroRepoPathFor(null, "hostA"), null, "空键返回 null 而不是抛");
  store.close();
});

test("upsertChoroRepo：同一 portable_key 跨端登记收敛同一行（#581）", () => {
  const store = openMemory();
  const r1 = store.upsertChoroRepo("D:\\repo", "x", null, "aa11", "2026-11-10T00:00:00.000Z", "github.com/x/y");
  store.upsertChoroRepoPath("github.com/x/y", "hostA", "D:\\repo", "2026-11-10T00:00:00.000Z");
  // 另一台机器登记同一仓库（不同 root）：收敛到同一行（身份行），root_path 更新
  // 为「最近一次登记的位置」——单机库永远只有一台机器在登记，看不到这个变化。
  const r2 = store.upsertChoroRepo("/Volumes/repo", "x", null, "bb22", "2026-11-11T00:00:00.000Z", "github.com/x/y");
  assert.equal(r2.id, r1.id, "同一身份一行");
  assert.equal(r2.root_path, "/Volumes/repo");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM choro_repos").get().n, 1);
  // created_at 不被跨端登记改写（首次插入时刻的语义保留）
  assert.equal(store.db.prepare("SELECT created_at FROM choro_repos").get().created_at, "2026-11-10T00:00:00.000Z");
  store.close();
});

test("upsertChoroRepo：升格期 root 被别的行占着时不强改 root（否则撞 UNIQUE 直接抛）（#581）", () => {
  const store = openMemory();
  // 升级前跨端登记出的重复行现场：Windows 行（占 D:\repo，键 NULL）+ Mac 行（占
  // /Volumes/repo，键已补）。此时 Windows 机器带着键 X 来登记 D:\repo——
  // byKey 命中 Mac 行，若强行把它的 root 改成 D:\repo 就撞 idx_choro_repos_root。
  store.upsertChoroRepo("D:\\repo", "x", null, "aa11", "2026-11-09T00:00:00.000Z", null);
  store.upsertChoroRepo("/Volumes/repo", "x", null, "bb22", "2026-11-10T00:00:00.000Z", "github.com/x/y");
  const r = store.upsertChoroRepo("D:\\repo", "x", null, "cc33", "2026-11-11T00:00:00.000Z", "github.com/x/y");
  assert.equal(r.root_path, "/Volumes/repo", "root 被占时保留本行原值，位置走位置表");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM choro_repos").get().n, 2, "重复行不合并（页面挂在 repo_id 上）");
  // 位置行的写入是调用方（t0/t1）的职责——upsert 之后照契约落一行，读侧才解析得到。
  store.upsertChoroRepoPath("github.com/x/y", "hostA", "D:\\repo", "2026-11-11T00:00:00.000Z");
  assert.equal(store.choroRepoPathFor("github.com/x/y", "hostA")?.root_path, "D:\\repo", "本机位置照记");
  store.close();
});
