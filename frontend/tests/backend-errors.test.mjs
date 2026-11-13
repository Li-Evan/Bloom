import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { createTranslator } from "next-intl";
import { KNOWN_ERROR_KEYS } from "../src/lib/backend-errors.ts";

const BACKEND = new URL("../../backend/app/", import.meta.url);
const load = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const [en, zh] = await Promise.all([
  load("../src/i18n/messages/en.json"),
  load("../src/i18n/messages/zh.json"),
]);

// 不翻译、也不按整句匹配的固定报错，每条写明理由。新增的后端报错必须进 KNOWN_ERROR_KEYS 或这里。
const EXEMPT = {
  // 浏览器永远发不出的请求
  "学习深度必须是 simple、standard 或 deep": "界面只提供三个固定选项",
  令牌类型不符: "界面只发用户令牌",
  "Invalid learning intent": "界面把澄清结果原样拼成 learning_intent，正常发不出不合法的；原因附在后面方便排查",
  // 后端原文是英文：英文界面原样可读；中文界面会显示英文，要中文得先把后端文案改成中文，再进映射表
  "Upload expired or unavailable; please upload again.": "英文原文；上传授权 1 小时后过期时会看到",
  "Upload already consumed; please upload again.": "英文原文；同一次上传重复建课时会看到",
  "Upload incomplete; please upload again.": "英文原文；分片没传完就建课时会看到",
  "Upload checksum mismatch; please upload again.": "英文原文；上传内容校验不一致时会看到",
  "Chunk already uploaded with different content.": "英文原文；上传途中文件被改动时会看到",
  "Files must total at most 50 MB.": "英文原文；界面上传前已按 50 MB 拦下",
  "Invalid or duplicate filenames.": "英文原文；浏览器给的文件名不含空字符",
  "Upload chunk exceeds 1 MB.": "英文原文；界面按后端给的分片大小切片",
  "Invalid file index.": "英文原文；界面只传登记过的文件序号",
  "Invalid chunk index or length.": "英文原文；界面按后端给的分片大小切片",
};

const STRING = String.raw`"((?:[^"\\]|\\.)*)"`;
const QUOTED = String.raw`(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')`;

async function pythonFiles(dir = BACKEND) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory() && entry.name !== "__pycache__") {
      out.push(...(await pythonFiles(url)));
    } else if (entry.name.endsWith(".py")) {
      out.push(url);
    }
  }
  return out;
}

// 一个后端源文件里所有不含变量的、会返回给浏览器的报错原文
function scanSource(source, add) {
  const constants = new Map(
    [...source.matchAll(new RegExp(String.raw`^([A-Z_]+)\s*=\s*${STRING}$`, "gm"))].map(
      (m) => [m[1], m[2]]
    )
  );
  // HTTPException(status_code=400, detail="…") 和位置参数 HTTPException(400, "…") 两种写法，可以跨行，单双引号都算；
  // 状态码可以是数字、变量或 status.HTTP_…；f 字符串和 with_reason(…) 不在这里匹配
  for (const m of source.matchAll(
    new RegExp(String.raw`HTTPException\(\s*(?:status_code=)?[\w.]+,\s*(?:detail=)?(?:${QUOTED}|([A-Z_]+)\b)`, "g")
  )) {
    const text = m[1] ?? m[2] ?? constants.get(m[3]);
    if (text !== undefined) add(text);
  }
  // 带原因的报错：with_reason("固定提示", exc) 与 model_failure 的 (状态码, 固定提示) 对照表
  for (const m of source.matchAll(new RegExp(String.raw`with_(?:reason|detail)\(\s*(?:${STRING}|([A-Z_]+))`, "g"))) {
    const text = m[1] ?? constants.get(m[2]);
    if (text !== undefined) add(text);
  }
  for (const m of source.matchAll(new RegExp(String.raw`^\s*return \d{3}, (?:${STRING}|([A-Z_]+))$`, "gm"))) {
    const text = m[1] ?? constants.get(m[2]);
    if (text !== undefined) add(text);
  }
  for (const m of source.matchAll(new RegExp(String.raw`\{"detail":\s*${STRING}\}`, "g"))) {
    add(m[1]);
  }
  for (const m of source.matchAll(/"message":\s*"([^"]+)"/g)) {
    add(m[1]);
  }
  // _stream_error(failure, retry=…, exc=…)：拼成「失败，重试提示」
  const retryDefault = source.match(/def _stream_error\([^)]*retry: str = "([^"]+)"/)?.[1];
  for (const m of source.matchAll(new RegExp(String.raw`_stream_error\(${STRING},`, "g"))) {
    const call = source.slice(m.index, source.indexOf(")\n", m.index));
    const retry = call.match(new RegExp(String.raw`retry=${STRING}`))?.[1] ?? retryDefault;
    add(`${m[1]}，${retry}`);
  }
}

