import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REMIND_CANCEL_COMMAND, REMIND_COMMAND, REMIND_LIST_COMMAND,
  createReminderPlugin, parseWhen
} from '../src/plugins/features/reminder.js';
import { createMemoryKVStore } from '../src/services/storage/memory.js';
import { stubScheduler, stubServices, stubStorage, testLog } from './helpers.js';
import type { BotApi, BotContext, PluginContext, ReplyTarget } from '../src/types.js';
import type { KVStore } from '../src/services/storage/types.js';

const TZ = 'Asia/Shanghai';
/** 2026-09-24 12:00 上海时间 */
const NOON = Date.UTC(2026, 8, 24, 4, 0, 0);

describe('parseWhen', () => {
  it('相对时间', () => {
    expect(parseWhen('30分钟后 喝水', NOON, TZ)).toEqual({
      ok: true, dueAt: NOON + 30 * 60000, text: '喝水'
    });
    expect(parseWhen('2小时后 出门', NOON, TZ)).toEqual({
      ok: true, dueAt: NOON + 2 * 3600000, text: '出门'
    });
  });

  it('绝对时间按配置时区解释', () => {
    // 19:30 上海 = 11:30 UTC
    expect(parseWhen('19:30 开会', NOON, TZ)).toEqual({
      ok: true, dueAt: Date.UTC(2026, 8, 24, 11, 30), text: '开会'
    });
  });

  it('多种写法等价：19点 / 19点30 / 19:30 / 19点半', () => {
    const expected = Date.UTC(2026, 8, 24, 11, 30);
    expect(parseWhen('19点30 开会', NOON, TZ)).toMatchObject({ dueAt: expected });
    expect(parseWhen('19:30 开会', NOON, TZ)).toMatchObject({ dueAt: expected });
    expect(parseWhen('19点半 开会', NOON, TZ)).toMatchObject({ dueAt: expected });
  });

  it('未写哪天且今天已过点 → 顺延到明天', () => {
    // 09:00 上海已过（现在 12:00）→ 明天 09:00 上海 = 2026-09-25T01:00Z
    expect(parseWhen('9:00 交报告', NOON, TZ)).toEqual({
      ok: true, dueAt: Date.UTC(2026, 8, 25, 1, 0), text: '交报告'
    });
  });

  it('明确写「今天」但时间已过 → 报错而不是悄悄改到明天', () => {
    const r = parseWhen('今天9点 交报告', NOON, TZ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('已经过去');
  });

  it('明天 / 后天', () => {
    expect(parseWhen('明天9点 交报告', NOON, TZ)).toMatchObject({ dueAt: Date.UTC(2026, 8, 25, 1, 0) });
    expect(parseWhen('后天9点 交报告', NOON, TZ)).toMatchObject({ dueAt: Date.UTC(2026, 8, 26, 1, 0) });
  });

  it('非法输入给出可执行的提示，而不是静默误解', () => {
    const bad = parseWhen('随便什么时候 开会', NOON, TZ);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain('没看懂时间');

    const noText = parseWhen('19:30', NOON, TZ);
    expect(noText.ok).toBe(false);
    if (!noText.ok) expect(noText.reason).toContain('提醒你做什么');

    expect(parseWhen('25:00 x', NOON, TZ).ok).toBe(false);
  });
});

interface Sent { target: ReplyTarget; text: string }

function harness(kv: KVStore, content: string, senderId = 'ME', name = 'Kai') {
  const replies: string[] = [];
  const sent: Sent[] = [];
  const api: BotApi = {
    reply: async (_ctx, text) => { replies.push(text); },
    send: async (target, text) => { sent.push({ target, text }); }
  };
  const scheduler = stubScheduler();
  const services = stubServices({ storage: stubStorage({ kv }), scheduler });
  const event: BotContext = {
    event: {
      rawEventType: 'GROUP_AT_MESSAGE_CREATE',
      kind: 'group',
      senderId,
      senderName: name,
      content,
      messageId: 'm1',
      timestamp: '0',
      groupOpenid: 'G1'
    },
    target: { scope: 'group', targetId: 'G1' },
    state: {},
    log: testLog
  };
  const config = {
    get: () => undefined,
    string: (_k: string, d: string) => d,
    bool: (_k: string, d: boolean) => d,
    number: (_k: string, d: number) => d
  };
  return { ctx: { api, log: testLog, config, services } as PluginContext, event, replies, sent, scheduler, kv };
}

afterEach(() => { vi.useRealTimers(); });

describe('reminder 插件', () => {
  it('只响应三个命令', async () => {
    const h = harness(createMemoryKVStore(), '随便聊聊');
    expect(await createReminderPlugin().handle?.(h.event, h.ctx)).toBe(false);
  });

  it('创建提醒并落库', async () => {
    vi.setSystemTime(new Date(NOON));
    const h = harness(createMemoryKVStore(), REMIND_COMMAND + ' 19:30 开会');
    expect(await createReminderPlugin().handle?.(h.event, h.ctx)).toBe(true);
    expect(h.replies[0]).toContain('2026-09-24 19:30');
    expect(h.replies[0]).toContain('开会');
    expect(h.kv.list('reminder', 'due:').length).toBe(1);
  });

  it('列表显示已创建的提醒', async () => {
    vi.setSystemTime(new Date(NOON));
    const kv = createMemoryKVStore();
    const plugin = createReminderPlugin();
    const create = harness(kv, REMIND_COMMAND + ' 19:30 开会');
    await plugin.handle?.(create.event, create.ctx);

    const list = harness(kv, REMIND_LIST_COMMAND);
    await plugin.handle?.(list.event, list.ctx);
    expect(list.replies[0]).toContain('开会');
    expect(list.replies[0]).toContain('2026-09-24 19:30');
    expect(kv.list('reminder', 'due:').length).toBe(1);
  });

  it('取消按列表序号删除', async () => {
    vi.setSystemTime(new Date(NOON));
    const kv = createMemoryKVStore();
    const plugin = createReminderPlugin();
    const create = harness(kv, REMIND_COMMAND + ' 19:30 开会');
    await plugin.handle?.(create.event, create.ctx);

    const cancel = harness(kv, REMIND_CANCEL_COMMAND + ' 1');
    await plugin.handle?.(cancel.event, cancel.ctx);
    expect(cancel.replies[0]).toContain('已取消');
    expect(kv.list('reminder', 'due:').length).toBe(0);
  });

  it('取消别人的提醒取消不到（列表按创建者过滤）', async () => {
    vi.setSystemTime(new Date(NOON));
    const kv = createMemoryKVStore();
    const plugin = createReminderPlugin();
    const mine = harness(kv, REMIND_COMMAND + ' 19:30 开会', 'ME', 'Kai');
    await plugin.handle?.(mine.event, mine.ctx);

    const other = harness(kv, REMIND_CANCEL_COMMAND + ' 1', 'OTHER', 'dev');
    await plugin.handle?.(other.event, other.ctx);
    expect(other.replies[0]).toContain('编号不对');
    expect(kv.list('reminder', 'due:').length).toBe(1);
  });

  it('编号非法时提示先看列表', async () => {
    vi.setSystemTime(new Date(NOON));
    const kv = createMemoryKVStore();
    const plugin = createReminderPlugin();
    const create = harness(kv, REMIND_COMMAND + ' 19:30 开会');
    await plugin.handle?.(create.event, create.ctx);

    const bad = harness(kv, REMIND_CANCEL_COMMAND + ' 9');
    await plugin.handle?.(bad.event, bad.ctx);
    expect(bad.replies[0]).toContain('编号不对');
    expect(kv.list('reminder', 'due:').length).toBe(1);
  });

  it('到期后发到群里，并从库里删除', async () => {
    vi.setSystemTime(new Date(NOON));
    const kv = createMemoryKVStore();
    const h = harness(kv, REMIND_COMMAND + ' 19:30 开会');
    const plugin = createReminderPlugin();
    plugin.setup?.(h.ctx);
    await plugin.handle?.(h.event, h.ctx);
    expect(kv.list('reminder', 'due:').length).toBe(1);

    const dueAt = Date.UTC(2026, 8, 24, 11, 30);
    await h.scheduler.fire('reminder-scan', dueAt + 1000);

    expect(h.sent.length).toBe(1);
    expect(h.sent[0]?.target).toEqual({ scope: 'group', targetId: 'G1' });
    expect(h.sent[0]?.text).toContain('开会');
    expect(h.sent[0]?.text).toContain('Kai');
    expect(kv.list('reminder', 'due:').length).toBe(0);
  });

  it('未到期的提醒不会被触发', async () => {
    vi.setSystemTime(new Date(NOON));
    const kv = createMemoryKVStore();
    const h = harness(kv, REMIND_COMMAND + ' 19:30 开会');
    const plugin = createReminderPlugin();
    plugin.setup?.(h.ctx);
    await plugin.handle?.(h.event, h.ctx);

    await h.scheduler.fire('reminder-scan', NOON + 60 * 1000);   // 才过 1 分钟
    expect(h.sent.length).toBe(0);
    expect(kv.list('reminder', 'due:').length).toBe(1);
  });

  it('没有提醒时列表给出用法', async () => {
    const h = harness(createMemoryKVStore(), REMIND_LIST_COMMAND);
    await createReminderPlugin().handle?.(h.event, h.ctx);
    expect(h.replies[0]).toContain('还没有提醒');
  });

  it('看不懂时间时不落库，并给出可执行提示', async () => {
    const h = harness(createMemoryKVStore(), REMIND_COMMAND + ' 随便 开会');
    await createReminderPlugin().handle?.(h.event, h.ctx);
    expect(h.replies[0]).toContain('没看懂时间');
    expect(h.kv.list('reminder', 'due:').length).toBe(0);
  });
});
