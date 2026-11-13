import { useTranslations } from "next-intl";

import { Skeleton } from "@/components/ui/skeleton";

// 用户中心各页等后端数据时先出骨架（左侧导航在 layout 里照常显示）：后端冷启动时不再整页空白。
// 读屏只听到一句「正在加载…」：提示不能包在 aria-busy 里（读屏会等 busy 结束才念，那时已经换成页面了）
export default function MeLoading() {
  const t = useTranslations("common");

  return (
    <div>
      <p role="status" className="sr-only">{t("loading")}</p>
      <div aria-hidden="true">
        <div className="mb-8 space-y-3">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-9 w-56 max-w-full" />
        </div>
        <div className="space-y-6">
          <Skeleton className="h-40 rounded-xl" />
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
            <Skeleton className="h-48 rounded-lg" />
            <Skeleton className="h-48 rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  );
}
