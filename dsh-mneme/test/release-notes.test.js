// scripts/release-notes.mjs 的回归测试。
//
// 这段逻辑原先嵌在 .github/workflows/release.yml 的 node -e 里：改排版要动工作流本体、还写不了
// 测试，而它产出的恰恰是 GitHub Release 的对外正文——最需要反复试排版的地方。抽成模块之后，
// 形状必须被锁住，否则下次「顺手压缩一下」就会静默改变所有 Release 页的样子。
//
// 锁的是四条容易悄悄退化的性质：
//   1. 分层而不是截断：标题 + 一句导语默认可见，其余折进 details，完整正文一条不丢；
//   2. 导语与折叠块不重复：consumed 记错就会让同一句话出现两次；
//   3. 导语不在未闭合的括号里断开，也不采用短到无法独立表意的首句；
//   4. 找不到小节必须非零退出、不写正文——退回空正文就是假成功；
//   5. 缩进续行跟着它所属的条目一起进折叠块，不散落到外面（老版本 CHANGELOG 里有 179 行）；
//   6. 正文本身不长时整段就是导语，不许凭空加省略号（短正文里也常有逗号）。
// 第 4 条走真进程（spawnSync）端到端：工作流只认退出码与 notes/body.md 这个文件。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findSection, parseBullet, lede, renderNotes } from "../scripts/release-notes.mjs";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "release-notes.mjs");

/** 括号深度：全角与半角都算。导语收尾时它必须是 0。 */
function parenDepth(s) {
  let d = 0;
  for (const c of s) {
    if (c === "\uFF08" || c === "(") d += 1;
    else if (c === "\uFF09" || c === ")") d = Math.max(0, d - 1);
  }
  return d;
}

const SAMPLE = [
  "# Changelog",
  "",
  "## [0.9.0] - 2026-10-17",
  "",
  "## \u{1F41B} 修复",
  "",
  "- **修掉一个能钉死宿主的轮询**：轮询器原先在没有新消息时也会整轮重建定时器，于是每收到一次心跳就多压一层等待队列，这在单次会话里看不出来，连续跑上几小时才会把宿主的事件循环拖到卡死，排查时表现为面板偶尔整片不刷新、日志里却什么异常都没有（这类问题最费时间，因为复现窗口很长，还得先怀疑是记忆库锁竞争），修法是把定时器提到循环外复用，并补一条回归用例锁住轮询次数。",
  "",
  "- **很短的一条**：两处水源在说谎。",
  "",
  "## [0.8.16] - 2026-10-12",
  "",
  "- 旧条目",
].join("\n");

test("findSection：取到该版小节，不含标题行，到下一个版本标题为止", () => {
  const sec = findSection(SAMPLE, "0.9.0");
  assert.ok(sec.startsWith("## \u{1F41B} 修复"), "小节从版本标题行之后开始");
  assert.ok(sec.includes("修掉一个能钉死宿主的轮询"), "正文在里面");
  assert.equal(sec.includes("[0.9.0]"), false, "不该带上版本标题行本身");
  assert.equal(sec.includes("旧条目"), false, "到下一个 ## [ 为止");
});

test("findSection：找不到该版本返回 null（入口据此 exit 1）", () => {
  assert.equal(findSection(SAMPLE, "9.9.9"), null);
});

test("findSection：版本号里的点被转义过，不会当成通配", () => {
  const text = SAMPLE.replace("## [0.8.16] - 2026-10-12", "## [0x8x16] - 2026-10-12");
  assert.equal(findSection(text, "0.8.16"), null, "点若被当通配就会误命中 0x8x16");
});

test("parseBullet：拆出标题与正文；非该形状返回 null 由调用方原样保留", () => {
  assert.deepEqual(parseBullet("- **标题**：正文在这里"), { title: "标题", body: "正文在这里" });
  assert.deepEqual(parseBullet("- **只有标题**"), { title: "只有标题", body: "" });
  assert.equal(parseBullet("普通段落"), null);
  assert.equal(parseBullet("- 没有粗体标题：正文"), null);
});

