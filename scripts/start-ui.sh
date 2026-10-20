#!/usr/bin/env bash
# 一键启动 data-mcps 工作台（沿用 metric-factory scripts/start-ui.sh 模式）：
#   依赖缺失自动安装 → 产物缺失或源码更新自动构建 → 起本机服务 → 健康检查 → 打开浏览器。
# 本机单用户：仅监听 127.0.0.1；外部数据为明确标注的合成夹具，无真实供应商调用。
# 端口默认 4173（被占用时自动顺延到 4174）；DATA_MCPS_PORT 可覆盖。
# 数据根默认 <repo>/.data-mcps；DATA_MCPS_DATA_ROOT 可覆盖。
# 测试/无浏览器环境：DATA_MCPS_NO_OPEN=1 跳过 open。
set -e
cd "$(dirname "$0")/.."

echo "== data-mcps 工作台 =="

# Node ≥ 22.19
if ! command -v node >/dev/null 2>&1; then
  echo "[环境] 未找到 Node.js（需要 ≥ 22.19）" >&2
  exit 1
fi
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)"; then
  echo "[环境] Node 版本过低（当前 $(node -v)，需要 ≥ 22.19）" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[首次运行] 安装依赖…"
  npm install --no-audit --no-fund
fi
# 构建判定：产物缺失，或 src/ui/catalog/package.json 比产物新（拉取新代码后自动重建）
if [ ! -f dist/cli.js ] || [ -n "$(find src ui catalog package.json -newer dist/cli.js -print -quit 2>/dev/null)" ]; then
  echo "[构建] 引擎与 UI（源码比产物新或缺产物）…"
  npm run build
fi

PORT="${DATA_MCPS_PORT:-4173}"
if curl -s -o /dev/null "http://127.0.0.1:${PORT}/api/v1/sources"; then
  echo "[端口] ${PORT} 已被占用，改用 4174"
  PORT=4174
fi

DATA_ROOT="${DATA_MCPS_DATA_ROOT:-$PWD/.data-mcps}"

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "[启动] 本机服务 http://127.0.0.1:${PORT} (Ctrl+C 退出)"
node dist/cli.js ui -p "$PORT" --data-root "$DATA_ROOT" &
SERVER_PID=$!

READY=0
for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/api/v1/sources"; then READY=1; break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then wait "$SERVER_PID"; exit 1; fi
  sleep 1
done
if [ "$READY" != "1" ]; then
  echo "[错误] 服务 40 秒内未就绪" >&2
  exit 1
fi

if [ -z "${DATA_MCPS_NO_OPEN:-}" ] && command -v open >/dev/null 2>&1; then
  open "http://127.0.0.1:${PORT}"
fi

wait "$SERVER_PID"
