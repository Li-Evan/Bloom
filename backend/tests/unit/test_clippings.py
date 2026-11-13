"""网页剪藏：浏览器插件交来用户已经打开的网页，全部进每人一门的「网页剪藏」；资料类课程可以删单个文件。"""
import pytest

from app import knowledge, web_import
from app.clippings import article_markdown
from app.models import Course, LearningEvent, Lesson
from tests.conftest import TestSession, bearer, create_user

PARAGRAPHS = "".join(f"<p>第 {i} 段：旋转位置编码把位置信息写进注意力的内积里，相对位置自然出现在结果中。</p>" for i in range(6))
REAL_FETCH = web_import.fetch_html


@pytest.fixture(autouse=True)
def server_cannot_read(monkeypatch):
    """默认服务器自己读不到这一页（403、要登录、靠脚本出正文），存的是浏览器交来的那份；不连外网。"""
    def refuse(url, deadline, **_):
        raise web_import.FetchFailed("HTTP 403")
    monkeypatch.setattr(web_import, "fetch_html", refuse)


def serve(monkeypatch, html, final=None):
    """服务器按网址读到 html（final：跳转后的地址）"""
    calls = []

    def fetch(url, deadline, **_):
        calls.append(url)
        return html.encode(), final or url
    monkeypatch.setattr(web_import, "fetch_html", fetch)
    return calls


def page(title="旋转式位置编码", body=""):
    return (f"<!DOCTYPE html><html><head><meta charset='utf-8'><title>{title} - 科学空间</title></head>"
            f"<body><nav>首页 归档 关于</nav><article><h1>{title}</h1>{PARAGRAPHS}{body}</article>"
            "<footer>版权所有</footer></body></html>")


def clip(client, user, url="https://kexue.fm/archives/8265", html=None, language="zh"):
    return client.post("/api/clippings", headers=bearer(user),
                       json={"url": url, "html": html or page(), "language": language})


def lessons_of(course_id):
    with TestSession() as db:
        return [(lesson.number, lesson.source_filename, lesson.source_url, lesson.content)
                for lesson in db.query(Lesson).filter_by(course_id=course_id).order_by(Lesson.number)]


def mark_read(course_id, number):
    with TestSession() as db:
        db.add(LearningEvent(course_id=course_id, lesson_number=number, event_type="lesson_completed"))
        db.commit()


# ---- 剪藏 ----

def test_the_first_clip_creates_the_clippings_course_and_later_clips_join_it(client):
    user = create_user("clip-first@example.com")
    first = clip(client, user)
    assert first.status_code == 200, first.text
    assert first.json()["lesson_number"] == 1 and not first.json()["existed"]
    course_id = first.json()["course_id"]

    second = clip(client, user, url="https://kexue.fm/archives/8130", html=page("线性注意力"))
    assert second.status_code == 200, second.text
    assert second.json() == {"course_id": course_id, "lesson_number": 2, "existed": False}

    courses = client.get("/api/courses", headers=bearer(user)).json()
    assert [(c["name"], c["is_project"], c["is_clippings"], c["lesson_count"]) for c in courses] == [("网页剪藏", True, True, 2)]
    (n1, name1, url1, text1), (n2, name2, url2, _) = lessons_of(course_id)
    assert (n1, name1, url1) == (1, "旋转式位置编码.md", "https://kexue.fm/archives/8265")
    assert (n2, name2, url2) == (2, "线性注意力.md", "https://kexue.fm/archives/8130")
    # 和「网页原文」存下来的课文一样：标题、来源链接、分隔线、正文；导航和页脚不进来
    assert text1.startswith("# 旋转式位置编码\n\n[查看来源网页](<https://kexue.fm/archives/8265>)\n\n---\n\n")
    assert "第 5 段" in text1 and "首页 归档" not in text1 and "版权所有" not in text1


def test_the_course_language_comes_from_the_first_clip(client):
    user = create_user("clip-en@example.com")
    course_id = clip(client, user, language="en").json()["course_id"]
    clip(client, user, url="https://kexue.fm/archives/8130", language="zh")
    detail = client.get(f"/api/courses/{course_id}", headers=bearer(user)).json()
    assert (detail["name"], detail["language"], detail["is_clippings"]) == ("Web Clippings", "en", True)
    assert all("[View original article](<" in text for _, _, _, text in lessons_of(course_id))


