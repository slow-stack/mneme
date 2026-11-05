# chorography M3 实现计划（分支 feat/chorography-m3，基于 origin/main da23e37——M0/M1/M2 均已合并）

spec §10 第三档：**开局注入 + 过期提示 + `/choro` 指令**（[design](../specs/2026-11-04-chorography-design.md) §7 / §10）。M4（记忆库入口迁移）本档不动。

## V3 已验（2026-11-05，本机）

spec §11 的 V3 问的是「与宿主现有 `systemPrompt` 注入的先后顺序与体积上限」。宿主 `@deepseek-ai/dsh-system-prompt` 的实现已从 `app.asar` 提出读过，三条结论直接决定了本档的设计：

1. **宿主侧完全没有体积上限**。`renderPrompt` 只是 `sections.map(...).join("\n\n")`，`assemble()` 里没有 token/字符预算、没有截断、没有超限报错。→ **上限只能由插件自己兜**，本档在渲染侧设行数与字符双上限。
2. **context 只按 order 排序，同 order 没有 name 兜底**（`sort((a, b) => a.order - b.order)`）。mneme 的 `memory`(90) / `user-settings`(85) 都排在宿主 `WORKING_DIRECTORY`(100) 之前——记忆块出现在「当前工作目录」那句台词之前，这是既有事实，本档不改。
3. **空文本的 context 被过滤、不占位**（`filter(text.length > 0)`）。→ 「本帧不注入就 `return ""`」是宿主契约内的合法关闭方式，不是 hack。
4. 追加一条：`interpolate()` 扫到 `{{…}}` 但变量不合法/未注册会**抛错并崩整轮装配**。从仓库读来的模块标题与路径必须过 `escapePromptVars`（mneme 已有，`src/user-settings.js`）。

## 已定实现决策（P24–P33）

| # | 决策 | 理由 | 被否备选 |
|---|---|---|---|
| P24 | 地志块**折进既有的 `memory` context**，不开第三个 context | `test/inject.test.js` 断言 `contexts.length === 2`；`inject.js:399-402` 的注释已经写明「Folding it here (instead of a separate context) keeps the prompt assembly stable at two blocks」；spec §7 也要求「合并成一次拼装，避免同一份提示里长两块」 | 新开 `{name:"chorography", order:88}`——要改既有断言，且直接违背 spec 原话 |
| P25 | 档位键 `chorographyInject`，枚举 `off`/`light`/`full`，**默认 `light`**，走 `z.union([z.const(...)])`（同 `summarizeDedupeMode`） | spec §7 原话就是三档 + 默认 light | 布尔键——表达不了三档；跟随 `chorographyEnabled` 隐式开——那就没有「关注入但保留工具」的组合 |
| P26 | 轻量档**不用 `LIGHT_MODE_OFF`**，改在消费侧判 `config.lightMode === true` → 视为 `off` | `applyLightModePreset` 对平铺键一律赋 `false`；枚举键进去会得到与 schema 不符的 `false`，而 `false !== "off"` 时注入照样渲染（静默失效，比不关更糟） | 把 `chorographyInject` 塞进 `LIGHT_MODE_OFF`——见左；改成布尔键——同 P25 |
| P27 | 「按 cwd 找仓库」**不新写一份 registry 读取**，直接吃注入器已经解析出来的 `scope.workspace_scope` | 那个值来自 `createScopeResolver`（registry 反查优先、`header.cwd` 兜底、失败落 NULL），是全仓唯一的 cwd 口径；再写一份就是两张皮，且 #487 的 Proxy 陷阱会重犯 | 在注入器里重读 `workspaceRegistry`——重犯 #487 |
| P28 | 仓库匹配走**祖先前缀**，不是精确相等 | 会话 cwd 常常是仓库子目录（`D:/repo/src`）；精确相等会让绝大部分真实会话匹配不到 | 只认精确相等——等于给用户加一条「必须在仓库根开会话」的暗规则 |
| P29 | **热路径不 fork git**。注入块只带「生成时间 + 基线短 sha」，真过期判定（`git rev-parse HEAD` 比对）只在 `/choro` 里做 | 每轮注入跑一次 `execFileSync` 在 Windows 上是几十毫秒起步，且这是给模型看的提示、不是硬判定；`/choro` 是人主动触发，付得起 | 注入时跑 git——热路径不可接受的成本，且失败降级路径又是一处 |
| P30 | 「一句摘要」位**用模块 title + 文件数 + 页状态**，不解析页正文 | spec §7 明确「只注标题级不注正文」，解析正文取摘要恰好违反这一条；`choro_modules` 也没有 summary 列（M0 没建）。页状态（skeleton/enriched/failed）反而是模型最需要的信息——它据此知道这一页有没有语义 | 从 `choro_claims` 取首条架构结论——claims 质量不定且体积不可控，留给后续档；解析 markdown 正文——违 spec |
| P31 | 渲染失败/取不到仓库/取不到 cwd **一律返回空串**，绝不让注入抛错 | `memory` context 已在热路径上；一个附属信息块把整轮 systemPrompt 搞崩是不成比例的失败 | 抛错让宿主记录——一次 DB 异常就整轮没有记忆注入 |
| P32 | 数据访问仍全部走 `queries.js`（新增 `repoByCwd` / `outline` 两函数），`inject.js` 只做渲染 | `queries.js` 的头注释就是「真源纪律：slug 只从 DB 白名单解析，路径拼装零用户输入」；在注入侧另写 SQL 就是第二份白名单 | 注入侧自写 SQL——两张皮 |
| P33 | `/choro` **只读**，不做 rebuild、不写档位 | spec §2 D6「只手动触发」；命令 handler 的返回值只作 UI 回执（`pipeline-command.js` 注释原话），写操作该走面板或 CLI，不该藏在一条斜杠命令里 | `/choro rebuild`——在宿主进程里跑 T0 写盘，越权且失败面大；`/choro light` 切档位——feature flags 改了也要重启 DSH 才生效，回执照样要说「重启」，收益低于代价 |

