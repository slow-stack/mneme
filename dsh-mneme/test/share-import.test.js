// 导入的动作面。四条锁，一条比一条容易被「顺手重构」拆掉：
//   a) 不改写别人——既有非 imported 行的 updated_at 逐字节不动（决策 2 的直接锁）；
//   b) 幂等——同包第二次导入 created = 0 且不删任何东西；
//   c) 外来行带着守卫要的身份落地（source / 两个 scope），否则车道 B 的九个池子白挡；
//   d) 真的排进了嵌入队列、并在提交后落进 embedding 列（在 transaction 里），否则对面的
//      向量检索吃不到这批。
// 另有三条同样会被「顺手重构」拆掉：撞名清单里的既有那一行必须是收件人自己的行（外来行
// 永远不许当 existing_id）、校验不过时整库无痕、干跑不许冒充「库刚变过」。这三条测的都是
// 收侧要对外讲的读数与其余读侧的可见性——报得出去但没人能看出错，比不测更糟。
// 最后三条盯事务那一层的形状：嵌入队列只在**最外层 COMMIT** 排空（不当场发、也不在提交前
// 排空）、对面宿主抢先把同一个 share_external_id 落库时整笔中止、以及「已经写下的行」随
// 回滚一起消失且一行都不嵌。它们各自防的替换品：store.runAtomically（txDepth 恒 0，队列
// 当场排空）、hand-rolled BEGIN/COMMIT（原子性一样，但 drain 与 notifyWrite 的位置不对）、
// 「撞一条就跳过这一条」的宽容写法（前几行留在库里）。
//
// C4 之后本文件管的是收侧的**进与出**两面。退出那五条锁防的是另一族错：删多（伤到收件人
// 自己的行）、删少（留下半个包，身份还挂在那个已经收起的包上）、没删干净幂等键（归档版实现
// 的死结：撤了却导不回来）、没删成东西却冒充「库刚变过」（重渲染整面镜像 + 顶回空闲计时器）、
// 以及嵌入次数与「真的写进库的行数」脱钩。最后一条是整包 IN 列表的分块：SQLite 一条语句的
// 参数上限是 32766，而包的水位按字节不按条数，所以「小正文大条数」的包能逼近它。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { deriveExternalId, importedTagFor, SHARE_KIND } from "../src/share.js";
import { IMPORTED_SOURCE } from "../src/memory-source.js";

const PACK_ID = "f0f0f0f0f0f0f0f0";
// packId 可换是第三个补的用例要的：external_id 的四格里含 pack_id，同 pack_id 的第二份
// 包会被幂等那格吃掉（skipped_existing），那条路径问不出「撞名报给谁」这件事。
const PACK_ID_2 = "a1a1a1a1a1a1a1a1";
const pack = (entries, alias = "桉", packId = PACK_ID) => ({
  kind: SHARE_KIND, pack_id: packId, alias, generated_at: "2026-10-22T00:00:00.000Z",
  source_version: "0.9.4", report: { included: entries.length, skipped: {}, skip_list: [], deduped: 0 },
  memories: entries.map((e) => ({ ...e, external_id: deriveExternalId(packId, e.type, e.title, e.content_hash) }))
});
const entry = (type, title, content) => ({
  type, title, content, tags: ["t"], importance: 4, epistemic_status: "verifiable",
  created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z",
  content_hash: "anchor", external_id: deriveExternalId(PACK_ID, type, title, "anchor")
});

