/**
 * 插件管理器：注册 -> setup -> 按顺序分发 -> stop。
 *
 * 隔离策略：任何一个插件抛错都只影响它自己，不会中断其他插件或事件循环；
 * 另外给 handle 加了超时，避免一个卡住的插件阻塞整条链。
 */

import type {
  BotApi, BotContext, Logger, Plugin, PluginConfig, PluginContext, Services
} from '../types.js';
import type { MetricsService } from '../types.js';
import { serializeError } from '../util/errors.js';

export interface RegistryOptions {
  log: Logger;
  /** 单个插件处理一次事件的时间上限（毫秒）；0 或省略表示不限 */
  handleTimeoutMs?: number;
  /** 可选：没有指标服务时计数静默跳过 */
  metrics?: MetricsService;
}

interface Entry {
  readonly plugin: Plugin;
  ctx?: PluginContext;
}

function withTimeout<T>(work: Promise<T> | T, ms: number, label: string): Promise<T> {
  if (ms <= 0) return Promise.resolve(work);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('plugin timed out after ' + ms + 'ms: ' + label));
    }, ms);
  });
  return Promise.race([Promise.resolve(work), guard]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export class PluginRegistry {
  private readonly entries: Entry[] = [];
  private readonly log: Logger;
  private readonly handleTimeoutMs: number;
  private readonly metrics: MetricsService | undefined;

  constructor(opts: RegistryOptions) {
    this.log = opts.log;
    this.handleTimeoutMs = opts.handleTimeoutMs ?? 0;
    this.metrics = opts.metrics;
  }

  add(plugin: Plugin): this {
    if (this.entries.some((e) => e.plugin.name === plugin.name)) {
      throw new Error('插件重名：' + plugin.name);
    }
    this.entries.push({ plugin });
    return this;
  }

  get names(): readonly string[] {
    return this.entries.map((e) => e.plugin.name);
  }

  has(name: string): boolean {
    return this.entries.some((e) => e.plugin.name === name);
  }

  async setupAll(
    api: BotApi,
    configFor: (plugin: Plugin) => PluginConfig,
    services: Services
  ): Promise<void> {
    for (const entry of this.entries) {
      const ctx: PluginContext = {
        api,
        log: this.log,
        config: configFor(entry.plugin),
        services
      };
      entry.ctx = ctx;
      try {
        await entry.plugin.setup?.(ctx);
        this.log.info('plugin ready', {
          name: entry.plugin.name,
          commands: entry.plugin.commands ?? []
        });
      } catch (err) {
        this.metrics?.inc('pluginFailures');
        this.log.error('plugin setup failed', {
          plugin: entry.plugin.name,
          error: serializeError(err)
        });
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const entry of this.entries) {
      const ctx = entry.ctx;
      const stop = entry.plugin.stop;
      if (ctx === undefined || stop === undefined) continue;
      try {
        await stop(ctx);
        this.log.info('plugin stopped', { name: entry.plugin.name });
      } catch (err) {
        this.log.error('plugin stop failed', {
          plugin: entry.plugin.name,
          error: serializeError(err)
        });
      }
    }
  }

  async dispatch(event: BotContext): Promise<{ handled: boolean; by?: string }> {
    for (const entry of this.entries) {
      const handle = entry.plugin.handle;
      const ctx = entry.ctx;
      if (handle === undefined || ctx === undefined) continue;
      let handled = false;
      try {
        handled = await withTimeout(
          handle(event, ctx),
          this.handleTimeoutMs,
          entry.plugin.name
        );
      } catch (err) {
        this.metrics?.inc('pluginFailures');
        event.log.error('plugin failed', {
          plugin: entry.plugin.name,
          error: serializeError(err)
        });
        continue;
      }
      if (handled) {
        event.log.debug('event handled', { plugin: entry.plugin.name });
        return { handled: true, by: entry.plugin.name };
      }
    }
    event.log.debug('no plugin handled event', { type: event.event.rawEventType });
    return { handled: false };
  }
}
