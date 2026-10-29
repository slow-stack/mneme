# 记忆分享包 · 车道 D（面板）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让不熟命令行的人在记忆面板里完成分享包的出、收、撤三步——分享弹层先看报告再下载、接收弹层先干跑再确认、外来区可筛可撤。

**Architecture:** 面板三件全部住在手写的 `lib/client.js`（lib-only，`npm run sync` 不 prune）；服务端只补一处——`/api/dsh-mneme/list` 在 HTTP 层给面板行加 `share_pack_id`（与既有 `archived`/`quality_score`/`heat` 同一处扩展点，不动 `toApiList`，因此不碰模型工具的 `MEMORY_ITEM_SCHEMA`）。三条路由与两张皮共用层在车道 A/C 已交付，本车道**不加路由、不加配置键、不改鉴权**。

**Tech Stack:** ESM、React（宿主提供的 `h`/`useState`/`useRef`/`useEffect`，经 `__ModuleLoader__` 注入）、`node:test` + `node:assert/strict`、Node 22/24、CI ubuntu + windows。

**Spec:** `docs/specs/2026-10-22-memory-share-pack-design.md`（§6 面板、§7 路由、§8 错误、§9 测试矩阵、§11 开关、§13 车道切分）——正文里 `src/…`、`lib/…`、`test/…` 一律相对包目录 `dsh-mneme/`，与 spec 同口径。

**前序车道：** A（出包）、B（守卫）、C（入库与退出）都已在本地 `main`。本计划的 BASE 是 `e9889bc`。

## Global Constraints

以下每一任务都隐含遵守（逐条抄自 spec 与 AGENTS.md，不打折）：

- **不加任何配置键**：`src/settings.js` 白名单、`src/config.js` schema、`test/api.test.js` 的旗标计数锁（**103**）一行都不许动（spec §11）。
- **不加新路由、不改 policy**：三条 share 路由（`/share`、`/receive`、`/receive/undo`）车道 A/C 已登记，`SECURITY.md` 的受门控清单**不动**（`test/security-doc.test.js` 双向比对，动它就红）。
- `lib/client.js` 是 **lib-only 手写文件**（`scripts/sync-lib.js:1-5`，sync 不 prune）：改它**不触发** check-sync，也不许为它造 `src/client.js`（`test/client.test.js:24` 锁这条）。
- 改了 `src/api.js`（D1 唯一一处）**必须** `npm run sync` 再提交，`lib/api.js` 与 `src/api.js` 平价由 `scripts/check-sync.js` 与 lib-smoke 守。
- **配色纪律 10**：新增/改动的每一条 `color:` 声明只许引用 `--mneme-*` 语义层或**真实存在**的 `--dsw-alias-*`；`test/contrast.test.js` 会自动重算全部 `color` 声明的浅/深双主题对比度（正文 4.5:1、图形色 3:1），解析不出来的颜色记失败不静默跳过。本计划只用六个已存在的令牌：`--mneme-fg-dim`、`--mneme-accent`、`--mneme-danger`、`--mneme-warn`、`--mneme-ok`、`--dsw-alias-label-primary`，以及边框用的 `--dsw-alias-border-l2`。
- **文案纪律**：面板文案是 `lib/client.js` 内联的两份字典（zh 从 `:264`、en 从 `:958` 起），**不是** `locale/*.json`（那两份只有 `meta.*`）。每个键必须**恰好出现两次**（zh + en），由 `test/client.test.js:930` 的全局锁把守；插值一律 `.replace("{n}", …)` 形式。
- **判据不许有第二份**：哪些行进包、包合不合格、错误码映射成什么状态，全在 `src/share.js` / `src/share-http.js` / `src/share-import.js`。面板只做协议消费方，**不复述任何一条判据**（#411 口径）。
- **注释写「为什么」**（纪律 8）：反直觉的门禁、默认干跑、截断口径、自门控徽章这类地方必须落一行「为什么」，代码含义靠命名与测试名表达。
- 测试命令：聚焦 `node --test test/<file>.js`；每次提交前 `npm test` 全绿（本车道结束时基线是 `tests 2398 / pass 2397 / fail 0 / skipped 1`，那 1 条 skipped 是既有的）。
- 提交纪律：`git add` **点名文件**，不用 `-A`/`.`；**不得有任何 `Co-Authored-By` trailer 或 AI 署名**（AGENTS.md，2026-09-19 起硬性）；不 amend、不 force-push。
- Git 收尾：本车道继续提交到**本地 `main`**（主树，她已授权），**不 push、不 rebase**（她对车道 C 收尾选的「保持现状」仍然生效；`main` 现在 ahead 57 / behind 11，收尾时如实报一次即可，不要自作处置）。
- 面板**不能在本机浏览器里验**：`lib/client.js` 由 DSH 宿主的 `__ModuleLoader__` 加载，本仓库没有可跑的宿主壳。所以本车道的「验证」= 静态锁 + 全套单测 + 明确交付「她 relink 后需要自己点的四步」。任何报告里不许写「UI 已验证」，只许写「锁住的是源码形状，真实渲染待她目测」。

---

## 车道 D 的三条线（决定与代价，评审可直接驳）

写这份计划前对着代码定下来的三条收窄，都是「面板 v1 该不该做这一格」的判断，spec §6 没细写：

1. **分享弹层只给 `type` 分批，不给 `tag` 分批。**
   理由：超水位时最常用的切法是按类型（实测单 type 最大批 1.10 MiB，整库 4.34 MiB，见 `docs/SHARE.md` 的实测那节），`tag` 是自由文本、错填一个字母就「静默发 0 条」，值不值得为它做一套输入框另说。
   代价：按 tag 分批仍然只能用 `dsh-mneme share --tag …`。413 的提示文案（`SHARE_ERROR_HINT`，住在 `src/share-http.js:11`）**原样显示**——它写着 `--type`/`--tag`，是 CLI 口吻。不在面板里改写成第二套措辞，因为「同一份错误文案只许有一份」（`docs/SHARE.md:439` 已把这条纪律写明）。**这一格要在 `docs/SHARE.md` 里如实写清。**

2. **外来区三件事都只在浏览态成立：筛选、徽标、整包退出。搜索态一样都做不了。**
   理由（写计划时我以为只有第二条成立，D1 的实现者对着代码推翻了第一条——已核）：
   `pack_id` 只从 `/api/dsh-mneme/list` 的面板行下发（D1）；而 `/search` 的 DTO 里
   **`source` 根本不是行来源**——`service.searchMemories` 给每条候选盖上召回渠道
   （`source: "keyword"|"vector"|"bm25"`，`src/service.js:939`、`:966`、`:974`），
   `toApiList` 原样透出，于是「这条是不是外来的」在搜索结果里读不出来。
   做法：筛选与撤销都挂在服务端真值上，读不出来就**明确不启用**——外来 chip 在有搜索词时
   `disabled` 并给出自己的文案（不假装筛过），徽标按 `source === "imported"` 门控（搜索态自然
   不出现），撤销按钮按 `memory.share_pack_id` 自门控（与 `heat` 徽章同一做法）。
   D1 的第三条用例把这两个事实钉住：哪天有人把召回侧那个字段改名让开 `source`（那是另一刀，
   牵动 `recall_runs` 的回执形状），那条会红，本条裁定届时要一起重看。
   代价：她在搜索态看到一条外来记忆时，既筛不掉它也撤不掉它，得清掉搜索词回浏览态。
   顺带记一笔**已知既存缺陷**（本车道不修）：搜索结果的卡片脚上那颗 `.mneme-cardsrc`
   显示的是 `keyword`/`vector`/`bm25` 而不是行的来源——那是同一个覆盖形状的另一处症状。
   代价写进 `docs/SHARE.md`，缺陷写进台账交给她判。

3. **别名输入框 `maxLength: 27`，与服务端同一把尺。**
   理由：`importedTagFor`（`src/share.js`）把整串标签（含 `from-` 前缀）截到 `IMPORTED_TAG_MAX = 32`，不拦的话她打的第 28 个字起在**对面**被静默吃掉，而这条标签是外来行唯一的来源读数。
   代价：`27` 这个数字在面板里出现一次，用一条跨文件静态锁（`test/client-share.test.js`）钉住它必须等于 `32 - "from-".length`；服务端改常量不改面板会红。

**明确不做（本车道）**：不加新路由、不加 policy、不改 `sendJson` 签名（A6 台账里那条 `Allow` 头缺失仍是独立判断，不夹带）、不动 `failHttp`/`index` 透传那笔账（车道 D 之后的收尾刀）、不改 `service.transaction()` 的可重入性（D 不需要嵌套事务）。

---

## File Structure

| 文件 | 本车道职责 | 动作 |
|---|---|---|
| `src/api.js` | `/api/dsh-mneme/list` 的面板行扩展点：条件补 `share_pack_id`（唯一一处服务端改动，`:387-392` 那个 map 里） | D1 modify |
| `lib/api.js` | sync 产物 | D1 `npm run sync` |
| `lib/client.js` | 面板三件：`ShareDialog` + `ShareReport`、`ReceiveDialog` + `ReceiveSummary`、外来区（筛选 chip + `ForeignBadge` + 抽屉撤销）；两份内联字典的新键；CSS 数组里 9 条新规则 | D2/D3/D4 modify |
| `test/share-foreign-rows.test.js` | 服务端行为锁：`/list` 的 `source=imported` 精确筛选与 `share_pack_id` 下发口径；`/search` 不带这一格 | D1 create |
| `test/client-share.test.js` | 面板静态锁 + 跨文件锁（类型集、六个跳过原因、别名尺、新键双语） | D2 create，D3/D4 append |
| `dsh-mneme/docs/SHARE.md` | 「面板」用法小节；`:8` 那句「缺的只剩面板按钮」；`:298` 的 loading 账；`:419-434` 的三笔账改写成「已闭 + 还剩什么」 | D5 modify |
| `dsh-mneme/README.md` | `### 记忆库主区视图与记忆图谱`（`:245`）末尾补面板三步的条目 | D5 modify |
| `AGENTS.md`（仓库根） | 模块地图「分享包（出与收）」那行（`:49`）末尾的「面板按钮属车道 D」换成面板三件的实际归属 | D5 modify |

