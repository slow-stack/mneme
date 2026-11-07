# dsh-go 原生面板

> 客户端仓库：[ccch1mneyyy/dsh-Go](https://github.com/ccch1mneyyy/dsh-Go)

> dsh-mneme 一直是「Web 面板 + 11 个记忆工具 + 自动注入」。手机 App **[dsh-go](https://github.com/ccch1mneyyy/dsh-Go)**（DSH 的 Android 客户端：Flutter 原生壳，手机本机跑引擎，也能遥控电脑）是 Flutter 原生界面，看不到 Web 面板——这个域就是给它的原生面板：与电脑端同一套功能划分（记忆 / 实体 / 设置 / 状态）、同一批后端路由。
>
> 记忆库是**按宿主独立存放**的：面板读写的是它所在那台宿主的 `memory.db`，与另一台设备上的库不互通。目前没有在线同步，只能通过分享包 `mneme.share/v1` 手动迁移，且不是实时同步。

## 职责边界

- **只做展示与转发**：取数、写回都走 `src/api.js` 已注册的 HTTP 路由 handler（进程内派发），不新增路由、不直连 SQLite、不写第二套口径。
- **不碰记忆本体**：面板不参与蒸馏、注入、巩固、冲突判定；它只是这些能力的一个操作面（和 Web 面板同级）。
- **可选能力**：桌面 / headless 宿主没有 [dsh-go](https://github.com/ccch1mneyyy/dsh-Go) 桥，这个域整块不加载（`ctx.inject(["dshGo"], …)` 的回调不会被调度）。
- **不重复 Web 面板**：`lib/client.js`（浏览器 bundle）照旧是 Web 面板的唯一实现；两边共享的是**后端**，不是视图代码。

## 对外接口

### 1. 包清单

`package.json` 的 `dshGo` 字段（[dsh-go](https://github.com/ccch1mneyyy/dsh-Go) 桥扫描已启用插件的 package.json，见 `dsh-go-bridge/lib/native/manifest.js`）：

```json
"dshGo": { "v": 1, "title": {...}, "icon": "book", "contributes": { "panels": [{ "id": "mneme", ... }] } }
```

面板的 `pkg` 由桥按「注册调用所在 fiber 所属的 loader entry」反查，所以**不需要独立包**：在 mneme 自己的插件上下文里调 `ctx.dshGo.panel("mneme", …)`，归谁一目了然。

### 2. 挂载点

`src/index.js` 在 webServer 块内、`createApi` 之后：

```js
ctx.inject(["dshGo"], (dshCtx) => {
  import("./dsh-go/panel.js")
    .then((panel) => panel.mountDshGoPanel(dshCtx, { apiToken: cfg.apiToken }))
    .catch((error) => ctx.logger?.warn?.(`[dsh-mneme] dsh-go 面板未加载：${error?.message ?? error}`));
});
```

两处细节都是刻意的：

- **动态 import**：静态导入会在插件加载时就把面板模块跑一遍，「没有 dsh-go 就不加载这个域」这句承诺就不成立了。
- **把 `cfg.apiToken` 交给面板**：`createApi` 给 token / token-write 路由包了鉴权，进程内调用不带令牌会被自家路由拦成 401。令牌以 `x-dsh-mneme-token` 头随请求走（`src/dsh-go/host.js`），不给进程内调用开白名单。

### 3. 视图协议（v2）

`buildView(state)` 返回 `{v:2, type:"stack", accent:"app", children:[…]}`，顶层是 App 原生 `tabs`：记忆 / 实体 / 设置。设置页顶部两格 `segmented`（设置 | 状态）——电脑端是四个页签，但 App 的页签条每格有 80dp 下限，四格在手机上会折行，所以放三格。

### 4. 0.11.0 补上的两块面板面

mneme 0.11.0 把「Agent 眼中的你」自动事实（`profile_facts` 三表）和 chorography 地志搬上了 Web 面板。手机面板跟着补，仍走同一批路由：

| 面板位置 | 路由 | 说明 |
|---|---|---|
| 设置 › 个性化 › Agent 眼中的你 | `GET /profile-facts?agent=` | 一次拿到 `cards` / `facts`（含归档）/ `journal` / `runs`；flag 关着也照读，历史上攒下的事实要能看见 |
| 同上（增 / 改 / 归档） | `POST /profile-facts/apply` | body `{agent, ops}`，op 形状与自动轮共用：`add` 必须带 `content`，`update`/`archive` 必须带 `id` |
| 同上（立即更新） | `POST /profile-facts/run` | 一次 LLM 维护轮，慢且串行，面板按 pending 处理（60s）；`409` = 功能关着，`503` = 没配模型，`502` = 模型答得不成形 |
| 设置 › 记忆引擎 › 代码库地志 | `GET /choro/repos`、`/choro/modules?repo=`、`/choro/page?repo=&slug=` | 仓库 → 模块骨架 → 页正文；都受 `chorographyEnabled` 闸门（关着回 `409 disabled`） |
| 同上（重建骨架） | `POST /choro/run` `{repo}` | 只跑 T0 apply（秒级）；T1 富化仍需命令行 `--t1`，所以重建会把已富化的语义段退回骨架 |

功能开关这块也换了一半口径：

- 枚举型旗标（`chorographyInject` 的 `light/full/off`）用下拉，`PUT /features` 收字符串值——同一个动作 id 既服务开关也服务下拉。
- 新增「其它」分组：把 `/features` 的 `effective` 里**我们还没给中文名**的布尔项动态列成数据行（`list` + `items` 绑定），点一行翻转一项。上游每加一个开关，手机面板不会再静默漏掉它；数值/字符串键（模型名、预算）不放这里，它们要输入框。

## 内部文件

| 文件 | 一句话 |
|---|---|
| `src/dsh-go/panel.js` | 状态机、取数、动作（`mountDshGoPanel`）。动作跑完自己把新数据推给所有打开的 feed |
| `src/dsh-go/host.js` | 进程内派发：`ctx.get("webServer").match(path)` 拿到 mneme 自己的 handler，伪造 req/res 调用 |
| `src/dsh-go/text.js` | 类型标签、开关分组、时间与 scope 格式化 |
| `src/dsh-go/views/root.js` | `buildView`：顶层页签组合 |
| `src/dsh-go/views/{common,memory,entity,settings,status}.js` | 各分区视图；`common.js` 是小组件构造器 |

文案取自 Web 面板的 zh i18n（`lib/client.js` 里的 `memory.*` 键），面板不再自造解释性文案。

## 已知坑

- **feed 是推送式的**：`data()` 每个面板实例只跑一次，`refresh` 效果只让 App 重画视图、不会重跑 `data()`。所以每个动作结尾都要 `broadcast()`（向所有 emit 推新 payload），否则点了按钮界面还是旧数据。推送节流 4/s。
- **不能走 HTTP**：[dsh-go](https://github.com/ccch1mneyyy/dsh-Go) 桥的路由守卫（`installFallbackGuard`）对没有合法签名的请求直接 401（`x-dsh-go-guard: reject`），浏览器 cookie 是宿主签的、进程内也拿不到。进程内 `webServer.match()` 绕开这一层，且复用同一批 handler。
- **`/external-api` 的 GET 有副作用**：不带参数时会顺手生成 Bearer token 并落库。面板读配置用 `?token=omit`（只回 `enabled/port/host`，不铸造也不落库），不读令牌。
- **进程内调用也要带令牌**：宿主配了 `apiToken` 时，`/update`、`/delete`、`/features` 这些 token 路由对进程内请求同样校验；令牌走 `x-dsh-mneme-token` 头。
- **两种响应节奏都要等**：多数路由在返回的 promise 里 `res.end`，少数（`/version-check`）立即 `return` 再在回调里写响应。`host.js` 同时等 handler 的返回值和响应结束，只 race 的话后者会被当成空结果。
- **`/search` 不认识 `type`**：它是全库语义检索，面板在拿到结果后再按所选类型收一遍。
- **`/entities` 的 `q`**：名字过滤必须下推到 store（`LIKE`，`%`/`_` 转义）。面板若自己取 limit 条再本地过滤，排在 limit 之外的实体永远搜不到。
- **删除只能按状态认人**：`confirm` 节点没有参数位（只有 id 与两个按钮文案），所以「删哪一条」只能靠状态；状态是所有面板共用的，因此面板按 `scope` 记下自己打开的那条，确认时与本打开的条目核对，不一致就拒绝。
- **`/update` 不接受 `type`**：编辑已有记忆时类型只读展示，新建才给选择器。
- **保存只发差集**：`/update` 没有版本号校验，整份提交会把别处（工具、Web 面板）刚写进去的新值盖掉。面板在编辑页记住打开时的快照，只提交改动过的字段，`updated_at` 对不上就中止并让用户再看一眼。
- **`/create` 不接受 scope**：归属 Agent / 工作区两个输入只在编辑已有记忆时出现。
- **节点预算**：面板 120 节点 / 8 层 / 32 KiB，`data` 32 KiB。列表行只下发 `summary`（`content` 截 120 字），全文留在详情取，否则条目一多就超预算。
- **地志与事实都有闸门**：`/choro/*` 在 `chorographyEnabled` 关闭时回 `409 {error:"disabled"}`，`/profile-facts/run` 在 `profileFactsEnabled` 关闭时同样 `409`；两个读口（`/profile-facts`、`/choro/repos` 之外的模块/页）不受开关影响，面板要能展示历史数据。
- **事实的 op 形状是硬约定**：`add` 缺 `content` 会把 `"undefined"` 写进事实正文并从此每帧注入；面板在本地就拦「正文不能空」，不把脏 op 递过去。
- **重建骨架只到 T0**：`POST /choro/run` 是同步秒级回执，不带 T1 富化；面板文案要说明「语义段退回骨架」，否则用户会以为富化丢了。
- **`refresh` 会重建视图树，页签选择会丢**：顶层 `tabs` 的选中项是 App 的本地状态（视图协议没有绑定口），App 收到 `refresh` 重新拉一遍视图，树一重建就回到第一个页签。所以「只改一个绑定值」的动作（开关、档位下拉、外部访问开关、事实增改、地志翻页）不要申请重画，只推数据；只有真的改变了「哪些节点存在」的动作（进子页、换分区、换分组、翻页、搜索）才要 refresh。
- **`nestFlags` 不能把值压成布尔**：枚举型旗标（`chorographyInject` = light/full/off）以前被写成 `value === true`，下拉永远只拿到 true/false。视图绑定要原样透传。
- **不要用 `metric.caption` 放单位**：`caption` 固定渲染在数值下方一行；v2 的 metric 整串数值同一字号，所以单位拼进 value（`57 条`），App 侧只有自带模型卡才会拆小字单位。
