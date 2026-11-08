// 运行状态: the runtime picture mneme's own Status tab shows, grouped into
// collapsible blocks so the settings tab stays short.
import { act, actions, b, caption, chart, fold, heading, kv } from "./common.js";

export function statusSection(state) {
  return [
    fold("库内一览", [kv(b("data.statusKv"))], true),
    fold("注入与召回", [kv(b("data.injectKv")), heading("常被召回"), { type: "list", items: b("data.topRows") }], true),
    fold("注入预览", [caption(b("data.injectPreviewText"))], false),
    fold("后台巩固", [kv(b("data.dreamKv")), { type: "list", items: b("data.runRows") }], false),
    fold(
      "模型用量",
      [
        {
          type: "chart",
          kind: "bar",
          categories: b("data.tokenCategories"),
          series: b("data.tokenSeries"),
          unit: "次",
          caption: "近 28 天",
        },
        kv(b("data.tokenKv")),
      ],
      false,
    ),
    fold(
      "热度分布",
      [
        { type: "chart", kind: "bar", categories: ["热", "温", "冷"], series: b("data.heatSeries"), unit: "条" },
        caption(b("data.heatNote")),
      ],
      false,
    ),
    fold("冲突队列", [actions(act("打开冲突队列", "open-conflict", undefined, "warning"))], false),
    fold("工作动态", [actions(act("打开工作动态", "open-panel", { k: "workbench" }, "todo"))], false),
    fold(
      "维护",
      [
        actions(
          act("检查可回收", "reclaim", undefined, "clear"),
          act("真跑回收", "reclaim-prepare", undefined, "delete"),
        ),
        ...(state.reclaimConfirm === true
          ? [{ type: "confirm", id: "reclaim-run", confirmLabel: "真跑回收", cancelLabel: "取消" }]
          : []),
        caption(b("data.reclaimText")),
      ],
      false,
    ),
  ];
}