新代码在 `lib/client.js` 里的**插入锚点**（行号会随任务漂移，一律以代码文本为锚）：

- `ForeignBadge` → 紧跟 `const ScopeBadge = ({ m, t }) => { … };`（现 `:232-241`）之后；
- `dispositionName` / `SHARE_TYPE_OPTIONS` / `SHARE_SKIP_REASONS` / `ShareDialog` / `ShareReport` / `ReceiveDialog` / `ReceiveSummary` → 紧跟 `function ImportDialog({ t, onClose, onImported }) { … }` 的收尾 `}`（现 `:6189`）之后、`function CreateDialog` 之前；
- 弹层状态位 → 紧跟 `const [createOpen, setCreateOpen] = useState(false);`（现 `:6337`）之后；外来筛选位 → 紧跟 `const [archivedOnly, setArchivedOnly] = useState(false);`（现 `:6332`）之后；
- CSS 新规则 → 紧跟 `".mneme-improw{display:flex;align-items:center;gap:8px;margin-top:10px}",`（现 `:2058`）之后；
- zh 文案 → 紧跟 `"memory.explorer.importNoFile": "请先选择文件",`（现 `:731`）之后；en 文案 → 紧跟 `"memory.explorer.importNoFile": "Choose a file first",`（现 `:1404`）之后。

---

## Interfaces

本车道**不产出新的服务端导出**。消费的东西都是车道 A/C 已交付的：

- `POST /api/dsh-mneme/share` → 200 `mneme.share/v1` 包体 `{ kind, pack_id, alias, generated_at, source_version, report:{ included, deduped, skipped:{6 键}, skip_list:[{title, reason}] }, memories:[…] }`，`report.skipped` 六键固定为 `archived`/`forgotten`/`readonly_type`/`excluded_type`/`blank_or_noise`/`sensitive`（`src/share.js:223`），`skip_list` 截到 50（`src/share.js:237`）；413 → `{ error:"too-large", bytes, limitBytes, hint, report }`；GET → 405（`src/api.js:1474-1515`）。200 带 `Content-Disposition`（`src/api.js:1499-1501`）。
- `POST /api/dsh-mneme/receive` → 200 `{ pack_id, alias, created, skipped_existing, unchanged, title_conflicts:[{type,title,existing_id}], conflicts_checked, dry_run }`（`src/share-import.js:171-187` + `share-http.js:173` 的 `dry_run`）；缺 `confirm: true` 一律干跑；400 带 `{ error, detail? }`（码表 `src/share-http.js:138-147`）。
- `POST /api/dsh-mneme/receive/undo` → 200 `{ pack_id, deleted, sample, dry_run }`（`sample` 前 20 条，`src/share-import.js:36`）。
- `GET /api/dsh-mneme/list` → 已支持 `source` 精确匹配（`src/api.js:368`，`store.js:1658`），本车道在 `:387-392` 的 map 里补 `share_pack_id`；`GET /api/dsh-mneme/search` → `toApiList` 输出（含 `source`、`tags`，**不含** `share_pack_id`）。
- 面板内新契约（D2 产出、D4 消费）：`ForeignBadge({ m, t })`、`isImportedItem(m)`（在 `lib/client.js` 里就是一个 `m.source === "imported"` 的判定，不另造谓词）。

---

### Task D1: 面板行带包号（唯一一处服务端改动）

**Files:**
- Modify: `src/api.js`（`/api/dsh-mneme/list` 的 items map，现 `:387-392`）
- Modify: `lib/api.js`（`npm run sync` 产物，不许手改）
- Create: `test/share-foreign-rows.test.js`

**Interfaces:**
- Consumes: `store.list()` 返回的行已带 `share_pack_id`（`src/store.js:544` 的 `toRow`）；`service.count(type, {source})` 已吃 `source`（`src/api.js:396`）。
- Produces: `/api/dsh-mneme/list` 的面板行在**有包号时**多一个键 `share_pack_id`；没有包号的行**不带这个键**（不是 `null`、不是 `""`）。D4 的抽屉撤销按钮按它自门控。

- [ ] **Step 1: 写失败的测试**

创建 `test/share-foreign-rows.test.js`，装配台照 `test/share-routes.test.js:67-85` 的 `shareSetup`（**必须落文件库**，`:memory:` 与文件库在 `service.list` 的读侧没差别，但这条锁吃的是真实列值，没必要用内存库的例外）。整份内容：

```js
// 外来区的服务端读数锁：面板要能「只筛外来行」并且「知道每行属于哪个包」。
// 盯三件事：
//   a) /list 的 source=imported 是**精确匹配**（src/store.js:1658），且 total 同口径——
//      面板的「外来」chip 直接吃这个参数，分页与计数不许各算一套；
//   b) /list 的面板行在**有包号时**才带 share_pack_id，普通行不带这个键（不是 null）。
//      这是抽屉「收起这个包」按钮的自门控依据，缺了它按钮就不该出现；
//   c) /search 的 DTO **既不带** share_pack_id，它的 `source` 也**不是**行来源——
//      service.searchMemories 给每条候选盖上召回渠道（`source: "keyword"|"vector"|"bm25"`，
//      src/service.js:939/966/974），把行自己的 provenance 覆盖掉了，所以搜索态压根读不出
//      「这条是不是外来的」。这一条锁住的是那个事实，不是待实现的功能，它同时是 D4 那条
//      「外来 chip 只管浏览态」裁定的凭据。哪天有人把召回渠道改名让开 `source`（那是另一刀，
//      牵动 recall_runs 的回执形状），这条会红，D4 的裁定届时要一起重看。
// 扩展点住在 HTTP 层不是 toApiList：模型工具严格复用后者（src/service.js:2094），
// archived/quality_score/heat 都在这同一处补，包号跟着走同一条路。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createApi } from "../src/api.js";
import { IMPORTED_SOURCE } from "../src/memory-source.js";
import { deriveExternalId } from "../src/share.js";

const PACK_ID = "0123456789abcdef";

class FakeRes {
  constructor() {
    this.statusCode = 0;
    this.body = "";
    this.headers = {};
  }
  writeHead(code, headers) {
    this.statusCode = code;
    this.headers = headers || {};
    return this;
  }
  end(text) {
    this.body = text ?? "";
    return this;
  }
}

function foreignSetup() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-foreign-rows-"));
  const store = createStore(join(dir, "memory.db"));
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const commands = { add: () => {}, remove: () => {}, list: () => [] };
  const routes = [];
  const ctx = { logger: null, webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, commands, null, undefined, "secret-token", null, null);
  return {
    store,
    service,
    routes,
    route(path) { return routes.find((r) => r.path === path); },
    close() {
      // 闭包拿 store，不用 this：裸调用下 this 是 undefined，异常被吞就变成
      // 「库没关就删目录」的 EPERM（同 share-routes.test.js 的理由）。
      try { store.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** GET 用的最小假 req：/list 与 /search 都是 policy open，不读 body。 */
function getReq(url) {
  return { method: "GET", url, headers: {} };
}

async function call(route, url) {
  const res = new FakeRes();
  await route.handler(getReq(url), res);
  return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : null };
}

/** 造一条外来行，字段与真实入库路径同一套（src/share-import.js 的落值）。
 *  注意 store.save 直接返回**那一行**（`insertMemoryRow` 的结果，见 src/store.js:1180-1185），
 *  而 service.saveWithDedupe 返回 `{ action, memory }`——两个形状不一样，别混。 */
function foreignRow(store, title) {
  return store.save({
    type: "decision",
    title,
    content: "对方库里的原文，本机不巩固它。",
    tags: ["from-桉桉"],
    source: IMPORTED_SOURCE,
    share_pack_id: PACK_ID,
    share_external_id: deriveExternalId(PACK_ID, "decision", title, "deadbeef"),
    epistemic_status: "confirmed"
  });
}

test("list?source=imported returns only foreign rows and counts the same set", async () => {
  const h = foreignSetup();
  try {
    h.service.saveWithDedupe({ type: "decision", title: "我自己的决定", content: "本机原文", tags: [] });
    foreignRow(h.store, "外来决定一");
    foreignRow(h.store, "外来决定二");
    const out = await call(h.route("/api/dsh-mneme/list"), "/api/dsh-mneme/list?source=imported");
    assert.equal(out.status, 200);
    assert.equal(out.data.items.length, 2, "只回外来行");
    assert.equal(out.data.total, 2, "total 与行同口径，否则分页的 has-more 会算错");
    assert.ok(out.data.items.every((m) => m.source === IMPORTED_SOURCE));
    const all = await call(h.route("/api/dsh-mneme/list"), "/api/dsh-mneme/list");
    assert.equal(all.data.items.length, 3, "不带 source 时三条都在");
  } finally { h.close(); }
});

test("list puts share_pack_id on foreign panel rows and omits the key on own rows", async () => {
  const h = foreignSetup();
  try {
    const own = h.service.saveWithDedupe({ type: "preference", title: "语言", content: "中文", tags: [] });
    foreignRow(h.store, "外来决定");
    const out = await call(h.route("/api/dsh-mneme/list"), "/api/dsh-mneme/list");
    const foreign = out.data.items.find((m) => m.source === IMPORTED_SOURCE);
    const ownRow = out.data.items.find((m) => m.id === own.memory.id);
    assert.equal(foreign.share_pack_id, PACK_ID);
    // 键**不存在**而不是 null：面板的按钮按 `memory.share_pack_id` 真值门控，
    // 一个 null 与一个 undefined 在 JSON 里是两种形状，锁死成一种。
    assert.equal("share_pack_id" in ownRow, false, "自己的行不许带包号键");
  } finally { h.close(); }
});

test("search DTO carries neither the pack id nor the row's own source", async () => {
  const h = foreignSetup();
  try {
    foreignRow(h.store, "外来检索命中");
    const out = await call(h.route("/api/dsh-mneme/search"), "/api/dsh-mneme/search?q=%E5%A4%96%E6%9D%A5%E6%A3%80%E7%B4%A2%E5%91%BD%E4%B8%AD");
    assert.equal(out.status, 200);
    assert.ok(out.data.items.length > 0, "关键词路径要能命中这条");
    assert.equal("share_pack_id" in out.data.items[0], false, "search 的 DTO 不带包号");
    // 召回渠道把行的 provenance 盖掉了（src/service.js:939/966/974）：这一格在搜索态**不是**
    // 行来源，所以「这条是不是外来的」在这张 DTO 上读不出来。D4 的外来 chip 因此只管浏览态。
    // 别把这条断言当 bug 去「修」——它是那条裁定的凭据，真要修的是召回侧的字段命名。
    assert.notEqual(out.data.items[0].source, IMPORTED_SOURCE,
      "search 的 source 是召回渠道（keyword/vector/bm25），不是行来源");
  } finally { h.close(); }
});
```

