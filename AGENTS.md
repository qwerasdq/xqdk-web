# Web端中国象棋AI辅助对弈应用开发方案（v2.0）

> 本文件与 CLAUDE.md 同步维护：两份内容必须保持一致，改任意一份时请同步另一份。

> 修订说明：本版在 1.0 基础上做了四类修改——①新增「JJ 象棋平台实时支招」场景；②删除不必要/不可核实的内容（自编译 WASM 流程、存疑 npm 包）；③落实技术选型（Vue 3 + TypeScript、纯前端 Pikafish WASM）；④全面复用 Android 版（D:\chess-dike）的棋规层、引擎交互模板、XQF 解析器与识别链路。调研结论均经过在线核实。

---

## 1. 项目目标

开发一个 Web 端中国象棋 AI 辅助对弈应用，浏览器直接打开即可用，四个核心场景：

1. **人机对弈**：用户与 AI 对弈，AI 作为对手或队友，难度可调
2. **AI 支招分析**：用户摆棋/走子，AI 实时给出评分、胜率、候选着法与主要变例
3. **复盘拆棋**：导入 XQF/PGN 棋谱，逐步回放并挂载 AI 分析
4. **JJ 象棋平台实时支招**：在 JJ 象棋下棋时，同步局面到本应用，AI 实时给建议（仅辅助学习，排位赛禁用，见附录 B）

## 2. 需求分析

| 需求 | 说明 |
|---|---|
| 棋盘交互 | 点击/拖拽走子，合法走法高亮，动画反馈 |
| AI 引擎 | 棋力达到业余高手以上（Pikafish NNUE，全国冠军水平），支持难度调节 |
| 实时分析 | 显示评分、胜率、候选着法（MultiPV）、主要变例 |
| 规则完整 | 将帅照面、应将、困毙判负、长将判负、重复局面判和——**由 Web 规则层实现**（引擎的规则选项作双保险，见 5.6） |
| 棋谱导入 | XQF/PGN 解析、回放、变例分支、每步挂引擎分析 |
| JJ 平台局面同步 | MVP 手动摆棋同步；Phase 2 屏幕识别自动同步（见 5.7） |
| 跨平台 | 浏览器直接打开，无需安装；PWA 离线对弈 |
| 加载体验 | NNUE 权重约 45MB 懒加载 + 进度条，应用壳秒开 |

## 3. 技术选型

### 3.1 AI 引擎：官方预编译 Pikafish WASM

Pikafish（皮卡鱼）是当前最强开源中国象棋引擎，基于 NNUE 神经网络。**官方已提供预编译的 WebAssembly 产物，无需自行编译**：

- 引擎 WASM：`official-pikafish/Pikafish` GitHub Releases（发布说明明确包含 WebAssembly target）：`pikafish.js` + `pikafish.wasm`
- NNUE 权重（约 45MB）：`official-pikafish/Networks` GitHub Releases 的 `pikafish.nnue`
- 本地已有同款权重可用作校验基准：`D:\chess-dike\app\src\main\pikafish\arm64-v8a\libpikafish.nnue.so`（45,508,991 字节，实为权重数据文件，与 WASM 版 `pikafish.nnue` 内容同源）

**权重加载策略**：

1. 应用壳即时渲染，引擎/权重**懒加载**：进入对弈/分析页才下载，`fetch` + `ReadableStream` 显示真实进度条
2. `pikafish.wasm` 用 `WebAssembly.instantiateStreaming` 流式编译；权重写入 Emscripten 虚拟文件系统后 `setoption name EvalFile value pikafish.nnue`
3. 三层缓存：HTTP 缓存（版本化 URL）→ Service Worker runtime cache（Cache API）→ 可选 OPFS 持久化
4. 权重**不进 git 仓库**（部署时放静态目录，或用 CI 从官方 Releases 拉取，附 SHA 校验）
5. 内存与线程：NNUE 常驻后引擎约占 90-128MB；浏览器多线程需 SharedArrayBuffer（COOP/COEP 响应头），GitHub Pages 无法自定义响应头 → **MVP 用 Threads=1、Hash 32-64MB**，进阶迁 Cloudflare Pages（见第 7 节）

### 3.2 规则层与棋盘渲染

**规则层：移植 Android 版 gamelogic 到 TypeScript，并补全长将/重复/困毙判定。不用现成 npm 棋规库。**

