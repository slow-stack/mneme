// 记忆分享包的纯核心：取行口径、脱敏、序列化。
// 本模块不认识 store、不认识 http，也不读 config —— 两侧出口（宿主内面板路由与
// standalone Bearer 数据面）共用的解析与答复在 share-http.js，#411 的教训是这两张皮
// 只许剩鉴权与路径不同。
// 唯一进来的外部判据是两个纯函数（write-admission 的空白/噪声、sensitive-scan 的
// 密钥/PII）：判据只许有一份，所以这里 import 而不是重抄，代价是模块图会连带把
// store 模块**加载**进来（write-admission → service → store）—— 加载不等于使用，
// 本模块不调它任何一个方法，也不碰 config。
import { createHash, randomBytes } from "node:crypto";
import { informationlessReason } from "./write-admission.js";
import { scanSensitive } from "./sensitive-scan.js";

export const SHARE_KIND = "mneme.share/v1";

// 跳过清单的条数上限：面板与 CLI 都要把「为什么这条没进包」摊给人看，但一个
// 几千条的库不该因此产出一份比包还长的报告。超限就截断，计数仍给全量。
export const SHARE_SKIP_LIST_MAX = 50;

// 体积水位留在 3 MiB，上限是两侧 readBody 各自写死的 4 MiB（api.js:57、
// api-standalone.js:31）。留 1 MiB 是给 JSON 包装与接收侧再序列化的余量——
// 包本身要作为 body 原样 POST 回去，水位贴上限等于给自己埋 413。
export const MAX_PACK_BYTES = 3 * 1024 * 1024;

// document 是指针行（#296），正文文件不随包走，导出去对面就是「看着有、点开是空」；
// 与 mirror.js 的 MIRROR_READONLY_TYPES 同口径，但这里刻意写死字面量而不是 import
// 那个 Set —— 分享格式的兼容面比镜像宽，镜像哪天放开只读 type 不该自动改掉包的口径。
export const SHARE_READONLY_TYPES = new Set(["document"]);
export const SHARE_EXCLUDED_TYPES = new Set(["summary"]);

const withoutNul = (value) => String(value ?? "").replace(/\u0000/g, "");

/**
 * 幂等键：`pack_id \0 type \0 title \0 content_hash`，防 ("ab","c") 与 ("a","bc") 撞同一键。
 *
 * 分隔符只保证「字段之间」的切法唯一，所以入参自己的 U+0000 必须先剥掉：不剥的话
 * ("t","a\0b") 与 ("t\0a","b") 拼出同一串字节，对面重算时把这条当成「已经吃过」，
 * 于是该建的行静默不建（串号是幂等表上最难查的那类 bug，没有报错）。剥完 `"a\0b"` 与
 * `"ab"` 同键——这与既有的 trim 是同一类归一（丢字节换切法唯一），不是新开的口子。
 * 归一写在这里而不是各调用方：铸造侧（本模块）与重算侧（车道 C）必须共用一份口径，
 * 两份实现各自归一迟早漂。除 U+0000 外不动别的字节，trim 口径照旧 —— 归一规则一变，
 * 已发出去的包里每个 external_id 都对不上。
 *
 * 第四格是内容锚，不是装饰：库里的去重键含 `content_hash`（store.js:1233），所以同 type
 * 同 title、正文不同的两条是两条合法记忆。键里没它时两条铸出同一个 external_id，收侧
 * 「先查后跳过」把第二条当成已吃过而静默不建，而包里的 `report.included` 已经说了 2 ——
 * 说谎的是这份账。缺锚的行（store 没算过）与 `null` 都归一成 `""`：JSON 里没有 undefined，
 * 重算侧只会看到 null，两者不许铸出两个键。
 */
