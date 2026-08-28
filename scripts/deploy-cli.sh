#!/usr/bin/env bash
# CLI 直传部署脚本：打包干净 staging 目录 → edgeone makers deploy → 自检
# 用法:
#   scripts/deploy-cli.sh                    # 部署到已 link 的项目（.edgeone/project.json）
#   scripts/deploy-cli.sh --name <项目名>    # 部署/创建直传型项目（如测试项目）
# 网络不稳可先: export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
NAME_ARG=""
if [ "${1:-}" = "--name" ] && [ -n "${2:-}" ]; then
  NAME_ARG="--name $2"
fi

echo "==> 构建干净 staging 目录"
STAGING="$(mktemp -d /tmp/image-bed-deploy.XXXXXX)"
# 静态前端 + 云函数 + 依赖清单；绝不打包 .env（密钥）、node_modules、本地图片、.git
cp index.html app.js styles.css package.json package-lock.json edgeone.json "$STAGING/"
cp -r cloud-functions "$STAGING/"

echo "==> 部署 (edgeone makers deploy)"
cd "$STAGING"
# shellcheck disable=SC2086
RESULT=$(edgeone makers deploy $NAME_ARG --env production --json)
echo "$RESULT" | tail -n 1
URL=$(echo "$RESULT" | tail -n 1 | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')

echo "==> 清理 staging"
cd /
rm -rf "$STAGING"

echo "==> 部署完成"
echo "预览 URL: $URL"
echo "提示: 预览 URL 首次访问需浏览器打开（种 cookie），正式域名不受影响。"
echo "提示: 直传项目不继承环境变量，需 edgeone makers env set 逐项配置。"
