import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createStandaloneApi } from "../src/api-standalone.js";
import { PACKAGE_VERSION } from "../src/version-check.js";
import { Config, applyLightModePreset } from "../src/config.js";

// Real HTTP server on an OS-assigned port (port: 0), driven with fetch.
async function setup({ config = {}, embedder = null, embedTimeoutMs } = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const settings = createSettings(store.db);
  const api = createStandaloneApi({ service, store, config, settings, logger: null, port: 0, embedder, embedTimeoutMs });
  await api.ready;
  const base = `http://127.0.0.1:${api.port}`;
  const auth = { authorization: `Bearer ${api.token}` };
  return {
    store,
    service,
    settings,
    api,
    base,
    auth,
    close: () => {
      // Drop pooled keep-alive sockets so node --test can drain the loop.
      api.server.closeIdleConnections?.();
      api.server.close();
      store.close();
    }
  };
}

// --- auth ---------------------------------------------------------------------

test("GET /health is open without a token; every other route 401s", async () => {
  const { base, close } = await setup();
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    for (const path of ["/status", "/profile", "/rules", "/memories", "/memories/x", "/search?q=x", "/context"]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 401, `${path} requires a token`);
      assert.deepEqual(await res.json(), { error: "unauthorized" });
    }

    const bad = await fetch(`${base}/status`, { headers: { authorization: "Bearer wrong-token" } });
    assert.equal(bad.status, 401, "wrong token rejected");
  } finally {
    close();
  }
});

test("GET /profile and /rules return saved settings", async () => {
  const { base, auth, settings, close } = await setup();
  try {
    settings.setProfile("我是后端工程师");
    settings.setRules(["先验证再修改", "默认使用中文回复"]);

    const profile = await fetch(`${base}/profile`, { headers: auth });
    assert.equal(profile.status, 200);
    assert.deepEqual(await profile.json(), { profile: "我是后端工程师" });

    const rules = await fetch(`${base}/rules`, { headers: auth });
    assert.equal(rules.status, 200);
    assert.deepEqual(await rules.json(), { rules: ["先验证再修改", "默认使用中文回复"] });
  } finally {
    close();
  }
});

test("GET /profile and /rules return empty values when unset", async () => {
  const { base, auth, close } = await setup();
  try {
    const profile = await fetch(`${base}/profile`, { headers: auth });
    assert.equal(profile.status, 200);
    assert.deepEqual(await profile.json(), { profile: "" });

    const rules = await fetch(`${base}/rules`, { headers: auth });
    assert.equal(rules.status, 200);
    assert.deepEqual(await rules.json(), { rules: [] });
  } finally {
    close();
  }
});

test("token is persisted into settings kv and reused across restarts", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const first = createStandaloneApi({ service, store, config: {}, settings, port: 0 });
  await first.ready;
  try {
    assert.equal(settings.getExternalApi().token, first.token, "generated token persisted");
    assert.ok(first.token.length >= 20, "token is a real random value");
    const second = createStandaloneApi({ service, store, config: {}, settings, port: 0 });
    await second.ready;
    assert.equal(second.token, first.token, "restart reuses the persisted token");
    second.server.closeIdleConnections?.();
    second.server.close();
  } finally {
    first.server.closeIdleConnections?.();
    first.server.close();
    store.close();
  }
});

// --- CRUD loop ------------------------------------------------------------------

test("POST/GET/DELETE /memories round trip", async () => {
  const { base, auth, close } = await setup();
  try {
    const post = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "preference", title: "语言", content: "始终用中文回复", importance: 4, tags: ["交流"] })
    });
    assert.equal(post.status, 201);
    const created = await post.json();
    assert.ok(created.id, "row id returned");
    assert.equal(created.title, "语言");
    assert.equal(created.importance, 4);

    const list = await fetch(`${base}/memories?limit=10`, { headers: auth });
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.total, 1);
    assert.equal(listBody.items.length, 1);

    const got = await fetch(`${base}/memories/${created.id}`, { headers: auth });
    assert.equal(got.status, 200);
    assert.equal((await got.json()).content, "始终用中文回复");

    const del = await fetch(`${base}/memories/${created.id}`, { method: "DELETE", headers: auth });
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { ok: true });

    const gone = await fetch(`${base}/memories/${created.id}`, { headers: auth });
    assert.equal(gone.status, 404, "deleted row reads back as 404");
    const delAgain = await fetch(`${base}/memories/${created.id}`, { method: "DELETE", headers: auth });
    assert.equal(delAgain.status, 404, "deleting a missing row is 404, not a fake ok");
  } finally {
    close();
  }
});

