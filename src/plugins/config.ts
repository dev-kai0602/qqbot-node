/**
 * 插件配置访问器。
 *
 * 核心把 QQBOT_PLUGIN_<NAME>_<KEY> 解析成 { key: value } 后交给这里，
 * 与插件自己声明的 defaults 合并，并做类型转换。
 * 这样插件读配置不需要知道环境变量长什么样，核心也不需要认识每个插件的字段。
 */

import type { PluginConfig } from '../types.js';

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'off'].includes(s)) return false;
  }
  return fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** 把配置对象的键统一成小写，供大小写不敏感查找 */
function lowerKeys(src: Readonly<Record<string, unknown>>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(src)) out.set(key.toLowerCase(), value);
  return out;
}

export function createPluginConfig(
  raw: Readonly<Record<string, unknown>>,
  defaults: Readonly<Record<string, unknown>>
): PluginConfig {
  // 大小写必须在两侧归一：src/config.ts 会把 env 里的 KEY 转成小写，
  // 而插件是用自己的标识符（通常是 camelCase）读取的。
  // 早先这里直接 raw[key] 查，导致 camelCase 的配置项永远取不到值、静默回落到默认值。
  const rawLower = lowerKeys(raw);
  const defaultsLower = lowerKeys(defaults);

  const read = (key: string): unknown => {
    const k = key.toLowerCase();
    const v = rawLower.get(k);
    return v === undefined ? defaultsLower.get(k) : v;
  };

  return {
    get: read,
    string(key: string, fallback: string): string {
      const v = read(key);
      return typeof v === 'string' && v !== '' ? v : fallback;
    },
    bool(key: string, fallback: boolean): boolean {
      return asBool(read(key), fallback);
    },
    number(key: string, fallback: number): number {
      return asNumber(read(key), fallback);
    }
  };
}
