// CLI `share` 的端到端覆盖：真 spawn `bin/cli.mjs`，打到一个顶替 Bearer 数据面的假 HTTP
// 服务上（127.0.0.1、端口 0，不要求本机开着 DSH，也不出环回）。
//
// 为什么要有这个文件：`cmdShare`/`printShare`/`expandHome` 约 78 行在 A7 里只被一次性探针
// 手工跑过（task-A7-report §5 的 concerned 第 1 条），bin/cli.mjs 对外只 export parseArgv
// 那几个解析件，命令本体从 `node --test` 够不着。codecov 看的是补丁覆盖率，这条路径没有
// 锁就等于「下一个改动它的人只能再手跑一遍」。
//
// 为什么假服务不自己编响应体：答复由 **出货的那一层**生成（parseShareBody + shareReply，
// 就是 api-standalone.js 里挂 /share 的同一对函数），rows 是假的、协议是真的。于是
// `kind` / `too-large` / `hint` / `bytes` 这些字段一漂移，这里当场红 —— 手写字面量的假服务
// 只会把「测试自己编的形状」锁成契约。数据面自身的口径另有 share-routes.test.js 与
// share-http.test.js 两处锁，本文件只管 CLI 这张嘴。
//
// spawn 必须异步：服务跑在本进程里，spawnSync 会堵住事件循环，CLI 只能等到自己 10s 超时
// （maintenance.test.js:23 那条教训，同一个坑不再踩一次）。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseShareBody, shareReply } from "../src/share-http.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.mjs");
const TOKEN = "cli-share-test-token";
const PACKAGE_VERSION = "0.9.4";
// 打包侧拿来遮正文里 home 前缀的入参（share.js 的 createHomeRedactor），跟 os.homedir() 无关：
// 子进程的 HOME 被下面的 scratch 顶掉了，两者刻意不是同一个目录。
const SOURCE_HOME = "/fake/home/alex";
const NOW = () => new Date("2026-10-22T00:00:00.000Z");

const row = (over) => ({
  id: "r", type: "decision", title: "t", content: "c", tags: [], importance: 3,
  archived: 0, forgotten: 0, created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z", content_hash: "h", ...over
});

// 两条进包 + 一条归档（archived）+ 一条 summary（excluded_type）：跳过清单里两种原因都要
// 有实物，printShare 那六档命名才不会退化成「只测了 happy path 的计数器」。
const THIN_ROWS = [
  row({ id: "1", type: "decision", title: "选 SQLite", content: "存储层用 node:sqlite", tags: ["存储"], importance: 4 }),
  row({ id: "2", type: "preference", title: "浅色主题", content: "界面默认浅色" }),
  row({ id: "3", type: "project", title: "归档项", content: "旧决定", archived: 1 }),
  row({ id: "4", type: "summary", title: "会话摘要", content: "摘出来的正文" })
];

// 413 只由**最终序列化字节**决定，水位 MAX_PACK_BYTES = 3 MiB 是硬编码、没有注入缝，所以这
// 一条只能靠体积本身撞上去（1.2M 个中文字 ≈ 3.4 MB UTF-8）。假服务不自己回 413。
const FAT_ROWS = [row({ id: "f", title: "长正文", content: "字".repeat(1_200_000) })];

