/**
 * SQLite 实现（Node 22 内置的 node:sqlite，零原生依赖）。
 *
 * 三个刻意的选择：
 *  - **存原始文本 + 昵称 + 发送者 openid**，不存渲染后的 `[昵称] xxx`。
 *    这样数据库里是干净的聊天记录，前缀渲染只发生在读取时，改格式不用迁移数据。
 *  - **记 sender_id**：昵称会变会重名，只有 openid 能可靠定位「某人的数据」。
 *  - WAL + synchronous=NORMAL：断电最多丢最后几条，换来写入不打满磁盘。
 *
 * 另外：node:sqlite 是**同步 API**，跑在单一 Node 线程上，写入天然串行，
 * 因此不需要额外的单写者队列。
 */

import { DatabaseSync } from 'node:sqlite';
import type { KVEntry, KVStore, MessageStore, SpendStore, StoredMessage } from './types.js';
import { trimNewestFirst } from './memory.js';

interface MessageRow {
  readonly role: string;
  readonly speaker: string | null;
  readonly content: string;
  readonly sender_id: string | null;
}

interface CountRow {
  readonly c: number | bigint;
}

function toStored(row: MessageRow): StoredMessage {
  const speaker = row.speaker;
  const senderId = row.sender_id;
  return {
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    ...(speaker !== null && speaker !== '' ? { speaker } : {}),
    ...(senderId !== null && senderId !== '' ? { senderId } : {})
  };
}

/**
 * 轻量迁移：老库里没有 sender_id 列时补上，并尽量回填。
 *
 * 加列用 try/catch 而不是先 PRAGMA 探测——新库建表时已含该列，ALTER 必然失败，
 * 那正是「已是最新结构」的信号，不值得为此多一次查询。
 *
 * 回填只做**能精确还原**的那部分：单聊会话键就是 `c2c:<openid>`，
 * 所以里面的 user 消息发送者可以确定。群聊老数据只有昵称，无法可靠归属，
 * 宁可留空也不猜——猜错等于把别人的数据算到某个人头上。
 */
function migrate(db: DatabaseSync): void {
  try {
    db.exec('ALTER TABLE messages ADD COLUMN sender_id TEXT');
  } catch {
    /* 列已存在 */
  }
  try {
    db.exec([
      'UPDATE messages SET sender_id = substr(session_key, 5)',
      "WHERE sender_id IS NULL AND role = 'user' AND session_key LIKE 'c2c:%'"
    ].join(' '));
  } catch {
    /* 表结构不符或为空，忽略 */
  }
}

/**
 * 与消息共用同一个数据库文件，但**各自持有连接**。
 * SQLite 本就是为多连接设计的，WAL 下写入自动串行；
 * 代价是两个文件句柄，换来的是两个 store 互不依赖、可单独测试。
 */
