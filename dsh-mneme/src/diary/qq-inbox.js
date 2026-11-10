/**
 * 素材来源之一：QQ 聊天收件箱（只读）。
 *
 * 这个模块**不 import `dsh-onebot-qq` 的任何东西**——那个包是 npm 装进来的普通目录，
 * 每次升级都会被覆盖，边界靠这个 provider 的入参/返回值切开，而不是靠 require 路径。
 *
 * 素材口径（实测 `D:\\DSH\\.dsh\\media\\onebot\\qq-inbox.jsonl` 的 decision 分布定下来的）：
 * 只取 `decision.stage === "dispatch" && decision.ok === true` 且消息里真有 text 段的行。
 * 同一份样本里 70 行中，白名单挡掉的群聊 20 行、投递成功但无有效文本 5 行——不滤掉，
 * 日记就会变成「今天什么也没干」的噪音，还占掉 document 注入预算。
 *
 * 已知缺口（照实写在这里，别当它不存在）：inbox 只有**入站**消息，机器人自己的回复
 * 不在其中（样本里 message_sent 命中 0）。所以日记能写「今天她说了什么」，
 * 写不了「我怎么回的」——需要时得另找来源，不能靠这一份编。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { localDateString } from "./rollover.js";
import { memoryBase } from "./dir.js";

/** `qq-inbox.jsonl` = 当前代（0），`qq-inbox.N.jsonl` = 越旧 N 越大。 */
export const INBOX_FILE_RE = /^qq-inbox(?:\.(\d+))?\.jsonl$/;

function generationOf(name) {
  const m = INBOX_FILE_RE.exec(name);
  return m && m[1] ? Number(m[1]) : 0;
}

/**
 * 收件箱文件，**新的在前**。
 *
 * 目录读不到返回 null（= 没有这个来源），与「目录在但没有消息」严格区分：
 * 前者是 `no-inbox-dir`，后者是 `no-material`，两者的处置完全不同。
 */
export function inboxFiles(dir) {
  if (!dir) return null;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  return names
    .filter((n) => INBOX_FILE_RE.test(n))
    .sort((a, b) => generationOf(a) - generationOf(b));
}

/** 只打码长度 ≥6 的数字串（与 onebot `lib/record.js:47-49` 的 redactDigits 同口径）。 */
export function redactDigits(text) {
  return String(text ?? "").replace(/\d{6,}/g, (m) => m.slice(0, 3) + "****");
}

/** 一条消息里所有 text 段的拼接。图片/表情/语音段没有可读正文，直接跳过。 */
export function textOf(frame) {
  const msg = frame && frame.message;
  if (!Array.isArray(msg)) return "";
  return msg
    .filter((s) => s && s.type === "text" && s.data && typeof s.data.text === "string")
    .map((s) => s.data.text)
    .join("")
    .trim();
}

/** 有效投递：`dispatch` 且 `ok === true`。其余（whitelist / command / 失败）都不算素材。 */
export function isEffective(frame) {
  const d = frame && frame.decision;
  return !!d && d.stage === "dispatch" && d.ok === true;
}

/**
 * 采一段窗口内的素材。
 *
 * 返回三选一：
 * - `{items, scanned, ignored}` 拿到东西（items 可以为空 = 当天确实没聊）
 * - `{error: "no-inbox-dir"}` 没有这个来源（目录不在）
 * - `{error: "inbox-unreadable", detail}` 目录在但一个文件都读不出来
 */
export function collectQqInbox({ dir, dateLocal, maxItems = 400 } = {}) {
  if (!dir) return { error: "no-inbox-dir" };
  const files = inboxFiles(dir);
  if (files === null) return { error: "no-inbox-dir", detail: String(dir) };
  if (files.length === 0) return { error: "inbox-unreadable", detail: String(dir) };
  const items = [];
  let scanned = 0;
  let ignored = 0;
  let readable = 0;
  for (const name of files) {
    let text;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    readable += 1;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      scanned += 1;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        // 坏行跳过但计数（与 loadObservations 同一条纪律）。
        ignored += 1;
        continue;
      }
      if (!row || row.kind !== "message" || !isEffective(row.frame)) {
        ignored += 1;
        continue;
      }
      const ts = Number(row.ts);
      if (!Number.isFinite(ts)) {
        ignored += 1;
        continue;
      }
      // 不在当天窗口内的行不算「忽略」，它属于别的日子。
      if (localDateString(new Date(ts)) !== dateLocal) continue;
      const body = textOf(row.frame);
      if (!body) {
        ignored += 1;
        continue;
      }
      items.push({ ts, role: "user", text: redactDigits(body).slice(0, 2000) });
    }
  }
  if (readable === 0) return { error: "inbox-unreadable", detail: String(dir) };
  items.sort((a, b) => a.ts - b.ts);
  return { items: items.slice(-maxItems), scanned, ignored };
}

/**
 * 把 `<DSH_HOME>/media/onebot` 推出来：memoryDir 默认就是 `<DSH_HOME>/memory`。
 *
 * 推不出来（memoryDir 被指到别处、或给了显式配置）就用配置值；两者都没有时这个来源
 * 直接报 `no-inbox-dir`——宁可这一路没有素材，也不去猜别的盘。
 */
export function resolveInboxDir({ memoryDir, configured = "" } = {}) {
  const custom = String(configured ?? "").trim();
  if (custom) return custom;
  // 必须走 memoryBase 而不是直接用配置串：默认值就是带 `~` 的字面量，
  // 不展开的话 join 出来的路径永远落空，旁挂会静默读不到（CodeRabbit #458 F2）。
  return join(memoryBase(memoryDir), "..", "media", "onebot");
}
