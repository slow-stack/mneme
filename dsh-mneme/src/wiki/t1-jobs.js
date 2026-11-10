// dsh-mneme/src/wiki/t1-jobs.js
// T1 面板后台任务的进程账与状态机（契约 §3.2）。
//
// 为什么住在这里而不是 api.js：T1 要 spawn 子进程，而 api.js 刻意只依赖少数 node
// 内置（不 import child_process）——HTTP 面只做参数解析与闸门分叉，进程生命周期与
// 状态账归 wiki 层。副作用是单测可以在 API 侧注入假 job 对象，永不真跑一次 T1
// （真跑要花模型额度，测试里花钱是不可接受的）。
//
// 为什么 spawn CLI 而不是宿主进程内直接 createT1()：单模块 30–240s，挂在宿主事件
// 循环上会拖住整个插件；而 bin/dsh-mneme-choro.mjs --t1 已经是那条唯一收费入口，
// 面板再走一遍编排逻辑等于造第二条路径，两边迟早不一致（收据形状、降级语义都会漂）。
//
// stdout 契约（防一类回归）：CLI 的 --json 用 JSON.stringify(receipt, null, 2) 输出
// ——**多行 JSON，不是 NDJSON**。所以 ring buffer 按行收（面板要的是人能看的日志尾巴），
// 回执解析另留一份可截断的全文，别指望从 200 行里拼出完整 JSON。
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// lib/wiki/t1-jobs.js 与 src/wiki/t1-jobs.js 到 bin/ 都是上两级：sync 只换目录名，
// 深度不变，所以这里可以硬编码相对位置。
const DEFAULT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "dsh-mneme-choro.mjs");

// 日志尾巴的上限取 200 行：面板是个窄弹层，再多也没人往下翻；而上限存在的真理由
// 是长任务会往 stdout 泼几万行，不封顶就是内存泄漏。
const DEFAULT_RING = 200;
// 已完成任务保留条数：status 要能被反复轮询（面板 2s 一次），但也不能无限留。
const DEFAULT_FINISHED = 20;

/** 逐行切分：chunk 边界可能落在一行中间，所以每路各留一个未完成余量。 */
function makeLineSplitter(onLine) {
  let rest = "";
  return {
    push(chunk) {
      rest += chunk;
      const parts = rest.split(/\r?\n/);
      rest = parts.pop() ?? "";
      for (const line of parts) onLine(line);
    },
    flush() {
      if (rest !== "") { onLine(rest); rest = ""; }
    }
  };
}

/**
 * @param {object} opts
 * @param {object} opts.store createStore 产物（只需要它来定位 bin 之外的路径时用；目前不读库）
 * @param {Function} [opts.spawn] 注入的 spawn（测试注假实现，绝不真起进程）
 * @param {string} [opts.nodePath] 跑脚本的解释器，缺省 process.execPath
 * @param {string} [opts.scriptPath] CLI 路径，缺省按 lib/src 同深度推导
 * @param {string|null} [opts.dbPath] 透传 --db；不传则 CLI 用自己的缺省记忆库
 * @param {() => string} [opts.now]
 * @param {number} [opts.ringLimit]
 * @param {number} [opts.maxFinished]
 */
