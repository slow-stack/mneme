// 2026-11-18 保护层接线（#688 续）：导入会话与排除项目的蒸馏门卫。
// 设计要点：
// 1. 放在 sessionGate 之后、route 解析之前——被挡的会话连路由都不该解析。
// 2. backfill（src/backfill.js:244-247）走 summarizeNow 且必须透传 bypassImported:
//    true，否则回填被自己的保护层挡死。opts 显式旁路，与 bypassPeak 同形。
// 3. 判据读事件走 snapshotSessionEvents(session)（无 seq 参数 = 全量），与
//    collectMessages 同一把读取器；sessionGate 有同形状先例（isChild(session)）。
// 4. cwd 读 session.header?.cwd（创建时冻结的那份，不能读 requestHeader——
//    scope.js 踩过的坑，pipeline-runner.js:57-62 projectRootOf 同口径）。
// 5. 前缀比较用 platform 分隔符归一后 startsWith；大小写不敏感（Windows 盘符
//    C:/c、D:/d 都会出现）。

/**
 * 把一段路径归一成可比较形态：统一 / 与 \、剥尾部分隔符、小写。
 * 空串/非字符串返回 null（调用方跳过）。
 */
function normalizeProjectPath(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/[\\/]+$/, "").replace(/[\\/]/g, "/").toLowerCase();
  return s || null;
}

/**
 * 排除名单命中判定：名单项归一后，cwd 必须等于它或是它的子路径。
 * 名单项里带通配符/正则一律按字面路径处理（不展开语义）。
 */
function isExcludedProject(sessionCwd, excludeList) {
  const cwd = normalizeProjectPath(sessionCwd);
  if (!cwd || !Array.isArray(excludeList) || excludeList.length === 0) return false;
  for (const item of excludeList) {
    const target = normalizeProjectPath(item);
    if (!target) continue;
    if (cwd === target || cwd.startsWith(target + "/")) return true;
  }
  return false;
}

export { isExcludedProject, normalizeProjectPath };