/** 插件私有 KV；同样独立连接、独立建表 */
export function createSqliteKVStore(path: string): KVStore {
  const db = new DatabaseSync(path);
  db.exec([
    'CREATE TABLE IF NOT EXISTS kv (',
    '  namespace TEXT NOT NULL,',
    '  key TEXT NOT NULL,',
    '  value TEXT NOT NULL,',
    '  updated_at INTEGER NOT NULL,',
    '  PRIMARY KEY (namespace, key)',
    ')'
  ].join('\n'));

  const getStmt = db.prepare('SELECT value FROM kv WHERE namespace = ? AND key = ?');
  const setStmt = db.prepare([
    'INSERT INTO kv (namespace, key, value, updated_at) VALUES (?, ?, ?, ?)',
    'ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ].join(' '));
  const removeStmt = db.prepare('DELETE FROM kv WHERE namespace = ? AND key = ?');
  // 用 substr 而不是 LIKE：LIKE 会把前缀里的 % 和 _ 当通配符，
  // 而 key 可能包含用户可控内容，不该把转义负担推给调用方。
  const listStmt = db.prepare([
    'SELECT key, value FROM kv',
    'WHERE namespace = ? AND substr(key, 1, ?) = ?',
    'ORDER BY key LIMIT ?'
  ].join(' '));
  const clearStmt = db.prepare('DELETE FROM kv WHERE namespace = ?');

  return {
    get(namespace: string, key: string): string | undefined {
      const row = getStmt.get(namespace, key) as unknown as { value: string } | undefined;
      return row === undefined ? undefined : row.value;
    },
    set(namespace: string, key: string, value: string): void {
      setStmt.run(namespace, key, value, Date.now());
    },
    remove(namespace: string, key: string): void {
      removeStmt.run(namespace, key);
    },
    list(namespace: string, prefix: string, limit = 1000): KVEntry[] {
      const rows = listStmt.all(namespace, prefix.length, prefix, limit) as unknown as KVEntry[];
      return rows.map((r) => ({ key: r.key, value: r.value }));
    },
    clearNamespace(namespace: string): number {
      return Number(clearStmt.run(namespace).changes);
    },
    close(): void {
      db.close();
    }
  };
}

export function createSqliteSpendStore(path: string): SpendStore {
  const db = new DatabaseSync(path);
  db.exec([
    'CREATE TABLE IF NOT EXISTS daily_spend (',
    '  day TEXT PRIMARY KEY,',
    '  spent_cny REAL NOT NULL,',
    '  updated_at INTEGER NOT NULL',
    ')'
  ].join('\n'));

  const loadStmt = db.prepare('SELECT spent_cny FROM daily_spend WHERE day = ?');
  const saveStmt = db.prepare([
    'INSERT INTO daily_spend (day, spent_cny, updated_at) VALUES (?, ?, ?)',
    'ON CONFLICT(day) DO UPDATE SET spent_cny = excluded.spent_cny, updated_at = excluded.updated_at'
  ].join(' '));

  return {
    load(day: string): number | undefined {
      const row = loadStmt.get(day) as unknown as { spent_cny: number } | undefined;
      return row === undefined ? undefined : Number(row.spent_cny);
    },
    save(day: string, spentCny: number): void {
      saveStmt.run(day, spentCny, Date.now());
    },
    close(): void {
      db.close();
    }
  };
}

export function createSqliteMessageStore(path: string): MessageStore {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec([
    'CREATE TABLE IF NOT EXISTS messages (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  session_key TEXT NOT NULL,',
    '  role TEXT NOT NULL,',
    '  speaker TEXT,',
    '  sender_id TEXT,',
    '  content TEXT NOT NULL,',
    '  created_at INTEGER NOT NULL',
    ')'
  ].join('\n'));
  migrate(db);
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_key, id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id)');

  const insertStmt = db.prepare(
    'INSERT INTO messages (session_key, role, speaker, sender_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const recentStmt = db.prepare(
    'SELECT role, speaker, sender_id, content FROM messages WHERE session_key = ? ORDER BY id DESC LIMIT ?'
  );
  const countStmt = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_key = ?');
  const countSenderStmt = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE sender_id = ?');
  const clearStmt = db.prepare('DELETE FROM messages WHERE session_key = ?');
  const deleteSenderStmt = db.prepare('DELETE FROM messages WHERE sender_id = ?');
  const pruneStmt = db.prepare('DELETE FROM messages WHERE created_at < ?');

  const countOf = (row: CountRow | undefined): number => (row === undefined ? 0 : Number(row.c));

  return {
    append(sessionKey: string, message: StoredMessage): number {
      const result = insertStmt.run(
        sessionKey,
        message.role,
        message.speaker ?? null,
        message.senderId ?? null,
        message.content,
        Date.now()
      );
      return Number(result.lastInsertRowid);
    },

    recent(sessionKey: string, limit: number, maxChars: number): StoredMessage[] {
      if (limit <= 0) return [];
      const rows = recentStmt.all(sessionKey, limit) as unknown as MessageRow[];
      return trimNewestFirst(rows.map(toStored), maxChars);
    },

    count(sessionKey: string): number {
      return countOf(countStmt.get(sessionKey) as unknown as CountRow | undefined);
    },

    clear(sessionKey: string): number {
      return Number(clearStmt.run(sessionKey).changes);
    },

    deleteBySender(senderId: string): number {
      return Number(deleteSenderStmt.run(senderId).changes);
    },

    countBySender(senderId: string): number {
      return countOf(countSenderStmt.get(senderId) as unknown as CountRow | undefined);
    },

    pruneBefore(cutoffMs: number): number {
      return Number(pruneStmt.run(cutoffMs).changes);
    },

    close(): void {
      db.close();
    }
  };
}
