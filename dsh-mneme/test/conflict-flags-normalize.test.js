// 面板写入侧的原子归一（src/settings.js 的 setFeatureFlags）。
//
// 背景：conflictFreezeEnabled 与 conflictLedgerMode 分属两张互不感知的白名单
// （布尔表与枚举表），历史上可以任意组合；组合成 freeze+enforce 时三个消费方
// 给出三种答案（见 src/conflict-mode.js 的文件头）。运行期解析（resolveConflictMode）
// 兜住「读出来的值」，这里兜住「写进去的值」——面板上点掉一个，另一个自动退让，
// 不再产生新的双开库。
//
// 为什么必须在 setFeatureFlags 里做、不能等运行期：面板改开关是**下次启动才生效**
// （src/index.js 启动时才把 kv 合并进 cfg）。归一落在写入那一刻，存的就已经是单选，
// 重启后读到的自然是单选。
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createSettings } from "../src/settings.js";

function setup() {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  return { store, settings };
}

// ---------------------------------------------------------------- 两条顺序

test("#641 归一：选 enforce 时自动关掉 freeze（同一笔写入的结果）", () => {
  const { store, settings } = setup();
  // 先造出「freeze 开着、档位 off」的起点
  settings.setFeatureFlags({ conflictFreezeEnabled: true });
  assert.equal(settings.getFeatureFlags().conflictFreezeEnabled, true);

  // 现在把档位拨到 enforce —— 这一次写入必须同时把 freeze 关掉
  const returned = settings.setFeatureFlags({ conflictLedgerMode: "enforce" });
  assert.equal(returned.conflictLedgerMode, "enforce");
  assert.equal(returned.conflictFreezeEnabled, false,
    "返回值就要是归一后的：调用方（面板）拿它刷新快照，晚一步会短暂显示双开");

  // 持久化的那份也必须已经归好，不能只在返回值里好看
  const stored = settings.getFeatureFlags();
  assert.equal(stored.conflictLedgerMode, "enforce");
  assert.equal(stored.conflictFreezeEnabled, false,
    "落库那份必须是单选——重启后读的就是它");
  store.close();
});

test("#641 归一：打开 freeze 时把 enforce 降成 shadow（另一条顺序）", () => {
  const { store, settings } = setup();
  settings.setFeatureFlags({ conflictLedgerMode: "enforce" });
  assert.equal(settings.getFeatureFlags().conflictLedgerMode, "enforce");

  const returned = settings.setFeatureFlags({ conflictFreezeEnabled: true });
  assert.equal(returned.conflictFreezeEnabled, true);
  assert.equal(returned.conflictLedgerMode, "shadow",
    "开冻结 = 我要人审，enforce 的自动处置必须退场；降 shadow 而不是 off，保住记账");

  const stored = settings.getFeatureFlags();
  assert.equal(stored.conflictFreezeEnabled, true);
  assert.equal(stored.conflictLedgerMode, "shadow");
  store.close();
});

// ---------------------------------------------------------------- 不该动的

test("#641 归一：只在 patch 真碰这两个键时才归一，写别的键不牵动它们", () => {
  const { store, settings } = setup();
  // 造一个双开的老库状态：直接用底层 kv 写进去（模拟旧版本留下的存量数据）。
  // 走 setFeatureFlags 是进不去的——那正是本测试要对比的行为。
  store.db.prepare("INSERT OR REPLACE INTO user_settings (key, value) VALUES ('feature_flags', ?)")
    .run(JSON.stringify({ conflictFreezeEnabled: true, conflictLedgerMode: "enforce" }));
  assert.deepEqual(
    { freeze: settings.getFeatureFlags().conflictFreezeEnabled, mode: settings.getFeatureFlags().conflictLedgerMode },
    { freeze: true, mode: "enforce" },
    "起点：存量双开"
  );

  // 改一个无关键：不许顺手把存量双开「修」掉。用户没点这两格，就别替他做决定——
  // 老库保持原样，运行期由 resolveConflictMode 兜（它会算出 shadow）。
  settings.setFeatureFlags({ dreamMaxMergePerRun: 40 });
  const after = settings.getFeatureFlags();
  assert.equal(after.conflictFreezeEnabled, true, "无关写入不许牵动 freeze");
  assert.equal(after.conflictLedgerMode, "enforce", "无关写入不许牵动档位");
  store.close();
});

test("#641 归一：freeze 开 + off/shadow 是正常叠加，不强行改档位", () => {
  const { store, settings } = setup();
  settings.setFeatureFlags({ conflictFreezeEnabled: true });
  for (const mode of ["off", "shadow"]) {
    const got = settings.setFeatureFlags({ conflictLedgerMode: mode });
    assert.equal(got.conflictLedgerMode, mode, `${mode} 不需要被归一改掉`);
    assert.equal(got.conflictFreezeEnabled, true, "freeze 也不该被关掉——两者不冲突");
  }
  store.close();
});

test("#641 归一：off 是显式选择，不自动关 freeze", () => {
  const { store, settings } = setup();
  settings.setFeatureFlags({ conflictFreezeEnabled: true });
  const got = settings.setFeatureFlags({ conflictLedgerMode: "off" });
  assert.equal(got.conflictLedgerMode, "off");
  assert.equal(got.conflictFreezeEnabled, true, "off + freeze 合法：两条路都通向人审队列");
  store.close();
});

test("#641 归一：一笔写入同时带两个键时，以 enforce 一侧为准且不来回互踢", () => {
  const { store, settings } = setup();
  // 面板一次只发一个键，但 API 是公开的（curl / 脚本 / 别的插件都可能一次发两个）。
  // 结果是确定的：档位 enforce 胜，freeze 关。
  const got = settings.setFeatureFlags({ conflictFreezeEnabled: true, conflictLedgerMode: "enforce" });
  assert.equal(got.conflictLedgerMode, "enforce");
  assert.equal(got.conflictFreezeEnabled, false,
    "两个键同时来时必须收敛到一个确定结果，不许留下双开");
  store.close();
});

test("#641 归一：非法值仍走原来的校验，不被归一掩盖", () => {
  const { store, settings } = setup();
  assert.throws(() => settings.setFeatureFlags({ conflictLedgerMode: "bogus" }), TypeError,
    "枚举外取值必须照样抛，归一不能变成兜底吞错");
  assert.throws(() => settings.setFeatureFlags({ conflictFreezeEnabled: "yes" }), TypeError,
    "布尔键传字符串必须照样抛");
  store.close();
});
