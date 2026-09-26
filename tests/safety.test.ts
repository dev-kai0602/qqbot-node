import { describe, expect, it } from 'vitest';
import { createSafetyService } from '../src/services/safety.js';

describe('SafetyService', () => {
  const s = createSafetyService();

  it('内置词命中', () => {
    expect(s.checkOutput('需要代开发票吗').hit).toBe(true);
  });

  it('干净文本不命中', () => {
    expect(s.checkInput('今天天气怎么样').hit).toBe(false);
    expect(s.checkOutput('北京今天晴，25 度。').hit).toBe(false);
  });

  it('身份证号被识别为隐私', () => {
    const v = s.checkOutput('他的身份证是 110101199003071234');
    expect(v.hit).toBe(true);
    expect(v.matched).toContain('PRIVACY');
  });

  it('可追加自定义词，且不影响未追加的实例', () => {
    const c = createSafetyService({ extraTerms: ['内部代号'] });
    expect(c.checkInput('这是内部代号').hit).toBe(true);
    expect(s.checkInput('这是内部代号').hit).toBe(false);
  });

  it('可自定义拒答话术', () => {
    expect(createSafetyService({ refusalText: 'NOPE' }).refusalText).toBe('NOPE');
  });
});
