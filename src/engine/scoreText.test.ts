// 评分文案测试：mate 符号是踩过坑的地方
// UCI 规范 + 实测：mate 正 = 走子方将杀对方；toRedScore 换算后正 = 红方将杀
import { describe, expect, it } from 'vitest'
import { scoreText } from './scoreText'
import { toRedScore, sideToMoveAfter, parseInfoLine, cpToWinRate } from './uci'

const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'

describe('scoreText（入参为红方视角评分）', () => {
  it('cp 带符号两位小数', () => {
    expect(scoreText({ kind: 'cp', value: 35 })).toBe('+0.35')
    expect(scoreText({ kind: 'cp', value: -62 })).toBe('-0.62')
    expect(scoreText({ kind: 'cp', value: 0 })).toBe('+0.00')
  })

  it('mate 正 = 红方将杀，负 = 红方被杀', () => {
    expect(scoreText({ kind: 'mate', value: 5 })).toBe('红方 5 步杀')
    expect(scoreText({ kind: 'mate', value: -3 })).toBe('红方 3 步被杀')
    expect(scoreText({ kind: 'mate', value: 1 })).toBe('红方 1 步杀')
  })
})

// 回归：红先双车必胜局面，引擎给 mate 1（正）。红方视角应仍为正 -> 显示"红方 1 步杀"。
// 旧代码把 mate>0 显示成"红方 N 步被杀"，与实际正好相反。
describe('回归：mate 符号经红方视角换算后的展示', () => {
  it('红方将杀（引擎 mate 正、红先）', () => {
    const side = sideToMoveAfter(START_FEN, [])
    const info = parseInfoLine('info depth 12 multipv 1 score mate 1 pv a8a9')!
    const scoreRed = toRedScore(info.score, side)
    expect(scoreRed).toEqual({ kind: 'mate', value: 1 })
    expect(scoreText(scoreRed)).toBe('红方 1 步杀')
  })

  it('黑方将杀红方（引擎 mate 正、轮黑走）→ 红方被杀', () => {
    const side = sideToMoveAfter(START_FEN, ['h2e2'])
    const info = parseInfoLine('info depth 12 multipv 1 score mate 2 pv h9g7')!
    const scoreRed = toRedScore(info.score, side)
    expect(scoreRed).toEqual({ kind: 'mate', value: -2 })
    expect(scoreText(scoreRed)).toBe('红方 2 步被杀')
  })

  it('黑方被杀（引擎 mate 负、轮黑走）→ 红方将杀', () => {
    // 实测：红方双车局面轮到黑走，引擎输出 score mate -1
    const side = sideToMoveAfter(START_FEN, ['h2e2'])
    const info = parseInfoLine('info depth 12 multipv 1 score mate -1 pv e9f9')!
    const scoreRed = toRedScore(info.score, side)
    expect(scoreRed).toEqual({ kind: 'mate', value: 1 })
    expect(scoreText(scoreRed)).toBe('红方 1 步杀')
  })
})

// 无 wdl 时的 mate→cp 兜底（useEngine.toLines 同口径）
describe('mate 兜底胜率方向', () => {
  const fallbackCp = (v: number) => (v > 0 ? 100000 : -100000)

  it('红方将杀 → 胜率趋近 1', () => {
    expect(cpToWinRate(fallbackCp(1))).toBeGreaterThan(0.99)
  })

  it('红方被杀 → 胜率趋近 0', () => {
    expect(cpToWinRate(fallbackCp(-1))).toBeLessThan(0.01)
  })
})
