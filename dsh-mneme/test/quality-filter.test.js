import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import {
  evaluateMemoryQuality,
  META_MEMORY_RE,
  textSimilarity,
  REPETITION_THRESHOLD,
  repetitionRatio
} from "../src/quality-filter.js";
import { testConfig } from "./helpers/test-config.js";

// Bug7: rule-based memory quality filter. Gated on
// config.memoryQualityFilter.enabled — **默认开**（src/config.js 的 schema 就是
// .default(true)，宿主装配后 cfg 里恒为 true）。只有显式 false 才关；裸配置
// （不传该键）按默认开处理，阈值读取走可选链回落到 10 / 30 / 4（#692）。
// 本文件自己的 setup 显式传 true，因为下面考的就是判据本身。Score bands:
//   >= 60       stored normally
//   30 .. < 60  quality_score persisted, injection ranked by importance × score/100
//   < 30        archived + tagged low_quality (explicit search still recalls it)

function setup(over = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({ memoryQualityFilter: { enabled: true }, ...over }) });
  return { store, service };
}

test("evaluateMemoryQuality: meta-memory scores below 60 (degraded, not archived)", () => {
  const { score, tags } = evaluateMemoryQuality({
    type: "history",
    title: "对话总结",
    content: "总结一下刚才的对话，需要记住以下要点"
  });
  assert.ok(score >= 30 && score < 60, `meta memory should be degraded (30..60), got ${score}`);
  assert.ok(tags.includes("meta"), "tagged meta");
});

test("evaluateMemoryQuality: short content is archived (< 30)", () => {
  const { score, tags } = evaluateMemoryQuality({ type: "preference", title: "语言", content: "短" });
  assert.ok(score < 30, `short content should be archived, got ${score}`);
  assert.ok(tags.includes("short_content"));
  assert.ok(tags.includes("low_quality"));
});

test("evaluateMemoryQuality: near-duplicate of a recent memory is archived", () => {
  const { score, tags } = evaluateMemoryQuality(
    { type: "preference", title: "重复", content: "猫咪喜欢在阳台晒太阳并打盹" },
    { recentContents: ["猫咪喜欢在阳台晒太阳并打盹"] }
  );
  assert.ok(score < 30, `duplicate should be archived, got ${score}`);
  assert.ok(tags.includes("duplicate"));
});

test("saveWithDedupe: meta memory persists quality_score < 60 and is not archived", () => {
  const { store, service } = setup();
  const { memory } = service.saveWithDedupe({
    type: "history",
    title: "对话总结",
    content: "总结一下刚才的对话，需要记住以下要点"
  });
  const got = store.getById(memory.id);
  assert.ok(got.quality_score !== undefined && got.quality_score < 60,
    `meta memory should store quality_score < 60, got ${got.quality_score}`);
  assert.equal(got.archived, false, "degraded memory stays un-archived");
});

test("saveWithDedupe: short text is archived + tagged low_quality", () => {
  const { store, service } = setup();
  const { memory } = service.saveWithDedupe({
    type: "preference",
    title: "语言",
    content: "短"
  });
  const got = store.getById(memory.id);
  assert.equal(got.archived, true, "short text archived");
  assert.ok(got.tags.includes("low_quality"), "tagged low_quality");
  assert.ok(got.quality_score < 30, `score below archive threshold, got ${got.quality_score}`);
});

test("saveWithDedupe: near-duplicate content is archived", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "习惯一", content: "猫咪喜欢在阳台晒太阳并打盹" });
  const { memory: dup } = service.saveWithDedupe({ type: "preference", title: "习惯二", content: "猫咪喜欢在阳台晒太阳并打盹" });
  const got = store.getById(dup.id);
  assert.equal(got.archived, true, "near-duplicate archived");
  assert.ok(got.tags.includes("low_quality"));
});

test("saveWithDedupe: filter off by explicit enabled:false skips scoring entirely", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const { memory } = service.saveWithDedupe({ type: "preference", title: "语言", content: "短" });
  const got = store.getById(memory.id);
  assert.equal(got.archived, false, "nothing archived when filter off");
  assert.equal(got.quality_score, undefined, "no quality_score when filter off");
  assert.ok(!got.tags.includes("low_quality"));
});

