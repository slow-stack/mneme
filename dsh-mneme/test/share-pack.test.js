// 分享包纯核心的形状锁。这个文件盯五类回归：
//   a) 进包的字段集合只许是白名单那几样 —— 少带是本意（不带 id / 向量 / 热度 / 本机
//      scope），多带就是泄露；所以这里锁「不含什么」比锁「含什么」更要紧。row 侧与
//      pack 侧各钉一条：白名单是逐层收窄的，只锁一层就有一层可以顺手放宽。
//   b) 幂等键的派生必须与接收侧重算一致（车道 C 靠它），改一个参数顺序就是破坏
//      所有已发出去的包。键里有内容锚（第四格），且「用的是进包的那对值」由包自己
//      证明——拿遮之前的标题去铸，收侧一律判成手改包。键里没有 scope，所以同键的孪生行
//      是常态：出包侧折叠成一条、`report.deduped` 记账，包内每个 id 必须互不相同
//      （车道 C 的 share_external_id 是 UNIQUE 索引，包内撞键等于整包回滚）。
//   c) 取行口径：哪些行不进包、以什么原因不进（跳过清单的读数就靠这些字面量），以及
//      不进的那几条返回的 title 也已经是遮过 home 的 —— 清单会进包体、会上终端；整行
//      命中密钥判据的那几条连标题都不许给（标题往往是那条凭据的回声）。
//   d) 分享边界用的是未门控的文本扫描面 —— 换成 config 门控的那个工厂，用户没开
//      写入闸门就等于裸发整库（静态锁，见最后一条用例）。
//   e) 打包口径逐条钉死：水位量的是**最终序列化字节**（不是条数也不是字符数——中文差
//      三倍，按字符数判等于把 413 留给对面）；skip_list 截断后计数仍须是全量（截的是
//      清单不是账）；filters 是分享者的显式收窄，既不进跳过计数也不进清单（进了就说谎：
//      她没跳过，是她自己选的），type 与 tag 同形（字符串或数组都算收窄、多值取任一，
//      空白与空数组才算没填），且形状读不懂的 filters 只许当收窄、不许当放行（那侧
//      错的方向是把整库发出去）；alias 缺省恒为空串，绝不拿本机身份猜一个填上——那是
//      这份格式里唯一一处会替人自报家的字段。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SHARE_KIND, deriveExternalId, createHomeRedactor, classifyRowForShare, buildSharePack
} from "../src/share.js";

test("pack kind is the versioned literal the receiver keys on", () => {
  assert.equal(SHARE_KIND, "mneme.share/v1");
});

test("external_id is 16 hex chars and stable per (pack, type, title, content anchor)", () => {
  const a = deriveExternalId("abcdef0123456789", "decision", "选 SQLite", "9f2c0b1a");
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, deriveExternalId("abcdef0123456789", "decision", "选 SQLite", "9f2c0b1a"));
});

test("external_id separates fields with NUL so concatenation cannot collide", () => {
  // 无分隔拼接时 ("ab","c") 与 ("a","bc") 同键 —— 这类碰撞在幂等表上就是静默串号。
  assert.notEqual(deriveExternalId("p", "ab", "c", "h"), deriveExternalId("p", "a", "bc", "h"));
  assert.notEqual(deriveExternalId("p1", "t", "x", "h"), deriveExternalId("p2", "t", "x", "h"));
  // 第四格也吃同一套切法：("x","h") 与 ("xh","") 不许同键。
  assert.notEqual(deriveExternalId("p", "t", "x", "h"), deriveExternalId("p", "t", "xh", ""));
});

test("external_id strips NUL out of the fields themselves", () => {
  // 分隔符只保证「字段之间」的切法唯一；字段自己含 U+0000 时切点又回到字节手里，
  // ("t","a\\0b") 与 ("t\\0a","b") 拼出同一串。接收侧（车道 C）按包内字节重算的就是
  // 这一串，所以两个键相等的后果是「这条已被吃过」——该建的行静默不建。
  // 归一放在 deriveExternalId 内部而不是调用方：铸造与重算必须共用一个口径。
  assert.notEqual(deriveExternalId("p", "t", "a\u0000b", "h"), deriveExternalId("p", "t\u0000a", "b", "h"));
  assert.notEqual(deriveExternalId("p\u0000a", "t", "x", "h"), deriveExternalId("p", "a\u0000t", "x", "h"));
  assert.notEqual(deriveExternalId("p", "t", "x", "a\u0000b"), deriveExternalId("p", "t", "x\u0000a", "b"));
  // 剥的只有 U+0000：trim 的空白口径不许跟着变，否则已发出去的键会全体漂移。
  assert.equal(deriveExternalId("p", "t", " x ", "h"), deriveExternalId("p", "t", "x", "h"));
});