// scheduleEmbed 的写回是 embedSingle 的 .then()，异步且不进任何可 await 的出口
// （fire-and-forget 是设计，不是漏的）。所以这里等的是**落库**：轮询到 embedding
// 列真有值为止，等不到就让断言自己红。轮询而不是 await 一个 tick，是因为桩返回的
// promise 与真实 embedder 的调度深度不同，写死 tick 数的用例会在某天多一层 await
// 时静默转红——那类红查起来比这条用例本身还贵。
async function waitFor(pred, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-share-import-"));
  const dbPath = join(dir, "memory.db");
  const raw = createStore(dbPath);
  const embedded = [];
  // 事务形状的两个观测点，都由 store 包装记下来，不改任何返回值：
  //  · saves：每次 store.save **返回之后**那一刻——库还开着事务吗（inTx）、嵌入已经被调用
  //    几次（fired）。这一格问的是「事务体内有没有当场发嵌入」。
  //  · fires ：每次 embedSingle 被调用那一刻——事务还在开着吗、库里能看到几行、写通知跑了
  //    没有。这一格问的是「排空是在 COMMIT 之前还是之后」。
  // 用 Proxy 而不是替换方法：service 拿到的是同一个 store 对象，所有方法照原样委托，
  // 观测只在调用后加一笔，绝不留一份「测试专用」的第二实现。
  const saves = [];
  const fires = [];
  const inject = { precheck: null };
  let writes = 0;
  let second = null;
  const store = new Proxy(raw, {
    get(t, key) {
      const v = Reflect.get(t, key);
      if (typeof v !== "function") return v;
      return (...args) => {
        const result = v.apply(t, args);
        if (key === "save") saves.push({ title: args[0].title, inTx: raw.db.isTransaction, fired: embedded.length });
        // 注入点：先查刚返回 undefined，写入还没发生——这正是「另一个宿主在我读与写之间
        // 提交」的那个窗口，用例在这里让对面的行落地。
        if (key === "getByShareExternalId" && inject.precheck) inject.precheck(args[0], result);
        return result;
      };
    }
  });
  const rowsOf = (s) => s.list({ limit: null, includeArchived: true, includeForgotten: true });
  const rows = () => rowsOf(raw);
  const service = createService({
    store, mirror: null, config: { embeddingModel: "stub" },
    onWrite: () => { writes++; }
  });
  // 方法名照 src/service.js 探测的那两个（schedule ?? embedSingle）：猜错的话 lock d 那条
  // 用例会「绿得没意义」——嵌入根本没被调用也测不出来。这里刻意不给 schedule()，
  // 走的是 embedSingle → store.setEmbedding 那一支，正是导入路径要的那一条。
  // 探针记录（已跑过、不留在文件里）：把这一整套 setEmbedder 摘掉、或把实现里的
  // scheduleEmbed(row) 删掉，下面 lock d 那条用例都会转红——它等的是 embedding 列，
  // 不是「函数被叫过」。
  // embedSingle 的函数体在第一个 await 之前同步跑完，所以 fires 记的就是「排空那一刻」：
  // 事务开没开、库里几行、写通知跑过没有，都是当下的读数而不是事后回看。
  service.setEmbedder({
    embedSingle: async (t) => {
      fires.push({ inTx: raw.db.isTransaction, rows: rowsOf(raw).length, writesAtFire: writes });
      embedded.push(t);
      return [0, t.length];
    },
    embed: async (xs) => xs.map(() => [0, 1])
  });
  return {
    store: raw, service, dir, rows, embedded, saves, fires, inject,
    writes: () => writes,
    // 第二个连接指同一个文件——AGENTS.md 说的「两个宿主共用一个 memoryDir」在单机上的
    // 等价物（WAL + busy_timeout 本就为多连接就绪，test/peer-blockers.test.js 同法）。
    openSecond() { second = createStore(dbPath); return second; },
    close() {
      for (const s of [second, raw]) { try { s.close(); } catch { /* closed */ } }
      // Windows：连接句柄延迟释放时 rm 偶发 EPERM，maxRetries 兜一下；清理只是收尾。
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); }
      catch (err) { if (!["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err; }
    }
  };
}

test("a foreign pack lands as new rows with the guard's identity", () => {
  const h = setup();
  try {
    const out = h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A")]), {});
    assert.equal(out.created, 1);
    assert.equal(out.pack_id, PACK_ID);
    const row = h.rows().find((m) => m.title === "选 SQLite");
    assert.equal(row.source, IMPORTED_SOURCE);
    assert.equal(row.agent_scope, undefined);
    assert.equal(row.workspace_scope, undefined);
    assert.equal(row.share_pack_id, PACK_ID);
    assert.ok(row.tags.includes(importedTagFor("桉")));
    assert.notEqual(row.created_at, "2026-10-01T00:00:00.000Z", "created_at is the store's, not the pack's");
    // content_hash 与 created_at 同一族：两格都由 store 铸造，包里的值传不进去（spec §5
    // 记的三个事实前两条）。这条不是防呆——是「unchanged 只许当读数」的前提：接收侧一旦
    // 能吃下发件侧的锚，那一格就从给人看的数变成动作依据，同 title 同锚但正文不同的两条
    // 就会被判成「已经吃过」而静默不建。库里这条行带的必须是收件人自己算的哈希。
    // 先锁形状再锁不等：只写 notEqual 的话 content_hash 读成 undefined 也算「不等于 anchor」，
    // 那条断言就成了永远绿的空锁。
    assert.match(row.content_hash, /^[0-9a-f]{64}$/, "the stored anchor is the recipient's own sha256");
    assert.notEqual(row.content_hash, "anchor", "content_hash is the store's, not the pack's");
  } finally { h.close(); }
});

test("re-importing the same pack creates nothing and deletes nothing", () => {
  const h = setup();
  try {
    h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A"), entry("pitfall", "别用表连接", "正文 B")]), {});
    const before = h.rows().length;
    const again = h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A"), entry("pitfall", "别用表连接", "正文 B")]), {});
    assert.equal(again.created, 0);
    assert.equal(again.skipped_existing, 2);
    // unchanged 在这里是 0，不是 bug：包里的锚是发送方**遮之前**的归一化哈希，库里这一格
    // 是收件人按收到的字节重算的（上一条用例锁的就是这件事）。所以这条计数只能回答
    // 「两侧的尺看起来一样吗」，永远不能回答「这条要不要建」——后者只看 share_external_id。
    assert.equal(again.unchanged, 0, "the two anchors legitimately differ; unchanged is a reading, not a decision");
    assert.equal(h.rows().length, before, "idempotent means nothing removed either");
  } finally { h.close(); }
});

test("a name clash with the host's own memory is reported, never merged into", () => {
  const h = setup();
  try {
    const mine = h.store.save({ type: "decision", title: "选 SQLite", content: "我自己的结论", tags: [] });
    const before = h.store.getById(mine.id);
    const out = h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A")]), {});
    assert.equal(out.created, 1);
    assert.equal(out.title_conflicts.length, 1);
    assert.equal(out.title_conflicts[0].existing_id, mine.id);
    const after = h.store.getById(mine.id);
    assert.equal(after.content, before.content);
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(after.archived, before.archived);
  } finally { h.close(); }
});

test("dry-run answers the same shape and writes nothing", () => {
  const h = setup();
  try {
    const out = h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A")]), { dryRun: true });
    assert.equal(out.created, 1);
    assert.equal(h.rows().length, 0, "a dry run must leave the library byte-identical");
    const real = h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A")]), {});
    assert.equal(real.created, 1);
  } finally { h.close(); }
});

test("an invalid pack throws before any row is written", () => {
  const h = setup();
  try {
    const bad = pack([entry("decision", "选 SQLite", "正文 A"), entry("decision", "第二条", "x")]);
    bad.memories[1].external_id = "0000000000000000";
    assert.throws(() => h.service.importSharePack(bad, {}), (e) => e.code === "external-id-mismatch");
    assert.equal(h.rows().length, 0);
  } finally { h.close(); }
});

// 车道 B 的九个池子把外来行报成「不可改写」，收侧的撞名读数得说的是同一件事：
// 撞的是收件人自己的行。上一包的 foreign 行同名不是撞名——它是别人的原文，
// 报出去只会让人去处理一条他既不能改也不能删（C4 之前）的行。
test("a clash is reported against my own row, never against another foreign row", () => {
  const h = setup();
  try {
    const first = h.service.importSharePack(pack([entry("pitfall", "别用表连接", "正文 B")], "桉"), {});
    assert.equal(first.title_conflicts.length, 0, "库里没有同名自己的行时不该凭空报撞名");
    const foreign = h.rows().find((m) => m.title === "别用表连接");
    assert.equal(foreign.source, IMPORTED_SOURCE);
    const second = h.service.importSharePack(pack([entry("pitfall", "别用表连接", "正文 B")], "杉", PACK_ID_2), {});
    assert.equal(second.created, 1, "别的 pack_id 铸出别的幂等键，这一条是真新建");
    assert.deepEqual(second.title_conflicts, [], "上一包的外来行不是「你库里已经有一条」");
  } finally { h.close(); }
});

// 第四条锁（d）。断言的是 embedding **列**：只数 embedSingle 被调了几次的话，
// 一个「调完就把向量丢掉」的实现照样绿，而这条契约要的是对面搜得到这批行。
test("the pack reaches the embed queue and lands a vector after the commit", async () => {
  const h = setup();
  try {
    const out = h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A"), entry("pitfall", "别用表连接", "正文 B")]), {});
    assert.equal(out.created, 2);
    assert.equal(await waitFor(() => h.service.embeddedCount() === 2), true,
      "both imported rows must end up with a vector, not just a scheduled call");
    assert.equal(h.embedded.length, 2, "exactly one embed per imported row");
    // 干跑一条都不许嵌：它一行都没写，排进队列的就是给不存在的行做向量。
    const dry = h.service.importSharePack(pack([entry("constraint", "别动镜像", "正文 C")], "桉"), { dryRun: true });
    assert.equal(dry.created, 1);
    assert.equal(h.embedded.length, 2, "a dry run schedules nothing");
    assert.equal(h.service.embeddedCount(), 2);
  } finally { h.close(); }
});

// 车道 C 预检点名的那条裁定：真导入必须裹在 service.transaction() 里，不是
// store.runAtomically()。两个助手都能让整包原子落库，所以「行在不在」测不出差别，
// 差别在事务那一层的 finally：syncMirror() + notifyWrite()——镜像与写通知才是收件人
// 其余读侧（面板、巩固调度、另一台宿主）看见这批行的地方。换成 runAtomically 会写下
// 整包却一次都不通知；干跑则两次都不该通知（它没改任何东西，却会把空闲计时器顶回去、
// 压掉本来该做的一轮巩固）。
test("the committed batch fires the transaction's write side effects exactly once", () => {
  const h = setup();
  try {
    h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A")]), { dryRun: true });
    assert.equal(h.writes(), 0, "a dry run must not claim the library just changed");
    h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A")]), {});
    assert.equal(h.writes(), 1, "one notifyWrite per committed batch, from transaction()'s finally");
  } finally { h.close(); }
});

// 裁定 1 的正身。上一条例子数的是 notifyWrite（换了 runAtomically 会红），但它是**代理**
// 读数：真正要钉的是嵌入队列的排空位置——scheduleEmbed 在事务里只入队，队列由 transaction()
// 的 finally 在**最外层 COMMIT 之后**排空。三种「看起来一样对」的写法各被哪一格抓住：
//  · store.runAtomically 导入：txDepth 恒 0，嵌入在事务体内当场发起 → saves 里的 fired 立刻 >0；
//  · hand-rolled BEGIN/COMMIT + 提交前排空：行是原子的、嵌入也发了，但发的时候事务还开着
//    （fires 的 inTx 为真）、库里的行数还不是全批（rows < N）、finally 那层的 notifyWrite 根本没跑；
//  · 事务外再补一遍嵌入：同 fired > 0 那一类。
// 「事务体内 fired === 0」与「排空时 inTx === 0」这两格是上一轮唯一缺的锁，notifyWrite 从此
// 只是第二信号，不再是唯一挡着「重构后静默不嵌入」的东西。
test("the embed queue drains at the transaction's outermost COMMIT, never inside the batch", () => {
  const h = setup();
  try {
    const p = pack([entry("decision", "选 SQLite", "正文 A"), entry("pitfall", "别用表连接", "正文 B")]);
    const out = h.service.importSharePack(p, {});
    assert.equal(out.created, 2);
    // 事务体内：两次写入都确实在开着的写事务里（inTx 为真，否则「一行都没发」只是因为
    // 根本没有事务——那格就成空锁了），且 embedSingle 一次都没被调用。
    assert.equal(h.saves.length, 2, "both rows are written through the store inside the batch");
    for (const s of h.saves) {
      assert.equal(s.inTx, true, `the write of 「${s.title}」 must happen inside an open transaction`);
      assert.equal(s.fired, 0, `nothing may be embedded while the batch is still open (saw 「${s.title}」)`);
    }
    // 排空时刻：COMMIT 已经发生（isTransaction 归 false），整批两行都已可见，写通知也已经
    // 跑过——这三格一起说的是「drain 在 finally 里、在提交之后」，不是「在事务里补的」。
    assert.equal(h.fires.length, 2, "exactly one embed per committed row");
    for (const f of h.fires) {
      assert.equal(f.inTx, false, "the queue must drain after the COMMIT, not while the transaction is open");
      assert.equal(f.rows, 2, "the drain sees the whole committed batch, not a prefix of it");
      assert.equal(f.writesAtFire, 1, "notifyWrite runs in the same finally, before the drain");
    }
    assert.equal(h.writes(), 1, "and exactly once for the batch");
  } finally { h.close(); }
});

// 两个连接、同一个文件（AGENTS.md 的多进程 WAL 场景在单进程里的等价物）：对面宿主在我
// 「先查读到 undefined」与「我这行 INSERT」之间把同一个 share_external_id 落了库。
// 这条锁能证与不能证，写清楚，别当成跨进程证明：
//  · 证到：整笔中止（导入抛错）、一包一行都不落（连不冲突的那条也不在库里）、对面那行原样
//    活着、且**两个连接读到的都是这个结果**（不是某条连接的私有回滚视图）、嵌入一次都没发。
//  · 没证到：报错的具体种类。WAL 下这条路径必然是 SQLITE_BUSY_SNAPSHOT（我们的事务先读过、
//    想升级成写事务时对端已提交，store 的 busy_timeout 不重试这一类）——实测消息
//    「database is locked」。索引那一层（UNIQUE）由下一条用例在**同一笔事务里**命中，那条
//    才锁得住「已经写下的行也一起回滚」。两种表面都是「双保险生效」，所以断言按行为不按消息。
//  · 注入点只能在**我们第一次写之前**：WAL 同一时刻只有一个写入者，我们的 INSERT 一落地，
//    对面那条就只会被 busy_timeout 挡死（那是另一件事，且要等 5 秒）。所以「对端抢先提交」
//    这一族里，本用例是唯一能成立的时间序，「已落半包再回滚」只能交给下一条用例。
test("a second host landing the same key mid-import aborts the whole batch on both connections", () => {
  const h = setup();
  const other = h.openSecond();
  try {
    const p = pack([entry("decision", "选 SQLite", "正文 A"), entry("pitfall", "别用表连接", "正文 B")]);
    const stolen = p.memories[0].external_id;
    let landed = false;
    h.inject.precheck = (key) => {
      if (landed || key !== stolen) return;
      landed = true;
      // 走另一个连接、另一个事务：它的 COMMIT 落在我们读与写之间。
      other.save({ type: "decision", title: "选 SQLite", content: "对面先落的原文",
        source: IMPORTED_SOURCE, share_pack_id: "另一个包", share_external_id: key });
    };
    assert.throws(() => h.service.importSharePack(p, {}), /UNIQUE constraint failed|database is locked/i);
    assert.equal(landed, true, "the injection must have run or the whole case is empty");
    assert.equal(h.saves.length, 0, "the abort must not leave any write of ours behind");
    // 收件人这条库里：只有对面那一条，包里两条一条都没落（幂等键不是 ours，也不算 skipped_existing）。
    assert.deepEqual(h.rows().map((m) => m.title), ["选 SQLite"]);
    assert.equal(h.rows()[0].content, "对面先落的原文", "the other host's row survives untouched");
    assert.equal(h.rows()[0].source, IMPORTED_SOURCE);
    // 对面连接读到的同一件事：我们的 INSERT 没有以「覆盖」「并存」的形态偷偷落进去。
    assert.deepEqual(other.list({ limit: null, includeArchived: true, includeForgotten: true }).map((m) => m.title),
      ["选 SQLite"], "the two connections must agree that nothing of ours landed");
    assert.equal(other.getByShareExternalId(stolen).content, "对面先落的原文");
    assert.equal(other.getByShareExternalId(p.memories[1].external_id), undefined);
    assert.equal(h.embedded.length, 0, "an aborted batch embeds nothing");
    assert.equal(h.service.embeddedCount(), 0);
  } finally { h.close(); }
});

// 「撞一条就跳过这一条继续」是这条契约最容易招来的宽容写法：看上去也返回了一个数，实际把
// 「这个包还没吃过」报成「吃过了」，而库里留下半包。上一条例子挡不住它（我们的第一行就没
// 写下去），所以这里让冲突发生在**第 3 行**：前两行的 INSERT 已经真的落进这笔事务，索引
// 在第三次写入时把它撞回去。断言三格：前两行随整笔回滚一起消失（不是「留下半包」）、已入队
// 的两次嵌入一个都没发（transaction() 把 pendingEmbed 截回基线）、错误原样穿出而不是被吞掉。
// 「外层回滚」这件事在这里只能这么测：transaction() 是无条件 `BEGIN`，所以
// `service.transaction(() => service.transaction(...))` 这种嵌套在实测里直接以
// 「cannot start a transaction within a transaction」失败（外层因此连累回滚）——文件里
// 真正的嵌套只有 store.runAtomically 那侧认 db.isTransaction 早退，而它不认识队列。
// 回滚一侧的锁因此落在**本笔事务自己失败**这条路上：截断 pendingEmbed 的代码就是那一格，
// 外层回滚走的也是同一格，形状等价。
// 注入走 h.store（同一个连接、同一笔已开着的事务）：这里要的是「写快照里这个键已被占用」
// 这一件事，对端提交在 WAL 下只会拿到 BUSY（见上一条例子），拿不到 UNIQUE。代价是注入的
// 那行也同属这笔事务，会跟着一起回滚——所以「对面的行活着」由上一条例子负责证。
test("a collision on the index rolls back the rows that already landed and discards their embeds", () => {
  const h = setup();
  try {
    const p = pack([entry("decision", "选 SQLite", "正文 A"), entry("pitfall", "别用表连接", "正文 B"),
      entry("constraint", "别动镜像", "正文 C")]);
    const stolen = p.memories[2].external_id;
    let injected = false;
    h.inject.precheck = (key) => {
      if (injected || key !== stolen) return;
      injected = true;
      h.store.save({ type: "constraint", title: "别动镜像", content: "已经被占的原文",
        source: IMPORTED_SOURCE, share_pack_id: "另一个包", share_external_id: key });
    };
    assert.throws(() => h.service.importSharePack(p, {}),
      /UNIQUE constraint failed: memories\.share_external_id/, "the index, not the pre-check, must be what aborts us");
    assert.equal(injected, true, "the injection must have run or the whole case is empty");
    assert.equal(h.saves.length, 2, "two of our INSERTs did land inside the transaction before the collision");
    assert.equal(h.rows().length, 0, "a prefix must never survive: the whole batch rolls back, nothing lands");
    assert.equal(h.embedded.length, 0, "the queued embeds are truncated on rollback — no vector for a rolled-back row");
    assert.equal(h.service.embeddedCount(), 0);
    assert.equal(h.store.getByShareExternalId(p.memories[0].external_id), undefined);
  } finally { h.close(); }
});

// ============================ C4：整包退出 ============================
// 退出是这条车道唯一会从用户库里**删掉东西**的动作，所以下面六条锁各自防一类「看着也对」
// 的替换品：
//   · 删成归档 —— 行还在，UNIQUE 位还占着，包撤不掉也导不回（spec §5 定物删的那条理由）；
//   · 只删可见面 / 只删第一块 —— deleted 报得满、库里却留着半包，那半包的来源标签指向一个
//     已经撤走的分享者，而面板只认答复里的数；
//   · 顺手清库 —— 收件人自己的行被一起带走或被改一行，本文件按 C3 的口径逐字节钉住那一行；
//   · 干跑走真删那半 / 没删成也进事务 —— 答复同形状，但它重渲染了整面镜像、顶回了做梦的
//     空闲计时器，还记下一笔没有对象的镜像债；
//   · 嵌入次数与真的写进库的行数脱钩（重复排空、给没写成的行做向量、退出后重嵌全库）；
//   · 整包 IN 列表不分块 —— SQLite 一条语句 32766 个参数的上限，撞上了就是整笔回滚。
test("undo removes exactly one pack's rows and frees the idempotency keys", () => {
  const h = setup();
  try {
    h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A"), entry("pitfall", "别用表连接", "正文 B")]), {});
    const kept = h.store.save({ type: "decision", title: "我自己的", content: "正文", tags: [] });
    const keptBefore = h.store.getById(kept.id);
    const preview = h.service.deleteSharePack(PACK_ID, { dryRun: true });
    assert.equal(preview.deleted, 2);
    assert.equal(preview.pack_id, PACK_ID);
    assert.equal(h.rows().length, 3, "dry-run removes nothing");
    assert.equal(h.writes(), 1, "the preview must not claim the library just changed (the 1 is the import's own notify)");
    const out = h.service.deleteSharePack(PACK_ID, {});
    assert.equal(out.deleted, 2);
    assert.deepEqual(out.sample, preview.sample, "the destructive answer carries the same inventory the preview showed");
    assert.equal(h.rows().length, 1, "only the withdrawn pack is gone, the host's row is still there");
    assert.ok(h.store.getById(kept.id), "the host's own rows must survive");
    const keptAfter = h.store.getById(kept.id);
    assert.equal(keptAfter.updated_at, keptBefore.updated_at, "a withdrawal must not touch the recipient's own row");
    assert.equal(keptAfter.content, keptBefore.content);
    assert.equal(h.writes(), 2, "one notifyWrite for the committed withdrawal, from transaction()'s finally");
    assert.equal(h.service.deleteSharePack(PACK_ID, {}).deleted, 0, "undo is idempotent");
    assert.equal(h.writes(), 2, "a withdrawal that deletes nothing must not notify a second time");
    const again = h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A"), entry("pitfall", "别用表连接", "正文 B")]), {});
    assert.equal(again.created, 2, "the UNIQUE slots were freed, so the pack can land again");
  } finally { h.close(); }
});

// 「留下半个包」是这一族里最难看见的错：deleted 报 2、sample 报 2、库里还剩 1 条带
// share_pack_id 的行——面板上那个包显示已收起，向量检索与关键词检索却还能搜到它，而它
// 的来源标签指向一个已经撤走的分享者。所以这里数的是**库级**行数（SELECT count(*) FROM
// memories），不是答复里的数、也不是 h.rows() 那个可见面：归档与遗忘那两张脸必须一起
// 收走。spec §5 明确不要的归档版实现在这里当场转红（变异检验：把实现换成逐行
// setArchived，本文件六条退出用例里有五条一起红，见 C4 报告的 M2）。
test("undo takes the whole pack with it, including the archived and forgotten faces", () => {
  const h = setup();
  try {
    h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A"), entry("pitfall", "别用表连接", "正文 B"),
      entry("constraint", "别动镜像", "正文 C")]), {});
    const rowsIn = h.rows();
    h.store.setArchived(rowsIn.find((m) => m.title === "选 SQLite").id, true);
    h.store.setForget(rowsIn.find((m) => m.title === "别用表连接").id, true);
    const total = () => h.store.db.prepare("SELECT count(*) AS c FROM memories").get().c;
    assert.equal(total(), 3, "three foreign rows landed before the withdrawal");
    const out = h.service.deleteSharePack(PACK_ID, {});
    assert.equal(out.deleted, 3, "the count is the store's, not the visible face's: archived/forgotten rows are part of the pack");
    assert.equal(total(), 0, "nothing of that pack may survive in any face");
    assert.deepEqual(h.store.listBySharePackId(PACK_ID), []);
    // 每一格的幂等键都释放了：剩一条就够把下一个同名条目卡成 skipped_existing，而它挂在
    // 一个已经报成「收起了」的包上——所以 re-import 必须整包新建，一条都不许跳过。
    const again = h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A"),
      entry("pitfall", "别用表连接", "正文 B"), entry("constraint", "别动镜像", "正文 C")]), {});
    assert.equal(again.created, 3, "every share_external_id slot the pack held is free again");
    assert.equal(again.skipped_existing, 0, "a withdrawn row must not read as 「already imported」");
    assert.deepEqual(again.title_conflicts, [], "the withdrawn pack left no row behind to clash with");
    assert.equal(h.rows().length, 3);
  } finally { h.close(); }
});

