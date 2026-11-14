/**
 * 存储服务：优先 SQLite，失败则降级为内存并明确告警。
 *
 * 降级策略的理由：一个跑得起来但丢历史的机器人，好过直接起不来。
 * 但降级必须**显式可见**——所以打 error 级日志，并在启动汇总里带上 kind。
 *
 * sqlite 模块刻意用**动态 import**：node:sqlite 在 Node < 22.13 上不存在，
 * 静态 import 会让进程在模块加载阶段就崩掉，那时连这里的 try/catch 都还没执行，
 * 「降级到内存」永远走不到。改成动态加载后，缺模块只是一次普通的 load 失败。
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../../types.js';
import { serializeError } from '../../util/errors.js';
import {
  createMemoryKVStore, createMemoryMessageStore, createMemorySpendStore
} from './memory.js';
import type { StorageService } from './types.js';

type SqliteModule = typeof import('./sqlite.js');

export interface StorageOptions {
  log: Logger;
  dataDir: string;
  /** 消息保留天数；启动时清理更早的记录 */
  retentionDays: number;
  /** 测试用：替换 node:sqlite 的加载方式（默认动态 import） */
  loadSqlite?: () => Promise<SqliteModule>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function memoryStorage(): StorageService {
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

export async function createStorage(opts: StorageOptions): Promise<StorageService> {
  const dbPath = join(opts.dataDir, 'qqbot.db');
  const opened: Array<{ close(): void }> = [];
  try {
    mkdirSync(opts.dataDir, { recursive: true });
    const load = opts.loadSqlite ?? ((): Promise<SqliteModule> => import('./sqlite.js'));
    const sqlite = await load();

    const messages = sqlite.createSqliteMessageStore(dbPath);
    opened.push(messages);
    const spend = sqlite.createSqliteSpendStore(dbPath);
    opened.push(spend);
    const kv = sqlite.createSqliteKVStore(dbPath);
    opened.push(kv);

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
    // 已经打开的连接要关掉，否则降级之后还留着几个句柄
    for (const store of opened) {
      try {
        store.close();
      } catch {
        /* 关不掉也不影响降级 */
      }
    }
    opts.log.error('sqlite unavailable, falling back to memory store (history will not survive restart)', {
      error: serializeError(err),
      node: process.version,
      requiredNode: '>=22.13.0'
    });
    return memoryStorage();
  }
}
