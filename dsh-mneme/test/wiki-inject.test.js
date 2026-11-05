// wiki/inject.js 的回归锁（M3 开局注入）。全部用例走真实 T0（fixture 仓库 apply）
// 建数据，不手插 DB 行——这一层测的正是「DB 索引 × cwd 反查」的对账。
// 锁的点：档位解析（含轻量档压成 off）、只注标题级、light 的 6 行上限与排序、
// 字符预算的逐行截断（不许半行）、空串语义（不注入 = 空串而非占位）、
// 渲染失败绝不抛、缓存随 updated_at 失效、转义只做在注入层。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runChoroT0 } from "../src/wiki/t0.js";
import { createStore } from "../src/store.js";
import { createChoroQueries } from "../src/wiki/queries.js";
import {
  createChoroInject,
  renderChoroBlock,
  resolveInjectTier,
  LIGHT_MODULE_LIMIT,
  MAX_BLOCK_CHARS
} from "../src/wiki/inject.js";
import { escapePromptVars } from "../src/user-settings.js";

const FIXED_NOW = () => "2026-11-05T00:00:00.000Z";

/** 造仓库：files = [[相对路径, 内容], ...]，返回根目录。 */
function makeFixture(files = null) {
  const root = mkdtempSync(join(tmpdir(), "choro-inject-"));
  const items = files ?? [
    ["package.json", JSON.stringify({ name: "ifix", scripts: { test: "node --test" } }, null, 2) + "\n"],
    ["src/a.js", 'import { b } from "./b.js";\nexport const a = () => b();\n'],
    ["src/b.js", 'import { b2 } from "./b2.js";\nexport const b = () => b2();\n'],
    ["src/b2.js", "export const b2 = () => 1;\n"]
  ];
  for (const [rel, content] of items) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init", "--no-gpg-sign"], { cwd: root, stdio: "pipe" });
  return root;
}

function rmTempBestEffort(dir) {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  console.warn("[wiki-inject.test] 临时目录清理未完成：" + dir);
}

function setup(config = {}, over = {}) {
  const root = makeFixture(over.files ?? null);
  const store = createStore(":memory:");
  runChoroT0({ repoRoot: root, store, apply: true, now: FIXED_NOW });
  const choro = createChoroQueries({ store });
  return { root, store, choro };
}

const ON = { chorographyEnabled: true, chorographyInject: "light" };

test("resolveInjectTier：总闸关 / 轻量档 / 非法值 / 缺省的四条口径", () => {
  assert.equal(resolveInjectTier(null), "off");
  assert.equal(resolveInjectTier({}), "off", "chorographyEnabled 默认关 → 不注入");
  assert.equal(resolveInjectTier({ chorographyEnabled: false }), "off");
  assert.equal(resolveInjectTier({ chorographyEnabled: true }), "light", "缺 chorographyInject 时按 light");
  assert.equal(resolveInjectTier({ chorographyEnabled: true, chorographyInject: "full" }), "full");
  assert.equal(resolveInjectTier({ chorographyEnabled: true, chorographyInject: "off" }), "off");
  assert.equal(resolveInjectTier({ chorographyEnabled: true, chorographyInject: "bogus" }), "light", "非法值退回缺省，不静默关掉");
  // 轻量档在消费侧压成 off：LIGHT_MODE_OFF 对平铺键赋 false，枚举键进不去（P26）
  assert.equal(resolveInjectTier({ chorographyEnabled: true, lightMode: true }), "off");
  assert.equal(resolveInjectTier({ chorographyEnabled: false, lightMode: false }), "off");
});

