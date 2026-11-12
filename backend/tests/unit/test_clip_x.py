"""剪藏 X（推特）：标题用帖子本身，不带「X 上的 Ada：…/ X」；正文不再被当成侧边栏丢掉（链接文字会丢）；不剪 Bloom 自己的页面。"""
import pytest

from app import web_import
from app.config import settings
from tests.conftest import bearer, create_user


@pytest.fixture(autouse=True)
def server_cannot_read(monkeypatch):
    """剪藏会先让服务器自己读这个网址；这里不连外网，当作读不到，存浏览器交来的那份。"""
    def refuse(url, deadline, **_):
        raise web_import.FetchFailed("HTTP 403")
    monkeypatch.setattr(web_import, "fetch_html", refuse)

TITLE = "Notes on Building a Better Agent Loop"
# 照着 2026-11 一篇 X 文章页的真实结构写的（文字是自己写的）：整页套在 class 带 --x-sidebar-wide、--x-nav-open 的布局里，
# 文章前面是作者栏，后面是作者卡片、时间和互动按钮，再后面是别人的回复
ARTICLE = f"""<!DOCTYPE html><html lang="zh"><head><title>X 上的 Ada：“{TITLE}” / X</title></head><body>
<div class="mx-auto flex min-h-dvh w-full overflow-x-clip [--x-sidebar-wide:1]">
<div class="w-full shrink-0 sm:w-[calc(100%-72px-184px*var(--x-sidebar-wide,0)*var(--x-nav-open))] grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_350px]">
<main class="border-normal mx-auto flex h-auto w-full max-w-[602px] min-w-0 flex-col sm:border-x">
<div class="bg-primary/80 sticky top-0 backdrop-blur-md z-20"><div class="hidden gap-2 px-2 h-[53px] sm:grid items-center">
<h2 class="text-headline2 text-primary max-w-full truncate font-bold"><span>文章</span></h2>
<a class="text-primary flex h-8 items-center" href="/i/jf/onboarding/web?mode=login">登录</a>
<a class="flex h-8 items-center bg-black px-4" href="/i/jf/onboarding/web?mode=signup">注册</a></div></div>
<div class="mx-auto w-full max-w-[600px]" id="urt:conversation:1:none:default"><ul><li>
<div class="outline-focus px-horizontal py-vertical [--media-overhang-end:var(--spacing-horizontal)] border-b border-divider">
<article class="flex flex-col gap-1"><div class="@container/post-actions flex flex-col gap-2"><div class="flex flex-col gap-3">
<div class="flex gap-2"><div class="relative flex w-10 shrink-0 flex-col items-center self-stretch"><a class="x-link max-w-full rounded-none" href="/example_author">
<img src="https://pbs.twimg.com/profile_images/1/avatar_x96.jpg" alt=""></a></div>
<div class="flex min-w-0 flex-1 flex-col"><span class="max-w-full min-w-0 flex shrink-0 items-center gap-1"><a class="rounded-xs x-link hover:underline" href="/example_author">
<div class="max-w-full text-body font-bold text-primary line-clamp-1">Ada</div></a></span>
<span class="flex max-w-full min-w-0 items-center gap-2"><a class="rounded-xs x-link" href="/example_author"><span class="max-w-full text-body text-secondary [font-feature-settings:'ss01']">@example_author</span></a></span></div></div>
<div class="contents"><div><div class="flex flex-col">
<a class="mb-6 block cursor-zoom-in" data-article-part="cover" href="/example_author/article/1/media/2"></a>
<h1 class="font-article text-primary mx-auto w-fit max-w-full text-center leading-[1.25] max-sm:text-[22px] sm:text-[26px]" data-article-part="title">{TITLE}</h1>
<div class="mt-3 flex min-w-0 flex-col items-center gap-1" data-article-part="byline"><span class="text-subtext1 x-middot-group"><span>7 分钟阅读</span></span></div>
<div class="mt-7" data-article-part="body"><div class="x-article-body break-words text-[16px] leading-[1.6] [&amp;&gt;p]:mb-4"><div class="contents [&amp;&gt;p]:mb-4">
<p class="font-article text-pretty whitespace-pre-wrap"><b><strong class="font-bold">TLDR:</strong></b><span> We moved from the middle of the table to near the top on </span><a href="https://www.tbench.ai/leaderboard/terminal-bench/2.0" class="text-brand underline decoration-1 underline-offset-[3px]"><span>Terminal Bench 2.0</span></a><span>.  </span><b><strong class="font-bold">Only the harness changed.</strong></b><span> This note walks through how we went about it.</span></p>
<h2 class="font-article text-balance mt-9 mb-2.5 text-[19px] leading-[1.3]"><span>What a harness is for</span></h2>
<p class="font-article text-pretty whitespace-pre-wrap"><span>A harness turns an uneven model into something dependable for the tasks you care about: the prompt, the tools and the loop that runs them are all part of it, and each of them can be tuned.</span></p>
<p class="font-article text-pretty whitespace-pre-wrap"><span>We start from </span><a href="https://docs.langchain.com/langsmith/observability-quickstart" class="text-brand underline decoration-1 underline-offset-[3px]"><span>Traces</span></a><span> to see where runs go wrong, then change one part of the harness at a time and measure again before keeping the change.</span></p>
<p class="font-article text-pretty whitespace-pre-wrap"><span>Most of the gains came from asking the agent to check its own work, and from noticing when it was going round in circles on the same broken idea.</span></p>
</div></div></div></div></div></div>
<section class="bg-secondary mt-8 mb-4 flex flex-col items-center rounded-md px-6 py-9 text-center"><a class="x-link" href="/example_author"><div class="x-avatar rounded-full size-14"></div></a>
<a class="rounded-xs x-link hover:underline" href="/example_author"><div class="text-headline1 font-bold">Ada</div></a>
<div class="text-body text-secondary line-clamp-2 mt-2 max-w-[400px]"><span class="max-w-full text-[length:inherit]">research engineer</span></div>
<a class="x-link x-button h-10 px-5" href="/example_author/articles"><span class="min-w-0 overflow-x-clip">更多文章</span></a><div class="text-subtext2 mt-3">加入 1.6万 关注者</div></section>
<div class="text-secondary flex shrink items-center"><a class="rounded-xs x-link hover:underline" href="/example_author/status/1">1:03 · 2026年2月18日</a><span class="shrink-0 px-1">·</span>
<a class="rounded-xs x-link inline-flex items-center gap-1" href="/example_author/status/1"><div class="font-bold">56.4万</div><div>浏览量</div></a></div></div>
<div class="-mx-2 flex h-5 min-h-5 w-[calc(100%+16px)] items-center justify-between mt-3" role="group"><a class="x-link x-engagement-button" href="/compose/post?in_reply_to=1"><span class="x-engagement-pill h-10 px-3"><span class="x-animated-count-visual">36</span></span></a></div>
</div></article></div></li>
<li><div class="flex flex-col"><div role="link" class="outline-focus px-horizontal py-vertical border-b cursor-pointer relative"><a class="absolute inset-0 pointer-events-none" href="/someone/status/2"></a>
<article class="flex flex-col gap-1"><a class="rounded-xs x-link hover:underline" href="/someone"><div class="font-bold">Someone</div></a>
<div class="max-w-full text-body whitespace-pre-wrap"><span class="max-w-full text-[length:inherit]">Nice write-up, thanks for sharing the details.</span></div></article></div></div></li>
</ul></div>
<aside class="fixed bottom-0 isolate z-40 flex w-full min-w-0 flex-col gap-4 px-6 pt-3"><h2 class="text-headline1 font-extrabold text-center">查看所有回复</h2><a class="x-button h-12 w-full px-6" href="/i/jf/onboarding/web?mode=login">继续前往 X</a></aside>
</main></div></div></body></html>"""
URL = "https://x.com/example_author/status/1234567890?s=20"


