import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readPipelineDoc } from "../src/pipeline.js";
import {
  RUNS_SUFFIX,
  RUNS_STATES,
  RunError,
  runsDir,
  runsPath,
  readRuns,
  appendRun,
  normalizeRun,
  loadRunsById
} from "../src/pipeline-runs.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createApi } from "../src/api.js";

// 这组测试守的是 M.O. 执行链的**第一步**：把「跑过一次」真的写下来，并让读侧读得回来。
//
// 为什么单独一个文件：读侧（src/pipeline.js）的契约已冻结，这里守的是它与盘面的接缝
// ——落点在哪、坏行怎么报、写进去的东西能不能被 tallyRuns 数出来。接缝坏掉时读侧
// 一切照旧地绿，只有面板上「所有节点都是 candidate」这一个症状，最容易查不出来。
//
// 很大一部分用例在守**读盘路径**：账本是别人写的（手写、历史、别的写入方），
// 读侧最大的风险不是读不出来，而是**替它补一个含义**——补出来的正面证据，面板会当真。

const here = dirname(fileURLToPath(import.meta.url));

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mneme-runs-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 与 test/pipeline.test.js 同款的最小工作流：两条步骤，引用自洽，够验投影。
function pipelineFile(steps) {
  return JSON.stringify({
    id: "demo",
    name: "演示",
    project: "someone/repo",
    version: 0,
    status: "active",
    done: "做完",
    trigger: [{ kind: "phrase", value: "跑一下" }],
    steps:
      steps ||
      [
        {
          id: "A1",
          phase: "准备",
          title: "第一步",
          when: "有人要跑",
          do: "做一件事",
          who: "main",
          tool: "true",
          done: "这件事做完了",
          risk: "R0",
          needs: [],
          why: "没有它后面没得跑",
          evidence: ["上次没有它，跑到一半才发现前置没做"]
        },
        {
          id: "A2",
          phase: "收尾",
          title: "第二步",
          when: "第一步做完",
          do: "做另一件事",
          who: "main",
          tool: "true",
          done: "这件事也做完了",
          risk: "R0",
          needs: ["A1"],
          why: "没有它没人知道跑完了",
          evidence: ["上次漏了它，以为没跑完"]
        }
      ]
  });
}

function seededProject(root, { steps = null } = {}) {
  const dir = join(root, ".mneme", "pipelines");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "demo.json"), pipelineFile(steps), "utf8");
  return dir;
}

/** 一条**完整**的账本行。手写账也得完整：读盘路径不替它补缺的布尔。 */
function ledgerLine({ at, by = "main", triggeredBy = "", steps }) {
  return JSON.stringify({
    at,
    by,
    triggeredBy,
    steps: steps.map((s) => ({ skipped: false, detoured: false, refuted: false, note: "", ...s }))
  });
}

function writeLedger(dir, id, lines, { trailingNewline = true } = {}) {
  writeFileSync(join(dir, `${id}${RUNS_SUFFIX}`), lines.join("\n") + (trailingNewline ? "\n" : ""), "utf8");
}

function goodRun(overrides = {}) {
  return {
    at: "2026-10-15T09:00:00.000Z",
    by: "main",
    triggeredBy: "跑一下",
    steps: [{ id: "A1", at: "2026-10-15T09:00:01.000Z" }],
    ...overrides
  };
}

class FakeRes {
  constructor() {
    this.statusCode = 200;
    this.body = "";
  }
  writeHead(code) {
    this.statusCode = code;
    return this;
  }
  end(text) {
    this.body = text ?? "";
    return this;
  }
}

function buildApi() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, { add() {}, remove() {}, list: () => [] }, null, undefined, "");
  return routes.find((r) => r.path === "/api/dsh-mneme/pipeline");
}

/** 走真路由读一次面板数据；返回 { status, doc }。 */
function apiDoc(root, { id = null } = {}) {
  const query = new URLSearchParams();
  if (id !== null) query.set("id", id);
  if (root !== null) query.set("project", root);
  const res = new FakeRes();
  buildApi().handler({ url: `/api/dsh-mneme/pipeline?${query}`, method: "GET", headers: {} }, res);
  return { status: res.statusCode, doc: JSON.parse(res.body) };
}

// ── 落点：与人手写的 .json 分开 ────────────────────────────────────────────────

test("落点是 <项目>/.mneme/pipelines/<id>.runs.jsonl，与手写的 .json 分开", () => {
  // 分开是刻意的：.json 是人手写、要 review、要提交的；.runs.jsonl 是每次都追加的
  // 运行账。同住一个文件的话，一次 run 就会把人的 diff 冲掉。
  const root = join(tmpdir(), "proj");
  const p = runsPath(root, "demo");
  assert.equal(p, join(root, ".mneme", "pipelines", `demo${RUNS_SUFFIX}`));
  assert.equal(p === join(root, ".mneme", "pipelines", "demo.json"), false);
  assert.equal(runsDir(root), dirname(p));
});

