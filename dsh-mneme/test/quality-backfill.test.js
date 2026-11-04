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
    // 子串但非标签：带引号的精确匹配不该命中（这是选 %"repetitive"% 而非 %repetitive% 的理由）。
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
