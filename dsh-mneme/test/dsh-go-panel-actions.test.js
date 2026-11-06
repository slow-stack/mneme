// src/dsh-go/panel.js —— 点按之后真的发生了什么。
//
// 这里用假的 webServer / dshGo 把面板挂起来，直接调它的 actions，断言三件事：
// 发给宿主的请求是否只包含该发的字段、视图是否切到了该切的地方、以及那些
// 「按共享状态猜参数」的地方有没有被核对。评审里指出的每一条都在下面有对应用例。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mountDshGoPanel, resetPanelState } from "../src/dsh-go/panel.js";

const TOKEN = "test-token";

function reply(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function bodyOf(req) {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => {
      text += String(chunk);
    });
    req.on("end", () => resolve(text === "" ? {} : JSON.parse(text)));
  });
}

function makeWorld() {
  const memories = [
    {
      id: "m1",
      type: "project",
      title: "面板改造",
      content: "正文一",
      tags: [],
      importance: 4,
      source: "tool",
      created_at: "2026-11-01T00:00:00.000Z",
      updated_at: "2026-11-01T00:00:00.000Z",
      archived: false,
    },
    {
      id: "m2",
      type: "preference",
      title: "单位同行同字号",
      content: "正文二",
      tags: ["ui"],
      importance: 3,
      source: "chat",
      created_at: "2026-11-02T00:00:00.000Z",
      updated_at: "2026-11-02T00:00:00.000Z",
      archived: false,
    },
  ];
  const writes = [];
  const reads = [];
  const features = {
    overrides: {},
    effective: { heatEnabled: false, autoInject: true, "scopeState.enabled": false },
    pendingRestart: [],
  };
  const external = { enabled: true, port: 8899, host: "0.0.0.0", token: "" };
  const state = { rules: [{ text: "已有一条规则" }] };
  const facts = {
    items: [
      {
        id: "f1",
        agent_key: "",
        content: "喜欢简洁的回复",
        status: "active",
        created_at: "2026-11-05T00:00:00.000Z",
        updated_at: "2026-11-05T00:00:00.000Z",
      },
    ],
    runs: [],
  };

  const routes = {
    "/api/dsh-mneme/info": (req, res) => reply(res, 200, { version: "0.10.1" }),
    "/api/dsh-mneme/health": (req, res) => reply(res, 200, { mirror: { status: "ok", success_at: null } }),
    "/api/dsh-mneme/dream-status": (req, res) =>
      reply(res, 200, { lastRun: {}, lastConsolidation: null, runs: [], pendingConflicts: 0, pendingMemoryIds: [] }),
    "/api/dsh-mneme/inject-status": (req, res) =>
      reply(res, 200, { autoInject: true, agentPreset: "cordis", suppressed: false }),
    "/api/dsh-mneme/recall-stats": (req, res) =>
      reply(res, 200, { injection: { injectedCount: 12, slotFillRate: 0.75 }, topRecalled: [] }),
    "/api/dsh-mneme/inject-preview": (req, res) => reply(res, 200, { snapshot: null }),
    "/api/dsh-mneme/semantic/llm-audit/stats": (req, res) =>
      reply(res, 200, { by_day: [], total_calls: 0, total_tokens: 0, total_cost_usd: 0 }),
    "/api/dsh-mneme/conflicts": (req, res) => {
      if (req.method === "GET") reply(res, 200, { items: [], total: 0 });
    },
    "/api/dsh-mneme/list": (req, res) => {
      const url = new URL(req.url, "http://x");
      reads.push({ path: "/list", url: req.url });
      const id = url.searchParams.get("id");
      if (id !== null) {
        const row = memories.find((item) => item.id === id);
        return reply(res, 200, { items: row === undefined ? [] : [row], total: row === undefined ? 0 : 1 });
      }
      const type = url.searchParams.get("type");
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const items = memories.filter((row) => type === null || row.type === type).slice(0, limit);
      reply(res, 200, { items, total: memories.length });
    },
    "/api/dsh-mneme/search": (req, res) => {
      // /search 不认识 type：它把两类都返回，类型筛选只能由面板自己再收一遍。
      reply(res, 200, { items: memories, total: memories.length });
    },
    "/api/dsh-mneme/entities": (req, res) => {
      reads.push({ path: "/entities" });
      const url = new URL(req.url, "http://x");
      const needle = (url.searchParams.get("q") ?? "").toLowerCase();
      const all = [
        { name: "Alice", type: "person", mention_count: 3 },
        { name: "Bob", type: "agent", mention_count: 1 },
      ];
      const entities = needle === "" ? all : all.filter((row) => row.name.toLowerCase().includes(needle));
      reply(res, 200, { entities, total: entities.length, totalExact: true });
    },
    "/api/dsh-mneme/memories/entities": (req, res) => reply(res, 200, { entities: [] }),
    "/api/dsh-mneme/memory/provenance": (req, res) => reply(res, 200, { windows: [] }),
    "/api/dsh-mneme/features": (req, res) => {
      if (req.method === "GET") return reply(res, 200, features);
      return bodyOf(req).then((body) => {
        writes.push({ path: "/features", method: req.method, body, token: req.headers["x-dsh-mneme-token"] });
        for (const [key, value] of Object.entries(body)) {
          features.overrides[key] = value;
          features.effective[key] = value;
        }
        reply(res, 200, { ok: true, effective: features.effective, overrides: features.overrides });
      });
    },
    "/api/dsh-mneme/mode": (req, res) => {
      if (req.method === "GET") return reply(res, 200, { mode: "standard" });
      return bodyOf(req).then(() => reply(res, 200, { mode: "standard" }));
    },
    "/api/dsh-mneme/rules": (req, res) => {
      if (req.method === "GET") return reply(res, 200, { rules: state.rules });
      return bodyOf(req).then((body) => {
        writes.push({ path: "/rules", method: req.method, body });
        state.rules = body.rules;
        reply(res, 200, { rules: state.rules });
      });
    },
    "/api/dsh-mneme/profile": (req, res) => {
      if (req.method === "GET") return reply(res, 200, { profile: "" });
      return bodyOf(req).then(() => reply(res, 200, { profile: "" }));
    },
    "/api/dsh-mneme/persona": (req, res) => reply(res, 200, { persona: {}, preview: { text: "" } }),
    "/api/dsh-mneme/commands": (req, res) => reply(res, 200, { commands: [] }),
    "/api/dsh-mneme/vector-config": (req, res) =>
      reply(res, 200, { config: { enabled: false, baseUrl: "", model: "", apiKey: "" } }),
    "/api/dsh-mneme/vector-reindex": (req, res) => reply(res, 200, { indexed: 1, skipped: 0 }),
    "/api/dsh-mneme/external-api": (req, res) => {
      if (req.method === "GET") {
        const url = new URL(req.url, "http://x");
        reads.push({ path: "/external-api", omit: url.searchParams.get("token") === "omit" });
        // 真实路由不带 omit 时会顺手 materialize 一个 Bearer；这里照实模拟。
        const token = url.searchParams.get("token") === "omit" ? "" : "materialized-bearer";
        return reply(res, 200, { config: { ...external, token } });
      }
      return bodyOf(req).then((body) => {
        writes.push({ path: "/external-api", method: req.method, body });
        Object.assign(external, body);
        reply(res, 200, { config: { ...external } });
      });
    },
    "/api/dsh-mneme/version-check": (req, res) => reply(res, 200, { version: "0.10.1", status: "latest" }),
    "/api/dsh-mneme/create": (req, res) =>
      bodyOf(req).then((body) => {
        writes.push({ path: "/create", method: req.method, body });
        reply(res, 201, { id: "m3", ...body, updated_at: "2026-11-03T00:00:00.000Z" });
      }),
    "/api/dsh-mneme/update": (req, res) =>
      bodyOf(req).then((body) => {
        writes.push({ path: "/update", method: req.method, body, token: req.headers["x-dsh-mneme-token"] });
        const memo = memories.find((row) => row.id === body.id);
        if (memo === undefined) return reply(res, 404, { error: "not-found" });
        Object.assign(memo, body, { updated_at: "2026-11-04T00:00:00.000Z" });
        reply(res, 200, { ok: true, memory: memo });
      }),
    "/api/dsh-mneme/profile-facts": (req, res) => {
      const url = new URL(req.url, "http://x");
      reads.push({ path: "/profile-facts" });
      const agent = url.searchParams.get("agent") ?? "";
      reply(res, 200, {
        cards: ["", "agent-a"],
        agent,
        facts: facts.items.filter((row) => row.agent_key === agent),
        journal: [],
        runs: facts.runs,
      });
    },
    "/api/dsh-mneme/profile-facts/apply": (req, res) =>
      bodyOf(req).then((body) => {
        writes.push({ path: "/profile-facts/apply", method: req.method, body });
        const applied = (body.ops ?? []).length;
        for (const op of body.ops ?? []) {
          if (op.op === "add") {
            facts.items.push({
              id: `f${facts.items.length + 1}`,
              agent_key: body.agent ?? "",
              content: op.content,
              status: "active",
              created_at: "2026-11-06T00:00:00.000Z",
              updated_at: "2026-11-06T00:00:00.000Z",
            });
          }
          if (op.op === "update") {
            const row = facts.items.find((item) => item.id === op.id);
            if (row !== undefined) row.content = op.content;
          }
          if (op.op === "archive") {
            const row = facts.items.find((item) => item.id === op.id);
            if (row !== undefined) row.status = "archived";
          }
        }
        reply(res, 200, { applied, failures: [], dupsSkipped: 0, facts: facts.items });
      }),
    "/api/dsh-mneme/profile-facts/run": (req, res) =>
      bodyOf(req).then((body) => {
        writes.push({ path: "/profile-facts/run", method: req.method, body });
        reply(res, 200, { status: "ok", opsApplied: 2, inputCount: 5 });
      }),
    "/api/dsh-mneme/choro/repos": (req, res) => reply(res, 200, { repos: [{ id: "r1", name: "mneme" }] }),
    "/api/dsh-mneme/choro/modules": (req, res) =>
      reply(res, 200, {
        repo: { id: "r1", name: "mneme", gitBaseline: "abc1234def" },
        modules: [{ slug: "src", title: "src", file_count: 12, page_status: "skeleton" }],
        edges: [],
      }),
    "/api/dsh-mneme/choro/page": (req, res) =>
      reply(res, 200, { page: { slug: "src", title: "src", content: "# src\n骨架正文" } }),
    "/api/dsh-mneme/choro/run": (req, res) =>
      bodyOf(req).then((body) => {
        writes.push({ path: "/choro/run", method: req.method, body });
        reply(res, 200, { ok: true, receipt: { pagesWritten: 3 } });
      }),
    "/api/dsh-mneme/delete": (req, res) =>
      bodyOf(req).then((body) => {
        writes.push({ path: "/delete", method: req.method, body });
        reply(res, 200, { ok: true });
      }),
  };

  return { memories, writes, reads, features, external, state, facts, routes };
}

