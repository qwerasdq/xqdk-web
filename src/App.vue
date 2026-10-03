<script setup lang="ts">
// 对弈主界面：棋盘 + 状态栏 + 走子历史 + 悔棋/新局/FEN 摆棋
// W2：人机对弈 v0（用户执红 AI 执黑，终局判定由规则层负责）
// W3：分析/支招模式（MultiPV 3 候选 + 建议箭头 + PV 中文变例）+ random_move 开局多样性
import { computed, onMounted, ref } from 'vue'
import { Game, GameStatus } from './xiangqi/game'
import { Position } from './xiangqi/position'
import { Move } from './xiangqi/move'
import * as Piece from './xiangqi/piece'
import BoardView from './components/BoardView.vue'
import EvalBar from './components/analysis/EvalBar.vue'
import AnalysisPanel from './components/analysis/AnalysisPanel.vue'
import ReviewView from './features/review/ReviewView.vue'
import { ucciToXY } from './xiangqi/pv'
import {
  engineSearch,
  engineAnalyze,
  engineNewGame,
  initEngine,
  setEngineOption,
  useEngine,
} from './engine/useEngine'
import type { AnalysisLine } from './engine/useEngine'

// 难度分档（CLAUDE.md 5.5）：depth 控搜索深度，Skill Level 才是"变弱"旋钮
interface Difficulty {
  label: string
  depth: number
  skill: number
}
const DIFFICULTIES: Difficulty[] = [
  { label: '入门', depth: 6, skill: 8 },
  { label: '初级', depth: 8, skill: 12 },
  { label: '中级', depth: 12, skill: 20 },
  { label: '高级', depth: 16, skill: 20 },
  { label: '大师', depth: 22, skill: 20 },
]
const difficultyIndex = ref(2) // 默认中级
const difficulty = computed(() => DIFFICULTIES[difficultyIndex.value]!)

const { status: engineStatus, engineName, error: engineError } = useEngine()

type Mode = 'game' | 'analyze' | 'review'
const mode = ref<Mode>('game')
// template 判断用 computed（vue-tsc 会对 v-if 字面量比较做流收窄，跨元素传播导致误报）
const isReview = computed(() => mode.value === 'review')
const isAnalyze = computed(() => mode.value === 'analyze')
const isGame = computed(() => mode.value === 'game')
// random_move：前 12 回合从 MultiPV 前 3 候选随机挑着（照抄 Android 版 GameController）
const RANDOM_BEFORE_MAX_ROUNDS = 12
const randomMoveEnabled = ref(true)

const game = ref(new Game())
const boardVersion = ref(0)
const selected = ref<Position | null>(null)
const legalTargets = ref<Position[]>([])
const lastMove = ref<{ from: Position; to: Position } | null>(null)
const status = ref<GameStatus>(GameStatus.MOVE)
const perpetualCheckSide = ref<'red' | 'black' | undefined>(undefined)
const fenInput = ref('')
const aiThinking = ref(false)

// ---- 分析（支招）状态 ----
const analysisLines = ref<AnalysisLine[]>([])
const analyzing = ref(false)
const selectedUcci = ref<string | null>(null)
let analysisSeq = 0 // 分析代次（过期检查）

const engineReady = computed(() => engineStatus.value === 'ready')

const statusText = computed(() => {
  const side = game.value.currentBoard.bRedGo ? '红方' : '黑方'
  switch (status.value) {
    case GameStatus.CHECK:
      return `将军！轮到${side}应着`
    case GameStatus.CHECKMATE:
      return `将死，${side}告负`
    case GameStatus.STALEMATE:
      return `困毙，${side}告负`
    case GameStatus.DRAW:
      return '重复局面，和棋'
    case GameStatus.PERPETUAL_CHECK:
      return `${perpetualCheckSide.value === 'red' ? '红' : '黑'}方长将判负`
    case GameStatus.ILLEGAL:
      return '非法着法'
    default:
      if (mode.value === 'analyze') return analyzing.value ? '分析中…' : '支招模式：轮到' + side + '走子'
      return aiThinking.value ? 'AI 思考中…' : `轮到${side}走子`
  }
})

const moveList = computed(() => {
  const rows: { no: number; red: string; black: string }[] = []
  for (let i = 0; i < game.value.history.length; i += 2) {
    rows.push({
      no: i / 2 + 1,
      red: game.value.history[i]?.chsString ?? '',
      black: game.value.history[i + 1]?.chsString ?? '',
    })
  }
  return rows
})

