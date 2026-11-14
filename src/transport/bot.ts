/**
 * 接入层：全项目唯一 import SDK 的地方。
 * 只做两件事——把 SDK 事件归一化成内部模型，把内部动作翻译回 SDK 调用。
 * 业务逻辑一律不在这里。
 */

import { QQBot, rateLimiter } from '@tencent-connect/qqbot-nodejs';
import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type {
  BotApi, BotContext, ChatScope, InboundEvent, Logger, MetricsService, ReplyTarget
} from '../types.js';
import { DedupeWindow } from '../util/dedupe.js';
import { serializeError } from '../util/errors.js';

export interface BotTransportOptions {
  appId: string;
  appSecret: string;
  transport: 'websocket' | 'webhook';
  markdownSupport: boolean;
  /** 单用户限流窗口（毫秒）；0 表示关闭 */
  rateLimitPerUserMs: number;
  logger: Logger;
  metrics: MetricsService;
}

export type EventHandler = (ctx: BotContext) => Promise<void>;

function toScope(scope: QQBotInboundMessage['replyTarget']['scope']): ChatScope | undefined {
  if (scope === 'c2c' || scope === 'group') return scope;
  return undefined;
}

export class BotTransport implements BotApi {
  private readonly bot: QQBot;
  private readonly log: Logger;
  private readonly handler: EventHandler;
  private readonly transportMode: 'websocket' | 'webhook';
  private readonly dedupe = new DedupeWindow();
  private readonly metrics: MetricsService;
  private stopping = false;

  constructor(opts: BotTransportOptions, handler: EventHandler) {
    this.handler = handler;
    this.log = opts.logger;
    this.metrics = opts.metrics;
    this.transportMode = opts.transport;
    this.bot = new QQBot({
      appId: opts.appId,
      appSecret: opts.appSecret,
      transport: opts.transport,
      markdownSupport: opts.markdownSupport,
      logger: opts.logger
    });

    // 准入限流：单用户窗口内只放行一条，超出的直接丢弃。
    // 刻意不排队——排队只会在窗口过后补发一串迟到的回复，比丢弃更像机器人。
    if (opts.rateLimitPerUserMs > 0) {
      this.bot.use(rateLimiter({
        perSender: { max: 1, windowMs: opts.rateLimitPerUserMs },
        onLimit: (_ctx, tier) => {
          this.metrics.inc('rateLimited');
          this.log.warn('message rate limited', { tier, windowMs: opts.rateLimitPerUserMs });
        }
      }));
    }

    this.bot.on('ready', () => {
      this.metrics.inc('gatewayReady');
      this.log.info('gateway ready');
    });
    this.bot.on('resumed', () => {
      this.metrics.inc('gatewayResumed');
      this.log.info('gateway resumed');
    });
    this.bot.on('error', (err: Error) => {
      this.metrics.inc('gatewayErrors');
      this.log.error('gateway error', { error: serializeError(err) });
    });
    this.bot.on('message', (_ctx, msg) => {
      // 刻意不 await：事件要尽快交回 SDK 的事件循环。
      // 但必须兜住 Promise——否则这里就是 unhandledRejection 的来源。
      this.onMessage(msg).catch((err: unknown) => {
        this.log.error('onMessage failed', { error: serializeError(err) });
      });
    });
  }

  async start(signal?: AbortSignal): Promise<void> {
    this.log.info('connecting', { transport: this.transportMode });
    await this.bot.start(signal);
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.log.info('stopping transport');
    this.bot.stop();
  }

  async reply(ctx: BotContext, text: string): Promise<void> {
    try {
      await this.bot.sendText(ctx.target, text);
      this.metrics.inc('repliesSent');
      this.log.debug('replied', { scope: ctx.target.scope, chars: text.length });
    } catch (err) {
      // 计数后继续抛出：调用方的错误边界负责记录，这里只负责指标
      this.metrics.inc('replyFailures');
      throw err;
    }
  }

  async send(target: ReplyTarget, text: string): Promise<void> {
    try {
      // 主动消息不携带 msgId，避免被平台当成被动回复
      await this.bot.sendText({ scope: target.scope, targetId: target.targetId }, text);
      this.metrics.inc('repliesSent');
      this.log.info('proactive sent', { scope: target.scope, chars: text.length });
    } catch (err) {
      this.metrics.inc('replyFailures');
      throw err;
    }
  }

  private async onMessage(msg: QQBotInboundMessage): Promise<void> {
    if (this.dedupe.isDuplicate(msg.messageId)) {
      this.metrics.inc('duplicatesDropped');
      this.log.warn('duplicate message dropped', { messageId: msg.messageId });
      return;
    }

    // 不静默兜底：未知 scope 直接丢弃并告警，避免用错误的 scope 回复
    const scope = toScope(msg.replyTarget.scope);
    if (scope === undefined) {
      this.metrics.inc('unsupportedScope');
      this.log.warn('unsupported reply scope, event dropped', {
        scope: String(msg.replyTarget.scope),
        messageId: msg.messageId
      });
      return;
    }

    const event: InboundEvent = {
      rawEventType: msg.rawEventType,
      kind: msg.kind,
      senderId: msg.senderId,
      content: msg.content,
      messageId: msg.messageId,
      timestamp: msg.timestamp,
      ...(msg.senderName !== undefined ? { senderName: msg.senderName } : {}),
      ...(msg.groupOpenid !== undefined ? { groupOpenid: msg.groupOpenid } : {})
    };

    const ctx: BotContext = {
      event,
      target: {
        scope,
        targetId: msg.replyTarget.targetId,
        ...(msg.replyTarget.msgId !== undefined ? { msgId: msg.replyTarget.msgId } : {})
      },
      state: { receivedAt: Date.now() },
      log: this.log
    };

    this.metrics.inc('eventsIn');
    this.metrics.countEvent(event.kind);
    this.log.info('event in', {
      type: event.rawEventType,
      kind: event.kind,
      sender: event.senderId,
      senderName: event.senderName ?? null,
      chars: event.content.length
    });

    try {
      await this.handler(ctx);
    } catch (err) {
      // 错误边界：单个事件失败绝不能让长连接挂掉
      this.log.error('handler failed', { messageId: event.messageId, error: serializeError(err) });
    }
  }
}
