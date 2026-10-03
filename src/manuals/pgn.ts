// PGN 棋谱解析器：头部标签 + 中文纵线记谱 movetext（"炮二平三 马2进3"）
// 中文着法 → UCCI 逆解析用"生成-匹配"法：
//   对每个同类型候选棋子的每个合法着法，用 getChsString 生成中文记谱与输入比对。
//   正确性天然继承记谱器（前/后消歧、多兵编号等规则完全一致），
//   参考 walker8088/cchess read_pgn.py（其核心 move_text 为同类实现）。

import { Board } from '../xiangqi/board'
import { Move } from '../xiangqi/move'
import { Position } from '../xiangqi/position'
import * as Piece from '../xiangqi/piece'
import { legalMoves } from '../xiangqi/rule'

export interface PgnManual {
  headers: Record<string, string>
  /** FEN 起始局面（无 [FEN] 标签时为标准开局） */
  initFen: string
  /** 主变着法（含中文原文） */
  moves: { ucci: string; chs: string }[]
  result: string
  comment: string | null
}

const STANDARD_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'

// 棋子类型首字（照抄记谱器的类型字表）
const PIECE_FIRST_CHARS = ['车', '马', '相', '象', '仕', '士', '帅', '将', '炮', '兵', '卒']
const RESULT_TOKENS = new Set(['*', '1-0', '0-1', '1/2-1/2', '1/2:1/2'])

/**
 * 中文着法 → UCCI（生成-匹配法）。
 * 在 board（走子前局面，含行棋方）上找所有同首字、同色候选棋子，
 * 枚举其合法着法并生成中文记谱，与输入比对。
 */
export function chineseToUcci(chs: string, board: Board): string | null {
  if (chs.length < 4 || !PIECE_FIRST_CHARS.includes(chs[0]!)) return null
  const firstChar = chs[0]!
  const wantRed = board.bRedGo

  // 可选：起列约束（中文数字列 / 阿拉伯数字列）缩小候选——记谱器已处理消歧，
  // 全量生成匹配即可，无需自行解析列号
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = board.getPieceByXY(x, y)
      if (!Piece.isValid(piece)) continue
      if (Piece.isRed(piece) !== wantRed) continue
      if (Piece.getNameByValue(piece) !== firstChar) continue
      for (const to of legalMoves(piece, x, y, board)) {
        const m = new Move(new Position(x, y), to, board)
        if (m.getChsString(board) === chs) return m.getUCCIString()
      }
    }
  }
  return null
}

/** 解析 PGN 文本，失败返回 null */
export function parsePgn(text: string): PgnManual | null {
  const headers: Record<string, string> = {}
  let comment: string | null = null
  let movetext = ''
  let braceDepth = 0
  let curComment = ''

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith('[')) {
      // [Key "Value"]
      const m = line.match(/\[(\w+)\s+"([^"]*)"\]/)
      if (m) headers[m[1]!.toLowerCase()] = m[2]!
      continue
    }

    // 注释 { ... }（可跨行）
    if (line.startsWith('{') || braceDepth > 0) {
      curComment += line.replace(/[{}]/g, '') + '\n'
      braceDepth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length
      if (braceDepth <= 0) {
        comment = curComment.trim()
        curComment = ''
        braceDepth = 0
      }
      continue
    }

    // movetext 行
    movetext += line + ' '
  }

  // 起始局面：FEN 标签或标准开局
  let initFen = headers['fen'] ?? STANDARD_FEN
  const board = new Board()
  if (!board.restoreFromFEN(initFen)) {
    initFen = STANDARD_FEN
    board.restoreFromFEN(initFen)
  }

  // 逐 token 处理 movetext
  const moves: { ucci: string; chs: string }[] = []
  let result = '*'
  for (const token of movetext.split(/\s+/)) {
    if (!token) continue
    if (RESULT_TOKENS.has(token)) {
      result = token
      break
    }
    if (/^\d+\.+$/.test(token)) continue // 回合号 "1." "12..."
    if (/^\d+\.\.\.$/.test(token)) continue // "1..."
    // 忽略变例括号（MVP 只取主变）
    if (token.startsWith('(') || token.endsWith(')')) continue

    let ucci: string | null = null
    // ICCS 五字符坐标（"h2-e2"）或 UCCI 四字符（"h2e2"）
    if (/^[a-i]\d-?[a-i]\d$/.test(token)) {
      ucci = token.replace('-', '')
    } else {
      ucci = chineseToUcci(token, board)
    }
    if (!ucci) {
      // 无法解析的着法：停止（保留已解析部分）
      break
    }
    const m = new Move(new Position(0, 0), new Position(0, 0), board)
    if (!m.fromUCCIString(ucci)) break
    board.tryMove(m.fromPosition, m.toPosition)
    board.bRedGo = !board.bRedGo
    moves.push({ ucci, chs: token })
  }

  if (moves.length === 0) return null
  return { headers, initFen, moves, result, comment }
}
