"use client";

import { MessageSquareText, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

// 第一次读课文时，正文开头上方给一条可关闭的短提示：划线提问是这个产品最有用的动作，不能只埋在课文最底下的小字里。
// 关掉之后记在 localStorage，以后任何一篇都不再出现。读不到 / 写不了 localStorage（隐私模式）时每次都显示，不报错。
// 水合之前不渲染（服务端不知道读者关过没有），所以不会闪一下再消失。
export const ASK_HINT_KEY = "bloom:hint:ask-dismissed";

export default function AskHint() {
  const t = useTranslations("learn.lesson.hint");
  const [state, setState] = useState<"hidden" | "mouse" | "touch">("hidden");

  useEffect(() => {
    try {
      if (localStorage.getItem(ASK_HINT_KEY)) return;
    } catch {
      /* 读不到就当没关过 */
    }
    // 触屏上是长按选字，说法不一样
    setState(window.matchMedia("(pointer: coarse)").matches ? "touch" : "mouse");
  }, []);

  if (state === "hidden") return null;

  const dismiss = () => {
    setState("hidden");
    try {
      localStorage.setItem(ASK_HINT_KEY, "1");
    } catch {
      /* 写不了就算了，下次还会出现 */
    }
  };

  return (
    <aside
      aria-label={t("label")}
      className="mb-8 flex items-start gap-3 rounded-lg border bg-accent/60 py-2.5 pl-3.5 pr-2"
    >
      <MessageSquareText className="mt-0.5 size-4 shrink-0 text-accent-foreground" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-pretty text-sm leading-relaxed text-foreground">
        {state === "touch" ? t("touch") : t("mouse")}
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t("dismiss")}
        // 40px 见方，够得着；负外边距把多出来的部分抵掉，提示条高度不变
        className="-my-2 -mr-1 flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </aside>
  );
}