export function deriveExternalId(packId, type, title, contentHash) {
  const parts = [withoutNul(packId), withoutNul(type), withoutNul(title).trim(), withoutNul(contentHash)];
  return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 16);
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 把正文里的本机 home 前缀换成 `~`。
 *
 * 判据是**分隔符游程**，不是几种固定拼法：把 base 按 `[/\\]+` 切成段，再用 `[/\\]+`
 * 拼回一条正则（段间至少一个分隔符、个数不限）。于是同一目录的所有写法——单反斜杠、
 * 正斜杠、JSON 里转义过的双反斜杠、混合、二次编码——都走同一条判据。上一版按
 * base / 单反斜杠 / 双反斜杠三个固定形态匹配，混合与二次编码照样漏，而「按拼法打补丁」
 * 的失败方式是永远漏下没列到的那一种，漏出来的正是用户名。
 * 大小写不敏感：盘符与用户目录在真实路径里的大小写常常和 homedir() 不一致。
 * 已知代价：游程要求段间**至少一个**分隔符，所以段间没有分隔符的写法（`C:Users`）不
 * 命中——上一版按三个固定形态匹配时同样不命中，游程在这一格既没放宽也没收窄。那已经不是
 * 同一目录的拼法（Node 与 JSON 都不产它），要命中只能把前缀约束整个拆掉，而那侧错的方向
 * 是泄露。
 */
export function createHomeRedactor(homeDir) {
  // 尾分隔符先剥：留着它就成了末段空串，拼出的游程把「正文必须带尾分隔符」写进判据，
  // 没带的那个反而漏。全由分隔符组成的 home（`//`）剥完即空，走 identity 出口——
  // 否则正则会把正文里的斜杠吃成 `~/`，把内容改花。
  const base = (typeof homeDir === "string" ? homeDir.trim() : "").replace(/[/\\]+$/, "");
  if (base.length < 2) return (text) => String(text ?? "");
  const re = new RegExp(`${base.split(/[/\\]+/).map(reEsc).join("[/\\\\]+")}[\\\\/]?`, "gi");
  // 折掉的只有「前缀 + 紧跟着的那一个分隔符」，输出统一成读者与对面 agent 都认的 `~/`；
  // 后面的路径按原样留着——改写用户写下的字节是另一类事故。前缀落在句尾时不补分隔符。
  return (text) => String(text ?? "").replace(re, (m) => (m.endsWith("\\") || m.endsWith("/") ? "~/" : "~"));
}

/**
 * 一条记忆进不进包。顺序是刻意的：先状态位（archived/forgotten），再类型，
 * 再判据 —— 空白与噪声先于敏感判定，因为一条内容为空的记忆没有可泄露的东西，
 * 把它记成 sensitive 会让跳过清单的读数说错原因。
 *
 * 「空白/噪声」这一级不自建判据：复用 informationlessReason（write-admission.js:117），
 * 它的口径是 title+content 的**组合**判定 —— 两侧归一后都不剩字才命中（"blank" 全空、
 * "noise" 只剩标点/空白）。组合口径管的是「这条写入有没有信息」，分享边界要问的是另一个
 * 问题：对面能不能吃下这一条。所以这里另外补一刀「正文 trim 后为空」（见函数内注释）。
 *
 * 跳过的分支也返回脱敏后的 title：跳过清单不只在本机看 —— 打包侧把它原样写进
 * pack.report.skip_list，CLI 再整份打到终端（车道 A3/A7 的口径），而 413 那次拒发
 * 仍带着同一份 report 出去（src/share-http.js）。未遮的 title 等于把用户名装进这份
 * 「设计上不含它」的文件，而泄露面最大的恰恰是不进包的那几条。所以在源头遮，每个
 * 消费方拿到的都是安全字符串；下游不需要、也不该再各补一刀。遮的仍是同一个 redact，
 * 本模块只有这一条脱敏路径。
 *
 * 但「遮过 home」不等于「可以外发」：一条被密钥判据认中的行，它的**标题**常常就是
 * 那条凭据的回声（最终评审的复现：标题「生产库密码 P@ssw0rd-for-prod-db 别丢」+ 正文
 * `password: …`，被跳过原因是 archived）。规则表只认「关键词 + 赋值号 + 值的形状」，
 * 单看这一串标题它并不命中 —— 所以这里判的是**整行**含不含凭据，命中就连带标题一起
 * 不给：正文不发的那条，它的标题也不该跟着包走。留空而不是给摘要/哈希：skip_list 随包
 * 外发，一个哈希是递给收侧的离线爆破 oracle，而低熵口令正是这类行最常见的内容。
 * 方向上的代价只有「少看得见一条标题」，计数仍给全量。
 *
 * 因此扫描面在判序**之前**算一次（原因归属仍按下面的判序，空白照旧先于敏感）：代价是
 * 归档行也进扫描，不再是「进包候选 + 敏感命中」那一小撮。量级没变 —— 整库逐条扫描实测
 * 98 ms（docs/SHARE.md），而这条路径本来就要付一次全表读（同处约 1.1 s）。
 */
