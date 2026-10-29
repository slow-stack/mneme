// 记忆的来源身份里唯一需要跨模块判定的一维：外来行。
// 车道 C 导入的行走 store.save 直接落 source='imported'，因此它可能出现在任何行池里；
// 本谓词是「不许改写别人原文」这条契约的唯一实现。判据精确匹配、不做大小写魔法：
// source 是机器写的列，任何大小写变体都该被当成「不是外来行」而不是当成外来行。
export const IMPORTED_SOURCE = "imported";

export function isImportedRow(m) {
  return m?.source === IMPORTED_SOURCE;
}
