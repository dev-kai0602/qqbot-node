/**
 * 内部事件模型、插件契约与 AI 契约。
 *
 * 这一层刻意不引用 SDK 类型：插件只认识下面这些接口，
 * 于是「换 SDK」只需要改 transport/bot.ts 一个文件。
 */

import type { AgentGateway } from './services/agent/types.js';
import type { StorageService } from './services/storage/types.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

export type ChatScope = 'c2c' | 'group';

export interface ReplyTarget {
  scope: ChatScope;
  targetId: string;
  msgId?: string;
}

export type ChatKind = 'c2c' | 'group' | 'guild' | 'dm';

export interface InboundEvent {
  /** 平台原始事件名，例如 GROUP_AT_MESSAGE_CREATE */
  rawEventType: string;
  kind: ChatKind;
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: string;
  groupOpenid?: string;
}

export interface BotContext {
  readonly event: InboundEvent;
  readonly target: ReplyTarget;
  /** 单次事件内共享的状态槽，插件之间可读写 */
  readonly state: Record<string, unknown>;
  readonly log: Logger;
  /**
   * 本次分发的取消信号：分发超时或进程退出时 abort。
   * 长耗时操作（AI 调用、下载）必须把它透传下去，否则超时只丢弃结果、
   * 底层工作还在跑，迟到的回复照样会发出去。
   */
  readonly signal?: AbortSignal;
}

/**
 * 插件可见的机器人动作能力。
 * 刻意保持窄：这里只放「发消息」这一件事。
 * 群管理、富媒体等能力走 services 注入，不要往这里堆。
 */
export interface BotApi {
  /** 回复触发本事件的消息（被动消息，受 5 分钟窗口约束） */
  reply(ctx: BotContext, text: string): Promise<void>;
  /** 主动发送（受配额与用户开关约束） */
  send(target: ReplyTarget, text: string): Promise<void>;
}

/** 插件配置访问器：带类型转换与默认值兜底 */
export interface PluginConfig {
  get(key: string): unknown;
  string(key: string, fallback: string): string;
  bool(key: string, fallback: boolean): boolean;
  number(key: string, fallback: number): number;
}

// ---------------------------------------------------------------------------
// AI 契约（插件面向的接口；Provider 实现细节在 services/ai/ 内）
// ---------------------------------------------------------------------------

export type ChatRole = 'system' | 'user' | 'assistant';

/** 思考模式档位；'none' 表示关闭 thinking */
export type ReasoningEffort = 'none' | 'low' | 'high' | 'max';

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

export interface AiRequest {
  /** 会话键：决定上下文隔离（群用群 openid，单聊用用户 openid） */
  readonly sessionKey: string;
  /** 用户标识，作为 user_id 传给模型 */
  readonly userId: string;
  /**
   * 说话人展示名。
   * 群聊共享上下文时必须提供，服务层会用它给该条消息加 [昵称] 前缀；
   * 单聊只有一个说话人，省略即可（不加前缀）。
   */
  readonly speaker?: string;
  readonly text: string;
}

export interface AiReply {
  readonly text: string;
  /** true 表示走了降级话术（超时 / 失败 / 预算用尽 / 空回复） */
  readonly degraded: boolean;
  readonly reason?: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly costCny?: number;
}

export interface AiService {
  /** 是否具备调用条件（配置齐全）；false 时插件应当放弃处理 */
  readonly available: boolean;
  chat(req: AiRequest, signal?: AbortSignal): Promise<AiReply>;
  /** 当日已花费（元） */
  spentCny(): number;
  /** 当日预算上限（元）；用于状态展示与告警阈值 */
  budgetLimitCny(): number;
  /** 某会话当前的上下文条数（诊断用） */
  contextSize(sessionKey: string): number;
  /** 清空某会话上下文 */
  resetContext(sessionKey: string): void;
}

/** 内容安全判定结果 */
export interface SafetyVerdict {
  readonly hit: boolean;
  readonly matched: readonly string[];
}

export interface SafetyService {
  checkInput(text: string): SafetyVerdict;
  checkOutput(text: string): SafetyVerdict;
  /** 输出命中时的替换话术 */
  readonly refusalText: string;
}

