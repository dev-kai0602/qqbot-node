/**
 * 提醒插件：/提醒 <时间> <内容>
 *
 * 触发后发到**创建提醒的那个会话**（群里设的就发群里）。
 *
 * 三个值得说明的设计：
 *
 * 1. **键就是到期时间**：`due:<13 位补零毫秒>:<随机 id>`。
 *    补零后字典序 = 时间序，所以一次前缀扫描拿到的就是按时间排好的队列，
 *    扫描时遇到第一条未到期即可 break，不用全表遍历。
 *
 * 2. **扫描放调度器里**，而不是插件自己 setInterval——
 *    定时回调抛错会变成 uncaughtException，而本项目的策略是记录后退出进程。
 *    一个提醒发失败就把机器人重启一遍是不可接受的。
 *
 * 3. **只能查/取消自己的提醒**：列表按 (会话, 创建者) 过滤，
 *    取消时也会校验归属，否则群里任何人都能删掉别人的提醒。
 *
 * 已知限制：主动消息可能失败——用户可以在 QQ 客户端关闭「允许主动发送」，
 * 平台也有每日配额。失败时只能记日志，因为此刻无法再通过 QQ 通知对方。
 */

import type { BotContext, Plugin, PluginContext, ReplyTarget } from '../../types.js';
import type { KVStore } from '../../services/storage/types.js';
import { formatInZone, wallClock, zonedEpoch } from '../../util/day.js';

export const REMIND_COMMAND = '/提醒';
export const REMIND_LIST_COMMAND = '/提醒列表';
export const REMIND_CANCEL_COMMAND = '/提醒取消';
export const REMINDER_NAMESPACE = 'reminder';

/** 扫描间隔：20 秒。提醒的精度需求远低于此，不必更密 */
const SCAN_INTERVAL_MS = 20000;
/** 单次扫描上限，防止异常数据把一次 tick 拖垮 */
const SCAN_LIMIT = 200;
/** 允许的最大提前量，挡住「100 年后」这类误输入 */
const MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

interface Reminder {
  readonly scope: 'c2c' | 'group';
  readonly targetId: string;
  readonly sessionKey: string;
  readonly creatorId: string;
  readonly creatorName?: string;
  readonly text: string;
  readonly dueAt: number;
  readonly createdAt: number;
}