function mount(world) {
  const webServer = {
    match(pathname) {
      const handler = world.routes[pathname];
      return handler === undefined ? undefined : { kind: "exact", path: pathname, handler };
    },
  };
  let def;
  const dshGo = {
    panel(id, definition) {
      assert.equal(id, "mneme");
      def = definition;
    },
  };
  resetPanelState();
  mountDshGoPanel({ get: (name) => (name === "webServer" ? webServer : undefined), dshGo }, { apiToken: TOKEN });
  return def;
}

const SCOPE_A = { sessionId: "s-a", turnId: "t-1", callId: "c-1" };
const SCOPE_B = { sessionId: "s-b", turnId: "t-1", callId: "c-2" };

async function payloadOf(def, scope = SCOPE_A) {
  const seen = [];
  const cancel = def.data(scope, (payload) => seen.push(payload));
  for (let i = 0; i < 40 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 10));
  cancel();
  return seen.at(-1);
}

const viewText = (def) => JSON.stringify(def.view(SCOPE_A));

test("删除按面板 scope 核对：别的面板打开的条目不会被误删", async () => {
  const world = makeWorld();
  const def = mount(world);

  await def.actions.open(SCOPE_A, { value: { id: "m1" } });
  await def.actions.open(SCOPE_B, { value: { id: "m2" } });

  // A 面板的确认落到 B 打开的那条上：必须拒绝，并且不发 /delete。
  const refused = await def.actions.delete(SCOPE_A, { value: { confirmed: true } });
  assert.equal(refused.toast, "这条不是当前打开的记忆，已取消");
  assert.equal(
    world.writes.filter((item) => item.path === "/delete").length,
    0,
  );

  // B 面板删自己那条：正常删除。
  await def.actions.delete(SCOPE_B, { value: { confirmed: true } });
  const deletes = world.writes.filter((item) => item.path === "/delete");
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0].body, { id: "m2" });
});

