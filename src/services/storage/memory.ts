/**
 * 内存实现：测试用，也是 SQLite 不可用时的降级路径。
 * 与 SQLite 实现共享同一套截断语义（trimNewestFirst），避免两者行为漂移。
 */

import type { KVEntry, KVStore, MessageStore, SpendStore, StoredMessage } from './types.js';

interface Row {
  readonly id: number;
  readonly sessionKey: string;
  readonly at: number;
  readonly message: StoredMessage;
}

/**
 * 从最新往回累加，超字符上限即停，但**至少保留最新一条**。
 * 注意方向：入参是「由新到旧」，返回是「由旧到新」。
 */
export function trimNewestFirst<T extends { content: string }>(
  newestFirst: readonly T[],
  maxChars: number
): T[] {
  const kept: T[] = [];
  let total = 0;
  for (const item of newestFirst) {
    total += item.content.length;
    if (total > maxChars && kept.length > 0) break;
    kept.push(item);
  }
  return kept.reverse();
}

export function createMemoryKVStore(): KVStore {
  // 扁平 Map：命名空间与键用 \u0000 拼接，避免两者各自含分隔符时产生歧义
  const rows = new Map<string, string>();
  const composite = (ns: string, key: string): string => ns + '\u0000' + key;
  const split = (c: string): { ns: string; key: string } | undefined => {
    const sep = c.indexOf('\u0000');
    return sep < 0 ? undefined : { ns: c.slice(0, sep), key: c.slice(sep + 1) };
  };

  return {
    get(namespace: string, key: string): string | undefined {
      return rows.get(composite(namespace, key));
    },
    set(namespace: string, key: string, value: string): void {
      rows.set(composite(namespace, key), value);
    },
    remove(namespace: string, key: string): void {
      rows.delete(composite(namespace, key));
    },
    list(namespace: string, prefix: string, limit = 1000): KVEntry[] {
      const out: KVEntry[] = [];
      for (const [c, value] of rows) {
        const parts = split(c);
        if (parts === undefined || parts.ns !== namespace) continue;
        if (!parts.key.startsWith(prefix)) continue;
        out.push({ key: parts.key, value });
      }
      out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return out.slice(0, limit);
    },
    clearNamespace(namespace: string): number {
      let removed = 0;
      for (const c of [...rows.keys()]) {
        const parts = split(c);
        if (parts !== undefined && parts.ns === namespace) {
          rows.delete(c);
          removed += 1;
        }
      }
      return removed;
    },
    close(): void {
      rows.clear();
    }
  };
}

export function createMemorySpendStore(): SpendStore {
  const rows = new Map<string, number>();
  return {
    load(day: string): number | undefined {
      return rows.get(day);
    },
    save(day: string, spentCny: number): void {
      rows.set(day, spentCny);
    },
    close(): void {
      rows.clear();
    }
  };
}

export function createMemoryMessageStore(now: () => number = Date.now): MessageStore {
  const rows: Row[] = [];
  let seq = 0;

  const mine = (sessionKey: string): Row[] => rows.filter((r) => r.sessionKey === sessionKey);

  const removeWhere = (predicate: (row: Row) => boolean): number => {
    let removed = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (row !== undefined && predicate(row)) {
        rows.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  };

  return {
    append(sessionKey: string, message: StoredMessage): number {
      seq += 1;
      rows.push({ id: seq, sessionKey, at: now(), message });
      return seq;
    },

    recent(sessionKey: string, limit: number, maxChars: number): StoredMessage[] {
      if (limit <= 0) return [];
      const list = mine(sessionKey);
      const newestFirst = list.slice(-limit).reverse().map((r) => r.message);
      return trimNewestFirst(newestFirst, maxChars);
    },

    count(sessionKey: string): number {
      return mine(sessionKey).length;
    },

    clear(sessionKey: string): number {
      return removeWhere((row) => row.sessionKey === sessionKey);
    },

    deleteBySender(senderId: string): number {
      return removeWhere((row) => row.message.senderId === senderId);
    },

    countBySender(senderId: string): number {
      return rows.filter((row) => row.message.senderId === senderId).length;
    },

    pruneBefore(cutoffMs: number): number {
      return removeWhere((row) => row.at < cutoffMs);
    },

    close(): void {
      rows.length = 0;
    }
  };
}