test("renderChoroBlock：只注标题级，模块名 / 文件数 / 页状态 / 页相对路径都在，正文一个字都不带", () => {
  const { root, store, choro } = setup(ON);
  try {
    const repo = choro.repoByCwd(root);
    const block = renderChoroBlock(choro.outline(repo.id), "full", "zh");
    assert.ok(block.includes("[仓库地志]"), "有块头");
    assert.ok(block.includes("ifix"), "仓库名");
    assert.ok(block.includes("生成于 2026-11-05"), "生成日期：地志是快照不是真相，读者得知道它可能是旧的");
    assert.ok(block.includes(".chorography/modules/src.md"), "页相对路径");
    assert.ok(block.includes("（3 文件）"), "文件数");
    // 「只注标题级」的机制锁：正文的节标题与说明行一个字都不许出现在注入块里
    assert.equal(block.includes("## 文件清单"), false);
    assert.equal(block.includes("确定性骨架"), false);
    assert.equal(block.includes("| 文件 |"), false);
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("renderChoroBlock：light 只列 6 行并明说还有几个，full 列全表", () => {
  // 9 个目录 → 9 个模块，超过 light 的 6 行上限
  const files = [["package.json", JSON.stringify({ name: "bigfix" }) + "\n"]];
  for (let i = 0; i < 9; i++) files.push([`p${i}/index.js`, `export const v${i} = ${i};\n`]);
  const { root, store, choro } = setup(ON, { files });
  try {
    const repo = choro.repoByCwd(root);
    const outline = choro.outline(repo.id);
    assert.ok(outline.modules.length >= LIGHT_MODULE_LIMIT + 1, "夹具要多于上限才测得出截断");
    const light = renderChoroBlock(outline, "light", "zh");
    const lightLines = light.split("\n");
    assert.equal(lightLines.length, LIGHT_MODULE_LIMIT + 2, "块头 1 + 模块 6 + 「还有 N 个」1");
    assert.ok(light.includes("另有 " + (outline.modules.length - LIGHT_MODULE_LIMIT) + " 个模块"), "静默截断比明说更坏");
    const full = renderChoroBlock(outline, "full", "zh");
    assert.equal(full.includes("另有"), false, "full 不该有截断提示");
    assert.equal(full.split("\n").length, outline.modules.length + 1);
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("renderChoroBlock：字符预算逐行截断，绝不切出半行", () => {
  // 造足够多的模块让 full 撞 6000 字符上限
  // 60 个「长名」模块就够撞上限：slug 取自目录名，目录名越长每条提纲行越长，
  // 比堆 400 个短名文件快一个数量级（夹具成本不该压在 T0 的 git 扫描上）。
  const files = [["package.json", JSON.stringify({ name: "hugefix" }) + "\n"]];
  const longName = "very-deep-directory-name-that-keeps-going-for-quite-a-while-indeed";
  for (let i = 0; i < 60; i++) files.push([`mod-${i}/${longName}/index.js`, `export const v = ${i};\n`]);
  const { root, store, choro } = setup(ON, { files });
  try {
    const repo = choro.repoByCwd(root);
    const block = renderChoroBlock(choro.outline(repo.id), "full", "zh");
    assert.ok(block.length <= MAX_BLOCK_CHARS.full, "不超预算：" + block.length);
    assert.ok(block.length > 0);
    for (const line of block.split("\n")) {
      assert.equal(line.startsWith("- ") || line.startsWith("["), true, "每一行都是完整的一行：" + line.slice(0, 40));
    }
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("renderChoroBlock：空提纲 / 空模块返回空串（不注入 = 空串，宿主会过滤掉不占位）", () => {
  assert.equal(renderChoroBlock(null, "light", "zh"), "");
  assert.equal(renderChoroBlock({ repo: { name: "x" }, modules: [] }, "light", "zh"), "");
  assert.equal(renderChoroBlock({ repo: { name: "x" } }, "light", "zh"), "");
});

test("createChoroInject：按 cwd 命中仓库才出块，未命中与总闸关都是空串", () => {
  const { root, store, choro } = setup(ON);
  try {
    const on = createChoroInject({ choro, config: ON, language: () => "zh" });
    assert.equal(on.tier, "light");
    assert.ok(on.text(root).includes("[仓库地志]"));
    assert.ok(on.text(join(root, "src")).includes("[仓库地志]"), "子目录也命中");
    assert.equal(on.text(join(root, "no-such-dir")), "", "不存在的 cwd → 空串");
    assert.equal(on.text(null), "", "没有 cwd → 空串");
    const off = createChoroInject({ choro, config: { chorographyEnabled: false } });
    assert.equal(off.text(root), "", "总闸关 → 空串");
    const noChoro = createChoroInject({ choro: null, config: ON });
    assert.equal(noChoro.text(root), "", "没有读侧对象也不抛");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("createChoroInject：渲染异常绝不抛，退化成空串", () => {
  const warnings = [];
  const boom = {
    repoByCwd: () => ({ id: 1, updated_at: "2026-11-05T00:00:00.000Z" }),
    outline: () => {
      throw new Error("db is gone");
    }
  };
  const inject = createChoroInject({
    choro: boom,
    config: ON,
    logger: { warn: (m) => warnings.push(m) },
    language: () => "zh"
  });
  assert.equal(inject.text("/whatever"), "", "附属信息块不能把整轮 systemPrompt 搞崩");
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("db is gone"));
});

test("createChoroInject：每轮查一次库取缓存键（不 fork git），同键不重渲染，换语言换键", () => {
  const { root, store, choro } = setup(ON);
  try {
    let lang = "zh";
    let calls = 0;
    const spy = {
      repoByCwd: (cwd) => choro.repoByCwd(cwd),
      outline: (id) => {
        calls += 1;
        return choro.outline(id);
      }
    };
    const inject = createChoroInject({ choro: spy, config: ON, language: () => lang });
    const first = inject.text(root);
    const second = inject.text(root);
    // 键要含页级生成时间，所以每轮必须查一次库——这是索引查询（几十微秒），
    // 不是 P29 要避开的 fork git / stat 磁盘。这里锁的就是「查库了，但没重渲染」：
    // 两次返回逐字节相同，说明缓存在生效而不是每次重新拼。
    assert.equal(calls, 2, "每轮查一次库取缓存键");
    assert.equal(second, first, "同一个键命中缓存，渲染结果一致");
    lang = "en";
    const en = inject.text(root);
    assert.equal(calls, 3, "换语言换键");
    assert.ok(en.includes("[Repo atlas]"));
    inject.dispose();
    assert.equal(inject.text(root).includes("[Repo atlas]"), true, "dispose 后仍能重算（只是丢了缓存）");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});

test("createChoroInject：注入层的文本过 escapePromptVars，名字里的花括号不许崩宿主装配", () => {
  const outline = {
    repo: { id: 1, name: "weird{{name}}repo", updatedAt: "2026-11-05T00:00:00.000Z" },
    generatedAt: "2026-11-05T00:00:00.000Z",
    modules: [{ slug: "a", title: "m{{x}}", fileCount: 1, parentSlug: null, status: "skeleton", relPath: ".chorography/modules/a.md" }]
  };
  const fake = { repoByCwd: () => ({ id: 1, updated_at: "2026-11-05T00:00:00.000Z" }), outline: () => outline };
  const inject = createChoroInject({ choro: fake, config: ON, language: () => "zh" });
  const text = inject.text("/x");
  // 契约不是「转义成某个具体形态」，而是「转义后不再留下任何成对花括号」：宿主
  // 的 interpolate() 只认 /\{\{([^{}]*)\}\}/，只要 {{ 与 }} 都不成对出现，
  // 就永远不会被当成变量引用。所以锁这两个子串，不锁反斜杠落在哪一格。
  assert.equal(text.includes("{{"), false, "残留 {{ 会让宿主 interpolate 抛错崩整轮装配");
  assert.equal(text.includes("}}"), false, "残留 }} 同上");
  // 与转义函数逐字节一致：注入层是唯一做转义的地方，别的层不许再包一层。
  assert.equal(text, escapePromptVars(ON, renderChoroBlock(outline, "light", "zh")));
  // 未转义的渲染函数本身保持原样——/choro 的 UI 回执不进宿主模板，转义了反而难看
  assert.ok(renderChoroBlock(outline, "light", "zh").includes("{{name}}"));
});

// T1 富化只推 choro_pages.generated_at，不动 choro_repos.updated_at（store.js:
// markChoroPageEnriched 的注释写明「T0 整仓替换与 T1 页级富化并存」）。缓存键若挂
// 在仓库行上，用户刚跑完 `--t1 --apply`，注入块还会写着「骨架」而 /choro（无缓存）
// 已经报「已有语义段」——两个面说同一件事却给出不同答案。所以锁这条：页级状态一变，
// 下一轮的注入块必须跟着变，且不是靠 dispose / 重启。
test("createChoroInject：T1 富化只推页级 generated_at，缓存也必须失效（不能停在「骨架」）", () => {
  const { root, store, choro } = setup(ON);
  try {
    const inject = createChoroInject({ choro, config: ON, language: () => "zh" });
    const before = inject.text(root);
    assert.equal(before.includes("已有语义段"), false, "富化前不该出现 enriched 标签");
    const repo = choro.repoByCwd(root);
    const repoRowBefore = store.choroRepoByRoot(root);
    const page = store.choroPageBySlug(repo.id, "src");
    assert.ok(page, "夹具必须切出 src 模块，否则这条用例测的是空气");
    store.markChoroPageEnriched(page.id, "2026-11-06T09:00:00.000Z");
    // 前提断言：富化确实没有碰仓库行——不然这条用例会假绿（更新的是 updated_at 也就命中）
    assert.equal(store.choroRepoByRoot(root).updated_at, repoRowBefore.updated_at, "T1 富化不该动 choro_repos.updated_at");
    const after = inject.text(root);
    assert.equal(after.includes("已有语义段"), true, "页级生成时间变了，注入块必须重算");
  } finally {
    store.close();
    rmTempBestEffort(root);
  }
});
