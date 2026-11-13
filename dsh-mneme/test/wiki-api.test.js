// chorography 四条读路由的回归锁（M1）。锁四层闸的语义分叉（#497 口径）：
// choro queries 缺装配 → 503 unavailable（环境缺件）；chorographyEnabled 关 →
// 409 disabled（用户没开）；repo 解析失败 → 404 / 歧义 → 400 带可选清单；
// 快乐路径四条全通。数据用真实 T0 fixture 建（同 wiki-queries 的对账纪律）。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
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

// POST 版：带 JSON body（readBody 走 data/end 事件）
async function invokePost(route, path, body) {
  const r = req(path, "POST");
  process.nextTick(() => {
    r.emit("data", Buffer.from(JSON.stringify(body ?? {})));
    r.emit("end");
  });
  const res = new FakeRes();
  await route.handler(r, res);
  return { status: res.statusCode, body: JSON.parse(res.body || "{}") };
}

// mark：往初始提交里掺区分串（#581 后无 remote 仓库按根提交哈希作身份键——
// 同一秒提交的相同内容会同键收敛成一行，往同一个库登记两个仓库的用例必须区分开）。
function makeRepo(store, mark = "") {
  const root = mkdtempSync(join(tmpdir(), "choro-api-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "apifix", scripts: { test: "node --test" } }, null, 2) + "\n", "utf8");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.js"), `import { b } from "./b.js";\nexport const a = () => b();\n// ${mark}\n`, "utf8");
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
    // 面板的地志页导入要把「根路径 + 页相对路径」拼成磁盘绝对路径（契约 §3.6），
    // 回执里缺 relPath 时它会静默回落到「请先选模块」——这条锁的就是那个真机 bug。
    const withPage = modules.body.modules.filter((m) => m.page_rel_path);
    assert.ok(withPage.length >= 1, "fixture 里至少一个模块有骨架页");
    for (const m of withPage) assert.equal(m.relPath, m.page_rel_path);

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

    const root2 = makeRepo(store, "second");
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

test("地志页路由区分缺失文件和不可读文件", async () => {
  const store = createStore(":memory:");
  const root = makeRepo(store);
  try {
    const { routes } = setup({ config: { chorographyEnabled: true }, choro: createChoroQueries({ store }) });
    const pageRoute = handler(routes, "/api/dsh-mneme/choro/page");
    const url = "/api/dsh-mneme/choro/page?slug=src";
    const file = join(root, ".chorography", "modules", "src.md");
    unlinkSync(file);
    const missing = await invoke(pageRoute, url);
    assert.equal(missing.status, 409);
    assert.equal(missing.body.error, "page-missing");
    assert.match(missing.body.hint, /dsh-mneme-choro/);
    mkdirSync(file);
    const unreadable = await invoke(pageRoute, url);
    assert.equal(unreadable.status, 409);
    assert.equal(unreadable.body.error, "page-unreadable");
    assert.match(unreadable.body.hint, /permissions/);
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

// ---------------------------------------------------------------------------
// 收尾档：POST /choro/run（面板重建入口，P34）+ /choro/search 的 semantic 路（P37–P39）
// ---------------------------------------------------------------------------
test("/choro/run：policy token-write，GET 405，POST 快乐路径重跑 T0", async () => {
  const store = createStore(":memory:");
  const root = makeRepo(store);
  try {
    const { routes } = setup({
      config: { chorographyEnabled: true },
      choro: {
        ...createChoroQueries({ store }),
        // 与 index.js 的装配同形：runT0Apply 闭包住 store（P35：写路径与读侧分开装配）
        runT0Apply: ({ repoRoot }) => runChoroT0({ repoRoot, store, apply: true }),
      },
    });
    const route = handler(routes, "/api/dsh-mneme/choro/run");
    assert.equal(route.policy, "token-write", "写仓库磁盘的口归 token-write");

    const get = await invoke(route, "/api/dsh-mneme/choro/run");
    assert.equal(get.status, 405, "只收 POST");

    // 破坏页面文件后重建：POST 走真 T0，页回来
    rmSync(join(root, ".chorography", "modules", "src.md"));
    const ok = await invokePost(route, "/api/dsh-mneme/choro/run", { repo: 1 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.ok(ok.body.receipt.moduleCount >= 2, "receipt 带划分计数");
    assert.ok(existsSync(join(root, ".chorography", "modules", "src.md")), "重建把页写了回来");
  } finally {
    rmTempBestEffort(root);
  }
});

test("/choro/run：开关关 409；repo 未知 404（与读路由同一道闸）", async () => {
  const store = createStore(":memory:");
  const root = makeRepo(store);
  try {
    const off = setup({
      config: { chorographyEnabled: false },
      choro: { ...createChoroQueries({ store }), runT0Apply: () => { throw new Error("不该被调到"); } },
    });
    const a = await invokePost(handler(off.routes, "/api/dsh-mneme/choro/run"), "/api/dsh-mneme/choro/run", { repo: 1 });
    assert.equal(a.status, 409);

    const on = setup({
      config: { chorographyEnabled: true },
      choro: { ...createChoroQueries({ store }), runT0Apply: () => { throw new Error("不该被调到") } },
    });
    const b = await invokePost(handler(on.routes, "/api/dsh-mneme/choro/run"), "/api/dsh-mneme/choro/run", { repo: 99 });
    assert.equal(b.status, 404);
  } finally {
    rmTempBestEffort(root);
  }
});

test("/choro/run：本机不可达时 409，绝不拿宿主 cwd 顶替（PR #679 评审）", async () => {
  const store = createStore(":memory:");
  const root = makeRepo(store);
  try {
    let called = 0;
    const { routes } = setup({
      config: { chorographyEnabled: true },
      choro: {
        ...createChoroQueries({ store }),
        // 契约：本机没登记位置、回退目录身份核验不过 → 空串
        localRootForRepo: () => "",
        runT0Apply: () => { called += 1; throw new Error("不该被调到"); },
      },
    });
    const res = await invokePost(handler(routes, "/api/dsh-mneme/choro/run"), "/api/dsh-mneme/choro/run", { repo: 1 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "repo-not-reachable-here");
    assert.equal(called, 0, "空串必须挡在 T0 之前：resolve(\"\") 会落到宿主进程的 cwd");
  } finally {
    rmTempBestEffort(root);
  }
});

test("/choro/run：旧装配缺 localRootForRepo 时退回 root_path，不变 500", async () => {
  const store = createStore(":memory:");
  const root = makeRepo(store);
  try {
    const { localRootForRepo, ...oldAssembly } = createChoroQueries({ store });
    const { routes } = setup({
      config: { chorographyEnabled: true },
      choro: {
        ...oldAssembly,
        runT0Apply: ({ repoRoot }) => runChoroT0({ repoRoot, store, apply: true }),
      },
    });
    const res = await invokePost(handler(routes, "/api/dsh-mneme/choro/run"), "/api/dsh-mneme/choro/run", { repo: 1 });
    assert.equal(res.status, 200, "缺一个方法不能让重建变 500");
    assert.equal(res.body.ok, true);
  } finally {
    rmTempBestEffort(root);
  }
});

test("/choro/search：embedder 在场 → 惰性物化 + semantic 数组；缺席 → semantic null", async () => {
  const store = createStore(":memory:");
  const root = makeRepo(store);
  try {
    // stub embedder：向量按内容方向分类（src 相关 → [1,0]），保证可排序断言
    const embedder = {
      model: "stub-1",
      embedSingle: async (text) => (/src|b\.js/.test(text) ? [1, 0] : [0, 1]),
      embed: async (text) => (/src|b\.js/.test(text) ? [1, 0] : [0, 1]),
    };
    const { routes } = setup({
      config: { chorographyEnabled: true },
      choro: { ...createChoroQueries({ store }), embedder },
    });
    const s = await invoke(handler(routes, "/api/dsh-mneme/choro/search"), "/api/dsh-mneme/choro/search?repo=1&q=b.js");
    assert.equal(s.status, 200);
    assert.ok(Array.isArray(s.body.hits) && s.body.hits.length >= 1, "keyword hits 照旧");
    assert.ok(Array.isArray(s.body.semantic) && s.body.semantic.length >= 1, "semantic 数组在场（惰性物化发生在这次请求里）");
    assert.equal(s.body.semantic[0].slug, "src", "与查询同向的页排前");
    assert.equal(typeof s.body.semantic[0].score, "number");

    const noEmbedder = setup({ config: { chorographyEnabled: true }, choro: createChoroQueries({ store }) });
    const t = await invoke(handler(noEmbedder.routes, "/api/dsh-mneme/choro/search"), "/api/dsh-mneme/choro/search?repo=1&q=b.js");
    assert.equal(t.body.semantic, null, "embedder 缺席 → null（调用方退纯关键词）");
  } finally {
    rmTempBestEffort(root);
  }
});

// ---------------------------------------------------------------------------
// 契约 §3.2（kb-qoder parity）：面板闭环要的新字段与新入口
// ---------------------------------------------------------------------------

test("/choro/repos：契约字段齐备，git 漂移 → stale/git，plan 漂移 → stale/plan", async () => {
  const store = createStore(":memory:");
  const root = makeRepo(store);
  try {
    const { routes } = setup({ config: { chorographyEnabled: true }, choro: createChoroQueries({ store }) });
    const url = "/api/dsh-mneme/choro/repos";

    // 刚重建完：不该有任何过期信号——否则面板会对着一个刚生成的地志喊「代码已变」，
    // 用户第一次用就学会不信任那个标记。
    const fresh = await invoke(handler(routes, url), url);
    assert.equal(fresh.status, 200);
    const a = fresh.body.repos[0];
    for (const key of ["id", "name", "rootPath", "modules", "pages", "claims", "legacy", "stale", "staleReason", "lastRunAt"]) {
      assert.ok(key in a, `契约字段 ${key} 必须在场（面板按它渲染）`);
    }
    assert.equal(a.stale, false);
    assert.equal(a.staleReason, null);
    assert.equal(a.legacy, false);
    assert.equal(typeof a.lastRunAt, "string");
    assert.ok(a.modules >= 2 && a.pages >= 2, "modules/pages 是契约字段名（不是行里的 module_count）");

    // 代码变了（新 commit）→ 说过期，理由必须是 git：面板那句话是「代码已变」。
    writeFileSync(join(root, "src", "c.js"), "export const c = () => 2;\n", "utf8");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "drift", "--no-gpg-sign"], { cwd: root, stdio: "pipe" });
    const drifted = await invoke(handler(routes, url), url);
    assert.equal(drifted.body.repos[0].stale, true);
    assert.equal(drifted.body.repos[0].staleReason, "git");

    // 先重建一次把 git 基线推平（否则 git 那一路永远优先，plan 判据根本轮不到），
    // 再只改 plan.yaml（HEAD 不动）→ 理由必须是 plan：这条判据不依赖 git，不能被
    // git 那一路掩盖掉，否则「改了模板配置但没提交」的仓库永远显示干净。
    runChoroT0({ repoRoot: root, store, apply: true });
    const cleaned = await invoke(handler(routes, url), url);
    assert.equal(cleaned.body.repos[0].stale, false, "重建后 git 基线推平，过期信号应清掉");
    writeFileSync(join(root, ".chorography", "plan.yaml"), "pages: []\n", "utf8");
    const planDrift = await invoke(handler(routes, url), url);
    assert.equal(planDrift.body.repos[0].stale, true);
    assert.equal(planDrift.body.repos[0].staleReason, "plan");
  } finally {
    rmTempBestEffort(root);
  }
});

test("/choro/run：空态按绝对路径登记新仓库，重复路径复用同一 id", async () => {
  const store = createStore(":memory:");
  // 只把仓库目录准备好但不登记：这就是面板「一个仓库都没登记」的真实起点。
  const root = mkdtempSync(join(tmpdir(), "choro-empty-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "emptyfix" }, null, 2) + "\n", "utf8");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.js"), "export const a = 1;\n", "utf8");
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init", "--no-gpg-sign"], { cwd: root, stdio: "pipe" });
  try {
    const { routes } = setup({
      config: { chorographyEnabled: true },
      choro: { ...createChoroQueries({ store }), runT0Apply: ({ repoRoot }) => runChoroT0({ repoRoot, store, apply: true }) }
    });
    const route = handler(routes, "/api/dsh-mneme/choro/run");
    const reposUrl = "/api/dsh-mneme/choro/repos";
    const before = await invoke(handler(routes, reposUrl), reposUrl);
    assert.equal(before.body.repos.length, 0, "起点确实是一个仓库都没登记");

    const first = await invokePost(route, "/api/dsh-mneme/choro/run", { path: root });
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.ok(first.body.receipt.moduleCount >= 1, "走的是真 T0（有划分回执）");
    const after = await invoke(handler(routes, reposUrl), reposUrl);
    assert.equal(after.body.repos.length, 1, "空态 + 路径 → 自动登记");

    // 第二次同一路径：不能变成两条记录，也不能报错——面板按钮会被连点。
    const again = await invokePost(route, "/api/dsh-mneme/choro/run", { rootPath: root, refresh: true });
    assert.equal(again.status, 200);
    assert.equal(again.body.refresh, true, "refresh 原样回显，面板据此区分「我要求过重跑」");
    assert.equal((await invoke(handler(routes, reposUrl), reposUrl)).body.repos.length, 1, "同一路径复用既有 id");
  } finally {
    rmTempBestEffort(root);
  }
});

test("/choro/run：路径给错时结构化报错，不落 500 一锅烩", async () => {
  const store = createStore(":memory:");
  const notGit = mkdtempSync(join(tmpdir(), "choro-notgit-"));
  try {
    const { routes } = setup({
      config: { chorographyEnabled: true },
      choro: { ...createChoroQueries({ store }), runT0Apply: ({ repoRoot }) => runChoroT0({ repoRoot, store, apply: true }) }
    });
    const route = handler(routes, "/api/dsh-mneme/choro/run");

    const rel = await invokePost(route, "/api/dsh-mneme/choro/run", { path: "some/rel/dir" });
    assert.equal(rel.status, 400);
    assert.equal(rel.body.error, "path-not-absolute", "相对路径的语义取决于宿主 cwd，必须挡");

    const missing = await invokePost(route, "/api/dsh-mneme/choro/run", { path: join(notGit, "nope") });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, "path-not-found");

    const plain = await invokePost(route, "/api/dsh-mneme/choro/run", { path: notGit });
    assert.equal(plain.status, 409);
    assert.equal(plain.body.error, "not-a-git-repo", "目录在但不是 git 仓库 → 409，不是 500");
  } finally {
    rmTempBestEffort(notGit);
  }
});

// T1 会真花钱（模型调用），所以这里注入假的 startT1Job / t1JobStatus：
// 路由层要锁的只是闸门与 200/409/404 的分叉形状，不是进程本身。
function withT1({ startT1Job, t1JobStatus } = {}) {
  const store = createStore(":memory:");
  const root = makeRepo(store);
  const choro = { ...createChoroQueries({ store }) };
  if (startT1Job) choro.startT1Job = startT1Job;
  if (t1JobStatus) choro.t1JobStatus = t1JobStatus;
  return { store, root, choro };
}

test("/choro/t1：缺装配 503 / 面板闸关 409 / 同仓并发 409 job-running / 缺省 404", async () => {
  const a = withT1({});
  try {
    const noJobs = setup({ config: { chorographyEnabled: true, chorographyT1FromPanel: true }, choro: a.choro });
    const missing = await invokePost(handler(noJobs.routes, "/api/dsh-mneme/choro/t1"), "/api/dsh-mneme/choro/t1", { repo: 1 });
    assert.equal(missing.status, 503, "没装配任务账 → 503 环境缺件");
    assert.equal(missing.body.error, "unavailable");
  } finally {
    rmTempBestEffort(a.root);
  }

  const b = withT1({ startT1Job: () => ({ started: true, jobId: "j-1" }) });
  try {
    const off = setup({
      config: { chorographyEnabled: true, chorographyT1FromPanel: false },
      choro: b.choro
    });
    const disabled = await invokePost(handler(off.routes, "/api/dsh-mneme/choro/t1"), "/api/dsh-mneme/choro/t1", { repo: 1 });
    assert.equal(disabled.status, 409, "T1 花模型额度，面板闸关着就不许起");
    assert.equal(disabled.body.error, "disabled");

    const on = setup({ config: { chorographyEnabled: true, chorographyT1FromPanel: true }, choro: b.choro });
    const t1Route = handler(on.routes, "/api/dsh-mneme/choro/t1");
    assert.equal(t1Route.policy, "token-write", "起一个会写页面/claims 的后台任务属数据面写");

    const ok = await invokePost(t1Route, "/api/dsh-mneme/choro/t1", { repo: 1, module: "src", retryFailed: true });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { jobId: "j-1", started: true });

    const unknown = await invokePost(t1Route, "/api/dsh-mneme/choro/t1", { repo: 99 });
    assert.equal(unknown.status, 404);

    const busy = withT1({ startT1Job: () => ({ started: false, code: "job-running", jobId: "j-2" }) });
    try {
      const busySetup = setup({ config: { chorographyEnabled: true, chorographyT1FromPanel: true }, choro: busy.choro });
      const running = await invokePost(handler(busySetup.routes, "/api/dsh-mneme/choro/t1"), "/api/dsh-mneme/choro/t1", { repo: 1 });
      assert.equal(running.status, 409);
      assert.equal(running.body.error, "job-running");
      assert.equal(running.body.jobId, "j-2", "把在跑的那个 jobId 带回给面板，好让它接着轮询而不是重起");
    } finally {
      rmTempBestEffort(busy.root);
    }
  } finally {
    rmTempBestEffort(b.root);
  }
});

test("/choro/t1/status：jobId 缺 400、未知 404、已知 200 带契约字段", async () => {
  const job = {
    jobId: "j-9",
    repo: { id: 1, name: "x", rootPath: "/x" },
    state: "running",
    startedAt: "T0",
    modules: { total: 2, done: 1, failed: 0 },
    logTail: ["line"]
  };
  const f = withT1({ startT1Job: () => ({ started: true, jobId: "j-9" }), t1JobStatus: (id) => (id === "j-9" ? job : null) });
  try {
    const { routes } = setup({ config: { chorographyEnabled: true }, choro: f.choro });
    const route = handler(routes, "/api/dsh-mneme/choro/t1/status");

    const noId = await invoke(route, "/api/dsh-mneme/choro/t1/status");
    assert.equal(noId.status, 400);
    assert.equal(noId.body.error, "jobId-required");

    const gone = await invoke(route, "/api/dsh-mneme/choro/t1/status?jobId=nope");
    assert.equal(gone.status, 404, "宿主重启后旧 jobId 必然查不到，面板据此回到「没有在跑的任务」");

    const found = await invoke(route, "/api/dsh-mneme/choro/t1/status?jobId=j-9");
    assert.equal(found.status, 200);
    assert.equal(found.body.state, "running");
    assert.equal(found.body.modules.total, 2);
    assert.deepEqual(found.body.logTail, ["line"]);
  } finally {
    rmTempBestEffort(f.root);
  }
});

// ---------------------------------------------------------------------------
// chorographyAutoRefresh：读侧自动重跑 T0（面板文案已经把它当契约写死了：
// 「读地志页时如果发现仓库代码变了，自动重跑一次 T0 骨架」）。
// 这一批同时锁「开关关着绝不偷偷改用户工作区」与「开关开着真的会刷」——只锁一端
// 的测试在实现成「永远不刷」或「永远刷」时都会绿，等于没锁。
// ---------------------------------------------------------------------------

// 计数外壳：真实 queries + 包一层的 runT0Apply（记调用次数、可注入失败）。
// 不造一个假 T0——「刷了但基线没推进」这种 bug 只有真 T0 才照得出来。
function countingChoro(store, { throwOnRun = false } = {}) {
  const calls = [];
  const base = createChoroQueries({ store });
  return {
    calls,
    choro: {
      ...base,
      // guardT1Loss 必须原样透给真 T0：这条守卫的意义就在于「自动刷新那条路会拒绝」，
      // 外壳把它吞掉就等于测了一个不存在的实现。
      runT0Apply: ({ repoRoot, guardT1Loss = false }) => {
        calls.push(repoRoot);
        if (throwOnRun) throw new Error("磁盘只读（模拟）");
        return runChoroT0({ repoRoot, store, apply: true, guardT1Loss });
      }
    }
  };
}

// 造一个「代码已变」的仓库：登记时的 git_baseline 与当前 HEAD 不同。
function driftRepo(store, mark = "") {
  const root = makeRepo(store, mark);
  writeFileSync(join(root, "src", "c.js"), "export const c = () => 2;\n", "utf8");
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "drift", "--no-gpg-sign"], { cwd: root, stdio: "pipe" });
  return root;
}

test("/choro/repos 自动重跑：开关关着时即使过期也一次都不刷（默认行为逐字节不变）", async () => {
  const store = createStore(":memory:");
  const root = driftRepo(store);
  try {
    const { calls, choro } = countingChoro(store);
    const { routes } = setup({ config: { chorographyEnabled: true }, choro });
    const url = "/api/dsh-mneme/choro/repos?repo=1";
    const REPOS_PATH = "/api/dsh-mneme/choro/repos";
    const res = await invoke(handler(routes, REPOS_PATH), url);
    assert.equal(res.status, 200);
    assert.equal(res.body.repos[0].staleReason, "git", "前提：这个仓库确实是过期的");
    assert.equal(calls.length, 0, "开关缺省 false 时读侧一个字节都不许动用户的工作区");
    assert.equal(res.body.autoRefreshed, false);
  } finally {
    rmTempBestEffort(root);
  }
});

test("/choro/repos 自动重跑：开关开 + ?repo= 点名且 git 过期 → 刷一次，回执按新基线说话", async () => {
  const store = createStore(":memory:");
  const root = driftRepo(store);
  try {
    const { calls, choro } = countingChoro(store);
    const { routes } = setup({ config: { chorographyEnabled: true, chorographyAutoRefresh: true }, choro });
    const url = "/api/dsh-mneme/choro/repos?repo=1";
    const REPOS_PATH = "/api/dsh-mneme/choro/repos";
    const res = await invoke(handler(routes, REPOS_PATH), url);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1, "开关开 + 指名 + git 过期 = 恰好刷这一个仓库");
    assert.equal(res.body.autoRefreshed, true);
    // 刷完必须改成不 stale：否则面板刚刷完就显示「代码已变」，等于谎报一次失败。
    assert.equal(res.body.repos[0].stale, false);
    assert.equal(res.body.repos[0].staleReason, null);
  } finally {
    rmTempBestEffort(root);
  }
});

