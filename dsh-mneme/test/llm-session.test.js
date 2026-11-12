import test from "node:test";
import assert from "node:assert/strict";

import { BACKGROUND_SESSION_ID, withBackgroundSession } from "../src/llm-session.js";

// Issue #668：pi-ai 的 opencode / opencode-go 适配器只在 options.sessionId 存在时
// 才注入 x-opencode-session 头，插件侧后台调用一个都没传，于是走这些路由的用户
// 「记忆 → 状态」页全是 400 MissingSessionID。这组用例锁的是「每一处后台调用都
// 真的走到了补 sessionId 的那条路」，而不是只锁那个小函数本身——只测函数的话，
// 把某个调用点的 withBackgroundSession 删掉，测试照样全绿。

test("withBackgroundSession fills the id and never mutates its input", () => {
  const input = { provider: "p", model: "m" };
  const out = withBackgroundSession(input);
  assert.equal(out.sessionId, BACKGROUND_SESSION_ID);
  assert.equal(input.sessionId, undefined, "must not mutate the caller's object");
  assert.deepEqual({ ...out, sessionId: undefined }, { ...input, sessionId: undefined });
});

test("withBackgroundSession keeps a real session id the host already gave", () => {
  const out = withBackgroundSession({ sessionId: "sess-real", provider: "p" });
  assert.equal(out.sessionId, "sess-real", "a real conversation id is more precise than the plugin's");
  assert.equal(out.provider, "p");
});

test("withBackgroundSession tolerates junk input", () => {
  assert.equal(withBackgroundSession(undefined), undefined);
  assert.equal(withBackgroundSession(null), null);
});

// 下面四条是「接线」锁：直接读源码，确认每个后台 LLM 调用点的 stream 参数都被
// withBackgroundSession 包住了。删掉任何一处都会红。
test("every background llm.stream call site passes a session id (#668)", async () => {
  const { readFileSync } = await import("node:fs");
  const root = new URL("../src/", import.meta.url);
  const sites = [
    ["dream.js", "ctx.llm.stream(withBackgroundSession(options))"],
    ["dream/sleep.js", "ctx.llm.stream(withBackgroundSession(options))"],
    ["index.js", "llm.stream(withBackgroundSession({"],
    ["pre-inject-gate.js", "llm.stream(withBackgroundSession({ ...route, maxTokens: JUDGE_MAX_TOKENS"],
    ["api.js", "llm.stream(withBackgroundSession({"],
    ["image-describe.js", "ctx.llm.stream(withBackgroundSession({"],
    ["summarize.js", "withBackgroundSession(withEffort && summarizeEffort"]
  ];
  for (const [file, needle] of sites) {
    const src = readFileSync(new URL(file, root), "utf8");
    assert.ok(src.includes(needle), `${file} 的 llm.stream 调用必须补 sessionId（#668）`);
  }
});

test("no bare llm.stream(options) survives anywhere in src", async () => {
  const { readFileSync } = await import("node:fs");
  const root = new URL("../src/", import.meta.url);
  const files = ["dream.js", "dream/sleep.js", "index.js", "pre-inject-gate.js", "api.js", "image-describe.js", "summarize.js"];
  for (const file of files) {
    const src = readFileSync(new URL(file, root), "utf8");
    // 允许 withBackgroundSession(...) 包裹，也允许测试替身之外的无参形态；
    // 这里只禁「直接把一份裸 options 丢进 stream」这一种回归形态。
    assert.ok(!/\.stream\(\s*options\s*\)/.test(src), `${file} 里不该再出现裸 ctx.llm.stream(options)`);
    assert.ok(!/\.stream\(\{\s*\.\.\.route,/.test(src), `${file} 里不该再出现裸 llm.stream({ ...route》）`);
  }
});

test("the background id is a stable, greppable constant", () => {
  assert.equal(BACKGROUND_SESSION_ID, "dsh-mneme");
  assert.ok(BACKGROUND_SESSION_ID.length > 0 && BACKGROUND_SESSION_ID.length <= 64);
});
