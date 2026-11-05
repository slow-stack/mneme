// runChoroT0 的端到端回归锁。这里钉的是 spec 里最不能破的三类契约：
// 1. 红线 1（机械面）：apply 只许写 <repo>/.chorography/ —— 对整个仓库做树快照，
//    除 .chorography/** 外每一个既有文件必须逐字节不变，且不得出现 .github/、
//    AGENTS.md、.gitignore（openwiki 的两个坏习惯在这里判死）。
// 2. 可重建不变量（spec §9）：同一状态两次 apply，.chorography 全部文件逐字节相同
//    （generatedAt 沿用 state.json，实现计划 P3）。
// 3. 保留区（spec §4 混合所有权）：CHORO:HUMAN 块跨重生成逐字节存活（红线 6）。
// 另有：非 git 拒绝、dry-run 零写入、plan 未知键拒绝且零写入、白名单过滤、DB 落账幂等。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { runChoroT0, ChoroRefusal } from "../src/wiki/t0.js";
import { parseArgv } from "../bin/dsh-mneme-choro.mjs";
import { T1_SECTION_START, T1_SECTION_END } from "../src/wiki/render.js";
import { createStore } from "../src/store.js";
import { PlanInvalidError } from "../src/wiki/plan.js";

function makeFixture({ git = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "choro-t0-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "demo-repo",
    version: "0.1.0",
    scripts: { test: "node --test", build: "node build.js" },
  }, null, 2) + "\n", "utf8");
  writeFileSync(join(root, "README.md"), "# demo\n", "utf8");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "src", "a.js"), "import { b } from \"./b.js\";\nimport { helper } from \"../lib/helper.js\";\nimport fmt from \"left-pad\";\nexport const a = () => b() + fmt(1);\n", "utf8");
  writeFileSync(join(root, "src", "b.js"), "import { helper } from \"../lib/helper.js\";\nexport const b = () => helper();\n", "utf8");
  writeFileSync(join(root, "lib", "helper.js"), "export const helper = () => 1;\n", "utf8");
  if (git) {
    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init", "--no-gpg-sign"], { cwd: root, stdio: "pipe" });
  }
  return root;
}

// 整仓树快照（排除 .git 内部）：relPath -> sha1(content)；目录集合单独记。
function snapshot(root) {
  const files = new Map();
  const dirs = new Set();
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs)) {
      const absPath = join(abs, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      if (relPath === ".git") continue;
      const st = statSync(absPath);
      if (st.isDirectory()) {
        dirs.add(relPath);
        walk(absPath, relPath);
      } else {
        files.set(relPath, readFileSync(absPath, "utf8"));
      }
    }
  };
  walk(root, "");
  return { files, dirs };
}

function choroFiles(root) {
  const out = new Map();
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs)) {
      const absPath = join(abs, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      if (statSync(absPath).isDirectory()) walk(absPath, relPath);
      else out.set(relPath, readFileSync(absPath, "utf8"));
    }
  };
  walk(join(root, ".chorography"), "");
  return out;
}

// Windows 上 %TEMP% 里刚写完的文件会被 Defender 短暂持锁，rmSync 撞 EPERM 是瞬时
// 抖动。清理重试几拍，还不行就记警告交给系统清理——**清理失败不许遮蔽 try 里的
// 真错**（finally 里抛错会替换原始异常，这是调试时真撞过的坑）。
function rmTempBestEffort(dir) {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  console.warn(`[wiki-t0.test] 临时目录清理未完成，留给系统清理：${dir}`);
}

const FIXED_NOW = () => "2026-11-05T00:00:00.000Z";

test("非 git 仓库整轮拒绝（锚点无法核验，spec 降级表第一行）", () => {
  const root = makeFixture({ git: false });
  try {
    assert.throws(
      () => runChoroT0({ repoRoot: root, apply: true, now: FIXED_NOW }),
      (err) => {
        assert.ok(err instanceof ChoroRefusal);
        assert.equal(err.code, "not-git");
        return true;
      }
    );
  } finally {
    rmTempBestEffort(root);
  }
});

