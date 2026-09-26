/**
 * 结构化 JSON 日志 + 密钥脱敏。
 *
 * 约定：
 *  - 只写 stdout / stderr；文件与轮转交给 systemd / journald。
 *    原先用 appendFileSync 直写文件有两个问题：同步 IO 阻塞事件循环，且文件无上限增长。
 *  - 不落消息正文，只落元数据与长度。
 *  - AppSecret 等字面量一律替换为 ***。
 */

import type { LogLevel, Logger } from './types.js';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level: LogLevel;
  /** 需要脱敏的字面量，例如 AppSecret */
  secrets?: readonly string[];
}

export function createLogger(opts: LoggerOptions): Logger {
  const threshold = ORDER[opts.level];
  const secrets = (opts.secrets ?? []).filter((s) => s.length >= 6);

  const scrub = (text: string): string => {
    let out = text;
    for (const secret of secrets) out = out.split(secret).join('***');
    return out;
  };

  const write = (level: LogLevel, msg: string, meta?: Record<string, unknown>): void => {
    if (ORDER[level] < threshold) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg: scrub(msg)
    };
    if (meta !== undefined) {
      try {
        record['meta'] = JSON.parse(scrub(JSON.stringify(meta))) as unknown;
      } catch {
        record['meta'] = '[unserializable]';
      }
    }
    const line = scrub(JSON.stringify(record)) + '\n';
    if (level === 'error' || level === 'warn') process.stderr.write(line);
    else process.stdout.write(line);
  };

  return {
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta)
  };
}
