// 稳定帧跟踪器测试，移植自 Android AssistCoreTest.kt（tracker 部分，5 用例）
import { describe, expect, it } from 'vitest'
import { BoardTracker } from './boardTracker'
import { canonicalStart, equal, validate } from './assistBoard'
import type { RecognitionResult } from './types'
import * as Piece from '../xiangqi/piece'
import { BOARD_W } from './types'

const at = (x: number, y: number): number => y * BOARD_W + x

/** 由棋盘直接构造识别结果（识别来源无关） */
function res(board: Uint8Array, valid = true): RecognitionResult {
  let n = 0
  for (const p of board) if (p !== Piece.EMPTY) n++
  return {
    canonical: board,
    screenRaw: board,
    cellScores: new Float32Array(90),
    orientation: 'STANDARD',
    issues: valid ? validate(board) : ['模拟坏帧'],
    unknownCells: 0,
    recognizedPieces: n,
    avgScore: 0.9,
  }
}

/** 红炮二平五后的局面 */
function midBoard(): Uint8Array {
  const mid = canonicalStart().slice()
  mid[at(4, 7)] = mid[at(7, 7)]!
  mid[at(7, 7)] = Piece.EMPTY
  return mid
}

/** 真实截图残局（canonical，红在下）：帅仕仕马 vs 将象象卒（8 子） */
function endgameBoard(): Uint8Array {
  const b = new Uint8Array(90)
  b[at(4, 9)] = Piece.WSHUAI
  b[at(3, 9)] = Piece.WSHI
  b[at(5, 9)] = Piece.WSHI
  b[at(4, 5)] = Piece.WMA
  b[at(4, 0)] = Piece.BJIANG
  b[at(4, 2)] = Piece.BXIANG
  b[at(6, 4)] = Piece.BXIANG
  b[at(6, 6)] = Piece.BZU
  return b
}

describe('BoardTracker 多帧确认', () => {
  it('确认局面并在红走子后翻转轮次', () => {
    const start = canonicalStart()
    const mid = midBoard()

    const tracker = new BoardTracker(3)
    tracker.reset(true)

    // 首次确认需连续 3 帧一致（防瞬时坏帧/幻觉帧）
    expect(tracker.onFrame(res(start))).toBe('UNSTABLE')
    expect(tracker.onFrame(res(start))).toBe('UNSTABLE')
    expect(tracker.onFrame(res(start))).toBe('NEW_GAME')
    expect(tracker.redGo).toBe(true)

    // 红走子后连续 3 帧确认
    expect(tracker.onFrame(res(mid))).toBe('UNSTABLE')
    expect(tracker.onFrame(res(mid))).toBe('UNSTABLE')
    expect(tracker.onFrame(res(mid))).toBe('NEW_BOARD')
    expect(tracker.redGo).toBe(false) // 红刚走完，轮到黑

    // 黑再走一步 => 回到红
    const mid2 = mid.slice()
    mid2[at(4, 2)] = mid2[at(7, 2)]!
    mid2[at(7, 2)] = Piece.EMPTY
    tracker.onFrame(res(mid2))
    tracker.onFrame(res(mid2))
    expect(tracker.onFrame(res(mid2))).toBe('NEW_BOARD')
    expect(tracker.redGo).toBe(true)
  })

  it('稀疏残局首次确认同样需 3 帧', () => {
    const tracker = new BoardTracker(3)
    tracker.reset(true)
    const b = endgameBoard()
    expect(tracker.onFrame(res(b))).toBe('UNSTABLE')
    expect(tracker.onFrame(res(b))).toBe('UNSTABLE')
    expect(tracker.onFrame(res(b))).toBe('NEW_BOARD')
    expect(equal(b, tracker.confirmed!.canonical)).toBe(true)
  })

  it('子数跳变超容差被拒绝并保持原局面', () => {
    const start = canonicalStart()
    const tracker = new BoardTracker(3)
    tracker.reset(true)
    for (let i = 0; i < 3; i++) tracker.onFrame(res(start))

    // 从 32 子开局骤然到 8 子残局：只可能是局部遮挡/幻觉帧，必须拒绝并保持原局面
    const b = endgameBoard()
    for (let i = 0; i < 3; i++) {
      expect(tracker.onFrame(res(b))).toBe('UNSTABLE')
    }
    expect(equal(start, tracker.confirmed!.canonical)).toBe(true)

    // 恢复正常帧后照常同步
    expect(tracker.onFrame(res(start))).toBe('SAME_BOARD')
  })

  it('忽略非法帧并检测新对局', () => {
    const start = canonicalStart()
    const tracker = new BoardTracker(3)
    tracker.reset(true)
    for (let i = 0; i < 3; i++) tracker.onFrame(res(start))

    // 一帧坏结果（例如动画/遮挡导致帅将缺失）
    const occluded = start.slice()
    occluded[at(4, 9)] = Piece.EMPTY
    expect(tracker.onFrame(res(occluded, false))).toBe('UNSTABLE')
    // 回到正确局面
    expect(tracker.onFrame(res(start))).toBe('SAME_BOARD')

    // 重开：回到完全一致的开局 => NEW_GAME，轮次重置红先
    const changed = midBoard()
    for (let i = 0; i < 3; i++) tracker.onFrame(res(changed))
    expect(tracker.redGo).toBe(false)
    expect(tracker.onFrame(res(start))).toBe('NEW_GAME')
    expect(tracker.redGo).toBe(true)
  })

  it('restore 回退后可重新同步', () => {
    const start = canonicalStart()
    const mid = midBoard()

    const tracker = new BoardTracker(3)
    tracker.reset(true)
    for (let i = 0; i < 3; i++) tracker.onFrame(res(start))
    for (let i = 0; i < 3; i++) tracker.onFrame(res(mid))
    expect(tracker.redGo).toBe(false)

    // 悔棋：恢复到开局（红先），随后同局面帧应视为未变化
    tracker.restore(res(start), true)
    expect(tracker.redGo).toBe(true)
    expect(tracker.onFrame(res(start))).toBe('SAME_BOARD')
    expect(tracker.redGo).toBe(true)

    // 屏幕仍是走子后的局面：照常重新确认，轮次按移动方翻转
    for (let i = 0; i < 3; i++) tracker.onFrame(res(mid))
    expect(tracker.redGo).toBe(false)
  })
})
