// onnxruntime-web 会话管理：WASM(SIMD+threads) EP、wasm 路径与线程配置、形状自检
//
// 部署约束：ort 的 wasm 二进制由 scripts/vision-assets.mjs 复制到 public/ort/（不入 git），
// 运行时通过 ortDir 参数告知本模块（由主线程按 document.baseURI 计算，兼容子路径部署）。
//
// 后端选择（W6e）：只保留 WASM。ORT 1.22 的 WebGPU 在设备丢失（驱动重置/多显卡切换/远程桌面/
// 休眠唤醒）后 run() 会永久挂起、同 realm 无法重建会话，只能靠换 worker 兜底；而识别按 ~800ms/帧
// 节流，本机实测推理 p50 83ms（含前后处理 ~92ms/帧），WASM 已有 8 倍余量。用一整套恢复状态机换一个
// 用不上的加速不划算，故移除 WebGPU，并改用非 jsep 构建（wasm 由 20.9MiB 降到 10.7MiB）。

import * as ort from 'onnxruntime-web/wasm'
import { MODEL_INPUT } from './postprocess'

/** 单帧推理超时：预热后稳态 ~100ms，超时基本可断定后端异常（兜底，避免 run() 挂起后 worker 永久卡住） */
export const INFER_TIMEOUT_MS = 5000

export interface ModelSession {
  session: ort.InferenceSession
  inputName: string
  outputName: string
  /** 输出行数（应为 ANCHORS=25200），用于运行时自检 */
  rows: number
}

/** 推理超时（后端异常挂起） */
export class InferenceTimeoutError extends Error {
  constructor(ms: number) {
    super(`推理超时 ${ms}ms（识别后端可能已断开）`)
    this.name = 'InferenceTimeoutError'
  }
}

let envReady = false

/** 全局 ort 环境配置（幂等） */
export function setupOrt(ortDir: string): void {
  if (envReady) return
  ort.env.wasm.wasmPaths = ortDir
  // threaded wasm 需 SharedArrayBuffer（COOP/COEP 已由部署响应头提供）；
  // 未隔离时显式降到单线程，避免 ort 内部警告与潜在失败
  const isolated = typeof self !== 'undefined' && (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
  ort.env.wasm.numThreads = isolated ? Math.min(4, Math.max(1, (navigator.hardwareConcurrency ?? 4) - 1)) : 1
  ort.env.logLevel = 'error'
  envReady = true
}

/** 竞速超时包装：超时后抛出可识别的错误（原 Promise 被放弃——挂起的 run() 永不 settle，无人再 await 它） */
export function withTimeout<T>(p: Promise<T>, ms: number, err: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(err()), ms)
    p.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** 执行一次推理（裸会话版），超时抛 InferenceTimeoutError */
async function runCore(
  session: ort.InferenceSession,
  inputName: string,
  outputName: string,
  data: Float32Array,
  timeoutMs: number,
): Promise<Float32Array> {
  const feeds: Record<string, ort.Tensor> = {
    [inputName]: new ort.Tensor('float32', data, [1, 3, MODEL_INPUT, MODEL_INPUT]),
  }
  const out = await withTimeout(session.run(feeds), timeoutMs, () => new InferenceTimeoutError(timeoutMs))
  const t = out[outputName]
  if (!t) throw new Error(`推理输出缺少 ${outputName}`)
  return t.data instanceof Float32Array ? (t.data as Float32Array) : Float32Array.from(t.data as ArrayLike<number>)
}

function safeRelease(session: ort.InferenceSession): void {
  try {
    void session.release().catch(() => {})
  } catch {
    // 挂起的会话 release 可能抛错，忽略
  }
}

/** 创建 + 形状自检 + 预热。任一步失败则释放会话并抛出 */
async function prepareSession(modelUrl: string): Promise<ModelSession> {
  const session = await ort.InferenceSession.create(modelUrl, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  })
  try {
    const input = session.inputMetadata[0]
    const output = session.outputMetadata[0]
    if (!input || !input.isTensor || input.name === undefined) throw new Error('模型无可用的张量输入')
    if (!output || !output.isTensor) throw new Error('模型无可用的张量输出')

    const inShape = input.shape.map(Number)
    if (inShape.length !== 4 || inShape[1] !== 3 || inShape[2] !== MODEL_INPUT || inShape[3] !== MODEL_INPUT) {
      throw new Error(`模型输入形状 ${JSON.stringify(input.shape)} 与预期 [1,3,${MODEL_INPUT},${MODEL_INPUT}] 不符`)
    }
    const outShape = output.shape.map(Number)
    if (outShape.length !== 3 || outShape[2] !== 20) {
      throw new Error(`模型输出形状 ${JSON.stringify(output.shape)} 与预期 [1,N,20] 不符`)
    }

    // 预热（零输入，结果丢弃）：把首次推理的 wasm 实例/线程池初始化前移，同时验证会话真实可用
    await runCore(session, input.name, output.name, new Float32Array(3 * MODEL_INPUT * MODEL_INPUT), INFER_TIMEOUT_MS)

    return {
      session,
      inputName: input.name,
      outputName: output.name,
      rows: outShape[1]!,
    }
  } catch (e) {
    safeRelease(session)
    throw e
  }
}

/** 创建 WASM 会话。失败即抛出，由上层展示错误（不做同 realm 重试/回退） */
export async function createSession(modelUrl: string, ortDir: string): Promise<ModelSession> {
  setupOrt(ortDir)
  return prepareSession(modelUrl)
}

/** 执行一次推理，返回扁平的 [rows*20] float32（已拷贝出 ort 张量）。超时抛 InferenceTimeoutError */
export async function runModel(m: ModelSession, data: Float32Array, timeoutMs = INFER_TIMEOUT_MS): Promise<Float32Array> {
  return runCore(m.session, m.inputName, m.outputName, data, timeoutMs)
}
