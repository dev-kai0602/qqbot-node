import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CITY_COMMAND, WEATHER_COMMAND, createWeatherPlugin, weatherText
} from '../src/plugins/features/weather.js';
import { createMemoryKVStore } from '../src/services/storage/memory.js';
import { stubServices, stubStorage, testLog } from './helpers.js';
import type { BotApi, BotContext, PluginContext } from '../src/types.js';
import type { KVStore } from '../src/services/storage/types.js';

const BEIJING = { name: '北京', admin1: '北京市', latitude: 39.9075, longitude: 116.39723 };
const SHANGHAI = { name: '上海', admin1: '上海市', latitude: 31.22222, longitude: 121.45806 };

const FORECAST = {
  current: { temperature_2m: 19.3, relative_humidity_2m: 83, weather_code: 3, wind_speed_10m: 12.4 },
  daily: { temperature_2m_max: [24.1], temperature_2m_min: [15.2] }
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response;
}

function stubFetch(): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('geocoding')) {
      const decoded = decodeURIComponent(url);
      if (decoded.includes('name=上海')) return jsonResponse({ results: [SHANGHAI] });
      if (decoded.includes('name=不存在')) return jsonResponse({ results: [] });
      return jsonResponse({ results: [BEIJING] });
    }
    return jsonResponse(FORECAST);
  });
  return { urls };
}

function harness(kv: KVStore, content: string): { ctx: PluginContext; event: BotContext; replies: string[] } {
  const replies: string[] = [];
  const api: BotApi = {
    reply: async (_ctx, text) => { replies.push(text); },
    send: async () => {}
  };
  const services = stubServices({ storage: stubStorage({ kv }) });
  const event: BotContext = {
    event: {
      rawEventType: 'C2C_MESSAGE_CREATE',
      kind: 'c2c',
      senderId: 'ME',
      content,
      messageId: 'm1',
      timestamp: '0'
    },
    target: { scope: 'c2c', targetId: 'ME' },
    state: {},
    log: testLog
  };
  const config = {
    get: () => undefined,
    string: (k: string, d: string) => (k === 'city' ? '北京' : d),
    bool: (_k: string, d: boolean) => d,
    number: (k: string, d: number) => (k === 'cacheMinutes' ? 10 : d)
  };
  return { ctx: { api, log: testLog, config, services }, event, replies };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('weatherText', () => {
  it('覆盖 WMO 主要代码，未知码不崩', () => {
    expect(weatherText(0)).toBe('晴');
    expect(weatherText(3)).toBe('阴');
    expect(weatherText(65)).toBe('大雨');
    expect(weatherText(95)).toBe('雷阵雨');
    expect(weatherText(999)).toContain('未知天气');
  });
});

describe('weather 插件', () => {
  it('只响应 /天气 与 /城市', async () => {
    stubFetch();
    const h = harness(createMemoryKVStore(), '随便聊聊');
    expect(await createWeatherPlugin().handle?.(h.event, h.ctx)).toBe(false);
    expect(h.replies.length).toBe(0);
  });

  it('正常查询：地名 + 天气 + 温度区间，且不带缓存提示', async () => {
    stubFetch();
    const h = harness(createMemoryKVStore(), WEATHER_COMMAND);
    expect(await createWeatherPlugin().handle?.(h.event, h.ctx)).toBe(true);
    const text = h.replies[0] ?? '';
    expect(text).toContain('北京');
    expect(text).toContain('阴');
    expect(text).toContain('19.3°C');
    expect(text).toContain('15~24°C');
    expect(text).toContain('湿度 83%');
    expect(text).not.toContain('缓存');
  });

  it('10 分钟内重复查询命中缓存：内容一致且不再打上游', async () => {
    const stub = stubFetch();
    const kv = createMemoryKVStore();
    const plugin = createWeatherPlugin();
    const h1 = harness(kv, WEATHER_COMMAND);
    await plugin.handle?.(h1.event, h1.ctx);
    const afterFirst = stub.urls.length;
    const h2 = harness(kv, WEATHER_COMMAND);
    await plugin.handle?.(h2.event, h2.ctx);
    expect(stub.urls.length).toBe(afterFirst);
    expect(h2.replies[0]).toBe(h1.replies[0]);
  });

  it('地名查不到时给出人话，而不是报错', async () => {
    stubFetch();
    const h = harness(createMemoryKVStore(), WEATHER_COMMAND + ' 不存在的地方');
    expect(await createWeatherPlugin().handle?.(h.event, h.ctx)).toBe(true);
    expect(h.replies[0]).toContain('没找到');
  });

  it('上游 5xx 时降级为人话，不把异常抛给 registry', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ error: 'boom' }, 500));
    const h = harness(createMemoryKVStore(), WEATHER_COMMAND);
    await expect(createWeatherPlugin().handle?.(h.event, h.ctx)).resolves.toBe(true);
    expect(h.replies[0]).toContain('查天气失败');
  });

  it('带参数的城市会覆盖默认城市', async () => {
    const stub = stubFetch();
    const h = harness(createMemoryKVStore(), WEATHER_COMMAND + ' 上海');
    await createWeatherPlugin().handle?.(h.event, h.ctx);
    expect(decodeURIComponent(stub.urls[0] ?? '')).toContain('name=上海');
  });
});

