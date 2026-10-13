// YOLO 检测结果 → 9×10 棋盘映射，直译自 Android assist/DetectionBoardMapper.kt
// 网格锚点优先级：① 模型 board 框（用棋子间距细化，见 refineGridByPitch）
//                ② 上层传入的 fallbackGrid（本帧检不出框时沿用上一帧）
//                ③ 纯棋子中心反解（分块定位帧，见 fitGridFromPieces）
//                ④ 棋子中心包围盒（≥20 子才可信）
// 之后：round 取整、越界丢弃、同格留高分；双王行号判朝向（帅在下=STANDARD）

import * as Piece from '../xiangqi/piece'
import type { BoardGridRect, MappedBoard, Orientation, YoloDetection } from './types'
import { BOARD_H, BOARD_W, CELLS } from './types'

/**
 * @param minPieces 单帧最少棋子检测数：残局可低至 3 子（帅仕 vs 将），结构合法性交给 validate/tracker
 * @param fallbackGrid 兜底网格（归一化帧坐标）：本帧检不出可用棋盘框时（低分辨率整帧常见）
 *   才用它做格子归属；有棋盘框时以当帧为准，见下方 refineGridByPitch。
 * @param forcedOrientation 上层锁定的朝向，给了就强制用它。朝向判据只看王落在哪一行，
 *   单帧误检会让 canonical 整体 180° 翻转（约 40 格同时变），是"抖动很大"的主因。
 *   锁定与滞回由上层 OrientationStabilizer 负责（本函数一帧可能被调用多次，不能在这里计数）。
 */
