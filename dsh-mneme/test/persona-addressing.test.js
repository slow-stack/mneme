// 修复一：人格寻址的兜底口径。default 卡的存在理由是「这一帧解析不到会话身份」，
// 而不是「所有没建卡的 agent 都该拿到它」——后者会把某个人格无条件塞进外部 bot 的
// 会话（DS Bot 那类：它自己带身份与设定，两处身份声明撞在同一帧里）。
// 现状（personaStrictAddressing 缺省 = false）已由 test/persona-inject.test.js:113
// 与 :124 钉住，本文件第一条照样锁它——这是 opt-in，不是把别人的行为改了。
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createInjector } from "../src/inject.js";
import { createSettings } from "../src/settings.js";

function setup(over = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const contexts = [];
  const ctx = {
    systemPrompt: {
      context(def) {
        contexts.push(def);
        return () => {};
      }
    }
  };
  createInjector(ctx, service, settings, { maxInjectedItems: 3, importanceThreshold: 3, ...over });
  return { store, settings, settingsCtx: contexts.find((c) => c.name === "user-settings") };
}

const withPreset = (agentPreset) => ({ agent: { session: { id: "s1", header: { agentPreset } } } });

// 种子：default 卡（Amarre）开着 + 一张 zephyr 卡。
function seed(settings, zephyrEnabled = true) {
  settings.setPersona({ name: "Amarre", personality: "轻松幽默", enabled: true });
  settings.setPersonaFor("zephyr", { name: "泽菲尔", personality: "冷危", enabled: zephyrEnabled });
}

test("缺省（开关关）：没建卡的身份仍落 default——本 PR 不改默认行为", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: true });
  seed(settings);
  const text = settingsCtx.text(withPreset("unknown-bot"));
  assert.ok(text.includes("Amarre"), "personaStrictAddressing 缺省时行为逐字节不变");
  store.close();
});

test("strict on：没建卡的身份不注入任何人格行", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: true, personaStrictAddressing: true });
  seed(settings);
  settings.setProfile("用户是规划背景");
  const text = settingsCtx.text(withPreset("unknown-bot"));
  assert.ok(!text.includes("Amarre"), "外部身份不该收到别人的人格");
  assert.ok(!text.includes("你的人格名字"), "无人格时整段人格行都不出现，不是留个空标签");
  store.close();
});

test("strict on：显式关掉的卡不再回落 default——这让「关掉这张卡」第一次有意义", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: true, personaStrictAddressing: true });
  seed(settings, false);
  const text = settingsCtx.text(withPreset("zephyr"));
  assert.ok(!text.includes("泽菲尔"), "关掉的卡本身不注入");
  assert.ok(!text.includes("Amarre"), "关掉之后落回 default 等于没关");
  store.close();
});

test("strict on：解析不到身份（无 session.header）照旧用 default 卡", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: true, personaStrictAddressing: true });
  seed(settings);
  const text = settingsCtx.text({});
  assert.ok(text.includes("你的人格名字：Amarre"), "无名会话正是 default 卡的受众，strict 不许把它一起关掉");
  store.close();
});

test("strict on：命中的卡照常注入，画像与规则不受影响", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: true, personaStrictAddressing: true });
  seed(settings);
  settings.setProfile("用户是规划背景");
  settings.setRules(["不提及用户名"]);
  const hit = settingsCtx.text(withPreset("zephyr"));
  assert.ok(hit.includes("你的人格名字：泽菲尔"), "身份命中时行为与现状一致");
  assert.ok(hit.includes("- 用户画像：用户是规划背景"), "画像恒注入：本开关只管人格行");
  assert.ok(hit.includes("- 规则：不提及用户名"), "规则恒注入：同上");
  store.close();
});
