/**
 * 签到插件：群打卡。
 *
 * 数据落在 kv 命名空间 checkin 下，键为 `<会话>|<用户 openid>|<YYYY-MM-DD>`：
 *  - 会话做前缀，天然区分「在哪个群签到」
 *  - 日期用 YYYY-MM-DD，字典序即时间序
 *  - 「今天」按配置时区算（服务器多为 UTC，直接取本地日期会在早上 8 点翻页）
 *
 * 连续天数用**一次 list + 内存回溯**，而不是每天一次 get：
 * 连续 100 天就是 100 次查询，而 list 只查一次。
 */

import type { BotContext, Plugin, PluginContext } from '../../types.js';
import { dayKey, shiftDay } from '../../util/day.js';

export const CHECKIN_COMMAND = '/签到';
export const CHECKIN_NAMESPACE = 'checkin';

function keyOf(session: string, userId: string, day: string): string {
  return session + '|' + userId + '|' + day;
}

function prefixOf(session: string, userId: string): string {
  return session + '|' + userId + '|';
}

export function createCheckinPlugin(): Plugin {
  return {
    name: 'checkin',
    commands: [CHECKIN_COMMAND],
    setup(ctx: PluginContext): void {
      ctx.log.info('checkin plugin ready', {
        command: CHECKIN_COMMAND,
        timeZone: ctx.services.timeZone
      });
    },
    async handle(event: BotContext, ctx: PluginContext): Promise<boolean> {
      if (event.event.content.trim() !== CHECKIN_COMMAND) return false;

      const kv = ctx.services.storage.kv;
      const today = dayKey(ctx.services.timeZone);
      const isGroup = event.target.scope === 'group';
      const session = isGroup
        ? 'group:' + (event.event.groupOpenid ?? event.target.targetId)
        : 'c2c:' + event.event.senderId;
      const me = event.event.senderId;
      const prefix = prefixOf(session, me);

      const days = new Set(
        kv.list(CHECKIN_NAMESPACE, prefix, 100000).map((e) => e.key.slice(prefix.length))
      );
      const already = days.has(today);

      if (!already) {
        kv.set(CHECKIN_NAMESPACE, keyOf(session, me, today), JSON.stringify({
          name: event.event.senderName ?? null,
          at: Date.now()
        }));
        days.add(today);
      }

      // 从今天往回数连续天数；上限避免脏数据造成死循环
      let streak = 0;
      let cursor = today;
      for (let i = 0; i < 3650; i += 1) {
        if (!days.has(cursor)) break;
        streak += 1;
        cursor = shiftDay(cursor, -1);
      }

      const who = isGroup && event.event.senderName !== undefined
        ? event.event.senderName + ' '
        : '';

      if (already) {
        await ctx.api.reply(event, who + '今天已经签过啦～连续 ' + streak + ' 天，明天再来。');
        return true;
      }

      const extra = days.size > streak ? '｜累计 ' + days.size + ' 天' : '';
      await ctx.api.reply(event, '✅ ' + who + '签到成功！连续 ' + streak + ' 天' + extra);
      return true;
    }
  };
}

export default createCheckinPlugin();
