// 屏幕识别局面 → Game 调和
//
// 职责：把 tracker 确认的 canonical 90 格局面安全应用到当前 Game，
// 尽量用合法着法走子（保留历史 / 悔棋 / 终局判定），走不了再退化 FEN 重载。
//
// 实现：从当前 Game 局面出发 BFS 搜索 ≤2 步（按对局行棋方交替），每步只走
// 规则层 legalMoves 过滤后的合法着法；找不到匹配路径则用识别局面重载 Game。
// 不碰双侧合法性之外的东西，也不做合规提示。

import { Game, GameStatus } from '../xiangqi/game'
import { Position } from '../xiangqi/position'
import { legalMoves } from '../xiangqi/rule'
import { Board } from '../xiangqi/board'
import * as Piece from '../xiangqi/piece'
import { toFen } from './assistBoard'
import type { MappedBoard } from './types'
import { BOARD_H, BOARD_W, CELLS } from './types'

export interface Reconciled {
  /** 应用方式：move = 用合法着法走（历史保留）；reload = 直接换棋盘；noop = 没变化 */
  applied: 'move' | 'reload' | 'noop'
  fen?: string
  move?: { from: Position; to: Position }
  reason?: string
}

type SyncGame = Pick<Game, 'currentBoard' | 'movePiece' | 'restoreFromFEN'>
function flattenBoard(g: SyncGame): Uint8Array {
  const out = new Uint8Array(CELLS)
  for (let y = 0; y < BOARD_H; y++) {
    for (let x = 0; x < BOARD_W; x++) out[y * BOARD_W + x] = g.currentBoard.piece[y]![x]!
  }
  return out
}

function equalBoards(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < CELLS; i++) if (a[i] !== b[i]) return false
  return true
}

function applyMove(board: Uint8Array, from: Position, to: Position): Uint8Array {
  const next = board.slice()
  const piece = next[from.y * BOARD_W + from.x]!
  next[to.y * BOARD_W + to.x] = piece
  next[from.y * BOARD_W + from.x] = Piece.EMPTY
  return next
}

interface SearchStep {
  from: Position
  to: Position
}

interface SearchNode {
  board: Uint8Array
  redGo: boolean
  steps: SearchStep[]
}

/** 当前行棋方可走的全部合法着法（from/to） */
function movesForSide(board: Uint8Array, redGo: boolean): SearchStep[] {
  const out: SearchStep[] = []
  const b = boardAsBoard(board, redGo)
  for (let y = 0; y < BOARD_H; y++) {
    for (let x = 0; x < BOARD_W; x++) {
      const p = board[y * BOARD_W + x]!
      if (p === Piece.EMPTY || Piece.isRed(p) !== redGo) continue
      const legal = legalMoves(p, x, y, b)
      for (const to of legal) out.push({ from: new Position(x, y), to })
    }
  }
  return out
}

/** 把扁平数组包装成规则层所需的 Board */
function boardAsBoard(board: Uint8Array, redGo: boolean): Board {
  const rows: number[][] = []
  for (let y = 0; y < BOARD_H; y++) {
    const row: number[] = []
    for (let x = 0; x < BOARD_W; x++) row.push(board[y * BOARD_W + x]!)
    rows.push(row)
  }
  const b = new Board()
  b.piece = rows
  b.bRedGo = redGo
  return b
}

/**
 * 从 current 到 target 的合法走法路径（深度 ≤maxPlies，按行棋方交替）。
 * 返回 null 表示没有匹配路径。
 */
function findPath(g: SyncGame, target: Uint8Array, maxPlies = 2): SearchStep[] | null {
  const start = flattenBoard(g)
  if (equalBoards(start, target)) return []

  const queue: SearchNode[] = [
    { board: start, redGo: g.currentBoard.bRedGo, steps: [] },
  ]
  let head = 0
  while (head < queue.length) {
    const node = queue[head++]!
    if (node.steps.length >= maxPlies) continue
    for (const m of movesForSide(node.board, node.redGo)) {
      const next = applyMove(node.board, m.from, m.to)
      const nextNode: SearchNode = { board: next, redGo: !node.redGo, steps: [...node.steps, m] }
      if (equalBoards(next, target)) return nextNode.steps
      queue.push(nextNode)
    }
  }
  return null
}

/**
 * 调和：返回应用方式。move 路径已实际执行到 Game；reload 已通过 restoreFromFEN 重载。
 */
export function reconcileGame(g: SyncGame, mapped: MappedBoard, redGo: boolean): Reconciled {
  const canonical = mapped.canonical
  if (canonical.length !== CELLS) return { applied: 'noop', reason: '识别结果长度异常' }

  const current = flattenBoard(g)
  if (equalBoards(current, canonical)) return { applied: 'noop' }

  const path = findPath(g, canonical, 2)
  if (path) {
    for (const m of path) {
      const st = g.movePiece(m.from, m.to)
      if (st.status === GameStatus.ILLEGAL) {
        return { applied: 'reload', fen: toFen(canonical, redGo), reason: '路径含非法着法' }
      }
    }
    return { applied: 'move', move: path[path.length - 1] }
  }

  const fen = toFen(canonical, redGo)
  if (!g.restoreFromFEN(fen)) {
    return { applied: 'noop', reason: 'FEN 重载失败' }
  }
  return { applied: 'reload', fen }
}