/** 顶替数据面的假服务：认 POST /share、验 Bearer，其余按 api-standalone 的口径回错码。 */
async function startPlane() {
  const state = { rows: THIN_ROWS, requests: [], lastStatus: null, lastBodyText: "" };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const { pathname } = new URL(req.url, "http://127.0.0.1");
      state.requests.push({ method: req.method, pathname, auth: req.headers.authorization ?? "", body: text });
      let out;
      try {
        if (req.method !== "POST" || pathname !== "/share") out = { status: 404, body: { error: "not-found" } };
        else if (req.headers.authorization !== `Bearer ${TOKEN}`) out = { status: 401, body: { error: "unauthorized" } };
        else {
          const parsed = parseShareBody(text);
          out = parsed.ok
            ? shareReply({ service: { all: () => state.rows }, packageVersion: PACKAGE_VERSION, homeDir: SOURCE_HOME, now: NOW, options: parsed.options })
            : { status: 400, body: { error: parsed.error } };
        }
      } catch (err) {
        // 漏这一兜，异常就顺着 socket 变成「一个字节都没回」，现场只剩 CLI 的 10s 超时。
        out = { status: 500, body: { error: "fixture-throw", detail: String(err) } };
      }
      state.lastStatus = out.status;
      state.lastBodyText = JSON.stringify(out.body);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(state.lastBodyText);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    overLimit() { state.rows = FAT_ROWS; },
    // 终端那格要看得懂「标题为什么是空的」，得有一批含凭据的被跳过行；默认那批
    // THIN_ROWS 被好几条用例共用作计数基准，不能为了这一格改它。
    use(rows) { state.rows = rows; },
    close: () => new Promise((r) => { server.closeIdleConnections?.(); server.close(r); })
  };
}

/**
 * 每个用例一套临时目录：`home` 顶替子进程的 HOME（tilde 展开与 cli.json 都落在这里），
 * `out` 是产物目录 —— 「干跑不许写文件」就断言这个目录空。
 */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "mneme-cli-share-"));
  const home = join(root, "home");
  const out = join(root, "out");
  mkdirSync(home, { recursive: true });
  mkdirSync(out, { recursive: true });
  return {
    home, out,
    cleanup() {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* win 偶发文件锁，残留临时目录无害 */ }
    }
  };
}

async function withPlane(fn) {
  const plane = await startPlane();
  const s = scratch();
  try {
    return await fn({
      plane, home: s.home, out: s.out, url: plane.url, token: TOKEN,
      auth: ["--url", plane.url, "--token", TOKEN]
    });
  } finally {
    s.cleanup();
    await plane.close();
  }
}

/**
 * HOME/USERPROFILE 一起改：os.homedir() 先读 HOME、Windows 再读 USERPROFILE，子进程里的
 * `~` 与 `~\` 才都展开进临时目录（断言失败时也不会有产物落进真人 home）。
 * 同时把 cwd 放到临时目录：本机那份 ~/.dsh-mneme/cli.json 不参与，产物也只进 scratch。
 *
 * DSH_MNEME_URL/TOKEN 给的是 **fixture 那一面**，不是清空。清空会顺着
 * `firstNonEmpty(flag, env, file) ?? DEFAULT_URL` 落到 `DEFAULT_URL = 127.0.0.1:8790`，
 * 那正是她本机活实例的默认端口：今天每个调用点都显式带 --url/--token 所以打不到，但那是
 * 「暂时没漏」而不是「漏不到」。指到 fixture 之后，未来少带一对旗标的调用点打的是本测试
 * 自己起的那面；那种错会变成断言当场红，而不是拿她的活库跑测试、还因为只读路由回 401
 * 而表现成「这条用例偶尔红」。
 */
function runCli(ctx, args, extraEnv = {}) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ctx.out,
      env: { ...process.env, HOME: ctx.home, USERPROFILE: ctx.home, DSH_MNEME_URL: ctx.url, DSH_MNEME_TOKEN: ctx.token, ...extraEnv },
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

const listFiles = (dir) => readdirSync(dir).sort();