test("id 不是文件名，是**一个**文件名：路径穿越与绝对路径都拒掉", () => {
  // 拒而不是清洗：清洗过的 id 会指向一个用户没指定的文件，那是更难查的一类错。
  const root = join(tmpdir(), "proj");
  assert.throws(() => runsPath(root, "../../etc/passwd"), (e) => e.name === "RunError");
  assert.throws(() => runsPath(root, "a/b"), (e) => e.name === "RunError");
  assert.throws(() => runsPath(root, "a\\b"), (e) => e.name === "RunError");
  assert.throws(() => runsPath(root, ".."), (e) => e.name === "RunError");
  assert.throws(() => runsPath(root, ""), (e) => e.name === "RunError");
  assert.throws(() => runsPath(root, null), (e) => e.name === "RunError");
});

// ── 读侧：空是实话，坏行报噪（但不再判死整份账本）────────────────────────────

test("状态词表是封闭的：absent / empty / ok / partial / broken", () => {
  // 锁住词表：客户端按这五个值分支，多一个少一个都要有人先改这里。
  assert.deepEqual([...RUNS_STATES], ["absent", "empty", "ok", "partial", "broken"]);
});

test("目录不存在、文件不存在 → absent；空文件 → empty：两者必须分得开", () => {
  // 「没人写过账」与「有人碰过这个文件但还没写进一次运行」在节点状态上都表现为
  // 全体 candidate；面板要能说出是哪一种，就不能把它们压成一个值。
  withDir((root) => {
    const missing = readRuns(root, "demo");
    assert.deepEqual(missing.runs, []);
    assert.deepEqual(missing.problems, []);
    assert.equal(missing.state, "absent");

    const dir = seededProject(root);
    writeFileSync(join(dir, `demo${RUNS_SUFFIX}`), "", "utf8");
    const blank = readRuns(root, "demo");
    assert.deepEqual(blank.runs, []);
    assert.deepEqual(blank.problems, []);
    assert.equal(blank.state, "empty");

    // 只有空白字符的账本同样算「空的」：它没有一行数据。
    writeFileSync(join(dir, `demo${RUNS_SUFFIX}`), "\n  \n", "utf8");
    assert.equal(readRuns(root, "demo").state, "empty");
  });
});

test("中间一行坏掉：报噪 + 跳过那一行，其余照收（不再判死整份账本）", () => {
  // 一次坏行就让全部历史永久读不出来，代价与故障严重程度不成比例；
  // 但**报噪不能省**：坏行进 problems、状态降成 partial，端点再带成 runsErrors。
  withDir((root) => {
    const dir = seededProject(root);
    writeLedger(dir, "demo", [
      ledgerLine({ at: "2026-10-13T09:00:00.000Z", steps: [{ id: "A1", at: "2026-10-13T09:00:01.000Z" }] }),
      "{ 半个对象",
      ledgerLine({ at: "2026-10-15T09:00:00.000Z", steps: [{ id: "A1", at: "2026-10-15T09:00:01.000Z" }] })
    ]);

    const report = readRuns(root, "demo");
    assert.equal(report.runs.length, 2, "好的两行要读出来");
    assert.equal(report.problems.length, 1);
    assert.equal(report.problems[0].line, 2, "要指到第几行");
    assert.equal(report.problems[0].truncated, false, "中间那行不是截断，是垃圾");
    assert.equal(report.state, "partial");
  });
});

test("末行被截断（不以换行结尾）：读回 N-1 条 + problems 非空", () => {
  withDir((root) => {
    const dir = seededProject(root);
    writeLedger(
      dir,
      "demo",
      [
        ledgerLine({ at: "2026-10-13T09:00:00.000Z", steps: [{ id: "A1", at: "2026-10-13T09:00:01.000Z" }] }),
        ledgerLine({ at: "2026-10-14T09:00:00.000Z", steps: [{ id: "A1", at: "2026-10-14T09:00:01.000Z" }] }),
        '{"at":"2026-10-15T09:00:00.000Z","by":"main","steps":[{"id":"A1","at":"2026-10-1'
      ],
      { trailingNewline: false }
    );

    const report = readRuns(root, "demo");
    assert.equal(report.runs.length, 2, "截断那一行之外的两条要在");
    assert.equal(report.problems.length, 1);
    assert.equal(report.problems[0].line, 3);
    assert.equal(report.problems[0].truncated, true, "可判定的截断：末行 + 文件不以换行结尾");
    assert.equal(report.state, "partial");
  });
});

