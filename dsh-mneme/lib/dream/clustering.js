// Cosine similarity of two equal-length numeric vectors. Returns 0 for empty
// or mismatched-length inputs, and for zero-norm vectors (numerically stable).
// Accepts typed arrays (Float32Array) as well as plain arrays: store.js caches
// vectors as Float32Array and `Array.isArray` is false for typed arrays — guarding
// on it alone would silently score every cached vector as 0.
const isVec = (v) => Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView));

export function cosineSimilarity(a, b) {
  if (!isVec(a) || !isVec(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// K-Means clustering of numeric vectors. Returns one index array per cluster.
// Uses k-means++ seeding and repairs empty clusters mid-iteration.
export function kMeans(vectors, k, opts = {}) {
  const n = vectors.length;
  if (n === 0) return [];
  const { maxIter = 100, tol = 1e-4 } = opts ?? {};
  if (k <= 0 || k >= n) return [vectors.map((_, i) => i)];

  const dim = vectors[0].length;
  const randomIndex = () => Math.floor(Math.random() * n);
  const squaredDist = (v, c) => {
    let s = 0;
    for (let d = 0; d < dim; d++) s += (v[d] - c[d]) * (v[d] - c[d]);
    return s;
  };

  // k-means++ seeding: first centroid uniform-random, later centroids sampled
  // with probability proportional to squared distance from nearest centroid.
  const centroids = [[...vectors[randomIndex()]]];
  while (centroids.length < k) {
    const dist = new Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      for (const c of centroids) best = Math.min(best, squaredDist(vectors[i], c));
      dist[i] = best;
      sum += best;
    }
    if (sum === 0) {
      // All points coincide with a centroid; fall back to uniform random.
      centroids.push([...vectors[randomIndex()]]);
    } else {
      let r = Math.random() * sum;
      let pick = 0;
      for (let i = 0; i < n; i++) {
        r -= dist[i];
        if (r <= 0) { pick = i; break; }
      }
      centroids.push([...vectors[pick]]);
    }
  }

  const assignment = new Array(n).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    // Assign each point to its nearest centroid.
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0, bestD = Infinity;
      for (let j = 0; j < k; j++) {
        const d = squaredDist(vectors[i], centroids[j]);
        if (d < bestD) { bestD = d; best = j; }
      }
      if (assignment[i] !== best) { assignment[i] = best; changed = true; }
    }
    if (!changed) break; // stable assignment => converged.

    // Recompute centroids as cluster means; reseed empty clusters randomly.
    const sums = Array.from({ length: k }, () => new Array(dim).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      counts[assignment[i]]++;
      for (let d = 0; d < dim; d++) sums[assignment[i]][d] += vectors[i][d];
    }
    let maxMove = 0;
    for (let j = 0; j < k; j++) {
      if (counts[j] === 0) {
        centroids[j] = [...vectors[randomIndex()]];
        maxMove = Infinity; // never call this converged this round.
      } else {
        for (let d = 0; d < dim; d++) {
          const mean = sums[j][d] / counts[j];
          const move = mean - centroids[j][d];
          if (move * move > maxMove) maxMove = move * move;
          centroids[j][d] = mean;
        }
      }
    }
    if (Math.sqrt(maxMove) < tol) break; // centroids moved less than tol.
  }

  // Build clusters from final assignments.
  const clusters = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) clusters[assignment[i]].push(i);
  return clusters;
}

// Group memories by vector clustering, preserving original object references.
export function clusterMemories(memories, vectors, k) {
  return kMeans(vectors, k).map((indices) => indices.map((i) => memories[i]));
}

// Find memory pairs that are highly similar yet could contradict each other.
// Only same-type pairs count; each pair reported once, lower index first.
export function findPotentialConflicts(memories, vectors, threshold = 0.85) {
  const pairs = [];
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      if (memories[i].type !== memories[j].type) continue;
      const sim = cosineSimilarity(vectors[i], vectors[j]);
      if (sim > threshold) pairs.push({ a: memories[i], b: memories[j], similarity: sim });
    }
  }
  return pairs;
}