test("POST /memories dedupes same title within a type (200 + merged content)", async () => {
  const { base, auth, close } = await setup();
  try {
    const first = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "project", title: "mneme", content: "v1 内容" })
    });
    assert.equal(first.status, 201);
    const row1 = await first.json();

    const second = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "project", title: "mneme", content: "v2 追加" })
    });
    assert.equal(second.status, 200, "merge, not a second creation");
    const row2 = await second.json();
    assert.equal(row2.id, row1.id, "same row reused");
    assert.ok(row2.content.includes("v1 内容") && row2.content.includes("v2 追加"), "content appended");

    const list = await fetch(`${base}/memories`, { headers: auth });
    assert.equal((await list.json()).total, 1, "no duplicate row created");
  } finally {
    close();
  }
});

test("POST /memories validation: invalid type, bad JSON, non-array tags → 400", async () => {
  const { base, auth, close } = await setup();
  try {
    const badType = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "diary", title: "t", content: "c" })
    });
    assert.equal(badType.status, 400);
    assert.deepEqual(await badType.json(), { error: "invalid-type" });

    const badJson = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{not json"
    });
    assert.equal(badJson.status, 400);
    assert.deepEqual(await badJson.json(), { error: "invalid-json" });

    const badTags = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "project", title: "t", content: "c", tags: "x" })
    });
    assert.equal(badTags.status, 400);
    assert.deepEqual(await badTags.json(), { error: "tags-must-be-an-array" });

    const noTitle = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "project", content: "c" })
    });
    assert.equal(noTitle.status, 400);
    assert.deepEqual(await noTitle.json(), { error: "missing-title" });
  } finally {
    close();
  }
});

// --- list filters / status / search ---------------------------------------------

test("GET /memories honors type + minImportance filters and paging", async () => {
  const { base, auth, service, close } = await setup();
  try {
    service.saveWithDedupe({ type: "preference", title: "低", content: "i2", importance: 2 });
    service.saveWithDedupe({ type: "preference", title: "高", content: "i5", importance: 5 });
    service.saveWithDedupe({ type: "project", title: "项目", content: "i4", importance: 4 });

    const byType = await fetch(`${base}/memories?type=preference`, { headers: auth });
    assert.equal((await byType.json()).total, 2);

    const byImportance = await fetch(`${base}/memories?minImportance=4`, { headers: auth });
    const filtered = await byImportance.json();
    assert.equal(filtered.total, 2);
    assert.deepEqual(filtered.items.map((m) => m.title).sort(), ["项目", "高"]);

    const paged = await fetch(`${base}/memories?limit=2&offset=0&order=chrono`, { headers: auth });
    const page = await paged.json();
    assert.equal(page.items.length, 2);
    assert.equal(page.total, 3);
  } finally {
    close();
  }
});

