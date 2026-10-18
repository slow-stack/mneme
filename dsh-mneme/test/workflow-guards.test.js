// 工作流配置的回归锁：安全扫描、发布权限、发版准备的注入面不能悄悄退回。
// 锁的都是「配置漂移」——CI 配置没有类型检查，改错了照样绿。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

test("security.yml 的 osv-scanner 保持 fail-on-vuln: true", () => {
  // 2026-10 审计：这里原本是 false（纯提醒，PR 上永远是绿的）。改回 false 就等于
  // 「有已知漏洞也不红」，而测试目录原本没有任何东西会察觉这件事。
  const yml = readFileSync(path.join(repoRoot, ".github", "workflows", "security.yml"), "utf8");
  assert.match(yml, /fail-on-vuln:\s*true/, "osv-scanner 必须保持 fail-on-vuln: true");
  assert.doesNotMatch(yml, /fail-on-vuln:\s*false/, "不得退回只上传 SARIF 不拦的档位");
});

// 剥掉整行注释再断言：注释里会**描述**「id-token: write 该发给谁」，
// 直接对全文 grep 会被自己写的说明文字骗过（第一版就栽在这里）。
function codeOnly(yml) {
  return yml.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
}

// 按缩进切出单个 job 的文本块：工作流顶层是 0 缩进，job 名是 2 缩进。
// 只做文本切片不做完整 YAML 解析——仓库零依赖，为一条断言引 yaml 解析器不划算。
function jobBlock(yml, name) {
  const lines = codeOnly(yml).split(/\r?\n/);
  const start = lines.findIndex((l) => l === "  " + name + ":");
  assert.ok(start >= 0, "找不到 job: " + name);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:$/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

test("release.yml 的 provenance 权限只发给 publish，不发给工作流顶层", () => {
  // 三件事分开断言，因为「全文件 grep id-token: write」会被两种错误都骗过：
  //   ①有人把 id-token 提到工作流顶层（verify/test 也拿到 OIDC 能力）
  //   ②有人把 publish 的权限删了但别的 job 还有（provenance 会失败）
  const yml = readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
  assert.match(yml, /npm publish[^\n]*--provenance/, "publish 必须带 --provenance");

  // YAML 允许把顶层键写成 "jobs": 或 'jobs':，那也是合法的工作流。
  // 只匹配裸 jobs: 会在那种写法下把整个文件当成 head，于是 publish 里合法的
  // id-token 被误判成「顶层声明」——失败方向是误红不是漏检，但假红会磨损这条锁。
  const head = codeOnly(yml).split(/\r?\n(?=["']?jobs["']?:\s*$)/m)[0];
  assert.doesNotMatch(head, /id-token:/, "工作流顶层不得声明 id-token（会泄漏给所有 job）");

  const publish = jobBlock(yml, "publish");
  assert.match(publish, /id-token:\s*write/, "publish job 需要 id-token: write");
  assert.doesNotMatch(publish, /contents:\s*write/, "publish 只读代码，不需要 contents: write");

  const release = jobBlock(yml, "release");
  assert.match(release, /contents:\s*write/, "release job 建 Release 需要 contents: write");
});

// 把每个 `run: |` 块的正文切出来。要断言的是「脚本正文里没有模板展开」，
// 而 run 块之外（env、with、name）出现 ${{ }} 是正常且必需的。
function runBlocks(yml) {
  const lines = codeOnly(yml).split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)run:\s*\|\s*$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) continue;
      if (line.match(/^\s*/)[0].length <= indent) break;
    }
    blocks.push(lines.slice(i + 1, j).join("\n"));
    i = j - 1;
  }
  return blocks;
}

