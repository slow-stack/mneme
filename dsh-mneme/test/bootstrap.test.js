// Issue #220 bootstrap 冷启动测试。
// 覆盖：五类确定性产物齐全 / node_modules 等产物目录跳过 / 幂等重跑（原地刷新
// 不产生重复行）/ README 变更后重跑内容刷新 / git 仓库追加提交主线记忆（git
// 不可用时优雅跳过）/ 输入校验三错码 / standalone API 路由（200 + 400 映射 + 401）。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createStandaloneApi } from "../src/api-standalone.js";
import { bootstrapFromDirectory, BootstrapError } from "../src/bootstrap.js";
import { testConfig } from "./helpers/test-config.js";

/** 造一个带五类来源的临时项目；node_modules 故意放上，断言会被跳过。 */
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), "mneme-bootstrap-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "demo",
    scripts: { test: "node --test", build: "node build.js" }
  }));
  writeFileSync(join(root, "README.md"), "# Demo 项目\n\n用于冷启动测试的说明。" + "正文内容。".repeat(60));
  writeFileSync(join(root, "CONTRIBUTING.md"), "# 贡献指南\n\n提交前必须跑全量测试，PR commit 必须可归属。");
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, ".github", "workflows", "ci.yml"), "name: CI\n");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  return root;
}

/** 真 git 仓库版（提交两条）；git 不可用返回 null，调用方跳过 git 断言。 */
function makeGitProject() {
  try {
    const root = makeProject();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["-C", root, "config", "user.email", "t@t.local"]);
    execFileSync("git", ["-C", root, "config", "user.name", "tester"]);
    execFileSync("git", ["-C", root, "add", "-A"]);
    execFileSync("git", ["-C", root, "commit", "-m", "feat: 第一条提交", "--no-verify"], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "commit", "-m", "fix: 修补一件事", "--allow-empty", "--no-verify"], { stdio: "ignore" });
    return root;
  } catch {
    return null;
  }
}

function makeService() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  return { store, service };
}

function findByTitle(store, type, title) {
  return store.list({ type, limit: 100 }).find((r) => r.title === title);
}

/** standalone API 测试骨架（与 standalone-api.test.js 同款：真 HTTP + fetch）。 */
async function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const settings = createSettings(store.db);
  const api = createStandaloneApi({ service, store, config: testConfig({}), settings, logger: null, port: 0 });
  await api.ready;
  const base = `http://127.0.0.1:${api.port}`;
  const auth = { authorization: `Bearer ${api.token}` };
  return {
    base, auth, close: () => {
      api.server.closeIdleConnections?.();
      api.server.close();
      store.close();
    }
  };
}

// ============================================================ 确定性产物

