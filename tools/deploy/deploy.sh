#!/usr/bin/env bash
# 阿里云一键部署：本地执行，把静态站点发布到服务器 nginx 目录。
# 用法：
#   1) 首次：把下面 5 个变量改成你的服务器信息（或用环境变量传入）
#   2) 服务器上先跑一次初始化：ssh 上去执行 tools/deploy/server-setup.sh
#   3) 以后每次发布：bash tools/deploy/deploy.sh
#
# 环境变量覆盖示例：
#   ALI_HOST=1.2.3.4 ALI_USER=root SSH_KEY=~/.ssh/id_rsa bash tools/deploy/deploy.sh
set -euo pipefail

# ---- 配置区（改成你的）----
ALI_HOST="${ALI_HOST:-YOUR_SERVER_IP}"        # 服务器 IP 或域名
ALI_USER="${ALI_USER:-root}"                  # SSH 用户
ALI_PORT="${ALI_PORT:-22}"                    # SSH 端口
ALI_DIR="${ALI_DIR:-/var/www/game-shop}"      # 服务器站点目录
SSH_KEY="${SSH_KEY:-}"                        # 私钥路径（可空=默认密钥/密码）
# ---------------------------

if [ "$ALI_HOST" = "YOUR_SERVER_IP" ]; then
  echo "✗ 请先编辑 tools/deploy/deploy.sh 配置区，或用 ALI_HOST 环境变量传入服务器地址" >&2
  exit 1
fi

SSH_OPTS=(-p "$ALI_PORT" -o StrictHostKeyChecking=accept-new)
[ -n "$SSH_KEY" ] && SSH_OPTS+=(-i "$SSH_KEY")

TS="$(date +%Y%m%d-%H%M%S)"
REL="$ALI_DIR/releases/$TS"

echo "==> 打包静态站点（排除 .git/node_modules/日志/截图/工具链）…"
tar czf - \
  --exclude=.git --exclude=node_modules --exclude=tools/e2e/node_modules \
  --exclude=tools/e2e/shots --exclude='*.log' --exclude=tools/blender \
  --exclude=.workbuddy-ai \
  . | ssh "${SSH_OPTS[@]}" "$ALI_USER@$ALI_HOST" "
    set -e
    mkdir -p '$REL'
    tar xzf - -C '$REL'
    ln -sfn '$REL' '$ALI_DIR/current'
    # 清理旧版本，只留最近 5 个（回滚用）
    cd '$ALI_DIR/releases' && ls -1t | tail -n +6 | xargs -r rm -rf
"

echo "==> 已发布：http://$ALI_HOST/ （目录 $REL，current 软链已切换）"
echo "    回滚：ssh $ALI_USER@$ALI_HOST 'ln -sfn $ALI_DIR/releases/<旧版本> $ALI_DIR/current'"
