import NextPage from "@/components/learn/next";
import { privatePageMetadata } from "@/lib/page-metadata";

export async function generateMetadata() {
  return privatePageMetadata("learn.recs.title");
}

export default async function LearnNextPage() {
  return <NextPage />;
}
