<script setup lang="ts">
// 复盘视图：导入 XQF/PGN → 步进回放 + 变例分支 + 可选挂引擎分析
import { computed, ref, watch } from 'vue'
import BoardView from '../../components/BoardView.vue'
import EvalBar from '../../components/analysis/EvalBar.vue'
import AnalysisPanel from '../../components/analysis/AnalysisPanel.vue'
import { Board } from '../../xiangqi/board'
import { Position } from '../../xiangqi/position'
import { parseXqf } from '../../manuals/xqf'
import type { MoveNode, XqfManual } from '../../manuals/xqf'
import { parsePgn } from '../../manuals/pgn'
import type { PgnManual } from '../../manuals/pgn'
import { engineAnalyze } from '../../engine/useEngine'
import type { AnalysisLine } from '../../engine/useEngine'
import { ucciToXY } from '../../xiangqi/pv'

interface ReviewManual {
  title: string
  red: string
  black: string
  result: string
  event: string
  initBoard: Board
  root: MoveNode
  totalMoves: number
  /** 全局注解（XQF 第 0 条 / PGN 根注释） */
  globalComment: string | null
}

const manual = ref<ReviewManual | null>(null)
const path = ref<MoveNode[]>([]) // 根 → 当前节点
const loadError = ref('')
const analyzing = ref(false)
const analysisLines = ref<AnalysisLine[]>([])
const selectedUcci = ref<string | null>(null)
const analyzeEnabled = ref(false)
let analysisSeq = 0

const currentNode = computed<MoveNode | null>(() => {
  if (!manual.value) return null
  return path.value.length > 0 ? path.value[path.value.length - 1]! : manual.value.root
})

// 当前局面：从初始局面沿 path 重放
const currentBoard = computed<Board>(() => {
  const m = manual.value
  if (!m) return new Board()
  const b = m.initBoard.clone()
  for (const n of path.value) {
    if (n.move) {
      b.tryMove(n.move.fromPosition, n.move.toPosition)
      b.bRedGo = !b.bRedGo
    }
  }
  return b
})

const lastMove = computed(() => {
  const cur = currentNode.value
  if (cur?.move) {
    return { from: cur.move.fromPosition, to: cur.move.toPosition }
  }
  return null
})

const stepNo = computed(() => path.value.length)
const isAtStart = computed(() => path.value.length === 0)
const isAtEnd = computed(() => {
  const cur = currentNode.value
  return cur == null || cur.nextMoves.length === 0
})

// 变例分支：当前节点的所有下一步（含主变）
const branches = computed(() => currentNode.value?.nextMoves ?? [])
const hasBranches = computed(() => branches.value.length > 1)

const sideToMove = computed(() => (currentBoard.value.bRedGo ? '红方' : '黑方'))

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

// ---- 导入 ----

async function onFileChange(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  loadError.value = ''
  try {
    const buf = new Uint8Array(await file.arrayBuffer())
    if (file.name.toLowerCase().endsWith('.xqf')) {
      const parsed = parseXqf(buf)
      if (!parsed) throw new Error('XQF 解析失败')
      manual.value = fromXqf(parsed, file.name)
    } else {
      const parsed = parsePgn(new TextDecoder('utf-8').decode(buf))
      if (!parsed) throw new Error('PGN 解析失败（着法无法识别）')
      manual.value = fromPgn(parsed, file.name)
    }
    path.value = []
    selectedUcci.value = null
    analysisLines.value = []
  } catch (err) {
    loadError.value = String(err instanceof Error ? err.message : err)
  }
}

function fromXqf(m: XqfManual, filename: string): ReviewManual {
  return {
    title: m.title || filename,
    red: m.red,
    black: m.black,
    result: m.result,
    event: m.event,
    initBoard: m.board.clone(),
    root: m.headMove,
    totalMoves: countNodes(m.headMove),
    globalComment: m.annotation,
  }
}

