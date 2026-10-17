import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import zlib from "node:zlib";
import { loadPipelines, validatePipeline, projectPipelineDir } from "../src/pipeline.js";
import {
  NUDGE_MIN_SUPPORT,
  DEFAULT_NUDGE_KINDS,
  PROPOSAL_STATUSES,
  COUNTERFACTUAL_CHOICES,
  resolveSessionDir,
  forEachZstdFrame,
  findSessionFiles,
  observationsFromCalls,
  toolCallsInLine,
  readSessionObservations,
  segmentObservations,
  filterSegmentsByKinds,
  safeCommandTokens,
  riskFloorForStep,
  omissionContrast,
  mineRepeatedPatterns,
  buildCounterfactual,
  applyAnswers,
  draftFromCandidate,
  writeDraftPipeline,
  writeFileAtomic,
  proposalDir,
  validateProposal,
  saveProposal,
  loadProposals,
  summarizeProposal,
  retirementProposals,
  nudgeFromSessions
} from "../src/pipeline-nudge.js";

// 这组测试守的是 M.O. 的**沉淀链**：一条手法能不能从真实数据里自己长出来。
// 三条不许越的分界线（见 src/pipeline-nudge.js 文件头），测试逐条守：
//   1. 机器只写它真观察到的东西（措辞里不许出现编出来的判据，也不许漏本机路径）；
//   2. 反事实判据的结论**永远不由机器给**（verdict 必须是 null，问题必须带着选项）；
//   3. 只产 draft，不产 active（写盘函数见到 active 直接拒）。
// 数据面全部用临时目录里的**真会话日志形状**（多帧 zstd + jsonl tool-call），不碰本机记忆库——
// 测试要能在 CI 上跑，也不能把任何真实记忆正文带进仓库。

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "mneme-nudge-"));
}

function withDir(fn) {
  const dir = tmpDir();
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 一行会话日志，形状照 DSH 会话文件：`data.message.content[]` 里是 tool-call，参数是 JSON 字符串。 */
function sessionLine({ turn = 1, calls = [], time = 1700000000000 } = {}) {
  const content = calls.map((c) => ({ type: "tool-call", name: c.name, arguments: JSON.stringify(c.args || {}) }));
  return JSON.stringify({ time, data: { turn, message: { content } } });
}

function skill(name) {
  return { name: "skill", args: { name } };
}

function pwsh(command) {
  return { name: "pwsh", args: { command } };
}

/**
 * 造一份会话日志。`frames` 是帧数组（每帧若干行）——**故意支持多帧**：只解第一帧是
 * 本仓踩过的坑（一个 1.5 MB 文件只解出 291 字节，得出「零命中」的假结论）。
 */
function writeSession(dir, sessionId, frames) {
  const buf = Buffer.concat(frames.map((lines) => zlib.zstdCompressSync(Buffer.from(lines.join("\n"), "utf8"))));
  const sub = join(dir, sessionId);
  mkdirSync(sub, { recursive: true });
  const file = join(sub, "session.v4.jsonl.zstd");
  writeFileSync(file, buf);
  return file;
}

test("多帧 zstd 要逐帧解：只解第一帧会静默丢掉后面的回合", () => {
  withDir((dir) => {
    const sessions = join(dir, "sessions");
    writeSession(sessions, "sess-a", [
      [sessionLine({ turn: 1, calls: [skill("alpha"), skill("beta")] })],
      [sessionLine({ turn: 2, calls: [skill("gamma")] })]
    ]);
    const read = readSessionObservations({ sessionDir: sessions });
    assert.equal(read.present, true);
    assert.equal(read.frames, 2, "两帧都要解出来");
    assert.equal(read.failedFrames, 0);
    assert.equal(read.observations.length, 3, "三处调用（两帧）都要被扫到");
    const turns = new Set(segmentObservations(read.observations).map((s) => s.turn));
    assert.deepEqual([...turns].sort(), [1, 2], "第二帧的那个回合不能被丢");
  });
});

test("截断帧：半行被丢掉，不抛错、也不把半行当成一条记录", () => {
  withDir((dir) => {
    const sessions = join(dir, "sessions");
    const good = zlib.zstdCompressSync(Buffer.from(sessionLine({ turn: 1, calls: [skill("alpha")] }), "utf8"));
    const cut = zlib.zstdCompressSync(Buffer.from(sessionLine({ turn: 2, calls: [skill("beta")] }), "utf8"));
    // 第二帧截掉一半：可能解出半行，也可能解不出来——两种都允许，但不许变成一条可用记录。
    const file = join(sessions, "sess-cut", "session.v4.jsonl.zstd");
    mkdirSync(join(sessions, "sess-cut"), { recursive: true });
    writeFileSync(file, Buffer.concat([good, cut.subarray(0, Math.floor(cut.length / 2))]));
    const read = readSessionObservations({ sessionDir: sessions });
    const names = read.observations.map((o) => o.name);
    assert.deepEqual(names, ["alpha"], "只留完整的那一条：宁可少一条，不要错一条");
  });
});

test("目录读不到与目录是空的必须能分辨（不把「读不到」显示成「没有」）", () => {
  withDir((dir) => {
    const missing = readSessionObservations({ sessionDir: join(dir, "nope") });
    assert.equal(missing.present, false);
    assert.equal(missing.scannedFiles, 0);
    const empty = join(dir, "sessions");
    mkdirSync(empty, { recursive: true });
    const nothing = readSessionObservations({ sessionDir: empty });
    assert.equal(nothing.present, true, "目录在");
    assert.equal(nothing.readable, true, "空目录是可读的");
    assert.equal(nothing.scannedFiles, 0);
    assert.equal(nothing.observations.length, 0);
  });
});

test("findSessionFiles 认所有版本的会话文件，超限时如实标截断", () => {
  withDir((dir) => {
    const sessions = join(dir, "sessions");
    for (const [id, name] of [["s1", "session.v4.jsonl.zstd"], ["s2", "session.v3.jsonl.zstd"], ["s3", "session.jsonl.zstd"]]) {
      mkdirSync(join(sessions, id), { recursive: true });
      writeFileSync(join(sessions, id, name), zlib.zstdCompressSync(Buffer.from("")));
    }
    mkdirSync(join(sessions, "s4"), { recursive: true });
    writeFileSync(join(sessions, "s4", "notes.txt"), "not a session");
    const found = findSessionFiles(sessions);
    assert.equal(found.files.length, 3, "不带版本号的老格式也算会话（只认 v4 会漏掉一半历史）");
    const capped = findSessionFiles(sessions, { limit: 2 });
    assert.equal(capped.files.length, 2);
    assert.equal(capped.truncated, true, "被上限截断要报出来，否则调用方以为扫全了");
  });
});

test("toolCallsInLine 只看 data.message.content，参数在 arguments 且是 JSON 字符串", () => {
  const line = sessionLine({ turn: 7, calls: [skill("agent-reach")] });
  const calls = toolCallsInLine(line);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "skill");
  assert.equal(calls[0].turn, 7);
  assert.deepEqual(calls[0].args, { name: "agent-reach" });
  // 半行不是一条记录。
  assert.deepEqual(toolCallsInLine(line.slice(0, 40)), []);
  // 不含 tool-call 的行直接跳过（省掉一次 JSON.parse）。
  assert.deepEqual(toolCallsInLine('{"data":{"message":{"content":[]}}}'), []);
});

