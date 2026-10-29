# 记忆分享包 车道 A + B 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 dsh-mneme 能把本机记忆打成一个脱敏的分享包文件（车道 A），并先把「外来记忆绝不被人家的巩固改写」这条性质挂到全部行池上（车道 B）。

**Architecture:** 两个新模块 —— `src/share.js` 是不碰 store、不碰 http 的纯核心（取行口径 + 两类脱敏 + 序列化 + 体积水位）；`src/share-http.js` 是宿主内面板路由与 standalone Bearer 数据面共用的唯一一份解析与答复（照 `src/reclaim-http.js` 的 #411 先例）。车道 B 新增 `src/memory-source.js` 提供一个谓词，挂在 `saveWithDedupe` 的汇流口和九处行池上。

**Tech Stack:** Node 22/24，ESM（`package.json` 的 `"type": "module"`），`node:test` + `node:assert/strict`，测试从 `../src/*.js` 导入（`lib/` 由 `npm run sync` 生成，lib-smoke 测试负责抓未同步）。

**Spec:** [docs/specs/2026-10-22-memory-share-pack-design.md](../specs/2026-10-22-memory-share-pack-design.md) —— 本计划按它论证，执行时两份一起读。**车道 C（入库与整包退出）和 D（面板）不在本计划内**：它们要等 A 落地后的 spec §12 实测数（真库条数 → 包体积）才能定水位文案与分批口径。

## Global Constraints

每一条都隐含作用于每个任务，值从 spec 与 AGENTS.md 逐字搬来：

- 所有路径相对包目录 `dsh-mneme/`；`lib/` 是 `npm run sync` 的产物，**禁止手改**（唯一例外是手写的 `lib/client.js`，本计划不碰它）。
- 任何改了 `src/` 的任务，收尾必须 `npm run sync`。
- **不加任何新配置键**：`src/settings.js` 白名单不动，`test/api.test.js:753` 的 `assert.equal(Object.keys(data.effective).length, 103)` 旗标计数锁不动（spec §11）。
- 新路由必须声明 `policy`（`open` / `token` / `token-write`），漏声明或复用路径在装配期直接抛错（AGENTS.md 纪律 9）。`policy` 只对宿主内侧 `src/api.js` 成立；standalone 侧是一道全局 Bearer 门（`src/api-standalone.js:326`），没有档位概念。
- 每条新路由要进 SECURITY.md 的「受门控」条目，**中英各一处**（`SECURITY.md:157`、`:538`）；`test/security-doc.test.js` 拿真实装配的路由做双向比对，漏了 CI 红。
- `readBody` 的 4 MiB 上限两侧各一份（`src/api.js:55`/`:151`、`src/api-standalone.js:29`/`:104`），超限时它自己答 413 并返回 `null` —— **每个 POST handler 必须写 `if (text === null) return;`**。
- 两侧 `sendJson` 签名不同：`src/api.js:31` 有第四参 `headers`，`src/api-standalone.js:81` 没有。带 `Content-Disposition` 的下载答复只能在宿主内侧出，不许为了同构硬拼。
- 防御段不动：`created_at`（`src/store.js:1154`、`:1200-1201`）与 `content_hash`（`src/store.js:1160`）一律由 store 自己落，不接受调用方传值（spec §5）。
- 发布只在 `dsh-mneme/` 包目录内执行；本计划不发版、不跑 `npm publish`。
- 提交信息**不得有 AI 署名，不得有任何 `Co-Authored-By` trailer**（AGENTS.md，2026-09-19 起生效）。
- 不顺手重构 `src/store.js` / `src/service.js`（已知超线热点，只在被功能碰到时按 AGENTS.md 的拆分方向处理）。

---

## 文件结构

| 动作 | 文件 | 负责什么 |
|---|---|---|
| Create | `src/share.js` | 纯核心：schema 常量、`external_id` 派生、取行口径、两类脱敏、序列化与体积水位。不认识 store、不认识 http |
| Create | `src/share-http.js` | 两张皮共用的一份入参解析与 `{status, body}` 答复（照 reclaim-http.js 的形状，永不直接写 `res`） |
| Create | `src/memory-source.js` | `IMPORTED_SOURCE` 常量 + `isImportedRow(m)` 谓词（车道 B 唯一的公开面） |
| Modify | `src/api.js`（`/export` 那条之后，约 `:1462`） | `POST /api/dsh-mneme/share`，policy `token` |
| Modify | `src/api-standalone.js`（`/maintenance/reclaim` 块旁，约 `:582`） | `POST /share` |
| Modify | `bin/cli.mjs` | `share` 子命令；`KNOWN_FLAGS`（`:122`）与 `USAGE`（`:47`）同步 |
| Modify | `src/service.js:1389-1402` | `saveWithDedupe` 的并入目标解析排除 imported（汇流口） |
| Modify | `src/dream.js:60,489,1017,1479` | 四处行池 |
| Modify | `src/dream/sleep.js:208,447,~498,589` | 四处行池 |
| Modify | `src/organize.js:155-164` | `rowsFor()` 的并入候选查询 |
| Create | `test/share-pack.test.js` | 纯核心：形状锁、口径、脱敏、水位 |
| Create | `test/share-http.test.js` | 协议层 + 反「两张皮分叉」静态锁 |
| Create | `test/share-routes.test.js` | 两张皮各自的装配与鉴权行为 |
| Create | `test/share-imported-guard.test.js` | 汇流口行为锁 + 九处池子静态锁 |
| Modify | `SECURITY.md:157`、`:538` | 双语补 `/share` |
| Create | `docs/SHARE.md` | 域文档，模板照 `docs/STORAGE.md` |
| Modify | `dsh-mneme/README.md`（文档索引，参考 `:710` 的 STORAGE.md 那条） | 挂上 SHARE.md |

---

## 车道 A：分享包

### Task A1: `external_id` 与包 schema 常量

**Files:**
- Create: `src/share.js`
- Test: `test/share-pack.test.js`

**Interfaces:**
- Consumes: 无
- Produces（`src/share.js`）: `SHARE_KIND = "mneme.share/v1"`、`SHARE_SKIP_LIST_MAX = 50`、`MAX_PACK_BYTES = 3 * 1024 * 1024`、`SHARE_READONLY_TYPES = new Set(["document"])`、`SHARE_EXCLUDED_TYPES = new Set(["summary"])`、`deriveExternalId(packId, type, title) -> string`（16 位小写 hex）

- [ ] **Step 1: 写失败测试**

创建 `test/share-pack.test.js`：

```js
// 分享包纯核心的形状锁。这个文件盯两类回归：
//   a) 包里的字段集合只许是白名单那几样 —— 少带是本意（不带 id / 向量 / 时间史），
//      多带就是泄露；所以这里锁「不含什么」比锁「含什么」更要紧。
//   b) 幂等键的派生必须与接收侧重算一致（车道 C 靠它），改一个参数顺序就是破坏
//      所有已发出去的包。
import test from "node:test";
import assert from "node:assert/strict";
import {
  SHARE_KIND, deriveExternalId
} from "../src/share.js";

test("pack kind is the versioned literal the receiver keys on", () => {
  assert.equal(SHARE_KIND, "mneme.share/v1");
});

test("external_id is 16 hex chars and stable per (pack, type, title)", () => {
  const a = deriveExternalId("abcdef0123456789", "decision", "选 SQLite");
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, deriveExternalId("abcdef0123456789", "decision", "选 SQLite"));
});

test("external_id separates fields with NUL so concatenation cannot collide", () => {
  // 无分隔拼接时 ("ab","c") 与 ("a","bc") 同键 —— 这类碰撞在幂等表上就是静默串号。
  assert.notEqual(deriveExternalId("p", "ab", "c"), deriveExternalId("p", "a", "bc"));
  assert.notEqual(deriveExternalId("p1", "t", "x"), deriveExternalId("p2", "t", "x"));
});
```

- [ ] **Step 2: 跑到失败**

Run: `node --test test/share-pack.test.js`
Expected: FAIL —— `Cannot find module ... src/share.js`

- [ ] **Step 3: 写最小实现**

创建 `src/share.js`：

