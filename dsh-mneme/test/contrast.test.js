import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// #178 的回归锁：面板正文色的对比度。
//
// 为什么是硬编码快照而不是现场读宿主：CI runner 上没有 DSH 安装（没有
// app.asar），宿主 token 表根本读不到；而这条锁要在 CI 上拦住「面板又用回了
// 一个低对比度的宿主 token」。所以把面板实际引用到的宿主 token 浅/深取值抄成
// 快照（2026-10 取自 DSH app.asar 的 token 表：body = 浅色、
// body[data-ds-dark-theme] = 深色、:root = 两主题同值），锁的是**面板自己的
// 用法**，宿主改色不会让这条锁变红。
//
// 面板的坑有两层，这条锁两层都咬：
//   ① 宿主 token 在浅色下给正文只有 1.26–4.49 的对比度（label-tertiary 50 处、
//      label-dimmed 4 处），照抄宿主名就等于照抄不合规——注意这两个名字**都是
//      真实存在的**宿主 token，只是宿主把它们定位成分隔线/占位符的低对比层；
//   ② 面板还长期引用 5 个**根本不存在的**宿主名（--dsw-alias-state-error /
//      -warning / -success / -warn / --dsw-alias-border），
//      于是吃的一直是写在 fallback 里的硬编码色。所以除了比值，还要锁「引用到的
//      宿主名必须真实存在」。
//
// 修法是面板自有的语义色层（--mneme-*，定义在 .mneme-x 等四个渲染根上），
// 混色基准仍是宿主 token，宿主换肤时跟着走。见 lib/client.js 里那段注释。

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientSource = readFileSync(join(root, "lib/client.js"), "utf8");

const HOST_TOKENS = {
  "--dsw-alias-label-primary": { light: "#0f1115", dark: "#f9fafb" },
  "--dsw-alias-label-secondary": { light: "#61666b", dark: "#cfd3d6" },
  "--dsw-alias-label-tertiary": { light: "#81858c", dark: "#adb2b8" },
  // 真名，不是幻影：宿主确有 --dsw-alias-label-dimmed（指向 static-neutral-bluish-200
  // / -750）。它留在快照里是为了让存在性锁**不**把它当幻影报错——该拦的是「拿它当
  // 正文/图形色」的用法，那由上面的比值锁负责。
  "--dsw-alias-label-dimmed": { light: "#e1e5ee", dark: "#43454a" },
  "--dsw-alias-state-business-primary": { light: "#4176e6", dark: "#7aaaff" },
  "--dsw-alias-state-error-primary": { light: "#ec1313", dark: "#f25a5a" },
  "--dsw-alias-bg-layer-1": { light: "#ffffff", dark: "#232324" },
  "--dsw-alias-bg-layer-2": { light: "#ffffff", dark: "#2c2c2e" },
  "--dsw-alias-bg-base": { light: "#ffffff", dark: "#151517" },
  "--dsw-alias-button-elevated-fill": { light: "#ffffff", dark: "#43454a" },
  "--dsw-alias-border-l1": { light: "#0000000a", dark: "#ffffff0f" },
  "--dsw-alias-border-l2": { light: "#0000001a", dark: "#ffffff1f" },
  "--dsw-alias-interactive-bg-hover": { light: "#2631480f", dark: "#ffffff14" },
  "--dsw-alias-interactive-bg-active": { light: "#2631481a", dark: "#ffffff24" },
  "--dsw-alias-scrollbar-bg-l2": { light: "#e5e5e5", dark: "#545557" },
  "--dsw-alias-scrollbar-hover-l2": { light: "#d4d4d4", dark: "#65676b" },
  "--dsw-static-amber-600": { light: "#dd8629", dark: "#dd8629" },
  "--dsw-static-green-500": { light: "#22c55e", dark: "#22c55e" },
  // 真实存在但**不是颜色**的宿主 token：只参与上面的「名字必须存在」检查。
  "--dsw-radius-md": { light: null, dark: null },
  "--dsw-focus-ring-width": { light: null, dark: null },
  "--dsw-focus-ring-color": { light: "transparent", dark: "transparent" }
};

/* ---------- 从面板产物里切出 CSS 块 ---------- */
const cssStart = clientSource.indexOf("const css = [");
const cssEnd = clientSource.indexOf('].join("\\n");', cssStart);
assert.ok(cssStart > 0 && cssEnd > cssStart, "lib/client.js 里找不到 CSS 数组（切片锚点变了？）");
const cssBlock = clientSource.slice(cssStart, cssEnd);

