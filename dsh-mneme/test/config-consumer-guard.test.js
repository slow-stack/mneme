// #719 / #641 收尾：把「同一配置键被 N 处各自 if 一遍」这件事写成可执行的守卫。
//
// 为什么需要这个文件：冲突档位那两个键（conflictFreezeEnabled / conflictLedgerMode）
// 曾经被三处各解析一遍，给出三种互不一致的结果——不报错、不崩，只是让注入侧说
// 「有矛盾」而处置侧一次都没跑。这类缺陷靠人眼看 diff 抓不住，只能靠机械判据。
//
// 两条判据（本文件就是它们）：
//   1. 单源键登记表：声明「这个键只允许在某个文件里读」，别处读到就红。
//   2. 状态枚举写者表：枚举成员必须有写入点，或显式登记「本仓库不写它，原因如下」。
//
// 判据刻意不写成「所有键都要单源」——那会让 dreamProvider 这类天生要被
// dream.js 与 sleep.js 一起读的键全部误报，逼出一份巨大的放宽清单，最后变成
// 永远绿的假守卫。只登记「一旦分叉就会让不同面行为不一致」的键。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * 单源键登记表：键名 → { file, why }。
 *
 * 加进来之前先问一句：这个键被两个文件读，会不会让「谁说了算」变得看调用顺序？
 * 会，就登记；只是两个消费方各取所需（比如 dream 与 sleep 各要知道用哪个 provider），
 * 不必进这张表。
 */
const SINGLE_SOURCE_KEYS = {
  conflictFreezeEnabled: {
    file: "conflict-mode.js",
    why: "矛盾对是否停车等人审。与 conflictLedgerMode 共同决定「处置跑不跑、记账跑不跑」，"
      + "三处各读一遍时给出三种结果（#719）。唯一解析处是 resolveConflictMode()。"
  },
  conflictLedgerMode: {
    file: "conflict-mode.js",
    why: "分诊档位。同上：它的语义与 conflictFreezeEnabled 绑定（同开时降 shadow），"
      + "任何消费方绕过 resolveConflictMode() 都只拿到配置里的字面值，不是生效值。"
  }
};

/**
 * 状态枚举的「定义但本仓库不写」登记表：枚举成员 → 原因。
 *
 * 预留位本身没问题，问题是它没人记录——注释里写着「预留位」而代码里没有任何
 * 护栏，下一个人读到时无法分辨「实现了但没数据」与「压根没实现」。
 */
const UNWRITTEN_ALLOWED = {
  // conflict_ledger.status
  differentiated: "人审判为「两件事不同」时走 differentiated_pairs 表（src/store.js 的"
    + " saveDifferentiatedPair），账本这一档没有写入点——账本记的是「这一对曾被判为冲突」，"
    + "而 differentiate 的结论落在那张专用表里，不让两套账重叠。"
};

/**
 * 把一个源文件剥成「只剩会被执行到的代码」。
 *
 * 目的是别把注释里的旧写法、SQL 注释里的说明、import 语句里的文件名当成消费点——
 * 我们量的是 `config.xxx` 这种**读取**。剥法刻意简单（不信正则可以解析 JS），
 * 但覆盖本仓库的三种注释形态：
 *   · `/* … *\/` 块注释
 *   · `//` 行内与行尾注释（`https://` 里的双斜杠不算，靠前面必须有空白或行首区分）
 *   · SQL 的 `--` 行（store.js 的建表语句里成段出现）
 * 方向是宁可漏报也不误报：真出现漏报，登记表的新增评审会把关。
 */
function stripNonCode(source) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const lines = [];
  for (const raw of withoutBlocks.split("\n")) {
    const trimmed = raw.trim();
    // 整行注释
    if (trimmed.startsWith("//") || trimmed.startsWith("--") || trimmed.startsWith("*")) continue;
    // 成对的 import / export … from 行不参与计数（那里出现的是文件名，不是读取）
    if (/^\s*(import|export\s+.*\bfrom\b)\s/.test(raw)) continue;
    // 行尾注释：从「空白 + //」起切掉，保护 `://`
    const cut = raw.search(/(^|\s)\/\/ /);
    lines.push(cut >= 0 ? raw.slice(0, cut) : raw);
  }
  return lines.join("\n");
}

async function listSources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listSources(full)));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

