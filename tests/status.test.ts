import { describe, expect, it } from 'vitest';
import { STATUS_COMMAND, createStatusPlugin } from '../src/plugins/features/status.js';
import { createMetricsService } from '../src/services/metrics.js';
import { createMemoryMessageStore } from '../src/services/storage/memory.js';
import type { BotApi, BotContext, Logger, MetricsService, PluginContext, Services } from '../src/types.js';

const log: Logger = { info() {}, warn() {}, error() {}, debug() {} };

function harness(metrics: MetricsService): { ctx: PluginContext; event: BotContext; replies: string[] } {
  const replies: string[] = [];
  const api: BotApi = {
    reply: async (_ctx, text) => { replies.push(text); },
    send: async () => {}
  };
  const services: Services = {
    log,
    dataDir: 'data',
    timeZone: 'UTC',
    ai: {
      available: true,
      chat: async () => ({ text: 'x', degraded: false }),
      spentCny: () => 0,
      budgetLimitCny: () => 20,
      contextSize: () => 0,
      resetContext: () => {}
    },
    agent: { available: false, ask: async () => ({ text: '', degraded: true }) },
    safety: {
      checkInput: () => ({ hit: false, matched: [] }),
      checkOutput: () => ({ hit: false, matched: [] }),
      refusalText: 'no'
    },
    storage: {
      kind: 'sqlite',
      messages: createMemoryMessageStore(),
      spend: { load: () => undefined, save: () => {}, close: () => {} },
      kv: { get: () => undefined, set: () => {}, remove: () => {}, list: () => [], clearNamespace: () => 0, close: () => {} },
      location: 'data/qqbot.db',
      close: () => {}
    },
    metrics,
    scheduler: { every: () => {}, names: () => [], close: () => {} }
  };
  const event: BotContext = {
    event: {
      rawEventType: 'C2C_MESSAGE_CREATE',
      kind: 'c2c',
      senderId: 'ME',
      content: STATUS_COMMAND,
      messageId: 'm1',
      timestamp: '0'
    },
    target: { scope: 'c2c', targetId: 'ME' },
    state: {},
    log
  };
  const config = {
    get: () => undefined,
    string: (_k: string, d: string) => d,
    bool: (_k: string, d: boolean) => d,
    number: (_k: string, d: number) => d
  };
  return { ctx: { api, log, config, services }, event, replies };
}

describe('status 插件', () => {
  it('只响应 /状态，其他消息不拦截', async () => {
    const m = createMetricsService({ log, alert: { alert: () => {} }, intervalMs: 0 });
    const h = harness(m);
    const other = { ...h.event, event: { ...h.event.event, content: '随便聊聊' } };
    expect(await createStatusPlugin().handle?.(other, h.ctx)).toBe(false);
    expect(h.replies.length).toBe(0);
    m.close();
  });

  it('输出包含运行时长、事件、AI 花费与存储种类', async () => {
    let spent = 0.1234;
    const m = createMetricsService({
      log,
      alert: { alert: () => {} },
      intervalMs: 0,
      storageKind: 'sqlite',
      budget: () => ({ spentCny: spent, limitCny: 20 })
    });
    m.inc('eventsIn', 7);
    m.countEvent('group');
    m.inc('repliesSent', 7);
    m.inc('aiCalls', 7);
    m.inc('duplicatesDropped', 1);

    const h = harness(m);
    expect(await createStatusPlugin().handle?.(h.event, h.ctx)).toBe(true);
    const text = h.replies[0] ?? '';
    expect(text).toContain('运行 ');
    expect(text).toContain('事件 7 条（群聊 1）');
    expect(text).toContain('回复 7 条');
    expect(text).toContain('AI 7 次');
    expect(text).toContain('¥0.1234 / ¥20');
    expect(text).toContain('存储 sqlite');
    expect(text).toContain('去重丢弃 1');
    m.close();
  });
});
