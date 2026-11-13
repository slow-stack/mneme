import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIRROR_EXCLUDED_TYPES, MIRROR_READONLY_TYPES, TYPE_FILE, createMirror, parseHumanEdits, renderMirrorText } from "../src/mirror.js";
import { createStore, TYPES } from "../src/store.js";
import { createService } from "../src/service.js";
import { PACKAGE_VERSION } from "../src/version-check.js";
import { testConfig } from "./helpers/test-config.js";

// #278 第一批：落盘盲区。TYPE_FILE 原先只有 5 个键，pitfall / constraint /
// rejected_solution / pattern 这些后加的 type 从不进镜像与导出——落点存在，但对
// 一半活跃记忆是盲的，且没有任何提示。#296 第二批把 document 也收了进来（只读
// 指针视图），排除集因此为空；两个集合的边界仍由下面的双向断言钉住。
const FORMERLY_UNCOVERED = ["pitfall", "constraint", "rejected_solution", "pattern"];

function tempDir() {
  return mkdtempSync(join(tmpdir(), "dsh-mneme-types-"));
}

function memory(type, over = {}) {
  return {
    id: "m1", type, title: "标题", content: "内容", tags: ["a"], importance: 3,
    forgotten: false, created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z", ...over
  };
}

test("#278: every store type has a landing point except the pinned exclusions", () => {
  const missing = [...TYPES].filter((t) => !TYPE_FILE[t] && !MIRROR_EXCLUDED_TYPES.has(t));
  assert.deepEqual(missing, [], "新增 type 必须显式决定落不落镜像，不能留下静默盲区");
  assert.deepEqual(Object.keys(TYPE_FILE).filter((t) => !TYPES.has(t)), [], "TYPE_FILE 不得含 store 不认识的键");
  assert.deepEqual([...MIRROR_EXCLUDED_TYPES].filter((t) => !TYPES.has(t)), [], "排除集里的 key 必须是真 type");
  // 双向：注释说的「TYPES \ TYPE_FILE 恰好等于排除集」要真被钉住。只查上面两条
  // 的话，将来有人把 document 加进 TYPE_FILE 却忘了从排除集删，两边同时变假还全绿。
  assert.deepEqual([...MIRROR_EXCLUDED_TYPES].filter((t) => TYPE_FILE[t]), [], "排除集与落盘集不得重叠");
  for (const type of FORMERLY_UNCOVERED) {
    assert.ok(TYPE_FILE[type], `${type} 必须有镜像文件（#278 第一批验收项）`);
  }
});

test("#278: an entry of a formerly uncovered type survives render → parse round-trip", () => {
  const text = renderMirrorText("pitfall", [memory("pitfall")]);
  const [edit] = parseHumanEdits(text);
  assert.equal(edit.id, "m1");
  assert.equal(edit.title, "标题");
  assert.equal(edit.content, "内容", "frontmatter 与元数据行都不得进 content");
  assert.equal(edit.updated_at, "2026-01-01T00:00:00.000Z");
});

test("#278: file header carries type / covered / coverage / tags union", () => {
  const text = renderMirrorText("constraint", [
    memory("constraint", { id: "m2", tags: ["z", "a"], updated_at: "2026-02-01T00:00:00.000Z" }),
    memory("constraint", { id: "m1", tags: ["a", "m"] })
  ]);
  assert.ok(text.startsWith("---\n"), "frontmatter 必须在文件最前");
  const fm = text.slice(4, text.indexOf("\n---", 3));
  assert.match(fm, /^type: constraint$/m);
  // OKF §7 actor 约定：<producer>/<version>，不是裸的 producer 名
  assert.equal(fm.match(/^generated\.by: (.+)$/m)?.[1], `dsh-mneme/${PACKAGE_VERSION}`);
  assert.match(fm, /^generated\.at: \d{4}-\d{2}-\d{2}T/m);
  assert.match(fm, /^covered: 2$/m);
  assert.match(fm, /^coverage: active-only$/m);
  assert.match(fm, /^tags: \["a", "m", "z"\]$/m);
  // frontmatter 不是条目、也不改条目数
  assert.equal(parseHumanEdits(text).length, 2);
});

