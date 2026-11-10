// Issue #622 可观测性回归：错峰时段串解析失败不许静默。
//
// parsePeakSpec 的失败语义（整串视为未配置）是刻意的契约——排程是省钱手段，绝不
// 该因为写错格式把蒸馏/巩固停掉。但「不救错」不等于「不吭声」：#424 的排查只能靠
// 「高峰期还在巩固」倒推，正是静默的全貌。本文件锁三件事：
//   ① invalidPeakSpecs 只报「非空且解析失败」——空串/未配置/合法串/全角归一救得了
//     的写法一律不报（验收第 2 条：不骚扰没配错峰的用户；#621 已落归一，两处共存）；
//   ② index.js 的启动告警真的接在 cfg 装配之后（接线锁，仿 failure-retention 的
//     写法）：告警读的是装配后的 cfg——面板改的 flatFlags 合并进来的值也算数；
//   ③ /features 答复的 invalidPeakHours 与 helper 同源（api.test.js 里另有往返）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parsePeakSpec, invalidPeakSpecs, PEAK_SPEC_KEYS } from "../src/peak-hours.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(path.join(here, "..", "src", "index.js"), "utf8");

test("invalidPeakSpecs: 只报非空且解析失败的键；空串/未配置/合法串不报", () => {
  // 未配置（undefined）与空串：合法的「未配置」，不告警
  assert.deepEqual(invalidPeakSpecs({}), {});
  assert.deepEqual(invalidPeakSpecs({ summarizePeakHours: "" }), {});
  assert.deepEqual(invalidPeakSpecs({ summarizePeakHours: "   " }), {});
  assert.deepEqual(invalidPeakSpecs({ dreamPeakHours: undefined }), {});
  // 合法串：不报
  assert.deepEqual(invalidPeakSpecs({ summarizePeakHours: "09:00-18:00" }), {});
  assert.deepEqual(invalidPeakSpecs({ dreamPeakHours: "mon-fri 08:00-12:00,14:00-18:00" }), {});
  // 全角等价写法：本批原基于未含 #621 归一的主线，当时 parsePeakSpec 解析失败、
  // 「报」是真话。**#621 已并入 main**（全角逗号/冒号/数字归一），解析现在成功，
  // 本断言随之翻转为不报——这正是 helper「只转述解析器、不自带第二套对错标准」
  // 的意义：判据翻转由解析器驱动，本文件不需要改任何逻辑。
  // ⚠️ 原注释里「两批共存无需联动改动」这句是错的：判据确实会翻，只是翻的位置
  // 在这里而不在 src/。合并 #621 后必须同步翻这一行，否则就是假红。
  assert.deepEqual(invalidPeakSpecs({ summarizePeakHours: "０９:００-１８:００" }), {});
  // 非法串：报，且带原串（告警要对得上配置文件里那一行）
  assert.deepEqual(invalidPeakSpecs({ summarizePeakHours: "24:00-08:00" }), { summarizePeakHours: "24:00-08:00" });
  assert.deepEqual(invalidPeakSpecs({ dreamPeakHours: "09.00-18.00" }), { dreamPeakHours: "09.00-18.00" });
  // 两个键互相独立，各查各的（"ok" 没有冒号、没有时段段——解析器视为非法，报得对）
  const both = invalidPeakSpecs({ summarizePeakHours: "09:00-18:00", dreamPeakHours: "24:00-01:00" });
  assert.deepEqual(both, { dreamPeakHours: "24:00-01:00" });
  // 非对象（裸调用方传 undefined 之类）不抛、返回空
  assert.deepEqual(invalidPeakSpecs(undefined), {});
  assert.deepEqual(invalidPeakSpecs(null), {});
  // 非字符串值（垃圾输入）不抛、不报——typeof 守卫
  assert.deepEqual(invalidPeakSpecs({ summarizePeakHours: 42 }), {});
});

test("PEAK_SPEC_KEYS 恰好覆盖两个时段键，parsePeakSpec 对它们的失败语义不变", () => {
  // 键名单独成表：告警点与提示点都要认同一份，谁加键谁改表（不各写数组各自漂移）
  assert.deepEqual(PEAK_SPEC_KEYS, ["summarizePeakHours", "dreamPeakHours"]);
  // 本 issue 不动解析语义：非法 → null、空 → null、合法 → 结构（#239 契约原样）
  assert.equal(parsePeakSpec("24:00-08:00"), null);
  assert.equal(parsePeakSpec(""), null);
  assert.ok(parsePeakSpec("09:00-18:00"));
});

test("接线锁：index.js 的启动告警读装配后的 cfg，且在 sessionGate 之前", () => {
  const cfgAt = indexSrc.indexOf("const cfg = { ...applyLightModePreset({ ...rawCfg, lightMode }), ...flatFlags };");
  const callAt = indexSrc.indexOf("invalidPeakSpecs(cfg)");
  const gateAt = indexSrc.indexOf("const sessionGate = createSessionGate(cfg);");
  assert.ok(cfgAt > 0, "装配行必须在");
  assert.ok(callAt > cfgAt, "告警必须排在 cfg 装配之后——读 rawCfg 会漏掉面板改的 flatFlags");
  assert.ok(gateAt > callAt, "告警在 sessionGate 之前（纯 log，不参与装配顺序的实质，锁在这里只为防它被挪进更早、读不到合并值的分支）");
  // 只 log：告警分支里不许出现改写 cfg 的语句（行为零变化是本 issue 的前提）
  const block = indexSrc.slice(callAt, gateAt);
  assert.ok(!/cfg\s*=[^=]/.test(block), "告警分支不得改写 cfg");
  assert.ok(block.includes("logger?.warn?.("), "失败可见性走 logger.warn");
});
