// #254 写入准入。两个阶段：
//   阶段一（已合入）：只计量、不拦截。会话写入预算的 N 与同话题冷却的 X 在没有真实
//   分布时拍任何数字都是误杀面（维护者 2026-09-23 拍板「先记录不拦，由遥测定」）。
//   所以那两个闸门只把原始测量点写进 llm_audit_logs（status='skipped'、
//   metadata.gate='g1' 且同话题重复时附 metadata.g2），不做判定、不改任何写入行为；
//   阈值与二次确认（memory_save({confirm:true})）等遥测有分布再单独提。
//   阶段一之后（本批）：第 1 级确定性拒绝。按 2026-09-21/09-22 两轮收窄的口径，
//   第 1 级只剩**密钥/PII 与空白噪声**两类判据走硬拒；去重键命中判 write-update 放行
//   （不把同步去重升级成拒绝门——2606.24535 记的那个失效模式：同步近重复门抢在异步
//   矛盾检测之前，本该被裁决的矛盾写入被门直接拒掉）。两类判据都零 LLM、纯确定性。
//   两个开关都默认关：enabled 打开判定，enforce 打开拦截（关 = 仅告警 + 留审计）。
//   默认关时 evaluate 的返回与阶段一逐字段一致（验收第 1 条「默认路径零行为变化」）。
//   密钥/PII 那一类的判据实现不在本模块：按验收第 4 条它是 #164 A2 的判据来源，由
//   createWriteAdmission 的 sensitiveScan 注入，本模块只定义它怎么被消费。
//
// 为什么复用 llm_audit_logs：它是仓库既有的「后台动作回执」表（bookkeeping，不
// 触发写钩子，见 store.js 的表注释）。第二阶段落地时「第一次 skipped/gate →
// 第二次 confirm:true 放行」在审计里成对出现，因果可回放。
//
// 一行一个新建行（不是一行一个信号）：这样「会话内新建条数」就是按 session_key
// 的直接计数，不需要任何 JSON 解析；g2 命中时作为该行的 metadata.g2 附带，不做第
// 二行。测量点只取在新行上——并入已有行是去重机制在正常工作，既不进预算也不记行。
// 会话身份来自工具 exec（scope.js › sessionKeyOf）：没有会话身份的写入（dream /
// summarize / import / organize）不进预算，预算管的是「一次对话里写飞了」。
//
// 穿透口（与 #275 拍板 5 的 pinned 豁免同口径）：constraint / preference 是 #249
// 第一批立的逐字保真池，永不进预算；仍记一行审计（metadata.exempt='pinned'）以便
// 观察穿透频率。穿透行既不参与 g2 判定，也不推进同话题的时间基准——它整个不在闸门
// 里，成为下一次比较的基准会把 g2 的样本混进穿透流量。
//
// 内容哈希（exact duplicate，第三类测量点，维护者 2026-09-24 拍板）：归一化口径定在
// content-hash.js，命中即「同一内容又被写了一次」。判据用哈希而不是相似度——相似度
// 阈值在同一件事换个说法 / 不同的事共享话题词之间来回挪，只会换一种错法。候选集先按
// type 与 scope 三维等值收窄再比哈希（不是全表扫），并把归档行一并纳入：「出口止体积、
// 不止重复」，被质量闸归档的同一个事实不在 saveWithDedupe 的候选集里（store.list 默认
// 排除归档），同样的内容再写一次就是一条新行，这正是这条信号要量的穿透。两个穿透口与
// pinned 豁免同口径：pinned 在这里返回得更早，连候选集查询都不发。
//
// 信号跟着同一行审计走，所以内容哈希与 g1/g2 覆盖同一批写入（会话内新建行）。无会话
// 身份的系统写入（dream 总览 / autoSummarize / bootstrap / standalone HTTP 保存）自
// #663 起只走第 1 级判据：命中即拒的那档落一行（session_key 为 NULL，无 g1/g2/dup 测量
// 点），放行档不落行——预算、话题冷却、内容哈希都要一条会话时间线做基准。
// 唯一没进来的是 share 收包那条路：它走 store.save（docs/SHARE.md 的信任边界），
// 判据挂在 saveWithDedupe 的汇流口，要接得先把那条路改到汇流口。
//
// 与 llmAudit.enabled 的关系：那个开关同时关掉审计行的启动期清理（index.js 的
// deleteOldLlmAudits），所以关掉时本模块一行都不写，否则就是在无保留期的表里做
// 按写入频次增长。
import { PINNED_MEMORY_TYPES } from "./service.js";
import { contentHashOf, normalizeForHash } from "./content-hash.js";