移植源（`D:\chess-dike\app\src\main\java\com\xqdk\chess\gamelogic\`）：

| 源文件 | 内容 | TS 目标 |
|---|---|---|
| `Rule.java` | 走法生成、蹩马腿/塞象眼、将军/将死/飞将检测（664 行纯逻辑） | `xiangqi/rule.ts` |
| `Move.java` | UCCI 互转 + `getChsString()` 完整中文记谱（含前中后消歧、兵卒特例） | `xiangqi/move.ts` + `xiangqi/notation.ts` |
| `Board.java` | FEN 解析/生成（xqbase 格式，红方大写黑方小写） | `xiangqi/board.ts` |
| `Piece.java` | 棋子常量表 | `xiangqi/piece.ts` |
| `Zobrist.java` | 局面哈希（87KB 常量表，从华弈 2022 开局库提取） | `xiangqi/zobrist.ts` |
| `Game.java` | 对局状态 | `xiangqi/game.ts` |

这些文件是纯 Java 逻辑（仅依赖 `android.util.Log`），可逐行直译 TS，行为与 Android 版完全一致。

**移植时必须补齐的两块（Android 版缺失，现依赖引擎内部规则）**：

1. **重复局面/长将判定**：用 `Board.getZobrist(redGo)` 局面键对历史局面计数——同一局面第 3 次出现判和（亚洲规则）；连续将帅对方且构成重复的长将判负
2. **困毙判定**：对方无合法着法且未被将军 → 困毙判负（象棋规则困毙判负，与国象不同；`Rule.isJiangShuaiDead()` 可改出"无子可动"变体）

为什么不选现成库：`zh-chess`（kongyijilafumi/zh-chess，npm 3.2.1）经核实真实存在，有 `generateLegalMoves`/`isLegalMove`，但约 20 stars 小众维护、**无长将/重复/困毙判定**——用了仍需自己补，且要额外适配 FEN/记谱约定；`@nmng108/xiangqiboardjs` 是 jQuery 库，不适配 Vue 3。1.0 方案中的 "ChessCanvas"、"Xiangqi(npm)" 无法核实存在，已删除。

**渲染：自绘 SVG 棋盘组件，不引第三方棋盘库。** 棋盘是 9×10 网格 + 河界 + 九宫斜线（约 20 条 path/line），自绘成本极低；SVG 天然支持点击/拖拽/合法着法高亮/建议箭头/动画，与规则层数据结构（`piece[y][x]`）直接绑定。棋子样式可参考 `D:\chess-dike\app\src\main\res` 中的棋盘/棋子美术资产。

### 3.3 通信架构：Web Worker + UCI

引擎计算必须放在 Web Worker，避免阻塞主线程：

```
主线程（Vue UI）  ←→  EngineWorker（Web Worker）  ←→  Pikafish WASM
     ↑                                                ↓
 SVG 棋盘渲染 / 分析面板                           UCI 指令/输出
```

与 1.0 的差异：不再用字符串透传，改用 **typed 判别联合消息协议**；Worker 内维护单引擎请求队列（新请求到来时 `stop` 旧搜索，照抄 `AnalysisEngine.kt` 的 pendingFen/stop 模式）；用 Vite 模块 Worker 语法创建。

**UCI 命令序列**（与 Android 版完全一致，模板见 `D:\chess-dike\app\src\main\java\com\xqdk\chess\assist\AnalysisEngine.kt`）：

```
uci → uciok
setoption name EvalFile value pikafish.nnue
setoption name Hash value 64
setoption name Threads value 1
setoption name MultiPV value 3          # 支招时；对弈搜索用 1
setoption name UCI_ShowWDL value true   # 启用引擎原生胜率
ucinewgame → isready → readyok
position fen <fen> [moves <ucci...>]
go depth 20        # 或 go movetime 3000 / go infinite（闪电出着）
# info depth 20 seldepth ... multipv 1 score cp 25 wdl 512 345 143 pv h2e2 ...
# bestmove h2e2 [ponder h9g7]
stop → bestmove（闪电出着）
```

**评分视角换算**：引擎 `info` 的 score 是**走子方视角**，UI 统一显示红方视角需按 FEN 的 side-to-move 翻转（逻辑照抄 `AnalysisModels.kt`：side 为黑时 cp 取反、mate 符号翻转）；胜率优先用引擎 `wdl` 字段（开启 `UCI_ShowWDL` 后 info 行自带，无需 cp 启发式换算）。

### 3.4 Vue 3 + TypeScript 工程结构

Vite + Vue 3 + TypeScript + Composition API + Pinia + Vue Router：

```
src/
  engine/          UCI 协议层：握手状态机、info/bestmove 解析、评分换算、
                   EngineWorker（new Worker(new URL('./worker.ts', import.meta.url), {type:'module'})）、
                   单引擎请求队列
  xiangqi/         规则层（3.2 移植产物）：board/piece/rule/move/notation/zobrist/repetition
  components/
    board/         BoardView.vue（SVG 棋盘）、棋子、箭头/高亮/走子动画
    analysis/      EvalBar、分析面板、候选着法列表、变例行
  features/
    game/          人机对弈
    analyze/       支招分析
    review/        复盘拆棋
    assist/        JJ 连线支招（Phase 2）
  manuals/         XQF/PGN 解析器（纯 TS）
  vision/          Phase 2：onnxruntime-web + YOLO 检测与棋盘映射