```js
// 记忆分享包的纯核心：取行口径、脱敏、序列化。
// 本模块不认识 store、不认识 http —— 两侧出口（宿主内面板路由与 standalone Bearer
// 数据面）共用的解析与答复在 share-http.js，#411 的教训是这两张皮只许剩鉴权与路径不同。
import { createHash } from "node:crypto";

export const SHARE_KIND = "mneme.share/v1";

// 跳过清单的条数上限：面板与 CLI 都要把「为什么这条没进包」摊给人看，但一个
// 几千条的库不该因此产出一份比包还长的报告。超限就截断，计数仍给全量。
export const SHARE_SKIP_LIST_MAX = 50;

// 体积水位留在 3 MiB，上限是两侧 readBody 各自写死的 4 MiB（api.js:55、
// api-standalone.js:29）。留 1 MiB 是给 JSON 包装与接收侧再序列化的余量——
// 包本身要作为 body 原样 POST 回去，水位贴上限等于给自己埋 413。
export const MAX_PACK_BYTES = 3 * 1024 * 1024;

// document 是指针行（#296），正文文件不随包走，导出去对面就是「看着有、点开是空」；
// 与 mirror.js 的 MIRROR_READONLY_TYPES 同口径，但这里刻意写死字面量而不是 import
// 那个 Set —— 分享格式的兼容面比镜像宽，镜像哪天放开只读 type 不该自动改掉包的口径。
export const SHARE_READONLY_TYPES = new Set(["document"]);
export const SHARE_EXCLUDED_TYPES = new Set(["summary"]);

/** 幂等键：NUL 分隔，防 ("ab","c") 与 ("a","bc") 撞同一键。 */
export function deriveExternalId(packId, type, title) {
  return createHash("sha256")
    .update(`${packId}\u0000${type}\u0000${String(title ?? "").trim()}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}
```

- [ ] **Step 4: 跑到通过**

Run: `node --test test/share-pack.test.js`
Expected: PASS（3 个测试）

- [ ] **Step 5: 同步并提交**

```bash
npm run sync
node --test test/lib-smoke.test.js
git add src/share.js test/share-pack.test.js lib/share.js
git commit -m "feat(share): add the share-pack kind and idempotency key"
```

---

### Task A2: 取行口径与两类脱敏

**Files:**
- Modify: `src/share.js`（追加导出）
- Test: `test/share-pack.test.js`（追加用例）

**Interfaces:**
- Consumes: `SHARE_READONLY_TYPES`、`SHARE_EXCLUDED_TYPES`、`SHARE_SKIP_LIST_MAX`（A1）；`informationlessReason(memory)`（`src/write-admission.js:117`，真值 = 空白或噪声）；`scanSensitive(text)`（`src/sensitive-scan.js:165`，返回 `{kind,label}` 或 null）
- Produces: `createHomeRedactor(homeDir) -> (text) => text`、`classifyRowForShare(row, { redact }) -> {include:true, row} | {include:false, reason}`，其中 `reason ∈ "archived"|"forgotten"|"readonly_type"|"excluded_type"|"blank_or_noise"|"sensitive"`

- [ ] **Step 1: 写失败测试**

追加到 `test/share-pack.test.js`：

```js
import { createHomeRedactor, classifyRowForShare } from "../src/share.js";

const row = (over = {}) => ({
  id: "11111111-1111-1111-1111-111111111111", type: "decision", title: "t", content: "c",
  tags: [], importance: 3, archived: 0, forgotten: 0, source: "session",
  agent_scope: null, workspace_scope: null, created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z", ...over
});

test("home redaction covers both separators and is case-insensitive", () => {
  const home = "/fake/home/alex";
  const redact = createHomeRedactor(home);
  assert.equal(redact(`read ${home}/docs/a.md`), "read ~/docs/a.md");
  assert.equal(redact(`read ${home.split("/").join("\\")}\\docs\\a.md`), "read ~/docs\\a.md");
  assert.equal(redact(`read ${home.toUpperCase()}/x`), "read ~/x");
  assert.equal(redact("nothing here"), "nothing here");
});

test("an empty or weird homedir never turns content into mangled text", () => {
  const redact = createHomeRedactor("");
  assert.equal(redact("keep this"), "keep this");
});

test("archived, forgotten and out-of-scope types are skipped with a reason", () => {
  assert.equal(classifyRowForShare(row({ archived: 1 }), {}).reason, "archived");
  assert.equal(classifyRowForShare(row({ forgotten: 1 }), {}).reason, "forgotten");
  assert.equal(classifyRowForShare(row({ type: "document" }), {}).reason, "readonly_type");
  assert.equal(classifyRowForShare(row({ type: "summary" }), {}).reason, "excluded_type");
  assert.equal(classifyRowForShare(row(), {}).include, true);
});

test("a credential in the body drops the whole row instead of redacting it", () => {
  // 就地打码会造出一条读不通的半截记忆；整条不进 + 跳过清单里看得见标题，才是
  // 分享者能复核的形态（spec §4）。
  const hit = classifyRowForShare(row({ content: "key sk-abcdefghijklmnopqrstuvwxyz012345" }), {});
  assert.equal(hit.include, false);
  assert.equal(hit.reason, "sensitive");
});

test("a blank memory is skipped as blank_or_noise before the sensitive check", () => {
  assert.equal(classifyRowForShare(row({ content: "   " }), {}).reason, "blank_or_noise");
});

test("the share filter uses the ungated scanner, never the gated factory", () => {
  // spec §4：分享边界本身就是安全边界。`createSensitiveScan({config})` 在
  // `sensitiveScanEnabled` 关时返回 null（`src/sensitive-scan.js:199`），谁要是把
  // 这里「顺手统一」成工厂，用户没开写入闸门就等于裸发整库。
  const text = readFileSync(new URL("../src/share.js", import.meta.url), "utf8");
  assert.ok(text.includes("scanSensitive("), "share must scan with the ungated text scanner");
  assert.ok(!text.includes("createSensitiveScan"), "share must not route through the gated factory");
});
```

同一条 import 语句里带上 `readFileSync`（`import { readFileSync } from "node:fs";`），A1 那批 import 若还没有就补在这一行。

- [ ] **Step 2: 跑到失败**

Run: `node --test test/share-pack.test.js`
Expected: FAIL —— `createHomeRedactor is not a function`（或导入门报错）

- [ ] **Step 3: 写实现**

追加到 `src/share.js`：

```js
import { informationlessReason } from "./write-admission.js";
import { scanSensitive } from "./sensitive-scan.js";

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 把正文里的本机 home 前缀换成 `~`。两个形态都要替：Windows 上同一目录既能写成
 * 反斜杠也能写成正斜杠（Node 两边都收），只替一种等于漏一半。大小写不敏感：
 * 盘符与用户目录在真实路径里的大小写常常和 homedir() 不一致。
 */
export function createHomeRedactor(homeDir) {
  const base = typeof homeDir === "string" ? homeDir.trim() : "";
  if (base.length < 2) return (text) => String(text ?? "");
  const forms = [...new Set([base, base.replace(/[\\/]/g, "\\")])];
  const re = new RegExp(`(?:${forms.map(reEsc).join("|")})`, "gi");
  return (text) => String(text ?? "").replace(re, "~");
}

/**
 * 一条记忆进不进包。顺序是刻意的：先状态位（archived/forgotten），再类型，
 * 再判据 —— 空白与噪声先于敏感判定，因为一条内容为空的记忆没有可泄露的东西，
 * 把它记成 sensitive 会让跳过清单的读数说错原因。
 */
