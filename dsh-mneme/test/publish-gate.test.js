// scripts/publish-gate.mjs 的回归测试。
//
// 这一步的价值全在「不许假绿」上：原先的 Verify published version 是
//   echo "Published: $(npm view "@modusensus/dsh-mneme@${V}" version)"
// 命令替换里的失败不让 `set -e` 退出 —— v0.8.16 那次日志里明明 `404 No match found for version
// 0.8.16`，step 与 job 却都是 success。下面第一条与第三条各自钉住两端：
//   · 版本已在 registry（幂等跳过路径）→ 立刻通过，不为传播延迟白等；
//   · 等满预算仍看不见 → 必须 `ok:false` 且入口退出 1。
// 谁要是把「拿不到」改成「跳过校验」或「返回成功」，第三条会红。
//
// 全部用例走假时钟 + 注入 probe：零网络、零真实等待，跑起来是毫秒级。
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  PACKAGE_NAME,
  main,
  parseArgs,
  probeVersion,
  versionUrl,
  waitForPublished
} from "../scripts/publish-gate.mjs";

/** 假时钟：只有 sleep() 会让时间前进，于是超时逻辑可以确定性断言。 */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    slept: () => t
  };
}

const noop = () => {};

/** 前 `misses` 次报 404、之后可见的 probe；锁的是「重试真的发生了」。 */
function probeMissingTimes(misses, { version = "0.8.16" } = {}) {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls <= misses) return { ok: false, reason: "missing", detail: "HTTP 404，registry 上还看不到" };
    return { ok: true, version, tarball: "https://registry.npmjs.org/x/-/x-0.8.16.tgz" };
  };
}

test("版本已在 registry：首次探测即通过，不为传播延迟白等（幂等跳过路径）", async () => {
  const clock = fakeClock();
  let sleeps = 0;
  const result = await waitForPublished("0.8.16", {
    now: clock.now,
    sleep: async (ms) => { sleeps += 1; await clock.sleep(ms); },
    probe: probeMissingTimes(0),
    log: noop
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.waitedMs, 0);
  assert.equal(sleeps, 0, "已发布路径不该有任何等待");
});

test("传播延迟：前两次 404、第三次可见 → 通过，且等待时间与重试次数如实报出", async () => {
  const clock = fakeClock();
  const result = await waitForPublished("0.8.16", {
    now: clock.now,
    sleep: clock.sleep,
    intervalMs: 15000,
    probe: probeMissingTimes(2),
    log: noop
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(result.waitedMs, 30000, "两次间隔的等待要计入");
  assert.ok(result.tarball.includes("0.8.16"));
});

test("等满预算仍看不见：必须 ok:false + reason timeout（防的就是 v0.8.16 那种假绿）", async () => {
  const clock = fakeClock();
  const result = await waitForPublished("0.8.16", {
    now: clock.now,
    sleep: clock.sleep,
    timeoutMs: 30000,
    intervalMs: 15000,
    probe: probeMissingTimes(Infinity),
    log: noop
  });
  assert.equal(result.ok, false, "拿不到版本时绝不是成功");
  assert.equal(result.reason, "timeout");
  assert.equal(result.attempts, 3, "t=0 / 15s / 30s 各一次探测");
  assert.equal(result.waitedMs, 30000);
  assert.match(result.lastError, /404/);
});

test("预算不是间隔整数倍时：最后一轮只睡到超时点，不多睡一整轮", async () => {
  const clock = fakeClock();
  const result = await waitForPublished("0.8.16", {
    now: clock.now,
    sleep: clock.sleep,
    timeoutMs: 20000,
    intervalMs: 15000,
    probe: probeMissingTimes(Infinity),
    log: noop
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3, "t=0 / 15s / 20s（最后一次落在超时点上）");
  assert.equal(result.waitedMs, 20000);
  assert.equal(clock.slept(), 20000, "总睡眠时间恰为预算，而不是 30000");
});

test("网络异常同样计入重试（既不崩也不当作成功），最终以最后一次原因报出", async () => {
  const clock = fakeClock();
  let calls = 0;
  const result = await waitForPublished("0.8.16", {
    now: clock.now,
    sleep: clock.sleep,
    timeoutMs: 15000,
    intervalMs: 15000,
    probe: async () => { calls += 1; return { ok: false, detail: `请求失败：fetch failed（第 ${calls} 次）` }; },
    log: noop
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2, "异常也继续重试");
  assert.match(result.lastError, /第 2 次/, "报的是最后一次原因");
});

test("probe 返回形状异常（undefined）也不炸，按拿不到处理", async () => {
  const clock = fakeClock();
  const result = await waitForPublished("0.8.16", {
    now: clock.now,
    sleep: clock.sleep,
    timeoutMs: 0,
    intervalMs: 15000,
    probe: async () => undefined,
    log: noop
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
});

test("默认预算：超时 10 分钟 / 间隔 15 秒（覆盖实测 ~4.5 分钟的传播延迟）", () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 600000);
  assert.equal(DEFAULT_INTERVAL_MS, 15000);
});

test("versionUrl：scoped 包名整体编码，origin 尾斜杠不重复", () => {
  assert.equal(
    versionUrl(PACKAGE_NAME, "0.8.16"),
    "https://registry.npmjs.org/%40modusensus%2Fdsh-mneme/0.8.16"
  );
  assert.equal(
    versionUrl(PACKAGE_NAME, "0.8.16", "https://registry.npmjs.org/"),
    "https://registry.npmjs.org/%40modusensus%2Fdsh-mneme/0.8.16"
  );
});

test("probeVersion：404 = 还没传播，200 且版本一致 = 可见（带 tarball）", async () => {
  const missing = await probeVersion("0.8.16", {
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) })
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "missing");

  const found = await probeVersion("0.8.16", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: "0.8.16", dist: { tarball: "https://registry.npmjs.org/x/-/x-0.8.16.tgz" } })
    })
  });
  assert.equal(found.ok, true);
  assert.equal(found.tarball, "https://registry.npmjs.org/x/-/x-0.8.16.tgz");
});

