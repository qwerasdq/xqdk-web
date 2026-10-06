# 开发日志 — 象棋迪克 Web（XQDK Web）

Web 端中国象棋 AI 辅助对弈应用。方案见 [CLAUDE.md](CLAUDE.md)（v2.0）。

## 2026-10-06 — 修复「无法开始屏幕捕获：reading attachPreview」

### 背景

- 症状：点「开始捕获」后报 `无法开始屏幕捕获：Cannot read properties of null (reading 'attachPreview')`，
  真实失败原因被这条消息覆盖，无从排查。

### 根因

- `useVision.start()` 中 `capture = new ScreenCapture(...)` → `await capture.start()`（内部 `getDisplayMedia`
  等用户选窗口，可达数秒）→ 恢复执行后再读模块级 `capture`。
- 授权期间识别 worker 若初始化失败（`init-error` / worker 异常），会经 `stopCapture()` 把 `capture` 置空；
  于是 `await` 恢复后 `capture.attachPreview(...)` 抛 TypeError，又被本函数的 catch 包装成
  「无法开始屏幕捕获：…」，把 worker 报出的真实错误（如模型加载失败）冲掉。
- 次生问题：`ScreenCapture.stop()` 若发生在 `getDisplayMedia` 授权完成前是空操作，授权完成后媒体流仍会
  启动且无人回收（屏幕流泄漏 + 持续抽帧）。

### 本次交付

| 文件 | 说明 |
|---|---|
| src/vision/useVision.ts | 改用局部 `const cap` 持有本次实例；`await` 后校验 `capture === cap`，已被回收则放弃接线并补一次 `cap.stop()`；catch 仅在仍持有该实例时才 `notifyError`，保留 worker 的真实错误 |
| src/vision/capture.ts | 新增 `stopped` 标志：`stop()` 在授权/播放期间被调用时，`start()` 拿到流后立即释放并返回，不进入抽帧 |
| src/vision/useVision.test.ts | 新增回归测试：mock 支持「start 挂起（模拟等待授权）」，授权期间派发 `init-error`，断言不崩溃、真实错误不被覆盖、`attachPreview` 未被调用、流被回收 |

### 验证

- 104 个单测全过（新增 1 个）；`vue-tsc` + `npm run build` 全绿。
- 该回归测试在修复前必然失败（旧代码抛 TypeError 并覆盖 `lastError`）。

### 遗留 / 待办

- [ ] 若真实失败原因是模型/ORT 加载：新代码已能显示真实 message，按提示继续排查（本次只修了错误被掩盖的问题）

### 2026-10-07 复查

- 用户再次报同一报错。核对 `git HEAD`（f9425e9）：仍是旧的 `capture.attachPreview(...)` 写法，
  修复只存在于工作区未提交 → 线上构建（Workers Builds 走 git）与其他 clone 依旧复现。
- 本地 dev（Vite）+ 真实 Chromium（headless + 自动选屏）点「开始捕获」正常进入「识别中（wasm）」、无报错；
  故该报错只能来自旧 bundle（PWA service worker precache 的旧 hash js，或未提交的线上构建）。

## 2026-10-06 — 仓库体检与二进制资产 git 策略对齐

### 背景

- 例行体检：103 个单测全过，`vue-tsc` + `vite build` 全绿，`dist` 产物完整（`_headers` COOP/COEP、engine×3、models、ort）；
  `public/engine/*`、`xq-yolo-640.onnx`、ORT wasm 的 SHA256 与 `scripts/*.sha256` 逐条一致。
- 发现文档与事实不符：CLAUDE.md / `scripts/deploy.sh` 写「引擎产物不进 git」，
  但 `public/engine/{pikafish.js,wasm,data}` 与 `public/models/xq-yolo-640.onnx` 实际已被 git 跟踪。

### 结论：二进制资产继续入库，修正文档

