import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createSettings } from "../src/settings.js";

function setup() {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  return { store, settings };
}

test("profile defaults to empty and round-trips", () => {
  const { store, settings } = setup();
  assert.equal(settings.getProfile(), "");
  settings.setProfile("我是后端工程师，偏好简洁代码");
  assert.equal(settings.getProfile(), "我是后端工程师，偏好简洁代码");
  settings.setProfile("");
  assert.equal(settings.getProfile(), "");
  store.close();
});

test("rules default to empty list and round-trip", () => {
  const { store, settings } = setup();
  assert.deepEqual(settings.getRules(), []);
  settings.setRules(["规则一", "规则二"]);
  assert.deepEqual(settings.getRules(), ["规则一", "规则二"]);
  settings.setRules([]);
  assert.deepEqual(settings.getRules(), []);
  store.close();
});

test("rules filters non-string entries", () => {
  const { store, settings } = setup();
  settings.setRules(["ok", 42, null, "also-ok"]);
  assert.deepEqual(settings.getRules(), ["ok", "also-ok"]);
  store.close();
});

test("addCommand stores and lists sorted by name", () => {
  const { store, settings } = setup();
  settings.addCommand({ name: "banner", description: "b", instruction: "打印横幅" });
  settings.addCommand({ name: "agenda", instruction: "列出今日议程" });
  const list = settings.listCommands();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((c) => c.name), ["agenda", "banner"]);
  assert.ok(list[1].id, "has id");
  store.close();
});

test("addCommand replaces existing name", () => {
  const { store, settings } = setup();
  settings.addCommand({ name: "fmt", instruction: "旧指令" });
  const updated = settings.addCommand({ name: "fmt", instruction: "新指令" });
  assert.equal(updated.instruction, "新指令");
  assert.equal(settings.listCommands().length, 1);
  store.close();
});

test("addCommand rejects invalid names and empty instructions", () => {
  const { store, settings } = setup();
  assert.throws(() => settings.addCommand({ name: "Bad Name", instruction: "x" }), /command name/);
  assert.throws(() => settings.addCommand({ name: "123abc", instruction: "x" }), /command name/);
  assert.throws(() => settings.addCommand({ name: "ok", instruction: "   " }), /instruction/);
  assert.equal(settings.listCommands().length, 0);
  store.close();
});

test("removeCommand removes by id and returns false for missing", () => {
  const { store, settings } = setup();
  const { id } = settings.addCommand({ name: "tmp", instruction: "x" });
  assert.equal(settings.removeCommand(id), true);
  assert.equal(settings.removeCommand(id), false);
  assert.equal(settings.listCommands().length, 0);
  store.close();
});

test("vector config defaults to undefined and round-trips", () => {
  const { store, settings } = setup();
  assert.equal(settings.getVectorConfig(), undefined);
  const saved = settings.setVectorConfig({
    enabled: true,
    baseUrl: " https://api.openai.com/v1/ ",
    apiKey: " sk-123 ",
    model: "text-embedding-3-small"
  });
  assert.equal(saved.enabled, true);
  assert.equal(saved.baseUrl, "https://api.openai.com/v1", "trims baseUrl");
  assert.equal(saved.apiKey, "sk-123", "trims apiKey");
  assert.equal(saved.model, "text-embedding-3-small");
  const read = settings.getVectorConfig();
  assert.equal(read.enabled, true);
  assert.equal(read.model, "text-embedding-3-small");
  store.close();
});

test("vector config disabled value is stored as false", () => {
  const { store, settings } = setup();
  settings.setVectorConfig({ enabled: false, baseUrl: "x", apiKey: "k", model: "m" });
  assert.equal(settings.getVectorConfig().enabled, false);
  store.close();
});

test("panel mode defaults to standard and round-trips", () => {
  const { store, settings } = setup();
  assert.equal(settings.getPanelMode(), "standard");
  settings.setPanelMode("light");
  assert.equal(settings.getPanelMode(), "light");
  settings.setPanelMode("standard");
  assert.equal(settings.getPanelMode(), "standard");
  store.close();
});

test("external api settings persist token and merge partial writes", () => {
  const { store, settings } = setup();
  assert.equal(settings.getExternalApi(), undefined);
  settings.setExternalApi({ enabled: true, port: 9000, token: "tok-1" });
  assert.deepEqual(settings.getExternalApi(), { enabled: true, port: 9000, host: "127.0.0.1", token: "tok-1" });
  // Token-only write preserves the other keys.
  settings.setExternalApi({ token: "tok-2" });
  assert.deepEqual(settings.getExternalApi(), { enabled: true, port: 9000, host: "127.0.0.1", token: "tok-2" });
  // Host write persists and survives the next partial merge.
  settings.setExternalApi({ host: "0.0.0.0" });
  assert.deepEqual(settings.getExternalApi(), { enabled: true, port: 9000, host: "0.0.0.0", token: "tok-2" });
  store.close();
});

