import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPipelines,
  validatePipeline,
  toPipelineV1,
  readPipelineDoc,
  suggestRetirements,
  RETIRE_AFTER_SKIPS,
  RETIRE_AFTER_DETOURS,
  projectLabel,
  RISK_LEVELS,
  ACTORS
} from "../src/pipeline.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createApi } from "../src/api.js";

// 这组测试守的是 M.O.（可执行的项目工作流）的读侧。与其它测试不同的一点：它同时
// 是**内容锁**——仓库里真实存在的那条发版工作流必须一直读得出来、且形状合法。
// 理由：工作流本体住仓库、由人写 JSON，没有编译器兜底；一条被改坏的 JSON 要等到
// 面板打开才报错，而那时人已经以为它在那儿了。

const here = dirname(fileURLToPath(import.meta.url));
// 工作流本体住**项目**里：<项目>/.mneme/pipelines/。测试跑在仓库里，项目根就是仓库根
// （dsh-mneme/ 的上一级）——它不在包里，也不该在包里，见下面那条锁。
const REPO_ROOT = join(here, "..", "..");
const REPO_PIPELINES = join(REPO_ROOT, ".mneme", "pipelines");
// 直接 loadPipelines 时要显式给作用域：默认值是 global，用错会让断言看着绿、
// 实际读的是另一层的账。
const PROJECT_SCOPE = { scope: "project", label: "mneme" };

// 起一个只注册路由、不监听端口的 api 实例（与 test/api-routes-gaps.test.js 同款）。
class FakeRes {
  constructor() { this.statusCode = 200; this.body = ""; }
  writeHead(code) { this.statusCode = code; return this; }
  end(text) { this.body = text ?? ""; return this; }
}

function buildApi() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, { add() {}, remove() {}, list: () => [] }, null, undefined, "");
  return { routes };
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "mneme-pipeline-"));
}

function withDir(fn) {
  const dir = tmpDir();
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function minimal(overrides = {}) {
  return {
    id: "demo",
    name: "演示",
    project: "someone/repo",
    version: 0,
    status: "active",
    done: "做完",
    trigger: [{ kind: "phrase", value: "跑一下" }],
    steps: [
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
      }
    ],
    ...overrides
  };
}

test("真实工作流读得出来：目录里那条发版工作流通过校验，且引用自洽", () => {
  const pipelines = loadPipelines(REPO_PIPELINES, PROJECT_SCOPE);
  assert.ok(pipelines.length >= 1, "pipelines/ 下至少要有一条工作流");
  const release = pipelines.find((p) => p.id === "dsh-mneme-release");
  assert.ok(release, "发版工作流必须叫 dsh-mneme-release");
  assert.equal(release.project, "slow-stack/mneme");
  assert.equal(release.status, "active");
  assert.ok(release.steps.length >= 10, "发版不是一条直线，步骤数不该少到十几步以内");

  // 引用自洽：每条 needs 都能落地（悬空引用会让图渲染出一个指向虚空的箭头）。
  const ids = new Set(release.steps.map((s) => s.id));
  for (const step of release.steps) {
    for (const need of step.needs) assert.ok(ids.has(need), `${step.id}.needs 悬空：${need}`);
    assert.ok(RISK_LEVELS.includes(step.risk), `${step.id} 风险档非法`);
    assert.ok(ACTORS.includes(step.who), `${step.id} 执行者非法`);
  }
  // 入口唯一：一张多入口的图没法当流程跑。
  assert.equal(release.steps.filter((s) => s.needs.length === 0).length, 1);
});

test("回归锁：图里每一步都带着反事实对照（没有对照的步骤不该进图）", () => {
  // 防的回归：#4.4 的准入判据是「没有它这次会不会失败」，不是「跑过多少次」。
  // 一条只会成功、不会失败的步骤提炼出来只增加间接层——所以这个文件里每条都要
  // 能指出「上次没做它，发生了什么」。这条锁会在有人往里塞空 evidence 时变红。
  const [release] = loadPipelines(REPO_PIPELINES, PROJECT_SCOPE);
  const bare = release.steps.filter((s) => s.evidence.length === 0).map((s) => s.id);
  assert.deepEqual(bare, [], "这些步骤没有反事实对照，等于没有判据");
});

