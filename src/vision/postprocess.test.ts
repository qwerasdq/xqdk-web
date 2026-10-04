// YOLO 输出解码与过滤测试，移植自 Android YoloPipelineTest.kt（5 用例）
// 夹具为真实模型对 1080×2400 天天象棋开局截图的输出采样
import { describe, expect, it } from 'vitest'
import { ANCHORS, DIMS, decode, letterboxForFrame } from './postprocess'
import { map } from './boardMapper'
import { canonicalStart, equal } from './assistBoard'
import { FIXTURE_ROWS } from './__fixtures__/yoloRows'
import type { YoloDetection } from './types'

const FRAME_W = 1080
const FRAME_H = 2400

function decodeFixture(frameW: number, frameH: number, conf = 0.6): YoloDetection[] {
  const lb = letterboxForFrame(frameW, frameH)
  // 满长输出张量，夹具行拷贝到对应 anchor 位置
  const rows = new Float32Array(ANCHORS * DIMS)
  FIXTURE_ROWS.forEach((r, i) => rows.set(r, i * DIMS))
  return decode(rows, lb, frameW, frameH, conf)
}

describe('YOLO 后处理（真实夹具）', () => {
  it('真实输出解码为 32 子 + 1 棋盘框', () => {
    const dets = decodeFixture(FRAME_W, FRAME_H)
    // 33 真实行 + 3 重叠重复框 => NMS 后恰 33；低分噪声被阈值滤除
    expect(dets.length).toBe(33)
    expect(dets.filter((d) => !d.isBoard).length).toBe(32)
    expect(dets.filter((d) => d.isBoard).length).toBe(1)
  })

  it('真实输出映射为标准开局', () => {
    const dets = decodeFixture(FRAME_W, FRAME_H)
    const mapped = map(dets, FRAME_W, FRAME_H)
    expect(mapped).not.toBeNull()
    expect(equal(canonicalStart(), mapped!.canonical)).toBe(true)
    expect(mapped!.orientation).toBe('STANDARD')
    expect(mapped!.pieceCount).toBe(32)
    expect(mapped!.dropped).toBe(0)
    expect(mapped!.grid).not.toBeNull()
  })

  it('提高阈值滤除低分标记盘', () => {
    const loose = decodeFixture(FRAME_W, FRAME_H, 0.45)
    const strict = decodeFixture(FRAME_W, FRAME_H, 0.6)
    expect(loose.length).toBeGreaterThanOrEqual(strict.length)
  })

  it('letterbox 把模型坐标映回帧坐标', () => {
    // 帧 1080x2400：scale = 640/2400，padX = (640 - 1080*scale)/2
    const lb = letterboxForFrame(FRAME_W, FRAME_H)
    const frameX = 500
    const frameY = 1000
    const modelX = frameX * lb.scale + lb.padX
    const modelY = frameY * lb.scale + lb.padY
    const rows = new Float32Array(ANCHORS * DIMS)
    const base = 12345 * DIMS
    rows[base] = modelX
    rows[base + 1] = modelY
    rows[base + 2] = 60
    rows[base + 3] = 60
    rows[base + 4] = 0.9
    rows[base + 5 + 4] = 0.95 // b_che
    const dets = decode(rows, lb, FRAME_W, FRAME_H)
    expect(dets.length).toBe(1)
    expect(dets[0]!.labelId).toBe(4)
    // b_che（label 4）→ 黑车 BJU
    expect(dets[0]!.piece).toBe(12)
    expect(Math.abs(dets[0]!.cx - frameX)).toBeLessThan(0.6)
    expect(Math.abs(dets[0]!.cy - frameY)).toBeLessThan(0.6)
    expect(Math.abs(dets[0]!.w - 60 / lb.scale)).toBeLessThan(0.6)
  })

  it('宽按钮状框被比例过滤', () => {
    const lb = letterboxForFrame(640, 640)
    const rows = new Float32Array(ANCHORS * DIMS)
    const put = (row: number, x: number, y: number, w: number, h: number, obj: number, cls: number): void => {
      const base = row * DIMS
      rows[base] = x
      rows[base + 1] = y
      rows[base + 2] = w
      rows[base + 3] = h
      rows[base + 4] = obj
      rows[base + 5 + cls] = 0.98
    }
    put(0, 100, 100, 60, 60, 0.9, 7) // 圆棋子 r_che（保留）
    put(1, 320, 60, 120, 55, 0.95, 2) // 工具栏按钮状 2:1 宽框（剔除）
    put(2, 500, 500, 22, 22, 0.95, 12) // 过小标记盘（相对中位尺寸剔除）
    const dets = decode(rows, lb, 640, 640)
    expect(dets.length).toBe(1)
    expect(dets[0]!.piece).toBe(5) // r_che → 红车 WJU
  })
})
