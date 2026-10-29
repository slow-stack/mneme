// 分享包在两张皮上共用的解析与答复（形状照 src/reclaim-http.js，#411）。
// 只返回 {status, body}，绝不自己写 res —— 两侧的 sendJson 签名不同（api.js 有
// headers 第四参、api-standalone.js 没有），把写 res 留在各侧 handler 里是唯一
// 能让一份实现喂两张脸的做法。
//
// 哪些行进包、以什么原因不进，一条判据都不在这里重复：那是 src/share.js 的事。本模块
// 只做协议层的事——读 body、把结果包成答复、给一个能落盘的文件名。
import { buildSharePack } from "./share.js";

/** 拒发时的下一步动作。它是给调用方看的，出口只许有一处措辞（同 RECLAIM_CONFIRM_HINT）。 */
const SHARE_ERROR_HINT = "包体超过分享水位：用 --type 或 --tag 分批，别整库外发。";

/**
 * 记日志这一手，只许经这里。
 *
 * 「这一层从不抛」是**层的契约**，不是每个调用面的运气（C5 评审裁定）：warn 裸调时，宿主
 * logger 自己坏掉就会从 catch 块里再抛出去，而两侧 handler 那个外层 try 在 .then 的回调里
 * 早已退栈——现场就是「一个字节都没回」（#410）。守卫住在面上一处一个，等于每接一张新脸
 * 都要记得再兜一次；住在层里，两侧、以及后面的 CLI（C7）拿到的都是同一个脾气。
 *
 * 三个构造器（shareReply / receiveReply / undoReply）都走这里，**对称本身就是要点**：
 * 只给新加的两个上守卫、出包那侧留一处裸调，下一个读者就会照那处裸的抄。
 * 日志环坏掉时答复照旧送出——对面拿到的仍是那一个状态码，只是少了一条日志迹。
 */
function warnSafely(warn, message) {
  try {
    warn?.(message);
  } catch { /* 记日志是自己的事，坏了的日志不许把已经算好的答复一起带走 */ }
}

/**
 * 解析 POST body（已由调用方读成文本）→ buildSharePack 的入参集合。
 *
 * 空 body 等价于 `{}`：分享的主用法就是「一个字节都不发，按整库口径打」。坏 JSON 与
 * 发成数组/null 是两个不同的错码（前者是调用方发坏了，后者是发错了顶层形状），
 * 与 reclaim 侧同款，出口要能分支。
 *
 * 只认这三个键，多余的键丢掉：面板与 CLI 各写各的选项时，静默接受一个拼错的键等于
 * 让她以为筛过了。
 *
 * 这里**没有** dryRun：share 是纯读、不改库，spec §4 明确它不套 reclaim 的
 * dry-run/confirm 纪律，干跑由 CLI 侧的 `--dry-run` 决定（它压根不发这个键）。上一版
 * 把它「登记但不参与答复构造」留着，等于凭空多出一个没人消费的公开字段：今天发
 * `dryRun: true` 的人拿到的是真包，而哪天要给它真语义、或把它删掉，两侧都是破坏性改动。
 * 删掉后它和别的多余键走同一条规则——丢掉，不再是一个特例。
 *
 * @returns {{ok: true, options: {alias?: string, type?: unknown, tag?: unknown}}
 *           | {ok: false, error: string}}
 */
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
  // type / tag 在这里只判「填没填」，不判形状。收窄口径是 share.js 的 shareFilterSet，
  // 它钉死的是「读不懂的形状只许收窄到 0 条，不许当没填」（错的方向是少发，当场看得见）。
  // 本层若再校验一次形状、把裸字符串或混进非字符串条目的数组丢成「没填」，就等于在 HTTP
  // 面上把那条洞反着挖开——她以为只发了一类，实际整库进包，而 report 看不出异样。
  if (body.type !== undefined && body.type !== null) options.type = body.type;
  if (body.tag !== undefined && body.tag !== null) options.tag = body.tag;
  return { ok: true, options };
}

/** 包文件名：日期 + pack_id 前 8 位。Content-Disposition 与 CLI 落盘共用这一个拼法。 */
export function shareFilename(packId, now = () => new Date()) {
  const stamp = now().toISOString().slice(0, 10).replace(/-/g, "");
  return `dsh-mneme-share-${stamp}-${String(packId).slice(0, 8)}.json`;
}