test("截断过的账本仍能继续追加：写成功不会让读永久失败", () => {
  // 这是「写侧报成功、读侧永久抛」的真实危害：一次断电之后账本不仅读不出来，
  // 还会因为随后的合法追加而**永远**读不出来（坏行成了中间行）。
  withDir((root) => {
    const dir = seededProject(root);
    writeLedger(
      dir,
      "demo",
      [
        ledgerLine({ at: "2026-10-14T09:00:00.000Z", steps: [{ id: "A1", at: "2026-10-14T09:00:01.000Z" }] }),
        '{"at":"2026-10-15T09:00:00.0'
      ],
      { trailingNewline: false }
    );

    appendRun(root, "demo", goodRun({ at: "2026-10-15T10:00:00.000Z" }));

    const report = readRuns(root, "demo");
    assert.equal(report.runs.length, 2, "旧的好行 + 新追加的那条");
    assert.equal(report.problems.length, 1, "坏行仍然被报出来");
    assert.equal(report.state, "partial");
    assert.equal(report.runs[1].at, "2026-10-15T10:00:00.000Z", "新那条没和坏行粘在一起");
  });
});

test("尾部空行不算一行账；BOM 不算数据（两种可修复的读不出来）", () => {
  // 多按一次回车、编辑器自作主张加 BOM：两者都会让「整份账本读不出来」，
  // 而它们都不是账本的内容——修在读侧，比让人拿十六进制编辑器去救便宜。
  withDir((root) => {
    const dir = seededProject(root);
    const line = ledgerLine({ at: "2026-10-15T09:00:00.000Z", steps: [{ id: "A1", at: "2026-10-15T09:00:01.000Z" }] });

    writeFileSync(join(dir, `demo${RUNS_SUFFIX}`), `${line}\n\n\n`, "utf8");
    assert.equal(readRuns(root, "demo").state, "ok", "尾部空行不该算坏行");

    writeFileSync(join(dir, `demo${RUNS_SUFFIX}`), `\ufeff${line}\n`, "utf8");
    const bom = readRuns(root, "demo");
    assert.equal(bom.state, "ok", "BOM 不该让第一行解析失败");
    assert.equal(bom.runs.length, 1);
  });
});

test("形状不对的行照样报噪：by 不在 ACTORS / steps 空 / step id 重复", () => {
  withDir((root) => {
    const dir = seededProject(root);
    const step = { id: "A1", at: "2026-10-15T09:00:01.000Z" };

    writeLedger(dir, "demo", [ledgerLine({ at: "2026-10-15T09:00:00.000Z", by: "robot", steps: [step] })]);
    assert.match(readRuns(root, "demo").problems[0].detail, /by/);

    writeLedger(dir, "demo", [JSON.stringify({ at: "2026-10-15T09:00:00.000Z", by: "main", steps: [] })]);
    assert.match(readRuns(root, "demo").problems[0].detail, /steps/);

    // 同一条 run 里同一个 step 出现两次：tallyRuns 会数两次，使用次数虚高。
    writeLedger(dir, "demo", [
      ledgerLine({ at: "2026-10-15T09:00:00.000Z", steps: [step, { ...step, at: "2026-10-15T09:00:02.000Z" }] })
    ]);
    assert.match(readRuns(root, "demo").problems[0].detail, /两次/);
  });
});

test("读盘缺布尔就算缺：只有 {id, at} 的行绝不能被算作一次使用", () => {
  // 回归锁，指向一个「读侧在制造正面证据」的缺陷：补 `false` 让 tallyRuns 认为
  // 「既没跳过也没绕行」→ uses +1 → 节点由 candidate 变 trusted。
  // 账本没说话，面板却在作证；这比读不出来严重得多。
  withDir((root) => {
    const dir = seededProject(root);
    writeLedger(dir, "demo", [
      JSON.stringify({ at: "2026-10-15T09:00:00.000Z", by: "main", steps: [{ id: "A1", at: "2026-10-15T09:00:01.000Z" }] })
    ]);

    const report = readRuns(root, "demo");
    assert.equal(report.runs.length, 0, "缺字段的行不进 runs");
    assert.equal(report.problems.length, 1);
    assert.match(report.problems[0].detail, /skipped/);
    assert.equal(report.state, "broken", "一条可用的记录都没收到");

    // 端到端：那个节点必须还是 candidate、credit 还是 null（不是「用过一次」）。
    const doc = readPipelineDoc({ projectRoot: root, id: "demo", pluginDir: root, runsById: { demo: report.runs } });
    const a1 = doc.nodes.find((n) => n.id === "A1");
    assert.equal(a1.state, "candidate");
    assert.equal(a1.credit, null);
  });
});

test("kind 只认 detour：不认识的取值报噪，不静默丢掉这一步的结局", () => {
  withDir((root) => {
    const dir = seededProject(root);
    writeLedger(dir, "demo", [
      JSON.stringify({
        at: "2026-10-15T09:00:00.000Z",
        by: "main",
        steps: [{ id: "A1", at: "2026-10-15T09:00:01.000Z", skipped: false, refuted: false, kind: "skip" }]
      })
    ]);
    const report = readRuns(root, "demo");
    assert.equal(report.runs.length, 0);
    assert.match(report.problems[0].detail, /kind/);
  });
});

