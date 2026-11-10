// local-mneme-panel — a dsh-go native panel over the installed dsh-mneme store.
//
// The panel never talks HTTP: src/dsh-go/host.js dispatches mneme's own registered
// route handlers inside this engine process. Reads are mneme's own GET routes;
// writes go through mneme's own routes (create/update/delete/features/profile/
// rules/mode/conflicts/commands/vector/external/reclaim), so its apiToken policy
// still applies if one is ever set.
import { createHostCall } from "./host.js";
import { buildView } from "./views/root.js";
import {
  FLAG_LABELS,
  RANGE_DAYS,
  TYPE_LABELS,
  clip,
  errorText,
  flagAction,
  fmtDay,
  fmtMonth,
  fmtTime,
  joinTags,
  scopeText,
  splitTags,
  entityIcon,
  entityTypeLabel,
  typeIcon,
  typeLabel,
  typeTone,
} from "./text.js";

const PAGE_SIZE = 20;
const cache = new Map();
// Live panel feeds, one emit per open panel/locale. dsh-go feeds are push-based:
// data() runs once and later state changes must be pushed through these emits
// (a `refresh` effect only re-renders the view; it never re-runs data()).
const emitters = new Set();
// 每个面板 scope 打开过哪条记忆。删除确认（confirm 节点）不携带任何参数，
// 只能靠状态决定删谁；状态又是所有面板共用的，所以按 scope 记一份，删除前
// 与本面板打开的那条核对，不匹配就拒绝（评审 #5）。
const openedBy = new Map();
// 冲突页的裁决同样改数据，而 state.conflictId 是模块级共享的：两个面板
// 各看一条冲突时，后开的会盖掉前一个的 id。按面板 scope 记一份再核对
// （评审 #3 的 conflict-win 部分）。
const conflictBy = new Map();
// 「Agent 眼中的你」的编辑态 state.factEdit 同样是共享的；按面板 scope 记
// 一份打开的事实 id，保存与归档前核对（评审 #3 的 facts 部分）。
const factBy = new Map();
// 上一次推给 App 的完整数据：未重新读取的块从这里并回去，保证每份 data 都
// 带着全部绑定键（见 load 的注释）。
let lastPayload = null;
const scopeKey = (scope) => [scope?.sessionId ?? "", scope?.turnId ?? "", scope?.callId ?? ""].join("|");

const defaultState = () => ({
  page: "list", // list|detail|editor|entity|conflict|settings|profile
  flagGroup: "basic",
  extraRows: [], // 上游新增、面板还没中文名的布尔旗标
  factsCards: [],
  factsAgent: "",
  factsRows: [],
  factsItems: [],
  factEdit: null,
  factsRunText: "",
  choroRepos: [],
  choroRepo: "",
  choroRows: [],
  choroNote: "",
  choroPageText: "",
  settingsView: "settings", // settings|status
  sPanel: "menu", // menu|workbench|commands|vector|external|help|facts|choro
  profileTab: "profile",
  q: "",
  type: "all",
  range: "all",
  minImportance: 0,
  scope: "all",
  semantic: false,
  viewMode: "flat",
  heatSort: false,
  filtersOpen: false,
  offset: 0,
  size: PAGE_SIZE,
  current: null,
  form: {},
  // 编辑页打开时的那份快照：只有和它不同的字段才会写回 /update，
  // 并且用它挡住「别处已经改过这条记忆」（评审 #4）。
  editBase: null,
  entityTotal: -1,
  entityTypeTotal: 0,
  entityQuery: "",
  entityName: "",
  entityDepth: 1,
  entityRelationCount: 0,
  entityMemoryCount: 0,
  flags: {},
  flagOverrides: {},
  pendingRestart: [],
  pendingConflicts: 0,
  pendingIds: new Set(),
  rowsCount: 0,
  total: 0, // 当前筛选下的总条数，翻页时用它算页数
  monthGroups: [],
  detailEntities: [],
  detailEntityCount: 0,
  detailConflict: false,
  provenanceText: "",
  conflictCount: 0,
  conflictId: "",
  conflictPick: "",
  conflictA: null,
  conflictB: null,
  conflictReady: false,
  wbKv: [],
  wbDeposited: [],
  wbArchived: [],
  commands: [],
  cmdCount: 0,
  sCmdPick: "",
  sCmdName: "",
  sCmdDesc: "",
  sCmdIns: "",
  vector: { enabled: false, baseUrl: "", model: "" },
  external: { enabled: false, port: 8790, host: "127.0.0.1" },
  // 读成功才允许整体写回：读失败时上面的 vector/external 会落成默认值，
  // 此时 PUT 会把用户在 Web 面板里配好的地址/端口覆盖掉（评审 #2）。
  vectorLoaded: false,
  externalLoaded: false,
  // 实体搜索要重读的是「实体清单」而不是整页；load() 按这个标记补读
  // （评审 #4）。
  entityDirty: false,
  // 顶层页签由 App 本地切换，state.page 可能还停在 "list"；设置项的动作
  // 改完数据后也要重读设置块，否则推到面板上的仍是旧值（评审 #6）。
  settingsDirty: false,
  versionNote: "",
  extractText: "",
  injectPreviewText: "",
  tokenCategories: [],
  tokenSeries: [],
  tokenKv: [],
  heatSeries: [],
  heatNote: "",
  reclaimText: "尚未检查。",
  reclaimConfirm: false,
  notice: "",
  noticeTone: "ok",
  err: "",
});

const state = defaultState();

function resetNotice() {
  state.notice = "";
  state.err = "";
}

function notice(text, tone = "ok") {
  state.notice = clip(text, 160);
  state.noticeTone = tone;
}

/** Read the resolved action arguments/values the app sends with an invoke. */
function valueOf(event, keys, fallback) {
  const value = event?.value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of keys) {
      if (value[key] !== undefined && value[key] !== null) return value[key];
    }
  }
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "boolean") return value;
  return fallback;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function rowOf(row) {
  const heat = typeof row.heat === "number" ? row.heat : Number.NaN;
  const pending = state.pendingIds.has(row.id);
  const marks = [];
  if (row.archived === true) marks.push("已归档");
  if (pending) marks.push("待确认");
  return {
    title: clip(row.title, 60),
    subtitle: `${typeLabel(row.type)} · ${fmtTime(row.updated_at ?? row.created_at)}${marks.length === 0 ? "" : ` · ${marks.join(" · ")}`}`,
    trailing: Number.isFinite(heat) ? `★${row.importance ?? 1} · 热度 ${heat.toFixed(2)}` : `★${row.importance ?? 1}`,
    ...(typeIcon(row.type) === undefined ? {} : { icon: typeIcon(row.type) }),
    tone: typeTone(row.type),
    action: { id: "open", args: { id: row.id } },
  };
}

/** Flat dotted flag keys -> nested object so `data.flags.a.b` bindings resolve. */
function nestFlags(effective) {
  const out = {};
  for (const [key, value] of Object.entries(effective ?? {})) {
    const parts = key.split(".");
    let node = out;
    for (const part of parts.slice(0, -1)) {
      if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
      node = node[part];
    }
    // 原样透传：开关是布尔，枚举型旗标（chorographyInject 的 light/full/off）
    // 是字符串。以前这里一律写成 `value === true`，下拉永远只看到 true/false。
    node[parts[parts.length - 1]] = value;
  }
  return out;
}

const enc = (value) => encodeURIComponent(String(value ?? ""));

/**
 * Mount the panel on a context that already provides the dsh-go `dshGo` service.
 * Called by src/index.js from `ctx.inject(['dshGo'], ...)`: without the dsh-go
 * bridge (desktop / headless hosts) this module never runs.
 */
