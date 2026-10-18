// SECURITY.md 的两处声明会随时间变成谎话，而且没人会注意到：
// 一是「Supported Versions」表——0.9.0 发了两个月它还在写 0.8.x 活跃开发中（#SECURITY 审计实测）；
// 二是文件里的相对链接——docs/DAEMON.md 实际在 dsh-mneme/docs/ 下，链接指错了也没人点。
// 这里把两件事都锁住：版本行必须等于 package.json 的 major.minor，链接必须真的能 stat 到。
// 不锁「正文里出现的版本号」——历史审计节记录的是过去的事实，写死版本号在那里是对的。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createApi } from "../src/api.js";

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(pkgRoot);
const docPath = path.join(repoRoot, "SECURITY.md");
const doc = readFileSync(docPath, "utf8");

// package.json 的 version → 支持表里应当出现的那一行（"0.9.0" → "0.9.x"）。
const { version } = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
const [major, minor] = version.split(".");
const expectedVersionRow = `${major}.${minor}.x`;

// 取某一节（到下一个同级 ## 标题为止）。用节而不是全文 grep：
// 历史审计节里也有 "v0.x.y" 字样，全文匹配会假绿。
function section(heading) {
  const start = doc.indexOf(heading);
  assert.ok(start >= 0, `SECURITY.md 里应有「${heading}」一节`);
  const rest = doc.slice(start + heading.length);
  const end = rest.search(/\r?\n## /);
  return end >= 0 ? rest.slice(0, end) : rest;
}

test("SECURITY.md 的支持版本表跟着 package.json 走（中英各一份）", () => {
  for (const heading of ["## Supported Versions", "## 支持版本"]) {
    const body = section(heading);
    // 表第一行就是「当前支持」的那一行；锁它，别锁整表（历史版本行本来就该在）。
    const rows = body.split(/\r?\n/).filter((l) => /^\|\s*[\d<]/.test(l));
    assert.ok(rows.length >= 2, `${heading} 的版本表应至少两行，实际 ${rows.length} 行`);
    const current = rows[0].split("|")[1].trim();
    assert.equal(current, expectedVersionRow,
      `${heading} 的首行应写 ${expectedVersionRow}（package.json 为 ${version}），实际写了 ${current}`);
  }
});

test("SECURITY.md 的版本表在两种语言之间是同一张表", () => {
  const versions = (heading) => section(heading)
    .split(/\r?\n/)
    .filter((l) => /^\|\s*[\d<]/.test(l))
    .map((l) => l.split("|")[1].trim());
  assert.deepEqual(versions("## 支持版本"), versions("## Supported Versions"),
    "中文表与英文表的版本行必须逐行一致，否则读者会看到两个不同的支持范围");
});

test("SECURITY.md 里的相对链接都能落到真实文件", () => {
  // 链接从仓库根解析（README 与 SECURITY.md 都在根上）。
  // 只查相对路径：外链、锚点、mailto 不归这里管。
  const links = [...doc.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((href) => !/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(href))
    .map((href) => href.split("#")[0])
    .filter(Boolean);
  assert.ok(links.length >= 2, `应解析出至少 2 条相对链接，实际 ${links.length}——正则失配会让这个用例变成永真`);
  const broken = links.filter((href) => !existsSync(path.resolve(repoRoot, href)));
  assert.deepEqual(broken, [], "这些相对链接指向了不存在的文件：" + broken.join(", "));
});

test("SECURITY.md 不再把供应商写成已停用的那家", () => {
  // 依赖扫描的实况是 gitleaks + dependency-review + OSV-Scanner + Dependabot，
  // 文档里曾长期写着第三方商业扫描平台（该平台并不在 CI 里跑）。
  assert.ok(!/OrbisAI/i.test(doc), "依赖扫描工具应写 CI 里真实在跑的那几个，不能留旧供应商名");
});

// 安全模型节那两张路由清单是「从代码抄出来的」，抄错了没人会发现：
// 实测就漏过 /persona（token-write，GET 开放）与 /conflicts（token，只读也要 token）。
// 这里不重跑鉴权逻辑（那是 route-policy.test.js 的事），只锁「文档清单 == 代码里的 policy 声明」：
// 以真实装配出来的路由为准，双向比对——文档少写、多写、写错边，都红。
function declaredRoutes() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const mounted = [];
  createApi(
    { webServer: { register(route) { mounted.push(route); return () => {}; } } },
    service, settings, { add() {}, remove() {}, list: () => [] }, null, undefined, "secret-token"
  );
  // 路由名去掉公共前缀，文档里写的是 /export 而不是 /api/dsh-mneme/export。
  return mounted.map((route) => ({
    name: route.path.replace("/api/dsh-mneme", "") || "/",
    policy: route.policy
  }));
}

// 从清单行里抠出反引号包着的路由。只认「可选方法 + 斜杠开头」的形状，
// 这样 `GET`/`HEAD` 这种纯方法名不会被当成路径。
function routesInBullet(line) {
  const out = [];
  for (const m of line.matchAll(/`([^`]+)`/g)) {
    const hit = m[1].trim().match(/^(?:GET|HEAD|POST|PUT|PATCH|DELETE)?\s*(\/\S*)$/);
    if (hit) out.push(hit[1]);
  }
  return out;
}

function bullet(prefix) {
  const line = doc.split(/\r?\n/).find((l) => l.startsWith(prefix));
  assert.ok(line, `SECURITY.md 里应有以「${prefix}」开头的清单行`);
  return routesInBullet(line);
}

// 文档里的 /semantic/graph/* 覆盖代码里的 /semantic/graph/ego 与 /semantic/graph/entity-attrs。
function covers(docEntry, name) {
  if (docEntry === name) return true;
  return docEntry.endsWith("/*") && name.startsWith(docEntry.slice(0, -1));
}

test("SECURITY.md 的开放读清单与代码里的 policy 声明一致", () => {
  const open = declaredRoutes().filter((r) => r.policy === "open" || r.policy === "token-write");
  for (const prefix of ["- **Open reads", "- **开放读"]) {
    const listed = bullet(prefix);
    const missing = open.filter((r) => !listed.some((e) => covers(e, r.name))).map((r) => r.name);
    assert.deepEqual(missing, [], `${prefix} 漏了这些实际开放的路由：${missing.join(", ")}`);
    const stale = listed.filter((e) => !open.some((r) => covers(e, r.name)));
    assert.deepEqual(stale, [], `${prefix} 写了代码里并不开放的路由：${stale.join(", ")}`);
  }
});

test("SECURITY.md 的受门控清单与代码里的 policy 声明一致", () => {
  const gated = declaredRoutes().filter((r) => r.policy === "token" || r.policy === "token-write");
  for (const prefix of ["- **Gated routes", "- **受门控的路由"]) {
    const listed = bullet(prefix);
    const missing = gated.filter((r) => !listed.some((e) => covers(e, r.name))).map((r) => r.name);
    assert.deepEqual(missing, [], `${prefix} 漏了这些实际受门控的路由：${missing.join(", ")}`);
    const stale = listed.filter((e) => !gated.some((r) => covers(e, r.name)));
    assert.deepEqual(stale, [], `${prefix} 写了代码里并不受门控的路由：${stale.join(", ")}`);
  }
});