// ── 写侧：一行一条，形状由收口函数保证 ────────────────────────────────────────

test("normalizeRun 把一条 run 收成契约形状（缺的补默认、多余的丢掉）", () => {
  const run = normalizeRun({
    at: "2026-10-15T09:00:00.000Z",
    by: "subagent",
    triggeredBy: "跑一下",
    steps: [{ id: "A1", at: "2026-10-15T09:00:01.000Z", skipped: true, note: "这次不用" }]
  });
  assert.deepEqual(run, {
    at: "2026-10-15T09:00:00.000Z",
    by: "subagent",
    triggeredBy: "跑一下",
    steps: [
      { id: "A1", at: "2026-10-15T09:00:01.000Z", skipped: true, detoured: false, refuted: false, note: "这次不用" }
    ]
  });
});

test("时间戳收成 ISO 毫秒：秒级、带偏移、Date、毫秒数都拉齐成同一个形状", () => {
  assert.equal(normalizeRun(goodRun({ at: new Date("2026-10-15T09:00:00.000Z") })).at, "2026-10-15T09:00:00.000Z");
  assert.equal(normalizeRun(goodRun({ at: "2026-10-15T09:00:00Z" })).at, "2026-10-15T09:00:00.000Z");
  assert.equal(normalizeRun(goodRun({ at: "2026-10-15T17:00:00+08:00" })).at, "2026-10-15T09:00:00.000Z");
  assert.equal(normalizeRun(goodRun({ at: Date.parse("2026-10-15T09:00:00.000Z") })).at, "2026-10-15T09:00:00.000Z");
  // 收成唯一一种形状，是因为读侧拿 step.at **按字符串比大小**取 lastUsedAt：
  // 混着 `...:01Z` 与 `...:01.500Z` 时，比较结果与人对先后的直觉不一致。
  assert.equal(normalizeRun(goodRun({ at: "2026-10-15" })).at, "2026-10-15T00:00:00.000Z");
  // 时间不做「补默认」：一次 run 什么时候跑的只有调用方知道，替它猜就是编数据。
  assert.throws(() => normalizeRun(goodRun({ at: "不是时间" })), (e) => e.name === "RunError");
  assert.throws(() => normalizeRun(goodRun({ at: undefined })), (e) => e.name === "RunError");
  assert.throws(() => normalizeRun(goodRun({ at: "" })), (e) => e.name === "RunError");
  assert.throws(() => normalizeRun(goodRun({ steps: [{ id: "A1" }] })), (e) => /at/.test(e.message));
});

test("normalizeRun：图里没有的步骤 id 报出来，不许悄悄记进去", () => {
  // 记进去会让 tallyRuns 数出一个不属于任何节点的账：面板上没有任何地方显示它，
  // 这条 run 于是成了「写了但看不见」。
  const bad = goodRun({ steps: [{ id: "NOPE", at: "2026-10-15T09:00:01.000Z" }] });
  assert.throws(() => normalizeRun(bad, { expectedStepIds: ["A1", "A2"] }), (e) => /NOPE/.test(e.message));
  assert.doesNotThrow(() => normalizeRun(bad));
});

test("appendRun 也要过 step id 闸门：写错的 id 当场拒，盘上不留东西", () => {
  // 闸门只挂在测试调用的那一层等于没挂：写盘之前拒掉，才是唯一能防住
  // 「落盘了、数得出来、面板永远看不见」的时刻。
  withDir((root) => {
    seededProject(root);
    assert.throws(
      () => appendRun(root, "demo", goodRun({ steps: [{ id: "NOPE", at: "2026-10-15T09:00:01.000Z" }] }), { expectedStepIds: ["A1", "A2"] }),
      (e) => e instanceof RunError && /NOPE/.test(e.message)
    );
    assert.equal(existsSync(runsPath(root, "demo")), false, "被拒的 run 不该留下账本文件");

    // 图上有的步骤照常写得进去。
    const written = appendRun(root, "demo", goodRun(), { expectedStepIds: ["A1", "A2"] });
    assert.equal(written.steps[0].id, "A1");
    assert.equal(readRuns(root, "demo").state, "ok");
  });
});

