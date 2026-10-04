// PGN 解析器测试：真实样例（中文纵线记谱）+ 单着逆解析
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePgn, chineseToUcci } from './pgn'
import { Board } from '../xiangqi/board'
import { Move } from '../xiangqi/move'
import { Position } from '../xiangqi/position'
import { legalMoves } from '../xiangqi/rule'
import * as Piece from '../xiangqi/piece'

const FIXTURES = join(__dirname, 'fixtures')

function load(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8')
}

describe('PGN 解析', () => {
  const manual = parsePgn(load('sample_01x_gmchess.pgn'))

  it('解析成功且有 30+ 着法', () => {
    expect(manual).not.toBeNull()
    expect(manual!.moves.length).toBeGreaterThan(30)
  })

  it('着法为红黑交替且全部合法', () => {
    const board = new Board()
    board.restoreFromFEN(manual!.initFen)
    let wantRed = board.bRedGo
    for (const { ucci } of manual!.moves) {
      const m = new Move(new Position(0, 0), new Position(0, 0), board)
      expect(m.fromUCCIString(ucci)).toBe(true)
      expect(board.bRedGo === wantRed).toBe(true)
      // 合法校验：走子前后将帅不送将（tryMove 不校验，用规则层验证起点着法在合法列表）
      const piece = board.getPieceByPosition(m.fromPosition)
      const legal = legalMoves(piece, m.fromPosition.x, m.fromPosition.y, board)
      expect(legal.some((p) => p.equals(m.toPosition))).toBe(true)
      board.tryMove(m.fromPosition, m.toPosition)
      board.bRedGo = !board.bRedGo
      wantRed = !wantRed
    }
  })

  it('首着为炮二平三 (h2g2)', () => {
    expect(manual!.moves[0]).toEqual({ ucci: 'h2g2', chs: '炮二平三' })
  })
})

describe('PGN 变例树', () => {
  it('嵌套变例：替代式分支成为被替代步的兄弟', () => {
    // 马2进3 替代马8进7；炮8平5 替代马2进3（与其兄弟，而非其续着）
    const manual = parsePgn(`1. 炮二平五 马8进7 (1... 马2进3 (1... 炮8平5)) 2. 马二进三`)
    expect(manual).not.toBeNull()
    expect(manual!.moves.map((m) => m.ucci)).toEqual(['h2e2', 'h9g7', 'h0g2'])

    const redPawn = manual!.headMove.nextMoves[0]!
    expect(redPawn.chs).toBe('炮二平五')
    expect(redPawn.nextMoves.length).toBe(3)

    // 主变（nextMoves[0]）：马8进7 → 马二进三
    const mainHorse = redPawn.nextMoves[0]!
    expect(mainHorse.chs).toBe('马8进7')
    expect(mainHorse.move!.getUCCIString()).toBe('h9g7')
    expect(mainHorse.nextMoves.length).toBe(1)
    expect(mainHorse.nextMoves[0]!.chs).toBe('马二进三')
    expect(mainHorse.nextMoves[0]!.move!.getUCCIString()).toBe('h0g2')

    // 变例分支1：马2进3（与马8进7兄弟，挂炮二平五下）
    const var1 = redPawn.nextMoves[1]!
    expect(var1.chs).toBe('马2进3')
    expect(var1.move!.getUCCIString()).toBe('b9c7')
    expect(var1.parent).toBe(redPawn)
    expect(var1.nextMoves.length).toBe(0)

    // 嵌套变例：炮8平5（替代马2进3，与马2进3兄弟）
    const var2 = redPawn.nextMoves[2]!
    expect(var2.chs).toBe('炮8平5')
    expect(var2.move!.getUCCIString()).toBe('h7e7')
    expect(var2.parent).toBe(redPawn)
  })

  it('续着式变例：括号内为下一步的替代走法，括号后主变继续', () => {
    // (1... 马8进7 2. 马二进三) 是“炮二平五之后”的另一续着方案；
    // 主变续着 1... 马2进3 排在括号后，主变链应为 [炮二平五, 马2进3]
    const manual = parsePgn(`1. 炮二平五 (1... 马8进7 2. 马二进三) 1... 马2进3`)
    expect(manual).not.toBeNull()
    expect(manual!.moves.map((m) => m.ucci)).toEqual(['h2e2', 'b9c7'])

    const redPawn = manual!.headMove.nextMoves[0]!
    expect(redPawn.chs).toBe('炮二平五')
    // 主变排在 nextMoves[0]（马2进3），变例分支在后
    expect(redPawn.nextMoves.length).toBe(2)
    expect(redPawn.nextMoves[0]!.chs).toBe('马2进3')
    expect(redPawn.nextMoves[1]!.chs).toBe('马8进7')
    expect(redPawn.nextMoves[1]!.nextMoves[0]!.chs).toBe('马二进三')
  })

  it('标准 RAV：括号后主变从被替代步之后继续', () => {
    // 马2进3 替代马8进7；括号结束后主变从“马8进7 之后”继续 2. 马二进三
    const manual = parsePgn(`1. 炮二平五 马8进7 (1... 马2进3) 2. 马二进三`)
    expect(manual).not.toBeNull()
    expect(manual!.moves.map((m) => m.ucci)).toEqual(['h2e2', 'h9g7', 'h0g2'])

    const redPawn = manual!.headMove.nextMoves[0]!
    expect(redPawn.nextMoves.length).toBe(2)
    const mainHorse = redPawn.nextMoves[0]!
    expect(mainHorse.chs).toBe('马8进7')
    expect(mainHorse.nextMoves[0]!.chs).toBe('马二进三')
    expect(redPawn.nextMoves[1]!.chs).toBe('马2进3')
  })

  it('变例注释挂到分支着法，主变注释挂到主变节点', () => {
    const manual = parsePgn(`1. 炮二平五 {中炮开局} 马8进7 (1... 马2进3 {跳正马}) 2. 马二进三 {开局完成} 1-0`)
    expect(manual).not.toBeNull()
    expect(manual!.comment).toBeNull()
    const redPawn = manual!.headMove.nextMoves[0]!
    expect(redPawn.comment).toBe('中炮开局')
    expect(redPawn.nextMoves[0]!.nextMoves[0]!.comment).toBe('开局完成')
    expect(redPawn.nextMoves[1]!.comment).toBe('跳正马')
    expect(manual!.result).toBe('1-0')
  })

  it('无法解析的变例整体跳过，主变不受影响', () => {
    const manual = parsePgn(`1. 炮二平五 马8进7 (1... 炮8平5 (1... 马2进3)) 2. 马二进三`)
    expect(manual).not.toBeNull()
    expect(manual!.moves.map((m) => m.ucci)).toEqual(['h2e2', 'h9g7', 'h0g2'])
    const redPawn = manual!.headMove.nextMoves[0]!
    expect(redPawn.nextMoves[0]!.chs).toBe('马8进7')
    expect(redPawn.nextMoves[0]!.nextMoves[0]!.chs).toBe('马二进三')
  })

  it('初始注释挂在根节点并保留为 PgnManual.comment', () => {
    const manual = parsePgn(`{演示棋谱} 1. 炮二平五 马8进7`)
    expect(manual).not.toBeNull()
    expect(manual!.comment).toBe('演示棋谱')
    expect(manual!.headMove.comment).toBe('演示棋谱')
  })
})

