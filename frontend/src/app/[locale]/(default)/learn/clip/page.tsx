import ClipReceiver from "@/components/learn/clip-receiver";
import { clipError, isClipId } from "@/lib/learn/clip-protocol";
import { privatePageMetadata } from "@/lib/page-metadata";

export async function generateMetadata() {
  return privatePageMetadata("learn.clip.title");
}

// 浏览器插件剪下网页后打开这里（?clip=<暂存 id>，取不了时 ?error=<原因>）
export default async function LearnClipPage({
  searchParams,
}: {
  searchParams: Promise<{ clip?: string | string[]; error?: string | string[] }>;
}) {
  const { clip, error } = await searchParams;
  const clipId = isClipId(clip) ? clip : null;
  const failure = clipError(error);
  return <ClipReceiver clipId={clipId} failure={failure} />;
}
