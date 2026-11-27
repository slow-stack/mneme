// Issue #791 可观测性回归：dream_runs.error 不许再把所有失败压成 "llm failed"。
//
// 背景（issue 正文里的那 48 轮）：流层其实早就拿到了原因——`describeStreamFailure`
// 从 finish chunk 的 `reason.failure {code, message}` 拼出 `CODE: message`，但它只
// 喂给 llm_audit_logs，dream_runs 那条路径写死字面量。运维从表里分不出「上下文超限」
// 「provider 没注册」「代理 422」——一个 terminal 422 被记成「模型偶发抽风」，
// 于是九天真就没人去查。
//
// 本文件锁四件事：
//   ① 只有 code / code+message 时，落库形态是 `llm failed: CODE` / `llm failed: CODE: message`；
//   ② 没有 failure 时逐字节保持 `llm failed`（既有面板、退避、LIKE 查询都按它判）；
//   ③ 返回值 `result.error` 仍是那个稳定短串——口径分离是本修法的前提，混了就是破坏面；
//   ④ 流失败但已经写了几条决策时，`applied` / `decisions` / `outcome` 一个都不许被挤掉。
import test from "node:test";
import assert from "node:assert/strict";
import { createDreamScheduler } from "../src/dream.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { testConfig } from "./helpers/test-config.js";

// ---------------------------------------------------------------- helpers

/**
 * 最小 ctx：巩固调用按 `| type=` 认出，然后按 `failure` 决定怎么失败。
 * `failure === undefined` 时正常返回 decisions JSON；否则流以 terminal error 收尾
 * （这正是 dsh-llm rc.1 把适配器失败转成 finish chunk 的形状，不是 throw）。
 */
function mockCtx({ failure, decisions } = {}) {
  return {
    logger: { warn: () => {}, info: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock-model" }) },
    llm: {
      async *stream(options) {
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        if (userText.includes("| type=")) {
          if (failure) {
            // 失败：一个 delta 都不给，直接 terminal error（streamText 返回 undefined）
            yield { type: "finish", reason: { kind: "error", failure } };
            return;
          }
          yield { type: "block-start", index: 0, blockType: "text" };
          yield { type: "text-delta", index: 0, text: decisions ?? "[]" };
          yield { type: "block-end", index: 0, block: { type: "text" } };
          yield { type: "finish", reason: { kind: "stop" } };
          return;
        }
        yield { type: "text-delta", index: 0, text: "记忆库总览：用户偏好中文。" };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
}

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  return { store, service, dream };
}

async function runWithFailure(failure) {
  const { store, service, dream } = setup();
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  const result = await dream.runDream(mockCtx({ failure }), service, {});
  const run = store.listDreamRuns()[0];
  store.close();
  return { result, run };
}

// ---------------------------------------------------------------- 落库形态

test("#791 只有 code：dream_runs.error 落 'llm failed: CODE'", async () => {
  const { result, run } = await runWithFailure({ code: "CONTEXT_WINDOW_EXCEEDED" });
  assert.equal(run.status, "failed");
  assert.equal(run.error, "llm failed: CONTEXT_WINDOW_EXCEEDED");
  // 返回值口径不变：面板与退避按这个短串判定
  assert.equal(result.error, "llm failed", "返回值 must stay the stable short string");
});

test("#791 code + message：落 'llm failed: CODE: message'，message 不重复 code", async () => {
  const { run } = await runWithFailure({
    code: "dsh_compaction_refused",
    message: "upstream proxy returned 422"
  });
  assert.equal(run.error, "llm failed: dsh_compaction_refused: upstream proxy returned 422");
});

test("#791 message 里已经含 code 时不重复拼（describeStreamFailure 的既有口径）", async () => {
  const { run } = await runWithFailure({
    code: "E_PROVIDER",
    message: "E_PROVIDER: no route registered for provider xdpool"
  });
  assert.equal(run.error, "llm failed: E_PROVIDER: no route registered for provider xdpool");
});

test("#791 没有 failure：逐字节保持 'llm failed'（改前行为）", async () => {
  // 空对象 = 适配器没给出任何原因。此时不能凭空造一个冒号出来。
  const { result, run } = await runWithFailure({});
  assert.equal(run.error, "llm failed");
  assert.equal(result.error, "llm failed");
});

// ---------------------------------------------------------------- 不挤掉已落盘的字段

test("#791 流失败但已写了几条决策：applied / decisions / outcome 都还在", async () => {
  // 现场形状：巩固成功后总览步骤失败（finish 在 :1830 那条分支）。新 error 串
  // 只该改 error 一列，绝不能顺手覆盖 decision 载荷。
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const { memory: m } = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });

  const ctx = mockCtx({ decisions: JSON.stringify([{ action: "keep", ids: [m.id] }]) });
  // 总览这一步抛错，走 finish(... failure: summaryStreamFailure || String(error))
  const originalStream = ctx.llm.stream;
  ctx.llm.stream = async function* (options) {
    const userText = options.messages.find((x) => x.role === "user")?.content?.[0]?.text ?? "";
    if (userText.includes("| type=")) {
      yield* originalStream.call(this, options);
      return;
    }
    throw new Error("summary boom");
  };

  const result = await dream.runDream(ctx, service, {});
  const run = store.listDreamRuns()[0];
  assert.equal(result.ok, false);
  assert.match(run.error, /^llm failed: summary boom$/, "总览失败的原因必须落库");
  assert.equal(run.decisions.length, 1, "decisions 不许被新 error 串挤掉");
  assert.equal(run.outcome.byId[m.id], "keep", "outcome 同样保留");
  assert.equal(run.applied, 0, "keep 不算 applied，口径不变");
  store.close();
});
