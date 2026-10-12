// YOLO 检测结果 → 9×10 棋盘映射，直译自 Android assist/DetectionBoardMapper.kt
// 1. 优先用模型 board 框做网格锚点；2. 兜底用棋子中心点包围盒；3. round 取整、越界丢弃、同格留高分；
// 4. 双王行号判朝向（帅在下=STANDARD）

import * as Piece from '../xiangqi/piece'
import type { BoardGridRect, MappedBoard, Orientation, YoloDetection } from './types'
import { BOARD_H, BOARD_W, CELLS } from './types'

/**
 * @param minPieces 单帧最少棋子检测数：残局可低至 3 子（帅仕 vs 将），结构合法性交给 validate/tracker
 * @param fallbackGrid 兜底网格（归一化帧坐标）：本帧检不出可用棋盘框时（低分辨率整帧常见）
 *   才用它做格子归属；有棋盘框时以当帧为准，见下方 refineGridByPitch。
 */
export function map(
  dets: YoloDetection[],
  frameW: number,
  frameH: number,
  minPieces = 3,
  fallbackGrid: BoardGridRect | null = null,
): MappedBoard | null {
  const pieces = dets.filter((d) => !d.isBoard)
  if (pieces.length < minPieces) return null

  let boardDet: YoloDetection | null = null
  for (const d of dets) {
    if (d.isBoard && (boardDet === null || d.score > boardDet.score)) boardDet = d
  }
  const avgW = pieces.reduce((s, d) => s + d.w, 0) / pieces.length
  const avgH = pieces.reduce((s, d) => s + d.h, 0) / pieces.length

  let bx0 = 0, by0 = 0, bx1 = 0, by1 = 0
  let anchored = false
  if (boardDet) {
    const x0 = boardDet.cx - boardDet.w / 2
    const y0 = boardDet.cy - boardDet.h / 2
    const x1 = boardDet.cx + boardDet.w / 2
    const y1 = boardDet.cy + boardDet.h / 2
    const ratio = (x1 - x0) / (y1 - y0)
    if (ratio >= 0.7 && ratio <= 1.3 && x1 - x0 >= avgW * 7 && y1 - y0 >= avgH * 8) {
      const refined = refineGridByPitch(pieces, x0, y0, x1, y1)
      bx0 = refined.x0; by0 = refined.y0; bx1 = refined.x1; by1 = refined.y1
      anchored = true
    }
  }
  if (!anchored && fallbackGrid) {
    // 本帧没有可用棋盘框（低分辨率整帧有时直接检出 0 框）：沿用上一帧定位的网格。
    // 帧间棋盘位置基本不变，直接用锁定网格比棋子包围盒稳。
    bx0 = fallbackGrid.nx0 * frameW
    by0 = fallbackGrid.ny0 * frameH
    bx1 = fallbackGrid.nx1 * frameW
    by1 = fallbackGrid.ny1 * frameH
    anchored = true
  }
  if (!anchored) {
    // 兜底：棋子中心包围盒（至少 20 子才可信）
    if (pieces.length < 20) return null
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const p of pieces) {
      if (p.cx < minX) minX = p.cx
      if (p.cx > maxX) maxX = p.cx
      if (p.cy < minY) minY = p.cy
      if (p.cy > maxY) maxY = p.cy
    }
    const w = maxX - minX
    const h = maxY - minY
    if (w <= 0 || h <= 0) return null
    const ratio = w / h
    if (ratio < 0.7 || ratio > 1.3) return null
    // 最小棋子间距应与包围盒跨度相容（近似 8 列 9 行的等距网格）
    let minDist = Infinity
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const dx = pieces[i]!.cx - pieces[j]!.cx
        const dy = pieces[i]!.cy - pieces[j]!.cy
        const d = Math.hypot(dx, dy)
        if (d < minDist) minDist = d
      }
    }
    if (h < minDist * 8 || w < minDist * 7) return null
    bx0 = minX; by0 = minY; bx1 = maxX; by1 = maxY
  }

  const gridW = (bx1 - bx0) / 8
  const gridH = (by1 - by0) / 9
  if (gridW <= 0 || gridH <= 0) return null

  // 屏幕布局（gy=0 为屏幕顶部）
  const cells = new Uint8Array(CELLS)
  const cellScore = new Float32Array(CELLS)
  let dropped = 0
  let scoreSum = 0
  for (const p of pieces) {
    const col = Math.round((p.cx - bx0) / gridW)
    const row = Math.round((p.cy - by0) / gridH)
    if (col < 0 || col >= BOARD_W || row < 0 || row >= BOARD_H) {
      dropped++
      continue
    }
    const idx = row * BOARD_W + col
    if (cells[idx] !== Piece.EMPTY && cellScore[idx]! >= p.score) {
      dropped++
      continue
    }
    if (cells[idx] !== Piece.EMPTY) scoreSum -= cellScore[idx]!
    cells[idx] = p.piece
    cellScore[idx] = p.score
    scoreSum += p.score
  }
  let pieceCount = 0
  for (let i = 0; i < CELLS; i++) if (cells[i] !== Piece.EMPTY) pieceCount++

  const orientation = detectOrientation(cells) ?? 'STANDARD'
  const { canonical, canonicalScores } = toCanonical(cells, cellScore, orientation)

  // 归一化网格（调试/遮挡判断复用），异常时置 null
  let grid: BoardGridRect | null = null
  try {
    grid = gridFromPxCorners(
      clamp(bx0, 0, frameW), clamp(by0, 0, frameH),
      clamp(bx1, 0, frameW), clamp(by1, 0, frameH),
      frameW, frameH,
    )
  } catch {
    grid = null
  }

  return {
    screenRaw: cells,
    canonical,
    cellScores: canonicalScores,
    orientation,
    grid,
    pieceCount,
    avgScore: pieceCount > 0 ? scoreSum / pieceCount : 0,
    dropped,
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

/**
 * 模型检出的棋盘框在高缩比下**高度系统性高估约 13%**（宽度准确）：
 * 1080p 整屏 + 445px 宽棋盘时真值 400×437，检出 409×496。
 * 直接用该框均分网格会把整行棋子推到相邻行（最底行整行错位，进而抖动）。
 *
 * 修法：棋子本身就是等距网格采样点。用「相邻同排/同列棋子的最小间距」当网格步长，
 * 固定步长、最小二乘解出左上角偏移，重建网格。实测 5 种捕获构图 + 全盘/中局/残局
 * 全部 0 错格，而单用检出框错 12–38 格。
 *
 * guard：步长必须与棋子尺寸相容（1.0–1.8 倍棋子宽/高，象棋网格间距天然大于棋子直径），
 * 且横纵步长之比接近 1（象棋的列距与行距实测比约 0.99–1.03，不是 9:10 的比例）。
 * 不满足则原样返回检出框——子太少或检测退化时宁可退回旧行为，也不能引入新错。
 */
export function refineGridByPitch(
  pieces: YoloDetection[],
  x0: number, y0: number, x1: number, y1: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const raw = { x0, y0, x1, y1 }
  if (pieces.length < 8) return raw
  const priorW = (x1 - x0) / 8
  const priorH = (y1 - y0) / 9
  const gw = fitPitch(pieces.map((p) => p.cx), median(pieces.map((p) => p.w)), priorW)
  const gh = fitPitch(pieces.map((p) => p.cy), median(pieces.map((p) => p.h)), priorH)
  if (gw === null || gh === null) return raw
  if (gw.g / gh.g < 0.7 || gw.g / gh.g > 1.3) return raw

  // 相位 phi 只确定格的「相对位置」，号码（第几行/列）还需要定整数偏移。
  // 棋盘框的**中心**是准的（实测与真值差 1–5px，而框高可高估 13%），所以用它做先验
  // 挑偏移：只在「网格中心与框中心相差不到 0.7 格」的候选里，取落在盘内棋子最多的。
  const ox = pickOffset(pieces.map((p) => p.cx), gw.g, gw.phi, BOARD_W, (x0 + x1) / 2)
  const oy = pickOffset(pieces.map((p) => p.cy), gh.g, gh.phi, BOARD_H, (y0 + y1) / 2)
  if (ox === null || oy === null) return raw
  return { x0: ox, y0: oy, x1: ox + gw.g * 8, y1: oy + gh.g * 9 }
}

/**
 * 在相位 phi 的等价网格（相邻候选相差整数倍步长）中挑一个原点：
 * 候选被限制在「网格中心距 boxCenter 不超过 0.7 格」内 —— 既挡住框位置不可靠带来的错位，
 * 也挡住一个恰好落在盘外一格的误检把整盘吸附偏移（只按"盘内子最多"会选错）。
 * 窗口内取盘内棋子最多者，同分取到格点残差最小者。
 */
function pickOffset(vals: number[], g: number, phi: number, n: number, boxCenter: number): number | null {
  const centreOffset = boxCenter - (g * (n - 1)) / 2
  const k0 = Math.round((centreOffset - phi) / g)
  let best: number | null = null
  let bestIn = -1
  let bestCost = Infinity
  for (let k = k0 - 1; k <= k0 + 1; k++) {
    const origin = phi + k * g
    // 网格中心与该候选中点的距离超过 0.7 格则淘汰
    if (Math.abs(origin + (g * (n - 1)) / 2 - boxCenter) > g * 0.7) continue
    let inside = 0
    let cost = 0
    for (const v of vals) {
      const idx = Math.round((v - origin) / g)
      if (idx >= 0 && idx < n) {
        inside++
        cost += Math.abs(v - origin - idx * g)
      }
    }
    cost = inside > 0 ? cost / inside : Infinity
    if (inside > bestIn || (inside === bestIn && cost < bestCost)) {
      bestIn = inside
      bestCost = cost
      best = origin
    }
  }
  // 大部分棋子都落不进盘内 → 这次拟合不可信，退回棋盘框
  if (best === null || bestIn < vals.length * 0.6) return null
  return best
}

/**
 * 一维点集 → 网格步长与相位。棋子中心在棋盘上严格落在等距格点，即使局面稀疏（残局）
 * 也能反解。做法：在 [1.05, 1.75]×棋子直径 内扫描候选周期，用圆形均值求相位，
 * 取「点到最近格点」平均残差最小的周期。
 *
 * 不用「相邻同排/同列最小间距」：开局同一列的两个子常常隔 2 行（如同列的马与炮），
 * 最小间距会是 2 个格距，直接把网格撑大一倍。
 *
 * 候选区间取「棋子尺寸」与「棋盘框均分步长」两个先验的交集：前者保证不会锁到 2 倍格距
 * （象棋网格间距与棋子直径之比实测约 1.2），后者保证残局只有底两行有子时不会把行距
 * 压扁成半个格（实测棋子高度偏高估会让纯尺寸区间漏掉真值）。
 */
export function fitPitch(vals: number[], size: number, prior?: number): { g: number; phi: number } | null {
  if (size <= 0 || vals.length < 4) return null
  let lo = size * 1.05
  let hi = size * 1.75
  // 带宽放宽到 0.80×先验：棋盘框对高度的系统性高估可达 13%（见顶部说明），
  // 收得比这更紧会把真值挡在区间外，导致残局直接退回原始框。
  if (prior !== undefined && prior > 0) {
    lo = Math.max(lo, prior * 0.8)
    hi = Math.min(hi, prior * 1.08)
  }
  if (hi <= lo) return null
  let bestG = 0
  let bestPhi = 0
  let bestCost = Infinity
  for (let g = lo; g <= hi; g += 0.05) {
    let sx = 0
    let sy = 0
    for (const v of vals) {
      const a = (2 * Math.PI * v) / g
      sx += Math.cos(a)
      sy += Math.sin(a)
    }
    const phi = (Math.atan2(sy, sx) * g) / (2 * Math.PI)
    let cost = 0
    for (const v of vals) {
      const k = Math.round((v - phi) / g)
      cost += Math.abs(v - phi - k * g)
    }
    cost /= vals.length
    if (cost < bestCost) {
      bestCost = cost
      bestG = g
      bestPhi = phi
    }
  }
  // 残差过大说明这些点根本不在等距格点上（检测退化），退回棋盘框
  if (bestCost > Math.min(size * 0.12, bestG * 0.1)) return null
  return { g: bestG, phi: bestPhi }
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b)
  const n = s.length
  if (n === 0) return 0
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2
}

