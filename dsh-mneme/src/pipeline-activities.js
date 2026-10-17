/**
 * 把 shell 观察压成**人能扫的「业务动作」清单**。
 *
 * ## 为什么需要这一层（三组实测逼出来的）
 *
 * 1. 拿单条命令去匹配手写步骤表，命中率只有 14.2~15.2%（非发版会话 4.4%，
 *    区分力仅 3 倍）→ **拿清单套行为这条路走不通**。
 * 2. 想用「整段命令」当分组键：每个会话中位 **539 组**、最多 7373 组
 *    → 文献那套「聚类 + 人命名」直接照搬也不成立（网页活动本来只有几十个页面）。
 * 3. 换「动词」当键：密度最高的全是 **PowerShell 管道语法**
 *    （`write-output` 10619、`select-object` 10422、`}` 4864…）
 *    → **「命令 ≈ 动作」这个预设是错的**：大部分"命令"不是活动，是句子成分。
 * 4. 只留业务命令（git/gh/npm/node/docker…）后：业务段占 **6.5%**，
 *    不同动词 **8 个**、不同前两词组 **1010 个** —— 这才是人能扫的量级。
 *
 * ## 这个模块的产出：一份「本次窗口观察到什么」清单
 *
 * 形态：`git status ×12`、`gh pr ×5`、`npm test ×3`。
 * **不猜它对应哪一步**——那件事交给人（见 mneme-research 的 09 号文档）。
 *
 * ## 🔴 隐私：为什么只输出「动词 + 子命令」
 *
 * 完整命令行里**几乎必然含绝对路径**，而路径里含本机用户名。例如实测里真实出现过
 * `set-location "c:\users\<用户名>\desktop\..."`。这条回执是要显示在界面上、
 * 可能被截图的那一面——所以本模块有一条硬规则：
 *
 * > **位置参数一律丢弃，只保留动词、子命令与 `-` 开头的旗标。**
 *
 * 旗标是语义（`--rebase` / `--force` / `-m`），位置参数是数据（路径、文件名、id）。
 * 只留前者，清单既表意又不泄露。这不是"顺手过滤"，是这一层存在的第二个理由。
 */

/**
 * 业务命令的动词白名单。
 *
 * 判据不是"常见"，而是"**它的执行会构成工作流的一步**"——即它有语义
 * （改仓库状态、发版、跑测试），而不是在组装文本（`write-output`、`foreach-object`）。
 *
 * 这张名单是**拍的**（实测里 6.5% 的段落在名单内），未验证覆盖率：
 * 可能有业务动作用了别的工具（`python`、`curl`、`cargo`）。认不出来不产清单项，
 * 是安全的方向——它只会让清单更短，不会让它更假。
 */
const BUSINESS_VERBS = new Set([
  // 实测 21723 次调用里，真正命中的只有这四个：git / gh / npm / node。
  // 其余先不收——认不出来只会让清单更短，不会让它更假；
  // 等真有项目用上了再加（这一版刻意不做"猜未来会用到"的预留）。
  "git", "gh", "npm", "npx", "node", "docker"
]);

/** 命令分隔符：与 pipeline-attribution 同一口径（只认两侧带空白的）。 */
const SEPARATOR_RE = /\s*(?:;|&&|\|\||\|)\s*|\n/u;

/** 重定向尾巴（`2>&1`、`> file`、`2>nul`）：不是命令的一部分。 */
const REDIRECT_RE = /\s*\d?>\s*&?\s*\S+/gu;

/** `cd <路径>`：前导定位语句，不是活动。 */
const CD_RE = /^cd\s/iu;

/**
 * 这个 token 像不像一个**子命令**。
 *
 * 必须做这道校验，否则三件事都会发生（都是端到端实测抓到的）：
 * 1. `node d:\dsh\...\probe.mjs` → 把**脚本路径**当成 sub，路径里的用户名被带出去；
 * 2. `git -C $(Join-Path ...) log --oneline` → 把 `$(Join-Path` 当成 sub，清单里出现
 *    `git (join-path -C --oneline` 这种读不懂的东西；
 * 3. `node x.test.js` → **带点的文件名**被当成 sub（`x.test.js` 完全符合"小写字母起头
 *    的短词"）。这条是加完前两条修复后复验时才冒出来的。
 *
 * 所以除了字符集，还要**排除含点的 token**：子命令带点是极罕见的
 * （`git log` / `gh pr` / `npm test` / `kubectl get` 都不带），而文件名几乎都带。
 * 宁可漏认一个，不可把文件名当子命令——后者会出现在给人看的清单里。
 */