test("probeVersion：请求抛错 / 5xx / 响应不是 JSON / 版本对不上，都折成 ok:false 而不抛", async () => {
  const net = await probeVersion("0.8.16", { fetchImpl: async () => { throw new Error("fetch failed"); } });
  assert.equal(net.reason, "network");

  const http = await probeVersion("0.8.16", { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  assert.equal(http.reason, "http");

  const badJson = await probeVersion("0.8.16", {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("boom"); } })
  });
  assert.equal(badJson.reason, "bad-json");

  const mismatch = await probeVersion("0.8.16", {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version: "0.8.15" }) })
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "mismatch");
});

test("parseArgs：位置参数给版本号，可覆盖预算；缺版本号如实回报", () => {
  assert.deepEqual(parseArgs(["0.8.16"]), { ok: true, version: "0.8.16", timeoutMs: 600000, intervalMs: 15000 });
  assert.deepEqual(parseArgs(["0.8.16", "--timeout-ms", "1000", "--interval-ms", "500"]), {
    ok: true, version: "0.8.16", timeoutMs: 1000, intervalMs: 500
  });
  assert.equal(parseArgs([]).reason, "missing-version");
  assert.equal(parseArgs(["0.8.16", "0.8.17"]).reason, "missing-version");
  assert.equal(parseArgs(["0.8.16", "--timeout-ms", "abc"]).ok, false);
});

test("入口退出码：通过 → 0；超时 → 1 且 stderr 指明去翻 publish 步日志", async () => {
  const logs = [];
  const errors = [];
  const okCode = await main(["0.8.16"], {
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
    wait: async (version) => ({ ok: true, version, attempts: 1, waitedMs: 0, tarball: "" })
  });
  assert.equal(okCode, 0);
  assert.equal(errors.length, 0);

  const failCode = await main(["0.8.16"], {
    log: noop,
    error: (line) => errors.push(line),
    wait: async () => ({ ok: false, reason: "timeout", attempts: 40, waitedMs: 600000, lastError: "HTTP 404" })
  });
  assert.equal(failCode, 1, "闸门未通过必须以非零退出让 job 变红");
  assert.ok(errors.some((line) => line.includes("发布闸门未通过")));
  assert.ok(errors.some((line) => line.includes("publish 步")));
});

test("入口退出码：缺版本号 → 1 并打印用法", async () => {
  const errors = [];
  const code = await main([], { log: noop, error: (line) => errors.push(line), wait: async () => ({ ok: true }) });
  assert.equal(code, 1);
  assert.ok(errors.some((line) => line.includes("用法")));
});
