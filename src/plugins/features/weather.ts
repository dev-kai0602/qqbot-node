/**
 * 天气插件：/天气 [城市]，/城市 [城市]
 *
 * 关于「按用户 IP 定位」：**官方机器人做不到**。
 * 机器人是反向连接腾讯网关的，用户的 QQ 客户端从不连到我们，
 * 所以这一侧不存在能观察用户 IP 的网络路径；SDK 的事件载荷里
 * 也没有任何 IP / 经纬度 / 归属地字段（已全量 grep 确认）。
 * 因此改用「用户自己设默认城市」——效果等价且可实现：
 * 城市优先级 = 命令参数 > 用户设置 > 插件默认。
 *
 * 数据源选 Open-Meteo：免费、**无需 API Key**、自带中文地理编码，
 * 插件开箱即用（实测从本机可达）。换供应商只需要改本文件的两个 URL。
 *
 * 两级缓存都落在 KV 里：
 *  - 城市坐标几乎不变 → 长期缓存
 *  - 实时天气 → 缓存若干分钟，避免群里几个人同时问就把对方 API 打爆
 *
 * 失败一律降级成一句人话：插件 handle 抛错会被 registry 记为 pluginFailures，
 * 但用户那边什么都没收到——那是最差的体验。
 */

import type { BotContext, Plugin, PluginContext } from '../../types.js';
import type { KVStore } from '../../services/storage/types.js';
import { fetchJson, HttpError } from '../../util/http.js';

export const WEATHER_COMMAND = '/天气';
export const CITY_COMMAND = '/城市';
export const WEATHER_NAMESPACE = 'weather';

function userCityKey(userId: string): string {
  return 'city:' + userId;
}

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/** WMO 天气代码 → 中文。Open-Meteo 返回数字码，官方表格见其文档 */
const WMO_TEXT: Record<number, string> = {
  0: '晴',
  1: '大部晴朗',
  2: '局部多云',
  3: '阴',
  45: '有雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '小阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '大阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴小冰雹',
  99: '雷阵雨伴冰雹'
};

export function weatherText(code: number): string {
  return WMO_TEXT[code] ?? ('未知天气(' + code + ')');
}

interface GeoResult {
  readonly results?: ReadonlyArray<{
    readonly name: string;
    readonly latitude: number;
    readonly longitude: number;
    readonly admin1?: string;
    readonly country?: string;
  }>;
}

interface ForecastResult {
  readonly current?: {
    readonly temperature_2m?: number;
    readonly relative_humidity_2m?: number;
    readonly weather_code?: number;
    readonly wind_speed_10m?: number;
  };
  readonly daily?: {
    readonly temperature_2m_max?: readonly number[];
    readonly temperature_2m_min?: readonly number[];
  };
}

interface Place {
  readonly name: string;
  readonly admin1: string;
  readonly latitude: number;
  readonly longitude: number;
}

/** 从 KV 读缓存；过期或不存在返回 undefined */
function readCache<T>(kv: KVStore, key: string, ttlMs: number, now: number): T | undefined {
  const raw = kv.get(WEATHER_NAMESPACE, key);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as { at: number; data: T };
    if (now - parsed.at > ttlMs) return undefined;
    return parsed.data;
  } catch {
    return undefined;
  }
}

function writeCache<T>(kv: KVStore, key: string, data: T, now: number): void {
  kv.set(WEATHER_NAMESPACE, key, JSON.stringify({ at: now, data }));
}

async function resolvePlace(kv: KVStore, city: string, now: number): Promise<Place | undefined> {
  const cacheKey = 'geo:' + city;
  const cached = readCache<Place>(kv, cacheKey, 30 * 24 * 60 * 60 * 1000, now);
  if (cached !== undefined) return cached;

  const url = GEO_URL + '?name=' + encodeURIComponent(city) + '&count=1&language=zh&format=json';
  const geo = await fetchJson<GeoResult>(url);
  const first = geo.results?.[0];
  if (first === undefined) return undefined;

  const place: Place = {
    name: first.name,
    admin1: first.admin1 ?? '',
    latitude: first.latitude,
    longitude: first.longitude
  };
  writeCache(kv, cacheKey, place, now);
  return place;
}

