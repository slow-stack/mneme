// CLI 的入库面（C7：receive 与 undo-share）。盯的四条都是「人会踩到」的：
//   a) 不带 --apply 就一个字都不写（照 reclaim 的 confirm 脾气）；
//   b) 包文件是本地读的，CLI 要把**包内容**送上去，不是只送一个路径；
//   c) undo-share 认的是包文件里的 pack_id，不是让人去抄 16 位十六进制；
//   d) 干跑报告里的撞名条数要说出来——那是决策 2 唯一的可见性。
//
// 为什么假服务不自己编答复体：解析与答复壳由**出货的那一层**完成（parseReceiveBody +
// receiveReply、parseUndoBody + undoReply，就是 api-standalone.js 挂 /receive 的同一对
// 函数），只有 service 里的 importSharePack/deleteSharePack 是假的。于是 confirm 的脾气、
// dry_run 的口径、external-id-mismatch 这类错码一漂移，这里当场红——手写字面量的假服务
// 只会把「测试自己编的形状」锁成契约（同 cli-share.test.js 的口径）。数据面自身的路由
// 另有 receive 侧的锁，本文件只管 CLI 这张嘴。
//
// spawn 必须异步：服务跑在本进程里，spawnSync 会堵住事件循环，CLI 只能等到自己 10s 超时
// （maintenance.test.js:23 那条教训，同一个坑不再踩一次）。
//
// 车道 A 留过一条账：清空 DSH_MNEME_URL 会顺着 resolveConfig 回落到
// DEFAULT_URL = 127.0.0.1:8790，漏传 auth 的调用点就会打到用户**活的**实例上。这里每个
// 用例都把 HOME/USERPROFILE 折进临时目录，DSH_MNEME_URL/TOKEN 给的是 fixture 那一面的
// 值而不是清空，旗标也显式给全（下面「漏传旗标」那条用例锁的就是这个 env）。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveExternalId, SHARE_KIND } from "../src/share.js";
import { parseReceiveBody, receiveReply, parseUndoBody, undoReply } from "../src/share-http.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.mjs");
const TOKEN = "cli-receive-test-token";
const PACK_ID = "f0f0f0f0f0f0f0f0";

/** 一个合法的最小包：CLI 原样读、原样送，external_id 用真锚算出来。 */
function packFile(dir, name = "pack.json") {
  const pack = {
    kind: SHARE_KIND, pack_id: PACK_ID, alias: "桉", generated_at: "x", source_version: "0.9.4",
    report: { included: 1, skipped: {}, skip_list: [], deduped: 0 },
    memories: [{
      type: "decision", title: "t", content: "c", tags: [], importance: 3, content_hash: "h",
      external_id: deriveExternalId(PACK_ID, "decision", "t", "h")
    }]
  };
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(pack), "utf8");
  return { path, pack };
}

/**
 * 顶替数据面的假服务：真解析（parseReceiveBody/parseUndoBody 决定 400 错码）、真答复壳
 * （receiveReply/undoReply 决定 dry_run 那一格与错码映射），只有 service 是假的。
 * handlers.importError 让某个用例把导入变成带码失败（receiveReply 顺着
 * SHARE_IMPORT_ERRORS 表回 400），handlers.deleteResult 让某个用例换一份退出读数
 * （样例行数与 deleted 的比例就是 CLI 那句话的唯一输入），假服务自己不编状态码。
 */
