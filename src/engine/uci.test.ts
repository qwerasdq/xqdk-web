// UCI 解析与视角换算测试
import { describe, expect, it } from 'vitest'
import {
  parseInfoLine,
  parseBestmoveLine,
  sideToMoveAfter,
  toRedScore,
  wdlToWinRate,
} from './uci'

const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'

describe('sideToMoveAfter', () => {
  it('红先局面：偶数着法后仍是红走', () => {
    expect(sideToMoveAfter(START_FEN, [])).toBe('w')
    expect(sideToMoveAfter(START_FEN, ['h2e2', 'h9g7'])).toBe('w')
    expect(sideToMoveAfter(START_FEN, ['h2e2', 'h9g7', 'b2e2', 'b9c7'])).toBe('w')
  })

  it('红先局面：奇数着法后轮到黑走', () => {
    expect(sideToMoveAfter(START_FEN, ['h2e2'])).toBe('b')
    expect(sideToMoveAfter(START_FEN, ['h2e2', 'h9g7', 'b2e2'])).toBe('b')
  })

  it('黑先局面按同样奇偶规则翻转', () => {
    const blackFirst = START_FEN.replace(' w ', ' b ')
    expect(sideToMoveAfter(blackFirst, [])).toBe('b')
    expect(sideToMoveAfter(blackFirst, ['h9g7'])).toBe('w')
    expect(sideToMoveAfter(blackFirst, ['h9g7', 'h2e2'])).toBe('b')
  })

  it('side 字段缺失或异常时按红方兜底', () => {
    expect(sideToMoveAfter('9/9/9/9/9/9/9/9/9/9', [])).toBe('w')
    expect(sideToMoveAfter('9/9/9/9/9/9/9/9/9/9', ['h2e2'])).toBe('b')
  })
})

// 回归：调用方传的是「起始局面 + 完整历史」，走子方必须按历史长度算，
// 否则奇数着法后红方视角评分整体反向（引擎给黑方的分被当成红方的分）。
describe('视角换算回归：起始局面 + 历史着法', () => {
  it('走完一步后轮到黑方，引擎给黑方的 cp 应翻成红方负分', () => {
    const side = sideToMoveAfter(START_FEN, ['h2e2'])
    const info = parseInfoLine('info depth 12 multipv 1 score cp 25 pv h9g7')!
    expect(side).toBe('b')
    expect(toRedScore(info.score, side)).toEqual({ kind: 'cp', value: -25 })
  })

  it('走完两步后轮到红方，引擎给红方的 cp 保持正分', () => {
    const side = sideToMoveAfter(START_FEN, ['h2e2', 'h9g7'])
    const info = parseInfoLine('info depth 12 multipv 1 score cp 25 pv b2e2')!
    expect(side).toBe('w')
    expect(toRedScore(info.score, side)).toEqual({ kind: 'cp', value: 25 })
  })

  it('黑方将杀红方时红方视角为负 mate', () => {
    const side = sideToMoveAfter(START_FEN, ['h2e2'])
    const info = parseInfoLine('info depth 20 multipv 1 score mate 2 pv h9g7')!
    expect(toRedScore(info.score, side)).toEqual({ kind: 'mate', value: -2 })
  })

  it('胜率随走子方换算：黑方优势时红方胜率低于 0.5', () => {
    const side = sideToMoveAfter(START_FEN, ['h2e2'])
    const info = parseInfoLine('info depth 20 multipv 1 score cp 300 wdl 800 150 50 pv h9g7')!
    expect(side).toBe('b')
    expect(info.wdl).toEqual([800, 150, 50])
    expect(wdlToWinRate(info.wdl!, side)).toBeLessThan(0.5)
  })
})

describe('parseInfoLine / parseBestmoveLine', () => {
  it('解析 depth/multipv/wdl/pv', () => {
    const info = parseInfoLine(
      'info depth 18 seldepth 24 multipv 2 score cp -30 wdl 120 400 480 nodes 1000 nps 50000 time 20 pv h9g7 b2e2',
    )!
    expect(info.depth).toBe(18)
    expect(info.seldepth).toBe(24)
    expect(info.multipv).toBe(2)
    expect(info.score).toEqual({ kind: 'cp', value: -30 })
    expect(info.wdl).toEqual([120, 400, 480])
    expect(info.pv).toEqual(['h9g7', 'b2e2'])
  })

  it('无 score 的 info 行返回 null', () => {
    expect(parseInfoLine('info depth 1 currmove h2e2')).toBeNull()
    expect(parseInfoLine('bestmove h2e2')).toBeNull()
  })

  it('bestmove 带与不带 ponder', () => {
    expect(parseBestmoveLine('bestmove h2e2 ponder h9g7')).toEqual({ move: 'h2e2', ponder: 'h9g7' })
    expect(parseBestmoveLine('bestmove h2e2')).toEqual({ move: 'h2e2', ponder: null })
  })
})
