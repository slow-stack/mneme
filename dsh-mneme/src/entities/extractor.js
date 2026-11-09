const VALID_TYPES = new Set(["person", "project", "concept", "technology", "organization"]);
// #619：affective_context 是「人 ↔ 当时那件事」的情绪关联，与其余四种
// 结构关系（uses / depends_on / part_of / related_to）不同轴。加进白名单不是
// 装饰：白名单外的类型会被 sanitizeRelationType 拒收，模型抽出来的情感边会
// 一条都落不了库，而库面上看不出任何异常。
const VALID_RELATIONS = new Set(["uses", "depends_on", "part_of", "related_to", "affective_context"]);
const MAX_MEMORY_CHARS = 4000;

function buildSystemPrompt(config) {
  const maxEntities = config.entityExtractionMaxEntities ?? 10;
  const maxAttrs = config.entityExtractionMaxAttrs ?? 20;
  
  return `You are an entity extraction engine. Extract named entities, their attributes, and relations from the given text.

RULES:
- Entities are concrete people, projects, technologies, concepts, or organizations.
- Attributes are characteristic states of an entity. Only extract attributes explicitly mentioned in the text.
- Do NOT infer, guess, or hallucinate. Only extract what is clearly stated.
- Use canonical names (full name / primary name). Do NOT merge synonyms — different spellings of the same person are different entities.
- Output MUST be strict JSON with this exact structure:
{
  "entities": [
    {"name": "string", "type": "person|project|concept|technology|organization", "attrs": [{"key": "string", "value": "string", "confidence": 0.9}]}
  ],
  "relations": [
    {"from": "entityName", "to": "entityName", "type": "uses|depends_on|part_of|related_to|affective_context"}
  ]
}

CONSTRAINTS:
- "type" must be one of: person, project, concept, technology, organization. If unsure, use "concept".
- Relation "type" must be one of: uses, depends_on, part_of, related_to, affective_context. If unsure, use related_to.
- affective_context is for an emotional state tied to a specific occasion (a person felt X on that day, about that thing). Never use it to declare a lasting trait of a person.
- "relations" from/to must reference entity names from the "entities" list.
- Maximum ${maxEntities} entities. Maximum ${maxAttrs} attributes per entity. Truncate if exceeded.
- Only include entity-related attributes. Ignore irrelevant miscellaneous details.
- Return ONLY the JSON object. No explanations, no markdown, no code fences.`;
}

function buildUserMessage(memoryText) {
  const truncated = memoryText.length > MAX_MEMORY_CHARS 
    ? memoryText.slice(0, MAX_MEMORY_CHARS) + "..." 
    : memoryText;
  return truncated;
}

function extractJsonFromText(text) {
  if (!text || typeof text !== "string") return null;
  
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }
  
  // Try to find first {...} block
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  
  return null;
}

function sanitizeType(type) {
  if (VALID_TYPES.has(type)) return type;
  return "concept";
}

function sanitizeConfidence(conf) {
  const num = Number(conf);
  if (Number.isNaN(num)) return 0.9;
  return Math.min(1, Math.max(0, num));
}

// #619：未知关系类型**不再静默降级成 related_to**。旧行为是「写入成功、不报错、
// 图上没有那条轴」——最难排查的一种失败：模型抽对了，库里却读不出它抽的是情感边
// 还是普通关联。现在返回 null，由调用方丢弃并 logger.warn 带原始类型名。
// 注意这与 sanitizeType（未知实体类型 → concept）刻意不同：实体类型是可容错的
// 粗分类，关系类型是语义轴本身，猜错一条边就是给图加错误事实。
function sanitizeRelationType(type) {
  if (typeof type !== "string") return null;
  const normalized = type.trim();
  if (VALID_RELATIONS.has(normalized)) return normalized;
  return null;
}

function sanitizeExtractedData(data, config, logger = null) {
  const maxEntities = config.entityExtractionMaxEntities ?? 10;
  const maxAttrs = config.entityExtractionMaxAttrs ?? 20;
  
  if (!data || !Array.isArray(data.entities)) {
    throw new Error("Invalid extraction: missing entities array");
  }
  
  const entities = [];
  const seenNames = new Set();
  
  for (const rawEntity of data.entities.slice(0, maxEntities)) {
    if (!rawEntity || typeof rawEntity.name !== "string" || !rawEntity.name.trim()) continue;
    
    const name = rawEntity.name.trim();
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    
    const attrs = [];
    if (Array.isArray(rawEntity.attrs)) {
      for (const rawAttr of rawEntity.attrs.slice(0, maxAttrs)) {
        if (!rawAttr || typeof rawAttr.key !== "string" || typeof rawAttr.value !== "string") continue;
        attrs.push({
          key: rawAttr.key.trim(),
          value: rawAttr.value.trim(),
          confidence: sanitizeConfidence(rawAttr.confidence)
        });
      }
    }
    
    entities.push({
      name,
      type: sanitizeType(rawEntity.type),
      attrs
    });
  }
  
  const relations = [];
  const rejectedRelationTypes = [];
  if (Array.isArray(data.relations)) {
    for (const rawRel of data.relations) {
      if (!rawRel || typeof rawRel.from !== "string" || typeof rawRel.to !== "string") continue;
      if (!seenNames.has(rawRel.from) || !seenNames.has(rawRel.to)) continue;
      const relationType = sanitizeRelationType(rawRel.type);
      if (!relationType) {
        // #619：不再降级成 related_to——记下原始类型名，交给调用方 warn。
        rejectedRelationTypes.push(String(rawRel.type));
        continue;
      }
      relations.push({
        from: rawRel.from,
        to: rawRel.to,
        type: relationType
      });
    }
  }
  if (rejectedRelationTypes.length > 0) {
    logger?.warn?.(
      `[extractor] dropped ${rejectedRelationTypes.length} relation(s) with unknown type(s): ${[...new Set(rejectedRelationTypes)].join(", ")}`
    );
  }

  return { entities, relations, rejectedRelationTypes };
}

