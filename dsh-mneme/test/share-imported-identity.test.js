// spec §15 二（车道 C9）：镜像里手改一条外来记忆是**允许**的——那是接收方自己磁盘上的字，
// 把刚打进去的内容静默改回去是比「改写」更糟的失效（他会以为编辑生效了，而文件下一次同步又被抹平）。
// 这里锁的不是「改不了」，而是改完之后身份还在：source 仍是 imported、两个 scope 仍是 NULL、
// share 两列原样。车道 B 的九个行池与汇流口全按 source 认外来行——若「编辑一次正文」能顺手改
// 归属，「改一下正文再摘掉守卫」就成了绕开整套契约的合法手段。
//
// 为什么这条锁今天就该是绿的、绿了仍然有价值：store.update 的 SET 白名单**含** source 与两个
// scope（src/store.js:1353——patch 显式携带该键才改写，否则保留既有），share_pack_id /
// share_external_id 则压根不在 UPDATE 语句里（身份两件套只由 save 铸造）。所以本锁防的回归
// 不是列的意外，而是有人给「人改回填」的 patch 加「按内容重归属/清 scope」这类便利——
// spec 裁定二点名不许做的事。两条用例各咬一条回填路线，缺一不可：
//   ① mergeHumanEdits——启动回灌与 /import 走的显式合并；
//   ② reconcileHumanEdits——每次 syncMirror 都跑的三方合并，专收两次业务写之间的手改。
// 只锁 ① 的话，② 随时可以在无人察觉时长出口子（它今天是照改外来行正文的，这是裁定）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { IMPORTED_SOURCE } from "../src/memory-source.js";
import { parseHumanEdits, renderMirrorText, createMirror } from "../src/mirror.js";

const FOREIGN_PACK_ID = "f0f0f0f0f0f0f0f0";
const FOREIGN_EXTERNAL_ID = "deadbeef00000099";

function seedForeignRow(store) {
  return store.save({
    type: "preference",
    title: "别人的偏好",
    content: "对方的原文初稿",
    tags: [],
    source: IMPORTED_SOURCE,
    share_pack_id: FOREIGN_PACK_ID,
    share_external_id: FOREIGN_EXTERNAL_ID
  });
}

// 断言全部走「身份四件套 + 归档位」这一组：正文改了是**预期**（裁定一），这些没动才是本锁。
function assertIdentityIntact(after, where) {
  assert.equal(after.source, IMPORTED_SOURCE, `editing the body must not demote the row out of the foreign set (${where})`);
  assert.equal(after.agent_scope, undefined, `a hand edit must not mint a scope onto a foreign row (${where})`);
  assert.equal(after.workspace_scope, undefined, `same for the workspace axis (${where})`);
  assert.equal(after.share_pack_id, FOREIGN_PACK_ID, `the pack addressing key is minted by save and must survive (${where})`);
  assert.equal(after.share_external_id, FOREIGN_EXTERNAL_ID, `the idempotency key likewise (${where})`);
  assert.equal(after.archived, false, `a hand edit is not an archive action (${where})`);
}

test("mergeHumanEdits rewrites a foreign row's body but never its guard identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-imported-identity-"));
  const store = createStore(join(dir, "memory.db"));
  try {
    const service = createService({ store, mirror: null, config: {} });
    const foreign = seedForeignRow(store);

    // 条目块由真渲染器（renderMirrorText → renderMemory）生成，测试只手改正文那一段。
    // 手写中文字段标签会跟 STR.mirrorLabel 漂移，而漂移的失败形态是 parseHumanEdits
    // 解析出 0 条——测试会空转着绿（假通过）。下面两条前置断言就是防这个的。
    const rendered = renderMirrorText("preference", [store.getById(foreign.id)], "zh");
    const markdown = rendered.replace("对方的原文初稿", "我改过的正文");
    assert.notEqual(markdown, rendered, "the human edit must actually land in the mirror text");

    const edits = parseHumanEdits(markdown);
    assert.equal(edits.length, 1, "the edited block must parse as exactly one entry, or this test is vacuous");
    assert.equal(edits[0].id, foreign.id);
    assert.equal(edits[0].content, "我改过的正文", "parse must see the edited body, not the machine metadata run");

    assert.equal(service.mergeHumanEdits("preference", edits), 1, "the edit must be applied, not silently discarded");

    const after = store.getById(foreign.id);
    assert.equal(after.content, "我改过的正文", "the hand edit lands — silently reverting it is the worse failure (spec §15 二)");
    assert.equal(after.title, "别人的偏好", "title untouched by this edit stays put");
    assertIdentityIntact(after, "mergeHumanEdits");
  } finally {
    try { store.close(); } catch { /* closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcileHumanEdits (the syncMirror re-ingest route) rewrites the body and keeps the identity too", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-imported-identity-sync-"));
  const store = createStore(join(dir, "memory.db"));
  try {
    const mirror = createMirror(join(dir, "mirror"));
    const service = createService({ store, mirror, config: {} });
    const foreign = seedForeignRow(store);

    // 业务写触发 syncMirror：外来行第一次落到 preferences.md（渲染器写出的 digest 是
    // 渲染时正文的哈希——人工改完正文它就失配，这正是 reconcile 认「有人动过」的判据）。
    service.saveWithDedupe({ type: "decision", title: "我自己的决定", content: "本机写入", tags: [] });
    const file = mirror.filePath("preference");
    assert.ok(existsSync(file), "the mirror must have rendered the foreign row to disk");

    const text = readFileSync(file, "utf8");
    const edited = text.replace("对方的原文初稿", "同步间隙里改的正文");
    assert.notEqual(edited, text, "the human edit must land in the file on disk");
    writeFileSync(file, edited, "utf8");

    // 第二次业务写：syncMirror 先跑 reconcileHumanEdits，把这份「两次写之间」的手改
    // 三方合并回库——本用例锁的就是这条路线改完之后身份还在。
    service.saveWithDedupe({ type: "decision", title: "另一个本机决定", content: "又是本机写入", tags: [] });

    const after = store.getById(foreign.id);
    assert.equal(after.content, "同步间隙里改的正文", "the edit survives the re-ingest route; it is not machine-washed");
    assertIdentityIntact(after, "reconcileHumanEdits");
  } finally {
    try { store.close(); } catch { /* closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
