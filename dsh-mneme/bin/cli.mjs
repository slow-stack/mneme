#!/usr/bin/env node
/**
 * dsh-mneme CLI —— @modusensus/dsh-mneme 外部 API 命令行客户端
 *
 * 零依赖 ESM（Node >= 20，使用全局 fetch）。
 * 配置优先级：命令行 --url/--token > 环境变量 DSH_MNEME_URL / DSH_MNEME_TOKEN
 *            > 配置文件 ~/.dsh-mneme/cli.json（{"url","token"}）
 * 默认服务地址：http://127.0.0.1:8790
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CLI_NAME = 'dsh-mneme';
const DEFAULT_URL = 'http://127.0.0.1:8790';
const CONFIG_DIR = path.join(os.homedir(), '.dsh-mneme');
const CONFIG_PATH = path.join(CONFIG_DIR, 'cli.json');
// 与 src/store.js 的 TYPES 对齐（CLI 是零依赖 HTTP 客户端，不 import 服务端
// 模块，所以这里是手写字面量）。document 是唯一例外：它只能经
// memory_register_document 铸造，saveWithDedupe 会拒绝旁路写入，所以不作为
// --type 的选项——test/cli-enums.test.js 锁住「差值恰好是 document」。
const MEMORY_TYPES = ['preference', 'project', 'decision', 'history', 'summary', 'pattern', 'rejected_solution', 'pitfall', 'constraint'];
// hybrid：API 的 searchMemories 支持（向量先、关键词补位、双路命中做分数混合，
// 见 src/api.js 的 mode 注释）。此前漏列，search --mode hybrid 会被客户端自己拒掉。
const SEARCH_MODES = ['keyword', 'vector', 'auto', 'hybrid'];
const REQUEST_TIMEOUT_MS = 10_000;

function readPkgVersion() {
  try {
    const pkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'package.json'
    );
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version ?? '?';
  } catch {
    return '?';
  }
}

const PKG_VERSION = readPkgVersion();

const USAGE = `${CLI_NAME} —— DSH 记忆插件（@modusensus/dsh-mneme）外部 API 命令行客户端

用法：
  ${CLI_NAME} <命令> [参数] [选项]

配置（优先级从高到低）：
  1. 命令行参数 --url <url> / --token <token>
  2. 环境变量 DSH_MNEME_URL / DSH_MNEME_TOKEN
  3. 配置文件 ~/.dsh-mneme/cli.json（由 \`config set\` 写入）
  未配置时使用默认地址：${DEFAULT_URL}

命令：
  config set <url> <token>     写入配置文件（token 省略时保留原值）
  config show                  查看当前配置（token 打码显示）
  config path                  打印配置文件路径
  status                       服务状态（版本 / 记忆统计 / 实体 / 运行时长）
  list [--type t] [--min-importance n] [--source s]
       [--limit n] [--offset n] [--json]
                               列出记忆（type: preference | project | decision | summary | history）
  search <query> [--mode m] [--topk n] [--json]
                               搜索记忆（mode: keyword | vector | auto）
  get <id> [--json]            查看单条记忆
  add --type <t> --title <t> --content <c>
      [--importance n] [--tags a,b] [--source s] [--json]
                               新增记忆（type: preference | project | decision | summary | history）
  delete <id>                  删除记忆
  reclaim [--older-than n] [--apply] [--vacuum] [--json]
                               存储无损回收（默认只报数字，不动数据）
                               --older-than n  输入快照保留窗口（天，默认 7；0 = 全部）
                               --apply         真的执行（不带就是 dry-run）
                               --vacuum        执行后整库 VACUUM（需配 --apply）
                               只清「可由记忆库重建的输入快照」与「归档行的向量」，
                               一条记忆都不删；收益按 VACUUM 前后体积量

选项：
  --url <url>                  覆盖服务地址
  --token <token>              覆盖访问 token
  --json                       输出原始 JSON
  -h, --help                   显示本帮助
  -V, --version                显示版本号

说明：
  token 在 DSH 面板「设置 → 外部访问」或插件设置中查看；
  除 GET /health 外，所有外部 API 路由均需 Bearer token。

示例：
  ${CLI_NAME} config set ${DEFAULT_URL} my-token
  ${CLI_NAME} status
  ${CLI_NAME} list --type project --limit 10
  ${CLI_NAME} search "部署流程" --mode vector --topk 5
  ${CLI_NAME} add --type decision --title "采用 SQLite" --content "存储层使用 node:sqlite" --importance 4 --tags 存储,决策
  ${CLI_NAME} get 42
  ${CLI_NAME} delete 42
  ${CLI_NAME} reclaim                       （先看：会清几行、库多大）
  ${CLI_NAME} reclaim --apply --vacuum      （确认后执行，并把空间真的收回来）`;

/* ---------------------------------- 参数解析 ---------------------------------- */

