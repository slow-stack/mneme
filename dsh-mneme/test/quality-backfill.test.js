import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { REPETITION_THRESHOLD, repetitionRatio } from "../src/quality-filter.js";

// 一次性迁移：撤回旧重复度度量留下的 repetitive 误判（#560 的收尾）。
//
// 这批用例锁的不是「迁移会改标签」，而是它的四条边界——每一条单独失守，都会让这次回填
// 变成比它要修的问题更大的问题：
//   1. 只动**新度量下不重复**的行。真重复（trigram > 0.7）的标签是对的，重算它就是把
//      「撤销误判」偷偷换成「重新判一遍」。
//   2. 分数只升不降（max(存量, 重建)）。存量分不是纯标签函数，直接用重建值会把历史上
//      被别的路径改过分的行往下压。
//   3. 归档位、updated_at、content_hash 一个都不许碰——归档是另一个决定；刷 updated_at
//      会让整库镜像重排并拆掉人工编辑的版本令牌；重算 content_hash 会把一次标签修订
//      变成一次内容修订。
//   4. 登记后不再跑。它不是「条件恒等幂等」，而是「一次性」：登记行就是判据，否则每次
//      打开都要全表扫一遍（本机 12,827 行实测 36.7ms，而 createStore 稳态 3.3ms）。

const LONG_NOTE = [
  "公共政策执行的偏差并不是单一原因造成的。从组织理论看，执行机构的层级结构会稀释政策意图，",
  "每一层都会按本层的信息与激励重新解释一次指令，到了末梢，任务的原始目标常常只剩下一个名称。",
  "从激励结构看，考核指标一旦被简化，执行者就会把可测量的部分当作全部，把不可测量的部分留空。",
  "从资源依赖看，政策落地需要财政、人事、信息三条线的配合，任何一条线短缺，执行都会退回到",
  "最容易完成的那部分动作，于是出现「有动作、无效果」。因此讨论执行偏差时，与其寻找一个总原因，",
  "不如分别问：目标在传递过程中被改写了什么，考核把哪些行为变成了理性选择，资源缺口让哪个环节",
  "先断掉。这三问分别对应组织、激励与资源三个解释层次，也对应三类不同的纠偏手段：前者靠信息回流",
  "与目标澄清，中者靠指标设计与问责边界，后者靠预算与能力建设。把它们混在一起谈，得到的往往",
  "是「重视不够」这类无法落地的结论。"
].join("").repeat(2);
const REPETITIVE = "好".repeat(40);