function fromPgn(m: PgnManual, filename: string): ReviewManual {
  const initBoard = new Board()
  initBoard.restoreFromFEN(m.initFen)
  // 直接使用解析出的变例树（含分支与逐节点注释）
  const headers = m.headers
  return {
    title: headers['event'] || filename,
    red: headers['red'] ?? '',
    black: headers['black'] ?? '',
    result: m.result === '*' ? '未知' : m.result === '1-0' ? '红胜' : m.result === '0-1' ? '黑胜' : '平局',
    event: headers['event'] ?? '',
    initBoard,
    root: m.headMove,
    totalMoves: countNodes(m.headMove),
    globalComment: m.comment,
  }
}

function countNodes(node: MoveNode): number {
  let n = 0
  for (const next of node.nextMoves) if (next.move) n += 1 + countNodes(next)
  return n
}

// ---- 回放控制 ----

function stepForward(): void {
  const cur = currentNode.value
  if (cur && cur.nextMoves.length > 0) {
    path.value = [...path.value, cur.nextMoves[0]!]
    selectedUcci.value = null
  }
}

function stepBack(): void {
  if (path.value.length > 0) {
    path.value = path.value.slice(0, -1)
    selectedUcci.value = null
  }
}

function jumpToStart(): void {
  path.value = []
  selectedUcci.value = null
}

function jumpToEnd(): void {
  const newPath: MoveNode[] = []
  let node: MoveNode | null = manual.value?.root ?? null
  while (node && node.nextMoves.length > 0) {
    newPath.push(node.nextMoves[0]!)
    node = node.nextMoves[0]!
  }
  path.value = newPath
  selectedUcci.value = null
}

function chooseBranch(node: MoveNode): void {
  const idx = branches.value.indexOf(node)
  if (idx < 0) return
  const newPath = [...path.value.slice(0, -1), node]
  path.value = newPath
  selectedUcci.value = null
}

/** 分支按钮文本：PGN 用原文中文，XQF 现算（当前局面即分支起点） */
function branchLabel(n: MoveNode): string {
  if (n.chs) return n.chs
  if (!n.move) return '?'
  const chs = n.move.getChsString(currentBoard.value)
  return chs || n.move.getUCCIString()
}

/** 当前节点注解（根节点注释与全局注解相同时不重复显示） */
const nodeComment = computed(() => {
  const cur = currentNode.value
  if (!cur || !cur.comment) return null
  if (cur === manual.value?.root && cur.comment === manual.value.globalComment) return null
  return cur.comment
})

// ---- 挂引擎分析 ----

async function runReviewAnalysis(): Promise<void> {
  if (!analyzeEnabled.value || !manual.value) return
  const m = manual.value
  const seq = ++analysisSeq
  analyzing.value = true
  const moves = path.value.map((n) => n.move?.getUCCIString() ?? '')
  try {
    await engineAnalyze(
      // 起始局面 + 路径着法（position fen <起始> moves <...>）；
      // 不可用「当前局面 + 全路径」——着法在现局面合法时会被重复应用
      { fen: m.initBoard.toFENString(), moves, depth: 16, multipv: 3 },
      (lines) => {
        if (seq === analysisSeq) analysisLines.value = lines
      },
    )
  } catch (err) {
    console.error('复盘分析失败:', err)
  } finally {
    if (seq === analysisSeq) analyzing.value = false
  }
}

// 步进/开关/导入时触发分析
watch([currentBoard, analyzeEnabled], () => {
  if (analyzeEnabled.value) void runReviewAnalysis()
})
</script>

