// onnxruntime-web 会话管理：EP 选择（WebGPU 优先 → WASM 回退）、wasm 路径与线程配置、形状自检
//
// 部署约束：ort 的 wasm 二进制由 scripts/vision-assets.mjs 复制到 public/ort/（不入 git），
// 运行时通过 ortDir 参数告知本模块（由主线程按 document.baseURI 计算，兼容子路径部署）。

import * as ort from 'onnxruntime-web'
import { MODEL_INPUT } from './postprocess'

export type Backend = 'webgpu' | 'wasm'

export interface ModelSession {
  session: ort.InferenceSession
  ep: Backend
  inputName: string
  outputName: string
  /** 输出行数（应为 ANCHORS=25200），用于运行时自检 */
  rows: number
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

async function createWith(modelUrl: string, ep: Backend): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(modelUrl, {
    executionProviders: [ep],
    graphOptimizationLevel: 'all',
  })
}

/**
 * 创建会话。prefer='auto' 时先试 WebGPU，失败或模型含不支持算子则回退 WASM。
 * 创建后做输入/输出形状自检——形状不符（如换模型后布局变化）立即报错，不留到推理时。
 */
export async function createSession(
  modelUrl: string,
  ortDir: string,
  prefer: 'auto' | Backend = 'auto',
): Promise<ModelSession> {
  setupOrt(ortDir)

  let session: ort.InferenceSession | null = null
  let ep: Backend = 'wasm'
  if (prefer !== 'wasm') {
    try {
      session = await createWith(modelUrl, 'webgpu')
      ep = 'webgpu'
    } catch (e) {
      if (prefer === 'webgpu') throw e
      session = null
    }
  }
  if (session === null) {
    session = await createWith(modelUrl, 'wasm')
    ep = 'wasm'
  }

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

  return {
    session,
    ep,
    inputName: input.name,
    outputName: output.name,
    rows: outShape[1]!,
  }
}

/** 执行一次推理，返回扁平的 [rows*20] float32（已拷贝出 ort 张量） */
export async function runModel(m: ModelSession, data: Float32Array): Promise<Float32Array> {
  const feeds: Record<string, ort.Tensor> = {
    [m.inputName]: new ort.Tensor('float32', data, [1, 3, MODEL_INPUT, MODEL_INPUT]),
  }
  const out = await m.session.run(feeds)
  const t = out[m.outputName]
  if (!t) throw new Error(`推理输出缺少 ${m.outputName}`)
  return t.data instanceof Float32Array ? (t.data as Float32Array) : Float32Array.from(t.data as ArrayLike<number>)
}