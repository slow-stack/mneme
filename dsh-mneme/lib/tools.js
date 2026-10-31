import { defineTool } from "@deepseek-ai/dsh-tools";
import { createScopeResolver, normalizeExplicitScope, sessionKeyOf, sessionOf } from "./scope.js";
import { describeLocalRuntime, resolveRuntimeEntry } from "./runtime/loader.js";
import { defaultRuntimeDir } from "./runtime/layout.js";
import { hostModulesDir, loadRuntimeManifest, provisionRuntime } from "./runtime/provision.js";
import { matchesPlatform } from "./runtime/closure.js";
import { verifyPayload } from "./runtime/verify.js";
import { TOOL_GUIDE, CONTINUITY_TOOL_RULE } from "./guide.js";
import { injectChildEnabled } from "./config.js";
import { normalizeScopeStateDimension, normalizeScopeStateValue, normalizeScopeStateState } from "./scope-state.js";
import { lastUserQuery } from "./inject.js";

const TEXT_OUTPUT = (text) => [{ type: "text", text }];
// Per-registry tool-name registry: guards against duplicate registration on
// live patch reload (DSH Desktop `patchReload: "live"`) where a plugin may be
// re-applied on the same tools registry without an intervening unregister.
const REGISTERED_TOOLS = new WeakMap();

// Wire shape emitted by service.toApiList: shared by memory_search and
// memory_list so their output schemas always declare every key the runtime
// value carries (additionalProperties: false would reject undeclared keys).
const MEMORY_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", required: true },
    type: { type: "string", required: true },
    title: { type: "string", required: true },
    content: { type: "string", required: true },
    tags: { type: "array", items: { type: "string" } },
    importance: { type: "integer", required: true },
    source: { type: "string" },
    // v0.8.0 A2：scope 标注与事件发生时间随行透出（未标注时缺省，可选属性）。
    // v0.8.1 底座：scope 来源（auto/explicit）与决策时间随行透出（同样可选）。
    agent_scope: { type: "string" },
    workspace_scope: { type: "string" },
    agent_scope_source: { type: "string" },
    workspace_scope_source: { type: "string" },
    scope_decided_at: { type: "string" },
    sensitivity: { type: "string" },
    occurred_at: { type: "string" },
    // #230：document 指针行的文件定位——「全文按需读」的入口；普通行缺省。
    doc_path: { type: "string" },
    created_at: { type: "string", required: true },
    updated_at: { type: "string", required: true }
  }
};
// 导出供回归测试断言 memory_get 与共享 schema 同源（#184 防漂移护栏）。
export { MEMORY_ITEM_SCHEMA };

// v0.8.0 A2：occurred 时间窗参数 → store 过滤选项（list/count 同口径）；
// 未传参返回空对象，既有调用方不受影响。（A3 复核：此处入参仅含 occurred 边界。）
function occurredWindow(args) {
  const from = args?.occurred_from ?? null;
  const to = args?.occurred_to ?? null;
  return from !== null || to !== null ? { occurredFrom: from, occurredTo: to } : {};
}

// v0.8.0 A3：strictScope 硬过滤的 visibility 选项（store.list/count 同口径）。
// flag 关或会话 scope 未解析出（flag 关时解析器返回 null）→ 空对象不过滤；
// scope 为 {null,null}（匿名会话）时照传——store 侧 fail-closed 只放行未标注行。
function strictVisibility(config, scope) {
  if (config?.strictScope !== true || !scope) return {};
  return { visibility: { agentScope: scope.agent_scope, workspaceScope: scope.workspace_scope } };
}

// v0.8.0 A2：检索结果的 provenance 附加段——只在有标注时出现，未标注行渲染
// 与 A2 前逐字节一致。
const MEMORY_PROVENANCE = (m) => {
  const parts = [];
  if (m.occurred_at) parts.push(`occurred: ${m.occurred_at}`);
  if (m.agent_scope || m.workspace_scope) {
    parts.push(`scope: ${m.agent_scope ?? "global"} / ${m.workspace_scope ?? "global"}`);
  }
  if (m.sensitivity) parts.push(`sensitivity: ${m.sensitivity}`);
  return parts.length ? ` | ${parts.join(" | ")}` : "";
};