test("迁移：长中文散文的 repetitive 误判被撤回，分数与 low_quality 跟着修", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-qbackfill-"));
  const dbPath = join(dir, "legacy.db");
  try {
    // 前置自检：这一行必须是「旧度量判重复、新度量不判重复」的那一类，否则用例测不到东西。
    assert.ok(
      repetitionRatio(LONG_NOTE.trim()) < REPETITION_THRESHOLD,
      "sample must read as non-repetitive under the new metric"
    );
    assert.ok(repetitionRatio(REPETITIVE) > REPETITION_THRESHOLD, "control sample must read as repetitive");

    const legacy = new DatabaseSync(dbPath);
    // quality_score 与 content_hash 都先建好：这条迁移的判据依赖前者，而后者用它当
    // 「不许被碰」的哨兵值（若迁移顺手重算内容哈希，哨兵就变了）。
    legacy.exec(
      "CREATE TABLE memories (" +
        "id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL," +
        "tags TEXT NOT NULL DEFAULT '[]', importance INTEGER NOT NULL DEFAULT 3," +
        "forgotten INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0," +
        "source TEXT, quality_score REAL, content_hash TEXT," +
        "created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
    );
    const insert = legacy.prepare(
      "INSERT INTO memories (id, type, title, content, tags, importance, forgotten, archived, source, quality_score, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, ?, ?)"
    );
    const add = (id, content, tags, score, archivedFlag, updatedAt) =>
      insert.run(id, "project", "样本 " + id, content, tags, 3, archivedFlag ? 1 : 0, score, "sentinel-" + id,
        "2026-01-01T00:00:00.000Z", updatedAt);

    // 被长文本误判：100 − 50 = 50。
    add("misjudged", LONG_NOTE, '["repetitive","low_quality"]', 50, false, "2026-01-01T00:00:00.000Z");
    // 真重复：新度量下依旧 > 0.7，标签有效，一个字段都不该动。
    add("really-repetitive", REPETITIVE, '["repetitive","low_quality"]', 50, false, "2026-01-02T00:00:00.000Z");
    // 归档行：分数与标签照修，归档位不许动（撤销归档是另一个决定）。
    add("archived-misjudged", LONG_NOTE, '["repetitive","low_quality"]', 50, true, "2026-01-03T00:00:00.000Z");
    // 只升不降：重建值 100 − 45 − 15 = 40 < 存量 55。
    add("keep-higher", LONG_NOTE, '["meta","self_referential","repetitive"]', 55, false, "2026-01-04T00:00:00.000Z");
    // 解析不了 / 不是数组：打开库时抛异常等于插件整树起不来，一律原样放过。
    add("broken-tags", LONG_NOTE, '["repetitive"', 50, false, "2026-01-05T00:00:00.000Z");
    add("not-array", LONG_NOTE, '{"repetitive":true}', 50, false, "2026-01-06T00:00:00.000Z");
    // 子串但非标签：LIKE 只做候选裁剪，真正的判据是下一段的 tags.includes("repetitive")。
    // 带引号形态的意义只是少解析几条坏 JSON，误伤由 includes 兜住。
    add("substring", LONG_NOTE, '["low_quality_repetitive"]', 50, false, "2026-01-07T00:00:00.000Z");
    // 撤掉 repetitive 后仍 < 30（100 − 80 = 20）→ low_quality 必须留着：它是分数的派生态。
    add("still-low", LONG_NOTE, '["duplicate","repetitive","low_quality"]', 20, false, "2026-01-08T00:00:00.000Z");
    legacy.close();

    const store = createStore(dbPath);
    const got = (id) => store.getById(id);
    const raw = (id) => store.db.prepare("SELECT * FROM memories WHERE id = ?").get(id);

    assert.deepEqual(got("misjudged").tags, [], "repetitive 与 low_quality 都该撤掉");
    assert.equal(got("misjudged").quality_score, 100);
    assert.equal(got("misjudged").archived, false);

    assert.deepEqual(got("really-repetitive").tags, ["repetitive", "low_quality"], "真重复的标签是对的");
    assert.equal(got("really-repetitive").quality_score, 50, "真重复的 50 分也是它应得的");

    assert.deepEqual(got("archived-misjudged").tags, []);
    assert.equal(got("archived-misjudged").quality_score, 100);
    assert.equal(got("archived-misjudged").archived, true, "修分数不等于撤销归档");

    assert.deepEqual(got("keep-higher").tags, ["meta", "self_referential"]);
    assert.equal(got("keep-higher").quality_score, 55, "重建值低于存量时保留存量，绝不往下压");

    assert.equal(raw("broken-tags").tags, '["repetitive"');
    assert.equal(raw("not-array").tags, '{"repetitive":true}');
    assert.deepEqual(got("substring").tags, ["low_quality_repetitive"]);

    assert.deepEqual(got("still-low").tags, ["duplicate", "low_quality"]);
    assert.equal(got("still-low").quality_score, 20);

    // 三项「不许被碰」的证据：updated_at 原值、content_hash 哨兵值、generation 不涨。
    assert.equal(raw("misjudged").updated_at, "2026-01-01T00:00:00.000Z",
      "回填不许刷 updated_at：镜像按它排序，人工编辑也拿它当版本令牌");
    assert.equal(raw("misjudged").content_hash, "sentinel-misjudged", "回填不是内容修订，不许重算内容哈希");
    // mirror_state 行由 incrementGeneration 懒建（INSERT OR IGNORE）：没有行就等于 0。
    const gen = store.db.prepare("SELECT generation FROM mirror_state WHERE id = 'main'").get();
    assert.equal(gen?.generation ?? 0, 0, "回填不是业务写，不许记镜像债（那会触发全量重渲染）");

    const record = store.db
      .prepare("SELECT applied_at FROM applied_migrations WHERE id = ?")
      .get("2026-11-quality-repetitive-backfill");
    assert.ok(record, "迁移必须登记，否则每次打开都要全表扫一遍");
    assert.match(record.applied_at, /^\d{4}-\d{2}-\d{2}T/);
    store.close();

    // 再开一次：登记行在，整块跳过。故意把一条已经修好的行重新打回误判状态，它必须
    // **留着**——这条迁移是一次性的，不是「条件恒等幂等」（后者每次打开都要扫全表）。
    const re = new DatabaseSync(dbPath);
    re.prepare("UPDATE memories SET tags = '[\"repetitive\"]', quality_score = 50 WHERE id = 'misjudged'").run();
    re.close();
    const again = createStore(dbPath);
    assert.deepEqual(again.getById("misjudged").tags, ["repetitive"], "登记后不再跑：重开不得二次改写");
    assert.equal(again.getById("misjudged").quality_score, 50);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 第二批边界：分批、原文判据、原型链查表。三条都不是「好看一点」，各自对应一种会静默
// 写坏数据或漏修的形态——
//   * 分批：候选行带全文，一次 .all() 把行数 × 正文长度全攒在内存，且一次超大 WAL 提交；
//   * 原文判据：已降级的行 content 只是前 120 字摘要，拿摘要判重复正好会放过「前缀干净、
//     后段大量重复」——旧度量误判最多的那一类；
//   * 原型链查表：SIGNAL_DEDUCTIONS 是对象字面量，查 constructor 拿到的是原型上的函数，
//     `?? 0` 兜不住，分数会算成 NaN 再写进 REAL 列。
test("迁移：分批翻页、按原文判重复、只减自有扣分键", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-qbackfill2-"));
  const dbPath = join(dir, "legacy.db");
  try {
    assert.ok(repetitionRatio(LONG_NOTE.trim()) < REPETITION_THRESHOLD, "fixture: 长文必须不重复");
    assert.ok(repetitionRatio(REPETITIVE) > REPETITION_THRESHOLD, "fixture: 填充分必须重复");

    const legacy = new DatabaseSync(dbPath);
    legacy.exec(
      "CREATE TABLE memories (" +
        "id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL," +
        "tags TEXT NOT NULL DEFAULT '[]', importance INTEGER NOT NULL DEFAULT 3," +
        "forgotten INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0," +
        "source TEXT, quality_score REAL, content_hash TEXT, _full_content TEXT," +
        "created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
    );
    const insert = legacy.prepare(
      "INSERT INTO memories (id, type, title, content, tags, importance, forgotten, archived, source, quality_score, content_hash, _full_content, created_at, updated_at) VALUES (?, 'project', ?, ?, ?, 3, 0, 0, NULL, ?, NULL, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
    );
    // 260 条跨过 BATCH=200，逼第二轮翻页真的发生（只有一轮的话分批逻辑等于没测）。
    for (let i = 0; i < 260; i++) {
      insert.run("bulk-" + String(i).padStart(3, "0"), "批量 " + i, LONG_NOTE, '["repetitive","low_quality"]', 50, null);
    }
    // 已降级：content 是前 120 字摘要（这里刻意给一段不重复的摘要），原文在 _full_content
    // 且它才是真重复的那一类。按原文判 → 标签保留；按摘要判 → 会被误撤。
    const summary = "这段摘要本身很短，字符分布也正常，按它判重复永远不会命中。" + "公共政策执行的偏差并不是单一原因造成的。".repeat(2);
    insert.run("demoted", "降级行", summary, '["repetitive","low_quality"]', 50, REPETITIVE);
    // 原型链标签：constructor 不在自有键里，一分都不该扣（扣了就是 NaN）。
    insert.run("proto-tag", "原型链标签", LONG_NOTE, '["repetitive","constructor"]', 50, null);
    // 非字符串元素：Object.hasOwn 会对它做属性键转换并抛 TypeError。这里没有任何 catch，
    // 异常会直接让 createStore 中止——插件整树起不来，且登记行永远写不上、每次打开都重撞。
    insert.run("obj-tag", "对象标签", LONG_NOTE, '["repetitive",{"toString":1}]', 50, null);
    legacy.close();

    const store = createStore(dbPath);
    try {
      const raw = (id) => store.db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
      // 260 条全修完，且不含任何 null 分（NaN 会被写成 NULL）。
      const bulk = store.db
        .prepare("SELECT COUNT(*) AS c FROM memories WHERE id LIKE 'bulk-%' AND tags = '[]' AND quality_score = 100")
        .get().c;
      assert.equal(bulk, 260, "跨批次的行必须逐批全部修完");
      const nulls = store.db
        .prepare("SELECT COUNT(*) AS c FROM memories WHERE quality_score IS NULL")
        .get().c;
      assert.equal(nulls, 0, "分数算成 NaN 会落成 NULL，这里必须是 0");

      const demoted = raw("demoted");
      assert.deepEqual(JSON.parse(demoted.tags), ["repetitive", "low_quality"], "按摘要判会把这条原文重复的行误撤");
      assert.equal(demoted.quality_score, 50, "原文仍重复 → 分数与标签一起保持原样");
      assert.equal(demoted._full_content, REPETITIVE, "判据读原文不等于改原文");
      assert.ok(demoted.content.startsWith("这段摘要"), "content 仍是摘要，迁移不许顺手恢复原文");

      // 整条原样放过（与坏 tags 同一策略）：本迁移不该顺手重写一个自己解析不了的值。
      assert.equal(raw("obj-tag").tags, '["repetitive",{"toString":1}]', "非字符串标签不许碰，更不许让它把打开库搞崩");
      assert.equal(raw("obj-tag").quality_score, 50);

      const proto = raw("proto-tag");
      assert.deepEqual(JSON.parse(proto.tags), ["constructor"], "repetitive 撤掉，其余标签原样保留");
      // constructor 不是自有扣分键 → 一分不扣，重建值 100；存量 50 是旧误判压出来的，
      // 取 max 抬回 100。若误按原型链扣分，这里会是 NaN → 写入 NULL，下面的断言就抓它。
      assert.equal(proto.quality_score, 100, "constructor 不得扣分：重建值应为满分");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 第三条边界：CAS 落空的行这一趟没修到，那就不许登记「已完成」——登记行是「这条迁移
// 跑完了」的唯一证据，写早了，那条行会带着旧分与旧标签一直留在库里，再没人回头看它。
// 这里用 AFTER UPDATE 触发器造**确定性**的 CAS 落空（不用定时器）：cur-a 的 rowid 在前，
// 它一被改写就分别去改 cur-b 的 tags 与 cur-c 的正文，于是这两行的 UPDATE 因 WHERE 不匹配
// 而 changes = 0。两条分开测，是因为它们各自对应 CAS 的一个条件：cur-b 验 tags，
// cur-c 验正文——只校验 tags/quality_score 时，cur-c 那种「正文被换成重复文本、另两列没动」
// 的情况会原地通过，把本该保留的 repetitive 撤掉。
test("迁移：CAS 落空时不写登记行，下次打开整条重跑", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-qbackfill3-"));
  const dbPath = join(dir, "legacy.db");
  try {
    assert.ok(repetitionRatio(LONG_NOTE.trim()) < REPETITION_THRESHOLD, "fixture: 长文必须不重复");

    const legacy = new DatabaseSync(dbPath);
    legacy.exec(
      "CREATE TABLE memories (" +
        "id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL," +
        "tags TEXT NOT NULL DEFAULT '[]', importance INTEGER NOT NULL DEFAULT 3," +
        "forgotten INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0," +
        "source TEXT, quality_score REAL, content_hash TEXT," +
        "created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
    );
    // content_hash 给非空哨兵：这一列的存量回填跑在本条迁移之前，也会 UPDATE memories，
    // 若留 NULL 就会提前触发下面的触发器、把 cas 冲突挪到错误的位置。
    const insert = legacy.prepare(
      "INSERT INTO memories (id, type, title, content, tags, importance, forgotten, archived, source, quality_score, content_hash, created_at, updated_at) VALUES (?, 'project', ?, ?, ?, 3, 0, 0, NULL, 50, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
    );
    insert.run("cur-a", "样本 A", LONG_NOTE, '["repetitive","low_quality"]', "sentinel-a");
    insert.run("cur-b", "样本 B", LONG_NOTE, '["repetitive","low_quality"]', "sentinel-b");
    insert.run("cur-c", "样本 C", LONG_NOTE, '["repetitive","low_quality"]', "sentinel-c");
    // 只认 cur-a：别的 UPDATE 不该引发冲突，否则测到的就不是本条迁移的 CAS 了。
    const replaced = '["repetitive","meta"]';
    legacy.exec(
      "CREATE TRIGGER cas_conflict AFTER UPDATE ON memories WHEN NEW.id = 'cur-a' " +
        "BEGIN " +
        "UPDATE memories SET tags = '" + replaced + "' WHERE id = 'cur-b'; " +
        "UPDATE memories SET content = '" + REPETITIVE + "' WHERE id = 'cur-c'; " +
        "END;"
    );
    legacy.close();

    const store = createStore(dbPath);
    try {
      // cur-a 修好了（它就是触发源），cur-b 的 CAS 落空、原样留着。
      assert.deepEqual(store.getById("cur-a").tags, [], "触发源那一行本身照常修好");
      assert.deepEqual(store.getById("cur-b").tags, ["repetitive", "meta"], "tags 变了：CAS 落空的行这一趟不许被覆盖");
      assert.deepEqual(store.getById("cur-c").tags, ["repetitive", "low_quality"],
        "只有正文变了也得挡下：判据读的是正文，不校验它就会把该保留的 repetitive 撤掉");
      assert.equal(store.getById("cur-c").content, REPETITIVE, "迁移不许顺手把正文改回去");
      const mark = store.db
        .prepare("SELECT 1 FROM applied_migrations WHERE id = ?")
        .get("2026-11-quality-repetitive-backfill");
      assert.equal(mark, undefined, "还有行没修到时不许登记：登记行一写，它就再也不会被处理");
    } finally {
      store.close();
    }

    // 再开一次：cur-a 已不是候选（repetitive 已撤），触发器不再开火，cur-b 这次能修好、
    // 登记行也才写上——「重跑」而不是「放弃」，这是不重试、只推迟登记的完整语义。
    const again = createStore(dbPath);
    try {
      assert.deepEqual(again.getById("cur-b").tags, ["meta"], "重跑时补上落空的那一行");
      // cur-c 的正文已被换成真重复文本：重跑时判据看到它是真重复，标签就该留着——
      // 这条顺带证明「重跑」不是「无条件撤销」，判据每次都重新读当次正文。
      assert.deepEqual(again.getById("cur-c").tags, ["repetitive", "low_quality"], "重跑按当次正文重新判");
      const mark = again.db
        .prepare("SELECT 1 FROM applied_migrations WHERE id = ?")
        .get("2026-11-quality-repetitive-backfill");
      assert.ok(mark, "没有落空之后才登记");
    } finally {
      again.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
