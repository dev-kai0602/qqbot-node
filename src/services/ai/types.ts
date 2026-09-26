/**
 * AI 服务内部类型：Provider 抽象。
 *
 * Provider 抽出来是为了两件事：
 *  1. 测试可以注入假 Provider，不打真实 API
 *  2. 换模型供应商只改一个实现文件
 *
 * 插件面向的契约（AiRequest / AiReply / AiService）在 src/types.ts。
 */

import type { ChatMessage, ReasoningEffort } from '../../types.js';

export interface ChatProviderRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly maxTokens: number;
  /** 传给模型用于内容安全与 KVCache 隔离；不要放隐私信息 */
  readonly userId: string;
  readonly reasoningEffort: ReasoningEffort;
}

export interface ChatProviderResponse {
  readonly text: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface ChatProvider {
  /** 失败一律抛错；调用方负责降级 */
  complete(req: ChatProviderRequest, signal?: AbortSignal): Promise<ChatProviderResponse>;
}