async function resolveEntity(entity, store) {
  const existing = store.findEntityByName(entity.name);
  if (existing) {
    store.updateEntity(existing.id, {});
    return existing.id;
  }
  const created = store.createEntity({ name: entity.name, type: entity.type });
  return created.id;
}

export async function extractEntities(memory, { store, config, callLLM, logger }) {
  try {
    if (!memory || !memory.content) {
      return { ok: false, error: "Invalid memory: missing content" };
    }
    
    const systemPrompt = buildSystemPrompt(config);
    const userText = buildUserMessage(memory.content);

    const messages = [
      { role: "system", content: [{ type: "text", text: systemPrompt }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } },
      { role: "user", content: [{ type: "text", text: userText }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } }
    ];

    // Issue #109: optional provider/model override + reasoning effort are
    // passed through to callLLM's options; the index.js adapter maps them onto
    // the route (or falls back to the caller's default model). Empty provider/
    // model both mean "use the caller default".
    const options = {};
    if (config.entityExtractionProvider) options.provider = config.entityExtractionProvider;
    if (config.entityExtractionModel) options.model = config.entityExtractionModel;
    const reasoning = config.entityExtractionReasoning;
    if (reasoning && reasoning !== "none") options.reasoningEffort = reasoning;
    // #405: 审计行要能归因到具体记忆。extractor 只把 content 写进 prompt，id 这里顺
    // options 交给 index.js 的 adapter（route 映射只认 provider/model，多余键不会进
    // llm.stream）。拿不到 id 就不写这个键，adapter 侧照旧留空数组，不造虚账。
    if (memory.id) options.memoryId = memory.id;
    const llmResponse = await callLLM(messages, options);
    
    if (!llmResponse) {
      return { ok: false, error: "LLM returned empty response" };
    }
    
    const rawData = extractJsonFromText(llmResponse);
    if (!rawData) {
      return { ok: false, error: "Failed to parse JSON from LLM response" };
    }
    
    const { entities, relations, rejectedRelationTypes } = sanitizeExtractedData(rawData, config, logger);
    
    const resolvedEntities = [];
    const entityIdMap = new Map();
    let skipCount = 0;
    
    // Resolve entities
    for (const entity of entities) {
      try {
        const entityId = await resolveEntity(entity, store);
        entityIdMap.set(entity.name, entityId);
        resolvedEntities.push({ ...entity, entity_id: entityId });
      } catch (err) {
        skipCount++;
        logger?.warn?.(`[extractor] Failed to resolve entity "${entity.name}":`, err.message);
      }
    }
    
    // Record attributes
    const attrs = [];
    for (const entity of resolvedEntities) {
      for (const attr of entity.attrs) {
        try {
          const saved = store.saveAttr({
            entity_id: entity.entity_id,
            attr_key: attr.key,
            attr_value: String(attr.value),
            memory_id: memory.id,
            confidence: attr.confidence,
            source: "llm_extract"
          });
          attrs.push(saved);
        } catch (err) {
          skipCount++;
          logger?.warn?.(`[extractor] Failed to save attr "${attr.key}" for entity "${entity.name}":`, err.message);
        }
      }
    }
    
    // Record relations
    const savedRelations = [];
    for (const rel of relations) {
      const fromId = entityIdMap.get(rel.from);
      const toId = entityIdMap.get(rel.to);
      if (!fromId || !toId) continue;
      
      try {
        const saved = store.saveRelation({
          from_entity: fromId,
          to_entity: toId,
          relation_type: rel.type,
          memory_id: memory.id,
          metadata: { model: options.model || "default" },
          // issue #24 块2：LLM 抽取自动建边 → llm 来源（初值 0.4），区别于
          // 人工/确认的满权边。来源进 metadata 之上的独立列，演化与审计可辨。
          source: "llm"
        });
        savedRelations.push(saved);
      } catch (err) {
        skipCount++;
        logger?.warn?.(`[extractor] Failed to save relation "${rel.from} -> ${rel.to}":`, err.message);
      }
    }
    
    return {
      ok: true,
      entities: resolvedEntities,
      attrs,
      relations: savedRelations,
      // #619：被丢弃的未知关系类型（含原始名字）。调用方据此判断「模型没抽」
      // 与「抽了但类型不认识」——两者的运维动作完全不同。
      rejectedRelationTypes,
      skipped: skipCount
    };
    
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
