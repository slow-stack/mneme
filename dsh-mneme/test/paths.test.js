// 落盘路径的中性根：把「库必须住在 ~/.dsh」这条绑定拆掉，同时不许弄丢存量库。
//
// 这组测试同时是**能跑起来的验证**：不设任何 DSH 相关变量、把 HOME 指到一个空目录，
// 只靠默认值也能建库、写一条记忆、再读回来——即「不依赖 DSH 也能跑」。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MNEME_HOME_DIR,
  DB_FILE,
  mnemeHome,
  legacyHome,
  defaultMemoryDir,
  legacyMemoryDir,
  hasDb,
  resolveMemoryDir,
  explainResolution,
  resolveRuntimeDir,
  resolveModelCacheDir,
  expandHome
} from "../src/paths.js";

function sandbox(t) {
  const home = mkdtempSync(join(tmpdir(), "mneme-paths-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/** 干净环境：不继承任何 DSH/MNEME 变量，避免本机环境把断言带偏。 */
const cleanEnv = () => ({});

test("默认家目录是中性名，不再是 .dsh", () => {
  const home = "/home/u";
  assert.equal(mnemeHome({ env: cleanEnv(), home }), join(home, MNEME_HOME_DIR));
  assert.equal(defaultMemoryDir({ env: cleanEnv(), home }), join(home, MNEME_HOME_DIR, "memory"));
  // 旧家只在兼容期读，不能拿来当新建默认。
  assert.equal(legacyHome({ env: cleanEnv(), home }), join(home, ".dsh"));
  assert.equal(legacyMemoryDir({ env: cleanEnv(), home }), join(home, ".dsh", "memory"));
});

test("MNEME_HOME 做主、DSH_MNEME_HOME 降别名、新名优先", () => {
  const home = "/home/u";
  assert.equal(mnemeHome({ env: { MNEME_HOME: "/data/m" }, home }), "/data/m");
  assert.equal(mnemeHome({ env: { DSH_MNEME_HOME: "/data/old" }, home }), "/data/old");
  assert.equal(
    mnemeHome({ env: { MNEME_HOME: "/data/new", DSH_MNEME_HOME: "/data/old" }, home }),
    "/data/new",
    "两个都给时新名赢"
  );
  // 前导 ~ 要展开（配置里常写 ~/xxx）。
  assert.equal(mnemeHome({ env: { MNEME_HOME: "~/mx" }, home }), join(home, "mx"));
  // 空白不算给值。
  assert.equal(mnemeHome({ env: { MNEME_HOME: "   " }, home }), join(home, MNEME_HOME_DIR));
});

test("空闲机器上解析到新家（不会去碰 .dsh）", (t) => {
  const home = sandbox(t);
  const r = resolveMemoryDir("", { env: cleanEnv(), home });
  assert.equal(r.source, "default");
  assert.equal(r.dir, join(home, MNEME_HOME_DIR, "memory"));
});

test("存量兼容：旧目录里有 memory.db 就继续用它，不给用户换空库", (t) => {
  const home = sandbox(t);
  const old = join(home, ".dsh", "memory");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, DB_FILE), "not-a-real-db-but-present");

  const r = resolveMemoryDir("", { env: cleanEnv(), home });
  assert.equal(r.source, "legacy");
  assert.equal(r.dir, old);
  // 关键：解析出来的目录里确实还是那本库。
  assert.equal(hasDb(r.dir), true);
});

test("旧目录只是空壳（没有 memory.db）不构成理由，仍用新家", (t) => {
  const home = sandbox(t);
  mkdirSync(join(home, ".dsh", "memory"), { recursive: true }); // 空目录
  const r = resolveMemoryDir("", { env: cleanEnv(), home });
  assert.equal(r.source, "default");
  assert.equal(r.dir, join(home, MNEME_HOME_DIR, "memory"));
});

test("两边都有库、体积相当 → 认作已迁完，用新家，旧库留着不删", (t) => {
  const home = sandbox(t);
  const old = join(home, ".dsh", "memory");
  const next = join(home, MNEME_HOME_DIR, "memory");
  mkdirSync(old, { recursive: true });
  mkdirSync(next, { recursive: true });
  writeFileSync(join(old, DB_FILE), "old");
  writeFileSync(join(next, DB_FILE), "new");

  const r = resolveMemoryDir("", { env: cleanEnv(), home });
  assert.equal(r.source, "default");
  assert.equal(r.dir, next);
  assert.equal(r.conflict, undefined, "体积相当不算误建，不该报冲突");
  assert.equal(existsSync(join(old, DB_FILE)), true, "旧库必须原地留着，解析不删任何东西");
});

test("两边都有库、新库小到像误建 → 继续用旧库并报 conflict（不让一次误跑搬走主库）", (t) => {
  const home = sandbox(t);
  const old = join(home, ".dsh", "memory");
  const next = join(home, MNEME_HOME_DIR, "memory");
  mkdirSync(old, { recursive: true });
  mkdirSync(next, { recursive: true });
  // 主库 100KB，误跑长出来的空库 1KB —— 差两个数量级，正是线上那次的形状。
  writeFileSync(join(old, DB_FILE), Buffer.alloc(100 * 1024, 0x61));
  writeFileSync(join(next, DB_FILE), Buffer.alloc(1024, 0x62));

  const r = resolveMemoryDir("", { env: cleanEnv(), home });
  assert.equal(r.source, "legacy", "误建的库不能把主库顶掉");
  assert.equal(r.dir, old);
  assert.deepEqual(
    r.conflict && { nextDir: r.conflict.nextDir, oldDir: r.conflict.oldDir, nextBytes: r.conflict.nextBytes, oldBytes: r.conflict.oldBytes },
    { nextDir: next, oldDir: old, nextBytes: 1024, oldBytes: 100 * 1024 }
  );
  // 两个库都还在——我们不删任何东西，只是选哪本。
  assert.equal(existsSync(join(old, DB_FILE)), true);
  assert.equal(existsSync(join(next, DB_FILE)), true);
});

test("体积判据的边界：新库正好 10% 不算误建，略小于 10% 才算", (t) => {
  const home = sandbox(t);
  const old = join(home, ".dsh", "memory");
  const next = join(home, MNEME_HOME_DIR, "memory");
  mkdirSync(old, { recursive: true });
  mkdirSync(next, { recursive: true });
  writeFileSync(join(old, DB_FILE), Buffer.alloc(1000, 0x61));

  writeFileSync(join(next, DB_FILE), Buffer.alloc(100, 0x62)); // 正好 10%
  assert.equal(resolveMemoryDir("", { env: cleanEnv(), home }).dir, next);

  writeFileSync(join(next, DB_FILE), Buffer.alloc(99, 0x62)); // 9.9%
  assert.equal(resolveMemoryDir("", { env: cleanEnv(), home }).source, "legacy");
});

test("迁移后库更小但同量级（如压缩过）仍认新家", (t) => {
  const home = sandbox(t);
  const old = join(home, ".dsh", "memory");
  const next = join(home, MNEME_HOME_DIR, "memory");
  mkdirSync(old, { recursive: true });
  mkdirSync(next, { recursive: true });
  writeFileSync(join(old, DB_FILE), Buffer.alloc(1000, 0x61));
  writeFileSync(join(next, DB_FILE), Buffer.alloc(300, 0x62)); // 30%

  const r = resolveMemoryDir("", { env: cleanEnv(), home });
  assert.equal(r.source, "default");
  assert.equal(r.dir, next);
});

test("显式配置与 MNEME_MEMORY_DIR 永远赢，且不看目录里有没有库", (t) => {
  const home = sandbox(t);
  mkdirSync(join(home, ".dsh", "memory"), { recursive: true });
  writeFileSync(join(home, ".dsh", "memory", DB_FILE), "old");

  const byCfg = resolveMemoryDir("/explicit/dir", { env: cleanEnv(), home });
  assert.equal(byCfg.source, "config");
  assert.equal(byCfg.dir, "/explicit/dir");

  const byEnv = resolveMemoryDir("", { env: { MNEME_MEMORY_DIR: "/from/env" }, home });
  assert.equal(byEnv.source, "env");
  assert.equal(byEnv.dir, "/from/env");

  // 配置优先于环境变量（显式 > 环境）。
  const both = resolveMemoryDir("/explicit/dir", { env: { MNEME_MEMORY_DIR: "/from/env" }, home });
  assert.equal(both.source, "config");
});

test("DSH_MNEME_MEMORY_DIR 仍被认（老脚本不炸）", (t) => {
  const home = sandbox(t);
  const r = resolveMemoryDir("", { env: { DSH_MNEME_MEMORY_DIR: "/legacy/env" }, home });
  assert.equal(r.source, "env");
  assert.equal(r.dir, "/legacy/env");
  // 新名优先。
  const both = resolveMemoryDir("", {
    env: { MNEME_MEMORY_DIR: "/new/env", DSH_MNEME_MEMORY_DIR: "/legacy/env" },
    home
  });
  assert.equal(both.dir, "/new/env");
});

test("运行时与模型缓存也搬到中性家，旧目录在就继续用", (t) => {
  const home = sandbox(t);
  assert.equal(resolveRuntimeDir({ env: cleanEnv(), home }), join(home, MNEME_HOME_DIR, "runtime"));
  assert.equal(resolveModelCacheDir({ env: cleanEnv(), home }), join(home, MNEME_HOME_DIR, "models"));

  // 旧缓存存在（避免白下 200MB）→ 继续用旧的。
  mkdirSync(join(home, ".dsh", "mneme", "runtime"), { recursive: true });
  mkdirSync(join(home, ".dsh", "mneme", "models"), { recursive: true });
  assert.equal(resolveRuntimeDir({ env: cleanEnv(), home }), join(home, ".dsh", "mneme", "runtime"));
  assert.equal(resolveModelCacheDir({ env: cleanEnv(), home }), join(home, ".dsh", "mneme", "models"));
});

test("旧缓存的位置跟着 DSH_HOME 走，别人把家指到别处也不会白重下 200MB", (t) => {
  const home = sandbox(t);
  const dshHome = join(home, "elsewhere", "dsh");
  mkdirSync(join(dshHome, "mneme", "runtime"), { recursive: true });
  mkdirSync(join(dshHome, "mneme", "models"), { recursive: true });
  const env = { DSH_HOME: dshHome };

  assert.equal(resolveRuntimeDir({ env, home }), join(dshHome, "mneme", "runtime"));
  assert.equal(resolveModelCacheDir({ env, home }), join(dshHome, "mneme", "models"));
});

test("DSH_HOME 与 ~/.dsh 不同时，写死的老位置仍作为兼容候选（#744 review）", (t) => {
  const home = sandbox(t);
  const dshHome = join(home, "srv", "dsh");
  // 宿主声明了 DSH_HOME，但存量库还躺在写死的 ~/.dsh/memory 里（本 PR 之前的默认值）。
  const hardCoded = join(home, ".dsh", "memory");
  mkdirSync(hardCoded, { recursive: true });
  writeFileSync(join(hardCoded, DB_FILE), "the-real-old-db");

  const r = resolveMemoryDir("", { env: { DSH_HOME: dshHome }, home });
  assert.equal(r.dir, hardCoded, "旧库在写死的位置时也要认出来，不能开新空库");
  assert.equal(r.source, "legacy");
  // 宿主声明的家优先：两边都有库时先看 DSH_HOME 那个。
  const declaredDb = join(dshHome, "memory");
  mkdirSync(declaredDb, { recursive: true });
  writeFileSync(join(declaredDb, DB_FILE), "declared");
  assert.equal(resolveMemoryDir("", { env: { DSH_HOME: dshHome }, home }).dir, declaredDb);
});

test("旧库体积算上 -wal / -shm，WAL 里的已提交数据不会被当成小库（#744 review）", (t) => {
  const home = sandbox(t);
  const old = join(home, ".dsh", "memory");
  const next = join(home, MNEME_HOME_DIR, "memory");
  mkdirSync(old, { recursive: true });
  mkdirSync(next, { recursive: true });
  // 旧库主文件只有 1KB，但 WAL/SHM 里还有 130KB；新库 8KB。
  // 只量主文件的话 8KB > 1KB，会误判成「新库比旧库大」而搬走主库。
  writeFileSync(join(old, DB_FILE), Buffer.alloc(1024, 0x61));
  writeFileSync(join(old, `${DB_FILE}-wal`), Buffer.alloc(100 * 1024, 0x62));
  writeFileSync(join(old, `${DB_FILE}-shm`), Buffer.alloc(32 * 1024, 0x63));
  writeFileSync(join(next, DB_FILE), Buffer.alloc(8 * 1024, 0x64));

  const r = resolveMemoryDir("", { env: cleanEnv(), home });
  assert.equal(r.source, "legacy", "旧库足迹含 WAL，新库相对它小到像误建");
  assert.equal(r.dir, old);
});

test("expandHome 口径与其它模块一致", () => {
  const home = "/home/u";
  assert.equal(expandHome("~", home), home);
  assert.equal(expandHome("~/a/b", home), join(home, "a", "b"));
  assert.equal(expandHome("~\\a", home), join(home, "a"));
  assert.equal(expandHome("/abs", home), "/abs");
  assert.equal(expandHome("rel", home), "rel");
});

test("告警文案：误建走 warn 并带两个路径与体积，单纯存量走 info，正常情况不吭声", () => {
  const home = "/home/u";
  const conflict = {
    dir: join(home, ".dsh", "memory"),
    source: "legacy",
    conflict: {
      nextDir: join(home, MNEME_HOME_DIR, "memory"),
      oldDir: join(home, ".dsh", "memory"),
      nextBytes: 3 * 1048576,
      oldBytes: 845.9 * 1048576
    }
  };
  const w = explainResolution(conflict);
  assert.equal(w.level, "warn");
  // 两个路径都得在：只报一个，人没法自己判断该留哪个。
  assert.ok(w.message.includes(conflict.conflict.oldDir));
  assert.ok(w.message.includes(conflict.conflict.nextDir));
  assert.ok(w.message.includes("845.9MB"), `体积要人读：${w.message}`);
  assert.ok(w.message.includes("3.0MB"));
  // 逃生阀：真迁过去的人得知道怎么让它闭嘴。
  assert.ok(w.message.includes("MNEME_MEMORY_DIR"));

  const info = explainResolution({ dir: join(home, ".dsh", "memory"), source: "legacy" });
  assert.equal(info.level, "info");
  assert.ok(info.message.includes(join(home, ".dsh", "memory")));

  assert.equal(explainResolution({ dir: home, source: "default" }), null);
  assert.equal(explainResolution({ dir: home, source: "config" }), null);
  assert.equal(explainResolution(null), null);
});

// ——— 端到端：不依赖 DSH 也能跑起来 ———
// Amarre 要的「能跑的验证」：不设 DSH_HOME、HOME 指向空目录，只靠默认值建库、
// 写一条记忆、读回来。跑通即证明核心链路没有把 DSH 当前提。
test("不依赖 DSH 也能跑起来：默认根下建库 → 写入 → 读回", async (t) => {
  const home = sandbox(t);
  const { dir, source } = resolveMemoryDir("", { env: cleanEnv(), home });
  assert.equal(source, "default");
  assert.ok(!dir.includes(".dsh"), `库目录不该落在 .dsh 下：${dir}`);

  mkdirSync(dir, { recursive: true });
  const { createStore } = await import("../src/store.js");
  const store = createStore(join(dir, DB_FILE));
  assert.equal(existsSync(join(dir, DB_FILE)), true);

  const saved = store.save({
    type: "history",
    title: "无 DSH 环境的第一条",
    content: "只靠 MNEME_HOME 默认值就能写进来。",
    importance: 3
  });
  assert.ok(saved?.id);

  const got = store.getById(saved.id);
  assert.equal(got.title, "无 DSH 环境的第一条");
  store.close();
});
