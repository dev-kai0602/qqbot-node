# 服务层（src/services）

## Purpose & Scope
跨插件共享的能力容器。插件只从 PluginContext.services 取，不 import 这里的任何实现文件。
不拥有业务语义——什么消息该回什么是插件的事。

## Entry Points & Contracts
- createServices() 返回的 Services 是插件的唯一入口；加服务要同步改 tests/helpers.ts 的桩。
- MetricsService 只做进程内计数，**没有导出端点**；观测出口是 status 插件与周期性 health 日志。
- AlertSink 是告警唯一出口，当前只有 createLogAlertSink。接邮件 = 新增实现 + 改 src/index.ts 一行，采集侧不动。
- scheduler.close() 统一清理，插件不需要自己 clearInterval。

## Anti-patterns
- **不要在插件里直接 setInterval。** 定时回调抛出的异常会成为 uncaughtException，而进程级策略是「记录后退出」，于是一个插件的小错会重启整个机器人。scheduler 存在的首要理由就是这层 catch。
- 不要引 Prometheus 客户端或 HTTP 面板：单机单用户，多一个端口就多一个暴露面和一套鉴权。
- 不要把 safety 当内容安全系统。它只是模型被绕过后的确定性地板，检出率未经验证。

## Dependencies & Edges
- [ai/AGENTS.md](ai/AGENTS.md) — AI 服务：预算、上下文、降级
- [storage/AGENTS.md](storage/AGENTS.md) — SQLite / 内存存储
- scheduler.ts / metrics.ts / safety.ts / index.ts 各自独立，无下游节点

## Patterns & Pitfalls
- metrics.inc(aiCalls) **不会**重置连续失败计数——重置只发生在 noteAiResult(true)。若在 inc 里重置，连续失败永远到不了告警阈值。
- snapshot() 的花费优先取 budget 闭包（按 token 实算）；addSpend 的内存累加只在没有 budget 时生效。
- AiService 与 MetricsService 互相引用，src/index.ts 用延迟赋值的 aiRef 闭包打破这个环。
- safety.checkInput 命中只记录不拒答（输入侧拒答会误伤正常提问），checkOutput 命中则替换成拒答话术。
- safety 的关键词过滤会误伤机器人自己的回答（答句里出现「洗钱」等字也会被拦），这是刻意的保守取舍。