// 审计口径（llm_audit_logs 的既有列）：trigger_source = 组件名，operation_type =
// 动作名，status='skipped' = 本行没有产生任何 LLM 花费（与 summarize 的间隔门、
// 尖峰门同款读法）。
export const ADMISSION_TRIGGER_SOURCE = "writeAdmission";
export const ADMISSION_OPERATION_TYPE = "write_admission";
export const ADMISSION_GATE_SESSION_BUDGET = "g1";

// 决策两值。阶段一恒 allow；第 1 级判定命中且 enforce 打开时才 deny。
export const ADMISSION_DECISION_ALLOW = "allow";
export const ADMISSION_DECISION_DENY = "deny";

// 第 1 级的拒绝原因（#254 拍板：硬拒绝只留密钥/PII 与空白噪声；去重键命中归
// write-update 放行，G1/G2 走二次确认）。reason 是审计行里的稳定键，别当展示文案用。
export const ADMISSION_DENY_BLANK = "blank";
export const ADMISSION_DENY_NOISE = "noise";
export const ADMISSION_DENY_SENSITIVE = "sensitive";

// 首次见到某会话时的回填深度：话题表由审计行重建，只回填最近这么多行。更早的
// 话题会漏（测量口径可接受），换来的是一次查询与有界的常驻内存。
export const TOPIC_LOOKBACK_ROWS = 200;

