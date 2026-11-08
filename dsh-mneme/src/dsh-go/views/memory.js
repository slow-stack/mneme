// 记忆 section: list (search + filters + month view), detail, editor, and the
// conflict queue that mneme's own drawer keeps one click away from a memory.
import {
  FILTER_TYPE_OPTIONS,
  MINIMP_OPTIONS,
  RANGE_OPTIONS,
  SCOPE_OPTIONS,
  TYPE_OPTIONS,
  VIEW_OPTIONS,
  typeLabel,
} from "../text.js";
import { act, actions, b, badge, caption, divider, empty, fold, heading, kv, select, text, toggle } from "./common.js";

function filterBar(state) {
  return fold(
    "筛选与视图",
    [
      select(
        "类型",
        "data.filter",
        [
          { label: "全部类型", value: "all" },
          ...FILTER_TYPE_OPTIONS.map((type) => ({ label: typeLabel(type), value: type })),
        ],
        "type-filter",
      ),
      select("时间范围", "data.fRange", RANGE_OPTIONS, "set-range"),
      select("重要度", "data.fMin", MINIMP_OPTIONS, "set-minimp"),
      select("来源", "data.fScope", SCOPE_OPTIONS, "set-scope"),
      select("视图", "data.fView", VIEW_OPTIONS, "set-view"),
      toggle("语义检索", "data.fSemantic", "toggle-semantic"),
      toggle("热度优先", "data.fHeat", "toggle-heat"),
    ],
    state.filtersOpen,
  );
}

function monthsView(state) {
  const groups = Array.isArray(state.monthGroups) ? state.monthGroups : [];
  if (groups.length === 0) return [{ type: "list", items: b("data.rows") }];
  return groups.map((group) => fold(group.label, [{ type: "list", items: group.rows }], true));
}

function memoryList(state) {
  return [
    {
      type: "form",
      submit: { id: "search" },
      submitLabel: "搜索",
      children: [{ type: "textField", label: "搜索记忆", bind: "data.query", placeholder: "标题或正文，留空返回全部" }],
    },
    actions(act("新记忆", "new", undefined, "add"), act("刷新", "refresh", undefined, "refresh")),
    filterBar(state),
    ...(state.viewMode === "month" ? monthsView(state) : [{ type: "list", items: b("data.rows") }]),
    // 翻页用 App 原生的两段 segmented：每段最少 80dp、两段正好铺满一行，
    // 不会像按钮组那样折成上下两行（面板只有约 297dp 宽）。
    // 页码文案挂在 label 上（binding data.pageText），顺带替掉独立的说明行。
    // 空列表也走同一条路：视图结构在首屏就定死了，按数据决定「要不要这块」
    // 会留下错误的残影（列表已经推来 N 条，空状态块却还在），所以这里不放
    // 任何依赖数据的结构分支，只把「没有匹配」写进页码文案里。
    {
      type: "segmented",
      label: b("data.pageText"),
      bind: "data.pagePick",
      options: [
        { label: "上一页", value: "prev" },
        { label: "下一页", value: "next" },
      ],
      onChange: { id: "page" },
    },
  ];
}

function memoryDetail(state) {
  const archived = state.current?.archived === true;
  return [
    actions(
      act("返回", "back", undefined, "reply"),
      act("编辑", "edit", undefined, "edit"),
      archived ? act("恢复", "unarchive", undefined, "refresh") : act("归档", "archive", undefined, "archive"),
    ),
    text(b("data.detailTitle"), { size: "title", weight: "semibold" }),
    {
      type: "row",
      children: [
        badge(b("data.detailType"), state.detailTypeTone ?? "info"),
        text(b("data.detailStars"), { size: "caption", weight: "medium" }),
      ],
    },
    ...(state.detailConflict === true
      ? [{ type: "callout", text: "这条记忆已进入冲突队列，可在「设置 › 状态 › 冲突队列」里裁决。", tone: "warn" }]
      : []),
    kv(b("data.detailMeta")),
    fold("正文", [text(b("data.detailContent"))], true),
    fold("相关实体", [{ type: "list", items: b("data.detailEntities") }], false),
    fold(
      "来源与溯源",
      [
        actions(act("查看来源", "provenance", undefined, "history")),
        text(b("data.provenanceText"), { size: "caption" }),
      ],
      false,
    ),
    actions(act("复制", "copy", undefined, "copy"), act("插入输入框", "insert", undefined, "paste")),
    fold("删除这条记忆", [{ type: "confirm", id: "delete", confirmLabel: "删除", cancelLabel: "取消" }], false),
  ];
}