test("bootstrap produces the five deterministic categories", async () => {
  const root = makeProject();
  const { store, service } = makeService();
  try {
    const summary = await bootstrapFromDirectory({ service, dir: root });
    assert.equal(summary.created, 5);
    assert.equal(summary.merged, 0);
    const titles = summary.items.map((i) => i.title);
    for (const t of ["项目脚本命令", "项目概览", "贡献规范", "CI 工作流清单", "顶层目录结构"]) {
      assert.ok(titles.includes(t), `missing category: ${t}`);
    }
    // 全部产物带 bootstrap 标记
    for (const row of store.list({ type: "project", limit: 100 })) {
      assert.ok(row.tags.includes("bootstrap"), `${row.title} tagged bootstrap`);
      assert.equal(row.source, "bootstrap");
    }
    // 顶层目录树跳过产物目录（按 bullet 行断言，避开说明文字里的字样）
    const tree = findByTitle(store, "project", "顶层目录结构");
    assert.ok(tree.content.includes("- src"));
    assert.ok(!tree.content.split("\n").some((l) => l.trim() === "- node_modules"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    store.close();
  }
});

test("git repo additionally gains the commit-history memory", async () => {
  const root = makeGitProject();
  if (!root) return; // git 不可用的环境优雅跳过
  const { store, service } = makeService();
  try {
    const summary = await bootstrapFromDirectory({ service, dir: root });
    const item = summary.items.find((i) => i.title === "近期提交主线");
    assert.ok(item, "commit-history memory created");
    assert.equal(item.action, "created");
    const row = findByTitle(store, "history", "近期提交主线");
    assert.ok(row.content.includes("feat: 第一条提交"));
    assert.ok(row.content.includes("fix: 修补一件事"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    store.close();
  }
});

// ============================================================ 幂等

test("re-running bootstrap refreshes in place without duplicates", async () => {
  const root = makeProject();
  const { store, service } = makeService();
  try {
    const first = await bootstrapFromDirectory({ service, dir: root });
    assert.equal(first.created, 5);
    const countAfterFirst = service.count();
    const second = await bootstrapFromDirectory({ service, dir: root });
    assert.equal(second.created, 0);
    assert.equal(second.merged, 5);
    assert.equal(service.count(), countAfterFirst, "no duplicate rows on re-run");
  } finally {
    rmSync(root, { recursive: true, force: true });
    store.close();
  }
});

test("changed source files refresh content on re-run (overwrite semantics)", async () => {
  const root = makeProject();
  const { store, service } = makeService();
  try {
    await bootstrapFromDirectory({ service, dir: root });
    writeFileSync(join(root, "README.md"), "# Demo 项目 v2\n\n全新的说明文字。");
    await bootstrapFromDirectory({ service, dir: root });
    const overview = findByTitle(store, "project", "项目概览");
    assert.ok(overview.content.includes("全新的说明文字"), "content refreshed");
    assert.equal(service.count(), 5, "still no duplicate rows");
  } finally {
    rmSync(root, { recursive: true, force: true });
    store.close();
  }
});

// ============================================================ 输入校验

test("bootstrap validates its inputs with coded errors", async () => {
  const root = makeProject();
  const { service } = makeService();
  try {
    await assert.rejects(
      bootstrapFromDirectory({ service, dir: "  " }),
      (e) => e instanceof BootstrapError && e.code === "missing-dir"
    );
    await assert.rejects(
      bootstrapFromDirectory({ service, dir: join(root, "does-not-exist") }),
      (e) => e instanceof BootstrapError && e.code === "dir-not-found"
    );
    const filePath = join(root, "package.json");
    await assert.rejects(
      bootstrapFromDirectory({ service, dir: filePath }),
      (e) => e instanceof BootstrapError && e.code === "not-a-directory"
    );
    // 带首尾空格的路径不许被静默 trim 成真目录（#386 第 6 条评审）：协议层
    // readBootstrapDir 承诺「回传原串、交给 fs 报错」，这一层若偷偷改写，用户填
    // " /repo " 会被读成 "/repo"，而报告上照样写着成功——读的是另一个目录，
    // 他却一无所知。所以这里必须仍然是 dir-not-found。
    await assert.rejects(
      bootstrapFromDirectory({ service, dir: ` ${root} ` }),
      (e) => e instanceof BootstrapError && e.code === "dir-not-found"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================ standalone 路由

test("POST /bootstrap: 200 with summary, 400 with coded errors, 401 without token", async () => {
  const root = makeProject();
  const { base, auth, close } = await setup();
  try {
    const unauth = await fetch(`${base}/bootstrap`, {
      method: "POST",
      body: JSON.stringify({ dir: root })
    });
    assert.equal(unauth.status, 401);

    const res = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ dir: root })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.created, 5);
    assert.equal(data.items.length, 5);

    const noDir = await fetch(`${base}/bootstrap`, { method: "POST", headers: auth, body: "{}" });
    assert.equal(noDir.status, 400);
    assert.deepEqual(await noDir.json(), { error: "missing-dir" });

    const notFound = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ dir: join(root, "nope") })
    });
    assert.equal(notFound.status, 400);
    assert.deepEqual(await notFound.json(), { error: "dir-not-found" });
  } finally {
    rmSync(root, { recursive: true, force: true });
    close();
  }
});
