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

import { equal, repairOverflow, validate } from './assistBoard'
import { BoardTracker } from './boardTracker'
import { detectOrientation, map, OrientationStabilizer } from './boardMapper'
import { CellStabilizer } from './cellStabilizer'
import { createSession, runModel, type ModelSession } from './model'
import { decode, dedupByCenter, shiftDetections } from './postprocess'
import { cropFromGrid, preprocess, tileRects } from './preprocess'
import type { YoloDetection } from './types'
import type { BoardGridRect, FromVisionWorker, MappedBoard, RecognitionResult, ToVisionWorker } from './types'
import type { CropRect } from './preprocess'
import { CELLS } from './types'

/** 一次推理的产物（含各阶段耗时，用于诊断） */
interface InferResult {
  dets: YoloDetection[]
  pre: number
  infer: number
  post: number
}

// 冷启动仍要求 3 帧（防开局误检）；已确认后的新局用 1 帧即可确认，
// 避免 CellStabilizer 2 帧 + BoardTracker 3 帧叠加成“画面变了但一直识别中”。
const CONFIRM_FRAMES = 1
const INITIAL_CONFIRM_FRAMES = 3
/** 逐格去抖帧数：连续 2 帧一致才采纳该格变化（吸收走子高亮/动画/相邻格跳变造成的单帧抖动） */
const STABILIZE_FRAMES = 2
/**
 * 定位帧的分块扫描格数。定位帧（无锁定网格 / 到期重定位）走分块而不是整帧：
 * 共享整个显示器时棋盘常只占几百像素，整帧 letterbox 后每子约 10px，模型检不到；
 * 2×2 分块把棋盘放大到可识别尺度，实测同一几何下检子数从 0–1 升到 30+。
 */
const TILE_N = 2
/** 每多少帧重新分块定位一次（裁剪窗口是静态的，棋盘滚动后需要跟上） */
const CALIBRATE_EVERY = 8

let model: ModelSession | null = null
let busy = false
let disposed = false
let initStarted = false
const tracker = new BoardTracker(CONFIRM_FRAMES, INITIAL_CONFIRM_FRAMES)
const stabilizer = new CellStabilizer(CELLS, STABILIZE_FRAMES)

/** 最近一次去抖后的稳定盘（诊断：区分"输出真在变"与"原始帧噪声已被吸收"） */
let lastStable: Uint8Array | null = null
/**
 * 朝向锁定：只在连续多帧一致指向另一朝向时才切换。
 * 朝向判据只看王落在哪一行，单帧误检会让 canonical 整体翻 180°（约 40 格同时变），
 * 这是"抖动很大"的主因；JJ 对局中棋盘方向不会中途改变，故默认锁死。
 */
const orientationLock = new OrientationStabilizer()

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

/** 单次推理：可选裁剪区域，检测框统一偏移回整帧坐标 */
async function inferOnce(bitmap: ImageBitmap, crop: CropRect | null): Promise<InferResult> {
  const t0 = performance.now()
  const { data, lb, crop: used } = preprocess(bitmap, crop)
  const t1 = performance.now()
  const out = await runModel(model!, data)
  const t2 = performance.now()
  const dets = shiftDetections(decode(out, lb, used.w, used.h), used.x0, used.y0)
  const t3 = performance.now()
  return { dets, pre: Math.round(t1 - t0), infer: Math.round(t2 - t1), post: Math.round(t3 - t2) }
}

/**
 * 分块扫描推理（仅定位用）：把整帧切成 n×n 小块分别推理，合并跨块检测。
 *
 * 为什么需要：共享整个显示器时棋盘常只占几百像素，整帧 letterbox 到 640 后每子约 10px，
 * 模型基本检不到（实测 1920×1080 帧内棋盘 300px → 整帧仅 1 子，而 2×2 分块可检出 30+）。
 * 只用于「定位不出棋盘」时，正常帧走裁剪单次推理，平均成本不变。
 */
