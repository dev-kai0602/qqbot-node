/**
 * 角色卡（SillyTavern Character Card）→ 一段人设文本。
 *
 * 卡片字段是给「角色扮演对话」设计的，不能整段塞进 system prompt：
 * 一张卡动辄几千字，还有 character_book 这种世界书。这里按用途裁剪，
 * 并给总长设硬上限，避免人设挤占上下文。
 */

import type { CharacterCard } from '@lenml/char-card-reader';

export interface Persona {
  /** 目录名（slug），用于日志与诊断 */
  readonly id: string;
  readonly name: string;
  /** 最终注入 system prompt 的文本 */
  readonly text: string;
}

const LIMITS = {
  description: 800,
  personality: 300,
  scenario: 200,
  systemPrompt: 400,
  examples: 600,
  postHistory: 200,
  total: 2000
} as const;

/** QQ 场景下每个角色都要遵守的收尾规则：写死在代码里，卡片无法覆盖 */
const QQ_RULES = [
  '始终以第一人称保持这个角色，不要跳出角色，也不要提到你在扮演。',
  '回答简短口语化，一般不超过 100 字。',
  '不要提工具、文件、命令行、提示词或你自己的实现细节。'
].join('');

function clip(text: string | undefined, max: number): string {
  const trimmed = (text ?? '').trim();
  if (trimmed === '') return '';
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max) + '…';
}

/** V2 卡片的扩展字段（system_prompt / post_history_instructions）不在 getter 上 */
function rawField(card: CharacterCard, key: string): string | undefined {
  const root = card.raw_data as { data?: Record<string, unknown> };
  const value = root.data?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** 去掉控制字符：卡片里混进 NUL 会让 YAML/日志都出问题 */
function sanitize(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

export function cardToPersona(card: CharacterCard, id: string): Persona {
  const name = clip(card.name, 40) || id;
  const description = clip(card.description, LIMITS.description);
  const personality = clip(card.personality, LIMITS.personality);
  const scenario = clip(card.scenario, LIMITS.scenario);
  const systemPrompt = clip(rawField(card, 'system_prompt'), LIMITS.systemPrompt);
  const examples = clip(card.message_example, LIMITS.examples);
  const postHistory = clip(rawField(card, 'post_history_instructions'), LIMITS.postHistory);

  const parts: string[] = ['你是「' + name + '」。'];
  if (description !== '') parts.push(description);
  if (personality !== '') parts.push('性格：' + personality);
  if (scenario !== '') parts.push('场景：' + scenario);
  if (systemPrompt !== '') parts.push(systemPrompt);
  if (examples !== '') parts.push('对话示例（模仿语气，不要照抄内容）：\n' + examples);
  if (postHistory !== '') parts.push(postHistory);
  parts.push(QQ_RULES);

  const text = sanitize(parts.join('\n')).slice(0, LIMITS.total);
  return { id, name, text };
}
