// Rule-based memory quality filter (Bug7). Pure + total: no shared state, no
// async, no external calls, so it can be unit-tested in isolation and wired
// into the writer without any I/O or store access.
//
// evaluateMemoryQuality scores a memory 0-100 and tags low-value signals. The
// writer then decides (config.memoryQualityFilter):
//   score >= degradeThreshold (60)     → stored normally
//   archiveThreshold (30) <= score < 60 → quality_score persisted; the
//     injection sort re-ranks by importance * quality_score/100 (degraded)
//   score < archiveThreshold (30)      → archived + tagged low_quality (still
//     recallable via explicit search, just never auto-injected)
//
// Signals and their deductions from the base 100:
//   meta                meta-memory vocabulary (the memory talks about the
//                       memory system itself, not the user's world)    −45
//   self_referential    title/content mentions its own type label      −15
//   short_content       content shorter than minContentLength          −80
//   repetitive          trigram repetition ratio > 0.7                 −50
//   duplicate           bigram similarity to a recent memory > 0.85    −80
//
// The meta signal alone lands a well-formed memory in the degraded band
// (30..60) — it is still stored and searchable, just demoted in injection.
// Reaching the archive band (< 30) needs a degenerate body (short, repetitive
// or near-duplicated) or stacked signals.

export const META_MEMORY_RE =
  /记忆|mneme|recall|inject|上下文|token|prompt|系统指令|作为AI|作为助手|我需要记住|总结一下刚才/;

// The deduction table is exported because a SECOND reader needs the same numbers: the
// one-time backfill in store.js reconstructs a stored score from a row's surviving tags
// (it cannot re-score wholesale — that would also re-apply signals that were never on
// the row). Duplicating 45/15/80/50/80 there would make "what a tag costs" two facts
// that can drift apart, and the drift would be silent: the backfill would just write
// slightly wrong numbers. Keys are the tag names, not the reasons.
export const SIGNAL_DEDUCTIONS = Object.freeze({
  meta: 45,
  self_referential: 15,
  short_content: 80,
  repetitive: 50,
  duplicate: 80
});

// Own-type labels, used for self-reference detection (the English type value
// the AI writers emit plus the Chinese equivalent a human would type).
const TYPE_LABELS = {
  preference: ["preference", "偏好"],
  project: ["project", "项目"],
  decision: ["decision", "决策", "决定"],
  history: ["history", "历史", "事件"],
  summary: ["summary", "总结", "摘要", "总览"],
  pattern: ["pattern", "模式", "规律"],
  rejected_solution: ["rejected_solution", "被否决", "废弃方案"],
  pitfall: ["pitfall", "踩坑"],
  constraint: ["constraint", "约束"]
};

/** Normalized bigram-overlap similarity in [0,1]; 0 for tiny/empty inputs. */
export function textSimilarity(a, b) {
  const bigrams = (s) => {
    const set = new Set();
    const t = String(s).replace(/\s+/g, "");
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / Math.min(A.size, B.size);
}

// Repetition threshold. Calibrated 2026-11-04 against a real 12,827-row library:
// the highest trigram ratio among genuine memories was 0.591 (a note where the
// same install paths repeat), so 0.7 keeps every real memory clear while still
// catching degenerate fillers (a single char x20 = 0.94, a sentence x5 = 0.79).
// Do not lower this without re-measuring: 0.6 leaves only 0.009 of headroom.
export const REPETITION_THRESHOLD = 0.7;

/**
 * Trigram repetition ratio in [0,1]: the share of 3-char windows that are not
 * the first occurrence of their own trigram. 0 = every trigram distinct.
 *
 * Why this instead of unique-chars / total (the measure shipped in v0.7.12):
 * that one is a function of LENGTH, not of repetition. Chinese prose draws from
 * a few hundred common characters, so uniqueChars/total decays toward 0 as the
 * text grows — measured on a real library it fell below the old 0.3 gate for
 * 94% of 800-2000 char memories and 100% of those over 2000 chars. Long memories
 * were being tagged "repetitive" for being long. Trigram repetition is
 * length-stable: concatenating distinct real memories up to 30,000 chars only
 * reaches 0.428, while genuinely duplicated text passes 0.6 by the second copy.
 */
export function repetitionRatio(text) {
  const t = String(text).replace(/\s+/g, "");
  if (t.length < 3) return 0;
  const total = t.length - 2;
  const seen = new Set();
  for (let i = 0; i < total; i++) seen.add(t.slice(i, i + 3));
  return 1 - seen.size / total;
}

/**
 * Score a memory's quality. `recentContents` (optional) is the list of recent
 * memory contents used for near-duplicate detection; when omitted the duplicate
 * signal is skipped. Never throws: every input is coerced defensively.
 * @param {object} memory  { type, title, content }
 * @param {object} [options]
 * @param {number} [options.minContentLength=10]
 * @param {string[]} [options.recentContents]  up to ~20 recent contents
 * @returns {{score: number, tags: string[], reason: string}}
 */
export function evaluateMemoryQuality(memory, options = {}) {
  const minContentLength = options.minContentLength ?? 10;
  const recentContents = Array.isArray(options.recentContents) ? options.recentContents : [];
  const title = String(memory?.title ?? "");
  const content = String(memory?.content ?? "");
  const text = `${title}\n${content}`;
  const trimmed = content.trim();
  const tags = [];
  const reasons = [];
  let score = 100;

  if (META_MEMORY_RE.test(text)) {
    score -= SIGNAL_DEDUCTIONS.meta;
    tags.push("meta");
    reasons.push("meta-memory vocabulary");
  }

  const labels = TYPE_LABELS[memory?.type];
  if (labels && labels.some((l) => text.includes(l))) {
    score -= SIGNAL_DEDUCTIONS.self_referential;
    tags.push("self_referential");
    reasons.push("mentions its own type");
  }

  if (minContentLength > 0 && trimmed.length < minContentLength) {
    score -= SIGNAL_DEDUCTIONS.short_content;
    tags.push("short_content");
    reasons.push(`content shorter than ${minContentLength} chars`);
  }

  if (trimmed.length > 0 && repetitionRatio(trimmed) > REPETITION_THRESHOLD) {
    score -= SIGNAL_DEDUCTIONS.repetitive;
    tags.push("repetitive");
    reasons.push("repetitive content");
  }

  if (recentContents.length > 0 && trimmed.length > 0) {
    for (const other of recentContents) {
      if (textSimilarity(trimmed, other) > 0.85) {
        score -= SIGNAL_DEDUCTIONS.duplicate;
        tags.push("duplicate");
        reasons.push("near-duplicate of a recent memory");
        break;
      }
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  if (score < 30) tags.push("low_quality");
  return { score, tags: [...new Set(tags)], reason: reasons.length ? reasons.join("; ") : "ok" };
}
