/**
 * 每日预算熔断。
 *
 * 定位说明：¥20/天 对 flash 模型其实是极宽裕的额度（约 470 万输出 token/天），
 * 它真正的价值不是省钱，而是「跑飞时的熔断开关」——
 * 比如某个循环把上下文撑爆、或插件异常重试，预算会先把闸门落下。
 *
 * **正因为它承担的是安全职责，才必须跨重启存续**：
 * 早先的实现只存在内存里，进程一重启就归零，反复重启即可无限绕过熔断——
 * 那等于熔断器本身失效。现在通过 SpendStore 落库。
 */

import type { SpendStore } from '../storage/types.js';
import { DEFAULT_TIMEZONE, dayKey } from '../../util/day.js';

export interface BudgetOptions {
  /** 每日上限（元） */
  dailyLimitCny: number;
  /** 输入计价（元 / 百万 token） */
  priceInputCnyPerM: number;
  /** 输出计价（元 / 百万 token） */
  priceOutputCnyPerM: number;
  /** 注入 now 便于测试跨日重置 */
  now?: () => number;
  /** 计算「今天」用的时区；默认 Asia/Shanghai（服务器多为 UTC，直接用本地日期会错 8 小时） */
  timeZone?: string;
  /** 可选：跨重启持久化当日花费。不传则退回纯内存（重启归零） */
  persistence?: SpendStore;
  /** 持久化失败回调；不传则静默忽略。刻意不抛错——记账失败不该中断对话 */
  onPersistError?: (err: unknown) => void;
}

export class DailyBudget {
  private readonly limitCny: number;
  private readonly priceIn: number;
  private readonly priceOut: number;
  private readonly now: () => number;
  private readonly timeZone: string;
  private readonly persistence: SpendStore | undefined;
  private readonly onPersistError: ((err: unknown) => void) | undefined;
  private day: string;
  private spent = 0;

  constructor(opts: BudgetOptions) {
    this.limitCny = opts.dailyLimitCny;
    this.priceIn = opts.priceInputCnyPerM;
    this.priceOut = opts.priceOutputCnyPerM;
    this.now = opts.now ?? Date.now;
    this.timeZone = opts.timeZone ?? DEFAULT_TIMEZONE;
    this.persistence = opts.persistence;
    this.onPersistError = opts.onPersistError;
    this.day = this.today();
    this.spent = this.restore(this.day);
  }

  /** 是否还能发起新的调用 */
  canSpend(): boolean {
    this.roll();
    return this.spent < this.limitCny;
  }

  /** 记账，返回本次花费（元） */
  record(promptTokens: number, completionTokens: number): number {
    this.roll();
    const cost = (promptTokens / 1e6) * this.priceIn + (completionTokens / 1e6) * this.priceOut;
    this.spent += cost;
    this.persist();
    return cost;
  }

  spentCny(): number {
    this.roll();
    return this.spent;
  }

  limit(): number {
    return this.limitCny;
  }

  /** 当天键（YYYY-MM-DD），诊断用 */
  currentDay(): string {
    this.roll();
    return this.day;
  }

  /** 跨日：切到新的一天，并尝试读取该天已有的记录 */
  private today(): string {
    return dayKey(this.timeZone, this.now());
  }

  private roll(): void {
    const key = this.today();
    if (key === this.day) return;
    this.day = key;
    this.spent = this.restore(key);
  }

  private restore(day: string): number {
    if (this.persistence === undefined) return 0;
    try {
      return this.persistence.load(day) ?? 0;
    } catch (err) {
      this.onPersistError?.(err);
      return 0;
    }
  }

  private persist(): void {
    if (this.persistence === undefined) return;
    try {
      this.persistence.save(this.day, this.spent);
    } catch (err) {
      this.onPersistError?.(err);
    }
  }
}
