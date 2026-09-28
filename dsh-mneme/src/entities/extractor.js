const VALID_TYPES = new Set(["person", "project", "concept", "technology", "organization"]);
const VALID_RELATIONS = new Set(["uses", "depends_on", "part_of", "related_to"]);
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
    {"from": "entityName", "to": "entityName", "type": "uses|depends_on|part_of|related_to"}
  ]
}

CONSTRAINTS:
- "type" must be one of: person, project, concept, technology, organization. If unsure, use "concept".
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

function sanitizeRelationType(type) {
  if (VALID_RELATIONS.has(type)) return type;
  return "related_to";
}

function sanitizeExtractedData(data, config) {
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
  if (Array.isArray(data.relations)) {
    for (const rawRel of data.relations) {
      if (!rawRel || typeof rawRel.from !== "string" || typeof rawRel.to !== "string") continue;
      if (!seenNames.has(rawRel.from) || !seenNames.has(rawRel.to)) continue;
      relations.push({
        from: rawRel.from,
        to: rawRel.to,
        type: sanitizeRelationType(rawRel.type)
      });
    }
  }
  
  return { entities, relations };
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
    const llmResponse = await callLLM(messages, options);
    
    if (!llmResponse) {
      return { ok: false, error: "LLM returned empty response" };
    }
    
    const rawData = extractJsonFromText(llmResponse);
    if (!rawData) {
      return { ok: false, error: "Failed to parse JSON from LLM response" };
    }
    
    const { entities, relations } = sanitizeExtractedData(rawData, config);
    
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
          metadata: { model: options.model || "default" }
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
      skipped: skipCount
    };
    
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