async function startPlane(handlers = {}) {
  const state = { requests: [], imports: [], deletes: [] };
  const service = {
    importSharePack(pack, opts) {
      state.imports.push({ pack, dryRun: opts?.dryRun });
      if (handlers.importError) {
        const err = new Error(handlers.importError);
        err.code = handlers.importError;
        err.detail = "index 2";
        throw err;
      }
      return {
        pack_id: PACK_ID, alias: "桉", created: 3, skipped_existing: 1, unchanged: 0,
        title_conflicts: [{ type: "decision", title: "t", existing_id: "own-1" }],
        conflicts_checked: 4
      };
    },
    deleteSharePack(packId, opts) {
      state.deletes.push({ packId, dryRun: opts?.dryRun });
      // 默认那一份够 confirm/dry_run 的锁用；要盯「deleted 远大于列出的样例」这类数字
      // 口径的用例自己带 deleteResult 进来——它仍然只替 service，答复壳还是真 undoReply。
      return handlers.deleteResult ?? { pack_id: packId, deleted: 7, sample: [{ type: "decision", title: "t" }] };
    }
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const { pathname } = new URL(req.url, "http://127.0.0.1");
      state.requests.push({ method: req.method, pathname, auth: req.headers.authorization ?? "", body: text });
      let out;
      try {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) out = { status: 401, body: { error: "unauthorized" } };
        else if (req.method === "POST" && pathname === "/receive") {
          const parsed = parseReceiveBody(text);
          out = parsed.ok
            ? receiveReply({ service, pack: parsed.pack, dryRun: parsed.dryRun })
            : { status: 400, body: { error: parsed.error } };
        } else if (req.method === "POST" && pathname === "/receive/undo") {
          const parsed = parseUndoBody(text);
          out = parsed.ok
            ? undoReply({ service, packId: parsed.packId, dryRun: parsed.dryRun })
            : { status: 400, body: { error: parsed.error } };
        } else out = { status: 404, body: { error: "not-found" } };
      } catch (err) {
        // 漏这一兜，异常就顺着 socket 变成「一个字节都没回」，现场只剩 CLI 的 10s 超时。
        out = { status: 500, body: { error: "fixture-throw", detail: String(err) } };
      }
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, state,
    close: () => new Promise((r) => { server.closeIdleConnections?.(); server.close(r); })
  };
}

/** 每个用例一套临时目录：home 顶替子进程的 HOME（tilde 展开与 cli.json 都落在这里）。 */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "mneme-cli-recv-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return {
    home,
    cleanup() {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* win 偶发文件锁，残留临时目录无害 */ }
    }
  };
}

async function withPlane(handlers, fn) {
  const plane = await startPlane(handlers);
  const s = scratch();
  try {
    return await fn({ plane, home: s.home, url: plane.url, auth: ["--url", plane.url, "--token", TOKEN] });
  } finally {
    s.cleanup();
    await plane.close();
  }
}

/**
 * HOME/USERPROFILE 一起改：os.homedir() 先读 HOME、Windows 再读 USERPROFILE，子进程里的
 * `~` 与 `~\` 才都展开进临时目录。DSH_MNEME_URL/TOKEN 指到 fixture 那一面而不是清空
 * （文件头注释那条账）。
 */
function runCli(ctx, args) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ctx.home,
      env: { ...process.env, HOME: ctx.home, USERPROFILE: ctx.home, DSH_MNEME_URL: ctx.url, DSH_MNEME_TOKEN: TOKEN },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", rej);
    child.on("exit", (code) => res({ code, stdout, stderr }));
  });
}

const receivedBodies = (plane) => plane.state.requests.map((r) => JSON.parse(r.body));

test("receive without --apply posts confirm absent and reports the dry-run numbers", { timeout: 60000 }, async () => {
  await withPlane({}, async (ctx) => {
    const f = packFile(ctx.home);
    const out = await runCli(ctx, ["receive", f.path, ...ctx.auth]);
    assert.equal(out.code, 0, out.stderr);
    const req = ctx.plane.state.requests[0];
    assert.equal(req.pathname, "/receive");
    assert.equal(req.auth, `Bearer ${TOKEN}`);
    const body = JSON.parse(req.body);
    assert.equal(body.confirm, undefined, "no --apply means no confirm");
    assert.deepEqual(body.pack, f.pack, "the pack body must travel, not just a path");
    // (b) 干跑没写：真解析层读出来的 dryRun 必须是 true——这条断的是**服务端那一侧**看到的
    // 意图，而不是 CLI 自己打印的措辞；两者分家就是「其实写了、却说没写」那类谎。
    assert.equal(ctx.plane.state.imports[0].dryRun, true);
    assert.match(out.stdout, /^干跑: 3 条/m);
    // 撞名是 advisory 读数，话术只许说「和你自己的条目同名，需要你看一眼」，不许说
    // 「没有别的撞名」，也不许替人说它已被解决。
    assert.match(out.stdout, /和你自己的条目同名 1 条/);
    assert.match(out.stdout, /需要你处置/);
    assert.ok(!/没有撞名|无冲突/.test(out.stdout), "撞名话术不许退化成「保证没有别的撞名」");
    assert.match(out.stdout, /没写库/);
  });
});

