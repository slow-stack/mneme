/**
 * 日记的读侧与「入库」。
 *
 * 「入库」是用户点按钮时**主动**把某一篇复制到绑定项目里——不是日记默认就写在那儿。
 * 这两件事分开的理由写在 `dir.js`：默认写进用户工作区会让「删掉插件目录就回滚干净」
 * 这条性质失效，而那正是 mneme 现有写盘面的成文契约。
 *
 * 复制而不是移动：memoryDir 那一份是主副本（还挂着指针行），项目里那份是给人看的。
 * 移走会让指针行指向一个已经被搬空的路径，`registerDocument` 下次校验就抛。
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DIARY_FILE_RE, diaryFilePath } from "./dir.js";

/** 入库目标：`<项目>/diary/`。与项目里其它人类可读产物同层，不埋进点目录。 */
export const EXPORT_SUBDIR = "diary";

/**
 * 列出目录里已有的日记，新的在前。
 *
 * 读不到目录返回 `[]`（= 还没写过），不抛——面板的空态与「坏了」必须能分开，
 * 而这里「读不到」的绝大多数情况就是「还没写过第一篇」。
 */
export function listDiaries(dir) {
  if (!dir) return [];
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

/** 读一篇正文。读不到返回 null（面板据此显示「还没有这一篇」而不是一个空框）。 */
export function readDiary(dir, date) {
  if (!dir || !/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ""))) return null;
  try {
    return readFileSync(diaryFilePath(dir, date), "utf8");
  } catch {
    return null;
  }
}

/**
 * 把一篇复制进绑定项目。
 *
 * `overwrite:false` 时目标已存在就拒绝——那是**用户项目里**的文件，可能已经被他改过，
 * 机器无声覆盖比不做更糟。要覆盖必须显式传 `overwrite:true`（面板上是一次确认）。
 */
export function exportDiary({ sourceDir, projectRoot, date, overwrite = false } = {}) {
  if (!sourceDir) return { ok: false, error: "no-source" };
  if (!projectRoot) return { ok: false, error: "project-unknown" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ""))) return { ok: false, error: "bad-date" };
  const from = diaryFilePath(sourceDir, date);
  let st;
  try {
    st = statSync(from);
  } catch {
    return { ok: false, error: "no-diary", date };
  }
  if (!st.isFile() || st.size <= 0) return { ok: false, error: "no-diary", date };
  const toDir = join(projectRoot, EXPORT_SUBDIR);
  const to = join(toDir, `${date}.md`);
  try {
    mkdirSync(toDir, { recursive: true });
  } catch (error) {
    return { ok: false, error: "target-unwritable", detail: String(error && error.message ? error.message : error) };
  }
  if (!overwrite) {
    try {
      statSync(to);
      return { ok: false, error: "target-exists", path: to };
    } catch {
      // 目标不存在才是可以写的路径。
    }
  }
  try {
    copyFileSync(from, to);
  } catch (error) {
    return { ok: false, error: "copy-failed", detail: String(error && error.message ? error.message : error) };
  }
  return { ok: true, date, path: to, bytes: st.size };
}