export function classifyRowForShare(row, { redact = (t) => t } = {}) {
  if (row?.archived) return { include: false, reason: "archived", title: row?.title };
  if (row?.forgotten) return { include: false, reason: "forgotten", title: row?.title };
  if (SHARE_READONLY_TYPES.has(row?.type)) return { include: false, reason: "readonly_type", title: row?.title };
  if (SHARE_EXCLUDED_TYPES.has(row?.type)) return { include: false, reason: "excluded_type", title: row?.title };
  if (informationlessReason(row)) return { include: false, reason: "blank_or_noise", title: row?.title };
  const scanned = scanSensitive([row?.title, row?.content, ...(Array.isArray(row?.tags) ? row.tags : [])]
    .filter((s) => typeof s === "string").join("\n"));
  if (scanned) return { include: false, reason: "sensitive", title: row?.title };
  const content = redact(row?.content ?? "");
  const title = redact(row?.title ?? "");
  return {
    include: true,
    row: {
      type: row.type,
      title,
      content,
      tags: (Array.isArray(row.tags) ? row.tags : []).map((t) => String(redact(t))),
      importance: Number.isInteger(row.importance) ? row.importance : 3,
      epistemic_status: row.epistemic_status ?? "subjective",
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
      // 对面入库时 store 会按自己的口径重算 content_hash（store.js:1160），这份只是
      // 包内的自证：让接收侧能核对「正文没在路上被改」。
      content_hash: row.content_hash ?? null
    }
  };
}
```

- [ ] **Step 4: 跑到通过**

Run: `node --test test/share-pack.test.js`
Expected: PASS（9 个测试）

> 若 `informationlessReason` 对 `content: "   "` 返回假值（它内部可能只看 title+content 的组合口径），**不要**改成自己判空白。把该用例改成断言这一条真实返回、并把 `classifyRowForShare` 的顺序按事实调整，然后在注释里写清它是按什么判的 —— 判据只许有一份。

- [ ] **Step 5: 同步并提交**

```bash
npm run sync
git add src/share.js test/share-pack.test.js lib/share.js
git commit -m "feat(share): add row selection with home redaction and credential skip"
```

---

### Task A3: 打包与体积水位

**Files:**
- Modify: `src/share.js`（追加 `buildSharePack`）
- Test: `test/share-pack.test.js`（追加用例）

**Interfaces:**
- Consumes: A1/A2 的全部导出
- Produces: `buildSharePack({ rows, alias, homeDir, packageVersion, filters, packId?, generatedAt? }) -> { ok: true, pack, bytes } | { ok: false, error: "too-large", pack, bytes, limitBytes }`；`pack` 形状见 spec §3：`{ kind, pack_id, alias, generated_at, source_version, report: { included, skipped: {archived, forgotten, readonly_type, excluded_type, blank_or_noise, sensitive}, skip_list }, memories: [...] }`，每条 memory 带 `external_id`

- [ ] **Step 1: 写失败测试**

追加到 `test/share-pack.test.js`：

```js
import { buildSharePack } from "../src/share.js";

const packInput = (rows, over = {}) => buildSharePack({
  rows, alias: "桉桉", homeDir: "/fake/home/alex", packageVersion: "0.9.4",
  packId: "abcdef0123456789", generatedAt: "2026-10-22T00:00:00.000Z", ...over
});

test("pack carries the whitelist and nothing else", () => {
  const { pack } = packInput([row({ embedding: "huge", content_history: "[{}]", doc_path: "/x", agent_scope: "/fake/home/alex/p" })]);
  assert.equal(pack.kind, "mneme.share/v1");
  assert.equal(pack.memories.length, 1);
  const m = pack.memories[0];
  for (const banned of ["id", "embedding", "content_history", "doc_path", "agent_scope", "workspace_scope", "sensitivity", "_full_content", "evidence"]) {
    assert.ok(!(banned in m), `pack must not carry ${banned}`);
  }
  assert.equal(m.type, "decision");
  assert.match(m.external_id, /^[0-9a-f]{16}$/);
});

test("report counts every skip reason and caps the list it shows", () => {
  const rows = [
    row({ type: "decision", title: "keep" }),
    row({ type: "preference", archived: 1 }),
    row({ type: "history", forgotten: 1 }),
    row({ type: "document" }),
    row({ type: "summary" }),
    row({ type: "pattern", content: "   " })
  ];
  const { pack } = packInput(rows);
  assert.equal(pack.report.included, 1);
  assert.deepEqual(pack.report.skipped, {
    archived: 1, forgotten: 1, readonly_type: 1, excluded_type: 1, blank_or_noise: 1, sensitive: 0
  });
  assert.ok(pack.report.skip_list.every((s) => typeof s.title === "string" && typeof s.reason === "string"));
});

test("skip list truncates but the counters stay exact", () => {
  const rows = Array.from({ length: 80 }, (_, i) => row({ type: "history", archived: 1, title: `a${i}` }));
  const { pack } = packInput(rows);
  assert.equal(pack.report.skipped.archived, 80);
  assert.equal(pack.report.skip_list.length, 50);
});

test("a pack over the water mark is refused with the measured size", () => {
  const rows = [row({ content: "字".repeat(2_000_000) })];
  const out = packInput(rows);
  assert.equal(out.ok, false);
  assert.equal(out.error, "too-large");
  assert.ok(out.bytes > out.limitBytes);
});

test("filters narrow what goes in without touching the reason counters", () => {
  const rows = [row({ type: "decision", title: "a" }), row({ type: "preference", title: "b" })];
  const byType = packInput(rows, { filters: { type: ["decision"] } });
  assert.equal(byType.pack.report.included, 1);
  assert.equal(byType.pack.memories[0].title, "a");
  const byTag = packInput([row({ type: "decision", title: "a", tags: ["keep"] })], { filters: { tag: "keep" } });
  assert.equal(byTag.pack.memories[0].tags.includes("keep"), true);
  const byTagMiss = packInput([row({ type: "decision", title: "a", tags: ["other"] })], { filters: { tag: "keep" } });
  assert.equal(byTagMiss.pack.report.included, 0);
});

test("alias defaults to the neutral label, never to a guessed identity", () => {
  const out = buildSharePack({ rows: [row()], homeDir: "/fake/home/alex", packageVersion: "0.9.4", packId: "p", generatedAt: "2026-10-22T00:00:00.000Z" });
  assert.equal(out.pack.alias, "");
});
```

- [ ] **Step 2: 跑到失败**

Run: `node --test test/share-pack.test.js`
Expected: FAIL —— `buildSharePack is not a function`

- [ ] **Step 3: 写实现**

追加到 `src/share.js`：

```js
import { randomBytes } from "node:crypto";

/**
 * 打包。顺序：过滤 → 逐条定性 → 铸 external_id → 序列化 → 量字节。
 *
 * 水位量的是**最终字节**而不是条数或字符数：包要原样作为 body POST 回对面（车道 C），
 * 中文字符数与 UTF-8 字节数差三倍，按字符数判等于把 413 留给对面。
 *
 * 超限不裁条目：裁到哪一条是替分享者做「哪条可以不发」的判断，而这份判断应该由她
 * 用 filters 分批来做（spec §4 决策 5）。
 */