test("GET /status reports version, per-type totals, entities and uptime", async () => {
  const { base, auth, service, close } = await setup();
  try {
    service.saveWithDedupe({ type: "preference", title: "p", content: "c" });
    service.saveWithDedupe({ type: "project", title: "j", content: "c" });
    service.saveWithDedupe({ type: "project", title: "j2", content: "c" });

    const res = await fetch(`${base}/status`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    // 回归锁：/status 的版本必须来自 package.json（PACKAGE_VERSION），不是散落的
    // 字面量——曾经此处硬编码常量在发版时漏 bump，运行 0.8.13 却对外报 0.7.12。
    assert.equal(body.version, PACKAGE_VERSION);
    assert.equal(body.memories.total, 3);
    assert.equal(body.memories.byType.preference, 1);
    assert.equal(body.memories.byType.project, 2);
    assert.equal(body.entities, 0, "no extraction wired → empty entity table");
    assert.ok(Number.isInteger(body.uptime_s));
  } finally {
    close();
  }
});

test("GET /search finds saved memories; empty q returns empty keyword result", async () => {
  const { base, auth, close } = await setup();
  try {
    await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "project", title: "记忆插件", content: "SQLite 全文检索" })
    });

    const res = await fetch(`${base}/search?q=${encodeURIComponent("全文检索")}&mode=keyword`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, "keyword");
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].title, "记忆插件");

    const empty = await fetch(`${base}/search?q=`, { headers: auth });
    assert.deepEqual(await empty.json(), { items: [], mode: "keyword" });
  } finally {
    close();
  }
});

test("unknown path returns 404 json", async () => {
  const { base, auth, close } = await setup();
  try {
    const res = await fetch(`${base}/nope`, { headers: auth });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not-found" });
  } finally {
    close();
  }
});

// --- light-mode preset (applyLightModePreset) ------------------------------------

const LIGHT_OFF_FIELDS = [
  "entityExtractionEnabled",
  "autoDream",
  "sleepModeEnabled",
  "rerankEnabled",
  "autoReindexOnBoot",
  "hybridInject",
  "searchSemanticDedup",
  "selectiveInjectEnabled",
  "bm25SearchEnabled"
];

test("applyLightModePreset turns heavy features off and keeps the core loop", () => {
  const cfg = applyLightModePreset(Config({ lightMode: true }));
  for (const field of LIGHT_OFF_FIELDS) {
    assert.equal(cfg[field], false, `${field} forced off in light mode`);
  }
  // Core loop preserved.
  assert.equal(cfg.autoInject, true);
  assert.equal(cfg.autoSummarize, true);
  assert.equal(cfg.hotMemoryEnabled, true);
  assert.equal(cfg.memoryQualityFilter.enabled, true);
  // Unrelated knobs untouched.
  assert.equal(cfg.dreamThresholdCount, 10);
  assert.equal(cfg.dreamDelayMs, 2000);
  assert.equal(cfg.maxInjectedItems, 5);
});

test("applyLightModePreset keeps explicit non-preset values and is a no-op without lightMode", () => {
  const tuned = applyLightModePreset(Config({ lightMode: true, dreamThresholdCount: 30, maxInjectedItems: 8 }));
  assert.equal(tuned.dreamThresholdCount, 30, "operator values survive the preset");
  assert.equal(tuned.maxInjectedItems, 8);

  const plain = Config({});
  assert.equal(applyLightModePreset(plain), plain, "identity when lightMode is unset");
  const off = Config({ lightMode: false });
  assert.equal(applyLightModePreset(off), off, "identity when lightMode is false");
});

test("persisted panel_mode=light wins over a bundle config that did not ask for it", () => {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  try {
    // Panel switched to light in a previous session; bundle config says nothing.
    settings.setPanelMode("light");
    const rawCfg = Config({});
    const lightMode = rawCfg.lightMode === true || settings.getPanelMode() === "light";
    const cfg = applyLightModePreset({ ...rawCfg, lightMode });
    assert.equal(lightMode, true, "persisted mode forces light");
    assert.equal(cfg.autoDream, false);
    assert.equal(cfg.entityExtractionEnabled, false);
    assert.equal(cfg.autoInject, true, "core injection stays on");

    // standard (default) never forces the preset even with a light bundle flag off.
    settings.setPanelMode("standard");
    const raw2 = Config({});
    assert.equal(raw2.lightMode === true || settings.getPanelMode() === "light", false);
  } finally {
    store.close();
  }
});

// --- #181：MCP 六件套的 API 面（PUT / save 透传 / archived 与 occurred 窗口）---

