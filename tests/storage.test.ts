import { describe, expect, it } from 'vitest';
import {
  createMemoryKVStore, createMemoryMessageStore, createMemorySpendStore
} from '../src/services/storage/memory.js';
import {
  createSqliteKVStore, createSqliteMessageStore, createSqliteSpendStore
} from '../src/services/storage/sqlite.js';
import type { KVStore, MessageStore } from '../src/services/storage/types.js';

function contract(name: string, make: () => MessageStore): void {
  describe(name, () => {
    it('append + recent 按时间正序返回，并保留说话人与发送者', () => {
      const s = make();
      s.append('k', { role: 'user', content: 'a' });
      s.append('k', { role: 'assistant', content: 'b' });
      s.append('k', { role: 'user', content: 'c', speaker: '张三', senderId: 'OP1' });
      const got = s.recent('k', 10, 1000);
      expect(got.map((m) => m.content)).toEqual(['a', 'b', 'c']);
      expect(got[0]?.speaker).toBeUndefined();
      expect(got[0]?.senderId).toBeUndefined();
      expect(got[2]?.speaker).toBe('张三');
      expect(got[2]?.senderId).toBe('OP1');
    });

    it('limit 只取最近 N 条', () => {
      const s = make();
      for (const t of ['1', '2', '3', '4', '5']) s.append('k', { role: 'user', content: t });
      expect(s.recent('k', 3, 1000).map((m) => m.content)).toEqual(['3', '4', '5']);
    });

    it('maxChars 从最旧开始丢，且至少保留最新一条', () => {
      const s = make();
      s.append('k', { role: 'user', content: '12345' });
      s.append('k', { role: 'user', content: '67890' });
      s.append('k', { role: 'user', content: 'abcde' });
      const got = s.recent('k', 100, 10);
      expect(got.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(10);
      expect(got[got.length - 1]?.content).toBe('abcde');

      const tiny = make();
      tiny.append('k', { role: 'user', content: 'x'.repeat(50) });
      expect(tiny.recent('k', 100, 5).length).toBe(1);
    });

    it('会话之间互不干扰', () => {
      const s = make();
      s.append('a', { role: 'user', content: 'x' });
      s.append('b', { role: 'user', content: 'y' });
      expect(s.count('a')).toBe(1);
      expect(s.count('b')).toBe(1);
      expect(s.recent('a', 10, 100).map((m) => m.content)).toEqual(['x']);
    });

    it('clear 只清指定会话，并返回删除条数', () => {
      const s = make();
      s.append('a', { role: 'user', content: 'x' });
      s.append('a', { role: 'assistant', content: 'y' });
      s.append('b', { role: 'user', content: 'z' });
      expect(s.clear('a')).toBe(2);
      expect(s.count('a')).toBe(0);
      expect(s.count('b')).toBe(1);
    });

    it('deleteBySender 跨会话删除某人的消息，不动别人', () => {
      const s = make();
      s.append('g1', { role: 'user', content: 'a', senderId: 'ME' });
      s.append('g1', { role: 'assistant', content: 'b' });
      s.append('g1', { role: 'user', content: 'c', senderId: 'OTHER' });
      s.append('c2c:ME', { role: 'user', content: 'd', senderId: 'ME' });
      expect(s.countBySender('ME')).toBe(2);
      expect(s.deleteBySender('ME')).toBe(2);
      expect(s.countBySender('ME')).toBe(0);
      expect(s.countBySender('OTHER')).toBe(1);
      expect(s.count('g1')).toBe(2);
    });

    it('pruneBefore 删除保留期之前的记录', () => {
      const s = make();
      s.append('k', { role: 'user', content: 'x' });
      s.append('k', { role: 'assistant', content: 'y' });
      expect(s.pruneBefore(Date.now() + 1000)).toBe(2);
      expect(s.count('k')).toBe(0);
    });
  });
}

contract('MemoryMessageStore', () => createMemoryMessageStore());
contract('SqliteMessageStore', () => createSqliteMessageStore(':memory:'));

async function tempDir(): Promise<{ dir: string; file: (n: string) => string; cleanup: () => void }> {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-test-'));
  return {
    dir,
    file: (n: string) => join(dir, n),
    cleanup: () => { rmSync(dir, { recursive: true, force: true }); }
  };
}

function kvContract(name: string, make: () => KVStore): void {
  describe(name, () => {
    it('set / get / remove 基本读写', () => {
      const s = make();
      expect(s.get('ns', 'k')).toBeUndefined();
      s.set('ns', 'k', 'v1');
      expect(s.get('ns', 'k')).toBe('v1');
      s.set('ns', 'k', 'v2');
      expect(s.get('ns', 'k')).toBe('v2');
      s.remove('ns', 'k');
      expect(s.get('ns', 'k')).toBeUndefined();
    });

    it('list 按键升序返回前缀匹配项', () => {
      const s = make();
      s.set('ns', 'g1|u1|2026-09-23', 'a');
      s.set('ns', 'g1|u1|2026-09-24', 'b');
      s.set('ns', 'g1|u2|2026-09-24', 'c');
      expect(s.list('ns', 'g1|u1|').map((e) => e.key)).toEqual([
        'g1|u1|2026-09-23',
        'g1|u1|2026-09-24'
      ]);
    });

    it('前缀为空返回整个命名空间', () => {
      const s = make();
      s.set('ns', 'a', '1');
      s.set('ns', 'b', '2');
      expect(s.list('ns', '').length).toBe(2);
    });

    it('命名空间之间互相隔离', () => {
      const s = make();
      s.set('ns1', 'k', 'v1');
      s.set('ns2', 'k', 'v2');
      expect(s.get('ns1', 'k')).toBe('v1');
      expect(s.get('ns2', 'k')).toBe('v2');
      expect(s.list('ns1', '').length).toBe(1);
    });

    it('clearNamespace 只清指定命名空间，并返回条数', () => {
      const s = make();
      s.set('ns1', 'a', '1');
      s.set('ns1', 'b', '2');
      s.set('ns2', 'a', '3');
      expect(s.clearNamespace('ns1')).toBe(2);
      expect(s.list('ns1', '').length).toBe(0);
      expect(s.get('ns2', 'a')).toBe('3');
    });

    it('前缀含 % 或 _ 时不被当成通配符（LIKE 陷阱回归）', () => {
      const s = make();
      s.set('ns', 'a%b|1', 'v1');
      s.set('ns', 'axb|1', 'v2');
      s.set('ns', 'a_b|1', 'v3');
      s.set('ns', 'aXb|1', 'v4');
      expect(s.list('ns', 'a%b|').map((e) => e.value)).toEqual(['v1']);
      expect(s.list('ns', 'a_b|').map((e) => e.value)).toEqual(['v3']);
    });
  });
}

kvContract('MemoryKVStore', () => createMemoryKVStore());
kvContract('SqliteKVStore', () => createSqliteKVStore(':memory:'));

describe('SpendStore', () => {
  it('memory：未记录返回 undefined，可覆盖', () => {
    const s = createMemorySpendStore();
    expect(s.load('2026-09-24')).toBeUndefined();
    s.save('2026-09-24', 1.5);
    expect(s.load('2026-09-24')).toBe(1.5);
    s.save('2026-09-24', 2.5);
    expect(s.load('2026-09-24')).toBe(2.5);
    s.close();
  });

  it('sqlite：关库重开后仍在（跨重启的根据）', async () => {
    const t = await tempDir();
    try {
      const first = createSqliteSpendStore(t.file('spend.db'));
      first.save('2026-09-24', 3.25);
      first.close();

      const second = createSqliteSpendStore(t.file('spend.db'));
      expect(second.load('2026-09-24')).toBe(3.25);
      expect(second.load('2026-09-25')).toBeUndefined();
      second.close();
    } finally {
      t.cleanup();
    }
  });
});

describe('SqliteMessageStore 持久化与迁移', () => {
  it('关闭后重开同一文件，历史仍在（这是选 SQLite 的全部理由）', async () => {
    const t = await tempDir();
    try {
      const first = createSqliteMessageStore(t.file('test.db'));
      first.append('g1', { role: 'user', content: '记得我说过的话', speaker: 'Kai', senderId: 'OP1' });
      first.append('g1', { role: 'assistant', content: '记住了' });
      first.close();

      const second = createSqliteMessageStore(t.file('test.db'));
      const got = second.recent('g1', 10, 1000);
      expect(got.length).toBe(2);
      expect(got[0]?.content).toBe('记得我说过的话');
      expect(got[0]?.speaker).toBe('Kai');
      expect(got[0]?.senderId).toBe('OP1');
      second.close();
    } finally {
      t.cleanup();
    }
  });

  it('老库（缺 sender_id 列）能自动迁移：旧数据可读，新列可用', async () => {
    const t = await tempDir();
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const legacy = new DatabaseSync(t.file('legacy.db'));
      legacy.exec([
        'CREATE TABLE messages (',
        '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
        '  session_key TEXT NOT NULL,',
        '  role TEXT NOT NULL,',
        '  speaker TEXT,',
        '  content TEXT NOT NULL,',
        '  created_at INTEGER NOT NULL',
        ')'
      ].join('\n'));
      legacy
        .prepare('INSERT INTO messages (session_key, role, speaker, content, created_at) VALUES (?,?,?,?,?)')
        .run('c2c:x', 'user', null, '旧数据', Date.now());
      legacy.close();

      const store = createSqliteMessageStore(t.file('legacy.db'));
      expect(store.recent('c2c:x', 10, 1000)[0]?.content).toBe('旧数据');
      // 单聊老数据可精确回填：会话键里就是 openid
      expect(store.countBySender('x')).toBe(1);
      expect(store.deleteBySender('x')).toBe(1);
      store.append('c2c:x', { role: 'user', content: '新数据', senderId: 'ME' });
      expect(store.countBySender('ME')).toBe(1);
      store.close();
    } finally {
      t.cleanup();
    }
  });
});
