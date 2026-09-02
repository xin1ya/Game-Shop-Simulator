#!/usr/bin/env bash
# 阿里云一键部署：本地执行，把静态站点发布到服务器 nginx 目录。
# 用法：
#   1) 首次：服务器上跑 tools/deploy/server-setup.sh（装 nginx + 站点配置）
#   2) 配置下面 4 个变量（或用环境变量传入）
#   3) 以后每次发布：bash tools/deploy/deploy.sh
#
# 防源码泄露（demo 公网测试）：
#   - 白名单打包：只发 index.html / styles / src / assets / robots.txt，
#     tests/tools/docs/开发脚本/Blender 管线一律不上公网；
#   - robots.txt 全站拒爬（防搜索引擎收录测试地址）；
#   - 可选混淆：OBFUSCATE=1 bash tools/deploy/deploy.sh（npx terser 压缩全部 JS，
#     提高阅读门槛——注意：纯前端 JS 无法真正加密，只是门槛）。
#   Web 游戏的源码本质上必须下发浏览器，上述是合理上限，勿信"绝对防泄露"。
set -euo pipefail

# ---- 配置区（改成你的，或用环境变量覆盖）----
ALI_HOST="${ALI_HOST:-47.243.159.231}"        # 服务器公网 IP 或域名
ALI_USER="${ALI_USER:-root}"                  # SSH 用户
ALI_PORT="${ALI_PORT:-22}"                    # SSH 端口
ALI_DIR="${ALI_DIR:-/var/www/game-shop}"      # 服务器站点目录
SSH_KEY="${SSH_KEY:-}"                        # 私钥路径（可空=默认密钥）
OBFUSCATE="${OBFUSCATE:-0}"                   # 1=发布前用 terser 压缩混淆 JS
SSH_PROXY="${SSH_PROXY:-connect -H 127.0.0.1:7890 %h %p}"  # 出口代理（本机直连不通时用；直连可置空）
# ---------------------------

SSH_OPTS=(-p "$ALI_PORT" -o StrictHostKeyChecking=accept-new)
[ -n "$SSH_KEY" ] && SSH_OPTS+=(-i "$SSH_KEY")
[ -n "$SSH_PROXY" ] && SSH_OPTS+=(-o "ProxyCommand=$SSH_PROXY")

TS="$(date +%Y%m%d-%H%M%S)"
STAGE=".deploy-staging-$TS"
trap 'rm -rf "$STAGE"' EXIT

echo "==> 白名单收集发布文件 → $STAGE"
mkdir -p "$STAGE"
cp -r index.html robots.txt styles src assets "$STAGE/"

if [ "$OBFUSCATE" = "1" ]; then
  echo "==> terser 压缩混淆 src/**/*.js（源文件不动，仅处理发布副本）"
  (cd "$STAGE" && find src -name '*.js' -print0 | while IFS= read -r -d '' f; do
    npx --yes terser "$f" --module --compress --mangle --mangle-props regex='/^_/' -o "$f"
  done)
fi

REL="$ALI_DIR/releases/$TS"
echo "==> 推送至 $ALI_USER@$ALI_HOST:$REL"
tar czf - -C "$STAGE" . | ssh "${SSH_OPTS[@]}" "$ALI_USER@$ALI_HOST" "
  set -e
  mkdir -p '$REL'
  tar xzf - -C '$REL'
  ln -sfn '$REL' '$ALI_DIR/current'
  cd '$ALI_DIR/releases' && ls -1t | tail -n +6 | xargs -r rm -rf
"

echo "==> 已发布：http://$ALI_HOST/ （版本 $TS）"
echo "    回滚：ssh $ALI_USER@$ALI_HOST 'ln -sfn $ALI_DIR/releases/<旧版本> $ALI_DIR/current'"
