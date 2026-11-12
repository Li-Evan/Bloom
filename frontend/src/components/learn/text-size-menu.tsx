"use client";

import { ALargeSmall } from "lucide-react";
import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TEXT_SIZES, parseTextSize, readTextSize, saveTextSize, subscribeTextSize } from "@/lib/text-size";

// 页面顶上的「字号」按钮：和设置里的「正文字号」是同一个（lib/text-size.ts）。
// 选一档菜单不收起，正文在后面立刻跟着变，可以连着试；不锁页面滚动（modal={false}），滚动条不会忽隐忽现让版面跳
export default function TextSizeMenu() {
  const t = useTranslations("common.text_size");
  const size = useSyncExternalStore(subscribeTextSize, readTextSize, () => null);

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          <ALargeSmall className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">{t("button")}</span>
          <span className="sr-only sm:hidden">{t("button")}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t("label")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={size ?? ""} onValueChange={(value) => saveTextSize(parseTextSize(value))}>
          {TEXT_SIZES.map((option) => (
            <DropdownMenuRadioItem key={option} value={option} onSelect={(event) => event.preventDefault()}>
              {t(option)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
