// /choro 的回归锁（M3）。锁三件事：
// 1. **只读**——它一个字节都不写（重建、富化、切档位都不在这条命令里，spec §2 D6）；
// 2. **三态过期**——一致 / 不一致 / 读不到 HEAD 必须分开报，不许把「读不到」说成
//    「没过期」（那是这条命令唯一的实质判断）；
// 3. **回执永不抛进宿主**——handler 走 CommandResult 契约，异常写进文本。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runChoroT0 } from "../src/wiki/t0.js";
import { createStore } from "../src/store.js";
import { createChoroQueries } from "../src/wiki/queries.js";
import { createChoroHandler, registerChoroCommand, CHORO_COMMAND } from "../src/choro-command.js";

const FIXED_NOW = () => "2026-11-05T00:00:00.000Z";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "choro-cmd-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "cfix", scripts: { test: "node --test" } }, null, 2) + "\n", "utf8");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.js"), 'import { b } from "./b.js";\nexport const a = () => b();\n', "utf8");
  writeFileSync(join(root, "src", "b.js"), "export const b = () => 1;\n", "utf8");
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
  console.warn("[choro-command.test] 临时目录清理未完成：" + dir);
}

/** git 提交一次，用于把 HEAD 推离地志基线（造「可能已过期」）。 */
function commitSomething(root, name) {
  writeFileSync(join(root, name), "// drift\n", "utf8");
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "drift", "--no-gpg-sign"], { cwd: root, stdio: "pipe" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function setup(config = {}) {
  const root = makeFixture();
  const store = createStore(":memory:");
  runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW });
  const choro = createChoroQueries({ store });
  return { root, store, choro, config: { chorographyEnabled: true, ...config } };
}

/** 造 invocation：handler 只读 agent.session.header.cwd。 */
function invocation(root) {
  return { agent: { session: { header: { cwd: root } } } };
}

