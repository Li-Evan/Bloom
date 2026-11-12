"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ErrorBar } from "@/components/learn/shell";
import { useLearnError } from "@/components/learn/use-learn-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { editLesson } from "@/lib/learn/api";
import { displayFileName, splitFileName } from "@/lib/learn/files";

// 后端：文件名最多 200 字（不含扩展名），正文最多 100 万字
const NAME_MAX_CHARS = 200;
const CONTENT_MAX_CHARS = 1_000_000;

// 课文页上直接改资料类课程里的一个文件：文件名和 Markdown 正文。剪藏、导入抽错了的地方在这里改掉。
// 保存后课文页换成新的正文，划线按原文重新找位置（找不到的只留在右栏和笔记里，后端不再按旧位置画）。
export default function LessonEditor({
  courseId,
  number,
  filename,
  content,
  onCancel,
  onSaved,
}: {
  courseId: string;
  number: number;
  filename: string;
  content: string;
  onCancel: () => void;
  onSaved: (saved: { source_filename: string | null; content: string }) => void;
}) {
  const t = useTranslations("learn");
  const report = useLearnError();
  const parts = splitFileName(filename);
  const suffix = displayFileName(parts.suffix);
  const [name, setName] = useState(parts.stem);
  const [text, setText] = useState(content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const tidy = name.split(/\s+/).filter(Boolean).join(" ");
  const nameTooLong = Array.from(tidy).length > NAME_MAX_CHARS;
  const changed = tidy !== parts.stem || text !== content;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || nameTooLong) return;
    if (!tidy) return setError(t("course.renameFile.empty"));
    if (!text.trim()) return setError(t("lesson.edit.empty"));
    if (!changed) return onCancel();
    setSaving(true);
    setError("");
    try {
      const saved = await editLesson(courseId, number, {
        ...(tidy !== parts.stem && { name: tidy }),
        ...(text !== content && { content: text }),
      });
      onSaved({ source_filename: saved.source_filename, content: text });
    } catch (err) {
      setError(report(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-4" aria-label={t("lesson.edit.title")}>
      <div className="space-y-1.5">
        <label htmlFor="edit-file-name" className="text-sm font-medium">
          {t("course.renameFile.label")}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="edit-file-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError("");
            }}
            disabled={saving}
            aria-invalid={nameTooLong || undefined}
            autoComplete="off"
          />
          {suffix && <span className="shrink-0 font-mono text-sm text-muted-foreground">{suffix}</span>}
        </div>
        {nameTooLong && (
          <p role="alert" className="text-xs text-destructive">
            {t("course.rename.tooLong", { max: NAME_MAX_CHARS, count: Array.from(tidy).length })}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <label htmlFor="edit-file-content" className="text-sm font-medium">
          {t("lesson.edit.content")}
        </label>
        <Textarea
          id="edit-file-content"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError("");
          }}
          disabled={saving}
          maxLength={CONTENT_MAX_CHARS}
          spellCheck={false}
          className="min-h-[60dvh] font-mono text-sm leading-relaxed"
        />
        <p className="text-xs text-pretty text-muted-foreground">{t("lesson.edit.hint")}</p>
      </div>
      {error && <ErrorBar message={error} onClose={() => setError("")} />}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={saving} disabled={nameTooLong}>
          {saving ? t("course.rename.saving") : t("course.rename.save")}
        </Button>
      </div>
    </form>
  );
}
