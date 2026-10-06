// onnxruntime-web 会话管理：EP 选择（WebGPU 优先 → WASM 回退）、wasm 路径与线程配置、形状自检
//
// 部署约束：ort 的 wasm 二进制由 scripts/vision-assets.mjs 复制到 public/ort/（不入 git），
// 运行时通过 ortDir 参数告知本模块（由主线程按 document.baseURI 计算，兼容子路径部署）。
//
// 稳定性约束（W6d 加固）：WebGPU 设备丢失（驱动重置/多显卡切换/远程桌面/休眠唤醒）后，
// ORT 1.22 的 session.run() 不会 reject，而是**永久挂起**（本机实测）——只靠 try/catch 无法恢复。
// 因此这里提供三层防护：
//   1. 初始化预热——首次 WebGPU 推理含着色器编译，预热把这段时间前移，同时验证后端真实可用，
//      失败的会话不会拖到第一帧才暴露；瞬时适配器失败（多显卡切换/驱动繁忙）重试一次。
//   2. watchDeviceLoss——监听运行时设备丢失（主动发现）。
//   3. 推理超时——run() 挂起超过 INFER_TIMEOUT_MS 判定后端断开（被动发现）。

import * as ort from 'onnxruntime-web'
import { MODEL_INPUT } from './postprocess'

export type Backend = 'webgpu' | 'wasm'

/** 单帧推理超时：预热后稳态 ~100ms，超时基本可断定后端挂起（设备丢失/驱动异常） */
export const INFER_TIMEOUT_MS = 5000

/** 会话创建 + 预热超时：设备异常时 ORT 可能既不返回也不报错，超时后走重试/回退，避免卡死在加载中 */
const SESSION_TIMEOUT_MS = 15000

/** WebGPU 创建失败后的重试间隔（适配器瞬时失败常见于多显卡机器） */
const WEBGPU_RETRY_DELAY_MS = 400

export interface ModelSession {
  session: ort.InferenceSession
  ep: Backend
  inputName: string
  outputName: string
  /** 输出行数（应为 ANCHORS=25200），用于运行时自检 */
  rows: number
  /** ep 落到 wasm 且曾尝试 WebGPU 时，记录 WebGPU 失败原因（UI 展示用） */
  fallbackReason?: string
}

/** 推理超时（后端挂起，典型场景是 WebGPU 设备丢失） */
export class InferenceTimeoutError extends Error {
  constructor(ms: number) {
    super(`推理超时 ${ms}ms（识别后端可能已断开）`)
    this.name = 'InferenceTimeoutError'
  }
}

/** 会话创建超时（设备异常，重试大概率同样卡死，不再重试） */
export class SessionInitTimeoutError extends Error {
  constructor(ep: Backend) {
    super(`创建 ${ep} 会话超时（${SESSION_TIMEOUT_MS}ms）`)
    this.name = 'SessionInitTimeoutError'
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
  ort.env.webgpu.powerPreference = 'high-performance'
  ort.env.logLevel = 'error'
  envReady = true
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

async function createWith(modelUrl: string, ep: Backend): Promise<ort.InferenceSession> {
  return withTimeout(
    ort.InferenceSession.create(modelUrl, {
      executionProviders: [ep],
      graphOptimizationLevel: 'all',
    }),
    SESSION_TIMEOUT_MS,
    () => new SessionInitTimeoutError(ep),
  )
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

/** 创建 + 形状自检 + 预热。任一步失败则释放会话并抛出，由上层决定重试/回退 */
async function prepareSession(modelUrl: string, ep: Backend): Promise<ModelSession> {
  const session = await createWith(modelUrl, ep)
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

    // 预热（零输入，结果丢弃）：WebGPU 首次推理含着色器编译（本机实测 ~0.8s，弱显卡更久）
    await runCore(session, input.name, output.name, new Float32Array(3 * MODEL_INPUT * MODEL_INPUT), SESSION_TIMEOUT_MS)

    return {
      session,
      ep,
      inputName: input.name,
      outputName: output.name,
      rows: outShape[1]!,
    }
  } catch (e) {
    safeRelease(session)
    throw e
  }
}

/**
 * 创建会话。prefer='auto' 时先试 WebGPU（失败重试一次后抛出，由上层换新 Worker 启动 WASM），
 * prefer='webgpu' 时失败直接抛出。不能在同一 Worker 内回退 WASM：WebGPU 与 WASM 共享 ORT runtime，
 * 前者初始化失败可能会把后者标记为 aborted。
 */
export async function createSession(
  modelUrl: string,
  ortDir: string,
  prefer: 'auto' | Backend = 'auto',
): Promise<ModelSession> {
  setupOrt(ortDir)
  if (prefer === 'wasm') return prepareSession(modelUrl, 'wasm')

  let lastErr: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await prepareSession(modelUrl, 'webgpu')
    } catch (e) {
      lastErr = e
      if (prefer === 'webgpu') throw e
      // 超时说明设备真的异常，重试大概率同样卡 15s，不再重试
      if (e instanceof SessionInitTimeoutError) break
      if (attempt === 0) await delay(WEBGPU_RETRY_DELAY_MS)
    }
  }

  // A timed-out WebGPU initialization may still be running inside ORT. Starting
  // WASM in this realm can re-enter initWasm() and fail with "multiple calls".
  // Let the caller terminate this worker and retry WASM in a fresh realm.
  if (lastErr instanceof SessionInitTimeoutError) throw lastErr

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * 监听会话所用 WebGPU 设备的丢失事件（WASM 会话为 no-op）。
 * 设备丢失后该会话的 run() 会永久挂起，必须靠此信号（或推理超时）提前切换后端。
 */
export async function watchDeviceLoss(m: ModelSession, onLost: (reason: string) => void): Promise<void> {
  if (m.ep !== 'webgpu') return
  try {
    const device = (await ort.env.webgpu.device) as unknown as { lost?: Promise<{ reason?: string }> } | undefined
    if (!device || typeof device.lost?.then !== 'function') return
    void device.lost.then((info) => onLost(info?.reason ?? 'unknown'))
  } catch {
    // 拿不到设备对象时依赖推理超时兜底，不影响会话本身
  }
}

/** 执行一次推理，返回扁平的 [rows*20] float32（已拷贝出 ort 张量）。超时抛 InferenceTimeoutError */
export async function runModel(m: ModelSession, data: Float32Array, timeoutMs = INFER_TIMEOUT_MS): Promise<Float32Array> {
  return runCore(m.session, m.inputName, m.outputName, data, timeoutMs)
}
