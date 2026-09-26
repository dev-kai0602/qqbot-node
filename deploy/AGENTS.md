# 部署（deploy）

## Purpose & Scope
systemd 常驻单元与 SQLite 备份。面向单机、单用户、少于 50 人的自托管。
不含 CI——构建在服务器上手动 npm run build。

## Entry Points & Contracts
- qqbot.service 跑 dist/index.js，Restart=always，任何退出都会被拉起。
- ProtectSystem=strict + ReadWritePaths=/home/kai/qqbot：**项目目录之外全为只读**。数据目录若移出这个路径，SQLite 会直接写不进去。
- /etc/systemd/system/ 里的单元是 deploy/ 的副本，改完必须 cp 过去并 daemon-reload，否则改了不生效。
- qqbot-backup.timer 每天 04:00（Persistent=true 补跑停机期间的遗漏），保留最新 14 份。

## Usage Patterns
1. 改代码：npm run build → sudo systemctl restart qqbot。Restart=always 不会替你重新构建。
2. 改单元：sudo cp deploy/qqbot.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart qqbot。

## Anti-patterns
- **不要用 cp 备份 SQLite。** WAL 下主库文件不含未 checkpoint 的事务，会得到「能打开但缺数据」的假备份。用 VACUUM INTO。
- 不要在单元里加 ExecStartPre=npm run build：构建失败会让服务进 failed 循环，而旧的 dist 本来还能跑。

## Dependencies & Edges
- [../AGENTS.md](../AGENTS.md) — 项目总体约束
- [../src/services/storage/AGENTS.md](../src/services/storage/AGENTS.md) — 被备份的库
- 恢复步骤与演练记录：[../docs/backup-drill.md](../docs/backup-drill.md)

## Patterns & Pitfalls
- systemd 报 unit file changed on disk 时只需 daemon-reload，不代表配置有错。
- 日志全部进 journald（StandardOutput=journal）。
- NODE_OPTIONS 里的 --max-old-space-size=768 是 Node 堆上限，与单元的 MemoryMax=2G 是两回事，两个都要保留。