test("undo of an unknown pack answers zero, not an error", () => {
  const h = setup();
  try {
    h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A")]), {});
    const genBefore = h.store.getMirrorState().generation;
    const out = h.service.deleteSharePack("0000000000000000", {});
    assert.equal(out.deleted, 0);
    assert.deepEqual(out.sample, []);
    assert.equal(out.pack_id, "0000000000000000");
    assert.equal(h.rows().length, 1, "an id that matches nothing must not delete the pack that is actually in the library");
    assert.equal(h.store.getMirrorState().generation, genBefore,
      "deleting nothing registers no mirror debt — recoverMirror would rewrite the whole mirror for zero rows");
    // 两张皮把对面的输入原样递进来：空串、空格、非字符串都不该抛，也不该摸 store。
    assert.deepEqual(h.service.deleteSharePack("", {}), { pack_id: "", deleted: 0, sample: [] });
    assert.deepEqual(h.service.deleteSharePack("   ", {}), { pack_id: "", deleted: 0, sample: [] });
    assert.deepEqual(h.service.deleteSharePack(undefined, {}), { pack_id: "", deleted: 0, sample: [] });
    assert.deepEqual(h.service.deleteSharePack(42, {}), { pack_id: "", deleted: 0, sample: [] });
    assert.equal(h.writes(), 1, "the four no-op answers above never reach transaction(), so they never notify");
  } finally { h.close(); }
});

