import test from "node:test";
import assert from "node:assert/strict";
import { STR } from "../src/lang.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createDreamScheduler } from "../src/dream.js";

// 防谄媚的**提示词侧**回归锁。
//
// 背景：#380 的注入前判定（pre-inject-gate）只拦「已落库的意见/立场」，而落到库里
// 之前的两个写作环节——蒸馏（summary / codingSummary）与总览叙述（dreamSummary）
// ——此前对谄媚内容一字未提。这两个环节写出的内容**完全不过** writeAdmission
// （write-admission.js 只在带 sessionKey 的 memory_save 路径生效），所以提示词是
// 唯一能施加约束的地方，本轮把「立场纪律 / 叙述纪律」写进字面量（Issue #530）。
//
// 这些用例锁的是**形状**（提示词里有没有这条约束、位置对不对），锁不了**行为**
// （模型是否真的照做）——后者要 LLM 在环 + 预注册判据，属 E12 那类实验，不在单测里
// 宣称。PR 与 CHANGELOG 不得把本文件写成「已知降低谄媚率」。

const LANGS = ["zh", "en"];

// 五组判据在两种语言里的对应词。写成「中英成对」是刻意的：少一种语言就等于
// 换语言的用户拿到一份没有防线的提示词（同 lang.test.js 对 profileExtract 的锁法）。
const STANCE_PATTERNS = [
  [/立场纪律|Stance discipline/, "立场纪律小节本身"],
  [/不要记录对用户本人|Never record evaluations of the user/, "规则 a：不记对用户本人的性格/能力/情绪评价"],
  [/可信度不同|differ in trustworthiness/, "规则 b：转录三种角色可信度不同"],
  [/以用户陈述为准|the user statement wins/, "规则 c：用户陈述压过助手推断"],
  [/不是提高 importance 的理由|never a reason to raise it/, "规则 d：赞许不抬 importance"],
];

for (const key of ["summary", "codingSummary"]) {
  test(`${key} 提示词带完整立场纪律（中英成对）`, () => {
    for (const lang of LANGS) {
      const text = STR.prompts[key][lang];
      for (const [re, label] of STANCE_PATTERNS) {
        assert.match(text, re, `${key}.${lang} 缺少${label}`);
      }
    }
  });
}

test("立场纪律排在任何 JSON 输出形状之前，不会被后置的时间锚点覆盖", () => {
  // summarize.js 在提示词**之后**再拼 STR.distillTimeAnchor（「据此换算 occurred_at」）。
  // 规则若排在那句之后，就成了「先按时间换算、再谈记什么」——指令优先级反了。
  // 同时它必须排在 schema 行之前：schema 是输出形状，纪律是内容判据，形状压不住判据。
  for (const key of ["summary", "codingSummary"]) {
    for (const lang of LANGS) {
      const text = STR.prompts[key][lang];
      const stance = text.search(/立场纪律|Stance discipline/);
      assert.ok(stance > 0, `${key}.${lang}: 立场纪律必须存在于提示词字面量内部`);
      assert.ok(stance < text.search(/occurred_at|occurred_at/), `${key}.${lang}: 立场纪律必须在 occurred_at 说明之前`);
      assert.ok(stance < text.search(/只输出 JSON 数组|Output only a JSON array/), `${key}.${lang}: 立场纪律必须在输出形状之前`);
      assert.ok(text.indexOf("立场纪律") < 0 || stance > text.indexOf("原子记忆原则") - 1,
        `${key}.${lang}: 立场纪律要跟在原子记忆原则之后，别抢掉开头角色句`);
    }
  }
});

test("工具/报错结论的豁免条款必须在场（删掉它会误杀 pitfall 与 constraint）", () => {
  // 规则 b 说「助手的结论是推断」，但编码类记忆（pitfall / rejected_solution /
  // constraint）的内容本来就是工具输出与报错直接给出的技术结论。没有这半句豁免，
  // 规则 b 会把整个编码回溯功能一并否掉——这是最容易被后人顺手删掉的高危句。
  for (const lang of LANGS) {
    const text = STR.prompts.summary[lang];
    assert.match(text, /工具输出、报错、命令结果|tool output, errors or command results/,
      `summary.${lang}: 工具结论豁免条款缺失，规则 b 会误杀 pitfall/constraint`);
  }
});

test("dreamSummary 带叙述纪律，且散文契约不被破坏", () => {
  for (const lang of LANGS) {
    const text = STR.prompts.dreamSummary[lang];
    assert.match(text, /叙述纪律|Narrative discipline/, `dreamSummary.${lang}: 缺叙述纪律`);
    assert.match(text, /不要给用户添上|add no characterisation/, `dreamSummary.${lang}: 缺「不给用户添性格评价」`);
    // 总览是**散文**契约：dream-fence 那条锁要求这里绝不能出现「JSON 数组」，
    // 否则模型会按数组契约回 `[]`，而 summaryText.trim() 判非空通过，`[]` 就
    // 被当成摘要存进库（dream.js:326-328 的注释记着这次评审实测）。
    assert.doesNotMatch(text, /JSON 数组|JSON array/, `dreamSummary.${lang}: 散文契约里不得出现 JSON 数组`);
    // 硬输出格式锁必须留在末尾，它是「只回叙述文本」的唯一保证。
    assert.match(lang === "zh" ? text : text, /只输出叙述文本，不要其他内容。|Output only the narrative text, nothing else./,
      `dreamSummary.${lang}: 末尾输出格式锁丢了`);
  }
});

// 下面这条是**输出侧**的接线锁：提示词改了，落库判据不能跟着变。
// 空字符串仍必须判为「没有摘要」（degraded/noop），不能被新文案带成「存了个空叙述」。
test("总览落库判据不因提示词改动而放宽", async () => {
  function mockCtx({ summaryText }) {
    return {
      logger: { warn: () => {} },
      agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock-model" }) },
      llm: {
        async *stream(options) {
          const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
          if (userText.includes("| type=")) {
            yield { type: "block-start", index: 0, blockType: "text" };
            yield { type: "text-delta", index: 0, text: "[]" };
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

  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const dream = createDreamScheduler({ onRun: () => Promise.resolve({ ok: true, skipped: true }) });
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文", importance: 3 });

  const ok = await dream.runDream(mockCtx({ summaryText: "记忆库总览：用户偏好中文。" }), service, {});
  assert.equal(ok.summary, true, "非空叙述照常落库");
  const row = service.all().find((m) => m.type === "summary");
  assert.ok(row, "总览行必须存在");
  assert.equal(row.source, "dream");
  assert.equal(row.importance, 5, "总览行的 importance 固定 5（最高注入档）");

  const empty = await dream.runDream(mockCtx({ summaryText: "" }), service, {});
  assert.equal(empty.summary, false, "空叙述不得落库");
  const rows = service.all().filter((m) => m.type === "summary");
  assert.equal(rows.length, 1, "旧总览存活，没有被空叙述覆盖");
  store.close();
});