> 实现者注意一处：`deriveExternalId` 的第四参是**包里那条 `content_hash`**，本测试只造键不校验键，任何非空串都行（真实入库时服务端会先用 `validateSharePack` 重算一遍再比，这条锁不吃那一档，见 `test/share-import.test.js`）。`foreignRow` 的形状照 `test/share-imported-guard.test.js` 里那句 `store.save({ … source: IMPORTED_SOURCE … })`——那是本仓唯一一处直接造外来行的先例。

- [ ] **Step 2: 跑测试确认失败的原因正确**

Run: `node --test test/share-foreign-rows.test.js`
Expected: **只有第二条红**（`share_pack_id` 那个键还没有），第一条与第三条**本来就是绿的**——它们锁的是服务端已有的能力与既有的形状（`source=imported` 精确筛选、search 的 DTO 不带包号且 `source` 是召回渠道），是这条车道依赖的前提，不是待实现的功能。第一条若也红，先确认 `service.count` 是否真的吃了 `source`（`src/api.js:396`）；第三条若红，说明召回侧的字段形状变了，停下来报 NEEDS_CONTEXT，不要改断言迁就。

- [ ] **Step 3: 实现——只改一处 map**

`src/api.js`，把现在的（`:387-392`）：

```js
        const items = service.toApiList(rows).map((m, i) => ({
          ...m,
          archived: rows[i].archived === true || rows[i].archived === 1,
          quality_score: rows[i].quality_score ?? null,
          ...(heatOn ? { heat: computeHeat(rows[i], Date.now(), config ?? {}) } : {})
        }));
```

改成：

```js
        const items = service.toApiList(rows).map((m, i) => ({
          ...m,
          archived: rows[i].archived === true || rows[i].archived === 1,
          quality_score: rows[i].quality_score ?? null,
          // 外来区的包号：抽屉里的「收起这个包」按 pack_id 整批删，寻址键必须由行自己带上。
          // 与 heat 同一个做法——**缺省就不带键**，面板的撤销按钮因此天然自门控：
          // /search 的 DTO 没有这一格（向量召回那一路行集不同），搜索态按不了撤销，
          // 那条代价写在 docs/SHARE.md 的车道 D 一节。扩展点留在 HTTP 层而不是
          // toApiList：模型工具严格复用后者（src/service.js:2094 与 MEMORY_ITEM_SCHEMA），
          // 给它们加一格没有第二个消费者，却要多改一处 schema 声明。
          ...(rows[i].share_pack_id ? { share_pack_id: rows[i].share_pack_id } : {}),
          ...(heatOn ? { heat: computeHeat(rows[i], Date.now(), config ?? {}) } : {})
        }));
```

- [ ] **Step 4: 同步并跑聚焦测试**

```bash
cd dsh-mneme
npm run sync
node --test test/share-foreign-rows.test.js
```
Expected: `tests 3 / pass 3 / fail 0`。

- [ ] **Step 5: 确认没伤到平价与既有锁**

```bash
cd dsh-mneme
npm run check-sync 2>/dev/null || node scripts/check-sync.js
node --test test/api.test.js test/share-routes.test.js test/tools-dto-schema-matrix.test.js
```
Expected: check-sync 通过；三份测试全绿（`tools-dto-schema-matrix` 绿是**关键证据**：包号没有混进模型工具的 DTO，`MEMORY_ITEM_SCHEMA` 未改）。

- [ ] **Step 6: 全套 + 提交**

```bash
cd dsh-mneme && npm test
git add dsh-mneme/src/api.js dsh-mneme/lib/api.js dsh-mneme/test/share-foreign-rows.test.js
git commit -m "feat(share): hand the panel the pack id on foreign rows"
```
（在仓库根执行 `git add`，路径按根写；`npm test` 基线 `tests 2401 / pass 2400 / fail 0 / skipped 1`——比 D1 之前多 3 条。）

**自查（D1）**：有没有顺手改 `toApiList`？有没有给 search 补包号？`policy` 与 `SECURITY.md` 一行未动？`lib/api.js` 与 `src/api.js` 的 diff 是否逐字节相同（`git show --stat` 两侧行数相等）？

---

### Task D2: 分享弹层（先报告，后下载）

**Files:**
- Modify: `lib/client.js`（字典两份 + CSS 数组 + `ShareDialog`/`ShareReport` + ⋯ 菜单的第一个新入口与 `shareOpen` 状态位）
- Create: `test/client-share.test.js`

**Interfaces:**
- Consumes: `POST /api/dsh-mneme/share`（`{alias?, type?}` → 包 或 413 报告）；面板已有的 `apiFetch`（`lib/client.js:247`）、`typeLabel`（`:4401` 附近，缺键回落原始类型串）、类 `mneme-impdialog`/`mneme-improw`/`mneme-featsubhint`/`mneme-saved`/`mneme-select`/`mneme-btn`/`mneme-footbtn`/`mneme-set-title`。
- Produces: `ShareDialog({ t, onClose })`、`ShareReport({ t, report, listOpen, setListOpen })`、`dispositionName(value)`、`SHARE_TYPE_OPTIONS`、`SHARE_SKIP_REASONS`。D4 不用这些；D5 的文档要引用「分享弹层」这个名字。

- [ ] **Step 1: 写失败的测试**

创建 `test/client-share.test.js`。全部是**静态源锁**（本仓库面板的可测形状就是这个，`test/client.test.js` 通篇如此：读 `lib/client.js` 文本按形状断言，不渲染）。整份内容：

