#!/usr/bin/env bash
# Does `schema.prisma` describe the database the migrations build?
#
# ═══ WHY THIS EXISTS ═══
#
# The two are written separately. A migration can be hand-authored SQL — the
# runner tables were — and `schema.prisma` is edited by hand beside it, so
# nothing forces them to agree. On 2026-09-27 they did not: a database
# migrated from scratch differed from the schema in four foreign keys, three
# index names, two id defaults, one timestamp default, and a partial index
# the schema declared as a plain one. Every gate was green throughout,
# because the application reads through the generated client and the
# migrations build the tables, and neither ever compares itself with the
# other.
#
# What it costs is the next `prisma migrate dev`: it diffs the schema against
# the database and writes a migration renaming live constraints, dropping
# three column defaults, and creating an index whose name already exists —
# which fails on every database it meets, or is hand-edited until it applies.
#
# ═══ EXIT CODES ARE THE CONTRACT, AND pnpm CAN ERASE THEM ═══
#
#   0   they agree
#   2   they differ — the SQL `migrate dev` would write is printed
#   1   the check itself could not run (no database, a schema that does not
#       parse): it compared nothing, and must never read as agreement
#
# `prisma migrate diff --exit-code` draws that 1/2 line, and
# `pnpm --filter <pkg> exec` ERASES it — measured, it reports 1 for a real
# difference, the same code as a failure to connect. So this runs a plain
# `pnpm exec` from inside the package, which passes the child's code through.
#
# Needs DATABASE_URL pointing at a database the migrations have been applied
# to, and nothing else — `--from-url` reads that database's actual state.
#
# Usage:  infra/test/schema-matches-migrations.sh [schemaFile]
#         (defaults to packages/persistence/prisma/schema.prisma)
set -u

repo=$(cd "$(dirname "$0")/../.." && pwd)

if [ $# -ge 1 ]; then
  schema="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
else
  schema="$repo/packages/persistence/prisma/schema.prisma"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set: point it at a database the migrations have been applied to." >&2
  exit 1
fi

out=$(mktemp)
cd "$repo/packages/persistence" || exit 1
PRISMA_HIDE_UPDATE_MESSAGE=1 pnpm exec prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel "$schema" \
  --script --exit-code > "$out" 2>&1
status=$?

case $status in
  0)
    echo "schema.prisma and the migrated database agree."
    ;;
  2)
    echo "schema.prisma and the migrations DISAGREE. This is the SQL 'prisma migrate dev' would write:"
    cat "$out"
    echo "Make schema.prisma describe what the migrations build (map:, onUpdate:, dbgenerated),"
    echo "or add the migration the schema implies. Never edit a migration that has shipped."
    ;;
  *)
    echo "prisma migrate diff could not run (exit $status), so nothing was compared:"
    cat "$out"
    status=1
    ;;
esac

rm -f "$out"
exit $status
