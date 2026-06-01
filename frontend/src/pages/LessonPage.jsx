import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Markdown from '../components/Markdown';
import {
  getLesson, getLessons, getAnnotations, createAnnotation, deleteAnnotation,
  submitFeedback, generateNextLesson, getFeedback, recordLessonOpened,
} from '../lib/api';

export default function LessonPage() {
  const { courseId, lessonNum } = useParams();
  const navigate = useNavigate();

  const [lesson, setLesson] = useState(null);
  const [allLessons, setAllLessons] = useState([]);
  const [annotations, setAnnotations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [feedbackContent, setFeedbackContent] = useState('');
  const [thoughtAnswers, setThoughtAnswers] = useState('');
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [feedbackSaved, setFeedbackSaved] = useState(false);

  const [showAnnotation, setShowAnnotation] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [annotationComment, setAnnotationComment] = useState('');
  const [selectionRange, setSelectionRange] = useState({ start: 0, end: 0 });

  const [generating, setGenerating] = useState(false);
  const [streamContent, setStreamContent] = useState('');
  const [showMobileNav, setShowMobileNav] = useState(false);

  const contentRef = useRef(null);

  useEffect(() => {
    setLoading(true);
    setError('');
    setFeedbackSaved(false);
    setStreamContent('');
    setGenerating(false);
    setFeedbackContent('');
    setThoughtAnswers('');

    Promise.all([
      getLesson(courseId, lessonNum),
      getAnnotations(courseId, lessonNum),
      getLessons(courseId),
      getFeedback(courseId, lessonNum),
    ])
      .then(([l, a, all, fb]) => {
        setLesson(l);
        setAnnotations(a);
        setAllLessons(all.filter((x) => x.number > 0));
        if (fb.exists) {
          setFeedbackContent(fb.content || '');
          setThoughtAnswers(fb.thought_answers || '');
          setFeedbackSaved(true);
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));

    // Record lesson opened event + scroll to top
    recordLessonOpened(courseId, lessonNum).catch(() => {});
    window.scrollTo(0, 0);
  }, [courseId, lessonNum]);

  const handleDeleteAnnotation = async (annId) => {
    try {
      await deleteAnnotation(courseId, lessonNum, annId);
      setAnnotations((prev) => prev.filter((a) => a.id !== annId));
    } catch (err) {
      setError(err.message);
    }
  };

  const handleTextSelect = () => {
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const text = sel.toString().trim();
      if (!text) return;
      // 用选区的公共祖先节点判断是否落在课文区，而非只看 anchorNode（更稳健、跨浏览器一致）
      const node = sel.getRangeAt(0).commonAncestorContainer;
      const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
      if (!contentRef.current?.contains(el)) return;
      setSelectedText(text);
      setSelectionRange({ start: 0, end: text.length });
      setShowAnnotation(true);
      setAnnotationComment('');
    } catch (e) {
      console.error('handleTextSelect failed', e);
    }
  };

  const handleSaveAnnotation = async () => {
    if (!annotationComment.trim()) return;
    try {
      const ann = await createAnnotation(courseId, lessonNum, {
        position_start: selectionRange.start,
        position_end: selectionRange.end,
        original_text: selectedText,
        comment: annotationComment.trim(),
      });
      setAnnotations((prev) => [...prev, ann]);
      setShowAnnotation(false);
      setAnnotationComment('');
      setSelectedText('');
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSubmitFeedback = async () => {
    setSubmittingFeedback(true);
    setError('');
    try {
      await submitFeedback(courseId, lessonNum, feedbackContent, thoughtAnswers.trim() || null);
      setFeedbackSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmittingFeedback(false);
    }
  };

  const handleReadDone = async () => {
    if (feedbackContent.trim() && !feedbackSaved) {
      await handleSubmitFeedback();
    }
    setGenerating(true);
    setStreamContent('');
    setError('');
    try {
      let finalData = null;
      await generateNextLesson(
        courseId,
        (chunk) => setStreamContent((prev) => prev + chunk),
        (data) => { finalData = data; },
      );
      if (finalData?.completed) {
        navigate(`/course/${courseId}`);
      } else if (finalData?.lesson_number) {
        navigate(`/course/${courseId}/lesson/${finalData.lesson_number}`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const currentNum = parseInt(lessonNum, 10);

  if (loading) {
    return (
      <div className="min-h-[100dvh] bg-stone-50">
        <header className="bg-stone-900 sticky top-0 z-10">
          <div className="max-w-[1200px] mx-auto px-6 py-3.5" />
        </header>
        <div className="max-w-[1200px] mx-auto px-6 py-10 flex gap-8">
          <main className="flex-1 min-w-0">
            <div className="bg-white rounded-2xl border border-stone-200/60 p-8 md:p-10">
              <div className="skeleton h-7 rounded-lg w-3/5 mb-6" />
              <div className="space-y-3">
                <div className="skeleton h-4 rounded w-full" />
                <div className="skeleton h-4 rounded w-full" />
                <div className="skeleton h-4 rounded w-4/5" />
                <div className="h-4" />
                <div className="skeleton h-4 rounded w-full" />
                <div className="skeleton h-4 rounded w-full" />
                <div className="skeleton h-4 rounded w-3/5" />
                <div className="h-4" />
                <div className="skeleton h-4 rounded w-full" />
                <div className="skeleton h-4 rounded w-2/3" />
              </div>
            </div>
          </main>
          <aside className="hidden lg:block w-48 shrink-0">
            <div className="skeleton h-3 rounded w-10 mb-4" />
            <div className="space-y-1">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton h-9 rounded-lg w-full" />
              ))}
            </div>
          </aside>
        </div>
      </div>
    );
  }

  if (error && !lesson) {
    return (
      <div className="min-h-[100dvh] bg-stone-50 flex flex-col items-center justify-center gap-4">
        <p className="text-rose-500 text-sm">{error}</p>
        <button
          onClick={() => navigate(`/course/${courseId}`)}
          className="text-emerald-600 hover:text-emerald-700 text-sm font-medium transition-colors"
        >
          返回课程
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-stone-50">
      {/* Header */}
      <header className="bg-stone-900 sticky top-0 z-10">
        <div className="max-w-[1200px] mx-auto px-6 py-3.5 flex items-center justify-between">
          <button
            onClick={() => navigate(`/course/${courseId}`)}
            className="text-stone-400 hover:text-white text-sm transition-colors flex items-center gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
            返回课程
          </button>
          <div className="flex items-center gap-3">
            <span className="text-xs text-stone-500 font-mono tabular-nums">
              {String(lessonNum).padStart(2, '0')}{lesson?.is_evaluation ? ' / EVAL' : ''}
            </span>
            <button
              onClick={() => setShowMobileNav(!showMobileNav)}
              className="lg:hidden text-stone-400 hover:text-white transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-[1200px] mx-auto px-6 py-10 flex gap-8">
        {/* Main content */}
        <main className="flex-1 min-w-0">
          {/* Lesson Content */}
          <article
            ref={contentRef}
            onMouseUp={handleTextSelect}
            className="bg-white rounded-2xl border border-stone-200/60 shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-8 md:p-10 mb-8"
          >
            <div className="prose prose-stone prose-lg max-w-none">
              <Markdown>{lesson?.content}</Markdown>
            </div>
          </article>

          {/* Annotations */}
          {annotations.length > 0 && (
            <div className="bg-amber-50/50 rounded-xl border border-amber-200/40 p-5 mb-8">
              <h3 className="text-xs font-medium text-amber-700 uppercase tracking-wide mb-3">我的批注</h3>
              <div className="space-y-2">
                {annotations.map((ann) => (
                  <div key={ann.id} className="bg-white rounded-lg p-3 border border-amber-100/60 group/ann">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-stone-400 mb-1 leading-relaxed">
                          原文：{ann.original_text.length > 80 ? ann.original_text.slice(0, 80) + '...' : ann.original_text}
                        </p>
                        <p className="text-sm text-stone-700">{ann.comment}</p>
                      </div>
                      <button
                        onClick={() => handleDeleteAnnotation(ann.id)}
                        className="opacity-0 group-hover/ann:opacity-100 text-stone-300 hover:text-rose-500 transition-all shrink-0 p-1"
                        title="删除批注"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Feedback section */}
          <div className="bg-white rounded-2xl border border-stone-200/60 p-6 md:p-8 mb-8">
            <h3 className="text-sm font-medium text-stone-800 mb-1">你的反馈</h3>
            <p className="text-xs text-stone-400 mb-5">
              写下你的问题、感悟、不理解的地方，或者你希望下一篇深入探讨的方向。
            </p>
            <textarea
              value={feedbackContent}
              onChange={(e) => { setFeedbackContent(e.target.value); setFeedbackSaved(false); }}
              placeholder="在这里写下你的反馈..."
              className="w-full border border-stone-200 rounded-lg p-3.5 text-sm resize-none h-32 transition-colors hover:border-stone-300 focus:border-emerald-600 outline-none mb-4"
            />
            <details className="mb-4">
              <summary className="text-xs text-stone-400 cursor-pointer hover:text-stone-600 transition-colors select-none">
                思考题回答（可选）
              </summary>
              <textarea
                value={thoughtAnswers}
                onChange={(e) => { setThoughtAnswers(e.target.value); setFeedbackSaved(false); }}
                placeholder="在这里写下你对思考题的回答..."
                className="w-full border border-stone-200 rounded-lg p-3.5 text-sm resize-none h-24 transition-colors hover:border-stone-300 focus:border-emerald-600 outline-none mt-3"
              />
            </details>
            <div className="flex items-center gap-3">
              <button
                onClick={handleSubmitFeedback}
                disabled={submittingFeedback}
                className="px-4 py-2 text-sm bg-stone-100 text-stone-600 rounded-lg hover:bg-stone-200 disabled:opacity-50 transition-all duration-200 cursor-pointer"
              >
                {submittingFeedback ? '保存中...' : '保存反馈'}
              </button>
              {feedbackSaved && (
                <span className="text-xs text-emerald-600 font-medium">已保存</span>
              )}
            </div>
          </div>

          {/* Error with retry */}
          {error && (
            <div className="mb-6 bg-rose-50 text-rose-600 text-sm px-4 py-2.5 rounded-lg border border-rose-100 flex items-center justify-between">
              <span>{error}</span>
              <button
                onClick={() => { setError(''); handleReadDone(); }}
                className="text-xs text-rose-700 underline hover:text-rose-900 ml-3 shrink-0"
              >
                重试
              </button>
            </div>
          )}

          {/* Generate next / streaming */}
          {generating ? (
            <div className="bg-white rounded-2xl border border-emerald-200/40 p-6 md:p-8">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-4 h-4 rounded-full border-2 border-stone-200 border-t-emerald-600 animate-spin" />
                <h3 className="text-xs font-medium text-emerald-700 uppercase tracking-wide">生成下一篇课文</h3>
              </div>
              {streamContent ? (
                <div className="prose prose-sm prose-stone max-w-none">
                  <Markdown>{streamContent}</Markdown>
                </div>
              ) : (
                <p className="text-stone-400 text-sm">AI 正在思考中...</p>
              )}
            </div>
          ) : (
            <button
              onClick={handleReadDone}
              className="w-full py-3.5 bg-emerald-600 text-white rounded-xl text-sm font-medium hover:bg-emerald-700 transition-all duration-200 cursor-pointer"
            >
              我读完了 — 生成下一篇
            </button>
          )}

          <p className="text-xs text-stone-300 text-center mt-4">
            提示：选中课文中的文字可以添加行内批注
          </p>
        </main>

        {/* Right sidebar — chapter nav (desktop: always visible, mobile: toggle) */}
        <aside className={`${showMobileNav ? 'fixed inset-0 z-40 bg-stone-950/30' : 'hidden'} lg:relative lg:block lg:bg-transparent`}>
          <div
            className={`${showMobileNav ? 'fixed right-0 top-0 h-full w-64 bg-white shadow-xl p-6 pt-16 overflow-y-auto z-50' : ''} lg:static lg:w-48 lg:shrink-0 lg:shadow-none lg:p-0`}
          >
            {showMobileNav && (
              <button
                onClick={() => setShowMobileNav(false)}
                className="absolute top-4 right-4 text-stone-400 hover:text-stone-600 lg:hidden"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
            <div className="lg:sticky lg:top-20">
              <h3 className="text-xs font-medium text-stone-400 uppercase tracking-wide mb-3">章节</h3>
              <nav className="space-y-0.5">
                <button
                  onClick={() => { navigate(`/course/${courseId}/syllabus`); setShowMobileNav(false); }}
                  className="w-full text-left px-3 py-2 rounded-lg text-sm text-stone-500 hover:bg-stone-100 hover:text-stone-700 transition-all duration-150 flex items-center gap-2.5 cursor-pointer"
                >
                  <span className="text-stone-300">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                    </svg>
                  </span>
                  <span>大纲</span>
                </button>

                {allLessons.map((l) => {
                  const isActive = l.number === currentNum;
                  return (
                    <button
                      key={l.id}
                      onClick={() => { navigate(`/course/${courseId}/lesson/${l.number}`); setShowMobileNav(false); }}
                      className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all duration-150 cursor-pointer ${
                        isActive
                          ? 'bg-stone-900 text-white'
                          : 'text-stone-500 hover:bg-stone-100 hover:text-stone-700'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <span className={`font-mono tabular-nums text-xs shrink-0 ${isActive ? 'text-stone-400' : 'text-stone-300'}`}>
                          {String(l.number).padStart(2, '0')}
                        </span>
                        <span className="truncate">
                          {l.title || `第 ${String(l.number).padStart(2, '0')} 篇`}
                        </span>
                        {l.is_evaluation && (
                          <span className={`text-[10px] ml-auto shrink-0 ${isActive ? 'text-amber-300' : 'text-amber-500'}`}>
                            评估
                          </span>
                        )}
                      </div>
                      {l.has_feedback && !isActive && (
                        <span className="ml-7 text-[10px] text-emerald-500">已反馈</span>
                      )}
                    </button>
                  );
                })}
              </nav>

              <div className="mt-6 pt-6 border-t border-stone-100 space-y-2">
                {annotations.length > 0 && (
                  <div className="px-3 py-1">
                    <span className="text-[10px] text-stone-300">
                      {annotations.length} 条批注
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
          {showMobileNav && (
            <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setShowMobileNav(false)} />
          )}
        </aside>
      </div>

      {/* Annotation popup */}
      {showAnnotation && (
        <div className="fixed inset-0 bg-stone-950/25 modal-backdrop flex items-center justify-center z-50 p-6">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-[0_20px_40px_-15px_rgba(0,0,0,0.1)] border border-stone-200/40">
            <h3 className="font-medium text-stone-800 text-sm mb-3">添加批注</h3>
            <p className="text-xs text-stone-400 mb-4 leading-relaxed">
              选中文本：{selectedText.length > 100 ? selectedText.slice(0, 100) + '...' : selectedText}
            </p>
            <textarea
              value={annotationComment}
              onChange={(e) => setAnnotationComment(e.target.value)}
              placeholder="写下你的困惑或想法..."
              className="w-full border border-stone-200 rounded-lg p-3 text-sm resize-none h-24 transition-colors hover:border-stone-300 focus:border-emerald-600 outline-none"
              autoFocus
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => { setShowAnnotation(false); setSelectedText(''); }}
                className="px-3 py-1.5 text-sm text-stone-500 hover:text-stone-700 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSaveAnnotation}
                disabled={!annotationComment.trim()}
                className="px-4 py-1.5 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40 transition-all duration-200 cursor-pointer"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
