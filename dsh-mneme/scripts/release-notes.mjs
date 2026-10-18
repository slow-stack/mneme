// 从 CHANGELOG 小节渲染 GitHub Release 正文的单一实现。
//
// 为什么抽成模块：这段逻辑原先嵌在 .github/workflows/release.yml 的 node -e 内联脚本里，
// 要改排版就得改工作流本体，也没法写测试——而 Release 正文恰恰是最需要反复试排版的东西。
// 抽出来之后同样的输入产出同样的正文，本地能预览、CI 能锁形状。
//
// 排版目标：Release 页的默认视图要能一眼扫完，但完整正文不能丢——它同时是「这个版本到底
// 改了什么」的唯一对外说明。做法是标题 + 一句导语默认可见，剩余正文折进 details，想细看的
// 人点开，不想看的人不被淹。
//
// CHANGELOG 本体一个字不动：那是仓库内的完整记录（含决策理由与审计线索），压缩它等于销毁
// 证据；分层只发生在对外渲染这一步。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 句末标点以中文全角为主。刻意不认半角句号：v0.9.0 这类版本号里的点是同一个字符，
// 认了会把导语切在版本号中间。
const END = /[。！？]/;
// 导语超长时的退让点，从强到弱。半角分号/逗号兜住中英混排的条目。
const SOFT = ["；", "，", ";", ","];