async function inferTiled(
  bitmap: ImageBitmap,
  frameW: number,
  frameH: number,
  n: number,
): Promise<InferResult> {
  const acc: YoloDetection[] = []
  let pre = 0
  let infer = 0
  let post = 0
  for (const rect of tileRects(frameW, frameH, n, n)) {
    const r = await inferOnce(bitmap, rect)
    acc.push(...r.dets)
    pre += r.pre
    infer += r.infer
    post += r.post
  }
  return { dets: dedupByCenter(acc), pre, infer, post }
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
    post({ type: 'frame-result', id, error: '模型未加载', detections: 0, mapped: null, event: 'UNSTABLE', movedSide: null, redGo: tracker.redGo, unstableStreak: tracker.unstableStreak, pieceCount: null, issues: [], candidateFrames: tracker.candidateFrames, frameW, frameH, cellsStable: false, unstableCells: 0, unstableIndices: [], stableChanges: 0, timings: { pre: 0, infer: 0, post: 0 } })
    return
  }
  if (busy) {
    // 上一帧还在推理：丢弃本帧（主线程按节流发送，堆积说明推理慢于抽帧）
    bitmap.close()
    post({ type: 'frame-result', id, error: 'busy', detections: 0, mapped: null, event: 'UNSTABLE', movedSide: null, redGo: tracker.redGo, unstableStreak: tracker.unstableStreak, pieceCount: null, issues: [], candidateFrames: tracker.candidateFrames, frameW, frameH, cellsStable: false, unstableCells: 0, unstableIndices: [], stableChanges: 0, timings: { pre: 0, infer: 0, post: 0 } })
    return
  }
  busy = true
  let mapped: MappedBoard | null = null
  let detCount = 0
  let result = invalidResult('识别失败', 0)
  let cellsStable = false
  let unstableCells = 0
  /** 稳定盘相对上一帧变化的格数（真正流到下游的抖动） */
  let stableChanges = 0
  /** 原始帧与稳定盘不一致的格索引（诊断用） */
  const unstableIndices: number[] = []
  const t = { pre: 0, infer: 0, post: 0 }
  try {
    let r: InferResult
    /** 本帧是否走的定位路径（整帧/分块），用于重置重定位计数 */
    let locating = false
    const orient = orientationLock.current
    if (lastGrid !== null && framesSinceCalib < CALIBRATE_EVERY) {
      // 已有锁定网格：按网格裁剪后单次推理（棋盘占比大，模型最准）
      r = await inferOnce(bitmap, cropFromGrid(lastGrid, frameW, frameH))
      mapped = map(r.dets, frameW, frameH, 3, lastGrid, orient)
    } else {
      locating = true
      // 定位帧：先整帧（棋盘填满画面时最快最准），整帧定位不出棋盘再分块扫描。
      // 分块是给"共享整个显示器、棋盘只占几百像素"准备的——整帧 letterbox 到 640 后
      // 每子只剩约 10px，模型检不到（实测 0–1 子）。
      r = await inferOnce(bitmap, null)
      mapped = map(r.dets, frameW, frameH, 3, null, orient)
      // 整帧“勉强成功”并不等于精度够：1080p 共享下棋盘 400px 时，整帧能定位但会错 29 格、
      // 只检出 19 子（探针实测）。拿到网格后立刻裁剪重推一次，用精确路径的结果出局面。
      if (mapped !== null) {
        const refined = await inferOnce(bitmap, cropFromGrid(mapped.grid, frameW, frameH))
        const remapped = map(refined.dets, frameW, frameH, 3, mapped.grid, orient)
        if (remapped !== null) {
          mapped = remapped
          r = refined
        }
      } else {
        r = await inferTiled(bitmap, frameW, frameH, TILE_N)
        mapped = map(r.dets, frameW, frameH, 3, null, orient)
        if (mapped !== null) {
          // 分块只用来找回网格：块边界处的棋子会被截半，出局面的精度不够。
          // 拿到网格后立刻按该网格裁剪重推一次，用裁剪帧的结果出局面。
          const refined = await inferOnce(bitmap, cropFromGrid(mapped.grid, frameW, frameH))
          const remapped = map(refined.dets, frameW, frameH, 3, mapped.grid, orient)
          if (remapped !== null) {
            mapped = remapped
            r = refined
          }
        }
      }
    }
    detCount = r.dets.length
    t.pre = r.pre
    t.infer = r.infer
    t.post = r.post

    // 朝向锁定：每帧只喂一次（map 一帧可能被调用多次，计数不能放在 map 里）。
    // 锁定值要到下一帧才生效——本帧已按原判定出的盘照用，帧间不会因判定抖动而翻盘。
    if (mapped !== null) orientationLock.update(detectOrientation(mapped.screenRaw))

    if (mapped === null) {
      // 定位失败：清掉网格，下一帧仍会重试定位（不会锁死）
      lastGrid = null
      framesSinceCalib = 0
      result = invalidResult('未识别到棋盘', detCount)
    } else {
      // 每帧都用当帧定位结果更新锚点，网格随棋盘小幅移动收敛
      if (mapped.grid) lastGrid = mapped.grid
      // 定位帧重置计数；裁剪帧递增，到期后回退到定位重定位
      framesSinceCalib = locating ? 0 : framesSinceCalib + 1
      // 数量超限修复：模型偶尔多吐同类框（实测红帅格上同时检出低分 r_pao），
      // 落到空格就成了"卒 6 个""炮 3 个"，此前会让整帧被 validate 丢弃。
      // 这里按格置信度剔掉多余的，只改数量不改内容。
      const repaired = repairOverflow(mapped.canonical, mapped.cellScores)
      if (repaired > 0) {
        mapped.pieceCount -= repaired
        send(`数量超限修复：剔除 ${repaired} 个低分框`)
      }
      const stable = stabilizer.update(mapped.canonical)
      cellsStable = equal(stable, mapped.canonical)
      // unstableCells 是"原始帧与稳定盘当前不一致"的格数。注意它**不等于抖动**：
      // 某格在 A/B 间严格交替时永远攒不到连续帧数，stable 停在 A 不动，该标记却永不清除。
      // 故另算"稳定盘自身相对上一帧变了多少格"——这才是真正流到下游的抖动。
      unstableCells = stabilizer.unstableCellCount
      if (lastStable !== null) {
        let n = 0
        for (let i = 0; i < CELLS; i++) if (stable[i] !== lastStable[i]) n++
        stableChanges = n
      }
      lastStable = stable.slice()
      for (let i = 0; i < CELLS; i++) if (mapped.canonical[i] !== stable[i]) unstableIndices.push(i)
      // 稳定盘喂 tracker；原始盘不一致时 UI 能看到“有变化”，
      // tracker 仍按候选/确认流程处理，避免真实走子被误判为不稳定。
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
    unstableCells,
    unstableIndices,
    stableChanges,
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
      orientationLock.reset()
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
      orientationLock.reset()
      lastGrid = null
      framesSinceCalib = 0
      break
  }
}
