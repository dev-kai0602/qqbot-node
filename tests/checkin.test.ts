import { describe, expect, it } from 'vitest';
import {
  CHECKIN_COMMAND, CHECKIN_NAMESPACE, createCheckinPlugin
} from '../src/plugins/features/checkin.js';
import { createMemoryKVStore } from '../src/services/storage/memory.js';
import { stubServices, stubStorage, testLog } from './helpers.js';
import { dayKey, shiftDay } from '../src/util/day.js';
import type { BotApi, BotContext, PluginContext } from '../src/types.js';
import type { KVStore } from '../src/services/storage/types.js';

const TZ = 'Asia/Shanghai';
const ME = 'OP_ME';
const GROUP = 'G1';

interface Harness {
  ctx: PluginContext;
  event: BotContext;
  replies: string[];
}

function harness(
  kv: KVStore,
  content: string,
  opts: { scope?: 'c2c' | 'group'; name?: string } = {}
): Harness {
  const scope = opts.scope ?? 'group';
  const replies: string[] = [];
  const api: BotApi = {
    reply: async (_ctx, text) => { replies.push(text); },
    send: async () => {}
  };
  const services = stubServices({ storage: stubStorage({ kv }) });
  const event: BotContext = {
    event: {
      rawEventType: scope === 'group' ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE',
      kind: scope,
      senderId: ME,
      ...(opts.name !== undefined ? { senderName: opts.name } : {}),
      content,
      messageId: 'm1',
      timestamp: '0',
      ...(scope === 'group' ? { groupOpenid: GROUP } : {})
    },
    target: { scope, targetId: scope === 'group' ? GROUP : ME },
    state: {},
    log: testLog
  };
  const config = {
    get: () => undefined,
    string: (_k: string, d: string) => d,
    bool: (_k: string, d: boolean) => d,
    number: (_k: string, d: number) => d
  };
  return { ctx: { api, log: testLog, config, services }, event, replies };
}

function seed(kv: KVStore, session: string, day: string): void {
  kv.set(CHECKIN_NAMESPACE, session + '|' + ME + '|' + day, '{}');
}

describe('checkin 插件', () => {
  it('只响应 /签到，其他消息不拦截', async () => {
    const h = harness(createMemoryKVStore(), '随便聊聊');
    expect(await createCheckinPlugin().handle?.(h.event, h.ctx)).toBe(false);
    expect(h.replies.length).toBe(0);
  });

  it('首次签到：连续 1 天', async () => {
    const h = harness(createMemoryKVStore(), CHECKIN_COMMAND, { name: 'Kai' });
    expect(await createCheckinPlugin().handle?.(h.event, h.ctx)).toBe(true);
    expect(h.replies[0]).toContain('签到成功');
    expect(h.replies[0]).toContain('连续 1 天');
    expect(h.replies[0]).toContain('Kai');
  });

  it('同一天重复签到被识别，且不重复写入', async () => {
    const kv = createMemoryKVStore();
    const plugin = createCheckinPlugin();
    const h1 = harness(kv, CHECKIN_COMMAND);
    await plugin.handle?.(h1.event, h1.ctx);
    const h2 = harness(kv, CHECKIN_COMMAND);
    await plugin.handle?.(h2.event, h2.ctx);
    expect(h2.replies[0]).toContain('已经签过');
    expect(kv.list(CHECKIN_NAMESPACE, 'group:' + GROUP + '|' + ME + '|').length).toBe(1);
  });

  it('昨天签过、今天再签 → 连续 2 天', async () => {
    const kv = createMemoryKVStore();
    const today = dayKey(TZ);
    seed(kv, 'group:' + GROUP, shiftDay(today, -1));
    const h = harness(kv, CHECKIN_COMMAND);
    await createCheckinPlugin().handle?.(h.event, h.ctx);
    expect(h.replies[0]).toContain('连续 2 天');
  });

  it('中间断了一天，连续天数从 1 重新算', async () => {
    const kv = createMemoryKVStore();
    const today = dayKey(TZ);
    seed(kv, 'group:' + GROUP, shiftDay(today, -2));   // 只签了前天
    const h = harness(kv, CHECKIN_COMMAND);
    await createCheckinPlugin().handle?.(h.event, h.ctx);
    expect(h.replies[0]).toContain('连续 1 天');
    expect(h.replies[0]).toContain('累计 2 天');
  });

  it('群聊与单聊的签到互不干扰', async () => {
    const kv = createMemoryKVStore();
    const plugin = createCheckinPlugin();
    const g = harness(kv, CHECKIN_COMMAND, { scope: 'group' });
    const c = harness(kv, CHECKIN_COMMAND, { scope: 'c2c' });
    await plugin.handle?.(g.event, g.ctx);
    await plugin.handle?.(c.event, c.ctx);
    expect(g.replies[0]).toContain('签到成功');
    expect(c.replies[0]).toContain('签到成功');   // 单聊里仍算首次
  });
});
