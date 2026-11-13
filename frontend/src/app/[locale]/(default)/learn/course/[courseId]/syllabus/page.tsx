import SyllabusPage from "@/components/learn/syllabus";
import { isRouteId } from "@/lib/learn/route-params";
import { notFound } from "next/navigation";

export default async function LearnSyllabusPage({
  params,
}: {
  params: Promise<{ locale: string; courseId: string }>;
}) {
  const { courseId } = await params;
  if (!isRouteId(courseId)) {
    notFound();
  }
  return <SyllabusPage courseId={courseId} />;
}
