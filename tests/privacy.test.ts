import { describe, expect, it } from 'vitest';
import {
  DELETE_COMMAND, INSPECT_COMMAND, createPrivacyPlugin
} from '../src/plugins/features/privacy.js';
import { createMemoryMessageStore } from '../src/services/storage/memory.js';
import type { MessageStore } from '../src/services/storage/types.js';
import type {
  BotApi, BotContext, Logger, MetricsService, PluginContext, Services
} from '../src/types.js';

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


const log: Logger = { info() {}, warn() {}, error() {}, debug() {} };
const ME = 'AAAA1111BBBB2222';
const OTHER = 'CCCC3333DDDD4444';
const GROUP = 'GROUP0001';

function makeStore(): MessageStore {
  const store = createMemoryMessageStore();
  store.append('c2c:' + ME, { role: 'user', content: '我的秘密', senderId: ME });
  store.append('c2c:' + ME, { role: 'assistant', content: '收到' });
  store.append('group:' + GROUP, { role: 'user', content: '大家好', speaker: 'Kai', senderId: ME });
  store.append('group:' + GROUP, { role: 'assistant', content: '你好' });
  store.append('group:' + GROUP, { role: 'user', content: '别理他', speaker: 'dev', senderId: OTHER });
  return store;
}

interface Harness {
  ctx: PluginContext;
  event: BotContext;
  replies: string[];
}

function harness(store: MessageStore, scope: 'c2c' | 'group', content: string): Harness {
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
      available: false,
      chat: async () => ({ text: '', degraded: true }),
      spentCny: () => 0,
      budgetLimitCny: () => 0,
      contextSize: () => 0,
      resetContext: () => {}
    },
    safety: {
      checkInput: () => ({ hit: false, matched: [] }),
      checkOutput: () => ({ hit: false, matched: [] }),
      refusalText: 'no'
    },
    storage: {
      kind: 'memory',
      messages: store,
      spend: { load: () => undefined, save: () => {}, close: () => {} },
      kv: { get: () => undefined, set: () => {}, remove: () => {}, list: () => [], clearNamespace: () => 0, close: () => {} },
      location: null,
      close: () => {}
    },
    metrics,
    scheduler: { every: () => {}, names: () => [], close: () => {} }
  };
  const event: BotContext = {
    event: {
      rawEventType: scope === 'c2c' ? 'C2C_MESSAGE_CREATE' : 'GROUP_AT_MESSAGE_CREATE',
      kind: scope,
      senderId: ME,
      content,
      messageId: 'm1',
      timestamp: '0',
      ...(scope === 'group' ? { groupOpenid: GROUP } : {})
    },
    target: { scope, targetId: scope === 'group' ? GROUP : ME },
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

describe('privacy 插件', () => {
  it('只处理自己的命令，其他消息不拦截', async () => {
    const h = harness(makeStore(), 'c2c', '随便聊聊');
    const handled = await createPrivacyPlugin().handle?.(h.event, h.ctx);
    expect(handled).toBe(false);
    expect(h.replies.length).toBe(0);
  });

  it('/我的数据 只报告不删除', async () => {
    const store = makeStore();
    const h = harness(store, 'c2c', INSPECT_COMMAND);
    const handled = await createPrivacyPlugin().handle?.(h.event, h.ctx);
    expect(handled).toBe(true);
    expect(h.replies[0]).toContain('2 条消息');
    expect(store.countBySender(ME)).toBe(2);
  });

  it('单聊删除：自己的消息与机器人回复全部清除，别人的数据不动', async () => {
    const store = makeStore();
    const h = harness(store, 'c2c', DELETE_COMMAND);
    await createPrivacyPlugin().handle?.(h.event, h.ctx);
    expect(store.countBySender(ME)).toBe(0);
    expect(store.count('c2c:' + ME)).toBe(0);
    expect(store.countBySender(OTHER)).toBe(1);
    expect(store.count('group:' + GROUP)).toBe(2);
    expect(h.replies[0]).toContain('已删除你发出的 2 条消息');
  });

  it('群聊删除：只删自己的消息，并明确告知群内机器人回复会保留', async () => {
    const store = makeStore();
    const h = harness(store, 'group', DELETE_COMMAND);
    await createPrivacyPlugin().handle?.(h.event, h.ctx);
    expect(store.countBySender(ME)).toBe(0);
    expect(store.countBySender(OTHER)).toBe(1);
    expect(store.count('group:' + GROUP)).toBe(2);
    expect(h.replies[0]).toContain('仍保留在群会话中');
  });
});
