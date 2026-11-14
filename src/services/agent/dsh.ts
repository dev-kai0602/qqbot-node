/**
 * 用 `dsh --profile headless` 实现 AgentGateway：一轮一个子进程。
 *
 * 为什么是子进程而不是常驻 runtime：
 *  - headless 是 DSH 的公开 CLI 契约（--json 输出 NDJSON 事件），不依赖内部 RPC；
 *  - 进程退出即回收内存，QQ 机器人的消息频率远低于进程启动成本；
 *  - 会话连续性由 `--session-id` 承担，id 落 KV，重启后仍能续上。
 *
 * 事件契约（实测）：
 *   {"type":"session","sessionId":"session-…"}
 *   {"type":"status","phase":"turn_start"|…}
 *   {"type":"final","sessionId":"…","text":"…","reason":{…}}
 * 最后一条 final 才是答案；reason.kind === 'error' 表示这一轮失败。
 */

import { spawn } from 'node:child_process';
import type { Logger } from '../../types.js';
import { serializeError } from '../../util/errors.js';
import type { KVStore } from '../storage/types.js';
import type { AgentGateway, AgentReply, AgentRequest } from './types.js';

export const AGENT_NAMESPACE = 'agent';
/** stderr 只留尾部，用于诊断 */
const STDERR_TAIL_LIMIT = 800;

export interface DshAgentOptions {
  log: Logger;
  /** 会话 id 落在这里，实现跨重启续聊 */
  kv: KVStore;
  /** dsh 可执行文件；默认取 PATH 里的 dsh */
  bin?: string;
  /** 固定附加参数（默认 ['--profile','headless','--json']） */
  baseArgs?: readonly string[];
  /** 单轮超时；超时直接杀掉子进程 */
  timeoutMs?: number;
  /** 子进程工作目录 */
  cwd?: string;
  /** 追加的环境变量（例如 DEEPSEEK_API_KEY） */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_ARGS = ['--profile', 'headless', '--json'] as const;
const DEFAULT_TIMEOUT_MS = 120_000;

interface FinalEvent {
  type: 'final';
  sessionId?: string;
  text?: string;
  reason?: { kind?: string; error?: { message?: string; code?: string } };
}

export function createDshAgent(opts: DshAgentOptions): AgentGateway {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bin = opts.bin ?? 'dsh';
  const baseArgs = [...(opts.baseArgs ?? DEFAULT_ARGS)];
  const cwd = opts.cwd ?? process.cwd();

  const runOne = (req: AgentRequest, signal?: AbortSignal): Promise<AgentReply> => {
    const stored = opts.kv.get(AGENT_NAMESPACE, 'session:' + req.sessionKey);
    const args = [...baseArgs, ...(stored === undefined ? [] : ['--session-id', stored]), '-'];

    return new Promise<AgentReply>((resolve) => {
      let settled = false;
      const finish = (reply: AgentReply): void => {
        if (settled) return;
        settled = true;
        resolve(reply);
      };

      const child = spawn(bin, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...opts.env }
      });

      let buffer = '';
      let stderrTail = '';
      let sessionId: string | undefined;
      let final: FinalEvent | undefined;

      const handleLine = (line: string): void => {
        if (line === '') return;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return; // 非 JSON 行（进度条之类）直接忽略
        }
        const rec = event as { type?: string; sessionId?: string };
        if (rec.type === 'session' && typeof rec.sessionId === 'string') {
          sessionId = rec.sessionId;
        } else if (rec.type === 'final') {
          final = event as FinalEvent;
        }
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
          handleLine(buffer.slice(0, idx).trimEnd());
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf('\n');
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      });

      const kill = (why: string): void => {
        if (settled) return;
        finish({
          text: '',
          ...(sessionId === undefined ? {} : { sessionId }),
          degraded: true,
          reason: why
        });
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已经退出 */
        }
      };

      const timer = setTimeout(() => { kill('timeout'); }, timeoutMs);
      const onAbort = (): void => { kill('aborted'); };
      if (signal !== undefined) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      child.on('error', (err: Error) => {
        opts.log.error('agent spawn failed', { bin, error: serializeError(err) });
        kill('spawn_failed');
      });

      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        // 收尾：最后一行可能没有换行
        if (buffer.trim() !== '') handleLine(buffer.trim());

        const sid = final?.sessionId ?? sessionId;
        if (sid !== undefined && sid !== stored) {
          try {
            opts.kv.set(AGENT_NAMESPACE, 'session:' + req.sessionKey, sid);
          } catch (err) {
            opts.log.warn('agent session id persist failed', { error: serializeError(err) });
          }
        }

        if (final === undefined) {
          opts.log.error('agent produced no final event', { code, session: req.sessionKey, stderr: stderrTail });
          finish({ text: '', ...(sid === undefined ? {} : { sessionId: sid }), degraded: true, reason: 'no_final' });
          return;
        }

        const failed = final.reason?.kind === 'error';
        const text = (final.text ?? '').trim();
        if (failed || text === '') {
          const message = final.reason?.error?.message ?? 'empty';
          opts.log.error('agent turn failed', { session: req.sessionKey, reason: message, code });
          finish({ text: '', ...(sid === undefined ? {} : { sessionId: sid }), degraded: true, reason: message });
          return;
        }

        finish({ text, ...(sid === undefined ? {} : { sessionId: sid }), degraded: false });
      });

      child.stdin.on('error', () => { /* 子进程提前退出时忽略 EPIPE */ });
      child.stdin.end(req.text);
    });
  };

  return {
    available: true,
    ask: runOne
  };
}
