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

/**
 * 棋子落在 640 输入里的目标尺度。模型训练分布约 25–37px：
 * 实测 <25px 检不到（1080p 整帧棋盘 400px 时仅 15.9px，错 13 格），
 * >44px 开始"同类多吐框"（黑车被判成卒、象/马/炮互相串类）。
 */
export const TARGET_PIECE_PX = 30
/** 整帧尺度已落入训练分布的下界；达到它就不必裁剪 */
export const PIECE_SCALE_MIN = 25

/**
 * 按**目标棋子尺度**推导裁剪区域。
 *
 * 动机（实测，用真实 JJ 截图在 1080p 与 240×445 两种捕获下扫描）：
 * 模型对棋子的可辨识尺度有窗口——棋子落在 640 输入里 25–37px 时 0 错格，
 * <25px 检不到，>44px 则出现"同类多吐框"（黑车→卒、象/马/炮串类）。
 * 旧实现用"棋盘外扩 20%"裁剪，裁剪区域随棋盘大小变，棋子尺度也跟着漂：
 * 模拟器 240×445 整帧本是 37px（正好），一裁剪变成 51–67px（分布外）→ 多吐误检。
 *
 * 现在的取法：
 * - 整帧尺度已 ≥ PIECE_SCALE_MIN → 返回 null，用整帧（别为了裁而裁）
 * - 否则取方形裁剪，边长使棋子缩放到 TARGET_PIECE_PX，且不小于棋盘本身
 *
 * @param pieceSize 当前帧检出的棋子中位边长（原始帧像素）
 * @returns null = 用整帧；否则为裁剪区域
 */
export function cropForPieceScale(
  grid: BoardGridRect | null,
  pieceSize: number,
  frameW: number,
  frameH: number,
): CropRect | null {
  if (!grid || pieceSize <= 0) return null
  const fullScale = pieceSize * Math.min(MODEL_INPUT / frameW, MODEL_INPUT / frameH)
  if (fullScale >= PIECE_SCALE_MIN) return null

  const x0 = grid.nx0 * frameW
  const y0 = grid.ny0 * frameH
  const x1 = grid.nx1 * frameW
  const y1 = grid.ny1 * frameH
  const bw = x1 - x0
  const bh = y1 - y0
  if (bw <= 0 || bh <= 0) return null

  // 方形边长：使棋子缩放到目标尺度；同时不小于棋盘本身（外扩 20% 容纳小幅位移）
  const side = Math.min(
    frameW,
    frameH,
    Math.max(pieceSize * (MODEL_INPUT / TARGET_PIECE_PX), bw * 1.2, bh * 1.2),
  )
  if (side < 64) return null
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  return {
    x0: Math.max(0, Math.min(frameW - side, cx - side / 2)),
    y0: Math.max(0, Math.min(frameH - side, cy - side / 2)),
    w: side,
    h: side,
  }
}

/**
 * 分块扫描的块布局（相邻块按 overlap 比例重叠，避免棋盘恰好落在块边界被切断）。
 *
 * 动机：共享「整个显示器」时棋盘往往只占几百像素，整帧 letterbox 到 640 后每子仅约 10px，
 * 模型基本检不到（实测 1920×1080 帧内棋盘 300px → 整帧仅检出 1 子）。
 * 分块把棋盘放大 2–3 倍到可识别尺度，实测同一几何下错格从 32 降到 4。
 */
export function tileRects(
  frameW: number,
  frameH: number,
  nx: number,
  ny: number,
  overlap = 0.1,
): CropRect[] {
  const tw = frameW / nx
  const th = frameH / ny
  const out: CropRect[] = []
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const x0 = Math.max(0, ix * tw - overlap * tw)
      const y0 = Math.max(0, iy * th - overlap * th)
      const x1 = Math.min(frameW, (ix + 1) * tw + overlap * tw)
      const y1 = Math.min(frameH, (iy + 1) * th + overlap * th)
      out.push({ x0, y0, w: x1 - x0, h: y1 - y0 })
    }
  }
  return out
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