```js
// 车道 D 的面板静态锁。为什么是静态锁：lib/client.js 由宿主 __ModuleLoader__ 加载，
// 本仓库没有可跑的宿主壳，渲染测试要拖进一份 React 测试栈才够得着那几行真代码。
// 锁的是「形状」而不是「长得像」：每一条都对应一个**会伤人的回归形态**，
// 注释里写清它防的是哪一种（AGENTS.md 纪律 8 对测试同样适用）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, "..", "lib/client.js"), "utf8");
const shareSource = readFileSync(join(here, "..", "src/share.js"), "utf8");

// 分享弹层最要紧的一条：**看见 report 之前不给下载**（spec §6 的支点）。
// 防的回归形态：有人为了「方便」把下载按钮改成常驻，或从别处（如列表工具栏）再开一条
// 直接落盘的口子——那一步停顿就没了，随手全库外发重新变成一次点击。
test("the share dialog gates the download on the report", () => {
  assert.ok(clientSource.includes('apiFetch("/api/dsh-mneme/share"'),
    "面板必须发这一枪（不许另造 fetch 绕过 apiFetch 的 token 注入）");
  assert.ok(clientSource.includes("const canDownload = !!rep && rep.included > 0;"),
    "下载按钮的唯一门：有报告且有内容。included 为 0 时对面吃的是 empty-pack（400），不该给一个必败的文件");
  assert.ok(clientSource.includes("canDownload && h(\"div\""),
    "下载那一行必须挂在 canDownload 上，而不是常驻（按钮本身在这样一个 div 里）");
  // 413 与 200 是两份形状：413 没有 memories，只有 report + 字节数 + hint。
  assert.ok(clientSource.includes("if (res.status === 413)"),
    "超水位要走 tooLarge 那一支，不能落到通用失败");
  assert.ok(clientSource.includes("JSON.stringify(pack, null, 2)"),
    "落盘的必须是服务端给的那份包，不能在面板里重拼字段（重拼一次就是一份第二口径）");
});

// docs/SHARE.md「车道 D 三笔账」之一：included 只数实际发出的条数，够格进包的是
// included + deduped。防的回归：有人把「合格条数」的标签挪到 included 上，读数是假的。
test("the report separates what shipped from what qualified", () => {
  assert.ok(clientSource.includes("report.included + report.deduped"),
    "折叠掉的那几条必须加回去，两个数同屏");
  assert.ok(clientSource.includes('"memory.explorer.shareDeduped"'),
    "deduped 有自己的一行文案，不是并进 included 那句");
});

// 跨文件锁：面板的六个跳过原因与八个可分享类型都只许是服务端那份的投影。
// 防的回归：share.js 加/改一个 reason 键或一类可分享类型，面板静默少一格
// ——她的报告上就有一类跳过是看不见的。
test("the panel's skip-reason and type sets mirror src/share.js", () => {
  const serverReasons = [...shareSource.matchAll(/reason:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  const uniqueReasons = [...new Set(serverReasons)];
  const panelReasons = /const SHARE_SKIP_REASONS = \[([^\]]*)\]/.exec(clientSource)[1]
    .split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
  assert.deepEqual(panelReasons, uniqueReasons,
    "跳过原因集必须与 share.js 的判序一致（顺序也一致：报告按判序展示）");

  const serverTypes = /SHARE_ALLOWED_TYPES = new Set\(\[([^\]]*)\]/.exec(shareSource)[1]
    .split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
  const panelTypes = /const SHARE_TYPE_OPTIONS = \[([^\]]*)\]/.exec(clientSource)[1]
    .split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
  assert.deepEqual(panelTypes.slice().sort(), serverTypes.slice().sort(),
    "类型下拉只能列真能进包的那几类");
});

// 别名的尺：服务端 importedTagFor 把整串（含 from-）截到 IMPORTED_TAG_MAX。
// 防的回归：服务端改这个常量而面板还拦着旧长度，她打的字在对面被静默吃掉。
test("the alias input matches the server's tag budget", () => {
  const max = Number(/IMPORTED_TAG_MAX = (\d+)/.exec(shareSource)[1]);
  assert.ok(clientSource.includes(`maxLength: ${max - "from-".length}`),
    "输入框长度必须等于服务端留给别名的字符数");
});

// 文件名以服务端 Content-Disposition 为准（拼法只住在 src/share-http.js 的 shareFilename）。
// 防的回归：面板自己抄一份「日期 + pack_id 前 8 位」的拼法，两处日后分叉。
test("the pack filename comes from the response header, with a pack_id fallback", () => {
  assert.ok(clientSource.includes('res.headers.get("content-disposition")'));
  assert.ok(clientSource.includes("const dispositionName = (value) =>"));
  // 回落那一格只许出现一次前缀串，且不带日期拼法。
  assert.equal(clientSource.split("dsh-mneme-share-").length - 1, 1,
    "面板只许有一份包名前缀串（回落用），不许再拼第二套日期命名");
  assert.equal(clientSource.includes("slice(0, 8)"), false,
    "pack_id 截 8 位是服务端的拼法，面板不许复制");
});
```

- [ ] **Step 2: 跑测试确认全红**

Run: `node --test test/client-share.test.js`
Expected: 5 条全 FAIL，失败原因都是「找不到这些串」——`/exec(shareSource)` 之类正则在 `src/share.js` 上必须**已经**能匹配（若 `SHARE_SKIP_REASONS` 那行的 `.exec(…)[1]` 抛 `null`，说明 `src/share.js` 的写法与本锁假设不同，先读 `src/share.js:120-135`、`:223` 与 `:16-19` 校准正则，不要改判据本身）。

- [ ] **Step 3: 加两份字典的新键**

zh：在 `"memory.explorer.importNoFile": "请先选择文件",` 之后插入——

```js
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
```

en：在 `"memory.explorer.importNoFile": "Choose a file first",` 之后插入——

```js
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
```

- [ ] **Step 4: 加 CSS（只用已有语义色）**

在 `".mneme-improw{display:flex;align-items:center;gap:8px;margin-top:10px}",` 之后插入——

```js
      // 车道 D 的分享/接收弹层：宽度与滚动共用 impdialog 的锚，正文一律 --mneme-* 语义层
      // （纪律 10：宿主 label-tertiary/label-dimmed 是分隔线层，不是正文色）。
      ".mneme-sharedialog{width:340px;max-height:min(72vh,560px);overflow-y:auto}",
      ".mneme-sharebody{margin-top:10px;display:flex;flex-direction:column;gap:2px}",
      ".mneme-sharebreak{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}",
      ".mneme-sharebreakitem{font-size:11px;line-height:15px;color:var(--mneme-fg-dim);font-variant-numeric:tabular-nums}",
      ".mneme-sharelist{margin-top:4px;max-height:132px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px}",
      ".mneme-sharow{display:flex;justify-content:space-between;gap:8px;font-size:11.5px;line-height:16px}",
      ".mneme-sharowtitle{color:var(--dsw-alias-label-primary);min-width:0;word-break:break-word}",
      ".mneme-sharowreason{flex:none;color:var(--mneme-fg-dim)}",
```

- [ ] **Step 5: 实现两个组件**

在 `function ImportDialog({ t, onClose, onImported }) { … }` 的收尾 `}` 之后、`function CreateDialog` 之前插入——

```js
    // --- 分享包弹层（车道 D，spec §6）---
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
            if (!res.ok || !d || !d.report) { setErr(t("memory.explorer.shareFailed")); setBusy(false); return; }
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
        const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
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
          // 它写着 --type/--tag 的 CLI 口吻，这一格已知：docs/SHARE.md 车道 D 那节记着。
          `${t("memory.explorer.shareTooLarge")
            .replace("{bytes}", String(tooLarge.bytes ?? "?"))
            .replace("{limit}", String(tooLarge.limitBytes ?? "?"))} ${tooLarge.hint || ""}`),
        tooLarge && tooLarge.report && h(ShareReport, { t, report: tooLarge.report, listOpen, setListOpen }),
        rep && h(ShareReport, { t, report: rep, listOpen, setListOpen }),
        canDownload && h("div", { className: "mneme-improw", style: { justifyContent: "flex-end" } },
          h("button", { type: "button", className: "mneme-btn", onClick: download },
            t("memory.explorer.shareDownload"))),
        rep && rep.included === 0 && h("div", { className: "mneme-featsubhint", style: { marginTop: 8 } },
          t("memory.explorer.shareEmpty"))
      );
    }
```

- [ ] **Step 6: 接一个入口（⋯ 菜单）**

`lib/client.js` 里 `const [createOpen, setCreateOpen] = useState(false);` 之后加**一个**状态位（`receiveOpen` 归 D3，别提前塞——那样菜单会引用一个 D2 还不存在的文案键）——

```js
      const [shareOpen, setShareOpen] = useState(false);
```

「⋯」按钮的 `onClick` 现在是 `() => { setMenuOpen(!menuOpen); setImportOpen(false); setCreateOpen(false); }`，改成——

```js
                onClick: () => { setMenuOpen(!menuOpen); setImportOpen(false); setCreateOpen(false); setShareOpen(false); }
```

菜单里 `t("memory.explorer.importMd"))` 那一项之后加一项——

```js
                h("button", { type: "button", role: "menuitem", onClick: () => { setShareOpen(true); setMenuOpen(false); } },
                  t("memory.explorer.sharePack")),
```

条件渲染块，`createOpen && h(CreateDialog, …)` 之前加——

```js
              shareOpen && h(ShareDialog, { t, onClose: () => setShareOpen(false) }),
```

- [ ] **Step 7: 跑锁 + 全局锁 + 全套**

```bash
cd dsh-mneme
node --test test/client-share.test.js test/client.test.js test/contrast.test.js
npm test
```
Expected: `client-share` 5/5 绿（本任务只带那 5 条）；`client.test.js` 的**双语全局锁**（`test/client.test.js:930`：每个键恰好两次）绿；`contrast.test.js` 绿（新 CSS 只引了已验证过的四个 `--mneme-*` 与两个真实宿主名）；全套相对 D1 基线只增本任务的 5 条。

- [ ] **Step 8: 提交**

```bash
git add dsh-mneme/lib/client.js dsh-mneme/test/client-share.test.js
git commit -m "feat(panel): build the share pack dialog with the report before the download"
```
（`lib/client.js` 是 lib-only，**不需要** `npm run sync`；`git status` 里不该出现别的文件。）

**自查（D2）**：`included` 与 `included + deduped` 两个数都在屏上吗？`canDownload` 是唯一下载门吗？有没有把任何一条跳过判据在面板里重述（「命中密钥的整条不发」这类话只许出现在 `shareHint` 的**说明**里，不许变成第二处判断逻辑）？新键 zh/en 各一次、没有多余空行导致全局锁误算？

---

### Task D3: 接收弹层（先干跑预览，再确认）

**Files:**
- Modify: `lib/client.js`（字典两份 + `ReceiveDialog`/`ReceiveSummary` + ⋯ 菜单的第二个入口与 `receiveOpen` 状态位 + 条件渲染。CSS 零新增：弹层复用 D2 的 `mneme-sharedialog`/`mneme-impdialog` 与读数复用 `mneme-sharebody`/`mneme-sharelist`/`mneme-sharow*`）
- Modify: `test/client-share.test.js`（追加两条锁）

