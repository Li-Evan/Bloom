import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { displayFileName, isPdfReadingName, PDF_READING_MAX_FILES, PDF_READING_MAX_PAGES } from "../src/lib/learn/files.ts";

const read = (path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

test("PDF 阅读版的课文靠 .pdf.md 认出来，显示时去掉 .md；上限和后端默认值一致", () => {
  assert.ok(isPdfReadingName("paper.pdf.md"));
  assert.ok(isPdfReadingName("Paper (2).PDF.md"));
  assert.ok(!isPdfReadingName("notes.md") && !isPdfReadingName("paper.pdf") && !isPdfReadingName(null));
  assert.equal(displayFileName("paper.pdf.md"), "paper.pdf");
  assert.equal(PDF_READING_MAX_FILES, 5);
  assert.equal(PDF_READING_MAX_PAGES, 100);
});

test("新建课程里有「PDF 阅读版」：带实验性标记和说明，只收 PDF，建好直接打开第一篇", async () => {
  const dialog = await read("components/learn/new-course-dialog.tsx");
  assert.match(dialog, /\{ mode: "pdf", Icon: ScanText, label: "modePdf", desc: "modePdfDesc" \}/);
  assert.match(dialog, /m === "pdf" && <ExperimentalBadge label=\{t\("common\.experimental"\)\} \/>/);
  assert.match(dialog, /t\("dashboard\.form\.pdfExperimentalTitle"\)/);
  assert.match(dialog, /accept="\.pdf,application\/pdf"/);
  assert.match(dialog, /course = await createPdfReadingCourse\(name\.trim\(\), pdfFiles, language, onProgress\);/);
  // 只收 PDF、数量有上限：多出来的和别的文件都明确提示，不悄悄丢
  assert.match(dialog, /const accepted = all\.filter\(isPdfFile\);/);
  assert.match(dialog, /setError\(t\("dashboard\.errors\.tooManyPdfs"/);
  const api = await read("lib/learn/api.ts");
  assert.match(api, /api<Course>\("\/api\/courses\/from-pdf-reading", createInit\(\{ body: formData \}\)\)/);
  assert.match(await read("components/learn/dashboard.tsx"), /const CREATE_MODES: CreateMode\[\] = \["topic", "project", "web", "pdf"\];/);
});

test("PDF 阅读版的课文顶部写明是自动转换的实验性结果，可以打开原 PDF；课程徽标也标实验性", async () => {
  const lesson = await read("components/learn/lesson.tsx");
  assert.match(lesson, /lesson\?\.is_source && isPdfReadingName\(lesson\.source_filename\) && <PdfReadingNotice/);
  const notice = await read("components/learn/pdf-reading-notice.tsx");
  assert.match(notice, /getLessonFile\(courseId, lessonNum\)/);
  assert.match(notice, /type: "application\/pdf"/);
  const badges = await read("components/learn/badges.tsx");
  assert.match(badges, /kind === "pdf" && <ExperimentalBadge/);
});

test("PDF 阅读版用到的文案两种语言都有", async () => {
  const load = async (lang) => JSON.parse(await read(`i18n/messages/${lang}.json`));
  for (const lang of ["zh", "en"]) {
    const { learn } = await load(lang);
    for (const value of [
      learn.common.experimental, learn.common.modes.pdf,
      learn.dashboard.form.modePdf, learn.dashboard.form.modePdfDesc, learn.dashboard.form.pdfExperimentalTitle,
      learn.dashboard.form.pdfExperimentalBody, learn.dashboard.form.pdfLabel, learn.dashboard.form.pdfDrop,
      learn.dashboard.form.pdfLimits, learn.dashboard.form.pdfNote,
      learn.dashboard.errors.pdfRequired, learn.dashboard.errors.pdfType, learn.dashboard.errors.tooManyPdfs,
      learn.dashboard.creating.pdf.render, learn.dashboard.creating.hintPdf, learn.generating.expect.pdf,
      learn.pdfReading.notice, learn.pdfReading.original,
    ]) {
      assert.equal(typeof value, "string", lang);
      assert.ok(value.length > 0, lang);
    }
    assert.match(learn.dashboard.form.pdfLimits, /\{files\}.*\{pages\}/);
  }
});
