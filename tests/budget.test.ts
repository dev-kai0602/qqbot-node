import { describe, expect, it } from 'vitest';
import { DailyBudget } from '../src/services/ai/budget.js';
import { createMemorySpendStore } from '../src/services/storage/memory.js';

describe('DailyBudget', () => {
  it('输入与输出分别计价并累加', () => {
    const b = new DailyBudget({ dailyLimitCny: 100, priceInputCnyPerM: 2, priceOutputCnyPerM: 10 });
    expect(b.record(1_000_000, 0)).toBeCloseTo(2, 6);
    expect(b.record(0, 1_000_000)).toBeCloseTo(10, 6);
    expect(b.spentCny()).toBeCloseTo(12, 6);
  });

  it('花满额度后 canSpend 变 false', () => {
    const b = new DailyBudget({ dailyLimitCny: 1, priceInputCnyPerM: 1, priceOutputCnyPerM: 1 });
    expect(b.canSpend()).toBe(true);
    b.record(1_000_000, 0);
    expect(b.spentCny()).toBeCloseTo(1, 6);
    expect(b.canSpend()).toBe(false);
  });

  it('跨重启恢复当日花费（这正是熔断器必须落库的原因）', () => {
    const store = createMemorySpendStore();
    const first = new DailyBudget({
      dailyLimitCny: 20, priceInputCnyPerM: 1, priceOutputCnyPerM: 0, persistence: store
    });
    first.record(1_000_000, 0);
    expect(first.spentCny()).toBeCloseTo(1, 6);

    // 模拟进程重启：新实例，同一份持久化
    const second = new DailyBudget({
      dailyLimitCny: 20, priceInputCnyPerM: 1, priceOutputCnyPerM: 0, persistence: store
    });
    expect(second.spentCny()).toBeCloseTo(1, 6);
  });

  it('跨日切到新的一天，且前一天记录不受影响', () => {
    const store = createMemorySpendStore();
    let now = new Date(2026, 8, 22, 12, 0, 0).getTime();
    const b = new DailyBudget({
      dailyLimitCny: 20, priceInputCnyPerM: 1, priceOutputCnyPerM: 0,
      now: () => now, persistence: store
    });
    b.record(1_000_000, 0);
    expect(store.load('2026-09-22')).toBeCloseTo(1, 6);

    now = new Date(2026, 8, 23, 0, 0, 1).getTime();
    expect(b.spentCny()).toBe(0);
    expect(b.currentDay()).toBe('2026-09-23');
    b.record(500_000, 0);
    expect(store.load('2026-09-23')).toBeCloseTo(0.5, 6);
    expect(store.load('2026-09-22')).toBeCloseTo(1, 6);
  });

  it('持久化失败只回调，不抛错、不中断记账', () => {
    const errors: unknown[] = [];
    const broken = {
      load: (): number | undefined => { throw new Error('load boom'); },
      save: (): void => { throw new Error('save boom'); },
      close: (): void => {}
    };
    const b = new DailyBudget({
      dailyLimitCny: 20, priceInputCnyPerM: 1, priceOutputCnyPerM: 0,
      persistence: broken, onPersistError: (e) => { errors.push(e); }
    });
    expect(b.spentCny()).toBe(0);
    expect(() => b.record(1_000_000, 0)).not.toThrow();
    expect(b.spentCny()).toBeCloseTo(1, 6);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it('跨日自动清零（UTC 口径）', () => {
    let now = Date.UTC(2026, 8, 22, 23, 0, 0);
    const b = new DailyBudget({
      dailyLimitCny: 1,
      priceInputCnyPerM: 1,
      priceOutputCnyPerM: 0,
      now: () => now,
      timeZone: 'UTC'
    });
    b.record(1_000_000, 0);
    expect(b.spentCny()).toBeCloseTo(1, 6);
    expect(b.canSpend()).toBe(false);
    now = Date.UTC(2026, 8, 23, 0, 0, 1);
    expect(b.spentCny()).toBe(0);
    expect(b.canSpend()).toBe(true);
  });

  it('「今天」按时区判定：UTC 16:00 才是上海的次日零点', () => {
    // 服务器跑在 UTC，若直接用本地日期，预算会在北京时间早上 8 点归零
    let now = Date.UTC(2026, 8, 22, 15, 30, 0);   // 上海 23:30，仍是 09-22
    const b = new DailyBudget({
      dailyLimitCny: 20, priceInputCnyPerM: 1, priceOutputCnyPerM: 0,
      now: () => now, timeZone: 'Asia/Shanghai'
    });
    b.record(1_000_000, 0);
    expect(b.currentDay()).toBe('2026-09-22');
    expect(b.spentCny()).toBeCloseTo(1, 6);

    now = Date.UTC(2026, 8, 22, 16, 30, 0);       // 上海 00:30，已跨日
    expect(b.currentDay()).toBe('2026-09-23');
    expect(b.spentCny()).toBe(0);
  });
});
