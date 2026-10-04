<script setup lang="ts">
// SVG 棋盘组件：9×10 网格 + 河界 + 九宫斜线 + 棋子 + 选中/落点/最近着法标记
// 默认视角：红方在下（y=9 显示在底部）
import { computed } from 'vue'
import type { Board } from '../xiangqi/board'
import type { Position } from '../xiangqi/position'
import { getNameByValue, isRed } from '../xiangqi/piece'

const props = defineProps<{
  board: Board
  selected: Position | null
  legalTargets: Position[]
  lastMove: { from: Position; to: Position } | null
  /** 建议着法（支招箭头），from → to */
  suggestMove?: { from: Position; to: Position } | null
  disabled?: boolean
}>()

const emit = defineEmits<{ (e: 'cell-click', x: number, y: number): void }>()

function onClickCell(x: number, y: number): void {
  if (props.disabled) return
  emit('cell-click', x, y)
}

const CELL = 100
const MARGIN = 50
const WIDTH = MARGIN * 2 + CELL * 8
const HEIGHT = MARGIN * 2 + CELL * 9

// 内部 y → SVG 行号（0 = 屏幕上方的第一行）
// 内部 y=0 是黑方底线 → 显示在顶部；y=9 是红方底线 → 显示在底部（红方在下）
function displayY(y: number): number {
  return y
}

// 内部坐标 → SVG 像素坐标
function px(x: number, y: number): { cx: number; cy: number } {
  return { cx: MARGIN + x * CELL, cy: MARGIN + displayY(y) * CELL }
}

const pieces = computed(() => {
  const list: { x: number; y: number; name: string; red: boolean }[] = []
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 9; x++) {
      const p = props.board.getPieceByXY(x, y)
      if (p !== 0) {
        list.push({ x, y, name: getNameByValue(p), red: isRed(p) })
      }
    }
  }
  return list
})

const gridLines = computed(() => {
  const lines: { x1: number; y1: number; x2: number; y2: number }[] = []
  for (let x = 0; x < 9; x++) {
    lines.push({ x1: MARGIN + x * CELL, y1: MARGIN, x2: MARGIN + x * CELL, y2: MARGIN + 9 * CELL })
  }
  for (let y = 0; y < 10; y++) {
    if (y === 4) continue // 楚河汉界断开
    lines.push({ x1: MARGIN, y1: MARGIN + y * CELL, x2: MARGIN + 8 * CELL, y2: MARGIN + y * CELL })
  }
  // 河界两侧
  lines.push({ x1: MARGIN, y1: MARGIN + 4 * CELL, x2: MARGIN + 3 * CELL, y2: MARGIN + 4 * CELL })
  lines.push({ x1: MARGIN + 5 * CELL, y1: MARGIN + 4 * CELL, x2: MARGIN + 8 * CELL, y2: MARGIN + 4 * CELL })
  // 九宫斜线（上：黑方 y=0..2）
  lines.push({ x1: MARGIN + 3 * CELL, y1: MARGIN, x2: MARGIN + 5 * CELL, y2: MARGIN + 2 * CELL })
  lines.push({ x1: MARGIN + 5 * CELL, y1: MARGIN, x2: MARGIN + 3 * CELL, y2: MARGIN + 2 * CELL })
  // 九宫斜线（下：红方 y=7..9）
  lines.push({ x1: MARGIN + 3 * CELL, y1: MARGIN + 7 * CELL, x2: MARGIN + 5 * CELL, y2: MARGIN + 9 * CELL })
  lines.push({ x1: MARGIN + 5 * CELL, y1: MARGIN + 7 * CELL, x2: MARGIN + 3 * CELL, y2: MARGIN + 9 * CELL })
  return lines
})

const targetMarks = computed(() => {
  return props.legalTargets.map((t) => ({
    ...px(t.x, t.y),
    capture: props.board.getPieceByPosition(t) !== 0,
  }))
})

const lastMoveMarks = computed(() => {
  if (!props.lastMove) return []
  return [props.lastMove.from, props.lastMove.to].map((p) => px(p.x, p.y))
})

const selectedMark = computed(() => (props.selected ? px(props.selected.x, props.selected.y) : null))

// 建议箭头（支招模式）：from 圆心 → to 圆心，带箭头
const suggestArrow = computed(() => {
  const s = props.suggestMove
  if (!s) return null
  const a = px(s.from.x, s.from.y)
  const b = px(s.to.x, s.to.y)
  const dx = b.cx - a.cx
  const dy = b.cy - a.cy
  const len = Math.hypot(dx, dy)
  if (len < 1) return null
  // 箭头从 from 边缘缩进到 to 边缘内
  const ux = dx / len
  const uy = dy / len
  const start = { x: a.cx + ux * 44, y: a.cy + uy * 44 }
  const end = { x: b.cx - ux * 46, y: b.cy - uy * 46 }
  // 箭头头部三角
  const hx = -uy * 18
  const hy = ux * 18
  return {
    line: { ...start, x2: end.x, y2: end.y },
    tip: [
      { x: end.x + ux * 16, y: end.y + uy * 16 },
      { x: end.x + hx, y: end.y + hy },
      { x: end.x - hx, y: end.y - hy },
    ],
  }
})

