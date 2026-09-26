# 存储层（src/services/storage）

## Purpose & Scope
三种原语：消息（MessageStore）、按天累计值（SpendStore）、插件私有 KV（KVStore）。
**不拥有 schema 语义**——KV 的键空间由各插件自己定义，加功能不需要改存储层。

## Entry Points & Contracts
- createStorage() 优先 SQLite，失败则降级内存并打 error 级日志；降级后 kind === memory 会出现在 /状态 与启动日志里。
- 三个 store **各自持有独立连接**，共用同一个 qqbot.db。

## Anti-patterns
- **KV 前缀查询必须用 substr(key, 1, ?) = ?，不要用 LIKE。** 键可能含用户可控内容，LIKE 会把 % 和 _ 当通配符，转义负担不该推给调用方。
- 不要给每个功能加专用 store：那会让 StorageService 随功能数线性膨胀，且每加一个功能都要改存储层。
- 不要用 cp 数据库文件做备份，见 [../../../deploy/AGENTS.md](../../../deploy/AGENTS.md)。

## Dependencies & Edges
- [../ai/AGENTS.md](../ai/AGENTS.md) — 唯一的重量级调用方（上下文 + 花费）
- deploy/qqbot-backup.sh — 对同一个库文件做备份

## Patterns & Pitfalls
- **memory.ts 与 sqlite.ts 必须行为一致**，两者共享 trimNewestFirst 以避免截断语义漂移；只改一边就是 bug。
- WAL + synchronous = NORMAL：断电最多丢最后几条。**这也意味着直接复制主库文件会漏掉 -wal 里未 checkpoint 的事务。**
- 迁移用 try { ALTER TABLE ... } catch {}：新库已含该列时 ALTER 必然失败，那正是「已是最新」的信号。
- 回填 sender_id 只做能精确还原的部分（c2c: 前缀的会话键）；群聊老数据只有昵称，宁可留空也不猜——猜错等于把别人的数据算到某个人头上。
