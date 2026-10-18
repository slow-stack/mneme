// 发布准备里「往两份 README 的版本表插占位行 + 回填路线图状态 + 核对 SECURITY.md 支持版本表」
// 的单一实现。
//
// 为什么抽成模块而不是留在入口里：入口 scripts/release-prep.mjs 在仓库根、import 即执行，
// 测不了。而这一步恰好静默失效过——根 README 的路线图表版本列写的是两段式 `**v0.9**`，
// 而匹配规则只认三段式 `**v0.9.0**`，于是脚本对根 README 一个字节也没改，打印的却是
// 「无版本表格行，跳过」：读起来像「这里不需要做」，实际是「这里没做」。v0.9.0 那次发布
// 准备（a9f8e35）只有 5 个文件变动、根 README 的路线图与 News 一字未动，佐证这不是新问题。
//
// 与 scripts/changelog-prep.mjs、scripts/test-count-sync.mjs 同一个理由：规则收在共用模块里
// 才测得到，也才不会两处各写一份。
import { detectEol } from "./changelog-prep.mjs";

// 版本号写在表格第一格才算「版本行」。三段式与两段式分开认：根 README 的路线图按 minor 排
// （v0.9），子 README 的版本历史按 patch 排（v0.9.0），两者不能互相匹配——否则给根 README
// 插一行 `**v0.9.1**` 会凭空造出一个不存在的 minor 条目。
const THREE = /^\|\s*\*\*v(\d+\.\d+\.\d+)\*\*/;
const TWO = /^\|\s*\*\*v(\d+\.\d+)\*\*/;

const cellCount = (line) => line.split("|").filter((c) => c.trim()).length;
const hasCJK = (s) => /[\u4e00-\u9fff]/.test(s);

