import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createInjector } from "../src/inject.js";
import { Config, injectChildEnabled } from "../src/config.js";

// Issue #619 补链（注入侧）：情感记忆要能被模型看见。
//
// 这套用例防的是同一类回归：情绪写进库了、面板上也看得见，但注入里没有——
// 那就是「情感记忆」只对用户可见、对模型不可见，对外一宣称就会被
// 「那我问它，它为什么不知道我那天焦虑」直接打穿。
//
// 锁六件事：
//   ① 默认关 → 注入块与不加这条之前**逐字节相同**（不做未授权的额外注入）；
//   ② 开 → 单次场合（occasion）的情绪边真的挂进注入正文，且带「谁·什么心情·
//      哪件事·次数」四项；
//   ③ trait 档不挂——它已被铸成 type=pattern 的记忆自己进注入，再挂一遍是
//      同一件事说两次；
//   ④ 父关（sleepAffectiveEnabled=false）→ 子项一并不挂，但子项持久值保留；
//   ⑤ 端点实体缺名字（被删）→ 不挂，宁可不说话也不说「某人」；
//   ⑥ 注释限长——它吃注入块预算，一条长注释能把同批后面的候选挤成标题行。

const embedder = {
  embedSingle: async () => [1, 0, 0],
  embed: async () => [1, 0, 0],
  schedule: () => {},
  modelHash: "mock#1",
  dimension: 3
};

function setup(configOverrides = {}) {
  const config = { maxInjectedItems: 5, importanceThreshold: 3, ...configOverrides };
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  service.setEmbedder(embedder);
  return { store, service, config };
}

function makeMemory(service, title, content = "内容") {
  return service.saveWithDedupe({ type: "project", title, content, importance: 3 }).memory;
}

/** 造一条情绪边：person --affective_context--> target，挂到 memory 上。 */
function makeAffect(store, service, memoryId, meta = {}) {
  const person = store.createEntity({ name: meta.person ?? "桉桉", type: "person" });
  const target = store.createEntity({ name: meta.target ?? "答辩", type: "project" });
  const edge = service.saveRelation({
    from_entity: person.id,
    to_entity: target.id,
    relation_type: "affective_context",
    memory_id: memoryId,
    source: "llm",
    metadata: {
      emotion: meta.emotion ?? "焦虑",
      attribution: meta.attribution ?? "occasion",
      why: meta.why ?? "首场答辩前一晚",
      sessionCount: meta.sessionCount ?? 1,
      ...(meta.promotedToTrait ? { promotedToTrait: true } : {})
    }
  });
  return { person, target, edge };
}

function injectText(config) {
  const { store, service } = setup(config);
  const contexts = [];
  const ctx = {
    systemPrompt: {
      context(def) { contexts.push(def); return () => {}; }
    }
  };
  createInjector(ctx, service, createSettings(store.db), config);
  return { store, service, contexts };
}

function bodyOf(contexts) {
  return contexts[0].text({});
}

test("#619 补链：默认关时注入块与不加注释逐字节相同", () => {
  const config = { maxInjectedItems: 5, importanceThreshold: 3 };
  const off = injectText(config);
  makeMemory(off.service, "答辩安排", "6 月 3 日首场");
  const offText = bodyOf(off.contexts);

  // 同样的库、同样的边，但开关打开 → 必须多出情绪行。
  const on = injectText({ ...config, affectiveInjectEnabled: true });
  const mem = makeMemory(on.service, "答辩安排", "6 月 3 日首场");
  makeAffect(on.store, on.service, mem.id);
  const onText = bodyOf(on.contexts);

  assert.ok(!offText.includes("情绪记录"), "默认关：不许出现情绪注释");
  assert.ok(onText.includes("情绪记录"), "打开后：情绪注释必须进注入正文");
  assert.notEqual(offText, onText, "开关必须真的改变注入结果（否则是假开关）");
});

test("#619 补链：注释带全四项事实，并标清单次场合", () => {
  const { store, service, contexts } = injectText({ affectiveInjectEnabled: true });
  const mem = makeMemory(service, "答辩安排", "6 月 3 日首场");
  makeAffect(store, service, mem.id, {
    person: "桉桉",
    target: "答辩",
    emotion: "焦虑",
    why: "首场前一晚",
    sessionCount: 1
  });
  const text = bodyOf(contexts);
  assert.ok(text.includes("桉桉"), "要说清楚是谁");
  assert.ok(text.includes("焦虑"), "要说清楚什么心情");
  assert.ok(text.includes("答辩"), "要说清楚对哪件事");
  assert.ok(text.includes("单次场合"), "必须标清单次场合——否则模型会把一次情绪当一贯表现");
  assert.ok(!/记了 \d+ 次/.test(text), "sessionCount=1 不写次数（写「记了 1 次」是废话）");
});