// --- feature flags ---

test("feature flags default to an empty object", () => {
  const { store, settings } = setup();
  assert.deepEqual(settings.getFeatureFlags(), {});
  store.close();
});

test("setFeatureFlags rejects unknown keys and persists nothing", () => {
  const { store, settings } = setup();
  settings.setFeatureFlags({ autoDream: false });
  assert.throws(() => settings.setFeatureFlags({ noSuchFlag: true }), TypeError);
  assert.throws(() => settings.setFeatureFlags({ noSuchFlag: true }), /noSuchFlag/);
  // 被拒的 patch 不落库，已存的合法值原样保留
  assert.deepEqual(settings.getFeatureFlags(), { autoDream: false });
  store.close();
});

test("setFeatureFlags enforces boolean types and integer ranges", () => {
  const { store, settings } = setup();
  assert.throws(() => settings.setFeatureFlags({ autoInject: "yes" }), /autoInject/);
  assert.throws(() => settings.setFeatureFlags({ distillMaxChars: 500 }), /distillMaxChars/);
  assert.throws(() => settings.setFeatureFlags({ distillRateLimitRetries: 1.5 }), /distillRateLimitRetries/);
  assert.throws(() => settings.setFeatureFlags({ codingBoostFactor: 9 }), /codingBoostFactor/);
  assert.deepEqual(settings.getFeatureFlags(), {}, "failed writes persist nothing");
  store.close();
});

test("setFeatureFlags merges partial patches and persists across instances", () => {
  const { store, settings } = setup();
  settings.setFeatureFlags({ autoDream: false, distillMaxChars: 48000 });
  settings.setFeatureFlags({ rerankEnabled: true });
  // 同一 kv 上的新实例读回合并结果，证明已真正持久化
  const settings2 = createSettings(store.db);
  assert.deepEqual(settings2.getFeatureFlags(), { autoDream: false, distillMaxChars: 48000, rerankEnabled: true });
  store.close();
});

test("getFeatureFlags drops unknown and corrupted keys from the kv", () => {
  const { store, settings } = setup();
  settings.setFeatureFlags({ autoInject: false });
  // 模拟旧版本/手改残留：绕过校验直接写脏 kv
  store.db.prepare("UPDATE user_settings SET value = ? WHERE key = ?").run(
    JSON.stringify({ autoInject: false, legacyFlag: true, autoDream: "yes", distillMaxChars: 999999 }),
    "feature_flags"
  );
  assert.deepEqual(settings.getFeatureFlags(), { autoInject: false });
  // 整个 kv 损坏（非 JSON）→ 读回空对象而不是抛错
  store.db.prepare("UPDATE user_settings SET value = ? WHERE key = ?").run("not-json", "feature_flags");
  assert.deepEqual(settings.getFeatureFlags(), {});
  store.close();
});

test("feature flags accept the new boolean, string, url and enum keys", () => {
  const { store, settings } = setup();
  settings.setFeatureFlags({
    "memoryQualityFilter.enabled": false,
    "llmAudit.enabled": false,
    "distillRecords.enabled": false,
    "distillRecords.retentionDays": 30,
    bm25SearchEnabled: false,
    conflictFreezeEnabled: true,
    trustEpistemicWeighting: true,
    reflectionFailureTracking: false,
    dreamProvider: "  siliconflow  ",
    dreamModel: "deepseek-chat",
    localEmbedModel: "Xenova/bge-small-zh-v1.5",
    ollamaModel: "nomic-embed-text",
    ollamaBaseUrl: "http://127.0.0.1:11434/",
    embedProvider: "ollama"
  });
  const flags = settings.getFeatureFlags();
  assert.equal(flags["memoryQualityFilter.enabled"], false, "nested keys stored flat");
  assert.equal(flags["llmAudit.enabled"], false);
  // #399：布尔与整数范围两类键都要能过白名单（retentionDays 是 natural 1..3650）
  assert.equal(flags["distillRecords.enabled"], false);
  assert.equal(flags["distillRecords.retentionDays"], 30);
  assert.equal(flags.bm25SearchEnabled, false);
  assert.equal(flags.conflictFreezeEnabled, true);
  assert.equal(flags.trustEpistemicWeighting, true);
  assert.equal(flags.reflectionFailureTracking, false);
  assert.equal(flags.dreamProvider, "siliconflow", "string values are trimmed");
  assert.equal(flags.dreamModel, "deepseek-chat");
  assert.equal(flags.ollamaBaseUrl, "http://127.0.0.1:11434/");
  assert.equal(flags.embedProvider, "ollama");
  // 同一 kv 上的新实例读回合并结果：点号键按平铺键持久化
  const settings2 = createSettings(store.db);
  assert.equal(settings2.getFeatureFlags()["memoryQualityFilter.enabled"], false);
  assert.equal(settings2.getFeatureFlags().embedProvider, "ollama");
  store.close();
});

