// sync.ts 调和测试：识别局面 → Game 的 1-ply / 2-ply / reload
import { describe, expect, it } from 'vitest'
import { Game } from '../xiangqi/game'
import { Position } from '../xiangqi/position'
import { canonicalStart, piecesFromFen, toFen } from './assistBoard'
import { reconcileGame } from './sync'
import type { MappedBoard } from './types'

function mappedOf(canonical: Uint8Array): MappedBoard {
  return {
    canonical,
    screenRaw: canonical,
    cellScores: new Float32Array(90),
    orientation: 'STANDARD',
    pieceCount: 32,
    avgScore: 0.9,
    dropped: 0,
    grid: null,
  }
}

/** 开局红炮二平五：内部 (x=7,y=7) → (x=4,y=7) */
function afterRedPawn(): Uint8Array {
  const p = canonicalStart().slice()
  const from = 7 * 9 + 7
  const to = 7 * 9 + 4
  p[to] = p[from]!
  p[from] = 0
  return p
}

/** 红炮二平五后黑炮右移（内部 (x=7,y=2) → (x=4,y=2)） */
function afterTwo(): Uint8Array {
  const p = afterRedPawn().slice()
  const from = 2 * 9 + 7
  const to = 2 * 9 + 4
  p[to] = p[from]!
  p[from] = 0
  return p
}

describe('reconcileGame', () => {
  it('同盘 noop', () => {
    const g = new Game()
    const r = reconcileGame(g, mappedOf(canonicalStart()), true)
    expect(r.applied).toBe('noop')
  })

  it('识别到当前行棋方 1 手：move 保留历史', () => {
    const g = new Game()
    const r = reconcileGame(g, mappedOf(afterRedPawn()), true)
    expect(r.applied).toBe('move')
    expect(r.move).toEqual({ from: new Position(7, 7), to: new Position(4, 7) })
    expect(g.history.length).toBe(1)
    expect(g.history[0]!.ucciString).toBe('h2e2')
    expect(g.currentBoard.bRedGo).toBe(false) // 同步 redGo 后轮到黑
  })

  it('识别到连续 2 手：move 保留两步历史', () => {
    const g = new Game()
    const r = reconcileGame(g, mappedOf(afterTwo()), true)
    expect(r.applied).toBe('move')
    expect(g.history.length).toBe(2)
    expect(g.currentBoard.bRedGo).toBe(true)
  })

  it('显式 redGo=false 的局面：move 后按识别轮次（黑先）', () => {
    const g = new Game()
    // 屏幕同步常见时序：黑刚走完，但 tracker 从局面 diff 判定下一手为黑（持续候补）
    // sync 只把 redGo 用于 reload；move 路径的轮次由 Game 保留（规则层权威）
    const r = reconcileGame(g, mappedOf(afterTwo()), false)
    expect(r.applied).toBe('move')
    expect(g.history.length).toBe(2)
    expect(g.currentBoard.bRedGo).toBe(true) // Game 历史仍是红先走完两步
  })

  it('无法匹配时 reload 为识别局面', () => {
    const g = new Game()
    // 直接构造一个无法由开局 1-2 步到达的局面：帅移位到 e2
    const weird = canonicalStart().slice()
    weird[4 * 9 + 4] = weird[9 * 9 + 4]!
    weird[9 * 9 + 4] = 0
    const r = reconcileGame(g, mappedOf(weird), false)
    expect(r.applied).toBe('reload')
    expect(g.currentBoard.getPieceByXY(4, 4)).toBe(1) // WSHUAI
    expect(g.history.length).toBe(0)
  })

  it('无效局面返回 noop 且不破坏 Game', () => {
    const g = new Game()
    const bad = new Uint8Array(80)
    const r = reconcileGame(g, mappedOf(bad), true)
    expect(r.applied).toBe('noop')
    expect(g.currentBoard.toFENString()).toBe('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1')
  })
})
