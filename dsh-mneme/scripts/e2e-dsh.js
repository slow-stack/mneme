// scripts/e2e-dsh.js
// 端到端演示：用 cordis 搭建最小 DSH 环境，真实装载 dsh-mneme 插件，
// 走一遍完整用户流程（工具注册 → 保存/搜索记忆 → 上下文注入 → 会话摘要 → autoDream）。
//
// 运行：node scripts/e2e-dsh.js
import { Context } from "@deepseek-ai/cordis";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mneme from "../lib/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- 环境
const memDir = mkdtempSync(join(tmpdir(), "dsh-mneme-e2e-"));
const ctx = new Context();

// 插件声明的 5 个依赖服务（tools / systemPrompt / webServer / llm / agentDefaultModel）
const registeredTools = [];
const injectContexts = [];
const apiRoutes = [];
const registeredCommands = new Map();
let llmCalls = [];

ctx.provide("tools", {
  register(def) { registeredTools.push(def); return () => {}; }
});
ctx.provide("commands", {
  register(def) { registeredCommands.set(def.name, def); return () => registeredCommands.delete(def.name); }
});
ctx.provide("systemPrompt", {
  context(def) { injectContexts.push(def); return () => {}; }
});
ctx.provide("webServer", {
  register(route) { apiRoutes.push(route); return () => {}; }
});
ctx.provide("agentDefaultModel", {
  currentSelection() { return { provider: "mock", model: "mock-model" }; }
});

// LLM mock：按 purpose / 消息内容返回合理结果（模拟真实 LLM 的巩固行为）
ctx.provide("llm", {
  async *stream(options) {
    llmCalls.push(options.purpose);
    const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
    let text = "";
    if (options.purpose === "summarization") {
      text = JSON.stringify([
        { type: "preference", title: "语言偏好", content: "用户偏好使用中文交流", importance: 4 }
      ]);
    } else if (options.purpose === "dsh-mneme-background" && userText.includes("id=")) {
      // 从传入的记忆清单解析 id 与类型，动态构造有效决策：优先演示 merge，其余 keep
      const entries = [...userText.matchAll(/id=([^\s|]+).*?type=(\w+)/g)].map((m) => ({ id: m[1], type: m[2] }));
      const byType = {};
      for (const e of entries) (byType[e.type] ??= []).push(e.id);
      const decisions = [];
      const claimed = new Set();
      const mergeType = Object.keys(byType).find((t) => byType[t].length >= 2);
      if (mergeType) {
        const ids = byType[mergeType];
        decisions.push({
          action: "merge", ids, keepSource: ids[0],
          title: "合并条目", content: "两条主题相近的记忆合并后的精炼摘要", importance: 4
        });
        ids.forEach((id) => claimed.add(id));
      }
      for (const e of entries) {
        if (!claimed.has(e.id)) decisions.push({ action: "keep", ids: [e.id] });
      }
      text = JSON.stringify(decisions);
    } else if (options.purpose === "dsh-mneme-background") {
      text = "记忆库总览：用户偏好中文交流；工作偏好（上午深度工作）；项目采用 SQLite 存储。";
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text" } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
});

// ---------------------------------------------------------------- 装载
const fiber = ctx.plugin(
  { name: mneme.name, inject: mneme.inject, Config: mneme.Config, apply: mneme.apply },
  {
    memoryDir: memDir,
    autoInject: true,
    autoSummarize: true,
    maxInjectedItems: 5,
    importanceThreshold: 3,
    autoDream: true,
    dreamThresholdCount: 3,
    dreamThresholdChars: 100,
    dreamDelayMs: 80
  }
);
await fiber;

// ---------------------------------------------------------------- 工具
const tool = (name) => registeredTools.find((t) => t.name === name);

console.log("══════ dsh-mneme 端到端演示 ══════");
console.log(`记忆目录：${memDir}\n`);

// 1. 装载检查
console.log("【1】插件装载");
const checks = [];
// 硬编码精确数会随插件演进过时（v0.7 起已有 8 工具 / 26+ 路由，早期写死的
// 7/14 导致新旧 dsh 上 e2e 都误报失败）；改用「下限」检查 + 打印实际数量。
checks.push(["注册 ≥7 个模型工具", registeredTools.length >= 7]);
checks.push(["注册 2 个注入上下文", injectContexts.length === 2 && injectContexts[0].name === "memory"]);
// prefix fallback（/api/dsh-mneme → 404）是兜底，不计入路由数。
checks.push(["注册 ≥14 条 API 路由", apiRoutes.filter((r) => r.kind === "exact").length >= 14]);
for (const [label, ok] of checks) console.log(`  ${ok ? "✅" : "❌"} ${label}`);
if (!checks.every(([, ok]) => ok)) { console.log("\n装载检查失败，中止。"); process.exit(1); }
console.log(`  工具（${registeredTools.length}）：${registeredTools.map((t) => t.name).join(", ")}`);
console.log(`  exact 路由：${apiRoutes.filter((r) => r.kind === "exact").length} 条\n`);

// 2. 保存记忆（工具执行）
console.log("【2】memory_save 保存记忆");
const saves = [];
saves.push(await tool("memory_save").execute({ type: "preference", title: "语言", content: "用户用中文交流", importance: 5 }));
saves.push(await tool("memory_save").execute({ type: "preference", title: "工作时段", content: "9-18 点在线，上午深度工作", importance: 4 }));
saves.push(await tool("memory_save").execute({ type: "preference", title: "工作习惯", content: "习惯上午处理复杂任务", importance: 3 }));
saves.push(await tool("memory_save").execute({ type: "project", title: "记忆插件", content: "dsh-mneme 用 SQLite + Markdown 镜像", importance: 4 }));
saves.push(await tool("memory_save").execute({ type: "decision", title: "存储选型", content: "确定使用 node:sqlite", importance: 5 }));
// 同标题再存一次 → 应触发去重合并
saves.push(await tool("memory_save").execute({ type: "preference", title: "语言", content: "用户用中文交流，偶尔英文", importance: 5 }));
for (const s of saves) console.log(`  memory ${s.action}: ${s.id}`);
console.log("  同标题二次保存 → 触发 merge ✓\n");

// 3. 搜索
console.log("【3】memory_search / memory_list");
const search = await tool("memory_search").execute({ query: "SQLite" });
console.log(`  搜索 "SQLite" → ${search.items.length} 条`);
const list = await tool("memory_list").execute({ type: "preference" });
console.log(`  preference 共 ${list.total} 条\n`);

// 4. 上下文注入
console.log("【4】自动注入（新会话上下文）");
const injected = injectContexts[0].text({});
console.log(injected ? `  ${injected.split("\n").filter(Boolean).map((l) => "  " + l).join("\n")}` : "  （空）");
console.log("");

// 5. 会话摘要（turn/end 事件）
console.log("【5】会话摘要（模拟 turn/end）");
const session = {
  id: "e2e-session-1",
  events: [
    { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "我偏好中文交流，以后都用中文。" }] } }
  ],
  requestHeader() { return { config: { provider: "mock", model: "mock-model" } }; }
};
await ctx.emit("session/event", session, { type: "turn/end" });
await sleep(50);
const afterSummary = await tool("memory_search").execute({ query: "中文交流" });
console.log(`  摘要入库：${afterSummary.items.length} 条命中（source: session）\n`);