export function createTools(ctx, service, config, embedder, sessionGate = null) {
  const toolsRegistry = ctx.tools;
  let registration = REGISTERED_TOOLS.get(toolsRegistry);
  if (!registration) {
    registration = { names: new Set(), sessionGate: null };
    REGISTERED_TOOLS.set(toolsRegistry, registration);
  }
  registration.sessionGate = sessionGate;
  const registeredTools = registration.names;
  // v0.8.0 A1/A2（issue #17）：会话 scope 解析（agentPreset + workspace 反查）。
  // flag 关闭时恒返回 null——写入不标注，检索不加权，行为与 A1 前完全一致。
  // logger 透传：registry 反查失败时 warnOnce 才有出口（否则静默降级无观测）。
  const resolveSessionScope = createScopeResolver({ ctx, config, logger: ctx.logger });
  // #249 能力说明（injectGuidanceEnabled）：开启时给「何时用」最有歧义的两个
  // 工具补一句判断指引。工具描述常驻、不进每轮上下文，这个位子零注入成本；
  // 关闭时描述逐字节不变，也不动其他工具的文案。
  // 它是注入父开关的子项（#249 第二批）：`autoInject` 关掉时这里同样不生效——
  // 工具描述是这个子项唯一住在注入器之外的落点，不在闸门内就漏了。
  // #249 N3 降级路径（continuityRescueEnabled）：宿主若不提供可挂钩的压缩前时机，
  // 双落点里的注入那一半就没有触发者，这时把规则交给 agent 自判（见 CONTINUITY_TOOL_RULE）。
  // 与能力说明各自独立：任一开关关闭时描述逐字节不变。
  // 本批不做宿主能力探测（没有可靠的探测口），所以子开关打开时这条规则常驻，与自动双落点并存。
  const withToolGuide = (name, description) => {
    let text = description;
    if (injectChildEnabled(config, "injectGuidanceEnabled") && TOOL_GUIDE[name]) text += TOOL_GUIDE[name];
    if (injectChildEnabled(config, "continuityRescueEnabled") && CONTINUITY_TOOL_RULE[name]) text += CONTINUITY_TOOL_RULE[name];
    return text;
  };

  // 复核项 4（issue #170）：strictScope 下他 scope（explicit）的行对工具侧按
  // 「不存在」处理——update/delete 与 memory_get 同款无存在性泄漏。strictScope
  // 关、或会话身份取不到（scope 为 null）时恒可见（与 get 的短路语义一致）。
  const visibleUnderStrictScope = (memory, exec) => {
    if (config?.strictScope !== true) return true;
    const scope = resolveSessionScope(exec);
    return !scope || service.isVisibleInScope(memory, scope);
  };
  // 在调用点以「展开恒为 undefined」的形态前置校验（抛错即中止写入）。
  const assertVisibleForTool = (id, exec) => {
    const memory = id ? service.getById(id) : undefined;
    if (!visibleUnderStrictScope(memory, exec)) throw new Error("memory not found");
    return undefined;
  };
  // delete 侧需要目标行本身判断存在性（不可见 = 视作不存在，不抛错）。
  const visibleForTool = (id, exec) => {
    const memory = id ? service.getById(id) : undefined;
    return visibleUnderStrictScope(memory, exec) ? memory : undefined;
  };
  const tools = [
    defineTool({
      name: "memory_save",
      description: withToolGuide(
        "memory_save",
        "Persist one memory entry for future sessions (user preferences, project state, decisions). " +
          "Call this when the user states a durable preference, a project decision is made, or a lesson is learned. " +
          "Merges into an existing entry of the same type when the title matches."
      ),
      parameters: {
        // document 不在此列（#230）：document 行只能经 memory_register_document
        // 铸造（注册校验 + doc_path + evidence），防止 memory_save 造出无指针
        // 无回链的伪行。
        type: { type: "string", required: true, enum: ["preference", "project", "decision", "history", "rejected_solution", "pitfall", "constraint"], description: "preference=user profile; project=project knowledge/state; decision=key decision; history=conversation summary; rejected_solution=rejected/abandoned implementation approach; pitfall=debugging lesson (symptom+root cause+fix); constraint=engineering constraint" },
        title: { type: "string", required: true, description: "Short unique title" },
        content: { type: "string", required: true, description: "Memory body" },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
        importance: { type: "integer", description: "1-5; >= threshold auto-injects into future sessions" },
        source: { type: "string", description: "Optional provenance" },
        sensitivity: { type: "string", description: "Optional sensitivity label (free-form, e.g. personal). Same-title entries with different sensitivity stay separate instead of merging." },
        occurred_at: { type: "string", description: "Optional ISO-8601 instant the remembered event happened (differs from write time). Invalid values are ignored." },
        agent_scope: { type: "string", description: "Optional explicit agent-scope declaration (issue #170): 'global' or '*' makes this memory visible to every agent; any other value narrows it to that label. Overrides the automatic carrier label for this write; honored even when automatic scope labeling is disabled." },
        workspace_scope: { type: "string", description: "Optional explicit workspace-scope declaration: 'global' or '*' makes this memory visible in every workspace; any other value narrows it to that label. Overrides the automatic carrier label for this write; honored even when automatic scope labeling is disabled." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", required: true, enum: ["created", "merged", "denied"] },
            // denied 时压根没有行可指，所以 id 缺省而不是空串：空串会让「写成功但
            // id 为空」与「根本没写」在读回执时长得一样，与 #254 验收第 2 条
            // （被拒写入可解释、不静默丢弃）相悖。
            id: { type: "string", description: "Row id; absent when action=denied." },
            reason: { type: "string", description: "Rejection reason when action=denied: blank | noise | sensitive." }
          }
        },
        render: (_args, value) => TEXT_OUTPUT(value.action === "denied"
          ? `memory save rejected (${value.reason ?? "denied"}): nothing was written`
          : `memory ${value.action}: ${value.id}`)
      },
      async execute(args, exec) {
        // scope 标注（v0.8.1 底座，issue #170）：默认由会话身份解析（载体自动
        // 标注，盖 auto 章）；显式 agent_scope/workspace_scope 参数逐维覆盖并盖
        // explicit 章。解析绝不抛错、取不到落 NULL。
        // 复核项 2（#170）：scopeEnabled 只门控「自动标注」分支——显式声明与
        // 读取身份（search/list/get/注入经同一解析器）不受 flag 限制，否则
        // strictScope 硬墙会被 flag 静默拆掉（fail-open）。
        // （存储 NULL，由 source 列与「从未标注」区分）。非字符串参数在工具
        // 入参 schema 层即被拒（type: "string"）——脏值到不了归一化，无静默放宽。
        const scope = resolveSessionScope(exec);
        const autoStamping = config?.scopeEnabled === true;
        const agentLabel = args.agent_scope !== undefined
          ? { value: normalizeExplicitScope(args.agent_scope), source: "explicit" }
          : autoStamping && scope ? { value: scope.agent_scope, source: "auto" } : null;
        const workspaceLabel = args.workspace_scope !== undefined
          ? { value: normalizeExplicitScope(args.workspace_scope), source: "explicit" }
          : autoStamping && scope ? { value: scope.workspace_scope, source: "auto" } : null;
        const result = service.saveWithDedupe({
          // #254 写入准入的计数单位：会话键作为瞬时字段随写入传递（与 _mergeInto /
          // _overwrite 同款约定，不落库）。缺会话身份的宿主返回 null = 这次写入不进
          // 预算；系统写入（dream / summarize / organize）从不带这个字段。
          _sessionKey: sessionKeyOf(exec),
          type: args.type,
          title: args.title,
          content: args.content,
          tags: args.tags ?? [],
          importance: args.importance ?? 3,
          source: args.source ?? "tool",
          ...(agentLabel ? { agent_scope: agentLabel.value, agent_scope_source: agentLabel.source } : {}),
          ...(workspaceLabel ? { workspace_scope: workspaceLabel.value, workspace_scope_source: workspaceLabel.source } : {}),
          ...(args.sensitivity !== undefined ? { sensitivity: args.sensitivity } : {}),
          ...(args.occurred_at !== undefined ? { occurred_at: args.occurred_at } : {})
        });
        // #254 第 1 级硬拒：工具层是模型唯一能看到这次失败的地方，必须显式回一句
        // 可行动的拒绝理由。静默返回成功会让模型以为记住了，然后永远不再重写。
        if (result.action === "denied") return { action: "denied", reason: result.reason };
        return { action: result.action, id: result.memory.id };
      }
    }),

    defineTool({
      name: "memory_search",
      description: withToolGuide(
        "memory_search",
        "Search the cross-session memory store for past context (solved problems, user preferences, project decisions). IMPORTANT: relevant cross-session memories are already injected into your context every turn — only call this when the injected memory block does NOT contain what you need, or you need to look something specific up. Substring-matches title/content/tags, and augments results with semantic (vector) recall + optional rerank when an embeddings provider is configured. Returns matching entries with source and timestamps."
      ),
      // A2 检索接线：occurred 时间窗 + 会话 scope 加成（见 execute）。
      parameters: {
        query: { type: "string", required: true, description: "Search text; substring match over title/content/tags" },
        limit: { type: "integer", description: "Max results (default 20)" },
        mode: { type: "string", enum: ["auto", "keyword", "vector", "hybrid"], description: "auto (default) = keyword hits first + vector fill when enabled; keyword = text only; vector = semantic recall first (falls back to keyword); hybrid = vector leads, keyword fills remaining slots" },
        semantic: { type: "boolean", description: "Shorthand: enable semantic (vector) recall (same as mode=vector when true)" },
        rerank: { type: "boolean", description: "Run cross-encoder rerank over candidates when a local reranker is configured (default true)" },
        occurred_from: { type: "string", description: "Optional ISO date/timestamp lower bound on when the remembered event happened (occurred_at, falling back to created_at). Date-only values are inclusive from that day's 00:00Z." },
        occurred_to: { type: "string", description: "Optional ISO date/timestamp upper bound on occurred_at. Date-only values are inclusive through that day's 23:59:59.999Z." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            items: {
              type: "array", required: true,
              items: MEMORY_ITEM_SCHEMA
            }
          }
        },
        render: (_args, value) => {
          const items = value.items ?? [];
          if (items.length === 0) return TEXT_OUTPUT("No memory entries found.");
          const body = items
            .map((m, i) => {
              const preview = (m.content ?? "").replace(/\s+/g, " ").trim();
              const cut = preview.length > 200 ? `${preview.slice(0, 200)}…` : preview;
              return `[${i + 1}] ${m.title}\n    ID: ${m.id} | type: ${m.type} | importance: ${m.importance} | updated: ${m.updated_at}${MEMORY_PROVENANCE(m)}\n    ${cut}`;
            })
            .join("\n\n");
          return TEXT_OUTPUT(`Found ${items.length} memory entr${items.length === 1 ? "y" : "ies"}:\n\n${body}`);
        }
      },
      async execute(args, exec) {
        const limit = args.limit ?? 20;
        const mode = args.semantic === true && !args.mode ? "vector" : args.mode ?? "auto";
        // v0.8.0 A2（issue #17）：scope 检索加权 + occurred 时间窗的检索接线。
        // flag 关闭或解析不出 scope 时为 null，检索行为与 A2 前一致。
        const scope = resolveSessionScope(exec);
        const occurredFrom = args.occurred_from ?? null;
        const occurredTo = args.occurred_to ?? null;
        const rows = await service.searchMemories(args.query, {
          mode,
          topK: limit,
          useRerank: args.rerank !== false,
          ...(scope ? { scope } : {}),
          ...(occurredFrom !== null || occurredTo !== null ? { occurredFrom, occurredTo } : {})
        });
        return { items: service.toApiList(rows) };
      }
    }),

    defineTool({
      name: "memory_list",
      description: "List memory entries by type, high-importance first, then newest, paginated. Set include_archived=true to also list archived (hidden) entries so they can be located and restored.",
      parameters: {
        type: { type: "string", enum: ["preference", "project", "decision", "history", "rejected_solution", "pitfall", "constraint", "document"], description: "Filter by type; omit for all. 'document' (#230) = agent-registered document pointer rows" },
        limit: { type: "integer", description: "Page size (default 50)" },
        offset: { type: "integer", description: "Page offset (default 0)" },
        include_archived: { type: "boolean", description: "Include archived (hidden) entries so they can be found and restored (default false)" },
        occurred_from: { type: "string", description: "Optional ISO date/timestamp lower bound on when the remembered event happened (occurred_at, falling back to created_at). Date-only values are inclusive from that day's 00:00Z." },
        occurred_to: { type: "string", description: "Optional ISO date/timestamp upper bound on occurred_at. Date-only values are inclusive through that day's 23:59:59.999Z." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            items: {
              type: "array", required: true,
              items: MEMORY_ITEM_SCHEMA
            },
            total: { type: "integer", required: true }
          }
        },
        render: (_args, value) => {
          const items = value.items ?? [];
          if (items.length === 0) return TEXT_OUTPUT(`0 memory entries (of ${value.total}).`);
          const body = items
            .map((m, i) => `[${i + 1}] ${m.title} (type=${m.type}, importance=${m.importance})\n    ID: ${m.id} | updated: ${m.updated_at}${MEMORY_PROVENANCE(m)}`)
            .join("\n\n");
          return TEXT_OUTPUT(`${items.length} memory entries (of ${value.total}):\n\n${body}`);
        }
      },
      async execute(args) {
        const includeArchived = args.include_archived === true;
        const rows = service.toApiList(service.list({
          type: args.type,
          limit: args.limit ?? 50,
          offset: args.offset ?? 0,
          includeArchived,
          ...occurredWindow(args),
          // A3：strict 开启时按会话 scope 硬过滤（宿主按 (args, runContext) 调用，
          // 从 arguments 取第二参）。
          ...strictVisibility(config, resolveSessionScope(arguments[1]))
        }));
        return { items: rows, total: service.count(args.type, { includeArchived, ...occurredWindow(args), ...strictVisibility(config, resolveSessionScope(arguments[1])) }) };
      }
    }),

    defineTool({
      name: "memory_get",
      description: "Fetch one memory entry by ID and return its full content as text. Use after memory_list to read a specific entry.",
      parameters: {
        id: { type: "string", required: true, description: "Memory id" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            // 与 memory_search / memory_list 共用同一份 item schema——DTO 由
            // toApiList 统一产出，内联副本曾漏掉 v0.8.1 的 scope 来源三键，
            // 任何被标注过的行都过不了 in-process 校验（#184）。
            memory: MEMORY_ITEM_SCHEMA
          }
        },
        render: (_args, value) => {
          const m = value.memory;
          // #230：document 指针行把文件路径亮在首行——「全文按需读」从这里拿路径。
          const doc = m.doc_path ? ` | doc: ${m.doc_path}` : "";
          return TEXT_OUTPUT(`${m.title}\nID: ${m.id} | type: ${m.type} | importance: ${m.importance}${doc}${MEMORY_PROVENANCE(m)}\n\n${m.content}`);
        }
      },
      async execute(args) {
        const memory = service.getById(args.id);
        if (memory === undefined) throw new Error("memory not found");
        // v0.8.0 A3：strictScope 下他 scope 的行按不存在处理（无存在性泄漏）。
        // 宿主注册表按 (args, runContext) 两参调用处理器，从 arguments 取第二参。
        const runContext = arguments[1];
        const scope = resolveSessionScope(runContext);
        if (config.strictScope === true && scope && !service.isVisibleInScope(memory, scope)) {
          throw new Error("memory not found");
        }
        return { memory: service.toApiList([memory])[0] };
      }
    }),

    defineTool({
      name: "memory_update",
      description: "Modify an existing memory entry (title, content, type, tags, importance).",
      parameters: {
        id: { type: "string", required: true, description: "Memory id" },
        title: { type: "string" },
        content: { type: "string" },
        // document 不在此列（#230）：type 不许改入 document——既有 document 行
        // 的摘要修复（只改 content/title）不受影响。
        type: { type: "string", enum: ["preference", "project", "decision", "history", "rejected_solution", "pitfall", "constraint"] },
        tags: { type: "array", items: { type: "string" } },
        importance: { type: "integer", description: "1-5" },
        reason: { type: "string", description: "Optional context for the correction (what the user actually said/wanted), recorded for reflection" },
        agent_scope: { type: "string", description: "Optional explicit agent-scope correction (issue #170): 'global' or '*' widens visibility to every agent; any other value narrows it to that label. Omit to keep the current agent scope. Recorded as an explicit scope decision (audited)." },
        workspace_scope: { type: "string", description: "Optional explicit workspace-scope correction: 'global' or '*' widens visibility to every workspace; any other value narrows it to that label. Omit to keep the current workspace scope. Recorded as an explicit scope decision (audited)." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            memory: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                title: { type: "string", required: true },
                content: { type: "string", required: true }
              }
            }
          }
        },
        render: (_args, value) => TEXT_OUTPUT(`Updated memory ${value.memory.id}: ${value.memory.title}`)
      },
      async execute(args) {
        // v0.9.0：失败表的 query 是「当时到底想干什么」唯一的落点，而 service
        // 层看不到会话（它只认 ctx.query，见 src/service.js 的 saveFailure 注释）。
        // 工具层是唯一同时握着改写动作与本轮会话的入口：没给 reason 就退回当轮用户
        // 原话，取法与注入侧共用同一份实现（src/inject.js 的 lastUserQuery），不复制
        // 第二份。两边都取不到时仍然写 NULL——空串会假装「有意图」，NULL 才说实话。
        const exec = arguments[1];
        const reason = typeof args.reason === "string" ? args.reason.trim() : "";
        const query = reason || lastUserQuery(exec) || undefined;
        const memory = service.update(args.id, {
          title: args.title,
          content: args.content,
          type: args.type,
          tags: args.tags,
          importance: args.importance,
          // 复核项 4（#170）：strictScope 下他 scope 的行按「不存在」处理（与 get 对齐），
          // 展开恒为 undefined，仅承担写入前校验。
          ...(assertVisibleForTool(args.id, exec)),
          ...(args.agent_scope !== undefined ? { agent_scope: args.agent_scope } : {}),
          ...(args.workspace_scope !== undefined ? { workspace_scope: args.workspace_scope } : {})
        }, { query });
        return { memory: { id: memory.id, title: memory.title, content: memory.content } };
      }
    }),

    defineTool({
      name: "memory_delete",
      description: "Permanently delete a memory entry.",
      parameters: {
        id: { type: "string", required: true }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { deleted: { type: "boolean", required: true } }
        },
        render: (_args, value) => TEXT_OUTPUT(value.deleted ? "Memory deleted." : "Memory not found.")
      },
      async execute(args) {
        // 复核项 4（#170）：不可见（explicit 他 scope）= 视作不存在，无存在性泄漏。
        const target = visibleForTool(args.id, arguments[1]);
        if (target) service.remove(args.id);
        return { deleted: !!target };
      }
    }),

    defineTool({
      name: "memory_forget",
      description:
        "Stop a memory from being auto-injected and from appearing in searches and lists without deleting it. " +
        "The entry stays in storage; pass forgotten: false to restore it.",
      parameters: {
        id: { type: "string", required: true },
        forgotten: { type: "boolean", description: "Suppress (true, default) or restore (false) the entry's visibility" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            memory: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                forgotten: { type: "boolean", required: true }
              }
            }
          }
        },
        render: (_args, value) => TEXT_OUTPUT(`Memory ${value.memory.id} injection ${value.memory.forgotten ? "suppressed" : "restored"}.`)
      },
      async execute(args) {
        if (service.getById(args.id) === undefined) {
          throw new Error("memory not found");
        }
        const memory = service.setForget(args.id, args.forgotten ?? true);
        return { memory: { id: memory.id, forgotten: memory.forgotten } };
      }
    }),

    defineTool({
      name: "memory_archive",
      description:
        "Archive a memory (hide it from active lists, search, injection and dream consolidation) or restore it. " +
        "Archived entries stay in storage and are recoverable: pass archived=false to restore, and use memory_list with " +
        "include_archived=true to find archived entries. " +
        "Only archive when the user asks, or an entry is clearly stale/no longer relevant — do not archive proactively mid-session to tidy up.",
      parameters: {
        id: { type: "string", required: true, description: "Memory id" },
        archived: { type: "boolean", description: "Archive (true, default) or restore (false) the entry" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            memory: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                archived: { type: "boolean", required: true }
              }
            }
          }
        },
        render: (_args, value) => TEXT_OUTPUT(`Memory ${value.memory.id} ${value.memory.archived ? "archived" : "restored"}.`)
      },
      async execute(args) {
        if (service.getById(args.id) === undefined) {
          throw new Error("memory not found");
        }
        const memory = service.setArchived(args.id, args.archived ?? true);
        return { memory: { id: memory.id, archived: memory.archived } };
      }
    }),

    // #471：政策轴——作用域级可逆闸门。与 memory_forget/memory_archive 的分工：
    // 那两个是事实轴的单条操作（改的是「这条记忆属于谁 / 还算不算数」，一条条来）；
    // 本工具是政策轴的按作用域操作（改的是「这一路现在通不通」，跨会话存续、
    // 松开即原样回来，一条记忆行都不动）。判断指引：整条工作线要临时静音用本工具；
    // 单条记忆不该再被想起才用 memory_forget/memory_archive。
    defineTool({
      name: "set_scope_state",
      description:
        "Press or release the reversible scope gate for one scope (issue #471): while paused, that scope's memories stay stored and unchanged but are held back from injection and dream consolidation. " +
        "This is not deletion and not forgetting — release with state=active and everything comes back exactly as it was, which is why it is the right tool for temporarily silencing a whole work stream rather than editing memories one by one. " +
        "dimension is agent or workspace; scope_value is the label itself, or * for that dimension's global gate. " +
        "Both switches (scopeState.enabled/enforce) are off by default, so setting a state has no effect on injection until the user turns them on in the panel.",
      parameters: {
        dimension: { type: "string", required: true, description: "Scope dimension to press: \"agent\" or \"workspace\"" },
        scope_value: { type: "string", required: true, description: "The scope label, or \"*\" for that dimension's global gate" },
        state: { type: "string", required: true, description: "\"paused\" presses the gate, \"active\" releases it" },
        note: { type: "string", description: "Optional short reason, stored with the decision so the next reader knows why it was pressed" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            scope: {
              type: "object",
              additionalProperties: false,
              properties: {
                dimension: { type: "string", required: true },
                scope_value: { type: "string", required: true },
                state: { type: "string", required: true },
                // 理由要能读回来：不带它，下次读的人只知道「按下过」却不知道为什么。
                // 这与库层 setScopeState 的 note 取舍是同一条理由——不带理由的重按
                // 不抹掉旧理由，正是为了让这里读得回来。可选：从没写过就没有。
                note: { type: "string" },
                decided_at: { type: "string", required: true }
              }
            }
          }
        },
        // 回执如实回显当前值（不是回显入参）：同一个状态重复按下时 decided_at 保持
        // 首次值，回显它才看得出「这次没有真的改变什么」。
        render: (_args, value) =>
          TEXT_OUTPUT(
            `Scope ${value.scope.dimension}:${value.scope.scope_value} is now ${value.scope.state} (decided at ${value.scope.decided_at}).`
          )
      },
      async execute(args) {
        const dimension = normalizeScopeStateDimension(args.dimension);
        const scopeValue = normalizeScopeStateValue(args.scope_value);
        const state = normalizeScopeStateState(args.state);
        if (dimension === null) throw new Error("dimension must be \"agent\" or \"workspace\"");
        if (scopeValue === null) throw new Error("scope_value must be a non-empty label or \"*\"");
        if (state === null) throw new Error("state must be \"active\" or \"paused\"");
        const row = service.setScopeState({ dimension, scope_value: scopeValue, state, note: args.note });
        if (row === undefined) throw new Error("scope state could not be recorded");
        return {
          scope: {
            dimension: row.dimension,
            scope_value: row.scope_value,
            state: row.state,
            // 没写过理由时键整个不出现（而不是 note: undefined）：output schema 是
            // 闭合的，DTO 矩阵会拿真实返回值过 validateJsonSchemaValue，留一个
            // 值为 undefined 的键等于留个空壳。
            ...(row.note === undefined ? {} : { note: row.note }),
            decided_at: row.decided_at
          }
        };
      }
    }),

    // #230（#164 设计稿评审线）：document 型记忆注册——agent 产长文档的指针
    // 行铸造口。写入权分离：全文归 agent（管线对文件零读零写零改），库里只
    // 存摘要 + doc_path + evidence 三样；C2 比对去重、supersede 记账在
    // service.registerDocument（src/document.js）内完成。判断指引：调研报告/
    // 设计稿/长整理产物「存外档」用本工具；原子事实（偏好/决策/教训）仍走
    // memory_save；tag 与章节名建议用英文（跨语言稳定键），摘要正文可多语言。
    defineTool({
      name: "memory_register_document",
      description:
        "Register an agent-authored document (research report, design doc, long digest) into memory as a pointer row. " +
        "Write-ownership split: the full text stays agent-owned on disk — the pipeline never reads or rewrites it; the DB " +
        "stores only the summary + doc_path + evidence. Validates the file exists (absolute path, non-empty regular file), " +
        "intersects evidence with real memory ids (all-fabricated evidence is rejected; unknown ids are dropped and the row " +
        "is tagged evidence_degraded), and dedupes: re-registering the same path or title supersedes the old row (the old " +
        "file is never touched; content_history stays traceable), while a merely near-duplicate summary of a different " +
        "document row is rejected — update that row instead. On success the absorbed atomic evidence rows leave the active " +
        "face in the same transaction (recoverable, nothing deleted); constraint/preference rows and other " +
        "document/summary rows are never auto-archived, and keep_evidence_active: true opts out. Ids this same document " +
        "absorbed on an earlier version still count as its evidence, so re-registering a new version is not read as " +
        "fabricated evidence. Use for 'where is the conclusion doc for this project?' " +
        "lookups; atomic facts still go to memory_save.",
      parameters: {
        path: { type: "string", required: true, description: "Absolute path of the document file (~ is expanded); must already exist as a non-empty regular file. The full text stays agent-owned — this pipeline never touches it." },
        title: { type: "string", required: true, description: "Short unique title (English recommended: it is the cross-language stable dedupe/supersede key)" },
        summary: { type: "string", required: true, description: "One-paragraph summary stored in the DB and used for injection (any language)" },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags (English recommended)" },
        importance: { type: "integer", description: "1-5 (default 3); the summary row injects at the next-priority tier within documentInjectBudget when importance >= threshold" },
        evidence: { type: "array", items: { type: "string" }, description: "Memory ids this document is grounded in (atomic facts, not other pointer rows); each is verified against the store — fabricated evidence is rejected, unknown/archived ids are dropped and the row is tagged evidence_degraded, except ids this same document absorbed on an earlier version, which stay its evidence. On success the absorbed atomic rows leave the active face unless keep_evidence_active is true." },
        keep_evidence_active: { type: "boolean", description: "Opt out of archiving the evidence rows absorbed by this document. Default false: after a successful registration the absorbed atomic rows leave the active face (recoverable, nothing deleted; constraint/preference rows and other document/summary rows are never auto-archived)." },
        source: { type: "string", description: "Optional provenance" },
        sensitivity: { type: "string", description: "Optional sensitivity label (free-form, e.g. personal). Part of the supersede matching key — same path/title with a different sensitivity stays a separate document." },
        agent_scope: { type: "string", description: "Optional explicit agent-scope declaration (issue #170): 'global' or '*' makes this document visible to every agent; any other value narrows it to that label. Overrides the automatic carrier label for this write; honored even when automatic scope labeling is disabled." },
        workspace_scope: { type: "string", description: "Optional explicit workspace-scope declaration (issue #170): 'global' or '*' makes this document visible in every workspace; any other value narrows it to that label. Overrides the automatic carrier label for this write; honored even when automatic scope labeling is disabled." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", required: true, enum: ["created", "superseded"] },
            id: { type: "string", required: true },
            superseded_id: { type: "string" },
            evidence_kept: { type: "integer", required: true },
            evidence_dropped: { type: "integer", required: true },
            evidence_archived: { type: "integer", required: true },
            degraded: { type: "boolean", required: true }
          }
        },
        render: (_args, value) => {
          const sup = value.superseded_id ? ` (supersedes ${value.superseded_id})` : "";
          const ev = ` | evidence: ${value.evidence_kept} kept, ${value.evidence_dropped} dropped, ${value.evidence_archived} archived${value.degraded ? " [degraded]" : ""}`;
          return TEXT_OUTPUT(`document ${value.action}: ${value.id}${sup}${ev}`);
        }
      },
      async execute(args, exec) {
        // scope 标注与 memory_save 同款（#170）：默认会话身份自动标注，显式
        // 参数逐维覆盖。校验/去重/supersede 全在 service.registerDocument。
        const scope = resolveSessionScope(exec);
        const autoStamping = config?.scopeEnabled === true;
        const agentLabel = args.agent_scope !== undefined
          ? { value: normalizeExplicitScope(args.agent_scope), source: "explicit" }
          : autoStamping && scope ? { value: scope.agent_scope, source: "auto" } : null;
        const workspaceLabel = args.workspace_scope !== undefined
          ? { value: normalizeExplicitScope(args.workspace_scope), source: "explicit" }
          : autoStamping && scope ? { value: scope.workspace_scope, source: "auto" } : null;
        // strictScope（#170 复核项 4 同款无存在性泄漏）：他 scope 的 evidence id
        // 按「不存在」处理——注册器用全局 getById 求交，看不见的行在这里先标出，
        // 与 unknown/archived 同落 dropped，不进持久化 evidence（不得为跨 scope
        // id 建立引用）。
        const hiddenEvidence = [];
        if (config?.strictScope === true && scope && Array.isArray(args.evidence)) {
          for (const raw of args.evidence) {
            const id = String(raw ?? "").trim();
            if (!id) continue;
            const row = service.getById(id);
            if (row && !service.isVisibleInScope(row, scope)) hiddenEvidence.push(id);
          }
        }
        const result = await service.registerDocument({
          path: args.path,
          title: args.title,
          summary: args.summary,
          tags: args.tags ?? [],
          ...(args.importance !== undefined ? { importance: args.importance } : {}),
          evidence: args.evidence ?? [],
          source: args.source ?? "tool",
          ...(args.sensitivity !== undefined ? { sensitivity: args.sensitivity } : {}),
          ...(agentLabel ? { agent_scope: agentLabel.value, agent_scope_source: agentLabel.source } : {}),
          ...(workspaceLabel ? { workspace_scope: workspaceLabel.value, workspace_scope_source: workspaceLabel.source } : {})
        }, {
          hiddenEvidenceIds: hiddenEvidence,
          // 默认开着归档（#275 拍板 5）；agent 显式要保留活跃面时走 keep_evidence_active。
          archiveEvidence: args.keep_evidence_active !== true
        });
        return {
          action: result.action,
          id: result.memory.id,
          ...(result.superseded ? { superseded_id: result.superseded.id } : {}),
          evidence_kept: result.evidence_kept,
          evidence_dropped: result.evidence_dropped,
          evidence_archived: result.evidence_archived,
          degraded: result.degraded
        };
      }
    }),

    // #231 第二批：agent 主动整理接口的调用入口。引擎在 src/organize.js（PR #267），
    // 当时刻意「不进工具列表、不加独立 opt-in 开关——#249 到位时只差注册工具一步」，
    // 本条就是那一步。工具描述是 agent 侧唯一的协议说明，所以两步规则（apply 必须带
    // 真实 run_id、筛除=discard 不删任何东西、archive 可恢复）都写在这里：本体已经
    // 强制了这些，描述的作用是让第一次调用就成功，而不是靠被拒后试错。
    defineTool({
      name: "memory_organize",
      description:
        "Close out a stretch of work: compare candidate memories against the store first, then land only what you decide to keep. " +
        "Two steps through one tool. mode=dryRun (default) takes `candidates` and answers one verdict per candidate — exact / near / new — with the " +
        "matched row when there is one; it writes NO memories, only an audit receipt. mode=apply takes that report's `run_id` plus one decision per " +
        "candidate (save | discard) and may archive a row the report flagged as superseded (action=archive with that matched id). " +
        "apply is rejected without a real run_id, and a report can be applied only once: candidates that were never compared cannot be written, and " +
        "a row the report never matched cannot be archived. Discard keeps a candidate out and deletes nothing; archive is recoverable and never " +
        "physically removes a row. This tool exists only when organizeEnabled is on (off by default, and off in lightweight mode) — if it is missing " +
        "from your tool list the user has not enabled it. For a single write use memory_save instead.",
      parameters: {
        mode: { type: "string", description: '"dryRun" (default: compare and report, writes nothing) or "apply" (land the decisions of a reported dryRun)' },
        candidates: {
          type: "array",
          // 宿主强制的 JSON Schema 子集要求 object 显式声明 additionalProperties，
          // 所以候选字段在这里逐键写死：scope **来源**两列（*_scope_source）故意不给
          // ——那是可信调用层盖的章，不是模型可自选的内容。
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { type: "string", required: true, description: "Memory type (project / preference / constraint / ... ; 'document' is rejected here — it is minted by memory_register_document)" },
              title: { type: "string", required: true, description: "Short stable title — part of the dedupe key (type + title + scope)" },
              content: { type: "string", required: true, description: "The body that would be stored" },
              importance: { type: "integer", description: "1-5 (default 3)" },
              tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
              sensitivity: { type: "string", description: "Optional per-candidate sensitivity, overriding the payload-level default" },
              agent_scope: { type: "string", description: "Optional per-candidate agent scope, overriding the payload-level default" },
              workspace_scope: { type: "string", description: "Optional per-candidate workspace scope, overriding the payload-level default" }
            }
          },
          description: "dryRun only: candidates to compare (hard cap 50 per call — this is for closing out a work stretch, not bulk import). Candidates missing type/title/content, or of type document, come back in `skipped`."
        },
        run_id: { type: "string", description: "apply only: the run_id returned by the dryRun report you are acting on" },
        decisions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              action: { type: "string", required: true, enum: ["save", "discard", "archive"], description: 'save writes the candidate at `index` through the normal dedupe path (an existing row with the same key is merged, not duplicated); discard keeps it out and deletes nothing; archive hides the row at `id` (recoverable, and only legal for a row this report matched)' },
              index: { type: "integer", description: "save | discard: the candidate index from the dryRun report" },
              id: { type: "string", description: "archive: id of the matched row to archive" }
            }
          },
          description: "apply only: one entry per candidate you judged. Entries whose index the dryRun never accepted are reported in `skipped`."
        },
        sensitivity: { type: "string", description: "dryRun only: payload-level default sensitivity label for candidates that do not set their own (also the scope dimension the comparison runs within)" },
        agent_scope: { type: "string", description: "dryRun only: payload-level default agent scope for candidates that do not set their own. 'global' or '*' widens visibility to every agent; any other value narrows it. Defaults to this session's auto-stamped agent label when scope labeling is on (same rule as memory_save)." },
        workspace_scope: { type: "string", description: "dryRun only: payload-level default workspace scope for candidates that do not set their own. 'global' or '*' widens visibility to every workspace; any other value narrows it. Defaults to this session's auto-stamped workspace label when scope labeling is on." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            // mode 是判别键：两种分支的返回键集不同，渲染与调用方都要靠它分流。
            mode: { type: "string", required: true, enum: ["dryRun", "apply"] },
            run_id: { type: "string", required: true },
            status: { type: "string", required: true },
            skipped: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  index: { type: "integer", required: true },
                  action: { type: "string" },
                  error: { type: "string", required: true },
                  ids: { type: "array", items: { type: "string" } }
                }
              }
            },
            // --- dryRun 分支 ---
            created_at: { type: "string" },
            counts: {
              type: "object",
              additionalProperties: false,
              properties: {
                total: { type: "integer", required: true },
                exact: { type: "integer", required: true },
                near: { type: "integer", required: true },
                new: { type: "integer", required: true },
                skipped: { type: "integer", required: true },
                truncated: { type: "integer", required: true }
              }
            },
            items: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  index: { type: "integer", required: true },
                  type: { type: "string", required: true },
                  title: { type: "string", required: true },
                  verdict: { type: "string", required: true, enum: ["exact", "near", "new"] },
                  // match.sim 只在向量档命中时出现（exact 档无相似度可报）；
                  // 归档目标必须是报告里出现过的 id，所以这条链接就是 archive 的凭据。
                  match: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      id: { type: "string", required: true },
                      title: { type: "string", required: true },
                      sim: { type: "number" }
                    }
                  }
                }
              }
            },
            // --- apply 分支 ---
            dry_run_id: { type: "string" },
            saved: { type: "integer" },
            merged: { type: "integer" },
            discarded: { type: "integer" },
            archived: { type: "integer" },
            memory_ids: { type: "array", items: { type: "string" } },
            degraded: { type: "boolean" }
          }
        },
        render: (_args, value) => {
          if (value.mode === "apply") {
            return TEXT_OUTPUT(
              `organize applied (${value.run_id}, report ${value.dry_run_id}): ${value.saved} saved, ${value.merged} merged, ` +
              `${value.archived} archived, ${value.discarded} discarded${value.skipped.length ? ` | ${value.skipped.length} skipped` : ""}.`
            );
          }
          const c = value.counts;
          return TEXT_OUTPUT(
            `organize dryRun ${value.run_id}: ${c.total} compared — ${c.new} new, ${c.exact} exact, ${c.near} near` +
            `${c.skipped ? `, ${c.skipped} rejected` : ""}${c.truncated ? `, ${c.truncated} over the cap not compared` : ""}. ` +
            `Nothing was written; pass this run_id with your decisions to memory_organize mode=apply.`
          );
        }
      },
      async execute(args, exec) {
        const mode = String(args?.mode ?? "dryRun").trim();
        const scope = resolveSessionScope(exec);
        const autoStamping = config?.scopeEnabled === true;
        // 载荷级缺省与 memory_save 同源：显式参数盖 explicit 章，否则吃会话自动标注
        // 盖 auto 章。少了这一步，整理接口就成了第二条「写进库却不带 scope」的通道
        // ——candidates 会全部落在未标注（全局可见）那一档。
        const agentLabel = args.agent_scope !== undefined
          ? { value: normalizeExplicitScope(args.agent_scope), source: "explicit" }
          : autoStamping && scope ? { value: scope.agent_scope, source: "auto" } : null;
        const workspaceLabel = args.workspace_scope !== undefined
          ? { value: normalizeExplicitScope(args.workspace_scope), source: "explicit" }
          : autoStamping && scope ? { value: scope.workspace_scope, source: "auto" } : null;
        const hiddenIds = [];
        if (mode === "apply" && config?.strictScope === true && scope && Array.isArray(args.decisions)) {
          // #170 复核项 4 的口径延伸（register_document 的 hiddenEvidenceIds 同形）：
          // 他 scope 的 explicit 行按「不存在」处理，由**可信调用层**算好传入，绝不
          // 取 payload 里的字段——那是调用方可自选的内容，不是授权。少了这一段，
          // archive 就成了第二条绕过 scope 治理的改库通道。
          for (const decision of args.decisions) {
            if (String(decision?.action ?? "").trim() !== "archive") continue;
            const id = String(decision?.id ?? "").trim();
            if (!id) continue;
            const row = service.getById(id);
            if (row && !service.isVisibleInScope(row, scope)) hiddenIds.push(id);
          }
        }
        const result = await service.organize(
          {
            mode,
            ...(args.candidates !== undefined ? { candidates: args.candidates } : {}),
            ...(args.run_id !== undefined ? { run_id: args.run_id } : {}),
            ...(args.decisions !== undefined ? { decisions: args.decisions } : {}),
            ...(args.sensitivity !== undefined ? { sensitivity: args.sensitivity } : {}),
            ...(agentLabel ? { agent_scope: agentLabel.value, agent_scope_source: agentLabel.source } : {}),
            ...(workspaceLabel ? { workspace_scope: workspaceLabel.value, workspace_scope_source: workspaceLabel.source } : {})
          },
          { hiddenIds }
        );
        if (mode === "apply") {
          return {
            mode: "apply",
            run_id: result.run_id,
            dry_run_id: result.dry_run_id,
            status: result.status,
            saved: result.saved,
            merged: result.merged,
            discarded: result.discarded,
            archived: result.archived,
            memory_ids: result.memory_ids,
            skipped: result.skipped,
            degraded: result.degraded
          };
        }
        // dryRun 的落点必须过一遍调用方的可见性。`agent_scope` / `workspace_scope`
        // 是模型自己给的参数，而 `organize.dryRun` 的比对只看三列**值**（不看
        // `*_scope_source`、不调 `isVisibleInScope`）——不过这一关，dryRun 就成了
        // 「那一档有没有这个标题」的探测口：#170 复核项 4 给 memory_get / memory_delete
        // 的口径是「不存在」，这里也按不存在说，落点一个键都不带。
        // counts 跟着重算：留着引擎那份计数，`exact: 1` 配一个不带 match 的条目本身就是
        // 存在性oracle，等于把泄露从 id 挪到计数器。审计行仍存原始落点（那是给操作者看的
        // 证据面），apply 侧另有 hiddenIds 挡归档。
        const visibleItems = result.items.map((item) => {
          const match = item.match && visibleUnderStrictScope(service.getById(item.match.id), exec) ? item.match : null;
          return {
            index: item.index,
            type: item.type,
            title: item.title,
            verdict: match ? item.verdict : "new",
            ...(match ? { match: { id: match.id, title: match.title, ...(match.sim != null ? { sim: match.sim } : {}) } } : {})
          };
        });
        const verdictCount = (verdict) => visibleItems.filter((i) => i.verdict === verdict).length;
        return {
          mode: "dryRun",
          run_id: result.run_id,
          created_at: result.created_at,
          status: result.status,
          counts: {
            total: visibleItems.length,
            exact: verdictCount("exact"),
            near: verdictCount("near"),
            new: verdictCount("new"),
            skipped: result.counts.skipped,
            truncated: result.counts.truncated
          },
          items: visibleItems,
          skipped: result.skipped
        };
      }
    }),

    // 运行时口子（issue #131 / PR-C）。
    //
    // 为什么要有这个工具：mneme 的取向是「本体保持完善但轻量；重的功能存在、默认不开、不被依赖」。
    // 本地向量化就是那个重功能 —— 它需要额外一份运行时（解包后数百 MB）。面板上有按钮，但用户
    // 可能根本不看面板；这时 agent 需要一个入口，能先查状态、把代价告诉用户，再按需取回。
    //
    // 关于「要不要直接 provision」：它会联网、可能传几十到上百 MB、耗时数分钟。所以工具描述里
    // 明确要求先告知用户；只有在用户已经表示要本地向量化时才直接动手。
    defineTool({
      name: "memory_runtime",
      description:
        "Inspect or provision the LOCAL inference runtime that dsh-mneme's local (offline) embedding and rerank need: " +
        "the transformers + onnxruntime dependency closure, hundreds of MB unpacked. It is deliberately NOT a default " +
        "dependency — mneme's core stays lightweight and local vectorization is opt-in — so this tool is the hook that " +
        "makes the heavy capability available on demand. Use action=status first: it is read-only and reports whether " +
        "the runtime is ready plus what provisioning would cost. action=provision tries, in order: (1) adopting an " +
        "existing copy from this profile's node_modules (no network; hardlinked when on the same volume, so no extra " +
        "disk), (2) a configured local .tgz directory, (3) downloading from the npm registry against a pinned manifest, " +
        "verifying every tarball's sha512. Provisioning can transfer tens to hundreds of MB and take minutes: unless " +
        "the user has already asked for local vectorization, tell them that cost before calling it. action=verify loads " +
        "the runtime and runs one real inference (strictly offline, so the model must already be cached).",
      parameters: {
        action: { type: "string", enum: ["status", "provision", "verify"], required: true, description: "status = read-only; provision = fetch/adopt the runtime; verify = run one real inference" },
        overwrite: { type: "boolean", description: "provision only: replace an existing payload (use when repairing a broken one)" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            summary: { type: "string", required: true },
            status: { type: "string", required: true },
            cost: { type: "string", required: true },
            strategy: { type: "string" },
            payloadId: { type: "string" },
            packages: { type: "integer" },
            files: { type: "integer" },
            bytes: { type: "integer" },
            dimension: { type: "integer" },
            reason: { type: "string" }
          }
        },
        render: (_args, value) => TEXT_OUTPUT(value.summary)
      },
      async execute(args) {
        const runtimeDir = config?.runtimeDir ?? "";
        const manifest = loadRuntimeManifest();
        const forPlatform = Array.isArray(manifest?.packages) ? manifest.packages.filter((pkg) => matchesPlatform(pkg, process.platform, process.arch)) : null;
        const cost =
          `Local vectorization needs an extra local inference runtime (transformers + onnxruntime closure, ` +
          `hundreds of MB unpacked${forPlatform ? `, ${forPlatform.length} packages for this platform` : ""}). ` +
          `It is not a default dependency: provisioning adopts an existing copy when possible, otherwise downloads it.`;

        if (args.action === "provision") {
          const result = await provisionRuntime({
            hostModulesDir: hostModulesDir(import.meta.url),
            runtimeDir,
            localTarballDir: config?.runtimeTarballDir ?? "",
            mirror: config?.runtimeMirror ?? "",
            overwrite: args.overwrite === true,
            manifest
          });
          return {
            summary: result.ok
              ? `Runtime ${result.strategy === "download" ? "downloaded from npm" : "adopted from this machine"}: ` +
                `${result.packages} packages / ${result.files} files. Local embedding can be used after a DSH reload.`
              : `Could not provision the runtime: ${result.reason}`,
            status: result.ok ? "available" : "failed",
            cost,
            strategy: result.strategy,
            ...(result.payloadId ? { payloadId: result.payloadId } : {}),
            ...(result.packages === undefined ? {} : { packages: result.packages }),
            ...(result.files === undefined ? {} : { files: result.files }),
            ...(result.bytes === undefined ? {} : { bytes: result.bytes }),
            ...(result.reason ? { reason: result.reason } : {})
          };
        }

        if (args.action === "verify") {
          const candidate = resolveRuntimeEntry({ runtimeDir: runtimeDir || undefined });
          if (candidate === null) {
            return { summary: "No usable runtime payload to verify.", status: "missing", cost };
          }
          // 验的必须是用户真实在用的那一份：缓存目录与嵌入模型都跟配置走。空目录交给 verify
          // 自己补默认值（「空 = ~/.dsh/mneme/models」是配置与文档的约定，嵌入侧同一份解析）；
          // 模型不给会让 verify 恒探默认小模型，用户换了模型时这份结论就不是他实际使用的那份（#387）。
          const report = await verifyPayload(candidate.dir, {
            cacheDir: config?.embedModelCacheDir,
            model: config?.localEmbedModel || undefined
          });
          return {
            summary: report.ok
              ? `Runtime verified: real inference succeeded (dim ${report.functional.dim}, ${report.functional.rows} rows, ` +
                `${report.functional.elapsedMs}ms, offline). Integrity: ${report.integrity.status}.`
              : `Runtime verification failed — structural: ${report.structural.ok}, functional: ${report.functional.ok} (${report.functional.reason}).`,
            status: report.ok ? "verified" : "failed",
            cost,
            payloadId: candidate.payloadId,
            ...(report.functional.dim ? { dimension: report.functional.dim } : {}),
            ...(report.ok ? {} : { reason: report.functional.reason })
          };
        }

        // status：只读，且刻意不加载模型（那要几百毫秒且碰缓存）。报告要给到 agent 足够的信息去
        // 决定「要不要打扰用户」。
        const report = describeLocalRuntime({ runtimeDir: runtimeDir || defaultRuntimeDir() });
        return {
          summary:
            `Local inference runtime: ${report.status}` +
            (report.payloadId ? ` (${report.payloadId}, ${report.procedure ?? "?"}, ${report.materialize ?? "?"})` : "") +
            `. ${report.status === "available" ? "Local embedding/rerank can be used." : "Local embedding is unavailable — " + (report.hint ?? "")}`,
          status: report.status,
          cost,
          ...(report.payloadId ? { payloadId: report.payloadId } : {}),
          ...(forPlatform ? { packages: forPlatform.length } : {}),
          ...(report.reason ? { reason: report.reason } : {})
        };
      }
    })
  ];

  // Tool-exposure gate (v0.8.5): 跨会话记忆已自动注入，memory_search /
  // memory_archive 在慢/轻量模型上是多余往返，面板开关可直接隐藏工具——
  // 模型看不到就不会调，比在描述里劝它少调用更可靠。注意：live patch reload
  // 下已注册的工具不会被宿主反注册，排除只对全新会话生效。
  const hiddenTools = new Set();
  if (config?.disableMemorySearch === true) hiddenTools.add("memory_search");
  if (config?.disableMemoryArchive === true) hiddenTools.add("memory_archive");
  // #231 第二批是**反向**语义：memory_organize 默认不在场，organizeEnabled 打开才
  // 注册。仍走同一个闸门而不是在数组里条件展开——模型看不到就不会调，这比在描述里
  // 劝它别用可靠（上面那段 v0.8.5 的定性对两个方向都成立）。
  if (config?.organizeEnabled !== true) hiddenTools.add("memory_organize");

  for (const tool of tools) {
    if (hiddenTools.has(tool.name)) {
      ctx.logger?.info?.(`[dsh-mneme] tool "${tool.name}" hidden by config (disableMemorySearch/disableMemoryArchive/organizeEnabled)`);
      continue;
    }
    if (registeredTools.has(tool.name)) {
        ctx.logger?.warn?.(`[dsh-mneme] tool "${tool.name}" already registered, skipping duplicate`);
        continue;
      }
      // #539：闸门包在**注册期**，而不是在 execute 内部各写一遍。已注册的执行器
      // 不会被宿主反注册（同上面 disableMemorySearch 那段 v0.8.5 的定性），所以
      // 包一层的意义在于：热重载后 registration.sessionGate 换成新实例，旧的执行器
      // 也跟着读新的闸门，不会拿着过期 config 继续放行。
      //
      // 取会话走 sessionOf(exec) = exec.agent.session。ToolExecutionInput.agent 在
      // 宿主类型里是**可选**的，PTC 内层派发可能压根不带 agent；这种调用会拿到
      // null → isOff(null) 为 false → 放行。这是有意的：不认识调用者的工具调用
      // 不能一律拒绝（那会把正常会话也打死），闸门只对「能证明自己是谁」的调用生效。
      if (typeof tool.execute === "function") {
        const execute = tool.execute.bind(tool);
        tool.execute = async (args, exec) => {
          if (registration.sessionGate?.isOff(sessionOf(exec))) {
            throw new Error("dsh-mneme: memory tools are disabled for this incognito session");
          }
          return execute(args, exec);
        };
      }
      registeredTools.add(tool.name);
      ctx.tools.register(tool);
  }

  return tools;
}
