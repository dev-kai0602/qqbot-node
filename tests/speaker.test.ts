import { describe, expect, it } from 'vitest';
import { speakerLabel } from '../src/util/speaker.js';

describe('speakerLabel', () => {
  it('优先使用平台下发的昵称', () => {
    expect(speakerLabel('5556C0AB1BC88C7F96AC71D88C578684', '张三')).toBe('张三');
  });

  it('昵称为空或只有空格时回退到 openid 尾号', () => {
    expect(speakerLabel('5556C0AB1BC88C7F96AC71D88C578684')).toBe('用户8684');
    expect(speakerLabel('5556C0AB1BC88C7F96AC71D88C578684', '   ')).toBe('用户8684');
  });

  it('同一 openid 的标签稳定，不同 openid 不冲突', () => {
    const a = speakerLabel('5556C0AB1BC88C7F96AC71D88C578684');
    const b = speakerLabel('5556C0AB1BC88C7F96AC71D88C578684');
    const c = speakerLabel('503C58F379CB7D67092B2345406A6A9A');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('短 id 不会崩，给一个兜底标签', () => {
    expect(speakerLabel('ab')).toBe('某位用户');
    expect(speakerLabel('')).toBe('某位用户');
  });
});
