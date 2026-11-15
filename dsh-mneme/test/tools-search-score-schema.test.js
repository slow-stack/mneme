// issue #735：向量路一开，memory_search 的整个返回值被宿主拒收。
//
// 形状：#713（续）让 toApiList 条件展开 `_score`，但忘了在 MEMORY_ITEM_SCHEMA
// （additionalProperties:false）里声明它。于是 `mode=auto|vector` 命中向量时，
// 宿主 in-process 校验报
//   tool "memory_search" returned invalid output:
//   "value.items[0]._score" is not a declared property
// 而 keyword 路不带该键，所以表现为「换个 mode 就全挂」。
//
// 为什么原有测试没抓到（PR 里要写的那句）：
//   - test/vector-threshold.test.js 确实断过 `_score`，但它只比
//     `service.toApiList(rows)[0]._score` 的数值——**只测 DTO 产地的形状，
//     从不过工具的 output schema**，两边各自绿着，合起来才红。
//   - test/tools-dto-schema-matrix.test.js 的 A 层会拿真实 execute 返回值过
//     validateJsonSchemaValue，但它的 setup 从不 setEmbedder/setVectorIndex，
//     种子形态里也没有一条走过向量路 → `_score` 这条条件展开在矩阵里从未被真实
//     产出，B 层的「声明键必须被真实产出」自然也检不到它。
//
// 所以这条测试的职责很窄：**让向量路真的命中，再拿工具自己声明的 schema 验一次
// 真实返回值**。删掉 src/tools.js 里的 `_score` 声明，它必须红。
import test from "node:test";
import assert from "node:assert/strict";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";
import { createVectorIndex } from "../src/vector-index.js";
import { testConfig } from "./helpers/test-config.js";

// Every query embeds to [1,0,0]; the stored row sits at cosine 0.5 to it.
const embedder = {
  embedSingle: async () => [1, 0, 0],
  embed: async () => [1, 0, 0],
  schedule: () => {},
  modelHash: "mock#1",
  dimension: 3
};

const HALF_COSINE = [0.5, Math.sqrt(0.75), 0];
// 6 chars: adaptive would land on its 0.65 default, and there is no literal
// overlap with the row, so only the vector path can surface it.
const QUERY = "量子计算入门";

function setup(config) {
  const store = createStore(":memory:");
  const resolved = testConfig({ adaptiveThresholdEnabled: false, vectorSearchThreshold: 0.4, ...config });
  const service = createService({ store, mirror: null, config: resolved });
  const vectorIndex = createVectorIndex({ store });
  service.setEmbedder(embedder);
  service.setVectorIndex(vectorIndex);
  const row = service.saveWithDedupe({ type: "project", title: "猫", content: "喜欢猫" });
  vectorIndex.saveEmbedding(row.memory.id, HALF_COSINE);

  const registered = [];
  const ctx = { tools: { register(def) { registered.push(def); return () => {}; } } };
  // 工具层与 service 必须共用同一个 config 对象：阈值与 embedder 都从那边读。
  createTools(ctx, service, resolved, embedder);
  const byName = Object.fromEntries(registered.map((def) => [def.name, def]));
  return { store, service, byName, id: row.memory.id };
}

test("#735 向量路命中的 memory_search 返回值必须过自己的 output schema", async () => {
  const { byName, id } = setup();
  const value = await byName.memory_search.execute({ query: QUERY, mode: "vector", limit: 10 });

  assert.equal(value.items.length, 1, "cosine 0.5 clears the configured 0.4 cutoff");
  assert.equal(value.items[0].id, id);
  assert.ok(
    Math.abs(value.items[0]._score - 0.5) < 1e-6,
    `向量路必须带出余弦分，实际 ${value.items[0]._score}`
  );

  const errors = validateJsonSchemaValue(byName.memory_search.output.schema, value);
  assert.deepEqual(
    errors,
    [],
    `memory_search 的真实返回未被 output schema 接受（#735 的形状）：${JSON.stringify(errors)}\n`
      + `返回键：${JSON.stringify(Object.keys(value.items[0]))}`
  );
});

test("#735 keyword 路与 memory_list / memory_get 不带 _score，也照样过 schema", async () => {
  const { byName, service } = setup();
  // 字面命中，只走关键词路。
  service.saveWithDedupe({ type: "project", title: QUERY, content: "字面命中即可" });

  const keyword = await byName.memory_search.execute({ query: QUERY, mode: "keyword", limit: 10 });
  assert.ok(keyword.items.length >= 1, "the literal row is found by keyword");
  for (const item of keyword.items) assert.equal("_score" in item, false);
  assert.deepEqual(validateJsonSchemaValue(byName.memory_search.output.schema, keyword), []);

  // list / get 与 search 共用同一份 item schema（B' 层守着同源），它们恒不带
  // `_score`——所以 `_score` 在 schema 里必须是可选属性，不能是 required。
  const list = await byName.memory_list.execute({ limit: 10 });
  assert.deepEqual(validateJsonSchemaValue(byName.memory_list.output.schema, list), []);

  const got = await byName.memory_get.execute({ id: list.items[0].id });
  assert.deepEqual(validateJsonSchemaValue(byName.memory_get.output.schema, got), []);
  assert.equal("_score" in got.memory, false);
});
