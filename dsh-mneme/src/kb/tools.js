// dsh-mneme/src/kb/tools.js
// 知识库的模型侧出口：三个**只读**工具（kb_list_collections / kb_search /
// kb_read_doc）。写操作一个都不给模型——建集合、入库都是用户在面板上按的按钮
// （与 chorography「生成只走 CLI」同一条红线：知识库收的是用户自己的资料，模型
// 不该有权决定往里塞什么）。
//
// 返回 defineTool() 兼容的描述对象数组，由 src/tools.js 在 kbEnabled 时展开进
// 它自己的数组——本文件不 import defineTool，装配顺序与两个开关（kbEnabled 与
// kb 是否装配到位）由调用方掌握，一处判定不两处分叉。
const TEXT_OUTPUT = (text) => [{ type: "text", text }];

/**
 * @param {object} deps
 * @param {object|null} deps.kb  createKb() 的返回值；null = 未装配，仍返回数组但
 *                               execute 会明确抛错（调用方本不该在此情形注册它们，
 *                               真注册了也要给人话而不是 undefined 崩）
 * @param {object} [deps.cfg]
 */
export function kbToolDefinitions({ kb = null, cfg = {} } = {}) {
  const limitCap = Number(cfg?.kbSearchHitCap) > 0 ? Number(cfg.kbSearchHitCap) : 20;

  const requireKb = () => {
    if (!kb) throw new Error("Knowledge base is not available in this session (kb-unavailable).");
    return kb;
  };

  return [
    {
      name: "kb_list_collections",
      description: "List knowledge-base collections with document and chunk counts. The knowledge base holds the user's own reference material (local files, web pages, chorography pages) and is separate from memory. Use kb_search to search inside them. Read-only.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            collections: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  key: { type: "string", required: true },
                  title: { type: "string", required: true },
                  description: { type: "string" },
                  docs: { type: "integer", required: true },
                  chunks: { type: "integer", required: true },
                  updatedAt: { type: "string" }
                }
              }
            }
          }
        },
        render: (_args, value) => {
          const list = value.collections ?? [];
          if (list.length === 0) {
            return TEXT_OUTPUT("0 collections. The user can add one from the mneme panel (Knowledge base → new collection).");
          }
          const lines = list.map((c) => `- ${c.key} — ${c.title}（${c.docs} docs, ${c.chunks} chunks）${c.description ? ` · ${c.description}` : ""}`);
          return TEXT_OUTPUT(`${list.length} collections:\n${lines.join("\n")}`);
        }
      },
      async execute() {
        return { collections: requireKb().listCollections() };
      }
    },

    {
      name: "kb_search",
      description: "Keyword (BM25) search over the knowledge base. Returns matching chunks with collection key, document relative key, section heading, line number and excerpt. Read-only — the knowledge base is not memory and nothing here is written back to it.",
      parameters: {
        query: { type: "string", description: "Search text (CJK and ASCII both work)" },
        collection: { type: "string", description: "Restrict to one collection key; omit to search all collections" },
        limit: { type: "integer", description: `Max hits (default 20, cap ${limitCap})` }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            hits: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
            unreadable: { type: "array", items: { type: "string" }, description: "Documents that could not be read during the search" }
          }
        },
        render: (_args, value) => {
          const hits = value.hits ?? [];
          if (hits.length === 0) return TEXT_OUTPUT("0 hits.");
          const lines = hits.map(
            (h) => `${h.collection}/${h.relKey} · ${h.heading || "(no section)"} · L${h.line}: ${h.excerpt}`
          );
          return TEXT_OUTPUT(`${hits.length} hits:\n${lines.join("\n")}`);
        }
      },
      async execute(args) {
        const instance = requireKb();
        const query = String(args?.query ?? "").trim();
        if (query === "") throw new Error("kb_search: query is required.");
        const limit = Math.max(1, Math.min(limitCap, Number(args?.limit) || 20));
        const r = instance.search({ query, collection: args?.collection ?? null, limit });
        return { hits: r.hits, unreadable: r.unreadable ?? [] };
      }
    },

    {
      name: "kb_read_doc",
      description: "Read one knowledge-base document in full by collection key and relative key (as returned by kb_search). Read-only.",
      parameters: {
        collection: { type: "string", description: "Collection key" },
        relKey: { type: "string", description: "Document relative key, e.g. the absolute source path shown in kb_search hits" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            collection: { type: "string", required: true },
            relKey: { type: "string", required: true },
            title: { type: "string", required: true },
            content: { type: "string", required: true }
          }
        },
        render: (_args, value) => TEXT_OUTPUT(value.content)
      },
      async execute(args) {
        const instance = requireKb();
        const collection = String(args?.collection ?? "").trim();
        const relKey = String(args?.relKey ?? "");
        if (collection === "" || relKey === "") {
          throw new Error("kb_read_doc: collection and relKey are both required.");
        }
        const doc = instance.readDoc({ collection, relKey });
        if (!doc) {
          // 明确说「查不到」而不是回空串：空串会被模型当成「文件是空的」继续瞎编。
          throw new Error(
            `Knowledge-base document ${JSON.stringify(relKey)} was not found in collection ${JSON.stringify(collection)}. Use kb_list_collections / kb_search to find the right key.`
          );
        }
        if (doc.status === "error") {
          throw new Error(
            `Document ${JSON.stringify(relKey)} was not indexed successfully (last error: ${doc.error ?? "unknown"}). The user can re-ingest it from the mneme panel.`
          );
        }
        return { collection, relKey, title: doc.title, content: doc.content };
      }
    }
  ];
}
