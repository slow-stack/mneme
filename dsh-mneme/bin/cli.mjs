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
  share [--alias 名字] [--type a,b] [--tag 标签] --out <文件>
                               打一个可外发的脱敏分享包（不改库，纯读）
                               --alias 名字     在包里署名，对方看到的是这个而不是你的路径
                               --type/--tag     收窄到某几类/某个标签（超限分批用这两个）
                               --out <文件>     写出包文件；--dry-run 只报数不落盘
                               跳过归档/已遗忘/只读指针行/summary，密钥 PII 整条不进包
  receive <包文件> [--apply]
                               把对方 share 出来的包吃进自己的库（默认干跑，一个字都不写）
                               外来行标 source=imported，不参与本机的巩固/降级，也不并入你的条目
                               --apply 才真的写；重复吃同一个包不会多出第二份
  undo-share <包文件> [--apply]
                               按 pack_id 收起整包（物删：包还能重新导入，归档位会占住 UNIQUE）

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
  ${CLI_NAME} reclaim --apply --vacuum      （确认后执行，并把空间真的收回来）
  ${CLI_NAME} share --dry-run               （先看：会进几条、为什么跳过那些，不落盘）
  ${CLI_NAME} share --out pack.json         （写包；~/… 由 CLI 自己展开，PowerShell/cmd 不会）
  ${CLI_NAME} receive pack.json             （吃包：默认干跑，只报账，一个字都不写）
  ${CLI_NAME} receive pack.json --apply     （确认数字后真的吃进自己的库；重跑同一个包 created=0）
  ${CLI_NAME} undo-share pack.json --apply  （按包里那个 pack_id 整包收回：物删，之后还能重新导入）`;

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
  'alias', 'tag', 'out',
  // 布尔旗标
  'apply', 'vacuum', 'json', 'help', 'version',
  'dry-run', 'dryrun',
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
  // 拒答体自己带的下一步必须转出去，不然命令侧只能再写一份错误分支。撞上的这一刀是
  // share 的 413：响应体是 {error:"too-large", bytes, limitBytes, hint, report}，
  // 旧实现只取 data.error，于是现场只剩「请求失败（HTTP 413）：too-large」——「大了
  // 多少」与「用 --type/--tag 分批」那两句留在体里没人看得见（措辞只许有一份，就在
  // 拒发的那侧，同 RECLAIM_CONFIRM_HINT 的口径）。完整 report（含 skip_list）走
  // --json：下面 rawJson 把整个响应体原样交给 stderr，这里不复制第二份打印器。
  //
  // 已知取舍（C10 记档，见 docs/SHARE.md「已知还没做」）：这里只转 hint / bytes /
  // limitBytes 三样，所以 receive 那侧 400 的 `detail`（闸门指到哪一格）与数据面 413 的
  // `limit` 到不了人类可读的输出。刻意不补：补一格就得在这里多一条按路由分支的判断，
  // 而「错误文案只许有一份」是 #411 那条纪律的另一半。要逐格看就加 --json——rawJson
  // 那行给的正是原样响应体，一格都不丢。
  if (data && typeof data === 'object') {
    if (typeof data.hint === 'string' && data.hint.trim()) hint += `\n${data.hint.trim()}`;
    if (Number.isFinite(data.bytes) && Number.isFinite(data.limitBytes)) {
      hint += `\n量到 ${formatBytes(data.bytes)}，水位 ${formatBytes(data.limitBytes)}`;
    }
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

// --out 的例子写的是 `~/Desktop/pack.json`。Git Bash 会替她展开，PowerShell 与 cmd
// 不会——那两侧 `~/…` 是字面量，writeFileSync 直接 ENOENT，现场只剩一坨堆栈。CLI 不
// 接管 shell 的活，但引号里这一格得自己补（同 CONFIG_DIR 走 os.homedir()）。
function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p !== '~' && !p.startsWith('~/') && !p.startsWith('~\\')) return p;
  const rest = p.slice(1).replace(/^[/\\]+/, '');
  return path.join(os.homedir(), rest);
}

function printShare(pack, { dryRun }) {
  const r = pack?.report ?? {};
  const s = r.skipped ?? {};
  console.log(`${dryRun ? '干跑报告' : '分享包'}: ${r.included ?? 0} 条` +
    (pack?.alias ? `  来自 ${pack.alias}` : ''));
  const named = [['archived', '归档'], ['forgotten', '已遗忘'], ['readonly_type', '只读指针行'],
    ['excluded_type', '不随包走'], ['blank_or_noise', '空白/噪声'], ['sensitive', '密钥/PII']];
  const parts = named.filter(([k]) => (s[k] ?? 0) > 0).map(([k, zh]) => `${zh} ${s[k]}`);
  console.log(`  跳过: ${parts.length ? parts.join(', ') : '无'}`);
  // 折叠不是跳过：那条记忆够格进包，只是包里已经有了它（同标题同正文同内容锚、scope
  // 不同的两条）。不印出来的话 `included` 会比她心里的「够格的条数」少几条，而那正好是
  // 会让人怀疑口径少发了的那类差额。src/share.js 的 report.deduped。
  if ((r.deduped ?? 0) > 0) console.log(`  包内重复已折叠: ${r.deduped} 条（对面只吃一条）`);
  for (const item of (r.skip_list ?? []).slice(0, 20)) {
    // 标题为空有两种：这条本来没标题，或它整行被密钥判据命中、标题在源头就留空了
    // （src/share.js：skip_list 随包外发，而凭据常常就写在标题里）。终端要让人看清
    // 后一种是「有意不给」，不是「数据缺失」。
    console.log(`    - [${item.reason}] ${item.title || '（标题不外发）'}`);
  }
  // 判据用「六个计数之和 > 清单长度」而不是「清单等于 50」：前者是「账比清单长」这个事实本身，
  // 恰好 50 条被跳时后者会误报截断（面板侧同一条判据）。50 这个数不在这里出现，
  // 水位改了判据仍然对。
  const skippedTotal = ['archived', 'forgotten', 'readonly_type', 'excluded_type', 'blank_or_noise', 'sensitive']
    .reduce((n, k) => n + (r.skipped?.[k] ?? 0), 0);
  if (skippedTotal > (r.skip_list ?? []).length) console.log('    … 跳过清单已截断，计数仍为全量');
  if (dryRun) console.log(`  没写文件：加 --out <路径> 才会落盘`);
  else console.log(`  发给对方即可，她用自己的 ${CLI_NAME} receive 吃进去`);
}

async function cmdShare(cfg, flags) {
  requireToken(cfg);
  const out = expandHome(flagValue(flags, 'out'));
  const dryRun = flagBool(flags, 'dry-run') || flagBool(flags, 'dryrun');
  if (!out && !dryRun) {
    fail(
      cfg,
      `share 要么写文件（--out <路径>），要么只看报告（--dry-run）：` +
        `不写文件又把整库打到 stdout 会让报告被 JSON 淹掉。\n` +
        `例子：${CLI_NAME} share --out ~/Desktop/pack.json`
    );
  }
  const typeRaw = flagValue(flags, 'type');
  const body = {};
  if (typeRaw) body.type = typeRaw.split(',').map((t) => t.trim()).filter(Boolean);
  const alias = flagValue(flags, 'alias');
  if (alias) body.alias = alias;
  const tag = flagValue(flags, 'tag');
  if (tag) body.tag = tag;
  // 超水位那次服务端答 413，apiRequest 对非 2xx 走的是 failHttp：它把响应体里的 hint
  // 与量到的字节转出去再 exit(1)。所以这里**没有**可达的 error 分支——加 `if
  // (pack?.error)` 就是第二份出口，措辞迟早跟拒发那一侧分家（#411 的同一口径）。
  const pack = await apiRequest(cfg, 'POST', '/share', { body });
  const r = pack?.report ?? {};
  if (cfg.jsonMode) {
    console.log(stringify(dryRun ? { report: r, pack } : { report: r, file: out }));
  } else {
    printShare(pack, { dryRun });
  }
  if (dryRun) return;
  fs.writeFileSync(out, JSON.stringify(pack), 'utf8');
  // --json 时 stdout 只许那一份 JSON：后面追一行「已写出」会把 JSON.parse 撞在
  // position 536（jq 同理）。落盘路径已在上面的 payload 里（file 键），这行只对
  // 人有用，就只给人看（同 cmdReclaim：json 模式打印完就结束）。
  if (!cfg.jsonMode) console.log(`  已写出: ${out}`);
}

