import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 面板几何刻度层的回归锁（视觉系统 P0+P1a，docs/plans/2026-11-10-panel-visual-system.md）。
//
// 它咬五类漂移，每一类都真的发生过：
//   ① 间距靠手写：padding 曾长出 107 种取值、只有 41.7% 落 4 网格、29% 是奇数像素。
//      现在 CSS 里每一处 px 都必须在「刻度集」或「已登记的存量」里，且存量**只许减
//      不许增**——新加一个 padding:11px 会红，把一处 11px 改成 8px 不会红（那是迁移）。
//   ② 刻度定义散架：token 少了、值改了、挂的渲染根从五个变成四个，都会红。
//   ③ 原语被绕过：GEOMETRY 之外的键（9 / 10 / "8px"）必须当场抛错，宁可渲染炸掉，
//      也不要多出第 108 种间距——后者没人会注意，前者一进测试就红。
//   ④ CSS 与 GEOMETRY 各说一套：两边的键必须一一对应，刻度加了 CSS 没加（或反过来）也红。
//   ⑤ 迁移做一半：P1b 之后状态页的间距/圆角必须整页来自刻度，混回一个 padding:10px
//      就红——半迁移比不迁移更难读，因为看代码的人分不清哪个数是准的。
//
// 变异自证（PR 里要附）：把 client.js 里任一处 `padding:0 16px` 改成 `padding:0 17px`
// → 本文件第 2 条用例红；把 GEOMETRY.space 里的 12 删掉但保留 --mneme-space-12
// → 第 4 条红；把 .mneme-paneliglyph 从 token 规则的选择器里删掉 → 第 3 条红；
// 把状态页任一处 var(--mneme-space-12) 改回 12px → 第 6 条红。

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientSource = readFileSync(join(root, "lib/client.js"), "utf8");

/* ---------- 切片：与 test/contrast.test.js 同一对锚点 ---------- */
const cssStart = clientSource.indexOf("const css = [");
const cssEnd = clientSource.indexOf('].join("\\n");', cssStart);
assert.ok(cssStart > 0 && cssEnd > cssStart, "lib/client.js 里找不到 CSS 数组（切片锚点变了？）");
const cssBlock = clientSource.slice(cssStart, cssEnd);

// 注释里的 px 是散文（「隐掉 14px 的 tab 图标」），不是声明；只量真声明。
const declaredCss = cssBlock.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const joinedCss = [...cssBlock.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\"/g, '"')).join("");

/* ---------- 刻度集：与 client.js 的 GEOMETRY 表成对出现 ---------- */
const EXPECTED = {
  space: { 0: "0", 2: "2px", 4: "4px", 6: "6px", 8: "8px", 10: "10px", 12: "12px", 16: "16px", 20: "20px", 24: "24px", 40: "40px" },
  radius: { 4: "4px", 8: "8px", 12: "12px", pill: "999px" },
  type: { 12: "12px", 13: "13px", 15: "15px" },
  weight: { 400: "400", 600: "600" }
};

test("几何刻度定义完整且取值未漂移", () => {
  const found = {};
  for (const m of joinedCss.matchAll(/--mneme-(space|radius|type|weight)-([a-z0-9]+)\s*:\s*([^;}]+)/g)) {
    (found[m[1]] ||= {})[m[2]] = m[3].trim();
  }
  for (const [group, table] of Object.entries(EXPECTED)) {
    assert.deepEqual(found[group] || {}, table, `--mneme-${group}-* 刻度集与 GEOMETRY 不一致`);
  }
  // 反向：不许有表外的 --mneme-<group>-*。加了新档必须同时进这里和 GEOMETRY。
  for (const group of Object.keys(EXPECTED)) {
    const extra = Object.keys(found[group] || {}).filter((k) => !(k in EXPECTED[group]));
    assert.deepEqual(extra, [], `--mneme-${group}-* 出现表外档位：${extra.join(",")}`);
  }
});

