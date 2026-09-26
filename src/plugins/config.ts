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

export function createPluginConfig(
  raw: Readonly<Record<string, unknown>>,
  defaults: Readonly<Record<string, unknown>>
): PluginConfig {
  const read = (key: string): unknown => {
    const v = raw[key];
    return v === undefined ? defaults[key] : v;
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
