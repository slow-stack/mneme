// 左侧「ta 的日记」面板读的是**跨桶**清单——它长在 `main` 座位上，宿主不给它
// sessionId，所以算不出「当前会话的项目根」。这套用例锁的就是那条路径：
// 谁被算成一个桶、谁被跳过、谁的名字从 frontmatter 来而不是从目录名猜。
//
// 反面教材是 #613 的双桶：同一个项目因为历史原因落了两个目录键
// （`QQ对话-4f061790` 与 `QQ---4f061790`），面板若按目录名认人就会把同一本日记
// 挂成两个人。所以这里有一条用例专门断言「名字取自 frontmatter 的 persona」。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDiaryLibrary, readLibraryEntry, isBucketName } from "../src/diary/index.js";

/** 造一个临时 memoryDir，里面的 diaries/ 按给定的桶与日期铺开。 */
function fixture(buckets) {
  const memoryDir = mkdtempSync(join(tmpdir(), "mneme-diary-lib-"));
  const root = join(memoryDir, "diaries");
  mkdirSync(root, { recursive: true });
  for (const [bucket, files] of Object.entries(buckets)) {
    const dir = join(root, bucket);
    mkdirSync(dir, { recursive: true });
    for (const [date, text] of Object.entries(files)) {
      writeFileSync(join(dir, `${date}.md`), text, "utf8");
    }
  }
  return { memoryDir, root };
}

function entry({ persona = "", project = "p", body = "正文" } = {}) {
  const lines = ["---", "date: 2026-11-08"];
  if (project) lines.push(`project: ${project}`);
  if (persona) lines.push(`persona: ${persona}`);
  lines.push("---", "", body, "");
  return lines.join("\n");
}

test("按桶列出日记，名字取自 frontmatter 的 persona 而不是目录名", (t) => {
  // 两个桶是同一个项目（#613 的双桶现场）：目录名一个保留中文、一个被洗成 -。
  // 面板要显示的是「amarre」与「ptc」，不是那两个目录键。
  const { memoryDir } = fixture({
    "QQ对话-4f061790": { "2026-11-07": entry({ persona: "settings (amarre)", project: "QQ对话-4f061790" }) },
    "QQ---4f061790": { "2026-11-08": entry({ persona: "default (ptc)", project: "QQ---4f061790" }) }
  });
  t.after(() => rmSync(memoryDir, { recursive: true, force: true }));

  const { buckets } = listDiaryLibrary({ memoryDir });
  assert.equal(buckets.length, 2);
  const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));
  assert.equal(byKey["QQ对话-4f061790"].persona, "settings (amarre)");
  assert.equal(byKey["QQ---4f061790"].persona, "default (ptc)");
  // 桶键原样保留（面板要用它拼路由），没被改写。
  assert.ok(byKey["QQ---4f061790"]);
});

test("新的在前；每桶带 latest / count / entries", (t) => {
  const { memoryDir } = fixture({
    a: {
      "2026-11-05": entry({ persona: "default (x)" }),
      "2026-11-08": entry({ persona: "default (x)" }),
      "2026-11-06": entry({ persona: "default (x)" })
    },
    b: { "2026-11-01": entry({ persona: "default (y)" }) }
  });
  t.after(() => rmSync(memoryDir, { recursive: true, force: true }));

  const { buckets } = listDiaryLibrary({ memoryDir });
  assert.deepEqual(buckets.map((x) => x.key), ["a", "b"], "按 latest 倒序");
  assert.equal(buckets[0].latest, "2026-11-08");
  assert.equal(buckets[0].count, 3);
  assert.deepEqual(buckets[0].entries.map((e) => e.date), ["2026-11-08", "2026-11-06", "2026-11-05"]);
  assert.equal(buckets[1].latest, "2026-11-01");
});

test("空桶、回收站、非日记文件都不算一本", (t) => {
  const { memoryDir, root } = fixture({
    real: { "2026-11-08": entry({ persona: "default (x)" }) }
  });
  t.after(() => rmSync(memoryDir, { recursive: true, force: true }));
  // 只有 runs.jsonl 的桶：文件被删光之后的样子。
  mkdirSync(join(root, "hollow"), { recursive: true });
  writeFileSync(join(root, "hollow", "runs.jsonl"), "{}\n", "utf8");
  // 回收站：以点开头。
  mkdirSync(join(root, ".deleted"), { recursive: true });
  writeFileSync(join(root, ".deleted", "2026-11-08.md"), entry(), "utf8");
  // 根目录下的散落文件不是桶。
  writeFileSync(join(root, "stray.md"), "x", "utf8");

  const { buckets } = listDiaryLibrary({ memoryDir });
  assert.deepEqual(buckets.map((b) => b.key), ["real"],
    "只有 runs.jsonl 的桶、.deleted 回收站、根下的散文件都不该出现在导航栏里");
});