test("lede：cap 内第一个达标的句末标点处收尾，consumed 与导语等长", () => {
  // 正文必须真的长于 cap：短于 cap 时整段就是导语（见下一条用例），那样根本走不到本分支。
  const first = "这是一个足够长的句子，用来验证导语会在句末标点处停下来。";
  const body = first + "后面还有别的内容，".repeat(20);
  assert.ok(body.length > 150, "构造本身要求正文长于 cap");
  const r = lede(body, 150);
  assert.equal(r.lede, first);
  assert.equal(r.consumed, r.lede.length, "consumed 必须等于导语长度，否则折叠块会错位或重复");
});

test("lede：首句短于 MIN_LEDE 时不采用（实测有条首句只有 8 字，离开上下文没信息）", () => {
  const body = "两处水源在说谎。这个短句单独拿出来没有信息量，所以要继续往下取。";
  const r = lede(body, 150);
  assert.notEqual(r.lede, "两处水源在说谎。", "8 字的首句不该被当成导语");
  assert.ok(r.lede.startsWith("两处水源在说谎。"), "仍从正文开头起，不能跳过首句");
  assert.ok(r.lede.length > 8);
});

test("lede：软断点必须在括号平衡处 —— 不在未闭合的括号里切断", () => {
  // 复刻 v0.9.0 实测切出来的坏例子：GET /external-api（明文回吐 Bearer，…
  const body = "开放读清单里有 GET /external-api（明文回吐 Bearer，还会就地铸造 token），这条实测切在括号里最难看，所以专门钉住它。";
  const naive = body.slice(0, 40).lastIndexOf("\uFF0C");
  assert.equal(parenDepth(body.slice(0, naive)), 1, "构造本身要能触发规则：cap 内最后一个逗号在括号里");
  const r = lede(body, 40);
  assert.equal(parenDepth(r.lede), 0, "导语的括号必须闭合：" + r.lede);
  assert.ok(r.lede.includes("token）"), "应越过括号再收尾：" + r.lede);
});

test("lede：落到软断点分支时，consumed 连标点一起吃进去 —— 折叠块不能以逗号开头", () => {
  // 这条补的是 M4 类退化：软断点用省略号收尾时，若 consumed 只记到标点之前，折叠块就会以
  // 「，」开头（读者点开看到的第一件事是一个孤零零的逗号）。句末标点分支不会暴露它，因为
  // 那条分支把整句连同标点一起切走；只有刻意不写句末标点的正文才走得到这里。
  const body = Array.from({ length: 12 }, (_, i) => "\u7B2C" + (i + 1) + "\u6BB5\u5185\u5BB9\u5199\u5F97\u6BD4\u8F83\u957F\u4E00\u4E9B\uFF0C").join("") + "\u6536\u5C3E\u3002";
  const r = lede(body, 150);
  assert.ok(r.lede.endsWith("\u2026"), "\u6CA1\u6709\u53E5\u672B\u6807\u70B9\u65F6\u7528\u7701\u7565\u53F7\u6536\u5C3E\uFF1A" + r.lede);
  assert.equal(r.consumed, r.lede.length, "consumed \u5FC5\u987B\u7B49\u4E8E\u5BFC\u8BED\u957F\u5EA6");
  const rest = body.slice(r.consumed);
  assert.ok(rest.length > 0, "\u6784\u9020\u672C\u8EAB\u8981\u6C42\u8FD8\u6709\u5269\u4F59\u6B63\u6587\uFF0C\u5426\u5219\u6D4B\u4E0D\u5230");
  assert.equal(rest.startsWith("\uFF0C"), false, "\u6298\u53E0\u5757\u4E0D\u80FD\u4EE5\u9017\u53F7\u5F00\u5934\uFF1A" + rest.slice(0, 12));
});

test("lede：正文本身比 cap 短时，整段就是导语，不加省略号也不越界", () => {
  const body = "很短的一条正文，没有句末标点";
  const r = lede(body, 150);
  assert.equal(r.lede, body, "整段即导语");
  assert.equal(r.lede.includes("\u2026"), false, "不该凭空加省略号说后面还有");
  assert.equal(r.consumed, body.length, "consumed 不能超过正文长度");
});

