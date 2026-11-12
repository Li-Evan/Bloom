import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { BackendUnreachableError, request } from "../src/lib/api-common.ts";
import {
  StreamError,
  readAnnotationStream,
  streamNextLesson,
} from "../src/lib/learn/stream.ts";

const IDLE_TIMEOUT_MS = 120000;
const CONNECT_TIMEOUT_MS = 180000;
const encoder = new TextEncoder();
// 与 lib/learn/api.ts 的 generateNextLesson 相同：open 负责发请求，stream.ts 负责读流与空闲超时
const generateNextLesson = (courseId, onChunk, onDone) =>
  streamNextLesson(
    (signal) =>
      fetch(`/api/courses/${courseId}/next`, { method: "POST", signal }),
    onChunk,
    onDone
  );
const streamError = (code) => (error) =>
  error instanceof StreamError && error.code === code;
const flush = () => setImmediate();

function expectRejection(request, expected) {
  const result = assert.rejects(request, expected);
  result.catch(() => {});
  return result;
}

// Real Web Streams with a mocked transport and clock: no server, API key or
// third-party test dependencies are needed. Aborts emulate Chromium's error.
function mockSSE(t, { cancel, mockTimers = true } = {}) {
  if (mockTimers) t.mock.timers.enable({ apis: ["setTimeout"] });
  let controller;
  let signal;
  let cancelled = 0;
  const onAbort = () =>
    controller.error(
      new DOMException("BodyStreamBuffer was aborted", "AbortError")
    );
  const body = new ReadableStream({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled += 1;
      signal?.removeEventListener("abort", onAbort);
      return cancel?.();
    },
  });
  const response = new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (_url, options) => {
      signal = options.signal;
      signal.addEventListener("abort", onAbort, { once: true });
      return response;
    }
  );
  t.after(() => signal?.removeEventListener("abort", onAbort));
  return {
    body,
    response,
    fetchMock,
    get signal() {
      return signal;
    },
    get cancelled() {
      return cancelled;
    },
    send(data) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    },
    raw(text) {
      controller.enqueue(encoder.encode(text));
    },
    bytes(value) {
      controller.enqueue(value);
    },
    close() {
      controller.close();
    },
    error(reason) {
      controller.error(reason);
    },
    async tick(ms) {
      t.mock.timers.tick(ms);
      await flush();
    },
  };
}

test("a progressing lesson stream can run longer than two minutes", async (t) => {
  const stream = mockSSE(t);
  const chunks = [];
  const done = [];
  const request = generateNextLesson(
    17,
    (chunk) => chunks.push(chunk),
    (data) => done.push(data)
  );
  // Keep an early assertion failure from leaving an unhandled transport rejection.
  request.catch(() => {});
  await flush();

  for (let i = 0; i < 5; i += 1) {
    await stream.tick(60000);
    assert.equal(
      stream.signal.aborted,
      false,
      `active stream aborted at ${(i + 1) * 60}s`
    );
    stream.send({ content: `第${i + 1}段` });
    await flush();
  }
  stream.send({ done: true, lesson_number: 8 });
  await request;

  assert.equal(chunks.join(""), "第1段第2段第3段第4段第5段");
  assert.deepEqual(done, [{ done: true, lesson_number: 8 }]);
  const [url, options] = stream.fetchMock.mock.calls[0].arguments;
  assert.equal(url, "/api/courses/17/next");
  assert.equal(options.method, "POST");
  assert.equal(stream.body.locked, false);
  await stream.tick(IDLE_TIMEOUT_MS * 2);
  assert.equal(
    stream.signal.aborted,
    false,
    "successful requests must clear their timer"
  );
});