```

## 4. 三种实现方案对比

| 方案 | 技术栈 | 优点 | 缺点 | 推荐度 |
|---|---|---|---|---|
| 纯前端开箱即用 | 现有开源项目（如 shibing624/chinese-chess-ai） | 部署简单，零配置 | AI 棋力有限，定制性差 | ⭐⭐⭐ |
| 集成 Pikafish WASM | 官方预编译 WASM + Web Worker + 自绘 SVG + 自研规则层 | 棋力最强，完全本地，隐私好，零服务器 | 权重 45MB 首次加载较慢（进度条+缓存缓解） | ⭐⭐⭐⭐⭐ |
| 服务端引擎 | Node.js/Go + WebSocket + Pikafish | 前端轻量，引擎可复用 | 需服务器，有延迟，成本高 | ⭐⭐ |

**选定方案：纯前端 Pikafish WASM**，兼顾棋力、隐私和部署成本。

## 5. 开发步骤

### 5.1 获取引擎与权重

从官方 Releases 下载（不自编译）：

- `official-pikafish/Pikafish` Releases → `pikafish.js`、`pikafish.wasm`
- `official-pikafish/Networks` Releases → `pikafish.nnue`（约 45MB）

放入 `public/engine/`（不进 git），记录 SHA 校验。UCI 协议与选项清单参考 `D:\chess-dike\一些资料\pikafish相关的资料.md`。

### 5.2 封装 EngineWorker（TS 骨架）

```typescript
// src/engine/worker.ts —— Worker 侧
import PikafishFactory from '../../public/engine/pikafish.js';

type InMsg =
  | { type: 'init'; nnueUrl: string }
  | { type: 'uci'; cmd: string };          // 'position ...' / 'go ...' / 'stop'

let uciSend: (cmd: string) => void;

self.onmessage = async (e: MessageEvent<InMsg>) => {
  if (e.data.type === 'init') {
    const Pikafish = await PikafishFactory();
    const resp = await fetch(e.data.nnueUrl);           // 进度条由主线程负责
    Pikafish.FS.writeFile('/pikafish.nnue', new Uint8Array(await resp.arrayBuffer()));
    uciSend = (cmd) => Pikafish.callMain(cmd);          // pikafish.js 胶水接口
    uciSend('uci');
  } else {
    uciSend(e.data.cmd);
  }
};
// 引擎 stdout 行回调 → 解析后 postMessage typed 消息回主线程
```

主线程初始化（Vue composable `useEngine`）：

```typescript
// src/engine/useEngine.ts —— 主线程侧
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
worker.postMessage({ type: 'init', nnueUrl: '/engine/pikafish.nnue' });

