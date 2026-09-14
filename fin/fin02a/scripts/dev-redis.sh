#!/usr/bin/env bash
# FIN-02C 전용 개발/시험 Redis (BullMQ). 포트 6380, 영속화 없음. 데이터 디렉터리 fin/fin02a/.redis (gitignore).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${FIN02A_REDIS_PORT:-6380}"
case "${1:-}" in
  start)
    mkdir -p "$HERE/.redis"
    redis-server --port "$PORT" --bind 127.0.0.1 --save "" --appendonly no --daemonize yes --dir "$HERE/.redis" --logfile "$HERE/.redis/redis.log" >/dev/null
    echo "redis started on 127.0.0.1:$PORT"; echo "export FIN02A_REDIS_URL=redis://127.0.0.1:$PORT" ;;
  stop) redis-cli -p "$PORT" shutdown nosave >/dev/null 2>&1 && echo stopped ;;
  status) redis-cli -p "$PORT" ping ;;
  *) echo "usage: $0 start|stop|status"; exit 1 ;;
esac
