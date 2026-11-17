/**
 * 日记的合成管线：采集 → 生成 → 落盘 → 记账。
 *
 * ## 一条管线，三个入口
 *
 * 「跨天自动」「面板手动写一篇」「插件启动补写」必须汇到同一个 `compose`，只在入口处
 * 分叉。为什么：失败路径（无素材 / 模型挂 / 目录不可写 / 同日已写）各写一遍就是各验一遍，
 * 三份实现迟早长成三种行为——而那三种行为在用户眼里都是「今天没有日记」。
 *
 * ## 为什么正文落文件、摘要落记忆行
 *
 * 正文是人要读、要改、要能进 git 的东西，所以是 `YYYY-MM-DD.md`；记忆库里只留一条
 * `type="document"` 的**指针行**（摘要 + doc_path），复用既有的 `registerDocument`——
 * 那里已经把路径校验、去重（0.92 相似度）、supersede 记账做完了，一行不用重写。
 *
 * 反过来（正文进 SQLite）会把散文塞进注入预算，也会破掉 `src/document.js` 那条
 * 「全文归 agent，管线零读零写零改」的契约。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, openSync, fstatSync, readSync, closeSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describeStreamFailure, resolveRoute, runAuditedLlm, streamText } from "../dream.js";
import { writeFileAtomic } from "../pipeline-nudge.js";
import { renderUserSettingsBlock } from "../user-settings.js";
import { breakFenceMarkers } from "../fence.js";
import { STR, langOf } from "../lang.js";
import { collectQqInbox, resolveInboxDir } from "./qq-inbox.js";
import { collectSessionTranscript } from "./session-provider.js";
import { collectMemoryMaterial } from "./memory-provider.js";
import { readAgentSessions, agentSessionIds, UNNAMED_AGENT } from "./agent-bucket.js";
import { DIARY_FILE_RE, diaryAuditPath, diaryAgentDir, diaryDir, diaryFilePath, diaryRoot, agentsRoot, isBucketName } from "./dir.js";
import { localDateString, shouldRollDay } from "./rollover.js";

/** 正文太短当失败：模型偶尔只回一句「今天聊了聊天」，那不是日记，落盘就是噪音。 */
export const MIN_BODY_CHARS = 80;
/** 模型最多看多少条消息：一天几百条会把这轮 prompt 顶爆，而日记要的是轮廓不是逐条抄。 */
export const MAX_MATERIAL_ITEMS = 120;

/**
 * 账本追加：先看尾 1 字节要不要补换行。
 *
 * 与 `src/pipeline-runs.js:364-382` 同一条纪律，但那份是私有函数。少了补换行，
 * 追加会把上一条与本条粘成一行，一行坏 JSON 让整个账本读不出来——而账本恰好是
 * 「刚跑完一次」时才动的文件。
 */
function appendAudit(file, record) {
  mkdirSync(dirname(file), { recursive: true });
  let prefix = "";
  let fd = null;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    if (size > 0) {
      const tail = Buffer.allocUnsafe(1);
      readSync(fd, tail, 0, 1, size - 1);
      if (tail[0] !== 0x0a) prefix = "\n";
    }
  } catch {
    // 文件还不存在 = 空账本，不需要补。
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 关不掉也不影响写。
      }
    }
  }
  appendFileSync(file, prefix + JSON.stringify(record) + "\n", "utf8");
}

