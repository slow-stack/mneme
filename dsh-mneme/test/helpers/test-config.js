// #692: fixture 配置的公共入口——把「记忆质量过滤关掉」这个前提写成明文。
//
// memoryQualityFilter.enabled 的生产默认值是**开**（src/config.js 的 schema
// .default(true)，宿主装配后 cfg 里恒有 true）。而大量测试用的是两三个字的
// 短正文（「入门」「喜欢猫」「中文交流」），默认开之后这些行会被判
// short_content（−80 分 → score 20 < archiveThreshold 30）直接归档，
// 于是注入、检索、列表断言全空。
//
// 那些测试考的从来不是过滤规则，只是顺手依赖了「默认关」这个隐含前提。
// 这个前提现在写在这里、写一次：createService 的 config 走 testConfig()。
//
// 反过来，**需要过滤行为的测试自己传** { memoryQualityFilter: { enabled: true } }
// 显式覆盖，不许再依赖「什么都不传就等于关」。
export function testConfig(extra = {}) {
  return { memoryQualityFilter: { enabled: false }, ...extra };
}