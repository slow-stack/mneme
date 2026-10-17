# 人格 v1.2 · 实现报告（feat/persona-multi 车道）

日期：2026-10-17 · 基线 origin/main @ b4aff2c9（v1 已合并）· 触发：桉桉实测 v1 后提出多人格 + 字段不可见 + 保存静默失败三问题

## 与 v1 的差异清单

| 项 | v1 | v1.2 |
|---|---|---|
| 存储 | persona 键 = 单对象 | `{ default, byAgent }` 多卡形；**旧单对象读作 default，零迁移** |
| 注入 | 固定用唯一卡 | 按会话身份（session.header.agentPreset，scope.js 同源读法避 requestHeader 遮蔽坑）寻址 byAgent 卡；身份缺失/无卡/**卡 enabled=false** 一律落 default |
| API | GET 回单对象 | GET 回多卡形；PUT 双形——单对象形=合并 default 保 byAgent（旧前端兼容），多卡形=全量替换 |
| 面板 | 一张卡，字段仅 aria-label | 多卡列表（添加/切换/删除，default 不可删）+ **可见字段标签**（名字/性格设定/回复要求，mneme-featnumlabel 元素）+ **保存失败可见错误行**（修复 v1 静默 catch 吞 404——桉桉实测踩中） |
| 兜底行为 | — | 身份卡 enabled=false → 落 default（不注入半张卡），单测锁定 |

## 测试

- persona-settings 12（+6 多卡）、persona-inject 10（+4 寻址）、persona-api 6（+1 双形 PUT）、client 76（+1 多卡回归锁）
- 全量 `npm test`：**1903 pass / 0 fail / 1 skipped**（runtime-adopt symlink，环境性）
- check-sync 62 文件平价 ✓

## 设计决定

1. **卡 enabled=false 落 default 而非不注入**：半张卡（关了开关的身份卡）若直接不注入，会出现「这个 bot 突然没人格」的断层；落 default 保证每个会话恒有卡。
2. **身份解析只认 session.header.agentPreset**（冻结头）：与 scope 隔离同源，一次会话一个稳定身份；取不到 = 无身份 = default，老宿主行为与 v1 逐字节一致。
3. **保存失败不再静默**：personaError 渲染 4 秒可见错误（HTTP 状态码带上），v1 的教训直接写进回归锁。
4. **多卡形 PUT 全量替换 + 单对象形合并**：旧面板/旧调用方不会误删 byAgent 卡。

## 未做（有意）

- v1.5 协作式人格（提取→草稿→审批）不变，provenance 仍只预留。
- byAgent 卡与 scope 隔离（strictScope）的联动验证留给实测：人格寻址按 agentPreset，记忆 scope 按 agent_scope，两者键同源（同一 header）天然对齐，但未加联动测试。