const rules = [];
for (const m of cssBlock.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
  const s = m[1].replace(/\\"/g, '"');
  if (!s.includes("{")) continue;
  const rm = /^([^{]+)\{([^}]*)\}$/.exec(s.trim());
  if (rm) rules.push({ sel: rm[1].trim(), body: rm[2] });
}

/* ---------- 颜色数学（alpha 合成，不是「和白底混」） ---------- */
function parseColor(c) {
  let m;
  if ((m = /^#([0-9a-fA-F]{3,8})$/.exec(String(c).trim()))) {
    let s = m[1];
    if (s.length === 3 || s.length === 4) s = s.split("").map((x) => x + x).join("");
    return [
      parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16),
      s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1
    ];
  }
  if ((m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(String(c).trim()))) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [+m[1], +m[2], +m[3], a];
  }
  return null;
}
// 半透明前景必须真的叠到底色上再算比值：早期审计脚本拿「和白底混」量深色主题，
// 把 --dsw-alias-label-primary 60% 算成 15.36 的假高分（真实值 6.30）。
function composite(top, bottom) {
  const a = top[3] + bottom[3] * (1 - top[3]);
  const f = (i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / (a || 1);
  return [f(0), f(1), f(2), a];
}
function luminance([r, g, b]) {
  const [x, y, z] = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * x + 0.7152 * y + 0.0722 * z;
}
function contrast(fg, bg) {
  const a = luminance(composite(fg, bg));
  const b = luminance(bg);
  const [hi, lo] = [a, b].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/* ---------- 解析：宿主快照 + 面板自己的语义色层 ---------- */
const TOKENS = new Map();
for (const [name, v] of Object.entries(HOST_TOKENS)) TOKENS.set(name, v);

// 面板语义色层是一条由多个字符串字面量拼起来的规则，不出现在上面的 rules 里，
// 所以按拼好的文本再读一次。
const joined = [...cssBlock.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\"/g, '"')).join("");
const layerM = /([^{}]*)\{[^{}]*--mneme-fg-dim\s*:[^{}]*\}/.exec(joined);
assert.ok(layerM, "找不到面板语义色层（--mneme-* 定义），四个渲染根那条规则被删了？");
const layer = { sel: layerM[1].split("}").pop().trim(), body: layerM[0].slice(layerM[0].indexOf("{")) };
for (const g of layer.body.matchAll(/(--mneme-[a-z0-9-]+)\s*:\s*([^;}]+)/g)) {
  TOKENS.set(g[1], { light: g[2].trim(), dark: g[2].trim() });
}

// 先把 var()/color-mix() 逐层折成字符串，再交给 colorOf 解析成 RGBA。
// 之所以不用「一个递归函数同时返回数组和字符串」：字符串替换里塞数组会被打散。
function resolveValue(raw, theme) {
  let v = String(raw).trim().replace(/!important$/, "").trim();
  let changed = true;
  for (let guard = 0; changed && guard < 20; guard++) {
    changed = false;
    v = v.replace(/var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (_, tok, fb) => {
      const e = TOKENS.get(tok);
      const inner = e ? resolveValue(e[theme], theme) : null;
      if (inner) { changed = true; return inner; }
      if (fb) { changed = true; return fb.trim(); }
      return "\u00acMISSING\u00ac";
    });
  }
  return v.includes("\u00acMISSING\u00ac") ? null : v.trim();
}
function colorOf(raw, theme) {
  const v = resolveValue(raw, theme);
  if (v === null) return null;
  let m = /^color-mix\(\s*in\s+srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*transparent\s*\)$/.exec(v);
  if (m) {
    const base = colorOf(m[1], theme);
    if (!base) return null;
    return [...base.slice(0, 3), base[3] * (parseFloat(m[2]) / 100)];
  }
  m = /^color-mix\(\s*in\s+srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)\s*\)$/.exec(v);
  if (m) {
    const a = colorOf(m[1], theme);
    const b = colorOf(m[3], theme);
    if (!a || !b) return null;
    const p = parseFloat(m[2]) / 100;
    return [...a.slice(0, 3).map((x, i) => x * p + b[i] * (1 - p)), a[3] * p + b[3] * (1 - p)];
  }
  return parseColor(v);
}

/* ---------- 底色：按类名找它自己的 background ---------- */
const BG_BY_CLASS = new Map();
for (const r of rules) {
  const bg = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/.exec(r.body);
  if (!bg) continue;
  for (const c of r.sel.matchAll(/\.([a-z0-9-]+)/gi)) {
    const k = c[1].toLowerCase();
    if (!BG_BY_CLASS.has(k)) BG_BY_CLASS.set(k, []);
    BG_BY_CLASS.get(k).push({ val: bg[1].trim(), sel: r.sel });
  }
}
const THEME_BG = { light: "#ffffff", dark: "#232324" }; // --dsw-alias-bg-layer-1
function backgroundOf(sel, theme) {
  const base = parseColor(THEME_BG[theme]);
  const own = [];
  for (const c of sel.matchAll(/\.([a-z0-9-]+)/gi)) {
    for (const e of BG_BY_CLASS.get(c[1].toLowerCase()) ?? []) {
      if (!/hover|active|focus|disabled/.test(e.sel)) own.push(e);
    }
  }
  for (const e of own) {
    const v = colorOf(e.val, theme);
    if (v) return v[3] < 1 ? composite(v, base) : v;
  }
  return base;
}

/* ---------- 逐条算 ---------- */
const failures = [];
let audited = 0;
for (const r of rules) {
  const colM = /(?:^|;)\s*color\s*:\s*([^;]+)/.exec(r.body);
  if (!colM) continue;
  if (/::(before|after)/.test(r.sel)) continue;
  const fsM = /font-size\s*:\s*([\d.]+)px/.exec(r.body);
  const fwM = /font-weight\s*:\s*([\d]+|bold|normal)/.exec(r.body);
  const fs = fsM ? +fsM[1] : 13;
  const fw = fwM ? (/bold/.test(fwM[1]) ? 700 : fwM[1] === "normal" ? 400 : +fwM[1]) : 400;
  const need = fs >= 24 || (fs >= 18.66 && fw >= 700) ? 3 : 4.5;
  for (const theme of ["light", "dark"]) {
    const fg = colorOf(colM[1], theme);
    // 解析不出来**不算通过**：面板 CSS 块里的 color 全是 hex/rgb/var/color-mix
    // （没有 inherit/currentColor 之类的关键字），所以 null 只可能意味着引用了
    // 不存在的 token 或写了个解析器不认识的值——那正是要拦的东西。若在这里
    // `continue`，把一条声明改成 `color:var(--mneme-unknown)` 就能静默溜过，
    // 剩下的声明仍然够 audited >= 200。
    if (!fg) {
      failures.push(`${theme} ${r.sel} 颜色解析失败：${colM[1].trim()}`);
      continue;
    }
    audited++;
    const cr = contrast(fg, backgroundOf(r.sel, theme));
    if (cr < need) {
      failures.push(`${theme} ${r.sel} ${fs}px/${fw} = ${cr.toFixed(2)} < ${need}（${colM[1].trim()}）`);
    }
  }
}

test("面板每个 color 声明在浅/深两主题下都达到 WCAG AA（#178 主锁）", () => {
  assert.ok(audited >= 200, `审计到的 color 声明太少（${audited}），CSS 切片或解析器可能失效了`);
  assert.deepEqual(failures, [], "以下声明对比度不足：\n" + failures.join("\n"));
});

// 幻影 token 的回归锁：面板曾经引用 5 个宿主里不存在的名字，于是长年吃 fallback
// 里的硬编码色（换肤不跟随、深色主题翻车）。这条锁不看比值、只看名字是否存在，
// 因此将来任何「顺手写个听起来合理的 --dsw-* 名」都会被拦下。
test("面板引用的宿主 token 必须真实存在（幻影 token 回归锁）", () => {
  // 只扫真实声明：CSS 数组里夹着 JS 注释，注释里会提到被修掉的旧名。
  const declared = cssBlock.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const referenced = new Set([...declared.matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0]));
  const unknown = [...referenced].filter((n) => !(n in HOST_TOKENS));
  assert.deepEqual(unknown, [], "面板引用了宿主快照里没有的 token（幻影名或快照过期）：" + unknown.join(", "));
});

