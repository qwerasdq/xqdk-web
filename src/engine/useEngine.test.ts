// @vitest-environment happy-dom
// 引擎取消/代次保护测试：新请求取代旧请求、主动取消、movetime 生成
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const box = vi.hoisted(() => ({
  messages: [] as unknown[],
  onmessage: null as null | ((e: MessageEvent) => void),
  activeId: 0,
}))

class FakeWorker {
  private _onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  set onmessage(fn: ((e: MessageEvent) => void) | null) {
    this._onmessage = fn
    box.onmessage = fn
  }
  get onmessage(): ((e: MessageEvent) => void) | null {
    return this._onmessage
  }
  postMessage(msg: unknown): void {
    box.messages.push(msg)
  }
  terminate(): void {}
}

function dispatchReady(): void {
  box.onmessage?.({
    data: { type: 'ready', engineId: 'fake', engineName: 'Pikafish' },
  } as MessageEvent)
}

function dispatchBestmove(id: number): void {
  box.onmessage?.({
    data: { type: 'bestmove', id, text: 'bestmove h2e2' },
  } as MessageEvent)
}

beforeEach(() => {
  vi.resetModules()
  box.messages = []
  box.onmessage = null
  box.activeId = 0
  vi.stubGlobal('Worker', FakeWorker)
  Object.defineProperty(globalThis, 'crossOriginIsolated', { value: true, configurable: true })
  vi.stubGlobal('SharedArrayBuffer', class {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as Record<string, unknown>).crossOriginIsolated
})

describe('engine 取消/代次保护', () => {
  it('engineSearch：新请求到来时旧请求 reject 为取消错误', async () => {
    const m = await import('./useEngine')
    m.initEngine()
    dispatchReady()

    const first = m.engineSearch({ fen: 'start', moves: [], depth: 12 })
    // 第二个请求会 abort 第一个
    const second = m.engineSearch({ fen: 'start', moves: [], depth: 12 })
    await expect(first).rejects.toBeInstanceOf(m.EngineSearchCancelledError)
    m.cancelEngineSearch()
    await expect(second).rejects.toBeInstanceOf(m.EngineSearchCancelledError)
  })

  it('cancelEngineSearch：reject 全部 pending 并通知 worker', async () => {
    const m = await import('./useEngine')
    m.initEngine()
    dispatchReady()

    const p = m.engineSearch({ fen: 'start', moves: [], depth: 12 })
    await vi.waitFor(() => {
      expect(box.messages.some((msg) => (msg as { type?: string }).type === 'go')).toBe(true)
    })
    m.cancelEngineSearch()
    await expect(p).rejects.toBeInstanceOf(m.EngineSearchCancelledError)
    expect(box.messages.some((msg) => (msg as { type?: string }).type === 'cancelSearch')).toBe(true)
  })

  it('engineAnalyze：movetime 请求生成 go movetime 命令', async () => {
    const m = await import('./useEngine')
    m.initEngine()
    dispatchReady()

    const p = m.engineAnalyze({ fen: 'start', moves: [], movetime: 1500, multipv: 3 }, () => {})
    await vi.waitFor(() => {
      const go = [...box.messages].reverse().find((msg) => (msg as { type?: string }).type === 'go') as
        | { type: 'go'; goCmd: string }
        | undefined
      expect(go?.goCmd).toBe('movetime 1500')
    })
    m.cancelEngineSearch()
    await expect(p).rejects.toBeInstanceOf(m.EngineSearchCancelledError)
  })

  it('旧代次 bestmove 不 resolve 旧请求', async () => {
    const m = await import('./useEngine')
    m.initEngine()
    dispatchReady()

    const old = m.engineSearch({ fen: 'start', moves: [], depth: 12 })
    const latest = m.engineSearch({ fen: 'start', moves: [], depth: 12 })
    // 旧 id 的 bestmove 返回：旧请求已被新请求取消，应 reject 而不是 resolve
    dispatchBestmove(1)
    await expect(old).rejects.toBeInstanceOf(m.EngineSearchCancelledError)
    m.cancelEngineSearch()
    await expect(latest).rejects.toBeInstanceOf(m.EngineSearchCancelledError)
  })
})