// 上限管的是**答复的字节数**不是删除的完整性：这一格要走两张皮（面板 JSON 与 Bearer 数据面
// JSON），一个几千条的包如果把全部标题塞进答复，响应体就比请求还大，而人只需要认前面几条。
// 所以删多少与报多少是两格：deleted 恒为全集，sample 恒为 20 条封顶的前缀。
test("the sample is capped so a huge pack still answers in bounded bytes", () => {
  const h = setup();
  try {
    const many = Array.from({ length: 30 }, (_, i) => entry("pattern", `模式 ${i}`, `正文 ${i}`));
    h.service.importSharePack(pack(many), {});
    const out = h.service.deleteSharePack(PACK_ID, { dryRun: true });
    assert.equal(out.deleted, 30);
    assert.equal(out.sample.length, 20);
    assert.ok(out.sample.every((s) => typeof s.type === "string" && typeof s.title === "string"));
    assert.deepEqual(Object.keys(out.sample[0]).sort(), ["title", "type"],
      "the sample carries only what a human needs to recognise the batch — no ids, no content bytes");
    assert.equal(h.rows().length, 30, "the preview deletes nothing");
    const real = h.service.deleteSharePack(PACK_ID, {});
    assert.equal(real.deleted, 30, "the cap never caps the delete, only the report");
    assert.equal(real.sample.length, 20);
    assert.equal(h.rows().length, 0);
  } finally { h.close(); }
});