test("带点号的开关能连翻两次回到原值（state.flags 是扁平键）", async () => {
  const world = makeWorld();
  const def = mount(world);
  await payloadOf(def);

  const action = def.actions["flag.scopeState_enabled"];
  assert.equal(typeof action, "function");

  await action(SCOPE_A, { value: {} });
  assert.equal(world.features.effective["scopeState.enabled"], true);
  const first = world.writes.filter((item) => item.path === "/features").at(-1);
  assert.deepEqual(first.body, { "scopeState.enabled": true });
  // 进程内写请求必须带令牌，否则配了 apiToken 的宿主会 401（评审 #2）。
  assert.equal(first.token, TOKEN);

  await action(SCOPE_A, { value: {} });
  assert.equal(world.features.effective["scopeState.enabled"], false);
});

test("搜索仍然遵守类型筛选（/search 不带 type）", async () => {
  const world = makeWorld();
  const def = mount(world);

  await def.actions["type-filter"](SCOPE_A, { value: { value: "preference" } });
  await def.actions.search(SCOPE_A, { value: { query: "正文" } });
  const payload = await payloadOf(def);
  assert.equal(payload.rows.length, 1);
  assert.equal(payload.rows[0].title, "单位同行同字号");
});

test("实体搜索走宿主的名字过滤，而不是只过滤本地切片", async () => {
  const world = makeWorld();
  const def = mount(world);
  await def.actions["entity-search"](SCOPE_A, { value: { entityQuery: "bob" } });
  const payload = await payloadOf(def);
  assert.equal(payload.entities.length, 1);
  assert.equal(payload.entities[0].title, "Bob");
});

