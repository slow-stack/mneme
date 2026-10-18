// issue #471：政策轴（作用域级可逆闸门）。
//
// 与事实轴（src/scope.js 的 agent_scope / workspace_scope 标注）的分野：
//   事实轴回答「这条记忆属于谁」——持久，跟着记忆行走（strictScope 那道可见性硬墙、
//   scope_changes 那份人工修正审计都长在这条轴上）。
//   政策轴回答「这个作用域现在通不通」——暂时，由人单方面按下、松开即恢复，存在运行
//   期表 scope_state 里（建表注释见 src/store.js），不改任何记忆行、不改任何配置键、
//   不重启。
//
// 为什么单独一个模块：判定要与存储能各自被检验。本模块不 import store.js——它只接
// 收一个「读状态行」的函数，于是 test 可以直接构造暂停集合、不必开库（与
// write-admission.js 把判据实现与存储解耦同款）。存储读写留在 store.js。
//
// 依赖方向是单向的：store.js import 本模块的三个 normalizeScopeState*（落库前把
// 维度/值/状态归一到可解释的枚举），本模块 import scope.js 的 scopeKeyOf；scope.js
// 不 import 任何本包模块，所以不成环。归一化与判定同处一个文件是刻意的——两者共享
// 同一套枚举常量（SCOPE_STATE_DIMENSIONS / _VALUES / _ALL），分开写会让「写入侧认的
// 值」与「判定侧认的值」有机会各自漂移，那正是本仓 gateByScope 注释里记着的坑。
//
// 为什么判定只写一份：src/service.js 的 gateByScope 注释已写明「过滤点漂移」是本仓
// 真实踩过的坑——`entity:` 与 `attr:` 两条前缀路曾在入口就 return，整条绕过硬墙。
// 政策轴照同一纪律办：判定收在本模块，service 侧只挂在既有出口上。
//
// 两级开关（与 src/write-admission.js:11 同口径）：
//   enabled 打开时：被按下的作用域其候选照常注入，但留一条审计行说清「本应被拦下」；
//   enforce 打开时：真的不注入。
// 先看「如果按下会少掉多少」，再决定要不要真按——writeAdmission 与 preInjectGate
// 都是这么分两次上线的。两个开关都默认关时本模块的判定恒为「通」，service 侧拿到的
// 是原数组本身（不是等值副本），行为与改动前逐字段一致。
import { scopeKeyOf } from "./scope.js";

// 审计口径（llm_audit_logs 的既有列）：trigger_source = 组件名，operation_type =
// 动作名，status='skipped' = 本行没有产生任何 LLM 花费（与 summarize 的间隔门、
// 尖峰门、writeAdmission 同款读法）。
export const SCOPE_STATE_TRIGGER_SOURCE = "scopeState";
export const SCOPE_STATE_OPERATION_TYPE = "scope_state_gate";

// 作用域维度。刻意只取本仓已有的两维，不照搬 dsh-domain-role 的四级作用域——它的
// project 级存在一个已知缺口（其 docs/06-limitations.md 的 B1：「项目级暂停不读会话
// 存档 ⇒ 判不出就不拦」），而本仓的 agent_scope / workspace_scope 都是确定值，不存在
// 「判不出归属」的情况。
export const SCOPE_STATE_DIMENSIONS = ["agent", "workspace"];

// 状态两值。active 是「松开」，paused 是「按下」——写成显式两值而不是「有行=按下」，
// 是为了让回执能如实报出「这一路现在是通的」，而不是让「没有行」同时承担「从未按过」
// 与「按过又松开了」两种意思。
export const SCOPE_STATE_VALUES = ["active", "paused"];

// 该维度全局（不针对某个具体标签）。注意它只命中「在这一维上有标注」的记忆：未标注
// 的行（scopeKeyOf 为 null）在该维度上不属于任何一路，全局按下也不该把它们卷进来
// ——它们对谁都可见，不是「这一路」。
export const SCOPE_STATE_ALL = "*";

/**
 * 维度归一化。脏输入返回 null 由调用方拒绝（写入侧）或忽略（读取侧）。
 * @param {unknown} raw
 * @returns {"agent"|"workspace"|null}
 */
export function normalizeScopeStateDimension(raw) {
  return SCOPE_STATE_DIMENSIONS.includes(raw) ? raw : null;
}

/**
 * 作用域值归一化。与 scopeKeyOf 同款口径（非空 trim 字符串），额外的只有 '*'
 * 这个哨兵值。空白/非字符串落 null——不做 trim 后回退，因为「按下空字符串」不是
 * 一个可解释的意图（不像 resolveWriteScope 那样有「取不到就放宽」的正当理由）。
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeScopeStateValue(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  return s === SCOPE_STATE_ALL ? SCOPE_STATE_ALL : s;
}

/**
 * 状态归一化。
 * @param {unknown} raw
 * @returns {"active"|"paused"|null}
 */