// 入库面（车道 C）。包文件在**本地**读、把包内容整个送上去：服务端永远看不到路径，
// 也就不需要任何文件系统权限——这是 receive 协议选「传包不传路径」的全部理由。
// confirm 的脾气照 reclaim：缺省即干跑，写收件人的库（或物删整包）要 --apply 显式确认。
async function cmdReceive(cfg, rest, flags) {
  requireToken(cfg);
  const file = rest[0];
  if (!file) {
    fail(cfg, `receive 需要包文件：${CLI_NAME} receive <包文件>（不带 --apply 只干跑，一个字都不写）`);
  }
  let pack;
  try {
    pack = JSON.parse(fs.readFileSync(expandHome(file), 'utf8'));
  } catch (e) {
    // 读坏/读不到都在发请求之前拒掉：半读出来的包发过去只会换回一个闸门错，
    // 而那一格现场已经说不清是「文件本来就这样」还是「传输坏了」。
    fail(cfg, `读不到包文件 ${file}：${String(e?.message ?? e)}\n包文件是对方 ${CLI_NAME} share --out 出来的那个 .json。`);
  }
  const applied = flagBool(flags, 'apply');
  const body = { pack };
  if (applied) body.confirm = true;
  const data = await apiRequest(cfg, 'POST', '/receive', { body });
  if (cfg.jsonMode) {
    console.log(stringify(data));
    return;
  }
  printReceive(data, { applied });
  if (!applied) console.log('  没写库：确认数字之后加 --apply 真的导入');
}

