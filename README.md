# qqbot-test

官方 QQ 机器人 Node SDK 的脚手架：分层 + 插件化，用于长期自托管。

## 目录结构

```text
src/
  index.ts              入口：装配 + 进程级错误边界 + 优雅退出
  config.ts             分层配置：默认值 → .env → 环境变量（含插件命名空间）
  logger.ts             JSON 日志 + AppSecret 脱敏（只写 stdout/stderr）
  types.ts              内部事件模型 + 插件契约（不引用 SDK 类型）
  services.ts           服务容器（ai / storage / scheduler 后续挂这里）
  util/dedupe.ts        幂等去重窗口（有 TTL 与条目上限）
  util/errors.ts        统一错误序列化（保留 stack 与 code）
  transport/bot.ts      接入层：全项目唯一 import SDK 的地方
  plugins/
    loader.ts           插件自动发现（扫描 features/）
    registry.ts         注册 / setup / 带超时的 dispatch / stop
    config.ts           插件配置访问器
    features/           加插件只需在这里新增一个文件
      echo.ts
      ping.ts
tests/                  vitest 测试
deploy/                 systemd 单元
```

依赖方向单向，不允许反向：

```text
index.ts -> transport/ -> SDK
index.ts -> plugins/   -> types.ts（只认识内部接口）
plugins/ -> services（经 PluginContext 注入，不直接 import 实现）
```

## 快速开始

```bash
npm install
cp .env.example .env && chmod 600 .env
$EDITOR .env            # 填入 QQBOT_APP_ID / QQBOT_APP_SECRET
npm run typecheck       # 含测试代码
npm test
npm run build
npm start
```

## 如何加一个插件

在 `src/plugins/features/` 下新建一个文件，默认导出一个 `Plugin`，**不需要改任何核心文件**：

```ts
import type { BotContext, Plugin, PluginContext } from '../../types.js';

export default {
  name: 'hello',
  commands: ['/hello'],
  defaults: { greeting: '你好' },
  setup(ctx: PluginContext): void {
    ctx.log.info('hello ready', { greeting: ctx.config.string('greeting', '你好') });
  },
  async handle(event: BotContext, ctx: PluginContext): Promise<boolean> {
    if (event.event.content.trim() !== '/hello') return false;
    await ctx.api.reply(event, ctx.config.string('greeting', '你好'));
    return true;
  }
} satisfies Plugin;
```

插件配置走独立命名空间，核心不认识任何插件字段：

```bash
QQBOT_PLUGIN_HELLO_GREETING=早上好
QQBOT_PLUGIN_HELLO_ENABLED=false
```

构建后启动即可。

## 已落地的约束

| 需求 | 落点 |
|---|---|
| 配置外置 | `config.ts` 三层优先级；密钥只走 `.env`（600）或环境变量 |
| 异步安全 | 事件处理全程 `async`；单事件与单插件异常都被隔离；`dispatch` 带 15s 超时 |
| 日志与错误边界 | `logger.ts` 统一 JSON 出口 + 脱敏；`unhandledRejection` / `uncaughtException` **记录后退出**，交给 systemd 拉起干净进程 |
| 分层 + 插件化 | `transport/` 隔离 SDK；`plugins/` 只依赖 `types.ts` 契约；插件自动发现 |
| 幂等 | `util/dedupe.ts`：5 分钟 TTL + 10000 条上限 |
| 日志不落正文 | 只记 `chars` 长度与元数据 |

## 状态与观测

在 QQ 里直接发 `/状态`：

```text
运行 3 小时 12 分
事件 42 条（群聊 30 / 单聊 12）
回复 42 条｜失败 0
AI 38 次｜失败 0｜降级 4
今日花费 ¥0.1234 / ¥20
网关 READY 4｜RESUMED 0｜错误 0
存储 sqlite｜去重丢弃 2｜插件错误 0
```

journald 里每 5 分钟会有一条 `health` 日志，可直接看趋势：

```bash
journalctl -u qqbot | grep '"msg":"health"' | tail -20
journalctl -u qqbot | grep 'alert:'          # 告警
```

**为什么不做 Web 面板**：单机自托管、只有一个使用者，加一个 HTTP 端口意味着多一个暴露面和一套鉴权，收益不成正比。

### 告警出口

告警经 `AlertSink` 抽象，**当前只有日志实现**（`createLogAlertSink`）。
接入事务邮件时只需新增一个实现并在 `src/index.ts` 换一行，采集侧代码不需要改动。
已实现的阈值：DeepSeek 预算用到 80%、AI 连续失败 5 次。

## 备份


```bash
sudo systemctl start qqbot-backup.service   # 立即备份一次
sudo systemctl list-timers qqbot-backup.timer
ls -lh ~/qqbot/backups/
```

每天 04:00 自动执行，保留最新 14 份。用 `VACUUM INTO` 做事务一致快照——
**不要用 `cp`**：WAL 模式下复制主库文件会漏掉未 checkpoint 的事务。
备份后立即 `integrity_check`，不通过就删除产物并报错。

恢复方式：`systemctl stop qqbot` → 把备份文件拷成 `data/qqbot.db`（并删掉 `-wal`/`-shm`）→ `systemctl start qqbot`。
演练记录见 [docs/backup-drill.md](./docs/backup-drill.md)。

## 测试


```bash
npm test
```

覆盖：密钥脱敏（msg 与嵌套 meta）、日志等级与流分离、去重窗口（TTL 与上限）、
插件错误隔离与超时、配置插件命名空间。
