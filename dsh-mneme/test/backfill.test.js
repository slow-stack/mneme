// 导入会话批量回填的判据与计划（#606 之后的 DSH 0.2.2-rc.3 场景）。
//
// 这里锁三件事：① 判别是纯函数、只认两条信号；② dry-run 的数字与真跑用同一份
// 筛选；③ 真跑真的把「最近 N 轮」和「每窗 5 条」传下去了。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import test from "node:test";

import {
  DEFAULT_DAYS,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_ROUNDS,
  IMPORT_PROVIDER,
  isImportedSession,
  parseSessionTexts,
  planBackfill,
  readSessionFile,
  recentTurns,
  runBackfill
} from "../src/backfill.js";

const importedMessage = (seq) => ({
  type: "assistant/message",
  seq,
  data: {
    turn: 1,
    step: 1,
    message: {
      id: `m${seq}`,
      role: "assistant",
      content: [{ type: "text", text: "答" }],
      source: { kind: "model", provider: IMPORT_PROVIDER, model: IMPORT_PROVIDER }
    },
    stream: []
  }
});

const normalMessage = (seq) => ({
  type: "assistant/message",
  seq,
  data: {
    turn: 1,
    step: 1,
    message: {
      id: `m${seq}`,
      role: "assistant",
      content: [{ type: "text", text: "答" }],
      source: { kind: "model", provider: "deepseek-chat", model: "deepseek-chat" }
    },
    stream: []
  }
});

const turnStart = (turn, seq) => ({ type: "turn/start", seq, data: { turn } });
const turnEnd = (turn, seq, code = null) => ({
  type: "turn/end",
  seq,
  data: { turn, reason: code === null ? { kind: "completed" } : { kind: "error", error: { code, message: code } } }
});

function writeSessionFile(dir, id, { createdAt, events, name = "session.v4.jsonl.zstd" }) {
  const target = join(dir, "workspace-slug", id);
  mkdirSync(target, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", version: 4, id, createdAt, cwd: "/workspace", isSeeded: false }),
    ...events.map((event) => JSON.stringify(event))
  ];
  const buffer = zstdCompressSync(Buffer.from(`${lines.join("\n")}\n`, "utf8"));
  writeFileSync(join(target, name), buffer);
  return join(target, name);
}

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "mneme-backfill-"));
}

test("isImportedSession: provider 戳是主判据", () => {
  assert.equal(isImportedSession([turnStart(1, 0), importedMessage(1), turnEnd(1, 2)]), true);
  assert.equal(isImportedSession([turnStart(1, 0), normalMessage(1), turnEnd(1, 2)]), false);
  assert.equal(isImportedSession([]), false);
  assert.equal(isImportedSession(null), false);
  assert.equal(isImportedSession([{ type: "assistant/message" }]), false);
});

test("isImportedSession: 整条会话没有 assistant/message 时靠错误码兜底", () => {
  const events = [turnStart(1, 0), turnEnd(1, 1, "DEEPSEEK_EXPORT_TEMPLATE_RESPONSE")];
  assert.equal(isImportedSession(events), true);
  // 别把普通会话的失败也认成导入（错误码前缀必须吻合）。
  assert.equal(isImportedSession([turnStart(1, 0), turnEnd(1, 1, "STREAM_CLOSED")]), false);
});

test("isImportedSession: 不认 header 与 session/title", () => {
  const events = [
    { type: "session", version: 4, id: "s1", createdAt: 1, cwd: "/w", isSeeded: false },
    { type: "session/title", seq: 0, data: { title: "导入的标题" } }
  ];
  assert.equal(isImportedSession(events), false);
});

