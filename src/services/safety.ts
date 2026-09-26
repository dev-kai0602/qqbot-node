/**
 * 内容安全过滤（C3 的确定性地板）。
 *
 * 定位必须说清楚：**这不是一套完整的内容安全系统**。
 * 真正的第一道防线是 system prompt 里让模型自审；
 * 这里是模型被绕过之后仍然拦得住的确定性兜底。
 *
 * 两点诚实说明：
 *  - 内置词表刻意保持小而通用（违法交易、隐私信息），不堆砌词库；
 *    运营规范要求的效果需要标注测试集才能量化，**「检出率 ≥ 90%」目前未验证**。
 *  - 关键词过滤会误伤：机器人自己的回答里出现这些字也会被拦。
 *    对输出侧这是可接受的保守选择；对输入侧按 R18 的默认策略只记录、不拒答。
 */

import type { SafetyService, SafetyVerdict } from '../types.js';

export interface SafetyOptions {
  /** 追加的敏感词（运营方自行维护） */
  extraTerms?: readonly string[];
  /** 输出命中时的替换话术 */
  refusalText?: string;
}

/** 内置兜底词：通用、可解释、不涉及具体政治表述 */
const BUILTIN_TERMS: readonly string[] = [
  '代开发票',
  '办假证',
  '出售银行卡',
  '刷单返利',
  '洗钱',
  '枪支买卖',
  '毒品交易',
  '博彩投注'
];

/** 隐私类：命中即拒，避免把他人隐私转发出去 */
const PRIVACY_PATTERNS: readonly RegExp[] = [
  /\d{17}[\dXx]/,      // 身份证号
  /\d{16,19}/          // 银行卡号
];

function scan(text: string, terms: readonly string[]): string[] {
  const hits: string[] = [];
  for (const term of terms) {
    if (term !== '' && text.includes(term)) hits.push(term);
  }
  for (const pattern of PRIVACY_PATTERNS) {
    if (pattern.test(text)) hits.push('PRIVACY');
  }
  return hits;
}

export function createSafetyService(opts: SafetyOptions = {}): SafetyService {
  const terms = [...BUILTIN_TERMS, ...(opts.extraTerms ?? [])];
  return {
    checkInput(text: string): SafetyVerdict {
      const matched = scan(text, terms);
      return { hit: matched.length > 0, matched };
    },
    checkOutput(text: string): SafetyVerdict {
      const matched = scan(text, terms);
      return { hit: matched.length > 0, matched };
    },
    refusalText: opts.refusalText ?? '这个问题我没法回答，换个话题吧。'
  };
}
