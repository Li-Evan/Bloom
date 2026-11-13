export type WebPreview = {
  title: string;
  url: string;
  content: string;
  characters: number;
  via_reader: boolean;
};

export function webArticleMarkdown(article: WebPreview, sourceLabel: string): string {
  const title = article.title.replace(/[\r\n]+/g, " ").replace(/([\\`*_{}\[\]<>#!|])/g, "\\$1");
  const url = new URL(article.url);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid article URL");
  const source = url.href.replace(/</g, "%3C").replace(/>/g, "%3E");
  return `# ${title}\n\n[${sourceLabel}](<${source}>)\n\n---\n\n${article.content}\n`;
}

export function webArticleFilename(title: string): string {
  return `${title.replace(/[\\/\x00-\x1f<>:"|?*]/g, " ").trim().slice(0, 160) || "article"}.md`;
}
