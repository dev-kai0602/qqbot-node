/**
 * DeepSeek Provider（OpenAI 兼容的 /chat/completions）。
 *
 * 两个已核实的细节：
 *  - 关闭 thinking：按官方文档，OpenAI 格式用 reasoning_effort='none'
 *    （默认开启且 effort=high，会显著拉长延迟，与 60s 超时冲突）
 *  - user_id：请求体顶层字段，字符集 [a-zA-Z0-9\-_]，用于内容安全与 KVCache 隔离
 */

import type { ChatProvider, ChatProviderRequest, ChatProviderResponse } from './types.js';

export interface DeepSeekProviderOptions {
  apiKey: string;
  baseUrl?: string;
  /** 单次请求硬超时（毫秒） */
  timeoutMs?: number;
}

interface DeepSeekResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function createDeepSeekProvider(opts: DeepSeekProviderOptions): ChatProvider {
  const baseUrl = (opts.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 60000;

  return {
    async complete(req: ChatProviderRequest, signal?: AbortSignal): Promise<ChatProviderResponse> {
      const timeout = AbortSignal.timeout(timeoutMs);
      const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

      const res = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + opts.apiKey
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          max_tokens: req.maxTokens,
          reasoning_effort: req.reasoningEffort,
          user_id: req.userId,
          stream: false
        }),
        signal: composed
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error('DeepSeek HTTP ' + res.status + ': ' + body.slice(0, 300));
      }

      const json = (await res.json()) as DeepSeekResponse;
      const text = json.choices?.[0]?.message?.content ?? '';
      return {
        text,
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0
      };
    }
  };
}