export function buildSharePack({
  rows, alias = "", homeDir, packageVersion, filters = {},
  packId = randomBytes(8).toString("hex"), generatedAt = new Date().toISOString()
} = {}) {
  const redact = createHomeRedactor(homeDir);
  const wanted = Array.isArray(filters.type) && filters.type.length ? new Set(filters.type) : null;
  const tag = typeof filters.tag === "string" && filters.tag.trim() ? filters.tag.trim() : null;
  const skipped = { archived: 0, forgotten: 0, readonly_type: 0, excluded_type: 0, blank_or_noise: 0, sensitive: 0 };
  const skipList = [];
  const memories = [];
  for (const source of Array.isArray(rows) ? rows : []) {
    if ((wanted && !wanted.has(source?.type)) || (tag && !(Array.isArray(source?.tags) ? source.tags : []).includes(tag))) {
      continue; // 过滤是分享者的显式收窄，不算「跳过」，不进计数也不进清单
    }
    const verdict = classifyRowForShare(source, { redact });
    if (!verdict.include) {
      skipped[verdict.reason] = (skipped[verdict.reason] ?? 0) + 1;
      if (skipList.length < SHARE_SKIP_LIST_MAX) skipList.push({ title: verdict.title ?? "", reason: verdict.reason });
      continue;
    }
    memories.push({ external_id: deriveExternalId(packId, verdict.row.type, verdict.row.title), ...verdict.row });
  }
  const pack = {
    kind: SHARE_KIND,
    pack_id: packId,
    alias: typeof alias === "string" ? alias.trim() : "",
    generated_at: generatedAt,
    source_version: String(packageVersion ?? ""),
    report: { included: memories.length, skipped, skip_list: skipList },
    memories
  };
  const bytes = Buffer.byteLength(JSON.stringify(pack), "utf8");
  if (bytes > MAX_PACK_BYTES) {
    return { ok: false, error: "too-large", pack, bytes, limitBytes: MAX_PACK_BYTES };
  }
  return { ok: true, pack, bytes };
}
```

- [ ] **Step 4: 跑到通过**

Run: `node --test test/share-pack.test.js`
Expected: PASS（15 个测试：A1 三条 + A2 六条 + A3 六条）

- [ ] **Step 5: 同步并提交**

```bash
npm run sync
git add src/share.js test/share-pack.test.js lib/share.js
git commit -m "feat(share): build the pack with skip accounting and a size water mark"
```

---

### Task A4: `src/share-http.js` —— 两张皮共用的解析与答复

**Files:**
- Create: `src/share-http.js`
- Test: `test/share-http.test.js`

**Interfaces:**
- Consumes: `buildSharePack`（A3）、`SHARE_KIND`
- Produces: `parseShareBody(text) -> {ok:true, options} | {ok:false, error}`（options = `{alias, type[], tag, dryRun}`）；`shareReply({ service, packageVersion, homeDir, now, options }) -> { status, body }`；`shareFilename(packId, now)`

- [ ] **Step 1: 写失败测试**

创建 `test/share-http.test.js`：

```js
// 分享包的 HTTP 口径。两类回归：
//   a) 口径本身 —— 这张脸有两个入口（宿主内面板路由、standalone Bearer 数据面），
//      任何一处松掉都会同时污染两侧；
//   b) **不许再长出第二份实现**（#410 修好面板侧、数据面停在旧形态的那次教训）。
//      下面的静态锁把「校验字面量只许出现在本模块」写成断言。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseShareBody, shareReply, shareFilename } from "../src/share-http.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(resolve(here, "../src", f), "utf8");
const rows = [
  { id: "a", type: "decision", title: "选 SQLite", content: "正文", tags: [], importance: 4,
    archived: 0, forgotten: 0, created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z" },
  { id: "b", type: "preference", archived: 1, forgotten: 0, title: "归档项", content: "x", tags: [] }
];
const fakeService = { all: () => rows };
const baseArgs = { service: fakeService, packageVersion: "0.9.4", homeDir: "/fake/home/alex", now: () => new Date("2026-10-22T00:00:00.000Z") };

test("bad json and non-object bodies are refused with a code, not a throw", () => {
  assert.deepEqual(parseShareBody(""), { ok: true, options: {} });
  assert.equal(parseShareBody("{oops").ok, false);
  assert.equal(parseShareBody("[1,2]").ok, false);
});

test("unknown option keys are dropped, not silently accepted", () => {
  const parsed = parseShareBody(JSON.stringify({ alias: "桉", type: ["decision"], color: "red" }));
  assert.equal(parsed.ok, true);
  assert.ok(!("color" in parsed.options));
});

test("reply returns the pack body with kind and disposition-ready filename", () => {
  const { status, body } = shareReply({ ...baseArgs, options: {} });
  assert.equal(status, 200);
  assert.equal(body.kind, "mneme.share/v1");
  assert.equal(body.report.included, 1);
  assert.equal(body.report.skipped.archived, 1);
  assert.match(shareFilename("abcdef0123456789", () => new Date("2026-10-22T00:00:00.000Z")), /^dsh-mneme-share-20261022-abcdef01\.json$/);
});

test("oversized packs answer 413 with the measured size and the batching hint", () => {
  const fat = [{ id: "f", type: "decision", title: "t", content: "字".repeat(2_000_000), tags: [], archived: 0, forgotten: 0 }];
  const out = shareReply({ ...baseArgs, service: { all: () => fat }, options: {} });
  assert.equal(out.status, 413);
  assert.equal(out.body.error, "too-large");
  assert.ok(out.body.bytes > out.body.limitBytes);
  assert.match(out.body.hint, /--type/);
});

test("empty library answers 200 with included 0 — not an error", () => {
  const out = shareReply({ ...baseArgs, service: { all: () => [] }, options: {} });
  assert.equal(out.status, 200);
  assert.equal(out.body.report.included, 0);
});

test("the share literals live in the share modules only", () => {
  const FORKED = ["mneme.share/v1", "too-large", "parseShareBody", "shareReply"];
  for (const lit of FORKED) {
    assert.ok(src("share-http.js").includes(lit) || src("share.js").includes(lit), `${lit} must live in the share modules`);
  }
});
```

跨面的那一半锁（`api.js` 与 `api-standalone.js` 必须调 `shareReply(`、不许自己复制字面量）**不在本任务**：A4 时两张皮还没接上，现在就锁必红。它跟在 A6 Step 1 里补。

- [ ] **Step 2: 跑到失败**

Run: `node --test test/share-http.test.js`
Expected: FAIL —— `Cannot find module ... src/share-http.js`

- [ ] **Step 3: 写实现**

创建 `src/share-http.js`：

```js
// 分享包在两张皮上共用的解析与答复（形状照 src/reclaim-http.js，#411）。
// 只返回 {status, body}，绝不自己写 res —— 两侧的 sendJson 签名不同（api.js 有
// headers 第四参、api-standalone.js 没有），把写 res 留在各侧 handler 里是唯一
// 能让一份实现喂两张脸的做法。
import { buildSharePack } from "./share.js";

const SHARE_ERROR_HINT = "包体超过分享水位：用 --type 或 --tag 分批，别整库外发。";

export function parseShareBody(text) {
  if (text === undefined || text === null || String(text).trim() === "") return { ok: true, options: {} };
  let body;
  try {
    body = JSON.parse(String(text));
  } catch {
    return { ok: false, error: "invalid-json" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "invalid-body" };
  const options = {};
  if (typeof body.alias === "string") options.alias = body.alias;
  if (Array.isArray(body.type) && body.type.every((t) => typeof t === "string")) options.type = body.type;
  if (typeof body.tag === "string") options.tag = body.tag;
  if (body.dryRun === true) options.dryRun = true;
  return { ok: true, options };
}

export function shareFilename(packId, now = () => new Date()) {
  const stamp = now().toISOString().slice(0, 10).replace(/-/g, "");
  return `dsh-mneme-share-${stamp}-${String(packId).slice(0, 8)}.json`;
}

/**
 * 组包并给出答复。`service.all()` 是「全库含归档/已遗忘」的现成通道，口径（哪些行
 * 进、哪些跳）全在 share.js 里判，本模块不重复任何一条判据。
 */
export function shareReply({ service, packageVersion, homeDir, now = () => new Date(), options = {} }) {
  const rows = typeof service?.all === "function" ? service.all() : [];
  const out = buildSharePack({
    rows, alias: options.alias, homeDir, packageVersion,
    filters: { type: options.type, tag: options.tag },
    generatedAt: now().toISOString()
  });
  if (!out.ok) {
    return { status: 413, body: { error: out.error, bytes: out.bytes, limitBytes: out.limitBytes, hint: SHARE_ERROR_HINT, report: out.pack.report } };
  }
  return { status: 200, body: out.pack };
}
```

- [ ] **Step 4: 跑到通过**

Run: `node --test test/share-http.test.js`
Expected: PASS（6 个测试）

- [ ] **Step 5: 同步并提交**

```bash
npm run sync
git add src/share-http.js test/share-http.test.js lib/share-http.js
git commit -m "feat(share): add the one shared parse/reply layer for both surfaces"
```

---

### Task A5: 宿主内面板路由 `POST /api/dsh-mneme/share`

**Files:**
- Modify: `src/api.js`（紧接 `/export` 那条 register 之后，约 `:1462`）
- Test: `test/share-routes.test.js`

**Interfaces:**
- Consumes: `shareReply`、`parseShareBody`、`shareFilename`（A4）；本文件已有的 `sendJson(res, status, payload, headers)`（`:31`）、`readBody`（`:151`）、closure 里的 `service`/`config`
- Produces: 一条 `kind: "exact"`、`path: "/api/dsh-mneme/share"`、`policy: "token"` 的路由；答复体为包 JSON，带 `Content-Disposition`

- [ ] **Step 1: 写失败测试**

创建 `test/share-routes.test.js`（装配台照 `test/api-routes-gaps.test.js:397-416` 的 `reclaimSetup` 形状，**必须落文件库**，`:memory:` 那条路数在这里同样适用）：

```js
// 分享包在两张皮上的装配锁。盯三件事：
//   a) policy 归对（token —— 它是全库级读取，与 /export 同门，见 2026-10 审计 P0）；
//   b) token 配上时**不带 token 必须 401**，不是静默放行；
//   c) readBody 返回 null（超 4 MiB，它自己已答 413）时 handler 必须直接 return，
//      不能再答一次 —— 双写响应是 #410 那一类故障。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createApi } from "../src/api.js";

const SHARE_PATH = "/api/dsh-mneme/share";

function shareSetup(apiToken = "secret-token") {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-share-api-"));
  const store = createStore(join(dir, "memory.db"));
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const commands = { add: () => {}, remove: () => {}, list: () => [] };
  const routes = [];
  const ctx = { logger: null, webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, commands, null, undefined, apiToken, null, null);
  return { store, service, routes, close() { try { store.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); } };
}

function fakeReqRes({ method = "POST", url = SHARE_PATH, body = "", authorized = true } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  if (authorized) req.headers = { authorization: "Bearer secret-token" };
  const res = new EventEmitter();
  res.headersSent = false;
  res.statusCode = 0;
  const chunks = [];
  res.setHeader = (k, v) => { res.responseHeaders ??= {}; res.responseHeaders[k] = v; };
  res.write = (c) => chunks.push(Buffer.from(c));
  res.end = (c) => { if (c) chunks.push(Buffer.from(c)); res.finished = true; };
  return { req, res, text: () => Buffer.concat(chunks).toString("utf8") };
}

async function callShare(route, opts) {
  const { req, res, text } = fakeReqRes(opts);
  req.emit("data", Buffer.from(opts.body ?? ""));
  req.emit("end");
  await route.handler(req, res);
  return { status: res.statusCode, body: text() };
}

test("share route is registered with policy token", () => {
  const s = shareSetup();
  try {
    const route = s.routes.find((r) => r.path === SHARE_PATH);
    assert.ok(route, "route must exist");
    assert.equal(route.policy, "token");
    assert.equal(route.kind, "exact");
  } finally { s.close(); }
});

test("a configured token gates the share route", async () => {
  const s = shareSetup();
  try {
    const route = s.routes.find((r) => r.path === SHARE_PATH);
    s.store.save({ type: "decision", title: "选 SQLite", content: "正文", tags: [] });
    const denied = await callShare(route, { authorized: false, body: "" });
    assert.equal(denied.status, 401);
    const allowed = await callShare(route, { authorized: true, body: "" });
    assert.equal(allowed.status, 200);
    const pack = JSON.parse(allowed.body);
    assert.equal(pack.kind, "mneme.share/v1");
    assert.equal(pack.report.included, 1);
    assert.ok(!("id" in pack.memories[0]));
  } finally { s.close(); }
});

test("GET on the share route is not an open read", async () => {
  const s = shareSetup();
  try {
    const route = s.routes.find((r) => r.path === SHARE_PATH);
    const out = await callShare(route, { method: "GET", body: "" });
    assert.ok(out.status === 405 || out.status === 404, `GET must not build a pack, got ${out.status}`);
  } finally { s.close(); }
});
```

- [ ] **Step 2: 跑到失败**

Run: `node --test test/share-routes.test.js`
Expected: FAIL —— `route must exist`

- [ ] **Step 3: 写实现**

在 `src/api.js` 的 `/export` register 块结束（`:1462` 的 `});`）之后插入。`os` 的 `homedir` 若本文件还没导入，加到文件顶部的 import 区（`import { homedir } from "node:os";`）：

```js
  // --- 分享包（spec §4）------------------------------------------------------
  // 读侧全库口径，鉴权与 /export 同门（token）：它导出的是**脱敏后**的行集，但
  // 「谁在往外打整库」这件事本身就需要跟写路由一样登记在册。
  // GET 不开口子：这条路由的存在感来自「有人主动按分享键」，不是给面板轮询用的。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/share",
    policy: "token",
    handler(req, res) {
      try {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method-not-allowed" });
          return;
        }
        return readBody(req, res).then((text) => {
          if (text === null) return; // readBody 已经答过 413，再写一次就是双写响应
          const parsed = parseShareBody(text);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const out = shareReply({ service, packageVersion: PACKAGE_VERSION, homeDir: homedir(), options: parsed.options });
          if (out.status === 200) {
            sendJson(res, 200, out.body, {
              "Content-Disposition": `attachment; filename="${shareFilename(out.body.pack_id)}"`
            });
            return;
          }
          sendJson(res, out.status, out.body);
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });
```

并在 `src/api.js` 顶部 import 区补：

```js
import { parseShareBody, shareReply, shareFilename } from "./share-http.js";
```

`PACKAGE_VERSION` 若本文件已有（`/export` 在用）则直接复用；没有就按 `/export` 那一处同样的来源导入，不要新算一份版本口径。

- [ ] **Step 4: 跑到通过**

Run: `node --test test/share-routes.test.js test/route-policy.test.js`
Expected: PASS —— 三条断言过，且 `route-policy` 的路由计数下界仍过（`assert.ok(mounted.length >= 30)`，多一条只会更高）

- [ ] **Step 5: 同步并提交**

```bash
npm run sync
git add src/api.js test/share-routes.test.js lib/api.js
git commit -m "feat(share): expose the pack builder on the panel route"
```

---

### Task A6: standalone 数据面 `POST /share`

**Files:**
- Modify: `src/api-standalone.js`（`/maintenance/reclaim` 块之后，约 `:582`）
- Test: `test/share-routes.test.js`（追加）

**Interfaces:**
- Consumes: `shareReply`、`parseShareBody`、`shareFilename`（A4）；本文件的 `sendJson(res, status, payload)`（`:81`，**无 headers 参数**）、`readBody`（`:104`）、closure 里的 `service`/`store`
- Produces: `POST /share`，答复体为包 JSON（standalone 侧不出 `Content-Disposition`，CLI 自己落盘）

- [ ] **Step 1: 写失败测试**

追加到 `test/share-routes.test.js`（装配照 `test/standalone-api.test.js:12-32` 起真服务 + `fetch` 的形状）：

```js
import { createStandaloneApi } from "../src/api-standalone.js";

function standaloneSetup() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-share-std-"));
  const store = createStore(join(dir, "memory.db"));
  const service = createService({ store, mirror: null, config: {} });
  return new Promise((resolve) => {
    const api = createStandaloneApi({ service, store, config: {}, port: 0, strictPort: true });
    api.start().then(() => resolve({ api, store, service, dir,
      close() { return Promise.resolve(api.stop?.()).finally(() => { try { store.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); }); } }));
  });
}

test("standalone /share answers the pack for a Bearer caller and 401 otherwise", async () => {
  const h = await standaloneSetup();
  try {
    h.store.save({ type: "decision", title: "选 SQLite", content: "正文 here", tags: [] });
    const token = h.api.token ?? "";
    const anon = await fetch(`http://127.0.0.1:${h.api.port}/share`, { method: "POST", body: "{}" });
    assert.equal(anon.status, 401);
    const ok = await fetch(`http://127.0.0.1:${h.api.port}/share`, {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ alias: "桉" })
    });
    assert.equal(ok.status, 200);
    const pack = await ok.json();
    assert.equal(pack.alias, "桉");
    assert.equal(pack.report.included, 1);
  } finally { await h.close(); }
});
```

> 如果 `createStandaloneApi` 的 token 字段名或 `start/stop` 方法名与上面不符，**照 `test/standalone-api.test.js` 里现成的用法改这几行**，不要改被测模块去迁就测试。

- [ ] **Step 2: 跑到失败**

Run: `node --test test/share-routes.test.js`
Expected: FAIL —— 404（standalone 侧还没有 `/share`）

- [ ] **Step 3: 写实现**

在 `src/api-standalone.js` 的 `/maintenance/reclaim` 块之后插入（照它的 `void readBody(...).then(...)` 写法，但**外面包一层 catch**：共享答复构造器抛错在这个文件里没有外层兜底，那正是 #410）：

```js
      if (req.method === "POST" && pathname === "/share") {
        void readBody(req, res).then((text) => {
          if (text === null) return;
          const parsed = parseShareBody(text);
          if (!parsed.ok) { sendJson(res, 400, { error: parsed.error }); return; }
          const out = shareReply({ service, packageVersion: PACKAGE_VERSION, homeDir: homedir(), options: parsed.options });
          sendJson(res, out.status, out.body);
        }).catch(() => sendJson(res, 500, { error: "internal" }));
        return;
      }
