# Security Policy

> **English** | [中文](#安全策略)

---

## Supported Versions

We actively maintain the latest minor version. Security fixes are backported to the latest patch release, and critical fixes may be backported to the previous minor version.

| Version | Supported | Status |
|---|---|---|
| 0.8.x | ✅ Yes | Active development |
| 0.7.x | ⚠️ Best-effort | Critical fixes only |
| < 0.7.0 | ❌ No | Please upgrade to 0.8.x |

**End-of-life notice**: 0.7.x is in best-effort maintenance (critical fixes only). Its end-of-life date will be announced in advance; after that date no security fixes will be provided for 0.7.x. Security support for 0.6.x and below ended with the 0.8.1 release — please upgrade to 0.8.x.

---

## Known Security Features

The following security features are implemented and maintained in the project:

| Feature | Description | Status |
|---|---|---|
| `apiToken` Authentication | When a token is configured, **write** routes plus the sensitive reads (`/export`, `/external-api`, `/vector-config`, `/maintenance/*`) require `Authorization: Bearer <apiToken>`; comparison uses `crypto.timingSafeEqual`. Plain reads stay open by design — see [Security Model](#5-security-model-what-actually-protects-what) | ✅ Implemented |
| `policyEpoch` Memory Governance | Bumping `policyEpoch` downgrades all prior `dream_runs` to historical evidence; their receipts no longer drive real-time memory decisions | ✅ Implemented |
| `conflictFreezeEnabled` Conflict Freeze | Conflicting memories are not auto-merged; they are flagged as pending human review, preserving data integrity | ✅ Implemented |
| CAS (Compare-and-Swap) Guard | Prevents concurrent write conflicts; ensures atomic write operations | ✅ Implemented |
| Digest Baseline Audit | Memory updates are compared against digest baselines to detect unauthorized changes | ✅ Implemented |
| `failure_memories` Audit Trail | Every failed write operation is logged for forensic analysis | ✅ Implemented |
| `recall_run` Search Audit | Every search operation is recorded with timestamp and query metadata | ✅ Implemented |
| Local-First Data Processing | Local by default; **not** zero-network: with an OpenAI-compatible embedder (`embedProvider`, default `openai`) memory text is POSTed to the configured endpoint, and consolidation/summarization send text to the host LLM. Local model downloads (runtime) and the npm registry version check are the only other outbound calls | ⚠️ Conditional |
| No Telemetry | No analytics and no remote logging of memories; the plugin does make the outbound calls listed above (version check, model download, configured embedder/LLM) | ✅ Implemented (no telemetry) |
| Query Sanitization | LIKE-query escaping, **bounded paging** (`limit` ≤ 1000, `topK` ≤ 200, request body ≤ 4 MiB), and Markdown mirror escaping prevent injection, memory amplification and malformed input | ✅ Implemented |
| `entityExtractionEnabled` Opt-In Entity Extraction | Entity extraction is opt-in via configuration (default: off), minimizing data processing by default | ✅ Implemented |
| Graceful Degradation | System falls back to keyword search on component failure; no crash | ✅ Implemented |
| Human-Editable Mirrors | All memories mirrored to Markdown files; users can verify and reconstruct data | ✅ Implemented |
| Mirror Generation CAS/Fence | Mirror sync is bound to a monotonic `generation` counter with CAS/fence semantics; stale or concurrent mirror writes are rejected | ✅ Implemented |
| Crash-Recovery Debt Model | Business writes atomically bump `desired generation` in the same transaction; after a crash, `recoverMirror` replays the debt instead of silently skipping repairs | ✅ Implemented |
| `/health` Auth-Gated Endpoint | Health endpoint requires `apiToken`; error codes are sanitized (no-space / permission / sync-failed) and read failures fail closed as `unknown` | ✅ Implemented |
| Fail-Closed Input Validation | Generation counters and hot-memory parameters are validated (`Number.isInteger`, finite, non-negative) with SQL `CHECK` constraints; invalid input falls back to safe defaults or is rejected | ✅ Implemented |
| Hybrid Score Clamping | Hybrid fusion scores are clamped to [0, 1] to prevent vector + BM25 stacking from breaking normalization bounds | ✅ Implemented |
| Standalone External API (v0.7.12, opt-in) | Optional per-plugin HTTP server for ecosystem integrations, bound to `127.0.0.1` by default with an auto-generated persistent Bearer token (`timingSafeEqual` verified); `/health` is the only unauthenticated route; binding a non-loopback host is an explicit operator decision | Implemented |
| Tag Sanitization | Tag normalization reuses the sanitizer; `autoTag` skips forgotten memories; `setMemoryTags` runs inside a SAVEPOINT for atomic rollback | ✅ Implemented |

### Standalone External API (v0.7.12)

Since v0.7.12 the plugin can optionally start its own HTTP server (`externalApiEnabled`, default **off**) so other plugins, CLIs, and desktop tools can read and write memories without going through the DSH host port.

- **Loopback by default**: the server binds `127.0.0.1:8790` (`externalApiHost` / `externalApiPort`, or persisted panel settings). Rebinding to a non-loopback address exposes the store to your network and is an explicit operator decision.
- **Token authentication**: every route except `GET /health` requires `Authorization: Bearer <token>`; the token is auto-generated on first use, persisted in the plugin settings store and verified with `timingSafeEqual`. To rotate it, clear the persisted value (settings kv key `external_api`) and let the next boot mint a new one — there is no rotate endpoint yet.
- **Surface**: memories read/write (`GET/POST /memories`, `GET/PUT/DELETE /memories/:id`, `GET /search`, `GET /context`, `GET /status`), plus profile/rules **reads** (`GET /profile`, `GET /rules`), `POST /bootstrap` and the reclaim routes (`GET/POST /maintenance/reclaim`). Writes go through the same dedupe + quality-filter path as in-conversation saves. The full route list lives in [docs/DAEMON.md](docs/DAEMON.md).
- **CLI**: `bin/cli.mjs` is a thin client over this API and stores its credentials in `~/.dsh-mneme/cli.json` - treat that file like any credential file.

---

## Reporting a Vulnerability

### Please DO NOT

- Open a public issue for security vulnerabilities
- Post exploit details in discussions or comments
- Submit PRs that expose security flaws without prior coordination

### Please DO

1. **Email** `work@modusensus.space` (or open a **private security advisory** via [GitHub Security Advisories](https://github.com/slow-stack/mneme/security/advisories))
2. Include:
   - A clear description of the vulnerability
   - Steps to reproduce (minimal test case preferred)
   - Impact assessment (data exposure? local-only? remote?)
   - Affected versions
   - Your proposed fix (if any)
   - Whether you are requesting credit / disclosure preferences

### Scope and Out of Scope

**In scope** — issues this policy covers:
- Remote API authentication or authorization bypass (`apiToken`-protected surfaces)
- Memory integrity violations (CAS/fence bypass, unauthorized overwrite, replay paths)
- Mirror consistency and recovery logic that can cause silent data corruption
- Exploitable vulnerabilities in shipped runtime dependencies (supported versions only)

**Out of scope** — we will not act on:
- Social engineering or phishing against maintainers or users
- DoS claims that require unrealistic local resource exhaustion with no product defect
- Vulnerabilities present only in unsupported versions (`< 0.7.0`)
- Best-practice hardening suggestions with no demonstrable security impact

Not sure whether your finding is in scope? Report it anyway via the private channel — we will triage and respond.

### Response Timeline

| Phase | Time | Action |
|---|---|---|
| Acknowledgment | Within 48 hours | We confirm receipt and assign a tracking ID |
| Initial Assessment | Within 7 days | We validate severity and scope; we may request additional information |
| Fix Development | Severity-dependent | Critical: ≤ 14 days; High: ≤ 30 days; Medium/Low: next release |
| Validation & Testing | 1–3 days after fix | We run regression and security tests on the patch |
| Coordinated Disclosure | At fix release | We publish a security advisory and release patch simultaneously |

**Note**: For Critical vulnerabilities, if a full fix cannot be developed within 14 days, we will provide a temporary mitigation or workaround within that timeframe.

### Escalation (If You Do Not Hear Back)

- If you do not receive an acknowledgment within **48 hours**, re-send to `work@modusensus.space` with subject prefix: `[SECURITY][FOLLOW-UP]`.
- If there is still no response after another **48 hours**, open a **private security advisory** via [GitHub Security Advisories](https://github.com/slow-stack/mneme/security/advisories) and reference your original report timestamp.
- Do not disclose details publicly while escalation is in progress.

### Severity Classification

We follow the [CVSS v3.1](https://www.first.org/cvss/v3.1/specification-document) standard:

- **Critical** (9.0–10.0): Remote code execution, unauthorized data exfiltration, bypass of core security controls
- **High** (7.0–8.9): Local privilege escalation, significant data integrity compromise, DoS with high impact
- **Medium** (4.0–6.9): Information disclosure under specific conditions, partial bypass of controls
- **Low** (0.1–3.9): Minor information leakage, defense-in-depth improvements

---

## Security Design Principles

### 1. Local-First (not zero-network)

- Storage, keyword/BM25 search, mirroring and the injection pipeline are entirely local
- Embeddings and consolidation **run locally only when configured to**: `embedProvider` defaults to `openai`, which POSTs memory text to the endpoint you configure; `autoDream` / `autoSummarize` send text through the host LLM. Set `embedProvider: local` (plus the local runtime) if text must not leave the machine
- Other outbound calls: the npm registry version check, and local model downloads when the runtime is provisioned
- No telemetry, no analytics, no remote logging of memory content

### 2. Fail-Safe by Default

- Any component failure (LLM, embedder, reranker) degrades gracefully to keyword search
- Malformed input never crashes the plugin or corrupts the database
- Concurrent write conflicts are resolved via CAS (compare-and-swap) guards

### 3. Audit Everything

- Every `autoDream` run generates a cryptographically verifiable receipt
- Every memory update creates a `failure_memories` audit trail
- Every search records a `recall_run` for later inspection

### 4. Human Sovereignty

- All memories are mirrored to human-editable Markdown files
- Machine writes vs. human edits are distinguished via digest baselines
- Users can fully reconstruct the database from Markdown mirrors alone

### 5. Security Model: What Actually Protects What

The token is a lock on the **write** surface, not a wall around the whole API.

- **The real boundary is loopback + the DSH host listener.** The host-side routes (`/api/dsh-mneme/*`) are mounted on the DSH port, which binds `127.0.0.1` and is fenced by the host against DNS rebinding and cross-site browser requests. That fence does **not** establish identity: any local process, and any page running in the host's own origin, is inside the perimeter.
- **Authentication is opt-in and fail-open.** `apiToken` defaults to empty; while it is empty, `isAuthorized()` returns true for every request — reads *and* writes. Setting a token gates the write routes and the sensitive reads; it does not gate plain reads.
- **Open reads (no token even when one is configured)**: `GET /`, `/info`, `/version-check`, `/list`, `/recall-stats`, `/search`, `/semantic`, `/semantic/llm-audit`, `/semantic/llm-audit/stats`, `/semantic/graph/*`, `/entities`, `/memories/entities`, `/dream-status`, `/inject-status`, `/inject-preview`, `/pipeline`, `/candidates`, `/llm-providers`, plus the `GET` branches of `/profile`, `/rules`, `/features`, `/mode`, `/commands`. Treat them as readable by anything local.
- **Gated routes (when a token is configured)**: all writes (`/create`, `/update`, `/delete`, `/import`, `/mode`, `/features`, `/commands`, `/conflicts/resolve`, `PUT /profile`, `PUT /rules`, `/vector-config`, `/vector-reindex`, `/runtime/provision`, `/maintenance/reclaim`, `/test-model`, `/health`) and the sensitive reads `/export` and `/external-api`.
- **The standalone data plane** (`127.0.0.1:8790`) is the opposite shape: every route except `GET /health` requires its own Bearer token. Pointing `externalApiHost` at a non-loopback address therefore turns it into a plaintext, token-only HTTP surface — an explicit operator decision.
- **Consequence**: if you expose the plugin beyond loopback (reverse proxy, non-loopback bind), set `apiToken` *and* check that the plain reads above are acceptable to expose — they are not covered by it.
- **How this list stays true**: every route declares its own `policy` (`open` / `token` / `token-write`) at registration, and `createRouteRegistrar` throws when a route has none or reuses a path. A new route that forgets its classification **fails to boot** instead of silently opening — the matrix above is derived from code, not from anyone's memory.

---

## Dependency Vulnerability Handling

### Process

We follow a 5-step process for handling third-party dependency vulnerabilities:

| Step | Action | Timeframe | Tooling |
|---|---|---|---|
| 1. Scan | Continuous automated scanning of all runtime and development dependencies | Automated (daily) | OrbisAI Security, npm audit |
| 2. Assess | For each detected vulnerability, assess severity, exploitability, and impact on dsh-mneme | Within 48 hours of detection | CVSS v3.1, manual code analysis |
| 3. Report | Document findings in the security tracker; report to maintainers | Immediately after assessment | Security tracker, maintainer channel |
| 4. Fix | Upgrade dependency to a patched version or apply mitigation | Critical: ≤ 14 days; High: ≤ 30 days; Medium/Low: next release | npm/pnpm update, manual patching |
| 5. Disclose | Publish security advisory with details and fixed version | At release of fixed version | GitHub Security Advisories + npm release notes |

### Third-Party Dependency Policy

- All new runtime dependencies must pass a security review before inclusion
- Dependencies with known critical vulnerabilities that cannot be fixed within the timeline will be replaced with alternatives
- Dependency lockfiles (`package-lock.json`) are committed and reviewed in PRs

### Recent Dependency Fixes

| CVE | Package | Version (Before) | Version (After) | Severity | Fixed In |
|---|---|---|---|---|---|
| CVE-2026-39244 | `adm-zip` | 0.5.18 | 0.6.0 | High | v0.3.4 |

---

## Security Audit History

### v0.2.10 — Security Hardening

| ID | Finding | Severity | Status |
|---|---|---|---|
| F-NEW-01 | Concurrent write race on `store.js` | **Critical** | ✅ Fixed (CAS guard + atomic write) |
| F-NEW-02 | Transactional inconsistency during mirror sync | **High** | ✅ Fixed (transactional mirror + rollback) |
| F-NEW-03 | Mirror health state not validated before overwrite | **High** | ✅ Fixed (digest baseline + FSM validation) |

### v0.3.4 — Dependency Security

| CVE | Package | Severity | Status |
|---|---|---|---|
| CVE-2026-39244 | `adm-zip` 0.5.18 | **High** | ✅ Fixed (upgraded to 0.6.0) |

### v0.3.6 — Mirror Debt Modeling (audit peer re-verification)

| Finding | Severity | Status |
|---|---|---|
| Mirror sync not bound to a generation counter (stale overwrite window) | **High** | ✅ Fixed (generation + CAS/fence semantics, per-type status) |
| `/health` endpoint unauthenticated with verbose error codes | **High** | ✅ Fixed (auth-gated, sanitized codes, fail-closed `unknown`) |
| COMMIT-crash window could permanently skip mirror repairs | **High** | ✅ Fixed (recoverMirror triggers on dirty OR generation > applied) |

### v0.3.8 — Mirror Sync Reliability (peer 6 blockers)

| Finding | Severity | Status |
|---|---|---|
| Silent mirror sync failures (no error surfaced to write path) | **High** | ✅ Fixed (`syncMirror` returns `{success, error}`; `afterSync` check on write entry) |
| Non-atomic generation increments under multi-process concurrency | **High** | ✅ Fixed (`UPDATE ... RETURNING` atomic statement + `PRAGMA busy_timeout=5000`) |
| Generation counter overflow / negative values | **Medium** | ✅ Fixed (JS validation + SQL `CHECK(0..MAX_SAFE_INTEGER)`) |

### v0.3.9 — Audit A/B/D/F

| Finding | Severity | Status |
|---|---|---|
| CAS update and generation increment not in the same transaction | **High** | ✅ Fixed (atomic `runAtomically`; miss does not increment) |
| Failed updates could report success | **High** | ✅ Fixed (degraded/pending receipts with mirror attributes) |
| Generation validation not fail-closed | **Medium** | ✅ Fixed (`Number.isInteger` fail-closed + migration detects stale dirty values) |

### v0.5.1 — Hot Memory Parameter Defense

| Finding | Severity | Status |
|---|---|---|
| Negative / non-finite `maxRounds`/`maxTokens` could trigger a synchronous infinite loop via public API | **High** | ✅ Fixed (fallback to safe defaults 5/2000) |
| Hybrid fusion score could exceed 1.0 (vector + BM25 stacking) | **Medium** | ✅ Fixed (clamp to [0, 1]) |

### v0.6.5 — Tag System Hardening

| Finding | Severity | Status |
|---|---|---|
| `autoTag` could tag forgotten memories | **Medium** | ✅ Fixed (filter `forgotten` before tagging) |
| Tag normalization bypassed the sanitizer | **Medium** | ✅ Fixed (reuse `sanitize` in `normalizeTags`) |
| `setMemoryTags` not atomic on failure | **Medium** | ✅ Fixed (SAVEPOINT rollback) |

### Ongoing

- Automated dependency scanning via **OrbisAI Security**
- Community security reviews welcome via private advisory

---

## Security Advisory Channels

Security advisories are published through the following channels simultaneously:

1. **[GitHub Security Advisories](https://github.com/slow-stack/mneme/security/advisories)** — primary channel with detailed technical information
2. **[npm Releases](https://www.npmjs.com/package/@modusensus/dsh-mneme)** — release notes include security advisories and fix summaries

To receive security notifications:
- **GitHub**: Watch the repository and enable "Security alerts" in repository settings
- **npm**: Subscribe to package release notifications for `@modusensus/dsh-mneme`

---

## Disclosure Policy

We practice **coordinated disclosure**:

1. Reporter submits vulnerability privately
2. We investigate and acknowledge within 48 hours
3. We develop fix and prepare advisory (timeline based on severity)
4. We notify reporter of fix timeline and planned disclosure date
5. We release patch + publish advisory simultaneously
6. We credit the reporter (with their consent) in the advisory

We do **not** pursue legal action against security researchers who:
- Act in good faith
- Do not exploit vulnerabilities beyond proof-of-concept
- Do not access data belonging to others
- Allow reasonable time for us to respond before public disclosure

**Bug Bounty Policy**: This project does not currently offer monetary rewards. We provide public credit in the advisory (with the reporter's consent).

---

## Security Logs & Data Retention

All audit data is stored **locally** in the plugin database and never leaves the device:

| Data Type | Storage Location | Notes |
|---|---|---|
| `failure_memories` audit logs | Local database | Every failed write is recorded; used for forensic analysis |
| `recall_run` search logs | Local database | Every search is recorded with timestamp and query metadata |
| AutoDream receipts | Local database + Markdown mirror | Cryptographically verifiable; persist until user deletes them |
| `distill_records` raw window text (#399) | Local database | **Opt-in, off by default.** Only when `distillRecords.enabled: true`: the raw prompt/answer text of distilled windows is kept verbatim (no truncation), capped by `retentionDays` (default 90). Never includes private reasoning, plugin-injected content, tool arguments or tool output. Retention trims the text only — provenance links stay (they point at an empty range, shown as "source expired") |
| Dependency scan reports | OrbisAI Security dashboard | Not stored on device |

Retention is user-controlled: audit records live only as long as the local database does. There is no remote logging and no telemetry.

---

## Security-Related Configuration

```yaml
# Hardened configuration example (all keys below match src/config.js where applicable)
dsh-mneme:
  # Disable autoDream if you want full manual control
  autoDream: false

  # Enable conflict freeze for sensitive environments
  conflictFreezeEnabled: true

  # Use local-only embedding (no network)
  embedProvider: local

  # Require Authorization: Bearer <apiToken> on remote endpoints (timing-safe)
  apiToken: "set-a-strong-unique-token"

  # Bump to downgrade all prior dream_runs to historical evidence
  policyEpoch: 1

  # Keep entity extraction off by default (data minimization)
  entityExtractionEnabled: false

  # Reranking is opt-in (default: off) — no extra model downloads unless enabled
  rerankEnabled: false

  # Coding-memory distillation is off by default (data minimization)
  codingRetrospect: false

  # Disable sleep mode maintenance if you want zero background activity
  sleepModeEnabled: false

  # Epistemic trust weighting is opt-in (default: off)
  trustEpistemicWeighting: false

  # LLM audit log retention (days)
  llmAudit:
    enabled: true
    retentionDays: 90

  # Raw distilled-window text is off by default (data minimization).
  # Turn it on only if you need to audit what a memory was distilled from:
  # text is kept verbatim (untruncated), so enable a short retentionDays.
  distillRecords:
    enabled: false
    retentionDays: 90
```

---

## Contributor Security Guidelines

All contributors must comply with the following security requirements:

1. **Dependency Audit**: Run `npm audit` before submitting a PR; newly introduced dependencies must pass security review
2. **Secret Scanning**: Never commit API keys, tokens, or credentials to the repository
3. **Input Validation**: All user inputs must be validated and sanitized (including LLM-derived content)
4. **Secure Code Review**: PRs with security-relevant changes require approval from a maintainer with security expertise
5. **Documentation**: New features must include a security impact analysis in the PR description
6. **Responsible Disclosure**: Security vulnerabilities found during development must be reported via the appropriate channel, not in public PRs

---

## Contact

- **Security Team**: `work@modusensus.space`
- **Private Advisory**: [GitHub Security Advisories](https://github.com/slow-stack/mneme/security/advisories)
- **GPG Key**: Available upon request for encrypted communication

---

## License

This project is licensed under the **MIT License**. See [LICENSE](https://github.com/slow-stack/mneme/blob/main/LICENSE) for details.

---

# 安全策略

> **中文** | [English](#security-policy)

---

## 支持版本

我们积极维护最新的 minor 版本。安全修复会 backport 到最新的 patch 版本，关键修复可能 backport 到前一个 minor 版本。

| 版本 | 支持状态 | 说明 |
|---|---|---|
| 0.8.x | ✅ 支持 | 活跃开发中 |
| 0.7.x | ⚠️ 尽力维护 | 仅关键修复 |
| < 0.7.0 | ❌ 不支持 | 请升级至 0.8.x |

**停止维护通知**：0.7.x 处于尽力维护阶段（仅关键修复）。停止维护的具体日期将提前公布；该日期之后将不再提供 0.7.x 的安全修复。0.6.x 及更早版本的安全支持已随 0.8.1 发版终止——请升级至 0.8.x。

---

## 已知安全特性

项目已实现并维护以下安全特性：

| 特性 | 描述 | 状态 |
|---|---|---|
| `apiToken` 鉴权 | 配置 token 后，所有远程端点需 `Authorization: Bearer <apiToken>`，比较使用 `crypto.timingSafeEqual` | ✅ 已实现 |
| `policyEpoch` 记忆治理 | 提升 `policyEpoch` 后，所有先前的 `dream_runs` 降级为历史证据，其 receipt 不再驱动实时记忆决策 | ✅ 已实现 |
| `conflictFreezeEnabled` 冲突冻结 | 冲突记忆不自动合并，标记为待人工复核，保护数据完整性 | ✅ 已实现 |
| CAS（比较并交换）守卫 | 防止并发写入冲突，确保原子写操作 | ✅ 已实现 |
| Digest 基线审计 | 记忆更新与 digest 基线比对，检测未授权修改 | ✅ 已实现 |
| `failure_memories` 审计轨迹 | 每次写入失败均记录，供取证分析 | ✅ 已实现 |
| `recall_run` 搜索审计 | 每次搜索操作均记录时间戳和查询元数据 | ✅ 已实现 |
| 本地优先数据处理 | embedding、rerank、记忆整理均在本地完成，数据不离开设备 | ✅ 已实现 |
| 无遥测 | 无分析、无远程日志，设计上无网络请求 | ✅ 已实现 |
| 查询净化 | LIKE 查询转义、分页边界限制、Markdown 镜像转义，防止注入和畸形输入 | ✅ 已实现 |
| `entityExtractionEnabled` 实体抽取 Opt-In | 实体抽取为配置项、默认关闭（数据最小化原则） | ✅ 已实现 |
| 优雅降级 | 组件故障时自动回退至关键词搜索，不崩溃 | ✅ 已实现 |
| 人工可编辑镜像 | 所有记忆镜像至 Markdown 文件，用户可验证和重建数据 | ✅ 已实现 |
| Mirror Generation CAS/Fence | 镜像同步绑定单调递增的 `generation` 计数器并采用 CAS/fence 语义，拒绝过期或并发镜像写入 | ✅ 已实现 |
| 崩溃恢复债务模型 | 业务写入在自身事务内原子递增 `desired generation`；崩溃后 `recoverMirror` 依据债务重放修复，不再静默跳过 | ✅ 已实现 |
| `/health` 鉴权门控 | 健康端点要求 `apiToken`；错误码净化（no-space / permission / sync-failed），读取失败 fail-closed 为 `unknown` | ✅ 已实现 |
| Fail-Closed 输入校验 | generation 计数与热记忆参数均做 `Number.isInteger`、有限性、非负校验并配 SQL `CHECK` 约束；非法输入回退安全默认值或被拒绝 | ✅ 已实现 |
| 混合分数钳制 | 混合检索融合分数钳制在 [0, 1]，防止向量 + BM25 叠加突破归一化边界 | ✅ 已实现 |
| Tag 净化 | Tag 规范化复用 sanitizer；`autoTag` 跳过已遗忘记忆；`setMemoryTags` 在 SAVEPOINT 内执行，失败原子回滚 | ✅ 已实现 |

---

## 报告漏洞

### 请不要

- 在公开 issue 中披露安全漏洞
- 在讨论区或评论中发布漏洞利用细节
- 未经事先协调就提交暴露安全缺陷的 PR

### 请这样做

1. **发送邮件**至 `work@modusensus.space`（或通过 [GitHub 私有安全公告](https://github.com/slow-stack/mneme/security/advisories) 提交）
2. 邮件内容请包含：
   - 漏洞的清晰描述
   - 复现步骤（优先提供最小测试用例）
   - 影响评估（数据泄露？仅本地？远程？）
   - 受影响的版本
   - 你建议的修复方案（如有）
   - 是否要求在公告中署名 / 披露偏好

### 受理范围与不受理范围

**受理范围**——本政策覆盖以下问题：
- 远程 API 鉴权 / 授权绕过（`apiToken` 保护面）
- 记忆完整性破坏（CAS/fence 绕过、未授权覆盖、重放路径）
- 可导致静默数据损坏的镜像一致性与恢复逻辑缺陷
- 在受支持版本中可利用的已发布运行时依赖漏洞

**不受理范围**——以下问题我们不予处理：
- 针对维护者或用户的社工 / 钓鱼类问题
- 仅通过不现实的本地资源耗尽触发、且无产品缺陷支撑的 DoS 声明
- 仅存在于不支持版本（`< 0.7.0`）的问题
- 无可证明安全影响的"最佳实践建议"类问题

不确定你的发现是否在受理范围内？仍请通过私有渠道提交——我们会评估并回复。

### 响应时间线

| 阶段 | 时间 | 行动 |
|---|---|---|
| 确认收到 | 48 小时内 | 我们确认收到并分配追踪 ID |
| 初步评估 | 7 天内 | 我们验证严重程度和影响范围；可能需要更多信息 |
| 修复开发 | 按严重程度 | 严重：≤ 14 天；高：≤ 30 天；中/低：下个版本 |
| 验证与测试 | 修复完成后 1–3 天 | 对补丁进行回归测试和安全测试 |
| 协调披露 | 修复发布时 | 同时发布安全公告和补丁版本 |

**备注**：对于严重漏洞，如果 14 天内无法提供完整修复，我们将在该时间内提供临时缓解措施或替代方案。

### 无响应升级路径

- 若 **48 小时内**未收到确认，请重新发送到 `work@modusensus.space`，邮件标题加前缀：`[SECURITY][FOLLOW-UP]`。
- 若再次等待 **48 小时**仍无回复，请通过 [GitHub 私有安全公告](https://github.com/slow-stack/mneme/security/advisories) 提交，并注明首次报告时间。
- 升级处理中请勿公开披露漏洞细节。

### 严重程度分级

我们遵循 [CVSS v3.1](https://www.first.org/cvss/v3.1/specification-document) 标准：

- **严重** (9.0–10.0)：远程代码执行、未授权数据外泄、核心安全控制绕过
- **高** (7.0–8.9)：本地权限提升、重大数据完整性破坏、高影响 DoS
- **中** (4.0–6.9)：特定条件下的信息泄露、部分控制绕过
- **低** (0.1–3.9)：轻微信息泄露、纵深防御改进

---

## 安全设计原则

### 1. 本地优先，零网络

- 所有 embedding、rerank、记忆整理均在本地运行
- 记忆文本**永不**离开设备
- 无遥测、无分析、无远程日志

### 2. 默认 Fail-Safe

- 任何组件故障（LLM、embedder、reranker）均优雅降级到关键词搜索
- 畸形输入不会导致插件崩溃或数据库损坏
- 并发写入冲突通过 CAS（比较并交换）守卫解决

### 3. 全面审计

- 每次 `autoDream` 运行生成密码学可验证的 receipt
- 每次记忆更新创建 `failure_memories` 审计轨迹
- 每次搜索记录 `recall_run` 供后续检查

### 4. 人类主权

- 所有记忆镜像到人类可编辑的 Markdown 文件
- 机器写入 vs 人工编辑通过 digest 基线区分
- 用户可仅凭 Markdown 镜像完整重建数据库

### 5. 最小远程暴露面

- 远程 API 端点为可选：需配置 `apiToken` 才生效
- 配置 token 后，每个远程请求均经过 timing-safe 比较
- 未配置 token 时，远程端点实际处于禁用状态，所有处理均在本地

---

## 依赖漏洞处理

### 处理流程

我们采用 5 步流程处理第三方依赖漏洞：

| 步骤 | 行动 | 时间要求 | 工具 |
|---|---|---|---|
| 1. 扫描 | 对所有运行时和开发依赖进行持续自动扫描 | 自动（每日） | OrbisAI Security、npm audit |
| 2. 评估 | 对每个检测到的漏洞评估严重程度、可利用性和对 dsh-mneme 的影响 | 检测后 48 小时内 | CVSS v3.1、人工代码分析 |
| 3. 上报 | 将发现记录到安全追踪器，并上报给维护者 | 评估后立即 | 安全追踪器、维护者通道 |
| 4. 修复 | 升级依赖至已修复版本或应用缓解措施 | 严重：≤ 14 天；高：≤ 30 天；中/低：下个版本 | npm/pnpm 更新、手动补丁 |
| 5. 披露 | 发布包含详情和已修复版本的安全公告 | 修复版本发布时 | GitHub Security Advisories + npm 发布说明 |

### 第三方依赖政策

- 所有新增运行时依赖需通过安全审查后方可引入
- 存在已知严重漏洞且在期限内无法修复的依赖将被替换为替代方案
- 依赖锁文件（`package-lock.json`）已提交并在 PR 中审查

### 近期依赖修复

| CVE | 包 | 修复前版本 | 修复后版本 | 严重程度 | 修复版本 |
|---|---|---|---|---|---|
| CVE-2026-39244 | `adm-zip` | 0.5.18 | 0.6.0 | 高 | v0.3.4 |

---

## 安全审计历史

### v0.2.10 — 安全加固

| ID | 发现 | 严重程度 | 状态 |
|---|---|---|---|
| F-NEW-01 | `store.js` 并发写入竞态 | **严重** | ✅ 已修复（CAS 守卫 + 原子写入） |
| F-NEW-02 | 镜像同步期间事务不一致 | **高** | ✅ 已修复（事务化镜像 + 回滚） |
| F-NEW-03 | 覆盖前未验证镜像健康状态 | **高** | ✅ 已修复（digest 基线 + FSM 验证） |

### v0.3.4 — 依赖安全

| CVE | 包 | 严重程度 | 状态 |
|---|---|---|---|
| CVE-2026-39244 | `adm-zip` 0.5.18 | **高** | ✅ 已修复（升级至 0.6.0） |

### v0.3.6 — Mirror 债务建模（审计 peer 复核修复）

| 发现 | 严重程度 | 状态 |
|---|---|---|
| 镜像同步未绑定 generation 计数器（过期覆盖窗口） | **高** | ✅ 已修复（generation + CAS/fence 语义，per-type 状态） |
| `/health` 端点未鉴权且错误码冗长 | **高** | ✅ 已修复（鉴权门控、错误码净化、读取失败 fail-closed `unknown`） |
| COMMIT-崩溃窗口可能永久跳过镜像修复 | **高** | ✅ 已修复（dirty 或 generation > applied 时触发 recoverMirror） |

### v0.3.8 — Mirror 同步可靠性（peer 6 blockers）

| 发现 | 严重程度 | 状态 |
|---|---|---|
| 镜像同步静默失败（错误未上抛至写路径） | **高** | ✅ 已修复（`syncMirror` 返回 `{success, error}`；写入口 `afterSync` 检查） |
| 多进程并发下 generation 非原子递增 | **高** | ✅ 已修复（`UPDATE ... RETURNING` 原子语句 + `PRAGMA busy_timeout=5000`） |
| generation 溢出 / 负值 | **中** | ✅ 已修复（JS 校验 + SQL `CHECK(0..MAX_SAFE_INTEGER)`） |

### v0.3.9 — 审计 A/B/D/F

| 发现 | 严重程度 | 状态 |
|---|---|---|
| CAS 更新与 generation 递增不在同一事务 | **高** | ✅ 已修复（`runAtomically` 原子执行；miss 不递增） |
| 失败更新可能虚报成功 | **高** | ✅ 已修复（degraded/pending 回执，带 mirror 属性） |
| generation 校验未 fail-closed | **中** | ✅ 已修复（`Number.isInteger` fail-closed + 迁移检测旧脏值） |

### v0.5.1 — 热记忆负参数防御

| 发现 | 严重程度 | 状态 |
|---|---|---|
| 负 / 非有限 `maxRounds`/`maxTokens` 可经公开 API 触发同步死循环 | **高** | ✅ 已修复（回退安全默认值 5/2000） |
| 混合融合分数可超过 1.0（向量 + BM25 叠加） | **中** | ✅ 已修复（钳制到 [0, 1]） |

### v0.6.5 — Tag 系统加固

| 发现 | 严重程度 | 状态 |
|---|---|---|
| `autoTag` 可能给已遗忘记忆打标签 | **中** | ✅ 已修复（打标前过滤 `forgotten`） |
| Tag 规范化绕过 sanitizer | **中** | ✅ 已修复（`normalizeTags` 复用 `sanitize`） |
| `setMemoryTags` 失败时非原子 | **中** | ✅ 已修复（SAVEPOINT 回滚） |

### 持续进行

- 通过 **OrbisAI Security** 进行自动化依赖扫描
- 欢迎社区通过私有公告提交安全审查

---

## 安全公告渠道

安全公告通过以下渠道同时发布：

1. **[GitHub Security Advisories](https://github.com/slow-stack/mneme/security/advisories)** — 主要渠道，包含详细技术信息
2. **[npm Releases](https://www.npmjs.com/package/@modusensus/dsh-mneme)** — 发布说明中包含安全公告和修复摘要

接收安全通知方式：
- **GitHub**：Watch 仓库并在仓库设置中启用“安全警报”
- **npm**：订阅 `@modusensus/dsh-mneme` 的发布通知

---

## 披露政策

我们实行**协调披露**：

1. 报告者私下提交漏洞
2. 我们在 48 小时内确认收到
3. 我们开发修复并准备公告（时间取决于严重程度）
4. 我们通知报告者修复时间线和计划披露日期
5. 我们同时发布补丁和安全公告
6. 我们在公告中致谢报告者（经其同意）

我们**不会**对以下安全研究人员采取法律行动：
- 出于善意行事
- 不将漏洞利用超出概念验证范围
- 不访问属于他人的数据
- 在公开披露前给予我们合理的响应时间

**漏洞赏金政策**：本项目目前不提供经济奖励。我们会在公告中公开致谢报告者（经其同意）。

---

## 安全日志与数据保留

所有审计数据**本地**存储于插件数据库，不离开设备：

| 数据类型 | 存储位置 | 说明 |
|---|---|---|
| `failure_memories` 审计日志 | 本地数据库 | 每次写入失败均记录，供取证分析 |
| `recall_run` 搜索日志 | 本地数据库 | 每次搜索均记录时间戳和查询元数据 |
| AutoDream receipts | 本地数据库 + Markdown 镜像 | 密码学可验证；保留至用户删除 |
| `distill_records` 蒸馏窗口原文（#399） | 本地数据库 | **opt-in，默认关。** 仅当 `distillRecords.enabled: true` 时：被蒸馏窗口的用户提示与助手公开正文**逐字留存**（不截断），受 `retentionDays`（默认 90）约束。**绝不**包含私有推理链、插件注入的机器内容、工具入参与工具输出。到期裁剪只删原文，溯源链接保留（指向空区间，显示「来源已过期」） |
| 依赖扫描报告 | OrbisAI Security 控制台 | 不存储于设备 |

保留期由用户控制：审计记录仅随本地数据库存续。无远程日志、无遥测。

---

## 安全相关配置

```yaml
# 加固配置示例（键均对应 src/config.js 实际配置，除注明外）
dsh-mneme:
  # 如需完全手动控制，可禁用 autoDream
  autoDream: false

  # 敏感环境启用冲突冻结
  conflictFreezeEnabled: true

  # 仅使用本地 embedding（无网络）
  embedProvider: local

  # 远程端点需 Authorization: Bearer <apiToken>（timing-safe）
  apiToken: "set-a-strong-unique-token"

  # 提升以将先前的 dream_runs 降级为历史证据
  policyEpoch: 1

  # 实体抽取默认关闭（数据最小化）
  entityExtractionEnabled: false

  # Rerank 为 opt-in（默认关闭）——未启用时不下载额外模型
  rerankEnabled: false

  # 编码记忆蒸馏默认关闭（数据最小化）
  codingRetrospect: false

  # 不需要后台维护时可关闭 Sleep Mode
  sleepModeEnabled: false

  # 记忆可信度加权为 opt-in（默认关闭）
  trustEpistemicWeighting: false

  # LLM 审计日志保留天数
  llmAudit:
    enabled: true
    retentionDays: 90

  # 蒸馏窗口原文默认关闭（数据最小化）。
  # 只有需要复核「一条记忆蒸馏自哪段对话」时才打开：
  # 原文逐字留存（不截断），请同时设一个较短的 retentionDays
  distillRecords:
    enabled: false
    retentionDays: 90
```

---

## 贡献者安全指南

所有贡献者必须遵守以下安全要求：

1. **依赖审计**：提交 PR 前运行 `npm audit`；新增依赖必须通过安全审查
2. **密钥扫描**：禁止向仓库提交 API 密钥、令牌或凭据
3. **输入验证**：所有用户输入必须验证和净化（包括 LLM 相关内容）
4. **安全代码审查**：涉及安全相关变更的 PR 需获得具有安全专业知识维护者的批准
5. **文档记录**：新功能必须在 PR 描述中包含安全影响分析
6. **负责任的披露**：开发过程中发现的安全漏洞必须通过适当渠道报告，而非在公开 PR 中提交

---

## 联系方式

- **安全团队**：`work@modusensus.space`
- **私有公告**：[GitHub Security Advisories](https://github.com/slow-stack/mneme/security/advisories)
- **GPG 密钥**：如需加密通信，可应请求提供

---

## 许可协议

本项目基于 **MIT License** 开源。详见 [LICENSE](https://github.com/slow-stack/mneme/blob/main/LICENSE)。

---

*Last updated: 2026-09-06*  
*Policy version: 2.3*
