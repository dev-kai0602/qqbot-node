#!/usr/bin/env bash
#
# QQ Bot SQLite 备份。
#
# 为什么不用 cp：数据库跑在 WAL 模式下，直接复制主库文件会漏掉 -wal 里
# 尚未 checkpoint 的事务，得到一个「能打开但缺数据」的假备份。
# VACUUM INTO 由 SQLite 保证事务一致，且不需要停服。
#
# 备份后立即做 integrity_check 与行数统计——备份不可用等于没备份，
# 宁可现在失败，也不要等到要恢复时才发现。
set -euo pipefail

APP_DIR="/home/kai/qqbot"
DB="${APP_DIR}/data/qqbot.db"
BACKUP_DIR="${APP_DIR}/backups"
# 保留的备份份数（timer 每天一次，即约两周）
KEEP=14

mkdir -p "${BACKUP_DIR}"

if [ ! -f "${DB}" ]; then
  echo "database not found: ${DB}" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${BACKUP_DIR}/qqbot-${STAMP}.db"

# VACUUM INTO 要求目标文件不存在
rm -f "${OUT}"
sqlite3 "${DB}" "VACUUM INTO '${OUT}'"

CHECK="$(sqlite3 "${OUT}" "PRAGMA integrity_check;")"
if [ "${CHECK}" != "ok" ]; then
  echo "integrity_check FAILED on ${OUT}: ${CHECK}" >&2
  rm -f "${OUT}"
  exit 1
fi

ROWS="$(sqlite3 "${OUT}" "SELECT COUNT(*) FROM messages;")"
SIZE="$(du -h "${OUT}" | cut -f1)"
echo "backup ok: ${OUT} (${SIZE}, ${ROWS} messages)"

# 只保留最新的 KEEP 份
ls -1t "${BACKUP_DIR}"/qqbot-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "retained: $(find "${BACKUP_DIR}" -name "qqbot-*.db" -type f | wc -l) file(s)"