worker.onmessage = (e) => {
  if (e.data.type === 'info') {
    // depth/seldepth/multipv/score(cp|mate)/wdl/pv —— 换算红方视角后更新 Pinia
  } else if (e.data.type === 'bestmove') {
    const move = e.data.move;               // 如 'h2e2'（UCCI，a0-i9）
    executeMove(move);
  }
};
```

### 5.3 初始化棋盘

SVG 棋盘组件绑定规则层数据：`new Game(fen)` → 渲染 → 用户走子 → `game.makeMove(ucci)` → 生成新 FEN → 发引擎分析。走子合法性与将军/将死/困毙全部由规则层判定，不依赖引擎。

### 5.4 对弈流程

1. 用户点击棋子，规则层生成合法走法并高亮
2. 用户走子，更新棋盘，生成 FEN
3. 发送 `position fen <FEN>` 和 `go depth N` 到 Worker
4. 接收 `bestmove h2e2`，在棋盘上执行 AI 走子动画
5. 规则层检查终局条件（将死/困毙/长将判负/重复判和）

### 5.5 棋力控制

| 难度 | go 命令 | Skill Level | 说明 |
|---|---|---|---|
| 入门 | `go depth 6` | 8 | 引擎主动出昏招 |
| 初级 | `go depth 8` | 12 | |
| 中级 | `go depth 12` | 20（默认） | + random_move 开局多样性 |
| 高级 | `go depth 16` | 20 | |
| 大师 | `go depth 22-24` | 20 | 可选 go infinite + 闪电出着 |

- `random_move`：前 12 回合从 MultiPV 前 3 候选随机挑着（照抄 Android 版 `GameController` 的 `random_before_max_rounds=12` 策略），保证开局多样性
- 可选精确分档：`setoption name UCI_LimitStrength value true` + `UCI_Elo 1280-3133`
- **关键提醒**：NNUE 全强配置下低深度棋力依然很高，`Skill Level` 才是真正"变弱"的旋钮
- 所有引擎着法落子前由规则层强制校验（困毙/长将过滤，见 5.6）

### 5.6 特殊规则处理

**规则层内置判定（主）+ 引擎规则选项（双保险）**：

- **重复局面判和**：Zobrist 局面键计数，同一局面第 3 次出现判和
- **长将判负**：一方连续将军且局面循环重复 → 判负；引擎建议着法触发长将时，规则层拒绝该着法并要求引擎排除重搜（`position fen <fen> moves <excluded>` + 重新 `go`）
- **困毙判负**：对方无合法着法且未被将军 → 判负；引擎估值常把对方无子可动视为优势，必须由规则层强制纠正
- 双保险：`setoption name Repetition Rule value AsianRule`（默认即 AsianRule）与 `Draw Rule` 选项（引擎 UCI option 清单见 `PikafishExternalEngine.java` 注释）

### 5.7 JJ 象棋平台实时支招

**MVP（手动摆棋）**：用户在与 JJ 平台对局的棋盘上落子后，在本应用棋盘上点选同步同一着法 → 引擎实时分析 → 显示建议箭头 + 3 个候选着法按钮 + 预测后续 4 步中文着法（"炮二平五 (h2e2)"格式，复用 `MoveChinese.kt` 的 describe 模式）。与场景②支招分析同构，增量成本极小、零平台风险。

**Phase 2（屏幕识别自动同步）**：

1. `getDisplayMedia` 捕获 JJ 象棋窗口/标签页（每次会话需用户授权）
2. canvas 抽帧 → `onnxruntime-web/wasm`（WASM SIMD+threads EP，Worker 内运行）加载 YOLOv5 模型
   （**不用 WebGPU EP**：ORT 1.22 下设备丢失后 `run()` 永久挂起且同 realm 无法重建，恢复只能换 worker；
   识别按 ~800ms/帧节流、实测 WASM 推理 p50 83ms，余量充足。详见 DEVLOG W6e）
3. 模型来源：`D:\chess-dike\app\src\main\assets\yolov5n_xq_fp16.tflite` 转 ONNX（tflite2onnx 工具）
4. 棋盘映射逻辑直译 `DetectionBoardMapper.kt`（棋盘框锚点网格映射 / 双王位置判定朝向 / 越界丢弃）
5. YOLO 后处理（NMS）照抄 `YoloPostprocessor.kt`；多帧稳定确认后才更新局面
6. 识别结果经 `AssistBoard` 硬合法性校验（拒绝非法棋盘状态），自动进入支招流程

### 5.8 复盘拆棋：XQF/PGN 解析

**均纯 TS 实现，不走 WASM。**

- **XQF**（优先，Android 存量资产）：头部定长偏移结构用 `DataView` 按偏移读取；v10+ 解密（`XQFKey`：keyXY/keyXYf/keyXYt/keyRMKSize/F32Keys）为纯字节运算，直译 `XQFParser.java`/`XQFKey.java`；GB18030 文本用浏览器原生 `TextDecoder('gb18030')`；着法记录与变例树结构照搬 `XQFManual.java`。格式文档：`D:\chess-dike\棋谱\XQF文件格式说明.TXT`
- **PGN**：棋谱库（`D:\chess-dike\棋谱\pgns\` 内 WXF/dpxq 库）movetext 为中文纵线记谱（"炮二平三 马2进3"），参考 `XQFParser\cchess\read_pgn.py` 写 TS 解析；需实现"中文着法 → UCCI"逆解析器（`Move.getChsString()` 的逆函数，前中后消歧按 xqbase 规范）
- 回放 UI：步进/快进/变例分支选择 + 每步可选挂引擎分析

## 6. 关键代码示例（TS 骨架）

### 6.1 Worker 中解析引擎输出

```typescript
// info 行正则解析（与 Android 版 parseInfoCmd 同口径）
const INFO_RE = /depth (\d+).*?seldepth (\d+).*?multipv (\d+).*?score (cp|mate) (-?\d+)(?:.*?wdl (\d+) (\d+) (\d+))?.*?pv (.+)?$/;

