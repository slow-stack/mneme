import test from "node:test";
import assert from "node:assert/strict";
import { withMaxTokensFallback, parseMaxTokensCap, MAX_TOKENS_REJECT_RE } from "../src/dream.js";

// Issue #478：dreamMaxTokens 默认 131072 原样发给 OpenAI 兼容网关，很多网关硬
// 上限更小（实测 dream_runs 180 连败的报错："max_tokens 不能超过 65536"），
// 400 直接拒、推理没开始。本套锁两件事：上限提取认得出显式上限、认不出时不猜；
// withMaxTokensFallback 在 stream（result===undefined + getStreamError）与
// throw 两条路径上都按提取到的上限降级重试恰一次，AbortError 永不被降级吞掉。

function makeLogger() {
  const warns = [];
  return { warns, logger: { warn: (...a) => warns.push(a.join(" ")), info() {}, error() {} } };
}

test("parseMaxTokensCap: 显式上限认得出（中/英/符号三种说法）", () => {
  assert.equal(parseMaxTokensCap("max_tokens 不能超过 65536"), 65536);
  assert.equal(parseMaxTokensCap("Maximum value is 65536"), 65536);
  assert.equal(parseMaxTokensCap("max_tokens must be at most 32768"), 32768);
  assert.equal(parseMaxTokensCap("max_tokens <= 8192"), 8192);
  assert.equal(parseMaxTokensCap("max_tokens 不得超过 4096"), 4096);
});

test("parseMaxTokensCap: 认不出显式上限时返回 null，绝不猜", () => {
  // 只有请求值、没有上限值——把 131072 误当上限会让重试原样再炸一次
  assert.equal(parseMaxTokensCap("max_tokens 131072 is too large for this model"), null);
  assert.equal(parseMaxTokensCap("bad request"), null);
  assert.equal(parseMaxTokensCap(""), null);
  assert.equal(parseMaxTokensCap(null), null);
});

test("MAX_TOKENS_REJECT_RE: 命中 max_tokens/maxTokens 两种写法，不误伤无关报错", () => {
  assert.ok(MAX_TOKENS_REJECT_RE.test("max_tokens 不能超过 65536"));
  assert.ok(MAX_TOKENS_REJECT_RE.test("maxTokens exceed limit"));
  assert.ok(!MAX_TOKENS_REJECT_RE.test("reasoning effort unsupported"));
});

test("withMaxTokensFallback: stream 路径（undefined + getStreamError）按上限降级重试恰一次", async () => {
  const { logger, warns } = makeLogger();
  const ctx = { logger };
  const calls = [];
  const attempt = async (tokens) => {
    calls.push(tokens);
    // 第一次发大值 → 网关拒收折叠成 undefined；重试用 65536 → 成功
    return tokens > 65536 ? undefined : `ok@${tokens}`;
  };
  const out = await withMaxTokensFallback(ctx, 131072, attempt, () =>
    "400 max_tokens 不能超过 65536");
  assert.equal(out, "ok@65536");
  assert.deepEqual(calls, [131072, 65536], "大值先发，拒收后按上限重试");
  assert.equal(warns.length, 1, "降级必须留痕");
  assert.match(warns[0], /131072.*65536/);
});

test("withMaxTokensFallback: throw 路径同样降级，AbortError 永远直通", async () => {
  const { logger } = makeLogger();
  const ctx = { logger };
  // throw 路径：第一次抛 400，重试成功
  const calls = [];
  const out = await withMaxTokensFallback(ctx, 131072, async (tokens) => {
    calls.push(tokens);
    if (tokens > 65536) throw new Error("invalid max_tokens: max_tokens 不能超过 65536");
    return `ok@${tokens}`;
  }, () => "");
  assert.equal(out, "ok@65536");
  assert.deepEqual(calls, [131072, 65536]);

  // AbortError：即使消息里带 max_tokens 字样也绝不触发重试（取消意图不可吞）
  const abort = new Error("max_tokens rejected during dispose");
  abort.name = "AbortError";
  const abCalls = [];
  await assert.rejects(
    withMaxTokensFallback(ctx, 131072, async (tokens) => { abCalls.push(tokens); throw abort; }, () => ""),
    /dispose/
  );
  assert.deepEqual(abCalls, [131072], "AbortError 不重试");
});

test("withMaxTokensFallback: 无上限可提取或上限不小于当前值时不重试", async () => {
  const { logger } = makeLogger();
  const ctx = { logger };
  // 报错只有请求值没有上限 → 不猜，原样 undefined 返回
  let calls = 0;
  const out1 = await withMaxTokensFallback(ctx, 131072, async () => { calls++; return undefined; }, () =>
    "max_tokens 131072 is too large for this model");
  assert.equal(out1, undefined);
  assert.equal(calls, 1, "认不出上限就不重试");

  // 上限 >= 当前值（报错自相矛盾）→ 不重试，throw 路径原样抛
  const boom = new Error("max_tokens 不能超过 131072");
  await assert.rejects(
    withMaxTokensFallback(ctx, 131072, async () => { throw boom; }, () => ""),
    (e) => e === boom,
    "cap >= maxTokens 时不重试且原样抛"
  );
});

test("withMaxTokensFallback: 无关报错不触发重试（stream 与 throw 双路径）", async () => {
  const { logger } = makeLogger();
  const ctx = { logger };
  let calls = 0;
  const out = await withMaxTokensFallback(ctx, 131072, async () => { calls++; return undefined; }, () =>
    "reasoning effort UNSUPPORTED_REASONING_EFFORT");
  assert.equal(out, undefined);
  assert.equal(calls, 1);

  await assert.rejects(
    withMaxTokensFallback(ctx, 131072, async () => { throw new Error("quota exhausted"); }, () => ""),
    /quota exhausted/
  );
});

// 接线锁：单测绿不代表真接上了。#478 的第一次实现只挂了 dream 侧三个点，
// sleep.js 两处仍原样发 config.sleepMaxTokens，而面板 hint 已对外承诺
// 「超上限同样自动降级」——这种「函数有、没人用」的缺口只靠行为测试抓不到。
test("接线锁：dreamMaxTokens/sleepMaxTokens 的五个使用点全部包在 withMaxTokensFallback 里", async () => {
  const { readFile } = await import("node:fs/promises");
  const srcDir = new URL("../src/", import.meta.url);
  const files = { "dream.js": await readFile(new URL("dream.js", srcDir), "utf8"), "dream/sleep.js": await readFile(new URL("dream/sleep.js", srcDir), "utf8") };
  for (const [name, source] of Object.entries(files)) {
    // 任何一处还把 config.dreamMaxTokens/sleepMaxTokens 直接当 maxTokens 发，就是漏接线。
    assert.ok(
      !/maxTokens:\s*config\.(dream|sleep)MaxTokens/.test(source),
      `${name}: still passes config.*MaxTokens straight into maxTokens — wrap it in withMaxTokensFallback`
    );
  }
  // 五个调用点：dream 三条（叙述/巩固/摘要）+ sleep 两条（冲突/模式）。
  const dreamHits = files["dream.js"].match(/withMaxTokensFallback\(ctx, config\.dreamMaxTokens/g) ?? [];
  const sleepHits = files["dream/sleep.js"].match(/withMaxTokensFallback\(ctx, config\.sleepMaxTokens/g) ?? [];
  assert.equal(dreamHits.length, 3, `dream.js must wrap all 3 dreamMaxTokens sites (got ${dreamHits.length})`);
  assert.equal(sleepHits.length, 2, `dream/sleep.js must wrap both sleepMaxTokens sites (got ${sleepHits.length})`);
});
