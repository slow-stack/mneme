// dsh-mneme/src/choro-command.js
// /choro：仓库地志的只读回执（M3，spec §10）。
//
// 与 pipeline-command.js 的区别：那边持有状态（开窗 / 结账），这边**什么都不写**。
// spec §2 D6 定的是「只手动触发，过期只提示」——重建、富化、切档位全都不在这条
// 命令里，它只回答三个问题：当前仓库登记过地志吗？基线还一致吗？提纲长什么样？
import { gitHead } from "./wiki/t0.js";
import { renderChoroBlock } from "./wiki/inject.js";
import { STR } from "./lang.js";
// #607：提示里的 CLI 命令必须给绝对路径入口（profile 装的插件没有全局 shim），
// 光写 `dsh-mneme-choro` 让用户照抄只会 command not found。推导不出入口时
// 返回 null，文案退回通用说法——宁可少说，也不给一条跑不起来的命令。
import { choroCliCommandFrom } from "./wiki/cli-hint.js";

export const CHORO_COMMAND = "choro";

/** 短 sha：回执里只用于人眼比对，给全 40 位纯属噪音。 */
function shortSha(sha) {
  const text = String(sha ?? "").trim();
  return text.length > 7 ? text.slice(0, 7) : text;
}

/** 生成时间只留日期（与注入块同口径：分钟级精度在这块文本里没有信息量）。 */
function dateOnly(iso) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso ?? ""));
  return m ? m[1] : String(iso ?? "");
}

/**
 * 过期判定：地志落库时的 git 基线 vs 当前 HEAD。
 *
 * **只在这里做**——注入块是每轮都要渲染的热路径，fork 一次 git 在 Windows 上
 * 几十毫秒起步（P29）。这里是用户主动敲的，付得起一次 rev-parse。
 * 三种结局分开报：一致 / 不一致 / 读不到 git——不能把「读不到」说成「没过期」。
 */
function staleness(repo) {
  const baseline = String(repo.git_baseline ?? "").trim();
  const head = gitHead(repo.root_path);
  if (!head) return { state: "no-git", baseline, head: null };
  if (baseline && baseline === head) return { state: "fresh", baseline, head };
  return { state: "stale", baseline, head };
}

/**
 * 处理函数。返回 CommandResult 形状 { kind, text }——**只作 UI 回执，不进模型
 * 上下文**（同 pipeline-command.js 的契约注释）；要模型看提纲，走开局注入那条路。
 *
 * @param {object} opts.choro createChoroQueries() 的产物
 * @param {object} opts.config 合并后的配置
 * @param {() => string} [opts.language]
 */
export function createChoroHandler({ choro, config, language = () => "zh" } = {}) {
  // 本文件在 `src/` 与 `lib/` 的同一层（bin/ 的父级），推导一次就够，不必每次
  // 报错都去碰文件系统。
  const cli = choroCliCommandFrom(import.meta.url, language() === "en" ? "<repo path>" : "<仓库路径>");
  return (invocation) => {
    const lang = language() === "en" ? "en" : "zh";
    const S = STR.choroCommandUsage[lang];
    try {
      // 闸只认 chorographyEnabled，不认注入档位：resolveInjectTier 在轻量档下也返回
      // "off"，用它当闸会让 lightMode 的用户敲 /choro 时听到「没开，去设置里打开」
      // ——而设置里明明是开着的（档位只管注入，不管这条命令能不能看提纲）。
      if (!config || config.chorographyEnabled !== true) return { kind: "error", text: S.off };
      const raw = invocation?.agent?.session?.header?.cwd ?? null;
      const cwd = typeof raw === "string" ? raw.trim() : "";
      if (!cwd) return { kind: "error", text: S.noCwd };
      const repo = choro ? choro.repoByCwd(cwd) : null;
      if (!repo) return { kind: "error", text: S.noRepo(cwd, cli) };
      const outline = choro.outline(repo.id);
      if (!outline || outline.modules.length === 0) {
        return { kind: "success", text: S.title(repo.name, 0, dateOnly(repo.updated_at)) + "\n" + S.empty };
      }
      const lines = [S.title(repo.name, outline.modules.length, dateOnly(outline.generatedAt))];
      // 命令里的清单不设 light 的 6 行上限：人主动敲了命令就是要看全表。
      // 但 full 档的字符上限仍由 renderChoroBlock 自己兜——回执是 UI 里一个文本框，
      // 贴爆它同样是失败（上限不在这里判，两处各判一次迟早对不上）。
      const block = renderChoroBlock(outline, "full", lang);
      if (block) lines.push(block.split("\n").slice(1).join("\n"));
      // 截断语要说「还剩几个」，不是「总共几个」：总表格行数减去真列出来的行数才是
      // 读者没看到的量。传总数会让人以为「另有 38 个」而实际只漏了 3 个。
      const listed = block ? block.split("\n").filter((line) => line.startsWith("- ")).length : 0;
      const rest = Math.max(0, outline.modules.length - listed);
      if (rest > 0) lines.push(S.truncated(rest));
      const head = staleness(repo);
      if (head.state === "fresh") lines.push(S.fresh(shortSha(head.head)));
      else if (head.state === "stale") lines.push(S.stale(shortSha(head.baseline), shortSha(head.head), cli));
      else lines.push(S.noGit);
      lines.push(S.hint);
      return { kind: "success", text: lines.filter(Boolean).join("\n") };
    } catch (error) {
      // 回执层永不抛进宿主（同 pipeline-command.js）：把原因写进文本就够了。
      return { kind: "error", text: String(error?.message ?? error) };
    }
  };
}

/**
 * 注册。返回 disposer 或 null（宿主没有命令注册表时静默返回 null，不抛）。
 * 形状与 registerMoRunCommand 一致——两条内置命令只有「做什么」不同。
 */
export function registerChoroCommand({ ctx, choro, config, enabled, language = () => "zh" }) {
  if (enabled !== true) return null;
  if (typeof ctx?.commands?.register !== "function") return null;
  const lang = language() === "en" ? "en" : "zh";
  return ctx.commands.register({
    name: CHORO_COMMAND,
    description: STR.choroCommandDescription[lang],
    input: { hint: STR.choroCommandInputHint[lang] },
    handler: createChoroHandler({ choro, config, language })
  });
}
