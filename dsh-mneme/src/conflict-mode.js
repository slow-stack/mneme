// 冲突处置的两个开关（conflictFreezeEnabled / conflictLedgerMode）的**唯一解析处**。
//
// 为什么需要它：这两个键此前被三处各自解析，而且解析结果互不一致——
//   · src/dream.js         —— enforce 让位给 freeze（ledgerEnforce = enforce && !freeze）
//   · src/dream/sleep.js   —— 同开时把 enforce 降成 shadow（记账照跑、处置不跑）
//   · src/service.js（注入侧）—— 只看 conflictLedgerMode，完全不看 freeze
// 于是同一份配置在「处置」「记账」「注入标注」三件事上给出三种答案：注入侧仍在给
// 矛盾对挂标注，处置侧一次都不跑。这不是 bug，是三个消费方对同一组配置解析不一致。
//
// 把解析收成一个纯函数之后，「配置成什么样就得到什么行为」才成立；以后再加消费方，
// 一律调这里，不许各自读 cfg 再判断。
//
// 面板侧另有一道同向的守卫（settings.js 的 setFeatureFlags 原子归一）：选中 enforce
// 自动关 freeze、打开 freeze 把 enforce 降成 shadow。面板那道管「写进去的值」，
// 这里管「读出来的值」——配置文件直接改、或旧版本已经存成双开的老库，都靠这里兜。

/**
 * 两个键同时开时谁的语义胜出。
 *
 * 口径与 #616 一致（父子绑定不继承）：**freeze 胜出**，ledgerMode 降级为 shadow。
 * 为什么是 shadow 而不是 off：分诊记账是零风险的测量动作（只写 conflict_ledger，
 * 不改任何一行记忆），停掉它等于让「切 enforce 之前先有一周真实分布可对」这条
 * 预注册证据断掉；而处置（T1 归档 / T3 落链 / T4 注入标注）必须停——绝不出现
 * 两套处置语义同时生效。
 */
export const FREEZE_WINS = "freeze-wins";

/**
 * 解析两个开关的最终语义。
 *
 * @param {object} config 插件配置（可能来自配置文件，也可能来自面板 kv 覆盖）
 * @returns {{ freeze: boolean, ledgerMode: "off"|"shadow"|"enforce", degraded: string|null }}
 *   `freeze`     —— 矛盾对是否停车等人审
 *   `ledgerMode` —— 分诊档位（可能与配置里写的不同，同开时被降成 shadow）
 *   `degraded`   —— 非 null 表示发生了降级，值说明原因（当前只有 freeze-wins）
 */
export function resolveConflictMode(config) {
  const freeze = config?.conflictFreezeEnabled === true;
  const rawMode = config?.conflictLedgerMode ?? "off";
  if (freeze && rawMode === "enforce") {
    return { freeze: true, ledgerMode: "shadow", degraded: FREEZE_WINS };
  }
  return { freeze, ledgerMode: rawMode, degraded: null };
}

// 降级告警「每进程一条」。dream 与 sleep 是两个独立调度器，各调一次
// resolveConflictMode；不收敛的话同一件事每轮打两行（旧代码更糟：两行说法方向相反，
// 一个说降 freeze、一个说降 shadow）。键用降级原因，不同原因各留一条。
const warned = new Set();

/**
 * 降级时打一条 warn，同一原因每进程只打一次。返回本次是否真的写了日志（测试用）。
 *
 * @param {{ warn?: Function }|null} logger
 * @param {{ degraded: string|null }} mode resolveConflictMode 的返回值
 * @param {string} where 触发点标识，仅用于日志定位（不参与去重）
 */
export function warnConflictModeDegraded(logger, mode, where) {
  if (!mode?.degraded) return false;
  const key = `${mode.degraded}`;
  if (warned.has(key)) return false;
  warned.add(key);
  logger?.warn?.(`dsh-mneme: conflictLedgerMode=enforce coexists with conflictFreezeEnabled — degrading to shadow (freeze wins); disable one of them [${where}]`);
  return true;
}

/** 测试钩子：清空「已告警」记忆，让每个用例看到同一起点。 */
export function resetConflictModeWarnings() {
  warned.clear();
}
