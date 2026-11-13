import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/components/learn/new-course-dialog.tsx", import.meta.url), "utf8");

function pageDragHarness({ open = true, creating = false, mode = "topic" } = {}) {
  const tree = ts.createSourceFile("dialog.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect" &&
        node.getText(tree).includes('window.addEventListener("drop"')) effect = node.arguments[0].getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(effect, "A page-wide file drop listener must exist");
  const target = new EventTarget();
  const state = { active: false, drops: 0 };
  const js = ts.transpile(`const effect = ${effect};`, { target: ts.ScriptTarget.ES2020 });
  const cleanup = new Function("window", "open", "creating", "mode", "setPageDrag", "pageDropRef",
    "mountedRef", "openRef", "setError", "t", `${js}; return effect();`)(
    target, open, creating, mode, (value) => { state.active = value; },
    { current: async () => { state.drops++; } }, { current: true }, { current: open }, () => {}, (key) => key,
  );
  const send = (type, files = true) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: files ? ["Files"] : ["text/plain"], dropEffect: "none" } });
    target.dispatchEvent(event);
    return event;
  };
  return { state, send, cleanup };
}

test("page-wide file drag stays active across children; dropping prevents navigation and handles once", () => {
  const h = pageDragHarness();
  h.send("dragenter");
  h.send("dragenter");
  h.send("dragleave");
  assert.equal(h.state.active, true);
  const over = h.send("dragover");
  assert.equal(over.defaultPrevented, true);
  assert.equal(over.dataTransfer.dropEffect, "copy");
  assert.equal(h.send("drop").defaultPrevented, true);
  assert.equal(h.state.drops, 1);
  assert.equal(h.state.active, false);
  h.cleanup();
  h.send("drop");
  assert.equal(h.state.drops, 1);
});

test("page drag ignores text and disables listeners while closed or creating; exit clears highlight", () => {
  const h = pageDragHarness();
  assert.equal(h.send("dragover", false).defaultPrevented, false);
  h.send("drop", false);
  assert.equal(h.state.drops, 0);
  h.send("dragenter");
  h.send("dragleave");
  assert.equal(h.state.active, false);
  h.send("dragenter");
  h.send("blur");
  assert.equal(h.state.active, false);
  h.cleanup();
  for (const options of [{ open: false }, { creating: true }]) {
    const disabled = pageDragHarness(options);
    assert.equal(disabled.send("drop").defaultPrevented, false);
    assert.equal(disabled.state.drops, 0);
  }
});
