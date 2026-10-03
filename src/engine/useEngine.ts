// 主线程侧引擎封装：EngineWorker 生命周期 + 搜索请求/响应 + 事件订阅
// 搜索队列在 Worker 内维护（pendingFen/stop 模式，照抄 AnalysisEngine.kt）

import { ref, shallowRef } from 'vue'
import { parseInfoLine, parseBestmoveLine, toRedScore, wdlToWinRate, cpToWinRate } from './uci'
import type { EngineInfo, EngineScore, BestmoveResult } from './uci'
import { workerSource } from './worker'

export type EngineStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface SearchRequest {
  fen: string
  moves: string[]
  depth?: number
  movetime?: number
  multipv?: number
  /** 排除的着法（UCCI），用于长将/困毙拦截后的重搜 */
  excluded?: string[]
}

// 引擎文件目录绝对 URL（build 后 base './' 下仍正确）
const ENGINE_DIR = new URL(import.meta.env.BASE_URL + 'engine/', location.href).href

const status = ref<EngineStatus>('idle')
const engineName = ref('')
const error = ref('')
const lastInfo = shallowRef<EngineInfo | null>(null)

let worker: Worker | null = null
let readyResolved = false
const readyWaiters: (() => void)[] = []
// info 订阅（带搜索 id，用于分析器按 id 过滤）
const infoListeners = new Set<(id: number, i: EngineInfo) => void>()

let searchSeq = 0
const pendingSearches = new Map<number, (r: BestmoveResult) => void>()

const SEARCH_TIMEOUT_MS = 30_000

function onWorkerMessage(e: MessageEvent): void {
  const msg = e.data as
    | { type: 'ready'; engineId: string; engineName: string }
    | { type: 'info'; id: number; text: string }
    | { type: 'bestmove'; id: number; text: string }
    | { type: 'log'; text: string }

  if (msg.type === 'ready') {
    readyResolved = true
    engineName.value = msg.engineName
    status.value = 'ready'
    for (const w of readyWaiters) w()
    readyWaiters.length = 0
    // 预热引擎缓存（PWA 离线）：首次加载时 SW 尚未控制页面，引擎文件的 XHR
    // 未被 runtimeCaching 拦截；主动写入与 workbox 相同的 cacheName
    void warmEngineCache()
    return
  }

async function warmEngineCache(): Promise<void> {
  if (typeof caches === 'undefined') return
  try {
    const cache = await caches.open('engine-assets')
    for (const f of ['pikafish.js', 'pikafish.wasm', 'pikafish.data']) {
      const url = new URL(ENGINE_DIR + f, location.href).href
      if (!(await cache.match(url))) {
        await cache.add(url)
      }
    }
  } catch (err) {
    console.warn('引擎缓存预热失败:', err)
  }
}
  if (msg.type === 'info') {
    const info = parseInfoLine(msg.text)
    if (info) {
      lastInfo.value = info
      for (const cb of infoListeners) cb(msg.id, info)
    }
    return
  }
  if (msg.type === 'bestmove') {
    const result = parseBestmoveLine(msg.text)
    if (result) {
      const resolve = pendingSearches.get(msg.id)
      if (resolve) {
        pendingSearches.delete(msg.id)
        resolve(result)
      }
    }
    return
  }
  if (msg.type === 'log') {
    console.log('[engine]', msg.text)
  }
}

async function waitReady(): Promise<void> {
  if (readyResolved) return
  await new Promise<void>((resolve) => readyWaiters.push(resolve))
}

// MultiPV 通过 setoption 设置（pikafish/Stockfish 不支持 go multipv 参数）。
// 主线程 postMessage 有序 + worker 命令队列串行，setoption 保证先于随后的 position/go 执行。
let currentMultiPv = 1
function ensureMultiPv(n: number): void {
  if (currentMultiPv === n) return
  currentMultiPv = n
  sendUci(`setoption name MultiPV value ${n}`)
}

/** 初始化引擎（幂等）：加载 WASM + UCI 握手，首次约 1-3 秒 */
export function initEngine(): void {
  if (worker) return
  status.value = 'loading'
  error.value = ''
  // Blob classic worker：社区 pikafish.js 构建仅在裸 classic worker 中工作正常
  // （vite 打包 worker 在 dev/build 下均静默失效，见 worker.ts 头注释）
  const blobUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
  worker = new Worker(blobUrl)
  worker.onmessage = onWorkerMessage
  worker.onerror = (e) => {
    error.value = e.message || 'Worker 错误'
    status.value = 'error'
  }
  worker.postMessage({ type: 'init', engineDir: ENGINE_DIR })
}

/** 直通 UCI 命令（setoption 等） */
export function sendUci(cmd: string): void {
  worker?.postMessage({ type: 'uci', cmd })
}

