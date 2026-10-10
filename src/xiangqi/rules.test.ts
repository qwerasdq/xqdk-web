// 规则层单元测试：对照 chess-dike Android 版行为与 xqbase 规范
// 注意：xqbase FEN 第一行是 y=0（黑方底线），从上到下排列
import { describe, it, expect } from 'vitest'
import { Board } from './board'
import { Game, GameStatus } from './game'
import {
  legalMoves,
  possibleToPositions,
  isJiangShuaiInDanger,
  findJiangShuaiPos,
  allLegalMoves,
} from './rule'
import { ucciToChinese } from './move'
import * as Piece from './piece'
import { Position } from './position'

const INITIAL_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'

// 黑将 (4,0)，红炮 (4,1)(4,2)，红马 (6,2)，红车 (3,9)(5,9)，红帅 (4,9)
// 重炮杀：炮(4,2) 架炮(4,1) 将军；将走 (3,0)/(5,0) 被车攻，(4,1) 吃炮后被马 (6,2) 攻（蹩腿 (5,2) 空）
const CHECKMATE_FEN = '4k4/4C4/4C1N2/9/9/9/9/9/9/3RKR3 b - - 0 1'

// 黑将 (4,0)，红兵 (3,1)(5,1)，红帅 (3,9)：将未被将军但三处去路全被兵控 → 困毙
const STALEMATE_FEN = '4k4/3P1P3/9/9/9/9/9/9/9/3K5 b - - 0 1'

// 红车 (0,5)、黑车 (8,5)：双车循环 2 次后初始局面第 3 次出现 → 判和
const DRAW_FEN = '4k4/9/9/9/9/R7r/9/9/9/3K5 w - - 0 1'

// 红车 (4,5)、黑将 (4,0)、红帅 (3,9)：红车左右来回连续将军
const PERPETUAL_FEN = '4k4/9/9/9/9/4R4/9/9/9/3K5 w - - 0 1'

// 黑车 (4,1) 挡在红车 (4,9) 与黑将 (4,0) 之间：黑车走开即送将
const SENDCHECK_FEN = '4k4/4r4/9/9/9/9/9/9/9/3KR3 b - - 0 1'

function ucciToPos(ucci: string): [Position, Position] {
  const from = new Position(ucci.charCodeAt(0) - 97, 9 - (ucci.charCodeAt(1) - 48))
  const to = new Position(ucci.charCodeAt(2) - 97, 9 - (ucci.charCodeAt(3) - 48))
  return [from, to]
}

function playSeq(g: Game, seq: string[]): GameStatus {
  let state = g.updateGameStatus()
  for (const ucci of seq) {
    if (
      state.status !== GameStatus.MOVE &&
      state.status !== GameStatus.CHECK &&
      state.status !== GameStatus.SELECT
    ) {
      break
    }
    const [from, to] = ucciToPos(ucci)
    state = g.movePiece(from, to)
  }
  return state.status
}

describe('Board FEN', () => {
  it('初始局面 FEN 输出符合 xqbase 格式', () => {
    const b = new Board()
    expect(b.toFENString()).toBe(INITIAL_FEN)
  })

  it('FEN 解析往返一致', () => {
    const b = new Board()
    b.restoreFromFEN(INITIAL_FEN)
    expect(b.toFENString()).toBe(INITIAL_FEN)
  })

  it('短格式 FEN（缺后半段）自动补全', () => {
    const b = new Board()
    const ok = b.restoreFromFEN('4k4/9/9/9/9/9/9/9/9/4K4 b')
    expect(ok).toBe(true)
    expect(b.bRedGo).toBe(false)
    expect(b.rounds).toBe(1)
  })

  it('Zobrist 键：相同局面相同键，走子后键变化', () => {
    const b1 = new Board()
    const b2 = new Board()
    expect(b1.getZobrist(true)).toBe(b2.getZobrist(true))
    b1.doMove(new Position(7, 7), new Position(4, 7)) // 炮二平五
    expect(b1.getZobrist(false)).not.toBe(b2.getZobrist(true))
  })
})

