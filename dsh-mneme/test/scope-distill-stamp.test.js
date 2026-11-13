// 把 CodeRabbit 在 PR #434 上核出的三条钉死。
// 前两条是「读起来对、跑起来错」的形态：注释写着 A，代码实际做 B。
// 第三条是契约与实现的落差：文件头写着「任何异常都被吞掉」，但只吞了一半。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createScopeResolver } from "../src/scope.js";
import { createSummarizer } from "../src/summarize.js";
import { testConfig } from "./helpers/test-config.js";

function summarizerHarness() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  const events = [];
  const ctx = {
    on(name, fn) { events.push({ name, fn }); return () => {}; },
    llm: {
      stream() {
        const json = JSON.stringify([
          { type: "decision", title: "选型", content: "确定用 node:sqlite", importance: 4 }
        ]);
        return (async function* () {
          yield { type: "block-start", block: { type: "text" } };
          yield { type: "text-delta", delta: json };
          yield { type: "block-end", block: { type: "text" } };
          yield { type: "finish", kind: "ok" };
        })();
      }
    }
  };
  createSummarizer(ctx, service, {
    autoSummarize: true,
    scopeEnabled: true,
    summarizeDedupeMode: "title",
    summarizeDedupeWindowHours: 24,
    summarizeMinIntervalMinutes: 0,
    summarizeMaxRunsPerSession: 0,
    distillRateLimitIntervalMs: 0
  }, {});
  return { store, service, handler: events.find((e) => e.name === "session/event").fn };
}

const SID = "s-scope-dedupe";

function sessionOf(scope) {
  return {
    id: SID,
    header: { agentPreset: scope, cwd: "C:\\work\\probe" },
    requestHeader: () => ({ config: testConfig({ provider: "deepseek", model: "deepseek-chat" }) }),
    events: [
      { seq: 1, type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "提问" }] } },
      { seq: 2, type: "turn/end" }
    ]
  };
}

// 回归形状：scopeEnabled 与 summarizeDedupeMode 同开时，第二轮蒸馏会命中第一轮
// 的行。findSessionDuplicate 的候选筛（type + source + 时间窗）不看 scope，真正
// 决定并不并的是 saveWithDedupe 的 scopeMatches 门。调用方若用「命中就不传章」
// 表达「不重贴」，新条目的 scope 会变成 null：与已带章的候选不等 → 门拒 → 回落
// 新建，而那一行也是新行，同样该带章却没有章。结果是同题两行、一行 auto 一行
// NULL——跨作用域隔离没做成，同题重复倒留下了。
test("scope + dedupe: a scope-gate rejection still stamps the replacement row", async () => {
  const { store, service, handler } = summarizerHarness();
  // 同 source 的存量未标注行：正是 scopeEnabled 之前写下的那些行的形状。
  service.saveWithDedupe({
    type: "decision", title: "选型", content: "旧内容", source: `session:${SID}`, importance: 4
  });

  await handler(sessionOf("amarre"), { seq: 2, type: "turn/end" });

  const rows = store.list({ limit: null });
  assert.equal(rows.length, 2, "跨作用域不并入，存量行原样留着");
  const stamped = rows.filter((r) => r.agent_scope === "amarre");
  assert.equal(stamped.length, 1, "回落新建的那一行必须带章（它同样是新行）");
  assert.equal(stamped[0].workspace_scope, "C:\\work\\probe", "两维都盖");
});

// 反向锁：同作用域同题照旧并入，且不新造行、不把既有行的来源升级成 explicit
// （升级只在用户显式声明时发生，见 service.js 的 scopeUpgrade 分支）。
test("scope + dedupe: a same-scope candidate still merges and keeps its source", async () => {
  const { store, service, handler } = summarizerHarness();
  service.saveWithDedupe({
    type: "decision", title: "选型", content: "旧内容", source: `session:${SID}`,
    importance: 4,
    agent_scope: "amarre", agent_scope_source: "auto",
    workspace_scope: "C:\\work\\probe", workspace_scope_source: "auto"
  });

  await handler(sessionOf("amarre"), { seq: 2, type: "turn/end" });

  const rows = store.list({ limit: null });
  assert.equal(rows.length, 1, "同作用域同题：并入而不是新造");
  assert.equal(rows[0].agent_scope_source, "auto", "并入不把来源升级成 explicit");
});

// scope.js 文件头写着硬约束「任何异常都被吞掉」，但那条约束此前只覆盖了
// session.header 的取得与 registry 查询——header 的**字段**读取裸着。宿主给出
// 会抛错的 accessor 时（sessionOf / sessionKeyOf 就是为同一类宿主写的 try 包），
// 异常会穿出解析器：蒸馏路径上一个窗口的记忆与游标一起丢，工具路径上是一次
// memory_save 直接失败。锁的是「字段级读取也必须各自护住」。
test("scope resolver: a throwing header accessor never escapes the resolver", () => {
  const resolve = createScopeResolver({ ctx: {}, config: testConfig({ scopeEnabled: true }), logger: {} });
  const session = {
    id: "s-throw",
    get header() {
      return {
        get agentPreset() { throw new Error("host accessor exploded"); },
        get cwd() { throw new Error("host accessor exploded"); }
      };
    }
  };

  let value = null;
  assert.doesNotThrow(() => { value = resolve({ agent: { session } }); });
  assert.deepEqual(value, { agent_scope: null, workspace_scope: null }, "取不到就落 NULL，不是抛出");
});

// 居中 sheet 是「宿主没有右栏服务」时的唯一完整视图入口（PipelineHeaderEntry 的
// fallback）。它 portal 到 body，焦点默认留在 trigger 上，而挂在 sheet 元素上的
// onKeyDown 既因没有 tabIndex 不被聚焦、也收不到外部键盘事件 —— Escape 于是不
// 生效，键盘用户只剩 Tab 摸到关闭按钮一条路。这里锁住「焦点进得去、Esc 出得来」
// 两件事都在；做法与 MemoryOverlay 一致（打开时 focus，Esc 挂在 window 上）。
test("pipeline sheet fallback is keyboard reachable: focus moves in, Escape gets out", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(join(root, "lib/client.js"), "utf8");

  assert.match(src, /ref: sheetRef,\s*\n\s*tabIndex: -1,/, "sheet 必须可聚焦（否则 onKeyDown 收不到事件）");
  assert.match(src, /if \(!sheetOpen\) return undefined;\s*\n\s*if \(sheetRef\.current\) sheetRef\.current\.focus\(\);/,
    "打开时必须把焦点移进 sheet");
  assert.match(src, /window\.addEventListener\("keydown", onKey\)/, "Escape 必须挂在 window 上收");
});