export function map(
  dets: YoloDetection[],
  frameW: number,
  frameH: number,
  minPieces = 3,
  fallbackGrid: BoardGridRect | null = null,
  forcedOrientation: Orientation | null = null,
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
    // 仍无网格：用棋子中心反解（分块定位帧走到这里——块边界常把棋盘框切断）。
    // 比下面的包围盒兜底稳：包围盒要求"检到的子刚好铺满整盘"，反解只要求等距。
    const fitted = fitGridFromPieces(pieces)
    if (fitted !== null) {
      bx0 = fitted.x0; by0 = fitted.y0; bx1 = fitted.x1; by1 = fitted.y1
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

  // 朝向：上层锁定了就用锁定值（防单帧误检把整盘翻 180°），否则按本帧王位判定
  const orientation = forcedOrientation ?? detectOrientation(cells) ?? 'STANDARD'
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
 * 修法：棋子本身就是等距网格采样点。用「圆形均值扫描候选周期」反解步长与相位，
 * 再用「罩住最多棋子」的整数偏移定出原点，重建网格。实测 5 种捕获构图 + 全盘/中局/残局
 * 全部 0 错格，而单用检出框错 12–38 格。
 *
 * guard：步长必须与棋子尺寸相容（1.05–1.75 倍棋子宽/高，象棋网格间距天然大于棋子直径），
 * 且横纵步长之比接近 1（象棋的列距与行距实测比约 0.99–1.03，不是 9:10 的比例）。
 * 不满足则原样返回检出框——子太少或检测退化时宁可退回旧行为，也不能引入新错。
 */
export function refineGridByPitch(
  pieces: YoloDetection[],
  x0: number, y0: number, x1: number, y1: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const raw = { x0, y0, x1, y1 }
  const fitted = fitGridByPitch(pieces, (x1 - x0) / 8, (y1 - y0) / 9, (x0 + x1) / 2, (y0 + y1) / 2)
  return fitted ?? raw
}

/**
 * 只用棋子中心反解网格，**不需要棋盘框**。
 *
 * 用途：分块扫描定位时棋盘框常被块边界切断（一块里可能只有半个棋盘），只能靠棋子本身反解。
 *
 * 先验的取法：包围盒跨度 ÷ 跨度内的格数。格数未知（棋子可能只占棋盘一角），
 * 所以枚举格数 k，取残差最小的那个组合。**不能固定用 k=8/9**——只有 6 行有子时
 * span/9 会把步长低估三分之一，先验带宽随之收死，直接拟合失败。
 */
export function fitGridFromPieces(
  pieces: YoloDetection[],
): { x0: number; y0: number; x1: number; y1: number } | null {
  if (pieces.length < 12) return null
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of pieces) {
    if (p.cx < minX) minX = p.cx
    if (p.cx > maxX) maxX = p.cx
    if (p.cy < minY) minY = p.cy
    if (p.cy > maxY) maxY = p.cy
  }
  const sizeW = median(pieces.map((p) => p.w))
  const sizeH = median(pieces.map((p) => p.h))
  const gw = fitPitchBySpan(pieces.map((p) => p.cx), sizeW, maxX - minX, BOARD_W - 1)
  const gh = fitPitchBySpan(pieces.map((p) => p.cy), sizeH, maxY - minY, BOARD_H - 1)
  if (gw === null || gh === null) return null
  if (gw.g / gh.g < 0.7 || gw.g / gh.g > 1.3) return null

  // 必须"钉住原点"才可信：棋子要覆盖到棋盘两端附近，否则把整盘平移一格后
  // 棋子照样全落在盘内（投票并列），原点就是猜的 —— 实测只看到半盘时会偏 2 格。
  // 宁可不给，也不要给一个自信的错盘：上层退回锁定网格或报"未识别到棋盘"。
  if (maxX - minX < gw.g * (BOARD_W - 2)) return null
  if (maxY - minY < gh.g * (BOARD_H - 2)) return null

  const ox = pickOffset(pieces.map((p) => p.cx), gw.g, gw.phi, BOARD_W, (minX + maxX) / 2)
  const oy = pickOffset(pieces.map((p) => p.cy), gh.g, gh.phi, BOARD_H, (minY + maxY) / 2)
  if (ox === null || oy === null) return null
  return { x0: ox, y0: oy, x1: ox + gw.g * (BOARD_W - 1), y1: oy + gh.g * (BOARD_H - 1) }
}

/**
 * 在相位 phi 的等价网格（相邻候选相差整数倍步长）中挑一个原点。
 *
 * 判据：网格能罩住最多棋子者优先，同分取到格点残差最小者，再同分取最靠近参考中心者
 * （参考中心是"棋子应该落在这个网格里"的先验）。
 *
 * 不设"网格中心必须贴近参考中心"的硬窗口：分块扫描只覆盖棋盘一角时，棋子包围盒中心
 * 可以离棋盘中心好几格（实测只有下半盘时差 1.5 格），硬窗口会把正确原点挡在外面。
 * 而"罩住最多棋子"本身就能排除被盘外误检带偏的候选——偏一格时那个误检会落到盘外。
 */
function pickOffset(vals: number[], g: number, phi: number, n: number, refCentre: number): number | null {
  let best: number | null = null
  let bestIn = -1
  let bestCost = Infinity
  let bestCentric = Infinity
  // 候选覆盖"网格中心落在参考中心附近"的所有整数偏移，两头各留 2 格余量
  const k0 = Math.round((refCentre - (g * (n - 1)) / 2 - phi) / g)
  for (let k = k0 - 2; k <= k0 + 2; k++) {
    const origin = phi + k * g
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
    const centric = Math.abs(origin + (g * (n - 1)) / 2 - refCentre)
    if (
      inside > bestIn ||
      (inside === bestIn && cost < bestCost - 1e-9) ||
      (inside === bestIn && Math.abs(cost - bestCost) <= 1e-9 && centric < bestCentric)
    ) {
      bestIn = inside
      bestCost = cost
      bestCentric = centric
      best = origin
    }
  }
  // 大部分棋子都落不进盘内 → 这次拟合不可信，退回棋盘框
  if (best === null || bestIn < vals.length * 0.6) return null
  return best
}

/**
 * 跨度未知格数时的步长求解：枚举跨度内含的格数 k=1..maxGaps，各自拟合，
 * 取残差最小者（并列时取步长最接近 1.2×棋子尺寸的，即象棋网格与棋子直径的实测比）。
 */
function fitPitchBySpan(
  vals: number[],
  size: number,
  span: number,
  maxGaps: number,
): { g: number; phi: number } | null {
  if (span <= 0 || size <= 0) return null
  let best: { g: number; phi: number } | null = null
  let bestCost = Infinity
  for (let k = 1; k <= maxGaps; k++) {
    const fit = fitPitch(vals, size, span / k)
    if (fit === null) continue
    // 重算该拟合的平均残差，用于跨 k 比较
    let cost = 0
    for (const v of vals) cost += Math.abs(v - fit.phi - Math.round((v - fit.phi) / fit.g) * fit.g)
    cost /= vals.length
    const tie = Math.abs(fit.g - size * 1.2)
    const bestTie = best === null ? Infinity : Math.abs(best.g - size * 1.2)
    if (cost < bestCost - 1e-9 || (Math.abs(cost - bestCost) <= 1e-9 && tie < bestTie)) {
      bestCost = cost
      best = fit
    }
  }
  return best
}

/**
 * 网格反解共用实现：固定周期扫描 + 相位求解 + 整数偏移投票。
 * @param priorW/priorH 周期先验（通常为棋盘框或包围盒跨度均分），用于收窄扫描区间
 * @param cx/cy 网格中心先验，用于在等价偏移中挑出正确编号
 */
function fitGridByPitch(
  pieces: YoloDetection[],
  priorW: number,
  priorH: number,
  cx: number,
  cy: number,
): { x0: number; y0: number; x1: number; y1: number } | null {
  if (pieces.length < 8) return null
  const gw = fitPitch(pieces.map((p) => p.cx), median(pieces.map((p) => p.w)), priorW)
  const gh = fitPitch(pieces.map((p) => p.cy), median(pieces.map((p) => p.h)), priorH)
  if (gw === null || gh === null) return null
  if (gw.g / gh.g < 0.7 || gw.g / gh.g > 1.3) return null

  // 相位 phi 只确定格的「相对位置」，号码（第几行/列）还需要定整数偏移。
  // 中心先验是准的（实测与真值差 1–5px，而框高可高估 13%），所以用它挑偏移：
  // 只在「网格中心与先验中心相差不到 0.7 格」的候选里，取落在盘内棋子最多的。
  const ox = pickOffset(pieces.map((p) => p.cx), gw.g, gw.phi, BOARD_W, cx)
  const oy = pickOffset(pieces.map((p) => p.cy), gh.g, gh.phi, BOARD_H, cy)
  if (ox === null || oy === null) return null
  return { x0: ox, y0: oy, x1: ox + gw.g * 8, y1: oy + gh.g * 9 }
}

/**
 * 一维点集 → 网格步长与相位。棋子中心在棋盘上严格落在等距格点，即使局面稀疏（残局）
 * 也能反解。做法：在 [0.9, 1.75]×棋子直径 内扫描候选周期，用圆形均值求相位，
 * 取「点到最近格点」平均残差最小的周期。
 *
 * 不用「相邻同排/同列最小间距」：开局同一列的两个子常常隔 2 行（如同列的马与炮），
 * 最小间距会是 2 个格距，直接把网格撑大一倍。
 *
 * 候选区间取「棋子尺寸」与「棋盘框均分步长」两个先验的交集：前者保证不会锁到 2 倍格距，
 * 后者保证残局只有底两行有子时不会把行距压扁成半个格（实测棋子高度偏高估会让纯尺寸区间
 * 漏掉真值）。下界放到 0.9 是因为格距/棋子尺寸在不同渲染下差异很大——Android 端约 1.2，
 * 而 JJ 模拟器实测约 0.98（棋子贴边），1.05 的下界会直接把真值排除在外。
 */
export function fitPitch(vals: number[], size: number, prior?: number): { g: number; phi: number } | null {
  if (size <= 0 || vals.length < 4) return null
  // 下界 0.9×棋子尺寸：JJ 的棋子是贴边圆形立绘，检测框几乎等于格距（实测 pitch/size ≈ 0.98），
  // 用"格距必然大于棋子直径"的物理直觉取 1.05× 会把真值挡在区间外 → 拟合失败 → 退回
  // 高度高估 13% 的模型棋盘框 → 整行错位（实测 240×445 下第 3 帧起错 18 格，第 5 帧错 32 格）。
  // 不会锁到"半格距"的次谐波：残差判据（bestCost）与 pickOffset 的 60% 入盘率会挡掉。
  let lo = size * 0.9
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

/**
 * 朝向稳定器：锁定一次朝向，之后只在**连续多帧一致地**指向另一朝向时才切换。
 *
 * 为什么需要：detectOrientation 只看王在哪一行，单帧误检（红帅被检到上半盘）就会让
 * canonical 整体 180° 翻转——约 40 格同时变，表现为"抖动很大"。JJ 对局中棋盘方向
 * 不会中途改变，所以默认锁死，只在确实换边（用户重开/切视角）时才跟随。
 *
 * 冷启动：第一个能判出朝向的帧即锁定（不再要求连续 N 帧）——锁定错了会在
 * switchFrames 帧内被纠正，但若要求连续 N 帧才锁定，开头 N 帧就一直在抖。
 */
export class OrientationStabilizer {
  private locked: Orientation | null = null
  private pending: Orientation | null = null
  private hits = 0

  constructor(private readonly switchFrames = 5) {}

  reset(): void {
    this.locked = null
    this.pending = null
    this.hits = 0
  }

  /** 本帧应采用（并已锁定）的朝向；返回 null 表示尚无可靠朝向，本帧走原判定 */
  update(detected: Orientation | null): Orientation | null {
    if (this.locked === null) {
      // 冷启动：第一个判得出朝向的帧直接锁定
      if (detected !== null) this.locked = detected
      return this.locked
    }
    // 已锁定：只有连续多帧一致指向另一朝向才切换
    if (detected !== null && detected !== this.locked) {
      if (detected === this.pending) {
        if (++this.hits >= this.switchFrames) {
          this.locked = detected
          this.pending = null
          this.hits = 0
        }
      } else {
        this.pending = detected
        this.hits = 1
      }
    } else {
      this.pending = null
      this.hits = 0
    }
    return this.locked
  }

  get current(): Orientation | null {
    return this.locked
  }
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