describe('中文记谱（对照 xqbase 规范）', () => {
  it('炮二平五 / 马八进七 / 兵三进一', () => {
    const b = new Board()
    expect(ucciToChinese('h2e2', b)).toBe('炮二平五')
    expect(ucciToChinese('b0c2', b)).toBe('马八进七')
    expect(ucciToChinese('g3g4', b)).toBe('兵三进一')
  })

  it('黑方：卒3进1 / 马8进7（阿拉伯数字）', () => {
    const b = new Board()
    b.doMove(new Position(7, 7), new Position(4, 7)) // 炮二平五
    expect(ucciToChinese('c6c5', b)).toBe('卒3进1')
    expect(ucciToChinese('h9g7', b)).toBe('马8进7')
  })

  it('车一平二（平移记目标横坐标）', () => {
    const b = new Board()
    b.clear()
    b.setPieceByXY(8, 9, Piece.WJU)
    b.setPieceByXY(4, 9, Piece.WSHUAI)
    b.setPieceByXY(4, 0, Piece.BJIANG)
    expect(ucciToChinese('i0h0', b)).toBe('车一平二')
  })

  it('同列双车：前/后消歧', () => {
    const b = new Board()
    b.clear()
    b.setPieceByXY(4, 8, Piece.WJU)
    b.setPieceByXY(4, 9, Piece.WJU)
    b.setPieceByXY(3, 9, Piece.WSHUAI)
    b.setPieceByXY(4, 0, Piece.BJIANG)
    // 红方从上往下数：y=8 的车是"前"，y=9 的车是"后"
    expect(ucciToChinese('e1e2', b)).toBe('前车进一')
    expect(ucciToChinese('e0e1', b)).toBe('后车进一')
  })

  it('帅四平五', () => {
    const b = new Board()
    b.clear()
    b.setPieceByXY(5, 9, Piece.WSHUAI)
    b.setPieceByXY(4, 0, Piece.BJIANG)
    expect(ucciToChinese('f0e0', b)).toBe('帅四平五')
  })
})

describe('走法生成与合法性', () => {
  it('马蹩腿：马八进七合法，马脚被占则非法', () => {
    const b = new Board()
    const moves = legalMoves(Piece.WMA, 1, 9, b)
    expect(moves.some((p) => p.equals(new Position(2, 7)))).toBe(true)
    b.setPieceByXY(1, 8, Piece.WJU) // 占马脚
    const moves2 = legalMoves(Piece.WMA, 1, 9, b)
    expect(moves2.some((p) => p.equals(new Position(2, 7)))).toBe(false)
  })

  it('象塞眼', () => {
    const b = new Board()
    b.clear()
    b.setPieceByXY(2, 9, Piece.WXIANG)
    b.setPieceByXY(4, 9, Piece.WSHUAI)
    b.setPieceByXY(4, 0, Piece.BJIANG)
    const moves = legalMoves(Piece.WXIANG, 2, 9, b)
    expect(moves.some((p) => p.equals(new Position(4, 7)))).toBe(true)
    b.setPieceByXY(3, 8, Piece.BZU) // 塞象眼
    const moves2 = legalMoves(Piece.WXIANG, 2, 9, b)
    expect(moves2.some((p) => p.equals(new Position(4, 7)))).toBe(false)
  })

  it('送将过滤：黑车不能离开帅车之间的遮挡列', () => {
    const b = new Board()
    b.restoreFromFEN(SENDCHECK_FEN)
    const moves = legalMoves(Piece.BJU, 4, 1, b)
    expect(moves.some((p) => p.equals(new Position(0, 1)))).toBe(false)
    expect(moves.some((p) => p.equals(new Position(3, 1)))).toBe(false)
    expect(moves.some((p) => p.equals(new Position(4, 2)))).toBe(true)
  })

  it('将军检测：黑将被红车将军', () => {
    const b = new Board()
    b.restoreFromFEN(SENDCHECK_FEN)
    const king = findJiangShuaiPos(Piece.BJIANG, b)!
    expect(isJiangShuaiInDanger(Piece.BJIANG, king, b)).toBe(false)
    b.setPieceByXY(4, 1, Piece.EMPTY) // 移除遮挡车
    expect(isJiangShuaiInDanger(Piece.BJIANG, king, b)).toBe(true)
  })
})

describe('终局判定', () => {
  it('将死（重炮杀 + 马封将路）', () => {
    const g = new Game()
    g.restoreFromFEN(CHECKMATE_FEN)
    expect(g.updateGameStatus().status).toBe(GameStatus.CHECKMATE)
  })

  it('困毙判负：黑将无子可动且未被将军', () => {
    const g = new Game()
    g.restoreFromFEN(STALEMATE_FEN)
    expect(g.updateGameStatus().status).toBe(GameStatus.STALEMATE)
  })

  it('重复局面判和：双车循环 2 次后判和', () => {
    const g = new Game()
    g.restoreFromFEN(DRAW_FEN)
    const status = playSeq(g, ['a4b4', 'i4h4', 'b4a4', 'h4i4', 'a4b4', 'i4h4', 'b4a4', 'h4i4'])
    expect(status).toBe(GameStatus.DRAW)
  })

  it('长将判负：红车连续将军 8 次', () => {
    const g = new Game()
    g.restoreFromFEN(PERPETUAL_FEN)
    // 红车 (4,5)↔(4,6) 左右平移将军，黑将 (4,0)↔(5,0) 躲避
    const seq = [
      'e4e3', 'e9f9', 'e3f3', 'f9e9',
      'f3e3', 'e9f9', 'e3f3', 'f9e9',
      'f3e3', 'e9f9', 'e3f3', 'f9e9',
      'f3e3', 'e9f9', 'e3f3', 'f9e9',
    ]
    let state = g.updateGameStatus()
    for (const ucci of seq) {
      if (state.status !== GameStatus.MOVE && state.status !== GameStatus.CHECK) break
      const [from, to] = ucciToPos(ucci)
      state = g.movePiece(from, to)
    }
    expect(state.status).toBe(GameStatus.PERPETUAL_CHECK)
    expect(state.perpetualCheckSide).toBe('red')
  })

  it('悔棋恢复局面与局面计数', () => {
    const g = new Game()
    const [from, to] = ucciToPos('h2e2')
    g.movePiece(from, to)
    expect(g.undoMove()).not.toBeNull()
    expect(g.currentBoard.toFENString()).toBe(INITIAL_FEN)
    const s = g.movePiece(from, to)
    expect(s.status).toBe(GameStatus.MOVE)
  })
})

