import { LOCAL_USER } from "@/lib/local-user";
import { signToken } from "@/lib/token";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ imageId: string }> }) {
  const { imageId } = await context.params;
  if (!/^[a-f0-9]{32}$/.test(imageId)) return new Response(null, { status: 404 });
  const base = process.env.BACKEND_URL?.replace(/\/+$/, "");
  if (!base) return new Response(null, { status: 503 });
  const { token } = await signToken({ scope: "user", sub: LOCAL_USER.uuid, email: LOCAL_USER.email });
  try {
    const response = await fetch(`${base}/api/project-images/${imageId}`, {
      headers: { Authorization: `Bearer ${token}` }, cache: "no-store", redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]),
    });
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || !/^image\/(jpeg|png|gif|webp)$/.test(type)) {
      await response.body?.cancel();
      return new Response(null, { status: response.ok ? 502 : response.status });
    }
    return new Response(response.body, { headers: {
      "Content-Type": type, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return new Response(null, { status: 502 });
  }
}