test("CLI share --dry-run：报数并解释没写文件，输出目录一个字节不多", { timeout: 60000 }, async () => {
  await withPlane(async (ctx) => {
    const dry = await runCli(ctx, ["share", "--dry-run", ...ctx.auth]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /^干跑报告: 2 条$/m);
    assert.match(dry.stdout, /跳过: 归档 1, 不随包走 1/);
    assert.match(dry.stdout, /- \[archived\] 归档项/);
    assert.match(dry.stdout, /- \[excluded_type\] 会话摘要/);
    assert.match(dry.stdout, /没写文件：加 --out <路径> 才会落盘/);
    assert.ok(!dry.stdout.includes("已写出"), "干跑不许报落盘");
    assert.deepEqual(listFiles(ctx.out), [], "干跑不许产出任何文件");

    // 同时给 --dry-run 与 --out：偏好干跑，那个路径也不许被创建（cmdShare 的 `if (dryRun) return`
    // 排在写盘之前）。这一条锁的是「安全的那一侧」：脚本以为有文件会拿到 none，但不能反过来
    // ——带了 --dry-run 却动了盘。
    const both = join(ctx.out, "must-not-exist.json");
    const combo = await runCli(ctx, ["share", "--dry-run", "--out", both, ...ctx.auth]);
    assert.equal(combo.code, 0, combo.stderr);
    assert.ok(!existsSync(both), "--dry-run 在场时 --out 不得落盘");
    assert.deepEqual(listFiles(ctx.out), []);
  });
});

test("漏传 --url/--token 的调用点打到的是 fixture 那一面，不是她本机 8790", { timeout: 60000 }, async () => {
  await withPlane(async (ctx) => {
    // 这条锁的是 runCli 那份 env，不是 CLI 的行为：DSH_MNEME_URL/TOKEN 给的是本测试自己
    // 起的端口，所以「未来某个调用点忘了带旗标」落在这里是当场可看见的一次请求，而不是
    // 悄悄打到 `DEFAULT_URL = 127.0.0.1:8790`（她本机活实例的默认端口，只读面回 401、
    // 老构建回 404，表现成「这条用例偶尔红」）。清空那两个变量才是这里要防的回归。
    const before = ctx.plane.state.requests.length;
    const run = await runCli(ctx, ["share", "--dry-run"]);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(ctx.plane.state.requests.length, before + 1, "请求要落到 fixture 这一面");
    assert.deepEqual(listFiles(ctx.out), []);
  });
});

test("CLI 的跳过清单：含凭据那行不给标题，终端要写得像「有意不给」", { timeout: 60000 }, async () => {
  await withPlane(async (ctx) => {
    // 这条锁的是终端那一格：src/share.js 在源头把命中密钥判据的行的标题留空，skip_list
    // 于是只剩原因。空标题直接打出来是一行尾随空格，读的人会当成「这条本来没标题」，
    // 而它恰恰是最需要被看见的那一类拒绝。
    const secret = "P@ssw0rd-for-prod-db";
    ctx.plane.use([
      row({ id: "1", type: "project", title: "干净的归档行", content: "没有凭据", archived: 1 }),
      row({ id: "2", type: "decision", title: `生产库密码 ${secret} 别丢`, content: `password: ${secret}`, archived: 1 })
    ]);
    const dry = await runCli(ctx, ["share", "--dry-run", ...ctx.auth]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /^干跑报告: 0 条$/m);
    assert.match(dry.stdout, /- \[archived\] 干净的归档行/);
    assert.match(dry.stdout, /- \[archived\] （标题不外发）/);
    // 终端与落盘是同一份 report 的两张嘴：这里也不许出现那个值。
    assert.ok(!dry.stdout.includes(secret), "CLI 不许把凭据标题打到终端");
    assert.ok(!dry.stderr.includes(secret), "错误面同样不许");
  });
});

test("CLI 报得出包内折叠：included 少的那几条要有去处", { timeout: 60000 }, async () => {
  await withPlane(async (ctx) => {
    // 同标题、同正文、同内容锚而 scope 不同的两条在库里是两条合法记忆，在包里共用一把
    // external_id，于是出包侧折成一条。终端只报 `干跑报告: 1 条` 的话，读的人以为自己
    // 少发了 —— 这一格要说清那条去哪了（src/share.js 的 report.deduped）。
    ctx.plane.use([
      row({ id: "1", type: "decision", title: "同一个标题", content: "同一份正文", content_hash: "same-hash", agent_scope: "preset-a" }),
      row({ id: "2", type: "decision", title: "同一个标题", content: "同一份正文", content_hash: "same-hash", agent_scope: "preset-b" })
    ]);
    const dry = await runCli(ctx, ["share", "--dry-run", ...ctx.auth]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /^干跑报告: 1 条$/m);
    assert.match(dry.stdout, /包内重复已折叠: 1 条/);
    assert.match(dry.stdout, /跳过: 无/, "折叠不走跳过那本账");
    assert.deepEqual(JSON.parse(ctx.plane.state.lastBodyText).report.skip_list, []);
  });
});

