// sync.ts 调和测试：识别局面 → Game 的 1-ply / 2-ply / reload
import { describe, expect, it } from 'vitest'
import { Game } from '../xiangqi/game'
import { Position } from '../xiangqi/position'
import { canonicalStart, piecesFromFen, toFen } from './assistBoard'
import { planSync, reconcileGame } from './sync'
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

  it('无法匹配时 blocked，不自动改盘（防止识别错覆盖）', () => {
    const g = new Game()
    // 直接构造一个无法由开局 1-2 步到达的局面：帅移位到 e2
    const weird = canonicalStart().slice()
    weird[4 * 9 + 4] = weird[9 * 9 + 4]!
    weird[9 * 9 + 4] = 0
    const r = reconcileGame(g, mappedOf(weird), false)
    expect(r.applied).toBe('blocked')
    expect(g.currentBoard.getPieceByXY(4, 4)).toBe(0) // 未重载，原帅仍在底线
    expect(g.history.length).toBe(0)
  })

  it('planSync 对 move 不改变 Game，应用由 reconcileGame 执行', () => {
    const g = new Game()
    const plan = planSync(g, mappedOf(afterRedPawn()), true)
    expect(plan.kind).toBe('move')
    expect(plan.path?.[0]).toEqual({ from: new Position(7, 7), to: new Position(4, 7) })
    expect(g.history.length).toBe(0) // 纯计划未应用
    expect(g.currentBoard.bRedGo).toBe(true)
  })

  it('planSync 对 blocked 不改变 Game，需确认后再应用', () => {
    const g = new Game()
    const weird = canonicalStart().slice()
    weird[4 * 9 + 4] = weird[9 * 9 + 4]!
    weird[9 * 9 + 4] = 0
    const plan = planSync(g, mappedOf(weird), false)
    expect(plan.kind).toBe('blocked')
    expect(plan.fen).toBeTruthy()
    expect(g.history.length).toBe(0)
    expect(g.currentBoard.piece[9]![4]).toBe(1) // 未重载，原帅仍在底线
  })

  it('无效局面返回 noop 且不破坏 Game', () => {
    const g = new Game()
    const bad = new Uint8Array(80)
    const r = reconcileGame(g, mappedOf(bad), true)
    expect(r.applied).toBe('noop')
    expect(g.currentBoard.toFENString()).toBe('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1')
  })

  // 「本来该我走却显示轮到对方」：blocked 分支的 FEN 曾用 tracker 猜的 redGo，
  // 而首帧确认分支从不设置它，恒为初始值"红方走"。改为按 Game↔识别局面 diff 推回合。
  it('blocked：红方刚走完 → FEN 应为黑方走', () => {
    const g = new Game()
    // 造一个无法用 ≤2 步合法到达的红方走子（炮移到非法格），触发 blocked
    const weird = canonicalStart().slice()
    weird[5 * 9 + 4] = weird[7 * 9 + 7]! // 红炮挪到 (4,5)
    weird[7 * 9 + 7] = 0
    const plan = planSync(g, mappedOf(weird), true)
    expect(plan.kind).toBe('blocked')
    expect(plan.fen).toMatch(/ b /) // diff 判定红方刚走 → 轮到黑
  })

  it('blocked：黑方刚走完 → FEN 应为红方走', () => {
    const g = new Game()
    const weird = canonicalStart().slice()
    weird[4 * 9 + 4] = weird[2 * 9 + 1]! // 黑炮挪到 (4,4)
    weird[2 * 9 + 1] = 0
    const plan = planSync(g, mappedOf(weird), true)
    expect(plan.kind).toBe('blocked')
    expect(plan.fen).toMatch(/ w /)
  })

  it('blocked：识别噪声（移动方多子凭空出现）不猜轮次，退回 Game 当前行棋方', () => {
    // 网格漂移会让整行棋子"换位"：movedSide 可能仍判出红方，但红方一侧出现多个子，
    // 不是一次走子。此时应退回 Game 的 bRedGo，而不是按 diff 猜。
    const g = new Game()
    const noisy = canonicalStart().slice()
    // 红方一侧：帅、仕、相同时"消失"（模拟整行错位）
    noisy[9 * 9 + 4] = 0
    noisy[9 * 9 + 3] = 0
    noisy[9 * 9 + 5] = 0
    const plan = planSync(g, mappedOf(noisy), false)
    expect(plan.kind).toBe('blocked')
    expect(plan.reason).toBe('识别与当前局面差异过大')
    expect(plan.fen).toMatch(/ w /) // 退回 Game 当前（红方走），不按噪声 diff 猜
  })

  it('blocked：diff 判不出移动方时退回 Game 当前行棋方', () => {
    const g = new Game()
    // 红黑双方都有变化 → movedSide 返回 null，应退回 Game 的 bRedGo
    const weird = canonicalStart().slice()
    weird[5 * 9 + 4] = weird[7 * 9 + 7]!; weird[7 * 9 + 7] = 0
    weird[4 * 9 + 4] = weird[2 * 9 + 1]!; weird[2 * 9 + 1] = 0
    const plan = planSync(g, mappedOf(weird), false)
    expect(plan.kind).toBe('blocked')
    expect(plan.fen).toMatch(/ w /) // Game 当前是红方走（新局）
  })
})