def test_clipping_the_same_page_again_opens_the_file_wherever_it_is_now(client):
    user = create_user("clip-again@example.com")
    course_id = clip(client, user).json()["course_id"]
    again = clip(client, user, url="https://kexue.fm/archives/8265#comments")
    assert again.json() == {"course_id": course_id, "lesson_number": 1, "existed": True}
    assert len(lessons_of(course_id)) == 1

    moved = client.post(f"/api/courses/{course_id}/lessons/1/move", headers=bearer(user), json={"new_course_name": "位置编码"})
    assert moved.status_code == 200, moved.text
    after_move = clip(client, user).json()
    assert after_move == {"course_id": moved.json()["course_id"], "lesson_number": 1, "existed": True}


def test_pages_on_any_port_can_be_clipped_and_are_never_fetched(client, monkeypatch):
    def no_lookup(host, port):
        raise AssertionError(f"looked up {host}:{port}")
    monkeypatch.setattr(web_import, "fetch_html", REAL_FETCH)
    monkeypatch.setattr(web_import, "public_address", no_lookup)
    user = create_user("clip-port@example.com")
    res = clip(client, user, url="http://wiki.intranet.example:8080/page?id=7#top")
    assert res.status_code == 200, res.text
    (_, _, url, _), = lessons_of(res.json()["course_id"])
    assert url == "http://wiki.intranet.example:8080/page?id=7"


# ---- 和「网页原文」对齐：服务器自己读得到这一页时，存的就是网页原文导入的那篇 ----

def test_a_page_the_server_can_read_is_saved_exactly_as_web_import_would(client, monkeypatch):
    # 登录后的浏览器里排版不同（X 上丢了加粗和链接），脚本还往正文里插了推荐
    url = "https://kexue.fm/archives/8265"
    served = page(body="<p><strong>要点</strong>：细节见<a href='https://arxiv.org/abs/2104.09864'>原论文</a>，这里只讲直觉和推导的主线。</p>")
    browser = page(body="<p>要点：细节见原论文，这里只讲直觉和推导的主线。</p><p>为你推荐：线性注意力的十种写法，登录后看更多。</p>")
    calls = serve(monkeypatch, served)
    user = create_user("clip-served@example.com")
    res = clip(client, user, url=url + "#comments", html=browser)
    assert res.status_code == 200, res.text
    assert calls == [url]
    (_, name, source_url, text), = lessons_of(res.json()["course_id"])
    assert text == article_markdown(web_import.extract_article(served.encode(), url), "zh")
    assert "**要点**" in text and "[原论文](https://arxiv.org/abs/2104.09864)" in text and "为你推荐" not in text
    assert (name, source_url) == ("旋转式位置编码.md", url)


def test_a_page_still_loading_in_the_browser_is_saved_from_the_server(client, monkeypatch):
    serve(monkeypatch, page())
    user = create_user("clip-loading@example.com")
    res = clip(client, user, html="<html><head><title>旋转式位置编码</title></head><body><p>加载中…</p></body></html>")
    assert res.status_code == 200, res.text
    (_, _, _, text), = lessons_of(res.json()["course_id"])
    assert "第 5 段" in text


def test_when_the_server_only_gets_a_teaser_the_page_from_the_browser_is_kept(client, monkeypatch):
    # 付费墙、「登录看全文」：服务器只拿到开头，用户自己的浏览器里是全文
    paid = "".join(f"<p>付费部分第 {i} 段：从复数乘法出发推导旋转矩阵，再推广到高维的分块对角形式。</p>" for i in range(12))
    serve(monkeypatch, page())
    user = create_user("clip-teaser@example.com")
    res = clip(client, user, html=page(body=paid))
    (_, _, _, text), = lessons_of(res.json()["course_id"])
    assert "付费部分第 11 段" in text


def test_a_server_read_that_lands_on_another_page_is_not_the_clip(client, monkeypatch):
    # 服务器被跳到登录页：既不用它，也不拿它顶替还没加载出正文的浏览器页面
    serve(monkeypatch, page("登录科学空间", body="<p>请先登录。登录后可以评论、收藏文章，并在手机和电脑之间同步阅读进度。</p>"),
          final="https://kexue.fm/login?next=/archives/8265")
    user = create_user("clip-login@example.com")
    loading = "<html><head><title>请稍候…</title></head><body><p>正在进行安全验证</p></body></html>"
    assert clip(client, user, html=loading).status_code == 422
    res = clip(client, user)
    (_, name, _, text), = lessons_of(res.json()["course_id"])
    assert name == "旋转式位置编码.md" and "请先登录" not in text


