// 从目录引导（bootstrap）的 HTTP 口径 —— 唯一实现。
//
// 为什么要单独一个模块：这张脸原本只有一个入口（Bearer 数据面 src/api-standalone.js
// 的 POST /bootstrap），#386 第 6 条要给面板补入口，于是就有了第二个。历史教训写在
// reclaim-http.js 的开头：#410 修好面板侧之后数据面还停在旧形态（#411），整段复制
// 必然漂移。所以解析、校验、答复形状从第一份就落在这里，两个入口只留路径与鉴权不同。
//
// 这里只做协议层的事：解析、校验、把 bootstrapFromDirectory 的结果包成答复。真正的
// 解析在 src/bootstrap.js——它读目录、抽六类确定性产物，零 LLM。
//
// 与 reclaim-http.js 的一处刻意不同：这里**不做 confirm 两步确认**。bootstrap 是
// 幂等的（吃 saveWithDedupe 的 (type,title,scope) 去重，`_overwrite` 只刷新内容），
// 重复跑不会翻倍，也不会删任何东西，所以不需要「先看报告再执行」那道门。

/**
 * 「引导能力没接线」的错误码。两个入口各有一次顺序敏感的显式检查（503 要赢过 400：
 * 端点整个没接线时报「dir 不合法」是误导），所以这条不能只藏在 bootstrapReply 里；
 * 但也必须是同一份字符串。
 */
export const BOOTSTRAP_UNAVAILABLE = "bootstrap-unavailable";

/** 引导失败的 warn 文案。两条路径共用，日志里不会出现两种拼法。 */
export /**
 * 记日志这一手，只许经这里。
 *
 * 照 `share-http.js` 的同一份理由抄（C5 评审裁定）：warn 裸调时，宿主 logger 自己坏掉就会
 * 从 catch 块里再抛出去，而两侧 handler 那个外层 try 在 .then 的回调里早已退栈——现场
 * 就是「一个字节都没回」（#410）。守卫住在层里，两张脸（in-process 与 Bearer 数据面）
 * 拿到的就是同一个脾气，不必每张脸各记一次。
 */
function warnSafely(warn, message) {
  try {
    warn?.(message);
  } catch { /* 记日志是自己的事，坏了的日志不许把已经算好的答复一起带走 */ }
}

function bootstrapWarnMessage(error) {
  return `[dsh-mneme] bootstrap failed: ${String(error)}`;
}

/**
 * 解析 POST body（已读成文本）的结构。只判 JSON 与顶层形状，dir 在 readBootstrapDir
 * 里读——两步分开是为了保住「invalid-json → invalid-body → 能力是否接线 → dir」这个
 * 顺序，这个顺序是既有对外行为。
 *
 * 不用 api.js 的 parseBody：它把坏 JSON 吞成 {}，而 invalid-json 与 invalid-body 是
 * 两个不同的错（前者是调用方发坏了，后者是发成了数组/null）。
 *
 * @returns {{ok: true, body: object} | {ok: false, error: string}}
 */
export function parseBootstrapJson(text) {
  let body;
  try {
    body = JSON.parse(text || "{}");
  } catch {
    return { ok: false, error: "invalid-json" };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid-body" };
  }
  return { ok: true, body };
}

/**
 * 读 dir 并归一化。
 *
 * 只收非空字符串：插件没有「工作区根目录」的概念，绝不猜路径（猜错就会去读一个
 * 与用户意图无关的目录，然后把里面的东西写进记忆库）。`trim()` 之后再判空，
 * 但**回传原串**而不是 trim 后的——两端空白在 Windows 路径里不合法，交给 fs 报
 * dir-not-found 比在这里静默改写更诚实。
 *
 * @returns {{ok: true, dir: string} | {ok: false, error: string}}
 */
export function readBootstrapDir(body) {
  if (typeof body.dir !== "string" || !body.dir.trim()) {
    return { ok: false, error: "missing-dir" };
  }
  return { ok: true, dir: body.dir };
}

/**
 * 把一次引导请求变成 { status, body }。调用方只管 sendJson，不自己拼答复。
 *
 * 报告一律不加包装层（就是 bootstrapFromDirectory 的原样返回）：面板与数据面都直接
 * 读 created / merged / items 这几格。
 *
 * `BootstrapError` 带 `code`（missing-dir / dir-not-found / not-a-directory），它们
 * 是**调用方的输入问题**，回 400 并把 code 当错误码；其余异常是内部问题，回 500，
 * 且不能让 warn 把异常本身吞掉。
 *
 * @param {{bootstrapper: ((input: {dir: string}) => Promise<object>)|null,
 *          dir: string, warn?: ((msg: string) => void)|null}} input
 * @returns {Promise<{status: number, body: object}>}
 */
export function bootstrapReply({ bootstrapper, dir, warn = null }) {
  if (!bootstrapper) return Promise.resolve({ status: 503, body: { error: BOOTSTRAP_UNAVAILABLE } });
  return Promise.resolve()
    .then(() => bootstrapper({ dir }))
    .then((summary) => ({ status: 200, body: summary }))
    .catch((error) => {
      if (error?.code) return { status: 400, body: { error: error.code } };
      warnSafely(warn, bootstrapWarnMessage(error));
      return { status: 500, body: { error: "internal" } };
    });
}
