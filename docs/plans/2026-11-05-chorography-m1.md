# chorography M1 实现计划（分支 feat/chorography-m1，叠在 feat/chorography-m0 上）

spec §10 M1 档：**面板浏览 + 三个只读工具 + 关键词检索**。生成 UI 不在本档（M2/M3）。

| # | 决策 | 理由 | 被否备选 |
| --- | --- | --- | --- |
| P8 | 新增 `choro_edges` 表（repo_id, from_slug, to_slug, weight） | spec §7 的 `choro_module_map` 要依赖边，M0 schema 漏了这张；replaceChoroGraph 顺手多删多插一段，幂等语义不变 | 从页面正文反向解析边：脆弱且要二次约定格式 |
| P9 | `chorographyEnabled` 配置键（opt-in 默认关），管**工具暴露**；lightMode 不强制关 | 工具描述常驻模型上下文 = 新增成本，按仓库纪律必须 opt-in + settings 白名单 + 旗标计数锁；choro 无每轮注入物、无热路径挂载，故不进 LIGHT_MODE_OFF（注释写明） | 无开关直接注册：违背自查清单第 1 条 |
| P10 | 检索 = 关键词子串（大小写不敏感，按 `## ` 分节返回命中与行号） | spec §7 的 choro_search 本来就定义成「关键词 + 模块过滤」；向量留给 embedder 接入（V4）后再加 | M1 就上向量：embedder 模型版本绑定问题（V4）未解 |
| P11 | 面板座位**无条件注册**（挂在 #562 的 panellist inject 块内，id/key `dsh-mneme-wiki`），内容层按 features 空态 | inject 同名二次注册的 cordis 语义未知，不赌；开关生效走既有「重启生效」纪律；座位常挂的收敛形态就是 D2 拆双 Cordis 条目 | 独立二次 inject 同名槽：语义没验证过 |
| P12 | 页面正文真源读盘（root_path + rel_path），slug 只从 DB 白名单解析 | 磁盘是唯一真源（spec §4）；路径拼装零用户输入 = 零穿越面 | 把正文塞 DB：违反所有权模型 |
| P13 | MD 渲染用 ~80 行手写只读渲染器（先转义再格式化，无原始 HTML 通道） | 面板 bundle 零依赖；知识库阅读体验需要标题/列表/代码块 | 引 marked：破零依赖；裸 `<pre>`：没法读 |

路由四条全 `policy: "open"`（宿主围栏统一鉴权，读操作；SECURITY.md 表同步）：GET `/choro/repos`、`/choro/modules?repoId`、`/choro/page?repoId&slug`、`/choro/search?repoId&q&module&limit`。开关关时一律 409 disabled（#497 先例：路由挂着、逻辑层挡）。

工具三个走 tools.js 的 hiddenTools 闸（`chorographyEnabled !== true` → 不注册，同 organizeEnabled 反向语义）：`choro_search` / `choro_read_page` / `choro_module_map`，**零写工具**（红线 3）。

面板：左侧模块树（父链缩进）+ 右侧正文 + 顶部搜索框（结果列表 → 点开即页）；样式全部复用 `.mneme-panel` 渲染根与 `--mneme-*` 语义色层，不新增渲染根（contrast 五根锁不动）。

待实测回填：V3（宿主 systemPrompt 注入先后与体积）是 M3 的事；本档跑完顺手对三个真实仓库各 `--apply` 一轮给 V2 人判。
