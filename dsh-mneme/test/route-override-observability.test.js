// Issue #792 可观测性回归：面板覆盖配置文件里的路由键时不许静默。
//
// 合并顺序是 kv 压过 bundle（src/index.js 启动装配），这条优先级是刻意的：面板
// 是运行时覆盖层。问题从来不是优先级，而是**一个字都不说**——改 yml 的人只会
// 觉得「我明明改了」。同时还有第二个方向：面板把输入框清空后 kv 里存的是 `""`，
// 字符串白名单把空串当合法值保留，于是空串把配置文件写好的路由整个吃掉。
//
// 本文件锁三件事：
//   ① routeKeyOverrides 只报「配置文件写了 && 面板也有 && 值不同」，且能区分
//      「显式改成别的值」与「面板清空」（cleared）两种形状；
//   ② 空串在合并阶段被当未配置：只有 provider/model 这类键吃这条规则；
//   ③ 接线锁（仿 peak-hours-observability）：对账在过滤**之前**算，告警在cfg 装配
//      之后、且只 log 不改 cfg。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { FEATURE_FLAG_ROUTE_STRINGS, routeKeyOverrides } from "../src/settings.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(path.join(here, "..", "src", "index.js"), "utf8");

test("#792 方向 A：配置文件与面板值不同 → 报一条覆盖", () => {
  const out = routeKeyOverrides({ dreamProvider: "deepseek", dreamModel: "deepseek-chat" }, {
    dreamProvider: "xdpool",
    dreamModel: "deepseek-chat"
  });
  // 只报真的不一样的键：dreamModel 两边一致，不该出现在清单里
  assert.deepEqual(out, [{ key: "dreamProvider", fileValue: "deepseek", panelValue: "xdpool", cleared: false }]);
});

test("#792 方向 B：面板清空（空串）→ 报 cleared，且合并阶段不覆盖配置文件", () => {
  const out = routeKeyOverrides({ dreamProvider: "deepseek" }, { dreamProvider: "" });
  assert.deepEqual(out, [{ key: "dreamProvider", fileValue: "deepseek", panelValue: "", cleared: true }]);
  // 空串在合并时被跳过：模拟 index.js 的 flatFlags 过滤
  const flags = { dreamProvider: "" };
  const flatFlags = {};
  for (const [key, value] of Object.entries(flags)) {
    if (value === "" && FEATURE_FLAG_ROUTE_STRINGS.includes(key)) continue;
    flatFlags[key] = value;
  }
  assert.deepEqual(flatFlags, {}, "空串路由键不进 flatFlags，配置文件的值才留得住");
  const cfg = { ...{ dreamProvider: "deepseek" }, ...flatFlags };
  assert.equal(cfg.dreamProvider, "deepseek", "生效的是配置文件里的值");
});

test("#792 两边都没配 → 清单为空（不骚扰没配路由的用户）", () => {
  assert.deepEqual(routeKeyOverrides({}, {}), []);
  assert.deepEqual(routeKeyOverrides({ dreamProvider: "" }, {}), []);
  assert.deepEqual(routeKeyOverrides({ dreamProvider: "deepseek" }, {}), [], "配置文件有值、面板没碰 → 不算覆盖");
  // 非法入参不抛
  assert.deepEqual(routeKeyOverrides(undefined, undefined), []);
  assert.deepEqual(routeKeyOverrides(null, null), []);
});

test("#792 空白差异不算覆盖（两边都是同一份路由，只是有人多敲了空格）", () => {
  assert.deepEqual(routeKeyOverrides({ dreamProvider: " deepseek " }, { dreamProvider: "deepseek" }), []);
});

test("#792 路由键按后缀识别：provider/model 进表，错峰串这类「空串=关掉」的键不进表", () => {
  assert.ok(FEATURE_FLAG_ROUTE_STRINGS.includes("dreamProvider"));
  assert.ok(FEATURE_FLAG_ROUTE_STRINGS.includes("dreamModel"));
  assert.ok(FEATURE_FLAG_ROUTE_STRINGS.includes("sleepProvider"));
  // 反例：清空即「关掉错峰」，绝不能当未配置——否则用户永远关不掉错峰
  assert.ok(!FEATURE_FLAG_ROUTE_STRINGS.includes("summarizePeakHours"));
  assert.ok(!FEATURE_FLAG_ROUTE_STRINGS.includes("dreamPeakHours"));
});

test("接线锁：对账在过滤之前算，告警排在 cfg 装配之后且不改 cfg", () => {
  const cfgAt = indexSrc.indexOf("const cfg = { ...applyLightModePreset({ ...rawCfg, lightMode }), ...flatFlags };");
  const reconcileAt = indexSrc.indexOf("const routeOverrides = routeKeyOverrides(rawCfg, flags);");
  const warnAt = indexSrc.indexOf("for (const { key, fileValue, panelValue, cleared } of routeOverrides) {");
  const gateAt = indexSrc.indexOf("const sessionGate = createSessionGate(cfg);");
  assert.ok(cfgAt > 0, "装配行必须在");
  assert.ok(reconcileAt > 0, "对账点必须在");
  assert.ok(warnAt > 0, "告警点必须在");
  // 必须在过滤之前：被清空的那条本身也要有话说，过滤后再算就看不见了
  assert.ok(reconcileAt < cfgAt, "对账要读未过滤的 flags，且早于合并");
  assert.ok(warnAt > cfgAt, "告警排在 cfg 装配之后");
  assert.ok(gateAt > warnAt, "告警在 sessionGate 之前");
  const block = indexSrc.slice(warnAt, gateAt);
  assert.ok(!/cfg\s*=[^=]/.test(block), "告警分支不得改写 cfg（优先级本身不动）");
  assert.ok(block.includes("logger?.warn?.("), "覆盖可见性走 logger.warn");
  // 空串过滤必须真的接在 flatFlags 构造里（否则本文件第 2 条的语义只是纸面推演）
  const skipAt = indexSrc.indexOf('if (value === "" && FEATURE_FLAG_ROUTE_STRINGS.includes(key)) continue;');
  assert.ok(skipAt > 0, "空串路由键的过滤语句必须在");
  assert.ok(skipAt < cfgAt, "过滤发生在合并之前，cfg 里才不会出现空串");
});
