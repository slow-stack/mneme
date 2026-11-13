// 模型可见时间线索：注入行与三个工具回执都要带日期，且日期缺省时渲染与改动前
// 逐字节一致。
//
// 为什么单独开一份：这三处（inject.js / tools.js / lang.js）在仓库里从来没有测试
// 断言过渲染串（ops_grep 在 252 个测试文件里对 `updated: ` 零命中），所以改动它们
// 时测试不会红——反过来说，新加的行为也没人钉住。本文件专门钉这个面。
import test from "node:test";
import assert from "node:assert/strict";
import { hintDate, memoryDate } from "../src/date-hint.js";
import { STR } from "../src/lang.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";
import { createInjector } from "../src/inject.js";
import { createSettings } from "../src/settings.js";
import { testConfig } from "./helpers/test-config.js";

test("hintDate 只认 YYYY-MM-DD 前缀的形状，坏值返回空串而不是占位符", () => {
  assert.equal(hintDate("2026-11-11T10:29:45.703Z"), "2026-11-11");
  assert.equal(hintDate("2026-11-11"), "2026-11-11");
  assert.equal(hintDate(""), "");
  assert.equal(hintDate(null), "");
  assert.equal(hintDate(undefined), "");
  assert.equal(hintDate("2026-11"), "");
  assert.equal(hintDate("昨天"), "");
  assert.equal(hintDate(20261111), "");
});

test("memoryDate：事件发生时间优先，缺省回落到落库时间", () => {
  assert.equal(memoryDate({ occurred_at: "2026-10-05T09:30:00+08:00", created_at: "2026-11-01T00:00:00Z" }), "2026-10-05");
  assert.equal(memoryDate({ occurred_at: null, created_at: "2026-11-01T00:00:00Z" }), "2026-11-01");
  assert.equal(memoryDate({ created_at: "2026-11-01T00:00:00Z" }), "2026-11-01");
  // occurred_at 形状不对时不能让整条丢掉日期——回落 created_at。
  assert.equal(memoryDate({ occurred_at: "not-a-date", created_at: "2026-11-01T00:00:00Z" }), "2026-11-01");
  assert.equal(memoryDate({}), "");
  assert.equal(memoryDate(null), "");
});

// 日期位是「可选参数」：不传时渲染必须与加日期前逐字节相同。老调用方（含
// test/graph-inject-budget.test.js 的三参调用）因此不受影响。
test("两个行模板：不传日期时输出与加日期前逐字节一致", () => {
  assert.equal(STR.entryLine.zh("preference", "", "标题", "正文"), "- [preference] 标题：正文");
  assert.equal(STR.entryLine.en("preference", "[verified] ", "Title", "body"), "- [preference] [verified] Title: body");
  assert.equal(STR.graphHintLine.zh("entity", "某某", "内容"), "- [线索/entity] 某某：内容");
  assert.equal(STR.graphHintLine.en("technology", "Foo", "bar"), "- [hint/technology] Foo: bar");
});

test("两个行模板：传日期时日期落在类型括号之后、标题之前", () => {
  assert.equal(STR.entryLine.zh("preference", "", "标题", "正文", "2026-11-11"), "- [preference] 2026-11-11 标题：正文");
  assert.equal(STR.entryLine.en("decision", "", "Title", "body", "2026-11-11"), "- [decision] 2026-11-11 Title: body");
  // 前缀 `- [type] ` 不能被日期抢走：线索行的引导语/前缀断言依赖它。
  assert.ok(STR.graphHintLine.zh("entity", "某某", "内容", "2026-11-11").startsWith("- [线索/entity] "));
  assert.equal(STR.graphHintLine.zh("entity", "某某", "内容", "2026-11-11"), "- [线索/entity] 2026-11-11 某某：内容");
});

function setupTools() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const registered = [];
  const ctx = { tools: { register(def) { registered.push(def); return () => {}; } } };
  createTools(ctx, service, {}, null);
  const byName = (n) => registered.find((t) => t.name === n);
  return { store, service, byName };
}

