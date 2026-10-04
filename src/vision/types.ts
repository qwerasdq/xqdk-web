// 识别管线共享类型，移植自 Android assist/RecognitionTypes.kt + YoloDetections.kt
// 坐标约定：canonical 红恒在 y=9（与项目内部 Board 坐标 1:1，无额外变换）

import { LABEL_BOARD, PIECE_CODES } from './labels'

export const BOARD_W = 9
export const BOARD_H = 10
export const CELLS = BOARD_W * BOARD_H // 90

/** 屏幕朝向：STANDARD = 红在屏幕下方（我方视角正常）；FLIPPED = 红在上（换边局） */
export type Orientation = 'STANDARD' | 'FLIPPED'

/** letterbox 参数：帧 → 640 输入的缩放与居中留白 */
export interface Letterbox {
  scale: number
  padX: number
  padY: number
}

/** YOLO 检测框（坐标为原始帧像素域） */
export class YoloDetection {
  constructor(
    readonly labelId: number,
    readonly score: number,
    readonly cx: number,
    readonly cy: number,
    readonly w: number,
    readonly h: number,
  ) {}

  get isBoard(): boolean {
    return this.labelId === LABEL_BOARD
  }

  /** 对应项目 Piece 常量；board 类别返回 -1 */
  get piece(): number {
    return PIECE_CODES[this.labelId] ?? -1
  }
}

/** 归一化棋盘网格（由棋盘框换算，供调试叠加等复用） */
export interface BoardGridRect {
  nx0: number
  ny0: number
  nx1: number
  ny1: number
}

/** 检测 → 9×10 映射结果 */
export interface MappedBoard {
  /** 屏幕布局（gy=0 为屏幕顶部），扁平 90 格，元素为 Piece 常量或 0 */
  screenRaw: Uint8Array
  /** canonical（红恒在 y=9），扁平 90 格 */
  canonical: Uint8Array
  /** canonical 同索引置信度（0 = 空） */
  cellScores: Float32Array
  orientation: Orientation
  grid: BoardGridRect | null
  pieceCount: number
  avgScore: number
  /** 被丢弃的越界棋子数（同格冲突的低分覆盖不计数，与 Android 一致） */
  dropped: number
}

/** 一帧识别结果（tracker 输入） */
export interface RecognitionResult {
  canonical: Uint8Array
  screenRaw: Uint8Array
  cellScores: Float32Array
  orientation: Orientation
  issues: string[]
  unknownCells: number
  recognizedPieces: number
  avgScore: number
}

export function isResultValid(r: RecognitionResult): boolean {
  return r.issues.length === 0 && r.unknownCells === 0
}

export type TrackerEvent = 'NEW_BOARD' | 'SAME_BOARD' | 'NEW_GAME' | 'UNSTABLE'

// ---- 主线程 ↔ 识别 worker 消息协议（W6b 使用）----

export type ToVisionWorker =
  | { type: 'init'; modelUrl: string; ortDir: string; ep: 'auto' | 'webgpu' | 'wasm' }
  | { type: 'frame'; id: number; bitmap: ImageBitmap; frameW: number; frameH: number }
  | { type: 'reset' }
  | { type: 'ack-decision'; decision: 'apply' | 'discard'; canonical: Uint8Array }
  | { type: 'dispose' }

export type FromVisionWorker =
  | { type: 'ready'; ep: 'webgpu' | 'wasm'; loadMs: number }
  | { type: 'init-error'; stage: 'fetch' | 'session' | 'ep'; message: string }
  | {
      type: 'frame-result'
      id: number
      error?: string
      detections: number
      mapped: MappedBoard | null
      event: TrackerEvent
      movedSide: 'red' | 'black' | null
      /** tracker 推断的当前行棋方（协同步 / UI 显示用，权威以 Game 为准） */
      redGo: boolean
      unstableStreak: number
      timings: { pre: number; infer: number; post: number }
    }
  | { type: 'log'; text: string }
