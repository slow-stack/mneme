/**
 * 后台 LLM 调用的会话标识（issue #668）。
 *
 * 主对话之所以能走网关，是因为 `@deepseek-ai/dsh-agent-loop` 在请求里带了
 * `sessionId: this.session.id`；而 pi-ai 的 opencode / opencode-go 适配器
 * （`dist/providers/opencode-headers.js` 的 `withSessionHeader`）**只在
 * `options.sessionId` 存在时**才注入 `x-opencode-session` 头，缺了就被网关
 * 直接 400 `MissingSessionID` 拒绝。
 *
 * 插件这一侧有 7 处后台调用：总结提炼、记忆巩固、sleep 各相位、实体抽取、
 * 注入门控、连通性探测、图像描述。它们都没有真实会话——不是「忘了传」，
 * 而是本来就不属于任何用户会话（审计行 `session_key` 也一直是 NULL）。
 * 于是传一个稳定的固定标识：只服务网关路由，不参与会话归属、不影响谁能看到
 * 什么、也不改变记忆的作用域判定。
 *
 * 为什么不按 run id 派生：那会让网关把同一批后台调用当成 N 个不同会话，
 * 既拿不到路由复用的好处，也让排障时「这是插件干的」和「这是某个用户在聊」
 * 混在一起。固定值一眼能分辨来源。
 */
export const BACKGROUND_SESSION_ID = "dsh-mneme";

/**
 * 后台调用的 `purpose` 值（2026-11-26）。
 *
 * 这里原本是 `"compaction"`，理由只是想借用「后台通道」的配额分类——结果
 * 撞上了代理层（billion-context / bili）对 DSH 原生压缩调用的封堵判据。
 *
 * 完整链路：
 * 1. DSH 把 `purpose` 塞进请求头 `x-bili-plugin-purpose`（bili 的宿主半
 *    `dist/agent/dsh-native.js` 里 `attr.purpose ?? "conversation"`）；
 * 2. bili 代理半 `dist/index.js` 判 `pluginAgent==="dsh" && purpose==="compaction"`
 *    就认定这是「DSH 原生压缩」，返回 422 `dsh_compaction_refused`，理由是原生
 *    压缩的 checkpoint 会把原始历史永久遮蔽掉、毁掉 bili 自己的压缩底座
 *    （bili #1729 / #1772 / #1206）。这个拒绝是 terminal 的，重试每次都一样。
 *
 * 代价（本机实测）：2026-11-18 起到 11-26，巩固轮 `dream_consolidate` **48 次
 * 全失败、0 次成功**，失败原因全是这个 422；而画像事实维护挂在巩固轮之后
 * （`src/index.js` 的 `profileChain`，前一条 `rep.ok === false` 就整段跳过），
 * 于是 `profile_facts` 从 11-17 之后 9 天零新增——功能看起来「没坏」，只是
 * 再也产不出东西。
 *
 * 所以：**purpose 绝不能再用 `"compaction"`**，任何一个后端把它当语义标签
 * 读都可能再撞一次。用带插件前缀的自有值，即便别的层要认也能一眼看出是
 * 我们发的；`isSideRequest` 只要求 purpose 非空，换值不影响它继续走后台
 * 通道（那条判据是 `purpose !== void 0 && purpose.length > 0`）。
 *
 * 新增后台 LLM 调用时**一律引用这个常量**，不要再写字面量。
 */
export const BACKGROUND_PURPOSE = "dsh-mneme-background";

/**
 * 给一份 GenerateOptions 补上后台会话标识。
 *
 * 已自带 `sessionId` 的调用方保持原值不动（宿主若哪天替我们传了真实会话，
 * 那个更精确，不该被覆盖）；其余情况补 `BACKGROUND_SESSION_ID`。
 * 纯函数，不修改入参。
 */
export function withBackgroundSession(options) {
  if (!options || typeof options !== "object") return options;
  if (options.sessionId) return options;
  return { ...options, sessionId: BACKGROUND_SESSION_ID };
}
