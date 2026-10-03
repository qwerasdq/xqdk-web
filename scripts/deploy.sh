#!/usr/bin/env bash
# 本地校验 + 手动部署（备用）
#
# 正式部署走 Cloudflare Git 集成：推送到 GitHub → Cloudflare 自动构建部署（无需 Token）。
# 本脚本用于：本地提交前的完整校验（--check），或 Git 集成出问题时的手动部署兜底。
#
# 为什么不是 GitHub Pages：Pikafish WASM 是 pthread 构建，需要 SharedArrayBuffer，
# 而 SAB 要求 COOP/COEP 响应头，GitHub Pages 不支持自定义响应头。
# Cloudflare Pages 通过 public/_headers 配置（构建时复制到 dist/_headers）。
#
# 用法：
#   bash scripts/deploy.sh --check        # 仅本地校验（单测 + 构建 + 产物检查），不部署
#   bash scripts/deploy.sh                # 全量：单测 + 构建 + 校验 + 手动部署 + 线上验证
#   bash scripts/deploy.sh --skip-tests   # 跳过单测
#
# 手动部署首次使用：
#   npx wrangler login                    # 浏览器授权（或用 CLOUDFLARE_API_TOKEN 环境变量）
#
# 可用环境变量：
#   CF_PAGES_PROJECT   项目名（默认 xqdk-web）
#   CF_PAGES_BRANCH    分支（默认 main；与项目 production branch 一致时为生产部署）
set -euo pipefail

PROJECT_NAME="${CF_PAGES_PROJECT:-xqdk-web}"
BRANCH="${CF_PAGES_BRANCH:-main}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP_TESTS=0
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --check) CHECK_ONLY=1; SKIP_TESTS=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "[x] 未知参数: $arg（用 --help 查看用法）"; exit 1 ;;
  esac
done

# ---- 1. 引擎产物检查（不进 git，缺失时提示来源）----
echo "==> 检查引擎产物"
for f in pikafish.js pikafish.wasm pikafish.data; do
  if [ ! -f "public/engine/$f" ]; then
    echo "[x] 缺少 public/engine/$f"
    echo "    NNUE 内嵌于 pikafish.data，三个文件缺一不可（来源见 DEVLOG「引擎产物」）"
    exit 1
  fi
done
echo "    pikafish.js / .wasm / .data 齐备"

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
[ -f dist/_headers ] || { echo "[x] dist/_headers 缺失（COOP/COEP 响应头，引擎必需）"; exit 1; }
grep -q "Cross-Origin-Opener-Policy" dist/_headers || { echo "[x] _headers 缺 COOP"; exit 1; }
grep -q "Cross-Origin-Embedder-Policy" dist/_headers || { echo "[x] _headers 缺 COEP"; exit 1; }
for f in pikafish.js pikafish.wasm pikafish.data; do
  [ -f "dist/engine/$f" ] || { echo "[x] dist/engine/$f 缺失"; exit 1; }
done
SIZE="$(du -sh dist | cut -f1)"
echo "    产物 OK（index.html / _headers(COOP+COEP) / engine×3，共 $SIZE）"

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "==> --check 模式：本地校验通过，跳过部署"
  exit 0
fi

# ---- 4. 登录检查 ----
echo "==> 检查 Cloudflare 登录状态"
WHO="$(npx wrangler whoami 2>&1)" || true
if printf '%s' "$WHO" | grep -qi "not authenticated\|not logged in\|未登录"; then
  echo "[x] 未登录 Cloudflare。先执行: npx wrangler login"
  echo "    或在环境变量中设置 CLOUDFLARE_API_TOKEN"
  exit 1
fi

# ---- 5. 首次部署创建项目（已存在则忽略）----
npx wrangler pages project create "$PROJECT_NAME" --production-branch "$BRANCH" >/dev/null 2>&1 || true

# ---- 6. 部署 ----
echo "==> 部署到 Cloudflare Pages（$PROJECT_NAME / $BRANCH）"
set +e
OUT="$(npx wrangler pages deploy dist --project-name "$PROJECT_NAME" --branch "$BRANCH" 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$OUT"
[ "$STATUS" -eq 0 ] || { echo "[x] 部署失败（wrangler 退出码 $STATUS）"; exit "$STATUS"; }

# ---- 7. 线上验证（COOP/COEP 是引擎能否加载的前提）----
URL="$(printf '%s' "$OUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.pages\.dev' | tail -1)"
if [ -n "$URL" ]; then
  echo "==> 线上验证响应头（$URL）"
  H="$(curl -sI "$URL/" 2>/dev/null || true)"
  if printf '%s' "$H" | grep -qi "cross-origin-opener-policy: same-origin"; then
    echo "    COOP OK"
  else
    echo "    [!] 未检测到 COOP —— 引擎将无法加载（检查 _headers 是否随构建复制到 dist）"
  fi
  if printf '%s' "$H" | grep -qi "cross-origin-embedder-policy: require-corp"; then
    echo "    COEP OK"
  else
    echo "    [!] 未检测到 COEP —— 引擎将无法加载"
  fi
fi
echo "==> 部署完成"