export function mountDshGoPanel(ctx, options = {}) {
  // options.apiToken 由 src/index.js 传入：路由注册器给 token / token-write
  // 路由包了鉴权，进程内调用不带这个头就会被自家 API 拦成 401（评审 #2）。
  const call = createHostCall(ctx, options);

  // ---------------------------------------------------------------- loaders
  function groupByMonth(rows, raw) {
    const buckets = new Map();
    rows.forEach((row, index) => {
      const label = fmtMonth(raw[index]?.updated_at ?? raw[index]?.created_at);
      if (!buckets.has(label)) buckets.set(label, []);
      buckets.get(label).push(row);
    });
    return [...buckets.entries()].map(([label, list]) => ({ label, rows: list }));
  }

  async function loadMemory() {
    const statsPromise = call("/recall-stats?window=30").catch(() => ({}));
    const conflictsPromise = call("/conflicts").catch(() => ({}));
    const dreamPromise = call("/dream-status").catch(() => ({}));
    const payload = {
      query: state.q,
      filter: state.type,
      fRange: state.range,
      fMin: String(state.minImportance),
      fScope: state.scope,
      fSemantic: state.semantic,
      fView: state.viewMode,
      fHeat: state.heatSort,
    };
    let items = [];
    if (state.q !== "") {
      const mode = state.semantic ? "hybrid" : "auto";
      const res = await call(`/search?q=${enc(state.q)}&topK=20&mode=${mode}`);
      // /search 没有 type 参数（它是全库语义检索），类型筛选只能在拿到结果后
      // 再收一遍，否则搜索会把用户选好的类型丢掉（评审 #8）。
      const hits = res?.items ?? [];
      items = state.type === "all" || state.type === "" ? hits : hits.filter((item) => item?.type === state.type);
      payload.total = String(items.length);
      // 空结果不再靠一块 emptyState 表达：那个结构在首屏就定了，数据晚一步
      // 到达时就会和真实列表同时出现。文案跟着数据走，结构不跟着动。
      payload.pageText =
        items.length === 0
          ? "搜索无结果"
          : `搜索 · ${items.length} 条`;
    } else {
      const query = new URLSearchParams({
        limit: String(state.size),
        offset: String(state.offset),
        order: "chrono",
      });
      if (state.type !== "all" && state.type !== "") query.set("type", state.type);
      if (state.minImportance > 0) query.set("minImportance", String(state.minImportance));
      const days = RANGE_DAYS[state.range];
      if (days !== undefined) query.set("updatedFrom", new Date(Date.now() - days * 86400000).toISOString());
      if (state.scope === "deposited") query.set("deposited", "only");
      if (state.scope === "archived") query.set("archived", "only");
      if (state.scope === "foreign") query.set("source", "imported");
      const res = await call(`/list?${query.toString()}`);
      items = res?.items ?? [];
      const total = num(res?.total, items.length);
      const pages = Math.max(1, Math.ceil(total / state.size));
      const pageNo = Math.min(pages, Math.floor(state.offset / state.size) + 1);
      payload.total = String(total);
      // 这行文案同时是左胶囊的标签，列宽只有约 142dp，越长越容易折行。
      payload.pageText = total === 0 ? "没有匹配的记忆" : `${total} 条 · ${pageNo}/${pages} 页`;
    }
    for (const row of items) cache.set(row.id, row);
    const dream = await dreamPromise;
    state.pendingIds = new Set(Array.isArray(dream?.pendingMemoryIds) ? dream.pendingMemoryIds : []);
    const ordered = state.heatSort ? [...items].sort((a, b2) => num(b2.heat, -1) - num(a.heat, -1)) : items;
    payload.rows = ordered.map(rowOf);
    state.monthGroups = groupByMonth(ordered, ordered);
    const [stats, conflicts] = await Promise.all([statsPromise, conflictsPromise]);
    payload.injected = String(stats?.injection?.injectedCount ?? 0);
    payload.slotRate = String(Math.round((stats?.injection?.slotFillRate ?? 0) * 1000) / 10);
    payload.conflicts = String(conflicts?.total ?? 0);
    // metric values render in one style, so units ride along in the value
    payload.totalText = `${payload.total ?? "0"} 条`;
    payload.injectedText = `${payload.injected} 次`;
    payload.slotRateText = `${payload.slotRate}%`;
    payload.conflictsText = `${payload.conflicts} 条`;
    state.pendingConflicts = num(conflicts?.total, 0);
    payload.pendingConflicts = state.pendingConflicts;
    // 翻页用的是 chips（原生最小 48dp，两个一定同行），点完立刻把绑定清空，
    // 免得选中的那枚一直带着勾。
    payload.pagePick = "";
    state.rowsCount = (payload.rows ?? []).length;
    state.total = num(payload.total, state.rowsCount);
    return payload;
  }

  async function loadDetail() {
    const memo = state.current ?? {};
    const entities = await call(`/memories/entities?memoryId=${enc(memo.id ?? "")}`).then((res) => res?.entities ?? []);
    state.detailEntityCount = entities.length;
    state.detailConflict = state.pendingIds.has(memo.id);
    return {
      detailTitle: clip(memo.title ?? "（无标题）", 120),
      detailMeta: [
        { label: "类型", value: typeLabel(memo.type) },
        { label: "重要度", value: `★${memo.importance ?? 1}` },
        { label: "归属", value: scopeText(memo) },
        { label: "更新", value: fmtTime(memo.updated_at ?? memo.created_at) },
        { label: "标签", value: clip(joinTags(memo.tags) || "—", 40) },
        { label: "来源", value: clip(memo.source ?? "—", 40) },
        { label: "状态", value: memo.archived ? "已归档" : "正常", tone: memo.archived ? "muted" : "good" },
      ],
      detailContent: clip(memo.content ?? "", 2000),
      detailType: typeLabel(memo.type),
      detailTypeTone: typeTone(memo.type) ?? "info",
      detailStars: `重要度 ★${memo.importance ?? 1}`,
      detailEntities: entities.slice(0, 8).map((item) => ({
        title: clip(item.name ?? item.title ?? item.id ?? "—", 40),
        subtitle: clip(item.type ?? "实体", 20),
        icon: "user",
      })),
      detailEntityCount: entities.length,
      detailConflict: state.detailConflict,
      provenanceText: state.provenanceText,
    };
  }

  function loadEditor() {
    return {
      form: {
        id: state.form.id ?? "",
        title: state.form.title ?? "",
        content: state.form.content ?? "",
        type: state.form.type ?? "project",
        importance: num(state.form.importance, 3),
        tags: state.form.tags ?? "",
        agentScope: state.form.agentScope ?? "",
        workspaceScope: state.form.workspaceScope ?? "",
      },
    };
  }

  async function loadEntity() {
    const needle = state.entityQuery.trim();
    // 名字过滤交给宿主（/entities?q=）：本地过滤只能看见 limit 那一条切片，
    // 排在后面的实体搜不到（评审 #9）。类型数只在不搜索时重算——它代表整库
    // 有几种类型，不该随搜索词一起抖动。
    const [directory, matched] = await Promise.all([
      needle === "" ? null : call("/entities?limit=200").catch(() => null),
      call(`/entities?limit=${needle === "" ? 200 : 30}${needle === "" ? "" : `&q=${enc(needle)}`}`),
    ]);
    const all = directory?.entities ?? matched?.entities ?? [];
    state.entityTotal = num(matched?.total, all.length);
    if (needle === "") {
      const types = new Set();
      for (const item of all) {
        if (typeof item?.type === "string" && item.type !== "") types.add(item.type);
      }
      state.entityTypeTotal = types.size;
    }
    const shown = (needle === "" ? all : (matched?.entities ?? [])).slice(0, 30);
    return {
      entityTotal: String(state.entityTotal),
      entityTypeTotal: String(state.entityTypeTotal),
      entityTotalText: `${String(state.entityTotal)} 个`,
      entityTypeTotalText: `${String(state.entityTypeTotal)} 类`,
      entityQuery: state.entityQuery,
      // 结构固定，空库的提示走这一行文案（见 views/entity.js 的注释）。
      entityStatus:
        shown.length === 0
          ? needle === ""
            ? "还没有实体 · 在「设置 › 记忆引擎」的功能开关里打开「抽取人物与项目」"
            : `没有名字含「${clip(needle, 20)}」的实体`
          : needle === ""
            ? `共 ${String(state.entityTotal)} 个实体`
            : `搜索「${clip(needle, 20)}」· ${String(shown.length)} 个`,
      entities: shown.map((item) => ({
        title: clip(item.name ?? item.title ?? item.id ?? "—", 40),
        subtitle: clip(entityTypeLabel(item.type ?? "—"), 20),
        trailing: item.mention_count === undefined ? undefined : `${item.mention_count} 次`,
        ...(entityIcon(item.type) === undefined ? {} : { icon: entityIcon(item.type) }),
        action: { id: "open-entity", args: { name: String(item.name ?? "") } },
      })),
    };
  }

  async function loadEntityDetail() {
    const name = state.entityName;
    const ego = await call(`/semantic/graph/ego?entity=${enc(name)}&depth=${state.entityDepth}&limit=40`);
    const attrs = await call(`/semantic/graph/entity-attrs?entity=${enc(name)}`).catch(() => null);
    const nodes = Array.isArray(ego?.nodes) ? ego.nodes : [];
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const root = ego?.root ?? {};
    const relations = (Array.isArray(ego?.edges) ? ego.edges : []).slice(0, 30).map((edge) => {
      const from = byId.get(edge.from_entity);
      const to = byId.get(edge.to_entity);
      const other = edge.from_entity === root.id ? edge.to_entity : edge.from_entity;
      const otherNode = byId.get(other);
      return {
        title: `${clip(from?.name ?? "—", 16)} → ${clip(to?.name ?? "—", 16)}`,
        subtitle: clip(edge.relation_type ?? "关系", 24),
        tone: "info",
        ...(otherNode === undefined
          ? {}
          : { action: { id: "open-entity", args: { name: String(otherNode.name ?? "") } } }),
      };
    });
    const memories = new Map();
    for (const edge of Array.isArray(ego?.edges) ? ego.edges : []) {
      if (typeof edge.memory_id === "string" && edge.memory_id !== "") {
        const memo = cache.get(edge.memory_id);
        memories.set(edge.memory_id, {
          title: clip(memo?.title ?? `记忆 ${edge.memory_id.slice(0, 8)}`, 40),
          subtitle: memo === undefined ? "未在本地缓存" : typeLabel(memo.type),
          action: { id: "open", args: { id: edge.memory_id } },
        });
      }
    }
    state.entityRelationCount = relations.length;
    state.entityMemoryCount = memories.size;
    return {
      entityName: clip(root.name ?? name, 40),
      entityType: clip(entityTypeLabel(root.type ?? "实体"), 20),
      entityMentionText: `被提到 ${String(root.mention_count ?? 0)} 次 · 关系 ${relations.length} 条`,
      entityDepth: String(state.entityDepth),
      entityAttrs: (Array.isArray(attrs?.attrs) ? attrs.attrs : []).slice(0, 24).map((attr) => ({
        label: clip(attr.key ?? "—", 30),
        value: clip(String(attr.value ?? "—"), 60),
      })),
      entityRelations: relations,
      entityMemories: [...memories.values()].slice(0, 20),
      entityRelationCount: relations.length,
      entityMemoryCount: memories.size,
      entityHint: "点关系可以跳到相邻实体；点记忆可以跳到详情。",
    };
  }

  async function loadSettings() {
    const [features, mode] = await Promise.all([call("/features"), call("/mode")]);
    const effective = features?.effective ?? {};
    state.flags = effective;
    state.flagOverrides = features?.overrides ?? {};
    state.pendingRestart = Array.isArray(features?.pendingRestart) ? features.pendingRestart : [];
    const changed = Object.keys(state.flagOverrides).length;
    const pending = state.pendingRestart.length;
    // 上游不断加旗标：没给中文名的布尔项仍要出现在面板上，否则新功能在手机上
    // 静默消失。数值/字符串键（模型名、预算）不放这里——它们需要输入框，不是开关。
    state.extraRows = Object.keys(effective)
      .filter((key) => !FLAG_LABELS.has(key) && typeof effective[key] === "boolean")
      .sort()
      .map((key) => ({
        title: key,
        subtitle: effective[key] === true ? "已开启 · 点一下关闭" : "已关闭 · 点一下开启",
        icon: effective[key] === true ? "toggle-on" : "toggle-off",
        action: { id: "flag-set", args: { key } },
      }));
    const payload = {
      extraRows: state.extraRows,
      settingsView: state.settingsView,
      sPanel: state.sPanel,
      flagGroup: state.flagGroup,
      flags: nestFlags(effective),
      mode: String(mode?.mode ?? "standard"),
      flagsMeta: `已改 ${changed} 项 · 待重启生效 ${pending} 项（改动即时写回 mneme，重启引擎后彻底生效）`,
    };
    if (state.sPanel === "menu") return payload;
    if (state.sPanel === "workbench") {
      const [deposited, archived] = await Promise.all([
        call("/list?deposited=only&limit=8&order=chrono").catch(() => ({})),
        call("/list?archived=only&limit=5&order=chrono").catch(() => ({})),
      ]);
      const depItems = deposited?.items ?? [];
      const arcItems = archived?.items ?? [];
      for (const row of [...depItems, ...arcItems]) cache.set(row.id, row);
      state.wbDeposited = depItems.map((row) => ({
        title: clip(row.title, 50),
        subtitle: `${typeLabel(row.type)} · ${fmtTime(row.updated_at)}`,
        action: { id: "open", args: { id: row.id } },
      }));
      state.wbArchived = arcItems.map((row) => ({
        title: clip(row.title, 50),
        subtitle: fmtTime(row.updated_at),
        trailing: "点按恢复",
        action: { id: "wb-restore", args: { id: row.id } },
      }));
      Object.assign(payload, {
        wbKv: [
          { label: "已沉淀", value: `${String(deposited?.total ?? depItems.length)} 条` },
          { label: "已归档", value: `${String(archived?.total ?? arcItems.length)} 条` },
        ],
        wbDeposited: state.wbDeposited,
        wbArchived: state.wbArchived,
      });
    } else if (state.sPanel === "commands") {
      const res = await call("/commands").catch(() => ({ commands: [] }));
      state.commands = Array.isArray(res?.commands) ? res.commands : [];
      state.cmdCount = state.commands.length;
      Object.assign(payload, {
        cmdRows: state.commands.map((cmd) => ({
          title: clip(cmd.name ?? cmd.id ?? "—", 30),
          subtitle: clip(cmd.description ?? "", 60),
        })),
        cmdCount: state.cmdCount,
        sCmdPick: state.sCmdPick,
        sCmdName: state.sCmdName,
        sCmdDesc: state.sCmdDesc,
        sCmdIns: state.sCmdIns,
      });
    } else if (state.sPanel === "vector") {
      const res = await call("/vector-config").catch(() => null);
      // 读到才算 loaded：读失败时下面会落成默认值，不能再拿它整体覆盖
      // 服务端配置（评审 #2）。
      state.vectorLoaded = res !== null && typeof res === "object" && res.config !== null && typeof res.config === "object";
      const config = res?.config ?? {};
      state.vector = {
        enabled: config.enabled === true,
        baseUrl: String(config.baseUrl ?? ""),
        model: String(config.model ?? ""),
      };
      const keySet = typeof config.apiKey === "string" && config.apiKey !== "";
      Object.assign(payload, {
        sVecEnabled: state.vector.enabled,
        sVecUrl: state.vector.baseUrl,
        sVecModel: state.vector.model,
        vectorKv: [
          {
            label: "状态",
            value: state.vector.enabled ? "已启用" : "未启用",
            tone: state.vector.enabled ? "good" : "muted",
          },
          { label: "接口", value: state.vector.baseUrl === "" ? "未配置" : clip(state.vector.baseUrl, 60) },
          { label: "模型", value: state.vector.model === "" ? "未配置" : state.vector.model },
          { label: "密钥", value: keySet ? "已配置（面板不显示）" : "未配置" },
        ],
        vectorNote: "搜索不再只认字面：接入任意 OpenAI 兼容的 embedding 接口后，意思相近的记忆也能被召回。",
      });
    } else if (state.sPanel === "external") {
      // 读一次真实配置，否则面板永远拿默认值渲染，保存时又把默认值写回去，
      // 把用户已经在 Web 面板里配好的端口/地址覆盖掉（评审 #6）。
      // 必须带 token=omit：不带的话这条 GET 会顺手生成并落库一个 Bearer。
      const res = await call("/external-api?token=omit").catch(() => null);
      state.externalLoaded = res !== null && typeof res === "object" && res.config !== null && typeof res.config === "object";
      const config = res?.config ?? {};
      state.external = {
        enabled: config.enabled === true,
        port: num(config.port, 8790),
        host: typeof config.host === "string" && config.host !== "" ? config.host : "127.0.0.1",
      };
      Object.assign(payload, {
        sExtEnabled: state.external.enabled,
        sExtPort: String(state.external.port),
        sExtHost: state.external.host,
      });
    } else if (state.sPanel === "facts") {
      // 「Agent 眼中的你」：一次请求喂饱这张卡（facts / journal / runs）。flag 关着
      // 也照读——历史上开过又关掉的库里事实还在，得让人看得见。
      const query = state.factsAgent === "" ? "" : `?agent=${encodeURIComponent(state.factsAgent)}`;
      const facts = await call(`/profile-facts${query}`).catch(() => ({}));
      state.factsCards = Array.isArray(facts?.cards) ? facts.cards.map(String) : [];
      const rows = Array.isArray(facts?.facts) ? facts.facts : [];
      state.factsItems = rows;
      const active = rows.filter((fact) => fact.status !== "archived");
      state.factsRows = rows.slice(0, 20).map((fact) => ({
        title: clip(String(fact.content ?? ""), 60),
        subtitle:
          fact.status === "archived"
            ? `已归档 · ${fmtTime(fact.updated_at)}`
            : `更新于 ${fmtTime(fact.updated_at)}`,
        trailing: fact.status === "archived" ? "已归档" : "点一下修改",
        action: { id: "facts-edit", args: { id: String(fact.id ?? "") } },
      }));
      const runs = Array.isArray(facts?.runs) ? facts.runs : [];
      const last = runs[0];
      state.factsRunText =
        last === undefined
          ? "还没跑过维护轮。点「立即更新」会让模型读最近的记忆补事实。"
          : `最近一轮：${String(last.status ?? "?")} · 改 ${String(last.ops_applied ?? 0)} 条 · 读 ${String(last.input_count ?? 0)} 条记忆 · ${fmtTime(last.started_at)}`;
      Object.assign(payload, {
        factsAgent: state.factsAgent,
        factsCardOptions: [
          { label: "默认", value: "" },
          // 宿主给的 cards 里常含空串（默认卡），别再和「默认」重复一次。
          ...state.factsCards.filter((key) => key !== "").map((key) => ({ label: key, value: key })),
        ],
        factsRows: state.factsRows,
        factsRunText: state.factsRunText,
        sFactNew: state.form.factNew ?? "",
        sFactEdit: state.factEdit?.content ?? "",
        factsEditHint:
          state.factEdit === null
            ? ""
            : `正在修改：${clip(String(state.factEdit.content ?? ""), 40)}`,
      });
      if (active.length === 0) state.factsRows.push({ title: "还没有事实", subtitle: "点下面的「立即更新」让模型生成一批。" });
    } else if (state.sPanel === "choro") {
      // 地志是「按仓库」的：先列已登记仓库，再列该仓库的模块骨架页。
      const repos = await call("/choro/repos").catch(() => ({}));
      state.choroRepos = (Array.isArray(repos?.repos) ? repos.repos : []).map((repo) => ({
        id: String(repo.id ?? ""),
        name: clip(String(repo.name ?? repo.root_path ?? repo.id ?? ""), 40),
      }));
      if (state.choroRepo === "" && state.choroRepos.length > 0) state.choroRepo = state.choroRepos[0].id;
      const known = state.choroRepos.some((repo) => repo.id === state.choroRepo);
      if (!known) state.choroRepo = state.choroRepos[0]?.id ?? "";
      let note = "先在地志里登记仓库（命令行 dsh-mneme-choro <repo> --apply）。";
      let rows = [];
      if (state.choroRepo !== "") {
        const map = await call(`/choro/modules?repo=${encodeURIComponent(state.choroRepo)}`).catch(() => ({}));
        const modules = Array.isArray(map?.modules) ? map.modules : [];
        rows = modules.slice(0, 30).map((item) => ({
          title: clip(String(item.title ?? item.slug ?? ""), 40),
          subtitle: `${String(item.file_count ?? 0)} 个文件 · ${String(item.page_status ?? "无页")}`,
          trailing: "看页",
          action: { id: "choro-page", args: { slug: String(item.slug ?? "") } },
        }));
        const repo = state.choroRepos.find((item) => item.id === state.choroRepo);
        const baseline = map?.repo?.gitBaseline;
        note =
          modules.length === 0
            ? "这个仓库还没有骨架页：点下面的「重建骨架」生成一次。"
            : `${modules.length} 个模块${baseline ? ` · 基线 ${String(baseline).slice(0, 7)}` : ""} · ${repo?.name ?? ""}`;
      }
      state.choroRows = rows;
      state.choroNote = note;
      Object.assign(payload, {
        choroRepo: state.choroRepo,
        choroRepoOptions:
          state.choroRepos.length === 0
            ? [{ label: "还没有登记任何仓库", value: "" }]
            : state.choroRepos.map((repo) => ({ label: repo.name, value: repo.id })),
        choroRows: state.choroRows,
        choroNote: state.choroNote,
        choroPageText: state.choroPageText,
      });
    } else if (state.sPanel === "help") {
      const info = await call("/info").catch(() => ({}));
      Object.assign(payload, {
        helpKv: [
          { label: "插件", value: `@modusensus/dsh-mneme ${String(info?.version ?? "—")}` },
          { label: "记忆库", value: "本机 SQLite（与本机 Web 面板同一份，不跨设备同步）" },
          { label: "面板", value: "dsh-go 原生面板" },
        ],
        versionNote: state.versionNote,
      });
    }
    return payload;
  }

  async function loadProfile() {
    if (state.profileTab === "persona") {
      const res = await call("/persona");
      const persona = res?.persona ?? {};
      const preview = res?.preview ?? {};
      return {
        personaText: clip(
          JSON.stringify({ default: persona.default ?? {}, byAgent: persona.byAgent ?? {} }, null, 2),
          700,
        ),
        previewItems: [
          { label: "生效来源", value: String(preview.source ?? "—") },
          { label: "注入内容", value: clip(preview.text === "" ? "（空）" : preview.text, 300) },
        ],
      };
    }
    if (state.profileTab === "rules") {
      const res = await call("/rules");
      return { editText: clip(JSON.stringify(res?.rules ?? [], null, 2), 2000) };
    }
    const res = await call("/profile");
    return { editText: clip(res?.profile ?? "", 2000), extractText: state.extractText };
  }

  async function loadConflict() {
    const res = await call("/conflicts");
    const items = Array.isArray(res?.items) ? res.items : [];
    state.conflictCount = num(res?.total, items.length);
    const rows = items.slice(0, 20).map((item) => ({
      title: clip(item.a?.title ?? item.b?.title ?? item.id ?? "—", 40),
      subtitle: `A：${clip(item.a?.title ?? "—", 20)} · B：${clip(item.b?.title ?? "—", 20)}`,
      tone: "warn",
      action: { id: "conflict-pick-row", args: { id: String(item.id ?? "") } },
    }));
    const selected = items.find((item) => item.id === state.conflictId) ?? null;
    state.conflictA = selected?.a ?? null;
    state.conflictB = selected?.b ?? null;
    state.conflictReady = selected !== null;
    const side = (memo) =>
      memo === null
        ? []
        : [
            { label: "类型", value: typeLabel(memo.type) },
            { label: "重要度", value: `★${memo.importance ?? 1}` },
            { label: "更新", value: fmtTime(memo.updated_at ?? memo.created_at) },
          ];
    return {
      conflictRows: rows,
      conflictCount: state.conflictCount,
      conflictReady: state.conflictReady,
      conflictPick: state.conflictPick,
      conflictATitle: clip(state.conflictA?.title ?? "", 120),
      conflictAMeta: side(state.conflictA),
      conflictAContent: clip(state.conflictA?.content ?? "", 800),
      conflictBTitle: clip(state.conflictB?.title ?? "", 120),
      conflictBMeta: side(state.conflictB),
      conflictBContent: clip(state.conflictB?.content ?? "", 800),
      pendingConflicts: state.conflictCount,
    };
  }

  async function loadStatus() {
    const [info, health, dream, inject, stats, conflicts, list, entities, mode, preview, audit, features, recent] =
      await Promise.all([
        call("/info").catch(() => ({})),
        call("/health").catch(() => ({})),
        call("/dream-status").catch(() => ({})),
        call("/inject-status").catch(() => ({})),
        call("/recall-stats?window=30").catch(() => ({})),
        call("/conflicts").catch(() => ({})),
        call("/list?limit=1").catch(() => ({})),
        call("/entities?limit=1").catch(() => ({})),
        call("/mode").catch(() => ({})),
        call("/inject-preview").catch(() => ({})),
        call("/semantic/llm-audit/stats?days=28").catch(() => ({})),
        call("/features").catch(() => ({})),
        call("/list?limit=200&order=chrono").catch(() => ({})),
      ]);
    const run = dream?.lastRun ?? {};
    const mirror = health?.mirror ?? {};
    const snapshot = preview?.snapshot ?? null;
    state.injectPreviewText =
      snapshot === null
        ? "还没有渲染过注入预览：下一轮对话开始时 mneme 会写一份快照。"
        : clip(typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot), 500);
    const byDay = Array.isArray(audit?.by_day) ? audit.by_day : [];
    state.tokenCategories = byDay.map((day) => fmtDay(day.day));
    state.tokenSeries = byDay.length === 0 ? [] : [{ name: "调用", values: byDay.map((day) => num(day.count, 0)) }];
    state.tokenKv = [
      { label: "调用次数", value: `${String(audit?.total_calls ?? 0)} 次` },
      { label: "Token", value: String(audit?.total_tokens ?? 0) },
      { label: "估算成本", value: `$${Number(audit?.total_cost_usd ?? 0).toFixed(4)}` },
    ];
    const heatEnabled = (features?.effective ?? {}).heatEnabled === true;
    const heated = (recent?.items ?? []).filter((row) => typeof row.heat === "number");
    if (heatEnabled && heated.length > 0) {
      const hot = heated.filter((row) => row.heat >= 0.7).length;
      const warm = heated.filter((row) => row.heat >= 0.3 && row.heat < 0.7).length;
      state.heatSeries = [{ name: "条数", values: [hot, warm, heated.length - hot - warm] }];
      state.heatNote = `统计最近 ${heated.length} 条记忆的热度。`;
    } else {
      state.heatSeries = [];
      state.heatNote = "mneme 没有开启“热度衰减”，所以看不到热度分布。";
    }
    state.pendingConflicts = num(conflicts?.total, 0);
    return {
      // metric cards live on 状态, mirroring mneme's own Status page
      totalText: `${String(list?.total ?? 0)} 条`,
      injectedText: `${String(stats?.injection?.injectedCount ?? 0)} 次`,
      slotRateText: `${String(Math.round((stats?.injection?.slotFillRate ?? 0) * 1000) / 10)}%`,
      conflictsText: `${String(conflicts?.total ?? 0)} 条`,
      statusKv: [
        { label: "mneme 版本", value: String(info?.version ?? "—") },
        { label: "记忆", value: `${String(list?.total ?? 0)} 条` },
        { label: "实体", value: `${String(entities?.total ?? 0)} 个` },
        { label: "运行模式", value: String(mode?.mode ?? "—") },
        { label: "镜像", value: String(mirror.status ?? "—"), tone: mirror.status === "ok" ? "good" : "warn" },
        { label: "上次成功", value: fmtTime(mirror.success_at) },
      ],
      injectKv: [
        {
          label: "自动注入",
          value: inject?.autoInject ? "已开启" : "已关闭",
          tone: inject?.autoInject ? "good" : "muted",
        },
        { label: "注入抑制", value: inject?.suppressed ? "是" : "否" },
        { label: "会话预设", value: String(inject?.agentPreset ?? "—") },
        { label: "近 30 天注入", value: `${String(stats?.injection?.injectedCount ?? 0)} 次` },
        { label: "命中率", value: `${String(Math.round((stats?.injection?.slotFillRate ?? 0) * 1000) / 10)}%` },
      ],
      topRows: (stats?.topRecalled ?? []).slice(0, 5).map((row) => ({
        title: clip(row.title, 40),
        subtitle: typeLabel(row.type),
        trailing: `${row.count} 次`,
      })),
      dreamKv: [
        { label: "上次巩固", value: fmtTime(dream?.lastConsolidation) },
        { label: "上次运行", value: `${fmtTime(run.created_at)} ${run.status ?? "—"}` },
        {
          label: "待确认",
          value: `${String(conflicts?.total ?? 0)} 条`,
          tone: num(conflicts?.total, 0) > 0 ? "warn" : "good",
        },
      ],
      runRows: (dream?.runs ?? []).slice(0, 5).map((row) => ({
        title: `${fmtTime(row.created_at)} · ${String(row.status ?? "—")}`,
        subtitle: clip(row.summary ?? row.mode ?? "", 40),
      })),
      injectPreviewText: state.injectPreviewText,
      tokenCategories: state.tokenCategories,
      tokenSeries: state.tokenSeries,
      tokenKv: state.tokenKv,
      heatSeries: state.heatSeries,
      heatNote: state.heatNote,
      reclaimText: state.reclaimText,
      reclaimConfirm: state.reclaimConfirm,
      pendingConflicts: state.pendingConflicts,
    };
  }

  // The app's `tabs` bar switches locally, so the payload always carries every
  // section (a binding whose key is missing renders as 「—」). That does not mean
  // every section must be re-read after every tap: 实体 / 设置 / 状态 only change
  // while their own page is open, so a tap on the list used to cost four reads
  // (评审 #14). Load the active page's section, keep the rest from the previous
  // payload; a full read happens on mount.
  async function load(options = {}) {
    const full = options.full === true;
    const payload = {
      page: state.page,
      profileTab: state.profileTab,
      notice: state.notice,
      err: state.err,
    };
    const jobs = [];
    const merge = (promise) => jobs.push(promise.then((part) => Object.assign(payload, part)));
    const page = state.page;
    const memoryPage = !["entity", "settings", "profile"].includes(page);
    if (full || memoryPage) {
      const memory = page === "detail" ? loadDetail() : page === "editor" ? loadEditor() : loadMemory();
      merge(Promise.resolve(memory));
    }
    const entityPage = page === "entity";
    // 实体搜索要重读实体清单；但搜索后 state.page 仍是 "list"（视图里实体
    // 区就是列表），旧条件只看页面，于是搜索完推的仍是搜索前那份（评审 #4）。
    if (full || entityPage || state.entityDirty) merge(entityPage ? loadEntityDetail() : loadEntity());
    state.entityDirty = false;
    if (full || page === "settings" || page === "profile" || state.settingsDirty) {
      merge(loadSettings());
      merge(loadStatus());
    }
    state.settingsDirty = false;
    if (full || (memoryPage && page === "conflict")) merge(loadConflict());
    if (full || page === "profile") merge(loadProfile());
    const settled = await Promise.allSettled(jobs);
    const failed = settled.find((item) => item.status === "rejected");
    if (failed !== undefined) payload.err = errorText(failed.reason);
    // 未重新读取的块沿用上一次的完整结果；刷新过的那块覆盖上去。
    const merged = lastPayload === null ? payload : { ...lastPayload, ...payload };
    lastPayload = merged;
    return merged;
  }

  /** Re-run the loaders and push the result into every live panel feed. */
  async function broadcast() {
    if (emitters.size === 0) return;
    const payload = await load();
    for (const emit of [...emitters]) {
      try {
        emit(payload);
      } catch {
        // a closing panel detaches its emitter; nothing to do
      }
    }
  }

  // ---------------------------------------------------------------- actions
  function goMemory(page) {
    state.page = page;
    state.err = "";
  }

  function nextValue(list, current, value) {
    const picked = typeof value === "string" && list.includes(value) ? value : null;
    if (picked !== null) return picked;
    const index = list.indexOf(current);
    return list[(index + 1) % list.length];
  }

  async function applyArchived(archived, event, scope) {
    const memo = state.current;
    if (memo === null) return { toast: "先选一条记忆" };
    // 归档/恢复改的是「正在看」的那一条，参数只能从状态里拿；状态是模块级
    // 共享的，两个面板各开一条时后开的会盖掉前一个的 current。与删除同一条
    // 规矩：只动本面板自己打开的那条，对不上就拒绝（评审 #10）。
    const mine = openedBy.get(scopeKey(scope));
    if (mine === undefined || mine !== memo.id) {
      return { toast: "这条不是当前打开的记忆，已取消" };
    }
    try {
      const res = await call("/update", { method: "POST", body: { id: mine, archived } });
      if (res?.memory !== null && typeof res.memory === "object") {
        state.current = res.memory;
        openedBy.set(scopeKey(scope), String(res.memory.id ?? mine));
      }
      notice(archived ? "已归档。" : "已恢复。");
    } catch (error) {
      state.err = errorText(error);
    }
    return {};
  }

  // 编辑页的比对基准：点「编辑」时看到的那一份快照。冲突后必须用最新的
  // 记忆重建它，否则下一次保存会因为 base 为 null 而整份提交、直接跳过版本
  // 检查（评审 #11）。
  function editBaseOf(memo) {
    return {
      title: String(memo.title ?? ""),
      content: String(memo.content ?? ""),
      importance: num(memo.importance, 3),
      tags: joinTags(memo.tags),
      agentScope: typeof memo.agent_scope === "string" ? memo.agent_scope : "",
      workspaceScope: typeof memo.workspace_scope === "string" ? memo.workspace_scope : "",
      updatedAt: typeof memo.updated_at === "string" ? memo.updated_at : "",
    };
  }

  // 每次打开都回宿主重读，而不是先看 cache：cache 是列表加载时写下的，
  // 可能已经几分钟没更新；编辑页会拿它预填表单，随后整份提交回 /update，
  // 用陈旧内容覆盖掉工具或 Web 面板刚写进去的新值（评审 #4）。
  // /list 支持按 id 取单条（归档行也取得到），不再用 limit=500 扫列表再拿缓存
  // 兜底：500 条之外或已归档的条目根本扫不到，兜底等于拿旧值去比对 updated_at
  // （评审 #12）。网络失败就让它抛，调用处会报错，绝不悄悄退回缓存。
  async function openMemoryById(id) {
    const res = await call(`/list?id=${encodeURIComponent(String(id))}`);
    const row = (res?.items ?? [])[0];
    if (row === undefined) {
      cache.delete(id);
      return undefined;
    }
    cache.set(row.id, row);
    return row;
  }

  const actions = {
    "switch-group"(scope, event) {
      resetNotice();
      const keys = ["basic", "record", "write", "workflow", "retrieval", "scope", "extra"];
      state.flagGroup = nextValue(keys, state.flagGroup, valueOf(event, ["group", "value", "k"], ""));
      state.page = "settings";
      return {};
    },

    "switch-panel"(scope, event) {
      resetNotice();
      const keys = ["menu", "workbench", "commands", "vector", "external", "help", "facts", "choro"];
      state.sPanel = nextValue(keys, state.sPanel, valueOf(event, ["value", "panel", "k"], ""));
      state.page = "settings";
      return {};
    },

    "open-panel"(scope, event) {
      resetNotice();
      // 功能开关已经铺在设置页正文里，不再有 flags 子页面（#dsh-go 面板对齐电脑端分组）
      const keys = ["workbench", "commands", "vector", "external", "help", "facts", "choro"];
      const wanted = String(valueOf(event, ["k", "panel", "value"], "") ?? "");
      state.sPanel = keys.includes(wanted) ? wanted : "menu";
      state.page = "settings";
      // 子页面画在「设置」视图里：从「状态」视图点过来时若不把视图切回去，
      // 看到的还是状态页，什么都没有发生（评审 #14）。
      state.settingsView = "settings";
      return {};
    },

    "switch-settings-view"(scope, event) {
      resetNotice();
      state.settingsView = nextValue(["settings", "status"], state.settingsView, valueOf(event, ["value"], ""));
      if (state.settingsView === "settings") state.page = "settings";
      return {};
    },

    "open-profile"(scope, event) {
      resetNotice();
      const wanted = String(valueOf(event, ["k", "tab", "value"], state.profileTab) ?? "");
      state.profileTab = ["profile", "rules", "persona"].includes(wanted) ? wanted : "profile";
      state.page = "profile";
      return {};
    },

    "open-conflict"() {
      resetNotice();
      state.page = "conflict";
      // 冲突页同样属于「设置」视图（入口在设置页的状态区里），视图停在状态
      // 视图时切不到它（评审 #14）。
      state.settingsView = "settings";
      return {};
    },

    "clear-filter"() {
      resetNotice();
      state.q = "";
      state.type = "all";
      state.range = "all";
      state.minImportance = 0;
      state.scope = "all";
      state.semantic = false;
      state.heatSort = false;
      state.offset = 0;
      goMemory("list");
      return {};
    },

    "set-range"(scope, event) {
      resetNotice();
      state.range = nextValue(["all", "7d", "30d", "90d"], state.range, valueOf(event, ["value"], ""));
      state.offset = 0;
      goMemory("list");
      return {};
    },

    "set-minimp"(scope, event) {
      resetNotice();
      const picked = String(valueOf(event, ["value"], "0") ?? "0");
      state.minImportance = ["0", "3", "4", "5"].includes(picked) ? Number(picked) : 0;
      state.offset = 0;
      goMemory("list");
      return {};
    },

    "set-scope"(scope, event) {
      resetNotice();
      state.scope = nextValue(["all", "deposited", "archived", "foreign"], state.scope, valueOf(event, ["value"], ""));
      state.offset = 0;
      goMemory("list");
      return {};
    },

    "set-view"(scope, event) {
      resetNotice();
      state.viewMode = nextValue(["flat", "month"], state.viewMode, valueOf(event, ["value"], ""));
      return {};
    },

    "toggle-semantic"(scope, event) {
      resetNotice();
      const value = event?.value;
      state.semantic = typeof value === "boolean" ? value : !state.semantic;
      return {};
    },

    "toggle-heat"(scope, event) {
      resetNotice();
      const value = event?.value;
      state.heatSort = typeof value === "boolean" ? value : !state.heatSort;
      return {};
    },

    async provenance() {
      resetNotice();
      const memo = state.current;
      if (memo === null) return { toast: "先选一条记忆" };
      try {
        const res = await call(`/memory/provenance?id=${enc(memo.id)}&limit=5`);
        const windows = Array.isArray(res?.windows) ? res.windows : [];
        if (windows.length === 0) {
          state.provenanceText = "mneme 里没有这条记忆的蒸馏来源记录。";
        } else {
          const first = windows[0] ?? {};
          state.provenanceText = clip(
            `${windows.length} 个来源窗口 · 最近来自会话 ${String(first.session_id ?? "—").slice(0, 12)}（${fmtTime(first.created_at)}）`,
            300,
          );
        }
      } catch (error) {
        state.provenanceText = errorText(error).includes("distill-records-disabled")
          ? "mneme 没开「保留蒸馏原文」，所以这条记忆没有可查的来源窗口。"
          : errorText(error);
      }
      return {};
    },

    refresh() {
      resetNotice();
      return {};
    },

    back() {
      resetNotice();
      state.err = "";
      if (state.page === "profile" || state.page === "conflict") {
        state.page = "settings";
        state.sPanel = "menu";
      } else if (state.page === "entity") {
        state.page = "list";
      } else if (state.page === "settings") {
        if (state.sPanel !== "menu") state.sPanel = "menu";
        else state.page = "list";
      } else if (state.page === "detail" || state.page === "editor") {
        state.page = "list";
      }
      return {};
    },

    search(scope, event) {
      resetNotice();
      state.q = String(valueOf(event, ["query", "q", "text"], state.q) ?? "").trim();
      state.offset = 0;
      goMemory("list");
      return {};
    },

    page(scope, event) {
      resetNotice();
      // chips 送来的是 "prev" / "next"；早期的按钮组送 { d: ±1 }，两条都认。
      const raw = valueOf(event, ["value", "d", "delta", "page"], 0);
      const delta = raw === "prev" ? -1 : raw === "next" ? 1 : num(raw, 0);
      const pages = Math.max(1, Math.ceil(num(state.total, 0) / state.size));
      const next = Math.min(pages, Math.max(1, Math.floor(state.offset / state.size) + 1 + delta));
      state.offset = (next - 1) * state.size;
      goMemory("list");
      return {};
    },

    async open(scope, event) {
      resetNotice();
      const id = String(valueOf(event, ["id"], "") ?? "");
      if (id === "") return { toast: "这条记录没有 id" };
      let found;
      try {
        found = await openMemoryById(id);
      } catch (error) {
        state.err = errorText(error);
        return {};
      }
      if (found === undefined) {
        state.err = "这条记忆已经不在列表里了。";
        return {};
      }
      state.current = found;
      openedBy.set(scopeKey(scope), found.id);
      state.provenanceText = "尚未查看。点上面的按钮可向 mneme 查这条记忆的蒸馏来源。";
      goMemory("detail");
      return {};
    },

    "open-entity"(scope, event) {
      resetNotice();
      const name = String(valueOf(event, ["name", "entity", "value"], "") ?? "");
      if (name === "") return { toast: "没有选中实体" };
      state.entityName = name;
      state.entityDepth = 1;
      state.page = "entity";
      return {};
    },

    "entity-search"(scope, event) {
      resetNotice();
      state.entityQuery = String(valueOf(event, ["entityQuery", "query", "q"], "") ?? "").trim();
      state.page = "list";
      // 让下一次 load() 补读实体清单（页面仍是列表，见 load 里的注释）。
      state.entityDirty = true;
      return {};
    },

    "entity-depth"(scope, event) {
      resetNotice();
      const picked = String(valueOf(event, ["value", "entityDepth"], "1") ?? "1");
      state.entityDepth = picked === "2" ? 2 : 1;
      return {};
    },

    edit(scope) {
      resetNotice();
      const memo = state.current;
      if (memo === null) return { toast: "先选一条记忆" };
      // 记下本面板打开的那条：save 也要按它核对（评审 #3）。
      openedBy.set(scopeKey(scope), memo.id);
      state.form = {
        id: memo.id,
        title: memo.title ?? "",
        content: memo.content ?? "",
        type: memo.type ?? "project",
        importance: num(memo.importance, 3),
        tags: joinTags(memo.tags),
        agentScope: typeof memo.agent_scope === "string" ? memo.agent_scope : "",
        workspaceScope: typeof memo.workspace_scope === "string" ? memo.workspace_scope : "",
      };
      state.editBase = editBaseOf(memo);
      goMemory("editor");
      return {};
    },

    "type-filter"(scope, event) {
      resetNotice();
      const next = String(valueOf(event, ["value", "type"], "all") ?? "all");
      state.type = next === "all" || TYPE_LABELS[next] !== undefined ? next : "all";
      state.offset = 0;
      goMemory("list");
      return {};
    },

    "form-type"(scope, event) {
      const next = String(valueOf(event, ["value", "type"], state.form.type ?? "project") ?? "project");
      state.form.type = TYPE_LABELS[next] === undefined ? "project" : next;
      return {};
    },

    new() {
      resetNotice();
      state.current = null;
      state.form = {
        id: "",
        title: "",
        content: "",
        type: "project",
        importance: 3,
        tags: "",
        agentScope: "",
        workspaceScope: "",
      };
      goMemory("editor");
      return {};
    },

    async save(scope, event) {
      resetNotice();
      const value = event?.value;
      const source =
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? { ...state.form, ...value }
          : { ...state.form };
      const title = String(source.title ?? "").trim();
      const content = String(source.content ?? "").trim();
      const type = TYPE_LABELS[String(source.type ?? "")] === undefined ? "project" : String(source.type);
      const importance = Math.min(5, Math.max(1, Math.round(num(source.importance, 3))));
      const tags = splitTags(String(source.tags ?? ""));
      if (title === "" || content === "") return { toast: "标题和正文都不能空" };
      const id = state.form.id === "" || state.form.id === undefined ? undefined : String(state.form.id);
      // 编辑既有条目也要核对面板 scope：state.form 是模块级共享的，两个面板
      // 各开一条时，A 面板点保存会把内容写进 B 刚打开的那条（评审 #3）。
      // 新建（id 为空）不涉及已有行，不核对。
      if (id !== undefined) {
        const mine = openedBy.get(scopeKey(scope));
        if (mine === undefined || mine !== id) {
          return { toast: "这条不是当前打开的记忆，已取消" };
        }
      }

      if (id === undefined) {
        try {
          const res = await call("/create", { method: "POST", body: { title, content, importance, tags, type } });
          state.form = {};
          state.editBase = null;
          if (res !== null && typeof res === "object" && typeof res.id === "string") {
            state.current = res;
            openedBy.set(scopeKey(scope), res.id);
            goMemory("detail");
            notice(res.action === "merged" ? "已并入同标题的既有条目。" : "已新建一条记忆。");
          } else {
            goMemory("list");
            notice("已保存。");
          }
        } catch (error) {
          state.err = errorText(error);
        }
        return {};
      }

      // 编辑既有条目：先回宿主要一份当前值。盘点窗口够长（跨了几分钟甚至几次
      // 对话）时，缓存里的那份可能已经被工具或 Web 面板改过，而这里回填的表单
      // 一旦整份提交就会把对方的写入盖掉；/update 没有版本号校验，所以这层
      // 比较只能放在面板侧（评审 #4）。
      let fresh;
      try {
        fresh = await openMemoryById(id);
      } catch (error) {
        state.err = errorText(error);
        return {};
      }
      if (fresh === undefined) {
        state.current = null;
        state.form = {};
        state.editBase = null;
        goMemory("list");
        notice("这条记忆已经不在了。", "warn");
        return {};
      }
      const base = state.editBase;
      if (base !== null && base.updatedAt !== "" && base.updatedAt !== String(fresh.updated_at ?? "")) {
        state.current = fresh;
        state.form = {
          id: fresh.id,
          title: fresh.title ?? "",
          content: fresh.content ?? "",
          type: fresh.type ?? "project",
          importance: num(fresh.importance, 3),
          tags: joinTags(fresh.tags),
          agentScope: typeof fresh.agent_scope === "string" ? fresh.agent_scope : "",
          workspaceScope: typeof fresh.workspace_scope === "string" ? fresh.workspace_scope : "",
        };
        state.editBase = editBaseOf(fresh);
        state.err = "这条记忆刚在别处被改过，已换成最新内容，请再确认一次。";
        return {};
      }

      // 只提交真正改动的字段：把未改的 title/content 一起发回去，等于用旧值
      // 覆盖对方的写入（同一问题的一半）。
      const body = { id };
      if (base === null || title !== base.title) body.title = title;
      if (base === null || content !== base.content) body.content = content;
      if (base === null || importance !== base.importance) body.importance = importance;
      if (base === null || joinTags(tags) !== base.tags) body.tags = tags;
      const agentScope = String(source.agentScope ?? "").trim();
      const workspaceScope = String(source.workspaceScope ?? "").trim();
      if (base === null || agentScope !== base.agentScope) body.agent_scope = agentScope === "" ? null : agentScope;
      if (base === null || workspaceScope !== base.workspaceScope) {
        body.workspace_scope = workspaceScope === "" ? null : workspaceScope;
      }
      if (Object.keys(body).length === 1) return { toast: "没有改动" };
      try {
        const res = await call("/update", { method: "POST", body });
        const memo = res?.memory;
        state.form = {};
        state.editBase = null;
        if (memo !== null && typeof memo === "object" && typeof memo.id === "string") {
          state.current = memo;
          openedBy.set(scopeKey(scope), memo.id);
          goMemory("detail");
        } else {
          goMemory("list");
        }
        notice("已保存修改。");
      } catch (error) {
        state.err = errorText(error);
      }
      return {};
    },

    async archive(scope, event) {
      resetNotice();
      return applyArchived(true, event, scope);
    },

    async unarchive(scope, event) {
      resetNotice();
      return applyArchived(false, event, scope);
    },

    async delete(scope, event) {
      resetNotice();
      if (valueOf(event, ["confirmed"], false) !== true) return {};
      const memo = state.current;
      if (memo === null) return { toast: "先选一条记忆" };
      // 确认框本身不带参数（confirm 节点只有 id 与两个按钮文案），所以「删哪
      // 一条」只能靠状态。状态是模块级的、被所有面板共用：两个面板各开一条时
      // 后开的会盖掉前一个的 current，此时点确认就会删错行（评审 #5）。
      // 打开记忆时按面板 scope 记一份（见 open）。只显示共享详情、没在本面板
      // 走过 open 的（mine 为空）也不能删：state.current 可能是另一个面板的
      // 条目（评审 #13）。
      const mine = openedBy.get(scopeKey(scope));
      if (mine === undefined || mine !== memo.id) {
        return { toast: "这条不是当前打开的记忆，已取消" };
      }
      const id = mine;
      try {
        await call("/delete", { method: "POST", body: { id } });
        cache.delete(id);
        openedBy.delete(scopeKey(scope));
        state.current = null;
        goMemory("list");
        notice("已删除。");
      } catch (error) {
        state.err = errorText(error);
      }
      return {};
    },

    copy() {
      const memo = state.current;
      if (memo === null) return { toast: "先选一条记忆" };
      return { copy: clip(`# ${memo.title}\n\n${memo.content}`, 8000) };
    },

    insert() {
      const memo = state.current;
      if (memo === null) return { toast: "先选一条记忆" };
      return { insert: clip(`【记忆】${memo.title}\n${memo.content}`, 2000) };
    },

    "profile-tab"(scope, event) {
      resetNotice();
      const next = nextValue(
        ["profile", "rules", "persona"],
        state.profileTab,
        valueOf(event, ["k", "tab", "value"], ""),
      );
      state.profileTab = next;
      state.page = "profile";
      return {};
    },

    async "profile-save"(scope, event) {
      resetNotice();
      const body = String(valueOf(event, ["editText", "text", "value"], "") ?? "");
      try {
        if (state.profileTab === "rules") {
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            state.err = "规则必须是合法 JSON 数组。";
            return {};
          }
          // 非数组（{} / null / "text"）不能落成空数组：这条路由是整份覆盖，
          // 静默写 [] 会把用户已有的规则一次清空（评审 #10）。
          if (!Array.isArray(parsed)) {
            state.err = "规则必须是合法 JSON 数组。";
            return {};
          }
          await call("/rules", { method: "PUT", body: { rules: parsed } });
        } else {
          await call("/profile", { method: "PUT", body: { profile: body } });
        }
        notice("已保存。");
      } catch (error) {
        state.err = errorText(error);
      }
      return {};
    },

    async "profile-extract"() {
      resetNotice();
      if (state.profileTab !== "profile") return { toast: "先切到画像" };
      try {
        const res = await call("/profile/extract", { method: "POST", body: {} });
        const draft = res?.draft ?? res ?? {};
        const text =
          typeof draft.profile === "string"
            ? draft.profile
            : typeof draft.text === "string"
              ? draft.text
              : JSON.stringify(draft);
        state.extractText = clip(`草稿：${text}`, 600);
      } catch (error) {
        const raw = errorText(error);
        state.extractText = raw.includes("disabled")
          ? "mneme 没开「画像提取草稿」，先到「设置 › 功能开关 › 写入」里打开它。"
          : raw.includes("no-route")
            ? "没有可用的模型路由，提取不了草稿。"
            : raw.includes("no-input")
              ? "记忆还太少，提取不出画像。"
              : raw;
      }
      return {};
    },

    async mode(scope, event) {
      resetNotice();
      const next = String(valueOf(event, ["mode", "value"], "standard") ?? "standard");
      if (next !== "standard" && next !== "light") {
        state.err = "未知的模式。";
        return {};
      }
      try {
        await call("/mode", { method: "PUT", body: { mode: next } });
        notice(`已切到${next === "light" ? "轻量" : "标准"}模式。`);
      } catch (error) {
        state.err = errorText(error);
      }
      return {};
    },

    async reclaim() {
      resetNotice();
      try {
        const res = await call("/maintenance/reclaim");
        const report = res?.report ?? res ?? {};
        const rows = Array.isArray(report.candidates) ? report.candidates.length : undefined;
        const total = rows ?? report.reclaimable ?? report.total ?? report.rows ?? null;
        state.reclaimText =
          total === null ? "已检查（dry-run，未改动）。" : `可回收 ${String(total)} 条（dry-run，未改动）。`;
      } catch (error) {
        state.reclaimText = errorText(error);
      }
      return {};
    },

    "reclaim-prepare"() {
      resetNotice();
      state.reclaimConfirm = true;
      state.reclaimText = "回收会丢弃无法再召回的条目，确认后再执行。";
      return {};
    },

    async "reclaim-run"(scope, event) {
      resetNotice();
      if (valueOf(event, ["confirmed"], false) !== true) return {};
      try {
        const res = await call("/maintenance/reclaim", {
          method: "POST",
          body: { confirm: true, vacuum: true },
        });
        const report = res?.report ?? res ?? {};
        state.reclaimText = `已回收 ${String(report.reclaimed ?? report.total ?? 0)} 条。`;
        state.reclaimConfirm = false;
      } catch (error) {
        state.reclaimText = errorText(error);
      }
      return {};
    },

    "conflict-pick-row"(scope, event) {
      resetNotice();
      state.conflictId = String(valueOf(event, ["id"], "") ?? "");
      conflictBy.set(scopeKey(scope), state.conflictId);
      state.conflictPick = "";
      state.page = "conflict";
      return {};
    },

    "conflict-pick"(scope, event) {
      resetNotice();
      const picked = String(valueOf(event, ["winner", "value"], "") ?? "");
      state.conflictPick = picked === "a" || picked === "b" ? picked : "none";
      state.page = "conflict";
      return {};
    },

    async "conflict-win"(scope, event) {
      resetNotice();
      if (valueOf(event, ["confirmed"], false) !== true) return {};
      const id = state.conflictId;
      if (id === "") return { toast: "先选一条冲突" };
      // 冲突 id 也是共享状态：只裁决本面板自己选中的那条（评审 #3）。
      if (conflictBy.get(scopeKey(scope)) !== id) {
        return { toast: "这条不是当前打开的冲突，已取消" };
      }
      const winner = state.conflictPick === "a" ? "a" : state.conflictPick === "b" ? "b" : null;
      try {
        await call("/conflicts/resolve", { method: "POST", body: { id, winner, apply: true } });
        conflictBy.delete(scopeKey(scope));
        state.conflictId = "";
        state.conflictPick = "";
        notice("已按裁决合并。");
      } catch (error) {
        state.err = errorText(error);
      }
      return {};
    },

    async "wb-restore"(scope, event) {
      resetNotice();
      const id = String(valueOf(event, ["id"], "") ?? "");
      if (id === "") return {};
      try {
        await call("/update", { method: "POST", body: { id, archived: false } });
        notice("已恢复这条记忆。");
      } catch (error) {
        state.err = errorText(error);
      }
      return {};
    },

    "cmd-pick"(scope, event) {
      resetNotice();
      state.sCmdPick = String(valueOf(event, ["value"], "") ?? "");
      state.page = "settings";
      return {};
    },

    "cmd-add"(scope, event) {
      resetNotice();
      const value = event?.value;
      const source =
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? { sCmdName: value.sCmdName, sCmdDesc: value.sCmdDesc, sCmdIns: value.sCmdIns }
          : {};
      const name = String(source.sCmdName ?? state.sCmdName ?? "").trim();
      const description = String(source.sCmdDesc ?? state.sCmdDesc ?? "").trim();
      const instruction = String(source.sCmdIns ?? state.sCmdIns ?? "").trim();
      if (name === "" || instruction === "") return { toast: "命令名和指令正文都不能空" };
      return call("/commands", { method: "POST", body: { name, description, instruction } }).then(
        () => {
          state.sCmdName = "";
          state.sCmdDesc = "";
          state.sCmdIns = "";
          notice(`已添加命令 ${name}。`);
          return {};
        },
        (error) => {
          state.err = errorText(error);
          return {};
        },
      );
    },

    async "cmd-delete"(scope, event) {
      resetNotice();
      if (valueOf(event, ["confirmed"], false) !== true) return {};
      const id = state.sCmdPick;
      if (id === "") return { toast: "先选一条命令" };
      try {
        await call(`/commands?id=${enc(id)}`, { method: "DELETE" });
        state.sCmdPick = "";
        notice("已删除命令。");
      } catch (error) {
        state.err = errorText(error);
      }
      return {};
    },

    "vector-toggle"(scope, event) {
      resetNotice();
      // 没读到真实配置时 state.vector 只是默认值，整体 PUT 会覆盖服务端（评审 #2）。
      if (!state.vectorLoaded) return { toast: "还没读到向量配置，请刷新后再改" };
      const value = event?.value;
      state.vector.enabled = typeof value === "boolean" ? value : !state.vector.enabled;
      return call("/vector-config", {
        method: "PUT",
        body: { enabled: state.vector.enabled, baseUrl: state.vector.baseUrl, model: state.vector.model },
      }).then(
        () => {
          notice(`向量检索：${state.vector.enabled ? "已开启" : "已关闭"}`);
          return {};
        },
        (error) => {
          state.err = errorText(error);
          return {};
        },
      );
    },

    "vector-save"(scope, event) {
      resetNotice();
      if (!state.vectorLoaded) return { toast: "还没读到向量配置，请刷新后再改" };
      const value = event?.value;
      const source = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
      const baseUrl = String(source.sVecUrl ?? state.vector.baseUrl ?? "").trim();
      const model = String(source.sVecModel ?? state.vector.model ?? "").trim();
      state.vector.baseUrl = baseUrl;
      state.vector.model = model;
      return call("/vector-config", {
        method: "PUT",
        body: { enabled: state.vector.enabled, baseUrl, model },
      }).then(
        () => {
          notice("已保存向量配置。");
          return {};
        },
        (error) => {
          state.err = errorText(error);
          return {};
        },
      );
    },

    "vector-reindex"() {
      resetNotice();
      const run = call("/vector-reindex", { timeoutMs: 60000 }).then(
        (res) => {
          notice(`索引完成：新增 ${String(res?.indexed ?? 0)} 条，跳过 ${String(res?.skipped ?? 0)} 条。`);
          return {};
        },
        (error) => {
          state.err = errorText(error);
          return {};
        },
      );
      return {
        pending: { label: "正在重建向量索引", timeoutMs: 60000 },
        result: async () => run,
      };
    },

    "external-toggle"(scope, event) {
      resetNotice();
      if (!state.externalLoaded) return { toast: "还没读到外部访问配置，请刷新后再改" };
      const value = event?.value;
      state.external.enabled = typeof value === "boolean" ? value : !state.external.enabled;
      return call("/external-api", {
        method: "PUT",
        body: { enabled: state.external.enabled, port: state.external.port, host: state.external.host },
      }).then(
        () => {
          notice(`外部访问：${state.external.enabled ? "已开启" : "已关闭"}`);
          return {};
        },
        (error) => {
          state.err = errorText(error);
          return {};
        },
      );
    },

    "external-save"(scope, event) {
      resetNotice();
      if (!state.externalLoaded) return { toast: "还没读到外部访问配置，请刷新后再改" };
      const value = event?.value;
      const source = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
      const port = Math.round(num(source.sExtPort ?? state.external.port, 8790));
      const host = String(source.sExtHost ?? state.external.host ?? "").trim();
      if (port < 1 || port > 65535) return { toast: "端口要在 1–65535 之间" };
      if (host === "" || host.includes("://")) return { toast: "监听地址不能带协议前缀" };
      state.external.port = port;
      state.external.host = host;
      return call("/external-api", {
        method: "PUT",
        body: { enabled: state.external.enabled, port, host },
      }).then(
        () => {
          notice("已保存外部访问配置。");
          return {};
        },
        (error) => {
          state.err = errorText(error);
          return {};
        },
      );
    },

    async "check-version"() {
      resetNotice();
      try {
        const res = await call("/version-check");
        const status = String(res?.status ?? "unknown");
        state.versionNote =
          status === "outdated"
            ? `有新版本 ${String(res?.latest ?? "")}（当前 ${String(res?.version ?? "")}）`
            : status === "latest"
              ? `已是最新版本 ${String(res?.version ?? "")}`
              : "没能连上 npm registry，稍后再试。";
        if (status === "outdated" && res?.latest) notice(`mneme 有新版本 ${res.latest}`);
      } catch (error) {
        state.versionNote = errorText(error);
      }
      return {};
    },
  };

  // One action per feature switch: the app tells us which action fired, and the
  // new value arrives as `event.value` (boolean) or is derived by flipping the
  // current effective value.
  for (const key of FLAG_LABELS.keys()) {
    actions[flagAction(key)] = async (scope, event) => {
      resetNotice();
      const value = event?.value;
      // state.flags 是宿主原样的扁平点号键（scopeState.enabled）；嵌套形态只
      // 出现在视图绑定里（payload.flags = nestFlags(effective)）。这里若按嵌套
      // 去取值会恒为 undefined，于是「已经打开的开关」永远翻转不回去（评审 #7）。
      const current = state.flags?.[key];
      // 布尔项翻转、枚举项（chorographyInject 的 light/full/off）直接用宿主给的
      // 字符串值：同一个动作 id 同时服务开关与下拉。
      const next =
        typeof value === "boolean" || typeof value === "string"
          ? value
          : typeof current === "string"
            ? current
            : !(current === true);
      try {
        await call("/features", { method: "PUT", body: { [key]: next } });
        const features = await call("/features");
        state.flagOverrides = features?.overrides ?? {};
        state.pendingRestart = Array.isArray(features?.pendingRestart) ? features.pendingRestart : [];
        state.flags = features?.effective ?? state.flags;
        state.settingsDirty = true;
        notice(
          `${FLAG_LABELS.get(key) ?? key}：${
            typeof next === "string" ? next : next ? "已开启" : "已关闭"
          }`,
        );
      } catch (error) {
        state.err = errorText(error);
      }
      // 开关只改一个绑定值：数据已经推过去了，别让 App 重建视图（否则设置页
      // 会被弹回第一个页签）。
      return { refresh: false };
    };
  }

  // ---- 「Agent 眼中的你」自动事实（0.11.0 的面板卡） ----------------------
  // 写入只有一个入口：POST /profile-facts/apply，op 形状与自动轮共用（add 必须
  // 带 content、update/archive 必须带 id）。这里不自己拼 SQL，也不碰 user_settings
  // ——手填画像仍然优先。
  const applyFacts = (ops) =>
    call("/profile-facts/apply", { method: "POST", body: { agent: state.factsAgent, ops } });

  Object.assign(actions, {
    "facts-agent"(scope, event) {
      resetNotice();
      state.factsAgent = String(valueOf(event, ["value", "agent"], "") ?? "");
      state.factEdit = null;
      factBy.delete(scopeKey(scope));
      return {};
    },

    "facts-edit"(scope, event) {
      resetNotice();
      const id = String(valueOf(event, ["id"], "") ?? "");
      const fact = state.factsItems.find((item) => String(item.id) === id);
      if (fact === undefined) return { toast: "这条事实已经不在了" };
      state.factEdit = { id, content: String(fact.content ?? "") };
      factBy.set(scopeKey(scope), id);
      return {};
    },

    "facts-add"(scope, event) {
      resetNotice();
      const value = event?.value;
      const source = value !== null && typeof value === "object" ? value : {};
      const text = String(source.sFactNew ?? state.form.factNew ?? "").trim();
      if (text === "") return { toast: "写一句话再添加" };
      return applyFacts([{ op: "add", content: text }]).then(
        (result) => {
          state.form.factNew = "";
          notice(`已加 ${String(result?.applied ?? 1)} 条事实。`);
          return {};
        },
        (error) => {
          state.err = errorText(error);
          return {};
        },
      );
    },

    "facts-save"(scope, event) {
      resetNotice();
      const target = state.factEdit;
      if (target === null) return { toast: "先点一条事实" };
      if (factBy.get(scopeKey(scope)) !== target.id) {
        return { toast: "这条不是当前打开的事实，已取消" };
      }
      const value = event?.value;
      const source = value !== null && typeof value === "object" ? value : {};
      const text = String(source.sFactEdit ?? target.content ?? "").trim();
      if (text === "") return { toast: "事实正文不能空" };
      if (text === target.content) return { toast: "没有改动" };
      return applyFacts([{ op: "update", id: target.id, content: text }]).then(
        (result) => {
          const failed = Array.isArray(result?.failures) ? result.failures : [];
          if (failed.length > 0) {
            state.err = "这条事实已被改过或删掉了，刷新后再试。";
            return {};
          }
          state.factEdit = null;
          factBy.delete(scopeKey(scope));
          notice("事实已更新。");
          return {};
        },
        (error) => {
          state.err = errorText(error);
          return {};
        },
      );
    },

    "facts-archive"(scope, event) {
      resetNotice();
      if (valueOf(event, ["confirmed"], false) !== true) return {};
      const target = state.factEdit;
      if (target === null) return { toast: "先点一条事实" };
      if (factBy.get(scopeKey(scope)) !== target.id) {
        return { toast: "这条不是当前打开的事实，已取消" };
      }
      return applyFacts([{ op: "archive", id: target.id }]).then(
        () => {
          state.factEdit = null;
          factBy.delete(scopeKey(scope));
          notice("已归档这条事实。");
          return {};
        },
        (error) => {
          state.err = errorText(error);
          return {};
        },
      );
    },

    "facts-run"(scope, event) {
      resetNotice();
      // 维护轮要跑一次 LLM（模型读最近记忆、提 op、落库），慢且不可并发，所以
      // 走 pending：面板先挂一条「正在更新」，最长等 60 秒。
      const run = call("/profile-facts/run", {
        method: "POST",
        body: { agent: state.factsAgent },
        timeoutMs: 60000,
      }).then(
        (receipt) => {
          const status = String(receipt?.status ?? "ok");
          state.factsRunText =
            status === "ok"
              ? `本轮改了 ${String(receipt?.opsApplied ?? 0)} 条事实。`
              : status === "noop"
                ? "没有新记忆可读，这轮没动。"
                : `这轮结束了：${status}`;
          notice("事实维护轮已结束。");
          return { toast: "事实已更新" };
        },
        (error) => {
          const message = errorText(error);
          // 409 = 功能关着，503 = 没配模型，502 = 模型答得不成形：三种都得说人话。
          state.err = /\b409\b/u.test(message)
            ? "「Agent 眼中的你」还关着：先在上面把开关打开。"
            : /\b503\b/u.test(message)
              ? "还没配后台模型：先在 mneme 设置里选一个 dream 模型。"
              : message;
          return { toast: "这轮没成功" };
        },
      );
      return { pending: { label: "正在维护事实", timeoutMs: 60000 }, result: async () => run };
    },

    // ---- 代码库地志（chorography）-----------------------------------------
    "choro-repo"(scope, event) {
      resetNotice();
      state.choroRepo = String(valueOf(event, ["value"], "") ?? "");
      state.choroPageText = "";
      return {};
    },

    "choro-page"(scope, event) {
      resetNotice();
      const slug = String(valueOf(event, ["slug"], "") ?? "");
      if (slug === "" || state.choroRepo === "") return { toast: "先选一个仓库" };
      return call(`/choro/page?repo=${encodeURIComponent(state.choroRepo)}&slug=${encodeURIComponent(slug)}`).then(
        (res) => {
          const page = res?.page;
          state.choroPageText =
            page === undefined
              ? "这一页读不出来，可能刚被重建过。"
              : clip(String(page?.content ?? page?.relPath ?? ""), 1600);
          notice(`已读取 ${String(page?.title ?? slug)} 的骨架页。`);
          return {};
        },
        (error) => {
          const message = errorText(error);
          state.err = /\b409\b/u.test(message) ? "索引还在、盘上没了：点「重建骨架」重跑一次。" : message;
          return {};
        },
      );
    },

    "choro-run"(scope, event) {
      resetNotice();
      if (valueOf(event, ["confirmed"], false) !== true) return {};
      if (state.choroRepo === "") return { toast: "还没有登记任何仓库" };
      const run = call("/choro/run", {
        method: "POST",
        body: { repo: state.choroRepo },
        timeoutMs: 60000,
      }).then(
        (res) => {
          const receipt = res?.receipt ?? {};
          state.choroPageText = "";
          notice(
            `骨架已重建：${String(receipt.pagesWritten ?? receipt.modules ?? 0)} 页` +
              (receipt.t1Loss === true ? "（已富化的语义段被退回骨架）" : ""),
          );
          return { toast: "重建完成" };
        },
        (error) => {
          state.err = errorText(error);
          return { toast: "重建失败" };
        },
      );
      return { pending: { label: "正在重建骨架", timeoutMs: 60000 }, result: async () => run };
    },
  });

  // 未收录的布尔旗标（「其它」组里的数据行）：行里带着 key，点一下翻转。
  actions["flag-set"] = async (scope, event) => {
    resetNotice();
    const key = String(valueOf(event, ["key", "value"], "") ?? "");
    if (key === "") {
      state.err = "没有拿到要切换的键。";
      return {};
    }
    const next = state.flags?.[key] !== true;
    try {
      await call("/features", { method: "PUT", body: { [key]: next } });
      const features = await call("/features");
      state.flagOverrides = features?.overrides ?? {};
      state.pendingRestart = Array.isArray(features?.pendingRestart) ? features.pendingRestart : [];
      state.flags = features?.effective ?? state.flags;
      state.settingsDirty = true;
      notice(`${key}：${next ? "已开启" : "已关闭"}`);
    } catch (error) {
      state.err = errorText(error);
    }
    return { refresh: false };
  };

  // 只改绑定值的动作不申请重画视图。App 收到 refresh 会重新拉一次视图树，
  // 而顶层 tabs 的选中页签是 App 的本地状态：树一重建就回到第一个页签，用户在
  // 设置页翻开关会被弹回记忆页。这些动作的结果都在 data 里（开关值、列表行、
  // 文案），推一次数据就够了。
  const VALUE_ONLY = new Set([
    "mode",
    "vector-toggle",
    "vector-save",
    "external-toggle",
    "external-save",
    "profile-save",
    "facts-agent",
    "facts-edit",
    "facts-add",
    "facts-save",
    "facts-archive",
    "facts-run",
    "flag-set",
    "choro-repo",
    "choro-page",
    "choro-run",
  ]);

  // Every action may change what the panel shows, so push fresh data before
  // asking the app to re-render (the refresh effect alone would re-render a
  // stale feed).
  const wrapped = {};
  for (const [id, handler] of Object.entries(actions)) {
    wrapped[id] = async (scope, event) => {
      let result;
      try {
        result = await handler(scope, event);
      } catch (error) {
        state.err = errorText(error);
        result = undefined;
      }
      // 默认重画视图：多数动作会改变「哪些节点存在」（进子页、空态、列表）。
      // 只改一个绑定值的动作（开关、档位、外部访问的开关）要显式关掉重画：
      // App 的 refresh 会让它重新拉一次视图树，而页签选择是 App 的本地状态，
      // 重建后回到第一个页签——用户正在设置页翻开关，会被弹回记忆页。
      const wanted = result ?? {};
      const skip = wanted.refresh === false || VALUE_ONLY.has(id) || id.startsWith("flag.");
      const effect = { ...wanted, refresh: !skip };
      // pending 动作（维护轮、地志重建）把真正的活儿放在 result 里，handler
      // 返回时它还没跑：此时立刻 broadcast 推出去的仍是这一轮之前的事实与
      // 地志列表。改成等 result 跑完再推（评审 #15）。
      if (typeof wanted.result === "function") {
        const inner = wanted.result;
        effect.result = async (...args) => {
          try {
            return await inner(...args);
          } finally {
            await broadcast();
          }
        };
        return effect;
      }
      await broadcast();
      return effect;
    };
  }

  // ----------------------------------------------------------------- panel
  ctx.dshGo.panel("mneme", {
    view() {
      return buildView(state);
    },
    data(scope, emit) {
      emitters.add(emit);
      // 挂载时读全：之后每个动作只重读当前页那一块（见 load 的注释）。
      load({ full: true }).then(
        (payload) => {
          if (emitters.has(emit)) emit(payload);
        },
        (error) => {
          if (emitters.has(emit)) emit({ notice: state.notice, err: errorText(error) });
        },
      );
      return () => {
        emitters.delete(emit);
      };
    },
    actions: wrapped,
  });
}

/**
 * 清掉模块级状态与缓存。在引擎重新挂载面板、以及测试之间切换场景时用它：
 * 这些表（列表缓存、按 scope 打开的记忆、提示语）是模块级的，跨 mount 复用会
 * 把上一个场景的残留带进下一个。
 */
export function resetPanelState() {
  cache.clear();
  emitters.clear();
  openedBy.clear();
  conflictBy.clear();
  factBy.clear();
  lastPayload = null;
  Object.assign(state, defaultState());
}
