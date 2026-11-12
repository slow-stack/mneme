// #164 A2：写入边界的密钥 / PII 判据（src/sensitive-scan.js）。
//
// 这是「真判据」自己的验收，与 write-admission.test.js 里那组（拿参考扫描器测**闸门
// 接线**）分工不同：这边测判据本身，且第一条用例就是把 #332 配好的 26 条语料原样跑在
// 生产实现上——维护者 09-28 的验收条件就是这句「同一套负样本原样跑，抓错任何一条就
// 不算落地」，所以它放在这里而不是再抄一份语料。
//
// 参考扫描器 referenceScan 只服务闸门测；本文件刻意**不** import 它——生产判据与
// 参考实现是两份独立实现，同时跑过同一套语料才算把语料用足（对照着改就成了自证）。
import test from "node:test";
import assert from "node:assert/strict";

import { scanSensitive, createSensitiveScan } from "../src/sensitive-scan.js";
import {
  SECRET_SAMPLES,
  PII_SAMPLES,
  POSITIVE_SAMPLES,
  NEGATIVE_SAMPLES,
  SAMPLE_VALUES
} from "./helpers/write-admission-samples.js";
import { fakeAwsSecretAccessKeyEnv, fakeAssignedApiKeySample } from "./helpers/fake-auth-values.js";

// #164 A2 的语料里那几条凭据值走 helper 的拼接导出，别在测试里另抄一份字面量：
// GitHub 的 push protection 会按形状拦真实凭据（本 PR 实测：`sk_live_` 一条就够
// 拒推，helper 正是为这件事把值拆成两段拼的）。这里复用同一份，仓库文本里不留完整形状。
const STRIPE_KEY = SAMPLE_VALUES.stripeKey;

// 正样本那条 OpenAI key 从语料里取，不另抄字面量（同 STRIPE_KEY 的理由）。
const OPENAI_KEY = POSITIVE_SAMPLES.find((s) => s.id === "openai-key").content.match(/\S*sk-\S+/)[0];
/** `sk-proj-…` 前缀的变体：语料那条不带 proj-，这里补同样的正文长度。 */
const openaiProjKey = (body) => `sk-proj-${body}`;
const OPENAI_BODY = OPENAI_KEY.replace(/^.*?sk-(?:proj-)?/, "");

test("真判据：正样本一条都不漏放，且 kind 与语料声明一致", () => {
  for (const sample of POSITIVE_SAMPLES) {
    const text = `${sample.title}\n${sample.content}`;
    const hit = scanSensitive(text);
    assert.ok(hit, `${sample.id} 被漏放（${sample.why}）`);
    // kind 是审计行里的稳定判据键：它错了，「按 kind 看命中分布」这条路就断了。
    // 同一个串可能被多条规则吃下（`sk_live_` 也像通用 `sk-`），所以顺序是判据的一部分。
    assert.equal(hit.kind, sample.kind, `${sample.id} 的 kind 必须是语料声明的那个（规则顺序变了就会漂）`);
    assert.equal(typeof hit.label, "string");
  }
});

test("真判据：负样本一条都不误杀（抓错任何一条就不算落地）", () => {
  for (const sample of NEGATIVE_SAMPLES) {
    const hit = scanSensitive(`${sample.title}\n${sample.content}`);
    assert.equal(hit, null, `${sample.id} 被误杀（${sample.why}）：实际命中 ${hit?.kind}`);
  }
});

test("密钥与 PII 分两档，但都从同一条通道出来", () => {
  // 分档的意义是「将来按类放行只改策略、不动判据」：kind 集合是策略的抓手，
  // 所以这里断言两类都能被分辨，而不是把 PII 折进密钥那一档。
  assert.ok(SECRET_SAMPLES.length >= 1 && PII_SAMPLES.length >= 1);
  assert.equal(scanSensitive("password = \"Tr0ub4dor&3xKcd\"").kind, "assigned_secret");
  assert.equal(scanSensitive("联系方式 zhang.wei@example.com").kind, "email");
  assert.equal(scanSensitive("值班手机 13800138000").kind, "cn_mobile");
});

