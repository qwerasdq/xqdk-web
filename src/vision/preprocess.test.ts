// 裁剪区域推导测试：外扩、帧内约束、过小回退
import { describe, expect, it } from 'vitest'
import { cropFromGrid } from './preprocess'

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
