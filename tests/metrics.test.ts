import { describe, expect, it } from 'vitest';
import { createMetricsService, formatDuration } from '../src/services/metrics.js';
import type { AlertSink, Logger } from '../src/types.js';

const log: Logger = { info() {}, warn() {}, error() {}, debug() {} };

interface AlertRecord {
  level: string;
  code: string;
  message: string;
}

function recorder(): { alerts: AlertRecord[]; sink: AlertSink } {
  const alerts: AlertRecord[] = [];
  return {
    alerts,
    sink: {
      alert: (level, code, message) => { alerts.push({ level, code, message }); }
    }
  };
}

describe('MetricsService', () => {
  it('计数、事件分类与花费累计', () => {
    const { sink } = recorder();
    const m = createMetricsService({ log, alert: sink, intervalMs: 0 });
    m.inc('eventsIn');
    m.inc('eventsIn', 2);
    m.countEvent('group');
    m.countEvent('group');
    m.countEvent('c2c');
    m.addSpend(0.5);
    const s = m.snapshot();
    expect(s.counters.eventsIn).toBe(3);
    expect(s.eventsByKind).toEqual({ group: 2, c2c: 1 });
    expect(s.aiSpentCny).toBeCloseTo(0.5, 6);
    m.close();
  });

  it('预算用到 80% 时告警，且只告一次', () => {
    const { sink, alerts } = recorder();
    let spent = 0;
    const m = createMetricsService({
      log, alert: sink, intervalMs: 0,
      budget: () => ({ spentCny: spent, limitCny: 20 })
    });
    spent = 15;                        // 75%，不告警
    m.noteAiResult(false);
    expect(alerts.length).toBe(0);
    spent = 16.5;                      // 82.5%，告警
    m.noteAiResult(false);
    expect(alerts.filter((a) => a.code === 'AI_BUDGET_HIGH').length).toBe(1);
    m.noteAiResult(false);             // 再触发也不重复告警
    expect(alerts.filter((a) => a.code === 'AI_BUDGET_HIGH').length).toBe(1);
    m.close();
  });

  it('AI 连续失败 5 次告警；成功一次即重置计数', () => {
    const { sink, alerts } = recorder();
    const m = createMetricsService({ log, alert: sink, intervalMs: 0 });
    for (let i = 0; i < 4; i += 1) m.noteAiResult(false);
    expect(alerts.length).toBe(0);
    m.noteAiResult(false);
    expect(alerts.filter((a) => a.code === 'AI_FAILURE_BURST').length).toBe(1);

    m.noteAiResult(true);              // 重置
    for (let i = 0; i < 5; i += 1) m.noteAiResult(false);
    expect(alerts.filter((a) => a.code === 'AI_FAILURE_BURST').length).toBe(2);
    m.close();
  });

  it('inc(aiCalls) 不得重置连续失败计数（否则告警永远不触发）', () => {
    const { sink, alerts } = recorder();
    const m = createMetricsService({ log, alert: sink, intervalMs: 0 });
    for (let i = 0; i < 5; i += 1) {
      m.inc('aiCalls');                 // 真实流程：每次调用前都会 inc
      m.inc('aiFailures');
      m.noteAiResult(false);
    }
    expect(alerts.filter((a) => a.code === 'AI_FAILURE_BURST').length).toBe(1);
    expect(m.snapshot().counters.aiCalls).toBe(5);
    m.close();
  });
});

describe('formatDuration', () => {
  it('按量级选择单位', () => {
    expect(formatDuration(30_000)).toBe('30 秒');
    expect(formatDuration(5 * 60_000)).toBe('5 分 0 秒');
    expect(formatDuration(3 * 3600_000 + 12 * 60_000)).toBe('3 小时 12 分');
    expect(formatDuration(2 * 86400_000 + 3 * 3600_000)).toBe('2 天 3 小时');
  });
});
