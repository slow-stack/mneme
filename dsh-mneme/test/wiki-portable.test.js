// 可移植身份（#581）的纯函数回归锁：URL 归一化的形态表 + 无 remote 的退化链。
// 这层是「身份与位置分家」的地基——归一化漏一种形态，同一仓库在两端就算出两个
// 键，分家就白做了。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeGitUrl, portableKeyFor, hostId } from "../src/wiki/portable.js";

test("normalizeGitUrl：SSH / HTTPS / scp / 大小写归一到同一身份，凭据不进键", () => {
  const expected = "github.com/slow-stack/mneme";
  assert.equal(normalizeGitUrl("git@github.com:slow-stack/mneme.git"), expected);
  assert.equal(normalizeGitUrl("ssh://git@github.com/slow-stack/mneme.git"), expected);
  assert.equal(normalizeGitUrl("https://github.com/slow-stack/mneme"), expected);
  assert.equal(normalizeGitUrl("https://github.com/slow-stack/mneme/"), expected);
  assert.equal(normalizeGitUrl("HTTPS://GitHub.com/Slow-Stack/Mneme.GIT"), expected);
  // token 在 userinfo 里：不进键。泄进库里是一回事，令牌轮换后同一仓库算出
  // 不同键、跨端匹配失效是另一回事，两个都不可接受（#581 的评审预判）。
  assert.equal(normalizeGitUrl("https://user:ghp_token@github.com/slow-stack/mneme.git"), expected);
  assert.equal(normalizeGitUrl(""), null);
  assert.equal(normalizeGitUrl(null), null);
});

test("portableKeyFor：有 remote 用归一化 URL，无 remote 退化根提交哈希（同名仓库不撞键）", () => {
  const root = mkdtempSync(join(tmpdir(), "choro-portable-"));
  try {
    writeFileSync(join(root, "package.json"), "{}\n", "utf8");
    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init", "--no-gpg-sign"], { cwd: root, stdio: "pipe" });
    // 无 remote：退化根提交哈希——跨副本恒定，且与「碰巧同名的别的仓库」天然
    // 区分（issue 提的仓库名退化不能用：重名率太高，第二次登记会吃掉别人的行）。
    const k1 = portableKeyFor(root);
    assert.match(k1, /^git:[0-9a-f]{40}$/, "无 remote 退化 git:<根提交>");
    assert.equal(portableKeyFor(root), k1, "同仓库重复计算恒定");
    execFileSync("git", ["remote", "add", "origin", "git@github.com:slow-stack/mneme.git"], { cwd: root, stdio: "pipe" });
    assert.equal(portableKeyFor(root), "github.com/slow-stack/mneme", "有 remote 时 URL 赢");
    assert.equal(typeof hostId(), "string");
    assert.ok(hostId().length > 0, "hostId 必须非空（位置表的主键一半）");
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 留给系统清理 */ }
  }
});
