import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPluginEnabled, loadConfig } from '../src/config.js';
import { createPluginConfig } from '../src/plugins/config.js';

const SAVED = { ...process.env };

function clearQqbotEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('QQBOT_')) delete process.env[key];
  }
}

beforeEach(() => { clearQqbotEnv(); });

afterEach(() => {
  clearQqbotEnv();
  for (const [k, v] of Object.entries(SAVED)) {
    if (v !== undefined) process.env[k] = v;
  }
});

describe('配置与插件命名空间', () => {
  it('QQBOT_PLUGIN_<NAME>_<KEY> 折叠进 plugins 命名空间', () => {
    process.env['QQBOT_APP_ID'] = '123';
    process.env['QQBOT_APP_SECRET'] = 'x'.repeat(32);
    process.env['QQBOT_PLUGIN_PING_VERBOSE'] = 'false';
    process.env['QQBOT_PLUGIN_DEMO_CITY'] = '北京';
    const cfg = loadConfig('/nonexistent-env-file');
    expect(cfg.plugins['ping']?.['verbose']).toBe('false');
    expect(cfg.plugins['demo']?.['city']).toBe('北京');
  });

  it('核心不认识任何具体插件字段（加插件无需改 config.ts）', () => {
    process.env['QQBOT_APP_ID'] = '123';
    process.env['QQBOT_APP_SECRET'] = 'x'.repeat(32);
    process.env['QQBOT_PLUGIN_NEVER_HEARD_OF_IT_SOME_KEY'] = 'v';
    const cfg = loadConfig('/nonexistent-env-file');
    expect(cfg.plugins['never']?.['heard_of_it_some_key']).toBe('v');
  });

  it('插件默认启用，只有显式否定值才关闭', () => {
    process.env['QQBOT_APP_ID'] = '123';
    process.env['QQBOT_APP_SECRET'] = 'x'.repeat(32);
    const cfg = loadConfig('/nonexistent-env-file');
    expect(isPluginEnabled(cfg, 'anything')).toBe(true);
    expect(isPluginEnabled(cfg, 'ping')).toBe(true);
    process.env['QQBOT_PLUGIN_PING_ENABLED'] = 'false';
    const off = loadConfig('/nonexistent-env-file');
    expect(isPluginEnabled(off, 'ping')).toBe(false);
    expect(isPluginEnabled(off, 'echo')).toBe(true);
  });

  it('缺密钥时报错并指名缺哪一项', () => {
    expect(() => loadConfig('/nonexistent-env-file')).toThrow(/QQBOT_APP_ID/);
  });
});

describe('插件配置访问器', () => {
  it('env 侧的键被转成小写后，camelCase 的配置键仍能取到值', () => {
    // 回归：src/config.ts 把 QQBOT_PLUGIN_<NAME>_<KEY> 的 KEY 转成小写，
    // 而插件是用 camelCase 标识符读取的。两侧必须按同一规则归一化。
    const cfg = createPluginConfig({ cacheminutes: '60' }, { cacheMinutes: 10 });
    expect(cfg.number('cacheMinutes', 10)).toBe(60);
  });

  it('defaults 用 camelCase 时同样能取到', () => {
    const cfg = createPluginConfig({}, { maxRetries: 3 });
    expect(cfg.number('maxRetries', 3)).toBe(3);
  });

  it('大小写不敏感：env 侧写成大写也能匹配', () => {
    const cfg = createPluginConfig({ VERBOSE: 'false' }, { verbose: true });
    expect(cfg.bool('verbose', true)).toBe(false);
  });

  it('空字符串回落到默认值', () => {
    const cfg = createPluginConfig({ greeting: '' }, { greeting: '你好' });
    expect(cfg.string('greeting', '你好')).toBe('你好');
  });
});
