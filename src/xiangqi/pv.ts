// PV 变例工具：UCCI 着法序列 → 中文着法（从给定 FEN 模拟走子）
// 逻辑同 Android 版 MoveChinese.describe：restore FEN 后逐着 apply 并取 getChsString
// 注意：Web 版 Move 构造函数为 (from, to, board?)，与 Android 的 Move(board) 不同

import { Board } from './board'
import { Move } from './move'
import { Position } from './position'

function makeMove(board: Board, ucci: string): Move | null {
  const m = new Move(new Position(0, 0), new Position(0, 0), board)
  return m.fromUCCIString(ucci) ? m : null
}

/** 从 FEN 出发模拟 PV，返回中文着法数组（如 ['炮二平五', '马8进7', ...]） */
export function pvToChinese(fen: string, pv: string[]): string[] {
  const board = new Board()
  if (!board.restoreFromFEN(fen)) return []
  const result: string[] = []
  for (const ucci of pv) {
    const m = makeMove(board, ucci)
    if (!m) break
    result.push(m.getChsString(board))
    board.tryMove(m.fromPosition, m.toPosition)
    board.bRedGo = !board.bRedGo
  }
  return result
}

/** 单着描述："炮二平五 (h2e2)"；解析失败原样返回 UCCI（同 Android MoveChinese.describe） */
export function describeMove(fen: string, ucci: string): string {
  const board = new Board()
  if (!board.restoreFromFEN(fen)) return ucci
  const m = makeMove(board, ucci)
  if (m) {
    return `${m.getChsString(board)} (${ucci})`
  }
  return ucci
}

/** UCCI 字符串 → 棋盘坐标（用于建议箭头） */
export function ucciToXY(ucci: string): { fx: number; fy: number; tx: number; ty: number } | null {
  if (!/^[a-i][0-9][a-i][0-9]$/.test(ucci)) return null
  return {
    fx: ucci.charCodeAt(0) - 97,
    fy: 9 - (ucci.charCodeAt(1) - 48),
    tx: ucci.charCodeAt(2) - 97,
    ty: 9 - (ucci.charCodeAt(3) - 48),
  }
}
