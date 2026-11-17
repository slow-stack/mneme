import test from "node:test";
import assert from "node:assert/strict";
import { isHumanInputSource } from "../src/human-source.js";

// #745：这份判据原先在四处各写一遍（注入查询 / 蒸馏转录 / 连续性快照 / 日记素材），
// 四处一起漏掉中继消息。抽成一份之后口径只在这里钉。

test("issue#745 human-source: 旧事件没有 source / kind 时放行", () => {
  assert.equal(isHumanInputSource(undefined), true, "缺 source 的旧事件不能因为判据收紧而丢");
  assert.equal(isHumanInputSource(null), true);
  assert.equal(isHumanInputSource({}), true, "有 source 但没有 kind：更旧的形状");
});

test("issue#745 human-source: 白名单三种来源都算人提问", () => {
  assert.equal(isHumanInputSource({ kind: "user" }), true, "GUI 直输");
  assert.equal(isHumanInputSource({ kind: "bot", form: "relay", role: "room", senderName: "You" }), true,
    "经 DS Bot / 群聊中继的人类消息（宿主 0.2.x 实测形态）");
  assert.equal(isHumanInputSource({ kind: "plugin:dsh-onebot" }), true, "QQ 桥中继的人类消息");
});

test("issue#745 human-source: 白名单外的机器来源一律不算人", () => {
  for (const kind of [
    "runtime-context",
    "time-context",
    "skill-catalog",
    "agent-instructions",
    "plugin:dsh-mneme",
    "coordinator",
    "agent-message",
    "subagent-report",
    "team-message",
    "schedule",
    "dsh-rewind"
  ]) {
    assert.equal(isHumanInputSource({ kind }), false, `${kind} 不是当前用户想干什么`);
  }
});

test("issue#745 human-source: 白名单 kind 也要看 form，机器形态的面板注入不算提问", () => {
  // 反向对照：#745 review 补的那层。kind 落在白名单里但 form 是机器上下文时，
  // 放行就等于「将来某个插件用 {kind:'bot', form:'notice'} 推通知会被当成提问」。
  for (const form of ["snapshot", "catalog", "notice", "instructions"]) {
    assert.equal(isHumanInputSource({ kind: "bot", form }), false, `kind:bot + form:${form}`);
    assert.equal(isHumanInputSource({ kind: "user", form }), false, `kind:user + form:${form}`);
    assert.equal(isHumanInputSource({ kind: "plugin:dsh-onebot", form }), false, `onebot + form:${form}`);
  }
  // 人自己发的两条中继形态必须仍放行——过了 form 这层不能顺手把功能关掉。
  assert.equal(isHumanInputSource({ kind: "bot", form: "relay" }), true);
  assert.equal(isHumanInputSource({ kind: "plugin:dsh-onebot" }), true);
});

test("issue#745 human-source: 非对象 source 不猜", () => {
  assert.equal(isHumanInputSource("user"), false, "字符串不是 source 对象");
  assert.equal(isHumanInputSource(42), false);
  assert.equal(isHumanInputSource(true), false);
});
