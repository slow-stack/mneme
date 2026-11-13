// T1 生成轮的回归锁（M2，实现计划 P14–P22）。runner 全部是注入的 stub——
// 单测绝不真开 headless 会话（那是 V1/手动的世界）。锁的点：
// 输出契约（坏 JSON / 编造锚点 → failed）、三重上限触发的模块级失败、
// 环境级失败整档中止（页状态不动）、失败两次标 failed 且 --retry-failed 可拉回、
// 富化写法（T1 段在「生成说明」前、CHORO:HUMAN 保留区照旧页尾回填）、
// claims 双落（表 + evidence/<slug>.json）、未登记仓库拒绝。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, cpSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { runChoroT0 } from "../src/wiki/t0.js";
import { createStore } from "../src/store.js";
import { createT1, T1Refusal, T1_SECTION_START, T1_SECTION_END, makeHeadlessRunner, locateDshExe, resolveCliJs } from "../src/wiki/t1.js";
import { hostId } from "../src/wiki/portable.js";

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

/* ------------------------- 定位层（issue #578） ------------------------- */
//
// 这一组锁的是「按安装布局写死路径」那类回归：exe 名、cli.js 位置、失败诊断三件事
// 以前都只有一种答案，换一种安装布局（DSH NEXT）整档 T1 就起不来，而报错是
// 「(无输出)」。全部用临时目录造假结构，不碰真 asar、不真开进程。

/** 造一棵假的安装树：<root>/<exeName> + <root>/resources/app.asar/<rel> */
function fakeInstall(exeName, cliRels) {
  const root = mkdtempSync(join(tmpdir(), "choro-install-"));
  const exe = join(root, exeName);
  writeFileSync(exe, "", "utf8");
  for (const rel of cliRels) {
    const abs = join(root, "resources", "app.asar", ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, "// cli\n", "utf8");
  }
  return { root, exe };
}

test("resolveCliJs：DSH NEXT 布局优先于旧布局，且 DSH_CLI_JS 压过一切", () => {
  // 两种布局同时在（老机器升级后可能留下旧目录），新布局必须赢——否则又一次
  // 「升级了但还是按旧位置找」。
  const both = fakeInstall("DSH NEXT.exe", [
    "lib/desktop-cli.js",
    "dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js",
  ]);
  try {
    const picked = resolveCliJs(both.exe, {});
    assert.equal(picked.verified, true);
    assert.equal(picked.path, join(both.root, "resources", "app.asar", "lib", "desktop-cli.js"));
  } finally {
    rmTempBestEffort(both.root);
  }

  // 只有旧布局：仍要认（不能为了修新布局把老安装打坏）。
  const legacy = fakeInstall("DeepSeek Harness.exe", ["dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"]);
  try {
    const picked = resolveCliJs(legacy.exe, {});
    assert.equal(picked.verified, true);
    assert.ok(picked.path.includes("dsh-desktop-host"));
  } finally {
    rmTempBestEffort(legacy.root);
  }

  // DSH_CLI_JS：探测不进 asar 的进程（裸 node、远程布局）唯一的人工出口。
  const manual = fakeInstall("DSH NEXT.exe", []);
  try {
    const custom = join(manual.root, "custom-cli.js");
    writeFileSync(custom, "// cli\n", "utf8");
    const picked = resolveCliJs(manual.exe, { DSH_CLI_JS: custom });
    assert.equal(picked.path, custom);
    assert.equal(picked.verified, true);
  } finally {
    rmTempBestEffort(manual.root);
  }
});

