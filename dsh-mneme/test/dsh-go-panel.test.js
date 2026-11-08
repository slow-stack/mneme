import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildView } from "../src/dsh-go/views/root.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");

// 这组守的是**视图契约**，不是像素：dsh-go 只认 JSON，越界（节点数 / 层数 / 字节）
// 是会在用户手机上直接报错的硬失败，所以每加一屏都要过一遍预算。
// 取数（src/dsh-go/host.js）与动作（src/dsh-go/panel.js）需要真宿主，端到端在
// dsh-go-bridge 那一侧验证；这里只锁得到「视图能拼出来、拼得合规」。

const LIMITS = { nodes: 120, depth: 8, bytes: 32768 };

/**
 * 与 bridge 的 viewStats 同口径：节点 = 带 `type` 的组件对象（bindings / options /
 * actions 里的参数对象不算节点），层数 = 组件 children 的递归深度。
 */
function stats(node, depth = 1) {
  if (node === null || typeof node !== "object") return { nodes: 0, depth };
  if (Array.isArray(node)) {
    let nodes = 0;
    let deepest = depth;
    for (const child of node) {
      const s = stats(child, depth);
      nodes += s.nodes;
      deepest = Math.max(deepest, s.depth);
    }
    return { nodes, depth: deepest };
  }
  const isComponent = typeof node.type === "string";
  let nodes = isComponent ? 1 : 0;
  let deepest = isComponent ? depth : depth;
  for (const value of Object.values(node)) {
    if (value === null || typeof value !== "object") continue;
    const s = stats(value, isComponent ? depth + 1 : depth);
    nodes += s.nodes;
    deepest = Math.max(deepest, s.depth);
  }
  return { nodes, depth: deepest };
}

/** 面板状态的默认形状（与 src/dsh-go/panel.js 的 state 对齐，覆盖视图读到的每个字段）。 */
function state(over = {}) {
  return {
    page: "list",
    flagGroup: "basic",
    settingsView: "settings",
    sPanel: "menu",
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
    size: 20,
    current: null,
    form: {},
    entityTotal: 12,
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
    versionNote: "",
    extractText: "",
    injectPreviewText: "",
    tokenCategories: [],
    tokenSeries: [],
    tokenKv: [],
    heatSeries: [],
    heatNote: "",
    reclaimText: "",
    reclaimConfirm: false,
    notice: "",
    noticeTone: "ok",
    err: "",
    ...over,
  };
}

const SCREENS = [
  ["记忆列表", state()],
  ["记忆列表·月视图", state({ viewMode: "month", monthGroups: [{ label: "2026-11", rows: [] }] })],
  ["记忆详情", state({ page: "detail", current: { id: "m1", archived: false } })],
  ["记忆编辑", state({ page: "editor", form: { id: "m1", type: "project" } })],
  ["记忆新建", state({ page: "editor", form: {} })],
  ["冲突队列", state({ page: "conflict" })],
  ["冲突对照", state({ page: "conflict", conflictReady: true, conflictPick: "a", conflictCount: 1 })],
  ["实体", state({ entityTotal: 0 })],
  ["实体详情", state({ page: "entity" })],
  ["设置首页", state()],
  ["状态", state({ settingsView: "status" })],
  ["画像", state({ page: "profile" })],
  ["人格", state({ page: "profile", profileTab: "persona" })],
  ["规则", state({ page: "profile", profileTab: "rules" })],
  ["工作动态", state({ sPanel: "workbench" })],
  ["自定义指令", state({ sPanel: "commands", cmdCount: 1, commands: [{ id: "c1", name: "x" }], sCmdPick: "c1" })],
  ["向量检索", state({ sPanel: "vector" })],
  ["外部访问", state({ sPanel: "external" })],
  ["关于", state({ sPanel: "help" })],
  ["Agent 眼中的你", state({ sPanel: "facts" })],
  ["代码库地志", state({ sPanel: "choro" })],
];

for (const [name, fixture] of SCREENS) {
  test(`dsh-go 视图在预算内：${name}`, () => {
    const view = buildView(fixture);
    assert.equal(view.v, 2);
    const s = stats(view);
    assert.ok(s.nodes <= LIMITS.nodes, `${name} 节点 ${s.nodes} > ${LIMITS.nodes}`);
    assert.ok(s.depth <= LIMITS.depth, `${name} 层 ${s.depth} > ${LIMITS.depth}`);
    const bytes = Buffer.byteLength(JSON.stringify(view), "utf8");
    assert.ok(bytes <= LIMITS.bytes, `${name} 体积 ${bytes} > ${LIMITS.bytes}`);
  });
}

