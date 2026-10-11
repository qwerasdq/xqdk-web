// 逐格时间稳定器测试：单帧抖动吸收、多帧变化生效、返回值与内部状态隔离
import { describe, expect, it } from 'vitest'
import { CellStabilizer } from './cellStabilizer'
import * as Piece from '../xiangqi/piece'
import { BOARD_W, CELLS } from './types'

const at = (x: number, y: number): number => y * BOARD_W + x

function board(entries: Array<[number, number, number]>): Uint8Array {
  const b = new Uint8Array(CELLS)
  for (const [x, y, p] of entries) b[at(x, y)] = p
  return b
}

describe('CellStabilizer 逐格去抖', () => {
  it('首帧直接采纳（冷启动不引入延迟）', () => {
    const s = new CellStabilizer(CELLS, 2)
    expect(s.update(board([[4, 9, Piece.WSHUAI]]))[at(4, 9)]).toBe(Piece.WSHUAI)
  })

  it('单帧抖动被吸收：瞬时消失的棋子保持原值', () => {
    const s = new CellStabilizer(CELLS, 2)
    const base = board([[4, 9, Piece.WSHUAI]])
    s.update(base)
    // 该帧帅被遮挡（检测丢失）——只有 1 帧，不应生效
    expect(s.update(board([]))[at(4, 9)]).toBe(Piece.WSHUAI)
    // 恢复正常后照常
    expect(s.update(base)[at(4, 9)]).toBe(Piece.WSHUAI)
  })

  it('单帧误检被吸收：瞬时多出的棋子不会落到盘上', () => {
    const s = new CellStabilizer(CELLS, 2)
    const base = board([[4, 9, Piece.WSHUAI]])
    s.update(base)
    // 一帧在空点误检出一枚棋子
    expect(s.update(board([[4, 9, Piece.WSHUAI], [0, 0, Piece.BJU]]))[at(0, 0)]).toBe(Piece.EMPTY)
  })

  it('连续 needFrames 帧一致才改变该格（走子生效）', () => {
    const s = new CellStabilizer(CELLS, 3)
    const from = board([[4, 9, Piece.WSHUAI]])
    const to = board([[4, 8, Piece.WSHUAI]])
    s.update(from)
    expect(s.update(to)[at(4, 8)]).toBe(Piece.EMPTY) // 第 1 帧
    expect(s.update(to)[at(4, 8)]).toBe(Piece.EMPTY) // 第 2 帧
    expect(s.update(to)[at(4, 8)]).toBe(Piece.WSHUAI) // 第 3 帧生效
    expect(s.update(to)[at(4, 9)]).toBe(Piece.EMPTY) // 起点同步清空
  })

  it('相邻格跳变的抖动不会落到盘上', () => {
    const s = new CellStabilizer(CELLS, 2)
    const a = board([[4, 9, Piece.WSHUAI]])
    s.update(a)
    // 检测框在 (4,9)/(3,9) 之间来回跳：都不该被采纳
    expect(s.update(board([[3, 9, Piece.WSHUAI]]))[at(3, 9)]).toBe(Piece.EMPTY)
    expect(s.update(a)[at(4, 9)]).toBe(Piece.WSHUAI)
  })

  it('返回值与内部状态隔离：改返回值不影响后续帧', () => {
    const s = new CellStabilizer(CELLS, 2)
    const base = board([[0, 0, Piece.BJU]])
    const out = s.update(base)
    out[at(0, 0)] = Piece.EMPTY
    expect(s.update(base)[at(0, 0)]).toBe(Piece.BJU)
  })

  it('reset 后重新冷启动', () => {
    const s = new CellStabilizer(CELLS, 2)
    s.update(board([[1, 1, Piece.WMA]]))
    s.reset()
    const out = s.update(board([[2, 2, Piece.BMA]]))
    expect(out[at(1, 1)]).toBe(Piece.EMPTY)
    expect(out[at(2, 2)]).toBe(Piece.BMA)
  })

  it('长度不符时报错（防止坐标约定被悄悄改坏）', () => {
    const s = new CellStabilizer(CELLS, 2)
    expect(() => s.update(new Uint8Array(80))).toThrow(/不符/)
  })
})
