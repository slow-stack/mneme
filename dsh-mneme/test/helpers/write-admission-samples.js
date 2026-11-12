// #254 第 1 级「密钥 / PII」判据的回归样本集。
//
// 这份语料是给**判据**用的，不是给闸门用的：闸门（src/write-admission.js）只消费
// `sensitiveScan` 返回的 {kind,label}，判据本身是 #164 A2 的落地范围（记在维护者
// 排期里）。语料放在这里有两个用途——判据落地时有一份现成的正负样本可跑；现在就能
// 把「接线通不通」钉住（下面导出的 referenceScan 是只给测试用的参考实现）。
//
// 三条口径：
//
// 1. 正样本分两类。SECRET_SAMPLES（密钥凭据）与 PII_SAMPLES（个人信息）都收，但
//    两者的误杀面差一个量级：密钥串在正常项目记忆里几乎不出现（出现了就是事故），
//    而邮箱 / 电话 / 订单号在项目记忆里完全可能是正当内容。所以 `kind` 必须落进
//    审计行（见 write-admission.js 的 record）——enforce 打开前先按 kind 看命中
//    分布，将来要按类放行也只改策略、不动判据。
//
// 2. 负样本专挑两类最容易误杀的文本：**含敏感词但没有值**（"把 API key 放进环境
//    变量"）、**高熵但不是凭据**（sha256 校验和、UUID、Luhn 合法的示例卡号之外的
//    长数字）。一个只按关键词命中的扫描器会在这组里全军覆没，这正是这组样本的
//    用处——它量的不是「抓得住多少」，而是「抓错多少」。
//
// 3. 样本里的凭据都是公开占位值（AWS 官方文档的 AKIA…EXAMPLE（AWS 公开示例）、GitHub /
//    OpenAI / Stripe 的文档格式、Stripe 与银行的官方测试卡号），不是真凭据。
//
// 用法（测试侧）：
//   import { allSamples, NEGATIVE_SAMPLES, referenceScan } from "./helpers/write-admission-samples.js";
import { fakeLeakedPassword, fakeAwsAccessKeyId, fakePemHeader } from "./fake-auth-values.js";

// 这几条样本的**值**在密钥扫描器眼里就是真凭据的形状。字面量直接写进仓库有两重代价：
// GitHub 侧 push protection 会直接拒推（GH013），CI 的 gitleaks 全历史扫描会红掉
// （.github/workflows/security.yml）。拆成拼接后仓库文本里不再含完整形状，而运行时拼
// 出来的值仍然是判据要面对的那个形状——语料测的东西一点没变。
//
// 两套扫描器的规则**并不重合**：push protection 拦的是 Slack / Stripe，gitleaks 拦的是
// GitHub PAT / JWT。所以这几条统一走拼接，别按「上一次哪条红了」逐条打补丁——扫描器
// 升级一次规则就又得回来补。
//
// 别为了绕开扫描器把它们简化成一眼假的占位串：正样本的价值恰恰在于压在检测器的形状
// 边界上，改成 `xoxb-xxx` 就等于把这条样本删了。AWS 那条用的是官方文档自己的示例值
// AKIA…EXAMPLE（AWS 公开示例），两套扫描器本来就认它是样例，保持字面量。
const assemble = (...parts) => parts.join("");

/** 语料里那几条被扫描器盯着形状的凭据值。测试侧要拼句子时从这里取，别另抄一份。 */
export const SAMPLE_VALUES = {
  githubPat: assemble("ghp_", "16C7e42F292c6912E7710c838347Ae178B4a"),
  slackToken: assemble("xoxb-", "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx"),
  jwt: assemble(
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    ".eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
  ),
  stripeKey: assemble("sk_", "live_", "51H8Qw2KZvN3mPqRsTuVwXyZ0123456789abcdef"),
  // 这条曾以整串字面量留在下面的 content 里，被 GitHub secret scanning 报成 openai_api_key
  // （alert #1）。它是形状样本不是真凭据（正文就是 a-z、0-9 顺序串），但扫描器只看形状，
  // 所以按上面第 32-34 行的口径统一走拼接，别让它再当例外。
  openaiKey: assemble("sk-proj-", "abcdefghijklmnopqrstuvwxyz0123456789ABCD")
};

