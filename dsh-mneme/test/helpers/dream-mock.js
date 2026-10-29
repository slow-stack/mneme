// test/helpers/dream-mock.js
// 共享的确定性 LLM 测试桩：consolidation 决策生成器 + 最小 DSH ctx。
// 被 scripts/stress-dsh.js 与 test/stress.test.js 共用，保证压测与单测
// 走同一套"LLM 行为"，避免两边决策逻辑漂移。

export function parseEntries(listText) {
  return [...listText.matchAll(
    /id=([^\s|]+)\s*\|\s*type=(\w+)\s*\|\s*importance=(\d+)\s*\|\s*updated=([^\s|]+)\s*\|\s*title=([^|]*)/g
  )].map((m) => ({ id: m[1], type: m[2], importance: Number(m[3]), updated: m[4], title: m[5].trim() }));
}

/**
 * 长会话检索的确定性决策：title 含「变体」→ archive，其余 keep。
 */
export function sessionDecisions(listText) {
  const entries = parseEntries(listText);
  const decisions = [];
  const claimed = new Set();
  for (const e of entries) {
    if (e.title.includes("变体")) {
      decisions.push({ action: "archive", ids: [e.id], reason: "stale variant" });
      claimed.add(e.id);
    }
  }
  for (const e of entries) {
    if (!claimed.has(e.id)) decisions.push({ action: "keep", ids: [e.id] });
  }
  return JSON.stringify(decisions);
}

/**
 * 冲突裁决的确定性决策：title 以「(旧)」结尾 → conflict（胜者为同主题
 * 不带「(旧)」者），无对手 → keep。同一快照必然产出同一决策。
 */
export function arbitrationDecisions(listText) {
  const entries = parseEntries(listText);
  const byKey = new Map();
  for (const e of entries) {
    const key = e.title.replace(/\(旧\)$/, "").trim();
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }
  const decisions = [];
  const claimed = new Set();
  for (const group of byKey.values()) {
    const loser = group.find((e) => e.title.includes("(旧)"));
    const winner = group.find((e) => !e.title.includes("(旧)"));
    if (winner && loser) {
      decisions.push({ action: "conflict", winner: winner.id, loser: loser.id, reason: "新信息覆盖旧信息" });
      claimed.add(winner.id);
      claimed.add(loser.id);
      continue;
    }
    for (const e of group) {
      if (!claimed.has(e.id)) decisions.push({ action: "keep", ids: [e.id] });
      claimed.add(e.id);
    }
  }
  return JSON.stringify(decisions);
}

/**
 * 最小 DSH ctx：consolidation 用 onConsolidation(listText) 产出决策，
 * summary 返回固定文本。
 */
export function mockCtx({ onConsolidation, summaryText = "记忆库总览：用户偏好中文；关键决策已巩固。" } = {}) {
  return {
    logger: { warn: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "stress-model" }) },
    llm: {
      async *stream(options) {
        const userText = options.messages.find((m) => m.role === "user")?.content?.[0]?.text ?? "";
        // 认「这是巩固那一次调用」的判据：以前看 userText 是否以 `id=` 开头，但
        // #493 追加的围栏让 user 段以角色声明开头了。改判清单**形状**而不是首行——
        // `| type=` 只有巩固清单有（叙述条的 listing 形如 `- id=… | title=…`，没有
        // type=），所以两条调用路径不会串台。
        if (userText.includes("| type=")) {
          yield { type: "text-delta", index: 0, text: onConsolidation ? onConsolidation(userText, options.purpose) : "[]" };
        } else {
          yield { type: "text-delta", index: 0, text: summaryText };
        }
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
}