test("resolveCliJs：DSH_CLI_JS 明确指定但路径不存在 → 直接失败，绝不回退到其它候选", () => {
  const root = mkdtempSync(join(tmpdir(), "choro-t1-explicit-"));
  try {
    const exe = join(root, "DSH NEXT.exe");
    writeFileSync(exe, "", "utf8");
    // 这份「看起来能用」的布局候选真的存在：如果没有显式指定的短路，
    // resolveCliJs 会安静地挑中它，用户以为自己的 DSH_CLI_JS 生效了。
    const asarLib = join(root, "resources", "app.asar", "lib");
    mkdirSync(asarLib, { recursive: true });
    writeFileSync(join(asarLib, "desktop-cli.js"), "", "utf8");

    const missing = join(root, "不存在的", "desktop-cli.js");
    const picked = resolveCliJs(exe, { DSH_CLI_JS: missing });
    assert.equal(picked.path, null, "显式指定失败就是失败：回退会让人以为设置生效了");
    assert.equal(picked.verified, false);
    assert.equal(picked.explicitMissing, missing, "把用户写的那个路径原样带回来，好让他改");
    assert.ok(picked.candidates.includes(missing), "候选清单里仍是第一位");
  } finally {
    for (let i = 0; i < 5; i++) {
      try { rmSync(root, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); }
    }
  }
});

test("runner：DSH_CLI_JS 指定不存在的路径时，错误信息指向那个路径而不是布局", () => {
  const run = makeHeadlessRunner({
    locateExe: () => "D:\\fake\\DSH.exe",
    resolveCli: () => ({ path: null, candidates: ["D:\\fake\\cli.js"], verified: false, explicitMissing: "D:\\my\\cli.js" }),
  });
  return run({ cwd: ".", task: "x", model: "p/m" }).then((res) => {
    assert.equal(res.ok, false);
    assert.equal(res.kind, "environment");
    assert.ok(res.reason.includes("D:\\my\\cli.js"), "要点名用户写的路径");
    assert.ok(res.reason.includes("不会回退"), "要说清它不会自动改用别的候选，否则用户会去查布局");
  });
});

test("resolveCliJs：全都不在时交回旧布局路径但标 verified:false，候选清单完整", () => {
  // verified:false 是失败信息里那句「这次没探测」的依据：宁可说清楚「我没看到」
  // 也不假装自己确认过路径存在。
  const empty = fakeInstall("DSH NEXT.exe", []);
  try {
    const picked = resolveCliJs(empty.exe, {});
    assert.equal(picked.verified, false);
    assert.ok(picked.path.endsWith(join("dsh-desktop-host", "lib", "cli.js")));
    assert.equal(picked.candidates.length, 3); // DSH_CLI_JS 未设 → 不占位
    assert.ok(picked.candidates.some((c) => c.endsWith(join("lib", "desktop-cli.js"))));
  } finally {
    rmTempBestEffort(empty.root);
  }
});

test("locateDshExe：认 DSH NEXT.exe，也认标准安装位与 DSH_EXE", () => {
  // 旧实现只认 basename === "deepseek harness.exe"：DSH NEXT 的 exe 名不匹配、
  // 装在别处也不匹配 → 两个条件同时不满足，直接 environment 失败。
  assert.equal(locateDshExe({}, "D:\\Apps\\DSH NEXT.exe"), "D:\\Apps\\DSH NEXT.exe");
  assert.equal(locateDshExe({}, "D:\\Apps\\DeepSeek Harness.exe"), "D:\\Apps\\DeepSeek Harness.exe");
  // 不认识的 exe 名不许瞎猜：装了两套宿主时按「同目录任意 exe」挑会挑错。
  assert.equal(locateDshExe({ ProgramFiles: "Z:\\nope", "ProgramFiles(x86)": "Z:\\nope2" }, "D:\\Apps\\other.exe"), null);

  const install = fakeInstall("DSH NEXT.exe", []);
  try {
    // 标准安装位探测：<root>/DSH NEXT/DSH NEXT.exe
    const pf = join(install.root, "pf");
    const dir = join(pf, "DSH NEXT");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "DSH NEXT.exe"), "", "utf8");
    assert.equal(locateDshExe({ ProgramFiles: pf }, "D:\\Apps\\other.exe"), join(dir, "DSH NEXT.exe"));
    // DSH_EXE 最高优先（显式指定永远赢过探测）。
    assert.equal(locateDshExe({ DSH_EXE: install.exe, ProgramFiles: pf }, "D:\\Apps\\other.exe"), install.exe);
  } finally {
    rmTempBestEffort(install.root);
  }
});

