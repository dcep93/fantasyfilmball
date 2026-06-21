#!/bin/bash

set -euo pipefail

assets_dir="app/public/assets"
target_path="app/src/app_x/config/local_asset_names.ts"

if [[ ! -d "$assets_dir" ]]; then
  echo "Expected assets directory at $assets_dir before writing." >&2
  exit 1
fi

asset_names=()
while IFS= read -r asset_name; do
  asset_names+=("$asset_name")
done < <(find "$assets_dir" -maxdepth 1 -type f -exec basename {} \; | LC_ALL=C sort)

{
  echo "const localAssetNames = ["
  if ((${#asset_names[@]} > 0)); then
    for asset_name in "${asset_names[@]}"; do
      printf '  %s,\n' "$(printf '%s' "$asset_name" | jq -Rr @json)"
    done
  fi
  echo "] as const;"
  echo
  echo "export default localAssetNames;"
} >"$target_path"