test("receive --apply sends confirm and prints the created count", { timeout: 60000 }, async () => {
  await withPlane({}, async (ctx) => {
    const f = packFile(ctx.home);
    const out = await runCli(ctx, ["receive", f.path, "--apply", ...ctx.auth]);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(receivedBodies(ctx.plane)[0].confirm, true);
    assert.equal(ctx.plane.state.imports[0].dryRun, false);
    assert.match(out.stdout, /^已导入: 3 条/m);
    assert.ok(!out.stdout.includes("没写库"), "执行过的报告不许再说不写");
  });
});

test("a missing or unreadable pack file fails before any request", { timeout: 60000 }, async () => {
  await withPlane({}, async (ctx) => {
    const out = await runCli(ctx, ["receive", join(tmpdir(), "definitely-not-here.json"), ...ctx.auth]);
    assert.notEqual(out.code, 0);
    assert.match(`${out.stdout}${out.stderr}`, /包|文件|read|ENOENT/i);
    assert.deepEqual(ctx.plane.state.requests, [], "本地读文件就失败了，一个请求都不许发");
  });
});

test("undo-share reads the pack_id out of the file the user already has", { timeout: 60000 }, async () => {
  await withPlane({}, async (ctx) => {
    const f = packFile(ctx.home);
    const out = await runCli(ctx, ["undo-share", f.path, "--apply", ...ctx.auth]);
    assert.equal(out.code, 0, out.stderr);
    const body = JSON.parse(ctx.plane.state.requests[0].body);
    assert.equal(body.packId, PACK_ID);
    assert.equal(body.confirm, true);
    assert.match(out.stdout, /^已收起: 7 条/m);
    // 物删这条契约在终端上要说明白：--apply 是人和删除之间唯一的东西。
    assert.match(out.stdout, /物删/);
    assert.match(out.stdout, /· \[decision\] t/);
  });
});

// 退出答复里的 sample 是服务端截过前缀的样例（src/share-import.js 的 DELETE_SAMPLE_MAX
// 是 20），CLI 还要再截到 10，而 deleted 才是全集。不加说明，一个 500 行的包在终端上
// 就是 10 条无名要点，人会读成「要收走的就是这些」（C7 评审点名的那条）。
test("undo-share 列出的行要说得出自己是样例，全集那格用的是服务端的数", { timeout: 60000 }, async () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ type: "decision", title: `row-${i}` }));
  await withPlane({ deleteResult: { pack_id: PACK_ID, deleted: 500, sample: rows } }, async (ctx) => {
    const f = packFile(ctx.home);
    const out = await runCli(ctx, ["undo-share", f.path, "--apply", ...ctx.auth]);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /^已收起: 500 条/m);
    const bullets = out.stdout.split("\n").filter((l) => /^\s+· \[/.test(l));
    assert.equal(bullets.length, 10, "样例只许列前 10 条");
    assert.match(out.stdout, /样例[^\n]*不是全部清单/);
    // 全集那格必须是服务端的 500，不能是「还有 490 条」这类把两次截断混在一起的数。
    assert.match(out.stdout, /只列前 10 条[^\n]*500/);
    const captionAt = out.stdout.indexOf("样例");
    const bulletAt = out.stdout.indexOf("· [");
    assert.ok(captionAt >= 0 && captionAt < bulletAt, "要点必须挂在样例这句话下面，不许吊在别句话后面");
    assert.ok(!/全部行|就是这些|以下所有/.test(out.stdout), "样例话术不许升级成完整清单的口吻");

    // --json 走的是同一份答复，打印分支加的两句不许漏进 stdout（jq 吃的还是那一个对象）。
    const json = await runCli(ctx, ["undo-share", f.path, "--apply", "--json", ...ctx.auth]);
    assert.equal(json.code, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).deleted, 500);
    assert.ok(!json.stdout.includes("样例"), "--json 的 stdout 只许那一份 JSON");
  });
});

