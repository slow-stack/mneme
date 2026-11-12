// 图像描述档（docs/DISTILL.md:346 的「描述档」）：
// 原图不落库、不读字节、不做 OCR——只在蒸馏前让一个**多模态模型**给每张图写一段
// 描述，把描述文字并进转录，图本身仍然只是 `[图: 文件名 …]` 占位。
//
// 三个决定与它们各自的理由：
//
// ① 图字节由宿主（@deepseek-ai/dsh-llm）编进请求，本模块不碰。
//    dsh-llm 的 adapter 边界会先看 modelInfo.inputModalities：含 image 就把消息里
//    的 image 块原样交给适配器（字节由它在内部取），不含就换成
//    `[image omitted because this model accepts text only; attachment sha256:…]`。
//    所以这里只负责「把真 image 块放进一次调用」，读文件/base64/attachments store
//    全都不需要——本插件也没有 attachments 服务可注入。
//
// ② 必须自己的 provider 槽，且留空就不描述。
//    蒸馏路由（summarizeProvider 或会话主模型）多半是纯文本模型。拿它去看图，
//    最坏的结果是宿主的 textOnly 降级把它换成占位——一次调用换回一行占位，白花钱
//    且看不出错。所以槽没配就整档不跑，只在审计 metadata 里留 skipped 原因。
//
// ③ 描述失败绝不影响蒸馏。
//    任何异常（路由不可用、模型不支持、流中断）都退化成「这张图没有描述」，
//    与 #611 之前的行为一致；描述是增强，不是蒸馏的前置条件。
//
// 长度上限：描述要挤进蒸馏转录（trimTranscript 只留尾部 N 字符），单张图给它
// MAX_DESCRIPTION_CHARS 的天花板，超了截断——四张图各写 800 字会把真正要蒸馏的
// 对话正文挤出窗口，那是拿主产物换辅产物。

import { STR, langOf } from "./lang.js";
import { withBackgroundSession } from "./llm-session.js";
import { imageLabel } from "./attachment-text.js";

/** 单张图描述的字数天花板（字符）。 */
export const MAX_DESCRIPTION_CHARS = 300;

/** 描述行前缀（与 attachment-text 的 `[图 …]` 占位区分开）。 */
export const DESCRIPTION_PREFIX = "描述：";

/**
 * 这个模型能不能看图。返回 true / false / "unknown"。
 *
 * `inputModalities` 缺席表示「未知」（老适配器不声明能力），不是「不支持」——
 * 宿主那侧对未知是不投影（照原样发），所以这里也该照发，让宿主决定。只有明确
 * 声明了且不含 image，才是确凿的「看不到」。
 */
export async function canSeeImages(ctx, provider, model) {
  if (typeof ctx?.llm?.resolveModelInfo !== "function") return "unknown";
  try {
    const info = await ctx.llm.resolveModelInfo(provider, model);
    const modalities = info?.inputModalities;
    if (!Array.isArray(modalities)) return "unknown";
    return modalities.includes("image");
  } catch {
    // 能力查询失败 = 无法证明不支持 → 按未知处理（同 dream.js 对 effort 的处置）。
    return "unknown";
  }
}

/** 从 content 块里挑出 image 块（保持原顺序、原对象，不改写任何字段）。 */
export function imageBlocks(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === "image" && block?.attachment);
}

/** 一张图的稳定标识：优先 attachmentId，其次元数据四元组，最后退回序号。 */
function attachmentKey(block, index) {
  const ref = block?.attachment ?? {};
  if (typeof ref.attachmentId === "string" && ref.attachmentId) return ref.attachmentId;
  const size = `${ref.width ?? "?"}x${ref.height ?? "?"}`;
  return `${ref.name ?? ""}|${ref.mediaType ?? ""}|${size}|${index}`;
}

function trimDescription(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_DESCRIPTION_CHARS) return flat;
  return `${flat.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`;
}

/**
 * 给一批 image 块出描述。返回 Map<attachmentKey, string>（只含成功的）。
 *
 * @param {object} ctx       插件 ctx（只用 ctx.llm.stream）
 * @param {{provider: string, model: string}} route  描述专用路由
 * @param {object} config    由 langOf 取提示词语言
 * @param {Array} blocks     image 块数组（通常是同一个 part 的）
 * @param {{signal?: AbortSignal}} [options]
 */
export async function describeImages(ctx, route, config, blocks, options = {}) {
  const out = new Map();
  if (!Array.isArray(blocks) || blocks.length === 0) return out;
  if (typeof ctx?.llm?.stream !== "function") return out;
  const prompt = STR.prompts.imageDescription[langOf(config)];
  for (const [index, block] of blocks.entries()) {
    const key = attachmentKey(block, index);
    if (out.has(key)) continue;
    try {
      let text = "";
      const stream = ctx.llm.stream(withBackgroundSession({
        provider: route.provider,
        model: route.model,
        purpose: "image-description",
        messages: [
          {
            role: "user",
            content: [
              // 图块原样转发：字节由宿主按 inputModalities 决定编不编进来。
              { type: "image", attachment: block.attachment },
              { type: "text", text: prompt }
            ],
            source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" }
          }
        ],
        ...(options.signal ? { signal: options.signal } : {})
      }));
      for await (const chunk of stream) {
        if (chunk?.type === "text-delta") text += chunk.text ?? chunk.delta ?? "";
        if (chunk?.type === "finish") {
          const kind = chunk.reason?.kind ?? chunk.kind;
          if (kind === "error" || kind === "aborted") break;
        }
      }
      const description = trimDescription(text);
      if (description) out.set(key, description);
    } catch {
      // 单张图失败不影响其他张，也不影响蒸馏（见文件头 ③）。
    }
  }
  return out;
}

/**
 * 把描述挂到占位行后面：`[图: 屏幕截图 …]` → `[图: 屏幕截图 …]\n  描述：…`。
 *
 * 只改描述行，不动占位本身——占位是 #611 定的口径（永不空串、带文件名与尺寸），
 * 描述是它的补充而不是替代。找不到对应 key 的块留原样。
 */
export function appendDescriptions(text, blocks, descriptions, indexOffset = 0) {
  if (!descriptions || descriptions.size === 0) return text;
  let result = text;
  // 同一附件常被重复贴（追问、引用），描述只该挂一次：已经处理过的 key 跳过，
  // 否则第二处会在自己那行上也插一行「描述：…」，读起来像图里有两段描述。
  const done = new Set();
  for (const [i, block] of (Array.isArray(blocks) ? blocks : []).entries()) {
    const key = attachmentKey(block, indexOffset + i);
    if (done.has(key)) continue;
    const description = descriptions.get(key);
    if (!description) continue;
    const placeholder = placeholderFor(block);
    if (!placeholder || !result.includes(placeholder)) continue;
    // 只替换第一次出现：同一张图重复贴两遍时，第二处留白比错位替换安全。
    result = result.replace(placeholder, `${placeholder}\n  ${DESCRIPTION_PREFIX}${description}`);
    done.add(key);
  }
  return result;
}

/** 占位行文本，与 attachment-text.js 的输出逐字一致（那边是唯一口径来源）。 */
function placeholderFor(block) {
  const label = imageLabel(block);
  return label ? `[图: ${label}]` : "[图]";
}
