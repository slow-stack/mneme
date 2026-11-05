# chorography M2 实现计划（分支 feat/chorography-m2，基于 origin/main 952f307——M1 已合并）

spec §10 M2 档：**T1 生成轮 + 成本上限 + 降级路径**。语义段落（架构/约定/技术栈/构建命令）
与溯源 claims 落进骨架页；生成入口本档是 CLI（`--t1`），面板生成按钮与 `/choro` 指令随 M3。

## V1 已验（2026-11-05，本机实测）

桌面版 headless 通道**通**：`dsh --profile headless "<task>"` 10 秒完成一次任务、exit 0。
两个必需配方（都进了 t1.js 的真实 runner）：

1. **绕过 `.cmd` wrapper 直接调 exe**：`ELECTRON_RUN_AS_NODE=1 "…\DeepSeek Harness.exe"
   --expose-internals "…\dsh-desktop-host\lib\cli.js" --profile headless …`——wrapper 在
   Git Bash 下路径引号会碎（实测 `'%D:\Program' 不是内部或外部命令`）。
2. **模型路由用 `--patch` 临时 overlay**（bili-scroll 同款、零配置改动）：headless profile
   默认路由 deepseek-official 要 API key（MISSING_CREDENTIAL），而池插件 dsh-xdpool 已装在
   headless profile 里；overlay 写一条 `agent-default-model → provider: xdpool / model:
   deepseek-v4.1-flash` 即可吃池额度。overlay 是一次性临时文件（只有 provider/model 名，
   无 key——红线 4），跑完即删。

## 已定实现决策（M1 之外的补口）

| # | 决策 | 理由 | 被否备选 |
| --- | --- | --- | --- |
| P14 | session runner 是注入接口：`createT1({ store, runSession })`，真实 runner（spawn headless）与测试 stub 共一套编排 | 单测绝不真开 headless 会话；成本上限与降级逻辑必须能脱离模型验证 | 测试里 mock child_process：脆且绕过编排语义 |
| P15 | 三重上限全在事件流上实现：`--json` NDJSON 边读边计数，工具调用超限 / 输出超限 / 墙钟超时 → kill 子进程、该模块 fail | spec §6 步 11 的三重上限；NDJSON 让三者共用同一条读取循环，不是三个定时器 | 事后解析：超限了钱已经花完 |
| P16 | 输出契约 = 严格 JSON（章程要求只输出一个对象），解析失败 / claims 的 sourcePath 不在模块文件清单里 → 该轮 failed（fail_count++），骨架原样保留 | 溯源锚点可核验是 spec 的根基（红线 5 相邻）；编造的锚点比没有更伤 | 丢坏 claims 保正文：正文与锚点必须同源（claims 是正文的证据层） |
| P17 | 失败计数落 `choro_pages.fail_count`（addColumn 幂等迁移）；连续 2 次失败 → status=failed，T1 跳过 failed 页除非 `--retry` | spec 步 12「失败两次即记 failed」；不加列就得把计数藏进 state.json（页级状态散两处） | 不持久化：重跑永远从 0 数 |
| P18 | headless **起不来**（spawn 失败 / MISSING_CREDENTIAL 等环境级错误）≠ 单模块失败：整档中止、页状态不动、receipt 带 `t1Unavailable` + 原因 | spec 降级表的两条不同行（「根本起不来」整档关 vs「超时/超限」单模块 failed），面板据此显示「当前只有骨架」+ 原因 | 一律标 failed：把环境问题记成页的错，重跑永远 failed |
| P19 | 富化写法：T1 四段插在「生成说明」节**之前**，T0 确定性段落原样保留；CHORO:HUMAN 保留区照旧页尾回填 | T0 段落是可重建的（字节稳定契约只对 skeleton 页），富化后页面归 T1 所有、T0 段落成了上下文——重建整页时富化层丢弃重来（enriched 页不参与 T0 的字节稳定不变量） | T0 段落也重排：富化页与骨架页格式漂移，diff 无法读 |
| P20 | claims 落两处：`choro_claims` 表（删旧插新）+ `evidence/<slug>.json`（spec §4 磁盘契约）；`sourcePath` 必须命中该模块的文件清单 | 磁盘 evidence 是人可查的证据层，表是检索层；两处同源同写 | 只落表：spec §4 的 evidence/ 目录就名存实亡 |
| P21 | 模型路由 = CLI `--model provider/model`，缺省 `xdpool/deepseek-v4.1-flash`（池目录会漂，flag 覆盖）；不进 config schema | T1 只手动触发（CLI 显式 `--t1`），不是常驻行为——AGENTS.md 自查清单第 1 条的开关针对常驻行为 | 进 config schema：又一个键 + 计数锁 + 文档锁，为一个手动 flag 不值 |
| P22 | 章程里「只读、不修改文件」是**软约束**：headless 工具集由宿主管，T1 不做工具白名单（那要 --patch 覆盖宿主工具注册，超出 mneme 的管辖面） | 边界如实写进 README/计划：人发起、产出只写 `.chorography/**`（写路径断言）、越界动作 git diff 可见 | 章程当防线：提示词不是安全边界，假装是才是危险 |
| P23 | 重跑 T0 命中已富化的页时，**先出声再丢**：`collectT1Loss` 数出「页里含 `CHORO:T1` 的页」与「`evidence/*.json` 份数」，进 `warnings` + receipt 的结构化字段 `t1Loss`；清点纯只读，不改字节也不删 evidence | P19 说丢弃富化层是设计意图，但**静默才是 bug**——2026-11-05 在 dsh-baleen 实测：重跑 `--apply` 后 `modules/src-client.md` 的 CHORO:T1 段消失、`choro_claims` 清空，33 条 claims 的 evidence 文件留在磁盘成孤儿，全程零提示，用户看到的是「跑完 T0，语义段落没了」 | apply 时顺手删掉旧 evidence：那是证据层，删了就没法回查；或干脆不提示：静默丢失比多一行提示糟糕得多 |

## 步骤

1. store：`fail_count` 列（addColumn 幂等）+ `saveChoroPageClaims`（删旧插新）。
2. `src/wiki/t1.js`：章程构建、NDJSON 三重上限、JSON 输出校验（schema + claims 锚点对账）、
   页面富化（保留区回填复用 render.js）、claims/evidence 双落、降级表全路径。
3. CLI：`--t1 [--module slug] [--model provider/model] [--timeout 秒] [--retry-failed]`；
   receipt 与 T0 同款人话格式。
4. 测试（stub runner，四层）：编排（选模块/跳过 failed）、三重上限触发、输出契约校验
   （坏 JSON/编造锚点 → failed）、富化与保留区共存、降级分叉（环境级 vs 模块级）。
5. T1 标记从 t1.js 收进 `src/wiki/render.js`（写的人 t1.js、读的人还有 t0.js），T0 加
   `collectT1Loss` 清点 + warning（P23），回归测试落在 `test/wiki-t0.test.js`。

## 落地状态（2026-11-05）

代码全部落盘，闸门实测：`npm test` 2780 tests / **2779 pass / 0 fail / 1 skipped**
（新增 `test/wiki-t1.test.js` 7 例 + `test/wiki-t0.test.js` 2 例：t1Loss 清点、CLI 解析），
`check-sync` 92 文件一致。真实冒烟：dsh-baleen `src-client` 29s 富化、33 条 claims
锚点存活 33/33。**未提交**——等用户点头。

