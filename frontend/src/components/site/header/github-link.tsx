import { useTranslations } from "next-intl";
import { SiGithub } from "react-icons/si";
import { GITHUB_URL } from "@/lib/nav";
import { cn } from "@/lib/utils";

// 开源仓库的入口
export default function GitHubLink({ className }: { className?: string }) {
  const t = useTranslations("header");
  const label = t("github");

  return (
    <a
      href={GITHUB_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        className
      )}
    >
      <SiGithub aria-hidden="true" className="size-[18px]" />
    </a>
  );
}