test("the content anchor is part of the key, and a missing one normalizes stably", () => {
  // 同 type 同 title、正文不同的两条在库里是两条合法记忆（去重键含 content_hash，
  // store.js:1233）。键不含内容锚时这两条铸出同一个 external_id，收侧的先查后跳过
  // 会漏掉第二条，而 report.included 已经说了 2。
  assert.notEqual(deriveExternalId("p", "t", "x", "hash-one"), deriveExternalId("p", "t", "x", "hash-two"));
  assert.notEqual(deriveExternalId("p", "t", "x", "hash-one"), deriveExternalId("p", "t", "x", ""));
  // 缺锚（store 没算过 content_hash 的行）也要一个稳定值：JSON 里没有 undefined，
  // 收侧只会看到 null，两者不许铸出两个键。
  assert.equal(deriveExternalId("p", "t", "x"), deriveExternalId("p", "t", "x", null));
  assert.equal(deriveExternalId("p", "t", "x", undefined), deriveExternalId("p", "t", "x", ""));
});

const row = (over = {}) => ({
  id: "11111111-1111-1111-1111-111111111111", type: "decision", title: "t", content: "c",
  tags: [], importance: 3, archived: 0, forgotten: 0, source: "session",
  agent_scope: null, workspace_scope: null, created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z", ...over
});

test("home redaction covers both separators and is case-insensitive", () => {
  const home = "/fake/home/alex";
  const redact = createHomeRedactor(home);
  assert.equal(redact(`read ${home}/docs/a.md`), "read ~/docs/a.md");
  assert.equal(redact(`read ${home.split("/").join("\\")}\\docs\\a.md`), "read ~/docs\\a.md");
  assert.equal(redact(`read ${home.toUpperCase()}/x`), "read ~/x");
  assert.equal(redact("nothing here"), "nothing here");
});

test("a windows homedir is redacted however the body spells it", () => {
  // homedir() 在 Windows 上给反斜杠，正文里同一目录却常被写成斜杠（Node 两边都收，
  // 模型输出的路径两种都有）。只按 base 的方向匹配 = 另一半原样进包，泄露的是用户名。
  const redact = createHomeRedactor("C:\\Users\\alex");
  assert.equal(redact("read C:\\Users\\alex\\docs\\a.md"), "read ~/docs\\a.md");
  assert.equal(redact("read C:/Users/alex/docs/a.md"), "read ~/docs/a.md");
  assert.equal(redact("home is c:/USERS/Alex"), "home is ~");
  // 已知取舍：前缀没有名字边界，所以 `/Users/alex` 会把邻居目录 `/Users/alexandra`
  // 一起吃掉。这一侧错的方向是**多遮**（永远不泄露），另一侧错的方向才是泄露，
  // 所以这里不加边界。真要加，改的是这一行——别顺手改成静默行为。
  assert.equal(redact("C:/Users/alexandra/x"), "~andra/x");
});

test("the JSON-escaped spelling of a windows home is redacted too", () => {
  // 正文里用 JSON 或引号包一段 Windows 路径时，落库的字节是双反斜杠（`C:\\Users\\alex`）。
  // 它既不是 base 也不是那两个单分隔符形态，两边都不匹配 —— 于是用户名原样进包，而
  // 这份包的设计前提正是不含它。漏的这一类跟「只补一个方向」是同一类错：判据按一种
  // 拼法写，现实里同一目录有三种拼法。
  const redact = createHomeRedactor("C:\\Users\\alex");
  assert.equal(redact('{"path": "C:\\\\Users\\\\alex\\\\notes.md"}'), '{"path": "~/\\notes.md"}');
  assert.equal(redact("read C:\\\\Users\\\\alex"), "read ~");
  // 已知取舍（同上条）：折掉的仍是「前缀 + 紧跟的一个分隔符」，多出来那个反斜杠按原样
  // 留着——不改写用户写下的其余字节。这一条锁的是「不泄露」，不是「输出好看」。
  assert.ok(!redact("C:\\\\Users\\\\alex\\\\secrets").includes("alex"), "escaped home prefix leaked");
  // 泄露的是进包的那条路径，所以在进包口径上也钉一次：同一个 redact，不补第二刀。
  const shipped = classifyRowForShare(row({ content: '{"p": "C:\\\\Users\\\\alex\\\\a.md"}' }), { redact });
  assert.equal(shipped.include, true);
  assert.ok(!JSON.stringify(shipped.row).includes("alex"), "escaped home prefix shipped in the pack");
});