/** 取出某个版本的 CHANGELOG 小节正文（不含 ## [V] 标题行本身）；找不到返回 null。 */
export function findSection(text, version) {
  const re = new RegExp("^## \\[" + version.replace(/\./g, "\\.") + "\\][^\\n]*\\n", "m");
  const start = text.search(re);
  if (start === -1) return null;
  const rest = text.slice(start + text.slice(start).indexOf("\n") + 1);
  const next = rest.search(/^## \[/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/** 拆 - **标题**：正文；不是这个形状返回 null，调用方按普通行原样保留。 */
export function parseBullet(line) {
  const m = line.match(/^- \*\*(.+?)\*\*(?:[：:]\s*)?([\s\S]*)$/);
  if (!m) return null;
  return { title: m[1].trim(), body: (m[2] || "").trim() };
}

/**
 * 括号深度：全角（或半角( 进一层，）或) 出一层。导语绝不在未闭合的括号里断开——
 * 「…（明文回吐 Bearer，」这种收尾等于把一句话切在从句中间，读者要回头找主语。
 */
function depthAt(s, end) {
  let d = 0;
  for (let i = 0; i < end; i += 1) {
    const c = s[i];
    if (c === "\uFF08" || c === "(") d += 1;
    else if (c === "\uFF09" || c === ")") d = Math.max(0, d - 1);
  }
  return d;
}

/** 导语最短长度：低于它说明这句太短、离开上下文就没信息（实测有一条首句只有 8 字）。 */
const MIN_LEDE = 24;

/**
 * 取导语，返回 {lede, consumed}。
 *
 * consumed 是导语在正文里吃掉的字符数：折叠块放 body.slice(consumed)，因此导语与细节不
 * 重复——不记录它的话，用户点开折叠会看到同一句话出现两次。
 *
 * 优先级：① cap 内第一个长度达标（>= MIN_LEDE）的句末标点，整句收尾最干净；
 * ② cap 内最后一个括号平衡的软标点（分号/逗号/顿号），用省略号收尾、并连标点一起吃进
 * consumed（否则折叠块以「，」开头）；③ cap 内没有平衡软标点时，延到 cap 之后最近的平衡
 * 软标点，容许有限超长；④ 兜底硬截断。
 *
 * 两条规则都是被真实语料逼出来的：v0.9.0 的「GET /external-api（明文回吐 Bearer，」是在
 * 未闭合的括号里切断的（故有 depthAt）；同批有条首句「两处水源在说谎。」短到无法独立表意
 * （故有 MIN_LEDE）。
 */
export function lede(body, cap = 150) {
  if (!body) return { lede: "", consumed: 0 };
  // 正文本身不比 cap 长：整段就是导语。这一条必须排在软断点搜索**之前**——否则短正文里
  // 只要有个逗号就会被加上省略号，凭空说「后面还有」；逗号恰是最后一个字符时更荒唐：
  // 省略号后面什么也没有，折叠块是空的。原先这条守在函数末尾，靠句末标点分支侥幸躲过多数
  // 情况，只有「短且没有句末标点」的正文才会踩到。
  if (body.length <= cap) return { lede: body, consumed: body.length };
  for (let i = 0; i < body.length && i < cap; i += 1) {
    if (END.test(body[i]) && i + 1 >= MIN_LEDE) return { lede: body.slice(0, i + 1), consumed: i + 1 };
  }

  let before = -1;
  for (const mark of SOFT) {
    let at = body.slice(0, cap).lastIndexOf(mark);
    while (at !== -1 && depthAt(body, at) !== 0) at = body.slice(0, at).lastIndexOf(mark);
    if (at > before) before = at;
  }
  if (before >= MIN_LEDE) return { lede: body.slice(0, before) + "\u2026", consumed: before + 1 };

  const limit = Math.floor(cap * 1.6);
  for (let i = cap; i < Math.min(body.length, limit); i += 1) {
    if (SOFT.includes(body[i]) && depthAt(body, i) === 0) {
      return { lede: body.slice(0, i) + "\u2026", consumed: i + 1 };
    }
  }

  return { lede: body.slice(0, cap) + "\u2026", consumed: cap };
}

/**
 * 渲染 Release 正文：输入 findSection 的结果（小节正文），输出可直接写进
 * gh release --notes-file 的 Markdown。
 *
 * 折叠块的缩进按 GitHub 列表项的规则写成两个空格；少缩进一级会被渲染成独立段落，
 * 整条子弹的视觉归属就断了。列表项内 details 与正文之间必须有空行，否则内部 Markdown 不解析。
 */
/**
 * 把一个小节切成「块」：一个块 = 一条子弹 + 它下面所有缩进续行（含缩进的子列表）。
 *
 * 为什么必须先切块再渲染：CHANGELOG 里有 179 行缩进续行（0.8.6 / 0.8.7 / 0.8.12 等老版本集中
 * 出现，另有 59 行 `  - ` 子列表）。逐行 trim 的写法会把续行当成独立段落甩到条目的
 * `<details>` 外面——读者看到的是「条目正文只有一句，剩下的莫名其妙散在下面」，而且缩进没了、
 * 子列表变成平铺段落。渲染的单位是**条目**，不是行。
 */
export function splitBlocks(sectionText) {
  const blocks = [];
  for (const raw of sectionText.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    // 缩进行且当前有可挂靠的块 → 续行；否则（块首行之外的单行文本）另起一块。
    if (/^[ \t]+\S/.test(raw) && blocks.length) {
      blocks[blocks.length - 1].lines.push(raw.replace(/\s+$/, ""));
      continue;
    }
    blocks.push({ lines: [raw.trim()] });
  }
  return blocks;
}

export function renderNotes(sectionText, opts = {}) {
  const cap = opts.cap || 150;
  const out = [];
  for (const block of splitBlocks(sectionText)) {
    const line = block.lines[0];
    if (/^## /.test(line)) { out.push("", line, ""); continue; }
    const b = parseBullet(line);
    if (!b) { out.push(line); continue; }
    // 导语**只从条目首行取**：可见行必须是单行，混进换行就等于把续行又推回 details 外面。
    // 首行剩下的部分 + 全部续行（各自保留缩进，子列表才不会塌成段落）一起进折叠块。
    const { lede: l, consumed } = lede(b.body, cap);
    out.push("- **" + b.title + "**" + (l ? " — " + l : ""));
    const rest = [b.body.slice(consumed).trim(), ...block.lines.slice(1).map((c) => c.replace(/\s+$/, ""))]
      .filter(Boolean)
      .join("\n");
    if (rest) out.push("  <details><summary>细节</summary>", "", "  " + rest.replace(/\n/g, "\n  "), "", "  </details>");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** release.yml 的调用方式：node dsh-mneme/scripts/release-notes.mjs <version>（cwd 为仓库根）。 */
function main() {
  const v = (process.argv[2] || "").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(v)) { console.error("usage: release-notes.mjs <version>"); process.exit(1); }
  const md = readFileSync("dsh-mneme/CHANGELOG.md", "utf8");
  const sec = findSection(md, v);
  if (!sec) { console.error("changelog section not found: " + v); process.exit(1); }
  const body = renderNotes(sec);
  mkdirSync("notes", { recursive: true });
  writeFileSync("notes/body.md", body);
  console.log("--- extracted notes ---\n" + body.slice(0, 400));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();