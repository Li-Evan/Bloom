import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import LessonPage from "@/components/learn/lesson";
import { lessonStart } from "@/lib/learn/lesson-start";
import { lessonTabTitle } from "@/lib/learn/lessons";
import { annotationParam, isRouteId } from "@/lib/learn/route-params";
import { notFound } from "next/navigation";

type Params = { locale: string; courseId: string; lessonNum: string };

// 标签页标题：和课文页里 DocumentTitle 同一条规则。页面里直接带着正文渲染，Next 在水合之后才写入的元数据标题
// 不能再是学习区的默认标题，否则会把 DocumentTitle 刚设好的课文标题盖掉。取不到课文时沿用学习区的默认标题
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { locale, courseId, lessonNum } = await params;
  const start = isRouteId(courseId) && isRouteId(lessonNum) ? await lessonStart(courseId, lessonNum) : null;
  if (!start) return {};
  const t = await getTranslations({ locale, namespace: "learn" });

  return { title: `${lessonTabTitle(t, Number(lessonNum), start)} | Bloom` };
}

export default async function LearnLessonPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<{ annotation?: string | string[] }>;
}) {
  const { courseId, lessonNum } = await params;
  if (!isRouteId(courseId) || !isRouteId(lessonNum)) {
    notFound();
  }
  const annotationId = annotationParam((await searchParams).annotation);
  // 正文、课程和目录在服务端先取好，随页面直接显示；划线问答、标记、译文、反馈由浏览器随后再取
  const initial = await lessonStart(courseId, lessonNum);

  // 阅读页不显示站点页脚（LessonPage 里渲染 HideFooter）；课文打不开时的整页提示里页脚照常显示
  return <LessonPage courseId={courseId} lessonNum={lessonNum} annotationId={annotationId} initial={initial} />;
}