export function classifyRowForShare(row, { redact = (t) => t } = {}) {
  const title = redact(row?.title ?? "");
  // 扫描面用 `scanSensitive` 这个「任意文本」口径的导出，不用带开关的那个工厂面：
  // 工厂在 sensitiveScanEnabled 关时返回 null（sensitive-scan.js:199），而那个键管的是
  // **写入侧**可观测性。分享边界本身就是安全边界（spec §4）——用户没开写入闸门时
  // 恰恰最需要这里照常在扫，跟着开关走等于裸发整库。
  const scanned = scanSensitive([row?.title, row?.content, ...(Array.isArray(row?.tags) ? row.tags : [])]
    .filter((s) => typeof s === "string").join("\n"));
  const skipTitle = scanned ? "" : title;
  if (row?.archived) return { include: false, reason: "archived", title: skipTitle };
  if (row?.forgotten) return { include: false, reason: "forgotten", title: skipTitle };
  if (SHARE_READONLY_TYPES.has(row?.type)) return { include: false, reason: "readonly_type", title: skipTitle };
  if (SHARE_EXCLUDED_TYPES.has(row?.type)) return { include: false, reason: "excluded_type", title: skipTitle };
  // 正文 trim 后为空即算空白，这一格 `informationlessReason` 够不着：它判的是 title+content
  // 的**组合**（两侧归一后都不剩字才命中），所以「标题有字、正文一片空白」在它眼里是有信息
  // 的。上一版据此让那条进包，判据本身没错，错在出口：收侧的 `content` 列 NOT NULL，车道 C
  // 还按 spec §5 逐条校验非空，一条空正文不是少发一条而是**把整包毒掉**（校验不过 → 什么都不
  // 导入，对面拿着一个报错的包不知道差在哪一条）。这里不开第七个原因键：六个键被 docs/SHARE.md
  // 的表、CLI 的档位名与本文件的计数三方钉死，多一个就是第四份要跟着改的口径；而「这条不该进包」
  // 的原因确实就是「它没有正文」，同一格读数不撒谎。
  if (!String(row?.content ?? "").trim() || informationlessReason(row)) {
    return { include: false, reason: "blank_or_noise", title: skipTitle };
  }
  // 命中判据时标题恒为空串，与「这条压根没标题」同一个出口形状（下游只看到字符串）。
  if (scanned) return { include: false, reason: "sensitive", title: "" };
  const content = redact(row?.content ?? "");
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
      // 这一条是**发送方库里的内容锚**，原样带过去只作引用，不是完整性凭证，别拿它
      // 校验「正文没在路上被改」（车道 C 注意）。两处对不上：① 它由 store 从**未脱敏**
      // 的 title/content 派生（store.js:1160 → contentHashOf，content-hash.js:49-53），
      // 而包里的 content/title 是遮过的——所以只要 home 遮过一次，两者就必然不一致，
      // 恰恰是遮过的那几条对不上；② 它算的是归一化后的文本（NFKC → 小写 → 去标点 →
      // 空白折叠），对面按收到的字节重算 sha256 本来就得不到同一个值。真要做传输完整性
      // 校验，得对遮后的字节另派一把新字段，不是复用这一把。
      content_hash: row.content_hash ?? null
    }
  };
}

/**
 * filters 一个键的形状归一：→「任一命中」的集合，或 null（= 没填，不收窄）。
 * type 与 tag 共用这一份判据（裁定：两者同形）。三条理由，方向各不同：
 * - 裸字符串与数组都算收窄。出口把 `--type` / `--tag` 给成串还是数组不由这里决定
 *   （单旗标给串、重复旗标与面板多选给数组都说得通），只认一种就是把另一种读成「没筛」
 *   = **放行整库**，而她以为只发了一类。多值取「任一」，与 type 原本用的集合口径一致。
 * - 空数组与只剩空白的条目算「没填」：清空勾选不等于要一个空包，读成「筛成 0 条」是替
 *   她说谎。同一次调用不该因为出口给串还是给数组而读出两种结果。
 * - 认不出的条目（非字符串）留在集合里 → 谁都不匹配 → 收窄到 0 条。这一侧错的方向是
 *   **少发**，report 与 stdout 当场看得见；「认不出就当没填」才是把整库发出去。
 */
