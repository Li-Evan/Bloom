import re

from app import courses, prompts_en


def placeholders(text):
    return set(re.findall(r'(?<!\{)\{(\w+)\}(?!\})', text))


def test_english_outline_review_and_repair_remove_unsupported_question_tags_like_chinese():
    for zh, en in ((courses.GROUNDED_SYLLABUS_REVIEW_PROMPT, prompts_en.GROUNDED_SYLLABUS_REVIEW_PROMPT),
                   (courses.GROUNDED_SYLLABUS_REPAIR_PROMPT, prompts_en.GROUNDED_SYLLABUS_REPAIR_PROMPT)):
        assert '没有证据的标记必须删除' in zh
        assert 'a tag without such evidence must be removed, never kept just because the draft has it' in en
        assert 'tag on a mastery item exactly as it is' not in en


def test_english_summary_reviews_evidence_not_achievement():
    assert '没有作答标记未验证' in courses.SUMMARY_PROMPT
    assert 'mark an item with no answer as unverified' in prompts_en.SUMMARY_PROMPT
    assert 'how far it was achieved' not in prompts_en.SUMMARY_PROMPT
    assert placeholders(courses.SUMMARY_PROMPT) == placeholders(prompts_en.SUMMARY_PROMPT)


def test_english_next_lesson_rule_six_reads_correctly():
    assert '6. **Accuracy first**: prefer an accurate concrete example; use an analogy only when it helps without misleading, ' \
           'and state where it applies (its limits or the concrete situation it fits), to help the student build intuition' in prompts_en.NEXT_LESSON_PROMPT
    assert 'limits or concrete scene to help' not in prompts_en.NEXT_LESSON_PROMPT
    assert placeholders(courses.NEXT_LESSON_PROMPT) == placeholders(prompts_en.NEXT_LESSON_PROMPT)


def test_english_prerequisites_line_never_lists_what_the_lesson_teaches():
    for zh, en in ((courses.FIRST_LESSON_PROMPT, prompts_en.FIRST_LESSON_PROMPT),
                   (courses.SOURCE_LESSON_PROMPT, prompts_en.SOURCE_LESSON_PROMPT),
                   (courses.NEXT_LESSON_PROMPT, prompts_en.NEXT_LESSON_PROMPT)):
        assert '不得把本篇要教的概念当作前置要求' in zh
        assert '> Prerequisites: [only the background the reader needs beforehand; never list a concept this lesson is meant to teach]' in en
        assert placeholders(zh) == placeholders(en)