test("规则页提交非数组不会把已有规则清空", async () => {
  const world = makeWorld();
  const def = mount(world);
  await def.actions["open-profile"](SCOPE_A, { value: { k: "rules" } });

  const payload = await payloadOf(def);
  assert.ok(payload.editText.includes("已有一条规则"));

  await def.actions["profile-save"](SCOPE_A, { value: { editText: "{}" } });
  assert.equal(
    world.writes.filter((item) => item.path === "/rules").length,
    0,
  );
  assert.deepEqual(world.state.rules, [{ text: "已有一条规则" }]);
  const after = await payloadOf(def);
  assert.match(after.err, /JSON 数组/);
});

test("从状态视图进冲突页会把视图切回设置", async () => {
  const world = makeWorld();
  const def = mount(world);
  await def.actions["switch-settings-view"](SCOPE_A, { value: { value: "status" } });
  assert.ok(viewText(def).includes("库内一览"));

  await def.actions["open-conflict"](SCOPE_A, { value: {} });
  const view = viewText(def);
  assert.ok(view.includes("冲突队列"));
  assert.ok(!view.includes("库内一览"));
});

test("外部访问页读的是宿主已存配置，且用 token=omit 读", async () => {
  const world = makeWorld();
  const def = mount(world);
  await def.actions["open-panel"](SCOPE_A, { value: { k: "external" } });
  const payload = await payloadOf(def);

  assert.equal(payload.sExtPort, "8899");
  assert.equal(payload.sExtHost, "0.0.0.0");
  const read = world.reads.filter((item) => item.path === "/external-api").at(-1);
  assert.equal(read.omit, true);
});

test("保存只提交改过的字段", async () => {
  const world = makeWorld();
  const def = mount(world);
  await def.actions.open(SCOPE_A, { value: { id: "m1" } });
  await def.actions.edit(SCOPE_A, { value: {} });
  await def.actions.save(SCOPE_A, {
    value: { title: "面板改造 v2", content: "正文一", importance: 4, tags: "" },
  });

  const update = world.writes.filter((item) => item.path === "/update").at(-1);
  assert.deepEqual(Object.keys(update.body).sort(), ["id", "title"]);
  assert.equal(update.body.title, "面板改造 v2");
});

test("别处改过这条记忆时，保存不会覆盖对方", async () => {
  const world = makeWorld();
  const def = mount(world);
  await def.actions.open(SCOPE_A, { value: { id: "m1" } });
  await def.actions.edit(SCOPE_A, { value: {} });

  world.memories[0].updated_at = "2026-11-05T00:00:00.000Z";
  world.memories[0].content = "别处写入的新正文";

  await def.actions.save(SCOPE_A, {
    value: { title: "面板改造 v2", content: "正文一", importance: 4, tags: "" },
  });

  assert.equal(
    world.writes.filter((item) => item.path === "/update").length,
    0,
  );
  const payload = await payloadOf(def);
  assert.match(payload.err, /刚在别处被改过/);
});

