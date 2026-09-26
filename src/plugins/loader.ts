/**
 * 插件自动发现。
 *
 * 约定：features/ 下的每个 .js 文件默认导出一个 Plugin。
 * 加插件 = 加文件，核心零改动。
 *
 * 设计取舍：动态扫描换来「零改核心」，代价是加载错误只在运行时暴露。
 * 这里用三件事补偿：
 *  1. 逐文件校验形状
 *  2. 失败不静默——按 error 级记日志
 *  3. 启动结束时打印完整清单（谁加载了、谁失败了），journalctl 里一眼可见
 */

import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Logger, Plugin } from '../types.js';
import { serializeError } from '../util/errors.js';

export interface LoadFailure {
  file: string;
  reason: string;
}

export interface LoadResult {
  plugins: Plugin[];
  failed: LoadFailure[];
}

function isPlugin(value: unknown): value is Plugin {
  if (typeof value !== 'object' || value === null) return false;
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0;
}

/** 默认扫描目录：与本文件同级的 features/（编译后仍同级） */
export function defaultFeaturesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'features');
}

export async function loadPlugins(dir: string, log: Logger): Promise<LoadResult> {
  const plugins: Plugin[] = [];
  const failed: LoadFailure[] = [];

  let files: string[];
  try {
    const dirents = await readdir(dir, { withFileTypes: true });
    files = dirents
      .filter((d) => d.isFile() && d.name.endsWith('.js') && !d.name.endsWith('.d.js'))
      .map((d) => d.name)
      .sort();
  } catch (err) {
    log.error('plugin directory unreadable', { dir, error: serializeError(err) });
    return { plugins, failed };
  }

  for (const file of files) {
    const full = join(dir, file);
    try {
      const mod = (await import(pathToFileURL(full).href)) as { default?: unknown };
      const candidate = mod.default;
      if (!isPlugin(candidate)) {
        failed.push({ file, reason: '默认导出不是合法 Plugin（缺少 name）' });
        log.error('plugin invalid', { file });
        continue;
      }
      plugins.push(candidate);
    } catch (err) {
      failed.push({ file, reason: err instanceof Error ? err.message : String(err) });
      log.error('plugin load failed', { file, error: serializeError(err) });
    }
  }

  return { plugins, failed };
}