test("CLI share --out：数据面答复逐字落盘，解析回来 kind 与 report 都对", { timeout: 60000 }, async () => {
  await withPlane(async (ctx) => {
    const dest = join(ctx.out, "pack.json");
    const run = await runCli(ctx, ["share", "--out", dest, ...ctx.auth]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /^分享包: 2 条$/m);
    assert.ok(run.stdout.includes(`已写出: ${dest}`), run.stdout);
    assert.equal(ctx.plane.state.requests.at(-1).auth, `Bearer ${TOKEN}`, "Bearer 头得真的带上，否则这条只是本地写文件");

    const text = readFileSync(dest, "utf8");
    // 逐字相同：CLI 只做 JSON.parse → JSON.stringify 的往返，不许顺手美化、加换行或改键序
    // ——这份文件是要原样 POST 给对面的（车道 C），多一个空格对面重算的锚就对不上。
    assert.equal(text, ctx.plane.state.lastBodyText);
    const pack = JSON.parse(text);
    assert.equal(pack.kind, "mneme.share/v1");
    assert.equal(pack.report.included, 2);
    assert.equal(pack.alias, "", "没给 --alias 时包里是空串，不是 undefined");
  });
});

test("CLI share 不带 --out 也不带 --dry-run：先解释再退出，一个请求都不发", { timeout: 60000 }, async () => {
  await withPlane(async (ctx) => {
    const run = await runCli(ctx, ["share", ...ctx.auth]);
    assert.notEqual(run.code, 0, "整库答复直接打 stdout 会把报告淹掉，这条必须拒");
    assert.match(run.stderr, /要么写文件（--out <路径>），要么只看报告（--dry-run）/);
    assert.ok(run.stderr.includes("dsh-mneme share --out ~/Desktop/pack.json"),
      `拒绝里要带一条能照抄的例子，got: ${run.stderr}`);
    assert.deepEqual(ctx.plane.state.requests, [], "拒绝发生在请求之前：不许先打一轮再拒");
    assert.deepEqual(listFiles(ctx.out), [], "拒绝路径不留文件");
  });
});

test("CLI share --out 的 `~` 前缀：展开到子进程 home（PowerShell/cmd 不会替她展开）", { timeout: 60000 }, async () => {
  await withPlane(async (ctx) => {
    // Git Bash 会展开 `~/…`，PowerShell 与 cmd 给到 CLI 的是字面量 —— USAGE 里的例子正是
    // 这一串，所以 expandHome 是那个例子在 Windows 上能不能用的全部区别。
    const NAMES = ["dsh-mneme-cli-share-tilde-probe.json", "dsh-mneme-cli-share-tilde-probe-win.json"];
    const tilde = await runCli(ctx, ["share", "--out", `~/${NAMES[0]}`, ...ctx.auth]);
    assert.equal(tilde.code, 0, `tilde 展开失败就是 writeFileSync 的 ENOENT 堆栈：${tilde.stderr}`);
    assert.ok(existsSync(join(ctx.home, NAMES[0])), `${NAMES[0]} 应落在子进程 home 里，got: ${tilde.stdout}`);
    assert.ok(tilde.stdout.includes(NAMES[0]) && !tilde.stdout.includes(`~/${NAMES[0]}`),
      `打印的应是展开后的路径，got: ${tilde.stdout}`);

    const backslash = await runCli(ctx, ["share", "--out", `~\\${NAMES[1]}`, ...ctx.auth]);
    assert.equal(backslash.code, 0, backslash.stderr);
    assert.ok(existsSync(join(ctx.home, NAMES[1])), `${NAMES[1]}：反斜杠形态同一条规则（expandHome 认 ~\\）`);

    // 绝对路径不受影响：expandHome 只改 `~`/`~/`/`~\` 开头，别的原样交给 writeFileSync。
    const abs = join(ctx.out, "abs.json");
    const plain = await runCli(ctx, ["share", "--out", abs, ...ctx.auth]);
    assert.equal(plain.code, 0, plain.stderr);
    assert.ok(existsSync(abs) && !existsSync(join(ctx.home, "abs.json")));
    // 这里**不**留「万一 HOME 覆盖没生效就去真人 home 里把这两个名字擦掉」的兜底：那个
    // rmSync 的靶子是 os.homedir()，只有在测试本来就该红（覆盖失效）的情况下才会动她家目录，
    // 而它删的是「同名」不是「本测试刚写的那个 inode」。HOME 覆盖有没有生效由上面两条
    // existsSync(join(ctx.home, …)) 负责——红了就停手，产物留在临时 home 里等她自己看。
  });
});