test("dsh-go 顶层是三个原生页签（App 页签条每格 80dp，第四格会折行）", () => {
  const view = buildView(state());
  const tabs = view.children.find((node) => node.type === "tabs");
  assert.ok(tabs, "顶层没有 tabs");
  assert.deepEqual(
    tabs.items.map((item) => item.label),
    ["记忆", "实体", "设置"],
  );
});

test("功能开关铺在设置页正文里，不是子页面（#dsh-go 对齐电脑端分组）", () => {
  const view = buildView(state());
  const flat = JSON.stringify(view);
  assert.ok(flat.includes("功能开关"), "缺少功能开关标题");
  assert.ok(!flat.includes("功能开关（分组）"), "标题仍带着「（分组）」");
  assert.ok(flat.includes('"bind":"data.flagGroup"'), "分组选择器没有绑定");
  assert.ok(/"bind":"data\.flags\./.test(flat), "没有开关绑定到 data.flags.*");
  assert.ok(!flat.includes('"k":"flags"'), "还有指向 flags 子页面的入口");
});

function walk(node, out = []) {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  out.push(node);
  for (const value of Object.values(node)) walk(value, out);
  return out;
}

test("设置页里不再出现自造的解释性小字（只留 mneme 原文案）", () => {
  const flat = JSON.stringify(buildView(state()));
  const invented = [
    "38 项开关",
    "写成斜杠命令，随时调用",
    "跨会话记住你是谁",
    "接口地址、模型、重建索引",
    "版本检测与数据来源",
    "轻量模式少做后台整理",
    "沉淀 =",
  ];
  for (const phrase of invented) assert.ok(!flat.includes(phrase), `自造文案还在：${phrase}`);
  assert.ok(flat.includes("控制插件在后台做哪些事"), "缺少 mneme 原文案（features.desc）");
  assert.ok(flat.includes("轻量模式只保留核心能力"), "缺少 mneme 原文案（mode.desc）");
});

test("dsh-go 清单合法：一个面板、placement 只落 session.tab / features", () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
  const manifest = pkg.dshGo;
  assert.equal(manifest.v, 1);
  const panels = manifest.contributes.panels;
  assert.equal(panels.length, 1);
  const [panel] = panels;
  assert.equal(panel.id, "mneme");
  assert.ok(["session.tab", "features"].includes(panel.placement[0]));
  // 面板里不出现密钥 / 令牌字样：清单是 App 侧可读的静态文件
  assert.ok(!JSON.stringify(manifest).includes("token"));
});

test("记忆页与实体页的树不随数据变：首屏和拿到数据后是同一棵树", () => {
  // 面板的 view() 在 data() 之前就要交出整棵树，所以按数据决定「要不要这块」
  // 的地方，首屏会先按默认值定形，之后数据推来了也只是填绑定——空状态块就会
  // 和有数据的列表同时挂在屏幕上。这里把两棵树直接比对，锁住结构稳定。
  const empty = JSON.stringify(buildView(state({ rowsCount: 0, entityTotal: 0 })));
  const filled = JSON.stringify(buildView(state({ rowsCount: 20, entityTotal: 12 })));
  assert.equal(empty, filled, "视图结构仍然跟着数据走，首屏会留下残影");
  assert.ok(!empty.includes('"type":"emptyState"'), "记忆 / 实体页不再用数据决定空状态块");
});

test("翻页是 App 原生的两段 segmented：一行铺满，不折行也不叠按钮", () => {
  const nodes = walk(buildView(state()));
  const pager = nodes.find((node) => node.type === "segmented" && node.bind === "data.pagePick");
  assert.ok(pager, "缺少翻页 segmented");
  assert.deepEqual(
    pager.options.map((option) => option.label),
    ["上一页", "下一页"],
  );
  assert.deepEqual(
    pager.options.map((option) => option.value),
    ["prev", "next"],
  );
  assert.equal(pager.onChange.id, "page");
  // 页码文案挂在 label 上（必绘），不再单独占一行。
  assert.deepEqual(pager.label, { $: "data.pageText" });

  // 回归：曾经用两个 stack + chips 做左右对齐，右列在真机上渲染失败
  // （App 显示「这部分无法显示」），所以翻页只能是单个节点。
  assert.equal(
    nodes.filter((node) => node.type === "chips" && node.bind === "data.pagePick").length,
    0,
    "翻页又回到了 chips 方案",
  );
  const folded = nodes.filter(
    (node) => node.type === "actions" && (node.items ?? []).some((item) => item.action?.id === "page"),
  );
  assert.equal(folded.length, 0, "翻页按钮还在 actions 里：窄屏会被折成上下两行");
});