test("appendRun 一次一行：目录自己建、已有内容不以换行结尾也不会粘行", () => {
  withDir((root) => {
    // 目录都不存在时也要能落下来——第一次跑一条工作流就是这个状态。
    appendRun(root, "demo", goodRun({ at: "2026-10-14T09:00:00.000Z" }));
    assert.equal(existsSync(runsPath(root, "demo")), true);

    // 手工写一条**不带结尾换行**的半行（模拟被别的东西截断/手写过的账本）：
    // 直接追加会把两条 run 粘成一行。手写的行也得是完整的——读盘路径不替它补布尔。
    writeFileSync(
      runsPath(root, "demo"),
      ledgerLine({ at: "2026-10-14T09:00:00.000Z", steps: [{ id: "A1", at: "2026-10-14T09:00:01.000Z" }] }),
      "utf8"
    );
    appendRun(root, "demo", goodRun({ at: "2026-10-15T09:00:00.000Z" }));

    const runs = readRuns(root, "demo").runs;
    assert.equal(runs.length, 2, "两条 run 必须各自成行");
    assert.deepEqual(runs.map((r) => r.at), ["2026-10-14T09:00:00.000Z", "2026-10-15T09:00:00.000Z"]);
  });
});

test("appendRun 只看账本尾 1 字节，不整份读（热路径代价与账本长度无关）", () => {
  // 复杂度不是可观测行为，一次调用的结果证伪不了它，所以这里锁实现方式，
  // 另用一个几千行的账本证明行为仍然对。为什么值得一条锁：账本只增不减，
  // 「每次追加重读全文」的代价是渐进的——不会有人报 bug，只会有人觉得面板变慢。
  const src = readFileSync(join(here, "..", "src", "pipeline-runs.js"), "utf8");
  const start = src.indexOf("function tailNeedsNewline");
  const end = src.indexOf("export function loadRunsById");
  assert.ok(start > 0 && end > start, "定位不到追加路径的实现");
  const appendPath = src.slice(start, end);
  assert.equal(/readFileSync/.test(appendPath), false, "追加路径不得整份读账本");
  assert.equal(/fstatSync/.test(appendPath) && /readSync/.test(appendPath), true, "尾字节要用 open + fstat + read 取");

  withDir((root) => {
    const dir = seededProject(root);
    const lines = [];
    for (let i = 0; i < 2000; i++) {
      const day = String((i % 28) + 1).padStart(2, "0");
      lines.push(ledgerLine({ at: `2026-09-${day}T09:00:00.000Z`, steps: [{ id: "A1", at: `2026-09-${day}T09:00:01.000Z` }] }));
    }
    writeLedger(dir, "demo", lines);
    appendRun(root, "demo", goodRun({ at: "2026-10-15T09:00:00.000Z" }));

    const report = readRuns(root, "demo");
    assert.equal(report.problems.length, 0);
    assert.equal(report.runs.length, 2001, "大账本照常追加");
    assert.equal(report.runs[2000].at, "2026-10-15T09:00:00.000Z");
  });
});

test("落盘格式是锁死的：一行一条 JSON，字段齐全", () => {
  // 账本是人也要读的（`git diff` 里会看到它）。少一个默认值、多个字段，
  // 都会让「人工看一条 run」变成解谜。
  withDir((root) => {
    seededProject(root);
    appendRun(root, "demo", goodRun());
    const raw = readFileSync(runsPath(root, "demo"), "utf8");
    const lines = raw.split(/\r\n|\n/).filter((l) => l !== "");
    assert.equal(lines.length, 1, "一次 run 只占一行");
    assert.deepEqual(Object.keys(JSON.parse(lines[0])), ["at", "by", "triggeredBy", "steps"]);
    assert.deepEqual(Object.keys(JSON.parse(lines[0]).steps[0]), ["id", "at", "skipped", "detoured", "refuted", "note"]);
    assert.equal(raw.endsWith("\n"), true, "以换行结尾，下一次追加才不会粘行");
  });
});

// ── kind:"detour" 的往返：绕行不许被读成一次成功使用 ─────────────────────────

test("kind:\"detour\" 写进去、读回来仍是绕行，不是一次成功使用", () => {
  // 回归锁：归一化只留契约那六个键，`kind` 被丢掉时，读侧仍认 `kind === "detour"`——
  // 于是一次绕行经「写→读」往返后 credit 从 {uses:0, detoured:1} 翻成 {uses:1, detoured:0}，
  // 节点由 candidate 变 trusted，rework-path 提议永不出现。修在收口处，
  // 因为手写账、历史账、别的写入方都走这条口。
  withDir((root) => {
    seededProject(root);
    appendRun(root, "demo", goodRun({ steps: [{ id: "A1", at: "2026-10-15T09:00:01.000Z", kind: "detour" }] }));

    const report = readRuns(root, "demo");
    assert.equal(report.problems.length, 0);
    assert.equal(report.runs[0].steps[0].detoured, true);
    assert.equal(report.runs[0].steps[0].skipped, false);

    const doc = readPipelineDoc({ projectRoot: root, id: "demo", pluginDir: root, runsById: { demo: report.runs } });
    const a1 = doc.nodes.find((n) => n.id === "A1");
    assert.equal(a1.credit.uses, 0, "绕行不是使用");
    assert.equal(a1.credit.detoured, 1);
    assert.notEqual(a1.state, "trusted", "被绕开不等于这一步被验证过");
  });
});

