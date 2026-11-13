"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { PageHead } from "@/components/page-head";
import { CrumbBar, LearnPage, WorkingBar } from "@/components/learn/shell";
import { useLearnError } from "@/components/learn/use-learn-error";
import { Button } from "@/components/ui/button";
import { Link, useRouter } from "@/i18n/navigation";
import { clipPage } from "@/lib/learn/api";
import {
  CLIP_PROTOCOL,
  MAX_CLIP_BYTES,
  type ClipError,
  fromExtension,
  toExtension,
} from "@/lib/learn/clip-protocol";
import { courseLanguageOf } from "@/lib/learn/language";

// 没装插件、或者这个地址被直接打开：等这么久还没收到就说明白
const WAIT_MS = 5000;

// 浏览器插件剪下一个网页后打开的页面：向插件要那一页，存进「网页剪藏」，然后直接打开存好的那一篇。
// 约定见 lib/learn/clip-protocol.ts。
export default function ClipReceiver({ clipId, failure }: { clipId: string | null; failure: ClipError | null }) {
  const t = useTranslations("learn");
  const errorsT = useTranslations("errors");
  const locale = useLocale();
  const router = useRouter();
  const report = useLearnError();
  const [savingSince, setSavingSince] = useState<number | null>(null);
  const [error, setError] = useState(() =>
    failure ? t(`clip.failure.${failure}`) : clipId ? "" : t("clip.failure.missing")
  );
  // 开发模式下 effect 会跑两遍：只存一次
  const started = useRef(false);

  useEffect(() => {
    if (!clipId || failure) return;
    let settled = false;
    const finish = (message: string) => {
      settled = true;
      toExtension({ type: "clip-done", id: clipId });
      if (message) setError(message);
    };
    const save = async (url: string, html: string) => {
      if (started.current) return;
      started.current = true;
      if (new Blob([html]).size > MAX_CLIP_BYTES) return finish(errorsT("webTooBig"));
      setSavingSince(Date.now());
      try {
        const saved = await clipPage(url, html, courseLanguageOf(locale));
        finish("");
        router.replace(`/learn/course/${saved.course_id}/lesson/${saved.lesson_number}`);
      } catch (err) {
        setSavingSince(null);
        // 网络断了等情况没有确定的结果：不让插件删暂存，刷新页面还能再存
        settled = true;
        setError(report(err));
      }
    };
    const onMessage = (event: MessageEvent) => {
      const message = fromExtension(event);
      if (!message || settled) return;
      if (message.type === "ready") return toExtension({ type: "clip-request", id: clipId });
      if (message.id !== clipId) return;
      if (message.version < CLIP_PROTOCOL) return finish(t("clip.failure.outdated"));
      if (!message.clip) return finish(t("clip.failure.missing"));
      settled = true;
      void save(message.clip.url, message.clip.html);
    };
    window.addEventListener("message", onMessage);
    toExtension({ type: "clip-request", id: clipId });
    const timer = window.setTimeout(() => {
      if (!settled) finish(t("clip.failure.missing"));
    }, WAIT_MS);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
    };
  }, [clipId, failure, errorsT, locale, report, router, t]);

  return (
    <>
      <CrumbBar items={[{ label: t("dashboard.title"), href: "/learn" }, { label: t("clip.title") }]} />
      <LearnPage className="max-w-3xl">
        <PageHead title={t("clip.title")} description={t("clip.description")} />
        {error ? (
          <div className="space-y-4">
            {/* 这里没有别的内容可看，提示不能关掉 */}
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-pretty text-destructive">
              {error}
            </p>
            <Button asChild variant="outline">
              <Link href="/learn">{t("clip.back")}</Link>
            </Button>
          </div>
        ) : savingSince ? (
          <WorkingBar title={t("clip.saving")} expect={t("clip.savingExpect")} startedAt={savingSince} />
        ) : (
          <WorkingBar title={t("clip.waiting")} />
        )}
      </LearnPage>
    </>
  );
}