test("#278/#296: mirror writes the formerly uncovered files, and documents land as a pointer view", () => {
  const dir = tempDir();
  try {
    const mirror = createMirror(dir);
    const rows = FORMERLY_UNCOVERED.map((type, i) => memory(type, { id: `m${i}`, content: `内容${i}` }));
    rows.push(memory("document", {
      id: "doc1", title: "报告", content: "第一句。第二句不该出现。", doc_path: "C:/docs/report.md"
    }));
    mirror.sync(rows);
    for (const [i, type] of FORMERLY_UNCOVERED.entries()) {
      const file = join(dir, TYPE_FILE[type]);
      assert.ok(existsSync(file), `${TYPE_FILE[type]} 必须落盘`);
      const [edit] = parseHumanEdits(readFileSync(file, "utf8"));
      assert.equal(edit.id, `m${i}`);
      assert.equal(edit.content, `内容${i}`);
    }
    // #296 第 4 条：document 落盘，但只给指针行——id + 标题 + 摘要首句 + 路径，
    // 不含正文；文件头必须说清这是只读视图（不能复用「可编辑」那句）。
    assert.ok(MIRROR_READONLY_TYPES.has("document"), "document 是只读 type");
    assert.ok(existsSync(join(dir, "documents.md")), "document 指针行现在落盘");
    const docs = readFileSync(join(dir, "documents.md"), "utf8");
    assert.match(docs, /只读视图/);
    assert.ok(docs.includes("doc1") && docs.includes("报告") && docs.includes("第一句"));
    assert.ok(docs.includes("report.md"), "指针行必须给出 doc_path，否则「看着完整、其实找不到文件」的老问题原样回来");
    assert.ok(!docs.includes("第二句"), "只读视图不含全文，只留摘要首句");
    assert.equal(parseHumanEdits(docs).length, 0, "指针行不是可回填的条目");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#296: readHumanEdits never returns the read-only type — a hand-edited view cannot reach the store", () => {
  const dir = tempDir();
  try {
    const mirror = createMirror(dir);
    mirror.sync([memory("document", { id: "doc1", doc_path: "/tmp/report.md" })]);
    // 模拟有人在 documents.md 里手改（视图是机器所有，改动必须被忽略而不是回填）
    const file = join(dir, TYPE_FILE.document);
    writeFileSync(file, readFileSync(file, "utf8") + "- **ID**: `doc1`\n- **类型**: document\n被人改过的正文\n", "utf8");
    assert.deepEqual(mirror.readHumanEdits("document"), [], "指定的只读 type 也要跳过");
    assert.deepEqual(mirror.readHumanEdits().filter((e) => e.id === "doc1"), [], "全量扫描同样跳过它");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#278: mirror covers every active row — no silent 500-row truncation", () => {
  const dir = tempDir();
  let store;
  try {
    store = createStore(join(dir, "memory.db"));
    const service = createService({ store, mirror: createMirror(dir), config: testConfig({}) });
    for (let i = 0; i < 501; i++) store.save({ type: "pitfall", title: `t${i}`, content: `c${i}` });
    // 任意一次业务写触发一次镜像同步（不是逐条 save，避免 501 次渲染）
    service.saveWithDedupe({ type: "pattern", title: "trigger", content: "x" });
    const text = readFileSync(join(dir, TYPE_FILE.pitfall), "utf8");
    assert.match(text, /^covered: 501$/m, "文件头必须如实自述覆盖条数");
    assert.equal((text.match(/^- \*\*ID\*\*: /gm) ?? []).length, 501, "超过 500 条的活跃集必须全部落盘");
    assert.equal(parseHumanEdits(text).length, 501);
  } finally {
    // close 必须在 rm 之前：Windows 上库文件仍被打开时 rmSync 会 EPERM，把断言
    // 失败覆盖成文件锁错误。
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#278: scope / sensitivity 只作展示字段，且永不进 content", () => {
  const text = renderMirrorText("constraint", [memory("constraint", {
    agent_scope: "standard",
    workspace_scope: "D:/WorkSpace/demo",
    sensitivity: "personal"
  })]);
  assert.match(text, /^- \*\*作用域\*\*: standard \/ D:\/WorkSpace\/demo$/m);
  assert.match(text, /^- \*\*敏感度\*\*: personal$/m);
  assert.equal(parseHumanEdits(text)[0].content, "内容", "新字段不得进 content");
  // 没值的条目不该多出空字段行（本机 2843 条里只有 37 条带 scope 标签）
  const bare = renderMirrorText("constraint", [memory("constraint")]);
  assert.ok(!bare.includes("作用域") && !bare.includes("敏感度"));
  // 值是调用方传的任意字符串：里面的换行不得伪造出第二个条目头
  const injected = renderMirrorText("constraint", [memory("constraint", {
    sensitivity: "x\n- **ID**: `ghost`\n- **类型**: decision"
  })]);
  assert.equal(parseHumanEdits(injected).length, 1, "值里的换行不得造出幽灵条目");
  // 值本身仍在（被压成一行），关键是它不再位于行首——行首才是条目头的锚
  assert.ok(!/^- \*\*ID\*\*: `ghost`/m.test(injected), "不得出现伪造的条目头");
});

test("#278: mirror keeps its active-only claim — archived and forgotten rows stay out", () => {
  const dir = tempDir();
  let store;
  try {
    store = createStore(join(dir, "memory.db"));
    const service = createService({ store, mirror: createMirror(dir), config: testConfig({}) });
    // forgotten 在 INSERT 里硬编码为 0（store.js insertMemoryRow），只能经 setForget
    // 设置；archived 可以在载荷里给，这里统一走 setter 保持同一个路径。
    for (const [id, title] of [["keep-c", "留"], ["arch-c", "归档"], ["gone-c", "遗忘"]]) {
      store.save({ id, type: "constraint", title, content: "c" });
    }
    store.setArchived("arch-c", true);
    store.setForget("gone-c", true);
    service.saveWithDedupe({ type: "pattern", title: "trigger", content: "x" });
    const text = readFileSync(join(dir, TYPE_FILE.constraint), "utf8");
    // 文件头写 coverage: active-only，正文就必须只有活跃行——说一套写一套比没有
    // 这个字段更糟（外部工具照着聚合）。
    assert.match(text, /^covered: 1$/m, "覆盖条数只数活跃行");
    assert.ok(text.includes("keep-c"));
    assert.ok(!text.includes("arch-c"), "归档行不进镜像");
    assert.ok(!text.includes("gone-c"), "遗忘行不进镜像");
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#278: re-syncing unchanged content does not rewrite the file", () => {
  const dir = tempDir();
  try {
    const mirror = createMirror(dir);
    const rows = [memory("pitfall"), memory("constraint", { id: "m2" })];
    mirror.sync(rows);
    const first = readFileSync(join(dir, TYPE_FILE.pitfall), "utf8");
    const firstAt = first.match(/^generated\.at: (.+)$/m)[1];
    // generated.at 每次渲染都是新时间戳：无脑落盘会让编辑器、同步盘与 git 在每次
    // 业务写后都看到全部镜像「被外部修改」，而内容一字未变。
    mirror.sync(rows);
    const second = readFileSync(join(dir, TYPE_FILE.pitfall), "utf8");
    assert.equal(second, first, "内容未变的文件不得被重写");
    assert.equal(second.match(/^generated\.at: (.+)$/m)[1], firstAt, "未变时保留原时间戳");
    // 内容真变了必须落盘
    mirror.sync([memory("pitfall", { content: "改了" })]);
    const third = readFileSync(join(dir, TYPE_FILE.pitfall), "utf8");
    assert.notEqual(third, second);
    assert.ok(third.includes("改了"));
    // 顺手确认「空 type 删文件」这条防复活行为没被上面的跳过逻辑带坏
    assert.ok(!existsSync(join(dir, TYPE_FILE.constraint)), "该 type 没行时文件要删掉");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