// `--flag value` 形态下，「下一个词以 -- 开头就别当值」这条规则有一个致命反例：
// 值本身就可能是 `--` 开头的字符串。外部 API 的 token 由
// `crypto.randomBytes(24).toString("base64url")` 生成（src/api-standalone.js），
// base64url 的字母表含 `-`，所以约 1/4096 的 token 头两位恰好都是 `-`：
//
//   dsh-mneme reclaim --url http://127.0.0.1:55423 --token --UYoOHxr6PtE2-bfqW...
//
// 旧规则把 `--UYoOHxr6PtE2-bfqW...` 当成一个新旗标（键名 `uyoohxr6pte2-bfqw...`），
// 于是 token 解析成 `true`，flagValue 视作「没给」→ 退回环境变量/配置文件 → 全空
// → 报「未配置访问 token」。而 CLI 生成 token 的另一半同样会撞：`--token=--abc`
// 走等号分支没事，`--token --abc` 就废。这不是测试的随机性，是真实用户的随机性。
//
// 修法：区分「已知旗标」与「未知词」。下一个词以 `--` 开头时，只有它确实是一个
// 已注册的旗标才当作旗标，否则当作当前 flag 的值。于是 `--limit --json` 仍按
// 旧语义把 --json 当旗标，而 `--token --UYo...` 正确取到 token。
// 已知旗标表必须与下面 flagValue/flagBool 的实际用法保持同步；漏登记的代价是
// 该旗标被当成值吞掉，所以 test/cli-flag-value.test.js 用文本锁对齐两者。
const KNOWN_FLAGS = new Set([
  // 取值的旗标
  'url', 'token', 'type', 'title', 'content', 'importance', 'tags', 'source',
  'limit', 'offset', 'mode', 'topk', 'top-k', 'min-importance', 'minimportance',
  'older-than', 'olderthandays',
  // 布尔旗标
  'apply', 'vacuum', 'json', 'help', 'version'
]);

/** `--foo=bar` / `--foo` 取出小写键名；非旗标词返回 null。 */
function flagKeyOf(word) {
  if (typeof word !== 'string' || !word.startsWith('--') || word === '--') return null;
  const key = word.slice(2);
  const eq = key.indexOf('=');
  return (eq >= 0 ? key.slice(0, eq) : key).toLowerCase();
}

