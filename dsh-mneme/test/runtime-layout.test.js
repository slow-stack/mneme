import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  RUNTIME_MANIFEST,
  TRANSFORMERS_ENTRY,
  defaultRuntimeDir,
  defaultModelCacheDir,
  describePayload,
  listPayloadDirs,
  nodeModulesDir,
  payloadDir,
  payloadId,
  runtimeManifestPath,
  transformersVersionOk
} from "../src/runtime/layout.js";

// 运行时目录契约（issue #131 / PR-A）：这里守住的是「结构检查能不能准确地
// 指出缺了什么」。功能验证（真 import 并跑推理）不在本文件覆盖范围，
// 由后续的 verify 模块负责。

/**
 * 造一份假的 payload。默认是一个「完整可用」的形态，各选项用来单独破坏一处，
 * 这样每个用例只验证一条判据。
 */
function makePayload({
  version = "4.2.0",
  platform = "win32",
  arch = "x64",
  packages = ["@huggingface/transformers", "onnxruntime-node", "sharp"],
  withEntry = true,
  nodePlatform = platform,
  nodeArch = arch,
  withManifest = false
} = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "mneme-runtime-"));
  const dir = payloadDir(runtimeDir, payloadId({ version, platform, arch }));
  const nm = nodeModulesDir(dir);

  for (const name of packages) {
    const pkgDir = join(nm, name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name, version: name === "@huggingface/transformers" ? version : "1.0.0" })
    );
  }

  if (withEntry) {
    const entry = join(dir, TRANSFORMERS_ENTRY);
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "// 占位：真实运行时这里是可被 import 的 ESM 入口\n");
  }

  if (nodePlatform && packages.includes("onnxruntime-node")) {
    // 真实包结构是 bin/napi-v6/<平台>/<架构>/，夹具必须照做，否则测不到架构这一层。
    mkdirSync(join(nm, "onnxruntime-node", "bin", "napi-v6", nodePlatform, nodeArch), { recursive: true });
  }

  if (withManifest) {
    writeFileSync(
      runtimeManifestPath(dir),
      JSON.stringify({ payloadId: payloadId({ version, platform, arch }), procedure: "adopted" })
    );
  }

  return { runtimeDir, dir };
}

test("payloadId 带版本、平台与架构，多份可共存", () => {
  assert.equal(payloadId({ version: "4.2.0", platform: "win32", arch: "x64" }), "transformers-4.2.0-node-win32-x64");
  assert.equal(payloadId({ version: "4.3.1", platform: "darwin", arch: "arm64" }), "transformers-4.3.1-node-darwin-arm64");
});

test("运行时根目录默认挂在中性家 ~/.mneme/runtime 下，不再是 .dsh", () => {
  // 传空 env 是必须的：旧家的位置跟着 DSH_HOME 走，不隔掉就会被跑测试这台机器的
  // DSH_HOME 带偏（本机就有）。
  assert.equal(defaultRuntimeDir("/home/u", {}), join("/home/u", ".mneme", "runtime"));
  // 模型缓存同源：也要在中性家下，且与运行时同父目录。
  assert.equal(defaultModelCacheDir("/home/u", {}), join("/home/u", ".mneme", "models"));
});

test("旧缓存目录存在就用旧的，新目录是不是空壳不参与判定（#744 review）", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mneme-layout-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = {};

  // 两个旧目录都在，新目录也建出来（只是空壳）。
  mkdirSync(join(home, ".dsh", "mneme", "runtime"), { recursive: true });
  mkdirSync(join(home, ".dsh", "mneme", "models"), { recursive: true });
  mkdirSync(join(home, ".mneme", "runtime"), { recursive: true });
  mkdirSync(join(home, ".mneme", "models"), { recursive: true });

  assert.equal(
    defaultRuntimeDir(home, env),
    join(home, ".dsh", "mneme", "runtime"),
    "旧缓存存在就不该被空壳新目录顶掉，否则那 200MB 白重下"
  );
  assert.equal(defaultModelCacheDir(home, env), join(home, ".dsh", "mneme", "models"));

  // 旧目录不在时才去新家。
  rmSync(join(home, ".dsh"), { recursive: true, force: true });
  assert.equal(defaultRuntimeDir(home, env), join(home, ".mneme", "runtime"));
  assert.equal(defaultModelCacheDir(home, env), join(home, ".mneme", "models"));
});

