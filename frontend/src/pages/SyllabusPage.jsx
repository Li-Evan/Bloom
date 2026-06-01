import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Markdown from '../components/Markdown';
import { getCourse, getLessons } from '../lib/api';

export default function SyllabusPage() {
  const { courseId } = useParams();
  const navigate = useNavigate();

  const [course, setCourse] = useState(null);
  const [allLessons, setAllLessons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([getCourse(courseId), getLessons(courseId)])
      .then(([c, l]) => {
        setCourse(c);
        setAllLessons(l.filter((x) => x.number > 0));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [courseId]);

  if (loading) {
    return (
      <div className="min-h-[100dvh] bg-stone-50">
        <header className="bg-stone-900 sticky top-0 z-10">
          <div className="max-w-[1200px] mx-auto px-6 py-3.5" />
        </header>
        <div className="max-w-[1200px] mx-auto px-6 py-10 flex gap-8">
          <main className="flex-1 min-w-0">
            <div className="bg-white rounded-2xl border border-stone-200/60 p-8 md:p-10">
              <div className="skeleton h-7 rounded-lg w-2/5 mb-6" />
              <div className="space-y-3">
                <div className="skeleton h-4 rounded w-full" />
                <div className="skeleton h-4 rounded w-full" />
                <div className="skeleton h-4 rounded w-3/4" />
                <div className="h-4" />
                <div className="skeleton h-4 rounded w-full" />
                <div className="skeleton h-4 rounded w-full" />
                <div className="skeleton h-4 rounded w-1/2" />
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

  if (error) {
    return (
      <div className="min-h-[100dvh] bg-stone-50 flex flex-col items-center justify-center gap-4">
        <p className="text-rose-500 text-sm">{error}</p>
        <button onClick={() => navigate(`/course/${courseId}`)} className="text-emerald-600 hover:text-emerald-700 text-sm font-medium transition-colors">
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
          <span className="text-xs text-stone-500 font-mono">SYLLABUS</span>
        </div>
      </header>

      <div className="max-w-[1200px] mx-auto px-6 py-10 flex gap-8">
        {/* Main content */}
        <main className="flex-1 min-w-0">
          <article className="bg-white rounded-2xl border border-stone-200/60 shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-8 md:p-10">
            <div className="prose prose-stone prose-lg max-w-none">
              <Markdown>{course?.syllabus_content}</Markdown>
            </div>
          </article>
        </main>

        {/* Right sidebar — chapter nav (same as LessonPage) */}
        <aside className="hidden lg:block w-48 shrink-0">
          <div className="sticky top-20">
            <h3 className="text-xs font-medium text-stone-400 uppercase tracking-wide mb-3">章节</h3>
            <nav className="space-y-0.5">
              {/* Syllabus — active */}
              <div className="w-full text-left px-3 py-2 rounded-lg text-sm bg-stone-900 text-white flex items-center gap-2.5">
                <span className="font-mono tabular-nums text-xs text-stone-400">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                  </svg>
                </span>
                <span>大纲</span>
              </div>

              {allLessons.map((l) => (
                <button
                  key={l.id}
                  onClick={() => navigate(`/course/${courseId}/lesson/${l.number}`)}
                  className="w-full text-left px-3 py-2 rounded-lg text-sm text-stone-500 hover:bg-stone-100 hover:text-stone-700 transition-all duration-150 flex items-center gap-2.5 cursor-pointer"
                >
                  <span className="font-mono tabular-nums text-xs text-stone-300">
                    {String(l.number).padStart(2, '0')}
                  </span>
                  <span>第 {String(l.number).padStart(2, '0')} 篇</span>
                  {l.is_evaluation && (
                    <span className="text-[10px] ml-auto text-amber-500">评估</span>
                  )}
                </button>
              ))}
            </nav>
          </div>
        </aside>
      </div>
    </div>
  );
}