def test_noscript_text_of_a_page_that_ran_its_scripts_is_not_the_title(client):
    # X 的文章页：开着 JavaScript 时 <noscript> 不显示，以前它的「JavaScript 不可用。」成了课文标题
    user = create_user("clip-noscript@example.com")
    html = ("<!DOCTYPE html><html><head><title>Ada on X: Notes on Building / X</title></head><body>"
            "<noscript><h1>JavaScript 不可用。</h1><p>我们检测到此浏览器中的 JavaScript 已禁用。请启用 JavaScript 或改用支持的浏览器来继续访问 x.com。"
            "你可以在我们的帮助中心查看支持的浏览器列表。</p></noscript>"
            f"<main><article><div><span>Notes on Building a Better Agent Loop</span></div>{PARAGRAPHS}</article></main></body></html>")
    res = clip(client, user, url="https://x.com/example_author/status/1", html=html)
    assert res.status_code == 200, res.text
    (_, name, _, text), = lessons_of(res.json()["course_id"])
    assert "JavaScript" not in name and "JavaScript" not in text
    assert name.startswith("Ada on X") and "Notes on Building a Better Agent Loop" in text and "第 5 段" in text


def test_each_user_has_their_own_clippings(client):
    alice, bob = create_user("clip-alice@example.com"), create_user("clip-bob@example.com")
    a = clip(client, alice).json()
    b = clip(client, bob).json()
    assert a["course_id"] != b["course_id"] and not b["existed"]
    assert client.get(f"/api/courses/{a['course_id']}", headers=bearer(bob)).status_code == 404