<template>
  <div class="review">
    <div class="review-toolbar">
      <label class="import-btn">
        导入棋谱（XQF/PGN）
        <input type="file" accept=".xqf,.pgn,.txt" style="display: none" @change="onFileChange" />
      </label>
      <span class="err" v-if="loadError">{{ loadError }}</span>
      <label class="analyze-toggle">
        <input type="checkbox" v-model="analyzeEnabled" />
        挂引擎分析
      </label>
    </div>

    <div v-if="manual" class="review-info">
      <span class="title">{{ manual.title }}</span>
      <span v-if="manual.red || manual.black">红 {{ manual.red || '?' }} — 黑 {{ manual.black || '?' }}</span>
      <span>结果：{{ manual.result }}</span>
      <span>共 {{ manual.totalMoves }} 着</span>
      <span>第 {{ stepNo }} 步 / 轮到{{ sideToMove }}</span>
    </div>

    <div v-if="manual" class="review-main">
      <BoardView
        :board="currentBoard"
        :selected="null"
        :legal-targets="[]"
        :last-move="lastMove"
        :suggest-move="suggestMove"
        :disabled="true"
        @cell-click="() => {}"
      />
      <aside class="review-side">
        <div class="nav">
          <button @click="jumpToStart" :disabled="isAtStart">⏮</button>
          <button @click="stepBack" :disabled="isAtStart">◀</button>
          <button @click="stepForward" :disabled="isAtEnd">▶</button>
          <button @click="jumpToEnd" :disabled="isAtEnd">⏭</button>
        </div>

        <!-- 变例分支 -->
        <div class="branches" v-if="hasBranches">
          <div class="branches-label">变例分支：</div>
          <button
            v-for="(b, i) in branches"
            :key="i"
            class="branch"
            :class="{ active: path[path.length - 1] === b }"
            @click="chooseBranch(b)"
          >
            {{ branchLabel(b) }}
          </button>
        </div>

        <!-- 注解区：全局注解 + 当前节点注释 -->
        <div class="annotation" v-if="manual.globalComment || nodeComment">
          <div class="annotation-row" v-if="manual.globalComment">
            <span class="annotation-label">全局注解</span>
            <span class="annotation-text">{{ manual.globalComment }}</span>
          </div>
          <div class="annotation-row" v-if="nodeComment">
            <span class="annotation-label">本步注解</span>
            <span class="annotation-text">{{ nodeComment }}</span>
          </div>
        </div>

        <!-- 挂引擎分析面板 -->
        <div class="analyze-row" v-if="analyzeEnabled">
          <EvalBar :win-rate-red="analysisWinRate" />
          <AnalysisPanel
            class="grow"
            :fen="currentBoard.toFENString()"
            :lines="analysisLines"
            :selected-ucci="selectedUcci"
            :analyzing="analyzing"
            @select="(u) => (selectedUcci = u)"
          />
        </div>
      </aside>
    </div>
    <div v-else class="review-empty">导入 XQF 或 PGN 棋谱开始复盘</div>
  </div>
</template>

<style scoped>
.review {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.review-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}
.import-btn {
  padding: 8px 14px;
  border: 1px solid #5a3a1e;
  border-radius: 6px;
  background: #5a3a1e;
  color: #fff;
  cursor: pointer;
  font-size: 14px;
}
.import-btn:hover {
  background: #6d4a26;
}
.err {
  color: #c0392b;
  font-size: 13px;
}
.analyze-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: #666;
  cursor: pointer;
}
.review-info {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  align-items: center;
  padding: 8px 12px;
  background: #f7f2e7;
  border: 1px solid #ddd;
  border-radius: 8px;
  font-size: 13px;
}
.review-info .title {
  font-weight: bold;
  font-size: 15px;
}
.review-main {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  flex-wrap: wrap;
  justify-content: center;
}
.review-main > :deep(.board-svg) {
  flex: 1 1 420px;
  max-width: 520px;
}
.review-side {
  flex: 0 1 320px;
  min-width: 280px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.nav {
  display: flex;
  gap: 6px;
}
.nav button {
  flex: 1;
  padding: 8px;
  font-size: 16px;
  border: 1px solid #bbb;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
}
.nav button:hover:not(:disabled) {
  background: #f0f0f0;
}
.nav button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.branches {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 8px;
  background: #fdf6ec;
  border: 1px solid #e8d5b8;
  border-radius: 6px;
}
.branches-label {
  font-size: 13px;
  color: #8a6d3b;
}
.branch {
  font-size: 12px;
  padding: 4px 8px;
  border: 1px solid #c9a86a;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
}
.branch.active {
  background: #5a3a1e;
  color: #fff;
}
.annotation {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  background: #f2f7f2;
  border: 1px solid #cfe3cf;
  border-radius: 6px;
  font-size: 13px;
}
.annotation-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.annotation-label {
  flex: 0 0 auto;
  color: #4a7a4a;
  font-weight: bold;
}
.annotation-text {
  white-space: pre-wrap;
  word-break: break-word;
  color: #333;
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
.review-empty {
  padding: 60px;
  text-align: center;
  color: #999;
  font-size: 15px;
}
</style>
