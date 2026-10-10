import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientSource = readFileSync(join(root, "lib/client.js"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// The Web client bundle registers itself via __ModuleLoader__.load. DSH
// resolves the bundle by plugin package name, so the registered id must match
// package.json `name` exactly (a mismatch surfaces as "loaded without
// registering '@modusensus/dsh-mneme'" in the DSH client).
test("client bundle registers under the package name", () => {
  const match = clientSource.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/);
  assert.ok(match, "client bundle must call __ModuleLoader__.load with an id");
  assert.equal(match[1], pkg.name, "registered id must equal package.json name");
});

// client.js is hand-authored under lib/ only (no src/ counterpart), so the
// src->lib sync must never prune it.
test("client bundle is lib-only with no src counterpart", () => {
  assert.equal(existsSync(join(root, "src/client.js")), false, "src/ must not contain client.js");
  assert.equal(existsSync(join(root, "lib/client.js")), true, "lib/client.js must exist");
});

// 归档侧第五指标（#275）自己按「归档区为空就整段省略」门控，但整卡还有一道 hasData 门：
// 那道门只认召回回执与活跃僵尸行时，「全归档 + 窗口内无回执」的库会直接 return null，
// 指标永远不显示（自动评审 #312 指出的回归）。这里锁死 hasData 必须把 archive.total 计进来。
test("status card: hasData counts the archive metric", () => {
  const m = clientSource.match(/const hasData =[^;]+;/);
  assert.ok(m, "the status card must declare hasData");
  assert.match(m[0], /d\.archive\?\.total/, "hasData must count archive.total, not just runs/active rows");
});

// The memory entry lives at the sidebar foot, not in the settings modal: the
// migration must register into `sidebar.footer.action` (the list slot the
// sidebar shell renders beside Settings) and must not keep a `settings.section`
// registration, or the entry would appear twice under different hosts.
test("memory entry registers into the sidebar foot slot", () => {
  assert.ok(
    clientSource.includes('ctx.slots.inject("sidebar.footer.action"'),
    "client must inject into sidebar.footer.action"
  );
  assert.equal(
    clientSource.includes('"settings.section"'),
    false,
    "the old settings.section registration must be gone"
  );
});

// The tab era is over: the in-conversation memory tab fought the floating
// composer and squeezed the session layout, so the library no longer
// registers as a conversation view. The sidebar entry opens the centered
// sheet directly — from any state, including the new-chat hero screen. A
// dialog role stays banned either way.
test("sidebar entry opens the sheet; conversation-view tab stays retired", () => {
  assert.equal(
    clientSource.includes("role: \"dialog\""),
    false,
    "no dialog surface should remain"
  );
  assert.ok(
    /function openLibrary\(\) \{\s*setOverlayOpen\(true\);/.test(clientSource),
    "the entry must open the overlay directly (no tab activation)"
  );
  assert.ok(
    clientSource.includes("conflictBadgeCount.refresh();"),
    "opening the library must re-read the conflict count (badge must not show a stale number)"
  );
  assert.equal(
    clientSource.includes('ctx.slots.inject("conversation.view"'),
    false,
    "the conversation.view tab must stay retired"
  );
  assert.equal(
    clientSource.includes("activateExplorerTab"),
    false,
    "the tab-click activation machinery must be gone"
  );
});

// The sheet is deliberately NOT fullscreen: a dimmed backdrop plus a rounded
// panel capped at 1180×880 keeps the conversation visible behind it. It
// reuses the full MemoryExplorer and closes on Esc, the close button, or a
// backdrop click.
test("memory library opens as a centered sheet with backdrop", () => {
  assert.ok(
    clientSource.includes(".mneme-backdrop{position:fixed;inset:0"),
    "a dimmed backdrop must sit behind the sheet"
  );
  assert.ok(
    /\.mneme-overlay\{position:fixed;z-index:1000;left:50%;top:50%;transform:translate\(-50%,-50%\)/.test(clientSource),
    "the sheet must be centered, not viewport-filling"
  );
  assert.ok(
    clientSource.includes("width:min(1240px,calc(100vw - 88px))"),
    "the sheet must not occupy the full width and keeps friendly margins"
  );
  assert.ok(
    clientSource.includes('h(MemoryExplorer, { t })'),
    "the sheet renders the same MemoryExplorer component"
  );
  assert.ok(
    clientSource.includes('e.key === "Escape"'),
    "Esc must close the sheet"
  );
  assert.ok(
    clientSource.includes('className: "mneme-backdrop"'),
    "the backdrop is a clickable close surface"
  );
  assert.ok(
    clientSource.includes('"memory.overlay.close"'),
    "the close affordance keeps its localized label"
  );
});

// The sidebar hands each entry only its column state: a wide row (icon +
// label) when expanded, a bare rail icon when collapsed — for both the
// portalled top button and the footer fallback.
test("trigger renders a wide row or a rail icon from the wide flag", () => {
  assert.ok(
    /wide \? "mneme-trigger" : "mneme-trigger mneme-rail"/.test(clientSource),
    "trigger must branch on the wide flag"
  );
  assert.ok(
    /wide && h\("span", \{ className: "mneme-trigger-label" \}/.test(clientSource),
    "the label span must render only when wide"
  );
  assert.ok(
    /size: wide \? 16 : 18/.test(clientSource),
    "the portalled icon must follow the host panel-row size (16) and the rail size (18)"
  );
});

// 入口的两态形状（宿主内核 0.2 侧边栏改版后重写，见 lib/client.js 的
// SidebarTopEntry 头注释）：
//  · 展开：混进宿主 nav.panelList 里「插件 / 自动化任务」那一组，套用宿主
//    panelRow 的实时类名 → 一颗低调面板行，不再是第二个高亮「新会话」按钮；
//  · 收起：宿主把面板列表整组 display:none，只有 fixed 到标题栏的开关与
//    「新会话」还可见，所以入口必须搬回那个位置（见下一条用例）。
// 本用例锁「展开态借的是宿主面板行」，回归表现是入口退回成大按钮或落回
// 新会话行后面变成孤立项。
test("sidebar entry portals into the host panel list with footer fallback", () => {
  assert.ok(
    clientSource.includes('ctx.slots.inject("sidebar.footer.action"'),
    "the footer slot registration must stay as anchor + fallback"
  );
  assert.ok(
    clientSource.includes("SidebarTopEntry"),
    "the portalled top entry must exist"
  );
  assert.ok(
    clientSource.includes(`'[class*="regionArea"]'`),
    "the portal must anchor at the host's regionArea container"
  );
  assert.ok(
    clientSource.includes(`'[class*="panelList"]'`),
    "the wide shape must target the host panel list (the 插件 / 自动化任务 group)"
  );
  assert.ok(
    clientSource.includes(`'[class*="panelRow"]:not(.mneme-topentry-native)'`),
    "the panel-row class must come from a host row, never from our own portalled button"
  );
  assert.ok(
    clientSource.includes("list.appendChild(created)"),
    "the wide entry must be appended into that group, below the host's own entries"
  );
  assert.ok(
    clientSource.includes("insertBefore(created, target)"),
    "the entry must keep the idempotent place() helper for hosts without a panel list"
  );
  assert.ok(
    clientSource.includes("if (!host) return fallback;"),
    "the portal entry persists across collapse (no footer jump); footer fallback only covers portal failure"
  );
  assert.ok(
    clientSource.includes('"memory.view.label"'),
    "the sheet aria-label must come from the memory.view.label dictionary key"
  );
});

// Issue #130: ecosystem plugins (task board, skill explorer, …) inject their
// own entries right after the New-Session row, and late inserters land above
// earlier ones — a fixed "before regionArea" slot degrades into the tail of
// that group, detaching the memory button from its familiar top spot. The
// entry therefore (a) resolves the same anchor as the ecosystem's shared
// sidebar-entry-core (logoRow row, legacy direct-child button), (b) re-asserts
// its slot from the existing observer, and (c) stays idempotent — the anchor
// check short-circuits before any DOM write, so observers never ping-pong.
test("entry re-asserts its slot against ecosystem entries", () => {
  assert.ok(
    clientSource.includes(`btn.closest('[class*="logoRow"]')`),
    "the anchor must resolve the New-Session logo row like the ecosystem core"
  );
  assert.ok(
    clientSource.includes("const target = anchor ? anchor.nextSibling : region;"),
    "the entry must sit right after the New-Session row, falling back before regionArea"
  );
  assert.ok(
    clientSource.includes("if (created.parentElement === parent && created.nextSibling === target) return;"),
    "placement must be idempotent so the observer never writes on steady state"
  );
  assert.ok(
    /place\(cur\);\s*\n\s*sync\(cur\);/.test(clientSource),
    "the observer must re-place the entry and re-read its classes on childList churn"
  );
});

// 用户实测确认的遮挡 bug（v0.8.10）：收起侧边栏时入口沿用宿主给「新会话」的
// left:48px，正好压在「新会话」图标上把它盖掉，左上角只剩两颗图标。
// 修法：不再共用那个 left，用一条更具体的规则推到 84px（「新会话」右侧 =
// 宿主 48px + 钮宽 28px + 间距 8px），并把宿主的面板菜单变量
// --dsh-windows-menu-start（宿主收起态自己设 84px）顺延到 120px。
// 回归表现：左上角少一颗图标，或「应用 / 编辑」与记忆图标叠在一起。
test("collapsed entry vacates the New-Session slot instead of covering it", () => {
  assert.ok(
    clientSource.includes("html[data-windows-titlebar] .mneme-topentry .mneme-topentry-rail{left:84px}"),
    "the collapsed entry must sit right of the host's 48px New-Session slot"
  );
  assert.ok(
    // 源码里这段 CSS 含转义引号（注入 <style> 后才还原成普通引号），断言按源码字面量写。
    clientSource.includes(':has([data-plugin-entry=\\"@modusensus/dsh-mneme\\"]){--dsh-windows-menu-start:120px}'),
    "the caption menu must shift right so the memory icon never overlaps 应用 / 编辑"
  );
  assert.ok(
    clientSource.includes(":has([data-sidebar-collapsed=true]):has("),
    "the menu shift must apply only while the sidebar is collapsed"
  );
  assert.ok(
    clientSource.includes("`${cls.row} mneme-topentry-rail`.trim()"),
    "the collapsed button carries the host New-Session class plus our rail offset rule"
  );
});

// 宿主面板行的类名带着激活态修饰类（.xxx_panelActive），而我们的入口不是
// panel 插槽的成员、永远不该常亮；照抄整串类名会让记忆入口跟着宿主当前选中
// 的面板一起高亮。这里锁「读类名时必须剔掉激活态」。
test("panel-row highlight never leaks onto the memory entry", () => {
  assert.ok(
    clientSource.includes('!name.includes("panelActive")'),
    "panelActive must be filtered out of the copied host row classes"
  );
});

// Three alignment/softness guarantees born from field feedback: (a) the
// portalled entry re-reads the live host classes on every mutation — the host
// and skins rewrite hashed class names asynchronously, so a mount-time snapshot
// goes stale (收起态尤其依赖这条：搬迁后类名必须重新对齐宿主「新会话」按钮),
// (b) it never hardcodes a width, so whichever host class it carries decides the
// box model, (c) the toolbar dropdown escapes the transform stacking trap — the
// container needs the z-index because transform creates the context.
test("entry re-reads the live host classes and lifts the toolbar dropdown", () => {
  assert.ok(
    clientSource.includes("new MutationObserver"),
    "the entry must re-sync the copied class via MutationObserver"
  );
  assert.ok(
    clientSource.includes('attributeFilter: ["class"]'),
    "the observer must watch class attribute changes"
  );
  assert.doesNotMatch(
    clientSource,
    /\.mneme-topentry-native\{(?:[^}]*;)?width:/,
    "the entry must use the native button width, which reserves its horizontal margins"
  );
  assert.ok(
    clientSource.includes(".mneme-topentry{display:flex;flex-direction:column;position:relative}"),
    "the entry wrapper must stretch the native button within a column flex layout (position:relative hosts the #177 badge)"
  );
  assert.equal(
    clientSource.includes(".mneme-topentry-native .mneme-topentry-label{flex:1;min-width:0;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"),
    false,
    "the old left-aligned label override must go; native centering applies"
  );
  assert.ok(
    /\.mneme-xtools\{[^}]*z-index:3\}/.test(clientSource),
    "the toolbar container must carry z-index:3 (sticky month header is 2, drawer 6)"
  );
});

// Importance renders as Lucide star glyphs (the morphicons-paired data set;
// the runtime cannot require the ESM-only morphicons engine, so the path
// ships inline like the other stroke icons). Raw text stars are fully
// retired: the drawer's edit-mode <option> select used to keep "★".repeat
// labels (SVG cannot render inside <option>) — it is now the SVG star
// button row, and the inline indicators (importance chips / entity meta /
// inject preview) share the same StarGlyph, so every star in the panel has
// one shape. (用户反馈：文本 ★ 过尖、与卡片 SVG 星不统一。)
test("importance renders as star glyphs, not raw text stars", () => {
  assert.ok(
    clientSource.includes("STAR_PATH_D"),
    "the Lucide star path data must be inlined"
  );
  assert.ok(
    clientSource.includes("const ImportanceStars"),
    "the star-row component must exist"
  );
  assert.equal(
    (clientSource.match(/★/g) || []).length,
    0,
    "no raw text star may remain anywhere — every star renders through the shared SVG path"
  );
  assert.ok(
    /h\(ImportanceStars, \{ className: "mneme-dmetaval"/.test(clientSource),
    "the drawer detail must render the star row"
  );
  assert.ok(
    /h\(ImportanceStars, \{ value: m\.importance/.test(clientSource),
    "the card foot must render the star row"
  );
  assert.ok(
    /className: "mneme-staredit"/.test(clientSource),
    "the drawer edit importance must be the SVG star button row, not a text-star <select>"
  );
  assert.ok(
    /h\(StarGlyph, \{ size: 11 \}\)/.test(clientSource),
    "inline star indicators must go through the shared StarGlyph"
  );
});

// better-sidebar ecosystem integration is an optional capability (official
// external-plugin-guide §2.2): 'betterSidebar' IS declared in inject (DSH's
// runtime gates ctx property access on the inject declaration — probing
// without declaring fails the whole loader entry, verified in the field) and
// better-sidebar 软集成（issue #88 修正）：模块级 inject 声明 betterSidebar
// 是硬等待——未安装 bs 的环境整个 entry pending（"1 entry did not activate"，
// Failed to load plugins）。正确模式（dsh-server-deck 同款）：外层入口零
// inject 立即激活（独立模式保底），tab 注册挂在内层动态子插件
// ctx.plugin({ inject: ['betterSidebar'] }) 由 cordis 原生等待服务——bs 未装
// 时该内层 fiber 永远 INACTIVE，静默无害。
test("better-sidebar tab mounts via an inner sub-plugin, standalone mode intact", () => {
  assert.ok(
    /const reg = bsCtx\.betterSidebar;[\s\S]{0,60}typeof reg\.registerTab !== "function"/.test(clientSource),
    "the inner apply must still guard the service shape before registering"
  );
  assert.ok(
    /(?:const TAB_ID = |id: )"dsh-mneme:memory"/.test(clientSource),
    "the registered tab id must be package-prefixed"
  );
  assert.ok(
    /title: \(\) => t\("memory\.view\.label"\)/.test(clientSource),
    "the tab title must reuse the localized 记忆库 label"
  );
  assert.ok(
    /component: \(\) => h\(MemoryExplorer, \{ t \}\)/.test(clientSource),
    "the tab must reuse the MemoryExplorer views"
  );
  assert.ok(
    clientSource.includes('"dsh-mneme: better-sidebar tab"'),
    "the registration effect must carry a named label for scope cleanup"
  );
  // issue #88：模块级 inject 声明 betterSidebar 是硬等待——未安装 bs 的环境
  // 整个 entry pending（"1 entry did not activate"）。tab 注册必须挂在内层
  // 动态子插件（dsh-server-deck 同款模式），外层入口零 inject 立即激活。
  assert.ok(
    /const inject = \["slots", "locale"\]/.test(clientSource),
    "the module inject must not declare betterSidebar (hard-wait regression)"
  );
  assert.ok(
    /ctx\.plugin\?\.\(\{[\s\S]*?inject: \["betterSidebar"\][\s\S]*?apply: \(bsCtx\) =>/.test(clientSource),
    "the tab registration must live in an inner dynamic sub-plugin waiting on cordis"
  );
  assert.ok(
    /if \(\+\+tries <= 10\) timer = setTimeout\(attempt, 1000\);/.test(clientSource) === false,
    "the old 10×1s probe must go — cordis waits for the inner inject natively"
  );
});

// The graph toggle must not read as "share": the primitives share icon is
// banned and a custom node-graph glyph takes its place.
test("graph toggle uses a node-graph glyph, not the share icon", () => {
  assert.equal(
    clientSource.includes("IconShareOutline16"),
    false,
    "IconShareOutline16 reads as share and must not appear"
  );
  assert.ok(
    clientSource.includes("GraphNodesIcon"),
    "the custom node-graph icon must back the graph toggle"
  );
});

// #287 的成因已经不存在了，但那条教训要留着：当年的崩法是「宿主图标名换代 →
// 取到 undefined → h(undefined) 即 React #130，整个 slot entry 崩掉」。现在的解法
// 不是继续探测多代名字，而是**不再依赖宿主图标库**——插件自己画 mneme mark。
// 这条用例锁三件事：(a) 客户端里不再有对宿主 IconArchive* 名字的探测（回到探测
// 就等于把 #287 那类耦合请回来）；(b) mark 走一个内联 SVG 组件、自带路径常量；
// (c) 四个入口共用同一个 helper，避免某处漏改又出现"归档盒"。
test("mneme mark is self-drawn: no host icon-name probing left (#287 root cause)", () => {
  assert.equal(
    /primitives\.IconArchiveOutline(20|Regular|Medium)/.test(clientSource),
    false,
    "the client must not probe host archive glyph names any more"
  );
  assert.ok(
    /const MNEME_MARK_D = "M[^"]+"/.test(clientSource),
    "the mark must carry its own path constant"
  );
  assert.ok(
    clientSource.includes('viewBox: "0 0 16 16"') && clientSource.includes('stroke: "currentColor"'),
    "the mark must follow the host icon spec (16 grid, currentColor) so it reads as first-party"
  );
  assert.ok(
    /const renderMnemeMark = \(props\) => h\(MnemeMark, props\)/.test(clientSource),
    "the mark must render through one shared helper"
  );
  for (const site of [
    "renderMnemeMark({ size: 15 })",              // 浮层标题栏
    "renderMnemeMark({ size: wide ? 16 : 18 })",  // 侧栏 trigger + portal 入口（面板行档 16 / 标题栏档 18）
    "renderMnemeMark({ size })"                   // better-sidebar tab 图标
  ]) {
    assert.ok(clientSource.includes(site), `every render site must go through the helper: ${site}`);
  }
  assert.equal(
    /renderArchiveIcon/.test(clientSource),
    false,
    "the retired archive-glyph helper must be gone, not left as a second path"
  );
});

// 插件列表那颗图标由宿主从 package.json 的 `icon` 读：必须是**包内相对路径**、
// 落在 files 白名单里、且宿主只接受 SVG/PNG/JPEG/WebP ≤256KiB。
// 宿主 `iconOf()` 的硬规则：绝对路径或带 scheme 直接报错、realpath 后不许跑出
// manifest 目录、超 256KiB 报错；缺文件/坏文件时静默回落成通用插画（等于用户
// 看到的不是自家图标）。这里把可静态检的部分全锁住。
test("plugin-list icon: declared, in-package, and shipped in files", () => {
  const icon = pkg.icon;
  assert.equal(typeof icon, "string", "package.json must declare an icon");
  assert.equal(icon, "assets/icon.svg", "the icon must be the self-drawn mark");
  assert.ok(!/^([A-Za-z]:|[A-Za-z][A-Za-z\d+.-]*:)/.test(icon), "the icon must be a relative path (host rejects absolute/URL)");
  assert.ok(pkg.files.includes("assets"), "the assets dir must ship, or the published package has no icon");
  const file = join(root, icon);
  assert.ok(existsSync(file), `the declared icon must exist: ${icon}`);
  const bytes = readFileSync(file);
  assert.ok(bytes.length > 0 && bytes.length <= 256 * 1024, "the icon must be a non-empty file under the host's 256 KiB cap");
  const svg = bytes.toString("utf8");
  assert.ok(svg.includes("<svg") && svg.includes("viewBox"), "the icon must be an SVG with a viewBox");
  // <img> 不能继承 currentColor：文件必须自带颜色，否则会渲染成黑块/不可见。
  assert.ok(/stroke="#[0-9a-fA-F]{6}"/.test(svg), "the standalone file must bake its own colour (<img> cannot inherit currentColor)");
  // 文件与客户端内联路径必须是同一颗：两边形状漂移是最容易悄悄发生的事。
  const inline = clientSource.match(/const MNEME_MARK_D = "([^"]+)"/)[1];
  assert.ok(svg.includes(inline), "assets/icon.svg must use the same path as the inline mark (no shape drift)");
});

// 插件列表的标题/描述读包内的 `locale/<语言码>.json`：宿主 readPluginMeta 先解析
// `<specifier>/locale/en.json`，再遍历同目录的每个 *.json（文件名必须过语言码正则），
// 取 meta.title / meta.description；一个都读不到就回落到 package.json 的 name——
// 也就是裸包名 "@modusensus/dsh-mneme"（用户看到的现状）。
// ⚠️ 真正的门槛是**能否被 Node 解析**：宿主用 ESM resolver 取这个文件，而 exports
// 字段会把没列出的子路径**全部挡掉**，且 optionalResourcePath 对"读不到"是静默的
// （返回 undefined 继续走回落），不报错。所以少了 "./locale/*" 这一行，文件乖乖躺在
// 包里也永远不生效——这条回归极难靠肉眼发现，必须锁死。
test("plugin-list title/description are localized through locale/*.json", () => {
  assert.ok(
    Object.keys(pkg.exports).includes("./locale/*"),
    "exports must expose ./locale/* or the host resolver silently never reads the dictionaries"
  );
  assert.ok(pkg.files.includes("locale"), "the locale dir must ship in files, or the published package loses it");
  const dir = join(root, "locale");
  assert.ok(existsSync(dir), "locale/ must exist");
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  assert.ok(files.length >= 2, "at least an English and a Chinese dictionary must ship");
  for (const name of files) {
    const language = name.slice(0, -5);
    assert.match(language, /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/, `locale/${name} must be named after a language id`);
    const parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
    assert.equal(typeof parsed.meta, "object", `locale/${name} must carry a meta block`);
    assert.ok(typeof parsed.meta.title === "string" && parsed.meta.title.trim() !== "", `locale/${name}: meta.title must be a non-empty string`);
    assert.ok(
      typeof parsed.meta.description === "string" && parsed.meta.description.trim() !== "",
      `locale/${name}: meta.description must be a non-empty string`
    );
  }
  const en = JSON.parse(readFileSync(join(dir, "en.json"), "utf8"));
  assert.ok(en.meta.title !== pkg.name, "the English title must not be the bare package name (that is the bug this fixes)");
});

// 方案 A：查询收敛。状态页只做仪表盘（小页预览 + 服务端 total + 查看全部），
// 沉淀/归档的完整浏览走记忆库的 deposited/archived 筛选视图（chip 预置 +
// 状态页入口跳转），详情抽屉给归档记忆一个反向的「恢复」。
test("status dashboard links into deposited/archived library views", () => {
  assert.ok(
    clientSource.includes('"/api/dsh-mneme/list?deposited=only&limit=8&order=chrono"'),
    "the workbench deposited preview must read the server-side deposited view"
  );
  assert.ok(
    clientSource.includes('"/api/dsh-mneme/list?archived=only&limit=3&order=chrono"'),
    "the workbench archived preview must cap at 3 rows backed by a server total"
  );
  assert.ok(
    clientSource.includes("browseWithFilter"),
    "the status page must jump into the library with preset filters"
  );
  assert.ok(
    /view === "status" && h\(StatusPanel, \{ t, onBrowse: browseWithFilter \}\)/.test(clientSource),
    "the status panel must receive the browse-jump callback"
  );
  assert.ok(
    clientSource.includes('(depositedOnly ? "&deposited=only" : "")'),
    "the library filterQS must carry the deposited chip"
  );
  assert.ok(
    clientSource.includes('(archivedOnly ? "&archived=only" : "")'),
    "the library filterQS must carry the archived chip"
  );
  assert.ok(
    clientSource.includes('postUpdate({ archived: false }, { restored: true })'),
    "the drawer must offer restore for archived memories"
  );
  assert.ok(
    clientSource.includes('"memory.status.viewAll"'),
    "the view-all entries must come from the dictionary"
  );
});

// Every memory feature lives in the main-area library now: the explorer
// hosts three sub-views (browse / entities / settings) switched by tabs whose
// labels come from dedicated dictionary keys.
test("explorer hosts browse, entities and settings sub-views", () => {
  for (const key of ["tabMemory", "tabEntities", "tabSettings"]) {
    assert.ok(
      clientSource.includes(`"memory.explorer.${key}"`),
      `sub-view labels must come from memory.explorer.${key}`
    );
  }
  assert.ok(
    clientSource.includes("h(EntityPanel, { t, focusEntity: graphFocus, onJumpMemory: jumpToMemory })"),
    "the entity panel must be embedded as a sub-view"
  );
  assert.ok(
    clientSource.includes('h(SettingsContent, { t })'),
    "the settings forms must be embedded as a sub-view"
  );
});

// The graph panel jumps back into the browser: related-memory rows and the
// edge source button must land on the browse tab with the target selected.
test("graph jump lands on the selected memory in the browser", () => {
  assert.ok(
    /onClick: \(\) => onJumpMemory && onJumpMemory\(m\)/.test(clientSource),
    "related-memory rows must jump via onJumpMemory(m)"
  );
  assert.ok(
    clientSource.includes("onJumpMemory({ id: selected.edge.memory_id })"),
    "the edge source button must jump to the origin memory by id"
  );
  assert.ok(
    /const jumpToMemory = \(target\) => \{/.test(clientSource),
    "jumpToMemory must reset filters and select the target"
  );
});

// "entity:" in the browser search is the graph entry grammar: it must offer
// a jump chip instead of filtering the list.
test("entity: search grammar offers a graph jump", () => {
  assert.ok(
    clientSource.includes('query.trim().startsWith("entity:")'),
    "the entity: prefix must be recognized"
  );
  assert.ok(
    /onClick: \(\) => openGraphFor\(entityQuery\)/.test(clientSource),
    "the jump chip must switch to the graph sub-view"
  );
});

// The explorer is a card-grid / timeline browse with a right-hand detail
// drawer: types with counts, a month→day time tree (timeline mode), and the
// drawer rendering the untruncated content.
test("explorer lays out types, timeline, and full-text detail", () => {
  assert.ok(
    clientSource.includes('className: "mneme-xmain"'),
    "the three-column grid must be present"
  );
  assert.ok(
    clientSource.includes('className: "mneme-dcontent"'),
    "the detail drawer must render the full content"
  );
  assert.ok(
    clientSource.includes('className: "mneme-cards"'),
    "the card-grid view must exist alongside the timeline"
  );
  assert.ok(
    /toLocaleDateString\(undefined, \{ year: "numeric", month: "long" \}\)/.test(clientSource),
    "month groups must format via the host locale, not hardcoded strings"
  );
});

// The library page must read as a first-party view: the chrome resolves to
// the host's design tokens (layer-1 canvas, brand-blue active states) and
// the boxed-panel / pill-chip patterns of the drawer era must stay gone.
test("explorer chrome aligns with the host design system", () => {
  assert.ok(
    clientSource.includes("background:var(--dsw-alias-bg-layer-1)"),
    "the page canvas must sit on the host bg-layer-1 token"
  );
  assert.ok(
    /\.mneme-vtab\.mneme-active::after/.test(clientSource),
    "active sub-tabs use the host underline treatment"
  );
  assert.ok(
    clientSource.includes(".mneme-vtab.mneme-active{color:var(--dsw-alias-state-business-primary)}"),
    "active sub-tab text must turn the host brand blue"
  );
  assert.equal(
    /\.mneme-xmain\{[^}]*border:1px/.test(clientSource),
    false,
    "the three-column layout must not wrap itself in a boxed panel"
  );
  assert.equal(
    clientSource.includes("border-radius:999px"),
    false,
    "pill chips belong to the drawer era and must stay gone"
  );
});

// heat 阶段二：/list 仅在 heatEnabled=true 时下发逐条 heat，前端徽章三档
// 配色且自门控（字段缺省自动隐藏）——卡片页脚、抽屉 meta、状态分布卡共用
// 同一数据源，前端不感知开关状态。
test("heat badges render from the /list projection and self-hide when off", () => {
  assert.ok(
    /const HeatBadge = \(\{ value, size = 12 \}\) =>/.test(clientSource),
    "the heat badge component must exist"
  );
  assert.ok(
    clientSource.includes("flame:"),
    "the Lucide flame glyph must back the badge"
  );
  assert.ok(
    /h\(HeatBadge, \{ value: m\.heat \}\)/.test(clientSource),
    "the card foot must render the heat badge"
  );
  assert.ok(
    clientSource.includes('t("memory.explorer.heat")'),
    "the drawer must show a localized heat meta row"
  );
  assert.ok(
    clientSource.includes("function HeatStatusCard"),
    "the status grid must include the heat distribution card"
  );
  assert.ok(
    clientSource.includes('typeof items[0].heat !== "number"'),
    "the distribution card must self-hide when /list omits heat"
  );
  assert.ok(
    /\.mneme-heat--hot\{/.test(clientSource),
    "the three-tier heat colors must be styled"
  );
  // order=heat 的前端补口：热度是运行时投影无存储序，SQL 排不了——页内
  // 对已加载条目降序，时间树保持 chrono；chip 自门控（heat 缺省不出现）。
  assert.ok(
    /const heatAvailable = visible\.some\(\(m\) => typeof m\.heat === "number"\);/.test(clientSource),
    "the heat-sort chip must self-gate on the /list heat field"
  );
  assert.ok(
    /const gridItems = heatSort[\s\S]{0,80}\(b\.heat \?\? 0\) - \(a\.heat \?\? 0\)/.test(clientSource),
    "the cards grid must sort loaded items by heat in-page"
  );
  assert.ok(
    clientSource.includes("if (!heatSort) switchViewMode(\"cards\")"),
    "toggling heat sort must land on the cards view (sort does not apply to the month tree)"
  );
});

// 巩固/睡眠模型路由 UI：下拉数据来自宿主侧已注册适配器（/llm-providers，
// 云端插件侧端点），「测试连通性」走 POST /test-model 真实最小调用。旧后端
// 端点 404 时必须回退纯文本输入——前端自门控，不挡旧版本。
test("consolidation/sleep model routing: provider dropdowns from /llm-providers, connectivity test via /test-model, graceful fallback", () => {
  // 1. 端点探测与降级
  assert.ok(
    clientSource.includes('apiFetch("/api/dsh-mneme/llm-providers")'),
    "the features card must probe GET /llm-providers for the route dropdowns"
  );
  assert.ok(
    /setRoutes\(Array\.isArray\(j && j\.providers\) \? j\.providers : \[\]\)/.test(clientSource),
    "the probe must only accept a {providers: []} shape"
  );
  assert.ok(
    /Array\.isArray\(routes\)\s*\?\s*routeSelects\("dreamProvider", "dreamModel", dreamTest, setDreamTest, "dreamReasoningEffort"\)/.test(clientSource),
    "dream routing must upgrade to dropdowns only when the probe succeeded (and pass its own effort key)"
  );
  assert.ok(
    /:\s*h\(react\.Fragment, null, strRow\("dreamProvider"\), strRow\("dreamModel"\)\)/.test(clientSource),
    "when /llm-providers is unavailable the plain text inputs must remain (old-backend fallback)"
  );
  // 2. 睡眠侧行：跟随 sleepModeEnabled 门控，与巩固共用数据源
  assert.ok(
    /const sleepSub = eff\.sleepModeEnabled && Array\.isArray\(routes\) && h\("div", \{ className: "mneme-featsub" \},\s*\n\s*routeSelects\("sleepProvider", "sleepModel", sleepTest, setSleepTest, "sleepReasoningEffort"\)/.test(clientSource),
    "the sleep route row must gate on sleepModeEnabled and share the providers source"
  );
  // 2b. 睡眠路由的值必须进初始化草稿：FEATURE_STRINGS 漏键会导致重挂载后
  // 下拉永远显示「跟随默认路由」（后端存了但前端读不回来）。
  assert.ok(
    /const FEATURE_STRINGS = \["dreamProvider", "dreamModel", "sleepProvider", "sleepModel",/.test(clientSource),
    "sleepProvider/sleepModel must be restored into the draft on mount, not only written"
  );
  // 2c. 连通性测试状态按路由各持一份：共享单份会让点一个按钮两个组同时
    // 显示「测试中/结果」且互相禁用。
  assert.ok(
    /const \[dreamTest, setDreamTest\] = useState\(null\);/.test(clientSource)
      && /const \[sleepTest, setSleepTest\] = useState\(null\);/.test(clientSource),
    "the connectivity test state must be per-route, not shared between dream and sleep"
  );
  assert.ok(
    /runModelTest\(curP, curM, setTestState, effort\)/.test(clientSource),
    "each route's test button must target its own test state and pass the route's configured effort"
  );
  // 3. 连通性测试：真实最小调用 + 结果展示（成功/失败 + 耗时 + 报错原因）
  assert.ok(
    clientSource.includes('apiFetch("/api/dsh-mneme/test-model", {'),
    "the connectivity test must POST /test-model"
  );
  assert.ok(
    /body: JSON\.stringify\(\{\s*provider, model,\s*\.\.\.\(reasoningEffort && reasoningEffort !== "none" \? \{ reasoningEffort \} : \{\}\)\s*\}\)/.test(clientSource),
    "the test payload must carry provider/model plus the configured reasoningEffort, omitted for 'none'/unset (issue #215, same convention as the backend)"
  );
  assert.ok(
    /typeof j\.durationMs === "number" \? j\.durationMs : Date\.now\(\) - started/.test(clientSource),
    "the result duration must prefer the backend's durationMs and fall back to client timing"
  );
  assert.ok(
    /detail: \[j\.modelId, j\.reply \? "「" \+ j\.reply \+ "」" : ""\]\.filter\(Boolean\)\.join\(" · "\)/.test(clientSource),
    "the success line must surface the model's actual reply (backend caps it at 100 chars)"
  );
  assert.ok(
    /detail: \[j\.modelId, j\.error \|\| "HTTP " \+ res\.status\]\.filter\(Boolean\)\.join\(" · "\)/.test(clientSource),
    "the failure line must carry the tested modelId plus the backend error (502/400 bodies)"
  );
  assert.ok(
    clientSource.includes("memory.features.modelTestOk") && clientSource.includes("memory.features.modelTestFail"),
    "the result line must render success/failure with the localized labels"
  );
  // 4. 下拉改动即提交（与 embedProvider 一致），当前值不在枚举时保留为额外选项
  assert.ok(
    /setStrs\(\(c\) => \(\{ \.\.\.c, \[key\]: v \}\)\);\s*\n\s*put\(\{ \[key\]: v \}\)/.test(clientSource),
    "select changes must commit through the features PUT like the embed provider select"
  );
  assert.ok(
    /curM && !mVals\.includes\(curM\) \? h\("option", \{ key: "current", value: curM \},\s*\n\s*mStale \? curM \+ t\("memory\.features\.routeStaleMark"\) : curM\) : null/.test(clientSource),
    "a configured value missing from the provider's model list must survive as an extra option, marked when stale (issue #191)"
  );
  // 5. 双语 i18n 与样式
  for (const key of ["routeFollowDefault", "modelTest", "modelTesting", "modelTestOk", "modelTestFail", "modelTestHint", "routeStaleMark", "routeStaleHint", "sleepModelHint"]) {
    const occurrences = clientSource.split(`"memory.features.${key}"`).length - 1;
    assert.ok(occurrences >= 2, `i18n key memory.features.${key} must exist in both zh and en (got ${occurrences})`);
  }
  assert.ok(
    clientSource.includes(".mneme-routeselect{width:240px;max-width:60%}"),
    "the route selects must share the string-input width budget"
  );
});

// issue #191：级联下拉刻意保留不在列表里的旧值（不丢配置），但此前与正常
// 选项无差别展示——切 Provider 后残留的中继风格 model id 照常保存，用户分
// 不清「改错了」还是「还没生效」。旧值必须显式标记 + 行级提示（改选或点连
// 通性测试当场验证 + 重启生效）；适配器列表为空或 provider 未注册时前端无
// 从校验 model，一律不标记防误报。
test("stale route values are marked and explained at the row level (issue #191)", () => {
  // 1. 旧值判定：仅在适配器列表非空时比对；model 只在 provider 已注册时校验
  assert.ok(
    /const hasProviders = entries\.length > 0;/.test(clientSource),
    "stale checks must be gated on a non-empty provider registry (no false alarms)"
  );
  assert.ok(
    /const pStale = hasProviders && !!curP && !entry;/.test(clientSource),
    "a saved provider missing from /llm-providers must be flagged"
  );
  assert.ok(
    /const mStale = hasProviders && !!entry && !!curM && !mVals\.includes\(curM\);/.test(clientSource),
    "a saved model outside the selected provider's list must be flagged only when that provider is registered"
  );
  // 2. 标记落在选项文本上：下拉收起时也能看出旧值不在列表
  assert.ok(
    /pStale && p === curP \? p \+ t\("memory\.features\.routeStaleMark"\) : p/.test(clientSource),
    "the preserved provider option must carry the stale mark"
  );
  // 3. 行级提示：⚠ 警示 + 改选/测试引导 + 重启生效，一条提示说完
  assert.ok(
    /\(pStale \|\| mStale\) && h\("div", \{ className: "mneme-featsubhint" \},\s*\n\s*"⚠ " \+ t\("memory\.features\.routeStaleHint"\)/.test(clientSource),
    "the stale warning hint must render at the route row with the warning prefix"
  );
  // 3b. 旧值保留必须无条件：列表为空（端点刚起 / 零适配器）时也不得把已存
  // provider 静默显示成「跟随默认路由」——只有标记带门，保留不带门。
  assert.ok(
    /curP && !entries\.some\(\(p\) => p\.provider === curP\) \? \[curP\] : \[\]/.test(clientSource),
    "the preserved provider option must stay unconditional (empty list must not hide the saved value)"
  );
  // 3c. 英文提示不得把「不在列表」限定在 model 维度——provider 本身不在
  // 列表时同样渲染此行（CodeRabbit #213 review）。
  assert.ok(
    !clientSource.includes("provider's model list"),
    "the en stale hint must cover provider-absence too, not only the model case"
  );
  // 4. issue #215：三条路由各自透传自己的档位键——routeSelects 按路由行
  // 传入键名、从生效配置取值；sleep 无回退重试，档位被拒时测试是事前唯一
  // 的暴露口。
  assert.ok(
    /const routeSelects = \(providerKey, modelKey, testState, setTestState, effortKey\) => \{/.test(clientSource)
      && /const effort = effortKey \? \(eff\[effortKey\] \|\| ""\) : ""/.test(clientSource),
    "routeSelects must take the route's effort key and read the configured value from effective settings"
  );
  assert.ok(
    /routeSelects\("dreamProvider", "dreamModel", dreamTest, setDreamTest, "dreamReasoningEffort"\)/.test(clientSource)
      && /routeSelects\("sleepProvider", "sleepModel", sleepTest, setSleepTest, "sleepReasoningEffort"\)/.test(clientSource)
      && /routeSelects\("entityExtractionProvider", "entityExtractionModel", entityTest, setEntityTest, "entityExtractionReasoning"\)/.test(clientSource),
    "each route row must pass its own reasoning effort key (dream/sleep/entityExtraction)"
  );
  // 4. 连通性测试按钮的说明与结果互斥（同一行槽位二选一，不堆叠）
  assert.ok(
    /\(testState && !testState\.running\s*\n\s*\? h\("div", \{ className: "mneme-featsubhint" \},/.test(clientSource)
      && clientSource.includes('t("memory.features.modelTestHint")'),
    "the test row must show either the result or the standing explanation, never both"
  );
});

// 帮助与反馈入口（v0.8）：设置页底部三个反馈链接——GitHub 新建 issue 预填
// （环境信息）、邮件反馈、浏览已知问题。纯前端链接零后端成本；插件版本从
// /info 拉取（version 只读，不铺任何 token/凭据）。公开链接不得带个人邮箱。
test("settings feedback card: prefilled issue + mailto + browse, version from /info", () => {
  // 1. 版本预填端点
  assert.ok(
    clientSource.includes('apiFetch("/api/dsh-mneme/info")'),
    "the feedback card must fetch the plugin version from /info"
  );
  assert.ok(
    clientSource.includes("setPkgVersion"),
    "the fetched version must land in component state"
  );
  // 2. GitHub 新建 issue：issues/new?title=&body= 预填环境信息（当前仓库无模板）
  assert.ok(
    clientSource.includes("https://github.com/slow-stack/mneme/issues/new?title="),
    "the issue link must prefill title+body on issues/new"
  );
  assert.ok(
    clientSource.includes("**插件版本**") && clientSource.includes("**平台**"),
    "the prefill body must carry plugin version and platform"
  );
  // 3. 邮件反馈：官方邮箱（对外不写个人邮箱），mailto 预填 subject+body
  assert.ok(
    clientSource.includes("mailto:work@modusensus.space?subject="),
    "the mailto link must point at the public support address"
  );
  // 4. 浏览已知问题：跳仓库 issues 列表页（去重前置步骤）
  assert.ok(
    clientSource.includes('href: "https://github.com/slow-stack/mneme/issues"'),
    "the browse link must open the repo issues list"
  );
  // 5. 双语 i18n
  for (const key of ["feedback.title", "feedback.newIssue", "feedback.email", "feedback.browse", "feedback.hint"]) {
    const occurrences = clientSource.split(`"memory.settings.${key}"`).length - 1;
    assert.ok(occurrences >= 2, `i18n key memory.settings.${key} must exist in both zh and en (got ${occurrences})`);
  }
});

// UI 文案必须双语齐全（中英各一条）。用户明确要求所有 UI 文字都做 i18n，
// 这条守卫用「每个键恰好出现两次」兜住：出现奇数次就是漏译，>2 次说明重复。
test("i18n keys are bilingual: every key appears exactly twice (zh + en)", () => {
  const counts = new Map();
  for (const match of clientSource.matchAll(/^\s*"([a-zA-Z0-9_.]+)"\s*:\s*"/gm)) {
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  const odd = [...counts.entries()].filter(([, n]) => n !== 2).map(([key, n]) => `${key}×${n}`);
  assert.deepEqual(odd, [], `这些 i18n 键没有做到中英各一条：${odd.join(", ")}`);
  assert.ok(counts.size > 100, `解析到的键太少（${counts.size}），正则可能没匹配到 i18n 表`);
});

// issue #135：向量状态卡必须区分「没配」与「配了却一条都没嵌上」。此前卡片只看
// ready，而未配置的 legacy embedder（ready 恒 true）一路显示成正常 provider。
test("vector status card surfaces the configured/degraded split", () => {
  // 1. 读后端新字段，缺失（旧服务端）时退化成旧行为而不是误报未配置
  assert.ok(
    clientSource.includes('typeof j?.configured === "boolean" ? j.configured : null'),
    "the card must read `configured` and tolerate older servers that omit it"
  );
  assert.ok(
    clientSource.includes("j?.degraded === true"),
    "the card must read `degraded`"
  );
  // 2. 三态互斥：未配置优先于初始化中，降级只在既非未配置也非初始化时成立
  assert.ok(
    clientSource.includes("const unconfigured = !off && state.configured === false;"),
    "unconfigured must be its own state, not folded into ready"
  );
  assert.ok(
    clientSource.includes("const pending = !off && !unconfigured && state.ready !== true;"),
    "an unconfigured embedder must not be reported as initializing"
  );
  assert.ok(
    clientSource.includes("const degraded = !off && !unconfigured && !pending && state.degraded === true;"),
    "degraded must only apply to a configured, settled embedder"
  );
  // 3. 三个状态各自的标签/说明走 i18n，双语齐备
  for (const key of ["vectorUnconfigured", "vectorUnconfiguredHint", "vectorDegradedHint"]) {
    const occurrences = clientSource.split(`"memory.status.${key}"`).length - 1;
    assert.ok(occurrences >= 2, `i18n key memory.status.${key} must exist in both zh and en (got ${occurrences})`);
  }
  assert.ok(
    clientSource.includes('t("memory.status.vectorUnconfigured")'),
    "the unconfigured state must render its own label"
  );
  assert.ok(
    clientSource.includes('t("memory.status.vectorDegradedHint")'),
    "the degraded state must render its own caption (0 of {m} indexed)"
  );
});

// v0.8.0 A4（issue #17）：作用域隔离的面板面——设置卡新组（scopeEnabled /
// strictScope 开关）+ 记忆条目的 scope provenance 展示。i18n 键必须中英双语
// 齐全；徽章/详情行沿用 heat 徽章的「字段缺省即不渲染」模式，前端不感知开关。
/**
 * A4（issue #17）面板面回归：作用域隔离的设置卡分组、十个 i18n 键的中英双语
 * 齐备（沿用 occurrences ≥ 2 模式），以及 ScopeBadge 组件与三处接线（cards
 * 脚部 / timeline 行 / 详情抽屉 dmeta）的真实存在性——只做源码断言，不挂
 * React 渲染环境，与文件内其他 clientSource 断言同一风格。
 */
test("scope isolation ships panel switches and provenance surfaces (A4)", () => {
  assert.ok(
    /key: "group\.scope", items: \["scopeEnabled", "strictScope"\]/.test(clientSource),
    "FEATURE_GROUPS must carry a dedicated scope group"
  );
  for (const key of [
    "memory.features.group.scope",
    "memory.features.scopeEnabled",
    "memory.features.scopeEnabled.hint",
    "memory.features.strictScope",
    "memory.features.strictScope.hint",
    "memory.explorer.scopeBadge",
    "memory.explorer.detail.agentScope",
    "memory.explorer.detail.workspaceScope",
    "memory.explorer.detail.sensitivity",
    "memory.explorer.detail.occurred"
  ]) {
    const occurrences = clientSource.split(`"${key}"`).length - 1;
    assert.ok(occurrences >= 2, `i18n key ${key} must exist in both zh and en (got ${occurrences})`);
  }
  assert.ok(/const ScopeBadge = \(\{ m, t \}\)/.test(clientSource), "ScopeBadge component must exist");
  assert.ok(clientSource.includes("h(ScopeBadge, { m, t })"), "ScopeBadge must be wired into browse views");
  assert.ok(clientSource.includes('t("memory.explorer.detail.agentScope")'), "drawer must render agent scope row");
  assert.ok(clientSource.includes('t("memory.explorer.detail.occurred")'), "drawer must render occurred row");
});

// v0.8.0 冲突集中处理：状态页的待确认冲突队列（reason + 双方内容对比 +
// 保留 A/B/仅标记动作），resolveConflictPending 的第一个前端出口。双语齐备。
test("conflict queue ships a central review surface on the status tab", () => {
  for (const key of [
    "memory.status.conflictQueue.reason",
    "memory.status.conflictQueue.sideA",
    "memory.status.conflictQueue.sideB",
    "memory.status.conflictQueue.keepA",
    "memory.status.conflictQueue.keepB",
    "memory.status.conflictQueue.markReviewed",
    "memory.status.conflictQueue.applyHint",
    "memory.status.conflictQueue.missing",
    "memory.status.conflictQueue.refresh"
  ]) {
    const occurrences = clientSource.split(`"${key}"`).length - 1;
    assert.ok(occurrences >= 2, `i18n key ${key} must exist in both zh and en (got ${occurrences})`);
  }
  assert.ok(/function ConflictsQueue\(\{ t \}\)/.test(clientSource), "ConflictsQueue component must exist");
  assert.ok(clientSource.includes('"/api/dsh-mneme/conflicts"'), "queue must fetch the conflicts endpoint");
  assert.ok(clientSource.includes('"/api/dsh-mneme/conflicts/resolve"'), "queue must call the resolve endpoint");
  assert.ok(clientSource.includes("h(ConflictsQueue, { t })"), "status tab must render the queue");
});

// --- issue #178 批次一：无障碍（aria-live 网络 / 语义标题 / 焦点管理 / 图摘要） ---

// 面板瞬时反馈（保存/裁决/刷新/复制）不能只靠纯视觉 span：announce() 单例
// polite live region 是唯一的播报通道，所有接线点都必须走它。
test("a11y: announce() live region exists and every transient feedback routes through it", () => {
  assert.ok(clientSource.includes('function announce(text)'), "module-level announce() must exist");
  assert.ok(clientSource.includes('"aria-live"'), "live region must set aria-live");
  assert.ok(clientSource.includes('"role", "status"'), "live region must carry role=status");
  // 接线点：功能开关保存、画像、向量、token、模式、extapi 保存+复制、
  // 记忆编辑保存、队列刷新、裁决完成 —— 至少 9 处。
  const wired = (clientSource.match(/\bannounce\(t\(/g) || []).length;
  assert.ok(wired >= 9, `announce() wiring points expected >= 9, got ${wired}`);
});

// 状态卡标题原来是 div，读屏无法按标题导航；统一 h3（CSS margin 归零防回归）。
test("a11y: status card titles are real headings", () => {
  assert.ok(clientSource.includes('h("h3", { className: "mneme-xcolhead" }'), "StatusCard title must be an h3");
  const css = clientSource.match(/\.mneme-xcolhead\{[^}]*\}/);
  assert.ok(css && css[0].includes("margin:0"), "h3 default margin must be neutralized in CSS");
});

// 弹层焦点管理：Tab 圈在面板内，关闭后焦点还给触发元素（两个 opener 都要标记）。
test("a11y: overlay focus trap and focus restore are wired", () => {
  const openers = (clientSource.match(/"data-mneme-overlay-opener"/g) || []).length;
  assert.equal(openers, 2, "both overlay entry buttons must carry the opener marker");
  assert.ok(clientSource.includes('querySelectorAll(\'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])\')'),
    "overlay must enumerate focusables for the Tab cycle");
  assert.ok(/querySelector\('\[data-mneme-overlay-opener\]'\)/.test(clientSource), "closing must restore focus to the opener");
});

// 冲突裁决按钮「保留 A/B」在同文案多卡片下不可区分，必须带条目标题的 aria-label。
test("a11y: conflict keep buttons carry item-title aria-labels", () => {
  const labels = (clientSource.match(/"aria-label": `\$\{t\("memory\.status\.conflictQueue\.keep/g) || []).length;
  assert.equal(labels, 2, "keepA/keepB buttons must both set aria-label");
});

// ego 关系图对读屏是一块不可达 SVG，必须 role=img + 计数摘要（键中英各一）。
test("a11y: entity graph svg exposes a count summary", () => {
  assert.ok(clientSource.includes('role: "img"'), "graph svg must be role=img");
  for (const key of ["memory.graph.summary"]) {
    const occurrences = clientSource.split(`"${key}"`).length - 1;
    assert.ok(occurrences >= 2, `i18n key ${key} must exist in both zh and en (got ${occurrences})`);
  }
});

// --- issue #177：冲突队列交互与视觉重做 ---

// 相似度进度条：只从「相似度 X / similarity X」锚定短语回收数字（防把年份当
// 相似度），A/B 卡片带侧色类，冻结徽章替代预裁决阶段的「已归档」徽章。
test("conflict queue: similarity bar, side colors and frozen badge", () => {
  assert.ok(clientSource.includes("similarityOf(it.reason)"), "reason must be parsed for similarity");
  assert.ok(clientSource.includes("/(?:相似度|similarity)\\s*([01](?:\\.\\d+)?)/i"), "parse must anchor on the similarity phrase");
  for (const key of ["memory.status.conflictQueue.similarity", "memory.status.conflictQueue.frozenBadge"]) {
    const occurrences = clientSource.split(`"${key}"`).length - 1;
    assert.ok(occurrences >= 2, `i18n key ${key} must exist in both zh and en (got ${occurrences})`);
  }
  assert.ok(clientSource.includes('"mneme-conflict-side--a"'), "side A must carry the A color class");
  assert.ok(clientSource.includes('"mneme-conflict-side--b"'), "side B must carry the B color class");
  assert.ok(!/s\.archived && h\("span", \{ className: "mneme-badge mneme-badge--archived"/.test(clientSource),
    "the pre-ruling archived badge must be replaced by the frozen badge");
  assert.ok(clientSource.includes("mneme-badge--frozen"), "frozen badge class must exist");
});

// 词级 diff：LCS 对齐是纯函数，锁它的存在、上限护栏与渲染接线（无损性由
// difftest 独立验证，此处只锁形状）。
test("conflict queue: word diff is wired with size guards", () => {
  assert.ok(clientSource.includes("function wordDiff(aText, bText)"), "wordDiff must exist");
  assert.ok(clientSource.includes("mneme-conflict-mark--del"), "del highlight class must exist");
  assert.ok(clientSource.includes("mneme-conflict-mark--ins"), "ins highlight class must exist");
  assert.ok(clientSource.includes("n > 800 || m > 800"), "DP must bail on oversized inputs");
});

// 空态教育卡：0 冲突时也渲染（原来整块 return null），解释冻结是什么。
test("conflict queue: empty-state explainer card", () => {
  assert.ok(!/if \(!items \|\| items\.length === 0\) return null;/.test(clientSource),
    "empty queue must render the explainer instead of nothing");
  for (const key of ["memory.status.conflictQueue.emptyTitle", "memory.status.conflictQueue.emptyBody"]) {
    const occurrences = clientSource.split(`"${key}"`).length - 1;
    assert.ok(occurrences >= 2, `i18n key ${key} must exist in both zh and en (got ${occurrences})`);
  }
});

// 状态卡待处理高亮 + 侧边栏入口 badge（挂 portal 与回退两个按钮）。
test("conflict queue: actionable status card and sidebar entry badge", () => {
  assert.ok(clientSource.includes('"mneme-conflict-jump"'), "pending>0 card must carry the highlight class");
  assert.ok(clientSource.includes("mneme-statuscard--actionable"), "highlight CSS must exist");
  assert.ok((clientSource.match(/h\(ConflictBadge, \{ pending \}\)/g) || []).length === 2,
    "badge must be wired into both entry buttons");
  assert.ok((clientSource.match(/= useConflictBadgeCount\(\);/g) || []).length === 2,
    "both entry components must subscribe to the shared badge count");
  assert.ok(clientSource.includes('"/api/dsh-mneme/dream-status"'), "badge must reuse the dream-status endpoint");
});

// 用户反馈「裁决完红点消失得很慢」的根因：裁决成功时冲突队列广播
// mneme:conflicts-changed，但只有状态卡订阅了它，侧边栏红点漏订——红点于是只能
// 等 60s 兜底轮询。本用例锁三类回归：(a) 红点订阅该广播并立即重取；(b) 计数走
// 模块级单例（原先 portal 与 footer 回退各起一个 60s 轮询 → 两份请求且互不同步）；
// (c) 兜底轮询保留（后台 autoDream 自己产生/消解冲突时没人广播，靠它浮现）。
test("sidebar badge clears on the conflicts-changed broadcast, not on the next poll", () => {
  assert.ok(
    /window\.addEventListener\("mneme:conflicts-changed", onChanged\)/.test(clientSource),
    "the badge must subscribe to the broadcast the conflict queue already emits"
  );
  assert.ok(
    clientSource.includes("const conflictBadgeCount = (() => {"),
    "the count must live in one module-level store shared by both entry components"
  );
  assert.ok(
    clientSource.includes("if (listeners.size === 1) {"),
    "exactly one poll timer per store, refcounted by its subscribers"
  );
  assert.ok(
    /setInterval\(refresh, 60_000\)/.test(clientSource),
    "the 60s fallback poll must stay: background autoDream resolves conflicts without broadcasting"
  );
  assert.ok(
    clientSource.includes("if (inflight) return inflight;"),
    "concurrent refreshes (broadcast + open + first subscriber) must collapse into one request"
  );
});

// 上一条锁的是"接线在不在"，这条锁"接线真的按预期跑"。把源码里那段 store 抠出来
// 用受控的 apiFetch / setInterval 真跑一遍——用户抱怨的正是时序（慢），而
// "存在某个字符串" 证明不了任何时序。回归表现：第二个订阅者又开一条轮询、
// 广播后不立刻反映、并发 refresh 打两次请求、订阅者走光后定时器还在跑。
test("badge store: one poll for both entries, immediate publish after a refresh", async () => {
  const src = clientSource.match(/const conflictBadgeCount = \(\(\) => \{[\s\S]*?\}\)\(\);/);
  assert.ok(src, "the badge store source block must be extractable verbatim");
  const calls = [];
  const resolvers = [];
  const timers = [];
  let cleared = 0;
  const makeStore = new Function("apiFetch", "setInterval", "clearInterval",
    `${src[0]}\nreturn conflictBadgeCount;`);
  const store = makeStore(
    (path) => {
      calls.push(path);
      return new Promise((resolve) => { resolvers.push(resolve); });
    },
    (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    () => { cleared += 1; }
  );
  const settle = async (payload) => {
    const batch = resolvers.splice(0, resolvers.length);
    batch.forEach((r) => r({ ok: true, json: () => Promise.resolve(payload) }));
    await new Promise((r) => setTimeout(r, 0));
  };

  const seen = [];
  const un1 = store.subscribe((v) => seen.push(v));
  assert.equal(calls.length, 1, "the first subscriber must trigger exactly one fetch");
  assert.equal(timers.length, 1, "and exactly one timer");
  assert.equal(timers[0].ms, 60_000, "the fallback cadence stays 60s");
  const un2 = store.subscribe((v) => seen.push(v));
  assert.equal(calls.length, 1, "a second subscriber must reuse the poll, not start another");
  assert.equal(timers.length, 1, "still one timer for both entry buttons");

  await settle({ pendingConflicts: 3 });
  assert.deepEqual(seen, [0, 0, 3, 3], "both subscribers must see the same published value");

  // 广播路径：冲突队列裁决成功后 dispatch mneme:conflicts-changed → hook 调 refresh()
  store.refresh();
  store.refresh();
  assert.equal(calls.length, 2, "concurrent refreshes collapse into a single in-flight request");
  await settle({ pendingConflicts: 0 });
  assert.equal(store.get(), 0, "the count must drop as soon as the refreshed value lands");
  assert.equal(seen[seen.length - 1], 0, "and both subscribers must be notified");

  store.refresh();
  await settle({ pendingConflicts: 0 });
  assert.deepEqual(seen, [0, 0, 3, 3, 0, 0], "an unchanged value must not re-render subscribers");

  un1();
  assert.equal(cleared, 0, "the timer must survive while one subscriber remains");
  un2();
  assert.equal(cleared, 1, "the timer must stop when the last subscriber leaves");
});

// --- issue #179：注入预览（状态页卡片 + /inject-preview 端点透传的旁路快照） ---
test("a11y+preview: inject preview card is wired on the status tab", () => {
  assert.ok(clientSource.includes('"/api/dsh-mneme/inject-preview"'), "card must fetch the preview endpoint");
  assert.ok(clientSource.includes("h(InjectPreviewCard, { t })"), "status grid must render the preview card");
  for (const key of [
    "memory.status.injectPreview",
    "memory.status.injectPreviewNone",
    "memory.status.injectPreview.chars",
    "memory.status.injectPreview.empty"
  ]) {
    const occurrences = clientSource.split(`"${key}"`).length - 1;
    assert.ok(occurrences >= 2, `i18n key ${key} must exist in both zh and en (got ${occurrences})`);
  }
});
// --- issue #386 第 3 条：Markdown 镜像健康卡 ---
// 镜像写失败（磁盘满/权限）在记忆库侧完全静默，状态页这张卡是最早的可见信号。
// 关键不变量是 fail-closed：fetch 失败或 status 不是 ok/degraded 时必须渲染
// 「未知」——这里锁死派生表达式，防止未来被「简化」成把未知当正常显示。
test("mirror health: card wired with fail-closed unknown rendering", () => {
  assert.ok(clientSource.includes('"/api/dsh-mneme/health"'), "mirror card must fetch the health endpoint");
  assert.ok(clientSource.includes("h(MirrorHealthCard, { t })"), "overview grid must render the mirror card");
  const status = clientSource.match(/const status = m && \(m\.status === "ok" \|\| m\.status === "degraded"\) \? m\.status : "unknown";/);
  assert.ok(status, "non-ok/non-degraded status (incl. fetch failure) must collapse to unknown, never ok");
  assert.ok(clientSource.includes('m.last_error === "no-space"'), "last_error no-space must be mapped to human text");
  assert.ok(clientSource.includes('m.last_error === "permission"'), "last_error permission must be mapped to human text");
  for (const key of [
    "memory.status.mirror.ok",
    "memory.status.mirror.degraded",
    "memory.status.mirror.unknown",
    "memory.status.mirror.err.noSpace",
    "memory.status.mirror.err.permission",
    "memory.status.mirror.err.syncFailed"
  ]) {
    const occurrences = clientSource.split(`"${key}"`).length - 1;
    assert.ok(occurrences >= 2, `i18n key ${key} must exist in both zh and en (got ${occurrences})`);
  }
});

// --- issue #386 第 1 条：独立服务只读卡片 ---
// 卡片展示 dsh-mneme-serve 示例命令并支持复制。关键锁：命令不能写成
// `npx dsh-mneme-serve …` —— bin 名与包名不同，裸 npx 会尝试安装一个不存在
// 的 npm 包「dsh-mneme-serve」，用户复制出去必然报错。
test("serve card: sample command is npx-installable and card is wired", () => {
  assert.ok(clientSource.includes('"memory.settings.serve.title"'), "serve card must exist in the settings view");
  assert.ok(clientSource.includes("copyServeCmd"), "serve command must have a copy affordance");
  assert.ok(clientSource.includes("npx -p @modusensus/dsh-mneme dsh-mneme-serve"), "sample command must name the real package via -p");
  assert.equal(clientSource.includes("npx dsh-mneme-serve"), false, "bare `npx dsh-mneme-serve` would install a nonexistent package");
  for (const key of [
    "memory.settings.serve.title",
    "memory.settings.serve.cmd",
    "memory.settings.serve.hint"
  ]) {
    const occurrences = clientSource.split(`"${key}"`).length - 1;
    assert.ok(occurrences >= 2, `i18n key ${key} must exist in both zh and en (got ${occurrences})`);
  }
});

// --- issue #386 第 2 条：MCP 接入卡 ---
// 可发现性缺口：dsh-mneme-mcp 此前面板一个字都没有。锁三件事：片段必须带
// DSH_MNEME_TOKEN（MCP 数据面走外部访问 API 的 Bearer，不是面板本地
// localStorage 那把）、复制入口存在、i18n 中英成对。
test("mcp card: mount snippet is copyable and token-keyed to the external API", () => {
  assert.ok(clientSource.includes('"memory.settings.mcp.title"'), "mcp card must exist in the settings view");
  assert.ok(clientSource.includes("copyMcpSnippet"), "mcp snippet must have a copy affordance");
  assert.ok(clientSource.includes("DSH_MNEME_TOKEN"), "snippet must key the external-API Bearer token");
  assert.ok(clientSource.includes("mcpServers"), "snippet must be an .mcp.json fragment");
  for (const key of [
    "memory.settings.mcp.title",
    "memory.settings.mcp.snippet",
    "memory.settings.mcp.hint"
  ]) {
    const occurrences = clientSource.split(`"${key}"`).length - 1;
    assert.ok(occurrences >= 2, `i18n key ${key} must exist in both zh and en (got ${occurrences})`);
  }
});
// --- 冲突裁决窗可读性（报障原话：窗口太小又不能放大，完全对比不了内容，只好
// 两个都删或胡乱选一个）---
// 锁四件事：展开切换存在且默认收起（折叠态仍走 140 字预览，既有布局不回归）；
// 展开态渲染未截断全文并去掉 diff 的行数钳制；判读依据行（类型/重要度/字数/
// 新旧 + 单侧复制）在位；窄容器降级单列。缺任何一条，报障就复发。
test("conflict queue: expandable full text with decision metadata", () => {
  assert.ok(clientSource.includes('"memory.status.conflictQueue.expand"'), "collapsed state must offer 展开全文");
  assert.ok(clientSource.includes('"memory.status.conflictQueue.collapse"'), "expanded state must offer 收起全文");
  assert.ok(clientSource.includes('"aria-expanded": open'), "the toggle must expose aria-expanded");
  assert.ok(/open \? \(s\.content \|\| ""\) : \(s\.content \|\| ""\)\.slice\(0, 140\)/.test(clientSource),
    "collapsed keeps the 140-char preview while expanded must render untruncated content");
  assert.ok(clientSource.includes("mneme-conflict-diff--full"), "expanded diff must drop the 4-line clamp");
  assert.ok(clientSource.includes('"memory.status.conflictQueue.chars"'), "each side must show its length");
  assert.ok(clientSource.includes('"memory.status.conflictQueue.updated"'), "each side must show which one is newer");
  assert.ok(clientSource.includes("copySide"), "each side must be copyable for external comparison");
  assert.ok(clientSource.includes("@container (max-width:560px){.mneme-conflict-pair{grid-template-columns:1fr}}"),
    "a narrow panel must fall back to one column instead of two unreadable halves");
  for (const key of [
    "memory.status.conflictQueue.expand",
    "memory.status.conflictQueue.collapse",
    "memory.status.conflictQueue.copySide",
    "memory.status.conflictQueue.copiedSide",
    "memory.status.conflictQueue.importance",
    "memory.status.conflictQueue.chars",
    "memory.status.conflictQueue.updated",
    "memory.status.conflictQueue.created"
  ]) {
    const occurrences = clientSource.split(`"${key}"`).length - 1;
    assert.ok(occurrences >= 2, `i18n key ${key} must exist in both zh and en (got ${occurrences})`);
  }
});
// 面板 bundle 在本文件里只被当**文本**读（上面的断言全是正则/字符串包含），
// 而仓库的 CI 里没有任何一步**解析**它：于是重复声明这类语法错误能一路绿灯进
// 主干，后果却是整个面板加载失败（__ModuleLoader__ 拿到的模块一执行就抛
// SyntaxError）。lib/client.js 无 src 对应物、不参与 sync，也就没有别的闸门
// 覆盖它——这里补一道解析闸（PR #320 rebase 时真实踩到：与上游新增的
// summarizeSub 撞名，node --check 报 "Identifier 'summarizeSub' has already
// been declared"，而当时 CI 全绿）。
test("client bundle parses: 面板产物必须是合法 JS（无重复声明等语法错误）", () => {
  const result = spawnSync(process.execPath, ["--check", join(root, "lib/client.js")], { encoding: "utf8" });
  assert.equal(result.status, 0, `lib/client.js 解析失败：\n${result.stderr || result.stdout}`);
});
