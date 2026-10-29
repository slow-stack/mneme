/**
 * M.O.（Modus Operandi）工作流的**读侧**。
 *
 * 本体的落点是仓库（`<项目>/.mneme/pipelines/*.json`），不是记忆库：
 * 工作流是要跑的东西，必须能提交、能 PR、能 review、能被 CI 读、能整版回退；
 * 记忆库只存「为什么有这条」（证据）与「跑得怎么样」（结算）。
 * 三句话的分工：记忆是「为什么」，仓库是「怎么跑」，图是「看起来怎么样」。
 *
 * 这里只做三件事：读盘 → 校验（宁可读不出来，也不要读出一个半成品）→ 投影成
 * `mneme.pipeline/v1`（前端与 agent 共用的那一份结构化数据）。
 *
 * 为什么不用 YAML：本包运行时依赖只有 `morphicons` 一个，为一个配置文件引 YAML
 * 解析器不划算；手写子集解析器则是给未来埋一个「读起来对、跑起来错」的坑。
 * 人读的形态由面板渲染负责，不靠文件格式。
 *
 * **两层来源**（2026-10-15 定）：项目层在前、全局层在后，顺序即优先级。
 * 一条工作流默认属于某个项目，跟着项目走；装一次插件就在所有项目里看到同一套
 * 「全局工作流」，正是设计备忘要避免的局面——本机活跃记忆里 95.7% 的
 * `workspace_scope` 为空，「全局」于是变成谁都不看的杂物堆。全局层留着的唯一
 * 理由是接那些**跨项目复用**的工作流，而跨项目复用是一个要留痕的显式动作。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, posix as pathPosix, win32 as pathWin32 } from "node:path";
import { fileURLToPath } from "node:url";

// 两种路径语义各自指名一次，别让调用点再自己判断平台。
const basenamePosix = pathPosix.basename;
const basenameWin32 = pathWin32.basename;

/**
 * **全局层**的家：插件包自带的 `pipelines/`。算法是「本模块所在目录的上一级」——
 * src/ 与 lib/ 都在包根下，所以这个式子对源码树和发布包同时成立。
 *
 * 它只是**兜底层**，不是默认住处：默认住处是 `projectPipelineDir()`。发布包里今天
 * 没有 `pipelines/`（目录为空即不进包），所以全局层通常是空的——**这正是想要的**：
 * 一条工作流该不该跨项目用，得是一个人说出来的动作，而不是装插件时顺手塞进去的默认。
 */
export function defaultPipelineDir() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "pipelines");
}

/** **项目层**的家：`<项目>/.mneme/pipelines/*.json`。点开头不碍眼，但仍随仓库提交。 */
export const PROJECT_PIPELINE_SUBDIR = ".mneme";

export function projectPipelineDir(projectRoot) {
  return join(projectRoot, PROJECT_PIPELINE_SUBDIR, "pipelines");
}

/**
 * 项目根 → 面板上那个作用域标签。**只取目录名，不把整条绝对路径画出去**：
 * 绝对路径里有本机用户名，而面板是会被截图、被贴进 issue 的那一面。
 * 机器要用的完整路径另在 `sources[].dir`，那是数据，不是给人读的。
 */
export function projectLabel(projectRoot) {
  const root = String(projectRoot ?? "");
  // **语义显式指名，不借 path.basename()**：它跟着运行平台走——posix 上 `\` 不是
  // 分隔符，一条 Windows 路径会被整条当成标签，而面板正是会被截图、被贴进 issue
  // 的那一面，标签里于是带着本机用户名，恰好是本函数要挡住的东西。
  // 含反斜杠按 Windows 语义解析，否则按 posix——两个平台的正确结果就此一致。
  // Windows 腿对旧写法**结构性看不见**（win32.basename 两种分隔符都认，旧实现在
  // 本机算出来就是对的），所以这条的杀伤力只在 ubuntu 矩阵腿上。
  const base = root.includes("\\") ? basenameWin32(root) : basenamePosix(root);
  return base === "" ? root : base;
}

/**
 * 读取来源，**项目层在前、全局层在后**——顺序就是优先级：同 id 时项目层赢。
 *
 * 没有项目根（会话工作目录那一刻不可得）时只给全局层，并如实标 `project: null`；
 * **绝不回退到进程自己所在的目录**：那会把「读不到」变成「读到别的地方」，
 * 而后者在界面上看不出来，是最难查的一类错。
 */
