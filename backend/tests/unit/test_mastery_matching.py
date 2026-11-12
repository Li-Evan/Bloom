"""勾选掌握项改成规范化后的近似匹配（去标点、空白、大小写、全半角；包含关系或相似度 >= 阈值），
并且一篇课文可以写多条 mastery 注释（以前只认第一条，一篇课文讲了好几项也只勾上 1 项）。仍然只看课文自己的注释，不按正文猜。"""
import pytest

import app.courses as courses_module
from app.courses import _auto_check_mastery, _count_mastery_items, _mastery_comment_items

ZH_OUTLINE = (
    "# 课 · 课程大纲\n\n## 核心掌握项\n\n### 甲\n"
    "- [ ] 能够解释复利和单利的区别\n"
    "- [ ] 能够解释存量与流量的区别\n"
    "- [ ] 能够判断一个二阶矩阵能否对角化，并写出各因子\n"
    "- [x] 能够计算矩阵的特征值\n"
    "- [ ] 能够解释复利\n"
    "- [ ] 能够解释单利\n"
    "\n## 不在本课题范围内\n\n- 其它\n"
)
EN_OUTLINE = (
    "# Course Outline\n\n## Core mastery items\n\n### A\n"
    "- [ ] Define a system as elements, interconnections and a function or purpose.\n"
    "- [ ] Explain why swapping elements while incentives stay unchanged often leaves system behaviour the same.\n"
    "- [ ] Distinguish a stock from a flow, and classify given quantities (bathtub water, account money) as one or the other.\n"
    "- [ ] Apply the stock-and-flow view to a household budget: savings as the stock, income and spending as flows.\n"
    "\n## Out of scope\n\n- Other\n"
)


def comment(*items):
    return "正文\n" + "".join(f"<!-- mastery: {item} -->\n" for item in items)


def ticked(outline, lesson):
    return [line[6:] for line in _auto_check_mastery(outline, lesson).splitlines() if line.startswith("- [x] ")]


# ---- 多条注释 ----

def test_a_lesson_with_one_comment_per_item_ticks_every_item():
    """每项一条 <!-- mastery: ... -->，以前只认第一条。"""
    lesson = comment(
        "Define a system as elements, interconnections and a function or purpose.",
        "Distinguish a stock from a flow, and classify given quantities (bathtub water, account money) as one or the other.",
        "Explain why swapping elements while incentives stay unchanged often leaves system behaviour the same.",
    )

    assert _mastery_comment_items(EN_OUTLINE, lesson) == [
        "Define a system as elements, interconnections and a function or purpose.",
        "Distinguish a stock from a flow, and classify given quantities (bathtub water, account money) as one or the other.",
        "Explain why swapping elements while incentives stay unchanged often leaves system behaviour the same.",
    ]
    assert _count_mastery_items(_auto_check_mastery(EN_OUTLINE, lesson)) == (3, 4)


def test_one_comment_with_semicolons_and_several_comments_can_be_mixed():
    lesson = comment("能够解释复利和单利的区别; 能够解释存量与流量的区别", "能够判断一个二阶矩阵能否对角化，并写出各因子")

    assert ticked(ZH_OUTLINE, lesson) == [
        "能够解释复利和单利的区别", "能够解释存量与流量的区别", "能够判断一个二阶矩阵能否对角化，并写出各因子", "能够计算矩阵的特征值",
    ]


def test_a_comment_spread_over_several_lines_is_read():
    lesson = "正文\n<!-- mastery:\n能够解释复利和单利的区别;\n能够解释存量与流量的区别\n-->"

    assert _mastery_comment_items(ZH_OUTLINE, lesson) == ["能够解释复利和单利的区别", "能够解释存量与流量的区别"]


def test_an_item_that_contains_a_semicolon_itself_is_still_found_whole():
    outline = "- [ ] Explain A; and B\n- [ ] Apply C\n"

    assert _mastery_comment_items(outline, comment("Apply C; Explain A; and B")) == ["Apply C", "Explain A; and B"]


# ---- 近似匹配 ----

