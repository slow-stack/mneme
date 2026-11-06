// dsh-mneme/src/wiki/queries.js
// chorography 的读侧（M1）：仓库列表 / 模块图 / 页面正文 / 关键词检索。
// 收尾档追加：向量检索（P37–P39，惰性物化 + cosine）。
// 检索读侧零写路径的例外只有一处——向量物化写 choro_vectors（P37：检索时惰性
// 补嵌，host 侧才有 embedder；那是向量账本，不是页面真源）。
//
// 真源纪律（spec §4 / P12）：页面正文永远读仓库磁盘的 MD（root_path + DB 里的
// rel_path），库里的表只是索引与状态账。slug 只从 DB 白名单解析，路径拼装零用户
// 输入——面板与工具传进来的 slug 查不到模块行就返回 null，绝不用它拼路径。
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

// 页正文去 frontmatter / CHORO 标记行后作为嵌入文本（P40：嵌页级全文）。
function pageEmbedText(content) {
  const lines = String(content ?? "").split("\n");
  let start = 0;
  if (lines[0]?.trim() === "---") {
    start = 1;
    while (start < lines.length && lines[start].trim() !== "---") start++;
    start++;
  }
  return lines
    .slice(start)
    .filter((l) => !l.startsWith("<!-- CHORO:T1:") && !l.startsWith("<!-- CHORO:HUMAN:"))
    .join("\n")
    .trim();
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function createChoroQueries({ store }) {
  const db = store.db;

  /** 已登记仓库（含模块/页面计数，面板仓库选择器与工具的 repo 解析共用）。 */
  function listRepos() {
    const rows = db.prepare(
      `SELECT r.id, r.root_path, r.name, r.plan_fingerprint, r.git_baseline, r.updated_at,
              (SELECT COUNT(*) FROM choro_modules m WHERE m.repo_id = r.id) AS module_count,
              (SELECT COUNT(*) FROM choro_pages p JOIN choro_modules m2 ON p.module_id = m2.id
                 WHERE m2.repo_id = r.id) AS page_count
         FROM choro_repos r ORDER BY r.id`
    ).all();
    return rows;
  }

  /** repo 解析：数字 id 或显示名（root_path 是本机私有路径，不作为对外键）。 */
  function resolveRepo(ref) {
    if (ref === undefined || ref === null || ref === "") {
      const rows = listRepos();
      if (rows.length === 1) return rows[0];
      if (rows.length === 0) return null;
      return { ambiguous: rows.map((r) => ({ id: r.id, name: r.name })) };
    }
    const byId = db.prepare("SELECT * FROM choro_repos WHERE id = ?").get(Number(ref));
    if (byId) return byId;
    const byName = db.prepare("SELECT * FROM choro_repos WHERE name = ?").get(String(ref));
    return byName ?? null;
  }

  /** 模块表 + 跨模块边（choro_module_map 与面板左侧树共用同一份数据）。 */
  function moduleMap(repoId) {
    const modules = db.prepare(
      `SELECT m.id, m.slug, m.title, m.parent_id, m.file_count, m.fingerprint, m.updated_at,
              p.status AS page_status, p.rel_path AS page_rel_path
         FROM choro_modules m
         LEFT JOIN choro_pages p ON p.module_id = m.id
        WHERE m.repo_id = ? ORDER BY m.slug`
    ).all(repoId);
    const edges = db.prepare(
      `SELECT from_slug, to_slug, weight FROM choro_edges WHERE repo_id = ?
        ORDER BY from_slug, to_slug`
    ).all(repoId);
    return { modules, edges };
  }

  /**
   * 读一页正文。slug 必须命中 DB 的模块行（P12：路径零用户输入）；磁盘文件被手删
   * 时返回 { error: "page-missing" }（索引还没重算，读侧如实报缺，不伪造内容）。
   */
  function readPage(repoId, slug) {
    const row = db.prepare(
      `SELECT m.slug, m.title, m.file_count, m.parent_id, p.rel_path, p.status,
              p.git_baseline, p.template_version, p.generated_at, p.human_block_count
         FROM choro_modules m JOIN choro_pages p ON p.module_id = m.id
        WHERE m.repo_id = ? AND m.slug = ?`
    ).get(repoId, String(slug));
    if (!row) return null;
    const repo = db.prepare("SELECT root_path, name FROM choro_repos WHERE id = ?").get(repoId);
    const abs = join(repo.root_path, row.rel_path);
    if (!existsSync(abs)) return { error: "page-missing", slug: row.slug, relPath: row.rel_path };
    return {
      slug: row.slug,
      title: row.title,
      fileCount: row.file_count,
      status: row.status,
      gitBaseline: row.git_baseline,
      templateVersion: row.template_version,
      generatedAt: row.generated_at,
      humanBlockCount: row.human_block_count,
      repoName: repo.name,
      relPath: row.rel_path,
      content: readFileSync(abs, "utf8"),
    };
  }

  /**
   * 关键词检索（P10）：按 `## ` 分节做大小写不敏感子串匹配，命中返回页 slug、
   * 节标题、起始行号与摘录。只扫 DB 里登记过的页面文件（不是全目录 glob——
   * 划分变更后未重算的孤儿文件不该被搜出来）。q 为空返回空数组不报错。
   */
  function search(repoId, q, { moduleSlug = null, limit = 20 } = {}) {
    const needle = String(q ?? "").trim().toLowerCase();
    if (needle === "") return [];
    const cap = Math.max(1, Math.min(100, Number(limit) || 20));
    const pages = db.prepare(
      `SELECT m.slug, m.title AS module_title, p.rel_path
         FROM choro_modules m JOIN choro_pages p ON p.module_id = m.id
        WHERE m.repo_id = ? AND (? IS NULL OR m.slug = ?)
        ORDER BY m.slug`
    ).all(repoId, moduleSlug, moduleSlug);
    const repo = db.prepare("SELECT root_path FROM choro_repos WHERE id = ?").get(repoId);
    const hits = [];
    for (const page of pages) {
      const abs = join(repo.root_path, page.rel_path);
      if (!existsSync(abs)) continue;
      let text;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      // 分节：每个 `## ` 标题开启一节，节内所有行都属于该节；文件头（frontmatter
      // 之后到第一个 `## `）算 "（页首）" 一节，保证对 title/摘要的命中也有落点。
      let section = "（页首）";
      let sectionStart = 1;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (i > 0 && /^## /.test(line)) {
          section = line.replace(/^## /, "").trim();
          sectionStart = i + 1;
        }
        if (line.toLowerCase().includes(needle)) {
          hits.push({
            slug: page.slug,
            moduleTitle: page.module_title,
            section,
            line: i + 1,
            sectionStart,
            excerpt: line.trim().slice(0, 200),
          });
          if (hits.length >= cap) return hits;
        }
      }
    }
    return hits;
  }

  /**
   * 按会话工作目录找已登记仓库（M3 开局注入的唯一入口）。
   *
   * 三个刻意的取舍：
   * 1. **祖先前缀匹配**而不是精确相等——真实会话的 cwd 常常是仓库子目录
   *    （`D:/repo/src`），精确相等会让绝大部分会话匹配不到，等于逼用户
   *    「必须在仓库根开会话」这条暗规则。
   * 2. 两侧都做 realpath 归一：Windows 上盘符大小写、8.3 短名、符号链接
   *    会让同一个目录写出不同字符串；t0 落库时存的就是 realpath。
   * 3. **最长前缀胜出**——仓库嵌套（子模块、`.worktrees/`）时取最深那层，
   *    否则内层会话会被外层仓库抢走。
   * cwd 不存在或不是目录时返回 null（不是抛错）：注入在热路径上，失败只
   * 意味着「本帧不注入」。
   */
  function repoByCwd(cwd) {
    const raw = String(cwd ?? "").trim();
    if (raw === "") return null;
    let normalized;
    try {
      normalized = realpathSync(resolve(raw));
    } catch {
      return null;
    }
    const cmp = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
    const target = cmp(normalized);
    const rows = db.prepare("SELECT * FROM choro_repos ORDER BY id").all();
    let best = null;
    for (const row of rows) {
      const root = cmp(String(row.root_path ?? ""));
      if (root === "") continue;
      const hit = target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
      if (!hit) continue;
      if (!best || root.length > cmp(String(best.root_path)).length) best = row;
    }
    return best ?? null;
  }

  /**
   * 注入与 /choro 共用的最小提纲（M3）：模块名 + 文件数 + 页状态 + 页相对路径。
   * **不读页正文**——spec §7 要求「只注标题级不注正文」，正文走 readPage。
   * parentSlug 单独解出来给渲染层做层级缩进（DB 里存的是 parent_id）。
   */
  function outline(repoId) {
    const repo = db.prepare(
      "SELECT id, root_path, name, git_baseline, plan_fingerprint, updated_at FROM choro_repos WHERE id = ?"
    ).get(repoId);
    if (!repo) return null;
    const rows = db.prepare(
      `SELECT m.id, m.slug, m.title, m.parent_id, m.file_count,
              p.status AS page_status, p.rel_path AS page_rel_path, p.generated_at
         FROM choro_modules m
         LEFT JOIN choro_pages p ON p.module_id = m.id
        WHERE m.repo_id = ? ORDER BY m.slug`
    ).all(repoId);
    const slugById = new Map(rows.map((r) => [r.id, r.slug]));
    let generatedAt = null;
    const modules = rows.map((r) => {
      if (r.generated_at && (generatedAt === null || r.generated_at > generatedAt)) generatedAt = r.generated_at;
      return {
        slug: r.slug,
        title: r.title,
        fileCount: r.file_count,
        parentSlug: r.parent_id === null || r.parent_id === undefined ? null : slugById.get(r.parent_id) ?? null,
        status: r.page_status ?? null,
        relPath: r.page_rel_path ?? null,
      };
    });
    return {
      repo: {
        id: repo.id,
        name: repo.name,
        rootPath: repo.root_path,
        gitBaseline: repo.git_baseline,
        updatedAt: repo.updated_at,
      },
      generatedAt: generatedAt ?? repo.updated_at ?? null,
      modules,
    };
  }

  // --- chorography 向量（收尾档 P37–P39）---------------------------------
  // 惰性物化（P37）：只在 host 侧检索路径调用（embedder 由 index.js 注入）；
  // CLI 环境没有 embedder → 向量永不物化，检索退关键词。staleness 两维：
  // 页 generated_at 变了（内容变了）、行 dim ≠ 本次查询向量 dim（换 embedder
  // 模型了，P38）→ 重嵌。dim 失配是全表性的，遇到一次就把整仓重嵌（几十页）。
  async function embedPageVectors(repoId, embedder, { limit = 200, expectDim = null } = {}) {
    const pages = db.prepare(
      `SELECT p.id, p.generated_at, m.slug, m.title, p.rel_path
         FROM choro_pages p JOIN choro_modules m ON p.module_id = m.id
        WHERE m.repo_id = ? ORDER BY m.slug`
    ).all(repoId);
    const repo = db.prepare("SELECT root_path FROM choro_repos WHERE id = ?").get(repoId);
    const embedOne = embedder.embedSingle ? (t) => embedder.embedSingle(t) : (t) => embedder.embed(t);
    const rows = store.getChoroPageVectors(repoId);
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    const result = { embedded: 0, skipped: 0, stale: 0, failed: [], dimMismatch: false };
    // dim 失配的全量重嵌（P38）：expectDim 来自查询向量（调用方先嵌查询再物化，
    // 维度免费拿到）。expectDim 与任何现存行失配 → 本轮 fresh 检查失效，全量重嵌；
    // 没给 expectDim（无查询场景）退化为只按 generated_at 判 staleness。
    const dimDrift = expectDim !== null && rows.some((r) => r.dim !== expectDim);
    if (dimDrift) result.dimMismatch = true;
    for (const page of pages) {
      if (result.embedded >= limit) break;
      const row = bySlug.get(page.slug);
      const fresh = !dimDrift && row && row.source_generated_at === page.generated_at && row.vector;
      if (fresh) { result.skipped++; continue; }
      if (row && row.vector) result.stale++;
      const abs = join(repo.root_path, page.rel_path);
      if (!existsSync(abs)) continue;
      let text;
      try {
        text = pageEmbedText(readFileSync(abs, "utf8"));
      } catch {
        result.failed.push({ slug: page.slug, reason: "page-unreadable" });
        continue;
      }
      if (text.trim() === "") { result.skipped++; continue; }
      let vector;
      try {
        vector = await embedOne(text);
      } catch (err) {
        result.failed.push({ slug: page.slug, reason: String(err?.message ?? err).slice(0, 120) });
        continue;
      }
      if (!Array.isArray(vector) || vector.length === 0) {
        result.failed.push({ slug: page.slug, reason: "embedder-returned-no-vector" });
        continue;
      }
      if (row && row.dim !== vector.length) result.dimMismatch = true;
      store.saveChoroPageVector(page.id, {
        vector,
        dim: vector.length,
        model: String(embedder.model ?? "choro"),
        sourceGeneratedAt: page.generated_at,
        createdAt: new Date().toISOString(),
      });
      result.embedded++;
    }
    return result;
  }

  /** 嵌查询文本（宿主侧）。embedder 缺席 / 不可用 → null。 */
  async function embedQueryText(embedder, q) {
    if (!embedder) return null;
    const embedOne = embedder.embedSingle ? (t) => embedder.embedSingle(t) : (t) => embedder.embed(t);
    try {
      const v = await embedOne(String(q ?? ""));
      return Array.isArray(v) && v.length > 0 ? v : null;
    } catch {
      return null;
    }
  }

  /** 纯余弦 Top-N：向量已给定时零嵌入。行 dim 与查询失配的行过滤掉（P38）。 */
  function semanticTopN(repoId, queryVector, { limit = 10 } = {}) {
    if (!Array.isArray(queryVector) || queryVector.length === 0) return [];
    const rows = store.getChoroPageVectors(repoId).filter((r) => r.vector && r.dim === queryVector.length);
    return rows
      .map((r) => ({
        slug: r.slug,
        title: r.title,
        score: Number(cosine(queryVector, JSON.parse(r.vector)).toFixed(4)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
  }

  /** 便捷组合：嵌查询 + Top-N（P39：独立数组，不与 keyword hits 混排序）。
   * 空查询 → []（空白查询的「语义」是噪声，面板逐键触发时尤其如此）；
   * embedder 缺席 → null（调用方退纯关键词）。 */
  async function searchSemantic(repoId, embedder, q, { limit = 10 } = {}) {
    if (!embedder) return null;
    if (String(q ?? "").trim() === "") return [];
    const queryVector = await embedQueryText(embedder, q);
    if (!queryVector) return [];
    return semanticTopN(repoId, queryVector, { limit });
  }

  return {
    listRepos, resolveRepo, moduleMap, readPage, search, repoByCwd, outline,
    embedPageVectors, searchSemantic, embedQueryText, semanticTopN,
  };
}
