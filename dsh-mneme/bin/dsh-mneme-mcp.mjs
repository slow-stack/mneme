#!/usr/bin/env node
/**
 * dsh-mneme-mcp —— @modusensus/dsh-mneme stdio MCP server (v1, issue #181)
 *
 * 零依赖 ESM（Node >= 20，全局 fetch）。任何 MCP 客户端（Claude Code / Cursor /
 * 任意支持 Model Context Protocol 的 host）以 stdio 挂载本进程，即可获得与 DSH
 * 内一致的记忆工具六件套：memory_save / memory_search / memory_list /
 * memory_get / memory_update / memory_delete。
 *
 * 数据面走 standalone API（8790，Bearer）而非直连 memory.db——写入并发由 DSH
 * 单点负责，最稳。工具名、参数、输出渲染与 src/tools.js 逐字对齐（test/mcp-stdio.test.js
 * 有平价回归锁漂移）；scope 语义差异仅一处：standalone API 无会话上下文，
 * save 不做自动标注、只认显式 agent_scope / workspace_scope 声明。
 *
 * 配置优先级（沿用 CLI 约定）：
 *   环境变量 MNEME_URL / MNEME_TOKEN（兼容 DSH_MNEME_*）> ~/.dsh-mneme/cli.json（{"url","token"}）
 *   > 默认 http://127.0.0.1:8790
 *
 * Claude Code 挂载示例（.mcp.json）：
 *   { "mcpServers": { "dsh-mneme": {
 *       "command": "dsh-mneme-mcp",
 *       "env": { "DSH_MNEME_TOKEN": "<面板「设置 → 外部访问 API」中的 token>" } } } }
 *
 * 日志只进 stderr；stdout 仅承载 JSON-RPC 帧（每行一条）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_URL = "http://127.0.0.1:8790";
const CONFIG_PATH = path.join(process.env.MNEME_CONFIG_DIR || path.join(os.homedir(), ".dsh-mneme"), "cli.json");
const REQUEST_TIMEOUT_MS = 10_000;
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const LATEST_PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "dsh-mneme";

const UNAUTHORIZED_HINT =
  "unauthorized: the dsh-mneme standalone API rejected the token. Set MNEME_TOKEN (alias: DSH_MNEME_TOKEN) " +
  "(or `dsh-mneme config set <url> <token>`); the token is shown in the DSH panel " +
  "under Settings -> External API.";

function readPkgVersion() {
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version ?? "?";
  } catch {
    return "?";
  }
}
const PKG_VERSION = readPkgVersion();

// --- 配置解析（env > cli.json > 默认）---------------------------------------

function readConfigFile(configPath = CONFIG_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function resolveMcpConfig(env = process.env, configPath = CONFIG_PATH) {
  const file = readConfigFile(configPath);
  const url = firstNonEmpty(env.MNEME_URL, env.DSH_MNEME_URL, file.url) ?? DEFAULT_URL;
  const token = firstNonEmpty(env.MNEME_TOKEN, env.DSH_MNEME_TOKEN, file.token) ?? "";
  return { url: url.replace(/\/+$/, ""), token };
}

// --- HTTP 客户端（超时 + 状态码归一）----------------------------------------

async function apiRequest(config, pathname, { method = "GET", body, query } = {}) {
  const search = query ? `?${new URLSearchParams(query)}` : "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  let text;
  try {
    // res.text() 必须留在本块内：超时信号要覆盖到响应正文读完——只拿到响应头
    // 不算完成，正文停摆同样要被 abort（CodeRabbit 评审项）。
    res = await fetch(`${config.url}${pathname}${search}`, {
      method,
      headers: {
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal
    });
    text = await res.text();
  } catch (error) {
    const reason = error?.cause?.code ?? error?.name ?? String(error);
    throw new Error(`dsh-mneme API unreachable at ${config.url}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (res.status === 401) throw new Error(UNAUTHORIZED_HINT);
  return { status: res.status, json };
}

/** 非 401 的失败统一成带状态码的消息（400 时尽量带上 API 的错误码）。 */
function assertOk({ status, json }, okStatuses) {
  if (okStatuses.includes(status)) return;
  throw new Error(
    status === 400
      ? `invalid request: ${json?.error ?? "unknown"}`
      : `dsh-mneme API error (HTTP ${status})`
  );
}

// --- 渲染（与 src/tools.js 的 output.render 逐字对齐）-----------------------

