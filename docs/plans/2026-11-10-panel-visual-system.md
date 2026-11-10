# 面板视觉系统（v1）设计笔记 —— Astryx 能抄什么，以及间距为什么必须刻度化

依据：桉桉 2026-11-10 提出「想照 Qoder 做知识库」之后紧接着问「https://github.com/meta/astryx
能不能用来设计 mneme 的仪表盘和 UI」，并拍板「你现在做吧」（写下来，考后照做）；
以及 issue #607 遗留的观感类反馈（面板不像人写的、入口说不清属于谁）。

基线：**v0.13.0 = ef8f9ce**。本文档**只做设计，不改一行渲染代码**——考期冻结，落地时间见 §10。

---

## 一、结论先给

1. **Astryx 不引进依赖。** 三条硬约束（构建链 / React 19 / 宿主观感与既有的对比度锁），见 §3。引进的收益远小于拆锁的代价。
2. **要抄的是它的三层规范**：空间与字号刻度（`astryx docs tokens`）、页面骨架（`astryx template dashboard --skeleton`）、无障碍契约测试（`test:a11y-contract`）。
3. **面板"不成体系"的真根因不是配色，是没有组件层。** 颜色已经有 16 个语义 token 和四道测试锁（踩过 #178 换来的）；空间维度一个 token 都没有，1,610 处 px 散成 **107 个不同取值**，其中 40 个只出现过一次。
4. 所以 v1 的三件事是：**刻度**（§5.A）→ **原语层**（§5.B）→ **规则锁**（§5.C）。全部零新依赖，全部可在现有 `lib/client.js` 里完成。

---

## 二、现状量化（v0.13.0，2026-11-10 实测）

| 维度 | 实测值 | 判断 |
| --- | --- | --- |
| `dsh-mneme/lib/client.js` | 779,130 字节 / 13,437 行 | 单文件，手写 bundle，无构建链 |
| 语义色 token `--mneme-*` | **16 个，全是色值**（fg-dim / accent / danger / warn / ok / graphic-dim / chart-1..6 / heat-1..4） | 色层已成型 |
| 宿主 token `--dsw-*` 引用 | 469 处 / 23 个名字 | 颜色实质由宿主托管 |
| 空间 token | **0 个** | 这是缺口 |
| `padding` 声明 | 182 处 / **107 种取值** | 无刻度 |
| `gap` 声明 | 172 处 / 25 种取值 | 无刻度 |
| `margin` + `marginTop` | 40 处 / 29 种 与 50 处 / 9 种 | 无刻度 |
| `borderRadius` | **0 处** | 圆角统一没做，也不在 token 里 |
| `fontSize` | 25 处 / 8 种数值（12/13/15 为主） | 字号基本收敛，但无 token |
| `fontWeight` | 3 处 / 2 种（400 / 600） | 同上 |
| px 出现次数 | 1,610 次 / **107 个不同数值** | 见下方分布 |
| px 落在 4 的倍数上 | **41.7%** | 约六成不在任何网格上 |
| px 落在偶数上 | 71.0% | **29% 是奇数像素**（1/3/11/13/17…） |
| 只用过一次的 px 数值 | 40 个（占 107 种的 37.4%） | 长尾即漂移 |
| 高频 px 前 10 覆盖 | 63.5% | 8(174) 12(161) 1(135) 10(133) 6(91) 16(79) 2(76) 14(61) 4(56) 13(56) |
| 从宿主 `primitives` 实际取用的能力 | **只有两个 hook**：`useAnchoredPosition` / `useDismissOnOutsidePointer` | 面板没有任何组件库，全是手写 div + 行内样式 |

复现方式（本文档数字全部由这个脚本产出，改刻度后应重跑对比）：

存成 `panel-metrics.mjs`，在 `dsh-mneme/` 下执行 `node panel-metrics.mjs lib/client.js`：

```js
import fs from "node:fs";
const t = fs.readFileSync(process.argv[2], "utf8");
const px = [...t.matchAll(/(?<![\w-])(\d{1,3}(?:\.\d+)?)px/g)].map(m => Number(m[1]));
const freq = px.reduce((a, v) => (a[v] = (a[v] || 0) + 1, a), {});
const rows = Object.entries(freq).map(([v, n]) => [Number(v), n]).sort((a, b) => b[1] - a[1]);
const on4 = rows.filter(([v]) => v % 4 === 0).reduce((s, [, n]) => s + n, 0);
console.log("px 出现", px.length, "次 /", rows.length, "种；4 网格", (on4 / px.length * 100).toFixed(1) + "%；只出现一次的值", rows.filter(([, n]) => n === 1).length);
for (const prop of ["padding", "gap", "margin", "borderRadius", "fontSize"]) {
  const decls = [...t.matchAll(new RegExp("\\b" + prop + "\\s*:\\s*[^;\"'\`}]+", "g"))].map(m => m[0]);
  const vals = new Set(decls.map(d => d.replace(/\s+/g, " ").split(":").slice(1).join(":").trim()));
  console.log(prop.padEnd(12), decls.length, "处 /", vals.size, "种取值");
}
```