test("图里有闸门：至少一条 gate 与至少一个汇合点", () => {
  // 防的回归：把「人点头」这类检查点画成普通步骤，于是图上再也看不出哪里会停；
  // 以及把并行收尾的汇合拆成两条独立尾段，图就成了两支互不相干的流程。
  const [release] = loadPipelines(REPO_PIPELINES, PROJECT_SCOPE);
  const doc = toPipelineV1(release, {});
  assert.ok(doc.nodes.some((n) => n.kind === "gate"), "一条工作流都没有闸门，说明它不可执行");
  const fanIn = doc.nodes.filter((n) => doc.edges.filter((e) => e.to === n.id).length > 1);
  assert.ok(fanIn.length >= 1, "没有汇合点：并行段没有收口的地方");
});

test("校验器一次把话说完：不返回「部分可用」", () => {
  const broken = minimal({
    id: "Bad_ID",
    status: "running",
    version: -1,
    trigger: [],
    steps: [
      { id: "A1", phase: "准备", title: "x", when: "x", do: "x", who: "robot", tool: "", done: "x", risk: "R9", needs: ["Z9"], why: "x" },
      { id: "A1", phase: "准备", title: "y", when: "y", do: "y", who: "main", tool: "", done: "y", risk: "R0", needs: [], why: "y" }
    ]
  });
  assert.throws(
    () => validatePipeline(broken, "broken.json"),
    (error) => {
      assert.equal(error.name, "PipelineError");
      assert.equal(error.message.startsWith("broken.json: "), true);
      const issues = error.problems.join(" | ");
      // 一次全报：改一条跑一次是最消耗人的失败模式。
      for (const expect of ["id 必须是小写 kebab", "status 必须是", "version 必须是", "trigger 至少要有一条", "risk 必须是", "who 必须是", "needs 指向了不存在的步骤", "id 重复"]) {
        assert.ok(issues.includes(expect), `漏报：${expect}（实得 ${issues}）`);
      }
      return true;
    }
  );
});

test("环被抓住：回写是新版本，不是回到自己", () => {
  const cyclic = minimal({
    steps: [
      { id: "A1", phase: "p", title: "a", when: "w", do: "d", who: "main", tool: "", done: "x", risk: "R0", needs: ["A3"], why: "y" },
      { id: "A2", phase: "p", title: "b", when: "w", do: "d", who: "main", tool: "", done: "x", risk: "R0", needs: ["A1"], why: "y" },
      { id: "A3", phase: "p", title: "c", when: "w", do: "d", who: "main", tool: "", done: "x", risk: "R0", needs: ["A2"], why: "y" }
    ]
  });
  assert.throws(() => validatePipeline(cyclic), /图里有环/);
});

test("坏文件不静默跳过：目录里有一条读不出来就整体抛", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "ok.json"), JSON.stringify(minimal()), "utf8");
    // 静默跳过最难查：面板上看着少一条，谁也不知道是没写还是写坏了。
    writeFileSync(join(dir, "bad.json"), "{ not json", "utf8");
    assert.throws(() => loadPipelines(dir), /bad\.json: JSON 解析失败/);
  });
});

test("两条工作流撞 id：报出来且指出跟谁撞", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "a.json"), JSON.stringify(minimal()), "utf8");
    writeFileSync(join(dir, "b.json"), JSON.stringify(minimal({ name: "另一个" })), "utf8");
    assert.throws(() => loadPipelines(dir), /id "demo" 与 a\.json 重复/);
  });
});

test("目录不存在返回空表，不是抛错", () => {
  // 面板在任何一次启动里都可能先于文件到位；这里抛错会让整块面板打不开。
  assert.deepEqual(loadPipelines(join(tmpdir(), "definitely-not-there-" + Date.now())), []);
});

test("投影：节点种类、边与 needs 一一对应", () => {
  const pipeline = validatePipeline(minimal({
    steps: [
      { id: "A1", phase: "准备", title: "入口", when: "w", do: "d", who: "main", tool: "", done: "x", risk: "R0", needs: [], why: "y", evidence: ["e"] },
      { id: "A2", phase: "准备", title: "闸门", when: "w", do: "d", who: "human", tool: "", done: "x", risk: "R3", needs: ["A1"], why: "y", evidence: ["e"], gate: true },
      { id: "A3", phase: "收尾", title: "汇合", when: "w", do: "d", who: "main", tool: "", done: "x", risk: "R1", needs: ["A1", "A2"], why: "y", evidence: ["e"] }
    ]
  }));
  const doc = toPipelineV1(pipeline, {});
  assert.equal(doc.contract, "mneme.pipeline/v1");
  assert.deepEqual(doc.nodes.map((n) => n.kind), ["step", "gate", "branch"]);
  assert.equal(doc.edges.length, 3);
  assert.deepEqual(doc.edges.map((e) => e.id).sort(), ["A1->A2", "A1->A3", "A2->A3"]);
  // 这份对象是手工 validate 出来的，没走过 loadPipelines，因此**没有来源**。
  // 空着是实话：默认成 "project" 会让来路不明的工作流看起来像本项目的。
  assert.equal(doc.pipeline.scope, null);
  assert.equal(doc.pipeline.scopeLabel, null);
});

