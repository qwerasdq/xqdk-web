// 棋盘快照工具，移植自 Android assist/AssistBoard.kt（识别域子集）
// 约定与项目内部 Board 一致：扁平 90 格，idx = y*9+x，y=0 黑方底线、y=9 红方底线

import * as Piece from '../xiangqi/piece'
import { BOARD_H, BOARD_W, CELLS } from './types'

/** 标准开局 FEN（xqbase 格式，红先） */
export const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'

/** 标准开局局面（红在 y=9 底部），扁平 90 格 */
export function canonicalStart(): Uint8Array {
  const p = new Uint8Array(CELLS)
  const at = (x: number, y: number): number => y * BOARD_W + x
  for (let x = 0; x < BOARD_W; x++) {
    p[at(x, 0)] = x === 0 || x === 8 ? Piece.BJU
      : x === 1 || x === 7 ? Piece.BMA
      : x === 2 || x === 6 ? Piece.BXIANG
      : x === 3 || x === 5 ? Piece.BSHI
      : Piece.BJIANG
  }
  p[at(1, 2)] = Piece.BPAO
  p[at(7, 2)] = Piece.BPAO
  for (let x = 0; x < BOARD_W; x += 2) p[at(x, 3)] = Piece.BZU
  for (let x = 0; x < BOARD_W; x += 2) p[at(x, 6)] = Piece.WBING
  p[at(1, 7)] = Piece.WPAO
  p[at(7, 7)] = Piece.WPAO
  for (let x = 0; x < BOARD_W; x++) {
    p[at(x, 9)] = x === 0 || x === 8 ? Piece.WJU
      : x === 1 || x === 7 ? Piece.WMA
      : x === 2 || x === 6 ? Piece.WXIANG
      : x === 3 || x === 5 ? Piece.WSHI
      : Piece.WSHUAI
  }
  return p
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < CELLS; i++) if (a[i] !== b[i]) return false
  return true
}

/** 与开局对照一致的子数（用于"开局检测"） */
const startBoard = canonicalStart()
export function matchStartCount(pieces: Uint8Array): number {
  let n = 0
  for (let i = 0; i < CELLS; i++) {
    if (pieces[i] !== Piece.EMPTY && pieces[i] === startBoard[i]) n++
  }
  return n
}

/** 各兵种数量上限（红黑各一套），用于超限修复 */
export const PIECE_LIMITS: Record<number, number> = {
  [Piece.WSHUAI]: 1, [Piece.WSHI]: 2, [Piece.WXIANG]: 2, [Piece.WMA]: 2, [Piece.WJU]: 2, [Piece.WPAO]: 2, [Piece.WBING]: 5,
  [Piece.BJIANG]: 1, [Piece.BSHI]: 2, [Piece.BXIANG]: 2, [Piece.BMA]: 2, [Piece.BJU]: 2, [Piece.BPAO]: 2, [Piece.BZU]: 5,
}

/**
 * 数量超限修复：某兵种超过上限时，按格置信度从低到高剔除多余的子。
 *
 * 动机：模型偶尔对同一兵种多吐一个框（实测红帅格上同时检出 r_pao 0.695 与 r_jiang 0.881），
 * 多出的框落到空格就变成"卒 6 个""炮 3 个"。此前这类帧被 validate 判为无效整帧丢弃，
 * 表现为识别断续 UNSTABLE；而盘面其实只错了一格，剔掉最低分的那个即可。
 *
 * 只做数量裁剪，不改动任何具体格的内容（不做"卒不该在这"这类棋规推断）——
 * 越界/照面等仍交给 validate 拒绝。返回被剔除的格数（0 表示无超限）。
 */
export function repairOverflow(pieces: Uint8Array, scores: Float32Array): number {
  const counts = new Int32Array(Piece.BZU + 1)
  for (let i = 0; i < CELLS; i++) if (pieces[i] !== Piece.EMPTY) counts[pieces[i]!]++
  let removed = 0
  for (let p = Piece.WSHUAI; p <= Piece.BZU; p++) {
    const limit = PIECE_LIMITS[p]!
    let excess = counts[p]! - limit
    if (excess <= 0) continue
    // 收集该兵种所有格，按分数升序，剔掉最低的 excess 个
    const idxs: number[] = []
    for (let i = 0; i < CELLS; i++) if (pieces[i] === p) idxs.push(i)
    idxs.sort((a, b) => scores[a]! - scores[b]!)
    for (let k = 0; k < excess && k < idxs.length; k++) {
      pieces[idxs[k]!] = Piece.EMPTY
      scores[idxs[k]!] = 0
      removed++
    }
  }
  return removed
}

/**
 * 硬合法性校验（比 Android 多一项将帅照面检查，增强噪声拒识）：
 * 帅/将各恰好 1、各兵种数量上限、总数 ≤32、将帅同线且中间无子非法。
 * 返回问题列表，空表示通过。
 */