test("waiting for response headers has its own longer timeout, not the stream idle timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  t.mock.method(globalThis, "fetch", (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () =>
          reject(
            new DOMException("signal is aborted without reason", "AbortError")
          ),
        { once: true }
      );
    });
  });
  const rejection = expectRejection(
    generateNextLesson(1, () => {}),
    streamError("connectTimeout")
  );
  t.mock.timers.tick(IDLE_TIMEOUT_MS);
  assert.equal(signal.aborted, false, "queueing / cold start is not stream idleness");
  t.mock.timers.tick(CONNECT_TIMEOUT_MS - IDLE_TIMEOUT_MS);
  await rejection;
  assert.equal(signal.aborted, true);
});

test("idle timeout while waiting for the first body chunk is not a raw AbortError", async (t) => {
  const stream = mockSSE(t);
  const rejection = expectRejection(
    generateNextLesson(1, () => {}),
    streamError("timeout")
  );
  await flush();
  await stream.tick(IDLE_TIMEOUT_MS);
  await rejection;
  assert.equal(stream.signal.aborted, true);
  assert.equal(stream.body.locked, false);
});

test("each received chunk restarts the idle timeout", async (t) => {
  const stream = mockSSE(t);
  const chunks = [];
  const rejection = expectRejection(
    generateNextLesson(1, (chunk) => chunks.push(chunk)),
    streamError("timeout")
  );
  await flush();
  await stream.tick(90000);
  stream.send({ content: "仍在生成" });
  await flush();
  await stream.tick(IDLE_TIMEOUT_MS - 1);
  assert.equal(stream.signal.aborted, false);
  await stream.tick(1);
  await rejection;
  assert.deepEqual(chunks, ["仍在生成"]);
  assert.equal(stream.body.locked, false);
});

test("the idle timeout starts only once response headers arrive", async (t) => {
  const stream = mockSSE(t);
  let respond;
  t.mock.method(globalThis, "fetch", async (...args) => {
    const response = await stream.fetchMock(...args);
    return new Promise((resolve) => {
      respond = () => resolve(response);
    });
  });
  const request = generateNextLesson(1, () => {});
  request.catch(() => {});
  await flush();
  await stream.tick(150000);
  assert.equal(stream.signal.aborted, false);
  respond();
  await flush();
  await stream.tick(IDLE_TIMEOUT_MS - 1);
  assert.equal(stream.signal.aborted, false);
  stream.send({ done: true, lesson_number: 2 });
  await request;
});

test("SSE heartbeats count as activity even without lesson text", async (t) => {
  const stream = mockSSE(t);
  const request = generateNextLesson(1, () =>
    assert.fail("heartbeat is not content")
  );
  request.catch(() => {});
  await flush();
  for (let i = 0; i < 4; i += 1) {
    await stream.tick(90000);
    assert.equal(stream.signal.aborted, false);
    stream.raw(": keep-alive\n\n");
    await flush();
  }
  stream.send({ done: true, lesson_number: 2 });
  await request;
});

test("empty byte chunks do not keep an otherwise idle request alive", async (t) => {
  const stream = mockSSE(t);
  const rejection = expectRejection(
    generateNextLesson(1, () => {}),
    streamError("timeout")
  );
  await flush();
  await stream.tick(90000);
  stream.bytes(new Uint8Array());
  await flush();
  await stream.tick(30000);
  await rejection;
});

test("done is terminal, is delivered once, and does not wait for socket closure", async (t) => {
  const stream = mockSSE(t, { cancel: () => new Promise(() => {}) });
  const chunks = [];
  const done = [];
  const request = generateNextLesson(
    1,
    (chunk) => chunks.push(chunk),
    (data) => done.push(data)
  );
  stream.raw(
    'data: {"content":"课文"}\n\ndata: {"done":true,"lesson_number":2}\n\ndata: {"done":true}\n\ndata: {"content":"忽略"}\n\n'
  );
  await request;
  assert.deepEqual(chunks, ["课文"]);
  assert.deepEqual(done, [{ done: true, lesson_number: 2 }]);
  assert.equal(stream.cancelled, 1);
  assert.equal(stream.body.locked, false);
  await stream.tick(IDLE_TIMEOUT_MS);
  assert.equal(stream.signal.aborted, false);
});

