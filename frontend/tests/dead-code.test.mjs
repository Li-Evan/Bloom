import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";

const src = new URL("../src/", import.meta.url).pathname;

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

test("已无引用的孤儿组件已删除", async () => {
  for (const path of ["components/blocks/block-markdown", "components/feedback"]) {
    await assert.rejects(access(join(src, path)), `${path} 还在`);
  }
});

test("没有留下被注释掉的 Feedback 渲染或它的入口", async () => {
  for (const file of await sourceFiles(src)) {
    assert.doesNotMatch(await readFile(file, "utf8"), /components\/feedback|<Feedback[\s/>]|showFeedback/, file);
  }
});

test("模板残留已删：无引用的组件、重复的 hook、旧的流水类型标签、未使用的 UI 原件", async () => {
  for (const path of [
    "components/blocks/crumb",
    "lib/trans-type.ts",
    "hooks/use-mobile.tsx",
    ...["accordion", "alert", "checkbox", "collapsible", "icon", "navigation-menu", "radio-group", "sonner", "switch", "tabs"].map(
      (name) => `components/ui/${name}.tsx`
    ),
  ]) {
    await assert.rejects(access(join(src, path)), `${path} 还在`);
  }
});

test("package.json 里没有已不再使用的依赖（拖拽、表格、动画、彩纸、旧 Markdown / 高亮库、已删 UI 件的 Radix 包）", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const all = new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)]);
  for (const name of [
    "@dnd-kit/core", "@dnd-kit/modifiers", "@dnd-kit/sortable", "@dnd-kit/utilities",
    "@tanstack/react-table", "framer-motion", "canvas-confetti", "@types/canvas-confetti",
    "markdown-it", "@types/markdown-it", "highlight.js", "@radix-ui/react-icons",
    "@radix-ui/react-accordion", "@radix-ui/react-checkbox", "@radix-ui/react-collapsible",
    "@radix-ui/react-navigation-menu", "@radix-ui/react-radio-group", "@radix-ui/react-switch", "@radix-ui/react-tabs",
  ]) {
    assert.ok(!all.has(name), `${name} 还在 package.json 里`);
  }
});

// 从路由、中间件、i18n 入口出发，沿着 import 走一遍：src 下的 ts / tsx 文件都应该被用到
test("src 下没有没人引用的 ts / tsx 文件（类型声明除外）", async () => {
  const all = (await sourceFiles(src)).filter((f) => !f.endsWith(".d.ts"));
  const has = new Set(all);
  const isEntry = (file) => {
    const rel = relative(src, file);
    return (
      (rel.startsWith("app/") && /(^|\/)(page|layout|error|global-error|not-found|loading|route|template|default|robots|sitemap)\.tsx?$/.test(rel)) ||
      rel === "middleware.ts" || rel === "i18n/request.ts" || rel === "mdx-components.tsx" || rel === "instrumentation.ts"
    );
  };
  const resolveImport = (spec, from) => {
    const base = spec.startsWith("@/") ? join(src, spec.slice(2)) : spec.startsWith(".") ? join(dirname(from), spec) : null;
    if (!base) return null;
    return [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find((c) => has.has(c)) ?? null;
  };
  const seen = new Set(all.filter(isEntry));
  const stack = [...seen];
  while (stack.length) {
    const file = stack.pop();
    const text = await readFile(file, "utf8");
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
      const target = resolveImport(m[1], file);
      if (target && !seen.has(target)) {
        seen.add(target);
        stack.push(target);
      }
    }
  }
  assert.deepEqual(all.filter((f) => !seen.has(f)).map((f) => relative(src, f)), []);
});

test("生产代码已不用的文案键已删：课程页的「读完原文后…」提示、「我读完原文了，生成下一篇」按钮", async () => {
  for (const locale of ["zh", "en"]) {
    const learn = JSON.parse(await readFile(join(src, `i18n/messages/${locale}.json`), "utf8")).learn;
    assert.equal(learn.course.sourceNext, undefined, `${locale}: course.sourceNext`);
    assert.equal(learn.lesson.next.finishedSource, undefined, `${locale}: lesson.next.finishedSource`);
  }
  for (const file of await sourceFiles(src)) {
    assert.doesNotMatch(await readFile(file, "utf8"), /course\.sourceNext\b|next\.finishedSource/, file);
  }
});
