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
