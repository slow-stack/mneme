// 设置 / 状态: two sibling areas, mirroring mneme's own panel where 设置 and
// 状态 are separate top-level tabs. The app's tab bar only fits three tabs at
// 80dp on a phone, so the third tab holds a two-item switch (设置 | 状态) and
// each area keeps its own inner navigation: 设置 is a card menu (like mneme's
// Settings cards) and 状态 is mneme's Status page with its grouped cards.
import { ENUM_FLAGS, FLAG_GROUPS, MODE_OPTIONS, flagAction, flagPath } from "../text.js";
import {
  act,
  actions,
  b,
  caption,
  divider,
  empty,
  fold,
  heading,
  kv,
  metric,
  mono,
  select,
  text,
  toggle,
} from "./common.js";
import { conflictPage } from "./memory.js";
import { statusSection } from "./status.js";

const SETTINGS_VIEWS = ["settings", "status"];

// 设置页的顺序与分组对齐 mneme 电脑端面板（个性化 / 记忆引擎 / 搜索 / 连接与
// 安全 / 帮助）。功能开关是记忆引擎的一部分，所以不再藏进子页面，直接铺在设置
// 页上；只有需要表单的子页（命令 / 向量 / 外部访问 / 工作动态 / 关于）才进入
// 「点一行 → 子页面」的导航。
const PAGES = [
  { key: "commands", title: "自定义指令", hint: "把常用提示词存成 / 命令，聊天时直接键入调用。", icon: "command" },
  {
    key: "vector",
    title: "向量检索",
    hint: "搜索不再只认字面：接入任意 OpenAI 兼容的 embedding 接口后，意思相近的记忆也能被召回。",
    icon: "chart",
  },
  {
    key: "external",
    title: "外部访问",
    hint: "开放一个本机接口，让其他工具（插件、命令行、桌面应用）也能读写这份记忆库，默认只允许本机连接。改动保存后重启 DSH 生效。",
    icon: "globe",
  },
  {
    key: "choro",
    title: "代码库地志",
    hint: "给常用仓库生成一份代码骨架：模块划分、文件数、约定与构建方式，开会话时按档位注入。",
    icon: "code",
  },
  { key: "help", title: "关于", icon: "info" },
];

const pageRow = (page) => ({
  title: page.title,
  ...(page.hint === undefined ? {} : { subtitle: page.hint }),
  icon: page.icon,
  action: { id: "open-panel", args: { k: page.key } },
});

const rows = (keys) => ({
  type: "list",
  items: PAGES.filter((page) => keys.includes(page.key)).map(pageRow),
});

function personalRows() {
  return {
    type: "list",
    items: [
      {
        title: "用户画像",
        subtitle: "写一段自我介绍（角色、背景、偏好），Agent 每轮对话都会自动带上。",
        icon: "user",
        action: { id: "open-profile", args: { k: "profile" } },
      },
      {
        title: "规则",
        subtitle: "给 Agent 立下必须遵守的规矩，随时增删，下一轮即生效。",
        icon: "list",
        action: { id: "open-profile", args: { k: "rules" } },
      },
      {
        title: "Agent 眼中的你",
        subtitle: "dream 巩固后自动维护的一份逐条事实清单；这里可以逐条改、加、归档。",
        icon: "sparkle",
        action: { id: "open-panel", args: { k: "facts" } },
      },
      {
        title: "人格定义（beta）",
        subtitle: "给这位 Agent 一张角色卡：名字、性格、回复要求。",
        icon: "robot",
        action: { id: "open-profile", args: { k: "persona" } },
      },
    ],
  };
}

function settingsMenu(state) {
  const group = FLAG_GROUPS.find((g) => g.key === state.flagGroup) ?? FLAG_GROUPS[0];
  return [
    heading("个性化"),
    personalRows(),
    heading("记忆引擎"),
    {
      type: "segmented",
      label: "\u200b",
      bind: "data.mode",
      options: MODE_OPTIONS,
      onChange: { id: "mode" },
    },
    caption(
      "轻量模式只保留核心能力：记忆读写、自动注入、热记忆；巩固、实体抽取、语义搜索等全部关闭，适合低配机器或只想「记住偏好」的场景。标准模式开启全部功能。",
    ),
    rows(["choro"]),
    heading("功能开关"),
    select(
      "分组",
      "data.flagGroup",
      FLAG_GROUPS.map((g) => ({ label: g.label, value: g.key })),
      "switch-group",
    ),
    caption(group.note),
    ...group.items.map(([key, label]) => toggle(label, flagPath(key), flagAction(key))),
    // 枚举项不是开关：给一组下拉（目前只有地志注入档位，挂在工作流组下）。
    ...ENUM_FLAGS.filter((flag) => group.key === "workflow").flatMap((flag) => [
      select(flag.label, flagPath(flag.key), flag.options, flagAction(flag.key)),
      caption(flag.hint),
    ]),
    // 「其它」组按 /features 的 effective 动态列出未收录的布尔旗标：视图结构
    // 不能靠数据分支，所以用 list + 数据行（点一行翻转一侧）。
    ...(group.key === "extra" ? [{ type: "list", items: b("data.extraRows") }] : []),
    caption(b("data.flagsMeta")),
    caption(
      "控制插件在后台做哪些事。改动即时保存，重启 DSH 后生效；嵌套开关（如「质量过滤 · 启用」）在电脑端面板里按点号归类。",
    ),
    heading("搜索"),
    rows(["vector"]),
    heading("连接与安全"),
    rows(["external"]),
    heading("帮助"),
    rows(["commands", "help"]),
    divider(),
    actions(act("刷新", "refresh", undefined, "refresh")),
  ];
}

