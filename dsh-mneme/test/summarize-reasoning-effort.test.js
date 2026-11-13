// Regression for issue #315: the distill (summarize) LLM call gets a reasoning
// effort knob, mirroring the entity-extraction shape (issue #109) and reusing
// the dream/sleep fallback machinery. Pins:
//  - explicit effort is forwarded on the distill stream call;
//  - default 'none' omits the field entirely (current behavior unchanged);
//  - a stream-level effort rejection (error finish chunk, the rc.1 shape that
//    never reaches catch) is retried once WITHOUT the field;
//  - non-effort stream failures are NOT retried (no blind double calls) and
//    the aborted window stays retryable (cursor not consumed);
//  - 'off' works like any explicit effort (rejected → retried without it).
// Mock shapes (ctx.on subscription capture, {delta} text chunks, finish
// {reason:{kind,failure}}) follow the existing summarize.test.js conventions.
import test from "node:test";
import assert from "node:assert/strict";
import { createSummarizer } from "../src/summarize.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { testConfig } from "./helpers/test-config.js";

const ENTRIES_JSON = JSON.stringify([
  { type: "decision", title: "选型", content: "确定用 node:sqlite", importance: 4 }
]);

function userMessage(text, seq) {
  return {
    seq,
    type: "user/message",
    data: { source: { kind: "user" }, content: [{ type: "text", text }] }
  };
}

function setup(configOver = {}, stream) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const calls = [];
  const events = [];
  const ctx = {
    on(name, fn) {
      events.push({ name, fn });
      return () => {};
    },
    llm: {
      stream(options) {
        calls.push(options);
        return stream(options);
      }
    }
  };
  const config = { autoSummarize: true, distillRateLimitIntervalMs: 0, ...configOver };
  createSummarizer(ctx, service, config, {});
  const handler = events.find((e) => e.name === "session/event").fn;
  const session = {
    id: "s315",
    requestHeader: () => ({ config: testConfig({ provider: "deepseek", model: "deepseek-chat" }) }),
    events: [userMessage("帮我选型", 1), { seq: 2, type: "turn/end" }]
  };
  return { store, service, calls, handler, session };
}

test("issue#315: explicit summarizeReasoningEffort is forwarded on the distill call", async () => {
  const { store, calls, handler, session } = setup(
    { summarizeReasoningEffort: "low" },
    () => (async function* () {
      yield { type: "text-delta", delta: ENTRIES_JSON };
      yield { type: "finish", kind: "ok" };
    })()
  );
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reasoningEffort, "low", "the configured effort rides the distill call");
  store.close();
});

test("issue#315: default 'none' omits the reasoningEffort field entirely", async () => {
  const { store, calls, handler, session } = setup(
    {},
    () => (async function* () {
      yield { type: "text-delta", delta: ENTRIES_JSON };
      yield { type: "finish", kind: "ok" };
    })()
  );
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1);
  assert.equal("reasoningEffort" in calls[0], false, "unset/'none' must not add the field");
  assert.equal(store.count(), 1, "entries still stored as before");
  store.close();
});

test("issue#315: stream-level effort rejection retries once without the field", async () => {
  const { store, calls, handler, session } = setup(
    { summarizeReasoningEffort: "low" },
    (options) => (async function* () {
      if (options.reasoningEffort) {
        // rc.1 shape: the provider rejection arrives as a terminal error finish
        // chunk (adapterStream never throws), so the retry must be triggered
        // from the chunk path, not a catch block.
        yield {
          type: "finish",
          reason: {
            kind: "error",
            failure: {
              code: "UNSUPPORTED_REASONING_EFFORT",
              message: 'provider "deepseek" model "deepseek-chat" does not support reasoning effort "low"'
            }
          }
        };
        return;
      }
      yield { type: "text-delta", delta: ENTRIES_JSON };
      yield { type: "finish", kind: "ok" };
    })()
  );
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 2, "exactly one no-effort retry");
  assert.equal(calls[0].reasoningEffort, "low", "first attempt forwards the effort");
  assert.equal("reasoningEffort" in calls[1], false, "retry omits the rejected effort field");
  assert.equal(store.count(), 1, "the retried run still stores its entry");
  store.close();
});

test("issue#315: non-effort stream failures are not retried and stay abortable", async () => {
  const { store, calls, handler, session } = setup(
    { summarizeReasoningEffort: "low" },
    () => (async function* () {
      yield { type: "finish", reason: { kind: "error", failure: { code: "PROVIDER_GONE", message: "provider deepseek is not registered" } } };
    })()
  );
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1, "no blind retry when the stream failure is not an effort rejection");
  assert.equal(store.count(), 0, "failed window stores nothing");
  store.close();
});

test("issue#315: off works like any explicit effort (rejected → retried without it)", async () => {
  const { store, calls, handler, session } = setup(
    { summarizeReasoningEffort: "off" },
    (options) => (async function* () {
      if (options.reasoningEffort) {
        yield { type: "finish", reason: { kind: "error", failure: { code: "UNSUPPORTED_REASONING_EFFORT", message: 'reasoning effort "off" is not supported here' } } };
        return;
      }
      yield { type: "text-delta", delta: ENTRIES_JSON };
      yield { type: "finish", kind: "ok" };
    })()
  );
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].reasoningEffort, "off");
  assert.equal(store.count(), 1);
  store.close();
});

test("issue#315: successful effort-fallback retry records audit as success, not the first failure", async () => {
  const { store, service, calls, handler, session } = setup(
    { summarizeReasoningEffort: "low" },
    (options) => (async function* () {
      if (options.reasoningEffort) {
        // first attempt is rejected (effort unsupported)…
        yield { type: "finish", reason: { kind: "error", failure: { code: "UNSUPPORTED_REASONING_EFFORT", message: 'reasoning effort "low" rejected' } } };
        return;
      }
      // …but the no-effort retry succeeds.
      yield { type: "text-delta", delta: ENTRIES_JSON };
      yield { type: "finish", kind: "ok" };
    })()
  );
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 2, "effort rejection + one retry");
  const rows = service.listLlmAudits();
  const summarize = rows.find((r) => r.operation_type === "summarize_compress");
  assert.ok(summarize, "summarize audit row present");
  assert.equal(summarize.status, "success",
    "the retried run must record success, not the first attempt's error status");
  store.close();
});

test("issue#315: abort is not misread as an effort rejection even when the message matches the pattern", async () => {
  const { store, calls, handler, session } = setup(
    { summarizeReasoningEffort: "low" },
    () => (async function* () {
      // The message matches EFFORT_REJECT_RE on purpose: without the AbortError
      // guard in withEffortFallback this would be misread as an effort rejection
      // and trigger a wasteful no-effort retry.
      throw Object.assign(new Error("aborted by dispose: UNSUPPORTED_REASONING_EFFORT"), { name: "AbortError" });
    })()
  );
  await handler(session, { seq: 2, type: "turn/end" });
  assert.equal(calls.length, 1, "abort must not trigger a no-effort fallback retry");
  store.close();
});