function memoryEditor(state) {
  return [
    actions(act("取消", "back")),
    {
      type: "form",
      submit: { id: "save" },
      submitLabel: "保存",
      children: [
        { type: "textField", label: "标题", bind: "data.form.title", required: true, maxLength: 200 },
        { type: "textField", label: "正文", bind: "data.form.content", multiline: true, maxLines: 6, maxLength: 2000 },
        ...(state.form?.id === "" || state.form?.id === undefined
          ? [
              select(
                "类型",
                "data.form.type",
                TYPE_OPTIONS.map((type) => ({ label: typeLabel(type), value: type })),
                "form-type",
              ),
            ]
          : [text(`类型：${typeLabel(state.form?.type)}（保存后不能改）`, { size: "caption" })]),
        { type: "stepper", label: "重要度", bind: "data.form.importance", min: 1, max: 5 },
        { type: "textField", label: "标签", bind: "data.form.tags", placeholder: "逗号分隔" },
        ...(state.form?.id === "" || state.form?.id === undefined
          ? []
          : [
              { type: "textField", label: "归属 Agent", bind: "data.form.agentScope", placeholder: "留空 = 全局" },
              { type: "textField", label: "归属工作区", bind: "data.form.workspaceScope", placeholder: "留空 = 全局" },
            ]),
      ],
    },
  ];
}

// ------------------------------------------------------------- conflict queue
export function conflictPage(state) {
  const nodes = [
    actions(act("返回", "back", undefined, "reply"), act("刷新", "refresh", undefined, "refresh")),
    heading("冲突队列"),
    caption("冻结的矛盾记忆，等待人工确认"),
  ];
  if (state.conflictCount === 0) {
    nodes.push(empty("没有待裁决的冲突", undefined, "check"));
    return nodes;
  }
  nodes.push({ type: "list", items: b("data.conflictRows") });
  if (state.conflictReady !== true) return nodes;
  nodes.push(divider());
  nodes.push(
    fold(
      "版本 A",
      [
        text(b("data.conflictATitle"), { size: "subtitle", weight: "semibold" }),
        kv(b("data.conflictAMeta")),
        text(b("data.conflictAContent")),
      ],
      true,
    ),
  );
  nodes.push(
    fold(
      "版本 B",
      [
        text(b("data.conflictBTitle"), { size: "subtitle", weight: "semibold" }),
        kv(b("data.conflictBMeta")),
        text(b("data.conflictBContent")),
      ],
      false,
    ),
  );
  nodes.push(
    actions(
      act("采用 A", "conflict-pick", { winner: "a" }, "check"),
      act("采用 B", "conflict-pick", { winner: "b" }, "check"),
      act("都不采用", "conflict-pick", { winner: "none" }, "remove"),
    ),
  );
  if (state.conflictPick !== "") {
    const label = state.conflictPick === "a" ? "采用 A" : state.conflictPick === "b" ? "采用 B" : "都不采用";
    nodes.push({ type: "confirm", id: "conflict-win", confirmLabel: label, cancelLabel: "取消" });
    nodes.push(caption("确认后：保留方正文追加已否决注记，另一方归档。"));
  }
  return nodes;
}

export function memorySection(state) {
  if (state.page === "conflict") return conflictPage(state);
  if (state.page === "detail") return memoryDetail(state);
  if (state.page === "editor") return memoryEditor(state);
  return memoryList(state);
}
