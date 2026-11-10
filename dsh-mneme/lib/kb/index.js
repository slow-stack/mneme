// dsh-mneme/src/kb/index.js
// 知识库第二层（§3.3/§3.4）：集合 + 文档入库（本地文件 / 网页 / 仓库地志页）+
// 分块 + BM25 检索。真源在 kb_* 三张表里（不像 chorography 那样以磁盘 MD 为真源
// ——知识库收的就是「外来原文的副本」，用户随时可能把原文件挪走/删掉，检索面不能
// 跟着消失），所以读侧零 IO。
//
// 物理隔离：本模块只碰 kb_* 三张表，绝不写 memories，也不进巩固/质量过滤任何池子
// （与 wiki 行同一条纪律，也是 §3.3 的红线）。
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import { createBM25Index } from "../search/bm25.js";

// 单文档上限：知识库是检索面不是文件仓，几十兆的语料进来只会把 BM25 全量重算
// 变成卡顿源。超限给明确 error 回执（面板要能显示「这份为什么不进来」），不静默截断。
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
// 单块目标长度：BM25 的 length normalization 对超长块惩罚很重，而太碎的块丢上下文。
// 1200 字符约等于中文 600 字，是「一段完整论述」的常见尺度。
const CHUNK_TARGET_CHARS = 1200;

const KINDS = new Set(["file", "url", "choro_page"]);

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 按行切块，**严格连续、不跳行**——这是 readDoc 能逐字节还原原文、以及检索命中
 * 能给出准确行号（起始行 = 1 + 前面所有块的行数）的前提。破坏它这两件事同时坏。
 * `## ` 标题开启新节并重置 target（一节尽量整块进来，除非它自己就超长）；
 * 超长单行单独成块不拆（行号与原文还原都靠这个假设）。
 */
