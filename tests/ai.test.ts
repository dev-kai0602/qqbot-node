import { describe, expect, it } from 'vitest';
import { createAiService } from '../src/services/ai/index.js';
import { DailyBudget } from '../src/services/ai/budget.js';
import { createMemoryMessageStore } from '../src/services/storage/memory.js';
import type { MessageStore } from '../src/services/storage/types.js';
import type { ChatProvider } from '../src/services/ai/types.js';
import type { Logger } from '../src/types.js';

const log: Logger = { info() {}, warn() {}, error() {}, debug() {} };

function fixedProvider(text: string, promptTokens = 100, completionTokens = 50): ChatProvider {
  return {
    complete: async () => ({ text, promptTokens, completionTokens })
  };
}

/** 记录每次请求的 messages，用于断言组装结果 */
function recordingProvider(reply = '好的'): { provider: ChatProvider; seen: string[][] } {
  const seen: string[][] = [];
  const provider: ChatProvider = {
    complete: async (req) => {
      seen.push(req.messages.map((m) => m.role + ':' + m.content));
      return { text: reply, promptTokens: 1, completionTokens: 1 };
    }
  };
  return { provider, seen };
}

function makeService(provider: ChatProvider, budget?: DailyBudget, store?: MessageStore) {
  return createAiService({
    log,
    provider,
    model: 'test-model',
    maxTokens: 128,
    reasoningEffort: 'none',
    systemPrompt: 'SYS',
    budget: budget ?? new DailyBudget({ dailyLimitCny: 20, priceInputCnyPerM: 2.2, priceOutputCnyPerM: 8.6 }),
    store: store ?? createMemoryMessageStore(),
    contextMessages: 16,
    contextChars: 6000,
    fallbackText: 'FALLBACK',
    budgetExhaustedText: 'BUDGET_OUT'
  });
}

describe('AiService', () => {
  it('正常回复：返回文本并记账', async () => {
    const svc = makeService(fixedProvider('你好'));
    const r = await svc.chat({ sessionKey: 's1', userId: 'u1', text: 'hi' });
    expect(r.text).toBe('你好');
    expect(r.degraded).toBe(false);
    expect(r.promptTokens).toBe(100);
    expect(r.costCny).toBeGreaterThan(0);
    expect(svc.spentCny()).toBeGreaterThan(0);
  });

  it('Provider 抛错时降级，不把异常抛给插件', async () => {
    const boom: ChatProvider = {
      complete: async () => { throw new Error('network down'); }
    };
    const svc = makeService(boom);
    const r = await svc.chat({ sessionKey: 's1', userId: 'u1', text: 'hi' });
    expect(r.degraded).toBe(true);
    expect(r.text).toBe('FALLBACK');
    expect(r.reason).toBe('provider_error');
  });

  it('空回复视为降级，不把空串发给用户', async () => {
    const svc = makeService(fixedProvider('   '));
    const r = await svc.chat({ sessionKey: 's1', userId: 'u1', text: 'hi' });
    expect(r.degraded).toBe(true);
    expect(r.reason).toBe('empty');
    expect(r.text).toBe('FALLBACK');
  });

  it('预算耗尽时直接降级，且根本不打 Provider', async () => {
    let called = 0;
    const provider: ChatProvider = {
      complete: async () => { called += 1; return { text: 'x', promptTokens: 0, completionTokens: 0 }; }
    };
    const budget = new DailyBudget({ dailyLimitCny: 0, priceInputCnyPerM: 1, priceOutputCnyPerM: 1 });
    const svc = makeService(provider, budget);
    const r = await svc.chat({ sessionKey: 's1', userId: 'u1', text: 'hi' });
    expect(r.reason).toBe('budget_exhausted');
    expect(called).toBe(0);
  });

  it('多轮对话带上历史，且顺序正确', async () => {
    const { provider, seen } = recordingProvider('回复1');
    const svc = makeService(provider);
    await svc.chat({ sessionKey: 's1', userId: 'u1', text: '第一句' });
    await svc.chat({ sessionKey: 's1', userId: 'u1', text: '第二句' });
    expect(seen[0]?.length).toBe(2);
    expect(seen[0]?.[0]?.startsWith('system:SYS')).toBe(true);
    expect(seen[0]?.[1]).toBe('user:第一句');
    expect(seen[1]?.length).toBe(4);
    expect(seen[1]?.[1]).toBe('user:第一句');
    expect(seen[1]?.[2]).toBe('assistant:回复1');
    expect(seen[1]?.[3]).toBe('user:第二句');
    expect(svc.contextSize('s1')).toBe(4);
  });

  it('system prompt 始终附加说话人约定（即使运营方覆盖了自定义 prompt）', async () => {
    const { provider, seen } = recordingProvider();
    const svc = makeService(provider);
    await svc.chat({ sessionKey: 's1', userId: 'u1', text: 'x' });
    expect(seen[0]?.[0]).toContain('SYS');
    expect(seen[0]?.[0]).toContain('[昵称]');
    expect(seen[0]?.[0]).toContain('说话人');
  });

  // ---- 群共享上下文 + 说话人标注 ----

  it('群聊给用户消息加 [说话人] 前缀', async () => {
    const { provider, seen } = recordingProvider();
    const svc = makeService(provider);
    await svc.chat({ sessionKey: 'g1', userId: 'u1', speaker: '张三', text: '今天天气' });
    expect(seen[0]?.[1]).toBe('user:[张三] 今天天气');
  });

  it('群聊历史里保留前缀，第二个人能接上前文', async () => {
    const { provider, seen } = recordingProvider('好的');
    const svc = makeService(provider);
    await svc.chat({ sessionKey: 'g1', userId: 'u1', speaker: '张三', text: '今天天气' });
    await svc.chat({ sessionKey: 'g1', userId: 'u2', speaker: '李四', text: '那明天呢' });
    expect(seen[1]?.length).toBe(4);
    expect(seen[1]?.[1]).toBe('user:[张三] 今天天气');
    expect(seen[1]?.[2]).toBe('assistant:好的');
    expect(seen[1]?.[3]).toBe('user:[李四] 那明天呢');
  });

  it('单聊不加前缀', async () => {
    const { provider, seen } = recordingProvider();
    const svc = makeService(provider);
    await svc.chat({ sessionKey: 'c1', userId: 'u1', text: '你好' });
    expect(seen[0]?.[1]).toBe('user:你好');
  });

  it('会话之间上下文隔离，可单独清空', async () => {
    const svc = makeService(fixedProvider('ok'));
    await svc.chat({ sessionKey: 'a', userId: 'u', text: 'x' });
    expect(svc.contextSize('a')).toBe(2);
    expect(svc.contextSize('b')).toBe(0);
    svc.resetContext('a');
    expect(svc.contextSize('a')).toBe(0);
  });

  it('上下文来自存储：换成同一个 store 的新服务实例也能读到历史', async () => {
    const store = createMemoryMessageStore();
    const first = makeService(fixedProvider('记住了'), undefined, store);
    await first.chat({ sessionKey: 'g1', userId: 'u1', speaker: 'Kai', text: '我叫 Kai' });

    const second = makeService(fixedProvider('好'), undefined, store);
    expect(second.contextSize('g1')).toBe(2);
  });
});