function shareFilterSet(value) {
  if (value === undefined || value === null) return null;
  const kept = [];
  for (const item of Array.isArray(value) ? value : [value]) {
    if (typeof item !== "string") { kept.push(item); continue; }
    const trimmed = item.trim();
    if (trimmed) kept.push(trimmed);
  }
  return kept.length ? new Set(kept) : null;
}

/**
 * 打包。顺序是刻意的：过滤 → 逐条定性 → 用**进包的那对值**铸 external_id → 序列化 → 量字节。
 *
 * 水位量的是**最终序列化字节**，不是条数也不是字符数：这份包要原样当 body POST 回
 * 对面（车道 C），而中文字符数与 UTF-8 字节数差三倍，按字符数判等于把 413 留给对面；
 * 按条数判则对「条少但每条很长」的库说谎，那种包照样过大。字节只能在 JSON 写完之后再量，
 * 所以这里没有「先算大小再决定装几条」的分支。
 *
 * 超限**不裁条目**：裁到哪一条是替分享者做「哪条可以不发」的判断，而这份判断该由她自己
 * 用 filters 分批来做（spec §4 决策 5）。所以只拒绝，并把量到的 bytes 与 limitBytes 一起
 * 交回，让出口能说出「大了多少、怎么分批」。
 *
 * filters 是分享者的显式收窄，**不进跳过计数也不进清单**：那份账要说的是「本可以发、
 * 因为口径没发」，把她自己筛掉的记进去，读数就把她指向错的那一类。所以两个判据都排在
 * classifyRowForShare **之前**——这一条顺序是测试锁住的（把过滤挪到定性之后就多说几条
 * 她没跳过的行），别当成可读性优化来「合并条件」。
 *
 * skip_list 截到 SHARE_SKIP_LIST_MAX，skipped 的六个计数仍走全量——截的是清单不是账。
 * 清单里的 title 用 classifyRowForShare 返回值原样写入：它已在源头遮过 home，命中密钥
 * 判据的那几条也已在源头留空（标题是凭据的回声，而这份清单随包外发）。这里补第二刀
 * 是「两个口径」的开始，不是更安全。
 *
 * `report.deduped`：同一份包里铸出同一把 `external_id` 的行只发一条。键是
 * `(pack_id, type, title, content_hash)`，**没有 scope**，而库里同 type 同标题同内容锚、
 * scope 不同的两条是合法的两行（store.js:1233 的去重键带 agent/workspace/sensitivity
 * 三维）——所以「两条不同记忆铸出同一个键」是常态，不是畸形数据。为什么在出包侧折叠：
 * ①对面那台库没有 scope 这一维（包里就不带它），这两条到对面就是同一条记忆，正文与
 * 标题逐字节相同，发两份只是让她多两行一样的东西；②不折叠的后果不是重复而是**整包失败**
 * ——车道 C 的 `share_external_id` 是 UNIQUE 索引，第二条 INSERT 抛错会穿出 runAtomically
 * 的 ROLLBACK 把整包带走（spec §5 明写「先查管常规重复导入、UNIQUE 管并发」，可同一个包
 * 内部的两条先查谁都查不到，因为那时一行都没落）。「重跑就 created=0」救不了它：重跑吃的
 * 是同一个死键。方向上的代价只有少发一条重复正文，`included` 因此是**实际发出的条数**，
 * 折叠掉的数在 `deduped` 里，两份账相加才是「够格进包的行数」。
 */
