/**
 * 统一的错误序列化。
 *
 * 之前这段逻辑在 index / transport / registry 里各写了一遍，且只取 message，
 * 把 stack 与 code 都丢了——排障时最需要的信息恰好没了。
 */

export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const out: Record<string, unknown> = { name: err.name, message: err.message };
    if (typeof err.stack === 'string') out['stack'] = err.stack;
    const code = (err as { code?: unknown }).code;
    if (code !== undefined) out['code'] = code;
    return out;
  }
  return { message: String(err) };
}
