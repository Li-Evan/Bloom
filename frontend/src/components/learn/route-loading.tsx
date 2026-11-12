import { useTranslations } from "next-intl";
import LearnColumns from "@/components/learn/columns";
import { LearnPage } from "@/components/learn/shell";
import { Skeleton } from "@/components/ui/skeleton";

// 学习区的页面都要先在服务端取数：点了课程卡片、「继续」、课文链接之后，服务端返回之前旧页面原样停着，
// 像是没点上。路由层的 loading.tsx 用它马上换成骨架。course：课程 / 大纲 / 课文页（面包屑条 + 两栏）；不传是列表类页面。
export default function RouteLoading({ course = false }: { course?: boolean }) {
  const t = useTranslations("learn.common");

  return (
    <>
      <span role="status" className="sr-only">{t("loading")}</span>
      {course && (
        <div aria-hidden="true" className="h-14 border-b">
          <div className="mx-auto flex h-full max-w-6xl items-center gap-3 px-4 sm:px-6 lg:px-8">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
      )}
      <LearnPage aria-busy="true">
        {course ? (
          <LearnColumns
            rail={<Skeleton className="hidden h-64 rounded-xl lg:block" />}
            head={
              <div className="mb-8">
                <Skeleton className="mb-3 h-4 w-24" />
                <Skeleton className="h-10 w-3/5" />
              </div>
            }
          >
            <div className="space-y-3">
              {["w-full", "w-11/12", "w-full", "w-4/5", "w-full", "w-2/3"].map((w, i) => <Skeleton key={i} className={`h-4 ${w}`} />)}
            </div>
          </LearnColumns>
        ) : (
          <>
            <div className="mb-8 space-y-3">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-9 w-48" />
            </div>
            <Skeleton className="mb-6 h-24 rounded-xl" />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-40 rounded-xl" />)}
            </div>
          </>
        )}
      </LearnPage>
    </>
  );
}
