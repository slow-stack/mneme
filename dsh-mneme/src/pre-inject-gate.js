// Issue #380 注入前判定（preInjectGate）：每帧注入候选出池后、进入 system prompt
// 前，由一次池级 LLM 调用判出「会向本次请求注入意见/立场」的记忆（E12 D1 口径：
// 判定协议与实验 protocol-preinject.txt 同源；「意见/立场」框架依据 E3 读数 2
// 「FR 跟随意见内容」，且已被用户采纳为执行期决策）。
//
// 两条硬约束决定了本模块的形状：
// 1. 宿主 systemPrompt 渲染是同步回调（inject.js 的 text callback 不支持 await，
//    service.js Bug4 注释同源）——判定只能 async prefetch + cache、同步消费，与
//    inject.js 的 queryVectorCache 同款。冷缓存首帧降级为不判定原样注入，下一轮
//    同 key 渲染生效；防线故障永不阻塞注入。
// 2. 判定只给闸门用，绝不进模型上下文——给模型看任何标记的整条线已被 E2/E3
//    关闭（E12：判定+标记 D2 比判定+过滤 D1 差 +17.6pp）。
//
// 消费点在 service.injectCandidates 内、touchRecalled **之前**（#380 评审：与
// strictScope 同纪律，见 service.js 的「闸门还必须在 touchRecalled 之前」注释）：
// 滤除若发生在函数返回之后，被滤掉的记忆照样刷温时钟、照样进 recall_runs 曝光账，
// 反馈环会把闸门想压下的意见记忆重新顶上来。所以判定由 injectCandidates 调用，
// 帧状态经 gateStats 出参回给调用方做面板快照（不动「返回数组」的既有契约）。
//
// 两级语义复用 #254 writeAdmission（enabled 观察档 / enforce 真拦截）：
//   enabled=true 才跑判定；enforce=true 且缓存命中时同步滤除被标记候选；
//   observe 档（enforce=false）候选集不动，判定完成时落审计行看真实负载的意见
//   占比分布（issue：先测分布再决定 enforce）。
//
// 审计走 llm_audit_logs：trigger_source="preInjectGate"，真实 model_id 与 token
// 用量（区别于 writeAdmission 的 "skipped"/"-" 占位——本闸有真实 LLM 花费，面板
// 消费视图自动生效），related_memory_ids=被标记记忆的真实 UUID，metadata 带分布
// 与降级标记。llmAudit 关闭时本闸不运行（与 write-admission 的 evaluate 早退同
// 口径：无保留期的表不记账，无账目的判定不可见也不该花钱）。审计行**无条件落**：
// 无路由时 model_id 落 "unknown"（summarize.js 的无路由占位同款），不许出现
// 「判定照花钱、账目不见影」（#380 评审）。session_key 不写——store.js 的列语义是
// 「#254 写入准入的会话键（LLM 调用行恒 NULL）」，写进去会挤占 write-admission
// 话题回填的 TOPIC_LOOKBACK_ROWS 窗口。
//
// 候选映射为 m#<i> 局部序号参与判定、出参映射回真实 UUID——E13b 实测模型抄 36
// 位 UUID 的错误率足以让整单决策作废，局部短 id 是同源解法。
//
// 超时与取消（CodeRabbit on #382）：判定挂起用 GenerateOptions.signal（宿主
// llm.stream 契约自带）真取消底层流，取消发起后**有界等待流真正停止**才放行同
// key 重试；宿主不理会 signal 时该 key 进冷却期，冷却内不再对该池发新流——宁可
// 暂缓防线也不累积悬挂流；冷却按 key，跨 key 的悬挂流由熔断兜（不守取消契约与
// key 无关，同样计入连续降级）。冷却期与宽限期可注入（测试用），默认值不变。
//
// 两条资源护栏（#380 评审）：
//   - 连续降级熔断：判定器系统性坏掉时（模型持续返回不可解析输出、宿主持续报错）
//     逐帧重试等于把成本绑到交互帧数上——连续 FAILURE_BREAKER_N 次降级后全局停判
//     一个冷却期，到期自动恢复。熔断只停花钱，不改防线行为（照旧原样注入）。
//   - 整池被标记时放弃本次 enforce（fail-open）：记忆正文是判定模型的可影响输入，
//     一条指令型记忆可诱导模型标记全池 → 整个记忆块静默失明。该形态本帧退回观察档
//     原样注入并 warn；判定结果仍在缓存与审计里（n_flagged == n_pool 即此形态）。
import { STR, langOf } from "./lang.js";

