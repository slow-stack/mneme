/**
 * 日记的**触发侧**：让「跨天了该写一篇」变成自动发生，而不是等人想起来点按钮。
 *
 * 为什么单独一个文件：compose.js 是纯逻辑（采集/生成/落盘），触发时机、去重、
 * 错误兜底是**宿主接线**问题。混在一起会让那层不再能被测试直接驱动。
 *
 * 三条执行侧边界（与 pipeline-nudge-auto.js 同一套口径）：
 * - **不 cron，但可选定时唤醒**：判定发生在三处——turn/end、插件启动、以及
 *   diaryWriteEveryMinutes > 0 时的定时器。定时器只负责「醒来问一句今天写了没」，
 *   写不写仍由 compose 按落盘日期去重，所以一天最多一篇；缺省 0 = 关，只有前两处
 *   （＝此前行为，整日不说话就不写）；
 * - **一次只补一篇**：睡得久一点回来了也就补一篇，不许醒来一次补十篇烧配额；
 * - **失败不冒泡**：session/event 那条链上还挂着摘要与续期，日记写砸了只能 warn。
 */
import { projectRootOf } from "../pipeline-runner.js";
import { localDateString } from "./rollover.js";
import { sessionAgentId } from "./session-provider.js";

/** 同一项目两次判定的最短间隔：turn/end 密度很高，而一天只需写一篇。 */
export const DIARY_MIN_INTERVAL_MS = 60 * 1000;

