// 帧 → YOLO 输入张量：letterbox 缩放至 640×640、灰边填充 (114,114,114)、RGB 归一化、NCHW 排布
//
// 布局已用 onnx.load 核实：输入 `images` 为 [1,3,640,640]（NCHW）——注意 tflite 源模型是 NHWC，
// ONNX 导出为 NCHW，按 NHWC 填数据会导致检测结果全错。

import { MODEL_INPUT, letterboxForFrame } from './postprocess'
import type { BoardGridRect, Letterbox } from './types'

/** 裁剪区域（原始帧像素） */
export interface CropRect {
  x0: number
  y0: number
  w: number
  h: number
}

/**
 * 由已定位的棋盘网格推导下一帧的裁剪区域：棋盘框外扩 margin（默认 20%），并约束到帧内。
 * 外扩是为了容纳走子后棋子仍在框附近、以及棋盘本身的小幅位移。
 * 返回 null 表示无网格或区域过小，调用方应回退整帧。
 */
export function cropFromGrid(
  grid: BoardGridRect | null,
  frameW: number,
  frameH: number,
  margin = 0.2,
): CropRect | null {
  if (!grid) return null
  const x0 = grid.nx0 * frameW
  const y0 = grid.ny0 * frameH
  const x1 = grid.nx1 * frameW
  const y1 = grid.ny1 * frameH
  const mx = (x1 - x0) * margin
  const my = (y1 - y0) * margin
  const cx0 = Math.max(0, x0 - mx)
  const cy0 = Math.max(0, y0 - my)
  const cx1 = Math.min(frameW, x1 + mx)
  const cy1 = Math.min(frameH, y1 + my)
  if (cx1 - cx0 < 64 || cy1 - cy0 < 64) return null
  return { x0: cx0, y0: cy0, w: cx1 - cx0, h: cy1 - cy0 }
}

/** letterbox 灰边（与训练时一致，不能用黑边） */
export const PAD_VALUE = 114

export interface Preprocessed {
  /** [1,3,640,640] NCHW，值域 0..1 */
  data: Float32Array
  lb: Letterbox
  /** 裁剪区域（原始帧像素，四舍五入）。整帧时为 [0,0,w,h] */
  crop: CropRect
}

let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null

function ensureCanvas(): OffscreenCanvasRenderingContext2D {
  if (ctx === null) {
    canvas = new OffscreenCanvas(MODEL_INPUT, MODEL_INPUT)
    ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (ctx === null) throw new Error('OffscreenCanvas 2d 上下文不可用')
  }
  return ctx
}

/** RGBA → NCHW float32（0..1），导出以便纯逻辑单测 */
export function rgbaToNchw(rgba: Uint8ClampedArray, size: number = MODEL_INPUT): Float32Array {
  const plane = size * size
  const out = new Float32Array(3 * plane)
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    out[i] = rgba[p]! / 255
    out[plane + i] = rgba[p + 1]! / 255
    out[2 * plane + i] = rgba[p + 2]! / 255
  }
  return out
}

/**
 * ImageBitmap → 模型输入。默认整帧；传入已定位棋盘区域时只裁剪该区域，
 * 大幅减少 JJ 页面圆形按钮/头像等非棋盘 UI 的误检。
 * 绘制尺寸与 letterboxForFrame 同口径（Math.round），
 * 保证后处理把坐标映回帧域时不会引入整数化偏差。
 */
export function preprocess(
  bitmap: ImageBitmap,
  crop?: CropRect | null,
): Preprocessed {
  const c = ensureCanvas()
  const x0 = crop ? Math.max(0, Math.round(crop.x0)) : 0
  const y0 = crop ? Math.max(0, Math.round(crop.y0)) : 0
  const cw = crop ? Math.max(1, Math.round(crop.w)) : bitmap.width
  const ch = crop ? Math.max(1, Math.round(crop.h)) : bitmap.height

  const lb = letterboxForFrame(cw, ch)
  const dw = Math.max(1, Math.round(cw * lb.scale))
  const dh = Math.max(1, Math.round(ch * lb.scale))

  c.fillStyle = `rgb(${PAD_VALUE},${PAD_VALUE},${PAD_VALUE})`
  c.fillRect(0, 0, MODEL_INPUT, MODEL_INPUT)
  c.drawImage(bitmap, x0, y0, cw, ch, lb.padX, lb.padY, dw, dh)

  const img = c.getImageData(0, 0, MODEL_INPUT, MODEL_INPUT)
  return { data: rgbaToNchw(img.data), lb, crop: { x0, y0, w: cw, h: ch } }
}