test("the redactor matches separator runs, so no escaping depth survives", () => {
  // 按固定拼法打补丁是隐私函数的错法：同一目录在正文里有的是字节写法（单反斜杠、JSON
  // 转义、混合、二次编码），漏一种就漏用户名，而「补到哪一种」永远追着现实跑。判据
  // 换成段间游程（至少一个分隔符、个数不限）之后，转义层数不再是判据，一整类一起关掉。
  const redact = createHomeRedactor("C:\\Users\\alex");
  const bs = (n) => "\\".repeat(n);
  for (const n of [1, 2, 3, 4, 8]) {
    assert.ok(
      !redact(`read C:${bs(n)}Users${bs(n)}alex${bs(n)}notes.md`).includes("alex"),
      `home leaked at ${n} separators per join`
    );
  }
  // 混合（前一处两个、后一处一个）与二次编码是手写 JSON 时最容易落库的两种，也是上一版
  // 「三个固定形态」恰好都够不着的那两种。
  assert.ok(!redact(`read C:${bs(2)}Users${bs(1)}alex${bs(2)}a.md`).includes("alex"), "home leaked through mixed escaping");
  assert.ok(!redact(`{"p": "C:${bs(4)}Users${bs(2)}alex${bs(3)}x"}`).includes("alex"), "home leaked through doubly-encoded escaping");
  // 前缀带尾分隔符时（`homedir()` 一般不给，但配置里写出来的人不少）：尾那个不许变成
  // 「必须存在」的条件，否则正文里没写尾斜杠的那条照常漏。
  assert.ok(!createHomeRedactor("C:\\Users\\alex\\")("home C:\\Users\\alex\\p").includes("alex"), "trailing-separator home leaked");
  // 已知取舍：游程要求段间**至少一个**分隔符，所以 `C:Users` 这种无分隔写法不命中。
  // 那不是同一目录的另一种拼法（Node 与 JSON 都不产它），要命中只能拆掉前缀的全部约束，
  // 而这一侧错的方向是泄露。锁在这里，免得日后当 bug 顺手加回来。
  assert.equal(redact("C:Usersalex is not a path"), "C:Usersalex is not a path");
});

test("an empty or weird homedir never turns content into mangled text", () => {
  const redact = createHomeRedactor("");
  assert.equal(redact("keep this"), "keep this");
  // 全是分隔符的 home（`//`）若照原样进游程，拼出来的正则会把正文里的斜杠都吃成 `~/`。
  assert.equal(createHomeRedactor("//")("a // b"), "a // b");
});

test("archived, forgotten and out-of-scope types are skipped with a reason", () => {
  assert.equal(classifyRowForShare(row({ archived: 1 }), {}).reason, "archived");
  assert.equal(classifyRowForShare(row({ forgotten: 1 }), {}).reason, "forgotten");
  assert.equal(classifyRowForShare(row({ type: "document" }), {}).reason, "readonly_type");
  assert.equal(classifyRowForShare(row({ type: "summary" }), {}).reason, "excluded_type");
  assert.equal(classifyRowForShare(row(), {}).include, true);
});

test("a skipped row's title comes back redacted, from here", () => {
  // 跳过清单不是「只在本地看」的：buildSharePack 把 verdict.title 原样写进
  // pack.report.skip_list，CLI 又把这份清单打到终端，413 那次拒发还带着同一份 report。
  // 一条标题里带本机 home 前缀的记忆只要不进包，未脱敏的 title 就把用户名装进了那份
  // 「设计上不含它」的文件。所以在源头遮，消费方才不必各自补第二刀（也才没有「忘了补」
  // 这一类回归可犯）。
  const redact = createHomeRedactor("/fake/home/alex");
  const leanOn = (over) => classifyRowForShare(row({ title: "/fake/home/alex/退路方案", ...over }), { redact });
  for (const [over, reason] of [
    [{ archived: 1 }, "archived"],
    [{ forgotten: 1 }, "forgotten"],
    [{ type: "document" }, "readonly_type"],
    [{ type: "summary" }, "excluded_type"]
  ]) {
    const verdict = leanOn(over);
    assert.equal(verdict.reason, reason);
    assert.equal(verdict.title, "~/退路方案");
    assert.ok(!verdict.title.includes("alex"), "leaked home prefix in skip title");
  }
  // sensitive 这一档换了出口：标题恒为空串。上一版在这里断言 `~/退路方案`，那是错的
  // 期待——命中密钥判据的行，它的标题正是那条凭据的回声，遮 home 遮不掉它（见下一条）。
  const sensitive = leanOn({ content: "key sk-abcdefghijklmnopqrstuvwxyz012345" });
  assert.equal(sensitive.reason, "sensitive");
  assert.equal(sensitive.title, "", "a credential-bearing row must not hand over its title");
});