test("lede：正文比 cap 短且以逗号结尾时，仍是整段导语 —— 不加省略号说「后面还有」", () => {
  // 这条钉的是「短正文保护」的位置：它必须排在软断点搜索之前。原先守在函数末尾，短正文里
  // 只要有个逗号就会被加省略号；逗号恰是最后一个字符时更荒唐——省略号后面什么也没有，
  // 折叠块是空的。实测语料里 25 字的短条就被切成了这个样子。
  const body = Array.from({ length: 4 }, () => "\u4E00\u4E8C\u4E09\u56DB\u4E94\u516D\u4E03\u516B\u4E5D\u5341").join("") + "\uFF0C";
  const r = lede(body, 150);
  assert.equal(r.lede, body, "整段即导语，不该被软断点截断");
  assert.equal(r.lede.includes("\u2026"), false, "不该加省略号");
  assert.equal(r.consumed, body.length, "consumed 要覆盖整段");
  assert.equal(body.slice(r.consumed), "", "没有剩余正文可折 —— 折叠块必须为空");
});

test("renderNotes：标题 + 导语默认可见，其余折进 details，且导语不重复出现", () => {
  // 正文要长于 cap，否则整段展开（没有可折的东西时，多一步点击毫无收益）。
  const section =
    "- **标题甲**：第一句要足够长，所以会被当作导语留下来并在此收尾。" +
    "第二句只应该出现在折叠块里，不该在可见行重复。".repeat(12);
  const out = renderNotes(section, { cap: 150 });
  const [head, ...rest] = out.split("\n");
  assert.ok(head.startsWith("- **标题甲** \u2014 "), "可见行是标题 + 导语：" + head);
  const folded = rest.join("\n");
  assert.ok(folded.includes("<details><summary>细节</summary>"), "剩余正文折进 details");
  assert.ok(folded.includes("第二句只应该出现在折叠块里"), "细节里要有后半段");
  assert.equal(folded.includes("第一句要足够长，所以会被当作导语留下来并在此收尾"), false, "导语不在折叠块里重复出现");
});

test("renderNotes：details 缩进两级且与正文之间空行 —— 否则内部 Markdown 不解析、视觉归属也断", () => {
  const section =
    "- **标题乙**：第一句要足够长，所以会被当作导语留下来并在此收尾。" +
    "后面这句进折叠块。".repeat(20);
  const lines = renderNotes(section).split("\n");
  const open = lines.findIndex((l) => l.includes("<details"));
  const close = lines.findIndex((l) => l.includes("</details"));
  assert.notEqual(open, -1, "长子弹必须被折叠");
  assert.ok(lines[open].startsWith("  <details"), "details 标签缩进两格：" + lines[open]);
  assert.ok(lines[close].startsWith("  </details"), "闭合标签缩进两格：" + lines[close]);
  assert.equal(lines[open + 1], "", "details 与正文之间必须空行，否则内部 Markdown 不解析");
  assert.equal(lines[close - 1], "", "正文与闭合标签之间也要空行");
  assert.ok(lines[open + 2].startsWith("  "), "折叠正文缩进两格：" + lines[open + 2]);
});

