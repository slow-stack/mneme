/**
 * 日记库：把 `<memoryDir>/diaries/` 底下的所有分桶读成「谁写了多少篇」的清单。
 *
 * 和 `dir.js` 的分工：那边管**一个桶在哪**（给定 projectRoot 算键与路径），
 * 这边管**有哪些桶**——左侧面板要的是后者，它拿不到「当前会话的项目」，
 * 因为 `main` 座位不注入 sessionId。
 *
 * 「谁写的」只记在正文 frontmatter 里（`persona: settings (amarre)`），库里
 * 没有第二份。所以这里读最新一篇的 frontmatter 来认人：读不到就退回桶名，
 * 绝不猜——猜错会把 A 的日记挂到 B 名下，而那在界面上看不出来。
 */
import { readdirSync, readFileSync, statSync, renameSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DIARY_FILE_RE, diaryRoot, agentsRoot, isBucketName } from "./dir.js";

/** frontmatter 块：文件必须以 `---` 起头，第二道横线收尾。 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * 桶键 → 项目根与写日记的 agent。来源是 diaries/state.json（compose 自己写的账本）。
 *
 * 为什么面板要这个：一个桶就是一份 `projectKey(projectRoot)` 的产物，桶名里只有
 * 目录名和 8 位哈希，**反推不回绝对路径**。而「现在再写一篇」必须给 `project`。
 * 读不到就返回空表——那是「这个桶是别人手工放的」或「账本丢了」，面板那时候
 * 就不该长出一个点了必然 400 的按钮。
 */
