import { describe, expect, it } from 'vitest';
import { dayKey, shiftDay } from '../src/util/day.js';

describe('dayKey', () => {
  it('按指定时区计算，UTC 与上海可差一天', () => {
    // 2026-09-24T16:30:00Z → 上海已是 09-25 00:30
    const ms = Date.UTC(2026, 8, 24, 16, 30, 0);
    expect(dayKey('UTC', ms)).toBe('2026-09-24');
    expect(dayKey('Asia/Shanghai', ms)).toBe('2026-09-25');
  });

  it('上海凌晨属于当天，而不是 UTC 的前一天', () => {
    const ms = Date.UTC(2026, 8, 24, 0, 30, 0);   // 上海 08:30
    expect(dayKey('Asia/Shanghai', ms)).toBe('2026-09-24');
  });

  it('非法时区退回 UTC，不抛错', () => {
    const ms = Date.UTC(2026, 8, 24, 12, 0, 0);
    expect(dayKey('Not/AZone', ms)).toBe('2026-09-24');
  });
});

describe('shiftDay', () => {
  it('跨月、跨年、闰年都正确', () => {
    expect(shiftDay('2026-09-24', -1)).toBe('2026-09-23');
    expect(shiftDay('2026-09-01', -1)).toBe('2026-08-31');
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDay('2024-03-01', -1)).toBe('2024-02-29');
    expect(shiftDay('2026-09-24', 1)).toBe('2026-09-25');
  });

  it('输入畸形时原样返回，不抛错', () => {
    expect(shiftDay('nonsense', -1)).toBe('nonsense');
  });
});