当前输出（v0.13.0）：

```
px 出现 1610 次 / 107 种；4 网格 41.7%；只出现一次的值 40
padding      182 处 / 107 种取值
gap          172 处 / 25 种取值
margin       40 处 / 29 种取值
borderRadius 0 处 / 0 种取值
fontSize     25 处 / 8 种取值
```

---

## 三、为什么不能直接把 Astryx 当依赖

Astryx 本体（2026-11-10 核实）：MIT、Beta、`meta/astryx`、21,844 star、2026-01-09 建仓、
Meta 内部八年的设计系统开源化（内部 13,000+ 应用）、150+ 无障碍组件、7 套主题、
React 19 + StyleX 实现但**消费端只 import 预编译 CSS**（`reset → astryx.css → theme.css`，靠 `@layer` 级联）、
**主题 = 一组 CSS 变量覆盖**、CLI 面向 agent（`astryx init` 把组件索引写进 AGENTS.md / CLAUDE.md）。

它质量没问题，是我们这边接不住：

1. **没有构建链。** `lib/client.js` 的头是 `window.__ModuleLoader__.load({ factory: (require) => ... })`，
   只能 `require` 宿主给的三样：`react`、`@deepseek-ai/dsh-client-ui-primitives`、`dsh-better-sidebar`。
   塞 npm 包要么改构建链（等于重做发布形态），要么把 150+ 组件手抄进一个 13k 行的单文件。
2. **React 19 peer。** 宿主给哪个版本不由我们定；拿插件去赌宿主版本是大忌。
3. **会和宿主观感打架。** Astryx 自带 reset、主题层和自己的字体（Figtree）。而 `test/contrast.test.js`
   的四道锁（正文 AA ≥200 条 color 声明审计、幻影宿主 token、图形 3:1、五个渲染根齐全）全部以
   **宿主 token 为基准**。引进来等于先把锁拆了再重写一套，收益为负。

---

## 四、根因（四层，从硬到软）

- **L1 没有组件层。** 每张卡片、每一行、每个徽章都手写 `div + style`。同一件事写 180 次，
  180 次各自算间距 ⇒ 漂移是必然结果，不是审美失误。
- **L2 空间没有刻度。** 颜色有 16 个 token 兜住，空间一个都没有。107 种 padding 里 40 种只出现一次，
  就是"当时差一点点，就地加 1px"的物证（29% 是奇数像素）。
- **L3 没有页面骨架。** 每个 seat 自己拼布局，所以"仪表盘"只能表现为"卡片往下堆"，
  没有栅格、没有主次、没有信息密度分级。
- **L4 交互细节没有契约。** 焦点态、键盘可达、动效时长各自发挥；空态文案刚被 #607 教育过一次。

**为什么颜色没崩：** 因为 #178 真的踩过（70 条对比度不合格），才有 `--mneme-*` 语义层 + 四道锁。
空间层缺的正是同一套东西——**不是加大投入，而是把已经验证过的方法换到另一个维度再用一遍。**

---

## 五、目标形态（三个交付物，都零新依赖）

### 5.A 三组刻度（定义位置与 `--mneme-*` 同处：五个渲染根）

| 组 | 令牌 | 取值 | 说明 |
| --- | --- | --- | --- |
| 间距 | `--mneme-space-0/2/4/6/8/10/12/16/20/24/40` | 0 / 2 / 4 / 6 / 8 / 10 / 12 / 16 / 20 / 24 / 40 | 4 为基；2 与 6 是 inline 半档（图标与文字之间）；10 与 40 是 P1b 迁移时补的（见 §5.E） |
| 圆角 | `--mneme-radius-4/8/12/pill` | 4 / 8 / 12 / 999 | 现在圆角 0 处声明，等于全交给宿主，不统一；12 同上为 P1b 补档 |
| 字级 | `--mneme-type-12/13/15` | 12 / 13 / 15，行高 1.45 / 1.5 / 1.55 | 现有取值基本就在这三个数上，等于把既有事实写成 token |
| 字重 | `--mneme-weight-400/600` | 400 / 600 | 同上 |

