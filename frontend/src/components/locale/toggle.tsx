"use client";

import { useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Spinner } from "@/components/ui/spinner";
import { usePathname, useRouter } from "@/i18n/navigation";
import { locales } from "@/i18n/locale";
import { cn } from "@/lib/utils";

// 只有两种语言，直接给一个文字按钮切到另一种：中文页上写 EN，英文页上写 中文。
// 换语言要重新渲染整页，等的这段时间按钮转圈、不能再点
export default function LocaleToggle({
  tone = "auto",
  className,
}: {
  tone?: "auto" | "dark";
  className?: string;
}) {
  const t = useTranslations("header");
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const target = locales.find((l) => l !== locale) ?? locale;

  const switchLocale = () => {
    const { search, hash } = window.location;
    startTransition(() => router.replace(`${pathname}${search}${hash}`, { locale: target }));
  };

  return (
    <button
      type="button"
      lang={t("language_target_lang")}
      aria-label={t("language")}
      aria-busy={pending || undefined}
      title={t("language")}
      disabled={pending}
      onClick={switchLocale}
      className={cn(
        "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 font-mono text-xs transition-colors disabled:cursor-wait",
        tone === "dark"
          ? "border border-white/15 text-stone-300 hover:border-white/30 hover:text-white"
          : "border border-border text-muted-foreground hover:bg-muted hover:text-foreground",
        className
      )}
    >
      {pending && <Spinner className="size-3.5" />}
      {t("language_target")}
    </button>
  );
}