// 后端里所有不含变量的、会返回给浏览器的报错原文
async function staticBackendMessages() {
  const messages = new Map();
  for (const url of await pythonFiles()) {
    const file = url.pathname.split("/backend/app/")[1];
    scanSource(await readFile(url, "utf8"), (text) => messages.set(text, file));
  }
  return messages;
}

test("扫描覆盖 HTTPException 的各种写法：关键字参数、位置参数、跨行、单引号、status 常量、模块常量；不收 f 字符串", () => {
  const found = [];
  scanSource(
    [
      'NOT_FOUND = "常量报错"',
      'raise HTTPException(status_code=404, detail="关键字参数")',
      'raise HTTPException(409, "位置参数")',
      "raise HTTPException(\n    400,\n    \"跨行的位置参数\",\n)",
      "raise HTTPException(status.HTTP_403_FORBIDDEN, detail='单引号')",
      "raise HTTPException(404, NOT_FOUND)",
      'raise HTTPException(400, f"{name} 带变量")',
      "raise HTTPException(status, with_reason(\"带原因\", exc))",
    ].join("\n"),
    (text) => found.push(text)
  );
  assert.deepEqual(found.sort(), ["位置参数", "关键字参数", "单引号", "带原因", "常量报错", "跨行的位置参数"].sort());
});

test("扫描能找到后端的固定报错（防止正则失效后测试空转）", async () => {
  const messages = await staticBackendMessages();
  assert.ok(messages.size > 60, `只扫到 ${messages.size} 条`);
  for (const sample of [
    "找不到这门课程",
    "没能调用模型服务，请稍后重试",
    "没能回答这条提问，请稍后重试",
    "没能生成课程总结，请稍后重试",
    "服务器出了点问题，请稍后重试",
    "已经开始学习，不能修改大纲",
    "找不到这条标记",
  ]) {
    assert.ok(messages.has(sample), `没扫到：${sample}`);
  }
});

test("后端每一条固定报错要么在 KNOWN_ERROR_KEYS 里有译文，要么在豁免清单里", async () => {
  const unhandled = [...(await staticBackendMessages())]
    .filter(([text]) => !(text in KNOWN_ERROR_KEYS) && !(text in EXEMPT))
    .map(([text, file]) => `${file}: ${text}`);
  assert.deepEqual(unhandled, []);
});

test("映射表和豁免清单里没有已经从后端消失的旧文案", async () => {
  const messages = await staticBackendMessages();
  const stale = [...Object.keys(KNOWN_ERROR_KEYS), ...Object.keys(EXEMPT)].filter(
    (text) => !messages.has(text)
  );
  assert.deepEqual(stale, []);
});

test("errors 命名空间没有死键：每个键要么是后端报错或代理报错的译文，要么在源码里按名字用到", async () => {
  const { BRIDGE_ERROR_KEYS } = await import("../src/lib/backend-errors.ts");
  const mapped = new Set([...Object.values(KNOWN_ERROR_KEYS), ...Object.values(BRIDGE_ERROR_KEYS)]);
  const sources = async (dir) => {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) out.push(...(await sources(url)));
      else if (/\.tsx?$/.test(entry.name)) out.push(await readFile(url, "utf8"));
    }
    return out;
  };
  const code = (await sources(new URL("../src/", import.meta.url))).join("\n");
  const dead = Object.keys(zh.errors).filter((key) => !mapped.has(key) && !code.includes(`"${key}"`));
  assert.deepEqual(dead, []);
});

