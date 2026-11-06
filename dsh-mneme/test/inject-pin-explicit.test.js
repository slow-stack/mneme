import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

// #249 第二批（显式 pin）验收。判据从「类型是 constraint/preference」换成
// 「用户亲手钉在 pinned_memories 里」。
//
// 为什么需要这一层：旧的类型口径把 1163 条 constraint/preference 全当成 pin，
// 而 pin 预算最多 5 条，于是池子永远比预算大两个数量级——真正该每轮必进的
// 「提交署名硬约束」「拒绝谄媚」在 200 行规则窗口里排 133 / 157 名，就算封顶
// 和补位都修好也轮不到。根因是「type 就算 pin」这个隐含假设本身。
//
// 本文件按 Amarre 的验收清单逐条锁：
//   ① 表空 → 回落旧类型口径（升级即等价，她钉第一条才切换）
//   ② pin 一条**不在 200 行窗口内**的记忆仍能注入（补丁存在的理由本身）
//   ③ pin 一条 **pattern** 类型能注入（写得最全的那版往往是 pattern）
//   ④ pin 的行越权（strictScope 不通过）→ 不进块
//   ⑤ pin 的行属暂停作用域 → 不进块
//   ⑥ pinnedInjectBudget === 0 → shown=0 且注入序列与改前完全一致
//   ⑦ 被 pin 的行 forgotten/archived → 不进块
//
// ②③ 的种子必须造 >200 条同 importance 的行，否则种子库窗口装得下、
// 用例假绿——「窗口外」这件事根本没被造出来。

function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service };
}

const titlesOf = (list) => list.map((m) => m.title);

// 造 n 条 importance=5 的普通条目。updated_at 递增，于是「最先造的」在
// store.list 的 (importance DESC, updated_at DESC, id) 序里排在最后，
// 200 行窗口装不下它——这就是「窗口外」的造法。
function seedCrowd(service, n, prefix = "普通条目") {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const m = service.saveWithDedupe({
      type: "decision",
      title: `${prefix}${i}`,
      content: `第 ${i} 条与 pin 无关的普通决定，用来把窗口撑满`,
      importance: 5
    }).memory;
    ids.push(m.id);
  }
  return ids;
}

function saveOne(service, { type = "preference", title, content, importance = 5, extra = {} }) {
  return service.saveWithDedupe({ type, title, content, importance, ...extra }).memory;
}

test("表空时回落旧类型口径：pattern 不会被当成 pin", () => {
  // 升级后 pinned_memories 是空表。若此时直接改读表，她现有的「按类型挑 5 条」
  // 会静默降到 0 条——所以空表必须回落旧口径，升级即等价。
  const { store, service } = setup({ maxInjectedItems: 5, pinnedInjectBudget: 5, importanceThreshold: 3 });
  seedCrowd(service, 10);
  saveOne(service, { type: "preference", title: "旧口径偏好", content: "类型即 pin 的旧口径下它该进块" });
  // pattern 是旧口径的反证：它写得最全，但不在 PINNED_MEMORY_TYPES 里，
  // 表空时不得被当成 pin。
  saveOne(service, { type: "pattern", title: "旧口径模式", content: "pattern 不在旧口径的 pin 类型里" });

  assert.equal(store.countPinned(), 0, "前提：pin 表是空的");

  const pinnedStats = {};
  const selected = service.injectCandidates({ query: "与 pin 无关的问题", maxItems: 5, pinnedStats });

  assert.equal(pinnedStats.source, "type-fallback", "空表必须标成 type-fallback");
  assert.equal(pinnedStats.outsideWindow, 0, "回落口径只能从窗口里取，不该有窗口外补位");
  assert.equal(pinnedStats.shown, 1, "旧口径下只有那一条 preference 算 pin");
  assert.ok(titlesOf(selected).slice(0, 1).includes("旧口径偏好"), "旧口径的 pin 仍要前置");
  assert.ok(!titlesOf(selected).includes("旧口径模式"), "表空时 pattern 不得被当成 pin");
});

