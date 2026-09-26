import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';

interface Captured {
  out: string;
  err: string;
}

function capture(fn: () => void): Captured {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const stdout = process.stdout as unknown as { write: (c: unknown) => boolean };
  const stderr = process.stderr as unknown as { write: (c: unknown) => boolean };
  const origOut = stdout.write;
  const origErr = stderr.write;
  stdout.write = (c: unknown): boolean => { outChunks.push(String(c)); return true; };
  stderr.write = (c: unknown): boolean => { errChunks.push(String(c)); return true; };
  try {
    fn();
  } finally {
    stdout.write = origOut;
    stderr.write = origErr;
  }
  return { out: outChunks.join(''), err: errChunks.join('') };
}

const SECRET = 'super-secret-value-123456';

describe('logger 密钥脱敏', () => {
  it('AppSecret 不出现在 msg 里', () => {
    const log = createLogger({ level: 'debug', secrets: [SECRET] });
    const { out } = capture(() => { log.info('connecting with ' + SECRET); });
    expect(out).not.toContain(SECRET);
    expect(out).toContain('***');
  });

  it('AppSecret 不出现在 meta 及其嵌套结构里', () => {
    const log = createLogger({ level: 'debug', secrets: [SECRET] });
    const { out } = capture(() => {
      log.info('meta 脱敏', { appSecret: SECRET, nested: { token: SECRET }, ok: 'keep-me' });
    });
    expect(out).not.toContain(SECRET);
    expect(out).toContain('keep-me');
  });

  it('等级过滤生效：低于阈值的不输出', () => {
    const log = createLogger({ level: 'warn' });
    const { out, err } = capture(() => {
      log.info('should-be-dropped');
      log.warn('kept');
    });
    expect(out).not.toContain('should-be-dropped');
    expect(err).toContain('kept');
  });

  it('info 走 stdout，warn/error 走 stderr', () => {
    const log = createLogger({ level: 'debug' });
    const { out, err } = capture(() => { log.info('i-msg'); log.error('e-msg'); });
    expect(out).toContain('i-msg');
    expect(err).toContain('e-msg');
  });
});