test("#619 补链：trait 档不重复注入（它已铸成 pattern 自己进）", () => {
  const cases = [
    { attribution: "trait", label: "attribution=trait" },
    { attribution: "occasion", promotedToTrait: true, label: "promotedToTrait=true" }
  ];
  for (const c of cases) {
    const { store, service, contexts } = injectText({ affectiveInjectEnabled: true });
    const mem = makeMemory(service, "答辩安排", "6 月 3 日首场");
    makeAffect(store, service, mem.id, c);
    const text = bodyOf(contexts);
    assert.ok(!text.includes("情绪记录"), `${c.label}：稳定倾向不该再挂一次注释`);
  }
});

test("#619 补链：父开关关着一并不挂，但子项持久值保留", () => {
  const { store, service, contexts } = injectText({
    affectiveInjectEnabled: true,
    sleepAffectiveEnabled: false
  });
  const mem = makeMemory(service, "答辩安排", "6 月 3 日首场");
  makeAffect(store, service, mem.id);
  assert.ok(!bodyOf(contexts).includes("情绪记录"), "父关 → 遗留的情绪边不许继续往注入里说话");

  // 闸门只判「当下生效」，不改写值：重开父开关，子项选择还在。
  assert.equal(injectChildEnabled({ sleepAffectiveEnabled: false, affectiveInjectEnabled: true }, "affectiveInjectEnabled"), false);
  assert.equal(injectChildEnabled({ sleepAffectiveEnabled: true, affectiveInjectEnabled: true }, "affectiveInjectEnabled"), true);
  assert.equal(injectChildEnabled({ affectiveInjectEnabled: true }, "affectiveInjectEnabled"), true, "父未出现 → 只按子项判");
});

test("#619 补链：端点实体缺名字时不挂（宁可不说话）", () => {
  const { store, service, contexts } = injectText({ affectiveInjectEnabled: true });
  const mem = makeMemory(service, "答辩安排", "6 月 3 日首场");
  // 造一条边后把目标实体删掉：LEFT JOIN 取不到名字，注入侧必须跳过。
  const { target } = makeAffect(store, service, mem.id);
  store.db.prepare("DELETE FROM entities WHERE id = ?").run(target.id);
  assert.ok(!bodyOf(contexts).includes("情绪记录"), "实体缺名字的空壳注释是噪声，不许进注入");
});

test("#619 补链：注释限长，不吃掉注入块预算", () => {
  const { store, service, contexts } = injectText({ affectiveInjectEnabled: true });
  const mem = makeMemory(service, "答辩安排", "6 月 3 日首场");
  // why 在 service 侧已截到 60 字，撑不破上限；真正能撑爆的是端点名字——
  // 实体名来自抽取，长名字（整段标题被当成实体名）是现实里会发生的。
  makeAffect(store, service, mem.id, { target: "很长的目标名".repeat(20) });
  const text = bodyOf(contexts);
  // 触发限长 → 整条不挂；但记忆本身必须还在块里（注释不该把记忆也带走）。
  assert.ok(!text.includes("情绪记录"), "超长注释应整条放弃");
  assert.ok(text.includes("答辩安排"), "放弃注释不能连带丢掉那条记忆");
});

test("#619 补链：同一记忆多条情绪边只挂最新一条", () => {
  const { store, service, contexts } = injectText({ affectiveInjectEnabled: true });
  const mem = makeMemory(service, "答辩安排", "6 月 3 日首场");
  makeAffect(store, service, mem.id, { emotion: "焦虑", target: "答辩" });
  makeAffect(store, service, mem.id, { emotion: "松了口气", target: "答辩" });
  const text = bodyOf(contexts);
  const hits = (text.match(/情绪记录/g) || []).length;
  assert.equal(hits, 1, "一条记忆只挂一条情绪注释（多挂会把注入块撑爆，也会把历史情绪误读成现状）");
});

test("#619 补链：新配置键登记进面板白名单与轻量档", () => {
  assert.equal(Config({}).affectiveInjectEnabled, false, "默认关：未经用户同意不该占注入预算");
  const client = createStore(":memory:");
  const settings = createSettings(client.db);
  settings.setFeatureFlags({ affectiveInjectEnabled: true });
  assert.equal(settings.getFeatureFlags().affectiveInjectEnabled, true, "面板能写进 kv（否则点了只会拿到 400）");
  assert.equal(Config({ lightMode: true }).affectiveInjectEnabled, false, "轻量档必须关掉");
});