test("pin 一条不在 200 行窗口内的记忆仍能注入", () => {
  // 这是整个第二层存在的理由：i=5 的 1143 条里 943 条（83%）进不了 200 行窗口，
  // 靠相关性排序永远轮不到「署名」「拒绝谄媚」这类稳定偏好。
  const { store, service } = setup({ maxInjectedItems: 5, pinnedInjectBudget: 5, importanceThreshold: 3 });
  // 必须先造 200+ 条同 importance 的行，否则窗口装得下、这条用例假绿。
  const crowd = seedCrowd(service, 220);
  // crowd[0] 最早造 → updated_at 最小 → 排在 220 条的最后 → 在 200 行窗口外。
  const target = crowd[0];

  // 先证明它真的在窗口外：不改 pin 时它进不了候选池。
  const before = service.injectCandidates({ query: "与 pin 无关的问题", maxItems: 5, pinnedStats: {} });
  assert.ok(
    !before.some((m) => m.id === target),
    "前提：未 pin 时这条在 200 行窗口外，进不了注入块"
  );

  store.pinMemory(target);
  assert.equal(store.countPinned(), 1);

  const pinnedStats = {};
  const after = service.injectCandidates({ query: "与 pin 无关的问题", maxItems: 5, pinnedStats });

  assert.equal(pinnedStats.source, "explicit", "表非空 → explicit 口径");
  assert.equal(pinnedStats.outsideWindow, 1, "这条是点查补回来的，必须计入 outsideWindow");
  assert.equal(pinnedStats.shown, 1, "窗口外的 pin 也要占一个 pin 槽");
  assert.ok(after.some((m) => m.id === target), "pin 一条窗口外的记忆，它必须真的进块");
  assert.ok(titlesOf(after).slice(0, 1).includes("普通条目0"), `pin 前置到块首：${titlesOf(after).join(" / ")}`);
});

test("pin 一条 pattern 类型能注入", () => {
  // 语义去重扫出 10 组，内容最全的那版 8 组是 pattern（「带学铁律」449 字含
  // 「一次一个概念块」，限类型就只能拿 141 字的 constraint 残缺版）。
  // 所以 explicit 口径的 filter 里不能出现 PINNED_MEMORY_TYPES。
  const { store, service } = setup({ maxInjectedItems: 5, pinnedInjectBudget: 5, importanceThreshold: 3 });
  seedCrowd(service, 10);
  const m = saveOne(service, { type: "pattern", title: "带学铁律全版", content: "一次只讲一个概念块，讲完停下等她回应" });
  store.pinMemory(m.id);

  const pinnedStats = {};
  const selected = service.injectCandidates({ query: "与 pin 无关的问题", maxItems: 5, pinnedStats });

  assert.equal(pinnedStats.source, "explicit");
  assert.equal(pinnedStats.shown, 1, "pattern 被显式钉住就该进 pin 池");
  assert.ok(titlesOf(selected).includes("带学铁律全版"), `pattern 类型的 pin 必须进块：${titlesOf(selected).join(" / ")}`);
});

test("pin 的行越权时不得进块（strictScope）", () => {
  // pin 不是绕过闸门的通道：补位与点查都发生在 strictScope 之前，硬墙照旧生效。
  const { store, service } = setup({
    maxInjectedItems: 5,
    pinnedInjectBudget: 5,
    importanceThreshold: 3,
    strictScope: true
  });
  seedCrowd(service, 10);
  const m = saveOne(service, {
    title: "越权偏好",
    content: "只属于 proj-a 的偏好，不该泄进 proj-b 的注入块",
    extra: { workspace_scope: "proj-a", workspace_scope_source: "explicit" }
  });
  store.pinMemory(m.id);

  const pinnedStats = {};
  const selected = service.injectCandidates({
    query: "与 pin 无关的问题",
    maxItems: 5,
    scope: { agent_scope: null, workspace_scope: "proj-b" },
    pinnedStats
  });

  assert.equal(pinnedStats.source, "explicit", "前提：确实走了 explicit 口径");
  assert.equal(pinnedStats.shown, 0, "被 strictScope 挡下的行不能算成已 pin");
  assert.ok(!titlesOf(selected).includes("越权偏好"), `越权 pin 不得进块：${titlesOf(selected).join(" / ")}`);
});