const MEMORY_PROVENANCE = (m) => {
  const parts = [];
  if (m.occurred_at) parts.push(`occurred: ${m.occurred_at}`);
  if (m.agent_scope || m.workspace_scope) {
    parts.push(`scope: ${m.agent_scope ?? "global"} / ${m.workspace_scope ?? "global"}`);
  }
  if (m.sensitivity) parts.push(`sensitivity: ${m.sensitivity}`);
  return parts.length ? ` | ${parts.join(" | ")}` : "";
};

const previewOf = (content) => {
  const preview = (content ?? "").replace(/\s+/g, " ").trim();
  return preview.length > 200 ? `${preview.slice(0, 200)}…` : preview;
};

// --- 工具定义（六件套；描述与参数同 src/tools.js，平价测试逐字校验）----------

const MEMORY_TYPE_ENUM = ["preference", "project", "decision", "history", "rejected_solution", "pitfall", "constraint"];

// #230：memory_list 的过滤枚举比 save/update 宽一档——document 指针行可被
// 列出（agent 需要按类型找到注册过的外档），但不进 save/update（铸造口唯一
// = registerDocument；MCP 暂不镜像该工具，接口面归 #231）。
const MEMORY_TYPE_LIST_ENUM = [...MEMORY_TYPE_ENUM, "document"];

const TOOL_SAVE_DESCRIPTION =
  "Persist one memory entry for future sessions (user preferences, project state, decisions). " +
  "Call this when the user states a durable preference, a project decision is made, or a lesson is learned. " +
  "Merges into an existing entry of the same type when the title matches.";
const TOOL_SEARCH_DESCRIPTION =
  "Search the cross-session memory store for past context (solved problems, user preferences, project decisions). IMPORTANT: relevant cross-session memories are already injected into your context every turn — only call this when the injected memory block does NOT contain what you need, or you need to look something specific up. Substring-matches title/content/tags, and augments results with semantic (vector) recall + optional rerank when an embeddings provider is configured. Returns matching entries with source and timestamps.";
const TOOL_LIST_DESCRIPTION =
  "List memory entries by type, high-importance first, then newest, paginated. Set include_archived=true to also list archived (hidden) entries so they can be located and restored.";
const TOOL_GET_DESCRIPTION =
  "Fetch one memory entry by ID and return its full content as text. Use after memory_list to read a specific entry.";
const TOOL_UPDATE_DESCRIPTION =
  "Modify an existing memory entry (title, content, type, tags, importance).";
const TOOL_DELETE_DESCRIPTION =
  "Permanently delete a memory entry.";

const SCOPE_SAVE_NOTE_AGENT =
  "Optional explicit agent-scope declaration (issue #170): 'global' or '*' makes this memory visible to every agent; any other value narrows it to that label. Overrides the automatic carrier label for this write; honored even when automatic scope labeling is disabled.";
const SCOPE_SAVE_NOTE_WORKSPACE =
  "Optional explicit workspace-scope declaration: 'global' or '*' makes this memory visible in every workspace; any other value narrows it to that label. Overrides the automatic carrier label for this write; honored even when automatic scope labeling is disabled.";
const SCOPE_UPDATE_NOTE_AGENT =
  "Optional explicit agent-scope correction (issue #170): 'global' or '*' widens visibility to every agent; any other value narrows it to that label. Omit to keep the current agent scope. Recorded as an explicit scope decision (audited).";
const SCOPE_UPDATE_NOTE_WORKSPACE =
  "Optional explicit workspace-scope correction: 'global' or '*' widens visibility to every workspace; any other value narrows it to that label. Omit to keep the current workspace scope. Recorded as an explicit scope decision (audited).";
const OCCURRED_FROM_NOTE =
  "Optional ISO date/timestamp lower bound on when the remembered event happened (occurred_at, falling back to created_at). Date-only values are inclusive from that day's 00:00Z.";
const OCCURRED_TO_NOTE =
  "Optional ISO date/timestamp upper bound on occurred_at. Date-only values are inclusive through that day's 23:59:59.999Z.";