function looksLikeSubcommand(token) {
  if (typeof token !== "string") return false;
  const t = token.replace(/^["']|["']$/gu, "");
  // 一个正则同时挡住四类坏值：旗标（`-` 开头）、含点的文件名、`$(…)` 这类
  // shell 片段、以及超长的东西。上一版写成五道 if，等价但更啰嗦。
  return /^[a-z0-9][a-z0-9_-]{0,19}$/u.test(t);
}

/**
 * 一条命令 → 一个业务动作。
 *
 * 返回 `{ verb, sub, flags }` 或 `null`（不是业务命令，或抽不出动词）。
 * - `verb`：白名单里的动词（小写）
 * - `sub`：**扫描出的第一个像子命令的 token**（不是"第一个非旗标 token"——那个
 *   可能是路径或参数，见 `looksLikeSubcommand`）。找不到就是空串
 * - `flags`：`-` 开头的旗标。**位置参数一律丢弃**（理由见文件头隐私一节）
 */
export function businessCommandOf(command) {
  if (typeof command !== "string") return null;
  const cleaned = command.replace(REDIRECT_RE, " ").trim();
  if (cleaned === "" || CD_RE.test(cleaned)) return null;

  const tokens = cleaned.split(/\s+/u).filter((t) => t !== "");
  if (tokens.length === 0) return null;

  const verb = tokens[0].toLowerCase().replace(/^["']|["']$/gu, "");
  if (!BUSINESS_VERBS.has(verb)) return null;

  // **扫描**而不是取第一个非旗标：`git -C <path> log` 的子命令在 `-C <值>` 之后。
  let sub = "";
  for (let i = 1; i < tokens.length; i += 1) {
    if (looksLikeSubcommand(tokens[i])) {
      sub = tokens[i].replace(/^["']|["']$/gu, "").toLowerCase();
      break;
    }
  }

  // 旗标：只留 `-` 开头的、短的、不含路径分隔符的（`--base=<path>` 这类直接丢）。
  const flags = [];
  for (const raw of tokens.slice(1)) {
    const t = raw.replace(/^["']|["']$/gu, "");
    if (t.startsWith("-") && t.length > 1 && t.length <= 24 && !/[/\\=]/u.test(t)) flags.push(t);
  }

  return { verb, sub, flags: [...new Set(flags)].slice(0, 4) };
}

/**
 * 分组的键。
 *
 * 优先用子命令（`git status`）。**没有子命令时退而用第一个旗标**——因为对
 * `node` / `npm` 这类工具，真正区分语义的常常就是旗标：`node --test`（跑测试）与
 * `node --check`（查语法）是两件事，若键里只有 `node`，它们会被合并成一行，
 * 清单就读不出差别了。这条是端到端实测里发现的（16 次 node 调用被并成一条）。
 *
 * **旗标仍然只是"补充"，不是主体**：`git status -C --porcelain` 的键是 `git status`，
 * `-C`（它后面本来跟着一个被丢弃的路径）不该挤进键里。
 */
export function activityKey(activity) {
  if (!activity) return "";
  const tail = activity.sub || (Array.isArray(activity.flags) ? activity.flags[0] : "") || "";
  return tail ? `${activity.verb} ${tail}` : activity.verb;
}

/**
 * 一批观察 → 业务动作清单（按出现次数降序）。
 *
 * 每条：`{ key, verb, sub, count, flags }`；`flags` 是出现过的旗标并集（截断）。
 * **不含任何位置参数**，因此不含路径与用户名。
 */
export function tallyActivities(observations) {
  const groups = new Map();
  let shellNoise = 0;
  let totalSegments = 0;

  for (const observation of observations || []) {
    const command = observation?.command;
    if (typeof command !== "string" || command.trim() === "") continue;
    for (const raw of command.split(SEPARATOR_RE)) {
      if (raw.trim() === "") continue;
      totalSegments += 1;
      const activity = businessCommandOf(raw);
      if (!activity) {
        shellNoise += 1;
        continue;
      }
      const key = activityKey(activity);
      const cur = groups.get(key) || { key, verb: activity.verb, sub: activity.sub, count: 0, flags: new Set() };
      cur.count += 1;
      for (const f of activity.flags) cur.flags.add(f);
      groups.set(key, cur);
    }
  }

  const activities = [...groups.values()]
    .map((g) => ({ key: g.key, verb: g.verb, sub: g.sub, count: g.count, flags: [...g.flags].slice(0, 6) }))
    .sort((a, b) => (b.count === a.count ? a.key.localeCompare(b.key) : b.count - a.count));

  return {
    activities,
    // 两个数分开报：「业务动作很少」与「这条命令根本不是动作」是两件事。
    businessSegments: activities.reduce((n, a) => n + a.count, 0),
    shellNoise,
    totalSegments
  };
}