**落地时的偏离（P0 已按此实现）：令牌按像素值命名，不按档位号。**
原稿写的是 `--mneme-radius-sm/md` 这类档位名。实际落地改成 `--mneme-radius-8`、`--mneme-space-12`，理由是：
档位号会让 `gap: "4"` 表示 8px，写的人要背表、读的人无法就地核对；按值命名后调用点自解释，
测试也能拿「允许的 px 集合」直接校验，不需要维护第二份档位↔像素映射（第二份映射就是下一个漂移源）。

**必须承认的破坏性：** 现有 10 / 14 / 18 不在刻度上（10 有 133 次、14 有 61 次、18 有 52 次，不是零头）。
映射建议 10→8 或 12、14→12 或 16、18→16 或 20，**每个 seat 单独视觉复核**，不许全局替换了事。

**合法例外（写进白名单，不是"随手"）：** 1px 描边、图表/热力图几何、SVG 坐标、滚动条宽度、
动画位移量。白名单要有注释说明为什么它不该进刻度。

### 5.B 手写原语层（约 150 行，仍在 client.js 内）

```js
Stack({ direction = "column", gap = 0, pad = 0, align, justify, wrap, grow, style, className, children })
Inline({ gap = 6, wrap, children })            // 横向一行
Card({ title, actions, dense, style, className, children })  // 1px 描边 + radius(8) + 内距，唯一允许写 padding 的壳
Section({ title, hint, style, children })       // 组标题 + 说明 + 内容，统一上下距
Grid({ min = 220, gap = 12, children })         // auto-fill minmax，仪表盘用
```

规则：**只收刻度键，表外值当场抛错**（不是 `assert`——生产构建里 `assert` 会被剥掉，
那就等于「开发期拦、线上放行」，正是这套锁要消灭的那种静默降级）。目标是把 182 处 padding
与 172 处 gap 收进 ≤12 种形态。

落地时的两处签名偏离：内距统一叫 `pad`（`padding` 与 CSS 属性同名，读调用点时容易误认为直通）；
`Stack` 的 `gap` 默认 0 而不是 2（默认值是个隐性意见，`Inline` 的 6 才是常用值，其余留白由调用点说清）。

### 5.C 规则锁（新增 `dsh-mneme/test/panel-tokens.test.js`）

1. 扫描 client.js 的 CSS 切片：所有 px 必须 ∈ 刻度集 ∪ 白名单；**白名单失效也报红**
   （清单里的值在代码里消失了，说明刻度在悄悄退回去）。
2. 五个渲染根都定义了 §5.A 的刻度（与 contrast.test.js 的渲染根断言同源）。
3. 原语层调用里出现表外值即失败（数字、字符串、`null`、`undefined` 都算），
   且原语块内部不许出现裸 px（1px 发丝线与 Grid 的 min 阈值是两个带注释的例外）。
4. 扩无障碍三条：`focus-visible` 规则存在、每个可点区域有 role/aria 文案、
   `announce()` 覆盖所有瞬时反馈类型（保存/失败/刷新/裁决/复制）。
5. **变异自证**：手工把一个 `padding: 8` 改成 `padding: 9`，锁必须红——这条要写进 PR 描述。

### 5.D 落地记录（P0 + P1a，2026-11-10 已实现）

| 交付物 | 状态 | 位置 |
| --- | --- | --- |
| 三组刻度 + 字重 | ✅ | `dsh-mneme/lib/client.js` 的 token 规则（五个渲染根那一条），接在 `--mneme-heat-4` 之后 |
| 原语层五个组件 | ✅ | 同文件，`/* panel-geometry:begin` … `/* panel-geometry:end */` 之间，紧跟 `const h = react.createElement;` |
| 规则锁 | ✅ | 新增 `dsh-mneme/test/panel-tokens.test.js`，6 例 |
| 存量不改视觉 | ✅ | 只加 token 与原语，**一个 seat 都没换**，因此本次不需要截图复核 |

**存量棘轮的口径**：测试里把当前 CSS 的 89 个 px 取值逐值计数录成基线（合计 1501 处；
比 §二的 1610/107 少，是因为口径剔除了注释散文里的 px、且只统计 CSS 切片），
规则是「只许减不许增」，并额外放行两个白名单值（1 = 发丝线、2 = 焦点环）。
白名单值从代码里消失同样报红——刻度悄悄退回去和偷偷加新值一样有害。

**变异自证（四条，全部按预期红，改完逐条还原并复查 6/6 绿）**：

