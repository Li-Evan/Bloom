"use client";

import { ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { ContextValue } from "@/types/context";
import { Me } from "@/types/user";
import { useBackendError } from "@/hooks/use-backend-error";
import { toast } from "sonner";
import { createUserLoader } from "@/lib/user-loader";

const AppContext = createContext({} as ContextValue);

export const useAppContext = () => useContext(AppContext);

// 本地用户的资料（GET /api/me）在页面打开时取一次；取失败（后端还没起来）按退避间隔有限次重试
export const AppContextProvider = ({ children }: { children: ReactNode }) => {
  const backendError = useBackendError();
  // user loader 只创建一次，用 ref 拿到随语言变化的最新翻译函数
  const backendErrorRef = useRef(backendError);
  backendErrorRef.current = backendError;
  const [user, setUser] = useState<Me | null>(null);
  const [userLoadFailed, setUserLoadFailed] = useState(false);

  const [userLoader] = useState(() =>
    createUserLoader<Me>({
      load: () => api<Me>("/api/me"),
      onUser: setUser,
      onError: (e) => toast.error(backendErrorRef.current(e)),
      onFailed: setUserLoadFailed,
    })
  );

  useEffect(() => {
    userLoader.sync("local");
    return () => userLoader.stop();
  }, [userLoader]);

  const reloadUser = useCallback(() => userLoader.reload(), [userLoader]);

  return (
    <AppContext.Provider value={{ user, setUser, userLoadFailed, reloadUser }}>
      {children}
    </AppContext.Provider>
  );
};
