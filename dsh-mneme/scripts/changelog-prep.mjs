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
 * 只剥掉整段两端的空行，保留每行自己的缩进（正文原样搬走的前提）。
 * 重新拼回时用原文的行尾：CRLF 的 CHANGELOG 若在这里退化成 LF，整份文件就成了混合行尾。
 */
function stripBlankEdges(text, eol) {
  const lines = text.split(/\r?\n/);
  let from = 0;
  let to = lines.length;
  while (from < to && lines[from].trim() === "") from += 1;
  while (to > from && lines[to - 1].trim() === "") to -= 1;
  return lines.slice(from, to).join(eol);
}

/**
 * 插入 `## [version] - date` 节（幂等：已含该版本则不改）。
 *
 * **两个位置约定，都是被真实发版逼出来的**：
 *
 * 1. 新版本节排在 `## [Unreleased]` **下面**，不是 `# Changelog` 下面。Keep a Changelog
 *    的约定是未发布区永远在最上；插反了会写出「[0.9.1] 在 [Unreleased] 之上」的顺序颠倒。
 *    v0.9.0 那次就是靠事后一笔人工提交（77df0fb）掰回来的——机器算得对的事不该留给人补。
 *
 * 2. `[Unreleased]` 里攒着的条目**整段搬进新版本节**，Unreleased 留空。原先只插一个
 *    「🐛 修复 / （待填）」空占位，攒着的条目原地不动，于是发版后文件里同时存在
 *    「新版本节是空的」和「旧条目还挂在 Unreleased 名下」——搬运这一步照样是人工补的
 *    （同一个 77df0fb）。搬的是位置不是内容：原样移动、一个字不改，所以「新版本节里
 *    该写什么」这个判断仍然只由往 Unreleased 里写条目的人做。
 *
 * 返回 `{ok:false, reason}` 而不是静默返回原文——调用方必须能区分「没什么可做」与
 * 「该做但没做成」，后者要报错退出。`reason` 取值：`already-present` / `header-not-found`。
 * 成功时带两个字段，**必须分开用**：
 * - `movedContent`：是否真的从 [Unreleased] 搬了非空正文（决定「搬了」还是「插了空占位」）；
 * - `moved`：其中以 `- ` 开头的条目数，只用于把日志说得更具体。
 * 用 `moved` 当「有没有搬」的判据是错的：正文非空但一条 `-` 都没有（例如全是正文段落或
 * 缩进代码块）时 `moved` 是 0，日志会说「[Unreleased] 本来是空的」——而它是非空的。
 *
 * @param {string} text CHANGELOG 全文
 * @param {string} version 如 "0.8.13"
 * @param {string} date 如 "2026-10-03"
 * @returns {{ok: true, text: string, moved: number, movedContent: boolean} | {ok: false, reason: "already-present" | "header-not-found"}}
 */
export function insertReleaseSection(text, version, date) {
  if (text.includes(`## [${version}]`)) return { ok: false, reason: "already-present" };
  const eol = detectEol(text);
  const placeholder = `## 🐛 修复${eol}${eol}- （待填）${eol}`;

  const m = /^## \[Unreleased\][^\r\n]*\r?\n/m.exec(text);
  if (m) {
    const start = m.index + m[0].length;
    const rest = text.slice(start);
    const nextRel = rest.search(/^## \[/m);
    const body = nextRel === -1 ? rest : rest.slice(0, nextRel);
    const tail = nextRel === -1 ? "" : rest.slice(nextRel);
    // 只剥节边界上的空行，**不 trim 正文**：正文首行若是缩进代码块（Markdown 的四空格），
    // trim 会把前导空格吃掉，代码块降级成普通段落——那就不是「原样搬」了。
    const pending = stripBlankEdges(body, eol);
    const head = `## [${version}] - ${date}${eol}${eol}`;

    // Unreleased 里攒着东西：整段搬进新版本节，Unreleased 留空。
    // 搬的是位置不是内容——原样移动，一个字不改。这样「新版本节里有什么」这个判断
    // 仍然只由往 Unreleased 里写条目的人做，脚本只负责把攒好的东西挪对地方。
    if (pending) {
      const moved = pending.split(/\r?\n/).filter((l) => l.startsWith("- ")).length;
      return { ok: true, moved, movedContent: true, text: text.slice(0, start) + eol + head + pending + eol + eol + tail };
    }

    // Unreleased 是空的：插占位节，等人写内容。
    return { ok: true, moved: 0, movedContent: false, text: text.slice(0, start) + eol + head + placeholder + eol + tail };
  }

  // 没有 [Unreleased] 的旧文件：退回标题之后。BOM 可选——带 BOM 的检出上 `^#` 同样匹配不到。
  const section = `## [${version}] - ${date}${eol}${eol}${placeholder}${eol}`;
  const out = text.replace(/^(\uFEFF?# Changelog\r?\n\r?\n)/, "$1" + section);
  if (out === text) return { ok: false, reason: "header-not-found" };
  return { ok: true, moved: 0, movedContent: false, text: out };
}