async function runSave(config, args) {
  const body = {
    type: args.type,
    title: args.title,
    content: args.content,
    ...(args.tags !== undefined ? { tags: args.tags } : {}),
    ...(args.importance !== undefined ? { importance: args.importance } : {}),
    ...(args.source !== undefined ? { source: args.source } : {}),
    ...(args.sensitivity !== undefined ? { sensitivity: args.sensitivity } : {}),
    ...(args.occurred_at !== undefined ? { occurred_at: args.occurred_at } : {}),
    ...(args.agent_scope !== undefined ? { agent_scope: args.agent_scope } : {}),
    ...(args.workspace_scope !== undefined ? { workspace_scope: args.workspace_scope } : {})
  };
  const res = await apiRequest(config, "/memories", { method: "POST", body });
  assertOk(res, [200, 201]);
  return `memory ${res.json?.action ?? "created"}: ${res.json?.id}`;
}

async function runSearch(config, args) {
  const mode = args.semantic === true && !args.mode ? "vector" : args.mode;
  const query = {
    q: String(args.query ?? ""),
    ...(args.limit !== undefined ? { topK: String(args.limit) } : {}),
    ...(mode !== undefined ? { mode: String(mode) } : {}),
    ...(args.rerank !== undefined ? { rerank: String(args.rerank) } : {}),
    ...(args.occurred_from !== undefined ? { occurred_from: String(args.occurred_from) } : {}),
    ...(args.occurred_to !== undefined ? { occurred_to: String(args.occurred_to) } : {})
  };
  const res = await apiRequest(config, "/search", { query });
  assertOk(res, [200]);
  const items = res.json?.items ?? [];
  if (items.length === 0) return "No memory entries found.";
  const body = items
    .map((m, i) => {
      return `[${i + 1}] ${m.title}\n    ID: ${m.id} | type: ${m.type} | importance: ${m.importance} | updated: ${m.updated_at}${MEMORY_PROVENANCE(m)}\n    ${previewOf(m.content)}`;
    })
    .join("\n\n");
  return `Found ${items.length} memory entr${items.length === 1 ? "y" : "ies"}:\n\n${body}`;
}

async function runList(config, args) {
  const query = {
    ...(args.type !== undefined ? { type: String(args.type) } : {}),
    ...(args.limit !== undefined ? { limit: String(args.limit) } : {}),
    ...(args.offset !== undefined ? { offset: String(args.offset) } : {}),
    ...(args.include_archived !== undefined ? { include_archived: String(args.include_archived) } : {}),
    ...(args.occurred_from !== undefined ? { occurred_from: String(args.occurred_from) } : {}),
    ...(args.occurred_to !== undefined ? { occurred_to: String(args.occurred_to) } : {}),
    ...(args.workspace_scope !== undefined ? { workspace_scope: String(args.workspace_scope) } : {})
  };
  const res = await apiRequest(config, "/memories", { query });
  assertOk(res, [200]);
  const items = res.json?.items ?? [];
  const total = res.json?.total ?? 0;
  if (items.length === 0) return `0 memory entries (of ${total}).`;
  const body = items
    .map((m, i) => `[${i + 1}] ${m.title} (type=${m.type}, importance=${m.importance})\n    ID: ${m.id} | updated: ${m.updated_at}${MEMORY_PROVENANCE(m)}`)
    .join("\n\n");
  return `${items.length} memory entries (of ${total}):\n\n${body}`;
}

async function runGet(config, args) {
  const res = await apiRequest(config, `/memories/${encodeURIComponent(String(args.id ?? ""))}`);
  // 404 → 与 DSH 内 memory_get 同语义的抛错（isError 渲染 "memory not found"）。
  if (res.status === 404) throw new Error("memory not found");
  assertOk(res, [200]);
  const m = res.json;
  if (!m || !m.id) throw new Error("memory not found");
  // #230：document 指针行把文件路径亮在首行，与 src/tools.js 的 memory_get
  // render 逐字对齐。
  const doc = m.doc_path ? ` | doc: ${m.doc_path}` : "";
  return `${m.title}\nID: ${m.id} | type: ${m.type} | importance: ${m.importance}${doc}${MEMORY_PROVENANCE(m)}\n\n${m.content}`;
}

async function runUpdate(config, args) {
  const body = {
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.content !== undefined ? { content: args.content } : {}),
    ...(args.type !== undefined ? { type: args.type } : {}),
    ...(args.tags !== undefined ? { tags: args.tags } : {}),
    ...(args.importance !== undefined ? { importance: args.importance } : {}),
    ...(args.reason !== undefined ? { reason: args.reason } : {}),
    ...(args.agent_scope !== undefined ? { agent_scope: args.agent_scope } : {}),
    ...(args.workspace_scope !== undefined ? { workspace_scope: args.workspace_scope } : {})
  };
  const res = await apiRequest(config, `/memories/${encodeURIComponent(String(args.id ?? ""))}`, { method: "PUT", body });
  if (res.status === 404) throw new Error("memory not found");
  assertOk(res, [200]);
  const m = res.json?.memory;
  if (!m || !m.id) throw new Error("memory not found");
  return `Updated memory ${m.id}: ${m.title}`;
}

