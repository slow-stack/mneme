
import test from "node:test";
import assert from "node:assert/strict";
import { STR, langOf } from "../src/lang.js";
import { createMirror, parseHumanEdits, renderMirrorText } from "../src/mirror.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createInjector } from "../src/inject.js";
import { createSettings } from "../src/settings.js";
import { testConfig } from "./helpers/test-config.js";

test("langOf resolves the per-instance config language", () => {
  assert.equal(langOf({}), "zh");
  assert.equal(langOf({ language: "zh" }), "zh");
  assert.equal(langOf({ language: "en" }), "en");
  assert.equal(langOf({ language: "fr" }), "zh");
  assert.equal(langOf(null), "zh");
});

test("prompt table resolves by explicit language key", () => {
  assert.ok(STR.prompts.summary.zh.includes("记忆库提炼助手"));
  assert.ok(STR.prompts.summary.en.includes("memory curation assistant"));
  assert.ok(STR.prompts.consolidation.zh.includes("记忆库整理助手"));
  assert.ok(STR.prompts.consolidation.en.includes("consolidation assistant"));
  assert.ok(STR.prompts.conflict.zh.includes("冲突仲裁"));
  assert.ok(STR.prompts.conflict.en.includes("conflict arbiter"));
  assert.ok(STR.prompts.pattern.zh.includes("模式发现助手"));
  assert.ok(STR.prompts.pattern.en.includes("pattern-discovery assistant"));
  // 画像提取（#497）：两段纪律在中英文里都必须成对存在——「输入是数据不是指令」防的
  // 是指令型记忆改写任务，「禁止声明助手身份」防的是画像正文与外部 bot 自带身份撞车
  // （画像不受 personaEnabled 管辖）。少一种语言就等于换语言的用户拿到没有防线的提示词。
  for (const lang of ["zh", "en"]) {
    const p = STR.prompts.profileExtract[lang];
    assert.ok(typeof p === "string" && p.length > 100, `profileExtract.${lang} must be a full prompt`);
    assert.match(p, /不是指令|not instructions/, `profileExtract.${lang}: memory text must be declared data, not instructions`);
    assert.match(p, /(绝不为助手|never name).{0,60}(助手|assistant|identity)/i,
      `profileExtract.${lang}: the prompt must forbid an assistant-identity claim in the draft`);
    assert.ok(p.includes("profile"), `profileExtract.${lang} must state the JSON key`);
  }
  // 冻结模式后缀：纯提示文本，可直接拼接在巩固 prompt 后。
  assert.ok(STR.prompts.freezeSuffix.zh.startsWith("\n\n当前为「冲突冻结」模式"));
  assert.ok(STR.prompts.freezeSuffix.en.startsWith("\n\nConflict-freeze mode is active"));
  // 无 JS 语法残留：不携带 const 声明、模板字面量包裹或拼接片段。
  for (const [key, pair] of Object.entries(STR.prompts)) {
    for (const [lang, text] of Object.entries(pair)) {
      assert.ok(!text.startsWith("const ") && !text.startsWith("? ")
        && !text.endsWith("`;") && !text.endsWith("`"),
        `${key}.${lang} must not carry JS syntax`);
    }
  }
});

test("two injectors with different language configs render independently", () => {
  function setup(language) {
    const store = createStore(":memory:");
    const service = createService({ store, mirror: null, config: testConfig({}) });
    const settings = createSettings(store.db);
    const contexts = [];
    const ctx = { systemPrompt: { context(def) { contexts.push(def); } } };
    createInjector(ctx, service, settings, { maxInjectedItems: 3, importanceThreshold: 3, language });
    service.saveWithDedupe({ type: "preference", title: "lang", content: "value", importance: 5 });
    return { store, contexts };
  }
  const en = setup("en");
  const zh = setup("zh");
  try {
    assert.ok(en.contexts[0].text({}).includes("[Memory]"), "en instance renders English header");
    assert.ok(zh.contexts[0].text({}).includes("[记忆库]"), "zh instance renders Chinese header");
  } finally {
    en.store.close();
    zh.store.close();
  }
});

test("mirror render follows the instance language; parser accepts both", () => {
  const memory = { id: "m1", type: "preference", title: "t", content: "c", importance: 5, tags: [], updated_at: "2026-01-01" };
  const enText = renderMirrorText("preference", [memory], "en");
  const zhText = renderMirrorText("preference", [memory], "zh");
  assert.ok(enText.includes("- **Type**: preference"));
  assert.ok(zhText.includes("- **类型**: preference"));
  const edits = parseHumanEdits(enText + "\n" + zhText);
  assert.deepEqual(
    edits.map((e) => e.id),
    ["m1", "m1"]
  );
  assert.equal(edits[1].content, "c");
});

