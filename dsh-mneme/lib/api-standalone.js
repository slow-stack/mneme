// Standalone HTTP API: a plain node:http server for ecosystem
// integrations that live outside the DSH host and cannot reach the plugin's
// internal webServer routes (/api/dsh-mneme/*). Mirrors the JSON semantics of
// those routes but with mandatory Bearer-token auth on everything except
// GET /health, so the store can be exposed safely on loopback.
//
// #181 (MCP stdio server, bin/dsh-mneme-mcp.mjs) rides on these routes as its
// data plane: the six-tool surface (memory_save/search/list/get/update/delete)
// is fully served here — PUT /memories/:id, the save passthrough fields
// (sensitivity / occurred_at / explicit scope) and the list/search archived +
// occurred-window filters exist for that parity, with tool-identical semantics.
//
// Security: the default bind host is 127.0.0.1. Pointing externalApiHost at a
// non-loopback address exposes the whole memory store to the network — that is
// the operator's explicit responsibility (documented in README).
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { TYPES } from "./store.js";
import { bootstrapFromDirectory } from "./bootstrap.js";
import { PACKAGE_VERSION } from "./version-check.js";
import { parseReclaimJson, readReclaimFields, reclaimReply, RECLAIM_UNAVAILABLE } from "./reclaim-http.js";
import { parseShareBody, shareReply, parseReceiveBody, receiveReply, parseUndoBody, undoReply } from "./share-http.js";

const DEFAULT_PORT = 8790;
const DEFAULT_HOST = "127.0.0.1";
const MAX_PORT_ATTEMPTS = 20;
// 请求体与分页上界（防御，不是功能）：与宿主内 api.js 的 MAX_REQUEST_BODY_BYTES /
// MAX_PAGE_LIMIT / MAX_SEARCH_TOP_K 同值同义——两张数据面的口径必须一致，否则
// 「从哪张脸进来」会决定一次请求能吃掉多少内存。
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
const MAX_PAGE_LIMIT = 1000;
const MAX_SEARCH_TOP_K = 200;

/**
 * Listen with automatic EADDRINUSE recovery. Tries the configured port, then
 * the next MAX_PORT_ATTEMPTS-1 ports, and finally falls back to port 0 so the
 * OS assigns a free port. Multiple DSH profiles/instances sharing the default
 * port no longer leave the standalone API permanently unavailable.
 *
 * strictPort opts out of that recovery (dsh-mneme-serve daemon, #363): a
 * long-lived third-party integration pins the URL, so silently hopping ports
 * would make clients talk to nothing (or, worse, to a future different data
 * plane). A busy configured port is a configuration error there — fail loud.
 */
function listenWithRetry(server, startPort, host, logger, strictPort = false) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (port) => {
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        resolve(address && typeof address === "object" ? address.port : port);
      };
      const onError = (error) => {
        server.off("listening", onListening);
        if (error?.code === "EADDRINUSE" && strictPort) {
          reject(error);
          return;
        }
        if (error?.code === "EADDRINUSE" && attempt < MAX_PORT_ATTEMPTS - 1) {
          attempt++;
          const next = startPort + attempt;
          logger?.warn?.(`[dsh-mneme] standalone API port ${port} in use, retrying ${next}`);
          tryListen(next);
          return;
        }
        if (error?.code === "EADDRINUSE") {
          logger?.warn?.(`[dsh-mneme] standalone API port ${port} still in use, falling back to OS-assigned port`);
          tryListen(0);
          return;
        }
        reject(error);
      };
      server.once("listening", onListening);
      server.once("error", onError);
      server.listen(port, host);
    };
    tryListen(startPort);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/** True when the request carries the configured token. */
function isAuthorized(req, apiToken) {
  const raw = req.headers?.authorization ?? req.headers?.["x-dsh-mneme-token"] ?? "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw.trim();
  if (token === "" || token.length !== apiToken.length) return false;
  // Constant-time comparison: no timing oracle on the token.
  return timingSafeEqual(Buffer.from(token), Buffer.from(apiToken));
}

/**
 * Collect the request body as text, or null when it exceeds the cap.
 *
 * 超限时**必须回 null 而不是空串**：空串经 parseBody 变成 {}，而 /profile、
 * /rules、/persona 的 PUT 会把「字段缺失」当成「用户要清空」——一个 5 MiB 的
 * 请求就能把画像/规则/人格静默清掉。返回 null 让调用点在碰任何 store 之前
 * 直接 413（2026-10 评审指出的数据损坏路径）。
 * 连接不 destroy：调用方要能收到明确的 413，而不是被掐断。
 */
