// 裁剪区域推导测试：外扩、帧内约束、过小回退、分块布局
import { describe, expect, it } from 'vitest'
import { cropFromGrid, tileRects } from './preprocess'

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