// 上一轮评审点名的缺口：现有三把事务锁（saves 里的 fired、排空时刻的 inTx/rows/writesAtFire、
// notifyWrite 次数）数的是「排空那一眼」的形状，所以「在 transaction() 返回之后再补一遍嵌入」
// 那种写法能同时满足它们。这条把锚换成一个等式：**发射次数 == 本次真的写进库的行数**，
// 不多不少，且退出一次都不许发。它能抓住的形状：重复排空（双份嵌入）、给没写成的行做向量（干跑/回滚/
// 未知包）、以及「退出后把剩下的库重嵌一遍」（那既烧收件人的模型额度，也把外来行的向量重新
// 写进已经删掉的行——后者由 searchVector 那一格兜住：向量集合永远只以库为准）。
// 诚实记下它抓不到的那一半：如果实现把入队换成「事务返回后一次性补」，次数与向量列都对得上，
// 本文件所有探针都读不到差别——差别只在 pendingEmbed 有没有被用过，那是 service 闭包内部的
// 事，钉它要动生产代码的可测面，这一刀不换（见报告 leftover）。
test("embeds fire exactly once per row a batch writes, and never for a withdrawal", async () => {
  const h = setup();
  try {
    const first = h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A"), entry("pitfall", "别用表连接", "正文 B")]), {});
    assert.equal(h.fires.length, first.created, "one embed fire per written row, no more");
    const preview = h.service.importSharePack(pack([entry("constraint", "别动镜像", "正文 C")], "桉"), { dryRun: true });
    assert.equal(preview.created, 1);
    assert.equal(h.fires.length, first.created, "a dry run writes no rows, so it must fire no embed");
    const second = h.service.importSharePack(pack([entry("constraint", "别动镜像", "正文 C")], "杉", PACK_ID_2), {});
    assert.equal(h.fires.length, first.created + second.created, "the second pack adds exactly its own rows");
    assert.equal(h.embedded.length, h.fires.length, "no fire is dropped and none is invented");
    assert.equal(await waitFor(() => h.service.embeddedCount() === 3), true, "all three live rows end up vectored");
    const withdrawn = h.store.listBySharePackId(PACK_ID).map((m) => m.id);
    const firesBefore = h.fires.length;
    const out = h.service.deleteSharePack(PACK_ID, {});
    assert.equal(out.deleted, 2);
    assert.equal(h.fires.length, firesBefore,
      "a withdrawal embeds nothing: it writes no row, and re-embedding the survivor would burn the recipient's model quota");
    assert.equal(await waitFor(() => h.service.embeddedCount() === 1), true,
      "the embedding column travels with the row: the two withdrawn rows take their vectors to the grave");
    // 真正的读路径：向量检索的候选集合每次由 SQL 现取（store.searchVector），所以退出的行
    // 不可能以「有向量的僵尸」身份回来。桩向量的余弦对任何 [0, n] 都是 1，这里要的就是
    // 「全都入选」的宽口径，好让行数差直接显形。
    const hits = h.service.searchVector([0, 1], { limit: 10, threshold: 0 });
    assert.equal(hits.length, 1, "the withdrawn rows are invisible to vector recall");
    assert.equal(hits[0].share_pack_id, PACK_ID_2);
    for (const id of withdrawn) assert.equal(h.store.getById(id), undefined);
  } finally { h.close(); }
});