test("同一句话不能既映射又豁免", () => {
  assert.deepEqual(
    Object.keys(KNOWN_ERROR_KEYS).filter((text) => text in EXEMPT),
    []
  );
});

test("映射表：zh 文案与后端原文一致（原样显示），en 有译文且不含中文，各键只对应一句", () => {
  const keys = Object.values(KNOWN_ERROR_KEYS);
  assert.equal(new Set(keys).size, keys.length, "有两句后端报错共用了一个键");
  for (const [message, key] of Object.entries(KNOWN_ERROR_KEYS)) {
    assert.equal(zh.errors[key], message, key);
    assert.ok(typeof en.errors[key] === "string" && en.errors[key], key);
    assert.doesNotMatch(en.errors[key], /[一-鿿]/, `en ${key} 含中文`);
  }
  assert.deepEqual(Object.keys(en.errors).sort(), Object.keys(zh.errors).sort());
});

test("错误文案不提积分或退款：开源版没有这些", () => {
  for (const [message, key] of Object.entries(KNOWN_ERROR_KEYS)) {
    assert.doesNotMatch(message, /积分|退回|退款/, message);
    assert.doesNotMatch(en.errors[key], /\bcredits?\b|\brefund/i, `${key}: "${en.errors[key]}"`);
  }
});

test("errors 命名空间的文案是合法的 ICU 消息，能格式化", () => {
  for (const [locale, messages] of [
    ["en", en],
    ["zh", zh],
  ]) {
    const problems = [];
    const t = createTranslator({
      locale,
      messages,
      namespace: "errors",
      onError: (e) => problems.push(e.message),
    });
    for (const key of Object.keys(messages.errors)) {
      assert.ok(t(key).length > 0, `${locale} ${key}`);
    }
    assert.deepEqual(problems, [], locale);
  }
});

test("前端代理自己的报错：中文原文即译文，英文有译文且不含中文", async () => {
  const { BRIDGE_ERROR_KEYS } = await import("../src/lib/backend-errors.ts");
  for (const [message, key] of Object.entries(BRIDGE_ERROR_KEYS)) {
    assert.equal(zh.errors[key], message, key);
    assert.ok(en.errors[key], key);
    assert.doesNotMatch(en.errors[key], /[一-鿿]/, key);
    assert.ok(!(message in KNOWN_ERROR_KEYS), `${message} 不是后端文案`);
  }
});

test("带原因的报错：固定提示照常翻译，原因原样保留；不认识的提示整句原样显示", async () => {
  const { translateBackendMessage, splitReason } = await import("../src/lib/backend-errors.ts");
  const t = (key) => ({ reasonOpen: " (Reason: ", reasonClose: ")" })[key] ?? `<${key}>`;
  const reason = "model provider HTTP 400: Unsupported parameter: 'max_tokens'";
  assert.equal(
    translateBackendMessage(`没能分析学习目标，请稍后重试（原因：${reason}）`, t),
    `<goalAnalysisFailed> (Reason: ${reason})`
  );
  assert.equal(translateBackendMessage("无法连接后端服务（原因：ECONNREFUSED）", t), "<backendUnreachable> (Reason: ECONNREFUSED)");
  assert.equal(translateBackendMessage("一句没见过的话（原因：x）", t), "一句没见过的话（原因：x）");
  assert.deepEqual(splitReason("找不到这门课程"), ["找不到这门课程", undefined]);
  assert.deepEqual(splitReason("a（原因：b（c））"), ["a", "b（c）"]);
});

test("translateBackendMessage：认识的换成译文，不认识的原样返回，原型链上的名字不当作报错", async () => {
  const { translateBackendMessage } = await import("../src/lib/backend-errors.ts");
  const t = (key) => `<${key}>`;
  assert.equal(translateBackendMessage("找不到这门课程", t), "<courseNotFound>");
  assert.equal(translateBackendMessage("一句没见过的话", t), "一句没见过的话");
  assert.equal(translateBackendMessage("constructor", t), "constructor");
  assert.equal(translateBackendMessage("toString", t), "toString");
});