function workbenchPanel() {
  const nodes = [
    kv(b("data.wbKv")),
    heading("已沉淀"),
    { type: "list", items: b("data.wbDeposited") },
    caption("沉淀 = 被 mneme 当成工作流或项目状态写下来的条目。"),
    heading("归档"),
  ];
  nodes.push({ type: "list", items: b("data.wbArchived") });
  nodes.push(caption("点按任意一条可以恢复它。"));
  return nodes;
}

function commandsPanel(state) {
  const nodes = [{ type: "list", items: b("data.cmdRows") }];
  if (state.cmdCount === 0) nodes.push(empty("还没有自定义命令", "在下面填一条，之后就能随时叫它。", "command"));
  nodes.push({
    type: "form",
    submit: { id: "cmd-add" },
    submitLabel: "新增命令",
    children: [
      { type: "textField", label: "命令名", bind: "data.sCmdName", required: true, maxLength: 40 },
      { type: "textField", label: "说明", bind: "data.sCmdDesc", maxLength: 120 },
      { type: "textField", label: "指令正文", bind: "data.sCmdIns", multiline: true, maxLines: 4, maxLength: 2000 },
    ],
  });
  if (state.cmdCount > 0) {
    nodes.push(
      select(
        "要删除的命令",
        "data.sCmdPick",
        [
          { label: "不删除", value: "" },
          ...state.commands.map((cmd) => ({ label: String(cmd.name ?? cmd.id), value: String(cmd.id) })),
        ],
        "cmd-pick",
      ),
    );
    if (state.sCmdPick !== "") {
      nodes.push({ type: "confirm", id: "cmd-delete", confirmLabel: "删除命令", cancelLabel: "取消" });
    }
  }
  return nodes;
}

function vectorPanel() {
  return [
    kv(b("data.vectorKv")),
    toggle("启用向量检索", "data.sVecEnabled", "vector-toggle"),
    {
      type: "form",
      submit: { id: "vector-save" },
      submitLabel: "保存向量配置",
      children: [
        { type: "textField", label: "接口地址", bind: "data.sVecUrl", placeholder: "https://…/v1", maxLength: 200 },
        {
          type: "textField",
          label: "模型",
          bind: "data.sVecModel",
          placeholder: "text-embedding-3-small",
          maxLength: 80,
        },
      ],
    },
    actions(act("重建索引", "vector-reindex", undefined, "refresh")),
    caption(b("data.vectorNote")),
  ];
}

function externalPanel() {
  return [
    toggle("开启外部访问", "data.sExtEnabled", "external-toggle"),
    {
      type: "form",
      submit: { id: "external-save" },
      submitLabel: "保存外部访问",
      children: [
        { type: "textField", label: "端口", bind: "data.sExtPort", placeholder: "8790", maxLength: 5 },
        { type: "textField", label: "监听地址", bind: "data.sExtHost", placeholder: "127.0.0.1", maxLength: 60 },
      ],
    },
    caption("令牌由 mneme 自己管理，面板不读取也不显示明文；需要令牌时到电脑端的 mneme 设置里看。"),
  ];
}

function helpPanel() {
  return [
    kv(b("data.helpKv")),
    actions(act("检测新版本", "check-version", undefined, "download")),
    caption(b("data.versionNote")),
  ];
}

const PANEL_TITLES = {
  facts: "Agent 眼中的你",
  choro: "代码库地志",
  workbench: "工作台",
  commands: "自定义命令",
  vector: "向量检索",
  external: "外部访问",
  help: "关于",
};