test("summary completion keeps the completed payload", async (t) => {
  const stream = mockSSE(t);
  const done = [];
  const request = generateNextLesson(
    1,
    () => {},
    (data) => done.push(data)
  );
  stream.send({ phase: "summary", content: "总结" });
  stream.send({ done: true, completed: true });
  await request;
  assert.deepEqual(done, [{ done: true, completed: true }]);
});

test("fragmented UTF-8, CRLF, malformed JSON and a final unterminated line are handled", async (t) => {
  const stream = mockSSE(t);
  const chunks = [];
  const done = [];
  const request = generateNextLesson(
    1,
    (chunk) => chunks.push(chunk),
    (data) => done.push(data)
  );
  stream.raw(": heartbeat\r\ndata: not-json\r\n\r\n");
  const bytes = encoder.encode(
    'data:{"content":"下一篇🌱"}\r\n\r\ndata: {"done":true,"lesson_number":8}'
  );
  for (const byte of bytes) stream.bytes(new Uint8Array([byte]));
  stream.close();
  await request;
  assert.deepEqual(chunks, ["下一篇🌱"]);
  assert.deepEqual(done, [{ done: true, lesson_number: 8 }]);
  assert.equal(stream.body.locked, false);
});

for (const partial of ["", 'data: {"content":"只有半篇"}\n\n']) {
  test(`an incomplete stream rejects instead of silently succeeding (${partial ? "partial" : "empty"})`, async (t) => {
    const stream = mockSSE(t);
    const done = t.mock.fn();
    const rejection = expectRejection(
      generateNextLesson(1, () => {}, done),
      streamError("interrupted")
    );
    if (partial) stream.raw(partial);
    stream.close();
    await rejection;
    assert.equal(done.mock.callCount(), 0);
    assert.equal(stream.body.locked, false);
    await stream.tick(IDLE_TIMEOUT_MS);
    assert.equal(stream.signal.aborted, false);
  });
}

test("server error events are preserved and release the reader", async (t) => {
  const stream = mockSSE(t);
  const done = t.mock.fn();
  const rejection = expectRejection(
    generateNextLesson(1, () => {}, done),
    /服务暂时不可用，请稍后重试/
  );
  stream.send({ error: "服务暂时不可用，请稍后重试" });
  await rejection;
  assert.equal(done.mock.callCount(), 0);
  assert.equal(stream.cancelled, 1);
  assert.equal(stream.body.locked, false);
  await stream.tick(IDLE_TIMEOUT_MS);
  assert.equal(stream.signal.aborted, false);
});

// 经 api-common 的 request 发请求（与 api-client 相同的错误解析），确认 HTTP 错误的 detail 到达调用方且定时器被清掉
const generateViaRequest = (onChunk) =>
  streamNextLesson(
    (signal) =>
      request(
        "http://backend.test/api/courses/1/next",
        null,
        { method: "POST", signal },
        () => "zh"
      ),
    onChunk
  );

for (const [status, body, expected] of [
  [400, '{"detail":"课程已完结"}', /课程已完结/],
  [
    422,
    '{"detail":[{"loc":["body","x"],"msg":"字段不能为空"}]}',
    /字段不能为空/,
  ],
  [502, "Bad Gateway", /HTTP 502/],
]) {
  test(`HTTP ${status} retains the backend message and clears the timer`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let signal;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      signal = options.signal;
      return new Response(body, { status });
    });
    await assert.rejects(
      generateViaRequest(() => {}),
      expected
    );
    t.mock.timers.tick(IDLE_TIMEOUT_MS);
    assert.equal(signal.aborted, false);
  });
}

test("an unreachable backend is reported as such, not as a timeout, and clears the timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    signal = options.signal;
    throw new TypeError("fetch failed");
  });
  await assert.rejects(
    generateViaRequest(() => {}),
    (error) => error instanceof BackendUnreachableError
  );
  t.mock.timers.tick(IDLE_TIMEOUT_MS);
  assert.equal(signal.aborted, false);
});

