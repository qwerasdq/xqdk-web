// useVision 主线程状态机测试：Worker 与 ScreenCapture 均 mock（node 环境无真实 API）
//
// W6e：识别后端固定 WASM，WebGPU 及其恢复状态机已移除。本文件覆盖启动/就绪/错误/停止，
// 以及「授权期间 worker 失败」的边界（start() 挂起时 worker 报错，不得读已置空的 capture、
// 不得覆盖真实错误）。Worker 消息由测试手动派发（真实 Worker 在 node 环境不存在）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVision } from './useVision'
import type { FromVisionWorker } from './types'

interface FakeWorker {
  messages: unknown[]
  terminated: boolean
  onmessage: ((e: { data: FromVisionWorker }) => void) | null
  onerror: ((e: { message: string }) => void) | null
}

const box = vi.hoisted(() => ({
  workers: [] as FakeWorker[],
  captures: [] as { started: boolean; attachCalls: number }[],
  /** 模拟 getDisplayMedia 等待用户授权：start() 挂起，期间可派发 worker 消息 */
  holdStart: false,
  releaseStart: null as null | (() => void),
}))

class FakeWorkerImpl implements FakeWorker {
  messages: unknown[] = []
  terminated = false
  onmessage: FakeWorker['onmessage'] = null
  onerror: FakeWorker['onerror'] = null
  constructor(_url: unknown, _opts?: unknown) {
    box.workers.push(this)
  }
  postMessage(msg: unknown): void {
    this.messages.push(msg)
  }
  terminate(): void {
    this.terminated = true
  }
}

vi.mock('./capture', () => ({
  ScreenCapture: class {
    started = false
    attachCalls = 0
    constructor() {
      box.captures.push(this)
    }
    async start(): Promise<void> {
      if (box.holdStart) {
        await new Promise<void>((resolve) => {
          box.releaseStart = resolve
        })
      }
      this.started = true
    }
    stop(): void {
      this.started = false
    }
    attachPreview(): void {
      this.attachCalls++
    }
    get sourceInfo() {
      return { label: '测试窗口', displaySurface: 'window' }
    }
  },
}))

let vision: ReturnType<typeof useVision>

function lastWorker(): FakeWorker {
  return box.workers[box.workers.length - 1]!
}

function initMsg(w: FakeWorker): Record<string, unknown> {
  return w.messages[0] as Record<string, unknown>
}

function dispatch(w: FakeWorker, msg: FromVisionWorker): void {
  w.onmessage?.({ data: msg })
}

function dispatchErr(w: FakeWorker, message: string): void {
  w.onerror?.({ message })
}

/** 启动并收到 ready，返回主 worker */
async function startCapturing(ready: FromVisionWorker = { type: 'ready', loadMs: 1 }): Promise<FakeWorker> {
  const p = vision.start()
  const w = lastWorker()
  dispatch(w, ready)
  await p
  return w
}

beforeEach(() => {
  vi.stubGlobal('Worker', FakeWorkerImpl)
  box.workers.length = 0
  box.captures.length = 0
  box.holdStart = false
  box.releaseStart = null
  vision = useVision('/models/x', '/ort/')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useVision', () => {
  it('初始为 idle 且无来源', () => {
    expect(vision.state.state).toBe('idle')
    expect(vision.state.started).toBe(false)
    expect(vision.state.sourceInfo).toBeNull()
    expect(typeof vision.ackDecision).toBe('function')
  })

  // 后端固定 WASM：init 消息不应再带任何后端选择参数（W6e 回归点）
  it('start：worker 只收到 modelUrl/ortDir，ready 后进入 capturing 并记录来源', async () => {
    const w = await startCapturing()
    expect(initMsg(w)).toEqual({ type: 'init', modelUrl: '/models/x', ortDir: '/ort/' })
    expect(vision.state.state).toBe('capturing')
    expect(vision.state.sourceInfo?.label).toBe('测试窗口')
    expect(w.terminated).toBe(false)
  })

  it('init-error：进入 error 态并回收 worker 与捕获', async () => {
    const p = vision.start()
    const w = lastWorker()
    dispatch(w, { type: 'init-error', stage: 'session', message: '模型加载失败 404' })
    await p

    expect(vision.state.state).toBe('error')
    expect(vision.state.lastError).toBe('识别模型初始化失败：模型加载失败 404')
    expect(w.terminated).toBe(true)
    expect(box.captures[0]?.started).toBe(false)
  })

  it('frame-result：更新逐帧诊断与 unstableStreak', async () => {
    const w = await startCapturing()
    dispatch(w, {
      type: 'frame-result',
      id: 1,
      detections: 3,
      mapped: null,
      event: 'UNSTABLE',
      movedSide: null,
      redGo: true,
      unstableStreak: 7,
      pieceCount: null,
      issues: ['未识别到棋盘'],
      candidateFrames: 0,
      frameW: 1280,
      frameH: 720,
      timings: { pre: 1, infer: 2, post: 3 },
    })
    expect(vision.state.unstableStreak).toBe(7)
    expect(vision.state.lastFrameDiag).toEqual({
      detections: 3,
      pieceCount: null,
      issues: ['未识别到棋盘'],
      candidateFrames: 0,
      frameW: 1280,
      frameH: 720,
    })
  })

  it('stop：回收 worker 与捕获，回到 idle', async () => {
    const w = await startCapturing()
    vision.stop()
    expect(w.terminated).toBe(true)
    expect(vision.state.state).toBe('idle')
    expect(vision.state.started).toBe(false)
    expect(vision.state.sourceInfo).toBeNull()
    expect(box.captures[0]?.started).toBe(false)
  })

  it('worker 运行期异常：进入 error 态并回收', async () => {
    const w = await startCapturing()
    dispatchErr(w, '内存不足')
    expect(vision.state.state).toBe('error')
    expect(vision.state.lastError).toContain('内存不足')
    expect(w.terminated).toBe(true)
  })

  it('授权期间 worker 初始化失败：保留真实错误、不崩溃、回收已拿到的流', async () => {
    box.holdStart = true
    const p = vision.start()
    const w = lastWorker()

    // 用户还在选窗口，worker 硬失败 → 进入 error 并回收 capture
    dispatch(w, { type: 'init-error', stage: 'session', message: '模型加载失败 404' })
    expect(vision.state.state).toBe('error')
    expect(vision.state.lastError).toBe('识别模型初始化失败：模型加载失败 404')
    expect(box.captures[0]?.started).toBe(false)

    // 授权完成：start() 恢复执行，不得读取已被置空的 capture，也不得覆盖真实错误
    box.holdStart = false
    box.releaseStart?.()
    await p

    expect(vision.state.state).toBe('error')
    expect(vision.state.lastError).toBe('识别模型初始化失败：模型加载失败 404')
    expect(vision.state.sourceInfo).toBeNull()
    expect(box.captures[0]?.attachCalls).toBe(0)
    expect(box.captures[0]?.started).toBe(false)
  })
})
