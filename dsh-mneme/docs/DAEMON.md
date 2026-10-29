# dsh-mneme 独立服务(daemon)

`dsh-mneme-serve`:在 DSH 宿主之外把 mneme 跑成一个常驻数据面。#363(Mneme Bridge)确立的方向——第三方集成需要长期挂载,而 DSH 不必一直开着;这是官方推荐姿势,lib 直挂的 embedded 模式降级为无网兜底。

## 1. 职责边界

daemon 是**数据面**,不是第二个宿主:

- **有**:存储(SQLite)、检索(关键词 + BM25 + 向量,`/search` 统一召回,与宿主共用 `src/semantic.js` 同一套装配)、注入候选(`/context`,issue #370,与宿主注入管线同一份 `injectCandidates`)、镜像同步与人改合并、`/maintenance/reclaim`、`/share`(记忆分享包,纯读,见 [SHARE.md](SHARE.md))、`/receive` 与 `/receive/undo`(吃包入库与整包退出,车道 C;写的是**本机自己的库**,与 `/share` 同一条 4 MiB 入站上限)、`/bootstrap`、recall_runs 检索/注入回执。
- **没有(第一期,无 LLM)**:巩固(autoDream)、蒸馏(autoSummarize)、实体抽取、sleep、注入/工具/面板路由。前两者是**结构性缺失**而非开关——daemon 装配里没有 LLM 句柄,巩固只属于 DSH 宿主进程。这就是 daemon 与宿主「单写者」的机械保证(AGENTS.md externalApi/autoDream 单侧纪律的 daemon 版),不依赖用户自觉。
- **收包在 daemon 上付的是什么**:一个事务里逐条先查 `share_external_id` 再 `store.save`,嵌入随最外层 COMMIT 排空(`--embed local` 时真打向量,`off` 时只落结构),镜像重渲染照 daemon 自己那条回灌路走。**实体一个都不建**——不是 daemon 缺 LLM 才不建,车道 C 对外来行本来就不做抽取(有向量、无实体,实体与图检索看不见它们),宿主侧同样如此。成本的量级读数见 [SHARE.md](SHARE.md)「收侧」那一节实测。

与宿主装配(`src/index.js` apply)的关系:`src/serve.js` 只搬数据面那一半,每步注释锚定 index.js 来源行号;刻意不抽公共装配函数(apply 其余环节与宿主 ctx 纠缠,防御段纪律「最后动或不动」)。装配漂移风险由 `test/serve-bin.test.js` 的多进程共存用例兜底(两进程真开同一个库互写互读)。

## 2. 对外接口

路由面 = `src/api-standalone.js` 全表(health/status/profile/rules/memories 读写/search/context/share/receive(含 `/receive/undo`)/maintenance/bootstrap),鉴权同源(Bearer + timingSafeEqual,`GET /health` 免鉴权)。daemon 自身零新路由;#370 的 `/context` 落在 api-standalone 工厂里,宿主外部访问与 daemon 自动同享(参数、scope 语义与 recall_runs 注入分账见包 README 路由表)。daemon 侧唯一自有选项是 `strictPort`(见 §4)。

`/context` 的档位信号(#383):响应多一个 `tier`(`full` 语义档 / `degraded` 规则档 / `unknown` 语义路未启用或判不出来,fail-closed),**具体降级原因只在 stderr**——`dsh-mneme: /context degraded to the rule tier (<reason>)`,不进响应体。原因是给运维的读数,六值互不吞并(成例「修法不同就分开」):`embed-unavailable` 无可用接口(embedder 对象在、缺 `embedSingle`/`embed`,修适配器)/ `embed-empty` 空向量 / `embed-timeout` 挂起 / `embed-error` 抛错 / `embed-dimension` 维度不符(有向量但没有一条与查询同维,修法是重建索引)/ `no-embedder` 压根没装配 embedder(`--embed off` / lightMode / 宿主未装配,**预期态不是故障**,修法是把嵌装扮上或开起来)。`tier` 是给调用方的读数,两套消费者分开;六值的唯一真源是 `src/api-standalone.js` 的 `CONTEXT_DEGRADE_REASONS`,契约测试从它派生。`unknown` 之下(维度探针没跑成 / 有行却一条向量都读不出来)另有一行 `dsh-mneme: /context tier left unknown: <what>`,**不是**那六值的一员(`tier` 不是 degraded,没有降级原因可记),运维程序不要按原因枚举解析它——没有它,调用方对 unknown 的策略是「不告警」时,一次真实的判档故障会整个消失。`no-embedder` 不并进 `embed-unavailable` 是故意的:那两者共用「语义路没通」的结果,但一个是适配器坏了(异常)、一个是语义路没开(设计内常态),并成一个值会让按 `embed-unavailable` 告警的面板对每个轻量模式安装报警;用词则与宿主面 `/api/dsh-mneme/semantic` 的 `reason` 对齐(那边是另一套枚举、另一个消费者,别顺手统一)。这里最值得盯的是 `embed-dimension`:嵌入接口一切正常,但库里是旧维度向量,`searchVector` 直接跳过、不抛错,召回静默退回关键词档——修法是重建索引,不是查端点。判档有成本:`q` 非空且装了 embedder 时一次 `/context` 会真起一次查询嵌入(一次往返 + `embedTimeoutMs` 窗口),维度探针本身是**按匹配短路的存在性判据**(有没有一条活跃向量与查询同维,不是 `LIMIT 1` 读一行——混合维度库里那会抽错维误报 degraded、首条损坏又会漏报 full):一次无 `LIMIT` 的全 id 扫描 + 短路解析,同维度健康库只解析 1 个向量,只有要报 degraded 时才走完全表;不复用 `/health`(它只回 `{ok:true}`)也不做全表扫。

CLI:

```bash
dsh-mneme-serve [--memory-dir <dir>] [--port <n>] [--host <addr>] [--embed <provider>]
```

- `memoryDir`:CLI > env `DSH_MNEME_MEMORY_DIR` > `~/.dsh/memory`(与宿主 config.js 同默认,支持前导 `~`)。
- `--embed`:语义检索提供方。`local`(默认:自管 runtime 与嵌入模型缺失时**自动取件**,download 档,约 200MB;失败降级关键词并打可操作日志)| `ollama` | `openai`(读宿主面板存的 vector-config)| `off`(纯关键词 + BM25)。取件来源可用 env 换道:`DSH_MNEME_RUNTIME_DIR`(自管 runtime 目录)、`DSH_MNEME_RUNTIME_TARBALL_DIR`(离线 .tgz 目录,优先于联网)、`DSH_MNEME_RUNTIME_MIRROR`(registry 镜像前缀)。
- port/host 解析链与宿主「外部访问」一致:显式参数 > kv `external_api` 持久值 > 默认 8790 / 127.0.0.1。
- token 与 DSH 面板 / CLI **共用同一份**(kv `external_api`,首次启动自动生成并持久化)——三方零配置互通。
- 安全:daemon 使用明文 HTTP,不提供原生 TLS。指定非回环 `--host` 时,请勿直接把服务暴露给不可信网络;远程访问请走 TLS 终止代理或 SSH 隧道。
- stdout 只在就绪时打一行 `dsh-mneme-serve listening on http://host:port (pid N)`(机器可读,脚本/测试解析端口用);日志全走 stderr。
- SIGINT/SIGTERM 优雅收库后 exit 0;Windows 强杀由 WAL 回放兜底。

## 3. 内部文件

- `src/serve.js` — `createServeRuntime({memoryDir, port, host, logger, strictPort, embed, embedder, reranker})`:装配链 createStore → createSettings → createMirror → createService(最小 config)→ recoverMirror → 人改镜像合并闭包 → vectorIndex + semantic → recall recorder → createMaintenance → createStandaloneApi(带 `embedder: embedder ?? semantic?.embedder ?? null`,供 `/context` 查询嵌入),每步锚定 index.js 行号。返回 `{api, store, service, settings, maintenance, semantic, tokenExisted, dispose}`;第三方可 import 它自行托管生命周期(bin 只是薄壳),`embedder/reranker` 参数供注入自管嵌入。
- `src/semantic.js` — embedder/reranker 装配 + boot 自动回填,**纯搬移自 index.js**(PR2),宿主与 daemon 共用同一份;`backfillMissingEmbeddings` 经 index.js barrel 再出口(测试照旧从 index.js import)。
- `bin/dsh-mneme-serve.mjs` — CLI 壳。独立成 bin 而非 cli.mjs 子命令:CONTRIBUTING 禁止给 cli.mjs 加 import;命名循 dsh-mneme-mcp 先例。
- `src/api-standalone.js` 的 `strictPort` 选项 — daemon 自己引入的唯一数据面改动,默认关闭(daemon 侧显式传 true)。#370 起该工厂另增 `/context` 路由与可选 `embedder` 注入,宿主外部访问同享。

## 4. 已知坑

1. **端口互斥,二选一**:daemon 与 DSH 的「外部访问」抢同一个默认端口。daemon 侧 strictPort 报错退出;反方向( daemon 先占 8790,DSH 后开外部访问)宿主侧会**静默顺延**到下一端口(宿主旁路的多实例恢复语义,api-standalone.js listenWithRetry)——面板显示的端口会变,别当 bug 报。
2. **双进程写并发**:与 DSH 同时运行是设计内场景(WAL + busy_timeout 先序,store.js createStore)。但 `saveWithDedupe` 的 (type,title,scope) 去重是先查后写、库层无 UNIQUE 约束,两进程并发写同一三元组有极小概率产生重复条目——已知限制,勿当强保证宣传(要不要加 UNIQUE 索引属 schema 防御段,单独决策)。
3. **镜像双写竞态**:daemon 与宿主都会渲镜像 .md;可再生物,失败由 recoverMirror 自愈,极端并发下单文件可能短暂脏,下次同步覆盖。
4. **版本偏斜**:库迁移是幂等加法式(PRAGMA 检查 + ALTER),旧代码读新 schema 一般无碍,但该组合无人测过——daemon 与插件请同版本升级。
5. **第一期不吃宿主配置**:daemon 不加载 config schema(schemastery 是宿主 peer 依赖),面板/feature_flags 对它不生效;它只有 CLI 参数 + 上述固定最小 config(`language: zh`、document 子系统关闭;语义键默认值逐键锚定 config.js,见 `src/serve.js` 的 `daemonSemanticCfg`)。`--embed local` 首次启动会自动取件 runtime + 模型(均有日志);取件/嵌入失败统一降级关键词 + BM25,不影响读写。
6. **验收锚点**:`test/serve.test.js`(in-process 全链路 + token 复用 + recall_runs 回执 + 注入假 embedder 的向量轴锁)、`test/serve-bin.test.js`(真子进程 + 多进程互写互读)、`test/standalone-api.test.js` 的 strictPort 用例(busy → reject,默认路径仍顺延)、`test/reindex-backfill.test.js`(semantic 纯搬移后宿主行为不变)。
