// 记忆语言（memory.language，src/config.js）：生成记忆、注入标题与后台 LLM
// 提示词所用语言，'zh'（默认，上游行为不变）/ 'en'。本模块无全局状态：每个
// 插件实例从自己的 config 取语言（langOf），逐层传给 inject / summarize /
// dream / sleep / mirror，多实例（如 agent preset 内挂载）互不影响。
// 各语言对经 STR.<key>[language] 索引取值。

/** 解析实例语言：config.language === "en" 用英文，其余（含缺席）一律中文。 */
export function langOf(config) {
  return config?.language === "en" ? "en" : "zh";
}

const PROMPTS = {
  "summary": {
    "zh": "你是记忆库提炼助手。根据下面的会话内容，提炼值得跨会话记住的原子记忆。\n原子记忆原则：每条记忆只装一个独立事实/偏好/决策，短小、自带完整上下文（把数字、名字、路径、结论等原始细节保留在 content 里，不要抽象概括）；宁可拆成多条也绝不合并丢细节。信息量一般提 2-4 条，信息密集的对话可提 4-8 条。\n只输出 JSON 数组，每项形如 {\"type\":\"preference|project|decision|history\",\"title\":\"简短标题\",\"content\":\"保留原始细节的一句话\",\"importance\":1-5,\"occurred_at\":\"可选：事件发生的绝对时间，ISO-8601\"}。\noccurred_at（可选）：这条记忆所述事件**实际发生**的绝对时间，ISO-8601 带时区（如 2026-10-05T09:30:00+08:00）。会话里出现「昨天/前天/上周/上个月」这类相对时间时，按提示末尾给出的当前时间换算成绝对时间再填；没有任何时间依据、或换算不出来时，整条省略该字段——严禁编造，也不要把当前时间当成事件时间填进去。\n不要输出任何其他文字。",
    "en": "You are the memory curation assistant. From the conversation content below, distill atomic memories worth remembering across sessions.\nAtomic-memory principle: each memory holds exactly one standalone fact/preference/decision — short and self-contained (keep raw details like numbers, names, paths, and conclusions verbatim in content; do not abstract or summarize them away). Prefer splitting into multiple entries over merging and losing detail. Extract 2-4 entries normally, 4-8 for information-dense conversations.\nWrite every title and content in English.\nOutput only a JSON array, each item shaped {\"type\":\"preference|project|decision|history\",\"title\":\"short title\",\"content\":\"one sentence preserving original detail\",\"importance\":1-5,\"occurred_at\":\"optional: absolute time the event happened, ISO-8601\"}.\noccurred_at (optional): the absolute time the described event **actually happened**, in ISO-8601 with a timezone (e.g. 2026-10-05T09:30:00+08:00). When the conversation uses a relative time (yesterday / the day before / last week / last month), convert it into an absolute time against the current time given at the end of this prompt. Omit the field entirely when there is no temporal basis or it cannot be converted — never invent a value, and never pass the current time off as the event time.\nOutput no other text."
  },
  "codingSummary": {
    "zh": "你是记忆库提炼助手。根据下面的会话内容（含用户输入、助手回答、工具调用与结果），提炼值得跨会话记住的原子记忆。\n原子记忆原则：每条记忆只装一个独立事实/偏好/决策，短小、自带完整上下文（把数字、报错信息、命令、路径、结论等原始细节保留在 content 里，不要抽象概括）；宁可拆成多条也绝不合并丢细节。信息量一般提 2-4 条，信息密集的对话可提 4-8 条。\n只输出 JSON 数组，每项形如 {\"type\":\"preference|project|decision|history|rejected_solution|pitfall|constraint\",\"title\":\"简短标题\",\"content\":\"保留原始细节的一句话\",\"importance\":1-5,\"occurred_at\":\"可选：事件发生的绝对时间，ISO-8601\"}。\noccurred_at（可选）：这条记忆所述事件**实际发生**的绝对时间，ISO-8601 带时区（如 2026-10-05T09:30:00+08:00）。会话里出现「昨天/前天/上周/上个月」这类相对时间时，按提示末尾给出的当前时间换算成绝对时间再填；没有任何时间依据、或换算不出来时，整条省略该字段——严禁编造，也不要把当前时间当成事件时间填进去。\n若对话涉及编码/调试，可额外提取编码类记忆：\n- rejected_solution：被否决/废弃的实现方案（content 含方案简述 + 被否决原因 + 最终采用方案）\n- pitfall：调试踩坑记录（content 含现象/报错 + 根因 + 解决/规避方法）\n- constraint：项目工程约束（content 含约束描述 + 来源）\n普通闲聊、临时无关对话一律不提取编码类记忆。不要输出任何其他文字。",
    "en": "You are the memory curation assistant. From the conversation content below (including user input, assistant replies, tool calls and results), distill atomic memories worth remembering across sessions.\nAtomic-memory principle: each memory holds exactly one standalone fact/preference/decision — short and self-contained (keep raw details like numbers, error messages, commands, paths, and conclusions verbatim in content; do not abstract them away). Prefer splitting into multiple entries over merging and losing detail. Extract 2-4 entries normally, 4-8 for information-dense conversations.\nWrite every title and content in English.\nOutput only a JSON array, each item shaped {\"type\":\"preference|project|decision|history|rejected_solution|pitfall|constraint\",\"title\":\"short title\",\"content\":\"one sentence preserving original detail\",\"importance\":1-5,\"occurred_at\":\"optional: absolute time the event happened, ISO-8601\"}.\noccurred_at (optional): the absolute time the described event **actually happened**, in ISO-8601 with a timezone (e.g. 2026-10-05T09:30:00+08:00). When the conversation uses a relative time (yesterday / the day before / last week / last month), convert it into an absolute time against the current time given at the end of this prompt. Omit the field entirely when there is no temporal basis or it cannot be converted — never invent a value, and never pass the current time off as the event time.\nIf the conversation involves coding/debugging, additionally extract coding-specific memories:\n- rejected_solution: implementation approaches that were rejected or abandoned (content: brief approach + why rejected + what was adopted instead)\n- pitfall: debugging pitfalls (content: symptom/error + root cause + fix or workaround)\n- constraint: project engineering constraints (content: constraint description + source)\nNever extract coding-specific memories from casual small talk or temporary unrelated conversations. Output no other text."
  },
  "dreamSummary": {
    "zh": "你是记忆库状态叙述助手。根据整理后的记忆，写一段 150-200 字的「当前状态」叙述：现在在做什么（活跃主题）、最近完成了什么或发生了什么变化、接下来明显的走向。只陈述记忆中有依据的事实，不要发明细节；偏好、项目、决策自然融入叙述而不必逐项罗列。这段叙述会作为会话上下文常驻注入。只输出叙述文本，不要其他内容。",
    "en": "You are the memory status narrator. From the consolidated memories below, write a 150-200 word \"current state\" narrative: what is being worked on now (active themes), what was recently completed or changed, and the obvious next direction. State only facts grounded in the memories — never invent details; weave preferences, projects, and decisions into the narrative instead of listing them. This narrative is injected as standing conversation context. Output only the narrative text, nothing else."
  },
  "consolidation": {
    "zh": "你是记忆库整理助手。下面是全部记忆条目（id、类型、标题、内容、重要性、更新时间）。\n请执行记忆巩固（consolidation），输出一个决策 JSON 数组。\n\n【决策格式（必须严格遵守）】\n每个决策必须是对象，字段固定：\n- \"action\"：必填。取值只能是 \"keep\" / \"merge\" / \"archive\" / \"update\" / \"conflict\" 之一（字段名必须是 action，严禁写成 type）\n- \"ids\"：必填，数组，本决策涉及的记忆 id 列表\n- \"reason\"：可选，字符串，决策理由\n- \"importance\"：可选，整数 1-5\n- merge 额外字段：\"keepSource\"（单个 id 字符串，必须是 ids 之一）+ 合并后的 \"title\"、\"content\"\n- conflict 额外字段：\"winner\" 与 \"loser\"，都是【单个 id 字符串，不是数组】\n- update 额外字段：修正后的 \"title\" 和/或 \"content\"；\"ids\" 只能包含一个 id\n\n【决策 JSON 示例】\n[\n  { \"action\": \"merge\", \"ids\": [\"m1\", \"m2\"], \"keepSource\": \"m1\", \"title\": \"合并标题\", \"content\": \"合并后的摘要内容\", \"importance\": 4, \"reason\": \"主题相近\" },\n  { \"action\": \"conflict\", \"winner\": \"m3\", \"loser\": \"m4\", \"reason\": \"内容矛盾，保留更新的信息\" },\n  { \"action\": \"update\", \"ids\": [\"m5\"], \"content\": \"修正后的内容\", \"reason\": \"信息过时\" },\n  { \"action\": \"archive\", \"ids\": [\"m6\"], \"reason\": \"重复或过时\" }\n]\n\n【任务】\n1. 识别主题相近的条目 → merge（合并为更精炼的摘要，保留信息最完整的 id 作为 keepSource）\n2. 识别重复/过时信息 → archive\n3. 识别内容矛盾的条目 → conflict（按时间新旧、来源完整性、信息具体程度判断 winner/loser）\n4. 发现单条记忆中的信息过时、错误或遗漏 → update（直接修正内容）\n   - update 的 ids 只能包含一个 id\n   - 必须提供修正后的 title 和/或 content\n   - 仅当内容确实需要修正时才使用，不要滥用\n   - 每次整理最多输出 2 个 update\n   - 24 小时内新建的记忆不可 update\n5. 无问题的条目无需输出（未提及的条目将自动保留 keep）\n\n【硬性规则】\n- 字段名必须精确为 \"action\"，严禁写成 \"type\"；字段名统一用双引号\n- conflict 的 winner/loser、merge 的 keepSource 都是【单个 id 字符串，绝不是数组】\n- 每条记忆最多被 claim 一次：同一个 id 不能出现在多个决策中（同一 id 不能被 merge 和 conflict/archive 等重复占用）\n- 未在决策中提及的记忆将自动保留（keep），无需为每条记忆输出 keep\n- merge 的 keepSource 必须是 ids 之一\n- 仅合并同类型条目（type 相同）\n- 不要编造 ids；只使用提供的 id\n- 重要性 1-5，合并后取最高\n- archive 仅用于确属「重复或已过时」的条目；rejected_solution / constraint / pitfall / preference / pattern 属长保留类型，除非确属重复或过时，否则不要归档\n- 每次整理最多输出 8 个 archive\n- 只输出 JSON 数组，不要其他文字",
    "en": "You are the memory consolidation assistant. Below are all memory entries (id, type, title, content, importance, updated time).\nPerform memory consolidation and output a JSON array of decisions.\n\n[Decision format (must be followed strictly)]\nEach decision must be an object with fixed fields:\n- \"action\": required. Value must be one of \"keep\" / \"merge\" / \"archive\" / \"update\" / \"conflict\" (the field name must be action, never type)\n- \"ids\": required, array, the list of memory ids involved in this decision\n- \"reason\": optional, string, rationale for the decision\n- \"importance\": optional, integer 1-5\n- merge extra fields: \"keepSource\" (a single id string, must be one of ids) plus the merged \"title\" and \"content\"\n- conflict extra fields: \"winner\" and \"loser\", each a [single id string, never an array]\n- update extra fields: the corrected \"title\" and/or \"content\"; \"ids\" may contain only one id\n\n[Decision JSON examples]\n[\n  { \"action\": \"merge\", \"ids\": [\"m1\", \"m2\"], \"keepSource\": \"m1\", \"title\": \"Merged title\", \"content\": \"Merged summary content\", \"importance\": 4, \"reason\": \"similar topics\" },\n  { \"action\": \"conflict\", \"winner\": \"m3\", \"loser\": \"m4\", \"reason\": \"content contradicts; keep the newer information\" },\n  { \"action\": \"update\", \"ids\": [\"m5\"], \"content\": \"corrected content\", \"reason\": \"information outdated\" },\n  { \"action\": \"archive\", \"ids\": [\"m6\"], \"reason\": \"duplicate or outdated\" }\n]\n\n[Task]\n1. Identify entries with similar topics -> merge (merge into a more refined summary; keep the id with the most complete information as keepSource)\n2. Identify duplicate/outdated information -> archive\n3. Identify entries with contradictory content -> conflict (judge winner/loser by recency, source completeness, and information specificity)\n4. Find outdated, wrong, or missing information in a single memory -> update (correct the content directly)\n   - update's ids may contain only one id\n   - must provide the corrected title and/or content\n   - use only when the content truly needs correction; do not abuse\n   - output at most 2 updates per consolidation run\n   - memories created within the last 24 hours must not be updated\n5. Entries without issues need no output (unmentioned entries are automatically kept)\n\n[Hard rules]\n- Field names must be exactly \"action\", never \"type\"; use double quotes for all field names\n- conflict winner/loser and merge keepSource are [single id strings, never arrays]\n- Each memory may be claimed at most once: the same id must not appear in multiple decisions (an id must not be claimed by both merge and conflict/archive, etc.)\n- Memories not mentioned in any decision are automatically kept (keep); no need to output keep for every memory\n- merge keepSource must be one of ids\n- Only merge entries of the same type (identical type)\n- Never invent ids; use only the provided ids\n- Importance is 1-5; after a merge take the highest\n- Write every title, content, and reason in English\n- archive is only for entries that are genuinely \"duplicate or outdated\"; rejected_solution / constraint / pitfall / preference / pattern are long-retention types — do not archive them unless they are truly duplicate or outdated\n- output at most 8 archives per consolidation run\n- Output only the JSON array, nothing else"
  },
  "conflict": {
    "zh": "你是记忆库冲突仲裁助手。下面是检测到的高相似度记忆对，可能内容矛盾或重复。\n对每一对输出一个 decision 对象：\n- 两条确实矛盾/重复 → { \"action\": \"conflict\", \"winner\": <保留的id>, \"loser\": <归档的id>, \"reason\": \"理由\" }\n- 两条只是主题相近、并无矛盾 → { \"action\": \"keep\", \"ids\": [<两个id>] }\n规则：\n- winner 应为信息更完整、更新或更可信的一条\n- 只使用提供的 id，不要编造\n- 每对必须输出一个 decision\n- 只输出 JSON 数组，不要其他文字",
    "en": "You are the memory conflict arbiter. Below are detected high-similarity memory pairs that may contradict or duplicate each other.\nFor each pair output one decision object:\n- The two entries genuinely contradict/duplicate -> { \"action\": \"conflict\", \"winner\": <id to keep>, \"loser\": <id to archive>, \"reason\": \"rationale\" }\n- The two entries are merely topically similar, no contradiction -> { \"action\": \"keep\", \"ids\": [<both ids>] }\nRules:\n- winner should be the more complete, newer, or more trustworthy entry\n- Use only the provided ids; never invent them\n- Every pair must produce exactly one decision\n- Write every reason in English\n- Output only a JSON array, no other text"
  },
  // Issue #126：sleepActionSet="full" 的六分支裁决 prompt。默认档（"conflict"）
  // 仍用上面只有 conflict/keep 的窄 prompt——后台自动流程不静默扩张行为。
  "conflictFull": {
    "zh": "你是记忆库冲突仲裁助手。下面是检测到的高相似度记忆对。请对每一对**恰好输出一个** decision。\n\n先判断属于哪一类，再按对应格式输出：\n\n1. 同义重复（说的是同一件事，合并后不丢信息）→ { \"action\": \"merge\", \"ids\": [<两个id>], \"keepSource\": <保留的id>, \"title\": \"合并后标题\", \"content\": \"合并后内容\", \"importance\": 1-5 }\n2. 演进（旧版整体被新版取代、旧版作废）→ { \"action\": \"supersede\", \"winner\": <取代方id>, \"loser\": <被取代方id>, \"reason\": \"理由\" }\n3. 互补（两条各自成立、覆盖不同侧面，都不能丢）→ { \"action\": \"differentiate\", \"ids\": [<两个id>], \"distinctions\": [\"差异点1\", \"差异点2\"] }\n4. 信息部分过时（只需就地修正其中一条）→ { \"action\": \"update\", \"ids\": [<要修正的id>], \"title\": \"修正后标题\", \"content\": \"修正后内容\", \"importance\": 1-5, \"reason\": \"理由\" }\n5. 真矛盾（同一事实给出互斥结论，必须留一个）→ { \"action\": \"conflict\", \"winner\": <保留的id>, \"loser\": <归档的id>, \"reason\": \"理由\" }\n6. 主题相近但既无矛盾也不需合并 → { \"action\": \"keep\", \"ids\": [<两个id>] }\n\n判据先后：先看能否 merge（同义），再看是否只是旧版被取代（supersede），再看是否互补（differentiate），最后才考虑 conflict。拿不准时倾向 keep 或 differentiate——两条都留下比错误归档一条安全。\n规则：\n- 只使用提供的 id，不要编造\n- 每对必须输出一个 decision\n- winner/loser 与 keepSource 都是【单个 id 字符串，不是数组】\n- differentiate 的 distinctions 必须非空，写清两条各自覆盖的不同侧面\n- update 的 ids 只能含一个 id，且只能指向 24 小时以前创建的记忆（保护期内的新记忆不要 update）\n- 只输出 JSON 数组，不要其他文字",
    "en": "You are the memory conflict arbiter. Below are detected high-similarity memory pairs. For each pair output **exactly one** decision.\n\nClassify first, then use the matching shape:\n\n1. Same-fact duplicate (same thing, merging loses no information) -> { \"action\": \"merge\", \"ids\": [<both ids>], \"keepSource\": <id to keep>, \"title\": \"merged title\", \"content\": \"merged content\", \"importance\": 1-5 }\n2. Evolution (the newer version supersedes and invalidates the older one) -> { \"action\": \"supersede\", \"winner\": <superseding id>, \"loser\": <superseded id>, \"reason\": \"rationale\" }\n3. Complementary (both hold, covering different aspects — neither can be dropped) -> { \"action\": \"differentiate\", \"ids\": [<both ids>], \"distinctions\": [\"difference 1\", \"difference 2\"] }\n4. Partially outdated (only one entry needs an in-place correction) -> { \"action\": \"update\", \"ids\": [<id to correct>], \"title\": \"corrected title\", \"content\": \"corrected content\", \"importance\": 1-5, \"reason\": \"rationale\" }\n5. Genuine contradiction (mutually exclusive conclusions on the same fact — one must go) -> { \"action\": \"conflict\", \"winner\": <id to keep>, \"loser\": <id to archive>, \"reason\": \"rationale\" }\n6. Topically similar but neither contradictory nor mergeable -> { \"action\": \"keep\", \"ids\": [<both ids>] }\n\nOrder of judgment: try merge first (same fact), then supersede (older version replaced), then differentiate (complementary), and only then conflict. When unsure, prefer keep or differentiate — keeping both is safer than wrongly archiving one.\nRules:\n- Use only the provided ids; never invent them\n- Every pair must produce exactly one decision\n- winner/loser and keepSource are each a [single id string, never an array]\n- distinctions must be a non-empty array spelling out what each entry covers\n- update may target only memories created more than 24 hours ago, and ids may contain only one id\n- Write every reason in English\n- Output only a JSON array, no other text"
  },
  "pattern": {
    "zh": "你是记忆库模式发现助手。下面是最近的记忆条目（id、类型、标题、内容）。\n请发现跨条目的稳定模式：用户偏好的规律、反复出现的主题、可复用的工作流或项目规律。\n对每个模式输出一个 create decision：\n{ \"action\": \"create\", \"type\": \"pattern\", \"title\": \"模式一句话标题\", \"content\": \"模式详细描述（2-4句）\", \"importance\": 1-5, \"evidence\": [\"支持该模式的记忆id\"] }\n规则：\n- 只输出有据可依的模式，宁缺毋滥\n- evidence 必须是列表中真实存在的 id\n- 最多输出 N 个模式\n- 只输出 JSON 数组，不要其他文字",
    "en": "You are the memory pattern-discovery assistant. Below are recent memory entries (id, type, title, content).\nDiscover stable cross-entry patterns: regularities in user preferences, recurring themes, reusable workflows or project patterns.\nFor each pattern output one create decision:\n{ \"action\": \"create\", \"type\": \"pattern\", \"title\": \"one-sentence pattern title\", \"content\": \"detailed pattern description (2-4 sentences)\", \"importance\": 1-5, \"evidence\": [\"ids of memories supporting this pattern\"] }\nRules:\n- Only output well-evidenced patterns; prefer fewer over filler\n- evidence must contain ids that actually exist in the list\n- Output at most N patterns\n- Write every title, content, and reason in English\n- Output only a JSON array, no other text"
  },
  "freezeSuffix": {
    "zh": "\n\n当前为「冲突冻结」模式：检测到内容矛盾的条目时，仍请输出 conflict，并以 winner/loser 作为候选、reason 说明理由；冲突不会被自动裁决，而会冻结待人工确认。",
    "en": "\n\nConflict-freeze mode is active: when you detect entries with contradictory content, still output conflict — winner/loser are treated as candidates and reason explains the rationale; conflicts are not auto-adjudicated but frozen for human confirmation."
  },
  // 叙述条（#164 对齐）：按主题聚类合成叙述，evidence 只能用簇内真实 id。
  "narrative": {
    zh: "你是记忆库叙述助手。下面按主题聚类给出记忆条目（id=... | title=... | 内容）。\n对每个聚类写一段 80-150 字的叙述条：该主题下的事实聚合——当前状态、关键事实、值得注意的走向。只依据给出的条目，不要发明细节。\n输出严格 JSON 数组：\n[{ \"tag\": \"聚类标签（原样照抄）\", \"content\": \"叙述文本\", \"evidence\": [\"支撑本叙述的记忆 id\"] }]\n规则：\n- evidence 只能使用该聚类内真实存在的 id，不要编造\n- 不是每个聚类都必须输出；没有可说的就跳过\n- 只输出 JSON 数组，不要其他文字",
    en: "You are the memory narrative assistant. Below are memory entries grouped by topic clusters (id=... | title=... | content).\nFor each cluster write an 80-150 word narrative bar: the aggregated facts of that topic — current state, key facts, notable direction. Ground everything in the given entries; never invent details.\nOutput a strict JSON array:\n[{ \"tag\": \"cluster label (copy verbatim)\", \"content\": \"narrative text\", \"evidence\": [\"memory ids supporting this narrative\"] }]\nRules:\n- evidence must only use ids that really exist inside that cluster; never invent them\n- You do not have to cover every cluster; skip ones with nothing to say\n- Output only the JSON array, nothing else"
  }
};