describe('possibleToPositions 与 Android 版一致性抽查', () => {
  it('初始局面各棋子可走点数', () => {
    const b = new Board()
    expect(possibleToPositions(Piece.WMA, 1, 9, b).length).toBe(2) // 马八进七/进九
    expect(possibleToPositions(Piece.WJU, 0, 9, b).length).toBe(2) // 车九进一/进二（y=6 己方兵挡）
    expect(possibleToPositions(Piece.WPAO, 1, 7, b).length).toBe(12) // 炮八：横向6 + 纵向5移1吃
    expect(possibleToPositions(Piece.WBING, 4, 6, b).length).toBe(1) // 兵五进一
  })
})

// 黑将 (3,0)，黑卒 (3,7)(5,8)，红帅 (4,9)：黑卒 (3,7)->(3,8) 后封死红帅全部去路
const DELIVER_STALEMATE_FEN = '3k5/9/9/9/9/9/9/3p5/5p3/4K4 b - - 0 1'

describe('困毙（由走子方造成）', () => {
  it('走子前对方尚有逃格，走子后无着可走 -> 对方判负（走子方获胜）', () => {
    const g = new Game()
    expect(g.restoreFromFEN(DELIVER_STALEMATE_FEN)).toBe(true)

    // 走子前：红帅只剩 (3,9)=d0 一个逃格
    const before = g.currentBoard.clone()
    before.bRedGo = true
    expect(allLegalMoves(before)).toEqual(['e0d0'])

    // 黑卒 (3,7)=d2 -> (3,8)=d1，封死 d0
    const st = g.movePiece(new Position(3, 7), new Position(3, 8))
    expect(st.status).toBe(GameStatus.STALEMATE)
    expect(g.isGameOver).toBe(true)
  })
})

describe('allLegalMoves（当前行棋方全部合法着法）', () => {
  function load(fen: string): Board {
    const b = new Board()
    expect(b.restoreFromFEN(fen)).toBe(true)
    return b
  }

  it('初始局面红先：44 着，UCCI 格式正确且无重复', () => {
    const moves = allLegalMoves(load(INITIAL_FEN))
    expect(moves.length).toBe(44) // 象棋开局着法数（与 xqbase 一致）
    expect(moves.every((m) => /^[a-i][0-9][a-i][0-9]$/.test(m))).toBe(true)
    expect(new Set(moves).size).toBe(moves.length)
  })

  it('黑先时数量相同、着法不同（只列当前行棋方）', () => {
    const red = allLegalMoves(load(INITIAL_FEN))
    const black = allLegalMoves(load(INITIAL_FEN.replace(' w ', ' b ')))
    expect(black.length).toBe(44)
    // 红方着法起点的行号是 0/2/3（红方半场），黑方是 6/7/9
    expect(red.every((m) => Number(m[1]) <= 3)).toBe(true)
    expect(black.every((m) => Number(m[1]) >= 6)).toBe(true)
  })

  it('被牵制的黑车不能离线（走开即送将）', () => {
    // 黑车 (4,1)=e8 挡在红车 (4,9) 与黑将 (4,0) 之间
    const moves = allLegalMoves(load(SENDCHECK_FEN))
    expect(moves).toContain('e8e7') // 沿线移动仍挡将，合法
    expect(moves).not.toContain('e8d8') // 离线即送将，被 legalMoves 过滤
    expect(moves.filter((m) => m.startsWith('e8')).every((m) => m[2] === 'e')).toBe(true)
  })

  it('困毙局面（行棋方无着可走）返回空数组', () => {
    expect(allLegalMoves(load(STALEMATE_FEN))).toEqual([])
  })
})
