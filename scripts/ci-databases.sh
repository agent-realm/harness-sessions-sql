#!/usr/bin/env bash
# Starts a disposable ClickHouse and PostgreSQL pair for one CI job (.github/workflows/conformance.yml)
# and hands the job the conformance kit's variables (conformance/README.md) through $GITHUB_ENV.
#
# - The password is generated here, for this job only, and masked in the log before it is used.
# - Both ports are published on 127.0.0.1 only.
# - The images come from $CH_IMAGE and $PG_IMAGE, pinned by digest in the workflow.
# - The job removes both containers at its end, with `docker rm -f -v`.
set -euo pipefail

: "${CH_IMAGE:?}" "${PG_IMAGE:?}" "${GITHUB_ENV:?}" "${GITHUB_WORKSPACE:?}"

pw=$(openssl rand -hex 24)
echo "::add-mask::$pw"

docker run -d --name ssql-ch -p 127.0.0.1:8123:8123 \
  -e CLICKHOUSE_USER=kit -e CLICKHOUSE_PASSWORD="$pw" \
  --ulimit nofile=262144:262144 "$CH_IMAGE" >/dev/null
docker run -d --name ssql-pg -p 127.0.0.1:5432:5432 \
  -e POSTGRES_USER=kit -e POSTGRES_PASSWORD="$pw" -e POSTGRES_DB=kit "$PG_IMAGE" >/dev/null

# Both servers answer within a minute on a hosted runner; give them two.
for i in $(seq 1 60); do
  ch=no
  pg=no
  curl -fsS -u "kit:$pw" 'http://127.0.0.1:8123/?query=SELECT%201' >/dev/null 2>&1 && ch=yes
  docker exec ssql-pg pg_isready -U kit -d kit >/dev/null 2>&1 && pg=yes
  if [ "$ch" = yes ] && [ "$pg" = yes ]; then break; fi
  if [ "$i" = 60 ]; then
    echo "the databases did not start: clickhouse=$ch postgres=$pg" >&2
    docker logs --tail 50 ssql-ch >&2 || true
    docker logs --tail 50 ssql-pg >&2 || true
    exit 1
  fi
  sleep 2
done
echo "ClickHouse $(curl -fsS -u "kit:$pw" 'http://127.0.0.1:8123/?query=SELECT%20version()') and $(docker exec ssql-pg postgres --version) are up"

{
  echo "SSQL_CH_URL=http://127.0.0.1:8123"
  echo "SSQL_CH_USER=kit"
  echo "SSQL_CH_PASSWORD=$pw"
  # node-postgres takes the password from PGPASSWORD, so the URL carries none.
  echo "SSQL_PG_URL=postgres://kit@127.0.0.1:5432/kit"
  echo "PGPASSWORD=$pw"
  echo "SSQL_ADAPTERS=$GITHUB_WORKSPACE/adapters-checkout/packages/harness-session-adapters"
} >> "$GITHUB_ENV"