// 红方视角换算（照抄 AnalysisModels.kt）
function toRedScore(scoreCp: number, fenSideToMove: string): number {
  return fenSideToMove === 'b' ? -scoreCp : scoreCp;   // 引擎 score 是走子方视角
}
```

### 6.2 UCCI 坐标与中文记谱

坐标约定（必须与 xqbase/Android 版一致）：UCCI 着法 4 字母 `h2e2`（列 a-i，行 0-9，a0 为左下）；棋盘内部 `piece[y][x]`，y=0 黑方底线。**中文记谱以直译 `Move.java` 的 `getChsString()` 为准**（红方中文数字从右往左数、黑方阿拉伯数字从左往右数，进退平移规则，同列同子前/中/后消歧，多兵五子编号），1.0 版的示意代码已废弃。

## 7. 部署与优化

- **MVP：GitHub Pages 静态托管**。单文件 100MB 上限，45MB 权重可直接托管；无自定义响应头 → 引擎单线程（Threads=1）。权重不入 git，用 GitHub Actions 从官方 Releases 拉取
- **进阶：Cloudflare Pages + R2**。可配 `_headers` 支持 COOP/COEP 启用多线程 WASM；但单文件 25MiB 上限，权重必须放 R2 或运行时从 GitHub Releases fetch
- **PWA 离线**：vite-plugin-pwa（Workbox）——precache 应用壳（带 hash 的 js/css/html）；wasm + NNUE 走 runtime cache（Cache API），**不放入 precache**（避免首启双倍下载）；权重用版本化 URL 做更新
- **性能**：Worker 中优先 `go movetime` 而非固定深度，避免长考卡顿；分析面板节流更新（照抄 Android 版 100ms GUI 节流）

## 8. 参考项目

| 项目 | 说明 |
|---|---|
| official-pikafish/Pikafish | 引擎源码 + 预编译 WASM Releases |
| official-pikafish/Networks | NNUE 权重官方发布 |
| tsonglew/chess-cn | 3D 象棋（Three.js），社区版整合了 WASM 引擎 + Pikafish 服务端 + 联机 |
| shibing624/chinese-chess-ai | 纯前端单文件，Minimax+Alpha-Beta，开箱即用 |
| TaylorPzreal/chinese-chess | React 19 + TypeScript + Konva，三档难度 |
| walker8088/cchess | Python 棋谱解析器（XQF/PGN/TXT/CBF/CBR 多格式），本仓库 `XQFParser/` 即其副本 |
| zh-chess | npm 棋规框架（调研过，因缺长将/重复/困毙未采用） |
| onnxruntime-web | Phase 2 屏幕识别推理运行时 |
| VinXiangQi | YOLO 棋盘识别权重来源（Android 版 tflite 模型同源） |

## 9. 注意事项

- **合规使用**：本工具仅用于本地对弈、复盘分析、辅助学习。**严禁在在线排位赛中使用**（含 JJ 平台支招功能），否则可能封号（见附录 B）
- **困毙判负**：引擎估值常把对方无子可动视为优势，但象棋规则是困毙判负，必须由规则层强制校验
- **长将处理**：AI 劣势时可能长将，规则判负体验差，需在棋力控制层拦截
- **内存管理**：WASM + NNUE 权重约 90-128MB；移动端浏览器注意内存，分阶段加载
- **线程限制**：多线程 WASM 需 SharedArrayBuffer（COOP/COEP 响应头），GitHub Pages 不支持 → MVP 单线程；Threads=1 下中高级棋力依然可用
- **浏览器兼容**：WebAssembly/Web Worker 现代浏览器均支持；iOS Safari 对 PWA 和后台 Worker 有限制
- **首次加载**：NNUE 权重 45MB，必须显示加载进度；提供轻量版（无 NNUE）可作快速体验入口
- **屏幕捕获授权**：getDisplayMedia 每次会话需用户手动授权，页面必须前置说明用途

## 10. MVP 路线（6 周）

| 周 | 内容 | 依赖 | 验收标准 |
|---|---|---|---|
| W1 | Vite + Vue3 + TS 脚手架；规则层 TS 移植（Board/Piece/Move/Rule/Game/Zobrist）+ 补长将/重复/困毙 + 单元测试；SVG 棋盘组件（点击/拖拽/合法高亮/FEN 摆棋） | 无 | 规则层测试通过；棋盘可摆任意 FEN 并走子、显示中文记谱 |
| W2 | EngineWorker + UCI 桥（握手/options/info/bestmove 解析/评分换算）；官方 WASM + NNUE 加载与进度条；人机对弈 v0 | W1 | 完整对局可下：引擎应招、终局判定（将死/困毙/重复）正确 |
| W3 | 难度分档（5.5）；分析面板（评分/胜率 WDL/候选着法 MultiPV 3/PV 中文着法/EvalBar）；支招模式（箭头 + 3 候选按钮 + 预测后 4 步） | W2 | 支招模式与 Android 版功能对齐 |
| W4 | 复盘模块：XQF 解析（TS）+ PGN 解析（中文记谱）+ 回放 UI（变例树/步进/挂引擎分析）；PWA（SW 缓存）；部署 GitHub Pages | W1、W3 | 可导入 `D:\chess-dike\棋谱\` 样例文件回放分析；断网可离线对弈 |
| W5 | JJ 支招 MVP（手动摆棋同步 + 实时分析 + 对方回合"若对方走 X 我方应 Y"预案）；合规声明与界面提示 | W2、W3 | 双屏对照手动同步 JJ 对局可流畅支招 |
| W6+ | Phase 2：屏幕识别（getDisplayMedia + onnxruntime-web + YOLO ONNX 转换 + 映射移植 + 多帧确认）；可选多线程（Cloudflare Pages）；移动端布局、音效、开局库 | W5 | 自动识别 JJ 棋盘并持续支招 |

## 附录 A：Android 版资产 → Web 模块映射

| Android 源（D:\chess-dike） | Web 目标 | 复用方式 |
|---|---|---|
| `gamelogic/Rule.java` | `xiangqi/rule.ts` | 直译 + 补困毙判定变体 |
| `gamelogic/Move.java` | `xiangqi/move.ts`、`xiangqi/notation.ts` | 直译（UCCI 互转 + 中文记谱） |
| `gamelogic/Board.java` | `xiangqi/board.ts` | 直译（FEN 解析/生成） |
| `gamelogic/Piece.java` | `xiangqi/piece.ts` | 直译（常量表） |
| `gamelogic/Zobrist.java` | `xiangqi/zobrist.ts` | 直译（87KB 哈希表）+ 重复局面检测 |
| `assist/AnalysisEngine.kt` | `engine/EngineClient.ts` | 引擎握手/搜索循环/stop 重搜/info 解析模板 |
| `assist/AnalysisModels.kt` | `engine/analysisModels.ts` | 红方视角评分换算 |
| `assist/AssistBoard.kt` | `xiangqi/assistBoard.ts` | FEN↔棋盘、applyUcci、硬合法性校验 |
| `assist/MoveChinese.kt` | `xiangqi/moveChinese.ts` | UCCI→"炮二平五 (h2e2)" 描述 |
| `manuals/XQFParser.java` + `XQFKey.java` + `XQFManual.java` | `manuals/xqf.ts` | XQF 解密/解析直译 |
| `assist/DetectionBoardMapper.kt` | `vision/boardMapper.ts` | Phase 2 屏幕棋盘映射 |
| `assist/YoloPostprocessor.kt` | `vision/postprocess.ts` | Phase 2 YOLO 后处理 |
| `assets/yolov5n_xq_fp16.tflite` | ONNX 转换产物 | Phase 2 识别模型 |
| `pikafish/arm64-v8a/libpikafish.nnue.so` | `pikafish.nnue` 校验基准 | 权重同源校验 |
| `res/drawable/*.png` | SVG 棋子样式参考 | 美术资产 |
| `棋谱/` 格式文档与样本 | 测试夹具 | 解析器测试数据 |



文档版本：2.0
适用场景：Web 端中国象棋 AI 对弈/分析工具开发
推荐技术栈：Pikafish 官方 WASM + Web Worker + Vue 3 + TypeScript + 自研规则层（移植自 chess-dike）+ PWA