/** key → 读到它的文件名集合（只算代码，不算注释与 import）。 */
async function configReadsByKey() {
  const reads = new Map();
  for (const file of await listSources(SRC_DIR)) {
    const code = stripNonCode(readFileSync(file, "utf8"));
    const name = relative(SRC_DIR, file).split("\\").join("/");
    for (const m of code.matchAll(/\bconfig\??\.([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
      const key = m[1];
      if (!reads.has(key)) reads.set(key, new Set());
      reads.get(key).add(name);
    }
  }
  return reads;
}

test("#719 单源键：conflictFreezeEnabled / conflictLedgerMode 只在 conflict-mode.js 里被读", async () => {
  const reads = await configReadsByKey();
  const offenders = [];
  for (const [key, spec] of Object.entries(SINGLE_SOURCE_KEYS)) {
    const files = [...(reads.get(key) ?? [])];
    assert.ok(files.includes(spec.file),
      `${key} 必须在 ${spec.file} 里被读——登记的那个唯一解析处不见了？`);
    const extra = files.filter((f) => f !== spec.file);
    if (extra.length) offenders.push(`${key}: ${extra.join(", ")}（登记文件 ${spec.file}）`);
  }
  assert.deepEqual(offenders, [],
    "以下单源键被登记文件之外的地方读了。要么改调 resolveConflictMode()，"
    + "要么它就是第二种解析——那正是 #719 的形状：\n" + offenders.join("\n"));
});

test("#719 单源键登记表本身不许烂掉：每个键都还在被读，登记理由不是空话", async () => {
  const reads = await configReadsByKey();
  for (const [key, spec] of Object.entries(SINGLE_SOURCE_KEYS)) {
    assert.ok((reads.get(key)?.size ?? 0) > 0, `登记表里的 ${key} 已经没人读了，删掉这行登记`);
    assert.ok(spec.why && spec.why.length > 20,
      `${key} 的登记理由太短——下一个人要靠它判断能不能放宽`);
  }
});

test("#719 状态枚举：每个成员要么有写入点，要么登记「本仓库不写它」及原因", async () => {
  const store = readFileSync(join(SRC_DIR, "store.js"), "utf8");
  const decl = store.match(/const LEDGER_STATUSES = new Set\(\[([^\]]+)\]\)/);
  assert.ok(decl, "store.js 里找不到 LEDGER_STATUSES 声明——守卫跟着实现一起漂了");

  const members = decl[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
  assert.ok(members.length >= 3, "LEDGER_STATUSES 成员数异常");

  // 写入点：代码里出现该状态字面量的地方，除去声明本身所在的 store.js 枚举行。
  // 用全 src 扫而不是只看 setConflictLedgerStatus——zombied 是直接写在 SQL 里的。
  const sources = await listSources(SRC_DIR);
  const codeByFile = new Map(sources.map((f) => [
    relative(SRC_DIR, f).split("\\").join("/"),
    stripNonCode(readFileSync(f, "utf8"))
  ]));

  const missing = [];
  for (const member of members) {
    if (UNWRITTEN_ALLOWED[member]) continue;
    const quoted = new RegExp(`["'\`]${member}["'\`]`);
    const written = [...codeByFile.entries()].some(([name, code]) => {
      if (name === "store.js") {
        // 声明行本身不算写入点
        const withoutDecl = code.replace(/const LEDGER_STATUSES = new Set\(\[[^\]]+\]\)/, "");
        return quoted.test(withoutDecl) || new RegExp(`SET\\s+status\\s*=\\s*'${member}'`).test(withoutDecl);
      }
      return quoted.test(code) || new RegExp(`SET\\s+status\\s*=\\s*'${member}'`).test(code);
    });
    if (!written) missing.push(member);
  }
  assert.deepEqual(missing, [],
    "以下账本状态有人定义、没人写——要么补上写入点，要么写进 UNWRITTEN_ALLOWED 并说明为什么：\n"
    + missing.join("\n"));
});

test("#719 状态枚举登记表不许烂掉：登记为「不写」的成员必须真的还是没人写", async () => {
  const store = readFileSync(join(SRC_DIR, "store.js"), "utf8");
  const decl = store.match(/const LEDGER_STATUSES = new Set\(\[([^\]]+)\]\)/);
  const members = decl[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
  for (const key of Object.keys(UNWRITTEN_ALLOWED)) {
    assert.ok(members.includes(key),
      `UNWRITTEN_ALLOWED 里的 ${key} 已经不在 LEDGER_STATUSES 里了，删掉这行登记`);
    assert.ok(UNWRITTEN_ALLOWED[key].length > 20, `${key} 的「不写」理由太短`);
  }
});
