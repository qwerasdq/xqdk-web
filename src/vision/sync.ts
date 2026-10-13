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
import { movedSide, toFen } from './assistBoard'
import type { MappedBoard } from './types'
import { BOARD_H, BOARD_W, CELLS } from './types'

export interface SyncPlan {
  kind: 'noop' | 'move' | 'blocked' | 'reload'
  path?: SearchStep[]
  fen?: string
  reason?: string
}

export interface Reconciled {
  /** 应用方式：move = 用合法着法走（历史保留）；reload = 已直接换棋盘；blocked = 待人工确认；noop = 没变化 */
  applied: SyncPlan['kind']
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
export function findSyncPath(g: SyncGame, target: Uint8Array, maxPlies = 2): SearchStep[] | null {
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
 * diff 是否只是"移动方走了一步"（含吃子）：移动方一侧新增恰好 1 子、移除 0 或 1 子，
 * 且另一侧完全不动。噪声（网格整行漂移、误检增删）会违反这一点。
 */
function isSingleMoveDiff(oldP: Uint8Array, newP: Uint8Array, moved: 'red' | 'black'): boolean {
  let addedByMover = 0
  let removedByMover = 0
  let addedByOther = 0
  let removedByOther = 0
  for (let i = 0; i < CELLS; i++) {
    const o = oldP[i]!
    const n = newP[i]!
    if (o === n) continue
    if (n !== Piece.EMPTY) {
      if ((Piece.isRed(n) ? 'red' : 'black') === moved) addedByMover++
      else addedByOther++
    }
    if (o !== Piece.EMPTY) {
      if ((Piece.isRed(o) ? 'red' : 'black') === moved) removedByMover++
      else removedByOther++
    }
  }
  // 移动方恰好落 1 子（起格清空 0/1）；对方不新增，最多被吃 1 子。
  // 噪声（网格整行漂移、误检增删）会破坏这个形状。
  return addedByMover === 1 && removedByMover <= 1 && addedByOther === 0 && removedByOther <= 1
}

/**
 * 计算调和计划：
 * - noop = 没变化/长度异常；
 * - move = 找到合法走法路径（未实际执行）；
 * - blocked = 无法用合法走法到达，不应自动改盘，需人工确认；
 * - reload = 仅用于 reconcileGame 内部异常时（合法路径执行失败），主线程仍需按 blocked 处理。
 */
export function planSync(g: SyncGame, mapped: MappedBoard, redGo: boolean): SyncPlan {
  const canonical = mapped.canonical
  if (canonical.length !== CELLS) return { kind: 'noop', reason: '识别结果长度异常' }

  const current = flattenBoard(g)
  if (equalBoards(current, canonical)) return { kind: 'noop' }

  const path = findSyncPath(g, canonical, 2)
  if (path) return { kind: 'move', path }

  // 不再自动 reload：识别结果不能由当前局面合法到达时，需要人工确认，避免单帧/连续错检直接覆盖盘面。
  //
  // 轮到谁走：这一步必须自己判，不能用 tracker 的 redGo —— 它是猜的（首帧确认分支从不设置，
  // 恒为初始值"红方走"），而"确认同步"正是走这条路，于是常出现"本来该我走却显示轮到对方"。
  // 判据：把当前 Game 局面与识别局面做 diff，能判出刚才是谁走的，下一手就是另一方。
  // diff 不干净（两方都有变化）时退回 Game 当前行棋方——它至少由真实落子推出来，比硬编码猜测可靠。
  //
  // 另加一道噪声护栏：blocked 的典型成因是识别错（网格漂移/误检），此时 diff 出的"移动方"
  // 不可信。diff 里移动方一侧只应出现"1 子移位"（起点空、终点有子），若该侧有多个子凭空
  // 出现或消失，说明是噪声而非走子，退回 Game 当前行棋方，不要猜。
  const moved = movedSide(current, canonical)
  const noisy = moved !== null && !isSingleMoveDiff(current, canonical, moved)
  const nextRedGo = moved === null || noisy ? g.currentBoard.bRedGo : moved !== 'red'
  const fen = toFen(canonical, nextRedGo)
  if (!fen) return { kind: 'noop', reason: 'FEN 生成失败' }
  return { kind: 'blocked', fen, reason: noisy ? '识别与当前局面差异过大' : '无法用合法走法到达' }
}

/**
 * 调和：返回应用方式。
 * move = 路径已实际执行到 Game；blocked = 不应用，等待人工确认；noop = 没变化。
 * 不再自动执行 reload：reload 会清空历史且可能把识别错结果直接上盘，JJ 场景必须先人工确认。
 */
export function reconcileGame(g: SyncGame, mapped: MappedBoard, redGo: boolean): Reconciled {
  const plan = planSync(g, mapped, redGo)
  if (plan.kind === 'noop' || plan.kind === 'blocked') return { applied: plan.kind, fen: plan.fen, reason: plan.reason }

  if (plan.kind === 'move') {
    for (const m of plan.path ?? []) {
      const st = g.movePiece(m.from, m.to)
      if (st.status === GameStatus.ILLEGAL) {
        return { applied: 'blocked', fen: plan.fen, reason: '路径含非法着法' }
      }
    }
    const last = plan.path?.[plan.path.length - 1]
    return { applied: 'move', move: last ? { from: last.from, to: last.to } : undefined }
  }

  return { applied: 'noop', reason: plan.reason || '未知计划' }
}