function formatWeather(place: Place, forecast: ForecastResult): string {
  const cur = forecast.current ?? {};
  const temp = cur.temperature_2m;
  const code = cur.weather_code;
  const humidity = cur.relative_humidity_2m;
  const wind = cur.wind_speed_10m;
  const hi = forecast.daily?.temperature_2m_max?.[0];
  const lo = forecast.daily?.temperature_2m_min?.[0];

  const title = place.admin1 !== '' && place.admin1 !== place.name
    ? place.name + '（' + place.admin1 + '）'
    : place.name;

  const lines = [title + ' · ' + (code === undefined ? '天气未知' : weatherText(code))];
  if (temp !== undefined) {
    const range = hi !== undefined && lo !== undefined
      ? '（' + Math.round(lo) + '~' + Math.round(hi) + '°C）'
      : '';
    lines.push(temp.toFixed(1) + '°C' + range);
  }
  const extras: string[] = [];
  if (humidity !== undefined) extras.push('湿度 ' + Math.round(humidity) + '%');
  if (wind !== undefined) extras.push('风速 ' + Math.round(wind) + ' km/h');
  if (extras.length > 0) lines.push(extras.join('｜'));
  return lines.join('\n');
}

export function createWeatherPlugin(): Plugin {
  return {
    name: 'weather',
    commands: [WEATHER_COMMAND, CITY_COMMAND],
    defaults: { city: '北京', cacheMinutes: 10 },
    setup(ctx: PluginContext): void {
      ctx.log.info('weather plugin ready', {
        commands: [WEATHER_COMMAND, CITY_COMMAND],
        defaultCity: ctx.config.string('city', '北京'),
        cacheMinutes: ctx.config.number('cacheMinutes', 10)
      });
    },
    async handle(event: BotContext, ctx: PluginContext): Promise<boolean> {
      const text = event.event.content.trim();
      const kv = ctx.services.storage.kv;
      const cacheMs = Math.max(0, ctx.config.number('cacheMinutes', 10)) * 60 * 1000;
      const fallbackCity = ctx.config.string('city', '北京');

      // ---- /城市：查询或设置「我的默认城市」 ----
      if (text === CITY_COMMAND || text.startsWith(CITY_COMMAND + ' ')) {
        const arg = text.slice(CITY_COMMAND.length).trim();
        const key = userCityKey(event.event.senderId);

        if (arg === '') {
          const saved = kv.get(WEATHER_NAMESPACE, key);
          await ctx.api.reply(event, saved === undefined
            ? '你还没设置过城市。发「' + CITY_COMMAND + ' 上海」这样的格式设一下，' +
              '之后直接发 ' + WEATHER_COMMAND + ' 就查那里。当前默认是「' + fallbackCity + '」。'
            : '你当前的城市是「' + saved + '」。发「' + CITY_COMMAND + ' <新城市>」可以改。');
          return true;
        }

        // 先校验地名真的存在，避免把一个查不到的名字存进去、之后每次问都失败
        const place = await resolvePlace(kv, arg, Date.now()).catch(() => undefined);
        if (place === undefined) {
          await ctx.api.reply(event, '没找到「' + arg + '」这个地方，换个名字试试？');
          return true;
        }
        kv.set(WEATHER_NAMESPACE, key, place.name);
        await ctx.api.reply(event, '好，以后你问天气默认查「' + place.name + '」。');
        return true;
      }

      if (!text.startsWith(WEATHER_COMMAND)) return false;

      const arg = text.slice(WEATHER_COMMAND.length).trim();
      const saved = kv.get(WEATHER_NAMESPACE, userCityKey(event.event.senderId));
      // 优先级：命令里带的城市 > 用户自己设的 > 配置里的默认
      const city = arg !== '' ? arg : (saved ?? fallbackCity);
      const now = Date.now();

      try {
        const place = await resolvePlace(kv, city, now);
        if (place === undefined) {
          await ctx.api.reply(event, '没找到「' + city + '」这个地方，换个名字试试？');
          return true;
        }

        const cacheKey = 'now:' + place.latitude.toFixed(3) + ',' + place.longitude.toFixed(3);
        let forecast = readCache<ForecastResult>(kv, cacheKey, cacheMs, now);
        if (forecast === undefined) {
          const url = FORECAST_URL +
            '?latitude=' + place.latitude.toFixed(4) +
            '&longitude=' + place.longitude.toFixed(4) +
            '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m' +
            '&daily=temperature_2m_max,temperature_2m_min' +
            '&timezone=' + encodeURIComponent(ctx.services.timeZone) +
            '&forecast_days=1';
          forecast = await fetchJson<ForecastResult>(url);
          writeCache(kv, cacheKey, forecast, now);
        }

        await ctx.api.reply(event, formatWeather(place, forecast));
        return true;
      } catch (err) {
        const detail = err instanceof HttpError ? err.message : '未知错误';
        ctx.log.warn('weather lookup failed', { city, detail });
        await ctx.api.reply(event, '查天气失败了（' + detail + '），稍后再试试。');
        return true;
      }
    }
  };
}

export default createWeatherPlugin();