**Interfaces:**
- Consumes: `POST /api/dsh-mneme/receive`（`{pack}` 干跑 / `{pack, confirm: true}` 写库，答复八键见 §Interfaces）；`apiFetch`；D2 的类 `mneme-sharebody`/`mneme-sharelist`/`mneme-sharow`/`mneme-sharowtitle`/`mneme-sharowreason`；已存在的 `memory.explorer.importCancel`/`importing`/`importNoFile`。
- Produces: `ReceiveDialog({ t, onClose, onImported })`、`ReceiveSummary({ t, d })`。D4 不用这两个组件。

- [ ] **Step 1: 追加失败的锁**

`test/client-share.test.js` 末尾加——

```js
// docs/SHARE.md「车道 D 三笔账」之二：干跑与真导入的答复同形状，区别只有
// withDryRun 加的 dry_run 那一格。防的回归形态：界面按「我有没有发 confirm」推断写了
// 没有——同一件事写两处，改一处就出现「其实没写、却说写了」。
test("the receive dialog reads dry_run instead of inferring from its own button", () => {
  assert.ok(clientSource.includes('apiFetch("/api/dsh-mneme/receive"'),
    "入库只许走这一枪（apiFetch 带 token 注入）");
  assert.ok(clientSource.includes("post({ pack })"), "预览那一发不带 confirm——缺省即干跑");
  assert.ok(clientSource.includes("post({ pack, confirm: true })"),
    "真写的那一发必须带 confirm 这个真值，其他形状服务端都不认");
  assert.ok(clientSource.includes('d.dry_run === false ? "memory.explorer.receiveDidCreate"'),
    "「写进去了」这句只能由答复自己说——钉的是那个三元式本身，不是六个字面量都在");
  assert.ok(clientSource.includes("result.dry_run !== false"),
    "确认之后仍回干跑时要单独说「没有写库」，不许沉默，也不许挂在预览那一支上");
  assert.ok(clientSource.includes('"memory.explorer.receiveStillDry"'),
    "那一格要有自己的文案");
  // 第二个旋钮一概不认：收侧只认 confirm（spec §5——reclaim 的 body 里就带 dryRun，
  // 手熟的人会顺手发来，把它读成「要写」等于替她点头）。
  // **切片而不是全文**：本文件里 reclaim/VACUUM 那一发合法地发 `dryRun: false, confirm: true`，
  // 那是 reclaim 的形状不是 receive 的。全文反锁会一上来就红；谁把它「修」成全文锁，
  // 就等于给 reclaim 那颗键定罪。所以按函数名切区段，并且**两个锚点都要验**：
  // 结束锚点丢了的时候 indexOf 返回 -1，切片会一路长到文件尾而不是塌成空——
  // 那时候这条锁看似更严，实际悄悄开始管整个文件（而 ReceiveDialog 之后今天没有 dryRun，
  // 它会空过）。两头都钉住，锚点漂移只会红得明白。
  const receiveStart = clientSource.indexOf("function ReceiveDialog(");
  const receiveEnd = clientSource.indexOf("// #386 第 5 条", receiveStart);
  assert.ok(receiveStart > 0 && receiveEnd > receiveStart,
    "ReceiveDialog 的起止锚点都要在，且顺序对——否则这条锁在管的东西和它说的不是一件");
  const receiveRegion = clientSource.slice(receiveStart, receiveEnd);
  assert.ok(receiveRegion.length > 800, "ReceiveDialog 的区段短得不像话，先修锚再谈锁");
  assert.equal(receiveRegion.includes("dryRun"), false,
    "收侧不许发 dryRun——唯一的入口是 confirm");
});

// 三笔账之三：title_conflicts 是 advisory 读数，只对「本轮真正会新建的那些」判过，
// 重吃同一个包时恒空。防的回归：文案写成「现在没有冲突」。
test("the receive preview keeps the advisory reading honest", () => {
  assert.ok(clientSource.includes("d.title_conflicts"), "撞名清单要显示");
  assert.ok(clientSource.includes('"memory.explorer.receiveConflicts"'));
  // 钉的是**文案**而不是注释：解释性的话必须能写「这不等于没有冲突」来提醒读者，连注释一起
  // ban 等于把警告本身禁掉（本轮实装时撞上过：新注释里的「没有撞名」先红的是这条锁）。
  // 真正会伤人的是屏上那一句，所以只扫非注释行。
  const copyLines = clientSource.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
  assert.equal(/现在没有冲突|没有撞名|无冲突|no conflicts|no title clashes/i.test(copyLines), false,
    "不许出现「没有冲突」这类绝对断言（清单为空只说明本轮没有新的要报）");
  // 先预览才允许确认：干跑是必经的一站，不是可选装饰。
  assert.ok(clientSource.includes("disabled: busy || !preview"),
    "确认按钮在拿到预览之前必须 disabled");
  // advisory 读数的分母要说出来，否则「清单为空」与「什么也没比」在屏上长一个样。
  // 注意它是**包内条数**而不是「比过了几条」，所以文案只许说「包内 N 条」。
  assert.ok(clientSource.includes("d.conflicts_checked"),
    "要把服务端给的包内条数显示出来");
  assert.ok(clientSource.includes('t("memory.explorer.receivePackCount")'),
    "那一行要有自己的渲染点，不是只在字典里躺着");
});

// D3 评审裁定补的锁：两种「按了没反应」的形态。
//   a) 200 但正文读不出——曾经一路 return null，调用方把它读成「屏上已有提示」，
//      于是确认那一发悄悄没走完，而上一块的「将新建 N 条」还留在屏上；
//   b) 预览还在飞的时候又能选一个文件——飞回来的数字说的是前一个包，确认写的却是后一个。
test("the receive dialog never goes silent, and never lets a superseded preview drive the write", () => {
  assert.ok(clientSource.includes('if (!d || typeof d !== "object") {'),
    "200 但没有可读正文也要 setErr，不许 return null 装成「已经处理过了」");
  assert.ok(clientSource.includes("disabled: busy, onClick: () => fileRef.current?.click()"),
    "预览/确认在飞的时候不许再选文件（那一块数字属于上一个包）");
  assert.ok(clientSource.includes('typeof parsed !== "object"'),
    "解得出 JSON 但不是对象，是另一种失败，得有它自己的一句话");
  assert.ok(clientSource.includes('e.target.value = ""'),
    "选完清空控件值：否则改过的同一个文件再选一次不发 change，面板拿着旧包预览");
});
```

- [ ] **Step 2: 跑测试确认全红**

Run: `node --test test/client-share.test.js`
Expected: 新增三条 FAIL——`the receive dialog reads dry_run…` 红在第一句（`apiFetch("/api/dsh-mneme/receive"` 还不存在），`the receive preview…` 红在 `d.title_conflicts`，`the receive dialog never goes silent…` 红在 `if (!d || typeof d !== "object")`。原 5 条保持绿。实装之后如果那条**起止锚点**断言红，说明 `ReceiveDialog` 插到了 `// #386 第 5 条` 那个锚点**之后**，Step 4 的位置错了，先修位置再谈锁。

- [ ] **Step 3: 加两份字典的新键**

zh，紧跟 D2 插入的 `"memory.explorer.shareDownload": "下载包文件",` 之后——

```js
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
```

en，紧跟 D2 插入的 `"memory.explorer.shareDownload": "Download pack file",` 之后——

```js
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
```

- [ ] **Step 4: 实现两个组件**

紧跟 D2 的 `ShareDialog` 收尾 `}` 之后插入——

```js
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
        conflicts.length > 0 && h("div", { className: "mneme-sharelist" },
          conflicts.map((c, i) => h("div", { key: `${c.type}-${i}`, className: "mneme-sharow" },
            h("span", { className: "mneme-sharowtitle" }, c.title || ""),
            h("span", { className: "mneme-sharowreason" }, typeLabel(t, c.type))))),
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
          if (d.dry_run === false) onImported();
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
```

- [ ] **Step 5: 接第二个入口**

D2 加过 `shareOpen` 的那一行之后加状态位——

```js
      const [receiveOpen, setReceiveOpen] = useState(false);
```

「⋯」按钮的 `onClick`（D2 已改成带 `setShareOpen(false)` 的那一行）末尾再补一项——

```js
                onClick: () => { setMenuOpen(!menuOpen); setImportOpen(false); setCreateOpen(false); setShareOpen(false); setReceiveOpen(false); }
```

D2 加的那一项 `t("memory.explorer.sharePack"))` 之后加第二项——

```js
                h("button", { type: "button", role: "menuitem", onClick: () => { setReceiveOpen(true); setMenuOpen(false); } },
                  t("memory.explorer.receivePack")),
```

条件渲染块里，D2 的 `shareOpen && h(ShareDialog, …)` 之后加——

```js
              receiveOpen && h(ReceiveDialog, {
                t,
                onClose: () => setReceiveOpen(false),
                onImported: () => setReloadKey((k) => k + 1)
              }),
```

- [ ] **Step 6: 跑锁 + 全局锁 + 全套**

```bash
cd dsh-mneme
node --test test/client-share.test.js test/client.test.js test/contrast.test.js
npm test
```
Expected: `client-share` 8/8 绿（本任务 +3）。注意 `dryRun` 那条反锁只切 `ReceiveDialog` 的区段——全文反锁会撞上本文件里 reclaim/VACUUM 那一发合法的 `dryRun: false`，那条不是本车道的债；双语全局锁绿；全套只增本任务 3 条。

- [ ] **Step 7: 提交**

```bash
git add dsh-mneme/lib/client.js dsh-mneme/test/client-share.test.js
git commit -m "feat(panel): receive dialog previews the pack before it writes the library"
```