export function pipelineSources({ projectRoot = null, pluginDir = defaultPipelineDir() } = {}) {
  const sources = [];
  const root = typeof projectRoot === "string" ? projectRoot.trim() : "";
  if (root !== "") sources.push({ scope: "project", label: projectLabel(root), dir: projectPipelineDir(root) });
  sources.push({ scope: "global", label: null, dir: pluginDir });
  return sources;
}

/** 风险四档（R0–R3）。跨档按最高档算；子 agent 只准接 R0 / R1。 */
export const RISK_LEVELS = ["R0", "R1", "R2", "R3"];

/** 这一步谁做。`human` 与 `ci` 是闸门与流水线自己的位置，不是 agent。 */
export const ACTORS = ["main", "subagent", "human", "ci"];

/** 工作流状态：草稿 / 生效 / 退役。退役不删文件——留着才知道它曾经存在过。 */
export const STATUSES = ["draft", "active", "retired"];

/** 节点状态四值；`refuted` 是全篇核心信号。 */
export const NODE_STATES = ["candidate", "trusted", "stale", "refuted"];

/** 单层最多读多少条。目录被人塞满时宁可报错，也不要把一次面板刷新变成磁盘扫描。 */
const MAX_PIPELINES = 200;

/**
 * 提议的阈值：跳过/绕开多少次就该提一句。
 * 3 这个数来自标本 E2/E3——「某步跳过 ≥3 次 → 提议删掉；某动作你手动补过 ≥2 次 → 提议升成正式步骤」。
 */
export const RETIRE_AFTER_SKIPS = 3;
export const RETIRE_AFTER_DETOURS = 3;

/**
 * 从运行记录里算出「该提议什么」。这是**图的自我精简**——不是人定期巡检，
 * 而是计数到了就冒出来：
 *   跳过 ≥3 次  → 提议删掉**这一步**（这一步对这条流程没用了）
 *   绕开 ≥3 次  → 提议这条**路径**过时了（从这里岔出去成了常态，图该重画）
 *
 * 两者的区别是这一版的核心：**跳过 = 这次不用；绕开 = 这条路整个不对。**
 * 只有绕开才动「路径」这一层。
 */
