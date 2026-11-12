// Per-tab JSON reads only. Identity changes and writes invalidate both data and in-flight reads.
export function createReadCache(maxChars = 2_000_000) {
  const entries = new Map<string, { value: unknown; expires: number; size: number }>();
  const pending = new Map<string, Promise<unknown>>();
  const versions = new Map<string, number>();
  let epoch = 0;
  let size = 0;
  function clear(match?: (key: string) => boolean) {
    if (!match) {
      epoch++;
      entries.clear(); pending.clear(); versions.clear(); size = 0;
      return;
    }
    for (const key of new Set([...entries.keys(), ...pending.keys()])) {
      if (match(key)) versions.set(key, (versions.get(key) ?? 0) + 1);
    }
    for (const [key, entry] of entries) if (match(key)) { entries.delete(key); size -= entry.size; }
    for (const key of pending.keys()) if (match(key)) pending.delete(key);
  }
  async function read<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const entry = entries.get(key);
    if (entry && entry.expires > Date.now()) return structuredClone(entry.value) as T;
    if (entry) { entries.delete(key); size -= entry.size; }
    const generation = epoch;
    const version = versions.get(key) ?? 0;
    let promise = pending.get(key) as Promise<T> | undefined;
    if (!promise) {
      promise = load().then(value => {
        if (generation === epoch && version === (versions.get(key) ?? 0) && ttl > 0) {
          const chars = (JSON.stringify(value) ?? "").length;
          if (chars <= maxChars / 2) {
            while (entries.size && (size + chars > maxChars || entries.size >= 64)) {
              const oldest = entries.keys().next().value!;
              size -= entries.get(oldest)!.size;
              entries.delete(oldest);
            }
            entries.set(key, { value: structuredClone(value), expires: Date.now() + ttl, size: chars });
            size += chars;
          }
        }
        return value;
      });
      pending.set(key, promise);
      const current = promise;
      void promise.finally(() => { if (pending.get(key) === current) pending.delete(key); }).catch(() => {});
    }
    return structuredClone(await promise);
  }
  return { read, clear };
}

export function readTtl(path: string): number {
  if (/^\/api\/courses\/\d+\/lessons\/-?\d+$/.test(path)) return 120_000;
  if (/^\/api\/(courses(?:\/\d+(?:\/(?:syllabus|lessons))?)?(?:\?|$)|stats$|calendar$|recommendations$|me\/annotations[/?]|me\/teaching-style$)/.test(path)) return 30_000;
  return 0;
}