test("transformersVersionOk 只认 >=4.2.0 <5", () => {
  assert.equal(transformersVersionOk("4.2.0"), true);
  assert.equal(transformersVersionOk("4.10.3"), true);
  assert.equal(transformersVersionOk("4.2.0-rc.1"), true, "预发布后缀按主版本号判断即可");
  assert.equal(transformersVersionOk("4.1.9"), false);
  assert.equal(transformersVersionOk("5.0.0"), false);
  assert.equal(transformersVersionOk("garbage"), false);
  assert.equal(transformersVersionOk(undefined), false);
});

test("完整的 payload：结构检查通过，且不报任何缺件", () => {
  const { dir } = makePayload({ withManifest: true });
  const report = describePayload(dir, { platform: "win32", arch: "x64" });
  assert.equal(report.ok, true, `不应有失败：missing=${report.missing} reasons=${report.reasons}`);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.reasons, []);
  assert.equal(report.version, "4.2.0");
  assert.equal(report.manifest?.procedure, "adopted");
});

test("目录不存在（没装过）时给出可读原因，而不是抛异常", () => {
  const { runtimeDir } = makePayload();
  const report = describePayload(join(runtimeDir, "transformers-9.9.9-node-win32-x64"), { platform: "win32", arch: "x64" });
  assert.equal(report.ok, false);
  assert.equal(report.missing.length, 0);
  assert.match(report.reasons.join("\n"), /node_modules 不存在/);
});

test("缺入口文件时点名入口本身", () => {
  const { dir } = makePayload({ withEntry: false });
  const report = describePayload(dir, { platform: "win32", arch: "x64" });
  assert.equal(report.ok, false);
  assert.ok(report.missing.includes(TRANSFORMERS_ENTRY), `missing=${JSON.stringify(report.missing)}`);
});

test("缺必需包时逐个点名", () => {
  const { dir } = makePayload({ packages: ["@huggingface/transformers"] });
  const report = describePayload(dir, { platform: "win32", arch: "x64" });
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing.includes("onnxruntime-node"), true);
  assert.deepEqual(report.missing.includes("sharp"), true);
  // 包整个不在时，不应再额外抱怨平台子树——否则同一件事会被报两次。
  assert.equal(report.reasons.some((r) => r.includes("平台")), false);
});

test("onnxruntime-node 在，但缺少当前平台的二进制子树：报平台原因（裁剪/搬运最常见的错）", () => {
  const { dir } = makePayload({ nodePlatform: "darwin" });
  const report = describePayload(dir, { platform: "win32", arch: "x64" });
  assert.equal(report.ok, false);
  assert.equal(report.missing.length, 0, "包都在，不该算缺件");
  assert.match(report.reasons.join("\n"), /win32\/x64 的二进制子树/);
});

test("同平台但架构不符必须拒绝：linux-arm64 的 payload 不能在 linux-x64 上通过", () => {
  // 真实包内是 bin/napi-v6/{darwin,linux,win32}/{arm64,x64}，只查平台会让架构不符的
  // payload 通过结构检查、被 loader 选中，然后在 import 原生模块时才失败。
  const { dir } = makePayload({ platform: "linux", arch: "arm64" });
  assert.equal(describePayload(dir, { platform: "linux", arch: "arm64" }).ok, true, "同架构应当通过");
  const mismatched = describePayload(dir, { platform: "linux", arch: "x64" });
  assert.equal(mismatched.ok, false, "架构不符必须不通过");
  assert.equal(mismatched.missing.length, 0, "包都在，不该算缺件");
  assert.match(mismatched.reasons.join("\n"), /linux\/x64 的二进制子树/);
});

test("版本落在认可区间之外：结构不缺件，但要报版本原因", () => {
  const { dir } = makePayload({ version: "5.0.0" });
  const report = describePayload(dir, { platform: "win32", arch: "x64" });
  assert.equal(report.ok, false);
  assert.equal(report.missing.length, 0);
  assert.match(report.reasons.join("\n"), /不在认可区间/);
  assert.equal(report.version, "5.0.0");
});

test("listPayloadDirs 只列目录、名称排序，且对不存在的根目录返回空数组", () => {
  const { runtimeDir } = makePayload();
  makePayload();
  assert.deepEqual(listPayloadDirs(join(runtimeDir, "nope")), []);
  assert.deepEqual(listPayloadDirs(runtimeDir), ["transformers-4.2.0-node-win32-x64"]);
});

test("清单文件名与路径稳定（契约的一部分）", () => {
  assert.equal(RUNTIME_MANIFEST, "mneme-runtime.json");
  assert.equal(runtimeManifestPath("/rt/p"), join("/rt/p", "mneme-runtime.json"));
});