test("a credential-bearing row never contributes its title, whatever the skip reason was", () => {
  // 最终评审的复现（对出货代码跑的，不是对某个中间态）：一条**因非敏感原因**被跳过的行
  // ——归档位——标题里写着一句人话的口令提示，正文里是 `password: <那个值>`。旧写法把
  // scanSensitive 留在 classifyRowForShare 末尾，前面那五个跳过分支早就带着标题 return
  // 了，于是 `skip_list` 里原样出现「生产库密码 P@ssw0rd-for-prod-db 别丢」，而这份清单
  // 是随包外发的（整库被水位拒掉那次，413 答复里也带同一份 report）。
  // 断言写成「整个包里找不到那个值」，而不是「那一条记录的 title 为空」：后者只锁住
  // skip_list 一格，包体还有 memories、别名与 413 那条 report 副本。
  const secret = "P@ssw0rd-for-prod-db";
  const rows = [
    row({ title: `生产库密码 ${secret} 别丢`, content: `password: ${secret}`, archived: 1 }),
    row({ title: `老库口令 ${secret}`, content: `api_key = ${secret}abcdefgh`, forgotten: 1 }),
    row({ title: `${secret} 的指针`, content: `secret: ${secret}`, type: "document" }),
    row({ title: `${secret} 的总览`, content: `token: ${secret}`, type: "summary" }),
    // sensitive 那一档也照同一句口径：以前它给的是遮过 home 的标题，同样原样外发。
    row({ title: `生产库密码 ${secret} 别丢`, content: `password: ${secret}` }),
    // 对照组：同一批里一条干净的归档行，标题照旧要给——否则这条锁只是「全都不给」。
    row({ title: "干净的归档行", content: "没有凭据", archived: 1 })
  ];
  const { pack } = packInput(rows);
  const text = JSON.stringify(pack);
  assert.ok(!text.includes(secret), "a credential leaked into the shipped pack");
  assert.deepEqual(pack.report.skip_list, [
    { title: "", reason: "archived" },
    { title: "", reason: "forgotten" },
    { title: "", reason: "readonly_type" },
    { title: "", reason: "excluded_type" },
    { title: "", reason: "sensitive" },
    { title: "干净的归档行", reason: "archived" }
  ]);
  // 原因归属不许被这次收紧带跑：判序照旧（空白/噪声仍先于敏感，见上一条用例的顺序锁），
  // 这里只是不给标题，不是给另一个原因。
  assert.deepEqual(pack.report.skipped, {
    archived: 2, forgotten: 1, readonly_type: 1, excluded_type: 1, blank_or_noise: 0, sensitive: 1
  });
  assert.equal(pack.report.included, 0);
});

test("a credential in the body drops the whole row instead of redacting it", () => {
  // 就地打码会造出一条读不通的半截记忆；整条不进 + 跳过清单里看得见标题，才是
  // 分享者能复核的形态（spec §4）。
  const hit = classifyRowForShare(row({ content: "key sk-abcdefghijklmnopqrstuvwxyz012345" }), {});
  assert.equal(hit.include, false);
  assert.equal(hit.reason, "sensitive");
});

