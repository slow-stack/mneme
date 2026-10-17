/**
 * M.O.（Modus Operandi）的**归属规则**：把宿主的一次工具动作，映射成「它可能是工作流里的哪一步」。
 *
 * 这个模块存在的唯一理由，是执行链要记账时必须先回答一个问题：**这一次动作算哪一步？**
 * 没有这条规则，观察到的动作与工作流里的步骤编号是两套东西，记下来的账谁也读不懂；
 * 而「认真记了但没人能对账」比不记更糟——它会让面板显示一份看起来完整的假历史。
 *
 * ## 为什么只出候选，绝不下结论
 *
 * 本仓工作流里的 `tool` 字段是**人手写的自由文本**，实测形态：单命令（`npm test`）、
 * 多命令并列（`git log / gh pr list`）、带占位符（`git push <tag>`），19 步里还有 4 步
 * 是空的。拿这种文本去和宿主动作做精确匹配，命中率注定不高，而**误匹配的代价远大于漏匹配**：
 * 把「推 tag」记成「推分支」，`deriveState` 就会据此把错误的一步染成可信。
 *
 * 所以本模块的产出是**候选 + 理由**，由人（或上游的显式动作）确认；认不出来就是空数组，
 * **「认不出来」是合法答案，不许猜**。这与反事实判据那边同一条纪律：机器只写观察到的。
 *
 * ## 匹配分档
 *
 * - `exact`：归一化后整条命令相等（`npm test` ↔ `npm test`）
 * - `weak`：命令头相同、参数不同或缺失（`git push` ↔ `git push <tag>`）
 * - 其余不给候选
 *
 * 同一档内出现多条候选时，**全部返回**、不挑一个——挑一个就等于替人做了决定，而
 * 「两条工作流步骤长得一样」这件事该由人看着消歧。
 *
 * ## 调用方要自己分的三桶
 *
 * 本模块只给 `attributionCandidates` 一个入口；把一批观察归类是调用方的事，但要照这条口径分：
 *   matched   有候选（可能多条，由人消歧）
 *   unmatched 命令拼得出来，但没有任何步骤对得上
 *   skipped   命令行都拼不出来，归属无从谈起
 *
 * **「认不出来」与「没有这一步」必须长得不一样**，否则一份全是 unmatched 的报告会被读成
 * 「这次什么也没做」——与账本那边「缺账」和「坏账」要分开是同一条纪律。
 */

/** 命令里的占位符：`<tag>` / `<版本>`。它们不是字面量，不该参与比较。
 *  实测真实工作流只用尖括号这一种形态（`{}` 与 `[]` 各 0 次），不为假想的写法留分支。 */
const PLACEHOLDER_RE = /<[^>]*>/gu;

/**
 * 命令分隔符：一人写的 `tool` 里常见 `git log / gh pr list` 这种并列写法。
 * 用 `/` 分隔有歧义（路径里也有 `/`），所以只在**两侧有空白**时才当分隔符，
 * 否则 `/` 属于参数的一部分（`gh workflow run release-prep.yml` 不能被切碎）。
 * 实测真实工作流只出现这一种（`|` / `;` / `&&` 各 0 次），同样不留假想分支。
 */
const SEPARATOR_RE = /\s+\/\s+/u;

