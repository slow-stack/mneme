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
      star: [["polygon", { points: "12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" }]]
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
        "memory.settings.profile": "用户画像",
        "memory.settings.profileHint": "写一段自我介绍（角色、背景、偏好），Agent 每轮对话都会自动带上。",
        "memory.settings.profileSave": "保存画像",
        "memory.settings.profileSaved": "画像已保存",
        "memory.settings.profileExtract": "从记忆提取草稿",
        "memory.settings.profileExtracting": "正在提取…",
        "memory.settings.profileExtractHint": "会花一次模型调用，只在你点这个按钮时发生；提取出来的是草稿，不采用就不进库，你手写的画像也不会被覆盖。",
        "memory.settings.profileExtractDisabled": "没有提取：功能开关里的「画像提取草稿」还没打开。",
        "memory.settings.profileExtractEmpty": "库里没有可用的记忆条目，这次没有能提炼的内容（空输入下硬写一段画像只会是编的）。",
        "memory.settings.profileExtractNoRoute": "没有可用的模型：先在宿主里选一个默认模型（或在配置里填 dreamProvider / dreamModel），再点一次。",
        "memory.settings.profileSaveFailed": "画像没存进去",
        "memory.settings.profileExtractFailed": "提取没成：模型没按格式返回，或这次调用失败了。你现有的画像一个字都没被改动。",
        "memory.settings.profileDraftTitle": "草稿（还没保存）",
        "memory.settings.profileDraftRows": "依据记忆条数",
        "memory.settings.profileDraftTruncated": "条目较多，这次只读了前面一部分",
        "memory.settings.profileDraftApply": "采用为画像",
        "memory.settings.profileDraftDiscard": "丢弃草稿",
        "memory.settings.persona": "人格定义（beta）",
        "memory.settings.personaHint": "给这位 Agent 一张角色卡：名字、性格、回复要求。开关打开且下方「人格定义」总闸开启时，每轮对话都会注入。",
        "memory.settings.personaName": "名字",
        "memory.settings.personaNamePlaceholder": "例如：Nyx",
        "memory.settings.personaPersonality": "性格设定",
        "memory.settings.personaPersonalityPlaceholder": "例如：轻松幽默，讲难题时用类比帮用户快速理解",
        "memory.settings.personaReplyStyle": "回复要求",
        "memory.settings.personaReplyStylePlaceholder": "例如：先给结论再解释；用人在用的词，不用机制名",
        "memory.settings.personaSave": "保存人格",
        "memory.settings.personaSaved": "人格已保存",
        "memory.settings.personaSaveFailed": "保存失败",
        "memory.settings.personaEnabledToggle": "启用这张卡",
        "memory.settings.personaEnabledOn": "已启用——身份命中的会话会注入这张卡",
        "memory.settings.personaEnabledOff": "未启用——默认口径下这个身份的会话会改用默认卡；开着「严格人格寻址」时则完全不注入人格",
        "memory.settings.personaDefaultCard": "默认卡（兜底）",
        "memory.settings.personaAdd": "添加卡",
        "memory.settings.personaAddPlaceholder": "输入 agent 身份名（如 nyx），按它寻址注入",
        "memory.settings.personaEditingDefault": "正在编辑：默认卡——解析不到身份的会话一定用它；身份解析到了却没建卡（或卡被关掉）的会话，在默认口径下也落到这里，开着「严格人格寻址」则不注入人格",
        "memory.settings.personaEditingFor": "正在编辑身份卡：",
        "memory.settings.personaDeleteCard": "删除这张卡",
        "memory.settings.personaView": "Agent 眼中的你（注入生效文本）",
        "memory.settings.personaViewHint": "下面是这一轮真正会送进模型的整段文本：人格 → 画像 → 规则（后写的覆盖前写的，规则最硬）。文本由插件渲染，前端只显示。",
        "memory.settings.personaViewEmpty": "三项都是空的——Agent 每轮只会看到记忆库。",
        "memory.settings.personaViewUnknown": "读不到注入文本（预览请求失败或后端版本过旧）。这里不显示猜测的内容。",
        "memory.settings.personaViewSourceDefault": "当前按「解析不到会话身份」的会话预览，取默认卡。",
        "memory.settings.personaViewSourceFallback": "这个身份解析到了，但它没有可用的卡（没建或已关掉），所以落回默认卡——默认口径下这正是「关掉这张卡」不生效的原因；打开「严格人格寻址」后这种情况改为不注入人格。",
        "memory.settings.personaViewSourceCard": "当前按你正在编辑的这张身份卡预览。",
        "memory.settings.personaViewSourceNone": "按当前寻址口径，这个身份不会注入任何人格——默认卡只兜「解析不到会话身份」的会话。",
        "memory.settings.personaViewGateOff": "总闸「人格定义（beta）」现在是关的：下面这段里不会出现人格，只有画像与规则。",
        "memory.settings.personaViewRefresh": "刷新预览",
        "memory.features.personaEnabled": "人格定义（beta）",
        "memory.features.personaEnabled.hint": "把「设置 → 个性化」里的人格卡注入到每轮对话。默认关（beta）；总闸与人格卡内的开关同时打开才生效。",
        "memory.features.personaStrictAddressing": "严格人格寻址",
        "memory.features.personaStrictAddressing.hint": "开：会话身份没有对应人格卡、或那张卡被关掉时，就不注入人格——默认卡只兜「解析不到会话身份」的会话。宿主里跑着自带身份的 bot（DS Bot 那类）时关掉这种兜底，免得两句「你是谁」撞在同一轮。默认关 = 未命中就落默认卡（历史行为）。",
        "memory.features.profileExtractEnabled": "画像提取草稿",
        "memory.features.profileExtractEnabled.hint": "打开「设置 → 个性化 → 用户画像」里的「从记忆提取草稿」按钮：读一批活跃记忆、花一次模型调用，产一段「助手眼中的用户」草稿。草稿要你点「采用」才会写进画像，绝不自动覆盖你手写的原文。轻量档预设关（用户显式勾选仍然赢）。",
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
        "memory.entities.count": "{n} 个实体",
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
        // group.mo 是 v0.9.0 新增的独立分组（座位闸门，不是行为开关）；渲染
        // 走 t(`memory.features.${g.key}`)，缺这行会把键名直接写上屏。
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
        "memory.features.resilientModelDownload": "模型下载断了能续上",
        "memory.features.resilientModelDownload.hint": "开：下载中断后从断点续传并自动重试；关：中断就整份重来（断点续传，默认开）",
        "memory.features.searchSemanticDedup": "搜到意思相同的只留一条",
        "memory.features.searchSemanticDedup.hint": "开：检索结果里意思相近的条目合并成一条，少占名额；关：同义条目一起出现（语义去重，默认关）",
        "memory.features.autoDream": "后台自动整理记忆（合并 · 去重）",
        "memory.features.autoDream.hint": "开：后台自动合并、沉淀碎片记忆（autoDream）；关：记忆只增不减，越用越散",
        "memory.features.sleepModeEnabled": "你不在的时候它整理记忆",
        "memory.features.sleepModeEnabled.hint": "开：空闲时段做分层压缩与整理，白天少打扰；关：只有你手动触发的整理（睡眠模式，默认关）",
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
        "memory.features.summarizePeakHours": "高峰时段（不蒸馏）",
        "memory.features.summarizePeakHours.hint": "与巩固侧同一份写法；蒸馏会避开这些时段，窗口先攒着、非高峰一次蒸完",
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
        "memory.explorer.detail.closeAria": "关闭详情",
        "memory.explorer.detail.editTitle": "标题",
        "memory.explorer.detail.editContent": "内容",
        "memory.explorer.detail.editImportance": "重要性",
        "memory.explorer.detail.starLabel": "设为 {n} 星",
        "memory.status.dream": "最近巩固",
        "memory.status.dreamNever": "尚未运行",
        "memory.status.conflicts": "待确认冲突",
        "memory.status.conflictsHint": "冻结的矛盾记忆，等待人工确认",
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
        "memory.status.token.last7": "近 7 天",
        "memory.status.token.meterOnly": "（只计量）",
        "memory.status.token.detail": "详细状态卡（原「库内一览 / 后台运转」9 张，点击展开）",
        "memory.status.token.op.dream_consolidate": "记忆巩固",
        "memory.status.token.op.summarize_compress": "会话蒸馏",
        "memory.status.token.op.entity_extract": "实体抽取",
        "memory.status.token.op.dream_summarize": "总览摘要",
        "memory.status.token.op.sleep_pattern": "睡眠模式",
        "memory.status.token.op.write_admission": "写入准入",
        "memory.status.error": "加载失败"
      },
      en: {
        "memory.panel.empty": "No memories yet",
        "memory.panel.open": "Memory",
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
        "memory.settings.profile": "User Profile",
        "memory.settings.profileHint": "Describe yourself once — the agent reads it every turn.",
        "memory.settings.profileSave": "Save Profile",
        "memory.settings.profileSaved": "Profile saved",
        "memory.settings.profileExtract": "Draft from memory",
        "memory.settings.profileExtracting": "Extracting…",
        "memory.settings.profileExtractHint": "Costs one model call, and only when you press this button. The result is a draft: nothing is stored until you apply it, and your hand-written profile is never overwritten.",
        "memory.settings.profileExtractDisabled": "Nothing extracted: the “Profile draft from memory” feature switch is still off.",
        "memory.settings.profileExtractEmpty": "No usable memory entries in the store, so there was nothing to draft from (writing a profile out of an empty input would only be invention).",
        "memory.settings.profileExtractNoRoute": "No model available: pick a default model in the host (or set dreamProvider / dreamModel), then try again.",
        "memory.settings.profileSaveFailed": "Profile was not saved",
        "memory.settings.profileExtractFailed": "Extraction failed: the model did not return the required shape, or the call errored. Your existing profile is untouched.",
        "memory.settings.profileDraftTitle": "Draft (not saved)",
        "memory.settings.profileDraftRows": "Based on entries",
        "memory.settings.profileDraftTruncated": "many entries — only the first batch was read",
        "memory.settings.profileDraftApply": "Apply as profile",
        "memory.settings.profileDraftDiscard": "Discard draft",
        "memory.settings.persona": "Persona (beta)",
        "memory.settings.personaHint": "Give this agent a character card: name, personality, reply style. Injected every turn when the toggle below and the \"Persona\" master switch are both on.",
        "memory.settings.personaName": "Name",
        "memory.settings.personaNamePlaceholder": "e.g. Nyx",
        "memory.settings.personaPersonality": "Personality",
        "memory.settings.personaPersonalityPlaceholder": "e.g. relaxed and humorous; use analogies for hard topics",
        "memory.settings.personaReplyStyle": "Reply style",
        "memory.settings.personaReplyStylePlaceholder": "e.g. conclusion first; plain words over jargon",
        "memory.settings.personaSave": "Save Persona",
        "memory.settings.personaSaved": "Persona saved",
        "memory.settings.personaSaveFailed": "Save failed",
        "memory.settings.personaEnabledToggle": "Enable this card",
        "memory.settings.personaEnabledOn": "On — sessions matching this identity get this card",
        "memory.settings.personaEnabledOff": "Off — by default such sessions fall back to the default card; with strict persona addressing they get no persona at all",
        "memory.settings.personaDefaultCard": "Default (fallback)",
        "memory.settings.personaAdd": "Add card",
        "memory.settings.personaAddPlaceholder": "Agent identity (e.g. nyx) used to address injection",
        "memory.settings.personaEditingDefault": "Editing: default card — always used by sessions with no resolvable identity; a session whose identity has no card (or whose card is off) also lands here under the default mode, while strict persona addressing injects nothing instead",
        "memory.settings.personaEditingFor": "Editing identity card:",
        "memory.settings.personaDeleteCard": "Delete this card",
        "memory.settings.personaView": "You, as the agent sees you (injected text)",
        "memory.settings.personaViewHint": "This is the exact block handed to the model this turn: persona → profile → rules (later lines override earlier ones; rules are hardest). The plugin renders it; the panel only displays it.",
        "memory.settings.personaViewEmpty": "All three are empty — the agent only sees the memory store.",
        "memory.settings.personaViewUnknown": "Could not read the injected text (preview request failed or backend too old). Nothing is guessed here.",
        "memory.settings.personaViewSourceDefault": "Preview for sessions whose identity cannot be resolved — the default card applies.",
        "memory.settings.personaViewSourceFallback": "This identity resolved, but it has no usable card (never created, or switched off), so the default card applies — which is exactly why turning this card off changes nothing under the default mode. With strict persona addressing on, such a session gets no persona at all.",
        "memory.settings.personaViewSourceCard": "Preview for the identity card you are editing.",
        "memory.settings.personaViewSourceNone": "Under the current addressing mode this identity injects no persona at all — the default card only covers sessions with no resolvable identity.",
        "memory.settings.personaViewGateOff": "The master switch “Persona (beta)” is off: the block below contains profile and rules only.",
        "memory.settings.personaViewRefresh": "Refresh preview",
        "memory.features.personaEnabled": "Persona (beta)",
        "memory.features.personaEnabled.hint": "Inject the persona card (Settings → Personalization) into every turn. Off by default (beta); both this switch and the card's own toggle must be on.",
        "memory.features.personaStrictAddressing": "Strict persona addressing",
        "memory.features.personaStrictAddressing.hint": "On: when a session's identity has no persona card — or that card is switched off — no persona is injected, so the default card only covers sessions with no resolvable identity. Turn this on when the host runs a bot that brings its own identity (DS Bot and friends), otherwise two \"you are ...\" claims land in the same turn. Off (default): unresolved identities fall back to the default card, as before.",
        "memory.features.profileExtractEnabled": "Profile draft from memory",
        "memory.features.profileExtractEnabled.hint": "Adds the \"Draft from memory\" button to Settings → Personalization → profile: reads a batch of active memories, spends one model call, and returns an \"as the assistant sees them\" draft. Nothing is written until you press Apply, so your hand-written profile is never overwritten automatically. Off in the lightweight preset (an explicit choice still wins).",
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
        "memory.entities.count": "{n} entities",
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
        "memory.features.resilientModelDownload": "Model downloads resume after interruption",
        "memory.features.resilientModelDownload.hint": "On: downloads continue from where they stopped and retry automatically. Off: an interrupted download starts over (resumable downloads, on by default)",
        "memory.features.searchSemanticDedup": "Keep one entry when search hits near-duplicates",
        "memory.features.searchSemanticDedup.hint": "On: near-duplicate entries merge into one, saving injection slots. Off: duplicates all show up (semantic dedup, off by default)",
        "memory.features.autoDream": "Tidy memories in the background (merge · dedupe)",
        "memory.features.autoDream.hint": "On: fragmented memories are merged and settled in the background (autoDream). Off: memory only accumulates, so it gets messier the longer you use it",
        "memory.features.sleepModeEnabled": "It tidies memories while you are away",
        "memory.features.sleepModeEnabled.hint": "On: layered compaction and tidying happen during idle periods. Off: only consolidation you trigger manually (sleep mode, off by default)",
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
        "memory.features.summarizePeakHours": "Peak hours (no distillation)",
        "memory.features.summarizePeakHours.hint": "Same syntax as the consolidation side above; distillation avoids these windows and accumulates the material for one run off-peak",
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
        "memory.explorer.detail.closeAria": "Close details",
        "memory.explorer.detail.editTitle": "Title",
        "memory.explorer.detail.editContent": "Content",
        "memory.explorer.detail.editImportance": "Importance",
        "memory.explorer.detail.starLabel": "Set importance to {n} stars",
        "memory.status.dream": "Last consolidation",
        "memory.status.dreamNever": "Not yet run",
        "memory.status.conflicts": "Pending conflicts",
        "memory.status.conflictsHint": "Frozen contradictory memories awaiting confirmation",
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
      // 必须挂四个根——面板不只长在 .mneme-x 下：记忆库 sheet portal 到 body
      // （.mneme-overlay）、侧边栏入口在宿主插槽（.mneme-triggerwrap）、顶部入口
      // portal 到宿主侧边栏（.mneme-topentry）。
      ".mneme-x,.mneme-overlay,.mneme-triggerwrap,.mneme-topentry{" +
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
        "--mneme-heat-4:color-mix(in srgb,var(--dsw-alias-state-business-primary) 40%,var(--dsw-alias-label-primary))" +
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
      ".mneme-attrgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}",
      ".mneme-attrcard{min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 12px}",
      ".mneme-attrkey{font-size:11px;color:var(--mneme-fg-dim);margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".mneme-attrval{font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary);word-break:break-word}",
      ".mneme-relrow{display:flex;align-items:center;gap:10px;width:100%;padding:7px 10px;border:none;border-radius:10px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:13px;line-height:20px;text-align:left}",
      ".mneme-relrow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-reltype{flex:none;font-size:11px;line-height:16px;color:var(--mneme-accent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 35%,transparent);border-radius:6px;padding:0 6px}",
      ".mneme-relname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
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
      // 卡片网格：响应式 auto-fill，卡片悬停轻浮起
      ".mneme-cards{flex:1;min-height:0;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(252px,1fr));gap:14px;padding:20px 24px 32px;align-content:start}",
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
      // 先给「这一段在管什么」，卡片才是具体选项
      ".mneme-set-grouphead{font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--mneme-fg-dim);margin:24px 0 10px}",
      ".mneme-set-grouphead:first-child{margin-top:8px}",
      ".mneme-set-token{font-family:monospace;font-size:12px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);word-break:break-all;user-select:all}",
      ".mneme-set-hint{font-size:12px;color:var(--mneme-fg-dim)}",
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
    ].join("\n");
    if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "@modusensus/dsh-mneme";
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    const h = react.createElement;

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
      const [entities, setEntities] = useState(null); // null = still loading
      const [railQuery, setRailQuery] = useState("");
      const [entityName, setEntityName] = useState(focusEntity || "");
      const [depth, setDepth] = useState(1);
      const [data, setData] = useState(null);
      const [status, setStatus] = useState("idle"); // idle | loading | ready | notfound | error
      const [selected, setSelected] = useState(null); // { kind: "node"|"edge", node?|edge? }
      const [attrs, setAttrs] = useState([]);
      const [related, setRelated] = useState([]);
      const svgRef = useRef(null);
      const posRef = useRef([]); // live simulation positions, not React state
      const dragRef = useRef(null); // { id, moved }
      const viewRef = useRef({ x: 0, y: 0, k: 1 }); // pan/zoom viewport, viewBox units
      const [frame, setFrame] = useState(0); // re-render tick driven by the simulation

      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/entities?limit=500")
          .then((r) => (r.ok ? r.json() : { entities: [] }))
          .then((j) => { if (!cancelled) setEntities(Array.isArray(j.entities) ? j.entities : []); })
          .catch(() => { if (!cancelled) setEntities([]); });
        return () => { cancelled = true; };
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

      useEffect(() => { load(entityName, depth); }, [load, entityName, depth]);

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
      }, [entityName]);

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
          entities !== null && entities.length > 0 && h("div", { className: "mneme-xcount" },
            t("memory.entities.count").replace("{n}", String(entities.length)))
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
                      return h("button", {
                        key: e.id,
                        className: "mneme-relrow",
                        title: e.memory_id ? t("memory.graph.sourceMemory") : undefined,
                        onClick: () => { if (e.memory_id && onJumpMemory) onJumpMemory({ id: e.memory_id }); }
                      },
                        h("span", { className: "mneme-relname", style: { textAlign: "right", flex: 1 } }, entity.name),
                        h("span", { className: "mneme-reltype" }, e.relation_type),
                        h("span", { className: "mneme-relname", style: { flex: 1 } }, otherName)
                      );
                    })
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
    // 首屏可点项 = 3 总开关 + autoInject 的 2 个子开关 + M.O. 1 开关 +
    // scope 2 开关 + 「全部设置」按钮 = 9。复验修订：产品主人点名 M.O.
    // 「别藏在里面」，独立成组但仍折在「全部设置」后等于换个地方藏；
    // ≤8 是本仓库 #427 自设的软预算，owner 点名豁免一项，锁随注释同步改。
    // RuntimeProvisionBlock 配好即消失，常态首屏更少。
    const FEATURE_FIRST_SCREEN = ["group.basic", "group.mo", "group.scope"];
    const FEATURE_GROUPS = [
      { key: "group.basic", items: ["autoInject", "autoSummarize", "autoDream"] },
      { key: "group.core", items: ["hotMemoryEnabled", "injectTimePrefix", "memoryQualityFilter.enabled", "llmAudit.enabled", "writeAdmission.enabled", "writeAdmission.enforce", "preInjectGate.enabled", "preInjectGate.enforce", "sensitiveScanEnabled",
        // #399 的留存总闸（见下方 distillSub：天数行是它的子块）。放在组末，
        // 子块才能紧跟在它后面展开——items.map 之后的子块是按组尾渲染的。
        "distillRecords.enabled"] },
      // v0.9.0 M.O.（beta）复验修订：独立分组行——它不是行为开关而是座位闸门
      // （关=一个座位都不注册，见 apply 内的 M.O. 块）。独立成组只解决「混在
      // enhance 末位」；可见层由 FEATURE_FIRST_SCREEN 决定（见其注释），
      // 本轮已把组名提进首屏——组成员资格不决定可见性。
      // 同一组的三个键是**三件独立能力**，不是一条链的三段：看图（座位闸门）、
      // 自动沉淀（写提议到记忆库）、执行记账（/mo-run 开窗）。各自默认关，
      // 开了任何一个都不会顺带打开另一个——写能力必须由人一项一项点。
      { key: "group.mo", items: ["actionPipelineEnabled", "actionNudgeEnabled"] },
      { key: "group.enhance", items: ["entityExtractionEnabled", "codingRetrospect", "rerankEnabled", "resilientModelDownload", "searchSemanticDedup", "bm25SearchEnabled", "heatEnabled", "documentMemoryEnabled",
        // 人格定义页（beta）：注入总闸。分组随 enhance（行为开关，非座位闸门）；
        // 人格内容在设置页「个性化」区的人格卡。
        // 严格寻址是同一条链上的第二个口径开关（只在总闸打开时起作用）。
        "personaEnabled", "personaStrictAddressing", "profileExtractEnabled"] },
      { key: "group.dream", items: ["sleepModeEnabled"] },
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
    const FEATURE_NUMBERS = ["distillRecords.retentionDays", "dreamMaxTokens", "sleepMaxTokens"];
    const EMBED_PROVIDERS = ["openai", "local", "ollama"];
    // 实体抽取思考强度（issue #109）：与后端 FEATURE_FLAG_ENUMS 枚举对齐。
    const ENTITY_REASONING = ["none", "low", "medium", "high"];
    // 蒸馏思考强度（issue #315）：比 entity 多一个 off（显式关思考，思考型模型
    // 蒸馏防推理烧预算）。后端枚举含 off，面板必须能选到，否则操作者用不上。
    const SUMMARIZE_REASONING = ["off", "none", "low", "medium", "high"];

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
        h("div", { className: "mneme-featsubhint" }, t("memory.features.summarizePeakHours.hint"))
      );

      // #399 的留存开关紧跟在蒸馏总闸下：天数行只在留存开着时展开（关着一行
      // 不写，改天数没有意义）。放在这而不是挂在 flagRow 上，是因为
      // FEATURE_CHILDREN 只认布尔子项，而这里要的是一个整数输入行。
      const distillSub = eff["distillRecords.enabled"] && h("div", { className: "mneme-featsub" },
        numRow("distillRecords.retentionDays"),
        h("div", { className: "mneme-featsubhint" }, t("memory.features.distillRecords.retentionDays.hint"))
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
                g.key === "group.enhance" && h(react.Fragment, null, embedSub, entitySub),
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

    function SettingsContent({ t }) {
      const [profile, setProfile] = react.useState("");
      const [rules, setRules] = react.useState([]);
      const [commands, setCommands] = react.useState([]);
      const [newRule, setNewRule] = react.useState("");
      const [newCmd, setNewCmd] = react.useState({ name: "", description: "", instruction: "" });
      const [saved, setSaved] = react.useState(false);
      // 画像提取草稿（#497）：null = 没有结果；否则带 kind 的一次性结果，四种结局各一句
      // 话——把「没启用」「库里没东西」「模型没配合」压成同一句「没有草稿」，用户就只能瞎猜。
      const [profileDraft, setProfileDraft] = react.useState(null);
      const [profileExtracting, setProfileExtracting] = react.useState(false);
      // 保存失败要可见（persona 那条一直有，画像这条以前是静默 catch）。
      const [profileError, setProfileError] = react.useState("");
      const [cmdError, setCmdError] = react.useState("");
      // 人格卡（beta，v1.2 多卡）：default 卡草稿 + byAgent 卡列表 + 当前编辑位；
      // provenance 是 v1.5 协作式人格的预留位，v1 只透传不编辑。
      const [personaDefault, setPersonaDefault] = react.useState({ name: "", personality: "", replyStyle: "", enabled: false });
      const [personaByAgent, setPersonaByAgent] = react.useState({});
      const [personaEditing, setPersonaEditing] = react.useState("default");
      const [personaNewName, setPersonaNewName] = react.useState("");
      const [personaSaved, setPersonaSaved] = react.useState(false);
      const [personaError, setPersonaError] = react.useState("");
      // 注入预览：文本由后端渲染（GET /persona 的 preview 字段），前端只显示、不自己拼。
      // 原先这里是一段前端手拼的 profile + rules 列表，注释却写着「注入生效文本」——
      // 它既没有表头、没有「- 用户画像：」前缀，也完全没有人格三行，两份渲染代码必然漂。
      // null = 还没读到或读失败（fail-closed：显示「未知」而不是「空」，也不显示旧值）。
      const [injectedPreview, setInjectedPreview] = react.useState(null);
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

      const load = react.useCallback(async () => {
        try {
          const [p, r, c, v, ps] = await Promise.all([
            apiFetch("/api/dsh-mneme/profile").then((res) => res.json()),
            apiFetch("/api/dsh-mneme/rules").then((res) => res.json()),
            apiFetch("/api/dsh-mneme/commands").then((res) => res.json()),
            apiFetch("/api/dsh-mneme/vector-config").then((res) => res.json()),
            apiFetch("/api/dsh-mneme/persona").then((res) => res.json()).catch(() => null)
          ]);
          setProfile(p.profile || "");
          setRules(Array.isArray(r.rules) ? r.rules : []);
          setCommands(Array.isArray(c.commands) ? c.commands : []);
          setVector(v.config || { enabled: false, baseUrl: "", apiKey: "", model: "" });
          // 人格卡：旧后端无 /persona（404）时保持默认空卡，不阻塞其它卡片。
          // v1.2 多卡形 {default, byAgent}；旧单对象形读作 default（后端已兼容，
          // 这里双保险再判一次形状）。
          const pj = ps && ps.persona && typeof ps.persona === "object" ? ps.persona : {};
          const isMulti = "default" in pj || "byAgent" in pj;
          const dRaw = isMulti ? (pj.default ?? {}) : pj;
          const bRaw = isMulti && pj.byAgent && typeof pj.byAgent === "object" ? pj.byAgent : {};
          const norm = (c) => ({
            name: typeof c?.name === "string" ? c.name : "",
            personality: typeof c?.personality === "string" ? c.personality : "",
            replyStyle: typeof c?.replyStyle === "string" ? c.replyStyle : "",
            enabled: c?.enabled === true
          });
          setPersonaDefault(norm(dRaw));
          setPersonaByAgent(Object.fromEntries(Object.entries(bRaw).map(([k, c]) => [k, norm(c)])));
          setPersonaEditing("default");
          // 预览不在这里写：它只有一个所有者（loadPreview）。两处写同一个 state 就会
          // 互相覆盖，而这张卡的标题是「注入生效文本」——显示别张卡的文本比不显示更糟。
        } catch { /* ignore */ }
      }, []);

      react.useEffect(() => { load(); }, [load]);

      // 预览请求：切卡与点「刷新预览」时各一次。刻意不挂在卡的数据上——卡内改动是
      // 逐字自动保存的，那样等于每敲一个字发一次 GET。
      // 序号守卫：先切 A 再切 B 时，A 的 GET 可能后回来；没有这道判断，界面上就是
      // 「编辑位显示 B、预览显示 A」。
      const previewSeq = react.useRef(0);
      const loadPreview = react.useCallback(async (agentId) => {
        const seq = ++previewSeq.current;
        const q = agentId && agentId !== "default" ? `?agent=${encodeURIComponent(agentId)}` : "";
        try {
          const res = await apiFetch(`/api/dsh-mneme/persona${q}`);
          const body = await res.json();
          if (seq !== previewSeq.current) return;
          setInjectedPreview(body && body.preview && typeof body.preview.text === "string" ? body.preview : null);
        } catch {
          if (seq !== previewSeq.current) return;
          setInjectedPreview(null);
        }
      }, []);

      react.useEffect(() => { loadPreview(personaEditing); }, [personaEditing, loadPreview]);

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

      // 采用草稿 = 显式写画像。两件事都要对：把草稿文本直接交给保存（不能 setProfile
      // 之后再调无参保存——那读的是这次渲染里的旧闭包值，会存回旧文本），以及**只有
      // 真的存下了才提交界面状态**（否则一次 403 就留下「框里是草稿、库里是旧文、
      // 草稿已被清掉」的三不像，关掉面板后彻底找不回来）。
      async function applyProfileDraft() {
        if (profileDraft?.kind !== "draft") return;
        const text = profileDraft.text;
        if (await saveProfile(text)) {
          setProfile(text);
          setProfileDraft(null);
        }
      }

      // 人格卡保存（v1.2 多卡）：全量多卡形 PUT（{default, byAgent}，后端全量
      // 替换语义）。保存失败必须冒提示——v1 的静默 catch 曾把 404 吞成「看起来
      // 保存了」（后端未重装配时 PUT 打 404），桉桉实测踩中，此处不再静默。
      async function savePersonaCards(nextDefault, nextByAgent) {
        try {
          const res = await apiFetch("/api/dsh-mneme/persona", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ persona: { default: nextDefault, byAgent: nextByAgent } })
          });
          if (!res.ok) throw new Error("HTTP " + res.status);
          setPersonaSaved(true);
          setPersonaError("");
          announce(t("memory.settings.personaSaved"));
          setTimeout(() => setPersonaSaved(false), 1500);
        } catch (err) {
          setPersonaError((err && err.message) || "failed");
          setTimeout(() => setPersonaError(""), 4000);
        }
      }
      // 当前编辑位的卡：default 或 byAgent[editing]；草稿即编辑位状态本身。
      const personaEditingCard = personaEditing === "default"
        ? personaDefault
        : personaByAgent[personaEditing] || { name: "", personality: "", replyStyle: "", enabled: false };
      const updatePersonaCard = (key, value) => {
        if (personaEditing === "default") setPersonaDefault((c) => ({ ...c, [key]: value }));
        else setPersonaByAgent((c) => ({ ...c, [personaEditing]: { ...(c[personaEditing] || { name: "", personality: "", replyStyle: "", enabled: false }), [key]: value } }));
      };
      const saveEditingPersona = () => savePersonaCards(personaDefault, personaByAgent);
      const toggleEditingPersona = (checked) => {
        if (personaEditing === "default") {
          const next = { ...personaDefault, enabled: checked };
          setPersonaDefault(next);
          savePersonaCards(next, personaByAgent);
        } else {
          const next = { ...(personaByAgent[personaEditing] || { name: "", personality: "", replyStyle: "", enabled: false }), enabled: checked };
          setPersonaByAgent((c) => ({ ...c, [personaEditing]: next }));
          savePersonaCards(personaDefault, { ...personaByAgent, [personaEditing]: next });
        }
      };
      const addPersonaCard = () => {
        const id = personaNewName.trim();
        if (!id || id === "default" || personaByAgent[id]) return;
        const fresh = { name: id, personality: "", replyStyle: "", enabled: false };
        const next = { ...personaByAgent, [id]: fresh };
        setPersonaByAgent(next);
        setPersonaNewName("");
        setPersonaEditing(id);
        savePersonaCards(personaDefault, next);
      };
      const removePersonaCard = (id) => {
        if (id === "default" || !personaByAgent[id]) return;
        const next = { ...personaByAgent };
        delete next[id];
        setPersonaByAgent(next);
        if (personaEditing === id) setPersonaEditing("default");
        savePersonaCards(personaDefault, next);
      };

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
          const n = data.indexed ?? 0;
          setReindexMsg(t("memory.settings.vectorReindexDone").replace("{n}", String(n)));
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

      return h("div", null,
        // —— 个性化：画像 / 人格 / 规则 / 自定义指令（Agent 怎么对你） ——
        h("div", { className: "mneme-set-grouphead" }, t("memory.settings.group.personal")),
        // 用户画像 — who the agent is talking to
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
            profileError ? h("span", { className: "mneme-saved", style: { color: "var(--dsw-danger, #d33)" } },
              t("memory.settings.profileSaveFailed") + " (" + profileError + ")") : null
          ),
          // 从记忆提取草稿（#497）。两种结局都要显眼：草稿（要用户点「采用」才落库）
          // 与失败原因（开关没开 / 没内容可提 / 模型没配合）。手写的原文在这之上一直
          // 可见——采用前它不会被任何东西覆盖。
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 8 } },
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
              h("button", { type: "button", className: "mneme-btn", onClick: applyProfileDraft }, t("memory.settings.profileDraftApply")),
              h("button", { type: "button", className: "mneme-btn", onClick: () => setProfileDraft(null) }, t("memory.settings.profileDraftDiscard"))
            )
          ) : null
        ),
        // 人格卡（beta，v1.2 多卡）— who the agent is：多张角色卡按会话身份注入。
        // 卡内开关只是该卡 enabled 半边；总闸 personaEnabled 在功能开关组，双闸同真。
        h("section", { className: "mneme-set-card" },
          h("div", { className: "mneme-set-title" }, t("memory.settings.persona")),
          h("div", { className: "mneme-set-desc" }, t("memory.settings.personaHint")),
          // 卡列表：default + 各 byAgent 卡，点选切换编辑位；default 标注兜底位
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
            h("button", {
              type: "button",
              className: "mneme-btn" + (personaEditing === "default" ? " mneme-btn--active" : ""),
              onClick: () => setPersonaEditing("default")
            }, t("memory.settings.personaDefaultCard")),
            Object.keys(personaByAgent).map((id) =>
              h("span", { key: id, style: { display: "inline-flex", alignItems: "center", gap: 2 } },
                h("button", {
                  type: "button",
                  className: "mneme-btn" + (personaEditing === id ? " mneme-btn--active" : ""),
                  onClick: () => setPersonaEditing(id)
                }, id),
                // 卡删除 × 常显：用独立类 mneme-persona-del（见上方样式定义处的
                // 注释——为何不复用 mneme-set-del，以及 #457→#459 一修一回滚的教训）。
                h("button", {
                  type: "button",
                  className: "mneme-persona-del",
                  title: t("memory.settings.personaDeleteCard"),
                  "aria-label": t("memory.settings.personaDeleteCard") + " " + id,
                  onClick: () => removePersonaCard(id)
                }, "×")
              ))
          ),
          // 添加卡：输入 agent 身份名（注入时按它寻址）
          h("div", { style: { display: "flex", gap: 8 } },
            h("input", {
              className: "mneme-set-input",
              style: { marginBottom: 0 },
              value: personaNewName,
              placeholder: t("memory.settings.personaAddPlaceholder"),
              onChange: (e) => setPersonaNewName(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") addPersonaCard(); }
            }),
            h("button", { className: "mneme-btn", onClick: addPersonaCard }, t("memory.settings.personaAdd"))
          ),
          // 编辑位标题：default 卡 vs 具体身份卡
          h("div", { className: "mneme-set-desc" },
            personaEditing === "default"
              ? t("memory.settings.personaEditingDefault")
              : t("memory.settings.personaEditingFor") + " " + personaEditing),
          // 可见字段标签（v1.1 反馈：aria-label 看不见，框上要有字）
          h("div", { className: "mneme-featnumlabel" }, t("memory.settings.personaEnabledToggle")),
          h("div", { className: "mneme-set-row" },
            h("input", {
              type: "checkbox",
              checked: personaEditingCard.enabled === true,
              "aria-label": t("memory.settings.personaEnabledToggle"),
              onChange: (e) => toggleEditingPersona(e.target.checked)
            }),
            h("span", { className: "mneme-set-ruletext" },
              personaEditingCard.enabled === true
                ? t("memory.settings.personaEnabledOn")
                : t("memory.settings.personaEnabledOff"))
          ),
          h("div", { className: "mneme-featnumlabel" }, t("memory.settings.personaName")),
          h("input", {
            className: "mneme-set-input",
            value: personaEditingCard.name,
            placeholder: t("memory.settings.personaNamePlaceholder"),
            onChange: (e) => updatePersonaCard("name", e.target.value)
          }),
          h("div", { className: "mneme-featnumlabel" }, t("memory.settings.personaPersonality")),
          h("textarea", {
            className: "mneme-set-input mneme-set-input--area",
            value: personaEditingCard.personality,
            placeholder: t("memory.settings.personaPersonalityPlaceholder"),
            onChange: (e) => updatePersonaCard("personality", e.target.value)
          }),
          h("div", { className: "mneme-featnumlabel" }, t("memory.settings.personaReplyStyle")),
          h("textarea", {
            className: "mneme-set-input mneme-set-input--area",
            value: personaEditingCard.replyStyle,
            placeholder: t("memory.settings.personaReplyStylePlaceholder"),
            onChange: (e) => updatePersonaCard("replyStyle", e.target.value)
          }),
          h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
            h("button", { className: "mneme-btn", onClick: saveEditingPersona }, t("memory.settings.personaSave")),
            personaSaved && h("span", { className: "mneme-saved" }, t("memory.settings.personaSaved")),
            personaError && h("span", { className: "mneme-saved", style: { color: "var(--dsw-danger, #d33)" } },
              t("memory.settings.personaSaveFailed") + " (" + personaError + ")")
          )
        ),
        // Agent 眼中的你（只读）— 注入生效文本由后端渲染（GET /persona 的 preview 字段），
        // 前端只显示。以前这一段是前端自己拼的 profile + rules，注释却写着「注入生效文本」：
        // 没有人格三行、没有表头、没有「- 用户画像：」前缀，两份实现必然漂。
        h("section", { className: "mneme-set-card" },
          h("div", { className: "mneme-set-title" }, t("memory.settings.personaView")),
          h("div", { className: "mneme-set-desc" }, t("memory.settings.personaViewHint")),
          injectedPreview === null
            ? h("div", { className: "mneme-xempty" }, t("memory.settings.personaViewUnknown"))
            : h("div", null,
                h("div", { className: "mneme-set-desc" },
                  injectedPreview.source === "byAgent"
                    ? t("memory.settings.personaViewSourceCard")
                    : injectedPreview.source === "none"
                      ? t("memory.settings.personaViewSourceNone")
                      // source=default 有两种来路，必须分开说：请求带了 ?agent=<身份>
                      // 却仍落默认卡（身份解析到了，只是没建卡或卡被关掉——关卡的人最想
                      // 确认的就是这一格），与真的解析不到会话身份。
                      : injectedPreview.agent
                        ? t("memory.settings.personaViewSourceFallback")
                        : t("memory.settings.personaViewSourceDefault")),
                injectedPreview.configGate === true
                  ? null
                  : h("div", { className: "mneme-set-desc" }, t("memory.settings.personaViewGateOff")),
                injectedPreview.text
                  ? h("pre", { className: "mneme-set-input mneme-set-input--area", style: { whiteSpace: "pre-wrap", minHeight: 0 } }, injectedPreview.text)
                  : h("div", { className: "mneme-xempty" }, t("memory.settings.personaViewEmpty"))
              ),
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 6 } },
            h("button", {
              type: "button",
              className: "mneme-btn",
              onClick: () => loadPreview(personaEditing)
            }, t("memory.settings.personaViewRefresh"))
          )
        ),
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
        h("div", { className: "mneme-set-grouphead" }, t("memory.settings.group.engine")),
        // 运行模式 — light vs standard chip radios; each click PUTs and the
        // change only lands after a DSH restart (green saved hint says so).
        h("section", { className: "mneme-set-card" },
          h("div", { className: "mneme-set-title" }, t("memory.settings.mode.title")),
          h("div", { className: "mneme-set-desc" }, t("memory.settings.mode.desc")),
          modeError && h("div", { style: { fontSize: 12, color: "var(--mneme-danger)", marginBottom: 8 } }, modeError),
          mode === null && !modeError
            ? h("div", { className: "mneme-set-hint" }, "…")
            : h(react.Fragment, null,
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
              )
        ),
        // 功能开关 — 后端能力的细粒度闸门；改动即时保存，重启 DSH 后生效。
        h(FeaturesCard, { t }),
        // —— 搜索：语义召回 ——
        h("div", { className: "mneme-set-grouphead" }, t("memory.settings.group.search")),
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
        h("div", { className: "mneme-set-grouphead" }, t("memory.settings.group.connect")),
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
        // —— 帮助：支持与鼓励（图标行 + 检测更新 + star，兼当「关于」收尾） ——
        h("div", { className: "mneme-set-grouphead" }, t("memory.settings.group.help")),
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
      return [open, setOverlayOpen];
    }

    // 居中 sheet 记忆库：任何状态下（含新会话 hero、无 tab 环）都能从侧边栏
    // 入口直接打开。背板点击 / Esc 关闭。portal 到 <body>，侧边栏的层叠
    // 上下文裁不住它；运行时拒绝 react-dom 时就地渲染（position:fixed 仍然成立）。
    function MemoryOverlay({ t }) {
      const [open, setOpen] = useOverlayOpen();
      // #178：弹层焦点管理——打开时把焦点移入面板（关闭按钮为入口），
      // Tab 循环圈在面板内（Tab 从最后一个元素出去回到关闭按钮），
      // Esc/关闭时把焦点还给触发元素（侧边栏入口）。
      const panelRef = useRef(null);
      const closeBtnRef = useRef(null);
      useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => {
          if (e.key === "Escape") { setOpen(false); return; }
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
          onClick: () => setOpen(false),
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
              "aria-label": t("memory.overlay.close"),
              title: t("memory.overlay.close"),
              onClick: () => setOpen(false)
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
    function StatusCard({ t, title, loading, error, num, cap, rows, foot, className }) {
      return h("div", { className: className ? `mneme-statuscard ${className}` : "mneme-statuscard" },
        h("h3", { className: "mneme-xcolhead" }, title),
        loading
          ? h("div", { className: "mneme-statusnum" }, "…")
          : error
            ? h("div", { className: "mneme-statuscap", style: { color: "var(--mneme-danger)" } }, t("memory.status.error"))
            : h(react.Fragment, null,
                h("div", { className: "mneme-statusnum" }, num),
                rows && rows.length
                  ? h("div", { className: "mneme-statrows" },
                      rows.map((r, i) => h("div", { className: "mneme-statrow", key: r.key ?? i },
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
      const [state, setState] = useState({ loading: true, error: false, total: 0, byType: [] });
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
            setState({ loading: false, error: false, total: list.length, byType });
          })
          .catch(() => { if (!cancelled) setState({ loading: false, error: true, total: 0, byType: [] }); });
        return () => { cancelled = true; };
      }, []);
      const rows = state.byType.map(([ty, n]) => ({ label: entityTypeLabel(t, ty), value: String(n) }));
      return h(StatusCard, {
        t,
        title: t("memory.status.entities"),
        loading: state.loading,
        error: state.error,
        num: state.total.toLocaleString(),
        rows
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
      const [state, setState] = useState({ loading: true, error: false, provider: null, ready: null, configured: null, degraded: false, dimension: 0, embedded: 0, total: 0, localRuntime: null });
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
              localRuntime: j?.localRuntime ?? null
            });
          })
          .catch(() => { if (!cancelled) setState({ loading: false, error: true, provider: null, ready: null, dimension: 0, embedded: 0, localRuntime: null }); });
        return () => { cancelled = true; };
      }, [reload]);
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
      const [statsError, setStatsError] = useState(false);
      const [conf, setConf] = useState({ loading: true, error: false, pending: 0 });
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
        // KPI 第 4 格的待确认冲突与 DreamStatusCards 同源（/dream-status），
        // 同样监听 mneme:conflicts-changed 重取（#295），两处计数永不漂移。
        const loadConflicts = () => {
          apiFetch("/api/dsh-mneme/dream-status")
            .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
            .then((d) => {
              if (cancelled) return;
              setConf({ loading: false, error: false, pending: Number((d && d.pendingConflicts) ?? 0) });
            })
            .catch(() => { if (!cancelled) setConf({ loading: false, error: true, pending: 0 }); });
        };
        loadConflicts();
        window.addEventListener("mneme:conflicts-changed", loadConflicts);
        return () => { cancelled = true; window.removeEventListener("mneme:conflicts-changed", loadConflicts); };
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
        )
      );
    }

    // 巩固状态卡（×2）：最近一次 autoDream 运行 + 待确认冲突计数。数据来自
    // /dream-status，一次取回两张卡共用；失败只影响这两张卡自身。
    // showConflicts=false 用于 2026-10 改造后的降级折叠区：待确认冲突已升入
    // KPI 带，这里不再重复渲染冲突卡，只留最近运行卡。
    function DreamStatusCards({ t, onGotoQueue, showConflicts = true }) {
      const [state, setState] = useState({ loading: true, error: false, lastRun: null, pending: 0 });
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
                pending: Number((d && d.pendingConflicts) ?? 0)
              });
            })
            .catch(() => { if (!cancelled) setState({ loading: false, error: true, lastRun: null, pending: 0 }); });
        };
        loadOnce();
        // #295 评审：裁决完成后队列会广播 mneme:conflicts-changed，这里重取
        // 计数，状态卡的「待确认冲突」不再停留旧值。
        window.addEventListener("mneme:conflicts-changed", loadOnce);
        return () => { cancelled = true; window.removeEventListener("mneme:conflicts-changed", loadOnce); };
      }, []);
      const run = state.lastRun;
      const num = run ? formatRelativeTime(run.created_at, t) : t("memory.status.dreamNever");
      const cap = run
        ? `${run.status || "—"}${run.model ? ` · ${run.model}` : ""}`
        : t("memory.settings.mode.offList");
      // #178：pending>0 时冲突卡可激活（role=button + 可聚焦 + 回车/空格），
      // 激活直达队列——StatusPanel 把 onGotoQueue 传进来（一步 prop，无线程）。
      const pending = state.pending > 0;
      const gotoQueue = () => { if (pending && onGotoQueue) onGotoQueue(); };
      return h(react.Fragment, null,
        h(StatusCard, { t, title: t("memory.status.dream"), loading: state.loading, error: state.error, num, cap }),
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
      const [state, setState] = useState({ loading: true, suppressed: false });
      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/inject-status")
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((j) => { if (!cancelled) setState({ loading: false, suppressed: !!(j && j.suppressed) }); })
          .catch(() => { if (!cancelled) setState({ loading: false, suppressed: false }); });
        return () => { cancelled = true; };
      }, []);
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
        apiFetch("/api/dsh-mneme/conflicts")
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((d) => { setItems(d.items || []); setLoadError(false); if (!silent) announce(t("memory.status.conflictQueue.refreshed")); })
          // #295 评审：加载失败 ≠ 没有冲突——错误态渲染错误卡而不是空态教育卡，
          // 不能让 500 把「暂时看不到」伪装成「没有冲突」。
          .catch(() => { setItems([]); setLoadError(true); });
      };
      useEffect(() => { load(); }, []);
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
      // #177：相似度从 reason 文本中回收（sleep 路径写「相似度 0.87」，dream 路径
      // 是 LLM 自由文本）——回收得到就画进度条，否则不画，绝不显示编造的数字。
      // 防误报：只认「相似度 0.87 / similarity 0.87」这类锚定短语，不在全文里
      // 捞数字（否则 reason 里的年份、条数都会被当成相似度）。
      const similarityOf = (reason) => {
        const m = /(?:相似度|similarity)\s*([01](?:\.\d+)?)/i.exec(String(reason || ""));
        const v = m ? Number(m[1]) : NaN;
        return v >= 0 && v <= 1 ? v : null;
      };
      return h("div", { className: "mneme-conflictq" },
        h("div", { className: "mneme-conflictq-head" },
          h("span", { className: "mneme-xcount" }, t("memory.status.conflicts")),
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
          const sim = similarityOf(it.reason);
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
              h(MirrorHealthCard, { t })
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

    function MemoryExplorer({ t }) {
      const [view, setView] = useState("memory"); // memory | entity | status | settings
      const [items, setItems] = useState([]); // loaded browse pages, chrono desc
      const [total, setTotal] = useState(0); // server count for the current type filter
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
            setExpandedMonths(null); // 新数据回到「仅最新月展开」
            setLoading(false);
          })
          .catch(() => { if (!cancelled) { setItems([]); setTotal(0); setLoading(false); } });
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
      }, [query, semantic, searchTopK]);

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

      const counts = {};
      for (const m of items) counts[m.type] = (counts[m.type] || 0) + 1;
      const knownTypes = EXPLORER_TYPES.filter((k) => counts[k]);
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
      const applyMemoryUpdate = (updated, { archived = false, restored = false } = {}) => {
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

      const openGraphFor = (name) => {
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
        { key: "settings", label: t("memory.explorer.tabSettings") }
      ];

      return h("div", { className: "mneme-x" },
        h("div", { className: "mneme-xbar" },
          h("nav", { className: "mneme-vtabs", "aria-label": t("memory.view.label") },
            subviews.map((s) =>
              h("button", {
                key: s.key,
                type: "button",
                className: view === s.key ? "mneme-vtab mneme-active" : "mneme-vtab",
                "aria-pressed": String(view === s.key),
                onClick: () => setView(s.key)
              },
                h(Icon, { name: s.key === "memory" ? "database" : s.key === "entity" ? "waypoints" : s.key === "status" ? "activity" : "settings", size: 14, className: "mneme-vtabico" }),
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
                onClick: () => { setMenuOpen(!menuOpen); setImportOpen(false); setCreateOpen(false); setShareOpen(false); setReceiveOpen(false); }
              }, "⋯"),
              menuOpen && h("div", { className: "mneme-menu", role: "menu" },
                h("button", { type: "button", role: "menuitem", onClick: () => { setCreateOpen(true); setMenuOpen(false); } },
                  t("memory.explorer.newMemory")),
                h("button", { type: "button", role: "menuitem", onClick: () => { setMenuOpen(false); exportData("json"); } },
                  t("memory.explorer.exportJson")),
                h("button", { type: "button", role: "menuitem", onClick: () => { setMenuOpen(false); exportData("markdown"); } },
                  t("memory.explorer.exportMarkdown")),
                h("button", { type: "button", role: "menuitem", onClick: () => { setImportOpen(true); setMenuOpen(false); } },
                  t("memory.explorer.importMd")),
                h("button", { type: "button", role: "menuitem", onClick: () => { setShareOpen(true); setMenuOpen(false); } },
                  t("memory.explorer.sharePack")),
                h("button", { type: "button", role: "menuitem", onClick: () => { setReceiveOpen(true); setMenuOpen(false); } },
                  t("memory.explorer.receivePack")),
              ),
              importOpen && h(ImportDialog, {
                t,
                onClose: () => setImportOpen(false),
                onImported: () => setReloadKey((k) => k + 1)
              }),
              shareOpen && h(ShareDialog, { t, onClose: () => setShareOpen(false) }),
              receiveOpen && h(ReceiveDialog, {
                t,
                onClose: () => setReceiveOpen(false),
                onImported: () => setReloadKey((k) => k + 1)
              }),
              createOpen && h(CreateDialog, {
                t,
                onClose: () => setCreateOpen(false),
                // 新建后既刷新列表也选中新行：并入既有条目时 action 是 merged，
                // 返回的 id 就是被并入那一行——两种情况都该把它滚进视野。
                onCreated: (d) => { setReloadKey((k) => k + 1); if (d && d.id) setSelectedId(d.id); }
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
              }, h("span", { className: "mneme-xdot mneme-xdot--all", "aria-hidden": "true" }), h("span", null, t("memory.tab.all")), h("span", { className: "mneme-xcount2" }, String(items.length))),
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
              h("span", { className: "mneme-xcount", style: { marginLeft: "auto" } }, t("memory.explorer.count").replace("{n}", String(visible.length))),
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
        toastMsg && h("div", { className: "mneme-toast", role: "status" }, toastMsg)
      );
    }

    // --- Sidebar entry: 侧边栏里的记忆入口 ---
    // 注册仍在 sidebar.footer.action（list 插槽）——它既是 React 树的挂载
    // 锚点，也是 portal 失效时的原位回退；常驻 sheet 也从这个插槽挂载。
    // 入口形状跟着宿主 v0.2 的侧边栏走，分两态：
    //  · 展开态：宿主把「插件 / 自动化任务」这类全局面板渲染成 nav.panelList
    //    里的 panelRow（36px 行高、透明底、图标 + 标题）。我们把按钮 portal 进
    //    同一组并原样套用宿主 panelRow 的实时类名，于是它是该组的第三行——低调，
    //    而不是 v0.8.10 那样长得像第二个高亮「新会话」按钮。
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
        return () => {
          unsubscribe();
          window.removeEventListener("mneme:conflicts-changed", onChanged);
        };
      }, []);
      return pending;
    }
    function ConflictBadge({ pending }) {
      if (!pending || pending <= 0) return null;
      return h("span", { className: "mneme-entrybadge", "aria-hidden": "true" },
        pending > 99 ? "99+" : String(pending));
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

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, dictionaries), "dsh-mneme: dictionaries");

      // 记忆库唯一入口：sidebar.footer.action 注册作为锚点与回退；真实按钮
      // 由 SidebarTopEntry portal 到侧边栏工作区上方。overlay 从这个常驻
      // 插槽挂载（portal 到 body），会话切换不影响它的开关状态。
      // v0.7.15 起不再注册 conversation.view tab——对话内嵌的面板被悬浮
      // 输入框遮挡、挤压会话布局，sheet 页是更舒服的承载方式。
      ctx.slots.inject("sidebar.footer.action", () => {
        return ctx.slots.register({
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
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});