| 变异 | 期望 | 实际 |
| --- | --- | --- |
| M1 `padding:8px 16px` → `8px 17px` | 棘轮用例红 | ✅ 只有这一条红 |
| M2 `GEOMETRY` 删掉 12（CSS 仍留 `--mneme-space-12`） | 原语 style 用例红 | ✅ |
| M3 选择器删掉 `.mneme-paneliglyph` | 五个渲染根用例红 | ✅ |
| M4 原语块塞 `outlineOffset:"9px"` | 裸 px 用例红 | ✅ |

**已跑验证**：`panel-tokens` 6/6；`contrast.test.js` + `client.test.js` 127/127
（contrast 一行未改）；全量 **3,268 tests / 3,267 pass / 0 fail / 1 skip**；
`check-sync` ✓（119 个文件）。3,268 = 3,262 基线 + 本片新增 6 例。

### 5.E 落地记录（P1b 状态页，2026-11-10 已实现）

桉桉拍板「不用，你现在做吧」（越过她自己定的考期冻结，因为这一片她要看结果）。

**做了什么**：状态页的 44 条 CSS 规则（`.mneme-status*` / `.mneme-stat*` / `.mneme-tokenflow` /
`.mneme-kpiband` / `.mneme-donutwrap` / `.mneme-sink*` / `.mneme-legacy` / `.mneme-wb*` /
`.mneme-conflict*` / `.mneme-pending*` / `.mneme-heatbar`）里的 padding / margin / gap /
border-radius 全部换成 `var(--mneme-space-*)` / `var(--mneme-radius-*)`；另有 4 处行内 style 改走 `space()`
（SkippedReasonsNotice 的 paddingLeft 18→`space(16)`、InjectPreviewCard 的 marginTop/gap/padding、
HeatStatusCard 的 gap）。

**两档新刻度**（都是"既有事实本来就在这个数上，只是没名字"）：

| 新增 | 理由 |
| --- | --- |
| `--mneme-space-10` | 卡片内距 10px 是既有高频取值（133 次），压到 8 会让信息密度肉眼变松 |
| `--mneme-space-40` | 状态页分组之间 40px 的呼吸，压到 24 或 32 会把"三大块"的层次抹平 |
| `--mneme-radius-12` | 大卡圆角 12px 是既有取值，压到 8 与"大卡 / 小卡"的层级不符 |

**贴近邻档的取舍（每一条都是刻意，不是就近凑）**：分组间距 26→24、卡内下沿 14→12、
工作台标题上沿 28→24、`.mneme-wbrow`/`.mneme-wbmemo` 的 `10px 14px`→`10px 12px`、
radius 10→8、heatbar/simbar/simfill 的 3px→`pill`、conflict-mark 3→4、sinkbar 顶角 2→4。

**刻意不动**：`@container` / `@media` 里的 14 / 30 / 32 / 36 四个值。那些是"压到正好不溢出"的贴合值，
不是节奏值，进刻度反而会把断点行为锁死。理由写进了代码注释与测试注释。

**新锁（第 7 例）"状态页的间距与圆角全部走刻度（P1b 不回退）"**：按命名空间正则
`^\.mneme-(status|stat|tokenflow|kpiband|donut|sink|legacy|wb|conflict|pending|heatbar)` 扫 CSS 切片，
跳过 `@` 开头的 at-rule；每个 token 除了要匹配正则，还要**查档位真的存在、且落在正确的组里**
（防 `var(--mneme-space-13)` 这种拼错的令牌静默通过）；残余值只许 0 / auto / 1px（间距）与 0 / 50%（圆角）。
另加反向断言 `coveredRules >= 80`、`coveredDecls >= 60`（实测 **94 条规则 / 76 条几何声明**），防空转。

**踩坑并修掉**：这条用例最初写了 `keys.length === 0 && value !== "0"` 当成违规，
结果把 `margin-right:auto`、`padding:0 1px`、`border-radius:50%`、`margin-top:1px` 六处
**刻意的合法例外**全判成违规。修法是删掉该子句——auto / 1px / 50% 本身就是合法残余，不该靠特判放行。

**验证**：`panel-tokens` **7/7**；`contrast.test.js` + `client.test.js` **127/127**（contrast 一行未改）；
`check-sync` ✓（119 个文件）；全量 `npm test` **3,269 tests / 3,268 pass / 0 fail / 1 skip**（63.7s）。
px 计数无任何值增长，13 个值下降，表外无新增。

**变异自证（三条，全部按预期红，改完逐条还原并复查 7/7 绿）**：