test("只扫文本：路径与 id 这类元数据字段不进判据", () => {
  // 元数据由系统生成，不是用户写进来的内容；扫它们只会引入假阳（一个文件名里
  // `token` 这种词很常见）。契约是判据只看记忆的文本字段。
  const scan = createSensitiveScan({ config: { sensitiveScanEnabled: true } });
  assert.equal(scan({ title: "配置", content: "正常正文", id: SAMPLE_VALUES.githubPat, doc_path: STRIPE_KEY }), null);
  // 反过来，正文里的凭据必须报——上面那条不是靠「什么都扫不到」通过的。
  assert.ok(scan({ title: "配置", content: `正文里有 ${SAMPLE_VALUES.githubPat}` }));
});

test("tags 也扫：标签是用户输入的自由文本", () => {
  const scan = createSensitiveScan({ config: { sensitiveScanEnabled: true } });
  assert.equal(scan({ title: "正常标题", content: "正常正文", tags: ["正常"] }), null);
  assert.equal(scan({ title: "正常标题", content: "正常正文", tags: [SAMPLE_VALUES.githubPat] })?.kind, "github_token");
});

test("工厂：判据自己的闸关时连函数都不给（闸门侧行为与 #332 逐字段一致）", () => {
  assert.equal(createSensitiveScan({ config: { sensitiveScanEnabled: false } }), null);
  assert.equal(createSensitiveScan({ config: {} }), null);
  assert.equal(createSensitiveScan({}), null, "没有 config 也不能默认开");
  assert.equal(createSensitiveScan({ config: { sensitiveScanEnabled: "true" } }), null, "字符串 true 不是 true");
  const scan = createSensitiveScan({ config: { sensitiveScanEnabled: true } });
  assert.equal(typeof scan, "function");
});

test("工厂不碰决策：命中只报 kind，拦不拦由闸门的 enforce 决定", () => {
  // 判据与闸门分层（#164：默认仅告警、拦截 opt-in）——判据知道「这是什么」，
  // 但不知道也不该知道「要不要拦」。返回值里没有 decision / enforced 这类字段，
  // 就是这条分层的机器可判点。
  const scan = createSensitiveScan({
    config: { sensitiveScanEnabled: true, writeAdmission: { enabled: true, enforce: false } }
  });
  const hit = scan({ title: "调试", content: openaiProjKey(OPENAI_BODY) });
  assert.deepEqual(Object.keys(hit).sort(), ["kind", "label"]);
});

test("不抛：坏输入返回 null，扫描器故障不会把写入变成不可用", () => {
  assert.equal(scanSensitive(undefined), null);
  assert.equal(scanSensitive(null), null);
  assert.equal(scanSensitive(""), null);
  assert.equal(scanSensitive(12345), null);
  const scan = createSensitiveScan({ config: { sensitiveScanEnabled: true } });
  assert.equal(scan(null), null);
  assert.equal(scan({ title: 7, content: null, tags: "not-an-array" }), null);
});

test("一处命中只报最严重的那条（deny 面记类别，不记条数）", () => {
  // 一篇同时带 Stripe 密钥与邮箱的正文：报密钥那一档。反过来把 PII 排在前面
  // 会让「这条命中过密钥」这个更严重的事实被邮箱盖掉。
  const text = `邮箱 a@b.com，另外 ${STRIPE_KEY}`;
  assert.equal(scanSensitive(text).kind, "stripe_key");
});

test("语料之外的探针：漏放那一类锁一条（实现期实测出来的，不是假想）", () => {
  // 不在 #332 的 26 条语料里，是拿真判据跑额外形状时发现的：AWS secret access key
  // 没有前缀，`secret` 关键词规则又要求它后面紧跟赋值号，多词键
  // （`AWS_SECRET_ACCESS_KEY=`）两条都够不着 → 补了专用的键名规则。
  assert.equal(
    scanSensitive(fakeAwsSecretAccessKeyEnv()).kind,
    "aws_secret_key"
  );
  // 反向确认「值 + 赋值键」这条兜底规则还在工作，而且**不**看值的形状：`api_key =`
  // 后面跟任何 8 位以上的值都报（判据不知道哪个值是真的）。
  assert.equal(scanSensitive(fakeAssignedApiKeySample()).kind, "assigned_secret");
  // 收紧后的开关键字仍然认 24 位以上的真 key（44 位正文，语料那条）。
  assert.equal(scanSensitive(openaiProjKey(OPENAI_BODY)).kind, "openai_key");
});

// --- 合并后独立复审的三项加固 -------------------------------------------------

