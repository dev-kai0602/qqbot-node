/**
 * 说话人标签与渲染。
 *
 * 背景：官方机器人拿不到真实 QQ 号，只有 per-bot 的 openid（不可逆），
 * 以及可选的 username。群聊共享上下文时需要一个「人话」的标签来区分说话人。
 *
 * 策略：优先用平台给的昵称；没有就用 openid 尾部四位生成稳定短标签。
 * 不把完整 openid 塞进对话——它对模型没意义，也白白多占 token。
 */

export function speakerLabel(senderId: string, senderName?: string): string {
  if (senderName !== undefined) {
    const trimmed = senderName.trim();
    if (trimmed !== '') return trimmed;
  }
  const hex = senderId.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (hex.length < 4) return '某位用户';
  return '用户' + hex.slice(-4);
}

/**
 * 把一条用户消息渲染成发给模型的形式。
 *
 * 这是前缀约定的**唯一实现点**：实时消息与历史回放都走它，
 * 避免两边各写一遍导致格式漂移。
 */
export function renderUserMessage(speaker: string | undefined, text: string): string {
  return speaker === undefined ? text : '[' + speaker + '] ' + text;
}
