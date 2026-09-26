# 插件层（src/plugins）

## Purpose & Scope
插件契约、自动发现、注册与分发，以及具体功能插件（features/）。
不拥有存储与 AI 实现——插件只通过 PluginContext.services 使用它们。

## Entry Points & Contracts
- Plugin 契约在 [../types.ts](../types.ts)：name 必填，setup / stop / handle 可选，handle 返回 true 即终止整条链路。
- loadPlugins() 扫描**本文件同级**的 features/，只认 .js 文件与默认导出。
- **commands 字段只写进启动日志，不参与路由。** 分发完全靠各插件自己比较 event.content。
- 插件配置：未显式设置 QQBOT_PLUGIN_<NAME>_ENABLED=false 时**一律启用**；键名匹配**大小写不敏感**（env 侧的大写与插件声明的 camelCase 会归一到同一把键）。

## Usage Patterns
1. 加插件：在 src/plugins/features/ 新增一个默认导出 Plugin 的文件 → npm run build → 重启。核心零改动。

## Anti-patterns
- **插件名不要含下划线。** QQBOT_PLUGIN_<NAME>_<KEY> 在第一个下划线处切分，名为 group_admin 的插件会被解析成插件 group + 字段 admin_...。连字符或直接连写（group-admin / groupadmin）都可以。
- 不要让 handle() 抛错来表达「不处理」——返回 false。抛错会被记成 pluginFailures 并继续下一个插件，行为正确但污染指标。
- 不要在插件之间直接互相调用；要共享的放到 services。

## Dependencies & Edges
- [../transport/AGENTS.md](../transport/AGENTS.md)
- [../services/AGENTS.md](../services/AGENTS.md) — 服务容器
- [../util/day.ts](../util/day.ts) — 时区；[../util/speaker.ts](../util/speaker.ts) — 说话人标签

## Patterns & Pitfalls
- **加载顺序 = 文件名升序，且 load-bearing。** 当前是 chat, checkin, echo, ping, privacy, reminder, status——chat 必须排在 echo 之前。改名或新增文件时保持。
- **echo 是「没有 AI 时」的兜底**：chat 在 ai.available === false 时返回 false，echo 就会对**每一条**非命令消息回 Echo: ...。清空 QQBOT_AI_API_KEY 之前先设 QQBOT_PLUGIN_ECHO_ENABLED=false。
- setup() 抛错只记日志、不中断启动，插件仍留在 registry 里参与分发。
- dispatch() 的 15s 超时按插件失败处理并继续下一个插件，**不会取消已经在跑的那个 Promise**。
- /我的数据 与 /删除我的数据 的删除范围刻意不对等：单聊连机器人回复一起删，群聊只删自己发的（群里的回复是共享内容）。
