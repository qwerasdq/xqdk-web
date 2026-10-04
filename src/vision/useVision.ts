// 屏幕识别主线程组合式函数：Worker 生命周期、抽帧节流、事件回调
//
// 状态机：idle → loading → capturing → error（捕获中断后回 idle）
// Worker 用 Vite module worker（ORT 是 ESM 包；引擎那个 Blob classic worker 是 pikafish 专属处理）。

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
  lastError: string
  unstableStreak: number
  started: boolean
  sourceInfo: VisionSourceInfo | null
}

export interface VisionController {
  state: VisionStateObject
  start: (ep: 'auto' | Backend) => Promise<void>
  stop: () => void
  resetTracker: () => void
  ackDecision: (decision: 'apply' | 'discard', canonical: Uint8Array) => void
}

export function useVision(modelUrl: string, ortDir: string, handlers: VisionHandlers = {}): VisionController {
  const state = reactive({
    state: 'idle' as VisionState,
    backend: null as Backend | null,
    lastError: '',
    unstableStreak: 0,
    started: false,
    sourceInfo: null as VisionSourceInfo | null,
  })

  let worker: Worker | null = null
  let capture: ScreenCapture | null = null
  let frameId = 0

  function stopCapture(): void {
    if (capture) {
      capture.stop()
      capture = null
    }
  }

  function terminateWorker(): void {
    if (worker) {
      worker.terminate()
      worker = null
    }
  }

  function notifyError(message: string): void {
    state.state = 'error'
    state.lastError = message
    handlers.onError?.(message)
  }

  function onWorkerMessage(e: MessageEvent<FromVisionWorker>): void {
    const msg = e.data
    switch (msg.type) {
      case 'ready':
        state.backend = msg.ep
        state.state = 'capturing'
        state.lastError = ''
        break
      case 'init-error':
        notifyError(`识别模型初始化失败：${msg.message}`)
        terminateWorker()
        break
      case 'frame-result':
        state.unstableStreak = msg.unstableStreak
        handlers.onFrame?.(msg.event, msg.mapped, msg.movedSide, msg.redGo)
        break
      case 'log':
        // 保留调试通道，默认不显示
        break
    }
  }

  function post(msg: ToVisionWorker): void {
    if (worker) worker.postMessage(msg)
  }

  async function start(ep: 'auto' | Backend): Promise<void> {
    if (state.state === 'capturing') return
    if (state.state === 'loading') return

    state.state = 'loading'
    state.lastError = ''
    state.started = true

    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = onWorkerMessage
    worker.onerror = (e) => {
      notifyError(`识别 worker 异常：${e.message}`)
      terminateWorker()
    }

    post({ type: 'init', modelUrl, ortDir, ep })

    try {
      capture = new ScreenCapture({
        onFrame: (bitmap, frameW, frameH) => {
          if (!worker) {
            bitmap.close()
            return
          }
          const id = ++frameId
          post({ type: 'frame', id, bitmap, frameW, frameH })
        },
        onEnded: () => {
          // 用户主动停止共享：结束捕获并回收 worker，避免重开时泄漏旧实例
          stopCapture()
          terminateWorker()
          state.state = 'idle'
          state.backend = null
          state.sourceInfo = null
          state.started = false
          state.unstableStreak = 0
        },
        onError: (message) => notifyError(message),
      })
      await capture.start()
      state.sourceInfo = capture.sourceInfo
        ? {
            label: capture.sourceInfo.label,
            displaySurface: (capture.sourceInfo.displaySurface as 'monitor' | 'window' | 'browser' | 'unknown') || 'unknown',
          }
        : null
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      notifyError(`无法开始屏幕捕获：${message}`)
      terminateWorker()
      throw e
    }
  }

  function stop(): void {
    stopCapture()
    terminateWorker()
    state.state = 'idle'
    state.backend = null
    state.sourceInfo = null
    state.started = false
    state.unstableStreak = 0
  }

  function resetTracker(): void {
    post({ type: 'reset' })
  }

  function ackDecision(decision: 'apply' | 'discard', canonical: Uint8Array): void {
    post({ type: 'ack-decision', decision, canonical })
  }

  return { state, start, stop, resetTracker, ackDecision }
}