test("几何刻度挂满五个渲染根（少挂一个就等于没定义）", () => {
  const m = /([^{}]*)\{[^{}]*--mneme-space-8\s*:/.exec(joinedCss);
  assert.ok(m, "找不到定义几何刻度的规则");
  const sel = m[1].split("}").pop().trim();
  assert.equal(
    sel,
    ".mneme-x,.mneme-overlay,.mneme-triggerwrap,.mneme-topentry,.mneme-paneliglyph",
    "几何刻度必须和语义色层挂同一组五个根：overlay / 侧栏插槽 / 顶部入口 / 宿主 panelGlyph 都不在 .mneme-x 子树里"
  );
});

/* ---------- 存量棘轮：px 只许减少，不许新增 ---------- */
// 逐值计数，冻结在「本 PR 合进来的那棵树」上：ef8f9ce 之后 main 又合了 #642（情感归属可见），
// 它自己在 client.js 里带进 21 处 px（1px +3 / 2px +2 / 3px +1 / 6px +5 / 7px +1 / 8px +2 /
// 11px +4 / 14px +1 / 16px +2），所以下表 = ef8f9ce 基线 − 本分支的迁移 + #642 的增量。
// 本分支相对 main 净减 87 处（减 89、加 2，那 2 处是 15px 字阶与 999px pill 半径这两个
// 刻度定义本身，不是手写间距）。迁移时**把数字往下改**，不要为了让测试变绿去加值——
// 加值等于把漂移写进法律；下表这次往上动，是因为 main 先涨了。
const BASELINE = {
  1: 134, 2: 72, 3: 27, 4: 46, 5: 21, 6: 88,
  7: 21, 8: 160, 9: 18, 10: 115, 11: 55, 12: 141,
  13: 53, 14: 55, 15: 12, 16: 70, 17: 27, 18: 45,
  19: 14, 20: 20, 21: 4, 22: 14, 23: 1, 24: 21,
  25: 2, 26: 12, 27: 1, 28: 10, 30: 7, 32: 11,
  34: 1, 36: 5, 40: 5, 42: 1, 44: 2, 46: 3,
  48: 3, 52: 2, 64: 2, 76: 1, 84: 2, 88: 1,
  96: 4, 108: 1, 110: 1, 120: 1, 132: 1, 148: 2,
  150: 2, 180: 6, 190: 1, 200: 4, 216: 1, 220: 4,
  224: 1, 230: 1, 232: 1, 240: 3, 252: 1, 260: 1,
  264: 1, 280: 1, 300: 4, 320: 1, 340: 2, 360: 1,
  432: 1, 452: 2, 480: 3, 500: 1, 560: 3, 620: 1,
  640: 3, 680: 1, 683: 1, 720: 3, 860: 1, 920: 1,
  960: 1, 999: 1, 1000: 7, 1240: 1, 1.5: 8, 2.5: 1,
  9.5: 4, 10.5: 4, 11.5: 9, 12.5: 15, 13.5: 6
};

// 合法例外：不登记就等于「随便写」。每条都要说清为什么它不该进刻度。
const WHITELIST = {
  1: "1px 描边/分隔线（发丝线，缩放后仍是线而不是块）",
  2: "2px 焦点环与 tab 下划线（视觉系统 half-step，非布局间距）"
};

test("CSS 里的 px 只能来自刻度或存量，存量只许减不许增", () => {
  const current = {};
  for (const m of declaredCss.matchAll(/(?<![\w.-])(\d+(?:\.\d+)?)px/g)) {
    const v = Number(m[1]);
    current[v] = (current[v] || 0) + 1;
  }
  const grew = [];
  const intruders = [];
  for (const [v, count] of Object.entries(current)) {
    const key = Number(v);
    if (key in BASELINE) {
      if (count > BASELINE[key]) grew.push(`${v}px: ${BASELINE[key]} → ${count}`);
    } else if (!(key in WHITELIST)) {
      intruders.push(`${v}px × ${count}`);
    }
  }
  assert.deepEqual(intruders, [], "出现刻度外的 px 取值（先问它该不该是一个新档）：" + intruders.join(", "));
  assert.deepEqual(grew, [], "存量 px 变多了（迁移应让它变少；确实要加请先想清楚是不是该用刻度）：" + grew.join(", "));
  // 白名单条目失效要报红：值在代码里消失了说明刻度或写法变了，清单没跟着走就是僵尸条目。
  for (const [v, why] of Object.entries(WHITELIST)) {
    assert.ok(Number(v) in current, `白名单里的 ${v}px 已经不在 CSS 里了（${why}）——清单该删该改？`);
  }
});

/* ---------- 迁移进度锁：状态页的几何全部来自刻度（P1b） ---------- */
// 状态视图 = 状态卡网格 + Token 三屏 + 冲突队列 + 工作台。这一片此前是「最像手写
// 排版」的一片：padding 有 16/14/10/8 四档混用，圆角有 12/10/8/3 四种，分组间距
// 26px、页尾留白 40px 都不在任何刻度上。现在全部走 token，并且这条锁不允许回退。
//
// 两个例外，都写在这里而不是放任：
//   · 1px —— 光学微调（.mneme-conflict-mark 的左右 padding 这么宽），
//     它的作用是「贴着」而不是「隔着一段」，进刻度会让文字挤在一起；
//   · 断点档（@container / @media）整体跳过：那一档是「压到正好不溢出」的贴合值
//     （14px / 32px / 30px），不是节奏；把它收进刻度等于每次调断点都要改刻度表。
const STATUS_NS = /^\.mneme-(status|stat|tokenflow|kpiband|donut|sink|legacy|wb|conflict|pending|heatbar)/;
const GEOM_PROP = /^(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left))?$/;