export function suggestRetirements(pipeline, { runs = [], now = Date.now(), observed = null } = {}) {
  const credit = tallyRuns(runs);
  const out = [];
  // 前置违规（R1）：跨整本账本查一次——某步被执行过，而它的某个 needs 前置
  // 在**同一条 run 里**既没执行也没被跳过。查账本级而不是 run 级，
  // 是因为 tallyRuns 已经把 run 边界抹掉了；这里要保住边界，所以单独扫 runs。
  const violationSeen = new Set();
  for (const run of runs || []) {
    const doneIds = new Set((run.steps || []).filter((s) => s && !s.skipped && !s.detoured).map((s) => s.id));
    // #461：一条 run 的判别键分两类，两类永不相撞。
    //
    // at 存在（合法账本的唯一形态——normalizeRun 在写侧强制必填）走 `at:<值>`。
    // at 缺失（读侧被独立喂进非法形状，或未来写契约放宽）走 `anon:<内容指纹>`：
    // by + triggeredBy + 按序的结构化 step 字段（字段取舍见下方 anonymousRunKey）。
    // 用**内容**而不是数组索引，是因为
    // violationSeen 跨整本账本共享，而索引只在「本次遍历的数组顺序」里唯一——
    // 同一条 run 在账本里出现两次时，索引会让它的同一条违规被记成两条，
    // 那正是本条要修的那类「键塌缩」的反面形态（#507 评审）。
    //
    // 评审里希望中间加一层 run.id，但 normalizeRun（src/pipeline-runs.js:187）
    // 只产出 { at, by, triggeredBy, steps }，没有 id 字段，而 suggestRetirements
    // 收到的已经是归一化后的 run；补 id 要改写侧契约，不属这条防御深度问题。
    // 内容指纹是同一意图下不需要动 schema 的等价物。
    //
    // 两类键必须带不同前缀：否则「第 0 条缺 at」与「另一条 at 字面量正好是
    // #0」会生成同一个键，后一条 violation-precedence 被静默吞掉。
    const runKey = isNonEmptyString(run.at)
      ? `at:${run.at}`
      : anonymousRunKey(run);
    for (const step of pipeline.steps) {
      if (!doneIds.has(step.id) || !Array.isArray(step.needs)) continue;
      for (const need of step.needs) {
        if (doneIds.has(need)) continue;
        const had = (run.steps || []).some((s) => s && s.id === need);
        if (had) continue; // 前置做过（哪怕是 skipped）就不算违规
        const vk = `${runKey}|${step.id}|${need}`;
        if (violationSeen.has(vk)) continue;
        violationSeen.add(vk);
        // 同一步对不同前置各报一条：修图的人需要知道**断在哪条边**上
        out.push({
          kind: "violation-precedence",
          stepId: step.id,
          title: step.title,
          because: `执行过 ${step.id} 的那次（${run.at ?? "无时间"}）里，前置 ${need} 既没做也没标跳过`,
          effect: `提议重看 ${need} → ${step.id} 这条依赖——要么顺序写错了，要么前置根本不必要`
        });
      }
    }
  }
  for (const step of pipeline.steps) {
    const c = credit.get(step.id);
    if (!c) continue;
    // R2：跳过的性质由步骤自己的 optional 声明决定，不再靠次数猜意图。
    //   可选步骤跳过 = 设计如此，**永远不提议删**；
    //   必经步骤被跳 = 违规信号，rework-path 与 drop-step **并存**——
    //   同一事实「必经的一步总被跳」既可能是「这步多余」（删）也可能是「流程写错」
    //   （修图），判要靠人。这里绝不能用 if/else 吞并：07 号文那条教训在本仓重演过。
    if (step.optional !== true && (c.skipped || 0) >= RETIRE_AFTER_SKIPS && (c.uses || 0) === 0) {
      // 必经、从未真正执行、且总被跳：最像「写进清单但实际从不执行」（08 号文实测
      // gh pr merge --rebase 出现 0 次）。删步与修图两种读法都成立，同时给人。
      out.push({
        kind: "drop-step",
        stepId: step.id,
        title: step.title,
        because: `从未被执行过、且被跳过 ${c.skipped} 次`,
        effect: "提议删掉这一步——写进清单但实际从不执行的步骤，最可能是清单过时"
      });
    }
    if (step.optional === true) {
      if ((c.skipped || 0) >= RETIRE_AFTER_SKIPS) {
        out.push({
          kind: "optional-skip-ok",
          stepId: step.id,
          title: step.title,
          because: `可选步骤，被跳过 ${c.skipped} 次`,
          effect: "不提议改动——这是 optional 声明的正常行为（信息项，供人留意）"
        });
      }
    } else {
      if ((c.skipped || 0) >= RETIRE_AFTER_SKIPS) {
        out.push({
          kind: "rework-path",
          // cause 区分同 kind 的两种成因：nudge 侧按它选封闭问法——「必经的一步总
          // 被跳」问的是删步/改 optional，「被绕开成常态」问的是重画路径，共用一句
          // 问法会答非所问（CodeRabbit #458 F3）。
          cause: "skipped",
          stepId: step.id,
          title: step.title,
          because: `必经步骤被跳过 ${c.skipped} 次`,
          effect: "提议重看这条路径——必经的一步总被跳，要么它是多余的（该删/改 optional），要么流程写错了"
        });
      }
    }
    if ((c.detoured || 0) >= RETIRE_AFTER_DETOURS) {
      out.push({
        kind: "rework-path",
        cause: "detoured",
        stepId: step.id,
        title: step.title,
        because: `被绕开 ${c.detoured} 次`,
        effect: "提议重看这条路径——从这一步岔出去已经成了常态，图该重画"
      });
    }
  }
  // P3 投影（fix-step-tool）：人确认做过、但声明的 tool 在攒下的观察里从没出现。
  // 观察是旁挂文件里的聚合（{key,count}，无命令原文），不泄露路径。
  // **不做累计**：一次矛盾就报——人可以判「声明过时/本来不必敲/我记错了」。
  // 纯人判步骤（无 tool 声明）与 optional 步骤不进判据：前者无从矛盾，
  // 后者「这次没做」是正常，谈不上「做了但没看到」。
  if (observed && typeof observed === "object" && observed.latest?.activities?.length) {
    const seen = new Set(observed.latest.activities.map((a) => String(a?.key ?? "").toLowerCase()).filter(Boolean));
    for (const step of pipeline.steps) {
      if (step.optional === true) continue;
      const declared = typeof step.tool === "string" ? step.tool.trim() : "";
      if (declared === "") continue;
      const anchors = declared.split("/").map((t) => t.trim().toLowerCase()).filter(Boolean);
      if (anchors.some((a) => seen.has(a))) continue;
      const c = credit.get(step.id);
      if (!c || (c.uses || 0) === 0) continue; // 没被确认做过 → 无矛盾可言
      out.push({
        kind: "fix-step-tool",
        stepId: step.id,
        title: step.title,
        because: `确认做过 ${c.uses} 次，但声明的 ${declared} 在最近的观察里一次都没出现`,
        effect: "提议核对这个声明——是 tool 写过时了，还是这一步本来就不必敲那条命令",
        observedTop: observed.latest.activities.slice(0, 3).map((a) => `${a.key} ×${a.count}`)
      });
    }
  }
  return out;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const STEP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 校验失败的统一出口：一次把话说完，别让人一轮修一条。 */
class PipelineError extends Error {
  constructor(file, problems) {
    super(`${file}: ${problems.join("; ")}`);
    this.name = "PipelineError";
    this.problems = problems;
  }
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * at 缺失时一条 run 的判别键（#461 / CodeRabbit #507）：给无时间戳的 run 一个
 * **按内容**的稳定身份，好让 violationSeen 只并掉「同一条 run 重复出现」的同类
 * 违规，而不把内容不同的两条 run 并成一条。
 *
 * 覆盖 normalizeSteps（src/pipeline-runs.js:242）产出的**全部结构化字段**——
 * id / at / skipped / detoured / refuted。之所以必须收 step.at：漏了它，两条只在
 * 某一步时间上不同的 at-less run 会共键，后一条的 violation-precedence 被去重吞掉
 * （#507 指出的正是这条）。
 *
 * 用 JSON.stringify 而不是手写 `${id}@${at}` 拼接：run 侧 step id 只过
 * isSafeSegment（src/pipeline-runs.js:83），`@` `,` `:` 都是合法 id，手写拼接会与
 * 「id 里恰好含这些字符」的另一条 step 撞串——那会新造一类键塌缩（把另一类 at-less
 * 输入从「不漏报」改成「漏报」）。JSON 自带无歧义分隔，顺带把 by/triggeredBy 里的
 * `|`、以及 Date 与 ISO 串（Date.toJSON 归一成 ISO）的歧义一并收掉。
 *
 * note 不进来：它是自由文本，序列化进去会让「只差备注的同一条观测」被当成两次。
 *
 * 如实记下代价：skipped/detoured/refuted 对去重正确性是**惰性**的——violation 判定
 * 只读 doneIds（由 id + skipped/detoured 决定）与 id 是否存在，refuted 根本不被读
 * （见下方 suggestRetirements）。所以收这三个布尔防不住任何错误合并，却会让两条只差
 * 这些旗标的 at-less run 各报一条**逐字相同**的提议。仍选择全收，是为了让规则统一
 * （指纹 = 归一化 step 的每个结构化字段，唯一例外是自由文本 note），且将来 violation
 * 逻辑若开始读某个旗标时不会突然开始漏合并；anon 路径本身没有身份锚点，接受这一条
 * 重复的代价。注意这条路径在生产不可达：readStoredRun（src/pipeline-runs.js:262）
 * 强制 run.at 存在，正常账本永远走 `at:` 分支，此处纯属直接调用边界的防御深度。
 */
function anonymousRunKey(run) {
  return `anon:${JSON.stringify({
    by: run.by ?? null,
    triggeredBy: run.triggeredBy ?? null,
    steps: (run.steps || []).map((s) => ({
      id: s?.id ?? null,
      at: s?.at ?? null,
      skipped: !!s?.skipped,
      detoured: !!s?.detoured,
      refuted: !!s?.refuted
    }))
  })}`;
}

/**
 * 校验一条工作流。返回归一化后的对象；有任何问题就抛，不返回「部分可用」的东西
 * ——半个工作流比没有工作流更危险，因为它会被当成完整的跑。
 */
export function validatePipeline(raw, file = "<pipeline>") {
  const problems = [];
  const bad = (msg) => problems.push(msg);

  if (!isPlainObject(raw)) {
    throw new PipelineError(file, ["顶层必须是一个对象"]);
  }

  if (!isNonEmptyString(raw.id) || !ID_RE.test(raw.id)) {
    bad("id 必须是小写 kebab（如 dsh-mneme-maintenance）");
  }
  if (!isNonEmptyString(raw.name)) bad("name 必须是字符串");
  if (!isNonEmptyString(raw.project)) bad("project 必须是字符串（如 slow-stack/mneme）");
  if (!Number.isInteger(raw.version) || raw.version < 0) bad("version 必须是从 0 起的整数");
  if (!STATUSES.includes(raw.status)) bad(`status 必须是 ${STATUSES.join(" / ")}`);
  if (!isNonEmptyString(raw.done)) bad("done 必须写清「整条怎么算完成」");

  if (!Array.isArray(raw.trigger) || raw.trigger.length === 0) {
    bad("trigger 至少要有一条");
  } else {
    raw.trigger.forEach((t, i) => {
      if (!isPlainObject(t) || !isNonEmptyString(t.value)) {
        bad(`trigger[${i}] 必须写成 { kind, value }`);
      }
    });
  }

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    bad("steps 至少要有一级");
    throw new PipelineError(file, problems);
  }

  const ids = new Set();
  for (const [i, step] of raw.steps.entries()) {
    const at = isPlainObject(step) && isNonEmptyString(step.id) ? step.id : `steps[${i}]`;
    if (!isPlainObject(step)) {
      bad(`${at} 必须是对象`);
      continue;
    }
    if (!isNonEmptyString(step.id) || !STEP_ID_RE.test(step.id)) {
      bad(`${at}.id 非法（如 A1 / C2）`);
    } else if (ids.has(step.id)) {
      bad(`${at}.id 重复`);
    } else {
      ids.add(step.id);
    }
    for (const key of ["phase", "title", "when", "do", "done", "why"]) {
      if (!isNonEmptyString(step[key])) bad(`${at}.${key} 必须是非空字符串`);
    }
    if (!RISK_LEVELS.includes(step.risk)) bad(`${at}.risk 必须是 ${RISK_LEVELS.join(" / ")}`);
    if (!ACTORS.includes(step.who)) bad(`${at}.who 必须是 ${ACTORS.join(" / ")}`);
    if (!Array.isArray(step.needs)) bad(`${at}.needs 必须是数组（可空，表示这是一段的入口）`);
    if (step.gate !== undefined && typeof step.gate !== "boolean") bad(`${at}.gate 只能是布尔`);
    // 可选/必经声明（R2）：缺省 = 必经。有了它，「被跳过」才第一次有性质——
    // 可选步骤跳过是正常，必经步骤被跳是违规。见 07 号文的语义对照与 15 号文拍板。
    if (step.optional !== undefined && typeof step.optional !== "boolean") bad(`${at}.optional 只能是布尔`);
    if (step.evidence !== undefined && !Array.isArray(step.evidence)) {
      bad(`${at}.evidence 必须是字符串数组`);
    }
    // 断言（可断言节点）：一条一条写「这一步怎么算做完」，且要求**机器能判**。
    // 没有它就等于判断节点——完成与否只能由人认。这不是缺失，是两类节点之一。
    if (step.assert !== undefined) {
      if (!Array.isArray(step.assert)) {
        bad(`${at}.assert 必须是字符串数组`);
      } else {
        step.assert.forEach((entry, i) => {
          if (!isNonEmptyString(entry)) bad(`${at}.assert[${i}] 必须是非空字符串`);
        });
      }
    }
  }

  // 先把 id 收集齐再校验引用，否则会按声明顺序报一堆假错。
  for (const step of raw.steps) {
    if (!Array.isArray(step.needs)) continue;
    for (const need of step.needs) {
      if (!ids.has(need)) bad(`${step.id}.needs 指向了不存在的步骤 ${need}`);
    }
  }

  const cycles = findCycles(raw.steps, ids);
  if (cycles.length) bad(`图里有环：${cycles.join(" / ")}（回写是新版本，不是回到自己）`);

  if (problems.length) throw new PipelineError(file, problems);

  return {
    id: raw.id,
    name: raw.name,
    project: raw.project,
    version: raw.version,
    status: raw.status,
    done: raw.done,
    trigger: raw.trigger.map((t) => ({ kind: t.kind || "phrase", value: t.value, note: t.note || "" })),
    inputs: Array.isArray(raw.inputs) ? raw.inputs.slice() : [],
    steps: raw.steps.map((s) => ({
      id: s.id,
      phase: s.phase,
      title: s.title,
      when: s.when,
      do: s.do,
      who: s.who,
      tool: isNonEmptyString(s.tool) ? s.tool : "",
      done: s.done,
      risk: s.risk,
      needs: s.needs.slice(),
      why: s.why,
      evidence: Array.isArray(s.evidence) ? s.evidence.slice() : [],
      // 缺省是空数组而不是 undefined：两类节点的区别用「有没有断言」表达，
      // 用缺键会让下游每处都得先判在不在。
      assert: Array.isArray(s.assert) ? s.assert.slice() : [],
      gate: s.gate === true,
      // 缺省 false（= 必经）：显式落键而非缺省缺键——「这步可不可跳」是判据要读的
      // 语义，不是可有可无的装饰。读侧拿到的一律是布尔，不用到处判 undefined。
      optional: s.optional === true
    }))
  };
}

/** 三色 DFS 找环，把环上的步骤 id 拼出来（报错要能直接指到人看的那一行）。 */
function findCycles(steps, ids) {
  const needsOf = new Map();
  for (const step of steps) {
    if (isNonEmptyString(step.id) && Array.isArray(step.needs)) {
      needsOf.set(step.id, step.needs.filter((n) => ids.has(n)));
    }
  }
  const state = new Map(); // 0 未访问 / 1 在栈上 / 2 已定
  const cycles = [];
  const walk = (id, trail) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      cycles.push([...trail.slice(trail.indexOf(id)), id].join(" → "));
      return;
    }
    state.set(id, 1);
    for (const next of needsOf.get(id) || []) walk(next, [...trail, id]);
    state.set(id, 2);
  };
  for (const id of needsOf.keys()) walk(id, []);
  return cycles;
}