test("recentTurns: 只留最近 N 轮，且按 turn/start 切", () => {
  const events = [];
  for (let turn = 1; turn <= 25; turn += 1) {
    events.push(turnStart(turn, events.length));
    events.push({ type: "user/message", seq: events.length, data: { turn } });
    events.push(importedMessage(events.length));
    events.push(turnEnd(turn, events.length));
  }
  const trimmed = recentTurns(events, 20);
  assert.equal(trimmed[0].type, "turn/start");
  assert.equal(trimmed[0].data.turn, 6);
  assert.equal(trimmed[trimmed.length - 1].type, "turn/end");
  // 不截、以及没有 turn/start 的会话原样返回。
  assert.equal(recentTurns(events, 0).length, events.length);
  assert.equal(recentTurns(events, 100).length, events.length);
  const flat = [{ type: "user/message", seq: 0 }];
  assert.deepEqual(recentTurns(flat, 20), flat);
});

test("parseSessionTexts: 保留文件里的 seq，缺了按行号补", () => {
  const parsed = parseSessionTexts([
    `${JSON.stringify({ type: "session", id: "s1" })}\n${JSON.stringify({ type: "turn/start", seq: 7, data: { turn: 1 } })}`,
    `${JSON.stringify({ type: "turn/end", data: { turn: 1 } })}\nnot-json\n`
  ]);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].seq, 0); // header 没有 seq，按行号补
  assert.equal(parsed[1].seq, 7); // 文件里的 seq 原样保留
  assert.equal(parsed[2].seq, 2);
});

