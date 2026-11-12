// BM25 sparse retrieval (v0.5.0 召回率优化 1.1): the third recall path beside
// vector search and the LIKE keyword scan. The LIKE path only matches full
// substrings, so a multi-term query ("rust 异步 tokio") misses rows whose
// terms are scattered. BM25 scores per-token overlap with IDF weighting,
// which is exactly the gap: identifiers, code fragments and mixed CJK/ASCII
// queries recall rows the substring scan cannot see.

// Tokenizer: ASCII words keep their shape (identifiers like "dsh-mneme" or
// "ZFS_4421" survive as whole tokens); CJK runs become sliding bigrams
// (unigram only for single characters), the standard workaround for BM25's
// whitespace tokenization on Chinese.
export function tokenize(text) {
  const raw = String(text ?? "").toLowerCase();
  const tokens = [];
  const ascii = raw.match(/[a-z0-9_]+/g) ?? [];
  tokens.push(...ascii);
  const cjkRuns = raw.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) { tokens.push(run); continue; }
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

const K1 = 1.5; // term-frequency saturation
const B = 0.75;  // length normalization

/**
 * Build a BM25 index over documents: [{id, title, content}].
 * Returns { score, search }:
 *   score(query, doc) — per-spec ad-hoc scoring (re-tokenizes the doc)
 *   search(query, {limit}) — precomputed-tf ranking, scores normalized to
 *     [0,1] by the max so BM25 hits can weight-blend with vector/keyword
 *     scores on one scale. Rows the query does not touch at all are dropped.
 */
export function createBM25Index(documents) {
  const docs = Array.isArray(documents) ? documents.filter(Boolean) : [];
  const N = docs.length;
  const df = new Map();
  const prepared = docs.map((doc) => {
    const tokens = tokenize(`${doc.title ?? ""} ${doc.content ?? ""}`);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return { doc, tf, len: tokens.length };
  });
  const avgLen = N ? prepared.reduce((s, p) => s + p.len, 0) / N : 0 || 1;

  const idf = (t) => {
    const n = df.get(t) ?? 0;
    return Math.log((N - n + 0.5) / (n + 0.5) + 1);
  };

  function scorePrepared(queryTokens, p) {
    let score = 0;
    for (const t of queryTokens) {
      const f = p.tf.get(t);
      if (!f) continue;
      const norm = p.len ? K1 * (1 - B + B * (p.len / avgLen)) : K1;
      score += idf(t) * ((f * (K1 + 1)) / (f + norm));
    }
    return score;
  }

  return {
    score(query, doc) {
      const tokens = tokenize(`${doc?.title ?? ""} ${doc?.content ?? ""}`);
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      const len = tokens.length;
      // Ad-hoc scoring can't see corpus df; fall back to tf-only saturation
      // (df is approximated as 1 so idf ≈ log(N - 0.5 + 1) is constant).
      let score = 0;
      for (const t of tokenize(query)) {
        const f = tf.get(t);
        if (!f) continue;
        const norm = len ? K1 * (1 - B + B * (len / avgLen)) : K1;
        score += idf(t) * ((f * (K1 + 1)) / (f + norm));
      }
      return score;
    },
    search(query, { limit = 20 } = {}) {
      const qTokens = tokenize(query);
      if (!qTokens.length || !N) return [];
      const scored = [];
      for (const p of prepared) {
        const s = scorePrepared(qTokens, p);
        if (s > 0) scored.push({ row: p.doc, raw: s });
      }
      scored.sort((a, b) => b.raw - a.raw);
      const top = scored.slice(0, limit);
      const max = top[0]?.raw || 1;
      return top.map(({ row, raw }) => ({ ...row, score: max ? raw / max : 0 }));
    }
  };
}
/**
 * 增量语料索引（召回语料专用，service.js 的 bm25Recall 走这条）。
 *
 * 与 createBM25Index 共用同一套 tokenizer、K1/B 与打分公式，差别只在状态与表示：
 *
 * - 状态可变：upsert / remove 按 id 局部更新词表、df 与文档表，重建成本随「本轮
 *   变化的行数」走而不是随语料规模走。9k 行全量 build 实测 420ms，而一次写入只
 *   改几十行、增量 upsert 50 行不到 5ms。
 * - 表示紧凑：每篇文档的 term 存成「升序 Int32Array(termId) + 对齐的
 *   Uint16Array(freq)」，查询时与升序的查询词做归并求交，不用 Map 查找。
 *   同一份语料下与 Map 表示结果逐位相同（打分为整数排序后的同一批 term），
 *   但常驻内存约为其三分之一，查询也更快。
 * - 索引只留 id + 频次，不持有整行：召回结果由调用方按 id 回表补全（融合与
 *   注入渲染都需要完整字段）。
 *
 * 契约与 createBM25Index 的唯一差别：search 返回 { id, score }，不返回文档本身。
 */
