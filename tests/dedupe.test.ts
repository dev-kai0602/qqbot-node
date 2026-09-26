import { describe, expect, it } from 'vitest';
import { DedupeWindow } from '../src/util/dedupe.js';

describe('DedupeWindow', () => {
  it('首次不是重复，第二次是', () => {
    const w = new DedupeWindow(1000);
    expect(w.isDuplicate('m1', 0)).toBe(false);
    expect(w.isDuplicate('m1', 10)).toBe(true);
  });

  it('不同 key 互不影响', () => {
    const w = new DedupeWindow(1000);
    expect(w.isDuplicate('a', 0)).toBe(false);
    expect(w.isDuplicate('b', 0)).toBe(false);
    expect(w.isDuplicate('a', 0)).toBe(true);
  });

  it('超过 TTL 后重新放行', () => {
    const w = new DedupeWindow(1000);
    w.isDuplicate('m1', 0);
    expect(w.isDuplicate('m1', 1001)).toBe(false);
  });

  it('条目数不超过上限（防内存无限增长）', () => {
    const w = new DedupeWindow(60000, 3);
    for (const k of ['a', 'b', 'c', 'd', 'e']) w.isDuplicate(k, 0);
    expect(w.size).toBeLessThanOrEqual(3);
  });
});