test("能力识别：skill 取参数里的名字，mcp__<server>__<tool> 取 server，内置工具用自己的名字", () => {
  const obs = observationsFromCalls([
    skill("kaoyan-tutor"),
    { name: "mcp__github__list_issues", args: {} },
    pwsh("npm test"),
    { name: "read", args: { file_path: "src/pipeline.js" } }
  ]);
  assert.deepEqual(obs.map((o) => `${o.kind}:${o.name}`), ["skill:kaoyan-tutor", "mcp:github", "tool:pwsh", "tool:read"]);
  // 名字取不到的能力不算一次观察（对不上是要报出来的事实，不是硬凑成一条）。
  assert.deepEqual(observationsFromCalls([{ name: "skill", args: {} }]), []);
});

test("分段：按回合切段，连续同一能力折叠但留下 repeats", () => {
  const observations = observationsFromCalls([
    skill("alpha"),
    skill("alpha"),
    skill("beta"),
    skill("alpha")
  ]);
  observations[3].turn = 2;
  const segments = segmentObservations(observations);
  assert.equal(segments.length, 2, "跨回合要切开");
  assert.deepEqual(segments[0].steps.map((s) => `${s.name}x${s.repeats}`), ["alphax2", "betax1"]);
  assert.deepEqual(segments[1].steps.map((s) => s.name), ["alpha"]);
});

test("挖掘：至少两个不同会话才算候选；同一段路出现两次不算（复用第二次才算类型）", () => {
  withDir((dir) => {
    const sessions = join(dir, "sessions");
    // A 会话里出现两次的模式，支持度只有 1 —— 这是「一条命令被复制粘贴」的情形。
    writeSession(sessions, "sess-a", [
      [sessionLine({ turn: 1, calls: [skill("alpha"), skill("beta")] })],
      [sessionLine({ turn: 2, calls: [skill("alpha"), skill("beta")] })]
    ]);
    const one = readSessionObservations({ sessionDir: sessions });
    assert.deepEqual(mineRepeatedPatterns(segmentObservations(one.observations)), [], `支持度门槛是 ${NUDGE_MIN_SUPPORT} 个不同会话`);

    // 再加两个会话，凑够三个不同会话。
    writeSession(sessions, "sess-b", [[sessionLine({ turn: 1, calls: [skill("alpha"), skill("beta")] })]]);
    writeSession(sessions, "sess-c", [[sessionLine({ turn: 1, calls: [skill("alpha"), skill("beta")] })]]);
    const read = readSessionObservations({ sessionDir: sessions });
    const candidates = mineRepeatedPatterns(segmentObservations(read.observations));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].support, 3);
    assert.equal(candidates[0].occurrences, 4, "同一会话里走过两次也是事实，次数要照记");
    assert.equal(candidates[0].names.length, 2);
  });
});

test("默认只挖能力级：内置工具的通用动作不算手法（本机 520 份日志实测那是噪音）", () => {
  withDir((dir) => {
    const sessions = join(dir, "sessions");
    for (const id of ["sess-a", "sess-b", "sess-c"]) {
      writeSession(sessions, id, [
        [sessionLine({ turn: 1, calls: [{ name: "read", args: {} }, pwsh("npm test"), { name: "read", args: {} }] })]
      ]);
    }
    const read = readSessionObservations({ sessionDir: sessions });
    const segments = segmentObservations(read.observations);
    assert.deepEqual(DEFAULT_NUDGE_KINDS, ["skill", "mcp"]);
    // 三个会话都出现了 read → pwsh，支持度足够高，但它是通用动作习惯，不是项目手法。
    assert.deepEqual(mineRepeatedPatterns(segments), [], "默认口径下这类序列不该冒出来");
    // 显式开工具级才挖得到——而且要把「同一步连着走」重新折叠起来。
    const toolLevel = mineRepeatedPatterns(segments, { kinds: null });
    assert.equal(toolLevel.length, 1);
    assert.deepEqual(toolLevel[0].names, ["tool:read", "tool:pwsh", "tool:read"]);
  });
});

test("按层过滤后要重新折叠：被抽掉的那一层不能把同一步拆成两步", () => {
  const segments = [
    {
      sessionId: "s1",
      turn: 1,
      steps: [
        { key: "skill:alpha", kind: "skill", name: "alpha", tool: "skill", command: "", repeats: 1 },
        { key: "tool:pwsh", kind: "tool", name: "pwsh", tool: "pwsh", command: "npm test", repeats: 1 },
        { key: "skill:alpha", kind: "skill", name: "alpha", tool: "skill", command: "", repeats: 2 }
      ]
    }
  ];
  const scoped = filterSegmentsByKinds(segments, ["skill", "mcp"]);
  assert.equal(scoped[0].steps.length, 1, "中间那次 pwsh 抽掉后，两个 alpha 是相邻的同一步");
  assert.equal(scoped[0].steps[0].repeats, 3, "重复次数要累加，不能丢");
  // kinds 不是数组 = 不过滤（调用方明确要全部）。
  assert.equal(filterSegmentsByKinds(segments, null).length, 1);
  assert.equal(filterSegmentsByKinds(segments, null)[0].steps.length, 3);
});

test("缺席对照：统计口径跟候选自己的语汇走（中间夹着别的层也不算漏步）", () => {
  withDir((dir) => {
    const sessions = join(dir, "sessions");
    // 三个会话：能力级序列 A→B 都在，中间夹没夹 pwsh 与「漏没漏步」无关。
    writeSession(sessions, "sess-a", [[sessionLine({ turn: 1, calls: [skill("alpha"), pwsh("npm test"), skill("beta"), skill("gamma")] })]]);
    writeSession(sessions, "sess-b", [[sessionLine({ turn: 1, calls: [skill("alpha"), skill("beta"), skill("gamma")] })]]);
    // 第四个会话真的漏了 B。
    writeSession(sessions, "sess-d", [[sessionLine({ turn: 1, calls: [skill("alpha"), skill("gamma")] })]]);
    const read = readSessionObservations({ sessionDir: sessions });
    const segments = segmentObservations(read.observations);
    const [candidate] = mineRepeatedPatterns(segments);
    assert.deepEqual(candidate.names, ["skill:alpha", "skill:beta", "skill:gamma"]);
    const contrast = omissionContrast(candidate, segments);
    assert.equal(contrast.steps.length, 1);
    assert.equal(contrast.steps[0].withStep, 2, "夹着 pwsh 的那次也是走全了的");
    assert.equal(contrast.steps[0].withoutStep, 1);
  });
});

