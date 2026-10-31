// 两个 overrides 存在的唯一理由是 osv-scanner 的红灯，而红灯的判据是**已提交的
// lockfile**——所以这里锁的是 lockfile 的解析结果，不是 node_modules 里装了什么。
// 2026-10-31 的现场：同一条 lockfile 在 08:36 是绿的，04:42 那次 push 却是红的，
// 中间没有任何依赖变更——上游在 23:09 发了两条新公告（glob 超时后仍继续遍历、
// minimatch globparts 放大 DoS）。换句话说，这个文件里的断言会**因为上游多一条公告
// 而变红**，那是它应该做的事：红在本地，比红在 main 上便宜。
//
// 依赖链只有一条，且全部是 devDependency：
//   c8@12 → test-exclude@8 → glob + minimatch
// 两个上游包都已经是 npm 上的最新版、其 deps 仍写旧范围，所以只能在本仓库抬 pin。
// 一旦上游跟上、这条链不再解析到旧版本，下面的 overrides 断言就会失败——那时应当
// 删掉这两条 overrides，而不是把断言删掉。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(PKG_ROOT, "package-lock.json"), "utf8"));

// 公告给出的修复下限。低于它 = osv-scanner 会在 main 上红，这里先红。
const FLOORS = {
  glob: { fixed: [14, 0, 2], cve: "CVE-2026-118773 / GHSA-3g3m-2fjr-6pw4" },
  minimatch: { fixed: [11, 0, 1], cve: "CVE-2026-118764 / GHSA-g3hv-75wg-m249" },
};

function parseVersion(v) {
  return String(v).split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
}

function gte(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

test("glob 与 minimatch 在 lockfile 里都解析到公告的修复下限之上", () => {
  for (const [name, { fixed, cve }] of Object.entries(FLOORS)) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry, `lockfile 里应当有 node_modules/${name}`);
    const actual = parseVersion(entry.version);
    assert.ok(
      gte(actual, fixed),
      `${name} 解析成 ${entry.version}，低于 ${cve} 的修复下限 ${fixed.join(".")}——osv-scanner 会在 main 上红`,
    );
  }
});

// overrides 必须是**精确版本**，不能是 ^ / ~ 范围。
// 范围等于把选择权交回解析器：下一次上游发版，lockfile 会在某个「只更新 lockfile」
// 的 PR 里悄悄漂走，而红绿灯本该由人决定。brace-expansion 那次（PR #345）就是精确号。
test("overrides 是精确版本号，不是范围", () => {
  for (const name of Object.keys(FLOORS)) {
    const pin = pkg.overrides?.[name];
    assert.equal(typeof pin, "string", `package.json overrides 里应当钉住 ${name}`);
    assert.ok(
      /^\d+\.\d+\.\d+$/.test(pin),
      `${name} 的 override 应写精确版本（如 14.0.3），实际是 ${JSON.stringify(pin)}`,
    );
  }
});

// 钉版本是权宜之计，不是永久配置：这条链还在（c8 → test-exclude → glob）就说明
// 上游仍会解析到旧范围，overrides 必须留着。上游哪天收了，这条会红，提示来删 pin。
test("devDependency 链仍在：c8 → test-exclude → glob", () => {
  const c8 = lock.packages["node_modules/c8"];
  assert.ok(c8, "lockfile 里应当有 c8");
  assert.ok(c8.dependencies?.["test-exclude"], "c8 仍应依赖 test-exclude");
  const testExclude = lock.packages["node_modules/test-exclude"];
  assert.ok(testExclude, "lockfile 里应当有 test-exclude");
  assert.ok(
    testExclude.dependencies?.glob,
    "test-exclude 仍应依赖 glob——它一旦不再依赖，glob/minimatch 两条 overrides 就可以删了",
  );
});
