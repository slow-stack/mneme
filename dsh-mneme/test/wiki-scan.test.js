// scan.js 的回归锁：文件清单（默认排除 / gitignore 子集 / include 白名单）与
// import 图（ESM 静态/动态、CJS、Vue SFC、外部包聚合、builtin 过滤、unresolved 记账）。
// 锁的回归类型：正则提取器在「副作用 import / 再导出 / 多行 import」上漏边；
// glob 在无斜杠模式上漏掉任意层级语义；解析失败必须记 skipped 而不是中断（spec 降级表）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFiles, parseImportGraph, compileExclude, compileInclude, readRootPackage, workspacePrefixes } from "../src/wiki/scan.js";

function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), "choro-scan-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return root;
}

test("文件清单：默认排除 node_modules/.git/dist 与二进制/锁文件", () => {
  const root = makeRepo({
    "src/a.js": "export const a = 1;\n",
    "node_modules/pkg/index.js": "module.exports = 1;\n",
    "dist/bundle.js": "var a=1;\n",
    "logo.png": "binary-ish",
    "package-lock.json": "{}",
    "README.md": "# x\n",
    ".git/config": "",
  });
  try {
    assert.deepEqual(listFiles(root), ["README.md", "src/a.js"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("文件清单：.gitignore 子集——无斜杠模式命中任意层级，锚定模式只命中根部", () => {
  const root = makeRepo({
    "keep.js": "",
    "docs/readme.md": "",
    "docs/inner/notes.md": "",
    "build/out.js": "",
    "sub/build/out.js": "",
    "vendor/v.js": "",
  });
  try {
    const m = compileExclude(["*.md", "build", "/vendor"]);
    assert.equal(m.excludedFile("docs/readme.md"), true, "*.md 命中任意层级");
    assert.equal(m.excludedFile("docs/inner/notes.md"), true);
    assert.equal(m.excludedFile("keep.js"), false);
    assert.equal(m.excludedFile("build/out.js"), true, "目录级排除连带文件");
    assert.equal(m.excludedFile("sub/build/out.js"), true, "无斜杠目录名也是任意层级");
    assert.equal(m.excludedFile("vendor/v.js"), true, "前导 / 锚定到根");
    const inc = compileInclude(["docs"]);
    assert.equal(inc.matchesFile("docs/readme.md"), true);
    assert.equal(inc.matchesFile("src/a.js"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("文件清单：include 白名单非空时只留命中的文件", () => {
  const root = makeRepo({ "src/a.js": "", "docs/b.md": "", "c.js": "" });
  try {
    const files = listFiles(root, { exclude: [] });
    const inc = compileInclude(["src/**"]);
    const kept = files.filter((f) => inc.matchesFile(f));
    assert.deepEqual(kept, ["src/a.js"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import 图：ESM 静态/副作用/动态/再导出、CJS、多行 import 全部成边", () => {
  const root = makeRepo({
    "src/a.js": [
      "import b, { c } from \"./b.js\";",
      "import {",
      "  long,",
      "  multi,",
      "} from \"./multi.js\";",
      "import \"./side-effect.js\";",
      "const lazy = () => import(\"./lazy.js\");",
      "export * from \"./reexport.js\";",
      "const legacy = require(\"./legacy.js\");",
      "import path from \"node:path\";",
      "import fp from \"lodash/fp\";",
      "import { deep } from \"@scope/pkg/sub\";",
      "import { gone } from \"./no-such-file.js\";",
    ].join("\n"),
    "src/b.js": "export default 1;\n",
    "src/multi.js": "export const long = 1;\nexport const multi = 2;\n",
    "src/side-effect.js": "",
    "src/lazy.js": "",
    "src/reexport.js": "",
    "src/legacy.js": "",
  });
  try {
    const files = listFiles(root);
    const graph = parseImportGraph(root, files);
    const from = (to) => graph.edges.filter((e) => e.from === "src/a.js" && e.to === to).length;
    assert.equal(from("src/b.js"), 1);
    assert.equal(from("src/multi.js"), 1, "多行 import 也要成边");
    assert.equal(from("src/side-effect.js"), 1, "副作用 import 成边");
    assert.equal(from("src/lazy.js"), 1, "动态 import 成边");
    assert.equal(from("src/reexport.js"), 1, "再导出成边");
    assert.equal(from("src/legacy.js"), 1, "CJS require 成边");
    assert.ok(!graph.edges.some((e) => e.from === "src/a.js" && e.to.includes("node:path")), "node builtin 不成边");
    assert.ok(graph.external.has("lodash"), "裸说明符按包名聚合");
    assert.ok(graph.external.has("@scope/pkg"), "scoped 包取两段");
    assert.ok(graph.external.has("path") === false, "builtin 不进外部依赖");
    assert.deepEqual(graph.unresolved, [{ from: "src/a.js", spec: "./no-such-file.js" }], "解析失败记账不中断");
    assert.equal(graph.skipped.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import 图：Vue SFC 的 <script> 块参与成边，模板部分不参与", () => {
  const root = makeRepo({
    "comp/App.vue": [
      "<template>",
      "  <div :src=\"'./not-a-module.js'\"></div>",
      "</template>",
      "<script>",
      "import helper from \"../src/helper.js\";",
      "export default { components: {} };",
      "</script>",
    ].join("\n"),
    "src/helper.js": "export default 1;\n",
  });
  try {
    const graph = parseImportGraph(root, listFiles(root));
    assert.ok(graph.edges.some((e) => e.from === "comp/App.vue" && e.to === "src/helper.js"));
    assert.ok(!graph.edges.some((e) => e.from === "comp/App.vue" && e.to.includes("not-a-module")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import 图：读不了/解析不了的文件记 skipped，不中断整轮", () => {
  const root = makeRepo({ "ok.js": "import \"./x.js\";", "x.js": "" });
  try {
    // 制造一个清单里存在、磁盘上读不到的文件路径（直接喂给解析器，绕过 listFiles）
    const graph = parseImportGraph(root, ["ok.js", "x.js", "gone/broken.js"]);
    assert.equal(graph.skipped.some((s) => s.file === "gone/broken.js"), true);
    assert.ok(graph.edges.length >= 1, "其他文件不受影响");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package.json：scripts/entries/workspaces 收口，坏 JSON 返回 null 不抛", () => {
  const root = makeRepo({
    "package.json": JSON.stringify({
      name: "demo",
      main: "./lib/index.js",
      bin: { demo: "./bin/demo.mjs" },
      exports: { ".": "./lib/main.js" },
      scripts: { test: "node --test" },
      workspaces: ["packages/*", "apps/web"],
    }),
    "broken.js": "",
  });
  try {
    const pkg = readRootPackage(root);
    assert.equal(pkg.name, "demo");
    assert.deepEqual(pkg.scripts, { test: "node --test" });
    assert.ok(pkg.entries.includes("lib/index.js"));
    assert.ok(pkg.entries.includes("bin/demo.mjs"));
    assert.ok(pkg.entries.includes("lib/main.js"));
    // workspacePrefixes 返回排序数组（确定性口径，与文件清单同规矩）
    assert.deepEqual(workspacePrefixes(pkg.workspaces), ["apps/web", "packages"]);
    writeFileSync(join(root, "package.json"), "{oops", "utf8");
    assert.equal(readRootPackage(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