test("重建索引的慢活带自己的超时，不沿用 5 秒默认值", async () => {
  const world = makeWorld();
  const def = mount(world);
  const result = await def.actions["vector-reindex"](SCOPE_A, { value: {} });
  assert.equal(result.pending.timeoutMs, 60000);
  assert.deepEqual(await result.result(), {});
});

test("新面板挂起来之后就有数据，且指标卡带单位", async () => {
  const world = makeWorld();
  const def = mount(world);
  const payload = await payloadOf(def);
  assert.equal(payload.totalText, "2 条");
  assert.equal(payload.slotRateText, "75%");
  assert.equal(payload.statusKv.find((row) => row.label === "记忆").value, "2 条");
});

test("翻页 chips：next 进第二页、prev 回来、第一页再 prev 不动", async () => {
  const world = makeWorld();
  const offsets = [];
  // 只有两条记忆，凑不出第二页：这里让 /list 报 57 条，并记下每次的 offset。
  world.routes["/api/dsh-mneme/list"] = (req, res) => {
    const url = new URL(req.url, "http://x");
    const offset = Number(url.searchParams.get("offset") ?? 0);
    // 状态页也会打 /list（limit=1 / limit=200）做统计，这里只认列表页那一次。
    if (Number(url.searchParams.get("limit") ?? 20) === 20) offsets.push(offset);
    reply(res, 200, { items: world.memories.slice(0, 2), total: 57 });
  };
  const def = mount(world);

  const first = await payloadOf(def);
  assert.equal(first.pageText, "57 条 · 1/3 页");
  // 绑定清空，选中的那枚胶囊不会一直带着勾。
  assert.equal(first.pagePick, "");

  await def.actions.page(SCOPE_A, { value: "next" });
  const second = await payloadOf(def);
  assert.equal(offsets.at(-1), 20);
  assert.equal(second.pageText, "57 条 · 2/3 页");

  await def.actions.page(SCOPE_A, { value: "prev" });
  const back = await payloadOf(def);
  assert.equal(offsets.at(-1), 0);
  assert.equal(back.pageText, "57 条 · 1/3 页");

  // 第一页再往前：夹在 1，不会变成负 offset。
  await def.actions.page(SCOPE_A, { value: "prev" });
  await payloadOf(def);
  assert.equal(offsets.at(-1), 0);
});

test("实体页空库用一行文案说，不再插空状态块", async () => {
  const world = makeWorld();
  world.routes["/api/dsh-mneme/entities"] = (req, res) => reply(res, 200, { entities: [], total: 0 });
  const def = mount(world);
  const payload = await payloadOf(def);
  assert.match(payload.entityStatus, /还没有实体/);
  assert.match(payload.entityStatus, /抽取人物与项目/);
});

// ---- 0.11.0 的新面板面：动态旗标、枚举档位、事实卡、地志 ----------------

test("「其它」组列出上游新增的布尔旗标，点一行就能翻转", async () => {
  const world = makeWorld();
  // 一个我们没给中文名的布尔项 + 一个数值项：只有布尔项该出现在「其它」里。
  world.features.effective.entityRecallEnabled = false;
  world.features.effective.maxInjectedItems = 4;
  const def = mount(world);

  const payload = await payloadOf(def);
  const titles = payload.extraRows.map((row) => row.title);
  assert.deepEqual(titles, ["entityRecallEnabled"]);
  assert.match(payload.extraRows[0].subtitle, /已关闭/u);

  await def.actions["flag-set"](SCOPE_A, { value: { key: "entityRecallEnabled" } });
  const write = world.writes.find((item) => item.path === "/features");
  assert.deepEqual(write.body, { entityRecallEnabled: true });
  assert.equal(write.token, TOKEN);
});

test("枚举旗标按字符串写入：地志注入档位 light/full/off", async () => {
  const world = makeWorld();
  world.features.effective.chorographyInject = "light";
  const def = mount(world);

  await def.actions["flag.chorographyInject"](SCOPE_A, { value: "full" });
  const write = world.writes.find((item) => item.path === "/features");
  assert.deepEqual(write.body, { chorographyInject: "full" });
});

