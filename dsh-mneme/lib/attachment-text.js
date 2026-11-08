// 图块抽取：会话消息里的 `type:"image"` 块到纯文本占位（Issue #611）。
//
// 为什么单独一个模块：在本次改动之前，`textOf` 的实现在 summarize / continuity /
// hot-memory 三处各有一份副本（各写一份的理由不同，注释里都写了）。三份都是
// `p?.type && p.type !== "text"` → 空串，于是图片一律被丢。给三份各加一遍 image
// 分支，等于给同一件事写三份实现——而这三份本来就该同一个口径。所以为 image
// 单独抽一个**只做一件事**的模块：给定一个 content 块，回答它的可读文本。
//
// 口径（维护者 2026-11-08 定，先只做 off 档）：
// - 不调 vision、不读字节、不落原图。宿主有 `attachments.readImage()`，但记忆库
//   已 273MB，原图档明确不做。
// - 占位形如 `[图: 屏幕截图 2026-10-19.png]`，带文件名与宽高，够人回看时定位；
//   拿不到名字时退化成 `[图: image/png]`、再退化成 `[图]`，**绝不返回空串**——
//   返回空串正是本次要修的那个 bug（图-only 消息整条被丢，静默）。
// - 这里只回答「这一块读出什么文本」，不回答「这个模型能不能看图」。后者要看
//   `llm.resolveModelInfo(...).inputModalities`，属于描述档的准入判断，本批不做。

/** 图片块的占位前缀：审计与测试都按它计数。 */
export const IMAGE_PLACEHOLDER_PREFIX = "[图";

/** 一个图片块读出的人类可读标签（不含方括号）。什么元数据都没有时返回空串。 */
export function imageLabel(block) {
  const attachment = block?.attachment ?? {};
  const name = typeof attachment.name === "string" ? attachment.name.trim() : "";
  const mediaType = typeof attachment.mediaType === "string" ? attachment.mediaType : "";
  const width = Number.isFinite(attachment.width) ? attachment.width : undefined;
  const height = Number.isFinite(attachment.height) ? attachment.height : undefined;
  const size = width !== undefined && height !== undefined ? `${width}x${height}` : "";
  // 没有名字也没有 mediaType 时返回空串，由调用方退化成裸 `[图]`——宁可写「有一张图」，
  // 也不要写「[图: image]」这种把类型名当名字的假标签。
  const head = name || mediaType;
  if (!head) return "";
  const tail = [mediaType && name ? mediaType : "", size].filter(Boolean).join(" ");
  return tail ? `${head} ${tail}` : head;
}

/**
 * 把一个 content 块读成文本。
 *
 * @param {unknown} block  content 数组里的一项
 * @param {object} [options]
 * @param {boolean} [options.imagePlaceholder=true]  false 时图片块返回空串（旧行为，
 *   留给需要严格「只要文字」的调用方，例如把同一批内容喂给不支持图的模型）。
 * @returns {string}
 */
export function blockToText(block, options = {}) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  if (block.type === "image") {
    if (options.imagePlaceholder === false) return "";
    const label = imageLabel(block);
    return label ? `${IMAGE_PLACEHOLDER_PREFIX}: ${label}]` : `${IMAGE_PLACEHOLDER_PREFIX}]`;
  }
  if (block.type === undefined || block.type === "text") {
    return typeof block.text === "string" ? block.text : "";
  }
  // reasoning 等私有块：刻意不采集（各调用方的注释都写了理由，这里不重复）。
  return "";
}

/**
 * 把一个 content 数组读成多行文本。字符串数组（宽松形状）与严格块数组都认。
 *
 * @param {unknown} content
 * @param {object} [options] 透传给 blockToText
 * @returns {string}
 */
export function contentToText(content, options = {}) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => blockToText(block, options))
    .filter((s) => s)
    .join("\n");
}

/**
 * 数一段 content 里有几个图片块（审计用）。
 *
 * 为什么单独一个函数而不是在 contentToText 里顺带返回：调用方要的是「这一窗有多少
 * 张图」这个数，而 contentToText 的返回值是字符串，签名不想为一个计量改成对象。
 *
 * @param {unknown} content
 * @returns {number}
 */
export function countImages(content) {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "image") n += 1;
  }
  return n;
}