test("CLI share 撞 413：拒答体自带的 hint 与两个字节数走 failHttp 转出来", { timeout: 60000 }, async () => {
  await withPlane(async (ctx) => {
    ctx.plane.overLimit();
    const dest = join(ctx.out, "never.json");
    const run = await runCli(ctx, ["share", "--out", dest, ...ctx.auth]);
    assert.equal(run.code, 1);
    assert.equal(ctx.plane.state.lastStatus, 413, "体积要真撞上去，假服务不许自己编状态码");
    assert.match(run.stderr, /请求失败（HTTP 413）：too-large \[\/share\]/);
    // 56f7b06 修的就是这两句：旧 failHttp 只取 data.error，「大了多少」「怎么分批」留在体里
    // 没人看得见 —— 最需要下一步动作的那次拒绝，反而是最没信息量的那次。
    assert.match(run.stderr, /用 --type 或 --tag 分批/);
    assert.match(run.stderr, /量到 \d+(\.\d)? M?B，水位 3\.0 MB/);
    assert.ok(!existsSync(dest), "拒绝路径不许留半个包");
  });
});

test("CLI share --json 撞 413：stdout 保持干净，整份拒答体（含 report）走 stderr", { timeout: 60000 }, async () => {
  await withPlane(async (ctx) => {
    ctx.plane.overLimit();
    const run = await runCli(ctx, ["share", "--json", "--out", join(ctx.out, "never.json"), ...ctx.auth]);
    assert.equal(run.code, 1);
    // --json 的约定：stdout 只有那一份 JSON。拒答走 fail → console.error(rawJson)，
    // 所以 stdout 是空的，而 stderr 是可以直接 parse 的原始响应体。
    assert.equal(run.stdout.trim(), "", `--json 的 stdout 不许掺解释行：${run.stdout}`);
    const body = JSON.parse(run.stderr);
    assert.equal(body.error, "too-large");
    assert.ok(body.bytes > body.limitBytes, "两个字节数都在体里，出口才有「大了多少」可说");
    assert.match(body.hint, /分批/);
    assert.equal(body.report.included, 1, "完整报告走 --json：分批的依据就是这份数");
    assert.ok(!("memories" in body), "413 不许把刚拒绝掉的几 MB 再发一遍");
  });
});

test("CLI share --json 成功答复：stdout 是一份能 parse 的 JSON，尾巴不许掺「已写出」", { timeout: 60000 }, async () => {
  await withPlane(async (ctx) => {
    const dest = join(ctx.out, "json-pack.json");
    const written = await runCli(ctx, ["share", "--out", dest, "--json", ...ctx.auth]);
    assert.equal(written.code, 0, written.stderr);
    // A7 报告里实测过的那次 corruption：尾部追一行 已写出 就撞
    // SyntaxError: Unexpected non-whitespace character after JSON（jq 同理）。
    const parsed = JSON.parse(written.stdout);
    assert.deepEqual(Object.keys(parsed).sort(), ["file", "report"]);
    assert.equal(parsed.file, dest, "落盘路径已在 payload 里，那行提示只对人有意义");
    assert.equal(parsed.report.included, 2);
    assert.ok(!written.stdout.includes("已写出"));
    assert.ok(existsSync(dest), "--json 不改变落盘这件事");

    const dry = await runCli(ctx, ["share", "--dry-run", "--json", ...ctx.auth]);
    assert.equal(dry.code, 0, dry.stderr);
    const dryParsed = JSON.parse(dry.stdout);
    assert.deepEqual(Object.keys(dryParsed).sort(), ["pack", "report"]);
    assert.equal(dryParsed.pack.kind, "mneme.share/v1");
    assert.equal(dryParsed.report.included, 2);
  });
});

