// 主线程侧引擎封装：EngineWorker 生命周期 + 搜索请求/响应 + 事件订阅
// 搜索队列在 Worker 内维护（pendingFen/stop 模式，照抄 AnalysisEngine.kt）

import { ref, shallowRef } from 'vue'
import {
  parseInfoLine,
  parseBestmoveLine,
  sideToMoveAfter,
  toRedScore,
  wdlToWinRate,
  cpToWinRate,
} from './uci'
import type { EngineInfo, EngineScore, BestmoveResult } from './uci'
import { workerSource } from './worker'
import { createAnalysisCache, makeAnalysisCacheKey } from './analysisCache'
import type { AnalysisCacheEntry } from './analysisCache'

export type EngineStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface SearchRequest {
  /** 起始局面（不是当前局面） */
  fen: string
  /** 起始局面之后的完整着法历史（UCCI），由引擎按顺序应用 */
  moves: string[]
  depth?: number
  movetime?: number
  multipv?: number
  /**
   * 限制根着法搜索范围（UCI searchmoves 语义：**只搜**列出的着法）。
   * 注意 UCI 没有「排除着法」指令——要排除若干着法，传「全部合法着法 − 排除项」
   * （见 xiangqi/rule.ts 的 allLegalMoves）。空数组 = 不限制。
   */
  searchmoves?: string[]
}

// 引擎文件目录绝对 URL（build 后 base './' 下仍正确）
const ENGINE_DIR = new URL(import.meta.env.BASE_URL + 'engine/', location.href).href

const status = ref<EngineStatus>('idle')
const engineName = ref('')
const error = ref('')
const lastInfo = shallowRef<EngineInfo | null>(null)

let worker: Worker | null = null
let workerUrl: string | null = null
let readyResolved = false
type ReadyWaiter = { resolve: () => void; reject: (error: Error) => void }
const readyWaiters: ReadyWaiter[] = []
// info 订阅（带搜索 id，用于分析器按 id 过滤）
const infoListeners = new Set<(id: number, i: EngineInfo) => void>()

let searchSeq = 0
const pendingSearches = new Map<number, (r: BestmoveResult) => void>()

const SEARCH_TIMEOUT_MS = 30_000
const ENGINE_INIT_TIMEOUT_MS = 30_000
let initTimer: ReturnType<typeof setTimeout> | null = null

function clearInitTimer(): void {
  if (initTimer !== null) {
    clearTimeout(initTimer)
    initTimer = null
  }
}

function disposeWorker(): void {
  clearInitTimer()
  if (worker) {
    worker.onmessage = null
    worker.onerror = null
    worker.onmessageerror = null
    worker.terminate()
    worker = null
  }
  if (workerUrl) {
    URL.revokeObjectURL(workerUrl)
    workerUrl = null
  }
}

function failEngine(message: string): void {
  const detail = message || 'engine initialization failed'
  status.value = 'error'
  error.value = detail
  readyResolved = false
  const failure = new Error(detail)
  for (const waiter of readyWaiters) waiter.reject(failure)
  readyWaiters.length = 0
  disposeWorker()
}

function onWorkerMessage(e: MessageEvent): void {
  const msg = e.data as
    | { type: 'ready'; engineId: string; engineName: string }
    | { type: 'info'; id: number; text: string }
    | { type: 'bestmove'; id: number; text: string }
    | { type: 'error'; text: string }
    | { type: 'log'; text: string }

  if (msg.type === 'ready') {
    clearInitTimer()
    readyResolved = true
    engineName.value = msg.engineName
    status.value = 'ready'
    for (const waiter of readyWaiters) waiter.resolve()
    readyWaiters.length = 0
    // 预热引擎缓存（PWA 离线）：首次加载时 SW 尚未控制页面，引擎文件的 XHR
    // 未被 runtimeCaching 拦截；主动写入与 workbox 相同的 cacheName
    void warmEngineCache()
    return
  }

  if (msg.type === 'error') {
    failEngine(msg.text)
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
  if (status.value === 'error') {
    throw new Error(error.value || 'engine initialization failed')
  }
  await new Promise<void>((resolve, reject) => readyWaiters.push({ resolve, reject }))
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
  readyResolved = false
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
  if (typeof SharedArrayBuffer === 'undefined' || !isolated) {
    failEngine('engine requires a secure, cross-origin-isolated page; open http://localhost:5173 or use HTTPS')
    return
  }
  // Blob classic worker：社区 pikafish.js 构建仅在裸 classic worker 中工作正常
  // （vite 打包 worker 在 dev/build 下均静默失效，见 worker.ts 头注释）
  const blobUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
  workerUrl = blobUrl
  worker = new Worker(blobUrl)
  worker.onmessage = onWorkerMessage
  worker.onerror = (e) => failEngine(e.message || 'engine worker error')
  worker.onmessageerror = () => failEngine('engine worker message error')
  initTimer = setTimeout(() => failEngine('engine initialization timed out'), ENGINE_INIT_TIMEOUT_MS)
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
  const { fen, moves, depth, movetime, searchmoves } = req
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
    worker?.postMessage({ type: 'go', id, fen, moves, goCmd, searchmoves: searchmoves ?? [] })
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

/** 分析结果缓存（复盘步进/回退重复局面直接命中，不再重复搜索） */
const analysisCache = createAnalysisCache(64)

/** 清空分析缓存（引擎选项变化/新对局时可调用） */
export function clearAnalysisCache(): void {
  analysisCache.clear()
}

/**
 * MultiPV 分析：流式回调候选着法（按 multipv 分组，取各线最新 info），
 * bestmove 到达时 resolve。回调节流 100ms。
 * 命中缓存时直接回调终版结果，不发起新搜索。
 */
export async function engineAnalyze(
  req: SearchRequest,
  onUpdate: (lines: AnalysisLine[]) => void,
): Promise<BestmoveResult> {
  await waitReady()
  const multipv = req.multipv ?? 3
  // 起始局面 + 历史着法 → 引擎实际搜索局面的走子方（不能直接读 req.fen 的 side）
  const sideToMove = sideToMoveAfter(req.fen, req.moves)

  const cacheKey = makeAnalysisCacheKey({ ...req, multipv })
  const cached = analysisCache.get(cacheKey)
  if (cached) {
    onUpdate(cached.lines)
    return cached.result
  }

  ensureMultiPv(multipv)

  return new Promise<BestmoveResult>((resolve, reject) => {
    const id = ++searchSeq
    const { fen, moves, depth, movetime, searchmoves } = req
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
      const lines = toLines(collected, sideToMove)
      onUpdate(lines) // 终版
      // 仅缓存自然完成（未被新搜索 stop）的结果，避免把浅层截断结果当终版缓存
      if (searchSeq === id) {
        const entry: AnalysisCacheEntry = { lines, result: r }
        analysisCache.set(cacheKey, entry)
      }
      resolve(r)
    })

    worker?.postMessage({ type: 'go', id, fen, moves, goCmd, searchmoves: searchmoves ?? [] })
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