test("节点状态由对照数据推出，不由作者写死", () => {
  const pipeline = validatePipeline(minimal({
    steps: [
      { id: "A1", phase: "p", title: "从没跑过", when: "w", do: "d", who: "main", tool: "", done: "x", risk: "R0", needs: [], why: "y", evidence: ["e"] },
      { id: "A2", phase: "p", title: "跑过没砸", when: "w", do: "d", who: "main", tool: "", done: "x", risk: "R0", needs: ["A1"], why: "y", evidence: ["e"] },
      { id: "A3", phase: "p", title: "砸过", when: "w", do: "d", who: "main", tool: "", done: "x", risk: "R0", needs: ["A2"], why: "y", evidence: ["e"] },
      { id: "A4", phase: "p", title: "很久没碰", when: "w", do: "d", who: "main", tool: "", done: "x", risk: "R0", needs: ["A3"], why: "y", evidence: ["e"] }
    ]
  }));
  const now = Date.parse("2026-10-15T00:00:00Z");
  const doc = toPipelineV1(pipeline, {
    now,
    runs: [
      { id: "r1", steps: [{ id: "A2", at: "2026-10-14T00:00:00Z" }, { id: "A3", at: "2026-10-14T00:00:00Z", refuted: true }, { id: "A4", at: "2026-01-01T00:00:00Z" }] }
    ]
  });
  const state = Object.fromEntries(doc.nodes.map((n) => [n.id, n.state]));
  assert.deepEqual(state, { A1: "candidate", A2: "trusted", A3: "refuted", A4: "stale" });
  // refuted 优先于 stale：被推翻过的步骤不该因为「太久没用」而被降级成中性的 stale。
  assert.equal(doc.nodes.find((n) => n.id === "A3").credit.refuted, 1);
});

test("没有运行记录时，每个节点都是 candidate（这是实话，不是占位）", () => {
  const [release] = loadPipelines(REPO_PIPELINES, PROJECT_SCOPE);
  const doc = toPipelineV1(release, {});
  assert.equal(doc.runs.length, 0);
  assert.deepEqual([...new Set(doc.nodes.map((n) => n.state))], ["candidate"]);
});

test("readPipelineDoc：认不出 id 时不编造，但要列出有什么", () => {
  const doc = readPipelineDoc({ projectRoot: REPO_ROOT, id: "no-such-thing" });
  assert.equal(doc.pipeline, null);
  assert.deepEqual(doc.nodes, []);
  assert.deepEqual(doc.available.map((p) => p.id), ["dsh-mneme-release"]);
});

test("作用域标签对两种分隔符一视同仁：Windows 路径不得整条画进面板", () => {
  // 回归锁，指向一个**只在 posix 上现形**的缺陷：原实现借 path.basename() 取目录名，
  // 它跟着运行平台走——Linux 上一条 Windows 路径会被整条当成标签，而面板是会被
  // 截图、被贴进 issue 的那一面，标签里会带着本机用户名。
  //
  // **这条锁在 Windows 上是绿的、也永远抓不住回退**：win32.basename 两种分隔符都认，
  // 旧实现在本机结果就是对的。它的杀伤力只在 ubuntu 矩阵腿上——别当成冗余删掉。
  const win = projectLabel("C:\\Users\\someone\\Desktop\\dsh-mneme");
  const fwd = projectLabel("C:/Users/someone/Desktop/dsh-mneme");
  const posix = projectLabel("/home/someone/Desktop/dsh-mneme");
  assert.equal(win, "dsh-mneme", "反斜杠路径要取到目录名");
  assert.equal(fwd, "dsh-mneme", "正斜杠路径要取到目录名");
  assert.equal(posix, "dsh-mneme", "posix 路径行为不变");
  assert.equal(projectLabel("/home/someone/Desktop/dsh-mneme/"), "dsh-mneme", "尾随分隔符不改变结果");
  assert.equal(win.includes("someone"), false, "标签里不得出现用户名");
  assert.equal(/[\\/]/.test(win), false, "标签里不得残留分隔符");
  // 取不到目录名时按原样回退（与 basename 的 "" 语义一致）。
  assert.equal(projectLabel("/"), "/", "根路径回退原串");
  assert.equal(projectLabel(""), "", "空串回退原串");
});


