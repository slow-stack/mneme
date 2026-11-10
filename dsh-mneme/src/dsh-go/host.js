// In-process call into the mneme HTTP API.
//
// The panel runs inside the engine process, exactly where mneme registered its
// routes. Going through real HTTP would hit the dsh-go bridge guard (401 unless
// the request carries the process launch token, which is never written to disk),
// so we dispatch the registered route handler directly and never leave the
// process. Everything stays on the local web server table: no sockets.
//
// Auth is not skipped: mneme's route registrar wraps every route with a policy
// check, so a write route answers 401 unless the request carries the configured
// apiToken. We forward it as the x-dsh-mneme-token header (one of the two the
// registrar accepts) instead of weakening the policy for in-process callers.
import { EventEmitter } from "node:events";

const PREFIX = "/api/dsh-mneme";
const DEFAULT_TIMEOUT = 5000;

function makeRequest(url, method, body, apiToken) {
  const req = new EventEmitter();
  req.url = url;
  req.method = method;
  req.headers = {
    host: "127.0.0.1",
    "content-type": "application/json",
    "content-length": String(body === undefined ? 0 : Buffer.byteLength(body)),
  };
  if (typeof apiToken === "string" && apiToken.length > 0) {
    req.headers["x-dsh-mneme-token"] = apiToken;
  }
  req.socket = { remoteAddress: "127.0.0.1", encrypted: false };
  req.resume = () => {};
  req.pause = () => {};
  req.setEncoding = () => {};
  // The handler attaches its body listeners synchronously when invoked, so the
  // body is only released afterwards by flushRequest(); emitting during
  // construction would fire 'data'/'end' with no listener attached and the
  // handler's readBody() would wait forever.
  req.flush = () => {
    queueMicrotask(() => {
      if (body !== undefined) req.emit("data", Buffer.from(body));
      req.emit("end");
    });
  };
  return req;
}

function makeResponse() {
  const chunks = [];
  let settled;
  const done = new Promise((resolve) => {
    settled = resolve;
  });
  const headers = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    done,
    writeHead(status, extra) {
      res.statusCode = status;
      res.headersSent = true;
      if (extra !== undefined && extra !== null) {
        for (const key of Object.keys(extra)) headers[key.toLowerCase()] = extra[key];
      }
      return res;
    },
    setHeader(key, value) {
      headers[key.toLowerCase()] = value;
      return res;
    },
    getHeader(key) {
      return headers[key.toLowerCase()];
    },
    removeHeader(key) {
      delete headers[key.toLowerCase()];
    },
    write(chunk) {
      if (chunk !== undefined && chunk !== null && typeof chunk !== "function") {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      return true;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null && typeof chunk !== "function") {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      settled();
      return res;
    },
    flushHeaders() {},
  };
  res.text = () => Buffer.concat(chunks).toString("utf8");
  res.bytes = () => Buffer.concat(chunks);
  return res;
}

// 超时定时器不能被 unref()：handler 永不响应时，它是唯一还挂在事件循环上的
// 东西；unref 之后 node 22 的 test runner 会判定循环已空，把用例记成 cancelled
// （CI 的 node22 两腿就是这么红的）。改成显式 cancel —— 成功路径也不白挂 5 秒。
function timeout(ms) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("mneme 接口超时")), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Resolve the mneme route handler and run it in-process.
 * @param {object} ctx - the plugin context (must expose get()).
 * @param {{apiToken?: string}} [options] - the host's configured API token; the
 *   route registrar requires it for every token / token-write route.
 */
export function createHostCall(ctx, options = {}) {
  const apiToken = options.apiToken;
  return async function callMneme(path, options = {}) {
    const method = (options.method ?? "GET").toUpperCase();
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const url = new URL(PREFIX + path, "http://127.0.0.1");
    const webServer = ctx.get?.("webServer") ?? ctx.reflect?.get?.("webServer");
    if (webServer === undefined || typeof webServer.match !== "function") {
      throw new Error("宿主 webServer 不可用");
    }
    const route = webServer.match(url.pathname);
    if (route === undefined || route === null) throw new Error(`mneme 未注册 ${url.pathname}`);
    const req = makeRequest(url.pathname + url.search, method, body, apiToken);
    const res = makeResponse();
    let run;
    try {
      run = Promise.resolve(route.handler(req, res));
    } finally {
      req.flush();
    }
    // Wait for both: most routes return a promise and end the response inside it,
    // but a few (version-check) return undefined and end later from a callback.
    // Racing the three would return the moment the synchronous call returns and
    // hand an empty body to the caller, which then looks like a failed fetch.
    const guard = timeout(options.timeoutMs ?? DEFAULT_TIMEOUT);
    try {
      await Promise.race([
        Promise.all([run, res.done]).then(() => undefined),
        guard.promise,
      ]);
    } finally {
      guard.cancel();
    }
    const text = res.text();
    if (res.statusCode >= 400) {
      const detail = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      const error = new Error(`mneme ${method} ${path} → ${res.statusCode} ${detail}`);
      error.status = res.statusCode;
      error.body = text;
      throw error;
    }
    if (options.raw === true) return text;
    if (text === "") return {};
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  };
}
