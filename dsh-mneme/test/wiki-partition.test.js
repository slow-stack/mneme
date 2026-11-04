// partition.js 的回归锁：划分确定性（同输入两次逐项相同——spec §9 可重建不变量的
// 前半段）、兄弟组内聚合并、超限逐级下切、slug 稳定、父子链按目录包含。
import test from "node:test";
import assert from "node:assert/strict";
import { partitionModules } from "../src/wiki/partition.js";

function graph(edges) {
  const files = [...new Set(edges.flatMap((e) => [e.from, e.to]))].sort();
  return { files, graph: { edges, external: new Map() } };
}

test("划分是确定性的：同输入两次结果逐项相同", () => {
  const input = graph([
    { from: "src/a.js", to: "src/b.js" },
    { from: "lib/c.js", to: "src/a.js" },
  ]);
  const one = partitionModules({ ...input, maxFilesPerPage: 40, repoName: "demo" });
  const two = partitionModules({ ...input, maxFilesPerPage: 40, repoName: "demo" });
  assert.deepEqual(one, two);
});

test("根直属文件成 root 模块；目录组各自成页；互不相干的组不合并", () => {
  // 显式给根直属文件（graph() 只从边推文件，不含根组）。
  const files = ["README.md", "package.json", "src/a.js", "src/b.js", "tools/x.js", "tools/y.js"];
  const g = {
    edges: [
      { from: "src/a.js", to: "src/b.js" },
      { from: "tools/x.js", to: "tools/y.js" },
    ],
    external: new Map(),
  };
  const mods = partitionModules({ files, graph: g, maxFilesPerPage: 40, repoName: "demo" });
  const slugs = mods.map((m) => m.slug).sort();
  assert.deepEqual(slugs, ["root", "src", "tools"]);
  const root = mods.find((m) => m.slug === "root");
  assert.deepEqual(root.files.sort(), ["README.md", "package.json"]);
  assert.equal(root.title, "demo（仓库根）");
  const src = mods.find((m) => m.slug === "src");
  assert.deepEqual(src.files.sort(), ["src/a.js", "src/b.js"]);
});

test("兄弟组交叉边 ≥3 才合并（内聚判据要能口述，V2 人判用）", () => {
  // utils 与 src 之间 3 条边 → 合并成一个模块
  const strong = graph([
    { from: "src/a.js", to: "utils/u1.js" },
    { from: "src/b.js", to: "utils/u1.js" },
    { from: "src/a.js", to: "utils/u2.js" },
  ]);
  const merged = partitionModules({ ...strong, maxFilesPerPage: 40, repoName: "demo" });
  assert.equal(merged.length, 1, "3 条交叉边触发合并");
  // 只有 2 条边 → 各自独立
  const weak = graph([
    { from: "src/a.js", to: "utils/u1.js" },
    { from: "src/b.js", to: "utils/u1.js" },
  ]);
  const separate = partitionModules({ ...weak, maxFilesPerPage: 40, repoName: "demo" });
  assert.equal(separate.length, 2, "2 条边不合并");
});

test("超 max_files_per_page 的组逐级下切，叶子组仍超限按字典序切块", () => {
  const files = [];
  const edges = [];
  for (let i = 0; i < 7; i++) {
    files.push(`big/f${i}.js`);
    if (i > 0) edges.push({ from: "big/f0.js", to: `big/f${i}.js` });
  }
  const mods = partitionModules({ files, graph: { edges, external: new Map() }, maxFilesPerPage: 3, repoName: "demo" });
  const total = mods.reduce((sum, m) => sum + m.fileCount, 0);
  assert.equal(total, 7, "切分不丢文件");
  assert.ok(mods.every((m) => m.fileCount <= 3), "每块都不超上限");
  assert.ok(mods.length >= 3, "7 个文件、上限 3 → 至少 3 块");
  // slug 唯一（切块组的 #2 序号后缀避免撞名）
  const slugs = mods.map((m) => m.slug);
  assert.equal(new Set(slugs).size, slugs.length, "slug 无重复");
});

test("父链按目录包含取最近祖先（spec frontmatter.parents / DB parent_id 同源）", () => {
  const { files, graph: g } = graph([
    { from: "src/store/index.js", to: "src/store/util.js" },
    { from: "src/wiki/t0.js", to: "src/store/index.js" },
  ]);
  const mods = partitionModules({ files, graph: g, maxFilesPerPage: 40, repoName: "demo" });
  // 初稿是两级目录段：src/store、src/wiki；「src」本身不是组 → 无父链也合法，
  // 但 src/store 与 src/wiki 之间没有包含关系（同层），互不为父。
  const store = mods.find((m) => m.dir === "src/store");
  const wiki = mods.find((m) => m.dir === "src/wiki");
  assert.ok(store && wiki);
  assert.equal(store.parentSlug, null, "同级目录不是父子");
});

test("模块指纹随文件集/边集变化（DB 记账与过期检测的输入）", () => {
  const a = partitionModules({ ...graph([{ from: "src/a.js", to: "src/b.js" }]), maxFilesPerPage: 40, repoName: "d" });
  const b = partitionModules({
    files: ["src/a.js", "src/b.js", "src/c.js"],
    graph: { edges: [{ from: "src/a.js", to: "src/b.js" }], external: new Map() },
    maxFilesPerPage: 40,
    repoName: "d",
  });
  const fa = a.find((m) => m.slug === "src").fingerprint;
  const fb = b.find((m) => m.slug === "src").fingerprint;
  assert.notEqual(fa, fb, "文件集变了指纹必须变");
});

test("外部依赖按模块聚合（骨架页「外部依赖」一节的数据源）", () => {
  const files = ["src/a.js", "src/b.js", "lib/c.js"];
  const external = new Map([["left-pad", new Set(["src/a.js", "src/b.js"])]]);
  const mods = partitionModules({ files, graph: { edges: [], external }, maxFilesPerPage: 40, repoName: "d" });
  const src = mods.find((m) => m.dir === "src");
  assert.deepEqual(src.externalDeps, [{ pkg: "left-pad", count: 2 }]);
  const lib = mods.find((m) => m.dir === "lib");
  assert.deepEqual(lib.externalDeps, []);
});
