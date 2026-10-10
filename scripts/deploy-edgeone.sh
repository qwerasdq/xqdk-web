#!/usr/bin/env bash
# EdgeOne Pages 部署（备用路径 + 本地校验）
#
# 正式部署走 EdgeOne Pages **Git 集成**：推送到 GitHub → EdgeOne 自动构建部署。
# 构建/输出/响应头/SPA fallback 全部由根目录 edgeone.json 声明，无需在控制台填参数。
# 本脚本用于：本地提交前的完整校验（--check），或 Git 集成出问题时的手动上传兜底。
#
# 为什么是 EdgeOne 而不是 Cloudflare Workers：workers.dev 域名在国内被定向阻断，
# 必须挂代理才能访问；EdgeOne Pages 默认域名（*.edgeone.app）国内直连可达。
# 引擎是 pthread 构建的 WASM，需要 SharedArrayBuffer → 必须有 COOP/COEP 响应头，
# 由 edgeone.json 的 headers 段配置（GitHub Pages 这类不能配响应头的托管不可用）。
#
# 用法：
#   bash scripts/deploy-edgeone.sh --check              # 仅本地校验（构建 + 产物检查），不部署
#   EDGEONE_API_TOKEN=xxx bash scripts/deploy-edgeone.sh   # 用 API Token 部署（CI / 非交互）
#   bash scripts/deploy-edgeone.sh                      # 用已登录的 CLI 会话部署
#
# 首次使用：
#   npm i -g edgeone && edgeone login     # 浏览器授权（腾讯云中国站账号）
#   API Token 获取：Makers 控制台 → API Token → 创建（CI 用，见 edgeone CLI README）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT="${EDGEONE_PROJECT:-xqdk-web}"
SKIP_TESTS=0
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --check) CHECK_ONLY=1; SKIP_TESTS=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "[x] 未知参数: $arg（用 --help 查看用法）"; exit 1 ;;
  esac
done

# ---- 1. 引擎产物检查（已入库，SHA256 见 scripts/engine.sha256）----
echo "==> 检查引擎产物"
for f in pikafish.js pikafish.wasm pikafish.data; do
  if [ ! -f "public/engine/$f" ]; then
    echo "[x] 缺少 public/engine/$f"
    echo "    NNUE 内嵌于 pikafish.data，三个文件缺一不可（来源见 DEVLOG「引擎产物」）"
    exit 1
  fi
done
echo "    pikafish.js / .wasm / .data 齐备"

# ---- 1b. 识别模型与 ORT 运行时检查 ----
# 模型 xq-yolo-640.onnx 已入库（SHA256 见 public/models/README.md）；ORT 运行时由
# scripts/vision-assets.mjs 从 node_modules 生成，不入 git（见 .gitignore）。
echo "==> 检查识别资产"
[ -f "public/models/xq-yolo-640.onnx" ] || { echo "[x] 缺少 public/models/xq-yolo-640.onnx（来源见 public/models/README.md）"; exit 1; }
[ -f "public/ort/ort-wasm-simd-threaded.wasm" ] || { echo "[x] 缺少 ORT wasm —— 先执行: node scripts/vision-assets.mjs"; exit 1; }
ORT_SIZE="$(stat -c %s public/ort/ort-wasm-simd-threaded.wasm 2>/dev/null || stat -f %z public/ort/ort-wasm-simd-threaded.wasm)"
if [ "$ORT_SIZE" -gt $((25 * 1024 * 1024)) ]; then
  echo "[x] ORT wasm ${ORT_SIZE} 字节超过单文件 25 MiB 上限 —— 需降级 onnxruntime-web 版本"
  exit 1
fi
echo "    xq-yolo-640.onnx / ORT wasm($(awk -v s="$ORT_SIZE" 'BEGIN { printf "%.1f", s/1048576 }') MiB) 齐备"

# ---- 2. 测试 + 构建 ----
if [ "$SKIP_TESTS" -eq 0 ]; then
  echo "==> 单元测试"
  npx vitest run
fi
echo "==> 构建（vue-tsc 类型检查 + vite build）"
npm run build

# ---- 3. 产物校验 ----
echo "==> 产物校验"
[ -f dist/index.html ] || { echo "[x] dist/index.html 缺失"; exit 1; }
for f in pikafish.js pikafish.wasm pikafish.data; do
  [ -f "dist/engine/$f" ] || { echo "[x] dist/engine/$f 缺失"; exit 1; }
done
[ -f "dist/models/xq-yolo-640.onnx" ] || { echo "[x] dist/models/xq-yolo-640.onnx 缺失"; exit 1; }
[ -f "dist/ort/ort-wasm-simd-threaded.wasm" ] || { echo "[x] dist/ort/wasm 缺失（运行 node scripts/vision-assets.mjs）"; exit 1; }
[ -f edgeone.json ] || { echo "[x] 缺少 edgeone.json（COOP/COEP 响应头来源，缺失则引擎无法加载）"; exit 1; }
grep -q "Cross-Origin-Embedder-Policy" edgeone.json || { echo "[x] edgeone.json 缺 COEP 配置"; exit 1; }
# Git 集成读仓库根的 edgeone.json；手动上传读的是「上传目录内」的那份。
# 复制一份进 dist，两条路径共用同一份配置（否则手动上传会丢 COOP/COEP）。
cp edgeone.json dist/edgeone.json
[ -f dist/edgeone.json ] || { echo "[x] dist/edgeone.json 复制失败"; exit 1; }
SIZE="$(du -sh dist | cut -f1)"
echo "    产物 OK（index.html / engine×3 / models / ort，共 $SIZE）"

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "==> --check 模式：本地校验通过，跳过部署"
  exit 0
fi

# ---- 4. 部署（配置见根目录 edgeone.json）----
echo "==> 部署到 EdgeOne Pages（$PROJECT）"
if [ -n "${EDGEONE_API_TOKEN:-}" ]; then
  npx -y edgeone makers deploy ./dist -n "$PROJECT" -t "$EDGEONE_API_TOKEN"
else
  npx -y edgeone makers deploy ./dist -n "$PROJECT"
fi

# ---- 5. 线上验证（COOP/COEP 是引擎能否加载的前提）----
# 默认域名形如 https://<project>.<子域>.edgeone.app；可用 EDGEONE_URL 覆盖。
URL="${EDGEONE_URL:-}"
if [ -z "$URL" ]; then
  echo "==> 跳过线上验证（未设置 EDGEONE_URL）"
  echo "    部署后在控制台复制默认域名，再执行："
  echo "    EDGEONE_URL=https://xxx.edgeone.app bash -c 'curl -sI \$EDGEONE_URL/ | grep -i cross-origin'"
  echo "==> 部署完成"
  exit 0
fi
echo "==> 线上验证响应头（$URL）"
H="$(curl -sI "$URL/" 2>/dev/null || true)"
if printf '%s' "$H" | grep -qi "cross-origin-opener-policy: same-origin"; then
  echo "    COOP OK"
else
  echo "    [!] 未检测到 COOP —— 引擎将无法加载（检查 edgeone.json headers 是否生效）"
fi
if printf '%s' "$H" | grep -qi "cross-origin-embedder-policy: require-corp"; then
  echo "    COEP OK"
else
  echo "    [!] 未检测到 COEP —— 引擎将无法加载"
fi
echo "==> 部署完成"