def test_an_x_article_keeps_its_links_and_gets_a_clean_title():
    article = web_import.extract_article(ARTICLE.encode(), URL, rendered=True)
    assert article.title == TITLE
    assert "[Terminal Bench 2.0](https://www.tbench.ai/leaderboard/terminal-bench/2.0)" in article.content
    assert "We start from [Traces](https://docs.langchain.com/langsmith/observability-quickstart) to see" in article.content
    assert "## What a harness is for" in article.content
    assert article.content.startswith("**TLDR:**"), article.content[:120]
    # 作者栏、作者卡片、浏览量和别人的回复不进课文
    for noise in ("@example_author", "更多文章", "浏览量", "Nice write-up", "继续前往 X"):
        assert noise not in article.content, noise


def test_an_x_article_without_the_body_class_still_comes_out_clean():
    # 登录后的 X 不一定给正文那层 x-article-body：没有它时抽取器从整页找，作者头像和标题会重复出现在课文开头
    article = web_import.extract_article(ARTICLE.replace("x-article-body ", "").encode(), URL, rendered=True)
    assert article.title == TITLE and article.content.startswith("**TLDR:**"), article.content[:120]
    assert "[Traces](https://docs.langchain.com/langsmith/observability-quickstart)" in article.content


def test_an_x_post_without_a_heading_takes_the_post_as_its_title():
    paragraphs = "".join(f"<p>第 {i} 段：外壳决定了模型能发挥多少，提示词、工具和执行流程都属于外壳，每一样都能调。</p>" for i in range(5))
    for page_title, expected in (
        ("X 上的 Ada：“外壳工程的三个经验” / X", "外壳工程的三个经验"),
        ('Ada on X: "Three lessons from harness engineering" / X', "Three lessons from harness engineering"),
        ("Xユーザーのvivさん: 「ハーネスの話」 / X", "ハーネスの話"),
        ("X", "X"),
    ):
        html = f"<html><head><title>{page_title}</title></head><body><article>{paragraphs}</article></body></html>"
        assert web_import.extract_article(html.encode(), "https://x.com/v/status/1", rendered=True).title == expected