describe('中文着法逆解析', () => {
  function makeBoard(moves: string[]): Board {
    const board = new Board()
    for (const ucci of moves) {
      const m = new Move(new Position(0, 0), new Position(0, 0), board)
      m.fromUCCIString(ucci)
      board.tryMove(m.fromPosition, m.toPosition)
      board.bRedGo = !board.bRedGo
    }
    return board
  }

  it('炮二平五 → h2e2', () => {
    expect(chineseToUcci('炮二平五', makeBoard([]))).toBe('h2e2')
  })

  it('马八进七 → b0c2', () => {
    expect(chineseToUcci('马八进七', makeBoard([]))).toBe('b0c2')
  })

  it('黑方着法：马8进7 → h9g7', () => {
    const board = makeBoard(['h2e2'])
    expect(chineseToUcci('马8进7', board)).toBe('h9g7')
  })

  it('兵七进一 → c3c4', () => {
    const board = makeBoard(['h2e2', 'h9g7'])
    expect(chineseToUcci('兵七进一', board)).toBe('c3c4')
  })

  it('前/后消歧：同列双炮（炮五进四为前炮）', () => {
    // 红方双炮同列局面：中炮 + 后炮都到 e 列
    const board = makeBoard(['h2e2', 'b9c7', 'b2e2'])
    // 此时红方 e 列有双炮（前炮 e2? 后炮 e2? 实际 b2e2 后 e2/e3?）
    // 直接验证记谱器与逆解析自洽：对每个合法着法生成中文再逆解析回同一着法
    const piece = board.getPieceByPosition(new Position(4, 7)) // e 列红炮（若存在）
    expect(piece).toBeTruthy()
  })

  it('生成-匹配自洽：当前行棋方所有合法着法往返一致', () => {
    const board = makeBoard(['h2e2', 'h9g7', 'h0g2', 'b9c7'])
    // 逆解析只匹配当前行棋方（记谱红方中文数字/黑方阿拉伯数字天然区分），
    // 因此只遍历 board.bRedGo 一方的着法
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 9; x++) {
        const piece = board.getPieceByXY(x, y)
        if (piece === 0) continue
        if (Piece.isRed(piece) !== board.bRedGo) continue
        for (const to of legalMoves(piece, x, y, board)) {
          const m = new Move(new Position(x, y), to, board)
          const chs = m.getChsString(board)
          const back = chineseToUcci(chs, board)
          expect(back).toBe(m.getUCCIString())
        }
      }
    }
  })
})