// 撤销收的是**包文件**而不是裸 pack_id：让人抄 16 位十六进制去删自己库里的行，
// 抄错一位就是「删了个没删成的包还自以为收掉了」。pack_id 就写在包文件第一层。
async function cmdUndoShare(cfg, rest, flags) {
  requireToken(cfg);
  const file = rest[0];
  if (!file) {
    fail(cfg, `undo-share 需要当初那个包文件（pack_id 从文件里取）：${CLI_NAME} undo-share <包文件> [--apply]`);
  }
  let pack;
  try {
    pack = JSON.parse(fs.readFileSync(expandHome(file), 'utf8'));
  } catch (e) {
    fail(cfg, `读不到包文件 ${file}：${String(e?.message ?? e)}\n要的是当初 ${CLI_NAME} share --out 出来、发给对面那个 .json。`);
  }
  // trim 在这儿做：只有空格的 pack_id 与「没有 pack_id」是同一种「这个文件收不了」，
  // 放它出门只是绕一圈换回 400 missing-pack-id，而那一格会被读成服务端的问题（服务端
  // parseUndoBody 同样 trim，这里不改它的行为，只是不必为空格 round-trip）。
  const packId = typeof pack?.pack_id === 'string' ? pack.pack_id.trim() : '';
  if (!packId) {
    fail(cfg, `这个文件里没有 pack_id，收起不了：${file}\nundo-share 收的是整包，编号就写在包文件的第一层，不用也不该手抄 16 位十六进制。`);
  }
  const applied = flagBool(flags, 'apply');
  const body = { packId };
  if (applied) body.confirm = true;
  const data = await apiRequest(cfg, 'POST', '/receive/undo', { body });
  if (cfg.jsonMode) {
    console.log(stringify(data));
    return;
  }
  printReceive({ ...data, created: data?.deleted, alias: '' }, { applied, undo: true });
  if (!applied) console.log('  没删：确认条数之后加 --apply 真的收起这个包');
}

function printReceive(d, { applied, undo = false }) {
  const conflicts = Array.isArray(d?.title_conflicts) ? d.title_conflicts : [];
  console.log(`${undo ? (applied ? '已收起' : '将收起') : applied ? '已导入' : '干跑'}: ${d?.created ?? 0} 条` +
    (d?.alias ? `  来自 ${d.alias}` : '') + (d?.skipped_existing ? `  已存在 ${d.skipped_existing}` : ''));
  if (undo && applied) {
    // 服务端是物删不是归档（src/share-import.js 的 deleteSharePack）：这句话是 --apply
    // 与人之间唯一的说明书，不许软化成「移除」。干跑那一笔一个字都没动，说「直接从库里
    // 带走」是假话，还会把下面的样例压成「已经删掉的这几条」——干跑那侧的话术是 cmdUndo-
    // Share 结尾的「没删：…加 --apply」，两句不许同时出现（同一件事说两遍就没人细看）。
    console.log('  物删：这些行直接从库里带走，不是归档；包文件还在，重新 receive 一遍即可再来');
  }
  if (conflicts.length) {
    // 撞名是 advisory 读数（src/share-import.js：只对本轮真正会新建的条目判），
    // 所以这里只说「这几条要你看一眼」，永远不许说「除此之外没有别的撞名」。
    console.log(`  撞名提醒：和你自己的条目同名 ${conflicts.length} 条（同类型同标题，不会被并入，需要你处置）：`);
    for (const c of conflicts.slice(0, 10)) console.log(`    - [${c.type}] ${c.title}`);
    if (conflicts.length > 10) console.log('    … 只列前 10 条');
  }
  const sample = Array.isArray(d?.sample) ? d.sample : [];
  if (sample.length) {
    // 撞名那段有标题、有截断话，样例这段原先两样都没有：服务端把 sample 截到 20
    // （src/share-import.js 的 DELETE_SAMPLE_MAX），CLI 再截到 10，而 deleted 才是全集。
    // 一个 500 行的包就这样留下 10 条无名要点，人会当成「要收走的就是这些」。
    // 全集那一格只报服务端的数，不报「还剩几条」——两次截断混在一起就没人能对得上账。
    console.log('  样例：下面只是这一批里的几条，不是全部清单');
    const shown = sample.slice(0, 10);
    for (const s of shown) console.log(`    · [${s.type}] ${s.title}`);
    const total = typeof d?.deleted === 'number' ? d.deleted : (d?.created ?? 0);
    if (shown.length < total) console.log(`    … 只列前 ${shown.length} 条；整批共 ${total} 条（这个数来自服务端计数）`);
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
    case 'share':
      return cmdShare(cfg, flags);
    case 'receive':
      return cmdReceive(cfg, rest, flags);
    case 'undo-share':
      return cmdUndoShare(cfg, rest, flags);
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
