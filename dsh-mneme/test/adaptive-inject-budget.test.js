// Issue #239（第 5 项）：注入条数的查询自适应。
// 判据只看查询本身（零成本，不做探针检索——先探针检索等于白付一次 fuseRecall），
// 且只做**单向收缩**：模糊维持上限、确定收缩，绝不越过 maxInjectedItems——注入
// 相关却带偏生成的内容可能比不注入更糟。
import test from "node:test";
import assert from "node:assert/strict";
import { needsBroadRecall, adaptiveInjectBudget } from "../src/search/adaptive.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createInjector } from "../src/inject.js";
import { createSettings } from "../src/settings.js";
import { testConfig } from "./helpers/test-config.js";

function injectorSetup(over = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const settings = createSettings(store.db);
  const contexts = [];
  const ctx = { systemPrompt: { context(def) { contexts.push(def); return () => {}; } } };
  createInjector(ctx, service, settings, { maxInjectedItems: 4, importanceThreshold: 3, ...over });
  return { store, service, contexts };
}

// lastUserQuery 读的是 materialized 会话日志（DSH ≥0.1.2-rc 走 snapshotEvents）。
function ctxWithQuery(text) {
  return {
    agent: {
      session: {
        events: [{ type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text }] } }]
      }
    }
  };
}

function seed(service, n = 6) {
  for (let i = 0; i < n; i++) {
    service.saveWithDedupe({ type: "project", title: `项目${i}`, content: `内容${i}`, importance: 5 });
  }
}

const injectedCount = (text) => [0, 1, 2, 3, 4, 5].filter((i) => text.includes(`内容${i}`)).length;

test("#239-5 宽召回判据：回指/时间线索与极短查询算模糊，其余算确定", () => {
  // 模糊：回指或时间线索（中英各有）
  for (const q of ["上次那个方案怎么样了", "我们之前讨论过什么", "还记得我提过的偏好吗",
                   "what did we discuss last time", "do you remember my preference", "remind me"]) {
    assert.equal(needsBroadRecall(q), true, `${q} 应判为模糊`);
  }
  // 模糊：极短（与 adaptiveThreshold 对 <5 字符的判断同源：几乎匹配任何东西）
  assert.equal(needsBroadRecall("你好"), true);
  assert.equal(needsBroadRecall(""), true, "拿不到查询时不猜，维持现状");
  // 确定：具体技术问句
  for (const q of ["pnpm MODULE_NOT_FOUND 怎么修", "把 settings.js 里的白名单登记补上", "node:sqlite 的 WAL 配置项在哪"]) {
    assert.equal(needsBroadRecall(q), false, `${q} 应判为确定`);
  }
});

test("#239-5 注入预算：确定收缩到一半（下限 1），模糊维持上限，绝不越界", () => {
  assert.equal(adaptiveInjectBudget("pnpm MODULE_NOT_FOUND 怎么修", 5), 3, "确定 → 收缩到一半");
  assert.equal(adaptiveInjectBudget("上次讨论的方案", 5), 5, "模糊 → 维持上限");
  assert.equal(adaptiveInjectBudget("pnpm MODULE_NOT_FOUND 怎么修", 1), 1, "下限 1");
  assert.equal(adaptiveInjectBudget("pnpm MODULE_NOT_FOUND 怎么修", 0), 0, "0 = 不注入，flag 打开也不该变 1");
  assert.equal(adaptiveInjectBudget("any", undefined), undefined, "非法上限原样返回，不猜");
});

test("#239-5 默认关：开关未开时注入条数与查询无关（行为逐字节不变）", () => {
  const { contexts, service } = injectorSetup();
  seed(service);
  assert.equal(injectedCount(contexts[0].text(ctxWithQuery("pnpm MODULE_NOT_FOUND 怎么修"))), 4);
  assert.equal(injectedCount(contexts[0].text(ctxWithQuery("上次讨论的方案"))), 4);
});

test("#239-5 开关打开：确定查询少注入，模糊查询保持上限", () => {
  const { contexts, service } = injectorSetup({ injectUncertaintyAdaptive: true });
  seed(service);
  assert.equal(injectedCount(contexts[0].text(ctxWithQuery("pnpm MODULE_NOT_FOUND 怎么修"))), 2,
    "确定 → 注入条数减半");
  assert.equal(injectedCount(contexts[0].text(ctxWithQuery("上次讨论的方案"))), 4,
    "模糊 → 维持 maxInjectedItems");
});

test("#239-5 拿不到查询（无会话日志）时维持上限，不因开关而减少", () => {
  const { contexts, service } = injectorSetup({ injectUncertaintyAdaptive: true });
  seed(service);
  assert.equal(injectedCount(contexts[0].text({})), 4, "退化路径不猜、不缩");
});