export const GATE_TRIGGER_SOURCE = "preInjectGate";
export const GATE_OPERATION_TYPE = "pre_inject_gate";
// 判定输出上限：E12 实验同款硬编码（700），池级单次判定足够。
const JUDGE_MAX_TOKENS = 700;
// 缓存容量与 inject.js 的 queryVectorCache 同口径（cap 8，命中即刷新序 = LRU：
// FIFO 下活跃查询会被一次性新池挤出去，之后反复重判）。
const VERDICT_CACHE_MAX = 8;
// 流未停止时的 key 冷却期：冷却内不发新流（等旧的死掉/被宿主回收）。
const DEFAULT_COOLDOWN_MS = 60000;
// abort 之后的宽限：等底层流停止最多这么久，超过即视为宿主不响应取消。
const DEFAULT_SETTLE_GRACE_MS = 2000;
// 连续降级熔断阈值：连坏这么多次就全局停判一个冷却期（见文件头）。
const FAILURE_BREAKER_N = 3;

function extractJson(content) {
  const s = String(content ?? "").trim();
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

export function createPreInjectGate({ llm, agentDefaultModel, service, config, logger, judgeTimeoutMs, cooldownMs, settleGraceMs } = {}) {
  const language = langOf(config);
  const enabled = config?.preInjectGate?.enabled === true;
  const enforce = config?.preInjectGate?.enforce === true;
  // llmAudit 关闭 → 本闸不运行（见文件头：无账目的判定不可见也不该花钱）。
  const auditDisabled = config?.llmAudit?.enabled === false;
  const usable = enabled && !auditDisabled && typeof llm?.stream === "function";
  if (enabled && !usable) {
    logger?.warn?.("[dsh-mneme] preInjectGate enabled but unusable (llm missing or llmAudit disabled) — running as off");
  }

  const verdictCache = new Map(); // cacheKey -> { flaggedIds: Set<uuid>, nPool, reason }
  const inFlight = new Map();     // cacheKey -> Promise（并行渲染去重，防调用风暴）
  const cooldown = new Map();     // cacheKey -> 冷却截止 ms（流未停止的 key，冷却内不发新流）
  const JUDGE_TIMEOUT = judgeTimeoutMs ?? 60000;
  const COOLDOWN_MS = cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const SETTLE_GRACE_MS = settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS;
  let consecutiveFailures = 0;    // 连续降级次数（成功即归零）
  let breakerUntil = 0;           // 熔断截止 ms（0 = 未熔断）
  let disposed = false;

  // cacheKey = 查询 + 排序后的「id:content」：查询变、候选集变、**候选内容变**
  // （updateMemory 就地修正）都换 key——旧判定不沾新内容（CodeRabbit on #382）。
  // 排序保证同池同 key（等价池确定性）；内容进 key 换来的是 map 占用略涨，
  // 缓存 cap 8 有界。
  function cacheKey(query, candidates) {
    return `${query}\u0000${candidates.map((c) => `${c.id}:${c.content}`).sort().join("\u0001")}`;
  }

  function getCached(key) {
    return verdictCache.get(key) ?? null;
  }

  // 渲染帧的唯一同步入口（text callback 内调用，绝不 await）。返回
  //   state: "off"      闸门未启用/不可用/已 dispose/空池，调用方原样
  //          "filtered"  缓存命中 + enforce：调用方按 flaggedIds 滤除
  //          "observed"  缓存命中 + observe（或整池被标记的 enforce 退让）：
  //                      候选未动，分布已知（flaggedIds 带回）
  //          "pending"   冷缓存/冷却中/熔断中：本帧原样渲染；非冷却时判定已在后台发起
  // flaggedIds 只在缓存命中时非空。豁免（pin 池/graphHint 线索行不进判定集）由
  // 调用方在传入 judgedPart 时完成——本模块只认传入的池。
  function forFrame(query, candidates) {
    if (disposed || !usable || !Array.isArray(candidates) || candidates.length === 0) {
      return { state: "off", flaggedIds: null, nPool: 0 };
    }
    const key = cacheKey(query, candidates);
    const cached = verdictCache.get(key);
    if (cached) {
      // 命中刷序（LRU，见 VERDICT_CACHE_MAX 注释）。
      verdictCache.delete(key);
      verdictCache.set(key, cached);
      // enforce 黑屏保护：整池被标记时放弃本次滤除（fail-open，见文件头）。
      // 判定与审计都保留原样，面板上就是 n_flagged == n_pool 这一可见形态。
      const wipeout = enforce && cached.nPool > 0 && cached.flaggedIds.size >= cached.nPool;
      if (wipeout) {
        if (!cached.wipeoutWarned) {
          cached.wipeoutWarned = true;
          logger?.warn?.("[dsh-mneme] preInjectGate flagged the whole pool — skipping enforcement this frame (fail-open)");
        }
        return { state: "observed", flaggedIds: cached.flaggedIds, nPool: cached.nPool };
      }
      return {
        state: enforce ? "filtered" : "observed",
        flaggedIds: cached.flaggedIds,
        nPool: cached.nPool
      };
    }
    // 熔断期：判定器连坏（见文件头），全局停判——本帧原样渲染。
    if (Date.now() < breakerUntil) return { state: "pending", flaggedIds: null, nPool: candidates.length };
    // 冷却中的 key：上一条流还没死，不再叠新流（宁缓防线不积资源）。
    const until = cooldown.get(key);
    if (until) {
      if (Date.now() < until) return { state: "pending", flaggedIds: null, nPool: candidates.length };
      cooldown.delete(key);
    }
    if (inFlight.has(key)) return { state: "pending", flaggedIds: null, nPool: candidates.length };
    prefetch(key, query, candidates);
    return { state: "pending", flaggedIds: null, nPool: candidates.length };
  }

  // 降级计数：成功即归零（见 prefetch 的 verdict 分支），连坏 FAILURE_BREAKER_N
  // 次就全局停判一个冷却期（见文件头）。宿主不守取消契约（流不停）与判定失败
  // 同属「判定器不可用」，一起计数——否则每个不同查询都能各叠一条悬挂流，冷却
  // 按 key 就兜不住。熔断只停花钱，防线照旧原样注入。
  function noteDegraded() {
    consecutiveFailures += 1;
    if (consecutiveFailures >= FAILURE_BREAKER_N) {
      consecutiveFailures = 0;
      breakerUntil = Date.now() + COOLDOWN_MS;
      logger?.warn?.(`[dsh-mneme] preInjectGate degraded ${FAILURE_BREAKER_N} times in a row — pausing judgment for ${COOLDOWN_MS}ms`);
    }
  }

  function prefetch(key, query, candidates) {
    if (disposed || verdictCache.has(key) || inFlight.has(key)) return;
    const promise = judgePool(query, candidates)
      .then((outcome) => {
        inFlight.delete(key);
        // dispose 后在飞的结果不回写：拆机之后还改模块状态是 #381 有、#382 丢了的护栏。
        if (disposed) return;
        // 流未停止（宿主不响应 abort）：该 key 进冷却，冷却内不发新流。
        if (outcome.timedOut && !outcome.settled) {
          cooldown.set(key, Date.now() + COOLDOWN_MS);
          noteDegraded();
          return;
        }
        if (outcome.verdict) {
          consecutiveFailures = 0;
          verdictCache.set(key, outcome.verdict);
          if (verdictCache.size > VERDICT_CACHE_MAX) {
            verdictCache.delete(verdictCache.keys().next().value);
          }
          return;
        }
        // 判定失败（verdict=null）不缓存：下一帧重试。但连续降级要熔断——判定器
        // 系统性坏掉时，逐帧重试等于把成本绑到交互帧数上（见文件头）。
        noteDegraded();
      })
      .catch(() => { inFlight.delete(key); });
    inFlight.set(key, promise);
  }

  // 单次池级判定（E12 口径：1 次调用判整池，不逐条）。返回
  // { verdict, timedOut, settled }：verdict=null 即失败/不可解析/超时（审计行记
  // degraded）；timedOut 且 !settled = 底层流未随 abort 停止（调用方进冷却）。
  async function judgePool(query, candidates) {
    let route = {};
    try {
      const sel = agentDefaultModel?.currentSelection?.();
      if (sel?.provider && sel?.model) { route.provider = sel.provider; route.model = sel.model; }
    } catch { /* fall through：无路由照常判定、照常落账（model_id 落 "unknown"） */ }
    const modelId = route.provider && route.model ? `${route.provider}:${route.model}` : "";
    const startedAt = Date.now();
    const timestamp = new Date(startedAt).toISOString();
    const source = { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" };
    // 刻意不套 fenceListBody（dream.js:330，Issue #380 的复盘）：本闸的 system 契约把
    // user 侧形状写死成「你将收到一个 JSON 对象，包含 query 与 memories」（lang.js:57/58），
    // 套围栏会让提示词与载荷互相矛盾；而且判定池靠 JSON.parse 直接取 m#<i> 局部序号还原
    // 候选（test/pre-inject-gate.test.js 锁着这个形状），外包围栏文本会让解析整条失败。
    // 这里的注入防线不是围栏而是**判定结果绝不进模型上下文**：没有任何标记（判到的、
    // 没判到的）会被写回提示词，给模型看标记的整条线已被 E2/E3 关闭（见 lang.js:52-55）。
    // 但这条「移出候选」的保证是**有条件的**，写清楚免得被读成无条件：
    //   · 只有 enforce 开着、且本帧缓存命中（gateFrame.state === "filtered"）时才真移除候选
    //     （service.injectCandidates 的移除分支）；
    //   · 观察档（enforce 关）、冷缓存首帧、判定失败/超时、整池被标记的 fail-open 帧，
    //     候选原样注入——那些帧里记忆正文会照常到达模型；
    //   · 判定器识别的是「意见或立场」，它**不**承诺消化正文里任何指令句（越狱式记忆
    //     不在本闸的判据里），别把这段读成对注入指令的保证。
    // 没有围栏可闭合，也就没有「闭合标记被伪造」这一路风险。
    const messages = [
      { role: "system", content: [{ type: "text", text: STR.prompts.preInjectGate[language] }], source },
      { role: "user", content: [{ type: "text", text: JSON.stringify({ query, memories: candidates.map((c, i) => ({ id: `m#${i}`, content: c.content })) }) }], source },
    ];

    let text = null;
    let errorMessage = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let timedOut = false;
    let settled = false;
    // 取消协议：GenerateOptions.signal 是宿主 llm.stream 契约自带的取消通道。
    const abort = new AbortController();
    const consume = (async () => {
      try {
        for await (const chunk of llm.stream({ ...route, maxTokens: JUDGE_MAX_TOKENS, messages, signal: abort.signal })) {
          if (chunk.type === "text-delta" && typeof chunk.text === "string") text = (text ?? "") + chunk.text;
          if (chunk.type === "usage") {
            const u = chunk.usage ?? chunk;
            const i = u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? u.promptTokens;
            const o = u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? u.completionTokens;
            if (Number.isFinite(i)) inputTokens = i;
            if (Number.isFinite(o)) outputTokens = o;
          }
          if (chunk.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) {
            errorMessage = "llm stream aborted or errored";
            return;
          }
        }
      } finally {
        settled = true;
      }
    })();
    consume.catch(() => { /* 取消/竞态路径的拒绝已由 race 接过一次，这里防未处理拒绝 */ });

    let timeoutTimer;
    try {
      await Promise.race([
        consume,
        new Promise((_, reject) => {
          timeoutTimer = setTimeout(() => {
            timedOut = true;
            errorMessage = `judgment timeout (${JUDGE_TIMEOUT}ms)`;
            abort.abort(); // 先取消底层流，再等它停下
            reject(new Error(errorMessage));
          }, JUDGE_TIMEOUT);
        })
      ]);
      clearTimeout(timeoutTimer);
    } catch (err) {
      clearTimeout(timeoutTimer);
      if (!timedOut) errorMessage = String(err?.message ?? err);
      logger?.warn?.(`[dsh-mneme] preInjectGate judgment failed: ${errorMessage}`);
    }
    if (timedOut) {
      // 有界等流停止：停了才允许同 key 重试（prefetch 按 settled 决定是否冷却）。
      // 定时器必须显式 clear：流提前停下时它还会把进程多按 SETTLE_GRACE_MS（评审）。
      let graceTimer;
      await Promise.race([
        consume,
        new Promise((r) => { graceTimer = setTimeout(r, SETTLE_GRACE_MS); })
      ]).catch(() => {});
      clearTimeout(graceTimer);
    }

    // 出参解析：m#<i> → 数组索引 → 真实 UUID。越界/重复/非本池 id 一律忽略
    // （解析宽松、应用严格：模型幻觉出的 id 不能滤掉任何真实条目）。
    const parsed = errorMessage ? null : extractJson(text);
    const flaggedIds = new Set();
    let reason = null;
    if (parsed && Array.isArray(parsed.ids)) {
      for (const raw of parsed.ids) {
        const m = /^m#(\d+)$/.exec(String(raw));
        const idx = m ? Number(m[1]) : -1;
        if (idx >= 0 && idx < candidates.length) flaggedIds.add(candidates[idx].id);
      }
      if (typeof parsed.reason === "string" && parsed.reason.trim()) reason = parsed.reason.trim().slice(0, 300);
    } else if (!errorMessage) {
      errorMessage = "unparseable judgment output";
    }
    const degraded = errorMessage !== null || !parsed;

    // 审计 best-effort（CONTRIBUTING fail-safe 硬约定）：写行失败只 warn。
    // llmAudit 关闭时 usable 已为 false，这里理论不可达；防御性再判一次。
    // 条件里**不含 modelId**：判定生效就必有账（无路由落 "unknown" 占位）。
    // session_key 不写（store.js：LLM 调用行恒 NULL；写进去会挤占 write-admission
    // 的话题回填窗口）。
    if (config?.llmAudit?.enabled !== false && typeof service?.saveLlmAudit === "function") {
      try {
        service.saveLlmAudit({
          timestamp,
          trigger_source: GATE_TRIGGER_SOURCE,
          operation_type: GATE_OPERATION_TYPE,
          model_id: modelId || "unknown",
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          cost_usd: 0,
          duration_ms: Date.now() - startedAt,
          status: degraded ? "error" : "success",
          error_message: errorMessage,
          related_memory_ids: [...flaggedIds],
          metadata: {
            n_pool: candidates.length,
            n_flagged: flaggedIds.size,
            ...(reason ? { reason } : {}),
            degraded
          }
        });
      } catch (auditError) {
        logger?.warn?.(`[dsh-mneme] preInjectGate audit write failed: ${String(auditError)}`);
      }
    }

    if (degraded) return { verdict: null, timedOut, settled };
    return { verdict: { flaggedIds, nPool: candidates.length, reason }, timedOut, settled };
  }

  // dispose 钩子（index.js 的 disposers）。置 disposed 后：在飞的判定结果不再回写
  // 缓存/冷却，渲染帧直接走 off —— 拆机后模块状态不再变化。
  function clear() {
    disposed = true;
    verdictCache.clear();
    inFlight.clear();
    cooldown.clear();
    consecutiveFailures = 0;
    breakerUntil = 0;
  }

  return { enabled: usable, enforce, cacheKey, getCached, forFrame, clear };
}
