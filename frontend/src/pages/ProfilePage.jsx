import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { getGlobalStats, getCalendar } from '../lib/api';

const pad = (n) => String(n).padStart(2, '0');
const toKey = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`; // m 为 0 基月份
const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']; // 周一开头
const WEEK_ZH = ['日', '一', '二', '三', '四', '五', '六'];

// 当天活动强度 → 月历单元格配色（0 表示无活动）
const CELL = [
  'bg-stone-100 text-stone-300',
  'bg-emerald-100 text-emerald-800',
  'bg-emerald-200 text-emerald-900',
  'bg-emerald-400 text-white',
  'bg-emerald-600 text-white',
];
// 热力图单元格配色（无文字）
const HEAT = ['bg-stone-200/70', 'bg-emerald-200', 'bg-emerald-300', 'bg-emerald-500', 'bg-emerald-600'];

function level(count) {
  if (!count) return 0;
  if (count <= 2) return 1;
  if (count <= 4) return 2;
  if (count <= 7) return 3;
  return 4;
}

function StatCard({ value, label, accent }) {
  return (
    <div className="bg-white rounded-xl border border-stone-200/60 p-4">
      <p className={`text-2xl font-semibold tabular-nums ${accent ? 'text-emerald-600' : 'text-stone-900'}`}>{value}</p>
      <p className="text-xs text-stone-400 mt-1">{label}</p>
    </div>
  );
}

export default function ProfilePage() {
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [dayMap, setDayMap] = useState({});
  const [calendar, setCalendar] = useState(null);
  const [month, setMonth] = useState(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); });
  const [selectedDay, setSelectedDay] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([getGlobalStats(), getCalendar()])
      .then(([s, cal]) => {
        setStats(s);
        setCalendar(cal);
        const map = {};
        for (const d of cal.days) map[d.date] = d;
        setDayMap(map);
        // 默认定位到最近一次学习的那天，面板直接展示内容
        if (cal.last_active_date) {
          setSelectedDay(cal.last_active_date);
          const [y, m] = cal.last_active_date.split('-').map(Number);
          setMonth(new Date(y, m - 1, 1));
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const year = month.getFullYear();
  const m = month.getMonth();
  const now = new Date();
  const todayKey = toKey(now.getFullYear(), now.getMonth(), now.getDate());
  const isCurrentMonth = year === now.getFullYear() && m === now.getMonth();

  // 月历单元格：前导空格 + 1..本月天数
  const cells = useMemo(() => {
    const daysInMonth = new Date(year, m + 1, 0).getDate();
    const lead = (new Date(year, m, 1).getDay() + 6) % 7; // 周一开头
    const arr = Array(lead).fill(null);
    for (let d = 1; d <= daysInMonth; d++) arr.push(d);
    return arr;
  }, [year, m]);

  // 热力图：最近 26 周（周一对齐）到今天
  const heatWeeks = useMemo(() => {
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const start = new Date(end);
    start.setDate(end.getDate() - 181);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // 回退到周一
    const weeks = [];
    const cur = new Date(start);
    while (cur <= end) {
      const col = [];
      for (let i = 0; i < 7; i++) {
        col.push({ key: toKey(cur.getFullYear(), cur.getMonth(), cur.getDate()), future: cur > end });
        cur.setDate(cur.getDate() + 1);
      }
      weeks.push(col);
    }
    return weeks;
  }, [todayKey]);

  const selectDay = (key) => {
    setSelectedDay(key);
    const [y, mm] = key.split('-').map(Number);
    if (y !== year || mm - 1 !== m) setMonth(new Date(y, mm - 1, 1));
  };

  const detail = selectedDay ? dayMap[selectedDay] : null;
  const selectedTitle = (() => {
    if (!selectedDay) return '';
    const [y, mm, d] = selectedDay.split('-').map(Number);
    const wk = new Date(y, mm - 1, d).getDay();
    return `${mm} 月 ${d} 日 · 周${WEEK_ZH[wk]}`;
  })();

  return (
    <div className="min-h-[100dvh] bg-stone-50">
      {/* Header */}
      <header className="bg-stone-900 sticky top-0 z-10">
        <div className="max-w-[1100px] mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/')} className="text-base font-semibold text-white tracking-tight hover:text-emerald-400 transition-colors cursor-pointer">Bloom</button>
            <span className="text-stone-600 text-xs font-mono">个人中心</span>
          </div>
          <button
            onClick={() => navigate('/')}
            className="text-xs text-stone-400 hover:text-white transition-colors flex items-center gap-1 cursor-pointer"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
            </svg>
            我的课程
          </button>
        </div>
      </header>

      <main className="max-w-[1100px] mx-auto px-6 py-10">
        <div className="mb-8">
          <h2 className="text-2xl font-semibold tracking-tight text-stone-900">学习概览</h2>
          <p className="text-sm text-stone-400 mt-1">回顾你的学习足迹，点击日历看每天学了什么</p>
        </div>

        {error && (
          <div className="bg-rose-50 text-rose-600 text-sm px-4 py-2.5 rounded-lg mb-6 border border-rose-100">{error}</div>
        )}

        {loading ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-20 rounded-xl" />)}
            </div>
            <div className="skeleton h-72 rounded-xl" />
          </div>
        ) : (
          <>
            {/* Stat cards */}
            {stats && (
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-8">
                <StatCard value={stats.total_lessons_read} label="已学课文" />
                <StatCard value={stats.current_streak} label="连续学习天数" />
                <StatCard value={stats.longest_streak} label="最长连续天数" />
                <StatCard value={stats.total_annotations} label="划线提问数" />
                <StatCard value={stats.completed_courses} label="已完成课程" accent />
              </div>
            )}

            <div className="grid lg:grid-cols-[1.1fr_0.9fr] gap-5 mb-8">
              {/* Month calendar */}
              <div className="bg-white rounded-xl border border-stone-200/60 p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-stone-800">{year} 年 {m + 1} 月</h3>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setMonth(new Date(year, m - 1, 1))}
                      className="w-7 h-7 rounded-md hover:bg-stone-100 flex items-center justify-center text-stone-500 transition-colors cursor-pointer"
                      title="上个月"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <button
                      onClick={() => !isCurrentMonth && setMonth(new Date(year, m + 1, 1))}
                      disabled={isCurrentMonth}
                      className="w-7 h-7 rounded-md hover:bg-stone-100 flex items-center justify-center text-stone-500 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                      title="下个月"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-7 gap-1.5 mb-1.5">
                  {WEEK_LABELS.map((w) => (
                    <div key={w} className="text-center text-[11px] text-stone-400 font-medium py-1">{w}</div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-1.5">
                  {cells.map((d, i) => {
                    if (d === null) return <div key={`e${i}`} />;
                    const key = toKey(year, m, d);
                    const day = dayMap[key];
                    const lv = level(day?.event_count || 0);
                    const isToday = key === todayKey;
                    const isSel = key === selectedDay;
                    const clickable = !!day;
                    return (
                      <button
                        key={key}
                        onClick={() => clickable && selectDay(key)}
                        disabled={!clickable}
                        title={day ? `${day.lessons_read} 篇课文 · ${day.annotations} 条划线` : ''}
                        className={`aspect-square rounded-lg flex items-center justify-center text-xs font-medium relative transition-all
                          ${CELL[lv]}
                          ${clickable ? 'cursor-pointer hover:scale-[1.06]' : 'cursor-default'}
                          ${isSel ? 'ring-2 ring-stone-900 ring-offset-1' : isToday ? 'ring-2 ring-emerald-500/70' : ''}`}
                      >
                        {d}
                      </button>
                    );
                  })}
                </div>

                {/* Legend */}
                <div className="flex items-center justify-end gap-1.5 mt-4 text-[11px] text-stone-400">
                  <span>少</span>
                  {CELL.map((c, i) => <span key={i} className={`w-3 h-3 rounded ${c.split(' ')[0]}`} />)}
                  <span>多</span>
                </div>
              </div>

              {/* Selected-day detail */}
              <div className="bg-white rounded-xl border border-stone-200/60 p-5">
                {detail ? (
                  <>
                    <div className="flex items-baseline justify-between mb-1">
                      <h3 className="text-sm font-semibold text-stone-800">{selectedTitle}</h3>
                      <span className="text-[11px] text-stone-400 font-mono tabular-nums">{detail.courses.length} 个课程</span>
                    </div>
                    <p className="text-xs text-stone-400 mb-4">这天你学了 {detail.lessons_read} 篇课文，提出 {detail.annotations} 个划线问题</p>
                    <div className="space-y-2.5 max-h-[340px] overflow-y-auto -mr-2 pr-2">
                      {detail.courses.map((c) => (
                        <button
                          key={c.course_id}
                          onClick={() => navigate(`/course/${c.course_id}`)}
                          className="w-full text-left bg-stone-50 hover:bg-stone-100 border border-stone-200/60 hover:border-stone-300 rounded-lg p-3 transition-all group cursor-pointer"
                        >
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="font-medium text-sm text-stone-800 group-hover:text-stone-900 truncate">{c.course_name}</span>
                            {c.mode === 'source' && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 border border-amber-100 shrink-0">原文</span>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {c.lessons.length > 0 ? (
                              c.lessons.map((n) => (
                                <span key={n} className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100 tabular-nums">第 {n} 篇</span>
                              ))
                            ) : (
                              <span className="text-[11px] text-stone-400">课程整理</span>
                            )}
                            {c.annotations > 0 && (
                              <span className="text-[11px] px-2 py-0.5 rounded-full bg-stone-100 text-stone-500 tabular-nums">{c.annotations} 划线</span>
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="h-full min-h-[200px] flex flex-col items-center justify-center text-center">
                    <div className="w-11 h-11 rounded-full bg-stone-100 flex items-center justify-center mb-3">
                      <svg className="w-5 h-5 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
                      </svg>
                    </div>
                    <p className="text-stone-400 text-sm mb-1">{selectedDay ? '这天没有学习记录' : '点击日历查看当天内容'}</p>
                    <p className="text-stone-300 text-xs">绿色越深，代表那天学得越多</p>
                  </div>
                )}
              </div>
            </div>

            {/* Contribution heatmap — 最近半年足迹 */}
            <div className="bg-white rounded-xl border border-stone-200/60 p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-stone-800">学习足迹</h3>
                <span className="text-xs text-stone-400">最近 26 周 · 共 {calendar?.total_active_days || 0} 天有学习</span>
              </div>
              <div className="overflow-x-auto -mx-1 px-1">
                <div className="flex gap-1 min-w-max">
                  {heatWeeks.map((col, ci) => (
                    <div key={ci} className="flex flex-col gap-1">
                      {col.map((cell, ri) => {
                        if (cell.future) return <div key={ri} className="w-3 h-3" />;
                        const day = dayMap[cell.key];
                        const lv = level(day?.event_count || 0);
                        const isSel = cell.key === selectedDay;
                        return (
                          <button
                            key={ri}
                            onClick={() => day && selectDay(cell.key)}
                            disabled={!day}
                            title={day ? `${cell.key} · ${day.lessons_read} 篇课文` : cell.key}
                            className={`w-3 h-3 rounded-sm ${HEAT[lv]} ${day ? 'cursor-pointer hover:ring-1 hover:ring-stone-400' : 'cursor-default'} ${isSel ? 'ring-2 ring-stone-900' : ''}`}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
