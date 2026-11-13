"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// 流式文字：每个 token 都 setState 会让整个课文页跟着每个 token 重渲染一次。文字先攒在 ref 里，每帧最多刷新一次界面；
// ref.current 随时是完整的最新文字（停止、断线时按它存半截回答）
export function useFrameText() {
  const [text, setText] = useState("");
  const ref = useRef("");
  const frame = useRef(0);

  const append = useCallback((chunk: string) => {
    ref.current += chunk;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setText(ref.current);
    });
  }, []);

  const reset = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    ref.current = "";
    setText("");
  }, []);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return { text, ref, append, reset };
}
