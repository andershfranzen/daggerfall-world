#!/bin/sh
# Consistent online backup of both SQLite databases from the running container.
# Usage: deploy/backup.sh [backup-dir]   (default ./backups). Keeps the newest 14 sets.
set -eu
dir=${1:-./backups}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
compose="docker compose -f $(dirname "$0")/compose.yaml"
mkdir -p "$dir"
for db in daggerfallworld accounts; do
  # VACUUM INTO writes a transactionally consistent copy while the server keeps running.
  $compose exec -T game node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('/data/$db.db');
    db.exec(\"PRAGMA busy_timeout = 5000; VACUUM INTO '/tmp/$db.db'\");
    db.close();"
  $compose cp "game:/tmp/$db.db" "$dir/$db-$stamp.db"
  $compose exec -T game rm -f "/tmp/$db.db"
done
chmod 600 "$dir"/*-"$stamp".db
ls -1t "$dir"/accounts-*.db 2>/dev/null | tail -n +15 | while read -r f; do
  rm -f "$f" "$dir/daggerfallworld-${f##*/accounts-}"
done
echo "backup written to $dir (*-$stamp.db)"