| 变异 | 期望 | 实际 |
| --- | --- | --- |
| M5a `.mneme-statrows` 的 `margin-top:var(--mneme-space-10)` → `10px` | 棘轮 + P1b 同时红 | ✅ 红 **2** 条 |
| M5b `var(--mneme-space-12)` → `var(--mneme-space-13)` | 只 P1b 红（档位不存在） | ✅ |
| M5c `border-radius:var(--mneme-radius-12)` → `var(--mneme-space-12)` | 只 P1b 红（组错了） | ✅ |

M5b / M5c 这两条是专门为"拼错令牌也能过"这个漏洞设的——只验正则匹配的话，把 space 写成半径同样过得了。

**视觉复核**（深浅两主题，状态页全高 2,520px，Edge headless 实拍）：

| 分区 | 变化像素占比 | 性质 |
| --- | --- | --- |
| KPI 带 + Token 三屏 | 4.15% | 几像素级对齐位移 |
| 9 张旧卡 + 维护区 | 5.78% | 同上 |
| 冲突队列 + 工作台 | 6.38% | 同上 |

**没有一处的颜色、字号、结构发生变化**；差的全是 26→24、14→12 这类位移累积。
对比图落在 `C:/Users/石晴/AppData/Local/Temp/kb-preview/`：`cmp-light-cards.png`（上=改前，下=改后）、
`cmp-light-tail.png`、`cmp-dark-cards.png`。

### 5.F 落地记录（图表 bug，2026-11-11 已实现）

桉桉问「话说之前的图表呢，需要改吗？」——P1b 只动了间距，**绘制逻辑一行没碰**，所以三处真 bug 原样留着。
她说「现在改」。这三处不是审美问题，是数字读错：

| # | 现象 | 根因（行号为改前） | 谁受害 |
| --- | --- | --- | --- |
| ① | 纵轴永远 `1M / 1M / 1M / 0M` | `${(v / 1e6).toFixed(0)}M`（client.js:6848）—— 750K / 500K 都进 1M、250K 进 0M | **所有日用量 < 4M 的库**（即正常使用的库） |
| ② | 柱子贴地，像没数据 | `Math.max(1e6, Math.ceil(dayMax / 1e6) * 1e6)`（:6686）把上限钉在 1M——日 7 万时柱高 7% | 小库；大库反而正常，**方向是反的** |
| ③ | 七天全零也画轴 + 七根贴地柱 | 无条件渲染（:6845-6862），而沉淀图有空态（:6900） | 新库 / 停用期 |

**改法**：抽一个纯函数块 `/* panel-chart-scale:begin … end */`（同 `panel-geometry` 的先例，测试用
`new Function` 直接跑），两个函数：

- `chartScale(dayMax)` → `{ step, max, labels }`，或 `null`（无数据）。步长在 `1 / 2 / 2.5 / 5 / 10 × 10^n`
  里挑第一个满足 `step × 4 >= dayMax` 的，四格刚好盖住峰值；只收整数步长（`2.5 × 10^0` 会把整 token 轴
  切成小数，`exp >= 10` 时仍是整数）。
- `chartAxisLabel(n)` → `1M` / `1.5M` / `750K` / `500`。**整百万不带小数**（`toFixed(1)` 会写成「1.0M」，
  轴上一排「1.0M / 0.8M」比「1M / 750K」难读）。

**三种状态必须分开**（沿用 #412 那条教训：`stats` 为 `null` 与 `{}` 分属「未知」与「已知为空」）：

| 状态 | 渲染 |
| --- | --- |
| `rawDays === null`（未加载） | 空骨架 `.mneme-bars`，**不画轴也不刷文案** |
| `rawDays` 有值、七天全零 | 新增 `memory.status.token.daysEmpty`（「最近 7 天没有 token 记录」） |
| `statsError` | `memory.status.error` + `var(--mneme-danger)`（与 donut 同一口径） |

**实测轴**（改前 → 改后）：70K 从 `1M/1M/1M/0M` → `80K/60K/40K/20K`（柱高 7% → 88%）；
900K → `1M/750K/500K/250K`；3.9M → `4M/3M/2M/1M`（本来就对，不能改坏）；12M → `20M/15M/10M/5M`。

**新锁** `dsh-mneme/test/panel-chart-scale.test.js`（6 例）：

1. 0 / 负数 / NaN / null / `"abc"` / `Infinity` → `null`（调用方画空态，不画假轴）；
2. 五组定点量级的轴标签逐值断言；
3. **四条轴标签互不相同** ← 这条锁的是 ① 的**形状**（原 bug 去重后只剩「1M / 0M」两个值），
   比锁具体字符串更能挡住「换成别的错误格式」；