function parseArgv(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      let key = arg.slice(2);
      let value;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else {
        const next = argv[i + 1];
        const nextIsFlag = next !== undefined && flagKeyOf(next) !== null && KNOWN_FLAGS.has(flagKeyOf(next));
        if (next !== undefined && next !== '--' && !nextIsFlag) {
          value = argv[++i];
        } else {
          value = true;
        }
      }
      flags[key.toLowerCase()] = value;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function flagValue(flags, ...names) {
  for (const name of names) {
    const value = flags[name.toLowerCase()];
    if (value !== undefined && value !== true && value !== '') return value;
  }
  return undefined;
}

function flagBool(flags, ...names) {
  for (const name of names) {
    const value = flags[name.toLowerCase()];
    if (value !== undefined) return value === true || value === 'true' || value === '';
  }
  return false;
}

/* ---------------------------------- 配置解析 ---------------------------------- */

function readConfigFile() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function resolveConfig(flags) {
  const file = readConfigFile();
  const url =
    firstNonEmpty(flagValue(flags, 'url'), process.env.DSH_MNEME_URL, file.url) ?? DEFAULT_URL;
  const token =
    firstNonEmpty(flagValue(flags, 'token'), process.env.DSH_MNEME_TOKEN, file.token) ?? '';
  return { url: url.replace(/\/+$/, ''), token, jsonMode: false };
}

function maskToken(token) {
  if (!token) return '(未设置)';
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}

/* ---------------------------------- 输出与错误 ---------------------------------- */

function stringify(value) {
  return JSON.stringify(value, null, 2);
}

function fail(cfg, message, { rawJson } = {}) {
  if (cfg.jsonMode) {
    console.error(rawJson !== undefined ? rawJson : stringify({ error: message }));
  } else {
    console.error(message);
  }
  process.exit(1);
}

function failHttp(cfg, status, pathname, data, text) {
  const serverError =
    data && typeof data === 'object' && data.error
      ? String(data.error)
      : (text || '').slice(0, 200);
  let hint = '';
  if (status === 401) {
    hint =
      `\n访问 token 缺失或无效。token 可在 DSH 面板「设置 → 外部访问」或插件设置中查看，\n` +
      `然后用 \`${CLI_NAME} config set <url> <token>\`、环境变量 DSH_MNEME_TOKEN 或 --token 配置。`;
  } else if (status === 404) {
    hint = `\n资源不存在：${pathname}`;
  }
  fail(cfg, `请求失败（HTTP ${status}）${serverError ? `：${serverError}` : ''} [${pathname}]${hint}`, {
    rawJson: cfg.jsonMode && text ? text : undefined,
  });
}

function failNetwork(cfg, url, err) {
  const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
  const reason = timedOut
    ? `请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒）`
    : `无法连接到服务（${err?.code ?? err?.cause?.code ?? err?.message ?? '未知错误'}）`;
  fail(
    cfg,
    `${reason}：${url}\n` +
      `请确认 DSH 已启动、插件外部 API 已开启，且地址正确（默认 ${DEFAULT_URL}）。`
  );
}

function requireToken(cfg) {
  if (cfg.token) return;
  fail(
    cfg,
    [
      '未配置访问 token，无法调用该命令（外部 API 需要 Bearer 鉴权）。',
      '',
      'token 可在 DSH 面板「设置 → 外部访问」或插件设置中查看，然后任选其一配置：',
      `  1. ${CLI_NAME} config set <url> <token>`,
      '  2. 环境变量 DSH_MNEME_TOKEN=<token>',
      '  3. 命令行参数 --token <token>',
    ].join('\n')
  );
}

function parseIntArg(cfg, value, label) {
  if (value === undefined || value === true || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    fail(cfg, `无效的 ${label}: ${value}（应为非负整数）`);
  }
  return n;
}

/* ---------------------------------- HTTP 请求 ---------------------------------- */

async function apiRequest(cfg, method, pathname, { query, body } = {}) {
  let url = cfg.url + pathname;
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        params.set(key, String(value));
      }
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers = { Accept: 'application/json' };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    failNetwork(cfg, url, err);
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // 非 JSON 响应体，保留原始文本用于报错展示
  }

  if (!res.ok) {
    failHttp(cfg, res.status, pathname, data, text);
  }
  return data;
}

/* ---------------------------------- 结果格式化 ---------------------------------- */

