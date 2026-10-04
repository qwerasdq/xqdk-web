// 棋盘快照工具测试，移植自 Android AssistCoreTest.kt（AssistBoard + grid 部分）
import { describe, expect, it } from 'vitest'
import {
  START_FEN,
  applyUcci,
  canonicalStart,
  equal,
  movedSide,
  piecesFromFen,
  toFen,
  validate,
} from './assistBoard'
import { gridFromPxCorners } from './boardMapper'
import * as Piece from '../xiangqi/piece'
import { BOARD_W } from './types'

const at = (x: number, y: number): number => y * BOARD_W + x

describe('AssistBoard（移植自 AssistCoreTest）', () => {
  it('开局 FEN 往返一致', () => {
    const start = canonicalStart()
    const fen = toFen(start, true)
    expect(fen).toBe(START_FEN)
    expect(equal(start, piecesFromFen(fen))).toBe(true)
  })

  it('FEN 行棋方红用 w 黑用 b', () => {
    const start = canonicalStart()
    expect(toFen(start, true).endsWith('w - - 0 1')).toBe(true)
    expect(toFen(start, false).endsWith('b - - 0 1')).toBe(true)
  })

  it('movedSide 识别普通走子与吃子', () => {
    const start = canonicalStart()
    // 红炮二平五：h2e2 => 内部 (7,7)->(4,7)
    const mid = start.slice()
    mid[at(4, 7)] = mid[at(7, 7)]!
    mid[at(7, 7)] = Piece.EMPTY
    expect(movedSide(start, mid)).toBe('red')

    // 黑方接走：黑炮 (x7,y2)->(x4,y2)（Kotlin [y][x] 索引）
    const mid2 = mid.slice()
    mid2[at(4, 2)] = mid2[at(7, 2)]!
    mid2[at(7, 2)] = Piece.EMPTY
    expect(movedSide(mid, mid2)).toBe('black')

    // 吃子：红炮 (4,7) 吃 (4,4) 黑炮（源格在比较前已为空 => diff 只含目标格）
    const cap = mid.slice()
    cap[at(4, 7)] = Piece.EMPTY
    cap[at(4, 4)] = Piece.BPAO
    const cap2 = cap.slice()
    cap2[at(4, 4)] = Piece.WPAO
    expect(movedSide(cap, cap2)).toBe('red')
  })

  it('movedSide 对无效大变动作返回 null', () => {
    const start = canonicalStart()
    const other = canonicalStart()
    expect(movedSide(start, other)).toBeNull() // 无变化
    const weird = start.slice()
    weird[at(4, 9)] = Piece.EMPTY // 帅没了
    weird[at(4, 0)] = Piece.EMPTY // 将没了
    expect(movedSide(start, weird)).toBeNull()
  })

  it('validate 通过开局并识别损坏棋盘', () => {
    const start = canonicalStart()
    expect(validate(start)).toEqual([])
    const bad = start.slice()
    bad[at(4, 9)] = Piece.EMPTY // 帅没了
    expect(validate(bad)).not.toEqual([])
    const tooMany = start.slice()
    tooMany[at(4, 5)] = Piece.WPAO // 三个红炮
    expect(validate(tooMany).some((s) => s.includes('炮'))).toBe(true)
  })

  it('validate 识别将帅照面', () => {
    const start = canonicalStart()
    const facing = start.slice()
    // 清空 4 列中间的子（象/炮等），制造将帅照面
    for (let y = 1; y <= 8; y++) facing[at(4, y)] = Piece.EMPTY
    facing[at(4, 0)] = Piece.BJIANG
    facing[at(4, 9)] = Piece.WSHUAI
    expect(validate(facing).some((s) => s.includes('照面'))).toBe(true)
  })

  it('8 子稀疏残局通过校验', () => {
    const b = new Uint8Array(90)
    b[at(4, 9)] = Piece.WSHUAI
    b[at(3, 9)] = Piece.WSHI
    b[at(5, 9)] = Piece.WSHI
    b[at(4, 5)] = Piece.WMA
    b[at(4, 0)] = Piece.BJIANG
    b[at(4, 2)] = Piece.BXIANG
    b[at(6, 4)] = Piece.BXIANG
    b[at(6, 6)] = Piece.BZU
    let n = 0
    for (const p of b) if (p !== Piece.EMPTY) n++
    expect(n).toBe(8)
    expect(validate(b)).toEqual([])
  })

  it('手动走子语义与 applyUcci 一致', () => {
    const manual = piecesFromFen(START_FEN)
    const piece = manual[at(7, 7)]!
    manual[at(7, 7)] = Piece.EMPTY
    manual[at(4, 7)] = piece
    const manualFen = toFen(manual, false) // 红已走 => 轮到黑
    expect(applyUcci(START_FEN, 'h2e2')).toBe(manualFen)
  })

  it('applyUcci 走子并翻转行棋方', () => {
    // 红炮二平五：h2e2 => 内部 (7,7)->(4,7)，行棋方 w→b
    const fen2 = applyUcci(START_FEN, 'h2e2')
    expect(fen2).toBe('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C2C4/9/RNBAKABNR b - - 0 1')
    const fen3 = applyUcci(fen2, 'b7e7')
    expect(fen3.endsWith('w - - 0 1')).toBe(true)
    // 非法输入原样返回：着法过短 / 文件越界 / 起点无子
    expect(applyUcci(START_FEN, 'zz')).toBe(START_FEN)
    expect(applyUcci(START_FEN, 'j1j2')).toBe(START_FEN)
    expect(applyUcci(START_FEN, 'a4a5')).toBe(START_FEN)
  })

  it('网格由像素角点归一化（任意对角顺序）', () => {
    const grid = gridFromPxCorners(600, 1080, 200, 120, 1000, 1200)
    expect(grid).not.toBeNull()
    expect(grid!.nx0).toBeCloseTo(0.2, 9)
    expect(grid!.nx1).toBeCloseTo(0.6, 9)
    expect(grid!.ny0).toBeCloseTo(0.1, 9)
    expect(grid!.ny1).toBeCloseTo(0.9, 9)
  })
})