**自查（D3）**：`result.dry_run !== false` 那一行是不是「没有写库」的唯一出口？确认按钮在没预览时真的 disabled？`setBusy(false)` 是不是在 `post` 的两条分支里都执行（失败与成功都要放行下一发）？有没有把「包里一条不合格就整包拒」这类判据在面板里重述？

---

### Task D4: 外来区（筛选 chip + 来源徽标 + 抽屉「收起这个包」）

**Files:**
- Modify: `lib/client.js`（字典两份 + `ForeignBadge` + `TypeRowList` + CSS 一条 + `filterQS` + 外来 chip（只管浏览态：搜索态不许**开启**，已开着时永远许关掉，并有一行看得见的说明）+ 卡片与时间线两处徽标 + `MemoryDrawer` 的 meta 行与动作区 + 父级 `onUndone`。顺带把接收弹层 `ReceiveSummary` 里那份手写的撞名清单换成 `TypeRowList`（同一形状只留一份）。`visible` 那一行**不动**，理由在 Step 6）
- Modify: `test/client-share.test.js`（追加两条锁）

**Interfaces:**
- Consumes: `GET /api/dsh-mneme/list?source=imported`（D1 已锁）；行上的 `source`、`tags`、`share_pack_id`（D1）；`POST /api/dsh-mneme/receive/undo`（`{packId}` 干跑 / `{packId, confirm: true}` 物删，答复 `{pack_id, deleted, sample, dry_run}`）；既有的 `setToastMsg`、`setReloadKey`、`setSelectedId`（`lib/client.js:6585-6586` 那条 toast 先例）。
- Produces: `ForeignBadge({ m, t })`；`MemoryDrawer` 的新 prop `onUndone(n)`；状态位 `foreignOnly`。

- [ ] **Step 1: 追加失败的锁**

`test/client-share.test.js` 末尾加——

```js
// 外来区三件：筛选、来源徽标、整包退出。锁的是「每件事都挂在一个服务端真值上」，
// 而不是挂在一个界面自己造出来的判断上。
test("the foreign filter is a browse-state server filter and stays inert while searching", () => {
  assert.ok(clientSource.includes('foreignOnly ? "&source=imported" : ""'),
    "浏览态交给服务端筛：分页与 total 同口径，本地筛会切掉尾巴");
  // **搜索态不做本地过滤**（本轮扫描改掉的裁定，不是漏做）：/search 那张 DTO 的 source 是
  // 召回渠道（keyword/vector/bm25，src/service.js:939），行的 provenance 被盖掉，「这条是不是
  // 外来的」在这张 DTO 上压根读不出来。宁可让 chip 在搜索态明确失效并说清原因，也不要按一个
  // 假信号筛——test/share-foreign-rows.test.js 的第三条用例锁着这个事实。
  assert.ok(clientSource.includes("disabled: !!query.trim() && !foreignOnly"),
    "有搜索词时不许**开启**外来筛选（按下无效），但任何时候都许关掉——只给 disabled 会把她锁在一个她解不开的状态里");
  assert.ok(clientSource.includes('"memory.explorer.filterForeignSearchHint"'),
    "失效要有自己的文案，不能只靠 disabled 让人猜");
  assert.equal(clientSource.includes('(!foreignOnly || m.source'), false,
    "不许退回「搜索态本地按 source 筛」那条假信号");
  // 服务端不吃 source 这件事，不许用「给 search 的 URL 也拼一个键」的方式绕过去：
  // 那条路由压根不读它（src/api.js 的 search handler 里没有 source 这一档），拼上去
  // 只会造出一个「看起来筛过了、其实没有」的形状。全文件只许有一处拼这个参数。
  assert.equal(clientSource.split("&source=imported").length - 1, 1,
    "只有浏览态那一条 URL 会拼 source=imported");
});

// 来源徽标与撤销都按服务端给的真值门控：徽标认 source + from- 标签，撤销认 pack_id。
test("the foreign badge and the withdraw action gate on server truth, not on guesswork", () => {
  assert.ok(clientSource.includes('m.source === "imported"'),
    "徽标先认 source，再认标签：人手工打的 from-* 标签不算外来行");
  assert.ok(clientSource.includes('startsWith("from-")'),
    "别名读数就是 importedTagFor 打的那条标签，面板不另找地方读别名");
  assert.ok(clientSource.includes("memory.share_pack_id &&"),
    "撤销按钮按包号自门控：/search 的 DTO 不带这一格，那种行按不了（已知代价，docs/SHARE.md 记着）");
  assert.ok(clientSource.includes('apiFetch("/api/dsh-mneme/receive/undo"'),
    "整包退出只许走这一枪");
  assert.ok(clientSource.includes("{ packId: memory.share_pack_id, confirm: true }"),
    "删除那一发要带 confirm 真值，且 packId 只从行上取");
  assert.ok(clientSource.includes("d.dry_run === false"),
    "撤成功的读数同样只由答复的 dry_run 说");
  assert.ok(clientSource.includes("undoPreview.sample"),
    "删除前的确认要带前缀样例（答复的 sample 最多 20 条，deleted 才是全量）");
  // 撤是**物删**（docs/SHARE.md：归档行会占住 UNIQUE 位，撤了导不回来），文案不许写「归档」。
  assert.equal(/memory\.explorer\.undoPack[A-Za-z]*"\s*:\s*"[^"]*(归档|archive)/i.test(clientSource), false,
    "撤销的文案不许出现「归档」——它是物理删除");
  // 删除那一发的成功判据**只能是答复的 dry_run**。`confirm && d.dry_run === false` 那种合取
  // 读的是「我刚才点的是哪一颗」：确认回来一个 dry_run:true 时会把预览重画一遍当作没发生——
  // 接收弹层那一侧修过同一个形状，撤销这条更硬的路不许退回去。
  assert.ok(clientSource.includes("if (d.dry_run === false) onUndone(d.deleted ?? 0)"),
    "撤销的成功判据只看答复");
  assert.equal(clientSource.includes("confirm && d.dry_run === false"), false,
    "不许再出现按按钮形状推断的那种合取");
  assert.ok(clientSource.includes('t("memory.explorer.undoPackGone")'),
    "包已不在本库时要说那一句，而不是给一颗「确认删除 0 条」的键");
  // 同一形状只许有一份：抽屉的退出清单与接收弹层的撞名清单都是 {type,title} 两列。
  assert.ok(clientSource.includes("TypeRowList({ t, rows: undoPreview.sample })"),
    "清单形状走公共组件，不许第三份手写 .map");
  assert.ok(clientSource.includes('foreignOnly && !!query.trim() && h("div"'),
    "「搜索时不按」要有一行看得见的说明，不能只挂在 disabled 的 title 上");
});
```

- [ ] **Step 2: 跑测试确认新的两条红**

Run: `node --test test/client-share.test.js`
Expected: 新增两条 FAIL（找不到 `foreignOnly` 那几处串），前面 8 条保持绿。

- [ ] **Step 3: 加两份字典的新键**

zh，紧跟 D3 的 `"memory.explorer.receiveStillDry": "没有写库：这一枪仍是干跑",` 之后——

```js
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
        "memory.explorer.undoPackStillDry": "没有删除：这一枪仍是干跑",
        "memory.explorer.undoPackGone": "这个包在本库里已经没有行了",
```

en，紧跟 D3 的 `"memory.explorer.receiveStillDry": "Nothing was written: that call stayed dry",` 之后——

```js
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
        "memory.explorer.undoPackStillDry": "Nothing was deleted: that call stayed dry",
        "memory.explorer.undoPackGone": "That pack has no rows left in this store",
```

- [ ] **Step 4: 加 CSS（来源徽标）**

D2 那段 CSS 之后追加一行（`--mneme-ok` 与 `.mneme-saved` 同源，已在对比度锁下过了浅/深两主题）——

```js
      // 外来徽标：只有文字色与描边，**不给底色**。`.mneme-badge--scope` / `--frozen` 那两类
      // 有自己的 10–12% 色晕，而 `test/contrast.test.js` 的正文对比度是按**该条规则自己的
      // 背景**合成的：`--mneme-ok` 在画布上是 4.62，铺上 12% 绿晕就掉到 4.17（<4.5）。
      // 与其为它造一个新语义令牌或改用别的色，不如让这一颗走无晕的形状——来源读数本来就在
      // 文字里（`from-<别名>`），不靠底色说话。
      ".mneme-badge--foreign{color:var(--mneme-ok);border:1px solid color-mix(in srgb,var(--mneme-ok) 34%,transparent)}",
```

- [ ] **Step 5: 实现 ForeignBadge**

紧跟 `const ScopeBadge = ({ m, t }) => { … };` 的收尾 `};` 之后插入——

```js
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
     * 别名不单独存列：`importedTagFor` 打的那条 `from-<别名>` 标签就是唯一读数，
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
```

- [ ] **Step 6: 筛选状态位、查询串与两处过滤**

`const [archivedOnly, setArchivedOnly] = useState(false);` 之后加——

```js
      const [foreignOnly, setForeignOnly] = useState(false); // 只看外来行（source=imported）
```

`filterQS` 现在是（`:6371-6375`）

```js
      const filterQS = (type === "all" ? "" : `&type=${encodeURIComponent(type)}`)
        + (minImp ? `&minImportance=${minImp}` : "")
        + (dateFromIso ? `&updatedFrom=${encodeURIComponent(dateFromIso)}` : "")
        + (depositedOnly ? "&deposited=only" : "")
        + (archivedOnly ? "&archived=only" : "");
```

