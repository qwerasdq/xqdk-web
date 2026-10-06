// 屏幕识别主线程组合式函数：Worker 生命周期、抽帧节流、事件回调
//
// 状态机：idle → loading → capturing → error（捕获中断后回 idle）
// Worker 用 Vite module worker（ORT 是 ESM 包；引擎那个 Blob classic worker 是 pikafish 专属处理）。
//
// 后端恢复（W6d）：WebGPU 设备丢失后，同一 worker（realm）内 ORT 已不可用——
// 挂起的 run 使 release 失效，新会话报 `Session already started`。因此恢复只能替换 worker
// （新 realm）：先建 WASM 保持识别不中断，再用新 worker 尝试拿回 WebGPU，成功后换线。

import { reactive } from 'vue'
import { ScreenCapture } from './capture'
import type { FromVisionWorker, MappedBoard, ToVisionWorker, TrackerEvent } from './types'

export type VisionState = 'idle' | 'loading' | 'capturing' | 'error' | 'awaiting-confirm'
export interface VisionSourceInfo {
  label: string
  displaySurface: 'monitor' | 'window' | 'browser' | 'unknown'
}
export type Backend = 'webgpu' | 'wasm'

export interface VisionHandlers {
  onFrame?: (
    e: TrackerEvent,
    mapped: MappedBoard | null,
    movedSide: 'red' | 'black' | null,
    redGo: boolean,
  ) => void
  onError?: (message: string) => void
}

export interface VisionStateObject {
  state: VisionState
  backend: Backend | null
  /** 后端降级/恢复提示（空 = 无异常）；展示用，不参与逻辑 */
  backendNotice: string
  lastError: string
  unstableStreak: number
  started: boolean
  sourceInfo: VisionSourceInfo | null
  /** 最近一帧诊断（识别 0 子 / 校验失败时用户可据此调整窗口/缩放） */
  lastFrameDiag: {
    detections: number
    pieceCount: number | null
    issues: string[]
    candidateFrames: number
    frameW: number
    frameH: number
  } | null
}

export interface VisionController {
  state: VisionStateObject
  start: (ep: 'auto' | Backend) => Promise<void>
  stop: () => void
  resetTracker: () => void
  ackDecision: (decision: 'apply' | 'discard', canonical: Uint8Array) => void
  /** 手动重试拿回 WebGPU 后端（降级到 WASM 后可用） */
  reconnectWebGpu: () => void
  /** 挂载捕获预览画布（可选；用于人工确认捕获来源） */
  attachPreview: (canvas: HTMLCanvasElement | null) => void
}

/** 单次降级后自动换新 worker 拿回 WebGPU 的机会数（连续两次失败后转手动） */
const AUTO_RECONNECT_LIMIT = 2
/** WebGPU 会话存活超过该时长视为稳定，重置自动恢复计数 */
const STABLE_MS = 60_000
/** WASM 稳定后再尝试 WebGPU 的延迟 */
const RECONNECT_DELAY_MS = 1800

