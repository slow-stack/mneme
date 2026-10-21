// Persona settings (user_settings "persona" key) — v1.2 多卡模型。
// Locks: legacy v1 single-object reads as default; byAgent cards round-trip;
// corruption returns empty store without throwing; unknown fields dropped.
// Whitelist lock guards the #254-style pit: a flag missing from
// FEATURE_FLAG_BOOLEANS would make the panel toggle silently ineffective.
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createSettings } from "../src/settings.js";
import { resolvePersonaCard } from "../src/user-settings.js";

function setup() {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  return { store, settings };
}

test("persona defaults to empty store; default card round-trips via single-object form", () => {
  const { store, settings } = setup();
  assert.deepEqual(settings.getPersona(), { default: {}, byAgent: {} });
  const input = {
    name: "Amarre",
    personality: "轻松幽默，讲解用类比",
    replyStyle: "先给结论再解释",
    enabled: false,
    provenance: { sourceMemoryIds: [], generatedAt: "", reviewedByUser: false }
  };
  settings.setPersona(input);
  const got = settings.getPersona();
  assert.deepEqual(got.default, input);
  assert.deepEqual(got.byAgent, {});
  store.close();
});

test("default card write drops unknown fields", () => {
  const { store, settings } = setup();
  settings.setPersona({ name: "Amarre", sneaky: "field" });
  const got = settings.getPersona();
  assert.equal(got.default.name, "Amarre");
  assert.equal("sneaky" in got.default, false);
  store.close();
});

test("persona read of corrupt JSON returns empty store without throwing", () => {
  const { store, settings } = setup();
  settings.setPersona({ name: "seed" });
  // 直改底层键模拟损坏（面板口径：坏值显示为空、可重写，不抛错）
  store.db.prepare("UPDATE user_settings SET value = ? WHERE key = 'persona'").run("not json at all");
  assert.deepEqual(settings.getPersona(), { default: {}, byAgent: {} });
  store.close();
});

test("persona read of non-object JSON (array/number) returns empty store", () => {
  const { store, settings } = setup();
  store.db.prepare("INSERT INTO user_settings (key, value) VALUES ('persona', '[1,2]')").run();
  assert.deepEqual(settings.getPersona(), { default: {}, byAgent: {} });
  store.db.prepare("UPDATE user_settings SET value = '42' WHERE key = 'persona'").run();
  assert.deepEqual(settings.getPersona(), { default: {}, byAgent: {} });
  store.close();
});

test("setPersona tolerates non-object input (writes empty persona)", () => {
  const { store, settings } = setup();
  settings.setPersona(null);
  assert.deepEqual(settings.getPersona(), { default: {}, byAgent: {} });
  settings.setPersona("nope");
  assert.deepEqual(settings.getPersona(), { default: {}, byAgent: {} });
  store.close();
});

// ---- v1.2 多卡模型：{ default, byAgent }，旧单对象读作 default 兼容 ----------

test("v1 legacy single-object persona reads as default (zero migration)", () => {
  const { store, settings } = setup();
  // 直写 v1 形（单对象）模拟存量库
  store.db.prepare("INSERT INTO user_settings (key, value) VALUES ('persona', ?)")
    .run(JSON.stringify({ name: "Amarre", personality: "轻松幽默", enabled: true }));
  const got = settings.getPersona();
  assert.equal(got.default.name, "Amarre");
  assert.equal(got.default.enabled, true);
  assert.deepEqual(got.byAgent, {});
  store.close();
});

// 寻址口径住在 src/user-settings.js（注入与面板预览共用一份），不在 settings 里——
// settings 只存卡。原来那两个 getPersonaFor 用例因此改指向 resolvePersonaCard：
// 断言的是同一件事，但落在唯一那份实现上。
test("byAgent card round-trips via setPersonaFor/resolvePersonaCard", () => {
  const { store, settings } = setup();
  settings.setPersonaFor("zephyr", { name: "泽菲尔", personality: "冷危占有", enabled: true });
  assert.deepEqual(resolvePersonaCard(settings, "zephyr").card, { name: "泽菲尔", personality: "冷危占有", enabled: true });
  assert.equal(resolvePersonaCard(settings, "zephyr").source, "byAgent");
  // default 仍在且未被影响
  assert.deepEqual(settings.getPersona().default, {});
  // 卡列表含 zephyr
  assert.deepEqual(settings.listPersonas(), ["zephyr"]);
  store.close();
});