/** 假子进程：只实现 consumeHeadlessStream 用到的那几个面。 */
function fakeProc({ stdout = [], stderr = [], code = 0 } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = () => { proc.killed = true; };
  queueMicrotask(() => {
    for (const chunk of stdout) proc.stdout.emit("data", Buffer.from(chunk));
    for (const chunk of stderr) proc.stderr.emit("data", Buffer.from(chunk));
    proc.emit("close", code);
  });
  return proc;
}

test("headless 起不来时，stderr 尾巴进 reason（不再是「(无输出)」）", async () => {
  // issue #578 的直接症状：退出码 1 + stdout 空 → reason 只有「(无输出)」，用户
  // 连是缺 credential 还是路径错都不知道。原因一直在 stderr 里。
  const runner = makeHeadlessRunner({
    locateExe: () => "D:\\fake\\DSH NEXT.exe",
    resolveCli: () => ({ path: "D:\\fake\\cli.js", candidates: [], verified: true }),
    spawn: () => fakeProc({ stderr: ["Error: Cannot find module 'D:\\fake\\cli.js'\n"], code: 1 }),
  });
  const result = await runner({ cwd: ".", task: "t", model: "p/m", timeoutMs: 5000, maxToolCalls: 3, maxOutputBytes: 4096 });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "environment"); // "Cannot find" → 环境级
  assert.ok(result.reason.includes("Cannot find module"));
  assert.ok(!result.reason.includes("(无输出)"));
});

test("成功路径不追加「未经探测」的提示；探测失败且环境错时才追加", async () => {
  // 成功时多说一句会让人以为哪里没配好；失败时这句是唯一的自查线索。
  const okRunner = makeHeadlessRunner({
    locateExe: () => "D:\\fake\\app.exe",
    resolveCli: () => ({ path: "D:\\fake\\cli.js", candidates: [], verified: false }),
    spawn: () => fakeProc({ stdout: ['{"type":"final","text":"ok"}\n'] }),
  });
  const ok = await okRunner({ cwd: ".", task: "t", model: "p/m", timeoutMs: 5000, maxToolCalls: 3, maxOutputBytes: 4096 });
  assert.equal(ok.ok, true);
  assert.ok(!ok.reason);

  const badRunner = makeHeadlessRunner({
    locateExe: () => "D:\\fake\\app.exe",
    resolveCli: () => ({ path: "D:\\fake\\cli.js", candidates: [], verified: false }),
    spawn: () => fakeProc({ stderr: ["MISSING_CREDENTIAL\n"], code: 1 }),
  });
  const bad = await badRunner({ cwd: ".", task: "t", model: "p/m", timeoutMs: 5000, maxToolCalls: 3, maxOutputBytes: 4096 });
  assert.equal(bad.kind, "environment");
  assert.ok(bad.reason.includes("DSH_CLI_JS")); // 提示指向唯一的人工出口
});

test("找不到 CLI 时 reason 列出全部候选路径", async () => {
  const runner = makeHeadlessRunner({
    locateExe: () => "D:\\fake\\DSH NEXT.exe",
    resolveCli: () => ({ path: null, candidates: ["a/lib/desktop-cli.js", "b/dsh/lib/cli.js"], verified: false }),
    spawn: () => { throw new Error("不该 spawn"); },
  });
  const result = await runner({ cwd: ".", task: "t", model: "p/m", timeoutMs: 5000, maxToolCalls: 3, maxOutputBytes: 4096 });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "environment");
  assert.ok(result.reason.includes("a/lib/desktop-cli.js"));
  assert.ok(result.reason.includes("b/dsh/lib/cli.js"));
});

test("--dsh-exe 只影响这一轮：跑完 env 还原", async () => {
  // 原来写进 process.env 就不还：同一进程里后续每次定位都继承旧值（面板切仓库
  // 还是那个 exe），属于会记很久的脏状态。
  const { root, store } = setup();
  const saved = process.env.DSH_EXE;
  try {
    delete process.env.DSH_EXE;
    let seen = null;
    const t1 = createT1({
      store,
      runSession: async () => {
        seen = process.env.DSH_EXE;
        return { ok: true, text: GOOD_OUTPUT };
      },
      now: FIXED_NOW,
    });
    await t1.runT1({ repoRoot: root, moduleSlug: "src", dshExe: "D:\\Harness.exe" });
    assert.equal(seen, "D:\\Harness.exe"); // 轮内可见
    assert.equal(process.env.DSH_EXE, undefined); // 轮后还原
  } finally {
    if (saved !== undefined) process.env.DSH_EXE = saved;
    store.close();
    rmTempBestEffort(root);
  }
});

