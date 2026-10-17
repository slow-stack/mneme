// Persona injection via renderUserSettings (user-settings context, order 85).
// Locks: with either gate off, output is byte-identical to the legacy rendering
// (old users see zero change); with both gates on, persona lines lead the block
// (design ⑥: persona → profile → rules, rules stay hardest) and go through
// escapePromptVars.
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
  const config = { maxInjectedItems: 3, importanceThreshold: 3, ...over };
  createInjector(ctx, service, settings, config);
  const settingsCtx = contexts.find((c) => c.name === "user-settings");
  return { store, settings, settingsCtx };
}

test("legacy output unchanged when config gate off (persona stored but ignored)", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: false });
  settings.setProfile("用户是规划背景");
  settings.setRules(["不提及用户名"]);
  settings.setPersona({ name: "Amarre", personality: "轻松幽默", enabled: true });
  const text = settingsCtx.text({});
  // 逐字节等于历史渲染：无人格行、无人格名
  assert.equal(text, escapeless([
    "[用户设置] 来自 dsh-mneme 的用户画像与规则：",
    "- 用户画像：用户是规划背景",
    "- 规则：不提及用户名"
  ].join("\n")));
  store.close();
});

test("legacy output unchanged when persona.enabled off (config gate on)", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: true });
  settings.setProfile("用户是规划背景");
  settings.setPersona({ name: "Amarre", personality: "轻松幽默", enabled: false });
  const text = settingsCtx.text({});
  assert.ok(text.includes("用户画像"));
  assert.ok(!text.includes("人格"));
  store.close();
});

test("empty block stays empty when only persona exists but a gate is off", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: false });
  settings.setPersona({ name: "Amarre", enabled: true });
  assert.equal(settingsCtx.text({}), "");
  store.close();
});

test("both gates on: persona lines lead, then profile, then rules", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: true });
  settings.setProfile("用户是规划背景");
  settings.setRules(["不提及用户名"]);
  settings.setPersona({ name: "Amarre", personality: "轻松幽默", replyStyle: "先给结论再解释", enabled: true });
  const text = settingsCtx.text({});
  const idxPersona = text.indexOf("你的人格名字：Amarre");
  const idxProfile = text.indexOf("用户画像：用户是规划背景");
  const idxRule = text.indexOf("规则：不提及用户名");
  assert.ok(idxPersona > -1, "persona line present");
  assert.ok(idxProfile > idxPersona, "profile after persona (design ⑥)");
  assert.ok(idxRule > idxProfile, "rules after profile (rules hardest)");
  assert.ok(text.includes("人格性格设定：轻松幽默"));
  assert.ok(text.includes("回复要求：先给结论再解释"));
  store.close();
});

test("persona with blank text fields renders no persona lines (no empty bullets)", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: true });
  settings.setPersona({ name: "  ", personality: "", enabled: true });
  assert.equal(settingsCtx.text({}), "");
  settings.setProfile("有画像");
  const text = settingsCtx.text({});
  assert.ok(!text.includes("人格"));
  store.close();
});

test("persona text goes through escapePromptVars (no raw braces)", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: true });
  settings.setPersona({ name: "{{evil}}", enabled: true });
  const text = settingsCtx.text({});
  assert.ok(!text.includes("{{"), "no raw {{ in user-settings block");
  assert.ok(!text.includes("}}"), "no raw }} in user-settings block");
  store.close();
});

// ---- v1.2 多卡寻址：按会话身份取卡，取不到落 default ------------------------

test("session identity hit: byAgent card wins over default", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: true });
  settings.setPersona({ name: "Amarre", enabled: true }); // default
  settings.setPersonaFor("zephyr", { name: "泽菲尔", personality: "冷危占有", enabled: true });
  const ctxWithId = { agent: { session: { header: { agentPreset: "zephyr" } } } };
  const text = settingsCtx.text(ctxWithId);
  assert.ok(text.includes("你的人格名字：泽菲尔"), "byAgent card injected");
  assert.ok(!text.includes("Amarre"), "default card not injected when identity hit");
  store.close();
});

test("session identity miss: falls back to default card", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: true });
  settings.setPersona({ name: "Amarre", enabled: true });
  settings.setPersonaFor("zephyr", { name: "泽菲尔", enabled: true });
  const ctxUnknown = { agent: { session: { header: { agentPreset: "unknown-bot" } } } };
  const text = settingsCtx.text(ctxUnknown);
  assert.ok(text.includes("Amarre"), "default on identity miss");
  assert.ok(!text.includes("泽菲尔"), "other card not leaked");
  store.close();
});

test("identity card disabled (enabled=false) falls back to default, not partial card", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: true });
  settings.setPersona({ name: "Amarre", enabled: true });
  settings.setPersonaFor("zephyr", { name: "泽菲尔", personality: "冷", enabled: false });
  const ctxWithId = { agent: { session: { header: { agentPreset: "zephyr" } } } };
  const text = settingsCtx.text(ctxWithId);
  assert.ok(text.includes("Amarre"), "disabled id card → default");
  assert.ok(!text.includes("泽菲尔"), "disabled card never partially injected");
  store.close();
});

test("session without header (mock/old host) behaves exactly like v1 (default)", () => {
  const { store, settings, settingsCtx } = setup({ personaEnabled: true });
  settings.setPersona({ name: "Amarre", personality: "轻松幽默", enabled: true });
  const text = settingsCtx.text({}); // 无 session.header → default，与 v1 一致
  assert.ok(text.includes("你的人格名字：Amarre"));
  assert.ok(text.includes("人格性格设定：轻松幽默"));
  store.close();
});

// 期望值工具：直接写明文（本组用例不含需转义字符，escapePromptVars 为恒等）。
function escapeless(s) { return s; }