test("pin 的行属暂停作用域时不得进块（scopeState）", () => {
  const { store, service } = setup({
    maxInjectedItems: 5,
    pinnedInjectBudget: 5,
    importanceThreshold: 3,
    scopeState: { enabled: true, enforce: true }
  });
  seedCrowd(service, 10);
  const m = saveOne(service, {
    title: "暂停域偏好",
    content: "属于 proj-a 的偏好，而 proj-a 此刻被按下",
    extra: { workspace_scope: "proj-a", workspace_scope_source: "explicit" }
  });
  store.pinMemory(m.id);
  service.setScopeState({ dimension: "workspace", scope_value: "proj-a", state: "paused" });

  const pinnedStats = {};
  const selected = service.injectCandidates({ query: "与 pin 无关的问题", maxItems: 5, pinnedStats });

  assert.equal(pinnedStats.source, "explicit");
  assert.equal(pinnedStats.shown, 0, "被暂停闸拦下的行不能算成已 pin");
  assert.ok(!titlesOf(selected).includes("暂停域偏好"), `暂停作用域的 pin 不得进块：${titlesOf(selected).join(" / ")}`);
});

test("pinnedInjectBudget=0 时表里有 pin 也不得改变注入序列", () => {
  // 关闭态必须与改动前逐字节一致：预算 0 时整段不执行——不读表、不改 candidates。
  const { store, service } = setup({ maxInjectedItems: 5, pinnedInjectBudget: 0, importanceThreshold: 3 });
  seedCrowd(service, 10);
  const m = saveOne(service, { title: "被钉但预算关闭", content: "预算 0 时它不该被前置" });
  store.pinMemory(m.id);
  assert.equal(store.countPinned(), 1, "前提：表里确实有 pin 行");

  const pinnedStats = {};
  const selected = service.injectCandidates({ query: "与 pin 无关的问题", maxItems: 5, pinnedStats });

  assert.equal(pinnedStats.shown, 0, "预算 0 → pin 池关闭");
  assert.equal(pinnedStats.source, undefined, "关闭态不该标口径");
  assert.equal(pinnedStats.outsideWindow, 0);
  assert.equal(selected.length, 5, "槽位数不变");
  assert.ok(!titlesOf(selected).includes("被钉但预算关闭"), "关闭态下 pin 不得被前置");
});

test("被 pin 的行 forgotten/archived 后不得进块", () => {
  // pin 不是复活通道：点查取回的行照样要过遗忘/归档判定。
  const { store, service } = setup({ maxInjectedItems: 5, pinnedInjectBudget: 5, importanceThreshold: 3 });
  seedCrowd(service, 10);
  const forgotten = saveOne(service, { title: "钉过又遗忘", content: "钉住之后被遗忘，不该再进块" });
  const archived = saveOne(service, { title: "钉过又归档", content: "钉住之后被归档，不该再进块" });
  store.pinMemory(forgotten.id);
  store.pinMemory(archived.id);
  service.setForget(forgotten.id, true);
  service.setArchived(archived.id, true);

  const pinnedStats = {};
  const selected = service.injectCandidates({ query: "与 pin 无关的问题", maxItems: 5, pinnedStats });

  assert.equal(pinnedStats.shown, 0, "遗忘/归档的 pin 不得占槽");
  assert.ok(!titlesOf(selected).includes("钉过又遗忘"), "遗忘的 pin 不得进块");
  assert.ok(!titlesOf(selected).includes("钉过又归档"), "归档的 pin 不得进块");
});

// --- 判据：看「能用的」而不是「表里有几行」 ---------------------------------
//
// 下面三条是同一个 bug 的三个面：pin 行会在 memories 那边被归档 / 遗忘 / 硬删，
// 而 pinned_memories 对这三种一无所知。若判据写成 countPinned() > 0，只要表里
// 还剩一行（哪怕那一行早已归档），pinMode 就永远钉在 explicit、eligible 恒空
// → pin 全灭且**永不回落**，无日志无报错。这正是这批改动要治的静默失败。

function pinTargets(service, titles) {
  return titles.map((title) => saveOne(service, { title, content: `${title} 的正文` }));
}

test("钉过的行被归档后：回落旧口径，而不是 pin 全灭", () => {
  const { store, service } = setup({ maxInjectedItems: 5, pinnedInjectBudget: 5, importanceThreshold: 3 });
  seedCrowd(service, 10);
  const legacy = saveOne(service, { type: "preference", title: "旧口径仍该进", content: "类型口径下它每轮前置" });
  const [pinned] = pinTargets(service, ["钉过又归档"]);
  store.pinMemory(pinned.id);
  service.setArchived(pinned.id, true);

  const pinnedStats = {};
  const selected = service.injectCandidates({ query: "与 pin 无关的问题", maxItems: 5, pinnedStats });

  assert.equal(store.countPinned(), 1, "前提：表里还留着那一行（归档不会删 pin 行）");
  assert.equal(pinnedStats.source, "fallback-none-usable", "钉过但一条都用不了 → 必须留痕，不能静默");
  assert.ok(titlesOf(selected).includes("旧口径仍该进"), `archived 掉唯一 pin 后应回落类型口径：${titlesOf(selected).join(" / ")}`);
  assert.ok(!titlesOf(selected).includes("钉过又归档"), "归档的 pin 不得复活");
  assert.ok(legacy.id);
});

