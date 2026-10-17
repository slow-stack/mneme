import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const run = (a) => execFileSync("git", a, { cwd: process.cwd(), encoding: "utf8" });
run(["add", "-A"]);
const msg = [
  "fix(api): 超限请求体回 413，而不是把画像/规则清空",
  "",
  "评审发现的真问题：readBody 超限时回空串，parseBody 把它变成 {}，而 /profile、",
  "/rules、/persona 的 PUT 把「字段缺失」当成「用户要清空」——一个 5 MiB 的请求",
  "就能把画像、规则、人格卡静默清掉。这不是 400，是数据损坏。",
  "",
  "- readBody 超限回 null 并在数据到达时直接回 413；两张数据面同语义。",
  "- 21 处调用点在碰任何 store 之前统一早退。",
  "- 测试改成断言明确 413 + 库里没新增 + 画像/规则原样保留（旧用例只断言",
  "  notEqual(200)，而 /create 成功是 201——写进去了也能过）。",
  "- docs-config-keys 收紧：父路径回退改成显式白名单（否则往 writeAdmission",
  "  加子键、文档只提父名也能过），lightMode 清单只在那一节里查（否则删掉清单",
  "  某行、图谱表里还留着同名键也能过）。收紧后立刻抓到 actionRunEnabled 不在",
  "  文档清单里，已补。",
  "- release.yml 权限收到 job 级：id-token 只给 publish，contents: write 只给",
  "  release；工作流级退回 contents: read。security.yml 的 fail-on-vuln 与",
  "  provenance 各加一条配置锁（test/workflow-guards.test.js）。",
  "- 文档对齐：SECURITY.md 的零网络承诺改成条件表述；README 的 reclaim 改成",
  "  「只有 POST、只读 body」；AGENTS 的写入准入补全三个前置条件。",
].join("\n");
const f = join(tmpdir(), "mneme-cr.txt");
writeFileSync(f, msg);
run(["commit", "-F", f]);
console.log(run(["log", "-1", "--format=%h %s"]));
run(["push", "origin", "refactor/route-auth-policy"]);
console.log("pushed");