test("清单行自带规模与作用域，够第一屏用（不必先读图）", () => {
  const doc = readPipelineDoc({ projectRoot: REPO_ROOT });
  const [row] = doc.available;
  assert.equal(row.scope, "project");
  assert.equal(row.scopeLabel, basename(REPO_ROOT));
  assert.equal(row.steps, 19);
  // 对照覆盖率是这一屏最要紧的数字：19 步就该有 19 条反事实。
  assert.equal(row.contrast, row.steps);
  assert.deepEqual(row.states, { candidate: 19, trusted: 0, stale: 0, refuted: 0 });
});

test("工作流本体住项目里，不进 npm 包", () => {
  // 两头都防：
  //  · 打进包 → 装完插件之后**每个项目**都能读到它，「项目级」又悄悄退回全局级，
  //    而这一幕在任何一次本地测试里都看不出来（测试读的是仓库目录）；
  //  · 只锁「文件存在」不锁「不在包里」→ 上面那条会复发，没人拦。
  const pkg = JSON.parse(
    String(process.getBuiltinModule("node:fs").readFileSync(join(here, "..", "package.json"), "utf8"))
  );
  assert.ok(existsSync(REPO_PIPELINES), "项目层的 .mneme/pipelines/ 必须存在");
  assert.ok(
    !(pkg.files || []).some((f) => f === "pipelines" || f === "pipelines/"),
    "package.json 的 files 不许含 pipelines——那会把项目工作流变成随插件到处跑的全局工作流"
  );
});

test("同 id 两处都有：项目层赢，被遮蔽的那份要报出来而不是消失", () => {
  // 「默认项目级」这句话的落点就在这一条：同一条工作流，项目里那份说话。
  withDir((root) => {
    const dir = join(root, ".mneme", "pipelines");
    mkdirSync(dir, { recursive: true });
    const base = JSON.parse(readFileSync(join(REPO_PIPELINES, "dsh-mneme-release.json"), "utf8"));
    writeFileSync(join(dir, "dsh-mneme-release.json"), JSON.stringify({ ...base, name: "项目版" }), "utf8");
    const doc = readPipelineDoc({ projectRoot: root, pluginDir: REPO_PIPELINES });
    assert.equal(doc.pipeline.title, "项目版");
    // 被遮蔽的那份要**报出来**，不能就这么消失：否则以后有人往全局层加一条同名工作流、
    // 发现它「不见了」，会去翻文件系统而不是查这条遮蔽记录。
    assert.deepEqual(doc.shadowed, [{ id: "dsh-mneme-release", hidden: "global", by: "project" }]);
    assert.equal(doc.sources[0].scope, "project");
    assert.equal(doc.sources[1].scope, "global");
    // 作用域标签只取目录名：绝对路径里有本机用户名，而面板是会被截图的那一面。
    assert.equal(doc.pipeline.scopeLabel, basename(root));
  });
});