// ---- #581 跨端认领 ----

test("跨端认领：本机路径未登记但身份已登记（另一台机器跑过 T0）→ T1 直接富化那一行", async () => {
  const root = makeFixture();
  // 挂 remote：两台机器的同一仓库算出同一个身份键（fixture 无 remote 时键是根
  // 提交哈希，克隆体与原件也同键——这里用 remote 走最常用的那条路）。
  execFileSync("git", ["remote", "add", "origin", "https://github.com/slow-stack/t1fix.git"], { cwd: root, stdio: "pipe" });
  const store = createStore(":memory:");
  let clone = null;
  try {
    runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW });
    const row = store.db.prepare("SELECT id, root_path, portable_key FROM choro_repos").get();
    assert.equal(row.portable_key, "github.com/slow-stack/t1fix");

    // 模拟另一台机器：把整个检出（含 .chorography）搬到新路径——共享盘/换机场景
    // 的等价物。新路径没登记过（byRoot 落空），身份却已在库上。
    clone = mkdtempSync(join(tmpdir(), "choro-t1-hostb-"));
    cpSync(root, clone, { recursive: true });

    const t1 = createT1({ store, runSession: async () => ({ ok: true, text: GOOD_OUTPUT }), now: FIXED_NOW });
    const receipt = await t1.runT1({ repoRoot: clone, moduleSlug: "src" });
    assert.equal(receipt.enriched.length, 1, "跨端认领成功，pages 富化在身份行上");
    assert.equal(receipt.failed.length, 0);
    // 认领同时把本机路径落进位置表：读侧从此按 host 解析到它
    assert.equal(store.choroRepoPathFor(row.portable_key, hostId())?.root_path, realpathSync(clone),
      "认领必须登记本机位置");
    // 页面文件写在克隆体自己的 .chorography 里（真源纪律：正文永远读本机磁盘）
    assert.ok(readFileSync(join(clone, ".chorography", "modules", "src.md"), "utf8").includes(T1_SECTION_START));
  } finally {
    store.close();
    rmTempBestEffort(root);
    if (clone) rmTempBestEffort(clone);
  }
});

// ---- PR #679 评审：路径被另一身份占用时不许认领 ----

test("T1 身份优先：同一条路径登记的是另一个仓库时拒绝（否则读 B 的页、写 A 的 claims）", async () => {
  const rootA = makeFixture();
  execFileSync("git", ["remote", "add", "origin", "git@github.com:slow-stack/t1-a.git"], { cwd: rootA, stdio: "pipe" });
  const store = createStore(":memory:");
  let rootB = null;
  try {
    runChoroT0({ repoRoot: rootA, store, apply: true, now: FIXED_NOW });
    rootB = makeFixture();
    execFileSync("git", ["remote", "add", "origin", "git@github.com:slow-stack/t1-b.git"], { cwd: rootB, stdio: "pipe" });
    // 模拟共享库里的路径撞位：A 的身份行恰好写着 B 的本机路径
    store.db.prepare("UPDATE choro_repos SET root_path = ?").run(realpathSync(rootB));
    const t1 = createT1({ store, runSession: async () => ({ ok: true, text: GOOD_OUTPUT }), now: FIXED_NOW });
    await assert.rejects(
      () => t1.runT1({ repoRoot: rootB, moduleSlug: "src" }),
      (err) => err instanceof T1Refusal && err.code === "not-registered",
      "路径命中但身份不符：必须拒绝，不能把 claims 写进 A 的行");
    // 拒绝发生在写库之前：A 的页状态没被 B 的富化推进
    const st = store.db.prepare("SELECT status FROM choro_pages LIMIT 1").get();
    assert.equal(st.status, "skeleton");
  } finally {
    store.close();
    rmTempBestEffort(rootA);
    if (rootB) rmTempBestEffort(rootB);
  }
});