function readBody(req, res) {
  return new Promise((resolve) => {
    let body = "";
    let bytes = 0;
    let overflow = false;
    req.on("data", (chunk) => {
      if (overflow) return;
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        overflow = true;
        body = "";
        sendJson(res, 413, { error: "payload-too-large", limit: MAX_REQUEST_BODY_BYTES });
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(overflow ? null : body));
    // 超限后再来 transport error 也必须保留超限状态：否则调用点会拿着空串
    // 继续往 store 写（PUT /persona 把 "" 解析成 {}，覆盖既有设置）。
    req.on("error", () => resolve(overflow ? null : ""));
  });
}

/**
 * PUT /memories/:id 的请求体处理（模块级函数便于在调用点被 try/catch 包住：
 * service 抛错绝不能变成未处理拒绝或悬着不回的请求）。校验与内部
 * /api/dsh-mneme/update 同风格：字段出现就必须合法，宁 400 不静默纠正；
 * content 改写按 human_override 入档；scope 修正归一化在 service 层做
 * （null=放宽到全局，字符串=收窄/改标），审计 actor 记 "tool"。
 */
async function handlePutBody(res, service, logger, id, text) {
  let body;
  try {
    body = JSON.parse(text || "{}");
  } catch {
    sendJson(res, 400, { error: "invalid-json" });
    return;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    sendJson(res, 400, { error: "invalid-body" });
    return;
  }
  const patch = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) {
      sendJson(res, 400, { error: "invalid-title" });
      return;
    }
    patch.title = body.title.trim();
  }
  if (body.content !== undefined) {
    if (typeof body.content !== "string" || !body.content.trim()) {
      sendJson(res, 400, { error: "invalid-content" });
      return;
    }
    patch.content = body.content.trim();
  }
  if (body.type !== undefined) {
    if (!TYPES.has(body.type)) {
      sendJson(res, 400, { error: "invalid-type" });
      return;
    }
    patch.type = body.type;
  }
  if (body.importance !== undefined) {
    if (!Number.isInteger(body.importance) || body.importance < 1 || body.importance > 5) {
      sendJson(res, 400, { error: "invalid-importance" });
      return;
    }
    patch.importance = body.importance;
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || !body.tags.every((t) => typeof t === "string")) {
      sendJson(res, 400, { error: "invalid-tags" });
      return;
    }
    patch.tags = body.tags;
  }
  if (body.agent_scope !== undefined && body.agent_scope !== null && typeof body.agent_scope !== "string") {
    sendJson(res, 400, { error: "invalid-agent-scope" });
    return;
  }
  if (body.workspace_scope !== undefined && body.workspace_scope !== null && typeof body.workspace_scope !== "string") {
    sendJson(res, 400, { error: "invalid-workspace-scope" });
    return;
  }
  if (body.agent_scope !== undefined) patch.agent_scope = body.agent_scope;
  if (body.workspace_scope !== undefined) patch.workspace_scope = body.workspace_scope;
  if (body.reason !== undefined && (typeof body.reason !== "string" || !body.reason.trim())) {
    sendJson(res, 400, { error: "invalid-reason" });
    return;
  }
  if (Object.keys(patch).length === 0) {
    sendJson(res, 400, { error: "no-fields" });
    return;
  }
  const existing = service.getById(id);
  if (!existing) {
    sendJson(res, 404, { error: "not-found" });
    return;
  }
  if (patch.type === "document" && existing.type !== "document") {
    // #230 写入权分离：type 不许改入 document（铸造口唯一），干净 400。
    sendJson(res, 400, { error: "document-requires-register" });
    return;
  }
  // 内容被改写时旧版本先入档（human_override），与内部面板写路径一致。
  if (patch.content !== undefined && patch.content !== existing.content) {
    const history = Array.isArray(existing.content_history) ? existing.content_history : [];
    patch.content_history = [
      { content: existing.content ?? "", source: "human_override", updated_at: new Date().toISOString() },
      ...history
    ].slice(0, 20);
  }
  service.update(id, patch, {
    actor: "tool",
    ...(typeof body.reason === "string" && body.reason.trim() ? { query: body.reason.trim() } : {})
  });
  sendJson(res, 200, { memory: service.toApiList([service.getById(id)])[0] });
}

