"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useOptimistic, useSyncExternalStore, useState, useTransition } from "react";
import { toast } from "sonner";

import InitialAvatar from "@/components/brand/initial-avatar";
import ExportNotes from "@/components/me/export-notes";
import { Panel } from "@/components/me/page-head";
import ProfileRetry from "@/components/me/profile-retry";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useAppContext } from "@/contexts/app";
import { useBackendError } from "@/hooks/use-backend-error";
import { usePathname, useRouter } from "@/i18n/navigation";
import { locales } from "@/i18n/locale";
import { LANGUAGE_NAMES, languagesFor } from "@/lib/learn/language";
import { ApiError } from "@/lib/api-client";
import { readFont, saveFont, subscribeFont } from "@/lib/font";
import { saveShowMeaning, useShowMeaning } from "@/lib/learn/translation-meaning";
import { TEXT_SIZES, readTextSize, saveTextSize, subscribeTextSize } from "@/lib/text-size";
import { saveArchiveOnRead, saveNickname } from "@/lib/me/api";
import { MAX_NICKNAME, cleanNickname, nicknameProblem, nicknameProblemFromDetail } from "@/lib/me/nickname";
import type { Me } from "@/types/user";
import { cn } from "@/lib/utils";

const subscribe = () => () => {};

function Row({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-8 gap-y-2 py-5 first:pt-0 last:pb-0 sm:grid-cols-[11rem_minmax(0,1fr)]">
      <div>
        <Label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </Label>
        {hint && <p className="mt-1 text-xs leading-relaxed text-subtle-foreground">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// 一排互斥的选项（语言、主题、字体、正文字号）：当前项用 aria-pressed 标出；字体选项用各自的字体显示（font）
function Choice<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T | null;
  options: { value: T; label: string; icon?: React.ReactNode; font?: string }[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-md border bg-muted p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          style={option.font ? { fontFamily: `${option.font}, var(--font-sans)` } : undefined}
          className={cn(
            "inline-flex h-9 items-center gap-2 rounded-[calc(var(--radius-md)-3px)] px-3.5 text-sm transition-colors disabled:cursor-wait",
            value === option.value ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ProfilePanel() {
  const t = useTranslations("me.settings");
  const backendError = useBackendError();
  const router = useRouter();
  const { user, setUser, userLoadFailed } = useAppContext();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const current: string = user?.nickname ?? "";
  const value = draft ?? current;
  // 提交的是去掉看不见的字符（零宽字符、方向控制符等）和首尾空白之后的样子，和后端一样（lib/me/nickname.ts）
  const cleaned = cleanNickname(value);
  const dirty = !!user && cleaned !== current;

  const nicknameMessage = (problem: "length" | "needsLetter") =>
    problem === "needsLetter" ? t("nickname_needs_letter") : t("nickname_invalid", { max: MAX_NICKNAME });

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const problem = nicknameProblem(value);
    if (problem) {
      setError(nicknameMessage(problem));
      return;
    }

    setSaving(true);
    setError("");
    try {
      const updated = await saveNickname(cleaned);
      // 顶栏的名字和头像首字读的是这份用户资料，更新它就立刻跟着变；router.refresh 让服务端渲染的问候语也换掉
      setUser((prev: typeof user) => (prev ? { ...prev, ...updated } : prev));
      setDraft(null);
      toast.success(t("saved"));
      router.refresh();
    } catch (e) {
      // 422 是昵称没通过后端的校验：显示本地化的人话，不露出后端 pydantic 的英文原文
      setError(e instanceof ApiError && e.status === 422 ? nicknameMessage(nicknameProblemFromDetail(e.detail)) : backendError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel title={t("profile_title")}>
      <div className="divide-y">
      <Row label={t("avatar")} hint={t("avatar_hint")}>
        {user ? <InitialAvatar name={user.nickname} src={user.avatar_url} size={56} /> : <Skeleton className="size-14 rounded-full" />}
      </Row>
      <Row label={t("nickname")} htmlFor="nickname" hint={t("nickname_hint", { max: MAX_NICKNAME })}>
        {!user && userLoadFailed && <ProfileRetry className="mb-3" />}
        <form onSubmit={save} className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="nickname"
            value={value}
            // 保存途中锁住：成功后 setDraft(null) 会冲掉这期间新打的字
            disabled={!user || saving}
            maxLength={MAX_NICKNAME * 2}
            autoComplete="nickname"
            aria-invalid={!!error}
            aria-describedby={error ? "nickname-error" : undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              setError("");
            }}
            className="sm:max-w-sm"
          />
          <Button type="submit" disabled={!dirty} loading={saving} className="sm:shrink-0">
            {saving ? t("saving") : t("save")}
          </Button>
        </form>
        {error && (
          <p id="nickname-error" role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </Row>
      </div>
    </Panel>
  );
}

export function PreferencesPanel() {
  const t = useTranslations("me.settings");
  const tSize = useTranslations("common.text_size");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  const font = useSyncExternalStore(subscribeFont, readFont, () => null);
  const showMeaning = useShowMeaning();
  const textSize = useSyncExternalStore(subscribeTextSize, readTextSize, () => null);
  // 换语言要重新渲染整页，等的这段时间选中态先切到新语言，旁边转圈，选项锁住
  const [switching, startTransition] = useTransition();
  const [shownLocale, setShownLocale] = useOptimistic(locale);

  const switchLocale = (target: string) => {
    if (target === locale || switching) return;
    const { search, hash } = window.location;
    startTransition(() => {
      setShownLocale(target);
      router.replace(`${pathname}${search}${hash}`, { locale: target });
    });
  };

  return (
    <Panel title={t("prefs_title")}>
      <div className="divide-y">
      <Row label={t("language")} hint={t("language_hint")}>
        <div className="flex items-center gap-3">
          <Choice
            label={t("language")}
            value={shownLocale}
            onChange={switchLocale}
            disabled={switching}
            // 顺序跟着当前界面语言（和新建课程里的「课程语言」一致）
            options={languagesFor(locale)
              .filter((l) => (locales as readonly string[]).includes(l))
              .map((l) => ({ value: l, label: LANGUAGE_NAMES[l] }))}
          />
          {switching && <Spinner className="text-muted-foreground" />}
          <span role="status" className="sr-only">
            {switching ? t("language_switching") : ""}
          </span>
        </div>
      </Row>
      <Row label={t("theme")}>
        <Choice
          label={t("theme")}
          value={mounted ? (theme ?? "system") : null}
          onChange={setTheme}
          options={[
            { value: "light", label: t("theme_light"), icon: <Sun className="size-4" aria-hidden="true" /> },
            { value: "dark", label: t("theme_dark"), icon: <Moon className="size-4" aria-hidden="true" /> },
            { value: "system", label: t("theme_system"), icon: <Monitor className="size-4" aria-hidden="true" /> },
          ]}
        />
      </Row>
      <Row label={t("font")} hint={t("font_hint")}>
        <Choice
          label={t("font")}
          value={font}
          onChange={saveFont}
          options={[
            { value: "outfit", label: "Outfit", font: "var(--font-outfit)" },
            { value: "public-sans", label: "Public Sans", font: "var(--font-public-sans)" },
            { value: "system", label: t("font_system"), font: "var(--font-system)" },
          ]}
        />
      </Row>
      <Row label={t("text_size")} hint={t("text_size_hint")}>
        <Choice
          label={t("text_size")}
          value={textSize}
          onChange={saveTextSize}
          options={TEXT_SIZES.map((size) => ({ value: size, label: tSize(size) }))}
        />
      </Row>
      <Row label={t("translation_meaning")} hint={t("translation_meaning_hint")}>
        <Choice
          label={t("translation_meaning")}
          value={mounted ? (showMeaning ? "on" : "off") : null}
          onChange={(value) => saveShowMeaning(value === "on")}
          options={[
            { value: "on", label: t("translation_meaning_on") },
            { value: "off", label: t("translation_meaning_off") },
          ]}
        />
      </Row>
      </div>
    </Panel>
  );
}

// 学习：「读完立刻归档」存在后端（点「标记已读」时后端顺手归档），换设备也一样；先切过去，没存上退回并提示
export function LearningPanel() {
  const t = useTranslations("me.settings");
  const backendError = useBackendError();
  const { user, setUser } = useAppContext();
  const [saving, setSaving] = useState(false);

  const save = async (value: "on" | "off") => {
    const enabled = value === "on";
    if (!user || saving || enabled === Boolean(user.archive_on_read)) return;
    const apply = (on: boolean) => setUser((prev: Me | null) => (prev ? { ...prev, archive_on_read: on } : prev));
    setSaving(true);
    apply(enabled);
    try {
      await saveArchiveOnRead(enabled);
    } catch (e) {
      apply(!enabled);
      toast.error(backendError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel title={t("learning_title")}>
      <div className="divide-y">
      <Row label={t("archive_on_read")} hint={t("archive_on_read_hint")}>
        <Choice
          label={t("archive_on_read")}
          value={user ? (user.archive_on_read ? "on" : "off") : null}
          onChange={save}
          disabled={!user || saving}
          options={[
            { value: "on", label: t("archive_on_read_on") },
            { value: "off", label: t("archive_on_read_off") },
          ]}
        />
      </Row>
      </div>
    </Panel>
  );
}

// 数据：把所有笔记导出成一个 Markdown 文件
export function DataPanel() {
  const t = useTranslations("me.settings");

  return (
    <Panel title={t("data_title")}>
      <Row label={t("export_title")} hint={t("export_hint")}>
        <ExportNotes />
      </Row>
    </Panel>
  );
}
