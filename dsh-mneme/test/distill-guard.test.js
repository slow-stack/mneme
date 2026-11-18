import test from "node:test";
import assert from "node:assert/strict";
import { isExcludedProject, normalizeProjectPath } from "../src/distill-guard.js";

test("#688 normalizeProjectPath: 尾部分隔符、反斜杠、大小写都归一", () => {
  assert.equal(normalizeProjectPath("/work/private"), "/work/private");
  assert.equal(normalizeProjectPath("/work/private/"), "/work/private");
  assert.equal(normalizeProjectPath("C:\\Work\\Private\\"), "c:/work/private");
  assert.equal(normalizeProjectPath("  /work/private  "), "/work/private");
  assert.equal(normalizeProjectPath("/work//private/"), "/work/private");
});

test("#688 normalizeProjectPath: 空输入返回 null，根目录不掉成 null", () => {
  assert.equal(normalizeProjectPath(""), null);
  assert.equal(normalizeProjectPath("   "), null);
  assert.equal(normalizeProjectPath(null), null);
  assert.equal(normalizeProjectPath(undefined), null);
  assert.equal(normalizeProjectPath(42), null);
  // CodeRabbit #755 第 5 条："/" 剥尾后是空串，但它的语义是「根目录=全挡」，
  // 掉成 null 会被跳过，名单写 ["/"] 就形同虚设。它必须是有效条目。
  assert.equal(normalizeProjectPath("/"), "/");
  assert.equal(normalizeProjectPath("//"), "/");
});

test("#688 isExcludedProject: 等值与前缀命中，兄弟目录不误伤", () => {
  const list = ["/work/private"];
  assert.equal(isExcludedProject("/work/private", list), true);
  assert.equal(isExcludedProject("/work/private/sub/dir", list), true);
  assert.equal(isExcludedProject("/work/private-other", list), false);
  assert.equal(isExcludedProject("/work", list), false);
  assert.equal(isExcludedProject("/work/priv", list), false);
});

test("#688 isExcludedProject: 形如前缀的兄弟目录名不被吃掉", () => {
  assert.equal(isExcludedProject("/work/private-public", ["/work/private"]), false);
});

test("#688 isExcludedProject: 根目录条目挡全部", () => {
  assert.equal(isExcludedProject("/work/a", ["/"]), true);
  assert.equal(isExcludedProject("/", ["/"]), true);
});

test("#688 isExcludedProject: 名单里夹着无效条目时照常判其余条目", () => {
  assert.equal(isExcludedProject("/work/private", ["", "   ", null, "/work/private"]), true);
  assert.equal(isExcludedProject("/work/public", ["", null]), false);
});

test("#688 isExcludedProject: 会话没有 cwd 或名单为空时一律放行", () => {
  assert.equal(isExcludedProject(undefined, ["/work/private"]), false);
  assert.equal(isExcludedProject(null, ["/work/private"]), false);
  assert.equal(isExcludedProject("", ["/work/private"]), false);
  assert.equal(isExcludedProject("/work/private", []), false);
  assert.equal(isExcludedProject("/work/private", undefined), false);
  assert.equal(isExcludedProject("/work/private", "/work/private"), false);
});