// 干跑一笔都没删，所以「这些行直接从库里带走」在那一格是假话；而它压着下面的样例，
// 现场就成了「已经删掉的这几条」。干跑的说明书是行尾那句「没删：…加 --apply」。
test("undo-share 干跑不许出现物删话术，读起来是一次预览而不是删除", { timeout: 60000 }, async () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ type: "decision", title: `row-${i}` }));
  await withPlane({ deleteResult: { pack_id: PACK_ID, deleted: 500, sample: rows } }, async (ctx) => {
    const f = packFile(ctx.home);
    const out = await runCli(ctx, ["undo-share", f.path, ...ctx.auth]);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(ctx.plane.state.deletes[0].dryRun, true);
    assert.match(out.stdout, /^将收起: 500 条/m);
    assert.ok(!/物删|直接从库里带走/.test(out.stdout), "干跑不许断言行会被物删");
    assert.match(out.stdout, /没删/);
    // 样例的说明在干跑里同样要有——人正是拿这几条决定要不要加 --apply。
    assert.match(out.stdout, /样例[^\n]*不是全部清单/);
  });
});

// 空白 pack_id 与「没有 pack_id」是同一种「这个文件收不了」：本地就拒，别让它出门换回
// 一个 missing-pack-id（服务端 parseUndoBody 自己也会 trim，这里改不了它的行为，
// 只是不让人为了一个空格去 round-trip 一轮、并把 400 的现场当成服务端的问题）。
test("空白 pack_id 在本地就拒，一个请求都不发", { timeout: 60000 }, async () => {
  await withPlane({}, async (ctx) => {
    const path = join(ctx.home, "blank-id.json");
    writeFileSync(path, JSON.stringify({ kind: SHARE_KIND, pack_id: "   ", memories: [] }), "utf8");
    const out = await runCli(ctx, ["undo-share", path, "--apply", ...ctx.auth]);
    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /pack_id/);
    assert.match(out.stderr, /十六进制/, "复用那句说明书：为什么要的是包文件而不是手抄编号");
    assert.deepEqual(ctx.plane.state.requests, [], "空白 pack_id 不许打出去换回 400 missing-pack-id");

    const json = await runCli(ctx, ["undo-share", path, "--apply", "--json", ...ctx.auth]);
    assert.notEqual(json.code, 0);
    assert.equal(json.stdout.trim(), "", `--json 的 stdout 不许掺解释行：${json.stdout}`);
    assert.match(String(JSON.parse(json.stderr).error), /pack_id/);
  });
});

test("a 400 from receive keeps the server's error code visible", { timeout: 60000 }, async () => {
  // 错码由真 service 抛出、真 receiveReply 顺着 SHARE_IMPORT_ERRORS 映射成 400——假服务
  // 不编状态码，码集一漂移这里就红。
  await withPlane({ importError: "external-id-mismatch" }, async (ctx) => {
    const f = packFile(ctx.home);
    const out = await runCli(ctx, ["receive", f.path, ...ctx.auth]);
    assert.notEqual(out.code, 0);
    assert.match(`${out.stdout}${out.stderr}`, /external-id-mismatch/);
    assert.match(`${out.stdout}${out.stderr}`, /HTTP 400/);
  });
});

test("receive with no file argument fails with an explanation, and --json stays parseable", { timeout: 60000 }, async () => {
  await withPlane({}, async (ctx) => {
    // 「 refuse to write nothing and print nothing」：不给包文件不许静默 exit 0。
    const plain = await runCli(ctx, ["receive", ...ctx.auth]);
    assert.notEqual(plain.code, 0, "不带包文件的 receive 不许默默成功");
    assert.match(plain.stderr, /receive 需要包文件/);
    assert.deepEqual(ctx.plane.state.requests, [], "拒绝发生在请求之前");

    // --json 的拒绝分支同样要能 parse（车道 A 在 printShare 上修过的同一类 corruption：
    // stdout 只许 JSON，解释走 stderr 的 {error} 壳）。
    const json = await runCli(ctx, ["receive", "--json", ...ctx.auth]);
    assert.notEqual(json.code, 0);
    assert.equal(json.stdout.trim(), "", `--json 的 stdout 不许掺解释行：${json.stdout}`);
    const refusal = JSON.parse(json.stderr);
    assert.match(String(refusal.error), /receive 需要包文件/);
    assert.deepEqual(ctx.plane.state.requests, []);
  });
});