## 步骤

1. `src/wiki/queries.js` 加 `repoByCwd(cwd)`（realpath 归一 + 祖先前缀匹配）与 `outline(repoId)`（注入所需最小列集）；
2. 新增 `src/wiki/inject.js`：`resolveInjectTier(config)` 纯函数 + `renderChoroBlock(...)` 纯渲染 + `createChoroInject({ choro, config, logger })` → `{ text(cwd), dispose() }`，带渲染缓存；
3. `src/config.js` 加 `chorographyInject` 枚举键，改 `chorographyEnabled` 那段「不进 LIGHT_MODE_OFF」的注释（理由只剩一半）；
4. `src/settings.js` 的 `FEATURE_FLAG_ENUMS` 加 `chorographyInject`；
5. `src/lang.js` 加地志注入块文案与 `/choro` 命令文案（中英双份）；
6. `src/inject.js` 的 `memory` context 里按「时间 → 地志 → 热上下文 → 长期记忆」拼接，快照加 `choroChars`；
7. 新增 `src/choro-command.js`（照 `pipeline-command.js` 的形状），`src/index.js` 在 `disposers` 声明之后注册（TDZ 纪律）；
8. `lib/client.js`：`FEATURE_GROUPS` 的 `group.enhance` **末尾**加 `chorographyEnabled`（放末尾是为了不推远 `test/client.test.js:2468` 那个 700 字符窗口），组尾加 `choroSub` 档位下拉；
9. `docs/CONFIGURATION.md` 加键行、改 `chorographyEnabled` 措辞；`CHANGELOG.md`；`AGENTS.md` 模块地图；
10. 测试：新增 `test/wiki-inject.test.js` 与 `test/choro-command.test.js`，补 `test/inject.test.js`，`test/api.test.js` 计数 112→113；
11. `npm run sync` + `node scripts/check-sync.js` + `npm test`。

## 落地状态（2026-11-05）

全部 11 步已落地，闸门实测：

- `node scripts/check-sync.js` → ✓ src/ 与 lib/ 一致（94 个文件）
- `cd dsh-mneme && npm test` → **tests 2805 / pass 2804 / fail 0 / cancelled 0 / skipped 1**，71s
- 新增/扩充测试：`test/wiki-inject.test.js`（新建 9 例）、`test/choro-command.test.js`（新建 11 例）、`test/wiki-queries.test.js` 6 例（+2）、`test/inject.test.js` 31 例（+3）、`test/api.test.js` 旗标计数 112 → 113
- 端到端冒烟（临时脚本，未提交）：临时 git 夹具跑真实 T0 → light/full 各出 3 行提纲；`{chorographyEnabled:true, lightMode:true}` → tier=off / chars=0；`/choro` 回执带批次标题、全表、基线一致与正文读法提示

### 实现中改掉的三处口径（都由冒烟暴露）

1. **档位不是命令闸**：`resolveInjectTier` 在 `lightMode: true` 下也返回 `off`，若用它当 `/choro` 的开关，轻量档用户会被告知「没开，去设置里打开」而设置里明明开着。命令只认 `chorographyEnabled`。
2. **两档排序统一**：`light` 原按文件数降序、`full` 按 slug 字母序，同一份地志在两档下次序不同。改为先排序再分档。
3. **截断语改差额**：`/choro` 的「另有 N 个模块」原来传模块总数，会让人以为大部分没看到；改为总表行数减实际列出的行数。另修注入行把页路径粘在右括号后（缺分隔空格）。