test("network errors are not mislabeled as timeouts and clear the timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const failure = new TypeError("Failed to fetch");
  let signal;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    signal = options.signal;
    throw failure;
  });
  await assert.rejects(
    generateNextLesson(1, () => {}),
    (error) => error === failure
  );
  t.mock.timers.tick(IDLE_TIMEOUT_MS);
  assert.equal(signal.aborted, false);
});

test("a missing response body reports an actionable error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async () => new Response(null));
  await assert.rejects(
    generateNextLesson(1, () => {}),
    streamError("noBody")
  );
});

test("callback SyntaxErrors are not mistaken for malformed SSE JSON", async (t) => {
  const stream = mockSSE(t);
  const failure = new SyntaxError("callback failed");
  const rejection = expectRejection(
    generateNextLesson(1, () => {
      throw failure;
    }),
    (error) => error === failure
  );
  stream.send({ content: "课文" });
  stream.send({ done: true });
  stream.close();
  await rejection;
  assert.equal(stream.body.locked, false);
});

test("cleanup failures do not hide the original server error", async (t) => {
  const stream = mockSSE(t, {
    cancel: () => Promise.reject(new Error("cleanup failed")),
  });
  const rejection = expectRejection(
    generateNextLesson(1, () => {}),
    /生成失败/
  );
  stream.send({ error: "生成失败" });
  await rejection;
  await flush();
  assert.equal(stream.body.locked, false);
});

test("eight consecutive long generations do not reuse signals or leave stale timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals = [];
  for (let lesson = 2; lesson <= 9; lesson += 1) {
    const stream = mockSSE(t, { mockTimers: false });
    const done = [];
    const request = generateNextLesson(
      1,
      () => {},
      (data) => done.push(data)
    );
    request.catch(() => {});
    await flush();
    signals.push(stream.signal);
    for (let part = 0; part < 3; part += 1) {
      await stream.tick(60000);
      assert.ok(signals.every((signal) => !signal.aborted));
      stream.send({ content: `lesson ${lesson}, part ${part}` });
      await flush();
    }
    stream.send({ done: true, lesson_number: lesson });
    await request;
    assert.deepEqual(done, [{ done: true, lesson_number: lesson }]);
    assert.equal(stream.body.locked, false);
  }
  assert.equal(new Set(signals).size, 8);
  t.mock.timers.tick(IDLE_TIMEOUT_MS * 2);
  assert.ok(signals.every((signal) => !signal.aborted));
});

test("a fresh generation can succeed after an earlier idle timeout", async (t) => {
  const first = mockSSE(t);
  const rejection = expectRejection(
    generateNextLesson(1, () => {}),
    streamError("timeout")
  );
  await flush();
  await first.tick(IDLE_TIMEOUT_MS);
  await rejection;

  const second = mockSSE(t, { mockTimers: false });
  const done = [];
  const request = generateNextLesson(
    1,
    () => {},
    (data) => done.push(data)
  );
  second.send({ done: true, lesson_number: 8 });
  await request;
  assert.notEqual(first.signal, second.signal);
  assert.equal(first.signal.aborted, true);
  await second.tick(IDLE_TIMEOUT_MS * 2);
  assert.equal(second.signal.aborted, false);
  assert.deepEqual(done, [{ done: true, lesson_number: 8 }]);
});

test("annotation stream: chunks, final annotation, ignored lines, and server errors", async () => {
  const chunks = [];
  const done = [];
  const body = [
    ": ping\n\n",
    "data: not-json\n\n",
    'data: {"content":"答"}\n\n',
    'data: {"content":"案"}\n\n',
    'data: {"done":true,"annotation":{"id":3}}\n\n',
  ].join("");
  await readAnnotationStream(
    new Response(body),
    (c) => chunks.push(c),
    (d) => done.push(d)
  );
  assert.deepEqual(chunks, ["答", "案"]);
  assert.deepEqual(done, [{ done: true, annotation: { id: 3 } }]);

  await assert.rejects(
    readAnnotationStream(
      new Response('data: {"error":"没能回答这条提问，请稍后重试"}\n\n'),
      () => {}
    ),
    /没能回答这条提问/
  );
});