test("memory_search / memory_list / memory_get 三个回执都带 created 与 updated", async () => {
  const { store, service, byName } = setupTools();
  try {
    const saved = service.saveWithDedupe({ type: "preference", title: "时间线索", content: "条目正文" }).memory;
    const day = saved.created_at.slice(0, 10);

    const search = byName("memory_search");
    const searchText = search.output.render({}, await search.execute({ query: "条目正文" }))[0].text;
    assert.ok(searchText.includes(`created: ${day}`), "search 回执要带 created（原只有 updated）");
    assert.ok(searchText.includes(`updated: ${day}`), "search 回执的 updated 不能丢");
    assert.ok(!searchText.includes("T10:"), "日期不带时分秒");

    const list = byName("memory_list");
    const listText = list.output.render({}, await list.execute({}))[0].text;
    assert.ok(listText.includes(`created: ${day}`), "list 回执要带 created");

    // memory_get 改动前连 updated 都不给——模型取全文时彻底丢时间。
    const get = byName("memory_get");
    const getText = get.output.render({}, await get.execute({ id: saved.id }))[0].text;
    assert.ok(getText.includes(`created: ${day}`), "get 回执要带 created");
    assert.ok(getText.includes(`updated: ${day}`), "get 回执要带 updated（改动前缺）");
  } finally {
    store.close();
  }
});

// 注入行是消费方唯一无条件可见的文本：不带日期，模型只能拿 updated_at 猜年龄。
test("注入行带条目日期，occurred_at 优先于 created_at", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const contexts = [];
  const ctx = { systemPrompt: { context(def) { contexts.push(def); } } };
  try {
    const saved = service.saveWithDedupe({
      type: "decision", title: "带发生时间的决策", content: "正文", importance: 5,
      occurred_at: "2026-10-05T09:30:00+08:00"
    }).memory;
    createInjector(ctx, service, createSettings(store.db), { maxInjectedItems: 3, importanceThreshold: 3 });
    const text = contexts[0].text({});
    assert.ok(text.includes(`- [decision] 2026-10-05 带发生时间的决策`),
      `注入行要带 occurred_at 的日期，实际：${text}`);
    assert.ok(!text.includes(saved.created_at.slice(0, 10)),
      "occurred_at 存在时不应再拿 created_at 顶替");
  } finally {
    store.close();
  }
});

test("注入行：无 occurred_at 时回落到 created_at，且降级标题行同样带日期", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const contexts = [];
  const ctx = { systemPrompt: { context(def) { contexts.push(def); } } };
  try {
    const saved = service.saveWithDedupe({ type: "project", title: "无发生时间", content: "正文", importance: 5 }).memory;
    const day = saved.created_at.slice(0, 10);
    createInjector(ctx, service, createSettings(store.db), { maxInjectedItems: 3, importanceThreshold: 3 });
    const text = contexts[0].text({});
    assert.ok(text.includes(`- [project] ${day} 无发生时间`), `注入行要回落 created_at，实际：${text}`);
  } finally {
    store.close();
  }
});

// 降级标题行（预算不足时只留标题）是另一段代码，漏改就会在同一块里出现「有日期」
// 与「无日期」两种行，模型会以为后者是特殊条目。
test("预算不足的降级标题行也带日期", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const contexts = [];
  const ctx = { systemPrompt: { context(def) { contexts.push(def); } } };
  try {
    // 两条超长正文 → 高重要度那条先渲染并吃掉预算，低一档的只能退化成标题行。
    // 不能挑 pin 类型（constraint/preference）：pin 池不参与塌缩预算，永远不会降级
    // ——踩过一次，测试因此假绿。也不能让两条同重要度：平局按 updated_at DESC 排，
    // 后插入的那条会先渲染，到底谁降级就不确定了。配置键是 injectContentMaxChars
    // （inject.js:187），不是 maxContent。
    const long = "长".repeat(2000);
    const first = service.saveWithDedupe({ type: "project", title: "占满预算", content: long, importance: 5 }).memory;
    const second = service.saveWithDedupe({ type: "project", title: "被降级", content: long, importance: 3 }).memory;
    createInjector(ctx, service, createSettings(store.db), {
      maxInjectedItems: 5, importanceThreshold: 3, injectContentMaxChars: 1400
    });
    const text = contexts[0].text({});
    assert.ok(text.includes(`${first.created_at.slice(0, 10)} 占满预算`), "满行带日期");
    // 降级行必须逐字匹配「类型 + 日期 + 标题 + 重要性」，且整行就到重要性结尾。
    const degraded = `- [project] ${second.created_at.slice(0, 10)} 被降级（重要性 3）`;
    assert.ok(text.split("\n").includes(degraded), `降级标题行要带日期且不带正文，实际块：\n${text.slice(0, 600)}`);
  } finally {
    store.close();
  }
});