test("钉过的行被遗忘后：同样回落，而不是卡死", () => {
  const { store, service } = setup({ maxInjectedItems: 5, pinnedInjectBudget: 5, importanceThreshold: 3 });
  seedCrowd(service, 10);
  saveOne(service, { type: "preference", title: "旧口径仍该进", content: "类型口径下它每轮前置" });
  const [pinned] = pinTargets(service, ["钉过又遗忘"]);
  store.pinMemory(pinned.id);
  service.setForget(pinned.id, true);

  const pinnedStats = {};
  const selected = service.injectCandidates({ query: "与 pin 无关的问题", maxItems: 5, pinnedStats });

  assert.equal(pinnedStats.source, "fallback-none-usable");
  assert.ok(titlesOf(selected).includes("旧口径仍该进"), `forgotten 掉唯一 pin 后应回落类型口径：${titlesOf(selected).join(" / ")}`);
  assert.ok(!titlesOf(selected).includes("钉过又遗忘"), "遗忘的 pin 不得复活");
});

test("钉过的行被硬删后：没有可用行就回落，孤儿行还会被清掉", () => {
  const { store, service } = setup({ maxInjectedItems: 5, pinnedInjectBudget: 5, importanceThreshold: 3 });
  seedCrowd(service, 10);
  saveOne(service, { type: "preference", title: "旧口径仍该进", content: "类型口径下它每轮前置" });
  const [pinned] = pinTargets(service, ["钉过又被删"]);
  store.pinMemory(pinned.id);
  service.remove(pinned.id);

  // remove() 走的清理路径要顺带清掉 pin 行（防攒垃圾）；但即使没清，回落也必须
  // 成立——判据看的是「能不能用」，不是「表里有没有」。
  assert.equal(store.countPinned(), 0, "硬删记忆时要顺带清掉它的 pin 行，否则孤儿会越攒越多");

  const pinnedStats = {};
  const selected = service.injectCandidates({ query: "与 pin 无关的问题", maxItems: 5, pinnedStats });

  assert.equal(pinnedStats.source, "type-fallback", "表被清空后就是「从没钉过」，走旧口径");
  assert.ok(titlesOf(selected).includes("旧口径仍该进"), `全部 pin 失效后应回落类型口径：${titlesOf(selected).join(" / ")}`);
});

test("钉了多条、只有一部分还能用：留 explicit，只注入能用的那几条", () => {
  // 关键取舍：不能因为「有 2 条归档」就整段回落到类型口径——那会突然冒出一批
  // 她根本没钉过的条目，比少注入更糟。只要还有一条能用，口径就是 explicit。
  const { store, service } = setup({ maxInjectedItems: 5, pinnedInjectBudget: 5, importanceThreshold: 3 });
  seedCrowd(service, 10);
  saveOne(service, { type: "preference", title: "不该冒出来的旧口径条目", content: "explicit 下它不该被当 pin" });
  const [live, gone] = pinTargets(service, ["还活着的那条 pin", "已经归档的那条 pin"]);
  store.pinMemory(live.id);
  store.pinMemory(gone.id);
  service.setArchived(gone.id, true);

  const pinnedStats = {};
  const selected = service.injectCandidates({ query: "与 pin 无关的问题", maxItems: 5, pinnedStats });

  assert.equal(pinnedStats.source, "explicit", "还有一条能用 → 保持 explicit");
  assert.equal(pinnedStats.shown, 1, "只注入能用的那一条");
  assert.ok(titlesOf(selected).includes("还活着的那条 pin"), "能用的 pin 必须进块");
  assert.ok(!titlesOf(selected).includes("已经归档的那条 pin"), "归档的 pin 不得进块");
  assert.ok(
    !titlesOf(selected).includes("不该冒出来的旧口径条目"),
    "explicit 下不得回落类型口径——否则会冒出她没钉过的条目"
  );
  assert.ok(!titlesOf(selected).slice(0, 1).includes("不该冒出来的旧口径条目"));
});
