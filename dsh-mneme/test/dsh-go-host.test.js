// src/dsh-go/host.js —— 进程内派发的判据。
//
// 这个文件锁的是「面板能不能拿到宿主真的答复」，而不是某一屏长什么样：
//   - 请求体必须在 handler 挂好监听之后再 flush，否则 readBody 永远等不到 end；
//   - handler 返回 undefined 但稍后才 res.end（/version-check 就是这样）时，
//     调用方必须等到响应真的结束，不能拿着空 body 当成结果；
//   - 配了 apiToken 之后写路由要带令牌，否则被自家路由注册器拦成 401；
//   - 超时、未注册路径都要抛错，而不是返回一个空对象让面板显示成「0 条」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHostCall } from "../src/dsh-go/host.js";
import { FAKE_API_TOKEN } from "./helpers/fake-auth-values.js";

function fakeServer(routes) {
  return {
    match(pathname) {
      const handler = routes[pathname];
      return handler === undefined ? undefined : { kind: "exact", path: pathname, handler };
    },
  };
}

function readAll(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += String(chunk);
    });
    req.on("end", () => resolve(data));
  });
}

const ctxWith = (routes) => ({ get: (name) => (name === "webServer" ? fakeServer(routes) : undefined) });

test("进程内调用能读到请求体，并且同步响应即可返回", async () => {
  let seen = null;
  const call = createHostCall(
    ctxWith({
      "/api/dsh-mneme/echo": (req, res) => {
        seen = { method: req.method, url: req.url };
        void readAll(req).then((body) => {
          seen.body = body;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, body: JSON.parse(body) }));
        });
      },
    }),
  );
  const result = await call("/echo", { method: "POST", body: { title: "x" } });
  assert.deepEqual(result, { ok: true, body: { title: "x" } });
  assert.equal(seen.method, "POST");
  assert.equal(seen.body, JSON.stringify({ title: "x" }));
});

test("handler 同步返回 undefined、稍后 res.end 时仍然等到响应结束", async () => {
  // /version-check 的真实形状：handler 立即 return，答复在 promise 回调里写完。
  const call = createHostCall(
    ctxWith({
      "/api/dsh-mneme/version-check": (req, res) => {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ version: "0.10.1", status: "latest" }));
        }, 5);
        return undefined;
      },
    }),
  );
  const result = await call("/version-check");
  assert.equal(result.version, "0.10.1");
  assert.equal(result.status, "latest");
});

test("配了 apiToken 就把令牌放进 x-dsh-mneme-token 头", async () => {
  const call = createHostCall(
    ctxWith({
      "/api/dsh-mneme/update": (req, res) => {
        const token = req.headers["x-dsh-mneme-token"] ?? "";
        res.writeHead(token === FAKE_API_TOKEN ? 200 : 401);
        res.end(JSON.stringify(token === FAKE_API_TOKEN ? { ok: true } : { error: "unauthorized" }));
      },
    }),
    { apiToken: FAKE_API_TOKEN },
  );
  assert.deepEqual(await call("/update", { method: "POST", body: { id: "m1" } }), { ok: true });
});

test("没有令牌时写路由的 401 会变成异常，而不是空结果", async () => {
  const call = createHostCall(
    ctxWith({
      "/api/dsh-mneme/update": (req, res) => {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "unauthorized" }));
      },
    }),
  );
  await assert.rejects(call("/update", { method: "POST", body: { id: "m1" } }), /401/);
});

test("未注册的路径直接报错，不会静默返回空对象", async () => {
  const call = createHostCall(ctxWith({}));
  await assert.rejects(call("/list"), /mneme 未注册/);
});

test("宿主没有 webServer 时报错", async () => {
  const call = createHostCall({ get: () => undefined });
  await assert.rejects(call("/list"), /webServer 不可用/);
});

test("超时抛错（避免面板永远等着）", async () => {
  const call = createHostCall(
    ctxWith({
      "/api/dsh-mneme/slow": () => {
        // 永不响应
      },
    }),
  );
  await assert.rejects(call("/slow", { timeoutMs: 30 }), /超时/);
});

test("空响应体归一成 {}，非 JSON 归一成 { text }", async () => {
  const call = createHostCall(
    ctxWith({
      "/api/dsh-mneme/empty": (req, res) => {
        res.writeHead(200);
        res.end("");
      },
      "/api/dsh-mneme/plain": (req, res) => {
        res.writeHead(200);
        res.end("hello");
      },
    }),
  );
  assert.deepEqual(await call("/empty"), {});
  assert.deepEqual(await call("/plain"), { text: "hello" });
});
