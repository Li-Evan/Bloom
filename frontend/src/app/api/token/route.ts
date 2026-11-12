import { LOCAL_USER } from "@/lib/local-user";
import { signToken } from "@/lib/token";

// 浏览器向后端发请求前先来这里取一个短期令牌（lib/api-client.ts）。开源版没有登录：令牌总是签给本地用户
export async function GET() {
  const { token, expiresAt } = await signToken({ scope: "user", sub: LOCAL_USER.uuid, email: LOCAL_USER.email });

  return Response.json(
    { token, expires_at: expiresAt, expires_in: expiresAt - Math.floor(Date.now() / 1000) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