test("极大模式：A→B→C 与 A→B 支持度相同时只留长的那条", () => {
  withDir((dir) => {
    const sessions = join(dir, "sessions");
    for (const id of ["sess-a", "sess-b"]) {
      writeSession(sessions, id, [[sessionLine({ turn: 1, calls: [skill("alpha"), skill("beta"), skill("gamma")] })]]);
    }
    const read = readSessionObservations({ sessionDir: sessions });
    const candidates = mineRepeatedPatterns(segmentObservations(read.observations));
    assert.equal(candidates.length, 1, "前缀模式不该跟着长模式一起推给人");
    assert.deepEqual(candidates[0].names, ["skill:alpha", "skill:beta", "skill:gamma"]);
  });
});

test("缺席对照：中间那一步「走过几次 / 少走几次」是能观察的事实，首尾不算", () => {
  withDir((dir) => {
    const sessions = join(dir, "sessions");
    for (const id of ["sess-a", "sess-b", "sess-c"]) {
      writeSession(sessions, id, [[sessionLine({ turn: 1, calls: [skill("alpha"), skill("beta"), skill("gamma")] })]]);
    }
    // 第四个会话少走了中间那一步 —— 这就是「没有它，那次是这么过去的」。
    writeSession(sessions, "sess-d", [[sessionLine({ turn: 1, calls: [skill("alpha"), skill("gamma")] })]]);
    const read = readSessionObservations({ sessionDir: sessions });
    const segments = segmentObservations(read.observations);
    const [candidate] = mineRepeatedPatterns(segments);
    const contrast = omissionContrast(candidate, segments);
    assert.equal(contrast.steps.length, 1, "只有中间的步骤算得出这种对照（首尾省略等于整段没发生）");
    assert.equal(contrast.steps[0].stepId, "S2");
    assert.equal(contrast.steps[0].withStep, 3);
    assert.equal(contrast.steps[0].withoutStep, 1);
    assert.equal(contrast.interiorOnly, true);
  });
});

test("反事实判据不给结论：verdict 是 null，问题带固定选项", () => {
  withDir((dir) => {
    const sessions = join(dir, "sessions");
    for (const id of ["sess-a", "sess-b"]) {
      writeSession(sessions, id, [[sessionLine({ turn: 1, calls: [skill("alpha"), skill("beta")] })]]);
    }
    const read = readSessionObservations({ sessionDir: sessions });
    const segments = segmentObservations(read.observations);
    const [candidate] = mineRepeatedPatterns(segments);
    const cf = buildCounterfactual(candidate, { segments });

    // 这一条是本文件的头号锁：判据**不许**由机器给结论。
    assert.equal(cf.verdict, null, "「没有这条流程会不会漏步/失败」不由代码回答");
    assert.match(cf.verdictNote, /判据不自动判/);
    assert.equal(cf.observable.recurrence.support, 2);
    assert.equal(cf.observable.omission.interiorOnly, true);
    assert.equal(cf.observable.runs, null, "没有运行记录就如实报 null，不编一个 0 次");
    assert.equal(cf.ask.length, candidate.steps.length, "每一步都要有一个待答的问题");
    assert.deepEqual(cf.ask[0].choices, COUNTERFACTUAL_CHOICES.map((c) => c.id));
    assert.ok(cf.ask[0].choices.includes("unknown"), "必须留「答不上来」——逼人二选一会造出假答案");
    assert.equal(cf.ask[0].writeTo, "steps[].evidence[]");
  });
});

test("回答：非法选项直接拒，合法回答写进 evidence（准入判据的载体）", () => {
  const candidate = {
    id: "nudge-abc123",
    steps: [{ id: "S1", title: "技能：alpha", evidence: [] }, { id: "S2", title: "技能：beta", evidence: [] }]
  };
  const bad = applyAnswers(candidate, { S1: "looks-fine" });
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0], /不在选项里/);
  const ghost = applyAnswers(candidate, { S9: "would-fail" });
  assert.equal(ghost.ok, false);
  assert.match(ghost.problems[0], /不存在的步骤/);

  const { ok, candidate: answered, unanswered } = applyAnswers(candidate, {
    S1: { choice: "would-skip", note: "上次跳过它，收尾就漏了一步" },
    S2: "unknown"
  });
  assert.equal(ok, true);
  assert.equal(answered.status, "answered");
  assert.deepEqual(unanswered, []);
  assert.match(answered.steps[0].evidence[0], /^人答（\d{4}-\d{2}-\d{2}）：没有它，会漏掉这一步——上次跳过它/);
  // 原候选不许被就地改掉（回答是另一份东西）。
  assert.deepEqual(candidate.steps[0].evidence, []);
});

test("风险下限：机械清单命中就是 R2，写工具是 R1，其余 R0；R3 机器永远不给", () => {
  assert.deepEqual(riskFloorForStep({ tool: "pwsh", commands: ["git push origin main"] }), {
    risk: "R2",
    source: "blacklist",
    hits: ["git-push"]
  });
  const shell = riskFloorForStep({ tool: "pwsh", commands: ["Remove-Item -Recurse -Force build"] });
  assert.equal(shell.risk, "R2");
  assert.equal(shell.source, "blacklist");
  assert.deepEqual(riskFloorForStep({ tool: "write", commands: [] }), { risk: "R1", source: "write-tool", hits: [] });
  assert.deepEqual(riskFloorForStep({ tool: "read", commands: [] }), { risk: "R0", source: "default", hits: [] });
  // 多条命令里只要有一条命中，就是 R2（只看第一条会漏）。
  assert.equal(riskFloorForStep({ tool: "pwsh", commands: ["npm test", "git push"] }).risk, "R2");
  for (const probe of [{ tool: "pwsh", commands: [] }, { tool: "write" }, { tool: "task", commands: ["gh pr create -t x"] }]) {
    assert.notEqual(riskFloorForStep(probe).risk, "R3", "R3 的定义就是「得人来定」，机器给出来就是假的");
  }
});

test("安全取词：命令里的本机路径与用户名不许进草稿", () => {
  const homeName = basename(homedir());
  // 假路径**拼出来**而不是写成字面量：测试里也不该出现盘符路径的样子，连合成的都不留，
  // 免得 review 时还要人肉分辨哪条是真的。
  const fakeWin = ["C:", "Users", "fakeuser", "Desktop", "proj"].join("\\");
  const tokens = safeCommandTokens(`cd ${fakeWin} && node build.mjs --watch`);
  assert.ok(tokens.includes("cd"));
  assert.ok(tokens.includes("node"));
  assert.ok(!tokens.includes("fakeuser"), "路径段不许进标题");
  assert.ok(!tokens.some((t) => t.includes("\\") || t.includes(":")));
  // 家目录名本身就是本机用户名——即使它长得像普通单词也要挡住。
  assert.equal(safeCommandTokens(`node ${homedir()}/x.mjs`).includes(homeName), false);
  // 取不到词就返回空数组，宁可没词也不猜。
  assert.deepEqual(safeCommandTokens(["C:", "Users", "fakeuser"].join("\\")), []);
});

