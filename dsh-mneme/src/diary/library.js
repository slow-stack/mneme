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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DIARY_FILE_RE, diaryRoot } from "./dir.js";

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
 */
export function isBucketName(name) {
  const s = String(name ?? "");
  if (!s || s !== s.trim()) return false;
  if (s === "." || s === "..") return false;
  if (/[/\\]/.test(s)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  return true;
}

/**
 * 桶名 → 目录绝对路径。名字不合法就是 `null`。
 *
 * 这里**没有**第二道「解析后比对根前缀」的校验：`isBucketName` 已经挡住了
 * 分隔符与上跳，剩下的只可能是单层名字，前缀比对永远走不到。试过写它，
 * 变异测试（把比对删掉）一跑八条用例全绿，正说明它是死代码——那就别留，
 * 留着的防御没人能验证，反而让人以为这里有一层额外的兜底。
 */
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

/**
 * 全部桶。读不到根目录返回空清单而不是抛——「还没写过第一篇」与「路径坏了」
 * 在面板上是两种不同的话，但这一层分不出来，交给调用方去看 `root`。
 */
export function listDiaryLibrary({ memoryDir, configured = "" } = {}) {
  const root = diaryRoot({ memoryDir, configured });
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return { root, buckets: [] };
  }
  const buckets = [];
  const state = readBucketState(root);
  for (const name of names) {
    // `.deleted` 一类是回收站，不是日记。
    if (name.startsWith(".")) continue;
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
  buckets.sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0));
  return { root, buckets };
}

/** 读一篇的正文。桶名与日期都要过校验：这条路径直接拼文件系统。 */
export function readLibraryEntry({ memoryDir, configured = "", bucket, date } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ""))) return null;
  const root = diaryRoot({ memoryDir, configured });
  const dir = bucketDir(root, bucket);
  if (dir === null) return null;
  try {
    return readFileSync(join(dir, `${date}.md`), "utf8");
  } catch {
    return null;
  }
}
