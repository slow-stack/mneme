// 发布准备里「在 CHANGELOG 顶部插版本占位节」这一步的单一实现。
//
// 为什么抽成模块而不是留在入口里：入口 scripts/release-prep.mjs 在仓库根、import 即
// 执行，测不了；而这一步恰恰踩过坑——原先的实现在 **CRLF 检出**上用 /^(# Changelog\n\n)/
// 匹配文件头，命中不了于是 replace 退化成 no-op，**脚本却照样打印 ✓**，git status 里
// 什么也看不见。发版时最怕的就是这种假成功（CI 跑在 ubuntu 上是 LF，所以只有本机会中招）。
// 抽出来之后：行尾两种都能吃，匹配不上则**如实回报**，由入口报错退出。
//
// 与 scripts/test-count-sync.mjs 同一个理由：规则收在共用模块里才测得到、也才不会两处各写一份。

/** 取出文本的行尾风格：插入的内容跟着它走，避免把 CRLF 文件混成一半 CRLF 一半 LF。 */
export function detectEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * 在 `# Changelog` 标题之后插入 `## [version] - date` 占位节（幂等：已含该版本则不改）。
 *
 * 返回 `{ok:false, reason}` 而不是静默返回原文——调用方必须能区分「没什么可做」与
 * 「该做但没做成」，后者要报错退出。`reason` 取值：`already-present` / `header-not-found`。
 *
 * @param {string} text CHANGELOG 全文
 * @param {string} version 如 "0.8.13"
 * @param {string} date 如 "2026-10-03"
 * @returns {{ok: true, text: string} | {ok: false, reason: "already-present" | "header-not-found"}}
 */
export function insertReleaseSection(text, version, date) {
  if (text.includes(`## [${version}]`)) return { ok: false, reason: "already-present" };
  const eol = detectEol(text);
  const head = `## [${version}] - ${date}${eol}${eol}## 🐛 修复${eol}${eol}- （待填）${eol}${eol}`;
  // BOM 可选：带 BOM 的检出上 `^#` 同样匹配不到，属于同一类「形状变了就静默失败」。
  // 行尾 `\r?\n` 两种都吃——这就是本模块存在的首要理由。
  const out = text.replace(/^(\uFEFF?# Changelog\r?\n\r?\n)/, `$1${head}`);
  if (out === text) return { ok: false, reason: "header-not-found" };
  return { ok: true, text: out };
}