test("草稿：过 validatePipeline、status 是 draft、没人回答时 evidence 全空", () => {
  withDir((dir) => {
    const sessions = join(dir, "sessions");
    for (const id of ["sess-a", "sess-b"]) {
      writeSession(sessions, id, [
        [sessionLine({ turn: 1, calls: [skill("alpha"), { name: "mcp__github__list_issues", args: {} }, pwsh("npm test")] })]
      ]);
    }
    const read = readSessionObservations({ sessionDir: sessions });
    const segments = segmentObservations(read.observations);
    // kinds: null = 连内置工具一起挖。默认只挖能力级（技能/MCP），这一步要的是三步混合的样本。
    const [candidate] = mineRepeatedPatterns(segments, { kinds: null });
    const made = draftFromCandidate(candidate, { project: "slow-stack/mneme" });
    assert.equal(made.ok, true, made.problems.join("; "));
    assert.equal(made.pipeline.status, "draft");
    assert.equal(made.pipeline.project, "slow-stack/mneme");
    assert.equal(made.pipeline.steps.length, 3);
    assert.deepEqual(made.pipeline.steps.map((s) => s.id), ["S1", "S2", "S3"]);
    assert.deepEqual(made.pipeline.steps.map((s) => s.needs), [[], ["S1"], ["S2"]]);
    assert.deepEqual(made.unanswered, ["S1", "S2", "S3"], "没人回答之前，每一步都还没过准入判据");
    for (const step of made.pipeline.steps) {
      assert.deepEqual(step.evidence, [], "判据没答案时宁可空着，也不许编一条对照");
      assert.match(step.done, /待补/, "人话要留白，不能看起来像已经定稿");
      assert.match(step.why, /待补/);
    }
    // 人工回答过的那一步才带对照，其余照旧空着。
    const answered = applyAnswers(candidate, { S2: "would-fail" });
    const redraft = draftFromCandidate(answered.candidate, { project: "slow-stack/mneme" });
    assert.equal(redraft.ok, true);
    assert.deepEqual(redraft.unanswered, ["S1", "S3"]);
    assert.match(redraft.pipeline.steps[1].evidence[0], /会失败/);
    // 再走一遍校验器也不许变（归一化是幂等的）。
    assert.deepEqual(validatePipeline(redraft.pipeline).steps.length, 3);
  });
});

test("草稿写盘：只收 draft，不覆盖已有文件", () => {
  withDir((dir) => {
    const projectRoot = join(dir, "proj");
    mkdirSync(projectRoot, { recursive: true });
    const draft = {
      id: "nudge-deadbeef",
      name: "（待补）x",
      project: "p",
      version: 0,
      status: "draft",
      done: "（待补）整条怎么算完成",
      trigger: [{ kind: "phrase", value: "（待补）什么话该触发" }],
      steps: [
        {
          id: "S1",
          phase: "观察段",
          title: "技能：alpha",
          when: "（待补）这一段的入口",
          do: "调用技能 alpha",
          who: "main",
          tool: "skill",
          done: "（待补）这一步怎么算完成",
          risk: "R0",
          needs: [],
          why: "（待补）为什么必须有这一步",
          evidence: []
        }
      ]
    };
    const first = writeDraftPipeline({ projectRoot, pipeline: draft });
    assert.equal(first.ok, true);
    assert.equal(first.file, join(projectPipelineDir(projectRoot), "nudge-deadbeef.json"));
    // 写下去的东西必须能被读侧原样读回来——这是「产出的是工作流文件」而不是「产出的是 JSON」。
    const back = loadPipelines(projectPipelineDir(projectRoot), { scope: "project", label: "proj" });
    assert.equal(back.length, 1);
    assert.equal(back[0].id, "nudge-deadbeef");
    assert.equal(back[0].status, "draft");

    const again = writeDraftPipeline({ projectRoot, pipeline: draft });
    assert.equal(again.ok, false);
    assert.equal(again.reason, "exists", "已经在人手里的文件不能被机器改写");
    // 升格不在这条链上：沉淀链只产草稿。
    const active = writeDraftPipeline({ projectRoot, pipeline: { ...draft, id: "nudge-active", status: "active" } });
    assert.equal(active.ok, false);
    assert.equal(active.reason, "not-draft");
    const broken = writeDraftPipeline({ projectRoot, pipeline: { ...draft, id: "Bad_ID" } });
    assert.equal(broken.ok, false);
    assert.equal(broken.reason, "invalid");
  });
});

test("提议落 memoryDir：按项目分桶、坏文件不静默跳过", () => {
  withDir((dir) => {
    const memoryDir = join(dir, "memory");
    const projectRoot = join(dir, "proj");
    const bucket = proposalDir({ memoryDir, projectRoot });
    assert.ok(bucket.startsWith(memoryDir), "提议住 memoryDir，不进仓库");
    assert.ok(bucket.includes("proposals"));
    const proposal = {
      id: "nudge-abc123",
      origin: "nudge",
      status: "proposed",
      project: "proj",
      names: ["skill:alpha", "skill:beta"],
      steps: [{ id: "S1", title: "技能：alpha", evidence: [] }],
      support: 2,
      counterfactual: null
    };
    assert.deepEqual(validateProposal(proposal), { ok: true, problems: [] });
    saveProposal(bucket, proposal);
    assert.equal(existsSync(join(bucket, "nudge-abc123.json")), true);
    assert.equal(loadProposals(bucket).length, 1);

    // 缺了判据那一栏的候选不是候选。
    const noCf = { ...proposal, id: "nudge-abc124" };
    delete noCf.counterfactual;
    assert.equal(validateProposal(noCf).ok, false);
    assert.equal(validateProposal({ ...proposal, status: "collecting" }).ok, false);
    assert.deepEqual(PROPOSAL_STATUSES, ["proposed", "answered", "drafted", "dismissed"]);

    writeFileSync(join(bucket, "nudge-broken.json"), "{ not json");
    assert.throws(() => loadProposals(bucket), /JSON 解析失败/, "坏文件要炸出来，不做「跳过继续」");
    // 同一个项目算到同一个桶（分桶键不含绝对路径，也不含本机用户名）。
    assert.equal(proposalDir({ memoryDir, projectRoot }), bucket);
  });
});

test("清单行：反事实覆盖率与风险下限照实投影", () => {
  const proposal = {
    id: "nudge-abc123",
    status: "proposed",
    names: ["skill:a", "skill:b"],
    support: 3,
    firstSeenAt: "2026-10-01T00:00:00.000Z",
    lastSeenAt: "2026-10-15T00:00:00.000Z",
    steps: [
      { id: "S1", title: "a", risk: "R0", evidence: ["人答：会失败"] },
      { id: "S2", title: "b", risk: "R2", evidence: [] }
    ],
    counterfactual: { verdict: null }
  };
  const row = summarizeProposal(proposal);
  // 19/19 与 6/19 是两条不同的手法，清单上就该看得出来。
  assert.deepEqual(row.contrast, { answered: 1, total: 2 });
  assert.equal(row.riskFloor, "R2", "整条的风险取下限里的最高档");
  assert.equal(row.verdict, null, "判据没有结论时清单里也是 null，不显示一个假结论");
});

