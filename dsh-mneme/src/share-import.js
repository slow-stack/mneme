// dsh-mneme/src/share-import.js
// 车道 C 收侧的入库与退出：一份校验过的分享包 → 本库的外来行（整批一个事务），以及按
// pack_id 把那一批整包收回（spec §5）。
//
// 独立成模块（AGENTS.md 尺寸约定，同 organize.js / document.js 先例）：service.js 只做
// 依赖注入 + barrel 出口，调用方零改动。依赖由 createService 的闭包注入（store /
// transaction / scheduleEmbed），形状照 src/organize.js 的 createOrganizer——本模块不
// 认识 service 的内部接线，也不自带事务助手。
//
// C3b 是纯搬移：`ShareImportError` 与 `importSharePack` 的定义连同注释、错误码、答复
// 形状从 src/service.js 逐字移来，一行行为都没改。搬完那三把变异锁照样咬（见
// test/share-import.test.js 的「最外层 COMMIT 才排空嵌入队列」那组）。C4 是搬移之后
// 第一刀真的碰这块的改动，所以那两个「本文件」之类的口吻也一并改对了。
//
// ESM 环的位置随之挪了一格：原先是 service → share → write-admission → service，现在
// 那条 service → share 的直接边换成了 service → share-import → share，环还是那个环、
// 求值期仍然没有任何一侧调用另一侧。下面 share.js 那条 import 上的注释讲的就是它。

import { scopeKeyOf } from "./scope.js";
import { isImportedRow, IMPORTED_SOURCE } from "./memory-source.js";
// 车道 C 收侧的两个纯件：整包闸门与来源标签。import 它们而不是重抄一份——判据有两份
// 的话，出包侧改了收侧不会红，最坏情况是「对面按旧口径铸的键被我们整包拒掉」。
// 代价是一条**已知并被接受**的 ESM 环：service → share → write-admission → service
// （share.js 只借 write-admission 的空白/噪声判据，见它模块头）。环上三处都是函数
// （`PINNED_MEMORY_TYPES` 是 service 顶层的 const，但 write-admission 只在函数体里读它；
// share.js 用的 informationlessReason 是函数声明，提升后即刻可用），没有任何一侧在
// 模块求值期调用另一侧——所以求值顺序炸不出 TDZ。这条不是「应该没事」：C3 的报告里
// 有一道全新进程的 `import("./src/service.js")` 探针，本文件的测试也全走真实链路。
import { validateSharePack, importedTagFor } from "./share.js";

// 退出答复里给人核对的清单封顶 20 条。这个数管的是**答复的字节数**不是删除的完整性：
// deleted 恒是全集，sample 只是前缀。两张皮（面板路由 / Bearer 数据面）都把答复
// JSON.stringify 出去，一个几千条的包如果整包塞进答复，响应体会比请求还大，而人只需要
// 认出最前面那几条是不是他要收的那批。同 SHARE_SKIP_LIST_MAX（车道 A，50）的口径：
// 截的是清单不是账。
const DELETE_SAMPLE_MAX = 20;

/**
 * 导入的错误：带 code，让两张皮（面板路由与 standalone 数据面）映射成同一个 400 码
 * 而不是各写一份文案。类放在模块顶层而不是 createService 的闭包里——闭包每实例造一
 * 个新类，`instanceof` 就退化成「只在同一个 service 实例内部成立」的关系，而消费方
 * 判的是 `err.code`（spec §5：码集由 share.js 的 validateSharePack 定，这里只转发）。
 */
