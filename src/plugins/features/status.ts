/**
 * 状态插件：/状态 —— 直接在 QQ 里查看运行状况。
 *
 * 为什么用命令而不是 Web 面板：单机自托管、只有一个使用者，
 * 加一个 HTTP 端口意味着多一个暴露面和多一套鉴权，收益不成正比。
 * 需要长期观测时看 journald 里的周期性 health 日志即可。
 *
 * 告警出口（AlertSink）已抽象好；接入事务邮件时新增一个实现即可。
 */

import type { BotContext, Plugin, PluginContext } from '../../types.js';
import { formatDuration } from '../../services/metrics.js';

export const STATUS_COMMAND = '/状态';

const KIND_LABEL: Record<string, string> = {
  c2c: '单聊',
  group: '群聊',
  guild: '频道',
  dm: '私信'
};

export function createStatusPlugin(): Plugin {
  return {
    name: 'status',
    commands: [STATUS_COMMAND],
    setup(ctx: PluginContext): void {
      ctx.log.info('status plugin ready', { command: STATUS_COMMAND });
    },
    async handle(event: BotContext, ctx: PluginContext): Promise<boolean> {
      if (event.event.content.trim() !== STATUS_COMMAND) return false;

      const snap = ctx.services.metrics.snapshot();
      const c = snap.counters;
      const kinds = Object.entries(snap.eventsByKind)
        .map(([kind, n]) => (KIND_LABEL[kind] ?? kind) + ' ' + n)
        .join(' / ');

      const lines = [
        '运行 ' + formatDuration(snap.uptimeSec * 1000),
        '事件 ' + (c.eventsIn ?? 0) + ' 条' + (kinds === '' ? '' : '（' + kinds + '）'),
        '回复 ' + (c.repliesSent ?? 0) + ' 条｜失败 ' + (c.replyFailures ?? 0),
        'AI ' + (c.aiCalls ?? 0) + ' 次｜失败 ' + (c.aiFailures ?? 0) + '｜降级 ' + (c.aiDegraded ?? 0),
        '今日花费 ¥' + snap.aiSpentCny.toFixed(4) +
          (snap.aiBudgetCny === null ? '' : ' / ¥' + snap.aiBudgetCny),
        '网关 READY ' + (c.gatewayReady ?? 0) + '｜RESUMED ' + (c.gatewayResumed ?? 0) +
          '｜错误 ' + (c.gatewayErrors ?? 0),
        '存储 ' + snap.storageKind + '｜去重丢弃 ' + (c.duplicatesDropped ?? 0) +
          '｜插件错误 ' + (c.pluginFailures ?? 0)
      ];
      await ctx.api.reply(event, lines.join('\n'));
      return true;
    }
  };
}

export default createStatusPlugin();