test("injectCandidates: degraded memory ranks below a healthy preference", () => {
  const { service } = setup();
  // Healthy preference: score 100 → weight 1.0 → 3 * 1.0 = 3.0.
  service.saveWithDedupe({ type: "preference", title: "健康偏好", content: "用户平时习惯用中文交流", importance: 3 });
  // Degraded (meta-memory) preference: score ~55 → weight 0.55 → 5 * 0.55 = 2.75.
  service.saveWithDedupe({ type: "preference", title: "元记忆偏好", content: "总结一下刚才的对话内容吧", importance: 5 });
  const candidates = service.injectCandidates({ maxItems: 5, threshold: 3 });
  const titles = candidates.map((c) => c.title);
  assert.ok(titles.includes("健康偏好"), "healthy preference present");
  assert.ok(titles.includes("元记忆偏好"), "degraded preference present");
  assert.ok(titles.indexOf("健康偏好") < titles.indexOf("元记忆偏好"),
    "degraded memory is demoted below the healthy one");
});

test("exported helpers behave (meta regex, similarity, repetition ratio)", () => {
  assert.ok(META_MEMORY_RE.test("总结一下刚才的对话"));
  assert.ok(META_MEMORY_RE.test("作为AI助手，我需要记住"));
  assert.ok(!META_MEMORY_RE.test("用户喜欢喝咖啡"));
  assert.equal(textSimilarity("猫咪喜欢晒太阳", "猫咪喜欢晒太阳"), 1);
  assert.ok(textSimilarity("猫咪喜欢晒太阳", "完全不同的内容") < 0.3);
  assert.ok(repetitionRatio("哈哈哈哈哈哈") > REPETITION_THRESHOLD, "repetitive filler is flagged");
  assert.ok(repetitionRatio("一句信息量足够的话") < REPETITION_THRESHOLD, "normal prose is not");
});

// --- repetition is measured by trigrams, not by unique-chars/total ---
//
// The v0.7.12 measure (uniqueChars / length) was a function of LENGTH: Chinese
// prose draws from a few hundred common characters, so the ratio decays toward 0
// as text grows. On a real 12,827-row library it fell under the old 0.3 gate for
// 94% of 800-2000 char memories and 100% of those over 2000 chars — long notes
// were tagged "repetitive" for being long. These locks keep that from coming
// back; the fixture below is a genuine regression sample (old ratio 0.291 < 0.3,
// trigram ratio 0.060), not a synthetic one.

const LONG_NOTE = [
  "韦伯的科层制理论把理想型官僚组织拆成几个可检验的特征：职务分工固定、权责由成文规则界定、层级节制形成命令链条、任职者以技术资格选拔、薪酬按职级而非个人关系发放、公文与档案构成组织运行的书面基础。这套设计的目的不是效率本身，而是把统治的随意性关进规则的笼子，让命令的执行可以预期、可以追责。因此科层制的优点与缺点来自同一个源头：规则化带来稳定性，也带来僵化；非人格化带来公平，也带来冷漠。默顿对这一点的处理很典型，他提出目标置换的概念，说规则本来是达成目标的手段，运行久了就变成组织成员直接追求的目的，于是遵守程序本身成了绩效，组织对外部变化的反应速度下降。尼斯坎南则从经济人假设出发，把官僚视为预算最大化的理性行动者，用双边垄断模型解释为什么机构规模倾向于扩张而不是收缩，这与公共选择学派把政治过程还原为交换过程的做法一致。新制度主义的三条支流各有侧重：历史制度主义关心关键节点与路径依赖，强调早期制度选择如何锁定后续的可能性集合；社会学制度主义关心合法性机制，认为组织采纳某种结构往往是为了显得正当，而不是因为它在技术上更有效，于是出现制度同构的三种压力，即强制、模仿与规范；理性选择制度主义关心规则如何改变行动者的激励结构，把制度看成博弈的约束条件而非博弈的结果。奥斯特罗姆的公共池塘资源研究提供了另一条路径，她通过大量案例归纳出自主治理的八项设计原则，包括边界清晰、规则与本地条件相适应、集体选择安排的参与性、监督、渐进惩罚、冲突解决机制、对组织权的最低限度承认以及嵌套式单位的衔接，用来说明国家与市场之外还存在第三条可能的治理路径。",
  "公共政策的过程模型把政策生命周期切分成议程设定、方案形成、决策、执行、评估与终结几个阶段，好处是便于把一个连续的过程切开来观察，代价是它暗示阶段之间存在清晰的边界，而现实里议程往往在方案已经形成之后才被重新打开。金登的多源流框架对此做了修正，他用问题流、政策流与政治流三股彼此独立的溪流来解释议程的突然开启，当三股溪流在某个政策窗口处耦合，机会便出现，此时政策企业家的工作是把早已在政策共同体里流通的备选方案迅速挂到窗口上，因此所谓偶然的决策其实有长期的准备在前。间断平衡理论从另一个角度解释同一批现象，它注意到政策在很长时间里只有渐进调整，偶尔出现剧烈的方向改变，原因在于政策子系统被少数关注同一议题的行动者所垄断，一旦外部注意力被聚焦事件拉进来，子系统被打开，宏观政治的力量就会直接作用到原先封闭的领域。执行研究则提醒我们，政策文本与政策结果之间存在一个由基层官僚填充的空间，李普斯基观察到街头官僚在工作中必须处理个案，而个案的具体性迫使他们行使裁量，裁量的累积效果在某种意义上就是政策本身，这与自上而下的执行观形成对照，后者假设目标由上层确定、下级只负责忠实实现。",
  "把这三条支流放在一起看，它们的差别不在是否承认制度重要，而在制度以什么方式起作用。历史制度主义把制度看成时间中的结构，关注的是某个早期选择如何通过正反馈机制把自己固化下来，因此它最擅长解释为什么两个起点相似的体系会走向不同的终点，也最容易被批评为事后叙事，因为路径依赖往往只能在结果已经出现之后才被指认出来。社会学制度主义把制度看成意义的载体，组织的结构被采纳不一定因为它提高了效率，而因为它在一个组织场域里被认作正当，于是同构的压力从三个方向来：上级的强制、同行的模仿、专业共同体的规范。这一支最有解释力的是那些效率解释失效的现象，比如为什么不同国家的政府部门会长得越来越像，哪怕它们面对的公共问题并不相同。理性选择制度主义把制度看成激励的约束，行动者的偏好被视为给定，制度的作用是改变行动的收益矩阵，这一支的优点是模型清晰、可推演，缺点是把偏好的形成过程留在模型之外，而偏好的形成往往正是政治最要紧的部分。三种解释不是互斥的，处理同一个案例时它们常常各自说对一部分，问题在于研究者愿意为哪一种解释放弃信息量。"
].join("");