export class ShareImportError extends Error {
  constructor(code, detail) {
    super(`share import: ${code}`);
    this.name = "ShareImportError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 构造收侧的入库与退出。注入的三个依赖都是 service 闭包成员：`store` 是存储层，
 * `transaction` 必须是 service 那一个而不是 `store.runAtomically`——嵌入队列只在最外层
 * COMMIT 排空、回滚时按层截断，这套队列语义存储层的助手不认识（退出那侧用它是为了同一
 * 件事：镜像重渲染与写通知都在它的 finally 里）。
 *
 * @returns {{ importSharePack: (pack: object, opts?: { dryRun?: boolean }) => object,
 *   deleteSharePack: (packId: string, opts?: { dryRun?: boolean }) => object }}
 */
export function createShareImport({ store, transaction, scheduleEmbed }) {
  /**
   * 车道 C 的入库（spec §5）。与 service.js 里的 mergeHumanEdits 同属「外部文本进库」
   * 那一族（C3b 之后它在隔壁文件，别再按同文件口吻读这句），但方向相反：那一族改的是
   * 本机的行，这一族**已有的行一条都不许碰**。
   *
   * 真导入整包裹在注入的 `transaction()` 里而不是 `store.runAtomically()`：scheduleEmbed
   * 在 txDepth>0 时只入队，队列由那个 transaction()（住在 service.js，不是本文件）的
   * 最外层 COMMIT 排空（入队在 scheduleEmbed 首行，排空在 transaction 的 finally），
   * 存储层那个助手不认识这套队列——用它等于静默不嵌入，而这批行对收件人的向量检索就
   * 永远隐形（车道 C 预检点名的那条）。回滚一侧由 transaction() 截断 pendingEmbed，
   * 绝不给已回滚的行做向量。
   *
   * 幂等的主路径是事务内先查 `share_external_id`，命中即跳过。那把部分 UNIQUE 索引只是
   * 双保险，管两个宿主共用同一 memoryDir 时的竞态；它从这里穿出时是**整笔回滚**——不
   * catch、不续跑。「约束报错就跳过这一条」看着宽容，实际是把「这个包还没吃过」报成
   * 「吃过了」，而整包回滚后重跑一次本来就成了 created=0 的正常答复。
   *
   * 走 `store.save` 而不是 `saveWithDedupe`：后者命中即 appendContent 并入既有行，而
   * 「把别人的正文并进我的条目」正是决策 2 要禁的动作；汇流口那侧也已把外来行剔出候选集
   * （saveWithDedupe 里的 isImportedRow），两条路合起来才是「谁也不改谁」。
   *
   * @param {object} pack 一份分享包（kind `mneme.share/v1`）
   * @param {{dryRun?: boolean}} [opts] dryRun 只算账不写库，答复同形状
   * @returns {{pack_id: string, alias: string, created: number, skipped_existing: number,
   *   unchanged: number, title_conflicts: Array<{type: string, title: string, existing_id: string}>,
   *   conflicts_checked: number}}
   * @throws {ShareImportError} 校验不过时 err.code 属于 validateSharePack 的码集，且一行未写
   */
  function importSharePack(pack, { dryRun = false } = {}) {
    const v = validateSharePack(pack);
    if (!v.ok) throw new ShareImportError(v.error, v.detail);
    const tag = importedTagFor(pack.alias);
    // 撞名清单的判据按「收件人会不会真的看不见这条」来定，三个条件各挡一类假报告：
    //  · 已归档 / 已遗忘（store.list 的默认档已经排掉，这里再写一遍是把契约留在调用处，
    //    哪天有人给这个调用加上 includeArchived，报出来的就是他自己收起来的行）；
    //  · 带 scope 标注：外来行落的是 NULL scope，两条在他的视图里根本不在同一格——
    //    scope 这一半与 saveWithDedupe 的去重键同口径（scopeKeyOf 把 NULL 归一成「未标注」），
    //    但这里**不比 sensitivity**：去重键是五格（type / title / 两个 scope / sensitivity），
    //    这里只有四格，少了 sensitivity 那一格，见下面「刻意更宽」那条；
    //  · 外来行（isImportedRow）：这一格最容易被「顺手简化」掉。少了它，第二次导入别的
    //    包时会把上一包别人的原文报成「你库里已经有一条」，existing_id 指向一行他既不能
    //    改写、在 C4 之前也删不掉的行——撞名读数从「要不要处理我这条」变成「去处理别人
    //    那条」。
    // 同键取 list() 默认序（importance DESC, updated_at DESC, id）的第一条：那一行落在去重
    // 窗口里时，就是 saveWithDedupe 会挑中的并入目标，报出来的 id 因此是「假如允许并入会被
    // 吃掉的那一条」，不是随便一条同名行。但**这不是与去重等价的集合**，是刻意更宽的报法，
    // 两处差别都要写明免得日后被读成等价：去重只扫 `store.list({type, limit: 100})` 那个窗口
    // （第 101 条以后的同名行它根本看不见，我们扫全库），并且多比一格 sensitivity（同名同
    // scope 而敏感度不同的两条，去重会各建一行、我们照样报撞名）。方向是安全的：宽的一侧只
    // 会多报，漏报才是「收件人看不见这条」那种要命的形状。读的时候按「这里报的都是真同名
    // 行」，别按「dedupe 会吃的就是这些行」。
    // 标题两侧 trim，与去重那侧的 title.trim() 同一把尺。最后还有一处对照根本不成立，记下
    // 免得日后又被拼回等价：dream summary 那一支的键是 source、narrative 那一支（src/service.js:1405-1410）
    // 的键是 tags[0]，两种行的「假如允许并入」目标跟这里的「同名第一条」不是同一格东西。
    const ownByKey = new Map();
    for (const m of store.list({ limit: null })) {
      if (m.archived || isImportedRow(m)) continue;
      if (scopeKeyOf(m.agent_scope) || scopeKeyOf(m.workspace_scope)) continue;
      const key = `${m.type}\u0000${String(m.title).trim()}`;
      if (!ownByKey.has(key)) ownByKey.set(key, m.id);
    }
    const importBatch = () => {
      let created = 0;
      let skippedExisting = 0;
      let unchanged = 0;
      const conflicts = [];
      for (const entry of pack.memories) {
        const existing = store.getByShareExternalId(entry.external_id);
        if (existing) {
          skippedExisting++;
          // unchanged 比的是「同一把尺的两端」，而这两端本来就可能合法地不同：包里的锚是
          // 发送方**遮之前**的归一化哈希（决策 4），库里这一格是收件人按自己收到的字节
          // 重算的 store 哈希，两侧各自遮自己那台机器的 home 前缀。所以这个数**只是给人
          // 看的读数，绝不许当动作依据**——拿它决定「这条不用导入」就是个 bug；要不要建
          // 这条行，只看上面那格 share_external_id。
          if (typeof existing.content_hash === "string" && existing.content_hash === entry.content_hash) unchanged++;
          continue;
        }
        const key = `${entry.type}\u0000${String(entry.title).trim()}`;
        if (ownByKey.has(key)) conflicts.push({ type: entry.type, title: entry.title, existing_id: ownByKey.get(key) });
        if (dryRun) { created++; continue; }
        // created_at / content_hash 不在传参里：这两格由 store 铸造（spec §5 记的三个事实
        // 前两条），包里那两个值只作给人看的时间感与发件侧自证的锚。
        const row = store.save({
          type: entry.type,
          title: entry.title,
          content: entry.content,
          // 只追加一个来源标签，包里的标签原样带过来；Set 去重是防发件人本来就带了一个
          // 一模一样的标签（那样面板上会出现两条同名标签，读起来像系统写了两次）。
          tags: [...new Set([...(Array.isArray(entry.tags) ? entry.tags.map(String) : []), tag])],
          importance: Number.isInteger(entry.importance) ? entry.importance : 3,
          epistemic_status: entry.epistemic_status,
          source: IMPORTED_SOURCE,
          agent_scope: null,
          workspace_scope: null,
          share_pack_id: pack.pack_id,
          share_external_id: entry.external_id
        });
        // 排队而不是当场嵌：这里在事务里，txDepth>0，scheduleEmbed 入队、由 transaction()
        // 提交后 drain。别改成「事务外再补一遍」——那是 #372 与 distill-tx-embed-gap 修过
        // 两次的形状。
        scheduleEmbed(row);
        created++;
      }
      return { created, skippedExisting, unchanged, conflicts };
    };
    // 干跑不裹 transaction()：那一层的 finally 会 syncMirror() + notifyWrite()。一次没写
    // 任何东西的预览，不该把整面镜像重渲染一遍，更不该告诉睡眠调度器「库刚变过」——那
    // 一下会把空闲计时器重置，压掉她本来该做的一轮巩固。剩下的全是只读查询，不需要 BEGIN。
    const result = dryRun ? importBatch() : transaction(importBatch);
    return {
      pack_id: pack.pack_id,
      // alias 对面自报，可以是空串；缺格（手改包）时补空串而不是 undefined——这两张皮的
      // 答复会被 JSON.stringify，undefined 的键直接消失，面板就分不清「匿名」与「没读到」。
      alias: typeof pack.alias === "string" ? pack.alias : "",
      created: result.created,
      skipped_existing: result.skippedExisting,
      unchanged: result.unchanged,
      // title_conflicts 是 advisory 读数，**不是「没有撞名」的证明**：撞名只对本轮真正会新建
      // 的那些条目判（skipped_existing 那一支直接 continue，不再比），所以空数组只说明「这一批
      // 里没有新的撞名要报」。conflicts_checked 同样是包里的条数而不是比过的条数——第二次导入
      // 同一个包时这一格恒空，而撞名在库里物理存在。对面文案别写成「现在没有冲突」。
      title_conflicts: result.conflicts,
      conflicts_checked: pack.memories.length
    };
  }

  /**
   * 整包退出（spec §5）。**物删不归档**（裁定与理由都记在这儿，免得日后被读成手滑）：
   * 归档行仍占着 share_external_id 的 UNIQUE 位，会造成「撤了却导不回来」的死角——那个
   * 形态比多删更坏，而原始包还在分享者手里，随时能重导。
   * 本方法与 reclaim 的「一条记忆都不删」哲学相反：那是自动回收面（没人点头，删了就找不
   * 回来），这是人显式按下的一次撤销——他刚说过「这批不是我的」，留着才是替他做决定。
   *
   * 寻址键只有 `share_pack_id` 一个：外来行由本模块铸造（source='imported' + 两列），
   * 全仓别处都不写这两列，所以「按包删」与「只删外来行」今天等价。哪天有人给本地行也
   * 盖上 share_pack_id，这条等价就破了——那时要收窄的是 store 那一侧的 WHERE，不是这里
   * 补一层 filter（补了会让清点与实删分家，见下面 deleted 为什么取 store 的数）。
   *
   * 裹 `transaction()` 而不是裸调 `store.deleteBySharePackId`：后者内部有 runAtomically，
   * 而它在 db.isTransaction 为真时直接跑回调（src/store.js 的 runAtomically 首行），所以
   * 嵌套安全；换来的是 transaction 的 finally 把 syncMirror + notifyWrite 各做一次——
   * 退出必须让面板、镜像与做梦调度器同时知道这批行没了。什么都没删时**不进**事务：
   * 一笔空删除既不该重渲染镜像也不该把空闲计时器顶回去（与 importSharePack 的干跑同一条
   * 理由）。
   *
   * @param {string} packId 要收起的包；非字符串 / 空白 / 没导入过都答 0，不抛
   * @param {{dryRun?: boolean}} [opts] dryRun 只清点不删，答复同形状
   * @returns {{pack_id: string, deleted: number, sample: Array<{type: string, title: string}>}}
   */
  function deleteSharePack(packId, { dryRun = false } = {}) {
    const id = typeof packId === "string" ? packId.trim() : "";
    if (!id) return { pack_id: "", deleted: 0, sample: [] };
    // 清点与实删读的是同一个 store 方法（listBySharePackId 不过滤 archived/forgotten：
    // 那两个面也要一起收走，否则库里留下「来自一个已经收起的包」的行）。sample 取前
    // DELETE_SAMPLE_MAX 条给人核对「我要收起的到底是哪一批」——listBySharePackId 的序是
    // updated_at DESC, id DESC，所以报出去的是他最近看过的那几条。
    const rows = store.listBySharePackId(id);
    const sample = rows.slice(0, DELETE_SAMPLE_MAX).map((m) => ({ type: m.type, title: m.title }));
    if (dryRun || !rows.length) return { pack_id: id, deleted: rows.length, sample };
    // deleted 取 store 的 changes 而不是 rows.length：上面那次清点是只读快照，而
    // deleteBySharePackId 在**它自己的事务里重新读一遍 id**——两个宿主共用同一 memoryDir
    // 时（AGENTS.md 的那台机器两条腿），别人在我们清点之后往同一个包里补写的行会一起被删
    // （它不在 sample 里），我们清点到的行也可能已被别人删掉（它数不进 changes）。报实删的
    // 数才是诚实的那一个：sample 是清点时的预览，deleted 是这一笔真的带走了几行，并发下
    // 两者可以差一条，谁也不许拿对方的数当「漏删/多删」的依据。
    const deleted = transaction(() => store.deleteBySharePackId(id));
    return { pack_id: id, deleted, sample };
  }

  return { importSharePack, deleteSharePack };
}