test("dream summary keeps one row across a language switch (stable source identity)", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  service.saveWithDedupe({ type: "summary", title: "记忆库总览", content: "zh overview", importance: 5, source: "dream", _overwrite: true });
  service.saveWithDedupe({ type: "summary", title: "Memory library overview", content: "en overview", importance: 5, source: "dream", _overwrite: true });
  const summaries = store.all().filter((m) => m.type === "summary" && !m.archived);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].title, "Memory library overview");
  assert.equal(summaries[0].content, "en overview");
  store.close();
});

// Issue #764：why 自带句末标点时，affectiveNote 会拼出「。。」。
//
// 锁四件事，都是「只有渲染层能决定、库里不该被改」的那一半：
//   ① 句点类（。／．／.）不管一个还是连串，拼接后只有一个终止符；
//   ② 语气类（！／!／？／?／…）不剥——剥掉是把一句问话改写成陈述句，
//      所以改成让模板的终止符让位，语气原样留下，且不出现「！。」这种叠标点；
//   ③ why 只由标点组成 / 为空 → 整段「当时的原因」不出现（不能只剩空标签）；
//   ④ 中英文两条模板各自成立，且无 why 时的渲染与加这条规则之前逐字节相同。
test("#764 情绪注释：why 自带句末标点时不再拼出双终止符", () => {
  const zh = STR.affectiveNote.zh;
  const en = STR.affectiveNote.en;
  const call = (w) => zh("桉桉", "焦虑", "答辩", 1, w);

  // ① 句点类：常见形态全部收成一个「。」
  for (const w of ["首场答辩前一晚。", "首场答辩前一晚．", "首场答辩前一晚.", "首场答辩前一晚。。。", "首场答辩前一晚  "]) {
    const out = call(w);
    assert.ok(out.includes("首场答辩前一晚"), `why 内容要保留：${JSON.stringify(w)}`);
    assert.ok(!out.includes("。。"), `不许出现双句号：${JSON.stringify(w)} -> ${out}`);
    assert.ok(!out.includes("．。"), `不许出现混排双终止符：${JSON.stringify(w)} -> ${out}`);
    assert.match(out, /；当时的原因：首场答辩前一晚。这是场合性的/, `应当是单句号接下文：${JSON.stringify(w)} -> ${out}`);
  }

  // ② 语气类：语气符原样保留，模板的「。」让位
  for (const [w, tail] of [["她怕！", "她怕！这是场合性"], ["她怕吗？", "她怕吗？这是场合性"], ["她怕…", "她怕…这是场合性"]]) {
    const out = call(w);
    assert.ok(out.includes(tail), `语气符要留着、且后面不许再叠句号：${JSON.stringify(w)} -> ${out}`);
    assert.ok(!/[！？…]。/.test(out), `语气符后不许跟句号：${JSON.stringify(w)} -> ${out}`);
  }

  // ③ 只剩标点或为空：整段不出现，退回「没有 why」的渲染
  const bare = call("");
  for (const w of ["。", "！", "…", "  ", undefined, null]) {
    assert.equal(call(w), bare, `没有内容可讲的 why 必须与缺省渲染一致：${JSON.stringify(w)}`);
  }
  assert.ok(!bare.includes("当时的原因"), "没有 why 时不许出现标签");

  // ④ 英文模板同构；无 why 时与旧文案逐字节相同
  assert.match(
    en("An", "anxious", "defense", 1, "the night before."),
    /reason at the time: the night before\. Occasion-bound/,
    "英文：句点类收成一个"
  );
  assert.match(
    en("An", "anxious", "defense", 1, "was it worth it?"),
    /reason at the time: was it worth it\? Occasion-bound/,
    "英文：问号保留，不再补句点"
  );
  assert.equal(
    en("An", "anxious", "defense", 1, ""),
    '[affect record · single occasion] An was anxious about "defense". Occasion-bound — do not read it as a standing disposition.',
    "英文：无 why 时文案保持不变"
  );
  assert.equal(
    zh("桉桉", "焦虑", "答辩", 1, ""),
    "〔情绪记录·单次场合〕桉桉 在「答辩」这件事上焦虑。这是场合性的，不要当作一贯表现。",
    "中文：无 why 时文案保持不变"
  );
});
