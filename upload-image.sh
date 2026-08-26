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

  filename="$(basename "$source")"
  target="$target_dir/$filename"
  if [[ -e "$target" ]]; then
    stem="${filename%.*}"
    extension=""
    [[ "$filename" == *.* ]] && extension=".${filename##*.}"
    target="$target_dir/${stem}-$(date +%H%M%S)-$$$extension"
  fi

  cp "$source" "$target"
  relative_path="${target#./}"
  encoded="$(base64 < "$target" | tr -d '\n')"
  gh api "repos/$owner/$repo/contents/$relative_path" --method PUT \
    -f message="chore: upload $filename" \
    -f content="$encoded" \
    -f branch=main >/dev/null
  urls+=("https://cdn.jsdelivr.net/gh/$owner/$repo@main/$relative_path")
done

printf '\n上传完成:\n'
for url in "${urls[@]}"; do
  printf '%s\n' "$url"
  printf '![image](%s)\n' "$url"
done
