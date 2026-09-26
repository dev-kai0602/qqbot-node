/**
 * 示例插件：原样回显用户消息；以 / 开头的命令交给其他插件。
 *
 * 本文件是「加插件」的模板：新增同目录下的 .ts 即可，核心无需改动。
 */

import type { BotContext, Plugin, PluginContext } from '../../types.js';

export function createEchoPlugin(): Plugin {
  return {
    name: 'echo',
    setup(ctx: PluginContext): void {
      ctx.log.info('echo plugin ready');
    },
    async handle(event: BotContext, ctx: PluginContext): Promise<boolean> {
      const text = event.event.content.trim();
      if (text === '' || text.startsWith('/')) return false;
      await ctx.api.reply(event, 'Echo: ' + text);
      return true;
    }
  };
}

export default createEchoPlugin();