test("读不到 diaries 根目录时返回空清单，不抛", () => {
  const { buckets } = listDiaryLibrary({ memoryDir: join(tmpdir(), "mneme-no-such-dir-xyz") });
  assert.deepEqual(buckets, []);
});

test("第一篇没 persona 时往下找：同一桶里先后住过两个人才是 #613 要拆的形状", (t) => {
  const { memoryDir } = fixture({
    shared: {
      "2026-11-06": entry({ persona: "" }),            // 手工写的，没有 frontmatter persona
      "2026-11-07": entry({ persona: "settings (amarre)" })
    }
  });
  t.after(() => rmSync(memoryDir, { recursive: true, force: true }));

  const { buckets } = listDiaryLibrary({ memoryDir });
  assert.equal(buckets[0].persona, "settings (amarre)", "跳过没 persona 的那篇，取第一篇带它的");
});

test("读一篇：桶名与日期都是路径成分，越界一律读不到", (t) => {
  const { memoryDir, root } = fixture({ ok: { "2026-11-08": entry({ body: "今天很好" }) } });
  t.after(() => rmSync(memoryDir, { recursive: true, force: true }));
  // **诱饵**：root 外面放一个真能被读到的文件。只断言「返回 null」是不够的
  // ——桶名那一层挡不住时，`join` 会真的读到它；没有这个诱饵，校验坏了用例也绿。
  const leak = join(memoryDir, "leak");
  mkdirSync(leak, { recursive: true });
  writeFileSync(join(leak, "2026-11-08.md"), "根外面的东西", "utf8");
  mkdirSync(join(root, "ok"), { recursive: true });

  assert.match(readLibraryEntry({ memoryDir, bucket: "ok", date: "2026-11-08" }), /今天很好/);
  // 这三种都是「不能让它们拼进路径」的形状；命中诱饵就说明校验漏了。
  assert.equal(readLibraryEntry({ memoryDir, bucket: "..", date: "2026-11-08" }), null);
  assert.equal(readLibraryEntry({ memoryDir, bucket: "../leak", date: "2026-11-08" }), null);
  assert.equal(readLibraryEntry({ memoryDir, bucket: "ok/../../leak", date: "2026-11-08" }), null);
  // 合法但不存在 → null（面板据此显示「读不出」而不是空框）。
  assert.equal(readLibraryEntry({ memoryDir, bucket: "ok", date: "2026-01-01" }), null);
});

test("桶名判据挡的是路径语义，不是字符集", () => {
  // 挡：分隔符、上跳、控制字符、首尾空白、`.` 与 `..`。
  for (const bad of ["..", "../x", "a/b", "a\\b", "", ".", " a", "a ", "a\u0000b"]) {
    assert.equal(isBucketName(bad), false, `不该接受桶名 ${JSON.stringify(bad)}`);
  }
  // 不挡：合法的单层目录名。**中文不在这道判据里**——历史上真有一个保留中文的
  // 桶（`QQ对话-4f061790`），按字符集白名单会把它列出来却读不到。
  for (const ok of ["QQ---4f061790", "amarre-c836db6a", "QQ对话-4f061790", "a b"]) {
    assert.equal(isBucketName(ok), true, `该接受桶名 ${JSON.stringify(ok)}`);
  }
});

test("历史桶名带中文也要能读（#613 的双桶就有一个是那样）", (t) => {
  // 上一版 `projectKey` 只留 ASCII，但现场确实存在一个保留中文的桶
  // （用户那次让另一个会话手工写的）。清单与读取必须用同一道判据，否则就是
  // 「列得出来、点进去读不到」——用户看到的是点了没反应。
  const { memoryDir } = fixture({ "QQ对话-4f061790": { "2026-11-07": entry({ body: "旧的那篇" }) } });
  t.after(() => rmSync(memoryDir, { recursive: true, force: true }));

  const { buckets } = listDiaryLibrary({ memoryDir });
  assert.deepEqual(buckets.map((b) => b.key), ["QQ对话-4f061790"],
    "带中文的桶名必须出现在清单里——它是真实存在的历史桶，跳过它等于把用户写过的日记藏起来");
  assert.match(readLibraryEntry({ memoryDir, bucket: "QQ对话-4f061790", date: "2026-11-07" }), /旧的那篇/,
    "清单里列得出来就必须读得到，不能只做一半");
});