/**
 * 读一个目录下的全部工作流；坏文件直接抛，不做「跳过继续」——静默少一条最难查。
 * 每条挂上 `origin`（哪一层来的、家在哪个目录、哪个文件），供上层判优先级与显示。
 */
export function loadPipelines(dir, { scope = "global", label = null } = {}) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  if (files.length > MAX_PIPELINES) {
    throw new PipelineError(dir, [`目录里有 ${files.length} 个 .json，超过上限 ${MAX_PIPELINES}——这里应该是工作流目录，不是数据堆`]);
  }
  const out = [];
  const seen = new Map();
  for (const file of files) {
    const full = join(dir, file);
    let raw;
    try {
      raw = JSON.parse(readFileSync(full, "utf8"));
    } catch (error) {
      throw new PipelineError(file, [`JSON 解析失败：${error.message}`]);
    }
    const pipeline = validatePipeline(raw, file);
    if (seen.has(pipeline.id)) {
      throw new PipelineError(file, [`id "${pipeline.id}" 与 ${seen.get(pipeline.id)} 重复`]);
    }
    seen.set(pipeline.id, file);
    out.push({ ...pipeline, origin: { scope, label, dir, file } });
  }
  return out;
}

/**
 * 从一条运行记录里数出「这次走过哪几步」——结算用。
 *
 * 每一步有三种处置，**计数必须分开**，因为它们驱动的判断完全不同：
 *   uses     照图走了（或走了但被推翻）
 *   skipped  这一步这次不用（图上还在）→ 跳过 ≥3 次就提议删掉这一步
 *   detoured 从这里岔出去走了图上没有的路 → 被绕开 ≥3 次说明这条路径过时了
 *
 * 「跳过」与「绕开」不是一回事：**跳过 = 这次不用这一步；绕开 = 这条路整个不对**。
 * 混在一起数，两种提议就都发不出来了。
 */