function chunkContent(content) {
  const lines = String(content ?? "").replace(/\r\n/g, "\n").split("\n");
  const chunks = [];
  let heading = "";
  let buf = [];
  let bufChars = 0;

  const flush = () => {
    if (!buf.length) return;
    // 一个空行都不剥：块间用 \n 直接拼接就是原文（readDoc 靠这条），而且空白行
    // 不产生 token，对 BM25 的 len 分母零成本——剥它反而是纯损。
    chunks.push({ heading, text: buf.join("\n") });
    buf = [];
    bufChars = 0;
  };

  for (const line of lines) {
    const isH2 = /^##\s+/.test(line);
    const startsSection = isH2 && buf.length > 0;
    if (startsSection) flush();
    if (isH2) heading = line.replace(/^##\s+/, "").trim();
    buf.push(line);
    bufChars += line.length + 1;
    if (bufChars >= CHUNK_TARGET_CHARS) flush();
  }
  flush();
  return chunks;
}

function makeExcerpt(text, max = 200) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * @param {object} deps
 * @param {object} deps.store  createStore() 的返回值（用到 kb* 那组方法）
 * @param {object} [deps.embedder]  v1 不接向量（BM25 打底）；保留位，配了也不影响
 *                                 检索结果，接向量是下一档的事
 * @param {object} [deps.cfg]
 */
export function createKb({ store, embedder = null, cfg = {} } = {}) {
  if (!store || !store.db) throw new TypeError("createKb: store is required");
  const maxBytes = Number(cfg?.kbMaxBytes) > 0 ? Number(cfg.kbMaxBytes) : DEFAULT_MAX_BYTES;
  // 检索索引按集合懒物化：kb 是 opt-in 子系统，一次 ingest 之后反复检索的收益远大于
  // 「每次重建一遍 corpus」。写路径（ingest / delete / upsert）令其失效。
  const indexCache = new Map();

  function resolveCollection(key) {
    return store.kbCollectionByKey(String(key ?? "").trim());
  }

  function invalidate(collectionKey) {
    if (collectionKey == null) indexCache.clear();
    else indexCache.delete(String(collectionKey));
  }

  function listCollections() {
    return store.listKbCollections().map((r) => ({
      key: r.key,
      title: r.title,
      description: r.description ?? "",
      docs: Number(r.doc_count ?? 0),
      chunks: Number(r.chunk_count ?? 0),
      updatedAt: r.updated_at,
    }));
  }

  function upsertCollection({ key, title, description = "" } = {}) {
    const k = String(key ?? "").trim();
    if (k === "") throw new TypeError("upsertCollection: key is required");
    const row = store.upsertKbCollection({
      key: k,
      title: String(title ?? "").trim() || k,
      description: String(description ?? ""),
      at: new Date().toISOString(),
    });
    invalidate(k);
    return { key: row.key, title: row.title, description: row.description ?? "" };
  }

  function deleteCollection(key) {
    const k = String(key ?? "").trim();
    if (k === "") return false;
    const gone = store.deleteKbCollection(k);
    invalidate(k);
    return gone;
  }

  function listDocs({ collection } = {}) {
    const col = resolveCollection(collection);
    if (!col) return [];
    return store.listKbDocs(col.id).map((d) => ({
      relKey: d.rel_key,
      kind: d.kind,
      title: d.title,
      bytes: Number(d.bytes ?? 0),
      indexedAt: d.indexed_at,
      status: d.status,
      error: d.error ?? null,
    }));
  }

  /** 读来源正文。三种 kind 各自的最短路径，出错一律抛，由 ingest 收成 error 回执。 */
  async function readSource({ kind, source }) {
    const src = String(source ?? "").trim();
    if (src === "") throw new Error("empty-source");
    if (kind === "url") {
      if (typeof fetch !== "function") throw new Error("fetch-unavailable");
      const res = await fetch(src, { redirect: "follow" });
      if (!res.ok) throw new Error(`http-${res.status}`);
      const raw = await res.text();
      return { text: raw, relKey: src, title: src };
    }
    // file / choro_page：choro_page 的 source 就是该地志页 MD 的绝对路径（面板从
    // 地志页「导入」时拿到的正是它）。kind 只作分类与展示，读取路径与普通文件一致
    // ——不为它去跨域读 choro_* 表，那会把两条线的写作用域搅在一起。
    let size = 0;
    try {
      size = statSync(src).size;
    } catch (cause) {
      throw new Error(cause.code === "ENOENT" ? "file-not-found" : "file-unreadable");
    }
    if (size > maxBytes) throw new Error("too-large");
    const text = readFileSync(src, "utf8");
    return { text, relKey: src, title: basename(src) };
  }

  /**
   * 入库。同 rel_key + 同 sha256 是 no-op（回执 skipped=true，chunks 是库里现有的
   * 块数不是重新切出来的块数）——这条是整个幂等契约的落点，编辑器保存一次不能
   * 触发全量重切块。
   */
  async function ingest({ collection, kind, source, title } = {}) {
    const colKey = String(collection ?? "").trim();
    const k = String(kind ?? "").trim();
    const now = new Date().toISOString();
    if (!KINDS.has(k)) {
      return { docId: null, chunks: 0, skipped: false, error: "bad-kind" };
    }
    const col = resolveCollection(colKey);
    if (!col) {
      // 不静默建集合：拼错 key 的入库会把资料塞进一个凭空出现的集合里，用户永远
      // 找不到。面板的流程是先建集合再入库，工具侧也是先 list 再 ingest。
      return { docId: null, chunks: 0, skipped: false, error: "collection-not-found" };
    }

    let body;
    try {
      body = await readSource({ kind: k, source });
    } catch (cause) {
      const message = String(cause?.message ?? cause);
      const docId = store.markKbDocError({
        collectionId: col.id,
        relKey: String(source ?? "").trim() || "(empty)",
        kind: k,
        sourcePath: String(source ?? "").trim() || null,
        title: String(title ?? "").trim() || String(source ?? ""),
        error: message,
        at: now,
      });
      invalidate(colKey);
      return { docId, chunks: 0, skipped: false, error: message };
    }

    const chunks = chunkContent(body.text);
    const result = store.replaceKbDoc({
      collectionId: col.id,
      relKey: body.relKey,
      kind: k,
      sourcePath: body.relKey,
      title: String(title ?? "").trim() || body.title,
      bytes: Buffer.byteLength(body.text, "utf8"),
      sha256: sha256(body.text),
      at: now,
      chunks: chunks.map((c, i) => ({ ordinal: i, heading: c.heading, text: c.text })),
    });
    invalidate(colKey);
    return { docId: result.docId, chunks: result.chunks, skipped: result.skipped };
  }

  /** 集合级语料的 BM25 索引（懒物化，写路径失效）。 */
  function indexFor(col) {
    const cacheKey = col ? String(col.key) : "*";
    const cached = indexCache.get(cacheKey);
    if (cached) return cached;
    const rows = store.kbChunksForSearch(col ? col.id : null);
    const docs = rows.map((r) => ({
      id: r.id,
      // 标题与本节标题都进索引文本：用户搜「安装」时，命中「## 安装」比命中正文里
      // 偶然出现的「安装」更该排前面，而 BM25 只看词频，标题必须显式入语料。
      title: `${r.title} ${r.heading ?? ""}`.trim(),
      content: r.text ?? "",
      row: r,
    }));
    const built = { index: createBM25Index(docs), byId: new Map(docs.map((d) => [d.id, d])) };
    indexCache.set(cacheKey, built);
    return built;
  }

  function search({ query, collection = null, limit = 20 } = {}) {
    const q = String(query ?? "").trim();
    if (q === "") return { hits: [], unreadable: [] };
    let col = null;
    if (collection != null && String(collection).trim() !== "") {
      col = resolveCollection(collection);
      if (!col) return { hits: [], unreadable: [] };
    }
    const cap = Math.max(1, Math.min(100, Number(limit) || 20));
    const { index, byId } = indexFor(col);
    const ranked = index.search(q, { limit: cap });
    // 行号：块是**严格连续按行切**的，所以某块起始行 = 1 + 它前面所有块的行数。
    // 这里按需回算（只算命中的那一篇），避免给 kb_chunks 加一列只为省这点算术。
    const lineCache = new Map();
    const lineOf = (row) => {
      if (!lineCache.has(row.doc_id)) {
        const all = store.kbChunksByDoc(row.doc_id);
        let cursor = 1;
        const map = new Map();
        for (const c of all) {
          map.set(c.id, cursor);
          // 块间用 \n 拼接，所以上一块的行数就是游标增量（不 +1）。
          cursor += String(c.text ?? "").split("\n").length;
        }
        lineCache.set(row.doc_id, map);
      }
      return lineCache.get(row.doc_id).get(row.id) ?? 1;
    };
    const hits = ranked.map((hit) => {
      const row = byId.get(hit.id).row;
      return {
        collection: row.collection_key,
        relKey: row.rel_key,
        title: row.title,
        heading: row.heading ?? "",
        line: lineOf(row),
        excerpt: makeExcerpt(row.text),
        score: hit.score,
      };
    });
    return { hits, unreadable: [] };
  }

  /** 读整篇：块按行连续切，用 \n 拼回即是原文（见 chunkContent 的注释）。 */
  function readDoc({ collection, relKey } = {}) {
    const col = resolveCollection(collection);
    if (!col) return null;
    const doc = store.kbDocByRelKey(col.id, String(relKey ?? ""));
    if (!doc) return null;
    const chunks = store.kbChunksByDoc(doc.id);
    return {
      title: doc.title,
      content: chunks.map((c) => c.text).join("\n"),
      kind: doc.kind,
      relKey: doc.rel_key,
      status: doc.status,
      error: doc.error ?? null,
    };
  }

  function dispose() {
    indexCache.clear();
    try {
      embedder?.dispose?.();
    } catch { /* 释放期的失败不该盖住调用方的正常退出 */ }
  }

  return {
    listCollections,
    upsertCollection,
    deleteCollection,
    listDocs,
    ingest,
    search,
    readDoc,
    dispose,
  };
}
