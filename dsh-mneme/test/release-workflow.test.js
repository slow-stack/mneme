// .github/workflows/release.yml 的作业依赖锁。
//
// 防的是一类「声明抢跑」：GitHub Release 是对外的「这个版本已发布」，registry 才是唯一事实。
// 2026-10-12 修 Verify published version 假闸门（PR #419）时发现隔壁还有同一处豁口——release
// job 只 needs [verify, test]，于是 publish 真失败（token 失效、registry 拒绝）时 Release 照样
// 建出来：Release 页写着 v0.8.x，registry 上却没有，用户照 Release 装回的是上一个版本。
//
// 三条断言各锁一环，缺一环这类豁口就能重开：
//   1. release 必须等 publish —— 否则「发不出去」和「发出去了」在 Release 页上同形；
//   2. publish 必须含那道阻塞闸门（publish-gate.mjs）—— 否则 release 等的是一个不做校验的空壳，
//      第 1 条形同虚设（改回 `npm view` 一次性查询同样会退回假绿）；
//   3. release 仍要等 verify 与 test —— 免得为了修 1 顺手把版本/CHANGELOG 校验也绕过去。
//
// 工作流是 YAML，但为了三条断言引入 YAML 解析依赖不值得：这里只按缩进取作业块、读它自己的
// needs 行。因此断言落在「内联列表形状」上（`needs: [a, b]`）——有人改成块状列表测试会红，
// 那是真变化，值得人看一眼再改锁，而不是静默失效。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workflowPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows", "release.yml");
const workflow = readFileSync(workflowPath, "utf8");

/** 取一个顶级 job（缩进 2 格的 `name:`）的整块文本，到下一个同级键或文件结尾。 */
function jobBlock(name) {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `release.yml 里找不到 job ${name}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end);
}

/** 读一个 job 块的 `needs:` 内联列表；没有 needs 行返回空数组。 */
function needsOf(name) {
  const line = jobBlock(name).find((l) => /^ {4}needs:\s*\[/.test(l));
  if (!line) return [];
  const inner = line.slice(line.indexOf("[") + 1, line.lastIndexOf("]"));
  return inner.split(",").map((s) => s.trim()).filter(Boolean);
}

test("release 等 publish：发布声明不许抢在真的发出去之前", () => {
  const needs = needsOf("release");
  assert.ok(
    needs.includes("publish"),
    `release 的 needs 必须含 publish（当前 [${needs.join(", ")}]）—— 否则 publish 失败时 Release 仍会建出来`
  );
});

test("release 仍等 verify 与 test：修依赖顺序不该绕开版本与 CHANGELOG 校验", () => {
  const needs = needsOf("release");
  assert.ok(needs.includes("verify"), "release 必须等 verify（版本号与 CHANGELOG 小节）");
  assert.ok(needs.includes("test"), "release 必须等 test");
});

test("publish 内必须跑阻塞闸门：release 等的是一个真做过校验的作业", () => {
  // 只扫非注释行：publish job 的注释里刻意留了那行旧实现（说明它为什么是假绿），
  // 那是文档不是代码——按整块扫会把文档当成复发。
  const code = jobBlock("publish").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.match(
    code,
    /node dsh-mneme\/scripts\/publish-gate\.mjs/,
    "publish job 必须调用 publish-gate.mjs（拿不到版本就非零退出）"
  );
  assert.doesNotMatch(
    code,
    /echo "Published: \$\(npm view/,
    "不要退回命令替换里的 npm view —— 失败不会让 set -e 退出，那是 v0.8.16 的假绿"
  );
});