test("CLI share --type/--alias/--tag：按数据面认得的形状上线", { timeout: 60000 }, async () => {
  await withPlane(async (ctx) => {
    const run = await runCli(ctx, [
      "share", "--type", "decision,preference", "--alias", "桉桉的库", "--tag", "存储", "--dry-run", ...ctx.auth
    ]);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(JSON.parse(ctx.plane.state.requests.at(-1).body), {
      type: ["decision", "preference"], alias: "桉桉的库", tag: "存储"
    }, "--type 是逗号列表 → 数组；空旗标不该冒出键");
    // 收窄是真的生效（不是发出去没人读）：两条里只有带 存储 标签那条进包。
    assert.match(run.stdout, /^干跑报告: 1 条  来自 桉桉的库$/m);
    assert.deepEqual(listFiles(ctx.out), []);
  });
});

// CLI 与 src/share.js 之间没有 import 关系（bin/cli.mjs 是零依赖 HTTP 客户端，那条理由
// 写在它自己的注释里），所以「六个跳过原因键」和「50 的截断数」在 CLI 侧是抄过去的字面量。
// 抄的东西不会自己报错：share.js 改一个键名，CLI 就把那一档读成 0（跳过原因在终端上凭空
// 少一类）；改了上限，那句「跳过清单已截断」就打错格数。这条静态锁是两份文本之间唯一的
// 接缝——它不重跑逻辑，只比对字面量集合与那个数。
test("CLI 抄过去的原因键与截断数跟 src/share.js 同源", () => {
  const shareText = readFileSync(resolve(dirname(CLI), "..", "src", "share.js"), "utf8");
  const cliText = readFileSync(CLI, "utf8");

  const skippedBlock = shareText.match(/const skipped = \{([^}]*)\}/)?.[1] ?? "";
  const shareKeys = [...skippedBlock.matchAll(/([a-z_]+):\s*0/g)].map((m) => m[1]);
  const namedBlock = cliText.match(/const named = \[([\s\S]*?)\];/)?.[1] ?? "";
  const cliKeys = [...namedBlock.matchAll(/\['([a-z_]+)'/g)].map((m) => m[1]);
  // 两条正则都必须真的抓到东西，否则这个用例退化成永真（同本文件对假服务的口径）。
  assert.equal(shareKeys.length, 6, `share.js 的 skipped 应有六个键，抓到 ${shareKeys.length} 个：${shareKeys}`);
  assert.equal(cliKeys.length, 6, `cli.mjs 的 named 应有六档，抓到 ${cliKeys.length} 个：${cliKeys}`);
  assert.deepEqual(cliKeys, shareKeys, "CLI 的档位名必须与 report.skipped 的键逐字同序");

  const shareMax = Number(shareText.match(/SHARE_SKIP_LIST_MAX = (\d+)/)?.[1]);
  // CLI 那一侧的形状是 `if ((r.skip_list ?? []).length >= 50)`：抓 `).length >= N`。
  const cliCap = Number(cliText.match(/\)\.length >= (\d+)/)?.[1]);
  assert.ok(Number.isInteger(shareMax) && shareMax > 0, "share.js 的截断常量要读得出来");
  assert.ok(Number.isInteger(cliCap) && cliCap > 0, "cli.mjs 的截断格数要读得出来");
  assert.equal(cliCap, shareMax, "CLI 那句「已截断」的格数必须等于 SHARE_SKIP_LIST_MAX");
});