test("repetitionRatio: a long Chinese note is not repetitive (length no longer reads as repetition)", () => {
  // Guard the sample itself: it must still be long enough and character-diverse
  // enough that the OLD measure failed it — otherwise this proves nothing.
  const legacyRatio = new Set(LONG_NOTE).size / LONG_NOTE.length;
  assert.ok(LONG_NOTE.length > 1500, "fixture should be long, got " + LONG_NOTE.length);
  assert.ok(legacyRatio < 0.3,
    "fixture must still trip the old gate, got " + legacyRatio.toFixed(3) + "; if it no longer does, replace the sample");

  const ratio = repetitionRatio(LONG_NOTE);
  assert.ok(ratio < REPETITION_THRESHOLD, "long prose is not repetitive, got " + ratio.toFixed(3));

  const { score, tags } = evaluateMemoryQuality({ type: "project", title: "公共管理理论笔记", content: LONG_NOTE });
  assert.equal(score, 100, "a clean long note scores full marks");
  assert.ok(!tags.includes("repetitive"), "no repetitive tag");
});

test("repetitionRatio: stays well below the gate at every prefix length", () => {
  // The old measure went DOWN as text grew (it divided by length), so a long
  // note could never clear 0.3 no matter how original it was. Trigram ratio
  // drifts up only mildly with length (finite trigram space): on the real
  // library, stitching distinct memories up to 30,000 chars reached just 0.428.
  // So growing this genuine 1,611-char note must never approach the gate.
  for (const len of [200, 400, 800, 1200, LONG_NOTE.length]) {
    const ratio = repetitionRatio(LONG_NOTE.slice(0, len));
    assert.ok(ratio < 0.2,
      len + "-char prefix must stay far below the gate, got " + ratio.toFixed(3));
  }
});

