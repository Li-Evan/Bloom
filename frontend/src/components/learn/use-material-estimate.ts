"use client";

import { useEffect, useRef, useState } from "react";

import { decodeMaterialBytes, isBlankText } from "@/lib/learn/material-chunks";

// 新建课程里「主题 + 参考资料」选了文件之后，在点「创建课程」之前先读一遍文件，提前说出后端会拒绝的情况。
// - none：没选文件
// - reading：正在读文件
// - ready：Markdown / 文本文件都读得出、都有文字
// - pdf：里面有 PDF——浏览器读不出和后端一样的文字，交给服务器解析
// - unreadable：有文件的编码读不出来（后端会拒绝）
// - empty：有文件里没有文字（后端对「没有文字」的文件直接拒绝，哪怕别的文件有字）
// - failed：浏览器读不了这个文件（读取时被移走、删掉、没有权限），file 是读不了的那个文件名
export type MaterialEstimate =
  | { state: "none" | "reading" | "ready" | "pdf" | "unreadable" | "empty" }
  | { state: "failed"; file: string };

type Checked = "ok" | "empty" | "unreadable";

const fileKey = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;

// 读一个文件只为看它解不解得出、有没有字：结果是两个布尔折成的一个状态，不留全文（最多 50 个、每个可到 20 MB）
export async function checkMaterialFile(file: Pick<File, "arrayBuffer">): Promise<Checked> {
  const text = decodeMaterialBytes(await file.arrayBuffer());
  if (text === null) return "unreadable";

  return isBlankText(text) ? "empty" : "ok";
}

// active：对话框开着。关上之后把读过的结果清掉，再打开时重新读
export function useMaterialEstimate(
  files: File[],
  active = true
): MaterialEstimate {
  const [estimate, setEstimate] = useState<MaterialEstimate>({ state: "none" });
  // 读过的文件的结果留着，增删文件时不用把别的再读一遍
  const checked = useRef(new Map<string, Checked>());

  useEffect(() => {
    if (!active) {
      checked.current.clear();
      return;
    }
    if (files.length === 0) {
      setEstimate({ state: "none" });
      return;
    }
    if (files.some((file) => /\.pdf$/i.test(file.name))) {
      setEstimate({ state: "pdf" });
      return;
    }

    let cancelled = false;
    (async () => {
      const unread = files.filter((file) => !checked.current.has(fileKey(file)));
      if (unread.length) setEstimate({ state: "reading" });
      for (const file of unread) {
        let result: Checked;
        try {
          result = await checkMaterialFile(file);
        } catch {
          // 读取失败不记下来：学生把文件移回来、或重新选一次，会再读
          if (!cancelled) setEstimate({ state: "failed", file: file.name });
          return;
        }
        checked.current.set(fileKey(file), result);
        if (cancelled) return;
      }

      const results = files.map((file) => checked.current.get(fileKey(file)));
      setEstimate({ state: results.includes("unreadable") ? "unreadable" : results.includes("empty") ? "empty" : "ready" });
    })();

    return () => {
      cancelled = true;
    };
  }, [files, active]);

  return estimate;
}
