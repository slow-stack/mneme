// dsh-mneme/src/kb/routes.js
// 知识库第二层的 HTTP 面（契约 §3.6 的路径表）。**这张表是 C 线面板的合同**：
// 路径、方法、请求体字段、回执形状都照表写死，两边不许各自发挥。
//
// 本文件不判 cfg.kbEnabled——那是 A 线 api.js 里 kbGate 的职责（一处判定，不两处
// 分叉）。这里只吃传进来的 gate；万一没传（单测直接装路由），退化成「kb 未装配 →
// 503」这一条最小围栏，语义与 #497 先例一致：503 = 环境缺件、409 = 用户没开。
//
// kb 允许为 null（未装配），此时一律 503 而不是抛：面板要靠状态码渲染空态。
function defaultGate(kb, sendJson, res) {
  if (!kb) {
    sendJson(res, 503, { error: "unavailable", reason: "kb-unavailable" });
    return false;
  }
  return true;
}

function queryOf(req) {
  return new URL(req.url, "http://localhost").searchParams;
}

/**
 * @param {(route: object) => void} register createRouteRegistrar 的注册函数
 * @param {object} deps
 * @param {object|null} deps.kb      createKb() 的返回值，未装配时 null
 * @param {object} deps.cfg
 * @param {(res, status, body) => void} deps.sendJson
 * @param {(req, res) => Promise<string|null>} deps.readBody  超限时自己回过 413 并返回 null
 * @param {(text: string) => object} deps.parseBody           坏 JSON 回 {}
 * @param {(req, res) => boolean} [deps.gate]                 关 409 / 缺件 503，false = 已回执
 */