def test_a_long_post_title_is_cut_and_the_logged_in_author_header_is_dropped():
    long = "外壳" * 80
    title, _ = web_import.x_article(f"X 上的 Ada：“{long}” / X", "正文")
    assert len(title) == 100 and title.endswith("…")
    content = ("![](https://pbs.twimg.com/profile_images/1/a_x96.jpg)\n\n[Ada](https://x.com/example_author)\n\n"
               f"{TITLE}\n\n**TLDR:** the harness matters.")
    assert web_import.x_article(f"X 上的 Ada：“{TITLE}” / X", content) == (TITLE, "**TLDR:** the harness matters.")


def test_layout_class_names_do_not_make_other_pages_lose_their_article():
    paragraphs = "".join(f'<p>Paragraph {i}: see <a href="https://example.com/{i}">the notes</a> for how the loop was tuned.</p>' for i in range(6))
    html = (f'<html><head><title>Notes</title></head><body><div class="flex lg:w-[calc(100%-var(--sidebar-width))]">'
            f'<article><h1>Notes</h1>{paragraphs}</article></div></body></html>')
    content = web_import.extract_article(html.encode(), "https://example.com/notes", rendered=True).content
    assert content.count("[the notes](https://example.com/") == 6


def test_a_link_without_an_address_keeps_its_words_without_brackets():
    paragraphs = "".join(f"<p>Paragraph {i}: the harness shapes what the model can do, from prompts to tools.</p>" for i in range(6))
    html = (f"<html><head><title>t</title></head><body><article><h1>t</h1><p>Top 5 on <a><span>Terminal Bench 2.0</span></a>."
            f" Then <a href=\"javascript:void(0)\">more</a>.</p>{paragraphs}</article></body></html>")
    content = web_import.extract_article(html.encode(), "https://example.com/a").content
    assert "Top 5 on Terminal Bench 2.0. Then more." in content


def test_bloom_pages_are_not_clipped_into_bloom(client, monkeypatch):
    monkeypatch.setattr(settings, "WEB_URL", "https://bloom.example.com")
    user = create_user("clip-bloom@example.com")
    for url in ("https://bloom.example.com/zh/learn/course/41/lesson/1", "https://www.bloom.example.com/learn"):
        res = client.post("/api/clippings", headers=bearer(user), json={"url": url, "html": ARTICLE})
        assert res.status_code == 400 and "本来就在 Bloom 里" in res.json()["detail"], res.text
    assert client.post("/api/clippings", headers=bearer(user), json={"url": URL, "html": ARTICLE}).status_code == 200
