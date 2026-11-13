import type { Dispatch, SetStateAction } from "react";
import type { Me } from "@/types/user";

export interface ContextValue {
  user: Me | null;
  setUser: Dispatch<SetStateAction<Me | null>>;
  userLoadFailed: boolean;
  reloadUser: () => Promise<void>;
}
