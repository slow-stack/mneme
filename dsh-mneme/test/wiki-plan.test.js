// plan.yaml 校验的回归锁（spec §4 / §9；实现计划 P1）。
// 锁三类回归：未知键必须整轮拒绝（拼错的键等于失效的控制，不能静默忽略）、
// 类型错误逐条收集一次报完（人一次改完，不逐个试错）、无 plan.yaml 走默认启发式。
import test from "node:test";
import assert from "node:assert/strict";
import { loadPlan, planFingerprint, PLAN_ALLOWED_KEYS, PlanInvalidError } from "../src/wiki/plan.js";

test("无 plan.yaml / 空文件走默认启发式", () => {
  const a = loadPlan(null);
  assert.equal(a.plan.maxFilesPerPage, 40);
  assert.deepEqual(a.plan.exclude, []);
  assert.equal(a.plan.pages, null);
  assert.deepEqual(a.plan.templates, {});
  // 「没带 plan」也是可记账状态：指纹 = 空串 sha256
  assert.equal(a.fingerprint, planFingerprint(""));
  const b = loadPlan("   \n");
  assert.equal(b.plan.maxFilesPerPage, 40);
});

test("未知键整轮拒绝，报出键名与允许列表（spec 降级表第一行）", () => {
  assert.throws(
    () => loadPlan("includes:\n  - src\n"),
    (err) => {
      assert.ok(err instanceof PlanInvalidError);
      assert.ok(err.message.includes("includes"), "报错要点名拼错的键");
      assert.ok(err.message.includes("include"), "有相近键时给改正提示");
      assert.ok(err.message.includes("允许的顶层键"));
      for (const k of PLAN_ALLOWED_KEYS) assert.ok(err.message.includes(k));
      return true;
    }
  );
});

test("完全不相干的未知键不给误导性提示", () => {
  assert.throws(
    () => loadPlan("zzzzqqqq: 1\n"),
    (err) => err.message.includes("zzzzqqqq")
  );
});

test("类型错误逐条收集、一次报完（不 fail-fast）", () => {
  try {
    loadPlan("exclude: not-an-array\nmax_files_per_page: zero\npages:\n  - path: \"\"\n");
    assert.fail("应该抛 PlanInvalidError");
  } catch (err) {
    assert.ok(err instanceof PlanInvalidError);
    assert.ok(err.issues.length >= 3, `至少三条 issue，实际 ${err.issues.length}`);
    assert.ok(err.issues.some((i) => i.includes("exclude")));
    assert.ok(err.issues.some((i) => i.includes("max_files_per_page")));
    assert.ok(err.issues.some((i) => i.includes("pages[0]")));
  }
});

test("YAML 语法错误也走同一条拒绝路径", () => {
  assert.throws(() => loadPlan("a: [1, 2\nb: }\n"), PlanInvalidError);
});

test("pages 白名单形状合法时被接受，模板/笔记被保留", () => {
  const { plan } = loadPlan(
    "pages:\n  - path: src\n    title: 源码主区\n    template: arch\n    notes: 关注导出面\n" +
    "templates:\n  arch: |\n    自定义正文行\n"
  );
  assert.deepEqual(plan.pages, [{ path: "src", title: "源码主区", template: "arch", notes: "关注导出面" }]);
  assert.equal(plan.templates.arch, "自定义正文行\n");
});

test("pages 重复 path / 未知页级键 / 非 mapping 都被点名", () => {
  try {
    loadPlan("pages:\n  - path: src\n  - path: src\n  - bogus: 1\n  - 42\n");
    assert.fail("应该抛");
  } catch (err) {
    assert.ok(err.issues.some((i) => i.includes("重复")));
    assert.ok(err.issues.some((i) => i.includes("bogus")));
    assert.ok(err.issues.some((i) => i.includes("pages[3]")));
  }
});

test("指纹随内容变化（plan.yaml 改了就要重划边界）", () => {
  assert.notEqual(planFingerprint("a: 1\n"), planFingerprint("a: 2\n"));
});
