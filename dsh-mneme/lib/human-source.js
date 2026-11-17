// #745：什么样的 source 才算「人提问」。
//
// 旧实现只认 `source.kind === "user"`，而宿主 0.2.x 里人类输入并不都叫这个名字：
// 经 DS Bot / 群聊中继进来的消息是 `{ kind: "bot", form: "relay" }`（本机 853 个
// 会话、40,584 条 user/message 实测：`user` 5051 条、`bot|relay` 4986 条）。
// 于是中继会话里 `lastUserMessageInfo()` 一路回溯到上一条 kind:"user" 的消息（或
// 空串），`inboxMessageQuery()` 直接返回 ""，票据一次都不会被写入——注入查询恒为
// 空串，检索退化成「按重要度固定取几条」，Step 1 拿上一轮文本的观感也由此而来。
//
// 判据因此改成**白名单 + 明确的来源**，而不是「不是 user 就丢」：
//   - `user`：GUI 直输；
//   - `bot` ：DS Bot / 群聊中继（form:"relay"）；
//   - `plugin:dsh-onebot`：QQ 桥中继的人类消息（`<user_message ...>`）。
// 但白名单只回答「谁发的」，还要看「以什么形态进来的」：form 属于
// snapshot/catalog/notice/instructions 的一律排除（见 NON_HUMAN_FORMS），
// 否则将来某个插件用 `{kind:"bot", form:"notice"}` 推机器通知会被当成提问。
// 其余一律不算人提问：`runtime-context`/`time-context`/`skill-catalog`/
// `agent-instructions` 是宿主快照，`plugin:dsh-mneme` 是我们自己的 continuity
// 注入，`coordinator`/`agent-message`/`subagent-report`/`team-message` 是 Bot 之间
// 的投递（不是「当前用户想干什么」），`schedule` 是提醒不是提问。
// 没列进来的新传输方式退回旧行为（查询为空串，即不回归、但也没修好）——要支持
// 新传输，在这里加一行，所有消费点会一起跟上。
//
// Issue #745 查下来，同一条判据在四处各写了一遍（注入查询 / 蒸馏转录 / 连续性
// 快照 / 日记素材），四处一起漏掉中继消息。所以抽成这份共享模块：口径只有一个，
// 改一处四处齐动。
const HUMAN_INPUT_KINDS = new Set(["user", "bot", "plugin:dsh-onebot"]);

// `form` 说的是「这条消息以什么形态进来」。snapshot / catalog / notice /
// instructions 全是宿主或插件自己塞的机器上下文，即便 `kind` 落在白名单里也不能
// 当提问——`kind:"bot"` 现在只靠 kind 放行，将来哪个插件用
// `{kind:"bot", form:"notice"}` 推机器通知，就会被误认成用户在说话。
const NON_HUMAN_FORMS = new Set(["snapshot", "catalog", "notice", "instructions"]);

/**
 * 这条消息是不是人写进来的（= 可以当「用户提问」用）。
 *
 * 只判 source，不看正文；拿不到正文的调用方仍需自己判空。
 * 缺 source / 缺 kind 的旧事件放行（旧行为），其余默认拒绝。
 */
export function isHumanInputSource(source) {
  if (source === undefined || source === null) return true; // 旧事件没有 source
  if (typeof source !== "object") return false;
  // form 的排除排在 kind 之前：`{ form: "snapshot" }` 这种没带 kind 的机器注入
  // 若先撞上「没有 kind 就当旧事件放行」，就会绕过上面那条一律排除的约定，
  // 把快照正文当成最近一次人类提问（认领路径还会把它写进票据）。
  const form = source.form;
  if (typeof form === "string" && NON_HUMAN_FORMS.has(form)) return false;
  const kind = source.kind;
  if (kind === undefined) return true; // 更旧的事件：没有 kind
  return HUMAN_INPUT_KINDS.has(kind);
}