test("renderNotes：缩进续行随条目一起进 details，不散落到外面也不丢缩进", () => {
  // CHANGELOG 里有 179 行缩进续行（0.8.6 / 0.8.7 / 0.8.12 等老版本集中出现）与 59 行
  // "  - " 子列表。逐行 trim 的写法会把续行当成独立段落甩到条目的 details 外面，
  // 子列表还会塌成平铺段落——读者看到的是「正文只有一句，剩下的莫名其妙散在下面」。
  // 渲染的单位是条目，不是行。
  // 首行刻意写得短且没有句末标点：这样"句末标点落在续行上"才可达，用例才能抓到
  // "把续行拼回正文再切导语"这种写法——那种写法会把换行混进可见行。
  const section = [
    "- **标题丙**：首行很短",
    "  这一句续行足够长，句末标点落在续行上，好让拼接式的导语切分会把换行混进可见行。",
    "  这是续行二，属于上一条子弹。",
    "  - 子列表项不应塌成段落",
    "- **标题丁**：另起一条，用来确认块边界。",
  ].join("\n");
  const lines = renderNotes(section).split("\n");
  const firstClose = lines.findIndex((l) => l.includes("</details"));
  const secondHead = lines.findIndex((l) => l.includes("**标题丁**"));
  assert.notEqual(firstClose, -1, "带续行的条目必须被折叠");
  assert.ok(secondHead > firstClose, "第二条子弹应排在第一条的 details 之后，块边界不能串");
  const folded = lines.slice(0, firstClose).join("\n");
  assert.ok(folded.includes("这一句续行足够长"), "续行一在第一条的折叠块里");
  assert.ok(folded.includes("这是续行二"), "续行二在第一条的折叠块里");
  assert.ok(folded.includes("- 子列表项不应塌成段落"), "子列表在折叠块里且保留列表形状");
  const outside = lines.slice(secondHead).join("\n");
  assert.equal(outside.includes("这一句续行足够长"), false, "续行不该跑到下一条子弹那边");
  const visible = lines.find((l) => l.includes("**标题丙**"));
  assert.ok(visible.startsWith("- **标题丙** \u2014 "), "可见行仍是单行标题 + 导语：" + visible);
  assert.equal(visible.includes("续行"), false, "续行不许挤进可见行，否则可见行撑成多行：" + visible);
  // 这一条抓的是「把续行拼回正文再切导语」的写法：导语里混进换行后，可见行后面会多出一行
  // 没有任何缩进的裸行，续行又散到了 details 外面。判别方法是看可见行之后紧跟什么——
  // 正常只可能是 details 标签本身。
  const headIdx = lines.indexOf(visible);
  assert.ok(lines[headIdx + 1].startsWith("  <details"), "可见行之后必须直接是折叠块，不许有裸行：" + lines[headIdx + 1]);
  assert.equal(visible.includes("\u2026"), false, "首行没有句末标点时，导语只能是首行本身，不该跨行取到续行的句号：" + visible);
});

test("renderNotes：分类小节原样保留，非子弹行不加工", () => {
  const out = renderNotes("## \u{1F41B} 修复\n\n- 一条没有粗体标题的行\n");
  assert.ok(out.includes("## \u{1F41B} 修复"), "小节标题原样保留");
  assert.ok(out.includes("- 一条没有粗体标题的行"), "非 - **...** 形状原样保留");
  assert.equal(out.includes("<details>"), false, "没拆出正文就不该有折叠块");
});

test("入口：真进程跑一遍，写出 notes/body.md，且 CHANGELOG 本体一个字不动", () => {
  const root = mkdtempSync(join(tmpdir(), "mneme-release-notes-"));
  mkdirSync(join(root, "dsh-mneme"), { recursive: true });
  writeFileSync(join(root, "dsh-mneme", "CHANGELOG.md"), SAMPLE, "utf8");
  const res = spawnSync(process.execPath, [scriptPath, "0.9.0"], { cwd: root, encoding: "utf8" });
  assert.equal(res.status, 0, "退出码必须是 0：" + res.stderr);
  const body = readFileSync(join(root, "notes", "body.md"), "utf8");
  assert.ok(body.includes("## \u{1F41B} 修复"), "小节标题进了正文");
  assert.ok(body.includes("<details>"), "长子弹被折叠");
  assert.equal(readFileSync(join(root, "dsh-mneme", "CHANGELOG.md"), "utf8"), SAMPLE, "CHANGELOG 本体一个字不动");
});

test("入口：版本不存在时非零退出、不写正文（不许退回空正文假成功）", () => {
  const root = mkdtempSync(join(tmpdir(), "mneme-release-notes-"));
  mkdirSync(join(root, "dsh-mneme"), { recursive: true });
  writeFileSync(join(root, "dsh-mneme", "CHANGELOG.md"), SAMPLE, "utf8");
  const res = spawnSync(process.execPath, [scriptPath, "9.9.9"], { cwd: root, encoding: "utf8" });
  assert.notEqual(res.status, 0, "找不到小节必须非零退出");
  assert.match(
    res.stderr,
    /changelog section not found: 9\.9\.9/,
    "要报出是哪一版找不到 —— 只靠非零退出码的话，脚本崩了也算通过（崩溃不是这条要防的东西，静默假成功才是）"
  );
  assert.equal(existsSync(join(root, "notes", "body.md")), false, "不该留下空正文");
});

test("入口：版本号格式不对时直接拒绝", () => {
  const res = spawnSync(process.execPath, [scriptPath, "v1.2"], { encoding: "utf8" });
  assert.notEqual(res.status, 0, "只接受 x.y.z");
  assert.match(res.stderr, /usage: release-notes\.mjs/, "要说清用法，别静默退出");
});