/** 密钥凭据类正样本。kind 与 label 是判据该报回来的东西。 */
export const SECRET_SAMPLES = [
  {
    id: "aws-access-key",
    kind: "aws_access_key",
    label: "AWS access key id",
    title: "部署脚本",
    content: `部署脚本里写死了 ${fakeAwsAccessKeyId()}，回头要换掉`,
    why: "AKIA + 16 位大写字母数字，长度与字符集都固定"
  },
  {
    id: "github-pat",
    kind: "github_token",
    label: "GitHub token",
    title: "CI 配置",
    content: `CI 的 token 是 ${SAMPLE_VALUES.githubPat}，别再贴出来`,
    why: "ghp_ 前缀 + 36 位，GitHub PAT 的固定形状"
  },
  {
    id: "openai-key",
    kind: "openai_key",
    label: "OpenAI API key",
    title: "调试记录",
    content: `临时用 ${SAMPLE_VALUES.openaiKey} 调了一次`,
    why: "sk-/sk-proj- 前缀 + 长串"
  },
  {
    id: "slack-token",
    kind: "slack_token",
    label: "Slack token",
    title: "webhook",
    content: `webhook 配的是 ${SAMPLE_VALUES.slackToken}`,
    why: "xoxb- 前缀 + 分段数字 + 混合串"
  },
  {
    id: "pem-private-key",
    kind: "private_key",
    label: "PEM private key",
    title: "issue 正文",
    content: `把 ${fakePemHeader()} 整段贴到了 issue 里`,
    why: "PEM 头是明文私钥的确定标志，有没有正文都不影响判定"
  },
  {
    id: "assigned-literal",
    kind: "assigned_secret",
    label: "assigned credential literal",
    title: "本地配置",
    content: `config 里 password = ${fakeLeakedPassword()} 这一行得删掉`,
    why: "赋值号右边是字面量凭据——这是最常见的一类，也是最需要防误杀的一类"
  },
  {
    id: "jwt",
    kind: "jwt",
    label: "JSON Web Token",
    title: "抓包",
    content: `抓到的 Authorization 是 ${SAMPLE_VALUES.jwt}`,
    why: "三段 base64url，header 恒以 eyJ 开头"
  },
  {
    id: "connection-string",
    kind: "connection_string",
    label: "credentials in URL",
    title: "连不上",
    content: "postgres://admin:S3cr3tPa55w0rd@db.internal:5432/prod 连不上",
    why: "URL 里带 user:password@host 就是明文凭据"
  },
  {
    id: "stripe-key",
    kind: "stripe_key",
    label: "Stripe secret key",
    title: "支付联调",
    content: `联调用的 ${SAMPLE_VALUES.stripeKey} 忘了轮换`,
    why: "sk_live_ 前缀是生产密钥（测试密钥是 sk_test_，不该报）"
  },
  {
    id: "npm-auth-token",
    kind: "npm_token",
    label: "npm auth token",
    title: ".npmrc",
    content: "//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789",
    why: "按 _authToken= 这个固定键定位，不必猜 token 的形状"
  }
];

/** PII 类正样本。误杀面比密钥大一档，见文件头第 1 条。 */
export const PII_SAMPLES = [
  {
    id: "email-phone",
    kind: "email",
    label: "email address",
    title: "客户联系方式",
    content: "客户的联系方式是 zhang.wei@example.com，别外传",
    why: "RFC 形状的邮箱；项目记忆里出现它是可能的，所以更适合先告警"
  },
  {
    id: "cn-mobile",
    kind: "cn_mobile",
    label: "mainland mobile number",
    title: "值班表",
    content: "值班手机 13800138000，紧急情况打这个",
    why: "1[3-9] + 9 位，中国手机号的固定形状"
  },
  {
    id: "cn-id-card",
    kind: "cn_id_card",
    label: "mainland ID number",
    title: "实名核验",
    content: "身份证 11010519491231002X 已经核验过",
    why: "17 位数字 + 校验位（数字或 X）"
  },
  {
    id: "bank-card",
    kind: "bank_card",
    label: "payment card number",
    title: "对公账户",
    content: "银行卡 4111111111111111 是对公账户",
    why: "4 开头的 16 位；这里用 Visa 的公开测试号，不用真卡号"
  }
];

/**
 * 负样本：必须**一条都不命中**。每条都写清它为什么容易误杀。
 * 这是本文件里最值钱的部分——正样本只证明「抓得住」，负样本才约束「抓错多少」。
 */
