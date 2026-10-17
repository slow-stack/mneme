import test from "node:test";
import assert from "node:assert/strict";
import { businessCommandOf, activityKey, tallyActivities } from "../src/pipeline-activities.js";

// 这组测试守两件事：
//   ① 分组结果落在「人能扫」的量级（业务命令才进清单，shell 语法不进）
//   ② 🔴 隐私硬规则：位置参数一律丢弃——回执要显示在界面上，而完整命令行里
//      几乎必然含绝对路径（路径里含本机用户名）。这一条比功能本身重要。

test("业务命令：抽出 {动词, 子命令, 旗标}", () => {
  assert.deepEqual(businessCommandOf("git status"), { verb: "git", sub: "status", flags: [] });
  assert.deepEqual(businessCommandOf("git push origin main"), { verb: "git", sub: "push", flags: [] });
  assert.deepEqual(businessCommandOf("gh pr merge --rebase"), { verb: "gh", sub: "pr", flags: ["--rebase"] });
  assert.deepEqual(businessCommandOf("npm test"), { verb: "npm", sub: "test", flags: [] });
  // 子命令可空
  assert.deepEqual(businessCommandOf("npm"), { verb: "npm", sub: "", flags: [] });
});

test("🔴 隐私硬规则：位置参数一律丢弃，只留动词/子命令/旗标", () => {
  // 实测里真实出现过这种形状：路径含本机用户名。回执绝不能把它带出去。
  const r = businessCommandOf('set-location "c:\\users\\somebody\\desktop\\proj"; git commit -m "x"');
  // 整段里第一个可识别的是 set-location（不在名单）→ 由分段器处理；这里直接测 git commit
  assert.equal(businessCommandOf("git commit -m \"修好了\"").verb, "git");
  assert.deepEqual(businessCommandOf("git commit -m \"修好了\"").flags, ["-m"]);
  // 位置参数（文件名、分支名、路径）一个都不该出现在结果里
  const withPath = businessCommandOf("git add src/foo.js C:/Users/name/x.md");
  assert.equal(JSON.stringify(withPath).includes("Users"), false, "路径绝不能出现在结果里");
  assert.equal(JSON.stringify(withPath).includes("foo.js"), false, "文件名是位置参数，该丢");
});

test("🔴 旗标里的路径参数也要挡住（--file=C:/x 这种）", () => {
  const r = businessCommandOf("git commit --file=C:/Users/name/msg.txt -m x");
  assert.equal(JSON.stringify(r).includes("Users"), false, "带路径的旗标不许原样带出");
  // 纯旗标照常留
  assert.deepEqual(businessCommandOf("gh pr list --state all").flags.includes("--state"), true);
});

test("非业务命令一律不产清单项（shell 语法不是活动）", () => {
  // 实测里密度最高的就是这些——它们不是"做了什么"，是句子成分
  for (const noise of [
    'write-output "=== 检查 ==="',
    "select-object -first 10",
    "foreach-object { $_ }",
    "echo hello",
    "}",
    "if (test-path x) { }",
    "$erroractionpreference='continue'",
    "cd C:/some/dir"
  ]) {
    assert.equal(businessCommandOf(noise), null, `${noise} 不该进清单`);
  }
});

test("分段：一条命令里的多个业务动作分别计入", () => {
  const r = tallyActivities([{ command: 'cd C:/x; git status; echo "---"; npm test' }]);
  const keys = r.activities.map((a) => a.key).sort();
  assert.deepEqual(keys, ["git status", "npm test"], "cd 与 echo 应被排除");
  assert.equal(r.shellNoise, 2, "shell 噪音要单独计数，不能与业务动作混为一谈");
  assert.equal(r.totalSegments, 4);
});

test("计数与排序：按出现次数降序，同次数按名字", () => {
  const r = tallyActivities([
    { command: "git status" },
    { command: "npm test; git status" },
    { command: "git status && gh pr list" }
  ]);
  assert.equal(r.activities[0].key, "git status");
  assert.equal(r.activities[0].count, 3);
  assert.equal(r.businessSegments, 5);
});

test("旗标并集：同一动作的不同旗标合并展示，且截断", () => {
  const r = tallyActivities([
    { command: "gh pr merge --rebase" },
    { command: "gh pr merge --squash" }
  ]);
  assert.equal(r.activities.length, 1);
  assert.equal(r.activities[0].count, 2);
  assert.deepEqual(r.activities[0].flags.sort(), ["--rebase", "--squash"]);
});

