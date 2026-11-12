"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";

import { useFrameText } from "@/components/learn/use-frame-text";
import { askAboutLesson, clearLessonChat, getLessonChat } from "@/lib/learn/api";
import { BACKGROUND_CHECK_MS } from "@/lib/learn/background-answer";
import { savedAnswer, type ChatTurn } from "@/lib/learn/lesson-chat";
import { appendRun, finishRun, livePage, noRuns, readRuns, registerPage, startRun, subscribeRuns } from "@/lib/learn/running";
import { StreamError } from "@/lib/learn/stream";

// 挂在某一篇上的「问这篇」：写完的回答交给它换上（lib/learn/running.ts）
interface ChatPage {
  setTurns: Dispatch<SetStateAction<ChatTurn[]>>;
  setDraft: Dispatch<SetStateAction<string>>;
  setError: Dispatch<SetStateAction<string>>;
  setStreaming: Dispatch<SetStateAction<boolean>>;
  reset: () => void;
}

// 「问这篇」的状态：对话、输入框、正在写的回答。挂在课文页上，卡片收起时回答照样在写，再打开就看得到。
// 对话存在后端（每人每篇一份）：打开一篇时读一次，答完后端已经存好。开始了就写完：换到别的一篇也不断开，
// 回到这一篇时接着显示问题和写到哪儿了，写完换到那时挂着这一篇的页面上
export function useLessonChat({
  courseId,
  lessonNum,
  report,
  anchor,
}: {
  courseId: string;
  lessonNum: string;
  // 出错时给读者看的话
  report: (err: unknown) => string;
  // 读者正在读的那一段（lib/learn/lesson-chat.ts 的 readingAnchor）
  anchor: () => string;
}) {
  const t = useTranslations("learn");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [streaming, setStreaming] = useState(false);
  const { text: streamText, ref: streamRef, append, reset } = useFrameText();
  // 这个页面发起的回答还在写
  const busyRef = useRef(false);
  const routeRef = useRef("");
  // 读回来之前读者已经问了或清空了（或者回答已经写完换上了）：读回来的那份不再盖掉页面上的
  const touchedRef = useRef(false);
  const turnsRef = useRef(turns);
  useEffect(() => {
    turnsRef.current = turns;
  });
  const owner = useRef({}).current;
  const route = `${courseId}/${lessonNum}`;
  // 换到别的一篇时还在写的那一条（发起它的页面已经卸掉）：这个页面照着它显示
  const runs = useSyncExternalStore(subscribeRuns, readRuns, noRuns);
  const adopted = runs.find((run) => run.kind === "chat" && run.route === route && run.owner !== owner);

  const pageRef = useRef<ChatPage | null>(null);
  pageRef.current = {
    setTurns: (value) => {
      touchedRef.current = true;
      setTurns(value);
    },
    setDraft, setError, setStreaming, reset,
  };
  useEffect(() => registerPage(route, "chat", () => pageRef.current), [route]);

  useEffect(() => {
    routeRef.current = route;
    touchedRef.current = false;
    setTurns([]);
    setDraft("");
    setError("");
    setStreaming(false);
    reset();
    const load = async () => (await getLessonChat(courseId, lessonNum)).messages;
    // 换篇之前问的还在写：问题接在读回来的对话后面，回答接着写
    const asked = () => {
      const run = readRuns().find((item) => item.kind === "chat" && item.route === route && item.owner !== owner);
      return run ? [{ role: "user" as const, content: run.question ?? "" }] : [];
    };
    load().then(
      (messages) => {
        if (routeRef.current !== route || touchedRef.current) return;
        setTurns([...messages, ...asked()]);
      },
      (err) => {
        if (routeRef.current !== route || touchedRef.current) return;
        setTurns(asked());
        setError(t("lesson.chatLoadFailed", { message: report(err) }));
      }
    );
    return () => {
      routeRef.current = "";
    };
  }, [courseId, lessonNum, route, owner, reset, report, t]);

  const send = useCallback(async () => {
    const question = draft.trim();
    if (!question || busyRef.current || adopted) return;
    const route = `${courseId}/${lessonNum}`;
    // 下面换的都换到那时挂着这一篇的页面上：写着时换到别的一篇再回来，结果照样换上；都不在就不用换（后端照样答完、存好）
    const page = () => livePage<ChatPage>(route, "chat");
    touchedRef.current = true;
    const before = turnsRef.current;
    const asked: ChatTurn[] = [...before, { role: "user", content: question }];
    setTurns(asked);
    setDraft("");
    setError("");
    reset();
    setStreaming(true);
    busyRef.current = true;
    const key = startRun({ route, kind: "chat", owner, question });
    try {
      const { answer, partial } = await askAboutLesson(courseId, lessonNum, { question, anchor: anchor() }, (chunk) => {
        append(chunk);
        appendRun(key, chunk);
      });
      page()?.setTurns([...asked, { role: "assistant", content: answer, ...(partial ? { partial: true } : {}) }]);
    } catch (err) {
      const received = streamRef.current.trim();
      // 写到一半连接断了：已经收到的留在页面上，说明没收全（后端照样答完、存好，下次打开这一篇读到的是完整回答）；
      // 还没开始写就失败（没受理）：问题放回输入框
      if (received && err instanceof StreamError) {
        const shown: ChatTurn[] = [...asked, { role: "assistant", content: received }];
        page()?.setTurns(shown);
        // 后端照样把这条答完、存好：过一会儿读回存下的对话，读到这次的完整回答就把半截换掉（读者在那之前又问了别的就不动）
        let done = false;
        for (const wait of BACKGROUND_CHECK_MS) {
          setTimeout(() => {
            if (done) return;
            getLessonChat(courseId, lessonNum).then(({ messages }) => {
              const saved = done ? undefined : savedAnswer(messages, question, before);
              if (!saved) return;
              done = true;
              livePage<ChatPage>(route, "chat")?.setTurns((current) => (current.at(-1)?.content === received ? saved : current));
              livePage<ChatPage>(route, "chat")?.setError("");
            }, () => {
              // 读不回来就保持原样：页面上已经说了连接断了，重新打开这一篇时照样读到完整的
            });
          }, wait);
        }
      } else {
        page()?.setTurns(before);
        page()?.setDraft(question);
      }
      page()?.setError(report(err));
    } finally {
      busyRef.current = false;
      finishRun(key);
      page()?.setStreaming(false);
      page()?.reset();
    }
  }, [adopted, anchor, append, courseId, draft, lessonNum, owner, report, reset, streamRef]);

  const clear = useCallback(() => {
    if (busyRef.current || adopted) return;
    const route = `${courseId}/${lessonNum}`;
    const before = turnsRef.current;
    touchedRef.current = true;
    setTurns([]);
    setError("");
    clearLessonChat(courseId, lessonNum).catch((err) => {
      if (routeRef.current !== route) return;
      setTurns(before);
      setError(report(err));
    });
  }, [adopted, courseId, lessonNum, report]);

  return {
    turns, draft, setDraft, error,
    streaming: streaming || Boolean(adopted),
    streamText: adopted ? adopted.text : streamText,
    send, clear,
  };
}