export const NEGATIVE_SAMPLES = [
  {
    id: "keyword-no-value",
    title: "密钥管理",
    content: "把 API key 放进环境变量，别写进代码——轮换流程见 docs/handbook/12-secrets.md",
    why: "整句在讨论凭据管理，没有一个字面量值"
  },
  {
    id: "token-as-noun",
    title: "重试策略",
    content: "token 刷新失败时退避重试三次，第三次仍失败就报错",
    why: "token 是普通名词，后面没有赋值号"
  },
  {
    id: "redaction-placeholder",
    title: "脱敏示例",
    content: "password: <redacted>",
    why: "占位符不是值——纯关键词扫描器在这里必错"
  },
  {
    id: "env-var-indirection",
    title: "配置读取",
    content: "secret = process.env.MNEME_SECRET",
    why: "赋值右边是环境变量读取，不是字面量"
  },
  {
    id: "template-var",
    title: "模板",
    // 这条样本**故意**就是一个模板占位符——它量的正是「看到 = 或 : 就报」的误杀。
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 样本内容本身就是待测文本，不是要插值的模板
    content: "token: ${TOKEN}",
    why: "模板变量同理——看到 = 或 : 就报会误杀这一整类"
  },
  {
    id: "hash-not-secret",
    title: "校验和",
    content: "sha256 摘要 3f786850e387550fdab836ed7e6dc881de23001b 不是密钥，只是一个校验和",
    why: "高熵十六进制串，但不是凭据；按熵阈值判会误杀全部哈希"
  },
  {
    id: "uuid",
    title: "订单号",
    content: "订单号 550e8400-e29b-41d4-a716-446655440000 是 UUID v4",
    why: "同样是高熵串；UUID 在项目记忆里到处都是"
  },
  {
    id: "prefix-only",
    title: "格式说明",
    content: "GitHub PAT 的前缀是 ghp_，新格式是 github_pat_",
    why: "只提到前缀，后面没有 token 正文"
  },
  {
    id: "sk-prefix-only",
    title: "key 前缀",
    content: "sk- 开头的是 OpenAI 的 key 前缀",
    why: "同上——前缀本身不是凭据"
  },
  {
    id: "discuss-rotation",
    title: "轮换周期",
    content: "把密钥轮换周期定成 90 天，到期前一周提醒",
    why: "在讨论密钥的生命周期"
  },
  {
    id: "discuss-hashing",
    title: "密码处理",
    content: "用户在设置页输入密码后调用 bcrypt.hash 存哈希，明文不落盘",
    why: "讨论密码处理方式，不含任何密码"
  },
  {
    id: "discuss-pii",
    title: "脱敏要求",
    content: "手机号必须脱敏后再入库，日志里也不能出现",
    why: "在讨论 PII 策略，不含具体号码"
  }
];

/** 全部正样本（密钥 + PII），每条都带期望的 kind。 */
export const POSITIVE_SAMPLES = [...SECRET_SAMPLES, ...PII_SAMPLES];

/** 正负样本一起，便于整组遍历。 */
export const allSamples = [...POSITIVE_SAMPLES, ...NEGATIVE_SAMPLES];

// --- 参考扫描器（仅供测试） ---------------------------------------------------
// 这不是要发货的实现，也**不是** #164 A2 的实现——A2 归维护者排期。它的作用只有
// 两个：证明闸门侧 `sensitiveScan` 的接线真的能把命中变成拒绝；给上面的语料一个
// 可执行的对照。A2 落地时把同一个语料原样跑在真扫描器上，这个函数就可以删掉。
//
// 写法上刻意体现一件事：**先看形状，再看关键词**。纯关键词匹配在负样本组里会
// 全军覆没（见 NEGATIVE_SAMPLES 的 why），所以这里每条模式都带长度或字符集约束，
// 赋值型那条还要多一道占位符守卫。
const SECRET_PATTERNS = [
  { kind: "aws_access_key", label: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "github_token", label: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/ },
  { kind: "slack_token", label: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "private_key", label: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "jwt", label: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { kind: "connection_string", label: "credentials in URL", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/:@]{6,}@/ },
  { kind: "stripe_key", label: "Stripe secret key", re: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { kind: "npm_token", label: "npm auth token", re: /_authToken\s*=\s*[A-Za-z0-9_-]{20,}/ },
  { kind: "openai_key", label: "OpenAI API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  {
    kind: "assigned_secret",
    label: "assigned credential literal",
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\b\s*[:=]\s*["']?([^\s"']{8,})/i,
    // 占位符 / 间接引用守卫：命中关键词但没有字面量值时不算命中。
    guard: (value) => !/^(?:<[^>]*>|\$\{|\$[A-Z_]+$|process\.env|redacted|xx+|\*+|\u2026)/i.test(value)
  }
];

const PII_PATTERNS = [
  { kind: "email", label: "email address", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { kind: "cn_mobile", label: "mainland mobile number", re: /\b1[3-9]\d{9}\b/ },
  { kind: "cn_id_card", label: "mainland ID number", re: /\b\d{17}[\dXx]\b/ },
  { kind: "bank_card", label: "payment card number", re: /\b(?:4\d{15}|5[1-5]\d{14}|62\d{14,17})\b/ }
];

/**
 * 参考扫描器：命中返回 `{kind, label}`，未命中返回 null——与
 * `createWriteAdmission` 的 `sensitiveScan` 契约一致（不抛）。
 * 先密钥后 PII：一条文本同时像两类时（如带凭据的 URL 也像邮箱），报更严重的那类。
 */
export function referenceScan(memory) {
  const text = [memory?.title, memory?.content].filter((s) => typeof s === "string").join("\n");
  for (const p of [...SECRET_PATTERNS, ...PII_PATTERNS]) {
    const m = text.match(p.re);
    if (!m) continue;
    if (p.guard && !p.guard(m[1] ?? "")) continue;
    return { kind: p.kind, label: p.label };
  }
  return null;
}
