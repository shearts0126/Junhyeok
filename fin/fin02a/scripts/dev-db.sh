#!/usr/bin/env bash
# FIN-02A 전용 개발/시험 PostgreSQL (SCM/WMS 의 docker-compose DB 와 별개).
# 우선순위: docker compose(docker-compose.fin.yml) → 로컬 PostgreSQL 바이너리(initdb/pg_ctl, 비루트 사용자).
# 데이터 디렉터리: fin/fin02a/.pgdata (gitignore). 포트: 5433. 인증: 로컬 trust (개발 전용).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${FIN02A_PG_PORT:-5433}"
DATA="$HERE/.pgdata"
PGBIN="${FIN02A_PG_BIN:-/usr/lib/postgresql/16/bin}"
RUNAS="${FIN02A_PG_USER:-pgtest}"
LOG="$DATA/server.log"

as_pg() { if [ "$(id -u)" = "0" ]; then runuser -u "$RUNAS" -- "$@"; else "$@"; fi; }

case "${1:-}" in
  start)
    if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
      docker compose -f "$HERE/docker-compose.fin.yml" up -d; exit 0
    fi
    if [ ! -f "$DATA/PG_VERSION" ]; then
      mkdir -p "$DATA"; chown "$RUNAS" "$DATA" 2>/dev/null || true
      as_pg "$PGBIN/initdb" -D "$DATA" -U fin02a --auth-local=trust --auth-host=trust -E UTF8 --locale=C.UTF-8 >/dev/null
    fi
    as_pg "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c listen_addresses=127.0.0.1" -l "$LOG" start >/dev/null
    echo "postgres started on 127.0.0.1:$PORT (data: $DATA)"
    echo "export FIN02A_DATABASE_URL=postgresql://fin02a@127.0.0.1:$PORT/postgres"
    ;;
  stop)
    as_pg "$PGBIN/pg_ctl" -D "$DATA" stop -m fast >/dev/null && echo "stopped" ;;
  status)
    as_pg "$PGBIN/pg_ctl" -D "$DATA" status ;;
  *) echo "usage: $0 start|stop|status"; exit 1 ;;
esac