export function registerKbRoutes(register, { kb = null, cfg = {}, sendJson, readBody, parseBody, gate } = {}) {
  if (typeof register !== "function") throw new TypeError("registerKbRoutes: register is required");
  if (typeof sendJson !== "function") throw new TypeError("registerKbRoutes: sendJson is required");

  const allowed = (req, res) => (typeof gate === "function" ? gate(req, res) : defaultGate(kb, sendJson, res));

  // 读 JSON body 的唯一入口（三条写路由共用）。返回 null = readBody 已经回过 413，
  // 调用点**必须**直接 return：否则会拿着空对象继续往 store 写，413 之后又落一次库。
  // 坏 JSON 退化成 {}，由各 handler 的必填校验收成 400。
  const readJson = async (req, res) => {
    const text = await readBody(req, res);
    if (text === null) return null;
    if (typeof parseBody === "function") return parseBody(text);
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  };

  // --- 集合 ---------------------------------------------------------------
  // 一条路径上读（GET）与写（POST/DELETE）混在一起，只能声明一个 policy，取更严的
  // `token-write`——与 /profile 同款处理（src/api.js:495-514）。registrar 对同一
  // kind+path 重复登记直接抛错，所以不能拆成两条。
  //
  // 失败闭环：kb.collections 里出现过的文档之外一切都不动。不存在「删了一半」——
  // deleteCollection 是整个事务（store.deleteKbCollection 里有注释）。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/kb/collections",
    policy: "token-write",
    handler(req, res) {
      if (!allowed(req, res)) return;
      if (req.method === "GET") {
        sendJson(res, 200, { collections: kb.listCollections() });
        return;
      }
      if (req.method === "DELETE") {
        // key 走 query：集合 key 允许含斜杠，塞进路径会把 router 的 exact 匹配搅坏。
        const key = String(queryOf(req).get("key") ?? "").trim();
        if (key === "") {
          sendJson(res, 400, { error: "key-required" });
          return;
        }
        sendJson(res, 200, { ok: true, deleted: kb.deleteCollection(key) === true });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method-not-allowed" });
        return;
      }
      // 必须 return：handler 是 async 时吞掉 Promise，调用点（测试里的 await、
      // 宿主里的 invoke）就看不到回执已经发出——与 choro/search 踩过的坑同源。
      return readJson(req, res).then((body) => {
        if (body === null) return;
        const key = String(body?.key ?? "").trim();
        if (key === "") {
          sendJson(res, 400, { error: "key-required" });
          return;
        }
        const saved = kb.upsertCollection({
          key,
          title: body?.title,
          description: body?.description
        });
        sendJson(res, 200, { ok: true, key: saved.key });
      });
    }
  });

  // --- 文档列表 -----------------------------------------------------------
  register({
    kind: "exact",
    path: "/api/dsh-mneme/kb/docs",
    policy: "token",
    handler(req, res) {
      if (!allowed(req, res)) return;
      const collection = String(queryOf(req).get("collection") ?? "").trim();
      if (collection === "") {
        sendJson(res, 400, { error: "collection-required" });
        return;
      }
      sendJson(res, 200, { docs: kb.listDocs({ collection }) });
    }
  });

  // --- 读整篇 -------------------------------------------------------------
  register({
    kind: "exact",
    path: "/api/dsh-mneme/kb/doc",
    policy: "token",
    handler(req, res) {
      if (!allowed(req, res)) return;
      const url = queryOf(req);
      const collection = String(url.get("collection") ?? "").trim();
      const relKey = String(url.get("relKey") ?? "");
      if (collection === "" || relKey === "") {
        sendJson(res, 400, { error: "collection-and-relKey-required" });
        return;
      }
      const doc = kb.readDoc({ collection, relKey });
      if (!doc) {
        sendJson(res, 404, { error: "doc-not-found", collection, relKey });
        return;
      }
      sendJson(res, 200, {
        title: doc.title,
        content: doc.content,
        kind: doc.kind,
        relKey: doc.relKey,
        status: doc.status
      });
    }
  });

  // --- 入库 ---------------------------------------------------------------
  // 入库是异步的（url 要 fetch），handler 必须把整条 Promise 链 return 出去——
  // 不 return 会在响应发出之前就返回，body 恒空（choro/search 那条踩过同一个坑）。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/kb/ingest",
    policy: "token-write",
    handler(req, res) {
      if (!allowed(req, res)) return;
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method-not-allowed" });
        return;
      }
      return readJson(req, res).then(async (body) => {
        if (body === null) return;
        const collection = String(body?.collection ?? "").trim();
        const kind = String(body?.kind ?? "").trim();
        const source = String(body?.source ?? "").trim();
        if (collection === "" || kind === "" || source === "") {
          sendJson(res, 400, { error: "collection-kind-source-required" });
          return;
        }
        const r = await kb.ingest({ collection, kind, source, title: body?.title });
        if (r.error === "bad-kind") {
          sendJson(res, 400, { ok: false, error: r.error });
          return;
        }
        if (r.error === "collection-not-found") {
          // 拼错的集合 key 是调用方的错，不是文档的错——不能悄悄建集合（见 index.js）。
          sendJson(res, 404, { ok: false, error: r.error, collection });
          return;
        }
        // 来源级失败（找不到文件 / 太大 / http-404）回 200 + ok:false：kb_docs 里已经
        // 落了 status='error' 的行，面板要能显示「这份为什么没进来」，而 HTTP 4xx
        // 会让面板把它当成「请求本身错了」丢掉那条记录。
        sendJson(res, 200, {
          ok: !r.error,
          docId: r.docId,
          chunks: r.chunks,
          skipped: r.skipped,
          ...(r.error ? { error: r.error } : {})
        });
      });
    }
  });

  // --- 检索 ---------------------------------------------------------------
  register({
    kind: "exact",
    path: "/api/dsh-mneme/kb/search",
    policy: "token-write",
    handler(req, res) {
      if (!allowed(req, res)) return;
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method-not-allowed" });
        return;
      }
      return readJson(req, res).then((body) => {
        if (body === null) return;
        const query = String(body?.query ?? "").trim();
        if (query === "") {
          sendJson(res, 400, { error: "query-required" });
          return;
        }
        const r = kb.search({
          query,
          collection: body?.collection ?? null,
          limit: body?.limit
        });
        sendJson(res, 200, { hits: r.hits, unreadable: r.unreadable ?? [] });
      });
    }
  });
}