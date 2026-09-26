# AI 服务（src/services/ai）

## Purpose & Scope
把模型调用包装成一个**永不抛异常**的接口：插件拿到的永远是一句话。
负责预算闸门、上下文组装、说话人标注、降级、记账与落库。

## Entry Points & Contracts
- 插件面向的契约是 src/types.ts 的 AiService；provider 抽象在本目录 types.ts，只为换供应商和测试注入。
- available === false 时插件应当放弃处理，而不是降级刷屏。src/index.ts 在 apiKey 为空时返回 createUnavailableAi。
- 所有失败路径（超时 / HTTP 错 / 空回复 / 预算耗尽）都返回 degraded: true 的 AiReply，reason 各不相同；fallbackText（故障）与 budgetExhaustedText（预算）刻意分开。

## Anti-patterns
- 不要向插件抛异常。provider.complete() 才是允许抛错的那一层。
- **不要把 SPEAKER_CONVENTION 合并进用户可配置的 systemPrompt。** 运营方一旦覆盖 prompt 就会丢掉前缀说明，而前缀仍会被加上，模型看到的就是一堆没解释的 [昵称]。
- 不要用默认 thinking 配置：reasoning_effort 默认 high，会显著拉长延迟并与 60s 超时冲突。

## Dependencies & Edges
- deepseek.ts — OpenAI 兼容 /chat/completions
- budget.ts — 每日熔断
- [../storage/AGENTS.md](../storage/AGENTS.md) — 上下文与花费的持久化

## Patterns & Pitfalls
- **预算必须跨重启存续**（SpendStore 落库）。只存内存时反复重启就能无限绕过熔断，等于熔断器失效。
- 上下文存的是**原始文本 + speaker + senderId**，[昵称] 前缀在读取时渲染；改前缀格式不需要迁移数据。
- 上下文裁剪从最新往回累加、超上限即停，但**至少保留最新一条**（trimNewestFirst）。
- senderId 必须落库：昵称会变会重名，只有 openid 能可靠定位「某人的数据」，合规删除依赖它。
- 会话键：群用 group:<群 openid>，单聊用 c2c:<用户 openid>；群聊共享一份上下文，靠前缀区分说话人。
- user_id 是传给模型的内容安全 / KVCache 隔离字段，不是隐私数据。