async function runDelete(config, args) {
  const res = await apiRequest(config, `/memories/${encodeURIComponent(String(args.id ?? ""))}`, { method: "DELETE" });
  assertOk(res, [200, 404]);
  return res.status === 200 ? "Memory deleted." : "Memory not found.";
}

const stringSchema = (description) => ({ type: "string", description });
const intSchema = (description) => ({ type: "integer", description });
const boolSchema = (description) => ({ type: "boolean", description });
const tagsSchema = { type: "array", items: { type: "string" }, description: "Optional tags" };
const tagsUpdateSchema = { type: "array", items: { type: "string" } };
const typeEnumSchema = (description) => ({ type: "string", enum: MEMORY_TYPE_ENUM, description });
const importanceSaveSchema = intSchema("1-5; >= threshold auto-injects into future sessions");

export const MCP_TOOLS = [
  {
    name: "memory_save",
    description: TOOL_SAVE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        type: { ...typeEnumSchema("preference=user profile; project=project knowledge/state; decision=key decision; history=conversation summary; rejected_solution=rejected/abandoned implementation approach; pitfall=debugging lesson (symptom+root cause+fix); constraint=engineering constraint") },
        title: stringSchema("Short unique title"),
        content: stringSchema("Memory body"),
        tags: tagsSchema,
        importance: importanceSaveSchema,
        source: stringSchema("Optional provenance"),
        sensitivity: stringSchema("Optional sensitivity label (free-form, e.g. personal). Same-title entries with different sensitivity stay separate instead of merging."),
        occurred_at: stringSchema("Optional ISO-8601 instant the remembered event happened (differs from write time). Invalid values are ignored."),
        agent_scope: stringSchema(SCOPE_SAVE_NOTE_AGENT),
        workspace_scope: stringSchema(SCOPE_SAVE_NOTE_WORKSPACE)
      },
      required: ["type", "title", "content"]
    }
  },
  {
    name: "memory_search",
    description: TOOL_SEARCH_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        query: stringSchema("Search text; substring match over title/content/tags"),
        limit: intSchema("Max results (default 20)"),
        mode: { type: "string", enum: ["auto", "keyword", "vector", "hybrid"], description: "auto (default) = keyword hits first + vector fill when enabled; keyword = text only; vector = semantic recall first (falls back to keyword); hybrid = vector leads, keyword fills remaining slots" },
        semantic: boolSchema("Shorthand: enable semantic (vector) recall (same as mode=vector when true)"),
        rerank: boolSchema("Run cross-encoder rerank over candidates when a local reranker is configured (default true)"),
        occurred_from: stringSchema(OCCURRED_FROM_NOTE),
        occurred_to: stringSchema(OCCURRED_TO_NOTE)
      },
      required: ["query"]
    }
  },
  {
    name: "memory_list",
    description: TOOL_LIST_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: MEMORY_TYPE_LIST_ENUM, description: "Filter by type; omit for all. 'document' (#230) = agent-registered document pointer rows" },
        limit: intSchema("Page size (default 50)"),
        offset: intSchema("Page offset (default 0)"),
        include_archived: boolSchema("Include archived (hidden) entries so they can be found and restored (default false)"),
        occurred_from: stringSchema(OCCURRED_FROM_NOTE),
        occurred_to: stringSchema(OCCURRED_TO_NOTE),
        workspace_scope: stringSchema("Optional: list only entries belonging to exactly this workspace label (exact match, any scope source). This is a picker filter, not a visibility gate — it does NOT widen what strictScope hides.")
      },
      required: []
    }
  },
  {
    name: "memory_get",
    description: TOOL_GET_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { id: stringSchema("Memory id") },
      required: ["id"]
    }
  },
  {
    name: "memory_update",
    description: TOOL_UPDATE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        id: stringSchema("Memory id"),
        title: stringSchema("New title"),
        content: stringSchema("New content"),
        type: typeEnumSchema("New type"),
        tags: tagsUpdateSchema,
        importance: intSchema("1-5"),
        reason: stringSchema("Optional context for the correction (what the user actually said/wanted), recorded for reflection"),
        agent_scope: stringSchema(SCOPE_UPDATE_NOTE_AGENT),
        workspace_scope: stringSchema(SCOPE_UPDATE_NOTE_WORKSPACE)
      },
      required: ["id"]
    }
  },
  {
    name: "memory_delete",
    description: TOOL_DELETE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { id: stringSchema("Memory id") },
      required: ["id"]
    }
  }
];

