// 裁剪区域推导测试：外扩、帧内约束、过小回退、分块布局、目标尺度裁剪
import { describe, expect, it } from 'vitest'
import { PIECE_SCALE_MIN, TARGET_PIECE_PX, cropForPieceScale, cropFromGrid, tileRects } from './preprocess'
import { MODEL_INPUT } from './postprocess'

const FRAME_W = 1080
const FRAME_H = 2400

/** 归一化网格：棋盘框占帧的中间区域 */
function grid(nx0: number, ny0: number, nx1: number, ny1: number) {
  return { nx0, ny0, nx1, ny1 }
}

describe('cropFromGrid', () => {
  it('无网格时返回 null（调用方回退整帧）', () => {
    expect(cropFromGrid(null, FRAME_W, FRAME_H)).toBeNull()
  })

  it('外扩 20% 且落在帧内', () => {
    // 棋盘框：帧中央 50% 宽、60% 高
    const c = cropFromGrid(grid(0.25, 0.2, 0.75, 0.8), FRAME_W, FRAME_H)!
    const bw = 0.5 * FRAME_W
    const bh = 0.6 * FRAME_H
    expect(c.w).toBeCloseTo(bw * 1.4, 5)
    expect(c.h).toBeCloseTo(bh * 1.4, 5)
    // 中心不变
    expect(c.x0 + c.w / 2).toBeCloseTo(0.5 * FRAME_W, 5)
    expect(c.y0 + c.h / 2).toBeCloseTo(0.5 * FRAME_H, 5)
  })

  it('贴边棋盘外扩后被夹到帧内', () => {
    const c = cropFromGrid(grid(0, 0, 1, 1), FRAME_W, FRAME_H)!
    expect(c.x0).toBe(0)
    expect(c.y0).toBe(0)
    expect(c.w).toBe(FRAME_W)
    expect(c.h).toBe(FRAME_H)
  })

  it('区域过小时返回 null（避免裁到无意义小框）', () => {
    // 极小棋盘框：外扩后仍不足 64px
    expect(cropFromGrid(grid(0.5, 0.5, 0.52, 0.52), FRAME_W, FRAME_H)).toBeNull()
  })

  it('自定义 margin', () => {
    const c = cropFromGrid(grid(0.25, 0.25, 0.75, 0.75), FRAME_W, FRAME_H, 0)!
    expect(c.w).toBeCloseTo(0.5 * FRAME_W, 5)
    expect(c.h).toBeCloseTo(0.5 * FRAME_H, 5)
  })
})