// 建议箭头（选中的候选首着）
const suggestMove = computed(() => {
  if (!selectedUcci.value) return null
  const xy = ucciToXY(selectedUcci.value)
  if (!xy) return null
  return { from: new Position(xy.fx, xy.fy), to: new Position(xy.tx, xy.ty) }
})

const analysisWinRate = computed(() => {
  const main = analysisLines.value[0]
  return main ? main.winRateRed : 0.5
})

// ---- 引擎 ----

onMounted(() => {
  initEngine()
})

async function onDifficultyChange(): Promise<void> {
  await setEngineOption('Skill Level', difficulty.value.skill)
}

// 分析当前局面：MultiPV 3，流式更新候选（节流 100ms）
async function runAnalysis(): Promise<void> {
  if (!engineReady.value) return
  const g = game.value
  const seq = ++analysisSeq
  analyzing.value = true
  try {
    await engineAnalyze(
      {
        fen: g.currentBoard.toFENString(),
        moves: g.history.map((h) => h.ucciString),
        depth: difficulty.value.depth,
        multipv: 3,
      },
      (lines) => {
        if (seq === analysisSeq) analysisLines.value = lines
      },
    )
  } catch (err) {
    console.error('分析失败:', err)
  } finally {
    if (seq === analysisSeq) analyzing.value = false
  }
}

// AI（黑方）应招：搜索 → 规则层校验（长将/困毙拦截）→ 落子
// random_move：开启且回合 ≤12 时 MultiPV 3 搜索，从候选随机挑着（照抄 Android GameController）
async function requestAiMove(): Promise<void> {
  if (aiThinking.value || game.value.isGameOver || !engineReady.value) return
  aiThinking.value = true
  const g = game.value
  const snapshotRounds = g.history.length // 过期检查快照
  const fen = g.currentBoard.toFENString()
  const moves = g.history.map((h) => h.ucciString)
  const useRandom = randomMoveEnabled.value && g.currentBoard.rounds <= RANDOM_BEFORE_MAX_ROUNDS
  const excluded: string[] = []
  let accepted = false

  try {
    for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
      const collected: AnalysisLine[] = []
      let chosen: string
      if (useRandom) {
        const result = await engineAnalyze(
          { fen, moves, depth: difficulty.value.depth, multipv: 3, excluded },
          (lines) => {
            collected.splice(0, collected.length, ...lines)
          },
        )
        chosen = collected.length > 0
          ? collected[Math.floor(Math.random() * collected.length)]!.pv[0] ?? result.move
          : result.move
      } else {
        chosen = (await engineSearch({ fen, moves, depth: difficulty.value.depth, excluded })).move
      }

      // 搜索期间局面已变（新局/悔棋/用户走子）：丢弃结果
      if (game.value !== g || g.history.length !== snapshotRounds || g.isGameOver) break

      const m = new Move(new Position(0, 0), new Position(0, 0))
      if (!m.fromUCCIString(chosen)) {
        excluded.push(chosen)
        continue
      }
      const state = g.movePiece(m.fromPosition, m.toPosition)
      if (
        state.status === GameStatus.PERPETUAL_CHECK ||
        state.status === GameStatus.STALEMATE ||
        state.status === GameStatus.ILLEGAL
      ) {
        // 规则层拒绝：撤销该着法，排除后重搜
        g.undoMove()
        excluded.push(chosen)
        continue
      }
      accepted = true
      lastMove.value = { from: m.fromPosition, to: m.toPosition }
      status.value = state.status
      perpetualCheckSide.value = state.perpetualCheckSide
      boardVersion.value++
    }
  } catch (err) {
    console.error('AI 搜索失败:', err)
  } finally {
    aiThinking.value = false
  }
}

// ---- 用户交互 ----

function onCellClick(x: number, y: number): void {
  if (game.value.isGameOver || aiThinking.value || !engineReady.value) return
  const g = game.value
  const pos = new Position(x, y)
  const piece = g.currentBoard.getPieceByPosition(pos)

  // 已选中：尝试落子
  if (selected.value && legalTargets.value.some((t) => t.equals(pos))) {
    const state = g.movePiece(selected.value, pos)
    status.value = state.status
    perpetualCheckSide.value = state.perpetualCheckSide
    lastMove.value = { from: selected.value, to: pos }
    selected.value = null
    legalTargets.value = []
    selectedUcci.value = null
    boardVersion.value++
    if (!g.isGameOver) {
      if (mode.value === 'analyze') void runAnalysis() // 支招模式：实时分析
      else if (!g.currentBoard.bRedGo) void requestAiMove() // 对弈模式：AI 应招
    }
    return
  }

  // 选中新棋子（只允许当前行棋方）
  if (Piece.isValid(piece) && Piece.isRed(piece) === g.currentBoard.bRedGo) {
    selected.value = pos
    legalTargets.value = g.selectPosition(pos)
  } else {
    selected.value = null
    legalTargets.value = []
  }
  boardVersion.value++
}

