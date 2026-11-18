// 2026-11-18 保护层接线（#688 续）：导入会话与排除项目的蒸馏门卫。
// 设计要点：
// 1. 项目排除放在门卫区（route 解析之后、间隔门之前）——被挡的会话连路由都不该解析。
// 2. backfill（src/backfill.js）走 summarizeNow 且必须透传 bypassImported: true，
//    否则回填被自己的保护层挡死。opts 显式旁路，与 bypassPeak 同形。
// 3. 判据只读会话上已有的事件/header：导入判定由 src/imported-session.js 的纯函数
//    负责（summarize.js 复用 collectMessages 已读好的窗口，不额外快照）。
// 4. cwd 读 session.header?.cwd（创建时冻结的那份，不能读 requestHeader——
//    scope.js 踩过的坑，pipeline-runner.js:57-62 projectRootOf 同口径）。
// 5. 前缀比较按平台分隔符归一后 startsWith；大小写不敏感（Windows 盘符
//    C:/c、D:/d 都会出现）。

/**
 * 把一段路径归一成可比较形态：统一 / 与 \、剥尾部斜杠、小写。
 * 非字符串或纯空白返回 null（调用方跳过）。
 *
 * **文件系统根是有效条目，不当作空值丢掉**：名单里写 `/` 的意思是「全挡」，
 * 剥尾后不能变成 null 让整条规则失效（那是 CodeRabbit 在 #755 抓到的洞）。
 * 盘符根（`C:\`）剥尾后是 `c:`，它作为前缀本身就能命中 `c:/...`，无需特判。
 */
function normalizeProjectPath(raw) {
  if (typeof raw !== "string") return null;
  // 连续分隔符顺手折叠：手写配置里 `/work//private` 与 `/work/private` 是同一个目录，
  // 折叠后比较才不会因为一个多打的斜杠漏挡。
  const unified = raw.trim().replace(/[\\/]/g, "/").replace(/\/{2,}/g, "/");
  if (!unified) return null;
  const stripped = unified.replace(/\/+$/, "");
  // 剥干净了说明它本身就是根（"/"）——保留，不要掉成 null。
  if (!stripped) return "/";
  return stripped.toLowerCase();
}

/**
 * 排除名单命中判定：名单项归一后，cwd 必须等于它或是它的子路径。
 * 名单项里带通配符/正则一律按字面路径处理（不展开语义）。
 *
 * 根目录（`/`）是「整机全挡」，任何绝对路径都算它的后代；否则按
 * `target + "/"` 做前缀比较，`private-public` 不会被 `private/` 误伤。
 */
function isExcludedProject(sessionCwd, excludeList) {
  const cwd = normalizeProjectPath(sessionCwd);
  if (!cwd || !Array.isArray(excludeList) || excludeList.length === 0) return false;
  for (const item of excludeList) {
    const target = normalizeProjectPath(item);
    if (!target) continue;
    if (target === "/") return true; // 根目录：全挡
    if (cwd === target || cwd.startsWith(target + "/")) return true;
  }
  return false;
}

export { isExcludedProject, normalizeProjectPath };