```

顶部 import 区补 `parseShareBody, shareReply` 与 `homedir`（本文件已有 `os` 相关导入就并进去）。standalone 侧不写 `Content-Disposition` —— 它的 `sendJson` 没有 headers 参数，CLI 拿 JSON 自己落盘。

- [ ] **Step 4: 跑到通过**

两张皮都接上了，把跨面的反分叉锁补进 `test/share-http.test.js`（`src()` helper 本文件已有），然后一起跑：

```js
test("both surfaces call the shared builder instead of forking the口径", () => {
  for (const file of ["api.js", "api-standalone.js"]) {
    const text = src(file);
    assert.ok(text.includes("shareReply("), `${file} must call the shared reply builder`);
    for (const lit of ["mneme.share/v1", '"too-large"']) {
      assert.ok(!text.includes(lit), `${file} must not re-implement ${lit}`);
    }
  }
});
```

Run: `node --test test/share-routes.test.js test/share-http.test.js test/standalone-api.test.js`
Expected: PASS —— share-http 那份 7 个测试、share-routes 那两条、standalone 既有全套

- [ ] **Step 5: 同步并提交**

```bash
npm run sync
git add src/api-standalone.js test/share-routes.test.js lib/api-standalone.js
git commit -m "feat(share): serve the pack from the bearer data plane"
```

---

### Task A7: CLI `dsh-mneme share`

**Files:**
- Modify: `bin/cli.mjs`（`USAGE` `:47`、`KNOWN_FLAGS` `:122`、`switch (cmd)` `:708`、新增 `cmdShare`）

**Interfaces:**
- Consumes: `apiRequest(cfg, method, pathname, { query, body })`（`:292`）、`requireToken`（`:265`）、`flagValue`/`flagBool`/`stringify`/`fail`
- Produces: `share` 子命令，`--alias`、`--type`（可重复的逗号列表）、`--tag`、`--out <文件>`、`--dry-run`、`--json`

- [ ] **Step 1: 加旗标名（先让锁住它的测试转起来）**

`KNOWN_FLAGS`（`:122-129`）里补上，取值的加进「取值的旗标」段、布尔的加进「布尔旗标」段：

```js
  'alias', 'tag', 'out',
  'dry-run', 'dryrun',
