// 开源版只有一个本地用户，没有登录页。前端服务端用 BACKEND_JWT_SECRET 给这个身份签后端令牌（lib/token.ts），
// 后端第一次见到它时自动建出这个用户。只在服务端用。
export const LOCAL_USER = {
  uuid: "00000000-0000-4000-8000-000000000001",
  email: "me@bloom.local",
} as const;
