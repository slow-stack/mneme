// Persona settings (user_settings "persona" key) — getPersona/setPersona.
// Locks: round-trip keeps whitelisted fields; corruption returns {} without
// throwing; unknown fields are dropped on write (design: reports/persona-page-design.md ①).
// Whitelist lock guards the #254-style pit: a flag missing from
// FEATURE_FLAG_BOOLEANS would make the panel toggle silently ineffective.
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createSettings } from "../src/settings.js";

function setup() {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  return { store, settings };
}

test("persona defaults to empty object and round-trips whitelisted fields", () => {
  const { store, settings } = setup();
  assert.deepEqual(settings.getPersona(), {});
  const input = {
    name: "Amarre",
    personality: "轻松幽默，讲解用类比",
    replyStyle: "先给结论再解释",
    enabled: false,
    provenance: { sourceMemoryIds: [], generatedAt: "", reviewedByUser: false }
  };
  settings.setPersona(input);
  assert.deepEqual(settings.getPersona(), input);
  store.close();
});

test("persona write drops unknown fields", () => {
  const { store, settings } = setup();
  settings.setPersona({ name: "Amarre", sneaky: "field" });
  const got = settings.getPersona();
  assert.equal(got.name, "Amarre");
  assert.equal("sneaky" in got, false);
  store.close();
});

test("persona read of corrupt JSON returns {} without throwing", () => {
  const { store, settings } = setup();
  settings.setPersona({ name: "seed" });
  // 直改底层键模拟损坏（面板口径：坏值显示为空、可重写，不抛错）
  store.db.prepare("UPDATE user_settings SET value = ? WHERE key = 'persona'").run("not json at all");
  assert.deepEqual(settings.getPersona(), {});
  store.close();
});

test("persona read of non-object JSON (array/number) returns {}", () => {
  const { store, settings } = setup();
  store.db.prepare("INSERT INTO user_settings (key, value) VALUES ('persona', '[1,2]')").run();
  assert.deepEqual(settings.getPersona(), {});
  store.db.prepare("UPDATE user_settings SET value = '42' WHERE key = 'persona'").run();
  assert.deepEqual(settings.getPersona(), {});
  store.close();
});

test("setPersona tolerates non-object input (writes empty persona)", () => {
  const { store, settings } = setup();
  settings.setPersona(null);
  assert.deepEqual(settings.getPersona(), {});
  settings.setPersona("nope");
  assert.deepEqual(settings.getPersona(), {});
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