4. `max >= 峰值`，且峰值 ≥ 1000 时 `max < 峰值 × 2.5` ← 锁 ② 不许退回 1M 地板；
5. `chartAxisLabel` 的 K/M 分档与「整百万不带小数」；
6. **源级守卫**：`client.js` 里不许再出现 `toFixed(0)}M` 与 `Math.max(1e6,`，且渲染必须真的调用
   `chartAxisLabel(v)` 与 `scale.max`——纯函数绿了但渲染绕过去，等于没修。

**变异自证（4 条，全部按预期红，逐条还原后复查 6/6 绿，`readFileSync` 比对 identical=true）**：

| 变异 | 期望 | 实际 |
| --- | --- | --- |
| M6a 删掉 `if (!Number.isFinite(d) \|\| d <= 0) return null;` | 第 1 条红 | ✅ 1 红 |
| M6b `chartAxisLabel` 的 M 档退回 `toFixed(0)` | 第 5、6 条红 | ✅ 2 红 |
| M6c 在 `chartScale` 里把上限夹回 `Math.max(1e6, step)` | 第 2、4、6 条红 | ✅ 3 红 |
| M6d 柱高改回 `d.total / 1e6` | 只第 6 条红（纯函数测不到渲染） | ✅ 1 红 |

M6d 是刻意留的：它证明第 6 条源级守卫不是摆设——去掉它，渲染绕过纯函数就没人发现。

**视觉复核**（Edge headless，深浅两主题，mock 的 `by_day` 改成「每天 6–9 万、总量约 48.6 万」）：
`C:/Users/石晴/AppData/Local/Temp/kb-preview/cmp-chart-light.png`（上=改前 / 中=改后 / 下=空态）、
`cmp-chart-dark.png`。改前实测轴就是 `1M / 1M / 1M / 0M`，改后 `100K / 75K / 50K / 25K`。

**看见但没动的**（都不是 bug，且都要改视觉）：

- **同页撞色**（沉淀图借 donut 的色槽）→ 当天夜里就做了，见 §5.G；
- **donut 只有 6 个色槽**：第 7 种 operation 起会全部落灰。现在服务端正好 6 个（`TOKEN_OPS`），
  够用；真加第 7 种再改成「前 6 + 其他」。

### 5.G 落地记录（色槽各有其主，2026-11-11 已实现）

§5.F 记下的那处同页撞色，夜里接着做了（桉桉 m06131「你做吧你做吧，我去睡觉了」）。
动手时顺手扫了一圈同页的色槽，发现同一类问题还有第二处，于是一起收了。

**一、沉淀图不再借 donut 的色槽**

- 语义层新增 `--mneme-sink-added` / `--mneme-sink-merged`，取值与 `--mneme-chart-3` /
  `--mneme-chart-2` **逐字相同**——只换语义，视觉零变化。刻意**不写成 `var(--mneme-chart-3)`**：
  那仍是继承，以后调 donut 的六色盘会顺手改掉沉淀图的颜色，而这两张图回答的是不同问题
  （「token 都去哪了」 vs 「库在膨胀还是稳住了」）。
- `.mneme-sinkbar--added/merged` 改指新令牌；donut 的 `mneme-seg--N` / `mneme-dot--N` 一个不动。
- `test/client.test.js` 那两条 #178 断言改指 `sink-*`：原意是「不许直接拿宿主 label token
  当填充色」，换名后仍成立。

**二、第 6 个色槽收回单一来源**

- 改之前 `--mneme-chart-6` 是**死令牌**：`.mneme-seg--6` 与 `.mneme-dot--6` 各自内联了一份
  同样的 `color-mix(...50%,transparent)`——三份值一样，却互为独立源，改一处漏两处。
  现在弧与点都 `var(--mneme-chart-6)`。
- 定义旁那句「对比度解析器不递归 `--mneme-*` 变量」是过时的：`test/contrast.test.js` 的
  `resolveValue` 会从 `TOKENS` 里连 `--mneme-*` 一起折，内联没有技术理由。

**三、锁的形状：从「一对」改成「三家族」**

新锁不是只为沉淀图写的，而是把「色槽各有其主」当作一条全局约束：

| 家族 | 只服侍 |
|---|---|
| `--mneme-chart-*` | `.mneme-seg--N` / `.mneme-dot--N`（donut 的弧与图例点） |
| `--mneme-heat-*` | `.mneme-heatcell.l1..l4` |
| `--mneme-sink-*` | `.mneme-sinkbar--added/merged` |

