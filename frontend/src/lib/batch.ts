// 同一时刻发出的多个后端读请求合成一次 POST /api/batch：后端在同一个实例里并发执行，每条一完成就以一行 JSON 流回。
// 部署在「一个请求一个实例」的无服务器平台上时，页面并发的 N 个读请求原本各占一个实例，
// 没有空闲的热实例时每个都要冷启动约 3 秒；合成一个请求后只占一个实例。
// 每条请求拿到的仍是它自己的 Response（状态码、正文、Retry-After 和单独请求时一样），调用方照常处理。
// 批量接口不可用（旧后端、平台错误、中途断开）时，没拿到结果的那几条自动退回逐条请求。

export const MAX_BATCH = 12;

type Send = (paths: string[], key: string, signal: AbortSignal) => Promise<Response>;
type Single = (path: string, key: string, signal?: AbortSignal) => Promise<Response>;

type Member = {
  path: string;
  signal?: AbortSignal;
  done: boolean;
  resolve: (res: Response) => void;
  reject: (error: unknown) => void;
};

type Line = { i: number; status: number; body?: unknown; text?: string; headers?: Record<string, string> };

const NO_BODY = new Set([204, 205, 304]);

export function lineResponse({ status, body, text, headers }: Line): Response {
  const head = new Headers(headers);
  if (text !== undefined) {
    head.set("content-type", "text/plain; charset=utf-8");
    return new Response(text, { status, headers: head });
  }
  if (body === null || body === undefined || NO_BODY.has(status)) {
    return new Response(null, { status, headers: head });
  }
  head.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status, headers: head });
}

export async function readLines(body: ReadableStream<Uint8Array>, onLine: (line: Line) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const text = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (text) onLine(JSON.parse(text));
    }
    if (done) break;
  }
  if (buffer.trim()) onLine(JSON.parse(buffer));
}

// key 把能合在一起的请求分组（同一个身份），不同 key 的请求绝不合并。
// send 发整批；single 是平常的单条请求，只有一条时、或者整批没拿到这一条的结果时用它。
export function createBatcher({ send, single, wait = 0 }: { send: Send; single: Single; wait?: number }) {
  const queues = new Map<string, Member[]>();

  function settle(member: Member, outcome: Promise<Response>) {
    outcome.then(
      (res) => {
        if (member.done) return;
        member.done = true;
        member.resolve(res);
      },
      (error) => {
        if (member.done) return;
        member.done = true;
        member.reject(error);
      }
    );
  }

  async function run(key: string, members: Member[]) {
    const live = members.filter((m) => !m.done);
    if (live.length === 1) return settle(live[0], single(live[0].path, key, live[0].signal));
    if (!live.length) return;

    // 每条自己的取消只让那一条失败；所有条都不要了才取消整批
    const whole = new AbortController();
    let wanted = live.length;
    for (const member of live) {
      member.signal?.addEventListener("abort", () => (--wanted === 0 ? whole.abort() : undefined), { once: true });
    }

    try {
      const res = await send(live.map((m) => m.path), key, whole.signal);
      if (!res.ok || !res.body || !res.headers.get("content-type")?.includes("ndjson")) {
        await res.body?.cancel();
        throw new Error(`batch unavailable: HTTP ${res.status}`);
      }
      await readLines(res.body, (line) => {
        const member = live[line.i];
        if (member) settle(member, Promise.resolve(lineResponse(line)));
      });
    } catch {
      // 落到下面逐条重发
    }
    for (const member of live) {
      if (!member.done) settle(member, single(member.path, key, member.signal));
    }
  }

  function flush(key: string) {
    const members = queues.get(key) ?? [];
    queues.delete(key);
    for (let start = 0; start < members.length; start += MAX_BATCH) {
      void run(key, members.slice(start, start + MAX_BATCH));
    }
  }

  return function get(path: string, key: string, signal?: AbortSignal): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const member: Member = { path, signal, done: false, resolve, reject };
      signal?.addEventListener(
        "abort",
        () => {
          if (member.done) return;
          member.done = true;
          reject(signal.reason);
        },
        { once: true }
      );

      const queue = queues.get(key);
      if (queue) return void queue.push(member);
      queues.set(key, [member]);
      setTimeout(() => flush(key), wait);
    });
  };
}
