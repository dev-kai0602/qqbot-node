/**
 * AI 服务装配层。
 *
 * 职责五条，目标只有一个：让插件永远拿到一句话，而不是异常。
 *  1. 预算闸门：超了直接降级，根本不打 API
 *  2. 从存储取上下文，组装 system + 历史 + 本轮
 *  3. 群聊说话人标注（共享上下文，但标明谁在说）
 *  4. 失败 / 超时 / 空回复统一降级
 *  5. 记账与消息落库
 */

import type {
  AiReply, AiRequest, AiService, ChatMessage, Logger, ReasoningEffort
} from '../../types.js';
import { serializeError } from '../../util/errors.js';
import { renderUserMessage } from '../../util/speaker.js';
import type { MessageStore } from '../storage/types.js';
import type { MetricsService } from '../../types.js';
import type { DailyBudget } from './budget.js';
import type { ChatProvider } from './types.js';

/**
 * 说话人约定。
 *
 * 刻意与用户可配置的 system prompt 分开并**始终附加**：
 * 如果把它混进 QQBOT_AI_SYSTEM_PROMPT 的默认值里，运营方一覆盖就丢了，
 * 而前缀仍然会加上——模型就会看到一堆没解释的 [昵称]。
 */
const SPEAKER_CONVENTION = [
  '在群聊中，用户消息以 [昵称] 开头标明说话人。',
  '请只针对最后一条消息的说话人作答，并注意区分不同人的问题与需求，不要混在一起。'
].join('');

export interface AiServiceOptions {
  log: Logger;
  provider: ChatProvider;
  model: string;
  maxTokens: number;
  reasoningEffort: ReasoningEffort;
  systemPrompt: string;
  budget: DailyBudget;
  /** 消息存储：上下文从这里读，也写回这里 */
  store: MessageStore;
  /** 送入模型的历史条数上限 */
  contextMessages: number;
  /** 送入模型的历史字符上限 */
  contextChars: number;
  /** Provider 失败 / 超时 / 空回复时的兜底话术 */
  fallbackText: string;
  /** 预算耗尽时的话术（与故障区分开，便于用户理解） */
  budgetExhaustedText: string;
  /** 可选：没有指标服务时全部计数静默跳过，测试无需构造 */
  metrics?: MetricsService;
}

/** 密钥缺失时的占位实现：插件据此放弃处理，而不是疯狂降级刷屏 */
export function createUnavailableAi(log: Logger, reason: string): AiService {
  log.warn('ai service unavailable', { reason });
  return {
    available: false,
    chat(): Promise<AiReply> {
      return Promise.resolve({ text: '', degraded: true, reason });
    },
    spentCny(): number {
      return 0;
    },

    budgetLimitCny(): number {
      return 0;
    },
    contextSize(): number {
      return 0;
    },
    resetContext(): void {
      /* no-op */
    }
  };
}

export function createAiService(opts: AiServiceOptions): AiService {
  const log = opts.log;
  const systemContent = opts.systemPrompt + '\n' + SPEAKER_CONVENTION;

  return {
    available: true,

    async chat(req: AiRequest, signal?: AbortSignal): Promise<AiReply> {
      if (!opts.budget.canSpend()) {
        log.warn('ai budget exhausted', {
          spentCny: Number(opts.budget.spentCny().toFixed(4)),
          limitCny: opts.budget.limit()
        });
        opts.metrics?.inc('aiDegraded');
        return { text: opts.budgetExhaustedText, degraded: true, reason: 'budget_exhausted' };
      }

      const history = opts.store.recent(req.sessionKey, opts.contextMessages, opts.contextChars);
      const messages: ChatMessage[] = [
        { role: 'system', content: systemContent },
        ...history.map((m) => ({
          role: m.role,
          content: m.role === 'user' ? renderUserMessage(m.speaker, m.content) : m.content
        })),
        { role: 'user', content: renderUserMessage(req.speaker, req.text) }
      ];

      opts.metrics?.inc('aiCalls');
      try {
        const res = await opts.provider.complete(
          {
            model: opts.model,
            messages,
            maxTokens: opts.maxTokens,
            userId: req.userId,
            reasoningEffort: opts.reasoningEffort
          },
          signal
        );

        const cost = opts.budget.record(res.promptTokens, res.completionTokens);
        opts.metrics?.noteAiResult(true);
        opts.metrics?.addSpend(cost);
        const text = res.text.trim();

        if (text === '') {
          opts.metrics?.inc('aiDegraded');
          log.warn('ai returned empty text', { session: req.sessionKey });
          return { text: opts.fallbackText, degraded: true, reason: 'empty' };
        }

        opts.store.append(req.sessionKey, {
          role: 'user',
          content: req.text,
          ...(req.speaker !== undefined ? { speaker: req.speaker } : {}),
          // 落 openid：昵称会变会重名，只有它能可靠定位「某人的数据」
          senderId: req.userId
        });
        opts.store.append(req.sessionKey, { role: 'assistant', content: text });

        log.info('ai replied', {
          session: req.sessionKey,
          speaker: req.speaker ?? null,
          chars: text.length,
          promptTokens: res.promptTokens,
          completionTokens: res.completionTokens,
          costCny: Number(cost.toFixed(4)),
          spentCny: Number(opts.budget.spentCny().toFixed(4))
        });

        return {
          text,
          degraded: false,
          promptTokens: res.promptTokens,
          completionTokens: res.completionTokens,
          costCny: cost
        };
      } catch (err) {
        opts.metrics?.inc('aiFailures');
        opts.metrics?.inc('aiDegraded');
        opts.metrics?.noteAiResult(false);
        log.error('ai call failed', { session: req.sessionKey, error: serializeError(err) });
        return { text: opts.fallbackText, degraded: true, reason: 'provider_error' };
      }
    },

    spentCny(): number {
      return opts.budget.spentCny();
    },

    budgetLimitCny(): number {
      return opts.budget.limit();
    },

    contextSize(sessionKey: string): number {
      return opts.store.count(sessionKey);
    },

    resetContext(sessionKey: string): void {
      opts.store.clear(sessionKey);
    }
  };
}