test("/choro/repos 自动重跑：不 stale 或没点名 ?repo= 时都不刷（一次面板加载不能扫全库）", async () => {
  const store = createStore(":memory:");
  const cleanRoot = makeRepo(store, "clean");
  try {
    const { calls, choro } = countingChoro(store);
    const { routes } = setup({ config: { chorographyEnabled: true, chorographyAutoRefresh: true }, choro });
    const plain = "/api/dsh-mneme/choro/repos";
    const clean = await invoke(handler(routes, plain), plain);
    assert.equal(clean.status, 200);
    assert.equal(calls.length, 0, "staleReason 为 null → 没有刷的理由");

    // 造第二个过期仓库，但请求不带 ?repo=：列表路径一个都不许刷。
    const drifted = driftRepo(store, "drifted");
    try {
      const listed = await invoke(handler(routes, plain), plain);
      assert.equal(listed.body.repos.length, 2);
      assert.equal(calls.length, 0, "没点名就不刷：否则打开面板要付 N 次全仓扫描");
      assert.equal(listed.body.autoRefreshed, false);
      assert.ok(listed.body.repos.some((r) => r.staleReason === "git"), "过期信号照常回，只是不顺手刷");
    } finally {
      rmTempBestEffort(drifted);
    }
  } finally {
    rmTempBestEffort(cleanRoot);
  }
});

