// dsh-mneme/src/wiki/partition.js
// 模块划分（spec §6 步 4）：目录为初稿，用图的内聚度做合并，超 max_files_per_page
// 再逐级下切。全流程确定性：同输入两次划分给出逐项相同的结果（spec §9 的可重建
// 不变量要求划分本身也稳定）。
//
// 启发式只有两条、都便宜到可解释（V2 要人判质量，判据必须能口述）：
//   合并——同一父目录下的两个兄弟组，互相指向的内部边 ≥ MERGE_EDGE_MIN 且合并不超
//   上限时并成一组（典型收益：utils/ 与它唯一的消费者；典型损失：两个互不相干的
//   小目录被文件夹布局凑到一起，代价是页变大，不会错分语义）。
//   下切——超上限的组按下一级目录段切开；直属文件自成一组；叶子组仍超上限时按
//   文件名字典序切块（此时语义已无从谈起，保住「每页不超过上限」的契约）。
import { posix } from "node:path";
import { createHash } from "node:crypto";

const MERGE_EDGE_MIN = 3;

/**
 * @param {string[]} files 仓库相对路径（已排序）
 * @param {{edges: {from:string,to:string}[], external: Map<string,Set<string>>}} graph scan 的产物
 * @param {number} maxFilesPerPage plan.yaml 的上限
 * @returns {Array<{slug,title,dir,fileCount,files,parentSlug,internalEdges,externalDeps,fingerprint}>}
 */
export function partitionModules({ files, graph, maxFilesPerPage, repoName }) {
  const cap = Math.max(1, Math.floor(maxFilesPerPage));

  // 步 1：目录初稿——前两级目录段；根直属文件一组。
  const groups = new Map();
  for (const file of files) {
    const key = groupKeyOf(file);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }

  // 步 2：兄弟组合并（单遍、按 key 字典序，确定性）。
  mergeSiblingGroups(groups, graph.edges, cap);

  // 步 3：超限下切。
  const finalGroups = [];
  for (const key of [...groups.keys()].sort()) {
    splitOversized(key, groups.get(key), cap, finalGroups);
  }

  // 步 4：slug / title / 父链 / 边聚合。
  const modules = finalGroups
    .map((g) => materialize(g, graph))
    .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : a.slug < b.slug ? -1 : 1));

  assignSlugsAndParents(modules, repoName);
  for (const mod of modules) mod.fingerprint = moduleFingerprint(mod);
  return modules;
}

function groupKeyOf(file) {
  const dir = posix.dirname(file);
  if (dir === ".") return "";
  const segments = dir.split("/");
  return segments.slice(0, 2).join("/");
}

function mergeSiblingGroups(groups, edges, cap) {
  // 文件级边先折算到组级（两次查找的 Map，组数 = 目录数，量级无所谓）。
  const cross = new Map(); // "a|b" -> count（a、b 为组 key，字典序小的在前）
  for (const e of edges) {
    const ga = groupKeyOf(e.from);
    const gb = groupKeyOf(e.to);
    if (ga === gb || !groups.has(ga) || !groups.has(gb)) continue;
    const [x, y] = ga < gb ? [ga, gb] : [gb, ga];
    const k = `${x}|${y}`;
    cross.set(k, (cross.get(k) ?? 0) + 1);
  }

  const keys = [...groups.keys()].sort();
  for (const key of keys) {
    if (!groups.has(key)) continue; // 已被并走
    const parent = posix.dirname(key || "·");
    for (const [pairKey, count] of [...cross.entries()].sort()) {
      if (count < MERGE_EDGE_MIN) continue;
      const [a, b] = pairKey.split("|");
      if (a !== key) continue;
      if (!groups.has(a) || !groups.has(b)) continue;
      if (posix.dirname(a || "·") !== parent || posix.dirname(b || "·") !== parent) continue;
      if (groups.get(a).length + groups.get(b).length > cap) continue;
      // 并入字典序小的组；被并组从账上消失（cross 里的旧键自然失效）。
      groups.set(a, [...groups.get(a), ...groups.get(b)].sort());
      groups.delete(b);
    }
  }
}