// A path-dense technical note repeats the same install/invocation pattern on
// every line — the most "repetitive-looking" thing a real memory legitimately
// contains. On the real library the highest such note measured 0.591, so the
// threshold must sit above it; garbage fillers start at 0.75. Pinning both
// ends keeps a future "just lower it a bit" change from re-creating the false
// positives this issue is about.
test("repetitionRatio: a path-dense technical note is not filler", () => {
  const pathNote = [
    "各 agent 的 skill 安装目录与调用方式：",
    "Claude Code 的 skill 放在 ~/.claude/skills/<name>/SKILL.md，调用方式是在会话里输入 /<name>；",
    "Codex CLI 的 skill 放在 ~/.codex/skills/<name>/SKILL.md，调用方式是输入 $<name>；",
    "Cursor 的 skill 放在 .cursor/rules/<name>.mdc，随仓库提交，调用方式是自动 attach；",
    "Windsurf 的 skill 放在 .windsurf/rules/<name>.md，调用方式同样是自动 attach；",
    "Cline 的 skill 放在 .clinerules/<name>.md，调用方式是按目录层级继承；",
    "Gemini CLI 的 skill 放在 ~/.gemini/skills/<name>/SKILL.md，调用方式是 /<name>；",
    "Aider 的 skill 放在 .aider.conf.yml 的 read 列表里，调用方式是每次启动都读；",
    "每个 skill 目录里的 SKILL.md 都要有 frontmatter，写 name 与 description，",
    "description 决定它什么时候被调用，所以要写清触发条件而不是写功能概述。",
    "目录结构统一为 skills/<name>/SKILL.md，附带 references/ 与 scripts/ 子目录。",
    "同步方式：把 skills/<name>/SKILL.md 软链到各家的 skills/<name>/SKILL.md，",
    "这样只维护一份，各家读到的都是 ~/.claude/skills/<name>/SKILL.md 同一份内容。"
  ].join("");
  const ratio = repetitionRatio(pathNote);
  assert.ok(ratio > 0.3,
    "sanity: this note does repeat pattern-wise (" + ratio.toFixed(3) + "), so a low gate would flag it");
  assert.ok(ratio < REPETITION_THRESHOLD,
    "yet it is real content and must clear the gate, got " + ratio.toFixed(3));

  const { score, tags } = evaluateMemoryQuality({ type: "project", title: "各家 skill 安装目录", content: pathNote });
  assert.equal(score, 100, "path-dense note keeps full quality");
  assert.ok(!tags.includes("repetitive"), "not tagged repetitive");
});

test("repetitionRatio: duplicated content crosses the gate", () => {
  // Appending the same paragraph repeatedly is the failure mode this signal
  // exists for; x4 is where the paragraph dominates the text.
  const para = LONG_NOTE.slice(0, 339);
  assert.ok(repetitionRatio(para) < 0.1, "a single copy is clean");
  assert.ok(repetitionRatio(para.repeat(4)) > REPETITION_THRESHOLD, "four copies are caught");
});

test("repetitionRatio: degenerate filler is caught, short text is exempt", () => {
  assert.ok(repetitionRatio("好".repeat(20)) > REPETITION_THRESHOLD);
  assert.ok(repetitionRatio("a".repeat(1000)) > REPETITION_THRESHOLD);
  assert.ok(repetitionRatio("今天天气不错我们去跑步吧".repeat(5)) > REPETITION_THRESHOLD);
  assert.equal(repetitionRatio("好"), 0, "short text cannot be repetitive");
  assert.equal(repetitionRatio(""), 0);
});

test("saveWithDedupe: a long Chinese note keeps full quality (no repetitive demotion)", () => {
  const { store, service } = setup();
  const { memory } = service.saveWithDedupe({
    type: "project",
    title: "公共管理理论笔记",
    content: LONG_NOTE,
    importance: 3
  });
  const got = store.getById(memory.id);
  assert.equal(got.quality_score, 100, "long prose is not demoted");
  assert.ok(!got.tags.includes("repetitive"), "no repetitive tag persisted");
  assert.equal(got.archived, false);
});

// --- Issue #135 附属发现 1：importance ≥ exemptImportance 只降权，不静默归档 ----

test("Issue #135: importance-5 memory below archive threshold is demoted, not archived", () => {
  const { store, service } = setup();
  const { memory } = service.saveWithDedupe({
    type: "preference", title: "关键决策", content: "短", importance: 5
  });
  const got = store.getById(memory.id);
  assert.equal(got.archived, false, "importance 5 >= exemptImportance 4 → kept active");
  assert.ok(got.quality_score < 30, `score still persisted, got ${got.quality_score}`);
  assert.ok(got.tags.includes("low_quality"), "signal tag still written (verdict observable)");
});

test("Issue #135: importance-4 is exempt by default; importance-3 is still archived", () => {
  const { store, service } = setup();
  const four = service.saveWithDedupe({ type: "preference", title: "决策甲", content: "短", importance: 4 }).memory;
  const three = service.saveWithDedupe({ type: "preference", title: "决策乙", content: "短", importance: 3 }).memory;
  assert.equal(store.getById(four.id).archived, false, "importance 4 exempt by default");
  assert.equal(store.getById(three.id).archived, true, "importance 3 below the floor still archived");
});