test("/choro：总闸关时报「没开」并给出打开路径，不是空回执", () => {
  const { root, store, choro } = setup({ chorographyEnabled: false });
  try {
    const res = createChoroHandler({ choro, config: { chorographyEnabled: false }, language: () => "zh" })(invocation(root));
    assert.equal(res.kind, "error");
    assert.ok(res.text.includes("没开"));
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("/choro：拿不到 cwd / 仓库没登记，两种失败分开说", () => {
  const { root, store, choro, config } = setup();
  try {
    const handler = createChoroHandler({ choro, config, language: () => "zh" });
    const noCwd = handler({ agent: { session: { header: {} } } });
    assert.equal(noCwd.kind, "error");
    assert.ok(noCwd.text.includes("工作目录"));
    const noRepo = handler(invocation(join(root, "no-such-dir")));
    assert.equal(noRepo.kind, "error");
    assert.ok(noRepo.text.includes("dsh-mneme-choro"), "要给出生成命令，否则用户不知道下一步");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("/choro：快乐路径带提纲、状态与用法，且基线一致时明说没过期", () => {
  const { root, store, choro, config } = setup();
  try {
    const res = createChoroHandler({ choro, config, language: () => "zh" })(invocation(root));
    assert.equal(res.kind, "success");
    assert.ok(res.text.includes("仓库地志 · cfix"));
    assert.ok(res.text.includes(".chorography/modules/src.md"), "full 档列全部模块的页路径");
    assert.ok(res.text.includes("基线一致"), "T0 刚跑完，HEAD 就是基线");
    assert.ok(res.text.includes("choro_search"), "用法提示要指出「正文怎么读」");
    assert.equal(res.text.includes("## 文件清单"), false, "回执同样只给标题级，不贴正文");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("/choro：HEAD 推离基线 → 明说可能已过期，且明说「不会自己重跑」", () => {
  const { root, store, choro, config } = setup();
  try {
    const head = commitSomething(root, "drift.txt");
    const res = createChoroHandler({ choro, config, language: () => "zh" })(invocation(root));
    assert.equal(res.kind, "success");
    assert.ok(res.text.includes("可能已过期"), res.text);
    assert.ok(res.text.includes(head.slice(0, 7)), "要给出当前 HEAD 的短 sha，人才能自己比对");
    assert.ok(res.text.includes("不会自己重跑"), "只提示不自动更新是 spec §2 D6 的明说语义");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("/choro：读不到 HEAD 时报「判断不了」，不许冒充「没过期」", () => {
  const { store } = setup();
  const fake = {
    repoByCwd: () => ({ id: 1, name: "ghost", root_path: join(tmpdir(), "definitely-not-a-repo-" + Date.now()), updated_at: FIXED_NOW(), git_baseline: "deadbeef" }),
    outline: () => ({ repo: { id: 1, name: "ghost" }, generatedAt: FIXED_NOW(), modules: [{ slug: "a", title: "A", fileCount: 1, parentSlug: null, status: "skeleton", relPath: ".chorography/modules/a.md" }] })
  };
  try {
    const res = createChoroHandler({ choro: fake, config: { chorographyEnabled: true }, language: () => "zh" })({ agent: { session: { header: { cwd: "/x" } } } });
    assert.equal(res.kind, "success");
    assert.ok(res.text.includes("没法判断是否过期"), res.text);
    assert.equal(res.text.includes("基线一致"), false, "读不到 HEAD 绝不能说成一致");
  } finally {
    store.close();
  }
});

test("/choro：模块为空时给明确空态而不是半个回执", () => {
  const empty = {
    repoByCwd: () => ({ id: 1, name: "emptyfix", root_path: "/x", updated_at: FIXED_NOW(), git_baseline: "abc" }),
    outline: () => ({ repo: { id: 1, name: "emptyfix" }, generatedAt: FIXED_NOW(), modules: [] })
  };
  const res = createChoroHandler({ choro: empty, config: { chorographyEnabled: true }, language: () => "zh" })({ agent: { session: { header: { cwd: "/x" } } } });
  assert.equal(res.kind, "success");
  assert.ok(res.text.includes("还没扫出任何模块"));
});

test("/choro：读侧抛错时不把异常扔进宿主，原因写进回执", () => {
  const boom = { repoByCwd: () => { throw new Error("store closed"); }, outline: () => null };
  const res = createChoroHandler({ choro: boom, config: { chorographyEnabled: true }, language: () => "zh" })({ agent: { session: { header: { cwd: "/x" } } } });
  assert.equal(res.kind, "error");
  assert.ok(res.text.includes("store closed"));
});

test("/choro：注册闸——没开 / 宿主没有命令表都返回 null（不抛）", () => {
  const registered = [];
  const ctx = { commands: { register: (def) => { registered.push(def); return () => {}; } } };
  assert.equal(registerChoroCommand({ ctx, choro: null, config: {}, enabled: false, language: () => "zh" }), null);
  assert.equal(registerChoroCommand({ ctx: {}, choro: null, config: {}, enabled: true, language: () => "zh" }), null);
  const dispose = registerChoroCommand({ ctx, choro: null, config: { chorographyEnabled: true }, enabled: true, language: () => "zh" });
  assert.equal(typeof dispose, "function");
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, CHORO_COMMAND);
  assert.equal(typeof registered[0].handler, "function");
});

test("/choro：英文语言取英文文案（双语是成对的，不许只写中文）", () => {
  const { root, store, choro } = setup();
  try {
    const res = createChoroHandler({ choro, config: { chorographyEnabled: true }, language: () => "en" })(invocation(root));
    assert.equal(res.kind, "success");
    assert.ok(res.text.includes("Repo atlas"), res.text);
    assert.ok(res.text.includes("not stale"), res.text);
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("/choro：提纲超字符上限时，截断语报的是「还剩几个」而不是总数", () => {
  // 回执贴爆 UI 同样是失败，所以 full 档也守 6000 字符上限。但截断语必须报差额：
  // 报总数（38 个）而实际只漏了 3 个，读者会以为大部分模块都看不到。
  const many = Array.from({ length: 80 }, (_, i) => ({
    slug: "mod-" + i,
    title: "模块" + i + "-".repeat(120),
    fileCount: i,
    parentSlug: null,
    status: "skeleton",
    relPath: ".chorography/modules/mod-" + i + ".md"
  }));
  const fake = {
    repoByCwd: () => ({ id: 1, name: "bigfix", root_path: join(tmpdir(), "no-such-repo-" + Date.now()), updated_at: FIXED_NOW(), git_baseline: "x" }),
    outline: () => ({ repo: { id: 1, name: "bigfix" }, generatedAt: FIXED_NOW(), modules: many })
  };
  const res = createChoroHandler({ choro: fake, config: { chorographyEnabled: true }, language: () => "zh" })({ agent: { session: { header: { cwd: "/x" } } } });
  assert.equal(res.kind, "success");
  const m = /另有 (\d+) 个模块/.exec(res.text);
  assert.ok(m, "超上限必须明说还剩几个：" + res.text.slice(-200));
  const rest = Number(m[1]);
  assert.ok(rest > 0 && rest < 80, "必须报差额而不是总数 80，实际报 " + rest);
});

test("/choro：轻量档（lightMode）压掉的是注入，不是这条命令", () => {
  // resolveInjectTier 在 lightMode 下也返回 off。若拿它当命令闸，lightMode 的用户
  // 敲 /choro 会听到「没开，去设置里打开」——而设置里明明是开着的。档位管注入，
  // 命令只管子系统开没开。
  const { root, store, choro } = setup();
  try {
    const res = createChoroHandler({ choro, config: { chorographyEnabled: true, lightMode: true, chorographyInject: "full" }, language: () => "zh" })(invocation(root));
    assert.equal(res.kind, "success", "轻量档下命令照常可用");
    assert.ok(res.text.includes("仓库地志 · cfix"));
    assert.equal(res.text.includes("没开"), false, "子系统开着时不许说没开");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});