```

`type` 已在这张表里，别重复加。Run: `node --test test/cli-flag-value.test.js`
Expected: 此时仍 PASS（该锁只校验「用到的旗标必须在表里」，加名字不会转红）；下一步用上它们。

- [ ] **Step 2: 写 `cmdShare`**

照 `cmdReclaim`（`:663-688`）的形状，紧接其后加：

```js
async function cmdShare(cfg, flags) {
  requireToken(cfg);
  const out = flagValue(flags, 'out');
  const dryRun = flagBool(flags, 'dry-run') || flagBool(flags, 'dryrun');
  if (!out && !dryRun) {
    fail(
      cfg,
      `share 要么写文件（--out <路径>），要么只看报告（--dry-run）：` +
        `不写文件又把整库打到 stdout 会让报告被 JSON 淹掉。\n` +
        `例子：${CLI_NAME} share --out ~/Desktop/pack.json`
    );
  }
  const typeRaw = flagValue(flags, 'type');
  const body = {};
  if (typeRaw) body.type = typeRaw.split(',').map((t) => t.trim()).filter(Boolean);
  const alias = flagValue(flags, 'alias');
  if (alias) body.alias = alias;
  const tag = flagValue(flags, 'tag');
  if (tag) body.tag = tag;
  const pack = await apiRequest(cfg, 'POST', '/share', { body });
  // 超水位时服务端答 413，而 apiRequest 对非 2xx 走的是 failHttp（`:236`）：
  // 它会打印响应体然后 exit(1)。所以这里**没有**可达的 error 分支可写——
  // 别加 `if (pack?.error)`。实施时先读一眼 failHttp 确认它把响应体带出来了
  // （413 的响应体含 report 与 hint），没带就在 failHttp 那一侧补，不在这里补第二份。
  const r = pack?.report ?? {};
  if (cfg.jsonMode) {
    console.log(stringify(dryRun ? { report: r, pack } : { report: r, file: out }));
  } else {
    printShare(pack, { dryRun, out });
  }
  if (dryRun) return;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(out, JSON.stringify(pack), 'utf8');
  console.log(`  已写出: ${out}`);
}
```

并在 `printReclaim` 旁边加打印器（报告口径与 spec §3 一致）：

```js
function printShare(pack, { dryRun, out }) {
  const r = pack?.report ?? {};
  const s = r.skipped ?? {};
  console.log(`${dryRun ? '干跑报告' : '分享包'}: ${r.included ?? 0} 条` +
    (pack?.alias ? `  来自 ${pack.alias}` : ''));
  const named = [['archived', '归档'], ['forgotten', '已遗忘'], ['readonly_type', '只读指针行'],
    ['excluded_type', '不随包走'], ['blank_or_noise', '空白/噪声'], ['sensitive', '密钥/PII']];
  const parts = named.filter(([k]) => (s[k] ?? 0) > 0).map(([k, zh]) => `${zh} ${s[k]}`);
  console.log(`  跳过: ${parts.length ? parts.join(', ') : '无'}`);
  for (const item of (r.skip_list ?? []).slice(0, 20)) {
    console.log(`    - [${item.reason}] ${item.title}`);
  }
  if ((r.skip_list ?? []).length >= 50) console.log('    … 跳过清单已截断，计数仍为全量');
  if (dryRun) console.log(`  没写文件：加 --out <路径> 才会落盘`);
  else console.log(`  发给对方即可，她用自己的 ${CLI_NAME} receive 吃进去（车道 C）`);
}
```

`switch (cmd)`（`:708`）里补一行，紧接 `case 'reclaim'`：

```js
      case 'share': return cmdShare(cfg, flags);
```

- [ ] **Step 3: 补 USAGE**

`USAGE`（`:47`）的命令块里，`reclaim` 那段之后加：

```
  share [--alias 名字] [--type a,b] [--tag 标签] --out <文件>
                               打一个可外发的脱敏分享包（不改库，纯读）
                               --alias 名字     在包里署名，对方看到的是这个而不是你的路径
                               --type/--tag     收窄到某几类/某个标签（超限分批用这两个）
                               --out <文件>     写出包文件；--dry-run 只报数不落盘
                               跳过归档/已遗忘/只读指针行/summary，密钥 PII 整条不进包
```

- [ ] **Step 4: 跑到通过 + 手工验证**

```bash
node --test test/cli-flag-value.test.js
node bin/cli.mjs --help | grep -A 6 "share \["
node --check bin/cli.mjs
```
Expected: 测试 PASS；help 里能看到 share 那一段；语法检查过。

真跑一次（需要本机 DSH 开着外部访问）：`node bin/cli.mjs share --dry-run` —— 应打出条数与跳过分布，且**不写任何文件**。

- [ ] **Step 5: 同步并提交**

```bash
git add bin/cli.mjs
git commit -m "feat(share): add the dsh-mneme share command"
```

（`bin/` 不是 `src/` 的同步产物，本刀无需 `npm run sync`。）

---

### Task A8: 安全面文档、域文档与 README

**Files:**
- Modify: `SECURITY.md:157`（英文「Gated routes」）、`:538`（中文「受门控的路由」）
- Create: `dsh-mneme/docs/SHARE.md`
- Modify: `dsh-mneme/README.md`（文档索引，参考 `:710` 那条 STORAGE.md）

**Interfaces:**
- Consumes: A5/A6 已装配的路由
- Produces: 无代码接口；CI 的 `test/security-doc.test.js` 双向比对必须转绿

- [ ] **Step 1: 先让比对告诉你缺哪一处**

Run: `node --test test/security-doc.test.js`
Expected: FAIL —— 该测试拿真实装配的路由与 SECURITY.md 的两条条目做双向比对，新加的 `/share`（`token`）会被报出来。

- [ ] **Step 2: 改两处条目**

英文 `:157` 的「Gated routes」里，在 `/maintenance/reclaim` 之后插入 `` `/share` ``；中文 `:538` 的「受门控的路由」同位置插入 `` `/share` ``。两处都只是往已有清单里加一个路径名，**不要新起一条 bullet**（新 bullet 会被当成清单外路由，比对照样红）。

Run: `node --test test/security-doc.test.js`
Expected: PASS

- [ ] **Step 3: 写 `docs/SHARE.md`**

模板照 `docs/STORAGE.md`（标题带 issue 号 → `## 概览` → `## 用法` 的 fenced bash 块 → 「装什么、不装什么」表 → 代价与实测 → 已知坑）。内容按 spec 写，其中「代价与实测」这一节**必须先真跑再写**：