test("a blank memory is skipped as blank_or_noise before the sensitive check", () => {
  // 空白/噪声的唯一判据是 informationlessReason（src/write-admission.js:117），它按
  // title+content 的**组合**口径判：两侧归一后都不剩字才算命中（"blank" 全空、
  // "noise" 只剩标点）。组合口径答的是「这条写入有没有信息」，分享边界要答的是「对面吃不吃得下」，
  // 所以 share 在这一格里另加一条：正文 trim 后为空就是空白行。
  assert.equal(classifyRowForShare(row({ title: "", content: "" }), {}).reason, "blank_or_noise");
  assert.equal(classifyRowForShare(row({ title: "", content: "   " }), {}).reason, "blank_or_noise");
  assert.equal(classifyRowForShare(row({ title: "...", content: "---" }), {}).reason, "blank_or_noise");
  assert.equal(classifyRowForShare(row({ title: "有标题", content: undefined }), {}).reason, "blank_or_noise");
  assert.equal(classifyRowForShare(row({ title: "有标题", content: null }), {}).reason, "blank_or_noise");
  // 组合口径的另一面**在分享边界上翻了**（最终评审第 3 条）：上一版这里断言
  // 「标题有字、正文空白」那条 include === true，那是把判据本意当成了出口本意。收侧的
  // content 列 NOT NULL，车道 C 还逐条校验非空（spec §5），一条空正文不是少发一条，是
  // 把整包毒掉——校验不过就什么都不导入，对面手里只有一个报错的包。原因键仍是这六个
  // （多开第七个要同时改 docs 表、CLI 档位名和计数锁），而「它没有正文」本来就是空白的意思。
  assert.equal(classifyRowForShare(row({ content: "   " }), {}).reason, "blank_or_noise");
  // 反过来，正文有一个字就该进：这条锁的是「新判据不许把有正文的行一起挡掉」。
  assert.equal(classifyRowForShare(row({ content: "一个字" }), {}).include, true);
  // 顺序锁（空白先于敏感）：判据只看 title/content，扫描面却含 tags，所以一条正文
  // 为空、标签里带凭据的记忆两条都命中。报 blank_or_noise 才是对的原因 —— 没有正文
  // 就没有可泄露的东西，记成 sensitive 会让跳过清单的读数把用户指向错的那一类。
  assert.equal(
    classifyRowForShare(row({ title: "", content: "", tags: ["sk-abcdefghijklmnopqrstuvwxyz012345"] }), {}).reason,
    "blank_or_noise"
  );
});

test("a pack never ships a memory whose content is blank", () => {
  // 上一条锁的是单行判定，这条锁的是出口：车道 C 按 spec §5 逐条校验 content 非空，
  // 包里混进一条空正文 = 校验不过 = 整包一条都不入库。空正文在这个口径下不是「少发一条」，
  // 是「这一包废了」，所以它必须在出包侧就没掉。
  const { pack } = packInput([
    row({ title: "有标题", content: "   " }),
    row({ type: "history", title: "有标题", content: "" }),
    row({ type: "pattern", title: "正常一条", content: "有正文" })
  ]);
  assert.equal(pack.report.included, 1);
  assert.equal(pack.report.skipped.blank_or_noise, 2);
  for (const m of pack.memories) assert.ok(String(m.content).trim(), `blank content shipped: ${m.title}`);
});

test("the row that enters the pack carries only the whitelisted fields", () => {
  // 锁「不含什么」：id / 向量 / 热度 / source / 本机 scope 一律不带。agent_scope 与
  // workspace_scope 是本机目录与项目名，跟着包走就是泄露；对面入库时会按自己的
  // 口径重算这些，带过去只会被当成真相源。
  const out = classifyRowForShare(row({
    agent_scope: "secret-project",
    workspace_scope: "C:\\Users\\alex\\work",
    embedding: [0.1, 0.2],
    heat: 9.5,
    access_count: 42,
    content_hash: "deadbeef"
  }), {});
  assert.equal(out.include, true);
  assert.deepEqual(Object.keys(out.row).sort(), [
    "content", "content_hash", "created_at", "epistemic_status", "importance",
    "tags", "title", "type", "updated_at"
  ]);
  assert.equal(out.row.content_hash, "deadbeef");
});

const packInput = (rows, over = {}) => buildSharePack({
  rows, alias: "桉桉", homeDir: "/fake/home/alex", packageVersion: "0.9.4",
  packId: "abcdef0123456789", generatedAt: "2026-10-22T00:00:00.000Z", ...over
});

test("pack carries the whitelist and nothing else", () => {
  const { pack } = packInput([row({ embedding: "huge", content_history: "[{}]", doc_path: "/x", agent_scope: "/fake/home/alex/p" })]);
  assert.equal(pack.kind, "mneme.share/v1");
  assert.equal(pack.memories.length, 1);
  const m = pack.memories[0];
  for (const banned of ["id", "embedding", "content_history", "doc_path", "agent_scope", "workspace_scope", "sensitivity", "_full_content", "evidence"]) {
    assert.ok(!(banned in m), `pack must not carry ${banned}`);
  }
  assert.equal(m.type, "decision");
  assert.match(m.external_id, /^[0-9a-f]{16}$/);
  // report 的键集合同样是格式的一部分：车道 C 与面板都按这四个键读，多一个是新字段、
  // 少一个是断账（deduped 就是为「included 从此只数实际发出的条数」补的那一格）。
  assert.deepEqual(Object.keys(pack.report), ["included", "deduped", "skipped", "skip_list"]);
});