function formatTimestamp(value) {
  if (!value) return '';
  const s = String(value);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function formatMemoryLine(item) {
  const id = item?.id ?? '?';
  const type = item?.type ?? '?';
  const importance = item?.importance != null ? ` ★${item.importance}` : '';
  const title = item?.title ? ` ${item.title}` : '';
  const tags =
    Array.isArray(item?.tags) && item.tags.length ? ` [${item.tags.join(',')}]` : '';
  const date = formatTimestamp(item?.created_at ?? item?.createdAt);
  return `  #${id}  [${type}]${importance}${title}${tags}${date ? ` (${date})` : ''}`;
}

function printMemoryItems(payload, { withMode = false } = {}) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const total = payload?.total ?? items.length;
  if (withMode && payload?.mode) console.log(`搜索模式: ${payload.mode}`);
  console.log(`共 ${total} 条，本次显示 ${items.length} 条`);
  if (!items.length) return;
  console.log('');
  for (const item of items) {
    const score = item?.score ?? item?.similarity;
    const scoreText =
      typeof score === 'number' && Number.isFinite(score) ? ` (score ${score.toFixed(3)})` : '';
    console.log(formatMemoryLine(item) + scoreText);
    const content =
      typeof item?.content === 'string' ? item.content.replace(/\s+/g, ' ').trim() : '';
    if (content) {
      console.log(`      ${content.length > 80 ? `${content.slice(0, 80)}…` : content}`);
    }
  }
}

function printMemoryDetail(item) {
  if (!item || typeof item !== 'object') {
    console.log(stringify(item ?? null));
    return;
  }
  const fields = [];
  if (item.id !== undefined) fields.push(`id: ${item.id}`);
  if (item.type !== undefined) fields.push(`类型: ${item.type}`);
  if (item.importance !== undefined) fields.push(`重要性: ${item.importance}`);
  if (item.title !== undefined) fields.push(`标题: ${item.title}`);
  if (item.tags !== undefined) {
    fields.push(`标签: ${Array.isArray(item.tags) ? item.tags.join(', ') : item.tags}`);
  }
  if (item.source !== undefined) fields.push(`来源: ${item.source}`);
  const created = item.created_at ?? item.createdAt;
  if (created) fields.push(`创建时间: ${created}`);
  for (const line of fields) console.log(line);
  if (item.content !== undefined) console.log(`\n${item.content}`);
}

function printStatus(data) {
  console.log(`服务版本: ${data?.version ?? '?'}`);
  console.log(`运行时长: ${data?.uptime_s ?? data?.uptimeS ?? '?'} 秒`);
  const memories = data?.memories ?? {};
  console.log(`记忆总数: ${memories.total ?? '?'}`);
  const byType = memories.byType;
  if (Array.isArray(byType)) {
    for (const row of byType) {
      console.log(`  - ${row?.type ?? row?.name ?? '?'}: ${row?.count ?? row?.total ?? '?'}`);
    }
  } else if (byType && typeof byType === 'object') {
    for (const [type, count] of Object.entries(byType)) {
      console.log(`  - ${type}: ${count}`);
    }
  }
  const entities = data?.entities;
  if (entities != null) {
    const total =
      typeof entities === 'object' && !Array.isArray(entities)
        ? entities.total
        : entities;
    console.log(`实体数量: ${total ?? '?'}`);
  }
}

/* ---------------------------------- 子命令 ---------------------------------- */

