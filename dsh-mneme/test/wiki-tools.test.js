// #579：从宿主的工具执行入口验证，绕过 schema 校验直调 execute 会漏掉原故障。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";
import { createChoroQueries } from "../src/wiki/queries.js";
import { runChoroT0 } from "../src/wiki/t0.js";

const choroArgs = {
  choro_module_map: {},
  choro_read_page: { slug: "src" },
  choro_search: { query: "b.js" }
};

async function setup(t, config = {}, withChoro = false) {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const ctx = new Context();
  const prompt = await ctx.plugin(SystemPrompt);
  const runtime = await ctx.plugin(ToolRuntime);
  t.after(() => { runtime.dispose(); prompt.dispose(); });
  const tools = ctx.get("tools");
  const service = createService({ store, mirror: null, config: {} });
  createTools({ tools }, service, config, null, null, withChoro ? createChoroQueries({ store }) : null);
  const call = (name, args = {}) => tools.execute({
    name, callId: name, arguments: args, signal: new AbortController().signal
  });
  return { tools, store, call };
}

function makeRepo(t, store, name = "toolfix") {
  const root = mkdtempSync(join(tmpdir(), "choro-tools-"));
  t.after(() => rmTempBestEffort(root));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, scripts: { test: "node --test" } }, null, 2) + "\n", "utf8");
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

function expectToolError(result, pattern) {
  const message = result.content[0]?.text ?? "";
  assert.equal(result.isError, true, message);
  assert.match(message, pattern);
}

test("默认配置下三个 choro 工具不注册（模型看不到就不会调）", async (t) => {
  const { tools } = await setup(t, {}, true);
  for (const name of Object.keys(choroArgs)) {
    assert.ok(!tools.get(name), `${name} 默认缺席`);
  }
});

test("开关开但 queries 缺装配 → 同样缺席（可区分性归路由层）", async (t) => {
  const { tools } = await setup(t, { chorographyEnabled: true });
  for (const name of Object.keys(choroArgs)) assert.ok(!tools.get(name));
});

test("开启后三个只读工具的成功结果通过宿主校验", async (t) => {
  const { call, store } = await setup(t, { chorographyEnabled: true }, true);
  makeRepo(t, store);
  const map = await call("choro_module_map");
  assert.equal(map.isError, false);
  assert.equal(map.value.repo, "toolfix");
  assert.ok(map.value.modules.length >= 2);
  const page = await call("choro_read_page", { slug: "src" });
  assert.equal(page.isError, false);
  assert.equal(page.value.slug, "src");
  assert.match(page.value.content, /## 文件清单/);
  const search = await call("choro_search", { query: "b.js" });
  assert.equal(search.isError, false);
  assert.ok(search.value.hits.length >= 1);
  assert.equal(search.value.unreadablePages, undefined);
});

test("未登记或找不到指定仓库时，三个工具都返回可操作的错误", async (t) => {
  const { call, store } = await setup(t, { chorographyEnabled: true }, true);
  for (const [name, args] of Object.entries(choroArgs)) {
    expectToolError(await call(name, args), /No repository is registered.*dsh-mneme-choro/);
  }
  makeRepo(t, store);
  const [{ id }] = createChoroQueries({ store }).listRepos();
  const unknownId = String(id + 1);
  for (const [name, args] of Object.entries(choroArgs)) {
    expectToolError(await call(name, { ...args, repo: unknownId }), /Repository "\d+" is not registered/);
  }
});

test("多仓歧义提示可选 id，按 id 重试可读到对应仓库", async (t) => {
  const { call, store } = await setup(t, { chorographyEnabled: true }, true);
  makeRepo(t, store);
  makeRepo(t, store, "other");
  const repos = createChoroQueries({ store }).listRepos();
  for (const [name, args] of Object.entries(choroArgs)) {
    const result = await call(name, args);
    expectToolError(result, /More than one repository is registered/);
    for (const { id, name } of repos) assert.ok(result.content[0].text.includes(`${id} (${name})`));
  }
  const selected = await call("choro_module_map", { repo: String(repos[1].id) });
  assert.equal(selected.isError, false);
  assert.equal(selected.value.repo, "other");
});

test("读页错误区分未知 slug、缺失文件和不可读文件", async (t) => {
  const { call, store } = await setup(t, { chorographyEnabled: true }, true);
  const root = makeRepo(t, store);
  expectToolError(await call("choro_read_page", { slug: "nope" }), /Page "nope" was not found.*choro_module_map/);
  const path = join(root, ".chorography", "modules", "src.md");
  unlinkSync(path);
  expectToolError(await call("choro_read_page", { slug: "src" }), /Page "src" is missing from disk.*dsh-mneme-choro/);
  mkdirSync(path);
  const unreadable = await call("choro_read_page", { slug: "src" });
  expectToolError(unreadable, /Page "src" could not be read.*permissions/);
  assert.ok(!unreadable.content[0].text.includes(root), "工具错误不暴露仓库绝对路径");
});

test("共享库中本机不可达的仓库仍有模块图，读页和检索报告文件访问失败", async (t) => {
  const { call, store } = await setup(t, { chorographyEnabled: true }, true);
  const root = makeRepo(t, store);
  const [{ id, portable_key: key }] = createChoroQueries({ store }).listRepos();
  // 模拟「本机不可达」（#581 之后两处都要动）：身份行的 root_path 指向一个不
  // 存在的检出，且删掉本机的位置行——位置行如果还在，读侧会正确地解析回本机
  // 真路径（那正是修复要给的行为），「不可达」就造不出来了。
  store.db.prepare("UPDATE choro_repos SET root_path = ? WHERE id = ?")
    .run(join(root, "unavailable-checkout"), id);
  store.db.prepare("DELETE FROM choro_repo_paths WHERE repo_key = ?").run(key);
  const repo = String(id);

  const map = await call("choro_module_map", { repo });
  assert.equal(map.isError, false);
  assert.equal(map.value.repo, "toolfix");
  assert.ok(map.value.modules.some(({ slug }) => slug === "src"));
  expectToolError(await call("choro_read_page", { repo, slug: "src" }), /missing from disk.*local checkout/);
  expectToolError(await call("choro_search", { repo, query: "b.js" }), /Search was incomplete.*src.*local checkout/);
});

test("检索报告不可读的页，保留已读到的命中", async (t) => {
  const { call, store } = await setup(t, { chorographyEnabled: true }, true);
  const root = makeRepo(t, store);
  const rootPage = join(root, ".chorography", "modules", "root.md");
  unlinkSync(rootPage);
  const partial = await call("choro_search", { query: "b.js" });
  assert.equal(partial.isError, false);
  assert.ok(partial.value.hits.length >= 1);
  assert.deepEqual(partial.value.unreadablePages, ["root"]);
  assert.match(partial.content[0].text, /Search was incomplete.*root/);

  const empty = await call("choro_search", { query: "not present", module: "src" });
  assert.equal(empty.isError, false);
  assert.deepEqual(empty.value, { hits: [] });
  assert.equal(empty.content[0].text, "0 hits.");

  const incomplete = await call("choro_search", { query: "not present" });
  expectToolError(incomplete, /Search was incomplete.*root/);
  const srcPage = join(root, ".chorography", "modules", "src.md");
  unlinkSync(srcPage);
  mkdirSync(srcPage);
  expectToolError(await call("choro_search", { query: "b.js" }), /Search was incomplete.*root.*src/);
});