test("readSessionFile: 解出 header、事件与最后一条 seq", async () => {
  const root = makeRoot();
  try {
    const file = writeSessionFile(root, "session-a", {
      createdAt: 1_700_000_000_000,
      events: [turnStart(1, 0), importedMessage(1), turnEnd(1, 2)]
    });
    const reading = await readSessionFile(file);
    assert.equal(reading.header.id, "session-a");
    assert.equal(reading.header.createdAt, 1_700_000_000_000);
    assert.equal(reading.events.length, 4);
    assert.equal(reading.lastSeq, 2);
    assert.equal(reading.failed, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planBackfill: 计数、窗口、已消费与倒序都按同一份筛选算", async () => {
  const root = makeRoot();
  const now = Date.UTC(2026, 10, 14, 12, 0, 0);
  try {
    const day = 86400000;
    // 近 3 天内的导入会话（要跑）
    writeSessionFile(root, "imported-recent", {
      createdAt: now - day,
      events: [turnStart(1, 0), importedMessage(1), turnEnd(1, 2)]
    });
    // 更近的一条（用来验证倒序）
    writeSessionFile(root, "imported-newest", {
      createdAt: now - 1000,
      events: [turnStart(1, 0), importedMessage(1), turnEnd(1, 2)]
    });
    // 超出 90 天窗口
    writeSessionFile(root, "imported-old", {
      createdAt: now - 200 * day,
      events: [turnStart(1, 0), importedMessage(1), turnEnd(1, 2)]
    });
    // 普通会话：不计入导入
    writeSessionFile(root, "normal", {
      createdAt: now - day,
      events: [turnStart(1, 0), normalMessage(1), turnEnd(1, 2)]
    });
    // 导入且已被蒸馏完（游标追平）
    writeSessionFile(root, "imported-done", {
      createdAt: now - day,
      events: [turnStart(1, 0), importedMessage(1), turnEnd(1, 2)]
    });

    const cursors = new Map([["imported-done", 2]]);
    const service = { getDistillCursor: (id) => (cursors.has(id) ? { last_seq: cursors.get(id) } : undefined) };
    const plan = await planBackfill({
      service,
      sessionDir: root,
      now,
      config: { summarizeProvider: "deepseek-flash", summarizeModel: "deepseek-flash" }
    });

    assert.equal(plan.present, true);
    assert.equal(plan.filesScanned, 5);
    assert.equal(plan.importedSessions, 4);
    assert.equal(plan.outsideWindow, 1);
    assert.equal(plan.alreadyDistilled, 1);
    assert.equal(plan.pending, 2);
    assert.deepEqual(plan.candidates.map((item) => item.sessionId), ["imported-newest", "imported-recent"]);
    assert.equal(plan.routeConfigured, true);
    assert.equal(plan.callsPlanned, 2);
    assert.equal(plan.limit, 50);
    assert.equal(plan.days, DEFAULT_DAYS);
    assert.equal(plan.rounds, DEFAULT_ROUNDS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planBackfill: 没配蒸馏路由时 callsPlanned 为 0（dry-run 要看得见）", async () => {
  const root = makeRoot();
  try {
    writeSessionFile(root, "imported", {
      createdAt: Date.now(),
      events: [turnStart(1, 0), importedMessage(1), turnEnd(1, 2)]
    });
    const plan = await planBackfill({ sessionDir: root, config: {} });
    assert.equal(plan.pending, 1);
    assert.equal(plan.routeConfigured, false);
    assert.equal(plan.callsPlanned, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planBackfill: limit 只切候选，不改变账目", async () => {
  const root = makeRoot();
  try {
    const now = Date.now();
    for (let index = 0; index < 3; index += 1) {
      writeSessionFile(root, `imported-${index}`, {
        createdAt: now - index * 1000,
        events: [turnStart(1, 0), importedMessage(1), turnEnd(1, 2)]
      });
    }
    const plan = await planBackfill({ sessionDir: root, now, limit: 2 });
    assert.equal(plan.pending, 3);
    assert.equal(plan.candidates.length, 2);
    assert.equal(plan.candidates[0].sessionId, "imported-0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runBackfill: dry-run 不调 summarizer，一个 token 都不花", async () => {
  const root = makeRoot();
  try {
    writeSessionFile(root, "imported", {
      createdAt: Date.now(),
      events: [turnStart(1, 0), importedMessage(1), turnEnd(1, 2)]
    });
    let called = 0;
    const result = await runBackfill({
      sessionDir: root,
      config: { summarizeProvider: "p", summarizeModel: "m" },
      summarizer: { summarizeNow: () => { called += 1; } }
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.plan.callsPlanned, 1);
    assert.equal(called, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runBackfill: 真跑把最近 20 轮与 maxEntries 传下去，并逐条记账", async () => {
  const root = makeRoot();
  try {
    const events = [];
    for (let turn = 1; turn <= 25; turn += 1) {
      events.push(turnStart(turn, events.length));
      events.push({ type: "user/message", seq: events.length, data: { turn } });
      events.push(importedMessage(events.length));
      events.push(turnEnd(turn, events.length));
    }
    writeSessionFile(root, "imported", { createdAt: Date.now(), events });
    const calls = [];
    const result = await runBackfill({
      sessionDir: root,
      dryRun: false,
      config: { summarizeProvider: "p", summarizeModel: "m" },
      summarizer: {
        summarizeNow: (session, trigger, opts) => {
          calls.push({ session, trigger, opts });
        }
      }
    });
    assert.equal(result.dryRun, false);
    assert.equal(result.ran, 1);
    assert.equal(calls.length, 1);
    // 25 轮只送最近 20 轮：第一条是第 6 轮的 turn/start
    assert.equal(calls[0].session.events[0].data.turn, 6);
    assert.equal(calls[0].session.events.length, 80);
    assert.equal(calls[0].trigger.type, "turn/end");
    assert.equal(calls[0].opts.bypassPeak, true);
    assert.equal(calls[0].opts.maxEntries, DEFAULT_MAX_ENTRIES);
    assert.equal(result.results[0].status, "ran");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runBackfill: summarizer 自己的失败不影响后面的会话", async () => {
  const root = makeRoot();
  try {
    const now = Date.now();
    writeSessionFile(root, "a-bad", {
      createdAt: now - 1000,
      events: [turnStart(1, 0), importedMessage(1), turnEnd(1, 2)]
    });
    writeSessionFile(root, "b-good", {
      createdAt: now - 2000,
      events: [turnStart(1, 0), importedMessage(1), turnEnd(1, 2)]
    });
    const seen = [];
    const result = await runBackfill({
      sessionDir: root,
      dryRun: false,
      config: { summarizeProvider: "p", summarizeModel: "m" },
      summarizer: {
        summarizeNow: (session) => {
          seen.push(session.id);
          if (session.id === "a-bad") throw new Error("boom");
        }
      }
    });
    assert.deepEqual(seen, ["a-bad", "b-good"]);
    assert.equal(result.ran, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.results[0].status, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});