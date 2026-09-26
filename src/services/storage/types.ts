/**
 * 存储契约。
 *
 * 两种实现：SQLite（生产）与内存（测试 / 降级）。
 * 存的是**原始文本 + 说话人 + 发送者 openid**，不是渲染后的文本——
 * 渲染（[昵称] 前缀）在读取时做，这样数据库里留下的是干净的聊天记录。
 *
 * 为什么要单独存 sender_id：speaker 只是昵称，会变、会重名，
 * 无法据此可靠地定位「某个用户的数据」。运营规范 5.10 要求用户提出时能删，
 * 所以必须落一个稳定的身份标识。
 */

export type MessageRole = 'user' | 'assistant';

export interface StoredMessage {
  readonly role: MessageRole;
  /** 原始文本，不含 [昵称] 前缀 */
  readonly content: string;
  /** 群聊说话人昵称；仅用于展示 */
  readonly speaker?: string;
  /** 发送者 openid（仅用户消息有）；用于数据删除的精确定位 */
  readonly senderId?: string;
}

export interface MessageStore {
  /** 追加一条消息，返回自增 id */
  append(sessionKey: string, message: StoredMessage): number;
  /** 取最近若干条，按时间**正序**返回；maxChars 是字符上限（从最旧开始丢） */
  recent(sessionKey: string, limit: number, maxChars: number): StoredMessage[];
  count(sessionKey: string): number;
  /** 清空整个会话，返回删除条数 */
  clear(sessionKey: string): number;
  /** 删除某个发送者的全部消息（跨会话），返回删除条数 */
  deleteBySender(senderId: string): number;
  /** 某个发送者在各会话里的消息条数（用于「我的数据」查询） */
  countBySender(senderId: string): number;
  /** 删除早于 cutoffMs 的消息（保留期），返回删除条数 */
  pruneBefore(cutoffMs: number): number;
  close(): void;
}

/**
 * 按天累计的数值存储（当前用于 AI 预算）。
 *
 * 存在的理由：预算原本只存在内存里，**进程一重启就归零**，
 * 而「每日熔断」的全部意义就是跑飞时兜底——每次重启都清零等于没有熔断。
 */
export interface SpendStore {
  /** 读取某天的累计值（元）；无记录返回 undefined */
  load(day: string): number | undefined;
  /** 覆盖写入某天的累计值（元） */
  save(day: string, spentCny: number): void;
  close(): void;
}

/**
 * 插件私有键值存储。
 *
 * 为什么不给每个功能加一个专用 store：那会让 StorageService 随功能数线性膨胀，
 * 而且每加一个功能都要改存储层（正是我们要避免的「改核心」）。
 * KV + 命名空间把 schema 的决定权交回插件，存储层只提供原语。
 */
export interface KVEntry {
  readonly key: string;
  readonly value: string;
}

export interface KVStore {
  get(namespace: string, key: string): string | undefined;
  set(namespace: string, key: string, value: string): void;
  remove(namespace: string, key: string): void;
  /** 按键升序返回前缀匹配的条目（前缀为空即整个命名空间） */
  list(namespace: string, prefix: string, limit?: number): KVEntry[];
  /** 删除整个命名空间，返回删除条数 */
  clearNamespace(namespace: string): number;
  close(): void;
}

export type StorageKind = 'sqlite' | 'memory';

export interface StorageService {
  readonly kind: StorageKind;
  readonly messages: MessageStore;
  /** 按天累计值（AI 预算）；跨重启存续 */
  readonly spend: SpendStore;
  /** 插件私有 KV；插件按命名空间自管 schema */
  readonly kv: KVStore;
  /** 数据库文件路径；内存实现为 null */
  readonly location: string | null;
  close(): void;
}