test("🔴 回归：脚本路径不得被当成子命令（端到端实测抓到的真 bug）", () => {
  // 实测里出现过 `node d:\dsh\.dsh\_tmp-mo-probe.mjs` —— 原实现把整条路径当 sub，
  // 于是回执里带出本机路径（可能含用户名）。这正是隐私红线要挡的东西。
  const r = businessCommandOf('node d:\\dsh\\.dsh\\_tmp-probe.mjs');
  assert.equal(r.verb, "node");
  assert.equal(JSON.stringify(r).includes("dsh"), false, "路径绝不能出现在结果里");
  assert.equal(r.sub, "", "路径不是子命令，宁可留空");
  // 相对路径同理
  const r2 = businessCommandOf("node test/pipeline-nudge.test.js --test");
  assert.equal(r2.sub, "", "文件名不是子命令");
  assert.deepEqual(r2.flags, ["--test"]);
});

test("🔴 回归：`git -C <path> log` 要扫到 log，而不是把 `-C` 的值当子命令", () => {
  // 实测出现过 `git (join-path -C --oneline --porcelain` 这种读不懂的清单行。
  const r = businessCommandOf('git -C C:/some/dir log --oneline -3');
  assert.equal(r.verb, "git");
  assert.equal(r.sub, "log", "子命令在 -C 的值之后，必须扫描而不是取第一个");
  assert.equal(JSON.stringify(r).includes("some"), false, "路径不许带出");
});

test("子命令形状窄：含 $、括号、引号、长串的一律不算", () => {
  for (const bad of ["$p", "$(Get-Item", "C:/x/y", "d:\\a", "averyveryverylongsubcommandname", "'\"", "{", "@{"]) {
    const r = businessCommandOf(`git ${bad} status`);
    // 要么扫不到（sub 空），要么扫到 status；无论如何不能是那个坏值
    assert.equal(r.sub === bad.toLowerCase(), false, `${bad} 不该被当成子命令`);
  }
});

test("旗标里带 = 或路径的一律丢（--file=C:/x 这种）", () => {
  const r = businessCommandOf("git commit --file=C:/Users/name/msg.txt -m x");
  assert.equal(JSON.stringify(r).includes("Users"), false);
  assert.deepEqual(r.flags, ["-m"], "带值/路径的旗标整个丢掉");
});

test("重定向与引号不影响识别", () => {
  assert.deepEqual(businessCommandOf('npm test 2>&1 | Select-String "x"'), { verb: "npm", sub: "test", flags: [] });
  assert.equal(businessCommandOf("'git' 'status'").verb, "git");
});

test("坏输入不抛：空、非串、缺字段一律安全返回", () => {
  for (const bad of [null, undefined, "", "   ", 0, {}]) {
    assert.equal(businessCommandOf(bad), null);
  }
  for (const bad of [null, undefined, [], [{}], [{ command: null }], [0, "x"]]) {
    const r = tallyActivities(bad);
    assert.deepEqual(r.activities, []);
    assert.equal(typeof r.shellNoise, "number");
  }
  assert.equal(activityKey(null), "");
});

test("产出可读：key 是 `动词 子命令`，trim 过", () => {
  assert.equal(activityKey({ verb: "git", sub: "status" }), "git status");
  assert.equal(activityKey({ verb: "npm", sub: "" }), "npm");
});

test("没有子命令时用第一个旗标当键：node --test 与 node --check 不能并成一行", () => {
  // 端到端实测里 16 次 node 调用被并成一条 —— 但它们语义不同（跑测试 vs 查语法）。
  const r = tallyActivities([
    { command: "node --test x.test.js" },
    { command: "node --test y.test.js" },
    { command: "node --check src/foo.js" }
  ]);
  const keys = r.activities.map((a) => a.key).sort();
  assert.deepEqual(keys, ["node --check", "node --test"], "旗标区分语义，该分开");
  assert.equal(r.activities.find((a) => a.key === "node --test").count, 2);
});

test("旗标只当补充：有子命令时键仍以子命令为准", () => {
  const k = activityKey({ verb: "git", sub: "status", flags: ["-C", "--porcelain"] });
  assert.equal(k, "git status", "-C 后面本来跟着被丢弃的路径，不该挤进键里");
});
