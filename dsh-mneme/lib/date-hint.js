/**
 * 记忆条目上「模型可见」的日期标注。
 *
 * 背景：注入行与工具回执原来只给 updated_at（memory_get 连 updated_at 都不给），
 * 而模型回答「这条多旧了 / 还作不作数」唯一能用的就是时间。updated_at 又不是年龄
 * ——巩固（dream）合并时会把败者正文加注记并归档、顺带刷新 updated_at，全库
 * updated_at > created_at 的行里真漂移（≥1 天）有 656 行，最长 51 天。所以年龄
 * 必须看 created_at，事件时间有 occurred_at 时优先用它。
 *
 * 为什么只给日期不给时间：模型要判的是「多旧」，秒级精度没有信息量，每行却要多耗
 * 8 个字符的注入预算（MAX_BLOCK 只有 maxContent + 600）。跨年场景 YYYY-MM-DD 本身
 * 就覆盖了。
 *
 * 为什么按 UTC 切而不是宿主本地时区：created_at / occurred_at 落库都是 UTC ISO 串
 * （store 侧 Date.toISOString()）。按本地时区格式化会让同一份库在两台机器上渲染出
 * 不同的注入文本，测试也没法钉死。最坏情况是 UTC 16:00 之后的事件被标成前一天，
 * 对「多旧」这个用途无影响，确定性优先。
 */

/** ISO 时间串 → `YYYY-MM-DD`；空值或形状不对返回 ""（调用方据此跳过，不渲染占位符）。 */
export function hintDate(iso) {
  const s = String(iso ?? "");
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "";
}

/**
 * 条目日期：事件发生时间优先（occurred_at 是「这件事什么时候发生的」），缺省回落到
 * 落库时间 created_at（必填列，永远有值）。
 */
export function memoryDate(m) {
  return hintDate(m?.occurred_at) || hintDate(m?.created_at);
}
