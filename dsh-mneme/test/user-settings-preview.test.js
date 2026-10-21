// 修复二：面板「Agent 眼中的画像」那张卡标榜的是「注入生效文本」，但它原本是前端
// 自己拼的（只有 profile + rules，既没有 [用户设置] 表头、没有「- 用户画像：」前缀，
// 也完全没有人格三行）。两块渲染代码各写各的，就一定会漂——所以这里要的是**同源**：
// 预览必须由注入器用的同一个渲染函数产出，而不是第二份实现。
// 本文件最关键的一条是第 1 条：拿同一个 settings、同一个 config、同一个会话身份，
// 让注入器与路由各渲染一次，断言逐字节相等。前端复刻模板的写法永远锁不住这条。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createInjector } from "../src/inject.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function req(path, method = "GET") {
  return { url: path, method, headers: {}, on() {}, emit() {} };
}

// 一份 settings/config 同时喂注入器与 API：两侧必须读同一个源，否则「同源」是假的。
function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const settings = createSettings(store.db);
  const contexts = [];
  const ctx = { systemPrompt: { context(def) { contexts.push(def); return () => {}; } } };
  createInjector(ctx, service, settings, config);
  const injectorText = (agentPreset) =>
    contexts.find((c) => c.name === "user-settings").text(agentPreset ? { agent: { session: { header: { agentPreset } } } } : {});
  const routes = [];
  createApi(
    { webServer: { register: (route) => { routes.push(route); return () => {}; } } },
    service,
    settings,
    { add: () => {}, remove: () => {}, list: () => [] },
    undefined,
    undefined,
    "",
    config
  );
  const route = routes.find((r) => r.path === "/api/dsh-mneme/persona");
  const preview = async (agent) => {
    const res = new FakeRes();
    await route.handler(req(`/api/dsh-mneme/persona${agent ? `?agent=${agent}` : ""}`), res);
    return JSON.parse(res.body);
  };
  return { store, settings, injectorText, preview };
}

function seed(settings) {
  settings.setProfile("用户是规划背景");
  settings.setRules(["不提及用户名"]);
  settings.setPersona({ name: "Amarre", personality: "轻松幽默", replyStyle: "先结论后展开", enabled: true });
  settings.setPersonaFor("zephyr", { name: "泽菲尔", personality: "冷危", enabled: true });
}

test("预览与注入器逐字节同源（同身份、同配置渲染两次必须一致）", async () => {
  const { store, settings, injectorText, preview } = setup({ personaEnabled: true });
  seed(settings);
  for (const agent of ["zephyr", "unknown-bot", undefined]) {
    const fromInjector = injectorText(agent);
    const body = await preview(agent);
    assert.equal(body.preview.text, fromInjector, `agent=${agent ?? "(无)"} 的预览必须等于注入器这一帧的输出`);
  }
  store.close();
});

test("预览含表头与画像前缀，且人格行在最前（原样复刻注入文本，不是前端拼的三条）", async () => {
  const { store, settings, preview } = setup({ personaEnabled: true });
  seed(settings);
  const { preview: p } = await preview();
  assert.ok(p.text.startsWith("[用户设置] 来自 dsh-mneme 的用户画像与规则："), "表头缺失就不是「生效文本」");
  assert.ok(p.text.includes("- 你的人格名字：Amarre"), "人格行必须在预览里——原来那段完全没有它");
  assert.ok(p.text.includes("- 用户画像：用户是规划背景"), "画像前缀同理");
  assert.ok(p.text.indexOf("你的人格名字") < p.text.indexOf("用户画像："), "顺序即优先级：人格先出、画像与规则后出");
  assert.equal(p.source, "default", "无 agent 参数 = 按「解析不到身份」寻址");
  // agent 是面板区分两种 default 的唯一依据：解析不到身份（null）与「身份解析到了、
  // 但没建卡/卡被关」（回显那个身份）。少了这条断言，面板那条回落文案就没有依据。
  assert.equal(p.agent, null);
  store.close();
});

test("身份解析到了却没有可用的卡：source=default 且回显该身份", async () => {
  const { store, settings, preview } = setup({ personaEnabled: true });
  seed(settings);
  settings.setPersonaFor("ghost", { name: "无人格", enabled: false });
  const { preview: p } = await preview("ghost");
  assert.equal(p.source, "default", "默认口径下这张关掉的卡落回默认卡");
  assert.equal(p.agent, "ghost", "但身份是解析到的——面板要靠它说「回落」而不是「解析不到」");
  store.close();
});

test("预览按 agent 参数寻址，并说明用的是哪张卡", async () => {
  const { store, settings, preview } = setup({ personaEnabled: true });
  seed(settings);
  const hit = await preview("zephyr");
  assert.equal(hit.preview.source, "byAgent");
  assert.equal(hit.preview.agent, "zephyr");
  assert.ok(hit.preview.text.includes("你的人格名字：泽菲尔"));
  store.close();
});

test("总闸关着时预览如实说「人格不会注入」，且不把人格行混进去", async () => {
  const { store, settings, preview } = setup({ personaEnabled: false });
  seed(settings);
  const { preview: p } = await preview();
  assert.equal(p.configGate, false, "面板要靠这个字段解释「卡开着为什么没生效」");
  assert.ok(!p.text.includes("你的人格名字"), "预览里也不许出现实际不会注入的行");
  assert.ok(p.text.includes("用户画像："), "画像与规则照旧注入——闸只管人格");
  store.close();
});

test("strict 寻址 + 身份未命中：source=none，人格行一段都不出现", async () => {
  const { store, settings, preview } = setup({ personaEnabled: true, personaStrictAddressing: true });
  seed(settings);
  const { preview: p } = await preview("unknown-bot");
  assert.equal(p.source, "none");
  assert.ok(!p.text.includes("Amarre"), "外部身份在严格寻址下拿不到任何人格");
  assert.ok(p.text.includes("用户画像："), "画像与规则不受影响");
  store.close();
});
