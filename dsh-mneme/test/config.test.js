import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Config } from "../src/config.js";

test("session incognito is opt-in, with a default-on subordinate selector", () => {
  const cfg = Config({});
  assert.equal(cfg.sessionGateEnabled, false);
  assert.equal(cfg.sessionGateSubagents, true);
  assert.deepEqual(cfg.sessionGateSessions, []);
  assert.deepEqual(Config({ sessionGateSessions: ["s1", "s2"] }).sessionGateSessions, ["s1", "s2"]);
});

// ---------------------------------------------------------------- rerank opt-in (item ⑥)

test("rerank is opt-in: default config does not enable the local reranker", () => {
  const cfg = Config({});
  assert.equal(cfg.rerankEnabled, false, "rerankEnabled defaults to false");
  assert.equal(cfg.rerankProvider, "none", "rerankProvider defaults to none");
  // The plugin gate in index.js: LocalReranker is only constructed when both
  // hold — under defaults the gate is closed, so onnxruntime is never loaded.
  assert.equal(cfg.rerankEnabled && cfg.rerankProvider === "local", false, "gate closed by default");
  const enabled = Config({ rerankEnabled: true, rerankProvider: "local" });
  assert.equal(enabled.rerankEnabled && enabled.rerankProvider === "local", true, "explicit opt-in opens the gate");
});

test("dream sliding window + implicit keep config defaults and bounds (v0.4.4)", () => {
  const cfg = Config({});
  assert.equal(cfg.dreamMaxSnapshotSize, 200, "window defaults to 200");
  assert.equal(cfg.dreamImplicitKeep, true, "implicit keep defaults to true");
  const capped = Config({ dreamMaxSnapshotSize: 1000 });
  assert.equal(capped.dreamMaxSnapshotSize, 1000, "upper bound accepted");
  const off = Config({ dreamImplicitKeep: false });
  assert.equal(off.dreamImplicitKeep, false, "implicit keep can be disabled");
});

test("dream explicit coverage threshold config defaults and bounds (v0.4.4 fix)", () => {
  const cfg = Config({});
  assert.equal(cfg.dreamMinExplicitCoverage, 0.5, "coverage threshold defaults to 0.5");
  const low = Config({ dreamMinExplicitCoverage: 0.1 });
  assert.equal(low.dreamMinExplicitCoverage, 0.1, "lower bound accepted");
  const high = Config({ dreamMinExplicitCoverage: 1 });
  assert.equal(high.dreamMinExplicitCoverage, 1, "upper bound accepted");
});

test("startup probe: the reranker module never statically imports transformers/onnxruntime", () => {
  // LocalReranker is imported eagerly by index.js, so a bare install must not
  // pull onnxruntime in at module load. The heavy load is a lazy dynamic import
  // that only runs inside init(), which index.js calls only when the opt-in gate
  // is open (rerankEnabled && rerankProvider === "local").
  const src = readFileSync(new URL("../src/reranker.js", import.meta.url), "utf8");
  assert.ok(
    !src.includes('from "@huggingface/transformers"'),
    "no static transformers.js import in reranker.js"
  );
  // issue #131 之后，懒加载的落点从 reranker 内部搬到了 src/runtime/loader.js
  // （三层解析：自管 payload → 宿主裸 specifier）。判据随之改成两条，意图不变：
  // reranker 不得静态导入，且必须经由 loader 间接加载；动态 import 只允许出现在
  // loader 里（它是唯一知道「运行时从哪来」的模块）。
  assert.match(src, /from "\.\/runtime\/loader\.js"/, "reranker 经 runtime/loader.js 取运行时");
  assert.match(src, /loadTransformers\(/, "reranker 必须走三层解析，而不是自己拼 import");
  assert.ok(
    !/^\s*import[^\n]*@huggingface\/transformers/m.test(src),
    "reranker 不允许任何形式的静态 transformers 导入"
  );

  const loaderSrc = readFileSync(new URL("../src/runtime/loader.js", import.meta.url), "utf8");
  assert.match(loaderSrc, /import\(specifier\)/, "loader 用动态 import 保持懒加载");
  assert.ok(
    !/^\s*import[^\n]*@huggingface\/transformers/m.test(loaderSrc),
    "loader 不得静态导入 transformers，否则惰性加载就失效了"
  );
});
