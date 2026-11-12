// GET /api/me：开源版只有一个本地用户，资料只有昵称、头像和几项设置
export interface Me {
  uuid: string;
  email: string;
  nickname: string | null;
  avatar_url: string | null;
  locale?: string | null;
  created_at: string | null;
  // 设置里的「读完立刻归档」
  archive_on_read?: boolean;
}