- 正式部署走 Cloudflare Workers Builds（Git 集成），构建命令 `npm ci && npx vitest run && npm run build`，
  仓库内**没有**下载引擎/模型的步骤（`.github/workflows/deploy.yml` 已于 10-03 移除）。
  把二进制移出 git 会让线上构建产出缺 `engine/`、`models/` 的坏包 —— 必须入库。
- `public/ort/` 仍不入 git（postinstall 由 `scripts/vision-assets.mjs` 从 node_modules 生成），原描述正确。
- 据此修正 `scripts/deploy.sh` 两处注释；CLAUDE.md 中「不进 git」属 v2.0 方案原文，以本条为准。

### 仓库清理（已执行）

- 排查 remote：仓库原从 `qwerasdq/project`（其 main 为另一记账项目，与本仓库无共同祖先）迁至
  `qwerasdq/xqdk-web`；`main` 上游为 `xqdk/main`，线上 Worker `xqdk-web` 也跟此仓库
  → 旧 `project` remote 属残留，已 `git remote remove project`（连带清掉
  `branch.main.vscode-merge-base`；`project` 的代码 GitHub 上仍有，本地历史不受影响）。
- 体积回收：`.git` 从 **324.2MB 降到 11.7MB**。原不可达 blob 共 2450 个 / 443.7MB（未压缩），
  大头是早期「第一次commit」「第二次11」时期提交又删除的压缩包
  （97MB zip、53MB 7z、50MB / 45.5MB / 44MB zstd、44MB zip），并非代码。
  `git gc --prune=now` 后 `git count-objects` 只剩 1 pack / 211 对象、`garbage: 0`，`git fsck` 无输出。
- 清理后复验：11 个提交历史完好；`public/engine/*`、`xq-yolo-640.onnx` 的 SHA256 与
  `scripts/*.sha256` 仍逐条一致；103 单测 + `vue-tsc` + `vite build` 全绿。

### 遗留 / 待办

- [ ] 删除根目录垃圾文件 `ls`（0 字节，2026-10-06 生成）
- [ ] 根目录未跟踪的 `diagnose_vision_*.png`、`prod_repro_*.png` 归档或删除；`AGENTS.md` 待定是否入库

## 2026-10-06 — 第 5 天：W6d WebGPU 设备丢失防护与后端自愈（收尾）

### 背景 / 续接

- W6d 排查结论：ORT 1.22 在 WebGPU 设备丢失（驱动重置/多显卡切换/远程桌面/休眠唤醒）后，
  `session.run()` 不 reject 而是**永久挂起**（本机实测）——try/catch 无法恢复；
  且同 worker realm 内挂起的 run 使 release 失效，新会话报 `Session already started`，恢复只能换 worker（新 realm）。
- 上一会话完成防护代码与浏览器实测（截图 `w6d_deviceloss.png` 归档），本会话收尾：
  补恢复状态机单元测试、清理死代码（未使用的 `FALLBACK_DELAY_MS`）、补本条目。

### 本次交付

| 文件 | 说明 |
|---|---|
| src/vision/model.ts | 三层防护：①会话创建 + 预热（首次 WebGPU 推理含着色器编译，前移并验证后端真实可用；瞬时适配器失败重试一次）②`watchDeviceLoss` 监听设备丢失 ③推理超时（`run()` 挂起超 5s 抛 `InferenceTimeoutError`）；会话创建 15s 超时防卡在加载中 |
| src/vision/worker.ts | 设备丢失/推理超时上报 `backend-lost` 并拒绝后续帧（不尝试同 realm 重建，交由主线程换 worker） |
| src/vision/useVision.ts | 恢复状态机：`backend-lost` → 先建 WASM 兜底 worker 保持识别不中断 → 自动重连 WebGPU（上限 2 次，稳定 60s 重置配额）→ 转手动「重连 WebGPU」；`backendNotice` 全程提示 |
| src/vision/types.ts | `FromVisionWorker` 增加 `backend-lost` |
| src/features/assist/VisionControl.vue | 降级提示条 + 「重连 WebGPU」按钮（WASM 后端且未在加载时可用） |
| src/vision/model.test.ts（新） | `withTimeout` / `runModel` 超时与输出拷贝测试（6 个） |
| src/vision/useVision.test.ts | 恢复状态机测试（mock Worker + ScreenCapture + fake timers，11 个） |

