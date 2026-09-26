/**
 * 极简 HTTP JSON 客户端。
 *
 * 放在 util 而不是 services：它是无状态的纯工具，没有生命周期、没有配置、
 * 也不需要被 mock 成服务——插件直接 import 即可。
 *
 * 统一了三件容易各写各的事：超时、错误归一化、User-Agent。
 */

export class HttpError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export interface FetchJsonOptions {
  /** 单次请求硬超时（毫秒），默认 10 秒 */
  timeoutMs?: number;
  /** 部分公开 API 会拒绝空 UA */
  userAgent?: string;
  signal?: AbortSignal;
}

export async function fetchJson<T>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10000);
  const signal = opts.signal === undefined ? timeout : AbortSignal.any([opts.signal, timeout]);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': opts.userAgent ?? 'qqbot/0.1'
      },
      signal
    });
  } catch (err) {
    // 超时与网络错误都归到这里；调用方只需处理 HttpError 一种类型
    throw new HttpError('请求失败：' + (err instanceof Error ? err.message : String(err)));
  }

  if (!res.ok) {
    throw new HttpError('HTTP ' + res.status, res.status);
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new HttpError('响应不是合法 JSON');
  }
}