// 话题锚只收机械可判的两类：issue/PR 引用与文件路径。两条都带前缀或分隔符，误报
// 面小；自由文本里看不出确定性的「同话题」，硬判只会把误杀面提前引进来（#254 已
// 定：计量信号用确定性锚，不用相似度阈值——同一件事换个说法就掉下去，不同的事
// 共享话题词又顶上来，阈值怎么挪都是在两种误判之间来回）。
// 两处收紧都来自误报样本：`(?<![#\w])` 挡掉 Markdown 标题 `###1` 与紧跟标识符的
// 井号；扩展名要求首字符是字母，挡掉 `3.5/2.0` 这类比值（否则一个算式就成了话题）。
const ISSUE_REF = /(?<![#\w])#\d{1,7}\b/g;
const FILE_PATH = /(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,5}\b/g;

/**
 * 写入文本里的确定性话题锚：小写归一 + 路径分隔符统一为 `/` + 去重 + 排序。
 * 同一话题在不同轮次必须逐字节相等，才能用等值比较而不是相似度比较——所以
 * `src\service.js` 与 `src/service.js` 必须归到同一个锚。
 * @param {{title?: string, content?: string, tags?: string[]}} memory
 * @returns {string[]} 排序后的话题锚
 */
export function extractTopicKeys(memory) {
  const text = [memory?.title, memory?.content, ...(Array.isArray(memory?.tags) ? memory.tags : [])]
    .filter((s) => typeof s === "string")
    .join("\n");
  const keys = new Set();
  const add = (raw) => keys.add(raw.toLowerCase().replace(/\\/g, "/"));
  for (const m of text.matchAll(ISSUE_REF)) add(m[0]);
  for (const m of text.matchAll(FILE_PATH)) add(m[0]);
  return [...keys].sort();
}

/**
 * 第 1 级「空白 / 纯噪声」判据（#254，零 LLM、纯函数、无状态）。
 *
 * 为什么这两类够格进硬拒：它们的命中面**没有解释空间**——一条归一化后什么都不剩的
 * 写入，进库之后既检索不到也注入不了，写它只有成本没有收益，不存在「误杀有价值内容」
 * 的可能。这正是硬拒与二次确认的分界：有解释空间的（去重命中、预算/冷却）走二次确认，
 * 没有解释空间的才硬拒。
 *
 * 为什么复用 content-hash 的归一化而不另写一套：判据要的是「有没有信息」，而
 * normalizeForHash 的口径（NFKC → 小写 → 去标点 → 空白折叠）恰好就是「把格式折掉之后
 * 还剩什么」。另写一套只会多出一个会漂移的口径（同 content-hash.js 文件头的存量重算
 * 理由）。两个 reason 分开报是为了可解释：`blank` 是真的什么都没写（提交一个空表单），
 * `noise` 是写了但只有标点/空白（`...`、`---`）——两者的修法不同。
 *
 * 为什么不用 quality-filter 的 `repetitive`（trigram 重复率 > 0.7）一起判：那是**写入
 * 后**的评分扣分项，扣分可以错（只影响排序与归档），硬拒不能错。判据本身的误杀面已经
 * 收窄了（本次改动换掉了按长度衰减的旧度量），但「谁该进库」与「进库后谁该排后面」
 * 仍是两个决定：前者要用户改不了，后者只要排序可解释。重复片段里也可能藏着一条真
 * 事实（同一句规则被追加两遍），这种东西该留、只是排后面。
 *
 * @param {{title?: string, content?: string}|null|undefined} memory
 * @returns {"blank"|"noise"|null} 命中即返回 reason，否则 null
 */
export function informationlessReason(memory) {
  const title = String(memory?.title ?? "").trim();
  const content = String(memory?.content ?? "").trim();
  if (!title && !content) return ADMISSION_DENY_BLANK;
  if (!normalizeForHash(title) && !normalizeForHash(content)) return ADMISSION_DENY_NOISE;
  return null;
}

/**
 * 写入准入（#254）。返回的两个方法就是三个消费方共用的那份接口：
 *   evaluate 给出决策形状，record 把测量点/拒绝面写成审计行。
 * #249 的注入提示与 #275 的水位计数都读同一份 decision/审计行，而不是各写一套判定。
 *
 * 两个开关（config.writeAdmission，都默认关——验收第 1 条「默认路径零行为变化」）：
 *   enabled — 打开第 1 级判定（空白/噪声 + 注入进来的密钥/PII 判据）。
 *             关时 evaluate 的返回与阶段一逐字段一致，只算三个测量点。
 *   enforce — 命中时真的拒绝。关时判定照跑、照留审计，但决策回落 allow（仅告警）。
 * 密钥/PII 那一类判据不在这里实现：按 #254 验收第 4 条，它是 #164 A2 的判据来源，
 * 由 `sensitiveScan` 注入（见下），本模块只定义它怎么被消费。
 *
 * @param {object} deps
 * @param {object} deps.store 存储层（listLlmAudits / saveLlmAudit）
 * @param {object} [deps.config] 已解析配置（读 llmAudit.enabled、writeAdmission.*）
 * @param {object} [deps.logger]
 * @param {() => number} [deps.now] 时钟注入（测试用）
 * @param {(memory: object) => ({reason: string, kind?: string, label?: string}|null)} [deps.sensitiveScan]
 *   第 1 级的密钥/PII 判据（#164 A2 的落点）。约定：命中返回 `{kind, label}`，未命中
 *   返回 null，**不抛**（抛出按未命中处理并 warn，判据故障不能让写入变成不可用）。
 *   缺省时这一类判据整个不参与——本模块在 A2 落地前只跑空白/噪声。
 */
export function createWriteAdmission({ store, config, logger, now = Date.now, sensitiveScan = null } = {}) {
  // sessionKey → Map<话题锚, 最近一次新建行时刻(ms)>。真相源是审计行，这里只是它的
  // 增量视图：进程重启后按需回填。FIFO 上限防长驻进程内存无界（同 store.js 的
  // embedding 解析缓存口径）。
  const topicTables = new Map();
  const SESSION_CACHE_MAX = 200;

  const warn = (msg) => {
    // 计量是旁路：任何一环失败都不能影响写入，日志自身故障也一样。
    try {
      logger?.warn?.(msg);
    } catch { /* ignore */ }
  };

  /** 某会话的话题表（首见时从审计行回填，之后走内存增量）。 */
  function topicTable(sessionKey) {
    const cached = topicTables.get(sessionKey);
    if (cached) return cached;
    const table = new Map();
    try {
      const rows = store?.listLlmAudits?.({ sessionKey, limit: TOPIC_LOOKBACK_ROWS }) ?? [];
      for (const row of rows) {
        const metadata = row?.metadata;
        if (!metadata || typeof metadata !== "object" || !Array.isArray(metadata.topics)) continue;
        // 穿透行（pinned）整个不在闸门里，也就不该进基准表——只挡内存路径不挡回填，
        // 重启后口径就变了（同一个话题会因为一条穿透行而被判成重复）。
        if (metadata.exempt) continue;
        // 被第 1 级拦下的行同理：它根本没进库。内存路径已经跳过了（见 record 的
        // enforced 判断），回填路径必须同口径——否则同一条时间线会随进程重启而变：
        // 重启前不重复、重启后变重复。仅告警档（deny 非空但 decision=allow）要留，
        // 那条行确实落库了。
        if (metadata.deny?.enforced === true) continue;
        const at = Date.parse(row.timestamp);
        // 坏时间戳跳过：落到 0 会让 gap 变成几十年，一个离群值就能带偏按分位定的 X。
        if (!Number.isFinite(at)) continue;
        for (const topic of metadata.topics) {
          // 审计行按时间倒序返回，先到的那条就是该话题最近一次写入——后来的不覆盖。
          if (!table.has(topic)) table.set(topic, at);
        }
      }
    } catch (e) {
      // 回填失败降级为「本会话此前的话题不可见」：漏一个 g2 测量点，不影响写入。
      warn(`[dsh-mneme] write admission topic backfill failed: ${String(e)}`);
    }
    if (topicTables.size >= SESSION_CACHE_MAX && !topicTables.has(sessionKey)) {
      topicTables.delete(topicTables.keys().next().value);
    }
    topicTables.set(sessionKey, table);
    return table;
  }

  /**
   * 内容哈希候选集查询（#254 第三类测量点）。失败降级为「没命中」：漏一个测量点，
   * 不影响写入，也不让计量反噬。
   * 多条命中时的取舍（活区优先）：有活跃/未遗忘的命中就报它（判据是「去重候选集本该
   * 拦住」），只有归档/遗忘行命中才报它们。store 侧已把活跃行排在窗口头部，这里的 find
   * 是防御性重复：排序口径将来再变，本判据也不跟着变。
   * archived 与 forgotten 分开回：两者都是「出口」，但穿透含义不同——只命中已遗忘行时
   * 若只回 archived=false，读审计的人会以为库里有活跃重复；而 saveWithDedupe 的候选集
   * 本来就排除遗忘行（store.list 默认 includeForgotten=false），这类命中同样是穿透。
   * @returns {{memory_id: string, archived: boolean, forgotten: boolean}|null}
   */
  function lookupContentDup(memory) {
    try {
      const hash = contentHashOf(memory);
      if (!hash) return null;
      const hits = store?.findContentHashMatches?.({
        type: memory?.type,
        hash,
        agent_scope: memory?.agent_scope,
        workspace_scope: memory?.workspace_scope,
        sensitivity: memory?.sensitivity
      }) ?? [];
      const hit = hits.find((h) => !h.archived && !h.forgotten) ?? hits[0];
      return hit ? { memory_id: hit.id, archived: hit.archived === true, forgotten: hit.forgotten === true } : null;
    } catch (e) {
      warn(`[dsh-mneme] write admission content hash lookup failed: ${String(e)}`);
      return null;
    }
  }

  /**
   * 第 1 级判据的汇总口（#254）：空白 / 噪声 + 注入进来的密钥 / PII。
   * 顺序按成本排：字符串判据在前，注入的扫描器在后；扫描器抛异常按「未命中」处理
   * （warn）——判据故障不能让所有写入变成不可用，这是与计量同一条不反噬原则。
   * @returns {{reason: string, kind?: string, label?: string}|null}
   */
  function firstLevelHit(memory) {
    const info = informationlessReason(memory);
    if (info) return { reason: info };
    if (typeof sensitiveScan !== "function") return null;
    try {
      const hit = sensitiveScan(memory);
      if (!hit) return null;
      const deny = { reason: ADMISSION_DENY_SENSITIVE };
      // kind / label 只在判据真给了才落盘：给 undefined 会让审计行里出现一个
      // 存在但无值的键，读的人分不清「没报」和「报了空串」。
      if (hit.kind !== undefined) deny.kind = hit.kind;
      if (hit.label !== undefined) deny.label = hit.label;
      return deny;
    } catch (e) {
      warn(`[dsh-mneme] write admission sensitive scan failed: ${String(e)}`);
      return null;
    }
  }

  /**
   * 决策形状一次定死，后续只加分支、不改字段：
   *   decision — "allow" | "deny"
   *   gate     — "g1" | null（null = 这次写入不进预算，不记行）
   *   topics   — 本次写入的确定性话题锚
   *   repeat   — {topic, gapMs} | null（g2 的命中面）
   *   dup      — {memory_id, archived, forgotten} | null（内容哈希的命中面）
   *   exempt   — null | "pinned"
   *   deny     — null | {reason, kind?, label?}（第 1 级命中面）
   *
   * deny 非空但 decision 仍是 allow = 仅告警档（config.writeAdmission.enforce 关）：
   * 判定照跑、审计照留，写入不拦。读审计时「deny 非空且 decision=allow」就是这一档的
   * 指纹，不需要再读配置才能解释一行。
   *
   * 第 1 级判定放在 pinned 豁免之前：pinned 豁免的是**预算与冷却**（constraint /
   * preference 是 #249 第一批立的逐字保真池，不该被会话预算拦），不是「这条能不能落库」。
   * 一条写着私钥的 constraint 仍然是私钥。
   * @param {{memory: object, sessionKey?: string|null}} input
   */
  function evaluate({ memory, sessionKey } = {}) {
    const verdict = {
      decision: ADMISSION_DECISION_ALLOW,
      gate: null,
      topics: [],
      repeat: null,
      dup: null,
      exempt: null,
      deny: null
    };
    // 审计关掉时不记行、也不推进话题表（见文件头：那个开关连启动期清理一起关掉）。
    // 判据也一并跳过：拒绝面是「可解释」的承诺，审计关掉之后拒绝就只能静默发生，
    // 而静默丢弃比不拦更坏——调用方会以为记忆已经写进去了。
    if (config?.llmAudit?.enabled === false) return verdict;

    // #663：第 1 级判据与会话身份无关。autoSummarize / dream 输出 / bootstrap /
    // share 导入这些写入没有 sessionKey，但它们落库的同样是**文本**，密钥/PII 与
    // 空白噪声的判据面照样适用；此前这里提前 return，等于三处系统出口整片没判。
    const hit = config?.writeAdmission?.enabled === true ? firstLevelHit(memory) : null;
    const judged = hit ? { ...verdict, deny: hit } : verdict;

    // 命中且 enforce：决策已定，不再发候选集查询、不再比较话题（纯白花成本）。
    // gate 跟着会话身份走：无会话身份不记预算行（没有可比的时间线），但拒绝照样
    // 生效，审计行由 record 落（session_key 为 NULL）。
    if (hit && config?.writeAdmission?.enforce === true) {
      return {
        ...judged,
        decision: ADMISSION_DECISION_DENY,
        gate: sessionKey ? ADMISSION_GATE_SESSION_BUDGET : null,
        topics: extractTopicKeys(memory)
      };
    }

    // 无会话身份 = 系统写入（dream / summarize / import / bootstrap）：只过第 1 级，
    // 不进预算、不查内容哈希、不算话题冷却。三者都要一条会话时间线做基准；硬凑一个
    // 假 session_key 会把真实会话的分布污染成两截，读审计的人再也分不开。
    if (!sessionKey) return judged;

    const topics = extractTopicKeys(memory);
    const pinned = PINNED_MEMORY_TYPES.has(String(memory?.type ?? ""));
    if (pinned) return { ...judged, gate: ADMISSION_GATE_SESSION_BUDGET, topics, exempt: "pinned" };
    const dup = lookupContentDup(memory);
    const table = topicTable(sessionKey);
    const at = now();
    let repeat = null;
    for (const topic of topics) {
      if (!table.has(topic)) continue;
      const gapMs = Math.max(0, at - table.get(topic));
      // 同一行可能命中多个锚：取最近的那次（间隔最短＝最有价值的那次重复）。
      if (!repeat || gapMs < repeat.gapMs) repeat = { topic, gapMs };
    }
    return { ...judged, gate: ADMISSION_GATE_SESSION_BUDGET, topics, repeat, dup };
  }

  /**
   * 把测量点与拒绝面落成审计行（一行一个新建行 / 一次被拒的写入）。四个信号的读法：
   *   g1 会话写入预算：`GROUP BY session_key` 计数即得「会话内新建条数」分布；要剔
   *      掉穿透行（pinned 不进预算）就加 `json_extract(metadata,'$.exempt') IS NULL`。
   *   g2 同话题冷却：`json_extract(metadata,'$.g2.gap_ms')` 即得「同话题新建行间隔」
   *      分布。间隔算的是同一话题两次**新建行**之间——标题命中走并入的那次不在这里
   *      （并入正是冷却要做的事，已经做到了）。
   *   dup 内容哈希：`json_extract(metadata,'$.dup.memory_id')` 非空即「这条新行的内容
   *      与某条既有行归一化后逐字节相同」；`$.dup.archived` 区分命中那条在活区还是
   *      归档区——归档区命中就是去重候选集漏掉的那一类穿透。
   *   deny 第 1 级命中：#254 验收第 2 条要的「被拒的写入可解释、不静默丢弃」就落在
   *      这一项。三个键分工——`$.deny.reason` 是稳定判据键（blank / noise / sensitive），
   *      `$.deny.kind` 是密钥/PII 的子类，`$.deny.enforced` 区分「真拦下了」与「仅告警」。
   *      enforced=false 时这一行同时也是一个正常的 g1 行（写入确实发生了）。
   * 计量绝不影响写入：任何异常只 warn。
   * @returns {object[]} 落下的审计行（无测量点或失败时为空数组）
   */
  function record({ sessionKey, verdict, memoryId } = {}) {
    if (!verdict) return [];
    // #663：系统写入没有 gate（不进预算），但**被拒**是一次真实的丢弃，必须留行——
    // 否则三条系统出口的拒绝就是静默的，正与验收第 2 条相反。放行档不落行：没有
    // 会话基准的计量行读不出任何分布，只会把审计表撑大（同 llmAudit 保留期纪律）。
    if (!verdict.deny && (!sessionKey || verdict.gate == null)) return [];
    const at = now();
    const topics = Array.isArray(verdict.topics) ? verdict.topics : [];
    const enforced = verdict.decision === ADMISSION_DECISION_DENY;
    const rows = [];
    try {
      rows.push(store.saveLlmAudit({
        timestamp: new Date(at).toISOString(),
        trigger_source: ADMISSION_TRIGGER_SOURCE,
        operation_type: ADMISSION_OPERATION_TYPE,
        // 不是模型调用，但该列 NOT NULL——用显式占位串，免得被当成某条路由的
        // 花费来源统计进去。
        model_id: "-",
        status: "skipped",
        related_memory_ids: memoryId ? [memoryId] : [],
        session_key: sessionKey,
        metadata: {
          gate: verdict.gate,
          topics,
          ...(verdict.exempt ? { exempt: verdict.exempt } : {}),
          ...(verdict.repeat ? { g2: { topic: verdict.repeat.topic, gap_ms: verdict.repeat.gapMs } } : {}),
          // dup 两个出口分字段落盘：archived 与 forgotten 是两类不同的穿透，合成一个布尔
          // 会让「只剩遗忘行命中」读起来像「库里有活跃重复」（见 lookupContentDup 注释）。
          ...(verdict.dup
            ? { dup: {
              memory_id: verdict.dup.memory_id,
              archived: verdict.dup.archived === true,
              forgotten: verdict.dup.forgotten === true
            } }
            : {}),
          // enforced 由 decision 推出而不是另存一个入参：两者若各存一份，将来就会出现
          // 「decision=deny 但 enforced=false」这种自相矛盾的行。
          //
          // decision 只在真有拒绝面时落盘：两个开关都关时，这条 metadata 必须与只计量
          // 那一阶段逐字节一致（#254 验收第 1 条）。没有 deny 的行本来就默认是放行，
          // 写一个恒为 "allow" 的键只是把「默认路径零行为变化」变成需要解释的事。
          // 读法：有 deny 才有 decision，deny 非空且 decision=allow 就是仅告警档。
          ...(verdict.deny
            ? {
              decision: verdict.decision,
              deny: {
                reason: verdict.deny.reason,
                ...(verdict.deny.kind !== undefined ? { kind: verdict.deny.kind } : {}),
                ...(verdict.deny.label !== undefined ? { label: verdict.deny.label } : {}),
                enforced
              }
            }
            : {})
        }
      }));
    } catch (e) {
      // 审计失败只 warn（同 saveLlmAudit 的调用惯例），写入本身照常完成。
      warn(`[dsh-mneme] write admission audit failed: ${String(e)}`);
    }
    // 只有真正落库、且不是穿透口的行才推进话题表：审计写失败时内存视图不能跑在审计
    // 前面（重启回填会得到另一条时间线），pinned 写入整个不在闸门里。被拦下的写入
    // 同样不推进——它没进库，成为下一次 g2 的基准就会造出一条不存在的时间线。
    // 仅告警档（deny 非空但 decision=allow）**要**推进：那条行确实落库了。
    // 系统写入（无 sessionKey）没有话题表可用，跳过这一步即可。
    if (sessionKey && rows.length > 0 && !verdict.exempt && !enforced) {
      const table = topicTable(sessionKey);
      for (const topic of topics) table.set(topic, at);
    }
    return rows;
  }

  return { evaluate, record };
}
