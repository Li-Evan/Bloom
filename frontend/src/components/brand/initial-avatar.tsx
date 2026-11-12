import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initialOf } from "@/lib/initial";
import { cn } from "@/lib/utils";

// 有头像图用图；没有就用昵称首字，圆形、亮绿底近黑字（和主按钮同色，亮暗主题一致）
export default function InitialAvatar({
  name,
  src,
  size = 32,
  className,
}: {
  name?: string | null;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  return (
    <Avatar
      className={cn("shrink-0", className)}
      style={{ width: size, height: size }}
    >
      {src ? <AvatarImage src={src} alt="" /> : null}
      <AvatarFallback
        className="bg-primary text-primary-foreground"
        style={{ fontSize: Math.round(size * 0.44) }}
      >
        {initialOf(name)}
      </AvatarFallback>
    </Avatar>
  );
}
