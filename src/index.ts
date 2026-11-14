/**
 * 入口：装配 配置 -> 日志 -> 存储 -> 服务 -> 插件 -> 接入层，
 * 并负责进程级错误边界与优雅退出。
 *
 * 依赖方向（单向，不允许反向）：
 *   index.ts  ->  transport/  ->  SDK
 *   index.ts  ->  services/   ->  具体实现（ai / safety / storage）
 *   index.ts  ->  plugins/    ->  types.ts（只认识内部接口）
 *   plugins/  ->  services（经 PluginContext 注入，不直接 import 实现）
 */

import { mkdirSync } from 'node:fs';
import { isPluginEnabled, loadConfig } from './config.js';
import type { AppConfig } from './config.js';
import { createLogger } from './logger.js';
import { createServices } from './services/index.js';
import { createAiService, createUnavailableAi } from './services/ai/index.js';
import { createDshAgent, createUnavailableAgent } from './services/agent/dsh.js';
import { createDeepSeekProvider } from './services/ai/deepseek.js';
import { DailyBudget } from './services/ai/budget.js';
import { createSafetyService } from './services/safety.js';
import { createStorage } from './services/storage/index.js';
import { createLogAlertSink, createMetricsService } from './services/metrics.js';
import { createScheduler } from './services/scheduler.js';
import type { StorageService } from './services/storage/types.js';
import { BotTransport } from './transport/bot.js';
import { PluginRegistry } from './plugins/registry.js';
import { defaultFeaturesDir, loadPlugins } from './plugins/loader.js';
import { createPluginConfig } from './plugins/config.js';
import { serializeError } from './util/errors.js';
import { createDrainTracker } from './util/drain.js';
import type { AiService, BotContext, Logger, MetricsService, Plugin } from './types.js';

/**
 * 插件处理超时。
 *
 * 必须**晚于** AI 单次请求超时：否则一次正常的慢回复会被判成插件超时，
 * 分发继续往下走（echo 之类的前缀兜底插件会接走这条消息），
 * 而原 handler 稍后仍会把答案发出去 —— 用户收到两条回复。
 */
function pluginTimeoutMs(config: AppConfig): number {
  return Math.max(15000, config.ai.timeoutMs + 5000);
}

