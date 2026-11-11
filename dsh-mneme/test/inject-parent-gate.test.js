import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createInjector } from "../src/inject.js";
import { createSettings, FEATURE_FLAG_SPEC } from "../src/settings.js";
import { createTools } from "../src/tools.js";
import { Config, INJECT_CHILD_FLAGS, applyLightModePreset, injectChildEnabled } from "../src/config.js";

// 回归（issue #249 第二批）：注入形态的父／子开关。
// 父 = autoInject（既有挂载总闸，默认开）；子项按 #249 §10 的判据分档——是否
// 引入新的注入时机／新表面／额外成本。只修正既有位的能力说明随父生效，本批
// 默认值由关翻到开（显式产品决定，见 CHANGELOG）；父关 = 子项一律不生效，
// 但子项的持久值保留（父关是「不生效」，不是「重置用户配置」）。
//
// 能力说明有两个落点：系统提示段住在注入器内（父关时注入器根本不挂载，天然
// 不生效），工具描述住在注入器之外，是父闸唯一会漏的地方——本文件用真实工具
// 描述钉住它。

const CHILDREN = Object.values(INJECT_CHILD_FLAGS).flat();
const GUIDE_TOOLS = ["memory_search", "memory_save"];

function injectorSections(config) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const sections = [];
  const ctx = {
    systemPrompt: {
      context() { return () => {}; },
      section(def) { sections.push(def); return () => {}; }
    }
  };
  createInjector(ctx, service, createSettings(store.db), config);
  return sections;
}

function toolDescriptions(config) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const registered = [];
  const ctx = { tools: { register(def) { registered.push(def); return () => {}; } } };
  createTools(ctx, service, config, null);
  return new Map(registered.map((t) => [t.name, t.description]));
}

test("#249 第二批：解析后的默认配置里能力说明是开的", () => {
  assert.equal(Config({}).injectGuidanceEnabled, true, "基础档默认开（随父生效）");
  // 轻量档不因这次翻转多付常驻提示成本：预设把它压回 false。
  assert.equal(applyLightModePreset({ lightMode: true }).injectGuidanceEnabled, false);
});

test("#249 第二批：父关时子项在两个落点上都不生效", () => {
  assert.equal(injectorSections({ autoInject: true, injectGuidanceEnabled: true }).length, 1, "父开 → 注册提示段");
  assert.equal(injectorSections({ autoInject: false, injectGuidanceEnabled: true }).length, 0, "父关 → 不注册提示段");

  const plain = toolDescriptions({ injectGuidanceEnabled: false });
  const guided = toolDescriptions({ autoInject: true, injectGuidanceEnabled: true });
  const gated = toolDescriptions({ autoInject: false, injectGuidanceEnabled: true });
  for (const name of GUIDE_TOOLS) {
    assert.notEqual(guided.get(name), plain.get(name), `${name}：子项开 → 描述补了判断指引`);
    assert.equal(gated.get(name), plain.get(name), `${name}：父关 → 描述逐字节回到未开状态`);
  }
});

test("#249 第二批：闸门只认显式关掉的父，子项自己缺省即关", () => {
  const key = "injectGuidanceEnabled";
  assert.equal(injectChildEnabled({ [key]: true }, key), true, "父未出现 → 只按子项判");
  assert.equal(injectChildEnabled({}, key), false, "子项未开");
  assert.equal(injectChildEnabled({ autoInject: false, [key]: true }, key), false, "父显式关 → 子不生效");
  assert.equal(injectChildEnabled({ autoInject: false, [key]: false }, key), false);
});

test("#249 第二批：父关只停用，不改写子项的持久值", () => {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  settings.setFeatureFlags({ autoInject: false, injectGuidanceEnabled: true });
  const stored = settings.getFeatureFlags();
  assert.equal(stored.autoInject, false);
  assert.equal(stored.injectGuidanceEnabled, true, "父关不是重置用户配置");
  assert.equal(injectChildEnabled(stored, "injectGuidanceEnabled"), false, "值留着，当下不生效");
  settings.setFeatureFlags({ autoInject: true });
  assert.equal(injectChildEnabled(settings.getFeatureFlags(), "injectGuidanceEnabled"), true, "重开父开关恢复上次选择");
});

