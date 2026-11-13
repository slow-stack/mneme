import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { testConfig } from "./helpers/test-config.js";

// 这条锁防的是一类「上限形同不存在」的回归：上限判断如果排在会抛错的那次读取
// 后面，轮询就永远不会停手。
//
// service.js 的 setEmbedder 为异步初始化的 embedder 起了个轮询：每 100ms 读一次
// `emb.ready`，读到 true 或撞上 EMBED_READY_POLL_LIMIT(=30) 就停
// （注释原文 "~3s ceiling; never poll forever"）。但 `ready` 是个 getter
// —— embedding.js 的 OpenAI embedder 直接读库 —— 于是写成
//     if (emb.ready === true || attempts >= EMBED_READY_POLL_LIMIT) { stop(); }
// 的整条 `||` 会在左半边当场中断，右半边的天花板永远轮不到：stopEmbedReadyPolling()
// 不执行，定时器活过上限，并且每 100ms 抛一次未捕获异常。
//
// 实测现场（2026-10-14，加蒸馏留存的装配级用例时撞上）：fiber.dispose() 走完
// index.js 的 disposer（末尾一句就是 store.close()）之后，每次读 ready 都抛
// "database is not open" [ERR_INVALID_STATE]，5s 内读了 46 次 —— 天花板 31 被
// 击穿，node --test 进程因此不再退出。一个只在启动时读一次库的 getter，能把
// 宿主的事件循环钉死；而现有测试全都「装配完不拆」，所以从 v0.7.1 起一直没人碰到。
//
// 时序照真实卸载顺序复现：安装时未就绪（轮询启动）→ store.close()（此后每次读
// ready 都抛）→ 等超过天花板 → 看它停没停手、报了几次。
const POLL_LIMIT = 30; // 与 src/service.js 的 EMBED_READY_POLL_LIMIT 同值，改那边要改这里
const POLL_MS = 100;
const CEILING_READS = 1 + POLL_LIMIT; // setEmbedder 自己读一次，之后每个 tick 一次
const SETTLE_MS = 400; // 静默这么久没新读取，就认为定时器已经停手
const DEADLINE_MS = 30000; // 上限：等到这里还没静默就按超时处理

// 等「读取次数不再增长」。不能用「睡够 POLL_MS*30 + 600ms 再断言」——
// 全量 npm test 是多文件并行跑的，CPU 一挤，30 个 tick 未必在 3.6s 内跑完，
// 断言就会读到 30 而不是 31（2026-10-15 rebase 后在全量跑里实测撞到一次，
// 单跑 3/3 通过、紧接着全量跑两遍也全绿——纯粹的负载抖动）。
// 静默判定是可靠的：定时器周期 100ms，而越过上限后 stopEmbedReadyPolling()
// 会 clearInterval，此后 reads 恒不再变，两者不会混淆。
async function waitUntilSettled(getReads) {
  const started = Date.now();
  let last = getReads();
  let lastChange = Date.now();
  while (Date.now() - started < DEADLINE_MS) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const now = getReads();
    if (now !== last) {
      last = now;
      lastChange = Date.now();
      continue;
    }
    if (Date.now() - lastChange >= SETTLE_MS) return now;
  }
  return getReads();
}

test("the embedder ready poll stops at its ceiling even when reading ready throws", async () => {
  const warns = [];
  const store = createStore(":memory:");
  const service = createService({
    store,
    mirror: null,
    config: testConfig({}),
    logger: { warn: (...args) => warns.push(args) }
  });

  let reads = 0;
  let closed = false;
  const embedder = {
    get ready() {
      reads++;
      if (closed) {
        // 与 embedding.js 的 OpenAI embedder 同形：getter 内部经 settings 读库。
        store.db.prepare("SELECT count(*) AS c FROM memories").get();
      }
      return false; // 始终「未就绪」：轮询会一直跑下去，除非天花板真的生效
    }
  };

  service.setEmbedder(embedder);
  assert.equal(reads, 1, "setEmbedder 先读一次 ready，决定要不要起轮询");

  closed = true;
  store.close(); // 卸载路径的最后一步

  await waitUntilSettled(() => reads);
  const atCeiling = reads;

  assert.equal(
    atCeiling,
    CEILING_READS,
    `读 ready 抛错也必须按上限停手（实际读了 ${atCeiling} 次，上限 ${CEILING_READS}）`
  );
  assert.equal(reads, atCeiling, "越过天花板之后不许再有读取：定时器必须已经清掉");
  assert.equal(warns.length, 1, "读不出来只报一次，别把 3s 上限变成 30 条刷屏");
  assert.match(String(warns[0][0]), /embedder ready probe failed/);
});
