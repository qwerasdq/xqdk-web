# 开发日志 — 象棋迪克 Web（XQDK Web）

Web 端中国象棋 AI 辅助对弈应用。方案见 [CLAUDE.md](CLAUDE.md)（v2.0）。

## 2026-10-03 — 第 1 天：工程搭建 + 规则层移植（W1 里程碑）

### 环境准备
- 安装 Android Studio 2026.2.1.8（D:\android-studio）、Temurin JDK 17（D:\jdk-17）、Android SDK 34 + NDK 25/26.3（D:\Android\Sdk）
- clone chess-dike 源码到 D:\chess-dike（Android 版，规则层移植蓝本）
- 成功构建 Android APK（XQDK 2026.10.03，61MB，dotprod 变体）并安装到 Redmi K30 Pro

### Web 工程（d:\project）
- 脚手架：Vite 6 + Vue 3 + TypeScript + Vitest（npmmirror 镜像源）
- 目录：`src/xiangqi/`（规则层）、`src/components/`（SVG 棋盘）、`src/engine/`（预留，W2）

### 规则层移植（直译 chess-dike gamelogic 包）
| 文件 | 来源 | 说明 |
|---|---|---|
| piece.ts | Piece.java | 棋子常量 1-14、FEN 字符映射、中文名 |
| position.ts | Position.java | 坐标 |
| board.ts | Board.java | piece[y][x]、FEN 解析/生成、doMove/tryMove |
| rule.ts | Rule.java | 走法生成、将军/将死/飞将、蹩马腿/塞象眼 |
| move.ts | Move.java | UCCI 互转、中文记谱（前/中/后消歧） |
| zobrist.ts | 新实现 | 种子 PRNG 生成 64 位键（BigInt）；Android 版固定表与开局库耦合，Web 端 MVP 不需要 |
| game.ts | Game.java | 对局状态机 + 悔棋 + **新增**：重复判和/长将判负/困毙判定 |

**Web 版规则增强（Android 版缺失，原依赖引擎兜底）**：
1. `legalMoves`：完整合法着法过滤（走后不送将 + 不照面）
2. `isStalemated`：困毙判定（对方无合法着法且未被将军 → 判负）
3. 重复局面判和：局面键第 3 次出现判和；连续将军 ≥4 时推迟判和（长将优先，符合亚洲规则）
4. 长将判负：同一方连续将军 ≥8 且局面循环 → 判负（MVP 简化规则，待细化为亚洲规则）

### 测试（Vitest，19 用例全过）
- FEN 往返、中文记谱（炮二平五/马八进七/前车进一消歧）、蹩马腿/塞象眼、
  送将过滤、将军检测、将死（重炮杀）、困毙、重复判和（双车循环）、
  长将判负（8 连将）、悔棋、初始局面可走点数抽查

### 遇到的问题与解决
1. 测试 FEN 行序写反（xqbase FEN 第一行是 y=0 黑方行）→ 修正所有测试 FEN
2. 长将与重复判和优先级：将军循环中 DRAW 先触发 → 增加"连续将军 ≥4 时推迟判和"
3. vue-tsc 对 private 类字段报 TS2741（.vue/.ts program 类型实例不一致）→ Board.piece 改公开字段（注释标注勿直接访问）
4. SVG 点击热区被棋子覆盖 → 热区透明 rect 置于顶层

### 待办（W2）
- [ ] EngineWorker + UCI 桥（官方 pikafish.js/wasm 下载，45MB NNUE 懒加载 + 进度条）
- [ ] 人机对弈 v0（AI 应招 + 终局判定联动）
- [ ] 难度分档（Skill Level + depth 分档 + random_move）

## 2026-10-03 — 第 2 天：引擎接入 + 人机对弈 v0（W2 里程碑）