test("PUT /memories/:id patches fields and returns the DTO (unauthorized without token)", async () => {
  const { base, auth, service, close } = await setup();
  try {
    const created = await (await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "preference", title: "编辑器", content: "用 vim", importance: 3 })
    })).json();

    const noAuth = await fetch(`${base}/memories/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "用 nvim" })
    });
    assert.equal(noAuth.status, 401, "PUT requires the Bearer token");

    const put = await fetch(`${base}/memories/${created.id}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ content: "用 nvim", importance: 4, tags: ["工具"], reason: "用户改用 nvim 了" })
    });
    assert.equal(put.status, 200);
    const { memory } = await put.json();
    assert.equal(memory.content, "用 nvim");
    assert.equal(memory.importance, 4);
    assert.deepEqual(memory.tags, ["工具"]);

    // content 改写按 human_override 入档（与内部面板写路径一致）。
    const raw = service.getById(created.id);
    assert.equal(raw.content_history?.[0]?.source, "human_override");
    assert.equal(raw.content_history?.[0]?.content, "用 vim");
  } finally {
    close();
  }
});

test("PUT /memories/:id validation: bad fields → 400, empty patch → 400, missing id → 404", async () => {
  const { base, auth, close } = await setup();
  try {
    const put = (body, id = "whatever") => fetch(`${base}/memories/${id}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    assert.equal((await put({ title: "" })).status, 400);
    assert.equal((await put({ importance: 9 })).status, 400);
    assert.equal((await put({ tags: "x" })).status, 400);
    assert.equal((await put({ type: "nope" })).status, 400);
    assert.equal((await put({})).status, 400, "empty patch is no-fields");
    assert.equal((await put({ content: "x" }, "missing-id")).status, 404);
    assert.equal((await put({ agent_scope: 5 })).status, 400);
  } finally {
    close();
  }
});

test("PUT /memories/:id surfaces service failures as 500 instead of a hung request", async () => {
  const { base, auth, service, close } = await setup();
  try {
    const created = await (await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "preference", title: "会抛错", content: "v1" })
    })).json();
    const original = service.update;
    service.update = () => { throw new Error("boom"); };
    try {
      const res = await fetch(`${base}/memories/${created.id}`, {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ content: "v2" })
      });
      assert.equal(res.status, 500, "service throw must not strand the request");
      assert.deepEqual(await res.json(), { error: "internal" });
    } finally {
      service.update = original;
    }
  } finally {
    close();
  }
});

test("POST /memories passes through sensitivity/occurred_at/scope and returns action", async () => {
  const { base, auth, close } = await setup();
  try {
    const post = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        type: "decision",
        title: "迁移",
        content: "迁到 sqlite 分支",
        sensitivity: "personal",
        occurred_at: "2026-01-15T10:00:00Z",
        agent_scope: "global"
      })
    });
    assert.equal(post.status, 201);
    const created = await post.json();
    assert.equal(created.action, "created", "action rides along for tool parity");
    assert.equal(created.sensitivity, "personal");
    // store 把 ISO 瞬时归一化成完整毫秒形式（2026-01-15T10:00:00Z → …T10:00:00.000Z）。
    assert.match(created.occurred_at, /^2026-01-15T10:00:00/);
    assert.equal(created.agent_scope, "global");
    assert.equal(created.agent_scope_source, "explicit");

    // 合并判据=同 type + 同标题 + 同 sensitivity + 同作用域三元（0.8.0 起去重键
    // 含 scope，跨作用域同标题本就分开存）：补齐 agent_scope 才 merged。
    const merged = await (await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "decision", title: "迁移", content: "迁到 sqlite 分支（更新）", sensitivity: "personal", agent_scope: "global" })
    })).json();
    assert.equal(merged.action, "merged", "same dedupe key reports merged");

    const separate = await (await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "decision", title: "迁移", content: "无标注版本" })
    })).json();
    assert.equal(separate.action, "created", "no sensitivity/scope → different dedupe key");

    const bad = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "decision", title: "x", content: "y", sensitivity: 5 })
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "invalid-sensitivity");
  } finally {
    close();
  }
});

test("GET /memories supports include_archived and the occurred_at window", async () => {
  const { base, auth, service, close } = await setup();
  try {
    const save = (title, occurredAt) => fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "history", title, content: `body of ${title}`, ...(occurredAt ? { occurred_at: occurredAt } : {}) })
    });
    const january = await (await save("一月的事", "2026-01-15T10:00:00Z")).json();
    await save("二月的事", "2026-02-15T10:00:00Z");
    await save("无时间戳的事", null);

    const february = await (await fetch(`${base}/memories?occurred_from=2026-02-01`, { headers: auth })).json();
    // 「无时间戳的事」按 occurred_at→created_at 回退（写入日 2026-09），落在窗口内。
    assert.deepEqual(february.items.map((m) => m.title).sort(), ["二月的事", "无时间戳的事"]);
    assert.equal(february.total, 2, "total honors the same window");

    const upToJanuary = await (await fetch(`${base}/memories?occurred_to=2026-01-31`, { headers: auth })).json();
    assert.deepEqual(upToJanuary.items.map((m) => m.title), ["一月的事"]);

    service.setArchived(january.id, true);
    const active = await (await fetch(`${base}/memories`, { headers: auth })).json();
    assert.equal(active.total, 2, "archived rows stay hidden by default");
    const withArchived = await (await fetch(`${base}/memories?include_archived=true`, { headers: auth })).json();
    assert.equal(withArchived.total, 3, "include_archived=true surfaces archived rows");
  } finally {
    close();
  }
});

test("GET /search honors the occurred_at window", async () => {
  const { base, auth, close } = await setup();
  try {
    const save = (title, occurredAt) => fetch(`${base}/memories`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "history", title, content: `记忆星球 ${title}`, ...(occurredAt ? { occurred_at: occurredAt } : {}) })
    });
    await save("旧事", "2026-01-15T10:00:00Z");
    await save("新事", "2026-03-15T10:00:00Z");

    const hit = await (await fetch(`${base}/search?q=${encodeURIComponent("记忆星球")}&occurred_from=2026-03-01`, { headers: auth })).json();
    assert.equal(hit.items.length, 1);
    assert.equal(hit.items[0].title, "新事");
  } finally {
    close();
  }
});

// --- GET /context（issue #370，#363 承诺）---------------------------------------

/** /context 用例的省事入库：走 POST /memories，与第三方调用同路径。 */
async function saveMemory(base, auth, body) {
  const res = await fetch(`${base}/memories`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.ok(res.status === 201 || res.status === 200, `save ${body.title} → ${res.status}`);
  return res.json();
}

test("GET /search passes a declared scope through (strictScope hard wall on the search face too)", async () => {
  // issue #370：searchMemories 本就收 scope，8790 此前没有入口——透传后第三方
  // 声明身份，A2 软加权与 strictScope 硬过滤在检索面同样成立；不传参数行为
  // 与既往逐字节一致（scopeFromSearchParams 返回 undefined → 不进 options）。
  const { base, auth, close } = await setup({ config: { strictScope: true } });
  try {
    await saveMemory(base, auth, { type: "decision", title: "他域检索", content: "外部线索 abc", importance: 5, agent_scope: "other-agent" });

    const scoped = await (await fetch(`${base}/search?q=${encodeURIComponent("外部线索")}&agent_scope=me`, { headers: auth })).json();
    assert.ok(!scoped.items.some((m) => m.title === "他域检索"), "explicit foreign agent_scope row is hard-filtered");

    const unscoped = await (await fetch(`${base}/search?q=${encodeURIComponent("外部线索")}`, { headers: auth })).json();
    assert.ok(unscoped.items.some((m) => m.title === "他域检索"), "no scope declared → gate dormant, behavior unchanged");
  } finally {
    close();
  }
});

test("GET /context returns the injection-shaped aggregate; empty q still serves the rule tier", async () => {
  const { base, auth, settings, close } = await setup();
  try {
    settings.setProfile("我是后端工程师");
    settings.setRules(["先验证再修改"]);
    await saveMemory(base, auth, { type: "decision", title: "核心决策", content: "选定 SQLite 单文件库", importance: 5 });
    await saveMemory(base, auth, { type: "preference", title: "默认中文", content: "回复默认用中文", importance: 4 });

    const res = await fetch(`${base}/context`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    // 形状锁：五键响应——bridge 等调用方按这些键渲染，漂移（加塞/漏带）在此变红。
    // #383 新增 tier（档位信号）；空 q 时语义路未启用，报 unknown 而不是 full。
    assert.deepEqual(Object.keys(body).sort(), ["items", "pinnedCount", "profile", "rules", "tier"]);
    assert.equal(typeof body.tier, "string", "tier 必填");
    assert.equal(body.tier, "unknown", "空 q = 语义路未启用，不宣称档位（fail-closed，不报 full）");
    assert.equal(body.profile, "我是后端工程师");
    assert.deepEqual(body.rules, ["先验证再修改"]);
    assert.equal(body.pinnedCount, 0, "pinnedInjectBudget 默认 0（opt-in 纪律，issue #370 取舍 3）");
    const titles = body.items.map((m) => m.title);
    assert.ok(titles.includes("核心决策") && titles.includes("默认中文"), "empty q → pure rule tier, high-importance rows still served");
    for (const item of body.items) {
      assert.ok(item.id && item.type && item.title && typeof item.content === "string" && Number.isInteger(item.importance));
    }
  } finally {
    close();
  }
});

test("GET /context threshold is an importance gate (not /search's similarity threshold)", async () => {
  // 同名不同义锁（issue #370 点名的文档区分）：/context 的 threshold 走
  // injectCandidates 的 importance 门（summary/preference 豁免），与相似度无关
  // ——本用例全程无 embedder/向量，纯规则档即可验证。
  const { base, auth, close } = await setup();
  try {
    await saveMemory(base, auth, { type: "decision", title: "低重要", content: "小事一桩", importance: 3 });
    await saveMemory(base, auth, { type: "decision", title: "高重要", content: "大事记", importance: 5 });

    const open = await (await fetch(`${base}/context`, { headers: auth })).json();
    const openTitles = open.items.map((m) => m.title);
    assert.ok(openTitles.includes("低重要") && openTitles.includes("高重要"), "default threshold=3 admits both");

    const gated = await (await fetch(`${base}/context?threshold=4`, { headers: auth })).json();
    const gatedTitles = gated.items.map((m) => m.title);
    assert.ok(gatedTitles.includes("高重要"), "importance 5 survives threshold=4");
    assert.ok(!gatedTitles.includes("低重要"), "importance 3 is gated out at threshold=4");
  } finally {
    close();
  }
});

test("GET /context pins preference rows ahead when pinnedInjectBudget is on", async () => {
  // #249 pin 池经 8790 透出。用 preference 而非 constraint：constraint 属编码
  // 记忆，非编码查询被 codingGate 排除在候选池外，pin 池也够不着它。
  const { base, auth, close } = await setup({ config: { pinnedInjectBudget: 2 } });
  try {
    await saveMemory(base, auth, { type: "preference", title: "pin-偏好", content: "永远先讲结论", importance: 5 });
    await saveMemory(base, auth, { type: "decision", title: "普通决策", content: "先做 A 再做 B", importance: 5 });

    const body = await (await fetch(`${base}/context`, { headers: auth })).json();
    assert.equal(body.items[0].title, "pin-偏好", "pinned row leads the block");
    assert.equal(body.pinnedCount, 1);
  } finally {
    close();
  }
});

test("GET /context honors a declared scope under strictScope; undeclared stays unfiltered", async () => {
  // scope 语义锁（issue #370）：声明身份 → strictScope 硬过滤按 isVisibleInScope
  // 生效；不声明 → scope=null，门不触发（与宿主「会话身份取不到时两维为 null」
  // 同构）。任一维声明而另一维缺省时，缺维按解析不到走 fail-closed。
  const { base, auth, close } = await setup({ config: { strictScope: true } });
  try {
    await saveMemory(base, auth, { type: "decision", title: "他域决策", content: "别的 agent 的事", importance: 5, agent_scope: "other-agent" });
    await saveMemory(base, auth, { type: "decision", title: "全域决策", content: "谁都可见", importance: 5 });

    const declared = await (await fetch(`${base}/context?agent_scope=me`, { headers: auth })).json();
    const declaredTitles = declared.items.map((m) => m.title);
    assert.ok(!declaredTitles.includes("他域决策"), "explicit foreign agent_scope row is hard-filtered");
    assert.ok(declaredTitles.includes("全域决策"));

    const undeclared = await (await fetch(`${base}/context`, { headers: auth })).json();
    const undeclaredTitles = undeclared.items.map((m) => m.title);
    assert.ok(undeclaredTitles.includes("他域决策"), "no declared scope → no gate");
  } finally {
    close();
  }
});

test("GET /context embeds the query via the injected embedder (wiring lock)", async () => {
  // embedder 接线锁（issue #370）：createStandaloneApi 新增的可选 embedder 必须
  // 真被 /context 用上——宿主与 daemon 传的都是 semantic 装配的同一实例。
  const calls = [];
  const fake = {
    ready: true,
    modelHash: "fake-hash-1",
    dimension: 4,
    embedSingle: async (text) => {
      calls.push(text);
      return [1, 0, 0, 0];
    }
  };
  const { base, auth, close } = await setup({ embedder: fake });
  try {
    const res = await fetch(`${base}/context?q=${encodeURIComponent("语义查询")}`, { headers: auth });
    assert.equal(res.status, 200);
    await res.json();
    assert.deepEqual(calls, ["语义查询"], "the route must hand the query to the injected embedder");
  } finally {
    close();
  }
});

test("GET /context survives a throwing embedder (rule-tier degradation, never 500)", async () => {
  const { base, auth, close } = await setup({
    embedder: { ready: true, embedSingle: async () => { throw new Error("model offline"); } }
  });
  try {
    await saveMemory(base, auth, { type: "decision", title: "降级存照", content: "嵌入挂了也要有注入", importance: 5 });
    const res = await fetch(`${base}/context?q=任意`, { headers: auth });
    assert.equal(res.status, 200, "embed failure must degrade to the rule tier");
    const body = await res.json();
    assert.ok(body.items.some((m) => m.title === "降级存照"));
  } finally {
    close();
  }
});

test("GET /context times out a hung embedder and degrades (embedTimeoutMs guard)", async () => {
  // CodeRabbit on #371：embedder 挂起（不抛错，典型为第三方 ollama/openai 端点
  // 无响应）不能占住 HTTP 连接——超时按嵌入缺失降级规则档。测试用 50ms 短超时
  // 避免慢测试；生产默认 3000 由工厂选项约束（同 strictPort，不进 config schema）。
  const { base, auth, close } = await setup({
    embedTimeoutMs: 50,
    embedder: { ready: true, embedSingle: () => new Promise(() => {}) }
  });
  try {
    await saveMemory(base, auth, { type: "decision", title: "挂起存照", content: "嵌入悬挂也要有注入", importance: 5 });
    const started = Date.now();
    const res = await fetch(`${base}/context?q=任意`, { headers: auth });
    assert.equal(res.status, 200, "hung embedder must not hang the route");
    const body = await res.json();
    assert.ok(body.items.some((m) => m.title === "挂起存照"), "timed-out embed falls back to the rule tier");
    assert.ok(Date.now() - started < 3000, "response must not wait on the hung embedder");
  } finally {
    close();
  }
});

test("strictPort: busy port rejects instead of hopping; default path still hops", async () => {
  // daemon 语义锁(#363):strictPort 下配置端口被占 = 配置错误,明确失败 ——
  // 顺延会让把 URL 写死的第三方客户端静默打到错误端口。占口用裸 net server
  // (OS 分配,不与并行测试抢固定号)。
  const { default: net } = await import("node:net");
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const busyPort = blocker.address().port;

  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  try {
    const strict = createStandaloneApi({ service, store, config: {}, settings, logger: null, port: busyPort, strictPort: true });
    await assert.rejects(strict.ready, (err) => err?.code === "EADDRINUSE");

    // 默认路径(不传 strictPort)行为不变:顺延成功;具体端口不断言(避免抢号)。
    const hopping = createStandaloneApi({ service, store, config: {}, settings, logger: null, port: busyPort });
    await hopping.ready;
    assert.notEqual(hopping.port, busyPort, "default policy hops off a busy port");
    hopping.server.close();
  } finally {
    blocker.close();
    store.close();
  }
});

// --- GET /context 的档位信号（issue #383）---------------------------------------
// 嵌入降级在调用方视角是完全静默的：items 看起来正常，只是召回质量悄悄变差。
// 外部集成方（Mneme Bridge 的 remote 模式）无法据此降级自己的期望或打日志。
// 三态 fail-closed：判不出来报 unknown，不报 full。

/** 可用的 embedder：任何查询都回一个固定向量。 */
const okEmbedder = { embedSingle: async () => [1, 0, 0], embed: async () => [1, 0, 0] };

test("GET /context tier=full when the query embedding succeeds", async () => {
  const { base, auth, close } = await setup({ embedder: okEmbedder });
  try {
    await saveMemory(base, auth, { type: "decision", title: "核心决策", content: "选定 SQLite 单文件库", importance: 5 });
    const body = await (await fetch(`${base}/context?q=${encodeURIComponent("数据库选型")}`, { headers: auth })).json();
    assert.equal(body.tier, "full", "嵌入成功 → 语义档");
  } finally {
    close();
  }
});

test("GET /context tier=degraded when no embedder is injected", async () => {
  // 缺省（不传 embedder）：daemon 与宿主都可能走到这条——embedder 未装配。
  const { base, auth, close } = await setup();
  try {
    await saveMemory(base, auth, { type: "decision", title: "核心决策", content: "选定 SQLite 单文件库", importance: 5 });
    const body = await (await fetch(`${base}/context?q=${encodeURIComponent("数据库选型")}`, { headers: auth })).json();
    assert.equal(body.tier, "degraded", "无 embedder → 降级到规则档，且必须说出来");
  } finally {
    close();
  }
});

test("GET /context tier=degraded when the query embedding times out", async () => {
  // embedder 挂起（不抛错）时由 withEmbedTimeout 兜底——这是最难自查的一种降级，
  // 因为接口是好的、只是没有响应。
  const hanging = { embedSingle: () => new Promise(() => {}), embed: () => new Promise(() => {}) };
  const { base, auth, close } = await setup({ embedder: hanging, embedTimeoutMs: 30 });
  try {
    await saveMemory(base, auth, { type: "decision", title: "核心决策", content: "选定 SQLite 单文件库", importance: 5 });
    const body = await (await fetch(`${base}/context?q=${encodeURIComponent("数据库选型")}`, { headers: auth })).json();
    assert.equal(body.tier, "degraded", "嵌入超时 → 降级到规则档");
  } finally {
    close();
  }
});

test("GET /context tier=degraded when the embedder returns an unusable vector", async () => {
  // 空数组 / 非数组同样让语义路走不通（embedQueryVector 的既有兜底），一并报降级。
  const empty = { embedSingle: async () => [], embed: async () => [] };
  const { base, auth, close } = await setup({ embedder: empty });
  try {
    await saveMemory(base, auth, { type: "decision", title: "核心决策", content: "选定 SQLite 单文件库", importance: 5 });
    const body = await (await fetch(`${base}/context?q=${encodeURIComponent("数据库选型")}`, { headers: auth })).json();
    assert.equal(body.tier, "degraded", "不可用向量 → 降级到规则档");
  } finally {
    close();
  }
});