test("手写账里的 kind:\"detour\" 同样认：只给 kind、不给三个布尔也算完整", () => {
  // 旧写法只有一个 `kind` 字段。它必须被认下来（而不是因为「缺 detoured」被判成坏行），
  // 否则老账本会整段变成噪音。
  withDir((root) => {
    const dir = seededProject(root);
    writeLedger(dir, "demo", [
      JSON.stringify({
        at: "2026-10-15T09:00:00.000Z",
        by: "main",
        steps: [{ id: "A1", at: "2026-10-15T09:00:01.000Z", kind: "detour", skipped: false, refuted: false }]
      })
    ]);
    const report = readRuns(root, "demo");
    assert.equal(report.problems.length, 0);
    assert.equal(report.runs[0].steps[0].detoured, true);
    assert.equal(report.state, "ok");
  });
});

// ── 行为级：写下去的那条 run 要能被读侧数出来 ────────────────────────────────

test("行为级：一次 run 落盘后，readPipelineDoc 的 nodes[].credit 与 state 真的变了", () => {
  withDir((root) => {
    seededProject(root);

    // 写之前：没有账 → 全体 candidate（这是读侧如实说的「还没跑过」）。
    const before = readPipelineDoc({ projectRoot: root, id: "demo", pluginDir: root });
    assert.deepEqual([...new Set(before.nodes.map((n) => n.state))], ["candidate"]);

    appendRun(root, "demo", {
      at: "2026-10-15T09:00:00.000Z",
      by: "human",
      triggeredBy: "跑一下",
      steps: [
        { id: "A1", at: "2026-10-15T09:00:01.000Z" },
        { id: "A2", at: "2026-10-15T09:00:02.000Z", refuted: true }
      ]
    });

    const runsById = loadRunsById(root, ["demo"]).runsById;
    const after = readPipelineDoc({ projectRoot: root, id: "demo", pluginDir: root, runsById });
    assert.equal(after.runs.length, 1);

    const byId = Object.fromEntries(after.nodes.map((n) => [n.id, n]));
    // 照图走了、没被推翻 → trusted，并记下用了 1 次与最后一次的时间。
    assert.equal(byId.A1.state, "trusted");
    assert.deepEqual(byId.A1.credit, { uses: 1, refuted: 0, skipped: 0, detoured: 0, lastUsedAt: "2026-10-15T09:00:01.000Z" });
    // 走过但被推翻 → refuted：这是唯一有硬判据的信号，染色留给它。
    assert.equal(byId.A2.state, "refuted");
    assert.equal(byId.A2.credit.refuted, 1);
    assert.equal(byId.A2.credit.uses, 1);

    // 清单页的账也要跟着动：首屏不能还是「全 candidate」。
    assert.deepEqual(after.available[0].states, { candidate: 0, trusted: 1, stale: 0, refuted: 1 });
  });
});

test("行为级：跳过与绕开各自独立累加，谁都不吞谁（两种提议一起发得出来）", () => {
  withDir((root) => {
    seededProject(root);
    // 一次同时「跳过」+「绕开」：两件事驱动的提议不同（删这一步 / 重画这条路），
    // 第一版写成 if/else if 时绕行把跳过吃掉了，两种提议一起哑掉。
    const line = { id: "A1", at: "2026-10-15T09:00:01.000Z", skipped: true, detoured: true };
    for (const at of ["2026-10-13T09:00:00.000Z", "2026-10-14T09:00:00.000Z", "2026-10-15T09:00:00.000Z"]) {
      appendRun(root, "demo", { at, by: "main", triggeredBy: "", steps: [line] });
    }

    const runsById = loadRunsById(root, ["demo"]).runsById;
    const doc = readPipelineDoc({ projectRoot: root, id: "demo", pluginDir: root, runsById });
    const a1 = doc.nodes.find((n) => n.id === "A1");
    assert.equal(a1.credit.uses, 0, "跳过/绕开都不是「用了这一步」");
    assert.equal(a1.credit.skipped, 3);
    assert.equal(a1.credit.detoured, 3);

    // 计数到阈值就该冒出提议——这是执行链存在的理由：不用人等巡检。
    // R2 新语义：A1 是必经（无 optional）且从未 uses、被跳 3 次 → drop-step 与
    // rework-path **并存**（删与修图两种读法都给人，谁也不吞谁）。
    const kinds = doc.suggestions.map((s) => s.kind).sort();
    assert.deepEqual(kinds, ["drop-step", "rework-path", "rework-path"].sort(), JSON.stringify(doc.suggestions));
    // 绕开不染色：染色要留给真正被推翻过的。
    assert.equal(a1.state, "stale");
  });
});

// ── 端点接线：面板拿得到的那一份 ─────────────────────────────────────────────