@pytest.mark.parametrize("written", [
    "能够解释复利和单利的区别。",                  # 句号
    "  能够解释复利和单利的区别  ",                # 空白
    "能够解释 复利 和 单利 的区别",                # 空格
    "能够解释复利和单利的区别（含例子）",            # 多了括号说明（被包含 + 相似度）
    "能够解释复利与单利的区别",                    # 一个字不同
    "能够解释复利和单利的区别!",                   # 标点
])
def test_a_slightly_rewritten_chinese_item_still_ticks_the_right_one(written):
    assert _mastery_comment_items(ZH_OUTLINE, comment(written)) == ["能够解释复利和单利的区别"]
    assert "能够解释复利和单利的区别" in ticked(ZH_OUTLINE, comment(written))


@pytest.mark.parametrize("written", [
    "explain why swapping elements while incentives stay unchanged often leaves system behaviour the same",   # 大小写、少句号
    "Explain why swapping elements while incentives stay unchanged, often leaves system behaviour the same.",  # 多一个逗号
    "Explain why swapping elements while incentives stay unchanged often leaves the system behaviour the same.",  # 多一个词
    "EXPLAIN WHY SWAPPING ELEMENTS WHILE INCENTIVES STAY UNCHANGED OFTEN LEAVES SYSTEM BEHAVIOUR THE SAME",
])
def test_a_slightly_rewritten_english_item_still_ticks_the_right_one(written):
    assert _mastery_comment_items(EN_OUTLINE, comment(written)) == [
        "Explain why swapping elements while incentives stay unchanged often leaves system behaviour the same.",
    ]


def test_a_truncated_item_that_is_most_of_the_original_still_counts_but_half_of_it_does_not():
    outline = "- [ ] 能够判断一个二阶矩阵能否对角化，并写出各因子\n"

    assert _mastery_comment_items(outline, comment("能够判断一个二阶矩阵能否对角化")) == ["能够判断一个二阶矩阵能否对角化，并写出各因子"]
    assert _mastery_comment_items(outline, comment("能够判断一个二阶矩阵")) == []


def test_full_width_and_half_width_characters_are_the_same_thing():
    outline = "- [ ] Compute f(x)=2x+1 at x=3 and explain the result\n"

    assert _mastery_comment_items(outline, comment("Compute f（x）＝2x＋1 at x＝3 and explain the result")) == [
        "Compute f(x)=2x+1 at x=3 and explain the result",
    ]


def test_the_progress_row_and_the_tick_use_the_outlines_own_wording_not_the_models():
    lesson = comment("能够解释复利与单利的区别。")

    assert _mastery_comment_items(ZH_OUTLINE, lesson) == ["能够解释复利和单利的区别"]
    assert "- [x] 能够解释复利和单利的区别\n" in _auto_check_mastery(ZH_OUTLINE, lesson)


# ---- 不误勾 ----

@pytest.mark.parametrize("written", [
    "能够解释存量与流量的关系",                   # 差两个字的另一项，相似度 0.83 < 0.85
    "能够判断二阶矩阵是否可以对角化",               # 改写太多：相似度 0.8 < 0.85
    "能够解释",                                 # 太短
    "能够",
    "完全无关的一句话，讲的是别的东西",
    "",
])
def test_a_different_or_too_loose_item_ticks_nothing(written):
    outline = ZH_OUTLINE.replace("- [x] 能够计算矩阵的特征值\n", "")

    assert _mastery_comment_items(outline, comment(written)) == []
    assert _auto_check_mastery(outline, comment(written)) == outline


def test_short_items_only_match_exactly():
    outline = "- [ ] 能够解释复利\n- [ ] 能够解释单利\n- [ ] 会算利息\n"

    assert _mastery_comment_items(outline, comment("能够解释复利。", "会算利息")) == ["能够解释复利", "会算利息"]  # 规范化后一字不差
    assert _mastery_comment_items(outline, comment("会算利息吗", "会算")) == []  # 不到 MASTERY_MATCH_MIN_CHARS 个字：包含也不算
    assert _mastery_comment_items(outline, comment("能够解释复利吗")) == ["能够解释复利"]  # 够长的，整条包含并占大头，算同一项


def test_an_item_the_comment_wrote_word_for_word_is_not_stolen_by_a_loose_match_of_another():
    outline = "- [ ] Explain simple interest versus compound interest\n- [ ] Explain simple interest versus compound growth\n"
    lesson = comment("Explain simple interest versus compound interest", "Explain simple interest versus compound growth.")

    assert _mastery_comment_items(outline, lesson) == [
        "Explain simple interest versus compound interest", "Explain simple interest versus compound growth",
    ]