test("#249 第二批：面板的父子关系与后端同源（漏一处就静默消失）", () => {
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  // 渲染点：子项靠 flagRow 展开。只断言「声明与文案出现过」是恒真检查——把
  // 2236 行改回 g.items.map(boolRow)，子项既不在 group.core 的 items 里、也不经
  // flagRow 渲染，面板上彻底消失，而字符串断言全绿。这一条才是那道门。
  // #427 revamp：渲染形态从 map(flagRow) 升级为 map + subAfter（子块紧贴总闸），
  // 门锁的是「每个 items 键都经 flagRow 渲染」这件事本身。
  assert.ok(/g\.items\.map\(\(k\) => h\(react\.Fragment, \{ key: k \}, flagRow\(k\), subAfter\[k\]\)\)/.test(client),
    "分组渲染必须走 flagRow（经 subAfter 内联），否则子项不渲染");
  const children = client.match(/const FEATURE_CHILDREN = (\{[^}]*\})/)?.[1] ?? "";
  assert.ok(children.includes("autoInject"), "面板未声明父开关 autoInject");
  const allItems = [...client.matchAll(/items: \[([^\]]*)\]/g)].map((m) => m[1]).join("\n");
  for (const child of CHILDREN) {
    assert.ok(children.includes(`"${child}"`), `面板 FEATURE_CHILDREN 漏了 ${child}`);
    assert.ok(!allItems.includes(`"${child}"`), `${child} 同时在 items 与 FEATURE_CHILDREN 里，会被渲染两次`);
    // 双语文案：与 test/client.test.js 的路由键同款计数（zh + en 各一份 = 2）。
    const named = client.split(`"memory.features.${child}"`).length - 1;
    const hinted = client.split(`"memory.features.${child}.hint"`).length - 1;
    assert.ok(named >= 2, `${child} 的文案要中英各一份（got ${named}）`);
    assert.ok(hinted >= 2, `${child} 的提示要中英各一份（got ${hinted}）`);
    // 白名单：面板给的开关必须真能写进 kv，否则点了只会拿到 400。
    assert.ok(FEATURE_FLAG_SPEC.booleans.includes(child), `${child} 不在 settings 白名单里`);
  }

  // 子项只能由 flagRow 经 FEATURE_CHILDREN 渲染一次。上面那张表（后端闸门）只
  // 覆盖 autoInject，地志的两枚子项是纯面板关系，不在里面——所以这一条改用前端
  // 表自己解析，覆盖面板声明的全部子项。
  // 回归：5c41d31 在 choroSub 里先手写了两行 boolRow，5bad8a6 往 FEATURE_CHILDREN
  // 补父关系时没删旧的，同一个键渲染两遍（v0.14.0-beta.1 带着它上线：切上面那个，
  // 下面那行不同步）。旧的断言查不出来——它只比「items 与 FEATURE_CHILDREN 有没有
  // 重叠」，手写行不进任何表。
  // 先剥注释再数：注释里写字面量不该算渲染点（客户端源码里也有同款约定）。
  const stripped = client
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  const childrenBlock = stripped.match(/const FEATURE_CHILDREN = \{([\s\S]*?)\n    \};/)?.[1] ?? "";
  const declaredChildren = [...childrenBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(declaredChildren.length >= 5, `前端 FEATURE_CHILDREN 解析失败（got ${declaredChildren.length}）`);
  for (const child of declaredChildren) {
    const escaped = child.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const handwritten = (stripped.match(new RegExp(`boolRow\\(\\s*"${escaped}"`, "g")) || []).length;
    assert.equal(handwritten, 0, `${child} 被手写渲染了 ${handwritten} 次：子项只能由 flagRow 渲染，否则面板上会出现两行`);
  }
  // 防「删掉渲染让上面那条变绿」：子项真得有展开点。
  assert.ok(/kids\.map\(\(c\) => boolRow\(c, \{ sub: true, gate: k \}\)\)/.test(stripped),
    "flagRow 必须展开子项并带 gate，否则 FEATURE_CHILDREN 只是声明、面板上没有子行");
});
