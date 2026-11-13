// issue #692：「默认开」的开关在代码里用 `=== true` 读，而默认值只写在 zod schema
// （src/config.js）里。走宿主（index.js 先经 Config(config)）没问题，但绕过 Config 的
// 裸配置调用方拿到的是 undefined，于是「默认开」落不了地。
//
// 这里守的是读侧口径：`!== false`（与 autoInject / autoDream / hybridInject /
// heatEnabled / summarizeBatchCrossTypeDedupe 同一惯例），并各验一次显式关掉的反向
// 对照——否则「改成恒真」也会让默认开那半条通过。
//
// 第三处 `memoryQualityFilter.enabled` 已经翻过来了（#692 尾巴，见
// test/quality-filter.test.js 的两条锁与 `test/helpers/test-config.js` 的前提），
// 但它不归本文件：那处翻完会连带改变「裸配置调用方写的短正文会不会被归档」，
// 属于接口契约级别的变化，落点放在质量过滤自己的测试里更近，这里只留这句话当路标。
import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createDreamScheduler } from "../src/dream.js";
import { resilientDownloadEnabled } from "../src/semantic.js";

/** 裸配置：不经 Config，键缺失（= undefined），与第三方程序化调用同形。 */
function bareService(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service };
}

/**
 * audit.test.js 同款最小 ctx：consolidation 提示词以 "id=" 开头，summary 提示词
 * 以 "- title: content" 开头，用这个形状区分两次 LLM 调用。
 */
function mockCtx({ onConsolidation, summaryText = "记忆库总览：用户偏好中文。" } = {}) {
  return {
    logger: { warn: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock-model" }) },
    llm: {
      async *stream(options) {
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        if (userText.includes("| type=")) {
          yield { type: "block-start", index: 0, blockType: "text" };
          yield { type: "text-delta", index: 0, text: onConsolidation ? onConsolidation(userText) : "[]" };
          yield { type: "block-end", index: 0, block: { type: "text" } };
          yield { type: "finish", reason: { kind: "stop" } };
          return;
        }
        yield { type: "text-delta", index: 0, text: summaryText };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
}

/**
 * 一次 dream run，模型把两条 constraint 合并成一条。constraint 在
 * ARCHIVE_GUARDED_TYPES 里（src/dream/decisions.js:20），所以 mergeGuard 生效时
 * 这条决策必须被 skip 并写明理由。
 */
async function runGuardedMerge(config) {
  const { store, service } = bareService(config);
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  const { memory: a } = service.saveWithDedupe({ type: "constraint", title: "部署顺序", content: "先跑迁移再起服务。", importance: 4 });
  const { memory: b } = service.saveWithDedupe({ type: "constraint", title: "部署顺序（补）", content: "先跑迁移，再起服务，最后冒烟。", importance: 4 });
  const ctx = mockCtx({
    onConsolidation: () => JSON.stringify([
      { action: "merge", ids: [a.id, b.id], keepSource: b.id, title: "部署顺序", content: "先跑迁移，再起服务，最后冒烟。", importance: 4 }
    ])
  });
  const result = await dream.runDream(ctx, service, config);
  const run = store.listDreamRuns().at(-1);
  // skip 明细：整单被判无效时在 result.decisions[].skipped，落了半批时在 run.skipped_reasons。
  const errors = [
    ...(result.decisions ?? []).flatMap((d) => (d.skipped ?? []).map((s) => s.error ?? "")),
    ...(run.skipped_reasons ?? []).map((r) => r.error ?? "")
  ].join("\n");
  return { result, run, errors, store };
}

// ---------------------------------------------------- dreamMergeGuard（默认开）

test("#692 dreamMergeGuard: 裸配置下默认开，guarded 类型 merge 被 skip", async () => {
  const { result, errors } = await runGuardedMerge({});
  assert.equal(result.applied ?? 0, 0, "guarded merge 不该落库");
  assert.match(errors, /dreamMergeGuard/, "skip 理由要点名护栏");
  assert.match(errors, /constraint/, "skip 理由要点名被保护的类型");
});

test("#692 dreamMergeGuard: 显式 false 才放行（反向对照）", async () => {
  const { result, errors } = await runGuardedMerge({ dreamMergeGuard: false });
  assert.equal(result.ok, true);
  assert.equal(result.applied, 1, "显式关掉后同一条 merge 应当落库");
  assert.doesNotMatch(errors, /dreamMergeGuard/, "关掉后不该再出现护栏理由");
});

// ------------------------------------------------ resilientModelDownload（默认开）

test("#692 resilientModelDownload: 装配层判据在裸配置下为开，显式 false 才关", () => {
  assert.equal(resilientDownloadEnabled({}), true);
  assert.equal(resilientDownloadEnabled(undefined), true);
  assert.equal(resilientDownloadEnabled({ resilientModelDownload: true }), true);
  assert.equal(resilientDownloadEnabled({ resilientModelDownload: false }), false);
});