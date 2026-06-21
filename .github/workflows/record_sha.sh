#!/bin/bash

set -euo pipefail

target_sha_path="app/src/app_x/config/sha_x.json"

if [[ ! -f "$target_sha_path" ]]; then
  echo "Expected sha.json at $target_sha_path before writing." >&2
  exit 1
fi

cat > "$target_sha_path" <<EOF2
{
  "time": $(TZ='America/New_York' date | jq -Rs .),
  "git_log": $(git log -1 | jq -Rs .)
}
EOF2
