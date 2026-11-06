// 实体 section: entity catalogue with a search box, plus one entity's
// attributes and relations (mneme's graph ego network, without the SVG map).
import { act, actions, b, badge, caption, fold, heading, kv, metric, select, text } from "./common.js";

const DEPTH_OPTIONS = [
  { label: "只看直接关系", value: "1" },
  { label: "再看两层", value: "2" },
];

function entityList() {
  // 这里曾经按 state.entityTotal === 0 换成一块空状态：视图结构在首屏就
  // 定死了，而数据是随后才推来的，于是实体已经有了、空状态块还挂在上面。
  // 现在结构固定，空库的提示由 data.entityStatus 这一行文案承载。
  return [
    {
      type: "grid",
      columns: 2,
      children: [metric("实体总数", "data.entityTotalText"), metric("类型数", "data.entityTypeTotalText")],
    },
    {
      type: "form",
      submit: { id: "entity-search" },
      submitLabel: "搜索实体",
      children: [{ type: "textField", label: "按名字找", bind: "data.entityQuery", placeholder: "留空显示全部" }],
    },
    { type: "list", items: b("data.entities") },
    caption(b("data.entityStatus")),
    actions(act("刷新", "refresh", undefined, "refresh")),
  ];
}

function entityDetail(state) {
  return [
    actions(act("返回", "back", undefined, "reply"), act("刷新", "refresh", undefined, "refresh")),
    { type: "row", children: [heading(b("data.entityName")), badge(b("data.entityType"), "info")] },
    caption(b("data.entityMentionText")),
    select("关系深度", "data.entityDepth", DEPTH_OPTIONS, "entity-depth"),
    fold("属性", [kv(b("data.entityAttrs"))], true),
    fold("关系", [{ type: "list", items: b("data.entityRelations") }], true),
    fold("提及它的记忆", [{ type: "list", items: b("data.entityMemories") }], false),
    text(b("data.entityHint"), { size: "caption" }),
  ];
}

export function entitySection(state) {
  if (state.page === "entity") return entityDetail(state);
  return entityList(state);
}
