<p align="center">
  <img src="https://raw.githubusercontent.com/slow-stack/mneme/main/images/mneme-banner-hero.webp" alt="Mneme — The Memory That Dreams" width="100%" />
</p>

# mneme-memory

Cross-session memory for any MCP client — a stdio MCP server that exposes the
six memory tools of the [dsh-mneme](https://www.npmjs.com/package/@modusensus/dsh-mneme)
plugin to Claude Code, Cursor, Codex, Hermes, OpenCode and any other host that
speaks [Model Context Protocol](https://modelcontextprotocol.io).

It is **not** a second memory store. The server talks to dsh-mneme's standalone
HTTP API, so memories written from your editor show up in DSH and vice versa.

## What you get

| Tool | Purpose |
|---|---|
| `memory_save` | Persist one entry (preference / project / decision / summary / history) for future sessions |
| `memory_search` | Search past context by keyword and, when the library has embeddings, by meaning |
| `memory_list` | List entries by type, importance first, paginated (`include_archived` to see archived ones) |
| `memory_get` | Fetch one entry's full content by id |
| `memory_update` | Modify title / content / type / tags / importance of an existing entry |
| `memory_delete` | Permanently delete an entry |

Tool names, parameters and output rendering are kept verbatim-aligned with the
plugin's in-DSH tools (a cross-package parity test locks this in CI).

## Prerequisite: a reachable memory library

Pick one:

- **DSH is running** — enable the external API: DSH panel → 记忆 / Memory →
  Settings → *Connections & safety* → *External API*. The token shown there is
  the one you pass below.
- **No DSH** — run the standalone daemon (same library, no LLM, no DSH needed):

  ```bash
  npx -p @modusensus/dsh-mneme dsh-mneme-serve --memory-dir <library-dir> --port 8790
  ```

  It prints the resolved port on stdout once ready; logs go to stderr. The
  daemon and DSH's external API default to the same port — run one, or offset
  the other with `--port`.

## Mount it

```json
{
  "mcpServers": {
    "mneme-memory": {
      "command": "mneme-mcp",
      "env": {
        "MNEME_URL": "http://127.0.0.1:8790",
        "MNEME_TOKEN": "<token from the panel's External API card>"
      }
    }
  }
}
```

Without a global install, launch it through `npx`. The bin name differs from the
package name, so `npx mneme-mcp` would try to install a nonexistent package —
pass the package explicitly with `-p`:

```json
{
  "mcpServers": {
    "mneme-memory": {
      "command": "npx",
      "args": ["-y", "-p", "mneme-memory", "mneme-mcp"],
      "env": { "MNEME_TOKEN": "<token>" }
    }
  }
}
```

## Configuration

Resolved in this order, first non-empty wins:

| Setting | Priority |
|---|---|
| URL | `DSH_MNEME_URL` → `MNEME_URL` → `url` in `~/.dsh-mneme/cli.json` → `http://127.0.0.1:8790` |
| Token | `DSH_MNEME_TOKEN` → `MNEME_TOKEN` → `token` in `~/.dsh-mneme/cli.json` → (none) |

`DSH_MNEME_*` and `MNEME_*` are equivalent; the former exists for mounts written
before this package was split out, so nothing needs migrating. The config file
accepts no `MNEME_*` keys — it is shared with the plugin CLI
(`dsh-mneme config set <url> <token>` writes it).

## One semantic difference from in-DSH use

The standalone API has no conversation context, so `memory_save` cannot infer
which agent or workspace a memory belongs to: it only honours an explicit
`agent_scope` / `workspace_scope` argument and otherwise stores the entry
unscoped. Everything else behaves as inside DSH.

## Security notes

- Writes go through the API (single writer), never directly against the SQLite
  file — concurrent access stays safe.
- The token is sent as a `Bearer` header. If `MNEME_URL` points at plain HTTP on
  a non-loopback host, the server prints a warning on stderr: prefer a loopback
  address or an SSH tunnel.
- All logs go to stderr; stdout carries only JSON-RPC frames (one per line).

---

## 中文说明

`mneme-memory` 是 dsh-mneme 插件的记忆工具六件套的 **stdio MCP server 版**，供
Claude Code / Cursor / Codex 等任意 MCP 客户端挂载。它**不是第二个记忆库**——数据面
走插件的 standalone HTTP API，所以在编辑器里写的记忆，回到 DSH 里同样能读到。

- **前置**：要么在 DSH 面板「设置 → 连接与安全 → 外部访问 API」开启并取令牌；要么
  不开 DSH，直接跑独立服务
  `npx -p @modusensus/dsh-mneme dsh-mneme-serve --memory-dir <库目录> --port 8790`
  （两者默认抢同一端口，二选一或用 `--port` 错开）。
- **挂载**：`command` 填 `mneme-mcp`，`env` 填 `MNEME_URL` / `MNEME_TOKEN`。不想全局
  安装就用 `npx`，但**必须带 `-p mneme-memory`**——bin 名与包名不同，裸
  `npx mneme-mcp` 会去装一个不存在的包。
- **配置优先级**：`DSH_MNEME_*` → `MNEME_*` → `~/.dsh-mneme/cli.json` → 默认
  `http://127.0.0.1:8790`。两组环境变量等价，前者是为拆包前的老挂载保留的，无需迁移。
- **一处语义差异**：standalone API 没有会话上下文，`memory_save` 不自动标注归属，
  只认显式的 `agent_scope` / `workspace_scope`，否则按未归属存储。
- **安全**：写入一律经 API（单写者），不直连 SQLite；非回环地址走明文 HTTP 时会在
  stderr 告警；日志只进 stderr，stdout 只承载 JSON-RPC 帧。