test("状态页的间距与圆角全部走刻度（P1b 不回退）", () => {
  const violations = [];
  let coveredRules = 0;
  let coveredDecls = 0;
  for (const raw of declaredCss.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("@")) continue;
    const m = /^"([^"]*)\{(.*)\}"?,?$/.exec(line);
    if (!m) continue;
    const selector = m[1];
    if (!selector.split(",").some((s) => STATUS_NS.test(s.trim()))) continue;
    coveredRules += 1;
    for (const decl of m[2].split(";")) {
      const at = decl.indexOf(":");
      if (at < 0) continue;
      const prop = decl.slice(0, at).trim();
      const value = decl.slice(at + 1).trim();
      const isSpacing = GEOM_PROP.test(prop);
      const isRadius = prop === "border-radius";
      if (!isSpacing && !isRadius) continue;
      coveredDecls += 1;
      // 先把 token 抠出来查「档位存不存在、组对不对」：var(--mneme-space-13) 这种
      // 未定义的键不会报错、只是渲染成空值，光看前缀是查不出来的。
      const keys = [...value.matchAll(/var\(--mneme-(space|radius)-([a-z0-9]+)\)/g)];
      for (const k of keys) {
        const table = EXPECTED[k[1]];
        if (!(k[2] in table)) {
          violations.push(selector + " { " + prop + ": " + value + " } ← " + k[1] + " 没有档位 " + k[2]);
        }
      }
      const rest = value.replace(/var\(--mneme-(?:space|radius)-[a-z0-9]+\)/g, " ").split(/\s+/).filter(Boolean);
      const leftoversOk = isSpacing
        ? rest.every((x) => x === "0" || x === "auto" || x === "1px")
        : rest.every((x) => x === "0" || x === "50%");
      const groupOk = isSpacing ? keys.every((k) => k[1] === "space") : keys.every((k) => k[1] === "radius");
      // 注意：不能要求「必须有 token」——auto / 1px / 50% 是刻意的例外，
      // 本身就已经是合法值（leftoversOk 会放它们过），要求 token 只会把它们误判成违规。
      if (!leftoversOk || !groupOk) {
        violations.push(selector + " { " + prop + ": " + value + " }");
      }
    }
  }
  assert.deepEqual(violations, [], "状态页出现刻度外的间距/圆角：" + violations.join(" ; "));
  // 反向：不许因为「一个状态类都没匹配上」而空转通过（改类名、改切片锚点都会走到这里）。
  assert.ok(coveredRules >= 80, "扫到的状态页规则只有 " + coveredRules + " 条（预期 ≥80），锁空转了？");
  assert.ok(coveredDecls >= 60, "扫到的状态页几何声明只有 " + coveredDecls + " 条（预期 ≥60），锁空转了？");
});