test("事实卡：列出、逐条改、归档都走同一个 apply 入口", async () => {
  const world = makeWorld();
  const def = mount(world);

  await def.actions["open-panel"](SCOPE_A, { value: { k: "facts" } });
  const payload = await payloadOf(def);
  assert.equal(payload.factsRows.length, 1);
  assert.match(payload.factsRows[0].title, /喜欢简洁/u);
  assert.deepEqual(payload.factsCardOptions.map((item) => item.value), ["", "agent-a"]);

  await def.actions["facts-add"](SCOPE_A, { value: { sFactNew: "用中文回答" } });
  const added = world.writes.find((item) => item.path === "/profile-facts/apply");
  assert.deepEqual(added.body, { agent: "", ops: [{ op: "add", content: "用中文回答" }] });

  await def.actions["facts-edit"](SCOPE_A, { value: { id: "f1" } });
  await def.actions["facts-save"](SCOPE_A, { value: { sFactEdit: "喜欢简短回复" } });
  const updated = world.writes.filter((item) => item.path === "/profile-facts/apply").at(-1);
  assert.deepEqual(updated.body.ops, [{ op: "update", id: "f1", content: "喜欢简短回复" }]);

  // 归档要确认；没确认不发请求。
  const before = world.writes.length;
  await def.actions["facts-archive"](SCOPE_A, { value: {} });
  assert.equal(world.writes.length, before);
  await def.actions["facts-edit"](SCOPE_A, { value: { id: "f1" } });
  await def.actions["facts-archive"](SCOPE_A, { value: { confirmed: true } });
  const archived = world.writes.filter((item) => item.path === "/profile-facts/apply").at(-1);
  assert.deepEqual(archived.body.ops, [{ op: "archive", id: "f1" }]);
});

test("事实维护轮是 pending 任务：最长 60 秒，结束后给一句人话", async () => {
  const world = makeWorld();
  const def = mount(world);
  await def.actions["open-panel"](SCOPE_A, { value: { k: "facts" } });

  const effect = await def.actions["facts-run"](SCOPE_A, {});
  assert.equal(effect.pending.timeoutMs, 60000);
  const result = await effect.result();
  assert.equal(result.toast, "事实已更新");
  const run = world.writes.find((item) => item.path === "/profile-facts/run");
  assert.deepEqual(run.body, { agent: "" });
});

test("地志：重建骨架要先确认，模块页能读出来", async () => {
  const world = makeWorld();
  const def = mount(world);
  await def.actions["open-panel"](SCOPE_A, { value: { k: "choro" } });

  const payload = await payloadOf(def);
  assert.deepEqual(payload.choroRepoOptions, [{ label: "mneme", value: "r1" }]);
  assert.equal(payload.choroRows[0].title, "src");
  assert.match(payload.choroNote, /1 个模块/u);

  const before = world.writes.length;
  await def.actions["choro-run"](SCOPE_A, { value: {} });
  assert.equal(world.writes.length, before, "没确认就重建了骨架");

  const effect = await def.actions["choro-run"](SCOPE_A, { value: { confirmed: true } });
  assert.equal(effect.pending.timeoutMs, 60000);
  await effect.result();
  const run = world.writes.find((item) => item.path === "/choro/run");
  assert.deepEqual(run.body, { repo: "r1" });

  await def.actions["choro-page"](SCOPE_A, { value: { slug: "src" } });
  const after = await payloadOf(def);
  assert.match(after.choroPageText, /骨架正文/u);
});

test("翻开关不重画视图：只推数据，别把用户从设置页弹回记忆页", async () => {
  const world = makeWorld();
  const def = mount(world);

  // 值类动作：不申请 refresh（App 收到 refresh 会重建视图树，页签选择跟着丢失）。
  const flipped = await def.actions["flag.heatEnabled"](SCOPE_A, { value: true });
  assert.equal(flipped.refresh, false, "翻开关不该触发视图重建");
  const after = await payloadOf(def);
  assert.equal(after.flags.heatEnabled, true, "绑定值要跟着推过去");

  const enumed = await def.actions["flag.chorographyInject"](SCOPE_A, { value: "full" });
  assert.equal(enumed.refresh, false);
  assert.equal((await payloadOf(def)).flags.chorographyInject, "full");

  // 结构类动作仍然要重画：进子页、换分区都靠它。
  const opened = await def.actions["open-panel"](SCOPE_A, { value: { k: "facts" } });
  assert.equal(opened.refresh, true, "进子页需要重建视图");
});

