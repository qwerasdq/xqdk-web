/// <reference lib="webworker" />
// 屏幕识别 worker：帧 → 已确认局面快照（纯视觉，不接触 Game/规则层）
//
// 主线程负责捕获与节流（~800ms/帧），本 worker 串行处理：letterbox 预处理 → ORT 推理 →
// YOLO 后处理 → 9×10 映射 → 硬校验 → 多帧确认（BoardTracker）。确认后的 canonical 局面
// 交回主线程，由 sync.ts 与 Game 调和。
//
// Vite module worker（ORT 是 ESM 包；引擎那个 Blob classic worker 是 pikafish 专属处理，不复制）
//
// 推理后端（W6e）：只用 WASM（SIMD+threads）。WebGPU 因设备丢失后 run() 永久挂起、无法在同 realm
// 恢复而被移除，详见 model.ts 顶部说明。

declare const self: DedicatedWorkerGlobalScope

import { equal, validate } from './assistBoard'
import { BoardTracker } from './boardTracker'
import { map } from './boardMapper'
import { CellStabilizer } from './cellStabilizer'
import { createSession, runModel, type ModelSession } from './model'
import { decode, shiftDetections } from './postprocess'
import { cropFromGrid, preprocess } from './preprocess'
import type { BoardGridRect, FromVisionWorker, MappedBoard, RecognitionResult, ToVisionWorker } from './types'
import { CELLS } from './types'

const CONFIRM_FRAMES = 3
/** 逐格去抖帧数：连续 2 帧一致才采纳该格变化（吸收走子高亮/动画/相邻格跳变造成的单帧抖动） */
const STABILIZE_FRAMES = 2
/** 每多少帧回退一次整帧重新定位棋盘（裁剪帧构图不同会让棋盘框漂移） */
const CALIBRATE_EVERY = 8

let model: ModelSession | null = null
let busy = false
let disposed = false
let initStarted = false
const tracker = new BoardTracker(CONFIRM_FRAMES)
const stabilizer = new CellStabilizer(CELLS, STABILIZE_FRAMES)

/** 整帧定位锁定的棋盘网格（归一化帧坐标）；裁剪帧沿用该锚点做格子归属 */
let lastGrid: BoardGridRect | null = null
/** 距上次整帧校准的帧数 */
let framesSinceCalib = 0

function post(msg: FromVisionWorker): void {
  self.postMessage(msg)
}

function send(text: string): void {
  post({ type: 'log', text })
}

/** 无法映射（未识别到棋盘 / 子太少）时的占位结果：无效帧，tracker 计为 UNSTABLE */
function invalidResult(reason: string, count: number): RecognitionResult {
  return {
    canonical: new Uint8Array(CELLS),
    screenRaw: new Uint8Array(CELLS),
    cellScores: new Float32Array(CELLS),
    orientation: 'STANDARD',
    issues: [reason],
    unknownCells: 1,
    recognizedPieces: count,
    avgScore: 0,
  }
}

function toRecognition(mapped: MappedBoard, canonicalOverride?: Uint8Array): RecognitionResult {
  return {
    canonical: canonicalOverride ?? mapped.canonical,
    screenRaw: mapped.screenRaw,
    cellScores: mapped.cellScores,
    orientation: mapped.orientation,
    issues: validate(mapped.canonical),
    unknownCells: 0,
    recognizedPieces: mapped.pieceCount,
    avgScore: mapped.avgScore,
  }
}

async function handleInit(msg: Extract<ToVisionWorker, { type: 'init' }>): Promise<void> {
  if (initStarted || disposed) return
  initStarted = true
  const t0 = performance.now()
  disposed = false
  try {
    model = await createSession(msg.modelUrl, msg.ortDir)
  } catch (e) {
    model = null
    post({
      type: 'init-error',
      stage: 'session',
      message: e instanceof Error ? e.message : String(e),
    })
    return
  }
  post({ type: 'ready', loadMs: Math.round(performance.now() - t0) })
  send(`识别后端 wasm，输出行数 ${model.rows}`)
}

