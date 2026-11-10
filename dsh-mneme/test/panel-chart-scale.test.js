import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 7 天柱状纵轴的回归锁（2026-11）。原实现有两处真错，都在小用量库上暴露：
//   ① 标签写死 (v/1e6).toFixed(0)+"M" —— 750K / 500K 都变 1M、250K 变 0M，
//      于是轴永远是「1M / 1M / 1M / 0M」。四条线只剩两个不同值时，图就失去刻度。
//   ② 上限被 Math.max(1e6, …) 钉死 —— 日用量 7 万时柱子只有 7% 高，用量越大反而
//      越正常，正好反了。
// 第 3 条用例锁的就是 ① 的形状（标签去重后必须仍有 4 个），第 4 条锁 ②（上限不许
// 比峰值高出一倍半以上）。第 6 条是源级守卫：纯函数绿了、渲染绕过去也等于没修。

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientSource = readFileSync(join(root, "lib/client.js"), "utf8");

/* ---------- 切片：纯函数块（同 panel-geometry 的先例） ---------- */
const begin = clientSource.indexOf("/* panel-chart-scale:begin");
const end = clientSource.indexOf("/* panel-chart-scale:end */");
assert.ok(begin > 0 && end > begin, "lib/client.js 里找不到 panel-chart-scale 标记块（锚点变了？）");
const block = clientSource.slice(begin, end);
const { chartScale, chartAxisLabel } = new Function(
  `${block}\nreturn { chartScale, chartAxisLabel };`
)();

test("无数据不画轴：0 / 负数 / 非数值一律返回 null", () => {
  for (const v of [0, -1, -1e6, NaN, null, undefined, "abc", "", Infinity]) {
    assert.equal(chartScale(v), null, `chartScale(${String(v)}) 应为 null（调用方画空态）`);
  }
});

test("按量级挑步长：70K / 900K / 2.4M / 3.9M / 12M 的轴都是四条不同的线", () => {
  const cases = [
    [70000, [80000, 60000, 40000, 20000]],
    [900000, [1e6, 750000, 500000, 250000]],
    [2400000, [4e6, 3e6, 2e6, 1e6]],
    [3900000, [4e6, 3e6, 2e6, 1e6]],
    [12000000, [2e7, 1.5e7, 1e7, 5e6]]
  ];
  for (const [dayMax, labels] of cases) {
    const s = chartScale(dayMax);
    assert.deepEqual(s.labels, labels, `dayMax=${dayMax} 的轴不对`);
    assert.equal(s.max, labels[0], "max 必须等于最高那条线");
    assert.equal(s.step * 4, s.max, "step × 4 必须等于 max");
  }
});

test("四条轴标签互不相同（原 bug 的形状：去重后只剩 1M / 0M）", () => {
  const samples = [1, 2, 3, 4, 5, 9, 10, 99, 999, 1000, 4321, 70000, 250000, 900000,
    1500000, 2400000, 3900000, 12000000, 48000000, 1e9];
  for (const dayMax of samples) {
    const s = chartScale(dayMax);
    const texts = s.labels.map(chartAxisLabel);
    assert.equal(new Set(texts).size, 4, `dayMax=${dayMax} 的轴标签有重复：${texts.join(" / ")}`);
  }
});

test("上限够高又不浪费：max >= 峰值，且峰值 >= 1000 时不超过 2.5 倍", () => {
  for (const dayMax of [1, 2, 3, 5, 999, 1000, 4321, 70000, 900000, 2400000, 3.9e6, 12e6, 1e9]) {
    const s = chartScale(dayMax);
    assert.ok(s.max >= dayMax, `dayMax=${dayMax} 时上限 ${s.max} 装不下柱子`);
    if (dayMax >= 1000) {
      assert.ok(s.max < dayMax * 2.5, `dayMax=${dayMax} 时上限 ${s.max} 浪费过半（又退回 1M 地板了？）`);
    }
    for (let i = 1; i < s.labels.length; i += 1) {
      assert.ok(s.labels[i] < s.labels[i - 1], "轴标签必须自上而下递减");
    }
  }
});

test("轴标签按 K / M 分档且整百万不带小数", () => {
  assert.equal(chartAxisLabel(1e6), "1M");
  assert.equal(chartAxisLabel(3e6), "3M");
  assert.equal(chartAxisLabel(1.5e6), "1.5M");
  assert.equal(chartAxisLabel(750000), "750K");
  assert.equal(chartAxisLabel(250000), "250K");
  assert.equal(chartAxisLabel(80000), "80K");
  assert.equal(chartAxisLabel(1000), "1K");
  assert.equal(chartAxisLabel(500), "500");
  assert.equal(chartAxisLabel(0), "0");
});

test("渲染真的用了这两个函数（纯函数绿了但渲染绕过去等于没修）", () => {
  assert.ok(!/toFixed\(0\)\}M/.test(clientSource), "client.js 里还留着 (v/1e6).toFixed(0)M 的旧标签写法");
  assert.ok(!/Math\.max\(1e6,/.test(clientSource), "client.js 里还留着 Math.max(1e6, …) 的上限地板");
  assert.ok(/chartAxisLabel\(v\)/.test(clientSource), "网格标签没走 chartAxisLabel");
  assert.ok(/d\.total \/ scale\.max/.test(clientSource), "柱高没走 scale.max");
  assert.ok(/memory\.status\.token\.daysEmpty/.test(clientSource), "全零七天没有空态文案");
});
