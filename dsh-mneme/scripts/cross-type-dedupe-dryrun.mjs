#!/usr/bin/env node
// #687 one-time stock take: list cross-type near-duplicate memory pairs that the
// batch-level rule would have collapsed, so a human can approve a supersede pass
// before anything widens. READ-ONLY by construction: the database is opened with
// readOnly: true and this script contains no INSERT / UPDATE / DELETE — the only
// thing it ever produces is a report.
//
// Why only two type pairs: the 2026-11-13 measurement over the live library found
// 45 pairs at cosine >= 0.90, of which 36 (80%) were genuinely synonymous but 9
// merged away real information (5 time-series/state-snapshot, 2 symptom-vs-fix,
// 1 inverted conclusion, 1 different version). The concentration was in
// constraint<->pitfall (9) and history<->project (8), so the in-batch rule is
// gated to exactly those two pairs rather than opening a permanent type gate.
//
// Usage:
//   node scripts/cross-type-dedupe-dryrun.mjs [--db <path>] [--min-sim 0.9] [--out <file>]
//
// The report contains memory titles/content — private data. The default --out is
// outside the repository and an --out inside the repository is refused, because
// this file must never be committed.

import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { textSimilarity } from "../src/quality-filter.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The two pairs the rule is allowed to act on. Everything else is out of scope,
// including same-type duplicates (handled by saveWithDedupe / autoDream).
const ALLOWED_PAIRS = [
  ["pitfall", "constraint"],
  ["history", "project"]
];

function parseArgs(argv) {
  const args = { db: null, minSim: 0.9, out: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") args.db = argv[++i];
    else if (a === "--min-sim") args.minSim = Number(argv[++i]);
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      console.log("usage: node scripts/cross-type-dedupe-dryrun.mjs [--db <path>] [--min-sim 0.9] [--out <file>] [--json]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function defaultDbPath() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || ".", ".dsh");
  return join(home, "memory", "memory.db");
}

function parseVector(raw) {
  if (typeof raw !== "string" || !raw) return null;
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const vec = new Float64Array(arr.length);
  let norm = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = Number(arr[i]);
    if (!Number.isFinite(v)) return null;
    vec[i] = v;
    norm += v * v;
  }
  if (norm <= 0) return null;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < vec.length; i++) vec[i] *= inv;
  return vec;
}

