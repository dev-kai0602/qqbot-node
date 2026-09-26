import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScheduler } from '../src/services/scheduler.js';
import type { Logger } from '../src/types.js';

function capturingLog(): { log: Logger; errors: string[]; warns: string[] } {
  const errors: string[] = [];
  const warns: string[] = [];
  return {
    errors,
    warns,
    log: {
      info() {},
      debug() {},
      warn: (m) => { warns.push(m); },
      error: (m) => { errors.push(m); }
    }
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('SchedulerService', () => {
  it('回调抛错被接住，不会变成进程级异常（这是它存在的首要理由）', async () => {
    vi.useFakeTimers();
    const { log, errors } = capturingLog();
    const s = createScheduler({ log });
    s.every('boom', 1000, () => { throw new Error('boom'); });
    await vi.advanceTimersByTimeAsync(1100);
    expect(errors).toContain('scheduled task failed');
    s.close();
  });

  it('async 回调 reject 同样被接住', async () => {
    vi.useFakeTimers();
    const { log, errors } = capturingLog();
    const s = createScheduler({ log });
    s.every('async-boom', 1000, async () => { throw new Error('boom'); });
    await vi.advanceTimersByTimeAsync(1100);
    expect(errors).toContain('scheduled task failed');
    s.close();
  });

  it('上一次还没跑完时跳过本次，避免慢任务堆积', async () => {
    vi.useFakeTimers();
    const { log, warns } = capturingLog();
    const s = createScheduler({ log });
    let concurrent = 0;
    let maxConcurrent = 0;
    s.every('slow', 100, async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 250));
      concurrent -= 1;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(maxConcurrent).toBe(1);
    expect(warns.length).toBeGreaterThan(0);
    s.close();
  });

  it('任务重名与非法间隔直接报错', () => {
    const { log } = capturingLog();
    const s = createScheduler({ log });
    s.every('dup', 1000, () => {});
    expect(() => s.every('dup', 1000, () => {})).toThrow(/重名/);
    expect(() => s.every('zero', 0, () => {})).toThrow(/正数/);
    expect(s.names()).toEqual(['dup']);
    s.close();
  });

  it('close 之后不再触发', async () => {
    vi.useFakeTimers();
    const { log } = capturingLog();
    const s = createScheduler({ log });
    let ticks = 0;
    s.every('counting', 100, () => { ticks += 1; });
    await vi.advanceTimersByTimeAsync(350);
    const before = ticks;
    s.close();
    await vi.advanceTimersByTimeAsync(500);
    expect(ticks).toBe(before);
    expect(s.names()).toEqual([]);
  });
});