它同时拦三种回退：① 别的图借道这些色槽（`.mneme-sinkbar--added` 用 `chart-3`）；
② 每格色内联成字面量、令牌沦为死码（上一版 chart-6 就是这样）；③ 令牌之间互相继承
（`--mneme-sink-added:var(--mneme-chart-3)`——看着解耦，实际一动 donut 色盘就跟着变）。
原有 GRAPHICS 3:1 锁**照旧咬新令牌**——它按**值**解析、不看名字，所以「换个语义名顺手
放宽对比度」这条路被堵死。

**变异自证**（五条，前四条该红、第五条**该绿**）：

| 变异 | 结果 |
|---|---|
| `.mneme-sinkbar--added` 改回 `var(--mneme-chart-3)` | 红（借用 + 取色来源两条） |
| `--mneme-sink-added: var(--mneme-chart-3)`（继承式解耦） | 红（语义层里出现 chart 色槽） |
| `--mneme-chart-2: var(--mneme-sink-merged)`（反向继承） | 红（语义层里出现 sink 色槽） |
| `.mneme-dot--6` 退回内联 `color-mix` | 红（没按 `--mneme-chart-6` 取色） |
| 两个新令牌的混色比例各调 1%（60→61、55→54） | **绿** |

最后一条是刻意的：**这条锁守归属，不守色值**。谁想把沉淀图调成另一种颜色，那是设计决定、
该靠截图给人看，不该被测试钉死；锁只拦上面那三种回退。

**踩到的坑（写下来免得重犯）**

第一版把「语义层别借色槽」写成 `if (r.sel === layer.sel)`，这条分支**永远进不去**：语义层
那条规则是多个字符串拼出来的，`rules` 只收能整条匹配单个字面量的规则，它根本不在里面。
变异 M2 当场暴露（该红却绿），改成直接扫 `layer.body` 才咬得住。**没有变异自证，这条锁会以
「全绿」的形式一直假存在。**

另有一个环境坑：`node -e "..." "$1" "$2"` 传以 `--` 开头的字符串会被当成 node 选项
（`bad option: --mneme-...`），替换根本没发生、测试假绿。变异脚本改走环境变量才可靠。

**视觉复核**（Edge headless，同一 mock）

- 沉淀区裁图 743×205：深浅两主题像素差**都是 0.00%**；浏览器算出的 computed style 逐字相同
  （浅色 `color(srgb 0.543529 0.341961 0.129412)`，改前改后一致）。
- donut 区裁图 152×152：像素差**都是 0.00%**；`.mneme-dot--6` 的 computed 值改前改后一致
  （浅色 `color(srgb 0.0588235 0.0666667 0.0823529 / 0.5)`）。
- 图：`C:/Users/石晴/AppData/Local/Temp/kb-preview/cmp-sink-light.png` / `cmp-sink-dark.png`
  （上=改前，下=改后）、`cmp-donut-light.png` / `cmp-donut-dark.png`。

---

## 六、迁移分片（每片独立可验证，可停在任意一片）

| 片 | 内容 | 风险 | 验收 |
| --- | --- | --- | --- |
| P0 | 建三组刻度 + 规则锁 + 把现状 107 种值录成"基线红名单"（此时不改视觉） | 零 | 锁对现状全红→录名单后全绿；对故意改坏必须红 |
| P1a | 原语层落地（Stack/Inline/Card/Section/Grid），不改任何 seat | 低 | 新原语自测 + 全量测试不回归 |
| P1b | 状态页（热力图/统计/沉淀图）换原语 | 中 | 深浅两主题截图对比 + 全绿 —— **✅ 已完成（§5.E）** |
| P1c | 知识库页 + 地志页换原语 | 中 | 同上 |
| P1d | 设置页分组 + 诊断页换原语 | 中 | 同上 |
| P2 | 仪表盘页（若确定要做）：先静态线框（照 Astryx dashboard 骨架），再上码 | 中高 | 线框先给桉桉看，不做完再改需求 |

排序理由：状态页的卡片最同质（信息密度一致、没有交互分支），先换它最能暴露原语层设计错误，
成本也最低；知识库/地志有表单和列表混合，放后面。

---

## 七、Astryx 具体抄哪几句

| 命令 | 抄什么 | 不抄什么 |
| --- | --- | --- |
| `npx @astryxdesign/cli docs tokens` | 令牌**分类方式**（spacing/color/radius/typography/motion 各成一组，而不是一锅） | 具体数值（它的基数是 4 还是 8 不重要，我们的既有事实就在 4/8/12 上） |
| `npx @astryxdesign/cli template dashboard --skeleton` | 仪表盘的**信息分区**（header / 主指标 / 分栏 / 侧栏）与本机骨架的对应关系 | 生成的代码（React 19 组件，抄不进来） |
| `astryx component --list` | 组件命名的**收敛方式**（一个概念一个组件，不是每个页面自造一个） | 组件实现 |
| `test:a11y-contract`（playwright） | "把无障碍写成契约测试"这条做法本身 | 它们的契约内容（我们的宿主环境不同） |
| `astryx init`（写 AGENTS.md 组件索引） | **给 agent 一份可查的组件清单**这件事——我们对应的是在 client.js 顶部维护原语索引注释 | 全套 CLI |

