// T1 生成轮的回归锁（M2，实现计划 P14–P22）。runner 全部是注入的 stub——
// 单测绝不真开 headless 会话（那是 V1/手动的世界）。锁的点：
// 输出契约（坏 JSON / 编造锚点 → failed）、三重上限触发的模块级失败、
// 环境级失败整档中止（页状态不动）、失败两次标 failed 且 --retry-failed 可拉回、
// 富化写法（T1 段在「生成说明」前、CHORO:HUMAN 保留区照旧页尾回填）、
// claims 双落（表 + evidence/<slug>.json）、未登记仓库拒绝。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runChoroT0 } from "../src/wiki/t0.js";
import { createStore } from "../src/store.js";
import { createT1, T1Refusal, T1_SECTION_START, T1_SECTION_END } from "../src/wiki/t1.js";

const FIXED_NOW = () => "2026-11-05T12:00:00.000Z";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "choro-t1-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "t1fix", scripts: { test: "node --test" } }, null, 2) + "\n", "utf8");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.js"), 'import { b } from "./b.js";\nexport const a = () => b();\nexport function helper() { return 1; }\n', "utf8");
  writeFileSync(join(root, "src", "b.js"), "export const b = () => 1;\n", "utf8");
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init", "--no-gpg-sign"], { cwd: root, stdio: "pipe" });
  return root;
}

function rmTempBestEffort(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 留给系统清理 */ }
  }
}

function setup() {
  const root = makeFixture();
  const store = createStore(":memory:");
  runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW });
  return { root, store };
}

// 合法输出：两段带真实锚点、一段锚点编造给坏路径用例用
const GOOD_OUTPUT = JSON.stringify({
  architecture: "src 模块承载仓库的核心导出面，a.js 依赖 b.js。",
  convention: "导出全部用 export const 函数式风格。",
  techStack: "纯 ESM，无框架。",
  setup: "npm test。",
  claims: [
    { statement: "a.js 从 b.js 导入 b", kind: "architecture", sourcePath: "src/a.js", startLine: 1, endLine: 1 },
    { statement: "b.js 导出函数 b", kind: "tech-stack", sourcePath: "src/b.js", startLine: 1, endLine: 1 },
  ],
});