// 赋值句的键与值都在运行时拼装，别写成整串字面量：`.github/workflows/security.yml` 的
// gitleaks 是**全历史**扫描且没有 allowlist，而 generic-api-key 规则认的是「关键词 +
// 赋值号 + 高熵值」——一个 16 位、字符全不重复的十六进制串熵值就有 4.0，高于它 3.5 的
// 阈值，直接落进源码就会被判成真凭据（本批初稿实测：两条各报一次）。
// 与 helpers/write-admission-samples.js 里那几条凭据值同一个理由，那边也是拼的。
const envLine = (key, value, prefix = "") => `${prefix}${key}=${value}`;
/** 一眼假的低熵值：不是占位符（占位符会被守卫挡掉，那样就测不到这条规则了）。 */
const FAKE_LITERAL = ["super", "sekrit", "000"].join("-");

test("左边界放开 `_`：环境变量名形态的赋值也要抓（原先整类漏放）", () => {
  // 回归锁：赋值型规则的左边界原为 `[^A-Za-z0-9_]`，把下划线也当成了标识符内部字符，
  // 于是只有恰好落在行首的 `API_KEY=` 能中，而 `DB_PASSWORD=` / `MY_API_KEY=` /
  // `MYSQL_PASSWORD=` 这种「前缀_关键词」的环境变量名整类漏放——配置片段与 .env 正文
  // 恰恰是最常见的落库形态。放宽后 #332 的 26 条语料仍全绿，说明原写法不是语料换来
  // 的取舍，是白丢的。
  for (const [key, prefix] of [
    ["DB_PASSWORD", ""],
    ["MY_API_KEY", ""],
    ["MYSQL_PASSWORD", ""],
    ["GITHUB_TOKEN", "export "] // 带 shell 前缀的写法
  ]) {
    const line = envLine(key, FAKE_LITERAL, prefix);
    assert.equal(scanSensitive(line)?.kind, "assigned_secret", `${key} 形态的赋值不该漏放`);
  }
});

test("放宽左边界没有放走占位符与间接引用（守卫仍在管那一半）", () => {
  // 与上一条成对：放宽的是「关键词前面能不能是 `_`」，不是「右边的值算不算字面量」。
  // 后者仍归占位符守卫——下面三条正是负样本群里「有敏感词但没有值」的形态。
  // 这些值同样拼装，理由见本节开头（`${...}` 这类串本身也贴着"像凭据"的形状）。
  const placeholders = [
    ["DB_PASSWORD", ["$", "{DB_PASSWORD}"].join("")],
    ["MY_API_KEY", ["<", "your-key-here", ">"].join("")],
    ["DB_PASSWORD", ["process", ".env.DB_PASSWORD"].join("")]
  ];
  for (const [key, value] of placeholders) {
    const line = envLine(key, value);
    assert.equal(scanSensitive(line), null, `${key} 形态的占位 / 间接引用不该报`);
  }
});

test("身份证档加校验位：位数对但校验不过的 18 位数字串不报", () => {
  // 回归锁：原先只有银行卡档有 Luhn、身份证档只看长度，结果是 18 位纯数字（订单号 /
  // 内部编号 / 拼接时间戳）先被身份证规则命中，等不到银行卡那条的校验。补 GB 11643
  // MOD 11-2 之后两侧都干净：校验不过的不报，语料里那条真形状照报。
  assert.equal(scanSensitive("内部编号 123456789012345678 已登记"), null, "校验不过的 18 位不该报");
  assert.equal(scanSensitive("内部编号 987654321098765432 已登记"), null);
  assert.equal(scanSensitive("身份证 11010519491231002X 已核验")?.kind, "cn_id_card");
  // 小写 x 走同一张校验表（语料只覆盖了大写 X）。
  assert.equal(scanSensitive("身份证 11010519491231002x 已核验")?.kind, "cn_id_card");
});

test("email 的 local part 上界恰好卡在 RFC 5321 的 64", () => {
  // 上界不是随手取的数：64 是 RFC 5321 给 local part 的上限，所以「长于 64 不认」
  // 这条边界必须是精确的——松一位会让回溯面失控，紧一位会漏掉合法邮箱。
  const at = (n) => `${"a".repeat(n)}@example.com`;
  assert.ok(scanSensitive(at(64)), "64 位的 local part 是合法的，必须认");
  assert.equal(scanSensitive(at(65)), null, "65 位超出 RFC 上限，不认（换取回溯有界的代价）");
});