export function validate(pieces: Uint8Array): string[] {
  const issues: string[] = []
  const counts = new Int32Array(Piece.BZU + 1)
  let redKingIdx = -1
  let blackKingIdx = -1
  for (let i = 0; i < CELLS; i++) {
    const p = pieces[i]!
    if (p === Piece.EMPTY) continue
    counts[p]!++
    if (p === Piece.WSHUAI) redKingIdx = i
    if (p === Piece.BJIANG) blackKingIdx = i
  }
  if (counts[Piece.WSHUAI] !== 1) issues.push(`红帅数量异常:${counts[Piece.WSHUAI]}`)
  if (counts[Piece.BJIANG] !== 1) issues.push(`黑将数量异常:${counts[Piece.BJIANG]}`)
  for (const [k, v] of Object.entries(PIECE_LIMITS)) {
    const id = Number(k)
    // 帅/将已由上面的"恰好 1 个"检查覆盖，跳过以免重复报错
    if (id === Piece.WSHUAI || id === Piece.BJIANG) continue
    if (counts[id]! > v) issues.push(`${Piece.getNameByValue(id)}数量超限:${counts[id]}`)
  }
  let total = 0
  for (const c of counts) total += c
  if (total > 32) issues.push(`总子数超限:${total}`)

  // 将帅照面（飞将）非法：同列且中间无子
  if (redKingIdx >= 0 && blackKingIdx >= 0) {
    const rx = redKingIdx % BOARD_W
    const bx = blackKingIdx % BOARD_W
    if (rx === bx) {
      const ry = Math.floor(redKingIdx / BOARD_W)
      const by = Math.floor(blackKingIdx / BOARD_W)
      const lo = Math.min(ry, by)
      const hi = Math.max(ry, by)
      let blocked = false
      for (let y = lo + 1; y < hi; y++) {
        if (pieces[y * BOARD_W + rx] !== Piece.EMPTY) {
          blocked = true
          break
        }
      }
      if (!blocked) issues.push('将帅照面')
    }
  }
  return issues
}

/**
 * 推断"刚走子的一方"：对比旧/新局面。返回 'red' | 'black' | null（无法确定）。
 * 规则：新增棋子的阵营即移动方；无新增（重排/异常）则尝试用移除方补。
 */
export function movedSide(oldP: Uint8Array, newP: Uint8Array): 'red' | 'black' | null {
  let addedSide: 'red' | 'black' | null = null
  let removedSide: 'red' | 'black' | null = null
  for (let i = 0; i < CELLS; i++) {
    const o = oldP[i]!
    const n = newP[i]!
    if (o === n) continue
    if (n !== Piece.EMPTY) {
      const s = Piece.isRed(n) ? 'red' : 'black'
      if (addedSide !== null && addedSide !== s) return null
      addedSide = s
    }
    if (o !== Piece.EMPTY) {
      const s = Piece.isRed(o) ? 'red' : 'black'
      if (removedSide !== null && removedSide !== s) return null
      removedSide = s
    }
  }
  return addedSide ?? removedSide
}

/** 扁平 90 格 → xqbase FEN（红方大写黑方小写，与项目 Board 同口径） */
export function toFen(pieces: Uint8Array, redGo: boolean): string {
  let board = ''
  for (let y = 0; y < BOARD_H; y++) {
    let zeros = 0
    for (let x = 0; x < BOARD_W; x++) {
      const p = pieces[y * BOARD_W + x]!
      if (p === Piece.EMPTY) {
        zeros++
      } else {
        if (zeros > 0) {
          board += String(zeros)
          zeros = 0
        }
        board += Piece.getCharByValue(p)
      }
    }
    if (zeros > 0) board += String(zeros)
    if (y < BOARD_H - 1) board += '/'
  }
  return `${board} ${redGo ? 'w' : 'b'} - - 0 1`
}

/** 与项目 Board 互转（reconcile 用） */
export function fromBoardCells(getPiece: (x: number, y: number) => number): Uint8Array {
  const p = new Uint8Array(CELLS)
  for (let y = 0; y < BOARD_H; y++) {
    for (let x = 0; x < BOARD_W; x++) p[y * BOARD_W + x] = getPiece(x, y)
  }
  return p
}

/** FEN → 扁平 90 格（供测试构造局面） */
export function piecesFromFen(fen: string): Uint8Array {
  const p = new Uint8Array(CELLS)
  const board = fen.trim().split(/\s+/)[0]!
  let x = 0
  let y = 0
  for (const c of board) {
    if (c === '/') {
      x = 0
      y++
    } else if (c >= '0' && c <= '9') {
      x += c.charCodeAt(0) - 48
    } else {
      p[y * BOARD_W + x] = Piece.getValueByChar(c)
      x++
    }
  }
  return p
}

/**
 * 应用一个 UCCI 着法（如 "h2e2"）到 FEN 局面，返回行棋方翻转后的新 FEN。
 * 着法非法或起点无子时原样返回（照抄 Android AssistBoard.applyUcci）。
 */
export function applyUcci(fen: string, ucci: string): string {
  if (ucci.length < 4) return fen
  const fx = ucci.charCodeAt(0) - 97
  const fy = 9 - (ucci.charCodeAt(1) - 48)
  const tx = ucci.charCodeAt(2) - 97
  const ty = 9 - (ucci.charCodeAt(3) - 48)
  if (fx < 0 || fx >= BOARD_W || fy < 0 || fy >= BOARD_H || tx < 0 || tx >= BOARD_W || ty < 0 || ty >= BOARD_H) {
    return fen
  }
  const board = piecesFromFen(fen)
  const piece = board[fy * BOARD_W + fx]!
  if (piece === Piece.EMPTY) return fen
  board[ty * BOARD_W + tx] = piece
  board[fy * BOARD_W + fx] = Piece.EMPTY
  const nextRedGo = fen.trim().split(/\s+/)[1] !== 'w'
  return toFen(board, nextRedGo)
}