test("dry-run：只列候选与跳过，零会话零写入", async () => {
  const { root, store } = setup();
  try {
    let calls = 0;
    const t1 = createT1({ store, runSession: async () => { calls++; return { ok: true, text: GOOD_OUTPUT }; }, now: FIXED_NOW });
    const receipt = await t1.runT1({ repoRoot: root, dryRun: true });
    assert.equal(calls, 0, "dry-run 不开任何会话");
    assert.equal(receipt.dryRun, true);
    assert.equal(receipt.candidates.length, 2, "root + src 都是 skeleton");
    assert.equal(existsSync(join(root, ".chorography", "evidence")), false, "零写入");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("快乐路径：富化 + claims 双落 + 保留区照旧页尾回填", async () => {
  const { root, store } = setup();
  try {
    // stub 按章程里的 slug 出对应的输出：claims 的锚点必须落在**该模块自己的**
    // 文件清单里（root 页的清单只有 package.json）——这正是 P16 对账的真实约束。
    const t1 = createT1({
      store,
      runSession: async ({ task }) => ({
        ok: true,
        text: task.includes("slug=root")
          ? JSON.stringify({
              architecture: "仓库根只放清单与配置。", convention: "x", techStack: "x", setup: "npm test。",
              claims: [{ statement: "package.json 是包清单", kind: "setup", sourcePath: "package.json", startLine: 1, endLine: 1 }],
            })
          : GOOD_OUTPUT,
      }),
      now: FIXED_NOW,
    });
    const receipt = await t1.runT1({ repoRoot: root });
    assert.equal(receipt.enriched.length, 2);
    assert.equal(receipt.failed.length, 0);

    const page = readFileSync(join(root, ".chorography", "modules", "src.md"), "utf8");
    assert.ok(page.includes(T1_SECTION_START) && page.includes(T1_SECTION_END));
    assert.ok(page.includes("## 架构"));
    assert.ok(page.indexOf(T1_SECTION_START) < page.indexOf("## 生成说明"), "T1 段插在「生成说明」之前（P19）");
    assert.ok(page.includes("| src/a.js |"), "T0 文件清单原样保留");

    const claims = store.db.prepare(
      `SELECT c.statement, c.kind, c.source_path FROM choro_claims c
         JOIN choro_pages p ON c.page_id = p.id JOIN choro_modules m ON p.module_id = m.id
        WHERE m.slug = 'src' ORDER BY c.statement`
    ).all();
    assert.equal(claims.length, 2, "src 页两条 claims（root 页自己还有一条）");
    assert.equal(claims[0].source_path, "src/a.js");
    const evidence = JSON.parse(readFileSync(join(root, ".chorography", "evidence", "src.md".replace(".md", ".json")), "utf8"));
    assert.equal(evidence.claims.length, 2);
    const status = store.db.prepare(
      "SELECT p.status, p.generated_at FROM choro_pages p JOIN choro_modules m ON p.module_id = m.id WHERE m.slug = 'src'"
    ).get();
    assert.equal(status.status, "enriched");
    assert.equal(status.generated_at, FIXED_NOW());

    // 富化后的页再跑一次 T1：人写入保留区块后必须照旧存活（复用 M0 语义）
    const withHuman = page + "\n<!-- CHORO:HUMAN:START -->\n人写的批注\n<!-- CHORO:HUMAN:END -->\n";
    writeFileSync(join(root, ".chorography", "modules", "src.md"), withHuman, "utf8");
    await t1.runT1({ repoRoot: root, moduleSlug: "src" });
    const rePage = readFileSync(join(root, ".chorography", "modules", "src.md"), "utf8");
    assert.ok(rePage.includes("人写的批注"), "重富化不抹保留区");
    assert.ok(rePage.trimEnd().endsWith("<!-- CHORO:HUMAN:END -->"), "保留区照旧页尾回填");
    assert.equal(rePage.match(new RegExp(T1_SECTION_START.replace(/[/*]/g, (c) => "\\" + c), "g")).length, 1, "旧 T1 段被剥掉、只有一份新段");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("输出契约：坏 JSON → 失败计数；连续两次 → status=failed；--retry-failed 可拉回", async () => {
  const { root, store } = setup();
  try {
    let respond = "这不是 JSON";
    const t1 = createT1({ store, runSession: async () => ({ ok: true, text: respond }), now: FIXED_NOW });
    const r1 = await t1.runT1({ repoRoot: root, moduleSlug: "src" });
    assert.equal(r1.failed[0].failCount, 1);
    assert.equal(r1.failed[0].marked, false, "首次失败不标 failed（骨架仍是有效产物）");
    const r2 = await t1.runT1({ repoRoot: root, moduleSlug: "src" });
    assert.equal(r2.failed[0].marked, true, "连续两次到阈值");
    const st = store.db.prepare("SELECT p.status FROM choro_pages p JOIN choro_modules m ON p.module_id=m.id WHERE m.slug='src'").get();
    assert.equal(st.status, "failed");

    respond = GOOD_OUTPUT;
    const r3 = await t1.runT1({ repoRoot: root, moduleSlug: "src", retryFailed: true });
    assert.equal(r3.enriched.length, 1, "--retry-failed 把 failed 页拉回来");
    const st2 = store.db.prepare("SELECT p.status, p.fail_count FROM choro_pages p JOIN choro_modules m ON p.module_id=m.id WHERE m.slug='src'").get();
    assert.equal(st2.status, "enriched");
    assert.equal(st2.fail_count, 0, "成功清零的是连续性");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("编造锚点：claims 引用模块外文件 → 该轮 failed（正文与锚点同过同拒）", async () => {
  const { root, store } = setup();
  try {
    const fabricated = JSON.stringify({
      architecture: "x", convention: "x", techStack: "x", setup: "x",
      claims: [{ statement: "s", kind: "architecture", sourcePath: "D:/elsewhere/evil.js", startLine: 1, endLine: 1 }],
    });
    const t1 = createT1({ store, runSession: async () => ({ ok: true, text: fabricated }), now: FIXED_NOW });
    const receipt = await t1.runT1({ repoRoot: root, moduleSlug: "src" });
    assert.ok(receipt.failed[0].reason.includes("模块外"));
    const claims = store.db.prepare("SELECT COUNT(*) AS c FROM choro_claims").get().c;
    assert.equal(claims, 0, "拒绝轮不落任何 claims");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("环境级失败：整档中止、页状态不动、其余候选不跑（降级表第一行）", async () => {
  const { root, store } = setup();
  try {
    const ran = [];
    const t1 = createT1({
      store,
      runSession: async ({ task }) => {
        ran.push(task.slice(0, 20));
        return { ok: false, kind: "environment", reason: "spawn 失败：找不到 DeepSeek Harness 主程序" };
      },
      now: FIXED_NOW,
    });
    const receipt = await t1.runT1({ repoRoot: root });
    assert.ok(receipt.t1Unavailable.includes("找不到"));
    assert.equal(ran.length, 1, "第一个模块就中止");
    assert.equal(receipt.enriched.length, 0);
    const st = store.db.prepare("SELECT DISTINCT p.status FROM choro_pages p").get().status;
    assert.equal(st, "skeleton", "页状态原样（环境问题不是页的错）");
    const fails = store.db.prepare("SELECT SUM(fail_count) AS c FROM choro_pages").get().c;
    assert.equal(fails, 0, "fail_count 也不动");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("三重上限：runner 报超限 → 模块级失败路径（与坏 JSON 同一条记账）", async () => {
  const { root, store } = setup();
  try {
    const t1 = createT1({
      store,
      runSession: async () => ({ ok: false, kind: "module", reason: "工具调用超过 40 次上限" }),
      now: FIXED_NOW,
    });
    const receipt = await t1.runT1({ repoRoot: root, moduleSlug: "src" });
    assert.equal(receipt.failed.length, 1);
    assert.ok(receipt.failed[0].reason.includes("上限"));
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("未登记仓库整轮拒绝（先跑 T0）", async () => {
  const root = makeFixture();
  try {
    const store = createStore(":memory:");
    const t1 = createT1({ store, runSession: async () => ({ ok: true, text: GOOD_OUTPUT }), now: FIXED_NOW });
    await assert.rejects(
      () => t1.runT1({ repoRoot: root }),
      (err) => {
        assert.ok(err instanceof T1Refusal);
        assert.equal(err.code, "not-registered");
        return true;
      }
    );
    store.close();
  } finally {
    rmTempBestEffort(root);
  }
});
