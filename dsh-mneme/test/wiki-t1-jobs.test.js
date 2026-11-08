// T1 面板后台任务状态机的回归锁（契约 §3.2）。
//
// **绝不真起进程**：T1 一次要花模型额度，测试里注入假 spawn 就够——这一层要证明的
// 是「记账与状态迁移对不对」，不是「模型跑得通不通」（那是 CLI 的 e2e 地盘）。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createT1Jobs } from "../src/wiki/t1-jobs.js";

// 假子进程：stdout/stderr 是 EventEmitter，close/error 也走事件——形状贴着真
// ChildProcess，但一个字节都不会真跑出去。
function fakeSpawn() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.killed = false;
    child.kill = () => { child.killed = true; };
    child.cmd = cmd;
    child.args = args;
    child.opts = opts;
    calls.push(child);
    return child;
  };
  return { spawn, calls };
}

function makeJobs(overrides = {}) {
  const fake = fakeSpawn();
  const jobs = createT1Jobs({
    spawn: fake.spawn,
    nodePath: "node",
    scriptPath: "/pkg/bin/dsh-mneme-choro.mjs",
    dbPath: "/mem/memory.db",
    now: (() => { let i = 0; return () => `T${++i}`; })(),
    ...overrides
  });
  return { jobs, calls: fake.calls };
}

const repo = { id: 1, name: "r", root_path: "/repo" };

test("start：起的是 CLI 的 --t1 --apply --json（面板必须带 apply，否则 CLI 只列候选不写）", () => {
  const { jobs, calls } = makeJobs();
  const r = jobs.start({ repo, module: "src", retryFailed: true });
  assert.equal(r.started, true);
  assert.ok(r.jobId);
  assert.equal(calls.length, 1);
  const [cmd, args, opts] = [calls[0].cmd, calls[0].args, calls[0].opts];
  assert.equal(cmd, "node");
  assert.deepEqual(args.slice(0, 5), ["/pkg/bin/dsh-mneme-choro.mjs", "/repo", "--t1", "--apply", "--json"]);
  assert.ok(args.includes("--module") && args.includes("src"));
  assert.ok(args.includes("--retry-failed"));
  assert.ok(args.includes("--db") && args.includes("/mem/memory.db"));
  // Electron 宿主里不设这个变量会去开窗口而不是跑脚本——这条是踩过的坑。
  assert.equal(opts.env.ELECTRON_RUN_AS_NODE, "1");
  assert.deepEqual(opts.stdio, ["ignore", "pipe", "pipe"]);
  jobs.dispose();
});

test("同一仓库并发 → job-running 且带回在跑的 jobId（面板据此继续轮询而不是重起）", () => {
  const { jobs } = makeJobs();
  const first = jobs.start({ repo });
  const second = jobs.start({ repo });
  assert.equal(second.started, false);
  assert.equal(second.code, "job-running");
  assert.equal(second.jobId, first.jobId);

  // 不同仓库互不影响：并发闸是按仓库的，不是全局的。
  const other = jobs.start({ repo: { id: 2, name: "o", root_path: "/repo2" } });
  assert.equal(other.started, true);
  jobs.dispose();
});

test("stdout 逐行进 logTail（封顶 200 行），chunk 切在一行中间也不丢字", async () => {
  const { jobs, calls } = makeJobs();
  const { jobId } = jobs.start({ repo });
  const child = calls[0];
  // 故意把一行拆成两个 chunk：不做余量拼接的实现会把它切成两条假日志。
  child.stdout.emit("data", "第一行\n第二");
  child.stdout.emit("data", "行\n");
  let view = jobs.status(jobId);
  assert.deepEqual(view.logTail, ["第一行", "第二行"]);

  for (let i = 0; i < 300; i += 1) child.stdout.emit("data", `l${i}\n`);
  view = jobs.status(jobId);
  assert.equal(view.logTail.length, 200, "ring buffer 封顶：长任务 stdout 不封顶就是内存泄漏");
  assert.equal(view.logTail[199], "l299", "留下的是最新的尾巴（面板要看的是当前在干嘛）");
  jobs.dispose();
});

test("退出码 0 → done 且从回执读出进度；非 0 → failed 且带 stderr 尾巴", () => {
  const { jobs, calls } = makeJobs();
  const ok = jobs.start({ repo });
  // CLI --json 输出的是多行 JSON（不是 NDJSON）：按行收日志、按全文解析回执，两条路
  // 各走各的，才不会互相牺牲。
  calls[0].stdout.emit("data", JSON.stringify({ dryRun: false, enriched: [{ slug: "a" }], failed: [{ slug: "b" }] }, null, 2));
  calls[0].emit("close", 0);
  const done = jobs.status(ok.jobId);
  assert.equal(done.state, "done");
  assert.deepEqual(done.modules, { total: 2, done: 1, failed: 1 });
  assert.ok(done.finishedAt);

  const bad = jobs.start({ repo: { id: 2, name: "o", root_path: "/repo2" } });
  calls[1].stderr.emit("data", "拒绝运行（not-registered）：仓库没登记\n");
  calls[1].emit("close", 1);
  const failed = jobs.status(bad.jobId);
  assert.equal(failed.state, "failed");
  // 只报 exit code 等于让面板说「失败了，不知道为啥」——stderr 尾巴才是人话。
  assert.match(failed.error, /not-registered/);
  jobs.dispose();
});

test("未知 jobId → null；dispose 杀掉在跑的进程并清账", () => {
  const { jobs, calls } = makeJobs();
  assert.equal(jobs.status("nope"), null);
  const { jobId } = jobs.start({ repo });
  assert.equal(jobs.status(jobId).state, "running");
  jobs.dispose();
  assert.equal(calls[0].killed, true, "宿主卸载时要带走子进程，不留孤儿");
  assert.equal(jobs.status(jobId), null);
});
