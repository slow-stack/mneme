import test from "node:test";
import assert from "node:assert/strict";
import { Config } from "../src/config.js";
import { createSessionGate } from "../src/session-gate.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createInjector } from "../src/inject.js";
import { MEMORY_GUIDE_SECTION } from "../src/guide.js";
import { createTools } from "../src/tools.js";
import { createSummarizer } from "../src/summarize.js";

test("session gate defaults off and recognizes current and compatibility header shapes", () => {
  const defaults = Config({});
  assert.equal(defaults.sessionGateEnabled, false);
  assert.equal(defaults.sessionGateSubagents, true);
  assert.deepEqual(defaults.sessionGateSessions, []);

  const gate = createSessionGate({ sessionGateEnabled: true, sessionGateSubagents: true });
  const sessions = [
    { id: "header-parent", header: { parentSession: "captain", origin: "subagent", delegationDepth: 1 } },
    { id: "header-origin", header: { origin: "subagent" } },
    { id: "header-depth", header: { delegationDepth: 2 } },
    { id: "session-parent", parentSession: "captain" },
    { id: "alias-parent", parentSessionId: "captain" },
    { id: "request-parent", requestHeader: () => ({ config: { parentSession: "captain" } }) },
    { id: "request-origin", requestHeader: () => ({ config: { origin: "subagent", delegationDepth: 1 } }) }
  ];
  for (const session of sessions) {
    assert.equal(gate.isOff(session), true, session.id);
  }

  const firstEvent = { id: "first-event", header: { parentSession: "captain", origin: "subagent" } };
  assert.equal(gate.isOff(firstEvent), true, "header match works before any session/event was observed");
  gate.observe(firstEvent);
  assert.equal(gate.isOff("first-event"), true, "observed child ids remain recognizable in log scans");
});

test("manual ids survive the subagent switch, master-off is inert, and config is read live", () => {
  const cfg = { sessionGateEnabled: false, sessionGateSubagents: false, sessionGateSessions: ["manual"] };
  const gate = createSessionGate(cfg);
  const manual = { id: "manual" };
  const child = { id: "child", header: { parentSession: "captain" } };

  assert.equal(gate.isOff(manual), false, "the master is the only opt-in");
  cfg.sessionGateEnabled = true;
  assert.equal(gate.isOff(manual), true, "manual id matches even when automatic child detection is off");
  assert.equal(gate.isOff(child), false, "subagent switch independently controls automatic matching");
  cfg.sessionGateSubagents = true;
  assert.equal(gate.isOff(child), true, "the next call sees a live config change");
  cfg.sessionGateEnabled = false;
  assert.equal(gate.isOff(manual), false, "turning the master off restores normal behavior immediately");

  const inaccessible = {};
  Object.defineProperty(inaccessible, "id", { get() { throw new Error("host getter"); } });
  assert.doesNotThrow(() => gate.isOff(inaccessible));
});

function injectionSetup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文", importance: 5 });
  settings.setProfile("用户画像正文");
  settings.setRules(["先给结论"]);
  const contexts = [];
  const sections = [];
  const ctx = {
    systemPrompt: {
      context(definition) { contexts.push(definition); return () => {}; },
      section(definition) { sections.push(definition); return () => {}; }
    }
  };
  const gate = createSessionGate({
    sessionGateEnabled: true,
    sessionGateSubagents: true,
    sessionGateSessions: ["private"]
  });
  createInjector(ctx, service, settings, { injectGuidanceEnabled: true }, null, gate);
  return { store, contexts, sections, gate };
}

test("all system-prompt surfaces are empty for incognito and remain available to captain", () => {
  const { contexts, sections, gate } = injectionSetup();
  const memory = contexts.find((item) => item.name === "memory");
  const userSettings = contexts.find((item) => item.name === "user-settings");
  const guide = sections.find((item) => item.name === "memory-guide");
  const privateContext = { agent: { session: { id: "private" } } };
  const childContext = { agent: { session: { id: "worker", header: { parentSession: "captain", origin: "subagent" } } } };
  const captainContext = { agent: { session: { id: "captain", header: { origin: "main" } } } };

  assert.equal(memory.text(privateContext), "");
  assert.equal(userSettings.text(privateContext), "");
  assert.equal(guide.text(privateContext), "");
  assert.equal(memory.text(childContext), "");
  assert.equal(userSettings.text(childContext), "");
  assert.equal(guide.text(childContext), "");

  assert.match(memory.text(captainContext), /\[记忆库\]/);
  assert.match(userSettings.text(captainContext), /用户画像正文/);
  assert.equal(guide.text(captainContext), MEMORY_GUIDE_SECTION);
  gate.observe(childContext.agent.session);
  assert.equal(gate.isOff("worker"), true);
});

