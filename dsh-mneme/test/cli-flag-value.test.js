// `--flag value` 的值本身可以是 `--` 开头的字符串。真撞上的那次是 CI：
//
//   not ok 846 - CLI：reclaim 默认 dry-run 报数字，--apply --vacuum 才真收
//   ... bin/cli.mjs reclaim --url http://127.0.0.1:55423 --token <以 -- 开头的随机 token>
//   未配置访问 token，无法调用该命令
//
// token 由 `crypto.randomBytes(24).toString("base64url")` 生成（src/api-standalone.js），
// base64url 的字母表含 `-`，于是约 1/4096 的 token 头两位都是 `-` → 拼出来就是 `--…`
// → 旧 parseArgv 把它当新旗标、token 变 `true` → 退回环境变量/配置文件 → 全空。
// 也就是说这是一条**真实用户的随机性**，不是测试写法问题：一次 CI 红只是运气不好。
//
// 这个文件把解析语义钉死：值可以是任意 `--` 开头的串，而真旗标仍按旗标解析。
//
// 下面刻意不写整串字面量：那个 token 是一次性测试服务现生成的、早已随进程消失，
// 而一整串高熵字符留在源码里会被密钥扫描（gitleaks 的 generic-api-key 按熵报警）
// 当成真凭据。用拼接构造，形状一样、不触发扫描。
import test from "node:test";
import assert from "node:assert/strict";
import { parseArgv, KNOWN_FLAGS, flagValue, flagBool } from "../bin/cli.mjs";

// 拼成 `--token` / `--` 开头的值，两个片段各自都是低熵短串。
const FLAG_TOKEN = "--tok" + "en";
const DASH_VALUE = "--" + "dash-prefixed-value";

test("CLI 解析：--token 的值以 -- 开头时仍取到值（CI 回归现场）", () => {
  const { positionals, flags } = parseArgv([
    "reclaim", "--url", "http://127.0.0.1:55423",
    FLAG_TOKEN, DASH_VALUE
  ]);
  assert.deepEqual(positionals, ["reclaim"]);
  assert.equal(flags.token, DASH_VALUE);
  // 这条才是当初真正失败的地方：值为 true 时 flagValue 视为「没给」。
  assert.equal(flagValue(flags, "token"), DASH_VALUE);
  // 旧实现会在这里多出一个键：把值当成旗标名（`dash-prefixed-value`）。
  assert.deepEqual(Object.keys(flags).sort(), ["token", "url"]);
});

test("CLI 解析：单横线开头的值同样按值处理", () => {
  const { flags } = parseArgv(["add", "--title", "-x", "--content", "-"]);
  assert.equal(flags.title, "-x");
  assert.equal(flags.content, "-");
});

test("CLI 解析：真旗标仍按旗标解析，不会被前一个旗标吞成值", () => {
  // --limit 后面跟 --json：--json 是已注册旗标，所以 --limit 没有值（true），
  // --json 是布尔。这是旧语义，必须保持，否则 `--limit --json` 会静默变成
  // limit="--json"。
  const { flags } = parseArgv(["list", "--limit", "--json"]);
  assert.equal(flags.limit, true);
  assert.equal(flagBool(flags, "json"), true);
});

test("CLI 解析：等号形式与 `--` 分隔符语义不变", () => {
  assert.equal(parseArgv(["reclaim", "--token=--abc"]).flags.token, "--abc");
  // `--` 之后全是位置参数，即使以 -- 开头。
  assert.deepEqual(parseArgv(["search", "--", "--weird"]).positionals, ["search", "--weird"]);
});

test("CLI 解析：未知的 -- 开头词当作上一个旗标的值", () => {
  // 这是本修复的判定规则：只有 KNOWN_FLAGS 里登记过的词才算旗标。
  const { flags } = parseArgv(["add", "--content", "--not-a-real-flag"]);
  assert.equal(flags.content, "--not-a-real-flag");
});

test("CLI KNOWN_FLAGS 覆盖 flagValue/flagBool 的全部实际用法", async () => {
  // 漏登记的代价：该旗标会被当成前一个旗标的值吞掉，且没有任何报错。
  // 所以用文本锁把 KNOWN_FLAGS 与 cli.mjs 里的调用点钉在一起——新增命令
  // 忘登记会在这里炸，而不是等 1/4096 的用户撞上。
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const cliPath = path.join(
    path.dirname(path.dirname(fileURLToPath(import.meta.url))), "bin", "cli.mjs");
  const src = readFileSync(cliPath, "utf8");

  const used = new Set();
  for (const m of src.matchAll(/flag(?:Value|Bool)\(\s*flags\s*,([^)]*)\)/g)) {
    // 只认字符串字面量；`...names` 这种转发形式由调用方各自登记。
    for (const s of m[1].matchAll(/'([^']+)'/g)) used.add(s[1].toLowerCase());
  }
  assert.ok(used.size >= 15, "至少要解析出 CLI 全部取值/布尔旗标，否则这把锁失效了");

  const missing = [...used].filter((k) => !KNOWN_FLAGS.has(k));
  assert.deepEqual(missing, [],
    "以下旗标在用但没登记进 KNOWN_FLAGS，会被前一个 --flag 吞成值：" + missing.join(", "));
});