async function handleFrame(msg: Extract<ToVisionWorker, { type: 'frame' }>): Promise<void> {
  const { id, bitmap, frameW, frameH } = msg
  if (model === null) {
    bitmap.close()
    post({ type: 'frame-result', id, error: '模型未加载', detections: 0, mapped: null, event: 'UNSTABLE', movedSide: null, redGo: tracker.redGo, unstableStreak: tracker.unstableStreak, pieceCount: null, issues: [], candidateFrames: tracker.candidateFrames, frameW, frameH, cellsStable: false, timings: { pre: 0, infer: 0, post: 0 } })
    return
  }
  if (busy) {
    // 上一帧还在推理：丢弃本帧（主线程按节流发送，堆积说明推理慢于抽帧）
    bitmap.close()
    post({ type: 'frame-result', id, error: 'busy', detections: 0, mapped: null, event: 'UNSTABLE', movedSide: null, redGo: tracker.redGo, unstableStreak: tracker.unstableStreak, pieceCount: null, issues: [], candidateFrames: tracker.candidateFrames, frameW, frameH, cellsStable: false, timings: { pre: 0, infer: 0, post: 0 } })
    return
  }
  busy = true
  let mapped: MappedBoard | null = null
  let detCount = 0
  let result = invalidResult('识别失败', 0)
  let cellsStable = false
  const t = { pre: 0, infer: 0, post: 0 }
  try {
    // 每 CALIBRATE_EVERY 帧回退整帧重新定位棋盘：裁剪画面的构图与整帧不同，
    // 会让模型检出的棋盘框系统性漂移（实测框高 +3.6%，累积后最底行整行错位），
    // 故网格锚点以整帧定位为准，裁剪帧只沿用已锁定的网格。
    const useCrop = lastGrid !== null && framesSinceCalib < CALIBRATE_EVERY
    const crop = useCrop ? cropFromGrid(lastGrid, frameW, frameH) : null
    const t0 = performance.now()
    const { data, lb, crop: usedCrop } = preprocess(bitmap, crop)
    const t1 = performance.now()
    const out = await runModel(model, data)
    const t2 = performance.now()
    const dets = decode(out, lb, usedCrop.w, usedCrop.h)
    // 裁剪坐标是 crop 局部坐标，偏移回整帧后再做棋盘映射
    const shifted = shiftDetections(dets, usedCrop.x0, usedCrop.y0)
    // 裁剪帧沿用已锁定的整帧网格；整帧帧用当帧检出的棋盘框
    mapped = map(shifted, frameW, frameH, 3, useCrop ? lastGrid : null)
    const t3 = performance.now()
    detCount = dets.length
    t.pre = Math.round(t1 - t0)
    t.infer = Math.round(t2 - t1)
    t.post = Math.round(t3 - t2)

    if (mapped === null) {
      // 识别不到：丢弃锁定网格，下一帧回退整帧重定位
      lastGrid = null
      framesSinceCalib = 0
      result = invalidResult('未识别到棋盘', detCount)
    } else {
      if (!useCrop) {
        // 整帧定位：更新网格锚点与校准计时
        lastGrid = mapped.grid
        framesSinceCalib = 0
      } else {
        framesSinceCalib++
      }
      const stable = stabilizer.update(mapped.canonical)
      cellsStable = equal(stable, mapped.canonical)
      result = toRecognition(mapped, stable)
    }
  } catch (e) {
    result = invalidResult(e instanceof Error ? e.message : String(e), detCount)
  } finally {
    bitmap.close()
    busy = false
  }

  const event = tracker.onFrame(result)
  const movedSide = event === 'NEW_BOARD' ? tracker.lastMovedSide : null

  post({
    type: 'frame-result',
    id,
    detections: detCount,
    mapped: event === 'SAME_BOARD' ? null : mapped, // 无变化帧不回传局面，省一次序列化
    event,
    movedSide,
    redGo: tracker.redGo,
    unstableStreak: tracker.unstableStreak,
    pieceCount: mapped ? mapped.pieceCount : null,
    issues: result.issues,
    candidateFrames: tracker.candidateFrames,
    frameW,
    frameH,
    cellsStable,
    timings: t,
  })
}

self.onmessage = (e: MessageEvent<ToVisionWorker>): void => {
  const msg = e.data
  switch (msg.type) {
    case 'init':
      void handleInit(msg)
      break
    case 'frame':
      void handleFrame(msg)
      break
    case 'reset':
      tracker.reset()
      stabilizer.reset()
      lastGrid = null
      framesSinceCalib = 0
      break
    case 'ack-decision':
      // 对最新一帧已确认 canonical 做决策；stale canonical 由 tracker internally 判断
      tracker.ackDecision(msg.decision, msg.canonical)
      break
    case 'dispose':
      disposed = true
      void model?.session.release()
      model = null
      tracker.reset()
      stabilizer.reset()
      lastGrid = null
      framesSinceCalib = 0
      break
  }
}