export function normalizeScopeStateState(raw) {
  return SCOPE_STATE_VALUES.includes(raw) ? raw : null;
}

// 共享的空索引。enabled 关或表为空时返回它，让调用方的 `index.any` 短路检查是
// 一次属性读取而不是一次分配。
export const EMPTY_PAUSED_INDEX = Object.freeze({
  byDimension: Object.freeze({ agent: new Set(), workspace: new Set() }),
  any: false
});

/**
 * 把状态行编成查找索引。只收 state='paused' 的行——active 行是「松开」的留痕，
 * 不参与判定（保留它们是为了回执能报「你上次是松开的」，不是为了拦东西）。
 *
 * 为什么只保留一个维度→值的集合而不保留行本身：判定只需要「这个值在不在集合里」，
 * 行上的 note/decided_at 是给人回看用的，不是判定输入。多留一份会让索引与表之间
 * 出现第二份需要同步的状态。
 *
 * @param {Array<{dimension?: string, scope_value?: string, state?: string}>} rows
 * @returns {{byDimension: {agent: Set<string>, workspace: Set<string>}, any: boolean}}
 */
export function buildPausedIndex(rows) {
  const byDimension = { agent: new Set(), workspace: new Set() };
  let any = false;
  for (const row of rows ?? []) {
    if (!row || row.state !== "paused") continue;
    const dimension = normalizeScopeStateDimension(row.dimension);
    if (!dimension) continue;
    const value = normalizeScopeStateValue(row.scope_value);
    if (!value) continue;
    byDimension[dimension].add(value);
    any = true;
  }
  return any ? { byDimension, any } : EMPTY_PAUSED_INDEX;
}

/**
 * 一行记忆命中了哪些暂停作用域。返回命中明细（而不是布尔）是为了审计行能说清
 * 「是被哪一路拦下的」——只留一个布尔，日后回看只知道「少了」，不知道为什么少。
 *
 * 比较用 scopeKeyOf（与去重键、检索加权共用同一把钥匙）：未标注行在该维度上不
 * 参与比较，于是「按下 workspace=X」不会波及未标注的全局记忆。
 *
 * @param {object} m 记忆行
 * @param {{byDimension: object, any: boolean}} index
 * @returns {Array<{dimension: string, scope_value: string}>}
 */
export function matchPausedScopes(m, index) {
  if (!index || index.any !== true) return [];
  const hits = [];
  for (const dimension of SCOPE_STATE_DIMENSIONS) {
    const paused = index.byDimension[dimension];
    if (!paused || paused.size === 0) continue;
    const label = scopeKeyOf(dimension === "agent" ? m?.agent_scope : m?.workspace_scope);
    if (label === null) continue;
    if (paused.has(label)) hits.push({ dimension, scope_value: label });
    // 全局按下排在具体值之后：两者同时命中时，报具体值比报 '*' 更有信息量
    // （'*' 是「所有这一维的行」，具体值才是「就是这一路」）。
    else if (paused.has(SCOPE_STATE_ALL)) hits.push({ dimension, scope_value: SCOPE_STATE_ALL });
  }
  return hits;
}

/**
 * 命中的暂停作用域去重（审计行的 metadata.paused）。
 * @param {Array<object>} rows
 * @param {{byDimension: object, any: boolean}} index
 * @returns {Array<{dimension: string, scope_value: string}>}
 */
export function distinctPausedScopes(rows, index) {
  const seen = new Map();
  for (const m of rows ?? []) {
    for (const hit of matchPausedScopes(m, index)) {
      seen.set(`${hit.dimension}\u0000${hit.scope_value}`, hit);
    }
  }
  return [...seen.values()];
}

/**
 * 政策轴闸门。判定无状态（每次现读一次状态表），因为表恒小（行数 = 被人按过的
 * 作用域个数，个位数），而缓存会引入一套失效协议——面板或另一个进程改了状态后，
 * 缓存要能立刻知道，那需要 IPC 或轮询；用一次小表读换掉整类「缓存过期」缺陷。
 *
 * @param {object} deps
 * @param {() => Array<object>} [deps.listStates] 读状态行（store.listScopeStates）
 * @param {(entry: object) => void} [deps.saveAudit] 写审计行（store.saveLlmAudit）
 * @param {object} [deps.config] 已解析配置（读 scopeState.enabled / scopeState.enforce）
 * @param {object} [deps.logger]
 */