test("every registered memory tool rejects before side effects for an incognito session", async () => {
  const store = createStore(":memory:");
  const baseService = createService({ store, mirror: null, config: {} });
  let serviceCalls = 0;
  const service = new Proxy(baseService, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args) => {
        serviceCalls += 1;
        return value.apply(target, args);
      };
    }
  });
  const registered = [];
  const registry = { register(tool) { registered.push(tool); return () => {}; } };
  const gate = createSessionGate({ sessionGateEnabled: true, sessionGateSessions: ["private"] });
  createTools({ tools: registry }, service, {}, null, gate);
  const exec = { agent: { session: { id: "private" } } };

  assert.ok(registered.length >= 11);
  for (const tool of registered) {
    await assert.rejects(tool.execute({}, exec), /incognito session/, tool.name);
  }
  assert.equal(serviceCalls, 0, "rejected calls do not reach memory service reads or writes");
  assert.equal(store.count(), 0, "no memory rows were written through an executor");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM scope_state").get().n, 0, "set_scope_state also rejects before writing");

  const captainSave = registered.find((tool) => tool.name === "memory_save");
  const result = await captainSave.execute(
    { type: "preference", title: "captain", content: "可用", importance: 4 },
    { agent: { session: { id: "captain", header: { origin: "main" } } } }
  );
  assert.equal(result.action, "created", "normal captain tool use is unaffected");
  assert.equal(store.count(), 1);
  store.close();
});

test("retained tool executors use the latest gate after live registry reapply", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const registered = [];
  const registry = { register(tool) { registered.push(tool); return () => {}; } };
  const initialGate = createSessionGate({ sessionGateEnabled: true, sessionGateSessions: ["private"] });
  createTools({ tools: registry }, service, {}, null, initialGate);
  const retainedSave = registered.find((tool) => tool.name === "memory_save");
  const privateExec = { agent: { session: { id: "private" } } };
  const args = { type: "preference", title: "live gate", content: "check", importance: 4 };

  await assert.rejects(retainedSave.execute(args, privateExec), /incognito session/);
  const openGate = createSessionGate({ sessionGateEnabled: false });
  createTools({ tools: registry }, service, {}, null, openGate);
  assert.equal(registered.length, 11, "live reapply keeps the host's existing tool registrations");
  assert.equal((await retainedSave.execute(args, privateExec)).action, "created", "off restores the original tool behavior");
  const closedGate = createSessionGate({ sessionGateEnabled: true, sessionGateSessions: ["private"] });
  createTools({ tools: registry }, service, {}, null, closedGate);
  await assert.rejects(
    retainedSave.execute({ ...args, content: "blocked" }, privateExec),
    /incognito session/,
    "a retained tool uses the gate from the latest live reapply"
  );
  assert.equal(store.count(), 1, "the re-applied gate still runs before any write");
  store.close();
});

function summarySession(id, header = {}) {
  return {
    id,
    header,
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "选型" }] } },
      { type: "turn/end", seq: 2 }
    ]
  };
}

test("distillation skips incognito sessions before model or storage work", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const listeners = [];
  const calls = [];
  const ctx = {
    on(name, handler) { listeners.push({ name, handler }); return () => {}; },
    llm: {
      stream() {
        calls.push(true);
        const output = JSON.stringify([{ type: "decision", title: "选择", content: "落库", importance: 4 }]);
        return (async function* () {
          yield { type: "block-start", block: { type: "text" } };
          yield { type: "text-delta", delta: output };
          yield { type: "block-end", block: { type: "text" } };
          yield { type: "finish", kind: "ok" };
        })();
      }
    }
  };
  const gate = createSessionGate({ sessionGateEnabled: true, sessionGateSessions: ["private"] });
  const summarizer = createSummarizer(ctx, service, { autoSummarize: true, distillRateLimitIntervalMs: 0 }, {}, gate);
  const handler = listeners.find((item) => item.name === "session/event").handler;

  await handler(summarySession("private"), { type: "turn/end", seq: 2 });
  assert.equal(calls.length, 0);
  assert.equal(store.count(), 0);
  await handler(summarySession("captain", { origin: "main" }), { type: "turn/end", seq: 2 });
  assert.equal(calls.length, 1);
  assert.equal(store.count(), 1, "captain still distills normally");
  summarizer.dispose();
  store.close();
});
