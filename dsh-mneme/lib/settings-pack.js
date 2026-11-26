// 设置快照（#778）：把「人格卡 + 相关开关 + 规则」打成一小段可复制的 JSON，
// 在另一台机器上粘贴回来。
//
// 为什么需要这个东西：这三块配置本来就各有一条 REST 口（/persona、/features、
// /rules），但没有一条能把它们一起搬走。用户实际遇到的是「两台机器各跑一份
// DSH，想把人格搬过去」——现在只能去读 memory.db 的 user_settings、手拼 PUT、
// 或者在面板里逐字段抄。搬运的痛点在「一次搬全 + 搬错能看见」，不在读写能力。
//
// 三条纪律（都是这个仓库踩过的）：
//
// 1. **干跑与真写共用同一份计划**。计划（planSettingsPack）是纯函数，只读不写；
//    applySettingsPack 收的就是那份计划里的东西。分成两套实现，迟早出现「预览说
//    会改三处，实际改了四处」——面板预览比注入乐观是这个仓库的老病（#606）。
//
// 2. **对不上的卡不能静默丢**。byAgent 的键是宿主的 agentPreset（DS Bot 这类宿主
//    会把它写成常量，实测 43/50 都是 "standard"），bySession 的键是本机会话 id
//    ——两者跨机器几乎必然不命中。导入时把它们**照原样写进去也行**（下次同名的
//    会话/身份出现就自动生效），但必须让用户看见「这几张卡在这台机器上现在谁也
//    对不上」。所以计划里给每张卡标 unmatched，面板据此提示，是否保留由用户选。
//
// 3. **只搬配置，不搬记忆**。白名单在这里，不在调用方：persona 走 PERSONA_FIELDS
//    （settings.js 那份，写入面用什么这里就用什么），开关走 FEATURE_FLAG_SPEC
//    白名单，规则只收字符串数组。任何凭据（apiToken 之类）不在任何一张表里，
//    所以结构上就进不了包——不是靠「记得过滤掉」。
import { FEATURE_FLAG_SPEC, PERSONA_FIELDS, parsePersona, parsePersonaStore } from "./settings.js";

/** 包的格式标记。导入时只做「看见了但不匹配就拒」的软校验，不要求外部工具写它。 */
const PACK_KIND = "mneme-settings-pack";
const PACK_VERSION = 1;

/** 包顶层允许出现的段。别的一律忽略并在 warnings 里点名，不静默吃下。 */
const SECTIONS = ["persona", "featureFlags", "rules"];

/**
 * 与人格/注入相关的开关清单（#778 的「可勾选项」）。
 *
 * 为什么不是全部开关：这张包是「搬人格」用的，把 60 个开关一起搬过去等于把一台
 * 机器的调参习惯覆盖到另一台上——那不是这个 issue 要的。这里只收「人格段会读到
 * 的」那几类：人格自身、注入面、画像面。要搬全部开关是另一件事（#666 统一导出）。
 *
 * 取的是 FEATURE_FLAG_SPEC 里的真实键名（不是手写字符串），拼错会在启动时
 * 直接 undefined —— 所以下面用 filter 校验一遍，见 assertKnownFlags。
 */
const PERSONA_FLAG_KEYS = [
  // 人格段本体
  "personaEnabled",
  "personaStrictAddressing",
  // 注入面（人格块与记忆块在同一次注入里渲染，搬人格不改注入开关等于只搬了一半）
  "autoInject",
  "injectTimePrefix",
  "injectUncertaintyAdaptive",
  "injectGuidanceEnabled",
  "selectiveInjectEnabled",
  "hybridInject",
  "injectContentMaxChars",
  "pinnedInjectBudget",
  "injectRotationTurns",
  // 画像面（「Agent 眼中的你」是人格的补充读物）
  "profileExtractEnabled",
  "profileFactsEnabled",
  "profileDigestEnabled"
];

/** 白名单自检：任何拼错/被删掉的键都该在开发期就炸，而不是面板上少一格。 */
function knownFlagKeys() {
  const all = new Set([
    ...FEATURE_FLAG_SPEC.booleans,
    ...Object.keys(FEATURE_FLAG_SPEC.ints),
    ...Object.keys(FEATURE_FLAG_SPEC.numbers),
    ...FEATURE_FLAG_SPEC.strings,
    ...FEATURE_FLAG_SPEC.urls,
    ...Object.keys(FEATURE_FLAG_SPEC.enums)
  ]);
  const missing = PERSONA_FLAG_KEYS.filter((key) => !all.has(key));
  if (missing.length) {
    throw new Error(`settings-pack: unknown feature flag key(s): ${missing.join(", ")}`);
  }
  return PERSONA_FLAG_KEYS;
}

