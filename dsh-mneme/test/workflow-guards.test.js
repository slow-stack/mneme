// 工作流配置的回归锁：安全扫描的姿态不能悄悄退回「只提醒」。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

test("security.yml 的 osv-scanner 保持 fail-on-vuln: true", () => {
  // 2026-10 审计：这里原本是 false（纯提醒，PR 上永远是绿的）。改回 false 就等于
  // 「有已知漏洞也不红」，而测试目录原本没有任何东西会察觉这件事。
  const yml = readFileSync(path.join(repoRoot, ".github", "workflows", "security.yml"), "utf8");
  assert.match(yml, /fail-on-vuln:\s*true/, "osv-scanner 必须保持 fail-on-vuln: true");
  assert.doesNotMatch(yml, /fail-on-vuln:\s*false/, "不得退回只上传 SARIF 不拦的档位");
});

test("release.yml 的 publish job 持有 id-token 权限（provenance 前提）", () => {
  // --provenance 没有 id-token: write 会直接失败；同时这条也钉住「权限只发给
  // publish」——工作流级 id-token 会让 verify/test 也拿到 OIDC 能力。
  const yml = readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
  assert.match(yml, /npm publish[^\n]*--provenance/, "publish 必须带 --provenance");
  assert.match(yml, /id-token:\s*write/, "publish job 需要 id-token: write");
});
