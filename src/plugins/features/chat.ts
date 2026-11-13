/**
 * 对话插件：把用户消息交给 AI，再把回答发回去。
 *
 * 上下文策略（折中方案）：
 *  - 群聊**共享**一份完整对话上下文（机器人能看到群里所有人在说什么）
 *  - 但每条用户消息带上 [说话人] 前缀，模型据此区分不同人
 *  - 单聊只有一个说话人，不加前缀
 *
 * 两条安全策略（C3 + R18 的默认取舍）：
 *  - 输入侧命中：只记录与告警，**不拒答**（输入侧拒答会误伤正常提问）
 *  - 输出侧命中：替换为拒答话术（宁可少说，不可错说）
 */

import type { BotContext, Plugin, PluginContext } from '../../types.js';
import { speakerLabel } from '../../util/speaker.js';

export function createChatPlugin(): Plugin {
  return {
    name: 'chat',
    setup(ctx: PluginContext): void {
      if (!ctx.services.ai.available) {
        ctx.log.warn('chat plugin inactive: ai service unavailable (未配置 QQBOT_AI_API_KEY)');
        return;
      }
      ctx.log.info('chat plugin ready');
    },
    async handle(event: BotContext, ctx: PluginContext): Promise<boolean> {
      const ai = ctx.services.ai;
      if (!ai.available) return false;

      const text = event.event.content.trim();
      if (text === '' || text.startsWith('/')) return false;

      const isGroup = event.target.scope === 'group';
      const sessionKey = isGroup
        ? 'group:' + (event.event.groupOpenid ?? event.target.targetId)
        : 'c2c:' + event.event.senderId;
      const speaker = isGroup
        ? speakerLabel(event.event.senderId, event.event.senderName)
        : undefined;

      const input = ctx.services.safety.checkInput(text);
      if (input.hit) {
        ctx.services.metrics.inc('safetyInputHits');
        event.log.warn('safety: input flagged (not rejected)', {
          session: sessionKey,
          matched: input.matched
        });
      }

      const reply = await ai.chat({
        sessionKey,
        userId: event.event.senderId,
        ...(speaker !== undefined ? { speaker } : {}),
        text
      }, event.signal);

      // 被取消（分发超时 / 进程退出）后不能再发：迟到的那条会变成第二条回复
      if (event.signal?.aborted === true) {
        event.log.warn('chat cancelled, reply dropped', { session: sessionKey });
        return true;
      }

      const output = ctx.services.safety.checkOutput(reply.text);
      if (output.hit) {
        ctx.services.metrics.inc('safetyOutputBlocks');
        event.log.warn('safety: output blocked', {
          session: sessionKey,
          matched: output.matched
        });
      }
      await ctx.api.reply(event, output.hit ? ctx.services.safety.refusalText : reply.text);
      return true;
    }
  };
}

export default createChatPlugin();