const TOOL_RUNNERS = new Map([
  ["memory_save", runSave],
  ["memory_search", runSearch],
  ["memory_list", runList],
  ["memory_get", runGet],
  ["memory_update", runUpdate],
  ["memory_delete", runDelete]
]);

// --- JSON-RPC over stdio（MCP：每行一条消息）---------------------------------

const rpcError = (code, message) => ({ code, message });

async function dispatch(config, msg) {
  switch (msg.method) {
    case "initialize": {
      const requested = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : LATEST_PROTOCOL_VERSION;
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: PKG_VERSION },
        instructions:
          "dsh-mneme cross-session memory (six tools mirroring the in-DSH memory tools). " +
          "Data plane: the plugin's standalone API. Configure MNEME_URL / MNEME_TOKEN (aliases: DSH_MNEME_URL / DSH_MNEME_TOKEN) or ~/.dsh-mneme/cli.json."
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: MCP_TOOLS };
    case "tools/call": {
      const name = msg.params?.name;
      const runner = TOOL_RUNNERS.get(name);
      if (!runner) throw rpcError(-32602, `Unknown tool: ${name === undefined ? "(missing)" : String(name)}`);
      try {
        const text = await runner(config, msg.params?.arguments ?? {});
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return { content: [{ type: "text", text: String(error?.message ?? error) }], isError: true };
      }
    }
    default:
      throw rpcError(-32601, `method not found: ${String(msg.method)}`);
  }
}

function createMcpServer(config) {
  let buffer = "";
  const write = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: rpcError(-32700, "Parse error") });
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
      // 合法 JSON 但不是有效请求/通知（{}、数组等）：按 JSON-RPC 回 -32600，
      // 提取得到 id 就带上、取不到用 null——客户端不该分不清「无效」和「无响应」。
      write({
        jsonrpc: "2.0",
        id: msg && typeof msg === "object" && msg.id !== undefined ? msg.id : null,
        error: rpcError(-32600, "Invalid Request")
      });
      return;
    }
    // 通知（无 id）：不回复。initialized/cancelled 等一律静默。
    if (msg.id === undefined) return;
    dispatch(config, msg).then(
      (result) => write({ jsonrpc: "2.0", id: msg.id, result }),
      (error) => write({ jsonrpc: "2.0", id: msg.id, error: error?.code !== undefined && error?.message !== undefined ? error : rpcError(-32603, `internal error: ${String(error?.message ?? error)}`) })
    );
  };
  return {
    handleLine,
    start() {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
        }
      });
      process.stdin.on("end", () => process.exit(0));
      process.stdin.on("error", () => process.exit(1));
      const shutdown = () => process.exit(0);
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      // token 缺失只 warn 不退出——health/open 路由仍可用，且提示比静默 401 友好。
      if (!config.token) {
        process.stderr.write("[dsh-mneme-mcp] warning: no token configured (MNEME_TOKEN / ~/.dsh-mneme/cli.json); authenticated calls will fail.\n");
      }
    }
  };
}

function runningAsMain() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    const entry = pathToFileURL(path.resolve(arg)).href;
    return entry === import.meta.url || entry.toLowerCase() === import.meta.url.toLowerCase();
  } catch {
    return false;
  }
}

export function main() {
  const config = resolveMcpConfig();
  // 非回环 HTTP 明文传输会把 Bearer token 暴露给链路——与 CLI 同款取舍，但
  // 至少要喊一声，不让操作者无感地越过「默认仅本机」的安全模型。
  try {
    const url = new URL(config.url);
    const host = url.hostname;
    const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
    if (url.protocol === "http:" && !loopback) {
      process.stderr.write(`[dsh-mneme-mcp] warning: ${config.url} is plain HTTP on a non-loopback host — the Bearer token travels unencrypted. Prefer SSH tunneling or a loopback address.\n`);
    }
  } catch { /* 非法 URL 交给请求路径报错 */ }
  createMcpServer(config).start();
}

if (runningAsMain()) main();
