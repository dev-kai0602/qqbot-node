/**
 * 示例插件：/ping -> pong + 事件处理耗时。
 *
 * 同时演示插件私有配置：QQBOT_PLUGIN_PING_VERBOSE=false 可关掉详细信息，
 * 而核心代码不需要认识 verbose 这个字段。
 */

import type { BotContext, Plugin, PluginContext } from '../../types.js';

export function createPingPlugin(): Plugin {
  return {
    name: 'ping',
    commands: ['/ping'],
    defaults: { verbose: true },
    setup(ctx: PluginContext): void {
      ctx.log.info('ping plugin ready', { verbose: ctx.config.bool('verbose', true) });
    },
    async handle(event: BotContext, ctx: PluginContext): Promise<boolean> {
      if (event.event.content.trim() !== '/ping') return false;
      const raw = event.state['receivedAt'];
      const receivedAt = typeof raw === 'number' ? raw : Date.now();
      const parts = ['pong'];
      if (ctx.config.bool('verbose', true)) {
        parts.push('scope=' + event.event.kind);
        parts.push('latency=' + (Date.now() - receivedAt) + 'ms');
      }
      await ctx.api.reply(event, parts.join(' | '));
      return true;
    }
  };
}

export default createPingPlugin();
