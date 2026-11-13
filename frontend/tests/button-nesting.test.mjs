import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

async function tsxFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) out.push(...(await tsxFiles(url)));
    else if (entry.name.endsWith(".tsx")) out.push(url);
  }
  return out;
}

const tag = (node) =>
  ts.isJsxElement(node) ? node.openingElement.tagName.getText() : null;

function descendants(node, found = []) {
  ts.forEachChild(node, (child) => {
    found.push(child);
    descendants(child, found);
  });
  return found;
}

// 404、错误页、页眉页脚用到的区块：按钮和链接不能互相嵌套（按钮套链接只有文字可点，链接套按钮是非法的交互元素嵌套）
test("区块与页面里没有 <Button><Link> 或 <Link><Button> 嵌套（用 <Button asChild>）", async () => {
  const files = [
    ...(await tsxFiles(new URL("../src/components/site/", import.meta.url))),
    ...(await tsxFiles(new URL("../src/app/", import.meta.url))),
  ];
  const bad = [];
  for (const url of files) {
    const text = await readFile(url, "utf8");
    const sf = ts.createSourceFile(url.pathname, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const node of descendants(sf)) {
      const name = tag(node);
      if (name === "Button") {
        const asChild = node.openingElement.attributes.properties.some(
          (a) => ts.isJsxAttribute(a) && a.name.getText() === "asChild"
        );
        if (!asChild && descendants(node).some((d) => ["Link", "a"].includes(tag(d)))) {
          bad.push(`${url.pathname.split("/src/")[1]}: <Button> 里有链接`);
        }
      }
      if (name === "Link" || name === "a") {
        if (descendants(node).some((d) => tag(d) === "Button")) {
          bad.push(`${url.pathname.split("/src/")[1]}: <${name}> 里有 <Button>`);
        }
      }
    }
  }
  assert.deepEqual(bad, []);
});