export function buildSharePack({
  rows, alias = "", homeDir, packageVersion, filters = {},
  packId = randomBytes(8).toString("hex"), generatedAt = new Date().toISOString()
} = {}) {
  const redact = createHomeRedactor(homeDir);
  const wantedTypes = shareFilterSet(filters.type);
  const wantedTags = shareFilterSet(filters.tag);
  const skipped = { archived: 0, forgotten: 0, readonly_type: 0, excluded_type: 0, blank_or_noise: 0, sensitive: 0 };
  const skipList = [];
  const memories = [];
  // 折叠过的键（见模块头那段 `report.deduped` 的理由）。用 Set 而不是再查一次 memories：
  // 一个包几千条，`some` 会变成平方。
  const shipped = new Set();
  let deduped = 0;
  for (const source of Array.isArray(rows) ? rows : []) {
    // 两条判据都在定性之前（见上文：筛掉的不是跳过的，一次都不许进那份账）。
    if (wantedTypes && !wantedTypes.has(source?.type)) continue;
    if (wantedTags && !(Array.isArray(source?.tags) ? source.tags : []).some((t) => wantedTags.has(t))) continue;
    const verdict = classifyRowForShare(source, { redact });
    if (!verdict.include) {
      skipped[verdict.reason] = (skipped[verdict.reason] ?? 0) + 1;
      if (skipList.length < SHARE_SKIP_LIST_MAX) skipList.push({ title: verdict.title ?? "", reason: verdict.reason });
      continue;
    }
    // 键的四个入参一律取自 verdict.row，不是 source：收侧是按包内字节重算的（spec §5），
    // 铸造侧多吃一个遮之前的字节，对面就判成手改包而整包拒绝。内容锚同理——它是发送方
    // 遮之前的归一化锚（决策 4），但**包里的 content_hash 就是这一个值**，重算吃得准。
    const externalId = deriveExternalId(packId, verdict.row.type, verdict.row.title, verdict.row.content_hash);
    // 同键的第二条不发（见模块头）：留第一条，字节层面两条本就同文同题同锚。
    if (shipped.has(externalId)) { deduped += 1; continue; }
    shipped.add(externalId);
    memories.push({ external_id: externalId, ...verdict.row });
  }
  const pack = {
    kind: SHARE_KIND,
    pack_id: packId,
    alias: typeof alias === "string" ? alias.trim() : "",
    generated_at: generatedAt,
    source_version: String(packageVersion ?? ""),
    report: { included: memories.length, deduped, skipped, skip_list: skipList },
    memories
  };
  const bytes = Buffer.byteLength(JSON.stringify(pack), "utf8");
  if (bytes > MAX_PACK_BYTES) {
    return { ok: false, error: "too-large", pack, bytes, limitBytes: MAX_PACK_BYTES };
  }
  return { ok: true, pack, bytes };
}

// 车道 A 铸 pack_id 用的是 randomBytes(8) 的 hex，16 位；接收侧按这个形状判。
// 本行不是抄文档：spec §3 初稿写过 12 位，按它校验会把每一个真包拒掉。
export const PACK_ID_RE = /^[0-9a-f]{16}$/;

// 能入库的类型 = TYPE_FILE 的键集减去两个不随包走的排除项。这里重述一份而不是
// import mirror 的表，与 SHARE_READONLY_TYPES 同一理由：包的兼容面比镜像宽，
// 镜像哪天放开某个类型不该自动扩大接收侧的入库范围。形状由测试静态锁比对防漂。
// 耦合是双向的：出包口径不看 MIRROR_EXCLUDED_TYPES——某类若进了那个集合却没人对本表
// 做过决定，它照样随包发出、却在收侧把**整包**毒掉（invalid-type 是整包拒绝）；
// test/share-validate.test.js 的静态锁（直接 Object.keys(TYPE_FILE)）正是让这类
// 不匹配当场转红、而不是静默发生的仪器。
export const SHARE_ALLOWED_TYPES = new Set([
  "preference", "project", "decision", "history", "pitfall", "constraint", "rejected_solution", "pattern"
]);

// 上限管的是**成品标签**而不是别名片段：这个串要落进 tags 列并在面板上原样显示，
// 别名是对面自报的任意字符串，不封顶等于让她决定我们这里的字段长度。前缀 `from-`
// 也算在内，所以别名实际吃到的是 32-5=27 个字符。
const IMPORTED_TAG_MAX = 32;

