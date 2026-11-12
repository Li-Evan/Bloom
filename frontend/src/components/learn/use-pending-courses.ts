"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PENDING_CHANGED_EVENT,
  type PendingCourse,
  addPending,
  pendingStorageKey,
  readPending,
  readPendingStrict,
  removePending,
  withKnownCourse,
  writePending,
} from "@/lib/learn/pending-courses";

// 「正在生成」的课程记录：存在 localStorage 里（按用户分开），刷新、离开再回来、关掉标签再打开都还在。
// userId 还没拿到时（资料在加载）是空列表；浏览器禁用了存储时只在这个页面里有效。
export function usePendingCourses(userId: string | undefined) {
  const [items, setItems] = useState<PendingCourse[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [loadedFor, setLoadedFor] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!userId) {
      setItems([]);
      setLoadedFor(undefined);
      return;
    }
    setItems(readPending(userId));
    setLoadedFor(userId);
  }, [userId]);

  // 别处改了记录（另一个标签页、已经离开的页面里那次建课请求回来了）：跟着变
  useEffect(() => {
    if (!userId) return;
    const key = pendingStorageKey(userId);
    const reread = () => {
      // 存储读不了时记录只在内存里，没有「别处」可同步
      const latest = readPendingStrict(userId);
      if (latest) {
        itemsRef.current = latest;
        setItems(latest);
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) reread();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(PENDING_CHANGED_EVENT, reread);

    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(PENDING_CHANGED_EVENT, reread);
    };
  }, [userId]);

  const update = useCallback(
    (change: (list: PendingCourse[]) => PendingCourse[]) => {
      // 以存储里的为准（别处可能刚改过，不能拿这个组件里可能过时的列表去覆盖）；存储读不了才用内存里的。
      // 先改引用再 setState：同一轮里连着调用两次也不会互相覆盖
      const next = change((userId ? readPendingStrict(userId) : null) ?? itemsRef.current);
      itemsRef.current = next;
      setItems(next);
      if (userId) writePending(userId, next);
    },
    [userId]
  );

  const add = useCallback((item: PendingCourse) => update((list) => addPending(list, item)), [update]);
  const remove = useCallback((id: string) => update((list) => removePending(list, id)), [update]);
  const replaceAll = useCallback((next: PendingCourse[]) => update(() => next), [update]);
  const patch = useCallback(
    (id: string, change: Partial<PendingCourse>) => update((list) => list.map((item) => (item.id === id ? { ...item, ...change } : item))),
    [update]
  );
  const addKnown = useCallback((courseId: number) => update((list) => withKnownCourse(list, courseId)), [update]);

  // 取最新的记录（不等重新渲染）：两次几乎同时返回的列表请求不会各自把同一条记录「结算」一遍
  const current = useCallback(() => itemsRef.current, []);

  return { items, current, loaded: loadedFor === userId && userId !== undefined, add, remove, replaceAll, addKnown, patch };
}