test("external_id recomputes from the fields that actually ship in the pack", () => {
  // 收侧是按**包内字节**重算这把键的（spec §5），所以「键是从进包的那对值铸的」必须由
  // 包自己证明：拿遮之前的标题、或任何与包内不一致的正文/锚去铸，收侧一律判成手改包而
  // 整包拒绝。这一条不锁任何计数，只锁「铸造侧与包体侧是同一份值」。
  const rows = [
    row({ title: "/fake/home/alex/退路方案", content: "落点 /fake/home/alex/docs/a.md", content_hash: "cafebabe00000000" }),
    row({ type: "history", title: "plain", content: "c", content_hash: null }),
    row({ type: "pattern", title: "同一个标题", content: "一", content_hash: "aaaa0000" }),
    row({ type: "pattern", title: "同一个标题", content: "二", content_hash: "bbbb0000" })
  ];
  const { pack } = packInput(rows);
  assert.equal(pack.report.included, 4);
  for (const m of pack.memories) {
    assert.equal(
      m.external_id,
      deriveExternalId(pack.pack_id, m.type, m.title, m.content_hash),
      `external_id is not recomputable for "${m.title}"`
    );
  }
  // 遮过的标题才是包里那个标题：锁「没拿遮之前的串去铸键」。
  assert.notEqual(
    pack.memories[0].external_id,
    deriveExternalId(pack.pack_id, "decision", "/fake/home/alex/退路方案", "cafebabe00000000")
  );
});

test("two rows sharing type and title still ship two distinct ids", () => {
  // 库里的去重键是 (type, content_hash, agent_scope, workspace_scope, sensitivity)
  // （store.js:1233），所以同 type、同 title、正文不同的两条是两条合法记忆。键里没有
  // 内容锚时它们铸出同一个 external_id：收侧「先查后跳过」把第二条当成已吃过而静默不建，
  // 而 report.included 已经说了 2 —— 包里的账与包里的内容对不上，说谎的是我们。
  const rows = [
    row({ title: "同一个标题", content: "正文一", content_hash: "hash-one" }),
    row({ title: "同一个标题", content: "正文二", content_hash: "hash-two" })
  ];
  const { pack } = packInput(rows);
  assert.equal(pack.report.included, 2);
  // 正文不同 ⇒ 内容锚不同 ⇒ 两把键：这条锁的是「折叠不许把该发的两条折成一条」。
  assert.equal(pack.report.deduped, 0);
  assert.equal(new Set(pack.memories.map((m) => m.external_id)).size, 2);
  assert.deepEqual(
    pack.memories.map((m) => deriveExternalId(pack.pack_id, m.type, m.title, m.content_hash)),
    pack.memories.map((m) => m.external_id)
  );
});

test("rows that collapse to one external_id ship once and the fold is counted", () => {
  // 键是 (pack_id, type, title, content_hash)，**没有 scope**，而库里同 type 同标题同
  // 内容锚、scope 不同的两条是合法的两行（store.js:1233 的去重键吃三维 scope）。于是它们
  // 在包里共用一把键，`included` 却说有两条。发两条的后果不是「对面多一行重复」：车道 C
  // 的 share_external_id 挂 UNIQUE 索引，第二条 INSERT 抛错穿出 runAtomically 的
  // ROLLBACK，**整包吃不进去**；ledger 里那句「重跑就 created=0」救不了它——两次撞的是
  // 同一个死键，那行始终没落库。裁定：出包侧折叠成一条并记账。折叠只可能发生在标题与
  // 内容锚都相同的行上，到对面那台没有 scope 的库里那就是同一条记忆。
  const twin = (over) => row({ title: "同一个标题", content: "同一份正文", content_hash: "same-hash", ...over });
  const { pack } = packInput([
    twin({ agent_scope: "preset-a", workspace_scope: "/fake/home/alex/proj-a" }),
    twin({ agent_scope: "preset-b", workspace_scope: "/fake/home/alex/proj-b" }),
    twin({ agent_scope: null, workspace_scope: null }),
    row({ type: "history", title: "另一条", content: "别的正文", content_hash: "other-hash" })
  ]);
  assert.equal(pack.report.included, 2, "included 从此是「实际发出的条数」");
  assert.equal(pack.report.deduped, 2, "折叠掉的必须记账，否则这份账还是少两条");
  assert.equal(pack.memories.length, 2);
  // 包内每个 id 互不相同：这条是车道 C 那份 UNIQUE 索引在出包侧的前置条件。
  assert.equal(new Set(pack.memories.map((m) => m.external_id)).size, pack.memories.length);
  // 留下的是哪一条不重要（标题/正文/锚三者相同），但它必须自己能被重算——收侧是按包内
  // 字节验键的，折叠不许顺手改掉任何字段。
  assert.equal(pack.memories[0].external_id, deriveExternalId(pack.pack_id, "decision", "同一个标题", "same-hash"));
  assert.equal(pack.memories[0].content, "同一份正文");
});

