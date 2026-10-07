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

import { validate } from './assistBoard'
import { BoardTracker } from './boardTracker'
import { map } from './boardMapper'
import { createSession, runModel, type ModelSession } from './model'
import { decode } from './postprocess'
import { preprocess } from './preprocess'
import type { FromVisionWorker, MappedBoard, RecognitionResult, ToVisionWorker } from './types'
import { CELLS } from './types'

const CONFIRM_FRAMES = 3

let model: ModelSession | null = null
let busy = false
let disposed = false
let initStarted = false
const tracker = new BoardTracker(CONFIRM_FRAMES)

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

function toRecognition(mapped: MappedBoard): RecognitionResult {
  return {
    canonical: mapped.canonical,
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
    post({ type: 'frame-result', id, error: '模型未加载', detections: 0, mapped: null, event: 'UNSTABLE', movedSide: null, redGo: tracker.redGo, unstableStreak: tracker.unstableStreak, pieceCount: null, issues: [], candidateFrames: tracker.candidateFrames, frameW, frameH, timings: { pre: 0, infer: 0, post: 0 } })
    return
  }
  if (busy) {
    // 上一帧还在推理：丢弃本帧（主线程按节流发送，堆积说明推理慢于抽帧）
    bitmap.close()
    post({ type: 'frame-result', id, error: 'busy', detections: 0, mapped: null, event: 'UNSTABLE', movedSide: null, redGo: tracker.redGo, unstableStreak: tracker.unstableStreak, pieceCount: null, issues: [], candidateFrames: tracker.candidateFrames, frameW, frameH, timings: { pre: 0, infer: 0, post: 0 } })
    return
  }
  busy = true
  let mapped: MappedBoard | null = null
  let detCount = 0
  let result = invalidResult('识别失败', 0)
  const t = { pre: 0, infer: 0, post: 0 }
  try {
    const t0 = performance.now()
    const { data, lb } = preprocess(bitmap)
    const t1 = performance.now()
    const out = await runModel(model, data)
    const t2 = performance.now()
    const dets = decode(out, lb, frameW, frameH)
    mapped = map(dets, frameW, frameH)
    const t3 = performance.now()
    detCount = dets.length
    t.pre = Math.round(t1 - t0)
    t.infer = Math.round(t2 - t1)
    t.post = Math.round(t3 - t2)
    result = mapped === null ? invalidResult('未识别到棋盘', detCount) : toRecognition(mapped)
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
      break
  }
}