/* ---------- 原语层：抽出来真跑，不靠读源码猜 ---------- */
const gStart = clientSource.indexOf("    const GEOMETRY = {");
const gEnd = clientSource.indexOf("/* panel-geometry:end */", gStart);
assert.ok(gStart > 0 && gEnd > gStart, "找不到 panel-geometry 标记块（原语层被删或标记丢了）");
const geometrySource = clientSource.slice(gStart, gEnd);

const makeApi = () =>
  new Function(
    "const h = arguments[0];\n" +
      geometrySource +
      "\nreturn { GEOMETRY, space, radius, fontOf, weightOf, Stack, Inline, Card, Section, Grid };"
  )((type, props, ...kids) => ({ type, props, kids }));

test("原语层只收刻度键，表外值当场抛错（这是这条锁存在的理由）", () => {
  const api = makeApi();
  assert.equal(api.space(8), "var(--mneme-space-8)");
  assert.equal(api.space(0), "var(--mneme-space-0)");
  assert.equal(api.space(24), "var(--mneme-space-24)");
  assert.equal(api.radius("pill"), "var(--mneme-radius-pill)");
  assert.equal(api.fontOf(13), "var(--mneme-type-13)");
  assert.equal(api.weightOf(600), "var(--mneme-weight-600)");
  for (const bad of [9, 11, 14, 25, "8px", "8 ", null, undefined]) {
    assert.throws(() => api.space(bad), /只收刻度/, `space(${JSON.stringify(bad)}) 必须抛错`);
  }
  assert.throws(() => api.radius(6), /只收刻度/, "radius 不共享 space 的档位");
  assert.throws(() => api.space("16"), /只收刻度/, "字符串键同样要查表（16 不是档位）");
});

test("原语真的把刻度写进 style，且默认值都在刻度内", () => {
  const api = makeApi();
  const stack = api.Stack({ gap: 12, pad: 8, align: "center", children: "x" });
  assert.equal(stack.props.style.gap, "var(--mneme-space-12)");
  assert.equal(stack.props.style.padding, "var(--mneme-space-8)");
  assert.equal(stack.props.style.flexDirection, "column");
  assert.throws(() => api.Stack({ gap: 9 }), /只收刻度/);

  assert.equal(api.Inline({}).props.style.gap, "var(--mneme-space-6)");
  assert.equal(api.Inline({}).props.style.flexDirection, "row");
  assert.equal(api.Card({}).props.style.padding, "var(--mneme-space-12)");
  assert.equal(api.Card({ dense: true }).props.style.padding, "var(--mneme-space-8)");
  assert.equal(api.Card({}).props.style.borderRadius, "var(--mneme-radius-8)");
  assert.match(String(api.Grid({}).props.style.gridTemplateColumns), /^repeat\(auto-fill,minmax\(220px,1fr\)\)$/);
  assert.equal(api.Grid({ gap: 16 }).props.style.gap, "var(--mneme-space-16)");
  assert.throws(() => api.Grid({ gap: 11 }), /只收刻度/);
  assert.equal(api.Section({}).props.style.gap, "var(--mneme-space-8)");
});

test("原语层内部不许出现裸 px 字面量（1px 发丝线与栅格下限除外）", () => {
  // 两个例外写在这里而不是放任：1px 是发丝线（缩放后仍是线），栅格 min 是
  // 「内容多宽才排下一列」的阈值，不是间距——它进刻度反而会让栅格跟着间距漂。
  const literal = (geometrySource.match(/(?<![\w.-])\d+px/g) || []).filter((v) => v !== "1px");
  assert.deepEqual(literal, [], "原语层写了 px 字面量，绕过了刻度：" + literal.join(", "));
});
