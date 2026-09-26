/**
 * 指标采集与健康上报。
 *
 * 设计取舍：
 *  - **只做进程内计数**，不引 Prometheus 客户端。单机单体服务，
 *    加一套 metric 导出与抓取管道是负收益。
 *  - **暴露方式先用两类**：① `/状态` 命令（人主动问）② 周期性 health 日志
 *    （journalctl 可查，将来告警器也能基于它判断）。
 *  - **告警通道抽象成 AlertSink**：现在只有日志实现，
 *    将来接事务邮件时只需新增一个实现，不用动采集侧代码。
 */

import type { AlertSink, Logger, MetricName, MetricsService, MetricsSnapshot } from '../types.js';

/** 默认每 5 分钟打一条 health 日志 */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/** 预算使用率达到该比例时告警 */
const BUDGET_ALERT_RATIO = 0.8;
/** AI 连续失败达到该次数时告警 */
const AI_FAILURE_ALERT_THRESHOLD = 5;

export interface MetricsOptions {
  log: Logger;
  alert: AlertSink;
  /** 健康日志间隔（毫秒）；0 表示不启动定时上报 */
  intervalMs?: number;
  /** 预算只读视图，由 AI 服务提供 */
  budget?: () => { spentCny: number; limitCny: number };
  /** 存储种类，仅用于状态展示 */
  storageKind?: string;
  now?: () => number;
}

/** 现在只有日志实现；将来加 createEmailAlertSink 时不改调用方 */
export function createLogAlertSink(log: Logger): AlertSink {
  return {
    alert(level, code, message, meta) {
      log[level]('alert: ' + message, { code, ...(meta ?? {}) });
    }
  };
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return d + ' 天 ' + h + ' 小时';
  if (h > 0) return h + ' 小时 ' + m + ' 分';
  if (m > 0) return m + ' 分 ' + s + ' 秒';
  return s + ' 秒';
}

export function createMetricsService(opts: MetricsOptions): MetricsService {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const counters = new Map<MetricName, number>();
  const eventsByKind = new Map<string, number>();
  let spendCny = 0;
  let consecutiveAiFailures = 0;
  let budgetAlerted = false;

  const snapshot = (): MetricsSnapshot => {
    const budget = opts.budget?.();
    const base: Record<string, number> = {};
    for (const [k, v] of counters) base[k] = v;
    return {
      startedAt,
      uptimeSec: Math.floor((now() - startedAt) / 1000),
      counters: base as unknown as MetricsSnapshot['counters'],
      eventsByKind: Object.fromEntries(eventsByKind),
      // 花费有两个来源：AI 预算（权威，按 token 实算）与内部 addSpend 累加。
      // 有 budget 闭包时以它为准——避免两套账各记各的、最后对不上。
      aiSpentCny: budget === undefined ? spendCny : budget.spentCny,
      aiBudgetCny: budget === undefined ? null : budget.limitCny,
      storageKind: opts.storageKind ?? 'unknown'
    };
  };

  const checkThresholds = (): void => {
    const budget = opts.budget?.();
    if (budget !== undefined && budget.limitCny > 0 && !budgetAlerted) {
      if (budget.spentCny >= budget.limitCny * BUDGET_ALERT_RATIO) {
        budgetAlerted = true;
        opts.alert.alert('warn', 'AI_BUDGET_HIGH', 'DeepSeek 预算已用 ' +
          (budget.spentCny / budget.limitCny * 100).toFixed(0) + '%', {
          spentCny: Number(budget.spentCny.toFixed(4)),
          limitCny: budget.limitCny
        });
      }
    }
    if (consecutiveAiFailures === AI_FAILURE_ALERT_THRESHOLD) {
      opts.alert.alert('error', 'AI_FAILURE_BURST', 'DeepSeek 连续失败 ' + consecutiveAiFailures + ' 次', {
        consecutive: consecutiveAiFailures
      });
    }
  };

  const timer = opts.intervalMs === 0
    ? undefined
    : setInterval(() => {
        checkThresholds();
        const snap = snapshot();
        opts.log.info('health', {
          uptimeSec: snap.uptimeSec,
          eventsIn: snap.counters.eventsIn ?? 0,
          repliesSent: snap.counters.repliesSent ?? 0,
          replyFailures: snap.counters.replyFailures ?? 0,
          aiCalls: snap.counters.aiCalls ?? 0,
          aiFailures: snap.counters.aiFailures ?? 0,
          aiSpentCny: Number(snap.aiSpentCny.toFixed(4)),
          aiBudgetCny: snap.aiBudgetCny,
          storageKind: snap.storageKind
        });
      }, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  if (timer !== undefined) timer.unref();

  return {
    inc(name, by = 1) {
      // 注意：这里刻意**不**在 aiCalls 时重置 consecutiveAiFailures。
      // 每次调用前都会 inc('aiCalls')，若在此重置，连续失败计数永远到不了阈值，
      // 告警就形同虚设。重置只发生在真正成功时（noteAiResult(true)）。
      counters.set(name, (counters.get(name) ?? 0) + by);
    },
    countEvent(kind) {
      eventsByKind.set(kind, (eventsByKind.get(kind) ?? 0) + 1);
    },
    addSpend(cny) {
      spendCny += cny;
    },
    noteAiResult(ok) {
      consecutiveAiFailures = ok ? 0 : consecutiveAiFailures + 1;
      if (!ok) checkThresholds();
    },
    snapshot,
    close() {
      if (timer !== undefined) clearInterval(timer);
    }
  };
}