async function newGame(): Promise<void> {
  game.value = new Game()
  selected.value = null
  legalTargets.value = []
  lastMove.value = null
  status.value = GameStatus.MOVE
  aiThinking.value = false
  analysisLines.value = []
  selectedUcci.value = null
  boardVersion.value++
  if (engineReady.value) await engineNewGame()
}

// 对弈模式悔棋撤两步（AI + 用户），分析模式撤一步
function undo(): void {
  const g = game.value
  if (g.history.length === 0 || g.isGameOver) return
  if (mode.value === 'game') {
    const last = g.history[g.history.length - 1]
    if (last && !last.isRedMove) g.undoMove() // 先撤 AI 的黑方着法
    g.undoMove() // 再撤用户的红方着法
  } else {
    g.undoMove()
  }
  selected.value = null
  legalTargets.value = []
  lastMove.value = null
  selectedUcci.value = null
  status.value = GameStatus.MOVE
  boardVersion.value++
  if (mode.value === 'analyze' && !g.isGameOver) void runAnalysis()
}

function loadFEN(): void {
  const fen = fenInput.value.trim()
  if (!fen) return
  const g = new Game()
  if (g.restoreFromFEN(fen)) {
    game.value = g
    selected.value = null
    legalTargets.value = []
    lastMove.value = null
    selectedUcci.value = null
    const s = g.updateGameStatus()
    status.value = s.status
    perpetualCheckSide.value = s.perpetualCheckSide
    boardVersion.value++
    fenInput.value = ''
    if (!g.isGameOver) {
      if (mode.value === 'analyze') void runAnalysis()
      else if (!g.currentBoard.bRedGo) void requestAiMove() // 轮到黑方（AI）时自动应招
    }
  } else {
    alert('FEN 格式不正确')
  }
}

function switchMode(m: Mode): void {
  if (m === mode.value) return
  mode.value = m
  analysisLines.value = []
  selectedUcci.value = null
  boardVersion.value++
  const g = game.value
  if (!g.isGameOver && engineReady.value) {
    if (m === 'analyze') void runAnalysis()
    else if (!g.currentBoard.bRedGo) void requestAiMove()
  }
}
</script>

<template>
  <div class="app">
    <header>
      <h1>象棋迪克 Web</h1>
      <p class="sub">中国象棋 AI 辅助对弈 · 你执红方，AI 执黑</p>
    </header>
    <div class="engine-bar" v-if="!engineReady">
      <span v-if="engineStatus === 'loading'">引擎加载中…（首次约 2 秒）</span>
      <template v-else-if="engineStatus === 'error'">
        <span>引擎加载失败：{{ engineError }}</span>
        <button @click="initEngine">重试</button>
      </template>
    </div>
    <div class="engine-bar ok" v-else>{{ engineName }} 已就绪</div>
    <!-- 模式切换：始终可见（复盘模式下侧栏隐藏，切换入口必须留在外面） -->
    <div class="mode-tabs">
      <button :class="{ active: isGame }" @click="switchMode('game')">对弈</button>
      <button :class="{ active: isAnalyze }" @click="switchMode('analyze')">支招分析</button>
      <button :class="{ active: isReview }" @click="switchMode('review')">复盘</button>
    </div>
    <main class="layout">
      <ReviewView v-if="isReview" class="review-view" />
      <template v-else>
      <BoardView
        :key="boardVersion"
        :board="game.currentBoard"
        :selected="selected"
        :legal-targets="legalTargets"
        :last-move="lastMove"
        :suggest-move="isAnalyze ? suggestMove : null"
        :disabled="!engineReady || aiThinking"
        @cell-click="onCellClick"
      />
      <aside class="panel">
        <div class="status" :class="{ over: game.isGameOver }">{{ statusText }}</div>

        <!-- 分析模式：评分条 + 候选面板 -->
        <div class="analyze-row" v-if="isAnalyze">
          <EvalBar :win-rate-red="analysisWinRate" />
          <AnalysisPanel
            class="grow"
            :fen="game.currentBoard.toFENString()"
            :lines="analysisLines"
            :selected-ucci="selectedUcci"
            :analyzing="analyzing"
            @select="(u) => (selectedUcci = u)"
          />
        </div>

        <div class="controls" v-if="!isReview">
          <label class="diff">
            难度
            <select v-model.number="difficultyIndex" @change="onDifficultyChange">
              <option v-for="(d, i) in DIFFICULTIES" :key="d.label" :value="i">{{ d.label }}</option>
            </select>
          </label>
          <label class="random-toggle" v-if="isGame">
            <input type="checkbox" v-model="randomMoveEnabled" />
            开局多样
          </label>
          <button @click="undo" :disabled="game.history.length === 0 || game.isGameOver || aiThinking">悔棋</button>
          <button @click="newGame" :disabled="aiThinking">新对局</button>
        </div>
        <div class="fen" v-if="!isReview">
          <input v-model="fenInput" placeholder="粘贴 FEN 摆棋（可选）" @keyup.enter="loadFEN" />
          <button @click="loadFEN">摆棋</button>
        </div>
        <table class="moves" v-if="!isReview">
          <thead>
            <tr><th>#</th><th>红方</th><th>黑方</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in moveList" :key="row.no">
              <td>{{ row.no }}</td>
              <td>{{ row.red }}</td>
              <td>{{ row.black }}</td>
            </tr>
          </tbody>
        </table>
      </aside>
      </template>
    </main>
  </div>