function tallyRuns(runs) {
  const perStep = new Map();
  for (const run of runs || []) {
    for (const step of run.steps || []) {
      const cur = perStep.get(step.id) || { uses: 0, refuted: 0, lastUsedAt: null };
      perStep.set(step.id, cur);
      // 三种处置**各自独立累加**，谁也不吃谁：
      // 一次绕行很可能同时是「这一步这次没用」+「从这里岔出去了」——
      // 这两件事驱动的提议不同（删这一步 / 重画这条路径），吞掉一个就少一条提议。
      // 第一版写成 if/else if，于是绕行把跳过吃掉了。
      const detoured = step.detoured === true || step.kind === "detour";
      const skipped = step.skipped === true;
      if (detoured) cur.detoured = (cur.detoured || 0) + 1;
      if (skipped) cur.skipped = (cur.skipped || 0) + 1;
      // 只有「既没跳过也没绕行」才算真走了这一步——两种偏离都不是使用。
      if (!detoured && !skipped) cur.uses += 1;
      if (step.refuted) cur.refuted += 1;
      if (step.at && (!cur.lastUsedAt || step.at > cur.lastUsedAt)) cur.lastUsedAt = step.at;
    }
  }
  return perStep;
}

/**
 * 节点状态由**对照数据**推出来，不由作者写死：
 * 被推翻过 → refuted；用过没用砸 → trusted；有记录但久未使用 → stale；没有记录 → candidate。
 * 没有运行记录时全体是 candidate —— 这是实话，也正是面板上那句 beta 免责必须摆在脸上的原因。
 *
 * 绕行不改变状态、只累加计数：**被绕开不等于这一步坏了**（可能只是这次不需要），
 * 它推动的是「这条路径该重看了」这种**提议**，不是把节点染红。
 * 染色要留给真正被推翻过的（refuted）——那是唯一有硬判据的信号。
 */