整段换成（注意分号随最后一行走：`archivedOnly` 那行的 `;` 必须挪到新行的末尾，否则是语法错）——

```js
      const filterQS = (type === "all" ? "" : `&type=${encodeURIComponent(type)}`)
        + (minImp ? `&minImportance=${minImp}` : "")
        + (dateFromIso ? `&updatedFrom=${encodeURIComponent(dateFromIso)}` : "")
        + (depositedOnly ? "&deposited=only" : "")
        + (archivedOnly ? "&archived=only" : "")
        + (foreignOnly ? "&source=imported" : "");
```

`visible`（`:6489-6491`）**保持原样，一行都不改**：

```js
      const visible = remoteItems
        ? remoteItems.filter((m) => type === "all" || m.type === type)
        : items;
```

理由（这条是本轮扫描改掉的裁定）：搜索态那张 DTO 的 `source` 是召回渠道而不是行来源
（`src/service.js:939` 给每条候选盖 `source: "keyword"|"vector"|"bm25"`），按它筛等于按一个
假信号筛——`m.source === "imported"` 在搜索结果里恒不成立，「外来 chip 亮着却筛空/筛不空」
正是最难看的那种错。所以外来筛选只管**浏览态**；搜索态那颗 chip 不许被开启，但已经开着时永远许关掉（Step 7）。

- [ ] **Step 7: chip 与两处徽标**

在「已归档」那颗 chip 之后（`}, t("memory.explorer.filterArchived")),` 那一行之后）加——

```js
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
                }, t("memory.explorer.filterForeignSearchHint"))
```

卡片视图的 `.mneme-cardfoot` 里，`h(ScopeBadge, { m, t }),` 之后加一行（`:6835` 附近）——

```js
                          h(ForeignBadge, { m, t }),
```

时间线视图同样位置（第二处 `h(ScopeBadge, { m, t })`，`:6898` 附近）之后加——

```js
                                  h(ForeignBadge, { m, t }),
```

- [ ] **Step 8: 抽屉的包号行与两步撤销**

`MemoryDrawer` 的签名（`:5891`）加最后一个 prop——

```js
    function MemoryDrawer({ t, memory, conflict, deleting, deleteError, onClose, onDelete, onSaved, onUndone }) {
```

状态位（`const [entities, setEntities] = useState(null);` 之后）加——

```js
      // 整包退出的两段：先干跑清点（点按钮那一发），再确认物删。撤是**物理删除**不是归档
      // （归档行仍占 share_external_id 的 UNIQUE 位，撤了会导不回来，理由在
      // src/share-import.js 的 deleteSharePack），所以这里比删除那条路多一站清点。
      const [undoPreview, setUndoPreview] = useState(null);
      const [undoBusy, setUndoBusy] = useState(false);
      const [undoError, setUndoError] = useState(false);
      // 确认那一发却回干跑时唯一出声的一格（见 undoPack 的注释）。
      const [undoStillDry, setUndoStillDry] = useState(false);
```

方法（`const postUpdate = (patch, opts) => { … };` 之后）加——

```js
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
```

meta 行（「标签」那一行 `Array.isArray(memory.tags) && …` **之前**）加——

```js
            // 包号给人核对：与 `dsh-mneme undo-share <包文件>` 用的是同一个 pack_id，
            // 两条路撤的是同一批行。
            memory.share_pack_id && h(react.Fragment, null,
              h("span", { className: "mneme-dmetakey" }, t("memory.explorer.foreignPack")),
              h("span", { className: "mneme-dmetaval", title: memory.share_pack_id }, memory.share_pack_id)),
```

动作区（非编辑那一支，紧跟 `deleteError && h(...)` 那条之后、该 Fragment 收尾 `)` 之前）加——

```js
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
                        h("button", { type: "button", className: "mneme-btn", disabled: undoBusy, onClick: () => setUndoPreview(null) },
                          t("memory.explorer.cancel"))
                      )
                    : h("button", { type: "button", className: "mneme-btn mneme-btndanger", disabled: undoBusy, onClick: () => undoPack(false) },
                        t("memory.explorer.undoPack"))),
                // 撤销同样是往返一秒量级的枪（清点那一发与接收侧的干跑走的是同一档耗时）：
                // 只把键按灰而不说在忙，看起来就像没反应。
                undoBusy && h("span", { style: { fontSize: 12 } }, t("memory.explorer.importing")),
                undoStillDry && h("span", { style: { fontSize: 12, color: "var(--mneme-danger)" } },
                  t("memory.explorer.undoPackStillDry")),
                undoError && h("span", { style: { fontSize: 12, color: "var(--mneme-danger)" } },
                  t("memory.explorer.undoPackFailed")),
```

> 插入位置很关键：这一段必须落在 `h("div", { className: "mneme-dactions" }, …)` 的**非编辑那一支 Fragment 内**（与 `confirmDelete ? … : …` 同级），否则编辑态下也会冒出一颗撤销按钮。Step 9 的 `node --check` 之外，肉眼核一遍这一支的括号层级。

- [ ] **Step 9: 父级接线**

`h(MemoryDrawer, { … onSaved: applyMemoryUpdate })`（`:6919-6929`）里，在 `onSaved` 之后加——

```js
        onUndone: (n) => {
          // 撤掉的是整包：选中那一行已经不存在，关抽屉 + 刷新列表 + 一句 toast
          // （toast 形状照详情抽屉里 restored 那一条的先例，不带行号免得漂）。
          setSelectedId(null);
          setReloadKey((k) => k + 1);
          setToastMsg(t("memory.explorer.undoPackDone").replace("{n}", String(n)));
          setTimeout(() => setToastMsg(""), 2500);
        }
```

- [ ] **Step 10: 跑锁 + 全局锁 + 语法检查 + 全套**

```bash
cd dsh-mneme
node --test test/client-share.test.js test/client.test.js test/contrast.test.js
node --check lib/client.js
npm test
```
Expected: `client-share` 10/10 绿；`client.test.js` 双语全局锁绿（新键 zh/en 各一次）；`contrast.test.js` 绿（`.mneme-badge--foreign` 的 `color:var(--mneme-ok)` 与 `.mneme-saved` 同令牌，两主题都已在既有快照下合规）；`node --check` 无输出（括号层级没坏）。

- [ ] **Step 11: 提交**

```bash
git add dsh-mneme/lib/client.js dsh-mneme/test/client-share.test.js
git commit -m "feat(panel): foreign area filter, source badge, and per-pack withdrawal"
```

**自查（D4）**：徽标在没有 `from-` 标签的外来行上是不是安静地不出现（不显示「来自 undefined」）？`foreignOnly` 与 `archivedOnly` 同时开时是否可能互斥到恒空——若是，服务端 `source=imported` 与 `archived=only` 是两个独立开关（都在 `/api/dsh-mneme/list` 那一个 handler 里解析，不带行号免得漂），互斥结果恒空是**读数**而不是 bug，不许在面板里偷偷关掉其中一个；`undoPack(true)` 成功后有没有走 `onUndone`（关抽屉 + 刷新）而不是留在原地？

---

### Task D5: 文档扫面与车道收口

改功能就必须当轮扫文档（她的既有纪律，AGENTS.md 与 `docs/SHARE.md` 都记着「表层改动当轮改文档」）。本任务只改文档，零代码。

**Files:**
- Modify: `dsh-mneme/docs/SHARE.md`（`:8`、`:176`、`:298`、`:419-434`，并在「用法」那节加一小节）
- Modify: `dsh-mneme/README.md`（`### 记忆库主区视图与记忆图谱` 末尾，现 `:245-255`）
- Modify: `AGENTS.md`（仓库根 `:49` 那行末尾）

- [ ] **Step 1: 找齐所有「车道 D」欠账的落点**

```bash
cd dsh-mneme
grep -n "车道 D" docs/SHARE.md ../AGENTS.md ../README.md README.md 2>/dev/null
```
Expected: `docs/SHARE.md` 五处（`:8`、`:176`、`:298`、`:419`、`:424-425`）+ `AGENTS.md:49`。逐处过一遍，行号会漂，按文本定位。

- [ ] **Step 2: docs/SHARE.md 的「用法」加面板一小节**

在 `## 用法` 那节的末尾（CLI 示例之后）插入——

```markdown
### 面板（车道 D）

不想开命令行的人在记忆面板的「⋯」菜单里做同样三步：**分享记忆包…** / **导入分享包…** / 外来区筛选。

- **分享**：填别名（可空）、可选「只发这一类」，点「生成」。**报告先于下载**——
  进包条数、同键折叠数、六个跳过原因的计数、可展开的跳过清单都摆上屏之后，才出现
  「下载包文件」那颗键。`included` 是**实际发出**的条数，够格进包的是 `included + deduped`
  两个数同屏（包内折叠，见上面「`report` 只有四个键」那段）。超 3 MiB 水位时服务端回 413，
  面板显示同样的报告 + 字节数 + 那句提示；那句提示是 `--type`/`--tag` 的 CLI 口吻
  （`src/share-http.js` 的 `SHARE_ERROR_HINT` 只许有一份，面板不改写），按 tag 分批仍只能
  在命令行做。`included` 为 0 时不给下载——那种包对面吃的是 `empty-pack`（400）。
- **接收**：选包文件 → 先干跑（不带 `confirm`）→ 看「将新建 N 条 / 已在库中 M 条 /
  正文相同 U 条 / 撞名 K 条」→ 点「确认导入」才写库。**确认那颗键在拿到预览之前是灰的**。
  「写进去了」这句只由答复的 `dry_run` 说，不按按钮状态推；撞名是 advisory 读数
  （只对「本轮真正会新建的那些」判过），所以清单为空不等于「没有冲突」。
- **外来区**：工具条「外来」chip 走服务端的 `source=imported` 精确筛选（**只管浏览态**：
  有搜索词时这颗键不许被开启（已经开着的话永远许关掉），并说明为什么——搜索结果里没有可用的来源读数，见下面「已知代价」第一条）；
  行上是
  `from-<别名>` 徽标（读数就是 `importedTagFor` 打的那条标签，库里没有单独的别名列）；
  抽屉里显示所属 `pack_id` 并给「收起这个包」，**两段**：先干跑清点条数（并列出 `sample`
  里前 20 条样例标题，让人核对「要收起的到底是哪一批」；`deleted` 才是全量，两个数并发下
  可以差一条，谁也不是对方的依据），再确认**物删**
  （不归档的理由见上面「整包退出」那段）。
  已知不对称：搜索态的行不带 `pack_id`（`/search` 的 DTO 不含这一格），所以在搜索态
  按不了撤销——清掉搜索词、按「外来」chip 再撤。
  入库是逐条查 + 逐条写（实测 494 µs/条，单批千余条一秒开外），所以两发都有 loading。
```

