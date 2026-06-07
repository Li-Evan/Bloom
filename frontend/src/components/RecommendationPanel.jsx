const LANES = ['补地基', '做连接', '向外长'];

function SourceTopics({ topics }) {
  if (!topics?.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {topics.map((topic) => (
        <span
          key={topic}
          className="text-[11px] leading-5 px-2 rounded-full bg-stone-100 text-stone-500 border border-stone-200/70"
        >
          {topic}
        </span>
      ))}
    </div>
  );
}

function RecommendationCard({ item, index, onSave, onStart, starting }) {
  return (
    <article className="stagger-in bg-white border border-stone-200/70 rounded-xl p-4 hover:border-stone-300 hover:shadow-[0_10px_28px_-22px_rgba(28,25,23,0.55)] transition-all duration-200" style={{ '--i': index }}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <p className="text-[11px] font-mono text-emerald-600 mb-1">{LANES[index] || '推荐'}</p>
          <h3 className="text-base font-semibold text-stone-900 tracking-tight break-words">{item.title}</h3>
        </div>
        <button
          type="button"
          onClick={() => onSave(item)}
          className="shrink-0 w-8 h-8 rounded-full border border-stone-200 text-stone-400 hover:text-amber-600 hover:border-amber-200 hover:bg-amber-50 transition-colors flex items-center justify-center"
          title="收藏到待学习清单"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M17.6 21 12 17.7 6.4 21V5.8c0-1 .8-1.8 1.8-1.8h7.6c1 0 1.8.8 1.8 1.8V21Z" />
          </svg>
        </button>
      </div>

      <p className="text-sm text-stone-600 leading-6 mb-3">{item.rationale}</p>
      {item.bridge && (
        <p className="text-xs text-stone-500 leading-5 bg-stone-50 border border-stone-100 rounded-lg px-3 py-2 mb-3">
          {item.bridge}
        </p>
      )}
      <div className="flex items-end justify-between gap-3">
        <SourceTopics topics={item.source_topics} />
        <button
          type="button"
          onClick={() => onStart(item)}
          disabled={starting}
          className="shrink-0 bg-stone-900 text-white px-3 py-2 rounded-lg text-xs font-medium hover:bg-stone-800 disabled:opacity-50 transition-colors"
        >
          {starting ? '创建中...' : '开始学习'}
        </button>
      </div>
    </article>
  );
}

function SavedRow({ item, onRemove, onStart, starting }) {
  return (
    <div className="bg-white border border-stone-200/70 rounded-xl px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-medium text-stone-800 break-words">{item.title}</h4>
          {item.bridge && <p className="text-xs text-stone-400 mt-1 leading-5">{item.bridge}</p>}
        </div>
        <button
          type="button"
          onClick={() => onRemove(item)}
          className="shrink-0 text-stone-300 hover:text-rose-500 transition-colors p-1"
          title="移出待学习清单"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <button
        type="button"
        onClick={() => onStart(item)}
        disabled={starting}
        className="mt-3 w-full border border-stone-200 text-stone-700 px-3 py-2 rounded-lg text-xs font-medium hover:bg-stone-50 disabled:opacity-50 transition-colors"
      >
        {starting ? '创建中...' : '进入学习'}
      </button>
    </div>
  );
}

export default function RecommendationPanel({
  recommendations,
  savedRecommendations,
  refreshing,
  startingId,
  onRefresh,
  onSave,
  onRemove,
  onStart,
}) {
  return (
    <section className="mb-10">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 mb-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-stone-900">下一步学习</h2>
          <p className="text-sm text-stone-400 mt-1">从已学内容长出的 3 个主题</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="self-start sm:self-auto border border-stone-200 bg-white text-stone-700 px-3.5 py-2 rounded-lg text-sm font-medium hover:border-stone-300 hover:bg-stone-50 disabled:opacity-50 transition-colors inline-flex items-center gap-2"
        >
          <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M20 11a8.1 8.1 0 0 0-15.5-3M4 5v3h3m-3 5a8.1 8.1 0 0 0 15.5 3M20 19v-3h-3" />
          </svg>
          {refreshing ? '刷新中' : recommendations.length ? '换一组' : '生成推荐'}
        </button>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_320px] gap-4">
        <div className="grid md:grid-cols-3 gap-3">
          {refreshing && recommendations.length === 0 ? (
            [0, 1, 2].map((i) => (
              <div key={i} className="bg-white border border-stone-200/70 rounded-xl p-4">
                <div className="skeleton h-3 rounded w-14 mb-3" />
                <div className="skeleton h-5 rounded w-2/3 mb-4" />
                <div className="skeleton h-3 rounded w-full mb-2" />
                <div className="skeleton h-3 rounded w-5/6 mb-5" />
                <div className="skeleton h-8 rounded-lg w-20 ml-auto" />
              </div>
            ))
          ) : recommendations.length > 0 ? (
            recommendations.map((item, index) => (
              <RecommendationCard
                key={item.id}
                item={item}
                index={index}
                onSave={onSave}
                onStart={onStart}
                starting={startingId === item.id}
              />
            ))
          ) : (
            <div className="md:col-span-3 bg-white border border-dashed border-stone-300 rounded-xl px-5 py-8 text-center">
              <p className="text-sm text-stone-500">还没有推荐主题</p>
            </div>
          )}
        </div>

        <aside className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-stone-800">待学习清单</h3>
            <span className="text-xs font-mono text-stone-400">{savedRecommendations.length}</span>
          </div>
          {savedRecommendations.length > 0 ? (
            savedRecommendations.map((item) => (
              <SavedRow
                key={item.id}
                item={item}
                onRemove={onRemove}
                onStart={onStart}
                starting={startingId === item.id}
              />
            ))
          ) : (
            <div className="bg-white border border-stone-200/70 rounded-xl px-4 py-6 text-center">
              <p className="text-xs text-stone-400">收藏的主题会放在这里</p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