async function cmdConfig(cfg, sub, rest) {
  const subCmd = sub || 'show';

  if (subCmd === 'set') {
    const [url, tokenArg] = rest;
    if (!url) {
      fail(
        cfg,
        `用法: ${CLI_NAME} config set <url> <token>\n示例: ${CLI_NAME} config set ${DEFAULT_URL} my-token`
      );
    }
    if (!/^https?:\/\//i.test(url)) {
      fail(cfg, `无效的服务地址: ${url}（应以 http:// 或 https:// 开头）`);
    }
    const existing = readConfigFile();
    const token = tokenArg ?? existing.token ?? '';
    await fsp.mkdir(CONFIG_DIR, { recursive: true });
    await fsp.writeFile(CONFIG_PATH, `${JSON.stringify({ url, token }, null, 2)}\n`, 'utf8');
    if (cfg.jsonMode) {
      console.log(stringify({ configPath: CONFIG_PATH, url, tokenConfigured: Boolean(token) }));
    } else {
      console.log(`已写入配置文件: ${CONFIG_PATH}`);
      console.log(`  url: ${url}`);
      console.log(`  token: ${maskToken(token)}`);
    }
    return;
  }

  if (subCmd === 'show') {
    const hasFile = fs.existsSync(CONFIG_PATH);
    const file = readConfigFile();
    if (cfg.jsonMode) {
      console.log(
        stringify({
          configPath: CONFIG_PATH,
          configExists: hasFile,
          url: file.url ?? DEFAULT_URL,
          token: maskToken(file.token),
        })
      );
      return;
    }
    if (!hasFile) {
      console.log(`尚未创建配置文件（未配置）: ${CONFIG_PATH}`);
      console.log('');
      console.log(`可运行 \`${CLI_NAME} config set <url> <token>\` 创建配置；`);
      console.log('token 可在 DSH 面板「设置 → 外部访问」或插件设置中查看。');
      console.log(
        `未配置时使用默认地址 ${DEFAULT_URL}，也可用环境变量 DSH_MNEME_URL / DSH_MNEME_TOKEN。`
      );
      return;
    }
    console.log(`配置文件: ${CONFIG_PATH}`);
    console.log(`  url: ${file.url ?? `(未设置，默认 ${DEFAULT_URL})`}`);
    console.log(`  token: ${maskToken(file.token)}`);
    console.log('');
    console.log('配置优先级: --url/--token > 环境变量 DSH_MNEME_URL / DSH_MNEME_TOKEN > 配置文件');
    return;
  }

  if (subCmd === 'path') {
    console.log(CONFIG_PATH);
    return;
  }

  fail(cfg, `未知的 config 子命令: ${subCmd}\n可用子命令: set / show / path`);
}

async function cmdStatus(cfg) {
  requireToken(cfg);
  const data = await apiRequest(cfg, 'GET', '/status');
  if (cfg.jsonMode) {
    console.log(stringify(data));
  } else {
    printStatus(data);
  }
}

async function cmdList(cfg, flags) {
  requireToken(cfg);
  const query = {
    type: flagValue(flags, 'type'),
    minImportance: parseIntArg(cfg, flagValue(flags, 'min-importance', 'minImportance'), '--min-importance'),
    source: flagValue(flags, 'source'),
    limit: parseIntArg(cfg, flagValue(flags, 'limit'), '--limit'),
    offset: parseIntArg(cfg, flagValue(flags, 'offset'), '--offset'),
  };
  const data = await apiRequest(cfg, 'GET', '/memories', { query });
  if (cfg.jsonMode) {
    console.log(stringify(data));
  } else {
    printMemoryItems(data);
  }
}

async function cmdSearch(cfg, rest, flags) {
  requireToken(cfg);
  const q = rest[0];
  if (!q) {
    fail(
      cfg,
      `用法: ${CLI_NAME} search <query> [--mode m] [--topk n]\n` +
        `示例: ${CLI_NAME} search "部署流程" --mode vector --topk 5`
    );
  }
  const mode = flagValue(flags, 'mode');
  if (mode !== undefined && !SEARCH_MODES.includes(mode)) {
    fail(cfg, `无效的 --mode: ${mode}（可选: ${SEARCH_MODES.join(' | ')}）`);
  }
  const topK = parseIntArg(cfg, flagValue(flags, 'topk', 'top-k', 'topK'), '--topk');
  const data = await apiRequest(cfg, 'GET', '/search', { query: { q, mode, topK } });
  if (cfg.jsonMode) {
    console.log(stringify(data));
  } else {
    printMemoryItems(data, { withMode: true });
  }
}

async function cmdGet(cfg, rest) {
  requireToken(cfg);
  const id = rest[0];
  if (!id) {
    fail(cfg, `用法: ${CLI_NAME} get <id> [--json]`);
  }
  const data = await apiRequest(cfg, 'GET', `/memories/${encodeURIComponent(id)}`);
  if (cfg.jsonMode) {
    console.log(stringify(data));
  } else {
    printMemoryDetail(data);
  }
}

