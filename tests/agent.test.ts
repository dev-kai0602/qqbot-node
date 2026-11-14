import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_NAMESPACE, createDshAgent } from '../src/services/agent/dsh.js';
import { createMemoryKVStore } from '../src/services/storage/memory.js';
import type { Logger } from '../src/types.js';

const log: Logger = { info() {}, warn() {}, error() {}, debug() {} };

/** 用一段 shell 脚本冒充 dsh：测试不需要真的装 dsh，也不需要模型调用 */
function fakeDsh(body: string): { dir: string; bin: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'fake-dsh-'));
  const bin = join(dir, 'dsh');
  writeFileSync(bin, '#!/bin/sh\n' + body, 'utf8');
  chmodSync(bin, 0o755);
  return { dir, bin, cleanup: () => { rmSync(dir, { recursive: true, force: true }); } };
}

describe('DshAgent（headless 子进程）', () => {
  it('解析 NDJSON，取 final 的文本，并把会话 id 落 KV', async () => {
    const f = fakeDsh(`
task=$(cat)
printf '{"type":"session","sessionId":"session-t1"}\n'
printf '{"type":"status","phase":"turn_start","turn":1}\n'
printf '{"type":"final","sessionId":"session-t1","text":"收到:%s"}\n' "$task"
`);
    try {
      const kv = createMemoryKVStore();
      const agent = createDshAgent({ log, kv, bin: f.bin });
      const reply = await agent.ask({ sessionKey: 'group:g1', text: '你好' });
      expect(reply).toMatchObject({ text: '收到:你好', sessionId: 'session-t1', degraded: false });
      expect(kv.get(AGENT_NAMESPACE, 'session:group:g1')).toBe('session-t1');
    } finally {
      f.cleanup();
    }
  });

  it('第二次调用带上 --session-id 续聊', async () => {
    const f = fakeDsh(`
echo "$@" >> "$ARGV_FILE"
cat >/dev/null
printf '{"type":"final","sessionId":"session-t2","text":"x"}\n'
`);
    try {
      const argvFile = join(f.dir, 'argv.txt');
      const kv = createMemoryKVStore();
      kv.set(AGENT_NAMESPACE, 'session:group:g1', 'session-t2');
      const agent = createDshAgent({ log, kv, bin: f.bin, env: { ARGV_FILE: argvFile } });
      await agent.ask({ sessionKey: 'group:g1', text: 'hi' });
      const argv = readFileSync(argvFile, 'utf8');
      expect(argv).toContain('--session-id session-t2');
      expect(argv.trim().endsWith('-')).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it('final 报错时降级，不抛异常', async () => {
    const f = fakeDsh(`
cat >/dev/null
printf '{"type":"final","sessionId":"s","reason":{"kind":"error","error":{"message":"boom"}},"text":""}\n'
`);
    try {
      const agent = createDshAgent({ log, kv: createMemoryKVStore(), bin: f.bin });
      const reply = await agent.ask({ sessionKey: 'c2c:u1', text: 'hi' });
      expect(reply.degraded).toBe(true);
      expect(reply.reason).toBe('boom');
    } finally {
      f.cleanup();
    }
  });

  it('超时杀掉子进程并降级', async () => {
    const f = fakeDsh(`
cat >/dev/null
sleep 5
printf '{"type":"final","sessionId":"s","text":"late"}\n'
`);
    try {
      const agent = createDshAgent({ log, kv: createMemoryKVStore(), bin: f.bin, timeoutMs: 150 });
      const started = Date.now();
      const reply = await agent.ask({ sessionKey: 'c2c:u1', text: 'hi' });
      expect(reply.degraded).toBe(true);
      expect(reply.reason).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      f.cleanup();
    }
  });

  it('没有 final 事件时降级', async () => {
    const f = fakeDsh(`
cat >/dev/null
printf '{"type":"session","sessionId":"s9"}\n'
`);
    try {
      const agent = createDshAgent({ log, kv: createMemoryKVStore(), bin: f.bin });
      const reply = await agent.ask({ sessionKey: 'c2c:u1', text: 'hi' });
      expect(reply.degraded).toBe(true);
      expect(reply.reason).toBe('no_final');
    } finally {
      f.cleanup();
    }
  });
});