// 分块锁（SQLite 一条语句最多绑 32766 个参数，SQLITE_MAX_VARIABLE_NUMBER）。车道 A 的水位
// 按字节不按条数（MAX_PACK_BYTES = 3 MiB），所以「正文很短、条数很多」的包理论上能逼近那一格，
// 而一条语句撞上限是整笔回滚 = 这个包永远撤不掉。这里不测 32766 本身（那要 32767 行真数据），
// 测的是分块这件事真的发生了：600 行的包由**多条** DELETE 承担，每条绑的 `?` 严格少于全集，
// 而绑数之和正好是 600（没有漏删的块、没有重复的块）。
// 它防的回归：把 deleteBySharePackId 换回单条 IN（deletes.length 变 1、那条的绑数变 600）；
// 以及「只删了第一块」那种半吊子分块（deleted 变 500、绑数之和变 500）。
// 诚实记录这块观测的边界：它只数 DELETE FROM memories 的语句形状，不改任何返回值；chunk 尺寸
// 若哪天被调到 ≥600，本用例会转红，那时把包加大而不是把断言调松——断言的意思是「一条语句
// 绑不下整个包」，不是「chunk 等于 500」。
test("a pack larger than one IN chunk is withdrawn in chunks that each bind less than the whole set", () => {
  const h = setup();
  try {
    // 600 行由 store.save 直接落，不走 importSharePack：这条锁的是**删**那一侧的语句形状，
    // 而本文件的嵌入探针每次发射都要全表数一遍行数（见 setup 里的 fires.rows），600 行走完整
    // 导入会把用例变成 600×600 的读、测的还是导入侧（30 行那条已经覆盖）。落库带的那几列
    // （source / share_pack_id / share_external_id / epistemic_status）与导入路径逐字同一套，
    // 所以删除面读到的形状不是假的。
    const many = Array.from({ length: 600 }, (_, i) => entry("pattern", `模式 ${i}`, `正文 ${i}`));
    for (const e of many) {
      h.store.save({ type: e.type, title: e.title, content: e.content, tags: e.tags, importance: e.importance,
        epistemic_status: e.epistemic_status, source: IMPORTED_SOURCE, agent_scope: null, workspace_scope: null,
        share_pack_id: PACK_ID, share_external_id: e.external_id });
    }
    assert.equal(h.rows().length, 600, "the multi-chunk path needs a pack bigger than one chunk to exist at all");
    // 观测点：临时给这条连接的 prepare 加一层记账（取完立刻还原，见 finally）。store 内部
    // 调的是 db.prepare(...)，属性查找在调用那一刻发生，所以自己的这一层会先被命中；
    // delete 之后原型上的方法照原样回来。不改任何返回值，也不留第二份实现。
    const db = h.store.db;
    const originalPrepare = db.prepare;
    const sqls = [];
    db.prepare = function (sql) { sqls.push(sql); return originalPrepare.call(this, sql); };
    let out;
    try {
      out = h.service.deleteSharePack(PACK_ID, {});
    } finally {
      delete db.prepare;
    }
    assert.equal(db.prepare, originalPrepare, "the observation must be taken back off the connection");
    assert.equal(out.deleted, 600, "chunking must not lose a row, and must not report a chunk's count as the total");
    assert.equal(h.rows().length, 0, "every chunk is really deleted, not just the first one");
    // 两条 IN 都得分块：memories 与 memory_provenance 绑的是同一份 id 快照，只分其中一条
    // 等于另一半还挂着那个上限。
    for (const prefix of ["DELETE FROM memories WHERE id IN (", "DELETE FROM memory_provenance WHERE memory_id IN ("]) {
      const statements = sqls.filter((sql) => sql.startsWith(prefix));
      const bound = statements.map((sql) => (sql.match(/\?/g) || []).length);
      assert.ok(bound.length >= 2, `${prefix}… must run as more than one statement for a 600-row pack (saw ${bound.length})`);
      assert.equal(bound.reduce((sum, n) => sum + n, 0), 600,
        `${prefix}… chunks must partition the id set: nothing deleted twice, nothing left out`);
      for (const n of bound) assert.ok(n < 600, `one statement bound all ${n} ids — that is the unbounded IN list this lock exists to stop`);
    }
    // 整包的 UNIQUE 槽位随分块一起释放（最后一块最容易漏：它绑的是余数）。
    h.store.save({ type: "pattern", title: "模式 0", content: "撤完还能再落回同一格",
      source: IMPORTED_SOURCE, share_pack_id: PACK_ID, share_external_id: many[0].external_id });
    assert.equal(h.store.getByShareExternalId(many[0].external_id).content, "撤完还能再落回同一格");
    assert.equal(h.rows().length, 1);
  } finally { h.close(); }
});
