// dsh-mneme/test/wiki-cli-hint.test.js
// issue #607 的回归锁：提示里那条命令必须真能粘贴就跑。
//
// 这条 issue 的病因不是「文案不好看」，是**给了一条跑不起来的命令**：插件装在
// profile 依赖里，npm 只为全局安装把 shim 放进 PATH，用户照抄 dsh-mneme-choro
// 必然 command not found。所以真正要锁的不是字符串长相，而是三件事：
//   1) 推导出的入口在这个仓库里真实存在（下面的 existsSync 与实跑验证）；
//   2) 推导不依赖调用方在第几层目录（src/ 与 lib/ 同层、src/wiki/ 在第二层、
//      bin/ 在第一层）——写死层数会悄悄算错，而算错的表现正是又给一条跑不起来的命令；
//   3) 找不到入口时返回 null 让调用方降级，而不是硬编一个假路径。
//
// 引号部分单独锁：安装路径带空格是常态（Windows 的 C:\Program Files\），
// POSIX 路径带单引号也必须转义成 '\''，否则「带引号的命令」照样跑不起来。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { choroCliCommand, choroCliCommandFrom, choroCliEntry } from "../src/wiki/cli-hint.js";

const ENTRY_TAIL = join("bin", "dsh-mneme-choro.mjs");

test("从包内任意深度都能推出同一个 CLI 入口（不按固定层数）", () => {
  // 四个不同深度、且真实存在于本仓的模块位置；写死 dirname 次数的实现只会有
  // 其中一部分对，这条断言就会红。
  const froms = [
    new URL("../package.json", import.meta.url), // test/  -> 1 层
    new URL("../src/tools.js", import.meta.url), // src/   -> 1 层
    new URL("../src/wiki/t1.js", import.meta.url), // src/wiki/ -> 2 层
    new URL("../bin/dsh-mneme-choro.mjs", import.meta.url) // bin/ -> 0 层
  ];
  const entries = froms.map((u) => choroCliEntry(u.href));
  for (const [i, entry] of entries.entries()) {
    assert.equal(typeof entry, "string", "caller #" + i + " must resolve an entry");
    assert.ok(existsSync(entry), "caller #" + i + " resolved a path that does not exist: " + entry);
    assert.ok(entry.endsWith(ENTRY_TAIL), entry);
  }
  // 四条路径必须收敛到同一个入口，否则「同一份代码在不同文件里给出不同命令」
  assert.equal(new Set(entries).size, 1);
});

test("推出来的入口是这个包自己的 bin（不是同名外来目录）", () => {
  const entry = choroCliEntry(new URL("../src/wiki/t1.js", import.meta.url).href);
  assert.ok(entry);
  // 包根必须同时有 bin/ 与 package.json —— 这正是推导的两个条件，反过来验一遍
  const pkgRoot = entry.slice(0, entry.length - ENTRY_TAIL.length - 1);
  assert.ok(existsSync(join(pkgRoot, "package.json")), pkgRoot);
  assert.equal(join(pkgRoot, ENTRY_TAIL), entry);
});

test("源码树被裁剪（找不到 bin 或 package.json）时返回 null，不硬编假路径", () => {
  const dir = mkdtempSync(join(tmpdir(), "mneme-cli-hint-"));
  try {
    // 只有 bin/ 没有 package.json：可能是别人的同名 bin，不能认
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin", "dsh-mneme-choro.mjs"), "");
    assert.equal(choroCliEntry(pathToFileURL(join(dir, "bin", "dsh-mneme-choro.mjs")).href), null);

    // 补齐 package.json 就该认出来（证明上一条的红不是「永远返回 null」）
    writeFileSync(join(dir, "package.json"), "{}");
    assert.equal(
      choroCliEntry(pathToFileURL(join(dir, "bin", "dsh-mneme-choro.mjs")).href),
      join(dir, "bin", "dsh-mneme-choro.mjs")
    );

    // 只有 package.json 没有 bin/：`files` 少了 bin 的裁剪树，同样不能认
    const bare = mkdtempSync(join(tmpdir(), "mneme-cli-hint-bare-"));
    try {
      writeFileSync(join(bare, "package.json"), "{}");
      mkdirSync(join(bare, "src"), { recursive: true });
      assert.equal(choroCliEntry(pathToFileURL(join(bare, "src", "tools.js")).href), null);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("命令带引号：Windows 双引号，POSIX 单引号（路径含空格与单引号都要能跑）", () => {
  // Windows：安装路径带空格是常态，不加引号那条命令在 cmd 里会被拆成两段
  assert.equal(
    choroCliCommand("C:\\Program Files\\mneme\\bin\\dsh-mneme-choro.mjs", "<repo>", "win32"),
    'node "C:\\Program Files\\mneme\\bin\\dsh-mneme-choro.mjs" <repo> --apply'
  );
  // POSIX：无空格时也加引号（统一形态，便于用户照着改）
  assert.equal(
    choroCliCommand("/opt/mneme/bin/dsh-mneme-choro.mjs", "<repo>", "linux"),
    "node '/opt/mneme/bin/dsh-mneme-choro.mjs' <repo> --apply"
  );
  // POSIX：路径里有单引号，必须转成 '\''，否则 shell 把命令截断在引号处
  assert.equal(
    choroCliCommand("/opt/it's here/bin/dsh-mneme-choro.mjs", "<repo>", "linux"),
    "node '/opt/it'\\''s here/bin/dsh-mneme-choro.mjs' <repo> --apply"
  );
  // 占位符原样保留（面板给 <仓库路径>，工具报错给 <repo>），不被引号逻辑吞掉
  assert.equal(
    choroCliCommandFrom(new URL("../src/tools.js", import.meta.url).href, "<仓库路径>", "win32").endsWith(" <仓库路径> --apply"),
    true
  );
  // 入口缺失时整体返回 null —— 调用方据此降级，绝不输出半条命令
  assert.equal(choroCliCommand(null, "<repo>", "win32"), null);
  assert.equal(choroCliCommandFrom("not a url", "<repo>", "win32"), null);
});

test("真的能跑：用推导出的入口执行一次 --help（issue 的验收就是「用户能跑起来」）", () => {
  const entry = choroCliEntry(new URL("../src/wiki/t1.js", import.meta.url).href);
  assert.ok(entry);
  // 用真实入口起一次进程：issue 的验收标准就是「用户照着这条命令能跑起来」，
  const res = spawnSync(process.execPath, [entry, "--help"], { encoding: "utf8", timeout: 30000 });
  assert.equal(res.status, 0, entry + " --help failed: " + (res.stderr || res.stdout));
  assert.match(res.stdout, /--apply/);
});
  // 用真实入口起一次进程：issue 的验收标准就是「用户照着这条命令能跑起来」，
  // 字符串层面的断言证明不了这件事。