</template>

<style scoped>
.app {
  max-width: 1000px;
  margin: 0 auto;
  padding: 16px;
}
header {
  text-align: center;
}
h1 {
  margin: 8px 0 0;
  font-size: 26px;
}
.sub {
  color: #888;
  margin: 4px 0 12px;
  font-size: 13px;
}
.engine-bar {
  text-align: center;
  font-size: 13px;
  color: #666;
  padding: 6px;
  background: #f7f2e7;
  border: 1px solid #ddd;
  border-radius: 8px;
  margin-bottom: 8px;
}
.engine-bar.ok {
  color: #2e7d32;
  background: #eaf5ea;
  border-color: #c8e6c9;
}
.layout {
  display: flex;
  gap: 20px;
  align-items: flex-start;
  flex-wrap: wrap;
  justify-content: center;
}
.layout > :deep(.board-svg) {
  flex: 1 1 480px;
}
.review-view {
  flex: 1 1 100%;
}
.panel {
  flex: 0 1 340px;
  min-width: 300px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mode-tabs {
  display: flex;
  gap: 6px;
  max-width: 520px;
  margin: 0 auto 10px;
}
.mode-tabs button {
  flex: 1;
  padding: 8px;
  border: 1px solid #bbb;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  font-size: 15px;
}
.mode-tabs button.active {
  background: #5a3a1e;
  color: #fff;
  border-color: #5a3a1e;
}
.status {
  font-size: 18px;
  font-weight: bold;
  padding: 10px 12px;
  background: #f7f2e7;
  border: 1px solid #ddd;
  border-radius: 8px;
}
.status.over {
  background: #fdecea;
  border-color: #e74c3c;
  color: #c0392b;
}
.analyze-row {
  display: flex;
  gap: 10px;
  align-items: stretch;
}
.analyze-row :deep(.eval-bar) {
  flex: 0 0 22px;
}
.grow {
  flex: 1;
  min-width: 0;
}
.controls {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.diff {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 14px;
}
.diff select {
  padding: 6px;
  border: 1px solid #bbb;
  border-radius: 6px;
}
.random-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: #666;
  cursor: pointer;
}
button {
  padding: 8px 16px;
  border: 1px solid #bbb;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
}
button:hover:not(:disabled) {
  background: #f0f0f0;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.fen {
  display: flex;
  gap: 6px;
}
.fen input {
  flex: 1;
  padding: 8px;
  border: 1px solid #bbb;
  border-radius: 6px;
  font-size: 12px;
}
.moves {
  border-collapse: collapse;
  font-size: 14px;
}
.moves th,
.moves td {
  border: 1px solid #ddd;
  padding: 4px 10px;
  text-align: center;
}
.moves thead th {
  background: #f7f2e7;
}
.moves tbody {
  display: block;
  max-height: 320px;
  overflow-y: auto;
}
.moves thead,
.moves tbody tr {
  display: table;
  width: 100%;
  table-layout: fixed;
}
</style>