test("自精简提议走同一条「要人点头」的通路（必经步骤被跳 ≥3 次 → 修图+删步并存）", () => {
  const pipeline = {
    id: "demo",
    steps: [{ id: "S1", title: "第一步" }, { id: "S2", title: "第二步" }]
  };
  const runs = [
    { steps: [{ id: "S2", skipped: true }] },
    { steps: [{ id: "S2", skipped: true }] },
    { steps: [{ id: "S2", skipped: true }] },
    { steps: [{ id: "S1" }] }
  ];
  const proposal = retirementProposals(pipeline, { runs });
  // R2 新语义：S2 是必经（无 optional）、从未 uses、被跳 3 次 → 删步与修图两种读法并存
  assert.equal(proposal.items.length, 2);
  const kinds = proposal.items.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ["drop-step", "rework-path"]);
  const drop = proposal.items.find((x) => x.kind === "drop-step");
  assert.equal(drop.stepId, "S2");
  assert.match(drop.because, /被跳过 3 次/);
  for (const item of proposal.items) {
    assert.ok(item.question.length > 0, "提议不发问就只是通知，不叫要人点头");
    assert.ok(item.choices.includes("不知道"));
  }
  // 记了 4 次 run 但只有 1 次真走过 S1：计数只数处置，不数次数。
  assert.equal(retirementProposals(pipeline, { runs }).items.length, 2);
});

test("rework-path 按 cause 分流问法：skipped 问删步/改 optional，detoured 问重画路径", () => {
  // 锁的是 CodeRabbit #458 F3：同 kind 两种成因（pipeline.js 的 skipped/detoured
  // 两个触发点）若共用一句问法，跳过场景的人会被问「岔路」——答非所问。
  const pipeline = { id: "demo", steps: [{ id: "S1", title: "第一步" }, { id: "D1", title: "岔口" }] };
  // S1：必经、从未 uses、被跳 3 次 → rework-path(cause=skipped)
  // D1：被绕开 3 次 → rework-path(cause=detoured)
  const runs = [
    { steps: [{ id: "S1", skipped: true }, { id: "D1", detoured: true }] },
    { steps: [{ id: "S1", skipped: true }, { id: "D1", detoured: true }] },
    { steps: [{ id: "S1", skipped: true }, { id: "D1", detoured: true }] }
  ];
  const items = retirementProposals(pipeline, { runs }).items.filter((x) => x.kind === "rework-path");
  assert.equal(items.length, 2);
  const byCause = Object.fromEntries(items.map((x) => [x.cause, x]));
  assert.deepEqual(items.map((x) => x.cause).sort(), ["detoured", "skipped"], "cause 字段必须区分两种成因");
  assert.match(byCause.skipped.question, /optional|流程/);
  assert.ok(!/岔/.test(byCause.skipped.question), "跳过场景不该被问岔路的事");
  assert.match(byCause.detoured.question, /岔/);
  for (const item of items) {
    assert.ok(item.choices.includes("不知道"));
  }
});

test("端到端：真实形状的会话日志 → 至少一条候选 → 落一个过校验的 draft 文件", () => {
  withDir((dir) => {
    const sessions = join(dir, "sessions");
    const memoryDir = join(dir, "memory");
    const projectRoot = join(dir, "proj");
    mkdirSync(projectRoot, { recursive: true });
    // 两个会话走了同一段三步序列；第三个会话少了中间那一步（缺席对照的来源）。
    for (const id of ["sess-a", "sess-b"]) {
      writeSession(sessions, id, [
        [sessionLine({ turn: 1, calls: [skill("alpha"), skill("beta"), pwsh("npm test")] })]
      ]);
    }
    writeSession(sessions, "sess-c", [[sessionLine({ turn: 1, calls: [skill("alpha"), pwsh("npm test")] })]]);

    const doc = nudgeFromSessions({ sessionDir: sessions, projectRoot, memoryDir, project: "slow-stack/mneme", materialize: 1 });
    assert.equal(doc.contract, "mneme.nudge/v1");
    assert.equal(doc.source.present, true);
    assert.equal(doc.source.scannedFiles, 3);
    assert.ok(doc.counts.candidates >= 1, "真实形状的数据里必须挖得出候选");
    assert.equal(doc.counts.draftsWritten, 1);
    assert.equal(doc.drafts[0].ok, true);
    assert.deepEqual(doc.kinds, ["skill", "mcp"], "挖的是哪一层要跟着结果一起报出来");
    assert.equal(doc.boundaries.autoActivate, false);
    assert.equal(doc.boundaries.autoAnswerCounterfactual, false);

    // 草稿真的在项目里、真的能被读侧读回来、真的是 draft。
    const dir2 = projectPipelineDir(projectRoot);
    const files = readFileSync(join(dir2, `${doc.drafts[0].id}.json`), "utf8");
    const parsed = JSON.parse(files);
    assert.equal(parsed.status, "draft");
    const back = loadPipelines(dir2, { scope: "project", label: "proj" });
    assert.equal(back.length, 1);
    assert.equal(back[0].status, "draft");
    assert.ok(back[0].steps.length >= 2);
    for (const step of back[0].steps) assert.deepEqual(step.evidence, []);

    // 提议落进了 memoryDir 的项目桶，且带着「没人回答判据」的原话。
    const proposals = loadProposals(doc.proposalsDir);
    assert.equal(proposals.length, doc.counts.candidates);
    const first = proposals.find((p) => p.id === doc.drafts[0].id);
    assert.equal(first.counterfactual.verdict, null);
    assert.ok(first.counterfactual.unobservable.length >= 1);

    // 草稿文件里不许出现本机路径与用户名（它是要提交、要 review 的）。
    assert.ok(!/[A-Za-z]:[\\/]/.test(files), "仓库文件里不许出现盘符路径");
    const homeName = basename(homedir());
    assert.equal(files.includes(homeName), false, "仓库文件里不许出现本机用户名");
    // 临时目录的绝对路径同样不许进文件——命令原文里的路径会被 safeCommandTokens 洗掉。
    assert.equal(files.includes(dir), false);
  });
});

test("端到端：会话目录空时如实报空，不伪造候选、也不落草稿", () => {
  withDir((dir) => {
    const sessions = join(dir, "sessions");
    mkdirSync(sessions, { recursive: true });
    const projectRoot = join(dir, "proj");
    mkdirSync(projectRoot, { recursive: true });
    const doc = nudgeFromSessions({ sessionDir: sessions, projectRoot, memoryDir: join(dir, "memory"), materialize: true });
    assert.equal(doc.counts.candidates, 0);
    assert.equal(doc.counts.draftsWritten, 0);
    assert.deepEqual(doc.drafts, []);
    assert.equal(existsSync(projectPipelineDir(projectRoot)), false, "没有候选就不该建出 pipelines 目录");
  });
});