export type WhenResult =
  | { readonly ok: true; readonly dueAt: number; readonly text: string }
  | { readonly ok: false; readonly reason: string };

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 在某个墙上日期上加天数，自动处理跨月跨年 */
function addDays(base: { year: number; month: number; day: number }, delta: number): { year: number; month: number; day: number } {
  const t = new Date(Date.UTC(base.year, base.month - 1, base.day + delta));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/**
 * 解析时间表达。刻意只支持一组**明确**的写法，不做模糊 NLP：
 *   30分钟后 / 2小时后 / 1天后
 *   19:30 / 19点 / 19点30 / 19点30分 / 19点半
 *   今天19:30 / 明天9点 / 后天 8:00
 * 其余一律返回失败并给出用法，避免「我以为你懂」的静默误解。
 */
export function parseWhen(input: string, now: number, timeZone: string): WhenResult {
  const rel = /^(\d+)\s*(分钟|小时|天)\s*后\s*([\s\S]*)$/.exec(input);
  if (rel !== null) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const rest = (rel[3] ?? '').trim();
    if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: '时间数量要大于 0' };
    const ms = unit === '分钟' ? n * 60000 : unit === '小时' ? n * 3600000 : n * 86400000;
    if (ms > MAX_AHEAD_MS) return { ok: false, reason: '提醒最多只能设一年以内' };
    if (rest === '') return { ok: false, reason: '要提醒你做什么？' };
    return { ok: true, dueAt: now + ms, text: rest };
  }

  // 两个正则的**分组序号不同**（「点半」写法没有分钟组），
  // 所以不能共用一个 match 对象按下标取值——那样「19点半 开会」会取到 undefined 的剩余文本。
  const half = /^(今天|明天|后天)?\s*(\d{1,2})\s*点半\s*([\s\S]*)$/.exec(input);
  const abs = /^(今天|明天|后天)?\s*(\d{1,2})\s*[:：点时]\s*(\d{1,2})?\s*分?\s*([\s\S]*)$/.exec(input);

  let dayWord: string | undefined;
  let hour: number;
  let minute: number;
  let rest: string;

  if (half !== null) {
    dayWord = half[1];
    hour = Number(half[2]);
    minute = 30;
    rest = (half[3] ?? '').trim();
  } else if (abs !== null) {
    dayWord = abs[1];
    hour = Number(abs[2]);
    minute = Number(abs[3] ?? '0');
    rest = (abs[4] ?? '').trim();
  } else {
    return { ok: false, reason: '没看懂时间。可以写「30分钟后」「19:30」「明天9点」' };
  }

  {

    if (!Number.isInteger(hour) || hour > 23) return { ok: false, reason: '小时要在 0-23 之间' };
    if (!Number.isInteger(minute) || minute > 59) return { ok: false, reason: '分钟要在 0-59 之间' };
    if (rest === '') return { ok: false, reason: '要提醒你做什么？' };

    const today = wallClock(timeZone, now);
    const explicit = dayWord !== undefined;
    let offset = dayWord === '明天' ? 1 : dayWord === '后天' ? 2 : 0;
    let date = addDays(today, offset);
    let dueAt = zonedEpoch(timeZone, date.year, date.month, date.day, hour, minute);

    if (dueAt <= now) {
      if (explicit) return { ok: false, reason: '「' + dayWord + ' ' + pad(hour) + ':' + pad(minute) + '」已经过去了' };
      // 没写哪天且今天已过点，顺延到明天——这是更符合直觉的行为
      offset += 1;
      date = addDays(today, offset);
      dueAt = zonedEpoch(timeZone, date.year, date.month, date.day, hour, minute);
    }
    if (dueAt - now > MAX_AHEAD_MS) return { ok: false, reason: '提醒最多只能设一年以内' };
    return { ok: true, dueAt, text: rest };
  }
}

function makeKey(dueAt: number): string {
  const id = Math.random().toString(16).slice(2, 8);
  return 'due:' + String(dueAt).padStart(13, '0') + ':' + id;
}

