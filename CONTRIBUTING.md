# Contributing

> **English** | [中文](#贡献指南)

---

## Prerequisites

- **Node.js 24+** (CI runs on Node 24)
- **npm** (the repo uses npm; CI installs with `npm ci`)
- **git** (on Windows, watch LF/CRLF: the repo is LF-normalized and git converts automatically)

---

## Repository Layout

The repository root is a documentation listing; the actual plugin code (and the npm package) lives in the `dsh-mneme/` subdirectory:

```
dsh-mneme-repo/           # repo root (docs only, no package.json)
├── README.md / CHANGELOG.md / SECURITY.md / CONTRIBUTING.md
└── dsh-mneme/            # the plugin itself (npm package dir, publish entry)
    ├── src/              # source (ESM) — all feature work happens here
    ├── lib/              # build output; DSH actually loads lib/index.js
    ├── scripts/          # sync-lib.js, check-sync.js, e2e-dsh.js, stress-dsh.js, benchmark-*
    ├── test/             # node:test test suite
    ├── docs/             # SEMANTIC / SLEEP / ENTITIES / LOCAL_MODEL deep-dives
    ├── package.json      # plugin metadata and scripts
    └── cordis.patch.yml  # DSH injection patch
```

**Key convention: `src/` is the single source of truth; `lib/` is build output.**

- Write code only in `src/`, then run `npm run sync` to mirror changes into `lib/`.
- **Never edit `lib/` by hand** — the next sync overwrites it.
- Publish from inside `dsh-mneme/` — the **package directory** (per AGENTS.md red line: the repo root historically shipped broken packages and now has no package.json). `prepack` runs `scripts/check-sync.js`, which asserts `src/` ↔ `lib/` match file-for-file and fails the publish on any drift (issue #65). So run `npm run sync` (in `dsh-mneme/`) and commit the `lib/` changes **before** publishing.

---

## Local Development

```bash
# 1. Install dependencies (inside dsh-mneme/)
cd dsh-mneme
npm ci

# 2. After editing files under src/, mirror to lib/
npm run sync

# 3. Run the tests
npm test              # node --test test/*.test.js
npm run test:coverage # c8 coverage
```

Common scripts (all run under `dsh-mneme/`):

| Command | Description |
|---------|-------------|
| `npm test` | Full unit/integration suite |
| `npm run test:coverage` | Tests + c8 coverage (used by CI) |
| `npm run e2e` | End-to-end smoke test (scripts/e2e-dsh.js) |
| `npm run stress` | Three-axis stress test (scripts/stress-dsh.js) |
| `npm run sync` | src/ → lib/ mirror |
| `node bin/cli.mjs --help` | CLI smoke check (zero-dep external API client, v0.7.12+) |

---

## Testing Conventions

- Tests use Node's built-in **`node:test` + `node:assert/strict`**; no third-party test framework.
- New features require corresponding tests; **changing core logic (e.g. model routing, decision validation) must update the affected test assertions** so the suite stays green before committing.
- Test files live in `test/`, named `*.test.js`; shared mocks go in `test/helpers/` (e.g. `dream-mock.js`).
- Known environment dependency: a few cases in `reranker.test.js` need `@huggingface/transformers` (locally this one case fails without the package; it is unrelated to repo logic and CI installs it and passes).
- The published artifact is covered too: `test/lib-smoke.test.js` imports from `lib/` and asserts `src/` ↔ `lib/` are file-for-file identical (issue #65 regression guard).

---

## Code Style & Engineering Conventions

- **ESM**: the repo is `"type": "module"`; everything uses `import`/`export`.
- **Comments in Chinese**, biased toward "why" — core logic, config options, and fail-safe branches must explain their intent.
- **Fail-safe is a hard rule**: local failures in any background LLM path (autoDream / sleep / autoTag / summarization) must skip or degrade, **never** block the main flow (write, recall, injection).
- **Config is defined centrally with schemastery in `src/config.js`** (`z.object` + `.default(...)`); new options must keep docs and default-value semantics in sync.
- **Audit honesty**: a run's status (ok / noop / degraded / reconcile / failed) must reflect what actually committed — never a fake ok.
- **Benchmark honesty**: cite only reproducible numbers, and when quoting someone else's benchmark, mark it **self-reported vs independently reproduced**. A project claiming "best on every benchmark" without a reproducible harness is the norm, not the exception — treat unverifiable claims as marketing and never let them into our own docs. When borrowing a *design*, reading the README is enough; before borrowing *code*, read the LICENSE file itself (a `NOASSERTION` GitHub metadata field alongside an MIT badge means the license is unresolved, not MIT).

---

## Commits & Branches

- Commit messages follow **Conventional Commits**:

  ```
  fix(dream): reject cross-type merge as a whole batch (Issue #26)
  feat(tag): add tag-weighted recall
  docs: expand the SEMANTIC doc
  release: v0.6.9 ...
  ```

- Run `npm test` before committing and confirm green (note any environment-only known exceptions in the commit message).
- **Small fixes**: maintainers can push straight to `main` (maintainers-only shortcut — contributors always go through the workflow below).
- **Larger features / breaking changes**: open an Issue first to state the motivation and design, then submit a PR — the PR triggers CI (Node 24 + full suite + Codecov).
- Release operations (version bumps, tags, Releases, npm publish) are performed by maintainers — see the next section.

**Commit attribution is mandatory.** Every commit in a PR must be attributable to the PR author:

- Use an author email that belongs to **your own GitHub account** — preferably your noreply address (`ID+username@users.noreply.github.com`, see Settings → Emails). Check with `git config user.email`.
- **Signed commits are strongly recommended** (GPG/SSH — the "Verified" badge); they are the only cryptographic proof of authorship.
- Commits whose author email resolves to **someone else's GitHub account**, or that cannot be linked to you at all, **will not be merged**: unattributed code means nobody owns the responsibility when review questions or regressions arrive.
- You are expected to participate in review and answer questions about your own code — attribution is what makes that possible.

---

## Contributor Workflow: Issue → Claim → PR

Almost every change — **fixes and small features included** — starts from an Issue. Actionable work is labelled `good first issue` / `help wanted`.

1. **Claim before you start**: comment on the Issue with a short plan (what you will change, which files/tests). If the approach has open questions (path conventions, response shapes), settle them in that thread first — maintainer feedback on the claim is the fastest way to a merged PR. Opening a PR with no related Issue will be closed as unexpected (exceptions: typos and pure docs fixes).
2. **One PR per Issue**: reference it in the PR body (`Closes #N` / `Fixes #N` when the PR fully resolves it).
3. **Keep the PR minimal**: behavior changes belong in `src/` (+ `test/`); run `npm run sync` so `lib/` follows (`check-sync` will fail CI otherwise); `npm test` green; user-visible changes include their README line in the same PR.
4. **CI must be green** (Node 22/24 × Linux/Windows, full suite, Codecov) before review.
5. **A claimed Issue belongs to the claimant**: the claim comment is the lock — a second PR on the same Issue will be marked `duplicate` and closed, unless the first PR is clearly low-quality or has gone silent.
6. **Claims expire**: a claim with no PR within 2 weeks is released — anyone may re-claim it on the Issue thread.

---

## Scope: Platform Adaptation & Wrapper PRs

DSH upstream is still in developer preview — APIs and service interfaces change frequently. Until DSH reaches a stable release (RC or GA), **PRs that adapt dsh-mneme to secondary platforms or wrap it into other hosts are not a priority** and are reviewed with extra caution:

- Desktop shells (e.g. a Tauri/Electron wrapper around `dsh web`)
- Standalone CLI packaging
- Ports/wrappers of dsh-mneme into other plugin ecosystems

These tend to bind against unstable upstream APIs: a single upstream change can break them, and the maintenance burden falls back on this project. The currently supported platform is the **Web Profile** (`dsh web`).

Exceptions: if a contributor is willing to **own long-term maintenance** (track upstream changes and fix breakage), open a Discussion first to scope the work — maintainers will evaluate and review the PR.

Bug-fix PRs for existing desktop compatibility issues are still welcome.

---

## Release Process (Maintainers)

Versioning follows semantic versioning (`MAJOR.MINOR.PATCH`). Full flow:

1. **Update CHANGELOG**: add a version entry (`## [X.Y.Z] - date`, split into 「修复 / 新增 / 测试」) at the top of `dsh-mneme/CHANGELOG.md`; update the root `CHANGELOG.md` if it tracks the same. End the section with a `### 贡献者 / Thanks` subsection summarising outside contributors (`git log vPrev..HEAD --format='%an <%ae>' | sort -u`; list non-maintainers as "GitHub handle + what they did", and keep the inline 「感谢 @handle」 in the entry too); omit it when there are none. **Keep entries neutral**: no references to non-public issue numbers and no internal experiment codenames — nobody reading this repository can resolve them.
2. **Bump version**: change `version` in `dsh-mneme/package.json` and `package-lock.json`.
3. **Full test pass**: `npm test` must be green.
4. **Commit and push**: commit → `git push origin main` → `git tag vX.Y.Z` → `git push origin vX.Y.Z`.
5. **Create a GitHub Release**: title `vX.Y.Z`, body referencing the matching CHANGELOG entry (review before publishing).
6. **Publish to npm**: run `npm publish` from inside `dsh-mneme/` — the **package directory** (per AGENTS.md red line; the repository root has no package.json). `prepack` runs `scripts/check-sync.js` and fails if `src/` ↔ `lib/` drifted — ensure `npm run sync` + commit ran first.

---

## External API & CLI (v0.7.12+)

The standalone external API (`src/api-standalone.js`) and the `bin/cli.mjs` client let other plugins and desktop tools read/write memories over loopback HTTP. When touching them:

- Keep the route surface read/write on memories only; new routes need tests in `test/standalone-api.test.js` (they spin the real server on port 0).
- Auth additions/changes must keep `timingSafeEqual` token comparison and the `GET /health` exception.
- The CLI is dependency-free by contract - do not add imports to `bin/cli.mjs`.
- The standalone daemon (`bin/dsh-mneme-serve.mjs` → `src/serve.js`) is exempt from that contract: it mounts `lib/serve.js` by design. Keep it a pure data plane — no LLM handle, no dream/summarize path (single-writer guarantee vs. the host), and keep `strictPort` semantics (busy configured port = hard error; the in-host sidecar keeps its hop-and-fallback recovery).

## Issue Reporting Requirements (read this first)

Maintainers verify every report against the code before replying — you do not need to read the source. But a report **must come from someone who has actually run the plugin**, and must satisfy the minimums below **in full**. A report missing any required item will be **closed with a completion template**; comment with the missing details to reopen.

### Bug report — all six required

1. dsh-mneme version (settings panel, or `npm ls @modusensus/dsh-mneme`)
2. DSH version + profile (`web` / desktop / headless)
3. Operating system / platform
4. Reproduction steps, starting from a fresh session, each step actionable
5. Actual behavior vs expected behavior
6. Relevant console / log snippet (mask tokens)

### Feature request — all three required

1. The **use case** (what you are trying to accomplish — not "add feature X")
2. A statement that you have checked the current state: README, CHANGELOG, roadmap, and existing issues. Several requested capabilities already exist behind named switches (per-turn auto recall = `autoInject`; idle distillation = `autoSummarize` + `autoDream`)
3. The behavior change you expect (not a prescribed implementation)

### AI-assisted reports

- Using AI to polish wording or structure: fine.
- The report content **must be verified by you, item by item**: real environment, real reproduction, real observed behavior.
- Treated as **spam**: mass-submitted variants of the same topic, fabricated reproduction steps, references to plugin behavior or configuration that does not exist, or reports filed without ever running the plugin.
- Enforcement: spam reports are **closed on sight** with a link to this section; **repeated spam leads to blocking without further notice**.

### Maintainer commitment

Every report meeting the minimums gets code-level verification and a reply. Issues opened by maintainers (including AI-assisted maintainer workflows) are held to the same minimums.

## Contact

- **General questions & contributions**: [GitHub Discussions](https://github.com/slow-stack/mneme/discussions) or `work@modusensus.space`
- **Security vulnerabilities**: report privately via [SECURITY.md](SECURITY.md) — never open a public issue for vulnerabilities

---

## Miscellaneous

- Security issues go through [SECURITY.md](SECURITY.md) or a GitHub Security Advisory — never paste sensitive info into a public Issue.
- Be respectful and constructive; PRs touching data integrity, security, or behavior must include reproduction steps and regression evidence.

---

# 贡献指南

> **中文** | [English](#contributing)

---

## 环境要求

- **Node.js 24+**（CI 在 node 24 上运行）
- **npm**（仓库使用 npm，CI 用 `npm ci`）
- **git**（Windows 下注意 LF/CRLF：仓库以 LF 为准，git 会自动转换）

---

## 代码库布局

仓库根目录是发布清单，实际插件代码在 `dsh-mneme/` 子目录：

```
dsh-mneme-repo/           # 仓库根（仅文档清单，无 package.json）
├── README.md / CHANGELOG.md / SECURITY.md / CONTRIBUTING.md
└── dsh-mneme/            # 插件本体（npm 包目录，发布入口）
    ├── src/              # 源码（ESM），所有功能都在这里开发
    ├── lib/              # 构建产物，DSH 实际加载的是 lib/index.js
    ├── scripts/          # sync-lib.js、check-sync.js、e2e-dsh.js、stress-dsh.js、benchmark-*
    ├── test/             # node:test 测试
    ├── docs/             # SEMANTIC / SLEEP / ENTITIES / LOCAL_MODEL 等专题文档
    ├── package.json      # 插件包元数据与 scripts
    └── cordis.patch.yml  # DSH 注入补丁
```

**关键约定：`src/` 是唯一的事实来源，`lib/` 是构建产物。**

- 所有代码改动只写 `src/`，改完必须运行 `npm run sync` 同步到 `lib/`。
- **不要手工编辑 `lib/`**——下次 sync 会覆盖你的改动。
- 发布在 **`dsh-mneme/` 包目录内**执行（AGENTS.md 红线：仓库根历史上发出过坏包，根目录现已无 package.json）：`prepack` 会跑 `scripts/check-sync.js`，逐文件断言 `src/` ↔ `lib/` 一致，有漂移直接发布失败（issue #65 教训）。所以发布前务必先在 `dsh-mneme/` 里跑 `npm run sync` 并把 `lib/` 改动一起提交。

---

## 本地开发

```bash
# 1. 安装依赖（在 dsh-mneme/ 目录内）
cd dsh-mneme
npm ci

# 2. 修改 src/ 下的文件后，同步到 lib/
npm run sync

# 3. 跑测试
npm test              # node --test test/*.test.js
npm run test:coverage # c8 覆盖率
```

常用脚本（均在 `dsh-mneme/` 下）：

| 命令 | 说明 |
|------|------|
| `npm test` | 全量单元/集成测试 |
| `npm run test:coverage` | 测试 + c8 覆盖率（CI 使用） |
| `npm run e2e` | 端到端冒烟（scripts/e2e-dsh.js） |
| `npm run stress` | 三轴线压测（scripts/stress-dsh.js） |
| `npm run sync` | src/ → lib/ 同步 |

---

## 测试约定

- 测试框架为 Node 内置 **`node:test` + `node:assert/strict`**，不引入第三方测试库。
- 新增功能必须有对应测试；**修改核心逻辑（如模型路由、决策校验）时必须同步更新受影响用例的断言**，保证全量测试通过后提交。
- 测试文件放在 `test/`，命名 `*.test.js`；共享 mock 放 `test/helpers/`（如 `dream-mock.js`）。
- 已知环境依赖：`reranker.test.js` 的个别用例需要 `@huggingface/transformers`（本地未安装该包时这 1 例会失败，与本仓库逻辑无关，CI 会正常安装并通过）。
- 发布产物也被覆盖：`test/lib-smoke.test.js` 从 `lib/` 直接导入复跑关键用例，并断言 src↔lib 逐文件一致（issue #65 防再犯）。

---

## 代码风格与工程约定

- **ESM**：仓库 `"type": "module"`，全部使用 `import`/`export`。
- **注释用中文**，且偏向"解释为什么"——核心逻辑、配置项、fail-safe 分支都要求写清意图。
- **fail-safe 是硬性约定**：所有后台 LLM 链路（autoDream / sleep / autoTag / 摘要）中的局部失败只能跳过或降级，**绝不能**阻断主流程（写入、检索、注入）。
- **配置项统一用 schemastery 定义在 `src/config.js`**（`z.object` + `.default(...)`），新增配置记得同步文档与默认值语义。
- **审计诚实性**：任何 run 的状态（ok / noop / degraded / reconcile / failed）必须反映真实提交结果，绝不虚报。
- **benchmark 诚实性**：对外只引用可复现的数；引用他人 benchmark 时必须标注是**自报**还是**独立复现**。宣称「所有 benchmark 第一」却没有可复现评测工具的项目是常态而非例外——不可核验的声称按宣传处理，不得写进我们的文档。借鉴**设计**读 README 即可，借鉴**代码**必须先读 LICENSE 原文（GitHub 元数据为 `NOASSERTION` 却挂 MIT 徽章的，许可证属未定，不等于 MIT）。

---

## 提交与分支

- 提交信息遵循 **Conventional Commits**：

  ```
  fix(dream): 修复跨类型 merge 整单拒绝（Issue #26）
  feat(tag): 新增标签加权召回
  docs: 补充 SEMANTIC 文档
  release: v0.6.9 ...
  ```

- 提交前跑一遍 `npm test` 确认全绿（环境相关的已知例外需在提交说明里注明）。
- **小改动 / 修复**：可直推 `main`（本项目采用此工作流）。
- **较大功能 / 破坏性改动**：建议先开 Issue 说明动机与方案，再通过 PR 提交，PR 会触发 CI 校验（node 24 + 全量测试 + Codecov）。
- 发布相关操作（改版本号、打 tag、发 Release、npm publish）由维护者执行，详见下节。

**提交署名是硬性要求。** PR 里的每个 commit 都必须可归属到 PR 作者本人：

- 提交邮箱必须属于**你自己的 GitHub 账号**——推荐用 noreply 地址（`ID+用户名@users.noreply.github.com`，见 Settings → Emails）。用 `git config user.email` 自查。
- **强烈建议签名提交**（GPG/SSH，即 "Verified" 徽章）——这是作者身份的唯一密码学证明。
- 提交邮箱被 GitHub 归属到**他人账号**、或完全无法归属到你的 commit，**不予合并**：无法署名的代码，在 review 提问或出现回归时找不到责任人。
- 你需要参与 review 并能回答自己代码的问题——这正是署名的意义。

---

## 范围：平台适配与封装 PR

DSH 上游仍处于 developer preview 阶段，API 与服务接口变动频繁。在 DSH 稳定（RC 或正式版）之前，以下方向的 PR **不作为优先项**，且会以额外谨慎的态度审查：

- 桌面端适配（例如基于 `dsh web` 的 Tauri/Electron 桌面壳）
- 独立 CLI 封装
- 把 dsh-mneme 移植/封装到其他插件体系

这类 PR 往往绑定不稳定的上游接口——上游一次变动就可能使其失效，而维护责任会落到本项目头上。当前唯一受支持的平台是 **Web Profile**（`dsh web`）。

例外：如果贡献者愿意**承担长期维护**（跟进上游变更并修复 break），请先开 Discussion 沟通范围，维护者会评估并 review 该 PR。

针对现有 desktop 兼容问题的 **bug 修复 PR 依然欢迎**。

---

## 发布流程（维护者）

版本号遵循语义化版本（`MAJOR.MINOR.PATCH`）。完整流程：

1. **更新 CHANGELOG**：在 `dsh-mneme/CHANGELOG.md` 顶部新增版本条目（`## [X.Y.Z] - 日期`，分「修复 / 新增 / 测试」小节），根目录 `CHANGELOG.md` 如涉及同步更新。小节末尾加 `### 贡献者 / Thanks` 汇总本版外部贡献者（`git log v上一版..HEAD --format='%an <%ae>' | sort -u`，非维护者逐条列「GitHub 用户名 + 一句话做了什么」，条目内也保留「感谢 @用户名」）；无外部贡献者时省掉该小节。**条目一律用中性措辞**：不引用非公开的 issue 编号、不出现内部实验代号——它们在公开仓库里解析不出来，读者只会困惑。
2. **更新版本号**：改 `dsh-mneme/package.json` 的 `version` 与 `package-lock.json`（根目录无 package.json，勿臆造）。
3. **全量测试**：`npm test` 确认通过。
4. **提交并推送**：commit → `git push origin main` → `git tag vX.Y.Z` → `git push origin vX.Y.Z`。
5. **创建 GitHub Release**：标题为 `vX.Y.Z`，正文引用 CHANGELOG 对应条目（发布前需人工过目）。
6. **发布 npm**：在 **`dsh-mneme/` 包目录内**执行 `npm publish`（AGENTS.md 红线：仓库根历史上发出过坏包，根目录现无 package.json）。`prepack` 会跑 `scripts/check-sync.js` 校验 src↔lib 一致性，漂移则发布失败——发布前须先 `npm run sync` 并提交 `lib/` 改动。

---

## Issue 报告要求（提 issue 前必读）

维护者回复前会对每份报告做代码级核实——你不必读源码，但报告**必须来自真实运行过插件的环境**，且**逐项**满足以下最低要求。缺任何一项，报告会被**关闭并附补正模板**；补齐后评论即可重开。

### Bug 报告——六项缺一不可

1. dsh-mneme 版本（设置面板，或 `npm ls @modusensus/dsh-mneme`）
2. DSH 版本与 profile（`web` / desktop / headless）
3. 操作系统 / 平台
4. 复现步骤（从新会话开始，每步可照做）
5. 实际行为 vs 预期行为
6. 相关 console / log 片段（token 打码）

### Feature Request——三项缺一不可

1. **使用场景**（你要完成什么——而不是"加个 XX 功能"）
2. 已查现状声明：README、CHANGELOG、路线图与已有 issue。不少诉求已被现有开关覆盖（例如逐回合自动唤回 = `autoInject`；空闲期蒸馏 = `autoSummarize` + `autoDream`）
3. 期望的行为变化（不指定实现方案）

### 关于 AI 辅助

- 用 AI 打磨措辞、组织结构：可以。
- 报告内容**必须经你本人逐项核实**：环境真实、复现真实、观察到的行为真实。
- 以下情形视为**垃圾信息（spam）**：批量提交同一主题的变体、编造复现步骤、引用本插件不存在的行为或配置、从未运行过插件就提交。
- 处置：发现即关闭并附本节链接；**再次提交垃圾信息将直接拉黑，不再另行通知**。

### 维护者承诺

每份满足最低要求的报告都会得到代码级核实与回复。维护者自己（含 AI 辅助的维护者工作流）开的 issue 同受本节约束。

## 联系方式

- **一般问题与贡献咨询**：[GitHub Discussions](https://github.com/slow-stack/mneme/discussions) 或 `work@modusensus.space`
- **安全漏洞**：请通过 [SECURITY.md](SECURITY.md) 私有提交，不要在公开 Issue 中提交漏洞

---

## 其他

- 安全问题请走 [SECURITY.md](SECURITY.md) 或 GitHub Security Advisory，不要在公开 Issue 贴敏感信息。
- 保持礼貌与建设性；涉及数据损坏 / 安全 / 破坏性改动的 PR 需附复现步骤与回归证据。