/**
 * /context 的查询嵌入：best-effort，embedder 接口宽容与 searchMemories 同款
 * （embedSingle 优先，兼容 embed-only 的 OpenAI 兼容客户端，issue #10）。
 * 调用方负责 catch——嵌入失败降级规则档，绝不因此 500。
 */
async function embedQueryVector(embedder, q) {
  const embedSingle = typeof embedder.embedSingle === "function"
    ? embedder.embedSingle.bind(embedder)
    : typeof embedder.embed === "function"
      ? embedder.embed.bind(embedder)
      : null;
  if (!embedSingle) return undefined;
  const vector = await embedSingle(q);
  return Array.isArray(vector) && vector.length ? vector : undefined;
}

/**
 * /context 查询嵌入的超时护栏（CodeRabbit on #371）：embedder 挂起（不抛错，
 * 典型如第三方 ollama/openai 端点无响应）时不能让 HTTP 连接被无限占住——超时
 * 按嵌入缺失处理，降级规则档。输掉的 embed promise 无法取消、自行结束后被丢弃，
 * 无害；挂起的主要成本是一个泄漏的挂起任务，可接受。嵌入先完成时清掉定时器
 * （CodeRabbit 同轮 Minor：别让每个请求都留一枚要等满超时的计时器）。
 */
function withEmbedTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * scope 查询参数（/context 与 /search 同口径，issue #370）：两参全缺 = 返回
 * undefined（调用方不传 scope 走各自默认，行为与既往逐字节一致）；任一给出则
 * 缺的一维按「解析不到」（null）走 isVisibleInScope 的 fail-closed——身份不明
 * 的维度只见全局，不冒认，与宿主会话 scope 解析器同构。
 */
function scopeFromSearchParams(url) {
  const agentScope = url.searchParams.get("agent_scope");
  const workspaceScope = url.searchParams.get("workspace_scope");
  if (agentScope === null && workspaceScope === null) return undefined;
  return { agent_scope: agentScope, workspace_scope: workspaceScope };
}

/**
 * Create (and start) the standalone API server.
 * Accepts { service, store, config, logger, settings, port, host, embedder }:
 *   - token: persisted settings kv "external_api" wins; auto-generated
 *     (crypto.randomBytes(24).toString("base64url")) and persisted when empty.
 *   - port:  explicit arg > persisted settings > config.externalApiPort > 8790.
 *   - host:  explicit arg > config.externalApiHost > "127.0.0.1".
 *   - strictPort: EADDRINUSE rejects instead of hopping ports (daemon mode;
 *     default false keeps the in-host sidecar recovery described above).
 *   - embedder: query-embedding handle for GET /context (issue #370) — same
 *     instance the caller handed to service.setEmbedder; null degrades /context
 *     to the rule + BM25 tier. Best-effort: embed failures never fail the route.
 *   - embedTimeoutMs: /context query-embed guard (default 3000) — a hung
 *     embedder must not hold the HTTP connection; timeout degrades to the rule
 *     tier. Factory option (like strictPort), not a user config key.
 * Returns { server, port, host, token, ready }: `port` is the effective bound
 * port (updated to the OS-assigned one after `ready` resolves when asked to
 * bind port 0), `ready` resolves once listening and rejects if the bind fails.
 */