/**
 * 组包并给出答复。`service.all()` 是「全库含归档/已遗忘」的现成通道（store.js 的 all()
 * 不带 WHERE），口径判据全在 share.js 里判，本模块不重复任何一条。
 *
 * filters 两个键只在填了时才挂上去：buildSharePack 的默认值兜的是 `filters` 整个参数为
 * undefined，构造一个 `filters: null` 会直接在对端解引用时抛——没填的键就让它不存在。
 *
 * 413 那条绝不回 pack：这条答复存在的原因恰恰是包太大，把 memories 序列化回去等于把
 * 刚拒绝掉的那几 MB 再发一遍。report + 量到的字节 + 水位 + 提示够出口说清「大了多少、
 * 怎么分批」（share.js 超限时也把完整 pack 交回，本层只用它的 report）。
 *
 * 抛错在这里兜住并回 500，不留给调用方的 try：面板侧 handler 的形状是
 * `try { return readBody(...).then(...) } catch`，外层 try 在 .then 的回调里已经退栈，
 * 从这里抛出去就是一个没人接的 rejection，客户端拿到的不是 500 而是「一个字节都没回」
 * （#410，reclaim-http.js 里 reclaimReply 那段注释记的就是这一次）。共用层兜一次，两张
 * 皮才不会因为各自接线不同而有一种会漏。warn 可选：数据面的 logger 未必接得上，少一个
 * 回调也不许把异常漏出去。
 *
 * @param {{service: {all: () => object[]}, packageVersion: string, homeDir: string,
 *          now?: () => Date, options?: object, warn?: ((msg: string) => void)|null}} input
 * @returns {{status: number, body: object}}
 */
export function shareReply({ service, packageVersion, homeDir, now = () => new Date(), options = {}, warn = null }) {
  try {
    const rows = typeof service?.all === "function" ? service.all() : [];
    const filters = {};
    if (options.type !== undefined) filters.type = options.type;
    if (options.tag !== undefined) filters.tag = options.tag;
    const out = buildSharePack({
      rows, alias: options.alias, homeDir, packageVersion,
      filters,
      generatedAt: now().toISOString()
    });
    if (!out.ok) {
      return {
        status: 413,
        body: { error: out.error, bytes: out.bytes, limitBytes: out.limitBytes, hint: SHARE_ERROR_HINT, report: out.pack.report }
      };
    }
    return { status: 200, body: out.pack };
  } catch (error) {
    // 日志里留住原始文本（现场最难下手的就是「只回了 internal」那一类），对外只有一个码。
    warnSafely(warn, `[dsh-mneme] share pack failed: ${String(error)}`);
    return { status: 500, body: { error: "internal" } };
  }
}

// --- 接收侧（车道 C，spec §5）--------------------------------------------------
// 入库与整包退出同属「两张皮只许差在鉴权与路径」那条纪律（#411），所以这两组解析/答复
// 也住在本模块，与出包侧同一个形状：只回 {status, body}，绝不写 res。
//
// 这里刻意**不**重跑 validateSharePack：整包闸门住在 share.js、由 service 的
// importSharePack 自己调（src/share-import.js）。本层再判一次就是第二套口径——两份实现
// 各自演进时最坏情况是「路由放行、service 拒」或反过来，而一个包有没有合格从此没有准信。
// 失败靠 err.code 鸭子类型映射成状态码：ShareImportError 是刻意不从 service 再导出的
// （类跨模块之后，instanceof 就退化成「只在同一个实例内成立」），码才是契约。

/**
 * 导入错误码 → HTTP 状态。一张表喂两张皮（数据面那半也从这儿取），码集由 share.js 的
 * validateSharePack 定：闸门新增一格必须在这里登记。认不出的码走「500 + 日志」那一条，
 * 绝不静默降级成 400 冒充「你的包不合格」——那会把存储故障报成对方的错。
 */
export const SHARE_IMPORT_ERRORS = Object.freeze({
  "invalid-kind": 400,
  "invalid-pack-id": 400,
  "invalid-memories": 400,
  "empty-pack": 400,
  "invalid-type": 400,
  "invalid-entry": 400,
  "external-id-mismatch": 400,
  "duplicate-external-id": 400
});

/**
 * 「收侧没接线」的码（headless 或旧装配里没有那两个方法）。与 RECLAIM_UNAVAILABLE 同一
 * 处置：字面量只许住在本模块，两张皮都从这一个导出取，否则各写一种拼法就没法按码分支。
 */
export const SHARE_IMPORT_UNAVAILABLE = "share-import-unavailable";

/**
 * 缺省即干跑：没有 confirm 就是预览。脾气照 readReclaimFields 的 confirm（只认真布尔），
 * 但这一面的方向更硬——写的是**收件人的库**，所以唯一的入口就是 confirm，`dryRun` 之类
 * 的第二个旋钮一概不认（reclaim 的 body 形状里就带 dryRun，手熟的人会顺手发来，把它读成
 * 「要写」等于替她点头）。
 */
function readDryRun(body) {
  return body?.confirm !== true;
}

/**
 * 答复壳里唯一由本层加的一格。service 那一侧收的是 opts.dryRun、不认识 dry_run，对面读的
 * 却是这一格，所以放在本层加：两张皮拿到的键才完全相同。
 *
 * `dryRun !== false` 而不是 `=== true`：认不出的值（字符串、对象、undefined）一律落回**干跑**，
 * 与解析侧同一个失败方向；而传下去的那个布尔值与写进答复的那一格永远同一个数——「其实没写、
 * 却说写了」和「其实写了、却说没写」都是说谎，这一格不许和实参分家。
 */
function withDryRun(reply, dryRun) {
  return { ...reply, dry_run: dryRun !== false };
}