async function cmdAdd(cfg, flags) {
  requireToken(cfg);
  const type = flagValue(flags, 'type');
  const title = flagValue(flags, 'title');
  const content = flagValue(flags, 'content');
  if (!type || !title || !content) {
    fail(
      cfg,
      `用法: ${CLI_NAME} add --type <${MEMORY_TYPES.join('|')}> --title <标题> --content <内容>\n` +
        `      [--importance n] [--tags a,b] [--source s]\n\n` +
        `示例: ${CLI_NAME} add --type decision --title "采用 SQLite" --content "存储层使用 node:sqlite"`
    );
  }
  if (!MEMORY_TYPES.includes(type)) {
    fail(cfg, `无效的 --type: ${type}（可选: ${MEMORY_TYPES.join(' | ')}）`);
  }
  const importanceRaw = flagValue(flags, 'importance');
  let importance;
  if (importanceRaw !== undefined) {
    importance = Number(importanceRaw);
    if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
      fail(cfg, `无效的 --importance: ${importanceRaw}（应为 1-5 的整数）`);
    }
  }
  const tagsRaw = flagValue(flags, 'tags');
  const tags =
    tagsRaw !== undefined
      ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean)
      : undefined;
  const source = flagValue(flags, 'source');

  const body = { type, title, content };
  if (importance !== undefined) body.importance = importance;
  if (tags) body.tags = tags;
  if (source) body.source = source;

  const data = await apiRequest(cfg, 'POST', '/memories', { body });
  if (cfg.jsonMode) {
    console.log(stringify(data));
  } else {
    console.log('已添加记忆:');
    printMemoryDetail(data);
  }
}

async function cmdDelete(cfg, rest) {
  requireToken(cfg);
  const id = rest[0];
  if (!id) {
    fail(cfg, `用法: ${CLI_NAME} delete <id>`);
  }
  const data = await apiRequest(cfg, 'DELETE', `/memories/${encodeURIComponent(id)}`);
  if (cfg.jsonMode) {
    console.log(stringify(data));
  } else {
    console.log(`已删除记忆 ${id}`);
  }
}

function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '?';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function printReclaim(report, { applied }) {
  const planned = report?.planned ?? {};
  const cleared = report?.cleared ?? {};
  const columnBytes = report?.column_bytes ?? {};
  const size = report?.size ?? {};
  console.log(`存储无损回收（${applied ? '已执行' : 'dry-run，未改动任何数据'}）`);
  console.log(`  输入快照保留窗口: ${report?.olderThanDays ?? '?'} 天（cutoff ${report?.cutoff ?? '?'}）`);
  // 第三项（#399）：蒸馏原文的到期裁剪同样只删 distill_records，溯源链接刻意保留
  const rows = (o) =>
    `dream_runs.input ${o.dream_run_inputs ?? 0} 行 / 归档行向量 ${o.archived_embeddings ?? 0} 行 / 蒸馏原文 ${o.distill_records ?? 0} 行`;
  console.log(`  ${applied ? '已清理' : '将清理'}: ${rows(applied ? cleared : planned)}`);
  console.log(
    `  列文本大小（上界，非回收量）: ${formatBytes(columnBytes.dream_run_inputs)} / ${formatBytes(columnBytes.archived_embeddings)} / ${formatBytes(columnBytes.distill_records)}`
  );
  if (!applied) {
    console.log(
      `  库文件: ${formatBytes(size.before_bytes)}（空闲页 ${size.freelist_pages ?? '?'} 页，可立刻回收约 ${formatBytes(size.freelist_bytes)}）`
    );
    console.log('');
    console.log('  上面是 dry-run 的数字。确认后执行：');
    console.log(`    ${CLI_NAME} reclaim --apply --vacuum`);
    return;
  }
  const freed =
    typeof size.before_bytes === 'number' && typeof size.after_bytes === 'number'
      ? size.before_bytes - size.after_bytes
      : null;
  if (report?.vacuum?.error) {
    console.log(`  VACUUM: 失败（${String(report.vacuum.error).slice(0, 120)}）`);
    console.log('    清理已经完成且不可逆，文件暂时不会变小；库多半被别的进程占着锁，');
    console.log('    稍后重跑一次 `reclaim --apply --vacuum` 即可（清理是幂等的）。');
  } else {
    console.log(
      `  VACUUM: ${report?.vacuum?.ran ? `已跑（${report.vacuum.duration_ms ?? '?'} ms）` : '未跑（未带 --vacuum，文件不会变小）'}`
    );
  }
  console.log(
    `  库文件: ${formatBytes(size.before_bytes)} → ${formatBytes(size.after_bytes)}` +
      (freed !== null && freed > 0 ? `（释放 ${formatBytes(freed)}）` : '')
  );
  console.log(`  耗时: ${report?.duration_ms ?? '?'} ms`);
  if (report?.receipt) console.log(`  回执: llm_audit_logs #${report.receipt}`);
}