/** semver 比较，长度不同时缺位按 0 处理（两段式路由图对上三段式目标版本时要用）。 */
function cmpVersion(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 扫描文本里所有版本行，按写法分三段式 / 两段式，并按**表格块**分组。
 *
 * 为什么要分组：根 README 的中英路线图是两张独立的表，版本行一模一样。旧实现把所有版本行
 * 合并成一个数组，「表里是否已有目标版本」于是变成全文件判断——给中文表插了行之后，英文表
 * 就被判成「已存在」，永远补不上。分组之后每张表各自判断、各自插入。
 *
 * 分组规则：连续的版本行算一块，中间隔着表头/分隔行这类表格行也仍算同一块；遇到空行或正文
 * 才收块。导出是为了让测试能拿真实 README 断言「这些表仍被认得出」——正则一旦被改窄，
 * 用户看到的会是「无版本表格行，跳过」，而不是测试变红。
 */
export function scanReleaseRows(text) {
  const three = [];
  const two = [];
  const blocks = [];
  let current = null;
  text.split(/\r?\n/).forEach((line, index) => {
    const m3 = THREE.exec(line);
    const m2 = m3 ? null : TWO.exec(line);
    if (m3 || m2) {
      const kind = m3 ? "three" : "two";
      const row = { index, ver: (m3 || m2)[1], kind };
      (kind === "three" ? three : two).push(row);
      if (current && current.next === index) current.rows.push(row);
      else {
        current = { rows: [row], next: index + 1 };
        blocks.push(current);
      }
      current.next = index + 1;
      return;
    }
    if (current && /^\s*\|/.test(line)) current.next = index + 1;
    else current = null;
  });
  return { three, two, blocks };
}

/** 按锚点行的列数与语言生成占位行。列数是「这张表有几列」的唯一判据：2 列=版本历史，3 列=路线图。 */
function rowFor(anchorLine, version, date) {
  const n = cellCount(anchorLine);
  if (n <= 2) return date ? `| **v${version}**（${date}） | （待填） |` : `| **v${version}** | （待填） |`;
  if (n === 3) {
    return hasCJK(anchorLine)
      ? `| **v${version}** | （待填） | 🚧 准备中 |`
      : `| **v${version}** | TBD | 🚧 In prep |`;
  }
  return `| **v${version}** | 🚧 准备中 | （待填） | （待填） |`;
}

/**
 * 给一份 README 插版本占位行，并把当前 minor 那行路线图的状态回填成已发布。
 *
 * 按**表块**而不是整份文件处理：根 README 的中英路线图是两张独立的表，版本行一模一样。合并成
 * 一个数组判断「表里是否已有目标版本」，会让先插的中文表把英文表判成「已存在」。
 *
 * 返回 { text, actions }，而不是布尔：「没插」有三种原因（已存在 / 没有版本表 / 表里已有更高
 * 版本），入口需要能如实说明是哪一种——旧实现在这里统一打印「跳过」，把「没做」说成了「不需要做」。
 *
 * @param {string} text README 全文
 * @param {string} version 目标版本，如 "0.9.1"
 * @param {string} date 如 "2026-10-18"
 */
export function syncReadmeTables(text, version, date) {
  const [major, minor] = version.split(".");
  const minorKey = `${major}.${minor}`;
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  const { blocks, two } = scanReleaseRows(text);

  const insertAfter = new Map();
  const replaceAt = new Map();
  const actions = [];

  // 1) 逐张表块插占位行。**必须按块**：根 README 的中英路线图是两张独立的表、版本行一模一样，
  //    旧实现把全文件所有版本行当一个数组，「表里已有目标版本」于是退化成全文件判断——先插的
  //    中文表会让英文表被判成「已存在」，那张就永远补不上。
  //    锚点取块内「低于目标的最新版本行」，不插表尾：这类表常在末尾写一条 v0.8.x 这样的概括行。
  for (const block of blocks) {
    const isHistory = block.rows[0].kind === "three";
    const target = isHistory ? version : minorKey;
    if (block.rows.some((r) => r.ver === target)) continue;
    const lower = block.rows.filter((r) => cmpVersion(r.ver, target) < 0);
    if (!lower.length) continue;
    const anchor = lower.reduce((a, b) => (cmpVersion(b.ver, a.ver) > 0 ? b : a));
    const anchorLine = lines[anchor.index];
    let row = rowFor(anchorLine, target, date);
    // 路线图的状态格直接写已发布，而不是「🚧 准备中」：这一行随 PR 一起进 main，合并之后紧接着
    // 就是打 tag，所以它就是这次要发出去的那一版。若写成「🚧」，它不会自己变——下次跑发版准备
    // 时回填的是那一版的补丁号（0.10.0 已发布，路线图却写 v0.10.1），把首个发布版本记错。
    // 与下面第 2 步「不改写已发布行」不冲突：那条规则防的是抹掉「这个 minor 首个发布的是谁」。
    if (!isHistory && cellCount(anchorLine) === 3) {
      const released = hasCJK(anchorLine) ? `✅ 已发布（v${version}）` : `✅ Released (v${version})`;
      const cells = row.split("|");
      cells[cells.length - 2] = ` ${released} `;
      row = cells.join("|");
    }
    insertAfter.set(anchor.index, row);
    actions.push({ kind: "insert", table: isHistory ? "版本历史" : "路线图", after: `v${anchor.ver}` });
  }

  // 2) 回填当前 minor 那行仍是「🚧 准备中」的状态格——上一次发版留下的占位，发版准备这一刻
  //    它就该变成已发布（版本号已定，是事实）。主题文字（第二格）始终不碰，那是人写的。
  //
  //    刻意不把「✅ 已发布（v0.9.0）」改写成「（v0.9.1）」：本脚本跑在打 tag 之前，改了就等于
  //    在 PR 里提前宣布一个还没发出去的版本；PR 若被放弃，那行立刻变成谎话。补丁号只由人在
  //    真正发出去之后按需要更新（与 v0.8 那行「至 v0.8.16」同一口径）。
  for (const row of two) {
    if (row.ver !== minorKey) continue;
    const line = lines[row.index];
    if (cellCount(line) < 3) continue;
    const cells = line.split("|");
    const old = cells[3].trim();
    if (!/🚧/.test(old)) continue;
    const next = hasCJK(line) ? `✅ 已发布（v${version}）` : `✅ Released (v${version})`;
    cells[3] = ` ${next} `;
    replaceAt.set(row.index, cells.join("|"));
    actions.push({ kind: "rollup", table: "路线图", from: old, to: next });
  }

  if (!actions.length) return { text, actions };
  const out = [];
  lines.forEach((line, index) => {
    out.push(replaceAt.has(index) ? replaceAt.get(index) : line);
    if (insertAfter.has(index)) out.push(insertAfter.get(index));
  });
  return { text: out.join(eol), actions };
}

/** 取某一节（到下一个同级 ## 标题为止）。用节而不是全文 grep：历史审计节里也有版本号。 */
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
  return { ok: problems.length === 0, expected, problems };
}