test("端点：一次 run 喂进去，节点不再是 candidate，且状态是 ok", () => {
  withDir((root) => {
    seededProject(root);
    appendRun(root, "demo", goodRun({ steps: [{ id: "A1", at: "2026-10-15T09:00:01.000Z" }] }));

    const { status, doc } = apiDoc(root, { id: "demo" });
    assert.equal(status, 200);
    assert.equal(doc.runs.length, 1, "run 记录要走到投影里");
    const a1 = doc.nodes.find((n) => n.id === "A1");
    assert.equal(a1.state, "trusted");
    assert.equal(a1.credit.uses, 1);
    assert.equal(doc.runsState, "ok");
    assert.equal(doc.available[0].runsState, "ok");
    assert.deepEqual(doc.runsErrors, [], "读得干净时不该有噪音");
  });
});

test("端点：absent 与 empty 在响应里分得开（不靠 state 猜）", () => {
  withDir((root) => {
    const dir = seededProject(root);
    const absent = apiDoc(root, { id: "demo" }).doc;
    assert.equal(absent.runsState, "absent");
    assert.deepEqual(absent.runsErrors, []);

    writeFileSync(join(dir, `demo${RUNS_SUFFIX}`), "", "utf8");
    const empty = apiDoc(root, { id: "demo" }).doc;
    assert.equal(empty.runsState, "empty");
    // 两种情况下节点状态完全同形（都是 candidate）——这正是必须另给一个字段的原因。
    assert.deepEqual(absent.available[0].states, empty.available[0].states);
  });
});

test("端点：账本坏掉时说清坏在哪，但**不**吞掉那张读得出来的图（不再回 500）", () => {
  // 回归锁：早先对坏账本回 500，客户端把它当成「离线」，连带把工作流本身丢掉。
  // 账本坏了不等于工作流坏了：图照给，噪音与状态另说。
  withDir((root) => {
    const dir = seededProject(root);
    writeLedger(dir, "demo", ["{ 半个对象"]);

    const { status, doc } = apiDoc(root, { id: "demo" });
    assert.equal(status, 200, "账本坏不该让整个端点失败");
    assert.equal(doc.pipeline.id, "demo", "工作流本身还在");
    assert.ok(doc.nodes.length > 0, "图还在");
    assert.equal(doc.runsState, "broken");
    assert.equal(doc.runsErrors.length, 1);
    assert.equal(doc.runsErrors[0].id, "demo");
    assert.equal(doc.runsErrors[0].line, 1, "要能指到行");
    assert.match(doc.runsErrors[0].detail, /demo\.runs\.jsonl/);
    // 读不出来的账不能被算成「跑过」：节点仍是 candidate。
    assert.deepEqual([...new Set(doc.nodes.map((n) => n.state))], ["candidate"]);
  });
});

test("端点：部分坏 = partial，好的那几条照样投影出 credit", () => {
  // 「报噪」的意思不是「整份作废」：坏行归坏行，好行必须继续说话。
  withDir((root) => {
    const dir = seededProject(root);
    writeLedger(dir, "demo", [
      ledgerLine({ at: "2026-10-15T09:00:00.000Z", steps: [{ id: "A1", at: "2026-10-15T09:00:01.000Z" }] }),
      "{ 半个对象"
    ]);

    const { doc } = apiDoc(root, { id: "demo" });
    assert.equal(doc.runsState, "partial");
    assert.equal(doc.runs.length, 1);
    assert.equal(doc.nodes.find((n) => n.id === "A1").state, "trusted");
    assert.equal(doc.runsErrors.length, 1);
  });
});

test("端点：默认视图（不带 id）逐行带 runsState——那一屏才是最常被打开的", () => {
  // 回归锁：早先只有顶层 runsErrors，而默认视图连 500 兜底都没有；
  // 用户的第一个界面看到的是「全体 candidate」，看不出账本是坏的。
  withDir((root) => {
    const dir = seededProject(root);
    writeLedger(dir, "demo", ["{ 半个对象"]);
    // 再放一条干净的工作流进项目层：两行状态必须各说各的。
    writeFileSync(
      join(dir, "other.json"),
      JSON.stringify({
        id: "other",
        name: "另一条",
        project: "someone/repo",
        version: 0,
        status: "active",
        done: "做完",
        trigger: [{ kind: "phrase", value: "跑一下" }],
        steps: [
          { id: "B1", phase: "p", title: "一步", when: "w", do: "d", who: "main", tool: "", done: "x", risk: "R0", needs: [], why: "y", evidence: ["e"] }
        ]
      }),
      "utf8"
    );
    appendRun(root, "other", { at: "2026-10-15T09:00:00.000Z", by: "ci", triggeredBy: "", steps: [{ id: "B1", at: "2026-10-15T09:00:01.000Z" }] });

    const { status, doc } = apiDoc(root);
    assert.equal(status, 200);
    const states = Object.fromEntries(doc.available.map((row) => [row.id, row.runsState]));
    assert.deepEqual(states, { demo: "broken", other: "ok" });
    assert.equal(doc.runsErrors.length, 1);
  });
});

