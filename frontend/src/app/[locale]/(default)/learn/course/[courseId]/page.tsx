import CoursePage from "@/components/learn/course";
import { isRouteId } from "@/lib/learn/route-params";
import { notFound } from "next/navigation";

export default async function LearnCoursePage({
  params,
}: {
  params: Promise<{ locale: string; courseId: string }>;
}) {
  const { courseId } = await params;
  if (!isRouteId(courseId)) {
    notFound();
  }
  return <CoursePage courseId={courseId} />;
}
