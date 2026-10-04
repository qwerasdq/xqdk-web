// YOLO 检测结果 → 9×10 棋盘映射，直译自 Android assist/DetectionBoardMapper.kt
// 1. 优先用模型 board 框做网格锚点；2. 兜底用棋子中心点包围盒；3. round 取整、越界丢弃、同格留高分；
// 4. 双王行号判朝向（帅在下=STANDARD）

import * as Piece from '../xiangqi/piece'
import type { BoardGridRect, MappedBoard, Orientation, YoloDetection } from './types'
import { BOARD_H, BOARD_W, CELLS } from './types'

/**
 * @param minPieces 单帧最少棋子检测数：残局可低至 3 子（帅仕 vs 将），结构合法性交给 validate/tracker
 */
export function map(
  dets: YoloDetection[],
  frameW: number,
  frameH: number,
  minPieces = 3,
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
      bx0 = x0; by0 = y0; bx1 = x1; by1 = y1
      anchored = true
    }
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