// 变量层必须挂满四个渲染根：面板不只长在 .mneme-x 下——记忆库 sheet portal 到
// body（.mneme-overlay）、侧边栏入口在宿主插槽（.mneme-triggerwrap）、顶部入口
// portal 到宿主侧边栏（.mneme-topentry）。少挂一个，那个根下的文字就退回宿主的
// 低对比度 token，而且上面的主锁**照样全绿**（主锁只算颜色，不知道变量有没有继承到）。
test("面板语义色层覆盖四个渲染根", () => {
  const sel = layer.sel;
  assert.equal(sel, ".mneme-x,.mneme-overlay,.mneme-triggerwrap,.mneme-topentry");
});

// 图形色的对比度（WCAG 1.4.11，非文字 3:1）。上面那条主锁只看 `color:`，
// 而「颜色就是信息」的地方用的是 `background:` / `stroke:`——热度条、热度点、
// 打卡点、关系图连线。它们此前用宿主的 label-dimmed（浅 1.26 / 深 1.45），
// 等于把三档热度画成同一个看不见的灰。谁把它们改回去，主锁不会响，这条会。
const GRAPHICS = [
  { sel: ".mneme-heatbar--hot", prop: "background" },
  { sel: ".mneme-heatbar--warm", prop: "background" },
  { sel: ".mneme-heatbar--cold", prop: "background" },
  { sel: ".mneme-heatdot--hot", prop: "background" },
  { sel: ".mneme-heatdot--warm", prop: "background" },
  { sel: ".mneme-heatdot--cold", prop: "background" },
  { sel: ".mneme-wbdot", prop: "background" },
  { sel: ".mneme-wbdot--err", prop: "background" },
  { sel: ".mneme-gedge", prop: "stroke" },
  // Token 去向三屏（2026-10）：donut 弧（stroke）、图例色点与 7 天柱（background）
  // 都是「颜色就是信息」的图形——弧长/点位承载比例语义，掉回浅灰等于白画。
  // 零值热力格（interactive-bg-hover 轨道）与 heatbar 同理不在此列。
  { sel: ".mneme-seg--1", prop: "stroke" },
  { sel: ".mneme-seg--2", prop: "stroke" },
  { sel: ".mneme-seg--3", prop: "stroke" },
  { sel: ".mneme-seg--4", prop: "stroke" },
  { sel: ".mneme-seg--5", prop: "stroke" },
  { sel: ".mneme-seg--6", prop: "stroke" },
  { sel: ".mneme-dot--1", prop: "background" },
  { sel: ".mneme-dot--2", prop: "background" },
  { sel: ".mneme-dot--3", prop: "background" },
  { sel: ".mneme-dot--4", prop: "background" },
  { sel: ".mneme-dot--5", prop: "background" },
  { sel: ".mneme-dot--6", prop: "background" },
  { sel: ".mneme-bar", prop: "background" },
  { sel: ".mneme-heatcell.l1", prop: "background" },
  { sel: ".mneme-heatcell.l2", prop: "background" },
  { sel: ".mneme-heatcell.l3", prop: "background" },
  { sel: ".mneme-heatcell.l4", prop: "background" }
];
test("图形色（热度/打卡/连线）在浅深两主题下都达到 3:1", () => {
  const bySel = new Map(rules.map((r) => [r.sel, r]));
  const problems = [];
  for (const g of GRAPHICS) {
    const r = bySel.get(g.sel);
    if (!r) { problems.push(`${g.sel} 规则没了`); continue; }
    const m = new RegExp(`(?:^|;)\\s*${g.prop}\\s*:\\s*([^;]+)`).exec(r.body);
    if (!m) { problems.push(`${g.sel} 没有 ${g.prop}`); continue; }
    for (const theme of ["light", "dark"]) {
      const fg = colorOf(m[1], theme);
      if (!fg) { problems.push(`${g.sel} 解析不出颜色：${m[1]}`); continue; }
      // 热度条画在它自己的轨道（interactive-bg-hover）上，其余直接压在画布上。
      let bg = parseColor(THEME_BG[theme]);
      if (/heatbar/.test(g.sel)) {
        const track = colorOf("var(--dsw-alias-interactive-bg-hover)", theme);
        if (track) bg = composite(track, bg);
      }
      const cr = contrast(fg, bg);
      if (cr < 3) problems.push(`${theme} ${g.sel} ${cr.toFixed(2)} < 3（${m[1].trim()}）`);
    }
  }
  assert.deepEqual(problems, [], "图形色对比度不足：\n" + problems.join("\n"));
});

// 虚线关系边曾经在 .mneme-gedge-dashed 上再叠一层 opacity:.7，把已经只有 50% 的
// 描边压到浅色 2.28（低于图形 3:1）。上面那条图形锁只读单条规则自己的 stroke，
// 看不到「同一条边同时命中两条规则、其中一条在降透明度」这种叠加，所以单独锁一层：
// 虚线态只允许用 dash 图案区分，不许再动透明度。
test("虚线关系边不得靠降低不透明度区分", () => {
  const dashed = rules.find((r) => r.sel === ".mneme-gedge-dashed");
  assert.ok(dashed, ".mneme-gedge-dashed 规则没了（虚线态怎么区分无 memory_id 的边？）");
  const op = /(?:^|;)\s*opacity\s*:\s*([^;]+)/.exec(dashed.body);
  assert.equal(op, null, `虚线边又叠了 opacity（${op?.[1].trim()}）：50% 描边乘上它会在浅色画布跌破 3:1`);
  assert.match(dashed.body, /stroke-dasharray/, "虚线态丢了 dash 图案，就和实线边分不出来了");
});