function readBucketState(root) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  } catch {
    return {};
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

/**
 * 桶名合法性：**不按字符集白名单**，按「它是个单层目录名」判。
 *
 * 一开始写的是 `^[A-Za-z0-9._-]+$`，理由是路径成分越严越好——但现场就有一个
 * 保留中文的桶（`QQ对话-4f061790`，用户那天让另一个会话手工写的）。白名单会把
 * 那一本从导航栏里抹掉，等于把用户写过的日记藏起来，而界面上看不出来。
 *
 * 所以要挡的是**路径语义**，不是字符：分隔符、上跳、控制字符、首尾空白、
 * 以及 `.` / `..` 这两个特殊目录名。挡完这些，桶名就只剩「单层目录名」这一种
 * 可能，下游可以直接拼路径，不需要再比一次路径前缀（见 `bucketDir` 的注释）。
 *
 * 原本住在 library.js；#613 之后 dir.js 的 diaryAgentDir 也要用同一把尺，
 * 两份实现迟早漂——上移到路径层，这里转出口保持既有 import 面不破
 * （diary-library.test.js 从这里 import）。
 */
export { isBucketName };

function bucketDir(root, bucket) {
  if (!isBucketName(bucket)) return null;
  return join(root, bucket);
}

function readFrontmatter(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const hit = FRONTMATTER_RE.exec(text);
  if (!hit) return {};
  const out = {};
  for (const line of hit[1].split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * 列一个桶里的日记文件。与 `export.js` 的 `listDiaries` 同一口径
 * （只认 `YYYY-MM-DD.md`、跳过空文件、新的在前），这里不重复实现。
 */
function diaryFiles(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    if (!DIARY_FILE_RE.test(name)) continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size <= 0) continue;
    rows.push({ date: name.slice(0, 10), path, bytes: st.size, mtime: st.mtimeMs });
  }
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** 账本追加的尾换行检查（与 compose.js 的 appendAudit 同一条纪律，这里是多行版）。 */
function appendLines(file, lines) {
  const rows = lines.filter((l) => l.trim());
  if (!rows.length) return;
  let prefix = "";
  try {
    const stat = statSync(file);
    if (stat.size > 0) {
      const raw = readFileSync(file, "utf8");
      if (!/\n$/.test(raw)) prefix = "\n";
    }
  } catch {
    // 目标没有账本，直接创建。
  }
  writeFileSync(file, prefix + rows.join("\n") + "\n", { flag: "a" });
}

/**
 * #613 §3.2：同 hash 项目桶的自动归并。项目键的后缀是 sha256(projectRoot) 的前
 * 8 位（candidates.js:194 起的口径），前缀清洗规则一改就漂、hash 不会——所以认
 * 桶只认后缀，前缀仅作展示。live 库真发生过「同一项目两个桶」（QQ对话-4f061790
 * 与 QQ---4f061790），当时是手工合并的；这里把那条手工流程自动化：
 * - 组内只有一个桶 → 什么都不做；
 * - 日期不重叠 → 全部条目 rename 进目标桶。目标 = 有 runs.jsonl 的那个（手工
 *   合并时选它的依据），否则条目最多的，否则名字排序第一个；
 * - 日期重叠 → 绝不静默覆盖：目标里先到的留原名，源桶这篇降级为
 *   `<date>.conflict-<ts>.md`（不在 DIARY_FILE_RE 里，面板不列，盘上可查）
 *   ——两份都留着；
 * - runs.jsonl 按行追加进目标（§3.3：缺的就是缺，不补写、不伪造历史记账）；
 * - 源桶清空后删除目录。
 *
 * 在 library 读取前跑：面板打开一次就自愈一次。best-effort——任何一步失败只
 * warn，不阻塞列表。
 */
export function mergeSameHashBuckets(root, log = null) {
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  const groups = new Map();
  for (const name of names) {
    if (name.startsWith(".") || name === "agents") continue; // agents/ 是 #613 的命名空间，项目桶不许撞名
    if (!isBucketName(name)) continue;
    const m = /-([0-9a-f]{8})$/i.exec(name);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(name);
  }
  let merged = 0;
  for (const [, list] of groups) {
    if (list.length < 2) continue;
    try {
      const sorted = [...list].sort();
      const withRuns = sorted.filter((n) => existsSync(join(root, n, "runs.jsonl")));
      const target = withRuns[0]
        ?? sorted.reduce((best, n) => (diaryFiles(join(root, n)).length > diaryFiles(join(root, best)).length ? n : best), sorted[0]);
      for (const source of sorted) {
        if (source === target) continue;
        const srcDir = join(root, source);
        const dstDir = join(root, target);
        for (const file of diaryFiles(srcDir)) {
          const dst = join(dstDir, `${file.date}.md`);
          if (!existsSync(dst)) {
            // 日期不重叠：整篇归位。
            renameSync(file.path, dst);
          } else {
            // 日期重叠：绝不静默覆盖——目标里先到的留原名，源桶这篇降级为
            // conflict 副本，两份都留在盘上。
            copyFileSync(file.path, join(dstDir, `${file.date}.conflict-${Date.now()}.md`));
          }
        }
        // runs.jsonl 追加（§3.3）：源桶有的按行拼到目标尾部；没有就是没有。
        const srcRuns = join(srcDir, "runs.jsonl");
        if (existsSync(srcRuns)) {
          appendLines(join(dstDir, "runs.jsonl"), readFileSync(srcRuns, "utf8").split("\n"));
        }
        rmSync(srcDir, { recursive: true, force: true });
        merged += 1;
        log?.warn?.(`[dsh-mneme] diary: merged same-hash bucket ${source} into ${target}`);
      }
    } catch (error) {
      log?.warn?.(`[dsh-mneme] diary: same-hash merge failed: ${String((error && error.message) || error)}`);
    }
  }
  return merged;
}

/**
 * 全部桶。读不到根目录返回空清单而不是抛——「还没写过第一篇」与「路径坏了」
 * 在面板上是两种不同的话，但这一层分不出来，交给调用方去看 `root`。
 *
 * #613 §3：Agent 桶（`<root>/agents/<agentId>/`）与项目桶**并存不迁移**，读取
 * 侧都列。agent 桶没有 projectRoot/项目键——面板的「写一篇」走 agentMode 路由；
 * 认人靠 frontmatter 的 persona 行（与项目桶同一口径）。
 */
export function listDiaryLibrary({ memoryDir, configured = "", log = null } = {}) {
  const root = diaryRoot({ memoryDir, configured });
  // 同 hash 桶归并先于扫描：面板打开一次就自愈一次；失败不阻塞列表。
  try {
    mergeSameHashBuckets(root, log);
  } catch {
    // 归并是自愈不是前提，失败照常列。
  }
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return { root, buckets: [] };
  }
  const buckets = [];
  const state = readBucketState(root);
  for (const name of names) {
    // `.deleted` 一类是回收站，不是日记；`agents` 是 #613 的命名空间（归 agent
    // 桶扫描管），项目桶不许撞名。
    if (name.startsWith(".")) continue;
    if (name === "agents") continue;
    if (!isBucketName(name)) continue;
    const dir = join(root, name);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const files = diaryFiles(dir);
    // 空桶（文件被删光、只剩 runs.jsonl）不列：导航栏里挂一个点开是空的项
    // 比不列更糟。
    if (!files.length) continue;
    let persona = "";
    let project = "";
    for (const file of files) {
      const fm = readFrontmatter(file.path);
      if (!project && fm.project) project = fm.project;
      // persona 只认第一篇带它的：同一桶里可能先后住过两个人格（#613 要拆的那种），
      // 面板先按最新那篇记的人显示，不混。
      if (fm.persona) {
        persona = fm.persona;
        break;
      }
    }
    const meta = state[name] && typeof state[name] === "object" ? state[name] : {};
    buckets.push({
      key: name,
      project,
      // 「现在再写一篇」需要的两样：绝对路径与写作者身份。账本里没有就留空，
      // 面板据此把按钮禁掉——不猜路径，猜错会写在别的项目里。
      projectRoot: typeof meta.projectRoot === "string" ? meta.projectRoot : "",
      agentId: typeof meta.agentId === "string" ? meta.agentId : "",
      persona,
      latest: files[0].date,
      count: files.length,
      entries: files.map((file) => ({ date: file.date, bytes: file.bytes, mtime: file.mtime }))
    });
  }
  // Agent 桶扫描。`agents/<agentId>/` 一目录一本书；没有 projectRoot/项目键，
  // 认人靠 frontmatter 的 persona 行。
  const agentsDir = agentsRoot({ memoryDir, configured });
  let agentNames;
  try {
    agentNames = readdirSync(agentsDir);
  } catch {
    agentNames = [];
  }
  for (const agentId of agentNames) {
    if (!isBucketName(agentId)) continue;
    const dir = join(agentsDir, agentId);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const files = diaryFiles(dir);
    if (!files.length) continue;
    let persona = "";
    for (const file of files) {
      const fm = readFrontmatter(file.path);
      if (fm.persona) {
        persona = fm.persona;
        break;
      }
    }
    buckets.push({
      key: `agents/${agentId}`,
      project: "",
      projectRoot: "",
      agentId,
      persona,
      latest: files[0].date,
      count: files.length,
      entries: files.map((file) => ({ date: file.date, bytes: file.bytes, mtime: file.mtime }))
    });
  }
  buckets.sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0));
  return { root, buckets };
}

/** 读一篇的正文。桶名与日期都要过校验：这条路径直接拼文件系统。
 *  #613：`agents/<agentId>` 形状的桶读 agent 桶（isBucketName 挡路径语义后拼一层）。 */
export function readLibraryEntry({ memoryDir, configured = "", bucket, date } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ""))) return null;
  const root = diaryRoot({ memoryDir, configured });
  const name = String(bucket ?? "");
  let dir = null;
  if (name.startsWith("agents/")) {
    const agentId = name.slice("agents/".length);
    dir = isBucketName(agentId) ? join(agentsRoot({ memoryDir, configured }), agentId) : null;
  } else {
    dir = bucketDir(root, bucket);
  }
  if (dir === null) return null;
  try {
    return readFileSync(join(dir, `${date}.md`), "utf8");
  } catch {
    return null;
  }
}