def test_pages_without_an_article_are_refused_and_create_nothing(client):
    user = create_user("clip-refused@example.com")
    challenge = "<html><head><title>请稍候…</title></head><body><p>正在进行安全验证</p></body></html>"
    res = clip(client, user, html=challenge)
    assert res.status_code == 422 and "等页面显示出正文后再点一次" in res.json()["detail"]
    assert clip(client, user, url="file:///Users/me/a.html").status_code == 400
    assert clip(client, user, url="https://me:secret@example.com/a").status_code == 400
    assert clip(client, user, html="长" * (web_import.MAX_BYTES // 3 + 1)).status_code == 422
    assert client.post("/api/clippings", json={"url": "https://example.com/a", "html": page()}).status_code == 401
    with TestSession() as db:
        assert db.query(Course).filter_by(user_uuid=user.uuid).count() == 0


def test_the_knowledge_map_reads_each_clipping_under_its_own_title(client, monkeypatch):
    from tests.unit.test_knowledge_map import extraction, refresh, sync

    user = create_user("clip-map@example.com")
    course_id = clip(client, user).json()["course_id"]
    mark_read(course_id, 1)
    backgrounds = []
    monkeypatch.setattr(knowledge, "extract_part", lambda course, text, known: backgrounds.append(course.name) or extraction())
    assert sync(client, user, refresh(client, user)["next_chunk"]).status_code == 200
    assert backgrounds == ["旋转式位置编码"]
    # 改课名不影响剪藏的背景：已经整理好的不重整
    assert client.patch(f"/api/courses/{course_id}", headers=bearer(user), json={"name": "随手存"}).status_code == 200
    assert refresh(client, user)["pending_count"] == 0 and backgrounds == ["旋转式位置编码"]


# ---- 删单个文件 ----

def test_deleting_a_file_takes_its_records_and_frees_nothing_for_the_next_one(client):
    user = create_user("clip-delete@example.com")
    course_id = clip(client, user).json()["course_id"]
    clip(client, user, url="https://kexue.fm/archives/8130", html=page("线性注意力"))
    mark_read(course_id, 2)

    res = client.delete(f"/api/courses/{course_id}/lessons/2", headers=bearer(user))
    assert res.status_code == 200, res.text
    assert [number for number, *_ in lessons_of(course_id)] == [1]
    with TestSession() as db:
        assert db.query(LearningEvent).filter_by(course_id=course_id, lesson_number=2).count() == 0
    # 下一篇排到空出来的编号，不会一进来就显示已读
    third = clip(client, user, url="https://kexue.fm/archives/9000", html=page("位置插值")).json()
    assert third["lesson_number"] == 2
    listed = client.get(f"/api/courses/{course_id}/lessons", headers=bearer(user)).json()
    assert [(item["number"], item["is_read"]) for item in listed] == [(1, False), (2, False)]


def test_only_files_of_your_own_material_courses_can_be_deleted(client):
    from tests.conftest import seed_course

    user, other = create_user("clip-del-owner@example.com"), create_user("clip-del-other@example.com")
    course_id = clip(client, user).json()["course_id"]
    assert client.delete(f"/api/courses/{course_id}/lessons/1", headers=bearer(other)).status_code == 404
    assert client.delete(f"/api/courses/{course_id}/lessons/7", headers=bearer(user)).status_code == 404
    topic_id = seed_course(user.uuid)[0]
    topic =client.delete(f"/api/courses/{topic_id}/lessons/1", headers=bearer(user))
    assert topic.status_code == 400
    assert len(lessons_of(course_id)) == 1


# ---- 浏览器里渲染过的公式 ----

# 科学空间页面里 MathJax 2.7.9 渲染后的真实结构（行内公式原样，行间公式删去了中间的排版 span）
MATHJAX2_INLINE = (
    '<span class="MathJax_Preview" style="color: inherit;"></span><span class="MathJax notranslate" id="MathJax-Element-1-Frame" '
    'tabindex="0" role="presentation" style="position: relative;"><nobr aria-hidden="true"><span class="math" id="MathJax-Span-1">'
    '<span class="mrow" id="MathJax-Span-2"><span class="mi" id="MathJax-Span-3" style="font-family: MathJax_Math-italic;">W</span>'
    '</span></span></nobr><span class="MJX_Assistive_MathML" role="presentation"><math xmlns="http://www.w3.org/1998/Math/MathML">'
    '<mi>W</mi></math></span></span><script type="math/tex" id="MathJax-Element-1">W</script>')
MATHJAX2_DISPLAY = (
    '<span class="MathJax_Preview" style="color: inherit;"></span><div class="MathJax_Display"><span class="MathJax MathJax_FullWidth '
    'notranslate" id="MathJax-Element-3-Frame" tabindex="0" role="presentation"><nobr aria-hidden="true"><span class="math" '
    'id="MathJax-Span-9"><span class="mi">q</span><span class="mo">=</span><span class="mi">f</span></span></nobr>'
    '<span class="MJX_Assistive_MathML MJX_Assistive_MathML_Block" role="presentation"><math xmlns="http://www.w3.org/1998/Math/MathML" '
    'display="block"><mi>q</mi><mo>=</mo><mi>f</mi></math></span></span></div>'
    '<script type="math/tex; mode=display" id="MathJax-Element-3">\\tilde{q}_m = f(q, m)</script>')


def extracted(body):
    return web_import.extract_article(page(body=f"<p>权重矩阵 {body} 随时间更新。</p>").encode(), "https://kexue.fm/archives/0").content


def test_mathjax2_output_rendered_in_the_browser_keeps_one_copy_of_each_formula():
    assert "权重矩阵 $W$ 随时间更新" in extracted(MATHJAX2_INLINE)
    display = extracted(MATHJAX2_DISPLAY)
    assert display.count("\\tilde{q}_m = f(q, m)") == 1 and "q=f" not in display.replace(" ", "")


def test_mathjax3_formulas_use_the_tex_the_extension_wrote_down():
    container = ('<mjx-container class="MathJax CtxtMenu_Attached_0" jax="CHTML" display="true" data-bloom-tex="E = mc^2" '
                 'data-bloom-display="block"><mjx-math class="MJX-TEX"><mjx-mi>E</mjx-mi></mjx-math><mjx-assistive-mml>'
                 '<math display="block"><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></math>'
                 '</mjx-assistive-mml></mjx-container>')
    content = extracted(container)
    assert content.count("E = mc^2") == 1 and "Emc2" not in content.replace(" ", "")


def test_katex_rendered_in_the_browser_keeps_its_tex():
    katex = ('<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow>'
             '<annotation encoding="application/x-tex">a+b</annotation></semantics></math></span>'
             '<span class="katex-html" aria-hidden="true"><span class="mord mathnormal">a</span><span class="mbin">+</span>'
             '<span class="mord mathnormal">b</span></span></span>')
    assert "权重矩阵 $a+b$ 随时间更新" in extracted(katex)
