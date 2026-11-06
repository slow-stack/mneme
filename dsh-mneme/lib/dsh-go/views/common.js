// Small builders shared by every panel section.
export const b = (path) => ({ $: path });
export const text = (value, style) => ({ type: "text", text: value, ...(style === undefined ? {} : { style }) });
export const heading = (value) => text(value, { size: "subtitle", weight: "semibold" });
export const caption = (value) => text(value, { size: "caption" });
export const mono = (value) => text(value, { size: "mono" });
export const act = (label, id, args, icon) => ({
  label,
  ...(icon === undefined ? {} : { icon }),
  action: args === undefined ? { id } : { id, args },
});
export const actions = (...items) => ({ type: "actions", items });
export const kv = (items) => ({ type: "keyValue", items });
// 只接受两种来源：字面文案，或调用方显式构造好的绑定对象 { $: path }。
// 曾经把 "data.err" 这样的路径当字符串传进来，这里又原样当字面量下发，于是
// 面板把路径本身显示成一句提示（评审 #12）——绑定的构造统一由 b() 负责。
export const callout = (src, tone) => ({
  type: "callout",
  text: typeof src === "string" ? src : src,
  tone,
});
export const fold = (label, children, expanded = false) => ({ type: "collapsible", label, expanded, children });
export const metric = (label, value, tone) => ({
  type: "metric",
  label,
  value: b(value),
  ...(tone === undefined ? {} : { tone }),
});
export const divider = () => ({ type: "divider" });
// tone 只接受枚举值，不能绑定（schema 的 badgeV2.tone 是纯枚举），所以第二个
// 参数只能是字面色，不能是 "data.xxx" 这样的路径；文案同理，绑定要传 b(path)。
export const badge = (src, tone) => ({
  type: "badge",
  text: src,
  ...(tone === undefined ? {} : { tone }),
});
export const empty = (title, message, icon, action) => ({
  type: "emptyState",
  title,
  ...(message === undefined ? {} : { message }),
  ...(icon === undefined ? {} : { icon }),
  ...(action === undefined ? {} : { action }),
});
export const select = (label, bind, options, onChange) => ({
  type: "select",
  label,
  bind,
  options,
  onChange: { id: onChange },
});
export const toggle = (label, bind, onChange) => ({ type: "toggle", label, bind, onChange: { id: onChange } });

const NOTICE_TONES = { ok: "good", warn: "warn", bad: "bad" };

export function notices(state) {
  if (state.err) return [callout(b("data.err"), "bad")];
  if (state.notice) return [callout(b("data.notice"), NOTICE_TONES[state.noticeTone] ?? "info")];
  return [];
}

export const chart = (kind, categories, series, unit, captionText) => ({
  type: "chart",
  kind,
  categories,
  series,
  ...(unit === undefined ? {} : { unit }),
  ...(captionText === undefined ? {} : { caption: captionText }),
});