### 验证

- 101 个单元测试全过（新增 10 个 useVision 状态机测试）；vue-tsc + `npm run build` 全绿
- 恢复链路全路径有测试：设备丢失→兜底替换→自动重连成功/失败→配额耗尽转手动→手动重连→init-error→替换中 stop 回收
- 上一会话浏览器实测截图 `w6d_deviceloss.png` 已归档

### 遗留 / 待办

- [ ] 真实设备丢失场景人工验证（驱动重置/远程桌面切换，观察自动降级与恢复提示是否按预期出现）
- [ ] W6c 真实 JJ 窗口人工验证（预览缩略图确认来源 → 走子 → 观察同步/待确认/丢弃）
- [ ] 移动端布局、音效、开局库（可选增强）

## 2026-10-04 — 第 3 天（续）：W6c 捕获预览缩略图 + 逐帧诊断

### 背景 / 续接

- 真实 JJ 窗口人工验证中发现两个问题：
  1. **来源无法辨认**：Chrome 对 `getDisplayMedia` 的 `track.label` 只给设备 id
     （实测显示 `window:921264:0`），不暴露窗口标题——「窗口名摘要」方案在 Chrome 上不成立；
  2. **「不稳定」不透明**：连续 15+ 帧未确认时只有「· 不稳定」提示，
     不知道是没检测到棋盘、棋子太少还是校验失败，无法自助排查。

### 本次交付

| 文件 | 说明 |
|---|---|
| src/vision/capture.ts | `attachPreview(canvas)` + 每次抽帧同步绘制 240px 宽缩略图到主线程画布；stop 时清空 |
| src/vision/useVision.ts | 状态增加 `lastFrameDiag`（识别子数/校验问题/候选帧数/抽帧尺寸）；`attachPreview` 支持后挂画布（start 前未挂也能补挂） |
| src/vision/worker.ts + types.ts | `frame-result` 增加诊断字段：`pieceCount`、`issues`、`candidateFrames`、`frameW/H` |
| src/vision/boardTracker.ts | 暴露 `candidateFrames` getter（候选局面连续帧数） |
| src/features/assist/VisionControl.vue | 捕获中显示**预览缩略图**（人工确认来源窗口）；诊断行显示「识别到 N 子 · 稳定 x/3 帧」或「校验失败：<原因>」 |
| src/App.vue / AssistPanel.vue | 透传 `lastFrameDiag` 与预览画布挂载事件 |

### 验证

- vue-tsc + `npm run build` 全绿；85 个单元测试全过
- **Chrome fake 捕获源实测**（Playwright `--auto-select-desktop-capture-source`）：
  预览画布 240x135 正常绘制、诊断显示「检测 0 框 · 校验失败：未识别到棋盘」（fake 源无棋盘，符合预期）、
  无控制台错误（截图 `w6c_vision_diag.png`）
- 真实 JJ 窗口验证仍需人工：现在可直接通过缩略图确认捕获源是否正确

### 遗留 / 待办

- [ ] W6c 真实 JJ 窗口人工验证（预览缩略图确认来源 → 走子 → 观察同步/待确认/丢弃）
- [ ] 移动端布局、音效、开局库（可选增强）

## 2026-10-04 — 第 3 天（续）：W6c 人工验证支持 + 防误同步 + 复盘增强

### 背景 / 续接

- W6b 已提交（真实推理链路 + 自动同步），遗留三项：W6c 真实 JJ 窗口人工验证入口、
  「FEN 重载仅手动确认」防误同步、复盘增强（PGN 变例嵌套 / 注解展示 / 引擎分析缓存）。

### 本次交付