```markdown
# dsh-mneme 记忆分享包

## 概览
把本机记忆打成一个可外发的 JSON 包，发给同样装着 dsh-mneme 的人。包只含活跃行，
`agent_scope` / `workspace_scope` 与本机 home 前缀一律不进包，命中密钥/PII 的行
**整条不进**（不打码）。这一刀只出包：对面的 `receive` 在车道 C，本刀合完之后
发出去的包还吃不进去。

## 用法
```bash
dsh-mneme share --dry-run                  # 只看会进多少条、跳过多少条
dsh-mneme share --out ~/Desktop/pack.json  # 写包
dsh-mneme share --type decision,pitfall --out …   # 超水位时分批
```
前置：面板「设置 → 外部访问」打开，token 用 `dsh-mneme config set <url> <token>` 配一次。命令走 standalone 数据面 `POST /share`。

## 装什么、不装什么
| 对象 | 动作 | 为什么 |
|---|---|---|
| `archived` / `forgotten` 行 | 跳过 | 分享的是「现在还在用的我」，不是全部历史；这两面本来就不可达 |
| `document` 指针行 | 跳过 | 正文文件不随包走，导过去是「看着有、点开是空」 |
| `summary` 行 | 跳过 | 对面没有上下文读它，且会抢对面自己 dream 总览的注入档位 |
| 命中密钥/PII 的行 | **整条跳过**，不进包也不打码 | 半截打码的记忆是读不通的噪声；跳过清单里看得见标题，分享者自己决定 |
| `agent_scope` / `workspace_scope` | 不进包 | 里面是本机绝对路径与 agent 模板名 |
| 正文里的 home 前缀 | 换成 `~` | 正文字符串里同样会带出用户名目录 |

## 代价与实测
（这一节填你自己这次的读数：条数、包字节、`scanSensitive` 全库扫描耗时、
是否触发过 3 MiB 水位。没有读数就不要合这一刀——spec §12 等的就是这三个数。）

## 已知：包还吃不进去
车道 C（`POST /receive` + 幂等两列 + 整包退出）未到。现在收到包的人只能把它当
一份人可读的 Markdown 之外的 JSON 存着。
```

- [ ] **Step 4: README 挂链接**

`dsh-mneme/README.md` 的文档索引处（`:710` 那一族里）加一行指向 `docs/SHARE.md`，一句话说明「导出分享包发人」。若该 README 有中英两份并列的结构，两处都加 —— 孪本过期是 `test` 看不见的那类漂移。

- [ ] **Step 5: 全绿并提交**

```bash
npm test
git add SECURITY.md dsh-mneme/docs/SHARE.md dsh-mneme/README.md
git commit -m "docs(share): document the pack, its skips and the size water mark"
```
Expected: `npm test` 全绿（含 check-sync；A1-A7 每刀的 sync 都跑过，这里只兜底）。

---

## 车道 B：把「不改写」提前落到池子上

车道 B 在车道 C **之前**合，因为它此时完全惰性（库里还没有 `source = 'imported'` 的行，谓词一次都不命中），所以「导入的包会被对方巩固改写」那个空窗根本不会出现。spec §13 有这一段理由。

### Task B1: `isImportedRow` 与 `saveWithDedupe` 汇流口

**Files:**
- Create: `src/memory-source.js`
- Modify: `src/service.js:1371`、`:1389-1391`
- Test: `test/share-imported-guard.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `IMPORTED_SOURCE = "imported"`、`isImportedRow(m) -> boolean`；`saveWithDedupe` 不再可能把新内容并进 imported 行

- [ ] **Step 1: 写失败测试**

创建 `test/share-imported-guard.test.js`：

```js
// 「外来记忆不被改写」的行为锁 + 静态锁。
// 行为锁盯汇流口：saveWithDedupe 是 appendContent 改写的总入口（蒸馏路径与
// _mergeInto 显式目标都从这过），堵在这里等于在所有写入侧同时封口。
// 静态锁盯池子：巩固/降级读的是各自的行池，堵了汇流口不等于堵了它们——
// 池子里还有 setArchived / demoteToSummary 这些不经 saveWithDedupe 的动作。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { IMPORTED_SOURCE, isImportedRow } from "../src/memory-source.js";

const here = dirname(fileURLToPath(import.meta.url));

test("the predicate is the only definition of foreign-ness", () => {
  assert.equal(IMPORTED_SOURCE, "imported");
  assert.equal(isImportedRow({ source: "imported" }), true);
  assert.equal(isImportedRow({ source: "dream" }), false);
  assert.equal(isImportedRow(null), false);
  assert.equal(isImportedRow({ source: "Imported" }), false); // 精确匹配，不做大小写魔法
});

