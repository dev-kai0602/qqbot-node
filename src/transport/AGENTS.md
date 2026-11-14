# 接入层（src/transport）

## Purpose & Scope
全项目唯一接触 QQ SDK 的地方：把 SDK 事件归一化成内部模型，把内部动作翻译回 SDK 调用。
**不放任何业务逻辑**——消息内容怎么理解属于 plugins/。

## Entry Points & Contracts
- BotTransport 同时实现 BotApi，是插件唯一的消息出口。
- reply() 走被动消息（带 msgId，受平台 5 分钟窗口约束）；send() 主动消息**刻意不携带 msgId**，否则会被平台当成被动回复。
- onMessage() 的固定顺序：去重 → scope 校验 → 归一化 → 计数与日志 → 交给 handler，不可调换。
- **SDK middleware 链跑在 onMessage 之前**：当前只挂了 `rateLimiter`（单用户限流，默认 2s 一条，`QQBOT_RATE_LIMIT_PER_USER_MS=0` 关闭）。被限流的消息不会进入去重窗口，所以「同一条消息被重复推送且落在限流窗口内」只会记 `rateLimited`，不会记 `duplicatesDropped`。
- SDK 的 message 回调**刻意不 await** handler，以尽快把控制权交回事件循环；因此必须 .catch() 兜住 Promise。

## Anti-patterns
- 不要在 scope 未知时静默兜底成默认值。当前策略是丢弃 + 计数 unsupportedScope + warn——用错 scope 发出去比不发更糟。
- 不要改成 await 完 handler 再返回。
- 不要把 serializeError 简化成只取 message：stack 与 code 是排障时唯一有用的东西。

## Dependencies & Edges
- 上游：src/index.ts 构造并持有它。
- 契约：src/types.ts 的 BotApi / InboundEvent。
- 去重实现：[../util/dedupe.ts](../util/dedupe.ts)

## Patterns & Pitfalls
- 去重必须在最前面：平台明确会重复推送同一条消息，晚于去重的副作用都会翻倍。
- DedupeWindow 是**纯内存**的，进程重启即清空。重复推送窗口远短于重启耗时，故可接受——但不要当持久幂等层用。