/** 开始新对局：清空引擎内部状态 */
export async function engineNewGame(): Promise<void> {
  await waitReady()
  sendUci('ucinewgame')
}

/** 设置引擎选项（难度切换等） */
export async function setEngineOption(name: string, value: string | number): Promise<void> {
  await waitReady()
  sendUci(`setoption name ${name} value ${value}`)
}

/**
 * 搜索并等待 bestmove。
 * 新搜索会 stop 旧搜索（Worker 内排队）；旧搜索的 promise 仍会 resolve，
 * 调用方应以棋盘回合/历史长度判断结果是否过期。
 */
export async function engineSearch(req: SearchRequest): Promise<BestmoveResult> {
  await waitReady()
  ensureMultiPv(1) // 对弈搜索固定单线
  const id = ++searchSeq
  const { fen, moves, depth, movetime, excluded } = req
  let goCmd = ''
  if (depth != null) goCmd = `depth ${depth}`
  else if (movetime != null) goCmd = `movetime ${movetime}`
  else goCmd = 'depth 12'

  return new Promise<BestmoveResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSearches.delete(id)
      reject(new Error(`引擎搜索超时（${SEARCH_TIMEOUT_MS}ms）`))
    }, SEARCH_TIMEOUT_MS)
    pendingSearches.set(id, (r) => {
      clearTimeout(timer)
      resolve(r)
    })
    worker?.postMessage({ type: 'go', id, fen, moves, goCmd, excluded: excluded ?? [] })
  })
}

/** 订阅 info 行（分析面板用），返回退订函数 */
export function onEngineInfo(cb: (id: number, info: EngineInfo) => void): () => void {
  infoListeners.add(cb)
  return () => infoListeners.delete(cb)
}

// ---- 分析模式 ----

export interface AnalysisLine {
  multipv: number
  depth: number
  /** 红方视角评分（已换算） */
  scoreRed: EngineScore
  /** 红方胜率 0-1（优先引擎 wdl，无则 cp 启发式） */
  winRateRed: number
  pv: string[]
}

const INFO_UPDATE_THROTTLE_MS = 100 // 分析面板节流（照抄 Android 版 100ms GUI 节流）

/**
 * MultiPV 分析：流式回调候选着法（按 multipv 分组，取各线最新 info），
 * bestmove 到达时 resolve。回调节流 100ms。
 */
export async function engineAnalyze(
  req: SearchRequest,
  onUpdate: (lines: AnalysisLine[]) => void,
): Promise<BestmoveResult> {
  await waitReady()
  const multipv = req.multipv ?? 3
  ensureMultiPv(multipv)
  const sideToMove = req.fen.split(' ')[1] === 'b' ? 'b' : 'w'

  return new Promise<BestmoveResult>((resolve, reject) => {
    const id = ++searchSeq
    const { fen, moves, depth, movetime, excluded } = req
    let goCmd = ''
    if (depth != null) goCmd = `depth ${depth}`
    else if (movetime != null) goCmd = `movetime ${movetime}`
    else goCmd = 'depth 16'

    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`引擎分析超时（${SEARCH_TIMEOUT_MS}ms）`))
    }, SEARCH_TIMEOUT_MS)

    const collected = new Map<number, EngineInfo>()
    let lastFlush = 0

    const unsubscribe = onEngineInfo((searchId, info) => {
      if (searchId !== id) return
      collected.set(info.multipv, info)
      const now = Date.now()
      if (now - lastFlush < INFO_UPDATE_THROTTLE_MS) return
      lastFlush = now
      onUpdate(toLines(collected, sideToMove))
    })

    pendingSearches.set(id, (r) => {
      clearTimeout(timer)
      unsubscribe()
      onUpdate(toLines(collected, sideToMove)) // 终版
      resolve(r)
    })

    worker?.postMessage({ type: 'go', id, fen, moves, goCmd, excluded: excluded ?? [] })
  })
}

function toLines(collected: Map<number, EngineInfo>, sideToMove: 'w' | 'b'): AnalysisLine[] {
  const lines: AnalysisLine[] = []
  for (const [multipv, info] of collected) {
    const scoreRed = toRedScore(info.score, sideToMove)
    let winRateRed: number
    if (info.wdl) {
      winRateRed = wdlToWinRate(info.wdl, sideToMove)
    } else {
      winRateRed = cpToWinRate(scoreRed.kind === 'cp' ? scoreRed.value : scoreRed.value > 0 ? -100000 : 100000)
    }
    lines.push({ multipv, depth: info.depth, scoreRed, winRateRed, pv: info.pv })
  }
  lines.sort((a, b) => a.multipv - b.multipv)
  return lines
}

export function useEngine() {
  return {
    status,
    engineName,
    error,
    lastInfo,
    initEngine,
    engineSearch,
    engineAnalyze,
    engineNewGame,
    setEngineOption,
    onEngineInfo,
  }
}