### 引擎产物（与 CLAUDE.md 调研结论有出入，实测修正）
- **官方 Releases 无 WASM 产物**（查了全部历史 release：只有 7z 原生二进制包 + Wiki + 权重）→ 改用社区预编译
  [dffge552/xiangqi-pwa-offline](https://github.com/dffge552/xiangqi-pwa-offline)（用户确认）
- 文件：`public/engine/pikafish.js`（61KB，UMD）+ `pikafish.wasm`（510KB）+ `pikafish.data`（4MB）
- **NNUE 内嵌**：data 文件内嵌 8MiB 网络（(4320,1024,15,32,1)），**无需运行时加载 45MB 权重**；
  45MB 版权重（本地 Android 同源 + 社区仓库 43MB 版）仅作后续棋力增强备选
- 引擎版本 dev-20240816，pthread 构建，**需要 SharedArrayBuffer**（COOP/COEP 响应头，
  vite dev/preview 已配；GitHub Pages 无法部署此构建，需 Cloudflare Pages 或换构建）

### 引擎接口（探测实测，与 CLAUDE.md 5.2 假设的 stdin 方案不同）
- 该构建是社区 patch：`Pikafish({locateFile, mainScriptUrlOrBlob, onReceiveStdout, ...})` →
  module 带 **sendCommand(cmd)**（同步驱动单轮 UCI 循环，`wasm_uci_execute`）+ onReceiveStdout 行回调
- **关键坑 1**：仅在**裸 classic worker**（Blob）中工作；vite 打包的 worker（dev module / build iife）
  均静默失效 → worker 源码内联为字符串（`src/engine/worker.ts` 导出 workerSource）+ Blob classic worker 创建
- **关键坑 2**：sendCommand 同步驱动 UCI 循环，**stdout 回调里同步再 sendCommand 会重入导致挂起**
  （握手序列 onUciOk 发 setoption 即踩坑）→ 全部命令走**串行队列**（setTimeout drain，杜绝重入）
- 搜索跑在引擎自带 em-pthread worker，主线程不卡（实测 depth 18 搜索期间心跳正常）

### 本日交付
| 文件 | 说明 |
|---|---|
| src/engine/uci.ts | info/bestmove 行解析、红方视角评分换算（cp/mate 翻转、wdl 胜率） |
| src/engine/worker.ts | 引擎宿主：装载（fetch+new Function+假 importScripts 参数注入）、握手、搜索队列（pendingGo/stop）、串行命令队列 |
| src/engine/useEngine.ts | 主线程封装：init/ready 状态机、engineSearch（Promise+id 过期）、setEngineOption、engineNewGame、onEngineInfo |
| src/App.vue | 人机对弈 v0：你执红 AI 执黑、5 档难度（depth 6-22 + Skill Level 8-20）、AI 长将/困毙拦截重搜（searchmoves excluded）、悔棋撤 2 步、FEN 摆棋触发 AI、引擎加载状态 |
| vite.config.ts | dev/preview COOP+COEP 响应头（SAB） |

### e2e 验证（Playwright）
- 完整对局 5 回合：炮二平五/马八进七/车九平八/马二进三/兵七进一，AI 应招（顺炮炮8平5 等）正确
- 悔棋×2 各撤 2 步 ✓；新对局后引擎继续工作 ✓
- FEN 摆棋（轮到黑方）→ AI 自动先手 ✓；难度切换 ✓；production build（vite preview）同样全通 ✓
- 规则层 19 单测 + vue-tsc 全绿

### 遗留 / 待办
- [ ] 45MB 大权重接入（`FS_createDataFile` 写 /pikafish.nnue + setoption EvalFile，棋力增强）
- [ ] GitHub Pages 部署不可用（SAB）→ Cloudflare Pages + _headers 或找非 pthread 构建
- [ ] W3：分析面板（评分/胜率/MultiPV 候选/EvalBar）、支招模式、random_move 开局多样性

## 2026-10-03 — 第 2 天（续）：分析/支招模式 + random_move（W3 里程碑）

### 本日交付
| 文件 | 说明 |
|---|---|
| src/engine/useEngine.ts | 新增 engineAnalyze（MultiPV 分析：info 按 multipv 分组、红方视角换算、100ms 节流回调、bestmove 终版）；MultiPV 经 setoption 切换（实测 pikafish 不支持 go multipv 参数）；engineSearch 固定单线 |
| src/xiangqi/pv.ts | PV 工具：pvToChinese（FEN 模拟走子转中文着法）、describeMove（"炮二平五 (h2e2)"，同 Android MoveChinese.describe）、ucciToXY（箭头坐标） |
| src/components/analysis/EvalBar.vue | 红方胜率评分条 |
| src/components/analysis/AnalysisPanel.vue | 评分/胜率行 + 候选着法列表（点击选中）+ PV 前 4 步中文变例 |
| src/components/BoardView.vue | 建议箭头（suggestMove prop，橙线+三角箭头） |
| src/App.vue | 对弈/支招分析双模式切换；分析模式走子后自动 MultiPV 3 分析；random_move 开局多样性（前 12 回合从 3 候选随机挑，照抄 Android GameController） |

### 遇到的问题与解决
1. 分析只有 1 条候选 → pikafish（同 Stockfish）不支持 `go multipv`，MultiPV 必须 `setoption`；
   主线程 postMessage 有序 + worker 命令队列串行，保证 setoption 先于 position/go 执行
2. 照抄 Android `new Move(board)` 构造报错 → Web 版 Move 构造签名是 (from, to, board?)，pv.ts 适配

### e2e 验证（Playwright）
- 支招模式：初始局面 3 候选（炮二平五/炮二平四/炮八平五 +0.38/+0.32/+0.28 胜率 54.6%/53.6%/53.1%）、PV 4 步中文、点击候选箭头+变例切换、走子自动重分析、切回对弈 AI 应招 ✓
- random_move：4 局同着法开局 AI 应招 2 种（炮8平5/马8进7）✓
- 规则层 19 单测 + vue-tsc + production build 全绿

### 遗留 / 待办
- [ ] W4：XQF/PGN 复盘、PWA、部署（Cloudflare Pages，SAB 要求）
- [ ] W5：JJ 支招 MVP（手动摆棋同步）

## 2026-10-03 — 第 2 天（续）：复盘模块 + PWA（W4 里程碑）

### 本日交付
| 文件 | 说明 |
|---|---|
| src/manuals/xqf.ts | **XQF 解析器**（直译 XQFParser.java + XQFKey.java + XQFBufferDecoder.java，去 JBBP 依赖改 DataView 偏移读取）：头部定长结构、v10+ 解密（KeyXY/KeyXYf/KeyXYt/KeyRMKSize/F32Keys）、v12+ 局面位置解密、着法记录 + 变例树 + GB18030 注解 |
| src/manuals/pgn.ts | **PGN 解析器**：头部标签、中文纵线记谱→UCCI **逆解析（生成-匹配法）**——对每个同类型候选棋子枚举合法着法、用 getChsString 生成比对，消歧规则天然与记谱器一致 |
| src/manuals/xqf.test.ts, pgn.test.ts | 真实样例测试：XQF 加密版着法全量回放合法；PGN 37 着全量合法性 + 全部合法着法往返自洽（生成→逆解析→同着法） |
| src/features/review/ReviewView.vue | 复盘 UI：文件导入（.xqf/.pgn）、步进/快退/快进/跳转、变例分支选择、可选挂引擎分析（MultiPV 3 + 箭头） |
| vite.config.ts | vite-plugin-pwa：应用壳 precache（带 hash js/css/html），引擎文件运行时 CacheFirst |
| src/engine/useEngine.ts | 引擎缓存预热（首次加载 SW 未接管时主动写 engine-assets cache，保证离线可用） |
| public/_headers | Cloudflare Pages COOP/COEP 响应头（SAB 要求） |

### 遇到的问题与解决
1. **PWA 离线引擎失效**：SW 首次注册时引擎 XHR 已发出（未被拦截），runtimeCaching 缓存为空 → 引擎就绪后主动 `cache.add()` 预热（与 workbox 同 cacheName）
2. **复盘模式切换入口消失**：mode-tabs 原在 aside.panel 内，复盘时 aside 被 v-else 隐藏 → 用户被困复盘页。已把 tabs 提到 layout 外（始终可见）
3. vue-tsc 对 template 内 `mode === 'review'` 字面量比较做流收窄误报 → 改用 computed 布尔量（isReview/isAnalyze/isGame）
4. 样例 XQF 头部元数据全 0（文件本身未填），测试改为断言类型而非非空

### e2e 验证（Playwright，production build + preview server）
- 三模式冒烟：对弈（AI 应招 马2进3）、支招分析（3 候选）、复盘（导入 XQF 135 着 + 步进 + 变例）✓
- 导入 PGN 37 着、步进/快退/快进/跳转、挂引擎分析（3 候选）✓
- **离线**：SW 注册 → 断网重开 → 引擎就绪 → 完整对局 ✓
- 单测 33 个全绿（规则 19 + XQF 5 + PGN 9）+ vue-tsc

### 遗留 / 待办
- [ ] 部署：Cloudflare Pages（含 _headers）；GitHub Pages 因 SAB 不可用
- [ ] W5：JJ 支招 MVP（手动摆棋同步）
- [ ] 复盘增强：PGN 变例括号嵌套、XQF 注解展示、引擎分析缓存

## 2026-10-03 — 第 2 天（续）：部署脚本

- `scripts/deploy.sh` + `npm run deploy` / `npm run deploy:check`
  - 流程：引擎产物检查 → 单测 → 构建（vue-tsc+vite）→ 产物校验（index.html / _headers 含 COOP+COEP / engine×3）→ Cloudflare 登录检查 → 自动建项目 → `wrangler pages deploy` → 线上 curl 验证 COOP/COEP 响应头
  - `--check` 仅本地校验不部署；`--skip-tests` 跳过单测；环境变量 CF_PAGES_PROJECT / CF_PAGES_BRANCH 可覆盖项目名/分支
  - 实测：`--check` 全链路通过，产物 4.7M（远超 Pages 限制的富余；45MB 大权重方案才需 R2）
  - 未登录时 whoami 输出 "not authenticated"（退出码为 0），脚本用 grep 匹配该文案拦截
- 首次部署前置：`npx wrangler login`（或 CLOUDFLARE_API_TOKEN 环境变量）

## 2026-10-03 — 第 2 天（续）：GitHub Actions 推送自动部署

- `.github/workflows/deploy.yml`：push main/master（或手动触发）→ 引擎产物准备（未入库则从上游下载 + SHA256 校验，见 scripts/engine.sha256）→ 单测 → 构建 → 产物校验（_headers COOP/COEP）→ wrangler-action 部署 Cloudflare Pages
  - concurrency 组避免并发部署；npm cache 加速
  - 部署分支名 = 触发分支名（与 CF 项目 Production branch 一致时为生产部署，否则 Preview）
- 一次性配置：Cloudflare 建 API Token（Pages:Edit）+ GitHub Secrets 配 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
- .gitignore 更新：排除 dist/ 与 tsconfig.tsbuildinfo
- 本地已验证：YAML 语法、npm ci（需先结束占用的 vite 进程，EPERM 解除）、引擎准备 shell 脚本、SHA 校验、测试与构建链