| 文件 | 说明 |
|---|---|
| src/vision/sync.ts | 拆出**纯函数 `planSync`**（不改 Game，返回 noop/move/reload 计划）；`reconcileGame` 改为基于计划的应用包装；reload（FEN 重载）不再无条件执行 |
| src/vision/boardTracker.ts | 新增 `ackDecision('apply' / 'discard', canonical)`：已确认/已丢弃的快照不再重复提示（`hasAcked` 抑制），离开该局面后标记自动清除 |
| src/vision/useVision.ts | 状态机扩展 `awaiting-confirm`；新增 `sourceInfo`（捕获窗口名 + displaySurface）；暴露 `ackDecision` |
| src/vision/capture.ts | `sourceInfo` getter（`track.label` + `getSettings().displaySurface`） |
| src/features/assist/VisionControl.vue | 捕获来源摘要（"正在捕获：<窗口名>"）+ 待确认同步卡片（确认同步 / 丢弃按钮） |
| src/App.vue | `pendingVision` 待确认状态：合法走子仍自动应用，**FEN 重载进入待确认**；确认才重载、丢弃则 ack 抑制；手动改盘/切模式清空 pending |
| src/manuals/pgn.ts | **PGN 变例树解析重写**：嵌套括号 → 与 XQF 一致的 `MoveNode` 树；`{...}` 逐着法注释（跨空格/跨行）；变例语义双模式自动判定（标准 RAV 替代式 / 续着式，非法着法则整段跳过不影响主变）；主变用 `mainChild` 链独立追踪 |
| src/features/review/ReviewView.vue | 复盘直接使用变例树（不再拍平）；分支按钮显示**中文着法**；新增注解区（XQF 全局注解 + 当前节点注释） |
| src/engine/analysisCache.ts | **引擎分析缓存**（LRU 64 条）：键 = 规范化 FEN + 有序着法 + depth/movetime + 实际 MultiPV + 排序 excluded；命中直接回调终版结果不重搜 |
| src/engine/useEngine.ts | `engineAnalyze` 接入缓存；仅自然完成的搜索写缓存（被新搜索 stop 的截断结果不缓存）；导出 `clearAnalysisCache` |
| src/components/BoardView.vue | 修复吃子落点提示圈：`r="CELL / 2 - 6"` 漏写了绑定冒号，被当成 SVG 字面量 → 圈根本不渲染 |

### 遇到的问题与解决

1. **PGN 变例语义两难**：标准 RAV 是「替代前一着」（变例首着与被替代步同色同起点），
   但实际棋谱也存在「续着式」（首着是前一着之后的下一着）写法。采样 dpxq/WXF 真实库
   （4 万+ 局）发现均未用括号变例，参考实现 read_pgn.py 也未支持。
   最终实现 `canParse` 合法性探测**双模式自动判定**：先按替代式探测（棋盘回退到被替代步之前），
   失败再按续着式（被替代步之后），都失败则整段跳过——主变永不受损。
2. **变例棋盘状态恢复**：用 `boardAfter` WeakMap 记录每步落子后局面，
   进入变例/退出时精确恢复，解决了嵌套变例与括号后主变续着的解析错位。
3. **缓存污染防护**：worker 内新搜索会 stop 旧搜索（旧 bestmove 提前返回），
   若不区分会把「被截断的浅层结果」当终版缓存 → 用 `searchSeq === id` 判定仅缓存自然完成的结果。
4. **测试期望与结构错位**：初期变例测试按错误的心理模型断言（层级搞反），
   用 tsx 调试脚本 dump 实际树结构后按正确语义重写断言。
5. **吃子提示圈不渲染（全功能 E2E 发现）**：`BoardView.vue` 吃子目标圈写成 `r="CELL / 2 - 6"`
   （漏绑定冒号）→ 浏览器按字面量解析报 `Expected length, "CELL / 2 - 6"`，圈始终不显示。
   改为 `:r="CELL / 2 - 6"` 后实测 `r="44"` 正常渲染。

### 验证

- 单元测试 **85 个全部通过**（规则 19 + XQF 6 + PGN 15 + vision 38 + engine 缓存 7）；
  PGN 新增 6 个变例树用例（嵌套兄弟分支 / 续着式 / 标准 RAV / 注释挂载 / 非法变例跳过 / 根注释）