test("会话根目录跟着 DSH_HOME 走，不写死本机路径", () => {
  const fake = join(tmpdir(), "mneme-dsh-home");
  assert.equal(resolveSessionDir({ dshHome: fake }), join(fake, "sessions"));
  // 显式传 dshHome 优先于环境变量；两者都没有时落在 ~/.dsh 下（不出现盘符字面量）。
  const fakeHome = ["D:", "somewhere", ".dsh"].join("/");
  assert.equal(resolveSessionDir({ dshHome: fakeHome }), join(fakeHome, "sessions"));
});

test("forEachZstdFrame：坏帧计入 failed 而不静默吞掉", () => {
  const good = zlib.zstdCompressSync(Buffer.from("hello"));
  const bad = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from("nonsense")]);
  const seen = [];
  const stat = forEachZstdFrame(Buffer.concat([good, bad]), (text) => seen.push(text));
  assert.deepEqual(seen, ["hello"]);
  assert.equal(stat.frames, 1);
  assert.equal(stat.failed, 1, "解不出来的帧要被计数，不能当成「本来就没有内容」");
});

test("写盘留下的目录结构不改动已有工作流（不碰发布工作流那条）", () => {
  withDir((dir) => {
    const projectRoot = join(dir, "proj");
    const dir2 = projectPipelineDir(projectRoot);
    mkdirSync(dir2, { recursive: true });
    const human = { id: "handwritten", note: "人写的" };
    writeFileSync(join(dir2, "handwritten.json"), JSON.stringify(human));
    const before = statSync(join(dir2, "handwritten.json")).mtimeMs;
    const made = writeDraftPipeline({
      projectRoot,
      pipeline: {
        id: "nudge-keep",
        name: "x",
        project: "p",
        version: 0,
        status: "draft",
        done: "d",
        trigger: [{ kind: "phrase", value: "t" }],
        steps: [
          {
            id: "S1",
            phase: "观察段",
            title: "t",
            when: "w",
            do: "do",
            who: "main",
            tool: "read",
            done: "d",
            risk: "R0",
            needs: [],
            why: "y",
            evidence: []
          }
        ]
      }
    });
    assert.equal(made.ok, true);
    assert.equal(statSync(join(dir2, "handwritten.json")).mtimeMs, before, "人写的文件不动");
    assert.deepEqual(readFileSync(join(dir2, "handwritten.json"), "utf8"), JSON.stringify(human));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 专家团复核（2026-10-16）抓出的阻断项，每条一个失败即红的回归用例。
// 这些用例的写法是「先按旧行为写会红」：比如空回答那条，旧实现返回 ok:true +
// status:"answered"，这里的断言立刻炸。
// ─────────────────────────────────────────────────────────────────────────────

test("回归·空回答不算「已答」：一条都没接受就不许推进状态", () => {
  const candidate = { id: "nudge-abc123", steps: [{ id: "S1", title: "技能：alpha", evidence: [] }] };
  // 旧实现：{} 与 null 都返回 ok:true / status:"answered" / applied:0 —— 无人回答却已答。
  for (const answers of [{}, null, undefined]) {
    const r = applyAnswers(candidate, answers);
    assert.equal(r.ok, false, `answers=${JSON.stringify(answers)} 必须失败`);
    assert.equal(r.candidate, null, "不许交出一份「已答」的候选");
    assert.equal(r.applied.length, 0);
    assert.match(r.problems[0], /空回答不算/);
  }
  // 非法选项同样是失败（原有行为，别在修这条时弄丢）。
  assert.equal(applyAnswers(candidate, { S1: "nope" }).ok, false);
  // 真答了一条才推进。
  const ok = applyAnswers(candidate, { S1: "would-fail" });
  assert.equal(ok.ok, true);
  assert.equal(ok.candidate.status, "answered");
  assert.equal(ok.applied.length, 1);
});

test("回归·跨工作区不并账：两个桶各一次不是「支持度 2 的同一手法」", () => {
  withDir((dir) => {
    const sessions = join(dir, "sessions");
    const seq = [[sessionLine({ turn: 1, calls: [skill("alpha"), skill("beta")] })]];
    writeSession(join(sessions, "ws-a"), "sess-1", seq);
    writeSession(join(sessions, "ws-b"), "sess-2", seq);
    const cross = readSessionObservations({ sessionDir: sessions });
    const crossSegments = segmentObservations(cross.observations);
    assert.equal(crossSegments.length, 2);
    assert.deepEqual(
      mineRepeatedPatterns(crossSegments),
      [],
      "旧实现把两个项目的各一次并成支持度 2 —— 那是把两本账合成一本"
    );

    // 同一个桶里两个会话才够格，且候选带着自己的桶。
    writeSession(join(sessions, "ws-a"), "sess-3", seq);
    const read = readSessionObservations({ sessionDir: sessions });
    const candidates = mineRepeatedPatterns(segmentObservations(read.observations));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].support, 2);
    assert.equal(candidates[0].bucket, "ws-a");
  });
});

test("回归·扫全部会话时不许声称候选属于某个项目（拒绝归属，不写项目桶、不落草稿）", () => {
  withDir((dir) => {
    const sessions = join(dir, "sessions");
    const seq = [[sessionLine({ turn: 1, calls: [skill("alpha"), skill("beta")] })]];
    for (const id of ["sess-a", "sess-b"]) writeSession(sessions, id, seq);
    const memoryDir = join(dir, "memory");
    const projectRoot = join(dir, "proj");
    mkdirSync(projectRoot, { recursive: true });

    // 给 projectRoot、不给 sessionDir（=扫全部）→ 旧实现照旧贴项目名并写项目桶。
    const loose = nudgeFromSessions({ dshHome: dir, projectRoot, memoryDir, materialize: true });
    assert.ok(loose.counts.candidates >= 1, "普查本身照跑，候选还是要挖出来");
    assert.equal(loose.refused.reason, "unscoped-sessions", "必须显式报出降级原因");
    assert.equal(loose.project, null);
    assert.equal(loose.proposalsDir, null, "不写任何项目的提议桶");
    assert.equal(loose.counts.savedProposals, 0);
    assert.equal(loose.counts.draftsWritten, 0, "更不许往项目里落草稿");
    assert.equal(existsSync(memoryDir), false, "memoryDir 下连目录都不该建出来");
    assert.equal(existsSync(join(projectRoot, ".mneme")), false);

    // 给了该项目自己的 sessionDir 才认归属。
    const scoped = nudgeFromSessions({ sessionDir: sessions, projectRoot, memoryDir, project: "slow-stack/mneme", materialize: 1 });
    assert.equal(scoped.refused, null);
    assert.equal(scoped.project, "slow-stack/mneme");
    assert.ok(scoped.proposalsDir.includes("proposals"));
    assert.equal(scoped.counts.savedProposals, scoped.counts.candidates);
    assert.equal(scoped.counts.draftsWritten, 1);
  });
});

test("回归·unanswered 补回出口，且与写盘文件里 evidence 为空的步骤一致", () => {
  withDir((dir) => {
    const sessions = join(dir, "sessions");
    const memoryDir = join(dir, "memory");
    const projectRoot = join(dir, "proj");
    mkdirSync(projectRoot, { recursive: true });
    const seq = [[sessionLine({ turn: 1, calls: [skill("alpha"), skill("beta")] })]];
    for (const id of ["sess-a", "sess-b"]) writeSession(sessions, id, seq);

    const doc = nudgeFromSessions({ sessionDir: sessions, projectRoot, memoryDir, project: "slow-stack/mneme", materialize: 1 });
    assert.equal(doc.drafts.length, 1);
    const draft = doc.drafts[0];
    assert.equal(draft.ok, true);
    assert.ok(Array.isArray(draft.unanswered), "旧实现把 draftFromCandidate 算出的 unanswered 丢在出口");
    const saved = JSON.parse(readFileSync(draft.file, "utf8"));
    assert.deepEqual(
      draft.unanswered,
      saved.steps.filter((s) => s.evidence.length === 0).map((s) => s.id),
      "出口的 unanswered 必须就是写盘文件里还没人回答的那几步"
    );
    assert.equal(draft.unanswered.length, saved.steps.length, "没人回答时每一步都还没过准入判据");
    // 失败分支也要带这个键（否则调用方要按分支判字段在不在）。
    const broken = draftFromCandidate({ id: "nudge-x", steps: [] }, {});
    assert.equal(broken.ok, false);
    assert.ok(Array.isArray(broken.unanswered));
  });
});

test("回归·原子写：rename 之前崩掉不留半个目标文件，正常路径不留临时文件", () => {
  withDir((dir) => {
    const file = join(dir, "x.json");
    writeFileSync(file, "旧内容");
    // 只断言「出现过 tmp 字样」证明不了这条修复；这里把「rename 之前崩掉」真模拟一次。
    assert.throws(() => writeFileAtomic(file, "新内容", { beforeRename: () => { throw new Error("模拟崩溃"); } }), /模拟崩溃/);
    assert.equal(readFileSync(file, "utf8"), "旧内容", "目标文件一个字节都不许动");
    assert.deepEqual(readdirSync(dir), ["x.json"], "临时文件要收掉");
    writeFileAtomic(file, "新内容");
    assert.equal(readFileSync(file, "utf8"), "新内容");
    assert.deepEqual(readdirSync(dir), ["x.json"]);
  });
});

test("回归·落盘产物里没有半截文件：读侧整目录校验不能因为临时文件挂掉", () => {
  withDir((dir) => {
    const projectRoot = join(dir, "proj");
    const memoryDir = join(dir, "memory");
    const pipelineDir = projectPipelineDir(projectRoot);
    mkdirSync(pipelineDir, { recursive: true });
    // 先放一条人手写的合法工作流：它必须一直是可读的（读侧任一条坏就整层抛，
    // 所以一个半截的机器文件能把人写的那条一起带没）。
    const human = {
      id: "handwritten",
      name: "人写的",
      project: "p",
      version: 0,
      status: "active",
      done: "d",
      trigger: [{ kind: "phrase", value: "t" }],
      steps: [
        { id: "A1", phase: "p", title: "t", when: "w", do: "d", who: "main", tool: "", done: "d", risk: "R0", needs: [], why: "y", evidence: [] }
      ]
    };
    writeFileSync(join(pipelineDir, "handwritten.json"), `${JSON.stringify(human)}\n`);

    const draft = {
      id: "nudge-atomic",
      name: "（待补）x",
      project: "p",
      version: 0,
      status: "draft",
      done: "d",
      trigger: [{ kind: "phrase", value: "t" }],
      steps: [
        { id: "S1", phase: "观察段", title: "t", when: "w", do: "d", who: "main", tool: "", done: "d", risk: "R0", needs: [], why: "y", evidence: [] }
      ]
    };
    const made = writeDraftPipeline({ projectRoot, pipeline: draft });
    assert.equal(made.ok, true);
    assert.deepEqual(readdirSync(pipelineDir).filter((f) => f.includes(".tmp-")), [], "temporaries 必须清零");
    assert.equal(loadPipelines(pipelineDir, { scope: "project", label: "p" }).length, 2, "两条都读得出来");

    // 提议那边同一套。
    const proposal = {
      id: "nudge-atomic",
      origin: "nudge",
      status: "proposed",
      names: ["skill:a", "skill:b"],
      steps: [{ id: "S1", title: "a", evidence: [] }],
      support: 2,
      counterfactual: null
    };
    const bucket = proposalDir({ memoryDir, projectRoot });
    saveProposal(bucket, proposal);
    assert.deepEqual(readdirSync(bucket).filter((f) => f.includes(".tmp-")), []);
    assert.equal(loadProposals(bucket).length, 1);
  });
});

test("回归·边界：校验层拒绝任何非 null 的 verdict（不只靠产者自觉）", () => {
  const base = {
    id: "nudge-abc123",
    origin: "nudge",
    status: "proposed",
    names: ["skill:a", "skill:b"],
    steps: [{ id: "S1", title: "a", evidence: [] }],
    support: 2
  };
  const bad = { ...base, counterfactual: { verdict: "会漏步" } };
  assert.equal(validateProposal(bad).ok, false);
  assert.match(validateProposal(bad).problems[0], /verdict 必须是 null/);
  // 缺 verdict 键 = undefined，也拒（否则「没写」会被读成「还没算」）。
  assert.equal(validateProposal({ ...base, counterfactual: {} }).ok, false);
  assert.equal(validateProposal({ ...base, counterfactual: { verdict: null } }).ok, true);
  assert.equal(validateProposal({ ...base, counterfactual: null }).ok, true);
  // 写盘时同样过不去：产者那条路绕不开这道边界。
  withDir((dir) => {
    assert.throws(() => saveProposal(join(dir, "p"), bad), /verdict 必须是 null/);
  });
  // 而 summarizeProposal 照旧原样投影 —— 正因为它会投影，才必须在校验层拦。
  assert.equal(summarizeProposal({ ...base, counterfactual: { verdict: null } }).verdict, null);
});

test("回归·按层过滤后的相邻不许当真相邻：夹着的调用要留痕", () => {
  const raw = [
    {
      sessionId: "s1",
      bucket: "ws-a",
      turn: 1,
      steps: [
        { key: "tool:read", kind: "tool", name: "read", tool: "read", command: "", repeats: 4 },
        { key: "skill:alpha", kind: "skill", name: "alpha", tool: "skill", command: "", repeats: 1 },
        { key: "tool:read", kind: "tool", name: "read", tool: "read", command: "", repeats: 3 },
        { key: "tool:grep", kind: "tool", name: "grep", tool: "grep", command: "", repeats: 1 },
        { key: "skill:beta", kind: "skill", name: "beta", tool: "skill", command: "", repeats: 1 }
      ]
    }
  ];
  const scoped = filterSegmentsByKinds(raw, ["skill", "mcp"]);
  assert.deepEqual(scoped[0].steps.map((s) => s.name), ["alpha", "beta"]);
  assert.deepEqual(scoped[0].steps[0].elided, { count: 4, tools: ["tool:read"], head: true }, "开头夹着的要记，且标明在它之前");
  assert.deepEqual(scoped[0].steps[1].elided, { count: 4, tools: ["tool:read", "tool:grep"], head: false });

  const [candidate] = mineRepeatedPatterns(raw, { minSupport: 1, kinds: ["skill", "mcp"] });
  const steps = candidate.steps;
  assert.match(steps[0].when, /它之前还有 4 次其他调用/, "开头不是「这一段的入口」");
  assert.match(steps[1].when, /中间还有 4 次其他调用/);
  assert.match(steps[1].when, /相邻关系是过滤后的/);
  assert.ok(!/紧跟在/.test(steps[1].when), "原始观察里中间隔着 4 次调用，不许断言「紧跟在」");

  // 真的相邻时措辞不变（否则这条修复就成了「一律不敢说」）。
  const tight = [
    {
      sessionId: "s2",
      bucket: "ws-a",
      turn: 1,
      steps: [
        { key: "skill:alpha", kind: "skill", name: "alpha", tool: "skill", command: "", repeats: 1 },
        { key: "skill:beta", kind: "skill", name: "beta", tool: "skill", command: "", repeats: 1 }
      ]
    }
  ];
  const [tightCandidate] = mineRepeatedPatterns(tight, { minSupport: 1, kinds: ["skill", "mcp"] });
  assert.match(tightCandidate.steps[1].when, /紧跟在/);
  assert.equal(tightCandidate.steps[1].elided, null);
});

test("回归·failures：未接线与「确实一条都没有」必须分开报", () => {
  const candidate = {
    id: "nudge-abc123",
    bucket: null,
    names: ["skill:a", "skill:b"],
    steps: [{ id: "S1", title: "a", evidence: [] }],
    support: 2,
    occurrences: 2,
    sessions: ["s1", "s2"],
    turns: 2
  };
  const unwired = buildCounterfactual(candidate, { segments: [] });
  assert.notEqual(unwired.observable.failures, null, "旧实现用 null 同时表示「没接线」和「没有记录」");
  assert.equal(unwired.observable.failures.available, false);
  assert.equal(unwired.observable.failures.reason, "not-wired");
  const empty = buildCounterfactual(candidate, { segments: [], failures: [] });
  assert.deepEqual(empty.observable.failures, { available: true, count: 0, kinds: [] });
  const rows = buildCounterfactual(candidate, {
    segments: [],
    failures: [{ failure_type: "correction" }, { failure_type: "correction" }, { failure_type: "recall" }]
  });
  assert.deepEqual(rows.observable.failures, { available: true, count: 3, kinds: ["correction", "recall"] });

  withDir((dir) => {
    const sessions = join(dir, "sessions");
    mkdirSync(sessions, { recursive: true });
    const loose = nudgeFromSessions({ sessionDir: sessions, memoryDir: null, projectRoot: null });
    assert.equal(loose.source.failureSource, "unwired");
    const wired = nudgeFromSessions({ sessionDir: sessions, memoryDir: null, projectRoot: null, failures: [] });
    assert.equal(wired.source.failureSource, "caller");
  });
});

test("回归·长度为 2 的候选：对照栏显式留白，不静默变空", () => {
  withDir((dir) => {
    const sessions = join(dir, "sessions");
    const seq = [[sessionLine({ turn: 1, calls: [skill("alpha"), skill("beta")] })]];
    for (const id of ["sess-a", "sess-b"]) writeSession(sessions, id, seq);
    const read = readSessionObservations({ sessionDir: sessions });
    const segments = segmentObservations(read.observations);
    const [candidate] = mineRepeatedPatterns(segments);
    assert.equal(candidate.names.length, 2);
    const contrast = omissionContrast(candidate, segments);
    assert.deepEqual(contrast.steps, []);
    assert.equal(contrast.empty, true, "「空」要说出来，否则看的人会把它读成「反例为零」");
    assert.match(contrast.note, /留白/);
    // 有中间步骤的候选不该带这条留白说明。长度 3 的候选要在**两个**会话里出现，
    // 否则它要么被支持度门槛筛掉，要么（只出现一次时）被极大模式并进那条两步的。
    const three = [[sessionLine({ turn: 1, calls: [skill("alpha"), skill("beta"), skill("gamma")] })]];
    writeSession(sessions, "sess-c", three);
    writeSession(sessions, "sess-d", three);
    const read2 = readSessionObservations({ sessionDir: sessions });
    const segs2 = segmentObservations(read2.observations);
    const longOne = mineRepeatedPatterns(segs2).find((c) => c.names.length === 3);
    assert.ok(longOne, "三步序列在两个会话里出现过，必须挖得出来");
    const contrast2 = omissionContrast(longOne, segs2);
    assert.equal(contrast2.empty, false);
    assert.equal(contrast2.note, "");
    assert.equal(contrast2.steps.length, 1, "只有中间那一步有缺席对照");
  });
});

test("回归·文件上限按排序截断，不按遍历顺序（选择偏差要能被看见）", () => {
  withDir((dir) => {
    const sessions = join(dir, "sessions");
    // 故意让「造出来的顺序」与「字典序」相反。
    writeSession(join(sessions, "z-ws"), "sess-1", [[sessionLine({ turn: 1, calls: [skill("alpha")] })]]);
    writeSession(join(sessions, "a-ws"), "sess-2", [[sessionLine({ turn: 1, calls: [skill("beta")] })]]);
    writeSession(join(sessions, "m-ws"), "sess-3", [[sessionLine({ turn: 1, calls: [skill("gamma")] })]]);
    const found = findSessionFiles(sessions, { limit: 2 });
    assert.equal(found.totalFiles, 3, "真总数要能看见");
    assert.equal(found.files.length, 2);
    assert.equal(found.truncated, true);
    assert.ok(
      found.files.every((f) => f.includes("a-ws") || f.includes("m-ws")),
      "留下的是字典序靠前的两个，而不是遍历时先撞上的那两个"
    );
    // 读数层要把总数与截断一起透出去。
    const read = readSessionObservations({ sessionDir: sessions, limit: 2 });
    assert.equal(read.totalFiles, 3);
    assert.equal(read.truncated, true);
    assert.equal(read.scannedFiles, 2);
  });
});
