// YOLOv5 输出后处理，直译自 Android assist/YoloPostprocessor.kt（纯逻辑，与模型无关）
// 解码 [1,25200,20] → 置信度过滤 → 类别感知 NMS → 比例/尺寸一致性过滤

import { YoloDetection } from './types'
import type { Letterbox } from './types'

export const MODEL_INPUT = 640
export const ANCHORS = 25200
export const DIMS = 20
export const CONF_THRESHOLD = 0.6 // Android 默认：0.60（参考实现 0.7，取 0.6 兼顾召回）
export const IOU_THRESHOLD = 0.45

/** 帧 → 640 输入的 letterbox 参数（scale 与 pad 的计算口径与 Kotlin roundToInt 一致） */
export function letterboxForFrame(frameW: number, frameH: number): Letterbox {
  const scale = Math.min(MODEL_INPUT / frameW, MODEL_INPUT / frameH)
  const nw = Math.round(frameW * scale)
  const nh = Math.round(frameH * scale)
  return { scale, padX: (MODEL_INPUT - nw) / 2, padY: (MODEL_INPUT - nh) / 2 }
}

/**
 * 解码模型输出。
 * @param output 扁平 [25200*20] float32（行序即 anchor 序，值已是解码后的像素域）
 * @param lb letterbox 参数
 * @returns 过滤后的检测框（坐标为原始帧像素域）
 */
export function decode(
  output: Float32Array,
  lb: Letterbox,
  frameW: number,
  frameH: number,
  confThreshold = CONF_THRESHOLD,
  iouThreshold = IOU_THRESHOLD,
): YoloDetection[] {
  interface Raw {
    labelId: number
    score: number
    x1: number
    y1: number
    x2: number
    y2: number
  }

  const raws: Raw[] = []
  for (let i = 0; i < ANCHORS; i++) {
    const base = i * DIMS
    const obj = output[base + 4]!
    if (obj < confThreshold) continue
    let bestCls = -1
    let bestScore = 0
    for (let c = 0; c < DIMS - 5; c++) {
      const s = obj * output[base + 5 + c]!
      if (s > bestScore) {
        bestScore = s
        bestCls = c
      }
    }
    if (bestCls < 0 || bestScore < confThreshold) continue
    const cx = output[base]!
    const cy = output[base + 1]!
    const w = output[base + 2]!
    const h = output[base + 3]!
    raws.push({ labelId: bestCls, score: bestScore, x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 })
  }
  if (raws.length === 0) return []

  // 类别感知 NMS（仅同类互相压制），按得分降序贪心保留
  raws.sort((a, b) => b.score - a.score)
  const keep: Raw[] = []
  for (const r of raws) {
    let overlapped = false
    for (const k of keep) {
      if (k.labelId !== r.labelId) continue
      if (iou(r.x1, r.y1, r.x2, r.y2, k.x1, k.y1, k.x2, k.y2) > iouThreshold) {
        overlapped = true
        break
      }
    }
    if (!overlapped) keep.push(r)
  }

  // 640 输入域 → 原始帧域（不夹取到帧内，越界由 mapper 丢弃——与 Android 一致）
  const toFrame = (v: number, pad: number): number => (v - pad) / lb.scale
  const dets: YoloDetection[] = keep.map((r) => {
    const x1 = toFrame(r.x1, lb.padX)
    const y1 = toFrame(r.y1, lb.padY)
    const x2 = toFrame(r.x2, lb.padX)
    const y2 = toFrame(r.y2, lb.padY)
    return new YoloDetection(r.labelId, r.score, (x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1)
  })

  // 棋子比例过滤 + 尺寸一致性过滤（board 框不参与）
  const pieces = dets.filter((d) => !d.isBoard && d.w > 0 && aspectOk(d))
  if (pieces.length === 0) return dets.filter((d) => d.isBoard)
  const medianW = median(pieces.map((d) => d.w))
  const medianH = median(pieces.map((d) => d.h))
  const out: YoloDetection[] = []
  for (const d of dets) {
    if (
      d.isBoard ||
      (aspectOk(d) && d.w >= medianW * 0.55 && d.w <= medianW * 1.6 && d.h >= medianH * 0.55 && d.h <= medianH * 1.6)
    ) {
      out.push(d)
    }
    // 尺寸离群的丢弃
  }
  return out
}

function aspectOk(d: YoloDetection): boolean {
  const ratio = d.w / d.h
  return ratio >= 0.7 && ratio <= 1.3
}

function iou(
  ax1: number, ay1: number, ax2: number, ay2: number,
  bx1: number, by1: number, bx2: number, by2: number,
): number {
  const ix1 = Math.max(ax1, bx1)
  const iy1 = Math.max(ay1, by1)
  const ix2 = Math.min(ax2, bx2)
  const iy2 = Math.min(ay2, by2)
  const iw = Math.max(0, ix2 - ix1)
  const ih = Math.max(0, iy2 - iy1)
  const inter = iw * ih
  if (inter <= 0) return 0
  const a = (ax2 - ax1) * (ay2 - ay1)
  const b = (bx2 - bx1) * (by2 - by1)
  return inter / (a + b - inter)
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const n = s.length
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2
}