export function createDiaryAutoRun({
  ctx = null,
  composer = null,
  logger = null,
  sessionGate = null,
  now = () => Date.now(),
  minIntervalMs = DIARY_MIN_INTERVAL_MS,
  everyMs = 0,
  listProjects = null
} = {}) {
  const log = logger || (ctx && ctx.logger) || null;
  let disposed = false;
  let timer = null;
  /** 定时写的钟。与 timer（setTimeout(0) 的派发器）是两回事：那个只把待判项目挪到下一帧。 */
  let ticker = null;
  /** 每个项目最近一次判定时刻。注意是「判定」不是「写过」——写过与否在 compose 里按落盘判断。 */
  const checkedAt = new Map();
  /**
   * 待判项目 → { session, trigger }。带会话是因为素材主来源就是它（见 compose 的
   * session 参数）；带 trigger 是因为重扫要如实记账「这篇是谁叫醒的」。
   */
  const pending = new Map();

  const normalize = (p) => {
    let s = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
    if (/^[a-zA-Z]:\//.test(s)) s = s.toLowerCase();
    return s;
  };

  const runOne = (projectRoot, trigger, session = null) => {
    pending.delete(projectRoot);
    if (disposed || !composer) return null;
    checkedAt.set(normalize(projectRoot), now());
    // session 与 agentId 一起传：素材取会话转录，声音取这个会话的人格卡。
    // 两者必须来自同一个会话，否则会写出「A 的人格 + B 的素材」那种缝合怪。
    const task = composer.compose({ trigger, projectRoot, session, agentId: sessionAgentId(session) });
    // compose 是异步的（要等模型），绝不能返回给 session/event 的派发方去 await——
    // 那会把回合收尾吊在模型延迟上（本机实测 p90 五十秒级）。
    return Promise.resolve(task).catch((error) => {
      log?.warn?.("[dsh-mneme] diary compose failed (" + projectRoot + "): " + String((error && error.message) || error));
      return null;
    });
  };

  const flush = () => {
    timer = null;
    if (disposed) return;
    const first = pending.entries().next();
    if (first.done) return;
    const [projectRoot, queued] = first.value;
    runOne(projectRoot, queued.trigger, queued.session);
    if (pending.size > 0 && !disposed) defer();
  };

  const defer = () => {
    if (disposed || timer) return;
    // 当前这一帧是宿主的 turn/end 处理链。setTimeout(0) 挪到下一个宏任务，
    // 宿主先收尾；unref 让退出不被这根定时器吊住。
    timer = setTimeout(flush, 0);
    if (typeof timer.unref === "function") timer.unref();
  };

  const schedule = (projectRoot, session = null, trigger = "rollover") => {
    const key = normalize(projectRoot);
    const last = checkedAt.get(key);
    if (last !== undefined && now() - last < minIntervalMs) return;
    if (pending.has(projectRoot)) return;
    pending.set(projectRoot, { session, trigger });
    defer();
  };

  const onSessionEvent = (session, event) => {
    if (disposed) return;
    if (sessionGate?.isOff(session)) return;
    if (!event || event.type !== "turn/end") return;
    const projectRoot = projectRootOf(session);
    if (!projectRoot) return;
    schedule(projectRoot, session);
  };

  const unsubscribe = ctx && typeof ctx.on === "function" ? ctx.on("session/event", onSessionEvent) : null;

  /**
   * 定时写：每隔 everyMs 醒来问一次「今天写了没」。
   *
   * 为什么需要它：原来的判定全挂在 turn/end 上，等于「你不说话它就不写」。桉桉
   * 2026-11-09 说的「日记本按理来说应该需要定时写」就是这件事。唤醒后走的是同一条
   * schedule → compose 路径，去重仍在 compose 里按落盘日期做，所以：
   * - 一天最多一篇（跟手点「写一篇」共用那个去重）；
   * - 失败只 warn，不打断宿主（session/event 那条链上还挂着摘要与续期）；
   * - 醒来时不知道该扫哪个项目就什么都不做——宁可漏一次，不猜别人的项目根。
   *
   * 不用 setInterval 的理由：写完一篇要等模型（本机 p90 五十秒级），固定节拍会在
   * 慢的那次之后立刻再来一次。这里改成「跑完再排下一次」，天然不重叠。
   */
  const tick = async () => {
    if (disposed) return;
    ticker = null;
    if (!composer || everyMs <= 0) return;
    try {
      const projects = typeof listProjects === "function" ? listProjects() : [];
      const list = Array.isArray(projects) ? projects.filter(Boolean) : [];
      for (const projectRoot of list) {
        if (disposed) break;
        // 同一个项目由 turn/end 刚判过就不必再判（minIntervalMs 已经在 schedule 里
        // 拦了一道，这里只是省掉一次 map 写入）。
        schedule(projectRoot, null, "timer");
      }
    } catch (error) {
      log?.warn?.("[dsh-mneme] diary timer scan failed: " + String((error && error.message) || error));
    }
    arm();
  };

  const arm = () => {
    if (disposed || everyMs <= 0 || ticker) return;
    ticker = setTimeout(() => {
      Promise.resolve(tick()).catch((error) => {
        log?.warn?.("[dsh-mneme] diary timer tick failed: " + String((error && error.message) || error));
      });
    }, everyMs);
    // unref：不因为一根日记的钟让宿主退不出去。
    if (typeof ticker.unref === "function") ticker.unref();
  };

  // 只有明确配了间隔才起钟。缺省 0 = 完全不起，行为与 v0.13 之前一致。
  arm();

  /**
   * 启动补写：只补上次关宿主那段时间留下的那一篇。
   *
   * 为什么是启动而不是「每隔几小时」：宿主退出期间没有任何东西在跑，唯一能知道
   * 「昨天没写」的时刻就是下次启动或下次说话。两处都判，效果对用户是一样的。
   * 不知道该补哪个项目（启动时没有会话）→ 什么都不做，等第一次 turn/end。
   */
  const catchUp = (projects = []) => {
    if (disposed || !composer) return Promise.resolve([]);
    const list = Array.isArray(projects) ? projects.filter(Boolean) : [];
    return Promise.all(
      list.map((projectRoot) =>
        Promise.resolve(composer.compose({ trigger: "startup", projectRoot })).catch((error) => {
          log?.warn?.("[dsh-mneme] diary startup catch-up failed (" + projectRoot + "): " + String((error && error.message) || error));
          return null;
        })
      )
    );
  };

  const dispose = () => {
    disposed = true;
    pending.clear();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (ticker) {
      clearTimeout(ticker);
      ticker = null;
    }
    if (typeof unsubscribe === "function") unsubscribe();
  };
  dispose.runNow = (projectRoot, trigger = "manual", session = null) => (disposed || !projectRoot ? null : runOne(projectRoot, trigger, session));
  dispose.pendingCount = () => pending.size;
  dispose.timerArmed = () => ticker !== null;
  dispose.tickNow = () => (disposed ? Promise.resolve() : Promise.resolve(tick()));
  dispose.catchUp = catchUp;
  dispose.today = () => localDateString(new Date(now()));
  return dispose;
}