- vue-tsc + `npm run build` 全绿；`bash scripts/deploy.sh --check --skip-tests` 本地校验通过（产物 34M）
- **浏览器冒烟（Playwright + vite preview）**：导入含变例+注释的 PGN → 分支按钮显示中文
  （"马8进7 / 马2进3"）→ 注解区显示"本步注解：开局完成" → 无控制台错误
  （截图 `w6c_review_variations.png`）
- W6c 人工验证入口已就绪：捕获来源窗口名 + 待确认/丢弃按钮；
  真实 JJ 窗口验证依赖人工操作（真实屏幕捕获无法自动化）
- **全功能浏览器 E2E（四模式）**：对弈走子+AI 应招正常、支招分析出 3 候选（副变+变例行正常）、
  JJ 支招面板 + 识别控件齐备且合规声明在位、复盘变例切换±注解均正常；
  控制台仅剩吃子提示圈 `r` 属性报错一条 → 已修复并复测通过
  （截图 `w6c_full_e2e.png`）

### 遗留 / 待办

- [ ] W6c 真实 JJ 窗口人工验证（用新 UI：确认来源窗口 → 确认/丢弃待同步）
- [ ] 移动端布局、音效、开局库（可选增强）

## 2026-10-04 — 第 3 天（续）：W6 屏幕识别自动同步（W6b 里程碑）

### 背景 / 续接

- W5 已完成 JJ 手动摆棋支招 MVP；W6 拆成：

  - W6a：识别算法层移植（YOLO 后处理 / 棋盘映射 / 多帧跟踪 + 模型入库）
  - W6b：浏览器内真实推理链路 + 主线程自动同步 Game
  - W6c：真实屏幕捕获界面验证（依赖真实 JJ 窗口，留作人工/后续验证项）

- 当前工作区已有 W6a/W6b 代码（vision/ + App 接线 + VisionControl / VisionLab + 部署脚本），本次继续收尾验证。

### 本次变更（收尾 W6b）

- 修正 `worker.ts` 两个轻量收尾点：

  - `dispose` 时释放 ORT session
  - 补齐 `init-error` 的 `stage: 'fetch'` 分支（原有类型已声明，但 fetch 失败走 session 分支，归因不准）

- `VisionControl` 增加自动识别控制入口，接线 `useVision`：

  - 开始捕获 / 停止，错误与不稳定提示
  - 状态机 `idle → loading → capturing → error`

- `App.vue` 接入自动同步：

  - NEW_BOARD / NEW_GAME 识别结果 → `reconcileGame` 应用到当前 Game（优先合法走子保留历史，失败再 FEN 重载）
  - 自动按朝向切我方执红/黑；手动摆棋/悔棋/新局/切模式后重置 tracker，避免旧快照覆盖

- 部署/构建链：

  - `scripts/vision-assets.mjs` 复制 ORT wasm 到 `public/ort/`（postinstall + build 前置）
  - `scripts/deploy.sh` 校验模型与 ORT 资产、单文件 25 MiB 上限
  - `vite.config.ts` 给模型/ORT 配置 PWA runtime cache，且用 extern-wasm 条件避免重复拷贝
  - `.gitignore` 忽略 `public/ort/` 与调试样本 `public/samples/`

### 验证（收尾 W6b）

