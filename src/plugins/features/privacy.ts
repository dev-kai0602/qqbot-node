/**
 * 隐私插件：让用户能查、能删自己的数据。
 *
 * 对应运营规范 5.10 的两条要求：
 *  - 采集用户数据须如实披露用途与范围  → /我的数据
 *  - 用户要求时必须能删除              → /删除我的数据
 *
 * 删除范围划得很清楚（不夸大能力）：
 *  - 你在任何会话里发出的消息：全部删除
 *  - 你的单聊会话：连同机器人的回复一起清除
 *  - 群聊里机器人的回复：**保留**——它是群共享内容，其他成员可能正在用；
 *    一并删除会破坏他人的对话上下文。这一点在回复里明确告知用户。
 */

import type { BotContext, Plugin, PluginContext } from '../../types.js';

export const INSPECT_COMMAND = '/我的数据';
export const DELETE_COMMAND = '/删除我的数据';

export function createPrivacyPlugin(): Plugin {
  return {
    name: 'privacy',
    commands: [INSPECT_COMMAND, DELETE_COMMAND],
    setup(ctx: PluginContext): void {
      ctx.log.info('privacy plugin ready', { commands: [INSPECT_COMMAND, DELETE_COMMAND] });
    },
    async handle(event: BotContext, ctx: PluginContext): Promise<boolean> {
      const text = event.event.content.trim();
      if (text !== DELETE_COMMAND && text !== INSPECT_COMMAND) return false;

      const me = event.event.senderId;
      const store = ctx.services.storage.messages;
      const isC2c = event.target.scope === 'c2c';
      const sessionKey = isC2c
        ? 'c2c:' + me
        : 'group:' + (event.event.groupOpenid ?? event.target.targetId);

      if (text === INSPECT_COMMAND) {
        await ctx.api.reply(
          event,
          '我这边一共存了你 ' + store.countBySender(me) + ' 条消息；当前这个' +
          (isC2c ? '单聊' : '群聊') + '会话保留 ' + store.count(sessionKey) +
          ' 条作为对话上下文。发送 ' + DELETE_COMMAND + ' 可以全部删除。'
        );
        return true;
      }

      // 先删自己发出的消息（跨会话），再清空单聊会话里剩余的机器人回复
      const removedMine = store.deleteBySender(me);
      const removedSession = isC2c ? store.clear('c2c:' + me) : 0;

      ctx.log.warn('user data deleted', {
        scope: event.target.scope,
        removedOwnMessages: removedMine,
        removedC2cSession: removedSession
      });

      const parts = ['已删除你发出的 ' + removedMine + ' 条消息'];
      if (isC2c) {
        parts.push('以及本单聊会话里机器人的 ' + removedSession + ' 条回复');
        parts.push('对话上下文已重置');
      } else {
        parts.push('群聊里机器人的历史回复仍保留在群会话中（属群共享内容，删除会影响其他成员）');
        parts.push('如需彻底清除，可在单聊里发送同样的命令');
      }
      await ctx.api.reply(event, parts.join('；') + '。');
      return true;
    }
  };
}

export default createPrivacyPlugin();
