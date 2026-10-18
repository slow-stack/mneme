// 两份 README 曾经都写着「默认全离线」「offline by default」「默认零网络依赖」——
// 这与代码默认值相反：autoDream 与 autoSummarize 默认开（src/config.js），
// 两者都把记忆正文交给 ctx.llm.stream(...)（src/dream.js / src/summarize.js）；
// embedProvider 默认还是 "openai"，只有显式改成 "local"（ONNX）才真正离线。
// 一句假话比不写更坏：读者会据此以为装完就能断网用，而它默认会把正文发给宿主模型。
// 所以这里锁两件事：一、绝对离线声明不许回来；二、隐私节必须写出「巩固走宿主模型」这个出站事实——
// 删掉假话后如果什么都不说，误导是一样的。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(pkgRoot);
const rootReadme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
const pkgReadme = readFileSync(path.join(pkgRoot, "README.md"), "utf8");

// 只锁「默认 / 无条件」的说法。带条件的离线表述（把 embedProvider 改成 local、离线巩固论文、
// 运行时离线取件）都是真话，不在这个列表里，否则守卫会把正确写法也判红。
const ABSOLUTE_CLAIMS = [
  "默认全离线",
  "默认零网络依赖",
  "offline by default",
  "Zero network dependency by default",
  "完全离线的语义记忆引擎",
];

function section(text, heading) {
  const start = text.indexOf(heading);
  assert.ok(start >= 0, `README 里应有「${heading}」一节`);
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\r?\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

test("两份 README 都不许再把「离线」写成默认行为", () => {
  for (const [name, text] of [
    ["README.md", rootReadme],
    ["dsh-mneme/README.md", pkgReadme],
  ]) {
    for (const claim of ABSOLUTE_CLAIMS) {
      assert.ok(!text.includes(claim), `${name} 仍含绝对离线声明：${claim}`);
    }
  }
});

test("隐私节必须写出「巩固与摘要走宿主模型」这个出站事实", () => {
  const zh = section(rootReadme, "## 隐私承诺");
  assert.ok(zh.includes("宿主模型"), "中文隐私节应说明巩固与摘要走宿主模型");
  assert.ok(
    zh.includes("autoDream") || zh.includes("autoSummarize"),
    "中文隐私节应点名 autoDream / autoSummarize，否则读者不知道是谁在出站",
  );
  const en = section(rootReadme, "## Privacy");
  assert.ok(
    en.includes("host model"),
    "English Privacy section should disclose that consolidation uses the host model",
  );
});
