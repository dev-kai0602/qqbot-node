/**
 * 调度器：给插件用的周期性任务注册表。
 *
 * 它存在的**主要理由是错误边界**，不是「方便」：
 * setInterval 回调里抛出的异常会变成 uncaughtException，
 * 而本项目的策略是「记录后退出进程」——也就是说一个插件的定时任务出错，
 * 会把整个机器人重启一遍。所以在回调外面必须有一层 try/catch。
 *
 * 另外两个顺带的好处：
 *  - 上一次还没跑完就跳过本次，避免慢任务堆积
 *  - 统一在 close() 时清理，不依赖各插件自己记得 clearInterval
 */

import type { Logger, SchedulerService } from '../types.js';
import { serializeError } from '../util/errors.js';

interface Task {
  readonly name: string;
  readonly timer: ReturnType<typeof setInterval>;
  running: boolean;
}

export interface SchedulerOptions {
  log: Logger;
}

export function createScheduler(opts: SchedulerOptions): SchedulerService {
  const log = opts.log;
  const tasks = new Map<string, Task>();

  return {
    every(name: string, intervalMs: number, fn: (now: number) => void | Promise<void>): void {
      if (tasks.has(name)) {
        throw new Error('调度任务重名：' + name);
      }
      if (intervalMs <= 0) {
        throw new Error('调度间隔必须为正数：' + name);
      }

      const task: Task = { name, running: false, timer: setInterval(() => { void run(); }, intervalMs) };
      task.timer.unref();

      const run = async (): Promise<void> => {
        if (task.running) {
          log.warn('scheduler tick skipped (previous run still in progress)', { name });
          return;
        }
        task.running = true;
        try {
          await fn(Date.now());
        } catch (err) {
          // 关键：绝不让定时任务的异常冒到进程级
          log.error('scheduled task failed', { name, error: serializeError(err) });
        } finally {
          task.running = false;
        }
      };

      tasks.set(name, task);
      log.info('scheduled task registered', { name, intervalMs });
    },

    names(): readonly string[] {
      return [...tasks.keys()];
    },

    close(): void {
      for (const task of tasks.values()) clearInterval(task.timer);
      tasks.clear();
    }
  };
}