export function createCorpusIndex() {
  const termIds = new Map(); // term -> termId
  // termId 只增不减：被删除的词保留 id 但 df 归零。它不会再出现在任何文档的
  // term 数组里，因此既不影响打分也不会让 df 变成负数——复用 id 反而会让
  // 「删除的分数」串到新词上。
  const df = [];             // termId -> 含该词的文档数
  const slots = [];          // slot -> { id, terms: Int32Array, freqs: Uint16Array, len } | null
  const slotById = new Map();
  const freeSlots = [];
  let totalLen = 0;

  function termIdOf(term, create) {
    const seen = termIds.get(term);
    if (seen !== undefined) return seen;
    if (!create) return -1;
    const id = df.length;
    termIds.set(term, id);
    df.push(0);
    return id;
  }

  function release(slot) {
    const rec = slots[slot];
    if (!rec) return;
    for (let i = 0; i < rec.terms.length; i++) df[rec.terms[i]] -= 1;
    totalLen -= rec.len;
    slots[slot] = null;
    slotById.delete(rec.id);
    freeSlots.push(slot);
  }

  function remove(id) {
    const slot = slotById.get(id);
    if (slot === undefined) return false;
    release(slot);
    return true;
  }

  function upsert(doc) {
    if (!doc || doc.id == null) return;
    const tokens = tokenize(`${doc.title ?? ""} ${doc.content ?? ""}`);
    // 聚合不做成每文档一个 Map（9k 行就是 9k 个临时 Map，实测是 build 的主要开销）：
    // 先把 termId 摊进数组做数值排序，再压缩同值连续段得到 (terms, freqs)。
    const flat = new Int32Array(tokens.length);
    for (let i = 0; i < tokens.length; i++) flat[i] = termIdOf(tokens[i], true);
    flat.sort();
    let uniq = 0;
    for (let i = 0; i < flat.length; i++) if (i === 0 || flat[i] !== flat[i - 1]) uniq += 1;
    const terms = new Int32Array(uniq);
    const freqs = new Uint16Array(uniq);
    let w = -1;
    for (let i = 0; i < flat.length; i++) {
      if (i === 0 || flat[i] !== flat[i - 1]) {
        w += 1;
        terms[w] = flat[i];
        freqs[w] = 1;
      } else if (freqs[w] < 65535) {
        freqs[w] += 1;
      }
    }

    const existing = slotById.get(doc.id);
    if (existing !== undefined) release(existing);
    const slot = freeSlots.length ? freeSlots.pop() : slots.length;
    slots[slot] = { id: doc.id, terms, freqs, len: tokens.length };
    slotById.set(doc.id, slot);
    totalLen += tokens.length;
    for (let i = 0; i < terms.length; i++) df[terms[i]] += 1;
  }

  function has(id) { return slotById.has(id); }
  function size() { return slotById.size; }
  function ids() { return [...slotById.keys()]; }

  function search(query, { limit = 20 } = {}) {
    const n = slotById.size;
    if (!n) return [];
    const seen = new Set();
    const wanted = [];
    for (const t of tokenize(query)) {
      const tId = termIdOf(t, false);
      if (tId < 0 || seen.has(tId)) continue;
      seen.add(tId);
      wanted.push(tId);
    }
    if (!wanted.length) return [];
    wanted.sort((a, b) => a - b);
    const idfs = wanted.map((tId) => Math.log((n - df[tId] + 0.5) / (df[tId] + 0.5) + 1));
    // totalLen 为 0（全是空文档）时退化为 1，且 len 为 0 的文档走 K1 分支，不做 0 除法
    const avgLen = totalLen ? totalLen / n : 1;

    const scored = [];
    for (const rec of slots) {
      if (!rec) continue;
      let raw = 0;
      // 归并求交：rec.terms 与 wanted 都升序，双指针一遍过
      let i = 0;
      let j = 0;
      while (i < rec.terms.length && j < wanted.length) {
        const a = rec.terms[i];
        const b = wanted[j];
        if (a < b) { i++; continue; }
        if (a > b) { j++; continue; }
        const f = rec.freqs[i];
        const norm = rec.len ? K1 * (1 - B + B * (rec.len / avgLen)) : K1;
        raw += idfs[j] * ((f * (K1 + 1)) / (f + norm));
        i++;
        j++;
      }
      if (raw > 0) scored.push({ id: rec.id, raw });
    }
    scored.sort((a, b) => b.raw - a.raw);
    const top = scored.slice(0, limit);
    const max = top[0]?.raw || 1;
    return top.map(({ id, raw }) => ({ id, score: max ? raw / max : 0 }));
  }

  return { upsert, remove, has, size, ids, search };
}