export function gridFromPxCorners(
  xa: number, ya: number, xb: number, yb: number,
  frameW: number, frameH: number,
): BoardGridRect | null {
  const x0 = Math.min(xa, xb), x1 = Math.max(xa, xb)
  const y0 = Math.min(ya, yb), y1 = Math.max(ya, yb)
  const g: BoardGridRect = { nx0: x0 / frameW, ny0: y0 / frameH, nx1: x1 / frameW, ny1: y1 / frameH }
  if (g.nx0 < 0 || g.ny0 < 0 || g.nx1 > 1 || g.ny1 > 1) return null
  if (g.nx1 <= g.nx0 || g.ny1 <= g.ny0) return null
  return g
}

/** 双王位置判定屏幕朝向（帅在下=STANDARD；四分支顺序与 Android 一致） */
export function detectOrientation(raw: Uint8Array): Orientation | null {
  let redRow = -1
  let blackRow = -1
  for (let gy = 0; gy < BOARD_H; gy++) {
    for (let gx = 0; gx < BOARD_W; gx++) {
      const p = raw[gy * BOARD_W + gx]!
      if (p === Piece.WSHUAI) redRow = gy
      else if (p === Piece.BJIANG) blackRow = gy
    }
  }
  if (redRow >= 0 && redRow > 4) return 'STANDARD'
  if (blackRow >= 0 && blackRow > 4) return 'FLIPPED'
  if (redRow >= 0 && redRow <= 4) return 'FLIPPED'
  if (blackRow >= 0 && blackRow <= 4) return 'STANDARD'
  return null
}

/** 屏幕 raw 布局 → canonical（红恒在 y=9）；FLIPPED 时双轴 180° 翻转 */
export function toCanonical(
  raw: Uint8Array,
  rawScores: Float32Array,
  orientation: Orientation,
): { canonical: Uint8Array; canonicalScores: Float32Array } {
  const out = new Uint8Array(CELLS)
  const scores = new Float32Array(CELLS)
  for (let gy = 0; gy < BOARD_H; gy++) {
    for (let gx = 0; gx < BOARD_W; gx++) {
      const src = gy * BOARD_W + gx
      const p = raw[src]!
      if (p === Piece.EMPTY) continue
      const dst = orientation === 'STANDARD' ? src : (BOARD_H - 1 - gy) * BOARD_W + (BOARD_W - 1 - gx)
      out[dst] = p
      scores[dst] = rawScores[src]!
    }
  }
  return { canonical: out, canonicalScores: scores }
}