describe('cropForPieceScale', () => {
  /** 棋子经该裁剪后落在 640 输入里的像素数（letterbox 由长边决定） */
  function piecePxInInput(pieceSize: number, crop: { w: number; h: number }): number {
    return pieceSize * Math.min(MODEL_INPUT / crop.w, MODEL_INPUT / crop.h)
  }

  it('无网格 / 无棋子尺度时返回 null', () => {
    expect(cropForPieceScale(null, 30, 1920, 1080)).toBeNull()
    expect(cropForPieceScale(grid(0.1, 0.1, 0.4, 0.6), 0, 1920, 1080)).toBeNull()
  })

  it('整帧尺度已达下界时不裁剪（模拟器 240×445：棋子约 26px → 输入域约 37px）', () => {
    // 模拟器捕获整帧就是棋盘，硬裁会把棋子推到 51–67px（分布外）→ 黑车被判成卒
    const c = cropForPieceScale(grid(0.05, 0.02, 0.95, 0.98), 26, 240, 445)
    expect(c).toBeNull()
    expect(piecePxInInput(26, { w: 240, h: 445 })).toBeGreaterThanOrEqual(PIECE_SCALE_MIN)
  })

  it('整帧尺度不足时按目标尺度裁方形（1080p：棋盘 400px → 输入域约 16px）', () => {
    // 1920×1080 帧内棋盘 400×444，棋子 47.8px → 整帧 letterbox 后仅 15.9px，会错 13 格
    const c = cropForPieceScale(grid(200 / 1920, 100 / 1080, 600 / 1920, 544 / 1080), 47.8, 1920, 1080)!
    expect(c).not.toBeNull()
    expect(c.w).toBeCloseTo(c.h, 5) // 方形：非方形会让 letterbox 把尺度再缩一次
    expect(piecePxInInput(47.8, c)).toBeCloseTo(TARGET_PIECE_PX, 1)
  })

  it('裁剪区域不小于棋盘本身（外扩 20% 容纳走子位移）', () => {
    const c = cropForPieceScale(grid(200 / 1920, 100 / 1080, 600 / 1920, 544 / 1080), 47.8, 1920, 1080)!
    expect(c.w).toBeGreaterThanOrEqual(400 * 1.2 - 1e-6)
    expect(c.h).toBeGreaterThanOrEqual(444 * 1.2 - 1e-6)
  })

  it('裁剪区域被夹在帧内（棋盘靠边时不会越界）', () => {
    const c = cropForPieceScale(grid(0, 0, 0.2, 0.5), 47.8, 1920, 1080)!
    expect(c.x0).toBeGreaterThanOrEqual(0)
    expect(c.y0).toBeGreaterThanOrEqual(0)
    expect(c.x0 + c.w).toBeLessThanOrEqual(1920 + 1e-6)
    expect(c.y0 + c.h).toBeLessThanOrEqual(1080 + 1e-6)
  })

  it('棋盘填满小帧时退化为整帧（边长夹到帧尺寸）', () => {
    const c = cropForPieceScale(grid(0, 0, 1, 1), 3, 200, 200)!
    expect(c).toEqual({ x0: 0, y0: 0, w: 200, h: 200 })
  })

  it('裁剪区域过小时返回 null', () => {
    // 棋盘框极小且棋子尺度已达标之下：边长算出来不足 64px
    expect(cropForPieceScale(grid(0.5, 0.5, 0.5002, 0.5002), 1, 3000, 3000)).toBeNull()
  })
})

describe('tileRects', () => {
  it('2×2 覆盖整帧（含重叠）', () => {
    const rs = tileRects(FRAME_W, FRAME_H, 2, 2)
    expect(rs.length).toBe(4)
    // 首块左/上贴边，末块右/下贴边
    expect(rs[0]!.x0).toBe(0)
    expect(rs[0]!.y0).toBe(0)
    expect(rs[3]!.x0 + rs[3]!.w).toBeCloseTo(FRAME_W, 5)
    expect(rs[3]!.y0 + rs[3]!.h).toBeCloseTo(FRAME_H, 5)
  })

  it('相邻块有重叠（棋盘落在块边界时不会被切断）', () => {
    const rs = tileRects(FRAME_W, FRAME_H, 2, 2, 0.1)
    // 左右两块在 x 方向重叠
    expect(rs[0]!.x0 + rs[0]!.w).toBeGreaterThan(rs[1]!.x0)
    expect(rs[1]!.x0).toBeLessThan(FRAME_W / 2)
  })

  it('块面积足够大（过小的块 letterbox 后棋盘反而更小）', () => {
    const rs = tileRects(FRAME_W, FRAME_H, 2, 2)
    for (const r of rs) {
      expect(r.w).toBeGreaterThan(FRAME_W / 2 - 1)
      expect(r.h).toBeGreaterThan(FRAME_H / 2 - 1)
    }
  })

  it('3×3 每块约 1/3 尺寸', () => {
    const rs = tileRects(FRAME_W, FRAME_H, 3, 3, 0)
    expect(rs.length).toBe(9)
    expect(rs[0]!.w).toBeCloseTo(FRAME_W / 3, 5)
    expect(rs[8]!.x0 + rs[8]!.w).toBeCloseTo(FRAME_W, 5)
  })
})