test("端点：账本里写了图上没有的 step id → 看得见的噪音，不是静默", () => {
  // 这条守的是「上线后最常见的错」：宿主步骤与工作流步骤的归属规则还没定，
  // 写进来的 id 对不上图——那条 run 能落盘、能被读，却没有任何节点拿到它，
  // 面板症状与「从没跑过」完全同形。闸门挂在生产路径上（端点的 loadRunsById）。
  withDir((root) => {
    const dir = seededProject(root);
    writeLedger(dir, "demo", [
      ledgerLine({ at: "2026-10-15T09:00:00.000Z", steps: [{ id: "A1", at: "2026-10-15T09:00:01.000Z" }] }),
      ledgerLine({ at: "2026-10-16T09:00:00.000Z", steps: [{ id: "ghost-step", at: "2026-10-16T09:00:01.000Z" }] })
    ]);

    const { doc } = apiDoc(root, { id: "demo" });
    assert.equal(doc.runsState, "partial");
    assert.equal(doc.runs.length, 1, "对不上的那条不进 runs");
    assert.ok(doc.runsErrors.some((e) => /不在工作流的步骤表里/.test(e.detail)), JSON.stringify(doc.runsErrors));
    // 好行照常投影：闸门只拦对不上的那条。
    assert.equal(doc.nodes.find((n) => n.id === "A1").state, "trusted");
  });
});

test("端点：没有项目根时不谎称「没有账本文件」——runsState 给 null", () => {
  // 「读不到」与「读到空」是两回事：项目根拿不到时账本层根本无从读起。
  const { status, doc } = apiDoc(null, { id: "demo" });
  assert.equal(status, 200);
  assert.equal(doc.runsState, null);
  assert.equal(doc.available.every((row) => row.runsState === undefined), true);
});

test("loadRunsById 只读问到的那些 id，没问到的连盘都不碰", () => {
  withDir((root) => {
    const dir = seededProject(root);
    appendRun(root, "demo", goodRun());
    // 同目录里再放一份别人的账本：它没被问到，就不该出现在结果里。
    writeFileSync(join(dir, `other${RUNS_SUFFIX}`), "{ 半个对象\n", "utf8");

    const { runsById, errors, statesById } = loadRunsById(root, ["demo", "never-written"]);
    assert.deepEqual(Object.keys(runsById).sort(), ["demo", "never-written"]);
    assert.equal(runsById.demo.length, 1);
    assert.deepEqual(runsById["never-written"], [], "没跑过就是空数组，不是报错");
    assert.deepEqual(errors, [], "没被问到的坏账本不该污染这次读数");
    // 这张表按 id 查，prototype 是 null（与 runsById 同款，免得 id 叫 __proto__ 时查错）；
    // 断言前摊平成普通对象，别把「原型不同」当成内容不同。
    assert.deepEqual({ ...statesById }, { demo: "ok", "never-written": "absent" });
  });
});

test("loadRunsById：没有步骤表的 id 不套闸门（问不到图就不能假装知道图）", () => {
  withDir((root) => {
    const dir = seededProject(root);
    writeLedger(dir, "demo", [
      ledgerLine({ at: "2026-10-15T09:00:00.000Z", steps: [{ id: "ghost-step", at: "2026-10-15T09:00:01.000Z" }] })
    ]);

    const guarded = loadRunsById(root, ["demo"], { expectedStepIdsById: { demo: ["A1", "A2"] } });
    assert.equal(guarded.runsById.demo.length, 0);
    assert.match(guarded.errors[0].detail, /ghost-step/);

    // 白名单里没有这条工作流（比如 .json 被删了、账本还在）：只能放行，但状态如实报。
    const unguarded = loadRunsById(root, ["demo"], { expectedStepIdsById: {} });
    assert.equal(unguarded.runsById.demo.length, 1);
    assert.deepEqual(unguarded.errors, []);
  });
});

test("runsErrors 的 detail 带文件名与行号：报噪要能直接定位到那一行", () => {
  withDir((root) => {
    const dir = seededProject(root);
    writeLedger(dir, "demo", [
      ledgerLine({ at: "2026-10-15T09:00:00.000Z", steps: [{ id: "A1", at: "2026-10-15T09:00:01.000Z" }] }),
      "  ",
      "{ 半个对象"
    ]);
    const { errors } = loadRunsById(root, ["demo"]);
    assert.equal(errors.length, 2);
    assert.equal(errors[0].line, 2);
    assert.match(errors[0].detail, /demo\.runs\.jsonl 第 2 行/);
    assert.equal(errors[1].line, 3);
  });
});
