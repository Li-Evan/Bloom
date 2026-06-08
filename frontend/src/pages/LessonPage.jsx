import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Markdown from '../components/Markdown';
import PdfViewer from '../components/PdfViewer';
import {
  getLesson, getLessons, getAnnotations, createAnnotation, deleteAnnotation,
  addAnnotationMessage, saveInterruptedAnnotation, submitFeedback, generateNextLesson, getFeedback, recordLessonOpened,
  getCourse,
} from '../lib/api';

const HL_SUPPORTED = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

// Character offset of (container, offset) within `root`'s plain text.
const charOffset = (root, container, offset) => {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(container, offset);
  return r.toString().length;
};

// Resolve a session's [start, end] offsets — prefer matching its original text
// (robust to legacy rows that stored placeholder offsets), fall back to stored offsets.
const locateOffsets = (root, session) => {
  const text = session.original_text || '';
  if (text) {
    const plain = root.textContent || '';
    let idx = plain.indexOf(text, Math.max(0, (session.position_start || 0) - 2));
    if (idx === -1) idx = plain.indexOf(text);
    if (idx !== -1) return [idx, idx + text.length];
  }
  if (session.position_end > session.position_start) return [session.position_start, session.position_end];
  return null;
};

// Rebuild a DOM Range from plain-text [start, end] offsets within `root`.
const rangeFromOffsets = (root, start, end) => {
  if (start == null || end == null || end <= start) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let count = 0, startNode = null, startOffset = 0, endNode = null, endOffset = 0, n;
  while ((n = walker.nextNode())) {
    const len = n.textContent.length;
    if (startNode === null && count + len > start) { startNode = n; startOffset = start - count; }
    if (count + len >= end) { endNode = n; endOffset = end - count; break; }
    count += len;
  }
  if (!startNode || !endNode) return null;
  try {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  } catch {
    return null;
  }
};