/** 目录里最新一篇的日期。用来在状态文件缺失时自愈（状态丢了不至于重写去年那篇）。 */
export function latestDiaryDate(dir) {
  if (!dir) return null;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const dates = names.filter((n) => DIARY_FILE_RE.test(n)).map((n) => n.slice(0, 10)).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

/**
 * 渲染素材块：一行一条，带时间和说话人。
 *
 * 角色标签不是装饰：素材同时来自「她说的话」和「我自己说的话」之后，没有标签模型
 * 就会把两边混成一个人的独白——而日记的第一人称只属于助手自己。
 * 没有时间戳（跨日手动写、事件不带时间）时省略时间，不编一个。
 */
function renderMaterial(items) {
  return items
    .map((it) => {
      // #613：素材不止两种角色——记忆条目带 type（preference/decision/…），直接
      // 作为标签展示；assistant/user 保持原语义（session-provider 那侧不受影响）。
      const tag = String(it.role || "user");
      if (!Number.isFinite(it.ts)) return `[${tag}] ${it.text}`;
      const d = new Date(it.ts);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${hh}:${mm} [${tag}] ${it.text}`;
    })
    .join("\n");
}

/** 正文校验。任一不过即视为失败——半截文本落盘之后会被 registerDocument 当成合格文件。 */
export function validateBody(body) {
  const text = String(body ?? "").trim();
  if (text.length < MIN_BODY_CHARS) return "too-short";
  if (/^\s*```/.test(text) && !/```\s*$/.test(text)) return "unclosed-fence";
  if (/<<<|>>>/.test(text)) return "marker-leak";
  return null;
}

export function createDiaryComposer({ ctx, config, logger, service = null, settings = null, memoryDir, sessionGate = null, now = () => new Date() }) {
  const lang = langOf(config);
  // PROMPTS 不单独 export——它挂在 STR.prompts 上（src/lang.js:536）。走同一条出口，
  // 免得 lang.js 多一个「既有具名导出又有默认导出」的双份形状。
  const prompts = STR.prompts.diary[lang] ?? STR.prompts.diary.zh;
  const str = (key, ...args) => {
    const row = STR[key];
    if (!row) return "";
    const fn = row[lang] ?? row.zh;
    return typeof fn === "function" ? fn(...args) : fn;
  };
  // 整条管线串行：跨天触发与手动按钮可能在同一秒撞上，两次都读到「今天没写过」
  // 就会各写一篇（后一篇覆盖前一篇，或者拼成两段半截）。串行链的写法照抄
  // src/summarize.js 的 enqueueDistill。
  let chain = Promise.resolve();
  const enqueue = (task) => {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  async function readState(root) {
    const file = join(root, "state.json");
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    } catch {
      return {};
    }
  }

  function writeState(root, state) {
    try {
      writeFileAtomic(join(root, "state.json"), JSON.stringify(state, null, 2) + "\n");
    } catch (error) {
      // 状态写不进去只影响「下次判定要不要补」，不该让这一篇已经写好的日记报失败。
      logger?.warn?.(`[dsh-mneme] diary state write failed: ${String(error)}`);
    }
  }

  /**
   * @param {object} input
   * @param {"rollover"|"manual"|"startup"} input.trigger
   * @param {string} input.projectRoot 这条会话属于哪个项目（`header.cwd`）
   * @param {string|null} [input.chatId] QQ 会话 id，只进状态文件，不进文件名
   * @param {object|null} [input.session] 当前会话对象：素材主来源
   * @param {string|null} [input.agentId] 会话身份（`header.agentPreset`）：决定用哪张人格卡
   */
  async function compose({ trigger = "rollover", projectRoot, chatId = null, session = null, agentId = null, agentMode = false } = {}) {
    const at = now();
    const today = localDateString(at);
    // #613 §3：两种桶**并存不迁移**——项目桶（v0.13 存量，一行不动）与 Agent 桶
    // （v2 起新写入）。agentMode 时 projectRoot 被忽略：素材来自全局记忆，落点只
    // 由 agentId 决定；agentId 不合法就落到 _unnamed（验收红线：不存在的 Agent
    // 不许有同名目录，不认识的会话不许冒出目录）。
    const root = agentMode
      ? diaryAgentDir({ memoryDir, agentId, configured: config?.diaryDir })
      : diaryDir({ memoryDir, projectRoot, configured: config?.diaryDir });
    const auditFile = root ? diaryAuditPath(root) : null;
    const audit = (record) => {
      if (!auditFile) return;
      try {
        appendAudit(auditFile, { v: 1, ts: at.getTime(), date: today, trigger, ...record });
      } catch {
        // 账本写不进去不该改判主流程结果。
      }
    };
    const skip = (reason, extra = {}) => {
      audit({ status: "skipped", reason, ...extra });
      return { ok: true, status: "skipped", reason, date: today };
    };

    if (!root) {
      // 项目根为空 = 这条会话不属于任何项目（agentMode 则是 agentId 形状不合法）。
      // 绝不能退回宿主 cwd 写日记，那会把私密正文摊到启动目录里（与 /pipeline
      // 拒 project-not-absolute 同语义）。
      const reason = agentMode ? "agent-invalid" : "project-unknown";
      audit({ status: "skipped", reason });
      return { ok: true, status: "skipped", reason, date: today };
    }
    // stateRoot 在 root 判空之后算：root 为 null 时 join(null, "..") 会 TypeError，
    // 而那个 null 正是上面刚处理完的「项目未知/身份不合法」分支。
    const stateRoot = agentMode
      ? agentsRoot({ memoryDir, configured: config?.diaryDir })
      : join(root, "..");
    const state = await readState(stateRoot);
    const key = agentMode ? String(agentId).trim() : root.split(/[\\/]/).filter(Boolean).pop() || "";
    const entry = state[key] || {};
    const lastDate = entry.lastDate || latestDiaryDate(root);
    const roll = shouldRollDay(lastDate, today);
    const manual = trigger === "manual";
    const file = diaryFilePath(root, today);
    const existed = existsSync(file);

    if (!manual && !roll.roll) return skip("already-written", { lastDate });
    if (!manual && existed && !roll.gap) {
      // 文件已存在但状态文件说没写过（状态丢过一次）：以文件为准，不重写。
      state[key] = { ...entry, projectRoot, lastDate: today, chatId: chatId ?? entry.chatId ?? null };
      writeState(stateRoot, state);
      return skip("already-written", { lastDate: today });
    }

    // 素材主来源是**这条会话自己的转录**——「拥有人格的 agent 写日记」，写的就是
    // 它自己这一天经历过的事。QQ 收件箱只是兜底：启动补写时没有会话，只有 inbox。
    //
    // 顺序不能反过来：先读 inbox 的话，在 QQ 里聊的那一天会写出一篇「她说了什么」的
    // 旁观者日记，而作者明明就在对话里。手动触发（按钮）不看日期窗口——用户按下去
    // 的意思是「把现在这段写下来」，不是「写今天 00:00 到现在的」。
    const source = { kind: "session", scanned: 0, ignored: 0 };
    let collected = { items: [] };
    // #539/#745：会话被无痕闸门挡下时，它和「当天真的没说过话」是两回事。
    // 行为一样（都不写、都落 skip），但审计里的原因必须分开记，否则以后查
    // 「这天为什么没写日记」会被误导成素材不够，而去翻一堆并不存在的日志。
    let gatedBy = null;
    // #724 截断统计（#613 §4）：total/used 必须可观测——LIMIT 静默砍掉的正是
    // 晚上那段（#613 实测 11-07 尾部 18/19/22 点共 267 条），不报错。
    let memoryStats = null;
    if (agentMode) {
      // #613 §4：素材主来源 = 全局记忆。具名 agent：它名下已落定会话的痕迹；
      // _unnamed：全部 session 源里「没落到具名 agent 的」冷行（验收红线 8：
      // 冷行默认进 _unnamed；diaryBackfillColdAgents 的回填会逐步把它们解走）。
      // 会话转录与 QQ inbox 不参与 agent 桶——那是「某一段对话」，不是「这个
      // agent 的日记」。类型黑名单由配置给（默认 constraint/preference）。
      const bySession = readAgentSessions(agentsRoot({ memoryDir, configured: config?.diaryDir }));
      const isUnnamed = String(agentId).trim() === UNNAMED_AGENT;
      const excludeIds = isUnnamed
        ? Object.entries(bySession).filter(([, row]) => row && row.agent && row.agent !== UNNAMED_AGENT).map(([id]) => id)
        : [];
      const ids = agentSessionIds(bySession, key);
      const fromMemories = collectMemoryMaterial({
        service,
        sessionIds: ids,
        excludeIds,
        dateLocal: today,
        maxItems: MAX_MATERIAL_ITEMS,
        excludeTypes: Array.isArray(config?.diaryMemoryExcludeTypes) ? config.diaryMemoryExcludeTypes : []
      });
      if (fromMemories.error) {
        audit({ status: "skipped", reason: `memories-${fromMemories.error}` });
        return { ok: true, status: "skipped", reason: `memories-${fromMemories.error}`, date: today };
      }
      collected = { items: fromMemories.items, scanned: fromMemories.total, ignored: 0 };
      source.kind = "memories";
      source.scanned = fromMemories.total;
      memoryStats = fromMemories;
    } else if (session) {
      const fromSession = collectSessionTranscript({
        session,
        dateLocal: trigger === "manual" ? null : today,
        maxItems: MAX_MATERIAL_ITEMS,
        sessionGate
      });
      if (!fromSession.error) {
        collected = fromSession;
        source.kind = "session";
      } else if (fromSession.error === "session-gated") {
        gatedBy = "session-gated";
      }
    }
    if (!agentMode && !collected.items.length) {
      const inboxDir = resolveInboxDir({ memoryDir, configured: config?.diaryInboxDir });
      const fromInbox = collectQqInbox({ dir: inboxDir, dateLocal: today, maxItems: MAX_MATERIAL_ITEMS });
      if (!fromInbox.error && fromInbox.items.length) {
        collected = fromInbox;
        source.kind = "qq-inbox";
      } else if (!session && fromInbox.error) {
        return skip(fromInbox.error, { inboxDir });
      }
    }
    if (!collected.items.length) {
      // 当天零条有效消息：不调模型、不落盘。空素材调一次模型是纯浪费，
      // 而它写出来的东西必然是编的。
      //
      // 但原因要分开记（见上面 gatedBy）：闸门命中与「真的没素材」在审计里
      // 必须是两个 reason，不能都写成 no-material。
      state[key] = { ...entry, projectRoot, lastDate: today, chatId: chatId ?? entry.chatId ?? null };
      writeState(stateRoot, state);
      return skip(gatedBy ?? "no-material", { scanned: collected.scanned, ignored: collected.ignored, source: source.kind });
    }

    const material = renderMaterial(collected.items);
    let personaText = "";
    let personaSource = "none";
    let degraded = false;
    try {
      // agentId 必须传：不传就永远落 default 卡，那么「拥有人格的 agent 写日记」在
      // 多角色宿主里会变成「所有角色共用同一个声音写日记」。宿主没给身份时传 null，
      // 退回 default —— 那才是无名会话唯一该有的答案（user-settings.js:44-52）。
      const block = renderUserSettingsBlock({ settings, config, agentId });
      personaText = String(block?.text ?? "");
      personaSource = String(block?.source ?? "none");
    } catch (error) {
      // 人格渲染失败不该挡住日记，但要如实标注这一篇少了一层信息。
      degraded = true;
      logger?.warn?.(`[dsh-mneme] diary persona render failed: ${String(error)}`);
    }

    const userText = [
      personaText,
      "",
      str("diaryMaterialHeader", collected.items.length, today),
      breakFenceMarkers(material),
      "",
      str("diaryMaterialFooter")
    ]
      .filter((s) => s !== null && s !== undefined)
      .join("\n");

    const log = logger || { info() {}, warn() {} };
    const route = resolveRoute(ctx, config, log);
    if (!route) {
      audit({ status: "failed", reason: "no-route" });
      return { ok: false, status: "failed", reason: "no-route", date: today };
    }

    let streamFailure = "";
    let body;
    try {
      const text = await runAuditedLlm(
        ctx,
        service ?? {},
        config,
        {
          triggerSource: "diary",
          operationType: "diary_compose",
          modelId: `${route.provider}:${route.model}`,
          relatedMemoryIds: [],
          streamError: () => streamFailure,
          auditError: (out) => (String(out ?? "").trim() ? null : "empty diary body")
        },
        (reportUsage) =>
          streamText(
            ctx,
            {
              provider: route.provider,
              model: route.model,
              purpose: "diary",
              messages: [
                { role: "system", content: [{ type: "text", text: prompts }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } },
                { role: "user", content: [{ type: "text", text: userText }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } }
              ]
            },
            reportUsage,
            (reason) => {
              streamFailure = describeStreamFailure(reason);
            }
          )
      );
      if (text === undefined) {
        audit({ status: "failed", reason: "llm-failed", detail: streamFailure || "stream aborted" });
        return { ok: false, status: "failed", reason: "llm-failed", date: today };
      }
      body = String(text).trim();
    } catch (error) {
      audit({ status: "failed", reason: "llm-threw", detail: String(error && error.message ? error.message : error) });
      return { ok: false, status: "failed", reason: "llm-threw", date: today };
    }

    const invalid = validateBody(body);
    if (invalid) {
      audit({ status: "failed", reason: `invalid-body:${invalid}` });
      return { ok: false, status: "failed", reason: `invalid-body:${invalid}`, date: today };
    }

    const gapNote = roll.gap ? str("diaryGapNote", roll.gapDays) : "";
    // frontmatter 只放「这篇是谁在什么条件下写的」：正文要能独立于记忆库被读懂。
    // 不写绝对路径（会泄露本机用户名，candidates.js:188-192 同一条纪律），
    // 只写项目键与身份 id——两者都不是隐私，也都够回答「这声音是谁」。
    const front = [
      "---",
      `date: ${today}`,
      // #613 §3.4：project 记的是「生成时的项目键」，只作历史留痕——读取侧一律
      // 以目录路径为准。agent 桶没有项目，这一行整个省掉（library 用 agentId 认人）。
      ...(agentMode ? [] : [`project: ${key}`]),
      `source: ${source.kind}`,
      `persona: ${personaSource}${agentId ? ` (${agentId})` : ""}`,
      "---"
    ].join("\n");
    const header = [front, `# ${today}`, gapNote].filter(Boolean).join("\n\n");
    let finalText = `${header}\n\n${body}\n`;

    // 同日第二次写（手动按钮最常见）：追加一段「补记」，不覆盖——用户按了两次按钮，
    // 想要的是多一段，不是把上一段弄丢。整文件仍然一次原子覆盖。
    let mode = existed ? "append" : "create";
    if (existed) {
      let previous = "";
      try {
        previous = readFileSync(file, "utf8");
      } catch {
        previous = "";
      }
      if (previous.trim()) {
        const stamp = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
        finalText = `${previous.replace(/\s+$/, "")}\n\n## ${str("diaryAddendum", stamp)}\n\n${body}\n`;
      }
    }
    // #613 验收红线：LIMIT 截断必须对读者可见——正文末尾一行「今天素材 N 条，
    // 本篇用了 M 条」，账本 diaryTruncated 同步。两处都做：正文给人，账本给排查。
    if (memoryStats && memoryStats.truncated) {
      finalText = `${finalText.replace(/\s+$/, "")}\n\n---\n\n${str("diaryTruncationNote", memoryStats.total, memoryStats.used)}\n`;
    }

    try {
      mkdirSync(root, { recursive: true });
      writeFileAtomic(file, finalText);
    } catch (error) {
      audit({ status: "failed", reason: "workspace-unwritable", detail: String(error && error.message ? error.message : error) });
      return { ok: false, status: "failed", reason: "workspace-unwritable", date: today };
    }

    state[key] = { ...entry, projectRoot, lastDate: today, chatId: chatId ?? entry.chatId ?? null, agentId: agentId ?? entry.agentId ?? null };
    writeState(stateRoot, state);

    // 指针行：登记进记忆库，让日记能被检索到。登记不上不算失败——正文已经在盘上、
    // 已经被用户拥有，那一层不该被一个开关或者一次 dedupe 收走。
    let pointer = null;
    if (config?.documentMemoryEnabled === true && typeof service?.registerDocument === "function") {
      try {
        const result = await service.registerDocument({
          path: file,
          title: str("diaryTitle", today),
          summary: str("diarySummary", today, body.replace(/\s+/g, " ").slice(0, 160)),
          tags: ["diary"]
        });
        pointer = { action: result?.action ?? "created", id: result?.id ?? null };
      } catch (error) {
        degraded = true;
        pointer = { action: "failed", detail: String(error && error.message ? error.message : error) };
      }
    } else {
      pointer = { action: "skipped", reason: "documentMemoryEnabled-off" };
    }

    audit({
      status: "written",
      mode,
      items: collected.items.length,
      source: source.kind,
      persona: personaSource,
      pointer: pointer?.action ?? null,
      ...(agentMode ? { agent: agentId } : {}),
      ...(memoryStats && memoryStats.truncated ? { diaryTruncated: { total: memoryStats.total, used: memoryStats.used } } : {})
    });
    return {
      ok: true,
      status: "written",
      mode,
      date: today,
      path: file,
      pointer,
      degraded,
      items: collected.items.length,
      source: source.kind,
      persona: personaSource,
      // diaryTruncated 只在真截断时出现：未截断的计数是日常，不是需要向读者
      // 交代的事（正文注记与账本字段都只在截断时写）。
      ...(memoryStats && memoryStats.truncated ? { diaryTruncated: { total: memoryStats.total, used: memoryStats.used } } : {})
    };
  }

  /**
   * 状态文件里记过的项目根。
   *
   * 启动补写要用它：宿主刚起来时没有任何会话，不知道该补哪个项目——但状态文件里
   * 记着「上次是哪个项目、哪天写的」，那就是唯一可信的线索。读不到就是空数组。
   */
  function knownProjects() {
    const root = diaryRoot({ memoryDir, configured: config?.diaryDir });
    let state;
    try {
      state = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
    } catch {
      return [];
    }
    if (!state || typeof state !== "object" || Array.isArray(state)) return [];
    const seen = new Set();
    for (const entry of Object.values(state)) {
      const p = entry && typeof entry.projectRoot === "string" ? entry.projectRoot.trim() : "";
      if (p) seen.add(p);
    }
    return [...seen];
  }

  return {
    compose: (input) => enqueue(() => compose(input)),
    knownProjects,
    /** #613：agents/ 下写过日记的 agent 名单（catchUp 与定时巡检的输入）。 */
    knownAgents() {
      const root = agentsRoot({ memoryDir, configured: config?.diaryDir });
      let names;
      try {
        names = readdirSync(root);
      } catch {
        return [];
      }
      return names.filter((n) => isBucketName(n) && latestDiaryDate(join(root, n)));
    },
    /** 只读一次账本：面板要回答「今天为什么没有日记」时必须读它，不能靠猜。 */
    readAudit({ projectRoot, limit = 50 } = {}) {
      const root = diaryDir({ memoryDir, projectRoot, configured: config?.diaryDir });
      if (!root) return [];
      const file = diaryAuditPath(root);
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        return [];
      }
      const rows = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          // 坏行跳过（账本纪律：坏行不拖死整份读取）。
        }
      }
      return rows.slice(-limit);
    }
  };
}