export function createScopeStateGate({ listStates, saveAudit, config, logger } = {}) {
  let warned = false;
  const warn = (msg) => {
    if (warned) return;
    warned = true;
    try {
      logger?.warn?.(msg);
    } catch {
      // logger 自身故障不能影响检索路径——闸门坏掉时宁可放行（fail-open），
      // 与 scope.js「解析失败绝不阻塞写入」同一哲学：政策轴是加在读取侧的一道
      // 便利闸门，不是安全边界（安全边界是 strictScope 那道事实轴硬墙）。
    }
  };

  const enabled = () => config?.scopeState?.enabled === true;
  const enforce = () => config?.scopeState?.enforce === true;

  /**
   * 当前暂停索引。开关关、读失败、表为空都返回同一个空索引——三种情况下判定
   * 都是「通」，调用方不需要区分。
   */
  function index() {
    if (!enabled()) return EMPTY_PAUSED_INDEX;
    try {
      return buildPausedIndex(typeof listStates === "function" ? listStates() : []);
    } catch (e) {
      warn(`[dsh-mneme] scope-state gate: state read failed, gate is inert this call (${e?.message ?? e})`);
      return EMPTY_PAUSED_INDEX;
    }
  }

  /**
   * 检索侧的过滤出口。**只在 enforce 档动手**——enabled 单开时这一侧不过滤，
   * 与注入侧同一条两级语义（观察档不拦任何东西）。
   *
   * 开关关、观察档、没有暂停行时返回**原数组本身**（不是等值副本）——「默认路径
   * 零行为变化」这条验收要靠引用相等来钉死，副本会让它退化成「内容看起来一样」。
   *
   * 这一侧不写审计行：审计的口径是「本应被拦下的注入候选有多少」，只有注入路径
   * 才知道这件事。检索是工具与面板主动问的，把每次问答都记一行只会让审计表按
   * 查询频次增长，而查到的读数并不回答「按下会少掉多少」。
   */
  function filter(rows) {
    const idx = index();
    if (!idx.any || !enforce() || !Array.isArray(rows) || rows.length === 0) return rows;
    return rows.filter((m) => matchPausedScopes(m, idx).length === 0);
  }

  /**
   * 注入面的闸门。返回过滤后的候选与「本应被拦下」的明细。
   *
   * enforce 关（观察档）时**不过滤**，但留一条审计行——这正是两级开关的意义：
   * 先在真实流量里看「如果按下会少掉多少」，再决定要不要真按。审计写失败只 warn
   * （同 saveLlmAudit 的调用惯例），注入本身照常完成。
   *
   * @param {Array<object>} rows 注入候选（图召回合并之后、pin 池之前）
   * @returns {{rows: Array<object>, gated: Array<object>, enforced: boolean}}
   */
  function gateInjection(rows) {
    const idx = index();
    if (!idx.any || !Array.isArray(rows) || rows.length === 0) {
      return { rows, gated: [], enforced: false };
    }
    const gated = rows.filter((m) => matchPausedScopes(m, idx).length > 0);
    if (gated.length === 0) return { rows, gated: [], enforced: false };
    const enforced = enforce();
    record(idx, gated, enforced);
    return {
      rows: enforced ? rows.filter((m) => matchPausedScopes(m, idx).length === 0) : rows,
      gated,
      enforced
    };
  }

  function record(idx, gated, enforced) {
    if (typeof saveAudit !== "function") return;
    // llmAudit 关时一行都不写：那个开关同时关掉审计行的启动期清理
    // （index.js 的 deleteOldLlmAudits），在无保留期的表里按调用频次增长是不对的
    // （与 write-admission.js 的同一条理由）。
    if (config?.llmAudit?.enabled === false) return;
    try {
      saveAudit({
        trigger_source: SCOPE_STATE_TRIGGER_SOURCE,
        operation_type: SCOPE_STATE_OPERATION_TYPE,
        // 不是模型调用，但该列 NOT NULL——用显式占位串，免得被当成某条路由的
        // 花费来源统计进去（同 write-admission.js）。
        model_id: "-",
        status: "skipped",
        related_memory_ids: gated.map((m) => m?.id).filter(Boolean),
        metadata: {
          gate: "scopeState",
          paused: distinctPausedScopes(gated, idx),
          gated: gated.length,
          // enforced 由开关推出而不是另存一个入参：两者各存一份就会出现
          // 「闸门动手了但行上写着 false」这种自相矛盾的记录。
          enforced
        }
      });
    } catch (e) {
      warn(`[dsh-mneme] scope-state audit write failed (never blocks injection): ${e?.message ?? e}`);
    }
  }

  return { enabled, enforce, index, filter, gateInjection };
}