/** 一个值是否「算是空的」——空卡（只有 provenance 之类）不该被当成一张卡。 */
function cardIsEmpty(card) {
  if (!card || typeof card !== "object") return true;
  return !PERSONA_FIELDS.some((key) => {
    const value = card[key];
    if (value === undefined) return false;
    if (typeof value === "string") return value.trim() !== "";
    return true;
  });
}

/** 两张卡逐字段比，返回变化了的字段名（只比白名单字段）。 */
function changedFields(before, after) {
  const out = [];
  for (const key of PERSONA_FIELDS) {
    if (!Object.is(before?.[key], after?.[key])) out.push(key);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/**
 * 把当前配置打成包。include 决定带哪几段（面板上的勾选项）。
 * 缺省三段全带——「一次搬全」是这个 issue 的主诉求，默认少带一段就得多问一轮。
 */
export function buildSettingsPack({ settings, include, effectiveFlags = null } = {}) {
  const want = (name) => !include || include[name] !== false;
  const pack = { kind: PACK_KIND, version: PACK_VERSION, createdAt: new Date().toISOString() };

  if (want("persona")) {
    const store = settings.getPersona();
    pack.persona = {
      default: store.default ?? {},
      byAgent: store.byAgent ?? {},
      bySession: store.bySession ?? {}
    };
  }
  if (want("featureFlags")) {
    // 导出取**生效值**（overrides 压过 cfg 之后的那份）而不是只看 overrides：对方
    // 机器上的默认值可能与本机不同，只搬 overrides 会让「本机开着、对方默认也开着」
    // 的键在对方那里悄悄变回去。代价是包会大一圈，换来的是搬过去就对得上。
    //
    // effectiveFlags 由调用方（api.js 的 featureSnapshot）算好传进来——cfg 只在
    // 那一层可达，本模块不碰 config，这样它仍然是纯函数、可单测。
    const flags = {};
    const source = effectiveFlags ?? settings.getFeatureFlags();
    for (const key of knownFlagKeys()) {
      const value = source?.[key];
      if (value !== undefined && value !== null) flags[key] = value;
    }
    pack.featureFlags = flags;
  }
  if (want("rules")) {
    pack.rules = settings.getRules();
  }
  return pack;
}

// ---------------------------------------------------------------------------
// 解析（外部粘贴进来的包）
// ---------------------------------------------------------------------------

/**
 * 校验并规整一个外来包。返回 { ok, pack, warnings } 或 { ok:false, error }。
 *
 * 宽容之处：不带 kind/version 也收（用户可能手写/从文档抄的），缺段也收（只搬
 * 人格不带规则是合法的）。严格之处：任何一段存在但形状不对就整包拒——「半个包
 * 悄悄写进去」比「什么都不写」更难收拾。
 */
export function parseSettingsPack(raw) {
  const warnings = [];
  let input = raw;
  if (typeof raw === "string") {
    try {
      input = JSON.parse(raw);
    } catch {
      return { ok: false, error: "invalid-json" };
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "invalid-pack" };
  }
  if (input.kind !== undefined && input.kind !== PACK_KIND) {
    return { ok: false, error: "wrong-kind" };
  }
  if (input.version !== undefined && input.version !== PACK_VERSION) {
    // 未来版本可能改形状：认不出来就明说，别猜着写。
    return { ok: false, error: "unsupported-version" };
  }

  const pack = { kind: PACK_KIND, version: PACK_VERSION };
  let sections = 0;

  if (input.persona !== undefined) {
    const p = input.persona;
    if (!p || typeof p !== "object" || Array.isArray(p)) return { ok: false, error: "invalid-persona" };
    // 单卡形（v1 老包/手写）也收：整体当 default。
    const looksMulti = "default" in p || "byAgent" in p || "bySession" in p;
    const store = parsePersonaStore(JSON.stringify(looksMulti ? p : { default: p }));
    pack.persona = store;
    sections += 1;
  }

  if (input.featureFlags !== undefined) {
    const f = input.featureFlags;
    if (!f || typeof f !== "object" || Array.isArray(f)) return { ok: false, error: "invalid-feature-flags" };
    // 只留本包负责的那批键；包里有别的开关不算错，但要告诉用户「这些没搬」。
    const allowed = new Set(knownFlagKeys());
    const flags = {};
    const skipped = [];
    for (const [key, value] of Object.entries(f)) {
      if (allowed.has(key)) flags[key] = value;
      else skipped.push(key);
    }
    if (skipped.length) warnings.push({ code: "flags-out-of-scope", keys: skipped });
    pack.featureFlags = flags;
    sections += 1;
  }

  if (input.rules !== undefined) {
    if (!Array.isArray(input.rules)) return { ok: false, error: "invalid-rules" };
    const rules = input.rules.filter((r) => typeof r === "string");
    if (rules.length !== input.rules.length) warnings.push({ code: "rules-dropped-non-strings" });
    pack.rules = rules;
    sections += 1;
  }

  if (!sections) return { ok: false, error: "empty-pack" };

  const unknown = Object.keys(input).filter(
    (key) => !SECTIONS.includes(key) && !["kind", "version", "createdAt"].includes(key)
  );
  if (unknown.length) warnings.push({ code: "unknown-sections", keys: unknown });

  return { ok: true, pack, warnings };
}

// ---------------------------------------------------------------------------
// 干跑计划（纯函数，不写库）
// ---------------------------------------------------------------------------

/**
 * 算出「如果现在导入，会改什么」。返回值是给人看的，也是 apply 的唯一输入。
 *
 * knownAgents：本机真会命中的身份名（api.js 的 agentBySession 值 ∪ diary.knownAgents()）。
 * 传 null 表示「不知道」——此时不标 unmatched，也不下结论，面板只能说「无法判断」。
 */
export function planSettingsPack({ settings, pack, knownAgents = null, effectiveFlags = null } = {}) {
  const plan = { sections: {}, warnings: [] };
  const known = knownAgents ? new Set(knownAgents) : null;

  if (pack.persona) {
    const current = settings.getPersona();
    const nextStore = pack.persona;

    const defaultChanged = changedFields(current.default, nextStore.default);
    const byAgent = { add: [], replace: [], unchanged: [], unmatched: [] };
    for (const [agentId, card] of Object.entries(nextStore.byAgent ?? {})) {
      const before = current.byAgent?.[agentId];
      if (!before) byAgent.add.push(agentId);
      else if (changedFields(before, card).length) byAgent.replace.push(agentId);
      else byAgent.unchanged.push(agentId);
      if (known && !known.has(agentId)) byAgent.unmatched.push(agentId);
    }
    const bySession = { add: [], replace: [], unchanged: [] };
    for (const [sessionId, card] of Object.entries(nextStore.bySession ?? {})) {
      const before = current.bySession?.[sessionId];
      if (!before) bySession.add.push(sessionId);
      else if (changedFields(before, card).length) bySession.replace.push(sessionId);
      else bySession.unchanged.push(sessionId);
    }
    // 包里没有、本机有的卡：导入是「合并」还是「替换」？这里选合并（只写包里有的），
    // 因为「搬一张卡过来」不该顺手删掉本机原有的人格。要删除请走面板的删卡。
    const kept = Object.keys(current.byAgent ?? {}).filter((id) => !(id in (nextStore.byAgent ?? {})));

    plan.sections.persona = {
      default: { action: defaultChanged.length ? "replace" : "unchanged", changedFields: defaultChanged },
      byAgent,
      bySession,
      keptLocal: { byAgent: kept },
      dropUnmatched: byAgent.unmatched.slice()
    };
    if (byAgent.unmatched.length) {
      plan.warnings.push({ code: "persona-unmatched-agents", keys: byAgent.unmatched });
    }
    if (bySession.add.length || bySession.replace.length) {
      plan.warnings.push({ code: "persona-session-cards", keys: [...bySession.add, ...bySession.replace] });
    }
  }

  if (pack.featureFlags) {
    const { ok: accepted, rejected } = settings.validateFeatureFlags(pack.featureFlags);
    // 比的是**生效值**不是 overrides：对方默认已经等于包里这个值，就不必再写一条
    // 覆盖。少写一条覆盖 = 少一处将来会漂的持久状态（本机默认改了，对方还钉着旧值）。
    const currentEffective = effectiveFlags ?? { ...settings.getFeatureFlags() };
    const keys = [];
    for (const [key, value] of Object.entries(accepted)) {
      const before = currentEffective[key];
      keys.push({
        key,
        from: before === undefined ? null : before,
        to: value,
        action: Object.is(before, value) ? "same" : "change"
      });
    }
    plan.sections.featureFlags = { keys, rejected };
    for (const bad of rejected) plan.warnings.push({ code: "flag-rejected", key: bad.key, reason: bad.reason });
  }

  if (pack.rules) {
    const current = settings.getRules();
    const next = pack.rules;
    const same = current.length === next.length && current.every((rule, i) => rule === next[i]);
    plan.sections.rules = {
      action: same ? "unchanged" : "replace",
      from: current.length,
      to: next.length,
      added: next.filter((rule) => !current.includes(rule)),
      removed: current.filter((rule) => !next.includes(rule))
    };
  }

  return plan;
}

/** 计划里是否真的有事要做——面板据此决定「确认导入」按钮是否可点。 */
export function planHasChanges(plan) {
  const p = plan?.sections ?? {};
  if (p.persona) {
    if (p.persona.default?.action !== "unchanged") return true;
    const a = p.persona.byAgent ?? {};
    const s = p.persona.bySession ?? {};
    if ((a.add?.length ?? 0) + (a.replace?.length ?? 0)) return true;
    if ((s.add?.length ?? 0) + (s.replace?.length ?? 0)) return true;
  }
  if (p.featureFlags?.keys?.some((k) => k.action === "change")) return true;
  if (p.rules?.action === "replace") return true;
  return false;
}

// ---------------------------------------------------------------------------
// 落库
// ---------------------------------------------------------------------------

/**
 * 按计划写库。**只写计划里判过的那几处**，不做「拿包整体覆盖」。
 *
 * 为什么不让调用方直接 setPersona(pack.persona)：那会把本机独有的 byAgent 卡整片
 * 抹掉（setPersona 的多数形是全量替换）。这里的口径是**合并**：包里有的键逐格写、
 * 包里没有的键原样留着。想删卡请走面板。
 *
 * dropUnmatched：用户选了「只保留能对上的卡」时传 true，包里对不上任何身份的
 * byAgent 卡就不写进去。缺省 false（保留但不生效，比悄悄丢掉可逆）。
 */
export function applySettingsPack({ settings, pack, dropUnmatched = false, knownAgents = null, effectiveFlags = null } = {}) {
  const applied = { persona: false, featureFlags: false, rules: false };
  const known = knownAgents ? new Set(knownAgents) : null;

  if (pack.persona) {
    const current = settings.getPersona();
    const next = {
      default: pack.persona.default ?? current.default,
      byAgent: { ...current.byAgent },
      bySession: { ...current.bySession }
    };
    for (const [agentId, card] of Object.entries(pack.persona.byAgent ?? {})) {
      if (dropUnmatched && known && !known.has(agentId)) continue;
      next.byAgent[agentId] = card;
    }
    for (const [sessionId, card] of Object.entries(pack.persona.bySession ?? {})) {
      next.bySession[sessionId] = card;
    }
    settings.setPersona(next);
    applied.persona = true;
  }

  if (pack.featureFlags) {
    // 只写「真的会变」的键：生效值已经等于包里的值就不落覆盖。被拒的键不进库，
    // 理由已经在计划里给过。
    const { ok: accepted } = settings.validateFeatureFlags(pack.featureFlags);
    const currentEffective = effectiveFlags ?? { ...settings.getFeatureFlags() };
    const changes = {};
    for (const [key, value] of Object.entries(accepted)) {
      if (!Object.is(currentEffective[key], value)) changes[key] = value;
    }
    if (Object.keys(changes).length) {
      settings.setFeatureFlags(changes);
      applied.featureFlags = true;
    }
  }

  if (pack.rules) {
    settings.setRules(pack.rules);
    applied.rules = true;
  }

  return applied;
}

export const SETTINGS_PACK_FLAG_KEYS = PERSONA_FLAG_KEYS;
export { PACK_KIND, PACK_VERSION };