test("release-prep.yml 的版本号走 env 注入，不内插进 run 脚本", () => {
  // 2026-10 审计：zizmor 对 `--head "release-prep/${{ inputs.version }}"` 报 template-injection
  // （模板展开可能带进攻击者可控的代码）。虽然上游 Validate 已用 ^[0-9]+\.[0-9]+\.[0-9]+$ 卡过格式，
  // 但这里让扫描器看清「值不经过 shell 重解析」比让它推理上游校验够不够严便宜得多。
  // 退回内插不会有任何测试变红，所以在这里锁住。
  const yml = readFileSync(path.join(repoRoot, ".github", "workflows", "release-prep.yml"), "utf8");
  assert.match(yml, /VERSION:\s*\$\{\{\s*inputs\.version\s*\}\}/, "版本号必须先进 env 再进脚本");
  const blocks = runBlocks(yml);
  assert.ok(blocks.length >= 3, "至少应切出 Validate / Count tests / Create PR 三个 run 块，实际 " + blocks.length);
  for (const block of blocks) {
    assert.doesNotMatch(block, /\$\{\{/, "run 脚本正文里不得出现模板展开：" + block.slice(0, 120));
  }
});

test("release-prep.yml 与 badge:sync 用同一个记账口径（套件总数，不是通过数）", () => {
  // v0.8.11 徽章漂移的同类失效：两条路径各有一套口径时，谁都不知道该信哪个数。
  // 徽章报的是 CI（ubuntu）口径——平台条件跳过的用例在 pass 里不计、在 tests 里计入，
  // 于是从一台有跳过条件的机器上跑发版准备，会写进一个比 badge:sync 小 1 的徽章，
  // 而且它进 PR 时 CI 是绿的（徽章只出现在文档里，没有测试会去比对它）。
  const yml = readFileSync(path.join(repoRoot, ".github", "workflows", "release-prep.yml"), "utf8");
  const blocks = runBlocks(yml);
  const countBlock = blocks.find((b) => /node --test/.test(b));
  assert.ok(countBlock, "应当能切出跑测试的那个 run 块");
  assert.ok(countBlock.includes("tests [0-9]+"), "计数必须取 tests N（与 sync-test-badge.mjs 同口径）");
  assert.ok(!countBlock.includes("pass [0-9]+"), "不得退回 pass N：那是另一套记账口径");
});

test("发版准备的两份人写清单都点出跨 minor 要挪 SECURITY.md 支持版本表", () => {
  // 跨 minor 时 security-doc.test.js 会红，而那时人往往已经忘了这张表——工作流开的 PR
  // 就是最后一道能把话说清楚的时机。commit-msg 与 pr-body 是两份独立的文本，
  // 少一份就等于一半的路径上没有提示（reviewer 只看 PR 正文，git log 只看提交信息）。
  const yml = readFileSync(path.join(repoRoot, ".github", "workflows", "release-prep.yml"), "utf8");
  const hits = yml.match(/SECURITY\.md 中英两张支持版本表/g) || [];
  assert.equal(hits.length, 2, "commit message 与 PR 正文各要有一条，实际 " + hits.length);
});

test("release-prep.yml 的重跑守卫：已有 PR 不动分支，只覆盖机器产出", () => {
  // 2026-10-18 实测：工作流 8 步里前 7 步全成功，最后一步 git push 被
  // "! [rejected] release-prep/0.9.1 -> release-prep/0.9.1 (fetch first)" 打回——
  // 上一次运行已经把同名分支推上去了。不可重入的代价不是「重跑失败」这么轻：
  // 人会以为流程坏了，转去手工发版，整套自动化就此被绕开。
  //
  // 但「能重跑」不能退化成「无条件 force push」：分支上可能已经有人补过 CHANGELOG
  // 条目，那正是这套流程留给人的那部分工作，覆盖掉比不能重跑更糟。所以守卫分三档：
  // 有进行中的 PR → 什么都不动；顶端是机器产出且没有 PR → 按重跑覆盖；其他 → 停下要人看。
  const yml = readFileSync(path.join(repoRoot, ".github", "workflows", "release-prep.yml"), "utf8");
  const blocks = runBlocks(yml);
  const pushBlock = blocks.find((b) => /git push/.test(b));
  assert.ok(pushBlock, "应当能切出含 git push 的那个 run 块");

  const prLookup = pushBlock.indexOf('--state open');
  const pushAt = pushBlock.indexOf("git push");
  assert.ok(prLookup > 0, "重跑前必须查有没有进行中的 PR（gh pr list --state open）");
  assert.ok(prLookup < pushAt, "查 PR 必须发生在 push 之前");

  // 三档判定：没有 PR 才继续；继续时顶端提交必须是本工作流生成的。
  assert.ok(pushBlock.includes("--force-with-lease="), "重跑覆盖必须用 --force-with-lease（锁住 fetch 到的 SHA）");
  assert.ok(!/git push[^\n]*--force(?!-with-lease)/.test(pushBlock), "不得退回无条件 --force");
  // 断言的是那个 if 本身，不是变量名：变量名留在 case 里、判定被删掉，
  // 只查 includes("MACHINE_TAIL") 照样绿（第一版就是这么漏的）。
  assert.match(pushBlock, /if \[ "\$MACHINE_TAIL" != "yes" \]; then/, "必须有「顶端不是机器产出就停下」的那道判定");
});

test("release-prep.yml 开 PR 失败时给的是可行动的报错，不是裸 GraphQL 报错", () => {
  // 第二个真因（2026-10-18 实测）：仓库级开关 can_approve_pull_request_reviews=false，
  // job 里写 pull-requests: write 覆盖不了它，最后一步报
  // "GitHub Actions is not permitted to create or approve pull requests"。
  // 这个开关在**组织层**默认关着时仓库层根本改不动（gh api 返回 409 Conflict），
  // 所以要让人一眼看出该去哪里开、开完能不能直接重跑。
  const yml = readFileSync(path.join(repoRoot, ".github", "workflows", "release-prep.yml"), "utf8");
  // 只在**可执行部分**里找：这几句话在注释里也出现过（注释是在解释为什么），
  // 对全文 grep 会被自己写的说明文字骗过——报错文案被删干净了照样绿。
  const code = codeOnly(yml);
  assert.match(code, /not permitted to create or approve pull requests/, "报错文案要点名这个具体的 GitHub 报错，人才搜得到");
  assert.match(code, /Settings → Actions → General/, "必须写清去哪个设置页开");
  assert.match(code, /Allow GitHub Actions to create and approve pull requests/, "必须写清要打开的那个开关叫什么");
});