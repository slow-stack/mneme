// dsh-mneme/src/wiki/claims.js
// Claim 粒度的失效判定——借自 openwiki 的 Grounded Claims 设计：每条结论挂着「哪个
// 文件、哪几行」的证据，代码一动就先算出「哪几条结论失准」，而不是把整个仓库判成
// 过期、把全部语义段重跑一遍。
//
// 为什么值得做：choro_claims 早就存了 source_path / start_line / end_line（见 store.js
// 的 choro_claims 表定义），三列本来就是为这件事准备的；可 t0.js 重跑时整页 claims 会被
// 清空（replaceChoroGraph 的 pages[].claims = []），于是改一行代码就让所有页的语义段
// 变成无主孤儿。本模块把「整仓过期」降成「哪页哪条」，代价是一次 git diff 加几十行
// 纯计算：零模型、零网络、零写入。
//
// 只算「相对上次生成基线改了什么」，不判断代码本体——结论要留给读它的人。
import { execFileSync } from "node:child_process";

// git 对「含非 ASCII / 控制字符」的路径会加双引号并按 C 风格转义（core.quotepath 默认
// 就是开的），例如中文名会写成 "a/\344\270\255\346\226\207.js"。只脱引号不解转义的话，
// 归一出来的字符串永远对不上 choro_claims.source_path，这些文件上的结论就再也判不成
// touched —— **漏判**比误判更难发现，因为它看起来一切正常。
const GIT_PATH_ESCAPES = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", '"': '"', "\\": "\\" };

function unescapeQuotedGitPath(s) {
  if (!s.includes("\\")) return s;
  const bytes = [];
  const pushStr = (str) => { for (const b of Buffer.from(str, "utf8")) bytes.push(b); };
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch !== "\\" || i === s.length - 1) { pushStr(ch); continue; }
    const octal = /^[0-7]{3}/.exec(s.slice(i + 1));
    if (octal) { bytes.push(parseInt(octal[0], 8) & 0xff); i += 3; continue; }
    const escaped = GIT_PATH_ESCAPES[s[i + 1]];
    if (escaped !== undefined) { pushStr(escaped); i += 1; continue; }
    pushStr(ch);
  }
  return Buffer.from(bytes).toString("utf8");
}

// 路径归一：choro_claims.source_path 存的是仓库相对路径（正斜杠）；git 侧也是正斜杠，
// 但 `--- a/x` `+++ b/x` 带前缀，可能需要去掉。转义只出现在被引号包起来的那种写法里，
// 所以解转义严格跟着「这次是否脱过引号」走——不能对未加引号的路径无条件解，
// 否则 Windows 风格的反斜杠会被当成转义序列吃掉。
function normDiffPath(p) {
  let s = String(p ?? "").trim();
  const quoted = s.length >= 2 && s.startsWith('"') && s.endsWith('"');
  if (quoted) s = unescapeQuotedGitPath(s.slice(1, -1));
  if (s.startsWith("a/") || s.startsWith("b/")) s = s.slice(2);
  return s.replace(/\\/g, "/");
}

/**
 * 解析 `git diff --unified=0 <baseline> HEAD` 的文本。
 *
 * 只认 hunk 头 `@@ -a,b +c,d @@`：不解析正文，正文里带 `@@` 的代码行不会干扰，
 * 因为 hunk 头必须匹配完整形状。两个计数都要——旧侧计数是新旧行坐标的唯一来源，
 * claims 的行号记在**旧侧**（写 claim 时那一版就是 HEAD）。
 *
 * 不传 -M 还不够：git 在 `--unified=0` 下**仍会**自动开重命名检测（实测输出
 * `similarity index 100% / rename from / rename to`，既不出 hunk 也不进 /dev/null），
 * 于是重命名后旧路径上的 claim 会被判成「没事」。必须显式 `--no-renames`，让重命名
 * 按「删旧 + 增新」处理：旧路径上的 claim 落进 deleted 是对的（锚点跟着文件走了，得
 * 重新指），新路径没有 claim 自然也不会误报。
 *
 * 返回 { files: Map<path, [{oldStart, oldCount, newStart, newCount}]>, deleted: string[] }。
 */
