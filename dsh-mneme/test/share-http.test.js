// 分享包的 HTTP 口径。两类回归：
//   a) 口径本身 —— 这张脸有两个入口（宿主内面板路由、standalone Bearer 数据面），
//      任何一处松掉都会同时污染两侧；
//   b) **不许再长出第二份实现**（#410 修好面板侧、数据面停在旧形态的那次教训）。
//      下面的静态锁把「校验字面量只许出现在本模块」写成断言。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseShareBody, shareReply, shareFilename } from "../src/share-http.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(resolve(here, "../src", f), "utf8");
const rows = [
  { id: "a", type: "decision", title: "选 SQLite", content: "正文", tags: [], importance: 4,
    archived: 0, forgotten: 0, created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z" },
  { id: "b", type: "preference", archived: 1, forgotten: 0, title: "归档项", content: "x", tags: [] }
];
const fakeService = { all: () => rows };
const baseArgs = { service: fakeService, packageVersion: "0.9.4", homeDir: "/fake/home/alex", now: () => new Date("2026-10-22T00:00:00.000Z") };

test("bad json and non-object bodies are refused with a code, not a throw", () => {
  assert.deepEqual(parseShareBody(""), { ok: true, options: {} });
  // 没有 body 与空 body 同口径：分享的主用法就是「一个字节都不发，按整库口径打」。
  assert.deepEqual(parseShareBody(undefined), { ok: true, options: {} });
  assert.equal(parseShareBody("{oops").ok, false);
  assert.equal(parseShareBody("[1,2]").ok, false);
});

test("unknown option keys are dropped, not silently accepted", () => {
  const parsed = parseShareBody(JSON.stringify({ alias: "桉", type: ["decision"], color: "red" }));
  assert.equal(parsed.ok, true);
  assert.ok(!("color" in parsed.options));
  // dryRun 单列一条：它曾经是「登记但不参与答复构造」的键（照 reclaim 形状抄来的），
  // 后来删掉——share 纯读、不改库，干跑归 CLI 侧的 --dry-run，服务端没人消费它。留这
  // 一条是挡住「为了兼容把它加回来」的那次提交：发它的客户端拿到的是真包，不是干跑报告。
  assert.ok(!("dryRun" in parseShareBody(JSON.stringify({ dryRun: true })).options));
});

test("reply returns the pack body with kind and disposition-ready filename", () => {
  const { status, body } = shareReply({ ...baseArgs, options: {} });
  assert.equal(status, 200);
  assert.equal(body.kind, "mneme.share/v1");
  assert.equal(body.report.included, 1);
  assert.equal(body.report.skipped.archived, 1);
  assert.match(shareFilename("abcdef0123456789", () => new Date("2026-10-22T00:00:00.000Z")), /^dsh-mneme-share-20261022-abcdef01\.json$/);
  // 不给时钟就走本机当日：文件名是给人存的，日期缺一位就成了「未知日期的包」。
  assert.match(shareFilename("abcdef0123456789"), /^dsh-mneme-share-\d{8}-abcdef01\.json$/);
});

test("oversized packs answer 413 with the measured size and the batching hint", () => {
  const secret = "P@ssw0rd-for-prod-db";
  const fat = [
    { id: "f", type: "decision", title: "t", content: "字".repeat(2_000_000), tags: [], archived: 0, forgotten: 0 },
    // 这条是给「拒发也带 report」那格用的：整库被水位挡下时，出口照样看得见跳过清单，
    // 而清单随答复体外发——含凭据那行的标题必须在源头就留空，不然这一路是第二次泄露。
    { id: "s", type: "decision", title: `生产库密码 ${secret} 别丢`, content: `password: ${secret}`, tags: [], archived: 1, forgotten: 0 }
  ];
  const out = shareReply({ ...baseArgs, service: { all: () => fat }, options: {} });
  assert.equal(out.status, 413);
  assert.equal(out.body.error, "too-large");
  assert.ok(out.body.bytes > out.body.limitBytes);
  assert.match(out.body.hint, /--type/);
  // 拒答里绝不带 memories：这条路径存在的原因恰恰是包太大，把正文再序列化一遍回去
  // 等于把刚拒绝掉的几 MB 原样发出去（buildSharePack 超限时也把完整 pack 交回，
  // 本层只许取它的 report）。
  assert.ok(!("memories" in out.body), "413 body must not carry the pack body");
  assert.equal(out.body.report.included, 1, "但报告要给全：分批的依据就是这份数");
  assert.ok(!JSON.stringify(out.body).includes(secret), "the refused reply must not ship the credential in a title");
  assert.deepEqual(out.body.report.skip_list, [{ title: "", reason: "archived" }]);
});

test("empty library answers 200 with included 0 — not an error", () => {
  const out = shareReply({ ...baseArgs, service: { all: () => [] }, options: {} });
  assert.equal(out.status, 200);
  assert.equal(out.body.report.included, 0);
  // 出口只给 service/packageVersion/homeDir 也答得出来：now 与 options 都有默认值，
  // 缺省是「整库口径 + 本机此刻」，不是错误。
  const bare = shareReply({ service: { all: () => [] }, packageVersion: "0.9.4", homeDir: "/fake/home/alex" });
  assert.equal(bare.status, 200);
  assert.ok(Number.isFinite(Date.parse(bare.body.generated_at)), "generated_at 必须是可解析的时刻");
});

test("a filter this layer cannot read narrows the pack, never opens the library", () => {
  // share.js 把「读不懂的形状只许收窄、不许放行」钉死在它那一侧（share-pack.test.js）。
  // 本层是它上游第一个出口：在这里把裸字符串、混合数组当「没填」丢掉，等于把那条洞在
  // HTTP 面上重新挖开——她以为只发了一类，实际整库进了包。所以这一层不做形状归一也不做
  // 形状校验，原样交给 share.js（判据只许有一份）。
  const pair = [
    { id: "1", type: "decision", title: "选 SQLite", content: "正文", tags: ["keep"], archived: 0, forgotten: 0 },
    { id: "2", type: "preference", title: "浅色主题", content: "正文", tags: ["later"], archived: 0, forgotten: 0 }
  ];
  const args = { ...baseArgs, service: { all: () => pair } };
  const optionsOf = (body) => parseShareBody(JSON.stringify(body)).options;
  const includedOf = (body) => shareReply({ ...args, options: optionsOf(body) }).body.report.included;
  assert.equal(includedOf({ type: "decision" }), 1, "type 给成串同样是收窄");
  assert.equal(includedOf({ tag: ["keep"] }), 1, "tag 给成数组同样是收窄");
  assert.equal(includedOf({ type: ["decision", 7] }), 1, "条目里混进非字符串不撤销整条收窄");
  assert.equal(includedOf({ type: [7] }), 0, "全是认不出的条目 = 谁都不匹配，不是没筛");
});

test("a throwing row read answers 500 with a log line instead of leaking out as a rejection", () => {
  // 面板侧 handler 的形状是 `try { return readBody(...).then(...) } catch`：外层 try 在
  // .then 的回调里已经退栈，从共用层抛出去就是一个没人接的 rejection，客户端拿到的不是
  // 500 而是「一个字节都没回」（#410）。兜在共用层里，两张皮才不会因为各自接线不同而
  // 有一种会漏。
  const boom = { all: () => { throw new Error("database is locked"); } };
  const warned = [];
  const out = shareReply({ ...baseArgs, service: boom, options: {}, warn: (m) => warned.push(m) });
  assert.deepEqual(out, { status: 500, body: { error: "internal" } }, "对外只有一个码，不带原始错误文本");
  assert.match(warned.join(" "), /share pack failed/);
  assert.match(warned.join(" "), /database is locked/, "原始错误文本要留在日志里，否则现场无从下手");
  assert.equal(shareReply({ ...baseArgs, service: boom, options: {} }).status, 500, "没有 logger 也不许把异常漏出去");
  // 日志那一环自己是坏的那一环时也一样：这一层的契约是「从不抛」，不是「看调用面有没有
  // .catch」。C6 之前这里是裸调 warn，出包侧的面板路由（车道 A）恰好就少了那一声 .catch，
  // 于是宿主 logger 一抛就成了没人接的 rejection（#410 的形态）。守卫还回层里之后，
  // 三个构造器同一脾气——对称是要点，见 test/share-receive-http.test.js 的那条静态锁。
  const screaming = () => { throw new Error("log sink on fire"); };
  assert.deepEqual(shareReply({ ...baseArgs, service: boom, options: {}, warn: screaming }),
    { status: 500, body: { error: "internal" } }, "warn 自己抛时仍须把已经算好的 500 交出去");
});

test("the share literals live in the share modules only", () => {
  const FORKED = ["mneme.share/v1", "too-large", "parseShareBody", "shareReply"];
  for (const lit of FORKED) {
    assert.ok(src("share-http.js").includes(lit) || src("share.js").includes(lit), `${lit} must live in the share modules`);
  }
});

// 两张皮都接上之后才补得了这条（A4 时数据面还没有 /share，锁无可锁）。
// 上一条只管「字面量别在别处冒出来」，这条管反方向：两面必须真的**调**共用构造器。
// #411 那次是面板侧修好了、数据面停在复制的旧形态——复制出去的代码不会留下任何
// 痕迹让静态检查发现，只有「这一侧不许出现口径、又必须出现 shareReply(」这对双向
// 断言能抓住。
test("both surfaces call the shared builder instead of forking the口径", () => {
  for (const file of ["api.js", "api-standalone.js"]) {
    const text = src(file);
    assert.ok(text.includes("shareReply("), `${file} must call the shared reply builder`);
    for (const lit of ["mneme.share/v1", '"too-large"']) {
      assert.ok(!text.includes(lit), `${file} must not re-implement ${lit}`);
    }
  }
});