for (const partial of ["", 'data: {"content":"半截"}\n\n']) {
  test(`annotation stream: EOF without done is an interruption, not a silent success (${partial ? "partial" : "empty"})`, async () => {
    const chunks = [];
    const done = [];
    await assert.rejects(
      readAnnotationStream(new Response(partial), (c) => chunks.push(c), (d) => done.push(d)),
      (error) => error instanceof StreamError && error.code === "answerInterrupted"
    );
    assert.deepEqual(chunks, partial ? ["半截"] : []);
    assert.deepEqual(done, []);
  });
}

test("annotation stream: a network failure mid-answer becomes a translatable interruption", async () => {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode('data: {"content":"部分"}\n\n'));
      setTimeout(() => c.error(new TypeError("network error")), 0);
    },
  });
  const chunks = [];
  await assert.rejects(
    readAnnotationStream(new Response(body), (c) => chunks.push(c)),
    (error) => error instanceof StreamError && error.code === "answerInterrupted"
  );
  assert.deepEqual(chunks, ["部分"]);
});

test("annotation stream: a connection reset after done is still a success (done means the answer is saved)", async () => {
  let cancelled = 0;
  const body = new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode('data: {"content":"答案"}\n\ndata: {"done":true,"annotation":{"id":5}}\n\n'));
      setTimeout(() => c.error(new TypeError("network error")), 0);
    },
    cancel() {
      cancelled += 1;
    },
  });
  const chunks = [];
  const done = [];
  await readAnnotationStream(new Response(body), (c) => chunks.push(c), (d) => done.push(d));
  assert.deepEqual(chunks, ["答案"]);
  assert.deepEqual(done, [{ done: true, annotation: { id: 5 } }]);
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test("next-lesson stream: a browser network error mid-stream becomes a translatable interruption, not raw English", async (t) => {
  for (const message of ["network error", "Load failed"]) {
    const stream = mockSSE(t, { mockTimers: false });
    const chunks = [];
    const rejection = expectRejection(
      generateNextLesson(1, (chunk) => chunks.push(chunk)),
      streamError("interrupted")
    );
    stream.send({ content: "半篇" });
    await flush();
    stream.error(new TypeError(message));
    await rejection;
    assert.deepEqual(chunks, ["半篇"]);
    assert.equal(stream.body.locked, false);
  }
});

test("annotation stream: aborting mid-stream surfaces the AbortError so the caller can save the partial answer", async () => {
  const controller = new AbortController();
  const body = new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode('data: {"content":"部分"}\n\n'));
      controller.signal.addEventListener(
        "abort",
        () => c.error(new DOMException("aborted", "AbortError")),
        { once: true }
      );
    },
  });
  const chunks = [];
  const request = readAnnotationStream(new Response(body), (c) =>
    chunks.push(c)
  );
  await flush();
  controller.abort();
  await assert.rejects(request, (error) => error.name === "AbortError");
  assert.deepEqual(chunks, ["部分"]);
});

test("annotation stream: server error events and failing callbacks cancel the reader", async () => {
  for (const [body, onChunk, expected] of [
    [
      'data: {"content":"部分"}\n\ndata: {"error":"没能回答这条追问，请稍后重试"}\n\n',
      () => {},
      /没能回答这条追问/,
    ],
    [
      'data: {"content":"x"}\n\n',
      () => {
        throw new Error("callback failed");
      },
      /callback failed/,
    ],
  ]) {
    let cancelled = 0;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(body));
      },
      cancel() {
        cancelled += 1;
      },
    });
    await assert.rejects(
      readAnnotationStream(new Response(stream), onChunk),
      expected
    );
    await flush();
    assert.equal(
      cancelled,
      1,
      "the reader must be cancelled on every exit path"
    );
    assert.equal(stream.locked, false);
  }
});