test("长文本上的回溯有上界：写阻塞类回归的计时护栏", () => {
  // 回归锁：email 的 local part 与 connection_string 的 scheme 都作用在含 `.` 的字符
  // 类上，缺上界时每个起点都要一路重扫到结尾才失败 → O(n²)。未加上界时实测：34KB
  // 点分链 0.6 秒、120KB 对抗串 23.5 秒（email 18.6s + 连接串 4.1s）；而本判据在写入
  // 路径上同步跑，等于把写入卡死。加上界后同输入约 60ms。
  // 预算取 2 秒：比修复前小一个数量级（12× 安全边），又比修复后大 30 倍，不至于像
  // 50ms 级断言那样被 CI 抖动误伤——它抓的是「上界被拿掉」这类数量级回归，不是微优化。
  const inputs = [
    "a.".repeat(30000) + "@" + "b.".repeat(30000) + "!",
    "com.example.pkg.".repeat(10000) + "@"
  ];
  for (const text of inputs) {
    const started = process.hrtime.bigint();
    scanSensitive(text);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 2000, `${text.length} 字符耗时 ${ms.toFixed(1)}ms，超 2000ms 预算（回溯上界被破坏？）`);
  }
});

// 仓库文本守卫：语料里的凭据值必须以拼接形式存在，仓库里不得留下完整形状。
// 触发这件事的是 GitHub secret scanning 的 alert #1——write-admission-samples.js 里
// openai-key 那条曾经是整串字面量（同文件其它四条都已是 assemble 拼接），被报成
// openai_api_key 的 open=true 告警。它本身不是泄露（正文是 a-z、0-9 的顺序串），
// 但扫描器只看形状；而这条漏网说明「逐条记得改」靠不住，所以用一条测试把它钉住：
// 以后谁再往语料里加字面量，这里先红，不用等 GitHub 来通知。
test("语料里不留完整形状的凭据字面量（secret scanning alert #1 的回归锁）", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const helpersDir = new URL("./helpers/", import.meta.url);
  const files = (await readdir(helpersDir)).filter((f) => f.endsWith(".js"));
  // 前缀集合与长度都对齐 src/sensitive-scan.js 的 github_token / slack_token /
  // openai_key 三条规则——只有形状一致才谈得上「扫描器会认」，前缀写窄了等于给
  // gho_ / ghs_ / xoxp- 这些同族凭据开后门。改那三条规则时这里要跟着改。
  // 唯一放宽的是 sk- 的下限：生产规则是 24，这里用 20，宁可多报——漏报的代价是
  // GitHub 再报一次告警，多报的代价只是有人来把这行改成拼接。
  const rules = [
    // kind 与生产判据对齐，下面的断言拿它反查 scanSensitive 是不是真认这个形状。
    { re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/, what: "OpenAI key", kind: "openai_key", probe: `sk-${"a1".repeat(13)}` },
    { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/, what: "GitHub token", kind: "github_token", probe: `ghs_${"a1".repeat(18)}` },
    { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, what: "Slack token", kind: "slack_token", probe: `xoxp-${"a1".repeat(8)}` }
  ];
  // 「与生产规则同源」不能只是注释：CodeRabbit 在 #465 指出前一版把前缀写窄了
  // （只认 ghp_ / xoxb-，漏了 gho_/ghs_/xoxp-），注释却写着同源。所以这里反查
  // scanSensitive——守卫的每条规则必须真的被生产判据认成同一个 kind，否则这条红。
  // 生产规则收窄前缀时，这条测试会先于「GitHub 又报一次告警」发现不一致。
  // 两段合起来才叫同源：探针要同时被**守卫的规则**和**生产判据**认下，且 kind 一致。
  // 只查一边的话，任一侧收窄前缀都不会红——那正是 CodeRabbit 指出的失效模式。
  for (const { re, what, kind, probe } of rules) {
    assert.match(probe, re, `守卫自己的 ${what} 规则认不出 ${probe}，前缀写窄了？`);
    assert.equal(scanSensitive(probe)?.kind, kind, `生产判据不认 ${probe} 为 ${kind}，守卫与它不同源`);
  }
  for (const file of files) {
    const text = await readFile(new URL(file, helpersDir), "utf8");
    for (const { re, what } of rules) {
      const hit = text.match(re);
      assert.equal(
        hit,
        null,
        `${file} 里出现了完整的 ${what} 字面量（${hit?.[0]?.slice(0, 12)}…）：按 assemble 拼接，别整串写`
      );
    }
  }
});