/** 归一化：小写、去占位符、折叠空白。占位符去掉而不是替换成通配，否则 `git push <tag>` 会宽到能匹配一切。 */
export function normalizeCommand(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(PLACEHOLDER_RE, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/** 一条 `tool` 文本可能包含多条并列命令：拆开，逐条参与匹配。 */
export function commandParts(tool) {
  if (typeof tool !== "string") return [];
  return tool
    .split(SEPARATOR_RE)
    .map((part) => normalizeCommand(part))
    .filter((part) => part !== "");
}

/** 切成词。命令行的词就是空格分隔的片段；这里不做完整的 shell 解析（引号、转义），
 *  因为 `tool` 字段是**人写的说明文本**而不是可执行脚本，解析得越精细越容易把说明当脚本。 */
function tokensOf(command) {
  return command.split(" ").filter((t) => t !== "");
}

/**
 * 一个是否是另一个的**词前缀**：`["gh","pr","create"]` 是 `["gh","pr","create","--base","main"]`
 * 的前缀。这是「弱匹配」的判据。
 *
 * 为什么不用「第一个词相同」：真实工作流里 `git` 出现 5 次、`gh pr` 出现 4 次，按首词匹配
 * 会让一次 `git push` 报出六条候选——**噪声盖过信号**，人看一眼就放弃了。
 * 词前缀表达的是「这次跑的就是那一步，只是多带了参数」，这才是真实形态：
 * 人写 `gh pr create`，agent 跑的是 `gh pr create --base main --title …`。
 */
function isTokenPrefix(shorter, longer) {
  if (shorter.length === 0 || shorter.length > longer.length) return false;
  for (let i = 0; i < shorter.length; i += 1) {
    if (shorter[i] !== longer[i]) return false;
  }
  return true;
}

/**
 * 观察记录的形状（上游负责拼）。
 *
 * `command` 是**尽力而为**的命令行：宿主给的是工具名 + 结构化参数，把参数拼成命令行这件事
 * 由调用方按工具类型做。拼不出来就给空串——空串不会匹配上任何东西，是安全的默认。
 */
export function normalizeObservation(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const command = normalizeCommand(raw.command);
  if (command === "") return null; // 认不出命令行 = 这条观察对归属无用，直接丢给上游
  return {
    tool: typeof raw.tool === "string" ? raw.tool : "",
    command,
    ok: raw.ok === true ? true : raw.ok === false ? false : null // 三态：真 / 假 / 不知道
  };
}

/**
 * 给一次观察找候选步骤。返回按档位排序的数组（exact 在前），可能为空。
 *
 * **不返回「最佳候选」**：那会诱使调用方直接采用它。调用方要决策，就得自己面对
 * 「可能为空」「可能多条」这两个事实。
 */
export function attributionCandidates(observation, pipeline) {
  const obs = normalizeObservation(observation);
  if (!obs || !pipeline || !Array.isArray(pipeline.steps)) return [];

  const obsTokens = tokensOf(obs.command);
  const out = [];
  for (const step of pipeline.steps) {
    const parts = commandParts(step.tool);
    // 空 tool 的步骤**结构性地无法被归属**。这不是缺陷，是事实：作者没写它怎么跑。
    // 把它报告出来（而不是跳过），好让「为什么这一步永远没账」有据可查。
    if (parts.length === 0) continue;

    for (const part of parts) {
      if (part === obs.command) {
        out.push({
          stepId: step.id,
          confidence: "exact",
          matched: part,
          why: `命令与步骤里写的完全一致（${part}）`
        });
        break;
      }
      const partTokens = tokensOf(part);
      if (isTokenPrefix(partTokens, obsTokens) || isTokenPrefix(obsTokens, partTokens)) {
        const longer = partTokens.length >= obsTokens.length ? part : obs.command;
        out.push({
          stepId: step.id,
          confidence: "weak",
          matched: part,
          why: `像同一步但参数不同：步骤写的是「${part}」，这次是「${obs.command}」（${longer} 多带了参数）`
        });
        break;
      }
    }
  }

  out.sort((a, b) => (a.confidence === b.confidence ? a.stepId.localeCompare(b.stepId) : a.confidence === "exact" ? -1 : 1));
  return out;
}

/**
 * 结构性不可归属的步骤：作者没写 `tool`，所以它**永远不会**拿到账。
 *
 * 单独给一个入口，是为了让「为什么这一步永远没账」有据可查——否则它看起来只是
 * 「还没跑过」，而真相是这条工作流根本没写明它怎么跑。
 */
export function unattributableSteps(pipeline) {
  return (pipeline && Array.isArray(pipeline.steps) ? pipeline.steps : [])
    .filter((s) => commandParts(s.tool).length === 0)
    .map((s) => s.id);
}
