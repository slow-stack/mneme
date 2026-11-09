# 实体结构化记忆（Entity Gene，v0.3.0）

> dsh-mneme 的**记忆基因**层：从记忆文本里抽取**命名实体**、**带时间轴的属性**、**实体间关系**，并支持按实体/属性精确召回记忆。与 autoDream 联动——update 记录 supersedes、merge 迁移属性归属。

v0.3.0 四个阶段全部落地：

| 阶段 | 内容 |
|------|------|
| P1 | 三表 Schema（entities / entity_attrs / entity_relations）+ 索引 + store CRUD |
| P2 | LLM 抽取器（JSON 抽取 + resolveEntity 去重 + saveAttr 时间轴 + saveRelation + fail-safe） |
| P3 | 前缀搜索（`entity:` / `attr:`），attr 精确 = 1.0 > keyword 提及 = 0.7 |
| P4 | autoDream 联动（applyUpdate 写 supersedes 自引用；applyMerge 迁移 loser attrs） |

存储层（建表 + CRUD）**始终可用**，不依赖任何 LLM；只有 `entityExtractionEnabled=true` 时流水线才会自动抽取。

---

## 一、三表结构

所有建表语句在 `src/store.js` 的 `SCHEMA` 中，`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`，对旧库幂等。

### `entities` — 命名实体

```sql
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,            -- 规范化名称（全名/主名）
  type TEXT,                     -- person|project|concept|technology|organization
  first_seen TEXT NOT NULL,      -- 首次出现时间
  last_seen TEXT NOT NULL,       -- 最近出现时间
  mention_count INTEGER DEFAULT 1, -- 提及次数（同名去重后递增）
  canonical_memory_id TEXT       -- 规范来源记忆（保留位）
);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
```

### `entity_attrs` — 属性（快照式时间轴）

```sql
CREATE TABLE IF NOT EXISTS entity_attrs (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  attr_key TEXT NOT NULL,
  attr_value TEXT NOT NULL,
  memory_id TEXT,                -- 属性出处记忆
  valid_from TEXT NOT NULL,
  valid_until TEXT,              -- NULL = 当前有效
  confidence REAL DEFAULT 1.0,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_attrs_entity ON entity_attrs(entity_id);
CREATE INDEX IF NOT EXISTS idx_attrs_key    ON entity_attrs(attr_key);
CREATE INDEX IF NOT EXISTS idx_attrs_valid  ON entity_attrs(valid_from, valid_until);
CREATE INDEX IF NOT EXISTS idx_attrs_memory ON entity_attrs(memory_id);
```

### `entity_relations` — 关系（追加式）

```sql
CREATE TABLE IF NOT EXISTS entity_relations (
  id TEXT PRIMARY KEY,
  from_entity TEXT NOT NULL,
  to_entity TEXT NOT NULL,
  relation_type TEXT NOT NULL,   -- uses|depends_on|part_of|related_to|supersedes|affective_context
  memory_id TEXT,
  created_at TEXT NOT NULL,
  metadata TEXT                  -- JSON 自由字段
);
CREATE INDEX IF NOT EXISTS idx_relations_from ON entity_relations(from_entity);
CREATE INDEX IF NOT EXISTS idx_relations_to   ON entity_relations(to_entity);
CREATE INDEX IF NOT EXISTS idx_relations_type ON entity_relations(relation_type);
```

---

## 二、valid_until 时间轴机制

属性采用**快照式**写入：同一 `entity_id + attr_key` 只允许**一行当前有效**（`valid_until IS NULL`）。

```
saveAttr(entity=X, key=role, value="前端工程师")
  → 先把 X/role 的现有有效行 valid_until 置为 now（invalidateOldAttr）
  → 再插入新行 valid_from=now, valid_until=NULL
```

读取语义：

- `getCurrentAttrs(entityId)` — 只返回有效行（`valid_until IS NULL`），即"当前值"
- `getAttrHistory(entityId)` — 按 valid_from 升序返回全部历史行（含已失效），用于追溯演变
- `findMemoriesByAttr(key, value)` — 返回携带该属性**当前有效**行的记忆（去重）
  - **value 非空**：精确匹配 `attr_value`
  - **value 为空 / undefined / null**：返回该 `attr_key` 的全部当前有效记忆（"`attr:key` 无 `=value`"契约）

