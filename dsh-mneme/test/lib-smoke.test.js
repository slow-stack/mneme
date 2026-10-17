import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// lib/ 运行冒烟（v0.7.16 回归补测，重建被 PR#73 删除的 lib-smoke.test.js）。
// npm 包实际加载的是 lib/（package main → lib/index.js），历史教训 v0.7.8
// 只改 src 忘了同步 lib 发出去旧产物（issue #65）。这里补两层守护：
//   1) 静态：src/ 与 lib/ 逐文件字节一致（check-sync.js 的测试版，CI 常驻）；
//   2) 运行时：直接从 lib/ 导入核心模块跑关键链路，证明打包产物可独立加载。

const root = fileURLToPath(new URL("..", import.meta.url)); // dsh-mneme/
const srcDir = join(root, "src");
const libDir = join(root, "lib");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

test("src/ and lib/ are byte-identical (no publish drift)", () => {
  const srcFiles = walk(srcDir);
  assert.ok(srcFiles.length > 0, "src tree is not empty");
  const drift = [];
  for (const file of srcFiles) {
    const rel = relative(srcDir, file);
    const dest = join(libDir, rel);
    if (!readFileSync(dest, "utf8")) {
      drift.push(`missing lib/${rel}`);
    } else if (!readFileSync(file).equals(readFileSync(dest))) {
      drift.push(`differ lib/${rel}`);
    }
  }
  assert.deepEqual(drift, [], "src↔lib must stay in sync (npm run sync)");
});

test("没有文件带双 CR（行尾必须是 LF 或 CRLF，不是 CRCRLF）", () => {
  // 这条锁的来历：`src/candidates.js` 从诞生起每个换行都是 `<CR><CR><LF>`，
  // 一路进了 main、又随 v0.9.0 发到 npm，而**当时没有任何检查会红**——
  // 因为 `\r` 在 JS 里是合法空白，解析与测试全绿。代价落在别处：
  //   · 任何改动这个文件的人，diff 都是整文件 908/908（噪声掩盖真改动）；
  //   · 同一份文件 `Get-Content` 数出 908 行、编辑器/工具数出 454 行，两边对不上；
  //   · 发布产物里带着畸形行尾。
  // 判据是**扫描字节**而不是依赖某个工具的换行解释——正因工具口径不一致，
  // 才必须查 `<CR><CR><LF>` 这个具体序列本身。
  const bad = [];
  for (const dir of [srcDir, libDir]) {
    for (const file of walk(dir)) {
      if (!file.endsWith(".js")) continue;
      const doubleCr = readFileSync(file, "utf8").match(/\r\r\n/g);
      if (doubleCr) bad.push(`${relative(root, file)}: ${doubleCr.length} 处`);
    }
  }
  assert.deepEqual(bad, [], "行尾出现 <CR><CR><LF>——多出来的 CR 会让 diff 与行数口径一起坏掉");
});

// ---------------------------------------------------------------------------
// lib 运行时冒烟：直接加载 npm 实际分发的产物
// ---------------------------------------------------------------------------
test("lib store+service runs a save/get/count cycle", async () => {
  const { createStore } = await import("../lib/store.js");
  const { createService } = await import("../lib/service.js");

  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const { memory } = service.saveWithDedupe({ type: "preference", title: "语言", content: "中文" });
  assert.ok(memory.id);
  assert.ok(service.getById(memory.id));
  assert.equal(service.count(), 1);
});

test("lib summarize parses extraction JSON robustly", async () => {
  const { parseSummaryJson } = await import("../lib/summarize.js");

  // 前后夹带杂质的原始输出 → 只取数组
  const parsed = parseSummaryJson("```json\n[{\"type\":\"preference\",\"title\":\"x\",\"content\":\"y\",\"importance\":9}]\n```");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].importance, 5, "importance clamped to [1,5]");

  // 非法 JSON / 非数组 → 空数组，不抛
  assert.deepEqual(parseSummaryJson("no array here"), []);
  assert.deepEqual(parseSummaryJson('{"type":"preference"}'), []);
  assert.deepEqual(parseSummaryJson(""), []);
});

test("lib summarize constructs with autoSummarize disabled", async () => {
  const { createSummarizer } = await import("../lib/summarize.js");
  const summarizer = createSummarizer({}, {}, { autoSummarize: false });
  assert.equal(typeof summarizer.dispose, "function");
  summarizer.dispose();
});

test("lib inject constructs and renders an empty block", async () => {
  const { createInjector } = await import("../lib/inject.js");
  const registered = [];
  const ctx = {
    systemPrompt: {
      context: (def) => { registered.push(def); return () => {}; }
    }
  };
  const service = { injectCandidates: () => [], injectSettings: () => [] };
  const dispose = createInjector(ctx, service, {}, {});
  assert.equal(typeof dispose, "function");
  assert.equal(registered.length, 2, "memory + user-settings contexts registered");

  const memoryBlock = registered.find((d) => d.name === "memory");
  assert.equal(typeof memoryBlock.text, "function");
  assert.equal(memoryBlock.text({}), ""); // 无候选 → 空块
  dispose();
});