export function createT1Jobs({
  store = null,
  spawn: spawnFn = nodeSpawn,
  nodePath = process.execPath,
  scriptPath = DEFAULT_SCRIPT,
  dbPath = null,
  now = () => new Date().toISOString(),
  ringLimit = DEFAULT_RING,
  maxFinished = DEFAULT_FINISHED,
  env = process.env
} = {}) {
  const jobs = new Map();
  // 同一个仓库同时只许一个 T1：两个进程同时往同一批页面写，claims 与 status 会
  // 交错成没人能解释的中间态（T1 的写路径没有跨进程锁，这是硬事实不是保守）。
  const runningByRepo = new Map();

  function pushLine(job, line) {
    job.logTail.push(line);
    if (job.logTail.length > ringLimit) job.logTail.splice(0, job.logTail.length - ringLimit);
  }

  /** 回执解析：只认 JSON.parsable 的完整 stdout；解析不出来就保持 0/0/0 不瞎猜。 */
  function readCounts(job) {
    const text = job.stdoutAll.trim();
    if (text === "") return null;
    let receipt;
    try { receipt = JSON.parse(text); } catch { return null; }
    if (!receipt || typeof receipt !== "object") return null;
    if (Array.isArray(receipt.enriched) || Array.isArray(receipt.failed)) {
      const done = Array.isArray(receipt.enriched) ? receipt.enriched.length : 0;
      const failed = Array.isArray(receipt.failed) ? receipt.failed.length : 0;
      return { total: done + failed, done, failed };
    }
    if (Array.isArray(receipt.candidates)) {
      return { total: receipt.candidates.length, done: 0, failed: 0 };
    }
    return null;
  }

  function trimFinished() {
    const finished = [...jobs.values()].filter((j) => j.state !== "running");
    if (finished.length <= maxFinished) return;
    finished.sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
    for (const job of finished.slice(0, finished.length - maxFinished)) jobs.delete(job.jobId);
  }

  function finish(job, state, error) {
    if (job.state !== "running") return; // close 与 error 可能都到，只认第一次结算
    job.state = state;
    job.finishedAt = now();
    if (error) job.error = error;
    const counts = readCounts(job);
    if (counts) job.modules = counts;
    const key = String(job.repoKey);
    if (runningByRepo.get(key) === job.jobId) runningByRepo.delete(key);
    trimFinished();
  }

  /**
   * 起一个后台 T1。返回 {started:true, jobId} 或 {started:false, code, jobId?}——
   * 路由据此分叉 200 / 409，本层不碰 HTTP。
   */
  function start({ repo = null, module = null, retryFailed = false } = {}) {
    const rootPath = typeof repo?.root_path === "string" ? repo.root_path : "";
    if (rootPath === "") return { started: false, code: "repo-invalid" };
    const repoKey = String(repo.id ?? rootPath);
    const existing = runningByRepo.get(repoKey);
    if (existing) {
      const job = jobs.get(existing);
      // runningByRepo 里还留着但 job 已经结算（理论不可达）时不该把它当占用，
      // 否则这个仓库会被一条幽灵记录永久锁死。
      if (job && job.state === "running") return { started: false, code: "job-running", jobId: existing };
      runningByRepo.delete(repoKey);
    }

    const jobId = randomUUID();
    const job = {
      jobId,
      repoKey,
      repo: { id: repo.id ?? null, name: repo.name ?? null, rootPath },
      state: "running",
      startedAt: now(),
      finishedAt: null,
      modules: { total: 0, done: 0, failed: 0 },
      logTail: [],
      error: null,
      stdoutAll: "",
      stderrTail: []
    };
    jobs.set(jobId, job);
    runningByRepo.set(repoKey, jobId);

    const args = [scriptPath, rootPath, "--t1", "--apply", "--json"];
    if (module) args.push("--module", String(module));
    if (retryFailed === true) args.push("--retry-failed");
    if (dbPath) args.push("--db", String(dbPath));

    let child;
    try {
      child = spawnFn(nodePath, args, {
        // Electron 宿主里 process.execPath 是 electron 本体；不设这个变量它会去开
        // 窗口而不是跑 Node 脚本（t1.js 的真实 runner 用的是同一招）。
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (err) {
      finish(job, "failed", String((err && err.message) || err));
      return { started: true, jobId };
    }
    job.child = child;

    const outLines = makeLineSplitter((line) => pushLine(job, line));
    const errLines = makeLineSplitter((line) => {
      job.stderrTail.push(line);
      if (job.stderrTail.length > 20) job.stderrTail.shift();
    });
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on?.("data", (chunk) => {
      // 回执解析要完整 JSON，而 ring buffer 只留尾巴——所以另攒一份，封顶 256 KiB
      // 防止一个跑飞的任务把宿主内存吃光。
      if (job.stdoutAll.length < 256 * 1024) job.stdoutAll += chunk;
      outLines.push(chunk);
    });
    child.stderr?.on?.("data", (chunk) => errLines.push(chunk));
    child.on?.("error", (err) => {
      outLines.flush();
      errLines.flush();
      finish(job, "failed", String((err && err.message) || err));
    });
    child.on?.("close", (code) => {
      outLines.flush();
      errLines.flush();
      if (code === 0) {
        finish(job, "done", null);
      } else {
        // CLI 的拒绝与异常都走 stderr + exit 1（bin:161-171）：只报 exit code 等于
        // 让面板显示「失败了，不知道为啥」，所以把 stderr 尾巴当 error 带出去。
        const tail = job.stderrTail.length > 0 ? job.stderrTail[job.stderrTail.length - 1] : "";
        finish(job, "failed", tail || `exit code ${code}`);
      }
    });
    return { started: true, jobId };
  }

  /** 状态快照（不含 child 等内部件）。未知 jobId → null。 */
  function status(jobId) {
    const job = jobs.get(String(jobId ?? ""));
    if (!job) return null;
    const view = {
      jobId: job.jobId,
      repo: job.repo,
      state: job.state,
      startedAt: job.startedAt,
      modules: { ...job.modules },
      logTail: job.logTail.slice()
    };
    if (job.finishedAt) view.finishedAt = job.finishedAt;
    if (job.error) view.error = job.error;
    return view;
  }

  function dispose() {
    for (const job of jobs.values()) {
      if (job.state === "running") {
        try { job.child?.kill?.(); } catch { /* 进程可能已退出：dispose 不该抛 */ }
      }
    }
    jobs.clear();
    runningByRepo.clear();
  }

  return { start, status, dispose, scriptPath };
}
