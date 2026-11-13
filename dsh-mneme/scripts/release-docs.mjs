// 发布准备里「核对 SECURITY.md 支持版本表」的单一实现。
//
// 这里原本还有一件事：往两份 README 的版本表插占位行。2026-11-13 起两份 README
// 都不再承载版本历史——根 README 是入口页，只回答「它是什么、怎么装、凭什么信」；
// 每版改了什么由 CHANGELOG 与 GitHub Releases 承担。表格既然不在了，插行逻辑也一起
// 删掉：留着它只会变成「拿到一份没有版本表的 README，打印跳过」，正是这个模块当初
// 注释里记的那类静默失效（脚本对一个字节没改的 README 报告「无需改动」）。
//
// 为什么这个模块要独立存在：入口 scripts/release-prep.mjs 在仓库根、import 即执行，
// 测不了。核对逻辑收在共用模块里，测试才能拿真实 SECURITY.md 断言。

/** 取某一节（到下一个同级 ## 标题为止）。用节而不是全文 grep：别处也有版本号。 */
export function sectionOf(text, heading) {
  const start = text.indexOf(heading);
  if (start < 0) return null;
  const rest = text.slice(start + heading.length);
  const end = rest.search(/\r?\n## /);
  return end >= 0 ? rest.slice(0, end) : rest;
}

/**
 * 核对 SECURITY.md 的支持版本表首行是否等于 package.json 的 major.minor。
 *
 * 只核对、不改写。跨 minor 发版时整张表要向下挪一格（0.10.x 活跃 / 0.9.x 尽力维护 /
 * < 0.9.0 不支持），连停止维护那段措辞一起挪——这是维护策略的判断，机器替人写很容易
 * 写出「0.9.x 已停止支持」这类真事故。所以入口硬失败、把话说明白，由人改。
 *
 * 为什么必须在这里拦：dsh-mneme/test/security-doc.test.js 也锁同一件事，但那条锁在
 * 「PR 提交之后」才跑。脚本先拦，坏 PR 根本不会开出来。
 */
export function checkSupportTable(text, version) {
  const [major, minor] = version.split(".");
  const expected = `${major}.${minor}.x`;
  // 预发布版（0.14.0-beta.1）不是「受支持的版本」，支持表不该跟着它挪格。
  // 挪了等于对外宣称 0.14 已经在活跃维护——而 beta 随时可能推倒重来。
  // 这里显式标 skipped，调用方据此换一句人话；**不静默通过**：skipped 是返回值的一部分。
  if (version.includes("-")) {
    return { ok: true, expected, problems: [], skipped: "prerelease" };
  }
  const problems = [];
  for (const [heading, label] of [
    ["## Supported Versions", "英文"],
    ["## 支持版本", "中文"],
  ]) {
    const body = sectionOf(text, heading);
    if (body === null) {
      problems.push(`${label}表：找不到「${heading}」一节`);
      continue;
    }
    const rows = body.split(/\r?\n/).filter((l) => /^\|\s*[\d<]/.test(l));
    if (!rows.length) {
      problems.push(`${label}表：没解析出任何版本行（表格形状变了？）`);
      continue;
    }
    const found = rows[0].split("|")[1].trim();
    if (found !== expected) problems.push(`${label}表首行写的是 ${found}，应为 ${expected}`);
  }
  return { ok: problems.length === 0, expected, problems, skipped: null };
}