- [ ] **Step 3: docs/SHARE.md 的四句旧话改成现在的事实**

`:8` 那句「缺的只剩面板按钮（车道 D）——今天这三步……」——把「缺的只剩面板按钮」整段改写为：CLI 与面板**两条路都在**，同一批三件事（出包 / 入库 / 整包退出），同一套服务端判据；并保留原文里「三步各是什么」的描述，只删掉「缺按钮」那半句。

`:298` 那条「给人按的按钮旁边要有 loading，这条是给车道 D 的账」——把「这条是给车道 D 的账」改为「车道 D 的预览与确认两发都挂 `busy`，见上面『面板』那一节」。

`:176` 那句把「（车道 D）与 `undo-share` 都已经留了人类的位置」改为「面板的『收起这个包』与 `undo-share` 都留了人类的位置」。

`:419-425` 那段「**面板（车道 D）三件**：……按得动的那颗键属于车道 D……车道 D 落地时要一起清的三笔账」——整段重写为「**面板已落地（车道 D）**」，三笔账逐条写成**已闭**并各指一次证据：① 两个数同屏 → `test/client-share.test.js` 的 `the report separates what shipped from what qualified`；② `dry_run` 只由答复说 → `the receive dialog reads dry_run instead of inferring from its own button`；③ 撞名文案的 advisory 口径 → `the receive preview keeps the advisory reading honest`。然后**新增两条本车道留下的已知账**（不许写成「全部做完」）：

```markdown
**车道 D 留下的两格已知代价**（都是刻意的，不是漏做）：

1. **搜索态三件都做不了（筛选、徽标、撤销）**：`pack_id` 只从 `/api/dsh-mneme/list` 的面板行
   下发（`src/api.js` 那个 items 的 map），而 `/search` 的 DTO 里 `source` 是**召回渠道**
   （`keyword`/`vector`/`bm25`，`src/service.js:939`）而不是行来源——`searchMemories` 给每条候选
   盖上渠道时把 provenance 覆盖了，所以「这条是不是外来的」在那张 DTO 上读不出来。
   于是：外来 chip 有搜索词时不许被开启（已开着时永远许关掉，不把她锁在一个解不开的状态里；带自己的文案说明原因，不假装筛过）、`from-<别名>` 徽标在搜索态
   不出现、抽屉里也没有「收起这个包」。绕法一律是**清掉搜索词回浏览态**。
   这两个事实由 `test/share-foreign-rows.test.js` 的第三条用例钉着。要真修的是召回侧那个字段的
   命名（它同时让搜索结果那张卡片脚上显示 `keyword` 而不是行来源——既存症状，本车道不动），
   那一刀牵动 `recall_runs` 的回执形状，届时长出来的是第四个车道。
2. **面板只做 `type` 分批，不做 `tag` 分批**：`tag` 是自由文本，错一个字母就静默发 0 条，
   而 413 的提示语是服务端那一份（`SHARE_ERROR_HINT`），写着 `--type`/`--tag` 的 CLI 口吻。
   面板不改写它（同一份错误文案只许有一份），所以那句话在面板里读起来像在指命令行。
```

- [ ] **Step 4: dsh-mneme/README.md 的面板条目**

在 `### 记忆库主区视图与记忆图谱 🕸️（v0.5.0）` 那一节的最后一行（现在是 `图谱 ↔ 记忆双向互跳：…`）之后加——

```markdown
- **分享包三步（v0.9.x，车道 D）**：「⋯」菜单里的**分享记忆包…**（报告先于下载：进包条数、同键折叠、六个跳过原因、可展开的跳过清单，超水位回 413 同屏）与**导入分享包…**（选文件 → 干跑预览将新建几条 / 撞名几条 → 确认才写库），外来行带 `from-<别名>` 徽标、工具条「外来」chip 按 `source=imported` 服务端筛、抽屉「收起这个包」两段式整包退出（先清点后物删）。口径与判据一条都不在面板里复述——出包在 `src/share.js`、入包闸门在 `src/share-import.js`、协议层在 `src/share-http.js`，细则与实测见 [docs/SHARE.md](docs/SHARE.md)
```

（版本号只写「v0.9.x」这一档占位，**不改 `package.json`、不写 CHANGELOG**——发版号由 `release-prep.yml` 机械写，CHANGELOG 由她补，见 AGENTS.md 与本仓发版流程。）

- [ ] **Step 5: AGENTS.md 模块地图那一行**

仓库根 `AGENTS.md:49`「分享包（出与收）」那行的末尾「面板按钮属车道 D」替换为——

```markdown
面板三件（分享弹层 / 接收弹层 / 外来区筛选与整包退出）在 `lib/client.js`，一条判据都不在那里复述
```

并在同一行 `src/share-import.js` 的括号说明里保持既有文字不动（只换最后那半句）。

- [ ] **Step 6: 核一遍文档没有说谎**

```bash
cd dsh-mneme
grep -n "车道 D" docs/SHARE.md ../AGENTS.md README.md | head -20
node --test test/share-foreign-rows.test.js test/client-share.test.js test/client.test.js test/security-doc.test.js
npm test
```
Expected: 剩下的「车道 D」字样只应是**历史与已知代价**的表述（「车道 D 留下的两格已知代价」「车道 D 落地时」这类），不该再有「还没做 / 缺按钮 / 这是给车道 D 的账」；测试全绿；全套相对 D4 基线**不增用例**（本任务零代码）。

- [ ] **Step 7: 提交**

```bash
git add dsh-mneme/docs/SHARE.md dsh-mneme/README.md AGENTS.md
git commit -m "docs(share): the panel path is live, with the two known costs"
```

---

## 收尾（车道 owner 自己做，不派 subagent）

1. **基线核对**：`cd dsh-mneme && npm test` → 期望 `tests 2411 / pass 2410 / fail 0 / skipped 1`（即相对车道 D 之前的 `2398/2397` 增 **13** 条：D1 3 + D2 5 + D3 3 + D4 2，D5 零代码）。数字对不上时先数新增用例，别调断言。
2. **src↔lib 平价**：只有 D1 动了 `src/`。`node scripts/check-sync.js` 必须通过；`git log --stat` 里 D1 那一提交必须同时含 `src/api.js` 与 `lib/api.js`。
3. **提交卫生**：`for c in $(git log --format=%H e9889bc..HEAD); do git log -1 --format=%B $c | grep -i -e "co-authored" -e "generated" && echo "BAD $c"; done` 应无输出。
4. **台账**：`.superpowers/sdd/2026-10-23-memory-share-pack-lane-d/progress.md` 里逐条记下——本车道的三条线（§「车道 D 的三条线」）、两格已知代价（D5 写进 `docs/SHARE.md` 的那两条）、以及「面板没能在浏览器里验，锁的全是源码形状」。
5. **交给她的两件事**（不许代劳）：
   - **relink 插件后目测四步**：出包（改别名/改类型看报告变化）→ 超水位（整库出包应看到 413 + 报告 + 无下载键）→ 收包（干跑数字与确认后的 `created` 对齐，重吃同一个包 `created=0`）→ 外来区（chip 筛出、徽标显示、抽屉两段撤销、撤后同包可重导）。这是 `docs/SHARE.md:442-445` 那条「活体端到端还没跑过」的正解，车道 D 让它在**面板**这一侧也欠一次实测。
   - **git 处置**：本地 `main` 现在又比 `origin/main` 多出这几个提交（仍 behind 11）。她此前选「保持现状」，本车道不 push、不 rebase，只报一次数。

## 后续刀（不属于车道 D，写在这里免得丢）

- `index` 透传那一刀：`ShareImportError` → `receiveReply` → 面板/CLI 的 `failHttp`，**同一刀必须补上 `service.transaction()` 不可重入的钉子**（`docs/SHARE.md:451-457` 那条已申报的缺口：它是收侧「中途撞 UNIQUE → 整笔回滚」那把锁的承重墙，却没有自己的锁）。
- 405 的 `Allow` 头（A6 台账）：要补就得给 `api-standalone.js` 的 `sendJson` 加可选 headers 参数，那是那张脸所有路由的公共签名，独立判断。
- 车道 C 报告里那条「面板用例 `GET on the share route is not an open read` 收成 405/404 都接受」——车道 D 之后两面都已锁死 405，是否把面板那条也收紧，归车道 owner 判。