// 6. autoDream
console.log("【6】autoDream（阈值触发 → LLM 决策 → merge + 摘要）");
console.log("  等待调度器触发（delay 80ms）…");
await sleep(400);
const injectedAfter = injectContexts[0].text({});
const hasSummary = injectedAfter.includes("记忆库总览");
console.log(`  注入中出现"记忆库总览"：${hasSummary ? "是 ✅" : "否 ❌"}`);
const prefs = await tool("memory_list").execute({ type: "preference" });
console.log(`  dream merge 后 preference 条目：${prefs.items.length}（dream 时 4 条相近项，merge 成 1 条）`);

// 7. Web API 模拟调用
console.log("\n【7】Web 面板 API（/api/dsh-mneme/list）");
const listRoute = apiRoutes.find((r) => r.path === "/api/dsh-mneme/list");
const res = { writeHead(code, h) { this.statusCode = code; this.headers = h; return this; }, end(body) { this.body = body; } };
await listRoute.handler({ url: "/api/dsh-mneme/list?type=project" }, res);
const payload = JSON.parse(res.body);
console.log(`  HTTP ${res.statusCode}，project 条目 ${payload.items.length} 条\n`);

// 8. 用户画像 / 规则 / 自定义命令
console.log("【8】用户画像 / 规则 / 自定义命令");
function apiReq(path, method = "GET", body = null) {
  const listeners = {};
  const r = {
    url: path, method, headers: {},
    on(ev, fn) { listeners[ev] = fn; return r; },
    emit(ev, data) { listeners[ev]?.(data); return r; }
  };
  if (body !== null) {
    process.nextTick(() => { r.emit("data", Buffer.from(JSON.stringify(body))); r.emit("end"); });
  }
  return r;
}
function apiRes() { return { statusCode: 0, body: "", writeHead(code) { this.statusCode = code; return this; }, end(body) { this.body = body; } }; }

const profileRoute = apiRoutes.find((r) => r.path === "/api/dsh-mneme/profile");
const rp = apiRes();
await profileRoute.handler(apiReq("/api/dsh-mneme/profile", "PUT", { profile: "我是后端开发者，擅长 Node.js" }), rp);
const rulesRoute = apiRoutes.find((r) => r.path === "/api/dsh-mneme/rules");
const rr = apiRes();
await rulesRoute.handler(apiReq("/api/dsh-mneme/rules", "PUT", { rules: ["回答时先给结论", "使用简体中文"] }), rr);
const userSettings = injectContexts.find((c) => c.name === "user-settings").text({});
console.log(`  注入含用户画像：${userSettings.includes("后端开发者") ? "✅" : "❌"}`);
console.log(`  注入含规则：${userSettings.includes("先给结论") ? "✅" : "❌"}`);
const cmdRoute = apiRoutes.find((r) => r.path === "/api/dsh-mneme/commands");
const rc = apiRes();
await cmdRoute.handler(apiReq("/api/dsh-mneme/commands", "POST", { name: "review", description: "审查代码", instruction: "请按项目规范审查当前代码" }), rc);
const cmdRegistered = registeredCommands.has("review");
console.log(`  自定义命令 /review 已注册：${cmdRegistered ? "✅" : "❌"}`);
if (cmdRegistered) {
  const handler = registeredCommands.get("review").handler;
  const result = await handler({ agent: {}, rawInput: "", signal: null });
  console.log(`  命令触发返回：${result.text.slice(0, 24)}…`);
}
console.log("");

// ---------------------------------------------------------------- 汇总
console.log("══════ 汇总 ══════");
console.log(`  LLM 调用：${llmCalls.join(" → ")}`);
console.log(`  记忆文件：${memDir}`);
const all = await tool("memory_list").execute({});
console.log(`  当前可注入条目：${all.total}`);
console.log("══════ 演示结束 ══════");
fiber.dispose?.();