export function createStandaloneApi({ service, store, config = {}, logger, settings, port, host, maintenance, strictPort = false, embedder = null, embedTimeoutMs = 3000 }) {
  const persisted = settings?.getExternalApi?.() ?? {};

  let token = typeof persisted.token === "string" ? persisted.token : "";
  if (!token) {
    token = randomBytes(24).toString("base64url");
    // Persist only the token; enabled/port keys stay as they are (merge).
    try {
      settings?.setExternalApi?.({ token });
    } catch (error) {
      logger?.warn?.(`[dsh-mneme] standalone API token persistence failed: ${String(error)}`);
    }
  }

  // Persisted host (set from the panel) wins over the bundle config, same
  // precedence as port; the explicit argument still wins over both.
  const boundHost = host
    ?? (typeof persisted.host === "string" && persisted.host ? persisted.host : undefined)
    ?? config.externalApiHost
    ?? DEFAULT_HOST;
  const persistedPort = Number(persisted.port);
  const boundPort = port
    ?? (Number.isInteger(persistedPort) && persistedPort > 0 ? persistedPort : undefined)
    ?? config.externalApiPort
    ?? DEFAULT_PORT;

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;

      // Health is the single unauthenticated probe (monitor checks).
      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Everything else requires the Bearer token.
      if (!isAuthorized(req, token)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      // --- GET /status: version + store shape + uptime -----------------------
      if (req.method === "GET" && pathname === "/status") {
        const byType = {};
        for (const type of TYPES) byType[type] = service.count(type);
        let entities = 0;
        try {
          entities = store.db.prepare("SELECT count(*) AS c FROM entities").get().c;
        } catch { /* entities storage unavailable → 0 */ }
        sendJson(res, 200, {
          version: PACKAGE_VERSION,
          memories: { total: service.count(), byType },
          entities,
          uptime_s: Math.floor(process.uptime())
        });
        return;
      }

      // --- GET /profile: user self-description -------------------------------
      if (req.method === "GET" && pathname === "/profile") {
        sendJson(res, 200, { profile: settings?.getProfile?.() ?? "" });
        return;
      }

      // --- GET /persona: agent persona（人格定义页，beta；v1.2 多卡形） --------
      if (req.method === "GET" && pathname === "/persona") {
        sendJson(res, 200, { persona: settings?.getPersona?.() ?? { default: {}, byAgent: {} } });
        return;
      }

      // --- PUT /persona: write default (single-object form) or full multi-card
      // 形状判定在 setPersona 内（settings.js 双形兼容：单对象=合并 default、
      // 多卡=全量替换）；坏 JSON 回 400（与 /memories 写路径同口径）。
      if (req.method === "PUT" && pathname === "/persona") {
        void readBody(req, res).then((text) => {
          if (text === null) return;
          let body;
          try {
            body = JSON.parse(text || "{}");
          } catch {
            sendJson(res, 400, { error: "invalid-json" });
            return;
          }
          const persona = body && typeof body === "object" && !Array.isArray(body) && body.persona && typeof body.persona === "object"
            ? body.persona
            : body;
          try {
            settings?.setPersona?.(persona && typeof persona === "object" ? persona : {});
            sendJson(res, 200, { persona: settings?.getPersona?.() ?? { default: {}, byAgent: {} } });
          } catch {
            sendJson(res, 500, { error: "internal" });
          }
        });
        return;
      }

      // --- GET /rules: agent behavior rules -----------------------------------
      if (req.method === "GET" && pathname === "/rules") {
        sendJson(res, 200, { rules: settings?.getRules?.() ?? [] });
        return;
      }

      // --- GET /memories: paged + filtered list (same semantics as the
      //     internal /api/dsh-mneme/list) ------------------------------------
      if (req.method === "GET" && pathname === "/memories") {
        const type = url.searchParams.get("type") ?? undefined;
        // 上界是防御：limit 直接进 SQL LIMIT（见 MAX_PAGE_LIMIT 注释）。
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), MAX_PAGE_LIMIT);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const order = url.searchParams.get("order") ?? undefined;
        const minRaw = url.searchParams.get("minImportance");
        const minImportance = minRaw !== null && minRaw !== "" && !Number.isNaN(Number(minRaw))
          ? Number(minRaw)
          : undefined;
        const source = url.searchParams.get("source") || undefined;
        // include_archived + occurred 时间窗：与 memory_list 工具同口径（工具
        // 面六件套经 8790 全量可用，#181）；缺省行为与既有调用方逐字节一致。
        const includeArchived = url.searchParams.get("include_archived") === "true";
        const occurredFrom = url.searchParams.get("occurred_from") ?? undefined;
        const occurredTo = url.searchParams.get("occurred_to") ?? undefined;
        const listFilters = { includeArchived, ...(occurredFrom ? { occurredFrom } : {}), ...(occurredTo ? { occurredTo } : {}) };
        const items = service.toApiList(service.list({ type, limit, offset, order, minImportance, source, ...listFilters }));
        // Total honors the same filters so pager math stays correct.
        sendJson(res, 200, { items, total: service.count(type, { minImportance, source, ...listFilters }) });
        return;
      }

      // --- GET/PUT/DELETE /memories/:id --------------------------------------
      const idMatch = pathname.match(/^\/memories\/([^/]+)$/);
      if (idMatch) {
        let id = idMatch[1];
        try { id = decodeURIComponent(id); } catch { /* keep raw */ }
        if (req.method === "GET") {
          const row = service.getById(id);
          if (!row) {
            sendJson(res, 404, { error: "not-found" });
            return;
          }
          sendJson(res, 200, service.toApiList([row])[0]);
          return;
        }
        if (req.method === "DELETE") {
          // store.remove deletes silently — precheck for a distinguishable 404.
          if (!service.getById(id)) {
            sendJson(res, 404, { error: "not-found" });
            return;
          }
          service.remove(id);
          sendJson(res, 200, { ok: true });
          return;
        }
        // --- PUT: field patch（memory_update 工具的外部通道，#181）。字段校验
        // 与内部 /api/dsh-mneme/update 同风格：字段出现就必须合法，宁 400 不静默
        // 纠正；content 改写按 human_override 入档；scope 修正归一化在 service
        // 层做（null=放宽到全局，字符串=收窄/改标），审计 actor 记 "tool"。
        // 整个异步回调套 try/catch：service 抛错不能变成未处理拒绝（Node 默认
        // 策略下会终止宿主进程）或悬着不回的请求（外层同步 try 捕不到这里）。
        if (req.method === "PUT") {
          void readBody(req, res).then(async (text) => {
            if (text === null) return;
            try {
              await handlePutBody(res, service, logger, id, text);
            } catch (error) {
              logger?.warn?.(`[dsh-mneme] standalone API update failed: ${String(error)}`);
              sendJson(res, 500, { error: "internal" });
            }
          });
          return;
        }
        sendJson(res, 404, { error: "not-found" });
        return;
      }

      // --- POST /memories: save with title-dedupe (safer than raw save) ------
      if (req.method === "POST" && pathname === "/memories") {
        void readBody(req, res).then((text) => {
          if (text === null) return;
          let body;
          try {
            body = JSON.parse(text || "{}");
          } catch {
            sendJson(res, 400, { error: "invalid-json" });
            return;
          }
          if (body === null || typeof body !== "object" || Array.isArray(body)) {
            sendJson(res, 400, { error: "invalid-body" });
            return;
          }
          // Pre-validate what store.save would throw on, so clients get a
          // clean 400 instead of a leaked SQLite error.
          if (!TYPES.has(body.type)) {
            sendJson(res, 400, { error: "invalid-type" });
            return;
          }
          if (body.type === "document") {
            // #230 写入权分离：document 行铸造口唯一（registerDocument）。
            // 这里给干净 400，不让它落进 saveWithDedupe 的守卫变 500。
            sendJson(res, 400, { error: "document-requires-register" });
            return;
          }
          if (typeof body.title !== "string" || !body.title.trim()) {
            sendJson(res, 400, { error: "missing-title" });
            return;
          }
          if (typeof body.content !== "string") {
            sendJson(res, 400, { error: "missing-content" });
            return;
          }
          if (body.tags !== undefined && !Array.isArray(body.tags)) {
            sendJson(res, 400, { error: "tags-must-be-an-array" });
            return;
          }
          // memory_save 工具的其余可选字段（#181）：sensitivity / occurred_at /
          // 显式 scope。scope 仅收显式声明（standalone API 无会话上下文，自动
          // 标注无从解析，语义与工具的显式参数一致）；形状不对宁 400 不静默丢。
          for (const key of ["sensitivity", "occurred_at", "agent_scope", "workspace_scope"]) {
            if (body[key] !== undefined && (typeof body[key] !== "string" || !body[key].trim())) {
              sendJson(res, 400, { error: `invalid-${key.replace(/_/g, "-")}` });
              return;
            }
          }
          try {
            const result = service.saveWithDedupe({
              type: body.type,
              title: body.title,
              content: body.content,
              importance: body.importance,
              tags: body.tags,
              source: body.source,
              ...(body.sensitivity !== undefined ? { sensitivity: body.sensitivity } : {}),
              ...(body.occurred_at !== undefined ? { occurred_at: body.occurred_at } : {}),
              ...(body.agent_scope !== undefined ? { agent_scope: body.agent_scope, agent_scope_source: "explicit" } : {}),
              ...(body.workspace_scope !== undefined ? { workspace_scope: body.workspace_scope, workspace_scope_source: "explicit" } : {})
            });
            const { action } = result;
            // #254 写入准入：这条 HTTP 路径今天不带会话身份，evaluate 在无 sessionKey
            // 时直接早退，所以拦不到；仍然显式分支——将来真接上会话身份时，落到
            // `toApiList([null])` 上会变成 500，把「被拒」伪装成「服务器出错」，而
            // 这两件事对调用方的处置完全不同（改内容 vs 重试）。
            if (action === "denied") {
              sendJson(res, 422, { error: "write-rejected", reason: result.reason });
              return;
            }
            const { memory } = result;
            // action 随行透出（created/merged）：memory_save 工具语义对齐所需，
            // 附加键对既有消费方（CLI add 等）向后兼容。
            sendJson(res, action === "created" ? 201 : 200, { ...service.toApiList([memory])[0], action });
          } catch (error) {
            logger?.warn?.(`[dsh-mneme] standalone API save failed: ${String(error)}`);
            sendJson(res, 500, { error: "internal" });
          }
        });
        return;
      }

      // --- POST /maintenance/reclaim: 无损回收（#275 第一批，手动入口）-------
      // 默认 dry-run：只有显式 confirm:true 才真改数据。这两步都是不可逆的内容丢弃
      // （历史 run 的输入快照置空、归档行向量置空），所以不给「带 body 就执行」这种
      // 省事路径——确认必须建立在看得见的数字上。
      //
      // 口径（错误码字符串、默认值、报告形状）不在这里写：与宿主内的面板路由
      // /api/dsh-mneme/maintenance/reclaim 共用 src/reclaim-http.js，两张皮只有鉴权
      // 与路径不同。这条曾经是整段复制的，于是面板侧修好之后这边还停在旧形态（#411）。
      if (req.method === "POST" && pathname === "/maintenance/reclaim") {
        void readBody(req, res).then((text) => {
          if (text === null) return;
          const parsed = parseReclaimJson(text);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          // 顺序敏感：端点整个没接线时报「窗口不合法」是误导，503 必须赢过字段校验。
          if (!maintenance) {
            sendJson(res, 503, { error: RECLAIM_UNAVAILABLE });
            return;
          }
          const fields = readReclaimFields(parsed.body);
          if (!fields.ok) {
            sendJson(res, 400, { error: fields.error });
            return;
          }
          const { status, body } = reclaimReply({
            maintenance,
            dryRun: fields.dryRun,
            olderThanDays: fields.olderThanDays,
            vacuum: fields.vacuum,
            confirm: fields.confirm,
            warn: (msg) => logger?.warn?.(msg)
          });
          sendJson(res, status, body);
        });
        return;
      }

      // --- POST /share: 分享包（spec §4）--------------------------------------
      // 判据一条都不在这里：哪些行进包、超没超限、抛错回什么码，全在 share-http.js
      // 那份共用实现里（#411 的口径——两张皮只许差在鉴权与路径）。本侧独有的只有
      // 鉴权（Bearer，除 GET /health 外没有例外）与「不出 Content-Disposition」：
      // 下面的 sendJson 连 headers 参数都没有，CLI 拿 JSON 自己落盘。
      //
      // GET 回 405 而不是掉到末尾的 404，与面板那侧一致。这**故意**与上面的
      // /maintenance/reclaim（GET → 404）不同：状态码差一次就是第三处差别，而两条
      // 路由的「两张皮」约束比这份文件里邻居的写法更硬。
      //
      // .catch 不是装饰：shareReply 现在自己兜得住，但这条链上 readBody 之前之后的
      // 任何一处抛错都没人接——本文件那个同步 try/catch 在 .then 的回调里已经退栈，
      // 漏出去就是未处理拒绝、客户端一个字节都没收到（#410）。
      if (pathname === "/share") {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method-not-allowed" });
          return;
        }
        void readBody(req, res).then((text) => {
          if (text === null) return; // readBody 已经答过 413，再写一次就是双写响应
          const parsed = parseShareBody(text);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const out = shareReply({
            service,
            packageVersion: PACKAGE_VERSION,
            homeDir: homedir(),
            options: parsed.options,
            warn: (msg) => logger?.warn?.(msg)
          });
          sendJson(res, out.status, out.body);
        }).catch(() => sendJson(res, 500, { error: "internal" }));
        return;
      }

      // --- POST /receive + POST /receive/undo: 分享包入库与整包退出（车道 C）-----
      // 判据一条都不在这里：包体合格不合格住在 share.js 的闸门（由 service 的
      // importSharePack 调），错误码 → 状态的映射与 dry_run 那一格住在 src/share-http.js
      // 这份共用实现里——#411 的口径是两张皮只许差在鉴权与路径（面板那半见
      // /api/dsh-mneme/receive）。本面独有的只有两件事：鉴权是这里唯一的 Bearer 一道门
      // （没有 policy 名可用，除 GET /health 外人人都要带），以及 sendJson 连 headers
      // 参数都没有，所以不出 Content-Disposition。
      //
      // 非 POST 一律 405，与面板逐字同款：这**故意**与上面的 /maintenance/reclaim 不同
      // （那边掉到末尾 404）。状态码差一次就是第三处差别，而每条 receive 都还有个面板
      // 双胞胎，一致性比照抄本文件的邻居更硬。
      //
      // void + .catch，不留外层 try 兜底：本文件那个 try 在 .then 的回调里早已退栈，
      // 回调里抛出去就是没人接的 rejection、客户端一个字节都收不到（#410）。共用层
      // 从不抛（连 warn 自己坏都被守卫吞掉），所以这里能被走到的只剩面自己写答复那一步。
      // readBody 超限时会自己答 413 并把 text 解析成 null：那句 return 是必需的，少了
      // 它就是在已发出的响应上再写一次。
      if (pathname === "/receive" || pathname === "/receive/undo") {
        const isUndo = pathname === "/receive/undo";
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method-not-allowed" });
          return;
        }
        void readBody(req, res).then((text) => {
          if (text === null) return; // readBody 已经答过 413，再写一次就是双写响应
          const parsed = isUndo ? parseUndoBody(text) : parseReceiveBody(text);
          // 两个解析器都回 {ok:true,…}|{ok:false,error}，所以一处判断就够。别把它写成
          // 「有 error 就 400」：那会把本面缺路径时该落的 404 与真正的坏 body 混成一种
          // 答复，排查时看不出是哪一层没接上。
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const out = isUndo
            ? undoReply({ service, packId: parsed.packId, dryRun: parsed.dryRun, warn: (msg) => logger?.warn?.(msg) })
            : receiveReply({ service, pack: parsed.pack, dryRun: parsed.dryRun, warn: (msg) => logger?.warn?.(msg) });
          sendJson(res, out.status, out.body);
        }).catch(() => sendJson(res, 500, { error: "internal" }));
        return;
      }

      // --- POST /bootstrap: cold-start memories from repo files (#220) -------
      // 显式收 dir（插件没有工作区根目录概念，不猜路径）；确定性解析零 LLM；
      // 幂等骑 saveWithDedupe 的 (type, title, scope) 去重 + _overwrite 刷新。
      if (req.method === "POST" && pathname === "/bootstrap") {
        void readBody(req, res).then((text) => {
          if (text === null) return;
          let body;
          try {
            body = JSON.parse(text || "{}");
          } catch {
            sendJson(res, 400, { error: "invalid-json" });
            return;
          }
          if (body === null || typeof body !== "object" || Array.isArray(body)) {
            sendJson(res, 400, { error: "invalid-body" });
            return;
          }
          if (typeof body.dir !== "string" || !body.dir.trim()) {
            sendJson(res, 400, { error: "missing-dir" });
            return;
          }
          bootstrapFromDirectory({ service, dir: body.dir, logger })
            .then((summary) => sendJson(res, 200, summary))
            .catch((error) => {
              if (error?.code) {
                sendJson(res, 400, { error: error.code });
                return;
              }
              logger?.warn?.(`[dsh-mneme] standalone API bootstrap failed: ${String(error)}`);
              sendJson(res, 500, { error: "internal" });
            });
        });
        return;
      }

      // --- GET /search: unified recall pipeline (keyword + vector + BM25) ----
      if (req.method === "GET" && pathname === "/search") {
        const q = url.searchParams.get("q") ?? "";
        // 上界是防御：topK 直接进召回（见 MAX_SEARCH_TOP_K 注释）。
        const limit = Math.min(Number(url.searchParams.get("topK") ?? url.searchParams.get("limit") ?? 20), MAX_SEARCH_TOP_K);
        const mode = url.searchParams.get("mode") ?? "auto";
        const rerank = url.searchParams.get("rerank") !== "false";
        const occurredFrom = url.searchParams.get("occurred_from") ?? null;
        const occurredTo = url.searchParams.get("occurred_to") ?? null;
        // scope 透传（issue #370）：searchMemories 本就收 scope，此前 8790 没有
        // 入口——第三方（daemon 桥接侧）声明身份后，A2 软加权与 strictScope 硬
        // 过滤才在检索面同样成立；与 /context 同口径（scopeFromSearchParams）。
        const scope = scopeFromSearchParams(url);
        const query = q.trim();
        if (!query) {
          sendJson(res, 200, { items: [], mode: "keyword" });
          return;
        }
        // Any vector/rerank failure degrades to keyword inside searchMemories.
        void Promise.resolve(
          service.searchMemories(query, {
            mode,
            topK: limit,
            useRerank: rerank,
            ...(scope ? { scope } : {}),
            ...(occurredFrom !== null || occurredTo !== null ? { occurredFrom, occurredTo } : {})
          })
        ).then((rows) => {
          const used = rows.some((m) => m.vector === true) ? "vector" : "keyword";
          sendJson(res, 200, { items: service.toApiList(rows), mode: used });
        }).catch(() => {
          sendJson(res, 200, { items: service.toApiList(service.search(query, { limit })), mode: "keyword" });
        });
        return;
      }

      // --- GET /context: 注入候选一站式聚合（issue #370，#363 承诺）------------
      // 给定话题返回「宿主此刻会注入什么」的数据等价物：injectCandidates 全语义
      // （优先级分层 / 编码门控 / heat / scope 软加权 / hybrid 语义路 / pin 前置，
      // service.js:1494）+ 画像 + 规则。结构化条目、不含渲染文本——语言 / 时间
      // 前缀 / 热记忆是宿主会话概念，调用方（Mneme Bridge 等网页端桥接）自行渲染。
      // 与宿主注入的两点差异都是 HTTP 面的有意为之：① 首次调用即走语义路（宿主
      // 渲染必须同步，查询向量只能异步 prefetch 给下一轮，inject.js Bug4；这里
      // 没有该约束）；② 不做跨轮轮换（daemon 无会话状态，调用方自管）。
      // recall_runs 记账随 injectCandidates 内建（#217：注入是曝光型访问事件，
      // mode='inject' 与检索命中同表分账）——宿主注入同样记，/context 自动同口径。
      if (req.method === "GET" && pathname === "/context") {
        const q = (url.searchParams.get("q") ?? "").trim();
        const maxItemsRaw = Number(url.searchParams.get("topK") ?? url.searchParams.get("limit") ?? 5);
        const maxItems = Number.isInteger(maxItemsRaw) && maxItemsRaw > 0 ? Math.min(maxItemsRaw, MAX_SEARCH_TOP_K) : 5;
        // threshold 是 importance 阈值（injectCandidates 语义），与 /search 的
        // 相似度 threshold 同名不同义——文档已点名，勿混。
        const thresholdRaw = Number(url.searchParams.get("threshold") ?? 3);
        const threshold = Number.isFinite(thresholdRaw) ? thresholdRaw : 3;
        const scope = scopeFromSearchParams(url);
        void Promise.resolve(q && embedder ? withEmbedTimeout(embedQueryVector(embedder, q), embedTimeoutMs) : undefined)
          .catch(() => undefined)   // 查询嵌入失败降级规则档（与 searchMemories 同口径）
          .then((queryVector) => {
            const pinnedStats = {};
            const items = service.injectCandidates({ query: q, maxItems, threshold, queryVector, scope, pinnedStats });
            sendJson(res, 200, {
              profile: (settings?.getProfile?.() ?? "").trim(),
              rules: settings?.getRules?.() ?? [],
              items: service.toApiList(items),
              pinnedCount: pinnedStats.shown ?? 0
            });
          })
          .catch(() => {
            sendJson(res, 500, { error: "internal" });
          });
        return;
      }

      sendJson(res, 404, { error: "not-found" });
    } catch {
      sendJson(res, 500, { error: "internal" });
    }
  });

  // A permanent error listener keeps an EADDRINUSE / runtime socket error from
  // crashing the host process; `ready` still surfaces the first bind failure.
  server.on("error", (error) => {
    logger?.warn?.(`[dsh-mneme] standalone API error: ${String(error)}`);
  });
  const ready = new Promise((resolve, reject) => {
    // listening handled by listenWithRetry
    listenWithRetry(server, boundPort, boundHost, logger, strictPort).then(resolve, reject);
  });
  // server.listen is called inside listenWithRetry
  ready.then(() => {
    const address = server.address();
    if (address && typeof address === "object") {
      logger?.info?.(`[dsh-mneme] standalone API listening on http://${address.address}:${address.port}`);
    }
  }).catch(() => { /* already logged by the error handler above */ });

  const api = { server, port: boundPort, host: boundHost, token, ready };
  // After the OS assigns the real port (bind port 0), reflect it for callers.
  ready.then(() => {
    const address = server.address();
    if (address && typeof address === "object") api.port = address.port;
  }).catch(() => { /* bind failed: port stays as configured */ });
  return api;
}
