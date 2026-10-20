#!/usr/bin/env bash
# data-mcps 一键启动：检查环境 →（必要时）安装依赖 → 构建 → 启动本地服务并打开浏览器。
# 退出即停服务（Ctrl-C）。端口被占用时服务会明确报错退出（不静默换端口）。
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-4173}"

# Node ≥ 22.19
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请安装 Node ≥ 22.19 后重试。" >&2
  exit 1
fi
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)"; then
  echo "Node 版本过低（当前 $(node -v)，需要 ≥ 22.19）。" >&2
  exit 1
fi

[ -d node_modules ] || { echo "首次运行：安装依赖…"; npm install; }

echo "构建…"
npm run build

echo "启动本地服务（仅 127.0.0.1:${PORT}）…"
node dist/cli.js ui -p "$PORT" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

# 就绪后自动打开浏览器；服务若提前退出（如端口占用）则原样报错
for _ in $(seq 1 50); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    wait "$SERVER_PID"
    exit 1
  fi
  if curl -sf "http://127.0.0.1:${PORT}/api/v1/sources" >/dev/null 2>&1; then
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      # 端口被既有实例占用：本进程的服务已退出，原样报错
      wait "$SERVER_PID"
      exit 1
    fi
    echo "已就绪：http://127.0.0.1:${PORT}（Ctrl-C 停止）"
    command -v open >/dev/null 2>&1 && open "http://127.0.0.1:${PORT}" || true
    wait "$SERVER_PID"
    exit 0
  fi
  sleep 0.2
done

echo "服务 10 秒内未就绪，请查看上方日志。" >&2
exit 1
