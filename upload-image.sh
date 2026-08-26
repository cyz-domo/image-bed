#!/usr/bin/env bash

set -euo pipefail

if [[ $# -eq 0 ]]; then
  printf '用法: %s 图片路径 [图片路径 ...]\n' "$0" >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

owner="cyz-domo"
repo="image-bed"

if ! gh auth status >/dev/null 2>&1; then
  printf 'gh 未登录，请先执行: gh auth login\n' >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  printf '缺少 jq，请先安装 jq。\n' >&2
  exit 1
fi

year="$(date +%Y)"
month="$(date +%m)"
target_dir="images/$year/$month"
mkdir -p "$target_dir"

declare -a urls=()
for source in "$@"; do
  if [[ ! -f "$source" ]]; then
    printf '文件不存在: %s\n' "$source" >&2
    exit 1
  fi

  original_filename="$(basename "$source")"
  extension=""
  [[ "$original_filename" == *.* ]] && extension=".${original_filename##*.}"
  filename="$(date +%Y%m%d%H%M%S)-$(openssl rand -hex 4)$extension"
  target="$target_dir/$filename"
  if [[ -e "$target" ]]; then
    filename="$(date +%Y%m%d%H%M%S)-$(openssl rand -hex 8)$extension"
    target="$target_dir/$filename"
  fi

  cp "$source" "$target"
  relative_path="${target#./}"
  encoded_file="$(mktemp)"
  payload_file="$(mktemp)"
  trap 'rm -f "$encoded_file" "$payload_file"' EXIT
  base64 < "$target" | tr -d '\n' > "$encoded_file"
  jq -n \
    --arg message "chore: upload $filename" \
    --rawfile content "$encoded_file" \
    --arg branch main \
    '{message: $message, content: ($content | rtrimstr("\n")), branch: $branch}' > "$payload_file"
  gh api "repos/$owner/$repo/contents/$relative_path" --method PUT \
    --input "$payload_file" >/dev/null
  rm -f "$encoded_file" "$payload_file"
  trap - EXIT
  urls+=("https://cdn.jsdelivr.net/gh/$owner/$repo@main/$relative_path")
done

printf '\n上传完成:\n'
for url in "${urls[@]}"; do
  printf '%s\n' "$url"
  printf '![image](%s)\n' "$url"
done