- 单元测试：67 个全部通过（规则 19 + XQF 5 + PGN 9 + vision 系列；新增 reconcile redGo 与 tracker lastMovedSide 覆盖）
- 黑方视角翻转：JJ 支招切我方执黑后，`将` 从 y≈210 移到 y≈770、`帅` 从 y≈770 移到 y≈210，180° 翻转生效；渲染层翻转不影响内部坐标/点击/箭头（Playwright 实测）
- 构建：`npm run build` 全绿，产物含 `models/xq-yolo-640.onnx`、`ort-wasm-simd-threaded.jsep.wasm`、`pikafish.*`
- `vite preview` 冒烟：主页与 `?visionLab=1` 无页面错误；COOP/COEP 响应头与模型 / ORT / 引擎资产均 200 可访问
- 真实浏览器（Python Playwright + Chrome）VisionLab 推理：模型 `ready (wasm)`，静态样本首次检出 33 个检测框并映射成 `NEW_BOARD`、32 棋子、avg 0.932、STANDARD，随后持续 SAME_BOARD，无页面/控制台错误
- 部署校验：`bash scripts/deploy.sh --check --skip-tests` 全部通过；ORT wasm 20.9MiB，低于 Cloudflare 单文件 25MiB 上限
- 已清理 `.tmp-vision/`（临时 e2e 脚本 + 模型来源 zip）
- 提交：`e7cee72` W6b：屏幕识别真实推理链路 + 自动同步 Game（26 文件，1482 增 / 7 删）
- 截图：`w6_sync_e2e.png`、`w6_visionlab_e2e.png` 已纳入提交

### 遗留 / 待办
- [ ] W6c：真实 JJ 窗口屏幕捕获验证（模型识别/自动同步需要真实窗口人工确认；`?visionLab=1` 用静态样本/样本推理）
- [ ] 自动识别时若 Game 与 JJ 局面不一致，当前 `reconcileGame` 会 FEN 重载并清历史；可后续加“仅手动确认后重载”防误同步
- [ ] 复盘增强：PGN 变例括号嵌套、XQF 注解展示、引擎分析缓存

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

## 2026-10-03 — 第 2 天（续）：部署方式改 Cloudflare Git 集成

- 原 GitHub Actions + API Token 方案改为 **Cloudflare Pages Git 集成**（推送到 GitHub 即自动构建部署，无需 Token/Secret）：
  - 移除 `.github/workflows/deploy.yml`
  - 新增 `.nvmrc`（固定 Node 22，Cloudflare 构建镜像识别）
  - `scripts/deploy.sh` 保留为本地校验（`--check`）+ 手动部署兜底，头注释已更新
  - Cloudflare 面板构建配置：构建命令 `npm ci && npx vitest run && npm run build`，输出目录 `dist`，生产分支 `main`
- 锁文件已验证含 Linux 平台二进制（@rollup/linux-x64、@esbuild/linux-x64），Windows 生成不影响云端构建
- 仓库迁移：项目从 `qwerasdq/project`（main 为另一记账项目）迁至新仓库，本地历史随推（master → main）

## 2026-10-03 — 第 2 天（续）：部署适配 Cloudflare Worker（替代 Pages）

- 实际现状：Cloudflare 2026 已把 Pages 并入 Workers（Pages 维护模式），新建项目走 Worker 静态资源
  → dashboard 创建的是 Worker `xqdk-web`（非 Pages），适配而非回退：
  - 新增 `wrangler.jsonc`：`assets.directory = ./dist` + `not_found_handling: single-page-application`
  - `_headers` 在 Worker 静态资源同样生效（官方文档确认：放静态资源目录即 dist/_headers）
  - `scripts/deploy.sh` 手动部署改为 `npx wrangler deploy`，去掉 pages 专用参数与 CF_PAGES_* 环境变量
- 验证：`wrangler deploy --dry-run` 配置校验通过（13 files in dist）；`--check` 全链路通过
- Workers Builds 面板配置：Build `npm ci && npx vitest run && npm run build`，Deploy `npx wrangler deploy`
- 发现：本机 DNS 对 pages.dev 域直查超时，用 DoH（dns.alidns.com）验证 xqdk-web.pages.dev 为 NXDOMAIN，
  排除网络因素确认项目不在 Pages；worker 地址为 xqdk-web.<子域>.workers.dev

## 2026-10-03 — 第 2 天（收尾）：部署完成

- **线上地址**：https://xqdk-web.2054488343.workers.dev/（Cloudflare Workers 静态资源，Workers Builds 自动构建部署）
- 线上核验（海外节点 + 响应头服务，本机因 workers.dev 被阻断无法直连）：
  - 站点 200 OK（德国×2 / 西班牙节点，~0.1s）
  - COOP/COEP 响应头生效（引擎 SAB 前提）
  - /engine/pikafish.wasm 200 + application/wasm；/engine/pikafish.data 200 + 4,134,154 字节（与本地一致）
