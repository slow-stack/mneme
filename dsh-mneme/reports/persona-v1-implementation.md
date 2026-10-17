# 人格定义页 v1 · 实现报告（feat/persona-page 车道）

日期：2026-10-17 · 设计稿：reports/persona-page-design.md（六项推荐已由桉桉拍板）· 基线 origin/main @ 5238f23（v0.8.16）

## 与设计稿逐条对照

| 设计稿节 | 落地 | 偏差 |
|---|---|---|
| ① 数据模型 | settings.js：`PERSONA_FIELDS` 白名单（name/personality/replyStyle/enabled/provenance）+ `parsePersona` 容错（坏 JSON/非对象回 {}）+ `getPersona`/`setPersona`（写侧挑拣未知字段丢弃） | 无。provenance 为 v1.5 预留、v1 不写管道 |
| ② API 面 | api.js `/api/dsh-mneme/persona`（GET 开放、PUT/POST requireAuth）；api-standalone.js GET/PUT `/persona`（全局 Bearer 闸门下） | 小：internal 面坏 JSON 体**不清空库值、原样回显**（parseBody 容错回 {} 是仓内既有口径，加 jsonOk 守卫防误清）；standalone 面坏体仍 400 invalid-json。设计稿原话「坏体回 4xx/500 不落库」在「不落库」上两面对齐，「回 4xx」仅在 standalone 面成立——属对既有约定的顺从 |
| ③ 注入点 | inject.js `renderUserSettings` 扩展：双闸门（config.personaEnabled && persona.enabled）开时人格段前置（人格→画像→规则），`escapePromptVars` 覆盖 | 无。关闸时输出与历史版本逐字节一致（测试锁定） |
| ④ feature flag | config.js schema `personaEnabled: z.boolean().default(false)` + settings.js 白名单追加 + api.test.js effective 计数锁 +1 与默认值断言；不进 LIGHT_MODE_OFF | 无。client.js FEATURE_GROUPS group.enhance 追加（非独立组——它是行为开关不是座位闸门，与 M.O. 的 group.mo 区分） |
| ⑤ 面板 | client.js：人格卡（名字/性格/回复要求 + 卡内开关即改即存）、画像只读卡（注入生效文本，零后端新请求）、i18n 中英各 14 键 | 无 |
| ⑥ 冲突权威 | 渲染顺序人格段→profile→rules；rules 恒最硬 | 无 |
| ⑨ 分层纪律 | v1 只动 L-身份层（user_settings 的 persona 键）；记忆层与画像/规则层代码零改动 | 无 |

## 测试

- 新增四件：persona-settings（6）、persona-api（5）、persona-flag（3）、persona-inject（6）+ client.test.js 人格卡回归锁（1）
- 全量 `npm test`：**1891 pass / 0 fail / 1 skipped**（skip 为环境性用例，与本改动无关）
- `npm run sync` + check-sync：62 文件平价 ✓（client.js lib-only kept）

## 关键实现决定（评审提示）

1. **双闸门语义**：`persona.enabled`（卡内开关）与 `config.personaEnabled`（面板总闸）串联判，任一关即逐字节等于现状。总闸 hint 明写「同时打开才生效」。
2. **卡内开关即改即存**：toggle onChange 直接 PUT，与 profile 卡「点保存」节奏不同——开关型操作即时反馈是面板既有惯例（功能开关组同款）。
3. **api.test.js 计数锁 +1**：AGENTS.md 自查清单第 2 条（新配置键 schema 与白名单成对 + 旗标计数锁同步）。
4. **standalone PUT 的坏体 400**：与 /memories 写路径同口径（invalid-json），internal 面因 parseBody 容错而走「保值回显」——两面的差异写在路由注释里。

## 未做（有意）

- push / PR：等桉桉拍板（目标 irreversible 声明）。
- provenance 写入管道、byAgent 多人格、草稿卡：v1.5（设计稿⑧）。
- AGENTS.md 模块地图未改：persona 是既有模块内的键与路由，无新文件、无新功能面。
