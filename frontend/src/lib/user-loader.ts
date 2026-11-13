// 用户资料（GET /api/me）只取一次；取失败（后端重启、冷启动）按退避间隔有限次重试，不会一直停在「没有用户」。
// 重试用完仍没取到：onFailed(true)，界面据此给出手动重试；开始新一次尝试或换人、退出时 onFailed(false)。
// 不依赖 React，便于测试：onUser(null) 表示清空。
export const RETRY_DELAYS_MS = [2000, 5000, 10000, 15000, 30000];

export function createUserLoader<U>({
  load,
  onUser,
  onError,
  onFailed,
  delays = RETRY_DELAYS_MS,
  schedule = setTimeout,
  cancel = clearTimeout,
}: {
  load: () => Promise<U>;
  onUser: (user: U | null) => void;
  onError: (error: Error) => void;
  onFailed: (failed: boolean) => void;
  delays?: number[];
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: any) => void;
}) {
  let uuid: string | undefined;
  let loaded = false;
  // 每次换用户、退出、卸载都换一代：旧一代迟到的响应和定时器一律作废
  let generation = 0;
  let retries = 0;
  let timer: unknown;
  let failed = false;

  const setFailed = (value: boolean) => {
    if (failed !== value) {
      failed = value;
      onFailed(value);
    }
  };

  const clearTimer = () => {
    if (timer !== undefined) {
      cancel(timer);
      timer = undefined;
    }
  };

  // notify：是否把失败报给用户。自动重试不报，免得后端挂着时一直弹提示。
  async function attempt(gen: number, notify: boolean) {
    setFailed(false);
    try {
      const user = await load();
      if (gen !== generation) {
        return;
      }
      loaded = true;
      onUser(user);
    } catch (e) {
      if (gen !== generation) {
        return;
      }
      if (notify) {
        onError(e as Error);
      }
      const delay = delays[retries++];
      if (delay === undefined) {
        setFailed(true);
        return;
      }
      timer = schedule(() => {
        timer = undefined;
        attempt(gen, false);
      }, delay);
    }
  }

  return {
    get loaded() {
      return loaded;
    },

    // 传入当前用户的标识（没有传 undefined）：同一个用户不重复请求，换人或退出会清空旧用户
    sync(next: string | undefined) {
      if (next === uuid) {
        return;
      }
      const hadUser = uuid !== undefined;
      clearTimer();
      generation++;
      retries = 0;
      loaded = false;
      setFailed(false);
      uuid = next;
      if (hadUser) {
        onUser(null);
      }
      if (next !== undefined) {
        attempt(generation, true);
      }
    },

    // 显式刷新：用户资料还没加载出来时，立即再取一次。取消待触发的重试，也作废进行中的那次，
    // 否则两次都失败会各排一个重试，先排的那个定时器再也取消不掉。
    reload() {
      if (uuid === undefined) {
        return Promise.resolve();
      }
      clearTimer();
      return attempt(++generation, true);
    },

    // 卸载
    stop() {
      clearTimer();
      generation++;
    },
  };
}
