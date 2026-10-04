// 对方回合应对预案（照抄 Android 版 assist-helper 的设计）：
// 对方回合时，引擎算力同样为我方所用——先求对方最可能的 N 个走法（MultiPV），
// 再对每个候选逐个求我方最佳应对，产出「若对方走 X，我方应 Y」预案（Y 供箭头标注）。
//
// 生成是渐进的：每算完一条立即回调，UI 可边算边显示。

import { Board } from '../../xiangqi/board'
import { Move } from '../../xiangqi/move'
import { Position } from '../../xiangqi/position'
import { describeMove } from '../../xiangqi/pv'
import { engineAnalyze } from '../../engine/useEngine'
import type { AnalysisLine } from '../../engine/useEngine'

export interface AssistPlan {
  /** 对方着法（UCCI） */
  oppUcci: string
  /** 对方着法（中文描述，如 "炮8平5 (h9e7)"） */
  oppChs: string
  /** 我方应手（UCCI） */
  myUcci: string
  /** 我方应手（中文描述） */
  myChs: string
}

export interface BuildPlansRequest {
  /** 起始局面 FEN（对局初始局面，非当前局面） */
  fen: string
  /** 历史着法（UCCI），作用于起始 FEN 之上 */
  moves: string[]
  depth: number
  /** 对方候选数（建议 3） */
  topN: number
}

// 在棋盘上应用一步 UCCI（tryMove 不翻转行棋方，手动翻转，与 Game 历史重放一致）
function applyUcci(board: Board, ucci: string): boolean {
  const m = new Move(new Position(0, 0), new Position(0, 0), board)
  if (!m.fromUCCIString(ucci)) return false
  board.tryMove(m.fromPosition, m.toPosition)
  board.bRedGo = !board.bRedGo
  return true
}

// 单次分析，返回最终候选行（取引擎收敛后的快照）
function analyzeOnce(
  fen: string,
  moves: string[],
  depth: number,
  multipv: number,
): Promise<AnalysisLine[]> {
  let final: AnalysisLine[] = []
  return engineAnalyze({ fen, moves, depth, multipv }, (lines) => {
    final = lines
  }).then(() => final)
}

/**
 * 生成应对预案。
 * @param onPlan 每算好一条回调（渐进显示）
 * @param isStale 过期检查：局面已变/已退出该模式时返回 true，中止后续计算
 */
export async function buildPlans(
  req: BuildPlansRequest,
  onPlan: (plan: AssistPlan) => void,
  isStale: () => boolean,
): Promise<void> {
  const topN = Math.max(1, Math.min(3, req.topN))

  // 1. 对方怎么走：当前局面（轮对方）MultiPV topN
  const oppLines = await analyzeOnce(req.fen, req.moves, req.depth, topN)
  if (isStale()) return

  // 2. 逐个候选求我方应对
  for (const line of oppLines) {
    if (isStale()) return
    const oppUcci = line.pv[0]
    if (!oppUcci) continue

    const board = new Board()
    if (!board.restoreFromFEN(req.fen)) return
    let ok = true
    for (const u of req.moves) {
      if (!applyUcci(board, u)) {
        ok = false
        break
      }
    }
    if (!ok) return

    // 对方走子前的当前局面（用于中文描述）
    const beforeFen = board.toFENString()
    const oppChs = describeMove(beforeFen, oppUcci)

    if (!applyUcci(board, oppUcci)) continue
    const afterFen = board.toFENString()

    // 3. 我方应对（单线搜索足够——预案展示只需最佳应手）
    const myLines = await analyzeOnce(afterFen, [], req.depth, 1)
    if (isStale()) return
    const myUcci = myLines[0]?.pv[0]
    if (!myUcci) continue

    onPlan({
      oppUcci,
      oppChs,
      myUcci,
      myChs: describeMove(afterFen, myUcci),
    })
  }
}
