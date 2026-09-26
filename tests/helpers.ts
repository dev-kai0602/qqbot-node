/**
 * 测试共用桩。
 *
 * 抽出来的理由很实际：每给 Services 加一个字段（budgetLimitCny、storage.spend、
 * timeZone、storage.kv …），散落在各测试里的手写桩就得逐个补，漏一个就是编译错误。
 * 新测试统一从这里取；老测试里的内联桩待后续迁移。
 */

import { createMemoryMessageStore } from '../src/services/storage/memory.js';
import type { KVStore, StorageService } from '../src/services/storage/types.js';
import type {
  AiService, Logger, MetricsService, SafetyService, SchedulerService, Services
} from '../src/types.js';

export const testLog: Logger = { info() {}, warn() {}, error() {}, debug() {} };

export function stubKV(): KVStore {
  return {
    get: () => undefined,
    set: () => {},
    remove: () => {},
    list: () => [],
    clearNamespace: () => 0,
    close: () => {}
  };
}

export function stubAi(overrides: Partial<AiService> = {}): AiService {
  return {
    available: false,
    chat: async () => ({ text: '', degraded: true }),
    spentCny: () => 0,
    budgetLimitCny: () => 0,
    contextSize: () => 0,
    resetContext: () => {},
    ...overrides
  };
}

export function stubSafety(): SafetyService {
  return {
    checkInput: () => ({ hit: false, matched: [] }),
    checkOutput: () => ({ hit: false, matched: [] }),
    refusalText: 'refused'
  };
}

export function stubMetrics(): MetricsService {
  return {
    inc: () => {},
    countEvent: () => {},
    addSpend: () => {},
    noteAiResult: () => {},
    snapshot: () => ({
      startedAt: 0,
      uptimeSec: 0,
      counters: {},
      eventsByKind: {},
      aiSpentCny: 0,
      aiBudgetCny: null,
      storageKind: 'memory'
    }),
    close: () => {}
  };
}

export function stubStorage(overrides: Partial<StorageService> = {}): StorageService {
  return {
    kind: 'memory',
    messages: createMemoryMessageStore(),
    spend: { load: () => undefined, save: () => {}, close: () => {} },
    kv: stubKV(),
    location: null,
    close: () => {},
    ...overrides
  };
}

/** 只登记不执行的调度器；测试里用 fire() 手动触发，不依赖真实定时器 */
export function stubScheduler(): SchedulerService & { fire(name: string, now: number): Promise<void> } {
  const tasks = new Map<string, (now: number) => void | Promise<void>>();
  return {
    every(name, _intervalMs, fn) {
      tasks.set(name, fn);
    },
    names: () => [...tasks.keys()],
    close: () => { tasks.clear(); },
    async fire(name: string, now: number): Promise<void> {
      const fn = tasks.get(name);
      if (fn === undefined) throw new Error('no such task: ' + name);
      await fn(now);
    }
  };
}

export function stubServices(overrides: Partial<Services> = {}): Services {
  return {
    log: testLog,
    dataDir: 'data',
    timeZone: 'Asia/Shanghai',
    ai: stubAi(),
    safety: stubSafety(),
    storage: stubStorage(),
    metrics: stubMetrics(),
    scheduler: stubScheduler(),
    ...overrides
  };
}