export const STR = {
  // --- summarize.js：蒸馏的时间锚点 ------------------------------------------
  // 追加在 summary/codingSummary 之后，值随触发时刻变（所以是构造器而不是
  // STR.prompts 里的字面量——那张表被 test/lang.test.js 锁成「每个语言键都是
  // 纯字符串、不含 JS 语法」）。转录行本身不带时间戳，没有这个锚，「昨天/上周」
  // 就无从换算成绝对 occurred_at：prompt 要求换算却不给基准，模型只能编造，正是
  // 要防的那种幻觉。SimpleMem（arXiv 2601.02553）把时间锚定并进同一次抽取，这里
  // 的锚点时间取自蒸馏触发时刻（summarize.js 的可注入 now()，测试可用假时钟）。
  distillTimeAnchor: {
    zh: (iso) => `\n\n当前时间：${iso}（本会话发生的时间）。据此换算 occurred_at。`,
    en: (iso) => `\n\nCurrent time: ${iso} (when this conversation happened). Use it to convert occurred_at.`
  },
  // --- inject.js：注入块标题 / 条目行 ---------------------------------------
  hotHeader: {
    zh: (rounds, body) => `[短期上下文] 最近对话（共 ${rounds} 轮）：\n${body}`,
    en: (rounds, body) => `[Short-term context] Recent conversation (${rounds} rounds):\n${body}`
  },
  memoryHeader: {
    zh: "[记忆库] 来自 dsh-mneme 的跨会话记忆（用户偏好与高优先级项目/决策）：",
    en: "[Memory] Cross-session memories from dsh-mneme (user preferences and high-priority project/decision entries):"
  },
  verified: { zh: "[verified] ", en: "[verified] " },
  entryTitle: {
    zh: (title, importance) => `${title}（重要性 ${importance}）`,
    en: (title, importance) => `${title} (importance ${importance})`
  },
  entryLine: {
    zh: (type, verified, title, content) => `- [${type}] ${verified}${title}：${content}`,
    en: (type, verified, title, content) => `- [${type}] ${verified}${title}: ${content}`
  },
  // Issue #164①：注入截断不静默——上限/原长/memory_get 全文指引。
  truncatedHint: {
    zh: (max, len, id) => `〔已截断：上限 ${max}，原 ${len} 字符；全文用 memory_get "${id}" 查看〕`,
    en: (max, len, id) => `[truncated: limit ${max}, original ${len} chars; memory_get "${id}" for full text]`
  },
  // Issue #249（第一批）：pin 池超预算时的如实标注——分层不等于丢弃，也不允许
  // 静默省略未展示条数（agent 才知道库里的约束不止这几条，需按需 memory_search）。
  pinnedOverflow: {
    zh: (n) => `〔约束/偏好类另有 ${n} 条未展示〕`,
    en: (n) => `[${n} more constraint/preference entries not shown]`
  },
  // Issue #24 块3：图召回线索行的引导语——正向声明「链路信息非事实断言」，
  // 防 LLM 单次消费把桥接召回当有依据的事实回头扩散（幻觉诱导）。
  graphHintHeader: {
    zh: "[检索线索] 以下为实体图搜索的链路信息，仅供定位参考，非事实断言：",
    en: "[Retrieval hints] Entity-graph link trails below are navigation aids, not factual assertions:"
  },
  graphHintLine: {
    zh: (type, title, content) => `- [线索/${type}] ${title}：${content}`,
    en: (type, title, content) => `- [hint/${type}] ${title}: ${content}`
  },
  userSettingsHeader: {
    zh: "[用户设置] 来自 dsh-mneme 的用户画像与规则：",
    en: "[User settings] Profile and rules from dsh-mneme:"
  },
  profileLine: {
    zh: (profile) => `- 用户画像：${profile}`,
    en: (profile) => `- Profile: ${profile}`
  },
  ruleLine: {
    zh: (rule) => `- 规则：${rule}`,
    en: (rule) => `- Rule: ${rule}`
  },

  // --- summarize.js：蒸馏转录标签（进入 LLM 上下文） --------------------------
  transcriptUser: { zh: (t) => `用户：${t}`, en: (t) => `User: ${t}` },
  transcriptAssistant: { zh: (t) => `助手：${t}`, en: (t) => `Assistant: ${t}` },
  transcriptAgent: { zh: (t) => `子会话交付：${t}`, en: (t) => `Subagent delivery: ${t}` },
  transcriptToolCall: {
    zh: (name, args) => `工具调用：${name}(${args})`,
    en: (name, args) => `Tool call: ${name}(${args})`
  },
  statusOk: { zh: "成功", en: "success" },
  statusFail: { zh: "失败", en: "failed" },
  transcriptToolResult: {
    zh: (status, out) => `工具结果（${status}）：${out}`,
    en: (status, out) => `Tool result (${status}): ${out}`
  },
  transcriptCode: {
    zh: (status, out) => `代码执行（${status}）：${out}`,
    en: (status, out) => `Code execution (${status}): ${out}`
  },

  // --- dream.js：聚类快照标记 -------------------------------------------------
  clusterHeader: { zh: (n) => `# 聚类 ${n}`, en: (n) => `# Cluster ${n}` },
  conflictMark: { zh: " | [潜在冲突]", en: " | [potential conflict]" },
  summaryTitle: { zh: "记忆库总览", en: "Memory library overview" },
  // 常驻状态条口径脚注（#164 对齐）：每次 dream 刷新总览时随行标注快照口径，
  // 让「这条常驻叙述基于什么状态生成」永远可查；正式 evidence 列由叙述条批次落地。
  summaryScope: {
    zh: (count, run, date) => `\n\n〔口径：基于整理后 ${count} 条记忆快照 · run ${run} · ${date}〕`,
    en: (count, run, date) => `\n\n[scope: based on a post-consolidation snapshot of ${count} memories · run ${run} · ${date}]`
  },
  // per-topic 叙述条标题（#164 对齐）：主题键确定 → 标题跨 run 稳定 → dedupe
  // 原地刷新不产生重复行
  narrativeTitle: {
    zh: (tag) => `叙述：${tag}`,
    en: (tag) => `Narrative: ${tag}`
  },

  // --- dream/sleep.js：冲突候选列表 --------------------------------------------
  similarityReason: { zh: (s) => `相似度 ${s}`, en: (s) => `similarity ${s}` },
  // v0.8.1（issue #170 第 2 步）：跨 scope 相似对停车到冲突队列的专属 reason。
  scopeCandidateReason: {
    zh: (s) => `跨作用域相似 ${s}（疑似同一内容落在两个归属下，请裁决归属/去重）`,
    en: (s) => `cross-scope similar ${s} (same content under two scopes — review ownership)`
  },
  // v0.8.1（issue #170 复核项 3）：普通 dream 的 LLM 输出跨 scope conflict 时
  // 停车用（相似度未知，带模型给的裁决理由）。
  scopeConflictParkReason: {
    zh: (r) => `跨作用域冲突（归属不同，不自动裁决）${r ? `：${r}` : ""}`,
    en: (r) => `cross-scope conflict (different ownership — not auto-adjudicated)${r ? `: ${r}` : ""}`
  },
  candidateConflicts: {
    zh: (p) => `候选冲突：\nid=${p.a.id} | type=${p.a.type} | title=${p.a.title}\n${p.a.content}\n---\nid=${p.b.id} | type=${p.b.type} | title=${p.b.title}\n${p.b.content}\n（相似度 ${p.similarity.toFixed(2)}）`,
    en: (p) => `Candidate conflicts:\nid=${p.a.id} | type=${p.a.type} | title=${p.a.title}\n${p.a.content}\n---\nid=${p.b.id} | type=${p.b.type} | title=${p.b.title}\n${p.b.content}\n(similarity ${p.similarity.toFixed(2)})`
  },

  // --- dream/decisions.js：写回记忆的来源批注 ------------------------------------
  evidenceSuffix: {
    zh: (content, evidence) => `${content}\n\n[证据: ${evidence.join(", ")}]`,
    en: (content, evidence) => `${content}\n\n[Evidence: ${evidence.join(", ")}]`
  },
  supersededSuffix: {
    zh: (content, oldInfo) => `${content}\n\n（已否决旧信息：${oldInfo}）`,
    en: (content, oldInfo) => `${content}\n\n(superseded outdated info: ${oldInfo})`
  },
  // Issue #126：supersede 与 conflict 的关键差别——注记写在 loser（被取代方）
  // 而不是 winner，赢家正文因此保持干净（这正是 #126 对 conflict 的原抱怨）。
  supersededBySuffix: {
    zh: (content, winnerTitle) => `${content}\n\n（已被取代：${winnerTitle}）`,
    en: (content, winnerTitle) => `${content}\n\n(superseded by: ${winnerTitle})`
  },
  // Issue #126：differentiate 的差异注记，双方都要追加（进正文 → 进注入与
  // embedding，下一轮就不会再被判成重复）。
  differentiatedMarker: {
    zh: (notes) => `\n\n（差异注记：${notes.join("；")}）`,
    en: (notes) => `\n\n(differences: ${notes.join("; ")})`
  },

  // --- service.js：三方合并冲突批注（写入记忆内容） -----------------------------
  serviceConflictMarker: {
    zh: (ts, content) => `\n\n> ⚠️ 并发冲突：人工编辑 vs 记忆库并发更新（${ts}）\n> 记忆库版本：${content}`,
    en: (ts, content) => `\n\n> ⚠️ Concurrent conflict: human edit vs concurrent memory-library update (${ts})\n> memory-library version: ${content}`
  },

  // --- commands.js：自定义指令缺省描述（进命令注册表，LLM 可见） -----------------
  commandFallbackDesc: {
    zh: (name) => `自定义指令 ${name}`,
    en: (name) => `Custom command ${name}`
  },
  commandInputHint: {
    zh: "可选：追加给模型的补充说明",
    en: "Optional: extra note to append for the model"
  },
  commandSubmitted: {
    zh: (name) => `已提交指令：${name}`,
    en: (name) => `Submitted command: ${name}`
  },
  commandSubmitFailed: {
    zh: (name) => `指令 ${name} 提交失败，详见日志`,
    en: (name) => `Failed to submit command ${name}; see logs`
  },

  // --- mirror.js：镜像文件标签（渲染随实例语言；解析两种语言都认） ----------------
  mirrorLabel: {
    zh: { type: "类型", importance: "重要性", tags: "标签", updated: "更新时间", source: "来源", scope: "作用域", sensitivity: "敏感度" },
    en: { type: "Type", importance: "Importance", tags: "Tags", updated: "Updated", source: "Source", scope: "Scope", sensitivity: "Sensitivity" }
  },
  mirrorHeader: {
    zh: (name) => `# ${name} — dsh-mneme 镜像\n\n<!-- 条目标题与正文可编辑，会被合并回记忆库（人工优先）；文件头与条目元数据行由机器维护，改动会在下次同步时被覆盖。 -->\n\n`,
    en: (name) => `# ${name} — dsh-mneme mirror\n\n<!-- Entry titles and bodies are editable and merged back into the memory store (human edits win); the file header and entry metadata lines are machine-owned and get overwritten on the next sync. -->\n\n`
  },
  // document 的镜像只有指针行（#296 第二批）：没有可编辑的正文，手工改动一律被
  // 下次同步覆盖——所以不能复用上面那句「可编辑、会被合并回记忆库」。
  mirrorReadonlyHeader: {
    zh: (name) => `# ${name} — dsh-mneme 只读视图\n\n<!-- 只含指针行：id + 标题 + 摘要首句 + 文件路径，不含正文。正文在路径指向的文件里，批注请写进记忆库；本文件由机器维护，手工改动会在下次同步时被覆盖。 -->\n\n`,
    en: (name) => `# ${name} — dsh-mneme read-only view\n\n<!-- Pointer rows only: id + title + first sentence of the summary + file path, never the full text. The document itself lives at that path, annotations belong in the memory store, and this file is machine-owned: hand edits are overwritten on the next sync. -->\n\n`
  },
  // documentDir 的 index.md（#296 第二批）：整文件机器所有、可从库重建。
  documentIndexHeader: {
    zh: () => "# document 索引 — dsh-mneme\n\n<!-- 整文件机器所有，可从记忆库随时重建（所以这里不写生成时间）；要批注请写进记忆库（memory_save）。managed = 文件在 documentDir 内。 -->\n\n",
    en: () => "# document index — dsh-mneme\n\n<!-- Machine-owned as a whole and rebuildable from the memory store at any time (which is why it carries no generation timestamp). Annotations belong in the memory store (memory_save). managed = the file sits inside documentDir. -->\n\n"
  },

  prompts: PROMPTS
};
