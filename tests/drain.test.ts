import { describe, expect, it } from 'vitest';
import { createDrainTracker } from '../src/util/drain.js';

describe('DrainTracker', () => {
  it('记录并释放在途任务', () => {
    const drain = createDrainTracker();
    const done = drain.begin();
    expect(drain.inflight).toBe(1);
    done();
    expect(drain.inflight).toBe(0);
  });

  it('重复释放不会把计数减成负数', () => {
    const drain = createDrainTracker();
    const done = drain.begin();
    done();
    done();
    expect(drain.inflight).toBe(0);
  });

  it('空闲时 whenIdle 立即 resolve', async () => {
    const drain = createDrainTracker();
    await expect(drain.whenIdle()).resolves.toBeUndefined();
  });

  it('全部结束后唤醒等待者', async () => {
    const drain = createDrainTracker();
    const a = drain.begin();
    const b = drain.begin();
    let woken = false;
    const waiting = drain.whenIdle().then(() => { woken = true; });
    expect(woken).toBe(false);
    a();
    await Promise.resolve();
    expect(woken).toBe(false);
    b();
    await waiting;
    expect(woken).toBe(true);
  });

  it('drain 在等到空闲时返回 true', async () => {
    const drain = createDrainTracker();
    const done = drain.begin();
    setTimeout(done, 10);
    await expect(drain.drain(200)).resolves.toBe(true);
  });

  it('drain 超时返回 false 且不丢在途计数', async () => {
    const drain = createDrainTracker();
    drain.begin();
    await expect(drain.drain(10)).resolves.toBe(false);
    expect(drain.inflight).toBe(1);
  });
});
