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
import { homedir } from "node:os";
import { join } from "node:path";
import { projectKey } from "../candidates.js";

/** 展开 `~`。candidates.js 里那份是私有的，这里按同一口径抄一份最小实现。 */
export function expandHome(p) {
  const s = String(p ?? "");
  if (s === "~") return homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) return join(homedir(), s.slice(2));
  return s;
}

/** memoryDir 的基座，与 candidates/proposals/observations 三处同一条回落。 */
export function memoryBase(memoryDir) {
  return expandHome(memoryDir && String(memoryDir).trim() ? memoryDir : "~/.dsh/memory");
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

/** 只认 `YYYY-MM-DD.md`：同目录还住着 runs.jsonl，扫最新日期时不能把它算进去。 */
export const DIARY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

export function diaryFilePath(dir, dateLocal) {
  return join(dir, `${dateLocal}.md`);
}

/** 审计账本：每条 skip / failed / written 一行，回答「今天为什么没有日记」。 */
export function diaryAuditPath(dir) {
  return join(dir, "runs.jsonl");
}
