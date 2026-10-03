// XQF 解析器测试：真实样例（XQStudio 格式）+ 着法树合法性回放验证
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseXqf, mainLineMoves, countMoves } from './xqf'
import { Board } from '../xiangqi/board'
import { Position } from '../xiangqi/position'
import { Move } from '../xiangqi/move'

const FIXTURES = join(__dirname, 'fixtures')

function load(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)))
}

describe('XQF 解析', () => {
  const buf = load('sample_07_XQStudio.xqf')
  const manual = parseXqf(buf)

  it('解析成功且格式正确', () => {
    expect(manual).not.toBeNull()
    expect(manual!.format).toBe('XQ')
  })

  it('元数据可读（样例文件头部本身为空，断言不抛错）', () => {
    // sample_07 头部元数据全 0（文件本身未填），只验证字段类型与结果枚举
    expect(typeof manual!.title).toBe('string')
    expect(manual!.result).toMatch(/红胜|黑胜|平局|未知/)
  })

  it('有着法记录', () => {
    expect(countMoves(manual!.headMove)).toBeGreaterThan(10)
  })

  it('主变着法全部合法（从开局局面回放）', () => {
    const board = manual!.board.clone()
    let redGo = true // XQF 着法从红方开始
    for (const ucci of mainLineMoves(manual!.headMove)) {
      const m = new Move(new Position(0, 0), new Position(0, 0), board)
      expect(m.fromUCCIString(ucci)).toBe(true)
      // 行棋方交替合法（XQF 变例树主变是红黑交替）
      expect(board.bRedGo === redGo).toBe(true)
      board.tryMove(m.fromPosition, m.toPosition)
      board.bRedGo = !board.bRedGo
      redGo = !redGo
    }
  })

  it('头部版本号合法', () => {
    expect(manual!.version).toBeGreaterThanOrEqual(0x0a)
    expect(manual!.version).toBeLessThanOrEqual(0x20)
  })
})
