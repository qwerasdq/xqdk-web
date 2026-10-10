// 分析缓存测试：键规范化 + LRU 行为
import { describe, expect, it } from 'vitest'
import { createAnalysisCache, makeAnalysisCacheKey } from './analysisCache'
import type { AnalysisLine } from './useEngine'
import type { BestmoveResult } from './uci'

const FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'

function line(multipv: number, depth: number): AnalysisLine {
  return {
    multipv,
    depth,
    scoreRed: { kind: 'cp', value: 10 * multipv },
    winRateRed: 0.5,
    pv: ['h2e2', 'h9g7'],
  }
}

const RESULT: BestmoveResult = { move: 'h2e2', ponder: null }

describe('makeAnalysisCacheKey', () => {
  it('相同请求生成相同键', () => {
    const a = makeAnalysisCacheKey({ fen: FEN, moves: ['h2e2', 'h9g7'], depth: 16, multipv: 3 })
    const b = makeAnalysisCacheKey({ fen: FEN, moves: ['h2e2', 'h9g7'], depth: 16, multipv: 3 })
    expect(a).toBe(b)
  })

  it('depth/multipv/moves 不同则键不同', () => {
    const base = makeAnalysisCacheKey({ fen: FEN, moves: [], depth: 16, multipv: 3 })
    expect(makeAnalysisCacheKey({ fen: FEN, moves: [], depth: 12, multipv: 3 })).not.toBe(base)
    expect(makeAnalysisCacheKey({ fen: FEN, moves: [], depth: 16, multipv: 1 })).not.toBe(base)
    expect(makeAnalysisCacheKey({ fen: FEN, moves: ['h2e2'], depth: 16, multipv: 3 })).not.toBe(base)
  })

  it('searchmoves 排序后等价（顺序不敏感），缺省与空数组等价', () => {
    const a = makeAnalysisCacheKey({ fen: FEN, moves: [], depth: 16, searchmoves: ['h2e2', 'b0c2'] })
    const b = makeAnalysisCacheKey({ fen: FEN, moves: [], depth: 16, searchmoves: ['b0c2', 'h2e2'] })
    const c = makeAnalysisCacheKey({ fen: FEN, moves: [], depth: 16 })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('movetime 与 depth 互斥区分，缺省等同 depth 16', () => {
    const t = makeAnalysisCacheKey({ fen: FEN, moves: [], movetime: 3000 })
    const d = makeAnalysisCacheKey({ fen: FEN, moves: [], depth: 16 })
    expect(t).toBe(makeAnalysisCacheKey({ fen: FEN, moves: [], movetime: 3000 }))
    expect(t).not.toBe(d)
  })
})

describe('createAnalysisCache (LRU)', () => {
  it('set/get 往返，命中后重插保持最近使用', () => {
    const cache = createAnalysisCache(3)
    const e1 = { lines: [line(1, 10)], result: RESULT }
    const e2 = { lines: [line(1, 12)], result: RESULT }
    const e3 = { lines: [line(1, 14)], result: RESULT }
    cache.set('a', e1)
    cache.set('b', e2)
    cache.set('c', e3)
    // 访问 a 使其成为最近使用
    expect(cache.get('a')).toBe(e1)
    // 插入 d 应淘汰最久未用的 b
    cache.set('d', { lines: [line(1, 16)], result: RESULT })
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(e1)
    expect(cache.get('c')).toBe(e3)
    expect(cache.size).toBe(3)
  })

  it('超过上限时淘汰最旧条目', () => {
    const cache = createAnalysisCache(2)
    cache.set('a', { lines: [], result: RESULT })
    cache.set('b', { lines: [], result: RESULT })
    cache.set('c', { lines: [], result: RESULT })
    expect(cache.size).toBe(2)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBeDefined()
    expect(cache.get('c')).toBeDefined()
  })

  it('clear 清空', () => {
    const cache = createAnalysisCache(4)
    cache.set('a', { lines: [], result: RESULT })
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.get('a')).toBeUndefined()
  })
})
