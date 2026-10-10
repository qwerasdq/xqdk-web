// 引擎分析缓存：按「局面 + 着法序列 + 搜索参数」缓存最终分析结果。
// 复盘场景反复步进/回退时，相同局面直接命中缓存，不再重复发起搜索。

import type { BestmoveResult } from './uci'
import type { AnalysisLine } from './useEngine'

export interface AnalysisCacheRequest {
  fen: string
  moves: string[]
  depth?: number
  movetime?: number
  /** 实际生效的 MultiPV（缺省 3，与 engineAnalyze 一致） */
  multipv?: number
  /** UCI searchmoves 语义：只搜列出的着法（空/缺省 = 不限制） */
  searchmoves?: string[]
}

export interface AnalysisCacheEntry {
  lines: AnalysisLine[]
  result: BestmoveResult
}

/** 缓存键：FEN 规范化 + 有序着法 + 搜索参数（searchmoves 排序去敏） */
export function makeAnalysisCacheKey(req: AnalysisCacheRequest): string {
  const multipv = req.multipv ?? 3
  const limit = req.depth != null ? `d${req.depth}` : req.movetime != null ? `t${req.movetime}` : 'd16'
  const searchmoves = [...(req.searchmoves ?? [])].sort().join(',')
  return [req.fen.trim(), req.moves.join(' '), limit, `p${multipv}`, searchmoves].join('|')
}

export interface AnalysisCache {
  get(key: string): AnalysisCacheEntry | undefined
  set(key: string, entry: AnalysisCacheEntry): void
  clear(): void
  readonly size: number
}

/** 简单 LRU：Map 迭代序即插入序，命中时删除重插 */
export function createAnalysisCache(limit = 64): AnalysisCache {
  const map = new Map<string, AnalysisCacheEntry>()
  return {
    get(key) {
      const entry = map.get(key)
      if (entry) {
        map.delete(key)
        map.set(key, entry)
      }
      return entry
    },
    set(key, entry) {
      if (map.has(key)) map.delete(key)
      map.set(key, entry)
      if (map.size > limit) {
        const oldest = map.keys().next().value
        if (oldest !== undefined) map.delete(oldest)
      }
    },
    clear() {
      map.clear()
    },
    get size() {
      return map.size
    },
  }
}
