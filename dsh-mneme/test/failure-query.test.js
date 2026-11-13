import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";
import { testConfig } from "./helpers/test-config.js";

// v0.9.0：failure_memories.query 的起点是 2,367 行里只有 69 行非空（2.9%）。
// 但那个分母误导——按「expected 逐字落在某次 dream_runs.decisions 里」归属后
// （2026-10-14 实测，D:/DSH/.dsh/memory/memory.db）：
//   dream 侧 2,118 行，query 非空率 0.0%——机器巩固没有用户在场，本该为空；
//   入口侧   249 行，query 非空率 27.7%——模型自愿填 reason 的那部分。
// 所以要修的是入口侧，不是 dream 侧。
//
// 修法：工具层是唯一同时握着「改写动作」与「本轮会话」的入口（service 层只认
// ctx.query，见 src/service.js updateMemory 内的 saveFailure 调用）。调用方没给
// reason 时，工具自己去会话里取当轮用户原话——与注入侧共用同一份实现
// （src/inject.js 的 lastUserQuery），不复制第二份。
//
// 本文件锁三件事：① 没给 reason 时真的落到原话；② 给了 reason 不被覆盖；
// ③ 两边都取不到时写 NULL 而不是空串——空串会假装「有意图」，NULL 才说实话。

function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({
    store,
    mirror: null,
    config: testConfig({ reflectionFailureTracking: true, ...config })
  });
  const registered = [];
  const ctx = { tools: { register(def) { registered.push(def); return () => {}; } } };
  createTools(ctx, service, config, null);
  const tool = (name) => registered.find((def) => def.name === name);
  return { store, service, tool };
}

const seed = (store) => store.save({ type: "preference", title: "语言", content: "喜欢 Python", importance: 3 });

/** exec 形状与宿主一致：工具 execute 的第二个参数（src/tools.js 里的 arguments[1]）。 */
const execWith = (events, extra = {}) => ({
  agent: { session: { id: "s-failure-query", snapshotEvents: () => events, ...extra } }
});

const userMessage = (text, seq) => ({
  type: "user/message",
  ...(seq === undefined ? {} : { seq }),
  data: { source: { kind: "user" }, content: [{ type: "text", text }] }
});

const assistantMessage = (text, seq) => ({
  type: "assistant/message",
  ...(seq === undefined ? {} : { seq }),
  data: { message: { content: [{ type: "text", text }] } }
});

const run = (def, args, exec) => def.execute.bind(def)(args, exec);

test("memory_update 没给 reason 时，query 落当轮用户原话", async () => {
  const { store, tool } = setup();
  const mem = seed(store);
  await run(
    tool("memory_update"),
    { id: mem.id, content: "喜欢 Rust" },
    execWith([userMessage("不对，我喜欢的是 Rust，不是 Python")])
  );
  const [row] = store.listFailures();
  assert.equal(row.query, "不对，我喜欢的是 Rust，不是 Python");
  // expected/actual 语义未变：expected = 改成了什么，actual = 原本是什么。
  assert.equal(row.expected, "喜欢 Rust");
  assert.equal(row.actual, "喜欢 Python");
  assert.equal(row.failure_type, "user_correction");
  assert.equal(row.memory_id, mem.id);
});

test("memory_update 给了 reason 就用 reason，不被会话原话顶掉", async () => {
  const { store, tool } = setup();
  const mem = seed(store);
  await run(
    tool("memory_update"),
    { id: mem.id, content: "喜欢 Rust", reason: "用户说：换成 Rust" },
    execWith([userMessage("这句是当轮原话，但调用方已经说清了理由")])
  );
  assert.equal(store.listFailures()[0].query, "用户说：换成 Rust");
});

test("reason 是空白串时按「没给」处理，退回会话原话", async () => {
  const { store, tool } = setup();
  const mem = seed(store);
  // 与 api-standalone 的 PUT /memories/:id 同口径（body.reason.trim() 为空即视作未提供）。
  await run(
    tool("memory_update"),
    { id: mem.id, content: "喜欢 Rust", reason: "   " },
    execWith([userMessage("换成 Rust 吧")])
  );
  assert.equal(store.listFailures()[0].query, "换成 Rust 吧");
});

test("两边都取不到时写 NULL，不写空串（空串会假装有意图）", async () => {
  const { store, tool } = setup();
  const mem = seed(store);
  // 会话里只有助手消息 → 取不到「用户原话」。
  await run(tool("memory_update"), { id: mem.id, content: "喜欢 Rust" }, execWith([assistantMessage("好的")]));
  assert.equal(store.listFailures()[0].query, null);

  // 完全没有 exec（老宿主 / 直调）→ 同样 NULL，不抛。
  const mem2 = store.save({ type: "preference", title: "编辑器", content: "vim", importance: 3 });
  await run(tool("memory_update"), { id: mem2.id, content: "emacs" });
  assert.equal(store.listFailures()[1].query, null);
});

test("被撤回/压缩遮蔽的用户消息不算当轮原话（复用注入侧同一份实现）", async () => {
  const { store, tool } = setup();
  const mem = seed(store);
  // seq 1 被 rewind 遮蔽（surface.nodes 只暴露 2）——同 inject.js visibleSeqsOf 口径。
  // 这条同时锁住「没有抄第二份实现」：naive 的副本会漏掉可见面过滤。
  const events = [userMessage("我想撤回的那句话", 1), assistantMessage("好", 2)];
  await run(
    tool("memory_update"),
    { id: mem.id, content: "喜欢 Rust" },
    execWith(events, { surface: { nodes: [2] } })
  );
  assert.equal(store.listFailures()[0].query, null, "被遮蔽的消息不许当成原话");
});

test("会话内部读不出来时退化为 NULL，不让改写本身失败", async () => {
  const { store, tool } = setup();
  const mem = seed(store);
  // 宿主 getter 抛错（cordis Proxy 裸读未 inject 属性）——lastUserQuery 的 catch 兜住。
  const exec = {
    agent: {
      get session() {
        throw new Error("not injected");
      }
    }
  };
  await run(tool("memory_update"), { id: mem.id, content: "喜欢 Rust" }, exec);
  const [row] = store.listFailures();
  assert.equal(row.query, null);
  assert.equal(row.expected, "喜欢 Rust", "改写本身照常完成");
  assert.equal(store.getById(mem.id).content, "喜欢 Rust");
});

test("过长的原话按注入侧同一上限截断（不是各截各的）", async () => {
  const { store, tool } = setup();
  const mem = seed(store);
  await run(tool("memory_update"), { id: mem.id, content: "喜欢 Rust" }, execWith([userMessage("长".repeat(900))]));
  assert.equal(store.listFailures()[0].query.length, 500, "safeSlice(…, 500) 与注入侧一致");
});
