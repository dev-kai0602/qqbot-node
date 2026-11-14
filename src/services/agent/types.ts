/**
 * Agent 契约：插件只认识「把一句话交给 agent，拿回一句话」。
 *
 * 实现细节（现在是一轮一个 dsh headless 子进程）不暴露给插件，
 * 以后换成常驻 runtime 只需要换实现，插件与 chat 不用动。
 */
export interface AgentRequest {
  /** 会话键：决定 agent 侧上下文隔离（群用群 openid，单聊用用户 openid） */
  readonly sessionKey: string;
  readonly text: string;
}

export interface AgentReply {
  readonly text: string;
  /** 本轮 token 用量；没有 usage 事件时缺省（预算不记账） */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** agent 侧会话 id；首次调用后才有，供诊断与跨重启续聊 */
  readonly sessionId?: string;
  /** true 表示没拿到正常回答（超时 / 进程异常 / 模型报错），text 是兜底话术 */
  readonly degraded: boolean;
  readonly reason?: string;
}

export interface AgentGateway {
  /** 是否具备调用条件；false 时插件应当放弃处理 */
  readonly available: boolean;
  ask(req: AgentRequest, signal?: AbortSignal): Promise<AgentReply>;
}