function splitOversized(key, files, cap, out) {
  if (files.length <= cap) {
    out.push({ dir: key, files });
    return;
  }
  // 按下一级目录段细分；直属文件（无更深层）留在本组（subKey = key）。key 为空
  // （根直属组）时 dirname 是 "."，嵌套文件直接用完整相对目录做子键——根组没有
  // 「前缀可剥」。
  const sub = new Map();
  for (const file of files) {
    const dir = posix.dirname(file);
    let subKey;
    if (key === "") {
      subKey = dir === "." ? key : dir;
    } else {
      const rest = dir.startsWith(key + "/") ? dir.slice(key.length + 1) : "";
      subKey = rest === "" ? key : `${key}/${rest.split("/")[0]}`;
    }
    if (!sub.has(subKey)) sub.set(subKey, []);
    sub.get(subKey).push(file);
  }
  if (sub.size === 1) {
    const [onlyKey] = sub.keys();
    if (onlyKey === key) {
      // 已是最深层目录、没有可下的子级：按文件名切块，块名带序号（语义无可言，保契约）。
      chunkFiles(key, files, cap, out);
      return;
    }
    // 整组都在一个更深的子目录里：继续往下切。
    splitOversized(onlyKey, sub.get(onlyKey), cap, out);
    return;
  }
  for (const subKey of [...sub.keys()].sort()) {
    splitOversized(subKey, sub.get(subKey), cap, out);
  }
}

function chunkFiles(key, files, cap, out) {
  for (let i = 0; i < files.length; i += cap) {
    const slice = files.slice(i, i + cap);
    out.push({ dir: i === 0 ? key : `${key}#${Math.floor(i / cap) + 1}`, files: slice });
  }
}

function materialize(group, graph) {
  const fileSet = new Set(group.files);
  const internalEdges = graph.edges.filter((e) => fileSet.has(e.from) && fileSet.has(e.to));
  const extCounts = new Map();
  for (const [pkg, users] of graph.external) {
    const n = [...users].filter((f) => fileSet.has(f)).length;
    if (n > 0) extCounts.set(pkg, n);
  }
  return {
    dir: group.dir,
    files: group.files,
    fileCount: group.files.length,
    internalEdges,
    externalDeps: [...extCounts.entries()]
      .map(([pkg, count]) => ({ pkg, count }))
      .sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : b.count - a.count)),
  };
}

function assignSlugsAndParents(modules, repoName) {
  // slug：目录段连字化；重复加序号。空目录段（根直属）用 "root"。
  const used = new Map();
  for (const mod of modules) {
    const base = mod.dir === "" ? "root" : slugify(mod.dir);
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    mod.slug = n === 0 ? base : `${base}-${n + 1}`;
    mod.title = titleOf(mod, repoName);
  }
  // 父链：slug 集里目录包含关系最近的祖先（重名块 #2 算同层）。
  for (const mod of modules) {
    mod.parentSlug = null;
    let best = null;
    for (const other of modules) {
      if (other === mod) continue;
      if (other.dir === "") continue;
      if (mod.dir === other.dir || mod.dir === "") continue;
      if (!mod.dir.startsWith(other.dir + "/")) continue;
      if (best === null || other.dir.length > best.dir.length) best = other;
    }
    if (best) mod.parentSlug = best.slug;
  }
}

function slugify(dir) {
  return dir
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, "-")
    .replace(/\/+/g, "-")
    .replace(/^-+|-+$/g, "") || "root";
}

function titleOf(mod, repoName) {
  if (mod.dir === "") return repoName ? `${repoName}（仓库根）` : "仓库根";
  const segments = mod.dir.split("/");
  const last = segments[segments.length - 1];
  // 目录名直接当标题（保持原文大小写）；切块组带序号（dir 里的 # 是切块标记，
  // slugify 之后 slug 里已无 #，所以判断要看 dir）。
  return mod.dir.includes("#") ? `${last.replace(/#\d+$/, "")}（续 ${mod.dir.match(/#(\d+)$/)?.[1] ?? ""}）` : last;
}

function moduleFingerprint(mod) {
  const hash = createHash("sha256");
  for (const f of mod.files) hash.update(`f:${f}\n`);
  for (const e of mod.internalEdges) hash.update(`e:${e.from}>${e.to}\n`);
  return hash.digest("hex");
}
