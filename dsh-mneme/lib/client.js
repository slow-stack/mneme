window.__ModuleLoader__.load({
  id: "@modusensus/dsh-mneme",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let react = require("react");
    let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    let { useState, useEffect, useCallback, useRef } = react;

    // #178 无障碍批次一：aria-live 网络。模块级单例 polite live region +
    // announce()：面板所有瞬时反馈（保存成功/失败、队列刷新、裁决完成、
    // 复制成功）经此播报，读屏用户不再依赖纯视觉 span。单例挂 <body>，
    // 与面板组件生命周期解耦；文本先清空下一帧再写入，让连续两次相同
    // 文案也能各播报一次。
    let liveRegion = null;
    function announce(text) {
      if (!text || typeof document === "undefined") return;
      if (!liveRegion || !liveRegion.isConnected) {
        liveRegion = document.createElement("div");
        liveRegion.setAttribute("role", "status");
        liveRegion.setAttribute("aria-live", "polite");
        liveRegion.style.cssText = "position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap";
        document.body.appendChild(liveRegion);
      }
      liveRegion.textContent = "";
      window.requestAnimationFrame(() => { if (liveRegion) liveRegion.textContent = text; });
    }

    // #177 词级 diff：经典 LCS 对齐——删除片段标红、新增标绿、公共部分原样。
    // 分词两段式：Han 段先切出再逐字打散（\p{L} 把整句中文当一个词，必须单列），
    // 其余按 Unicode 词边界（拉丁按词、标点独立）。相邻同侧片段合并成 run。
    // 输入先截 800 字符；O(n·m) DP 仅在小文本启用（任一侧 > 800 词或 edit run
    // > 200 时返回 null），caller 退回原文展示，不为极端文本烧内存。
    function wordDiff(aText, bText) {
      const HAN = /^[\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}]+$/u;
      const tokenize = (s) => (s || "")
        .split(/([\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}]+)/u)
        .filter(Boolean)
        .flatMap((seg) => HAN.test(seg)
          ? [...seg]
          : seg.split(/(?=[^\p{L}\p{N}])|(?<=[^\p{L}\p{N}])/u).filter(Boolean));
      const a = tokenize((aText || "").slice(0, 800)), b = tokenize((bText || "").slice(0, 800));
      const n = a.length, m = b.length;
      if (n === 0 && m === 0) return null;
      if (n > 800 || m > 800) return null; // ponytail: O(n·m) DP，800×800 封顶（~2.5MB Int32），超限退回原文
      const dp = new Int32Array((n + 1) * (m + 1));
      const at = (i, j) => i * (m + 1) + j;
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[at(i, j)] = a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
        }
      }
      const ops = [];
      const push = (kind, text) => {
        const last = ops[ops.length - 1];
        if (last && last.kind === kind) last.text += text;
        else ops.push({ kind, text });
      };
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (a[i] === b[j]) { push("same", a[i]); i++; j++; }
        else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) { push("del", a[i]); i++; }
        else { push("ins", b[j]); j++; }
      }
      while (i < n) { push("del", a[i]); i++; }
      while (j < m) { push("ins", b[j]); j++; }
      if (ops.filter((o) => o.kind !== "same").length > 200) return null;
      return ops;
    }
    // --- mneme mark：插件自己的标识图标 -------------------------------------
    // 不再借宿主的 IconArchiveOutline*，两个原因：
    //  · 语义撞车——「归档盒」和记忆库里的归档动作是同一个符号，用户反馈看不出
    //    这是记忆插件（issue 走维护者自开通道）；
    //  · 宿主耦合——宿主图标名会换代（#287：Outline20 → OutlineRegular/Medium），
    //    只认某一代就取到 undefined，h(undefined) 即 React #130 把整个 slot entry
    //    崩掉。改用本地 Lucide 路径数据后，不再需要「探测多代名字 + 缺名降级」。
    // Lucide Brain（项目现有 Lucide 1.42 图标数据，ISC）；静态内嵌路径，避免插件运行时加载 ESM 包。
    // 宿主图标名会随版本换代，因此插件标识仍由本地 helper 渲染；插件列表 SVG 与这里共用同一路径。
    const MNEME_MARK_D = "M12 18V5M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5M17.997 5.125a4 4 0 0 1 2.526 5.77M18 18a4 4 0 0 0 2-7.464M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517M6 18a4 4 0 0 1-2-7.464M6.003 5.125a4 4 0 0 0-2.526 5.77";

    /** 24 栅格 Lucide Brain 映射到宿主 16 栅格，颜色仍随主题走。 */
    const MnemeMark = ({ size = 16, className }) => h("svg", {
      width: size,
      height: size,
      className,
      viewBox: "0 0 16 16",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg",
      "aria-hidden": "true",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }, h("path", { d: MNEME_MARK_D, transform: "scale(0.666667)" }));

    /** 渲染 mneme mark：四个入口（浮层标题栏 / footer 回退 / 侧边栏 portal / better-sidebar tab）共用同一颗。 */
    const renderMnemeMark = (props) => h(MnemeMark, props);

    // Portal target for the hero fallback surface. The host whitelists
    // react-dom for its own bundles (dsh-client-ui-trajectory requires it);
    // when the runtime rejects it for plugins the overlay renders in place —
    // position:fixed keeps it viewport-sized either way.
    let reactDom = null;
    try { reactDom = require("react-dom"); } catch { reactDom = null; }

    // Node-graph pictogram (three nodes joined by edges). The primitives kit
    // ships no network/graph icon, and its share-style glyph reads as
    // "share" — exactly the confusion this custom 16px replacement avoids.
    const GraphNodesIcon = ({ size = 16, className }) => h("svg", {
      width: size,
      height: size,
      className,
      viewBox: "0 0 16 16",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg"
    },
      h("path", {
        d: "M8 5.2 4.6 10.4M8 5.2l3.4 5.2M5.2 12h5.6",
        stroke: "currentColor",
        strokeWidth: "1.2",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }),
      h("circle", { cx: 8, cy: 3.4, r: 1.8, fill: "currentColor" }),
      h("circle", { cx: 3.6, cy: 12, r: 1.8, fill: "currentColor" }),
      h("circle", { cx: 12.4, cy: 12, r: 1.8, fill: "currentColor" })
    );

    // Stroke icons, Lucide path data (ISC license) inlined as [tag, attrs]
    // tuples — the plugin runtime cannot require third-party libraries, so
    // the data ships with the bundle (the morphicons/lucide pairing the
    // data package documents, minus the runtime dependency). Stroke picks
    // up currentColor, so icons follow the host theme tokens.
    const ICON_PATHS = {
      database: [["ellipse", { cx: "12", cy: "5", rx: "9", ry: "3" }], ["path", { d: "M3 5V19A9 3 0 0 0 21 19V5" }], ["path", { d: "M3 12A9 3 0 0 0 21 12" }]],
      waypoints: [["path", { d: "m10.586 5.414-5.172 5.172" }], ["path", { d: "m18.586 13.414-5.172 5.172" }], ["path", { d: "M6 12h12" }], ["circle", { cx: "12", cy: "20", r: "2" }], ["circle", { cx: "12", cy: "4", r: "2" }], ["circle", { cx: "20", cy: "12", r: "2" }], ["circle", { cx: "4", cy: "12", r: "2" }]],
      settings: [["path", { d: "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" }], ["circle", { cx: "12", cy: "12", r: "3" }]],
      search: [["path", { d: "m21 21-4.34-4.34" }], ["circle", { cx: "11", cy: "11", r: "8" }]],
      refresh: [["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }], ["path", { d: "M21 3v5h-5" }], ["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }], ["path", { d: "M8 16H3v5" }]],
      chevronDown: [["path", { d: "m6 9 6 6 6-6" }]],
      chevronRight: [["path", { d: "m9 18 6-6-6-6" }]],
      copy: [["rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" }], ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }]],
      check: [["path", { d: "M20 6 9 17l-5-5" }]],
      inbox: [["polyline", { points: "22 12 16 12 14 15 10 15 8 12 2 12" }], ["path", { d: "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" }]],
      activity: [["path", { d: "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" }]],
      flame: [["path", { d: "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" }]],
      // 意见与反馈入口的行首图标（Lucide 数据，同上 ISC 惯例内联）
      bug: [["path", { d: "m8 2 1.88 1.88" }], ["path", { d: "M14.12 3.88 16 2" }], ["path", { d: "M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" }], ["path", { d: "M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" }], ["path", { d: "M12 20v-9" }], ["path", { d: "M6.53 9C4.6 8.8 3 7.1 3 5" }], ["path", { d: "M6 13H2" }], ["path", { d: "M3 21c0-2.1 1.7-3.9 3.8-4" }], ["path", { d: "M20.97 5c0 2.1-1.6 3.8-3.5 4" }], ["path", { d: "M22 13h-4" }], ["path", { d: "M17.2 17c2.1.1 3.8 1.9 3.8 4" }]],
      mail: [["rect", { width: "20", height: "16", x: "2", y: "4", rx: "2" }], ["path", { d: "m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" }]],
      // star 是设置页鼓励入口的行首图标（Lucide 数据，同上 ISC 惯例内联）。
      // Icon 对未注册的名字静默 return null——漏了它就是一行缺图标、闸门全绿，
      // 所以这条表与用法必须同处出现（见 test/client.test.js 的图标名锁）。
      star: [["polygon", { points: "12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" }]],
      persona: [["path", { d: "M12 3a7 7 0 0 0-7 7c0 4 3 5 3 8h8c0-3 3-4 3-8a7 7 0 0 0-7-7z" }], ["path", { d: "M10 11h.01" }], ["path", { d: "M14 11h.01" }], ["path", { d: "M9.5 15c1.6 1 3.4 1 5 0" }]],
    };
    const Icon = ({ name, size = 16, className }) => {
      const parts = ICON_PATHS[name];
      if (!parts) return null;
      return h("svg", {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        className,
        "aria-hidden": "true"
      }, parts.map(([tag, attrs], i) => h(tag, { key: i, ...attrs })));
    };

    // Lucide v1.42 star path（morphicons 官方配套的数据包）。morphicons 本体
    // 是 ESM-only 的变形动画引擎、插件运行时不允许 require 第三方库，故按
    // 既有惯例内联图标数据静态渲染；实心/空心由 fill 区分，空心降透明度。
    const STAR_PATH_D = "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z";
    const ImportanceStars = ({ value = 0, size = 13, className }) => {
      const filled = Math.min(5, Math.max(0, Math.round(value || 0)));
      return h("span", { className: `mneme-stars${className ? ` ${className}` : ""}`, role: "img", "aria-label": `${filled}/5` },
        [0, 1, 2, 3, 4].map((i) => h("svg", { key: i, width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true" },
          h("path", {
            d: STAR_PATH_D,
            fill: i < filled ? "currentColor" : "none",
            stroke: "currentColor",
            strokeWidth: 1.6,
            strokeLinejoin: "round",
            opacity: i < filled ? 1 : 0.35
          }))));
    };

    // 单颗星（与 ImportanceStars 同一份 Lucide 路径）：筛选 chip、实体提及数、
    // 注入预览这类行内小指标用它渲染，替换此前的文本星号——文本星号角更尖锐，
    // 与卡片/抽屉的 SVG 星并排时明显不同形（用户反馈后全线统一）。
    const StarGlyph = ({ size = 11, filled = true }) => h("svg", {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      "aria-hidden": "true",
      fill: filled ? "currentColor" : "none",
      stroke: "currentColor",
      strokeWidth: 1.6,
      strokeLinejoin: "round",
      style: { verticalAlign: "-1px" }
    }, h("path", { d: STAR_PATH_D, opacity: filled ? 1 : 0.35 }));

    // 热度徽章（阶段二）：flame 图标 + 整数百分比，三档配色（热/温/冷）。
    // /list 仅在 heatEnabled=true 时下发 heat 字段——缺省即不渲染，开关关闭
    // 时徽章全站自动消失，前端无需感知开关状态。
    const HeatBadge = ({ value, size = 12 }) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
      const tier = pct >= 66 ? "hot" : pct >= 33 ? "warm" : "cold";
      return h("span", { className: `mneme-heat mneme-heat--${tier}`, title: `${pct}%` },
        h(Icon, { name: "flame", size, className: "mneme-heatico" }),
        h("span", { className: "mneme-heatpct" }, `${pct}%`));
    };

    /**
     * v0.8.0 A4（issue #17）：scope 标注徽章——条目的归属来源一行摘要。
     *
     * 仅在条目带任一 scope 标注（agent_scope / workspace_scope / sensitivity）
     * 时渲染；字段缺省返回 null（未标注条目视觉零变化，前端不感知开关状态，
     * 与 HeatBadge 的「数据缺省即不渲染」同一模式）。tooltip 展示完整归属，
     * 标签复用详情抽屉的 i18n 键（云端复验观察点：tooltip 曾硬编码英文）。
     *
     * @param {{m: object, t: (key: string) => string}} props
     * @param {object} props.m 记忆条目（/list、/search 透出的 toApiList 形状，
     *   scope 四字段条件存在）
     * @param {(key: string) => string} props.t i18n 取词函数（调用点闭包提供）
     * @returns {object|null} 徽章 vnode；无任何标注时为 null
     */
    const ScopeBadge = ({ m, t }) => {
      if (!m || (!m.agent_scope && !m.workspace_scope && !m.sensitivity)) return null;
      const tip = [
        m.agent_scope ? `${t("memory.explorer.detail.agentScope")}: ${m.agent_scope}` : null,
        m.workspace_scope ? `${t("memory.explorer.detail.workspaceScope")}: ${m.workspace_scope}` : null,
        m.sensitivity ? `${t("memory.explorer.detail.sensitivity")}: ${m.sensitivity}` : null
      ].filter(Boolean).join(" · ");
      return h("span", { className: "mneme-badge mneme-badge--scope", title: tip },
        t("memory.explorer.scopeBadge"));
    };

    /**
     * 「标题 + 类型」两列的小清单。抽屉的整包退出清单与接收弹层的撞名清单是同一个形状
     * （`{type,title}`），第三份手写 `.map` 就是第三处会各自漂移的地方——所以这里只有一份。
     * 分享弹层的跳过清单**不走它**：那一列的第二格是 reason 标签，不是类型。
     */
    function TypeRowList({ t, rows }) {
      const list = Array.isArray(rows) ? rows : [];
      if (!list.length) return null;
      return h("div", { className: "mneme-sharelist" },
        list.map((row, i) => h("div", { key: `${row.type}-${i}`, className: "mneme-sharow" },
          h("span", { className: "mneme-sharowtitle" }, row.title || ""),
          h("span", { className: "mneme-sharowreason" }, typeLabel(t, row.type)))));
    }

    /**
     * 外来行的来源徽标。别名不单独存列：`importedTagFor` 打的那条 `from-<别名>` 标签就是唯一读数，
     * 所以这里只认标签，不猜别的来源。先判 `source === "imported"` 再判标签——
     * 一个人手工给自己的一条打了 from-x 不算外来行，徽标会把它误报成别人的。
     * 搜索态不出现这个徽标，且这是对的：那张 DTO 的 source 是召回渠道（src/service.js:939），
     * 判据在那一侧读不出来。不许为了让搜索结果显示徽标而改成「认标签就算」——那会把
     * 手工标签误报成外来行，也是 memory-source.js 那条契约的反面。
     * from-shared 是空别名的中性值，照原样显示，不兜成「未知来源」。
     */
    const ForeignBadge = ({ m, t }) => {
      // 判据先于标签：`isImported` 就是 src/memory-source.js 那条契约的读数，
      // 手工打了 from-x 标签的本机行不算外来行。正向字面量也要留着——test/client-share.test.js
      // 的锁按 `m.source === "imported"` 钉这条契约，写成反向判断会让那条锁无处可钉。
      const isImported = !!m && m.source === "imported";
      if (!isImported) return null;
      const tags = Array.isArray(m.tags) ? m.tags : [];
      const tag = tags.find((x) => typeof x === "string" && x.startsWith("from-"));
      if (!tag) return null;
      return h("span", { className: "mneme-badge mneme-badge--foreign", title: tag },
        t("memory.explorer.foreignBadge").replace("{alias}", tag.slice(5)));
    };

    // Unified API fetcher: attaches the optional apiToken (set in the settings
    // view, persisted in localStorage) as a Bearer header. When no token has
    // been configured the header is omitted and the API stays open (default).
    const API_TOKEN_KEY = "dsh-mneme-api-token";
    function apiFetch(path, opts = {}) {
      const token = (typeof window !== "undefined" && window.localStorage)
        ? window.localStorage.getItem(API_TOKEN_KEY) || ""
        : "";
      const headers = { ...(opts.headers || {}) };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      return fetch(path, { ...opts, headers });
    }

    // 通用失效广播：任何改库动作（裁决/删除/编辑/归档/导入/接收/建条/回收…）
    // 成功后派发一次。此前跨组件失效只有 mneme:conflicts-changed 一个事件、
    // 三个状态侧监听者——记忆列表与冲突徽章、实体页、归档工作台全都不在名单里，
    // 用户裁决完冲突要关掉面板重开才能看到败者归档。数据视图一律订阅本事件
    // 立即重取；各动作自己的本地刷新（reloadKey / 列表过滤）保留，偶发的重复
    // GET 换「永远不陈旧」，划算。与 mneme:conflicts-changed 并存不合并：后者
    // 是裁决专属的精准信号，语义更窄，已有监听者不必搬家。
    function broadcastStoreChanged(reason) {
      try {
        window.dispatchEvent(new CustomEvent("mneme:store-changed", { detail: { reason: reason || "" } }));
      } catch { /* 非浏览器环境 */ }
    }

    // ⚠️ 'betterSidebar' 绝不能进模块级 inject（issue #88 实锤）：loader 对
    // inject 声明的服务是硬等待——未安装 better-sidebar 的环境里整个 entry
    // 永远 pending（"1 entry did not activate" → Failed to load plugins）。
    // 软依赖靠内层动态子插件探测（见 apply 内 better-sidebar 挂载块）。
    const inject = ["slots", "locale"];

    const NS = "memory";

    const dictionaries = {
      zh: {
        "memory.panel.empty": "暂无记忆条目",
        "memory.panel.open": "记忆",
        "wiki.panel.open": "仓库地志",
        "wiki.rebuild": "重建骨架",
        "wiki.rebuilding": "重建中…",
        "wiki.rebuild.done": "重建完成",
        "wiki.rebuild.failed": "重建失败",
        "wiki.rebuild.hint": "重跑 T0 确定性骨架（秒级）。T1 语义正文用旁边的「补语义正文」按钮（长任务，会轮询进度）；重建后富化页会退回骨架，需再补一次",
        "wiki.rebuild.modules": "个模块",
        "wiki.rebuild.pages": "页",
        // issue #607：空态原来说「在仓库目录里跑 dsh-mneme-choro」——那命令不在 PATH
        // 里、也根本不需要 cd（它收的是路径参数）。文案改成三步：说清这是什么、给出
        // 可直接点的生成入口、把 CLI 兜底写成带绝对路径的完整示例。
        "wiki.empty.noRepo": "这是 mneme 插件的「仓库地志」：把仓库代码结构铺成可浏览的模块页。还没有登记任何仓库——在下面填入仓库目录的绝对路径，点「生成骨架」就会直接生成并登记。也可以在本机命令行里跑（这个命令不在 PATH 里，要给绝对路径）：",
        "wiki.empty.disabled": "chorography（仓库地志）未启用。它属于本插件（记忆库）：打开「设置 → 记忆库设置 → 功能开关 → 它什么时候写进去 → 仓库地志（chorography）」，然后重启 DSH 生效。",
        "wiki.empty.noRepo.where": "仓库地志属于本插件（记忆库），开关在「设置 → 记忆库设置 → 功能开关 → 它什么时候写进去」里的「仓库地志（chorography）」，打开后要重启 DSH 才生效。",
        "wiki.empty.copy": "复制命令",
        "wiki.empty.copied": "已复制",
        "wiki.empty.copyFailed": "复制失败，请手动选中命令文本。",
        "wiki.empty.pickRepo": "已登记多个仓库，选一个：",
        "wiki.empty.generate": "生成骨架",
        "wiki.empty.generating": "生成中…",
        "wiki.empty.pathPlaceholder": "仓库目录的绝对路径，例如 D:\\code\\my-repo",
        "wiki.empty.cliSummary": "在命令行里生成（可选）",
        "wiki.empty.cliCmd": "node \"<profile>/node_modules/@modusensus/dsh-mneme/bin/dsh-mneme-choro.mjs\" \"<仓库路径>\" --apply",
        "wiki.empty.cliHint": "命令收的是一个路径参数，不必先 cd 进仓库；<profile> 指 DSH 的配置目录。",
        "wiki.flag.autoRefresh": "自动更新",
        "wiki.flag.t1FromPanel": "面板可发起 T1",
        "wiki.flag.saveFailed": "开关保存失败",
        "wiki.t1": "补语义正文（T1）",
        "wiki.t1.running": "T1 进行中…",
        "wiki.t1.done": "T1 语义正文已补完",
        "wiki.t1.failed": "T1 失败",
        "wiki.t1.disabled": "面板发起 T1 是关着的：打开 设置 → 记忆(mneme) → 功能 → 仓库地志，打开「面板可发起 T1」。",
        "wiki.t1.progress": "已完成",
        "wiki.t1.modules": "个模块",
        "wiki.t1.failedCount": "失败",
        "wiki.stale": "代码已变",
        "wiki.stale.hint": "上次生成之后仓库代码变过，页面可能和现状对不上：点「重建骨架」刷新。",
        "wiki.run.pathRequired": "先填仓库目录的绝对路径",
        "wiki.run.failed": "生成失败",
        "wiki.run.notAbsolute": "要给绝对路径（例如 D:\\code\\my-repo）：相对路径会按服务端进程的当前目录解析，同一个请求换个启动位置就落到别的目录。",
"wiki.run.notFound": "这个路径不存在，或不是一个目录。请检查拼写。",
"wiki.run.notGit": "这个目录不是 git 仓库，所以没有登记：仓库地志按 git 的提交与文件树生成模块结构，非 git 目录没有可比对的基线。请填仓库根目录（含 .git 的那一层），或先在该目录 git init。",
        "wiki.search.placeholder": "在页面里检索…",
        "wiki.state.loading": "加载中…",
        "wiki.state.pickPage": "从左侧选一个模块页。",
        "wiki.state.pageMissing": "索引还在、磁盘上的页面文件缺失。点顶部「重建骨架」即可重新生成（不用离开这个面板）。",
        "wiki.state.unavailable": "chorography 查询装配不可用（宿主环境缺件）。",
        "wiki.state.error": "加载失败",
        "wiki.tree.title": "模块",
        // 知识库（契约 §3.5-3 / §3.6）：照 #607 的教训，每个空态都要说清「这是什么、
        // 属于哪个插件、在哪开」——一句话答不上来就会变成用户来报的 bug。
        "kb.panel.open": "知识库",
        "kb.search": "检索",
        "kb.col.intro": "知识库是 mneme 插件的功能：把外部资料（本地文件 / 网页 / 仓库地志页）切块索引，检索与注入时一起用。",
        "kb.empty.disabled": "「知识库」未启用：打开 设置 → 记忆(mneme) → 功能 → 知识库，打开开关后重启 DSH 生效。",
        "kb.empty.unavailable": "知识库后端不可用：宿主里还没装配 kb 模块，重启 DSH 或升级插件后再看。",
        "kb.empty.collections": "还没有集合。左边先建一个集合（比如「项目文档」），再把本地文件、网页或地志页收进去；入库的正文会被切块索引。",
        "kb.empty.docs": "这个集合还没有文档：右边选来源类型，填路径或 URL 后点「入库」。",
        "kb.col.title": "集合",
        "kb.col.key": "集合键（英文/数字/短横线，入库与检索的寻址名）",
        "kb.col.name": "集合标题（可选）",
        "kb.col.create": "新建集合",
        "kb.col.delete": "删除集合",
        "kb.col.deleteConfirm": "再点一次确认删除",
        "kb.col.docs": "篇",
        "kb.col.chunks": "块",
        "kb.doc.title": "文档",
        "kb.doc.kind": "来源类型",
        "kb.doc.kind.file": "本地路径",
        "kb.doc.kind.url": "网页 URL",
        "kb.doc.kind.choro": "从地志页导入",
        "kb.doc.source": "本地绝对路径或网页 URL",
        "kb.doc.titleField": "标题（可选，缺省用文件名或 URL）",
        "kb.doc.ingest": "入库",
        "kb.doc.ingesting": "入库中…",
        "kb.doc.done": "入库完成",
        "kb.doc.skipped": "内容未变，已跳过（幂等）",
        "kb.doc.failed": "入库失败",
        "kb.doc.empty": "—",
        "kb.repo.pick": "仓库",
        "kb.repo.module": "模块页",
        "kb.repo.pickFirst": "先在上面选一个仓库",
        "kb.repo.none": "还没有登记的仓库：先去「仓库地志」页生成一次，再回来导入。",
        "kb.repo.noPath": "这个仓库的根路径拿不到（后端没回 rootPath），拼不出地志页的绝对路径。",
        "kb.repo.noRelPath": "这个模块还没生成骨架页（后端没回 relPath），先回「仓库地志」页生成一次再来导入。",
        // 仓库卡片：Qoder 那种「在这里选择整理知识」的入口（#607 反馈）。
        "kb.repos.title": "仓库：点一下把它的地志页整批整理进当前集合",
        "kb.repos.empty": "还没有登记的仓库：先去「仓库地志」页生成一次，再回来整理。",
        "kb.repos.modules": "个模块",
        "kb.repos.pages": "页",
        "kb.repos.organized": "已整理",
        "kb.repos.run": "整理进本集合",
        "kb.repos.running": "整理中…",
        "kb.repos.needCollection": "先在左边建一个集合，再整理；入库要有个去处。",
        "kb.repos.done": "整理完成",
        "kb.repos.new": "新增",
        "kb.repos.same": "未变",
        "kb.repos.failedN": "失败",
        "kb.repos.nopages": "这个仓库还没有地志页：先回「仓库地志」页生成骨架，再回来整理。",
        // 手动填路径降级成高级选项：卡片才是主路径，但单页导入与 URL 入库仍要留。
        "kb.advanced": "高级：手动入库 / 单页导入",
        "kb.load.failed": "加载失败",
        "memory.tab.all": "全部",
        "memory.tab.preference": "偏好",
        "memory.tab.project": "项目",
        "memory.tab.decision": "决策",
        "memory.tab.history": "历史",
        "memory.tab.summary": "小结",
        "memory.settings.title": "记忆库设置",
        "memory.settings.group.personal": "个性化",
        "memory.settings.group.engine": "记忆引擎",
        "memory.settings.group.search": "搜索",
        "memory.settings.group.connect": "连接与安全",
        "memory.settings.group.help": "帮助",
        "memory.settings.toc.label": "目录",
        "memory.settings.toc.aria": "设置分组目录",
        "memory.settings.toc.jump": "跳到「{name}」",
        "memory.settings.profile": "用户画像",
        "memory.settings.profileHint": "写一段自我介绍（角色、背景、偏好），Agent 每轮对话都会自动带上。",
        "memory.settings.profileSave": "保存画像",
        "memory.settings.profileSaved": "画像已保存",
        "memory.settings.profileExtract": "从记忆提取草稿",
        "memory.settings.profileExtracting": "正在提取…",
        "memory.settings.profileExtractHint": "会花一次模型调用，只在你点这个按钮时发生；提取出来的是草稿副本，只在这里展示——不会写进记忆库，也不会动你自己手写的「用户画像」。想留下它，点「复制草稿」。",
        "memory.settings.profileExtractDisabled": "没有提取：功能开关里的「画像提取草稿」还没打开。",
        "memory.settings.profileExtractEmpty": "库里没有可用的记忆条目，这次没有能提炼的内容（空输入下硬写一段画像只会是编的）。",
        "memory.settings.profileExtractNoRoute": "没有可用的模型：先在宿主里选一个默认模型（或在配置里填 dreamProvider / dreamModel），再点一次。",
        "memory.settings.profileSaveFailed": "画像没存进去",
        "memory.settings.profileExtractFailed": "提取没成：模型没按格式返回，或这次调用失败了。你现有的画像一个字都没被改动。",
        "memory.settings.profileDraftTitle": "草稿副本（不会自动保存）",
        "memory.settings.profileDraftRows": "依据记忆条数",
        "memory.status.entitiesSampled": "分类计数只统计最近 500 个实体；总数是全库",
        "memory.status.entitiesUnknown": "总数读不到；下面是最近 500 个实体的分类计数",
        "memory.settings.profileDraftTruncated": "条目较多，这次只读了前面一部分",
        "memory.settings.profileDraftCopy": "复制草稿",
        "memory.settings.profileDraftCopied": "已复制",
        "memory.settings.profileDraftCopyHint": "「用户画像」那一栏只由你自己填写；要把它写进去，请粘贴后自己点保存。",
        "memory.settings.profileDraftCopyFailed": "复制没成功：请选中上面的草稿手动复制。",
        "memory.settings.profileDraftDiscard": "丢弃草稿",
        "memory.settings.personaNamePlaceholder": "例如：Nyx",
        "memory.settings.personaPersonalityPlaceholder": "例如：轻松幽默，讲难题时用类比帮用户快速理解",
        "memory.settings.personaReplyStylePlaceholder": "例如：先给结论再解释；用人在用的词，不用机制名",
        "memory.settings.personaDefaultCard": "默认卡（兜底）",
        "memory.persona.title": "人格设计",
        "memory.persona.hint": "一个身份一张卡。卡上写了名字、性格、回复要求、场景与示例对话，保存后，这个身份说话时就用它，写日记时也只用这张卡的口吻——日记页按身份分开看，就是这里的分区在日记侧的样子。",
        "memory.persona.strictBefore": "严格寻址已开：还没有任何身份卡，所有人暂时都用默认卡。建出第一张卡后规则立刻变严——没建卡的会话将不再注入人格，主会话也一样。要保留谁的人格，先给谁建卡。子 agent 会继承父会话的卡，不必单独建。",
        "memory.persona.strictAfter": "严格寻址已生效：只有建了卡的会话会注入人格，其余会话（含主会话）一律不注入。子 agent 没自己的卡时继承父会话那张。",
        "memory.persona.cards": "身份卡",
        "memory.persona.defaultCard": "默认卡（兜底）",
        "memory.persona.newPlaceholder": "新身份名，如 nyx",
        "memory.persona.add": "添加身份卡",
        "memory.persona.delete": "删除这张卡",
        "memory.persona.enabled": "启用这张卡",
        "memory.persona.enabledOn": "已启用：这个身份的话与日记都用这张卡的口吻",
        "memory.persona.enabledOff": "未启用：这个身份会落回默认卡（开严格寻址时不注入人格）",
        "memory.persona.name": "名字",
        "memory.persona.personality": "性格设定",
        "memory.persona.replyStyle": "回复要求",
        "memory.persona.scenario": "场景（可选）",
        "memory.persona.scenarioPlaceholder": "这个身份在什么场合出现，面对谁",
        "memory.persona.mesExample": "示例对话（可选）",
        "memory.persona.mesExamplePlaceholder": "一两轮示例，最能定住语气",
        "memory.persona.save": "保存人格卡",
        "memory.persona.saved": "已保存",
        "memory.persona.saveFailed": "保存失败",
        "memory.persona.preview": "注入预览（这一轮真正送进模型的文本）",
        "memory.persona.previewRefresh": "刷新预览",
        "memory.persona.previewEmpty": "这一轮没有任何人格文本——卡是空的，或者总闸关着。",
        "memory.persona.previewUnknown": "读不到预览（请求失败或后端版本过旧），这里不显示猜测的内容。",
        "memory.persona.diary": "这个身份的日记",
        "memory.persona.diaryHint": "日记只认卡的口吻：写日记时按会话身份选卡，没身份才用默认卡。",
        "memory.persona.about": "你是谁的画像",
        "memory.persona.diaryCount": "{count} 篇 · 最近 {latest}",
        "memory.persona.diaryNone": "还没有日记。去左侧「ta 的日记」里写一篇，它就会按这张卡的口吻落笔。",
        "memory.persona.readFailed": "读不到人格库（请求失败或后端版本过旧），这里不显示猜测的内容。",
        "memory.persona.loading": "读取中…",
        "memory.persona.factsLinked": "自动事实与人格卡同域：这里的身份分区，也是「Agent 眼中的你」的分区。",
        "memory.settings.factsTitle": "自动事实（Agent 眼中的你）",
        "memory.settings.factsHint": "Agent 在巩固（dream）后从新记忆里提炼的「对你的了解」，按会话身份分卡，与人格卡同域，注在预览里手填画像之后。这里可以逐条修正；删除只是归档，随时可恢复。你自己填的用户画像不受影响。",
        "memory.settings.factsEmpty": "这张卡还没有事实。有新的对话记忆并跑过巩固后，Agent 对你的了解会出现在这里；也可以在下面手动添加。",
        "memory.settings.factsUnavailable": "读不到事实（请求失败或后端版本过旧）。这里不显示猜测的内容。",
        "memory.settings.factsAddPlaceholder": "例如：用户偏好简洁直给的回答",
        "memory.settings.factsAdd": "添加事实",
        "memory.settings.factsRowEdit": "编辑这条事实",
        "memory.settings.factsRowSave": "保存",
        "memory.settings.factsRowCancel": "取消",
        "memory.settings.factsRowDelete": "删除这条事实（归档，可恢复）",
        "memory.settings.factsApplyDone": "事实已更新",
        "memory.settings.factsApplyError": "没存进去：请求失败了，请再试一次。",
        "memory.settings.factsApplyFailures": "{n} 条没存进去",
        "memory.settings.factsApplyDups": "跳过 {n} 条重复",
        "memory.settings.factsGateOff": "功能开关里的「自动事实」没开：dream 轮不会自动维护这份清单，但这里的增改与下面的手动更新照常可用。",
        "memory.settings.factsRun": "立即更新",
        "memory.settings.factsRunning": "正在更新…",
        "memory.settings.factsRunOk": "已更新 {n} 条事实",
        "memory.settings.factsRunNoop": "没有新记忆，事实已是最新",
        "memory.settings.factsRunDisabled": "功能开关里的「自动事实」还没打开，先到功能开关区打开它。",
        "memory.settings.factsRunNoRoute": "没有可用的模型：先在宿主里选一个默认模型（或在配置里填 dreamProvider / dreamModel），再点一次。",
        "memory.settings.factsRunFailed": "更新没成：模型没按格式返回，或这次调用失败了。稍后可重试。",
        "memory.settings.factsJournalTitle": "最近变更",
        "memory.settings.factsJournalEmpty": "还没有变更记录",
        "memory.settings.factsOpAdd": "新增",
        "memory.settings.factsOpUpdate": "修改",
        "memory.settings.factsOpArchive": "归档",
        "memory.settings.factsActorAuto": "自动",
        "memory.settings.factsActorManual": "手动",
        "memory.settings.factsRunLast": "最近一轮：",
        "memory.settings.factsRunCounts": "输入 {input} 条 · 应用 {ops} 项操作",
        "memory.settings.factsRunStatusOk": "成功",
        "memory.settings.factsRunStatusNoop": "无变更",
        "memory.settings.factsRunStatusFailed": "失败",
        "memory.features.personaEnabled": "人格定义（beta）",
        "memory.features.personaEnabled.hint": "把「设置 → 个性化」里的人格卡注入到每轮对话。默认关（beta）；总闸与人格卡内的开关同时打开才生效。",
        "memory.features.personaStrictAddressing": "严格人格寻址",
        "memory.features.personaStrictAddressing.hint": "开：会话身份没有对应人格卡、或那张卡被关掉时，就不注入人格——默认卡只兜「解析不到会话身份」的会话。宿主里跑着自带身份的 bot（DS Bot 那类）时关掉这种兜底，免得两句「你是谁」撞在同一轮。默认关 = 未命中就落默认卡（历史行为）。",
        "memory.features.profileExtractEnabled": "画像提取草稿",
        "memory.features.profileExtractEnabled.hint": "打开「设置 → 个性化 → Agent 眼中的你」卡上的「从记忆提取草稿」按钮：读一批活跃记忆、花一次模型调用，产一段「助手眼中的用户」草稿。草稿只在那张卡上展示副本，可一键复制，不会写进记忆库、也不会覆盖你自己填的「用户画像」。轻量档预设关（用户显式勾选仍然赢）。",
        "memory.features.profileFactsEnabled": "自动事实",
        "memory.features.profileFactsEnabled.hint": "每次 dream（巩固）轮后，把这一窗口里沉淀的新记忆再读一遍，按会话身份卡维护一份「Agent 眼中的你」事实清单（设置 → 个性化 → 自动事实），注入在手填画像之后。事实住独立的表，不会覆盖你自己填的「用户画像」；面板上可逐条修正或删除（删除=归档，可恢复）。轻量档预设关（用户显式勾选仍然赢）。",
        "memory.features.chorographyEnabled": "仓库地志（chorography）",
        "memory.features.chorographyEnabled.hint": "读一遍仓库写成一份带页码的志书：确定性骨架零模型、可以随时重建；语义段由 CLI 的 headless 会话逐模块补。打开后有四个入口——模型侧三个只读工具、面板「仓库地志」浏览页、每轮的开局提纲注入、/choro 命令。关着时它们全部不存在（模型工具列表里根本没有，注入块不渲染，/choro 与侧栏入口都不注册）。默认关。",
        "memory.features.chorographyInject": "开局注入档位",
        "memory.features.chorographyInject.hint": "每轮往上下文里塞地志提纲的份量：light 只列文件数最多的 6 个模块（约 8 行）、full 列全部模块、off 不注入（工具与面板页仍可用）。只注模块名 / 文件数 / 页状态 / 页相对路径，不含正文；正文要模型自己用 choro_read_page 取。轻量档预设压成 off。",
        "memory.features.chorographyInject.off": "off（不注入）",
        "memory.features.chorographyInject.light": "light（前 6 个模块）",
        "memory.features.chorographyInject.full": "full（全部模块）",
        "memory.features.chorographyAutoRefresh": "自动更新",
        "memory.features.chorographyAutoRefresh.hint": "读地志页时如果发现仓库代码变了（git 基线与登记时不同），自动重跑一次 T0 骨架，省掉手动重建。默认关：它会在读路径上触发写盘，不想让浏览面板偷偷改文件就别开。",
        "memory.features.chorographyT1FromPanel": "面板可发起 T1",
        "memory.features.chorographyT1FromPanel.hint": "允许面板「仓库地志」页上的「补语义正文（T1）」按钮起一个 headless 会话逐模块补语义段。默认开：按钮是人主动点的，不是后台行为。关掉后按钮仍在，但点了会提示去命令行跑。",
        "memory.features.kbEnabled": "知识库",
        "memory.features.kbEnabled.hint": "把外部资料（本地文件 / 网页 / 仓库地志页）切块索引，供检索与注入使用；面板新增「知识库」页管理与入库。默认关。",
        "memory.features.group.kb": "知识库",
        "memory.settings.rules": "规则",
        "memory.settings.rulesHint": "给 Agent 立下必须遵守的规矩，随时增删，下一轮即生效。",
        "memory.settings.ruleAdd": "添加规则",
        "memory.settings.rulePlaceholder": "例如：回答时总是先给结论",
        "memory.settings.commands": "自定义指令",
        "memory.settings.commandsHint": "把常用提示词存成 / 命令，聊天时直接键入调用。",
        "memory.settings.cmdName": "命令名",
        "memory.settings.cmdDesc": "描述",
        "memory.settings.cmdInstruction": "指令内容",
        "memory.settings.cmdAdd": "添加命令",
        "memory.settings.cmdDelete": "删除",
        "memory.settings.empty": "暂无内容",
        "memory.panel.semantic": "语义",
        "memory.sidebar.aria": "打开记忆库",
        "memory.view.label": "记忆库",
        "memory.overlay.close": "关闭",
        "memory.explorer.tabMemory": "记忆",
        "memory.explorer.tabEntities": "实体",
        "memory.explorer.tabSettings": "设置",
        "memory.explorer.tabStatus": "状态",
        "memory.explorer.tabPersona": "人格",
        "memory.explorer.tabAffective": "情绪",
        "memory.entities.count": "{n} 个实体",
      "memory.entities.countSampled": "列表只列最近 {shown} 个；上方总数是全库",
        "memory.entities.pick": "从左侧选择一个实体，查看它的属性与关系",
        // 搜索框有字但一条没筛出来时用它；与 entities.none（库里真没实体）分开，
        // 否则「暂无实体」会把打错一个字误导成「你还没开抽取」。
        "memory.entities.noMatch": "没有匹配的实体，换个词试试",
        "memory.entities.none": "暂无实体：开启实体抽取后，记忆里的人物 / 项目 / 概念会自动沉淀到这里",
        "memory.entities.attrs": "属性",
        "memory.entities.relations": "关系",
        "memory.entities.mentions": "{n} 次提及",
        "memory.entities.lastSeen": "最近出现",
        "memory.entity.person": "人物",
        "memory.entity.project": "项目",
        "memory.entity.concept": "概念",
        "memory.entity.technology": "技术",
        "memory.entity.organization": "组织",
        "memory.entity.other": "其他",
        "memory.explorer.search": "搜索标题或内容…",
        "memory.explorer.searchTitle": "语义检索",
        "memory.explorer.types": "分类",
        "memory.explorer.timeline": "时间树",
        "memory.explorer.detail": "详情",
        "memory.explorer.emptyDetail": "在时间树中选择一条记忆查看全文",
        "memory.explorer.copy": "复制全文",
        "memory.explorer.copied": "已复制",
        "memory.explorer.refresh": "刷新",
        "memory.explorer.loadMore": "加载更多",
        "memory.explorer.count": "共 {n} 条",
        "memory.explorer.empty": "暂无记忆条目",
        "memory.explorer.source": "来源",
        "memory.explorer.created": "创建",
        "memory.explorer.updated": "更新",
        "memory.explorer.tags": "标签",
        "memory.explorer.importance": "重要性",
        "memory.explorer.heat": "热度",
        "memory.explorer.heatSort": "热度优先",
        "memory.explorer.heatSortHint": "对已加载条目按热度降序（页内排序，非全局序；时间树保持时间序）",
        "memory.explorer.filterDeposited": "沉淀",
        "memory.explorer.filterDepositedHint": "只看 autoDream 巩固/更新过的记忆",
        "memory.explorer.filterArchived": "已归档",
        "memory.explorer.filterArchivedHint": "只看已归档的记忆（默认列表不含它们）",
        "memory.explorer.topK": "返回数量",
        "memory.explorer.topKOption": "返回 {n} 条",
        "memory.card.open": "在记忆库中查看全文",
        "memory.time.now": "刚刚",
        "memory.time.seconds": "{n}秒前",
        "memory.time.minutes": "{n}分钟前",
        "memory.time.hours": "{n}小时前",
        "memory.time.days": "{n}天前",
        "memory.affective.title": "情绪归因",
        "memory.affective.sub": "按「谁 · 对什么 · 什么情绪」汇总，稳定倾向与单独一次分开列。",
        "memory.affective.loading": "读取中…",
        "memory.affective.error": "没读到数据 —— 这不等于「没有记录」，是这次请求失败了。",
        "memory.affective.empty": "库里还没有情绪边。开了情感相位并跑过一轮夜间巩固，这里才会有内容。",
        "memory.affective.occasion": "一次场合",
        "memory.affective.trait": "稳定倾向",
        "memory.affective.sessions": "跨 {n} 个独立会话",
        "memory.affective.evidence": "{n} 条证据",
        "memory.affective.lastSeen": "最近 {time}",
        "memory.affective.truncated": "只列了最近 {n} 条边，更早的没进这一页",
        "memory.affective.skipped": "{n} 条边没有情绪名，未计入",
        "memory.graph.title": "记忆图谱",
        "memory.graph.aria": "记忆图谱",
        "memory.graph.placeholder": "输入实体名，查看关联网络…",
        "memory.graph.depth": "跳数",
        "memory.graph.empty": "图谱待积累：随对话记忆的沉淀，实体与关系会自动进入图谱",
        "memory.graph.notFound": "未找到该实体",
        "memory.graph.related": "关联记忆",
        "memory.graph.relation": "关系",
        "memory.graph.sourceMemory": "查看来源记忆",
        "memory.graph.hint": "拖拽节点调整布局 · 空白处拖动平移 · 滚轮缩放",
        "memory.graph.resetView": "重置视图",
        "memory.graph.summary": "实体关系图：{entity} 及其 {nodes} 个节点、{edges} 条关系",
        "memory.graph.viewInGraph": "在实体视图中打开",
        "memory.graph.loading": "加载中…",
        "memory.graph.distance": "距中心 {n} 跳",
        // issue #24 块4：被动确认的复核面。边侧卡显示权重/来源，复核区列「抬过的边」。
        "memory.graph.weight": "权重 {w}",
        "memory.graph.source": "来源 {s}",
        "memory.graph.boosted.title": "被用出来的边",
        "memory.graph.boosted.hint": "正常触达会自动抬高边的权重，这里列出被抬过的那些——抬升是唯一会改变检索形状的动作。",
        "memory.graph.boosted.empty": "当前筛选下没有边（只列权重已高于其来源基线的边）",
        "memory.graph.boosted.loadFailed": "这一屏没取到数据（接口不可用），不是「没有边」——稍后重试。",
        "memory.graph.boosted.gateOff": "被动确认当前是关的，今后不会再自动抬权；下面列的是此前已经抬过的边。",
        "memory.graph.boosted.show": "查看被用出来的边",
        "memory.graph.boosted.hide": "收起",
        "memory.graph.boosted.gain": "+{g}",
        // 边的来源（#24 块2 的 RELATION_SOURCE_DEFAULTS）：决定权重的起点，
        // 所以复核时必须和权重一起显示，否则「0.5 比 1.0 弱」这种误读无可避免。
        "memory.graph.src.manual": "人工建立",
        "memory.graph.src.confirmed": "人工确认",
        "memory.graph.src.tag": "标签共现",
        "memory.graph.src.llm": "模型抽取",
        // #619 可见化 B：情感边（affective_context）在侧卡上要能不点进去就看懂。
        // 两档必须用不同的词：occasion 是「这一次场合观察到的情绪」，trait 是
        // 「跨若干独立场合反复出现、已被铸成稳定倾向」。只显示「焦虑」会让两者
        // 看起来一样，而它们回答的是完全不同的问题（这次怎么了 / 这个人是什么样）。
        "memory.graph.emotion": "情绪 {e}",
        "memory.graph.affectiveOccasion": "这一次的场合",
        "memory.graph.affectiveOccasions": "已跨 {n} 个场合",
        "memory.graph.affectiveTrait": "稳定倾向 · 跨 {n} 个独立场合",
        "memory.graph.affectiveEvidence": "{n} 条证据",
        "memory.graph.affectiveLegacy": "旧版情感边（没有场合记录）",
        "memory.settings.vectorTitle": "向量搜索",
        "memory.settings.vectorHint": "搜索不再只认字面：接入任意 OpenAI 兼容的 embedding 接口后，意思相近的记忆也能被召回。",
        "memory.settings.vectorEnabled": "启用向量搜索",
        "memory.settings.vectorBaseUrl": "API 地址 (Base URL)",
        "memory.settings.vectorApiKey": "API Key",
        "memory.settings.vectorModel": "模型名",
        "memory.settings.vectorSave": "保存配置",
        "memory.settings.vectorSaved": "配置已保存",
        "memory.settings.vectorReindex": "重建索引",
        "memory.settings.vectorReindexing": "索引中…",
        "memory.settings.vectorReindexDone": "已索引 {n} 条",
        "memory.settings.vectorReindexPartial": "已索引 {n} 条，{f} 条失败",
        "memory.settings.vectorReindexRemaining": "已索引 {n} 条，还剩 {r} 条待重建",
        "memory.settings.vectorReindexNothing": "没有需要重建的行（当前模型的向量已齐）",
        "memory.settings.apiTokenTitle": "API Token（可选）",
        "memory.settings.apiTokenHint": "这里只把 Token 存在当前浏览器（localStorage），供面板请求携带；服务端的锁是插件配置里的 apiToken，两边填同一个值才真正上锁。只填这里不改服务端 = 没上锁。",
        "memory.settings.apiTokenPlaceholder": "与插件配置的 apiToken 保持一致",
        "memory.settings.apiTokenSave": "保存 Token",
        "memory.settings.apiTokenSaved": "Token 已保存",
        "memory.settings.feedback.title": "意见与反馈",
        "memory.settings.feedback.desc": "遇到问题？直接告诉我们，或先看看有没有人遇到过：",
        "memory.settings.feedback.newIssue": "在 GitHub 上反馈问题",
        "memory.settings.feedback.newIssue.sub": "自动带上插件版本与环境信息",
        "memory.settings.feedback.email": "邮件反馈",
        "memory.settings.feedback.email.sub": "work@modusensus.space",
        "memory.settings.feedback.browse": "浏览已知问题",
        "memory.settings.feedback.browse.sub": "先搜搜，省一份重复 issue",
        "memory.settings.feedback.hint": "反馈前先搜搜是否已有相同问题，能省一份重复的 issue～",
        "memory.settings.update.check": "检测更新",
        "memory.settings.update.latest": "已是最新版本 ✓",
        "memory.settings.update.ahead": "当前版本比 registry 还新（本地开发版）",
        "memory.settings.update.error": "检测失败：稍后再试",
        // 检测更新点出的第三种结果（发现新版本）；横幅形态已删，它现在只是
        // 按需那一行的文案，占位 {v}/{c} 由 checkResultText 填。
        "memory.settings.version.outdated": "有新版本 {v}（当前运行 {c}）",
        "memory.settings.version.outdatedHint": "若安装时指定过版本号，常规升级不会跨大/小版本（pnpm 钉子）——请重新安装或在升级命令加 --latest；npm 已发布而市场暂未收录属正常（约 1 天延迟）。",
        "memory.settings.star": "给项目点个 Star",
        "memory.settings.star.sub": "它对你是好用的，就鼓励一下作者吧 (●'◡'●)",
        "memory.settings.mode.title": "运行模式",
        "memory.settings.mode.desc": "轻量模式只保留核心能力：记忆读写、自动注入、热记忆；巩固、实体抽取、语义搜索等全部关闭，适合低配机器或只想「记住偏好」的场景。标准模式开启全部功能。",
        "memory.settings.mode.light": "轻量",
        "memory.settings.mode.standard": "标准",
        "memory.settings.mode.savedHint": "已保存，重启 DSH 后生效",
        "memory.settings.mode.offList": "已关闭：巩固（autoDream）· 实体抽取 · 语义搜索",
        // #514：用户把宿主「极简（minimal）」与插件「轻量」混为一谈，以为关掉人格是
        // 轻量模式干的。这个词条把两件事分开说清楚，不再让用户自己猜。
        "memory.settings.mode.hostPresetHint": "注意区分：这里的「轻量 / 标准」是插件的记忆引擎档位，与 DSH 宿主的「极简模式（minimal 预设）」是两回事——轻量档不会关闭人格定义。",
        "memory.status.minimalPresetTitle": "当前会话用的是宿主的「极简模式」",
        "memory.status.minimalPresetBody": "极简预设（minimal）把 system prompt 整体接管了，记忆、用户画像、人格定义都不会送达模型。这是宿主的设计边界，插件改不了。想要它们生效：把 DSH 切到标准模式（或在 ~/.dsh/settings.yaml 设 agent-presets.default: standard）；过渡方案是把画像与规则写进 AGENTS.md——那条走指令路径，不受这个压制。",
        "memory.settings.extapi.title": "外部访问 API",
        "memory.settings.extapi.desc": "开放一个本机接口，让其他工具（插件、命令行、桌面应用）也能读写这份记忆库，默认只允许本机连接。改动保存后重启 DSH 生效。",
        "memory.settings.extapi.enabled": "启用",
        "memory.settings.extapi.disabled": "停用",
        "memory.settings.extapi.address": "地址",
        "memory.settings.extapi.port": "端口",
        "memory.settings.extapi.token": "Token",
        "memory.settings.extapi.copy": "复制",
        "memory.settings.extapi.copied": "已复制",
        "memory.settings.serve.title": "独立服务 dsh-mneme-serve",
        "memory.settings.serve.desc": "不启动 DSH 也能以 HTTP 方式访问同一份记忆库（无 LLM 数据面）。",
        "memory.settings.serve.cmd": "npx -p @modusensus/dsh-mneme dsh-mneme-serve --memory-dir <记忆库目录> --port <端口>",
        "memory.settings.serve.copy": "复制",
        "memory.settings.serve.copied": "已复制",
        "memory.settings.serve.hint": "与「外部访问 API」同源：同一套路由与鉴权，指向同一记忆库目录时，调用方应使用面板这张令牌（通常有效，非承诺）。两者默认抢同一端口，二选一或用 --port 错开。",
        "memory.settings.mcp.title": "MCP 服务 dsh-mneme-mcp",
        "memory.settings.mcp.desc": "stdio MCP 服务器：任何 MCP 客户端（Claude Code / Cursor 等）挂载后，即可获得与 DSH 内一致的记忆工具六件套。",
        "memory.settings.mcp.snippet": "{ \"mcpServers\": { \"dsh-mneme\": { \"command\": \"dsh-mneme-mcp\", \"env\": { \"DSH_MNEME_TOKEN\": \"<外部访问 API 的 token>\" } } } }",
        "memory.settings.mcp.copy": "复制",
        "memory.settings.mcp.copied": "已复制",
        "memory.settings.configKeys.title": "配置键覆盖面",
        "memory.settings.configKeys.desc": "配置文件里的键，面板能改多少、哪些只能手改。只列键名，不显示任何值。",
        "memory.settings.configKeys.summary": "schema 里共 {schema} 个键：面板能改 {panel} 个，{file} 个只能改配置文件，另有 {undefaulted} 个登记了却没有默认值。",
        "memory.settings.configKeys.fileOnlyHead": "只能改配置文件（{n} 个）",
        "memory.settings.configKeys.undefaultedHead": "面板登记了、但运行时没有默认值（{n} 个）",
        "memory.settings.configKeys.undefaultedHint": "这些键在白名单里，所以面板上有输入框；但 schema 没给默认值，留空时「当前生效值」里就没有它。填一个值才会生效。",
        "memory.settings.configKeys.show": "展开清单",
        "memory.settings.configKeys.hide": "收起清单",
        "memory.settings.configKeys.loadFailed": "没能取到这份清单（接口暂时不可用）——这不等于「没有只能改文件的键」。",
        "memory.settings.mcp.hint": "数据面走「外部访问 API」（默认 127.0.0.1:8790，Bearer），token 就是上面那张；可用 DSH_MNEME_URL / DSH_MNEME_TOKEN 环境变量或 ~/.dsh-mneme/cli.json 覆盖。command 需在 PATH 上（随 @modusensus/dsh-mneme 安装自带）。",
        "memory.settings.extapi.savedHint": "已保存，重启 DSH 后生效",
        "memory.settings.extapi.invalidPort": "端口需为 1-65535 的数字",
        "memory.tab.rejected_solution": "被否决方案",
        "memory.tab.pitfall": "踩坑记录",
        "memory.tab.constraint": "工程约束",
        "memory.tab.document": "文档",
        "memory.features.title": "功能开关",
        "memory.features.desc": "控制插件在后台做哪些事。先看「常用」里的总开关就够了，其余项收在「全部设置」里。改动即时保存，重启 DSH 后生效。",
        // Issue #427：分组原先按「实现」分（基础/检索与增强/巩固与睡眠/多会话隔离
        // 是架构图的分区），而人真正会问的是四个问题：它会记住什么、它什么时候
        // 写进去、它怎么用回来、不同会话会不会串。组名改成人话，术语留在 hint。
        // group.basic 是首屏层：新用户不读文档就该答得出「会不会自动记」；
        // 「别的会话能不能看到」由同在首屏的 scope 组回答。
        "memory.features.group.basic": "常用（先动这几个）",
        "memory.features.group.core": "它会记住什么",
        // group.mo 是 v0.9.0 的独立分组（座位闸门，不是行为开关），现已随 M.O.
        // 下架从 FEATURE_GROUPS 摘掉；这条文案留着是为了恢复时不必再想措辞。
        "memory.features.group.mo": "它的工作流（M.O.）",
        "memory.features.group.enhance": "它什么时候写进去",
        "memory.features.group.dream": "它怎么用回来",
        "memory.features.group.scope": "不同会话之间",
        "memory.features.group.advanced": "高级",
        // 「全部设置」= 第一层折叠（issue #427 建议 1），常显只留 basic + scope
        // 两组；「高级」是它内部的第二层（进阶 7 项）。
        "memory.features.allToggle": "全部设置",
        "memory.features.advancedToggle": "更少用的 7 个开关",
        "memory.features.restartHint": "重启 DSH 后生效",
        "memory.features.loadFailed": "加载失败",
        "memory.features.saveFailed": "保存失败",
        // Issue #427 建议 2：条目名给「打开会怎样、关掉会怎样」，术语放末尾。
        // 括号里的英文是设置项键名，末尾的「（BM25）」才是术语。
        "memory.features.autoInject": "自动带上旧记忆（每轮都用）",
        "memory.features.autoInject.hint": "开：每轮自动挑相关记忆塞给 Agent，它不用问就能想起；关：Agent 得自己调用查记忆的工具",
        "memory.features.injectGuidanceEnabled": "顺带教 Agent 怎么用记忆",
        "memory.features.injectGuidanceEnabled.hint": "开：在记忆工具的说明里写清什么时候该查、什么时候该写；关：只给工具不给用法",
        "memory.features.continuityRescueEnabled": "长对话被压缩前先存一份快照",
        "memory.features.continuityRescueEnabled.hint": "开：压缩前先存「正在做什么 / 下一步 / 未决问题」，关键上下文活过压缩；关：压缩可能把它压掉",
        "memory.features.parentOff": "上一项关闭时不生效",
        // 「默认 / 已改」徽标：overrides 里没有这个键 = 值来自 config schema 的
        // 默认值，一条命令就能退回。徽标让这件事不必去读配置文件才成立。
        "memory.features.tagDefault": "默认",
        "memory.features.tagDefault.hint": "这一项用的是出厂默认值，没有被你改过",
        "memory.features.tagChanged": "已改",
        "memory.features.tagChanged.hint": "你改过这一项，它不再用默认值",
        // 「待重启」是第三态，不是「已改」的加强版：#481 之前面板只有「已改」，
        // 用户改完总闸看到徽标亮起就以为生效了，实际运行时还在用启动时的旧值。
        "memory.features.tagPending": "待重启",
        "memory.features.tagPending.hint": "这一项已存进配置，但本次启动还没用上——重启 DSH（或在插件管理里关开一次本插件）后才生效",
        "memory.features.pendingRestartNotice": "有改动还没生效：标着「待重启」的开关要等重启 DSH 后才起作用（在插件管理里把本插件关开一次也行）。",
        "memory.features.autoSummarize": "自动把对话记下来（自动注入之外）",
        "memory.features.autoSummarize.hint": "开：对话结束自动提炼成长期记忆条目（autoSummarize）；关：只有你手动存或 Agent 主动存才有记忆",
        "memory.features.hotMemoryEnabled": "顺带带上最近几轮原话",
        "memory.features.hotMemoryEnabled.hint": "开：注入时把最近几轮的对话原文一并带上，Agent 眼前就是刚才聊的内容；关：只带提炼后的长期记忆。这几轮原文不会写进长期记忆（热记忆，默认开）",
        "memory.features.injectTimePrefix": "会话开头告诉它今天几号",
        "memory.features.injectTimePrefix.hint": "开：每个新会话的第一轮注入一次日期与星期，「今天」「上周」这类说法更稳；关：注入里不带时间（时间前缀，默认关）",
        "memory.features.entityExtractionEnabled": "顺手抽出人名、项目和概念",
        "memory.features.entityExtractionEnabled.hint": "开：每条新记忆里抽出人物/项目/概念，关系图谱自己长起来，也能按「谁」找记忆；关：只存整条记忆，不建关系（实体抽取，默认关）",
        "memory.features.entityExtractionProvider": "实体抽取 Provider",
        "memory.features.entityExtractionModel": "实体抽取模型",
        "memory.features.entityExtractionReasoning": "实体抽取思考强度",
        "memory.features.entityExtractionReasoning.none": "跟随默认",
        "memory.features.entityExtractionReasoning.low": "低",
        "memory.features.entityExtractionReasoning.medium": "中",
        "memory.features.entityExtractionReasoning.high": "高",
        "memory.features.summarizeReasoningEffort": "蒸馏思考强度",
        "memory.features.summarizeReasoningEffort.off": "关闭思考",
        "memory.features.summarizeReasoningEffort.none": "跟随默认",
        "memory.features.summarizeReasoningEffort.low": "低",
        "memory.features.summarizeReasoningEffort.medium": "中",
        "memory.features.summarizeReasoningEffort.high": "高",
        "memory.features.summarizeReasoningEffort.hint": "思考型模型建议选「低」或「关闭思考」，避免推理占满输出导致总结失败",
        "memory.features.entityExtractionModelHint": "Provider / 模型留空 = 跟随主对话模型；思考强度选「跟随默认」= 服务商默认",
        "memory.features.codingRetrospect": "写代码的过程也记下来",
        "memory.features.codingRetrospect.hint": "开：整段编码过程（含报错与工具调用）一并回顾，沉淀踩坑、约束和被否决的方案；关：只提炼对话内容（编码记忆蒸馏，默认关）",
        "memory.features.rerankEnabled": "搜出来的结果再精排一遍",
        "memory.features.rerankEnabled.hint": "开：本地重排模型给召回结果重新打分，更准但更慢；关：直接用检索时的排序（结果重排，默认关）",
        "memory.features.heatEnabled": "越久没用越靠后（像会忘）",
        "memory.features.heatEnabled.hint": "开：像遗忘曲线一样给记忆降温，长期没用过的往后排、不占注入名额；关：一直按相关度排（热度衰减，默认关）",
        "memory.features.documentMemoryEnabled": "长文档只存一张摘要卡",
        "memory.features.documentMemoryEnabled.hint": "开：Agent 写的长文档在记忆里只放「摘要卡」，正文仍由 Agent 保管、按需读取，注入只带摘要；关：整篇都往上下文里带（document 型记忆，默认关）",
        // --- v0.9.0 M.O.（Modus Operandi，beta）---
        // M.O. = Modus Operandi，拉丁语「一个人一贯的做事方式」；也是 org 词根
        // modus（modusensus）。界面主显示 M.O.，设置项 hint 第一句给全名。
        "memory.actions.beta": "beta",
        "memory.actions.notice": "提炼结果是候选，可能有错、过时、会被推翻。",
        "memory.actions.title": "M.O. · 工作流",
        "memory.actions.open": "打开 M.O.",
        "memory.actions.viewFull": "完整视图",
        "memory.actions.openPane": "在右栏打开完整视图",
        "memory.actions.announce.open": "M.O. 面板已打开",
        "memory.actions.announce.close": "M.O. 面板已关闭",
        "memory.actions.close": "关闭",
        "memory.actions.candidates": "候选 {n} 条",
        "memory.actions.runs": "最近运行",
        "memory.actions.runOf": "运行 {n}",
        "memory.actions.run.ok": "成功",
        "memory.actions.run.failed": "失败",
        "memory.actions.run.refuted": "被推翻",
        "memory.actions.state.candidate": "候选",
        "memory.actions.state.trusted": "可信",
        "memory.actions.state.stale": "过时",
        "memory.actions.state.refuted": "被推翻",
        "memory.actions.gate.has": "有闸门证据",
        "memory.actions.gate.none": "还没闸门",
        "memory.actions.gate.tag": "闸",
        "memory.actions.who.main": "主",
        "memory.actions.who.human": "人",
        "memory.actions.who.ci": "CI",
        "memory.actions.ov.done": "完成判据",
        "memory.actions.ov.trigger": "何时触发",
        "memory.actions.band.count": "{n} 步",
        "memory.actions.legend.states": "状态",
        "memory.actions.detail.situation": "情形",
        "memory.actions.detail.action": "动作",
        "memory.actions.detail.why": "为什么",
        "memory.actions.detail.cf": "反事实",
        "memory.actions.detail.noCf": "该节点还没有反事实记录",
        "memory.actions.detail.source": "来源记忆",
        "memory.actions.credit": "复用",
        "memory.actions.creditValue": "{n} 次 · 上次 {d} 天前",
        "memory.actions.dep": "依赖",
        "memory.actions.zoom.value": "缩放 {n}%",
        "memory.actions.zoom.in": "放大",
        "memory.actions.zoom.out": "缩小",
        "memory.actions.zoom.fit": "适应宽度",
        "memory.actions.zoom.hint": "Ctrl/⌘ + 滚轮也能缩放",
        // 缩放百分比指示（{n} 由画布工具条填）；基线 4568614 起就缺这两行，
        // 工具条上会直接显示键名。
        "memory.actions.list.heading": "这个项目里的工作流",
        "memory.actions.list.count": "工作流 {n} 条",
        "memory.actions.list.meta": "{steps} 步 · {gates} 道闸门 · 反事实 {cf}/{steps}",
        "memory.actions.scope.project": "项目 {name}",
        "memory.actions.scope.global": "全局",
        "memory.actions.scope.none": "项目未知",
        "memory.actions.broken": "有文件读不出来：",
        "memory.actions.empty.title": "这个项目里还没有工作流",
        "memory.actions.empty.body": "工作流的本体住在项目里的 .mneme/pipelines/ 下——跟着仓库走，能被提交、能被 review、能被 CI 读。做法被复用第二次才算节点类型，第一次只是实例；同一路径被走通两次之后，它才会从会话里被提炼出来、落到那个目录里。",
        "memory.actions.distill.action": "现在沉淀一次",
        "memory.actions.distill.busy": "正在读会话…",
        "memory.actions.distill.hint": "看一遍这个项目自己的会话日志，把反复走通的动作挖成提议。只写提议，不落草稿、不改仓库。",
        "memory.actions.distill.noProject": "读不到会话的工作目录，所以不知道该看哪个项目的日志",
        "memory.actions.distill.saved": "已提出 {n} 条提议（本次挖到 {m} 条候选）",
        "memory.actions.distill.none": "这一遍没挖到新的重复动作",
        "memory.actions.distill.noSessions": "这个项目还没有自己的会话日志，先攒几轮再来",
        "memory.actions.distill.unreadable": "会话日志读不出来（这是环境问题，不是「没有重复动作」）",
        "memory.actions.distill.failed": "这一遍没跑完，详见插件日志",
        "memory.actions.noRuns": "这一条还没有运行记录，所以每个节点都还是候选。",
        "memory.actions.settle.title": "本次运行",
        "memory.actions.settle.line": "「{title}」",
        "memory.actions.settle.used": "本次复用 {n} 条做法（勾选为被用上）",
        "memory.actions.settle.refutedWarn": "本次路径里有已被推翻的节点，结果仅供参考",
        "memory.features.actionPipelineEnabled": "M.O.（beta）",
        "memory.features.actionPipelineEnabled.hint": "只读视图：把真实会话里反复走通的动作连成一张图谱——会话头图标、右栏完整视图、每次运行的结算卡。看 ≠ 写：沉淀由「M.O. 自动沉淀」单独开，执行记账由 /mo-run 单独开。Modus Operandi（工作流）。重启 DSH 后生效",
        "memory.features.actionNudgeEnabled": "自动沉淀工作流（beta）",
        "memory.features.actionNudgeEnabled.hint": "开：每轮结束后看一眼这个项目自己的会话日志，把反复走通的动作挖成记忆库里的一条「提议」，等你确认才可能变成工作流。只产草稿、不自动启用、不往仓库里塞文件。挂热路径且要解压日志，轻量档会强制关掉。重启 DSH 后生效",
        "memory.features.diaryEnabled": "日记本（beta）",
        "memory.features.diaryEnabled.hint": "开：右栏多一个「日记本」，拥有人格的 agent 每天用这个项目真实发生过的对话写一篇日记——今天没聊就不写，不编。日记正文落在记忆目录，点「存到这个项目」才复制一份到项目里。轻量档会强制关掉。重启 DSH 后生效",
        "memory.features.diaryWriteEveryMinutes": "每隔多少分钟自动写（0 = 关）",
        "memory.features.diaryWriteEveryMinutes.hint": "关着时只有「聊完天」和「重启 DSH」两个时刻会判断今天该不该写——你整天不说话，它就整天不写。填个分钟数（如 60）它会到点自己醒来看一眼。仍然一天最多一篇，写不写由磁盘上有没有当天的文件决定",
        "memory.diary.title": "日记本",
        "memory.diary.note": "写的是这个项目里真实发生过的事：没聊过就不写，不编。",
        "memory.diary.write": "写今天",
        "memory.diary.writing": "正在写…",
        "memory.diary.export": "存到这个项目",
        "memory.diary.exporting": "正在存…",
        "memory.diary.loading": "正在读…",
        "memory.diary.noProject": "不知道这个会话属于哪个项目",
        "memory.diary.noProjectHint": "会话还没有工作目录，日记不知道该写到哪里。换一个有工作目录的会话再打开。",
        "memory.diary.noProjectRoot": "不知道这本书属于哪个项目，写不了",
        "memory.diary.disabled": "日记本没有开",
        "memory.diary.disabledHint": "到「设置 › 增强」里打开「日记本」，重启 DSH 之后这个入口才可用。",
        "memory.diary.unavailable": "日记服务没有装配起来",
        "memory.diary.readFailed": "读不出日记",
        "memory.diary.retry": "重试",
        "memory.diary.empty": "这个项目还没有日记",
        "memory.diary.emptyHint": "点「写今天」：它拿这个会话今天真实说过的话写一篇；今天没聊过就不写。",
"memory.diary.libraryEmpty": "还没有任何一本日记",
"memory.diary.libraryEmptyHint": "日记按 Agent 分本，写在记忆库的 diaries 目录下。写完第一篇这里就会出现它的名字。",
        "memory.diary.pickHint": "左边选一天，右边看正文。",
        "memory.diary.bookLabel": "纸和字",
        "memory.diary.book.plain": "素纸",
        "memory.diary.book.ruled": "横线",
        "memory.diary.book.grid": "方格",
        "memory.diary.book.kraft": "牛皮",
        "memory.diary.count": "共 {n} 篇",
        "memory.diary.writtenOk": "写好了：{path}",
  "memory.diary.exportOk": "已存到 {path}",
        "memory.diary.exportExists": "那个文件已经在项目里了，没有覆盖",
        "memory.diary.exportFailed": "存不进去",
        "memory.diary.composeFailed": "这次没有写成",
        "memory.diary.skip.already": "今天已经写过一篇了，没有重复写。",
        "memory.diary.skip.noMaterial": "今天这个项目没有可用的对话素材，所以没写。",
        "memory.diary.skip.other": "这一轮没有写成。",
        "memory.diary.auditTitle": "最近几轮",
        "memory.diary.status.written": "写了",
        "memory.diary.status.skipped": "跳过",
        "memory.diary.status.failed": "失败",
        "memory.features.resilientModelDownload": "模型下载断了能续上",
        "memory.features.resilientModelDownload.hint": "开：下载中断后从断点续传并自动重试；关：中断就整份重来（断点续传，默认开）",
        "memory.features.searchSemanticDedup": "搜到意思相同的只留一条",
        "memory.features.searchSemanticDedup.hint": "开：检索结果里意思相近的条目合并成一条，少占名额；关：同义条目一起出现（语义去重，默认关）",
        "memory.features.autoDream": "后台自动整理记忆（合并 · 去重）",
        "memory.features.autoDream.hint": "开：后台自动合并、沉淀碎片记忆（autoDream）；关：记忆只增不减，越用越散",
        "memory.features.sleepModeEnabled": "你不在的时候它整理记忆",
        "memory.features.sleepModeEnabled.hint": "开：空闲时段做分层压缩与整理，白天少打扰；关：只有你手动触发的整理（睡眠模式，默认关）",
        // #619：情感归因是 sleep 的子相——父开关关着它就一定不跑，所以紧挨着摆。
        "memory.features.sleepAffectiveEnabled": "它记得你在哪件事上是什么心情",
        "memory.features.sleepAffectiveEnabled.hint": "开：整理时把「某人在某件事上的情绪」记成一条带场合的关联，跨多个独立场合反复出现才认作稳定倾向；关：不记录情绪（情感归因，默认关，且要睡眠模式开着）",
        // #427 建议 5：hybridInject / selectiveInjectEnabled / adaptiveThresholdEnabled
        // 是同一件事「带什么回来」的三档，相邻摆放并在 hint 里点明，不再摊成
        // 三个不相干的并列开关。
        "memory.features.hybridInject": "关键词 + 意思 两路一起找",
        "memory.features.hybridInject.hint": "开：两路检索各取一批再合并，召回更全；关：只用一路。「带什么回来」共三档（混合注入 / 选择性注入 / 自适应阈值），可只开其中一档（混合注入，默认开）",
        "memory.features.selectiveInjectEnabled": "只带真正相关的记忆",
        "memory.features.selectiveInjectEnabled.hint": "开：按相关性筛一遍再注入，上下文更干净；关：带出去的更多也更杂。三档之一（选择性注入，默认开）",
        "memory.features.adaptiveThresholdEnabled": "按检索质量自动调松紧",
        "memory.features.adaptiveThresholdEnabled.hint": "开：召回质量差时放宽门槛、好时收紧；关：门槛固定。三档之一（自适应阈值，默认开）",
        "memory.features.reflectionUpdateEnabled": "整理时允许改已有记忆",
        "memory.features.reflectionUpdateEnabled.hint": "开：巩固可以改写、合并已有条目，不是只增不改；关：旧记忆永不被自动改动（反思更新，默认开）",
        "memory.features.distill": "蒸馏与限流",
        "memory.features.distillRateLimitIntervalMs": "蒸馏放行间隔 (ms)",
        "memory.features.distillRateLimitRetries": "429 重试次数",
        "memory.features.distillRateLimitBaseDelayMs": "退避起始延迟 (ms)",
        "memory.features.distillMaxChars": "转录截断上限（字符）",
        // #399 的两个留存键。此前只有后端白名单、面板够不着，而
        // docs/CONFIGURATION.md 写的是「面板可启停」——补 UI 让文档成真。
        // hint 必须写清两件事：这是**原始对话**落盘（隐私面），以及天数只管
        // 启动期裁剪（reclaim 走另一条 --older-than，不读这个键）。
        "memory.features.distillRecords.enabled": "留存蒸馏原文",
        "memory.features.distillRecords.enabled.hint": "蒸馏时把窗口内的公开对话原文一并落盘，并记下每条记忆的来源区间；私密推理与工具结果不落。关 = 一行不写、连收集都不做",
        "memory.features.distillRecords.retentionDays": "原文保留天数",
        "memory.features.distillRecords.retentionDays.hint": "1–3650 天；只管启动期裁剪。想让 reclaim 也按这个天数回收，需显式传 --older-than 同一数值",
        "memory.features.codingBoostFactor": "编码记忆加权",
        "memory.features.memoryQualityFilter.enabled": "没价值的记忆自动收起来",
        "memory.features.memoryQualityFilter.enabled.hint": "开：低价值条目自动归档、注入时按质量降权；关：什么都留着，噪声也一起带（记忆质量过滤，默认开）",
        "memory.features.llmAudit.enabled": "记下后台用了多少模型调用",
        "memory.features.llmAudit.enabled.hint": "开：巩固/总结的后台调用与 token 消耗都有账可查；关：后台开销无从核对（调用审计，默认开）",
        // #254：写入准入两层。检测关时整条路径不碰；检测开、拦截关 = 仅告警 +
        // 留审计；两个都开才真拦。文案要写清「只留审计」与「真拦下」的区别，
        // 否则操作者会以为打开检测就已经在拦。
        "memory.features.writeAdmission.enabled": "写入前先判一下是不是废话（只记不拦）",
        "memory.features.writeAdmission.enabled.hint": "开：空白/噪声写入判为命中并留一条审计记录，但仍存进去；关：完全不判。要真拦，见下一项（写入准入判定，默认关）",
        "memory.features.writeAdmission.enforce": "真把没用的写入挡下来",
        "memory.features.writeAdmission.enforce.hint": "开：命中直接拒绝写入；关：只留审计、照存不误。需先打开上面那项判定（写入准入拦截，默认关）",
        "memory.features.preInjectGate.enabled": "注入前先筛掉「只是我的看法」的记忆（只记不拦）",
        "memory.features.preInjectGate.enabled.hint": "开：注入前判出意见/立场类记忆并留审计，先观察分布；关：照常注入（注入前判定，默认关）",
        "memory.features.preInjectGate.enforce": "注入时真滤掉判定不合适的",
        "memory.features.preInjectGate.enforce.hint": "开：命中的候选在注入时丢掉；关：只留审计、照常注入。需先打开上面那项判定（注入前判定拦截，默认关）",
        // #164 A2：密钥/PII 判据自己的闸。文案要写清它管的是哪一批判据（与上面的
        // 空白/噪声分开）、它跑在「写入准入判定」里面（那一项关着就不跑），以及
        // 「开着也不拦」——拦是上面那项的事。
        "memory.features.sensitiveScanEnabled": "写入前扫一遍密钥和个人信息",
        "memory.features.sensitiveScanEnabled.hint": "开：在写入准入判定里面扫密钥/个人信息，命中只留审计；要真拦，再打开「写入准入拦截」。判定关着时它不跑（密钥/PII 扫描，默认关）",
        "memory.features.bm25SearchEnabled": "也用关键词方式找记忆",
        "memory.features.bm25SearchEnabled.hint": "开：多一个字少一个字也搜得到，专名、报错码、路径更易命中，与「按意思找」互补；关：只按语义相近度（BM25 关键词检索，默认开）",
        "memory.features.conflictFreezeEnabled": "互相矛盾的记忆先冻结",
        "memory.features.conflictFreezeEnabled.hint": "开：整理发现矛盾时先冻结待你确认，不让两条同时生效；关：两边都照用（冲突冻结，默认关）",
        "memory.features.scopeEnabled": "记住每条记忆来自哪个会话",
        "memory.features.scopeEnabled.hint": "开：每条新记忆标上来自哪个 Agent / 工作区，别的会话能不能看到由它说了算；关：新记忆不带来源，所有会话共用一批记忆（作用域标注，默认关）",
        "memory.features.strictScope": "别人设为私有的记忆我看不见",
        "memory.features.strictScope.hint": "开：其他会话明确标私有的记忆对你彻底不可见；关：仍可见、只是排到后面。要彻底隔离请用条目的「敏感度」字段。需先打开上面那项标注（严格隔离，默认关）",
        "memory.features.trustEpistemicWeighting": "按来源可信度调排序",
        "memory.features.trustEpistemicWeighting.hint": "开：可信度高的来源排前面；关：一视同仁（可信度加权，实验性，默认关）",
        "memory.features.reflectionFailureTracking": "整理失败时留下案例",
        "memory.features.reflectionFailureTracking.hint": "开：把失败原因与案例记下来供诊断改进；关：失败不留记录（失败追踪，默认开）",
        "memory.features.embedRoute": "语义检索路线",
        "memory.features.embedProvider": "Embedding 提供方",
        "memory.features.embedProvider.openai": "OpenAI 兼容接口",
        "memory.features.embedProvider.local": "本地模型（离线）",
        "memory.features.embedProvider.ollama": "Ollama",
        "memory.features.embedProvider.openai.hint": "接口地址 / Key / 模型在「向量搜索」卡片配置",
        "memory.features.embedProvider.local.hint": "首次使用会下载模型，之后完全离线",
        "memory.features.embedProvider.ollama.hint": "需要本机 Ollama 服务在运行",
        "memory.features.localEmbedModel": "本地 embedding 模型",
        "memory.features.ollamaBaseUrl": "Ollama 服务地址",
        "memory.features.ollamaModel": "Ollama 模型名",
        "memory.features.dreamProvider": "巩固模型 Provider",
        "memory.features.dreamModel": "巩固用模型名",
        "memory.features.dreamModelHint": "留空 = 跟随主对话模型；只影响记忆巩固（autoDream）用的模型",
        "memory.features.dreamPeakHours": "高峰时段（不做梦）",
        "memory.features.dreamPeakHours.hint": "设置忙碌时段，巩固会避开这些时间、事后补跑。写法：09:00-18:00，多段用逗号分隔，可带星期（如 mon-fri 08:00-12:00），支持跨零点；留空 = 不限制",
        "memory.features.dreamPeakHours.invalid": "当前值无法解析为时段，将按未配置处理（巩固全天候生效）。写法：09:00-18:00，多段用逗号分隔，可带星期前缀（mon-fri 08:00-12:00），支持跨零点；24:00 越界请写 00:00",
        "memory.features.summarizePeakHours": "高峰时段（不蒸馏）",
        "memory.features.summarizePeakHours.hint": "与巩固侧同一份写法；蒸馏会避开这些时段，窗口先攒着、非高峰一次蒸完",
        "memory.features.summarizePeakHours.invalid": "当前值无法解析为时段，将按未配置处理（蒸馏全天候生效）。写法与巩固侧相同：09:00-18:00，多段用逗号分隔，可带星期前缀，支持跨零点",
        "memory.features.sleepProvider": "睡眠 Provider",
        "memory.features.sleepModel": "睡眠模型",
        "memory.features.sleepModelHint": "留空 = 用巩固模型或当前模型；建议选非思考模型",
        // Issue #478：max_tokens 预算键。hint 写清两件事：这是「单轮输出预算」，
        // 以及服务商硬上限更小时后端会按报错自动降级重试（对齐 #478 的后端行为）。
        "memory.features.dreamMaxTokens": "巩固单轮输出上限 (max_tokens)",
        "memory.features.dreamMaxTokens.hint": "单轮巩固最多生成多少 token，256–131072。默认 131072 超过部分服务商硬上限时，后端会按报错里的上限自动降级重试",
        "memory.features.sleepMaxTokens": "睡眠单轮输出上限 (max_tokens)",
        "memory.features.sleepMaxTokens.hint": "睡眠阶段冲突/模式判断的单轮输出预算，256–131072；超上限同样自动降级",
        "memory.features.routeFollowDefault": "跟随默认路由",
        "memory.features.modelTest": "测试连通性",
        "memory.features.modelTesting": "测试中…",
        "memory.features.modelTestOk": "连通正常",
        "memory.features.modelTestFail": "测试失败",
        "memory.features.modelTestHint": "真实发起一次最小巩固调用，验证 Provider/模型连通与 effort 支持",
        "memory.features.modelTestDowngraded": "档位不被该模型接受，已去掉档位连通（与真实巩固一致）",
        "memory.features.routeStaleMark": "（不在可用列表）",
        "memory.features.routeStaleHint": "该值不在当前可用列表（常见于切换过 Provider）：请重新选择，或点「测试连通性」当场验证",
        "memory.explorer.viewCards": "卡片",
        "memory.explorer.viewTimeline": "时间线",
        "memory.explorer.viewAria": "视图切换",
        "memory.explorer.dateLabel": "时间",
        "memory.explorer.date.all": "全部时间",
        "memory.explorer.date.7d": "近 7 天",
        "memory.explorer.date.30d": "近 30 天",
        "memory.explorer.date.90d": "近 90 天",
        "memory.explorer.more": "更多操作",
        "memory.explorer.exportJson": "导出 JSON",
        "memory.explorer.exportMarkdown": "导出 Markdown",
        "memory.explorer.importMd": "导入 Markdown 镜像…",
        "memory.explorer.importTitle": "导入 Markdown 镜像",
        "memory.explorer.importHint": "选择一个镜像类型的 Markdown 文件，解析其中的人工编辑并合并进记忆库。",
        "memory.explorer.importType": "镜像类型",
        "memory.explorer.importPick": "选择文件…",
        "memory.explorer.importConfirm": "导入",
        "memory.explorer.importCancel": "取消",
        "memory.explorer.importing": "导入中…",
        "memory.explorer.imported": "已合并 {n} 条编辑",
        "memory.explorer.importFailed": "导入失败",
        "memory.explorer.importNoFile": "请先选择文件",
        "memory.explorer.bootstrap": "从目录引导…",
        "memory.explorer.bootstrapTitle": "从目录引导",
        "memory.explorer.bootstrapHint": "读这个目录里的确定性产物（脚本命令、README、贡献规范、CI 工作流、顶层结构、最近提交），一条规则一条记忆。不调用模型，重复执行只会合并更新、不会重复入库。",
        "memory.explorer.bootstrapDir": "目录路径",
        "memory.explorer.bootstrapConfirm": "开始引导",
        "memory.explorer.bootstraping": "引导中…",
        "memory.explorer.bootstrapDone": "新建 {n} 条、并入 {m} 条",
        "memory.explorer.bootstrapNoDir": "请先填写目录路径",
        "memory.explorer.bootstrapFailed": "引导失败",
        "memory.explorer.bootstrapErr.missing-dir": "没给目录路径",
        "memory.explorer.bootstrapErr.dir-not-found": "这个路径不存在",
        "memory.explorer.bootstrapErr.not-a-directory": "这个路径不是目录",
        "memory.explorer.bootstrapErr.bootstrap-unavailable": "当前装配下这条能力没接线",
        "memory.explorer.sharePack": "分享记忆包…",
        "memory.explorer.shareTitle": "分享记忆包",
        "memory.explorer.shareHint": "把本机活跃记忆打成一个可外发的包：密钥/PII 整条不发，本机路径抹成 ~，归档与遗忘的不进。",
        "memory.explorer.shareAlias": "分享别名",
        "memory.explorer.shareAliasBlank": "留空 = from-shared",
        "memory.explorer.shareType": "只发这一类",
        "memory.explorer.shareBuild": "生成",
        "memory.explorer.shareBuilding": "生成中…",
        "memory.explorer.shareFailed": "生成失败",
        "memory.explorer.shareIncluded": "进包 {n} 条",
        "memory.explorer.shareDeduped": "另有 {n} 条同键折叠，够格进包 {m} 条",
        "memory.explorer.shareSkipped": "跳过 {n} 条",
        "memory.explorer.share.skip.archived": "归档",
        "memory.explorer.share.skip.forgotten": "已遗忘",
        "memory.explorer.share.skip.readonly_type": "只读指针行",
        "memory.explorer.share.skip.excluded_type": "不外发的类型",
        "memory.explorer.share.skip.blank_or_noise": "空白或噪声",
        "memory.explorer.share.skip.sensitive": "密钥或 PII",
        "memory.explorer.shareSkipList": "跳过清单（{n} 条）",
        "memory.explorer.shareSkipListCapped": "清单只列前 {n} 条，上面计数是全量",
        "memory.explorer.shareNoTitle": "（标题不外发）",
        "memory.explorer.shareTooLarge": "包体 {bytes} 字节，超过 {limit} 字节水位",
        "memory.explorer.shareEmpty": "没有够格外发的条目，包是空的",
        "memory.explorer.shareDownload": "下载包文件",
        "memory.explorer.receivePack": "导入分享包…",
        "memory.explorer.receiveTitle": "导入分享包",
        "memory.explorer.receiveHint": "选她发来的包文件。先干跑预览，点确认才写库；导入的行进外来区，不参与本机的巩固、降级或整理。",
        "memory.explorer.receivePick": "选择包文件…",
        "memory.explorer.receiveNotJson": "这个文件不是 JSON",
        "memory.explorer.receiveNotPack": "这个文件不是分享包（顶层应该是一个 JSON 对象）",
        "memory.explorer.receivePreview": "先干跑预览",
        "memory.explorer.receiveConfirm": "确认导入",
        "memory.explorer.receiveFailed": "导入失败",
        "memory.explorer.receiveFrom": "来自 {alias}",
        "memory.explorer.receiveAnonymous": "未署名",
        "memory.explorer.receiveWouldCreate": "将新建 {n} 条",
        "memory.explorer.receiveDidCreate": "已新建 {n} 条",
        "memory.explorer.receiveExisting": "{n} 条已在库中",
        "memory.explorer.receiveUnchanged": "{n} 条正文相同",
        "memory.explorer.receiveConflicts": "撞名 {n} 条（不合并，请自己看）",
        "memory.explorer.receivePackCount": "包内 {n} 条",
        "memory.explorer.receiveStillDry": "没有写库：这一枪仍是干跑",
        "memory.explorer.filterForeign": "外来",
        "memory.explorer.filterForeignHint": "只看别人分享进来的记忆（source=imported）。这些行不参与本机的巩固、降级或整理。",
        "memory.explorer.filterForeignSearchHint": "搜索时这一档不按：搜索结果里没有可用的来源读数。要看外来区请先清掉搜索词。",
        "memory.explorer.foreignBadge": "来自 {alias}",
        "memory.explorer.foreignPack": "所属分享包",
        "memory.explorer.undoPack": "收起这个包",
        "memory.explorer.undoPackPreview": "将删除这个包的 {n} 条外来记忆（物理删除）",
        "memory.explorer.undoPackConfirm": "确认删除 {n} 条",
        "memory.explorer.undoPackDone": "已收起 {n} 条",
        "memory.explorer.undoPackFailed": "收起失败",
        "memory.explorer.undoPackBusy": "收起中…",
        "memory.explorer.undoPackStillDry": "没有删除：这一枪仍是干跑",
        "memory.explorer.undoPackGone": "这个包在本库里已经没有行了",
        "memory.explorer.newMemory": "新增记忆…",
        "memory.explorer.newTitle": "新增记忆",
        "memory.explorer.newHint": "手动写一条记忆。同类型同标题会并入既有条目，而不是长出第二行。",
        "memory.explorer.newType": "类型",
        "memory.explorer.newTitlePlaceholder": "短标题，也是去重键",
        "memory.explorer.newContentPlaceholder": "正文",
        "memory.explorer.newTagsPlaceholder": "标签，逗号分隔（可留空）",
        "memory.explorer.newConfirm": "新建",
        "memory.explorer.newSaving": "保存中…",
        "memory.explorer.newCreated": "已新建",
        "memory.explorer.newMerged": "已并入同标题的既有条目",
        "memory.explorer.newFailed": "新建失败",
        "memory.explorer.newNoTitle": "请先填写标题",
        "memory.explorer.newNoContent": "请先填写内容",
        "memory.explorer.exportFailed": "导出失败",
        "memory.explorer.conflictBadge": "冲突",
        "memory.explorer.archivedBadge": "已归档",
        "memory.explorer.scopeBadge": "作用域",
        "memory.explorer.detail.agentScope": "Agent 作用域",
        "memory.explorer.detail.workspaceScope": "工作区作用域",
        "memory.explorer.detail.scopeGlobal": "全局（所有会话可见）",
        "memory.explorer.detail.scopeSourceAuto": "自动",
        "memory.explorer.detail.scopeSourceExplicit": "显式",
        "memory.explorer.detail.scopeEditHint": "留空 = 全局；也可填写具体标签收窄归属",
        "memory.explorer.detail.scopeWidenConfirm": "确认放宽可见性？",
        "memory.explorer.detail.scopeWidenHint": "放宽后该记忆将对所有会话可见",
        "memory.explorer.detail.sensitivity": "敏感度",
        "memory.explorer.detail.occurred": "发生时间",
        "memory.explorer.detail.edit": "编辑",
        "memory.explorer.detail.save": "保存",
        "memory.explorer.detail.cancel": "取消",
        "memory.explorer.detail.archive": "归档",
        "memory.explorer.detail.restore": "恢复",
        "memory.explorer.detail.restored": "已恢复到主列表",
        "memory.explorer.detail.archived": "已归档",
        "memory.explorer.detail.archiveFailed": "操作失败",
        "memory.explorer.detail.saved": "已保存，镜像同步更新",
        "memory.explorer.detail.quality": "质量分",
        "memory.explorer.detail.entities": "关联实体",
        "memory.explorer.detail.entitiesEmpty": "开启实体抽取后，相关人物/项目会出现在这里",
        "memory.explorer.detail.provenance": "蒸发归因",
        "memory.explorer.detail.provenanceEmpty": "这条记忆没有归因：早于改造的历史行不补、也不猜",
        "memory.explorer.detail.provenanceMint": "铸造自",
        "memory.explorer.detail.provenanceWindow": "蒸馏窗口",
        "memory.explorer.detail.provenanceNoRun": "无运行归因（历史行）",
        "memory.explorer.detail.provenanceRecords": "{n} 条原文",
        "memory.explorer.detail.closeAria": "关闭详情",
        "memory.explorer.detail.editTitle": "标题",
        "memory.explorer.detail.editContent": "内容",
        "memory.explorer.detail.editImportance": "重要性",
        "memory.explorer.detail.starLabel": "设为 {n} 星",
        "memory.status.dream": "最近巩固",
        "memory.status.dreamNever": "尚未运行",
        "memory.status.dreamOrganizeOnly": "最近一次后台运行是 agent 主动整理（{time}），不计入巩固",
        "memory.status.conflicts": "待确认冲突",
        "memory.status.conflictsHint": "冻结的矛盾记忆，等待人工确认",
        "memory.status.skippedTitle": "本轮跳过 {n} 条决定",
        "memory.status.skippedHint": "这些决定被校验器拦下，未执行。同类原因已合并计数——出现一整类动作全部被拦，通常意味着提示词与护栏没对齐，值得看一眼。",
        "memory.status.skippedMore": "另有 {n} 类",
        "memory.status.skippedNone": "本轮没有跳过任何决定",
        "memory.status.injectSuppressed": "极简模式下注入按宿主设计关闭",
        "memory.status.injectSuppressedHint": "当前会话使用 minimal 预设：记忆注入 / 用户画像 / 热记忆不会送达模型（宿主设计，非插件缺陷）。切到标准模式，或在 ~/.dsh/settings.yaml 设 agent-presets.default: standard；过渡方案：把画像与规则写进 AGENTS.md",
        "memory.status.injectPreview": "注入预览",
        "memory.status.injectPreviewNone": "暂无预览——尚未发生注入（新会话或注入已关闭）",
        "memory.status.injectPreview.chars": "总体积",
        "memory.status.injectPreview.charsUnit": " 字符",
        "memory.status.injectPreview.maxItems": "注入上限",
        "memory.status.injectPreview.threshold": "相关性门槛",
        "memory.status.injectPreview.scope": "会话归属",
        "memory.status.injectPreview.query": "查询「{query}…」",
        "memory.status.injectPreview.hot": "hot memory",
        "memory.status.injectPreview.adaptiveOn": "自适应条数",
        "memory.status.injectPreview.rotated": "轮换抑制",
        "memory.status.injectPreview.empty": "本次组装未注入任何跨会话记忆（阈值或轮换过滤）",
        "memory.status.conflictQueue.reason": "原因",
        "memory.status.conflictQueue.sideA": "A 方",
        "memory.status.conflictQueue.sideB": "B 方",
        "memory.status.conflictQueue.keepA": "保留 A",
        "memory.status.conflictQueue.keepB": "保留 B",
        "memory.status.conflictQueue.markReviewed": "仅标记已处理",
        "memory.status.conflictQueue.applyHint": "确认后：保留方正文追加已否决注记，另一方归档。",
        "memory.status.conflictQueue.missing": "（该记忆已不存在）",
        "memory.status.conflictQueue.goto": "查看待确认冲突队列",
        "memory.status.conflictQueue.resolved": "已裁决：保留{name}",
        "memory.status.conflictQueue.refresh": "刷新队列",
        "memory.status.conflictQueue.refreshed": "冲突队列已刷新",
        "memory.status.conflictQueue.frozenBadge": "⏸ 冻结中",
        "memory.status.conflictQueue.frozenTitle": "冻结中：不参与注入与巩固，等你裁决",
        "memory.status.conflictQueue.similarity": "相似度",
        "memory.status.conflictQueue.diffTitle": "差异已高亮：红=删除、绿=新增",
        "memory.status.conflictQueue.diffFallback": "两段文本差异较大，请对照原文阅读",
        "memory.status.conflictQueue.expand": "展开全文",
        "memory.status.conflictQueue.collapse": "收起全文",
        "memory.status.conflictQueue.copySide": "复制本侧",
        "memory.status.conflictQueue.copiedSide": "本侧全文已复制",
        "memory.status.conflictQueue.importance": "重要度 {n}",
        "memory.status.conflictQueue.chars": "{n} 字符",
        "memory.status.conflictQueue.updated": "更新于 {time}",
        "memory.status.conflictQueue.created": "创建于 {time}",
        "memory.status.conflictQueue.emptyTitle": "暂无待确认冲突",
        "memory.status.conflictQueue.emptyBody": "当巩固发现两条互相矛盾或高度相似的记忆时，会先冻结在这里等你裁决，不会自动修改。裁决前双方都不参与注入。",
        "memory.status.conflictQueue.applyHintTitle": "确认后：保留方正文追加已否决注记，另一方归档",
    // #603 第 3 层：列表被服务端上限截断时必须明说。徽章上的总数与列表行数
    // 不一致、却没有任何提示，是最容易让人以为「就这些了」的假成功。
    "memory.status.conflictQueue.truncated": "已显示 {shown}/{total}（按相似度从高到低，其余请先处理上面的）",
        "memory.status.workbench": "工作动态",
        "memory.status.dreamConsolidate": "记忆巩固",
        "memory.status.summarize": "总结提炼",
        "memory.status.tokens": "{n} tokens",
        "memory.status.deposited": "沉淀 {n} 条记忆",
        "memory.status.failed": "失败",
        "memory.status.success": "成功",
        "memory.status.skipped": "跳过",
        "memory.status.emptyFeed": "还没有后台活动：对话结束后会自动提炼记忆",
        "memory.status.consolidated": "沉淀的记忆",
        "memory.status.consolidatedEmpty": "autoDream / autoSummarize 沉淀的记忆会出现在这里",
        "memory.status.archivedMemories": "已归档的记忆",
        "memory.status.heatDistribution": "热度分布",
        "memory.status.heat.hot": "热门（≥66%）",
        "memory.status.heat.warm": "温热（33–66%）",
        "memory.status.heat.cold": "冷却（<33%）",
        "memory.status.heat.sample": "按最近 {sample} 条采样",
        "memory.status.recallStats": "记忆复用",
        "memory.status.recall.zombie": "僵尸记忆",
        "memory.status.recall.exempt": "豁免",
        "memory.status.recall.runs": "30 天回执",
        "memory.status.recall.top": "常被召回",
        "memory.status.recall.inject": "注入",
        "memory.status.recall.archive": "归档",
        "memory.status.recallInject": "{runs} 轮 · {count} 条 · 槽位 {fill}%",
        "memory.status.recallArchive": "{total} 行 · +{add}/天 · 可压掉 {compress}",
        "memory.status.viewAll": "查看全部",
        "memory.status.depositedCount": "沉淀的记忆（{n}）",
        "memory.status.archivedCount": "已归档的记忆（{n}）",
        "memory.status.archivedEmpty": "没有归档的记忆",
        "memory.status.restore": "恢复",
        "memory.settings.extapi.reveal": "显示",
        "memory.settings.extapi.hide": "隐藏",
        "memory.settings.extapi.maskHint": "Token 已遮蔽；「复制」可复制完整值",
        "memory.explorer.delete": "删除",
        "memory.explorer.confirmDelete": "确认删除?",
        "memory.explorer.cancel": "取消",
        "memory.explorer.deleted": "已删除",
        "memory.explorer.deleteFailed": "删除失败",
        "memory.status.memories": "记忆总数",
        "memory.status.entities": "实体",
        "memory.status.vector": "向量索引",
        "memory.status.vectorOff": "未启用",
        "memory.status.vectorInit": "初始化中",
        "memory.status.vectorInitHint": "embedder 不可达，正在重试",
        "memory.status.vectorRuntimeMissing": "缺少本地推理运行时",
        "memory.status.vectorRuntimeHint": "本地推理运行时未就绪（{status}）",
        "memory.status.vectorRuntimeCost": "本地向量化需要额外一份本地推理运行时（解包后数百 MB）。下面的按钮会优先收编本机已有的那份（同盘硬链接、不占额外空间），没有再从 npm 下载并逐个校验。也可以让 Agent 代劳，或在终端自己跑：node scripts/mneme-runtime.mjs status / adopt / verify（见 docs/LOCAL_MODEL.md）",
        "memory.runtime.title": "本地推理运行时",
        "memory.runtime.available": "已就绪",
        "memory.runtime.missing": "未就绪 —— 只有用本地嵌入（embedProvider: local）时才需要它",
        "memory.runtime.restart": "本地嵌入要重启 DSH 才会生效",
        "memory.status.vectorRuntimeReady": "运行时已就绪",
        "memory.status.vectorRuntimeReadyHint": "本地嵌入尚未初始化（进程里的 embedder 在运行时缺失时已经失败过一次）：若一直停在这里，重启 DSH 即可。",
        "memory.status.vectorRuntimeFetch": "取回本地运行时",
        "memory.status.vectorRuntimeFetchBusy": "正在取回…（先试收编，必要时下载，数千个文件，请稍候）",
        "memory.status.vectorRuntimeFetchAdopted": "已收编本机已有的运行时：{n} 个包 / {m} 个文件（{mode}）。**请重启 DSH 使本地嵌入生效。**",
        "memory.status.vectorRuntimeFetchDownloaded": "下载完成：{n} 个包 / {m} 个文件。**请重启 DSH 使本地嵌入生效**（取回不会让当前进程里的 embedder 复活）。",
        "memory.status.vectorRuntimeFetchFailed": "取回失败：{reason}",
        "memory.status.vectorIndexed": "已索引 {n} / {m} 条",
        "memory.status.vectorBackfillRunning": "回填中：本轮上限 {m} 条",
        "memory.status.vectorBackfillDrained": "回填完成：本次启动补了 {n} 条",
        "memory.status.vectorBackfillCapped": "回填暂停：本轮额度用完（上限 {m} 条），会继续排下一轮",
        "memory.status.vectorBackfillStalled": "回填卡住：{f} 条嵌不进去，下次启动再试",
        "memory.status.vectorBackfillError": "回填失败：{e}",
      "memory.status.vectorUnconfigured": "未配置",
      "memory.status.vectorUnconfiguredHint": "未填 embedding 端点/模型或未启用，语义召回不可用",
      "memory.status.vectorDegradedHint": "已索引 0 / {m} 条，语义召回实际不可用",
        "memory.status.mirror": "Markdown 镜像",
        "memory.status.mirror.ok": "正常",
        "memory.status.mirror.degraded": "降级",
        "memory.status.mirror.unknown": "未知",
        "memory.status.mirror.dirty": "有未落盘改动",
        "memory.status.mirror.yes": "是",
        "memory.status.mirror.lastError": "最近错误",
        "memory.status.mirror.err.noSpace": "磁盘空间不足",
        "memory.status.mirror.err.permission": "权限不足",
        "memory.status.mirror.err.syncFailed": "同步失败",
        "memory.status.mirror.lastAttempt": "上次尝试",
        "memory.status.mirror.successAt": "上次成功",
        "memory.status.mirror.foot": "记忆条目在磁盘上的 Markdown 副本同步状态",
        "memory.status.capacity": "库体积",
        "memory.status.capacity.unknown": "未知",
        "memory.status.capacity.unknownFoot": "容量读数拿不到（面板请求失败，或宿主版本还没有这块）",
        "memory.status.capacity.active": "活跃条目",
        "memory.status.capacity.archived": "归档条目",
        "memory.status.capacity.reclaimable": "可回收（空闲页）",
        "memory.status.capacity.check.dbSize": "库体积过线",
        "memory.status.capacity.check.archivedRows": "归档条数过线",
        "memory.status.capacity.check.archivedRatio": "归档占比过线",
        "memory.status.capacity.foot": "三道预警线（体积 / 归档条数 / 归档占比）都可在设置里调；超限先跑维护卡的无损回收，真删由人确认",
        "memory.status.sec.overview": "库内一览",
        "memory.status.sec.engine": "后台运转",
        "memory.status.sec.maintenance": "维护",
        "memory.status.maint": "存储回收",
        "memory.status.maint.freelist": "空闲页可立刻回收",
        "memory.status.maint.plannedInputs": "待清理输入快照",
        "memory.status.maint.plannedEmbeddings": "待清理归档向量",
        "memory.status.maint.window": "保留窗口",
        "memory.status.maint.windowUnit": "天",
        "memory.status.maint.windowLabel": "保留窗口（天）",
        "memory.status.maint.reestimate": "重新估算",
        "memory.status.maint.reestimating": "估算中…",
        "memory.status.maint.stale": "窗口已改动：先点「重新估算」再执行，否则执行的是上一次估算的数字。",
        "memory.status.maint.vacuum": "同时 VACUUM",
        "memory.status.maint.vacuumHint": "VACUUM 会短暂独占数据库，期间其它读写要等待；不做也不影响清理结果。",
        "memory.status.maint.execute": "执行回收",
        "memory.status.maint.confirm": "确认执行（不可逆）",
        "memory.status.maint.running": "执行中…",
        "memory.status.maint.cancel": "取消",
        "memory.status.maint.confirmHint": "将清理 {inputs} 行输入快照与 {embeddings} 行归档向量，且不可逆。",
        "memory.status.maint.badWindow": "保留窗口要填不小于 0 的整数",
        "memory.status.maint.failed": "回收失败",
        "memory.status.maint.done": "回收已完成",
        "memory.status.maint.size": "体积（前 → 后）",
        "memory.status.maint.reclaimed": "实际释放",
        "memory.status.maint.clearedInputs": "已清理输入快照",
        "memory.status.maint.clearedEmbeddings": "已清理归档向量",
        "memory.status.maint.receipt": "审计回执",
        "memory.status.maint.receiptNone": "未记录（审计未启用或回执写入失败）",
        "memory.status.maint.duration": "耗时",
        "memory.status.maint.vacuumRan": "VACUUM 已执行",
        "memory.status.maint.vacuumOff": "未 VACUUM",
        "memory.status.maint.vacuumFailed": "VACUUM 失败",
        "memory.status.maint.vacuumFailedHint": "清理已完成且不可逆，但文件暂时不会变小；稍后重跑即可（清理是幂等的）。",
        "memory.status.sec.token": "Token 去向 · 近 7 天",
        "memory.status.token.in": "输入",
        "memory.status.token.out": "输出",
        "memory.status.token.total": "7 天 token 总量",
        "memory.status.token.calls": "调用次数",
        "memory.status.token.callsCap": "近 7 天 · 全部后台组件",
        "memory.status.token.share": "巩固占比",
        "memory.status.token.shareFoot": "dream_consolidate · {n} token",
        "memory.status.token.conflicts": "待确认冲突",
        "memory.status.token.conflictsFoot": "来自 /dream-status · 实时",
        "memory.status.token.donut": "按组件 · 谁花了这些 token",
        "memory.status.token.days": "按天 · 7 天趋势",
        "memory.status.token.heat": "8 周热力 · 每天花了多少",
        "memory.status.token.heatLess": "少",
        "memory.status.token.heatMore": "多",
        "memory.status.token.sink": "8 周沉淀 · 进来的 vs 稳住的",
        "memory.status.token.sinkAdded": "新增",
        "memory.status.token.sinkMerged": "巩固",
        "memory.status.token.sinkArchived": "归档",
        "memory.status.token.sinkGap": "巩固/新增",
        "memory.status.token.sinkEmpty": "最近还没有记录",
        "memory.status.token.sinkFoot": "巩固按去重记录数计，同一条被多轮合并只算一次",
        "memory.status.token.last7": "近 7 天",
        "memory.status.token.meterOnly": "（只计量）",
        "memory.status.token.detail": "详细状态卡（原「库内一览 / 后台运转」9 张，点击展开）",
        "memory.status.token.op.dream_consolidate": "记忆巩固",
        "memory.status.token.op.summarize_compress": "会话蒸馏",
        "memory.status.token.op.entity_extract": "实体抽取",
        "memory.status.token.op.dream_summarize": "总览摘要",
        "memory.status.token.op.sleep_pattern": "睡眠模式",
        "memory.status.token.op.write_admission": "写入准入",
        "memory.status.error": "加载失败",
      },
      en: {
        "memory.panel.empty": "No memories yet",
        "memory.panel.open": "Memory",
        "wiki.panel.open": "Repo Atlas",
        "wiki.rebuild": "Rebuild skeleton",
        "wiki.rebuilding": "Rebuilding…",
        "wiki.rebuild.done": "Rebuilt",
        "wiki.rebuild.failed": "Rebuild failed",
        "wiki.rebuild.hint": "Re-runs the deterministic T0 skeleton (seconds). T1 semantic prose uses the \"Enrich prose (T1)\" button next to it (long job, polls progress). Rebuilding drops enriched pages back to skeleton — re-run T1 after",
        "wiki.rebuild.modules": "modules",
        "wiki.rebuild.pages": "pages",
        "wiki.empty.noRepo": "This is the mneme plugin's \"Repo Atlas\": it turns a repository's code structure into browsable module pages. No repository is registered yet — put the repository directory's absolute path below and press \"Generate skeleton\" to build and register it. You can also run it from a terminal (the command is not on PATH, so give the absolute path):",
        "wiki.empty.disabled": "chorography (Repo Atlas) is disabled. It belongs to this plugin (memory store): enable Settings → Mneme settings → Features → When it gets written → Repo atlas (chorography), then restart DSH.",
        "wiki.empty.noRepo.where": "The repo atlas belongs to this plugin (memory store). The switch lives under Settings → Mneme settings → Features → When it gets written → Repo atlas (chorography); restart DSH after turning it on.",
        "wiki.empty.copy": "Copy command",
        "wiki.empty.copied": "Copied",
        "wiki.empty.copyFailed": "Copy failed — select the command text manually.",
        "wiki.empty.pickRepo": "Multiple repositories registered — pick one:",
        "wiki.empty.generate": "Generate skeleton",
        "wiki.empty.generating": "Generating…",
        "wiki.empty.pathPlaceholder": "Absolute path of the repository, e.g. D:\\code\\my-repo",
        "wiki.empty.cliSummary": "Or generate from a terminal (optional)",
        "wiki.empty.cliCmd": "node \"<profile>/node_modules/@modusensus/dsh-mneme/bin/dsh-mneme-choro.mjs\" \"<repo-path>\" --apply",
        "wiki.empty.cliHint": "The command takes the path as an argument — there is no need to cd into the repository first. <profile> is the DSH profile directory.",
        "wiki.flag.autoRefresh": "Auto-refresh",
        "wiki.flag.t1FromPanel": "Allow T1 from panel",
        "wiki.flag.saveFailed": "Could not save the switch",
        "wiki.t1": "Enrich prose (T1)",
        "wiki.t1.running": "T1 running…",
        "wiki.t1.done": "T1 prose enrichment finished",
        "wiki.t1.failed": "T1 failed",
        "wiki.t1.disabled": "Starting T1 from the panel is turned off: open Settings → Memory (mneme) → Features → Repo Atlas and enable \"Allow T1 from panel\".",
        "wiki.t1.progress": "done",
        "wiki.t1.modules": "modules",
        "wiki.t1.failedCount": "failed",
        "wiki.stale": "Code changed",
        "wiki.stale.hint": "The repository's code changed since the last run, so these pages may be out of date — press \"Rebuild skeleton\" to refresh.",
        "wiki.run.pathRequired": "Enter the repository's absolute path first",
        "wiki.run.failed": "Generate failed",
        "wiki.run.notAbsolute": "Give an absolute path (for example /home/me/code/my-repo): relative paths resolve against the server process's working directory, so the same request can land somewhere else depending on how the host was started.",
"wiki.run.notFound": "That path does not exist, or it is not a directory. Check the spelling.",
"wiki.run.notGit": "That directory is not a git repository, so it was not registered: the Repo Atlas derives module structure from git commits and the tracked file tree, and a non-git directory has no baseline to compare against. Point at the repository root (the directory containing .git), or run git init there first.",
        "wiki.search.placeholder": "Search pages…",
        "wiki.state.loading": "Loading…",
        "wiki.state.pickPage": "Pick a module page from the tree.",
        "wiki.state.pageMissing": "The index is there but the page file is missing. Use the “Rebuild” button in the top bar to regenerate it — no need to leave this panel.",
        "wiki.state.unavailable": "chorography queries are unavailable (host wiring missing).",
        "wiki.state.error": "Failed to load",
        "wiki.tree.title": "Modules",
        "kb.panel.open": "Knowledge Base",
        "kb.search": "Search",
        "kb.col.intro": "The knowledge base is an mneme plugin feature: it chunks and indexes external material (local files / web pages / Repo Atlas pages) so recall and injection can use it.",
        "kb.empty.disabled": "The knowledge base is disabled: open Settings → Memory (mneme) → Features → Knowledge base, turn it on, then restart DSH to apply.",
        "kb.empty.unavailable": "The knowledge base backend is unavailable: the host has not wired the kb module yet — restart DSH or update the plugin and try again.",
        "kb.empty.collections": "No collections yet. Create one on the left (say \"Project docs\"), then add local files, web pages or atlas pages; ingested text gets chunked and indexed.",
        "kb.empty.docs": "This collection has no documents yet: pick a source type on the right, fill in a path or URL, then press \"Ingest\".",
        "kb.col.title": "Collections",
        "kb.col.key": "Collection key (letters/digits/dashes; the address used for ingest and search)",
        "kb.col.name": "Collection title (optional)",
        "kb.col.create": "New collection",
        "kb.col.delete": "Delete collection",
        "kb.col.deleteConfirm": "Click again to confirm delete",
        "kb.col.docs": "docs",
        "kb.col.chunks": "chunks",
        "kb.doc.title": "Documents",
        "kb.doc.kind": "Source type",
        "kb.doc.kind.file": "Local path",
        "kb.doc.kind.url": "Web URL",
        "kb.doc.kind.choro": "From Repo Atlas",
        "kb.doc.source": "Absolute local path or web URL",
        "kb.doc.titleField": "Title (optional; defaults to the file name or URL)",
        "kb.doc.ingest": "Ingest",
        "kb.doc.ingesting": "Ingesting…",
        "kb.doc.done": "Ingested",
        "kb.doc.skipped": "Unchanged content — skipped (idempotent)",
        "kb.doc.failed": "Ingest failed",
        "kb.doc.empty": "—",
        "kb.repo.pick": "Repository",
        "kb.repo.module": "Module page",
        "kb.repo.pickFirst": "Pick a repository above first",
        "kb.repo.none": "No repository registered yet: generate one on the Repo Atlas page first, then come back to import.",
        "kb.repo.noPath": "This repository's root path is unavailable (the backend did not return rootPath), so the atlas page's absolute path cannot be composed.",
        "kb.repo.noRelPath": "This module has no skeleton page yet (the backend did not return relPath). Generate it on the Repo Atlas page first, then import.",
        "kb.repos.title": "Repositories: click one to organize its Atlas pages into the current collection",
        "kb.repos.empty": "No repository registered yet: generate one on the Repo Atlas page first, then come back to organize.",
        "kb.repos.modules": "modules",
        "kb.repos.pages": "pages",
        "kb.repos.organized": "organized",
        "kb.repos.run": "Organize into this collection",
        "kb.repos.running": "Organizing…",
        "kb.repos.needCollection": "Create a collection on the left first — ingesting needs somewhere to land.",
        "kb.repos.done": "Organize finished",
        "kb.repos.new": "new",
        "kb.repos.same": "unchanged",
        "kb.repos.failedN": "failed",
        "kb.repos.nopages": "This repository has no Atlas pages yet: generate its skeleton on the Repo Atlas page first, then come back to organize.",
        "kb.advanced": "Advanced: manual ingest / single page",
        "kb.load.failed": "Failed to load",
        "memory.tab.all": "All",
        "memory.tab.preference": "Preferences",
        "memory.tab.project": "Projects",
        "memory.tab.decision": "Decisions",
        "memory.tab.history": "History",
        "memory.tab.summary": "Summaries",
        "memory.settings.title": "Memory Settings",
        "memory.settings.group.personal": "Personalization",
        "memory.settings.group.engine": "Memory engine",
        "memory.settings.group.search": "Search",
        "memory.settings.group.connect": "Connections & safety",
        "memory.settings.group.help": "Help",
        "memory.settings.toc.label": "Contents",
        "memory.settings.toc.aria": "Settings section index",
        "memory.settings.toc.jump": "Jump to {name}",
        "memory.settings.profile": "User Profile",
        "memory.settings.profileHint": "Describe yourself once — the agent reads it every turn.",
        "memory.settings.profileSave": "Save Profile",
        "memory.settings.profileSaved": "Profile saved",
        "memory.settings.profileExtract": "Draft from memory",
        "memory.settings.profileExtracting": "Extracting…",
        "memory.settings.profileExtractHint": "Costs one model call, and only when you press this button. The result is a draft copy shown here only — it is never written to the memory store and never touches the User Profile you wrote yourself. Press “Copy draft” to keep it.",
        "memory.settings.profileExtractDisabled": "Nothing extracted: the “Profile draft from memory” feature switch is still off.",
        "memory.settings.profileExtractEmpty": "No usable memory entries in the store, so there was nothing to draft from (writing a profile out of an empty input would only be invention).",
        "memory.settings.profileExtractNoRoute": "No model available: pick a default model in the host (or set dreamProvider / dreamModel), then try again.",
        "memory.settings.profileSaveFailed": "Profile was not saved",
        "memory.settings.profileExtractFailed": "Extraction failed: the model did not return the required shape, or the call errored. Your existing profile is untouched.",
        "memory.settings.profileDraftTitle": "Draft copy (never saved automatically)",
        "memory.settings.profileDraftRows": "Based on entries",
        "memory.status.entitiesSampled": "Per-type counts cover the newest 500 entities only; the total is the whole library",
        "memory.status.entitiesUnknown": "Total unavailable; the counts below cover the newest 500 entities",
        "memory.settings.profileDraftTruncated": "many entries — only the first batch was read",
        "memory.settings.profileDraftCopy": "Copy draft",
        "memory.settings.profileDraftCopied": "Copied",
        "memory.settings.profileDraftCopyHint": "The User Profile field is yours to write; to keep this text, paste it there and save it yourself.",
        "memory.settings.profileDraftCopyFailed": "Copy failed: select the draft above and copy it manually.",
        "memory.settings.profileDraftDiscard": "Discard draft",
        "memory.settings.personaNamePlaceholder": "e.g. Nyx",
        "memory.settings.personaPersonalityPlaceholder": "e.g. relaxed and humorous; use analogies for hard topics",
        "memory.settings.personaReplyStylePlaceholder": "e.g. conclusion first; plain words over jargon",
        "memory.settings.personaDefaultCard": "Default (fallback)",
        "memory.persona.title": "Persona",
        "memory.persona.hint": "One card per identity. Each card carries a name, personality, reply style, scenario and example dialogue. Once saved, that identity speaks from it — and writes its diary in that voice too: the diary page is split by identity because this is where those partitions live.",
        "memory.persona.strictBefore": "Strict addressing is on, and there are no cards yet — everyone uses the default card for now. The first card you create flips the rule: sessions without a card stop receiving a persona, including this one. Create cards for the identities you want to keep. Subagents inherit their parent session's card, so they need none of their own.",
        "memory.persona.strictAfter": "Strict addressing is in effect: only sessions with a card receive a persona; every other session, including this one, gets none. A subagent without its own card inherits its parent session's.",
        "memory.persona.cards": "Identity cards",
        "memory.persona.defaultCard": "Default (fallback)",
        "memory.persona.newPlaceholder": "New identity, e.g. nyx",
        "memory.persona.add": "Add identity card",
        "memory.persona.delete": "Delete this card",
        "memory.persona.enabled": "Enable this card",
        "memory.persona.enabledOn": "On — this identity speaks and writes its diary from this card",
        "memory.persona.enabledOff": "Off — this identity falls back to the default card (no persona at all under strict addressing)",
        "memory.persona.name": "Name",
        "memory.persona.personality": "Personality",
        "memory.persona.replyStyle": "Reply style",
        "memory.persona.scenario": "Scenario (optional)",
        "memory.persona.scenarioPlaceholder": "When this identity shows up, and to whom",
        "memory.persona.mesExample": "Example dialogue (optional)",
        "memory.persona.mesExamplePlaceholder": "One or two turns; the surest way to pin the voice",
        "memory.persona.save": "Save persona card",
        "memory.persona.saved": "Saved",
        "memory.persona.saveFailed": "Save failed",
        "memory.persona.preview": "Injected preview (the exact text handed to the model this turn)",
        "memory.persona.previewRefresh": "Refresh preview",
        "memory.persona.previewEmpty": "Nothing persona-shaped this turn — the card is empty, or the master switch is off.",
        "memory.persona.previewUnknown": "Could not read the preview (request failed or backend too old). Nothing is guessed here.",
        "memory.persona.diary": "This identity's diary",
        "memory.persona.diaryHint": "The diary only follows the card: writing picks the card by session identity, and falls back to the default card only when there is no identity.",
        "memory.persona.about": "Who you are, from the agent's side",
        "memory.persona.diaryCount": "{count} entries · latest {latest}",
        "memory.persona.diaryNone": "No diary yet. Write one from “their diary” on the left and it lands in this card's voice.",
        "memory.persona.readFailed": "Could not read the persona store (request failed or backend too old). Nothing is guessed here.",
        "memory.persona.loading": "Loading…",
        "memory.persona.factsLinked": "Auto facts live in the same domain as persona cards: the identity split here is the split in “you, as the agent sees you”.",
        "memory.settings.factsTitle": "Auto facts (you, as the agent sees you)",
        "memory.settings.factsHint": "What the agent learned about you, distilled from new memories after each dream run — split into cards by session identity (same domain as persona cards) and injected after your handwritten profile in the preview. Fix entries here one by one; deleting only archives a fact and can be undone. The User Profile you wrote yourself is never touched.",
        "memory.settings.factsEmpty": "No facts on this card yet. After new conversation memories go through a dream run, what the agent picked up about you shows up here; you can also add one below.",
        "memory.settings.factsUnavailable": "Could not read the facts (request failed or backend too old). Nothing is guessed here.",
        "memory.settings.factsAddPlaceholder": "e.g. The user prefers short, direct answers",
        "memory.settings.factsAdd": "Add fact",
        "memory.settings.factsRowEdit": "Edit this fact",
        "memory.settings.factsRowSave": "Save",
        "memory.settings.factsRowCancel": "Cancel",
        "memory.settings.factsRowDelete": "Delete this fact (archived, restorable)",
        "memory.settings.factsApplyDone": "Facts updated",
        "memory.settings.factsApplyError": "Not saved: the request failed. Please try again.",
        "memory.settings.factsApplyFailures": "{n} not saved",
        "memory.settings.factsApplyDups": "skipped {n} duplicates",
        "memory.settings.factsGateOff": "The “Auto facts” feature switch is off: dream runs will not maintain this list, but editing here and the manual update below keep working.",
        "memory.settings.factsRun": "Update now",
        "memory.settings.factsRunning": "Updating…",
        "memory.settings.factsRunOk": "Updated {n} facts",
        "memory.settings.factsRunNoop": "No new memories — facts are already up to date",
        "memory.settings.factsRunDisabled": "The “Auto facts” feature switch is off; turn it on in the feature switches section first.",
        "memory.settings.factsRunNoRoute": "No model available: pick a default model in the host (or set dreamProvider / dreamModel), then try again.",
        "memory.settings.factsRunFailed": "Update failed: the model did not return the required shape, or the call errored. You can retry later.",
        "memory.settings.factsJournalTitle": "Recent changes",
        "memory.settings.factsJournalEmpty": "No changes recorded yet",
        "memory.settings.factsOpAdd": "Add",
        "memory.settings.factsOpUpdate": "Edit",
        "memory.settings.factsOpArchive": "Archive",
        "memory.settings.factsActorAuto": "auto",
        "memory.settings.factsActorManual": "manual",
        "memory.settings.factsRunLast": "Last run: ",
        "memory.settings.factsRunCounts": "input {input} · applied {ops} ops",
        "memory.settings.factsRunStatusOk": "ok",
        "memory.settings.factsRunStatusNoop": "no change",
        "memory.settings.factsRunStatusFailed": "failed",
        "memory.features.personaEnabled": "Persona (beta)",
        "memory.features.personaEnabled.hint": "Inject the persona card (Settings → Personalization) into every turn. Off by default (beta); both this switch and the card's own toggle must be on.",
        "memory.features.personaStrictAddressing": "Strict persona addressing",
        "memory.features.personaStrictAddressing.hint": "On: when a session's identity has no persona card — or that card is switched off — no persona is injected, so the default card only covers sessions with no resolvable identity. Turn this on when the host runs a bot that brings its own identity (DS Bot and friends), otherwise two \"you are ...\" claims land in the same turn. Off (default): unresolved identities fall back to the default card, as before.",
        "memory.features.profileExtractEnabled": "Profile draft from memory",
        "memory.features.profileExtractEnabled.hint": "Adds the \"Draft from memory\" button to the \"You in the agent's eyes\" card under Settings → Personalization: reads a batch of active memories, spends one model call, and returns an \"as the assistant sees them\" draft. The draft is only shown there as a copy you can copy out — it is never written to the memory store and never overwrites the User Profile you wrote yourself. Off in the lightweight preset (an explicit choice still wins).",
        "memory.features.profileFactsEnabled": "Auto facts",
        "memory.features.profileFactsEnabled.hint": "After each dream (consolidation) run, the memories settled in that window are read once more to maintain a per-identity-card list of facts the agent holds about you (Settings → Personalization → Auto facts), injected after the handwritten profile. Facts live in their own tables and never overwrite the User Profile you wrote yourself; any fact can be fixed or removed in the panel (removing = archiving, restorable). Off in the lightweight preset (an explicit choice still wins).",
        "memory.features.chorographyEnabled": "Repo atlas (chorography)",
        "memory.features.chorographyEnabled.hint": "Reads a repository once and writes it up as a paginated atlas: the deterministic skeleton costs no model and can be rebuilt any time; the semantic sections are added per module by a headless session in the CLI. Turning it on enables four entry points — three read-only tools for the model, the atlas panel page, the per-turn outline injection, and the /choro command. With it off none of them exist (the tools are absent from the model's tool list, the injection block is not rendered, neither /choro nor the sidebar entry is registered). Off by default.",
        "memory.features.chorographyInject": "Opening injection tier",
        "memory.features.chorographyInject.hint": "How much of the atlas outline goes into context every turn: light lists the six modules with the most files (about 8 lines), full lists every module, off injects nothing (tools and the panel page still work). Only module name / file count / page status / page path are injected, never page bodies — the model fetches those with choro_read_page. The lightweight preset forces off.",
        "memory.features.chorographyInject.off": "off (no injection)",
        "memory.features.chorographyInject.light": "light (top 6 modules)",
        "memory.features.chorographyInject.full": "full (all modules)",
        "memory.features.chorographyAutoRefresh": "Auto-refresh",
        "memory.features.chorographyAutoRefresh.hint": "When reading atlas pages, if the repository's code changed (git baseline differs from registration time), re-run the T0 skeleton automatically instead of asking you to rebuild. Off by default: it turns a read path into a write.",
        "memory.features.chorographyT1FromPanel": "Allow T1 from panel",
        "memory.features.chorographyT1FromPanel.hint": "Lets the \"Enrich prose (T1)\" button on the Repo Atlas panel start a headless session that fills in the semantic sections module by module. On by default: it is a button a human presses, not a background behaviour. With it off the button stays but points you at the CLI.",
        "memory.features.kbEnabled": "Knowledge base",
        "memory.features.kbEnabled.hint": "Chunks and indexes external material (local files / web pages / Repo Atlas pages) for recall and injection, plus a \"Knowledge base\" panel page to manage and ingest it. Off by default.",
        "memory.features.group.kb": "Knowledge base",
        "memory.settings.rules": "Rules",
        "memory.settings.rulesHint": "Rules the agent must follow — add or remove anytime, effective next turn.",
        "memory.settings.ruleAdd": "Add Rule",
        "memory.settings.rulePlaceholder": "e.g. Always lead with a conclusion",
        "memory.settings.commands": "Custom Commands",
        "memory.settings.commandsHint": "Save prompts as slash commands and invoke them right from the composer.",
        "memory.settings.cmdName": "Name",
        "memory.settings.cmdDesc": "Description",
        "memory.settings.cmdInstruction": "Instruction",
        "memory.settings.cmdAdd": "Add Command",
        "memory.settings.cmdDelete": "Delete",
        "memory.settings.empty": "Nothing yet",
        "memory.panel.semantic": "Semantic",
        "memory.sidebar.aria": "Open memory panel",
        "memory.view.label": "Memory",
        "memory.overlay.close": "Close",
        "memory.explorer.tabMemory": "Memories",
        "memory.explorer.tabEntities": "Entities",
        "memory.explorer.tabSettings": "Settings",
        "memory.explorer.tabStatus": "Status",
        "memory.explorer.tabPersona": "Persona",
        "memory.explorer.tabAffective": "Affective",
        "memory.entities.count": "{n} entities",
      "memory.entities.countSampled": "The list shows the newest {shown} only; the total above is the whole library",
        "memory.entities.pick": "Select an entity to see its attributes and relations",
        "memory.entities.noMatch": "No entities match that search — try another word",
        "memory.entities.none": "No entities yet — turn on entity extraction and people / projects / concepts will accumulate here",
        "memory.entities.attrs": "Attributes",
        "memory.entities.relations": "Relations",
        "memory.entities.mentions": "{n} mentions",
        "memory.entities.lastSeen": "Last seen",
        "memory.entity.person": "People",
        "memory.entity.project": "Projects",
        "memory.entity.concept": "Concepts",
        "memory.entity.technology": "Technologies",
        "memory.entity.organization": "Organizations",
        "memory.entity.other": "Others",
        "memory.explorer.search": "Search title or content…",
        "memory.explorer.searchTitle": "Semantic Search",
        "memory.explorer.types": "Types",
        "memory.explorer.timeline": "Timeline",
        "memory.explorer.detail": "Details",
        "memory.explorer.emptyDetail": "Select a memory in the timeline to read it",
        "memory.explorer.copy": "Copy content",
        "memory.explorer.copied": "Copied",
        "memory.explorer.refresh": "Refresh",
        "memory.explorer.loadMore": "Load more",
        "memory.explorer.count": "{n} items",
        "memory.explorer.empty": "No memories yet",
        "memory.explorer.source": "Source",
        "memory.explorer.created": "Created",
        "memory.explorer.updated": "Updated",
        "memory.explorer.tags": "Tags",
        "memory.explorer.importance": "Importance",
        "memory.explorer.heat": "Heat",
        "memory.explorer.heatSort": "By heat",
        "memory.explorer.heatSortHint": "Sort loaded items by heat, in-page (not global; the month tree keeps chronological order)",
        "memory.explorer.filterDeposited": "Deposited",
        "memory.explorer.filterDepositedHint": "Only memories autoDream consolidated or updated",
        "memory.explorer.filterArchived": "Archived",
        "memory.explorer.filterArchivedHint": "Only archived memories (excluded from the default list)",
        "memory.explorer.topK": "Results limit",
        "memory.explorer.topKOption": "Return {n}",
        "memory.card.open": "Open full text in the memory library",
        "memory.time.now": "just now",
        "memory.time.seconds": "{n}s ago",
        "memory.time.minutes": "{n}m ago",
        "memory.time.hours": "{n}h ago",
        "memory.time.days": "{n}d ago",
        "memory.affective.title": "Affective attributions",
        "memory.affective.sub": "Grouped by who · toward what · which emotion; lasting tendencies are listed apart from single occasions.",
        "memory.affective.loading": "Loading…",
        "memory.affective.error": "Could not load — that is not the same as having nothing recorded; this request failed.",
        "memory.affective.empty": "No affective edges yet. Turn on the affective phase and let one nightly pass run.",
        "memory.affective.occasion": "Single occasion",
        "memory.affective.trait": "Lasting tendency",
        "memory.affective.sessions": "across {n} independent sessions",
        "memory.affective.evidence": "{n} pieces of evidence",
        "memory.affective.lastSeen": "last {time}",
        "memory.affective.truncated": "Showing the newest {n} edges only; older ones are not on this page",
        "memory.affective.skipped": "{n} edges carried no emotion name and were left out",
        "memory.graph.title": "Memory Graph",
        "memory.graph.aria": "Memory graph",
        "memory.graph.placeholder": "Type an entity name to see its network…",
        "memory.graph.depth": "hops",
        "memory.graph.empty": "The graph is waiting for data: entities and relations accumulate as memories are extracted",
        "memory.graph.notFound": "Entity not found",
        "memory.graph.related": "Related memories",
        "memory.graph.relation": "Relation",
        "memory.graph.sourceMemory": "View source memory",
        "memory.graph.hint": "Drag nodes to rearrange · drag the background to pan · scroll to zoom",
        "memory.graph.resetView": "Reset view",
        "memory.graph.summary": "Entity graph: {entity} with {nodes} nodes and {edges} edges",
        "memory.graph.viewInGraph": "Open in entity explorer",
        "memory.graph.loading": "Loading…",
        "memory.graph.distance": "{n} hop(s) from root",
        // issue #24 块4：被动确认的复核面。
        "memory.graph.weight": "weight {w}",
        "memory.graph.source": "via {s}",
        "memory.graph.boosted.title": "Edges put to use",
        "memory.graph.boosted.hint": "A normal touch raises an edge's weight automatically. These are the ones that rose — raising is the only action that changes what gets recalled.",
        "memory.graph.boosted.empty": "No edges match this filter (only edges already above their source baseline are listed)",
        "memory.graph.boosted.loadFailed": "Couldn't load this panel (endpoint unavailable) — that is not the same as \"no edges\". Try again later.",
        "memory.graph.boosted.gateOff": "Passive confirmation is off, so nothing more will be raised; the edges below were raised earlier.",
        "memory.graph.boosted.show": "Show edges put to use",
        "memory.graph.boosted.hide": "Hide",
        "memory.graph.boosted.gain": "+{g}",
        // 边的来源（#24 块2 的 RELATION_SOURCE_DEFAULTS）：决定权重的起点，
        // 所以复核时必须和权重一起显示，否则「0.5 比 1.0 弱」这种误读无可避免。
        "memory.graph.src.manual": "manual",
        "memory.graph.src.confirmed": "confirmed",
        "memory.graph.src.tag": "tag overlap",
        "memory.graph.src.llm": "model-extracted",
        "memory.graph.emotion": "emotion {e}",
        "memory.graph.affectiveOccasion": "this occasion",
        "memory.graph.affectiveOccasions": "{n} occasions so far",
        "memory.graph.affectiveTrait": "lasting tendency · across {n} independent occasions",
        "memory.graph.affectiveEvidence": "{n} pieces of evidence",
        "memory.graph.affectiveLegacy": "older affective edge (no occasion record)",
        "memory.settings.vectorTitle": "Vector Search",
        "memory.settings.vectorHint": "Match by meaning, not just wording — connect any OpenAI-compatible embeddings API.",
        "memory.settings.vectorEnabled": "Enable vector search",
        "memory.settings.vectorBaseUrl": "Base URL",
        "memory.settings.vectorApiKey": "API Key",
        "memory.settings.vectorModel": "Model",
        "memory.settings.vectorSave": "Save Config",
        "memory.settings.vectorSaved": "Config saved",
        "memory.settings.vectorReindex": "Reindex",
        "memory.settings.vectorReindexing": "Indexing…",
        "memory.settings.vectorReindexDone": "Indexed {n} items",
        "memory.settings.vectorReindexPartial": "Indexed {n} items, {f} failed",
        "memory.settings.vectorReindexRemaining": "Indexed {n} items, {r} still pending",
        "memory.settings.vectorReindexNothing": "Nothing to rebuild (every row already carries this model's vector)",
        "memory.settings.apiTokenTitle": "API Token (optional)",
        "memory.settings.apiTokenHint": "This field only stores the token in this browser (localStorage) for the panel requests. The server-side lock is the plugin\u0027s apiToken config — set both to the same value; this field alone locks nothing.",
        "memory.settings.apiTokenPlaceholder": "Must match the plugin\u0027s apiToken",
        "memory.settings.apiTokenSave": "Save Token",
        "memory.settings.apiTokenSaved": "Token saved",
        "memory.settings.feedback.title": "Feedback",
        "memory.settings.feedback.desc": "Something off? Tell us directly, or check if someone hit it first:",
        "memory.settings.feedback.newIssue": "Report on GitHub",
        "memory.settings.feedback.newIssue.sub": "Plugin version & environment prefilled",
        "memory.settings.feedback.email": "Email us",
        "memory.settings.feedback.email.sub": "work@modusensus.space",
        "memory.settings.feedback.browse": "Browse known issues",
        "memory.settings.feedback.browse.sub": "Check if it's already reported",
        "memory.settings.feedback.hint": "Search for an existing issue first — it saves a duplicate.",
        "memory.settings.update.check": "Check for updates",
        "memory.settings.update.latest": "Up to date ✓",
        "memory.settings.update.ahead": "Newer than the registry (local build)",
        "memory.settings.update.error": "Check failed: try again later",
        "memory.settings.version.outdated": "New version {v} available (running {c})",
        "memory.settings.version.outdatedHint": "If the plugin was installed with a pinned version, regular upgrades never cross minor/major lines — reinstall or pass --latest. A fresh npm release may take about a day to appear in the market.",
        "memory.settings.star": "Star the project",
        "memory.settings.star.sub": "If it serves you well, cheer the author on (●'◡'●)",
        "memory.settings.mode.title": "Runtime mode",
        "memory.settings.mode.desc": "Light mode keeps the core loop only: memory read/write, auto-injection and hot memory — consolidation, entity extraction and semantic search are all off. For modest machines or when you just want preferences remembered. Standard mode enables everything.",
        "memory.settings.mode.light": "Light",
        "memory.settings.mode.standard": "Standard",
        "memory.settings.mode.savedHint": "Saved. Takes effect after restarting DSH",
        "memory.settings.mode.offList": "Off: consolidation (autoDream) · entity extraction · semantic search",
        "memory.settings.mode.hostPresetHint": "Two different things: Light/Standard here is this plugin's memory engine tier; the host's minimal preset is separate — Light never disables persona.",
        "memory.status.minimalPresetTitle": "This session runs the host's minimal preset",
        "memory.status.minimalPresetBody": "The minimal preset takes over the whole system prompt, so memory, profile and persona never reach the model. That is a host design boundary the plugin cannot change. To get them back: switch DSH to standard mode (or set agent-presets.default: standard in ~/.dsh/settings.yaml); as an interim workaround put profile and rules in AGENTS.md — that path is not suppressed.",
        "memory.settings.extapi.title": "External API",
        "memory.settings.extapi.desc": "Opens a local API so other tools (plugins, CLIs, desktop apps) can also read and write this memory store; binds to localhost only by default. Changes take effect after restarting DSH.",
        "memory.settings.extapi.enabled": "Enable",
        "memory.settings.extapi.disabled": "Disable",
        "memory.settings.extapi.address": "Address",
        "memory.settings.extapi.port": "Port",
        "memory.settings.extapi.token": "Token",
        "memory.settings.extapi.copy": "Copy",
        "memory.settings.extapi.copied": "Copied",
        "memory.settings.serve.title": "Standalone service: dsh-mneme-serve",
        "memory.settings.serve.desc": "Reach the same memory library over HTTP without starting DSH (no LLM data plane).",
        "memory.settings.serve.cmd": "npx -p @modusensus/dsh-mneme dsh-mneme-serve --memory-dir <memory-dir> --port <port>",
        "memory.settings.serve.copy": "Copy",
        "memory.settings.serve.copied": "Copied",
        "memory.settings.serve.hint": "Shares routes and auth with the external API: when pointing at the same memory directory, callers should use the panel's token (expected to work, not guaranteed). Both default to the same port — enable one or offset with --port.",
        "memory.settings.mcp.title": "MCP server: dsh-mneme-mcp",
        "memory.settings.mcp.desc": "stdio MCP server: any MCP client (Claude Code, Cursor, …) mounting it gets the same six memory tools as inside DSH.",
        "memory.settings.mcp.snippet": "{ \"mcpServers\": { \"dsh-mneme\": { \"command\": \"dsh-mneme-mcp\", \"env\": { \"DSH_MNEME_TOKEN\": \"<token from External API above>\" } } } }",
        "memory.settings.mcp.copy": "Copy",
        "memory.settings.mcp.copied": "Copied",
        "memory.settings.configKeys.title": "Config key coverage",
        "memory.settings.configKeys.desc": "How many config-file keys the panel can change, and which ones are file-only. Key names only — no values are shown.",
        "memory.settings.configKeys.summary": "The schema has {schema} keys: the panel can change {panel}, {file} are file-only, and {undefaulted} are registered without a runtime default.",
        "memory.settings.configKeys.fileOnlyHead": "File-only ({n})",
        "memory.settings.configKeys.undefaultedHead": "Registered for the panel but has no runtime default ({n})",
        "memory.settings.configKeys.undefaultedHint": "These keys are on the whitelist, so the panel shows an input for them, but the schema gives no default — while unset they are absent from the effective snapshot. Set a value for them to take effect.",
        "memory.settings.configKeys.show": "Show the list",
        "memory.settings.configKeys.hide": "Hide the list",
        "memory.settings.configKeys.loadFailed": "Couldn't load this list (endpoint unavailable) — that is not the same as \"no file-only keys\".",
        "memory.settings.mcp.hint": "Data plane is the external API (default 127.0.0.1:8790, Bearer) — the token is the one above; override with DSH_MNEME_URL / DSH_MNEME_TOKEN env vars or ~/.dsh-mneme/cli.json. The command must be on PATH (installed with @modusensus/dsh-mneme).",
        "memory.settings.extapi.savedHint": "Saved. Takes effect after restarting DSH",
        "memory.settings.extapi.invalidPort": "Port must be a number between 1 and 65535",
        "memory.tab.rejected_solution": "Rejected solutions",
        "memory.tab.pitfall": "Pitfalls",
        "memory.tab.constraint": "Constraints",
        "memory.tab.document": "Documents",
        "memory.features.title": "Features",
        "memory.features.desc": "Choose what the plugin does in the background. The Common switches at the top are all you need to start; everything else lives under All settings. Changes are saved immediately and take effect after restarting DSH.",
        // Issue #427: groups used to be implementation slices (the architecture
        // diagram's partitions). What a person actually asks is four questions —
        // what gets remembered, when it gets written, how it comes back, and
        // whether sessions bleed into each other. Terminology stays in the hints.
        // group.basic is the first-screen tier; the scope group sits there too so
        // "can other sessions see this?" is answerable without opening anything.
        "memory.features.group.basic": "Common (start here)",
        "memory.features.group.core": "What gets remembered",
        "memory.features.group.mo": "Its workflow (M.O.)",
        "memory.features.group.enhance": "When it gets written",
        "memory.features.group.dream": "How it comes back",
        "memory.features.group.scope": "Between sessions",
        "memory.features.group.advanced": "Advanced",
        "memory.features.allToggle": "All settings",
        "memory.features.advancedToggle": "7 rarer switches",
        "memory.features.restartHint": "Takes effect after restarting DSH",
        "memory.features.loadFailed": "Failed to load",
        "memory.features.saveFailed": "Failed to save",
        "memory.features.autoInject": "Carry old memories into every turn",
        "memory.features.autoInject.hint": "On: relevant memories are handed to the agent every turn, so it remembers without being asked. Off: the agent has to call the search tool itself",
        "memory.features.injectGuidanceEnabled": "Also teach the agent how to use memory",
        "memory.features.injectGuidanceEnabled.hint": "On: the memory tools' description says when to search and when to write. Off: the tools ship without guidance",
        "memory.features.continuityRescueEnabled": "Snapshot before a long chat gets compacted",
        "memory.features.continuityRescueEnabled.hint": "On: a snapshot of what's in progress / next steps / open questions is stored before compaction, so key context survives it. Off: compaction can crush it",
        "memory.features.parentOff": "Inactive while the switch above is off",
        "memory.features.tagDefault": "default",
        "memory.features.tagDefault.hint": "This one is at its factory default — you have not changed it",
        "memory.features.tagChanged": "changed",
        "memory.features.tagChanged.hint": "You changed this one; it no longer uses the default",
        "memory.features.tagPending": "restart pending",
        "memory.features.tagPending.hint": "Saved, but not yet in effect for this session — restart DSH (or toggle this plugin off and on in the plugin manager) to apply it",
        "memory.features.pendingRestartNotice": "Some changes are not in effect yet: switches marked \"restart pending\" apply only after you restart DSH (toggling this plugin off and on in the plugin manager works too).",
        "memory.features.autoSummarize": "Turn conversations into memory automatically",
        "memory.features.autoSummarize.hint": "On: memory entries are distilled when a conversation ends (autoSummarize). Off: memory only exists if you save it, or the agent decides to",
        "memory.features.hotMemoryEnabled": "Carry the last few turns verbatim",
        "memory.features.hotMemoryEnabled.hint": "On: the recent turns ride along with each injection, so the agent sees what was just said. Off: only distilled memories travel. Those turns are never written to long-term memory (hot memory, on by default)",
        "memory.features.injectTimePrefix": "Tell it today's date at session start",
        "memory.features.injectTimePrefix.hint": "On: the first turn of each new session gets the date and weekday once, so \"today\" and \"last week\" land reliably. Off: no time in the injection (time prefix, off by default)",
        "memory.features.entityExtractionEnabled": "Also pull out people, projects and concepts",
        "memory.features.entityExtractionEnabled.hint": "On: each new memory yields people / projects / concepts, so the relation graph grows by itself and recall can key on who. Off: memories stay whole, no relations (entity extraction, off by default)",
        "memory.features.entityExtractionProvider": "Entity extraction provider",
        "memory.features.entityExtractionModel": "Entity extraction model",
        "memory.features.entityExtractionReasoning": "Entity extraction reasoning",
        "memory.features.entityExtractionReasoning.none": "Follow default",
        "memory.features.entityExtractionReasoning.low": "Low",
        "memory.features.entityExtractionReasoning.medium": "Medium",
        "memory.features.entityExtractionReasoning.high": "High",
        "memory.features.summarizeReasoningEffort": "Distill reasoning effort",
        "memory.features.summarizeReasoningEffort.off": "No reasoning",
        "memory.features.summarizeReasoningEffort.none": "Follow default",
        "memory.features.summarizeReasoningEffort.low": "Low",
        "memory.features.summarizeReasoningEffort.medium": "Medium",
        "memory.features.summarizeReasoningEffort.high": "High",
        "memory.features.summarizeReasoningEffort.hint": "For thinking models, prefer Low or No reasoning so thinking cannot fill the output budget and break summaries",
        "memory.features.entityExtractionModelHint": "Provider / model empty = follow the main conversation model; reasoning \"Follow default\" = provider default",
        "memory.features.codingRetrospect": "Remember how the code was written too",
        "memory.features.codingRetrospect.hint": "On: the whole coding session (errors and tool calls included) is reviewed, yielding pitfalls, constraints and rejected solutions. Off: only conversation content is distilled (coding retrospection, off by default)",
        "memory.features.rerankEnabled": "Rerank search results once more",
        "memory.features.rerankEnabled.hint": "On: a local rerank model re-scores recalled candidates — more precise, slower. Off: the search-time order stands (reranking, off by default)",
        "memory.features.heatEnabled": "The longer unused, the lower it ranks",
        "memory.features.heatEnabled.hint": "On: memories cool down like a forgetting curve — long-unused ones rank later and stop taking injection slots. Off: relevance order always (heat decay, off by default)",
        "memory.features.documentMemoryEnabled": "Store long documents as a summary card",
        "memory.features.documentMemoryEnabled.hint": "On: long agent-authored documents live in memory as a \"summary card\"; the full text stays agent-owned and is read on demand. Off: the whole document travels into context (document memory, off by default)",
        // --- v0.9.0 M.O. / Modus Operandi (beta) ---
        "memory.actions.beta": "Beta",
        "memory.actions.notice": "Extracted steps are candidates: they may be wrong, outdated, or refuted.",
        "memory.actions.title": "Modus Operandi",
        "memory.actions.open": "Open Modus Operandi",
        "memory.actions.viewFull": "Full view",
        "memory.actions.openPane": "Open full view in sidebar",
        "memory.actions.announce.open": "Modus Operandi panel opened",
        "memory.actions.announce.close": "Modus Operandi panel closed",
        "memory.actions.close": "Close",
        "memory.actions.candidates": "{n} candidates",
        "memory.actions.runs": "Recent runs",
        "memory.actions.runOf": "Run {n}",
        "memory.actions.run.ok": "ok",
        "memory.actions.run.failed": "failed",
        "memory.actions.run.refuted": "refuted",
        "memory.actions.state.candidate": "candidate",
        "memory.actions.state.trusted": "trusted",
        "memory.actions.state.stale": "stale",
        "memory.actions.state.refuted": "refuted",
        "memory.actions.gate.has": "has counterfactual",
        "memory.actions.gate.none": "no gate yet",
        "memory.actions.gate.tag": "GATE",
        "memory.actions.who.main": "main",
        "memory.actions.who.human": "human",
        "memory.actions.who.ci": "CI",
        "memory.actions.ov.done": "Done when",
        "memory.actions.ov.trigger": "Triggered by",
        "memory.actions.band.count": "{n} steps",
        "memory.actions.legend.states": "States",
        "memory.actions.detail.situation": "Situation",
        "memory.actions.detail.action": "Action",
        "memory.actions.detail.why": "Why",
        "memory.actions.detail.cf": "Counterfactual",
        "memory.actions.detail.noCf": "No counterfactual recorded yet",
        "memory.actions.detail.source": "Source memories",
        "memory.actions.credit": "Reuse",
        "memory.actions.creditValue": "{n} uses · last {d}d ago",
        "memory.actions.dep": "depends on",
        "memory.actions.zoom.value": "Zoom {n}%",
        "memory.actions.zoom.in": "Zoom in",
        "memory.actions.zoom.out": "Zoom out",
        "memory.actions.zoom.fit": "Fit width",
        "memory.actions.zoom.hint": "Ctrl/⌘ + wheel also zooms",
        "memory.actions.list.heading": "Workflows in this project",
        "memory.actions.list.count": "{n} workflow(s)",
        "memory.actions.list.meta": "{steps} steps · {gates} gates · counterfactual {cf}/{steps}",
        "memory.actions.scope.project": "project {name}",
        "memory.actions.scope.global": "global",
        "memory.actions.scope.none": "project unknown",
        "memory.actions.broken": "Some files could not be read:",
        "memory.actions.empty.title": "No workflows in this project yet",
        "memory.actions.empty.body": "A workflow lives in the project, under .mneme/pipelines/ — it travels with the repository: committable, reviewable, readable by CI. A practice becomes a node type on its second reuse; the first run is just an instance. Once the same path has been walked twice it gets distilled out of the session and lands in that directory.",
        "memory.actions.distill.action": "Distill now",
        "memory.actions.distill.busy": "Reading sessions…",
        "memory.actions.distill.hint": "Scan this project's own session logs and mine repeated actions into proposals. Writes proposals only — no drafts, no repository changes.",
        "memory.actions.distill.noProject": "The session's working directory is unknown, so there is no project to scan",
        "memory.actions.distill.saved": "{n} proposal(s) written ({m} candidate(s) mined this pass)",
        "memory.actions.distill.none": "No new repeated action this pass",
        "memory.actions.distill.noSessions": "This project has no session logs of its own yet — come back after a few turns",
        "memory.actions.distill.unreadable": "The session logs could not be read (an environment problem, not an empty result)",
        "memory.actions.distill.failed": "This pass did not finish; see the plugin log",
        "memory.actions.noRuns": "No runs recorded for this workflow yet, so every step is still a candidate.",
        "memory.actions.settle.title": "This run",
        "memory.actions.settle.line": "\"{title}\"",
        "memory.actions.settle.used": "Reused {n} steps this run (checked = actually used)",
        "memory.actions.settle.refutedWarn": "This path contains refuted steps; take the result with caution",
        "memory.features.actionPipelineEnabled": "M.O. (beta)",
        "memory.features.actionPipelineEnabled.hint": "Read-only view: the ways of working that actually got walked through in real sessions, drawn as a graph — session-header icon, full sidebar view, and a per-run settlement card. Viewing is not writing: distillation has its own switch below, and run accounting has its own (/mo-run). Modus Operandi. Takes effect after restarting DSH",
        "memory.features.actionNudgeEnabled": "Auto-distill workflows (beta)",
        "memory.features.actionNudgeEnabled.hint": "On: after each turn, look at this project's own session logs and mine the actions it keeps repeating into a proposal in the memory store — it still needs your sign-off before becoming a workflow. Drafts only; never auto-activates; never writes files into the repo. Hooks a hot path and decompresses logs, so light mode forces it off. Takes effect after restarting DSH",
        "memory.features.diaryEnabled": "Diary (beta)",
        "memory.features.diaryEnabled.hint": "On: a Diary tab appears in the right sidebar, and the agent that carries a persona writes one entry a day from what actually happened in this project — no conversation that day, no entry, and nothing made up. Entries live in the memory directory; only the “Save into this project” button copies one into the repo. Light mode forces it off. Takes effect after restarting DSH",
        "memory.features.diaryWriteEveryMinutes": "Auto-write every N minutes (0 = off)",
        "memory.features.diaryWriteEveryMinutes.hint": "When off, DSH only checks whether today needs an entry at turn end and at startup — stay quiet all day and nothing gets written. Put a number here (e.g. 60) and it wakes up on its own. Still at most one entry a day: whether to write is decided by whether today's file exists on disk",
        "memory.diary.title": "Diary",
        "memory.diary.note": "Written from what actually happened in this project: no conversation, no entry, nothing invented.",
        "memory.diary.write": "Write today",
        "memory.diary.writing": "Writing…",
        "memory.diary.export": "Save into this project",
        "memory.diary.exporting": "Saving…",
        "memory.diary.loading": "Loading…",
        "memory.diary.noProject": "This session has no project directory",
        "memory.diary.noProjectHint": "The session has no working directory yet, so there is nowhere to write a diary to. Open this in a session that has one.",
        "memory.diary.noProjectRoot": "This notebook has no known project folder, so it cannot be written",
        "memory.diary.disabled": "The diary is off",
        "memory.diary.disabledHint": "Turn on Diary under Settings › Enhance, then restart DSH — the entry becomes available after that.",
        "memory.diary.unavailable": "The diary service is not wired up",
        "memory.diary.readFailed": "Could not read the diary",
        "memory.diary.retry": "Retry",
        "memory.diary.empty": "No diary entries for this project yet",
        "memory.diary.emptyHint": "Press “Write today”: it writes one entry from what this session actually said today, and writes nothing if there was no conversation.",
"memory.diary.libraryEmpty": "No diaries yet",
"memory.diary.libraryEmptyHint": "Diaries are kept one per agent under the memory library's diaries folder. The first entry written makes its name appear here.",
        "memory.diary.pickHint": "Pick a day on the left, read the entry on the right.",
        "memory.diary.bookLabel": "Paper and type",
        "memory.diary.book.plain": "Plain",
        "memory.diary.book.ruled": "Ruled",
        "memory.diary.book.grid": "Grid",
        "memory.diary.book.kraft": "Kraft",
        "memory.diary.count": "{n} entries",
        "memory.diary.writtenOk": "Written: {path}",
  "memory.diary.exportOk": "Saved to {path}",
        "memory.diary.exportExists": "That file is already in the project; nothing was overwritten",
        "memory.diary.exportFailed": "Could not save it",
        "memory.diary.composeFailed": "Nothing was written this time",
        "memory.diary.skip.already": "Today's entry already exists, so nothing was written twice.",
        "memory.diary.skip.noMaterial": "No usable conversation material in this project today, so nothing was written.",
        "memory.diary.skip.other": "Nothing was written this round.",
        "memory.diary.auditTitle": "Recent runs",
        "memory.diary.status.written": "written",
        "memory.diary.status.skipped": "skipped",
        "memory.diary.status.failed": "failed",
        "memory.features.resilientModelDownload": "Model downloads resume after interruption",
        "memory.features.resilientModelDownload.hint": "On: downloads continue from where they stopped and retry automatically. Off: an interrupted download starts over (resumable downloads, on by default)",
        "memory.features.searchSemanticDedup": "Keep one entry when search hits near-duplicates",
        "memory.features.searchSemanticDedup.hint": "On: near-duplicate entries merge into one, saving injection slots. Off: duplicates all show up (semantic dedup, off by default)",
        "memory.features.autoDream": "Tidy memories in the background (merge · dedupe)",
        "memory.features.autoDream.hint": "On: fragmented memories are merged and settled in the background (autoDream). Off: memory only accumulates, so it gets messier the longer you use it",
        "memory.features.sleepModeEnabled": "It tidies memories while you are away",
        "memory.features.sleepModeEnabled.hint": "On: layered compaction and tidying happen during idle periods. Off: only consolidation you trigger manually (sleep mode, off by default)",
        // #619: affective attribution is a sub-phase of sleep — it cannot run while
        // the parent is off, so it sits next to it.
        "memory.features.sleepAffectiveEnabled": "It remembers how you felt about a particular thing",
        "memory.features.sleepAffectiveEnabled.hint": "On: tidying records \"how someone felt about one event\" as an occasion-bound link, and only calls it a stable disposition when it recurs across several independent occasions. Off: emotions are not recorded (affective attribution, off by default, and requires sleep mode)",
        // #427 suggestion 5: hybridInject / selectiveInjectEnabled /
        // adaptiveThresholdEnabled are three dials of one question — what comes
        // back. Adjacent placement plus a hint that names the other two.
        "memory.features.hybridInject": "Search by keywords and meaning together",
        "memory.features.hybridInject.hint": "On: both channels each fetch a batch and merge — broader recall. Off: one channel only. Three dials exist for \"what comes back\" (hybrid / selective / adaptive threshold); one is enough (hybrid injection, on by default)",
        "memory.features.selectiveInjectEnabled": "Only carry memories that truly matter",
        "memory.features.selectiveInjectEnabled.hint": "On: relevance is filtered before injecting — cleaner context. Off: more comes along, and noisier. One of the three dials (selective injection, on by default)",
        "memory.features.adaptiveThresholdEnabled": "Tighten or loosen by retrieval quality",
        "memory.features.adaptiveThresholdEnabled.hint": "On: a poor-recall day loosens the floor, a good one tightens it. Off: the floor is fixed. One of the three dials (adaptive threshold, on by default)",
        "memory.features.reflectionUpdateEnabled": "Let tidying revise existing memories",
        "memory.features.reflectionUpdateEnabled.hint": "On: consolidation may rewrite and merge existing entries, not only add. Off: old memories are never auto-edited (reflective update, on by default)",
        "memory.features.distill": "Distillation & rate limiting",
        "memory.features.distillRateLimitIntervalMs": "Distill spacing (ms)",
        "memory.features.distillRateLimitRetries": "429 retries",
        "memory.features.distillRateLimitBaseDelayMs": "Backoff base delay (ms)",
        "memory.features.distillMaxChars": "Transcript cap (chars)",
        "memory.features.distillRecords.enabled": "Keep distilled transcripts",
        "memory.features.distillRecords.enabled.hint": "Also store the public parts of the distilled window, with a provenance link per memory; private reasoning and tool output are never stored. Off writes nothing and skips collection entirely",
        "memory.features.distillRecords.retentionDays": "Transcript retention (days)",
        "memory.features.distillRecords.retentionDays.hint": "1–3650 days; startup pruning only. To make reclaim use the same window, pass the same value via --older-than",
        "memory.features.codingBoostFactor": "Coding boost factor",
        "memory.features.memoryQualityFilter.enabled": "Tuck low-value memories away automatically",
        "memory.features.memoryQualityFilter.enabled.hint": "On: low-value entries are archived automatically and injection downranks by quality. Off: everything stays, noise included (memory quality filter, on by default)",
        "memory.features.llmAudit.enabled": "Keep tabs on background model usage",
        "memory.features.llmAudit.enabled.hint": "On: background consolidation / summary calls and token usage are all on record. Off: there is no way to check what the background spent (call audit, on by default)",
        // #254 — two layers: enabled runs the check (audit only), enforce actually
        // blocks. The hints must keep that difference explicit.
        "memory.features.writeAdmission.enabled": "Judge blank / noise writes before storing (audit only)",
        "memory.features.writeAdmission.enabled.hint": "On: blank / noise writes are flagged with an audit row but still stored. Off: nothing is judged. To actually block, see the next switch (write admission checks, off by default)",
        "memory.features.writeAdmission.enforce": "Really reject useless writes",
        "memory.features.writeAdmission.enforce.hint": "On: flagged writes are rejected outright. Off: audit row only, stored anyway. Needs the checks switch above (write admission enforcement, off by default)",
        "memory.features.preInjectGate.enabled": "Screen out \"just my opinion\" memories before injection (audit only)",
        "memory.features.preInjectGate.enabled.hint": "On: opinion / stance memories are judged before injection and audited, so you can watch the distribution first. Off: injected as usual (pre-inject gate, off by default)",
        "memory.features.preInjectGate.enforce": "Really drop flagged candidates at injection",
        "memory.features.preInjectGate.enforce.hint": "On: flagged candidates are dropped at injection time. Off: audit row only, injected anyway. Needs the gate switch above (pre-inject gate enforcement, off by default)",
        // #164 A2: its own gate for the secret / PII rules (separate from the
        // blank/noise pair above), and it runs inside the write admission checks
        // above, so with those off it never runs. Hits are audited only;
        // enforcement stays with the key above.
        "memory.features.sensitiveScanEnabled": "Scan writes for credentials and personal data",
        "memory.features.sensitiveScanEnabled.hint": "On: secret / PII rules run inside the write admission checks; hits are audited only — to block, also enable enforcement. Nothing runs while the checks switch is off (secret / PII scan, off by default)",
        "memory.features.bm25SearchEnabled": "Also search by exact keywords",
        "memory.features.bm25SearchEnabled.hint": "On: exact-term scoring joins in, so proper nouns, error codes and paths hit reliably — a complement to meaning-based search. Off: semantic similarity only (BM25 keyword search, on by default)",
        "memory.features.conflictFreezeEnabled": "Freeze contradictory memories first",
        "memory.features.conflictFreezeEnabled.hint": "On: contradictions found while tidying are frozen for your confirmation instead of both staying live. Off: both stay in use (conflict freezing, off by default)",
        "memory.features.scopeEnabled": "Record which session each memory came from",
        "memory.features.scopeEnabled.hint": "On: every new memory is tagged with the agent / workspace it came from — that tag decides whether other sessions see it. Off: new memories carry no origin and all sessions share one pool (scope tagging, off by default)",
        "memory.features.strictScope": "Memories others marked private stay invisible to me",
        "memory.features.strictScope.hint": "On: memories explicitly made private by other sessions are fully invisible. Off: they stay visible but rank lower. For true isolation use a memory's sensitivity field. Needs the tagging switch above (strict isolation, off by default)",
        "memory.features.trustEpistemicWeighting": "Rank by source credibility",
        "memory.features.trustEpistemicWeighting.hint": "On: more credible sources rank higher. Off: everything counts the same (credibility weighting, experimental, off by default)",
        "memory.features.reflectionFailureTracking": "Keep failed tidying cases on record",
        "memory.features.reflectionFailureTracking.hint": "On: failure causes and cases are stored for diagnosis and improvement. Off: failures leave no record (failure tracking, on by default)",
        "memory.features.embedRoute": "Semantic search route",
        "memory.features.embedProvider": "Embedding provider",
        "memory.features.embedProvider.openai": "OpenAI-compatible API",
        "memory.features.embedProvider.local": "Local model (offline)",
        "memory.features.embedProvider.ollama": "Ollama",
        "memory.features.embedProvider.openai.hint": "Endpoint / key / model live in the Vector Search card below",
        "memory.features.embedProvider.local.hint": "First use downloads the model; fully offline afterwards",
        "memory.features.embedProvider.ollama.hint": "Requires a local Ollama server",
        "memory.features.localEmbedModel": "Local embedding model",
        "memory.features.ollamaBaseUrl": "Ollama server URL",
        "memory.features.ollamaModel": "Ollama model",
        "memory.features.dreamProvider": "Consolidation provider",
        "memory.features.dreamModel": "Consolidation model",
        "memory.features.dreamModelHint": "Leave empty to follow the main conversation model; only affects autoDream consolidation",
        "memory.features.dreamPeakHours": "Peak hours (no dreaming)",
        "memory.features.dreamPeakHours.hint": "Busy hours for the machine; consolidation avoids them and catches up afterwards. Syntax: 09:00-18:00, several windows comma-separated, weekday prefix allowed (mon-fri 08:00-12:00), midnight-crossing allowed; empty = no limit",
        "memory.features.dreamPeakHours.invalid": "Current value is not a valid time-window spec and will be treated as unset (consolidation runs around the clock). Syntax: 09:00-18:00, comma-separated windows, optional weekday prefix (mon-fri 08:00-12:00), midnight-crossing allowed; write 00:00 instead of 24:00",
        "memory.features.summarizePeakHours": "Peak hours (no distillation)",
        "memory.features.summarizePeakHours.hint": "Same syntax as the consolidation side above; distillation avoids these windows and accumulates the material for one run off-peak",
        "memory.features.summarizePeakHours.invalid": "Current value is not a valid time-window spec and will be treated as unset (distillation runs around the clock). Syntax as on the consolidation side: 09:00-18:00, comma-separated windows, optional weekday prefix, midnight-crossing allowed",
        "memory.features.sleepProvider": "Sleep provider",
        "memory.features.sleepModel": "Sleep model",
        "memory.features.sleepModelHint": "Leave empty to reuse the consolidation model; a non-reasoning model is recommended",
        // Issue #478: max_tokens budget keys. Hint states both the scope (single-run
        // output budget) and the backend auto-downgrade on provider cap rejection.
        "memory.features.dreamMaxTokens": "Consolidation output cap (max_tokens)",
        "memory.features.dreamMaxTokens.hint": "Max tokens generated per consolidation run, 256–131072. When the default 131072 exceeds a provider's hard limit, the backend retries with the cap from the error",
        "memory.features.sleepMaxTokens": "Sleep output cap (max_tokens)",
        "memory.features.sleepMaxTokens.hint": "Single-run output budget for sleep conflict/mode calls, 256–131072; over-cap values are downgraded automatically",
        "memory.features.routeFollowDefault": "Follow default route",
        "memory.features.modelTest": "Test connectivity",
        "memory.features.modelTesting": "Testing…",
        "memory.features.modelTestOk": "Connected",
        "memory.features.modelTestFail": "Test failed",
        "memory.features.modelTestHint": "Fires one minimal consolidation call to verify provider/model connectivity and effort support",
        "memory.features.modelTestDowngraded": "Effort not accepted by this model; connected without it (same as a real consolidation)",
        "memory.features.routeStaleMark": " (not in list)",
        "memory.features.routeStaleHint": "This value is not in the currently available list (often a leftover from switching providers): reselect, or run a connectivity test to verify now",
        "memory.explorer.viewCards": "Cards",
        "memory.explorer.viewTimeline": "Timeline",
        "memory.explorer.viewAria": "Switch view",
        "memory.explorer.dateLabel": "Time",
        "memory.explorer.date.all": "All time",
        "memory.explorer.date.7d": "Last 7 days",
        "memory.explorer.date.30d": "Last 30 days",
        "memory.explorer.date.90d": "Last 90 days",
        "memory.explorer.more": "More actions",
        "memory.explorer.exportJson": "Export JSON",
        "memory.explorer.exportMarkdown": "Export Markdown",
        "memory.explorer.importMd": "Import Markdown mirror…",
        "memory.explorer.importTitle": "Import Markdown mirror",
        "memory.explorer.importHint": "Pick a Markdown mirror file; its manual edits are parsed and merged into the store.",
        "memory.explorer.importType": "Mirror type",
        "memory.explorer.importPick": "Choose file…",
        "memory.explorer.importConfirm": "Import",
        "memory.explorer.importCancel": "Cancel",
        "memory.explorer.importing": "Importing…",
        "memory.explorer.imported": "Merged {n} edits",
        "memory.explorer.importFailed": "Import failed",
        "memory.explorer.importNoFile": "Choose a file first",
        "memory.explorer.bootstrap": "Bootstrap from a directory…",
        "memory.explorer.bootstrapTitle": "Bootstrap from a directory",
        "memory.explorer.bootstrapHint": "Reads the deterministic artifacts there (script commands, README, contributing rules, CI workflows, top-level layout, recent commits) — one rule, one memory. No model call; running it again merges instead of duplicating.",
        "memory.explorer.bootstrapDir": "Directory path",
        "memory.explorer.bootstrapConfirm": "Bootstrap",
        "memory.explorer.bootstraping": "Bootstrapping…",
        "memory.explorer.bootstrapDone": "Created {n}, merged {m}",
        "memory.explorer.bootstrapNoDir": "Enter a directory path first",
        "memory.explorer.bootstrapFailed": "Bootstrap failed",
        "memory.explorer.bootstrapErr.missing-dir": "No directory path was given",
        "memory.explorer.bootstrapErr.dir-not-found": "That path does not exist",
        "memory.explorer.bootstrapErr.not-a-directory": "That path is not a directory",
        "memory.explorer.bootstrapErr.bootstrap-unavailable": "This capability is not wired in the current assembly",
        "memory.explorer.sharePack": "Share memories…",
        "memory.explorer.shareTitle": "Memory share pack",
        "memory.explorer.shareHint": "Pack your active memories for someone else: rows holding secrets are dropped whole, home paths become ~, archived and forgotten rows stay out.",
        "memory.explorer.shareAlias": "Share alias",
        "memory.explorer.shareAliasBlank": "blank = from-shared",
        "memory.explorer.shareType": "Only this type",
        "memory.explorer.shareBuild": "Build",
        "memory.explorer.shareBuilding": "Building…",
        "memory.explorer.shareFailed": "Could not build the pack",
        "memory.explorer.shareIncluded": "{n} rows in the pack",
        "memory.explorer.shareDeduped": "{n} folded as duplicates; {m} rows qualified",
        "memory.explorer.shareSkipped": "{n} rows skipped",
        "memory.explorer.share.skip.archived": "Archived",
        "memory.explorer.share.skip.forgotten": "Forgotten",
        "memory.explorer.share.skip.readonly_type": "Read-only pointers",
        "memory.explorer.share.skip.excluded_type": "Excluded types",
        "memory.explorer.share.skip.blank_or_noise": "Blank or noise",
        "memory.explorer.share.skip.sensitive": "Secrets or PII",
        "memory.explorer.shareSkipList": "Skip list ({n})",
        "memory.explorer.shareSkipListCapped": "List shows the first {n}; the counts above are complete",
        "memory.explorer.shareNoTitle": "(title withheld)",
        "memory.explorer.shareTooLarge": "Pack is {bytes} bytes, over the {limit}-byte water mark",
        "memory.explorer.shareEmpty": "Nothing qualified - the pack is empty",
        "memory.explorer.shareDownload": "Download pack file",
        "memory.explorer.receivePack": "Import a share pack…",
        "memory.explorer.receiveTitle": "Import a share pack",
        "memory.explorer.receiveHint": "Pick the file she sent. The first pass is a dry run; nothing is written until Confirm. Imported rows join the foreign area and never take part in this machine's consolidation, demotion or tidying.",
        "memory.explorer.receivePick": "Choose pack file…",
        "memory.explorer.receiveNotJson": "That file is not JSON",
        "memory.explorer.receiveNotPack": "That file is not a share pack (the top level should be one JSON object)",
        "memory.explorer.receivePreview": "Preview (dry run)",
        "memory.explorer.receiveConfirm": "Confirm import",
        "memory.explorer.receiveFailed": "Import failed",
        "memory.explorer.receiveFrom": "From {alias}",
        "memory.explorer.receiveAnonymous": "unnamed",
        "memory.explorer.receiveWouldCreate": "Would create {n}",
        "memory.explorer.receiveDidCreate": "Created {n}",
        "memory.explorer.receiveExisting": "{n} already in the store",
        "memory.explorer.receiveUnchanged": "{n} identical already",
        "memory.explorer.receiveConflicts": "{n} title clashes (not merged - check them yourself)",
        "memory.explorer.receivePackCount": "{n} rows in the pack",
        "memory.explorer.receiveStillDry": "Nothing was written: that call stayed dry",
        "memory.explorer.filterForeign": "Foreign",
        "memory.explorer.filterForeignHint": "Only rows shared in by someone else (source=imported). They never join this machine's consolidation, demotion or tidying.",
        "memory.explorer.filterForeignSearchHint": "Not applied while searching: search results carry no usable provenance readout. Clear the query to browse the foreign area.",
        "memory.explorer.foreignBadge": "From {alias}",
        "memory.explorer.foreignPack": "Share pack",
        "memory.explorer.undoPack": "Withdraw this pack",
        "memory.explorer.undoPackPreview": "This would delete {n} foreign rows from that pack (hard delete)",
        "memory.explorer.undoPackConfirm": "Delete {n} rows",
        "memory.explorer.undoPackDone": "Withdrew {n} rows",
        "memory.explorer.undoPackFailed": "Withdrawal failed",
        "memory.explorer.undoPackBusy": "Withdrawing…",
        "memory.explorer.undoPackStillDry": "Nothing was deleted: that call stayed dry",
        "memory.explorer.undoPackGone": "That pack has no rows left in this store",
        "memory.explorer.newMemory": "New memory…",
        "memory.explorer.newTitle": "New memory",
        "memory.explorer.newHint": "Write one memory by hand. Same type + same title merges into the existing entry instead of minting a second row.",
        "memory.explorer.newType": "Type",
        "memory.explorer.newTitlePlaceholder": "Short title; also the dedupe key",
        "memory.explorer.newContentPlaceholder": "Body",
        "memory.explorer.newTagsPlaceholder": "Tags, comma separated (optional)",
        "memory.explorer.newConfirm": "Create",
        "memory.explorer.newSaving": "Saving…",
        "memory.explorer.newCreated": "Created",
        "memory.explorer.newMerged": "Merged into the existing entry with that title",
        "memory.explorer.newFailed": "Create failed",
        "memory.explorer.newNoTitle": "Title is required",
        "memory.explorer.newNoContent": "Body is required",
        "memory.explorer.exportFailed": "Export failed",
        "memory.explorer.conflictBadge": "Conflict",
        "memory.explorer.archivedBadge": "Archived",
        "memory.explorer.scopeBadge": "Scoped",
        "memory.explorer.detail.agentScope": "Agent scope",
        "memory.explorer.detail.workspaceScope": "Workspace scope",
        "memory.explorer.detail.scopeGlobal": "Global (visible to all sessions)",
        "memory.explorer.detail.scopeSourceAuto": "auto",
        "memory.explorer.detail.scopeSourceExplicit": "explicit",
        "memory.explorer.detail.scopeEditHint": "Empty = global; or enter a specific label to narrow the scope",
        "memory.explorer.detail.scopeWidenConfirm": "Widen visibility?",
        "memory.explorer.detail.scopeWidenHint": "Widening makes this memory visible to all sessions",
        "memory.explorer.detail.sensitivity": "Sensitivity",
        "memory.explorer.detail.occurred": "Occurred",
        "memory.explorer.detail.edit": "Edit",
        "memory.explorer.detail.save": "Save",
        "memory.explorer.detail.cancel": "Cancel",
        "memory.explorer.detail.archive": "Archive",
        "memory.explorer.detail.restore": "Restore",
        "memory.explorer.detail.restored": "Restored to the main list",
        "memory.explorer.detail.archived": "Archived",
        "memory.explorer.detail.archiveFailed": "Action failed",
        "memory.explorer.detail.saved": "Saved; mirrors re-rendered",
        "memory.explorer.detail.quality": "Quality",
        "memory.explorer.detail.entities": "Related entities",
        "memory.explorer.detail.entitiesEmpty": "Turn on entity extraction and related people / projects appear here",
        "memory.explorer.detail.provenance": "Distillation provenance",
        "memory.explorer.detail.provenanceEmpty": "No attribution for this memory: rows older than the change are left blank, never guessed",
        "memory.explorer.detail.provenanceMint": "Minted by",
        "memory.explorer.detail.provenanceWindow": "Distill window",
        "memory.explorer.detail.provenanceNoRun": "No run attribution (legacy row)",
        "memory.explorer.detail.provenanceRecords": "{n} records",
        "memory.explorer.detail.closeAria": "Close details",
        "memory.explorer.detail.editTitle": "Title",
        "memory.explorer.detail.editContent": "Content",
        "memory.explorer.detail.editImportance": "Importance",
        "memory.explorer.detail.starLabel": "Set importance to {n} stars",
        "memory.status.dream": "Last consolidation",
        "memory.status.dreamNever": "Not yet run",
        "memory.status.dreamOrganizeOnly": "The last background run was an agent-initiated organize ({time}), not a consolidation",
        "memory.status.conflicts": "Pending conflicts",
        "memory.status.conflictsHint": "Frozen contradictory memories awaiting confirmation",
        "memory.status.skippedTitle": "{n} decisions skipped this run",
        "memory.status.skippedHint": "These decisions were blocked by the validator and not applied. Identical reasons are counted together — a whole action type being blocked usually means the prompt and the guard disagree, which is worth a look.",
        "memory.status.skippedMore": "{n} more kinds",
        "memory.status.skippedNone": "No decisions were skipped this run",
        "memory.status.injectSuppressed": "Injection disabled by host minimal preset",
        "memory.status.injectSuppressedHint": "This session uses the minimal preset: memory injection / profile / hot memory never reach the model (by host design, not a plugin defect). Switch to standard mode, or set agent-presets.default: standard in ~/.dsh/settings.yaml. Interim: put profile and rules in AGENTS.md",
        "memory.status.injectPreview": "Injection preview",
        "memory.status.injectPreviewNone": "No preview yet — no injection has happened (new session or injection off)",
        "memory.status.injectPreview.chars": "Total",
        "memory.status.injectPreview.charsUnit": " chars",
        "memory.status.injectPreview.maxItems": "Max items",
        "memory.status.injectPreview.threshold": "Relevance floor",
        "memory.status.injectPreview.scope": "Session scope",
        "memory.status.injectPreview.query": "query \"{query}…\"",
        "memory.status.injectPreview.hot": "hot memory",
        "memory.status.injectPreview.adaptiveOn": "adaptive budget",
        "memory.status.injectPreview.rotated": "rotation-suppressed",
        "memory.status.injectPreview.empty": "No cross-session memories injected this assembly (threshold or rotation filter)",
        "memory.status.conflictQueue.reason": "Reason",
        "memory.status.conflictQueue.sideA": "Side A",
        "memory.status.conflictQueue.sideB": "Side B",
        "memory.status.conflictQueue.keepA": "Keep A",
        "memory.status.conflictQueue.keepB": "Keep B",
        "memory.status.conflictQueue.markReviewed": "Mark reviewed only",
        "memory.status.conflictQueue.applyHint": "On confirm: a veto note is appended to the kept side and the other side is archived.",
        "memory.status.conflictQueue.missing": "(memory no longer exists)",
        "memory.status.conflictQueue.goto": "View pending conflict queue",
        "memory.status.conflictQueue.resolved": "Resolved: kept {name}",
        "memory.status.conflictQueue.refresh": "Refresh queue",
        "memory.status.conflictQueue.refreshed": "Conflict queue refreshed",
        "memory.status.conflictQueue.frozenBadge": "⏸ Frozen",
        "memory.status.conflictQueue.frozenTitle": "Frozen: excluded from injection and consolidation, awaiting your review",
        "memory.status.conflictQueue.similarity": "similarity",
        "memory.status.conflictQueue.diffTitle": "Differences highlighted: red = removed, green = added",
        "memory.status.conflictQueue.diffFallback": "The two texts differ substantially — compare the originals",
        "memory.status.conflictQueue.expand": "Expand full text",
        "memory.status.conflictQueue.collapse": "Collapse",
        "memory.status.conflictQueue.copySide": "Copy this side",
        "memory.status.conflictQueue.copiedSide": "Full text copied",
        "memory.status.conflictQueue.importance": "importance {n}",
        "memory.status.conflictQueue.chars": "{n} chars",
        "memory.status.conflictQueue.updated": "updated {time}",
        "memory.status.conflictQueue.created": "created {time}",
        "memory.status.conflictQueue.emptyTitle": "No pending conflicts",
        "memory.status.conflictQueue.emptyBody": "When consolidation finds two contradictory or highly similar memories, it freezes them here for your review instead of changing anything automatically. Neither side participates in injection until resolved.",
        "memory.status.conflictQueue.applyHintTitle": "On confirm: a veto note is appended to the kept side and the other side is archived",
    "memory.status.conflictQueue.truncated": "Showing {shown} of {total} (most similar first; clear these before the rest appear)",
        "memory.status.workbench": "Activity",
        "memory.status.dreamConsolidate": "Consolidation",
        "memory.status.summarize": "Summarization",
        "memory.status.tokens": "{n} tokens",
        "memory.status.deposited": "{n} memories deposited",
        "memory.status.failed": "failed",
        "memory.status.success": "success",
        "memory.status.skipped": "skipped",
        "memory.status.emptyFeed": "No background activity yet: memories are distilled after conversations",
        "memory.status.consolidated": "Deposited memories",
        "memory.status.consolidatedEmpty": "Memories deposited by autoDream / autoSummarize appear here",
        "memory.status.archivedMemories": "Archived memories",
        "memory.status.heatDistribution": "Heat distribution",
        "memory.status.heat.hot": "Hot (≥66%)",
        "memory.status.heat.warm": "Warm (33–66%)",
        "memory.status.heat.cold": "Cooled (<33%)",
        "memory.status.heat.sample": "Sampled from the latest {sample}",
        "memory.status.recallStats": "Recall reuse",
        "memory.status.recall.zombie": "Zombie memories",
        "memory.status.recall.exempt": "exempt",
        "memory.status.recall.runs": "Receipts (30d)",
        "memory.status.recall.top": "Most recalled",
        "memory.status.recall.inject": "Injected",
        "memory.status.recall.archive": "Archived",
        "memory.status.recallInject": "{runs} turns · {count} items · {fill}% slots",
        "memory.status.recallArchive": "{total} rows · +{add}/day · {compress} compressible",
        "memory.status.viewAll": "View all",
        "memory.status.depositedCount": "Deposited memories ({n})",
        "memory.status.archivedCount": "Archived memories ({n})",
        "memory.status.archivedEmpty": "Nothing archived",
        "memory.status.restore": "Restore",
        "memory.settings.extapi.reveal": "Reveal",
        "memory.settings.extapi.hide": "Hide",
        "memory.settings.extapi.maskHint": "Token masked; Copy still copies the full value",
        "memory.explorer.delete": "Delete",
        "memory.explorer.confirmDelete": "Confirm delete?",
        "memory.explorer.cancel": "Cancel",
        "memory.explorer.deleted": "Deleted",
        "memory.explorer.deleteFailed": "Delete failed",
        "memory.status.memories": "Total memories",
        "memory.status.entities": "Entities",
        "memory.status.vector": "Vector index",
        "memory.status.vectorOff": "Disabled",
        "memory.status.vectorInit": "Initializing",
        "memory.status.vectorInitHint": "embedder unreachable, retrying",
        "memory.status.vectorRuntimeMissing": "Local inference runtime missing",
        "memory.status.vectorRuntimeHint": "Local inference runtime not ready ({status})",
        "memory.status.vectorRuntimeCost": "Local vectorization needs an extra local inference runtime (hundreds of MB unpacked). The button below first adopts an existing copy on this machine (hardlinked on the same volume, no extra disk) and otherwise fetches it from npm with per-file checksums. You can also just ask the agent, or run it yourself: node scripts/mneme-runtime.mjs status / adopt / verify (see docs/LOCAL_MODEL.md)",
        "memory.runtime.title": "Local inference runtime",
        "memory.runtime.available": "ready",
        "memory.runtime.missing": "not ready — only needed when you use local embedding (embedProvider: local)",
        "memory.runtime.restart": "Local embedding takes effect after restarting DSH",
        "memory.status.vectorRuntimeReady": "Runtime ready",
        "memory.status.vectorRuntimeReadyHint": "Local embedder is not initialized yet (the in-process embedder already failed while the runtime was missing): restart DSH if this persists.",
        "memory.status.vectorRuntimeFetch": "Fetch local runtime",
        "memory.status.vectorRuntimeFetchBusy": "Fetching… (tries adopt first, may download — thousands of files)",
        "memory.status.vectorRuntimeFetchAdopted": "Adopted the runtime already on this machine: {n} packages / {m} files ({mode}). **Restart DSH to activate local embedding.**",
        "memory.status.vectorRuntimeFetchDownloaded": "Download complete: {n} packages / {m} files. **Restart DSH to activate local embedding** (fetching does not revive the embedder already running in this process).",
        "memory.status.vectorRuntimeFetchFailed": "Fetch failed: {reason}",
        "memory.status.vectorIndexed": "Indexed {n} / {m} items",
        "memory.status.vectorBackfillRunning": "Backfilling: {m} rows per run",
        "memory.status.vectorBackfillDrained": "Backfill finished: {n} rows embedded this start",
        "memory.status.vectorBackfillCapped": "Backfill paused: run budget spent ({m} rows), another round is queued",
        "memory.status.vectorBackfillStalled": "Backfill stuck: {f} rows will not embed, retrying on next start",
        "memory.status.vectorBackfillError": "Backfill failed: {e}",
      "memory.status.vectorUnconfigured": "Not configured",
      "memory.status.vectorUnconfiguredHint": "No embedding endpoint/model configured — semantic recall is off",
      "memory.status.vectorDegradedHint": "Indexed 0 / {m} items — semantic recall is effectively unavailable",
        "memory.status.mirror": "Markdown mirror",
        "memory.status.mirror.ok": "Healthy",
        "memory.status.mirror.degraded": "Degraded",
        "memory.status.mirror.unknown": "Unknown",
        "memory.status.mirror.dirty": "Unflushed changes",
        "memory.status.mirror.yes": "Yes",
        "memory.status.mirror.lastError": "Last error",
        "memory.status.mirror.err.noSpace": "Disk full",
        "memory.status.mirror.err.permission": "Permission denied",
        "memory.status.mirror.err.syncFailed": "Sync failed",
        "memory.status.mirror.lastAttempt": "Last attempt",
        "memory.status.mirror.successAt": "Last success",
        "memory.status.mirror.foot": "Sync state of the on-disk Markdown mirror of memory entries",
        "memory.status.capacity": "Storage size",
        "memory.status.capacity.unknown": "Unknown",
        "memory.status.capacity.unknownFoot": "Capacity readout unavailable (panel request failed, or the host predates this block)",
        "memory.status.capacity.active": "Active entries",
        "memory.status.capacity.archived": "Archived entries",
        "memory.status.capacity.reclaimable": "Reclaimable (freelist)",
        "memory.status.capacity.check.dbSize": "DB size over threshold",
        "memory.status.capacity.check.archivedRows": "Archived count over threshold",
        "memory.status.capacity.check.archivedRatio": "Archive share over threshold",
        "memory.status.capacity.foot": "The three thresholds (size / archived count / archive share) are adjustable in settings; when tripped, start with lossless reclaim in the maintenance card — real deletion stays human-confirmed",
        "memory.status.sec.overview": "Library",
        "memory.status.sec.engine": "Background activity",
        "memory.status.sec.maintenance": "Maintenance",
        "memory.status.maint": "Storage reclaim",
        "memory.status.maint.freelist": "Free pages reclaimable now",
        "memory.status.maint.plannedInputs": "Input snapshots to clear",
        "memory.status.maint.plannedEmbeddings": "Archived embeddings to clear",
        "memory.status.maint.window": "Retention window",
        "memory.status.maint.windowUnit": "days",
        "memory.status.maint.windowLabel": "Retention window (days)",
        "memory.status.maint.reestimate": "Re-estimate",
        "memory.status.maint.reestimating": "Estimating…",
        "memory.status.maint.stale": "Window changed - re-estimate before running, or the run would use the previous estimate's numbers.",
        "memory.status.maint.vacuum": "VACUUM as well",
        "memory.status.maint.vacuumHint": "VACUUM briefly takes an exclusive lock on the database; other reads and writes wait. Skipping it does not change what gets cleared.",
        "memory.status.maint.execute": "Run reclaim",
        "memory.status.maint.confirm": "Confirm (irreversible)",
        "memory.status.maint.running": "Running…",
        "memory.status.maint.cancel": "Cancel",
        "memory.status.maint.confirmHint": "This clears {inputs} input-snapshot rows and {embeddings} archived-embedding rows. It cannot be undone.",
        "memory.status.maint.badWindow": "The retention window must be an integer of at least 0",
        "memory.status.maint.failed": "Reclaim failed",
        "memory.status.maint.done": "Reclaim finished",
        "memory.status.maint.size": "Size (before → after)",
        "memory.status.maint.reclaimed": "Actually freed",
        "memory.status.maint.clearedInputs": "Input snapshots cleared",
        "memory.status.maint.clearedEmbeddings": "Archived embeddings cleared",
        "memory.status.maint.receipt": "Audit receipt",
        "memory.status.maint.receiptNone": "Not recorded (audit disabled or receipt write failed)",
        "memory.status.maint.duration": "Duration",
        "memory.status.maint.vacuumRan": "VACUUM ran",
        "memory.status.maint.vacuumOff": "Not VACUUMed",
        "memory.status.maint.vacuumFailed": "VACUUM failed",
        "memory.status.maint.vacuumFailedHint": "The reclaim already completed and cannot be undone, but the file will not shrink yet; run it again later (reclaim is idempotent).",
        "memory.status.sec.token": "Token flow · last 7 days",
        "memory.status.token.in": "input",
        "memory.status.token.out": "output",
        "memory.status.token.total": "7-day token total",
        "memory.status.token.calls": "Calls",
        "memory.status.token.callsCap": "Last 7 days · all background components",
        "memory.status.token.share": "Consolidation share",
        "memory.status.token.shareFoot": "dream_consolidate · {n} token",
        "memory.status.token.conflicts": "Pending conflicts",
        "memory.status.token.conflictsFoot": "From /dream-status · live",
        "memory.status.token.donut": "By component · who spent these tokens",
        "memory.status.token.days": "By day · 7-day trend",
        "memory.status.token.heat": "8-week heat · daily spend",
        "memory.status.token.heatLess": "less",
        "memory.status.token.heatMore": "more",
        "memory.status.token.sink": "8-week consolidation · in vs kept",
        "memory.status.token.sinkAdded": "added",
        "memory.status.token.sinkMerged": "consolidated",
        "memory.status.token.sinkArchived": "archived",
        "memory.status.token.sinkGap": "consolidated/added",
        "memory.status.token.sinkEmpty": "nothing recorded yet",
        "memory.status.token.sinkFoot": "consolidated counts distinct records; re-merging the same record counts once",
        "memory.status.token.last7": "last 7 days",
        "memory.status.token.meterOnly": "(metered only)",
        "memory.status.token.detail": "Detailed status cards (the original 9 under Library / Background activity, click to expand)",
        "memory.status.token.op.dream_consolidate": "Memory consolidation",
        "memory.status.token.op.summarize_compress": "Session distillation",
        "memory.status.token.op.entity_extract": "Entity extraction",
        "memory.status.token.op.dream_summarize": "Overview summary",
        "memory.status.token.op.sleep_pattern": "Sleep patterns",
        "memory.status.token.op.write_admission": "Write admission",
        "memory.status.error": "Failed to load"
      }
    };

    function typeLabel(t, type) {
      const key = `memory.tab.${type}`;
      const label = t(key);
      return label && label !== key ? label : String(type);
    }

    // Entity types live under their own i18n subtree (person/project/...);
    // unknown or "other" falls back to the raw type string.
    function entityTypeLabel(t, type) {
      const key = `memory.entity.${type}`;
      const label = t(key);
      return label && label !== key ? label : String(type);
    }

    function formatDate(value) {
      if (!value) return "—";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
    }

    // Relative time ("2分钟前") keeps cards scannable; anything older than a
    // week falls back to the absolute date. The card meta shows the relative
    // form and carries the full timestamp in a title tooltip.
    function formatRelativeTime(value, t) {
      if (!value) return "—";
      const ms = new Date(value).getTime();
      if (Number.isNaN(ms)) return "—";
      const diff = Date.now() - ms;
      if (diff < 60_000) return t("memory.time.now");
      const minutes = Math.floor(diff / 60_000);
      if (minutes < 60) return t("memory.time.minutes").replace("{n}", String(minutes));
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return t("memory.time.hours").replace("{n}", String(hours));
      const days = Math.floor(hours / 24);
      if (days < 7) return t("memory.time.days").replace("{n}", String(days));
      return new Date(ms).toLocaleDateString();
    }

    // Memory-library stylesheet, injected once per page following the host's
    // data-plugin-css convention. Every value resolves to the host's design
    // tokens: background layers, label/border/interactive aliases and the
    // --dsw-font-* scale, so the page reads as a first-party view beside
    // Chat / Trajectory (flat layer-1 canvas, hairline column separators,
    // text-turns-brand-blue active states — no boxed panels).
    const CSS_TAG = "@modusensus/dsh-mneme/drawer.css";
    const css = [
      // --- explorer shell: container queries let the toolbar adapt to the
      // better-sidebar workbench pane (~500px) as well as the 1240px sheet ---
      // --- sidebar foot trigger (wide row / collapsed rail icon) ---
      ".mneme-trigger{box-sizing:border-box;cursor:pointer;width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:12px;flex:none;align-items:center;gap:8px;margin:4px -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}",
      ".mneme-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-trigger.mneme-rail{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0}",
      ".mneme-trigger-label{white-space:nowrap;overflow:hidden}",
      // --- shared controls ---
      ".mneme-search{box-sizing:border-box;height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;outline:none;transition:border-color .12s,box-shadow .12s}",
      ".mneme-search:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent)}",
      ".mneme-search::placeholder{color:var(--mneme-fg-dim)}",
      ".mneme-chip{height:26px;padding:0 10px;border-radius:8px;border:1px solid transparent;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:12px;line-height:16px;display:inline-flex;align-items:center}",
      ".mneme-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-chip.mneme-active{color:var(--mneme-accent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}",
      ".mneme-select{box-sizing:border-box;height:30px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;outline:none}",
      ".mneme-routeselect{width:240px;max-width:60%}",
      ".mneme-footbtn{border:none;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:12px;line-height:16px;padding:3px 8px;border-radius:6px}",
      ".mneme-footbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".mneme-hint{color:var(--mneme-fg-dim);padding:24px 0;text-align:center;font-size:13px}",
      ".mneme-entitychip{flex:none;height:26px;padding:0 10px;border-radius:8px;border:none;background:none;color:var(--mneme-accent);cursor:pointer;font-family:inherit;font-size:12px;line-height:16px;display:inline-flex;align-items:center}",
      ".mneme-entitychip:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}",
      // --- main-area memory library page ---
      // 面板语义色层（#178）：宿主 token 在浅色下给正文/次要文字只有 1.26–4.49
      // 的对比度，且面板还一直在引用 5 个根本不存在的宿主名（--dsw-alias-state-error
      // / -warning / -success / -warn / --dsw-alias-border），
      // 于是长年吃的是写在 fallback 里的硬编码色。这里按宿主真实 token 现算一组
      // 面板自有语义色：混色基准全是宿主 token，宿主换肤时跟着走，不引入新字面量。
      // 必须挂满五个根——面板不只长在 .mneme-x 下：记忆库 sheet portal 到 body
      // （.mneme-overlay）、侧边栏入口在宿主插槽（.mneme-triggerwrap）、顶部入口
      // portal 到宿主侧边栏（.mneme-topentry）。第五个根是宿主内整页面板
      // （.mneme-panel）配套的侧栏图标容器：那颗图标长在宿主的 panelGlyph 里，
      // 不在 .mneme-x 的子树里，而它右上角的未处理冲突 badge 要吃 --mneme-danger。
      ".mneme-x,.mneme-overlay,.mneme-triggerwrap,.mneme-topentry,.mneme-paneliglyph{" +
        "--mneme-fg-dim:color-mix(in srgb,var(--dsw-alias-label-primary) 60%,transparent);" +
        "--mneme-graphic-dim:color-mix(in srgb,var(--dsw-alias-label-primary) 50%,transparent);" +
        "--mneme-accent:color-mix(in srgb,var(--dsw-alias-state-business-primary) 85%,var(--dsw-alias-label-primary));" +
        "--mneme-danger:color-mix(in srgb,var(--dsw-alias-state-error-primary) 80%,var(--dsw-alias-label-primary));" +
        "--mneme-warn:color-mix(in srgb,var(--dsw-static-amber-600,#dd8629) 65%,var(--dsw-alias-label-primary));" +
        "--mneme-ok:color-mix(in srgb,var(--dsw-static-green-500,#22c55e) 65%,var(--dsw-alias-label-primary));" +
        // Token 去向三屏（2026-10 可观测性改造）：图表六色全部单层 color-mix、
        // 基准只用宿主 token，test/contrast.test.js GRAPHICS 逐 selector 锁浅/深
        // ≥3:1。配比按 2026-10 审计数据校准（巩固 37% 是最大弧，占最深主色）。
        "--mneme-chart-1:color-mix(in srgb,var(--dsw-alias-state-business-primary) 70%,var(--dsw-alias-label-primary));" +
        "--mneme-chart-2:color-mix(in srgb,var(--dsw-static-green-500,#22c55e) 55%,var(--dsw-alias-label-primary));" +
        "--mneme-chart-3:color-mix(in srgb,var(--dsw-static-amber-600,#dd8629) 60%,var(--dsw-alias-label-primary));" +
        "--mneme-chart-4:color-mix(in srgb,var(--dsw-alias-state-error-primary) 65%,var(--dsw-alias-label-primary));" +
        "--mneme-chart-5:color-mix(in srgb,var(--dsw-static-green-500,#22c55e) 45%,var(--dsw-alias-state-business-primary));" +
        // chart-6 与 graphic-dim 同款但内联写：对比度解析器不递归 --mneme-* 变量。
        "--mneme-chart-6:color-mix(in srgb,var(--dsw-alias-label-primary) 50%,transparent);" +
        // 热力档位用 label 补余而非 transparent：transparent 混色在浅色主题下
        // 低档位对白底不足 3:1；label 补余两套主题各档都过线且单调。
        "--mneme-heat-1:color-mix(in srgb,var(--dsw-alias-state-business-primary) 85%,var(--dsw-alias-label-primary));" +
        "--mneme-heat-2:color-mix(in srgb,var(--dsw-alias-state-business-primary) 70%,var(--dsw-alias-label-primary));" +
        "--mneme-heat-3:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,var(--dsw-alias-label-primary));" +
        "--mneme-heat-4:color-mix(in srgb,var(--dsw-alias-state-business-primary) 40%,var(--dsw-alias-label-primary));" +
        // 几何刻度层（视觉系统 P0，docs/plans/2026-11-10-panel-visual-system.md）：
        // 颜色有 16 个 token 兜住，空间此前一个都没有——于是 padding 长出 107 种
        // 取值、只有 41.7% 落在 4 网格上、29% 是奇数像素。刻度按**像素值命名**
        // （--mneme-space-8 就是 8px），而不是 0..8 的档位号：
        // 档位号会让 gap:"4" 等于 8px，写的人要背一张表，读的人没法核对；
        // 值命名让调用点自解释，也让 test/panel-tokens.test.js 能用「允许的 px 集」
        // 直接校验，不需要第二份映射表。2 与 6 是 inline 半档（图标与文字之间）。
        "--mneme-space-0:0;" +
        "--mneme-space-2:2px;" +
        "--mneme-space-4:4px;" +
        "--mneme-space-6:6px;" +
        "--mneme-space-8:8px;" +
        "--mneme-space-12:12px;" +
        "--mneme-space-16:16px;" +
        "--mneme-space-20:20px;" +
        "--mneme-space-24:24px;" +
        // 圆角：全文件此前 borderRadius 声明 0 处（圆角全靠宿主，各页不统一）。
        "--mneme-radius-4:4px;" +
        "--mneme-radius-8:8px;" +
        "--mneme-radius-pill:999px;" +
        // 字号：现有 12/13/15 三种覆盖了绝大多数文本，把既有事实写成 token；
        // 10/14/18 仍散落在 133/61/52 处，属待迁移，不在此列（迁移要逐页视觉复核，
        // 全局替换会把紧凑列表撑开）。
        "--mneme-type-12:12px;" +
        "--mneme-type-13:13px;" +
        "--mneme-type-15:15px;" +
        "--mneme-weight-400:400;" +
        "--mneme-weight-600:600" +
      "}",
      ".mneme-x{flex:1;min-height:0;height:100%;width:100%;box-sizing:border-box;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);container-type:inline-size}",
      // 窄容器（better-sidebar 工作台 ~500px）下中央 vtabs 会与右缘悬浮的
      // 卡片/时间线切换器重叠：容器查询收窄时隐藏切换器，视图模式沿用
      // localStorage 记忆，宽容器（sheet）不受影响。
      "@container (max-width: 640px){.mneme-xtools .mneme-seg{display:none}}",
      ".mneme-xbar{position:relative;flex:none;display:flex;align-items:center;justify-content:center;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l2);padding:0 16px;min-height:52px}",
      ".mneme-filterbar{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".mneme-vtabs{display:flex;align-items:stretch;height:46px}",
      ".mneme-vtab{position:relative;border:0;background:none;cursor:pointer;padding:0 16px;color:var(--mneme-fg-dim);font-family:inherit;font-size:14px;font-weight:500;line-height:20px;display:inline-flex;align-items:center;gap:7px}",
      ".mneme-vtab:hover{color:var(--dsw-alias-label-primary)}",
      ".mneme-vtab.mneme-active{color:var(--mneme-accent)}",
      ".mneme-vtab.mneme-active::after{content:\"\";position:absolute;left:10px;right:10px;bottom:-1px;height:2.5px;border-radius:2px;background:var(--dsw-alias-state-business-primary)}",
      // transform 会自建层叠上下文：层级必须给在容器上——3 高于吸顶月份头(2)、
      // 低于详情抽屉(6)，下拉菜单/导入对话框随容器整体上浮。
      ".mneme-xtools{position:absolute;right:14px;top:50%;transform:translateY(-50%);display:flex;align-items:center;gap:8px;padding:0;z-index:3}",
      ".mneme-xcount{flex:none;font-size:12px;line-height:16px;color:var(--mneme-fg-dim);white-space:nowrap}",
    // 目录计数下面那行小字：说清「总数是全库、列表只列最近 N 个」，两个口径
    // 不一样不能只靠一个数字冒充（实体页此前就吃到这个亏）。
    ".mneme-xcountnote{font-size:11px;line-height:15px;color:var(--mneme-fg-dim);white-space:nowrap}",
      // --- three-column browse layout: hairline separators, no outer box ---
      ".mneme-xmain{flex:1;min-height:0;display:flex;flex-direction:row;overflow:hidden}",
      ".mneme-xside{flex:none;width:264px;min-width:0;min-height:0;overflow-y:auto;overflow-x:hidden;padding:16px 14px;border-right:1px solid var(--dsw-alias-border-l2);box-sizing:border-box;display:flex;flex-direction:column;gap:8px}",
      // 左栏下段=重要性+来源+热度：紧跟检索段之后（复验修订：不再钉底），
      // 顶部细线保留分段感；栏宽 264px 让 4 枚星级 chip 单行排布。
      ".mneme-xside-imp{flex:none;margin-top:10px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:8px}",
      // 内容区列容器 + 顶部工具条：类型 chips 横排 + 计数/刷新靠右；窄容器靠 wrap 换行。
      ".mneme-xcontent{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}",
      ".mneme-xbrowsebar{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      // 窄容器（better-sidebar 工作台 ~500px）：左栏收窄保内容区可用宽度。
      "@container (max-width: 640px){.mneme-xside{width:216px}}",
      // 类型筛选原为第二侧栏的竖排列表（三栏布局遗留，#面板两栏改版）：
      // 两栏化后收进内容区工具条，改为自适应横排 chips，彩点与计数保留。
      ".mneme-xtype{display:inline-flex;justify-content:flex-start;align-items:center;gap:7px;padding:4px 9px;border:none;border-radius:8px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:13px;line-height:18px;text-align:left}",
      ".mneme-xbrowse{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}",
      ".mneme-xrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".mneme-xsearch{width:100%}",
      ".mneme-xselect{flex:1;min-width:0}",
      ".mneme-xcolhead{flex:none;font-size:12px;font-weight:500;margin:0;color:var(--mneme-fg-dim);padding:2px 8px 8px}",
      ".mneme-xtype:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-xtype.mneme-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:500}",
      ".mneme-xcount2{flex:none;font-size:12px;color:var(--mneme-fg-dim)}",
      ".mneme-xmonth{display:flex;align-items:center;gap:4px;width:100%;padding:6px 8px 4px;border:none;border-radius:8px;background:none;color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;line-height:18px;text-align:left}",
      ".mneme-xmonth:first-child{margin-top:0}",
      ".mneme-xmonth:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-xcaret{flex:none;font-size:10px;color:var(--mneme-fg-dim);width:10px}",
      ".mneme-xday{display:flex;align-items:center;gap:4px;margin:6px 0 2px 22px;padding:2px 6px;border:none;border-radius:6px;background:none;font-family:inherit;font-size:12px;line-height:16px;color:var(--mneme-fg-dim);cursor:pointer;text-align:left}",
      ".mneme-xday:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".mneme-xitem{display:flex;gap:8px;align-items:baseline;width:calc(100% - 22px);margin-left:22px;padding:4px 8px;border:none;border-radius:8px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:13px;line-height:18px;text-align:left}",
      ".mneme-xitem:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-xitem.mneme-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}",
      ".mneme-xtime{flex:none;font-size:12px;line-height:16px;color:var(--mneme-fg-dim);font-variant-numeric:tabular-nums}",
      ".mneme-xname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".mneme-xempty{padding:18px 16px;text-align:center;color:var(--mneme-fg-dim);font-size:13px}",
      // --- memory-type color dots (mirrored across filter / timeline / detail) ---
      ".mneme-xdot{flex:none;display:inline-block;width:8px;height:8px;border-radius:50%;background:currentColor}",
      ".mneme-xdot--all{background:transparent;border:1.5px solid currentColor;opacity:.55;box-sizing:border-box}",
      ".mneme-xitem .mneme-xdot{align-self:center}",
      // --- detail column (preview pane sits BELOW the timeline: the list is
      // the primary scan target, the detail grows only when something is
      // selected so the empty state never eats the viewport) ---
      ".mneme-xdetail{flex:none;max-height:56%;min-height:0;overflow-y:auto;padding:12px 20px 16px;border-top:1px solid var(--dsw-alias-border-l2)}",
      ".mneme-xtree{flex:1;min-height:0;overflow-y:auto;padding:8px 10px 28px}",
      ".mneme-xdinner{max-width:720px}",
      ".mneme-xdtitle{font-size:16px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary);margin-bottom:10px;word-break:break-word}",
      ".mneme-xdmeta{display:flex;flex-wrap:wrap;gap:4px 14px;margin-bottom:6px;font-size:12px;line-height:18px;color:var(--mneme-fg-dim)}",
      ".mneme-xdsrc{display:inline-block;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}",
      ".mneme-xdcontent{margin-top:14px;font-size:14px;line-height:1.75;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}",
      ".mneme-xdactions{display:flex;gap:8px;margin-top:18px}",
      // --- graph sub-view (fills the content area under the tabs) ---
      ".mneme-graph{flex:1;min-height:0;width:100%;display:flex;flex-direction:column;padding:12px 16px 16px;box-sizing:border-box}",
      ".mneme-graphbar{display:flex;gap:8px;align-items:center;flex:none;margin-bottom:10px}",
      // touch-action 保持 none：图谱的拖拽与缩放只挂了 mousedown/mousemove/wheel，
      // 全仓 onPointerDown/onTouchStart 命中 0，所以在触屏上它本来就不是一个可交手势的
      // 面。改成 pan-y 会让纵向拖拽退回页面滚动——而浏览器在 touch-action:none 下会派发
      // 兼容鼠标事件，触屏纵向拖拽究竟走哪条路，没有真机无法定论；这一版不做无法复验的
      // 行为变更，留给出指针事件重写的那条车道。高度也不在这里限：480 主断点已压到
      // min(320px,52vh)，把 52vh 写进基础规则会在常见窗口高度（≈680px）下把桌面也压成
      // 353px，等于顺手改了大屏观感。
      ".mneme-graphsvg{flex:1;min-height:180px;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-button-elevated-fill);cursor:grab;touch-action:none}",
      ".mneme-gnode{cursor:pointer}",
      ".mneme-gnode circle{stroke:var(--dsw-alias-bg-layer-2);stroke-width:2;transition:stroke-width .12s}",
      ".mneme-gnode:hover circle{stroke-width:4}",
      ".mneme-gnode.mneme-groot circle{stroke:var(--dsw-alias-state-business-primary);stroke-width:3}",
      ".mneme-glabel{fill:var(--dsw-alias-label-secondary);font-size:11px;text-anchor:middle;pointer-events:none;user-select:none}",
      ".mneme-gedge{stroke:var(--mneme-graphic-dim);stroke-width:1.5;cursor:pointer}",
      ".mneme-gedge:hover{stroke:var(--dsw-alias-state-business-primary)}",
      // 虚线态靠 dash 图案区分，不再叠 opacity：50% 的描边再乘 .7 后浅色画布上
      // 只剩 2.28，低于图形要求的 3:1（图案已经承担了「没有 memory_id」这个语义）。
      ".mneme-gedge-dashed{stroke-dasharray:5 4}",
      // 图谱与图内侧卡的共同父容器：侧卡改浮层（#面板实体页去冗余）后需要
      // relative 锚点，否则 absolute 会逃逸到 .mneme-ent 根。
      ".mneme-entgraphwrap{position:relative;min-width:0}",
      // 侧卡从「SVG 下方文档流堆叠」（把图挤成邮票）改为图内左下浮层：
      // 反应面板与点击焦点同位，SVG 不再被推挤；背景用不透明 bg-layer-1，
      // 浮层下透出的图形不参与文字对比度计算。
      ".mneme-graphside{position:absolute;left:12px;bottom:12px;width:min(300px,60%);max-height:60%;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;z-index:2}",
      ".mneme-gs-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:4px;display:flex;justify-content:space-between;align-items:baseline;gap:8px}",
      ".mneme-gs-meta{font-size:13px;color:var(--mneme-fg-dim);margin-bottom:6px}",
      ".mneme-gs-link{display:block;width:100%;text-align:left;border:none;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:13px;padding:3px 6px;border-radius:6px;word-break:break-word}",
      ".mneme-gs-link:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      // --- entity explorer: rail + layered detail (entities → attrs → relations → graph) ---
      ".mneme-ent{flex:1;min-height:0;display:flex;overflow:hidden}",
      ".mneme-entrail{flex:none;width:224px;min-height:0;overflow:hidden;padding:12px 0 0;border-right:1px solid var(--dsw-alias-border-l2);box-sizing:border-box;display:flex;flex-direction:column}",
      // 复验修订：搜索与计数固定在顶部不随列表滚动，列表独立滚动；
      // 类型分组头 sticky——长列表滚动时分组归属始终可见。
      ".mneme-entrailhead{flex:none;padding:0 12px 10px;display:flex;flex-direction:column;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".mneme-entrailbody{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:4px 12px 12px;display:flex;flex-direction:column;gap:4px}",
      ".mneme-enttype{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-1);display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:8px 8px 2px;border:none;color:var(--mneme-fg-dim);cursor:pointer;font-family:inherit;font-size:11px;font-weight:600;line-height:16px;text-align:left;letter-spacing:.02em}",
      ".mneme-entitem{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:5px 8px;border:none;border-radius:8px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:13px;line-height:18px;text-align:left}",
      ".mneme-entitem:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-entitem.mneme-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}",
      ".mneme-entname{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".mneme-entmentions{flex:none;font-size:11px;color:var(--mneme-fg-dim);font-variant-numeric:tabular-nums}",
      ".mneme-entdetail{flex:1;min-width:0;min-height:0;overflow-y:auto;padding:20px 24px 32px;box-sizing:border-box}",
      ".mneme-entinner{max-width:720px}",
      ".mneme-enttitle{display:flex;align-items:center;gap:10px;font-size:17px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary);word-break:break-word}",
      ".mneme-enttitle .mneme-xdot{width:10px;height:10px}",
      ".mneme-entmeta{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px;font-size:12px;line-height:18px;color:var(--mneme-fg-dim)}",
      ".mneme-layer{margin-top:24px}",
      ".mneme-layerhead{display:flex;align-items:baseline;gap:8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:10px}",
      ".mneme-layercount{font-size:12px;font-weight:400;color:var(--mneme-fg-dim)}",
      // 属性网格同理：min(200px,100%) 的 100% 兜底压在基础规则上，实体页 detail 在
      // 481–519px 只剩 257–276px（rail 仍占 224px 横排），裸 200px 下限会溢出。
      ".mneme-attrgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(200px,100%),1fr));gap:8px}",
      ".mneme-attrcard{min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 12px}",
      ".mneme-attrkey{font-size:11px;color:var(--mneme-fg-dim);margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".mneme-attrval{font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary);word-break:break-word}",
      ".mneme-relrow{display:flex;align-items:center;gap:10px;width:100%;padding:7px 10px;border:none;border-radius:10px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:13px;line-height:20px;text-align:left}",
      ".mneme-relrow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-reltype{flex:none;font-size:11px;line-height:16px;color:var(--mneme-accent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 35%,transparent);border-radius:6px;padding:0 6px}",
      ".mneme-relname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      // #619 可见化 B：情感边上的情绪词。刻意不加新色相——沿用 accent 的淡色调，
      // 因为它是「同一条边上的附加信息」，不是新的边类别；加色相会让人以为
      // affective_context 是第三种关系。trait 档只把字号/字重提一档，用来区分
      // 「一次场合」和「一贯倾向」，两档仍然同色。
      ".mneme-relaffect{flex:none;font-size:11px;line-height:16px;color:var(--mneme-fg-dim);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:0 6px;max-width:9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".mneme-relaffect--trait{color:var(--mneme-accent);font-weight:600}",
      // #619 可见化 C：情绪归因一览。沿用面板既有色，不引入新色相——
      // trait 用 accent 加重，其余靠灰阶分层，跟关系行那颗小标签是同一套语汇。
      ".mneme-affective-head{margin-bottom:10px}",
      ".mneme-affective-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".mneme-affective-sub{font-size:12px;color:var(--mneme-fg-dim);margin-top:2px;line-height:1.5}",
      ".mneme-affective-list{display:flex;flex-direction:column;gap:6px;margin-top:8px}",
      ".mneme-affective-row{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 10px}",
      ".mneme-affective-row--trait{border-color:var(--mneme-accent)}",
      ".mneme-affective-main{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:13px}",
      ".mneme-affective-emotion{font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".mneme-affective-row--trait .mneme-affective-emotion{color:var(--mneme-accent)}",
      ".mneme-affective-arrow{color:var(--mneme-fg-dim)}",
      ".mneme-affective-target{color:var(--dsw-alias-label-primary)}",
      ".mneme-affective-tag{flex:none;font-size:11px;line-height:16px;color:var(--mneme-fg-dim);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:0 6px}",
      ".mneme-affective-tag--trait{color:var(--mneme-accent);border-color:var(--mneme-accent);font-weight:600}",
      ".mneme-affective-meta{font-size:11px;color:var(--mneme-fg-dim);margin-top:3px}",
      ".mneme-affective-empty{font-size:12px;color:var(--mneme-fg-dim);line-height:1.6;padding:10px 0}",
      ".mneme-affective-empty--error{color:var(--mneme-danger)}",
      ".mneme-affective-note{font-size:11px;color:var(--mneme-fg-dim);margin-top:8px}",
      ".mneme-gs-affective{margin-top:2px}",
      // issue #24 块4 复核面：抬过的边。用虚线边色（--mneme-graphic-dim 同层）
      // 而不是新增颜色——它表达的是「同一条边，只是被用过」，不是新类别。
      ".mneme-boosted{margin-top:6px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l2)}",
      ".mneme-boostedbody{margin-top:6px}",
      ".mneme-boostedrow{cursor:default;font-size:12px;line-height:18px;padding:5px 10px}",
      ".mneme-boostedrow:hover{background:none}",
      ".mneme-boostedgain{font-size:11px;color:var(--mneme-accent)}",
      // --- settings: quiet stacked sections, one concern per section ---
      ".mneme-set{flex:1;min-height:0;overflow-y:auto;padding:8px 24px 48px;box-sizing:border-box}",
      ".mneme-set-inner{max-width:720px;margin:0 auto}",
      // 设置页各节一律用 boxed 卡（.mneme-set-card）+ 分组标题（.mneme-set-grouphead）：
      // 旧的「无框 set-sec + 有框 set-card」混排是版面杂乱的一半来源
      ".mneme-set-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:4px}",
      ".mneme-set-desc{font-size:13px;line-height:19px;color:var(--mneme-fg-dim);margin-bottom:14px}",
      ".mneme-set-input{box-sizing:border-box;width:100%;height:34px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;outline:none;margin-bottom:10px;transition:border-color .12s,box-shadow .12s}",
      ".mneme-set-input:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent)}",
      ".mneme-set-input::placeholder{color:var(--mneme-fg-dim)}",
      ".mneme-set-input--area{height:auto;min-height:76px;padding:8px 12px;resize:vertical;line-height:1.6}",
      ".mneme-btn{flex:none;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;font-size:12px;line-height:16px;display:inline-flex;align-items:center;gap:6px}",
      ".mneme-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-btn:disabled{opacity:.5;cursor:default}",
      ".mneme-saved{font-size:12px;color:var(--mneme-ok)}",
      // rule rows: numbered chips + hover-revealed delete
      ".mneme-set-row{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;margin-bottom:8px;background:var(--dsw-alias-bg-base,transparent)}",
      ".mneme-set-idx{flex:none;width:20px;height:20px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);color:var(--mneme-fg-dim);font-size:11px;line-height:18px;display:inline-flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}",
      ".mneme-set-ruletext{flex:1;min-width:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);word-break:break-word}",
      ".mneme-set-del{flex:none;opacity:0;transition:opacity .12s;border:none;background:none;color:var(--mneme-fg-dim);cursor:pointer;font-size:14px;line-height:20px;padding:0 4px;border-radius:6px}",
      ".mneme-set-row:hover .mneme-set-del,.mneme-set-row:focus-within .mneme-set-del{opacity:1}",
      ".mneme-set-del:hover{color:var(--mneme-danger);background:var(--dsw-alias-interactive-bg-hover)}",
      // 人格卡删除 × 独立类：不复用 mneme-set-del——其 opacity:0 仅在
      // .mneme-set-row:hover 解除，卡标签不在该容器里 → × 永远透明（v1.2
      // 实测踩中）。#457 曾用内联 opacity:1 覆写，但悬停变红仍走
      // .mneme-set-del:hover，连带常点亮了规则区的真删除按钮，被 #459 回滚。
      // 独立类常显，只沿用配色，规则区行为分毫不动。
      ".mneme-persona-del{flex:none;opacity:1;border:none;background:none;color:var(--mneme-fg-dim);cursor:pointer;font-size:16px;line-height:18px;padding:0 3px;border-radius:6px}",
      ".mneme-persona-del:hover{color:var(--mneme-danger);background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-set-cmd{flex:1;min-width:0}",
      ".mneme-set-cmdname{font-size:13px;font-weight:600;color:var(--mneme-accent)}",
      ".mneme-set-cmddesc{font-size:12px;line-height:17px;color:var(--mneme-fg-dim);margin-top:1px;word-break:break-word}",
      // --- settings sub-view ---
      ".mneme-set{flex:1;min-height:0;overflow-y:auto;padding:8px 24px 48px;box-sizing:border-box}",
      // --- 宿主中列整页面板（sidebar.panellist + main 成对座位）---
      // 宿主把 main 槽渲染在三列 grid 的中列里，那一层只给了 min-width:0 与
      // overflow:hidden，没有任何尺寸约束——注册者必须自己铺满并自管滚动，
      // 否则内容会撑破中列（右栏打开时中列更窄，宽度还会变）。
      ".mneme-panel{box-sizing:border-box;flex:1;min-width:0;min-height:0;width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}",
      // 侧栏图标容器：badge 用绝对定位挂在它上面。宿主 panelRow 没有
      // overflow:hidden，所以 -3px 的偏移不会被裁；这里的 position:relative
      // 只提供定位上下文，不接管尺寸（由宿主的 panelGlyph 决定）。
      ".mneme-paneliglyph{position:relative;display:inline-flex;align-items:center;justify-content:center}",
      // --- chorography 面板（仓库地志）：顶栏检索 + 左树右文。颜色全部引用
      // 既有语义层（--dsw-alias-* 正文/边框、--mneme-fg-dim 弱化），不引入新
      // 字面量色——contrast.test.js 会重算每一条 color 声明。内容渲染挂在
      // .mneme-panel 根内（#562 的中列整页容器），不新增渲染根。
      ".mneme-wikibar{flex:none;display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}",
      ".mneme-wikirepo{flex:none;max-width:40%;font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      // 重建骨架按钮（收尾档 P34）与回执行：语义色层，无新字面量色。
      ".mneme-wikibtn{flex:none;height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;font-size:12px;line-height:26px;transition:border-color .12s}",
      ".mneme-wikibtn:hover{border-color:var(--dsw-alias-state-business-primary)}",
      ".mneme-wikibtn:disabled{opacity:.5;cursor:default}",
      ".mneme-wikirebuildnote{flex:1;min-width:0;font-size:11.5px;line-height:16px;color:var(--mneme-fg-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".mneme-wikisearch{flex:1;min-width:0;height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px;outline:none;transition:border-color .12s}",
      ".mneme-wikisearch:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent)}",
      ".mneme-wikibody{flex:1;min-height:0;display:flex;overflow:hidden}",
      ".mneme-wikitree{flex:none;width:232px;overflow-y:auto;border-right:1px solid var(--dsw-alias-border-l1);padding:10px 6px}",
      ".mneme-wikitreeitem{display:block;width:100%;text-align:left;border:none;background:none;cursor:pointer;font-family:inherit;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);padding:5px 8px;border-radius:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .12s}",
      ".mneme-wikitreeitem:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".mneme-wikitreeitem.mneme-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:500}",
      ".mneme-wikipage{flex:1;min-width:0;overflow-y:auto;padding:18px 22px 44px;color:var(--dsw-alias-label-primary)}",
      ".mneme-wikipage h2,.mneme-wikipage h3,.mneme-wikipage h4,.mneme-wikipage h5{margin:18px 0 8px;color:var(--dsw-alias-label-primary);line-height:1.35}",
      ".mneme-wikipage h2{font-size:17px;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:6px}",
      ".mneme-wikipage h3{font-size:15px}",
      ".mneme-wikipage h4,.mneme-wikipage h5{font-size:13.5px}",
      ".mneme-wikipage p{margin:6px 0;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary)}",
      ".mneme-wikipage ul,.mneme-wikipage ol{margin:6px 0;padding-left:22px}",
      ".mneme-wikipage li{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);margin:3px 0}",
      ".mneme-wikipre{margin:10px 0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));overflow-x:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);white-space:pre}",
      ".mneme-wikicode{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-active);border-radius:4px;padding:1px 5px}",
      // 表格（v0.11.1 美化）：真 table 替代竖线等宽行；文件清单第一列路径走
      // code 底色，行数列右对齐等宽数字；斑马纹用 3% 前景混色，不引新字面量色。
      ".mneme-wikitable{width:100%;border-collapse:collapse;margin:10px 0 14px;font-size:12.5px}",
      ".mneme-wikitable th{padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-weight:500;text-align:left;white-space:nowrap}",
      ".mneme-wikitable td{padding:5px 10px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);vertical-align:top}",
      ".mneme-wikitable tbody tr:nth-child(even){background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,transparent)}",
      ".mneme-wikitable tbody tr:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,transparent)}",
      ".mneme-wikitable td .mneme-wikicode{background:none;padding:0}",
      ".mneme-wikinum{text-align:right;font-variant-numeric:tabular-nums}",
      ".mneme-wikiquote{margin:8px 0 14px;padding:8px 12px;border-left:3px solid var(--dsw-alias-border-l2);color:var(--mneme-fg-dim);font-size:12px;line-height:18px}",
      ".mneme-wikiempty{padding:26px 22px;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:8px;overflow-y:auto}",
      ".mneme-wikiemptytitle{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".mneme-wikihits{position:absolute;inset-inline:22px;top:8px;z-index:3;display:flex;flex-direction:column;gap:4px;max-height:46%;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:8px;box-shadow:0 10px 28px color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent)}",
      ".mneme-wikihit{text-align:left;border:none;background:none;cursor:pointer;font-family:inherit;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);padding:5px 7px;border-radius:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".mneme-wikihit:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".mneme-wikihitsclose{flex:none;align-self:flex-end;border:none;background:none;cursor:pointer;color:var(--mneme-fg-dim);font-size:15px;line-height:16px;padding:0 4px}",
      // 相对定位由 .mneme-panel 提供？它没有——检索浮层需要定位上下文，给页面列加
      // position:relative（不能动 .mneme-panel 本身：记忆面板还挂在同一根上）。
      ".mneme-wikipage{position:relative}",
      // #607：空态里的「填路径 → 生成」那一行；宽度跟着空态列走，输入框吃掉
      // 剩余空间，按钮不吃（按钮换行会让空态看着像表单坏了）。
      ".mneme-wikirunrow{display:flex;align-items:center;gap:8px;margin-top:4px}",
      ".mneme-wikirunwide{flex:1;min-width:0;white-space:normal}",
      ".mneme-wikicli{margin-top:10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
      ".mneme-wikicli summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12.5px}",
      ".mneme-wikicli summary:hover{color:var(--dsw-alias-label-primary)}",
      ".mneme-wikiclihint{margin:6px 0 0;font-size:11.5px;line-height:17px;color:var(--mneme-fg-dim)}",
      // 开关按钮的激活态只改边框，不改前景色：wikibar 的底色是 bg-layer-1，
      // 叠一层强调色块会跟右侧徽章抢注意力；而把 color 换成强调色会让正文掉到
      // AA 以下（contrast.test.js 的主锁实测 1.00），所以状态字面靠「✓」承担。
      ".mneme-wikitoggle.mneme-on{border-color:var(--dsw-alias-state-business-primary)}",
      ".mneme-wikistale{margin-inline-end:2px}",
      ".mneme-wikit1bar{flex:none;padding:6px 16px;border-top:1px solid var(--dsw-alias-border-l2);font-size:11.5px;line-height:16px;color:var(--mneme-fg-dim);background:var(--dsw-alias-bg-layer-1)}",
      // --- 知识库页（契约 §3.6）---
      // 左列复用 wikitree 的宽度与分隔线，只是树项改成了集合行；右边沿用
      // wikipage 的阅读排版。颜色全部走语义层，不新增任何宿主 token。
      ".mneme-kbcol{display:flex;flex-direction:column;gap:2px;overflow-y:auto;padding:8px}",
      ".mneme-kbcolhead{margin:0;font-size:11.5px;line-height:17px;color:var(--mneme-fg-dim)}",
      ".mneme-kbcolnew{display:flex;flex-direction:column;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}",
      ".mneme-kbkey{height:28px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font-size:12.5px}",
      ".mneme-kbform{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px}",
      ".mneme-kbsechead{margin-top:16px;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".mneme-kbdocrow{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;padding:6px 0;border-top:1px solid var(--dsw-alias-border-l1)}",
      ".mneme-kbdoctitle{font-size:12.5px;color:var(--dsw-alias-label-primary)}",
      ".mneme-kbdocmeta{font-size:11.5px;line-height:17px;color:var(--mneme-fg-dim)}",
      // 仓库卡片（照 Qoder 的 Repo Wiki 卡片做的）：自适应列，卡片只承载「是哪个仓库、
      // 有几页、整理了几页」和一颗按钮，不塞正文——点进去才是内容。
      // auto-fit 而不是 auto-fill：只有一个仓库时卡片要铺满整行，
      // auto-fill 会把空轨道留着，单张卡片只占 1/3 宽，看着像被裁了。
      ".mneme-kbrepolist{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:8px;margin-top:8px}",
      ".mneme-kbrepo{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px}",
      ".mneme-kbrepohead{display:flex;align-items:center;gap:6px;min-width:0}",
      ".mneme-kbreponame{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".mneme-kbrepometa{display:flex;flex-wrap:wrap;gap:8px;font-size:11.5px;line-height:17px;color:var(--mneme-fg-dim)}",
      ".mneme-kbrepopath{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".mneme-kbreporun{align-self:flex-start}",
      // 批量整理的失败明细：toast 只有 2.5 秒，失败页名字一多就读不完，留在页面上。
      ".mneme-kbfails{margin-top:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}",
      ".mneme-kbadvtoggle{margin-top:14px;align-self:flex-start}",
      // --- 记忆库页面：居中 sheet，非全屏 ---
      // 从对话直接打开一页记忆库：背板压暗 + 居中圆角卡片（上限 1180×880），
      // 对话仍留在背板之后，任何状态下（含新会话 hero、无 tab 环）都可用。
      // portal 到 <body>，宿主侧边栏的层叠上下文裁不住它。
      ".mneme-backdrop{position:fixed;inset:0;z-index:999;background:color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);backdrop-filter:blur(2px);animation:mneme-fadein .14s ease-out}",
      ".mneme-overlay{position:fixed;z-index:1000;left:50%;top:50%;transform:translate(-50%,-50%);width:min(1240px,calc(100vw - 88px));height:min(920px,calc(100vh - 64px));display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);box-shadow:0 24px 64px color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent);animation:mneme-pop .18s cubic-bezier(.2,.9,.3,1)}",
      ".mneme-overlaybar{flex:none;display:flex;align-items:center;justify-content:space-between;height:48px;padding:0 12px 0 18px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".mneme-overlaytitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:8px}",
      ".mneme-overlaybody{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}",
      "@keyframes mneme-fadein{from{opacity:0}to{opacity:1}}",
      "@keyframes mneme-pop{from{opacity:0;transform:translate(-50%,-50%) scale(.98)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}",
      // --- 侧边栏顶部入口：借宿主「新会话」按钮的原生类名对齐 ---
      // wrapper display:contents 隐身，按钮成为侧边栏弹性布局的直接子元素；
      // 盒模型/间距/收起态 rail 几何全部继承宿主，我们只覆盖配色为次级观感。
      ".mneme-stars{display:inline-flex;align-items:center;gap:2px}",
      // 热度徽章三档：热（橙）/温（次级文字）/冷（弱化文字），冷档藏百分比只留图标。
      ".mneme-heat{display:inline-flex;align-items:center;gap:2px;font-size:11px;line-height:14px;font-variant-numeric:tabular-nums}",
      ".mneme-heat--hot{color:var(--mneme-warn)}",
      ".mneme-heat--warm{color:var(--dsw-alias-label-secondary)}",
      ".mneme-heat--cold{color:var(--mneme-fg-dim)}",
      ".mneme-heat--cold .mneme-heatpct{display:none}",
      // 侧边栏入口两种形态的样式（挂载与搬移逻辑见 SidebarTopEntry 的头注释）。
      // 展开态兜底：逐条镜像宿主 panelRow（36px 行高 / 透明底 / 2px 外边距 /
      // 7px 8px 内边距）——宿主面板行类名在或不在，观感都是「插件 / 自动化任务」
      // 那一档，不会再退回 v0.8.10 那种高亮大按钮。
      // 收起态：按钮带宿主 newSession 类名，标题栏固定几何（position:fixed、
      // 顶部居中、28px 圆钮、次级文字色、hover 填充）整套继承宿主规则，我们只用
      // 一条更具体的规则把 left 从宿主的 48px 推到 84px——即「新会话」右侧，
      // 不再像 v0.8.10 那样压在它身上（用户实测确认的遮挡 bug）。
      // 84 = 48（宿主给「新会话」的 left）+ 28（钮宽）+ 8（间距）；120 = 84 + 28 + 8，
      // 让「应用 / 编辑」菜单顺延到我们右侧。宿主侧出处：SidebarRoot.module.css 的
      // `.collapsed .newSession{left:48px}` 与
      // `html[data-windows-titlebar]:has([data-sidebar-collapsed=true]){--dsh-windows-menu-start:84px}`。
      ".mneme-topentry{display:flex;flex-direction:column;position:relative}",
      ".mneme-topentry-native{box-sizing:border-box;min-height:36px;border:none;border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;align-items:center;gap:8px;margin:0 2px;padding:7px 8px;line-height:22px;display:flex}",
      ".mneme-topentry-native:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".mneme-topentry-native:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}",
      ".mneme-topentry-native .mneme-topentry-label{white-space:nowrap}",
      "html[data-windows-titlebar] .mneme-topentry .mneme-topentry-rail{left:84px}",
      // 菜单让位只在「收起 + 入口确实挂在标题栏里」时生效；展开态完全不碰宿主变量。
      "html[data-windows-titlebar]:has([data-sidebar-collapsed=true]):has([data-plugin-entry=\"@modusensus/dsh-mneme\"]){--dsh-windows-menu-start:120px}",
      // --- 功能开关：一行一开关，Claude 式安静排版 ---
      ".mneme-featgroup{flex:none;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--mneme-fg-dim);margin:16px 0 2px}",
      ".mneme-featrow{display:flex;align-items:center;gap:14px;padding:11px 2px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".mneme-featrow:last-child{border-bottom:none}",
      ".mneme-featmain{flex:1;min-width:0}",
      ".mneme-featname{font-size:13.5px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}",
      ".mneme-feathint{font-size:12.5px;line-height:18px;color:var(--mneme-fg-dim);margin-top:2px}",
      ".mneme-switch{position:relative;flex:none;width:36px;height:22px;border-radius:11px;border:none;cursor:pointer;background:var(--dsw-alias-interactive-bg-active);transition:background .15s}",
      ".mneme-switch::after{content:\"\";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 3px color-mix(in srgb,var(--dsw-alias-label-primary) 25%,transparent);transition:transform .15s}",
      ".mneme-switch.mneme-on{background:var(--dsw-alias-state-business-primary)}",
      ".mneme-switch.mneme-on::after{transform:translateX(14px)}",
      ".mneme-switch:disabled{opacity:.5;cursor:default}",
      ".mneme-featnum{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 2px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".mneme-featnum:last-child{border-bottom:none}",
      ".mneme-featnumlabel{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}",
      ".mneme-numinput{box-sizing:border-box;width:110px;height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;outline:none;text-align:right;transition:border-color .12s,box-shadow .12s}",
      ".mneme-numinput:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent)}",
      // 字符串开关的输入框（provider/model 等）与其子块容器
      ".mneme-strinput{box-sizing:border-box;width:240px;max-width:60%;height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;outline:none;text-align:left;transition:border-color .12s,box-shadow .12s}",
      ".mneme-strinput:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent)}",
      ".mneme-featsub{margin:2px 0 8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;display:flex;flex-direction:column;gap:6px}",
      ".mneme-featsub .mneme-featnum{padding:6px 0;border-bottom:none}",
      ".mneme-featsubhint{font-size:12px;line-height:17px;color:var(--mneme-fg-dim)}",
      // 运行时那一块的说明文字：比常规 hint 再小一档，它是背景信息而不是要读的正文。
      ".mneme-runtimehint{font-size:11px;line-height:16px;color:var(--mneme-fg-dim)}",
      // --- 交互式记忆库：工具栏 / 卡片网格 / 详情抽屉 / 更多菜单 ---
      // sheet 边距放宽：与窗口边缘保持呼吸距离，居中不顶满。
      // 视图切换（卡片/时间线）分段控件挂在子页栏右侧。
      ".mneme-seg{display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}",
      ".mneme-seg button{border:none;background:none;color:var(--mneme-fg-dim);cursor:pointer;font-family:inherit;font-size:12px;line-height:16px;padding:5px 10px;display:inline-flex;align-items:center;gap:5px}",
      ".mneme-seg button:hover{color:var(--dsw-alias-label-primary)}",
      ".mneme-seg button.mneme-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:500}",
      // 卡片网格：响应式 auto-fill，卡片悬停轻浮起。
      // 轨道下限用 min(252px,100%) 而不是裸 252px：容器（.mneme-xcontent）只有
      // 265–294px 时裸下限仍要求 300px 轨道，网格横向溢出 2–11px 被外层 overflow:hidden
      // 切掉。这个洞出现在 481–519px——480 主断点之外、两栏又放不下的中间带，所以
      // 兜底必须落在基础规则上，只在断点里写等于给中间带留缺口。
      ".mneme-cards{flex:1;min-height:0;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(252px,100%),1fr));gap:14px;padding:20px 24px 32px;align-content:start}",
      ".mneme-card{display:flex;flex-direction:column;gap:7px;min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 13px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;font-family:inherit;text-align:left;transition:border-color .12s,box-shadow .12s,transform .12s}",
      ".mneme-card:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,var(--dsw-alias-border-l2));box-shadow:0 6px 20px color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);transform:translateY(-1px)}",
      ".mneme-card.mneme-active{border-color:var(--dsw-alias-state-business-primary)}",
      ".mneme-cardhead{display:flex;align-items:center;gap:6px;font-size:11.5px;line-height:16px;color:var(--mneme-fg-dim)}",
      ".mneme-cardtitle{font-size:13.5px;font-weight:600;line-height:19px;color:var(--dsw-alias-label-primary);word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
      ".mneme-cardexcerpt{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}",
      ".mneme-cardfoot{display:flex;align-items:center;gap:8px;margin-top:auto;font-size:11.5px;line-height:16px;color:var(--mneme-fg-dim)}",
      ".mneme-cardsrc{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      // 徽章：冲突待确认 / 已归档
      ".mneme-badge{flex:none;display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 7px;border-radius:6px;font-size:11px;line-height:14px}",
      ".mneme-badge--conflict{color:var(--mneme-danger);background:color-mix(in srgb,var(--mneme-danger) 10%,transparent);border:1px solid color-mix(in srgb,var(--mneme-danger) 30%,transparent)}",
      ".mneme-badge--archived{color:var(--mneme-fg-dim);background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-badge--scope{color:var(--mneme-accent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 30%,transparent)}",
      // 「默认 / 已改」徽标（#427）：default 复用 --archived 的语义色组合
      // （fg-dim on interactive-bg-hover），changed 复用 --scope 的 accent 组
      // 合——两组配对都已过 contrast.test.js 的重算，不再发明新颜色。
      ".mneme-badge--default{color:var(--mneme-fg-dim);background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-badge--changed{color:var(--mneme-accent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 30%,transparent)}",
      // 冲突集中处理队列（v0.8.0）：状态页的待确认冲突列表
      ".mneme-conflictq{display:flex;flex-direction:column;gap:10px}",
      ".mneme-conflictq-head{display:flex;align-items:center;gap:8px}",
".mneme-conflictq-truncated{flex:1;font-size:12px;line-height:16px;color:var(--mneme-fg-dim);text-align:right}",
      ".mneme-conflict-item{border:1px solid var(--dsw-alias-border-l1,var(--dsw-alias-interactive-bg-hover));border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px}",
      ".mneme-conflict-reason{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}",
      ".mneme-conflict-pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}",
      ".mneme-conflict-side{border:1px solid var(--dsw-alias-border-l1,var(--dsw-alias-interactive-bg-hover));border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:4px;min-width:0}",
      ".mneme-conflict-sidelabel{font-size:11px;color:var(--mneme-fg-dim)}",
      ".mneme-conflict-sidetitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".mneme-conflict-snippet{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}",
      ".mneme-conflict-missing{font-size:12px;color:var(--mneme-fg-dim)}",
      ".mneme-conflict-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".mneme-conflict-hint{font-size:11px;color:var(--mneme-fg-dim);margin-right:auto}",
      // #177 冲突队列视觉批次：A/B 侧色、相似度条、词级 diff、主色按钮、空态
      ".mneme-conflict-side--a{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 4%,transparent)}",
      ".mneme-conflict-side--a .mneme-conflict-sidelabel{color:var(--mneme-accent);font-weight:600}",
      ".mneme-conflict-side--b{border-color:color-mix(in srgb,var(--mneme-warn) 45%,transparent);background:color-mix(in srgb,var(--mneme-warn) 5%,transparent)}",
      ".mneme-conflict-side--b .mneme-conflict-sidelabel{color:var(--mneme-warn);font-weight:600}",
      ".mneme-conflict-simrow{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary)}",
      ".mneme-conflict-simbar{position:relative;flex:1;height:5px;border-radius:3px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}",
      ".mneme-conflict-simfill{position:absolute;top:0;bottom:0;left:0;border-radius:3px;background:var(--dsw-alias-state-business-primary)}",
      ".mneme-conflict-diff{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}",
      // 展开全文：取消行数钳制并给一个内部滚动区——报障点是「窗口太小又不能
      // 放大，完全对比不了内容」，所以展开态必须能容纳长文本且不撑破面板。
      // 上限用 em 而非 vh：宿主可能把面板放在零高视口里（隐藏 webview / 后台
      // 页），那时 46vh 会算成 0px，展开态直接看不见字——实测踩过。
      ".mneme-conflict-diff--full{display:block;-webkit-line-clamp:unset;max-height:28em;overflow-y:auto}",
      ".mneme-conflict-text{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere;max-height:28em;overflow-y:auto}",
      ".mneme-conflict-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--mneme-fg-dim)}",
      ".mneme-conflict-metaval{color:var(--dsw-alias-label-secondary)}",
      // 窄面板下并排会把每侧挤到无法阅读，退成单列（容器查询按面板实际宽度判）
      "@container (max-width:560px){.mneme-conflict-pair{grid-template-columns:1fr}}",
      ".mneme-conflict-mark{text-decoration:none;border-radius:3px;padding:0 1px}",
      ".mneme-conflict-mark--del{background:color-mix(in srgb,var(--mneme-danger) 16%,transparent);text-decoration:line-through}",
      ".mneme-conflict-mark--ins{background:color-mix(in srgb,var(--mneme-ok) 18%,transparent)}",
      ".mneme-conflict-primary{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 10px;border-radius:8px;border:none;background:var(--mneme-accent);color:var(--dsw-alias-bg-layer-1);cursor:pointer;font-family:inherit;font-size:12px;line-height:16px}",
      ".mneme-conflict-primary:disabled{opacity:.55;cursor:default}",
      ".mneme-conflict-primary:hover:not(:disabled){background:color-mix(in srgb,var(--mneme-accent) 85%,var(--dsw-alias-label-primary))}",
      ".mneme-badge--frozen{color:var(--mneme-warn);background:color-mix(in srgb,var(--mneme-warn) 12%,transparent)}",
      // 「待重启」徽标：沿用 frozen 的 warn 语义（都是「现状不是你刚设的样子」），
      // 但加边框把它和只读冻结态区分开——它需要用户动手，不是终态。
      ".mneme-badge--pending{color:var(--mneme-warn);background:color-mix(in srgb,var(--mneme-warn) 12%,transparent);border:1px solid color-mix(in srgb,var(--mneme-warn) 30%,transparent)}",
      ".mneme-pending{display:flex;align-items:flex-start;gap:8px;margin:8px 0 0;padding:8px 10px;border-radius:8px;font-size:12.5px;line-height:18px;color:var(--mneme-warn);background:color-mix(in srgb,var(--mneme-warn) 10%,transparent);border:1px solid color-mix(in srgb,var(--mneme-warn) 28%,transparent)}",
      // 圆点用当前色（currentColor）而不是再引一次 --mneme-warn：色值只有一个真源，
      // 改主题时提示行与圆点不会走散。
      ".mneme-pending-dot{flex:none;width:6px;height:6px;margin-top:6px;border-radius:50%;background:currentColor}",
      ".mneme-conflict-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:4px}",
      ".mneme-conflict-empty-title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
      ".mneme-conflict-empty-body{font-size:12px;line-height:18px;color:var(--mneme-fg-dim)}",
      ".mneme-statuscard--actionable{border-color:color-mix(in srgb,var(--mneme-warn) 55%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--mneme-warn) 35%,transparent)}",
      ".mneme-entrybadge{position:absolute;top:-3px;right:-3px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--mneme-danger);color:var(--dsw-alias-bg-layer-1,#fff);font-size:10.5px;line-height:16px;font-weight:600;text-align:center;box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1)}",
      ".mneme-triggerwrap{position:relative;pointer-events:none}",
      ".mneme-triggerwrap .mneme-trigger{pointer-events:auto}",
      ".mneme-conflict-jump .mneme-statuscard{border-color:color-mix(in srgb,var(--mneme-warn) 55%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--mneme-warn) 35%,transparent)}",
      ".mneme-conflict-jump:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:12px}",
      // 详情抽屉：sheet 内右侧滑出，覆盖在浏览区之上
      ".mneme-xmain{position:relative}",
      "@keyframes mneme-slidein{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:translateX(0)}}",
      ".mneme-drawer{position:absolute;top:0;right:0;bottom:0;width:min(432px,52%);display:flex;flex-direction:column;border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:-16px 0 40px color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);animation:mneme-slidein .18s ease-out;z-index:6}",
      ".mneme-drawerbar{flex:none;display:flex;align-items:center;gap:8px;height:44px;padding:0 10px 0 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".mneme-drawertype{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-secondary)}",
      ".mneme-drawerbody{flex:1;min-height:0;overflow-y:auto;padding:20px 22px 28px}",
      ".mneme-drawertitle{width:100%;font-size:16px;font-weight:600;line-height:23px;color:var(--dsw-alias-label-primary);word-break:break-word}",
      ".mneme-drawertitle-input{width:100%;box-sizing:border-box;font-size:15px;font-weight:600;line-height:22px;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent)}",
      ".mneme-dmeta{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin-top:12px;font-size:12.5px;line-height:19px}",
      ".mneme-dmetakey{color:var(--mneme-fg-dim)}",
      ".mneme-dmetaval{color:var(--dsw-alias-label-secondary);min-width:0;word-break:break-word}",
      ".mneme-dcontent{margin-top:14px;font-size:13.5px;line-height:1.75;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}",
      ".mneme-dcontent-input{width:100%;box-sizing:border-box;min-height:180px;font-size:13.5px;line-height:1.7;padding:9px 11px;border-radius:8px;border:1px solid var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;outline:none;resize:vertical;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent)}",
      ".mneme-dentities{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}",
      ".mnementity-chip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);cursor:default}",
      ".mneme-dactions{flex:none;display:flex;flex-wrap:wrap;gap:8px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l2)}",
      // 更多操作菜单（导入/导出）与导入弹层
      ".mneme-menuwrap{position:relative}",
      ".mneme-menu{position:absolute;right:0;top:calc(100% + 6px);min-width:180px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 32px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);padding:5px;z-index:20;animation:mneme-fadein .1s ease-out}",
      ".mneme-menu button{display:flex;align-items:center;gap:8px;width:100%;border:none;background:none;color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;font-size:13px;line-height:18px;padding:8px 10px;border-radius:8px;text-align:left}",
      ".mneme-menu button:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-impdialog{position:absolute;right:0;top:calc(100% + 6px);width:300px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 32px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);padding:14px;z-index:20;animation:mneme-fadein .1s ease-out}",
      ".mneme-improw{display:flex;align-items:center;gap:8px;margin-top:10px}",
      // 分享/接收弹层：宽度与滚动共用 impdialog 的锚，正文一律 --mneme-* 语义层
      // （纪律 10：宿主 label-tertiary/label-dimmed 是分隔线层，不是正文色）。
      ".mneme-sharedialog{width:340px;max-height:min(72vh,560px);overflow-y:auto}",
      ".mneme-sharebody{margin-top:10px;display:flex;flex-direction:column;gap:2px}",
      ".mneme-sharebreak{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}",
      ".mneme-sharebreakitem{font-size:11px;line-height:15px;color:var(--mneme-fg-dim);font-variant-numeric:tabular-nums}",
      ".mneme-sharelist{margin-top:4px;max-height:132px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px}",
      ".mneme-sharow{display:flex;justify-content:space-between;gap:8px;font-size:11.5px;line-height:16px}",
      ".mneme-sharowtitle{color:var(--dsw-alias-label-primary);min-width:0;word-break:break-word}",
      ".mneme-sharowreason{flex:none;color:var(--mneme-fg-dim)}",
      // 外来徽标：只有文字色与描边，**不给底色**。`.mneme-badge--scope` / `--frozen` 那两类
      // 有自己的 10–12% 色晕，而 `test/contrast.test.js` 的正文对比度是按**该条规则自己的
      // 背景**合成的：`--mneme-ok` 在画布上是 4.62，铺上 12% 绿晕就掉到 4.17（<4.5）。
      // 与其为它造一个新语义令牌或改用别的色，不如让这一颗走无晕的形状——来源读数本来就在
      // 文字里（`from-<别名>`），不靠底色说话。
      ".mneme-badge--foreign{color:var(--mneme-ok);border:1px solid color-mix(in srgb,var(--mneme-ok) 34%,transparent)}",
      // 瞬时操作提示（删除/归档）：挂在浏览层底部居中，不被抽屉卸载吞掉
      ".mneme-x{position:relative}",
      ".mneme-toast{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1);font-size:12.5px;line-height:18px;padding:7px 16px;border-radius:10px;z-index:30;box-shadow:0 8px 24px color-mix(in srgb,var(--dsw-alias-label-primary) 25%,transparent);animation:mneme-fadein .15s ease-out}",
      // --- explorer refresh: paged month tree, sticky headers, inline icons ---
      ".mneme-vtabico{flex:none;opacity:.85}",
      ".mneme-xsearchwrap{position:relative;flex:none}",
      ".mneme-xsearchico{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--mneme-fg-dim);pointer-events:none}",
      ".mneme-xsearchwrap .mneme-xsearch{padding-left:27px}",
      ".mneme-footbtn{display:inline-flex;align-items:center;gap:4px}",
      ".mneme-xmonth{position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-layer-1);display:flex;align-items:center;gap:6px}",
      ".mneme-xmonthcount{margin-left:auto;color:var(--mneme-fg-dim);font-weight:400;font-variant-numeric:tabular-nums}",
      ".mneme-xcaret{display:inline-flex;align-items:center;justify-content:center;color:var(--mneme-fg-dim)}",
      ".mneme-xmore{display:flex;justify-content:center;align-items:center;padding:10px 0 24px;min-height:20px}",
      ".mneme-xemptyico{display:block;margin:0 auto 6px;opacity:.7}",
      // --- status sub-view: responsive stat-card grid (auto-fill, ~220px min) ---
      ".mneme-status{flex:1;min-height:0;overflow-y:auto;padding:20px 24px 40px;box-sizing:border-box}",
      ".mneme-statusgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;max-width:1000px;margin:0 auto 12px}",
      ".mneme-statusgrid:last-of-type{margin-bottom:0}",
      // 概览区是单行三卡：auto-fit 让不满的轨道塌缩，三张卡恒等宽铺满、行尾不留洞
      ".mneme-statusgrid--overview{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}",
      // 跨列只在容器够放下 ≥2 列时生效（220px 最小轨 + 12px 间隙推出来的界）；
      // 单列容器里 span 2 会撑出隐式轨道把布局撑爆，必须撤掉
      "@container (min-width:452px) and (max-width:683px){.mneme-statuscard--vectorwide{grid-column:span 2}}",
      "@container (min-width:452px){.mneme-statuscard--wide{grid-column:span 2}}",
      // 状态页分组标题（库内一览 / 后台运转）：只做扫读锚点，压得比卡片标题低
      ".mneme-statushead{max-width:1000px;margin:0 auto 10px;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--mneme-fg-dim)}",
      ".mneme-statusgrid+.mneme-statushead{margin-top:26px}",
      ".mneme-statuscard{min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px 16px 14px}",
      // 指标行：一行一指标（label 左 / 数值右），取代「·」串联的说明长句——
      // 拥挤感的根源是把多指标压进一段会换行的散文
      ".mneme-statrows{margin-top:10px;display:flex;flex-direction:column;gap:4px}",
      ".mneme-statrow{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:12px;line-height:17px;color:var(--mneme-fg-dim)}",
      ".mneme-statrow>span:first-child{flex:none;white-space:nowrap}",
      ".mneme-statrow .mneme-heatdot{align-self:center}",
      // 预警行（#275 库体积卡）：行与值都要落预警色——.mneme-statrowval 自带
      // color 声明，只染行不染值的话，过线的数字仍是次级文本色。
      ".mneme-statrow--warn{color:var(--mneme-warn)}",
      ".mneme-statrow--warn .mneme-statrowval{color:var(--mneme-warn)}",
      ".mneme-statrowval{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}",
      ".mneme-statfoot{margin-top:8px;font-size:11px;line-height:16px;color:var(--mneme-fg-dim)}",
      // 热度分布条：三档占比一图看清，行标只补数字（类名带双横线，与 heatdot 同款）
      ".mneme-heatbar{display:flex;height:6px;border-radius:3px;overflow:hidden;margin-top:12px;background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-heatbar-seg{min-width:2px}",
      ".mneme-heatbar--hot{background:var(--mneme-warn)}",
      ".mneme-heatbar--warm{background:var(--mneme-fg-dim)}",
      ".mneme-heatbar--cold{background:var(--mneme-graphic-dim)}",
      ".mneme-heatdot{flex:none;width:8px;height:8px;border-radius:50%}",
      ".mneme-heatdot--hot{background:var(--mneme-warn)}",
      ".mneme-heatdot--warm{background:var(--mneme-fg-dim)}",
      ".mneme-heatdot--cold{background:var(--mneme-graphic-dim)}",
      // --- Token 去向三屏（2026-10 可观测性改造）：KPI 带 / donut / 7 天柱状 / 8 周热力 ---
      // KPI 带固定 4 列、容器收窄降 2 列：用 @container 不用 @media——面板同时长在
      // 宿主侧栏（~500px）与 sheet（1240px）里，决定布局的是容器宽度而非视口。
      ".mneme-kpiband{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;max-width:1000px;margin:0 auto 12px}",
      "@container (max-width:560px){.mneme-kpiband{grid-template-columns:repeat(2,minmax(0,1fr))}}",
      ".mneme-tokenflow{max-width:1000px;margin:0 auto 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px 16px 14px}",
      ".mneme-donutwrap{display:flex;gap:20px;align-items:center;margin-top:12px}",
      "@container (max-width:480px){.mneme-donutwrap{flex-direction:column;align-items:stretch}.mneme-donutbox{align-self:center}}",
      ".mneme-donutbox{position:relative;flex:none;width:148px;height:148px}",
      ".mneme-donutbox svg{width:100%;height:100%;display:block}",
      ".mneme-donut-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}",
      ".mneme-donut-center b{font-size:19px;font-weight:650;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}",
      ".mneme-donut-center span{font-size:11px;color:var(--mneme-fg-dim);margin-top:1px}",
      // r=15.9155 让周长≈100，dasharray 直接填百分比；段缝靠 JS 侧留，这里只管观感。
      ".mneme-donut circle.mneme-seg{fill:none;stroke-width:5.6;transition:opacity .15s}",
      ".mneme-donut.has-focus circle.mneme-seg:not(.focused){opacity:.35}",
      ".mneme-seg--1{stroke:var(--mneme-chart-1)}",
      ".mneme-seg--2{stroke:var(--mneme-chart-2)}",
      ".mneme-seg--3{stroke:var(--mneme-chart-3)}",
      ".mneme-seg--4{stroke:var(--mneme-chart-4)}",
      ".mneme-seg--5{stroke:var(--mneme-chart-5)}",
      ".mneme-seg--6{stroke:color-mix(in srgb,var(--dsw-alias-label-primary) 50%,transparent)}",
      ".mneme-legend{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
      ".mneme-legendrow{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;cursor:default;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary)}",
      ".mneme-legendrow:hover,.mneme-legendrow.focused{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-legendrow.dim{opacity:.45}",
      ".mneme-legenddot{flex:none;width:10px;height:10px;border-radius:3px}",
      ".mneme-dot--1{background:var(--mneme-chart-1)}",
      ".mneme-dot--2{background:var(--mneme-chart-2)}",
      ".mneme-dot--3{background:var(--mneme-chart-3)}",
      ".mneme-dot--4{background:var(--mneme-chart-4)}",
      ".mneme-dot--5{background:var(--mneme-chart-5)}",
      ".mneme-dot--6{background:color-mix(in srgb,var(--dsw-alias-label-primary) 50%,transparent)}",
      ".mneme-legendname{color:var(--dsw-alias-label-primary);white-space:nowrap}",
      ".mneme-legendsub{color:var(--mneme-fg-dim);font-size:11px}",
      ".mneme-legendval{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);white-space:nowrap}",
      ".mneme-legendpct{flex:none;width:46px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);font-weight:600}",
      ".mneme-bars{position:relative;height:150px;margin-top:14px}",
      ".mneme-gridline{position:absolute;left:0;right:0;border-top:1px dashed var(--dsw-alias-border-l2)}",
      ".mneme-gridlabel{position:absolute;right:0;transform:translateY(-58%);font-size:10px;color:var(--mneme-fg-dim)}",
      ".mneme-barcols{position:absolute;inset:0;display:flex;align-items:flex-end;gap:8px;padding:0 2px}",
      ".mneme-barcol{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:flex-end;height:100%}",
      ".mneme-bar{border-radius:5px 5px 2px 2px;background:var(--mneme-accent);min-height:2px;transition:opacity .15s}",
      ".mneme-barcol:hover .mneme-bar{opacity:.8}",
      ".mneme-barlabels{display:flex;gap:8px;padding:6px 2px 0}",
      ".mneme-barlabels span{flex:1;min-width:0;text-align:center;font-size:10.5px;color:var(--mneme-fg-dim);font-variant-numeric:tabular-nums}",
      // GitHub 贡献图式紧凑网格（复验第三轮「间距太大」）：11px 格 + 2px 缝；
      // heatrows 是左侧星期标签列（一/三/五），heatmonths 是顶部月份标签行
      // （列主序网格下月份行须与格子列对齐，所以同用 auto-flow:column）。
      ".mneme-heatgrid{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,11px);gap:2px;margin-top:12px}",
      ".mneme-heatcell{width:11px;height:11px;border-radius:2px;background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-heatwrap{display:flex;gap:4px}",
      ".mneme-heatrows{display:grid;grid-template-rows:repeat(7,11px);gap:2px;margin-top:12px;font-size:9.5px;line-height:11px;color:var(--mneme-fg-dim);text-align:right}",
      ".mneme-heatmonths{display:grid;grid-auto-flow:column;grid-auto-columns:11px;gap:2px;margin-top:0;font-size:9.5px;line-height:14px;color:var(--mneme-fg-dim)}",
      // 类名编号=视觉档位（l1 最浅…l4 最深），变量编号=business 占比降序，故交叉引用。
      ".mneme-heatcell.l1{background:var(--mneme-heat-4)}",
      ".mneme-heatcell.l2{background:var(--mneme-heat-3)}",
      ".mneme-heatcell.l3{background:var(--mneme-heat-2)}",
      ".mneme-heatcell.l4{background:var(--mneme-heat-1)}",
      ".mneme-heatlegend{display:flex;align-items:center;gap:3px;margin-top:8px;font-size:10.5px;color:var(--mneme-fg-dim)}",
      ".mneme-heatlegend .mneme-heatcell{width:10px;height:10px}",
      // 热力右侧的空白：热力只有 56 格 × 11px ≈ 745px 宽，而容器可用宽 968px，
      // 右边常年空着约 220px。原先三块图各自独占整行，空白是「每块只占半行」造成的，
      // 不是某个空 div——所以这里把热力与沉淀图并成两列（左侧热力按内容宽 auto，
      // 右侧吃剩余），容器窄到放不下两列时回落单列竖排。
      ".mneme-flowrow{display:grid;grid-template-columns:auto minmax(0,1fr);gap:20px;align-items:start}",
      "@container (max-width:960px){.mneme-flowrow{grid-template-columns:minmax(0,1fr)}}",
      ".mneme-flowheat{min-width:0}",
      ".mneme-flowsink{min-width:0;display:flex;flex-direction:column}",
      // 8 周沉淀只画两条（进来的 / 稳住的）：220px 宽里三序列会细到看不清，
      // 归档数改在下方图例里给总量。
      ".mneme-sinkchart{display:flex;align-items:flex-end;gap:4px;height:96px;margin-top:12px}",
      ".mneme-sinkcol{flex:1;min-width:0;display:flex;align-items:flex-end;gap:2px;height:100%}",
      ".mneme-sinkbar{flex:1;min-width:0;border-radius:2px 2px 0 0;min-height:1px}",
      ".mneme-sinkbar--added{background:var(--mneme-chart-3)}",
      ".mneme-sinkbar--merged{background:var(--mneme-chart-2)}",
      ".mneme-sinklabels{display:flex;gap:4px;margin-top:4px;font-size:9.5px;color:var(--mneme-fg-dim);font-variant-numeric:tabular-nums}",
      ".mneme-sinklabels span{flex:1;min-width:0;text-align:center;white-space:nowrap}",
      ".mneme-sinklegend{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin-top:8px;font-size:10.5px;color:var(--mneme-fg-dim)}",
      ".mneme-sinklegend b{font-weight:600;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
      // 原 9 卡降级折叠区：默认收起，展开才挂载子卡（见 TokenFlowSection 注释）。
      ".mneme-legacy{max-width:1000px;margin:0 auto 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 16px}",
      ".mneme-legacy summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
      // --- 状态页工作台：让用户看见插件在干活（动态/沉淀/归档） ---
      ".mneme-wbhead{margin:28px auto 10px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);max-width:1000px;display:flex;align-items:baseline;justify-content:space-between;gap:8px}",
      ".mneme-wblist{max-width:1000px;display:flex;flex-direction:column;gap:6px}",
      ".mneme-wbrow{display:flex;gap:10px;align-items:flex-start;padding:10px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}",
      ".mneme-wbdot{flex:none;width:8px;height:8px;border-radius:50%;margin-top:6px;background:var(--mneme-ok)}",
      ".mneme-wbdot--err{background:var(--mneme-danger)}",
      ".mneme-wbmain{min-width:0;flex:1}",
      ".mneme-wbtitle{font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary)}",
      ".mneme-wbsub{font-size:12px;line-height:17px;color:var(--mneme-fg-dim);margin-top:1px}",
      ".mneme-wbmemo{display:flex;gap:10px;align-items:center;padding:10px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}",
      ".mneme-wbmemo .mneme-xdot{flex:none}",
      ".mneme-wbmemo-main{min-width:0;flex:1}",
      ".mneme-statusnum{font-size:24px;font-weight:600;line-height:32px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}",
      // 大数字预警色（#275 库体积卡）：状态卡都走 StatusCard，只有传 numWarn 的
      // 卡会挂这个类。
      ".mneme-statusnum--warn{color:var(--mneme-warn)}",
      ".mneme-statuscap{margin-top:4px;font-size:13px;line-height:19px;color:var(--mneme-fg-dim);word-break:break-word}",
      // --- destructive actions: red outline = delete, solid red = confirm ---
      ".mneme-btndanger{color:var(--mneme-danger);border-color:var(--mneme-danger)}",
      ".mneme-btndanger:hover{background:color-mix(in srgb,var(--mneme-danger) 12%,transparent)}",
      ".mneme-btndangerconfirm{background:var(--mneme-danger);border-color:var(--mneme-danger);color:var(--dsw-alias-bg-layer-1)}",
      ".mneme-btndangerconfirm:hover{filter:brightness(.9)}",
      // --- settings cards: boxed cards for the runtime-mode and external-API
      // sections — each card owns its fetch/PUT state, so it renders as a
      // self-contained unit inside the stacked settings view ---
      ".mneme-set-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;margin-bottom:10px}",
      // 设置页分组标题（个性化 / 记忆引擎 / 搜索 / 连接与安全 / 帮助）：
      // 先给「这一段在管什么」，卡片才是具体选项；scroll-margin-top 是给 #518 的粘顶目录（实测约 74px 高）留的跳转余量
      // ——没有它，点 chip 滚过去的标题就停在目录背面
      ".mneme-set-grouphead{font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--mneme-fg-dim);margin:24px 0 10px;scroll-margin-top:84px}",
      ".mneme-set-toc+.mneme-set-grouphead{margin-top:8px}", // nav 才是第一个孩子：:first-child 自 #518 起永不命中
      // 设置页目录（#518）：分组标题 + 一栏跳转 chip。粘顶是因为设置页是整块
      // 滚动的（.mneme-set 自己 overflow-y），长页里目录滚走了就等于没有——用户
      // 提的诉求正是「方便直接跳转」，跳不回去的目录不算数。
      // 窄屏收成横向滚动：换行会让粘顶条吃掉半屏高度，而设置页本身已经很挤。
      ".mneme-set-toc{position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1));padding:8px 0 10px;margin-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".mneme-set-toclabel{font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--mneme-fg-dim);margin-bottom:6px}",
      ".mneme-set-toclist{display:flex;gap:6px;overflow-x:auto;padding:3px}", // 不 wrap：chip flex:none，窄屏横向滚；3px 给 focus ring 留位（滚动容器会裁掉描边）
      ".mneme-set-tocchip{flex:none;height:26px;padding:0 10px;border-radius:13px;border:1px solid var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:12px;line-height:24px;transition:border-color .12s,color .12s}",
      ".mneme-set-tocchip:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}",
      ".mneme-set-tocchip:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      ".mneme-set-token{font-family:monospace;font-size:12px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);word-break:break-all;user-select:all}",
      ".mneme-set-hint{font-size:12px;color:var(--mneme-fg-dim)}",
      // 配置键覆盖清单（#386 第 7 条）：一行一排 chip，长键名换行不截断——
      // 这张表的用处就是让「memoryQualityFilter.archiveThreshold」这样的名字能被
      // 完整抄进配置文件，省略号会直接毁掉它的用途。
      ".mneme-keylist{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}",
      ".mneme-keychip{font-family:monospace;font-size:11px;padding:2px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,transparent);color:var(--mneme-fg-dim);word-break:break-all;user-select:all}",
      // --- 重要性编辑行：与查看态同一份 Lucide 星形（此前是文本星号下拉，角更尖锐且与其他星不统一） ---
      ".mneme-staredit{display:inline-flex;align-items:center;gap:1px;justify-self:start}",
      ".mneme-starbtn{border:none;background:none;cursor:pointer;padding:2px 1px;display:inline-flex;color:var(--dsw-alias-label-secondary);transition:transform .12s}",
      ".mneme-starbtn--on{color:var(--mneme-warn)}",
      ".mneme-starbtn:hover{transform:scale(1.12)}",
      ".mneme-starbtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px;border-radius:4px}",
      // --- 意见与反馈：图标行 + 版本 footer，收在设置页末尾当「关于」用 ---
      ".mneme-feedlist{display:flex;flex-direction:column;gap:4px}",
      ".mneme-feedrow{display:flex;align-items:flex-start;gap:10px;padding:9px 10px;border-radius:10px;text-decoration:none;transition:background .12s}",
      ".mneme-feedrow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-feedico{flex:none;width:28px;height:28px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
      ".mneme-feedrow:hover .mneme-feedico{background:var(--dsw-alias-interactive-bg-active)}",
      ".mneme-feedtext{display:flex;flex-direction:column;gap:1px;min-width:0}",
      ".mneme-feedname{font-size:13px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary)}",
      ".mneme-feedsub{font-size:12px;line-height:17px;color:var(--mneme-fg-dim)}",
      ".mneme-set-foot{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-top:12px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--mneme-fg-dim)}",
      // --- 存储回收卡（#386 第 4 条）：控制行 + 两步确认的警告块 ---
      ".mneme-maintrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}",
      ".mneme-maintlbl{flex:none;font-size:12px;line-height:17px;color:var(--mneme-fg-dim)}",
      ".mneme-maintrow .mneme-set-input{flex:none;width:96px;margin-bottom:0}",
      ".mneme-maintcheck{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary)}",
      ".mneme-maintwarn{margin-top:12px;padding:10px 12px;border-radius:10px;border:1px solid color-mix(in srgb,var(--mneme-danger) 45%,transparent);background:color-mix(in srgb,var(--mneme-danger) 8%,transparent)}",
      ".mneme-maintwarnhead{font-size:13px;line-height:19px;font-weight:600;color:var(--mneme-danger)}",
      ".mneme-maintresult{margin-top:12px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}",
      ".mneme-maintresulthead{font-size:13px;line-height:19px;font-weight:600;color:var(--mneme-ok)}",
      ".mneme-mainterr{margin-top:10px;font-size:12px;line-height:17px;color:var(--mneme-danger)}",
      // --- v0.9.0 M.O.（beta）---------------------------------------------
      // 语义色层第二份：浮层面板（portal 到 body）、右栏 pane、退化 sheet、
      // 对话行结算卡都不在原四个渲染根之下。contrast.test.js 对原四根选择器
      // 做精确匹配锁，所以这里另起一条规则、取值逐字相同，且必须排在其后
      // （测试按首次出现抓取 --mneme-* 定义）。引用的宿主 token 全部在
      // test/contrast.test.js 的 HOST_TOKENS 快照里，不许新增名字。
      ".mneme-pipe,.mneme-pipeview,.mneme-pipe-settle,.mneme-pipe-root{" +
        "--mneme-fg-dim:color-mix(in srgb,var(--dsw-alias-label-primary) 60%,transparent);" +
        "--mneme-graphic-dim:color-mix(in srgb,var(--dsw-alias-label-primary) 50%,transparent);" +
        "--mneme-accent:color-mix(in srgb,var(--dsw-alias-state-business-primary) 85%,var(--dsw-alias-label-primary));" +
        "--mneme-danger:color-mix(in srgb,var(--dsw-alias-state-error-primary) 80%,var(--dsw-alias-label-primary));" +
        "--mneme-warn:color-mix(in srgb,var(--dsw-static-amber-600,#dd8629) 65%,var(--dsw-alias-label-primary));" +
        "--mneme-ok:color-mix(in srgb,var(--dsw-static-green-500,#22c55e) 65%,var(--dsw-alias-label-primary))" +
      "}",
      // 会话头 trigger：与 Agent Teams 同规格（28px 行高、12px 字号），
      // 页头窄容器下文字标签隐藏、降级纯图标。
      ".mneme-pipe-root{position:relative;display:inline-flex}",
      ".mneme-pipe-trigger{min-height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:5px;padding:3px 7px;font-family:inherit;font-size:12px;display:inline-flex}",
      ".mneme-pipe-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-pipe-trigger:focus-visible{color:var(--dsw-alias-label-primary);outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      ".mneme-pipe-triggerLabel{white-space:nowrap}",
      "@container (width<=480px){.mneme-pipe-triggerLabel{display:none}}",
      ".mneme-pipe-dot{flex:none;min-width:14px;height:14px;border-radius:7px;padding:0 3px;background:color-mix(in srgb,var(--mneme-warn) 14%,transparent);color:var(--dsw-alias-label-primary);font-size:10px;line-height:14px;font-weight:600;font-variant-numeric:tabular-nums;text-align:center}",
      // 浮层面板：几何抄 Agent Teams（min(500px,100vw-32px) / 12px 圆角 /
      // fixed 定位由 useAnchoredPosition 给出）。阴影用中性 rgba：宿主的
      // elevation token 不在面板 token 快照白名单里，不能引用。
      ".mneme-pipe-panel{z-index:100;box-sizing:border-box;width:min(500px,100vw - 32px);max-height:min(680px,100vh - 32px);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;padding:0;display:flex;position:fixed;overflow:hidden;background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 28px rgba(0,0,0,0.28);color:var(--dsw-alias-label-primary)}",
      ".mneme-pipe-head{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px 8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".mneme-pipe-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);display:inline-flex;align-items:center;gap:6px;min-width:0}",
      ".mneme-pipe-beta{flex:none;font-size:11px;line-height:16px;font-weight:600;color:var(--mneme-warn);border:1px solid color-mix(in srgb,var(--mneme-warn) 55%,transparent);border-radius:6px;padding:0 6px}",
      // 内测免责：界面常驻一行，「候选」是可见状态词不是 tooltip。
      ".mneme-pipe-notice{flex:none;display:flex;gap:6px;align-items:flex-start;padding:7px 14px 0;font-size:12px;line-height:17px;color:var(--mneme-fg-dim)}",
      ".mneme-pipe-scope{flex:none;font-size:11px;line-height:16px;color:var(--mneme-fg-dim)}",
      // 运行档位：一次运行一个芯片；失败/被推翻的运行照常列出（留痕）。
      ".mneme-pipe-runs{flex:none;display:flex;gap:6px;flex-wrap:wrap;padding:6px 14px 2px}",
      ".mneme-pipe-run{border:1px solid var(--dsw-alias-border-l2);background:0 0;border-radius:8px;cursor:pointer;color:var(--mneme-fg-dim);font-family:inherit;font-size:12px;line-height:16px;padding:2px 8px;display:inline-flex;gap:6px;align-items:center}",
      ".mneme-pipe-run:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-pipe-run:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      ".mneme-pipe-run.mneme-on{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}",
      ".mneme-pipe-runDot{flex:none;width:8px;height:8px;border-radius:4px}",
      ".mneme-pipe-runDot--ok{background:var(--mneme-ok)}",
      ".mneme-pipe-runDot--failed{background:var(--mneme-warn)}",
      ".mneme-pipe-runDot--refuted{background:var(--mneme-danger)}",
      // 图：宽态 SVG 分层 DAG（trace viewer 读法），窄态整块换成竖排列表。
      // 高度下限：flex:1 的基准是 0，只要某一层祖先没有确定高度（浮层与居中 sheet 都是 max-height
      // 封顶），分到的就是 0 像素——画布「在 DOM 里、但看不见」。下限不修复成因，只保证最坏情况下
      // 还能看见图；这跟上面那条撞车是两件事，别把任何一条当成另一条的修复。
      ".mneme-pipe-graph{flex:1;min-height:220px;overflow:auto;padding:4px 8px 2px}",
      // 缩放条与缩放容器。画布本身是 width:100% 的 SVG，所以「缩放」= 改外层容器的百分比宽度：
      // 100% 就是适应栏宽，放大则容器比栏宽，滚动条自己出来——平移不必另写一套。
      ".mneme-pipe-zoombar{flex:none;display:flex;align-items:center;gap:6px;padding:5px 12px 0;font-size:12px;color:var(--mneme-fg-dim)}",
      ".mneme-pipe-zoombtn{border:1px solid var(--dsw-alias-border-l2);background:0 0;border-radius:6px;cursor:pointer;color:var(--mneme-fg-dim);font-family:inherit;font-size:12px;line-height:16px;padding:1px 7px}",
      ".mneme-pipe-zoombtn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-pipe-zoombtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      ".mneme-pipe-zoomval{min-width:40px;text-align:right;font-variant-numeric:tabular-nums}",
      ".mneme-pipe-zoomwrap{min-width:0}",
      ".mneme-pipe-svg{display:block;width:100%;height:auto}",
      ".mneme-pipe-edge{stroke:var(--mneme-graphic-dim);fill:none;stroke-width:1.5}",
      ".mneme-pipe-edgeOn{stroke:var(--mneme-accent);fill:none;stroke-width:2.5}",
      ".mneme-pipe-edgeFail{stroke:var(--mneme-danger);fill:none;stroke-width:2;stroke-dasharray:5 3}",
      // 节点形状按 kind 区分（step 矩形 / gate 菱形 / branch 圆角 / artifact 胶囊），
      // 状态走描边+填充：refuted 是全篇核心信号，双份危险色最扎眼。
      ".mneme-pipe-node{fill:var(--dsw-alias-bg-layer-2);stroke:var(--mneme-graphic-dim);stroke-width:1.2}",
      ".mneme-pipe-node--trusted{stroke:var(--mneme-ok);stroke-width:1.6}",
      ".mneme-pipe-node--candidate{stroke:var(--mneme-graphic-dim)}",
      ".mneme-pipe-node--stale{stroke:var(--dsw-alias-border-l2);stroke-dasharray:3 2;fill:var(--dsw-alias-bg-base)}",
      ".mneme-pipe-node--refuted{stroke:var(--mneme-danger);stroke-width:2;fill:color-mix(in srgb,var(--mneme-danger) 10%,transparent)}",
      ".mneme-pipe-node--onpath{stroke:var(--dsw-alias-state-business-primary);stroke-width:2}",
      ".mneme-pipe-nodeT{fill:var(--dsw-alias-label-primary);font-size:11px;font-weight:600}",
      ".mneme-pipe-nodeS{fill:var(--mneme-fg-dim);font-size:9.5px}",
      ".mneme-pipe-nodeK{fill:var(--mneme-fg-dim);font-size:9px}",
      // 图例：四个状态 + 闸门有无（counterfactual null = 空心圈「还没闸门」）。
      ".mneme-pipe-legend{flex:none;display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding:2px 14px 8px;font-size:11px;line-height:16px;color:var(--mneme-fg-dim)}",
      ".mneme-pipe-pill{flex:none;border-radius:6px;padding:0 6px;font-size:11px;line-height:18px;font-weight:600;border:1px solid transparent}",
      ".mneme-pipe-pill--candidate{color:var(--mneme-fg-dim);border-color:var(--dsw-alias-border-l2)}",
      ".mneme-pipe-pill--trusted{color:var(--mneme-ok);border-color:color-mix(in srgb,var(--mneme-ok) 45%,transparent)}",
      ".mneme-pipe-pill--stale{color:var(--mneme-fg-dim);border-color:var(--dsw-alias-border-l2);border-style:dashed}",
      ".mneme-pipe-pill--refuted{color:var(--mneme-danger);border-color:color-mix(in srgb,var(--mneme-danger) 55%,transparent);background:color-mix(in srgb,var(--mneme-danger) 10%,transparent)}",
      ".mneme-pipe-gate{flex:none;width:10px;height:10px;border-radius:5px;border:1.5px solid var(--mneme-graphic-dim)}",
      ".mneme-pipe-gate--has{border-color:var(--mneme-ok);background:var(--mneme-ok)}",
      // 阶段带（2026-10-16）：段底用宿主 hover 层而不是自造色——对比度锁不认识
      // 「SVG 文字底下还有一层 rect」，所以段底必须淡到不参与文字对比度。
      ".mneme-pipe-bandbg{fill:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-pipe-bandline{stroke:var(--dsw-alias-border-l2);stroke-width:1}",
      ".mneme-pipe-bandT{fill:var(--dsw-alias-label-primary);font-size:12px;font-weight:600}",
      // 闸门节点与风险条：颜色只做冗余，信息本体在文本（闸 / R0-R3）里——
      // 不许靠单一色相区分（AGENTS.md 自查清单第 9 条）。
      ".mneme-pipe-node--gate{stroke:var(--mneme-warn);stroke-width:2}",
      ".mneme-pipe-gatetag{fill:var(--mneme-warn);font-size:9px;font-weight:600}",
      ".mneme-pipe-risk--r0{stroke:var(--mneme-graphic-dim)}",
      ".mneme-pipe-risk--r1{stroke:var(--mneme-accent)}",
      ".mneme-pipe-risk--r2{stroke:var(--mneme-warn)}",
      ".mneme-pipe-risk--r3{stroke:var(--mneme-danger)}",
      // 流程概览带：读投影里 pipeline.done 与 pipeline.trigger，回答「这条流程
      // 在干什么、何时起跑」。正文用 label-secondary（与节点详情屏同档）。
      ".mneme-pipe-overview{flex:none;padding:8px 14px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:3px}",
      // 节点详情（宽态点选展开 / 窄态 details 手风琴共用）。
      ".mneme-pipe-detail{flex:none;border-top:1px solid var(--dsw-alias-border-l1);padding:8px 14px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);max-height:180px;overflow:auto}",
      ".mneme-pipe-detailTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:2px}",
      ".mneme-pipe-dt{font-weight:600;color:var(--mneme-fg-dim)}",
      ".mneme-pipe-cf{margin-top:4px;padding:4px 8px;border-radius:8px;background:color-mix(in srgb,var(--mneme-ok) 10%,transparent);color:var(--dsw-alias-label-secondary)}",
      ".mneme-pipe-cf--none{background:0 0;border:1px dashed var(--dsw-alias-border-l2);color:var(--mneme-fg-dim)}",
      // 窄态（better-sidebar ~500px / 浮层内）：节点竖排列表化，边收成
      // 左侧轨道线 + 「依赖」芯片——换布局，不是缩放。
      ".mneme-pipe-list{flex:1;min-height:180px;overflow:auto;padding:4px 12px 8px}",
      ".mneme-pipe-item{position:relative;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:8px 10px 8px 30px;margin:0 0 10px}",
      ".mneme-pipe-item::before{content:\"\";position:absolute;left:13px;top:-10px;height:10px;border-left:2px solid var(--mneme-graphic-dim)}",
      ".mneme-pipe-item:first-child::before{display:none}",
      ".mneme-pipe-itemDot{position:absolute;left:8px;top:12px;width:10px;height:10px;border-radius:5px;border:2px solid var(--mneme-graphic-dim);background:var(--dsw-alias-bg-layer-2)}",
      ".mneme-pipe-itemDot--trusted{border-color:var(--mneme-ok)}",
      ".mneme-pipe-itemDot--stale{border-style:dashed;border-color:var(--dsw-alias-border-l2)}",
      ".mneme-pipe-itemDot--refuted{border-color:var(--mneme-danger);background:var(--mneme-danger)}",
      ".mneme-pipe-itemDot--onpath{border-color:var(--dsw-alias-state-business-primary)}",
      ".mneme-pipe-itemName{font-size:13px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary)}",
      ".mneme-pipe-itemName--refuted{color:var(--mneme-danger)}",
      ".mneme-pipe-itemMeta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:2px;font-size:11px;line-height:16px;color:var(--mneme-fg-dim)}",
      ".mneme-pipe-dep{font-size:11px;color:var(--mneme-fg-dim)}",
      ".mneme-pipe-item summary{cursor:pointer;list-style:none}",
      ".mneme-pipe-item summary::-webkit-details-marker{display:none}",
      ".mneme-pipe-itemBody{margin-top:6px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
      // 对话行结算卡（turnTail）：死数据，跟这次运行绑死。
      ".mneme-pipe-settle{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:8px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:4px 0;max-width:620px}",
      ".mneme-pipe-settleHead{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px}",
      ".mneme-pipe-settleTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);display:inline-flex;align-items:center;gap:6px}",
      ".mneme-pipe-steps{display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin:2px 0}",
      ".mneme-pipe-stepChip{border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:0 7px;font-size:11px;line-height:18px;color:var(--mneme-fg-dim);display:inline-flex;gap:4px;align-items:center}",
      ".mneme-pipe-stepChip--used{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent);color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}",
      ".mneme-pipe-stepArrow{color:var(--mneme-fg-dim);font-size:11px}",
      // 老宿主退化：居中 sheet（形态沿用记忆库 overlay 的背板 + 居中面板）。
      ".mneme-pipe-sheet{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:60;width:min(860px,calc(100vw - 48px));max-height:calc(100vh - 96px);border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,0.3)}",
      ".mneme-pipe-sheetbar{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".mneme-pipe-sheetbody{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column}",
      // 空态/加载/错误共用文案块。
      ".mneme-pipe-empty{flex:none;padding:18px 14px;text-align:center;font-size:13px;line-height:20px;color:var(--mneme-fg-dim)}",
      ".mneme-pipe-emptyTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:4px}",
      // 工作流清单：**选择器**，不是「一屏」。它在上面占一条、图在下面占其余——
      // 第一版把它做成吃掉整屏、点条目才换屏，结果画布藏在一次点击后面且界面上没有任何
      // 提示，反馈连着两次说「看不到画布和节点」。上限用固定值不用百分比：百分比在
      // 高度不确定的祖先下会被当成 none，又变回吃掉整屏。
      ".mneme-pipe-wflist{flex:none;max-height:220px;min-height:0;overflow:auto;padding:8px 14px 10px;display:flex;flex-direction:column;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".mneme-pipe-wfhead{flex:none;display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:12px;color:var(--mneme-fg-dim)}",
      ".mneme-pipe-wf{display:block;width:100%;text-align:left;font-family:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:9px 11px;cursor:pointer;color:var(--dsw-alias-label-primary)}",
      ".mneme-pipe-wf:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-pipe-wf:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      // 当前展开的那条：只有颜色不同，图仍由下面的画布独占——选择器不该抢主语的位置。
      ".mneme-pipe-wf.mneme-on{border-color:var(--dsw-alias-state-business-primary)}",
      ".mneme-pipe-wfTop{display:flex;align-items:baseline;justify-content:space-between;gap:8px}",
      ".mneme-pipe-wfName{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);min-width:0}",
      ".mneme-pipe-wfScope{flex:none;font-size:11px;color:var(--mneme-fg-dim)}",
      ".mneme-pipe-wfMeta{display:block;margin-top:3px;font-size:12px;color:var(--mneme-fg-dim)}",
      ".mneme-pipe-wfId{display:block;margin-top:2px;font-size:11px;color:var(--mneme-fg-dim)}",
      ".mneme-pipe-broken{flex:none;font-size:12px;line-height:17px;color:var(--mneme-warn);padding:6px 14px 0}",
      // 手动沉淀：按钮与回执占一行。回执用 --mneme-fg-dim 而不是 --mneme-warn——
      // 「这一遍没挖到」是正常结果，不是警告；只有「读不出来」才是故障，那也由文案说清，
      // 不靠颜色区分（红黄两色在深浅主题里最容易一起掉对比度）。
      ".mneme-pipe-distill{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}",
      ".mneme-pipe-distillBtn{border:1px solid var(--dsw-alias-border-l2);background:0 0;border-radius:8px;cursor:pointer;color:var(--mneme-fg-dim);font-family:inherit;font-size:12px;line-height:16px;padding:2px 9px}",
      ".mneme-pipe-distillBtn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-pipe-distillBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      // 禁用态用虚线边而不是降透明度：整块降 opacity 会把文字一起压到 AA 以下，
      // 而「为什么禁用」本来就由 title 说明（读不到会话工作目录）。
      ".mneme-pipe-distillBtn:disabled{cursor:not-allowed;border-style:dashed;color:var(--mneme-fg-dim)}",
      ".mneme-pipe-distillNote{color:var(--mneme-fg-dim);line-height:17px;min-width:0}",
      // --- v0.13 日记本（beta）---------------------------------------------
      // 语义色层第三份：日记本整页长在右栏 pane 里，既不在 .mneme-x 下、也不是
      // pipe 那套类名。取值与第一份逐字相同，理由同 :2831 那条注释——测试按
      // 首次出现抓 --mneme-* 定义，所以这条只能排在它后面。
      ".mneme-diary,.mneme-diary-paper,.mneme-diary-head,.mneme-diary-list,.mneme-persona{" +
        "--mneme-fg-dim:color-mix(in srgb,var(--dsw-alias-label-primary) 60%,transparent);" +
        "--mneme-graphic-dim:color-mix(in srgb,var(--dsw-alias-label-primary) 50%,transparent);" +
        "--mneme-accent:color-mix(in srgb,var(--dsw-alias-state-business-primary) 85%,var(--dsw-alias-label-primary));" +
        "--mneme-danger:color-mix(in srgb,var(--dsw-alias-state-error-primary) 80%,var(--dsw-alias-label-primary));" +
        "--mneme-warn:color-mix(in srgb,var(--dsw-static-amber-600,#dd8629) 65%,var(--dsw-alias-label-primary));" +
        "--mneme-ok:color-mix(in srgb,var(--dsw-static-green-500,#22c55e) 65%,var(--dsw-alias-label-primary))" +
      "}",
      // 手绘风只靠**形状**做，不靠颜色：四角不对称的圆角（每边一个数会写成
      // 「横向/纵向」两组百分比）、比常规粗一点的 1.5px 描边、虚线分隔、以及
      // 正负 0.3deg 的轻微歪斜——这些都不碰对比度，深浅主题下一样成立。
      // 想加纸纹就用 repeating-linear-gradient：它不是 color 声明，主锁不看；
      // 反过来**别在这里加 color**，任何新色值都要先过 #178 的 AA 主锁。
      ".mneme-diary{display:flex;flex-direction:column;gap:10px;height:100%;min-height:0;padding:10px 12px;font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary);box-sizing:border-box}",
      ".mneme-diary-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".mneme-diary-title{font-size:15px;line-height:21px;font-weight:700;letter-spacing:.3px;color:var(--dsw-alias-label-primary)}",
      ".mneme-diary-note{font-size:12px;line-height:17px;color:var(--mneme-fg-dim)}",
      ".mneme-diary-spacer{flex:1 1 auto;min-width:0}",
      ".mneme-diary-btn{border:1.5px solid var(--dsw-alias-border-l2);background:0 0;border-radius:13px 9px 14px 10px;cursor:pointer;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:17px;padding:3px 11px}",
      ".mneme-diary-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-diary-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      ".mneme-diary-btn:disabled{cursor:not-allowed;border-style:dashed;color:var(--mneme-fg-dim)}",
      ".mneme-diary-btn--primary{border-color:var(--mneme-accent);color:var(--mneme-accent)}",
      ".mneme-diary-body{display:flex;gap:10px;min-height:0;flex:1 1 auto}",
      // 左侧面板的导航栏：一行一个 Agent 名字，横向可滚。
      // 与右栏那套「左边日期列表」不同层——这里多一层「谁写的」。
      ".mneme-diary-nav{display:flex;gap:6px;flex-wrap:wrap;flex:none;border-bottom:1px dashed var(--dsw-alias-border-l2);padding-bottom:8px}",
      ".mneme-diary-agent{border:1.5px solid transparent;background:0 0;cursor:pointer;font-family:inherit;font-size:12px;line-height:17px;padding:3px 10px;border-radius:12px 8px 13px 9px;color:var(--mneme-fg-dim);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".mneme-diary-agent:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-diary-agent:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      ".mneme-diary-agent--on{border-color:var(--mneme-accent);color:var(--mneme-accent);font-weight:600}",
      ".mneme-diary-agentName{pointer-events:none}",
      ".mneme-diary-list{flex:0 0 108px;display:flex;flex-direction:column;gap:4px;overflow:auto;padding-right:2px;border-right:1px dashed var(--dsw-alias-border-l2)}",
      ".mneme-diary-day{text-align:left;border:0;background:0 0;cursor:pointer;font-family:inherit;font-size:12px;line-height:17px;padding:3px 7px;border-radius:9px 7px 10px 6px;color:var(--mneme-fg-dim)}",
      ".mneme-diary-day:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-diary-day:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      ".mneme-diary-day--on{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:600;transform:rotate(-.3deg)}",
      // 本子：四套纸 + 固定字。纸纹走 background-image（不是 color 声明），
      // 主锁只看 color，所以纸纹不会把对比度审计带偏；但这意味着**纸再花，
      // 字也必须用 --mneme-* 那层语义色**，别为了「像本子」写一个浅灰字。
      ".mneme-diary-books{display:flex;gap:4px;flex:none;flex-wrap:wrap}",
      ".mneme-diary-book{border:1.5px solid transparent;background:0 0;cursor:pointer;font-family:inherit;font-size:11px;line-height:16px;padding:2px 8px;border-radius:10px 7px 11px 6px;color:var(--mneme-fg-dim)}",
      ".mneme-diary-book:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-diary-book:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      ".mneme-diary-book--on{border-color:var(--mneme-accent);color:var(--mneme-accent);font-weight:600}",
      ".mneme-diary-meta{flex:none;font-size:11px;line-height:16px;color:var(--mneme-fg-dim);display:flex;gap:6px;align-items:baseline;padding:0 2px}",
      // 写/存两个动作的回执：成功和失败用同一块位置，靠左侧描边与配色区分，
      // 不另起弹层——面板里已经有纸张在动，再多一层浮层会盖住正文。
      ".mneme-diary-notice{flex:none;font-size:12px;line-height:18px;padding:5px 9px;border-radius:6px;border-left:3px solid var(--mneme-accent);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);word-break:break-word}",
      ".mneme-diary-notice--bad{border-left-color:var(--mneme-danger);color:var(--mneme-danger)}",
      ".mneme-diary-paperhead{display:flex;align-items:baseline;gap:8px;padding-bottom:6px;margin-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".mneme-diary-papername{font-size:13px;line-height:19px;font-weight:600;color:var(--mneme-accent);flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".mneme-diary-paperdate{font-size:11px;line-height:16px;color:var(--mneme-fg-dim);font-variant-numeric:tabular-nums;flex:none}",
      // 纸地：素纸 / 横线 / 方格 / 牛皮。横线与方格用 background-size 让格线正好
      // 落在 26px 行高上，行距一改就得同步改这两个数，否则字会压在线上。
      ".mneme-diary-paper--ruled{background-image:repeating-linear-gradient(to bottom,transparent 0 25px,var(--dsw-alias-border-l1) 25px 26px);background-size:100% 26px;background-position:0 0}",
      ".mneme-diary-paper--grid{background-image:repeating-linear-gradient(to bottom,transparent 0 25px,var(--dsw-alias-border-l1) 25px 26px),repeating-linear-gradient(to right,transparent 0 25px,var(--dsw-alias-border-l1) 25px 26px);background-size:100% 26px,26px 100%;background-position:0 0,0 0}",
      ".mneme-diary-paper--kraft{background:color-mix(in srgb,var(--dsw-static-amber-600,#dd8629) 8%,transparent)}",
      ".mneme-diary-paper--plain{background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,transparent)}",
      ".mneme-diary-paper{flex:1 1 auto;min-width:0;overflow:auto;padding:12px 14px;border:1.5px solid var(--dsw-alias-border-l1);border-radius:16px 11px 15px 9px;transform:rotate(.18deg);background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,transparent)}",
      // 日记正文用衬线：本子上写字不该像聊天记录。四套纸共用一套字，行高 26px
      // 与 --ruled/--grid 的格线对齐；行高一改必须同步上面两条 background-size。
      ".mneme-diary-text{margin:0;word-break:break-word;font-family:Georgia,\"Times New Roman\",\"Songti SC\",\"Noto Serif SC\",serif;font-size:14px;line-height:26px;color:var(--dsw-alias-label-primary)}",
      // 正文是渲染过的排版（renderDiaryBody），不再是 <pre> 原文：段落、小标题、
      // 列表各归各位。行高 26px 必须贯穿所有块级元素，否则格线会和字错开。
      ".mneme-diary-text p{margin:0 0 13px}",
      ".mneme-diary-text p:last-child{margin-bottom:0}",
      ".mneme-diary-text h2,.mneme-diary-text h3,.mneme-diary-text h4,.mneme-diary-text h5{margin:13px 0 6px;font-family:inherit;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary)}",
      ".mneme-diary-text h2{font-size:16px}",
      ".mneme-diary-text h3{font-size:15px}",
      ".mneme-diary-text ul,.mneme-diary-text ol{margin:0 0 13px;padding-left:22px}",
      ".mneme-diary-text li{margin:0;line-height:26px}",
      ".mneme-diary-text blockquote{margin:0 0 13px;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--mneme-fg-dim)}",
      ".mneme-diary-text code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px;background:var(--dsw-alias-interactive-bg-active);border-radius:4px;padding:1px 4px}",
      ".mneme-diary-sheet{margin:0;white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:12px;line-height:18px;color:var(--mneme-fg-dim)}",
      ".mneme-diary-empty{padding:14px 0;font-size:12px;line-height:18px;color:var(--mneme-fg-dim)}",
      ".mneme-diary-warn{font-size:12px;line-height:17px;color:var(--mneme-danger)}",
      ".mneme-diary-ok{font-size:12px;line-height:17px;color:var(--mneme-ok)}",
      ".mneme-diary-audit{flex:none;border-top:1px dashed var(--dsw-alias-border-l2);padding-top:8px;display:flex;flex-direction:column;gap:3px;max-height:96px;overflow:auto}",
      ".mneme-diary-audithead{font-size:11px;line-height:16px;letter-spacing:.4px;text-transform:uppercase;color:var(--mneme-fg-dim)}",
      ".mneme-diary-auditrow{font-size:11px;line-height:16px;color:var(--mneme-fg-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      // 会话头入口按钮：尺寸与 M.O. 的 .mneme-pipe-trigger 对齐（28px 行高 / 12px 字号），
      // 手绘感只靠不对称圆角 + 1.5px 描边，颜色仍走宿主语义 token（不新增色值）。
      // --- 人格设计整页（第五个座位）---------------------------------------
      // 刻意**不新开一份 --mneme-* 语义色层**：contrast.test.js 按首次出现的
      // 「--mneme-fg-dim」定义解析色值（:118），再来一份就得保证顺序，收益却为零。
      // 这一页只用第一份色层已经覆盖到的宿主 token 与既有 -dim 类名，靠形状做手绘感。
      ".mneme-persona{display:flex;flex-direction:column;gap:10px;height:100%;min-height:0;padding:10px 12px;box-sizing:border-box;font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary)}",
      ".mneme-persona-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:none}",
      ".mneme-persona-title{font-size:15px;line-height:21px;font-weight:700;letter-spacing:.3px;color:var(--dsw-alias-label-primary)}",
      ".mneme-persona-spacer{flex:1 1 auto;min-width:0}",
      ".mneme-persona-body{display:flex;gap:12px;min-height:0;flex:1 1 auto}",
      ".mneme-persona-about{flex:0 1 auto;min-height:0;max-height:46%;overflow:auto;border-top:1px dashed var(--dsw-alias-border-l2);padding-top:10px;margin-top:2px}",
      ".mneme-persona-about .mneme-set-card{padding:12px 14px;margin-bottom:8px}",
      // 左列身份卡：宽度固定，卡片是「贴纸」而不是菜单行。
      ".mneme-persona-col{flex:0 0 190px;display:flex;flex-direction:column;gap:8px;min-height:0;overflow:auto;padding-right:2px;border-right:1px dashed var(--dsw-alias-border-l2)}",
      ".mneme-persona-card{display:flex;align-items:center;gap:2px}",
      ".mneme-persona-pick{flex:1 1 auto;min-width:0;text-align:left;border:1.5px solid transparent;background:0 0;cursor:pointer;font-family:inherit;font-size:12.5px;line-height:18px;padding:5px 10px;border-radius:12px 8px 13px 9px;color:var(--mneme-fg-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".mneme-persona-pick:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-persona-pick:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      ".mneme-persona-pick--on{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary);font-weight:600;transform:rotate(-.3deg)}",
      ".mneme-persona-del{flex:none;border:0;background:0 0;cursor:pointer;font-family:inherit;font-size:13px;line-height:18px;padding:2px 6px;border-radius:8px;color:var(--mneme-fg-dim)}",
      ".mneme-persona-del:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--mneme-danger)}",
      ".mneme-persona-del:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      ".mneme-persona-new{display:flex;gap:6px;align-items:center;margin-top:2px}",
      // 右列编辑区：一张「卡纸」，与日记纸同一种歪斜语言。
      ".mneme-persona-sheet{flex:1 1 auto;min-width:0;overflow:auto;padding:12px 14px;border:1.5px solid var(--dsw-alias-border-l1);border-radius:16px 11px 15px 9px;transform:rotate(.14deg);display:flex;flex-direction:column;gap:8px}",
      ".mneme-persona-label{font-size:12px;line-height:17px;font-weight:600;letter-spacing:.2px;color:var(--dsw-alias-label-secondary)}",
      ".mneme-persona-note{font-size:12px;line-height:18px;color:var(--mneme-fg-dim)}",
      ".mneme-persona-diary{flex:none;border-top:1px dashed var(--dsw-alias-border-l2);padding-top:8px;display:flex;flex-direction:column;gap:4px}",
      ".mneme-persona-diaryrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--mneme-fg-dim)}",
      ".mneme-persona-preview{margin:0;white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:12px;line-height:19px;color:var(--mneme-fg-dim);max-height:180px;overflow:auto;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px 8px 13px 9px}",
      // ===== 移动端适配（mobile-adapt 车道）=====
      // 为什么主通道是 @container 而不是 @media：面板有两种形态（overlay 弹层与
      // better-sidebar 工作台 tab），容器宽度与视口宽度并不相等；`.mneme-x` 是
      // container-type:inline-size 的容器根（1950 行），两种形态下容器查询都成立。
      // @media 只负责 `.mneme-overlay` 自己的外框——它不在 `.mneme-x` 之内，
      // 容器查询够不到它，这一条只能走视口。
      // 纪律：以下几块内一律不写 color/fill/stroke/background。contrast.test.js 的
      // 规则提取器按「单层花括号」匹配（/^([^{]+)\{([^}]*)\}$/），双花括号的
      // @container / @media 整串不匹配而被跳过——在这样的块里写颜色等于绕过 #178
      // 的 AA 主锁，属于静默失效，不是优化。布局属性不受影响。
      "@media (max-width: 640px){.mneme-overlay{width:calc(100vw - 16px);height:calc(100dvh - 16px);border-radius:12px}}",
      // 触屏没有 hover：设置页的删除钮 base 是 opacity:0、只靠 :hover/:focus-within
      // 恢复（2088-2089），手机上等于永久不可见。#457 与 #459 两次回滚都是因为把
      // hover 配色一起改了，所以这里只加「常显」，不碰颜色。min-height:24px 是
      // WCAG 2.5.8 AA 的触控目标下限，顺手补到常显按钮上。
      "@media (hover:none){.mneme-set-del{opacity:1;padding:0 8px;min-height:24px}.mneme-footbtn{min-height:24px}}",
      // 主断点 480：骨架换向，不是继续收窄数值。临界宽度实算——卡片要 252+48=300、
      // 左栏 216+1，面板得 ≥517px；实体属性网格要 248、rail 224+1，得 ≥473px。
      // 目标区间上沿只有 430px，靠收窄永远追不上，只能改骨架。
      // 左右分栏在窄容器里改上下：左栏/rail 限高可滚，不允许自然撑开把主区挤掉；
      // 不做折叠按钮（要 JS 状态 + 新 i18n 键，成本高于收益）。
      // 抽屉改满宽不丢关闭入口：抽屉自带 ✕（.mneme-drawerbar）；锚点是
      // .mneme-xmain 自己的 position:relative（2252），换向后仍然成立。
      // 实体页换向的前提：rail 侧本就 .mneme-entrailbody{overflow-y:auto} +
      // .mneme-enttype{sticky}（2046/2047），叠放后天然可滚、零 JS、不加文案键。
      // 图谱只在 CSS 层止血（高度 + touch-action + 标签字号）：它能拖能缩依赖
      // onMouseDown/onMouseMove/wheel，全仓 onPointerDown/onTouchStart 命中 0，
      // 那是能力缺失不是样式问题，归后续车道。
      // 页签的横向滚动也归这一档：4 个带图标的 tab 约 436px，而本档给 .mneme-xbar 留的
      // 可用宽度是容器宽减 62px（左 10 + 右 52 让位给绝对定位的 ⋯），480px 时只剩 418px
      // ——整段 361–480px 都会把页签顶到 ⋯ 底下，只写 360 档等于把症状留在主断点全程。
      // menu / impdialog / sharedialog 三处窄屏宽度必须带 box-sizing:border-box：全文件没有
      // *{box-sizing} 兜底（实数 0 处），声明的那个数是内容宽，外宽还要再加 padding+border
      // ——impdialog +30px、menu +12px，320px 视口下比屏幕还宽，会被 overlay 裁掉。
      // sharedialog 自己不带 padding：它和 impdialog 同挂一条 div（见 JSX 里的
      // `className:"mneme-impdialog mneme-sharedialog"`），盒模型由 impdialog 带过来，
      // 所以它同样 +30px；宽度取哪一条由源码顺序决定，故两条都得是 border-box。
      "@container (max-width: 480px){.mneme-xbar{justify-content:flex-start;padding:0 52px 0 10px}.mneme-vtab{padding:0 10px}.mneme-vtabs{min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}.mneme-vtabs::-webkit-scrollbar{height:0}.mneme-xmain{flex-direction:column}.mneme-xside{width:100%;flex:0 1 auto;min-height:0;max-height:min(42vh,300px);border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2);overscroll-behavior:contain}.mneme-xbrowsebar{padding:8px 12px}.mneme-filterbar{padding:8px 12px}.mneme-drawer{width:100%}.mneme-drawerbody{padding:16px 14px 24px}.mneme-cards{padding:14px 12px 24px;overscroll-behavior:contain}.mneme-ent{flex-direction:column}.mneme-entrail{width:100%;flex:0 1 auto;min-height:0;max-height:min(40vh,280px);border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2)}.mneme-entrailbody{overscroll-behavior:contain}.mneme-entdetail{padding:16px 14px 24px}.mneme-set{padding:8px 14px 40px}.mneme-status{padding:16px 14px 32px}.mneme-menu{box-sizing:border-box;min-width:0;width:min(200px,calc(100cqw - 32px))}.mneme-impdialog{box-sizing:border-box;width:min(300px,calc(100cqw - 32px))}.mneme-sharedialog{box-sizing:border-box;width:min(340px,calc(100cqw - 32px))}.mneme-graph{padding:10px 12px 12px}.mneme-graphsvg{max-height:min(320px,52vh);touch-action:pan-y}.mneme-glabel{font-size:14px}.mneme-graphside{position:static;width:auto;max-width:100%;max-height:min(200px,30vh);margin-top:8px}}",
      // 360 档只做两件事：隐掉 14px 的 tab 图标（.mneme-vtab 带图标时约 109px/个、
      // 4 个约 436px，320px 容器原地就横向溢出），再把正文 padding 收到 12–14px。
      // 页签横向滚动不在这一档、属于 480 主断点，理由见 480 档那条算式。
      "@container (max-width: 360px){.mneme-vtabico{display:none}.mneme-vtab{padding:0 8px;font-size:13px}.mneme-xbar{padding:0 46px 0 8px}.mneme-cards{grid-template-columns:1fr;padding:12px 10px 20px}.mneme-xside{max-height:min(46vh,260px)}.mneme-entrail{max-height:min(44vh,240px)}.mneme-entdetail{padding:14px 12px 22px}.mneme-set{padding:8px 12px 36px}.mneme-status{padding:14px 12px 30px}}",
    ].join("\n");
    if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "@modusensus/dsh-mneme";
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    const h = react.createElement;

    /* panel-geometry:begin
     * 几何原语层（视觉系统 P1a，docs/plans/2026-11-10-panel-visual-system.md）。
     * 面板此前没有组件层：每张卡片、每一行都手写 div + 行内 style，同一件事写 180 次、
     * 180 次各自算间距，于是 padding 长出 107 种取值。这一层只做一件事：把
     * 「间距/圆角/字号」收成 Token，并让调用点无法绕过它。
     *
     * 约定（写代码的人只需要记这一条）：所有几何参数只收 GEOMETRY 表里的键，
     * 传表外的值（9、10、14、16.5、「8px」）当场抛错。宁可渲染炸掉，也不要
     * 悄悄画出一个第 108 种间距——后者没人会发现，前者一进测试就红。
     *
     * 标记注释不是装饰：test/panel-tokens.test.js 把 begin/end 之间这段抽出来
     * 直接跑（注入一个假的 createElement），所以这段必须保持纯函数、不许 require。
     */
    const GEOMETRY = {
      space: [0, 2, 4, 6, 8, 12, 16, 20, 24],
      radius: [4, 8, "pill"],
      type: [12, 13, 15],
      weight: [400, 600]
    };
    function geometryVar(group, key) {
      const table = GEOMETRY[group];
      if (!table) throw new Error("mneme panel: 未知刻度组 " + group);
      if (!table.includes(key)) {
        throw new Error(
          "mneme panel: " + group + " 不接受 " + JSON.stringify(key) +
          "——只收刻度 " + table.join("/") + "（见 lib/client.js 的 GEOMETRY）"
        );
      }
      return "var(--mneme-" + group + "-" + key + ")";
    }
    const space = (key) => geometryVar("space", key);
    const radius = (key) => geometryVar("radius", key);
    const fontOf = (key) => geometryVar("type", key);
    const weightOf = (key) => geometryVar("weight", key);

    function Stack(o) {
      const p = o || {};
      const style = Object.assign(
        { display: "flex", flexDirection: p.direction || "column", gap: space(p.gap == null ? 0 : p.gap), padding: space(p.pad == null ? 0 : p.pad) },
        p.align ? { alignItems: p.align } : null,
        p.justify ? { justifyContent: p.justify } : null,
        p.wrap ? { flexWrap: "wrap" } : null,
        p.grow ? { flexGrow: 1, minWidth: 0 } : null,
        p.style || null
      );
      return h("div", { className: p.className, style }, p.children);
    }
    function Inline(o) {
      const p = o || {};
      return Stack(Object.assign({}, p, { direction: "row", align: p.align || "center", gap: p.gap == null ? 6 : p.gap }));
    }
    // 唯一允许自己写内距的壳：卡片内距只有两档，dense 给紧凑列表用。
    function Card(o) {
      const p = o || {};
      const head = p.title == null && p.actions == null ? null : h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: space(8), marginBottom: space(8) } },
        h("div", { style: { fontSize: fontOf(13), fontWeight: weightOf(600), color: "var(--dsw-alias-label-primary)", minWidth: 0 } }, p.title),
        p.actions == null ? null : h("div", { style: { display: "flex", alignItems: "center", gap: space(6), flex: "none" } }, p.actions)
      );
      return h(
        "div",
        {
          className: p.className,
          style: Object.assign(
            {
              boxSizing: "border-box",
              border: "1px solid var(--dsw-alias-border-l2)",
              borderRadius: radius(8),
              padding: p.dense ? space(8) : space(12),
              background: "transparent",
              minWidth: 0
            },
            p.style || null
          )
        },
        head,
        p.children
      );
    }
    function Section(o) {
      const p = o || {};
      return h(
        "section",
        { style: Object.assign({ display: "flex", flexDirection: "column", gap: space(8), marginBottom: space(16) }, p.style || null) },
        p.title == null && p.hint == null ? null : h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: space(2) } },
          p.title == null ? null : h("h3", { style: { margin: 0, fontSize: fontOf(13), fontWeight: weightOf(600), color: "var(--dsw-alias-label-primary)" } }, p.title),
          p.hint == null ? null : h("p", { style: { margin: 0, fontSize: fontOf(12), lineHeight: 1.5, color: "var(--mneme-fg-dim)" } }, p.hint)
        ),
        p.children
      );
    }
    // 仪表盘栅格：auto-fill 而不是断点，容器宽度变化时自己重排。
    function Grid(o) {
      const p = o || {};
      return h(
        "div",
        {
          style: Object.assign(
            { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(" + (p.min || 220) + "px,1fr))", gap: space(p.gap == null ? 12 : p.gap) },
            p.style || null
          )
        },
        p.children
      );
    }
    /* panel-geometry:end */


    // --- graph view constants ---
    // Entity type → node fill. The host has no palette token for categorical
    // data, so these are fixed hues tuned for both light and dark themes
    // (medium saturation, similar luminance).
    const TYPE_COLORS = {
      person: "#3b82f6",
      project: "#22c55e",
      concept: "#a855f7",
      technology: "#f59e0b",
      organization: "#06b6d4"
    };
    function typeColor(type) {
      return TYPE_COLORS[type] || "#94a3b8";
    }

    // Memory-type → dot fill, shared by the type filter, timeline rows and the
    // detail meta so one hue always means one memory type across the panel.
    // Same palette rules as TYPE_COLORS: fixed hues, medium saturation,
    // similar luminance, legible on light and dark themes.
    const MEMORY_TYPE_COLORS = {
      preference: "#f59e0b",
      project: "#22c55e",
      decision: "#3b82f6",
      summary: "#a855f7",
      history: "#94a3b8",
      // codingRetrospect 的三类编码记忆：警示色区分度最高——踩坑/被否决方案
      // 天然带"注意"语义，工程约束用冷色表达"规则"。
      rejected_solution: "#fb923c",
      pitfall: "#ef4444",
      constraint: "#0ea5e9"
    };
    function memoryTypeColor(type) {
      return MEMORY_TYPE_COLORS[type] || "#94a3b8";
    }

    // Compact date for the detail meta ("2026/8/16"); the full timestamp
    // stays in the tooltip.
    function formatDateShort(value) {
      if (!value) return "—";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
    }
    // Graph canvas space: the svg's fixed viewBox. The simulation runs in
    // these user units — never in CSS pixels — so node positions always land
    // inside the drawn area; the browser scales the viewBox to whatever the
    // element's CSS size is (small window, hidden tab, maximized #72).
    const VIEW_W = 380, VIEW_H = 300;

    function nodeRadius(n) {
      // mention_count → area-ish growth, clamped so hubs stay legible.
      const base = 7 + Math.min(20, Math.max(1, n.mention_count ?? 1)) * 0.55;
      // heat projection (0-1 or null): hot entities render slightly larger.
      if (n.heat == null) return base;
      return base + (Math.max(0, Math.min(1, n.heat)) - 0.5) * 4;
    }

    function nodeOpacity(n) {
      // heat projection: hot entities are bright (opacity 1), cold fade to 0.4.
      if (n.heat == null) return 1;
      return 0.4 + 0.6 * Math.max(0, Math.min(1, n.heat));
    }

    // Deterministic golden-angle spiral: no two nodes start overlapping, and
    // re-running the layout for the same data is stable (no random seeding).
    function initialPositions(nodes, width, height) {
      const cx = width / 2;
      const cy = height / 2;
      return nodes.map((n, i) => {
        const r = i === 0 ? 0 : 34 + 13 * Math.sqrt(i);
        const a = i * 2.39996;
        return { ...n, x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), vx: 0, vy: 0, pinned: false };
      });
    }

    // --- Entity explorer: the entity-gene layers made visible ---
    // Rail = the entity directory (grouped by type, mention-ranked inside a
    // type). Detail = the layered structure from docs/ENTITIES.md:
    //   ① 属性  current snapshot of entity_attrs (saveAttr invalidates old rows)
    //   ② 关系  entity_relations touching the entity (from the 1-hop ego walk)
    //   ③ 关联记忆  memories recalled through the entity: prefix search
    //   ④ 关系图谱  the same ego graph the old graph-only tab drew
    function EntityPanel({ t, focusEntity, onJumpMemory }) {
      const [entities, setEntities] = useState(null);
      // 目录只取最近 500 个（limit=500），可「一共抽出多少实体」问的是全库。
      // 后端回 total + totalExact（见 src/api.js 的 /entities），这里必须用全库数，
      // 否则左侧栏永远显示「500 个实体」——那正是「实体太少」这个观感的另一半来源：
      // 状态页已经在 #559 修正，实体页这一处当时漏了。null = 全库数读不到（老宿主
      // 或计数失败），此时退回切片长度并如实标成切片口径，不冒充全库。
      const [entityTotal, setEntityTotal] = useState(null);
      const [railQuery, setRailQuery] = useState("");
      const [entityName, setEntityName] = useState(focusEntity || "");
      const [depth, setDepth] = useState(1);
      const [data, setData] = useState(null);
      const [status, setStatus] = useState("idle"); // idle | loading | ready | notfound | error
      const [selected, setSelected] = useState(null); // { kind: "node"|"edge", node?|edge? }
      const [attrs, setAttrs] = useState([]);
      const [related, setRelated] = useState([]);
      // issue #24 块4：被动确认的复核面。默认收起——它是一个「想查的时候
      // 才查」的面，不该占实体页第一屏；展开时才去取，省一次请求。
      const [boostedOpen, setBoostedOpen] = useState(false);
      const [boosted, setBoosted] = useState(null); // { count, passiveConfirmEnabled, items }
      const svgRef = useRef(null);
      const posRef = useRef([]); // live simulation positions, not React state
      const dragRef = useRef(null); // { id, moved }
      const viewRef = useRef({ x: 0, y: 0, k: 1 }); // pan/zoom viewport, viewBox units
      const [frame, setFrame] = useState(0); // re-render tick driven by the simulation
      // 通用失效广播的重取游标：记忆行的增删改会连带实体属性/关联记忆/关系边，
      // 目录与各层数据的 effect 依赖都带上它（见下方订阅 effect）。
      const [dataTick, setDataTick] = useState(0);

      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/entities?limit=500")
          .then((r) => (r.ok ? r.json() : { entities: [] }))
          .then((j) => {
            if (cancelled) return;
            setEntities(Array.isArray(j.entities) ? j.entities : []);
            setEntityTotal(j.totalExact === true && typeof j.total === "number" ? j.total : null);
          })
          .catch(() => { if (!cancelled) { setEntities([]); setEntityTotal(null); } });
        return () => { cancelled = true; };
      }, [dataTick]);

      // 通用失效广播订阅：实体抽取随写入发生，本页签对别处的改库（删除记忆、
      // 裁决冲突、导入）无从感知——不订阅的话，切回来之前图谱一直是旧的。
      useEffect(() => {
        const onChanged = () => setDataTick((k) => k + 1);
        window.addEventListener("mneme:store-changed", onChanged);
        return () => window.removeEventListener("mneme:store-changed", onChanged);
      }, []);

      useEffect(() => {
        if (focusEntity && focusEntity !== entityName) {
          setEntityName(focusEntity);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [focusEntity]);

      // Auto-select the most recently seen entity so the layers are never a
      // dead end on first open (the rail still allows picking another one).
      useEffect(() => {
        if (!entities || entityName || entities.length === 0) return;
        setEntityName(entities[0].name);
      }, [entities, entityName]);

      const load = useCallback(async (name, d) => {
        if (!name) { setData(null); setStatus("idle"); return; }
        setStatus("loading");
        setSelected(null);
        try {
          const res = await apiFetch(`/api/dsh-mneme/semantic/graph/ego?entity=${encodeURIComponent(name)}&depth=${d}`);
          if (res.status === 404) { setData(null); setStatus("notfound"); return; }
          if (!res.ok) { setData(null); setStatus("error"); return; }
          const json = await res.json();
          setData(json);
          setStatus("ready");
        } catch {
          setData(null);
          setStatus("error");
        }
      }, []);

      useEffect(() => { load(entityName, depth); }, [load, entityName, depth, dataTick]);

      // Layer data for the selected entity: current attrs + related memories.
      useEffect(() => {
        setAttrs([]);
        setRelated([]);
        if (!entityName) return;
        let cancelled = false;
        apiFetch(`/api/dsh-mneme/semantic/graph/entity-attrs?entity=${encodeURIComponent(entityName)}`)
          .then((r) => (r.ok ? r.json() : { attrs: [] }))
          .then((j) => { if (!cancelled) setAttrs(Array.isArray(j.attrs) ? j.attrs : []); })
          .catch(() => {});
        apiFetch(`/api/dsh-mneme/search?q=${encodeURIComponent("entity:" + entityName)}&limit=10`)
          .then((r) => (r.ok ? r.json() : { items: [] }))
          .then((j) => { if (!cancelled) setRelated(Array.isArray(j.items) ? j.items : []); })
          .catch(() => {});
        return () => { cancelled = true; };
      }, [entityName, dataTick]);

      // issue #24 块4 复核面：只在展开时取，收起时不发请求。
      const loadBoosted = useCallback(async () => {
        try {
          const res = await apiFetch("/api/dsh-mneme/semantic/graph/boosted-relations?limit=100");
          setBoosted(res.ok
            ? await res.json()
            : { count: 0, items: [], passiveConfirmEnabled: false, error: true });
        } catch {
          setBoosted({ count: 0, items: [], passiveConfirmEnabled: false, error: true });
        }
      }, []);
      useEffect(() => {
        if (boostedOpen) loadBoosted();
      }, [boostedOpen, loadBoosted]);

      // Simulation: run in rAF against posRef, tick React only every few frames.
      // Re-seeds when data changes; dragging writes straight into posRef.
      useEffect(() => {
        if (!data || data.nodes.length === 0) return;
        // Bounds in viewBox units: measuring clientWidth here put the gravity
        // center and clamp range outside the 380-wide viewBox once the window
        // (or its hidden-then-shown container) got wide, and every node was
        // clipped off-canvas — the maximized-invisible bug (#72).
        posRef.current = initialPositions(data.nodes, VIEW_W, VIEW_H);
        const byId = new Map(posRef.current.map((n) => [n.id, n]));
        const edges = data.edges;
        let raf = 0;
        let n = 0;
        const tick = () => {
          const nodes = posRef.current;
          // pairwise repulsion, capped so far nodes don't explode
          for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
              const a = nodes[i], b = nodes[j];
              let dx = b.x - a.x, dy = b.y - a.y;
              let d2 = dx * dx + dy * dy;
              if (d2 < 1) { dx = (Math.random() - 0.5) || 1; dy = (Math.random() - 0.5) || 1; d2 = dx * dx + dy * dy; }
              const d = Math.sqrt(d2);
              const f = Math.min(2200 / d2, 6);
              const fx = (dx / d) * f, fy = (dy / d) * f;
              a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
            }
          }
          // edge springs pull toward the target length
          for (const e of edges) {
            const a = byId.get(e.from), b = byId.get(e.to);
            if (!a || !b) continue;
            const dx = b.x - a.x, dy = b.y - a.y;
            const d = Math.sqrt(dx * dx + dy * dy) || 1;
            const f = (d - 90) * 0.02;
            const fx = (dx / d) * f, fy = (dy / d) * f;
            a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
          }
          let energy = 0;
          for (const node of nodes) {
            // gentle gravity toward center keeps the cloud from drifting off-canvas
            node.vx += (VIEW_W / 2 - node.x) * 0.002;
            node.vy += (VIEW_H / 2 - node.y) * 0.002;
            if (node.pinned || node === dragRef.current?.node) { node.vx = 0; node.vy = 0; continue; }
            node.vx *= 0.85; node.vy *= 0.85;
            node.x = Math.max(nodeRadius(node) + 4, Math.min(VIEW_W - nodeRadius(node) - 4, node.x + node.vx));
            node.y = Math.max(nodeRadius(node) + 14, Math.min(VIEW_H - nodeRadius(node) - 14, node.y + node.vy));
            energy += Math.abs(node.vx) + Math.abs(node.vy);
          }
          n++;
          if (n % 3 === 0) setFrame((f) => f + 1);
          if (n < 300 && energy > 0.4) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
      }, [data]);

      // drag handling on the svg surface
      const onNodeMouseDown = (e, node) => {
        e.preventDefault();
        e.stopPropagation(); // node drag must not start a background pan
        dragRef.current = { node, moved: false };
        const startX = e.clientX, startY = e.clientY;
        const origX = node.x, origY = node.y;
        const svg = svgRef.current;
        const rect = svg.getBoundingClientRect();
        const scale = VIEW_W / Math.max(1, rect.width) / viewRef.current.k; // viewBox units per css px, zoom-aware
        const onMove = (ev) => {
          dragRef.current.moved = true;
          node.x = origX + (ev.clientX - startX) * scale;
          node.y = origY + (ev.clientY - startY) * scale;
          setFrame((f) => f + 1);
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          setTimeout(() => { dragRef.current = null; }, 0);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      };

      const onNodeClick = (node) => {
        if (dragRef.current?.moved) return; // it was a drag, not a click
        setSelected({ kind: "node", node });
      };
      const onEdgeClick = (edge) => setSelected({ kind: "edge", edge });

      // --- canvas pan & zoom ---
      // The viewport (translate + scale) lives in viewRef so the simulation
      // and the handlers share it without re-mounting; every mutation bumps
      // `frame` to re-render. Panning starts on the bare svg surface (node
      // mousedowns stopPropagation above); zooming is a native non-passive
      // wheel listener because React attaches wheel handlers passively and
      // could not preventDefault the page scroll.
      const svgToView = (clientX, clientY) => {
        const svg = svgRef.current;
        const rect = svg.getBoundingClientRect();
        const sx = VIEW_W / Math.max(1, rect.width);
        const sy = VIEW_H / Math.max(1, rect.height);
        return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
      };

      const onSurfaceMouseDown = (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const start = { x: e.clientX, y: e.clientY };
        const orig = { ...viewRef.current };
        const onMove = (ev) => {
          const rect = svgRef.current?.getBoundingClientRect();
          if (!rect) return;
          const sx = VIEW_W / Math.max(1, rect.width);
          const sy = VIEW_H / Math.max(1, rect.height);
          const v = viewRef.current;
          v.x = orig.x + (ev.clientX - start.x) * sx;
          v.y = orig.y + (ev.clientY - start.y) * sy;
          setFrame((f) => f + 1);
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      };

      useEffect(() => {
        const svg = svgRef.current;
        if (!svg) return undefined;
        const onWheel = (e) => {
          e.preventDefault();
          const v = viewRef.current;
          const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
          const k = Math.min(3, Math.max(0.5, v.k * factor));
          const s = svgToView(e.clientX, e.clientY);
          // keep the point under the cursor pinned while the scale changes
          const px = (s.x - v.x) / v.k;
          const py = (s.y - v.y) / v.k;
          v.k = k;
          v.x = s.x - px * k;
          v.y = s.y - py * k;
          setFrame((f) => f + 1);
        };
        svg.addEventListener("wheel", onWheel, { passive: false });
        return () => svg.removeEventListener("wheel", onWheel);
      });

      const resetView = () => {
        viewRef.current = { x: 0, y: 0, k: 1 };
        setFrame((f) => f + 1);
      };

      const nodes = posRef.current;
      const nodeById = new Map(nodes.map((n) => [n.id, n]));

      // --- rail: entity directory grouped by type ---
      const q = railQuery.trim().toLowerCase();
      const visibleEntities = (entities || []).filter((e) => !q || (e.name || "").toLowerCase().includes(q));
      const ENTITY_TYPE_ORDER = ["person", "project", "concept", "technology", "organization"];
      const groups = [];
      const byType = new Map();
      for (const e of visibleEntities) {
        const key = ENTITY_TYPE_ORDER.includes(e.type) ? e.type : "other";
        if (!byType.has(key)) { const g = { key, items: [] }; byType.set(key, g); groups.push(g); }
        byType.get(key).items.push(e);
      }

      const entity = entities?.find((e) => e.name === entityName) || null;
      const rootEdges = (data?.edges || []).filter((e) => e.from === data?.root?.id || e.to === data?.root?.id);
      const graphStatus = status === "ready" && data && data.nodes.length <= 1 ? "empty" : status;

      const rail = h("div", { className: "mneme-entrail" },
        // 头部固定段：表头（本页名「实体」——原误用全局页签名「记忆库」，而
        // memory.view.label 仍被顶部 nav aria-label 使用，字典不动只换这里）
        // + 搜索 + 计数，不随列表滚动。
        h("div", { className: "mneme-entrailhead" },
          h("div", { className: "mneme-xcolhead" }, t("memory.explorer.tabEntities")),
          h("input", {
            className: "mneme-search mneme-xsearch",
            placeholder: t("memory.graph.placeholder"),
            value: railQuery,
            onChange: (e) => setRailQuery(e.target.value)
          }),
          // 大数字用全库数；全库数读不到（老宿主 / 计数失败）时退回切片长度，
          // 但那只是「这次取回多少」，所以要多一行脚注说清列表本身只列最近 500 个。
          entities !== null && entities.length > 0 && h("div", { className: "mneme-xcount" },
            t("memory.entities.count").replace("{n}", String(entityTotal !== null ? entityTotal : entities.length))),
          entities !== null && entityTotal !== null && entityTotal > entities.length
            && h("div", { className: "mneme-xcountnote" },
              t("memory.entities.countSampled").replace("{shown}", String(entities.length)))
        ),
        h("div", { className: "mneme-entrailbody" },
          entities === null && h("div", { className: "mneme-xempty" }, "…"),
          entities !== null && entities.length === 0 && h("div", { className: "mneme-xempty" }, t("memory.entities.none")),
          entities !== null && entities.length > 0 && visibleEntities.length === 0 && h("div", { className: "mneme-xempty" }, t("memory.entities.noMatch")),
          groups.map((g) => h("div", { key: g.key },
            h("div", { className: "mneme-enttype" },
              h("span", { className: "mneme-xdot", style: { color: typeColor(g.key === "other" ? null : g.key) }, "aria-hidden": "true" }),
              entityTypeLabel(t, g.key)
            ),
            g.items.map((e) => h("button", {
              key: e.id,
              className: e.name === entityName ? "mneme-entitem mneme-active" : "mneme-entitem",
              onClick: () => setEntityName(e.name)
            },
              h("span", { className: "mneme-entname" }, e.name),
              h("span", { className: "mneme-entmentions" }, `×${e.mention_count ?? 1}`)
            ))
          ))
        )
      );

      // side card for a clicked (non-root) node or edge inside the graph layer
      const side = selected?.kind === "node"
        ? h("div", { className: "mneme-graphside" },
            h("div", { className: "mneme-gs-title" },
              h("span", null, selected.node.name),
              h("span", { className: "mneme-gs-meta" },
                `${entityTypeLabel(t, selected.node.type || "concept")} · `,
                h(StarGlyph, { size: 11 }),
                ` ${selected.node.mention_count ?? 1}`)
            ),
            selected.node.name !== entityName && h("button", {
              className: "mneme-footbtn",
              onClick: () => setEntityName(selected.node.name)
            }, t("memory.graph.viewInGraph"))
          )
        : selected?.kind === "edge"
          ? h("div", { className: "mneme-graphside" },
              h("div", { className: "mneme-gs-title" },
                h("span", null,
                  `${nodeById.get(selected.edge.from)?.name ?? "?"} → ${selected.edge.relation_type} → ${nodeById.get(selected.edge.to)?.name ?? "?"}`)
              ),
              h("div", { className: "mneme-gs-meta" },
                `${t("memory.graph.relation")} · ${formatRelativeTime(selected.edge.created_at, t)}`),
              // issue #24 块4：复核要看得见「这条边被抬过」。weight 是当前分，
              // source 决定它的起点（manual 1.0 / confirmed 1.0 / tag 0.3 / llm 0.4）——
              // 只看 weight 会把「tag 边被抬到 0.5」误读成「比 manual 边弱」。
              (selected.edge.weight !== undefined || selected.edge.source !== undefined) && h("div", { className: "mneme-gs-meta" },
                selected.edge.weight !== undefined
                  ? t("memory.graph.weight").replace("{w}", Number(selected.edge.weight).toFixed(2))
                  : null,
                selected.edge.weight !== undefined && selected.edge.source ? " · " : null,
                selected.edge.source
                  ? t("memory.graph.source").replace("{s}", t(`memory.graph.src.${selected.edge.source}`) || selected.edge.source)
                  : null),
              // #619 可见化 B：情感边单独一行，形状与上面两行（关系时间 / 权重来源）
              // 区分开——它答的是「这是什么情绪、算一次还是算一类」，不是权重问题。
              //
              // 三种形态必须分得清，否则界面上会出现两种假话：
              //  · metadata 为空 → 这是抽取器写的老边（或人工边），本来就没有情绪，
              //    不显示任何情绪行。显示「情绪 —」等于说「有边但情绪丢了」。
              //  · metadata.emotion 有值、promotedToTrait !== true → 一次具体场合。
              //  · promotedToTrait === true → 已升格为稳定倾向，必须带上跨几个独立
              //    场合，否则用户会把「一次情绪」和「一贯倾向」读成同一件事。
              (() => {
                const meta = selected.edge.metadata;
                if (!meta || typeof meta !== "object") return null;
                const emotion = typeof meta.emotion === "string" ? meta.emotion.trim() : "";
                if (!emotion) return null;
                const attrs = [];
                if (meta.promotedToTrait === true) {
                  const n = Number(meta.traitSessionCount);
                  attrs.push(Number.isFinite(n) && n > 0
                    ? t("memory.graph.affectiveTrait").replace("{n}", String(n))
                    : t("memory.graph.affectiveTrait").replace("{n}", "?"));
                } else {
                  // 场合档：说「这一次」。sessionCount > 1 时不能借用 trait 的文案
                  // ——那会把这批边说成「稳定倾向」，而升格是另一回事（判据是跨
                  // 独立会话数达到阈值并铸出 pattern，标记在 promotedToTrait 上）。
                  const sessions = Number(meta.sessionCount);
                  attrs.push(Number.isFinite(sessions) && sessions > 1
                    ? t("memory.graph.affectiveOccasions").replace("{n}", String(sessions))
                    : t("memory.graph.affectiveOccasion"));
                }
                if (typeof meta.attribution === "string" && meta.attribution.trim()) {
                  attrs.push(meta.attribution.trim());
                }
                // 证据条数用带标签的短语，不裸放一个数字——裸数字读起来像权重或 id。
                if (Array.isArray(meta.evidence) && meta.evidence.length > 0) {
                  attrs.push(t("memory.graph.affectiveEvidence").replace("{n}", String(meta.evidence.length)));
                }
                return h("div", { className: "mneme-gs-meta mneme-gs-affective" },
                  t("memory.graph.emotion").replace("{e}", emotion),
                  attrs.length > 0 ? ` · ${attrs.join(" · ")}` : null);
              })(),
              selected.edge.memory_id && h("button", {
                className: "mneme-footbtn",
                onClick: () => onJumpMemory && onJumpMemory({ id: selected.edge.memory_id })
              }, t("memory.graph.sourceMemory"))
            )
          : null;

      const detail = h("div", { className: "mneme-entdetail" },
        h("div", { className: "mneme-entinner" },
          status === "idle" && h("div", { className: "mneme-hint" }, t("memory.entities.pick")),
          status === "loading" && h("div", { className: "mneme-hint" }, t("memory.graph.loading")),
          status === "notfound" && h("div", { className: "mneme-hint" }, t("memory.graph.notFound")),
          status === "error" && h("div", { className: "mneme-hint" }, t("memory.panel.empty")),
          status === "ready" && entity && h(react.Fragment, null,
            h("div", { className: "mneme-enttitle" },
              h("span", { className: "mneme-xdot", style: { color: typeColor(entity.type) }, "aria-hidden": "true" }),
              entity.name
            ),
            h("div", { className: "mneme-entmeta" },
              h("span", null, entityTypeLabel(t, entity.type || "other")),
              h("span", null, t("memory.entities.mentions").replace("{n}", String(entity.mention_count ?? 1))),
              h("span", { title: formatDate(entity.last_seen) },
                `${t("memory.entities.lastSeen")}: ${formatRelativeTime(entity.last_seen, t)}`)
            ),
            // ① 关系图谱（前置）：图形在属性/列表之前，是实体页的第一眼；
            // 深度/复位 chips 从层头移进图谱工具行（动作靠近作用对象），操作
            // 提示收进行尾小字不再独占一行；关系列表（跳来源记忆的唯一入口）
            // 保留为图谱的文本镜像、与图谱同层共享层头，消除信息双轨的分段感。
            h("div", { className: "mneme-layer" },
              h("div", { className: "mneme-layerhead" },
                t("memory.entities.relations"),
                h("span", { className: "mneme-layercount" }, String(rootEdges.length))
              ),
              rootEdges.length === 0 && graphStatus === "empty"
                ? h("div", { className: "mneme-hint" }, t("memory.graph.empty"))
                : h(react.Fragment, null,
                    graphStatus !== "empty" && h("div", { className: "mneme-graphbar" },
                      h("button", {
                        className: depth === 2 ? "mneme-chip mneme-active" : "mneme-chip",
                        title: t("memory.graph.depth"),
                        onClick: () => setDepth(depth === 1 ? 2 : 1)
                      }, `${depth} ${t("memory.graph.depth")}`),
                      h("button", {
                        className: "mneme-chip",
                        title: t("memory.graph.resetView"),
                        onClick: resetView
                      }, t("memory.graph.resetView")),
                      h("span", { style: { marginLeft: "auto", fontSize: 12, color: "var(--mneme-fg-dim)" } }, t("memory.graph.hint"))
                    ),
                    graphStatus !== "empty" && h("div", { className: "mneme-entgraphwrap" },
                      h("svg", {
                        ref: svgRef,
                        className: "mneme-graphsvg",
                        viewBox: `0 0 ${VIEW_W} ${VIEW_H}`,
                        style: { height: 440 },
                        role: "img",
                        "aria-label": t("memory.graph.summary")
                          .replace("{entity}", (data.root && (data.root.label || data.root.name)) || "")
                          .replace("{nodes}", String(data.nodes.length))
                          .replace("{edges}", String(data.edges.length)),
                        onMouseDown: onSurfaceMouseDown
                      },
                        h("g", {
                          transform: `translate(${viewRef.current.x},${viewRef.current.y}) scale(${viewRef.current.k})`
                        },
                          data.edges.map((e) => {
                            const a = nodeById.get(e.from), b = nodeById.get(e.to);
                            if (!a || !b) return null;
                            return h("line", {
                              key: e.id,
                              x1: a.x, y1: a.y, x2: b.x, y2: b.y,
                              className: e.memory_id ? "mneme-gedge" : "mneme-gedge mneme-gedge-dashed",
                              onClick: () => onEdgeClick(e)
                            });
                          }),
                          nodes.map((n) => h("g", {
                            key: n.id,
                            className: n.id === data.root.id ? "mneme-gnode mneme-groot" : "mneme-gnode",
                            transform: `translate(${n.x},${n.y})`,
                            onMouseDown: (e) => onNodeMouseDown(e, n),
                            onClick: () => onNodeClick(n),
                            "data-node": n.name
                          },
                            h("circle", { r: nodeRadius(n), fill: typeColor(n.type), fillOpacity: nodeOpacity(n) }),
                            h("text", { className: "mneme-glabel", y: nodeRadius(n) + 13 }, n.name)
                          ))
                        )
                      ),
                      side
                    ),
                    rootEdges.length > 0 && rootEdges.map((e) => {
                      const out = e.from === data.root.id;
                      const other = nodeById.get(out ? e.to : e.from);
                      const otherName = other?.name ?? (out ? e.to : e.from);
                      // #619 可见化 B：情感边在列表里也要认得出。只列
                      // `affective_context` 这个类型名，用户读不出「什么情绪、算一类
                      // 还是一次」——而这两件事正是这条边的全部信息量。非情感边不受
                      // 影响（meta.emotion 为空），列表宽度也不变。
                      const emo = e.metadata && typeof e.metadata === "object"
                        ? (typeof e.metadata.emotion === "string" ? e.metadata.emotion.trim() : "")
                        : "";
                      const isTrait = e.metadata?.promotedToTrait === true;
                      return h("button", {
                        key: e.id,
                        className: "mneme-relrow",
                        title: e.memory_id ? t("memory.graph.sourceMemory") : undefined,
                        onClick: () => { if (e.memory_id && onJumpMemory) onJumpMemory({ id: e.memory_id }); }
                      },
                        h("span", { className: "mneme-relname", style: { textAlign: "right", flex: 1 } }, entity.name),
                        h("span", { className: "mneme-reltype" }, e.relation_type),
                        emo ? h("span", { className: isTrait ? "mneme-relaffect mneme-relaffect--trait" : "mneme-relaffect" }, emo) : null,
                        h("span", { className: "mneme-relname", style: { flex: 1 } }, otherName)
                      );
                    }),
                    // issue #24 块4「例外管理」的可见面。被动确认是唯一会悄悄
                    // 改变检索形状的动作（正常触达就抬权），所以它必须有个地方
                    // 能查——否则「自动确认」和「没人看过的自动确认」没有区别。
                    // 默认收起：这是审计视角，不是日常视角。
                    h("div", { className: "mneme-boosted" },
                      h("button", {
                        className: boostedOpen ? "mneme-chip mneme-active" : "mneme-chip",
                        "aria-expanded": boostedOpen ? "true" : "false",
                        onClick: () => setBoostedOpen(!boostedOpen),
                        title: t("memory.graph.boosted.hint")
                      }, boostedOpen ? t("memory.graph.boosted.hide") : t("memory.graph.boosted.show")),
                      boostedOpen && h("div", { className: "mneme-boostedbody" },
                        (() => {
                          if (boosted === null) return h("div", { className: "mneme-hint" }, t("memory.graph.loading"));
                          // 加载失败 ≠ 闸关：接口挂了却说「被动确认是关的」，会把人
                          // 引去翻设置，而真正的问题是这一屏没取到数据。
                          if (boosted.error === true) return h("div", { className: "mneme-hint" }, t("memory.graph.boosted.loadFailed"));
                          const items = boosted.items || [];
                          const off = boosted.passiveConfirmEnabled !== true;
                          // 闸关 ≠ 没有数据：已经抬过的边仍然在表里，关掉闸只表示
                          // 「今后不再自动抬」。所以先出闸关提示，再照常列历史——
                          // 否则人永远没法复核既有的提升。
                          // 空表提示与闸门状态无关：闸关且一条都没有时，光说「下面列的是
                          // 此前已经抬过的边」却不给任何行，人会以为这一屏坏了。
                          return h(react.Fragment, null,
                            off && h("div", { className: "mneme-hint" }, t("memory.graph.boosted.gateOff")),
                            items.length === 0
                              ? h("div", { className: "mneme-hint" }, t("memory.graph.boosted.empty"))
                              : h(react.Fragment, null,
                                  h("div", { className: "mneme-hint" }, t("memory.graph.boosted.hint")),
                                  items.map((b) => h("div", {
                                    key: b.id,
                                    className: "mneme-relrow mneme-boostedrow",
                                    title: `${t("memory.graph.source").replace("{s}", t(`memory.graph.src.${b.source}`) || b.source)} · ${Number(b.weight).toFixed(2)}`
                                  },
                                    h("span", { className: "mneme-relname", style: { textAlign: "right", flex: 1 } }, b.from_name ?? b.from),
                                    h("span", { className: "mneme-reltype" }, b.relation_type),
                                    h("span", { className: "mneme-relname", style: { flex: 1 } }, `${b.to_name ?? b.to} `,
                                      h("span", { className: "mneme-boostedgain" },
                                        t("memory.graph.boosted.gain").replace("{g}", Number(b.gain).toFixed(2))))
                                  ))
                                )
                          );
                        })()
                      )
                    )
                  )
            ),
            // ② 属性 — current snapshot (valid_until IS NULL)；空层整层隐藏
            // （原先渲染一行「暂无内容」占住高度，是零信息的堆积）
            attrs.length > 0 && h("div", { className: "mneme-layer" },
              h("div", { className: "mneme-layerhead" },
                t("memory.entities.attrs"),
                h("span", { className: "mneme-layercount" }, String(attrs.length))
              ),
              h("div", { className: "mneme-attrgrid" },
                attrs.map((a, i) => h("div", { key: i, className: "mneme-attrcard", title: a.value },
                  h("div", { className: "mneme-attrkey" }, a.key),
                  h("div", { className: "mneme-attrval" }, a.value)
                ))
              )
            ),
            // ③ 关联记忆 — entity: prefix recall（entity: 之外的唯一记忆回链入口）
            related.length > 0 && h("div", { className: "mneme-layer" },
              h("div", { className: "mneme-layerhead" },
                t("memory.graph.related"),
                h("span", { className: "mneme-layercount" }, String(related.length))
              ),
              related.map((m) => h("button", {
                key: m.id,
                type: "button",
                className: "mneme-gs-link",
                title: t("memory.card.open"),
                onClick: () => onJumpMemory && onJumpMemory(m)
              }, m.title || m.content?.slice(0, 60)))
            )
          )
        )
      );

      return h("div", { className: "mneme-ent" }, rail, detail);
    }


    // --- 功能开关卡片（可插拔后端能力）---
    // GET /features 拿 overrides + effective，PUT 提交增量；启动时 index.js
    // 把持久化的 kv 合并进配置，因此每个开关都标注「重启 DSH 后生效」。
    // 分组排版：核心/增强/巩固常驻，注入策略等收进「高级」折叠，普通用户
    // 不被专业项淹没。429 调速器参数、distillMaxChars、codingBoostFactor
    // 属调优噪音，按对齐结论留在配置文件，不上 UI。
    // #249 第二批：注入形态的父／子开关（父 = autoInject）。子项紧跟父行、缩进
    // 显示；父关时子项加一句「不生效」，但开关仍可点——父关是「不生效」而不是
    // 「重置用户配置」，子项自己勾着的值要留着，也应该能提前设好。同一份关系在
    // 后端 src/config.js 的 INJECT_CHILD_FLAGS（运行时闸门），两侧漂移由
    // test/inject-parent-gate.test.js 钉住。
    const FEATURE_CHILDREN = { autoInject: ["injectGuidanceEnabled", "continuityRescueEnabled"] };
    // Issue #427 建议 1：折叠线挪到「新手之外」。group.basic 是首屏层，只列新
    // 用户敢动的总开关；group.scope 也在首屏——它回答新用户的第二个必答题
    // 「它记的东西会不会被别的会话看到」。其余组整组收进「全部设置」折叠
    // （showAll）。成员从原组里移走而不是渲染时过滤：同一项永远只渲染一次。
    // 首屏可点项 = 3 总开关 + autoInject 的 2 个子开关 + scope 2 开关 +
    // 「全部设置」按钮 = 8。v0.9.0 曾按产品主人点名把 M.O. 独立成组并提进
    // 首屏（当时豁免 ≤8 软预算，理由记在 test/client.test.js 的同名用例里）；
    // 本轮主人决定把 M.O. 下架，那一组连同首屏位一起摘掉，预算回到 8。
    // RuntimeProvisionBlock 配好即消失，常态首屏更少。
    const FEATURE_FIRST_SCREEN = ["group.basic", "group.scope"];
    const FEATURE_GROUPS = [
      { key: "group.basic", items: ["autoInject", "autoSummarize", "autoDream"] },
      { key: "group.core", items: ["hotMemoryEnabled", "injectTimePrefix", "memoryQualityFilter.enabled", "llmAudit.enabled", "writeAdmission.enabled", "writeAdmission.enforce", "preInjectGate.enabled", "preInjectGate.enforce", "sensitiveScanEnabled",
        // #399 的留存总闸（见下方 distillSub：天数行是它的子块）。放在组末，
        // 子块才能紧跟在它后面展开——items.map 之后的子块是按组尾渲染的。
        "distillRecords.enabled"] },
      // M.O. 已下架（v0.13.x）：这一组连同首屏位一起摘掉，不是「折进全部设置」。
      // 反转的是 v0.9.0 时产品主人「别藏在里面」的点名——本轮主人明确要求下架，
      // 所以反向操作。三个键仍在 config schema 与 settings 白名单里，座位闸门那条
      // effect 也仍在（fail-closed：旗标 false 时一个座位都不注册），随时可恢复：
      // 把这行加回 FEATURE_GROUPS 与 FEATURE_FIRST_SCREEN 即可。
      // 面板不再渲染它，等于只剩配置文件一条入口——这是「下架」的本意。
      { key: "group.enhance", items: ["entityExtractionEnabled", "codingRetrospect", "rerankEnabled", "resilientModelDownload", "searchSemanticDedup", "bm25SearchEnabled", "heatEnabled", "documentMemoryEnabled",
        // 人格定义页（beta）：注入总闸。分组随 enhance（行为开关，非座位闸门）；
        // 人格内容在设置页「个性化」区的人格卡。
        // 严格寻址是同一条链上的第二个口径开关（只在总闸打开时起作用）。
        "personaEnabled", "personaStrictAddressing", "profileExtractEnabled",
        // 自动事实（profile_facts）：dream 后的自动维护闸。展示与人工修正不受它管
        // （GET/apply 在 flag 关时照常放行，存量事实要能看能改），它只决定「自动做梦
        // 维护」与面板「立即更新」这两条 LLM 路径开不开。
        "profileFactsEnabled",
        // chorography（仓库地志）的暴露闸（M1 就有的键，M3 才上 UI）：它是「是否
        // 启用这个子系统」而不是「每轮付多少」，所以和上面这些行为开关同组；
        // 每轮付出多少由紧随组尾的 choroSub 档位管。放组末是因为子块按组尾渲染
        // ——档位下拉要贴着它的总闸。
        "chorographyEnabled",
        // 日记本（v0.13）：右栏座位的闸门。和 M.O. 一样是「开关=座位注册与否」，
        // 但它属于「它在替你写字」这一类行为开关，所以归 enhance 而不是单开一组。
        "diaryEnabled"] },
      { key: "group.dream", items: ["sleepModeEnabled", "sleepAffectiveEnabled"] },
      // v0.8.0 A4（issue #17）：作用域隔离组——标注总开关 + 严格硬过滤。
      { key: "group.scope", items: ["scopeEnabled", "strictScope"] }
    ];
    const FEATURE_ADVANCED_BOOLS = ["hybridInject", "selectiveInjectEnabled", "adaptiveThresholdEnabled", "reflectionUpdateEnabled", "reflectionFailureTracking", "conflictFreezeEnabled", "trustEpistemicWeighting"];
    // 字符串键（blur/Enter 提交，空串合法 = 跟随默认）：巩固模型与语义
    // 检索路线。embedProvider 是枚举，用下拉单独渲染。
    const FEATURE_STRINGS = ["dreamProvider", "dreamModel", "sleepProvider", "sleepModel", "entityExtractionProvider", "entityExtractionModel", "localEmbedModel", "ollamaBaseUrl", "ollamaModel",
      // Issue #239 第 4 项：错峰时段串（巩固侧与蒸馏侧）。此前只有后端白名单、
      // 面板调不到——两个错峰键一个能调一个不能比都不给更让人困惑。
      "dreamPeakHours", "summarizePeakHours"];
    // 整数键（blur/Enter 提交，非法值不提交、退回生效值）：
    // issue #399 的 distillRecords.retentionDays。此前它与 enabled 一样只有
    // 后端白名单、面板够不着——而 CONFIGURATION.md 明写「面板可启停」。
    // 其余整数键（429 调速器参数、distillMaxChars、codingBoostFactor）是有意
    // 不上 UI 的调优噪音，见上方注释，别顺手搬进来。
    const FEATURE_NUMBERS = ["distillRecords.retentionDays", "dreamMaxTokens", "sleepMaxTokens", "diaryWriteEveryMinutes"];
    const EMBED_PROVIDERS = ["openai", "local", "ollama"];
    // 实体抽取思考强度（issue #109）：与后端 FEATURE_FLAG_ENUMS 枚举对齐。
    const ENTITY_REASONING = ["none", "low", "medium", "high"];
    // 蒸馏思考强度（issue #315）：比 entity 多一个 off（显式关思考，思考型模型
    // 蒸馏防推理烧预算）。后端枚举含 off，面板必须能选到，否则操作者用不上。
    const SUMMARIZE_REASONING = ["off", "none", "low", "medium", "high"];
    // 地志注入档位（M3）：与后端 settings.js 的 FEATURE_FLAG_ENUMS.chorographyInject
    // 同一份取值。light 是默认档，off 才是不注入。
    const CHORO_TIERS = ["off", "light", "full"];

    function FeatureRow({ name, hint, on, disabled, onToggle, sub, tag }) {
      return h("div", { className: "mneme-featrow", style: sub ? { paddingLeft: 18, opacity: 0.86 } : undefined },
        h("div", { className: "mneme-featmain" },
          h("div", { className: "mneme-featname" }, name,
            // 「默认 / 已改」徽标（#427 建议 3）：不用点开配置文件就知道哪
            // 些是出厂值、哪些被你改过；title 给完整解释（键盘/读屏可达）。
            tag && h("span", { className: "mneme-badge " + tag.kind, title: tag.title }, tag.text)
          ),
          h("div", { className: "mneme-feathint" }, hint)
        ),
        h("button", {
          type: "button",
          className: on ? "mneme-switch mneme-on" : "mneme-switch",
          role: "switch",
          "aria-checked": String(on),
          "aria-label": name,
          disabled,
          onClick: onToggle
        })
      );
    }

    function FeaturesCard({ t }) {
      const [state, setState] = useState(null); // { overrides, effective }
      const [error, setError] = useState("");
      // 保存失败的提示要单独的座位：上面那个 error 只在首屏加载失败（state 还是
      // null）时渲染，state 一到手它就永不出现——于是每一次 put 失败都静默，
      // 草稿留在输入框里，人以为改成功了。
      const [saveError, setSaveError] = useState("");
      const [busy, setBusy] = useState(false);
      const [savedTick, setSavedTick] = useState(false);
      const [showAdv, setShowAdv] = useState(false);
      // Issue #427 建议 1：「全部设置」是第一层折叠（默认收起），「高级」是它
      // 内部的第二层。两个状态独立：收起全部设置时高级的展开与否被记住。
      const [showAll, setShowAll] = useState(false);
      const [strs, setStrs] = useState({}); // 字符串输入的本地草稿：key -> string
      const [nums, setNums] = useState({}); // 数值输入的本地草稿：key -> string（提交时才转整数）
      // 巩固/睡眠模型路由下拉的数据源：GET /llm-providers 探测（云端 v0.7.26+
      // 的插件侧端点）。null = 端点不可用（404/失败）→ 回退纯文本输入，不挡旧后端。
      const [routes, setRoutes] = useState(null);
      // 连通性测试结果（巩固/睡眠/实体抽取各一份，互不串扰）：{ running: true } | { ok, ms, detail }
      const [dreamTest, setDreamTest] = useState(null);
      const [sleepTest, setSleepTest] = useState(null);
      const [entityTest, setEntityTest] = useState(null);

      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/features")
          .then((res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
          .then((j) => {
            if (cancelled) return;
            setState(j);
            const e = (j && j.effective) || {};
            const draft = {};
            for (const key of FEATURE_STRINGS) draft[key] = String(e[key] ?? "");
            setStrs(draft);
            const numDraft = {};
            for (const key of FEATURE_NUMBERS) numDraft[key] = String(e[key] ?? "");
            setNums(numDraft);
          })
          .catch(() => { if (!cancelled) setError(t("memory.features.loadFailed")); });
        return () => { cancelled = true; };
      }, [t]);

      // 插件侧枚举端点探测：不可用时静默保持 routes=null（文本框回退）。
      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/llm-providers")
          .then((res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
          .then((j) => { if (!cancelled) setRoutes(Array.isArray(j && j.providers) ? j.providers : []); })
          .catch(() => {});
        return () => { cancelled = true; };
      }, [t]);

      const eff = (state && state.effective) || {};

      // 返回值 = 这次写入有没有落库。调用方要据此决定草稿的去留。
      const put = async (patch) => {
        setBusy(true);
        try {
          const res = await apiFetch("/api/dsh-mneme/features", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch)
          });
          if (!res.ok) {
            // 服务端的校验失败把键名与范围写进 error（api.js 里那条 400 的注释
            // 就是这么设计的），读出来给人看。拿不到 body 才退回状态码——
            // 总之不能只剩一句「失败」让人猜是哪个开关、错在哪。
            const detail = await res.json()
              .then((j) => (j && j.error) || "")
              .catch(() => "");
            throw new Error(detail || ("HTTP " + res.status));
          }
          setState(await res.json());
          setSaveError("");
          // 功能开关即改即存：别的卡在读同一份 effective 快照（画像事实卡的
          // 「立即更新」按钮禁用态）——广播让它们重读，不然按提示开了开关还得
          // 关面板重开才解禁，正是本车道广播工作项要消灭的那类体验。
          try { window.dispatchEvent(new CustomEvent("mneme:features-changed")); } catch { /* 非浏览器环境 */ }
          announce(t("memory.features.restartHint"));
          setSavedTick(true);
          setTimeout(() => setSavedTick(false), 1800);
          return true;
        } catch (err) {
          const why = (err && err.message) || String(err);
          setSaveError(`${t("memory.features.saveFailed")} — ${why}`);
          return false;
        } finally {
          setBusy(false);
        }
      };

      // 字符串项失焦/回车提交：trim 后与生效值相同则回填放弃，否则交给
      // 后端校验（ollamaBaseUrl 的协议、embedProvider 的枚举在后端把关）。
      // 后端拒了就退回生效值并出声——留着被拒的文本，人以为改成功了。
      const commitString = (key) => {
        const raw = (strs[key] ?? "").trim();
        if (raw === String(eff[key] ?? "")) {
          setStrs((c) => ({ ...c, [key]: String(eff[key] ?? "") }));
          return;
        }
        put({ [key]: raw }).then((ok) => {
          if (!ok) setStrs((c) => ({ ...c, [key]: String(eff[key] ?? "") }));
        });
      };

      // 整数项失焦/回车提交。与字符串项同一形状，多三道闸：本地先挡非整数，
      // 挡不住的交后端（retentionDays 的范围 1–3650 由白名单把关），后端也拒了
      // 就把草稿退回生效值。前两道退回时也不出声——那是本地的即时反馈；第三道
      // 必须出声（put 会把原因写进 saveError），否则「框里的数字」与「在用的
      // 保留天数」会分家，而人看不出来。
      const commitNumber = (key) => {
        const raw = (nums[key] ?? "").trim();
        if (raw === String(eff[key] ?? "")) return;
        if (!/^\d+$/.test(raw)) {
          setNums((c) => ({ ...c, [key]: String(eff[key] ?? "") }));
          return;
        }
        put({ [key]: Number(raw) }).then((ok) => {
          if (!ok) setNums((c) => ({ ...c, [key]: String(eff[key] ?? "") }));
        });
      };

      // 「默认 / 已改」的信号来源是 state.overrides：featureSnapshot 只把
      // settings.getFeatureFlags() 里真实落库的键放进 overrides，键不在其中
      // = 值仍来自 config schema 的默认值。面板自己判断，不加后端字段、
      // 不动 config.js（#427 的验收红线之一）。
      const ovr = (state && state.overrides) || {};
      // 「待重启」是第三态，必须由后端算：#481 的坑正是「面板显示已改 ≠ 运行时
      // 已改」——开关在宿主启动时合并进 cfg 并冻结，此后改 kv 只是持久化。这个
      // 落差前端看不见（overrides 里只有「改了」这一个事实），所以后端另比一次
      // 冻结值并给出 pendingRestart 名单；本面板只负责把它显示出来。
      const pending = new Set((state && state.pendingRestart) || []);
      const flagTag = (k) => {
        if (pending.has(k)) {
          return {
            kind: "mneme-badge--pending",
            text: t("memory.features.tagPending"),
            title: t("memory.features.tagPending.hint")
          };
        }
        return {
          kind: Object.prototype.hasOwnProperty.call(ovr, k) ? "mneme-badge--changed" : "mneme-badge--default",
          text: t(Object.prototype.hasOwnProperty.call(ovr, k) ? "memory.features.tagChanged" : "memory.features.tagDefault"),
          title: t(Object.prototype.hasOwnProperty.call(ovr, k) ? "memory.features.tagChanged.hint" : "memory.features.tagDefault.hint")
        };
      };
      const boolRow = (k, opts = {}) => h(FeatureRow, {
        key: k,
        name: t(`memory.features.${k}`),
        hint: t(`memory.features.${k}.hint`)
          + (opts.gate && !eff[opts.gate] ? ` · ${t("memory.features.parentOff")}` : ""),
        on: !!eff[k],
        disabled: busy,
        sub: !!opts.sub,
        tag: flagTag(k),
        onToggle: () => put({ [k]: !eff[k] })
      });

      // 带子项的父开关：父行 + 紧随其后的子行（子行缩进，父关时标注不生效）。
      const flagRow = (k) => {
        const kids = FEATURE_CHILDREN[k];
        if (!kids) return boolRow(k);
        return h(react.Fragment, { key: k }, boolRow(k), kids.map((c) => boolRow(c, { sub: true, gate: k })));
      };

      // 模型枚举项的统一形状：string 或 {id, name?}（/llm-providers 契约）。
      const modelLabel = (m) => (typeof m === "string" ? m : String((m && (m.name || m.id)) ?? ""));
      const modelValue = (m) => (typeof m === "string" ? m : String((m && m.id) ?? ""));

      // 连通性测试：POST /test-model，空 provider/model = 按巩固路由解析
      // （agent 默认）。durationMs 优先后端值，缺失时客户端兜底计时；成功行
      // 附模型的实际回复（reply，后端截 100 字符）——「真的答了 ok」而非只报通。
      // reasoningEffort 透传该路由配置的档位（issue #215），'none'/未配置省略
      // 字段，与后端 src/api.js 的同口径。**档位被拒不再是失败**：后端与真实
      // run 一样丢掉字段重试一次，回以 effortDropped:true，这里单独说明「连通
      // 了、但不是用你配的档位」——否则用户会照着红色失败去换 Provider，而
      // 后台其实一直在正常跑（这正是它此前给出误导性诊断的原因）。
      const runModelTest = async (provider, model, setTestState, reasoningEffort) => {
        setTestState({ running: true });
        const started = Date.now();
        try {
          const res = await apiFetch("/api/dsh-mneme/test-model", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              provider, model,
              ...(reasoningEffort && reasoningEffort !== "none" ? { reasoningEffort } : {})
            })
          });
          const j = await res.json().catch(() => ({}));
          const ms = typeof j.durationMs === "number" ? j.durationMs : Date.now() - started;
          if (!res.ok || j.ok === false) {
            setTestState({
              ok: false,
              ms,
              detail: [j.modelId, j.error || "HTTP " + res.status].filter(Boolean).join(" · ")
            });
            return;
          }
          setTestState({
            ok: true,
            ms,
            // 只有后端明确置位才算降级（旧后端无此字段 → 不显示，不误报）。
            dropped: j.effortDropped === true,
            detail: [j.modelId, j.reply ? "「" + j.reply + "」" : ""].filter(Boolean).join(" · ")
          });
        } catch (err) {
          setTestState({ ok: false, ms: Date.now() - started, detail: String((err && err.message) ?? err) });
        }
      };

      // 巩固/睡眠路由行：provider/model 级联下拉（数据来自宿主侧已注册的
      // 适配器，用户不会选到不存在的模型）+ 连通性测试。空值 = 跟随默认
      // 路由；改动即提交（与 embedProvider 下拉一致）。当前值不在枚举里时
      // 保留为额外选项避免静默改值，并显式标记 + 行级提示（issue #191）。
      const routeSelects = (providerKey, modelKey, testState, setTestState, effortKey) => {
        const curP = strs[providerKey] ?? "";
        const curM = strs[modelKey] ?? "";
        // 该路由配置的档位（键名由调用点按路由行传入，issue #215）；
        // ''/'none' 由 runModelTest 统一省略。
        const effort = effortKey ? (eff[effortKey] || "") : "";
        const entries = Array.isArray(routes) ? routes : [];
        const entry = entries.find((p) => p && p.provider === curP);
        const models = (entry && Array.isArray(entry.models)) ? entry.models : [];
        const mVals = models.map(modelValue);
        // issue #191：旧值保留是刻意不丢配置，但必须看得见。适配器列表为空
        // （端点刚起 / 宿主零适配器）时无从比对，不标记防误报；provider 未
        // 选或本身不在列表时，模型归属由后端按默认路由解析，前端不校验
        // model——只在 provider 已注册时查配套。
        const hasProviders = entries.length > 0;
        const pStale = hasProviders && !!curP && !entry;
        const mStale = hasProviders && !!entry && !!curM && !mVals.includes(curM);
        const pList = entries.map((p) => p.provider).concat(
          curP && !entries.some((p) => p.provider === curP) ? [curP] : []);
        const putKey = (key) => (e) => {
          const v = e.target.value;
          setStrs((c) => ({ ...c, [key]: v }));
          put({ [key]: v });
        };
        return h(react.Fragment, null,
          h("div", { className: "mneme-featnum" },
            h("span", { className: "mneme-featnumlabel" }, t(`memory.features.${providerKey}`)),
            h("select", {
              className: "mneme-select mneme-routeselect", value: curP, disabled: busy,
              "aria-label": t(`memory.features.${providerKey}`), onChange: putKey(providerKey)
            },
              h("option", { value: "" }, t("memory.features.routeFollowDefault")),
              pList.map((p) => h("option", { key: p, value: p },
                pStale && p === curP ? p + t("memory.features.routeStaleMark") : p)))),
          h("div", { className: "mneme-featnum" },
            h("span", { className: "mneme-featnumlabel" }, t(`memory.features.${modelKey}`)),
            h("select", {
              className: "mneme-select mneme-routeselect", value: curM, disabled: busy,
              "aria-label": t(`memory.features.${modelKey}`), onChange: putKey(modelKey)
            },
              h("option", { value: "" }, t("memory.features.routeFollowDefault")),
              models.map((m, i) => h("option", { key: modelValue(m) + "|" + i, value: modelValue(m) }, modelLabel(m))),
              curM && !mVals.includes(curM) ? h("option", { key: "current", value: curM },
                mStale ? curM + t("memory.features.routeStaleMark") : curM) : null)),
          (pStale || mStale) && h("div", { className: "mneme-featsubhint" },
            "⚠ " + t("memory.features.routeStaleHint")),
          h("div", { className: "mneme-featnum" },
            h("button", {
              type: "button", className: "mneme-btn",
              disabled: busy || (testState && testState.running),
              onClick: () => runModelTest(curP, curM, setTestState, effort)
            }, t((testState && testState.running) ? "memory.features.modelTesting" : "memory.features.modelTest")),
            // 结果与说明共用同一行槽位二选一：出结果后说明自动让位，不堆叠。
            (testState && !testState.running
              ? h("div", { className: "mneme-featsubhint" },
                  (testState.ok ? "✓ " + t("memory.features.modelTestOk") : "✗ " + t("memory.features.modelTestFail"))
                  + (testState.ok && testState.dropped ? " · " + t("memory.features.modelTestDowngraded") : "")
                  + (typeof testState.ms === "number" ? " · " + (testState.ms / 1000).toFixed(1) + "s" : "")
                  + (testState.detail ? " · " + testState.detail : ""))
              : h("div", { className: "mneme-featsubhint" }, t("memory.features.modelTestHint"))))
        );
      };

      const strRow = (key) => h("div", { className: "mneme-featnum", key },
        h("span", { className: "mneme-featnumlabel" }, t(`memory.features.${key}`)),
        h("input", {
          className: "mneme-strinput",
          value: strs[key] ?? "",
          onChange: (e) => setStrs((c) => ({ ...c, [key]: e.target.value })),
          onBlur: () => commitString(key),
          onKeyDown: (e) => { if (e.key === "Enter") e.target.blur(); }
        }));

      // #622 可观测性：错峰时段串解析失败在面板可见。校验在服务端算好（/features
      // 的 invalidPeakHours，parsePeakSpec 只许有一份实现），面板只渲染——独立
      // bundle 复制一份解析器必然漂移。跟的是 effective 侧的计算结果，与输入框
      // 显示的值同源；改完保存（PUT 答复同走 featureSnapshot）提示立即跟着换。
      const peakInvalidHint = (key) =>
        Array.isArray(state?.invalidPeakHours) && state.invalidPeakHours.includes(key)
          ? h("div", { className: "mneme-featsubhint", style: { color: "var(--mneme-danger)" } },
              "⚠ " + t(`memory.features.${key}.invalid`))
          : null;

      // type 刻意用 text + inputMode 而不是 number：number 输入框在部分内容被
      // 判非法时 e.target.value 会变成空串，草稿与用户所见脱节；这里要自己拿
      // 到原文才能挡下非整数并退回生效值。
      const numRow = (key) => h("div", { className: "mneme-featnum", key },
        h("span", { className: "mneme-featnumlabel" }, t(`memory.features.${key}`)),
        h("input", {
          className: "mneme-numinput",
          type: "text",
          inputMode: "numeric",
          value: nums[key] ?? "",
          "aria-label": t(`memory.features.${key}`),
          onChange: (e) => setNums((c) => ({ ...c, [key]: e.target.value })),
          onBlur: () => commitNumber(key),
          onKeyDown: (e) => { if (e.key === "Enter") e.target.blur(); }
        }));

      // 语义检索路线：provider 下拉即时提交；local/ollama 选中时展开各自
      // 的连接字段，openai 的连接信息由「向量搜索」卡片持有，只给指引。
      const embedSub = h("div", { className: "mneme-featsub" },
        h("div", { className: "mneme-featnum" },
          h("span", { className: "mneme-featnumlabel" }, t("memory.features.embedProvider")),
          h("select", {
            className: "mneme-select",
            value: eff.embedProvider || "openai",
            disabled: busy,
            onChange: (e) => put({ embedProvider: e.target.value })
          },
            EMBED_PROVIDERS.map((p) => h("option", { key: p, value: p }, t(`memory.features.embedProvider.${p}`))))
        ),
        h("div", { className: "mneme-featsubhint" },
          t(`memory.features.embedProvider.${eff.embedProvider || "openai"}.hint`)),
        eff.embedProvider === "local" && strRow("localEmbedModel"),
        eff.embedProvider === "ollama" && strRow("ollamaBaseUrl"),
        eff.embedProvider === "ollama" && strRow("ollamaModel")
      );

      // 巩固模型：autoDream 开着才展开，避免闲置配置占版面。/llm-providers
      // 可用时用级联下拉 + 连通性测试；旧后端（端点 404）回退纯文本输入。
      const dreamSub = eff.autoDream && h("div", { className: "mneme-featsub" },
        Array.isArray(routes)
          ? routeSelects("dreamProvider", "dreamModel", dreamTest, setDreamTest, "dreamReasoningEffort")
          : h(react.Fragment, null, strRow("dreamProvider"), strRow("dreamModel")),
        h("div", { className: "mneme-featsubhint" }, t("memory.features.dreamModelHint")),
        // Issue #239 第 4 项镜像到巩固：高峰时段串（空 = 关闭）。放在 autoDream
        // 子块内——它是巩固的排程，开关关掉时不该还在界面上留着可编辑的输入框。
        strRow("dreamPeakHours"),
        peakInvalidHint("dreamPeakHours"),
        h("div", { className: "mneme-featsubhint" }, t("memory.features.dreamPeakHours.hint")),
        // Issue #478：单轮巩固的 max_tokens 预算。后端白名单（256–131072）早就有，
        // 修复前 UI 够不着；默认 131072 超过很多 OpenAI 兼容网关的硬上限又看不见调不了。
        numRow("dreamMaxTokens")
      );

      // 睡眠模型：sleepModeEnabled 开着才展开（sleepProvider/sleepModel 随本版
      // 进白名单；下拉与测试复用同一 /llm-providers 数据源）。
      const sleepSub = eff.sleepModeEnabled && Array.isArray(routes) && h("div", { className: "mneme-featsub" },
        routeSelects("sleepProvider", "sleepModel", sleepTest, setSleepTest, "sleepReasoningEffort"),
        h("div", { className: "mneme-featsubhint" }, t("memory.features.sleepModelHint")),
        // Issue #478：睡眠侧同款预算键（#257 引入后端白名单，UI 一直缺席）。
        numRow("sleepMaxTokens")
      );

      // 实体抽取路由与思考强度（issue #109）：entityExtractionEnabled 开着才
      // 展开。provider/model 级联下拉 + 连通性测试（同巩固/睡眠），reasoning
      // 枚举即时提交；旧后端（/llm-providers 404）回退纯文本输入。
      const entitySub = eff.entityExtractionEnabled && h("div", { className: "mneme-featsub" },
        Array.isArray(routes)
          ? routeSelects("entityExtractionProvider", "entityExtractionModel", entityTest, setEntityTest, "entityExtractionReasoning")
          : h(react.Fragment, null, strRow("entityExtractionProvider"), strRow("entityExtractionModel")),
        h("div", { className: "mneme-featnum" },
          h("span", { className: "mneme-featnumlabel" }, t("memory.features.entityExtractionReasoning")),
          h("select", {
            className: "mneme-select",
            value: eff.entityExtractionReasoning || "none",
            disabled: busy,
            onChange: (e) => put({ entityExtractionReasoning: e.target.value })
          },
            ENTITY_REASONING.map((r) => h("option", { key: r, value: r }, t(`memory.features.entityExtractionReasoning.${r}`))))
        ),
        h("div", { className: "mneme-featsubhint" }, t("memory.features.entityExtractionModelHint"))
      );

      // 蒸馏思考强度（issue #315）：autoSummarize 开着才展开，档位与实体抽取
      // 同款枚举下拉、即时提交。蒸馏没有独立 provider/model 路由键（跟随会话
      // 头或 config 文件的 summarizeProvider/summarizeModel），不上连通性测试。
      const summarizeSub = eff.autoSummarize && h("div", { className: "mneme-featsub" },
        h("div", { className: "mneme-featnum" },
          h("span", { className: "mneme-featnumlabel" }, t("memory.features.summarizeReasoningEffort")),
          h("select", {
            className: "mneme-select",
            value: eff.summarizeReasoningEffort || "none",
            disabled: busy,
            onChange: (e) => put({ summarizeReasoningEffort: e.target.value })
          },
            SUMMARIZE_REASONING.map((r) => h("option", { key: r, value: r }, t(`memory.features.summarizeReasoningEffort.${r}`))))
        ),
        h("div", { className: "mneme-featsubhint" }, t("memory.features.summarizeReasoningEffort.hint")),
        // Issue #239 第 4 项：蒸馏侧错峰时段串（空 = 关闭）。与思考强度同处一个
        // autoSummarize 子块——两处错峰开关都能在面板上调（巩固侧见 dreamSub）。
        strRow("summarizePeakHours"),
        peakInvalidHint("summarizePeakHours"),
        h("div", { className: "mneme-featsubhint" }, t("memory.features.summarizePeakHours.hint"))
      );

      // #399 的留存开关紧跟在蒸馏总闸下：天数行只在留存开着时展开（关着一行
      // 不写，改天数没有意义）。放在这而不是挂在 flagRow 上，是因为
      // FEATURE_CHILDREN 只认布尔子项，而这里要的是一个整数输入行。
      const distillSub = eff["distillRecords.enabled"] && h("div", { className: "mneme-featsub" },
        numRow("distillRecords.retentionDays"),
        h("div", { className: "mneme-featsubhint" }, t("memory.features.distillRecords.retentionDays.hint"))
      );

      // chorography M3：开局注入的档位。挂在 chorographyEnabled 下（总闸关着时
      // 不展开——没启用子系统就没有「注入多少」可谈）。枚举键没有通用渲染器，
      // 与上面几个子块同款手写下拉。轻量档（lightMode）在消费侧压成 off，
      // 面板不因此灰掉：那是运行时预设，不是用户选择。
      // 日记定时写（v0.13）：只有日记开着才展开——关掉的日记没有「多久写一次」的问题。
      // 0 = 只在 turn/end 与启动时判（此前行为），文案把这个差别说清楚，否则用户
      // 填了 60 却以为一天能写 24 篇。
      const diarySub = eff.diaryEnabled && h("div", { className: "mneme-featsub" },
        numRow("diaryWriteEveryMinutes"),
        h("div", { className: "mneme-featsubhint" }, t("memory.features.diaryWriteEveryMinutes.hint"))
      );

      const choroSub = eff.chorographyEnabled && h("div", { className: "mneme-featsub" },
        h("div", { className: "mneme-featnum" },
          h("span", { className: "mneme-featnumlabel" }, t("memory.features.chorographyInject")),
          h("select", {
            className: "mneme-select",
            value: eff.chorographyInject || "light",
            disabled: busy,
            onChange: (e) => put({ chorographyInject: e.target.value })
          },
            CHORO_TIERS.map((r) => h("option", { key: r, value: r }, t(`memory.features.chorographyInject.${r}`))))
        ),
        h("div", { className: "mneme-featsubhint" }, t("memory.features.chorographyInject.hint")),
        // 契约 §3.1 的两枚子开关，落在同一个子块里：它们只在仓库地志启用后
        // 才有意义，散到全部设置里就变成「看不见总闸却先看到子项」。
        // 两个都 opt-in/opt-out 按契约默认（自动更新默认关——它会读盘比 git 基线；
        // 面板发起 T1 默认开——它是人主动点的按钮，不是后台行为）。
        boolRow("chorographyAutoRefresh", { sub: true }),
        boolRow("chorographyT1FromPanel", { sub: true })
      );

      if (error && !state) return h("section", { className: "mneme-set-card" },
        h("div", { className: "mneme-set-title" }, t("memory.features.title")),
        h("div", { className: "mneme-set-hint" }, error));

      return h("section", { className: "mneme-set-card" },
        h("div", { className: "mneme-set-title" },
          t("memory.features.title"),
          savedTick && h("span", { className: "mneme-saved", style: { marginLeft: 8, fontWeight: 400 } }, t("memory.features.restartHint"))
        ),
        h("div", { className: "mneme-set-desc" }, t("memory.features.desc")),
        // #481：改了但没生效的开关，在这张卡里明说。放在 desc 之后、错误行之前
        // ——它是常态提示而非错误，但比错误更该先被看见（用户刚改完就会看这里）。
        // 行级 badge（flagTag 的第三态）标出具体是哪几行，这条只负责说清「有事
        // 没生效」和「怎么办」。
        pending.size > 0 && h("div", { className: "mneme-pending" },
          h("span", { className: "mneme-pending-dot" }),
          h("span", null, t("memory.features.pendingRestartNotice"))
        ),
        // 见 saveError 的声明处：这条分支不能跟着加载失败那条走。
        saveError && h("div", { className: "mneme-mainterr" }, saveError),
        h(RuntimeProvisionBlock, { t }),
        state === null && !error
          ? h("div", { className: "mneme-set-hint" }, "…")
          : (() => {
              // Issue #427：分组按「实现」分改不动需求本身，改的是「折叠线划在
              // 哪里」。renderGroup 是唯一的组渲染路径（含组尾子块），首屏层与
              // 「全部设置」共用它，保证 g.items.map(flagRow) 只写一次、子项
              // 只可能经 flagRow 渲染（test/inject-parent-gate.test.js 的门）。
              const renderGroup = (g) => h(react.Fragment, { key: g.key },
                h("div", { className: "mneme-featgroup" }, t(`memory.features.${g.key}`)),
                g.items.map(flagRow),
                // 子块按组尾追加。distillSub 紧跟在 core 组最后一行
                // （distillRecords.enabled）之后，天数行才贴着它的总闸。
                g.key === "group.core" && h(react.Fragment, null, distillSub, summarizeSub),
                g.key === "group.enhance" && h(react.Fragment, null, embedSub, entitySub, diarySub, choroSub),
                g.key === "group.dream" && h(react.Fragment, null, dreamSub, sleepSub)
              );
              const firstScreen = FEATURE_GROUPS.filter((g) => FEATURE_FIRST_SCREEN.includes(g.key));
              const restGroups = FEATURE_GROUPS.filter((g) => !FEATURE_FIRST_SCREEN.includes(g.key));
              return h(react.Fragment, null,
                firstScreen.map(renderGroup),
                // 「全部设置」= 第一层折叠（默认收起，#427 建议 1）：里面的
                // 30 余项对新手是噪音，对新用户可见的只有上面的总开关层。
                h("div", { className: "mneme-featgroup" },
                  h("button", {
                    type: "button",
                    className: "mneme-footbtn",
                    "aria-expanded": String(showAll),
                    onClick: () => setShowAll(!showAll)
                  },
                    h(Icon, { name: showAll ? "chevronDown" : "chevronRight", size: 12 }),
                    t("memory.features.allToggle"))
                ),
                showAll && h(react.Fragment, null,
                  restGroups.map(renderGroup),
                  // 「高级」降为第二层，嵌在「全部设置」内部。
                  h("div", { className: "mneme-featgroup" },
                    h("button", {
                      type: "button",
                      className: "mneme-footbtn",
                      "aria-expanded": String(showAdv),
                      onClick: () => setShowAdv(!showAdv)
                    },
                      h(Icon, { name: showAdv ? "chevronDown" : "chevronRight", size: 12 }),
                      t("memory.features.advancedToggle"))
                  ),
                  showAdv && FEATURE_ADVANCED_BOOLS.map((k) => boolRow(k))
                )
              );
            })()
      );
    }

    // 令牌遮蔽：保留首尾少量字符便于辨认，中间全部打点；完整值只经复制
    // 通道离开面板。
    function maskToken(value) {
      const s = String(value ?? "");
      if (s.length <= 8) return "•".repeat(Math.max(6, s.length));
      return `${s.slice(0, 5)}${"•".repeat(10)}${s.slice(-4)}`;
    }

    // 反馈预填用的平台标签：从 userAgent 提一个粗粒度 OS 名，够定位问题即可，
    // 不引第三方解析库。浏览器/Electron webview 里都能取到。
    const platformLabel = () => {
      const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
      if (/Windows NT/.test(ua)) return "Windows";
      if (/Mac OS X/.test(ua)) return "macOS";
      if (/Android/.test(ua)) return "Android";
      if (/iPhone|iPad/.test(ua)) return "iOS";
      if (/Linux/.test(ua)) return "Linux";
      return "Unknown";
    };

    // #182 / #514 注入状态探测：一处取数，两处消费（状态页告示卡、设置页提示）。
    // 分成两份读同一接口会让两处的「已知/未知」判断各自漂移——#514 里用户就是在
    // 设置页开关人格，却只在状态页才看得到原因。普通函数声明（会提升），这里紧
    // 挨着设置页放，是为了让源码顺序和「先谁用」对得上。
    function useInjectStatus() {
      const [state, setState] = useState({ loading: true, suppressed: false, agentPreset: null });
      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/inject-status")
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((j) => {
            if (!cancelled) {
              setState({
                loading: false,
                suppressed: !!(j && j.suppressed),
                agentPreset: (j && j.agentPreset) || null
              });
            }
          })
          .catch(() => { if (!cancelled) setState({ loading: false, suppressed: false, agentPreset: null }); });
        return () => { cancelled = true; };
      }, []);
      return state;
    }

    function SettingsContent({ t }) {
      const [rules, setRules] = react.useState([]);
      const [commands, setCommands] = react.useState([]);
      const [newRule, setNewRule] = react.useState("");
      const [newCmd, setNewCmd] = react.useState({ name: "", description: "", instruction: "" });
      const [cmdError, setCmdError] = react.useState("");
      const [vector, setVector] = react.useState({ enabled: false, baseUrl: "", apiKey: "", model: "" });
      const [vectorSaved, setVectorSaved] = react.useState(false);
      const [reindexing, setReindexing] = react.useState(false);
      const [reindexMsg, setReindexMsg] = react.useState("");
      const [apiToken, setApiToken] = react.useState(() =>
        (typeof window !== "undefined" && window.localStorage) ? window.localStorage.getItem("dsh-mneme-api-token") || "" : ""
      );
      const [apiTokenSaved, setApiTokenSaved] = react.useState(false);
      // 反馈入口的插件版本（GET /info）。失败保持 "unknown"，链接仍可用。
      const [pkgVersion, setPkgVersion] = react.useState("unknown");
      // 版本自检（复验修订：原为进入设置页自动请求 + 顶部横幅，现改为底部
      // 「支持与鼓励」卡里的「检测更新」按钮手动触发，结果内联显示——自动
      // 请求与横幅常驻都是打扰面）。status 共四种：outdated / latest / error / null（未检测）。
      const [updateInfo, setUpdateInfo] = react.useState(null);
      const [updateChecking, setUpdateChecking] = react.useState(false);
      function checkForUpdate() {
        if (updateChecking) return;
        setUpdateChecking(true);
        apiFetch("/api/dsh-mneme/version-check")
          .then((res) => (res.ok ? res.json() : null))
          .then((j) => {
            setUpdateInfo(j && typeof j.latest === "string" && typeof j.version === "string"
              ? { status: j.status, latest: j.latest, current: j.version }
              : { status: "error" });
            setUpdateChecking(false);
          })
          .catch(() => { setUpdateInfo({ status: "error" }); setUpdateChecking(false); });
      }
      // 检测结果一行文案：按 status 取既有或新增的 i18n key。
      function checkResultText() {
        if (!updateInfo) return "";
        if (updateInfo.status === "outdated") {
          return t("memory.settings.version.outdated")
            .replace("{v}", updateInfo.latest)
            .replace("{c}", updateInfo.current);
        }
        // 后端 classify（src/version-check.js）返回的是 "up-to-date"（连字符）。
        // 前端状态名必须与它逐字对齐：此前误写 "latest"/"up_to_date" 两个后端
        // 从未返回过的名字，检测成功也掉进 error 兜底（复验实测踩中）。
        if (updateInfo.status === "up-to-date") return t("memory.settings.update.latest");
        if (updateInfo.status === "ahead") return t("memory.settings.update.ahead");
        return t("memory.settings.update.error");
      }
      // 运行模式 — light vs standard; null = still loading. The card keeps
      // its own busy/saved/error state so it never blocks the others.
      const [mode, setMode] = react.useState(null);
      const [modeBusy, setModeBusy] = react.useState(false);
      const [modeSaved, setModeSaved] = react.useState(false);
      const [modeError, setModeError] = react.useState("");
      // 外部访问 API — config fetched from the backend (the token is generated
      // and kept server-side); host/port inputs are drafts, PUT only on save.
      const [extapi, setExtapi] = react.useState(null);
      const [extapiHost, setExtapiHost] = react.useState("127.0.0.1");
      const [extapiPort, setExtapiPort] = react.useState("");
      const [extapiBusy, setExtapiBusy] = react.useState(false);
      const [extapiSaved, setExtapiSaved] = react.useState(false);
      const [extapiCopied, setExtapiCopied] = react.useState(false);
      const [extapiError, setExtapiError] = react.useState("");
      // 令牌默认遮蔽显示：完整值只经「复制」离开面板，不直接铺在页面上。
      const [extapiTokenShown, setExtapiTokenShown] = react.useState(false);

      // 画像搬去「人格」页之后，这一路只剩规则/指令/向量三个请求：画像的读取跟着
      // 那张卡一起走（同一个数据不该有两个所有者，否则两页会各自显示不同的旧值）。
      const load = react.useCallback(async () => {
        try {
          const [r, c, v] = await Promise.all([
            apiFetch("/api/dsh-mneme/rules").then((res) => res.json()),
            apiFetch("/api/dsh-mneme/commands").then((res) => res.json()),
            apiFetch("/api/dsh-mneme/vector-config").then((res) => res.json()),
          ]);
          setRules(Array.isArray(r.rules) ? r.rules : []);
          setCommands(Array.isArray(c.commands) ? c.commands : []);
          setVector(v.config || { enabled: false, baseUrl: "", apiKey: "", model: "" });
          // 预览不在这里写：它只有一个所有者（loadPreview）。两处写同一个 state 就会
          // 互相覆盖，而这张卡的标题是「注入生效文本」——显示别张卡的文本比不显示更糟。
        } catch { /* ignore */ }
      }, []);

      react.useEffect(() => { load(); }, [load]);


      // 帮助与反馈卡片的版本号：独立小请求，失败不影响其它卡片。
      react.useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/info")
          .then((res) => (res.ok ? res.json() : null))
          .then((j) => { if (!cancelled && j && typeof j.version === "string") setPkgVersion(j.version); })
          .catch(() => {});
        return () => { cancelled = true; };
      }, []);

      // 反馈链接预填：环境信息（插件版本 + 平台）+ 问题描述骨架。邮件主题带
      // 版本/平台方便归档，正文同款模板；纯链接零后端成本。
      const feedbackEnv = `**插件版本**: ${pkgVersion}\n**平台**: ${platformLabel()}\n`;
      const feedbackBody = feedbackEnv + "**问题描述**:\n- 期望行为:\n- 实际行为:\n- 复现步骤:\n";
      const issueHref = "https://github.com/slow-stack/mneme/issues/new?title="
        + encodeURIComponent("[dsh-mneme] 问题反馈")
        + "&body=" + encodeURIComponent(feedbackBody);
      const mailHref = "mailto:work@modusensus.space?subject="
        + encodeURIComponent(`[dsh-mneme 反馈] ${pkgVersion} / ${platformLabel()}`)
        + "&body=" + encodeURIComponent(feedbackBody);
      // 反馈行：图标 + 主标题 + 一句副标；锚点属性由调用点给（保持 href 字面量可被测试锁住）
      const feedRow = (iconName, label, sub, anchorProps) => h("a", {
        className: "mneme-feedrow", ...anchorProps
      },
        h("span", { className: "mneme-feedico", "aria-hidden": "true" }, h(Icon, { name: iconName, size: 14 })),
        h("span", { className: "mneme-feedtext" },
          h("span", { className: "mneme-feedname" }, label),
          h("span", { className: "mneme-feedsub" }, sub)));

      // Runtime mode + external API — two independent fetches: one failing
      // endpoint only errors its own card, never the other one.
      react.useEffect(() => {
        let cancelled = false;
        const toErr = (err) => (err && err.message) || "failed";
        apiFetch("/api/dsh-mneme/mode")
          .then((res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
          .then((j) => { if (!cancelled) setMode(j.mode === "light" ? "light" : "standard"); })
          .catch((err) => { if (!cancelled) setModeError(toErr(err)); });
        apiFetch("/api/dsh-mneme/external-api")
          .then((res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
          .then((j) => {
            if (cancelled) return;
            const cfg = (j && j.config) || {};
            const next = {
              enabled: !!cfg.enabled,
              host: cfg.host || "127.0.0.1",
              port: Number(cfg.port) || 0,
              token: cfg.token || ""
            };
            setExtapi(next);
            setExtapiHost(next.host);
            setExtapiPort(next.port ? String(next.port) : "");
          })
          .catch((err) => { if (!cancelled) setExtapiError(toErr(err)); });
        return () => { cancelled = true; };
      }, []);




      async function putRules(next) {
        await apiFetch("/api/dsh-mneme/rules", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rules: next })
        });
      }

      async function addRule() {
        const text = newRule.trim();
        if (!text) return;
        const next = [...rules, text];
        await putRules(next);
        setRules(next);
        setNewRule("");
      }

      async function removeRule(index) {
        const next = rules.filter((_, i) => i !== index);
        await putRules(next);
        setRules(next);
      }

      async function addCommand() {
        const name = newCmd.name.trim();
        const instruction = newCmd.instruction.trim();
        if (!name || !instruction) return;
        try {
          const res = await apiFetch("/api/dsh-mneme/commands", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, description: newCmd.description, instruction })
          });
          const data = await res.json();
          if (!res.ok) { setCmdError(data.error || "failed"); return; }
          setCmdError("");
          setCommands([...commands, data.command]);
          setNewCmd({ name: "", description: "", instruction: "" });
        } catch { setCmdError("failed"); }
      }

      async function removeCommand(id) {
        await apiFetch(`/api/dsh-mneme/commands?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        setCommands(commands.filter((c) => c.id !== id));
      }

      async function saveVector() {
        try {
          await apiFetch("/api/dsh-mneme/vector-config", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(vector)
          });
          setVectorSaved(true);
          announce(t("memory.settings.vectorSaved"));
          setTimeout(() => setVectorSaved(false), 1500);
        } catch { /* ignore */ }
      }

      async function reindex() {
        setReindexing(true);
        setReindexMsg("");
        try {
          const res = await apiFetch("/api/dsh-mneme/vector-reindex");
          const data = await res.json();
          const n = Number(data.indexed ?? 0);
          const f = Number(data.failed ?? 0);
          const r = data.remaining;
          // #604: "已索引 0 条" used to be the only outcome ever shown, so a
          // rebuild that selected nothing (model switch, wrong selector) looked
          // exactly like a successful no-op. Say which of the three it was.
          if (data.error) {
            setReindexMsg("");
          } else if (n === 0 && f === 0 && (r === 0 || r == null)) {
            setReindexMsg(t("memory.settings.vectorReindexNothing"));
          } else if (f > 0) {
            setReindexMsg(t("memory.settings.vectorReindexPartial")
              .replace("{n}", String(n)).replace("{f}", String(f)));
          } else if (Number.isFinite(r) && r > 0) {
            setReindexMsg(t("memory.settings.vectorReindexRemaining")
              .replace("{n}", String(n)).replace("{r}", String(r)));
          } else {
            setReindexMsg(t("memory.settings.vectorReindexDone").replace("{n}", String(n)));
          }
        } catch { setReindexMsg(""); }
        setReindexing(false);
      }

      function saveToken() {
        try {
          if (apiToken.trim()) window.localStorage.setItem("dsh-mneme-api-token", apiToken.trim());
          else window.localStorage.removeItem("dsh-mneme-api-token");
          setApiTokenSaved(true);
          announce(t("memory.settings.apiTokenSaved"));
          setTimeout(() => setApiTokenSaved(false), 1500);
        } catch { /* ignore */ }
      }

      // Runtime mode: optimistic chip flip, rolled back on failure. Both
      // changes only take effect after a DSH restart — the saved hint says so.
      async function saveMode(next) {
        if (modeBusy) return;
        const prev = mode;
        setModeBusy(true);
        setModeError("");
        setMode(next);
        try {
          const res = await apiFetch("/api/dsh-mneme/mode", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: next })
          });
          if (!res.ok) throw new Error("HTTP " + res.status);
          setModeSaved(true);
          announce(t("memory.settings.mode.savedHint"));
          setTimeout(() => setModeSaved(false), 2500);
        } catch (err) {
          setMode(prev);
          setModeError((err && err.message) || "failed");
        }
        setModeBusy(false);
      }

      // External API: the backend owns the token and returns the full config,
      // so every PUT response refreshes host/port/token from the server.
      async function putExtapi(body) {
        setExtapiBusy(true);
        setExtapiError("");
        try {
          const res = await apiFetch("/api/dsh-mneme/external-api", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
          const cfg = data.config || {};
          const next = {
            enabled: !!cfg.enabled,
            host: cfg.host || "127.0.0.1",
            port: Number(cfg.port) || 0,
            token: cfg.token || ""
          };
          setExtapi(next);
          setExtapiHost(next.host);
          setExtapiPort(next.port ? String(next.port) : "");
          setExtapiSaved(true);
          announce(t("memory.settings.extapi.savedHint"));
          setTimeout(() => setExtapiSaved(false), 2500);
        } catch (err) {
          setExtapiError((err && err.message) || "failed");
        }
        setExtapiBusy(false);
      }

      function saveExtapiEnabled(enabled) {
        if (extapiBusy) return;
        putExtapi({ enabled });
      }

      function saveExtapiAddress() {
        if (extapiBusy) return;
        const raw = String(extapiPort).trim();
        const port = Number(raw);
        if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
          setExtapiError(t("memory.settings.extapi.invalidPort"));
          return;
        }
        putExtapi({ port, host: extapiHost.trim() || "127.0.0.1" });
      }

      function copyExtapiToken() {
        const token = extapi ? extapi.token || "" : "";
        navigator.clipboard?.writeText(token).then(
          () => { setExtapiCopied(true); announce(t("memory.settings.extapi.copied")); setTimeout(() => setExtapiCopied(false), 1500); },
          () => {}
        );
      }

      // 示例命令必须带 -p 包名：bin 名与包名不同，裸 npx 加 bin 名会去装一
      // 个不存在的同名 npm 包（client.test.js 对此有字面量锁，注释也别写它）。
      const [serveCopied, setServeCopied] = useState(false);
      function copyServeCmd() {
        navigator.clipboard?.writeText(t("memory.settings.serve.cmd")).then(
          () => { setServeCopied(true); announce(t("memory.settings.serve.copied")); setTimeout(() => setServeCopied(false), 1500); },
          () => {}
        );
      }

      const [mcpCopied, setMcpCopied] = useState(false);
      function copyMcpSnippet() {
        navigator.clipboard?.writeText(t("memory.settings.mcp.snippet")).then(
          () => { setMcpCopied(true); announce(t("memory.settings.mcp.copied")); setTimeout(() => setMcpCopied(false), 1500); },
          () => {}
        );
      }

      // 目录（#518）：五项分组标题是设置页唯一的骨架，所以索引直接由这张表
      // 生成，而不是再手写一遍标题——两份清单迟早会漂，而漂了的目录会把人
      // 领到空处。tocRefs 是滚动目标，与渲染顺序一一对应（同一个 map 里产出）。
      const tocGroups = [
        { key: "personal", label: t("memory.settings.group.personal") },
        { key: "engine", label: t("memory.settings.group.engine") },
        { key: "search", label: t("memory.settings.group.search") },
        { key: "connect", label: t("memory.settings.group.connect") },
        { key: "help", label: t("memory.settings.group.help") }
      ];
      const tocRefs = useRef({});
      function jumpToGroup(key) {
        const node = tocRefs.current?.[key];
        // 偏移不在这里算：标题自己带 scroll-margin-top（见 .mneme-set-grouphead）。
        // 两处各量一次粘顶条高度必然对不上，跳转会把目标停在目录背后。
        if (node && node.scrollIntoView) node.scrollIntoView({ block: "start", behavior: "smooth" });
      }
      const groupHead = (key) => h("div", {
        className: "mneme-set-grouphead",
        ref: (node) => { if (node) tocRefs.current[key] = node; }
      }, t("memory.settings.group." + key));

      // #514 的告示在运行模式卡也要出现，所以共享状态必须在本组件里声明。只在人格卡声明
      // 会让这张卡读到自由变量：渲染即 ReferenceError，而宿主只报 "import failed"，
      // 看起来像整个 bundle 加载不了。一份声明供本组件内两处消费，不要在每张卡里各取一次数。
      const injectStatus = useInjectStatus();
      const minimalWarn = !injectStatus.loading && injectStatus.suppressed;

      return h("div", null,
        h("nav", { className: "mneme-set-toc", "aria-label": t("memory.settings.toc.aria") },
          h("div", { className: "mneme-set-toclabel" }, t("memory.settings.toc.label")),
          h("div", { className: "mneme-set-toclist" },
            ...tocGroups.map((group) => h("button", {
              key: group.key,
              type: "button",
              className: "mneme-set-tocchip",
              title: t("memory.settings.toc.jump").replace("{name}", group.label),
              onClick: () => jumpToGroup(group.key)
            }, group.label))
          )
        ),
        // —— 个性化：规则 / 自定义指令（Agent 怎么对你） ——
        // 画像与自动事实已搬进记忆面板的「人格」页：它们说的是「你是谁、Agent 眼里
        // 你是谁」，跟人设卡必须待在同一页，否则一处改一半、两页各显示一半。
        groupHead("personal"),
        // 规则 — numbered rows, hover reveals the delete affordance
        h("section", { className: "mneme-set-card" },
          h("div", { className: "mneme-set-title" }, t("memory.settings.rules")),
          h("div", { className: "mneme-set-desc" }, t("memory.settings.rulesHint")),
          rules.length === 0 && h("div", { className: "mneme-xempty" }, t("memory.settings.empty")),
          rules.map((rule, i) =>
            h("div", { key: i, className: "mneme-set-row" },
              h("span", { className: "mneme-set-idx" }, String(i + 1)),
              h("span", { className: "mneme-set-ruletext" }, rule),
              h("button", {
                className: "mneme-set-del",
                title: t("memory.settings.cmdDelete"),
                "aria-label": t("memory.settings.cmdDelete"),
                onClick: () => removeRule(i)
              }, "×")
            )
          ),
          h("div", { style: { display: "flex", gap: 8 } },
            h("input", {
              className: "mneme-set-input",
              style: { marginBottom: 0 },
              value: newRule,
              placeholder: t("memory.settings.rulePlaceholder"),
              onChange: (e) => setNewRule(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") addRule(); }
            }),
            h("button", { className: "mneme-btn", onClick: addRule }, t("memory.settings.ruleAdd"))
          )
        ),
        // 自定义指令 — slash commands as titled rows
        h("section", { className: "mneme-set-card" },
          h("div", { className: "mneme-set-title" }, t("memory.settings.commands")),
          h("div", { className: "mneme-set-desc" }, t("memory.settings.commandsHint")),
          commands.length === 0 && h("div", { className: "mneme-xempty" }, t("memory.settings.empty")),
          commands.map((cmd) =>
            h("div", { key: cmd.id, className: "mneme-set-row" },
              h("div", { className: "mneme-set-cmd" },
                h("div", { className: "mneme-set-cmdname" }, `/${cmd.name}`),
                (cmd.description || cmd.instruction) && h("div", { className: "mneme-set-cmddesc" }, cmd.description || cmd.instruction)
              ),
              h("button", {
                className: "mneme-set-del",
                title: t("memory.settings.cmdDelete"),
                "aria-label": t("memory.settings.cmdDelete"),
                onClick: () => removeCommand(cmd.id)
              }, "×")
            )
          ),
          h("div", { style: { display: "grid", gap: 8, marginTop: 10 } },
            h("div", { style: { display: "flex", gap: 8 } },
              h("input", { className: "mneme-set-input", style: { marginBottom: 0 }, value: newCmd.name, placeholder: t("memory.settings.cmdName"), onChange: (e) => setNewCmd({ ...newCmd, name: e.target.value }) }),
              h("input", { className: "mneme-set-input", style: { marginBottom: 0 }, value: newCmd.description, placeholder: t("memory.settings.cmdDesc"), onChange: (e) => setNewCmd({ ...newCmd, description: e.target.value }) })
            ),
            h("textarea", { className: "mneme-set-input mneme-set-input--area", style: { minHeight: 56 }, value: newCmd.instruction, placeholder: t("memory.settings.cmdInstruction"), onChange: (e) => setNewCmd({ ...newCmd, instruction: e.target.value }) }),
            h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
              h("button", { className: "mneme-btn", onClick: addCommand }, t("memory.settings.cmdAdd")),
              cmdError && h("span", { style: { fontSize: 12, color: "var(--mneme-danger)" } }, cmdError)
            )
          )
        ),
        // —— 记忆引擎：运行模式（粗粒度）在前，功能开关（细粒度）紧随 ——
        groupHead("engine"),
        // 运行模式 — light vs standard chip radios; each click PUTs and the
        // change only lands after a DSH restart (green saved hint says so).
        h("section", { className: "mneme-set-card" },
          h("div", { className: "mneme-set-title" }, t("memory.settings.mode.title")),
          h("div", { className: "mneme-set-desc" }, t("memory.settings.mode.desc")),
          modeError && h("div", { style: { fontSize: 12, color: "var(--mneme-danger)", marginBottom: 8 } }, modeError),
          mode === null && !modeError
            ? h("div", { className: "mneme-set-hint" }, "…")
            : h(react.Fragment, null,
                // #514：用户以为「轻量」关掉了人格。两个词都会在界面上出现，不先
                // 分开说，用户永远会把宿主的 minimal 记成插件的 light。
                h("div", { className: "mneme-set-hint", style: { marginBottom: 8 } },
                  t("memory.settings.mode.hostPresetHint")),
                h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
                  h("button", {
                    className: mode === "light" ? "mneme-chip mneme-active" : "mneme-chip",
                    disabled: modeBusy,
                    onClick: () => saveMode("light")
                  }, t("memory.settings.mode.light")),
                  h("button", {
                    className: mode === "standard" ? "mneme-chip mneme-active" : "mneme-chip",
                    disabled: modeBusy,
                    onClick: () => saveMode("standard")
                  }, t("memory.settings.mode.standard")),
                  modeSaved && h("span", { className: "mneme-saved" }, t("memory.settings.mode.savedHint"))
                ),
                mode === "light" && h("div", { className: "mneme-set-hint", style: { marginTop: 8 } },
                  t("memory.settings.mode.offList"))
              ),
          // #514：suppressed 只在「autoInject 开着 + 宿主确实报了 minimal」时为真，
          // 所以这里不是吓唬人——关掉注入的用户、preset 未知的宿主都不会看到它。
          minimalWarn && h("div", {
            style: { marginTop: 10, padding: "8px 10px", borderLeft: "3px solid var(--mneme-warn)", fontSize: 12, lineHeight: "18px" }
          },
            h("div", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, t("memory.status.minimalPresetTitle")),
            h("div", { style: { marginTop: 4, color: "var(--mneme-fg-dim)" } }, t("memory.status.minimalPresetBody"))
          )
        ),
        // 功能开关 — 后端能力的细粒度闸门；改动即时保存，重启 DSH 后生效。
        h(FeaturesCard, { t }),
        // —— 搜索：语义召回 ——
        groupHead("search"),
        // 向量搜索 — semantic recall over an embeddings API
        h("section", { className: "mneme-set-card" },
          h("div", { className: "mneme-set-title" }, t("memory.settings.vectorTitle")),
          h("div", { className: "mneme-set-desc" }, t("memory.settings.vectorHint")),
          h("label", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 13, color: "var(--dsw-alias-label-primary)" } },
            h("input", { type: "checkbox", checked: !!vector.enabled, onChange: (e) => setVector({ ...vector, enabled: e.target.checked }) }),
            h("span", null, t("memory.settings.vectorEnabled"))
          ),
          h("input", { className: "mneme-set-input", value: vector.baseUrl, placeholder: t("memory.settings.vectorBaseUrl"), onChange: (e) => setVector({ ...vector, baseUrl: e.target.value }) }),
          h("input", { className: "mneme-set-input", type: "password", value: vector.apiKey, placeholder: t("memory.settings.vectorApiKey"), onChange: (e) => setVector({ ...vector, apiKey: e.target.value }) }),
          h("input", { className: "mneme-set-input", value: vector.model, placeholder: t("memory.settings.vectorModel"), onChange: (e) => setVector({ ...vector, model: e.target.value }) }),
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
            h("button", { className: "mneme-btn", onClick: saveVector }, t("memory.settings.vectorSave")),
            vectorSaved && h("span", { className: "mneme-saved" }, t("memory.settings.vectorSaved")),
            h("button", { className: "mneme-btn", onClick: reindex, disabled: reindexing }, reindexing ? t("memory.settings.vectorReindexing") : t("memory.settings.vectorReindex")),
            reindexMsg && h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #666)" } }, reindexMsg)
          )
        ),
        // —— 连接与安全：外部访问 API / 面板令牌 ——
        groupHead("connect"),
        // 外部访问 API — standalone HTTP service for plugins/CLI/desktop tools;
        // the token is generated and kept by the backend, so it is read-only
        // here with a copy affordance. Changes need a DSH restart.
        h("section", { className: "mneme-set-card" },
          h("div", { className: "mneme-set-title" }, t("memory.settings.extapi.title")),
          h("div", { className: "mneme-set-desc" }, t("memory.settings.extapi.desc")),
          extapiError && h("div", { style: { fontSize: 12, color: "var(--mneme-danger)", marginBottom: 8 } }, extapiError),
          extapi === null && !extapiError
            ? h("div", { className: "mneme-set-hint" }, "…")
            : h(react.Fragment, null,
                h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
                  h("button", {
                    className: extapi && extapi.enabled ? "mneme-chip mneme-active" : "mneme-chip",
                    disabled: extapiBusy,
                    onClick: () => saveExtapiEnabled(true)
                  }, t("memory.settings.extapi.enabled")),
                  h("button", {
                    className: extapi && !extapi.enabled ? "mneme-chip mneme-active" : "mneme-chip",
                    disabled: extapiBusy,
                    onClick: () => saveExtapiEnabled(false)
                  }, t("memory.settings.extapi.disabled")),
                  extapiSaved && h("span", { className: "mneme-saved" }, t("memory.settings.extapi.savedHint"))
                ),
                extapi && extapi.enabled && h(react.Fragment, null,
                  h("div", { className: "mneme-set-hint", style: { marginTop: 10 } },
                    `${t("memory.settings.extapi.address")}: http://${extapi.host}:${extapi.port}`),
                  h("div", { style: { display: "flex", gap: 8, marginTop: 8 } },
                    h("input", {
                      className: "mneme-set-input",
                      style: { marginBottom: 0, flex: 2, minWidth: 0, width: "auto" },
                      value: extapiHost,
                      placeholder: "127.0.0.1",
                      onChange: (e) => setExtapiHost(e.target.value)
                    }),
                    h("input", {
                      className: "mneme-set-input",
                      style: { marginBottom: 0, flex: 1, minWidth: 0, width: "auto" },
                      value: extapiPort,
                      placeholder: t("memory.settings.extapi.port"),
                      inputMode: "numeric",
                      onChange: (e) => setExtapiPort(e.target.value)
                    }),
                    h("button", { className: "mneme-btn", disabled: extapiBusy, onClick: saveExtapiAddress },
                      t("memory.settings.vectorSave"))
                  ),
                  h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 10 } },
                    h("div", {
                      className: "mneme-set-token",
                      style: { flex: 1, minWidth: 0 },
                      title: extapi.token && !extapiTokenShown ? t("memory.settings.extapi.maskHint") : undefined
                    }, !extapi.token ? "—" : (extapiTokenShown ? extapi.token : maskToken(extapi.token))),
                    h("button", {
                      className: "mneme-footbtn",
                      onClick: () => setExtapiTokenShown(!extapiTokenShown),
                      "aria-label": extapiTokenShown ? t("memory.settings.extapi.hide") : t("memory.settings.extapi.reveal")
                    }, extapiTokenShown ? t("memory.settings.extapi.hide") : t("memory.settings.extapi.reveal")),
                    h("button", { className: "mneme-btn", onClick: copyExtapiToken },
                      t("memory.settings.extapi.copy")),
                    extapiCopied && h("span", { className: "mneme-saved" }, t("memory.settings.extapi.copied"))
                  )
                )
              )
        ),
        // 独立服务卡片（issue #386 第 1 条）：纯只读展示 + 复制，不做进程
        // 启停/守护/端口探测。同源措辞用「应/通常」——令牌同源未全部实测，
        // 不写成已保证（见该 issue 讨论口径）。
        h("section", { className: "mneme-set-card" },
          h("div", { className: "mneme-set-title" }, t("memory.settings.serve.title")),
          h("div", { className: "mneme-set-desc" }, t("memory.settings.serve.desc")),
          h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
            h("code", {
              className: "mneme-set-token",
              style: { flex: 1, minWidth: 0 }
            }, t("memory.settings.serve.cmd")),
            h("button", { className: "mneme-btn", onClick: copyServeCmd },
              t("memory.settings.serve.copy")),
            serveCopied && h("span", { className: "mneme-saved" }, t("memory.settings.serve.copied"))
          ),
          h("div", { className: "mneme-set-hint", style: { marginTop: 10 } }, t("memory.settings.serve.hint"))
        ),
        // MCP 接入卡（issue #386 第 2 条）：与独立服务同款只读模式——片段 +
        // 复制，不做连通性探测（token 有效性与端点可达由 MCP 客户端侧报错）。
        h("section", { className: "mneme-set-card" },
          h("div", { className: "mneme-set-title" }, t("memory.settings.mcp.title")),
          h("div", { className: "mneme-set-desc" }, t("memory.settings.mcp.desc")),
          h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
            h("code", {
              className: "mneme-set-token",
              style: { flex: 1, minWidth: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }
            }, t("memory.settings.mcp.snippet")),
            h("button", { className: "mneme-btn", onClick: copyMcpSnippet },
              t("memory.settings.mcp.copy")),
            mcpCopied && h("span", { className: "mneme-saved" }, t("memory.settings.mcp.copied"))
          ),
          h("div", { className: "mneme-set-hint", style: { marginTop: 10 } }, t("memory.settings.mcp.hint"))
        ),
        // 向量搜索卡片已上移到「搜索」分组（与功能开关里的语义检索路线相邻），
        // 这里不再重复渲染。
        // API Token — advanced, last
        h("section", { className: "mneme-set-card" },
          h("div", { className: "mneme-set-title" }, t("memory.settings.apiTokenTitle")),
          h("div", { className: "mneme-set-desc" }, t("memory.settings.apiTokenHint")),
          h("div", { style: { display: "flex", gap: 8 } },
            h("input", {
              className: "mneme-set-input",
              style: { marginBottom: 0 },
              type: "password",
              value: apiToken,
              placeholder: t("memory.settings.apiTokenPlaceholder"),
              onChange: (e) => setApiToken(e.target.value)
            }),
            h("button", { className: "mneme-btn", onClick: saveToken }, t("memory.settings.apiTokenSave"))
          ),
          apiTokenSaved && h("div", { style: { marginTop: 8 } }, h("span", { className: "mneme-saved" }, t("memory.settings.apiTokenSaved")))
        ),
        // 配置键覆盖面（issue #386 第 7 条）：只读核对表，放在 connect 组尾——
        // 它与上面的 API Token / 独立服务同属「我在这台机器上能调什么」那一类，
        // 而不是功能开关（那些在 personal/core/enhance 各组里改）。
        h(ConfigKeysCard, { t }),
        // —— 帮助：支持与鼓励（图标行 + 检测更新 + star，兼当「关于」收尾） ——
        groupHead("help"),
        // 反馈三入口：新建 issue 预填（版本+平台）/ 邮件 / 浏览已知问题。
        // 纯前端链接零后端成本；插件版本来自 /info，平台取 userAgent。GitHub
        // 仓库当前没有 issue 模板，故用 issues/new?title=&body= 直接预填。
        h("section", { className: "mneme-set-card" },
          h("div", { className: "mneme-set-title" }, t("memory.settings.feedback.title")),
          h("div", { className: "mneme-set-desc" }, t("memory.settings.feedback.desc")),
          h("div", { className: "mneme-feedlist" },
            feedRow("bug", t("memory.settings.feedback.newIssue"), t("memory.settings.feedback.newIssue.sub"),
              { href: issueHref, target: "_blank", rel: "noopener noreferrer" }),
            feedRow("mail", t("memory.settings.feedback.email"), t("memory.settings.feedback.email.sub"),
              { href: mailHref }),
            feedRow("search", t("memory.settings.feedback.browse"), t("memory.settings.feedback.browse.sub"),
              { href: "https://github.com/slow-stack/mneme/issues", target: "_blank", rel: "noopener noreferrer" })
          ),
          // 检测更新：手动触发（复验修订——原顶部自动横幅移除），结果内联；
          // outdated 时提示带 pnpm 钉子警示（#174 报障成因）。
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 12 } },
            h("button", { className: "mneme-btn", onClick: checkForUpdate, disabled: updateChecking },
              updateChecking ? "…" : t("memory.settings.update.check")),
            updateInfo && h("span", { className: "mneme-feedsub" }, checkResultText())
          ),
          updateInfo?.status === "outdated" && h("div", { className: "mneme-set-hint", style: { marginTop: 8 } },
            t("memory.settings.version.outdatedHint")),
          // star 鼓励入口：链接到仓库主页而非 stargazers——前者右上角就有
          // Star 按钮，后者只是「看谁点过」的名单页（复验实测反馈）。
          h("div", { className: "mneme-feedlist", style: { marginTop: 12 } },
            feedRow("star", t("memory.settings.star"), t("memory.settings.star.sub"),
              { href: "https://github.com/slow-stack/mneme", target: "_blank", rel: "noopener noreferrer" })
          ),
          h("div", { className: "mneme-set-foot" },
            h("span", null, `dsh-mneme v${pkgVersion}`)
          )
        )
      );
    }

    // --- 打开记忆库 ---
    // v0.7.15 起记忆库不再注册 conversation.view tab：对话内嵌体验差
    // （面板被悬浮输入框遮挡、挤压会话布局）。唯一入口是侧边栏记忆按钮，
    // 直接打开居中 sheet——对话留在背板之后，不占全屏。保留这层间接函数
    // 是给图/实体视图的「查看来源记忆」跳转一个稳定语义：打开 sheet，
    // MemoryExplorer 内部状态（选中行、过滤）由各自的跳转回调处理。
    function openLibrary() {
      setOverlayOpen(true);
      // 打开面板 = 用户正准备处理冻结冲突：顺手把入口红点重取一次，别让他
      // 对着一个已经过期的计数（裁决走别的路径、或后台 autoDream 刚写过库时，
      // 计数不该等 60s 兜底轮询才对齐）。
      conflictBadgeCount.refresh();
    }

    // --- Hero fallback overlay state (module-level pub/sub) ---
    const overlayListeners = new Set();
    let overlayOpenState = false;
    function setOverlayOpen(v) {
      if (v === overlayOpenState) return;
      overlayOpenState = v;
      for (const fn of overlayListeners) fn();
    }
    function useOverlayOpen() {
      const [open, setOpen] = useState(overlayOpenState);
      useEffect(() => {
        const fn = () => setOpen(overlayOpenState);
        overlayListeners.add(fn);
        return () => { overlayListeners.delete(fn); };
      }, []);
      return [open, setOpen];
    }

    // --- 引导任务在飞态（issue #558，module-level pub/sub）---
    // better-sidebar 关 tab 会把标签页体（MemoryExplorer 与引导弹层）整个卸载：
    // keepMounted 覆盖隐藏与切视图、**不含关闭**（它自己的设计文档写明「记录的
    // 寿命只由原生 tab 关闭与会话消失回收」）。引导 POST 照样跑完、行照样落库
    // （saveWithDedupe 的 (type,title,scope) 三元组去重 + _overwrite 刷新，重复
    // 执行是合并更新不写坏数据），但成功/失败提示没地方显示，忙碌态也丢了——
    // 重开标签页还能再提交一次。把任务状态搬到模块级：弹层挂载时回放快照、订阅
    // 后续变化，就是上面 overlayListeners 的现成形状。prop 钻孔的 busy 链
    // （弹层 → explorer → overlay）整条拆掉，三处各自订阅同一份。
    //
    // 清理责任有界：terminal 状态只在「人看得见的关闭」时回 idle（MemoryExplorer
    // 的 onClose、⋯ 菜单的收起、explorer 卸载时**非 running** 的兜底——规则是
    // 「只存活用户没来得及看的那一份」：卸载发生在 running 时，结果还没人看过，
    // 留着等重开回放；卸载时已经是 done/failed，说明用户见过它，回 idle 保持
    // 「重开是干净弹层」的既有行为）。running 状态只有这一条路能跨过卸载，没有
    // 定时器要跨卸载存活，进程级生命周期随面板 bundle 结束。
    const bootstrapJob = { phase: "idle", dir: "", result: null, error: null, listeners: new Set() };
    function setBootstrapJob(patch) {
      Object.assign(bootstrapJob, patch);
      for (const fn of bootstrapJob.listeners) fn();
    }
    // phase 回 idle 但**保留 dir**：重开弹层带着上次用过的目录，重试同目录是最常见
    // 的下一步（弹层挂载时从这份 dir 播种输入框）。
    function resetBootstrapJob() {
      setBootstrapJob({ phase: "idle", result: null, error: null });
    }
    function useBootstrapJob() {
      const [, bump] = useState(0);
      useEffect(() => {
        const fn = () => bump((n) => n + 1);
        bootstrapJob.listeners.add(fn);
        return () => { bootstrapJob.listeners.delete(fn); };
      }, []);
      return bootstrapJob;
    }

    // 居中 sheet 记忆库：任何状态下（含新会话 hero、无 tab 环）都能从侧边栏
    // 入口直接打开。背板点击 / Esc 关闭。portal 到 <body>，侧边栏的层叠
    // 上下文裁不住它；运行时拒绝 react-dom 时就地渲染（position:fixed 仍然成立）。
    function MemoryOverlay({ t }) {
      const [open, setOpen] = useOverlayOpen();
      // 库内是否有请求在飞（目前只有「从目录引导」会置位）。Esc / 背板 / ✕ 三条
      // 关闭路径都要看它：关掉弹层会把 MemoryExplorer 连同引导弹层一起卸载，
      // 而 POST 还在飞，回来那句「新建几条、并入几条」就再没有地方显示——
      // 库写进去了，用户却以为没成功（评审 #4453225573）。
      // #558 起直接订阅模块级 bootstrapJob：弹层与 explorer 的 prop 钻孔链拆掉后，
      // 这里不再依赖子组件回报（tab 注册的 explorer 没有 onBusyChange，原本就
      // 报不上来），在飞守卫对所有挂载路径一致成立。
      const bootstrapJob = useBootstrapJob();
      const explorerBusy = bootstrapJob.phase === "running";
      // 用 ref 读而不是进 effect 依赖：那个 effect 在 [open] 变化时会
      // closeBtnRef.current.focus()，若把 explorerBusy 也列进依赖，每次请求
      // 起落都会重跑一次并抢焦点——用户正打字输目录时会被踢出输入框。
      const explorerBusyRef = useRef(false);
      useEffect(() => { explorerBusyRef.current = explorerBusy; }, [explorerBusy]);
      // #178：弹层焦点管理——打开时把焦点移入面板（关闭按钮为入口），
      // Tab 循环圈在面板内（Tab 从最后一个元素出去回到关闭按钮），
      // Esc/关闭时把焦点还给触发元素（侧边栏入口）。
      const panelRef = useRef(null);
      const closeBtnRef = useRef(null);
      useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => {
          // 库内请求在飞时不响应 Esc：见上面 explorerBusy 的注释。
          if (e.key === "Escape") { if (!explorerBusyRef.current) setOpen(false); return; }
          if (e.key !== "Tab" || !panelRef.current) return;
          const focusables = panelRef.current.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])');
          if (focusables.length === 0) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (e.shiftKey && (document.activeElement === first || !panelRef.current.contains(document.activeElement))) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        };
        window.addEventListener("keydown", onKey);
        if (closeBtnRef.current) closeBtnRef.current.focus();
        return () => {
          window.removeEventListener("keydown", onKey);
          const opener = document.querySelector('[data-mneme-overlay-opener]');
          if (opener) opener.focus();
        };
      }, [open]);
      if (!open) return null;
      // 背板与 sheet 是兄弟节点而不是嵌套：点击背板自身才关闭，sheet 内部
      // 的任何点击都不会冒泡到背板，不需要额外拦截。
      const tree = h(react.Fragment, null,
        h("div", {
          className: "mneme-backdrop",
          onClick: () => { if (!explorerBusyRef.current) setOpen(false); },
          "aria-hidden": "true"
        }),
        h("div", { className: "mneme-overlay", role: "region", "aria-label": t("memory.view.label"), ref: panelRef },
          h("div", { className: "mneme-overlaybar" },
            h("span", { className: "mneme-overlaytitle" },
              renderMnemeMark({ size: 15 }),
              t("memory.view.label")
            ),
            h("button", {
              type: "button",
              className: "mneme-footbtn",
              ref: closeBtnRef,
              // 忙碌时不禁用、只标 aria-disabled：真的 disabled 会把焦点从按钮上
              // 拿走，而 #178 的 Tab 环靠 closeBtnRef 当入口，焦点落空就出不去。
              "aria-disabled": String(explorerBusy),
              "aria-label": t("memory.overlay.close"),
              title: t("memory.overlay.close"),
              onClick: () => { if (!explorerBusyRef.current) setOpen(false); }
            }, "✕")
          ),
          h("div", { className: "mneme-overlaybody" }, h(MemoryExplorer, { t }))
        )
      );
      if (reactDom && typeof document !== "undefined") return reactDom.createPortal(tree, document.body);
      return tree;
    }

    const EXPLORER_TYPES = ["preference", "project", "decision", "summary", "history"];
    const PAGE_SIZE = 100; // browse page size — the tree grows by 100-row pages

    // --- Status sub-view: a responsive grid of stat cards. Every card owns
    // its fetch, loading ("…") and error state, so one failing endpoint
    // never blanks or blocks the others.
    // 卡片解剖：标题（h3）→ 大数字 → 指标行（rows，一行一指标）→ 脚注
    // （foot，采样口径这类背景信息）。cap 仍保留给单句说明型卡片。
    function StatusCard({ t, title, loading, error, num, numWarn, cap, rows, foot, className }) {
      return h("div", { className: className ? `mneme-statuscard ${className}` : "mneme-statuscard" },
        h("h3", { className: "mneme-xcolhead" }, title),
        loading
          ? h("div", { className: "mneme-statusnum" }, "…")
          : error
            ? h("div", { className: "mneme-statuscap", style: { color: "var(--mneme-danger)" } }, t("memory.status.error"))
            : h(react.Fragment, null,
                // numWarn：大数字走预警色（--mneme-warn）。只有需要报警的卡传它，
                // 其余卡不传、渲染与之前逐字节一致。
                h("div", { className: numWarn ? "mneme-statusnum mneme-statusnum--warn" : "mneme-statusnum" }, num),
                rows && rows.length
                  ? h("div", { className: "mneme-statrows" },
                      rows.map((r, i) => h("div", { className: r.warn ? "mneme-statrow mneme-statrow--warn" : "mneme-statrow", key: r.key ?? i },
                        h("span", null, r.label),
                        h("span", { className: "mneme-statrowval", title: String(r.value) }, String(r.value))))
                    )
                  : cap ? h("div", { className: "mneme-statuscap" }, cap) : null,
                foot ? h("div", { className: "mneme-statfoot" }, foot) : null
              )
      );
    }

    // 记忆总数 — list total plus per-type subtotals; each subtotal request
    // may fail independently (rendered as "—") without sinking the card.
    function MemoriesStatusCard({ t }) {
      const [state, setState] = useState({ loading: true, error: false, total: 0, byType: [] });
      useEffect(() => {
        let cancelled = false;
        const one = (ty) =>
          apiFetch(`/api/dsh-mneme/list?limit=1&order=chrono${ty ? `&type=${encodeURIComponent(ty)}` : ""}`)
            .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); });
        one()
          .then((all) => {
            if (cancelled) return null;
            const total = all.total || 0;
            return Promise.all(EXPLORER_TYPES.map((ty) =>
              one(ty).then((j) => [ty, j.total || 0]).catch(() => [ty, null])
            )).then((byType) => {
              if (!cancelled) setState({ loading: false, error: false, total, byType });
            });
          })
          .catch(() => { if (!cancelled) setState({ loading: false, error: true, total: 0, byType: [] }); });
        return () => { cancelled = true; };
      }, []);
      const rows = state.byType
        .map(([ty, n]) => ({ label: typeLabel(t, ty), value: n === null ? "—" : String(n) }));
      return h(StatusCard, {
        t,
        title: t("memory.status.memories"),
        loading: state.loading,
        error: state.error,
        num: state.total.toLocaleString(),
        rows
      });
    }

    // 实体 — directory snapshot grouped by entity type.
    function EntitiesStatusCard({ t }) {
      const [state, setState] = useState({ loading: true, error: false, total: 0, totalKnown: true, byType: [] });
      useEffect(() => {
        let cancelled = false;
        const order = ["organization", "person", "project", "technology", "concept"];
        apiFetch("/api/dsh-mneme/entities?limit=500")
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((j) => {
            if (cancelled) return;
            const list = Array.isArray(j.entities) ? j.entities : [];
            const counts = new Map();
            for (const e of list) {
              const key = order.includes(e.type) ? e.type : "other";
              counts.set(key, (counts.get(key) || 0) + 1);
            }
            const byType = order.concat("other")
              .filter((k) => counts.has(k))
              .map((k) => [k, counts.get(k)]);
            // 大数字用后端回的全库 total；分类型小行仍来自本次切片（最近 500 个），
            // 两个口径不一样，切片写进 foot 里说清楚——以前 total 取 list.length，
            // 一万六千个实体永远显示成 500，看着像"实体太少"。
            // totalExact 为假（计数失败 / 老宿主）时 total 只是切片长度，不能当全库数
            // 显示：那正是原来「永远 500」的错法。这时大数字显示“—”，脚注说明总数读不到。
            const totalKnown = j.totalExact === true && typeof j.total === "number";
            const realTotal = totalKnown ? j.total : list.length;
            setState({ loading: false, error: false, total: realTotal, totalKnown, sampled: list.length < realTotal, byType });
          })
          .catch(() => { if (!cancelled) setState({ loading: false, error: true, total: 0, totalKnown: true, byType: [] }); });
        return () => { cancelled = true; };
      }, []);
      const rows = state.byType.map(([ty, n]) => ({ label: entityTypeLabel(t, ty), value: String(n) }));
      return h(StatusCard, {
        t,
        title: t("memory.status.entities"),
        loading: state.loading,
        error: state.error,
        num: state.totalKnown === false ? "—" : state.total.toLocaleString(),
        rows,
        foot: state.totalKnown === false
          ? t("memory.status.entitiesUnknown")
          : state.sampled === true ? t("memory.status.entitiesSampled") : null
      });
    }

    // 向量索引 — whether semantic recall is switched on.
    // 取回本地推理运行时的共享块：**面板状态卡片与设置页共用同一份实现**。
    //
    // 为什么设置页也要有：状态卡片是「看到了顺手点」，而设置页是用户主动去找的地方。
    // 两处都给出代价说明与可复制的命令行，并且在**成功后明确要求重启** —— 取回运行时不会让
    // 当前进程里那个已经失败的 embedder 复活，重启才生效；不说清这一点，用户会以为功能坏了。
    function RuntimeProvisionBlock({ t, onChanged }) {
      const [runtime, setRuntime] = useState(null);
      const [ready, setReady] = useState(null);
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState("");
      const [tick, setTick] = useState(0);

      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/semantic")
          .then((res) => (res.ok ? res.json() : null))
          .then((j) => {
            if (cancelled || !j) return;
            setRuntime(j.localRuntime ?? null);
            setReady(j.ready ?? null);
          })
          .catch(() => {});
        return () => { cancelled = true; };
      }, [tick]);

      const available = runtime?.status === "available";
      // 运行时就绪但 embedder 没起来 = 刚取回到、还没重启。这时唯一有意义的动作就是重启。
      const needsRestart = available && ready !== true;

      const provision = async () => {
        setBusy(true);
        setMsg("");
        try {
          const res = await apiFetch("/api/dsh-mneme/runtime/provision", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ overwrite: runtime?.status === "broken" })
          });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const j = await res.json();
          if (j?.ok) {
            const key = j.strategy === "download"
              ? "memory.status.vectorRuntimeFetchDownloaded"
              : "memory.status.vectorRuntimeFetchAdopted";
            setMsg(t(key).replace("{n}", j.packages ?? 0).replace("{m}", j.files ?? 0).replace("{mode}", j.materialize ?? "?"));
          } else {
            setMsg(t("memory.status.vectorRuntimeFetchFailed").replace("{reason}", j?.reason ?? j?.status ?? "?"));
          }
          setTick((n) => n + 1);
          if (onChanged) onChanged();
        } catch (error) {
          setMsg(t("memory.status.vectorRuntimeFetchFailed").replace("{reason}", String((error && error.message) || error)));
        } finally {
          setBusy(false);
        }
      };

      // 配好之后就把整块收起来：设置页只在「需要用户知道或行动」时占地方，配好了就是纯噪音。
      // （msg 例外：刚点完按钮要看结果，那一刻 ready 还没变，本来也不会命中这条。）
      if (available && ready === true && msg === "") return null;

      return h(react.Fragment, null,
        h("div", { className: "mneme-runtimehint" },
          t("memory.runtime.title") + "：" + (available ? t("memory.runtime.available") : t("memory.runtime.missing"))),
        // 未就绪时才给代价说明与按钮；已就绪只留上面那行状态（以及在需要重启时下面那行提醒）。
        available ? null : h(react.Fragment, null,
          h("div", { className: "mneme-runtimehint" }, t("memory.status.vectorRuntimeCost")),
          h("button", {
            type: "button",
            className: "mneme-footbtn",
            disabled: busy,
            onClick: provision
          }, busy ? t("memory.status.vectorRuntimeFetchBusy") : t("memory.status.vectorRuntimeFetch"))
        ),
        msg ? h("div", { className: "mneme-runtimehint" }, msg) : null,
        needsRestart ? h("div", { className: "mneme-saved" }, t("memory.runtime.restart")) : null
      );
    }
    function VectorStatusCard({ t }) {
      const [state, setState] = useState({ loading: true, error: false, provider: null, ready: null, configured: null, degraded: false, dimension: 0, embedded: 0, total: 0, localRuntime: null, backfill: null });
      // 收编是写操作、耗时数秒，所以要有忙碌态与就地结果；reload 只是用来让上面的
      // 加载 useEffect 重跑一次，从而把最新状态拉回来。
      const [reload, setReload] = useState(0);
      useEffect(() => {
        let cancelled = false;
        // #118: /vector-config is secret-bearing (401 without a stored token →
        // "加载失败") and its `enabled` only reflects the OpenAI-compat external
        // service, so ollama/local mode always showed "未启用". /semantic is open
        // and covers every embedder provider + index stats.
        apiFetch("/api/dsh-mneme/semantic")
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((j) => {
            if (cancelled) return;
            setState({
              loading: false,
              error: false,
              provider: j?.embedProvider || null,
              ready: j?.ready ?? null,
              // issue #135: missing on older servers → null/false，卡片退化成
              // 旧行为（只按 ready 判断），不会误报「未配置」。
              configured: typeof j?.configured === "boolean" ? j.configured : null,
              degraded: j?.degraded === true,
              // Legacy OpenAI embedder exposes dimension only after its first
              // successful embed — fall back to the index stats' dimension.
              dimension: Number(j?.dimension ?? j?.index?.dimension ?? 0),
              embedded: Number(j?.index?.embeddedCount ?? 0),
              total: Number(j?.index?.totalCount ?? 0),
              // issue #131: 自管运行时状态。与 provider 无关地拿来，由下面决定是否要展示。
              localRuntime: j?.localRuntime ?? null,
              // #604：上一轮回填的去向。此前这一段完全没有出口 —— 面板只能看到
              // 「已索引 N / M 条」，撞 cap 停了、全行失败、抛错都长得一样。
              backfill: j?.embeddings?.backfill ?? null
            });
          })
          .catch(() => { if (!cancelled) setState({ loading: false, error: true, provider: null, ready: null, dimension: 0, embedded: 0, localRuntime: null }); });
        return () => { cancelled = true; };
      }, [reload]);
      // #604：回填在后台跑，卡如果只在挂载时取一次，「回填中」会一直挂着不动 ——
      // 那正是这次要修的「看不见」。跑着的时候每 5 秒自己再问一次，停了就不再问。
      useEffect(() => {
        if (state.backfill?.state !== "running") return undefined;
        const timer = setTimeout(() => setReload((n) => n + 1), 5000);
        return () => clearTimeout(timer);
      }, [state.backfill?.state, reload]);
      const off = !state.provider;
      // issue #135: 先把「没配」和「配了但在初始化」分开。此前两者都落到
      // ready !== true，于是未配置的 legacy embedder（ready 恒 true）反而
      // 一路显示成正常状态。
      const unconfigured = !off && state.configured === false;
      const pending = !off && !unconfigured && state.ready !== true;
      // 配好了、库里有东西、却一条都没嵌上 —— 这才是真正的降级。
      const degraded = !off && !unconfigured && !pending && state.degraded === true;
      // 本地 provider 缺运行时：绝不能显示「初始化中」——它永远不会初始化，只会一直重试，
      // 而那正是那份运行时（数百 MB）缺位的真实原因。这里必须说真话并给出下一步。
      const localBlocked = /^Local/.test(state.provider || "") && state.localRuntime?.status !== "available" && state.localRuntime != null;
      // 运行时已就绪但 embedder 还没起来 —— 这就是「刚取回运行时、但进程里的 embedder 早已失败」的过渡态。
      // 这时候继续说「embedder 不可达，正在重试」会让人以为永远好不了；要说的是可操作的那句：重启 DSH。
      const runtimeReadyPending = pending && state.localRuntime?.status === "available";
      const num = off
        ? t("memory.status.vectorOff")
        : localBlocked
          ? t("memory.status.vectorRuntimeMissing")
          : unconfigured
            ? t("memory.status.vectorUnconfigured")
            : runtimeReadyPending
              ? t("memory.status.vectorRuntimeReady")
              : pending
                ? t("memory.status.vectorInit")
                : `${state.provider.replace(/Embedder$/, "")} · ${state.dimension}D`;
      const cap = localBlocked
        ? t("memory.status.vectorRuntimeHint").replace("{status}", state.localRuntime.status)
        : unconfigured
          ? t("memory.status.vectorUnconfiguredHint")
          : runtimeReadyPending
            ? t("memory.status.vectorRuntimeReadyHint")
            : pending
              ? t("memory.status.vectorInitHint")
              : off ? ""
                : degraded
                  ? t("memory.status.vectorDegradedHint").replace("{m}", state.total)
                  : t("memory.status.vectorIndexed").replace("{n}", state.embedded).replace("{m}", state.total);

      // #604：回填这一轮到底怎么了，必须在卡上说得出来。三种停法含义完全不同：
      //   capped  → 还有活，额度用完了，会自动续排（可等）
      //   stalled → 剩下的都嵌不进去，本轮不再重试（要查原因）
      //   error   → 这一轮整个抛错（要看日志）
      // 都没跑过时 backfill 为 null，这里不出任何多余的行。
      const bf = state.backfill;
      const backfillHint = !bf || off || unconfigured || pending || localBlocked
        ? ""
        : bf.state === "running"
          ? t("memory.status.vectorBackfillRunning").replace("{m}", String(bf.maxTotal ?? "?"))
          : bf.state === "error"
            ? t("memory.status.vectorBackfillError").replace("{e}", String(bf.error ?? "").slice(0, 120))
            : bf.finishReason === "capped"
              ? t("memory.status.vectorBackfillCapped").replace("{m}", String(bf.maxTotal ?? "?"))
              : bf.finishReason === "stalled"
                ? t("memory.status.vectorBackfillStalled").replace("{f}", String(bf.failed ?? 0))
                : bf.finishReason === "drained"
                  ? t("memory.status.vectorBackfillDrained").replace("{n}", String(bf.indexed ?? 0))
                  : "";


      // 取回运行时由共享组件负责（设置页用的是同一份实现，见 RuntimeProvisionBlock）：
      // 代价说明、三档来源、结果文案与「要重启」都在那里 —— 同一件事不该有两份代码。
      return h(react.Fragment, null,
        h(StatusCard, {
          t,
          title: t("memory.status.vector"),
          loading: state.loading,
          error: state.error,
          num,
          cap,
          // #604：回填去向单独一行，不与「已索引 N / M」混在一句里 —— 那两件事
          // 回答的是不同问题（现在有多少可用 / 上一轮为什么停）。
          foot: backfillHint || null,
          // 概览区三张卡在 2 列档位会剩下半行空洞：向量卡在该档位跨满整行
          className: "mneme-statuscard--vectorwide"
        }),
        !state.loading && !state.error && localBlocked
          ? h("div", { className: "mneme-statuscap", style: { marginTop: "6px" } },
              h(RuntimeProvisionBlock, { t, onChanged: () => setReload((n) => n + 1) }))
          : null
      );
    }

    // 人读体积：回收报告里全是字节数（六到七位），不折成 KiB/MiB 就看不出「到底有没有
    // 变小」——而那正是这张卡要回答的问题。
    function formatBytes(n) {
      const v = Number(n);
      if (!Number.isFinite(v) || v < 0) return "—";
      if (v < 1024) return `${v} B`;
      const units = ["KiB", "MiB", "GiB", "TiB"];
      let x = v / 1024;
      let i = 0;
      while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
      return `${x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)} ${units[i]}`;
    }

    // 存储回收卡（issue #386 第 4 条，状态页「维护」区）。`dsh-mneme reclaim` 此前只有
    // CLI 与 standalone 两张脸，面板侧一个字都没有——「不可逆的内容丢弃」这种能力要么
    // 能被发现，要么等于不存在。
    //
    // 三条不变量，别在「顺手简化」时弄丢：
    //   ① 执行是两步。第一次点只进确认态，把这次要动的数字摆到眼前；第二次点才真的发
    //      POST。不用 window.confirm——宿主 webview 里它不一定可用，而且它挡不住「到底
    //      要清多少行」这个问题。
    //   ② VACUUM 失败 ≠ 成功。清理的两个 UPDATE 各自提交且不可逆，VACUUM 只负责把文件
    //      缩回去，失败最常见的原因是锁被别的进程占着。所以失败时必须同时说清四件事：
    //      清理已完成、不可逆、文件暂时不会变小、下一步重跑即可（清理是幂等的）。绝不
    //      能渲染成一次干净的「成功」。
    //   ③ 保留窗口只在点「重新估算」时发一次请求。键入即发 = 想输 30 却先敲出 3 的那一刻
    //      就换了估算，数字会跳。而且估算一旦与输入框不一致，确认态里摆出来的就是另一个
    //      动作的数字——所以那种状态下执行钮直接禁用（见下面的 stale）。
    //
    // 报告字段由 src/maintenance.js 的 reclaim() 决定，卡片只读不改。
    function MaintenanceCard({ t }) {
      // 与 src/maintenance.js 的 DEFAULT_INPUT_RETENTION_DAYS 同值：这里只用来初始化
      // 输入框与首屏那次 GET，真正的默认值仍由服务端兜底。
      const DEFAULT_WINDOW_DAYS = 7;
      // 与后端 MAX_RECLAIM_WINDOW_DAYS 同值。超界窗口服务端会回 400，但本地先拦一道：
      // 否则用户点「重新估算」只会看到一句服务端错误，还以为是网络问题。
      const MAX_WINDOW_DAYS = 3650;
      // 面板走 in-process 路由，与 CLI/standalone 底下是同一条 reclaim 实现。
      const RECLAIM_PATH = "/api/dsh-mneme/maintenance/reclaim";
      const [days, setDays] = useState(String(DEFAULT_WINDOW_DAYS));
      const [vacuum, setVacuum] = useState(false);
      const [report, setReport] = useState(null);
      const [loading, setLoading] = useState(true);
      const [estimating, setEstimating] = useState(false);
      const [error, setError] = useState("");
      // 确认态：true = 第一次点过了，此刻按钮换成实心红确认钮。
      const [armed, setArmed] = useState(false);
      const [running, setRunning] = useState(false);
      // 成功与失败分开存：合成一个对象容易在「先失败后成功」时把上一次的残留显示出来。
      const [result, setResult] = useState(null);
      const [resultError, setResultError] = useState("");

      // 挂载即预估：打开状态页就该看见「现在能收多少」，而不是先点一下才有数字。
      useEffect(() => {
        let cancelled = false;
        apiFetch(`${RECLAIM_PATH}?olderThanDays=${DEFAULT_WINDOW_DAYS}`)
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((j) => { if (!cancelled) { setReport(j); setLoading(false); } })
          .catch(() => { if (!cancelled) { setError(t("memory.status.maint.failed")); setLoading(false); } });
        return () => { cancelled = true; };
      }, []);

      // 只由「重新估算」按钮调用，不在 onChange 里调用（见上面 ③）。
      const estimate = () => {
        if (!/^\d+$/.test(days)) { setError(t("memory.status.maint.badWindow")); setArmed(false); return; }
        // 上界也在这里拦：`1e20` 与 400 位数字都能过 /^\d+$/（后者化成 Infinity），
        // 后端会回 400，但那样用户看到的是一句「回收失败」，不如直接说窗口不合法。
        if (Number(days) > MAX_WINDOW_DAYS) { setError(t("memory.status.maint.badWindow")); setArmed(false); return; }
        setEstimating(true);
        setError("");
        // 窗口一变，上一轮的确认态连同它显示的数字一起作废；上一次执行的回执也别再跟
        // 新的估算混在一起。
        setArmed(false);
        setResult(null);
        setResultError("");
        apiFetch(`${RECLAIM_PATH}?olderThanDays=${days}`)
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((j) => { setReport(j); setEstimating(false); })
          .catch(() => { setError(t("memory.status.maint.failed")); setEstimating(false); });
      };

      // 第二次点击（确认态里）才走这里。dryRun:false 与 confirm:true 是后端那条不可逆
      // 动作的确认门：缺 confirm 会回 400 confirm-required 并附一份 dry-run 报告。两个
      // 字面量逐字保留——改名或省掉一个都等于把门拆了。
      const execute = () => {
        setRunning(true);
        setResultError("");
        apiFetch(RECLAIM_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dryRun: false, confirm: true, olderThanDays: Number(days), vacuum })
        })
          .then((res) => res.json().catch(() => null).then((body) => ({ ok: res.ok, status: res.status, body })))
          .then((r) => {
            // 非 2xx 一律落到这条分支并带着服务端的 error 串返回：成功态只在守卫另一侧。
            if (!r.ok) {
              setResultError(`${t("memory.status.maint.failed")} · ${(r.body && r.body.error) || `HTTP ${r.status}`}`);
              setRunning(false);
              return;
            }
            setResult(r.body);
            setArmed(false);
            setRunning(false);
            // 回收确认模式真的删了行：主列表/实体页/工作台的计数都变了，广播重取。
            broadcastStoreChanged("reclaim");
          })
          .catch(() => { setResultError(t("memory.status.maint.failed")); setRunning(false); });
      };

      const size = (report && report.size) || {};
      const planned = (report && report.planned) || {};
      const rv = (result && result.vacuum) || {};
      const rsz = (result && result.size) || {};
      const rcl = (result && result.cleared) || {};
      // 估算数字与输入框不一致（刚改过窗口还没重新估算）时禁止执行：否则确认态里摆出来
      // 的是另一个窗口的数字，而对不可逆操作来说这是最坏的一种错位。
      const stale = !report || String(report.olderThanDays) !== days;
      // vacuum.error 是 string|null；非 null 就是「清理成功但文件没缩」这种半成功态。
      const vacuumError = rv.error == null ? null : String(rv.error);
      const freed = Number(rsz.before_bytes ?? 0) - Number(rsz.after_bytes ?? 0);

      return h("div", { className: "mneme-statuscard mneme-statuscard--wide" },
        h("h3", { className: "mneme-xcolhead" }, t("memory.status.maint")),
        loading
          ? h("div", { className: "mneme-statusnum" }, "…")
          : h("div", { className: "mneme-statusnum" }, formatBytes(size.before_bytes)),
        report ? h("div", { className: "mneme-statrows" },
          h("div", { className: "mneme-statrow" },
            h("span", null, t("memory.status.maint.freelist")),
            h("span", { className: "mneme-statrowval" }, `${formatBytes(size.freelist_bytes)} · ${size.freelist_pages ?? 0}`)),
          h("div", { className: "mneme-statrow" },
            h("span", null, t("memory.status.maint.plannedInputs")),
            h("span", { className: "mneme-statrowval" }, String(planned.dream_run_inputs ?? 0))),
          h("div", { className: "mneme-statrow" },
            h("span", null, t("memory.status.maint.plannedEmbeddings")),
            h("span", { className: "mneme-statrowval" }, String(planned.archived_embeddings ?? 0))),
          h("div", { className: "mneme-statrow" },
            h("span", null, t("memory.status.maint.window")),
            h("span", { className: "mneme-statrowval" }, `${report.olderThanDays} ${t("memory.status.maint.windowUnit")}`))
        ) : null,
        // 控制区：窗口只在点按钮时重新估算；VACUUM 默认关，并明说它会短暂独占数据库。
        h("div", { className: "mneme-maintrow" },
          h("span", { className: "mneme-maintlbl" }, t("memory.status.maint.windowLabel")),
          h("input", {
            className: "mneme-set-input",
            inputMode: "numeric",
            value: days,
            disabled: armed || running,
            onChange: (e) => setDays(e.target.value)
          }),
          h("button", {
            type: "button",
            className: "mneme-btn",
            disabled: armed || running || estimating,
            onClick: estimate
          }, estimating ? t("memory.status.maint.reestimating") : t("memory.status.maint.reestimate"))
        ),
        h("label", { className: "mneme-maintcheck" },
          h("input", {
            type: "checkbox",
            checked: vacuum,
            disabled: armed || running,
            onChange: (e) => setVacuum(e.target.checked)
          }),
          h("span", null, t("memory.status.maint.vacuum"))
        ),
        h("div", { className: "mneme-statuscap" }, t("memory.status.maint.vacuumHint")),
        stale && !loading && !estimating
          ? h("div", { className: "mneme-statuscap" }, t("memory.status.maint.stale"))
          : null,
        // 两步确认。未武装时只有「执行回收」（点了只进确认态，不发请求）；武装后换成实心
        // 红确认钮，并把窗口/VACUUM 在确认态里锁住——保证屏幕上的数字就是即将发出的动作。
        armed
          ? h(react.Fragment, null,
              h("div", { className: "mneme-maintwarn" },
                h("div", { className: "mneme-maintwarnhead" },
                  t("memory.status.maint.confirmHint")
                    .replace("{inputs}", String(planned.dream_run_inputs ?? 0))
                    .replace("{embeddings}", String(planned.archived_embeddings ?? 0))),
                h("div", { className: "mneme-statuscap" },
                  `${t("memory.status.maint.window")} ${report.olderThanDays} ${t("memory.status.maint.windowUnit")} · `
                  + (vacuum ? t("memory.status.maint.vacuum") : t("memory.status.maint.vacuumOff")))
              ),
              h("div", { className: "mneme-maintrow" },
                h("button", {
                  type: "button",
                  className: "mneme-btn mneme-btndangerconfirm",
                  disabled: running,
                  onClick: execute
                }, running ? t("memory.status.maint.running") : t("memory.status.maint.confirm")),
                h("button", {
                  type: "button",
                  className: "mneme-btn",
                  disabled: running,
                  onClick: () => setArmed(false)
                }, t("memory.status.maint.cancel"))
              )
            )
          : h("div", { className: "mneme-maintrow" },
              h("button", {
                type: "button",
                className: "mneme-btn mneme-btndanger",
                disabled: running || loading || estimating || stale,
                onClick: () => setArmed(true)
              }, t("memory.status.maint.execute"))
            ),
        result ? h("div", { className: "mneme-maintresult" },
          h("div", { className: "mneme-maintresulthead" },
            vacuumError ? t("memory.status.maint.vacuumFailed") : t("memory.status.maint.done")),
          h("div", { className: "mneme-statrows" },
            h("div", { className: "mneme-statrow" },
              h("span", null, t("memory.status.maint.clearedInputs")),
              h("span", { className: "mneme-statrowval" }, String(rcl.dream_run_inputs ?? 0))),
            h("div", { className: "mneme-statrow" },
              h("span", null, t("memory.status.maint.clearedEmbeddings")),
              h("span", { className: "mneme-statrowval" }, String(rcl.archived_embeddings ?? 0))),
            h("div", { className: "mneme-statrow" },
              h("span", null, t("memory.status.maint.size")),
              h("span", { className: "mneme-statrowval" }, `${formatBytes(rsz.before_bytes)} → ${formatBytes(rsz.after_bytes)}`)),
            h("div", { className: "mneme-statrow" },
              h("span", null, t("memory.status.maint.reclaimed")),
              h("span", { className: "mneme-statrowval" }, formatBytes(freed))),
            h("div", { className: "mneme-statrow" },
              h("span", null, t("memory.status.maint.receipt")),
              h("span", { className: "mneme-statrowval" },
                result.receipt == null ? t("memory.status.maint.receiptNone") : String(result.receipt))),
            h("div", { className: "mneme-statrow" },
              h("span", null, t("memory.status.maint.duration")),
              h("span", { className: "mneme-statrowval" }, `${Number(result.duration_ms ?? 0)} ms`))
          ),
          // VACUUM 失败 ≠ 成功：清理已经落库且不可逆，失败的只是「把文件缩回去」这一步。
          // 这里必须把「已完成 + 不可逆 + 暂时不会变小」和下一步（重跑即可，清理是幂等
          // 的）一起说清，否则用户只看到「没变小」会以为白清了。
          vacuumError
            ? h("div", { className: "mneme-maintwarn" },
                h("div", { className: "mneme-maintwarnhead" },
                  `${t("memory.status.maint.vacuumFailed")} · ${vacuumError}`),
                h("div", { className: "mneme-statuscap" }, t("memory.status.maint.vacuumFailedHint")))
            : h("div", { className: "mneme-statuscap" },
                rv.ran ? t("memory.status.maint.vacuumRan") : t("memory.status.maint.vacuumOff"))
        ) : null,
        resultError ? h("div", { className: "mneme-mainterr" }, resultError) : null,
        error ? h("div", { className: "mneme-mainterr" }, error) : null
      );
    }

    // Markdown 镜像健康卡（issue #386 第 3 条）。后端 /health 对镜像读失败是
    // fail-closed（dirty=null → unknown）；面板侧同样 fail-closed：fetch 失败
    // 或任何非 ok/degraded 的 status 一律渲染成「未知」，绝不显示「正常」——
    // 镜像写失败（磁盘满/权限）在库内完全静默，这张卡是最早的可见信号。
    function MirrorHealthCard({ t }) {
      const [state, setState] = useState({ loading: true, mirror: null });
      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/health")
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((j) => { if (!cancelled) setState({ loading: false, mirror: (j && j.mirror) || null }); })
          .catch(() => { if (!cancelled) setState({ loading: false, mirror: null }); });
        return () => { cancelled = true; };
      }, []);
      const m = state.mirror;
      const status = m && (m.status === "ok" || m.status === "degraded") ? m.status : "unknown";
      const num = status === "ok" ? t("memory.status.mirror.ok")
        : status === "degraded" ? t("memory.status.mirror.degraded")
        : t("memory.status.mirror.unknown");
      const errText = !m || !m.last_error ? null
        : m.last_error === "no-space" ? t("memory.status.mirror.err.noSpace")
        : m.last_error === "permission" ? t("memory.status.mirror.err.permission")
        : t("memory.status.mirror.err.syncFailed");
      const rows = [];
      if (m && m.dirty === true) rows.push({ key: "dirty", label: t("memory.status.mirror.dirty"), value: t("memory.status.mirror.yes") });
      if (errText) rows.push({ key: "err", label: t("memory.status.mirror.lastError"), value: errText });
      rows.push({ key: "attempt", label: t("memory.status.mirror.lastAttempt"), value: formatRelativeTime(m && m.last_attempt, t) });
      rows.push({ key: "success", label: t("memory.status.mirror.successAt"), value: formatRelativeTime(m && m.success_at, t) });
      return h(StatusCard, {
        t,
        title: t("memory.status.mirror"),
        loading: state.loading,
        error: false,
        num,
        rows,
        foot: t("memory.status.mirror.foot")
      });
    }

    // 库体积卡（#275 容量预警，空间维度）。数据与镜像健康卡同一条 /health 路径，
    // 读它的 capacity 块——维护者的接手口径就是「加一个库体积卡是同一条路径」。
    // 三种拿不到数据的情况全部 fail-closed 渲染成「未知」，绝不显示「正常」：
    // fetch 失败、老宿主没有 capacity 块、后端读失败（status:"unknown"）。
    // 预警只是观察口：卡片给的是「过线了，先跑无损回收」，不自动做任何事
    // （#275 拍板：真删由人显式确认）。
    function CapacityCard({ t }) {
      const [state, setState] = useState({ loading: true, capacity: null });
      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/health")
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((j) => { if (!cancelled) setState({ loading: false, capacity: (j && j.capacity) || null }); })
          .catch(() => { if (!cancelled) setState({ loading: false, capacity: null }); });
        return () => { cancelled = true; };
      }, []);
      const c = state.capacity;
      const unknown = !c || c.status === "unknown";
      const pct = (x) => `${Math.round(x * 1000) / 10}%`;
      const rows = [];
      if (!unknown && typeof c.active_rows === "number") {
        rows.push({ key: "active", label: t("memory.status.capacity.active"), value: c.active_rows.toLocaleString() });
      }
      if (!unknown && typeof c.archived_rows === "number") {
        const share = typeof c.archived_ratio === "number" ? ` (${pct(c.archived_ratio)})` : "";
        rows.push({ key: "archived", label: t("memory.status.capacity.archived"), value: c.archived_rows.toLocaleString() + share });
      }
      if (!unknown && typeof c.freelist_bytes === "number") {
        rows.push({ key: "freelist", label: t("memory.status.capacity.reclaimable"), value: formatBytes(c.freelist_bytes) });
      }
      // 过线的检查逐条列出，值/阈值都给全——「报警」要是能对上数字的，不然只是
      // 一句让人去翻配置的空话。键集合有界（服务端只发那三种），但标签仍显式
      // 映射：不按键名拼 i18n key，老字典缺键时会直接把键名漏给用户。
      const checkLabel = (key) =>
        key === "db_size" ? t("memory.status.capacity.check.dbSize")
          : key === "archived_rows" ? t("memory.status.capacity.check.archivedRows")
          : t("memory.status.capacity.check.archivedRatio");
      const checkValue = (chk) =>
        chk.key === "db_size" ? `${formatBytes(chk.value_bytes)} / ${formatBytes(chk.threshold_bytes)}`
          : chk.key === "archived_rows" ? `${chk.value.toLocaleString()} / ${chk.threshold.toLocaleString()}`
          : `${pct(chk.value)} / ${pct(chk.threshold)}`;
      const checks = !unknown && Array.isArray(c.checks) ? c.checks : [];
      let warn = false;
      for (const chk of checks) {
        if (chk.status === "warn") {
          warn = true;
          rows.push({ key: `warn-${chk.key}`, warn: true, label: checkLabel(chk.key), value: checkValue(chk) });
        }
      }
      // :memory: 库没有磁盘足迹（file_bytes 为 null）——大数字给「—」而不是 0，
      // 「量不到」和「零体积」是两回事。
      const num = unknown ? t("memory.status.capacity.unknown") : (typeof c.file_bytes === "number" ? formatBytes(c.file_bytes) : "—");
      return h(StatusCard, {
        t,
        title: t("memory.status.capacity"),
        loading: state.loading,
        error: false,
        num,
        numWarn: warn,
        rows,
        foot: unknown ? t("memory.status.capacity.unknownFoot") : t("memory.status.capacity.foot")
      });
    }

    // --- 配置键覆盖面（issue #386 第 7 条）---
    // 面板能改的键（settings.js 白名单）与 schema 里真有的键是两张表，从没被摆在一起
    // 对过。这条卡把它们交/差出来，回答一个具体问题：**「我在配置文件里看到的这个键，
    // 为什么在面板上找不到」**——答案要么是「它只能改文件」（fileOnly），要么是「它
    // 登记了却没默认值」（undefaulted，见 config-keys.js 对 dreamProvider 的说明）。
    //
    // 只显示键名，一个值都不显示：apiToken 的名字出现在「仅配置文件」里正是这条 issue
    // 想让人看见的（否则用户不知道它存在），值则一律不出服务端。
    //
    // 默认收起：这是一张核对表，不是日常要看的东西。做只读清单而不是补一批输入框，
    // 也是维护者在 issue 里给的接手口径（「做成只读清单就能先关掉大部分价值」）。
    function ConfigKeysCard({ t }) {
      const [state, setState] = useState({ loading: true, data: null, failed: false });
      const [open, setOpen] = useState(false);
      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/config-keys")
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((j) => { if (!cancelled) setState({ loading: false, data: j, failed: false }); })
          .catch(() => { if (!cancelled) setState({ loading: false, data: null, failed: true }); });
        return () => { cancelled = true; };
      }, []);
      const d = state.data;
      const counts = (d && d.counts) || null;
      const fileOnly = (d && d.fileOnly) || [];
      const undefaulted = (d && d.undefaulted) || [];
      const title = t("memory.settings.configKeys.title");
      const body = state.loading
        ? h("div", { className: "mneme-set-hint" }, "…")
        // 取数失败与「真的没有只读键」必须分开说：把失败画成 0 条，人会以为清单就是空的。
        : state.failed || !counts
          ? h("div", { className: "mneme-set-hint", style: { color: "var(--mneme-danger)" } },
            t("memory.settings.configKeys.loadFailed"))
          : h(react.Fragment, null,
            h("div", { className: "mneme-set-hint", style: { marginTop: 4 } },
              t("memory.settings.configKeys.summary")
                .replace("{schema}", String(counts.schemaLeaf))
                .replace("{panel}", String(counts.panelEditable))
                .replace("{file}", String(counts.fileOnly))
                // 三类的数字必须都来自服务端算出来的桶：写成 schema − panel 会与展开后
                // 「只能改文件」那段对不上（评审 #4452245244），因为 schema 之外还多出
                // 白名单里登记了却没默认值的那几个键。
                .replace("{undefaulted}", String(counts.undefaulted))),
            open && h("div", { style: { marginTop: 10 } },
              // 两段各自的标题也带上条数，收起时只看 summary 就够判断要不要展开。
              h("div", { className: "mneme-featsubhint", style: { marginTop: 2 } },
                t("memory.settings.configKeys.fileOnlyHead")
                  .replace("{n}", String(fileOnly.length))),
              h("div", { className: "mneme-keylist" },
                fileOnly.map((k) => h("code", { key: k, className: "mneme-keychip" }, k))),
              undefaulted.length > 0 && h(react.Fragment, null,
                h("div", { className: "mneme-featsubhint", style: { marginTop: 10 } },
                  t("memory.settings.configKeys.undefaultedHead")
                    .replace("{n}", String(undefaulted.length))),
                h("div", { className: "mneme-keylist" },
                  undefaulted.map((k) => h("code", { key: k, className: "mneme-keychip" }, k))),
                h("div", { className: "mneme-featsubhint", style: { marginTop: 4 } },
                  t("memory.settings.configKeys.undefaultedHint"))
              )
            ),
            h("button", { type: "button", className: "mneme-btn", style: { marginTop: 10 }, onClick: () => setOpen(!open) },
              open ? t("memory.settings.configKeys.hide") : t("memory.settings.configKeys.show"))
          );
      return h("section", { className: "mneme-set-card" },
        h("div", { className: "mneme-set-title" }, title),
        h("div", { className: "mneme-set-desc" }, t("memory.settings.configKeys.desc")),
        body
      );
    }

    // --- Token 去向三屏（2026-10 可观测性改造）---
    // 原 LlmStatusCard 只有一个「LLM 消耗」总数，且 by_source 把两个最大成本项
    // dream_consolidate / dream_summarize 合并成 autoDream（2026-10 审计里巩固
    // 单项就占 37%），「token 花在哪」不可见。这里换成三屏：KPI 带（总量/调用/
    // 巩固占比/待确认冲突）、按组件 donut、按天柱状 + 8 周热力；原 9 张状态卡
    // 降级到折叠区。数据走 getLlmAuditStats 新增的 by_operation / by_day 两个
    // 聚合（后端已排好序，前端按 TOKEN_OPS 恒定顺序取用，不依赖 API 排序）。
    const TOKEN_OPS = [
      "dream_consolidate",
      "summarize_compress",
      "entity_extract",
      "dream_summarize",
      "sleep_pattern",
      "write_admission"
    ];
    const tokenOpLabel = (t, op) => {
      const key = `memory.status.token.op.${op}`;
      const label = t(key);
      return label !== key ? label : String(op);
    };
    const tokenCompact = (n) => {
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
      if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
      return String(n);
    };
    // 热力分档：固定阈值（75万/150万/250万）在低用量库里整片落在 l1，档位失真
    // （复验第三轮「颜色不怎么明显」）。改按 56 天窗口内的非零日做三分位切四档
    // ——GitHub 贡献图同思路，档次随库的实际用量自适应拉开；全零/无数据退化
    // 为全 0 档（不留空档位）。边界是三个分位值（q 只返回 3 个）：n>p75 → l4、
    // >p50 → l3、>p25 → l2、其余非零 → l1，四档都有 populated。
    const heatLevel = (n, q) => (n <= 0 ? 0 : n > q[2] ? 4 : n > q[1] ? 3 : n > q[0] ? 2 : 1);
    const heatQuartiles = (days) => {
      const pos = days.map((d) => d.total).filter((v) => v > 0).sort((a, b) => a - b);
      if (!pos.length) return [0, 0, 0];
      const pick = (p) => pos[Math.min(pos.length - 1, Math.floor(p * pos.length))];
      return [pick(0.25), pick(0.5), pick(0.75)];
    };

    function TokenFlowSection({ t }) {
      const [stats, setStats] = useState(null);
      const [heatStats, setHeatStats] = useState(null);
      // 沉淀曲线（/semantic/consolidation-stats）与 token 审计不同源：前者读
      // memories.created_at / receipt_chain / archived_at，与「花了多少 token」
      // 无关，所以是独立请求、独立 error 位——一个失败不该把另一个图也拖成错误态。
      const [sinkStats, setSinkStats] = useState(null);
      const [sinkError, setSinkError] = useState(false);
      const [statsError, setStatsError] = useState(false);
      // #521 评审：待确认冲突与「上一轮跳过明细」同源（/dream-status），一次请求两用。
      // 跳过明细必须出现在首屏——它原先只挂在折叠区里的 DreamStatusCards 上，而那个
      // 折叠区默认收起、收起时连子卡都不挂载，等于「一整类动作 100% 被拦」仍旧看不见。
      const [conf, setConf] = useState({ loading: true, error: false, pending: 0, skipped: [] });
      const [focusOp, setFocusOp] = useState(null);
      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/semantic/llm-audit/stats?days=7")
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((j) => {
            if (cancelled) return;
            setStats(j && typeof j === "object" ? (j.stats || j) : {});
            setStatsError(false);
          })
          .catch(() => { if (!cancelled) setStatsError(true); });
        // 8 周热力要 56 天窗口，而 days=7 的 by_day 最多只有 8 个 UTC 日期——
        // 复用同一份响应会让 56 格里 48 格恒为 0（自动评审 #412 指出）。两个
        // 窗口各取所需：7 天喂 KPI 与柱状，56 天只喂热力。
        apiFetch("/api/dsh-mneme/semantic/llm-audit/stats?days=56")
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((j) => {
            if (cancelled) return;
            setHeatStats(j && typeof j === "object" ? (j.stats || j) : {});
          })
          .catch(() => { if (!cancelled) setHeatStats({}); });
        // 沉淀曲线同样要 56 天窗口，理由与热力一致（7 天的 by_day 撑不满 8 周）。
        apiFetch("/api/dsh-mneme/semantic/consolidation-stats?days=56")
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((j) => {
            if (cancelled) return;
            setSinkStats(j && typeof j === "object" ? j : {});
          })
          .catch(() => { if (!cancelled) setSinkError(true); });
        // KPI 第 4 格的待确认冲突与 DreamStatusCards 同源（/dream-status），
        // 同样监听 mneme:conflicts-changed 重取（#295），两处计数永不漂移。
        const loadConflicts = () => {
          apiFetch("/api/dsh-mneme/dream-status")
            .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
            .then((d) => {
              if (cancelled) return;
              // #495：这块 KPI 说的是「上一轮巩固跳过了什么」，所以要的是**巩固轮**。
              // organize 回执同样带 skipped，但它的跳过不是巩固决策（例如「与既有
              // 记忆重复」），混进来会让人以为巩固那一整类动作被拦。后端 lastConsolidation
              // 只含 auto/sleep；旧服务端没有该键时退回 lastRun，保持原行为。
              const last = (d && (d.lastConsolidation || d.lastRun)) || null;
              setConf({
                loading: false,
                error: false,
                pending: Number((d && d.pendingConflicts) ?? 0),
                skipped: Array.isArray(last && last.skippedReasons) ? last.skippedReasons : []
              });
            })
            .catch(() => { if (!cancelled) setConf({ loading: false, error: true, pending: 0, skipped: [] }); });
        };
        loadConflicts();
        window.addEventListener("mneme:conflicts-changed", loadConflicts);
        // 通用失效广播：KPI 第 4 格的待确认计数不只随裁决变——涉及冲突的
        // 记忆被删除/恢复也一样，两个事件都听，取数只有一次 GET。
        window.addEventListener("mneme:store-changed", loadConflicts);
        return () => {
          cancelled = true;
          window.removeEventListener("mneme:conflicts-changed", loadConflicts);
          window.removeEventListener("mneme:store-changed", loadConflicts);
        };
      }, []);

      const loading = !stats && !statsError;
      const byOp = stats && Array.isArray(stats.by_operation) ? stats.by_operation : [];
      // 按恒定顺序取行：API 排序变化不影响图例次序；未知操作留到渲染时兜底。
      const ops = TOKEN_OPS.map((op) => {
        const row = byOp.find((r) => r.operation === op);
        return { op, total: Number((row && row.total_tokens) ?? 0) };
      });
      const unknownOps = byOp.filter((r) => !TOKEN_OPS.includes(r.operation));
      const allOps = ops.concat(unknownOps.map((r) => ({ op: r.operation, total: Number(r.total_tokens ?? 0) })));
      const grand = allOps.reduce((a, r) => a + r.total, 0);
      const consolidate = ops[0].total;
      // donut：r=15.9155 让周长≈100，dasharray 直接填百分比；段与段留缝（取
      // 半个百分点与四分之一弧长的较小者），小弧不被缝吃掉。write_admission
      // 的 token 恒 0 是设计（只计量不拦截），自然不画弧，图例仍保留一行。
      let cursor = 0;
      const segs = allOps
        .map((r, i) => {
          const len = grand > 0 ? (r.total / grand) * 100 : 0;
          const gap = Math.min(0.25, len / 4);
          const seg = Math.max(len - gap * 2, 0.4);
          const off = -(cursor + gap);
          cursor += len;
          return { ...r, i, len, seg, off };
        })
        .filter((s) => s.len > 0);
      const opIdx = (op) => {
        const i = TOKEN_OPS.indexOf(op);
        return i >= 0 ? i : Math.max(0, Math.min(allOps.findIndex((r) => r.op === op), 5));
      };
      // 7 天柱状：上限向上取整到整 M，四条网格线按 niceMax/4 等距。
      // by_day 只返回有审计行的日期（SQL 是 GROUP BY，缺日无行），而 since=now-7d
      // 的窗口横跨 8 个 UTC 日期——直接映射会让柱子缺列、横轴不是连续 7 天（自动
      // 评审 #412 指出）。这里以「今天 UTC」为右端补成连续 7 天，缺日填 0；响应还
      // 没到时保持空数组，否则加载态会先画 7 根零高柱子（stats 为 null 与 {} 分属
      // 「未知」与「已知为空」，只有后者该补零）。
      const rawDays = stats && Array.isArray(stats.by_day) ? stats.by_day : null;
      const rawDayMap = new Map((rawDays ?? []).map((d) => [String((d && d.day) ?? ""), Number((d && d.total_tokens) ?? 0)]));
      const endDay = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
      const days = rawDays
        ? Array.from({ length: 7 }, (_, i) => {
            const key = new Date(endDay.getTime() - (6 - i) * 86400000).toISOString().slice(0, 10);
            return { day: key, total: rawDayMap.get(key) ?? 0 };
          })
        : [];
      const dayMax = Math.max(1, ...days.map((d) => d.total));
      const niceMax = Math.max(1e6, Math.ceil(dayMax / 1e6) * 1e6);
      const gridVals = [niceMax, niceMax * 0.75, niceMax * 0.5, niceMax * 0.25];
      // 8 周热力：数据必须来自 56 天窗口（heatStats），右缘对齐该窗口最后一天
      // （UTC），左侧补齐到周一；数据窗口之外的格子隐藏留形。日期一律走 UTC——
      // by_day 的 day 就是 UTC 日期。用 heatStats 而非 stats：否则 56 格里
      // 48 格恒 0。
      const heatDays = (heatStats && Array.isArray(heatStats.by_day) ? heatStats.by_day : []).map((d) => ({
        day: String((d && d.day) ?? ""),
        total: Number((d && d.total_tokens) ?? 0)
      }));
      const heatCells = [];
      if (heatDays.length) {
        const byDayMap = new Map(heatDays.map((d) => [d.day, d.total]));
        const end = new Date(`${heatDays[heatDays.length - 1].day}T00:00:00Z`);
        const start = new Date(end.getTime() - 55 * 86400000);
        for (let i = 0; i < 56; i++) {
          const d = new Date(start.getTime() + i * 86400000);
          const key = d.toISOString().slice(0, 10);
          heatCells.push({ key, total: byDayMap.get(key) ?? 0 });
        }
      }
      // 分档阈值取自本窗口真实分布（见 heatQuartiles 注释），空窗口退化全 0 档。
      const heatQ = heatQuartiles(heatCells);
      // 月份标签：GitHub 同款——按周列贴，列首日期属于哪个月，那列就标那个
      // 月；连续同月的列合并成一段（gridColumn: from / span）。月不在列首
      // 开始时其首列仍标上一月（列首归属优先），这是贡献图的通行近似。
      const monthLabels = (() => {
        if (!heatCells.length) return [];
        const spans = [];
        heatCells.forEach((c, i) => {
          if (i % 7 !== 0) return; // 只看列首
          const ym = c.key.slice(0, 7);
          const col = Math.floor(i / 7) + 1;
          const label = `${Number(ym.slice(5, 7))}月`;
          const lastSpan = spans[spans.length - 1];
          if (lastSpan && lastSpan.key === ym) { lastSpan.last = col; return; }
          spans.push({ key: ym, label, from: col, last: col });
        });
        return spans.map((m) => ({ ...m, span: m.last - m.from + 1 }));
      })();
      // 行标签：行 r 的星期 = (首列星期 + r) % 7（getUTCDay 周日=0）。一/三/五
      // 三行有字（GitHub 同款），其余留空。
      const heatRowLabels = (() => {
        const startDow = heatCells.length ? new Date(`${heatCells[0].key}T00:00:00Z`).getUTCDay() : 0;
        const rows = new Array(7).fill("");
        for (const d of [1, 3, 5]) rows[(d - startDow + 7) % 7] = ["一", "三", "五"][[1, 3, 5].indexOf(d)];
        return rows;
      })();
      // 8 周沉淀：56 天原始序列在热力右侧那条约 220px 的竖列里会细到看不出，
      // 所以按周聚成 8 桶（右端对齐今天 UTC，与 7 天柱状同一套「补连续区间」
      // 口径，缺周填 0）。三条线只画两条——新增与巩固是这张图要表达的剪刀差，
      // 归档数改在图例里给总量（它从 10-12 才开始非零，混进同一坐标会误导）。
      // sinkStats 为 null（未到）与 {}（已知为空）必须分开：前者不画图，后者
      // 画空态，否则加载态会先画 8 根零高柱子。
      const sinkDays = (() => {
        if (!sinkStats) return null;
        const rows = Array.isArray(sinkStats.by_day) ? sinkStats.by_day : [];
        const byDay = new Map(rows.map((d) => [String((d && d.day) ?? ""), d]));
        const out = [];
        for (let w = 7; w >= 0; w--) {
          let added = 0;
          let merged = 0;
          let archived = 0;
          let first = "";
          for (let i = 6; i >= 0; i--) {
            const key = new Date(endDay.getTime() - (w * 7 + i) * 86400000).toISOString().slice(0, 10);
            if (!first) first = key;
            const row = byDay.get(key);
            added += Number((row && row.added) ?? 0);
            merged += Number((row && row.merged) ?? 0);
            archived += Number((row && row.archived) ?? 0);
          }
          out.push({ key: first, added, merged, archived });
        }
        return out;
      })();
      const sinkMax = Math.max(1, ...((sinkDays ?? []).map((d) => d.added)));
      const sinkSum = (field) => (sinkDays ?? []).reduce((a, d) => a + d[field], 0);
      const sinkAddedTotal = sinkSum("added");
      const sinkMergedTotal = sinkSum("merged");
      const sinkArchivedTotal = sinkSum("archived");
      // 巩固/新增的比值取自总量而非逐周：单周可能新增为 0（无分母），总量口径
      // 才是「这个库到底在膨胀还是在巩固」的答案。
      const sinkGap = sinkAddedTotal > 0 ? `${((sinkMergedTotal / sinkAddedTotal) * 100).toFixed(0)}%` : "—";
      const kpi = (title, num, cap) =>
        h(StatusCard, { t, title, loading, error: statsError, num, cap });
      const segClass = (s) =>
        `mneme-seg mneme-seg--${opIdx(s.op) + 1}${focusOp === s.op ? " focused" : ""}`;
      const rowProps = (op) => ({
        className: focusOp && focusOp !== op ? "mneme-legendrow dim" : focusOp === op ? "mneme-legendrow focused" : "mneme-legendrow",
        onMouseEnter: () => setFocusOp(op),
        onMouseLeave: () => setFocusOp(null)
      });

      return h(react.Fragment, null,
        h("div", { className: "mneme-statushead" }, t("memory.status.sec.token")),
        h("div", { className: "mneme-kpiband" },
          kpi(
            t("memory.status.token.total"),
            Number((stats && stats.total_tokens) ?? 0).toLocaleString(),
            `${t("memory.status.token.in")} ${Number((stats && stats.input_tokens) ?? 0).toLocaleString()} · ${t("memory.status.token.out")} ${Number((stats && stats.output_tokens) ?? 0).toLocaleString()}`
          ),
          kpi(t("memory.status.token.calls"), Number((stats && stats.total_calls) ?? 0).toLocaleString(), t("memory.status.token.callsCap")),
          kpi(
            t("memory.status.token.share"),
            grand > 0 ? `${((consolidate / grand) * 100).toFixed(1)}%` : "0.0%",
            t("memory.status.token.shareFoot").replace("{n}", consolidate.toLocaleString())
          ),
          h(StatusCard, {
            t,
            title: t("memory.status.token.conflicts"),
            loading: conf.loading,
            error: conf.error,
            num: conf.pending.toLocaleString(),
            cap: t("memory.status.token.conflictsFoot")
          })
        ),
        h(SkippedReasonsNotice, { t, buckets: conf.skipped, loading: conf.loading, error: conf.error }),
        h("div", { className: "mneme-tokenflow" },
          h("h3", { className: "mneme-xcolhead" }, t("memory.status.token.donut")),
          statsError
            ? h("div", { className: "mneme-statuscap", style: { color: "var(--mneme-danger)" } }, t("memory.status.error"))
            : h("div", { className: "mneme-donutwrap" },
                h("div", { className: "mneme-donutbox" },
                  h("svg", {
                    className: focusOp ? "mneme-donut has-focus" : "mneme-donut",
                    viewBox: "0 0 42 42",
                    "aria-hidden": "true"
                  },
                    h("g", { transform: "rotate(-90 21 21)" },
                      segs.map((s) => h("circle", {
                        key: s.op,
                        className: segClass(s),
                        cx: 21,
                        cy: 21,
                        r: 15.9155,
                        "stroke-dasharray": `${s.seg.toFixed(2)} ${(100 - s.seg).toFixed(2)}`,
                        "stroke-dashoffset": s.off.toFixed(2)
                      }))
                    )
                  ),
                  h("div", { className: "mneme-donut-center" },
                    h("b", null, tokenCompact(grand)),
                    h("span", null, t("memory.status.token.last7"))
                  )
                ),
                h("div", { className: "mneme-legend" },
                  allOps.map((r) => h("div", Object.assign({ key: r.op }, rowProps(r.op)),
                    h("span", { className: `mneme-legenddot mneme-dot--${opIdx(r.op) + 1}` }),
                    h("span", { className: "mneme-legendname" }, tokenOpLabel(t, r.op)),
                    r.op === "write_admission"
                      ? h("span", { className: "mneme-legendsub" }, t("memory.status.token.meterOnly"))
                      : null,
                    h("span", { className: "mneme-legendval" }, r.total.toLocaleString()),
                    h("span", { className: "mneme-legendpct" },
                      grand > 0 ? `${((r.total / grand) * 100).toFixed(1)}%` : "0.0%")
                  ))
                )
              ),
          h("h3", { className: "mneme-xcolhead" }, t("memory.status.token.days")),
          h("div", { className: "mneme-bars" },
            gridVals.map((v, i) => h("div", { key: v, className: "mneme-gridline", style: { top: `${i * 25}%` } },
              h("span", { className: "mneme-gridlabel" }, `${(v / 1e6).toFixed(0)}M`)
            )),
            h("div", { className: "mneme-barcols" },
              days.map((d) => h("div", { className: "mneme-barcol", key: d.day },
                h("div", {
                  className: "mneme-bar",
                  style: { height: `${Math.max((d.total / niceMax) * 100, 0.4)}%` },
                  title: `${d.day} · ${d.total.toLocaleString()}`
                })
              ))
            )
          ),
          h("div", { className: "mneme-barlabels" },
            days.map((d) => h("span", { key: d.day }, d.day.slice(5)))
          ),
          // 热力与沉淀并排两列：热力只有约 745px，右侧原本整块空着。两列
          // 在窄容器里回落单列（见 .mneme-flowrow 的 @container）。
          h("div", { className: "mneme-flowrow" },
            h("div", { className: "mneme-flowheat" },
              h("h3", { className: "mneme-xcolhead" }, t("memory.status.token.heat")),
              // 月份行与格子列同用列主序网格对齐：每月占的列数 = 该月在这个
              // 56 天窗口里的列数（按列的起始日期算），标签只在该列起点画一次。
              h("div", { className: "mneme-heatmonths" },
                monthLabels.map((m) => h("span", { key: m.key, style: { gridColumn: `${m.from} / span ${m.span}` } }, m.label))
              ),
              h("div", { className: "mneme-heatwrap" },
                h("div", { className: "mneme-heatrows", "aria-hidden": "true" },
                  heatRowLabels.map((d, i) => h("span", { key: i }, d))
                ),
                h("div", { className: "mneme-heatgrid" },
                  heatCells.map((c) => h("div", {
                    key: c.key,
                    className: heatLevel(c.total, heatQ) ? `mneme-heatcell l${heatLevel(c.total, heatQ)}` : "mneme-heatcell",
                    title: `${c.key} · ${c.total.toLocaleString()}`
                  }))
                )
              ),
              h("div", { className: "mneme-heatlegend" },
                h("span", null, t("memory.status.token.heatLess")),
                h("span", { className: "mneme-heatcell" }),
                [1, 2, 3, 4].map((lv) => h("span", { key: lv, className: `mneme-heatcell l${lv}` })),
                h("span", null, t("memory.status.token.heatMore"))
              )
            ),
            h("div", { className: "mneme-flowsink" },
              h("h3", { className: "mneme-xcolhead" }, t("memory.status.token.sink")),
              sinkError
                ? h("div", { className: "mneme-statuscap", style: { color: "var(--mneme-danger)" } }, t("memory.status.error"))
                : !sinkDays
                  // 未到：什么都不画。画空态会把「还没加载完」说成「最近没有记录」。
                  ? null
                  : sinkAddedTotal + sinkMergedTotal + sinkArchivedTotal === 0
                  ? h("div", { className: "mneme-statuscap", style: { marginTop: "12px" } }, t("memory.status.token.sinkEmpty"))
                  : h("div", { className: "mneme-sinkchart" },
                      (sinkDays ?? []).map((d) => h("div", { className: "mneme-sinkcol", key: d.key },
                        // 两根柱同一基准（本期最大新增），高度差就是剪刀差本身；
                        // 巩固可能远小于新增，故给 1px 下限免得整根消失。
                        h("div", {
                          className: "mneme-sinkbar mneme-sinkbar--added",
                          style: { height: `${Math.max((d.added / sinkMax) * 100, d.added > 0 ? 1 : 0)}%` },
                          title: `${d.key} · ${t("memory.status.token.sinkAdded")} ${d.added}`
                        }),
                        h("div", {
                          className: "mneme-sinkbar mneme-sinkbar--merged",
                          style: { height: `${Math.max((d.merged / sinkMax) * 100, d.merged > 0 ? 1 : 0)}%` },
                          title: `${d.key} · ${t("memory.status.token.sinkMerged")} ${d.merged}`
                        })
                      ))
                    ),
              sinkDays && !sinkError
                ? h("div", { className: "mneme-sinklabels" },
                    sinkDays.map((d) => h("span", { key: d.key }, d.key.slice(5)))
                  )
                : null,
              // 图例只在有数据时给：加载中把三个 0 画出来等于谎报「最近没东西进库」。
              sinkDays && !sinkError
                ? h("div", { className: "mneme-sinklegend" },
                    h("span", null, `${t("memory.status.token.sinkAdded")} `, h("b", null, sinkAddedTotal.toLocaleString())),
                    h("span", null, `${t("memory.status.token.sinkMerged")} `, h("b", null, sinkMergedTotal.toLocaleString())),
                    h("span", null, `${t("memory.status.token.sinkArchived")} `, h("b", null, sinkArchivedTotal.toLocaleString())),
                    h("span", null, `${t("memory.status.token.sinkGap")} `, h("b", null, sinkGap))
                  )
                : null,
              h("div", { className: "mneme-statuscap", style: { marginTop: "6px", fontSize: "11px" } }, t("memory.status.token.sinkFoot"))
            )
          )
        )
      );
    }

    // #521 评审：跳过明细只留一份实现。它原先只挂在折叠区里的 DreamStatusCards 上，
    // 而那个折叠区默认收起、收起时连子卡都不挂载——首屏照样看不出「一整类动作 100%
    // 被拦」，等于把 #521 的病换个地方犯。现在由 TokenFlowSection 的 KPI 带下方渲染，
    // 折叠区不再重复一份。
    function SkippedReasonsNotice({ t, buckets, loading, error }) {
      const list = Array.isArray(buckets) ? buckets : [];
      if (loading || error || list.length === 0) return null;
      const total = list.reduce((sum, b) => sum + (Number(b.count) || 0), 0);
      return h("div", { className: "mneme-statuscard", style: { borderColor: "var(--mneme-warn)" } },
        h("div", { className: "mneme-statusnum", style: { fontSize: "16px", lineHeight: "24px" } },
          t("memory.status.skippedTitle").replace("{n}", String(total))),
        h("div", { className: "mneme-statuscap", style: { marginBottom: "6px" } }, t("memory.status.skippedHint")),
        h("ul", { style: { margin: 0, paddingLeft: "18px", fontSize: "12px", lineHeight: "18px" } },
          list.slice(0, 4).map((bucket, i) =>
            h("li", { key: i, style: { color: "var(--mneme-fg-dim)" } },
              (bucket.action ? bucket.action + " · " : "") + bucket.reason + " ×" + String(bucket.count)))),
        list.length > 4
          ? h("div", { className: "mneme-statuscap", style: { marginTop: "6px" } },
              t("memory.status.skippedMore").replace("{n}", String(list.length - 4)))
          : null
      );
    }
    // 巩固状态卡（×2）：最近一次 autoDream 运行 + 待确认冲突计数。数据来自
    // /dream-status，一次取回两张卡共用；失败只影响这两张卡自身。
    // showConflicts=false 用于 2026-10 改造后的降级折叠区：待确认冲突已升入
    // KPI 带，这里不再重复渲染冲突卡，只留最近运行卡。
    function DreamStatusCards({ t, onGotoQueue, showConflicts = true }) {
      const [state, setState] = useState({ loading: true, error: false, lastRun: null, lastConsolidation: null, pending: 0 });
      useEffect(() => {
        let cancelled = false;
        const loadOnce = () => {
          apiFetch("/api/dsh-mneme/dream-status")
            .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
            .then((d) => {
              if (cancelled) return;
              setState({
                loading: false,
                error: false,
                lastRun: (d && d.lastRun) || null,
                lastConsolidation: (d && d.lastConsolidation) || null,
                pending: Number((d && d.pendingConflicts) ?? 0)
              });
            })
            .catch(() => { if (!cancelled) setState({ loading: false, error: true, lastRun: null, lastConsolidation: null, pending: 0 }); });
        };
        loadOnce();
        // #295 评审：裁决完成后队列会广播 mneme:conflicts-changed，这里重取
        // 计数，状态卡的「待确认冲突」不再停留旧值。涉及冲突的记忆被删除/
        // 恢复同样改变计数，通用失效广播一并听。
        window.addEventListener("mneme:conflicts-changed", loadOnce);
        window.addEventListener("mneme:store-changed", loadOnce);
        return () => {
          cancelled = true;
          window.removeEventListener("mneme:conflicts-changed", loadOnce);
          window.removeEventListener("mneme:store-changed", loadOnce);
        };
      }, []);
      // #495：这张卡的标题是「最近巩固」，取数就该是巩固轮，而不是 runs[0]。
      // organize 与巩固共用 dream_runs，一次 agent 主动整理会写两行（dryRun 报告 +
      // apply 回执），把它顶到首位后这张卡就变成「整理回执」了。
      // 卡面数字只认巩固轮：lastConsolidation 由后端排除 organize 后取一条。旧服务端
      // 没有这个键时退回 lastRun，但退回的那条若是 organize 就仍然不算「最近巩固」。
      const organizedOnly = state.lastRun && state.lastRun.run_type === "organize" ? state.lastRun : null;
      const run = state.lastConsolidation
        || (state.lastRun && !organizedOnly ? state.lastRun : null);
      const num = run ? formatRelativeTime(run.created_at, t) : t("memory.status.dreamNever");
      // issue 给的两条路里选「标注」：最近一次后台运行是 organize 时，用脚注点名它，
      // 而不是把它从审计面抹掉。它没有挤掉巩固数（卡面仍是巩固轮），只是补一句说明
      // ——否则读者会以为整理就是那次巩固。
      const organizeFoot = organizedOnly && !run
        ? t("memory.status.dreamOrganizeOnly").replace("{time}", formatRelativeTime(organizedOnly.created_at, t))
        : null;
      const cap = run
        ? `${run.status || "—"}${run.model ? ` · ${run.model}` : ""}`
        // 只有 organize 跑过时不能沿用 offList 那句「已关闭：巩固…」——autoDream 可能
        // 开着，只是还没轮到。这时只留脚注说明最近那一条是什么。
        : organizeFoot ? null : t("memory.settings.mode.offList");
      // #178：pending>0 时冲突卡可激活（role=button + 可聚焦 + 回车/空格），
      // 激活直达队列——StatusPanel 把 onGotoQueue 传进来（一步 prop，无线程）。
      const pending = state.pending > 0;
      const gotoQueue = () => { if (pending && onGotoQueue) onGotoQueue(); };
      // #521 的跳过明细不在这里渲染：它已提到 TokenFlowSection 的 KPI 带下方，
      // 首屏可见。这张卡在折叠区里，展开后再重复一遍只会让人以为有两批跳过。
      return h(react.Fragment, null,
        h(StatusCard, { t, title: t("memory.status.dream"), loading: state.loading, error: state.error, num, cap, foot: organizeFoot }),
        showConflicts
          ? h("div", {
              role: pending ? "button" : undefined,
              tabIndex: pending ? 0 : undefined,
              "aria-label": pending ? t("memory.status.conflictQueue.goto") : undefined,
              className: pending ? "mneme-conflict-jump" : undefined,
              style: pending ? { cursor: "pointer" } : undefined,
              onClick: pending ? gotoQueue : undefined,
              onKeyDown: pending ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); gotoQueue(); } } : undefined
            },
              h(StatusCard, {
                t,
                title: t("memory.status.conflicts"),
                loading: state.loading,
                error: state.error,
                num: state.pending.toLocaleString(),
                cap: t("memory.status.conflictsHint")
              })
            )
          : null
      );
    }

    // #182 注入状态卡：极简模式下宿主按设计压制全部注入（#175 定论），这里
    // 主动提示，把「为什么没注入」从逐帧解压日志降为看一眼状态页。只在
    // suppressed=true 时渲染——standard 会话与 preset 未知的宿主零打扰。
    function InjectStatusCard({ t }) {
      const state = useInjectStatus();
      if (state.loading || !state.suppressed) return null;
      return h("div", { className: "mneme-statuscard", style: { borderColor: "var(--mneme-warn)" } },
        h("div", { className: "mneme-statusnum", style: { fontSize: "16px", lineHeight: "24px" } }, t("memory.status.injectSuppressed")),
        h("div", { className: "mneme-statuscap" }, t("memory.status.injectSuppressedHint"))
      );
    }

    // --- 注入预览（issue #179，状态页）---------------------------------------
    // 展示最近一帧 prompt 组装注入了什么：条目构成（类型/标题/重要性/字符数）、
    // hot memory 与总体积、当前生效参数（maxItems/threshold/自适应/scope/轮换）。
    // 数据来自 /inject-preview 的旁路快照——就是上次真实渲染用的同一份候选，
    // 不二次检索。无快照（autoInject 关/新会话/旧宿主）整卡退化为「暂无预览」。
    function InjectPreviewCard({ t }) {
      const [snap, setSnap] = useState(null);
      const [loading, setLoading] = useState(true);
      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/inject-preview")
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((j) => { if (!cancelled) { setSnap(j && j.snapshot); setLoading(false); } })
          .catch(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
      }, []);
      if (loading) return null;
      if (!snap) {
        return h("div", { className: "mneme-statuscard" },
          h("h3", { className: "mneme-xcolhead" }, t("memory.status.injectPreview")),
          h("div", { className: "mneme-statuscap" }, t("memory.status.injectPreviewNone"))
        );
      }
      // 参数改用指标行呈现：maxItems/threshold 这类裸键名换成白话标签，
      // 查询串这类背景信息放脚注。
      const rows = [
        { label: t("memory.status.injectPreview.maxItems"), value: String(snap.maxItems) },
        { label: t("memory.status.injectPreview.threshold"), value: String(snap.threshold) },
        snap.adaptive ? { label: t("memory.status.injectPreview.adaptiveOn"), value: "✓" } : null,
        snap.scoped
          ? { label: t("memory.status.injectPreview.scope"), value: snap.scoped.agent_scope || snap.scoped.workspace_scope }
          : null,
        snap.rotated > 0 ? { label: t("memory.status.injectPreview.rotated"), value: String(snap.rotated) } : null,
        snap.hotChars > 0
          ? { label: t("memory.status.injectPreview.hot"), value: `${snap.hotChars}${t("memory.status.injectPreview.charsUnit")}` }
          : null,
        { label: t("memory.status.injectPreview.chars"), value: `${snap.totalChars}${t("memory.status.injectPreview.charsUnit")}` }
      ].filter(Boolean);
      const foot = snap.query
        ? t("memory.status.injectPreview.query").replace("{query}", snap.query.slice(0, 24))
        : null;
      return h("div", { className: "mneme-statuscard mneme-statuscard--wide" },
        h("h3", { className: "mneme-xcolhead" }, t("memory.status.injectPreview")),
        h("div", { className: "mneme-statrows" },
          rows.map((r, i) => h("div", { className: "mneme-statrow", key: i },
            h("span", null, r.label),
            h("span", { className: "mneme-statrowval", title: String(r.value) }, String(r.value))))),
        foot ? h("div", { className: "mneme-statfoot" }, foot) : null,
        h("div", { style: { marginTop: 10 } },
          (snap.entries || []).length === 0
            ? h("div", { className: "mneme-statuscap" }, t("memory.status.injectPreview.empty"))
            : (snap.entries || []).map((m) => h("div", { key: m.id, style: { display: "flex", gap: 8, alignItems: "baseline", fontSize: 12, padding: "2px 0" } },
                h("span", { className: "mneme-xcolhead" }, typeLabel(t, m.type)),
                h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, m.title || "—"),
                h("span", { className: "mneme-xcolhead" },
                  h(StarGlyph, { size: 11 }),
                  ` ${m.importance ?? "—"} · ${m.chars}${t("memory.status.injectPreview.charsUnit")}`))))
      );
    }

    // --- 冲突集中处理队列（v0.8.0，状态页）---------------------------------
    // 此前冻结冲突只有计数与散落徽章，resolveConflictPending 无任何调用方——
    // 这里是第一处理入口：并排展示双方内容 + reason，人工选保留方后走
    // POST /conflicts/resolve（service 端按 dream 非冻结 conflict 同款处置）。
    // 队列为空时整块不渲染（不打扰无冲突实例）。
    function ConflictsQueue({ t }) {
      const [items, setItems] = useState(null);
      // Issue #603 第 3 层：服务端一直返回 { items, total }，这里此前把 total 丢掉、
      // 请求也不带 limit —— 面板列 50 条而徽章显示 60，第 51–60 条既翻不到也没有
      // 任何提示（「假成功」）。total 现在存下来，items.length < total 时明说
      // 「已显示 X/Y」，并一次请求取满服务端上限 200。
      const [total, setTotal] = useState(null);
      const [loadError, setLoadError] = useState(false);
      const [busy, setBusy] = useState(false);
      // 展开态按冲突条目记（一对两侧同时展开，便于逐行对照）；复制态按
      // 「条目:侧别」记，避免一次复制把别的按钮也点亮。
      const [openItems, setOpenItems] = useState({});
      const [copiedKey, setCopiedKey] = useState(null);
      const toggleItem = (id) => setOpenItems((prev) => ({ ...prev, [id]: !prev[id] }));
      const copySide = (key, content) => {
        navigator.clipboard?.writeText(String(content || "")).then(
          () => { setCopiedKey(key); announce(t("memory.status.conflictQueue.copiedSide")); setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500); },
          () => {}
        );
      };
      const load = (silent) => {
        // limit=200 = 服务端 Math.min(200, ...) 的上限（lib/api.js 的 conflicts 路由）。
        apiFetch("/api/dsh-mneme/conflicts?limit=200")
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((d) => {
            setItems(d.items || []);
            setTotal(typeof d.total === "number" ? d.total : null);
            setLoadError(false);
            if (!silent) announce(t("memory.status.conflictQueue.refreshed"));
          })
          // #295 评审：加载失败 ≠ 没有冲突——错误态渲染错误卡而不是空态教育卡，
          // 不能让 500 把「暂时看不到」伪装成「没有冲突」。
          .catch(() => { setItems([]); setTotal(null); setLoadError(true); });
      };
      useEffect(() => { load(); }, []);
      // 参与记忆在别处被删除/编辑时（通用失效广播），队列联表出的那一侧会失真
      // ——重取，宁可多一次 GET 也不把「已失联」装成「还在」。
      useEffect(() => {
        const onChanged = () => load(true);
        window.addEventListener("mneme:store-changed", onChanged);
        return () => window.removeEventListener("mneme:store-changed", onChanged);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      // #177：空队列不再整块消失——空态教育卡要渲染（原 return null 已移除）。
      if (!items) return null;
      const resolve = (id, winner) => {
        if (busy) return;
        setBusy(true);
        // #178：裁决结果经 live region 播报（纯视觉刷新读屏不可感知）
        const it = (items || []).find((x) => x.id === id) || {};
        apiFetch("/api/dsh-mneme/conflicts/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, winner, apply: winner !== null })
        })
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then(() => {
            announce(t("memory.status.conflictQueue.resolved").replace("{name}",
              (winner === "a" ? (it.memory_a && it.memory_a.title) : winner === "b" ? (it.memory_b && it.memory_b.title) : "") || ""));
            // #295 评审：裁决改变了 pending 总数——DreamStatusCards 只在挂载时
            // 读一次 dream-status，不广播的话状态卡停留在旧计数。同页两个组件
            // 用一个 window 事件对齐（比提升状态到 StatusPanel 少动三处）。
            try { window.dispatchEvent(new CustomEvent("mneme:conflicts-changed")); } catch { /* 非浏览器环境 */ }
            // 裁决会归档败者、给胜者追加已否决注记——记忆列表、实体页、归档
            // 工作台的数据全变了，走通用失效广播让它们立刻重取（用户反馈：
            // 以前要关面板重开才能看到裁决落地）。
            broadcastStoreChanged("conflict-resolve");
            load(true);
          })
          .catch(() => {})
          .finally(() => setBusy(false));
      };
      const side = (s, label, sideClass, ops, diffSide, open, itemKey) => h("div", { className: `mneme-conflict-side ${sideClass}` },
        h("div", { className: "mneme-conflict-sidelabel" }, label),
        s.missing
          ? h("div", { className: "mneme-conflict-missing" }, t("memory.status.conflictQueue.missing"))
          : h(react.Fragment, null,
              h("div", { className: "mneme-conflict-sidetitle", title: s.title }, s.title || "…"),
              // 判读依据行：类型 / 重要度 / 字数 / 新旧 + 单侧全文复制。报障者
              // 「只好两个都删或胡乱选」的直接原因是这一行了无信息——只有
              // A 方/B 方两个标签，看不出哪条更新、哪条更长、哪条更重要。
              h("div", { className: "mneme-conflict-meta" },
                h("span", { className: "mneme-conflict-metaval" }, typeLabel(t, s.type)),
                s.importance !== null && s.importance !== undefined
                  ? h("span", null, t("memory.status.conflictQueue.importance").replace("{n}", String(s.importance)))
                  : null,
                h("span", null, t("memory.status.conflictQueue.chars").replace("{n}", String((s.content || "").length))),
                h("span", null, (s.updated_at ? t("memory.status.conflictQueue.updated") : t("memory.status.conflictQueue.created"))
                  .replace("{time}", formatRelativeTime(s.updated_at || s.created_at, t))),
                h("button", {
                  className: "mneme-footbtn",
                  onClick: () => copySide(`${itemKey}:${diffSide}`, s.content)
                }, copiedKey === `${itemKey}:${diffSide}`
                  ? t("memory.status.conflictQueue.copiedSide")
                  : t("memory.status.conflictQueue.copySide"))),
              // #177：词级 diff 可用（LCS 无损对齐成功）时用高亮视图替代纯文本。
              // 侧别过滤（#295 评审修正）：A 侧渲染 same+del（它被删的部分高亮），
              // B 侧渲染 same+ins（它新增的部分高亮）——每列忠实于自己的原文。
              // title 提示颜色语义；diff 不可用时保留原 snippet。
              // 展开态：diff 去掉 4 行钳制、纯文本不再截 140 字（改走 pre-wrap 滚动区）。
              ops
                ? h("div", {
                    className: open ? "mneme-conflict-diff mneme-conflict-diff--full" : "mneme-conflict-diff",
                    title: t("memory.status.conflictQueue.diffTitle")
                  },
                    ops.map((o, k) => {
                      if (o.kind === "same") return o.text;
                      if (o.kind === "del" && diffSide === "a") {
                        return h("span", { key: k, className: "mneme-conflict-mark mneme-conflict-mark--del" }, o.text);
                      }
                      if (o.kind === "ins" && diffSide === "b") {
                        return h("span", { key: k, className: "mneme-conflict-mark mneme-conflict-mark--ins" }, o.text);
                      }
                      return null; // 对侧的编辑片段不出现在本列
                    }))
                : h("div", { className: open ? "mneme-conflict-text" : "mneme-conflict-snippet" },
                    open ? (s.content || "") : (s.content || "").slice(0, 140)),
              // #177：预裁决阶段两侧都还活着——「已归档」徽章换成「冻结中」，
              // 原注销记说明（applyHint）挪进 tooltip，不再整段占一行动态区。
              h("span", {
                className: "mneme-badge mneme-badge--frozen",
                title: `${t("memory.status.conflictQueue.frozenTitle")} ${t("memory.status.conflictQueue.applyHintTitle")}`
              }, t("memory.status.conflictQueue.frozenBadge")))
      );
      // #177：相似度优先取服务端新落列的值（#603 第 2 层）；老行与 LLM 裁决
      // 路径没有该列 → 回落到从 reason 文本回收。回收不到就返回 null，绝不
      // 显示编造的数字。
      // 防误报：只认「相似度 0.87 / similarity 0.87」这类锚定短语，不在全文里
      // 捞数字（否则 reason 里的年份、条数都会被当成相似度）。
      const similarityOf = (it) => {
        if (typeof it.similarity === "number" && it.similarity >= 0 && it.similarity <= 1) return it.similarity;
        const m = /(?:相似度|similarity)\s*([01](?:\.\d+)?)/i.exec(String(it.reason || ""));
        const v = m ? Number(m[1]) : NaN;
        return v >= 0 && v <= 1 ? v : null;
      };
      const shown = items.length;
      const hidden = typeof total === "number" && total > shown ? total - shown : 0;
      return h("div", { className: "mneme-conflictq" },
        h("div", { className: "mneme-conflictq-head" },
          h("span", { className: "mneme-xcount" }, t("memory.status.conflicts")),
          // Issue #603 第 3 层：截断必须说出来。此前 50/60 的差额只体现在徽章
          // 数字上，列表本身看不出少了东西。
          hidden > 0
            ? h("span", { className: "mneme-conflictq-truncated" },
                t("memory.status.conflictQueue.truncated").replace("{shown}", String(shown)).replace("{total}", String(total)))
            : null,
          h("button", { className: "mneme-footbtn", onClick: () => load() },
            h(Icon, { name: "refresh", size: 12 }), t("memory.status.conflictQueue.refresh"))),
        // #177 空态教育卡：队列没有条目时也渲染（整块此前直接 return null），
        // 解释「什么情况会产生冲突、冻结是什么」——新用户第一次遇见冻结时
        // 状态页已有解释在等他。加载失败时显示错误卡而不是空态卡。
        items.length === 0 && (loadError
          ? h("div", { className: "mneme-conflict-empty", role: "alert" },
              h("div", { className: "mneme-conflict-empty-title" }, t("memory.status.error")))
          : h("div", { className: "mneme-conflict-empty" },
              h("div", { className: "mneme-conflict-empty-title" }, t("memory.status.conflictQueue.emptyTitle")),
              h("div", { className: "mneme-conflict-empty-body" }, t("memory.status.conflictQueue.emptyBody")))),
        items.map((it) => {
          const sim = similarityOf(it);
          const open = openItems[it.id] === true;
          const aText = (it.memory_a && it.memory_a.content) || "";
          const bText = (it.memory_b && it.memory_b.content) || "";
          // diff 与相似度条互补：reason 给不出数字时才跑 LCS（两者表达同一信息）。
          const diff = (sim === null && !it.memory_a.missing && !it.memory_b.missing)
            ? wordDiff(aText, bText) : null;
          return h("div", { key: it.id, className: "mneme-conflict-item" },
          it.reason && h("div", { className: "mneme-conflict-reason" },
            `${t("memory.status.conflictQueue.reason")}: ${it.reason}`),
          sim !== null && h("div", { className: "mneme-conflict-simrow" },
            h("span", null, t("memory.status.conflictQueue.similarity")),
            h("span", { className: "mneme-conflict-simbar" },
              h("span", { className: "mneme-conflict-simfill", style: { width: `${Math.round(sim * 100)}%` } })),
            h("span", null, `${Math.round(sim * 100)}%`)),
          h("div", { className: "mneme-conflict-pair" },
            side(it.memory_a, t("memory.status.conflictQueue.sideA"), "mneme-conflict-side--a", diff, "a", open, it.id),
            side(it.memory_b, t("memory.status.conflictQueue.sideB"), "mneme-conflict-side--b", diff, "b", open, it.id)),
          h("div", { className: "mneme-conflict-actions" },
            h("span", { className: "mneme-conflict-hint", title: t("memory.status.conflictQueue.applyHintTitle") },
              t("memory.status.conflictQueue.applyHint")),
            h("button", {
              className: "mneme-footbtn",
              "aria-expanded": open,
              onClick: () => toggleItem(it.id)
            }, t(open ? "memory.status.conflictQueue.collapse" : "memory.status.conflictQueue.expand")),
            h("button", { className: "mneme-conflict-primary", disabled: busy, "aria-label": `${t("memory.status.conflictQueue.keepA")}: ${(it.memory_a && it.memory_a.title) || ""}`, onClick: () => resolve(it.id, "a") }, t("memory.status.conflictQueue.keepA")),
            h("button", { className: "mneme-conflict-primary", disabled: busy, "aria-label": `${t("memory.status.conflictQueue.keepB")}: ${(it.memory_b && it.memory_b.title) || ""}`, onClick: () => resolve(it.id, "b") }, t("memory.status.conflictQueue.keepB")),
            h("button", { className: "mneme-footbtn", disabled: busy, onClick: () => resolve(it.id, null) }, t("memory.status.conflictQueue.markReviewed"))));
        }));
    }

    // --- 状态页工作台：让用户切实看见插件在干活 ---
    // 活动流合并 llm_audit 里 autoDream/autoSummarize 的后台调用（状态、
    // token、沉淀条数）；沉淀记忆列表用 audit 行携带的 related_memory_ids
    // 对照最近列表解析出标题；归档列表走 /list?archived=only，「恢复」经
    // POST /update {archived:false} 送回主列表。
    function parseRelatedIds(v) {
      if (Array.isArray(v)) return v;
      if (typeof v === "string") {
        try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
      }
      return [];
    }

    function WorkbenchSection({ t, onBrowse }) {
      const [feed, setFeed] = useState(null); // audit rows（已过滤巩固/总结）
      const [deposited, setDeposited] = useState(null); // 沉淀记忆首页（服务端 deposited 视图）
      const [depositedTotal, setDepositedTotal] = useState(0);
      const [archived, setArchived] = useState(null); // 归档记忆首页
      const [archivedTotal, setArchivedTotal] = useState(0);
      const [restoring, setRestoring] = useState("");
      const [wbReload, setWbReload] = useState(0);

      const load = useCallback(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/semantic/llm-audit?pageSize=12")
          .then((r) => (r.ok ? r.json() : { items: [] }))
          .then((d) => {
            if (cancelled) return;
            setFeed((d.items || []).filter((r) =>
              r.trigger_source === "autoDream" || r.trigger_source === "autoSummarize"));
          })
          .catch(() => { if (!cancelled) setFeed([]); });
        // 仪表盘数据源：沉淀/归档各取一小页 + 服务端 total（/list 的 total
        // 与行同过滤）。长列表不再进状态页——「查看全部」跳记忆库的筛选
        // 视图，查询收敛到有搜索/分页的地方。
        apiFetch("/api/dsh-mneme/list?deposited=only&limit=8&order=chrono")
          .then((r) => (r.ok ? r.json() : { items: [], total: 0 }))
          .then((d) => {
            if (cancelled) return;
            setDeposited(d.items || []);
            setDepositedTotal(d.total || 0);
          })
          .catch(() => { if (!cancelled) setDeposited([]); });
        apiFetch("/api/dsh-mneme/list?archived=only&limit=3&order=chrono")
          .then((r) => (r.ok ? r.json() : { items: [], total: 0 }))
          .then((d) => {
            if (cancelled) return;
            setArchived(d.items || []);
            setArchivedTotal(d.total || 0);
          })
          .catch(() => { if (!cancelled) setArchived([]); });
        return () => { cancelled = true; };
      }, [wbReload]);
      useEffect(() => { load(); }, [load]);
      // 工作台三份列表（活动流/沉淀/归档）都读库：别处改库（裁决/删除/导入…）
      // 广播过来就整组重取——此前只有本组件自己的恢复按钮会刷新它。
      useEffect(() => {
        const onChanged = () => setWbReload((k) => k + 1);
        window.addEventListener("mneme:store-changed", onChanged);
        return () => window.removeEventListener("mneme:store-changed", onChanged);
      }, []);

      const restore = (id) => {
        setRestoring(id);
        apiFetch("/api/dsh-mneme/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, archived: false })
        })
          .then((r) => { if (!r.ok) throw new Error("http"); })
          .then(() => {
            setArchived((cur) => (cur || []).filter((m) => m.id !== id));
            setArchivedTotal((n) => Math.max(0, n - 1));
            // 恢复让行回到主列表：记忆页与实体页不知道这次 /update，广播让它们重取。
            broadcastStoreChanged("memory-restore");
          })
          .catch(() => {})
          .finally(() => setRestoring(""));
      };

      const statusLabel = (s) => s === "error"
        ? t("memory.status.failed")
        : s === "skipped" ? t("memory.status.skipped") : t("memory.status.success");
      const triggerLabel = (s) => s === "autoDream"
        ? t("memory.status.dreamConsolidate") : t("memory.status.summarize");

      return h(react.Fragment, null,
        h("div", { className: "mneme-wbhead" }, t("memory.status.workbench")),
        feed === null
          ? h("div", { className: "mneme-featsubhint" }, "…")
          : feed.length === 0
            ? h("div", { className: "mneme-featsubhint" }, t("memory.status.emptyFeed"))
            : h("div", { className: "mneme-wblist" },
                feed.map((row) => {
                  const n = parseRelatedIds(row.related_memory_ids).length;
                  return h("div", { className: "mneme-wbrow", key: row.id ?? row.timestamp },
                    h("span", { className: row.status === "error" ? "mneme-wbdot mneme-wbdot--err" : "mneme-wbdot", "aria-hidden": "true" }),
                    h("div", { className: "mneme-wbmain" },
                      h("div", { className: "mneme-wbtitle" },
                        `${triggerLabel(row.trigger_source)} · ${statusLabel(row.status)}`),
                      h("div", { className: "mneme-wbsub" },
                        formatRelativeTime(row.timestamp, t),
                        n > 0 && ` · ${t("memory.status.deposited").replace("{n}", String(n))}`,
                        row.total_tokens ? ` · ${t("memory.status.tokens").replace("{n}", Number(row.total_tokens).toLocaleString())}` : "",
                        row.error_message ? ` · ${row.error_message}` : "")
                    ));
                })),
        deposited !== null && depositedTotal > 0 && h(react.Fragment, null,
          h("div", { className: "mneme-wbhead" },
            h("span", null, t("memory.status.depositedCount").replace("{n}", String(depositedTotal))),
            onBrowse && depositedTotal > deposited.length && h("button", {
              type: "button",
              className: "mneme-footbtn",
              onClick: () => onBrowse({ deposited: true })
            }, t("memory.status.viewAll"))),
          h("div", { className: "mneme-wblist" },
            deposited.map((m) => h("div", { className: "mneme-wbmemo", key: m.id },
              h("span", { className: "mneme-xdot", style: { color: memoryTypeColor(m.type) }, "aria-hidden": "true" }),
              h("div", { className: "mneme-wbmemo-main" },
                h("div", { className: "mneme-wbtitle" }, m.title || (m.content || "").slice(0, 40)),
                h("div", { className: "mneme-wbsub" },
                  `${typeLabel(t, m.type)} · ${formatRelativeTime(m.updated_at || m.created_at, t)}`))
              )))),
        archived !== null && h(react.Fragment, null,
          h("div", { className: "mneme-wbhead" },
            h("span", null, t("memory.status.archivedCount").replace("{n}", String(archivedTotal))),
            onBrowse && archivedTotal > archived.length && h("button", {
              type: "button",
              className: "mneme-footbtn",
              onClick: () => onBrowse({ archived: true })
            }, t("memory.status.viewAll"))),
          archived.length === 0
            ? h("div", { className: "mneme-featsubhint" }, t("memory.status.archivedEmpty"))
            : h("div", { className: "mneme-wblist" },
                archived.map((m) => h("div", { className: "mneme-wbmemo", key: m.id },
                  h("span", { className: "mneme-xdot", style: { color: memoryTypeColor(m.type) }, "aria-hidden": "true" }),
                  h("div", { className: "mneme-wbmemo-main" },
                    h("div", { className: "mneme-wbtitle" }, m.title || (m.content || "").slice(0, 40)),
                    h("div", { className: "mneme-wbsub" },
                      `${typeLabel(t, m.type)} · ${formatRelativeTime(m.updated_at || m.created_at, t)}`)),
                  h("button", {
                    type: "button",
                    className: "mneme-btn",
                    disabled: restoring === m.id,
                    onClick: () => restore(m.id)
                  }, t("memory.status.restore"))
                ))))
      );
    }

    // 热度分布卡（阶段二）：采样最近 200 条的 heat 值做三档分布。自门控——
    // /list 不下发 heat（heatEnabled=false）时整卡不渲染，前端不感知开关。
    function HeatStatusCard({ t }) {
      const [state, setState] = useState({ loading: true, off: false, hot: 0, warm: 0, cold: 0, sample: 0 });
      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/list?limit=200&order=chrono")
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((d) => {
            if (cancelled) return;
            const items = d.items || [];
            if (!items.length || typeof items[0].heat !== "number") {
              setState({ loading: false, off: true, hot: 0, warm: 0, cold: 0, sample: 0 });
              return;
            }
            let hot = 0, warm = 0, cold = 0;
            for (const m of items) {
              if (m.heat >= 0.66) hot++; else if (m.heat >= 0.33) warm++; else cold++;
            }
            setState({ loading: false, off: false, hot, warm, cold, sample: items.length });
          })
          .catch(() => { if (!cancelled) setState({ loading: false, off: true, hot: 0, warm: 0, cold: 0, sample: 0 }); });
        return () => { cancelled = true; };
      }, []);
      if (state.off) return null;
      // 三档占比用堆叠条直接画出来（一眼读出分布），数字退到指标行；大数字
      // 不再放「热门数」——它曾被误读成总数。
      const total = state.hot + state.warm + state.cold;
      const tiers = [
        ["--hot", state.hot, t("memory.status.heat.hot")],
        ["--warm", state.warm, t("memory.status.heat.warm")],
        ["--cold", state.cold, t("memory.status.heat.cold")]
      ];
      return h("div", { className: "mneme-statuscard" },
        h("h3", { className: "mneme-xcolhead" }, t("memory.status.heatDistribution")),
        state.loading
          ? h("div", { className: "mneme-statusnum" }, "…")
          : h(react.Fragment, null,
              total > 0 && h("div", { className: "mneme-heatbar" },
                tiers.map(([tier, n]) => h("span", {
                  key: tier,
                  className: `mneme-heatbar-seg mneme-heatbar${tier}`,
                  style: { flexGrow: n }
                }))),
              h("div", { className: "mneme-statrows" },
                tiers.map(([tier, n, label]) => h("div", { className: "mneme-statrow", key: tier },
                  h("span", { style: { display: "flex", alignItems: "center", gap: 6 } },
                    h("span", { className: `mneme-heatdot mneme-heatdot${tier}`, "aria-hidden": "true" }),
                    label),
                  h("span", { className: "mneme-statrowval" }, String(n))))),
              h("div", { className: "mneme-statfoot" },
                t("memory.status.heat.sample").replace("{sample}", String(state.sample)))
            ));
    }

    // 记忆复用卡（#217）：只读聚合 /recall-stats（Top-N 召回 + 僵尸率 +
    // 覆盖度）。自门控——接口失败、窗口内无任何回执（earliestRunAt=null，
    // 口径不可信）或库为空时整卡不渲染，前端不感知；truncated（扫描超上限）
    // 只影响 hint 里的回执计数，不挡渲染。
    function RecallStatsCard({ t }) {
      const [state, setState] = useState({ loading: true, off: false, rate: null, zombie: 0, active: 0, exempt: 0, runs: 0, top: "", inject: "", archive: "" });
      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/recall-stats?window=30")
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((d) => {
            if (cancelled) return;
            const z = d.zombie || {};
            // 归档侧第五指标（#275）不能只靠 run/active 两路撑整张卡：整库归档是它的正常
            // 工作状态，那种库「窗口内没有召回回执、也没有活跃僵尸行」时若 hasData 为假，
            // 组件直接走 off 分支 return null，归档指标永远没机会显示。
            const hasData = (d.coverage?.runsScanned ?? 0) > 0 || (z.activeCount ?? 0) > 0
              || (d.archive?.total ?? 0) > 0;
            if (!hasData) {
              setState({ loading: false, off: true });
              return;
            }
            const rate = z.rate == null ? null : Math.round((1 - z.rate) * 100) + "%";
            const top = (d.topRecalled || []).slice(0, 3)
              .map((m) => (m.title || "").slice(0, 12))
              .join(" · ");
            // 注入口径（#217 增量）：窗口内无注入行（旧数据/关闭落账）时整段省略
            const inj = d.injection || {};
            const inject = (inj.runs ?? 0) > 0
              ? t("memory.status.recallInject")
                .replace("{runs}", String(inj.runs))
                .replace("{count}", String(inj.injectedCount ?? 0))
                .replace("{fill}", inj.slotFillRate == null ? "—" : String(Math.round(inj.slotFillRate * 100)))
              : "";
            // 第五指标（#275）：归档净增速率 + 可压掉行数。与注入口径同款自门控
            // ——归档区为空时整段省略，不往卡里塞一个恒 0 的数字。
            const ar = d.archive || {};
            const archive = (ar.total ?? 0) > 0
              ? t("memory.status.recallArchive")
                .replace("{total}", String(ar.total ?? 0))
                .replace("{add}", String(ar.perDay ?? 0))
                .replace("{compress}", String(ar.compressible?.rows ?? 0))
              : "";
            setState({
              loading: false, off: false, rate,
              zombie: z.zombieCount ?? 0, active: z.activeCount ?? 0,
              exempt: z.exemptCount ?? 0, runs: d.coverage?.runsScanned ?? 0, top, inject, archive
            });
          })
          .catch(() => { if (!cancelled) setState({ loading: false, off: true }); });
        return () => { cancelled = true; };
      }, []);
      if (state.off) return null;
      // 大数字保留复用率；其余指标拆成一行一条，不再用「·」串成散文。
      const rows = [
        {
          label: t("memory.status.recall.zombie"),
          value: `${state.zombie}/${state.active}（${t("memory.status.recall.exempt")} ${state.exempt}）`
        },
        { label: t("memory.status.recall.runs"), value: String(state.runs) },
        state.top && state.top !== "—" ? { label: t("memory.status.recall.top"), value: state.top } : null,
        state.inject ? { label: t("memory.status.recall.inject"), value: state.inject } : null,
        state.archive ? { label: t("memory.status.recall.archive"), value: state.archive } : null
      ].filter(Boolean);
      return h(StatusCard, {
        t,
        title: t("memory.status.recallStats"),
        loading: state.loading,
        error: false,
        num: state.rate ?? "—",
        rows,
        // 引擎区五张卡是奇数：复用卡信息量最大，宽容器下跨两列补齐行尾空洞
        className: "mneme-statuscard--wide"
      });
    }

    // #619 可见化 C：情绪归因一览。
    // 为什么单开一栏而不是塞进实体页：实体页是「从这个人往外看」，而这里要回答的是
    // 「这个库一共记住了我哪些情绪」——反向、全局的一眼。塞进实体页得先选一个实体，
    // 用户心里还没那个人。
    //
    // 三种状态严格分开，别让任何一种冒充另一种：
    //   loading  还没回来
    //   error    请求失败（500 / 网络），面板明说「不等于没有记录」
    //   empty    真的一条都没有，并且说清要怎么才会有
    // 这三件事在用户眼里完全不同，混成一个空列表是最容易犯也最伤人的糊弄。
    function AffectivePanel({ t }) {
      const [state, setState] = useState({ loading: true, error: false, items: [], totalEdges: 0, skippedEdges: 0, truncated: false });
      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/semantic/graph/affective?limit=200")
          .then((res) => {
            if (!res.ok) throw new Error(`http ${res.status}`);
            return res.json();
          })
          .then((j) => {
            if (cancelled) return;
            setState({
              loading: false,
              error: false,
              items: Array.isArray(j.items) ? j.items : [],
              totalEdges: j.totalEdges || 0,
              skippedEdges: j.skippedEdges || 0,
              truncated: j.truncated === true
            });
          })
          .catch(() => {
            // 失败就报失败。这里绝不能退化成空 items —— 那会让「上游挂了」
            // 长得和「你还没记过情绪」一模一样，用户会以为功能没用。
            if (!cancelled) setState({ loading: true, error: true, items: [], totalEdges: 0, skippedEdges: 0, truncated: false });
          });
        return () => { cancelled = true; };
      }, []);

      if (state.loading && !state.error) {
        return h("div", { className: "mneme-set" },
          h("div", { className: "mneme-set-inner" }, h("div", { className: "mneme-affective-empty", role: "status" }, t("memory.affective.loading"))));
      }
      if (state.error) {
        // role=alert：这是需要用户知道的一次失败，不是背景噪声。
        return h("div", { className: "mneme-set" },
          h("div", { className: "mneme-set-inner" },
            h("div", { className: "mneme-affective-empty mneme-affective-empty--error", role: "alert" }, t("memory.affective.error"))));
      }

      const rows = state.items.map((it, i) => {
        const isTrait = it.attribution === "trait";
        const bits = [];
        if (isTrait) {
          const n = it.traitSessionCount ?? it.sessionCount;
          if (Number.isFinite(n)) bits.push(t("memory.affective.sessions").replace("{n}", String(n)));
        } else if (Number.isFinite(it.sessionCount) && it.sessionCount > 1) {
          bits.push(t("memory.affective.sessions").replace("{n}", String(it.sessionCount)));
        }
        if (Number.isFinite(it.evidenceCount) && it.evidenceCount > 0) {
          bits.push(t("memory.affective.evidence").replace("{n}", String(it.evidenceCount)));
        }
        if (it.lastSeen) bits.push(t("memory.affective.lastSeen").replace("{time}", formatRelativeTime(it.lastSeen)));
        return h("div", { className: isTrait ? "mneme-affective-row mneme-affective-row--trait" : "mneme-affective-row", key: `${it.personId}-${it.targetId}-${it.emotion}-${it.attribution}-${i}` },
          h("div", { className: "mneme-affective-main" },
            h("span", { className: "mneme-affective-emotion" }, it.emotion),
            h("span", { className: "mneme-affective-arrow" }, "·"),
            h("span", { className: "mneme-affective-target" }, it.target ?? "?"),
            h("span", { className: isTrait ? "mneme-affective-tag mneme-affective-tag--trait" : "mneme-affective-tag" },
              isTrait ? t("memory.affective.trait") : t("memory.affective.occasion"))
          ),
          bits.length ? h("div", { className: "mneme-affective-meta" }, bits.join(" · ")) : null
        );
      });

      return h("div", { className: "mneme-set" },
        h("div", { className: "mneme-set-inner" },
          h("div", { className: "mneme-affective-head" },
            h("div", { className: "mneme-affective-title" }, t("memory.affective.title")),
            h("div", { className: "mneme-affective-sub" }, t("memory.affective.sub"))
          ),
          state.items.length === 0
            ? h("div", { className: "mneme-affective-empty", role: "status" }, t("memory.affective.empty"))
            : h("div", { className: "mneme-affective-list" }, rows),
          // 截断与跳过都要说出来：读者看到「就这些」时，得知道是自己没记够，
          // 还是这一页只放了这么多。
          state.truncated ? h("div", { className: "mneme-affective-note" }, t("memory.affective.truncated").replace("{n}", String(state.totalEdges))) : null,
          state.skippedEdges > 0 ? h("div", { className: "mneme-affective-note" }, t("memory.affective.skipped").replace("{n}", String(state.skippedEdges))) : null
        )
      );
    }

    function StatusPanel({ t, onBrowse }) {
      // #178：冲突卡键盘直达——激活后把焦点与视口带到队列块。
      const queueRef = useRef(null);
      const gotoQueue = () => {
        if (!queueRef.current) return;
        queueRef.current.setAttribute("tabindex", "-1");
        queueRef.current.focus({ preventScroll: true });
        if (queueRef.current.scrollIntoView) queueRef.current.scrollIntoView({ block: "start", behavior: "smooth" });
      };
      // 折叠区受控开合：收起时不挂载子卡，10 张卡各自的请求一次都不发——
      // 展开才是「我要看后台细节」的明确信号，首屏只承担 Token 三屏的开销。
      const [legacyOpen, setLegacyOpen] = useState(false);
      return h("div", { className: "mneme-status" },
        h(TokenFlowSection, { t }),
        h("details", {
          className: "mneme-legacy",
          open: legacyOpen
        },
          // 开合挂在 summary 上而非 details：details 上的 onClick 会连折叠区里
          // 子卡片的点击一起吃掉（preventDefault 拦掉冒泡上来的激活事件），
          // 而 summary 是浏览器原生的开合把手，点它以外的地方不该切换（自动
          // 评审 #412 指出）。
          h("summary", { onClick: (e) => { e.preventDefault(); setLegacyOpen(!legacyOpen); } }, t("memory.status.token.detail")),
          legacyOpen ? h(react.Fragment, null,
            // 分组标题把九张卡拆成「库内一览 / 后台运转」两段扫读单元
            h("div", { className: "mneme-statushead" }, t("memory.status.sec.overview")),
            h("div", { className: "mneme-statusgrid mneme-statusgrid--overview" },
              h(MemoriesStatusCard, { t }),
              h(EntitiesStatusCard, { t }),
              h(VectorStatusCard, { t }),
              h(MirrorHealthCard, { t }),
              h(CapacityCard, { t })
            ),
            h("div", { className: "mneme-statushead" }, t("memory.status.sec.engine")),
            h("div", { className: "mneme-statusgrid" },
              h(DreamStatusCards, { t, showConflicts: false }),
              h(HeatStatusCard, { t }),
              h(RecallStatsCard, { t }),
              h(InjectStatusCard, { t }),
              h(InjectPreviewCard, { t })
            )
          ) : null
        ),
        h("div", { className: "mneme-statushead" }, t("memory.status.sec.maintenance")),
        h("div", { className: "mneme-statusgrid" }, h(MaintenanceCard, { t })),
        h("div", { ref: queueRef }, h(ConflictsQueue, { t })),
        h(WorkbenchSection, { t, onBrowse })
      );
    }


    // --- 详情抽屉 ---
    // 右侧滑出：全文、来源、质量分、关联实体与手动操作（编辑/归档/删除）。
    // 编辑态本地暂存草稿，保存经 POST /update 落库；后端成功后重渲染镜像，
    // 前端只做本地视图同步。两步删除确认在此完成（红钮武装 → 实心红提交）。
    // v0.8.1 底座（issue #170）：scope 行的来源徽注（显式/自动）。存量行无来源
    // 时不加后缀——与 A4 的「未标注零视觉变化」同款克制。
    const scopeSourceSuffix = (t, source) =>
      source === "explicit" ? ` · ${t("memory.explorer.detail.scopeSourceExplicit")}`
        : source === "auto" ? ` · ${t("memory.explorer.detail.scopeSourceAuto")}`
        : "";
    const scopeProvenanceTitle = (t, source, decidedAt) =>
      [
        source === "explicit" ? t("memory.explorer.detail.scopeSourceExplicit")
          : source === "auto" ? t("memory.explorer.detail.scopeSourceAuto") : null,
        decidedAt ?? null
      ].filter(Boolean).join(" · ");

    function MemoryDrawer({ t, memory, conflict, deleting, deleteError, onClose, onDelete, onSaved, onUndone }) {
      const [editing, setEditing] = useState(false);
      const [title, setTitle] = useState(memory.title || "");
      const [content, setContent] = useState(memory.content || "");
      const [importance, setImportance] = useState(memory.importance || 3);
      // v0.8.1 底座（issue #170）：scope 归属的人工修正入口。空串=放宽到全局
      // （发送 null），非空=收窄到该标签；只有真的改动才会随 patch 发送并盖
      // explicit 章——普通编辑不得污染归属来源。
      const [agentScope, setAgentScope] = useState(memory.agent_scope || "");
      const [workspaceScope, setWorkspaceScope] = useState(memory.workspace_scope || "");
      const [confirmWiden, setConfirmWiden] = useState(false);
      const [confirmDelete, setConfirmDelete] = useState(false);
      const [busy, setBusy] = useState(false);
      const [savedTick, setSavedTick] = useState(false);
      const [saveError, setSaveError] = useState(false);
      const [copied, setCopied] = useState(false);
      const [entities, setEntities] = useState(null);
      // #512：这条记忆的归因——窗口级（哪一段原文蒸出来的）与行级（哪一轮铸造的）。
      // null = 还没读到（或读失败），两者要分得开，不能被当成「没有归因」。
      // 这个 state 必须住在**读它的那个组件**里：加归因区块时它曾被误放进
      // EntityPanel（同文件的上一个组件），于是 MemoryDrawer 的 effect 与渲染块
      // 引用到一个不存在的绑定，一开抽屉就 ReferenceError 把整个 renderer 带走
      // （issue #553）。同名 state 落在隔壁组件里，静态扫描与 review 都不容易看出来。
      const [provenance, setProvenance] = useState(null); // null = still loading
      // 整包退出的两段：先干跑清点（点按钮那一发），再确认物删。撤是**物理删除**不是归档
      // （归档行仍占 share_external_id 的 UNIQUE 位，撤了会导不回来，理由在
      // src/share-import.js 的 deleteSharePack），所以这里比删除那条路多一站清点。
      const [undoPreview, setUndoPreview] = useState(null);
      const [undoBusy, setUndoBusy] = useState(false);
      const [undoError, setUndoError] = useState(false);
      // 确认那一发却回干跑时唯一出声的一格（见 undoPack 的注释）。
      const [undoStillDry, setUndoStillDry] = useState(false);

      useEffect(() => {
        let cancelled = false;
        apiFetch(`/api/dsh-mneme/memories/entities?memoryId=${encodeURIComponent(memory.id)}`)
          .then((res) => (res.ok ? res.json() : { entities: [] }))
          .then((d) => { if (!cancelled) setEntities(d.entities || []); })
          .catch(() => { if (!cancelled) setEntities([]); });
        return () => { cancelled = true; };
      }, [memory.id]);

      // #512：归因单独取一次。读失败/未开启时保持 null——「没读到」不等于
      // 「没有归因」，界面上不能把这两件事显示成同一句话。
      useEffect(() => {
        let cancelled = false;
        setProvenance(null);
        apiFetch("/api/dsh-mneme/memory/provenance?id=" + encodeURIComponent(memory.id))
          .then((res) => (res.ok ? res.json() : null))
          .then((d) => {
            if (cancelled) return;
            if (d && Array.isArray(d.windows) && Array.isArray(d.mints)) setProvenance(d);
          })
          .catch(() => { if (!cancelled) setProvenance(null); });
        return () => { cancelled = true; };
      }, [memory.id]);

      const postUpdate = (patch, opts) => {
        setBusy(true);
        setSaveError(false);
        apiFetch("/api/dsh-mneme/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: memory.id, ...patch })
        })
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((d) => {
            onSaved(d.memory, opts);
            setEditing(false);
            announce(t("memory.explorer.detail.saved"));
            setSavedTick(true);
            setTimeout(() => setSavedTick(false), 2000);
          })
          .catch(() => setSaveError(true))
          .finally(() => setBusy(false));
      };

      const undoPack = (confirm) => {
        setUndoBusy(true);
        setUndoError(false);
        setUndoStillDry(false);
        apiFetch("/api/dsh-mneme/receive/undo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // 不带 confirm 就是干跑：第一发只清点，第二发才删。packId 只从行上取
          // （面板行带这个字段是因为「收起这个包」按 pack_id 整批删），面板不自己拼也不猜。
          body: JSON.stringify(confirm
            ? { packId: memory.share_pack_id, confirm: true }
            : { packId: memory.share_pack_id })
        })
          .then(async (res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((d) => {
            // 只认答复的 dry_run，**不按「我点的是哪一颗」推断**：确认那一发如果回 dry_run:true
            // （服务端与面板版本不一致的形态），悄悄把预览重画一遍就等于「按了删除却没删也不说」
            // ——接收弹层那一侧修过同一个形状，这里不许退回去。
            if (d.dry_run === false) onUndone(d.deleted ?? 0);
            else {
              setUndoPreview(d);
              if (confirm) setUndoStillDry(true);
            }
          })
          .catch(() => setUndoError(true))
          .finally(() => setUndoBusy(false));
      };

      const save = () => {
        const t2 = title.trim();
        if (!t2) return;
        const patch = { title: t2, content, importance };
        const curAgent = memory.agent_scope ?? "";
        const curWorkspace = memory.workspace_scope ?? "";
        const nextAgent = agentScope.trim();
        const nextWorkspace = workspaceScope.trim();
        const agentChanged = nextAgent !== curAgent;
        const workspaceChanged = nextWorkspace !== curWorkspace;
        if (agentChanged) patch.agent_scope = nextAgent || null;
        if (workspaceChanged) patch.workspace_scope = nextWorkspace || null;
        // 放宽可见性（标注→全局）必须显式确认（issue #170 的安全阀）：
        // 第一次点保存只弹确认，再次点「确认放宽」才真正落库。
        const widening = (curAgent && agentChanged && !nextAgent)
          || (curWorkspace && workspaceChanged && !nextWorkspace);
        if (widening && !confirmWiden) {
          setConfirmWiden(true);
          return;
        }
        setConfirmWiden(false);
        postUpdate(patch, {});
      };

      return h("aside", { className: "mneme-drawer", "aria-label": t("memory.explorer.detail") },
        h("div", { className: "mneme-drawerbar" },
          h("span", { className: "mneme-drawertype" },
            h("span", { className: "mneme-xdot", style: { color: memoryTypeColor(memory.type) }, "aria-hidden": "true" }),
            typeLabel(t, memory.type)
          ),
          conflict && h("span", { className: "mneme-badge mneme-badge--conflict" }, "⚠ ", t("memory.explorer.conflictBadge")),
          h("button", {
            type: "button",
            className: "mneme-footbtn",
            style: { marginLeft: "auto" },
            "aria-label": t("memory.explorer.detail.closeAria"),
            title: t("memory.explorer.detail.closeAria"),
            onClick: onClose
          }, "✕")
        ),
        h("div", { className: "mneme-drawerbody" },
          editing
            ? h(react.Fragment, null,
                h("div", { className: "mneme-xcolhead", style: { padding: "0 0 4px" } }, t("memory.explorer.detail.editTitle")),
                h("input", { className: "mneme-drawertitle-input", value: title, onChange: (e) => setTitle(e.target.value) }))
            : h("div", { className: "mneme-drawertitle" }, memory.title || t("memory.panel.empty")),
          h("div", { className: "mneme-dmeta" },
            h("span", { className: "mneme-dmetakey" }, t("memory.explorer.importance")),
            editing
              ? h("div", { className: "mneme-staredit", role: "radiogroup", "aria-label": t("memory.explorer.detail.editImportance") },
                  [1, 2, 3, 4, 5].map((n) => h("button", {
                    key: n,
                    type: "button",
                    role: "radio",
                    "aria-checked": String(importance === n),
                    "aria-label": t("memory.explorer.detail.starLabel").replace("{n}", String(n)),
                    className: importance >= n ? "mneme-starbtn mneme-starbtn--on" : "mneme-starbtn",
                    onClick: () => setImportance(n)
                  }, h(StarGlyph, { size: 15, filled: importance >= n }))))
              : h(ImportanceStars, { className: "mneme-dmetaval", value: memory.importance || 0 }),
            memory.heat != null && h(react.Fragment, null,
              h("span", { className: "mneme-dmetakey" }, t("memory.explorer.heat")),
              h("span", { className: "mneme-dmetaval" }, h(HeatBadge, { value: memory.heat, size: 13 }))),
            memory.source && h(react.Fragment, null,
              h("span", { className: "mneme-dmetakey" }, t("memory.explorer.source")),
              h("span", { className: "mneme-dmetaval", title: memory.source }, memory.source)),
            memory.occurred_at && h(react.Fragment, null,
              h("span", { className: "mneme-dmetakey" }, t("memory.explorer.detail.occurred")),
              h("span", { className: "mneme-dmetaval", title: memory.occurred_at }, formatDateShort(memory.occurred_at))),
            // v0.8.1 底座：scope 行双态——查看态展示归属 + 来源徽注（显式声明的
            // 「全局」也渲染，不再因 NULL 而隐身）；编辑态为文本框（留空=全局）。
            (editing || memory.agent_scope || memory.agent_scope_source === "explicit") && h(react.Fragment, null,
              h("span", { className: "mneme-dmetakey" }, t("memory.explorer.detail.agentScope")),
              editing
                ? h("input", {
                    type: "text",
                    className: "mneme-select",
                    style: { height: 26, fontSize: 12, justifySelf: "start", width: "100%" },
                    value: agentScope,
                    placeholder: t("memory.explorer.detail.scopeGlobal"),
                    title: t("memory.explorer.detail.scopeEditHint"),
                    onChange: (e) => setAgentScope(e.target.value)
                  })
                : h("span", {
                    className: "mneme-dmetaval",
                    title: scopeProvenanceTitle(t, memory.agent_scope_source, memory.scope_decided_at) || memory.agent_scope
                  }, (memory.agent_scope ?? t("memory.explorer.detail.scopeGlobal")) + scopeSourceSuffix(t, memory.agent_scope_source))),
            (editing || memory.workspace_scope || memory.workspace_scope_source === "explicit") && h(react.Fragment, null,
              h("span", { className: "mneme-dmetakey" }, t("memory.explorer.detail.workspaceScope")),
              editing
                ? h("input", {
                    type: "text",
                    className: "mneme-select",
                    style: { height: 26, fontSize: 12, justifySelf: "start", width: "100%" },
                    value: workspaceScope,
                    placeholder: t("memory.explorer.detail.scopeGlobal"),
                    title: t("memory.explorer.detail.scopeEditHint"),
                    onChange: (e) => setWorkspaceScope(e.target.value)
                  })
                : h("span", {
                    className: "mneme-dmetaval",
                    title: scopeProvenanceTitle(t, memory.workspace_scope_source, memory.scope_decided_at) || memory.workspace_scope
                  }, (memory.workspace_scope ?? t("memory.explorer.detail.scopeGlobal")) + scopeSourceSuffix(t, memory.workspace_scope_source))),
            memory.sensitivity && h(react.Fragment, null,
              h("span", { className: "mneme-dmetakey" }, t("memory.explorer.detail.sensitivity")),
              h("span", { className: "mneme-dmetaval", title: memory.sensitivity }, memory.sensitivity)),
            memory.quality_score != null && h(react.Fragment, null,
              h("span", { className: "mneme-dmetakey" }, t("memory.explorer.detail.quality")),
              h("span", { className: "mneme-dmetaval" }, String(memory.quality_score))),
            h("span", { className: "mneme-dmetakey" }, t("memory.explorer.created")),
            h("span", { className: "mneme-dmetaval", title: formatDate(memory.created_at) }, formatDateShort(memory.created_at)),
            h("span", { className: "mneme-dmetakey" }, t("memory.explorer.updated")),
            h("span", { className: "mneme-dmetaval", title: formatDate(memory.updated_at) },
              `${formatRelativeTime(memory.updated_at, t)}（${formatDateShort(memory.updated_at)}）`),
            // 包号给人核对：与 `dsh-mneme undo-share <包文件>` 用的是同一个 pack_id，
            // 两条路撤的是同一批行。
            memory.share_pack_id && h(react.Fragment, null,
              h("span", { className: "mneme-dmetakey" }, t("memory.explorer.foreignPack")),
              h("span", { className: "mneme-dmetaval", title: memory.share_pack_id }, memory.share_pack_id)),
            Array.isArray(memory.tags) && memory.tags.length > 0 && h(react.Fragment, null,
              h("span", { className: "mneme-dmetakey" }, t("memory.explorer.tags")),
              h("span", { className: "mneme-dmetaval" }, memory.tags.join(" · ")))
          ),
          entities !== null && h(react.Fragment, null,
            h("div", { className: "mneme-xcolhead", style: { padding: "16px 0 0" } }, t("memory.explorer.detail.entities")),
            entities.length === 0
              ? h("div", { className: "mneme-featsubhint", style: { marginTop: 4 } }, t("memory.explorer.detail.entitiesEmpty"))
              : h("div", { className: "mneme-dentities" },
                  entities.map((e, i) => h("span", { key: `${e.name}-${i}`, className: "mnementity-chip" },
                    h("span", { className: "mneme-xdot", style: { color: typeColor(e.type) }, "aria-hidden": "true" }),
                    e.name
                  )))),
          provenance !== null && h(react.Fragment, null,
            h("div", { className: "mneme-xcolhead", style: { padding: "16px 0 0" } }, t("memory.explorer.detail.provenance")),
            (provenance.windows.length === 0 && provenance.mints.length === 0)
              ? h("div", { className: "mneme-featsubhint", style: { marginTop: 4 } }, t("memory.explorer.detail.provenanceEmpty"))
              : h("div", { className: "mneme-dmeta" },
                  provenance.mints.map((m, i) => h(react.Fragment, { key: "mint-" + m.run_id + "-" + i },
                    h("span", { className: "mneme-dmetakey" }, t("memory.explorer.detail.provenanceMint")),
                    h("span", { className: "mneme-dmetaval", title: m.run_id },
                      [m.run_type, m.trigger_source, formatDateShort(m.created_at)].filter(Boolean).join(" · ")))),
                  provenance.windows.map((w, i) => h(react.Fragment, { key: "win-" + w.session_id + "-" + w.seq_start + "-" + i },
                    h("span", { className: "mneme-dmetakey" }, t("memory.explorer.detail.provenanceWindow")),
                    h("span", { className: "mneme-dmetaval", title: w.session_id },
                      [w.session_id + " · seq " + w.seq_start + "–" + w.seq_end,
                       w.distill_run_id
                         ? [w.run_type, w.run_status].filter(Boolean).join(" / ")
                         : t("memory.explorer.detail.provenanceNoRun"),
                       t("memory.explorer.detail.provenanceRecords").replace("{n}", String(w.records ? w.records.length : 0))
                      ].join(" · ")))))
          ),
          editing && h("div", { className: "mneme-xcolhead", style: { padding: "16px 0 4px" } }, t("memory.explorer.detail.editContent")),
          editing
            ? h("textarea", { className: "mneme-dcontent-input", value: content, onChange: (e) => setContent(e.target.value) })
            : h("div", { className: "mneme-dcontent" }, memory.content)
        ),
        h("div", { className: "mneme-dactions" },
          editing
            ? h(react.Fragment, null,
                confirmWiden
                  ? h(react.Fragment, null,
                      h("span", { style: { fontSize: 12, color: "var(--mneme-warn)" } },
                        t("memory.explorer.detail.scopeWidenHint")),
                      h("button", { type: "button", className: "mneme-btn mneme-btndangerconfirm", disabled: busy, onClick: save },
                        t("memory.explorer.detail.scopeWidenConfirm")),
                      h("button", { type: "button", className: "mneme-btn", disabled: busy, onClick: () => setConfirmWiden(false) },
                        t("memory.explorer.cancel"))
                    )
                  : h("button", { type: "button", className: "mneme-btn", disabled: busy, onClick: save }, t("memory.explorer.detail.save")),
                h("button", {
                  type: "button",
                  className: "mneme-btn",
                  disabled: busy,
                  onClick: () => {
                    setEditing(false);
                    setTitle(memory.title || "");
                    setContent(memory.content || "");
                    setImportance(memory.importance || 3);
                    setAgentScope(memory.agent_scope || "");
                    setWorkspaceScope(memory.workspace_scope || "");
                    setConfirmWiden(false);
                  }
                }, t("memory.explorer.detail.cancel")),
                savedTick && h("span", { className: "mneme-saved" }, t("memory.explorer.detail.saved")),
                saveError && h("span", { style: { fontSize: 12, color: "var(--mneme-danger)" } }, t("memory.explorer.detail.archiveFailed"))
              )
            : h(react.Fragment, null,
                h("button", { type: "button", className: "mneme-btn", onClick: () => setEditing(true) }, t("memory.explorer.detail.edit")),
                memory.archived
                  ? h("button", { type: "button", className: "mneme-btn", disabled: busy, onClick: () => postUpdate({ archived: false }, { restored: true }) },
                      t("memory.explorer.detail.restore"))
                  : h("button", { type: "button", className: "mneme-btn", disabled: busy, onClick: () => postUpdate({ archived: true }, { archived: true }) },
                      t("memory.explorer.detail.archive")),
                h("button", {
                  type: "button",
                  className: "mneme-btn",
                  onClick: () => {
                    navigator.clipboard?.writeText(memory.content || "").then(
                      () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
                      () => {}
                    );
                  }
                }, copied ? t("memory.explorer.copied") : t("memory.explorer.copy")),
                confirmDelete
                  ? h(react.Fragment, null,
                      h("button", { type: "button", className: "mneme-btn mneme-btndangerconfirm", disabled: deleting, onClick: () => onDelete(memory.id) },
                        t("memory.explorer.confirmDelete")),
                      h("button", { type: "button", className: "mneme-btn", onClick: () => setConfirmDelete(false) },
                        t("memory.explorer.cancel"))
                    )
                  : h("button", { type: "button", className: "mneme-btn mneme-btndanger", onClick: () => setConfirmDelete(true) },
                      t("memory.explorer.delete")),
                deleteError && h("span", { style: { fontSize: 12, color: "var(--mneme-danger)" } },
                  t("memory.explorer.deleteFailed")),
                memory.share_pack_id && h(react.Fragment, null,
                  undoPreview
                    ? (undoPreview.deleted ?? 0) === 0
                      // 「这个包已经不在本库里了」是她真正需要的那一句，而不是
                      // 「将删除 0 条 + 一颗确认删除 0 条的键」——后者真实但没用。
                      ? h("span", { style: { fontSize: 12, color: "var(--mneme-warn)" } },
                          t("memory.explorer.undoPackGone"))
                      : h(react.Fragment, null,
                        h("span", { style: { fontSize: 12, color: "var(--mneme-warn)" } },
                          t("memory.explorer.undoPackPreview").replace("{n}", String(undoPreview.deleted ?? 0))),
                        // sample 是**清点时**的前 20 条（{type,title}，序为 updated_at DESC），
                        // deleted 是这一笔真带走几行。两个数并发下可以差一条，谁也不是对方的
                        // 依据（src/share-import.js 的 deleteSharePack 那段），所以这里只把
                        // sample 当「我要收起的到底是哪一批」的核对清单，不参与条数。
                        // 清单形状走 TypeRowList：接收弹层的撞名清单与它是同一个形状，
                        // 第三份手写 .map 就是第三处会各自漂移的地方。
                        TypeRowList({ t, rows: undoPreview.sample }),
                        h("button", { type: "button", className: "mneme-btn mneme-btndangerconfirm", disabled: undoBusy, onClick: () => undoPack(true) },
                          t("memory.explorer.undoPackConfirm").replace("{n}", String(undoPreview.deleted ?? 0))),
                        // 取消回到「一颗干净的收起键」：清点结果与那句「仍是干跑」是同一轮的
                        // 两样东西，只清一样会让旧判词挂在空按钮旁边。
                        h("button", { type: "button", className: "mneme-btn", disabled: undoBusy, onClick: () => { setUndoPreview(null); setUndoStillDry(false); } },
                          t("memory.explorer.cancel"))
                      )
                    : h("button", { type: "button", className: "mneme-btn mneme-btndanger", disabled: undoBusy, onClick: () => undoPack(false) },
                        t("memory.explorer.undoPack"))),
                // 撤销同样是往返一秒量级的枪（清点那一发与接收侧的干跑走的是同一档耗时）：
                // 只把键按灰而不说在忙，看起来就像没反应。这一句说的是**收起**，不是导入——
                // 物删在飞的时候写成「导入中」是把两件相反的事挂在同一行字上。
                undoBusy && h("span", { style: { fontSize: 12 } }, t("memory.explorer.undoPackBusy")),
                undoStillDry && h("span", { style: { fontSize: 12, color: "var(--mneme-danger)" } },
                  t("memory.explorer.undoPackStillDry")),
                undoError && h("span", { style: { fontSize: 12, color: "var(--mneme-danger)" } },
                  t("memory.explorer.undoPackFailed"))
              )
        )
      );
    }

    // --- 导入弹层 ---
    // 选类型 → 选文件 → 解析合并。文件在本地读成文本，POST /import 只传
    // 文本与类型；成功后提示合并条数，并由父级刷新列表。
    function ImportDialog({ t, onClose, onImported }) {
      const [type, setType] = useState("preference");
      const [file, setFile] = useState(null);
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState("");
      const [err, setErr] = useState("");
      const fileRef = useRef(null);
      const submit = () => {
        if (!file) { setErr(t("memory.explorer.importNoFile")); return; }
        setBusy(true);
        setErr("");
        file.text()
          .then((text) => apiFetch("/api/dsh-mneme/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type, markdown: text })
          }))
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((d) => {
            setMsg(t("memory.explorer.imported").replace("{n}", String((d && d.merged) ?? 0)));
            setBusy(false);
            setTimeout(() => { onImported(); onClose(); }, 900);
          })
          .catch(() => { setBusy(false); setErr(t("memory.explorer.importFailed")); });
      };
      return h("div", { className: "mneme-impdialog", role: "region", "aria-label": t("memory.explorer.importTitle") },
        h("div", { className: "mneme-set-title" }, t("memory.explorer.importTitle")),
        h("div", { className: "mneme-featsubhint", style: { marginTop: 4 } }, t("memory.explorer.importHint")),
        h("div", { className: "mneme-improw" },
          h("span", { className: "mneme-featnumlabel" }, t("memory.explorer.importType")),
          h("select", { className: "mneme-select", value: type, onChange: (e) => setType(e.target.value) },
            ["preference", "project", "decision", "summary", "history"].map((k) =>
              h("option", { key: k, value: k }, typeLabel(t, k))))
        ),
        h("div", { className: "mneme-improw" },
          h("button", { type: "button", className: "mneme-btn", onClick: () => fileRef.current?.click() },
            file ? file.name : t("memory.explorer.importPick")),
          h("input", {
            ref: fileRef,
            type: "file",
            accept: ".md,.markdown,text/markdown",
            style: { display: "none" },
            onChange: (e) => { setFile((e.target.files && e.target.files[0]) || null); setErr(""); }
          })
        ),
        err && h("div", { className: "mneme-featsubhint", style: { color: "var(--mneme-danger)", marginTop: 8 } }, err),
        msg && h("div", { className: "mneme-saved", style: { marginTop: 8 } }, msg),
        h("div", { className: "mneme-improw", style: { justifyContent: "flex-end" } },
          h("button", { type: "button", className: "mneme-btn", disabled: busy, onClick: onClose }, t("memory.explorer.importCancel")),
          h("button", { type: "button", className: "mneme-btn", disabled: busy, onClick: submit },
            busy ? t("memory.explorer.importing") : t("memory.explorer.importConfirm"))
        )
      );
    }

    // --- 从目录引导弹层（issue #386 第 6 条；#558 起状态住模块级 bootstrapJob）---
    // 后端能力早在 #220 就实现了（src/bootstrap.js：六类确定性产物，零 LLM，吃
    // saveWithDedupe 的 (type,title,scope) 去重），但只有 Bearer 数据面一条入口，
    // 面板够不着——用户照文档找过来，发现产品界面里没有这个东西。
    //
    // 与 ImportDialog 的两处刻意的不同：
    // 1. 成功后保持 900ms 的提示阅读时间再自动收口。定时器句柄存进 ref，卸载时清
    //    掉——若 tab 在这 900ms 里被关掉，结果已经写进模块级 bootstrapJob（done），
    //    重开标签页回放这一份；timer 没了就不再自动收口，由人手动关（关 = 确认，
    //    explorer 会把任务态回 idle）。
    // 2. 错误按服务端的码分开说。「目录不存在」「不是目录」「能力没接线」三种情况下
    //    用户该做的事完全不同，统一成一句「引导失败」等于让他自己猜。
    //
    // busy / msg / err 全部从 store 派生而非本地 state：组件只是任务态的一个视图，
    // 卸载（tab 关闭）不丢、重挂载回放——这正是 #558 要的「请求与结果活得比标签页
    // 体长」。唯一的本地态是输入框草稿与「目录没填」这种提交前校验（请求没起飞，
    // 没有什么需要跨卸载存活）。
    function BootstrapDialog({ t, onClose, onImported }) {
      const job = useBootstrapJob();
      const [dir, setDir] = useState(job.dir || "");
      const [localErr, setLocalErr] = useState("");
      const timerRef = useRef(null);
      useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
      const busy = job.phase === "running";
      // 「新鲜 done」＝本次提交刚落地的 900ms 阅读窗（timer 还挂着）；重开回放的
      // done 没有 timer，按钮必须可点——否则旧结果会把弹层锁死。
      const freshDone = job.phase === "done" && timerRef.current !== null;
      const submitBlocked = busy || freshDone;
      // 错误消息从码派生：码是服务端的 error 字段（或 generic 兜底），本地校验的
      // 「目录没填」不进 store——请求没起飞，无需跨卸载存活。
      const err = localErr || (job.phase === "failed"
        ? (() => {
            const key = "memory.explorer.bootstrapErr." + String(job.error || "generic");
            const localized = t(key);
            // t() 对未知键原样返回键名——那就退回通用文案，别把键名甩给用户。
            return localized === key ? t("memory.explorer.bootstrapFailed") : localized;
          })()
        : "");
      const msg = job.phase === "done"
        ? t("memory.explorer.bootstrapDone")
            .replace("{n}", String((job.result && job.result.created) ?? 0))
            .replace("{m}", String((job.result && job.result.merged) ?? 0))
        : "";
      const submit = () => {
        if (busy) return;
        const target = String(dir || "").trim();
        if (!target) { setLocalErr(t("memory.explorer.bootstrapNoDir")); return; }
        // 任务态同步进 store（running）：父组件的「⋯」守卫与外层 Esc/背板/✕ 守卫
        // 在同一渲染里就位——旧 prop 链要等渲染提交后才追上，中间那一拍是
        // #4452539705 的老毛病；现在 setBootstrapJob 的监听者同步被唤醒。
        setBootstrapJob({ phase: "running", dir, result: null, error: null });
        setLocalErr("");
        apiFetch("/api/dsh-mneme/bootstrap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // 传原串（不 trim）：前后空格在多数文件系统里是合法路径的一部分，
          // 服务端也只是 trim 判空、回传原值。
          body: JSON.stringify({ dir })
        })
          .then((res) => res.json().then((d) => ({ ok: res.ok, d })))
          .then(({ ok, d }) => {
            if (!ok) {
              // terminal 化只写 store：此刻本组件可能已被 tab 关闭卸载——那正是
              // 要修的路径，结果留在 store 里等重开回放，而不是写进已卸载的组件。
              setBootstrapJob({ phase: "failed", error: (d && d.error) || "generic" });
              return;
            }
            setBootstrapJob({ phase: "done", result: { created: (d && d.created) ?? 0, merged: (d && d.merged) ?? 0 } });
            // onImported 只在结果落地那一刻调，回放不重复调：列表刷新要么当时已
            // 生效，要么重开标签页时挂载 effect 重新取（库已写入，列表不会旧）。
            onImported();
            timerRef.current = setTimeout(() => onClose(), 900);
          })
          .catch(() => { setBootstrapJob({ phase: "failed", error: "generic" }); });
      };
      return h("div", { className: "mneme-impdialog", role: "region", "aria-label": t("memory.explorer.bootstrapTitle") },
        h("div", { className: "mneme-set-title" }, t("memory.explorer.bootstrapTitle")),
        h("div", { className: "mneme-featsubhint", style: { marginTop: 4 } }, t("memory.explorer.bootstrapHint")),
        h("div", { className: "mneme-improw" },
          h("span", { className: "mneme-featnumlabel" }, t("memory.explorer.bootstrapDir")),
          // 用文本框而不是 <input webkitdirectory>：后者给的是「选了哪个目录里的
          // 一批文件」，拿不到目录本身，而 bootstrap 要的正是那个目录。
          h("input", {
            className: "mneme-set-input",
            style: { marginBottom: 0, flex: 1, minWidth: 0 },
            type: "text",
            value: dir,
            placeholder: "/path/to/project",
            // 请求进行中锁住输入框：否则用户改成 B，回来的提示就贴在 B 旁边，
            // 而它说的是 A 的结果（评审 #4452245279）。
            disabled: busy,
            onChange: (e) => { setDir(e.target.value); setLocalErr(""); }
          })
        ),
        err && h("div", { className: "mneme-featsubhint", style: { color: "var(--mneme-danger)", marginTop: 8 } }, err),
        msg && h("div", { className: "mneme-saved", style: { marginTop: 8 } }, msg),
        h("div", { className: "mneme-improw", style: { justifyContent: "flex-end" } },
          // 取消在 running 时锁死（既有守卫）；fresh done 的 900ms 窗内**可点**——
          // 旧实现靠 busy 连 cancel 一起锁，那时 busy 是本地 state、必然随组件活着
          // 解锁；现在 done 是 store 态、可能被重开回放，锁死会把弹层永久焊住。
          h("button", { type: "button", className: "mneme-btn", disabled: busy, onClick: onClose }, t("memory.explorer.importCancel")),
          h("button", { type: "button", className: "mneme-btn", disabled: submitBlocked, onClick: submit },
            busy ? t("memory.explorer.bootstraping") : t("memory.explorer.bootstrapConfirm"))
        )
      );
    }

    // --- 分享包弹层 ---
    // 这一面的支点只有一句：**看见 report 之前不给下载**。服务端一次 POST 就把包和报告
    // 一起交回，所以这一格拦不住靠协议、只能靠界面自己：CLI 那侧没人拦得住，面板至少要让
    // 「随手把整库外发」停一步。八个类型下拉、六个跳过原因都只许是 src/share.js 的投影，
    // 一条判据都不在这里复述（#411 口径）。
    const SHARE_TYPE_OPTIONS = ["preference", "project", "decision", "history", "pitfall", "constraint", "rejected_solution", "pattern"];
    // 顺序即 share.js 的判序（classifyRowForShare 从上往下命中）；报告按这个顺序排，
    // 跨文件锁在 test/client-share.test.js 里同时锁内容与顺序。
    const SHARE_SKIP_REASONS = ["archived", "forgotten", "readonly_type", "excluded_type", "blank_or_noise", "sensitive"];

    /**
     * 服务端 Content-Disposition 里的文件名。拼法只住在 src/share-http.js 的
     * shareFilename（日期 + pack_id 前 8 位），面板复制一份就是第二个口径：旧服务端没带
     * 这一格时宁可短（pack_id 兜底），也不许在这里再拼一次日期。
     */
    const dispositionName = (value) => {
      const m = /filename="?([^";]+)"?/.exec(value || "");
      return m ? m[1] : "";
    };

    // 出包报告。两笔账必须同屏：进包条数与「够格」条数是两个数（包内同键折叠），
    // 跳过计数是全量而跳过清单截到 50——只报清单会让人以为跳过的就清单里那些。
    function ShareReport({ t, report, listOpen, setListOpen }) {
      const skipped = report.skipped || {};
      const list = Array.isArray(report.skip_list) ? report.skip_list : [];
      const totalSkipped = SHARE_SKIP_REASONS.reduce((n, k) => n + (skipped[k] || 0), 0);
      return h("div", { className: "mneme-sharebody" },
        h("div", { className: "mneme-saved" }, t("memory.explorer.shareIncluded").replace("{n}", String(report.included ?? 0))),
        (report.deduped || 0) > 0 && h("div", { className: "mneme-featsubhint" },
          t("memory.explorer.shareDeduped")
            .replace("{n}", String(report.deduped))
            .replace("{m}", String(report.included + report.deduped))),
        totalSkipped > 0 && h("div", { className: "mneme-featsubhint" },
          t("memory.explorer.shareSkipped").replace("{n}", String(totalSkipped))),
        totalSkipped > 0 && h("div", { className: "mneme-sharebreak" },
          SHARE_SKIP_REASONS.filter((k) => (skipped[k] || 0) > 0).map((k) =>
            h("span", { key: k, className: "mneme-sharebreakitem" },
              `${t(`memory.explorer.share.skip.${k}`)} ${skipped[k]}`))),
        list.length > 0 && h("div", null,
          h("button", {
            type: "button",
            className: "mneme-footbtn",
            "aria-expanded": String(listOpen),
            onClick: () => setListOpen(!listOpen)
          }, t("memory.explorer.shareSkipList").replace("{n}", String(list.length))),
          listOpen && h("div", { className: "mneme-sharelist" },
            list.map((row, i) => h("div", { key: `${i}-${row.reason}`, className: "mneme-sharow" },
              // 命中密钥/PII 的那几条服务端就不给标题（空串），这里不许拿正文或摘要兜底：
              // 摘要是递给对面的离线爆破 oracle（src/share.js 的 skipTitle 那段）。
              h("span", { className: "mneme-sharowtitle" }, row.title || t("memory.explorer.shareNoTitle")),
              h("span", { className: "mneme-sharowreason" }, t(`memory.explorer.share.skip.${row.reason}`)))),
            // 截断的判据用「清单比账短」而不是硬写 50：服务端的水位改了，这里跟着走。
            totalSkipped > list.length && h("div", { className: "mneme-sharow" },
              h("span", { className: "mneme-sharowreason" },
                t("memory.explorer.shareSkipListCapped").replace("{n}", String(list.length))))))
      );
    }

    function ShareDialog({ t, onClose }) {
      const [alias, setAlias] = useState("");
      const [type, setType] = useState(""); // "" = 整库口径：这个键压根不发
      const [busy, setBusy] = useState(false);
      const [pack, setPack] = useState(null);
      const [fileName, setFileName] = useState("");
      const [tooLarge, setTooLarge] = useState(null);
      const [err, setErr] = useState("");
      const [listOpen, setListOpen] = useState(false);

      const build = () => {
        setBusy(true);
        setErr("");
        setPack(null);
        setTooLarge(null);
        setFileName("");
        setListOpen(false);
        const body = {};
        if (alias.trim()) body.alias = alias.trim();
        if (type) body.type = type;
        apiFetch("/api/dsh-mneme/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        })
          .then(async (res) => {
            const d = await res.json().catch(() => null);
            // 413 的答复不是包：{error, bytes, limitBytes, hint, report}。报告要给，
            // 包体一个字节都不许在内存里留着——服务端正是因为它太大才拒的。
            if (res.status === 413) { setTooLarge(d || {}); setBusy(false); return; }
            if (!res.ok) {
              // 与接收弹层同一份形状：服务端只回一个码（empty-pack / invalid-alias / …），
              // detail 有就带上——那是「哪一格不合格」的唯一读数，面板不自己编第二套文案。
              // 不这么做的话，日后 shareReply 新增的码在这里全是「生成失败」六个字。
              setErr(`${t("memory.explorer.shareFailed")}（${(d && d.error) || res.status}）`
                + (d && d.detail ? `：${d.detail}` : ""));
              setBusy(false);
              return;
            }
            // 200 但读不出报告**不是成功**：这一支不给码（没有码可给），只说失败。
            if (!d || !d.report) { setErr(t("memory.explorer.shareFailed")); setBusy(false); return; }
            setPack(d);
            setFileName(dispositionName(res.headers.get("content-disposition")));
            setBusy(false);
          })
          .catch(() => { setErr(t("memory.explorer.shareFailed")); setBusy(false); });
      };

      const rep = pack && pack.report;
      // included 为 0 时不给下载：那种包对面吃的是 empty-pack（400），给一个必败的文件
      // 不如在这里说清「没有够格外发的条目」。
      const canDownload = !!rep && rep.included > 0;

      const download = () => {
        // 面板写的字节必须与 `src/share.js` 量水位的、`bin/cli.mjs` 落盘的**同一份形状**
        // （pretty-print 只属于 `/export` 那个备份面：人读的档，不是要重投的包）。
        const blob = new Blob([JSON.stringify(pack)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName || `dsh-mneme-share-${pack.pack_id}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      };

      return h("div", { className: "mneme-impdialog mneme-sharedialog", role: "region", "aria-label": t("memory.explorer.shareTitle") },
        h("div", { className: "mneme-set-title" }, t("memory.explorer.shareTitle")),
        h("div", { className: "mneme-featsubhint", style: { marginTop: 4 } }, t("memory.explorer.shareHint")),
        h("div", { className: "mneme-improw" },
          h("span", { className: "mneme-featnumlabel" }, t("memory.explorer.shareAlias")),
          // 尺子与服务端同一把：importedTagFor 把整串标签（含 from-）截到 32，留给别名的
          // 就是 27。不拦的话她打的第 28 个字起在**对面**被静默吃掉，而这条标签是外来行
          // 唯一的来源读数。数字由 test/client-share.test.js 跨文件钉住。
          h("input", {
            type: "text",
            className: "mneme-select",
            value: alias,
            maxLength: 27,
            placeholder: t("memory.explorer.shareAliasBlank"),
            onChange: (e) => setAlias(e.target.value)
          })
        ),
        h("div", { className: "mneme-improw" },
          h("span", { className: "mneme-featnumlabel" }, t("memory.explorer.shareType")),
          h("select", { className: "mneme-select", value: type, onChange: (e) => setType(e.target.value) },
            h("option", { value: "" }, t("memory.tab.all")),
            SHARE_TYPE_OPTIONS.map((k) => h("option", { key: k, value: k }, typeLabel(t, k))))
        ),
        h("div", { className: "mneme-improw", style: { justifyContent: "flex-end" } },
          h("button", { type: "button", className: "mneme-btn", disabled: busy, onClick: onClose },
            t("memory.explorer.importCancel")),
          h("button", { type: "button", className: "mneme-btn", disabled: busy, onClick: build },
            busy ? t("memory.explorer.shareBuilding") : t("memory.explorer.shareBuild"))
        ),
        err && h("div", { className: "mneme-featsubhint", style: { color: "var(--mneme-danger)", marginTop: 8 } }, err),
        tooLarge && h("div", { className: "mneme-featsubhint", style: { color: "var(--mneme-warn)", marginTop: 8 } },
          // 提示语服务端给（SHARE_ERROR_HINT 只许有一份），面板只补自己那句字节数。
          // 它写着 --type/--tag 的 CLI 口吻，这一格已知：docs/SHARE.md 的『面板』那一节记着。
          `${t("memory.explorer.shareTooLarge")
            .replace("{bytes}", String(tooLarge.bytes ?? "?"))
            .replace("{limit}", String(tooLarge.limitBytes ?? "?"))} ${tooLarge.hint || ""}`),
        tooLarge && tooLarge.report && h(ShareReport, { t, report: tooLarge.report, listOpen, setListOpen }),
        rep && h(ShareReport, { t, report: rep, listOpen, setListOpen }),
        canDownload && h("div", { className: "mneme-improw", style: { justifyContent: "flex-end" } },
          h("button", { type: "button", className: "mneme-btn", onClick: download },
            t("memory.explorer.shareDownload"))),
        // 没有可下载的东西就一定给一句原因：`included` 为 0 与「这答复没有条数」是两种失败，
        // 但对她的界面是同一种——数字后面没有键。canDownload 是唯一的门，这里就只认它。
        rep && !canDownload && h("div", { className: "mneme-featsubhint", style: { marginTop: 8 } },
          t("memory.explorer.shareEmpty")),
      );
    }

    // 干跑与真导入**共用这一份读数**：两者的键完全相同，区别只有 dry_run 那一格。
    // 拆成两个组件就会各写一套文案，而「将新建」与「已新建」的唯一真凭是 dry_run。
    function ReceiveSummary({ t, d }) {
      const conflicts = Array.isArray(d.title_conflicts) ? d.title_conflicts : [];
      const alias = d.alias || t("memory.explorer.receiveAnonymous");
      return h("div", { className: "mneme-sharebody" },
        h("div", { className: "mneme-featsubhint" },
          `${t("memory.explorer.receiveFrom").replace("{alias}", alias)} · ${d.pack_id || ""}`),
        // dry_run 缺格（旧服务端）时按「没写」处理：宁可少报一次写入，不可虚报。
        h("div", { className: "mneme-saved" },
          t(d.dry_run === false ? "memory.explorer.receiveDidCreate" : "memory.explorer.receiveWouldCreate")
            .replace("{n}", String(d.created ?? 0))),
        (d.skipped_existing || 0) > 0 && h("div", { className: "mneme-featsubhint" },
          t("memory.explorer.receiveExisting").replace("{n}", String(d.skipped_existing))),
        (d.unchanged || 0) > 0 && h("div", { className: "mneme-featsubhint" },
          t("memory.explorer.receiveUnchanged").replace("{n}", String(d.unchanged))),
        // 撞名是 advisory 读数：只对「本轮真正会新建的那些」判过，重吃同一个包时恒空
        //（src/share-import.js:181-186）。所以这里**只有非空才出声**，绝不写「没有冲突」；
        // 屏上没有这一行不等于没有撞名，等于「本轮没有新的要报」。
        conflicts.length > 0 && h("div", { className: "mneme-featsubhint", style: { color: "var(--mneme-warn)" } },
          t("memory.explorer.receiveConflicts").replace("{n}", String(conflicts.length))),
        TypeRowList({ t, rows: conflicts }),
        // `conflicts_checked` 是服务端给的**包内条数**，不是「比过了几条」（同一处注释写明：
        // 第二次吃同一个包时 title_conflicts 恒空，而这一格仍是全量）。所以文案只说
        // 「包内 N 条」：它是上一行为什么可能沉默的尺，不许读成「比对了 N 条都没撞」。
        h("div", { className: "mneme-featsubhint" },
          t("memory.explorer.receivePackCount").replace("{n}", String(d.conflicts_checked ?? 0)))
      );
    }

    function ReceiveDialog({ t, onClose, onImported }) {
      const [file, setFile] = useState(null);
      const [pack, setPack] = useState(null);
      const [preview, setPreview] = useState(null);
      const [result, setResult] = useState(null);
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState("");
      const fileRef = useRef(null);

      // 一发 POST 两种用法（干跑 / 确认）都从这走，失败文案只有一份。返回 null 表示
      // 「已经有一句话摆上屏了」——所以每一条不回 null 的路径都必须自己先 setErr，
      // 否则调用方读到 null 就是什么都不做，现场变成「按了没反应」。
      const post = (body) => apiFetch("/api/dsh-mneme/receive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      })
        .then(async (res) => {
          const d = await res.json().catch(() => null);
          setBusy(false);
          if (!res.ok) {
            // 闸门只回一个码（invalid-kind / external-id-mismatch / …），detail 有就带上：
            // 那是「哪一格不合格」的唯一读数，面板不自己编第二套文案。
            setErr(`${t("memory.explorer.receiveFailed")}（${(d && d.error) || res.status}）`
              + (d && d.detail ? `：${d.detail}` : ""));
            return null;
          }
          // 200 但正文读不出（前置的 HTML 拦截页、空 body 的代理、被截断的响应）
          // **不是成功**：这里曾经直接把 null 交回调用方，于是确认那一发悄悄没走完，
          // 而屏上上一块的「将新建 N 条」还留着——看起来就像她没点确认。
          if (!d || typeof d !== "object") {
            setErr(t("memory.explorer.receiveFailed"));
            return null;
          }
          return d;
        })
        .catch(() => { setErr(t("memory.explorer.receiveFailed")); setBusy(false); return null; });

      const pick = (f) => {
        setFile(f || null);
        setErr("");
        setPreview(null);
        setResult(null);
        setPack(null);
        if (!f) return;
        f.text().then((text) => {
          // 坏 JSON 在本地就拦。「这个文件根本不是 JSON」与「这个包不合格」是两件事，
          // 后者由服务端的码说（invalid-kind / invalid-entry / …）。
          // 顶层不是对象的也一样在这里说清：`null`、`0`、`[]` 会让预览键永远灰着且不解释，
          // 那种「按不动也没话说」的界面比一句错话更坏。
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            setErr(t("memory.explorer.receiveNotJson"));
            return;
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            setErr(t("memory.explorer.receiveNotPack"));
            return;
          }
          setPack(parsed);
        }).catch(() => setErr(t("memory.explorer.receiveFailed")));
      };

      const runPreview = () => {
        setBusy(true);
        setErr("");
        setResult(null);
        // 不带 confirm = 干跑（服务端缺省即预览，spec §5 沿用 reclaim 的脾气）。
        post({ pack }).then((d) => { if (d) setPreview(d); });
      };

      const runApply = () => {
        setBusy(true);
        setErr("");
        post({ pack, confirm: true }).then((d) => {
          if (!d) return;
          setResult(d);
          // 写完才刷新列表；答复说没写就不刷（dry_run 那一格是唯一凭据）。
          // 同一支里顺手撤掉预览：写成功之后「将新建 40 条」与「已新建 40 条」是同屏的两种时态，
          // 上面那一句此时不是信息。回干跑时**保留**预览——那一发确实没写，屏上还该留着清点。
          if (d.dry_run === false) { setPreview(null); onImported(); }
        });
      };

      return h("div", { className: "mneme-impdialog mneme-sharedialog", role: "region", "aria-label": t("memory.explorer.receiveTitle") },
        h("div", { className: "mneme-set-title" }, t("memory.explorer.receiveTitle")),
        h("div", { className: "mneme-featsubhint", style: { marginTop: 4 } }, t("memory.explorer.receiveHint")),
        h("div", { className: "mneme-improw" },
          // 忙的时候不许再选一个文件：预览那一发还在飞，选第二个会清掉 pack/preview，
          // 而飞回来的那一块数字说的是**前一个**包——确认键亮着、写的却是后一个文件。
          // 这条窗口按实测是 0.5–3 秒量级，不是理论风险。
          h("button", { type: "button", className: "mneme-btn", disabled: busy, onClick: () => fileRef.current?.click() },
            file ? file.name : t("memory.explorer.receivePick")),
          h("input", {
            ref: fileRef,
            type: "file",
            accept: ".json,application/json",
            style: { display: "none" },
            // 选完就清空控件的值：否则她改完同一个文件再选一次，浏览器不发 change，
            // 面板会拿着上一版的包继续预览——同一颗键，两个事实。
            onChange: (e) => { pick((e.target.files && e.target.files[0]) || null); e.target.value = ""; }
          })
        ),
        err && h("div", { className: "mneme-featsubhint", style: { color: "var(--mneme-danger)", marginTop: 8 } }, err),
        // 入库是逐条先查 + 逐条 INSERT + 排队嵌入：实测 494 µs/条，单批一千多条要跑一秒开外，
        // 整库量级近 3 秒。busy 必须挂在预览与确认两发上，不然按钮看起来像没反应。
        busy && h("div", { className: "mneme-featsubhint", style: { marginTop: 8 } }, t("memory.explorer.importing")),
        preview && h(ReceiveSummary, { t, d: preview }),
        result && h(ReceiveSummary, { t, d: result }),
        // 按了确认却回个「仍是干跑」（服务端只认 confirm 的真值 true，缺省、字符串
        // "true"、别的旋钮一律不写）——这一句是唯一出声的地方：沉默会让人以为已经写进去了。
        // 它挂在 result 那一支而不是 ReceiveSummary 里：预览本来就该是干跑，那里再说一遍
        // 只是噪声。
        result && result.dry_run !== false && h("div", {
          className: "mneme-featsubhint", style: { color: "var(--mneme-warn)" }
        }, t("memory.explorer.receiveStillDry")),
        h("div", { className: "mneme-improw", style: { justifyContent: "flex-end" } },
          h("button", { type: "button", className: "mneme-btn", disabled: busy, onClick: onClose },
            t("memory.explorer.importCancel")),
          h("button", { type: "button", className: "mneme-btn", disabled: busy || !pack, onClick: runPreview },
            t("memory.explorer.receivePreview")),
          h("button", { type: "button", className: "mneme-btn", disabled: busy || !preview, onClick: runApply },
            t("memory.explorer.receiveConfirm"))
        )
      );
    }

    // #386 第 5 条：面板手动新增一条记忆。字段与 memory_save 工具对齐
    //（type/title/content/importance/tags），但**不放 scope/sensitivity**：归属的
    // 显式声明走详情抽屉那条路，它带「放宽可见性」二次确认；在新建表单里顺手盖
    // 章会绕开那道确认。后端的去重键仍是 (type, title, scope, sensitivity)，所以
    // 同类型同标题会并入既有行——服务端回的 action 决定提示语说「已新建」还是
    // 「已并入」，两者对用户是不同的事实，不能都报「已保存」。
    function CreateDialog({ t, onClose, onCreated }) {
      const [type, setType] = useState("preference");
      const [title, setTitle] = useState("");
      const [content, setContent] = useState("");
      const [importance, setImportance] = useState(3);
      const [tags, setTags] = useState("");
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState("");
      const [err, setErr] = useState("");
      const submit = () => {
        // 前端先拦一次空标题/空正文：后端也会 400，但往返一趟只为报「标题不能
        // 为空」不值当。服务端校验仍是权威——它同时管着类型白名单与去重。
        if (!title.trim()) { setErr(t("memory.explorer.newNoTitle")); return; }
        if (!content.trim()) { setErr(t("memory.explorer.newNoContent")); return; }
        setBusy(true);
        setErr("");
        apiFetch("/api/dsh-mneme/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type,
            title: title.trim(),
            content: content.trim(),
            importance,
            tags: tags.split(",").map((s) => s.trim()).filter(Boolean)
          })
        })
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((d) => {
            setMsg(d && d.action === "merged" ? t("memory.explorer.newMerged") : t("memory.explorer.newCreated"));
            // 成功后**不**重置 busy。这 900ms 是留给提示的阅读时间，而「新建」按钮此刻
            // 若重新可点，第二次同 type+title 会落进同一行，service 走 appendContent 把
            // 正文再追加一遍，提示还会从「已新建」翻成「已并入」——一次误触就写坏一条
            // 记忆。保持 busy 直到关窗，按钮全程 disabled（成功路径组件随即卸载，没有
            // 需要复原的状态）。
            // 停 900ms 让提示可读，再关窗并把新建的行选中（见 onCreated）。
            setTimeout(() => { onCreated(d); onClose(); }, 900);
          })
          .catch(() => { setBusy(false); setErr(t("memory.explorer.newFailed")); });
      };
      return h("div", { className: "mneme-impdialog", role: "region", "aria-label": t("memory.explorer.newTitle") },
        h("div", { className: "mneme-set-title" }, t("memory.explorer.newTitle")),
        h("div", { className: "mneme-featsubhint", style: { marginTop: 4 } }, t("memory.explorer.newHint")),
        h("div", { className: "mneme-improw" },
          h("span", { className: "mneme-featnumlabel" }, t("memory.explorer.newType")),
          h("select", { className: "mneme-select", value: type, onChange: (e) => setType(e.target.value) },
            // document 刻意不在列：它是 agent 注册长文档的指针行，铸造口唯一
            //（registerDocument，#230），后端路由也会 400。列出来只会让人点了
            // 才被拒。
            ["preference", "project", "decision", "history", "rejected_solution", "pitfall", "constraint"].map((k) =>
              h("option", { key: k, value: k }, typeLabel(t, k))))
        ),
        h("div", { className: "mneme-improw" },
          h("input", {
            type: "text",
            className: "mneme-set-input",
            value: title,
            placeholder: t("memory.explorer.newTitlePlaceholder"),
            "aria-label": t("memory.explorer.newTitlePlaceholder"),
            onChange: (e) => { setTitle(e.target.value); setErr(""); }
          })
        ),
        h("div", { className: "mneme-improw" },
          h("textarea", {
            className: "mneme-set-input mneme-set-input--area",
            value: content,
            placeholder: t("memory.explorer.newContentPlaceholder"),
            "aria-label": t("memory.explorer.newContentPlaceholder"),
            rows: 4,
            onChange: (e) => { setContent(e.target.value); setErr(""); }
          })
        ),
        h("div", { className: "mneme-improw" },
          h("input", {
            type: "text",
            className: "mneme-set-input",
            value: tags,
            placeholder: t("memory.explorer.newTagsPlaceholder"),
            "aria-label": t("memory.explorer.newTagsPlaceholder"),
            onChange: (e) => setTags(e.target.value)
          })
        ),
        h("div", { className: "mneme-improw" },
          h("span", { className: "mneme-featnumlabel" }, t("memory.explorer.importance")),
          h("div", { className: "mneme-staredit", role: "radiogroup", "aria-label": t("memory.explorer.detail.editImportance") },
            [1, 2, 3, 4, 5].map((n) => h("button", {
              key: n,
              type: "button",
              role: "radio",
              "aria-checked": String(importance === n),
              "aria-label": t("memory.explorer.detail.starLabel").replace("{n}", String(n)),
              className: importance >= n ? "mneme-starbtn mneme-starbtn--on" : "mneme-starbtn",
              onClick: () => setImportance(n)
            }, h(StarGlyph, { size: 15, filled: importance >= n }))))
        ),
        err && h("div", { className: "mneme-featsubhint", style: { color: "var(--mneme-danger)", marginTop: 8 } }, err),
        msg && h("div", { className: "mneme-saved", style: { marginTop: 8 } }, msg),
        h("div", { className: "mneme-improw", style: { justifyContent: "flex-end" } },
          h("button", { type: "button", className: "mneme-btn", disabled: busy, onClick: onClose }, t("memory.explorer.importCancel")),
          h("button", { type: "button", className: "mneme-btn", disabled: busy, onClick: submit },
            busy && !msg ? t("memory.explorer.newSaving") : t("memory.explorer.newConfirm"))
        )
      );
    }

    function MemoryExplorer({ t, onBusyChange }) {
      const [view, setView] = useState("memory"); // memory | entity | status | settings
      const [items, setItems] = useState([]); // loaded browse pages, chrono desc
      const [total, setTotal] = useState(0); // server count for the current type filter
      // #597：服务端全库分布（同一份筛选、不带 type）。null = 老服务端没这一格，
      // 分类栏退回页内现数（降级不炸，只是回到「只数已加载页」的旧行为）。
      const [typeCounts, setTypeCounts] = useState(null);
      const [loading, setLoading] = useState(true);
      const [loadingMore, setLoadingMore] = useState(false);
      const [type, setType] = useState("all");
      const [minImp, setMinImp] = useState(0); // importance floor: 0 = all, else 3/4/5
      const [query, setQuery] = useState("");
      const [semantic, setSemantic] = useState(false);
      const [vecEnabled, setVecEnabled] = useState(false);
      const [searchTopK, setSearchTopK] = useState(20);
      const [remoteItems, setRemoteItems] = useState(null);
      const [selectedId, setSelectedId] = useState(null);
      const [expandedMonths, setExpandedMonths] = useState(null); // null = 仅最新一个月展开
      const [collapsed, setCollapsed] = useState({});
      const [reloadKey, setReloadKey] = useState(0);
      const [deleting, setDeleting] = useState(false);
      const [deleteError, setDeleteError] = useState(false);
      const [toastMsg, setToastMsg] = useState(""); // 瞬时操作提示（删除/归档），挂在外层不被抽屉卸载吞掉
      const [graphFocus, setGraphFocus] = useState("");
      // 交互式面板新增：浏览模式（卡片/时间线，本地记住）、时间筛选、
      // 冲突冻结指示、更多操作菜单与导入弹层。
      const [viewMode, setViewMode] = useState(() => {
        try { return window.localStorage.getItem("dsh-mneme-view") === "cards" ? "cards" : "timeline"; }
        catch { return "timeline"; }
      });
      const [dateRange, setDateRange] = useState("all"); // all | 7d | 30d | 90d
      // 方案 A：沉淀/归档筛选 chip——状态页「查看全部」也会带着它们跳转过来。
      const [depositedOnly, setDepositedOnly] = useState(false); // 只看 autoDream 巩固
      const [archivedOnly, setArchivedOnly] = useState(false); // 只看已归档
      const [foreignOnly, setForeignOnly] = useState(false); // 只看外来行（source=imported）
      const [heatSort, setHeatSort] = useState(false); // 卡片页内热度降序（阶段二补口）
      const [pendingIds, setPendingIds] = useState(() => new Set());
      const [menuOpen, setMenuOpen] = useState(false);
      const [importOpen, setImportOpen] = useState(false);
      const [bootstrapOpen, setBootstrapOpen] = useState(false);
      // 引导请求是否在飞（#558）：订阅模块级 bootstrapJob 而不是接弹层的回调。
      // 「⋯」按钮在忙碌时必须不关弹层（评审 #4452245292）；从 store 派生后这条
      // 守卫跨 tab 关闭/重开仍然成立——请求在飞时重开标签页，菜单照样锁着。
      const bootstrapJob = useBootstrapJob();
      const bootstrapBusy = bootstrapJob.phase === "running";
      // 卸载兜底：只回「用户没来得及看」之外的状态。卸载发生在 running 时（tab
      // 关闭 / 覆盖层关闭都算），结果还没人看过——terminal 化发生在卸载之后，
      // 这份要留给重开回放（本 issue 修的就是它）；卸载时已是 done/failed，
      // 用户见过它，回 idle 保持「重开是干净弹层」的既有行为。
      useEffect(() => () => {
        if (bootstrapJob.phase !== "running") resetBootstrapJob();
      }, []);
      const [createOpen, setCreateOpen] = useState(false);
      const [shareOpen, setShareOpen] = useState(false);
      const [receiveOpen, setReceiveOpen] = useState(false);
      const itemRefs = useRef(new Map());
      const moreRef = useRef(null);

      const switchViewMode = (mode) => {
        setViewMode(mode);
        try { window.localStorage.setItem("dsh-mneme-view", mode); } catch { /* 隐私模式等 */ }
      };

      useEffect(() => {
        apiFetch("/api/dsh-mneme/vector-config")
          .then((res) => res.json())
          .then((d) => setVecEnabled(!!d.config?.enabled))
          .catch(() => {});
      }, []);

      // 冲突冻结指示：dream-status 一次带出待确认冲突涉及的记忆 id，
      // 卡片与详情抽屉据此画「冲突」徽章。
      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/dream-status")
          .then((res) => (res.ok ? res.json() : { pendingMemoryIds: [] }))
          .then((d) => { if (!cancelled) setPendingIds(new Set(d.pendingMemoryIds || [])); })
          .catch(() => {});
        return () => { cancelled = true; };
      }, [reloadKey]);

      // 通用失效广播订阅：任何改库动作（裁决/删除/编辑/导入/恢复…）都让首页
      // 与冲突徽章立刻重取。此前列表只靠弹层成功回调、手动刷新与 30s 首页合并
      // 续命——裁决冲突后徽章与败者归档要关面板重开才更新（用户反馈的病灶）。
      // reloadKey 同时驱动浏览列表、搜索与上面这份 pendingIds，一个游标全带上。
      useEffect(() => {
        const onChanged = () => setReloadKey((k) => k + 1);
        window.addEventListener("mneme:store-changed", onChanged);
        return () => window.removeEventListener("mneme:store-changed", onChanged);
      }, []);

      // One query string behind every browse-list fetch (initial page,
      // loadMore, auto-refresh): the type filter, importance floor and time
      // window always travel together, so counts and pagination stay
      // consistent.
      const dateFromIso = dateRange === "all" ? "" : new Date(
        Date.now() - (dateRange === "7d" ? 7 : dateRange === "30d" ? 30 : 90) * 86400000
      ).toISOString();
      const filterQS = (type === "all" ? "" : `&type=${encodeURIComponent(type)}`)
        + (minImp ? `&minImportance=${minImp}` : "")
        + (dateFromIso ? `&updatedFrom=${encodeURIComponent(dateFromIso)}` : "")
        + (depositedOnly ? "&deposited=only" : "")
        + (archivedOnly ? "&archived=only" : "")
        + (foreignOnly ? "&source=imported" : "");
      const listUrl = (offset) => `/api/dsh-mneme/list?limit=${PAGE_SIZE}&offset=${offset}${filterQS}&order=chrono`;

      // Browse = paged, pure-chronological pages (order=chrono). The default
      // importance ordering would interleave months across pages and break
      // the month tree; type filters server-side so pages stay consistent
      // however large the store grows.
      useEffect(() => {
        let cancelled = false;
        setLoading(true);
        apiFetch(listUrl(0))
          .then((res) => (res.ok ? res.json() : { items: [], total: 0 }))
          .then((d) => {
            if (cancelled) return;
            setItems(d.items || []);
            setTotal(d.total || 0);
            // #597：分布随筛选整体刷新（筛选变了 filterQS 变，本 effect 重跑）。
            setTypeCounts(d.typeCounts || null);
            setExpandedMonths(null); // 新数据回到「仅最新月展开」
            setLoading(false);
          })
          .catch(() => { if (!cancelled) { setItems([]); setTotal(0); setTypeCounts(null); setLoading(false); } });
        return () => { cancelled = true; };
      }, [reloadKey, filterQS]);

      const canLoadMore = !query.trim() && !remoteItems && items.length < total;
      const loadMore = useCallback(() => {
        if (loadingMore || query.trim() || remoteItems) return;
        if (items.length >= total) return;
        setLoadingMore(true);
        apiFetch(listUrl(items.length))
          .then((res) => (res.ok ? res.json() : { items: [] }))
          .then((d) => setItems((cur) => cur.concat(d.items || [])))
          .catch(() => {})
          .finally(() => setLoadingMore(false));
      }, [items.length, total, loadingMore, query, remoteItems, filterQS]);

      // Infinite scroll: a sentinel just past the loaded rows pulls the next
      // page while browsing (search results arrive complete already).
      useEffect(() => {
        const el = moreRef.current;
        if (!el || !canLoadMore) return undefined;
        const io = new IntersectionObserver((entries) => {
          if (entries.some((e) => e.isIntersecting)) loadMore();
        }, { root: el.closest(".mneme-xtree"), rootMargin: "240px" });
        io.observe(el);
        return () => io.disconnect();
      }, [canLoadMore, loadMore]);

      // Search hits the server so matches are global — not limited to the
      // loaded pages: keyword = literal text; vector = semantic ranking
      // (the pipeline falls back to keyword when no embedder is available).
      useEffect(() => {
        const query0 = query.trim();
        if (!query0 || query0.startsWith("entity:")) { setRemoteItems(null); return; }
        let cancelled = false;
        const timer = setTimeout(() => {
          const mode = semantic ? "vector" : "keyword";
          apiFetch(`/api/dsh-mneme/search?q=${encodeURIComponent(query0)}&mode=${mode}&topK=${searchTopK}`)
            .then((res) => (res.ok ? res.json() : { items: [] }))
            .then((d) => { if (!cancelled) setRemoteItems(d.items || []); })
            .catch(() => { if (!cancelled) setRemoteItems([]); });
        }, 250);
        return () => { cancelled = true; clearTimeout(timer); };
        // reloadKey 必须进依赖：导入/引导/接收成功时只递增它，而搜索态下 items 走
        // remoteItems 那条路——少了这一格，搜索词不变就永远看不到刚进来的新行
        // （评审 #4452245305）。
      }, [query, semantic, searchTopK, reloadKey]);

      // Live view: while the memory tab is open, quietly re-fetch page 1
      // every 30s (and on every activation) so fresh memories surface
      // without a manual refresh. Later pages stay as loaded.
      const refreshFirstPage = useCallback(() => {
        if (query.trim() || remoteItems) return;
        apiFetch(listUrl(0))
          .then((res) => (res.ok ? res.json() : null))
          .then((d) => {
            if (!d) return;
            setTotal(d.total || 0);
            setItems((cur) => {
              const fresh = d.items || [];
              const seen = new Set(fresh.map((m) => m.id));
              return fresh.concat(cur.filter((m) => !seen.has(m.id)));
            });
          })
          .catch(() => {});
      }, [query, remoteItems, filterQS]);

      useEffect(() => {
        if (view !== "memory") return undefined;
        refreshFirstPage();
        const iv = setInterval(() => {
          if (document.visibilityState === "visible") refreshFirstPage();
        }, 30000);
        return () => clearInterval(iv);
      }, [view, refreshFirstPage]);

      useEffect(() => {
        if (!selectedId) return;
        itemRefs.current.get(selectedId)?.scrollIntoView({ block: "nearest" });
      }, [selectedId]);

      // The two-step delete arms inside the drawer per selection: switching
      // or clearing the target disarms it, so a stale confirm can never
      // delete a new pick.
      useEffect(() => {
        setDeleteError(false);
      }, [selectedId]);

      const q = query.trim().toLowerCase();
      // "entity:" is the graph entry grammar: typing it means the user wants
      // the entity's neighborhood, not a memory list. Offer the jump instead
      // of auto-switching so the list stays predictable.
      const entityQuery = query.trim().startsWith("entity:")
        ? query.trim().slice(7).trim()
        : "";
      // Search results were filtered server-side (global); the type rail
      // still narrows them. Browse mode serves the loaded pages as-is —
      // type filtering happened in the query.
      const visible = remoteItems
        ? remoteItems.filter((m) => type === "all" || m.type === type)
        : items;

      // #597：分类计数的服务端源。页被 type 筛过又分了页，页内现数两头都数不出
      // 真分布——选中一类后其它类计数为 0 被 filter 整条滤掉，分类栏塌剩两枚。
      // typeCounts 在场时用全库分布（筛选口径与 total 一致），缺类补 0；
      // 老服务端没这一格时退回页内现数（旧行为，塌栏仍在但功能不炸）。
      const counts = {};
      if (typeCounts) {
        for (const k of EXPLORER_TYPES) counts[k] = typeCounts[k] || 0;
        for (const k of Object.keys(typeCounts)) {
          if (!EXPLORER_TYPES.includes(k)) counts[k] = typeCounts[k];
        }
      } else {
        for (const m of items) counts[m.type] = (counts[m.type] || 0) + 1;
      }
      const knownTypes = EXPLORER_TYPES.filter((k) => counts[k]);
      // 「全部」chip：服务端分布合计——total 带着当前 type 筛，合计才是不带 type
      // 的那个数（选中一类后 chips 不再从 5 跳到 200）。降级回退页内行数。
      const allCount = typeCounts
        ? Object.keys(typeCounts).reduce((n, k) => n + (typeCounts[k] || 0), 0)
        : items.length;
      const extraTypes = Object.keys(counts)
        .filter((k) => !EXPLORER_TYPES.includes(k))
        .sort((a, b) => counts[b] - counts[a]);

      // Time tree: sort newest first, then group month → day in one pass so
      // the grouping follows the sort order instead of re-sorting buckets.
      const sorted = [...visible].sort((a, b) =>
        new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
      // heatSort（阶段二补口，order=heat 的前端实现）：热度是运行时投影、
      // 无存储序，SQL 排不了；页内对已加载条目降序（非全局序），时间树
      // 仍走 chrono 不受影响。开关仅在 heat 字段在场上时出现（自门控）。
      const heatAvailable = visible.some((m) => typeof m.heat === "number");
      const gridItems = heatSort
        ? [...sorted].sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0))
        : sorted;
      const months = [];
      let curMonth = null, curDay = null;
      for (const m of sorted) {
        const d = new Date(m.updated_at || m.created_at || 0);
        const valid = !Number.isNaN(d.getTime());
        const mk = valid ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` : "unknown";
        if (!curMonth || curMonth.key !== mk) {
          curMonth = {
            key: mk,
            label: valid ? d.toLocaleDateString(undefined, { year: "numeric", month: "long" }) : "—",
            days: []
          };
          months.push(curMonth);
          curDay = null;
        }
        const dk = valid ? `${mk}-${String(d.getDate())}` : "unknown";
        if (!curDay || curDay.key !== dk) {
          curDay = { key: dk, label: valid ? d.toLocaleDateString(undefined, { day: "numeric" }) : "—", items: [] };
          curMonth.days.push(curDay);
        }
        curDay.items.push(m);
      }
      for (const mo of months) mo.count = mo.days.reduce((s, d) => s + d.items.length, 0);

      const selected = visible.find((m) => m.id === selectedId) || null;

      // Delete / archive / edit commit through POST endpoints; on success the
      // row leaves or updates in every local view (browse pages + search
      // results). Failures — 404 included — surface as a transient red note
      // in the drawer's action bar.
      const deleteById = (id) => {
        if (!id || deleting) return;
        setDeleting(true);
        setDeleteError(false);
        apiFetch("/api/dsh-mneme/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id })
        })
          .then((res) => { if (!res.ok) throw new Error("http"); })
          .then(() => {
            setItems((cur) => cur.filter((m) => m.id !== id));
            setRemoteItems((cur) => (cur ? cur.filter((m) => m.id !== id) : cur));
            setTotal((n) => Math.max(0, n - 1));
            setSelectedId(null);
            // 删除同样广播：冲突队列的联表侧、实体页的关联记忆都引用这条 id。
            broadcastStoreChanged("memory-delete");
            setToastMsg(t("memory.explorer.deleted"));
            setTimeout(() => setToastMsg(""), 2500);
          })
          .catch(() => {
            setDeleteError(true);
            setTimeout(() => setDeleteError(false), 4000);
          })
          .finally(() => setDeleting(false));
      };

      // 编辑保存 / 归档的本地落账：替换或移除对应行；镜像由后端重渲染。
      // 归档从所有视图移除（列表默认只看未归档），并清空选中。
      // 调用点在服务端提交成功之后，所以这里同时是通用失效广播的发布点：
      // 其它页签（实体/状态工作台/冲突队列）不知道这次 /update，不广播就陈旧。
      const applyMemoryUpdate = (updated, { archived = false, restored = false } = {}) => {
        broadcastStoreChanged(archived ? "memory-archive" : restored ? "memory-restore" : "memory-edit");
        if (archived) {
          setItems((cur) => cur.filter((m) => m.id !== updated.id));
          setRemoteItems((cur) => (cur ? cur.filter((m) => m.id !== updated.id) : cur));
          setTotal((n) => Math.max(0, n - 1));
          setSelectedId(null);
          setToastMsg(t("memory.explorer.detail.archived"));
          setTimeout(() => setToastMsg(""), 2500);
          return;
        }
        if (restored) {
          // 恢复：行离开当前视图（抽屉只能从归档浏览列表打开它），回主列表
          // 由下一次筛选切换/刷新自然带出。
          setItems((cur) => cur.filter((m) => m.id !== updated.id));
          setRemoteItems((cur) => (cur ? cur.filter((m) => m.id !== updated.id) : cur));
          setTotal((n) => Math.max(0, n - 1));
          setSelectedId(null);
          setToastMsg(t("memory.explorer.detail.restored"));
          setTimeout(() => setToastMsg(""), 2500);
          return;
        }
        const replace = (m) => (m.id === updated.id ? updated : m);
        setItems((cur) => cur.map(replace));
        setRemoteItems((cur) => (cur ? cur.map(replace) : cur));
      };

      // 导出：JSON 走响应对象重序列化（缩进美化），Markdown 原样落盘；
      // 文件名带日期，浏览器下载不动主列表。
      const exportData = (format) => {
        apiFetch(`/api/dsh-mneme/export?format=${format}`)
          .then(async (res) => {
            if (!res.ok) throw new Error("http");
            const blob = format === "json"
              ? new Blob([JSON.stringify(await res.json(), null, 2)], { type: "application/json" })
              : new Blob([await res.text()], { type: "text/markdown" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `dsh-mneme-export-${new Date().toISOString().slice(0, 10)}.${format === "json" ? "json" : "md"}`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
          })
          .catch(() => {});
      };

      // Graph → memory jump: land on the browser tab with filters reset so
      // the target row is visible, selected and scrolled into view. A target
      // beyond the loaded pages renders as a single-row result set instead
      // of pulling page after page to find it.
      const jumpToMemory = (target) => {
        if (!target?.id) return;
        setView("memory");
        setType("all");
        setQuery("");
        setRemoteItems(items.some((m) => m.id === target.id) ? null : [target]);
        setExpandedMonths(null);
        setSelectedId(target.id);
      };

      // 引导请求在飞时不许离开记忆视图（评审 #4453639221）：`.mneme-xtools` 整块挂在
      // `view === "memory"` 之下，BootstrapDialog 就在里面。任何离开这个视图的动作都会
      // 连它一起卸载——请求还在飞、界面已经没了，那句「新建几条、并入几条」就再没有
      // 地方显示。这里只拦「离开」的路径：jumpToMemory / browseWithFilter 是回到
      // memory，不拦。
      const leaveMemory = (key) => {
        if (bootstrapBusy) return;
        setView(key);
      };

      const openGraphFor = (name) => {
        if (bootstrapBusy) return;
        setGraphFocus(name || "");
        setView("entity");
      };

      // 状态页「查看全部」入口：跳回记忆库并预置对应筛选（清搜索态，避免
      // remoteItems 盖过浏览列表）。
      const browseWithFilter = (patch) => {
        setDepositedOnly(!!patch.deposited);
        setArchivedOnly(!!patch.archived);
        setQuery("");
        setRemoteItems(null);
        setView("memory");
      };

      const subviews = [
        { key: "memory", label: t("memory.explorer.tabMemory") },
        { key: "entity", label: t("memory.explorer.tabEntities") },
        { key: "status", label: t("memory.explorer.tabStatus") },
        { key: "settings", label: t("memory.explorer.tabSettings") },
        { key: "persona", label: t("memory.explorer.tabPersona") },
        { key: "affective", label: t("memory.explorer.tabAffective") },
        { key: "diary", label: t("memory.diary.title") }
      ];

      return h("div", { className: "mneme-x" },
        h("div", { className: "mneme-xbar" },
          h("nav", { className: "mneme-vtabs", "aria-label": t("memory.view.label") },
            subviews.map((s) =>
              h("button", {
                key: s.key,
                type: "button",
                // 引导请求在飞时四个视图标签一律禁用（评审 #4453639221）：离开 memory
                // 会把整个 `.mneme-xtools` 连同里面的 BootstrapDialog 卸掉。onClick 仍
                // 走 leaveMemory 而不是 setView——disabled 只是第一道，第二道在函数里，
                // 免得将来有人给标签换一种可点的实现就绕过去了。
                disabled: bootstrapBusy,
                className: view === s.key ? "mneme-vtab mneme-active" : "mneme-vtab",
                "aria-pressed": String(view === s.key),
                onClick: () => leaveMemory(s.key)
              },
                h(Icon, { name: s.key === "memory" ? "database" : s.key === "entity" ? "waypoints" : s.key === "status" ? "activity" : s.key === "persona" ? "persona" : "settings", size: 14, className: "mneme-vtabico" }),
                s.label
              ))
          ),
          view === "memory" && h("div", { className: "mneme-xtools" },
            h("div", { className: "mneme-seg", role: "group", "aria-label": t("memory.explorer.viewAria") },
              h("button", {
                type: "button",
                className: viewMode === "cards" ? "mneme-active" : "",
                onClick: () => switchViewMode("cards")
              }, t("memory.explorer.viewCards")),
              h("button", {
                type: "button",
                className: viewMode === "timeline" ? "mneme-active" : "",
                onClick: () => switchViewMode("timeline")
              }, t("memory.explorer.viewTimeline"))
            ),
            h("div", { className: "mneme-menuwrap" },
              h("button", {
                type: "button",
                className: "mneme-footbtn",
                style: { fontSize: 15, padding: "3px 9px" },
                "aria-label": t("memory.explorer.more"),
                "aria-expanded": String(menuOpen),
                title: t("memory.explorer.more"),
                // 引导请求在飞时整个「⋯」都不给开：菜单与引导弹层共用同一个
                // 绝对定位锚点、同一层 z-index，弹层排在菜单之后渲染，会把
                // 菜单顶上的两项导出盖住——它们没有 disabled，却点不到
                // （评审 #4453225585）。不开菜单，就不存在「可点但被遮住」。
                // 这也顺带把 #4452245292 那条锁得更死：菜单开不了，就没有
                // 任何路径能在请求中途把引导弹层卸掉。
                disabled: bootstrapBusy,
                onClick: () => {
                  setMenuOpen(!menuOpen);
                  setImportOpen(false);
                  // 引导弹层只在不忙的时候才关：它内部已经用 busy 禁用了取消与提交，
                  // 这里若照旧卸载，等于给了一条绕过那两道锁的路（评审 #4452245292）。
                  // 关的同时把任务态回 idle——用户看得见这个关闭，terminal 状态
                  // 不该留到下次重开（#558 的存活规则：只留没人看过的那份）。
                  if (!bootstrapBusy) { resetBootstrapJob(); setBootstrapOpen(false); }
                  setCreateOpen(false);
                  setShareOpen(false);
                  setReceiveOpen(false);
                }
              }, "⋯"),
              menuOpen && h("div", { className: "mneme-menu", role: "menu" },
                // 引导请求在飞时，会挂弹层的那几项一律 disabled：这些弹层共用同一个
                // 绝对定位锚点，后渲染的会盖住引导弹层，它那句「新建几条、并入几条」
                // 就没地方看了（评审 #4452539738）。导出两项不挂弹层，照旧可点。
                h("button", { type: "button", role: "menuitem", disabled: bootstrapBusy, onClick: () => { setCreateOpen(true); setMenuOpen(false); } },
                  t("memory.explorer.newMemory")),
                h("button", { type: "button", role: "menuitem", onClick: () => { setMenuOpen(false); exportData("json"); } },
                  t("memory.explorer.exportJson")),
                h("button", { type: "button", role: "menuitem", onClick: () => { setMenuOpen(false); exportData("markdown"); } },
                  t("memory.explorer.exportMarkdown")),
                h("button", { type: "button", role: "menuitem", disabled: bootstrapBusy, onClick: () => { setImportOpen(true); setMenuOpen(false); } },
                  t("memory.explorer.importMd")),
                h("button", { type: "button", role: "menuitem", disabled: bootstrapBusy, onClick: () => { setBootstrapOpen(true); setMenuOpen(false); } },
                  t("memory.explorer.bootstrap")),
                h("button", { type: "button", role: "menuitem", disabled: bootstrapBusy, onClick: () => { setShareOpen(true); setMenuOpen(false); } },
                  t("memory.explorer.sharePack")),
                h("button", { type: "button", role: "menuitem", disabled: bootstrapBusy, onClick: () => { setReceiveOpen(true); setMenuOpen(false); } },
                  t("memory.explorer.receivePack")),
              ),
              importOpen && h(ImportDialog, {
                t,
                onClose: () => setImportOpen(false),
                onImported: () => { setReloadKey((k) => k + 1); broadcastStoreChanged("import"); }
              }),
              bootstrapOpen && h(BootstrapDialog, {
                t,
                // 人看得见的关闭（取消 / 自动收口 / 菜单收起）：terminal 状态回 idle，
                // 重开是干净弹层；tab 关闭不经过这里——running 的任务态留在模块级，
                // 由重开时回放（#558）。
                onClose: () => { resetBootstrapJob(); setBootstrapOpen(false); },
                onImported: () => { setReloadKey((k) => k + 1); broadcastStoreChanged("import"); }
              }),
              shareOpen && h(ShareDialog, { t, onClose: () => setShareOpen(false) }),
              receiveOpen && h(ReceiveDialog, {
                t,
                onClose: () => setReceiveOpen(false),
                onImported: () => { setReloadKey((k) => k + 1); broadcastStoreChanged("import"); }
              }),
              createOpen && h(CreateDialog, {
                t,
                onClose: () => setCreateOpen(false),
                // 新建后既刷新列表也选中新行：并入既有条目时 action 是 merged，
                // 返回的 id 就是被并入那一行——两种情况都该把它滚进视野。
                onCreated: (d) => { setReloadKey((k) => k + 1); broadcastStoreChanged("create"); if (d && d.id) setSelectedId(d.id); }
              })
            )
          ),
        ),
        view === "memory" && h("div", { className: "mneme-xmain" },
          // 两栏布局（桉桉规格）：左栏上段=语义检索（怎么搜），下段=重要性/
          // 来源/热度（留什么）；原第二侧栏的类型列表与计数刷新下沉到内容区
          // 工具条（.mneme-xbrowsebar），五个功能入口一个不丢。
          h("div", { className: "mneme-xside" },
            h("div", { className: "mneme-xcolhead" }, t("memory.explorer.searchTitle")),
            h("div", { className: "mneme-xsearchwrap" },
              h(Icon, { name: "search", size: 14, className: "mneme-xsearchico" }),
              h("input", {
                className: "mneme-search mneme-xsearch",
                placeholder: t("memory.explorer.search"),
                value: query,
                onChange: (e) => setQuery(e.target.value)
              })
            ),
            entityQuery && h("button", {
              className: "mneme-entitychip",
              style: { textAlign: "left", justifyContent: "flex-start" },
              onClick: () => openGraphFor(entityQuery)
            }, `${t("memory.graph.viewInGraph")} “${entityQuery}”`),
            h("div", { className: "mneme-xrow" },
              vecEnabled && h("button", {
                className: semantic ? "mneme-chip mneme-active" : "mneme-chip",
                title: t("memory.settings.vectorTitle"),
                onClick: () => setSemantic(!semantic)
              }, t("memory.panel.semantic")),
              h("select", {
                className: "mneme-select mneme-xselect",
                value: searchTopK,
                onChange: (e) => setSearchTopK(Number(e.target.value)),
                title: t("memory.explorer.topK")
              }, [5, 10, 20, 50].map((n) => h("option", { key: n, value: n }, t("memory.explorer.topKOption").replace("{n}", String(n)))))
            ),
            h("div", { className: "mneme-xrow" },
              h("select", {
                className: "mneme-select mneme-xselect",
                value: dateRange,
                onChange: (e) => setDateRange(e.target.value),
                title: t("memory.explorer.dateLabel"),
                "aria-label": t("memory.explorer.dateLabel")
              },
                ["all", "7d", "30d", "90d"].map((k) =>
                  h("option", { key: k, value: k }, t(`memory.explorer.date.${k}`))))
            ),
            h("div", { className: "mneme-xside-imp" },
              h("div", { className: "mneme-xcolhead" }, t("memory.explorer.importance")),
              h("div", { className: "mneme-xrow" },
                [0, 3, 4, 5].map((v) =>
                  h("button", {
                    key: v,
                    className: minImp === v ? "mneme-chip mneme-active" : "mneme-chip",
                    onClick: () => setMinImp(v)
                  }, v === 0 ? t("memory.tab.all") : h(react.Fragment, null, h(StarGlyph, { size: 11 }), ` ${v}+`)))
              ),
              h("div", { className: "mneme-xrow" },
                h("button", {
                  className: depositedOnly ? "mneme-chip mneme-active" : "mneme-chip",
                  title: t("memory.explorer.filterDepositedHint"),
                  onClick: () => setDepositedOnly(!depositedOnly)
                }, t("memory.explorer.filterDeposited")),
                h("button", {
                  className: archivedOnly ? "mneme-chip mneme-active" : "mneme-chip",
                  title: t("memory.explorer.filterArchivedHint"),
                  onClick: () => setArchivedOnly(!archivedOnly)
                }, t("memory.explorer.filterArchived")),
                h("button", {
                  className: foreignOnly ? "mneme-chip mneme-active" : "mneme-chip",
                  // 搜索态不许**开启**这一档：/search 的 DTO 读不出行来源（`source` 被
                  // searchMemories 盖成召回渠道，见 src/service.js:939），按一个假信号筛比筛不动
                  // 更坏。但已经开着的时候永远许关掉——把它整个 disabled 会把她锁在一个解不开
                  // 的状态里，只能先去清搜索词。
                  disabled: !!query.trim() && !foreignOnly,
                  title: query.trim()
                    ? t("memory.explorer.filterForeignSearchHint")
                    : t("memory.explorer.filterForeignHint"),
                  "aria-pressed": String(foreignOnly),
                  onClick: () => setForeignOnly(!foreignOnly)
                }, t("memory.explorer.filterForeign")),
                // 「为什么这一档在搜索时不按」不能只挂在 title 上：disabled 的按钮不发 focus，
                // 触屏与键盘用户拿不到提示，而她看到的是一个**亮着**的筛选压在一堆没筛过的
                // 结果上。所以开着外来档又在搜索时，屏上多一行看得见的说明。
                foreignOnly && !!query.trim() && h("div", {
                  className: "mneme-featsubhint", style: { marginTop: 4 }
                }, t("memory.explorer.filterForeignSearchHint")),
                heatAvailable && h("button", {
                  className: heatSort ? "mneme-chip mneme-active" : "mneme-chip",
                  title: t("memory.explorer.heatSortHint"),
                  onClick: () => {
                    setHeatSort(!heatSort);
                    if (!heatSort) switchViewMode("cards"); // 排序只作用于卡片网格
                  }
                }, t("memory.explorer.heatSort"))
              )
            )
          ),
          h("div", { className: "mneme-xcontent" },
            h("div", { className: "mneme-xbrowsebar" },
              h("button", {
                className: type === "all" ? "mneme-xtype mneme-active" : "mneme-xtype",
                onClick: () => setType("all")
              }, h("span", { className: "mneme-xdot mneme-xdot--all", "aria-hidden": "true" }), h("span", null, t("memory.tab.all")), h("span", { className: "mneme-xcount2" }, String(allCount))),
              knownTypes.concat(extraTypes).map((key) =>
                h("button", {
                  key,
                  className: type === key ? "mneme-xtype mneme-active" : "mneme-xtype",
                  onClick: () => setType(key)
                },
                  h("span", { className: "mneme-xdot", style: { color: memoryTypeColor(key) }, title: typeLabel(t, key), "aria-hidden": "true" }),
                  h("span", null, typeLabel(t, key)),
                  h("span", { className: "mneme-xcount2" }, String(counts[key]))
                )),
              // #597：页头 = 服务端 total（搜索态的 total 是命中数，同样在 state 里）；
              // 不再用 visible.length——那只是已加载页的行数，滚动一次就停住。
              h("span", { className: "mneme-xcount", style: { marginLeft: "auto" } }, t("memory.explorer.count").replace("{n}", String(remoteItems ? visible.length : total))),
              h("button", { className: "mneme-footbtn", onClick: () => setReloadKey((k) => k + 1) },
                h(Icon, { name: "refresh", size: 12 }), t("memory.explorer.refresh"))
            ),
          viewMode === "cards"
            ? h("div", { className: "mneme-cards" },
                loading
                  ? h("div", { className: "mneme-xempty", style: { gridColumn: "1 / -1" } }, "…")
                  : visible.length === 0
                    ? h("div", { className: "mneme-xempty", style: { gridColumn: "1 / -1" } },
                        h(Icon, { name: "inbox", size: 20, className: "mneme-xemptyico" }),
                        t("memory.explorer.empty"))
                    : gridItems.map((m) => h("button", {
                        key: m.id,
                        type: "button",
                        className: m.id === selectedId ? "mneme-card mneme-active" : "mneme-card",
                        onClick: () => setSelectedId(m.id)
                      },
                        h("div", { className: "mneme-cardhead" },
                          h("span", { className: "mneme-xdot", style: { color: memoryTypeColor(m.type) }, title: typeLabel(t, m.type), "aria-hidden": "true" }),
                          h("span", null, typeLabel(t, m.type)),
                          h("span", { style: { marginLeft: "auto", fontVariantNumeric: "tabular-nums" } }, formatRelativeTime(m.updated_at || m.created_at, t))
                        ),
                        pendingIds.has(m.id) && h("span", { className: "mneme-badge mneme-badge--conflict", style: { alignSelf: "flex-start" } }, "⚠ ", t("memory.explorer.conflictBadge")),
                        h("div", { className: "mneme-cardtitle" }, m.title || (m.content || "").slice(0, 60)),
                        h("div", { className: "mneme-cardexcerpt" }, m.content || ""),
                        h("div", { className: "mneme-cardfoot" },
                          h(ImportanceStars, { value: m.importance || 0, size: 12 }),
                          h(HeatBadge, { value: m.heat }),
                          h(ScopeBadge, { m, t }),
                          h(ForeignBadge, { m, t }),
                          m.source && h("span", { className: "mneme-cardsrc", title: m.source }, m.source)
                        )
                      )),
                h("div", { ref: moreRef, className: "mneme-xmore", style: { gridColumn: "1 / -1" } },
                  canLoadMore
                    ? h("button", { className: "mneme-footbtn", disabled: loadingMore, onClick: loadMore },
                        loadingMore ? "…" : `${t("memory.explorer.loadMore")}（${items.length}/${total}）`)
                    : (!loading && visible.length > 0 && !q && !remoteItems
                        ? h("span", { className: "mneme-xcount" }, `${items.length} / ${total}`)
                        : null))
              )
            : h("div", { className: "mneme-xbrowse" },
            h("div", { className: "mneme-xtree" },
              h("div", { className: "mneme-xcolhead" }, t("memory.explorer.timeline")),
              loading
                ? h("div", { className: "mneme-xempty" }, "…")
                : visible.length === 0
                  ? h("div", { className: "mneme-xempty" },
                      h(Icon, { name: "inbox", size: 20, className: "mneme-xemptyico" }),
                      t("memory.explorer.empty"))
                  : months.map((month, mi) => {
                      // Only the newest month starts expanded; older months
                      // stay a one-line header until clicked — a several-
                      // thousand-row store renders a handful of DOM nodes.
                      const open = expandedMonths ? !!expandedMonths[month.key] : mi === 0;
                      return h("div", { key: month.key },
                        h("button", {
                          className: "mneme-xmonth",
                          "aria-expanded": String(open),
                          onClick: () => setExpandedMonths((c) => {
                            const base = c || (months.length ? { [months[0].key]: true } : {});
                            return { ...base, [month.key]: !open };
                          })
                        },
                          h("span", { className: "mneme-xcaret" }, h(Icon, { name: open ? "chevronDown" : "chevronRight", size: 12 })),
                          h("span", null, month.label),
                          h("span", { className: "mneme-xmonthcount" }, String(month.count))
                        ),
                        open && month.days.map((day) =>
                          h("div", { key: day.key },
                            h("button", {
                              className: "mneme-xday",
                              "aria-expanded": String(!collapsed[day.key]),
                              onClick: () => setCollapsed((c) => ({ ...c, [day.key]: !c[day.key] }))
                            },
                              h("span", { className: "mneme-xcaret" }, h(Icon, { name: collapsed[day.key] ? "chevronRight" : "chevronDown", size: 11 })),
                              day.label
                            ),
                            !collapsed[day.key] && day.items.map((m) => {
                              const d = new Date(m.updated_at || m.created_at || 0);
                              const time = Number.isNaN(d.getTime())
                                ? ""
                                : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
                              return h("button", {
                                key: m.id,
                                ref: (el) => { if (el) itemRefs.current.set(m.id, el); else itemRefs.current.delete(m.id); },
                                className: m.id === selectedId ? "mneme-xitem mneme-active" : "mneme-xitem",
                                onClick: () => setSelectedId(m.id)
                              },
                                h("span", { className: "mneme-xdot", style: { color: memoryTypeColor(m.type) }, title: typeLabel(t, m.type), "aria-hidden": "true" }),
                                h("span", { className: "mneme-xtime" }, time),
                                h("span", { className: "mneme-xname" }, m.title || m.content?.slice(0, 40)),
                                h(ScopeBadge, { m, t }),
                                h(ForeignBadge, { m, t })
                              );
                            })
                          ))
                      );
                    }),
              h("div", { ref: moreRef, className: "mneme-xmore" },
                canLoadMore
                  ? h("button", { className: "mneme-footbtn", disabled: loadingMore, onClick: loadMore },
                      loadingMore ? "…" : `${t("memory.explorer.loadMore")}（${items.length}/${total}）`)
                  : (!loading && visible.length > 0 && !q && !remoteItems
                      ? h("span", { className: "mneme-xcount" }, `${items.length} / ${total}`)
                      : null)
              )
            ),
            ),
          ),
      // 详情抽屉：卡片/时间线共用，选中即从右侧滑出（替代旧底部面板）。
      // 两步删除确认在抽屉内完成；编辑/归档经 /update 落库并同步本地视图。
      // 保持为 .mneme-xmain 直接子元素：抽屉锚在 xmain 的 relative 层上，随
      // 两栏改版内容区变宽，抽屉锚点不变。
      selected && h(MemoryDrawer, {
        key: selected.id,
        t,
        memory: selected,
        conflict: pendingIds.has(selected.id),
        deleting,
        deleteError,
        onClose: () => setSelectedId(null),
        onDelete: deleteById,
        onSaved: applyMemoryUpdate,
        onUndone: (n) => {
          // 撤掉的是整包：选中那一行已经不存在，关抽屉 + 刷新列表 + 一句 toast
          // （toast 形状照详情抽屉里 restored 那一条的先例，不带行号免得漂）。
          setSelectedId(null);
          setReloadKey((k) => k + 1);
          broadcastStoreChanged("pack-undo");
          setToastMsg(t("memory.explorer.undoPackDone").replace("{n}", String(n)));
          setTimeout(() => setToastMsg(""), 2500);
        }
      })
        ),
        view === "entity" && h(EntityPanel, { t, focusEntity: graphFocus, onJumpMemory: jumpToMemory }),
        view === "status" && h(StatusPanel, { t, onBrowse: browseWithFilter }),
        view === "settings" && h("div", { className: "mneme-set" },
          h("div", { className: "mneme-set-inner" }, h(SettingsContent, { t }))
        ),
        view === "affective" && h(AffectivePanel, { t }),
        view === "persona" && h("div", { className: "mneme-set" },
          h("div", { className: "mneme-set-inner" }, h(PersonaMainPanel, { t }))
        ),
        view === "diary" && h("div", { className: "mneme-set" },
          h("div", { className: "mneme-set-inner" }, h(DiaryLibraryPanel, { t }))
        ),
        toastMsg && h("div", { className: "mneme-toast", role: "status" }, toastMsg)
      );
    }

    // --- Sidebar entry: 侧边栏里的记忆入口 ---
    // 注册仍在 sidebar.footer.action（list 插槽）——它既是 React 树的挂载
    // 锚点，也是 portal 失效时的原位回退；常驻 sheet 也从这个插槽挂载。
    // 入口形状跟着宿主 v0.2 的侧边栏走，分两态：
    //  · 展开态：宿主把「插件 / 自动化任务」这类全局面板渲染成 nav.panelList
    //    里的 panelRow（36px 行高、透明底、图标 + 标题）。我们把按钮 portal 进
    //    同一组并原样套用宿主 panelRow 的实时类名，于是它是该组的一行——低调，
    //    而不是 v0.8.10 那样长得像第二个高亮「新会话」按钮。落点是「更多」行
    //    之前而不是组尾：宿主 0.2.2 起把「更多」追加进同一个 nav，组尾已不再是
    //    面板行，落在它下面会被展开的菜单盖住（#573）。
    //  · 收起态（Windows 标题栏）：panelList / regionArea / footArea 被宿主
    //    display:none，只有开关与「新会话」被改成固定在标题栏上。我们把按钮搬回
    //    标题栏、并排在「新会话」右侧（84px / 120px 的算法见上面 CSS 注释），
    //    三颗图标各就各位——v0.8.10 把入口留在宿主的 48px 上把它盖住了。
    // 承载类名一律从活元素读取（宿主/皮肤会异步改写哈希类名），不硬编码；
    // 面板列表不存在（没装任何面板插件）时退回「新会话」行之后。
    // 宿主结构异常时约 2 秒后放弃 portal，footer 回退按钮保持可用。
    // #177：未处理冲突数 badge——数据走 dream-status 的 pendingConflicts（与状态卡
    // 同一端点）。挂侧边栏入口按钮右上角（portal 与回退两处都挂），让用户不进面板
    // 也知道有冻结要裁决。
    // 刷新时机（用户反馈「裁决完红点消失得很慢」后重做）：
    //  · 裁决成功时冲突队列广播 mneme:conflicts-changed → 立刻重取，不必等下一轮；
    //    此前这条广播只有状态卡订阅，红点漏订，才慢到要等 60s 兜底轮询；
    //  · openLibrary 打开面板时重取（见上）；
    //  · 60s 兜底轮询——后台 autoDream 自己产生/消解冲突时没人广播，靠它浮现。
    // 计数是模块级单例：入口按钮的 portal 与 footer 回退是两个组件，原先各起一个
    // 60s 轮询（两份请求、两个互不同步的计数）。现在共享一个 store：一次取回广播给
    // 全部订阅者，in-flight 请求也去重，最后一个订阅者离开才停表。
    const conflictBadgeCount = (() => {
      const listeners = new Set();
      let value = 0;
      let timer = null;
      let inflight = null;
      const publish = (next) => {
        if (next === value) return;
        value = next;
        listeners.forEach((fn) => {
          try { fn(value); } catch { /* 单个订阅者出错不拖垮其余 */ }
        });
      };
      const refresh = () => {
        if (inflight) return inflight;
        inflight = apiFetch("/api/dsh-mneme/dream-status")
          .then((res) => (res.ok ? res.json() : { pendingConflicts: 0 }))
          .then((d) => { publish(Number((d && d.pendingConflicts) ?? 0) || 0); })
          .catch(() => { publish(0); })
          .finally(() => { inflight = null; });
        return inflight;
      };
      return {
        get: () => value,
        refresh,
        subscribe: (fn) => {
          listeners.add(fn);
          fn(value);
          if (listeners.size === 1) {
            refresh();
            timer = setInterval(refresh, 60_000);
          }
          return () => {
            listeners.delete(fn);
            if (listeners.size === 0 && timer !== null) { clearInterval(timer); timer = null; }
          };
        }
      };
    })();
    function useConflictBadgeCount() {
      const [pending, setPending] = useState(() => conflictBadgeCount.get());
      useEffect(() => {
        const unsubscribe = conflictBadgeCount.subscribe(setPending);
        const onChanged = () => { conflictBadgeCount.refresh(); };
        window.addEventListener("mneme:conflicts-changed", onChanged);
        // 涉及冲突的记忆在别处被删除/恢复时 pending 集同样会变——裁决广播
        // 之外的第二条失效路径（此前只能等 60s 兜底轮询）。
        window.addEventListener("mneme:store-changed", onChanged);
        return () => {
          unsubscribe();
          window.removeEventListener("mneme:conflicts-changed", onChanged);
          window.removeEventListener("mneme:store-changed", onChanged);
        };
      }, []);
      return pending;
    }
    function ConflictBadge({ pending }) {
      if (!pending || pending <= 0) return null;
      return h("span", { className: "mneme-entrybadge", "aria-hidden": "true" },
        pending > 99 ? "99+" : String(pending));
    }
    // --- 宿主内整页面板（新版宿主）：侧栏图标 + 中列整页 ---
    // 首选承载方式：记忆库直接长在宿主中列里，与会话平级，不再叠一层背板
    // 浮层。老宿主没声明 sidebar.panellist 时退回 footer.action + 浮层（见 apply）。
    function SidebarPanelGlyph({ size }) {
      // 红点复用模块级单例：图标与回落按钮共享同一个计数、同一条 60s 兜底轮询。
      const pending = useConflictBadgeCount();
      // 宿主 PanelRow 已经自带 button / aria-label / Tooltip / active 高亮，
      // 这里只交一颗图形——再造一层按钮会套出两颗可聚焦元素，Tab 要停两次，
      // 而且 host 的 selectPanel 也轮不到我们调。
      return h("span", { className: "mneme-paneliglyph" },
        renderMnemeMark({ size: size || 18 }),
        h(ConflictBadge, { pending })
      );
    }

    function MnemeMainPanel({ t }) {
      // 进面板 = 用户准备处理冻结冲突：重取一次红点计数。理由与浮层时代
      // openLibrary 里那次重取相同——裁决走别的路径或后台刚写过库时，计数
      // 不该等 60s 兜底轮询才对齐。
      useEffect(() => { conflictBadgeCount.refresh(); }, []);
      // 不自带「回到会话」按钮：宿主的 openSession / 新建会话都会
      // selectPanel(null)，用户点侧栏任何会话行就回得去（baleen 同样不做）。
      return h("div", { className: "mneme-panel" },
        h(MemoryExplorer, { t })
      );
    }

    function SidebarFallbackTrigger({ wide, t }) {
      const pending = useConflictBadgeCount();
      // #295 评审：.mneme-trigger 自身 overflow:hidden 且无定位上下文，badge
      // 直接放里面会被裁剪——包一层定位容器，badge 挂在容器上。
      return h("div", { className: "mneme-triggerwrap" },
        h("button", {
          type: "button",
          className: wide ? "mneme-trigger" : "mneme-trigger mneme-rail",
          "aria-label": pending > 0
            ? `${t("memory.sidebar.aria")} · ${t("memory.status.conflicts")} ${pending}`
            : t("memory.sidebar.aria"),
          title: t("memory.panel.open"),
          onClick: openLibrary,
          "data-mneme-overlay-opener": "true"
        },
          renderMnemeMark({ size: wide ? 16 : 18 }),
          wide && h("span", { className: "mneme-trigger-label" }, t("memory.panel.open"))
        ),
        h(ConflictBadge, { pending })
      );
    }

    function SidebarTopEntry({ wide, t, fallback }) {
      const [host, setHost] = useState(null);
      const [cls, setCls] = useState({ row: "", glyph: "", title: "" });
      const pending = useConflictBadgeCount();
      useEffect(() => {
        if (!reactDom || typeof document === "undefined") return undefined;
        let tries = 0, timer = null, created = null, mo = null;
        const findRegion = () => {
          const region = document.querySelector('[class*="regionArea"]');
          return region && region.parentElement ? region : null;
        };
        const findNative = (region) =>
          region.parentElement.querySelector('[class*="newSession"]')
          || region.previousElementSibling;
        const findPanelList = (region) =>
          region.parentElement.querySelector('[class*="panelList"]');
        // 宿主自己的面板行：排除我们自己 portal 进去的那颗按钮（它也带 panelRow）。
        const findPanelRow = (region) => {
          const list = findPanelList(region);
          return list ? list.querySelector('[class*="panelRow"]:not(.mneme-topentry-native)') : null;
        };
        // 面板列表里的「更多」行（宿主 PanelMoreMenu 的锚点）。宿主 0.2.2 起先渲染
        // 面板行、再把「更多」追加进同一个 nav，于是列表最后一项不再是面板行——
        // 我们的入口若仍 appendChild 到末尾就会落在它下面，菜单一展开就盖住入口
        // （#573）。按 [class*=] 前缀找，和其余几处一样不写死哈希类名；老宿主
        // 没有这行时返回 null，退回追加到末尾的老行为。
        const findMoreAnchor = (list) => list.querySelector('[class*="moreAnchor"]');
        // 占位锚点：新会话行（现役外壳里 newSession 按钮嵌在 logoRow 内，
        // 旧外壳是根的直接子按钮）。判定与生态插件的 sidebar-entry-core
        // 一致；锚点不可靠时回退到 regionArea 之前的旧位置。
        const findAnchor = (region) => {
          const parent = region.parentElement;
          const btn = parent.querySelector('[class*="newSession"]');
          if (!btn) return null;
          const row = btn.closest('[class*="logoRow"]');
          if (row && row.parentElement === parent) return row;
          return btn.parentElement === parent ? btn : null;
        };
        // 占位规则：紧跟新会话行（插件入口组的顶部），幂等——已在锚点位就
        // 不动 DOM。生态插件后插入时会把我们压下去一位，观察器里重排搬回；
        // 它们只在自身节点被移除时才重插，不会与我们来回争抢。
        // 注意 created 已紧跟锚点时 target 即 created 自身，必须直接返回：
        // insertBefore(x, x) 在 Chromium 里不是 no-op，会触发 mutation 造成
        // 观察器自激风暴、冻死整个 SPA。
        const place = (region) => {
          if (!created) return;
          const parent = region.parentElement;
          if (!parent) return;
          // 展开态落进宿主的面板列表（紧跟「插件 / 自动化任务」）；宿主没有面板
          // 列表时退回「新会话」行之后，由 .mneme-topentry-native 兜住低调行样式。
          const list = wide ? findPanelList(region) : null;
          if (list) {
            // 落在面板组末尾、但在「更多」行之前（#573）；没有「更多」行时组尾
            // 就是终点，退回老行为。
            const more = findMoreAnchor(list);
            if (more) {
              if (created.parentElement === list && created.nextElementSibling === more) return;
              list.insertBefore(created, more);
              return;
            }
            if (created.parentElement === list && created === list.lastElementChild) return;
            list.appendChild(created);
            return;
          }
          const anchor = findAnchor(region);
          const target = anchor ? anchor.nextSibling : region;
          if (target === created) return;
          if (created.parentElement === parent && created.nextSibling === target) return;
          parent.insertBefore(created, target);
        };
        // 类名一律从活元素读。展开态借宿主面板行的盒模型，并剔掉激活态修饰类
        // （否则我们的行会跟着宿主当前选中的面板一起常亮）；收起态借「新会话」
        // 按钮的类名拿整套标题栏固定几何。两处都取不到时留空，由我们的类兜底。
        const readCls = (region) => {
          if (!wide) return { row: findNative(region)?.className || "", glyph: "", title: "" };
          const row = findPanelRow(region);
          const btn = row || findNative(region);
          const glyph = row && row.querySelector('[class*="panelGlyph"]');
          const title = row && row.querySelector('[class*="panelTitle"]');
          return {
            row: (btn?.className || "")
              .split(/\s+/)
              .filter((name) => name && !name.includes("panelActive"))
              .join(" "),
            glyph: (glyph && glyph.className) || "",
            title: (title && title.className) || ""
          };
        };
        const sync = (region) => {
          const next = readCls(region);
          setCls((prev) => (prev.row === next.row && prev.glyph === next.glyph && prev.title === next.title ? prev : next));
        };
        const attempt = () => {
          const region = findRegion();
          if (region) {
            // 宿主切换展开/收起时会重排 DOM（面板列表 → 标题栏固定位），所以每次
            // 变动都重新落位并重读类名；宿主/皮肤异步改写类名也靠这条同步，否则
            // portal 按钮会停留在捕获时刻的旧类上（宽度/对齐失配）。
            created = document.createElement("div");
            created.dataset.pluginEntry = "@modusensus/dsh-mneme";
            place(region);
            setHost(created);
            sync(region);
            mo = new MutationObserver(() => {
              const cur = findRegion();
              if (!cur) return;
              place(cur);
              sync(cur);
            });
            mo.observe(region.parentElement, {
              attributes: true,
              attributeFilter: ["class"],
              childList: true,
              subtree: true
            });
            return;
          }
          if (++tries > 40) return; // 放弃 portal，footer 回退保持可用
          timer = setTimeout(attempt, 50);
        };
        attempt();
        return () => {
          clearTimeout(timer);
          if (mo) mo.disconnect();
          if (created && created.parentElement) created.parentElement.removeChild(created);
        };
      }, [wide]);
      if (!host) return fallback;
      // 图标与「插件 / 自动化任务」同档（16px）；收起态沿用标题栏里原来的 18px。
      const icon = renderMnemeMark({ size: wide ? 16 : 18 });
      return reactDom.createPortal(
        h("div", { className: "mneme-topentry" },
          h("button", {
            type: "button",
            // 展开态：宿主面板行类名 + 我们的同款兜底；收起态：宿主「新会话」类名
            // + 只覆盖 left 的 rail 规则（整套标题栏几何继承宿主）。
            className: wide
              ? `${cls.row} mneme-topentry-native`.trim()
              : `${cls.row} mneme-topentry-rail`.trim(),
            "aria-label": pending > 0
              ? `${t("memory.sidebar.aria")} · ${t("memory.status.conflicts")} ${pending}`
              : t("memory.sidebar.aria"),
            title: t("memory.panel.open"),
            onClick: openLibrary,
            "data-mneme-overlay-opener": "true"
          },
            // 图标套上宿主面板行的槽位类名，视觉与同组入口完全一致；取不到时裸渲染。
            cls.glyph ? h("span", { className: cls.glyph, "aria-hidden": "true" }, icon) : icon,
            wide && h("span", { className: `${cls.title} mneme-topentry-label`.trim() }, t("memory.panel.open")),
            h(ConflictBadge, { pending })
          )
        ), host);
    }

    // ---------------------------------------------------------------------
    // v0.9.0 M.O.（beta，只读）
    // 定性：trace viewer 不是编辑画布——节点=步骤、边=依赖、一次运行=一条
    // 被高亮走过的路径。本版数据全部是 §4 mneme.pipeline/v1 形状的假数据，
    // 服务端管线落地前先验证形态与交互。
    // ---------------------------------------------------------------------
    const PIPELINE_ACTIONS_TAB_ID = "dsh-mneme:actions";
    const PIPELINE_ACTIONS_TAB_KIND = "mneme-actions";

    // 节点状态四值，refuted 是全篇核心信号（最扎眼）。
    const PIPELINE_STATES = ["candidate", "trusted", "stale", "refuted"];

    // 数据面 = **项目里**的工作流（服务端 /api/dsh-mneme/pipeline 投影成 mneme.pipeline/v1）。
    // 项目从哪来：只有客户端拿得到会话的工作目录，所以这里解析出 cwd、当 ?project= 带上；
    // 服务端没有「当前项目」这个概念，也不许替谁猜一个。
    // 为什么四个座位共用缓存、且缓存**按项目 + 按工作流**分桶：四个座位读的必须是同一份
    // ——「会话头说有 3 条、右栏说有 5 条」这种分家没人查得出来；同理，同一个进程里开着
    // 两个不同项目的会话时，不分桶就会把 A 项目的清单端给 B 项目看，而画面看不出错。
    const pipelineDocs = new Map();
    const pipelinePendingByKey = new Map();
    function pipelineKey(project, id) { return (project || "") + "\u0000" + (id || ""); }
    function loadPipeline(project, id) {
      const key = pipelineKey(project, id);
      if (!pipelinePendingByKey.has(key)) {
        const params = [];
        if (project) params.push("project=" + encodeURIComponent(project));
        if (id) params.push("id=" + encodeURIComponent(id));
        const url = "/api/dsh-mneme/pipeline" + (params.length ? "?" + params.join("&") : "");
        pipelinePendingByKey.set(key, apiFetch(url)
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null)
          .then((doc) => { pipelineDocs.set(key, doc); return doc; }));
      }
      return pipelinePendingByKey.get(key);
    }
    // undefined = 还在读；null = 读不出来；对象 = 拿到了（其中 pipeline 为 null 表示
    // 这个项目里还没有工作流——那是空态，不是错误，别把两者画成同一张脸）。
    // id 为空 = 取清单（服务端会顺带给出第一条的完整投影，够结算卡用）。
    function usePipeline(project, id) {
      const key = pipelineKey(project, id);
      const [doc, setDoc] = useState(pipelineDocs.has(key) ? pipelineDocs.get(key) : undefined);
      useEffect(() => {
        let alive = true;
        loadPipeline(project, id).then((d) => { if (alive) setDoc(d); });
        return () => { alive = false; };
      }, [key]);
      return doc;
    }
    // 会话工作目录。两条来源依次试，各自兜自己的异常——一条抛了不能把另一条也带走；
    // 两处都试不到就**返回 null**（面板退到全局层，并如实标「项目未知」），绝不退回进程
    // 目录之类的东西——那会把「读不到」变成「读到别处」，而后者在界面上看不出来，是最难
    // 查的一类错。
    // 首选会话列表快照：byId[sessionId].cwd 是宿主给客户端的公开形状（dsh-context 用的
    // 就是这条）；sessions.get() 是宿主侧写法，客户端不一定有，所以放第二位。
    function sessionProject(ctx, sessionId) {
      if (!sessionId || !ctx || typeof ctx.get !== "function") return null;
      const warn = (err) => console.warn("[dsh-mneme] session cwd lookup failed:", err);
      const pick = (row) => {
        if (!row) return null;
        const cwd = (row.header && row.header.cwd) || row.cwd;
        return typeof cwd === "string" && cwd ? cwd : null;
      };
      let sessions = null;
      try { sessions = ctx.get("sessions"); } catch (err) { warn(err); }
      if (sessions) {
        try {
          const snap = sessions.list && typeof sessions.list.getSnapshot === "function"
            ? sessions.list.getSnapshot()
            : null;
          const hit = pick(snap && snap.byId ? snap.byId[sessionId] : null);
          if (hit) return hit;
        } catch (err) { warn(err); }
        try {
          if (typeof sessions.get === "function") {
            const hit = pick(sessions.get(sessionId));
            if (hit) return hit;
          }
        } catch (err) { warn(err); }
      }
      return null;
    }

    // 会话身份：`header.agentPreset` 就是这个人格卡的名字（服务侧
    // sessionAgentId 读的是同一个字段，两边必须同源，否则会写出「A 的人格 +
    // B 的素材」）。拿不到就回 null——绝不假猜成 default，那是另一张卡的文本。
    function sessionAgent(ctx, sessionId) {
      if (!sessionId || !ctx || typeof ctx.get !== "function") return null;
      const pick = (row) => {
        if (!row) return null;
        const preset = (row.header && row.header.agentPreset) || row.agentPreset;
        return typeof preset === "string" && preset.trim() ? preset.trim() : null;
      };
      try {
        const sessions = ctx.get("sessions");
        if (!sessions) return null;
        try {
          const snap = sessions.list && typeof sessions.list.getSnapshot === "function"
            ? sessions.list.getSnapshot()
            : null;
          const hit = pick(snap && snap.byId ? snap.byId[sessionId] : null);
          if (hit) return hit;
        } catch (err) { console.warn("[dsh-mneme] session agent lookup failed:", err); }
        try {
          if (typeof sessions.get === "function") {
            const hit = pick(sessions.get(sessionId));
            if (hit) return hit;
          }
        } catch (err) { console.warn("[dsh-mneme] session agent lookup failed:", err); }
      } catch (err) {
        console.warn("[dsh-mneme] sessions service unavailable:", err);
      }
      return null;
    }

    // DAG 分层布局：Kahn 最长路分层（层数 = 到该节点最长边数），
    // 防环——正常分层算完后如果还有节点没落位（说明有环），
    // 按输入顺序塞进最后一层，绝不死循环。节点数少，几十行够用。
    function layoutDag(nodes, edges) {
      const byId = {};
      for (const n of nodes) byId[n.id] = n;
      const indeg = {};
      const out = {};
      for (const n of nodes) { indeg[n.id] = 0; out[n.id] = []; }
      for (const e of edges) {
        if (!byId[e.from] || !byId[e.to] || e.from === e.to) continue;
        out[e.from].push(e.to);
        indeg[e.to] += 1;
      }
      const layer = {};
      const queue = nodes.filter((n) => indeg[n.id] === 0).map((n) => n.id);
      const remaining = {};
      for (const n of nodes) remaining[n.id] = indeg[n.id];
      while (queue.length) {
        const id = queue.shift();
        for (const to of out[id]) {
          layer[to] = Math.max(layer[to] || 0, (layer[id] || 0) + 1);
          remaining[to] -= 1;
          if (remaining[to] === 0) queue.push(to);
        }
      }
      const maxLayer = nodes.reduce((m, n) => Math.max(m, layer[n.id] || 0), 0);
      const leftovers = nodes.filter((n) => remaining[n.id] > 0);
      for (const n of leftovers) layer[n.id] = maxLayer + 1; // 环兜底
      const layers = [];
      for (const n of nodes) {
        const L = layer[n.id] || 0;
        (layers[L] = layers[L] || []).push(n.id);
      }
      return { layer, layers: layers.map((l) => l || []) };
    }

    // 阶段带布局（2026-10-16）：layoutDag 只按 DAG 深度分层、不读 phase，把 5 段
    // 19 步排成 18 层的单列长链（固有 354×1902px），第一屏既看不出「分几段」也
    // 读不出「谁在做」。这里按 step.phase 分组（保持作者书写顺序——phase 是人手
    // 写的分类词，不能按字母重排）、段内左到右每行两列换行：画布固有宽度落回
    // 354px（右栏 400px 不缩放就能读），高度从 1902 腰斩到 ~836。
    // 纯函数、不碰 DOM：探针 .scratch/mo-ux-probe-layout.mjs 会把它抠出来真跑，
    // 改签名或引用外部变量都会让那条可重跑核算失明。
    function layoutPipelineBands(nodes, edges, C) {
      const NW = (C && C.NW) || 150;
      const NH = (C && C.NH) || 54;
      const GX = (C && C.GX) || 30;
      const PAD = (C && C.PAD) || 12;
      const COLS = 2, ROW_GAP = 14, BAND_HEAD = 26, BAND_GAP = 18;
      const order = [];
      const byPhase = {};
      for (const n of nodes) {
        const ph = n.phase || "";
        if (!byPhase[ph]) { byPhase[ph] = []; order.push(ph); }
        byPhase[ph].push(n.id);
      }
      const pos = {};
      const bands = [];
      const bandRects = [];
      const W = PAD * 2 + COLS * NW + (COLS - 1) * GX;
      let y = PAD;
      for (const ph of order) {
        const ids = byPhase[ph];
        const rows = Math.ceil(ids.length / COLS);
        const top = y;
        y += BAND_HEAD;
        ids.forEach((id, i) => {
          const r = Math.floor(i / COLS), c = i % COLS;
          pos[id] = { x: PAD + c * (NW + GX), y: y + r * (NH + ROW_GAP) };
        });
        y += rows * NH + (rows - 1) * ROW_GAP;
        bands.push({ name: ph, count: ids.length, top, bottom: y });
        bandRects.push({ name: ph, count: ids.length, x: PAD - 6, y: top, w: W - 2 * (PAD - 6), h: y - top });
        y += BAND_GAP;
      }
      const H = y - BAND_GAP + PAD;
      return { pos, W, H, bands, bandRects };
    }

    // 标题两行拆分：pipeClip 一刀截 11 字把「定版本号与发布范围」截成「…发布范…」。
    // 节点加高到 54px 后装得下两行——标本 19 个标题里 7 个超 11 字、最长 22 字，
    // 恰好两行放全；超长兜底仍留省略号。
    function pipeTitleLines(s, n) {
      const str = String(s || "");
      if (str.length <= n) return [str];
      const head = str.slice(0, n);
      const rest = str.slice(n);
      return [head, rest.length > n ? rest.slice(0, n - 1) + "…" : rest];
    }

    function pipeFmtWhen(iso) {
      if (!iso) return "";
      const d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      const p = (x) => String(x).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    function pipeClip(s, n) {
      const str = String(s || "");
      return str.length > n ? str.slice(0, n - 1) + "…" : str;
    }
    function pipeDaysAgo(iso) {
      if (!iso) return null;
      const d = new Date(iso);
      if (isNaN(d.getTime())) return null;
      return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
    }

    // 运行档位：一次运行一个芯片；失败/被推翻的运行照常列出（留痕）。
    function PipelineRunChips(props) {
      const { t, runs, selectedRunId, onSelectRun } = props;
      return h("div", { className: "mneme-pipe-runs", role: "group", "aria-label": t("memory.actions.runs") },
        h("span", { className: "mneme-pipe-scope" }, t("memory.actions.runs")),
        (runs || []).map((r, i) => h("button", {
          key: r.id || i,
          type: "button",
          className: "mneme-pipe-run" + (r.id === selectedRunId ? " mneme-on" : ""),
          onClick: () => onSelectRun && onSelectRun(r.id),
          title: t("memory.actions.run." + (r.outcome || "ok"))
        },
          h("span", { className: "mneme-pipe-runDot mneme-pipe-runDot--" + (r.outcome || "ok"), "aria-hidden": "true" }),
          t("memory.actions.runOf").replace("{n}", String(i + 1)) + " · " + pipeFmtWhen(r.at)
        ))
      );
    }

    // 宽态 DAG：按 phase 分阶段带的 SVG，一次运行 = 一条高亮路径（trace viewer 读法）。
    // 分组与几何来自 layoutPipelineBands（纯函数，探针真跑它），这里只管画。
    function PipelineGraphSvg(props) {
      const { t, data, run, selectedNodeId, onSelectNode } = props;
      const nodes = data.nodes || [];
      const edges = data.edges || [];
      const pathSet = {};
      const edgeState = {};
      if (run && Array.isArray(run.path)) {
        for (const id of run.path) pathSet[id] = true;
        for (let i = 0; i + 1 < run.path.length; i++) {
          const a = run.path[i];
          const b = run.path[i + 1];
          const isLast = i + 2 === run.path.length;
          edgeState[a + ">" + b] = run.outcome === "failed" && isLast ? "fail" : "on";
        }
      }
      const usedSet = {};
      if (run && Array.isArray(run.usedNodeIds)) {
        for (const id of run.usedNodeIds) usedSet[id] = true;
      }
      const NW = 150, NH = 54, GX = 30, GY = 66, PAD = 12;
      const laid = layoutPipelineBands(nodes, edges, { NW, NH, GX, GY, PAD });
      const pos = laid.pos;
      const W = laid.W;
      const Hh = laid.H;
      const KIND_RX = { step: 8, gate: 4, branch: 16, artifact: 21 };
      return h("svg", {
        className: "mneme-pipe-svg",
        viewBox: `0 0 ${W} ${Hh}`,
        width: W,
        height: Hh,
        role: "img",
        "aria-label": t("memory.actions.title")
      },
        // 阶段带：段底 + 段名与该段步数。分段信息画在节点之下、边之下——
        // 它是背景不是主角，但必须先上屏，第一屏才读得出「分几段」。
        laid.bandRects.map((b, i) => h("g", { key: "band" + i },
          h("rect", {
            className: "mneme-pipe-bandbg",
            x: b.x, y: b.y, width: b.w, height: b.h, rx: 10
          }),
          i > 0 ? h("line", {
            className: "mneme-pipe-bandline",
            x1: PAD, x2: W - PAD, y1: b.y - 9, y2: b.y - 9
          }) : null,
          h("text", {
            className: "mneme-pipe-bandT",
            x: PAD + 4, y: b.y + 17
          }, (b.name || "") + " · " + t("memory.actions.band.count").replace("{n}", String(b.count)))
        )),
        edges.map((e) => {
          const a = pos[e.from];
          const b = pos[e.to];
          if (!a || !b) return null;
          const st = edgeState[e.from + ">" + e.to];
          const cls = st === "fail" ? "mneme-pipe-edgeFail" : st === "on" ? "mneme-pipe-edgeOn" : "mneme-pipe-edge";
          // 同行相邻（蛇形读法）：右缘出、左缘进，短水平贝塞尔；
          // 跨行/跨段仍走「底出顶进」的竖向贝塞尔。同行旧画法会把线甩出段外
          // （真机截图验出），横连读起来就是「往下一段走」。
          let d;
          if (b.y === a.y && b.x > a.x) {
            const ym = a.y + NH / 2;
            d = `M ${a.x + NW} ${ym} C ${a.x + NW + GX / 2} ${ym}, ${b.x - GX / 2} ${ym}, ${b.x} ${ym}`;
          } else {
            const x1 = a.x + NW / 2, y1 = a.y + NH, x2 = b.x + NW / 2, y2 = b.y;
            d = `M ${x1} ${y1} C ${x1} ${y1 + 26}, ${x2} ${y2 - 26}, ${x2} ${y2}`;
          }
          return h("path", {
            key: e.id || (e.from + ">" + e.to),
            className: cls,
            d
          }, e.label ? h("title", null, e.label) : null);
        }),
        nodes.map((n) => {
          const p = pos[n.id];
          if (!p) return null;
          const rx = KIND_RX[n.kind] != null ? KIND_RX[n.kind] : 8;
          const on = !!(run && pathSet[n.id]);
          const gate = n.kind === "gate";
          const cls = "mneme-pipe-node mneme-pipe-node--" + (n.state || "candidate")
            + (usedSet[n.id] ? " mneme-pipe-node--onpath" : "")
            + (gate ? " mneme-pipe-node--gate" : "");
          const lines = pipeTitleLines(n.title, 10);
          // meta 行三段：状态（四态）· who（主/人/CI）· risk（R0-R3）。
          // who/risk 都是投影自带字段，此前一个都没上屏；risk 缺失按 R0 兜底。
          const meta = [
            t("memory.actions.state." + (n.state || "candidate")),
            n.who ? t("memory.actions.who." + n.who) : null,
            n.risk || "R0"
          ].filter(Boolean).join(" · ");
          return h("g", {
            key: n.id,
            onClick: () => onSelectNode && onSelectNode(n.id),
            style: { cursor: "pointer" }
          },
            h("rect", {
              className: cls,
              x: p.x, y: p.y, width: NW, height: NH, rx
            }),
            // 风险色条：左缘一条竖线做冗余编码，信息本体在 meta 行的 R 文本里。
            h("line", {
              className: "mneme-pipe-risk--" + String(n.risk || "R0").toLowerCase(),
              x1: p.x + 3, y1: p.y + 8, x2: p.x + 3, y2: p.y + NH - 8,
              "stroke-width": 3, "stroke-linecap": "round"
            }),
            // 闸门角标：gate 步会「停下等批准」，与反事实圈同列放右上、圈在其上方——
            // 左上角压 risk 色条（真机截图验出的布局冲突）。
            gate ? h("text", {
              className: "mneme-pipe-gatetag",
              x: p.x + NW - 12, y: p.y + 24, textAnchor: "middle"
            }, t("memory.actions.gate.tag")) : null,
            // 反事实标记：空心圈 = 还没闸门（counterfactual 为 null），
            // 实心圈 = 有对照证据。做在右上角，一眼区分。
            h("circle", {
              cx: p.x + NW - 12, cy: p.y + 11, r: 4,
              fill: n.counterfactual ? "var(--mneme-ok)" : "none",
              stroke: n.counterfactual ? "var(--mneme-ok)" : "var(--mneme-graphic-dim)",
              "stroke-width": 1.5
            }, h("title", null, n.counterfactual ? t("memory.actions.gate.has") : t("memory.actions.gate.none"))),
            lines.length === 1
              ? h("text", {
                  className: "mneme-pipe-nodeT",
                  x: p.x + NW / 2, y: p.y + 24, textAnchor: "middle"
                }, lines[0])
              : [
                  h("text", {
                    key: "t1", className: "mneme-pipe-nodeT",
                    x: p.x + NW / 2, y: p.y + 18, textAnchor: "middle"
                  }, lines[0]),
                  h("text", {
                    key: "t2", className: "mneme-pipe-nodeT",
                    x: p.x + NW / 2, y: p.y + 31, textAnchor: "middle"
                  }, lines[1])
                ],
            h("text", {
              className: "mneme-pipe-nodeS",
              x: p.x + NW / 2, y: p.y + 46, textAnchor: "middle"
            }, meta),
            h("title", null, n.situation || n.title)
          );
        })
      );
    }

    // 图例：四个状态一眼分清 + 闸门有无。「被推翻」最扎眼是全篇核心信号。
    function PipelineLegend(props) {
      const { t } = props;
      return h("div", { className: "mneme-pipe-legend" },
        t("memory.actions.legend.states"),
        PIPELINE_STATES.map((s) => h("span", { key: s, className: "mneme-pipe-pill mneme-pipe-pill--" + s }, t("memory.actions.state." + s))),
        h("span", { className: "mneme-pipe-gate", "aria-hidden": "true" }),
        t("memory.actions.gate.none"),
        h("span", { className: "mneme-pipe-gate mneme-pipe-gate--has", "aria-hidden": "true" }),
        t("memory.actions.gate.has")
      );
    }

    // 节点详情：情形 / 动作 / 为什么 / 反事实（有无两种形态）/ 复用 / 来源。
    function PipelineNodeDetail(props) {
      const { t, node } = props;
      if (!node) return null;
      const credit = node.credit || {};
      const days = pipeDaysAgo(credit.lastUsedAt);
      const rows = [
        ["memory.actions.detail.situation", node.situation],
        ["memory.actions.detail.action", node.action],
        ["memory.actions.detail.why", node.why]
      ].filter(([, v]) => v);
      return h("div", { className: "mneme-pipe-detail", role: "region", "aria-label": node.title },
        h("div", { className: "mneme-pipe-detailTitle" },
          h("span", { className: "mneme-pipe-pill mneme-pipe-pill--" + (node.state || "candidate") }, t("memory.actions.state." + (node.state || "candidate"))),
          " " + node.title
        ),
        rows.map(([k, v]) => h("div", { key: k },
          h("span", { className: "mneme-pipe-dt" }, t(k) + "："), v
        )),
        node.counterfactual
          ? h("div", { className: "mneme-pipe-cf" },
              h("span", { className: "mneme-pipe-dt" }, t("memory.actions.detail.cf") + "："),
              node.counterfactual.contrast || "")
          : h("div", { className: "mneme-pipe-cf mneme-pipe-cf--none" }, t("memory.actions.detail.noCf")),
        h("div", null,
          h("span", { className: "mneme-pipe-dt" }, t("memory.actions.credit") + "："),
          t("memory.actions.creditValue")
            .replace("{n}", String(credit.uses != null ? credit.uses : 0))
            .replace("{d}", days == null ? "—" : String(days))
        ),
        node.source && (node.source.memoryIds || []).length
          ? h("div", null,
              h("span", { className: "mneme-pipe-dt" }, t("memory.actions.detail.source") + "："),
              (node.source.memoryIds || []).join("、"))
          : null
      );
    }

    // 窄态（浮层 / better-sidebar ~500px）：竖排列表——换布局，不是缩放。
    // 边收成左侧轨道线 + 「依赖」芯片；details 手风琴承载详情。
    function PipelineList(props) {
      const { t, data, run, selectedNodeId, onSelectNode } = props;
      const nodes = data.nodes || [];
      const edges = data.edges || [];
      const usedSet = {};
      if (run && Array.isArray(run.usedNodeIds)) for (const id of run.usedNodeIds) usedSet[id] = true;
      const onPath = {};
      if (run && Array.isArray(run.path)) for (const id of run.path) onPath[id] = true;
      const deps = {};
      for (const e of edges) (deps[e.to] = deps[e.to] || []).push(e.from);
      const { layers } = layoutDag(nodes, edges);
      const flat = [];
      layers.forEach((col) => col.forEach((id) => {
        const n = nodes.find((x) => x.id === id);
        if (n) flat.push(n);
      }));
      return h("div", { className: "mneme-pipe-list" },
        flat.map((n) => h("details", {
          key: n.id,
          className: "mneme-pipe-item",
          open: selectedNodeId === n.id || undefined,
          onToggle: (ev) => { if (ev.target && ev.target.open) onSelectNode && onSelectNode(n.id); }
        },
          h("summary", null,
            h("span", {
              className: "mneme-pipe-itemDot mneme-pipe-itemDot--" + (n.state || "candidate") +
                (onPath[n.id] ? " mneme-pipe-itemDot--onpath" : ""),
              "aria-hidden": "true"
            }),
            h("span", { className: "mneme-pipe-itemName" + (n.state === "refuted" ? " mneme-pipe-itemName--refuted" : "") }, n.title),
            h("span", { className: "mneme-pipe-itemMeta" },
              h("span", { className: "mneme-pipe-pill mneme-pipe-pill--" + (n.state || "candidate") }, t("memory.actions.state." + (n.state || "candidate"))),
              (deps[n.id] || []).length ? h("span", { className: "mneme-pipe-dep" }, t("memory.actions.dep") + " " + deps[n.id].join(" ")) : null,
              n.counterfactual ? null : h("span", { className: "mneme-pipe-dep" }, t("memory.actions.gate.none"))
            )
          ),
          h("div", { className: "mneme-pipe-itemBody" },
            n.situation ? h("div", null, h("span", { className: "mneme-pipe-dt" }, t("memory.actions.detail.situation") + "："), n.situation) : null,
            n.action ? h("div", null, h("span", { className: "mneme-pipe-dt" }, t("memory.actions.detail.action") + "："), n.action) : null,
            n.why ? h("div", null, h("span", { className: "mneme-pipe-dt" }, t("memory.actions.detail.why") + "："), n.why) : null,
            n.counterfactual
              ? h("div", { className: "mneme-pipe-cf" }, h("span", { className: "mneme-pipe-dt" }, t("memory.actions.detail.cf") + "："), n.counterfactual.contrast || "")
              : h("div", { className: "mneme-pipe-cf mneme-pipe-cf--none" }, t("memory.actions.detail.noCf"))
          )
        ))
      );
    }

    // 条目清单（名字 + 规模 + 作用域）：图上方的**选择器**。
    // 它解决的是「这是哪条工作流」——一进来就是一张图时这个问题没有落点，多条之间也没得选。
    // 但它不占整屏：图和它同屏，见下面的 PipelineBrowser。
    // 「现在就跑一次」。自动沉淀只在 turn/end 之后跑、还有 10 分钟冷却，所以人想立刻
    // 看到结果时没有入口。这里的 POST 与自动跑走**同一条** nudgeForProject，区别只有
    // materialize：按钮永远不落草稿，只把提议写进记忆库——升格仍然要人批。
    // project 为空（会话里读不到 cwd）时按钮是禁用的：服务端只会回 400，
    // 而一个点了必然失败的按钮比没有按钮更糟。
    function PipelineDistillButton(props) {
      const { t, project } = props;
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState("");
      const disabled = busy || !project;
      const run = () => {
        if (disabled) return;
        setBusy(true);
        setNote("");
        apiFetch("/api/dsh-mneme/nudge?project=" + encodeURIComponent(project), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        })
          .then((res) => res.json().then((j) => ({ ok: res.ok, status: res.status, body: j || {} })))
          .then(({ ok, status, body }) => {
            if (!ok) {
              // 503 = 会话日志读不到（环境问题），其余是这一跑本身失败。两句不能合并：
              // 「读不到」和「没有重复动作」在界面上长得一样时，人就只能瞎猜。
              setNote(t(status === 503
                ? "memory.actions.distill.unreadable"
                : "memory.actions.distill.failed"));
              return;
            }
            if (body.skipped) {
              setNote(t("memory.actions.distill.noSessions"));
              return;
            }
            const saved = (body.counts && body.counts.savedProposals) || 0;
            const found = (body.counts && body.counts.candidates) || 0;
            setNote(found === 0
              ? t("memory.actions.distill.none")
              : t("memory.actions.distill.saved").replace("{n}", String(saved)).replace("{m}", String(found)));
          })
          .catch(() => setNote(t("memory.actions.distill.failed")))
          .then(() => setBusy(false));
      };
      return h("span", { className: "mneme-pipe-distill" },
        h("button", {
          type: "button",
          className: "mneme-pipe-distillBtn",
          disabled,
          title: !project ? t("memory.actions.distill.noProject") : t("memory.actions.distill.hint"),
          onClick: run
        }, busy ? t("memory.actions.distill.busy") : t("memory.actions.distill.action")),
        note ? h("span", { className: "mneme-pipe-distillNote", role: "status" }, note) : null
      );
    }

    function PipelineWorkflowList(props) {
      const { t, data, activeId, onOpen, project } = props;
      const list = (data && data.available) || [];
      const scopeOf = (row) => (row.scope === "global"
        ? t("memory.actions.scope.global")
        : t("memory.actions.scope.project").replace("{name}", row.scopeLabel || row.scope));
      return h("div", { className: "mneme-pipe-wflist" },
        h("div", { className: "mneme-pipe-wfhead" },
          h("span", null, t("memory.actions.list.heading")),
          h("span", null, t("memory.actions.list.count").replace("{n}", String(list.length)))
        ),
        h(PipelineDistillButton, { t, project }),
        list.length
          ? list.map((row) => h("button", {
              key: row.id,
              type: "button",
              className: "mneme-pipe-wf" + (row.id === activeId ? " mneme-on" : ""),
              "aria-current": row.id === activeId ? "true" : undefined,
              onClick: () => onOpen(row.id)
            },
              h("span", { className: "mneme-pipe-wfTop" },
                h("span", { className: "mneme-pipe-wfName" }, row.title || row.id),
                h("span", { className: "mneme-pipe-wfScope" }, scopeOf(row))
              ),
              h("span", { className: "mneme-pipe-wfMeta" }, t("memory.actions.list.meta")
                .replace("{steps}", String(row.steps || 0))
                .replace("{gates}", String(row.gates || 0))
                .replace("{cf}", String(row.contrast || 0))),
              h("span", { className: "mneme-pipe-wfId" }, row.id)
            ))
          // 「读得出来但一份都没有」与「读不出来」是两回事，别画成同一张脸：
          // 前者要告诉人文件该放哪，后者只有 loadPipeline 返回 null 时才是。
          : h("div", { className: "mneme-pipe-empty" },
              h("div", { className: "mneme-pipe-emptyTitle" }, t("memory.actions.empty.title")),
              t("memory.actions.empty.body")
            ),
        data && data.unreadable && data.unreadable.length
          ? h("div", { className: "mneme-pipe-broken" },
              t("memory.actions.broken") + " " + data.unreadable.map((u) => u.detail || u.dir).join("；"))
          : null
      );
    }

    // 清单与图**同屏**：上面清单（选择器），下面画布（主语），默认展开第一条。
    // 形状换过两次，两次的教训都留在这里，免得再翻回去：
    //   一进来就是图 —— 没有名字、没有落点，用户要的是「像 Hermes 那样一串条目」；
    //   清单 ⟷ 图两屏来回切 —— 条目有了，但画布藏在一次点击后面、界面上没有任何提示，
    //   反馈连着两次说「看不到画布和节点」。
    // 两个 usePipeline 都是无条件调用：hook 不能条件调用，而「默认选第一条」这件事
    // 恰好可以放在两个读取之间，不必为此拆组件。
    function PipelineBrowser(props) {
      const { t, project } = props;
      const [picked, setPicked] = useState(null);
      const listDoc = usePipeline(project, null);
      const rows = (listDoc && listDoc.available) || [];
      // 没手选过就跟第一条；手选之后清单再刷新也不跳回去（否则一刷新就把人的选择抹掉）。
      const activeId = picked || (rows.length ? rows[0].id : null);
      const detailDoc = usePipeline(project, activeId);
      return h("div", {
        className: "mneme-pipe",
        style: { height: "100%", display: "flex", flexDirection: "column", minHeight: "0" }
      },
        h(PipelineWorkflowList, { t, data: listDoc, activeId, onOpen: setPicked, project }),
        h(PipelineView, { t, data: detailDoc })
      );
    }

    // 画布缩放。为什么要有：重排前 19 步是一条 18 层竖链（固有 354×1902），被 width:100%
    // 拉到栏宽之后高度上万——只能上下滚；重排成阶段带后（固有 354×836）仍有
    // 「凑近看某一段」的需求。按钮管精确、滚轮管顺手。
    const PIPELINE_ZOOM_MIN = 0.3;
    const PIPELINE_ZOOM_MAX = 4;
    const clampZoom = (z) => Math.min(PIPELINE_ZOOM_MAX, Math.max(PIPELINE_ZOOM_MIN, z));

    function PipelineZoomBar(props) {
      const { t, zoom, onZoom } = props;
      return h("div", { className: "mneme-pipe-zoombar" },
        h("button", {
          type: "button", className: "mneme-pipe-zoombtn",
          title: t("memory.actions.zoom.out"), "aria-label": t("memory.actions.zoom.out"),
          onClick: () => onZoom(zoom / 1.25)
        }, "−"),
        h("span", { className: "mneme-pipe-zoomval" },
          t("memory.actions.zoom.value").replace("{n}", String(Math.round(zoom * 100)))),
        h("button", {
          type: "button", className: "mneme-pipe-zoombtn",
          title: t("memory.actions.zoom.in"), "aria-label": t("memory.actions.zoom.in"),
          onClick: () => onZoom(zoom * 1.25)
        }, "+"),
        h("button", {
          type: "button", className: "mneme-pipe-zoombtn",
          title: t("memory.actions.zoom.hint"),
          onClick: () => onZoom(1)
        }, t("memory.actions.zoom.fit"))
      );
    }

    // 主视图：宽态 SVG 图 ↔ 窄态列表按容器宽切换（640px 阈值，ResizeObserver）。
    // 根挂 .mneme-pipeview 拿语义色变量层。
    function PipelineView(props) {
      const { t, data } = props;
      const nodes = (data && data.nodes) || [];
      const runs = (data && data.runs) || [];
      const [selectedRunId, setSelectedRunId] = react.useState(runs.length ? runs[0].id : null);
      const [selectedNodeId, setSelectedNodeId] = react.useState(null);
      const rootRef = react.useRef(null);
      const graphRef = react.useRef(null);
      const [narrow, setNarrow] = react.useState(false);
      const [zoom, setZoom] = react.useState(1);
      react.useEffect(() => {
        const el = rootRef.current;
        if (!el || typeof ResizeObserver !== "function") return;
        const ro = new ResizeObserver((entries) => {
          const w = entries && entries[0] ? entries[0].contentRect.width : 0;
          // 阈值从 640 降到 320：竖链与阶段带的固有宽度都是 354px——栏窄一点反而更该画图。
          // 640 那档是按当年那张摊得很开的假数据定的，真数据下它只会把右栏（通常 400~600px）
          // 全部推给「一列节点卡片」那一支，于是「看不到图谱」。
          setNarrow(w > 0 && w < 320);
        });
        ro.observe(el);
        return () => ro.disconnect();
      }, []);
      // 滚轮缩放必须**自己挂非被动监听**：React 的 onWheel 是挂在 root 上的被动监听，
      // preventDefault 会被浏览器忽略（控制台里那句 "Unable to preventDefault inside passive
      // event listener"），结果是 Ctrl+滚轮既缩放画布、又缩放整页，谁也没拦住。
      // 只认 Ctrl/⌘：普通滚轮仍旧是滚动画布——劫持它会让人滚不到下面的图例。
      react.useEffect(() => {
        const el = graphRef.current;
        if (!el || typeof el.addEventListener !== "function") return undefined;
        const onWheel = (ev) => {
          if (!ev.ctrlKey && !ev.metaKey) return;
          ev.preventDefault();
          setZoom((z) => clampZoom(z * (ev.deltaY < 0 ? 1.15 : 1 / 1.15)));
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
      }, [narrow]);

      const run = runs.find((r) => r.id === selectedRunId) || null;
      const selectedNode = selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) : null;
      if (!nodes.length) {
        return h("div", { className: "mneme-pipeview" },
          h("div", { className: "mneme-pipe-empty" },
            h("div", { className: "mneme-pipe-emptyTitle" }, t("memory.actions.empty.title")),
            t("memory.actions.empty.body")
          ),
          h("div", { className: "mneme-pipe-notice" }, t("memory.actions.notice"))
        );
      }
      return h("div", { className: "mneme-pipeview", ref: rootRef, style: { display: "flex", flexDirection: "column", flex: "1", minHeight: "0" } },
        h(PipelineRunChips, { t, runs, selectedRunId, onSelectRun: setSelectedRunId }),
        // 流程概览带：投影里 pipeline.done / trigger 此前一个都没渲染——第一屏
        // 说不出「这条流程要达成什么、什么时候起跑」。放画布上方、做成 HTML
        // 块而非 SVG 文本：125 字的完成判据要能换行。数据由投影保证存在。
        (data && data.pipeline) ? h("div", { className: "mneme-pipe-overview" },
          h("div", null,
            h("span", { className: "mneme-pipe-dt" }, t("memory.actions.ov.done") + "："),
            data.pipeline.done
          ),
          h("div", null,
            h("span", { className: "mneme-pipe-dt" }, t("memory.actions.ov.trigger") + "："),
            (data.pipeline.trigger || []).map((x) => x && x.value).filter(Boolean).join("、") || null
          )
        ) : null,
        // 一条运行记录都没有 = 全部候选。这句话得说出来：卡片上「候选」两个字本身
        // 不解释任何东西，而用户在这一屏最容易问的就是「为什么全是候选」。
        runs.length ? null : h("div", { className: "mneme-hint" }, t("memory.actions.noRuns")),
        // 缩放条放在分支**外面**：不论宽窄都在，既是控制，也是「新代码到没到」的肉眼标记。
        h(PipelineZoomBar, { t, zoom, onZoom: (z) => setZoom(clampZoom(z)) }),
        narrow
          ? h(PipelineList, { t, data, run, selectedNodeId, onSelectNode: setSelectedNodeId })
          : h("div", { className: "mneme-pipe-graph", ref: graphRef },
              // 宽度用百分比而不是 transform：百分比改的是**布局尺寸**，容器照常出滚动条，
              // 于是顺带就有了平移；transform 只改绘制，放大出去的那一半永远滚不到。
              h("div", { className: "mneme-pipe-zoomwrap", style: { width: (zoom * 100) + "%" } },
                h(PipelineGraphSvg, { t, data, run, selectedNodeId, onSelectNode: setSelectedNodeId })
              )
            ),
        h(PipelineLegend, { t }),
        selectedNode ? h(PipelineNodeDetail, { t, node: selectedNode }) : null,
        h("div", { className: "mneme-pipe-notice" }, t("memory.actions.notice"))
      );
    }

    // 右栏 tab 的正文。单独包一层组件、而不是把 hook 塞进 slots.register 的回调里：
    // 那个回调是不是当组件渲染由宿主决定，hook 放在名字明确的组件里才不必赌这件事。
    function PipelinePane(props) {
      const { t, project } = props;
      return h(PipelineBrowser, { t, project });
    }

    // 流水线标记：两个步骤块 + 依赖连线 + 状态点；开合状态用右上角
    // 实心/空心点区分（会话头图标要反映浮层开合）。
    function PipelineMark(props) {
      const { size = 16, open } = props || {};
      return h("svg", { width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" },
        h("path", { d: "M2.5 3h4.2v4.2H2.5z M9.3 8.8h4.2V13H9.3z", fill: "none", stroke: "currentColor", "stroke-width": 1.4 }),
        h("path", { d: "M6.7 5.1h4v3.7", fill: "none", stroke: "currentColor", "stroke-width": 1.2 }),
        h("circle", {
          cx: 13.2, cy: 2.8, r: 1.9,
          fill: open ? "currentColor" : "none",
          stroke: "currentColor", "stroke-width": 1.2
        })
      );
    }

    // 会话头入口：悬停 150ms 开 / 移开 120ms 关 / 点击固定 / Escape 关 /
    // 点击外部关（交互规格与 Agent Teams 浮层一致）。浮层锚 trigger、
    // portal 到 body。老宿主没有右栏服务时补一个「完整视图」按钮退回
    // 居中 sheet（形态沿用记忆库 overlay 的背板 + 居中面板）。
    function PipelineHeaderEntry(props) {
      const { t, hasPane, openPane, project } = props;
      const [open, setOpen] = useState(false);
      const [sheetOpen, setSheetOpen] = useState(false);
      const openRef = useRef(false);
      const pinnedRef = useRef(false);
      const hoverTimer = useRef(null);
      const rootRef = useRef(null);
      const anchorRef = useRef(null);
      const panelRef = useRef(null);
      const labelRef = useRef(null);
      const sheetRef = useRef(null);

      const changeOpen = (next) => {
        const was = openRef.current;
        const wasPinned = pinnedRef.current;
        openRef.current = next;
        setOpen(next);
        if (!next) pinnedRef.current = false;
        // announce 只挂「用户明确动作」的开合（点击固定 / Esc / 点外关）；
        // 悬停开合是瞬态，播报反而刷屏——与 §5 无障碍约束对齐。
        if (next && !was && wasPinned) announce(t("memory.actions.announce.open"));
        if (!next && was && wasPinned) announce(t("memory.actions.announce.close"));
      };
      const cancelHoverChange = () => {
        if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
      };
      const scheduleHoverOpen = () => {
        if (pinnedRef.current || openRef.current) return;
        // 窄容器下文字标签被 @container 隐藏（图标态）→ 不弹浮层，点击才开。
        if (labelRef.current && labelRef.current.offsetWidth === 0) return;
        cancelHoverChange();
        hoverTimer.current = setTimeout(() => {
          hoverTimer.current = null;
          openRef.current = true;
          setOpen(true);
        }, 150);
      };
      const scheduleHoverClose = () => {
        if (pinnedRef.current) return;
        cancelHoverChange();
        hoverTimer.current = setTimeout(() => {
          hoverTimer.current = null;
          openRef.current = false;
          setOpen(false);
        }, 120);
      };

      // 钩子顺序稳定：useAnchoredPosition 的存在性是模块常量条件，两次
      // 判断在所有渲染中走同一分支，不违反 hook 规则。
      const positioned = primitives && typeof primitives.useAnchoredPosition === "function"
        ? primitives.useAnchoredPosition({ open, anchorRef, panelRef, gap: 5, margin: 16 })
        : null;
      const panelStyle = positioned
        ? { ...positioned }
        : { position: "fixed", left: 0, top: 0, visibility: "hidden" };

      if (primitives && typeof primitives.useDismissOnOutsidePointer === "function") {
        primitives.useDismissOnOutsidePointer(rootRef, open, changeOpen, panelRef);
      }
      useEffect(() => {
        if (primitives && typeof primitives.useDismissOnOutsidePointer === "function") return;
        if (!open) return;
        const onDown = (ev) => {
          const panel = panelRef.current;
          const root = rootRef.current;
          if (panel && panel.contains(ev.target)) return;
          if (root && root.contains(ev.target)) return;
          changeOpen(false);
        };
        document.addEventListener("pointerdown", onDown, true);
        return () => document.removeEventListener("pointerdown", onDown, true);
      }, [open]);
      useEffect(() => () => cancelHoverChange(), []);

      // 居中 sheet 是「宿主没有右栏服务」时的唯一完整入口，键盘用户必须能进能出。
      // 它 portal 到 body，焦点默认留在原 trigger 上，而挂在 sheet 元素上的
      // onKeyDown 既因没有 tabIndex 不被聚焦、也收不到外部键盘事件——Escape 于是
      // 不生效，只剩 Tab 摸到关闭按钮一条路。做法与 MemoryOverlay 一致：打开时把
      // 焦点移进 sheet，Escape 在 window 上收，关掉再把焦点还给 trigger。
      useEffect(() => {
        if (!sheetOpen) return undefined;
        if (sheetRef.current) sheetRef.current.focus();
        const onKey = (ev) => {
          if (ev.key !== "Escape") return;
          ev.preventDefault();
          ev.stopPropagation();
          setSheetOpen(false);
          if (anchorRef.current) anchorRef.current.focus();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [sheetOpen]);

      const closeAll = () => {
        changeOpen(false);
        if (anchorRef.current) anchorRef.current.focus();
      };
      const onTriggerClick = () => {
        if (!openRef.current) {
          pinnedRef.current = true;
          changeOpen(true);
          setTimeout(() => { if (panelRef.current) panelRef.current.focus(); }, 0);
        } else if (pinnedRef.current) {
          changeOpen(false);
        } else {
          pinnedRef.current = true;
          if (panelRef.current) panelRef.current.focus();
        }
      };
      const doc = usePipeline(project, null);
      // 头部这一格标的是**这份清单读的是哪个项目**（某条工作流归谁，标在清单每一行上）：
      // 只取目录名，绝对路径不上界面——面板是会被截图的那一面。认不出项目时如实说，
      // 而不是编一个「全局」顶上：认不出和全局是两件事。
      const projectSource = ((doc && doc.sources) || []).find((s) => s.scope === "project");
      const scopeLabel = projectSource && projectSource.label
        ? t("memory.actions.scope.project").replace("{name}", projectSource.label)
        : t("memory.actions.scope.none");
      // 数的是这个项目里读出几条工作流；没拿到数据时是 0，不是随便挑一个数。
      const workflowCount = doc && doc.available ? doc.available.length : 0;

      const panel = (open && reactDom && typeof document !== "undefined")
        ? reactDom.createPortal(
            h("div", {
              ref: panelRef,
              // 注意：client.test.js 锁死全文件不得出现 role:"dialog"
              // （v0.7.15 清退 dialog 面的纪律），浮层只带 aria-label。
              "aria-label": t("memory.actions.title"),
              tabIndex: -1,
              className: "mneme-pipe mneme-pipe-panel",
              style: panelStyle,
              onMouseEnter: cancelHoverChange,
              onMouseLeave: scheduleHoverClose,
              onKeyDown: (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeAll(); } }
            },
              h("div", { className: "mneme-pipe-head" },
                h("span", { className: "mneme-pipe-title" }, t("memory.actions.title")),
                h("span", { className: "mneme-pipe-beta" }, t("memory.actions.beta")),
                h("span", { className: "mneme-pipe-scope" }, scopeLabel),
                h("button", {
                  type: "button",
                  className: "mneme-pipe-run",
                  // 有右栏服务：openTab(kind) 打开原生右栏 tab（页面类型无
                  // patterns，按 kind 打开）并收起浮层；打不开或老宿主
                  // （无 sidebarRight）退回本插件的居中 sheet——形态沿用
                  // 记忆库 overlay 的背板 + 居中面板。
                  onClick: () => {
                    if (openPane && openPane()) { changeOpen(false); return; }
                    changeOpen(false);
                    setSheetOpen(true);
                  }
                }, hasPane && openPane ? t("memory.actions.openPane") : t("memory.actions.viewFull"))
              ),
              h("div", { className: "mneme-pipe-notice" }, t("memory.actions.notice")),
              h(PipelineBrowser, { t, project })
            ),
            document.body
          )
        : null;

      const sheet = (sheetOpen && reactDom && typeof document !== "undefined")
        ? reactDom.createPortal(
            h("div", {
              className: "mneme-backdrop",
              onClick: (ev) => { if (ev.target === ev.currentTarget) setSheetOpen(false); }
            },
              h("div", {
                ref: sheetRef,
                tabIndex: -1,
                className: "mneme-pipe mneme-pipe-sheet",
                "aria-label": t("memory.actions.title"),
                onKeyDown: (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); setSheetOpen(false); } }
              },
                h("div", { className: "mneme-pipe-sheetbar" },
                  h("span", { className: "mneme-pipe-title" }, t("memory.actions.title")),
                  h("span", { className: "mneme-pipe-beta" }, t("memory.actions.beta")),
                  h("span", { className: "mneme-pipe-scope" }, scopeLabel),
                  h("button", { type: "button", className: "mneme-pipe-run", onClick: () => setSheetOpen(false) }, t("memory.actions.close"))
                ),
                h("div", { className: "mneme-pipe-sheetbody" }, h(PipelineBrowser, { t, project }))
              )
            ),
            document.body
          )
        : null;

      return h("div", {
        className: "mneme-pipe-root",
        ref: rootRef,
        onMouseEnter: scheduleHoverOpen,
        onMouseLeave: scheduleHoverClose
      },
        h("button", {
          type: "button",
          ref: anchorRef,
          className: "mneme-pipe-trigger",
          "aria-haspopup": "true",
          "aria-expanded": open ? "true" : "false",
          title: t("memory.actions.open"),
          onClick: onTriggerClick,
          onKeyDown: (ev) => { if (ev.key === "Escape" && open) { ev.preventDefault(); ev.stopPropagation(); closeAll(); } }
        },
          h(PipelineMark, { open }),
          h("span", { ref: labelRef, className: "mneme-pipe-triggerLabel" }, t("memory.actions.title")),
          workflowCount > 0 ? h("span", {
            className: "mneme-pipe-dot",
            title: t("memory.actions.list.count").replace("{n}", String(workflowCount))
          }, String(workflowCount)) : null
        ),
        panel,
        sheet
      );
    }

    // 对话行结算卡（turnTail）：死的落款——「这次跑哪条被用上了」。
    // 与会话头浮层读同一份数据；卡上勾选 = usedNodeIds（真正被复用），
    // 其余 path 节点只是被走过。没有运行记录时整张卡不出现——发一条「本次没用上任何
    // 做法」的空卡比不发更吵：它每一轮都会来一次。
    function TurnRunCard(props) {
      const { t, project } = props;
      const doc = usePipeline(project, null);
      const data = doc || {};
      const run = (data.runs || []).find((r) => r.id === "r1") || (data.runs || [])[0];
      if (!run) return null;
      const used = run.usedNodeIds || [];
      const refutedUsed = used.some((id) => {
        const n = (data.nodes || []).find((x) => x.id === id);
        return n && n.state === "refuted";
      });
      return h("div", { className: "mneme-pipe mneme-pipe-settle" },
        h("div", { className: "mneme-pipe-settleHead" },
          h("span", { className: "mneme-pipe-settleTitle" },
            h(PipelineMark, { size: 13 }),
            t("memory.actions.settle.title")
          ),
          h("span", { className: "mneme-pipe-beta" }, t("memory.actions.beta")),
          h("span", { className: "mneme-pipe-scope" },
            t("memory.actions.settle.line").replace("{title}", data.pipeline.title) + " · " + pipeFmtWhen(run.at))
        ),
        h("div", { className: "mneme-pipe-steps" },
          (run.path || []).map((id, i) => {
            const n = (data.nodes || []).find((x) => x.id === id);
            if (!n) return null;
            const isUsed = used.includes(id);
            return h(react.Fragment, { key: id + ":" + i },
              i > 0 ? h("span", { className: "mneme-pipe-stepArrow", "aria-hidden": "true" }, "→") : null,
              h("span", {
                className: "mneme-pipe-stepChip" + (isUsed ? " mneme-pipe-stepChip--used" : ""),
                title: n.title
              },
                (isUsed ? "✓ " : "") + pipeClip(n.title, 12)
              )
            );
          })
        ),
        h("div", { className: "mneme-pipe-scope" },
          t("memory.actions.settle.used").replace("{n}", String(used.length))
        ),
        refutedUsed ? h("div", { className: "mneme-pipe-scope" }, t("memory.actions.settle.refutedWarn")) : null
      );
    }

    // 座位注册（仅在旗标开启后被调用）：会话头入口、对话行结算卡、
    // 右栏类型与正文。⚠️ 服务名 sidebarRight 与注册服务名 sidebarRightTabs
    // 是两个不同的名字——类型/引导挂 sidebarRightTabs，打开走
    // ctx.get("sidebarRight").openTab。无右栏服务时不注册 pane（浮层 +
    // 居中 sheet 退化已在 PipelineHeaderEntry 内）。
    function registerPipelineSeats(ctx, t) {
      let hasPane = false;
      try {
        const sb = typeof ctx.get === "function" ? ctx.get("sidebarRight") : null;
        hasPane = !!(sb && typeof sb.openTab === "function");
      } catch { hasPane = false; }
      // 右栏打开：页面类型（无 patterns）按 kind 打开——openTab(kind)。
      // 服务半可用 / kind 未注册抛错时返回 false，调用方退化到居中 sheet。
      const openPane = () => {
        try {
          const sb = typeof ctx.get === "function" ? ctx.get("sidebarRight") : null;
          if (sb && typeof sb.openTab === "function") {
            sb.openTab(PIPELINE_ACTIONS_TAB_KIND);
            return true;
          }
        } catch (err) {
          console.warn("[dsh-mneme] sidebarRight.openTab failed, falling back to sheet:", err);
        }
        return false;
      };

      // 会话头入口：.actions 座位（.corner 被原生侧栏展开键占用，别用）。
      // 会话工作目录只有客户端拿得到，而「当前是哪个会话」只在座位注入里给——所以
      // 每个座位都要 inject: (sessionId) => ({ sessionId })，否则读到的永远是全局层。
      // 宿主若不吃这个选项，project 就是 null，面板如实说「项目未知」，不假装成功。
      ctx.slots.inject("conversation.session.header.actions", () => {
        return ctx.slots.register({
          name: "conversation.session.header.actions",
          id: "dsh-mneme:pipeline",
          order: 30,
          inject: (sessionId) => ({ sessionId })
        }, (props) => h(PipelineHeaderEntry, {
          t, hasPane, openPane, project: sessionProject(ctx, props && props.sessionId)
        }));
      });

      // 对话行结算卡：回答「这次跑哪条被用上了」。
      ctx.slots.inject("conversation.chat.turnTail", () => {
        return ctx.slots.register({
          name: "conversation.chat.turnTail",
          id: "dsh-mneme:pipeline:settle",
          // kind/scope 是**声明方**（宿主）在 children 上写的，注册方不重复声明——
          // 座位本身已经声明成 { kind: "list", scope: "session" }，多写一份只是噪音，
          // 万一注册侧按 schema 严校就是一次启动期抛错。
          inject: (sessionId) => ({ sessionId })
        }, (props) => h(TurnRunCard, { t, project: sessionProject(ctx, props && props.sessionId) }));
      });

      // tab 的**类型**与它的**正文**必须各自兜自己的异常，而且类型注册要幂等。
      // 为什么：宿主对重复的类型 id 会抛（`sidebarRight: tab type id "…" is already registered`），
      // 而这两件事的生命周期不一样——类型注册挂在宿主服务 `sidebarRightTabs` 上、插件重挂（刷新 /
      // 热重载 / 会话重建）时**留着**；正文座位是挂插件 scope 的，会随插件回收、重挂时要重来。
      // 原来两件事写在同一个 try 里，于是第二次挂载时类型那一抛就把正文一起带走了：界面上
      // 只剩宿主的 fallback「这类内容还没有可用的查看方式」，而错误只落在浏览器控制台里
      // ——看不见、也搜不到，是最费时间的一类。
      try {
        const tabs = typeof ctx.get === "function" ? ctx.get("sidebarRightTabs") : null;
        if (tabs && typeof tabs.register === "function") {
          const already = typeof tabs.get === "function" ? tabs.get(PIPELINE_ACTIONS_TAB_ID) : null;
          if (!already) {
            tabs.register({
              id: PIPELINE_ACTIONS_TAB_ID,
              kind: PIPELINE_ACTIONS_TAB_KIND,
              title: () => t("memory.actions.title"),
              guide: [{
                id: "dsh-mneme:pipeline:guide",
                order: 10,
                title: () => t("memory.actions.title"),
                description: () => t("memory.actions.notice"),
                icon: (size) => h(PipelineMark, { size, open: false })
              }]
            });
          }
        }
      } catch (err) {
        console.warn("[dsh-mneme] action pipeline tab type registration failed:", err);
      }

      try {
        const tabs = typeof ctx.get === "function" ? ctx.get("sidebarRightTabs") : null;
        if (tabs && typeof tabs.register === "function") {
          // 正文/标题都是按键座位：key = 类型 id，宿主按当前 tab 取。
          ctx.slots.inject("sidebar.right.pane.tab", () => {
            return ctx.slots.register({
              name: "sidebar.right.pane.tab",
              key: PIPELINE_ACTIONS_TAB_ID,
              inject: (sessionId) => ({ sessionId })
            }, (props) => h(PipelinePane, { t, project: sessionProject(ctx, props && props.sessionId) }));
          });
          ctx.slots.inject("sidebar.right.pane.tab.title", () => {
            return ctx.slots.register({
              name: "sidebar.right.pane.tab.title",
              key: PIPELINE_ACTIONS_TAB_ID
            }, () => t("memory.actions.title"));
          });
        }
      } catch (err) {
        console.warn("[dsh-mneme] action pipeline pane body registration failed:", err);
      }

      if (!hasPane) {
        console.info("[dsh-mneme] action pipeline: no sidebarRight service, pane tab skipped (floating panel + sheet fallback active)");
      }
    }

    // --- v0.13 日记本（beta）：常量、数据存取与正文组件 ----------------
    // tab 的 id 与 kind 是两个不同用途的东西（见 registerPipelineSeats 里那段注释）：
    // id 是宿主侧唯一键，kind 是 openTab() 的参数。
    const DIARY_TAB_ID = "dsh-mneme:diary";
    const DIARY_TAB_KIND = "mneme-diary";

    // 读侧：一条清单（含账本）+ 按天取正文。写侧两条 POST。
    // apiFetch 只补 Authorization 头，method/body 必须自己写。
    const DIARY_WRITE_OPTS = (payload) => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    });

    // agent/session 可选：手动「写今天」必须把「这个会话是谁」带过去，
    // 否则它永远落 default 人格卡——自动轮（auto.js）是带 agentId 的，
    // 两个入口写同一天会变成两个声音，正是桉桉说的「只以这个人格的口吻写日记」
    // 没做到的那一半。服务端已支持这两个查询参数。
    function diaryUrl(path, project, extra) {
      let url = "/api/dsh-mneme/diary" + path + "?project=" + encodeURIComponent(project || "");
      if (extra && extra.agent) url += "&agent=" + encodeURIComponent(extra.agent);
      if (extra && extra.session) url += "&session=" + encodeURIComponent(extra.session);
      return url;
    }

    // 日记本标记：一本翻开的册子 + 一道书脊。粗细 1.4 与 PipelineMark 对齐，
    // 颜色走 currentColor（图形色由座位那层的 --mneme-* 决定）。
    function DiaryMark(props) {
      const { size = 16 } = props || {};
      return h("svg", { width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" },
        h("path", { d: "M2.2 3.4c1.9-.6 3.8-.6 5.4.5v8.6c-1.6-1-3.5-1-5.4-.5z", fill: "none", stroke: "currentColor", "stroke-width": 1.4, "stroke-linejoin": "round" }),
        h("path", { d: "M13.8 3.4c-1.9-.6-3.8-.6-5.4.5v8.6c1.6-1 3.5-1 5.4-.5z", fill: "none", stroke: "currentColor", "stroke-width": 1.4, "stroke-linejoin": "round" })
      );
    }

    // 右栏 tab 的正文。为什么单独包一层具名组件（而不是把 hook 塞进
    // slots.register 的回调里）——同 PipelinePane 那条注释。
    // 只读 MD 渲染（P13）：React 文本节点天然转义，不经过 innerHTML，无原始
    // HTML 通道。frontmatter 折叠不显示；表格按等宽行渲染（知识库页的表都是
    // 两三列的清单，保真优先于交互）；`code` 拆成等宽 span。
    function renderWikiMarkdown(content) {
      const lines = String(content ?? "").split("\n");
      let i = 0;
      // frontmatter：首行是 --- 时吃到下一行 ---
      if (lines[0] && lines[0].trim() === "---") {
        i = 1;
        while (i < lines.length && lines[i].trim() !== "---") i++;
        i++;
      }
      const out = [];
      const inline = (text) => String(text).split(/`([^`]+)`/).map((part, idx) =>
        idx % 2 === 1 ? h("code", { key: idx, className: "mneme-wikicode" }, part) : part
      );
      let list = null; // "ul" | "ol" | null
      const flushList = () => {
        if (list) { out.push(h(list, { key: out.length }, listItems)); listItems = []; list = null; }
      };
      let listItems = [];
      let inCode = false;
      let codeLines = [];
      // --- 表格（v0.11.1 美化）：连续 `|` 行解析成真 table，不再按等宽行画竖线 ---
      const splitRow = (line) => String(line).trim().replace(/^\|/, "").replace(/\|$/, "")
        .split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
      const isSepRow = (cells) => cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
      // 路径形单元格（含 / 且以扩展名结尾）渲染成等宽 code——文件清单的第一列
      // 是相对路径，等宽 + 深一点的底色让路径在表里一眼可辨。
      const pathLike = (text) => /^(?!https?:)(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]{1,5}$/.test(String(text).trim());
      const cellNodes = (text, key) => {
        const trimmed = String(text).trim();
        if (pathLike(trimmed)) return h("code", { key, className: "mneme-wikicode" }, trimmed);
        return inline(trimmed);
      };
      let tableRows = null;
      const flushTable = () => {
        if (!tableRows) return;
        const rows = tableRows;
        tableRows = null;
        if (rows.length === 0) return;
        const headerCells = splitRow(rows[0]);
        const sepIndex = rows.length > 1 && isSepRow(splitRow(rows[1])) ? 1 : -1;
        const aligns = sepIndex >= 0
          ? splitRow(rows[sepIndex]).map((c) => (c.endsWith(":") ? "right" : c.startsWith(":") ? "center" : null))
          : headerCells.map(() => null);
        const bodyStart = sepIndex >= 0 ? sepIndex + 1 : 0;
        const head = h("thead", { key: "h" }, h("tr", null,
          headerCells.map((c, idx) => h("th", {
            key: idx, style: aligns[idx] ? { textAlign: aligns[idx] } : undefined,
          }, cellNodes(c, idx)))));
        const body = h("tbody", { key: "b" }, rows.slice(bodyStart).map((row, rIdx) => {
          const cells = splitRow(row);
          return h("tr", { key: rIdx }, headerCells.map((_, idx) => h("td", {
            key: idx,
            className: aligns[idx] === "right" ? "mneme-wikinum" : undefined,
            style: aligns[idx] && aligns[idx] !== "right" ? { textAlign: aligns[idx] } : undefined,
          }, cellNodes(cells[idx] ?? "", idx))));
        }));
        out.push(h("table", { key: out.length, className: "mneme-wikitable" }, head, body));
      };
      for (; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith("```")) {
          if (inCode) {
            out.push(h("pre", { key: out.length, className: "mneme-wikipre" }, codeLines.join("\n")));
            codeLines = []; inCode = false;
          } else { flushList(); flushTable(); inCode = true; }
          continue;
        }
        if (inCode) { codeLines.push(line); continue; }
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
          flushList(); flushTable();
          const level = Math.min(heading[1].length + 1, 5);
          out.push(h(`h${level}`, { key: out.length }, inline(heading[2])));
          continue;
        }
        const ul = line.match(/^\s*[-*]\s+(.*)$/);
        const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (ul || ol) {
          flushTable();
          const want = ul ? "ul" : "ol";
          if (list !== want) flushList();
          list = want;
          listItems.push(h("li", { key: listItems.length }, inline(ul ? ul[1] : ol[1])));
          continue;
        }
        if (/^\s*\|/.test(line)) { flushList(); tableRows = tableRows ?? []; tableRows.push(line); continue; }
        flushList(); flushTable();
        if (/^>\s?/.test(line)) { out.push(h("blockquote", { key: out.length, className: "mneme-wikiquote" }, inline(line.replace(/^>\s?/, "")))); continue; }
        if (line.trim() === "") continue;
        out.push(h("p", { key: out.length }, inline(line)));
      }
      flushList(); flushTable();
      if (inCode && codeLines.length > 0) out.push(h("pre", { key: out.length, className: "mneme-wikipre" }, codeLines.join("\n")));
      return out;
    }

    // 日记正文的排版入口：日记文件是「frontmatter + `# 日期` + 散文」这种固定形状，
    // 纸头已经单独显示了人格名与日期，所以这里要把这两样**去掉**再排版，
    // 否则纸上会先出现一遍 `--- date: ...` 再出现一遍日期标题。
    // 复用上面的 renderWikiMarkdown：它已经会吃 frontmatter、把 `#` 变标题、
    // 段落变 <p>、列表变真 <ul>、表格变真 <table>——日记偶尔也会长列表。
    function renderDiaryBody(text) {
      const lines = String(text ?? "").split("\n");
      let i = 0;
      if (lines[0] && lines[0].trim() === "---") {
        i = 1;
        while (i < lines.length && lines[i].trim() !== "---") i++;
        i++;
      }
      // 只吃掉紧随 frontmatter 的那个日期标题（`# 2026-11-08`），正文中间的
      // 小标题照常渲染——那是作者自己写的小标题，不是文件头。
      while (i < lines.length && lines[i].trim() === "") i++;
      if (i < lines.length && /^#\s+\d{4}-\d{2}-\d{2}\s*$/.test(lines[i].trim())) i++;
      return renderWikiMarkdown(lines.slice(i).join("\n"));
    }

    function DiaryPane(props) {
      const { t, project, agent, session } = props;
      const [doc, setDoc] = useState(undefined); // undefined=读中 null=读不出 对象=拿到
      const [gate, setGate] = useState(null);    // {kind, status} 503/409 的如实说明
      const [tick, setTick] = useState(0);
      const [day, setDay] = useState(null);      // 选中的日期串
      const [entry, setEntry] = useState(undefined);
      const [busy, setBusy] = useState("");      // "" | "compose" | "export"
      const [notice, setNotice] = useState(null);
      // 纸和字与记忆面板里的日记本共用同一个 localStorage 键：两处入口看的是
      // 同一本日记，纸张各选各的会让人以为进了两个不同的东西。
      const [book, setBook] = useState(readDiaryBook);

      useEffect(() => {
        if (!project) { setDoc(null); return; }
        let dead = false;
        setDoc(undefined);
        setGate(null);
        apiFetch(diaryUrl("", project))
          .then((res) => res.json().then((body) => ({ status: res.status, ok: res.ok, body })))
          .then((r) => {
            if (dead) return;
            if (r.ok) { setDoc(r.body || {}); return; }
            // 503 = 没装配、409 = 没开。两种都不是「读失败」，文案必须分开，
            // 否则用户会以为日记坏了而不是自己没开开关。
            if (r.status === 503 || r.status === 409) {
              setGate({ kind: r.status === 503 ? "unavailable" : "disabled", status: r.status });
              setDoc(null);
              return;
            }
            setDoc(null);
          })
          .catch((err) => {
            console.warn("[dsh-mneme] diary list failed:", err);
            if (!dead) setDoc(null);
          });
        return () => { dead = true; };
      }, [project, tick]);

      const rows = (doc && doc.diaries) || [];
      const activeDay = day || (rows.length ? rows[0].date : null);

      // 面板里改纸张时这个组件是挂着的，只读一次初值会一直用旧纸。
      useEffect(() => {
        const sync = () => setBook(readDiaryBook());
        window.addEventListener("storage", sync);
        window.addEventListener("mneme:diary-book-changed", sync);
        return () => {
          window.removeEventListener("storage", sync);
          window.removeEventListener("mneme:diary-book-changed", sync);
        };
      }, []);

      useEffect(() => {
        if (!project || !activeDay) { setEntry(undefined); return; }
        let dead = false;
        setEntry(undefined);
        apiFetch(diaryUrl("/entry", project) + "&date=" + encodeURIComponent(activeDay))
          .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
          .then((r) => {
            if (dead) return;
            setEntry({ date: activeDay, text: r.ok && r.body ? String(r.body.text || "") : null });
          })
          .catch((err) => {
            console.warn("[dsh-mneme] diary entry failed:", err);
            if (!dead) setEntry({ date: activeDay, text: null });
          });
        return () => { dead = true; };
      }, [project, activeDay]);

      const say = (tone, text) => {
        setNotice({ tone, text });
        if (typeof announce === "function") announce(text);
      };

      const writeToday = () => {
        if (!project || busy) return;
        setBusy("compose");
        setNotice(null);
        apiFetch(diaryUrl("/compose", project, { agent, session }), DIARY_WRITE_OPTS({}))
          .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
          .then((r) => {
            const b = r.body || {};
            if (!r.ok) { say("bad", t("memory.diary.composeFailed") + (b.error ? " (" + b.error + ")" : "")); return; }
            // skip 也是 200——「今天写过 / 今天没聊」都是正常结果，必须说清是哪一种，
            // 否则用户看到的是一句「成功了」但什么都没变（假成功）。
            // 写成时不能借用「已存到」那句文案——写和入库是两件事，
            // 复用到一起用户会以为日记已经被复制进项目目录了。
            if (b.status === "written") say("ok", t("memory.diary.writtenOk").replace("{path}", String(b.path || b.date || "")));
            else if (b.reason === "already-written") say("ok", t("memory.diary.skip.already"));
            else if (b.reason === "no-material") say("ok", t("memory.diary.skip.noMaterial"));
            else if (b.status === "skipped") say("ok", t("memory.diary.skip.other"));
            else say("ok", t("memory.diary.skip.other"));
            setTick((n) => n + 1);
          })
          .catch((err) => { console.warn("[dsh-mneme] diary compose failed:", err); say("bad", t("memory.diary.composeFailed")); })
          .finally(() => setBusy(""));
      };

      const exportDay = () => {
        if (!project || !activeDay || busy) return;
        setBusy("export");
        setNotice(null);
        apiFetch(diaryUrl("/export", project), DIARY_WRITE_OPTS({ date: activeDay }))
          .then((res) => res.json().then((body) => ({ ok: res.ok, status: res.status, body })))
          .then((r) => {
            const b = r.body || {};
            if (r.ok) say("ok", t("memory.diary.exportOk").replace("{path}", String(b.path || "")));
            else if (r.status === 409) say("bad", t("memory.diary.exportExists"));
            else say("bad", t("memory.diary.exportFailed") + (b.error ? " (" + b.error + ")" : ""));
          })
          .catch((err) => { console.warn("[dsh-mneme] diary export failed:", err); say("bad", t("memory.diary.exportFailed")); })
          .finally(() => setBusy(""));
      };

      const head = h("div", { className: "mneme-diary-head" },
        h(DiaryMark, { size: 16 }),
        h("span", { className: "mneme-diary-title" }, t("memory.diary.title")),
        h("span", { className: "mneme-diary-spacer" }),
        h("button", {
          type: "button", className: "mneme-diary-btn mneme-diary-btn--primary",
          disabled: !project || !!busy, onClick: writeToday,
          title: t("memory.diary.note")
        }, busy === "compose" ? t("memory.diary.writing") : t("memory.diary.write")),
        h("button", {
          type: "button", className: "mneme-diary-btn",
          disabled: !project || !activeDay || !!busy, onClick: exportDay
        }, busy === "export" ? t("memory.diary.exporting") : t("memory.diary.export"))
      );

      let body = null;
      if (!project) {
        body = h("div", { className: "mneme-diary-empty" },
          h("div", null, t("memory.diary.noProject")),
          h("div", null, t("memory.diary.noProjectHint")));
      } else if (gate) {
        body = h("div", { className: "mneme-diary-empty" },
          h("div", null, t(gate.kind === "disabled" ? "memory.diary.disabled" : "memory.diary.unavailable")),
          h("div", null, t(gate.kind === "disabled" ? "memory.diary.disabledHint" : "memory.diary.note")));
      } else if (doc === undefined) {
        body = h("div", { className: "mneme-diary-empty" }, t("memory.diary.loading"));
      } else if (doc === null) {
        body = h("div", { className: "mneme-diary-empty" },
          h("span", { className: "mneme-diary-warn" }, t("memory.diary.readFailed")),
          " ",
          h("button", { type: "button", className: "mneme-diary-btn", onClick: () => setTick((n) => n + 1) }, t("memory.diary.retry")));
      } else if (!rows.length) {
        body = h("div", { className: "mneme-diary-empty" },
          h("div", null, t("memory.diary.empty")),
          h("div", null, t("memory.diary.emptyHint")));
      } else {
        const list = h("div", { className: "mneme-diary-list" }, rows.map((r) => h("button", {
          key: r.date, type: "button",
          className: "mneme-diary-day" + (r.date === activeDay ? " mneme-diary-day--on" : ""),
          onClick: () => setDay(r.date)
        }, r.date)));
        const text = entry && entry.date === activeDay ? entry.text : undefined;
        const paper = h("div", { className: "mneme-diary-paper mneme-diary-paper--" + book },
          text === undefined
            ? h("div", { className: "mneme-diary-empty" }, t("memory.diary.loading"))
            : text === null
              ? h("span", { className: "mneme-diary-warn" }, t("memory.diary.readFailed"))
              : h("div", { className: "mneme-diary-text" }, renderDiaryBody(text)));
        body = h("div", { className: "mneme-diary-body" }, list, paper);
      }

      const audit = (doc && doc.audit) || [];
      const foot = audit.length
        ? h("div", { className: "mneme-diary-audit" },
            h("div", { className: "mneme-diary-audithead" }, t("memory.diary.auditTitle")),
            audit.slice(-6).reverse().map((a, i) => h("div", { key: "a" + i, className: "mneme-diary-auditrow" },
              [a.date, t("memory.diary.status." + (a.status || "skipped")), a.reason || ""].filter(Boolean).join(" · "))))
        : null;

      return h("div", { className: "mneme-diary" },
        head,
        h("div", { className: "mneme-diary-note" },
          rows.length
            ? t("memory.diary.count").replace("{n}", String(rows.length)) + " " + t("memory.diary.pickHint")
            : t("memory.diary.note")),
        notice ? h("div", { className: notice.tone === "bad" ? "mneme-diary-warn" : "mneme-diary-ok" }, notice.text) : null,
        body,
        foot
      );
    }

    // 会话头入口按钮：日记本是右栏的一个 tab，但**注册了 tab 类型不等于用户点得到**——
    // 没有能调 openTab 的按钮，页签就永远打不开，界面上等于不存在。v0.13.0 就是这么发的：
    // 类型、正文、旗标闸全绿，用户重启后却「侧边栏没有入口」。入口与页签是一对，缺一不可。
    // 这里只做「点一下开页签」，不复刻 M.O. 那套 hover 浮层——日记本身就是那个 pane。
    // 左侧面板（`sidebar.panellist` + `main` 成对座位）的图标：一本翻开的册子，
    // 与右栏 tab 的 DiaryMark 同一形状，但这里画成 24 网格的粗描边——侧栏图标
    // 统一走 1.8px，细描边在 18px 下会糊。
    function DiaryLibraryGlyph({ size }) {
      const s = size || 18;
      return h("span", { className: "mneme-paneliglyph", "aria-hidden": "true" },
        h("svg", {
          width: s, height: s, viewBox: "0 0 24 24", fill: "none",
          stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round"
        },
          h("path", { d: "M12 7c-1.8-1.3-4-1.6-7-1v13c3-.6 5.2-.3 7 1 1.8-1.3 4-1.6 7-1V6c-3-.6-5.2-.3-7 1z" }),
          h("path", { d: "M12 7v14" })));
    }

    // 一篇日记的 frontmatter 里，人格那一行形如 `persona: default (ptc)`：
    // 括号里是**写这篇的 agent 名**，前面是卡来自哪一维（default / settings / bySession…）。
    // 括号里那个词从来不是人格名——本机旧数据里五个桶都写着 `(ptc)`、一个写着
    // `(amarre)`，直接上屏就是导航栏一排项目键加一个 ptc（桉桉 2026-11-09 原话：
    // 「不要有那个什么ptc什么的其他导航，导航应该是人格名」）。
    //
    // 正确的名字只能从人格卡里取：agent 名 → 它自己那张卡的名字 → 没有就用
    // default 卡的名字（走的就是 resolvePersonaCard 的回落口径，写这篇时用的
    // 就是默认卡）。两级都取不到才退回项目名，再退回桶键，绝不把 agent 名当人格名。
    function diaryBucketName(bucket, store) {
      const persona = String((bucket && bucket.persona) || "");
      const hit = /\(([^)]+)\)\s*$/.exec(persona);
      const agent = hit ? hit[1].trim() : "";
      if (agent && store) {
        const byAgent = store.byAgent && store.byAgent[agent];
        if (byAgent && byAgent.name) return String(byAgent.name);
        const fallback = store.default && store.default.name;
        if (fallback) return String(fallback);
      }
      // 没有模板行（老日记）或还没读到人格卡：只剩项目名这一级，仍然不上 agent 名。
      if (bucket && bucket.project) return String(bucket.project);
      return String((bucket && bucket.key) || "");
    }

    // 左侧「ta 的日记」面板：导航栏是 Agent 名字，正文是选中那一篇。
    //
    // 与右栏 DiaryPane 的关键差别：右栏拿得到 sessionId（座位 `inject` 透传），
    // 所以能算出「当前会话的项目」；`main` 座位不注入 sessionId，这里算不出来，
    // 也不该只给一个项目看——它读的是跨桶清单（/diary/library）。
    //
    // 座位无条件注册、开关只管内容层：`diaryEnabled` 关着时后端回 409，面板据此
    // 渲染「去哪儿打开」的空态，而不是让入口凭空消失（#607 的教训）。
    // 左侧「ta 的日记」面板：一本本子的样子。
    //
    // 两条硬要求（桉桉 2026-11-09）：①导航写**人格名**，不写项目桶键——
    // `QQ---4f061790`、`amarre-c836db6a` 是存储实现，不是人；②长得像本子：
    // 固定几套纸与字，用户只挑不调。所以这里先把桶按人格名归并（同一个身份
    // 住过好几个项目桶时合成一个人），再用纸纹 + 字族做「本子」观感。
    //
    // 与右栏 DiaryPane 的关键差别：右栏拿得到 sessionId（座位 `inject` 透传），
    // 所以能算出「当前会话的项目」；`main` 座位不注入 sessionId，这里算不出来，
    // 也不该只给一个项目看——它读的是跨桶清单（/diary/library）。
    //
    // 座位无条件注册、开关只管内容层：`diaryEnabled` 关着时后端回 409，面板据此
    // 渲染「去哪儿打开」的空态，而不是让入口凭空消失（#607 的教训）。
    const DIARY_BOOKS = [
      { key: "plain", label: "memory.diary.book.plain" },
      { key: "ruled", label: "memory.diary.book.ruled" },
      { key: "grid", label: "memory.diary.book.grid" },
      { key: "kraft", label: "memory.diary.book.kraft" }
    ];
    const DIARY_BOOK_KEY = "dsh-mneme-diary-book";

    // 纸的选择只存本地（每台机器一本自己的本子），读不到就用横线：横线最像本子，
    // 而「没有纸纹」在视觉上最不像，不该是默认。
    function readDiaryBook() {
      try {
        const raw = window.localStorage.getItem(DIARY_BOOK_KEY);
        return DIARY_BOOKS.some((b) => b.key === raw) ? raw : "ruled";
      } catch { return "ruled"; }
    }

    function writeDiaryBook(book) {
      // 隐私模式 / 存储被禁时写不进去——纸纹是纯外观，失败就只在本次会话生效，
      // 不弹错、不谎报（下一次开面板会回落到默认，用户看得见）。
      try { window.localStorage.setItem(DIARY_BOOK_KEY, book); } catch { /* 忽略 */ }
      // storage 事件只在别的标签页触发，同一页里另一处入口（右栏 DiaryPane）
      // 收不到——自己补一个同页广播，否则换个入口纸张又变回旧样式。
      try { window.dispatchEvent(new CustomEvent("mneme:diary-book-changed")); } catch { /* 忽略 */ }
    }

    function DiaryLibraryPanel({ t }) {
      const [lib, setLib] = useState(undefined); // undefined=读中 null=读不出 对象=拿到
      const [gate, setGate] = useState(null);    // {kind, status}
      const [tick, setTick] = useState(0);
      const [pick, setPick] = useState(null);    // 选中的人格名
      const [day, setDay] = useState(null);      // 选中的那天（`桶键@日期` 复合键）
      const [entry, setEntry] = useState(undefined);
      const [book, setBook] = useState(readDiaryBook);
      // 写侧两个动作（写今天 / 存到项目）。右栏那份 DiaryPane 被撤掉之后，
      // 这里是唯一还能手动写的地方——不给它写按钮，等于把「手动补写」整条路删了。
      const [busy, setBusy] = useState("");
      const [notice, setNotice] = useState(null); // {kind:"ok"|"bad", text}
      // 导航要显示人格名，而人格名只在人格卡里；日记正文只写了 agent 名。
      // 读不到卡时导航退回项目名——不拿 agent 名顶上（见 diaryBucketName）。
      const [store, setStore] = useState(null);

      useEffect(() => {
        let dead = false;
        apiFetch("/api/dsh-mneme/persona")
          .then((res) => (res.ok ? res.json() : null))
          .then((j) => { if (!dead && j) setStore(personaStoreShape(j.persona)); })
          .catch(() => { /* 读不到就只用项目名，不阻断日记 */ });
        return () => { dead = true; };
      }, []);

      useEffect(() => {
        let dead = false;
        setLib(undefined);
        setGate(null);
        apiFetch("/api/dsh-mneme/diary/library")
          .then((res) => res.json().then((body) => ({ status: res.status, ok: res.ok, body })))
          .then((r) => {
            if (dead) return;
            if (r.ok) { setLib(r.body || {}); return; }
            // 503 = 没装配、409 = 没开。两种都不是「读失败」，文案必须分开。
            if (r.status === 503 || r.status === 409) {
              setGate({ kind: r.status === 503 ? "unavailable" : "disabled", status: r.status });
              setLib(null);
              return;
            }
            setLib(null);
          })
          .catch((err) => {
            console.warn("[dsh-mneme] diary library failed:", err);
            if (!dead) setLib(null);
          });
        return () => { dead = true; };
      }, [tick]);

      const buckets = (lib && lib.buckets) || [];

      // 桶 → 人。同一个名字在几个项目桶里各写过，合成一个人：导航上是「一个身份
      // 一本书」，不是「一个项目一本」。桶键只留在复合日期键里，用作取正文的线索。
      const people = [];
      const byName = new Map();
      for (const b of buckets) {
        const name = diaryBucketName(b, store);
        let person = byName.get(name);
        if (!person) {
          person = { name, entries: [], count: 0, latest: "" };
          byName.set(name, person);
          people.push(person);
        }
        for (const e of b.entries || []) {
          person.entries.push({ key: b.key + "@" + e.date, date: String(e.date), bucket: b.key });
        }
        person.count += Number(b.count) || 0;
        const latest = String(b.latest || "");
        if (latest > person.latest) person.latest = latest;
      }
      for (const p of people) {
        p.entries.sort((a, b2) => (a.date === b2.date ? 0 : a.date < b2.date ? 1 : -1));
      }

      const activePerson = people.find((p) => p.name === pick) || people[0] || null;
      const days = (activePerson && activePerson.entries) || [];
      const activeItem = days.find((d) => d.key === day) || days[0] || null;

      useEffect(() => {
        if (!activeItem) { setEntry(undefined); return; }
        let dead = false;
        setEntry(undefined);
        apiFetch("/api/dsh-mneme/diary/library/entry?bucket=" + encodeURIComponent(activeItem.bucket)
          + "&date=" + encodeURIComponent(activeItem.date))
          .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
          .then((r) => {
            if (dead) return;
            setEntry(r.ok && r.body && typeof r.body.text === "string" ? r.body.text : null);
          })
          .catch((err) => {
            console.warn("[dsh-mneme] diary library entry failed:", err);
            if (!dead) setEntry(null);
          });
        return () => { dead = true; };
      }, [activeItem && activeItem.key]);

      // 当前这一篇属于哪个项目：桶是 projectKey(projectRoot) 的产物，反推不回路径，
      // 所以只能读 diaries/state.json 里 compose 自己记的账（library.js 已并进桶上）。
      const activeBucket = activeItem
        ? buckets.find((b) => b.key === activeItem.bucket) || null
        : null;
      const writableRoot = (activeBucket && typeof activeBucket.projectRoot === "string"
        && activeBucket.projectRoot) || "";
      const writerAgent = (activeBucket && typeof activeBucket.agentId === "string"
        && activeBucket.agentId) || "";

      const say = (kind, text) => setNotice({ kind, text });

      const composeToday = () => {
        if (!writableRoot || busy) return;
        setBusy("compose");
        setNotice(null);
        apiFetch(diaryUrl("/compose", writableRoot, { agent: writerAgent }), DIARY_WRITE_OPTS({}))
          .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
          .then((r) => {
            const b = r.body || {};
            if (!r.ok) { say("bad", t("memory.diary.composeFailed") + (b.error ? " (" + b.error + ")" : "")); return; }
            // skip 不是错：already-written / no-material 都是关于这本书的答案，
            // 说清楚比笼统报「没写成」有用。
            if (b.status === "written") say("ok", t("memory.diary.writtenOk").replace("{path}", String(b.path || "")));
            else if (b.reason === "already-written") say("ok", t("memory.diary.skip.already"));
            else if (b.reason === "no-material") say("ok", t("memory.diary.skip.noMaterial"));
            else say("ok", t("memory.diary.skip.other"));
            setTick((n) => n + 1);
          })
          .catch((err) => {
            console.warn("[dsh-mneme] diary compose failed:", err);
            say("bad", t("memory.diary.composeFailed"));
          })
          .then(() => setBusy(""));
      };

      const exportDay = () => {
        if (!writableRoot || !activeItem || busy) return;
        setBusy("export");
        setNotice(null);
        apiFetch(diaryUrl("/export", writableRoot), DIARY_WRITE_OPTS({ date: activeItem.date }))
          .then((res) => res.json().then((body) => ({ status: res.status, ok: res.ok, body })))
          .then((r) => {
            const b = r.body || {};
            if (r.ok) say("ok", t("memory.diary.exportOk").replace("{path}", String(b.path || "")));
            else if (r.status === 409) say("bad", t("memory.diary.exportExists"));
            else say("bad", t("memory.diary.exportFailed") + (b.error ? " (" + b.error + ")" : ""));
          })
          .catch((err) => {
            console.warn("[dsh-mneme] diary export failed:", err);
            say("bad", t("memory.diary.exportFailed"));
          })
          .then(() => setBusy(""));
      };

      const paperButtons = h("div", { className: "mneme-diary-books", role: "group", "aria-label": t("memory.diary.bookLabel") },
        DIARY_BOOKS.map((b) => h("button", {
          key: b.key, type: "button",
          "aria-pressed": book === b.key ? "true" : "false",
          className: "mneme-diary-book" + (book === b.key ? " mneme-diary-book--on" : ""),
          onClick: () => { setBook(b.key); writeDiaryBook(b.key); }
        }, t(b.label))));

      const head = h("div", { className: "mneme-diary-head" },
        h(DiaryMark, { size: 16 }),
        h("span", { className: "mneme-diary-title" }, t("memory.diary.title")),
        h("span", { className: "mneme-diary-spacer" }),
        paperButtons,
        h("button", {
          type: "button", className: "mneme-diary-btn",
          // 账本里没有这个桶的路径 = 不知道写到哪，不给按钮（点了必然 400）。
          // 不用 title 藏原因，disabled + 下面那行说明更直接。
          disabled: !!gate || !writableRoot || !!busy,
          title: writableRoot ? undefined : t("memory.diary.noProjectRoot"),
          onClick: composeToday
        }, busy === "compose" ? t("memory.diary.writing") : t("memory.diary.write")),
        h("button", {
          type: "button", className: "mneme-diary-btn",
          disabled: !!gate || !writableRoot || !activeItem || !!busy,
          onClick: exportDay
        }, busy === "export" ? t("memory.diary.exporting") : t("memory.diary.export")),
        h("button", {
          type: "button", className: "mneme-diary-btn",
          disabled: !!gate, onClick: () => setTick((n) => n + 1)
        }, t("memory.diary.retry")));

      let body = null;
      if (gate) {
        body = h("div", { className: "mneme-diary-empty" },
          h("div", null, t(gate.kind === "disabled" ? "memory.diary.disabled" : "memory.diary.unavailable")),
          h("div", null, t(gate.kind === "disabled" ? "memory.diary.disabledHint" : "memory.diary.note")));
      } else if (lib === undefined) {
        body = h("div", { className: "mneme-diary-empty" }, t("memory.diary.loading"));
      } else if (lib === null) {
        body = h("div", { className: "mneme-diary-empty" },
          h("span", { className: "mneme-diary-warn" }, t("memory.diary.readFailed")), " ",
          h("button", { type: "button", className: "mneme-diary-btn", onClick: () => setTick((n) => n + 1) }, t("memory.diary.retry")));
      } else if (!people.length) {
        body = h("div", { className: "mneme-diary-empty" },
          h("div", null, t("memory.diary.libraryEmpty")),
          h("div", null, t("memory.diary.libraryEmptyHint")));
      } else {
        const nav = h("div", { className: "mneme-diary-nav" }, people.map((p) => h("button", {
          key: p.name, type: "button",
          className: "mneme-diary-agent" + (activePerson && p.name === activePerson.name ? " mneme-diary-agent--on" : ""),
          // title 只给数量，绝不放桶键：悬停提示里泄出 `QQ---4f061790` 与导航
          // 上写桶键是同一个错，只是藏得浅一点。
          title: t("memory.diary.count").replace("{n}", String(p.count)),
          onClick: () => { setPick(p.name); setDay(null); }
        }, h("span", { className: "mneme-diary-agentName" }, p.name))));

        const list = h("div", { className: "mneme-diary-list" }, days.map((r) => h("button", {
          key: r.key, type: "button",
          className: "mneme-diary-day" + (activeItem && r.key === activeItem.key ? " mneme-diary-day--on" : ""),
          onClick: () => setDay(r.key)
        }, r.date)));

        const text = typeof entry === "string" ? entry : undefined;
        const paper = h("div", { className: "mneme-diary-paper mneme-diary-paper--" + book },
          h("div", { className: "mneme-diary-paperhead" },
            h("span", { className: "mneme-diary-papername" }, (activePerson && activePerson.name) || ""),
            h("span", { className: "mneme-diary-paperdate" }, (activeItem && activeItem.date) || "")),
          text === undefined
            ? h("div", { className: "mneme-diary-empty" }, t("memory.diary.loading"))
            : text === null
              ? h("span", { className: "mneme-diary-warn" }, t("memory.diary.readFailed"))
              : h("div", { className: "mneme-diary-text" }, renderDiaryBody(text)));

        const meta = h("div", { className: "mneme-diary-meta" },
          t("memory.diary.count").replace("{n}", String((activePerson && activePerson.count) || 0)),
          activePerson && activePerson.latest ? h("span", { className: "mneme-diary-metaWhen" }, " · " + activePerson.latest) : null);

        body = h(react.Fragment, null, nav, meta, h("div", { className: "mneme-diary-body" }, list, paper));
      }

      const noticeRow = notice
        ? h("div", {
            className: "mneme-diary-notice" + (notice.kind === "bad" ? " mneme-diary-notice--bad" : ""),
            role: notice.kind === "bad" ? "alert" : "status"
          }, notice.text)
        : null;

      return h("div", { className: "mneme-diary" }, head, noticeRow, body);
    }


    // --- 人格设计整页（第五个座位）---------------------------------------
    // 一个身份一张卡。为什么必须是**一整页**而不是设置里那张卡：桉桉要的
    // 「设定好人格的 agent 只以这个人格的口吻写日记」需要三样东西同屏——
    // 卡本身、这张卡这一轮真正会注入的文本、以及这个身份已经写下的日记。
    // 设置页那张卡只能放第一样，另外两样放不进去也不该挤进去。
    //
    // 一条硬纪律：保存发**全三维**（default / byAgent / bySession）。
    // settings.setPersona 的多卡形是全量替换，只发两维就会把「绑会话」的卡整片
    // 抹掉——设置页那张卡原先正是这么发的（同一次改动里一并补上了 bySession：
    // 用户在任何一处点保存，都不该顺手删掉另一处的数据）。
    const PERSONA_CARD_FIELDS = ["name", "personality", "replyStyle", "scenario", "mesExample", "enabled"];

    function personaCardShape(raw) {
      const card = raw && typeof raw === "object" ? raw : {};
      const out = {};
      for (const field of PERSONA_CARD_FIELDS) {
        if (field === "enabled") out.enabled = card.enabled === true;
        else out[field] = typeof card[field] === "string" ? card[field] : "";
      }
      return out;
    }

    // 后端三种形状都要认：v2 多卡 {default,byAgent,bySession}、v1 单对象（读作
    // default）、以及 404（旧后端没有 /persona）。只认前两种里的第一种会把老装
    // 的用户读成「一张卡都没有」，那是最容易被当成「数据丢了」的假象。
    function personaStoreShape(raw) {
      const multi = !!raw && (("default" in raw) || ("byAgent" in raw) || ("bySession" in raw));
      const pick = (bucket) => Object.fromEntries(
        Object.entries(bucket && typeof bucket === "object" ? bucket : {}).map(([k, c]) => [k, personaCardShape(c)])
      );
      return {
        default: personaCardShape(multi ? raw.default : raw),
        byAgent: multi ? pick(raw.byAgent) : {},
        bySession: multi ? pick(raw.bySession) : {}
      };
    }

    function emptyPersonaCard() {
      return { name: "", personality: "", replyStyle: "", scenario: "", mesExample: "", enabled: false };
    }

    // 人格页图标：一张侧脸（轮廓 + 眼点）。24 网格、1.8 描边，与侧栏其它图标同规格。
    function PersonaGlyph({ size }) {
      const s = size || 18;
      return h("span", { className: "mneme-paneliglyph", "aria-hidden": "true" },
        h("svg", {
          width: s, height: s, viewBox: "0 0 24 24", fill: "none",
          stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round"
        },
          h("path", { d: "M12 3a7 7 0 0 0-7 7c0 4 3 5 3 8h8c0-3 3-4 3-8a7 7 0 0 0-7-7z" }),
          h("path", { d: "M10 11h.01" }),
          h("path", { d: "M14 11h.01" }),
          h("path", { d: "M9.5 15c1.6 1 3.4 1 5 0" })));
    }

    function PersonaMainPanel({ t }) {
      const [draft, setDraft] = useState(null);      // 三维全量；null = 还没读到
      const [phase, setPhase] = useState("loading"); // loading | ready | unknown
      const [editing, setEditing] = useState("default");
      const [newName, setNewName] = useState("");
      const [savedAt, setSavedAt] = useState(0);     // 时间戳哨兵：只在 >0 时显示「已保存」
      const [error, setError] = useState("");
      const [preview, setPreview] = useState(undefined); // undefined=读中 null=读不出 对象
      const [diary, setDiary] = useState(undefined);     // undefined=读中 null=读不出 数组
      const [tick, setTick] = useState(0);
      const [previewTick, setPreviewTick] = useState(0);
      // 严格寻址的生效值：/features 是 open 读路由，与设置页读同一份快照。
      // 不自己猜默认值——猜错的表现是「明明开了严格寻址，界面还说所有人都有卡兜」。
      const [strict, setStrict] = useState(false);
      const previewSeq = useRef(0);
      // #514：人是在这一页开关人格的，所以「为什么关了没反应」的答案必须在这一页。
      // 与状态页、设置页共用 useInjectStatus，三处口径不会各自漂。
      const injectStatus = useInjectStatus();
      const minimalWarn = !injectStatus.loading && injectStatus.suppressed;

      // ——— 从设置页「个性化」整块搬来的两件事 ——————————————————————————
      // 桉桉 2026-11-09：「mneme 设置里面的个性化还没移走」。人设、画像、Agent 眼中
      // 的你，说的是同一个「你是谁」，分在两页只会让人在两处各改一半。搬进来时口径
      // 一字未改（画像仍只由用户手填、草稿只出副本、事实仍只走 apply），只是换了宿主。
      const [profile, setProfile] = react.useState(""); // 用户手填的自我介绍（原设置页「用户画像」卡）
      const [saved, setSaved] = react.useState(false);
      // 画像提取草稿（#497）：null = 没有结果；否则带 kind 的一次性结果，四种结局各一句
      // 话——把「没启用」「库里没东西」「模型没配合」压成同一句「没有草稿」，用户就只能瞎猜。
      const [profileDraft, setProfileDraft] = react.useState(null);
      const [profileExtracting, setProfileExtracting] = react.useState(false);
      const [profileDraftCopied, setProfileDraftCopied] = react.useState(false);
      // 复制失败必须**看得见**：announce() 那个 live region 是 1px 裁剪元素，只有屏幕
      // 阅读器读得到。视力正常的用户看到按钮文字没变、页面也没变化，就会以为复制成功，
      // 粘贴时拿到旧的剪贴板内容——比不提示更糟。
      const [profileDraftCopyFailed, setProfileDraftCopyFailed] = react.useState(false);
      // 复制的每一趟都要能认出「这条回调还属于当前这份草稿吗」。剪贴板是异步的，复制 A 的
      // promise 还没落地时又提取出草稿 B，A 的回调就会在 B 上打勾或报错——B 一个字都没被
      // 复制过。用递增序号做票据：换草稿或重新复制都换票，旧票的回调直接丢弃。
      const profileCopyTicket = react.useRef(0);
      // 保存失败要可见（persona 那条一直有，画像这条以前是静默 catch）。
      const [profileError, setProfileError] = react.useState("");
      // 画像的读取：搬过来时从设置页的 load() 里摘出来单独放着——那张卡现在住在这里，
      // 数据的所有者也就该是这里（两页各读一份会各自显示不同的旧值）。
      // 失败保持空字符串：画像读不到时输入框是空的，用户一保存就会把它清掉，所以
      // 读失败要能重试（tick 由页头的「重试」按钮推）。
      useEffect(() => {
        let dead = false;
        apiFetch("/api/dsh-mneme/profile")
          .then((res) => (res.ok ? res.json() : null))
          .then((j) => { if (!dead && j && typeof j.profile === "string") setProfile(j.profile); })
          .catch(() => { /* 读不到就留空：下一次 tick 再试 */ });
        return () => { dead = true; };
      }, [tick]);

      // 返回「是否真的存下了」。apiFetch 只是 fetch 的薄壳，非 2xx 不会抛——同页的
      // savePersonaCards 一直判 `res.ok`，画像这条一直没判，于是服务端 403/413 时界面
      // 照样闪「画像已保存」（评审实测的同类洞，这次一起收）。
      async function saveProfile(next = profile) {
        try {
          const res = await apiFetch("/api/dsh-mneme/profile", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ profile: next })
          });
          if (!res.ok) throw new Error("HTTP " + res.status);
          setSaved(true);
          setProfileError("");
          announce(t("memory.settings.profileSaved"));
          setTimeout(() => setSaved(false), 1500);
          return true;
        } catch (err) {
          setProfileError((err && err.message) || "failed");
          setTimeout(() => setProfileError(""), 4000);
          return false;
        }
      }

      // 画像提取：一次宿主 LLM 调用，只在用户点按钮时发生。开关没开时后端直接回
      // 409，这里显示「未启用」而不是转圈后什么也没有——那会被读成按钮坏了。
      async function extractProfileDraft() {
        setProfileExtracting(true);
        setProfileDraft(null);
        // 新草稿一出现，上一趟复制的回调立刻作废，连它留下的两种提示也一并清掉。
        profileCopyTicket.current += 1;
        setProfileDraftCopied(false);
        setProfileDraftCopyFailed(false);
        try {
          const res = await apiFetch("/api/dsh-mneme/profile/extract", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}"
          });
          const body = await res.json().catch(() => null);
          if (res.ok && typeof body?.draft === "string" && body.draft.trim()) {
            setProfileDraft({
              kind: "draft",
              text: body.draft,
              rowsUsed: Number.isInteger(body.rowsUsed) ? body.rowsUsed : 0,
              truncated: body.truncated === true
            });
            return;
          }
          const error = body && typeof body.error === "string" ? body.error : "";
          // 五种结局各一句话：没启用 / 库里没内容 / 没配模型 / 模型不配合或调用失败 /
          // 成功草稿。压在一起就是把「环境缺东西」报成「这次没提炼出东西」。
          const kind = error === "disabled" ? "disabled"
            : error === "no-input" ? "empty"
            : error === "no-route" ? "noroute"
            : "failed";
          setProfileDraft({ kind });
        } catch {
          setProfileDraft({ kind: "failed" });
        } finally {
          setProfileExtracting(false);
        }
      }

      // 草稿只展示副本（桉桉 2026-11-04 定的口径）。这一段以前叫「采用为画像」，
      // 点一下就直接 PUT /profile —— 把用户手写的那份覆盖掉，且没有撤销。现在改成
      // 复制：要落进「用户画像」必须由用户自己粘贴再点保存，手写原文一个字都不会被
      // 后台改掉。剪贴板不可用（无权限 / 非安全上下文）时不许假装成功——退回
      // execCommand 那条老路，仍然失败就明确让她手动选中复制。
      function copyProfileDraft() {
        if (profileDraft?.kind !== "draft") return;
        const text = profileDraft.text || "";
        // 每次尝试先清掉上次的失败提示：失败过以后再成功，红字不能留在屏上。
        setProfileDraftCopyFailed(false);
        // 这一趟的票。回调落地时票已经不是当前那张，就说明界面早已换了一份草稿。
        const ticket = ++profileCopyTicket.current;
        const current = () => ticket === profileCopyTicket.current;
        const ok = () => {
          if (!current()) return;
          setProfileDraftCopied(true);
          announce(t("memory.settings.profileDraftCopied"));
          setTimeout(() => { if (current()) setProfileDraftCopied(false); }, 1500);
        };
        // 剪贴板失败要说话：这个方法唯一的产出就是"文本进了剪贴板"，静默失败
        // 会让用户以为复制成功、粘贴时却拿到旧内容（草稿是只读 <pre>，选中再
        // 复制是她能自己走的退路，得明确告诉她走这条）。
        // 失败还要顺手撤掉「已复制」：成功态能挂 1.5 秒，这期间重试失败会同时出现
        // 「已复制」和「复制没成功」两句相反的话。
        const failed = () => {
          if (!current()) return;
          setProfileDraftCopied(false);
          setProfileDraftCopyFailed(true);
          announce(t("memory.settings.profileDraftCopyFailed"));
        };
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).then(ok, () => copyProfileDraftFallback(text) ? ok() : failed());
        } else {
          copyProfileDraftFallback(text) ? ok() : failed();
        }
      }

      // 没有 Clipboard API（非安全上下文 / 内嵌 webview 未授权）时的退路：
      // 临时 textarea + execCommand("copy")。失败返回 false，由调用方说话。
      function copyProfileDraftFallback(text) {
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.setAttribute("readonly", "");
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          const done = document.execCommand("copy");
          document.body.removeChild(ta);
          return done === true;
        } catch {
          return false;
        }
      }
      // 「Agent 眼中的你」自动事实（profile_facts 三表）：展示与人工修正独立于手填
      // 画像（#497 口径：user_settings 神圣，这里一个字都不写它）。增改删全走
      // POST /apply（删除=归档，可恢复），与 dream 自动轮共用后端同一份 applyOps
      // 与同一本账——前端不复述任何判据，也不自己维护第二份事实列表。
      const [factsCards, setFactsCards] = react.useState([]); // 卡清单是全局的，不随选中卡变化
      const [factsRows, setFactsRows] = react.useState(null); // null = 还没读到/读失败（fail-closed，不拿旧卡的行冒充这张卡）
      const [factsJournal, setFactsJournal] = react.useState([]);
      const [factsRuns, setFactsRuns] = react.useState([]);
      const [factsAgent, setFactsAgent] = react.useState(""); // "" = default 卡
      const [factsEditId, setFactsEditId] = react.useState(null);
      const [factsEditDraft, setFactsEditDraft] = react.useState("");
      const [factsNew, setFactsNew] = react.useState("");
      const [factsBusy, setFactsBusy] = react.useState(false); // apply 提交中
      const [factsRunning, setFactsRunning] = react.useState(false); // 手动维护轮进行中
      // apply 的一次性回执：{kind, text}。failures / dupsSkipped 必须如实摆出来——
      // 把失败装成成功，人会以为删掉的事实在下一轮不会再来。
      const [factsNotice, setFactsNotice] = react.useState(null);
      // 手动维护轮的结局文案（profileDraft 的 kind 分支同款）：把「没启用」「没配模型」
      // 「模型不配合」压成一句「失败」，用户就只能瞎猜该去修什么。
      const [factsRunEnd, setFactsRunEnd] = react.useState(null);
      // 总闸快照只管「立即更新」按钮的可用性：null = 还没读到（读失败不猜，按钮保持
      // 可用，点下去由后端 409 disabled 兜底）；事实的展示与人工修正不受这个闸管。
      const [factsFlag, setFactsFlag] = react.useState(null);
      // 与 loadPreview 同一套序号守卫：先切 A 再切 B，A 的响应后到不能盖掉 B 的。
      const factsSeq = react.useRef(0);
      const loadFacts = react.useCallback(async (agentKey) => {
        const seq = ++factsSeq.current;
        try {
          const res = await apiFetch(`/api/dsh-mneme/profile-facts?agent=${encodeURIComponent(agentKey)}`);
          const body = await res.json().catch(() => null);
          if (seq !== factsSeq.current) return;
          if (res.ok && body && Array.isArray(body.facts)) {
            setFactsCards(Array.isArray(body.cards) ? body.cards.filter((k) => typeof k === "string") : []);
            setFactsRows(body.facts);
            setFactsJournal(Array.isArray(body.journal) ? body.journal : []);
            setFactsRuns(Array.isArray(body.runs) ? body.runs : []);
          } else {
            // 503 unavailable / 后端过旧：行清空走「读不到」文案；卡清单是全局的，
            // 保留上次读到的，选择器不至于闪空。
            setFactsRows(null);
            setFactsJournal([]);
            setFactsRuns([]);
          }
        } catch {
          if (seq === factsSeq.current) {
            setFactsRows(null);
            setFactsJournal([]);
            setFactsRuns([]);
          }
        }
      }, []);
      // 切卡先清行再取：上一张卡的事实留在屏上会被当成这张的（同 loadPreview 的
      // 单一所有者纪律——这里没有直接写数据，都交给 loadFacts）。维护轮结局一并
      // 清：A 卡跑完的「已更新 N 条」不该显示在 B 卡下（评审 P3：跨卡残留）。
      react.useEffect(() => {
        setFactsRows(null);
        setFactsEditId(null);
        setFactsEditDraft("");
        setFactsNotice(null);
        setFactsRunEnd(null);
        loadFacts(factsAgent);
      }, [factsAgent, loadFacts]);
      // 总闸快照：features 由功能开关卡管写，这里只读不写、失败不猜。功能开关卡
      // 即改即存并广播 mneme:features-changed——不监听的话，按提示开了「自动事实」
      // 还得关面板重开才解禁（正是广播工作项要消灭的那类体验）。
      react.useEffect(() => {
        let cancelled = false;
        const loadFlag = () => {
          apiFetch("/api/dsh-mneme/features")
            .then((res) => (res.ok ? res.json() : null))
            .then((j) => {
              if (cancelled) return;
              const eff = (j && j.effective) || {};
              setFactsFlag(eff.profileFactsEnabled === true);
            })
            .catch(() => {}); // 读失败保持 null：按钮不锁死，409 兜底
        };
        loadFlag();
        window.addEventListener("mneme:features-changed", loadFlag);
        return () => { cancelled = true; window.removeEventListener("mneme:features-changed", loadFlag); };
      }, []);
      // 人工修正统一入口：一张卡上的小批量 ops 一次 POST，回来重取 GET 让账本跟上，
      // 并刷新注入预览（事实段是注入文本的一部分，预览别停在编辑前）。
      async function applyFactsOps(ops) {
        if (factsBusy) return null;
        setFactsBusy(true);
        try {
          const res = await apiFetch("/api/dsh-mneme/profile-facts/apply", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agent: factsAgent, ops })
          });
          const body = await res.json().catch(() => null);
          if (!res.ok || !body || !Array.isArray(body.facts)) {
            setFactsNotice({ kind: "fail", text: t("memory.settings.factsApplyError") });
            announce(t("memory.settings.factsApplyError"));
            return null;
          }
          const fails = Array.isArray(body.failures) ? body.failures : [];
          const dups = Number(body.dupsSkipped) || 0;
          let text = t("memory.settings.factsApplyDone");
          let kind = "ok";
          if (fails.length || dups > 0) {
            const parts = [];
            if (fails.length) parts.push(t("memory.settings.factsApplyFailures").replace("{n}", String(fails.length)));
            if (dups > 0) parts.push(t("memory.settings.factsApplyDups").replace("{n}", String(dups)));
            text = parts.join(" · ");
            kind = fails.length ? "fail" : "dup";
          }
          setFactsNotice({ kind, text });
          announce(text);
          await loadFacts(factsAgent);
          return body;
        } catch {
          setFactsNotice({ kind: "fail", text: t("memory.settings.factsApplyError") });
          announce(t("memory.settings.factsApplyError"));
          return null;
        } finally {
          setFactsBusy(false);
        }
      }
      async function addFact() {
        const content = factsNew.trim();
        if (!content) return;
        const body = await applyFactsOps([{ op: "add", content }]);
        // 与既有活跃事实重复的 add 会被后端跳过并计数：输入框照常清空，跳了几条
        // 由提示条说明，别让人以为没点上。
        if (body) setFactsNew("");
      }
      function startFactEdit(f) {
        setFactsEditId(f.id);
        setFactsEditDraft(typeof f.content === "string" ? f.content : "");
      }
      function cancelFactEdit() {
        setFactsEditId(null);
        setFactsEditDraft("");
      }
      async function saveFactEdit() {
        if (factsEditId === null) return;
        const content = factsEditDraft.trim();
        if (!content) return;
        const editId = factsEditId;
        const body = await applyFactsOps([{ op: "update", id: editId, content }]);
        // 只有这条真的写进去了才收起编辑框；它自己的 op 失败时留着草稿，别让人重打。
        if (body && !(Array.isArray(body.failures) && body.failures.some((x) => x && x.id === editId))) {
          cancelFactEdit();
        }
      }
      async function archiveFact(id) {
        await applyFactsOps([{ op: "archive", id }]);
      }
      // 手动维护轮：结局按后端 error 码分派——no-route 重跑也一样、unparseable 等
      // 可重试、disabled 是闸没开，三种话不能混。跑完重取 GET 并刷新预览。
      async function runFacts() {
        if (factsRunning || factsBusy) return;
        setFactsRunning(true);
        setFactsRunEnd(null);
        try {
          const res = await apiFetch("/api/dsh-mneme/profile-facts/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agent: factsAgent })
          });
          const body = await res.json().catch(() => null);
          if (res.ok && body && typeof body.status === "string") {
            const n = Number(body.opsApplied) || 0;
            setFactsRunEnd(body.status === "noop" ? { kind: "noop" } : { kind: "ok", n });
            announce(t(body.status === "noop" ? "memory.settings.factsRunNoop" : "memory.settings.factsRunOk").replace("{n}", String(n)));
          } else {
            const error = body && typeof body.error === "string" ? body.error : "";
            const kind = error === "disabled" ? "disabled" : error === "no-route" ? "noroute" : "failed";
            setFactsRunEnd({ kind });
            announce(t(kind === "disabled" ? "memory.settings.factsRunDisabled"
              : kind === "noroute" ? "memory.settings.factsRunNoRoute"
              : "memory.settings.factsRunFailed"));
          }
          await loadFacts(factsAgent);
        } catch {
          setFactsRunEnd({ kind: "failed" });
          announce(t("memory.settings.factsRunFailed"));
        } finally {
          setFactsRunning(false);
        }
      }
      // 账本行的摘要截断：before/after 各 ~40 字符，长了加省略号——账本给「扫一眼」
      // 用，整句塞进来会把最近变更撑成一堵墙。
      const clipFactText = (s) => {
        const v = String(s ?? "");
        return v.length > 40 ? v.slice(0, 40) + "…" : v;
      };
      const factOpLabel = (op) => (op === "add" ? t("memory.settings.factsOpAdd")
        : op === "update" ? t("memory.settings.factsOpUpdate")
        : op === "archive" ? t("memory.settings.factsOpArchive")
        : String(op ?? ""));

      useEffect(() => {
        let dead = false;
        setPhase("loading");
        apiFetch("/api/dsh-mneme/persona")
          .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
          .then((r) => {
            if (dead) return;
            const raw = r.ok && r.body && r.body.persona && typeof r.body.persona === "object" ? r.body.persona : null;
            // 读不到就说读不到：这里不拿空壳冒充「一张卡都没有」。
            if (!raw) { setPhase("unknown"); return; }
            setDraft(personaStoreShape(raw));
            setPhase("ready");
          })
          .catch(() => { if (!dead) setPhase("unknown"); });
        return () => { dead = true; };
      }, [tick]);

      useEffect(() => {
        let dead = false;
        apiFetch("/api/dsh-mneme/features")
          .then((res) => (res.ok ? res.json() : null))
          .then((j) => {
            if (dead || !j) return;
            const eff = j.effective || {};
            setStrict(eff.personaStrictAddressing === true);
          })
          .catch(() => { /* 读不到就按关处理：告示宁可不出现，也不给人假警报 */ });
        return () => { dead = true; };
      }, [tick]);

      useEffect(() => {
        let dead = false;
        setDiary(undefined);
        apiFetch("/api/dsh-mneme/diary/library")
          .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
          .then((r) => {
            if (dead) return;
            setDiary(r.ok && r.body && Array.isArray(r.body.buckets) ? r.body.buckets : null);
          })
          .catch(() => { if (!dead) setDiary(null); });
        return () => { dead = true; };
      }, [tick]);

      // 预览序号守卫同设置页：先切 A 再切 B 时 A 的 GET 可能后回来，
      // 没这道判断就会「编辑位是 B、预览是 A」——那张卡的标题写着「真正会注入的文本」，
      // 显示别张卡的文本比不显示更糟。
      useEffect(() => {
        const seq = ++previewSeq.current;
        setPreview(undefined);
        const q = editing && editing !== "default" ? "?agent=" + encodeURIComponent(editing) : "";
        apiFetch("/api/dsh-mneme/persona" + q)
          .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
          .then((r) => {
            if (seq !== previewSeq.current) return;
            setPreview(r.ok && r.body && r.body.preview && typeof r.body.preview.text === "string" ? r.body.preview : null);
          })
          .catch(() => {
            if (seq !== previewSeq.current) return;
            setPreview(null);
          });
      }, [editing, previewTick]);

      const ready = phase === "ready" && !!draft;
      const current = !ready
        ? emptyPersonaCard()
        : editing === "default"
          ? draft.default
          : draft.byAgent[editing] || emptyPersonaCard();

      const save = async (next) => {
        try {
          const res = await apiFetch("/api/dsh-mneme/persona", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ persona: next })
          });
          if (!res.ok) throw new Error("HTTP " + res.status);
          setError("");
          setSavedAt(Date.now());
          setPreviewTick((n) => n + 1);
        } catch (err) {
          // 保存失败必须冒出来：v1 的静默 catch 曾把 404 吞成「看着像保存了」。
          setError((err && err.message) || "failed");
        }
      };

      const setField = (key, value) => {
        if (!ready) return;
        if (editing === "default") {
          setDraft({ ...draft, default: { ...draft.default, [key]: value } });
          return;
        }
        setDraft({
          ...draft,
          byAgent: { ...draft.byAgent, [editing]: { ...(draft.byAgent[editing] || emptyPersonaCard()), [key]: value } }
        });
      };

      const saveEditing = () => {
        if (!ready) return;
        save(draft);
      };

      // 开关即存（与设置页同语义），但仍走三维全量：只换自己这一维。
      const toggleEnabled = (checked) => {
        if (!ready) return;
        const nextCard = { ...current, enabled: checked };
        const next = editing === "default"
          ? { ...draft, default: nextCard }
          : { ...draft, byAgent: { ...draft.byAgent, [editing]: nextCard } };
        setDraft(next);
        save(next);
      };

      const addCard = () => {
        const id = newName.trim();
        if (!ready || !id || id === "default" || draft.byAgent[id]) return;
        const next = { ...draft, byAgent: { ...draft.byAgent, [id]: { ...emptyPersonaCard(), name: id } } };
        setDraft(next);
        setNewName("");
        setEditing(id);
        save(next);
      };

      const removeCard = (id) => {
        if (!ready || id === "default" || !draft.byAgent[id]) return;
        const next = { ...draft.byAgent };
        delete next[id];
        const out = { ...draft, byAgent: next };
        setDraft(out);
        if (editing === id) setEditing("default");
        save(out);
      };

      // 日记侧：桶的署名来自 frontmatter 的 `persona: <source> (<agent>)`，
      // 与「ta 的日记」面板同一个解析器，不另写一份。
      const buckets = Array.isArray(diary) ? diary : [];
      const name = String(editing || "");
      const mine = name && name !== "default"
        ? buckets.filter((b) => diaryBucketName(b, draft).toLowerCase() === name.toLowerCase())
        : [];
      const entryTotal = mine.reduce((sum, b) => sum + (Number(b.count) || 0), 0);
      const latest = mine.map((b) => String(b.latest || "")).sort().pop() || "";
      const allTotal = buckets.reduce((sum, b) => sum + (Number(b.count) || 0), 0);
      const sessionCards = ready ? Object.keys(draft.bySession) : [];
      const cardCount = ready ? Object.keys(draft.byAgent).length + Object.keys(draft.bySession).length : 0;

      const head = h("div", { className: "mneme-persona-head" },
        h(PersonaGlyph, { size: 16 }),
        h("span", { className: "mneme-persona-title" }, t("memory.persona.title")),
        h("span", { className: "mneme-persona-spacer" }),
        h("button", {
          type: "button", className: "mneme-diary-btn",
          onClick: () => { setTick((n) => n + 1); setPreviewTick((n) => n + 1); }
        }, t("memory.diary.retry")));

      let body = null;
      let about = null;
      if (phase === "loading") {
        body = h("div", { className: "mneme-diary-empty" }, t("memory.persona.loading"));
      } else if (phase === "unknown") {
        body = h("div", { className: "mneme-diary-empty" },
          h("span", { className: "mneme-diary-warn" }, t("memory.persona.readFailed")));
      } else {
        const cards = h("div", { className: "mneme-persona-col" },
          h("div", { className: "mneme-persona-label" }, t("memory.persona.cards")),
          h("div", { className: "mneme-persona-card" },
            h("button", {
              type: "button",
              className: "mneme-persona-pick" + (editing === "default" ? " mneme-persona-pick--on" : ""),
              onClick: () => setEditing("default")
            }, t("memory.persona.defaultCard"))),
          Object.keys(draft.byAgent).map((id) => h("div", { key: id, className: "mneme-persona-card" },
            h("button", {
              type: "button",
              className: "mneme-persona-pick" + (editing === id ? " mneme-persona-pick--on" : ""),
              title: id,
              onClick: () => setEditing(id)
            }, draft.byAgent[id].name || id),
            h("button", {
              type: "button", className: "mneme-persona-del",
              title: t("memory.persona.delete"), "aria-label": t("memory.persona.delete"),
              onClick: () => removeCard(id)
            }, "×"))),
          h("div", { className: "mneme-persona-new" },
            h("input", {
              className: "mneme-set-input", style: { marginBottom: 0, flex: "1 1 auto", minWidth: 0 },
              value: newName, placeholder: t("memory.persona.newPlaceholder"),
              onChange: (e) => setNewName(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") addCard(); }
            }),
            h("button", { type: "button", className: "mneme-btn", onClick: addCard }, t("memory.persona.add"))),
          sessionCards.length
            ? h("div", { className: "mneme-persona-note" },
              t("memory.persona.factsLinked") + " (" + sessionCards.length + ")")
            : null);

        const field = (key, label, placeholder, rows) => h(react.Fragment, null,
          h("label", { className: "mneme-persona-label", htmlFor: "mneme-persona-" + key }, label),
          rows
            ? h("textarea", {
              id: "mneme-persona-" + key, className: "mneme-set-input mneme-set-input--area",
              style: { marginBottom: 0 }, placeholder: placeholder,
              value: current[key] || "", onChange: (e) => setField(key, e.target.value)
            })
            : h("input", {
              id: "mneme-persona-" + key, className: "mneme-set-input",
              style: { marginBottom: 0 }, placeholder: placeholder,
              value: current[key] || "", onChange: (e) => setField(key, e.target.value)
            }));

        const previewNode = preview === undefined
          ? h("div", { className: "mneme-persona-note" }, t("memory.persona.loading"))
          : preview === null
            ? h("div", { className: "mneme-persona-note" }, t("memory.persona.previewUnknown"))
            : preview.text
              ? h("pre", { className: "mneme-persona-preview" }, preview.text)
              : h("div", { className: "mneme-persona-note" }, t("memory.persona.previewEmpty"));

        const diaryNote = diary === undefined
          ? t("memory.persona.loading")
          : diary === null
            ? t("memory.persona.readFailed")
            : name === "default"
              ? t("memory.persona.diaryCount").replace("{count}", String(allTotal)).replace("{latest}", "—")
              : entryTotal
                ? t("memory.persona.diaryCount").replace("{count}", String(entryTotal)).replace("{latest}", latest || "—")
                : t("memory.persona.diaryNone");

        const sheet = h("div", { className: "mneme-persona-sheet" },
          h("div", { className: "mneme-persona-note" }, t("memory.persona.hint")),
          strict ? h("div", {
            style: { padding: "8px 10px", borderLeft: "3px solid var(--mneme-warn)", fontSize: 12, lineHeight: "18px", color: "var(--mneme-fg-dim)" }
          },
            t(cardCount > 0 ? "memory.persona.strictAfter" : "memory.persona.strictBefore")) : null,
          minimalWarn ? h("div", {
            style: { padding: "8px 10px", borderLeft: "3px solid var(--mneme-warn)", fontSize: 12, lineHeight: "18px" }
          },
            h("div", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, t("memory.status.minimalPresetTitle")),
            h("div", { style: { marginTop: 4, color: "var(--mneme-fg-dim)" } }, t("memory.status.minimalPresetBody"))
          ) : null,
          h("label", { className: "mneme-persona-label" }, t("memory.persona.enabled")),
          h("div", { className: "mneme-set-row" },
            h("label", { className: "mneme-set-ruletext" },
              h("input", {
                type: "checkbox", checked: current.enabled === true,
                onChange: (e) => toggleEnabled(e.target.checked)
              }),
              " " + (current.enabled
                ? t("memory.persona.enabledOn")
                : t("memory.persona.enabledOff")))),
          field("name", t("memory.persona.name"), t("memory.settings.personaNamePlaceholder"), false),
          field("personality", t("memory.persona.personality"), t("memory.settings.personaPersonalityPlaceholder"), true),
          field("replyStyle", t("memory.persona.replyStyle"), t("memory.settings.personaReplyStylePlaceholder"), true),
          field("scenario", t("memory.persona.scenario"), t("memory.persona.scenarioPlaceholder"), true),
          field("mesExample", t("memory.persona.mesExample"), t("memory.persona.mesExamplePlaceholder"), true),
          h("div", { className: "mneme-persona-diaryrow" },
            h("button", { type: "button", className: "mneme-diary-btn", onClick: saveEditing }, t("memory.persona.save")),
            savedAt ? h("span", { className: "mneme-diary-ok" }, t("memory.persona.saved")) : null,
            error ? h("span", { className: "mneme-diary-warn" }, t("memory.persona.saveFailed") + " (" + error + ")") : null),
          h("div", { className: "mneme-persona-label" }, t("memory.persona.preview")),
          previewNode,
          h("div", { className: "mneme-persona-diary" },
            h("div", { className: "mneme-persona-label" }, t("memory.persona.diary")),
            h("div", { className: "mneme-persona-note" }, t("memory.persona.diaryHint")),
            h("div", { className: "mneme-persona-diaryrow" }, diaryNote,
              diary === undefined ? null : h("button", {
                type: "button", className: "mneme-diary-btn",
                onClick: () => setPreviewTick((n) => n + 1)
              }, t("memory.persona.previewRefresh")))));

        body = h("div", { className: "mneme-persona-body" }, cards, sheet);

        // 画像与自动事实（原设置页「个性化」里的两张卡）。人格页本身就是竖向排布：
        // 上面是这三张卡，这一块独占下方可滚动的区域，不与卡片选择器抢横向空间。
        about = h("div", { className: "mneme-persona-about" },
          h("div", { className: "mneme-persona-label" }, t("memory.persona.about")),
          h("section", { className: "mneme-set-card" },
            h("div", { className: "mneme-set-title" }, t("memory.settings.profile")),
            h("div", { className: "mneme-set-desc" }, t("memory.settings.profileHint")),
            h("textarea", {
              className: "mneme-set-input mneme-set-input--area",
              value: profile,
              placeholder: t("memory.settings.profile"),
              onChange: (e) => setProfile(e.target.value)
            }),
            h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
              h("button", { className: "mneme-btn", onClick: () => saveProfile() }, t("memory.settings.profileSave")),
              saved && h("span", { className: "mneme-saved" }, t("memory.settings.profileSaved")),
              profileError ? h("span", { className: "mneme-saved", style: { color: "var(--mneme-danger)" } },
                t("memory.settings.profileSaveFailed") + " (" + profileError + ")") : null
            ),
            // 从记忆提取草稿（#497）。**放在这张卡上而不是「用户画像」卡**：画像那一栏是
            // 用户自己手填的地方；这一段是从记忆里反推出来的「Agent 眼中的你」，属于可
            // 沉淀的那一侧。它只出**副本**——不写 user_settings，也不碰手写画像（桉桉
            // 2026-11-04 定的口径：只展示副本）。要改成手写画像只能自己复制再粘过去。
            h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 12 } },
              h("button", {
                type: "button",
                className: "mneme-btn",
                disabled: profileExtracting,
                onClick: extractProfileDraft
              }, t("memory.settings.profileExtract")),
              profileExtracting ? h("span", { className: "mneme-saved" }, t("memory.settings.profileExtracting")) : null
            ),
            h("div", { className: "mneme-set-desc" }, t("memory.settings.profileExtractHint")),
            profileDraft?.kind === "disabled" ? h("div", { className: "mneme-set-desc" }, t("memory.settings.profileExtractDisabled")) : null,
            profileDraft?.kind === "empty" ? h("div", { className: "mneme-set-desc" }, t("memory.settings.profileExtractEmpty")) : null,
            profileDraft?.kind === "noroute" ? h("div", { className: "mneme-set-desc" }, t("memory.settings.profileExtractNoRoute")) : null,
            profileDraft?.kind === "failed" ? h("div", { className: "mneme-set-desc" }, t("memory.settings.profileExtractFailed")) : null,
            profileDraft?.kind === "draft" ? h("div", null,
              h("div", { className: "mneme-featnumlabel" }, t("memory.settings.profileDraftTitle")),
              h("div", { className: "mneme-set-desc" },
                t("memory.settings.profileDraftRows") + ": " + profileDraft.rowsUsed
                + (profileDraft.truncated ? " · " + t("memory.settings.profileDraftTruncated") : "")),
              h("pre", { className: "mneme-set-input mneme-set-input--area", style: { whiteSpace: "pre-wrap", minHeight: 0 } }, profileDraft.text),
              h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 6 } },
                h("button", { type: "button", className: "mneme-btn", onClick: copyProfileDraft },
                  profileDraftCopied ? t("memory.settings.profileDraftCopied") : t("memory.settings.profileDraftCopy")),
                h("button", { type: "button", className: "mneme-btn", onClick: () => {
                  profileCopyTicket.current += 1;
                  setProfileDraft(null);
                  setProfileDraftCopied(false);
                  setProfileDraftCopyFailed(false);
                } }, t("memory.settings.profileDraftDiscard")),
                h("span", { className: "mneme-set-desc" }, t("memory.settings.profileDraftCopyHint")),
                profileDraftCopyFailed ? h("span", { className: "mneme-set-desc", role: "alert", style: { color: "var(--mneme-danger)" } },
                  t("memory.settings.profileDraftCopyFailed")) : null
              )
            ) : null
          ),
          // 自动事实（profile_facts）：dream 后自动维护的「Agent 眼中的你」，按会话身份
          // 分卡。放在注入预览卡之后——预览里事实段的来源就在这里，看预览的人顺势就能
          // 找到改它的地方；规则是用户立的另一域（另一张卡），不混。
          h("section", { className: "mneme-set-card" },
            h("div", { className: "mneme-set-title" }, t("memory.settings.factsTitle")),
            h("div", { className: "mneme-set-desc" }, t("memory.settings.factsHint")),
            // 卡选择器：default + 各身份卡，人格卡同款 chip 形态；切换即重取（effect 里清行）。
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
              h("button", {
                type: "button",
                className: "mneme-btn" + (factsAgent === "" ? " mneme-btn--active" : ""),
                onClick: () => setFactsAgent("")
              }, t("memory.settings.personaDefaultCard")),
              // 选中卡即使这轮从清单里消失（事实全归档且无同 scope 记忆）也不让它从
              // 选择器上失踪——正在编辑的人不能失去落点。
              [...new Set([factsAgent, ...factsCards])].filter((k) => k && k.trim()).map((k) =>
                h("button", {
                  key: k,
                  type: "button",
                  className: "mneme-btn" + (factsAgent === k ? " mneme-btn--active" : ""),
                  onClick: () => setFactsAgent(k)
                }, k))
            ),
            factsRows === null
              ? h("div", { className: "mneme-xempty" }, t("memory.settings.factsUnavailable"))
              : h("div", null,
                  // 只列活跃行：归档的行留在账本里可追溯，不再回到清单上（恢复=重新添加）。
                  factsRows.filter((f) => f && f.status === "active").length === 0
                    ? h("div", { className: "mneme-xempty" }, t("memory.settings.factsEmpty"))
                    : null,
                  factsRows.filter((f) => f && f.status === "active").map((f) =>
                    factsEditId === f.id
                      ? h("div", { key: f.id, className: "mneme-set-row" },
                          h("input", {
                            className: "mneme-set-input",
                            style: { marginBottom: 0, flex: "1 1 auto" },
                            value: factsEditDraft,
                            autoFocus: true,
                            onChange: (e) => setFactsEditDraft(e.target.value),
                            onKeyDown: (e) => {
                              if (e.key === "Enter") saveFactEdit();
                              if (e.key === "Escape") cancelFactEdit();
                            }
                          }),
                          h("button", { type: "button", className: "mneme-btn", disabled: factsBusy, onClick: saveFactEdit },
                            t("memory.settings.factsRowSave")),
                          h("button", { type: "button", className: "mneme-btn", disabled: factsBusy, onClick: cancelFactEdit },
                            t("memory.settings.factsRowCancel"))
                        )
                      : h("div", { key: f.id, className: "mneme-set-row" },
                          h("span", { className: "mneme-set-ruletext", style: { flex: "1 1 auto" } }, f.content),
                          // ✎ 与 × 都走 mneme-set-del（悬停显形）：低频动作不常驻，
                          // 与规则卡同一套视觉语言。
                          h("button", {
                            type: "button",
                            className: "mneme-set-del",
                            title: t("memory.settings.factsRowEdit"),
                            "aria-label": t("memory.settings.factsRowEdit"),
                            onClick: () => startFactEdit(f)
                          }, "✎"),
                          // 删除不二次确认：archive 可恢复（账本里留 before），打断比误删贵。
                          h("button", {
                            type: "button",
                            className: "mneme-set-del",
                            title: t("memory.settings.factsRowDelete"),
                            "aria-label": t("memory.settings.factsRowDelete"),
                            onClick: () => archiveFact(f.id)
                          }, "×")
                        )
                  ),
                  h("div", { style: { display: "flex", gap: 8, marginTop: 6 } },
                    h("input", {
                      className: "mneme-set-input",
                      style: { marginBottom: 0 },
                      value: factsNew,
                      placeholder: t("memory.settings.factsAddPlaceholder"),
                      onChange: (e) => setFactsNew(e.target.value),
                      onKeyDown: (e) => { if (e.key === "Enter") addFact(); }
                    }),
                    h("button", { type: "button", className: "mneme-btn", disabled: factsBusy, onClick: addFact },
                      t("memory.settings.factsAdd"))
                  ),
                  // apply 回执：失败（role=alert）与跳重如实摆出来，全成才说成功。
                  factsNotice
                    ? h("div", {
                        className: "mneme-set-desc",
                        role: factsNotice.kind === "fail" ? "alert" : undefined,
                        style: { color: factsNotice.kind === "fail" ? "var(--mneme-danger)" : undefined }
                      }, factsNotice.text)
                    : null,
                  // 手动维护轮：总闸快照关着就禁用（features 只读不写）；快照没读到时
                  // 不锁——点下去由后端 409 disabled 给出同款解释。
                  h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 12 } },
                    h("button", {
                      type: "button",
                      className: "mneme-btn",
                      disabled: factsRunning || factsFlag === false,
                      onClick: runFacts
                    }, factsRunning ? t("memory.settings.factsRunning") : t("memory.settings.factsRun")),
                    factsRunning ? h("span", { className: "mneme-saved" }, t("memory.settings.factsRunning")) : null
                  ),
                  factsFlag === false ? h("div", { className: "mneme-set-desc" }, t("memory.settings.factsGateOff")) : null,
                  // 五种结局各一句话（profileDraft 的 kind 分支同款）。
                  factsRunEnd?.kind === "ok" ? h("div", { className: "mneme-set-desc" },
                    t("memory.settings.factsRunOk").replace("{n}", String(factsRunEnd.n))) : null,
                  factsRunEnd?.kind === "noop" ? h("div", { className: "mneme-set-desc" }, t("memory.settings.factsRunNoop")) : null,
                  factsRunEnd?.kind === "disabled" ? h("div", { className: "mneme-set-desc" }, t("memory.settings.factsRunDisabled")) : null,
                  factsRunEnd?.kind === "noroute" ? h("div", { className: "mneme-set-desc" }, t("memory.settings.factsRunNoRoute")) : null,
                  factsRunEnd?.kind === "failed" ? h("div", { className: "mneme-set-desc", role: "alert", style: { color: "var(--mneme-danger)" } },
                    t("memory.settings.factsRunFailed")) : null,
                  // 最近变更（账本尾 8 条，后端按新→旧给）：时间 + op + 内容变化 + actor 徽章。
                  h("div", { className: "mneme-featnumlabel", style: { marginTop: 12 } }, t("memory.settings.factsJournalTitle")),
                  factsJournal.length === 0 ? h("div", { className: "mneme-xempty" }, t("memory.settings.factsJournalEmpty")) : null,
                  factsJournal.slice(0, 8).map((j) =>
                    h("div", { key: j.id, className: "mneme-set-row", style: { flexWrap: "wrap", gap: 6 } },
                      h("span", { className: "mneme-set-desc", title: j.at }, formatRelativeTime(j.at, t)),
                      h("span", { className: "mneme-set-ruletext" }, factOpLabel(j.op)),
                      h("span", { className: "mneme-set-desc", style: { flex: "1 1 160px" } },
                        // add 只展示新值；archive 只展示旧值（op 标签已经说了归档）；
                        // update 才有真正的 before→after。
                        j.op === "add" ? "+ " + clipFactText(j.after)
                          : j.op === "archive" ? clipFactText(j.before)
                          : clipFactText(j.before) + " → " + clipFactText(j.after)),
                      h("span", { className: "mneme-badge " + (j.actor === "manual" ? "mneme-badge--scope" : "mneme-badge--default") },
                        t(j.actor === "manual" ? "memory.settings.factsActorManual" : "memory.settings.factsActorAuto"))
                    )
                  ),
                  // 最近一轮维护（回执尾 1 条，后端按新→旧给）：状态 + 输入/应用计数。
                  factsRuns[0]
                    ? h("div", { className: "mneme-set-desc" },
                        t("memory.settings.factsRunLast")
                        + (factsRuns[0].status === "ok" ? t("memory.settings.factsRunStatusOk")
                          : factsRuns[0].status === "noop" ? t("memory.settings.factsRunStatusNoop")
                          : factsRuns[0].status === "failed" ? t("memory.settings.factsRunStatusFailed")
                          : String(factsRuns[0].status ?? ""))
                        + " · " + t("memory.settings.factsRunCounts")
                          .replace("{input}", String(Number(factsRuns[0].input_count) || 0))
                          .replace("{ops}", String(Number(factsRuns[0].ops_applied) || 0)))
                    : null
                )
          ),
        );
      }

      return h("div", { className: "mneme-persona" }, head, body, about);
    }

    // 右栏 tab 的座位注册（仅在 diaryEnabled 开启后被调用）。与 M.O. 那套同样的三条纪律：
    // ① 类型注册与正文座位各自兜自己的异常；② 类型注册要幂等（宿主对重复的
    // 类型 id 会抛）；③ **必须同时给一个能 openTab 的入口**，否则页签不可达。
    function registerDiarySeats(ctx, t) {
      // 与 M.O. 同一个判据：右栏页面类型按 kind 打开（openTab(kind)）。
      // 服务半可用 / kind 未注册时抛错 → 返回 false，入口按钮如实报「打不开」。
      try {
        const tabs = typeof ctx.get === "function" ? ctx.get("sidebarRightTabs") : null;
        if (tabs && typeof tabs.register === "function") {
          ctx.slots.inject("sidebar.right.pane.tab", () => {
            return ctx.slots.register({
              name: "sidebar.right.pane.tab",
              key: DIARY_TAB_ID,
              inject: (sessionId) => ({ sessionId })
            }, (props) => {
              const sid = props && props.sessionId;
              // agent 与 session 同源（都从这一个 sessionId 取），自动轮那条纪律：
              // 人格与素材必须是同一个人，否则写出「A 的声音 + B 的事」。
              return h(DiaryPane, {
                t,
                project: sessionProject(ctx, sid),
                agent: sessionAgent(ctx, sid),
                session: sid || null
              });
            });
          });
          ctx.slots.inject("sidebar.right.pane.tab.title", () => {
            return ctx.slots.register({
              name: "sidebar.right.pane.tab.title",
              key: DIARY_TAB_ID
            }, () => t("memory.diary.title"));
          });
        }
      } catch (err) {
        console.warn("[dsh-mneme] diary pane body registration failed:", err);
      }
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, dictionaries), "dsh-mneme: dictionaries");

      // --- 入口座位 ---
      // --- chorography（仓库地志）面板（M1，spec §7）---------------------
      // 浏览页：左模块树 / 右正文 / 顶部检索。数据从 /choro/* 四条读路由来，
      // 真源是仓库磁盘的 MD。座位无条件注册（P11）：inject 同名二次注册的
      // cordis 语义没验证过，不赌；chorographyEnabled 关着时页面渲染「未启用」
      // 空态（路由 409 disabled），开关生效走既有「重启生效」纪律——座位常挂
      // 的收敛形态就是 D2 拆双 Cordis 条目时的样子。
      function WikiGlyph({ size }) {
        // 图形走 currentColor，粗细对比交给宿主的 active 态；不引入新色值。
        return h("span", { className: "mneme-paneliglyph", "aria-hidden": "true" },
          h("svg", {
            width: size || 18, height: size || 18, viewBox: "0 0 24 24",
            fill: "none", stroke: "currentColor", strokeWidth: 1.8,
            strokeLinecap: "round", strokeLinejoin: "round"
          },
            h("path", { d: "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" }),
            h("path", { d: "M9 4v14" }),
            h("path", { d: "M15 6v14" })
          )
        );
      }


      function WikiMainPanel({ t }) {
        // #607：这个面板以前只有一条「去看 CLI」的空态，一个可点的东西都没有。
        // 现在空态自带「填绝对路径 → 生成」的入口，所以 state 里多三样东西：
        // path（那个输入框）、flags（顶栏两枚子开关的生效值）、t1（T1 长任务的
        // 进度快照）与 toast（补完之后的一次性回执）。
        const [state, setState] = useState({
          phase: "loading", repos: [], repo: null, modules: [], edges: [], page: null,
          hits: [], q: "", selected: null, disabled: false, error: null,
          rebuilding: false, rebuildNote: null, path: "", flags: null, t1: null, toast: "",
          cliCommand: null, copied: false
        });
        // T1 跑完要重读当前仓库的模块树，但轮询的闭包里拿不到最新的 state.repo：
        // 用 ref 记住加载成功的仓库 id，避免把整棵树塞进 effect 依赖里。
        const repoIdRef = useRef(null);
        // apiFetch 是裸 fetch：非 2xx 不抛错，返回 Response。这里统一解 JSON 并把
        // 状态码带回来——409 disabled（用户没开）/ 503 unavailable（装配缺件）
        // 各有各的空态文案（#497 的语义分叉在这里接住）。
        const readJson = async (res) => {
          let data = {};
          try { data = await res.json(); } catch { /* 空响应体 */ }
          return { status: res.status, data };
        };
        // 顶栏两枚子开关的生效值：/features 是 open 读路由，和设置卡读的是同一份
        // 快照（overrides ?? config），面板不再自己猜默认值——猜错的表现是开关
        // 显示「开」但按钮照样回 disabled。
        const loadFlags = useCallback(async () => {
          try {
            const { status, data } = await readJson(await apiFetch("/api/dsh-mneme/features"));
            if (status !== 200) return;
            const eff = (data && data.effective) || {};
            // 键名原样保留（不在这里改写成短名）：界面上两枚开关切换时要把
            // 同一个键 PUT 回 /features，两份名字只会多一次映射错的机会。
            setState((s) => ({
              ...s,
              flags: {
                chorographyAutoRefresh: eff.chorographyAutoRefresh === true,
                chorographyT1FromPanel: eff.chorographyT1FromPanel !== false
              }
            }));
          } catch { /* 读不到就按契约默认渲染，不把整页打成错误态 */ }
        }, []);
        const load = useCallback(async (repoRef) => {
          try {
            const { status, data } = await readJson(await apiFetch(`/api/dsh-mneme/choro/repos`));
            if (status === 409) { setState((s) => ({ ...s, phase: "disabled" })); return; }
            if (status === 503) { setState((s) => ({ ...s, phase: "unavailable" })); return; }
            const repos = data.repos ?? [];
            // #607：命令串由服务端算好（面板 bundle 拿不到 CLI 入口路径）。缺字段时
            // 留 null，空态退回 fallback 文案——不在这里拼一条可能跑不起来的命令。
            const cliCommand = typeof data.cliCommand === "string" && data.cliCommand ? data.cliCommand : null;
            if (repos.length === 0) { setState((s) => ({ ...s, phase: "no-repo", repos: [], repo: null, cliCommand })); return; }
            const ref = repoRef ?? (repos.length === 1 ? repos[0].id : null);
            if (ref === null) { setState((s) => ({ ...s, phase: "pick-repo", repos, repo: null })); return; }
            const mod = await readJson(await apiFetch(`/api/dsh-mneme/choro/modules?repo=${encodeURIComponent(ref)}`));
            if (mod.status !== 200) { setState((s) => ({ ...s, phase: "error", error: `modules ${mod.status}` })); return; }
            // T1 轮询的闭包拿不到最新的 state.repo，用 ref 记住当前仓库 id；
            // 同时把 repos 一起存进 state，顶栏的「代码已变」标记按 id 在列表里找
            // （/choro/modules 的 repo 只有 id/name，没有 stale）。
            const loaded = mod.data.repo;
            repoIdRef.current = loaded && loaded.id != null ? loaded.id : ref;
            setState((s) => ({ ...s, phase: "ready", repos, repo: loaded, modules: mod.data.modules ?? [], edges: mod.data.edges ?? [], page: null, selected: null }));
          } catch (err) {
            setState((s) => ({ ...s, phase: "error", error: String(err?.message ?? err) }));
          }
        }, []);
        useEffect(() => { load(); loadFlags(); }, [load, loadFlags]);
        const openPage = useCallback(async (slug) => {
          const repo = state.repo;
          if (!repo) return;
          setState((s) => ({ ...s, selected: slug, page: null }));
          try {
            const { status, data } = await readJson(await apiFetch(`/api/dsh-mneme/choro/page?repo=${encodeURIComponent(repo.id)}&slug=${encodeURIComponent(slug)}`));
            if (status !== 200 || data.error) { setState((s) => ({ ...s, page: { error: data.error ?? `page ${status}` } })); return; }
            setState((s) => ({ ...s, page: data.page }));
          } catch (err) {
            setState((s) => ({ ...s, page: { error: String(err?.message ?? err) } }));
          }
        }, [state.repo]);
        const runSearch = useCallback(async (q) => {
          setState((s) => ({ ...s, q }));
          const repo = state.repo;
          if (!repo || !q.trim()) { setState((s) => ({ ...s, hits: [] })); return; }
          try {
            const { data } = await readJson(await apiFetch(`/api/dsh-mneme/choro/search?repo=${encodeURIComponent(repo.id)}&q=${encodeURIComponent(q)}`));
            setState((s) => ({ ...s, hits: data.hits ?? [] }));
          } catch { setState((s) => ({ ...s, hits: [] })); }
        }, [state.repo]);
        // 重建骨架（收尾档 P34）：POST /choro/run（token-write），T0 apply 秒级
        // 同步回执。T1 语义富化是长任务，不上 HTTP——按钮旁的空态/提示会引导去
        // CLI（t1Loss 警告也从服务端原样透出）。
        const rebuild = useCallback(async () => {
          const repo = state.repo;
          if (!repo || state.rebuilding) return;
          setState((s) => ({ ...s, rebuilding: true, rebuildNote: null }));
          try {
            const { status, data } = await readJson(await apiFetch("/api/dsh-mneme/choro/run", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ repo: repo.id })
            }));
            if (status !== 200 || !data.ok) {
              setState((s) => ({ ...s, rebuilding: false, rebuildNote: `${t("wiki.rebuild.failed")}: ${data.detail ?? data.error ?? status}` }));
              return;
            }
            const r = data.receipt ?? {};
            const loss = (r.warnings ?? []).find((w) => /T1|语义/.test(w));
            setState((s) => ({
              ...s,
              rebuilding: false,
              rebuildNote: `${t("wiki.rebuild.done")}: ${r.moduleCount ?? "?"} ${t("wiki.rebuild.modules")} / ${r.pageCount ?? "?"} ${t("wiki.rebuild.pages")}${loss ? ` — ${loss}` : ""}`
            }));
            await load(repo.id);
          } catch (err) {
            setState((s) => ({ ...s, rebuilding: false, rebuildNote: `${t("wiki.rebuild.failed")}: ${String(err?.message ?? err)}` }));
          }
        }, [state.repo, state.rebuilding, load, t]);

        // 复制命令（#607）：issue 作者的原话是「用户怎么可能手动跑起来这个命令」。
        // 光把命令写好不够——长路径手抄一遍就是一次抄错的机会，所以给复制按钮。
        // 失败必须说出来：剪贴板在非安全上下文里不存在，静默失败等于点了没反应。
        const copyCommand = useCallback(() => {
          const text = state.cliCommand;
          if (!text) return;
          const done = () => { setState((s) => ({ ...s, copied: true })); announce(t("wiki.empty.copied")); setTimeout(() => setState((s) => ({ ...s, copied: false })), 1500); };
          const failed = () => announce(t("wiki.empty.copyFailed"));
          const clip = typeof navigator !== "undefined" ? navigator.clipboard : null;
          if (clip && typeof clip.writeText === "function") { clip.writeText(text).then(done, failed); return; }
          failed();
        }, [state.cliCommand, t]);

        // #607 的另一半：空态那条路也得能直接生成。这里收的是一个【路径】而不是
        // 一个已登记的 repo id——新目录第一次进来自报家门用的就是它。body 同时
        // 带 repo（有的话）与 path：A 线按 §3.2 扩出来的处理取 path、老实现取
        // repo，两版后端都能跑，面板不用跟着后端版本改。
        const runPaths = useCallback(async () => {
          const p = state.path.trim();
          if (!p) { setState((s) => ({ ...s, rebuildNote: t("wiki.run.pathRequired") })); return; }
          if (state.rebuilding) return;
          setState((s) => ({ ...s, rebuilding: true, rebuildNote: null, error: null }));
          try {
            const body = { path: p };
            if (state.repo && state.repo.id != null) body.repo = state.repo.id;
            const { status, data } = await readJson(await apiFetch("/api/dsh-mneme/choro/run", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body)
            }));
            if (status !== 200 || !data.ok) {
              // not-git 是这条路上最常见的一次失败（用户填了仓库里的某个子目录），
              // 单说「生成失败: not-git」等于没说——换成一句解释为什么被拒。
              // 两个码都要认：服务端把 wiki 层的 err.code "not-git" 翻成了对外契约里的
              // "not-a-git-repo"（src/api.js 的 run 分叉），只认一个就会出现「同样的
              // 失败在旧后端有人话、新后端只有错误码」这种半修状态。
              const why = data.error === "not-git" || data.error === "not-a-git-repo"
                ? t("wiki.run.notGit")
                : data.error === "path-not-absolute"
                  ? t("wiki.run.notAbsolute")
                  : data.error === "path-not-found"
                    ? t("wiki.run.notFound")
                    : (data.detail ?? data.error ?? status);
              setState((s) => ({ ...s, rebuilding: false, rebuildNote: `${t("wiki.run.failed")}: ${why}` }));
              return;
            }
            const r = data.receipt ?? {};
            setState((s) => ({
              ...s,
              rebuilding: false,
              rebuildNote: `${t("wiki.rebuild.done")}: ${r.moduleCount ?? "?"} ${t("wiki.rebuild.modules")} / ${r.pageCount ?? "?"} ${t("wiki.rebuild.pages")}`
            }));
            // 生成成功之后回到正常浏览态：重新拉一遍 repos 就会自己走进 ready。
            setState((s) => ({ ...s, path: "" }));
            await load();
          } catch (err) {
            setState((s) => ({ ...s, rebuilding: false, rebuildNote: `${t("wiki.run.failed")}: ${String(err?.message ?? err)}` }));
          }
        }, [state.path, state.repo, state.rebuilding, load, t]);

        // 顶栏两枚开关。写回走 /features 的全量快照（PUT 回来就是 snapshot），
        // 所以成功后直接换掉 flags，不必再打一次 GET。
        const toggleFlag = useCallback(async (key) => {
          const cur = state.flags || {};
          const next = !cur[key];
          setState((s) => ({ ...s, flags: { ...(s.flags || {}), [key]: next } }));
          try {
            const res = await apiFetch("/api/dsh-mneme/features", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ [key]: next })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await res.json();
          } catch (err) {
            // 回滚显示：开关留在「已开」而服务端没存，是最难查的那种假成功。
            setState((s) => ({ ...s, flags: { ...(s.flags || {}), [key]: cur[key] }, toast: `${t("wiki.flag.saveFailed")}: ${String(err?.message ?? err)}` }));
          }
        }, [state.flags, t]);

        // T1：30–240 秒起步的长任务，POST 只负责起跑，进度靠 2s 一次的轮询。
        // 回落三种非 200 都有话可说：409 disabled 是开关没开、409 job-running
        // 是已经有一轮在跑（直接把那个 jobId 接过来看）、其它按失败处理。
        const startT1 = useCallback(async () => {
          if (state.t1 && state.t1.state === "running") return;
          const repo = state.repo;
          const body = {};
          if (repo && repo.id != null) body.repo = repo.id;
          if (state.selected) body.module = state.selected;
          setState((s) => ({ ...s, toast: "", rebuildNote: null }));
          try {
            const { status, data } = await readJson(await apiFetch("/api/dsh-mneme/choro/t1", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body)
            }));
            if (status === 200 && data.jobId) {
              setState((s) => ({ ...s, t1: { jobId: data.jobId, state: "running" } }));
              return;
            }
            if (status === 409 && data.error === "disabled") {
              setState((s) => ({ ...s, toast: t("wiki.t1.disabled") }));
              return;
            }
            if (status === 409 && data.error === "job-running" && data.jobId) {
              setState((s) => ({ ...s, t1: { jobId: data.jobId, state: "running" }, toast: t("wiki.t1.running") }));
              return;
            }
            setState((s) => ({ ...s, toast: `${t("wiki.t1.failed")}: ${data.detail ?? data.error ?? status}` }));
          } catch (err) {
            setState((s) => ({ ...s, toast: `${t("wiki.t1.failed")}: ${String(err?.message ?? err)}` }));
          }
        }, [state.repo, state.selected, state.t1, t]);

        // 轮询只在「有一个 running 的 job」时挂表：依赖故意取 jobId 而不是整个
        // t1 对象，否则每轮 setState 都会把定时器拆了重建，2s 变成 2s+渲染时间。
        const t1JobId = state.t1 && state.t1.state === "running" ? state.t1.jobId : null;
        useEffect(() => {
          if (!t1JobId) return undefined;
          let stopped = false;
          const tick = async () => {
            try {
              const { status, data } = await readJson(await apiFetch(`/api/dsh-mneme/choro/t1/status?jobId=${encodeURIComponent(t1JobId)}`));
              if (stopped || status !== 200 || !data) return;
              setState((s) => ({ ...s, t1: { ...(s.t1 || {}), ...data } }));
              if (data.state === "done") {
                const mods = data.modules || {};
                setState((s) => ({ ...s, toast: `${t("wiki.t1.done")}: ${mods.done ?? 0}/${mods.total ?? 0} ${t("wiki.t1.modules")}${mods.failed ? ` · ${mods.failed} ${t("wiki.t1.failedCount")}` : ""}` }));
                // 语义正文补完 = 磁盘页变了，模块树里的页状态跟着变，重读一遍。
                if (repoIdRef.current != null) await load(repoIdRef.current);
              } else if (data.state === "failed") {
                setState((s) => ({ ...s, toast: `${t("wiki.t1.failed")}: ${data.error ?? ""}` }));
              }
            } catch { /* 单次轮询失败不终止整轮：下一拍还会重试 */ }
          };
          const timer = setInterval(tick, 2000);
          return () => { stopped = true; clearInterval(timer); };
        }, [t1JobId, load, t]);

        // toast 自清：和面板里其它 toast 同一个 2.5s 节奏。
        useEffect(() => {
          if (!state.toast) return undefined;
          const timer = setTimeout(() => setState((s) => (s.toast ? { ...s, toast: "" } : s)), 2500);
          return () => clearTimeout(timer);
        }, [state.toast]);

        // 「代码已变」标记：/choro/modules 回的 repo 只有 id/name，stale 在
        // /choro/repos 那份列表里（契约 §3.2），按 id 对回去。
        const staleRepo = (state.repos || []).find((r) => state.repo && r.id === state.repo.id && r.stale === true);

        if (state.phase === "loading") return h("div", { className: "mneme-panel mneme-wikiempty" }, t("wiki.state.loading"));
        if (state.phase === "disabled") return h("div", { className: "mneme-panel mneme-wikiempty" }, t("wiki.empty.disabled"));
        if (state.phase === "unavailable") return h("div", { className: "mneme-panel mneme-wikiempty" }, t("wiki.state.unavailable"));
        if (state.phase === "error") return h("div", { className: "mneme-panel mneme-wikiempty" }, `${t("wiki.state.error")}: ${state.error}`);
        // issue #607 的正面修复：这一屏不许再「只有一句话」。给出可直接操作的
        // 入口（填绝对路径 → 生成），CLI 降级成「可选方式」，且写明命令不在
        // PATH 里、收的是路径参数（以前那句「在仓库目录里跑」把人引去 cd）。
        if (state.phase === "no-repo") {
          return h("div", { className: "mneme-panel mneme-wikiempty" },
            h("div", { className: "mneme-wikiemptytitle" }, t("wiki.panel.open")),
            h("p", null, t("wiki.empty.noRepo")),
            h("div", { className: "mneme-wikirunrow" },
              h("input", {
                className: "mneme-wikisearch",
                placeholder: t("wiki.empty.pathPlaceholder"),
                value: state.path,
                onChange: (e) => { const v = e.target.value; setState((s) => ({ ...s, path: v })); },
                onKeyDown: (e) => { if (e.key === "Enter") runPaths(); },
                "aria-label": t("wiki.empty.pathPlaceholder")
              }),
              h("button", {
                type: "button",
                className: "mneme-wikibtn",
                disabled: state.rebuilding,
                onClick: runPaths
              }, state.rebuilding ? t("wiki.empty.generating") : t("wiki.empty.generate"))),
            state.rebuildNote && h("div", { className: "mneme-wikirebuildnote mneme-wikirunwide" }, state.rebuildNote),
            h("details", { className: "mneme-wikicli" },
              h("summary", null, t("wiki.empty.cliSummary")),
              state.cliCommand
                ? h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
                    h("code", { className: "mneme-set-token", style: { flex: 1, minWidth: 0, wordBreak: "break-all" } }, state.cliCommand),
                    h("button", { className: "mneme-btn", type: "button", onClick: copyCommand }, state.copied ? t("wiki.empty.copied") : t("wiki.empty.copy")))
                : h("pre", { className: "mneme-wikipre" }, t("wiki.empty.cliCmd")),
              h("p", { className: "mneme-wikiclihint" }, t("wiki.empty.cliHint"))),
            h("p", { className: "mneme-set-hint", style: { marginTop: 10 } }, t("wiki.empty.noRepo.where")),
            state.toast && h("div", { className: "mneme-toast", role: "status" }, state.toast));
        }
        if (state.phase === "pick-repo") {
          return h("div", { className: "mneme-panel mneme-wikiempty" },
            h("div", { className: "mneme-wikiemptytitle" }, t("wiki.empty.pickRepo")),
            state.repos.map((r) => h("button", {
              key: r.id, type: "button", className: "mneme-wikitreeitem",
              onClick: () => load(r.id)
            }, `${r.name}`)));
        }
        const tree = [];
        for (const mod of state.modules) {
          const depth = (mod.slug.match(/-/g) || []).length;
          tree.push(h("button", {
            key: mod.slug,
            type: "button",
            className: `mneme-wikitreeitem${state.selected === mod.slug ? " mneme-active" : ""}`,
            style: { paddingLeft: `${8 + Math.min(depth, 4) * 14}px` },
            title: mod.title,
            onClick: () => openPage(mod.slug)
          }, mod.slug));
        }
        const pageBody = state.page
          ? (state.page.error
            ? h("div", { className: "mneme-wikiempty" }, state.page.error === "page-missing" ? t("wiki.state.pageMissing") : state.page.error)
            : renderWikiMarkdown(state.page.content))
          : h("div", { className: "mneme-wikiempty" }, t("wiki.state.pickPage"));
        const flags = state.flags || {};
        const t1Running = !!(state.t1 && state.t1.state === "running");
        return h("div", { className: "mneme-panel" },
          h("div", { className: "mneme-wikibar" },
            h("span", { className: "mneme-wikirepo" }, state.repo ? `${state.repo.name}` : ""),
            // 契约 §3.5-2：stale 的仓库行内显示「代码已变」。徽章复用 pending
            // 那一档（warn 语义 = 你看到的和你以为的不一样），不新造颜色。
            staleRepo && h("span", {
              className: "mneme-badge mneme-badge--pending mneme-wikistale",
              title: t("wiki.stale.hint")
            }, t("wiki.stale")),
            h("input", {
              className: "mneme-wikisearch",
              placeholder: t("wiki.search.placeholder"),
              value: state.q,
              onChange: (e) => runSearch(e.target.value),
              "aria-label": t("wiki.search.placeholder")
            }),
            h("button", {
              type: "button",
              className: "mneme-wikibtn",
              disabled: state.rebuilding,
              title: t("wiki.rebuild.hint"),
              onClick: rebuild
            }, state.rebuilding ? t("wiki.rebuilding") : t("wiki.rebuild")),
            // 顶栏两枚开关：和设置卡里那两行是同一对键，面板里就地切是为了
            // 不必跳出浏览页去设置里找。禁用态只在读不到 /features 时出现。
            h("button", {
              type: "button",
              className: `mneme-wikibtn mneme-wikitoggle${flags.chorographyAutoRefresh ? " mneme-on" : ""}`,
              role: "switch",
              "aria-checked": String(!!flags.chorographyAutoRefresh),
              title: t("memory.features.chorographyAutoRefresh.hint"),
              onClick: () => toggleFlag("chorographyAutoRefresh")
            }, `${t("wiki.flag.autoRefresh")}${flags.chorographyAutoRefresh ? " ✓" : ""}`),
            h("button", {
              type: "button",
              className: `mneme-wikibtn mneme-wikitoggle${flags.chorographyT1FromPanel ? " mneme-on" : ""}`,
              role: "switch",
              "aria-checked": String(!!flags.chorographyT1FromPanel),
              title: t("memory.features.chorographyT1FromPanel.hint"),
              onClick: () => toggleFlag("chorographyT1FromPanel")
            }, `${t("wiki.flag.t1FromPanel")}${flags.chorographyT1FromPanel ? " ✓" : ""}`),
            // 发起按钮与上面那枚闸分开：闸关着时按钮仍在（点了回 409 disabled
            // 并给出「去哪儿打开」），比直接隐藏更好——藏起来的话用户只会觉得
            // 「按钮没了」，而不会知道是哪个开关。
            h("button", {
              type: "button",
              className: "mneme-wikibtn",
              disabled: t1Running,
              title: t("memory.features.chorographyT1FromPanel.hint"),
              onClick: startT1
            }, t1Running ? t("wiki.t1.running") : t("wiki.t1")),
            state.rebuildNote && h("span", { className: "mneme-wikirebuildnote" }, state.rebuildNote)),
          h("div", { className: "mneme-wikibody" },
            h("nav", { className: "mneme-wikitree", "aria-label": t("wiki.tree.title") }, tree),
            h("div", { className: "mneme-wikipage" },
              state.hits.length > 0 && h("div", { className: "mneme-wikihits" },
                state.hits.map((hit, idx) => h("button", {
                  key: `${hit.slug}-${hit.line}-${idx}`,
                  type: "button",
                  className: "mneme-wikihit",
                  onClick: () => { setState((s) => ({ ...s, hits: [] })); openPage(hit.slug); }
                }, `${hit.slug} · ${hit.section} · L${hit.line}: ${hit.excerpt}`)),
                h("button", { type: "button", className: "mneme-wikihitsclose", onClick: () => setState((s) => ({ ...s, hits: [] })) }, "×")),
              pageBody)),
          // T1 进度：只在一个 job 活着时出现。数字来自 /choro/t1/status 的
          // modules 汇总，不再由面板自己数模块——那是任务侧的真相。
          t1Running && h("div", { className: "mneme-wikit1bar", role: "status" },
            `${t("wiki.t1.running")} ${t("wiki.t1.progress")} ${(state.t1.modules && state.t1.modules.done) || 0}/${(state.t1.modules && state.t1.modules.total) || "?"} ${t("wiki.t1.modules")}`),
          state.toast && h("div", { className: "mneme-toast", role: "status" }, state.toast));
      }

    // 知识库座位的图标：书脊 + 书页，和「仓库地志」的地图图标区分开。
    // 这里只画 glyph，不自己造按钮（宿主 PanelRow 负责点击，见座位块注释）。
    function KbGlyph({ size }) {
      const s = size || 18;
      return h("span", { className: "mneme-paneliglyph", "aria-hidden": "true" },
        h("svg", {
          width: s, height: s, viewBox: "0 0 24 24", fill: "none",
          stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round"
        },
          h("path", { d: "M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z" }),
          h("path", { d: "M8 3v18" }),
          h("path", { d: "M12 8h5" })));
    }

    // 知识库面板（契约 §3.6）。两种失败态必须自己解释清楚，#607 的教训：
    // 空态本身就是说明书——说清这是什么、属于哪个插件、去哪儿打开。
    // 后端每 409/503 都有专门文案，绝不把裸状态码丢到屏幕上。
    function KbMainPanel({ t }) {
      const [state, setState] = useState({
        phase: "loading", error: null,
        collections: [], active: null, docs: [], docsPhase: "idle",
        newKey: "", newTitle: "", confirming: null,
        kind: "file", source: "", title: "",
        ingesting: false, toast: "",
        // reposPhase 单开一格：/choro/repos 也会 409/503（地志开关没开、queries 没装配），
        // 那两种情况若混进 repos=[] 就会显示成「还没有仓库，先去生成一次」——把环境问题
        // 说成用户没做操作，正是 #607 那类假成功。
        repos: [], reposPhase: "loading", repoId: null, modules: [], moduleSlug: "",
        organizing: null, organizeErrors: [], advOpen: false,
        search: "", searching: false, hits: []
      });
      // 选中集合同时存一份 ref：load() 是异步的，等它回来时 state.active 可能
      // 已经被用户点走，只有 ref 能给出「刚刚那个」。
      const activeRef = useRef(null);
      const patch = useCallback((next) => setState((s) => ({ ...s, ...next })), []);
      // readJson 每次渲染都是新函数，故意不进任何依赖数组：进了会把下面每一个
      // useCallback 每帧重建，再顺着 useEffect 把请求打成死循环。
      const readJson = async (res) => {
        let data = {};
        try { data = await res.json(); } catch (e) { data = {}; }
        return { status: res.status, data };
      };

      const loadDocs = useCallback(async (key) => {
        if (!key) { patch({ active: null, docs: [], docsPhase: "idle" }); return; }
        patch({ docsPhase: "loading" });
        try {
          const res = await apiFetch("/api/dsh-mneme/kb/docs?collection=" + encodeURIComponent(key));
          const json = await readJson(res);
          if (json.status === 200) patch({ docs: json.data.docs || [], docsPhase: "ready" });
          else patch({ docs: [], docsPhase: "error", error: String(json.status) });
        } catch (e) {
          patch({ docs: [], docsPhase: "error", error: String((e && e.message) || e) });
        }
      }, [patch]);

      const load = useCallback(async () => {
        try {
          const res = await apiFetch("/api/dsh-mneme/kb/collections");
          const json = await readJson(res);
          // 409 = 开关没开，503 = 宿主没装配。两者都给说明书，不给状态码。
          if (json.status === 409) { patch({ phase: "disabled" }); return; }
          if (json.status === 503) { patch({ phase: "unavailable" }); return; }
          if (json.status !== 200) { patch({ phase: "error", error: String(json.status) }); return; }
          const cols = json.data.collections || [];
          const prev = activeRef.current;
          const next = prev && cols.some((c) => c.key === prev) ? prev : (cols.length > 0 ? cols[0].key : null);
          activeRef.current = next;
          patch({ phase: "ready", collections: cols, active: next, error: null });
          await loadDocs(next);
        } catch (e) {
          patch({ phase: "error", error: String((e && e.message) || e) });
        }
      }, [patch, loadDocs]);

      const loadModules = useCallback(async (repoId) => {
        try {
          const res = await apiFetch("/api/dsh-mneme/choro/modules?repo=" + encodeURIComponent(repoId));
          const json = await readJson(res);
          if (json.status !== 200) { patch({ modules: [], moduleSlug: "" }); return; }
          const mods = json.data.modules || [];
          patch({ modules: mods, moduleSlug: mods.length > 0 ? mods[0].slug : "" });
        } catch (e) {
          patch({ modules: [], moduleSlug: "" });
        }
      }, [patch]);

      // 地志页导入要的是磁盘上的绝对路径，根路径只有 /choro/repos 有（契约 §3.2），
      // 所以这里单取一份仓库列表，不去改 /choro/page 的回执形状（那是两处真源）。
      // #607 教训：409（地志开关没开）/ 503（宿主没装配 queries）不是「你还没有仓库」，
      // 必须单列一格 reposPhase，否则环境问题会被显示成用户什么都没做。
      const loadRepos = useCallback(async () => {
        try {
          const res = await apiFetch("/api/dsh-mneme/choro/repos");
          const json = await readJson(res);
          if (json.status === 409) { patch({ repos: [], reposPhase: "disabled" }); return; }
          if (json.status === 503) { patch({ repos: [], reposPhase: "unavailable" }); return; }
          if (json.status !== 200) { patch({ repos: [], reposPhase: "error" }); return; }
          const repos = json.data.repos || [];
          patch({ repos, reposPhase: repos.length > 0 ? "ready" : "empty" });
          if (repos.length > 0 && repos[0].id !== undefined) {
            patch({ repoId: repos[0].id });
            await loadModules(repos[0].id);
          }
        } catch (e) {
          patch({ repos: [], reposPhase: "error" });
        }
      }, [patch, loadModules]);

      const createCollection = useCallback(async () => {
        const key = String(state.newKey || "").trim();
        if (!key) { patch({ toast: t("kb.col.key") }); return; }
        try {
          const res = await apiFetch("/api/dsh-mneme/kb/collections", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key, title: String(state.newTitle || "").trim() || key, description: "" })
          });
          const json = await readJson(res);
          if (json.status !== 200 || json.data.ok !== true) {
            patch({ toast: t("kb.load.failed") + ": " + (json.data.detail || json.data.error || json.status) });
            return;
          }
          activeRef.current = key;
          patch({ newKey: "", newTitle: "", confirming: null });
          await load();
        } catch (e) {
          patch({ toast: t("kb.load.failed") + ": " + String((e && e.message) || e) });
        }
      }, [state.newKey, state.newTitle, patch, load, t]);

      // 删除是两步：第一次只把按钮换成「再点一次确认」。不用 window.confirm，
      // 宿主 webview 里它不一定存在（同样的理由见 :6134 的批注）。
      const deleteCollection = useCallback(async (key) => {
        if (state.confirming !== key) { patch({ confirming: key }); return; }
        try {
          const res = await apiFetch("/api/dsh-mneme/kb/collections?key=" + encodeURIComponent(key), { method: "DELETE" });
          const json = await readJson(res);
          if (json.status !== 200 || json.data.ok !== true) {
            patch({ toast: t("kb.load.failed") + ": " + (json.data.detail || json.data.error || json.status), confirming: null });
            return;
          }
          if (activeRef.current === key) activeRef.current = null;
          patch({ confirming: null });
          await load();
        } catch (e) {
          patch({ toast: t("kb.load.failed") + ": " + String((e && e.message) || e), confirming: null });
        }
      }, [state.confirming, patch, load, t]);

      // 单条入库的公共落点：手动表单与「一键整理」都走它，免得两条路各写一份
      // 回执解析（#607 那类「两条路说法不一致」就是从复制粘贴开始的）。
      const postIngest = useCallback(async ({ collection, kind, source, title }) => {
        const body = { collection, kind, source };
        const trimmed = String(title || "").trim();
        if (trimmed) body.title = trimmed;
        const res = await apiFetch("/api/dsh-mneme/kb/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const json = await readJson(res);
        if (json.status !== 200 || json.data.ok !== true) {
          return { ok: false, error: String(json.data.detail || json.data.error || json.status) };
        }
        // skipped 是幂等命中（同 relKey + 同 sha256），不是失败，别混成一种回声。
        return { ok: true, skipped: json.data.skipped === true, chunks: json.data.chunks || 0 };
      }, []);

      const ingest = useCallback(async () => {
        const collection = state.active;
        if (!collection) { patch({ toast: t("kb.empty.collections") }); return; }
        const kind = state.kind === "choro" ? "choro_page" : state.kind;
        let source = String(state.source || "").trim();
        if (kind === "choro_page") {
          const repo = (state.repos || []).filter((r) => r.id === state.repoId)[0] || null;
          const mod = (state.modules || []).filter((m) => m.slug === state.moduleSlug)[0] || null;
          const rootPath = repo && repo.rootPath ? String(repo.rootPath) : "";
          const relPath = mod && mod.relPath ? String(mod.relPath) : "";
          // 拿不到根路径就停在这儿给一句人话——发出去必然是 404，用户只会更糊涂。
          if (!rootPath) { patch({ toast: t("kb.repo.noPath") }); return; }
          // 缺 relPath 与「没选模块」是两件事：前者是后端回执少字段、后者是用户没点。
          // 用同一句「请先选模块」会把真 bug 说成操作问题（#607 那种假成功），故分开。
          if (!relPath) { patch({ toast: t("kb.repo.noRelPath") }); return; }
          source = rootPath.replace(/[\\/]+$/, "") + "/" + relPath.replace(/^[\\/]+/, "");
        }
        if (!source) { patch({ toast: t("kb.doc.source") }); return; }
        patch({ ingesting: true });
        try {
          const out = await postIngest({ collection, kind, source, title: state.title });
          if (!out.ok) { patch({ ingesting: false, toast: t("kb.doc.failed") + ": " + out.error }); return; }
          // skipped 是幂等命中（同 relKey + 同 sha256），不是失败，别混成一种回声。
          const note = out.skipped
            ? t("kb.doc.skipped")
            : t("kb.doc.done") + ": " + out.chunks + " " + t("kb.col.chunks");
          patch({ ingesting: false, source: "", title: "", toast: note });
          await load();
        } catch (e) {
          patch({ ingesting: false, toast: t("kb.doc.failed") + ": " + String((e && e.message) || e) });
        }
      }, [state, patch, load, t, postIngest]);

      // 一键整理：把某个仓库的全部地志页依次灌进当前集合。
      // 之所以在前端循环而不是在后端加一个批量路由：kb 侧只认「一条来源一条 doc」，
      // 批量路由会引入第二套部分失败语义（哪几页进了、哪几页没进、能不能续跑），
      // 那属于要另做设计的东西；这边循环 + 一条汇总回执足够，且失败页能逐条报名字。
      const organizeRepo = useCallback(async (repo) => {
        const collection = state.active;
        if (!collection) { patch({ toast: t("kb.repos.needCollection") }); return; }
        const rootPath = repo && repo.rootPath ? String(repo.rootPath) : "";
        if (!rootPath) { patch({ toast: t("kb.repo.noPath") }); return; }
        patch({ organizing: repo.id });
        try {
          const res = await apiFetch("/api/dsh-mneme/choro/modules?repo=" + encodeURIComponent(repo.id));
          const json = await readJson(res);
          if (json.status !== 200) {
            patch({ organizing: null, toast: t("kb.load.failed") + ": " + String(json.status) });
            return;
          }
          // 只取真有地志页的模块：没 relPath 就是 choro_pages 里没这行（还没生成过骨架），
          // 硬灌进去只会得到一串 file-not-found，把「还没生成」说成「整理失败」。
          // 有 relPath 的页文件在磁盘上是存在的（T0 写骨架时一并落盘），status 只影响
          // 内容是骨架还是富化过，跟能不能读无关，所以不按 status 过滤。
          const pages = (json.data.modules || []).filter((m) => m.relPath);
          if (pages.length === 0) { patch({ organizing: null, toast: t("kb.repos.nopages") }); return; }
          let added = 0;
          let same = 0;
          const failed = [];
          for (const m of pages) {
            const src = rootPath.replace(/[\\/]+$/, "") + "/" + String(m.relPath).replace(/^[\\/]+/, "");
            const out = await postIngest({ collection, kind: "choro_page", source: src, title: m.title || "" });
            if (!out.ok) failed.push((m.title || m.slug || src) + " (" + out.error + ")");
            else if (out.skipped) same += 1;
            else added += 1;
          }
          // 回执把三档分开说：新增 / 未变 / 失败。合并成一句「整理完成」
          // 会让「一次都没进」也显示成功，正是 #607 那类假回声。
          const parts = [t("kb.repos.new") + " " + added, t("kb.repos.same") + " " + same];
          if (failed.length > 0) parts.push(t("kb.repos.failedN") + " " + failed.length);
          patch({ organizing: null, toast: parts.join(" · ") });
          await load();
          if (failed.length > 0) {
            // 失败明细留在页面上（toast 2.5 秒就没了，名字一多根本读不完）。
            patch({ organizeErrors: failed });
          } else {
            patch({ organizeErrors: [] });
          }
        } catch (e) {
          patch({ organizing: null, toast: t("kb.load.failed") + ": " + String((e && e.message) || e) });
        }
      }, [state.active, patch, load, t, postIngest]);

      const runSearch = useCallback(async () => {
        const query = String(state.search || "").trim();
        if (!query) { patch({ hits: [] }); return; }
        patch({ searching: true });
        try {
          const body = state.active ? { query, collection: state.active } : { query };
          const res = await apiFetch("/api/dsh-mneme/kb/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
          const json = await readJson(res);
          if (json.status !== 200) {
            patch({ searching: false, toast: t("kb.load.failed") + ": " + (json.data.detail || json.data.error || json.status) });
            return;
          }
          patch({ searching: false, hits: json.data.hits || [] });
        } catch (e) {
          patch({ searching: false, toast: t("kb.load.failed") + ": " + String((e && e.message) || e) });
        }
      }, [state.search, state.active, patch, t]);

      useEffect(() => { load(); }, [load]);
      // 仓库卡片是首屏内容，跟「手动入库选了哪种来源」无关，所以进页面就拉一次；
      // 底下高级表单切到 choro 时那次 loadRepos() 保留——那时可能已经换过集合。
      useEffect(() => { loadRepos(); }, [loadRepos]);
      // toast 自带计时器：它是回声，不该一直挂在页脚上占位置。
      useEffect(() => {
        if (!state.toast) return undefined;
        const timer = setTimeout(() => patch({ toast: "" }), 2500);
        return () => clearTimeout(timer);
      }, [state.toast, patch]);

      if (state.phase === "loading") {
        return h("div", { className: "mneme-panel mneme-wikiempty" },
          h("div", { className: "mneme-wikiemptytitle" }, t("kb.panel.open")),
          h("p", null, t("wiki.state.loading")));
      }
      if (state.phase === "disabled") {
        return h("div", { className: "mneme-panel mneme-wikiempty" },
          h("div", { className: "mneme-wikiemptytitle" }, t("kb.panel.open")),
          h("p", null, t("kb.col.intro")),
          h("p", null, t("kb.empty.disabled")));
      }
      if (state.phase === "unavailable") {
        return h("div", { className: "mneme-panel mneme-wikiempty" },
          h("div", { className: "mneme-wikiemptytitle" }, t("kb.panel.open")),
          h("p", null, t("kb.empty.unavailable")));
      }
      if (state.phase === "error") {
        return h("div", { className: "mneme-panel mneme-wikiempty" },
          h("div", { className: "mneme-wikiemptytitle" }, t("kb.panel.open")),
          h("p", null, t("kb.load.failed") + ": " + (state.error || "")),
          h("p", null, t("kb.empty.disabled")));
      }

      const collectionItems = state.collections.map((c) => h("button", {
        key: c.key,
        type: "button",
        className: "mneme-wikitreeitem" + (state.active === c.key ? " mneme-active" : ""),
        title: c.description || c.key,
        onClick: () => {
          activeRef.current = c.key;
          patch({ active: c.key, hits: [], confirming: null });
          loadDocs(c.key);
        }
      }, (c.title || c.key) + " · " + (c.docs || 0) + t("kb.col.docs") + " / " + (c.chunks || 0) + t("kb.col.chunks")));

      // 「已整理」按当前集合里已有的 relKey 前缀数：kb 侧 rel_key 存的就是磁盘绝对路径
      // （src/kb/index.js readSource），所以拿 rootPath 当前缀比就够了，不用为每张卡片
      // 再拉一次模块表——那会让打开知识库变成 N 次请求。
      const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
      const organizedCount = (repo) => {
        const root = norm(repo && repo.rootPath);
        if (!root) return 0;
        const prefix = root + "/";
        return (state.docs || []).filter((d) => {
          const rel = norm(d.relKey);
          return d.kind === "choro_page" && rel.startsWith(prefix);
        }).length;
      };

      const repoCards = (state.repos || []).map((repo) => {
        const rootPath = repo.rootPath ? String(repo.rootPath) : "";
        const done = organizedCount(repo);
        const total = Number(repo.pages || 0);
        const busy = state.organizing !== null && state.organizing === repo.id;
        return h("div", { key: String(repo.id), className: "mneme-kbrepo" },
          h("div", { className: "mneme-kbrepohead" },
            h("span", { className: "mneme-kbreponame" }, repo.name || rootPath || String(repo.id)),
            repo.stale === true && h("span", { className: "mneme-badge mneme-badge--pending mneme-wikistale" }, t("wiki.stale"))),
          h("div", { className: "mneme-kbrepometa" },
            h("span", null, String(Number(repo.modules || 0)) + " " + t("kb.repos.modules")),
            h("span", null, total + " " + t("kb.repos.pages")),
            h("span", null, t("kb.repos.organized") + " " + done + "/" + total),
            h("span", { className: "mneme-kbrepopath", title: rootPath }, rootPath)),
          h("button", {
            type: "button",
            className: "mneme-btn mneme-kbreporun",
            disabled: state.organizing !== null || total === 0 || !state.active,
            onClick: () => organizeRepo(repo)
          }, busy ? t("kb.repos.running") : t("kb.repos.run")));
      });

      const docRows = state.docs.map((d) => h("div", { key: d.relKey || d.title, className: "mneme-kbdocrow" },
        h("span", { className: "mneme-kbdoctitle" }, d.title || d.relKey),
        h("span", { className: "mneme-kbdocmeta" }, [d.kind, d.bytes ? d.bytes + "B" : "", d.indexedAt || "", d.status && d.status !== "ok" ? d.status : ""].filter(Boolean).join(" · ")),
        d.error && h("span", { className: "mneme-kbdocmeta" }, d.error)));

      return h("div", { className: "mneme-panel" },
        h("div", { className: "mneme-wikibar" },
          h("span", { className: "mneme-wikirepo" }, t("kb.panel.open")),
          h("input", {
            className: "mneme-wikisearch",
            value: state.search,
            placeholder: t("wiki.search.placeholder"),
            "aria-label": t("wiki.search.placeholder"),
            onChange: (e) => patch({ search: e.target.value }),
            onKeyDown: (e) => { if (e.key === "Enter") runSearch(); }
          }),
          h("button", { type: "button", className: "mneme-wikibtn", disabled: state.searching, onClick: runSearch },
            state.searching ? t("wiki.state.loading") : t("kb.search"))),
        h("div", { className: "mneme-wikibody" },
          h("nav", { className: "mneme-wikitree mneme-kbcol", "aria-label": t("kb.col.title") },
            h("div", { className: "mneme-kbcolhead" }, t("kb.col.title")),
            state.collections.length === 0 && h("p", { className: "mneme-kbcolhead" }, t("kb.empty.collections")),
            collectionItems,
            h("div", { className: "mneme-kbcolnew" },
              h("input", {
                className: "mneme-kbkey", value: state.newKey,
                placeholder: t("kb.col.key"), "aria-label": t("kb.col.key"),
                onChange: (e) => patch({ newKey: e.target.value }),
                onKeyDown: (e) => { if (e.key === "Enter") createCollection(); }
              }),
              h("input", {
                className: "mneme-kbkey", value: state.newTitle,
                placeholder: t("kb.col.name"), "aria-label": t("kb.col.name"),
                onChange: (e) => patch({ newTitle: e.target.value })
              }),
              h("button", { type: "button", className: "mneme-btn", onClick: createCollection }, t("kb.col.create")),
              state.active && h("button", {
                type: "button",
                className: "mneme-btn",
                onClick: () => deleteCollection(state.active)
              }, state.confirming === state.active ? t("kb.col.deleteConfirm") : t("kb.col.delete")))),
          h("div", { className: "mneme-wikipage" },
            state.hits.length > 0 && h("div", { className: "mneme-wikihits" },
              state.hits.map((hit, idx) => h("div", { key: idx, className: "mneme-wikihit" },
                [hit.collection, hit.relKey, hit.heading, hit.line ? "L" + hit.line : ""].filter(Boolean).join(" · ") + ": " + (hit.excerpt || ""))),
              h("button", { type: "button", className: "mneme-wikihitsclose", onClick: () => patch({ hits: [] }) }, "×")),
            h("p", { className: "mneme-kbcolhead" }, t("kb.col.intro")),

            // 仓库卡片区：Qoder 那种「在这儿选一个仓库，一键整理」的入口。
            // 三种非 ready 状态必须分开说（#607 教训）：地志没开 ≠ 宿主没装配 ≠
            // 你还没生成过仓库，混成一句「还没有仓库」等于让用户去修不存在的问题。
            h("div", { className: "mneme-kbsechead" }, t("kb.repos.title")),
            state.reposPhase === "loading" && h("p", { className: "mneme-kbdocmeta" }, t("wiki.state.loading")),
            state.reposPhase === "disabled" && h("p", { className: "mneme-kbdocmeta" }, t("kb.empty.disabled")),
            state.reposPhase === "unavailable" && h("p", { className: "mneme-kbdocmeta" }, t("kb.empty.unavailable")),
            state.reposPhase === "error" && h("p", { className: "mneme-kbdocmeta" }, t("kb.load.failed")),
            state.reposPhase === "empty" && h("p", { className: "mneme-kbdocmeta" }, t("kb.repos.empty")),
            repoCards.length > 0 && h("div", { className: "mneme-kbrepolist" }, repoCards),
            (state.organizeErrors || []).length > 0 && h("div", { className: "mneme-kbfails" },
              h("div", { className: "mneme-kbcolhead" }, t("kb.repos.failedN") + ": " + state.organizeErrors.length),
              state.organizeErrors.map((msg, i) => h("div", { key: i, className: "mneme-kbdocmeta" }, msg)),
              h("button", { type: "button", className: "mneme-btn", onClick: () => patch({ organizeErrors: [] }) }, "×")),

            // 手动入库降级成高级选项：保留能力，但不再占据首屏——它是「文件/网址/单页」
            // 这类少数场景的入口，日常路径是上面的卡片。用按钮而不是 <details>：
            // details 的展开态归浏览器管，React 再写 open 属性会两边打架。
            h("button", {
              type: "button",
              className: "mneme-btn mneme-kbadvtoggle",
              "aria-expanded": state.advOpen ? "true" : "false",
              onClick: () => patch({ advOpen: !state.advOpen })
            }, (state.advOpen ? "▾ " : "▸ ") + t("kb.advanced")),
            state.advOpen && h("div", { className: "mneme-kbform" },
              h("select", {
                className: "mneme-select", value: state.kind, "aria-label": t("kb.doc.kind"),
                onChange: (e) => {
                  const kind = e.target.value;
                  patch({ kind });
                  // 只有切到「从地志页导入」时才去拉仓库，别让普通入库也背上 choro 的请求。
                  if (kind === "choro" && state.repos.length === 0) loadRepos();
                }
              },
                h("option", { value: "file" }, t("kb.doc.kind.file")),
                h("option", { value: "url" }, t("kb.doc.kind.url")),
                h("option", { value: "choro" }, t("kb.doc.kind.choro"))),
              state.kind === "choro"
                ? h(react.Fragment, null,
                  h("select", {
                    className: "mneme-select",
                    value: state.repoId === null || state.repoId === undefined ? "" : String(state.repoId),
                    "aria-label": t("kb.repo.pick"),
                    onChange: (e) => {
                      const raw = e.target.value;
                      const repo = state.repos.filter((r) => String(r.id) === String(raw))[0] || null;
                      const id = repo ? repo.id : null;
                      patch({ repoId: id, modules: [], moduleSlug: "" });
                      if (id !== null) loadModules(id);
                    }
                  },
                    state.repos.length === 0 && h("option", { value: "" }, t("kb.repo.none")),
                    state.repos.map((r) => h("option", { key: r.id, value: String(r.id) }, r.name || r.rootPath || String(r.id)))),
                  h("select", {
                    className: "mneme-select", value: state.moduleSlug, "aria-label": t("kb.repo.module"),
                    onChange: (e) => patch({ moduleSlug: e.target.value })
                  },
                    state.modules.length === 0 && h("option", { value: "" }, t("kb.repo.pickFirst")),
                    state.modules.map((m) => h("option", { key: m.slug, value: m.slug }, m.title || m.slug))))
                : h("input", {
                  className: "mneme-kbkey", value: state.source,
                  placeholder: t("kb.doc.source"), "aria-label": t("kb.doc.source"),
                  onChange: (e) => patch({ source: e.target.value }),
                  onKeyDown: (e) => { if (e.key === "Enter") ingest(); }
                }),
              h("input", {
                className: "mneme-kbkey", value: state.title,
                placeholder: t("kb.doc.titleField"), "aria-label": t("kb.doc.titleField"),
                onChange: (e) => patch({ title: e.target.value })
              }),
              h("button", { type: "button", className: "mneme-btn", disabled: state.ingesting || !state.active, onClick: ingest },
                state.ingesting ? t("kb.doc.ingesting") : t("kb.doc.ingest"))),
            h("div", { className: "mneme-kbsechead" }, t("kb.doc.title")),
            state.docsPhase === "loading" && h("p", { className: "mneme-kbdocmeta" }, t("wiki.state.loading")),
            state.docsPhase !== "loading" && state.docs.length === 0 && h("p", { className: "mneme-kbdocmeta" }, t("kb.empty.docs")),
            docRows)),
        state.toast && h("div", { className: "mneme-toast", role: "status" }, state.toast));
    }

      // 两套宿主形态，二选一，靠宿主是否声明了 sidebar.panellist 判定：
      //  · 宿主内整页面板（首选）：sidebar.panellist 出图标、main 出中列整页。
      //    图标长在宿主自己的面板列表里（PanelRow 自己处理点击与 aria-current），
      //    插件只管渲染一颗 glyph，不自己造按钮、不自己调 selectPanel。
      //  · 老宿主回落：没有这两个座位时，footer.action 出按钮 + 居中 sheet，
      //    并保留 SidebarTopEntry 的 DOM portal（尽量把入口放到面板列表位置）。
      // 两套都挂同一个模块级 overlay 状态，但不会同时装：panellist 一旦出现就
      // 先把回落拆掉，否则侧栏会冒出两个记忆入口。
      // 判定 + 装载都收在两个闭包里：谁都可以问「宿主有没有这套座位」，
      // 也都可以在条件变化后重装回落——但同一时刻至多一份注册在册。
      const hostHasPanelSeat = () => typeof ctx.slots.spec === "function"
        && ctx.slots.spec("sidebar.panellist") !== undefined;
      let footerSeat = null;
      const dropFooterSeat = () => {
        if (footerSeat) { footerSeat(); footerSeat = null; }
      };
      const mountFooterSeat = () => {
        if (footerSeat || hostHasPanelSeat()) return;
        footerSeat = ctx.slots.register({
          name: "sidebar.footer.action",
          id: "dsh-mneme",
          order: 0,
          label: () => t("memory.panel.open")
        }, (props) => h(react.Fragment, null,
          h(SidebarTopEntry, {
            wide: !!(props && props.wide),
            t,
            fallback: h(SidebarFallbackTrigger, { wide: !!(props && props.wide), t })
          }),
          h(MemoryOverlay, { t })
        ));
      };

      ctx.slots.inject("sidebar.panellist", () => {
        dropFooterSeat();
        const disposeGlyph = ctx.slots.register({
          name: "sidebar.panellist",
          id: "dsh-mneme",
          // 排在宿主自己的面板之后（baleen 占 45）：记忆是高频入口，但排在
          // 已有面板之后不抢位。order 只影响列表排序，不影响可发现性。
          order: 60,
          label: () => t("memory.panel.open")
        }, (props) => h(SidebarPanelGlyph, { size: props && props.size }));
        // main 的 key 必须与上面侧栏的 id 逐字相同：宿主点面板行时调
        // layout.selectPanel(id)，它按 options.key 在 main 槽里找 entry，
        // 对不上直接抛 "main panel ... is not registered"。
        const disposeMain = ctx.slots.register({
          name: "main",
          key: "dsh-mneme"
        }, () => h(MnemeMainPanel, { t }));
        // chorography 第二个座位（M1）。成对规则只剩一半在这里：main 的 key
        // 仍是 "dsh-mneme-wiki" 且**无条件注册**——#562 那堵墙（布局里存着
        // activePanelId="dsh-mneme-wiki" 时少注册 main，宿主 selectPanel 直接
        // 抛 "main panel … is not registered"）。侧栏那一格不再无条件（#598）：
        // 默认关的功能不该常驻一个点进去只有「未启用」的入口，glyph 的登记挪进
        // 下面的座位闸，读 features 按 chorographyEnabled 决定。kb 座位（契约
        // §3.6）刻意保持无条件——「未启用」空态自己解释去哪儿开，是 #607 的
        // 另一种写法；两种形态并存是 #598 评论区 §四的拍板。
        const disposeWikiMain = ctx.slots.register({
          name: "main",
          key: "dsh-mneme-wiki"
        }, () => h(WikiMainPanel, { t }));
        // 知识库第三个座位（契约 §3.6）。和上面两个同理：id 与 key 逐字相同，
        // 否则宿主 selectPanel(id) 在 main 槽里找不到 entry 直接抛。
        // 座位无条件注册，开关只管内容层——这样「未启用」能自己解释去哪儿开，
        // 而不是让入口凭空消失（#607 的另一种写法）。
        const disposeKbGlyph = ctx.slots.register({
          name: "sidebar.panellist",
          id: "dsh-mneme-kb",
          order: 62,
          label: () => t("kb.panel.open")
        }, (props) => h(KbGlyph, { size: props && props.size }));
        const disposeKbMain = ctx.slots.register({
          name: "main",
          key: "dsh-mneme-kb"
        }, () => h(KbMainPanel, { t }));
        return () => {
          disposeGlyph();
          disposeMain();
          // wiki glyph 不在这把扫帚里了：它的登记随座位闸走（#598），
          // 生命周期归 cordis 上下文，与本回调的成对座位不同源。
          disposeWikiMain();
          disposeKbGlyph();
          disposeKbMain();
          // 座位被撤（宿主折叠该槽 / 换宿主形态）时把回落装回去：两条路径都
          // 只靠各自的 inject 触发，谁不动谁就永远停在「没有入口」的状态。
          mountFooterSeat();
        };
      });

      // 老宿主回落：footer.action 这一格既能当锚点（SidebarTopEntry 靠它挂
      // portal）也能当兜底按钮，新宿主上则整格不注册——否则侧栏两颗记忆入口。
      ctx.slots.inject("sidebar.footer.action", () => {
        mountFooterSeat();
        return () => {
          dropFooterSeat();
        };
      });

      // --- better-sidebar 生态 tab（可选软依赖）---
      // ⚠️ 平台事实（issue #88 实测 + dsh-server-deck 同款方案）：模块级
      // inject 声明 betterSidebar 是硬等待——未安装 bs 的环境整个 entry
      // pending（"1 entry did not activate" → Failed to load plugins），
      // v0.7.18 即因此对无 bs 用户启动失败。正确双模式（server-deck 验证
      // 过）：外层入口零 inject 立即激活（独立模式保底）；tab 注册挂在内层
      // 动态子插件 `ctx.plugin({ inject: ['betterSidebar'] })`，由 cordis
      // 原生等待服务——bs 未装时该内层 fiber 永远 INACTIVE，静默无害。
      // 兄弟上下文取未声明属性会直接抛错（"cannot get property without
      // inject"），轮询探测方案不可用。
      ctx.effect(() => {
        let dead = false;
        try {
          ctx.plugin?.({
            name: "dsh-mneme:bs-tab",
            inject: ["betterSidebar"],
            apply: (bsCtx) => {
              bsCtx.effect(() => {
                if (dead) return;
                const reg = bsCtx.betterSidebar;
                if (!reg || typeof reg.registerTab !== "function") return;
                  const TAB_ID = "dsh-mneme:memory";
                  if (typeof reg.getTab === "function" && reg.getTab(TAB_ID)) {
                    console.warn(`[dsh-mneme] better-sidebar tab "${TAB_ID}" already registered, skipping duplicate`);
                    return;
                  }
                try {
                  reg.registerTab({
                    id: TAB_ID,
                    title: () => t("memory.view.label"),
                    icon: (size) => renderMnemeMark({ size }),
                    order: 60,
                    component: () => h(MemoryExplorer, { t })
                  });
                } catch (err) {
                  // id 重复等注册失败不应拖垮其余功能，留一条线索即可
                  console.warn("[dsh-mneme] better-sidebar registerTab failed, falling back to native sidebar entry:", err);
                }
              }, "dsh-mneme: better-sidebar tab");
            }
          });
        } catch (err) {
          console.error("[dsh-mneme] better-sidebar mount failed:", err);
        }
        return () => { dead = true; };
      }, "dsh-mneme: better-sidebar mount");

      // --- v0.9.0 M.O.（beta）：旗标门控 ---
      // actionPipelineEnabled 关闭（默认）时一个座位都不注册——座位闸门
      // 在注册层而不是样式层（不是 display:none）。features 拉取失败时
      // 保持关闭（fail-closed），不猜。
      ctx.effect(() => {
        let dead = false;
        apiFetch("/api/dsh-mneme/features")
          .then((res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
          .then((j) => {
            if (dead) return;
            const eff = (j && j.effective) || {};
            if (!eff.actionPipelineEnabled) return;
            registerPipelineSeats(ctx, t);
          })
          .catch((err) => {
            console.warn("[dsh-mneme] features fetch failed, action pipeline stays off:", err);
          });
        return () => { dead = true; };
      }, "dsh-mneme: action-pipeline gate");

      // --- v0.13 日记本（beta）：独立旗标门控 ---
      // 为什么不复用上面那条：它读的是 actionPipelineEnabled——一个只为 M.O. 存在的
      // 闸门。把日记挂进同一个 then 里，等于「关掉 M.O. 顺带关掉日记」，而这两个
      // 功能没有任何关系。所以另起一条 effect、读自己的键、失败同样 fail-closed。
      ctx.effect(() => {
        let dead = false;
        apiFetch("/api/dsh-mneme/features")
          .then((res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
          .then((j) => {
            if (dead) return;
            const eff = (j && j.effective) || {};
            if (!eff.diaryEnabled) return;
            registerDiarySeats(ctx, t);
          })
          .catch((err) => {
            console.warn("[dsh-mneme] features fetch failed, diary stays off:", err);
          });
        return () => { dead = true; };
      }, "dsh-mneme: diary gate");

      // --- chorography 侧栏座位闸（#598）：与 M.O.（v0.9.0）/日记（v0.13）
      // 同一形态——features 拉一次、fail-closed（读不到就不注册，不猜）、开关
      // 改动重启生效。glyph 延迟注册走 diary 右栏页签同一条 inject→register
      // 路径：宿主每次渲染枚举 entriesOfSlot，晚到的登记下一帧出现。
      // main 不在这里——它无条件（#562）；kb 座位也不在这里——契约 §3.6
      // 刻意选了「入口常驻 + 空态自解释」的另一半（见上面 panellist 块注释）。
      ctx.effect(() => {
        let dead = false;
        apiFetch("/api/dsh-mneme/features")
          .then((res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
          .then((j) => {
            if (dead) return;
            if (!((j && j.effective) || {}).chorographyEnabled) return;
            ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
              name: "sidebar.panellist",
              id: "dsh-mneme-wiki",
              order: 61,
              label: () => t("wiki.panel.open")
            }, (props) => h(WikiGlyph, { size: props && props.size })));
          })
          .catch((err) => {
            console.warn("[dsh-mneme] features fetch failed, chorography seat stays off:", err);
          });
        return () => { dead = true; };
      }, "dsh-mneme: chorography seat gate");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});




