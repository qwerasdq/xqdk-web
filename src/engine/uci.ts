// UCI 协议解析：info/bestmove 行 → typed 结构；红方视角评分换算
// 口径照抄 Android 版 AnalysisModels.kt / AnalysisEngine.kt

export type SideToMove = 'w' | 'b'

export interface EngineScore {
  kind: 'cp' | 'mate'
  /** cp 为厘兵；mate 为正 = 走子方将在 N 步内被将死（负数 = 将杀对方） */
  value: number
}

export interface EngineInfo {
  depth: number
  seldepth: number
  multipv: number
  time: number
  nodes: number
  nps: number
  hashfull: number
  tbhits: number
  score: EngineScore
  /** 引擎原生胜率（千分比），开启 UCI_ShowWDL 后有值 */
  wdl: [number, number, number] | null
  /** 主要变例（UCCI 着法数组，如 ['h2e2','h9g7',...]） */
  pv: string[]
}

export interface BestmoveResult {
  move: string
  ponder: string | null
}

const INT_RE = {
  depth: /depth (\d+)/,
  seldepth: /seldepth (\d+)/,
  multipv: /multipv (\d+)/,
  time: /\btime (\d+)/,
  nodes: /\bnodes (\d+)/,
  nps: /\bnps (\d+)/,
  hashfull: /hashfull (\d+)/,
  tbhits: /tbhits (\d+)/,
}

function matchInt(line: string, re: RegExp): number {
  const m = line.match(re)
  return m ? Number.parseInt(m[1], 10) : 0
}

/** 解析单行 info 输出；非 info 行或无 score 时返回 null */
export function parseInfoLine(line: string): EngineInfo | null {
  if (!line.startsWith('info ')) return null

  const scoreMatch = line.match(/score (cp|mate) (-?\d+)/)
  if (!scoreMatch) return null

  let pv: string[] = []
  const pvMatch = line.match(/\bpv (.+)$/)
  if (pvMatch) pv = pvMatch[1].trim().split(/\s+/).filter(Boolean)

  let wdl: [number, number, number] | null = null
  const wdlMatch = line.match(/\bwdl (\d+) (\d+) (\d+)/)
  if (wdlMatch) wdl = [+wdlMatch[1], +wdlMatch[2], +wdlMatch[3]]

  return {
    depth: matchInt(line, INT_RE.depth),
    seldepth: matchInt(line, INT_RE.seldepth),
    multipv: matchInt(line, INT_RE.multipv),
    time: matchInt(line, INT_RE.time),
    nodes: matchInt(line, INT_RE.nodes),
    nps: matchInt(line, INT_RE.nps),
    hashfull: matchInt(line, INT_RE.hashfull),
    tbhits: matchInt(line, INT_RE.tbhits),
    score: { kind: scoreMatch[1] as 'cp' | 'mate', value: Number.parseInt(scoreMatch[2], 10) },
    wdl,
    pv,
  }
}

/** 解析 bestmove 行；非 bestmove 行返回 null */
export function parseBestmoveLine(line: string): BestmoveResult | null {
  if (!line.startsWith('bestmove ')) return null
  const m = line.match(/^bestmove (\S+)(?: ponder (\S+))?/)
  if (!m) return null
  return { move: m[1], ponder: m[2] ?? null }
}

/**
 * 引擎实际搜索的那个局面的走子方。
 *
 * 调用方给的是 `position fen <fen> moves <moves...>` 的起始局面 + 完整历史
 * （见 SearchRequest），着法由引擎自己应用；走子方因此 = 起始局的 side 按着法数
 * 奇偶翻转。直接读 `fen` 的 side 字段会在奇数着法后判反，
 * 导致红方视角的评分/胜率整体颠倒。
 */
export function sideToMoveAfter(fen: string, moves: readonly string[]): SideToMove {
  const base: SideToMove = fen.split(' ')[1] === 'b' ? 'b' : 'w'
  if (moves.length % 2 === 0) return base
  return base === 'w' ? 'b' : 'w'
}

/**
 * 红方视角评分换算（照抄 AnalysisModels.kt）：
 * 引擎 score 是"走子方视角"（即 FEN side-to-move 一方），
 * UI 统一红方视角：side 为黑时 cp 取反、mate 符号翻转
 */
export function toRedScore(score: EngineScore, sideToMove: SideToMove): EngineScore {
  if (sideToMove === 'b') {
    return { kind: score.kind, value: -score.value }
  }
  return score
}

/** 胜率换算：优先引擎原生 wdl；无 wdl 时按 cp 启发式（照抄 Android 版口径） */
export function wdlToWinRate(wdl: [number, number, number], sideToMove: SideToMove): number {
  const [win, draw, lose] = wdl
  // win/draw/lose 是走子方视角千分比；换算红方视角
  const rate = (win + draw / 2) / (win + draw + lose || 1)
  return sideToMove === 'b' ? 1 - rate : rate
}

export function cpToWinRate(cp: number): number {
  // 简化的 cp→胜率 sigmoid（与 Android 版口径一致的启发式）
  return 1 / (1 + Math.pow(10, -cp / 400))
}