test("/choro/repos 自动重跑失败：读照常 200、数据在、错误进 autoRefreshError", async () => {
  const store = createStore(":memory:");
  const root = driftRepo(store);
  try {
    const { calls, choro } = countingChoro(store, { throwOnRun: true });
    const { routes } = setup({ config: { chorographyEnabled: true, chorographyAutoRefresh: true }, choro });
    const url = "/api/dsh-mneme/choro/repos?repo=1";
    const REPOS_PATH = "/api/dsh-mneme/choro/repos";
    const res = await invoke(handler(routes, REPOS_PATH), url);
    // 读是主诉求、刷新是附赠：打成 500 等于「顺手的事没办成，正事也不给办」。
    assert.equal(res.status, 200, "刷新失败不许把读请求打成 500");
    assert.equal(calls.length, 1);
    assert.equal(res.body.autoRefreshed, false);
    assert.match(res.body.autoRefreshError, /磁盘只读/);
    assert.equal(res.body.repos.length, 1, "数据必须还在");
    assert.equal(res.body.repos[0].staleReason, "git", "没刷成功就照实说过期");
  } finally {
    rmTempBestEffort(root);
  }
});

// 自动刷新碰上已富化的仓库：不许动手。这条是「静默降级」的正对面——读页本来
// 只是个浏览动作，却会替用户把语义段和 claims 一起清掉，而屏幕上没有任何提示。
// 现在它变成一次主动拒绝，且拒绝与失败分开报（autoRefreshSkipped vs autoRefreshError）。
test("/choro/repos 自动重跑：仓库里有富化页时主动跳过，不动字节、不说成失败", async () => {
  const store = createStore(":memory:");
  const root = driftRepo(store);
  try {
    const repo = store.choroRepoByRoot(root);
    const page = store.choroPageBySlug(repo.id, "src");
    store.markChoroPageEnriched(page.id, "2026-11-01T00:00:00.000Z", null);
    const pagePath = join(root, page.rel_path);
    writeFileSync(pagePath, `${readFileSync(pagePath, "utf8")}\n<!-- CHORO:T1:START -->\n## 架构\n\na.js 是入口。\n<!-- CHORO:T1:END -->\n`, "utf8");
    const before = readFileSync(pagePath, "utf8");

    const { calls, choro } = countingChoro(store);
    const { routes } = setup({ config: { chorographyEnabled: true, chorographyAutoRefresh: true }, choro });
    const REPOS_PATH = "/api/dsh-mneme/choro/repos";
    const res = await invoke(handler(routes, REPOS_PATH), `${REPOS_PATH}?repo=1`);

    assert.equal(res.status, 200);
    assert.equal(calls.length, 0, "有富化页时连 T0 都不该被叫起来");
    assert.equal(res.body.autoRefreshed, false);
    assert.equal(res.body.autoRefreshSkipped, "t1-loss", "跳过要和失败分开报");
    assert.equal(res.body.autoRefreshError, undefined, "主动拒绝不是错误");
    assert.match(res.body.autoRefreshSkipNote, /1 页/, "说清为什么没做");
    assert.equal(readFileSync(pagePath, "utf8"), before, "页一字节未动");
    assert.equal(res.body.repos[0].staleReason, "git", "没刷就照实说过期");
    assert.equal(res.body.repos[0].enrichedPages, 1, "面板要靠这个数解释原因");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

// 库里的账和磁盘对不上时（status 还是 skeleton、页里却有 T1 段），T0 的读盘判断
// 会抛 would-drop-t1。到这一层仍按「主动跳过」回，绝不报成刷新失败。
test("/choro/page 自动重跑：T0 拒绝（would-drop-t1）时回 skipped 而非 error", async () => {
  const store = createStore(":memory:");
  const root = driftRepo(store);
  try {
    const repo = store.choroRepoByRoot(root);
    const page = store.choroPageBySlug(repo.id, "src");
    const pagePath = join(root, page.rel_path);
    // 故意不改库里的 status：模拟「有人手改了 MD」这类账实不符。
    writeFileSync(pagePath, `${readFileSync(pagePath, "utf8")}\n<!-- CHORO:T1:START -->\n## 架构\n\na.js 是入口。\n<!-- CHORO:T1:END -->\n`, "utf8");
    const before = readFileSync(pagePath, "utf8");

    const { choro } = countingChoro(store);
    const { routes } = setup({ config: { chorographyEnabled: true, chorographyAutoRefresh: true }, choro });
    const PAGE_PATH = "/api/dsh-mneme/choro/page";
    const res = await invoke(handler(routes, PAGE_PATH), `${PAGE_PATH}?repo=1&slug=src`);

    assert.equal(res.status, 200);
    assert.equal(res.body.autoRefreshed, false);
    assert.equal(res.body.autoRefreshSkipped, "t1-loss");
    assert.equal(res.body.autoRefreshError, undefined);
    assert.match(res.body.autoRefreshSkipNote, /富化/, "T0 那句人话原样透出去");
    assert.equal(readFileSync(pagePath, "utf8"), before, "拒绝发生在写盘之前");
    assert.ok(res.body.page.content.includes("CHORO:T1:START"), "页正文照常回，别把读也带坏");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

// /choro/page 是面板主路径，也是「读地志页时发现代码变了」那句文案的真正时刻。
// 顶栏「代码已变」徽章读 state.repo.stale —— 回执里没有 repo 这份数据，徽章永远不亮。
test("/choro/page 回执带 repo.stale/staleReason，并在这条读路径上自动重跑", async () => {
  const store = createStore(":memory:");
  const root = driftRepo(store);
  try {
    const { calls, choro } = countingChoro(store);
    const url = "/api/dsh-mneme/choro/page?repo=1&slug=src";
    const PAGE_PATH = "/api/dsh-mneme/choro/page";

    const offSetup = setup({ config: { chorographyEnabled: true }, choro });
    const off = await invoke(handler(offSetup.routes, PAGE_PATH), url);
    assert.equal(off.status, 200);
    assert.equal(off.body.repo.stale, true, "徽章的数据源：开关关着也要照实报过期");
    assert.equal(off.body.repo.staleReason, "git");
    assert.equal(off.body.autoRefreshed, false);
    assert.equal(calls.length, 0);

    const onSetup = setup({ config: { chorographyEnabled: true, chorographyAutoRefresh: true }, choro });
    const on = await invoke(handler(onSetup.routes, PAGE_PATH), url);
    assert.equal(on.status, 200);
    assert.equal(calls.length, 1, "页读路径点名的就是这一个仓库");
    assert.equal(on.body.autoRefreshed, true);
    assert.equal(on.body.repo.stale, false, "刷完页面与 repo 徽章必须同一时刻一致");
    assert.ok(on.body.page.content.includes("## 文件清单"), "页正文照常回");
  } finally {
    rmTempBestEffort(root);
  }
});
// --- /choro/claims（claim 粒度失效，Grounded Claims）-----------------------
// 锁的是一条态度：算不出来 ≠ 没事。基线认不出时必须 anchorStale，不许回一张空清单
// 让面板显示「全部结论都还准」——那是 #607 同类的假成功。

test("/choro/claims 在册且 policy open，四层闸与其余读路由一致", async () => {
  const off = setup({});
  const route = handler(off.routes, "/api/dsh-mneme/choro/claims");
  assert.ok(route, "/choro/claims 在册");
  assert.equal(route.policy, "open");
  const a = await invoke(route, "/api/dsh-mneme/choro/claims");
  assert.equal(a.status, 503, "queries 缺装配 → 503");

  const disabled = setup({ config: { chorographyEnabled: false }, choro: createChoroQueries({ store: createStore(":memory:") }) });
  const b = await invoke(handler(disabled.routes, "/api/dsh-mneme/choro/claims"), "/api/dsh-mneme/choro/claims");
  assert.equal(b.status, 409, "开关关 → 409");
  assert.equal(b.body.error, "disabled");
});

test("/choro/claims：快乐路径带页清单与 totals；未知 repo 404", async () => {
  const store = createStore(":memory:");
  const root = makeRepo(store);
  try {
    const { routes } = setup({ config: { chorographyEnabled: true }, choro: createChoroQueries({ store }) });
    const route = handler(routes, "/api/dsh-mneme/choro/claims");
    const repoId = store.db.prepare("SELECT id FROM choro_repos LIMIT 1").get().id;
    const r = await invoke(route, `/api/dsh-mneme/choro/claims?repo=${repoId}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.repo && r.body.repo.id === repoId);
    assert.equal(typeof r.body.head, "string");
    assert.ok(Array.isArray(r.body.pages), "页清单要在——面板靠它说「这页没问题」");
    assert.ok(r.body.totals && Number.isInteger(r.body.totals.claims));
    assert.equal(r.body.clean, true, "刚跑完 T0，基线就是 HEAD");

    const missing = await invoke(route, "/api/dsh-mneme/choro/claims?repo=999999");
    assert.equal(missing.status, 404);
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});