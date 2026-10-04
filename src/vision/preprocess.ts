// 帧 → YOLO 输入张量：letterbox 缩放至 640×640、灰边填充 (114,114,114)、RGB 归一化、NCHW 排布
//
// 布局已用 onnx.load 核实：输入 `images` 为 [1,3,640,640]（NCHW）——注意 tflite 源模型是 NHWC，
// ONNX 导出为 NCHW，按 NHWC 填数据会导致检测结果全错。

import { MODEL_INPUT, letterboxForFrame } from './postprocess'
import type { Letterbox } from './types'

/** letterbox 灰边（与训练时一致，不能用黑边） */
export const PAD_VALUE = 114

export interface Preprocessed {
  /** [1,3,640,640] NCHW，值域 0..1 */
  data: Float32Array
  lb: Letterbox
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
 * ImageBitmap → 模型输入。绘制尺寸与 letterboxForFrame 同口径（Math.round），
 * 保证后处理把坐标映回帧域时不会引入整数化偏差。
 */
export function preprocess(bitmap: ImageBitmap): Preprocessed {
  const c = ensureCanvas()
  const lb = letterboxForFrame(bitmap.width, bitmap.height)
  const dw = Math.round(bitmap.width * lb.scale)
  const dh = Math.round(bitmap.height * lb.scale)

  c.fillStyle = `rgb(${PAD_VALUE},${PAD_VALUE},${PAD_VALUE})`
  c.fillRect(0, 0, MODEL_INPUT, MODEL_INPUT)
  c.drawImage(bitmap, lb.padX, lb.padY, dw, dh)

  const img = c.getImageData(0, 0, MODEL_INPUT, MODEL_INPUT)
  return { data: rgbaToNchw(img.data), lb }
}