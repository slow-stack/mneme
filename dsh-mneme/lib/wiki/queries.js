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
// 过期判定复用既有三件真源（t0 的 gitHead、plan 的指纹、render 的模板版本），
// 面板侧不另造一套判据——两套判据迟早会对同一仓库给出两个答案。
import { gitHead } from "./t0.js";
import { loadPlanFromRepo } from "./plan.js";
import { TEMPLATE_VERSION } from "./render.js";

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
                 WHERE m2.repo_id = r.id) AS page_count,
              (SELECT COUNT(*) FROM choro_claims c
                 JOIN choro_pages p2 ON c.page_id = p2.id
                 JOIN choro_modules m3 ON p2.module_id = m3.id
                WHERE m3.repo_id = r.id) AS claim_count
         FROM choro_repos r ORDER BY r.id`
    ).all();
    return rows;
  }

  /**
   * 面板仓库列表（契约 §3.2）：在 listRepos 的行上补契约要求的字段。
   *
   * 为什么另开一个函数而不是改 listRepos 的返回形状：listRepos 的
   * module_count / page_count 被工具层与查询层测试锁着（下划线命名），改名就是
   * 破坏既有调用方；而契约要的是 modules / pages 这样的对外字段。两套名字并存
   * 难看，但改名的连带面比难看贵得多——装饰层把它包一层，工具层照旧读原始行。
   *
   * 每个仓库都要 fork 一次 git 判过期：这是用户点开面板才走的路（不是每轮注入的
   * 热路径），一次 rev-parse 几十毫秒在交互里不可感知。
   */
  /**
   * 契约字段的仓库对象（stale 由调用方决定是否重算）。
   *
   * 注意区分两个入口：repoFacts 每次都会 fork git 判过期；repoFromRow 是纯行投影，
   * 给「已经知道过期原因、手上有判定结果」的调用方用（例如自动重跑之后要紧着按
   * 新基线说话，不能再拿旧行算一遍）。混用会得到自相矛盾的回执。
   */
  function repoFromRow(row) {
    const rootPath = String(row.root_path ?? "");
    return {
      id: row.id,
      name: row.name,
      rootPath,
      modules: Number(row.module_count ?? 0),
      pages: Number(row.page_count ?? 0),
      claims: Number(row.claim_count ?? 0),
      // legacy = 这个仓库里有页面是用旧模板（或 M0 的 NULL）渲染的：重跑一次 T0 就
      // 会把它们升级成当前模板，面板据此提示「建议重建」而不是让用户自己比对版本。
      legacy: legacyPages(row.id) > 0,
      lastRunAt: row.updated_at ?? null
    };
  }

  function legacyPages(repoId) {
    const hit = db.prepare(
      `SELECT COUNT(*) AS n FROM choro_pages p JOIN choro_modules m ON p.module_id = m.id
        WHERE m.repo_id = ? AND (p.template_version IS NULL OR p.template_version <> ?)`
    ).get(repoId, TEMPLATE_VERSION);
    return Number(hit?.n ?? 0);
  }

  function repoFacts(row) {
    const rootPath = String(row.root_path ?? "");
    // git 优先：代码变了是更硬的「该重跑」信号，plan 变了才退而求其次——两者同时
    // 成立时面板只说一句话，说「git」比说「plan」更贴近用户看到的现象（他刚改了码）。
    const head = rootPath === "" ? null : gitHead(rootPath);
    const baseline = String(row.git_baseline ?? "").trim();
    let staleReason = null;
    if (head && head !== baseline) {
      staleReason = "git";
    } else if (rootPath !== "") {
      // 读不到 git（head 为 null）时不直接判「没过期」：plan.yaml 可能已经被改过，
      // 那条判据不依赖 git，仍能给出答案。
      let planFingerprintNow = null;
      try { planFingerprintNow = loadPlanFromRepo(rootPath).fingerprint; } catch { planFingerprintNow = null; }
      // plan.yaml 校验不过时 loadPlanFromRepo 会抛——那是「现在读不出结论」，不是
      // 「过期了」，所以落 null 保持 stale=false，让重建按钮自己去报那条 YAML 错误。
      if (planFingerprintNow && planFingerprintNow !== String(row.plan_fingerprint ?? "")) {
        staleReason = "plan";
      }
    }
    return {
      ...repoFromRow(row),
      stale: staleReason !== null,
      staleReason
    };
  }

  /** 单仓的原始 listRepos 行（自动重跑之后要拿推进过的基线，不能再用旧行）。 */
  function listRepoRow(repoId) {
    return listRepos().find((r) => Number(r.id) === Number(repoId)) ?? null;
  }

  /** 契约形状的仓库列表：listRepos 的原始行 → 对外字段。 */
  function listRepoFacts() {
    return listRepos().map((row) => repoFacts(row));
  }

  /** 仓库的契约字段（按 id/name，给 /choro/page 这类已知单仓的读路径用）。 */
  function repoFactsById(repoId) {
    const row = listRepoRow(repoId);
    return row ? repoFacts(row) : null;
  }

  /**
   * 按绝对路径找已登记仓库（面板「选目录 → 生成」必需）：T0 apply 落库时存的是
   * realpath，所以这里也必须先 realpath 再比，否则 Windows 上盘符大小写/短名/符号
   * 链接会让同一个目录被当成新仓库重复登记一次。
   */
  function repoByRoot(rootPath) {
    const raw = String(rootPath ?? "").trim();
    if (raw === "") return null;
    let normalized;
    try { normalized = realpathSync(resolve(raw)); } catch { return null; }
    return db.prepare("SELECT * FROM choro_repos WHERE root_path = ?").get(normalized) ?? null;
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
    // 纯加法补一个 camelCase 的 relPath：面板从地志页导入知识点要拼「根路径 + 页相对
    // 路径」，而这里历史上直出 SQL 行的 snake_case（page_rel_path）。C 线按契约读的是
    // mod.relPath，字段一缺就恒 undefined，用户选完模块点导入只会看到「请先选模块」。
    // 原字段一律保留——src/tools.js 的 render 与 choro-command 都还在吃 file_count /
    // page_status，改形状会波及它们；outline() 里的同名映射是这件事的正确写法。
    for (const m of modules) m.relPath = m.page_rel_path ?? null;
    return { modules, edges };
  }

  /**
   * 读一页正文。slug 必须命中 DB 的模块行（P12：路径零用户输入）；索引仍在但
   * 文件缺失或不可读时带回相对路径，让调用方给出对应的恢复提示。
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
    let content;
    try {
      content = readFileSync(abs, "utf8");
    } catch (cause) {
      const error = cause.code === "ENOENT" || cause.code === "ENOTDIR" ? "page-missing" : "page-unreadable";
      return { error, slug: row.slug, relPath: row.rel_path };
    }
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
      content,
    };
  }

  /**
   * 关键词检索（P10）：按 `## ` 分节做大小写不敏感子串匹配，命中返回页 slug、
   * 节标题、起始行号与摘录。只扫 DB 里登记过的页面文件（不是全目录 glob——
   * 划分变更后未重算的孤儿文件不该被搜出来）。需要提示检索不完整的调用方可接收
   * 不可读的页 slug。q 为空返回空数组不报错。
   */
  function search(repoId, q, { moduleSlug = null, limit = 20, onUnreadablePage } = {}) {
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
      let text;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        onUnreadablePage?.(page.slug);
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
    listRepos, listRepoFacts, repoFacts, repoFactsById, repoFromRow, listRepoRow, repoByRoot,
    resolveRepo, moduleMap, readPage, search, repoByCwd, outline,
    embedPageVectors, searchSemantic, embedQueryText, semanticTopN,
  };
}