function deriveState(credit, now, staleAfterDays = 90) {
  if (!credit || credit.uses === 0) return credit && credit.skipped ? "stale" : "candidate";
  if (credit.refuted > 0) return "refuted";
  if (credit.lastUsedAt) {
    const age = (now - Date.parse(credit.lastUsedAt)) / 86400000;
    if (Number.isFinite(age) && age > staleAfterDays) return "stale";
  }
  return "trusted";
}

/**
 * 清单页要的那点信息：够渲染「名字 + 一句话 + 状态 + 作用域」，不必把整张图读出来。
 * 面板第一屏是清单、点进去才是图，所以这一份是**首屏的全部输入**。
 */
function summarizePipeline(pipeline, runs, now) {
  const credit = tallyRuns(runs);
  const states = { candidate: 0, trusted: 0, stale: 0, refuted: 0 };
  let gates = 0;
  let contrast = 0;
  let assertable = 0;
  for (const step of pipeline.steps) {
    states[deriveState(credit.get(step.id) || null, now)] += 1;
    if (step.gate) gates += 1;
    if (step.evidence.length) contrast += 1;
    // 可断言节点数：与 contrast 并列的首屏指标。两者含义不同——contrast 数的是
    // 「写了没有」（内容靠人判），assertable 数的是「机器能不能判」。
    if (step.assert.length) assertable += 1;
  }
  return {
    id: pipeline.id,
    title: pipeline.name,
    scope: pipeline.origin.scope,
    scopeLabel: pipeline.origin.label,
    project: pipeline.project,
    status: pipeline.status,
    version: pipeline.version,
    done: pipeline.done,
    trigger: pipeline.trigger,
    file: pipeline.origin.file,
    steps: pipeline.steps.length,
    gates,
    // 反事实对照覆盖率：19/19 与 6/19 是两条完全不同的工作流，清单上就该看得出来。
    contrast,
    // 可断言节点数：机器能自动验完的有几步。「0/19」说明这条流程全靠人判——
    // 那是实话，不是缺陷，但清单上必须看得见。
    assertable,
    states
  };
}