// 所有格子（点击热区）
const cells = computed(() => {
  const list: { x: number; y: number }[] = []
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 9; x++) {
      list.push({ x, y })
    }
  }
  return list
})
</script>

<template>
  <svg :viewBox="`0 0 ${WIDTH} ${HEIGHT}`" class="board-svg">
    <rect :width="WIDTH" :height="HEIGHT" fill="#f0d9b5" />
    <g stroke="#5a3a1e" stroke-width="2" fill="none">
      <line
        v-for="(l, i) in gridLines"
        :key="i"
        :x1="l.x1"
        :y1="l.y1"
        :x2="l.x2"
        :y2="l.y2"
      />
    </g>
    <text :x="WIDTH / 2" :y="MARGIN + 4 * CELL" text-anchor="middle" dominant-baseline="middle" font-size="36" fill="#5a3a1e" opacity="0.7">楚 河 汉 界</text>
    <!-- 最近着法标记 -->
    <rect
      v-for="(m, i) in lastMoveMarks"
      :key="`lm${i}`"
      :x="m.cx - CELL / 2 + 6"
      :y="m.cy - CELL / 2 + 6"
      :width="CELL - 12"
      :height="CELL - 12"
      fill="none"
      stroke="#3a7d44"
      stroke-width="4"
      rx="8"
      opacity="0.85"
    />
    <!-- 选中标记 -->
    <rect
      v-if="selectedMark"
      :x="selectedMark.cx - CELL / 2 + 4"
      :y="selectedMark.cy - CELL / 2 + 4"
      :width="CELL - 8"
      :height="CELL - 8"
      fill="none"
      stroke="#2e6bdb"
      stroke-width="5"
      rx="8"
    />
    <!-- 合法落点 -->
    <g v-for="(t, i) in targetMarks" :key="`t${i}`">
      <circle v-if="!t.capture" :cx="t.cx" :cy="t.cy" r="12" fill="#3a7d44" opacity="0.7" />
      <circle v-else :cx="t.cx" :cy="t.cy" r="CELL / 2 - 6" fill="none" stroke="#c0392b" stroke-width="4" stroke-dasharray="8 6" opacity="0.85" />
    </g>
    <!-- 建议箭头（支招模式） -->
    <g v-if="suggestArrow" pointer-events="none">
      <line
        :x1="suggestArrow.line.x"
        :y1="suggestArrow.line.y"
        :x2="suggestArrow.line.x2"
        :y2="suggestArrow.line.y2"
        stroke="#e67e22"
        stroke-width="14"
        stroke-linecap="round"
        opacity="0.75"
      />
      <polygon :points="suggestArrow.tip.map((p) => `${p.x},${p.y}`).join(' ')" fill="#e67e22" opacity="0.9" />
    </g>
    <!-- 棋子 -->
    <g v-for="(p, i) in pieces" :key="`p${i}`">
      <circle
        :cx="px(p.x, p.y).cx"
        :cy="px(p.x, p.y).cy"
        r="42"
        fill="#ffe9c4"
        :stroke="p.red ? '#b03a2e' : '#333'"
        stroke-width="3"
      />
      <text
        :x="px(p.x, p.y).cx"
        :y="px(p.x, p.y).cy"
        text-anchor="middle"
        dominant-baseline="central"
        font-size="44"
        font-weight="bold"
        :fill="p.red ? '#b03a2e' : '#222'"
        font-family="'KaiTi', 'STKaiti', 'SimSun', serif"
      >
        {{ p.name }}
      </text>
    </g>
    <!-- 点击热区（透明，置于顶层以覆盖棋子） -->
    <rect
      v-for="c in cells"
      :key="`c${c.x}-${c.y}`"
      :x="px(c.x, c.y).cx - CELL / 2"
      :y="px(c.x, c.y).cy - CELL / 2"
      :width="CELL"
      :height="CELL"
      fill="transparent"
      @click="onClickCell(c.x, c.y)"
    />
  </svg>
</template>

<style scoped>
.board-svg {
  width: 100%;
  max-width: 560px;
  height: auto;
  display: block;
  margin: 0 auto;
  user-select: none;
  -webkit-user-select: none;
  touch-action: manipulation;
}
</style>
