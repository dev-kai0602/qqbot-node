import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '../src/plugins/registry.js';
import { createPluginConfig } from '../src/plugins/config.js';
import { createMemoryMessageStore } from '../src/services/storage/memory.js';
import type { StorageService } from '../src/services/storage/types.js';
import type {
  AiService, BotApi, BotContext, Logger, MetricsService, Plugin, SafetyService, Services
} from '../src/types.js';

const log: Logger = { info() {}, warn() {}, error() {}, debug() {} };
const api: BotApi = { reply: async () => {}, send: async () => {} };

const ai: AiService = {
  available: false,
  chat: async () => ({ text: '', degraded: true }),
  spentCny: () => 0,
  budgetLimitCny: () => 0,
  contextSize: () => 0,
  resetContext: () => {}
};

const safety: SafetyService = {
  checkInput: () => ({ hit: false, matched: [] }),
  checkOutput: () => ({ hit: false, matched: [] }),
  refusalText: 'no'
};

const storage: StorageService = {
  kind: 'memory',
  messages: createMemoryMessageStore(),
  spend: { load: () => undefined, save: () => {}, close: () => {} },
  kv: { get: () => undefined, set: () => {}, remove: () => {}, list: () => [], clearNamespace: () => 0, close: () => {} },
  location: null,
  close: () => {}
};

const metrics: MetricsService = {
  inc: () => {},
  countEvent: () => {},
  addSpend: () => {},
  noteAiResult: () => {},
  snapshot: () => ({
    startedAt: 0, uptimeSec: 0, counters: {}, eventsByKind: {},
    aiSpentCny: 0, aiBudgetCny: null, storageKind: 'memory'
  }),
  close: () => {}
};
const services: Services = {
  log,
  dataDir: 'data',
  timeZone: 'UTC',
  ai,
  safety,
  storage,
  metrics,
  scheduler: { every: () => {}, names: () => [], close: () => {} }
};

function eventCtx(content: string): BotContext {
  return {
    event: {
      rawEventType: 'C2C_MESSAGE_CREATE',
      kind: 'c2c',
      senderId: 'u1',
      content,
      messageId: 'm1',
      timestamp: '0'
    },
    target: { scope: 'c2c', targetId: 't1' },
    state: {},
    log
  };
}

function boot(reg: PluginRegistry, plugins: Plugin[]): Promise<void> {
  for (const p of plugins) reg.add(p);
  return reg.setupAll(api, (p) => createPluginConfig({}, p.defaults ?? {}), services);
}

describe('PluginRegistry 错误隔离', () => {
  it('插件抛错不影响后续插件', async () => {
    const seen: string[] = [];
    const reg = new PluginRegistry({ log });
    await boot(reg, [
      { name: 'boom', handle() { throw new Error('boom'); } },
      { name: 'ok', handle() { seen.push('ok'); return true; } }
    ]);
    const result = await reg.dispatch(eventCtx('hi'));
    expect(seen).toEqual(['ok']);
    expect(result).toEqual({ handled: true, by: 'ok' });
  });

  it('setup 抛错不影响其他插件启动', async () => {
    const reg = new PluginRegistry({ log });
    await boot(reg, [
      { name: 'bad', setup() { throw new Error('bad setup'); } },
      { name: 'good', setup() { /* noop */ } }
    ]);
    expect(reg.names).toEqual(['bad', 'good']);
  });

  it('插件重名直接报错，不静默覆盖', () => {
    const reg = new PluginRegistry({ log });
    reg.add({ name: 'dup' });
    expect(() => reg.add({ name: 'dup' })).toThrow(/重名/);
  });

  it('handle 超时被中断，后续插件仍能接手', async () => {
    const reg = new PluginRegistry({ log, handleTimeoutMs: 20 });
    await boot(reg, [
      { name: 'slow', handle() { return new Promise<boolean>(() => { /* 永不 resolve */ }); } },
      { name: 'fast', handle() { return true; } }
    ]);
    const result = await reg.dispatch(eventCtx('hi'));
    expect(result.by).toBe('fast');
  });

  it('无插件处理时 handled 为 false', async () => {
    const reg = new PluginRegistry({ log });
    await boot(reg, [{ name: 'nope', handle() { return false; } }]);
    expect((await reg.dispatch(eventCtx('hi'))).handled).toBe(false);
  });
});