- **已知限制**：workers.dev 域名在国内被定向阻断（换真实 CF IP 直连仍超时；Cloudflare 主站可直连，排除部署问题）
  - 决策：暂不绑自定义域名，先用代理访问
  - 缓解：PWA Service Worker 缓存——代理加载一次后，SW 可离线供应应用壳+引擎文件，后续无代理访问理论可行
  - 后续可选：绑定自定义域名（有域名时 10 分钟接入）

### 线上最终验证（用户实测，代理访问）
- ✅ 引擎在真实部署环境加载正常：状态栏「Pikafish 已就绪」，走子后 AI 正常应招
- ✅ **PWA 离线缓存意外解决了国内访问难题**：开代理加载一次（全量文件进 SW 缓存）后，
  关代理刷新页面依然可用——日常使用不再需要代理
  （前提：首次需代理；清浏览器数据/换浏览器需重来；SW 更新检查在无代理时会静默失败，无碍使用）

### 部署链路澄清（版本历史复盘）
- 首次上线实为 **dashboard 手动部署**（22-23 分钟前 ×3，来源"仪表盘"）——解释了仓库尚无 wrangler.jsonc 时站点已能运行
- **Git 自动构建首次验证成功**：push `11340bf`（含 wrangler.jsonc）→ 自动构建（单测+类型检查+构建）→ 自动部署，
  版本历史中该版本关联提交信息、作者 zyl，线上复核 200 / COOP+COEP / 引擎文件 4,134,154 字节全部正常
- 此后标准流程：`git push` → 约 1-2 分钟自动上线，无需任何手动操作

## 2026-10-04 — 第 3 天：JJ 支招 MVP（W5 里程碑）

### 本日交付
| 文件 | 说明 |
|---|---|
| src/features/assist/plans.ts | 应对预案生成：对方回合时引擎先算对方 top3 可能走法（MultiPV），再逐个求我方最佳应手，渐进产出「若对方走X，我方应Y」 |
| src/features/assist/AssistPanel.vue | 支招面板：我方执红/黑切换、回合提示、我方回合复用 AnalysisPanel（候选+PV）、对方回合预案列表（点击选中画我方应手箭头）、合规提示（沿用 Android 版口径） |
| src/App.vue | 新增「JJ 支招」模式：按回合分派（我方→候选分析 / 对方→预案），箭头双态（候选/预案应手） |

### 顺带修复的两个真 bug（W1/W3 遗留）
1. **引擎位置传参错误**：原用「当前 FEN + 全历史着法」构造 position 命令——历史着法在现局面合法时会被重复应用
   （如马往返后再走原路）导致局面错误。Game 新增 `startFen` getter，全部引擎调用改为
   `position fen <起始FEN> moves <历史>`（App.vue / ReviewView.vue / plans.ts）
2. **棋盘方向反了**：BoardView 注释写「红方在下」但 displayY 映射相反，红方实际渲染在上方。
   修正为红方在下（标准视角）；棋盘装饰元素（河界/九宫）对称无需调整，点击热区/箭头/标记随 px() 自动跟随

### e2e 验证（Playwright）
- JJ 支招全流程：合规提示/执红切换/我方候选 3 个（点击出箭头）/对方回合预案 3 条（"若对方走 炮8平5 (h7e7) → 我方应 马二进三 (h0g2)" 等，中文记法与应手均正确）/点预案出应手箭头/切换预案更新/同步对方着法后回到我方候选/切我方执黑后立即转为对方预案视角 ✓
- 方向修复后回归：对弈 AI 应招正常（炮二平五→马2进3）、支招候选/箭头正常 ✓

### 待办
- [ ] W6+：屏幕识别自动同步（getDisplayMedia + onnxruntime-web + YOLO）
- [ ] 可选增强：支招模式按我方视角自动翻转棋盘（我方执黑时黑在下方）
