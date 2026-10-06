// useVision 主线程状态机测试：Worker 与 ScreenCapture 均 mock（node 环境无真实 API）
//
// W6d 重点覆盖后端恢复链路：backend-lost → WASM 兜底替换 → 自动重连 WebGPU（配额用尽转手动）→
// 手动 reconnectWebGpu。Worker 消息由测试手动派发（真实 Worker 在 node 环境不存在）。
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
  captures: [] as { started: boolean }[],
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
    constructor() {
      box.captures.push(this)
    }
    async start(): Promise<void> {
      this.started = true
    }
    stop(): void {
      this.started = false
    }
    attachPreview(): void {}
    get sourceInfo() {
      return { label: '测试窗口', displaySurface: 'window' }
    }
  },
}))

let vision: ReturnType<typeof useVision>

function lastWorker(): FakeWorker {
  return box.workers[box.workers.length - 1]!
}

function workerAt(i: number): FakeWorker {
  return box.workers[i]!
}

function initEp(w: FakeWorker): string {
  return (w.messages[0] as { ep: string }).ep
}

function dispatch(w: FakeWorker, msg: FromVisionWorker): void {
  w.onmessage?.({ data: msg })
}

function dispatchErr(w: FakeWorker, message: string): void {
  w.onerror?.({ message })
}

/** 启动并收到 ready（默认 webgpu），返回主 worker */
async function startCapturing(ready: FromVisionWorker = { type: 'ready', ep: 'webgpu', loadMs: 1 }): Promise<FakeWorker> {
  const p = vision.start('auto')
  const w = lastWorker()
  expect(initEp(w)).toBe('auto')
  dispatch(w, ready)
  await p
  return w
}

/** 触发设备丢失并完成 WASM 兜底替换，返回兜底 worker */
async function fallbackToWasm(): Promise<{ main: FakeWorker; fallback: FakeWorker }> {
  const main = await startCapturing()
  dispatch(main, { type: 'backend-lost', reason: '设备被重置' })
  const fallback = lastWorker()
  expect(fallback).not.toBe(main)
  expect(initEp(fallback)).toBe('wasm')
  dispatch(fallback, { type: 'ready', ep: 'wasm', loadMs: 1 })
  return { main, fallback }
}