> ⚠️ 迁移时注意：同一 entity+key 连存两次会**失效前一行**（快照语义）。要保留多条同 key 的当前值，应把它们挂到**不同实体**上。

---

## 三、Store CRUD

`createStore` 暴露以下实体 API（`src/store.js`）：

| 方法 | 说明 |
|------|------|
| `createEntity({ name, type })` | 建实体，`first_seen=last_seen=now`，`mention_count=1` |
| `findEntityByName(name)` | 按规范化名称查（去重锚点） |
| `findEntityById(id)` | 按 id 查 |
| `updateEntity(id, patch)` | 部分更新；默认 `mention_count+1`、刷新 `last_seen`；可用 `patch.mention_count` 显式覆盖 |
| `saveAttr({ entity_id, attr_key, attr_value, memory_id, confidence, source })` | 写属性（先失效旧行） |
| `invalidateOldAttr(entityId, attrKey, now)` | 手动失效；返回受影响行数 |
| `getCurrentAttrs(entityId)` | 当前有效属性列表 |
| `getAttrHistory(entityId)` | 全部属性历史（最旧在前） |
| `getAttrsByMemory(memoryId)` | 某记忆关联的全部属性（autoDream update 用） |
| `findMemoriesByAttr(key, value)` | 按属性召回记忆（value 空 = 该 key 全部当前有效） |
| `saveRelation({ from_entity, to_entity, relation_type, memory_id, metadata })` | 追加关系 |
| `getRelations(entityId)` | 某实体任一侧（from/to）的关系 |
| `migrateAttrsToMemory(fromId, toId, now)` | 把 from 记忆的属性 memory_id 改指 to（keeper 已有同 entity+key 当前行则失效）；返回 `{ migrated, invalidated }` |

---

## 四、LLM 抽取器

`src/entities/extractor.js` → `extractEntities(memory, { store, config, callLLM })`。

### 触发方式

`service.saveWithDedupe` 在 **created** 后 fire-and-forget 触发，仅当：

1. `config.entityExtractionEnabled === true`
2. service 已通过 `service.setEntityExtractor(...)` 注入抽取钩子（`index.js` 在插件启动时接好）

抽取**异步执行**、失败绝不阻塞记忆写入（fail-safe）。

### LLM JSON 契约

```
{
  "entities": [
    {"name": "string", "type": "person|project|concept|technology|organization",
     "attrs": [{"key": "string", "value": "string", "confidence": 0.9}]}
  ],
  "relations": [
    {"from": "entityName", "to": "entityName", "type": "uses|depends_on|part_of|related_to|affective_context"}
  ]
}
```

抽取管线：

1. `buildSystemPrompt` — 约束上限（`entityExtractionMaxEntities` / `entityExtractionMaxAttrs`）、禁编造、用规范化名
2. `extractJsonFromText` — 先直接 `JSON.parse`，失败再抓首个 `{...}` 块
3. `sanitizeExtractedData` — 非法 type → `concept`；**非法 relation type → 拒收**（#619：不再静默降级成 `related_to`，丢弃的类型名进返回值 `rejectedRelationTypes` 并 `logger.warn`，让"模型抽了但类型不认识"在审计里看得见）；非法 confidence → 0.9；超限截断；relations 的 from/to 必须引用实体清单
4. `resolveEntity` — **同名去重**：`findEntityByName` 命中 → `updateEntity(id, {})`（`mention_count+1`），未命中 → 建新实体
5. 逐条 `saveAttr`（挂 `memory_id` + `source: "llm_extract"`）→ 逐条 `saveRelation`
6. 单实体/属性/关系失败只 `skipCount++` 并告警，不中断整批

### 返回 / fail-safe

```js
{ ok: true, entities: [{ name, type, attrs, entity_id }], attrs: [...], relations: [...], skipped: n, rejectedRelationTypes: [...] }
{ ok: false, error: "..." }
```

- 缺失 content、LLM 返回空、JSON 解析失败、sanitize 抛错、`callLLM` reject → 一律 `{ ok: false }`，**绝不向上抛异常**
- `entityExtractionEnabled=false` 时钩子完全不触发，存储层照常可用

