// Issue #164① 注入截断修复测试。
// 覆盖：截断带尾部提示（上限/原长/memory_get id 指引，不再静默）/ 短正文无
// 提示 / 上限可配（injectContentMaxChars）/ 块预算随上限放大（调大上限不被
// 1500 旧闸卡死）/ _full_content 压缩注入路径不加提示 / 默认 300 与既有行为
// 对齐（ellipsis 仍在、全文不整段进入）。
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createInjector } from "../src/inject.js";
import { createSettings } from "../src/settings.js";
import { testConfig } from "./helpers/test-config.js";

function setup(over = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const settings = createSettings(store.db);
  const contexts = [];
  const ctx = {
    systemPrompt: {
      context(def) {
        contexts.push(def);
        return () => {};
      }
    }
  };
  const config = { maxInjectedItems: 3, importanceThreshold: 3, ...over };
  const injector = createInjector(ctx, service, settings, config);
  return { store, service, contexts, injector };
}

test("truncated entry carries a non-silent tail hint with limit/length/memory_get", () => {
  const { contexts, service } = setup();
  const long = "超长正文内容。".repeat(200); // ~1400 chars
  const mem = service.saveWithDedupe({ type: "preference", title: "长记忆", content: long, importance: 5 }).memory;
  const text = contexts[0].text({});
  assert.ok(text.includes("…"), "ellipsis present");
  assert.ok(text.includes(`memory_get "${mem.id}"`), "hint carries memory_get id");
  assert.ok(text.includes("上限 300"), "hint carries the limit");
  assert.ok(text.includes(`原 ${long.length} 字符`), "hint carries original length");
});

test("short content gets no hint", () => {
  const { contexts, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "短记忆", content: "中文交流", importance: 5 });
  const text = contexts[0].text({});
  assert.ok(!text.includes("已截断"), "no truncation hint on short content");
});

test("injectContentMaxChars raises the cap and the hint reports the new limit", () => {
  const { contexts, service } = setup({ injectContentMaxChars: 800 });
  const long = "字".repeat(1000);
  service.saveWithDedupe({ type: "preference", title: "长记忆", content: long, importance: 5 });
  const text = contexts[0].text({});
  assert.ok(text.includes("字".repeat(800)), "content injected up to the new cap");
  assert.ok(!text.includes("字".repeat(801)), "content beyond the new cap is cut");
  assert.ok(text.includes("上限 800"), "hint reports the configured limit");
});

test("block budget scales with the cap (raised cap is not defeated by the 1500 gate)", () => {
  const { contexts, service } = setup({ injectContentMaxChars: 1000, maxInjectedItems: 2 });
  const body = "块".repeat(900);
  service.saveWithDedupe({ type: "preference", title: "甲", content: body, importance: 5 });
  service.saveWithDedupe({ type: "preference", title: "乙", content: body, importance: 5 });
  const text = contexts[0].text({});
  assert.ok(text.includes("甲"), "first entry full");
  assert.ok(text.includes("块".repeat(900)), "first entry body not collapsed by stale block gate");
  assert.ok(text.includes("乙"), "second entry still rendered");
});

test("_full_content (sleep-compressed) path obeys the cap and says so (#266 评审)", () => {
  const { store, contexts, service } = setup();
  const mem = service.saveWithDedupe({ type: "preference", title: "压缩记忆", content: "占位", importance: 5 }).memory;
  // 模拟 sleep 降级：content=压缩摘要（400 字符 > 默认 300 上限），原文入库 _full_content
  const summary = "压缩摘要。".repeat(80);
  store.db.prepare("UPDATE memories SET content=?, _full_content=? WHERE id=?")
    .run(summary, "原始长文".repeat(100), mem.id);
  const text = contexts[0].text({});
  // 「降级过」不等于「天然够短」：原先这条早返回的唯一效果就是绕过上限，现在统一截断。
  assert.ok(!text.includes(summary), "oversized summary is not injected whole");
  assert.ok(text.includes("压缩摘要。".repeat(60)), "the part inside the cap is still there (300 chars)");
  assert.ok(text.includes("已截断"), "the cut is reported, never silent");
});

test("default cap stays 300 (ellipsis regression of Bug6)", () => {
  const { contexts, service } = setup();
  const long = "x".repeat(2000);
  service.saveWithDedupe({ type: "preference", title: "长记忆", content: long, importance: 5 });
  const text = contexts[0].text({});
  assert.ok(text.includes("x".repeat(300)));
  assert.ok(!text.includes("x".repeat(301)));
});
