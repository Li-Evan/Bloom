import { splitMatches } from "@/lib/me/notes";

// 把文字里命中搜索词的部分标出来
export default function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {splitMatches(text, query).map((part, i) =>
        part.hit ? (
          <mark key={i} className="rounded-[3px] bg-primary/60 px-0.5 text-foreground">
            {part.text}
          </mark>
        ) : (
          part.text
        )
      )}
    </>
  );
}
