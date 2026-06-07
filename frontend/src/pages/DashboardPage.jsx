import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import RecommendationPanel from '../components/RecommendationPanel';
import {
  getCourses,
  createCourse,
  createSourceCourse,
  deleteCourse,
  getGlobalStats,
  getRecommendations,
  refreshRecommendations,
  saveRecommendation,
  removeSavedRecommendation,
  startRecommendation,
} from '../lib/api';

// 创建是阻塞式的（串行两次 LLM），前端拿不到真实进度，用阶段文案 + 伪进度营造前进感
const LOADING_MESSAGES = [
  '正在分析课题与参考材料…',
  '正在设计课程大纲…',
  '正在编写第一课…',
  '即将完成，正在收尾…',
];

const LEARNING_DEPTH_OPTIONS = [
  { value: 'simple', label: '简单', hint: '主干路径' },
  { value: 'standard', label: '标准', hint: '完整掌握' },
  { value: 'deep', label: '深入', hint: '原理展开' },
];

export default function DashboardPage() {
  const [courses, setCourses] = useState([]);
  const [stats, setStats] = useState(null);
  const [recommendations, setRecommendations] = useState([]);
  const [savedRecommendations, setSavedRecommendations] = useState([]);
  const [newCourseName, setNewCourseName] = useState('');
  const [newCourseRef, setNewCourseRef] = useState('');
  const [learningDepth, setLearningDepth] = useState('standard');
  const [createMode, setCreateMode] = useState('topic');
  const [sourceFile, setSourceFile] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [progress, setProgress] = useState(0);
  const [refreshingRecommendations, setRefreshingRecommendations] = useState(false);
  const [startingRecommendationId, setStartingRecommendationId] = useState(null);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;

    async function loadInitialData() {
      try {
        const [c, s, r] = await Promise.all([getCourses(), getGlobalStats(), getRecommendations()]);
        if (cancelled) return;
        setCourses(c);
        setStats(s);
        setRecommendations(r.recommendations || []);
        setSavedRecommendations(r.saved || []);
        setLoading(false);

        if (c.length > 0 && (r.recommendations || []).length === 0) {
          setRefreshingRecommendations(true);
          try {
            const data = await refreshRecommendations();
            if (cancelled) return;
            setRecommendations(data.recommendations || []);
            setSavedRecommendations(data.saved || []);
          } catch (err) {
            if (!cancelled) setError(err.message);
          } finally {
            if (!cancelled) setRefreshingRecommendations(false);
          }
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadInitialData();
    return () => { cancelled = true; };
  }, []);

  // 创建中：阶段文案轮播 + 伪进度（趋近 92% 封顶，成功后整页跳转，无需归零）
  useEffect(() => {
    if (!creating) { setLoadingStep(0); setProgress(0); return; }
    const msgTimer = setInterval(() => {
      setLoadingStep((s) => Math.min(s + 1, LOADING_MESSAGES.length - 1));
    }, 3500);
    const progTimer = setInterval(() => {
      setProgress((p) => (p < 92 ? p + (92 - p) * 0.06 : p));
    }, 350);
    return () => { clearInterval(msgTimer); clearInterval(progTimer); };
  }, [creating]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (creating) return;
    if (createMode === 'topic' && !newCourseName.trim()) return;
    if (createMode === 'source' && !sourceFile) {
      setError('请先选择 PDF、TXT 或 MD 文件');
      return;
    }
    setError('');
    setCreating(true);
    try {
      const sourceName = sourceFile?.name?.replace(/\.[^.]+$/, '') || '';
      const course = createMode === 'source'
        ? await createSourceCourse(newCourseName.trim() || sourceName, sourceFile, learningDepth)
        : await createCourse(newCourseName.trim(), newCourseRef.trim(), learningDepth);
      setCourses([course, ...courses]);
      setNewCourseName('');
      setNewCourseRef('');
      setSourceFile(null);
      setShowCreate(false);
      navigate(`/course/${course.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  async function handleRefreshRecommendations() {
    if (refreshingRecommendations) return;
    setError('');
    setRefreshingRecommendations(true);
    try {
      const data = await refreshRecommendations();
      setRecommendations(data.recommendations || []);
      setSavedRecommendations(data.saved || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setRefreshingRecommendations(false);
    }
  }

  const handleSaveRecommendation = async (item) => {
    try {
      const saved = await saveRecommendation(item.id);
      setRecommendations((prev) => prev.filter((rec) => rec.id !== item.id));
      setSavedRecommendations((prev) => [saved, ...prev.filter((rec) => rec.id !== item.id)]);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRemoveSavedRecommendation = async (item) => {
    try {
      await removeSavedRecommendation(item.id);
      setSavedRecommendations((prev) => prev.filter((rec) => rec.id !== item.id));
    } catch (err) {
      setError(err.message);
    }
  };

  const handleStartRecommendation = async (item) => {
    if (creating) return;
    setError('');
    setStartingRecommendationId(item.id);
    setCreating(true);
    try {
      const reference = [
        `推荐理由：${item.rationale}`,
        item.bridge ? `已学连接：${item.bridge}` : '',
        item.source_topics?.length ? `相关已学主题：${item.source_topics.join('、')}` : '',
      ].filter(Boolean).join('\n');
      const course = await createCourse(item.title, reference);
      await startRecommendation(item.id, course.id);
      setCourses((prev) => [course, ...prev]);
      setRecommendations((prev) => prev.filter((rec) => rec.id !== item.id));
      setSavedRecommendations((prev) => prev.filter((rec) => rec.id !== item.id));
      navigate(`/course/${course.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
      setStartingRecommendationId(null);
    }
  };

  const handleDelete = async (e, courseId) => {
    e.stopPropagation();
    if (!confirm('确定删除这个课程吗？所有课文和批注都将丢失。')) return;
    try {
      await deleteCourse(courseId);
      setCourses((prev) => prev.filter((c) => c.id !== courseId));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-stone-50">
      {/* Creating overlay — full-screen loading */}
      {creating && (
        <div className="fixed inset-0 z-50 bg-stone-950/40 modal-backdrop flex items-center justify-center p-6">
          <div className="bg-white rounded-2xl p-8 max-w-sm w-full shadow-[0_20px_50px_-12px_rgba(0,0,0,0.25)] border border-stone-200/40 text-center">
            <div className="w-11 h-11 rounded-full border-[3px] border-stone-200 border-t-emerald-600 animate-spin mx-auto mb-5" />
            <h3 className="text-base font-semibold text-stone-900 mb-1.5">正在为你定制课程</h3>
            <p className="text-sm text-stone-500 mb-6 min-h-[20px] transition-opacity duration-300">
              {LOADING_MESSAGES[loadingStep]}
            </p>
            <div className="w-full h-1.5 bg-stone-100 rounded-full overflow-hidden mb-2.5">
              <div
                className="h-full bg-emerald-500 rounded-full transition-[width] duration-500 ease-out"
                style={{ width: `${Math.round(progress)}%` }}
              />
            </div>
            <p className="text-xs text-stone-400">AI 串行生成大纲与第一课 · 约 20–60 秒</p>
          </div>
        </div>
      )}
      {/* Header — dark */}
      <header className="bg-stone-900 sticky top-0 z-10">
        <div className="max-w-[1100px] mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-base font-semibold text-white tracking-tight">Bloom</h1>
            <span className="text-stone-600 text-xs font-mono">2-Sigma Learning</span>
          </div>
        </div>
      </header>

      <main className="max-w-[1100px] mx-auto px-6 py-10">
        {/* Page title + action */}
        <div className="flex items-end justify-between mb-8">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-stone-900">我的课程</h2>
            <p className="text-sm text-stone-400 mt-1">点击课程卡片进入学习</p>
          </div>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-emerald-700 transition-all duration-200 cursor-pointer"
          >
            新建课程
          </button>
        </div>

        {/* Learning Stats */}
        {stats && (stats.total_courses > 0) && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
            <div className="bg-white rounded-xl border border-stone-200/60 p-4">
              <p className="text-2xl font-semibold text-stone-900 tabular-nums">{stats.total_lessons_read}</p>
              <p className="text-xs text-stone-400 mt-1">已学课文</p>
            </div>
            <div className="bg-white rounded-xl border border-stone-200/60 p-4">
              <p className="text-2xl font-semibold text-stone-900 tabular-nums">{stats.total_annotations}</p>
              <p className="text-xs text-stone-400 mt-1">批注数</p>
            </div>
            <div className="bg-white rounded-xl border border-stone-200/60 p-4">
              <p className="text-2xl font-semibold text-stone-900 tabular-nums">{stats.current_streak}</p>
              <p className="text-xs text-stone-400 mt-1">连续学习天数</p>
            </div>
            <div className="bg-white rounded-xl border border-stone-200/60 p-4">
              <p className="text-2xl font-semibold text-emerald-600 tabular-nums">{stats.completed_courses}</p>
              <p className="text-xs text-stone-400 mt-1">已完成课程</p>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-rose-50 text-rose-600 text-sm px-4 py-2.5 rounded-lg mb-6 border border-rose-100">
            {error}
          </div>
        )}

        <RecommendationPanel
          recommendations={recommendations}
          savedRecommendations={savedRecommendations}
          refreshing={refreshingRecommendations}
          startingId={startingRecommendationId}
          onRefresh={handleRefreshRecommendations}
          onSave={handleSaveRecommendation}
          onRemove={handleRemoveSavedRecommendation}
          onStart={handleStartRecommendation}
        />

        {/* Create form */}
        {showCreate && (
          <form onSubmit={handleCreate} className="mb-8 bg-white rounded-xl border border-stone-200/60 p-5 space-y-4">
            <div className="inline-flex rounded-lg border border-stone-200 bg-stone-50 p-1">
              <button
                type="button"
                onClick={() => setCreateMode('topic')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  createMode === 'topic'
                    ? 'bg-white text-stone-900 shadow-sm'
                    : 'text-stone-500 hover:text-stone-700'
                }`}
              >
                主题生成
              </button>
              <button
                type="button"
                onClick={() => setCreateMode('source')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  createMode === 'source'
                    ? 'bg-white text-stone-900 shadow-sm'
                    : 'text-stone-500 hover:text-stone-700'
                }`}
              >
                上传原文
              </button>
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1.5">学习深度</label>
              <div className="grid grid-cols-3 gap-2">
                {LEARNING_DEPTH_OPTIONS.map((option) => {
                  const selected = learningDepth === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={selected}
                      disabled={creating}
                      onClick={() => setLearningDepth(option.value)}
                      className={`min-h-[58px] rounded-lg border px-3 py-2 text-left transition-all disabled:opacity-50 ${
                        selected
                          ? 'border-emerald-600 bg-emerald-50 text-emerald-800'
                          : 'border-stone-200 bg-white text-stone-600 hover:border-stone-300 hover:bg-stone-50'
                      }`}
                    >
                      <span className="block text-sm font-medium">{option.label}</span>
                      <span className={`block text-xs mt-0.5 ${selected ? 'text-emerald-600' : 'text-stone-400'}`}>
                        {option.hint}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1.5">课题名称</label>
              <input
                type="text"
                value={newCourseName}
                onChange={(e) => setNewCourseName(e.target.value)}
                placeholder={createMode === 'source' ? '可留空，默认使用文件名' : '例如「博弈论基础」「Python 装饰器」'}
                className="w-full px-3.5 py-2.5 bg-white border border-stone-200 rounded-lg text-sm transition-colors hover:border-stone-300 focus:border-emerald-600 outline-none"
                autoFocus
                disabled={creating}
              />
            </div>

            {createMode === 'topic' ? (
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1.5">
                  参考材料
                  <span className="text-stone-400 font-normal ml-1">（可选）</span>
                </label>
                <textarea
                  value={newCourseRef}
                  onChange={(e) => setNewCourseRef(e.target.value)}
                  placeholder="粘贴课本章节、论文摘要、笔记、或任何你希望 AI 参考的内容..."
                  className="w-full border border-stone-200 rounded-lg p-3.5 text-sm resize-none h-28 transition-colors hover:border-stone-300 focus:border-emerald-600 outline-none"
                  disabled={creating}
                />
                <p className="text-xs text-stone-400 mt-1">AI 会根据这些材料设计课程大纲和课文内容</p>
              </div>
            ) : (
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1.5">PDF / TXT / MD 原文</label>
                <label className="flex items-center justify-between gap-3 border border-dashed border-stone-300 rounded-lg px-3.5 py-3 bg-stone-50/70 hover:bg-stone-50 transition-colors cursor-pointer">
                  <span className="text-sm text-stone-500 truncate">
                    {sourceFile ? sourceFile.name : '选择一个 PDF、TXT 或 MD 文件'}
                  </span>
                  <span className="text-xs text-emerald-600 font-medium shrink-0">选择文件</span>
                  <input
                    type="file"
                    accept=".pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown,text/x-markdown"
                    className="hidden"
                    disabled={creating}
                    onChange={(e) => setSourceFile(e.target.files?.[0] || null)}
                  />
                </label>
                <p className="text-xs text-stone-400 mt-1">创建后先阅读原文，划线提问会立即回答；读完后再生成下一篇</p>
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={creating}
                className="bg-stone-900 text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-stone-800 disabled:opacity-50 transition-all duration-200 cursor-pointer"
              >
                {creating ? '创建中...' : createMode === 'source' ? '上传并创建' : '创建课程'}
              </button>
            </div>
          </form>
        )}

        {/* Course list */}
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="bg-white rounded-xl border border-stone-200/60 p-5">
                <div className="flex items-center justify-between">
                  <div className="skeleton h-4 rounded w-1/3" />
                  <div className="flex items-center gap-3">
                    <div className="skeleton h-5 rounded-full w-14" />
                    <div className="skeleton h-3 rounded w-8" />
                  </div>
                </div>
                <div className="skeleton h-3 rounded w-20 mt-2" />
              </div>
            ))}
          </div>
        ) : courses.length === 0 ? (
          <div className="py-20 text-center">
            <div className="w-12 h-12 rounded-full bg-stone-100 mx-auto mb-4 flex items-center justify-center">
              <svg className="w-5 h-5 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
              </svg>
            </div>
            <p className="text-stone-400 text-sm mb-1">还没有课程</p>
            <p className="text-stone-300 text-xs">点击「新建课程」开始你的第一次一对一学习</p>
          </div>
        ) : (
          <div className="space-y-2">
            {courses.map((course, i) => (
              <div
                key={course.id}
                style={{ '--i': i }}
                className="stagger-in w-full bg-white rounded-xl p-5 text-left border border-stone-200/60 hover:border-stone-300 hover:shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)] transition-all duration-200 group cursor-pointer"
                onClick={() => navigate(`/course/${course.id}`)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <h3 className="font-medium text-stone-800 group-hover:text-stone-900 transition-colors truncate">
                      {course.name}
                    </h3>
                    {course.mode === 'source' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 border border-amber-100 shrink-0">
                        原文
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {course.status === 'completed' ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-100">
                        已完成
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-stone-50 text-stone-500 border border-stone-100">
                        {Math.round(course.mastery_progress * 100)}%
                      </span>
                    )}
                    <span className="text-xs text-stone-400 font-mono tabular-nums">
                      {course.lesson_count} 篇
                    </span>
                    <button
                      onClick={(e) => handleDelete(e, course.id)}
                      className="opacity-0 group-hover:opacity-100 text-stone-300 hover:text-rose-500 transition-all p-1"
                      title="删除课程"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                      </svg>
                    </button>
                    <svg className="w-4 h-4 text-stone-300 group-hover:text-stone-500 group-hover:translate-x-0.5 transition-all" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                    </svg>
                  </div>
                </div>
                <div className="flex items-center gap-3 mt-1.5">
                  <p className="text-xs text-stone-400 font-mono tabular-nums">
                    {new Date(course.created_at).toLocaleDateString('zh-CN')}
                  </p>
                  {course.status !== 'completed' && course.mastery_progress > 0 && (
                    <div className="flex-1 h-1 bg-stone-100 rounded-full overflow-hidden max-w-[120px]">
                      <div
                        className="h-full bg-emerald-500 rounded-full"
                        style={{ width: `${Math.round(course.mastery_progress * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