CLI 只在设计期跑（`npx` 一次性），**不进仓库依赖、不进构建**。

---

## 八、不做什么

- 不引 Astryx / StyleX / 任何组件库进 `dependencies`。
- 不引它的 reset 与主题层（会和宿主 + `contrast.test.js` 的基准冲突）。
- 不做"整体重写面板"——13k 行单文件重写等于重开一个项目，且考期不允许。
- 不改 `contrast.test.js` 的任何断言（它是色层的既成成果）。
- 不为了整齐牺牲信息密度：设置页那种紧凑列表该密就密，刻度里有 `space-1`/`space-2` 就是给它用的。

---

## 九、验收标准（数字）

P0 + P1a 已达成（2026-11-10）：

- ✅ 刻度三组 + 字重落地，五个渲染根齐全。
- ✅ 原语层五个组件，表外值抛错。
- ✅ 新增 `panel-tokens.test.js`（6 例），四条变异全部按预期红。
- ✅ `contrast.test.js` 一行不改仍全绿。
- ✅ 全量 `npm test` 不回归：**3,268 / 3,267 pass / 1 skip**；`check-sync` ✓（119 个文件）。

P1b 已达成（2026-11-10，见 §5.E）：

- ✅ 状态页 44 条规则 + 4 处行内 style 全部走刻度，新锁第 7 例（7/7）。
- ✅ 三条变异（含两条"令牌拼错"专门用例）按预期红。
- ✅ 全量 `npm test` **3,269 / 3,268 pass / 1 skip**；`check-sync` ✓（119 个文件）。
- ✅ 深浅两主题全高截图对比，变化像素 4.15% / 5.78% / 6.38%，**零颜色/字号/结构变化**。

图表与色槽两片已达成（2026-11-10 夜 – 11-11 凌晨，见 §5.F / §5.G）：

- ✅ 7 天柱状图三处绘制 bug 修复，新增 `panel-chart-scale.test.js`（6 例），四条变异按预期红。
- ✅ 色槽各有其主：三家族锁 1 例（`contrast.test.js` 共 6 例），五条变异（四条红、一条刻意绿）。
- ✅ `chart-6` 从三份内联收回单一令牌；沉淀图与 donut 视觉像素差 **0.00%**（深浅两主题）。
- ✅ 全量 `npm test` **3,276 / 3,275 pass / 1 skip**；`check-sync` ✓（119 个文件）。

仍在 P1c–P1d（每片做完再定下一片）：

- 间距取值：**107 → ≤12**（棘轮只保证不再增加，实际收敛靠 P1c/P1d）。
- px 落 4 网格：**41.7% → 100%（白名单除外）**；奇数 px：**0（白名单除外）**。
- 深浅两主题逐页截图对比（每片一组），给桉桉看再往下走。

---

## 十、时机与前置

- **考期冻结**（2026-12-19/20 初试）。P0 + P1a 是不改视觉的底层（只加 token 与原语，
  一个 seat 都没换），做完不影响任何界面，已随本分支落地。
- **P1b 是桉桉当夜当场放行的例外**（「不用，你现在做吧」），理由是这一片只重排既有的
  间距节奏、不加任何信息与交互，改动可整片回滚。P1c / P1d 仍排在 12-20 之后，除非她再一次明说。
- 前置：PR #638（扩展功能首屏分组）先合，避免同文件冲突；#178 的色层不动。
- 与 issue 的关系：**现在不开新 issue**（考期不开工单，避免看起来像在排期）。
  考后拆三条：刻度+锁 / 原语层迁移 / 仪表盘。

---

## 附：Astryx 事实速查（供考后复核，可能已变）

- 仓库 `meta/astryx`，MIT，Beta；主页 astryx.atmeta.com；Storybook / Sandbox 在线可看。
- 包：`@astryxdesign/core`、`@astryxdesign/cli`、`@astryxdesign/build`、七套 `@astryxdesign/theme-*`。
- `@astryxdesign/charts` 与 `@astryxdesign/vega` **只在 `@canary` 标签下**，没有稳定版——
  所以仪表盘要用图表的话，它现在也给不了稳定依赖（这条本身就是"别引"的又一个理由）。