/** 外来行的来源标签。别名是分享者自报的自由字符串，在这里被压成一条安全标签；
 *  空别名走中性值，绝不拿对面的机器身份（用户名、路径）兜底。 */
export function importedTagFor(alias) {
  // 整类空白（含换行与制表符）**一条规则**：游程折成一个 "-"。上一版删 \r\n\t、折其余
  // 空白——同一字符类开两条规则，而删除那侧恰恰制造 "a\nb" 与 "ab" 的同标签碰撞，
  // 还从收件人实际看得见的来源读数里擦掉词缝。「标签必须单行」两个行为都满足，不构成
  // 区分理由；仓库先例是 mirror.js 的 oneLine()：只折不删。
  // trim 排在折叠**之前**：全空白的别名折叠后会剩一个 "-"，于是拿到 `from--` 而不是
  // 中性值——「空别名走 from-shared」这条契约就漏在半空白那种写法上。
  const flat = String(alias ?? "").trim().replace(/\s+/g, "-");
  if (!flat) return "from-shared";
  return `from-${flat}`.slice(0, IMPORTED_TAG_MAX);
}

/**
 * 整包校验。返回第一个不合格项就停：半途入库是最难复盘的失败，而「哪一条不合格」
 * 对发送方已经足够（index + 一个码）。
 *
 * 判序也是契约的一部分（出口按码映射 400，不看码之外的次序）：包级三格先判，因为
 * 它们决定逐条判据有没有意义；条目内「类型 → 标题 → 正文」排在重算之前，因为一条
 * 空白正文无论键对不对都不该入库——把它记成 external-id-mismatch 会把人指向「包被改
 * 过」，而真正的问题是那条本身没内容。
 */
export function validateSharePack(pack) {
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) return { ok: false, error: "invalid-kind" };
  if (pack.kind !== SHARE_KIND) return { ok: false, error: "invalid-kind" };
  if (typeof pack.pack_id !== "string" || !PACK_ID_RE.test(pack.pack_id)) return { ok: false, error: "invalid-pack-id" };
  if (!Array.isArray(pack.memories)) return { ok: false, error: "invalid-memories" };
  if (!pack.memories.length) return { ok: false, error: "empty-pack" };
  const seen = new Set();
  for (let index = 0; index < pack.memories.length; index++) {
    const m = pack.memories[index];
    if (!m || typeof m !== "object") return { ok: false, error: "invalid-entry", index };
    if (!SHARE_ALLOWED_TYPES.has(m.type)) return { ok: false, error: "invalid-type", index, detail: String(m.type ?? "") };
    if (typeof m.title !== "string" || !m.title.trim()) return { ok: false, error: "invalid-entry", index, detail: "title" };
    if (typeof m.content !== "string" || !m.content.trim()) return { ok: false, error: "invalid-entry", index, detail: "content" };
    if (m.tags !== undefined && !Array.isArray(m.tags)) return { ok: false, error: "invalid-entry", index, detail: "tags" };
    if (m.importance !== undefined && !Number.isInteger(m.importance)) return { ok: false, error: "invalid-entry", index, detail: "importance" };
    // 16 位这个长度与 PACK_ID_RE 相同是巧合，不是同一份契约：pack_id 是 randomBytes(8)
    // 的 hex，这一把是 sha256 的前 16 位（deriveExternalId）。写成两个正则是为了让
    // 「哪天只把包 id 加长」不会顺手改掉这里的判据。
    if (typeof m.external_id !== "string" || !/^[0-9a-f]{16}$/.test(m.external_id)) return { ok: false, error: "invalid-entry", index, detail: "external_id" };
    // 四个入参与铸造侧逐字对齐，缺锚归一成 null 而不是跳过这一格：少了第四格时，同标题
    // 不同正文的两条会重算出同一个键，第二条被判成「包被人改过」——而它恰恰没被改。
    const expect = deriveExternalId(pack.pack_id, m.type, m.title, typeof m.content_hash === "string" ? m.content_hash : null);
    if (expect !== m.external_id) return { ok: false, error: "external-id-mismatch", index };
    if (seen.has(m.external_id)) return { ok: false, error: "duplicate-external-id", index };
    seen.add(m.external_id);
  }
  return { ok: true, pack, count: pack.memories.length };
}