test("dry-run 零写入：仓库树前后逐字节相同，receipt 给出将写清单", () => {
  const root = makeFixture();
  const store = createStore(":memory:");
  try {
    const before = snapshot(root);
    const receipt = runChoroT0({ repoRoot: root, store, apply: false, now: FIXED_NOW });
    assert.equal(receipt.dryRun, true);
    assert.ok(receipt.wouldWrite.length >= 4, "至少 3 页 + index + state.json");
    assert.equal(receipt.moduleCount, 3, "root/lib/src 三个初稿组，1 条交叉边不触发合并");
    const after = snapshot(root);
    assert.deepEqual([...after.files.keys()].sort(), [...before.files.keys()].sort(), "没有新增文件");
    for (const [path, content] of before.files) assert.equal(after.files.get(path), content, `${path} 未被动过`);
    assert.equal(after.dirs.has(".chorography"), false, ".chorography 目录都没建");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("apply：只有 .chorography/** 被写入，既有文件逐字节不变，无 .github/AGENTS.md/.gitignore（红线 1 契约）", () => {
  const root = makeFixture();
  const store = createStore(":memory:");
  try {
    const before = snapshot(root);
    const receipt = runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW });
    assert.equal(receipt.dryRun, false);
    const after = snapshot(root);

    for (const [path, content] of before.files) {
      assert.equal(after.files.get(path), content, `既有文件 ${path} 被动过（红线 1）`);
    }
    const added = [...after.files.keys()].filter((p) => !before.files.has(p));
    assert.ok(added.length > 0, "有新产物");
    for (const p of added) assert.ok(p.startsWith(".chorography/"), `新增文件越界：${p}`);
    for (const forbidden of [".github", ".github/workflows/openwiki-update.yml", "AGENTS.md", ".gitignore", "openwiki"]) {
      assert.equal(after.files.has(forbidden), false, `${forbidden} 不得出现`);
      assert.equal(after.dirs.has(forbidden), false);
    }

    // 页面内容形状：frontmatter + 文件清单 + 外部依赖（left-pad 聚合在 src 模块）
    const srcPage = readFileSync(join(root, ".chorography", "modules", "src.md"), "utf8");
    assert.ok(srcPage.includes("status: skeleton"));
    assert.ok(srcPage.includes("gitBaseline: "));
    assert.ok(srcPage.includes("`left-pad`"), "外部依赖按包聚合出现在页里");
    assert.ok(srcPage.includes("src/a.js"), "文件清单在页里");
    const index = readFileSync(join(root, ".chorography", "index.md"), "utf8");
    assert.ok(index.includes("demo-repo"), "index 记仓库名");
    assert.ok(index.includes("node --test"), "脚本命令进 index");
    const state = JSON.parse(readFileSync(join(root, ".chorography", "state.json"), "utf8"));
    assert.equal(state.moduleCount, 3);
    assert.equal(state.generatedAt, FIXED_NOW());
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("可重建不变量：同状态两次 apply，.chorography 全部文件逐字节相同", () => {
  const root = makeFixture();
  const store = createStore(":memory:");
  try {
    runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW });
    const first = choroFiles(root);
    runChoroT0({ repoRoot: root, store, apply: true, now: () => "2026-11-05T09:99:99.000Z" });
    const second = choroFiles(root);
    assert.deepEqual([...second.keys()].sort(), [...first.keys()].sort());
    for (const [path, content] of first) {
      assert.equal(second.get(path), content, `${path} 两次生成不同字节`);
    }
    // generatedAt 沿用的直接证据：state.json 里还是第一次的时刻
    const state = JSON.parse(readFileSync(join(root, ".chorography", "state.json"), "utf8"));
    assert.equal(state.generatedAt, FIXED_NOW(), "state.json 未被第二次 run 推进（内容没变）");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("保留区跨重生成逐字节存活（红线 6），页尾按原相对顺序回填", () => {
  const root = makeFixture();
  const store = createStore(":memory:");
  try {
    runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW });
    const pagePath = join(root, ".chorography", "modules", "src.md");
    const original = readFileSync(pagePath, "utf8");
    const blockA = "<!-- CHORO:HUMAN:START -->\n## 为什么这么划\n\nb.js 是 a.js 的下游（人写的字，一个都不许动）。\n<!-- CHORO:HUMAN:END -->";
    const blockB = "<!-- CHORO:HUMAN:START -->\n注意：helper 的别名历史上叫 util，改回去会炸 build。\n<!-- CHORO:HUMAN:END -->";
    writeFileSync(pagePath, `${original}\n${blockA}\n\n${blockB}\n`, "utf8");

    const receipt = runChoroT0({ repoRoot: root, store, apply: true, now: () => "2026-11-06T00:00:00.000Z" });
    assert.equal(receipt.humanBlocksPreserved, 2, "receipt 点出保留块数");
    const regenerated = readFileSync(pagePath, "utf8");
    assert.ok(regenerated.includes(blockA), "块 A 原文逐字节存活");
    assert.ok(regenerated.includes(blockB), "块 B 原文逐字节存活");
    assert.ok(regenerated.indexOf(blockA) < regenerated.indexOf(blockB), "相对顺序不变");
    assert.ok(regenerated.trimEnd().endsWith(blockB), "回填在页尾（确定性位置，实现计划 P6）");
    assert.ok(regenerated.startsWith(original), "新正文在前，旧块整体后置");

    // 再跑一遍：新文件里的块再次被抽出回填，仍是同两块、顺序不变
    runChoroT0({ repoRoot: root, store, apply: true, now: () => "2026-11-07T00:00:00.000Z" });
    assert.equal(readFileSync(pagePath, "utf8"), regenerated, "第三轮生成也稳定（块不再翻倍）");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

// 重跑 T0 会把富化页退回骨架（P19：富化层不参与字节稳定不变量，重建整页丢弃重来）。
// 丢弃是设计意图，静默不是：这条锁钉的是「丢之前必须说一声」，且清点本身不动任何字节。
// 曾经的真实现场——D:/dsh-baleen 重跑 T0 --apply 后 modules/src-client.md 的 CHORO:T1
// 段消失、DB choro_claims 清空，而 .chorography/evidence/src-client.json 的 33 条 claims
// 还躺在磁盘上无人引用，全程零提示。
test("重跑 T0 覆盖已富化的页：必须先出声（t1Loss 清点 + warning），evidence 不删", () => {
  const root = makeFixture();
  const store = createStore(":memory:");
  try {
    runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW });
    const relPage = ".chorography/modules/src.md";
    const pagePath = join(root, ".chorography", "modules", "src.md");
    writeFileSync(pagePath,
      `${readFileSync(pagePath, "utf8")}\n${T1_SECTION_START}\n## 架构\n\na.js 是入口，b.js 是它的下游。\n${T1_SECTION_END}\n`,
      "utf8");
    mkdirSync(join(root, ".chorography", "evidence"), { recursive: true });
    writeFileSync(join(root, ".chorography", "evidence", "src.json"),
      JSON.stringify({ slug: "src", claims: [{ statement: "a.js 是入口", sourcePath: "src/a.js" }] }, null, 2) + "\n",
      "utf8");

    const dry = runChoroT0({ repoRoot: root, store, now: FIXED_NOW });
    assert.deepEqual(dry.t1Loss.pages, [relPage], "清点出会被退回骨架的页");
    assert.equal(dry.t1Loss.orphanEvidence, 1, "清点出会变孤儿的 evidence 文件");
    assert.ok(dry.warnings.some((w) => w.includes("T1 语义段")), "dry-run 也要说一声");
    assert.ok(readFileSync(pagePath, "utf8").includes(T1_SECTION_START), "dry-run 不动字节");

    const applied = runChoroT0({ repoRoot: root, store, apply: true, now: () => "2026-11-09T00:00:00.000Z" });
    assert.deepEqual(applied.t1Loss.pages, [relPage], "apply receipt 同样带清点");
    assert.ok(applied.warnings.some((w) => w.includes("evidence")), "孤儿 evidence 数进 warning");
    assert.ok(!readFileSync(pagePath, "utf8").includes(T1_SECTION_START), "T1 段确实被丢弃（设计意图）");
    assert.ok(exists(root, ".chorography/evidence/src.json"), "evidence 不删——孤儿留着当证人");

    // 清点只读：页已退回骨架后再跑，就不再报（否则警告会变成常驻噪音）
    const clean = runChoroT0({ repoRoot: root, store, now: () => "2026-11-10T00:00:00.000Z" });
    assert.deepEqual(clean.t1Loss.pages, [], "没有 T1 段时不报警");
    assert.equal(clean.t1Loss.orphanEvidence, 1, "但孤儿 evidence 仍在，照实报");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

// CLI 的 --timeout 是「秒」，一路乘 1000 变成 spawn 的 timeoutMs。NaN 混进去不会
// 报错，只会让墙钟上限静默失效——用户以为设了 60 秒，实际跑到 4 分钟默认值。
test("CLI 解析：--t1 相关旗标取到值，--timeout 只收正数秒", () => {
  const { flags } = parseArgv([
    "D:/repo", "--t1", "--apply", "--module", "src", "--model", "xdpool/m",
    "--timeout", "60", "--retry-failed", "--dsh-exe", "D:/Harness.exe", "--json",
  ]);
  assert.equal(flags.t1, true);
  assert.equal(flags.apply, true);
  assert.equal(flags.module, "src");
  assert.equal(flags.model, "xdpool/m");
  assert.equal(flags.timeout, 60, "解析出来就是数字，接线处不再二次转换");
  assert.equal(flags.retryFailed, true);
  assert.equal(flags["dsh-exe"], "D:/Harness.exe");
  assert.throws(() => parseArgv(["--t1", "--timeout", "abc"]), /正数秒/);
  assert.throws(() => parseArgv(["--t1", "--timeout", "0"]), /正数秒/);
  assert.throws(() => parseArgv(["--t1", "--timeout"]), /需要一个秒数/);
});

test("plan.yaml 未知键整轮拒绝且零写入（D7 的第一道闸）", () => {
  const root = makeFixture();
  const store = createStore(":memory:");
  try {
    mkdirSync(join(root, ".chorography"), { recursive: true });
    writeFileSync(join(root, ".chorography", "plan.yaml"), "includes:\n  - src\n", "utf8");
    assert.throws(
      () => runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW }),
      (err) => {
        assert.ok(err instanceof PlanInvalidError);
        assert.ok(err.message.includes("includes"));
        return true;
      }
    );
    assert.equal(snapshot(root).files.has(".chorography/index.md"), false, "拒绝路径不写产物");
    assert.equal(snapshot(root).files.has(".chorography/state.json"), false, "拒绝路径不推进 state");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("pages 白名单：只给列出的 slug 建页；模板与笔记原文进页（D7 正面控制）", () => {
  const root = makeFixture();
  const store = createStore(":memory:");
  try {
    mkdirSync(join(root, ".chorography"), { recursive: true });
    writeFileSync(join(root, ".chorography", "plan.yaml"),
      "pages:\n  - path: src\n    title: 源码主区\n    template: arch\n    notes: 只看导出面\ntemplates:\n  arch: |\n    自定义正文（人写的）\n", "utf8");
    const receipt = runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW });
    assert.equal(receipt.pageCount, 1);
    assert.equal(receipt.skippedByWhitelist, 2, "root/lib 被白名单挡下");
    const page = readFileSync(join(root, ".chorography", "modules", "src.md"), "utf8");
    assert.ok(page.includes("title: 源码主区"));
    assert.ok(page.includes("自定义正文（人写的）"), "模板正文进页");
    assert.ok(page.includes("只看导出面"), "笔记进页");
    assert.ok(!exists(root, ".chorography/modules/root.md"), "未列出的模块不建页");
    assert.ok(!exists(root, ".chorography/modules/lib.md"), "未列出的模块不建页");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("apply 落库：repo 登记 + 模块/页面成行，重跑行数不翻倍；claim 空壳为 0（M0 口径）", () => {
  const root = makeFixture();
  const store = createStore(":memory:");
  try {
    runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW });
    const repos = store.db.prepare("SELECT * FROM choro_repos").all();
    assert.equal(repos.length, 1);
    assert.equal(repos[0].name, "demo-repo");
    assert.ok(repos[0].root_path.endsWith("demo-repo") || repos[0].root_path.includes("choro-t0-"));
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM choro_modules").get().c, 3);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM choro_pages").get().c, 3);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM choro_claims").get().c, 0, "T0 零 claims");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM choro_vectors").get().c, 0, "M0 零向量");

    const status = store.db.prepare("SELECT DISTINCT status FROM choro_pages").get().status;
    assert.equal(status, "skeleton");

    runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM choro_modules").get().c, 3, "重跑不翻倍");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM choro_pages").get().c, 3, "重跑不翻倍");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("仓库内容变了：页面跟着变、state.json 推进（指纹是输入，不是快照）", () => {
  const root = makeFixture();
  const store = createStore(":memory:");
  try {
    runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW });
    const stateBefore = JSON.parse(readFileSync(join(root, ".chorography", "state.json"), "utf8"));
    writeFileSync(join(root, "src", "c.js"), "export const c = 3;\n", "utf8");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "add c", "--no-gpg-sign"], { cwd: root, stdio: "pipe" });

    const receipt = runChoroT0({ repoRoot: root, store, apply: true, now: () => "2026-11-08T00:00:00.000Z" });
    assert.equal(receipt.reusedGeneratedAt, false, "仓库变了，generatedAt 不沿用");
    assert.ok(receipt.moduleSummary.find((m) => m.slug === "src").fileCount === 3);
    const stateAfter = JSON.parse(readFileSync(join(root, ".chorography", "state.json"), "utf8"));
    assert.equal(stateAfter.generatedAt, "2026-11-08T00:00:00.000Z");
    assert.notEqual(stateAfter.repoFingerprint, stateBefore.repoFingerprint);
    const srcPage = readFileSync(join(root, ".chorography", "modules", "src.md"), "utf8");
    assert.ok(srcPage.includes("src/c.js"), "新文件出现在清单里");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

function exists(root, rel) {
  try {
    statSync(join(root, rel));
    return true;
  } catch {
    return false;
  }
}
