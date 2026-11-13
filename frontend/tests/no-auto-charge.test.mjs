import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.test";
globalThis.document = { documentElement: { lang: "zh" } };

const { loadNextData } = await import("../src/lib/learn/api.ts");

const json = (body) => new Response(JSON.stringify(body));

function mockBackend(t, calls) {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const path = new URL(String(url), "http://x").pathname;
    if (path === "/api/token") {
      return json({ token: "t", expires_at: Date.now() / 1000 + 900 });
    }
    calls.push(`${init.method ?? "GET"} ${path}`);
    if (path === "/api/backend/courses") return json([{ id: 1, name: "课程" }]);
    if (path === "/api/backend/stats") return json({ total_courses: 1 });
    if (path === "/api/backend/recommendations")
      return json({ recommendations: [], saved: [] });
    return new Response(JSON.stringify({ detail: `unexpected ${path}` }), {
      status: 500,
    });
  });
}

test("「下一步学习」首次加载只读：有课程、没有推荐时只取推荐，不调用 recommendations/refresh", async (t) => {
  const calls = [];
  mockBackend(t, calls);

  const data = await loadNextData();

  assert.deepEqual(calls, ["GET /api/backend/recommendations"]);
  assert.deepEqual(data.recommendations, []);
  assert.deepEqual(data.saved, []);
});

// 会调用模型的前端函数（对应 POST /api/backend/courses*、/next、…/annotations、…/messages、/recommendations/refresh）
const CHARGED = [
  "createCourse",
  "createCourseFromMaterials",
  "generateNextLesson",
  "createAnnotation",
  "addAnnotationMessage",
  "refreshRecommendations",
];

async function sources() {
  const out = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) await walk(url);
      else if (/\.tsx?$/.test(entry.name) && entry.name !== "api.ts") {
        out.push([entry.name, await readFile(url, "utf8")]);
      }
    }
  };
  await walk(new URL("../src/", import.meta.url));
  return out;
}

// 这些调用的回调不是用户事件：渲染 / 副作用 / 定时器
const NOT_EVENTS = new Set([
  "useEffect",
  "useLayoutEffect",
  "useMemo",
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "queueMicrotask",
]);

const calleeName = (node) =>
  ts.isIdentifier(node.expression) ? node.expression.text : null;

function* ancestors(node) {
  for (let n = node.parent; n; n = n.parent) yield n;
}

// 函数的名字：function handleX(){} 或 const handleX = () => {}
function functionName(node) {
  if (ts.isFunctionDeclaration(node)) return node.name?.text;
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
}

const inNotEvent = (node) =>
  [...ancestors(node)].find(
    (a) => ts.isCallExpression(a) && NOT_EVENTS.has(calleeName(a))
  );

function parse(file, text) {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

// 扫描全部源码，返回 { 调用: [{file, name, handler}], 引用: [{file, name, node}] }
async function scan() {
  const calls = [];
  const handlers = new Set();
  const trees = [];
  for (const [file, text] of await sources()) {
    const sf = parse(file, text);
    trees.push([file, sf]);
    visit(sf, (node) => {
      if (ts.isCallExpression(node) && CHARGED.includes(calleeName(node))) {
        const owner = [...ancestors(node)].map(functionName).find(Boolean);
        calls.push({
          file,
          node,
          name: calleeName(node),
          owner,
          bad: inNotEvent(node),
        });
        if (owner && /^handle[A-Z]/.test(owner)) handlers.add(owner);
      }
    });
  }
  const refs = [];
  for (const [file, sf] of trees) {
    visit(sf, (node) => {
      if (ts.isIdentifier(node) && handlers.has(node.text))
        refs.push({ file, node });
    });
  }
  return { calls, handlers, refs, trees };
}

test("会调用模型的函数只在 handle* 事件处理函数里被调用，不在 useEffect / useMemo / 定时器里", async () => {
  const { calls } = await scan();
  assert.ok(calls.length >= 7, `只找到 ${calls.length} 处调用`);
  for (const { file, name, owner, bad } of calls) {
    assert.ok(
      !bad,
      bad && `${file}: ${name} 在 ${calleeName(bad)} 的回调里被调用`
    );
    assert.match(
      owner ?? "",
      /^handle[A-Z]\w*$/,
      `${file}: ${name} 不在 handle* 函数里（在 ${owner} 里）`
    );
  }
  assert.deepEqual(
    [...new Set(calls.map((c) => c.name))].sort(),
    [...CHARGED].sort(),
    "每个会调用模型的函数都应该至少有一处调用被检查到"
  );
});

test("调用了模型接口的处理函数，只能挂在 on* 事件属性上或被别的 handle* 调用，不能出现在副作用里", async () => {
  const { handlers, refs } = await scan();
  assert.ok(handlers.size >= 6, `只找到 ${handlers.size} 个处理函数`);
  for (const { file, node } of refs) {
    if (
      functionName(node.parent) === node.text ||
      ts.isVariableDeclaration(node.parent)
    )
      continue; // 声明本身
    if (ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent))
      continue;
    assert.ok(!inNotEvent(node), `${file}: ${node.text} 被放进了副作用/定时器`);
    const eventAttr = [...ancestors(node)].find(
      (a) => ts.isJsxAttribute(a) && /^on[A-Z]/.test(a.name.getText())
    );
    const otherHandler = [...ancestors(node)]
      .map(functionName)
      .find((n) => n && /^handle[A-Z]/.test(n) && n !== node.text);
    assert.ok(
      eventAttr || otherHandler,
      `${file}: ${node.text} 不是挂在事件属性上`
    );
  }
});

test("通用错误条不带会调用模型的动作：error && … 里不能引用这些处理函数", async () => {
  const { handlers, trees } = await scan();
  let errorBars = 0;
  for (const [file, sf] of trees) {
    visit(sf, (node) => {
      if (
        !ts.isBinaryExpression(node) ||
        node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken ||
        !ts.isIdentifier(node.left) ||
        node.left.text !== "error"
      ) {
        return;
      }
      errorBars++;
      visit(node.right, (n) => {
        assert.ok(
          !(ts.isIdentifier(n) && handlers.has(n.text)),
          `${file}: 通用错误条里引用了会调用模型的 ${n.text}`
        );
      });
    });
  }
  assert.ok(errorBars >= 3, `只找到 ${errorBars} 个 error && … 错误条`);
});
