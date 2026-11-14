import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CharacterCard } from '@lenml/char-card-reader';
import { cardToPersona } from '../src/services/persona/card.js';
import { loadPersona, readPersonaPointer, renderPersonaPatch } from '../src/services/persona/index.js';
import type { Logger } from '../src/types.js';

const log: Logger = { info() {}, warn() {}, error() {}, debug() {} };

function card(overrides: Record<string, unknown> = {}): CharacterCard {
  return CharacterCard.from_json({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '小音',
      description: '一只住在群里的猫娘。',
      personality: '活泼、爱撒娇',
      scenario: 'QQ 群聊',
      mes_example: '<START>\n{{user}}: 在吗\n{{char}}: 在的在的～',
      system_prompt: '',
      post_history_instructions: '',
      ...overrides
    }
  });
}

describe('角色卡 → 人设', () => {
  it('把名字/描述/性格/场景拼成人设，并追加 QQ 规则', () => {
    const p = cardToPersona(card(), 'neko');
    expect(p.id).toBe('neko');
    expect(p.name).toBe('小音');
    expect(p.text).toContain('你是「小音」');
    expect(p.text).toContain('一只住在群里的猫娘。');
    expect(p.text).toContain('性格：活泼、爱撒娇');
    expect(p.text).toContain('场景：QQ 群聊');
    expect(p.text).toContain('不要提工具');
  });

  it('超长字段被裁剪，总长有硬上限', () => {
    const p = cardToPersona(card({ description: 'x'.repeat(5000) }), 'big');
    expect(p.text.length).toBeLessThanOrEqual(2000);
    expect(p.text).toContain('…');
  });

  it('空卡片也能给出可用人设（不抛错）', () => {
    const p = cardToPersona(CharacterCard.from_json({ spec: 'chara_card_v2', spec_version: '2.0', data: {} }), 'empty');
    expect(p.name).toBe('empty');
    expect(p.text.length).toBeGreaterThan(0);
  });
});

describe('yaml patch 渲染', () => {
  it('只覆盖 system-prompt，字符串用 JSON 转义', () => {
    const yaml = renderPersonaPatch({ id: 'neko', name: '小音', text: '带"引号"和\n换行' });
    expect(yaml).toContain('- id: system-prompt');
    expect(yaml).toContain('personaPrefix: "');
    // JSON 字符串本身能被 JSON.parse 还原
    const quoted = yaml.split('personaPrefix: ')[1]?.trim() ?? '';
    expect(JSON.parse(quoted)).toBe('带"引号"和\n换行');
  });
});

describe('加载与指针文件', () => {
  async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'persona-'));
    try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it('指针缺失时不加载', async () => {
    await withDir(async (dir) => {
      expect(readPersonaPointer(join(dir, 'persona'))).toBeUndefined();
      await expect(loadPersona({ dir: join(dir, 'personas'), pointerFile: join(dir, 'persona'), log }))
        .resolves.toBeUndefined();
    });
  });

  it('指针 + card.json 正常加载', async () => {
    await withDir(async (dir) => {
      const personas = join(dir, 'personas');
      mkdirSync(join(personas, 'neko'), { recursive: true });
      writeFileSync(join(dir, 'persona'), 'neko\n');
      writeFileSync(join(personas, 'neko', 'card.json'), JSON.stringify({
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: { name: '小音', description: '猫娘' }
      }));
      const p = await loadPersona({ dir: personas, pointerFile: join(dir, 'persona'), log });
      expect(p?.id).toBe('neko');
      expect(p?.text).toContain('猫娘');
    });
  });

  it('slug 带路径穿越时拒绝加载', async () => {
    await withDir(async (dir) => {
      writeFileSync(join(dir, 'persona'), '../etc\n');
      await expect(loadPersona({ dir: join(dir, 'personas'), pointerFile: join(dir, 'persona'), log }))
        .resolves.toBeUndefined();
    });
  });

  it('卡片缺失时返回 undefined 而不是抛错', async () => {
    await withDir(async (dir) => {
      writeFileSync(join(dir, 'persona'), 'ghost\n');
      await expect(loadPersona({ dir: join(dir, 'personas'), pointerFile: join(dir, 'persona'), log }))
        .resolves.toBeUndefined();
    });
  });
});