test("nested feature flag keys are validated as booleans and rejected otherwise", () => {
  const { store, settings } = setup();
  assert.throws(() => settings.setFeatureFlags({ "memoryQualityFilter.enabled": "yes" }), /memoryQualityFilter\.enabled/);
  assert.throws(() => settings.setFeatureFlags({ "llmAudit.enabled": 1 }), /llmAudit\.enabled/);
  assert.throws(() => settings.setFeatureFlags({ "distillRecords.enabled": 1 }), /distillRecords\.enabled/);
  // 范围外的整数也要被挡（retentionDays 上限 3650）
  assert.throws(() => settings.setFeatureFlags({ "distillRecords.retentionDays": 0 }), /distillRecords\.retentionDays/);
  assert.deepEqual(settings.getFeatureFlags(), {}, "failed writes persist nothing");
  store.close();
});

test("string feature flags: empty is legal, over-length and enum violations rejected", () => {
  const { store, settings } = setup();
  // 空字符串合法 = 跟随主对话模型（面板显示 placeholder）
  settings.setFeatureFlags({ dreamProvider: "", dreamModel: "   " });
  assert.equal(settings.getFeatureFlags().dreamProvider, "");
  assert.equal(settings.getFeatureFlags().dreamModel, "", "whitespace-only trims to empty");
  assert.throws(() => settings.setFeatureFlags({ dreamModel: "x".repeat(201) }), /dreamModel/);
  assert.throws(() => settings.setFeatureFlags({ localEmbedModel: 42 }), /localEmbedModel/);
  assert.throws(() => settings.setFeatureFlags({ embedProvider: "bogus" }), /embedProvider/);
  assert.throws(() => settings.setFeatureFlags({ embedProvider: "OpenAI" }), /embedProvider/, "enum is case-sensitive");
  assert.deepEqual(settings.getFeatureFlags(), { dreamProvider: "", dreamModel: "" }, "failed writes persist nothing");
  store.close();
});

test("ollamaBaseUrl accepts empty and http(s) URLs, rejects other protocols", () => {
  const { store, settings } = setup();
  settings.setFeatureFlags({ ollamaBaseUrl: "" });
  assert.equal(settings.getFeatureFlags().ollamaBaseUrl, "", "empty = follow default");
  settings.setFeatureFlags({ ollamaBaseUrl: "  https://embed.example.com/v1  " });
  assert.equal(settings.getFeatureFlags().ollamaBaseUrl, "https://embed.example.com/v1");
  assert.throws(() => settings.setFeatureFlags({ ollamaBaseUrl: "ftp://localhost:11434" }), /ollamaBaseUrl/);
  assert.throws(() => settings.setFeatureFlags({ ollamaBaseUrl: "file:///etc/passwd" }), /ollamaBaseUrl/);
  assert.throws(() => settings.setFeatureFlags({ ollamaBaseUrl: "javascript:alert(1)" }), /ollamaBaseUrl/);
  assert.throws(() => settings.setFeatureFlags({ ollamaBaseUrl: "localhost:11434" }), /ollamaBaseUrl/, "protocol is required");
  assert.throws(() => settings.setFeatureFlags({ ollamaBaseUrl: "not a url" }), /ollamaBaseUrl/);
  assert.equal(settings.getFeatureFlags().ollamaBaseUrl, "https://embed.example.com/v1", "rejected writes persist nothing");
  store.close();
});

test("getFeatureFlags drops corrupted string, url and enum keys from the kv", () => {
  const { store, settings } = setup();
  settings.setFeatureFlags({ dreamModel: "m", ollamaBaseUrl: "http://localhost:11434", embedProvider: "local" });
  // 模拟旧版本/手改残留：字符串键混入非字符串、URL 键混入非法协议、枚举越界
  store.db.prepare("UPDATE user_settings SET value = ? WHERE key = ?").run(
    JSON.stringify({ dreamModel: 42, ollamaBaseUrl: "ftp://bad", embedProvider: "bogus", autoInject: false }),
    "feature_flags"
  );
  assert.deepEqual(settings.getFeatureFlags(), { autoInject: false });
  store.close();
});
