import { SignJWT } from "jose";

const ISSUER = "bloom-frontend";
const TTL_SECONDS = 15 * 60;

type Claims = { scope: "user"; sub: string; email: string };

// 只在服务端用：前端服务端给本地用户签后端访问令牌（lib/local-user.ts）
export async function signToken(claims: Claims) {
  const secret = process.env.BACKEND_JWT_SECRET;
  if (!secret) {
    throw new Error("BACKEND_JWT_SECRET is not set");
  }

  const iat = Math.floor(Date.now() / 1000);
  const expiresAt = iat + TTL_SECONDS;

  const token = await new SignJWT({ scope: claims.scope, email: claims.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setSubject(claims.sub)
    .setIssuedAt(iat)
    .setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(secret));

  return { token, expiresAt };
}
