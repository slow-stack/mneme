// #780 委派型子代理不继承人格（personaExcludeSubagents）。
// 形状照 test/persona-addressing.test.js：同一套 setup/seed，只是 ctx 里多带
// session.header.origin / isSeeded 两个字段，让排除分支看得见它们。
//
// 锁住四件事：①默认关时行为逐字节不变 ②开着时委派型子代理整段人格行不出现
// ③fork 分支（isSeeded: true）不受影响——只按 origin 关会误伤用户自己的并行对话
// ④isSeeded 取不到时按「不是委派型」处理，宁可维持历史行为也不误关。
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createInjector } from "../src/inject.js";
import { createSettings } from "../src/settings.js";
import { resolvePersonaCard } from "../src/user-settings.js";
import { testConfig } from "./helpers/test-config.js";

function setup(over = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
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

const delegated = () => ({
  agent: { session: { id: "child-1", header: { agentPreset: "standard", origin: "subagent", isSeeded: false } } }
});
const forked = () => ({
  agent: { session: { id: "fork-1", header: { agentPreset: "standard", origin: "subagent", isSeeded: true } } }
});
const plain = () => ({ agent: { session: { id: "main-1", header: { agentPreset: "standard" } } } });

function seed(settings) {
  settings.setPersona({ name: "Amarre", personality: "轻松幽默", replyStyle: "不要急于总结", enabled: true });
}

test("#780 缺省（开关关）：委派型子代理照样继承 default 卡——不改默认行为", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: true });
  seed(settings);
  const text = settingsCtx.text(delegated());
  assert.ok(text.includes("你的人格名字：Amarre"), "personaExcludeSubagents 缺省时行为逐字节不变");
  store.close();
});

test("#780 开关开：委派型子代理整段人格行都不注入（连 default 也不兜）", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: true, personaExcludeSubagents: true });
  seed(settings);
  const text = settingsCtx.text(delegated());
  assert.ok(!text.includes("Amarre"), "委派型子代理不该收到对话人设");
  assert.ok(!text.includes("你的人格名字"), "无人格时整段人格行都不出现，不是留个空标签");
  store.close();
});

test("#780 开关开：fork 出来的分支照旧继承人格——不能把用户自己的并行对话一起关掉", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: true, personaExcludeSubagents: true });
  seed(settings);
  const text = settingsCtx.text(forked());
  assert.ok(text.includes("你的人格名字：Amarre"), "fork 分支带 isSeeded: true，不是委派型子代理");
  store.close();
});

test("#780 开关开：主会话不受影响", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: true, personaExcludeSubagents: true });
  seed(settings);
  const text = settingsCtx.text(plain());
  assert.ok(text.includes("你的人格名字：Amarre"), "没有 origin 的普通会话照旧走寻址");
  store.close();
});

test("#780 开关开：委派型子代理连自己那张 bySession 卡都不拿", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: true, personaExcludeSubagents: true });
  seed(settings);
  settings.setPersonaForSession("child-1", { name: "子代理专用", enabled: true });
  const text = settingsCtx.text(delegated());
  assert.ok(!text.includes("子代理专用"), "排除须排在所有维度之前，否则只挡住 default 那一路");
  assert.ok(!text.includes("Amarre"));
  store.close();
});

test("#780 开关开：画像与规则恒注入，本开关只管人格行", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: true, personaExcludeSubagents: true });
  seed(settings);
  settings.setProfile("用户是规划背景");
  settings.setRules(["不提及用户名"]);
  const text = settingsCtx.text(delegated());
  assert.ok(!text.includes("你的人格名字"));
  assert.ok(text.includes("- 用户画像：用户是规划背景"));
  assert.ok(text.includes("- 规则：不提及用户名"));
  store.close();
});

test("#780 resolvePersonaCard：isSeeded 取不到（null）时不触发排除", () => {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  settings.setPersona({ name: "Amarre", enabled: true });
  const unknown = resolvePersonaCard(settings, null, {
    excludeSubagents: true,
    origin: "subagent",
    isSeeded: null
  });
  assert.equal(unknown.source, "default", "isSeeded 未知时按非委派处理，宁可维持历史行为");
  const excluded = resolvePersonaCard(settings, null, {
    excludeSubagents: true,
    origin: "subagent",
    isSeeded: false
  });
  assert.equal(excluded.source, "none");
  assert.deepEqual(excluded.card, {});
  store.close();
});