function factsPanel() {
  // 结构必须与数据无关（宿主先给视图、后推数据；按数据分支的地方会在首屏定形）。
  // 所以「编辑框 / 归档按钮」永远在树里，点的哪条事实由 data.factEditHint 说明、
  // 内容由 data.sFactEdit 填。
  return [
    select(
      "哪张卡",
      "data.factsAgent",
      b("data.factsCardOptions"),
      "facts-agent",
    ),
    { type: "list", items: b("data.factsRows") },
    { type: "textField", label: "修改这条事实", bind: "data.sFactEdit", multiline: true, maxLines: 3, maxLength: 300 },
    text(b("data.factsEditHint"), { size: "caption" }),
    actions(act("保存修改", "facts-save", undefined, "save")),
    { type: "confirm", id: "facts-archive", confirmLabel: "归档这条", cancelLabel: "取消" },
    {
      type: "form",
      submit: { id: "facts-add" },
      submitLabel: "添加一条",
      children: [
        { type: "textField", label: "新事实（一句话）", bind: "data.sFactNew", required: true, maxLength: 200 },
      ],
    },
    actions(act("立即更新", "facts-run", undefined, "sparkle")),
    caption(b("data.factsRunText")),
    caption("事实由模型在 dream 巩固后自己维护；手填的画像永远优先，事实不会覆盖它。"),
  ];
}

function choroPanel(state) {
  return [
    select("仓库", "data.choroRepo", b("data.choroRepoOptions"), "choro-repo"),
    { type: "list", items: b("data.choroRows") },
    text(b("data.choroNote"), { size: "caption" }),
    fold("模块页", [mono(b("data.choroPageText"))], false),
    { type: "confirm", id: "choro-run", confirmLabel: "重建骨架", cancelLabel: "取消" },
    caption("重建会把已富化的模块页退回骨架；语义段要命令行 --t1 重新生成。"),
  ];
}

function panelBody(state) {
  switch (state.sPanel) {
    case "facts":
      return factsPanel(state);
    case "choro":
      return choroPanel(state);
    case "workbench":
      return workbenchPanel();
    case "commands":
      return commandsPanel(state);
    case "vector":
      return vectorPanel();
    case "external":
      return externalPanel();
    case "help":
      return helpPanel();
    default:
      return [];
  }
}

function panelPage(state) {
  return [
    actions(act("返回", "back", undefined, "reply"), act("刷新", "refresh", undefined, "refresh")),
    heading(PANEL_TITLES[state.sPanel] ?? "设置"),
    ...panelBody(state),
  ];
}

function settingsBody(state) {
  if (state.page === "profile") return profilePage(state);
  if (state.page === "conflict") return conflictPage(state);
  if (state.sPanel !== "menu") return panelPage(state);
  return settingsMenu(state);
}

function statusBody(state) {
  return [
    {
      type: "grid",
      columns: 2,
      children: [
        metric("记忆总数", "data.totalText"),
        metric("近 30 天注入", "data.injectedText"),
        metric("注入命中率", "data.slotRateText", "good"),
        metric("待确认冲突", "data.conflictsText", state.pendingConflicts > 0 ? "warn" : undefined),
      ],
    },
    ...statusSection(state),
    actions(act("刷新", "refresh", undefined, "refresh")),
  ];
}

export function settingsTab(state) {
  const view = SETTINGS_VIEWS.includes(state.settingsView) ? state.settingsView : "settings";
  return [
    {
      type: "segmented",
      label: "\u200b",
      bind: "data.settingsView",
      options: [
        { label: "设置", value: "settings" },
        { label: "状态", value: "status" },
      ],
      onChange: { id: "switch-settings-view" },
    },
    ...(view === "status" ? statusBody(state) : settingsBody(state)),
  ];
}

export function profilePage(state) {
  const nodes = [
    actions(act("返回", "back", undefined, "reply"), act("刷新", "refresh", undefined, "refresh")),
    {
      type: "segmented",
      label: "\u200b",
      bind: "data.profileTab",
      options: [
        { label: "画像", value: "profile" },
        { label: "规则", value: "rules" },
        { label: "人格", value: "persona" },
      ],
      onChange: { id: "profile-tab" },
    },
  ];
  if (state.profileTab === "persona") {
    nodes.push(kv(b("data.previewItems")));
    nodes.push(fold("人格设定", [mono(b("data.personaText"))], false));
    return nodes;
  }
  nodes.push({
    type: "textField",
    label: state.profileTab === "rules" ? "规则（JSON 数组）" : "用户画像",
    bind: "data.editText",
    multiline: true,
    maxLines: 8,
    maxLength: 4000,
  });
  nodes.push(actions(act("保存", "profile-save", undefined, "save")));
  if (state.profileTab === "profile") {
    nodes.push(actions(act("从记忆提取草稿", "profile-extract", undefined, "sparkle")));
    if (state.extractText !== "") nodes.push(text(b("data.extractText"), { size: "caption" }));
  }
  return nodes;
}

export { panelPage };