test("report counts every skip reason and caps the list it shows", () => {
  const rows = [
    row({ type: "decision", title: "keep" }),
    row({ type: "preference", archived: 1 }),
    row({ type: "history", forgotten: 1 }),
    row({ type: "document" }),
    row({ type: "summary" }),
    // 空白这一条要标题也没字：informationlessReason 是 title+content 的**组合**口径
    // （上面 A2 那条用例锁过「标题有字、正文空白照常进包」），只空正文的话这一格永远是 0。
    row({ type: "pattern", title: "", content: "   " })
  ];
  const { pack } = packInput(rows);
  assert.equal(pack.report.included, 1);
  assert.deepEqual(pack.report.skipped, {
    archived: 1, forgotten: 1, readonly_type: 1, excluded_type: 1, blank_or_noise: 1, sensitive: 0
  });
  assert.ok(pack.report.skip_list.every((s) => typeof s.title === "string" && typeof s.reason === "string"));
});

test("skip list truncates but the counters stay exact", () => {
  const rows = Array.from({ length: 80 }, (_, i) => row({ type: "history", archived: 1, title: `a${i}` }));
  const { pack } = packInput(rows);
  assert.equal(pack.report.skipped.archived, 80);
  assert.equal(pack.report.skip_list.length, 50);
});

test("a pack over the water mark is refused with the measured size", () => {
  const rows = [row({ content: "字".repeat(2_000_000) })];
  const out = packInput(rows);
  assert.equal(out.ok, false);
  assert.equal(out.error, "too-large");
  assert.ok(out.bytes > out.limitBytes);
});

test("filters narrow what goes in without touching the reason counters", () => {
  const rows = [row({ type: "decision", title: "a" }), row({ type: "preference", title: "b" })];
  const byType = packInput(rows, { filters: { type: ["decision"] } });
  assert.equal(byType.pack.report.included, 1);
  assert.equal(byType.pack.memories[0].title, "a");
  const byTag = packInput([row({ type: "decision", title: "a", tags: ["keep"] })], { filters: { tag: "keep" } });
  assert.equal(byTag.pack.memories[0].tags.includes("keep"), true);
  const byTagMiss = packInput([row({ type: "decision", title: "a", tags: ["other"] })], { filters: { tag: "keep" } });
  assert.equal(byTagMiss.pack.report.included, 0);
});

test("filters.tag given as an array narrows, exactly like type does", () => {
  // 重复的 `--tag` 是 CLI 最自然的形状（`--tag a --tag b` → ["a","b"]）。只认裸字符串时
  // 这一串读成「没填」= 整库通过 tag 检查 —— 与 type 那一格是同一个洞，错的方向同样是
  // 多发。裁定：tag 与 type 同形，字符串或数组都算收窄，多值取「任一」（与 type 的集合
  // 口径一致），空白与空数组才算没填。
  const rows = [
    row({ title: "a", tags: ["keep"] }),
    row({ title: "b", tags: ["other"] }),
    row({ title: "c", tags: ["keep", "later"] }),
    row({ title: "d" })
  ];
  const one = packInput(rows, { filters: { tag: ["keep"] } });
  assert.equal(one.pack.report.included, 2);
  assert.deepEqual(one.pack.memories.map((m) => m.title), ["a", "c"]);
  const both = packInput(rows, { filters: { tag: ["keep", "other"] } });
  assert.equal(both.pack.report.included, 3);
  const miss = packInput(rows, { filters: { tag: ["zzz"] } });
  assert.equal(miss.pack.report.included, 0);
  assert.deepEqual(miss.pack.report.skip_list, []);
  // 裸字符串仍是收窄（上一格的原口径，不许因为加了数组就把串读回「没填」）。
  assert.equal(packInput(rows, { filters: { tag: "keep" } }).pack.report.included, 2);
});

