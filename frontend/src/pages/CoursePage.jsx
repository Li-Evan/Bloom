import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Markdown from '../components/Markdown';
import { getCourse, getLessons, getSummary } from '../lib/api';

export default function CoursePage() {
  const { courseId } = useParams();
  const navigate = useNavigate();
  const [course, setCourse] = useState(null);
  const [lessons, setLessons] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([getCourse(courseId), getLessons(courseId)])
      .then(([c, l]) => {
        setCourse(c);
        setLessons(l);
        if (c.status === 'completed') {
          getSummary(courseId).then(setSummary).catch(() => {});
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [courseId]);

  if (loading) {
    return (
      <div className="min-h-[100dvh] bg-stone-50">
        <header className="bg-stone-900 sticky top-0 z-10">
          <div className="max-w-[720px] mx-auto px-6 py-3.5" />
        </header>
        <main className="max-w-[720px] mx-auto px-6 py-10">
          <div className="mb-10">
            <div className="skeleton h-8 rounded-lg w-2/5 mb-4" />
            <div className="flex items-center gap-4">
              <div className="skeleton h-5 rounded-full w-16" />
              <div className="skeleton h-4 rounded w-14" />
            </div>
          </div>
          <div className="skeleton h-3 rounded w-10 mb-4" />
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="bg-white rounded-xl px-5 py-4 border border-stone-200/60 flex items-center gap-4 mb-2">
              <div className="skeleton w-10 h-10 rounded-xl shrink-0" />
              <div className="flex-1">
                <div className="skeleton h-4 rounded w-24 mb-1.5" />
                <div className="skeleton h-3 rounded w-16" />
              </div>
            </div>
          ))}
        </main>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-[100dvh] bg-stone-50 flex flex-col items-center justify-center gap-4">
        <p className="text-rose-500 text-sm">{error}</p>
        <button onClick={() => navigate('/')} className="text-emerald-600 hover:text-emerald-700 text-sm font-medium transition-colors">
          返回首页
        </button>
      </div>
    );
  }

  const normalLessons = lessons.filter((l) => l.number > 0);
  const isCompleted = course.status === 'completed';

  return (
    <div className="min-h-[100dvh] bg-stone-50">
      {/* Header */}
      <header className="bg-stone-900 sticky top-0 z-10">
        <div className="max-w-[720px] mx-auto px-6 py-3.5 flex items-center justify-between">
          <button
            onClick={() => navigate('/')}
            className="text-stone-400 hover:text-white text-sm transition-colors flex items-center gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
            返回
          </button>
          <span className="text-xs text-stone-500 font-mono">
            {isCompleted ? 'COMPLETED' : 'IN PROGRESS'}
          </span>
        </div>
      </header>

      <main className="max-w-[720px] mx-auto px-6 py-10">
        {/* Course hero */}
        <div className="mb-10">
          <h1 className="text-3xl font-semibold tracking-tight text-stone-900">{course.name}</h1>
          <div className="flex items-center gap-4 mt-3">
            <span className={`text-xs px-2.5 py-1 rounded-full border ${
              isCompleted
                ? 'bg-emerald-50 text-emerald-600 border-emerald-100'
                : 'bg-stone-50 text-stone-500 border-stone-100'
            }`}>
              {isCompleted ? '已完成' : '学习中'}
            </span>
            <span className="text-sm text-stone-400">
              <span className="font-mono tabular-nums">{normalLessons.length}</span> 篇课文
            </span>
            <span className="text-sm text-stone-300 font-mono tabular-nums">
              {new Date(course.created_at).toLocaleDateString('zh-CN')}
            </span>
          </div>

          {/* Mastery progress bar */}
          {course.mastery_progress !== undefined && (
            <div className="mt-4">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-stone-400">掌握进度</span>
                <span className="text-xs font-mono tabular-nums text-stone-500">
                  {Math.round(course.mastery_progress * 100)}%
                </span>
              </div>
              <div className="w-full h-1.5 bg-stone-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                  style={{ width: `${Math.round(course.mastery_progress * 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Lesson list (syllabus as first item) */}
        <div className="mb-8">
          <h2 className="text-xs font-medium text-stone-400 uppercase tracking-wide mb-4">目录</h2>

          {/* Syllabus entry — same style as lesson cards */}
          {course.syllabus_content && (
            <button
              onClick={() => navigate(`/course/${courseId}/syllabus`)}
              className="w-full bg-white rounded-xl px-5 py-4 text-left border border-stone-200/60 hover:border-stone-300 hover:shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)] transition-all duration-200 group cursor-pointer flex items-center justify-between mb-2"
            >
              <div className="flex items-center gap-4">
                <span className="w-10 h-10 rounded-xl bg-emerald-600 flex items-center justify-center shrink-0">
                  <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                  </svg>
                </span>
                <div>
                  <span className="font-medium text-stone-700 text-sm group-hover:text-stone-900 transition-colors block">课程大纲</span>
                  <span className="text-xs text-stone-400">掌握项与学习进度</span>
                </div>
              </div>
              <svg className="w-4 h-4 text-stone-300 group-hover:text-stone-500 group-hover:translate-x-0.5 transition-all" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
              </svg>
            </button>
          )}

          {normalLessons.length === 0 ? (
            <div className="py-16 text-center bg-white rounded-xl border border-stone-200/60">
              <div className="w-10 h-10 rounded-full bg-stone-50 mx-auto mb-3 flex items-center justify-center">
                <svg className="w-5 h-5 text-stone-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
              </div>
              <p className="text-stone-400 text-sm">暂无课文</p>
            </div>
          ) : (
            <div className="space-y-2">
              {normalLessons.map((lesson) => (
                <button
                  key={lesson.id}
                  onClick={() => navigate(`/course/${courseId}/lesson/${lesson.number}`)}
                  className="w-full bg-white rounded-xl px-5 py-4 text-left border border-stone-200/60 hover:border-stone-300 hover:shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)] transition-all duration-200 group cursor-pointer flex items-center justify-between"
                >
                  <div className="flex items-center gap-4">
                    <span className="w-10 h-10 rounded-xl bg-stone-900 flex items-center justify-center text-xs font-mono text-white font-medium shrink-0">
                      {String(lesson.number).padStart(2, '0')}
                    </span>
                    <div className="min-w-0">
                      <span className="font-medium text-stone-700 text-sm group-hover:text-stone-900 transition-colors block truncate">
                        {lesson.title || `第 ${String(lesson.number).padStart(2, '0')} 篇`}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-stone-400 font-mono tabular-nums">
                          {new Date(lesson.created_at).toLocaleDateString('zh-CN')}
                        </span>
                        {lesson.has_feedback && (
                          <span className="text-[10px] text-emerald-500">已反馈</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {lesson.is_evaluation && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 border border-amber-100">
                        评估篇
                      </span>
                    )}
                    <svg className="w-4 h-4 text-stone-300 group-hover:text-stone-500 group-hover:translate-x-0.5 transition-all" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                    </svg>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Summary section */}
        {summary && (
          <div className="mb-8">
            <h2 className="text-xs font-medium text-emerald-600 uppercase tracking-wide mb-4">课程总结</h2>
            <div className="bg-white rounded-xl border border-emerald-200/40 p-6">
              <div className="prose prose-sm prose-stone max-w-none">
                <Markdown>{summary.content}</Markdown>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
