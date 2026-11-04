// chorography 四条读路由的回归锁（M1）。锁四层闸的语义分叉（#497 口径）：
// choro queries 缺装配 → 503 unavailable（环境缺件）；chorographyEnabled 关 →
// 409 disabled（用户没开）；repo 解析失败 → 404 / 歧义 → 400 带可选清单；
// 快乐路径四条全通。数据用真实 T0 fixture 建（同 wiki-queries 的对账纪律）。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";
import { createChoroQueries } from "../src/wiki/queries.js";
import { runChoroT0 } from "../src/wiki/t0.js";

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function req(path, method = "GET") {
  const r = new EventEmitter();
  r.url = path;
  r.method = method;
  r.headers = {};
  return r;
}

function setup({ config = null, choro = null } = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, { add: () => {}, remove: () => false, list: () => [] }, null, undefined, "", config, null, null, choro);
  return { routes };
}

function handler(routes, path) {
  return routes.find((r) => r.path === path);
}

async function invoke(route, path) {
  const res = new FakeRes();
  await route.handler(req(path), res);
  return { status: res.statusCode, body: JSON.parse(res.body || "{}") };
}

function makeRepo(store) {
  const root = mkdtempSync(join(tmpdir(), "choro-api-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "apifix", scripts: { test: "node --test" } }, null, 2) + "\n", "utf8");
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

test("四条 choro 路由都在册且 policy 全 open", () => {
  const { routes } = setup({});
  for (const p of ["/api/dsh-mneme/choro/repos", "/api/dsh-mneme/choro/modules", "/api/dsh-mneme/choro/page", "/api/dsh-mneme/choro/search"]) {
    const route = handler(routes, p);
    assert.ok(route, `${p} 在册`);
    assert.equal(route.policy, "open");
  }
});

test("queries 缺装配 → 503；开关关 → 409 disabled（语义分叉）", async () => {
  const missing = setup({});
  const reposRoute = handler(missing.routes, "/api/dsh-mneme/choro/repos");
  const a = await invoke(reposRoute, "/api/dsh-mneme/choro/repos");
  assert.equal(a.status, 503);
  assert.equal(a.body.error, "unavailable");

  const off = setup({ config: { chorographyEnabled: false }, choro: createChoroQueries({ store: createStore(":memory:") }) });
  const b = await invoke(handler(off.routes, "/api/dsh-mneme/choro/repos"), "/api/dsh-mneme/choro/repos");
  assert.equal(b.status, 409);
  assert.equal(b.body.error, "disabled");
});

test("快乐路径：repos / modules / page / search 全通", async () => {
  const store = createStore(":memory:");
  const root = makeRepo(store);
  try {
    const { routes } = setup({ config: { chorographyEnabled: true }, choro: createChoroQueries({ store }) });
    const repos = await invoke(handler(routes, "/api/dsh-mneme/choro/repos"), "/api/dsh-mneme/choro/repos");
    assert.equal(repos.status, 200);
    assert.equal(repos.body.repos.length, 1);
    const repoId = repos.body.repos[0].id;

    const modules = await invoke(handler(routes, "/api/dsh-mneme/choro/modules"), `/api/dsh-mneme/choro/modules?repo=${repoId}`);
    assert.equal(modules.status, 200);
    assert.ok(modules.body.modules.length >= 2);
    assert.ok(Array.isArray(modules.body.edges));

    const page = await invoke(handler(routes, "/api/dsh-mneme/choro/page"), `/api/dsh-mneme/choro/page?repo=${repoId}&slug=src`);
    assert.equal(page.status, 200);
    assert.ok(page.body.page.content.includes("## 文件清单"));

    const search = await invoke(handler(routes, "/api/dsh-mneme/choro/search"), `/api/dsh-mneme/choro/search?repo=${repoId}&q=b.js`);
    assert.equal(search.status, 200);
    assert.ok(search.body.hits.length >= 1);
  } finally {
    rmTempBestEffort(root);
  }
});

test("repo 解析失败各归各位：未知 → 404；歧义 → 400 带清单；slug 缺 → 400", async () => {
  const store = createStore(":memory:");
  const root = makeRepo(store);
  try {
    const { routes } = setup({ config: { chorographyEnabled: true }, choro: createChoroQueries({ store }) });
    const notFound = await invoke(handler(routes, "/api/dsh-mneme/choro/modules"), "/api/dsh-mneme/choro/modules?repo=nope");
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body.error, "repo-not-found");

    const root2 = makeRepo(store);
    try {
      const ambiguous = await invoke(handler(routes, "/api/dsh-mneme/choro/modules"), "/api/dsh-mneme/choro/modules");
      assert.equal(ambiguous.status, 400);
      assert.equal(ambiguous.body.error, "repo-ambiguous");
      assert.equal(ambiguous.body.repos.length, 2);
    } finally {
      rmTempBestEffort(root2);
    }

    const repoId = 1;
    const noSlug = await invoke(handler(routes, "/api/dsh-mneme/choro/page"), `/api/dsh-mneme/choro/page?repo=${repoId}`);
    assert.equal(noSlug.status, 400);
    assert.equal(noSlug.body.error, "slug-required");

    const badSlug = await invoke(handler(routes, "/api/dsh-mneme/choro/page"), `/api/dsh-mneme/choro/page?repo=${repoId}&slug=../etc/passwd`);
    assert.equal(badSlug.status, 404, "路径穿越形态的 slug 走未知页 404（slug 只从 DB 白名单解析）");
  } finally {
    rmTempBestEffort(root);
  }
});
