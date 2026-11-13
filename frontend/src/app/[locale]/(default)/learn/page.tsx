import Dashboard from "@/components/learn/dashboard";
import { privatePageMetadata } from "@/lib/page-metadata";

export async function generateMetadata() {
  return privatePageMetadata("learn.dashboard.title");
}

export default async function LearnPage() {
  return <Dashboard />;
}