/**
 * 解析 POST /receive 的 body（已读成文本）→ { pack, dryRun }。
 *
 * 三个码分开是有原因的：invalid-json（发坏了）、invalid-body（顶层就不是对象）、
 * missing-pack（对象里没有包）——对面据此知道改哪一头，而它们全是 400。空 body 是
 * **错**的，与出包侧相反：那边「一个字节都不发」是整库口径，这边压根没东西可写。
 *
 * pack 那一格只判「是不是个对象」，不判包：数组或 `{kind:"nope"}` 都往下交，由闸门整包拒
 * （invalid-kind）。判据只许有一处。
 *
 * @returns {{ok: true, pack: object, dryRun: boolean} | {ok: false, error: string}}
 */
export function parseReceiveBody(text) {
  if (text === undefined || text === null || String(text).trim() === "") return { ok: false, error: "invalid-body" };
  let body;
  try {
    body = JSON.parse(String(text));
  } catch {
    return { ok: false, error: "invalid-json" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "invalid-body" };
  if (!body.pack || typeof body.pack !== "object") return { ok: false, error: "missing-pack" };
  return { ok: true, pack: body.pack, dryRun: readDryRun(body) };
}

/**
 * 解析 POST /receive/undo 的 body → { packId, dryRun }。顶层形状与「有没有 id」是两个错，
 * 与 receive 侧同一口径（发坏了 / 发错了形状 / 没填）。
 *
 * id 在这里 trim，与 deleteSharePack 首行同一把尺；非字符串与空白一律不进删除那条路——
 * 让空白去 service 那儿换回一个 `pack_id: ""` 的 0 删除，读数上看不出是「没填」还是
 * 「那个包本来就没导入过」，而这两种在出口是完全不同的事。
 *
 * @returns {{ok: true, packId: string, dryRun: boolean} | {ok: false, error: string}}
 */
export function parseUndoBody(text) {
  if (text === undefined || text === null || String(text).trim() === "") return { ok: false, error: "invalid-body" };
  let body;
  try {
    body = JSON.parse(String(text));
  } catch {
    return { ok: false, error: "invalid-json" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "invalid-body" };
  const packId = typeof body.packId === "string" ? body.packId.trim() : "";
  if (!packId) return { ok: false, error: "missing-pack-id" };
  return { ok: true, packId, dryRun: readDryRun(body) };
}

/**
 * 入库的答复。`pack` 原样交给 service，校验在那儿跑（见本段开头那句「判据只许有一处」）。
 *
 * 抛错在这儿兜住并回 500，不留给调用方的 try：两侧 handler 的形状都是
 * `try { return readBody(...).then(...) } catch`，外层 try 在 .then 的回调里已经退栈，
 * 从这里抛出去就是一个没人接的 rejection（#410）。warn 可选——数据面的 logger 未必接得上，
 * 少一个回调不许把异常漏出去。
 *
 * @param {{service: {importSharePack?: Function}, pack: object, dryRun?: boolean,
 *          warn?: ((msg: string) => void)|null}} input
 * @returns {{status: number, body: object}}
 */
export function receiveReply({ service, pack, dryRun, warn = null }) {
  if (typeof service?.importSharePack !== "function") {
    return { status: 503, body: { error: SHARE_IMPORT_UNAVAILABLE } };
  }
  const dry = dryRun !== false;
  try {
    return { status: 200, body: withDryRun(service.importSharePack(pack, { dryRun: dry }), dry) };
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : null;
    const status = code === null ? undefined : SHARE_IMPORT_ERRORS[code];
    if (status) {
      // detail 是闸门给的那一格（哪个字段、哪个坏类型），只转发不加工；没有就不造这一格。
      const detail = typeof error.detail === "string" && error.detail ? { detail: error.detail } : {};
      return { status, body: { error: code, ...detail } };
    }
    warnSafely(warn, `[dsh-mneme] share import failed: ${String(error)}`);
    return { status: 500, body: { error: "internal" } };
  }
}

/**
 * 整包退出的答复。这一面**不查** SHARE_IMPORT_ERRORS：packId 的形状闸门在 parseUndoBody，
 * service 那侧不抛带码的错（非字符串/空白它回一个 0 删除，不是异常），所以真抛出来就是
 * 存储故障。别在这儿补第二张表——那张表只会成为 SHARE_IMPORT_ERRORS 的影子。
 *
 * 答复里的 pack_id 是 service 的读数而不是请求的回显（非字符串/空白那一支它回 ""），
 * 本层不改写、不兜底；dry_run 由 withDryRun 加，与入库那侧同一格键。
 *
 * @param {{service: {deleteSharePack?: Function}, packId: string, dryRun?: boolean,
 *          warn?: ((msg: string) => void)|null}} input
 * @returns {{status: number, body: object}}
 */
export function undoReply({ service, packId, dryRun, warn = null }) {
  if (typeof service?.deleteSharePack !== "function") {
    return { status: 503, body: { error: SHARE_IMPORT_UNAVAILABLE } };
  }
  const dry = dryRun !== false;
  try {
    return { status: 200, body: withDryRun(service.deleteSharePack(packId, { dryRun: dry }), dry) };
  } catch (error) {
    warnSafely(warn, `[dsh-mneme] share undo failed: ${String(error)}`);
    return { status: 500, body: { error: "internal" } };
  }
}
