/**
 * 对话插件：把用户消息交给 DSH agent，再把回答发回去。
 *
 * 上下文由 agent 侧维护：每个会话键对应一个 DSH session（id 落 KV，重启续用），
 * 群里共享一份上下文，所以消息仍带 [昵称] 前缀，让模型知道是谁在说话。
 *
 * 两条安全策略（C3 + R18 的默认取舍）：
 *  - 输入侧命中：只记录与告警，**不拒答**（输入侧拒答会误伤正常提问）
 *  - 输出侧命中：替换为拒答话术（宁可少说，不可错说）
 */

import type { BotContext, Plugin, PluginContext } from '../../types.js';
import { renderUserMessage, speakerLabel } from '../../util/speaker.js';

export function createChatPlugin(): Plugin {
  return {
    name: 'chat',
    setup(ctx: PluginContext): void {
      if (!ctx.services.agent.available) {
        ctx.log.warn('chat plugin inactive: agent unavailable (检查 QQBOT_AGENT_ENABLED / QQBOT_AI_API_KEY)');
        return;
      }
      ctx.log.info('chat plugin ready', { backend: 'dsh-agent' });
    },
    async handle(event: BotContext, ctx: PluginContext): Promise<boolean> {
      const agent = ctx.services.agent;
      if (!agent.available) return false;

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

      // 群聊保留 [昵称] 前缀：DSH 会话是整群共享的，模型要能区分谁在说话
      const reply = await agent.ask({ sessionKey, text: renderUserMessage(speaker, text) }, event.signal);

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
