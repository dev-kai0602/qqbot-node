/**
 * 存储服务：优先 SQLite，失败则降级为内存并明确告警。
 *
 * 降级策略的理由：一个跑得起来但丢历史的机器人，好过直接起不来。
 * 但降级必须**显式可见**——所以打 error 级日志，并在启动汇总里带上 kind。
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../../types.js';
import { serializeError } from '../../util/errors.js';
import {
  createMemoryKVStore, createMemoryMessageStore, createMemorySpendStore
} from './memory.js';
import {
  createSqliteKVStore, createSqliteMessageStore, createSqliteSpendStore
} from './sqlite.js';
import type { StorageService } from './types.js';

export interface StorageOptions {
  log: Logger;
  dataDir: string;
  /** 消息保留天数；启动时清理更早的记录 */
  retentionDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function createStorage(opts: StorageOptions): StorageService {
  const dbPath = join(opts.dataDir, 'qqbot.db');
  try {
    mkdirSync(opts.dataDir, { recursive: true });
    const messages = createSqliteMessageStore(dbPath);
    const spend = createSqliteSpendStore(dbPath);
    const kv = createSqliteKVStore(dbPath);
    const removed = messages.pruneBefore(Date.now() - opts.retentionDays * DAY_MS);
    opts.log.info('storage ready', {
      kind: 'sqlite',
      location: dbPath,
      retentionDays: opts.retentionDays,
      pruned: removed
    });
    return {
      kind: 'sqlite',
      messages,
      spend,
      kv,
      location: dbPath,
      close: () => {
        messages.close();
        spend.close();
        kv.close();
      }
    };
  } catch (err) {
    opts.log.error('sqlite unavailable, falling back to memory store (history will not survive restart)', {
      error: serializeError(err)
    });
    const messages = createMemoryMessageStore();
    const spend = createMemorySpendStore();
    const kv = createMemoryKVStore();
    return {
      kind: 'memory',
      messages,
      spend,
      kv,
      location: null,
      close: () => {
        messages.close();
        spend.close();
        kv.close();
      }
    };
  }
}