/**
 * 投影成 `mneme.pipeline/v1`：前端渲染与 agent 读取用的是同一份数据，
 * 画面只是它的投影——只画不存，agent 就什么也读不到。
 */
export function toPipelineV1(pipeline, { runs = [], now = Date.now(), memoryLinks = {} } = {}) {
  const credit = tallyRuns(runs);
  // 没经过 loadPipelines 的对象（手工 validate 出来的、别处传来的）没有来源。
  // 这时 scope 落 null 而不是 "project"：默认成项目级会让一条其实来路不明的工作流
  // 看起来「就是本项目的」，而面板上没人能分辨。
  const origin = pipeline.origin || { scope: null, label: null, dir: "", file: "" };

  const nodes = pipeline.steps.map((step) => {
    const c = credit.get(step.id) || null;
    const link = memoryLinks[step.id] || null;
    return {
      id: step.id,
      // gate / branch 是画法，不是第二套数据：闸门要能一眼看出来「这里会停下」。
      kind: step.gate ? "gate" : step.needs.length > 1 ? "branch" : "step",
      title: step.title,
      phase: step.phase,
      situation: step.when,
      action: step.do,
      why: step.why,
      who: step.who,
      tool: step.tool,
      done: step.done,
      risk: step.risk,
      state: deriveState(c, now),
      credit: c ? { uses: c.uses, refuted: c.refuted, skipped: c.skipped || 0, detoured: c.detoured || 0, lastUsedAt: c.lastUsedAt } : null,
      // 可断言节点 vs 判断节点：这是两类节点的**唯一**区分点，也是一张图里
      // 「哪些步骤能被机器盯着」的全部依据。**必须投影成 null 而不是空数组**：
      // 空数组会让「作者没写断言」与「写了但一条都没通过」长得一样，而这两件事
      // 在验收时完全不同（前者是判断节点，后者是失败）。
      assert: step.assert.length ? { checks: step.assert.slice(), count: step.assert.length } : null,
      // 反事实对照是**准入判据**的载体（「没有它这次会不会失败」），不是备注：
      // 答不出来的步骤在图上要显得比答得出来的虚。
      counterfactual: step.evidence.length
        ? { contrast: step.evidence.join(" ／ "), evidence: step.evidence.length }
        : null,
      // 记忆 id 是本机私有数据，不进仓库文件；有本地对照表才填。
      source: link ? { memoryIds: link.memoryIds || [], originSession: link.originSession || null } : null
    };
  });

  const edges = [];
  for (const step of pipeline.steps) {
    for (const need of step.needs) {
      edges.push({ id: `${need}->${step.id}`, from: need, to: step.id, kind: "control", label: "" });
    }
  }

  return {
    contract: "mneme.pipeline/v1",
    pipeline: {
      id: pipeline.id,
      title: pipeline.name,
      // scope 是**从哪儿读出来的**，不是作者写的：同一条文件放进项目层就变项目级。
      scope: origin.scope,
      scopeLabel: origin.label,
      project: pipeline.project,
      file: origin.file,
      status: pipeline.status,
      version: pipeline.version,
      done: pipeline.done,
      trigger: pipeline.trigger,
      inputs: pipeline.inputs,
      updatedAt: null
    },
    nodes,
    edges,
    runs
  };
}

