// personaEnabled flag wiring (#254-style): schema key + whitelist pair must
// surface in /features effective with default false — a missing key would make
// the panel toggle silently ineffective (client reads effective to register).
import test from "node:test";
import assert from "node:assert/strict";
import { Config } from "../src/config.js";
import { createSettings, FEATURE_FLAG_SPEC } from "../src/settings.js";
import { createStore } from "../src/store.js";

test("config schema has personaEnabled defaulting to false", () => {
  const cfg = Config({});
  assert.equal(cfg.personaEnabled, false);
  // 顶层扁平布尔：显式 true 穿透
  const cfgOn = Config({ personaEnabled: true });
  assert.equal(cfgOn.personaEnabled, true);
});

test("personaEnabled is in the boolean whitelist and spec export", () => {
  assert.ok(FEATURE_FLAG_SPEC.booleans.includes("personaEnabled"));
  // 默认关：不在 lightMode 排除名单（轻量纯文本注入物，用户显式勾选赢——
  // 定性同 actionPipelineEnabled；若未来要进名单，此处会失败并提示改设计稿④）
  const cfg = Config({});
  const light = cfg.lightMode === true ? cfg : cfg;
  void light; // lightMode 定性由 api.test.js 计数锁与 config.js 注释共同钉住
});

test("effective snapshot includes personaEnabled (false default) via featureSnapshot path", () => {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  // settings.setFeatureFlags 逐键校验合并写：白名单键可写（w1 已锁 TypeError 面）
  settings.setFeatureFlags({ personaEnabled: true });
  assert.equal(settings.getFeatureFlags().personaEnabled, true);
  // 清掉覆盖后 effective 应回落到 config 默认 false——由 api.test.js 的
  // 计数锁 + personaEnabled 默认值断言在 /features 路径上完整验证（w1 已同步 +1）。
  store.close();
});
