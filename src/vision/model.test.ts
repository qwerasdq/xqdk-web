// model.ts 推理逻辑：输出拷贝、缺张量报错、超时兜底（后端挂起时 run() 不会 reject）
import { describe, expect, it } from 'vitest'
import { InferenceTimeoutError, runModel, withTimeout, type ModelSession } from './model'

describe('withTimeout', () => {
  it('正常完成时透传结果', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, () => new Error('超时'))).resolves.toBe(42)
  })

  it('原 Promise 拒绝时透传原错误（不误报超时）', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, () => new Error('超时'))).rejects.toThrow('boom')
  })

  it('永不 settle 时按超时处理', async () => {
    const p = withTimeout(new Promise<never>(() => {}), 20, () => new InferenceTimeoutError(20))
    await expect(p).rejects.toBeInstanceOf(InferenceTimeoutError)
    await expect(p).rejects.toThrow('推理超时 20ms')
  })
})

function fakeSession(run: () => Promise<Record<string, unknown>>): ModelSession {
  return {
    session: { run } as unknown as ModelSession['session'],
    inputName: 'images',
    outputName: 'output0',
    rows: 25200,
  }
}

describe('runModel', () => {
  it('后端挂起时抛推理超时，而不是无限等待', async () => {
    const m = fakeSession(() => new Promise(() => {}))
    await expect(runModel(m, new Float32Array(3 * 640 * 640), 20)).rejects.toBeInstanceOf(InferenceTimeoutError)
  })

  it('正常输出时拷贝为 Float32Array', async () => {
    const values = new Float32Array([1, 2, 3])
    const m = fakeSession(async () => ({ output0: { data: values } }))
    const out = await runModel(m, new Float32Array(3 * 640 * 640), 1000)
    expect(out).toBe(values)
  })

  it('输出缺少目标张量时报错', async () => {
    const m = fakeSession(async () => ({}))
    await expect(runModel(m, new Float32Array(3 * 640 * 640), 1000)).rejects.toThrow('推理输出缺少 output0')
  })
})