test("undo-share without --apply is a dry-run: the physical delete needs the flag", { timeout: 60000 }, async () => {
  await withPlane({}, async (ctx) => {
    const f = packFile(ctx.home);
    const out = await runCli(ctx, ["undo-share", f.path, ...ctx.auth]);
    assert.equal(out.code, 0, out.stderr);
    const body = JSON.parse(ctx.plane.state.requests[0].body);
    assert.equal(body.confirm, undefined, "撤销是物删，缺省必须是干跑");
    assert.equal(ctx.plane.state.deletes[0].dryRun, true, "service 那一侧读到的也得是干跑");
    assert.match(out.stdout, /^将收起: 7 条/m);
    assert.match(out.stdout, /没删/);
    // 同一句物删话术在干跑里是假话（这一笔一个字没动），--apply 那条用例锁它出现。
    assert.ok(!/物删|直接从库里带走/.test(out.stdout), "干跑不许断言行会被物删");
  });
});

test("undo-share on a file without pack_id explains the pack-file choice", { timeout: 60000 }, async () => {
  await withPlane({}, async (ctx) => {
    const path = join(ctx.home, "not-a-pack.json");
    writeFileSync(path, JSON.stringify({ hello: "world" }), "utf8");
    const out = await runCli(ctx, ["undo-share", path, "--apply", ...ctx.auth]);
    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /pack_id/);
    // 取包文件而不是裸 pack_id 是刻意的（人抄 16 位十六进制必出错），拒绝话术要把这条
    // 理由说出来，否则下个读者会「顺手」加一个 pack_id 旗标把它绕回去。
    assert.match(out.stderr, /十六进制/);
    assert.deepEqual(ctx.plane.state.requests, [], "本地就拒了，不许先打一轮 missing-pack-id 再拒");
  });
});

test("receive accepts `~` and `~\\` pack paths（PowerShell/cmd 不会替她展开）", { timeout: 60000 }, async () => {
  await withPlane({}, async (ctx) => {
    const NAMES = ["tilde-pack.json", "tilde-pack-win.json"];
    packFile(ctx.home, NAMES[0]);
    const slash = await runCli(ctx, ["receive", `~/${NAMES[0]}`, "--apply", ...ctx.auth]);
    assert.equal(slash.code, 0, `tilde 展开失败就是 readFileSync 的 ENOENT：${slash.stderr}`);
    assert.equal(JSON.parse(ctx.plane.state.requests.at(-1).body).pack.pack_id, PACK_ID);

    packFile(ctx.home, NAMES[1]);
    const backslash = await runCli(ctx, ["receive", `~\\${NAMES[1]}`, "--apply", ...ctx.auth]);
    assert.equal(backslash.code, 0, backslash.stderr);
    assert.equal(JSON.parse(ctx.plane.state.requests.at(-1).body).pack.pack_id, PACK_ID,
      "反斜杠形态同一条规则（expandHome 认 ~\\）");
  });
});

test("receive --json：stdout 恰一份能 parse 的答复，尾巴不许掺提示", { timeout: 60000 }, async () => {
  await withPlane({}, async (ctx) => {
    const f = packFile(ctx.home);
    const out = await runCli(ctx, ["receive", f.path, "--json", ...ctx.auth]);
    assert.equal(out.code, 0, out.stderr);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.pack_id, PACK_ID);
    assert.equal(parsed.created, 3);
    assert.equal(parsed.dry_run, true, "dry_run 走的是真答复壳加的那一格");
    assert.ok(!out.stdout.includes("没写库"), "--json 的 stdout 只许那一份 JSON");
  });
});

test("漏传 --url/--token 的调用点打到的是 fixture 那一面，不是她本机 8790", { timeout: 60000 }, async () => {
  // 这条锁的是 runCli 那份 env，不是 CLI 的行为：DSH_MNEME_URL/TOKEN 给的是本测试自己
  // 起的端口。清空那两个变量才会顺着 `?? DEFAULT_URL` 落到 127.0.0.1:8790（车道 A 留的
  // 账），今天每个调用点显式带旗标所以打不到——那是「暂时没漏」而不是「漏不到」。
  await withPlane({}, async (ctx) => {
    const f = packFile(ctx.home);
    const out = await runCli(ctx, ["receive", f.path]);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(ctx.plane.state.requests.length, 1, "请求要落到 fixture 这一面");
  });
});
