// chorography 只读工具的回归锁（M1）。锁四件事：
// 1. 默认配置下三个 choro_* 工具根本不注册（模型连名字都看不到，与 memory_organize
//    同款反向语义）——tools.test.js 的 11 工具清单锁管默认面，这里管开启面；
// 2. chorographyEnabled 开 + queries 装配 → 三工具在场；
// 3. 开了开关但 queries 缺装配（null）→ 同样不在场（「开了没装配」与「没开」
//    对模型都不可见，可区分性由面板路由的 409/503 负责）；
// 4. execute 的错误形状：多仓歧义带回可选清单、未知 slug 报 page-not-found。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";
import { createChoroQueries } from "../src/wiki/queries.js";
import { runChoroT0 } from "../src/wiki/t0.js";

function setup(config = {}, choro) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const registered = [];
  const ctx = {
    tools: {
      register(def) {
        registered.push(def);
        return () => {};
      }
    }
  };
  createTools(ctx, service, config, null, null, choro);
  return { registered, store };
}

function makeRepo(store) {
  const root = mkdtempSync(join(tmpdir(), "choro-tools-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "toolfix", scripts: { test: "node --test" } }, null, 2) + "\n", "utf8");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.js"), 'import { b } from "./b.js";\nexport const a = () => b();\n', "utf8");
  writeFileSync(join(root, "src", "b.js"), "export const b = () => 1;\n", "utf8");
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init", "--no-gpg-sign"], { cwd: root, stdio: "pipe" });
  runChoroT0({ repoRoot: root, store, apply: true, now: () => "T" });
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

test("默认配置下三个 choro 工具不注册（模型看不到就不会调）", () => {
  const { registered } = setup();
  const names = registered.map((t) => t.name);
  for (const name of ["choro_module_map", "choro_read_page", "choro_search"]) {
    assert.ok(!names.includes(name), `${name} 默认缺席`);
  }
});

test("开关关但 queries 缺装配 → 同样缺席（可区分性归路由层）", () => {
  const { registered } = setup({ chorographyEnabled: true }, null);
  const names = registered.map((t) => t.name);
  assert.ok(!names.includes("choro_search"));
});

test("开启后三工具在场，execute 走通读侧三件套", async () => {
  const store = createStore(":memory:");
  const root = makeRepo(store);
  try {
    const choro = createChoroQueries({ store });
    const { registered } = setup({ chorographyEnabled: true }, choro);
    const names = registered.map((t) => t.name);
    for (const name of ["choro_module_map", "choro_read_page", "choro_search"]) {
      assert.ok(names.includes(name), `${name} 在场`);
    }
    const byName = Object.fromEntries(registered.map((t) => [t.name, t]));

    const map = await byName.choro_module_map.execute({});
    assert.ok(map.modules.length >= 2);
    assert.equal(map.repo, "toolfix");

    const page = await byName.choro_read_page.execute({ slug: "src" });
    assert.equal(page.slug, "src");
    assert.ok(page.content.includes("## 文件清单"));

    const missing = await byName.choro_read_page.execute({ slug: "nope" });
    assert.equal(missing.error, "page-not-found");

    const hits = await byName.choro_search.execute({ query: "b.js" });
    assert.ok(hits.hits.length >= 1);
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("多仓歧义：execute 返回可选清单而不是猜一个", async () => {
  const store = createStore(":memory:");
  const root1 = makeRepo(store);
  const root2 = makeRepo(store);
  try {
    const choro = createChoroQueries({ store });
    const { registered } = setup({ chorographyEnabled: true }, choro);
    const map = registered.find((t) => t.name === "choro_module_map");
    const result = await map.execute({});
    assert.equal(result.error, "repo-ambiguous");
    assert.equal(result.repos.length, 2);
    const named = await map.execute({ repo: "toolfix" });
    assert.ok(named.modules, "显式给名后解析成功（fixture 同名仓按 id 序取先者）");
  } finally {
    store.close();
    rmTempBestEffort(root1);
    rmTempBestEffort(root2);
  }
});