export default function LessonPage() {
  const { courseId, lessonNum } = useParams();
  const navigate = useNavigate();

  const [lesson, setLesson] = useState(null);
  const [course, setCourse] = useState(null);
  const [allLessons, setAllLessons] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [feedbackContent, setFeedbackContent] = useState('');
  const [thoughtAnswers, setThoughtAnswers] = useState('');
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [feedbackSaved, setFeedbackSaved] = useState(false);

  // Highlight Q&A sessions
  const [marker, setMarker] = useState(null);       // { top, left, selectedText, start, end } | null — pre-ask icon
  const [composer, setComposer] = useState(null);   // { top, selectedText, start, end, draft, saving } | null
  const [openId, setOpenId] = useState(null);       // expanded session id | null
  const [followDraft, setFollowDraft] = useState('');
  const [streaming, setStreaming] = useState(false);  // a highlight answer is streaming in
  const [streamText, setStreamText] = useState('');   // live streamed answer text
  const [tops, setTops] = useState({});             // session id -> px top within article (reflow-resilient)
  const [pdfTops, setPdfTops] = useState({});       // PDF session id -> px top within article, computed from geometric rects
  const [cardRect, setCardRect] = useState(null);   // { left, top, width, height } of the active overlay (drag + resize)

  const [generating, setGenerating] = useState(false);
  const [streamContent, setStreamContent] = useState('');
  const [showMobileNav, setShowMobileNav] = useState(false);

  const contentRef = useRef(null);   // <article>
  const proseRef = useRef(null);     // markdown content only (excludes overlay)
  const abortRef = useRef(null);     // AbortController for the active stream
  const streamTextRef = useRef('');  // mirror of streamText, read at abort time

  useEffect(() => {
    setLoading(true);
    setError('');
    setFeedbackSaved(false);
    setStreamContent('');
    setGenerating(false);
    setFeedbackContent('');
    setThoughtAnswers('');
    setMarker(null);
    setComposer(null);
    setOpenId(null);
    setFollowDraft('');
    setCardRect(null);
    setStreaming(false);
    setStreamText('');
    setTops({});
    setPdfTops({});

    Promise.all([
      getLesson(courseId, lessonNum),
      getAnnotations(courseId, lessonNum),
      getLessons(courseId),
      getFeedback(courseId, lessonNum),
      getCourse(courseId),
    ])
      .then(([l, a, all, fb, c]) => {
        setLesson(l);
        setCourse(c);
        setSessions(a);
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

  // Paint yellow highlights for saved sessions + recompute reflow-resilient dot positions.
  useEffect(() => {
    const article = contentRef.current;
    const prose = proseRef.current;
    if (!article || !prose) return;

    const compute = () => {
      const articleTop = article.getBoundingClientRect().top;
      const ranges = [];
      const nextTops = {};
      for (const s of sessions) {
        const off = locateOffsets(prose, s);
        const range = off ? rangeFromOffsets(prose, off[0], off[1]) : null;
        if (range) {
          ranges.push(range);
          nextTops[s.id] = Math.max(0, Math.round(range.getBoundingClientRect().top - articleTop));
        } else {
          nextTops[s.id] = s.anchor_top || 0;
        }
      }
      setTops(nextTops);
      if (HL_SUPPORTED) {
        if (ranges.length) CSS.highlights.set('bloom-ann', new Highlight(...ranges));
        else CSS.highlights.delete('bloom-ann');
      }
    };

    compute();
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('resize', compute);
      if (HL_SUPPORTED) CSS.highlights.delete('bloom-ann');
    };
  }, [sessions, lesson?.content]);

  // Paint a distinct highlight for the pending (being-asked) selection.
  useEffect(() => {
    if (!HL_SUPPORTED || !proseRef.current) return;
    const sel = composer || marker;
    const range = sel ? rangeFromOffsets(proseRef.current, sel.start, sel.end) : null;
    if (range) CSS.highlights.set('bloom-pending', new Highlight(range));
    else CSS.highlights.delete('bloom-pending');
    return () => { if (HL_SUPPORTED) CSS.highlights.delete('bloom-pending'); };
  }, [marker, composer, lesson?.content]);

  // Initial geometry for an overlay card anchored near `top`, docked to the article's right edge.
  const initRect = (top) => {
    const width = 340;
    const aw = contentRef.current?.clientWidth || 700;
    const left = Math.max(8, aw - width - 8);
    const height = Math.min(Math.round((window.innerHeight || 800) * 0.6), 460);
    return { left, top: Math.max(0, top), width, height };
  };

  const clearPendingSelection = () => {
    setMarker(null);
    setComposer(null);
    if (!openId) setCardRect(null);
  };

  const sessionTop = (session) => {
    if (!session) return 0;
    if (session.pdf_position) return pdfTops[session.id] ?? session.anchor_top ?? 0;
    return tops[session.id] ?? session.anchor_top ?? 0;
  };

  const openSession = (id) => {
    setMarker(null);
    setComposer(null);
    setFollowDraft('');
    setCardRect(initRect(sessionTop(sessions.find((s) => s.id === id))));
    setOpenId(id);
  };

  const openComposerFromMarker = () => {
    if (!marker) return;
    setOpenId(null);
    setCardRect(initRect(marker.top));
    setComposer({ ...marker, draft: '', saving: false });
    setMarker(null);
  };

  // Drag the active overlay by its header.
  const startDrag = (e) => {
    if (!cardRect) return;
    e.preventDefault();
    const start = { mx: e.clientX, my: e.clientY, left: cardRect.left, top: cardRect.top };
    const move = (ev) => setCardRect((r) => (r ? { ...r, left: start.left + ev.clientX - start.mx, top: Math.max(0, start.top + ev.clientY - start.my) } : r));
    const up = () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
    };
    // capture phase → the card's onMouseUp stopPropagation can't swallow these
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
  };

  // Resize the active overlay from any edge/corner. dir ∈ {n,s,e,w,ne,nw,se,sw}.
  const startResize = (dir, e) => {
    if (!cardRect) return;
    e.preventDefault();
    e.stopPropagation();
    const MIN_W = 260, MIN_H = 180;
    const start = { mx: e.clientX, my: e.clientY, ...cardRect };
    const move = (ev) => {
      const dx = ev.clientX - start.mx, dy = ev.clientY - start.my;
      let { left, top, width, height } = start;
      if (dir.includes('e')) width = Math.max(MIN_W, start.width + dx);
      if (dir.includes('s')) height = Math.max(MIN_H, start.height + dy);
      if (dir.includes('w')) { width = Math.max(MIN_W, start.width - dx); left = start.left + (start.width - width); }
      if (dir.includes('n')) { height = Math.max(MIN_H, start.height - dy); top = Math.max(0, start.top + (start.height - height)); }
      setCardRect({ left, top, width, height });
    };
    const up = () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
    };
    // capture phase → the card's onMouseUp stopPropagation can't swallow these
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
  };

  const handleTextSelect = () => {
    try {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) { clearPendingSelection(); return; }
      const text = selection.toString().trim();
      const range = selection.getRangeAt(0);
      // 用选区公共祖先判断是否落在课文区（跨浏览器更稳健）
      const node = range.commonAncestorContainer;
      const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
      if (!text || !proseRef.current?.contains(el)) { clearPendingSelection(); return; }
      const rect = range.getBoundingClientRect();
      const articleRect = contentRef.current.getBoundingClientRect();
      const top = Math.max(0, Math.round(rect.top - articleRect.top));
      const left = Math.max(8, Math.min(Math.round(rect.right - articleRect.left), Math.round(articleRect.width - 72)));
      const start = charOffset(proseRef.current, range.startContainer, range.startOffset);
      const end = start + text.length;
      setOpenId(null);
      setComposer(null);
      setMarker({ top, left, selectedText: text, start, end });
    } catch (e) {
      console.error('handleTextSelect failed', e);
    }
  };

  const handleCreateSession = async () => {
    if (!composer?.draft.trim() || streaming) return;
    const q = composer.draft.trim();
    const tempId = `tmp-${Date.now()}`;
    const pdfPos = composer.pdfPosition ? JSON.stringify(composer.pdfPosition) : null;
    const temp = {
      id: tempId,
      original_text: composer.selectedText,
      comment: q,
      anchor_top: composer.top,
      position_start: composer.start ?? 0,
      position_end: composer.end ?? composer.selectedText.length,
      pdf_position: pdfPos,
      messages: [{ role: 'user', content: q }],
    };
    setSessions((prev) => [...prev, temp]);
    setOpenId(tempId);
    setComposer(null);
    // keep cardRect from the composer so the card doesn't jump as it becomes the session
    setStreamText('');
    streamTextRef.current = '';
    setStreaming(true);
    setError('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      let finalAnn = null;
      await createAnnotation(
        courseId, lessonNum,
        {
          position_start: temp.position_start,
          position_end: temp.position_end,
          original_text: temp.original_text,
          comment: q,
          answer_immediately: true,
          anchor_top: temp.anchor_top,
          pdf_position: pdfPos,
        },
        (chunk) => { streamTextRef.current += chunk; setStreamText((t) => t + chunk); },
        (data) => { finalAnn = data.annotation; },
        controller.signal,
      );
      if (finalAnn) {
        setSessions((prev) => prev.map((s) => (s.id === tempId ? finalAnn : s)));
        setOpenId(finalAnn.id);
      } else {
        setSessions((prev) => prev.filter((s) => s.id !== tempId));
        setOpenId(null);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        const partial = streamTextRef.current.trim();
        if (partial) {
          try {
            const ann = await saveInterruptedAnnotation(courseId, lessonNum, {
              position_start: temp.position_start,
              position_end: temp.position_end,
              original_text: temp.original_text,
              comment: q,
              anchor_top: temp.anchor_top,
              pdf_position: pdfPos,
              partial_answer: streamTextRef.current,
            });
            setSessions((prev) => prev.map((s) => (s.id === tempId ? ann : s)));
            setOpenId(ann.id);
          } catch {
            setSessions((prev) => prev.map((s) => (s.id === tempId
              ? { ...s, messages: [...s.messages, { role: 'assistant', content: streamTextRef.current }] }
              : s)));
          }
        } else {
          setSessions((prev) => prev.filter((s) => s.id !== tempId));
          setOpenId(null);
        }
      } else {
        setError(err.message);
        setSessions((prev) => prev.filter((s) => s.id !== tempId));
        setOpenId(null);
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
      setStreamText('');
    }
  };

  const handleFollowUp = async (sessionId) => {
    if (!followDraft.trim() || streaming) return;
    const q = followDraft.trim();
    setFollowDraft('');
    // optimistically show the user's question; reverted if the request fails
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, messages: [...s.messages, { role: 'user', content: q }] } : s)));
    setStreamText('');
    streamTextRef.current = '';
    setStreaming(true);
    setError('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      let finalAnn = null;
      await addAnnotationMessage(
        courseId, lessonNum, sessionId, q,
        (chunk) => { streamTextRef.current += chunk; setStreamText((t) => t + chunk); },
        (data) => { finalAnn = data.annotation; },
        controller.signal,
      );
      if (finalAnn) {
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? finalAnn : s)));
      } else {
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, messages: s.messages.slice(0, -1) } : s)));
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        const partial = streamTextRef.current.trim();
        if (partial) {
          try {
            const ann = await saveInterruptedAnnotation(courseId, lessonNum, {
              annotation_id: sessionId,
              question: q,
              partial_answer: streamTextRef.current,
            });
            setSessions((prev) => prev.map((s) => (s.id === sessionId ? ann : s)));
          } catch {
            setSessions((prev) => prev.map((s) => (s.id === sessionId
              ? { ...s, messages: [...s.messages, { role: 'assistant', content: streamTextRef.current }] }
              : s)));
          }
        } else {
          setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, messages: s.messages.slice(0, -1) } : s)));
        }
      } else {
        setError(err.message);
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, messages: s.messages.slice(0, -1) } : s)));
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
      setStreamText('');
    }
  };

  const handleStopStreaming = () => {
    abortRef.current?.abort();
  };

  const handleDeleteSession = async (id) => {
    try {
      await deleteAnnotation(courseId, lessonNum, id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (openId === id) setOpenId(null);
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
  const isSourceLesson = Boolean(lesson?.is_source);
  const isProject = Boolean(course?.is_project);
  const isPdf = Boolean(lesson?.source_filename?.toLowerCase().endsWith('.pdf'));
  const fileUrl = `/api/courses/${courseId}/lessons/${lessonNum}/file`;
  const handlePdfSelect = ({ text, position, clientRect }) => {
    const articleRect = contentRef.current?.getBoundingClientRect();
    if (!articleRect || !clientRect) return;
    const top = Math.max(0, Math.round(clientRect.top - articleRect.top));
    const left = Math.max(8, Math.min(Math.round(clientRect.right - articleRect.left), Math.round(articleRect.width - 72)));
    setOpenId(null);
    setComposer(null);
    setMarker({
      top,
      left,
      selectedText: text,
      start: 0,
      end: text.length,
      pdfPosition: position,
    });
  };
  const handleOpenPdfHighlight = (id) => {
    setMarker(null);
    setComposer(null);
    setFollowDraft('');
    setCardRect(initRect(sessionTop(sessions.find((s) => s.id === id))));
    setOpenId(id);
  };
  const handlePdfHighlightTops = useCallback((nextTops) => {
    setPdfTops((prev) => {
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(nextTops);
      if (
        prevKeys.length === nextKeys.length
        && nextKeys.every((key) => prev[key] === nextTops[key])
      ) return prev;
      return nextTops;
    });
  }, []);
  const pendingPdfHighlight = isPdf && (composer?.pdfPosition || marker?.pdfPosition)
    ? [{ id: '__pending-pdf', position: composer?.pdfPosition || marker?.pdfPosition, pending: true }]
    : [];
  const pdfHighlights = isPdf
    ? [
        ...sessions.flatMap((s) => {
          if (!s.pdf_position) return [];
          try { return [{ id: s.id, position: JSON.parse(s.pdf_position) }]; } catch { return []; }
        }),
        ...pendingPdfHighlight,
      ]
    : [];

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
            className={`relative bg-white rounded-2xl border border-stone-200/60 shadow-[0_1px_3px_rgba(0,0,0,0.04)] mb-8 ${isPdf ? 'overflow-hidden p-0' : 'p-8 md:p-10'}`}
          >
            {isPdf ? (
              <PdfViewer
                url={fileUrl}
                highlights={pdfHighlights}
                onSelect={handlePdfSelect}
                onOpenHighlight={handleOpenPdfHighlight}
                onHighlightTops={handlePdfHighlightTops}
                onClearSelection={clearPendingSelection}
              />
            ) : (
              <div ref={proseRef} className="prose prose-stone prose-lg max-w-none">
                <Markdown>{lesson?.content}</Markdown>
              </div>
            )}

            {/* After selecting text → a small icon appears; click it to open the question box */}
            {marker && (
              <button
                onMouseUp={(e) => e.stopPropagation()}
                onClick={openComposerFromMarker}
                title="向 AI 提问"
                style={{ top: Math.max(0, marker.top - 30), left: marker.left }}
                className="absolute z-40 flex items-center gap-1 pl-1.5 pr-2 py-1 rounded-full bg-amber-400 text-stone-900 text-[11px] font-medium shadow-[0_4px_12px_-2px_rgba(180,120,0,0.4)] hover:bg-amber-300 hover:-translate-y-0.5 transition-all anim-pop cursor-pointer"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 011.037-.443 48.282 48.282 0 005.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.019z" />
                </svg>
                提问
              </button>
            )}

            {/* Minimized session dots — line into the margin + a clickable dot */}
            {sessions.map((s) => (
              openId === s.id ? null : (
                <button
                  key={`dot-${s.id}`}
                  onClick={() => openSession(s.id)}
                  onMouseUp={(e) => e.stopPropagation()}
                  title={s.comment}
                  className="absolute z-20 flex items-center group/dot"
                  style={{ top: Math.max(0, sessionTop(s) - 6), right: 6 }}
                >
                  <span className="w-5 h-px bg-amber-300 mr-1 group-hover/dot:bg-amber-400 transition-colors" />
                  <span className="w-3 h-3 rounded-full bg-emerald-500 ring-4 ring-emerald-100/70 group-hover/dot:scale-125 transition-transform" />
                </button>
              )
            ))}

            {/* New-session composer (draggable) */}
            {composer && (
              <div
                onMouseUp={(e) => e.stopPropagation()}
                style={cardRect ? { left: cardRect.left, top: cardRect.top, width: cardRect.width } : { top: composer.top, right: 8, width: 340 }}
                className="absolute z-50 max-w-[calc(100%-1rem)] bg-white rounded-xl border border-emerald-200 shadow-[0_12px_30px_-10px_rgba(0,0,0,0.18)] p-4 anim-pop"
              >
                <div onMouseDown={startDrag} className="flex items-center justify-between mb-2 cursor-move select-none">
                  <span className="text-xs font-medium text-emerald-700">划线提问</span>
                  <button onMouseDown={(e) => e.stopPropagation()} onClick={() => { setComposer(null); setCardRect(null); }} className="text-stone-300 hover:text-stone-500 transition-colors p-0.5">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <p className="text-[11px] text-stone-400 mb-2.5 leading-relaxed border-l-2 border-amber-300 pl-2">
                  {composer.selectedText.length > 90 ? composer.selectedText.slice(0, 90) + '...' : composer.selectedText}
                </p>
                <textarea
                  value={composer.draft}
                  onChange={(e) => setComposer((c) => ({ ...c, draft: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      if (composer.draft.trim()) handleCreateSession();
                    }
                  }}
                  placeholder="针对这段话提一个问题..."
                  autoFocus
                  className="w-full border border-stone-200 rounded-lg p-2.5 text-sm resize-none h-20 transition-colors hover:border-stone-300 focus:border-emerald-600 outline-none"
                />
                <div className="flex justify-end gap-2 mt-2">
                  <button onClick={() => { setComposer(null); setCardRect(null); }} className="px-3 py-1.5 text-xs text-stone-500 hover:text-stone-700 transition-colors">取消</button>
                  <button
                    onClick={handleCreateSession}
                    disabled={!composer.draft.trim()}
                    className="px-3 py-1.5 text-xs bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40 transition-all duration-200 cursor-pointer"
                  >
                    提问
                  </button>
                </div>
              </div>
            )}

            {/* Expanded session — multi-turn Q&A (draggable) */}
            {sessions.map((s) => (
              openId === s.id ? (
                <div
                  key={`open-${s.id}`}
                  onMouseUp={(e) => e.stopPropagation()}
                  style={cardRect
                    ? { left: cardRect.left, top: cardRect.top, width: cardRect.width, height: cardRect.height }
                    : { top: sessionTop(s), right: 8, width: 340, height: 440 }}
                  className="absolute z-50 max-w-[calc(100%-1rem)] bg-white rounded-xl border border-emerald-200 shadow-[0_12px_30px_-10px_rgba(0,0,0,0.18)] flex flex-col anim-pop"
                >
                  <div onMouseDown={startDrag} className="flex items-center justify-between px-4 py-2.5 border-b border-stone-100 shrink-0 cursor-move select-none">
                    <span className="text-xs font-medium text-emerald-700">划线追问</span>
                    <div className="flex items-center gap-0.5">
                      <button onMouseDown={(e) => e.stopPropagation()} onClick={() => handleDeleteSession(s.id)} title="删除这条提问" className="text-stone-300 hover:text-rose-500 transition-colors p-1">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.02-2.09 2.201v.916" />
                        </svg>
                      </button>
                      <button onMouseDown={(e) => e.stopPropagation()} onClick={() => { setOpenId(null); setCardRect(null); }} title="缩小到旁边" className="text-stone-300 hover:text-stone-600 transition-colors p-1">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12h-15" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <div className="px-4 py-3 overflow-y-auto flex-1 min-h-0">
                    <p className="text-[11px] text-stone-400 mb-3 leading-relaxed border-l-2 border-amber-200 pl-2">
                      {s.original_text.length > 120 ? s.original_text.slice(0, 120) + '...' : s.original_text}
                    </p>
                    <div className="space-y-3">
                      {s.messages.map((m, i) => (
                        m.role === 'user' ? (
                          <div key={i} className="flex justify-end">
                            <div className="bg-stone-100 text-stone-700 text-sm rounded-2xl rounded-br-sm px-3 py-2 max-w-[88%] whitespace-pre-wrap">{m.content}</div>
                          </div>
                        ) : (
                          <div key={i} className="prose prose-sm prose-stone max-w-none border-l-2 border-emerald-200 pl-3">
                            <Markdown>{m.content}</Markdown>
                          </div>
                        )
                      ))}
                      {streaming && openId === s.id && (
                        streamText ? (
                          <div className="prose prose-sm prose-stone max-w-none border-l-2 border-emerald-200 pl-3">
                            <Markdown>{streamText}</Markdown>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 text-xs text-stone-400 pl-3">
                            <span className="w-3 h-3 rounded-full border-2 border-stone-200 border-t-emerald-600 animate-spin" />
                            AI 正在回答...
                          </div>
                        )
                      )}
                    </div>
                  </div>
                  <div className="px-3 py-2.5 border-t border-stone-100 flex items-end gap-2 shrink-0">
                    <textarea
                      value={followDraft}
                      onChange={(e) => setFollowDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); handleFollowUp(s.id); } }}
                      placeholder="继续追问..."
                      rows={1}
                      className="flex-1 min-w-0 border border-stone-200 rounded-lg px-3 py-2 text-sm resize-none transition-colors hover:border-stone-300 focus:border-emerald-600 outline-none max-h-24"
                    />
                    {streaming ? (
                      <button
                        onClick={handleStopStreaming}
                        className="px-3 py-2 text-xs bg-rose-50 text-rose-600 border border-rose-200 rounded-lg hover:bg-rose-100 shrink-0 transition-all duration-200 cursor-pointer inline-flex items-center gap-1.5"
                      >
                        <span className="w-2.5 h-2.5 rounded-[2px] bg-rose-500" />
                        停止
                      </button>
                    ) : (
                      <button
                        onClick={() => handleFollowUp(s.id)}
                        disabled={!followDraft.trim()}
                        className="px-3 py-2 text-xs bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40 shrink-0 transition-all duration-200 cursor-pointer"
                      >
                        发送
                      </button>
                    )}
                  </div>

                  {/* Resize handles — drag any edge or corner */}
                  <div onMouseDown={(e) => startResize('n', e)} className="absolute -top-1 left-3 right-3 h-2 cursor-ns-resize" />
                  <div onMouseDown={(e) => startResize('s', e)} className="absolute -bottom-1 left-3 right-3 h-2 cursor-ns-resize" />
                  <div onMouseDown={(e) => startResize('w', e)} className="absolute -left-1 top-3 bottom-3 w-2 cursor-ew-resize" />
                  <div onMouseDown={(e) => startResize('e', e)} className="absolute -right-1 top-3 bottom-3 w-2 cursor-ew-resize" />
                  <div onMouseDown={(e) => startResize('nw', e)} className="absolute -top-1 -left-1 w-3.5 h-3.5 cursor-nwse-resize" />
                  <div onMouseDown={(e) => startResize('ne', e)} className="absolute -top-1 -right-1 w-3.5 h-3.5 cursor-nesw-resize" />
                  <div onMouseDown={(e) => startResize('sw', e)} className="absolute -bottom-1 -left-1 w-3.5 h-3.5 cursor-nesw-resize" />
                  <div onMouseDown={(e) => startResize('se', e)} className="absolute -bottom-1 -right-1 w-3.5 h-3.5 cursor-nwse-resize" />
                </div>
              ) : null
            ))}
          </article>

          {/* Feedback section */}
          {!isProject && (
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
            {!isSourceLesson && (
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
            )}
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
          )}

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
          {!isProject && (generating ? (
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
              {isSourceLesson ? '我读完原文了 — 生成下一篇' : '我读完了 — 生成下一篇'}
            </button>
          ))}

          <p className="text-xs text-stone-300 text-center mt-4">
            提示：选中文字后点冒出的「提问」图标向 AI 发问（划线处会标黄）；窗口可拖动，缩小后点右侧小圆点重新打开
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
              <h3 className="text-xs font-medium text-stone-400 uppercase tracking-wide mb-3">{isProject ? '文件' : '章节'}</h3>
              <nav className="space-y-0.5">
                {!isProject && (
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
                )}

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
                          {(isProject && l.source_filename) || l.title || `第 ${String(l.number).padStart(2, '0')} 篇`}
                        </span>
                        {l.is_source && (
                          <span className={`text-[10px] ml-auto shrink-0 ${isActive ? 'text-amber-300' : 'text-amber-500'}`}>
                            原文
                          </span>
                        )}
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
                {sessions.length > 0 && (
                  <div className="px-3 py-1">
                    <span className="text-[10px] text-stone-300">
                      {sessions.length} 个划线提问
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
    </div>
  );
}