/**
 * 面板与 agent 的公共入口：按来源顺序读全两层，投影出第一条（或指定 id 的那条），
 * 并**总是**给出清单（`available`）——首屏是清单，图是点进去才要的东西。
 *
 * `projectRoot` 是会话工作目录。给不出来时只读全局层，并在 `sources` 里如实标
 * `project: null`、`available` 为空：界面据此说「这个会话的工作目录拿不到」，
 * 而不是悄悄显示一份不属于任何项目的清单。
 */
export function readPipelineDoc({
  projectRoot = null,
  pluginDir = defaultPipelineDir(),
  id = null,
  runsById = {},
  now = Date.now(),
  memoryLinks = {},
  // P3 投影的燃料：观察旁挂（调用方用 loadObservations 读好后传进来）。
  // 形状：{ [pipelineId]: { latest: { activities: [{key,count,flags?}] } } }。
  // 设计成调用方预读而不是传 memoryDir——pipeline.js 保持零文件系统职责（只读
  // 自己的 pipelines 目录），旁挂的路径规则归 observations 模块管。
  observationsById = {}
} = {}) {
  const sources = pipelineSources({ projectRoot, pluginDir });
  const ordered = [];
  const byId = new Map();
  const shadowed = [];
  const unreadable = [];

  for (const source of sources) {
    let list;
    try {
      list = loadPipelines(source.dir, { scope: source.scope, label: source.label });
    } catch (error) {
      // 项目层里有个坏文件，不该把全局层一起拖死：如实记下来继续读下一层。
      // 全局层是自家发出去的包，坏了就是坏了——照抛。
      if (source.scope === "global") throw error;
      unreadable.push({ scope: source.scope, dir: source.dir, detail: error.message });
      continue;
    }
    for (const pipeline of list) {
      const already = byId.get(pipeline.id);
      if (already) {
        // 项目层赢是**安排好的**，不是巧合：记下来，免得以后有人以为丢了文件。
        shadowed.push({ id: pipeline.id, hidden: source.scope, by: already.origin.scope });
        continue;
      }
      byId.set(pipeline.id, pipeline);
      ordered.push(pipeline);
    }
  }

  const available = ordered.map((p) => summarizePipeline(p, runsById[p.id] || [], now));
  const chosen = (id ? byId.get(id) : ordered[0]) || null;

  const base = {
    contract: "mneme.pipeline/v1",
    sources: sources.map((s) => ({ scope: s.scope, label: s.label, dir: s.dir, present: existsSync(s.dir) })),
    available,
    shadowed,
    unreadable
  };

  if (!chosen) return { ...base, pipeline: null, nodes: [], edges: [], runs: [], suggestions: [] };
  return {
    ...toPipelineV1(chosen, { runs: runsById[chosen.id] || [], now, memoryLinks }),
    ...base,
    // 图的自我精简：计数到了就把提议冒出来，不用人等巡检。
    suggestions: suggestRetirements(chosen, { runs: runsById[chosen.id] || [], now, observed: observationsById[chosen.id] ?? null })
  };
}
