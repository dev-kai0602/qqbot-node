/**
 * 幂等去重窗口。
 *
 * 平台明确同一条消息可能被重复推送，处理前必须先过这一层。
 * 实现要点：
 *  - 惰性清理：只在插入时扫描过期项，不引入额外定时器
 *  - 条目上限：即使全部命中 TTL 也不会让内存无限增长
 *  - 可注入 now：便于测试，不用等真实时间
 */

export class DedupeWindow {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs = 5 * 60 * 1000, maxEntries = 10000) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.seen.size;
  }

  /** 返回 true 表示这是重复项，应当丢弃 */
  isDuplicate(key: string, now: number = Date.now()): boolean {
    this.evict(now);
    if (this.seen.has(key)) return true;
    this.seen.set(key, now);
    return false;
  }

  private evict(now: number): void {
    for (const [key, at] of this.seen) {
      if (now - at > this.ttlMs) this.seen.delete(key);
    }
    while (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next();
      if (oldest.done === true) break;
      this.seen.delete(oldest.value);
    }
  }
}
