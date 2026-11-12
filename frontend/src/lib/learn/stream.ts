
const LESSON_STREAM_IDLE_TIMEOUT_MS = 120000;
// 收到响应头之前单独计时：请求排队、冷启动、后端先排教学计划（模型调用最长 45 秒）都还没开始流式，不算「流没有数据」
const LESSON_CONNECT_TIMEOUT_MS = 180000;

export type StreamErrorCode = "noBody" | "interrupted" | "timeout" | "connectTimeout" | "answerInterrupted";

export class StreamError extends Error {
  constructor(public code: StreamErrorCode) {
    super(code);
    this.name = "StreamError";
  }
}

type StreamData = {
  content?: string;
  error?: string;
  code?: string;
  done?: boolean;
  [key: string]: unknown;
};

// 流里的 `{error}` 事件：原样抛出后端的话
const streamError = (data: StreamData) => new Error(data.error);

// 批注问答的 SSE：每个 token 调 onChunk，最终事件调 onDone；`{error}` 抛出。
// done 是后端存好之后才发的：收到就返回，之后连接被重置也不算中断（和 streamNextLesson 一样）。
// 没收到 done 就断了（EOF、网络错误）抛 StreamError("answerInterrupted")：回答没存下来，不能当成功
export async function readAnnotationStream<T extends StreamData>(
  res: Response,
  onChunk: (text: string) => void,
  onDone?: (data: T) => void
) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if ((err as Error)?.name === "AbortError") throw err;
        throw new StreamError("answerInterrupted");
      }
      const { done, value } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let data: T;
        try {
          data = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (data.error) throw streamError(data);
        if (data.content) onChunk(data.content);
        if (data.done) {
          onDone?.(data);
          return;
        }
      }
    }
    throw new StreamError("answerInterrupted");
  } finally {
    // 出错或回调抛异常时也要断开连接，收尾不能盖住原始错误
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// 只限制「无数据」的时长而非总时长：长课文带着前文上下文可能连续生成两分钟以上。
export async function streamNextLesson<T extends StreamData>(
  open: (signal: AbortSignal) => Promise<Response>,
  onChunk: (text: string) => void,
  onDone?: (data: T) => void,
  idleTimeoutMs = LESSON_STREAM_IDLE_TIMEOUT_MS,
  connectTimeoutMs = LESSON_CONNECT_TIMEOUT_MS
) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  let timedOut: StreamErrorCode | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const startTimeout = (ms: number, code: StreamErrorCode) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      timedOut = code;
      controller.abort();
    }, ms);
  };
  const resetIdleTimeout = () => startTimeout(idleTimeoutMs, "timeout");

  try {
    startTimeout(connectTimeoutMs, "connectTimeout");
    const res = await open(controller.signal);
    if (!res.body) throw new StreamError("noBody");

    resetIdleTimeout();
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const processLine = (line: string) => {
      if (!line.startsWith("data:")) return false;
      let data: T;
      try {
        data = JSON.parse(line.slice(5));
      } catch {
        return false;
      }
      if (!data) return false;
      if (data.error) throw streamError(data);
      // 回调的异常不能落进上面解析 JSON 的 catch
      if (data.content) onChunk(data.content);
      if (data.done) {
        if (onDone) onDone(data);
        return true;
      }
      return false;
    };

    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        // 超时是我们自己 abort 的，由下面的 catch 换成 timeout；其余读流异常（浏览器的 TypeError「network error」「Load failed」）
        // 不把英文原话丢给界面，按「连接中断、没收到完成确认」处理
        if (timedOut) throw err;
        throw new StreamError("interrupted");
      }
      const { done, value } = chunk;
      if (done) {
        buffer += decoder.decode();
        if (processLine(buffer)) return;
        // 只有 EOF 不能证明后端已保存课文
        throw new StreamError("interrupted");
      }
      // 重试期间（保存前检查到参考答案里有自我更正，后端再生成一次）后端每 10 秒发一行 SSE 注释 `: keepalive` 当心跳，
      // 这里收到任何字节就重置 120 秒无数据超时；注释行不以 data: 开头，processLine 会跳过。其余时候模型沉默期间没有数据，
      // 后端自己的流读超时（90 秒）比这里短，模型卡住时通常是它先报错
      if (value.byteLength > 0) resetIdleTimeout();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        // 后端提交后才发 done，不必等 socket 关闭
        if (processLine(line)) return;
      }
    }
  } catch (err) {
    if (timedOut) throw new StreamError(timedOut);
    throw err;
  } finally {
    clearTimeout(timeout!);
    if (reader) {
      // 收尾不能拖慢跳转，也不能盖住原始错误
      reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
