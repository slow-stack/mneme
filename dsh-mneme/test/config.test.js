import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Config } from "../src/config.js";
import { isCodingTask } from "../src/service.js";

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

// ---------------------------------------------------------------- codingKeywords 工程协作词（2026-11-06）
// 生产日志里「合并 / 开 PR / 看 CI / 发版 / 验收 / 冲突 / 分支 / issue」这类
// 工程协作话在原 56 项词表里一个都不命中，被判成非编码任务，于是
// rejected_solution / pitfall / constraint 三类编码记忆被 codingGate 整类滤掉。
// 实测这类 query 占非编码调用的 17.1~17.8%。本组用例锁住补词后的词表与行为。

test("codingKeywords 覆盖工程协作动作，且不含歧义词", () => {
  const { codingKeywords } = Config({});

  // 这 34 项就是补进去的工程协作词，一个都不能少（少了就等于白改）。
  // 不另加「长度必须是 90」的断言：那是把「逐词覆盖」和「不多不少」两个语义
  // 绑在一处，删一个词会同时触发两条断言，看报告的人会误以为两条用例各自
  // 独立兜底。逐词断言已经足够——多出来的词由下面的「不得含」三条反向兜住。
  //
  // 「审评」必须与「评审」并列：她真实说的是「等审评」「看CI和审评」（8 条 /
  // 779 次），「评审」只有 4 条 / 420 次。同义不同形，子串匹配两套都得分开放。
  const engineering = [
    "提交", "合并", "分支", "冲突", "验收", "审查", "评审", "审评", "发版",
    "仓库", "回滚", "推送", "拉取", "变基", "上线", "打包", "迁移",
    "字段", "鉴权", "超时", "并发", "闪退", "白屏", "端口", "进程",
    "守护", "定时任务", "索引", "缓存", "死锁", "内存泄漏", "日志",
    "版本号", "环境变量"
  ];
  for (const kw of engineering) {
    assert.ok(codingKeywords.includes(kw), `缺少工程协作词「${kw}」`);
  }

  // 刻意不加的两个：
  // 「事务」唯一命中是政治学简答「公共事务委托给企业和社会组织」，加进去
  // 会把考研答题场景判成编码任务，方向正好相反。
  // 「依赖包」纯冗余——「依赖」已在表内，它永远不会单独生效。
  assert.ok(!codingKeywords.includes("事务"), "不得加「事务」：会把政治学简答判成编码任务");
  assert.ok(!codingKeywords.includes("依赖包"), "不得加「依赖包」：「依赖」已在表内，纯冗余");

  // 无重复
  assert.equal(new Set(codingKeywords).size, codingKeywords.length, "词表不得有重复项");

  // 英文词一律不加：isCodingTask 是纯子串匹配，无词边界的短英文词会误命中。
  // 实测 pr 命中 69 条/6002 次，其中无词边界 30 条/3477 次（57.9%）是
  // C:/Program File/GitHub CLI、pnpm 路径、prompt 这类文本。
  for (const kw of ["pr", "ci", "push", "pull", "rebase", "revert", "diff"]) {
    assert.ok(!codingKeywords.includes(kw), `不得加英文短词「${kw}」：无词边界会误命中`);
  }
});

test("工程协作话被判成编码任务，考研答题话仍判成非编码", () => {
  // 走生产的 isCodingTask，不在这里另写一份判断逻辑。
  // 此前这条用例自己写 const isCoding = (t) => codingKeywords.some(...)，
  // 测的是「词表内容对不对」，不是「生产函数怎么用它」——实测把
  // src/service.js 的 isCodingTask 改成永远 return false（整个编码门废掉），
  // 全仓 177 个相关用例仍然全绿。所以这里必须 import 真函数。
  const { codingKeywords } = Config({});

  // 这些是她真实说过的工程协作话，补词前全部被判成非编码
  for (const q of [
    "提交这个issue然后你在主分支的基础上开分支修",
    "先回帖再开分支。",
    "合并",
    "看看#536，解决冲突",
    "看看ci和评审",
    "A+B，今天就能发版",
    "等审评。你看看#35那个pr。",
    "按照你说的，先合并完前面的再开#493"
  ]) {
    assert.equal(isCodingTask(q, codingKeywords), true, `「${q}」应判成编码任务`);
  }

  // 考研答题话：补词后仍然不能被判成编码任务，否则她的答题场景会注入编码踩坑
  for (const q of [
    "1.B,2.这个就是……政府职能转变，公共事务委托给企业和社会组织",
    "背95单词",
    "英语阅读 1 篇（2016 起正序）",
    "631 专业课块 · 15:30–17:00"
  ]) {
    assert.equal(isCodingTask(q, codingKeywords), false, `「${q}」应判成非编码任务`);
  }
});