def test_when_two_outline_items_are_equally_close_nothing_is_ticked():
    outline = "- [ ] Explain simple interest versus compound interest\n- [ ] Explain simple interest versus compound growth\n"

    assert _mastery_comment_items(outline, comment("Explain simple interest versus compound")) == []


def test_items_that_are_not_in_the_outline_at_all_are_ignored_and_ticked_ones_stay_ticked():
    updated = _auto_check_mastery(ZH_OUTLINE, comment("能够计算矩阵的特征值", "完全不在大纲里的一项内容比较长"))

    assert updated == ZH_OUTLINE and _count_mastery_items(updated) == (1, 6)


def test_only_the_whole_line_is_ticked_even_when_one_item_is_a_prefix_of_another():
    outline = "- [ ] 能够解释复利的含义\n- [ ] 能够解释复利的含义和计算\n"

    updated = _auto_check_mastery(outline, comment("能够解释复利的含义"))

    assert updated == "- [x] 能够解释复利的含义\n- [ ] 能够解释复利的含义和计算\n"


def test_windows_line_endings_in_the_outline_are_ticked_too():
    outline = "- [ ] 能够解释复利和单利的区别\r\n- [ ] 能够解释存量与流量的区别\r\n"

    assert _auto_check_mastery(outline, comment("能够解释复利和单利的区别。")) == (
        "- [x] 能够解释复利和单利的区别\r\n- [ ] 能够解释存量与流量的区别\r\n"
    )


def test_a_lesson_without_a_comment_or_with_an_empty_one_changes_nothing():
    assert _auto_check_mastery(ZH_OUTLINE, "没有注释") == ZH_OUTLINE
    assert _auto_check_mastery(ZH_OUTLINE, "<!-- mastery: ; -->") == ZH_OUTLINE
    assert _mastery_comment_items("没有掌握项", comment("能够解释复利")) == []


def test_the_thresholds_are_constants_with_the_agreed_values():
    assert courses_module.MASTERY_MATCH_SIMILARITY == 0.85
    assert 0.5 < courses_module.MASTERY_MATCH_CONTAINMENT < 1 and courses_module.MASTERY_MATCH_MIN_CHARS >= 4


# ---- 差异只在数字或单个关键词的不是同一项 ----

@pytest.mark.parametrize("outline_item, written", [
    ("能够计算矩阵的特征向量", "能够计算矩阵的特征值"),
    ("能够解释二阶矩阵的行列式含义", "能够解释三阶矩阵的行列式含义"),
    ("Compute the determinant of a 3x3 matrix by cofactor expansion", "Compute the determinant of a 2x2 matrix by cofactor expansion"),
    ("Compare a fixed-rate mortgage with a variable payment schedule", "Compare an adjustable-rate mortgage with a variable payment schedule"),
    ("能够列出前 5 项数列并判断是否收敛", "能够列出前 6 项数列并判断是否收敛"),
    ("Explain why the first 3 periods matter most for the balance", "Explain why the first 5 periods matter most for the balance"),
])
def test_a_near_twin_that_differs_only_by_a_number_or_one_keyword_is_not_the_same_item(outline_item, written):
    outline = f"- [ ] {outline_item}\n"

    assert _mastery_comment_items(outline, comment(written)) == []
    assert _auto_check_mastery(outline, comment(written)) == outline


@pytest.mark.parametrize("outline_item, written", [
    ("Explain why swapping elements while incentives stay unchanged often leaves system behaviour the same",
     "Explain why swapping elements while incentives stay unchanged often leave system behavior the same"),  # 词形变化 / 拼写变体
    ("能够解释复利和单利的区别", "能够解释复利与单利的区别"),                                                 # 虚词
    ("Explain the idea of compounding with an example", "Explain the idea of a compounding with the example"),  # 冠词
    ("能够判断一个二阶矩阵能否对角化", "能够判断二阶矩阵能否对角化"),                                           # 删掉「一个」
])
def test_function_words_inflections_and_dropped_words_are_still_the_same_item(outline_item, written):
    outline = f"- [ ] {outline_item}\n"

    assert _mastery_comment_items(outline, comment(written)) == [outline_item]


def test_a_comment_item_identical_after_normalizing_is_taken_even_when_another_item_is_just_as_close():
    outline = "- [ ] Explain simple interest versus compound interest\n- [ ] Explain simple interest versus compound interests\n"

    assert _mastery_comment_items(outline, comment("explain simple interest versus compound interest.")) == [
        "Explain simple interest versus compound interest",
    ]