test("a row the filter removes never reaches the classification step", () => {
  // 后三条在口径上本来就必被跳过（archived / forgotten / document 只读 / summary 排除），
  // 同时又 type 筛掉。谁把过滤挪到 classifyRowForShare 之后，这里就会冒出 archived:1
  // 之类的读数，并把她亲手筛掉的行打进跳过清单 —— 那份账要说的是「本可以发、因为口径
  // 没发」，混进「她自己没选」就是说谎。
  const rows = [
    row({ type: "decision", title: "keep" }),
    row({ type: "preference", title: "/fake/home/alex/已归档", archived: 1 }),
    row({ type: "history", title: "已遗忘", forgotten: 1 }),
    row({ type: "document", title: "指针行" }),
    row({ type: "summary", title: "总览" })
  ];
  const ALL_ZERO = {
    archived: 0, forgotten: 0, readonly_type: 0, excluded_type: 0, blank_or_noise: 0, sensitive: 0
  };
  const { pack } = packInput(rows, { filters: { type: ["decision"] } });
  assert.equal(pack.report.included, 1);
  assert.deepEqual(pack.report.skipped, ALL_ZERO);
  assert.deepEqual(pack.report.skip_list, []);
  // tag 那一侧同理：被筛掉的行也不许进账。
  const tagged = packInput(
    [row({ title: "keep", tags: ["keep"] }), row({ title: "gone", tags: ["other"], archived: 1 })],
    { filters: { tag: ["keep"] } }
  );
  assert.deepEqual(tagged.pack.report.skipped, ALL_ZERO);
  assert.deepEqual(tagged.pack.report.skip_list, []);
});

test("a filter shape this function can't read never widens to the whole library", () => {
  // 出口把 `--type` 传成数组还是裸字符串不由这里决定（CLI 一个旗标给字符串、面板多选给
  // 数组都说得通）。能决定的是：读得懂的收窄意图不许因为形状不对就当「没筛」——那侧
  // 错的方向是**多发**，分享者以为只发了一类，实际把整库发了出去。
  const rows = [row({ type: "decision", title: "a" }), row({ type: "preference", title: "b" })];
  const byString = packInput(rows, { filters: { type: "decision" } });
  assert.equal(byString.pack.report.included, 1);
  assert.equal(byString.pack.memories[0].type, "decision");
  // 反过来，「填了但只剩空白」是**没填**，与空数组同口径：读成筛成空包才是说谎。
  assert.equal(packInput(rows, { filters: { type: "  ", tag: "" } }).pack.report.included, 2);
  assert.equal(packInput(rows, { filters: { type: [], tag: "   " } }).pack.report.included, 2);
  // 同一条规则要覆盖数组里的空白：一次 CLI 调用不该因为出口给串还是给数组而读出两种结果。
  assert.equal(packInput(rows, { filters: { type: ["", "  "], tag: [""] } }).pack.report.included, 2);
  // 两侧同形之后条目还须各自归一：`--type " decision "` 是同一个类型，不是「谁都不匹配」。
  assert.equal(packInput(rows, { filters: { type: [" decision ", ""] } }).pack.report.included, 1);
  // 字符串以外的标量（面板串错字段、body 写错类型）留在集合里 → 收窄到 0 条。这一侧错的
  // 方向是少发，report 与 stdout 都看得见；「认不出就当没填」才是把整库发出去。
  assert.equal(packInput(rows, { filters: { type: 123 } }).pack.report.included, 0);
  assert.equal(packInput(rows, { filters: { tag: { 0: "keep" } } }).pack.report.included, 0);
});

test("alias defaults to the neutral label, never to a guessed identity", () => {
  const out = buildSharePack({ rows: [row()], homeDir: "/fake/home/alex", packageVersion: "0.9.4", packId: "p", generatedAt: "2026-10-22T00:00:00.000Z" });
  assert.equal(out.pack.alias, "");
});

test("the share filter uses the ungated scanner, never the gated factory", () => {
  // spec §4：分享边界本身就是安全边界。`createSensitiveScan({config})` 在
  // `sensitiveScanEnabled` 关时返回 null（`src/sensitive-scan.js:199`），谁要是把
  // 这里「顺手统一」成工厂，用户没开写入闸门就等于裸发整库。
  const text = readFileSync(new URL("../src/share.js", import.meta.url), "utf8");
  assert.ok(text.includes("scanSensitive("), "share must scan with the ungated text scanner");
  assert.ok(!text.includes("createSensitiveScan"), "share must not route through the gated factory");
});