test("项目层有坏文件：不拖死全局层，但要报出来", () => {
  withDir((root) => {
    const dir = join(root, ".mneme", "pipelines");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.json"), "{ not json", "utf8");
    const doc = readPipelineDoc({ projectRoot: root, pluginDir: REPO_PIPELINES });
    assert.ok(doc.pipeline, "全局层那份还在");
    assert.equal(doc.unreadable.length, 1);
    assert.equal(doc.unreadable[0].scope, "project");
    // 报出来要能定位到文件：只写「读不了」等于让人自己满目录去找。
    assert.match(doc.unreadable[0].detail, /broken\.json/);
  });
});

test("不给项目根就只读全局层，如实标出来——绝不回退到进程目录", () => {
  // 回退会把「读不到」变成「读到别的地方」，而后者在界面上看不出来，是最难查的一类错。
  const doc = readPipelineDoc({ projectRoot: null, pluginDir: REPO_PIPELINES });
  assert.deepEqual(doc.sources.map((s) => s.scope), ["global"]);
  assert.ok(doc.pipeline);
});

test("路由 /api/dsh-mneme/pipeline：读得出、认不出 id 时不编造、坏文件说清坏在哪", async () => {
  // 接线锁：读侧再好，没人注册路由也到不了面板。用真 createApi 走一遍，
  // 而不是断言源码里出现过某个字符串——路径改了、参数传错了都要能被抓。
  const api = buildApi();
  const route = api.routes.find((r) => r.path === "/api/dsh-mneme/pipeline");
  assert.ok(route, "路由没注册");

  // 不给 project：只读全局层。发布包里没有 pipelines/，所以这里就该是空的——
  // 空是实话，不是错误（面板据此画空态，而不是画成「读不出来」）。
  const noProject = new FakeRes();
  route.handler({ url: "/api/dsh-mneme/pipeline", method: "GET", headers: {} }, noProject);
  assert.equal(noProject.statusCode, 200);
  assert.equal(JSON.parse(noProject.body).pipeline, null);

  // 给 project：读项目层。
  const ok = new FakeRes();
  route.handler({
    url: "/api/dsh-mneme/pipeline?project=" + encodeURIComponent(REPO_ROOT),
    method: "GET",
    headers: {}
  }, ok);
  assert.equal(ok.statusCode, 200);
  const doc = JSON.parse(ok.body);
  assert.equal(doc.contract, "mneme.pipeline/v1");
  assert.equal(doc.pipeline.id, "dsh-mneme-release");
  assert.equal(doc.sources[0].scope, "project");
  assert.ok(doc.nodes.length > 0);

  // 相对路径**拒掉**而不是忽略：忽略了会静默退成「全局」，而全局看起来一切正常
  // ——那正是这一刀要修掉的那类错。
  const relative = new FakeRes();
  route.handler({ url: "/api/dsh-mneme/pipeline?project=dsh-mneme", method: "GET", headers: {} }, relative);
  assert.equal(relative.statusCode, 400);
  assert.equal(JSON.parse(relative.body).error, "project-not-absolute");

  const missing = new FakeRes();
  route.handler({
    url: "/api/dsh-mneme/pipeline?id=nope&project=" + encodeURIComponent(REPO_ROOT),
    method: "GET",
    headers: {}
  }, missing);
  assert.equal(JSON.parse(missing.body).pipeline, null);
});

// ── 绕行与退役提议：跳过 ≠ 绕开 ──────────────────────────────────────────────
// 这一版的核心区分。混在一起数，两种提议就都发不出来：
//   跳过 = 这次不用这一步（图上还在）→ 提议删掉**这一步**
//   绕开 = 这条路整个不对（图该重画）→ 提议重看**这条路径**

test("跳过与绕开分开计数，谁都不冒充谁", () => {
  const pipeline = validatePipeline(minimal({
    steps: [
      { id: "A1", phase: "p", title: "a", when: "w", do: "d", who: "main", tool: "", done: "x", risk: "R0", needs: [], why: "y", evidence: ["e"] },
      { id: "A2", phase: "p", title: "b", when: "w", do: "d", who: "main", tool: "", done: "x", risk: "R0", needs: ["A1"], why: "y", evidence: ["e"] }
    ]
  }));
  const doc = toPipelineV1(pipeline, {
    runs: [
      { id: "r1", steps: [{ id: "A1", skipped: true }, { id: "A2", detoured: true }] },
      { id: "r2", steps: [{ id: "A1", skipped: true }, { id: "A2", detoured: true }] }
    ]
  });
  const a1 = doc.nodes.find((n) => n.id === "A1");
  const a2 = doc.nodes.find((n) => n.id === "A2");
  assert.equal(a1.credit.skipped, 2, "A1 是被跳过");
  assert.equal(a1.credit.detoured, 0, "跳过不该被算成绕开");
  assert.equal(a2.credit.detoured, 2, "A2 是被绕开");
  assert.equal(a2.credit.skipped, 0, "绕开不该被算成跳过");
  // 两者都不算「用了这一步」——绕行和跳过都没走那一步。
  assert.equal(a1.credit.uses, 0);
  assert.equal(a2.credit.uses, 0);
});

test("绕行不染色：被绕开不等于这一步坏了", () => {
  // 染色要留给真正被推翻过的（refuted）——那是唯一有硬判据的信号。
  // 把「被绕开」也染红，会让图上到处都是红点，人就不看了。
  const pipeline = validatePipeline(minimal({
    steps: [
      { id: "A1", phase: "p", title: "a", when: "w", do: "d", who: "main", tool: "", done: "x", risk: "R0", needs: [], why: "y", evidence: ["e"] }
    ]
  }));
  const doc = toPipelineV1(pipeline, { runs: [{ id: "r1", steps: [{ id: "A1", detoured: true }] }] });
  assert.equal(doc.nodes[0].state, "candidate", "绕开不改变状态，只累加计数");
  assert.equal(doc.nodes[0].credit.detoured, 1);
});

test(`跳过 ≥${RETIRE_AFTER_SKIPS} 次 → 提议删掉这一步`, () => {
  const pipeline = validatePipeline(minimal({
    steps: [
      { id: "A1", phase: "p", title: "这一步其实是多余的", when: "w", do: "d", who: "main", tool: "", done: "x", risk: "R0", needs: [], why: "y", evidence: ["e"] },
      { id: "A2", phase: "p", title: "b", when: "w", do: "d", who: "main", tool: "", done: "x", risk: "R0", needs: ["A1"], why: "y", evidence: ["e"] }
    ]
  }));
  const runs = [{ id: "r1", steps: [{ id: "A1", skipped: true }, { id: "A2" }] },
                { id: "r2", steps: [{ id: "A1", skipped: true }, { id: "A2" }] },
                { id: "r3", steps: [{ id: "A1", skipped: true }, { id: "A2" }] }];
  const s = suggestRetirements(pipeline, { runs });
  assert.equal(s.length, 1);
  assert.equal(s[0].kind, "drop-step");
  assert.equal(s[0].stepId, "A1");
  assert.match(s[0].because, /跳过 3 次/);
});

test(`绕开 ≥${RETIRE_AFTER_DETOURS} 次 → 提议重看这条路径（不是删节点）`, () => {
  const pipeline = validatePipeline(minimal({
    steps: [
      { id: "A1", phase: "p", title: "从这里开始岔出去", when: "w", do: "d", who: "main", tool: "", done: "x", risk: "R0", needs: [], why: "y", evidence: ["e"] },
      { id: "A2", phase: "p", title: "b", when: "w", do: "d", who: "main", tool: "", done: "x", risk: "R0", needs: ["A1"], why: "y", evidence: ["e"] }
    ]
  }));
  const runs = [{ id: "r1", steps: [{ id: "A1", detoured: true }, { id: "A2" }] },
                { id: "r2", steps: [{ id: "A1", detoured: true }, { id: "A2" }] },
                { id: "r3", steps: [{ id: "A1", detoured: true }, { id: "A2" }] }];
  const s = suggestRetirements(pipeline, { runs });
  assert.equal(s.length, 1);
  assert.equal(s[0].kind, "rework-path", "绕开动的是「路径」这一层，不是删掉那个点");
  assert.match(s[0].effect, /路径/);
});

test("没到阈值就不提议；两种提议可以同时出现但各自独立", () => {
  const pipeline = validatePipeline(minimal({
    steps: [
      { id: "A1", phase: "p", title: "a", when: "w", do: "d", who: "main", tool: "", done: "x", risk: "R0", needs: [], why: "y", evidence: ["e"] },
      { id: "A2", phase: "p", title: "b", when: "w", do: "d", who: "main", tool: "", done: "x", risk: "R0", needs: ["A1"], why: "y", evidence: ["e"] }
    ]
  }));
  assert.deepEqual(suggestRetirements(pipeline, { runs: [{ id: "r1", steps: [{ id: "A1", skipped: true }] }] }), [],
    "跳过一次不该提议");
  const runs = [{ id: "r1", steps: [{ id: "A1", skipped: true, detoured: true }] },
                { id: "r2", steps: [{ id: "A1", skipped: true, detoured: true }] },
                { id: "r3", steps: [{ id: "A1", skipped: true, detoured: true }] }];
  const s = suggestRetirements(pipeline, { runs });
  assert.deepEqual(s.map((x) => x.kind).sort(), ["drop-step", "rework-path"], "同一节点上两种提议互不吞并");
});

test("readPipelineDoc 带上 suggestions（没到阈值时是空数组，不是缺字段）", () => {
  const doc = readPipelineDoc({ projectRoot: REPO_ROOT });
  assert.ok(Array.isArray(doc.suggestions), "字段必须在——缺字段会让面板分不清「没有」和「读不到」");
});

// ── 字段白名单锁：给「静默掉字段」这个洞装一道闸 ────────────────────────────
//
// 为什么需要这道锁：`validatePipeline` 的步骤归一化是**显式字段映射**——白名单外的键
// 会被无声丢弃，不告警、不报错。所以「往工作流里写一个新字段」的默认结局是「它消失了，
// 而面板上看不出少了东西」。这正是本仓历史上反复抓到的那一类「声称改了但产物里查不到」。
//
// 探针实测过（三面逐个数）：往步骤里塞 `assert` / `onFailure` / `retries`，三个全部消失。
// 将来真要加字段，就得同时改三处——归一化返回、节点投影、首屏清单——漏掉任何一处，
// 症状都是「加了但看不见」，且**不会红**。这道锁把那个症状提前到测试里：
// 谁动了字段集合，这里当场变红，逼人把三处一起改完、并把新集合写进断言。
//
// 反面提醒：断言里写的是**全集**而不是「包含」。包含式断言挡不住「多加了一个字段」，
// 而多出来的字段同样会进投影、同样会被前端与 agent 读到——那也是一种契约变更。
//
// 2026-10-16：`assert` 正式进产品（这一步改了四处：校验、归一化返回、节点投影、
// 首屏计数）。三处集合相应更新——**这道锁逼着人一次改完，正是它存在的理由**。

const STEP_KEYS = [
  "assert", "do", "done", "evidence", "gate", "id", "needs", "phase", "risk", "title", "tool", "when", "who", "why"
];
const NODE_KEYS = [
  "action", "assert", "counterfactual", "credit", "done", "id", "kind", "phase", "risk", "situation",
  "source", "state", "title", "tool", "who", "why"
];
const AVAILABLE_KEYS = [
  "assertable", "contrast", "done", "file", "gates", "id", "project", "scope", "scopeLabel", "states",
  "status", "steps", "title", "trigger", "version"
];
const NODE_STATE_KEYS = ["candidate", "refuted", "stale", "trusted"];

test("字段白名单锁：步骤归一化只留这 14 个键，白名单外的键会被静默丢弃", () => {
  const norm = validatePipeline(minimal({
    steps: [{
      id: "A1", phase: "准备", title: "第一步", when: "有人要跑", do: "做一件事",
      who: "main", done: "做完了", risk: "R0", needs: [], why: "因为",
      assert: ["npm test 全绿"],
      // 这两个仍在白名单外：它们属执行侧，等形状定了再加，免得又造两个存不下的字段。
      onFailure: "halt",
      retries: 0
    }]
  }), "lock.json");

  assert.deepEqual(Object.keys(norm.steps[0]).sort(), STEP_KEYS,
    "步骤键集合变了。若这是有意的：请同时改 pipeline.js 的归一化返回、toPipelineV1 的节点投影、summarizePipeline 的首屏计数，再把这里的集合更新掉。");

  // assert 现在留得住（这是 2026-10-16 那一刀要证明的事）
  assert.deepEqual(norm.steps[0].assert, ["npm test 全绿"]);

  // 仍被丢弃的两个：明写断言，将来若接住了这条会红，提醒更新契约与文档。
  for (const key of ["onFailure", "retries"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(norm.steps[0], key), false,
      `${key} 今天不该出现在归一化结果里；它出现了说明白名单被改过，请一并更新本锁与相关文档`);
  }
});

test("字段白名单锁：节点投影 16 个键、首屏清单 15 个键，节点状态恒为四态", () => {
  const norm = validatePipeline(minimal(), "lock.json");
  const withOrigin = { ...norm, origin: { scope: "project", label: "demo", dir: "", file: "lock.json" } };

  const v1 = toPipelineV1(withOrigin, {});
  assert.deepEqual(Object.keys(v1.nodes[0]).sort(), NODE_KEYS,
    "节点键集合变了——前端与 agent 读的是这一份，改它要同步面板");
  assert.equal(v1.nodes[0].credit, null,
    "没有运行记录时 credit 必须是 null——一个「补了默认值的空 credit 对象」会让前端以为「跑过但全是 0」");
  const doc = readPipelineDoc({ projectRoot: REPO_ROOT });
  assert.ok(doc.available.length >= 1);
  assert.deepEqual(Object.keys(doc.available[0]).sort(), AVAILABLE_KEYS,
    "首屏清单行的键集合变了——面板第一屏读的就是这一份");
  assert.deepEqual(Object.keys(doc.available[0].states).sort(), NODE_STATE_KEYS,
    "节点状态只能是这四态；多一态就意味着前端有分支没接");
});

test("可断言节点：没写断言时投影是 null 而不是空数组（「没写」不等于「写了没通过」）", () => {
  const bare = validatePipeline(minimal(), "lock.json"); // minimal 的步骤没有 assert
  const withOrigin = { ...bare, origin: { scope: "project", label: "demo", dir: "", file: "lock.json" } };
  const v1 = toPipelineV1(withOrigin, {});

  assert.equal(v1.nodes[0].assert, null,
    "空数组会让「作者没写断言」与「写了但一条都没过」长得一样——验收时这是两件事");
  // 首屏计数同样要说得清：0/1 是实话，不是缺陷。
  const doc = readPipelineDoc({ projectRoot: REPO_ROOT });
  assert.equal(typeof doc.available[0].assertable, "number");
});

test("可断言节点：写了断言就进投影与首屏计数，且逐条可读", () => {
  const p = validatePipeline(minimal({
    steps: [{
      id: "A1", phase: "准备", title: "第一步", when: "有人要跑", do: "做一件事",
      who: "main", done: "做完了", risk: "R0", needs: [], why: "因为",
      assert: ["git tag 已推送", "release.yml 绿"]
    }]
  }), "lock.json");
  const withOrigin = { ...p, origin: { scope: "project", label: "demo", dir: "", file: "lock.json" } };
  const v1 = toPipelineV1(withOrigin, {});

  assert.deepEqual(v1.nodes[0].assert, { checks: ["git tag 已推送", "release.yml 绿"], count: 2 });
});

test("可断言节点的形参校验：非数组、空串、非字符串都要拒（坏形状不许静默通过）", () => {
  const base = {
    id: "demo", name: "演示", project: "a/b", version: 0, status: "active", done: "做完",
    trigger: [{ kind: "phrase", value: "跑一下" }],
    steps: [{
      id: "A1", phase: "准备", title: "第一步", when: "有人要跑", do: "做一件事",
      who: "main", done: "做完了", risk: "R0", needs: [], why: "因为"
    }]
  };
  const withAssert = (value) => validatePipeline(
    { ...base, steps: [{ ...base.steps[0], assert: value }] }, "x.json");

  assert.throws(() => withAssert("npm test 全绿"), /assert 必须是字符串数组/);
  assert.throws(() => withAssert([""]), /assert\[0\] 必须是非空字符串/);
  assert.throws(() => withAssert([42]), /assert\[0\] 必须是非空字符串/);
  // 空数组是合法的：它就是「判断节点」，只是作者显式写了个空。
  assert.deepEqual(withAssert([]).steps[0].assert, []);
});

// ── 候选路由：与工作流路由是两处不同的东西 ──────────────────────────────────

test("路由 /api/dsh-mneme/candidates：读候选层，且把三条边界写进契约", async () => {
  const api = buildApi();
  const route = api.routes.find((r) => r.path === "/api/dsh-mneme/candidates");
  assert.ok(route, "候选路由没注册");

  const ok = new FakeRes();
  route.handler({
    url: "/api/dsh-mneme/candidates?project=" + encodeURIComponent(REPO_ROOT),
    method: "GET",
    headers: {}
  }, ok);
  assert.equal(ok.statusCode, 200);
  const doc = JSON.parse(ok.body);
  assert.equal(doc.contract, "mneme.candidates/v1");
  // 「这一刀不做的事」写进契约，免得以后有人以为忘了做。
  assert.deepEqual(doc.boundaries, { autoPromote: false, autoApprove: false, injectIntoMemory: false });
  // 候选住本地，不进仓库——契约里给的是本地的家，不是 <项目>/.mneme/。
  assert.match(doc.dir, /candidates/);
  assert.equal(doc.dir.includes(REPO_ROOT), false, "候选目录不该等于项目仓库目录");

  // 相对路径与工作流路由同一口径：拒掉，不静默退成「没有项目」。
  const relative = new FakeRes();
  route.handler({ url: "/api/dsh-mneme/candidates?project=dsh-mneme", method: "GET", headers: {} }, relative);
  assert.equal(relative.statusCode, 400);
  assert.equal(JSON.parse(relative.body).error, "project-not-absolute");
});
