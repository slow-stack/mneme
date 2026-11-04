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
