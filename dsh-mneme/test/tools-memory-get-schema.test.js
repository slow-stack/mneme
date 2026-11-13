// #184 回归：memory_get 的内联输出 schema 漏声明 v0.8.1 的 scope 来源三键
// （agent_scope_source / workspace_scope_source / scope_decided_at），且
// additionalProperties:false → toApiList 对被标注行条件展开这些键后，宿主
// in-process 校验直接拒收（"invalid output"），表现为「个别 id 必失败、多数
// 正常」。本文件用生产同款校验器（@deepseek-ai/dsh-tools 的
// validateJsonSchemaValue）复现并防漂移；修复 = memory_get 复用与
// list/search 共享的 MEMORY_ITEM_SCHEMA，不再维护内联副本。
import test from "node:test";
import assert from "node:assert/strict";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools, MEMORY_ITEM_SCHEMA } from "../src/tools.js";
import { testConfig } from "./helpers/test-config.js";

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const registered = [];
  const ctx = {
    tools: {
      register(def) {
        registered.push(def);
        return () => {};
      }
    }
  };
  createTools(ctx, service, {}, undefined);
  const byName = Object.fromEntries(registered.map((def) => [def.name, def]));
  return { store, service, byName };
}

// memory_get.execute 的返回 = { memory: toApiList([getById(id)])[0] }——契约
// 测试直接对「toApiList 产出的 DTO ↔ 声明的 output schema」做校验（DTO 键的
// 唯一来源就是 toApiList，execute 只是包装）。
test("memory_get output validates for fully scope-annotated rows (#184)", () => {
  const { store, service, byName } = setup();
  const saved = store.save({
    type: "preference",
    title: "annotated row",
    content: "带全量 scope 来源标注的记忆行",
    source: "test",
    agent_scope: "coder",
    agent_scope_source: "auto",
    workspace_scope: "proj-alpha",
    workspace_scope_source: "auto",
    scope_decided_at: "2026-09-15T00:00:00Z"
  });
  const get = byName.memory_get;
  const dto = service.toApiList([store.getById(saved.id)])[0];
  const res = { memory: dto };
  assert.deepEqual(validateJsonSchemaValue(get.output.schema, res), []);
});

test("memory_get item schema reuses MEMORY_ITEM_SCHEMA (no inline copy) (#184)", () => {
  const { byName } = setup();
  const get = byName.memory_get;
  // defineTool 编译会克隆 schema，恒等不成立——断言键集与严格性同源。
  const compiled = get.output.schema.properties.memory;
  assert.deepEqual(
    Object.keys(compiled.properties).sort(),
    Object.keys(MEMORY_ITEM_SCHEMA.properties).sort()
  );
  assert.equal(compiled.additionalProperties, false);
  assert.deepEqual(compiled.required.sort(), ["content", "created_at", "id", "importance", "title", "type", "updated_at"]);
});