test("saveWithDedupe never merges into an imported row", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-imported-guard-"));
  const store = createStore(join(dir, "memory.db"));
  try {
    const service = createService({ store, mirror: null, config: {} });
    const foreign = store.save({ type: "decision", title: "选 SQLite", content: "对方的原文", tags: [], source: IMPORTED_SOURCE });
    const before = store.getById(foreign.id);
    const out = service.saveWithDedupe({ type: "decision", title: "选 SQLite", content: "我自己的新结论", tags: [] });
    assert.equal(out.action, "created", "same title+scope must NOT physically merge into a foreign row");
    assert.notEqual(out.memory.id, foreign.id);
    const after = store.getById(foreign.id);
    assert.equal(after.content, before.content);
    assert.equal(after.updated_at, before.updated_at, "a foreign row's updated_at must not move");
  } finally {
    try { store.close(); } catch { /* closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑到失败**

Run: `node --test test/share-imported-guard.test.js`
Expected: FAIL —— `Cannot find module ... src/memory-source.js`

- [ ] **Step 3: 写谓词与汇流口**

创建 `src/memory-source.js`：

```js
// 记忆的来源身份里唯一需要跨模块判定的一维：外来行。
// 车道 C 导入的行走 store.save 直接落 source='imported'，因此它可能出现在任何行池里；
// 本谓词是「不许改写别人原文」这条契约的唯一实现。判据精确匹配、不做大小写魔法：
// source 是机器写的列，任何大小写变体都该被当成「不是外来行」而不是当成外来行。
export const IMPORTED_SOURCE = "imported";

export function isImportedRow(m) {
  return m?.source === IMPORTED_SOURCE;
}
```

改 `src/service.js`。`:1371` 那一行（候选集）：

```js
    const candidates = store.list({ type: memory.type, limit: 100 }).filter((m) => !isImportedRow(m));
```

`:1389-1391` 的显式目标（`_mergeInto` 那条路）改成：

```js
    const explicitCandidate = memory._mergeInto ? store.getById(memory._mergeInto) : undefined;
    const explicitTarget = explicitCandidate && !isImportedRow(explicitCandidate) ? explicitCandidate : undefined;
```

并在 `src/service.js` 顶部 import 区补 `import { isImportedRow } from "./memory-source.js";`。

> 注释要写「为什么」：这两处不是防呆，是防**别人的原文被我们的 LLM 并入他自己的行**（spec §5 决策 2）。`store.list` 那处过滤掉候选、`_mergeInto` 那处把显式目标降级为「未命中」，两条都落到既有的「新建一行」分支上 —— 不新增第三种结局。

- [ ] **Step 4: 跑到通过**

Run: `node --test test/share-imported-guard.test.js`
Expected: PASS（两条）

- [ ] **Step 5: 同步并提交**

```bash
npm run sync
node --test test/distill.test.js test/summarize.test.js   # 若这两个文件名不同，跑 npm test 兜底
git add src/memory-source.js src/service.js test/share-imported-guard.test.js lib/memory-source.js lib/service.js
git commit -m "feat(share): stop consolidation merges from rewriting imported rows"
```

---

### Task B2: 九处行池挂谓词 + 静态锁

**Files:**
- Modify: `src/dream.js:60,489,1017,1479`
- Modify: `src/dream/sleep.js:208,447,~498,589`
- Modify: `src/organize.js:155-164`
- Test: `test/share-imported-guard.test.js`（追加静态锁）

**Interfaces:**
- Consumes: `isImportedRow`（B1）
- Produces: 巩固、降级、模式扫描、关系补全、整理并入五类动作都不再看见外来行

- [ ] **Step 1: 先写静态锁（它比行为测试便宜，且是唯一能防「将来漏加一处」的锁）**

追加到 `test/share-imported-guard.test.js`：

```js
const POOL_SITES = [
  ["src/dream.js", "const memories = withoutPaused(service, service.all().filter((m) => !isImportedRow(m) && !m.archived && m.type !== \"summary\" && m.type !== \"document\"));"],
  ["src/dream.js", "const inputs = withoutPaused(service, service.all().filter((m) => !isImportedRow(m) && !m.archived && !m.forgotten && m.type !== \"summary\" && m.type !== \"document\"));"],
  ["src/dream.js", "let memories = withoutPaused(service, service.all().filter((m) => !isImportedRow(m) && !m.archived && m.type !== \"summary\" && m.type !== \"document\"));"],
  ["src/dream.js", "const summaryAll = withoutPaused(service, service.all().filter((m) => !isImportedRow(m) && !m.archived && m.type !== \"summary\" && m.type !== \"document\"));"],
  ["src/dream/sleep.js", "const memories = withoutPaused(service, service.all().filter((m) => !isImportedRow(m) && !m.archived && !m.forgotten && m.type !== \"summary\" && m.type !== \"document\"));"],
  ["src/dream/sleep.js", "for (const m of withoutPaused(service, service.all().filter((m) => !isImportedRow(m)))) {"],
  ["src/dream/sleep.js", "!isImportedRow(m) && !m.archived && m.type !== \"summary\" && m.type !== \"pattern\""],
  ["src/dream/sleep.js", "const memories = withoutPaused(service, service.all().filter((m) => !isImportedRow(m) && !m.archived && !m.forgotten));"],
  ["src/organize.js", "store.list({ type: candidate.type, limit: null }).filter((m) => !isImportedRow(m) && !m.archived && scopeMatches(m, candidate))"]
];

test("every row pool that can rewrite or archive is guarded", () => {
  for (const [file, needle] of POOL_SITES) {
    assert.ok(readFileSync(resolve(here, "..", file), "utf8").includes(needle),
      `${file} must guard its row pool with isImportedRow: ${needle.slice(0, 60)}`);
  }
});

test("dream.js has no unguarded service.all() pool left", () => {
  const text = readFileSync(resolve(here, "../src/dream.js"), "utf8");
  const offenders = text.split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([ , line]) => line.includes("service.all()") && !line.includes("isImportedRow") && !line.includes("m.source === \"dream\""));
  assert.deepEqual(offenders, [], `unguarded pools at ${offenders.map(([n]) => n).join(", ")}`);
});
```

（`readFileSync`、`resolve`、`here` 在文件顶部已导入；若缺 `resolve`/`here` 就照本文件已有的那组 import 补齐，别再引一份。）

- [ ] **Step 2: 跑到失败**

Run: `node --test test/share-imported-guard.test.js`
Expected: FAIL —— 第一条静态锁报出缺哪个文件的哪一句

- [ ] **Step 3: 按 POOL_SITES 逐处改（每处只是把谓词放到既有 `.filter` 的最前面）**

`src/dream.js` 四处，逐字对照静态锁里的字符串：`:60`（`memories`，触发阈值用）、`:489`（`inputs`，叙述生成）、`:1017`（`memories`，**巩固真正读的那份快照**）、`:1479`（`summaryAll`，dream 总览输入）。四处都是 `withoutPaused(service, service.all().filter(...))` 的同一形状，把 `!isImportedRow(m) &&` 加在 filter 谓词开头。`:1519` 那句 `service.all().find((m) => m.type === "summary" && m.source === "dream")` **不改** —— 它按 `source === "dream"` 取行，外来行按构造不可能命中，加了反而是噪声。

`src/dream/sleep.js` 四处：`:208` 池子、`:447` 那个 `for (const m of withoutPaused(service, service.all()))`（下面直接 `setArchived` / `demoteToSummary`，是本车道最要紧的一处）、`:~498` 的 `service.list({ limit: 200, includeForgotten: false, excludeTypes: ["document"] }).filter(...)`、`:589` 的关系补全池。

`src/organize.js` 一处（`:155-164` 的 `rowsFor`）：

```js
      rowsByScope.set(key,
        store.list({ type: candidate.type, limit: null }).filter((m) => !isImportedRow(m) && !m.archived && scopeMatches(m, candidate)));
```

三个文件各自顶部补 `import { isImportedRow } from "../memory-source.js";`（`dream/sleep.js` 用 `../memory-source.js`，其余用 `./memory-source.js`）。

- [ ] **Step 4: 跑到通过 + 回归**

```bash
node --test test/share-imported-guard.test.js
npm run sync
node --test test/dream.test.js test/sleep.test.js test/organize.test.js
```
Expected: 静态锁 PASS；巩固/睡眠/整理三份既有测试不转红（若文件名不同，跑 `npm test` 兜底）。

> 若某处既有测试转红，先怀疑自己把谓词放错了位置（比如放进 `withoutPaused` 里面或漏在最内层），而不是去改那条测试的期望 —— 这些测试是既有性质的锁。

- [ ] **Step 5: 提交**

```bash
git add src/dream.js src/dream/sleep.js src/organize.js test/share-imported-guard.test.js lib/dream.js lib/dream/sleep.js lib/organize.js
git commit -m "feat(share): guard every row pool consolidation reads from"
```

---

### Task B3: 域文档补一句「外来区」与全绿

**Files:**
- Modify: `dsh-mneme/docs/SHARE.md`（新增一节）
- Modify: `dsh-mneme/docs/SLEEP.md` 与 `dsh-mneme/docs/DISTILL.md`（各加一句外来行不参与巩固/并入口径，若这两份文档确实描述对应行为）

- [ ] **Step 1: 写清「本刀还吃不了」**

在 `docs/SHARE.md` 加一节，明写车道 B 合完之后：**本库不会巩固外来行**，但对面此刻还**没有** `receive` 可用（车道 C 未到），外来行只能由车道 C 产生。这一节存在的意义是防止看文档的人以为「守卫上了就能导入」。

- [ ] **Step 2: 顺手扫另外两份文档是否过期**

`docs/SLEEP.md` 描述降级/归档分层（本刀改了 `sleep.js:447` 那圈），`docs/DISTILL.md`/整理相关文档描述并入口径（改了 `organize.js`）。各加一句「`source='imported'` 的行不参与」；如果该文档根本不描述这一层，就别硬塞 —— 文档清扫纪律是「改到位」，不是「每份都改」。

- [ ] **Step 3: 全绿**

```bash
npm test
```
Expected: 全绿（含 check-sync、contrast、security-doc、api 旗标计数 103 不动）。

- [ ] **Step 4: 提交**

```bash
git add dsh-mneme/docs/SHARE.md dsh-mneme/docs/SLEEP.md
git commit -m "docs(share): record that imported rows stay out of consolidation"
```

---

## 收尾清单（两车道合完后逐项确认）

- [ ] `npm test` 在 ubuntu 与 windows × node 22/24 的口径下都过（本地至少跑一次全量）。
- [ ] `test/api.test.js:753` 的 `103` 没被动过 —— 本计划不该加配置键，加了就说明实现跑偏。
- [ ] SECURITY.md 双语两处都有 `/share`，`test/security-doc.test.js` 双向比对绿。
- [ ] `docs/SHARE.md` 的「代价与实测」有真读数，不是空表。
- [ ] 每个提交都没有 AI 署名、没有任何 `Co-Authored-By` trailer：`git log -3 --format=%B` 逐条看一眼。
- [ ] 车道 C 的待办：真库条数 → 包体积的读数决定水位与分批文案（spec §12）。