function cosine(a, b) {
  // Dimension mismatch is not a near-miss, it is an unanswerable comparison:
  // return null so the caller can count it instead of scoring it 0 (the silent
  // "runs to completion, looks fine" failure this project already ate once).
  if (!a || !b || a.length !== b.length) return null;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// "Keep the fuller one" must be a deterministic function of the row, not of
// iteration order: content length first (the whole reason for superseding
// instead of merging), then the later edit, then id as the final tiebreak.
function pickWinner(a, b) {
  const la = String(a.content ?? "").length;
  const lb = String(b.content ?? "").length;
  if (la !== lb) return la > lb ? { winner: a, loser: b, criterion: "longer-content" } : { winner: b, loser: a, criterion: "longer-content" };
  const ua = String(a.updated_at ?? "");
  const ub = String(b.updated_at ?? "");
  if (ua !== ub) return ua > ub ? { winner: a, loser: b, criterion: "newer-updated_at" } : { winner: b, loser: a, criterion: "newer-updated_at" };
  return a.id < b.id ? { winner: a, loser: b, criterion: "id-tiebreak" } : { winner: b, loser: a, criterion: "id-tiebreak" };
}

const args = parseArgs(process.argv.slice(2));
const dbPath = resolve(args.db ?? defaultDbPath());
const outPath = resolve(args.out ?? join(tmpdir(), "mneme-cross-type-dedupe-dryrun.json"));

// Guard the guard: a report holding memory text inside the checkout would end up
// in a commit sooner or later. Refuse instead of relying on the operator.
if (outPath === REPO_ROOT || outPath.startsWith(REPO_ROOT + sep)) {
  throw new Error(`refusing to write the report inside the repository (${outPath}); pass --out to a path outside ${REPO_ROOT}`);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec("PRAGMA busy_timeout = 5000;");

const types = [...new Set(ALLOWED_PAIRS.flat())];
const placeholders = types.map(() => "?").join(", ");
const rows = db.prepare(
  `SELECT id, type, title, content, updated_at, embedding
     FROM memories
    WHERE type IN (${placeholders})
      AND archived = 0
      AND forgotten = 0
      AND superseded_by IS NULL
      AND embedding IS NOT NULL`
).all(...types);

const byType = new Map(types.map((t) => [t, []]));
let unvectorized = 0;
let dimMismatch = 0;
for (const row of rows) {
  row.vec = parseVector(row.embedding);
  delete row.embedding;
  if (!row.vec) {
    unvectorized++;
    continue;
  }
  byType.get(row.type)?.push(row);
}

const dims = new Set([...byType.values()].flat().map((r) => r.vec.length));
if (dims.size > 1) {
  // Two embedding generations in one library means cross-generation cosines are
  // meaningless; say so instead of producing a number nobody should trust.
  throw new Error(`library holds mixed embedding dimensions (${[...dims].join(", ")}); refusing to compare across them`);
}

const pairs = [];
for (const [left, right] of ALLOWED_PAIRS) {
  const A = byType.get(left) ?? [];
  const B = byType.get(right) ?? [];
  for (const a of A) {
    for (const b of B) {
      const sim = cosine(a.vec, b.vec);
      if (sim === null) {
        dimMismatch++;
        continue;
      }
      if (sim < args.minSim) continue;
      const pick = pickWinner(a, b);
      pairs.push({
        left: a.type,
        right: b.type,
        leftId: a.id,
        rightId: b.id,
        cosine: Number(sim.toFixed(4)),
        // Second, independent signal: the same bigram overlap the batch rule
        // uses, so the reviewer can see which pairs survive a *text* comparison
        // too (a high cosine with low text overlap is often a same-topic,
        // different-fact pair — exactly the kind the 2026-11-13 audit found).
        textSim: Number(textSimilarity(`${a.title}\n${a.content}`, `${b.title}\n${b.content}`).toFixed(4)),
        keep: pick.winner.id,
        drop: pick.loser.id,
        criterion: pick.criterion,
        keepType: pick.winner.type,
        dropType: pick.loser.type,
        keepTitle: pick.winner.title,
        dropTitle: pick.loser.title,
        keepLen: String(pick.winner.content ?? "").length,
        dropLen: String(pick.loser.content ?? "").length
      });
    }
  }
}

pairs.sort((x, y) => y.cosine - x.cosine || x.keep.localeCompare(y.keep));

const report = {
  generatedAt: new Date().toISOString(),
  db: dbPath,
  readOnly: true,
  minSim: args.minSim,
  allowedPairs: ALLOWED_PAIRS,
  scanned: { [types[0]]: byType.get(types[0])?.length ?? 0, [types[1]]: byType.get(types[1])?.length ?? 0, unvectorized, dimMismatch },
  pairCount: pairs.length,
  byPair: Object.fromEntries(ALLOWED_PAIRS.map(([l, r]) => [`${l}<->${r}`, pairs.filter((p) => (p.left === l && p.right === r)).length])),
  // The batch rule reuses textSim (bigram overlap) as its gate; the table below
  // shows how the two signals line up on real data before that default is set.
  textSimBands: Object.fromEntries(
    [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]].map(([lo, hi]) => [
      `${lo}-${hi >= 1 ? 1 : hi}`,
      pairs.filter((p) => p.textSim >= lo && p.textSim < hi).length
    ])
  ),
  pairs
};

writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`read-only scan: ${dbPath}`);
  console.log(`types: ${types.join(", ")}; scanned ${rows.length} rows (unvectorized ${unvectorized}, dim mismatch ${dimMismatch})`);
  console.log(`pairs at cosine >= ${args.minSim}: ${pairs.length} (${Object.entries(report.byPair).map(([k, v]) => `${k}=${v}`).join(", ")})`);
  console.log("textSim bands:", JSON.stringify(report.textSimBands));
  console.log("");
  console.log("cosine  textSim  pair                 keep(id/len)  drop(id/len)  criterion");
  for (const p of pairs) {
    console.log(
      `${p.cosine.toFixed(4)}  ${p.textSim.toFixed(4)}   ${`${p.left}/${p.right}`.padEnd(20)} ${`${p.keep.slice(0, 8)}/${p.keepLen}`.padEnd(14)} ${`${p.drop.slice(0, 8)}/${p.dropLen}`.padEnd(14)} ${p.criterion}`
    );
  }
  console.log("");
  console.log(`report: ${outPath}`);
}

db.close();