import { redirect } from "@/i18n/navigation";

// 自托管的 Bloom 没有营销首页：打开就是「我的课程」
export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect({ href: "/learn", locale });
}