test("Issue #135: exemptImportance=1 disables auto-archive; =5 narrows the floor", () => {
  const one = setup({ memoryQualityFilter: { enabled: true, exemptImportance: 1 } });
  const threeLow = one.service.saveWithDedupe({ type: "preference", title: "语言", content: "短", importance: 3 }).memory;
  assert.equal(one.store.getById(threeLow.id).archived, false, "exemptImportance 1 exempts everything");

  const five = setup({ memoryQualityFilter: { enabled: true, exemptImportance: 5 } });
  const four = five.service.saveWithDedupe({ type: "preference", title: "决策甲", content: "短", importance: 4 }).memory;
  assert.equal(five.store.getById(four.id).archived, true, "importance 4 no longer exempt at floor 5");
});

// --- Issue #135 附属发现 2：update 的 tags 整组替换不再抹掉系统信号标签 --------

test("Issue #135: update with tags preserves the filter's signal tags", () => {
  const { store, service } = setup();
  const { memory } = service.saveWithDedupe({ type: "preference", title: "语言", content: "短" });
  assert.ok(store.getById(memory.id).tags.includes("low_quality"), "precondition: filter tagged the row");

  service.update(memory.id, { tags: ["用户标签"], content: "补充后的完整内容，不再是短文本了" });
  const after = store.getById(memory.id);
  assert.ok(after.tags.includes("用户标签"), "user tags applied");
  assert.ok(after.tags.includes("low_quality"), "low_quality preserved through the update");
  assert.ok(after.tags.includes("short_content"), "short_content preserved too");
});

test("Issue #135: update without tags leaves the row untouched (legacy path)", () => {
  const { store, service } = setup();
  const { memory } = service.saveWithDedupe({ type: "preference", title: "语言", content: "短" });
  const before = store.getById(memory.id).tags;
  service.update(memory.id, { content: "只改内容，不带 tags 字段" });
  assert.deepEqual(store.getById(memory.id).tags, before, "no tags in patch → tags untouched");
});

test("Issue #135 review: self_referential is a signal tag and survives a tagged update", () => {
  const { store, service } = setup();
  // type 自指（title 提到自身类型标签「偏好」）→ quality-filter.js 写
  // self_referential（−15）；加短内容一起跌破归档线。SIGNAL_TAGS 清单必须
  // 覆盖它，否则带 tags 的 update 恰好把这个标签抹掉（审计线索缺口）。
  const { memory } = service.saveWithDedupe({ type: "preference", title: "偏好记录", content: "短" });
  const tagged = store.getById(memory.id);
  assert.ok(tagged.tags.includes("self_referential"), "precondition: self_referential written");

  service.update(memory.id, { tags: ["用户标签"], content: "补充后的完整内容" });
  const after = store.getById(memory.id);
  assert.ok(after.tags.includes("self_referential"), "self_referential preserved through the update");
  assert.ok(after.tags.includes("用户标签"), "user tags still applied");
});

// --- Issue #692：把「默认开」这条契约本身钉住 --------------------------------
//
// 上一版读法是 `qf?.enabled === true`：绕过 Config 的调用方（裸配置、第三方直
// 接 createService）静默拿到「关」，与 schema 的 default(true) 相反。三件事
// 一起锁：裸配置=开、显式 false 才是关、qf 缺席时阈值读取不许抛。

test("Issue #692: 裸配置（不传 memoryQualityFilter）按默认开处理——短正文被归档", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const { memory } = service.saveWithDedupe({ type: "preference", title: "语言", content: "短", importance: 3 });
  const got = store.getById(memory.id);
  assert.equal(got.archived, true, "默认开：短正文跌破归档线");
  assert.ok(got.tags.includes("low_quality"), "signal tag written");
  assert.equal(typeof got.quality_score, "number", "判据确实跑过：分数必须落库");
  assert.ok(got.quality_score < 30, `score below the archive band, got ${got.quality_score}`);
});

test("Issue #692: 显式 enabled:false 才是关——不评分、不归档、不打标", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: { memoryQualityFilter: { enabled: false } } });
  const { memory } = service.saveWithDedupe({ type: "preference", title: "语言", content: "短", importance: 3 });
  const got = store.getById(memory.id);
  assert.equal(got.archived, false, "关掉时不做归档");
  assert.equal(got.quality_score ?? null, null, "关掉时不写分（NULL/未设，不是 0）");
  assert.ok(!got.tags.includes("low_quality"), "关掉时不写判据标签");
});

