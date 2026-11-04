// 配置键覆盖面的「唯一一份」描述（issue #386 第 7 条）。
//
// 为什么单独一个模块：面板上能改的键（settings.js 白名单）与 schema 里实际存在的
// 键（config.js 的 Config）是两张表，它们从来没被摆在同一个地方对过。于是
// 「用户能理解、但面板改不到」的键只能靠读源码 + 手数得到答案——issue #386 列了
// 七组、维护者另外复述了一遍，每次都要重新数。
//
// 这里只做「算」：把 schema 声明的叶子键与白名单取交/差，回三份清单。它不读
// 数据库、不碰 cfg 的实际值、**不返回任何键的值**——apiToken 这类敏感键的名字可以
// 出现在「仅配置文件」清单里（那正是这条 issue 想让用户看见的东西），值一个字节
// 都不出。判定口径住在 flagKeysFromSpec，api.js 的 featureSnapshot 用的也是它；
// 谁要是另抄一份白名单，test/config-keys-routes.test.js 的静态锁直接转红。

import { Config } from "./config.js";
import { FEATURE_FLAG_SPEC } from "./settings.js";

/**
 * 白名单里的全部键（面板 PUT 能写、effective 会算的那些）。
 *
 * 顺序与 api.js 的 featureSnapshot 逐字对应：booleans → ints → numbers → strings
 * → urls → enums。api.js 直接引这一份，不再自己拼一遍。
 */
export function flagKeysFromSpec() {
  return [
    ...FEATURE_FLAG_SPEC.booleans,
    ...Object.keys(FEATURE_FLAG_SPEC.ints),
    ...Object.keys(FEATURE_FLAG_SPEC.numbers),
    ...FEATURE_FLAG_SPEC.strings,
    ...FEATURE_FLAG_SPEC.urls,
    ...Object.keys(FEATURE_FLAG_SPEC.enums)
  ];
}

/**
 * 把「已解析的配置对象」摊平成叶子键清单。
 *
 * 这份清单的含义是**「有默认值因此会出现在 effective 里的键」**，不是「schema 声明
 * 了哪些键」——两者不等。`Config({})` 解析后 `apiToken` 根本不存在（`z.string()`
 * 没有 `.default()`），若拿它当 schema 清单，最该被用户看见的那个键反而消失了
 * （第一版就是这么错的，被 `config-keys returns key names but never the apiToken
 * value` 那条用例抓住）。
 *
 * 数组当叶子（`sessionGateSessions` 是 `z.array`，面板没有编辑器，整条替换不算
 * 「改一个值」）。
 */
export function defaultedLeafKeys(instance = Config({})) {
  const out = [];
  const walk = (node, prefix) => {
    for (const key of Object.keys(node)) {
      const value = node[key];
      const path = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) walk(value, path);
      else out.push(path);
    }
  };
  walk(instance, "");
  return out;
}

/**
 * schema **声明**的全部叶子键（含没有默认值的那些，比如 apiToken）。
 *
 * 直接走 schema 的 ref 图而不是解析结果：`Config.dict` 里每一项都是
 * `{ uid, refs }`，真实节点在 `refs[uid]`。三种形状要分开处理：
 *   - `object`：有 `dict`，递归进去；
 *   - `dict`：键是开放的（`heatTypeDecay` 就是），只能靠 `meta.default` 的对象键
 *     把已知的那几个名字还原出来；没有默认值就整条当一个叶子；
 *   - 其它：叶子。
 *
 * 探针实测：声明叶子 196 个、解析结果 191 个、白名单 113 个。两边差的那五个是
 * `dreamProvider` / `dreamModel` / `dreamReasoningEffort` / `apiToken` /
 * `sleepReasoningEffort`——都只声明、没给默认值。
 */
export function schemaLeafKeys(schema = Config) {
  const out = [];
  const resolve = (node) => (node && node.refs && node.uid in node.refs ? node.refs[node.uid] : node);
  const walk = (node, prefix) => {
    const real = resolve(node);
    if (!real) return;
    if (real.type === "object" && real.dict) {
      for (const key of Object.keys(real.dict)) walk(real.dict[key], prefix ? `${prefix}.${key}` : key);
      return;
    }
    if (real.type === "dict") {
      const def = real.meta && real.meta.default;
      if (def && typeof def === "object" && !Array.isArray(def)) {
        for (const key of Object.keys(def)) out.push(`${prefix}.${key}`);
        return;
      }
    }
    out.push(prefix);
  };
  if (schema && schema.dict) {
    for (const key of Object.keys(schema.dict)) walk(schema.dict[key], key);
  }
  return out;
}

/**
 * 三份清单 + 计数。#386 第 7 条要的答案全在这里。
 *
 * - `panelEditable`：schema 声明了、且白名单也登记了的键（面板能改）。
 * - `fileOnly`：schema 声明了、面板改不到的键——issue 正文点名的那七组都在里面，
 *   连同 `apiToken`、`memoryDir` 这类「知道它存在就够了」的键。
 * - `undefaulted`：白名单登记了、schema 也有，**但没有 `.default()`**，所以
 *   `effective` 里根本不会出现它。**这是本轮读码发现的一处真实不对称**：
 *   `dreamProvider` / `dreamModel` 在 settings.js 的 STRINGS 表里，config.js 那边
 *   只有 `z.string().description(...)` 而没有 `.default()`，于是面板有输入框、保存
 *   也能存，但 `featureSnapshot()` 的 `configFlagValue` 取到 undefined 就不写进
 *   effective（api.js 的 `if (value !== undefined)`）。列出来而不擅自补默认值：
 *   补默认值会改变「未配置时到底用哪个模型」的既有行为，那是另一个决定。
 *
 * 三份互不相交，并集 = 白名单 ∪（声明里不在白名单的那批）——探针实测白名单
 * 113 个全部都在声明里，所以并集就是声明的 196 个，一个不漏也不重复。
 */
export function describeConfigKeys() {
  const declared = schemaLeafKeys();
  const declaredSet = new Set(declared);
  const defaulted = new Set(defaultedLeafKeys());
  const flags = flagKeysFromSpec();
  const flagSet = new Set(flags);

  const panelEditable = [];
  const undefaulted = [];
  for (const key of flags) {
    if (!declaredSet.has(key)) continue;
    if (defaulted.has(key)) panelEditable.push(key);
    else undefaulted.push(key);
  }
  const fileOnly = declared.filter((key) => !flagSet.has(key));

  return {
    counts: {
      schemaLeaf: declared.length,
      flag: flags.length,
      panelEditable: panelEditable.length,
      fileOnly: fileOnly.length,
      undefaulted: undefaulted.length
    },
    panelEditable,
    fileOnly,
    undefaulted
  };
}
