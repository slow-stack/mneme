/**
 * 运行中的 standalone API 实例的句柄表 —— 只为一件事存在：令牌轮换。
 *
 * 为什么需要这个文件：`src/index.js` 装配 standalone server 时拿到的是个**局部
 * 变量**，host 路由（`src/api.js` 的 `/api/dsh-mneme/external-api`）根本看不见它。
 * 于是「改配置」一直只能落库、等下次启动生效。令牌轮换不能这样等：面板刚把新
 * 令牌显示出来、用户立刻复制走，而运行中的服务还在认旧令牌，调用方会集体 401
 * —— 面板显示一个服务并不接受的钥匙，是最典型的假成功。
 *
 * 为什么只放一个槽位：一个 DSH 进程只跑一个 standalone server（index.js 里单点
 * 装配）。做成多实例容器就等于在这里再造一份「谁在跑」的真源，和配置 kv 打架。
 * 后来者替换前者；卸载时用同一个句柄做条件清除，避免把下一任误清掉。
 *
 * 这个模块刻意不持有 settings/config：令牌生成与落库仍是 standalone 实例自己的
 * 职责（它拿着同一个 settings 实例），这里只负责「把意图转交给活着的那一个」。
 */
let active = null;

/** 记下当前运行的实例（index.js 在 server 起来后调用）。 */
export function registerStandaloneApi(api) {
  active = api ?? null;
}

/**
 * 条件清除：只有还在位的那一个才清得掉。传 api 比裸清安全——卸载旧实例时若
 * 已经被新实例顶替，裸清会把新实例一起抹掉，轮换就静默退化成「重启后生效」。
 */
export function clearStandaloneApi(api) {
  if (active && (!api || active === api)) active = null;
}

/**
 * 让活着的实例换令牌：返回新令牌；没有活实例（服务未启用、绑定失败、已卸载）
 * 时返回 null —— 调用方据此如实报 `applied: "live" | "restart"`，绝不假装成功。
 */
export function rotateStandaloneToken() {
  if (!active || typeof active.rotateToken !== "function") return null;
  return active.rotateToken();
}