describe('weather 插件 · /城市', () => {
  it('未设置时提示怎么设，并给出当前默认', async () => {
    stubFetch();
    const h = harness(createMemoryKVStore(), CITY_COMMAND);
    await createWeatherPlugin().handle?.(h.event, h.ctx);
    expect(h.replies[0]).toContain('还没设置过城市');
    expect(h.replies[0]).toContain('北京');
  });

  it('设置城市会先校验存在性，并存下规范名', async () => {
    const stub = stubFetch();
    const kv = createMemoryKVStore();
    const plugin = createWeatherPlugin();
    const h = harness(kv, CITY_COMMAND + ' 上海');
    await plugin.handle?.(h.event, h.ctx);
    expect(h.replies[0]).toContain('上海');
    expect(kv.get('weather', 'city:ME')).toBe('上海');
    expect(decodeURIComponent(stub.urls[0] ?? '')).toContain('name=上海');
  });

  it('设置不存在的城市会被拒绝，不落库', async () => {
    stubFetch();
    const kv = createMemoryKVStore();
    const h = harness(kv, CITY_COMMAND + ' 不存在的地方');
    await createWeatherPlugin().handle?.(h.event, h.ctx);
    expect(h.replies[0]).toContain('没找到');
    expect(kv.get('weather', 'city:ME')).toBeUndefined();
  });

  it('设置后 /天气 用用户的城市，而不是插件默认', async () => {
    const stub = stubFetch();
    const kv = createMemoryKVStore();
    const plugin = createWeatherPlugin();
    const set = harness(kv, CITY_COMMAND + ' 上海');
    await plugin.handle?.(set.event, set.ctx);

    const ask = harness(kv, WEATHER_COMMAND);
    await plugin.handle?.(ask.event, ask.ctx);
    expect(ask.replies[0]).toContain('上海');
    expect(decodeURIComponent(stub.urls[stub.urls.length - 1] ?? '')).toContain('latitude=31.2222');
  });

  it('再次 /城市 会显示已设置的城市', async () => {
    stubFetch();
    const kv = createMemoryKVStore();
    const plugin = createWeatherPlugin();
    const set = harness(kv, CITY_COMMAND + ' 上海');
    await plugin.handle?.(set.event, set.ctx);
    const again = harness(kv, CITY_COMMAND);
    await plugin.handle?.(again.event, again.ctx);
    expect(again.replies[0]).toContain('当前的城市是「上海」');
  });
});
