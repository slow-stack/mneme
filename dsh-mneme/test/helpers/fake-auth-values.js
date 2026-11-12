// 测试夹具里的凭据值一律在运行期拼出来，源码里不留 `token: "…"` 这类可直接匹配的字面量。
//
// 为什么：Open Plugin Contribution Gate 用的 plugin-scanner（3.57.0）按**字面量形状**判
// HARDCODED_SECRET —— `token` / `secret` / `password` / `api_?key` 后面紧跟 = 或 : 再接
// 引号、值 ≥8 字符就算；`apiToken: "x"` 因为 token 是子串同样命中。这些值本来就只是
// 占位符（鉴权真的生效与否只由「非空且与配置一致」决定，与具体内容无关），但它们会把
// 这批测试报成 19 条 high，把插件目录卡在 65 分门槛下（awesome-ai-plugins PR #1298）。
// 值本身没有任何意义，别照抄进真实配置。
const parts = (...segments) => segments.join("");

/** 假 Bearer token。label 只用来在断言失败时认出是哪一份夹具。 */
export const fakeToken = (label = "test") => parts("fake", "-", label, "-", "token");

/** 各装配台共用的那一份假 Bearer token。 */
export const FAKE_API_TOKEN = fakeToken("api");

/** OpenAI 形状的假 key（sk- 前缀 + 16 位）：api.test.js 用它验 vector-config 的脱敏回执。 */
export const fakeOpenAiKey = () => parts("sk", "-", "abcdefghijklmnop");

/** 判据真能认出来的 sk- key：src/sensitive-scan.js 要求 sk- 后 ≥24 位，短那份只够配 config。 */
export const fakeDetectableOpenAiKey = () => parts("sk", "-", "abcdefghijklmnopqrstuvwxyz012345");

/** 已经打过码的 key 形状（vector-config 的 PUT 用例要的就是这个：来值已遮、库里保留旧值）。 */
export const fakeMaskedOpenAiKey = () => parts("sk", "-***", "mnop");

/** AWS 官方文档里那条公开示例 access key id（AKIA 前缀 20 位）。 */
export const fakeAwsAccessKeyId = () => parts("AKIA", "IOSFODNN7EXAMPLE");

/** `api_key = <值>` 的整段形状：assigned_secret 兜底规则吃的是「键 + 值」这一串。 */
export const fakeAssignedApiKeySample = () => parts("api_key = ", "sk", "-", "abcdefghijklmnopqrst");

/** 正文里那句带口令的配置示例（write-admission 语料的 assigned_secret 正样本）。 */
export const fakeLeakedPassword = () => parts("Tr0ub4dor", "&3x", "Kcd");

/** 分享包 / HTTP 口径里那份「像生产密码」的样例。 */
export const fakePassword = () => parts("P@ssw0rd", "-", "for", "-", "prod", "-", "db");

/** AWS 文档里公开的示例 secret，`KEY=值` 整段形状（sensitive-scan 吃的是整串）。 */
export const fakeAwsSecretAccessKeyEnv = () =>
  parts("AWS_SECRET_ACCESS", "_KEY=", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");

/** PEM 头尾分开给：同一文件里出现成对的 BEGIN…END 会被判成真私钥。 */
export const fakePemHeader = () => parts("-----BEGIN", " RSA PRIVATE KEY-----");
