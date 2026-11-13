import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createMirror } from "../src/mirror.js";
import { testConfig } from "./helpers/test-config.js";

// 回归（issue #430）：写路径上的全表物化。此前每一次业务写都要走两处
// all() + 逐行 toRow（27 字段 + 三次 JSON.parse）：
//   1. 质量过滤的近重复判定只要最近 20 条 content，却先物化整库再 slice(0,20)
//      （5k 行实测 100ms 级 → 本批换成单列有界查询后 0.06ms 级）；
//   2. syncMirror 先物化整库再逐行 filter 掉 archived/forgotten/document。
// 本批修复：store 新增单列有界读 recentContents()；list() 两条分支的 SELECT *
// 换成显式列清单（memoryColumns，排除 embedding）；syncMirror 改走 list 的无界
// 档 + SQL 侧过滤。下面四条锁不测墙钟（CI 矩阵 ubuntu+windows × node 22/24 并行，
// 计时断言不稳），锁的是「谁被物化」这个形状本身。

function make(over = {}) {
  const store = createStore(":memory:");
  return { store, config: testConfig({ memoryQualityFilter: { enabled: true }, ...over }) };
}

test("#430: recentContents mirrors the all() prefix it replaced", () => {
  const { store } = make();
  for (let i = 0; i < 25; i += 1) {
    store.save({ type: "project", title: `t${i}`, content: `c${i}`, importance: 3 });
  }
  // 旧写法：all().slice(0, 20).map((m) => m.content ?? "")。集合锁与逐位锁都要：
  // 一旦把 ORDER BY 丢掉（或反向），只要 LIMIT 不低于表行数，取到的行一个不少、
  // 只是顺序全反过来，集合锁抓不到这类回归（变异检验证实，见 PR 讨论）。
  // 逐位比较在此安全：store.js 的 per-instance 单调时间戳守卫保证同一实例内
  // updated_at 严格递增，故这几行的先后关系是确定的。
  const expected = store.all().slice(0, 20).map((m) => m.content ?? "");
  const actual = store.recentContents(20);
  assert.equal(actual.length, 20);
  assert.deepEqual(actual, expected, "same 20 contents in the same order as the old prefix");
  assert.deepEqual([...actual].sort(), [...expected].sort(), "same 20 contents as the old prefix (order-agnostic backstop)");
  assert.equal(store.recentContents().length, 20, "default limit is 20");
  assert.equal(store.recentContents(3).length, 3);
  // sanitizePage 口径：0 / 负数 / 非整数落回默认值，而不是 SQLite 里 LIMIT 无界
  assert.equal(store.recentContents(0).length, 20, "limit 0 falls back to the default, never unbounded");
  assert.equal(store.recentContents(-1).length, 20);
  assert.equal(store.recentContents(undefined).length, 20);
  // 口径与 all() 一致：不过滤 archived（近重复判定要连归档内容一起看）
  const { id } = store.save({ type: "project", title: "旧", content: "归档正文", importance: 3 });
  store.setArchived(id, true);
  assert.ok(store.recentContents(20).includes("归档正文"), "archived rows still take part in near-duplicate detection");
  // 空库不炸
  const fresh = createStore(":memory:");
  assert.deepEqual(fresh.recentContents(20), []);
  store.close();
  fresh.close();
});

test("#430: list() projects columns and never leaks embedding", () => {
  const { store } = make();
  const { id } = store.save({ type: "project", title: "带向量", content: "正文", importance: 3 });
  store.setEmbedding(id, [1, 0, 0]);
  for (const opts of [{ limit: 50 }, { limit: null }, { order: "chrono", limit: 10 }, { type: "project", limit: null }]) {
    const rows = store.list(opts);
    assert.ok(rows.length > 0, `list(${JSON.stringify(opts)}) returned rows`);
    for (const row of rows) {
      assert.equal("embedding" in row, false, `embedding never leaks into list rows (${JSON.stringify(opts)})`);
      assert.equal(typeof row.content, "string", "content still projected");
    }
  }
  store.close();
});

test("#430: the write path reads explicit, bounded columns (no SELECT *, no embedding)", () => {
  const { store } = make();
  store.save({ type: "project", title: "带向量", content: "正文", importance: 3 });
  // 语句级探针（不测墙钟）：SELECT * 会把全表最重的 embedding 列拖进内存再被
  // toRow 丢掉，且无界档实测 5k 行 263ms → 117ms。这里直接看发出去的 SQL——
  // 将来谁把列投影改回 SELECT *（或手工把 embedding 加回清单），本锁立刻转红，
  // 而「行里没有 embedding」那条锁抓不到这种回归（toRow 本就不输出向量）。
  const seen = [];
  const orig = store.db.prepare.bind(store.db);
  store.db.prepare = (sql) => { seen.push(String(sql)); return orig(sql); };
  const listSql = seen.length;
  store.list({ limit: 50 });
  store.list({ limit: null });
  store.list({ type: "project", limit: 10, order: "chrono" });
  const probed = seen.length - listSql;
  assert.ok(probed >= 3, `expected three distinct list queries, saw ${probed}`);
  for (const sql of seen) {
    assert.ok(!/SELECT\s+\*/i.test(sql), `write path must project explicit columns: ${sql}`);
    assert.ok(!/\bembedding\b/.test(sql), `write path must not read the embedding column: ${sql}`);
  }
  // 质量过滤那条单列读同样要探：它一旦退回 SELECT *，多读的正是全表最重的列。
  seen.length = 0;
  store.recentContents(20);
  assert.equal(seen.length, 1, "recentContents issues exactly one query");
  assert.ok(!/SELECT\s+\*/i.test(seen[0]), `recentContents must read one column: ${seen[0]}`);
  assert.ok(!/\bembedding\b/.test(seen[0]), "recentContents must not read the embedding column");
  assert.match(seen[0], /\bLIMIT\b/i, `recentContents must stay bounded: ${seen[0]}`);
  store.close();
});

