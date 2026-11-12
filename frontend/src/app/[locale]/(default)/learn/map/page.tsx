import KnowledgeMapPage from "@/components/learn/knowledge-map";
import { privatePageMetadata } from "@/lib/page-metadata";

export async function generateMetadata() {
  return privatePageMetadata("learn.map.title");
}

export default async function Page() {
  return <KnowledgeMapPage />;
}