// ---- 评审复审补的两个洞：跨面板归档、按 id 回读、局部加载 ----------------

test("归档按面板 scope 核对：别的面板打开的条目不会被归档", async () => {
  const world = makeWorld();
  const def = mount(world);
  await def.actions.open(SCOPE_A, { value: { id: "m1" } });
  await def.actions.open(SCOPE_B, { value: { id: "m2" } });

  // A 面板的归档落到 B 打开的那条上：必须拒绝，并且不发 /update。
  const refused = await def.actions.archive(SCOPE_A, { value: {} });
  assert.equal(refused.toast, "这条不是当前打开的记忆，已取消");
  assert.equal(
    world.writes.filter((item) => item.path === "/update").length,
    0,
  );

  await def.actions.archive(SCOPE_B, { value: {} });
  const write = world.writes.filter((item) => item.path === "/update").at(-1);
  assert.deepEqual(write.body, { id: "m2", archived: true });
});

test("打开记忆按 id 回读单条，不再扫 500 条列表", async () => {
  const world = makeWorld();
  const def = mount(world);
  await def.actions.open(SCOPE_A, { value: { id: "m2" } });

  const listReads = world.reads.filter((item) => item.path === "/list");
  assert.ok(
    listReads.some((item) => item.url.includes("id=m2")),
    "打开时没有按 id 向宿主要最新值",
  );
  assert.ok(
    !listReads.some((item) => item.url.includes("limit=500")),
    "仍在扫 500 条列表再拿缓存兜底",
  );
});

test("冲突后按最新记忆重建比对基准，第二次保存仍做版本检查", async () => {
  const world = makeWorld();
  const def = mount(world);
  await def.actions.open(SCOPE_A, { value: { id: "m1" } });
  await def.actions.edit(SCOPE_A, { value: {} });

  world.memories[0].updated_at = "2026-11-05T00:00:00.000Z";
  world.memories[0].content = "别处写入的新正文";

  await def.actions.save(SCOPE_A, {
    value: { title: "面板改造 v2", content: "正文一", importance: 4, tags: "" },
  });
  assert.equal(
    world.writes.filter((item) => item.path === "/update").length,
    0,
    "冲突时不该提交",
  );

  // 冲突后表单已换成最新内容；用户只改了标题，再保存只应提交标题。
  await def.actions.save(SCOPE_A, {
    value: { title: "面板改造 v2", content: "别处写入的新正文", importance: 4, tags: "" },
  });
  const update = world.writes.filter((item) => item.path === "/update").at(-1);
  assert.deepEqual(Object.keys(update.body).sort(), ["id", "title"]);
});

test("列表页的动作只重读列表，不再顺手读实体与设置", async () => {
  const world = makeWorld();
  const def = mount(world);
  await payloadOf(def);

  const seen = [];
  for (const path of [
    "/api/dsh-mneme/entities",
    "/api/dsh-mneme/features",
    "/api/dsh-mneme/dream-status",
  ]) {
    const original = world.routes[path];
    world.routes[path] = (req, res, ...rest) => {
      seen.push(path);
      return original(req, res, ...rest);
    };
  }

  await def.actions.page(SCOPE_A, { value: { value: "next" } });
  assert.deepEqual(seen, [], "列表动作把实体 / 设置 / 状态也重读了一遍");
});

test("pending 动作等活干完再推数据，不推这一轮之前的旧列表", async () => {
  const world = makeWorld();
  const def = mount(world);
  await def.actions["open-panel"](SCOPE_A, { value: { k: "facts" } });

  // 挂一个活着的 emitter，否则 broadcast() 会因为没人听而直接返回。
  const seen = [];
  const cancel = def.data(SCOPE_A, (payload) => seen.push(payload));
  for (let i = 0; i < 40 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  const before = world.reads.filter((item) => item.path === "/profile-facts").length;

  const effect = await def.actions["facts-run"](SCOPE_A, {});
  assert.equal(
    world.reads.filter((item) => item.path === "/profile-facts").length,
    before,
    "任务还没跑完就推了旧数据",
  );

  await effect.result();
  assert.equal(
    world.reads.filter((item) => item.path === "/profile-facts").length,
    before + 1,
    "任务跑完后没有重新推数据",
  );
  cancel();
});
