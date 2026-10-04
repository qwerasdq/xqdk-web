// 检测 → 9×10 映射测试，移植自 Android DetectionBoardMapperTest.kt（7 用例）
import { describe, expect, it } from 'vitest'
import { map } from './boardMapper'
import { canonicalStart, equal, validate } from './assistBoard'
import { PIECE_CODES, LABEL_BOARD } from './labels'
import { YoloDetection } from './types'
import * as Piece from '../xiangqi/piece'
import { BOARD_H, BOARD_W } from './types'

const BOARD_X0 = 100
const BOARD_Y0 = 200
const CELL_W = 90
const CELL_H = 80
const PIECE_SIZE = 66
const FRAME_W = 1080
const FRAME_H = 2400

function labelIdOf(piece: number): number {
  return PIECE_CODES.indexOf(piece)
}

function pieceDet(piece: number, col: number, row: number, score = 0.9): YoloDetection {
  const cx = BOARD_X0 + col * CELL_W
  const cy = BOARD_Y0 + row * CELL_H
  return new YoloDetection(labelIdOf(piece), score, cx, cy, PIECE_SIZE, PIECE_SIZE)
}

const boardDet = new YoloDetection(
  LABEL_BOARD, 0.95,
  BOARD_X0 + 4 * CELL_W, BOARD_Y0 + 4.5 * CELL_H, 8 * CELL_W, 9 * CELL_H,
)

function startDetections(flipped: boolean): YoloDetection[] {
  const start = canonicalStart()
  const out: YoloDetection[] = []
  for (let y = 0; y < BOARD_H; y++) {
    for (let x = 0; x < BOARD_W; x++) {
      const p = start[y * BOARD_W + x]!
      if (p === Piece.EMPTY) continue
      if (flipped) {
        // 屏幕上红在上：canonical(x,y) 出现在屏幕 (8-x, 9-y)
        out.push(pieceDet(p, BOARD_W - 1 - x, BOARD_H - 1 - y))
      } else {
        out.push(pieceDet(p, x, y))
      }
    }
  }
  return [...out, boardDet]
}

const at = (x: number, y: number): number => y * BOARD_W + x

describe('检测 → 棋盘映射', () => {
  it('标准开局映射为 canonical 开局', () => {
    const mapped = map(startDetections(false), FRAME_W, FRAME_H)
    expect(mapped).not.toBeNull()
    expect(equal(canonicalStart(), mapped!.canonical)).toBe(true)
    expect(mapped!.orientation).toBe('STANDARD')
    expect(mapped!.pieceCount).toBe(32)
    expect(mapped!.dropped).toBe(0)
    expect(mapped!.avgScore).toBeGreaterThan(0.85)
    expect(mapped!.grid).not.toBeNull()
  })

  it('翻转（红在上）开局映射为 canonical 开局且朝向 FLIPPED', () => {
    const mapped = map(startDetections(true), FRAME_W, FRAME_H)
    expect(mapped).not.toBeNull()
    expect(equal(canonicalStart(), mapped!.canonical)).toBe(true)
    expect(mapped!.orientation).toBe('FLIPPED')
    expect(mapped!.pieceCount).toBe(32)
  })

  it('越界棋子丢弃，同格冲突高分胜出', () => {
    // 补足 minPieces 门槛的无关棋子（分散在不同格）
    const filler: YoloDetection[] = [
      [Piece.WJU, 0, 9], [Piece.WXIANG, 2, 9], [Piece.WSHI, 3, 9],
      [Piece.WMA, 7, 9], [Piece.WXIANG, 6, 9], [Piece.WSHI, 5, 9],
      [Piece.WBING, 0, 6], [Piece.WBING, 2, 6], [Piece.WBING, 4, 6],
      [Piece.WBING, 6, 6], [Piece.WBING, 8, 6],
    ].map(([p, x, y]) => pieceDet(p!, x!, y!))
    const dets: YoloDetection[] = [
      boardDet,
      pieceDet(Piece.WSHUAI, 4, 9),
      // 越界：屏幕顶行之外（row=-1）
      new YoloDetection(labelIdOf(Piece.BSHI), 0.91, BOARD_X0 + 4 * CELL_W, BOARD_Y0 - CELL_H, PIECE_SIZE, PIECE_SIZE),
      ...filler,
      // 同格冲突：低分先来、高分留下
      pieceDet(Piece.WPAO, 1, 7, 0.8),
      pieceDet(Piece.WMA, 1, 7, 0.93),
    ]
    const mapped = map(dets, FRAME_W, FRAME_H)
    expect(mapped).not.toBeNull()
    expect(mapped!.screenRaw[at(1, 7)]).toBe(Piece.WMA)
    expect(mapped!.screenRaw[at(4, 9)]).toBe(Piece.WSHUAI)
    expect(mapped!.screenRaw[at(4, 0)]).toBe(Piece.EMPTY)
    expect(mapped!.dropped).toBe(1) // 越界 1（同格冲突由高分覆盖，不计丢弃）
  })

  it('无棋盘框时兜底用棋子包围盒', () => {
    const dets = startDetections(false).filter((d) => !d.isBoard)
    const mapped = map(dets, FRAME_W, FRAME_H)
    expect(mapped).not.toBeNull()
    expect(equal(canonicalStart(), mapped!.canonical)).toBe(true)
    expect(mapped!.pieceCount).toBe(32)
    expect(mapped!.grid).not.toBeNull()
  })

  it('子太少且无棋盘框返回 null', () => {
    const dets = [
      pieceDet(Piece.WSHUAI, 4, 9),
      pieceDet(Piece.WJU, 0, 9),
      pieceDet(Piece.BJIANG, 4, 0),
      pieceDet(Piece.BJU, 0, 0),
      pieceDet(Piece.WBING, 4, 6),
    ]
    expect(map(dets, FRAME_W, FRAME_H)).toBeNull()
  })

  it('稀疏残局（8 子）有棋盘框时正常映射', () => {
    const dets = [
      boardDet,
      pieceDet(Piece.WSHUAI, 4, 9),
      pieceDet(Piece.WSHI, 3, 9),
      pieceDet(Piece.WSHI, 5, 9),
      pieceDet(Piece.WMA, 4, 5),
      pieceDet(Piece.BJIANG, 4, 0),
      pieceDet(Piece.BXIANG, 4, 2),
      pieceDet(Piece.BXIANG, 6, 4),
      pieceDet(Piece.BZU, 6, 6),
    ]
    const mapped = map(dets, FRAME_W, FRAME_H)
    expect(mapped).not.toBeNull()
    expect(mapped!.pieceCount).toBe(8)
    expect(validate(mapped!.canonical)).toEqual([])
  })

  it('畸形棋盘框退回包围盒兜底', () => {
    // board 框长宽比异常（1:2）=> 不应作为锚点，走 bbox 兜底
    const badBoard = new YoloDetection(
      LABEL_BOARD, 0.95,
      BOARD_X0 + 4 * CELL_W, BOARD_Y0 + 4.5 * CELL_H, 4 * CELL_W, 9 * CELL_H,
    )
    const dets = [...startDetections(false).filter((d) => !d.isBoard), badBoard]
    const mapped = map(dets, FRAME_W, FRAME_H)
    expect(mapped).not.toBeNull()
    expect(equal(canonicalStart(), mapped!.canonical)).toBe(true)
  })
})
