/**
 * 服务容器。
 *
 * 插件不 import 具体实现，而是从 PluginContext.services 取；
 * 这样新增服务（scheduler / search / media）时插件侧签名不变。
 */

import type {
  AiService, Logger, MetricsService, SafetyService, SchedulerService, Services
} from '../types.js';
import type { AgentGateway } from './agent/types.js';
import type { StorageService } from './storage/types.js';

export interface ServiceOptions {
  log: Logger;
  dataDir: string;
  timeZone: string;
  ai: AiService;
  agent: AgentGateway;
  safety: SafetyService;
  storage: StorageService;
  metrics: MetricsService;
  scheduler: SchedulerService;
}

export function createServices(opts: ServiceOptions): Services {
  return {
    log: opts.log,
    dataDir: opts.dataDir,
    timeZone: opts.timeZone,
    ai: opts.ai,
    agent: opts.agent,
    safety: opts.safety,
    storage: opts.storage,
    metrics: opts.metrics,
    scheduler: opts.scheduler
  };
}
