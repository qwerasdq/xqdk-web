// 屏幕识别主线程组合式函数：Worker 生命周期、抽帧节流、事件回调
//
// 状态机：idle → loading → capturing → error（捕获中断后回 idle）
// Worker 用 Vite module worker（ORT 是 ESM 包；引擎那个 Blob classic worker 是 pikafish 专属处理）。
//
// 推理后端（W6e）：只用 WASM。WebGPU 设备丢失的恢复需要「换 worker + 自动重连配额」整套状态机，
// 而识别按 ~800ms/帧节流、WASM 已有 8 倍余量，收益不抵复杂度，故连同该状态机一并移除。

import { reactive } from 'vue'
import { ScreenCapture } from './capture'
import type { FromVisionWorker, MappedBoard, ToVisionWorker, TrackerEvent } from './types'

export type VisionState = 'idle' | 'loading' | 'capturing' | 'error' | 'awaiting-confirm'
export interface VisionSourceInfo {
  label: string
  displaySurface: 'monitor' | 'window' | 'browser' | 'unknown'
}

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
  start: () => Promise<void>
  stop: () => void
  resetTracker: () => void
  ackDecision: (decision: 'apply' | 'discard', canonical: Uint8Array) => void
  /** 挂载捕获预览画布（可选；用于人工确认捕获来源） */
  attachPreview: (canvas: HTMLCanvasElement | null) => void
}

export function useVision(modelUrl: string, ortDir: string, handlers: VisionHandlers = {}): VisionController {
  const state = reactive({
    state: 'idle' as VisionState,
    lastError: '',
    unstableStreak: 0,
    started: false,
    sourceInfo: null as VisionSourceInfo | null,
    lastFrameDiag: null as VisionStateObject['lastFrameDiag'],
  })

  const previewCanvas = { current: null as HTMLCanvasElement | null }

  let worker: Worker | null = null
  let capture: ScreenCapture | null = null
  let frameId = 0

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
    killWorker(worker)
    worker = null
  }

  function notifyError(message: string): void {
    state.state = 'error'
    state.lastError = message
    handlers.onError?.(message)
  }

  function spawnWorker(): Worker {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<FromVisionWorker>) => onWorkerMessage(e, w)
    w.onerror = (e: ErrorEvent) => onWorkerError(e, w)
    w.postMessage({ type: 'init', modelUrl, ortDir } satisfies ToVisionWorker)
    return w
  }

  function onWorkerMessage(e: MessageEvent<FromVisionWorker>, from: Worker): void {
    const msg = e.data
    if (from !== worker) return

    switch (msg.type) {
      case 'ready': {
        state.lastError = ''
        if (state.state !== 'awaiting-confirm') state.state = 'capturing'
        break
      }
      case 'init-error': {
        stopCapture()
        notifyError(`识别模型初始化失败：${msg.message}`)
        terminateWorker()
        break
      }
      case 'frame-result':
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
    if (from !== worker) return
    stopCapture()
    notifyError(`识别 worker 异常：${e.message}`)
    terminateWorker()
  }

  function post(msg: ToVisionWorker, transfer: Transferable[] = []): void {
    if (worker) worker.postMessage(msg, transfer)
  }

  async function start(): Promise<void> {
    if (state.state === 'capturing') return
    if (state.state === 'loading') return

    state.state = 'loading'
    state.lastError = ''
    state.started = true

    worker = spawnWorker()

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

  function attachPreview(canvas: HTMLCanvasElement | null): void {
    previewCanvas.current = canvas
    capture?.attachPreview(canvas)
  }

  return { state, start, stop, resetTracker, ackDecision, attachPreview }
}