beforeEach(() => {
  vi.useFakeTimers()
  // useVision 的重试定时器用 window.setTimeout；stub 指向（已 fake 的）全局 setTimeout
  vi.stubGlobal('window', { setTimeout: globalThis.setTimeout })
  vi.stubGlobal('Worker', FakeWorkerImpl)
  box.workers.length = 0
  box.captures.length = 0
  vision = useVision('/models/x', '/ort/')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useVision', () => {
  it('初始为 idle 且无后端/来源', () => {
    expect(vision.state.state).toBe('idle')
    expect(vision.state.backend).toBeNull()
    expect(vision.state.started).toBe(false)
    expect(vision.state.sourceInfo).toBeNull()
    expect(typeof vision.ackDecision).toBe('function')
  })

  it('启动后收到 ready(webgpu) 进入 capturing 并记录来源', async () => {
    const w = await startCapturing()
    expect(vision.state.state).toBe('capturing')
    expect(vision.state.backend).toBe('webgpu')
    expect(vision.state.sourceInfo?.label).toBe('测试窗口')
    expect(vision.state.backendNotice).toBe('')
    expect(w.terminated).toBe(false)
  })

  it('自动模式下 WebGPU 降级 WASM 时给出提示', async () => {
    await startCapturing({ type: 'ready', ep: 'wasm', loadMs: 1, fallbackReason: '模拟失败' })
    expect(vision.state.state).toBe('capturing')
    expect(vision.state.backend).toBe('wasm')
    expect(vision.state.backendNotice).toContain('已降级 WASM 后端')
  })

  it('backend-lost：终止旧 worker，WASM 兜底接管并调度自动重连', async () => {
    const { main, fallback } = await fallbackToWasm()
    expect(main.terminated).toBe(true)
    expect(vision.state.backend).toBe('wasm')
    expect(vision.state.state).toBe('capturing')
    expect(vision.state.backendNotice).toContain('正在尝试恢复 WebGPU')

    // 重连定时器到点：起替换 worker 重试（ep 偏好为 auto）
    vi.advanceTimersByTime(1800)
    const retry = lastWorker()
    expect(retry).not.toBe(fallback)
    expect(initEp(retry)).toBe('auto')
  })

  it('自动重连拿到 WebGPU 后换线并清空提示', async () => {
    const { fallback } = await fallbackToWasm()
    vi.advanceTimersByTime(1800)
    const retry = lastWorker()
    dispatch(retry, { type: 'ready', ep: 'webgpu', loadMs: 1 })
    expect(vision.state.backend).toBe('webgpu')
    expect(vision.state.backendNotice).toBe('')
    expect(fallback.terminated).toBe(true)
    expect(workerAt(box.workers.length - 1)).toBe(retry)
  })

  it('自动重连连续失败耗尽配额后转手动，不再自动生成 worker', async () => {
    const { fallback } = await fallbackToWasm()
    // 第 1 次自动重试失败（仍只有 WASM）
    vi.advanceTimersByTime(1800)
    dispatch(lastWorker(), { type: 'ready', ep: 'wasm', loadMs: 1, fallbackReason: '无 GPU' })
    // 第 2 次自动重试失败
    vi.advanceTimersByTime(1800)
    dispatch(lastWorker(), { type: 'ready', ep: 'wasm', loadMs: 1, fallbackReason: '无 GPU' })
    expect(vision.state.backend).toBe('wasm')
    expect(vision.state.backendNotice).toContain('点「重连 WebGPU」可重试')
    expect(fallback.terminated).toBe(true)

    // 配额耗尽：继续推进时间不再生成新 worker
    const count = box.workers.length
    vi.advanceTimersByTime(60_000)
    expect(box.workers.length).toBe(count)
  })

  it('reconnectWebGpu：手动重试成功换线 / 失败继续 WASM', async () => {
    await fallbackToWasm()
    // 清掉自动重连定时器，直接手动重试（失败路径）
    vision.reconnectWebGpu()
    const manual = lastWorker()
    expect(initEp(manual)).toBe('webgpu')
    expect(vision.state.backendNotice).toContain('正在尝试恢复 WebGPU')
    dispatch(manual, { type: 'ready', ep: 'wasm', loadMs: 1, fallbackReason: '无 GPU' })
    expect(manual.terminated).toBe(true)
    expect(vision.state.backend).toBe('wasm')
    expect(vision.state.backendNotice).toContain('恢复 WebGPU 失败')

    // 再次手动重试（成功路径）
    vision.reconnectWebGpu()
    const manual2 = lastWorker()
    dispatch(manual2, { type: 'ready', ep: 'webgpu', loadMs: 1 })
    expect(vision.state.backend).toBe('webgpu')
    expect(vision.state.backendNotice).toBe('')
  })

  it('替换 worker（目标 WebGPU）init-error：提示失败并保留 WASM 主 worker', async () => {
    const { fallback } = await fallbackToWasm()
    vision.reconnectWebGpu()
    const manual = lastWorker()
    dispatchErr(manual, '创建会话失败')
    expect(manual.terminated).toBe(true)
    expect(vision.state.backend).toBe('wasm')
    expect(vision.state.backendNotice).toContain('恢复 WebGPU 失败')
    expect(fallback.terminated).toBe(false)
    expect(vision.state.state).toBe('capturing')
  })

  it('WASM 兜底 worker init-error：整体进入 error 态', async () => {
    const main = await startCapturing()
    dispatch(main, { type: 'backend-lost', reason: '设备被重置' })
    const fallback = lastWorker()
    dispatchErr(fallback, 'wasm 会话创建失败')
    expect(vision.state.state).toBe('error')
    expect(vision.state.lastError).toContain('wasm 会话创建失败')
    expect(fallback.terminated).toBe(true)
  })

  it('替换进行中 stop：主 worker 与 pending 一并回收，回到 idle', async () => {
    const main = await startCapturing()
    dispatch(main, { type: 'backend-lost', reason: '设备被重置' })
    const fallback = lastWorker()
    vision.stop()
    expect(main.terminated).toBe(true)
    expect(fallback.terminated).toBe(true)
    expect(vision.state.state).toBe('idle')
    expect(vision.state.started).toBe(false)
    expect(vision.state.backend).toBeNull()
    expect(box.captures[0]?.started).toBe(false)
  })

  it('稳定运行后丢失（>STABLE_MS）重置自动恢复配额', async () => {
    const main = await startCapturing()
    vi.advanceTimersByTime(60_001)
    dispatch(main, { type: 'backend-lost', reason: '设备被重置' })
    const fallback = lastWorker()
    dispatch(fallback, { type: 'ready', ep: 'wasm', loadMs: 1 })
    // 配额被重置：本次降级只消耗 1 次，仍会调度自动重连
    expect(vision.state.backendNotice).toContain('正在尝试恢复 WebGPU')
  })
})
