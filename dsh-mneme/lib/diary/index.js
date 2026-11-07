/**
 * 日记本（QQ 机器人写日记）。
 *
 * 需求原文要的是「让机器人每天写一篇日记，侧栏能把日记入库到绑定的项目里」。
 * 拆开是三件事，落在三处：
 *
 * 1. **写什么** —— `compose.js`：素材 → 一段正文 → 原子落盘 → 指针行。
 * 2. **什么时候写** —— `auto.js`：本机没有日历调度原语，所以是「跨天惰性判定 +
 *    启动补写」，不是 cron。判定本身在 `rollover.js`，是纯函数。
 * 3. **素材从哪来** —— `qq-inbox.js`：只读 QQ 收件箱。这一层是 provider 形状，
 *    以后接别的来源只需要再写一个同签名模块，compose 不认识 QQ。
 *
 * 正文宿在 `<memoryDir>/diaries/<项目键>/YYYY-MM-DD.md`（见 `dir.js` 里为什么不写
 * 进用户工作区）；记忆库里只有一条 `type="document"` 指针行，复用既有铸造口。
 */
export { createDiaryComposer, validateBody, latestDiaryDate, MIN_BODY_CHARS, MAX_MATERIAL_ITEMS } from "./compose.js";
// 「什么时候写」的纯函数与「素材从哪来」的 provider 形状，都在上面两个文件里。
export { createDiaryAutoRun, DIARY_MIN_INTERVAL_MS } from "./auto.js";
export { collectQqInbox, inboxFiles, redactDigits, resolveInboxDir, INBOX_FILE_RE } from "./qq-inbox.js";
export { collectSessionTranscript, sessionAgentId, MAX_ITEM_CHARS } from "./session-provider.js";
export { diaryDir, diaryRoot, diaryFilePath, diaryAuditPath, memoryBase, expandHome, DIARY_FILE_RE } from "./dir.js";
export { localDateString, shouldRollDay, dayGap, MAX_CATCH_UP_DAYS } from "./rollover.js";
export { listDiaries, readDiary, exportDiary, EXPORT_SUBDIR } from "./export.js";
