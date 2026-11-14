import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStorage } from '../src/services/storage/index.js';
import type { Logger } from '../src/types.js';

const log: Logger = { info() {}, warn() {}, error() {}, debug() {} };

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-store-'));
  return fn(dir).finally(() => { rmSync(dir, { recursive: true, force: true }); });
}

describe('存储装配与降级', () => {
  it('node:sqlite 可用时落 SQLite，并在启动时清理过期消息', async () => {
    await withTempDir(async (dir) => {
      const storage = await createStorage({ log, dataDir: dir, retentionDays: 60 });
      expect(storage.kind).toBe('sqlite');
      expect(storage.location).toContain('qqbot.db');
      storage.messages.append('c2c:u1', { role: 'user', content: 'hi' });
      expect(storage.messages.count('c2c:u1')).toBe(1);
      storage.close();
    });
  });

  it('加载 sqlite 失败时降级为内存，而不是让进程起不来', async () => {
    await withTempDir(async (dir) => {
      const storage = await createStorage({
        log,
        dataDir: dir,
        retentionDays: 60,
        loadSqlite: () => Promise.reject(new Error('node:sqlite missing'))
      });
      expect(storage.kind).toBe('memory');
      expect(storage.location).toBeNull();
      // 降级后仍要可用，否则启动后面的装配全是空指针
      storage.messages.append('c2c:u1', { role: 'user', content: 'hi' });
      expect(storage.messages.count('c2c:u1')).toBe(1);
      storage.close();
    });
  });
});
