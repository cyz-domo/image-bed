#!/usr/bin/env bash

set -euo pipefail

if [[ $# -eq 0 ]]; then
  printf '用法: %s 图片路径 [图片路径 ...]\n' "$0" >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

remote_url="$(git remote get-url origin)"
if [[ "$remote_url" =~ github\.com[:/]([^/]+)/([^/.]+)(\.git)?$ ]]; then
  owner="${BASH_REMATCH[1]}"
  repo="${BASH_REMATCH[2]}"
else
  printf '无法从 origin 解析 GitHub 仓库地址。\n' >&2
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
  urls+=("https://cdn.jsdelivr.net/gh/$owner/$repo@main/$relative_path")
done

git add "$target_dir"
git commit -m "chore: add uploaded image(s)"
git push origin main

printf '\n上传完成:\n'
for url in "${urls[@]}"; do
  printf '%s\n' "$url"
  printf '![image](%s)\n' "$url"
done

