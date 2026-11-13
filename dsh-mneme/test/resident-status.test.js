// 常驻状态条（#164 对齐，PR-3）测试。
// 覆盖：总览即「唯一常驻叙述」——每次 dream 刷新走 _overwrite supersede
// （单行、content_history 可追溯）、内容带快照口径脚注（条数 + run 片段 +
// 日期）、summary tier 注入位不变。
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createDreamScheduler } from "../src/dream.js";
import { testConfig } from "./helpers/test-config.js";

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  return { store, service };
}

function mockCtx(sequence) {
  // sequence = 按流顺序的响应表：consolidation 调用给 {decisions}，summary
  // 调用给 {summary}，一次 runDream 消费两项。
  let calls = 0;
  return {
    llm: {
      stream: async function* () {
        const step = sequence[calls] ?? { summary: "空转叙述" };
        calls++;
        const text = step.decisions !== undefined ? JSON.stringify(step.decisions) : step.summary;
        yield { type: "text-delta", text };
        yield { type: "finish", reason: { kind: "ok" } };
      }
    },
    logger: { warn: () => {} }
  };
}

test("overview refresh carries the snapshot-scope footer", async () => {
  const { store, service } = setup();
  service.saveWithDedupe({ type: "project", title: "项目", content: "活跃中" });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(
    mockCtx([{ decisions: [] }, { summary: "当前在推进记忆插件，蒸馏管线已稳定。" }]),
    service,
    { dreamProvider: "deepseek", dreamModel: "deepseek-chat" }
  );
  assert.equal(result.ok, true);
  const summary = store.all().find((m) => m.type === "summary");
  assert.ok(summary, "resident bar created");
  assert.ok(summary.content.startsWith("当前在推进记忆插件"), "narrative body first");
  assert.match(summary.content, /〔口径：基于整理后 \d+ 条记忆快照 · run [0-9a-f]{8} · \d{4}-\d{2}-\d{2}〕/, "scope footer carries count/run/date");
  store.close();
});

test("second refresh supersedes in place: one row, overwrite traceable in content_history", async () => {
  const { store, service } = setup();
  service.saveWithDedupe({ type: "project", title: "项目", content: "活跃中" });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const ctx = mockCtx([
    { decisions: [] },
    { summary: "第一版状态叙述。" },
    { decisions: [] },
    { summary: "第二版状态叙述。" }
  ]);
  await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat" });
  await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat" });
  const summaries = store.all().filter((m) => m.type === "summary");
  assert.equal(summaries.length, 1, "exactly one resident bar (supersede, not append)");
  assert.ok(summaries[0].content.startsWith("第二版状态叙述。"), "latest narrative wins");
  assert.ok((summaries[0].content_history ?? []).length >= 1, "overwrite recorded in content_history");
  store.close();
});

test("resident bar rides the summary tier 0 injection slot", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ type: "summary", title: "记忆库总览", content: "当前状态叙述正文", importance: 5 });
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文", importance: 5 });
  // injectCandidates 的 summary=0 档位契约：总览排在普通记忆前
  const candidates = service.injectCandidates({ query: "", maxItems: 5 });
  const ids = candidates.map((c) => c.id);
  const summaryId = store.all().find((m) => m.type === "summary").id;
  const prefId = store.all().find((m) => m.type === "preference").id;
  assert.ok(ids.includes(summaryId), "resident bar in candidates");
  assert.ok(ids.indexOf(summaryId) < ids.indexOf(prefId), "resident bar ahead of normal memories");
  store.close();
});