async function cmdReclaim(cfg, flags) {
  requireToken(cfg);
  const applied = flagBool(flags, 'apply');
  const vacuum = flagBool(flags, 'vacuum');
  if (vacuum && !applied) {
    fail(
      cfg,
      `--vacuum 需要配 --apply：dry-run 不改数据，也就没有可回收的页。\n` +
        `先看数字，再执行：${CLI_NAME} reclaim --apply --vacuum`
    );
  }
  const olderThanDays = parseIntArg(cfg, flagValue(flags, 'older-than', 'olderThanDays'), '--older-than');
  const body = { dryRun: !applied };
  if (applied) {
    // 服务端要求显式确认：这两步不可逆，缺 confirm 只会拿回一份 dry-run 报告。
    body.confirm = true;
  }
  if (olderThanDays !== undefined) body.olderThanDays = olderThanDays;
  if (vacuum) body.vacuum = true;
  const data = await apiRequest(cfg, 'POST', '/maintenance/reclaim', { body });
  if (cfg.jsonMode) {
    console.log(stringify(data));
  } else {
    printReclaim(data, { applied });
  }
}

/* ---------------------------------- 入口 ---------------------------------- */
async function main(argv) {
  const { positionals, flags } = parseArgv(argv);
  const cmd = positionals[0];
  const rest = positionals.slice(1);

  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(USAGE);
    return;
  }
  if (cmd === '-V' || cmd === '--version' || cmd === 'version') {
    console.log(PKG_VERSION);
    return;
  }

  const cfg = resolveConfig(flags);
  cfg.jsonMode = flagBool(flags, 'json');

  switch (cmd) {
    case 'config':
      return cmdConfig(cfg, rest[0], rest.slice(1));
    case 'status':
      return cmdStatus(cfg);
    case 'list':
    case 'ls':
      return cmdList(cfg, flags);
    case 'search':
      return cmdSearch(cfg, rest, flags);
    case 'get':
      return cmdGet(cfg, rest);
    case 'add':
      return cmdAdd(cfg, flags);
    case 'delete':
    case 'rm':
      return cmdDelete(cfg, rest);
    case 'reclaim':
      return cmdReclaim(cfg, flags);
    default:
      fail(cfg, `未知命令: ${cmd}\n运行 \`${CLI_NAME} --help\` 查看帮助。`);
  }
}

// 直接运行才进 main（import 只取 parseArgv 做单测时必须安静）：npm 全局安装走
// node_modules/.bin 的符号链接，argv[1] 是链接路径而非真身，所以要 realpath 两侧
// 再比，不能用字符串相等。
const invokedDirectly = (() => {
  if (process.argv[1] == null) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err?.stack ?? String(err));
    process.exit(1);
  });
}

export { parseArgv, KNOWN_FLAGS, flagValue, flagBool, flagKeyOf };