// ---------------------------------------------------------------------------
// 指标与告警契约
// ---------------------------------------------------------------------------

export type MetricName =
  | 'eventsIn'
  | 'repliesSent'
  | 'replyFailures'
  | 'duplicatesDropped'
  | 'rateLimited'
  | 'unsupportedScope'
  | 'gatewayReady'
  | 'gatewayResumed'
  | 'gatewayErrors'
  | 'aiCalls'
  | 'aiFailures'
  | 'aiDegraded'
  | 'safetyInputHits'
  | 'safetyOutputBlocks'
  | 'pluginFailures';

export interface MetricsSnapshot {
  readonly startedAt: number;
  readonly uptimeSec: number;
  readonly counters: Readonly<Partial<Record<MetricName, number>>>;
  readonly eventsByKind: Readonly<Record<string, number>>;
  readonly aiSpentCny: number;
  readonly aiBudgetCny: number | null;
  readonly storageKind: string;
}

export interface MetricsService {
  inc(name: MetricName, by?: number): void;
  /** 按事件类型计数（GROUP_AT_MESSAGE_CREATE 等） */
  countEvent(kind: string): void;
  addSpend(cny: number): void;
  /** 记录一次 AI 调用结果，用于连续失败检测 */
  noteAiResult(ok: boolean): void;
  snapshot(): MetricsSnapshot;
  close(): void;
}

/**
 * 告警出口。
 *
 * 现在只有日志实现（createLogAlertSink）；将来接入事务邮件时新增一个实现即可，
 * 采集侧代码不需要改动——这正是先不做邮件、但先留接口的意义。
 */
export interface AlertSink {
  alert(level: 'warn' | 'error', code: string, message: string, meta?: Record<string, unknown>): void;
}

/**
 * 周期性任务。回调抛错会被调度器接住并记日志，不会升级成进程级异常。
 */
export interface SchedulerService {
  /** 注册周期任务；重名或间隔非正数会抛错 */
  every(name: string, intervalMs: number, fn: (now: number) => void | Promise<void>): void;
  /** 已注册的任务名（诊断用） */
  names(): readonly string[];
  close(): void;
}

/**
 * 服务容器：跨插件共享的能力。
 * 插件只从 PluginContext.services 取，不 import 具体实现。
 */
export interface Services {
  readonly log: Logger;
  readonly dataDir: string;
  /** 计算「今天」用的时区；签到与 AI 预算共用，避免各自实现导致口径不一致 */
  readonly timeZone: string;
  readonly ai: AiService;
  /** DSH agent；chat 的回复由它产生（ai 保留给尚未迁移的路径与预算） */
  readonly agent: AgentGateway;
  readonly safety: SafetyService;
  /** 消息存储；AI 上下文从这里读写，后续「签到」等插件也用它 */
  readonly storage: StorageService;
  /** 运行指标；/状态 命令与健康上报用它 */
  readonly metrics: MetricsService;
  /** 周期任务；插件用它注册定时工作（如提醒扫描） */
  readonly scheduler: SchedulerService;
}

/** setup / stop / handle 时交给插件的上下文 */
export interface PluginContext {
  readonly api: BotApi;
  readonly log: Logger;
  readonly config: PluginConfig;
  readonly services: Services;
}

/**
 * 插件契约。
 *
 * 加一个插件 = 在 src/plugins/features/ 下新增一个文件并默认导出本接口，
 * 不需要修改任何核心文件。
 */
export interface Plugin {
  readonly name: string;
  readonly commands?: readonly string[];
  /** 插件默认配置；核心会与用户配置合并后交给 setup */
  readonly defaults?: Readonly<Record<string, unknown>>;
  /** 启动时调用一次 */
  setup?(ctx: PluginContext): void | Promise<void>;
  /** 关闭时调用一次，用于释放定时器 / 连接 */
  stop?(ctx: PluginContext): void | Promise<void>;
  /**
   * 事件处理。
   * @returns true 表示已处理，链路终止
   */
  handle?(event: BotContext, ctx: PluginContext): boolean | Promise<boolean>;
}