function parseReminder(raw: string): Reminder | undefined {
  try {
    const parsed = JSON.parse(raw) as Reminder;
    if (typeof parsed.dueAt !== 'number' || typeof parsed.text !== 'string') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function createReminderPlugin(): Plugin {
  let ctx: PluginContext | undefined;

  // 刻意把 kv 作为参数传入，而不是用 setup 捕获的 ctx：
  // handle 本来就有自己的 context，走捕获值会形成隐藏耦合——
  // 表现就是「不调 setup 就查不到数据」，写测试时才发现。
  const mine = (kv: KVStore, sessionKey: string, creatorId: string): Array<{ key: string; reminder: Reminder }> => {
    const out: Array<{ key: string; reminder: Reminder }> = [];
    for (const entry of kv.list(REMINDER_NAMESPACE, 'due:', SCAN_LIMIT)) {
      const reminder = parseReminder(entry.value);
      if (reminder === undefined) continue;
      if (reminder.sessionKey !== sessionKey || reminder.creatorId !== creatorId) continue;
      out.push({ key: entry.key, reminder });
    }
    return out;
  };

  const fire = async (reminder: Reminder): Promise<void> => {
    const services = ctx?.services;
    if (services === undefined) return;
    const target: ReplyTarget = { scope: reminder.scope, targetId: reminder.targetId };
    const who = reminder.creatorName === undefined ? '' : reminder.creatorName + '，';
    try {
      await ctx?.api.send(target, '⏰ ' + who + '提醒你：' + reminder.text);
      services.log.info('reminder fired', { text: reminder.text, scope: reminder.scope });
    } catch (err) {
      // 主动消息可能因用户关闭开关或超出配额而失败；此刻已无法再用 QQ 通知对方
      services.log.error('reminder send failed', { text: reminder.text });
    }
  };

  return {
    name: 'reminder',
    commands: [REMIND_COMMAND, REMIND_LIST_COMMAND, REMIND_CANCEL_COMMAND],
    setup(context: PluginContext): void {
      ctx = context;
      const services = context.services;
      services.log.info('reminder plugin ready', {
        commands: [REMIND_COMMAND, REMIND_LIST_COMMAND, REMIND_CANCEL_COMMAND],
        scanIntervalSec: Math.round(SCAN_INTERVAL_MS / 1000)
      });

      services.scheduler.every('reminder-scan', SCAN_INTERVAL_MS, async (now: number) => {
        const kv = services.storage.kv;
        for (const entry of kv.list(REMINDER_NAMESPACE, 'due:', SCAN_LIMIT)) {
          const reminder = parseReminder(entry.value);
          if (reminder === undefined) {
            kv.remove(REMINDER_NAMESPACE, entry.key);
            services.log.warn('dropped malformed reminder', { key: entry.key });
            continue;
          }
          // 键按时间升序，遇到第一条未到期就可以停
          if (reminder.dueAt > now) break;
          kv.remove(REMINDER_NAMESPACE, entry.key);
          await fire(reminder);
        }
      });
    },

    async handle(event: BotContext, context: PluginContext): Promise<boolean> {
      const text = event.event.content.trim();

      const isList = text === REMIND_LIST_COMMAND;
      const isCancel = text === REMIND_CANCEL_COMMAND || text.startsWith(REMIND_CANCEL_COMMAND + ' ');
      const isCreate = text === REMIND_COMMAND || text.startsWith(REMIND_COMMAND + ' ');
      if (!isList && !isCancel && !isCreate) return false;

      const kv = context.services.storage.kv;
      const me = event.event.senderId;
      const sessionKey = event.target.scope === 'group'
        ? 'group:' + (event.event.groupOpenid ?? event.target.targetId)
        : 'c2c:' + me;

      if (isList) {
        const list = mine(kv, sessionKey, me);
        if (list.length === 0) {
          await context.api.reply(event, '你在这个会话还没有提醒。发「' + REMIND_COMMAND + ' 明天9点 交报告」试试。');
          return true;
        }
        const lines = list.map((item, i) =>
          String(i + 1) + '. ' + formatInZone(context.services.timeZone, item.reminder.dueAt) +
          ' — ' + item.reminder.text);
        await context.api.reply(event, '你的提醒：\n' + lines.join('\n'));
        return true;
      }

      if (isCancel) {
        const arg = text.slice(REMIND_CANCEL_COMMAND.length).trim();
        const list = mine(kv, sessionKey, me);
        const index = Number(arg);
        if (!Number.isInteger(index) || index < 1 || index > list.length) {
          await context.api.reply(event, '编号不对。先发 ' + REMIND_LIST_COMMAND + ' 看编号（当前有 ' + list.length + ' 条）。');
          return true;
        }
        const target = list[index - 1];
        if (target === undefined) {
          await context.api.reply(event, '这条提醒已经不在了。');
          return true;
        }
        kv.remove(REMINDER_NAMESPACE, target.key);
        await context.api.reply(event, '已取消：' + formatInZone(context.services.timeZone, target.reminder.dueAt) + ' ' + target.reminder.text);
        return true;
      }

      const body = text.slice(REMIND_COMMAND.length).trim();
      if (body === '') {
        await context.api.reply(event, '用法：' + REMIND_COMMAND + ' <时间> <内容>\n例如「' + REMIND_COMMAND + ' 30分钟后 喝水」「' + REMIND_COMMAND + ' 明天9点 交报告」');
        return true;
      }

      const when = parseWhen(body, Date.now(), context.services.timeZone);
      if (!when.ok) {
        await context.api.reply(event, when.reason);
        return true;
      }

      const reminder: Reminder = {
        scope: event.target.scope,
        targetId: event.target.targetId,
        sessionKey,
        creatorId: me,
        ...(event.event.senderName !== undefined ? { creatorName: event.event.senderName } : {}),
        text: when.text,
        dueAt: when.dueAt,
        createdAt: Date.now()
      };
      kv.set(REMINDER_NAMESPACE, makeKey(when.dueAt), JSON.stringify(reminder));

      await context.api.reply(event, '好，' + formatInZone(context.services.timeZone, when.dueAt) +
        ' 我会在这里提醒你：' + when.text);
      return true;
    }
  };
}

export default createReminderPlugin();
