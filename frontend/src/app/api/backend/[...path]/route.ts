import { forwardBackendRequest } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return forwardBackendRequest(request, path);
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as HEAD };
