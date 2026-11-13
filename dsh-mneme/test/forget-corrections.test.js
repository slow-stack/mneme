// #532 选择性遗忘 × 事实更正的结构性回归锁。
//
// 现象（议题主楼）：更正两个事实 → 只忘一个 → 保留的那个答回更正前的旧值。
// 根因是三段契约的接缝（docs/FORGET.md §1）：更正由蒸馏落成新行（三元组去重不
// 命中、dream 冲突裁决阈值门控未运行）→ 旧行与新行之间没有持久失效关系 →
// memory_forget 按行抑制，合流在同一行里的其他事实连带退出可见面，旧值行成了
// 唯一幸存载体。
//
// 本文件锁两件事：
//   ① 存储层合成轨迹（零 LLM）：两行并存、遗忘新行、旧行原样幸存——这是现象的
//     存储层等价物。**机制修复落地时 ⑤ 的断言应当翻转**：更正行写入后旧行要么
//     被记上失效关系、要么退出活跃面；注释里写明翻转条件，防止它被当成「永远
//     该绿」的现状锁读。
//   ② memory_forget 的工具描述必须带行粒度警示：模型无从得知「请求的语义粒度
//     （一个事实）」与「工具的能力粒度（一行）」之间的落差，除非描述告诉它。
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";
import { testConfig } from "./helpers/test-config.js";

test("#532 合成轨迹：更正落新行、遗忘新行、旧行原样幸存（机制修复落地时 ⑤ 翻转）", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({}) });
  try {
    // ① 原始陈述（对话 A 的蒸馏产物：颜色 + 时间合流一行）
    const r1 = service.saveWithDedupe({
      type: "preference", title: "纸模工具的收纳与整理",
      content: "纸模工具放在雾蓝色收纳盒，每周三晚上八点整理一次", importance: 3
    });
    // ② 更正（对话 B：蒸馏器另起标题 → (type,title,scope) 三元组不命中 → 新行）
    const r2 = service.saveWithDedupe({
      type: "preference", title: "收纳盒颜色与整理时间的更正",
      content: "收纳盒换成浅橙色，整理时间改为每周六上午九点", importance: 3
    });
    assert.notEqual(r1.memory.id, r2.memory.id, "标题不同 → 去重不命中，更正落成新行");
    // ③ 结构断言：两行同时活跃，二者之间没有任何失效链接（本车道基线未含 #275
    //   的 capacityStats，直接查列）
    const activeCount = () => store.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE forgotten = 0 AND archived = 0").get().n;
    assert.equal(activeCount(), 2, "更正不淘汰旧行（dream 未运行的阈值下无失效关系）");
    // ④ 「忘掉颜色」＝按行遗忘新值行（模型在可见行里看到的颜色载体）
    service.setForget(r2.memory.id, true);
    // ⑤ 现象复现：新值行退出可见面后，旧值行仍是唯一幸存载体——这正是 #532
    //    「保留的更正事实答回旧值」的存储层等价物。机制修复（写侧更正失效关系 /
    //    dream 触发前移，见 docs/FORGET.md §3）落地时翻转：旧行应被记上失效关系
    //    或退出活跃面，断言改为不存在「幸存的旧值行」。
    assert.equal(store.getById(r1.memory.id).forgotten, false, "旧行从未被任何机制波及（toRow 把列归一成 boolean）");
    assert.match(store.getById(r1.memory.id).content, /每周三晚上八点/, "旧值仍在召回面");
    // 被抑制的行可恢复（接口契约：行粒度遗忘不是删除）——恢复后两行回到并存
    // 状态：失效关系的缺位不因遗忘/恢复而改变。
    service.setForget(r2.memory.id, false);
    assert.equal(activeCount(), 2);
  } finally {
    store.close();
  }
});

test("memory_forget 的工具描述必须带行粒度警示（#532 对话 5 的模型误用直接对策）", () => {
  const registered = [];
  const ctx = { tools: { register(def) { registered.push(def); return () => {}; } } };
  createTools(ctx, { getById: () => undefined }, {}, undefined);
  const forget = registered.find((d) => d.name === "memory_forget");
  assert.ok(forget, "memory_forget 必须注册");
  // 锁「语义」不锁逐字：描述必须让模型知道抑制按行、合流事实连带退出、
  // 请求只针对一个事实时先看行内容或拆分。防的回归是有人把描述改回
  // 「只说单条抑制」，模型在「忘掉 X」请求下重新对合流行整条下手。
  const desc = String(forget.description || "");
  assert.match(desc, /per ROW/i, "描述必须写明抑制粒度是行");
  assert.match(desc, /memory_update|inspect|say in your reply/i, "描述必须给出合流行下的替代动作");
});