/** 退出时最多等在途事件多久 */
const SHUTDOWN_DRAIN_MS = 5000;
/** 插件 stop 最多等多久（超时也继续关资源，不能无限挂住进程） */
const SHUTDOWN_STOP_MS = 5000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function buildAi(
  config: AppConfig,
  log: Logger,
  storage: StorageService,
  metrics: MetricsService,
  budget: DailyBudget
): AiService {
  if (config.ai.apiKey === '') {
    return createUnavailableAi(log, 'missing_api_key');
  }
  return createAiService({
    log,
    provider: createDeepSeekProvider({
      apiKey: config.ai.apiKey,
      baseUrl: config.ai.baseUrl,
      timeoutMs: config.ai.timeoutMs
    }),
    model: config.ai.model,
    maxTokens: config.ai.maxTokens,
    reasoningEffort: config.ai.reasoningEffort,
    systemPrompt: config.ai.systemPrompt,
    budget,
    store: storage.messages,
    contextMessages: config.ai.contextMessages,
    contextChars: config.ai.contextChars,
    fallbackText: config.ai.fallbackText,
    budgetExhaustedText: config.ai.budgetExhaustedText,
    metrics
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger({
    level: config.logLevel,
    secrets: [config.appSecret, config.ai.apiKey]
  });

  // 进程级错误边界：崩溃就退出，让 systemd 拉起一个干净进程。
  // 继续运行一个状态可疑的进程，比重启一次危险得多。
  process.on('unhandledRejection', (reason: unknown) => {
    log.error('unhandledRejection, exiting', { error: serializeError(reason) });
    process.exit(1);
  });
  process.on('uncaughtException', (err: Error) => {
    log.error('uncaughtException, exiting', { error: serializeError(err) });
    process.exit(1);
  });

  mkdirSync(config.dataDir, { recursive: true });

  const storage = await createStorage({
    log,
    dataDir: config.dataDir,
    retentionDays: config.messageRetentionDays
  });
  // 指标与 AI 互相引用：指标需要读预算，AI 需要写计数。
  // 用闭包 + 延迟赋值打破这个环——budget() 只在真正取快照时才被调用。
  const alert = createLogAlertSink(log);
  let aiRef: AiService | undefined;
  const metrics = createMetricsService({
    log,
    alert,
    intervalMs: config.healthIntervalSec * 1000,
    storageKind: storage.kind,
    budget: () =>
      aiRef === undefined
        ? { spentCny: 0, limitCny: 0 }
        : { spentCny: aiRef.spentCny(), limitCny: aiRef.budgetLimitCny() }
  });
  // 预算由 agent 与旧的 AI 路径共用：两条路都该算进同一个每日上限
  const budget = new DailyBudget({
    dailyLimitCny: config.ai.dailyBudgetCny,
    priceInputCnyPerM: config.ai.priceInputCnyPerM,
    priceOutputCnyPerM: config.ai.priceOutputCnyPerM,
    timeZone: config.timeZone,
    // 落库：否则进程一重启预算就归零，每日熔断等于失效
    persistence: storage.spend,
    onPersistError: (err: unknown) => {
      log.error('budget persist failed', { error: serializeError(err) });
    }
  });

  const ai = buildAi(config, log, storage, metrics, budget);
  aiRef = ai;

  const agent = !config.agent.enabled
    ? createUnavailableAgent(log, 'agent_disabled')
    : config.ai.apiKey === ''
      ? createUnavailableAgent(log, 'missing_api_key')
      : createDshAgent({
          log,
          kv: storage.kv,
          bin: config.agent.bin,
          timeoutMs: config.agent.timeoutMs,
          cwd: config.dataDir,
          // 不把密钥写进新文件：复用 .env 里已有的这把
          env: { DEEPSEEK_API_KEY: config.ai.apiKey },
          budget,
          metrics,
          fallbackText: config.ai.fallbackText,
          budgetExhaustedText: config.ai.budgetExhaustedText
        });
  const safety = createSafetyService({
    extraTerms: config.ai.safetyExtraTerms,
    refusalText: config.ai.safetyRefusalText
  });
  const scheduler = createScheduler({ log });
  const services = createServices({
    log,
    dataDir: config.dataDir,
    timeZone: config.timeZone,
    ai,
    agent,
    safety,
    storage,
    metrics,
    scheduler
  });

  log.info('booting', {
    transport: config.transport,
    markdownSupport: config.markdownSupport,
    dataDir: config.dataDir,
    storageKind: storage.kind,
    storageLocation: storage.location,
    messageRetentionDays: config.messageRetentionDays,
    timeZone: config.timeZone,
    aiAvailable: ai.available,
    aiModel: ai.available ? config.ai.model : null,
    aiDailyBudgetCny: ai.available ? config.ai.dailyBudgetCny : null,
    // 启动时恢复的当日花费：用来证明预算确实跨重启存续（而不是归零）
    aiSpentTodayCny: ai.available ? Number(ai.spentCny().toFixed(6)) : null,
    healthIntervalSec: config.healthIntervalSec,
    node: process.version
  });

  // 插件自动发现：加插件 = 加文件，本文件不需要改动
  const loaded = await loadPlugins(defaultFeaturesDir(), log);
  const enabled: Plugin[] = [];
  const disabled: string[] = [];
  for (const plugin of loaded.plugins) {
    if (isPluginEnabled(config, plugin.name)) enabled.push(plugin);
    else disabled.push(plugin.name);
  }

  const registry = new PluginRegistry({
    log,
    handleTimeoutMs: pluginTimeoutMs(config),
    metrics
  });
  for (const plugin of enabled) registry.add(plugin);

  // 退出信号：SIGTERM 时中断在途任务；drain 用来等它们收尾后再关资源
  const controller = new AbortController();
  const drain = createDrainTracker();

  const transport = new BotTransport(
    {
      appId: config.appId,
      appSecret: config.appSecret,
      transport: config.transport,
      markdownSupport: config.markdownSupport,
      rateLimitPerUserMs: config.rateLimitPerUserMs,
      logger: log,
      metrics
    },
    async (ctx: BotContext): Promise<void> => {
      const release = drain.begin();
      try {
        // 退出信号一并下发：SIGTERM 时在途的 AI 调用会被立刻取消
        await registry.dispatch({ ...ctx, signal: controller.signal });
      } finally {
        release();
      }
    }
  );

  await registry.setupAll(
    transport,
    (plugin) => createPluginConfig(config.plugins[plugin.name] ?? {}, plugin.defaults ?? {}),
    services
  );

  log.info('plugins summary', {
    enabled: registry.names,
    disabled,
    failed: loaded.failed
  });

  let shuttingDown = false;
  let shutdownDone: Promise<void> | undefined;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn('shutdown requested', { signal, inflight: drain.inflight });

    // 1) 取消在途任务，handler 会尽快返回
    controller.abort();
    // 2) 停止接收新事件，drain 期间不会再起新的 handler
    transport.stop();

    // 3) 等在途任务收尾，再关插件与资源
    shutdownDone = (async () => {
      const drained = await drain.drain(SHUTDOWN_DRAIN_MS);
      if (!drained) {
        log.warn('drain timed out, closing with in-flight work', { inflight: drain.inflight });
      }
      await Promise.race([registry.stopAll(), delay(SHUTDOWN_STOP_MS)]);
      // 先停调度器：避免关闭过程中还触发新的定时任务
      scheduler.close();
      metrics.close();
      storage.close();
      log.info('shutdown complete', { drained });
    })();
  };
  process.on('SIGINT', () => { shutdown('SIGINT'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });

  await transport.start(controller.signal);
  // 等 shutdown 序列走完（drain → stopAll → 关资源）再退出进程
  if (shutdownDone !== undefined) await shutdownDone;
  log.info('transport stopped, bye');
}

main().catch((err: unknown) => {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      msg: 'fatal',
      error: serializeError(err)
    }) + '\n'
  );
  process.exit(1);
});