export function useVision(modelUrl: string, ortDir: string, handlers: VisionHandlers = {}): VisionController {
  const state = reactive({
    state: 'idle' as VisionState,
    backend: null as Backend | null,
    backendNotice: '',
    lastError: '',
    unstableStreak: 0,
    started: false,
    sourceInfo: null as VisionSourceInfo | null,
    lastFrameDiag: null as VisionStateObject['lastFrameDiag'],
  })

  const previewCanvas = { current: null as HTMLCanvasElement | null }

  let worker: Worker | null = null
  /** 恢复用替换 worker：就绪前不接管帧，确认拿到目标后端后才换线 */
  let pending: Worker | null = null
  let capture: ScreenCapture | null = null
  let frameId = 0
  let epPreference: 'auto' | Backend = 'auto'
  let readyAt = 0
  let autoRetries = 0
  let retryTimer: number | null = null
  let generation = 0
  /** 替换 worker 想拿到的后端（wasm 兜底 / webgpu 恢复） */
  let pendingTarget: 'auto' | 'webgpu' | 'wasm' | null = null

  function clearRetryTimer(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  function killWorker(w: Worker | null): void {
    if (!w) return
    try {
      w.postMessage({ type: 'dispose' } satisfies ToVisionWorker)
    } catch {
      // worker 已终止时忽略
    }
    w.terminate()
  }

  function stopCapture(): void {
    if (capture) {
      capture.stop()
      capture = null
    }
  }

  function terminateWorker(): void {
    clearRetryTimer()
    generation++
    killWorker(worker)
    worker = null
    killWorker(pending)
    pending = null
  }

  function notifyError(message: string): void {
    state.state = 'error'
    state.lastError = message
    handlers.onError?.(message)
  }

  function spawnWorker(ep: 'auto' | Backend): Worker {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<FromVisionWorker>) => onWorkerMessage(e, w)
    w.onerror = (e: ErrorEvent) => onWorkerError(e, w)
    w.postMessage({ type: 'init', modelUrl, ortDir, ep } satisfies ToVisionWorker)
    return w
  }

  /** 起一个替换 worker 尝试拿到目标后端（帧仍发给当前 worker，直到替换者就绪） */
  function startReplacementWorker(ep: 'auto' | Backend): void {
    if (!state.started || worker === null || pending !== null) return
    pendingTarget = ep
    pending = spawnWorker(ep)
  }

  /** 当前 worker 失效：立即替换为新 worker（先 WASM 兜底保持识别） */
  function replaceWithFallback(reason: string): void {
    const g = ++generation
    const old = worker
    clearRetryTimer()
    if (old) {
      old.onmessage = null
      old.onerror = null
      killWorker(old)
    }
    worker = null

    state.backend = null
    state.backendNotice = `${reason}；正在切换 WASM 后端…`
    if (!state.started || g !== generation) return

    // 先 WASM：快、稳，立即恢复识别
    pendingTarget = 'wasm'
    pending = spawnWorker('wasm')
  }

  function onWorkerMessage(e: MessageEvent<FromVisionWorker>, from: Worker): void {
    const msg = e.data
    if (from !== worker && from !== pending) return

    switch (msg.type) {
      case 'ready': {
        if (from === pending) {
          // 替换者：目标后端（wasm 兜底或 webgpu 恢复）拿到后才换线
          const target = pendingTarget
          const ok = target === 'webgpu' ? msg.ep === 'webgpu' : true
          if (!ok) {
            killWorker(pending)
            pending = null
            state.backendNotice = `恢复 WebGPU 失败（${msg.fallbackReason ?? '未获得 GPU 设备'}），继续使用 WASM 后端`
            break
          }
          const old = worker
          worker = pending
          pending = null
          pendingTarget = null
          killWorker(old)
          state.backend = msg.ep
          state.lastError = ''
          if (state.state !== 'awaiting-confirm') state.state = 'capturing'
          if (msg.ep === 'webgpu') {
            readyAt = Date.now()
            state.backendNotice = ''
            // 不重置 autoRetries：稳定运行超过 STABLE_MS 才清零，防止设备持续故障时陷入循环
          } else {
            readyAt = Date.now()
            if (autoRetries < AUTO_RECONNECT_LIMIT) {
              autoRetries++
              state.backendNotice = 'WASM 后端运行中，正在尝试恢复 WebGPU…'
              clearRetryTimer()
              retryTimer = window.setTimeout(() => {
                retryTimer = null
                if (state.started && state.backend === 'wasm') startReplacementWorker(epPreference)
              }, RECONNECT_DELAY_MS)
            } else {
              state.backendNotice = 'WASM 后端运行中，点「重连 WebGPU」可重试'
            }
          }
          break
        }

        state.backend = msg.ep
        readyAt = Date.now()
        state.lastError = ''
        if (msg.ep === 'webgpu') {
          autoRetries = 0
          state.backendNotice = ''
        } else if (msg.fallbackReason) {
          state.backendNotice = `WebGPU 不可用（${msg.fallbackReason}），已降级 WASM 后端`
        }
        if (state.state !== 'awaiting-confirm') state.state = 'capturing'
        break
      }
      case 'backend-lost': {
        if (from !== worker) break
        // 稳定运行过的会话不计入自动恢复配额，且先 WASM 兜底
        if (Date.now() - readyAt > STABLE_MS) autoRetries = 0
        replaceWithFallback(msg.reason)
        break
      }
      case 'init-error': {
        if (from === pending) {
          const target = pendingTarget
          const message = msg.message
          killWorker(pending)
          pending = null
          if (target === 'webgpu') {
            state.backendNotice = `恢复 WebGPU 失败（${message}），继续使用 WASM 后端`
          } else if (target === 'auto' && msg.retryWithWasm) {
            // auto worker's WebGPU attempt may have poisoned ORT's shared WASM
            // runtime; start WASM in a separate realm while keeping capture alive.
            state.backendNotice = `恢复 WebGPU 失败（${message}），继续使用 WASM 后端`
            pendingTarget = 'wasm'
            pending = spawnWorker('wasm')
          } else {
            // WASM 兜底也失败：回到出错态
            stopCapture()
            notifyError(`识别模型初始化失败：${message}`)
            terminateWorker()
          }
          break
        }
        if (msg.retryWithWasm && epPreference === 'auto') {
          replaceWithFallback(`WebGPU 初始化失败（${msg.message}）`)
          break
        }
        stopCapture()
        notifyError(`识别模型初始化失败：${msg.message}`)
        terminateWorker()
        break
      }
      case 'frame-result':
        if (from !== worker) break
        state.unstableStreak = msg.unstableStreak
        state.lastFrameDiag = {
          detections: msg.detections,
          pieceCount: msg.pieceCount,
          issues: msg.issues,
          candidateFrames: msg.candidateFrames,
          frameW: msg.frameW,
          frameH: msg.frameH,
        }
        handlers.onFrame?.(msg.event, msg.mapped, msg.movedSide, msg.redGo)
        break
      case 'log':
        // 保留调试通道，默认不显示
        break
    }
  }

  function onWorkerError(e: ErrorEvent, from: Worker): void {
    if (from === pending) {
      const target = pendingTarget
      killWorker(pending)
      pending = null
      if (target === 'webgpu') {
        state.backendNotice = `恢复 WebGPU 失败（${e.message || 'worker 异常'}），继续使用 WASM 后端`
      } else {
        stopCapture()
        notifyError(`识别 worker 异常：${e.message}`)
        terminateWorker()
      }
      return
    }
    stopCapture()
    notifyError(`识别 worker 异常：${e.message}`)
    terminateWorker()
  }

  function post(msg: ToVisionWorker, transfer: Transferable[] = []): void {
    if (worker) worker.postMessage(msg, transfer)
  }

  async function start(ep: 'auto' | Backend): Promise<void> {
    if (state.state === 'capturing') return
    if (state.state === 'loading') return

    state.state = 'loading'
    state.lastError = ''
    state.backendNotice = ''
    state.started = true
    epPreference = ep
    autoRetries = 0
    pendingTarget = null

    worker = spawnWorker(ep)

    // 用局部 const 持有本次实例：await 期间 worker 初始化失败会 stopCapture() 把
    // 模块级 capture 置空，恢复执行后不能再读它（否则报 reading attachPreview）。
    const cap = new ScreenCapture({
      onFrame: (bitmap, frameW, frameH) => {
        if (!worker) {
          bitmap.close()
          return
        }
        const id = ++frameId
        try {
          // ImageBitmap 必须转移所有权，否则结构化克隆会失败，Worker 永远收不到画面。
          post({ type: 'frame', id, bitmap, frameW, frameH }, [bitmap])
        } catch (e) {
          bitmap.close()
          throw e
        }
      },
      onEnded: () => {
        // 用户主动停止共享：结束捕获并回收 worker，避免重开时泄漏旧实例
        stopCapture()
        terminateWorker()
        state.state = 'idle'
        state.backend = null
        state.backendNotice = ''
        state.sourceInfo = null
        state.started = false
        state.unstableStreak = 0
        state.lastFrameDiag = null
      },
      onError: (message) => notifyError(message),
  })
    capture = cap

    try {
      await cap.start()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // 已被 worker 失败路径回收时，保留它的真实错误，不要用本处异常覆盖
      if (capture === cap) {
        notifyError(`无法开始屏幕捕获：${message}`)
        stopCapture()
        terminateWorker()
      }
      throw e
    }

    // 授权期间识别 worker 可能已失败并回收（init-error / worker 异常 → stopCapture）：
    // 放弃接线；并补一次 stop —— 若 stop() 发生在授权完成前，ScreenCapture 内部的清理
    // 是空操作，需在此确保刚拿到的媒体流被释放。
    if (capture !== cap) {
      cap.stop()
      return
    }

    cap.attachPreview(previewCanvas.current)
    const info = cap.sourceInfo
    state.sourceInfo = info
      ? {
          label: info.label,
          displaySurface: (info.displaySurface as 'monitor' | 'window' | 'browser' | 'unknown') || 'unknown',
        }
      : null
  }

  function stop(): void {
    stopCapture()
    terminateWorker()
    state.state = 'idle'
    state.backend = null
    state.backendNotice = ''
    state.sourceInfo = null
    state.started = false
    state.unstableStreak = 0
    state.lastFrameDiag = null
  }

  function resetTracker(): void {
    post({ type: 'reset' })
  }

  function ackDecision(decision: 'apply' | 'discard', canonical: Uint8Array): void {
    post({ type: 'ack-decision', decision, canonical })
  }

  function reconnectWebGpu(): void {
    if (!state.started || worker === null || pending !== null) return
    clearRetryTimer()
    autoRetries = 0
    state.backendNotice = '正在尝试恢复 WebGPU…'
    startReplacementWorker('webgpu')
  }

  function attachPreview(canvas: HTMLCanvasElement | null): void {
    previewCanvas.current = canvas
    capture?.attachPreview(canvas)
  }

  return { state, start, stop, resetTracker, ackDecision, reconnectWebGpu, attachPreview }
}