test("#430: quality filter reads recent contents without materializing the table", () => {
  const { store, config } = make();
  // 抛错探针（先例 audit.test.js:182、mirror-dirty.test.js:383）：写路径一旦再退回
  // all()，本用例立刻失败，而不是等到某个 profile 上再被观测到。
  store.all = () => { throw new Error("write path must not materialize the whole table"); };
  const service = createService({ store, mirror: null, config });
  const base = "今天下午去操场跑步三圈然后回来洗澡";
  const first = service.saveWithDedupe({ type: "history", title: "记录A", content: base });
  assert.equal(first.action, "created");
  const second = service.saveWithDedupe({ type: "history", title: "记录B", content: `${base}${base}${base}` });
  const row = store.getById(second.memory.id);
  assert.equal(row.archived, true, "near-duplicate still archived");
  assert.ok(row.tags.includes("low_quality"), "low_quality tag still added");
  assert.ok(row.quality_score < 30, `score still below the archive threshold: ${row.quality_score}`);
});

test("#430: syncMirror covers the active set without materializing it", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-430-"));
  try {
    const { store, config } = make();
    const mirror = createMirror(dir);
    // 先按正常路径写一次，把镜像文件建起来
    const seed = createService({ store, mirror, config });
    const a = store.save({ type: "project", title: "活跃项目", content: "项目正文", importance: 3 });
    store.save({ type: "preference", title: "偏好", content: "偏好正文", importance: 3 });
    const hidden = store.save({ type: "project", title: "归档项目", content: "归档正文", importance: 3 });
    store.setArchived(hidden.id, true);
    const held = store.save({ type: "project", title: "遗忘项目", content: "遗忘正文", importance: 3 });
    store.setForget(held.id, true);
    seed.saveWithDedupe({ type: "project", title: "触发同步", content: "第一次触发同步的正文，长度足够不触发短内容规则", importance: 3 });

    // 写路径不得再出现全表物化
    store.all = () => { throw new Error("syncMirror must not materialize the whole table"); };
    const svc = createService({ store, mirror, config });
    const res = svc.saveWithDedupe({ type: "project", title: "第二次触发", content: "第二次触发同步的正文，内容与上一句不同以免被判近重复", importance: 3 });
    assert.equal(res.action, "created");
    assert.equal(res.memory.archived, false, "quality filter left it active (mirror only renders active rows)");

    const text = readFileSync(join(dir, "projects.md"), "utf8");
    assert.ok(text.includes(a.id), "active row still rendered");
    assert.ok(text.includes(res.memory.id), "new row still rendered");
    assert.ok(!text.includes("归档项目"), "archived row stays out");
    assert.ok(!text.includes("遗忘项目"), "forgotten row stays out");
    assert.ok(readFileSync(join(dir, "preferences.md"), "utf8").includes("偏好正文"), "sibling type rendered");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#430: the document gate is decided in SQL, before anything is rendered", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-430-doc-"));
  try {
    const { store, config } = make({ memoryQualityFilter: { enabled: true }, documentMemoryEnabled: false });
    const mirror = createMirror(dir);
    const svc = createService({ store, mirror, config });
    // 真 document 行：doc_path 只能经 store.saveDocument 铸造（通用 save 整类拒绝）。
    // 这条用例必须让库里真的有 document 行——上一版用例库里一行都没有，
    // 「闸关时不渲染 document」就无法与「根本没见过 document」区分（变异检验漏网）。
    const doc = store.saveDocument({
      type: "document",
      title: "指针文档",
      content: "文档摘要正文，长度足够",
      doc_path: "docs/pointer.md",
      importance: 3
    });
    svc.saveWithDedupe({ type: "project", title: "项目", content: "项目正文，长度足够绕开短内容归档规则", importance: 3 });
    const docPath = mirror.filePath("document");
    // 闸关（#296 第二批默认）：有真指针行也不许渲染出 documents.md
    assert.equal(existsSync(docPath), false, "documents.md stays absent while the gate is off");
    // 陈旧视图必须被删掉：不留一个「看着还在、其实已关」的视图
    writeFileSync(docPath, "陈旧视图", "utf8");
    svc.saveWithDedupe({ type: "project", title: "再写一条", content: "再写一条正文，与上一条正文互不相似", importance: 3 });
    assert.equal(existsSync(docPath), false, "stale documents.md pruned while the gate is off");
    assert.equal(existsSync(join(dir, "index.md")), false, "index.md pruned while the gate is off");
    assert.ok(readFileSync(join(dir, "projects.md"), "utf8").includes("项目正文"), "sibling type still rendered");
    // 反向：闸开时同一份指针行确实会渲染（证明上面那条断言有判别力，而不是
    // 因为 document 行从没进入过渲染集），关回去再必须删掉。
    config.documentMemoryEnabled = true;
    svc.saveWithDedupe({ type: "project", title: "闸开", content: "闸开后的正文，与前面几条互不相似", importance: 3 });
    assert.ok(existsSync(docPath), "documents.md rendered while the gate is on");
    assert.ok(readFileSync(docPath, "utf8").includes(doc.id), "pointer row is what gets rendered");
    config.documentMemoryEnabled = false;
    svc.saveWithDedupe({ type: "project", title: "闸关回去", content: "闸关回去后的正文，同样互不相似", importance: 3 });
    assert.equal(existsSync(docPath), false, "documents.md pruned again once the gate flips back off");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