export function parseDiffRanges(diffText) {
  const files = new Map();
  const deleted = [];
  let livePath = null;
  let oldPath = null;
  for (const line of String(diffText ?? "").split("\n")) {
    if (line.startsWith("diff --git ")) { livePath = null; oldPath = null; continue; }
    if (line.startsWith("--- ")) { oldPath = normDiffPath(line.slice(4)); continue; }
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      if (raw === "/dev/null") {
        // 整文件删除：claims 指向它的全部作废（没有出处就没有可校验的结论）。
        if (oldPath) deleted.push(oldPath);
        livePath = null;
      } else {
        livePath = normDiffPath(raw);
        if (!files.has(livePath)) files.set(livePath, []);
      }
      continue;
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m || livePath === null) continue;
    files.get(livePath).push({
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return { files, deleted };
}

/**
 * 取基线到当前 HEAD 的 diff。基线不在仓库里（force-push / 浅克隆 / 换机重拉）时
 * 不猜：回 { ok: false, reason }，调用方据此说「基线认不出了，建议重建」而不是
 * 拿空 diff 报「全部结论都还准」——空 diff 与「算不出来」在页面上是两句话。
 */
export function diffSince(repoRoot, baseline, head) {
  const clean = (v) => /^[0-9a-f]{7,40}$/i.test(String(v ?? "").trim());
  if (!clean(baseline) || !clean(head)) return { ok: false, reason: "baseline-unreadable" };
  try {
    const text = execFileSync(
      "git",
      ["diff", "--unified=0", "--no-color", "--no-ext-diff", "--no-renames", `${baseline}..${head}`],
      // --no-renames 是必需的，不是保险：git 会按配置自动开重命名检测（实测在
      // --unified=0 下也开），一旦识别成 rename 就既不产生 hunk、也不产生 /dev/null，
      // 旧路径上的 claim 会被静默判成 untouched。见本函数上方 parseDiffRanges 的说明。
      // stdio 显式接管 stderr：execFileSync 默认把子进程 stderr 直接漏到父进程，
      // 「不是 git 仓库」那条几十行的 usage 会污染面板日志，也会在测试输出里刷屏。
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }
    );
    return { ok: true, ...parseDiffRanges(text) };
  } catch (err) {
    // 两种情况在这里合流：`<基线>..HEAD` 里有 git 认不出的 rev（force-push 后
    // 旧基线消失、浅克隆截断历史），或这个目录根本不是 git 仓库。对调用方是同一件
    // 事：**算不出来**。别把 exit code 当 reason 抛给面板——面板要说的是人话。
    return { ok: false, reason: "diff-failed", detail: String(err?.stderr ?? err?.message ?? err).trim().slice(0, 200) };
  }
}

function normPath(p) {
  return String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * 逐条 claim 判「还准不准」。
 *
 * 四档理由，全部能从 diff 与三列证据机械算出：
 *   - deleted      证据文件在基线之后被删了，这条结论没有出处了。
 *   - touched      改动的行与 claim 的行区间相交，结论本身可能已经不对。
 *   - shifted      claim 区间没被碰，但它上方有增删，行号整体偏移——内容还在，
 *                  锚点要重新指。刻意与 touched 分开：混成一个「失效」，面板就会
 *                  对着一堆只是行号错位的结论喊「要重写」，喊几次就没人信了。
 *   - unverifiable 所属文件改过，可这条 claim 当初就没记行号，无法定位到具体一行。
 *   - uncommitted  验证那一刻这个文件还在工作区里没提交（#648）。claim 的行号取自
 *                  磁盘内容而不是任何提交，提交层面的 diff 从改动之后起算，永远看不到
 *                  这段——只能老实说「无法用提交核对」，不能冒充「没变」。这一档由
 *                  summarizeClaims 依据页面记下的脏文件清单补，不在 diff 里算。
 *
 * 输入 diff 为 { files: Map, deleted: string[] }；输出与输入等长，未受影响的
 * reason 为 null（调用方自行过滤）。
 */
export function assessClaims(claims, diff) {
  const files = diff?.files ?? new Map();
  const deleted = new Set(diff?.deleted ?? []);
  return (claims ?? []).map((claim) => {
    const path = normPath(claim.sourcePath);
    if (path === "") return { ...claim, reason: null };
    if (deleted.has(path)) return { ...claim, reason: "deleted" };
    const hunks = files.get(path);
    if (!hunks || hunks.length === 0) return { ...claim, reason: null };
    const start = Number.isInteger(claim.startLine) ? claim.startLine : null;
    const end = Number.isInteger(claim.endLine) ? claim.endLine : start;
    if (start === null || start < 1) return { ...claim, reason: "unverifiable" };
    const sorted = [...hunks].sort((a, b) => a.oldStart - b.oldStart);
    let shift = 0;
    for (const h of sorted) {
      const hOldEnd = h.oldCount === 0 ? h.oldStart : h.oldStart + h.oldCount - 1;
      // 纯插入（`@@ -a,0 +c,d @@`，oldCount === 0）没有「旧行区间」，但它插在旧第 a 行
      // 之后、第 a+1 行之前。落进 claim 区间内部（a >= start 且 a < end）就是真碰到了，
      // 与「删除/替换」一样算 touched；插在 claim 首行之前只是把它推下去，仍算 shifted。
      // 老写法 `h.oldCount > 0 && ...` 让纯插入永远不算相交——多行结论被插进新行时，
      // 结论原文已被改变却报「没事」。
      const overlaps = h.oldCount > 0
        ? start <= hOldEnd && end >= h.oldStart
        : h.oldStart >= start && h.oldStart < end;
      if (overlaps) return { ...claim, reason: "touched", shift };
      if (hOldEnd < start) shift += h.newCount - h.oldCount;
    }
    return shift === 0 ? { ...claim, reason: null } : { ...claim, reason: "shifted", shift };
  });
}

/**
 * 仓库级汇总：逐条判定 → 「哪几页、几条、因为什么」。
 *
 * claims 每项需带 pageSlug；pages 每项 { slug, title, hasT1, verifiedBaseline,
 * verifiedAt, verifiedDirtyFiles, diffBaseline, baselineApprox, baselineUnknown, anchorStale }。
 *
 * 为什么 pages 要带验证基线、为什么还要 diffByPage：claims 的行号是**各自那页被
 * 富化的那一刻**记下的。全仓只有一个 git_baseline（T0 的时点），拿它当所有 claims
 * 的比对起点，会把「T1 之前就发生、claim 早已算进去」的改动误报成 touched——页越晚
 * 富化越容易误报。所以每页按自己的 verifiedBaseline 分组各算一次 diff。
 *
 * hasT1 是页面正文里有 T1 段标记的页——这类页「正文有语义段、库里零条 claims」是
 * t1.js 落盘非原子留下的残局（文件先落盘、DB 后写，中途崩了就成这样）。单独记进
 * inconsistent：不修它的话这页永远「看起来没有可校验的证据」，一次都不会被标成需要复核。
 *
 * diffByPage(slug) 三态：diff 对象 = 算过了；null = 这一页没有可用的起点（判不了）。
 * 「判不了」的结论一条都不标，页面用 baselineUnknown / anchorStale 两种不同的说法交代。
 */
export function summarizeClaims(claims, diff, { pages = [], diffByPage = null } = {}) {
  const assessed = diffByPage
    ? (claims ?? []).flatMap((claim) => assessClaims([claim], diffByPage(claim.pageSlug)))
    : assessClaims(claims, diff);
  // 脏文件上的 claim 覆盖 diff 的判定（#648）：diff 比对的是两个提交，而 claim 的行号
  // 取自验证时刻的磁盘。文件当时没进提交，diff 里就必然没有这段改动——这时 diff 说
  // 「没碰过」是假阴性，必须换成 uncommitted。没有这份清单的页（老数据）不覆盖。
  const dirtyBySlug = new Map();
  for (const page of pages) {
    if (Array.isArray(page.verifiedDirtyFiles) && page.verifiedDirtyFiles.length > 0) {
      dirtyBySlug.set(page.slug, new Set(page.verifiedDirtyFiles.map((p) => normPath(p))));
    }
  }
  const judged = dirtyBySlug.size === 0
    ? assessed
    : assessed.map((claim) => {
      const dirty = dirtyBySlug.get(claim.pageSlug);
      if (dirty && dirty.has(normPath(claim.sourcePath))) return { ...claim, reason: "uncommitted", shift: 0 };
      return claim;
    });
  const bySlug = new Map();
  for (const page of pages) {
    bySlug.set(page.slug, {
      slug: page.slug,
      title: page.title ?? page.slug,
      hasT1: Boolean(page.hasT1),
      verifiedBaseline: page.verifiedBaseline ?? null,
      verifiedAt: page.verifiedAt ?? null,
      // 原样透传：面板要说「这一页是在含未提交改动的状态下验证的」（#648）。
      verifiedDirtyFiles: Array.isArray(page.verifiedDirtyFiles) ? page.verifiedDirtyFiles : null,
      // 实际拿来跑 diff 的起点：新数据就是 verifiedBaseline；老数据（本功能之前富化）
      // 退到全仓基线，baselineApprox 标记「这不是当真的验证点，是保底起点」。
      diffBaseline: page.diffBaseline ?? page.verifiedBaseline ?? null,
      baselineApprox: Boolean(page.baselineApprox),
      baselineUnknown: Boolean(page.baselineUnknown),
      anchorStale: Boolean(page.anchorStale),
      claims: 0,
      atRisk: [],
      inconsistent: false,
    });
  }
  for (const claim of judged) {
    const slug = claim.pageSlug;
    if (!bySlug.has(slug)) {
      bySlug.set(slug, { slug, title: claim.pageTitle ?? slug, hasT1: false, claims: 0, atRisk: [], inconsistent: false });
    }
    const bucket = bySlug.get(slug);
    bucket.claims += 1;
    if (!claim.reason) continue;
    bucket.atRisk.push({
      claimId: claim.id ?? null,
      statement: claim.statement,
      kind: claim.kind ?? null,
      sourcePath: claim.sourcePath,
      startLine: claim.startLine ?? null,
      endLine: claim.endLine ?? null,
      reason: claim.reason,
      shift: claim.shift ?? 0,
    });
  }
  for (const bucket of bySlug.values()) {
    bucket.inconsistent = bucket.hasT1 && bucket.claims === 0;
    // 零条结论的页谈不上「哪次验证的」——骨架页不该因为没富化过就被标成「判不了」。
    if (bucket.claims === 0) bucket.baselineUnknown = false;
  }
  const list = [...bySlug.values()].sort((a, b) => {
    // 有风险的排前面，然后依次是：锚点对不上账的、起点认不出的、本来就是空的、
    // 干净的。依次递减的严重度，是为了让「要动手」的永远在第一屏。
    const rank = (p) =>
      p.atRisk.length > 0 ? 0
        : p.inconsistent ? 1
          : p.anchorStale ? 2
            : p.baselineUnknown ? 3
              : 4;
    return rank(a) - rank(b) || a.slug.localeCompare(b.slug);
  });
  const flat = list.flatMap((p) => p.atRisk);
  const count = (reason) => flat.filter((c) => c.reason === reason).length;
  return {
    pages: list,
    totals: {
      pages: list.length,
      claims: assessed.length,
      atRiskClaims: flat.length,
      atRiskPages: list.filter((p) => p.atRisk.length > 0).length,
      touched: count("touched"),
      shifted: count("shifted"),
      deleted: count("deleted"),
      unverifiable: count("unverifiable"),
      uncommitted: count("uncommitted"),
      inconsistentPages: list.filter((p) => p.inconsistent).length,
      baselineUnknownPages: list.filter((p) => p.baselineUnknown).length,
      anchorStalePages: list.filter((p) => p.anchorStale).length,
    },
  };
}