---

## 五、搜索：`entity:` / `attr:` 前缀

`service.searchMemories` 在 `config.entitySearchEnabled === true`（默认 true）时识别前缀路由：

```
entity:阿尔托        → searchByEntity("阿尔托")
attr:国籍=芬兰       → searchByAttr("国籍", "芬兰")   精确匹配
attr:国籍           → searchByAttr("国籍", undefined) 该 key 全部当前有效
```

### searchByEntity 排序

**合并优先级：attr 精确关联 = 1.0 > 关键词提及 = 0.7**，attr 命中不覆盖、keyword 只补充召回，最终按 `_score` 降序取 topK：

| 来源 | 分数 |
|------|------|
| `entity_attrs.memory_id` 精确关联（当前有效） | `_score = 1.0`，`_source = "entity_attr"` |
| 标题/内容/标签含实体名 | `_score = 0.7`，`_source = "keyword"` |

`entitySearchEnabled=false` 时前缀不做路由，按普通关键词搜索（`entity:xxx` 字面串极少命中 → 通常返回空）。

---

## 六、autoDream 联动

`applyDecisions` 在 `config.entityExtractionEnabled === true` 时启用实体副作用，**仅记录、绝不阻断主流程**：

- **applyUpdate（supersedes）**：事务提交成功后，为该记忆关联的每条实体属性建立**自引用** supersedes 关系，表示"此属性版本已被替代"：

  ```js
  saveRelation({ from_entity: attr.entity_id, to_entity: attr.entity_id,
                 relation_type: "supersedes", memory_id: id,
                 metadata: { attr_key, old_value } })
  ```

- **applyMerge（属性迁移）**：将 loser 记忆关联的 `entity_attrs.memory_id` 迁移到 keeper；若 keeper 已有同 `entity+key` 的当前有效属性，则 loser 行被**失效**（keeper 值优先）：

  ```
  { migrated, invalidated } = store.migrateAttrsToMemory(loserId, keeperId, now)
  ```

- `entityExtractionEnabled=false` 时两条副作用**完全跳过**（update/merge 本身照常生效）。

---

## 七、配置项

| 键 | 默认值 | 说明 |
|----|--------|------|
| `entityExtractionEnabled` | `false` | 实体抽取总开关（默认关；存储层恒可用） |
| `entityExtractionModel` | `""` | 抽取专用模型（空 = 用 agent 默认模型） |
| `entityExtractionMaxEntities` | `10` | 每次抽取实体数上限 |
| `entityExtractionMaxAttrs` | `20` | 每实体属性数上限 |
| `entitySearchEnabled` | `true` | `entity:` / `attr:` 前缀搜索开关 |

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: dsh-mneme
  config:
    entityExtractionEnabled: true
    entityExtractionModel: deepseek-chat   # 可选，默认用 agent 默认模型
    entitySearchEnabled: true
```

---

## 八、迁移说明

- 实体三表在 `createStore` 的 `SCHEMA` 中 `CREATE TABLE IF NOT EXISTS` 创建，**旧库打开自动建表**，幂等（重复打开/重启无副作用，`test/entities.test.js` 有覆盖）。
- 无需人工迁移数据；现有 `memories` 表不变，实体表是**旁挂**结构。
- 抽取开启后，新写入的记忆自动补实体；存量记忆可通过触发抽取或后续 backfill 补全（v0.3.0 未内置存量回扫）。

---

## 测试

`test/entities.test.js`（31 条，node:test）：Schema 三表 + 索引 + 旧库幂等迁移 / 实体 CRUD / 属性时间轴（saveAttr 失效旧行、getCurrentAttrs / getAttrHistory）/ `findMemoriesByAttr`（精确匹配 + **空 value 契约** + 过期行排除）/ 抽取器（mock LLM 写入、同名去重、垃圾 JSON / LLM 故障 fail-safe、开关触发）/ 前缀搜索（1.0 > 0.7 排序、attr 精确、attr 空值、开关关闭不路由）/ autoDream（supersedes、merge 迁移与失效、开关关闭跳过）/ fail-safe（抽取失败不阻塞写入）。