test("缺省寻址：身份没建卡、或卡被关掉，都落 default", () => {
  const { store, settings } = setup();
  settings.setPersona({ name: "Amarre", enabled: true }); // 单对象形写 default
  settings.setPersonaFor("zephyr", { name: "泽菲尔", enabled: false }); // 卡存在但关
  assert.equal(resolvePersonaCard(settings, "unknown-bot").card.name, "Amarre");
  // 身份卡存在但 enabled=false → 落 default（兜底优先，不注入半张卡）
  assert.equal(resolvePersonaCard(settings, "zephyr").card.name, "Amarre");
  // 身份缺失（null/空串）→ default
  assert.equal(resolvePersonaCard(settings, null).card.name, "Amarre");
  assert.equal(resolvePersonaCard(settings, "").card.name, "Amarre");
  store.close();
});

test("strict 寻址：身份没建卡与卡被关掉都不注入，无名会话仍用 default", () => {
  const { store, settings } = setup();
  settings.setPersona({ name: "Amarre", enabled: true });
  settings.setPersonaFor("zephyr", { name: "泽菲尔", enabled: false });
  const strict = { strict: true };
  for (const id of ["unknown-bot", "zephyr"]) {
    const { card, source } = resolvePersonaCard(settings, id, strict);
    assert.equal(source, "none", `${id} 在严格寻址下不该拿到任何卡`);
    assert.deepEqual(card, {});
  }
  // 开着的身份卡照样命中（strict 不改变命中语义）
  settings.setPersonaFor("mentor", { name: "导师", enabled: true });
  assert.equal(resolvePersonaCard(settings, "mentor", strict).source, "byAgent");
  // 解析不到身份 = default 卡的受众，strict 不动这一格
  assert.equal(resolvePersonaCard(settings, null, strict).card.name, "Amarre");
  store.close();
});

test("setPersona single-object form merges default and keeps byAgent", () => {
  const { store, settings } = setup();
  settings.setPersonaFor("zephyr", { name: "泽菲尔", enabled: true });
  settings.setPersona({ name: "Amarre-新", enabled: true }); // 单对象形
  const got = settings.getPersona();
  assert.equal(got.default.name, "Amarre-新");
  assert.equal(got.byAgent.zephyr.name, "泽菲尔", "byAgent must survive a legacy-form write");
  store.close();
});

test("removePersona deletes byAgent card but default is protected", () => {
  const { store, settings } = setup();
  settings.setPersonaFor("zephyr", { name: "泽菲尔", enabled: true });
  assert.equal(settings.removePersona("zephyr"), true);
  assert.deepEqual(settings.listPersonas(), []);
  assert.equal(settings.removePersona("default"), false, "default card cannot be removed");
  assert.equal(settings.removePersona("ghost"), false);
  store.close();
});

test("corrupt multi-card JSON reads as empty store without throwing", () => {
  const { store, settings } = setup();
  settings.setPersona({ name: "seed" });
  store.db.prepare("UPDATE user_settings SET value = ? WHERE key = 'persona'").run("broken {");
  assert.deepEqual(settings.getPersona(), { default: {}, byAgent: {} });
  store.close();
});

test("personaEnabled is in the feature-flag boolean whitelist", () => {
  const { store, settings } = setup();
  // 写侧逐键校验的合并写：未知键抛 TypeError，白名单键可用——
  // 这条锁防「白名单漏登记 → 面板开关静默失效」（#254 同型坑）。
  settings.setFeatureFlags({ personaEnabled: true });
  assert.equal(settings.getFeatureFlags().personaEnabled, true);
  assert.throws(() => settings.setFeatureFlags({ notARealFlag: true }), TypeError);
  store.close();
});
