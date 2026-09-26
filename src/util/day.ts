/**
 * 按指定时区计算「今天是哪天」。
 *
 * 为什么需要它：服务器跑在 UTC，而直接取本地日期会让「今天」在
 * 北京时间早上 8 点翻页——签到会莫名其妙地重置，AI 预算也会提前归零。
 *
 * 用 Intl 而不是自己算偏移：夏令时与历史时区变更交给 ICU，
 * 手写 +8 小时在 Asia/Shanghai 上碰巧对，换个时区就错。
 */

export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/** 形如 2026-09-24；字典序即时间序，可直接用于前缀扫描与比较 */
export function dayKey(timeZone: string, ms: number = Date.now()): string {
  try {
    // en-CA 的短日期格式恰好是 YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(ms));
  } catch {
    // 时区名非法时退回 UTC，至少不比崩溃更糟
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/** 某个瞬间在指定时区的墙上时间 */
export interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

export function wallClock(timeZone: string, ms: number = Date.now()): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // en-US + hour12:false 在午夜会给出 24，归一到 0
    hour: get('hour') % 24,
    minute: get('minute')
  };
}

/** 某瞬间在指定时区的 UTC 偏移（毫秒） */
function zoneOffsetMs(timeZone: string, ms: number): number {
  const w = wallClock(timeZone, ms);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  // 抹掉秒，避免 formatToParts 丢秒造成的偏差
  return asUtc - Math.floor(ms / 60000) * 60000;
}

/**
 * 把「指定时区的墙上时间」换算成 epoch 毫秒。
 *
 * 做法是先用 UTC 造一个猜测值，再看该瞬间在目标时区的偏移，迭代修正。
 * 迭代两次是为了让夏令时切换日也能收敛（Asia/Shanghai 无夏令时，一次就够）。
 */
export function zonedEpoch(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let result = guess - zoneOffsetMs(timeZone, guess);
  result = guess - zoneOffsetMs(timeZone, result);
  return result;
}

/** 格式化为「2026-09-24 19:30」这样的话术 */
export function formatInZone(timeZone: string, ms: number): string {
  const w = wallClock(timeZone, ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return w.year + '-' + p(w.month) + '-' + p(w.day) + ' ' + p(w.hour) + ':' + p(w.minute);
}

/** 由 dayKey 往前推 n 天（按日历天，不考虑时区边界） */
export function shiftDay(key: string, deltaDays: number): string {
  const parts = key.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return key;
  const t = Date.UTC(y, m - 1, d) + deltaDays * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
