/**
 * 在途任务计数（优雅退出用）。
 *
 * 只做一件事：让 shutdown 能等到「手上正在处理的那些事件」跑完，再去关
 * SQLite 连接和 transport。没有它，SIGTERM 到来时还在 await AI 的 handler
 * 会撞上一个已经 close 的数据库。
 *
 * 刻意不负责取消：取消由调用方的 AbortController 传播（见 index.ts），
 * 这里只做计数与等待，因此可以单独测试。
 */
export interface DrainTracker {
  /** 当前在途任务数 */
  readonly inflight: number;
  /** 登记一个在途任务；返回的函数结束登记（幂等，重复调用只算一次） */
  begin(): () => void;
  /** 全部结束的 Promise；已经空闲时立即 resolve */
  whenIdle(): Promise<void>;
  /** 最多等 timeoutMs；true = 等到了空闲，false = 超时 */
  drain(timeoutMs: number): Promise<boolean>;
}

export function createDrainTracker(): DrainTracker {
  let inflight = 0;
  let waiters: Array<() => void> = [];

  const releaseAllIfIdle = (): void => {
    if (inflight !== 0) return;
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };

  const whenIdle = (): Promise<void> => {
    if (inflight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => { waiters.push(resolve); });
  };

  return {
    get inflight(): number {
      return inflight;
    },

    begin(): () => void {
      inflight += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inflight -= 1;
        releaseAllIfIdle();
      };
    },

    whenIdle,

    async drain(timeoutMs: number): Promise<boolean> {
      if (inflight === 0) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => { resolve(false); }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      });
      try {
        return await Promise.race([whenIdle().then(() => true), timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  };
}
