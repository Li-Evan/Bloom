import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

async function parse(file) {
  const text = await readFile(
    new URL(`../src/components/learn/${file}`, import.meta.url),
    "utf8"
  );
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

function find(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  // forEachChild 的回调返回真值会提前结束遍历，所以用语句体
  ts.forEachChild(node, (child) => {
    find(child, predicate, found);
  });
  return found;
}

test("课文页：带「重试」的错误条也有关闭按钮（不能只有重试一条路）", async () => {
  const sf = await parse("lesson.tsx");
  const bars = find(
    sf,
    (n) =>
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      ts.isIdentifier(n.left) &&
      n.left.text === "nextError"
  );
  assert.equal(bars.length, 1, "应该恰好有一个 nextError 错误条");
  const attrs = find(bars[0].right, (n) => ts.isJsxAttribute(n)).map((n) => [
    n.name.getText(),
    n.initializer?.getText() ?? "",
  ]);
  assert.ok(
    attrs.some(([name, init]) => name === "onClick" && init.includes("handleRetryNext")),
    "重试按钮还在"
  );
  // 重试会再调用一次模型：先不走缓存确认上一次没有在后台存好新课文，确认没有才走 handleReadDone（经 ref 拿最新一次渲染的那个，不用点重试那一刻的旧闭包）
  const retry = find(sf, (n) => ts.isVariableDeclaration(n) && n.name.getText() === "handleRetryNext")[0].getText();
  assert.ok(retry.indexOf("goToLandedLesson()") > 0 && retry.indexOf("goToLandedLesson()") < retry.indexOf("handleReadDoneRef.current()"));
  assert.match(sf.getText(), /handleReadDoneRef\.current = handleReadDone;/);
  // 守卫看 ref：检查期间、生成期间再点重试都不会发第二个 POST /next
  assert.match(retry, /if \(checkingNextRef\.current \|\| generatingRef\.current\) return;/);
  const landed = find(sf, (n) => ts.isVariableDeclaration(n) && n.name.getText() === "goToLandedLesson")[0].getText();
  assert.match(landed, /getLessons\(courseId, true\)/);
  // 关闭：错误条组件的 onClose 只清掉错误，不会重试
  assert.ok(
    attrs.some(
      ([name, init]) =>
        name === "onClose" && /setNextError\(\s*""\s*\)/.test(init) && !init.includes("handleReadDone")
    ),
    "没有关闭按钮"
  );

  // 错误条组件里确实渲染了会调 onClose 的关闭按钮
  const notice = await parse("lesson-feedback.tsx");
  const comp = find(
    notice,
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === "LessonNotice"
  );
  assert.equal(comp.length, 1);
  const closes = find(
    comp[0],
    (n) => ts.isJsxAttribute(n) && n.name.getText() === "onClick"
  ).map((n) => n.initializer.getText());
  assert.ok(closes.some((c) => c === "{onClose}"), "LessonNotice 的关闭按钮没有接 onClose");
});

test("PDF 渲染循环：每次 await 之后、写入共享状态之前都要检查 cancelled", async () => {
  const sf = await parse("pdf-viewer.tsx");
  const isCancelledReturn = (stmt) =>
    stmt &&
    ts.isIfStatement(stmt) &&
    stmt.expression.getText() === "cancelled" &&
    /^return;?$/.test(stmt.thenStatement.getText().replace(/[{}\s]/g, ""));

  const guardedAfter = (predicate, what) => {
    const hits = find(sf, (n) => ts.isBlock(n) && n.statements.some(predicate));
    assert.ok(hits.length, `没找到 ${what}`);
    for (const block of hits) {
      const i = block.statements.findIndex(predicate);
      assert.ok(
        block.statements
          .slice(0, i)
          .some((s, j) => j === i - 1 && isCancelledReturn(s)),
        `${what} 前面应紧跟 if (cancelled) return`
      );
    }
  };

  // 往共享的 pagesRef 里放页
  guardedAfter(
    (s) =>
      ts.isExpressionStatement(s) &&
      s.expression.getText().startsWith("pagesRef.current.push("),
    "pagesRef.current.push"
  );
  // await pdf.getPage(n) 之后、往 host 里加页面元素之前
  const afterGetPage = (s) =>
    ts.isVariableStatement(s) && s.getText().includes("await pdf.getPage(");
  const blocks = find(
    sf,
    (n) => ts.isBlock(n) && n.statements.some(afterGetPage)
  );
  assert.equal(blocks.length, 1);
  const i = blocks[0].statements.findIndex(afterGetPage);
  assert.ok(
    isCancelledReturn(blocks[0].statements[i + 1]),
    "await pdf.getPage 之后要检查 cancelled"
  );
});
