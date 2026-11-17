/**
 * 日记的落盘位置。
 *
 * 为什么不写进用户绑定的那个项目目录（本次需求的原始想法是 `D:\\QQ对话\\日记\\`）：
 * 那类目录实测不是 git 仓库、没有 .gitignore，还堆着探针脚本——私密正文摊在那儿，
 * 误删没有任何回滚面。更要紧的是 mneme 成文的写盘面只有两处（`src/index.js` 的
 * `memoryDir` 与 `documentDir`），在这里开第三处「往用户任意工作区写」的能力，
 * 会让「删掉插件的目录就回滚干净」这条性质失效。
 *
 * 所以与 candidates / proposals / observations 同构（同一个纪律见
 * `src/pipeline-observations.js:11-19`）：**项目键分桶、宿在 memoryDir 下、不进仓库**。
 * 「入库到绑定项目」是另一件事——用户点按钮时导出过去，那是一个主动动作。
 */
import { join } from "node:path";
import { projectKey } from "../candidates.js";
import { expandHome as expandHomePath, resolveMemoryDir } from "../paths.js";

/** 展开 `~`。统一走 paths.js 的口径（原先这里与 candidates.js 各抄一份）。 */
export function expandHome(p) {
  return expandHomePath(p);
}

/** memoryDir 的基座，与 candidates/proposals/observations 三处同一条回落（中性根 + 存量兼容）。 */
export function memoryBase(memoryDir) {
  return resolveMemoryDir(memoryDir).dir;
}

/**
 * 日记根：`<memoryDir>/diaries`，或配置里给的目录。
 *
 * `diaryDir` 只改**根**，项目键分桶照旧——否则两个项目的日记会混进同一个平面目录，
 * 而「哪篇属于哪个项目」就只剩 frontmatter 一句话可查。
 */
export function diaryRoot({ memoryDir, configured = "" } = {}) {
  const custom = expandHome(configured && String(configured).trim() ? configured : "");
  return custom ? custom : join(memoryBase(memoryDir), "diaries");
}

/** `<root>/<项目键>/`。项目根拿不到时返回 null（调用方必须据此拒绝写，不许退成全局）。 */
export function diaryDir({ memoryDir, projectRoot, configured = "" } = {}) {
  const key = projectKey(projectRoot);
  if (!key) return null;
  return join(diaryRoot({ memoryDir, configured }), key);
}

/**
 * #613 §3：Agent 桶的根 `<root>/agents/`。与项目桶**并存不迁移**——存量项目桶
 * 一行不动，v2 起新写入进 Agent 桶；正交的两个维度，读取侧都列（library.js）。
 */
export function agentsRoot({ memoryDir, configured = "" } = {}) {
  return join(diaryRoot({ memoryDir, configured }), "agents");
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
 * 两份实现迟早漂——上移到路径层，library.js 转出口保持既有 import 面。
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
 * `<root>/agents/<agentId>/`。agentId 必须是单层目录名（isBucketName 口径），
 * 不合法返回 null——调用方据此落到 `_unnamed`，绝不退成别的目录名。
 */
export function diaryAgentDir({ memoryDir, agentId, configured = "" } = {}) {
  const id = String(agentId ?? "").trim();
  if (!id || !isBucketName(id)) return null;
  return join(agentsRoot({ memoryDir, configured }), id);
}

/** 只认 `YYYY-MM-DD.md`：同目录还住着 runs.jsonl，扫最新日期时不能把它算进去。 */
export const DIARY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

export function diaryFilePath(dir, dateLocal) {
  return join(dir, `${dateLocal}.md`);
}

/** 审计账本：每条 skip / failed / written 一行，回答「今天为什么没有日记」。 */
export function diaryAuditPath(dir) {
  return join(dir, "runs.jsonl");
}
