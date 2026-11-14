/**
 * 形象加载：指针文件 -> 目录 -> 卡片 -> 人设 -> dsh patch。
 *
 * 磁盘布局（都在 QQBOT_PERSONAS_DIR 下）：
 *   personas/<slug>/card.png   或 card.jpg / card.webp / card.json
 * 指针文件（QQBOT_PERSONA_FILE，默认 data/persona）里只写 slug：
 *   neko
 * 指针缺失或为空 = 不加载卡片，沿用 patch 里的内置人设。
 *
 * 每次都重新读盘：换卡不需要重启，改指针文件下一条消息就生效。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CharacterCard } from '@lenml/char-card-reader';
import type { Logger } from '../../types.js';
import { serializeError } from '../../util/errors.js';
import { cardToPersona, type Persona } from './card.js';

export type { Persona } from './card.js';

/** 卡片文件名候选，按顺序找第一个存在的 */
const CARD_FILES = ['card.png', 'card.jpg', 'card.webp', 'card.json'] as const;
/** slug 只允许安全字符：它会拼进路径 */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export interface LoadPersonaOptions {
  /** 卡片根目录 */
  dir: string;
  /** 指针文件；不存在或内容为空表示不加载 */
  pointerFile: string;
  log: Logger;
}

/** 读指针文件里的 slug；没有就返回 undefined */
export function readPersonaPointer(pointerFile: string): string | undefined {
  if (!existsSync(pointerFile)) return undefined;
  const slug = readFileSync(pointerFile, 'utf8').trim();
  return slug === '' ? undefined : slug;
}

export async function loadPersona(opts: LoadPersonaOptions): Promise<Persona | undefined> {
  let slug: string | undefined;
  try {
    slug = readPersonaPointer(opts.pointerFile);
  } catch (err) {
    opts.log.error('persona pointer unreadable', { file: opts.pointerFile, error: serializeError(err) });
    return undefined;
  }
  if (slug === undefined) return undefined;

  if (!SLUG_RE.test(slug)) {
    opts.log.error('persona slug rejected', { slug });
    return undefined;
  }

  const cardPath = CARD_FILES
    .map((name) => join(opts.dir, slug, name))
    .find((p) => existsSync(p));
  if (cardPath === undefined) {
    opts.log.error('persona card not found', { slug, dir: opts.dir, looked: CARD_FILES.join(', ') });
    return undefined;
  }

  try {
    // .json 走 from_json：from_file 只对图片（PNG/JPEG/WebP）做内嵌元数据解析
    const card = cardPath.endsWith('.json')
      ? CharacterCard.from_json(JSON.parse(readFileSync(cardPath, 'utf8')) as Parameters<typeof CharacterCard.from_json>[0])
      : await CharacterCard.from_file(readFileSync(cardPath));
    const persona = cardToPersona(card, slug);
    opts.log.info('persona loaded', {
      id: persona.id,
      name: persona.name,
      chars: persona.text.length,
      card: cardPath
    });
    return persona;
  } catch (err) {
    opts.log.error('persona card unreadable', { card: cardPath, error: serializeError(err) });
    return undefined;
  }
}

/**
 * 渲染成 dsh 的 patch 文件：只覆盖 system-prompt，工具裁剪仍在 repo 里的静态补丁里。
 * YAML 是 JSON 的超集，所以用 JSON.stringify 生成双引号标量，免去手写转义。
 */
export function renderPersonaPatch(persona: Persona): string {
  return [
    '# 由 qqbot 按角色卡生成，请勿手改（改卡或改指针文件即可）',
    '# 卡片：' + persona.id,
    '- id: system-prompt',
    '  config:',
    '    personaPrefix: ' + JSON.stringify(persona.text),
    ''
  ].join('\n');
}

/** 写 patch 文件，返回路径；写失败只记日志（人设坏掉不该让机器人起不来） */
export function writePersonaPatch(file: string, persona: Persona, log: Logger): string | undefined {
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, renderPersonaPatch(persona), 'utf8');
    return file;
  } catch (err) {
    log.error('persona patch write failed', { file, error: serializeError(err) });
    return undefined;
  }
}
