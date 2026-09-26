# qqbot-test

## Purpose & Scope
自托管的官方 QQ 开放平台机器人：分层 + 插件化，面向单机、少量群。
唯一观测入口是 QQ 里的命令与 journald。操作面步骤见 README.md，本文件只写代码里看不见的约束。

## Entry Points & Contracts
- 装配全在 src/index.ts，依赖方向**单向且不许反向**：index → transport → SDK；index → services → 实现；plugins → types.ts（插件经 PluginContext 拿能力，不 import 具体实现）。
- **只有 src/transport/bot.ts 可以 import @tencent-connect/**。换 SDK 只改这一个文件。
- 配置三层覆盖：内置默认值 → .env → 进程环境变量；插件字段走 QQBOT_PLUGIN_<NAME>_<KEY>。

## Usage Patterns
1. 改代码：`npm run typecheck && npm test` → `npm run build` → `sudo systemctl restart qqbot`。**dist 不会自动重建，systemd 跑的是 dist/index.js。**
2. 加功能：在 src/plugins/features/ 新增一个默认导出 Plugin 的文件，核心零改动。

## Anti-patterns
- **任何群管理类命令（公告、禁言、踢人、清人等）必须先有 owner 白名单守卫，才能落地。** 当前全项目零权限概念，群里任何人都能触发任何命令；先加命令后补权限是最容易引入的严重问题。
- 不要给 BotApi（src/types.ts）加能力。它刻意只放「发消息」一件事；群管理与富媒体走 services 注入。
- 插件不要 import services/* 的具体实现，只从 ctx.services 取。
- 不要把消息正文写进日志，只写长度与元数据。
- 不要用本地日期或 toISOString 算「今天」，服务器是 UTC。

## Dependencies & Edges
- [src/transport/AGENTS.md](src/transport/AGENTS.md) — SDK 接入层
- [src/plugins/AGENTS.md](src/plugins/AGENTS.md) — 插件契约与功能插件
- [src/services/AGENTS.md](src/services/AGENTS.md) — 服务容器、调度、指标、安全
- [deploy/AGENTS.md](deploy/AGENTS.md) — systemd 与备份

## Patterns & Pitfalls
- 「今天」只由 src/util/day.ts 的 dayKey() 定义，签到与 AI 预算共用。
- 「[昵称] 」前缀只在 src/util/speaker.ts 的 renderUserMessage() 一处实现，实时与历史回放都走它。
- 单事件有四层错误边界（进程 / 事件 / 插件 / 定时任务）。除最外层刻意为之的 process.exit(1)，任何一层都不许把异常升级成进程退出。
- 插件的 commands 字段只进启动日志，**不参与路由**；分发靠各插件自己比较 content。
- 插件按**文件名升序**加载，顺序 load-bearing——见 src/plugins/AGENTS.md。
- **build 会先清空 dist 再编译。不要去掉这一步**：tsc 不清理陈旧产物，删掉的源文件对应的 .js 会留在 dist 里，而 loader 扫描的正是 dist/，插件会「复活」。
