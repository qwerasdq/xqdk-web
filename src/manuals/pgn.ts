// PGN 棋谱解析器：头部标签 + 中文纵线记谱 movetext（"炮二平三 马2进3"）
// 中文着法 → UCCI 逆解析用"生成-匹配"法：
//   对每个同类型候选棋子的每个合法着法，用 getChsString 生成中文记谱与输入比对。
//   正确性天然继承记谱器（前/后消歧、多兵编号等规则完全一致），
//   参考 walker8088/cchess read_pgn.py（其核心 move_text 为同类实现）。
// v3：支持嵌套变例括号 ( ... )，输出与 XQF 一致的 MoveNode 树；逐着法注释挂到当前节点。
//    变例语义自动判定：标准 RAV（替代前一着）/ 续着式（前一步之后的另一着）/ 无法解析则跳过。

import { Board } from '../xiangqi/board'
import { Move } from '../xiangqi/move'
import { Position } from '../xiangqi/position'
import * as Piece from '../xiangqi/piece'
import { legalMoves } from '../xiangqi/rule'
import type { MoveNode } from './xqf'

export interface PgnManual {
  headers: Record<string, string>
  /** FEN 起始局面（无 [FEN] 标签时为标准开局） */
  initFen: string
  /** 主变着法（含中文原文，兼容旧调用方） */
  moves: { ucci: string; chs: string; comment?: string | null }[]
  /** 变例树根（move=null），PGN 用 */
  headMove: MoveNode
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

function makeNode(
  move: Move | null,
  parent: MoveNode | null,
  chs: string | null = null,
): MoveNode {
  return { move, comment: null, chs, nextMoves: [], parent }
}

interface Word {
  value: string
  isVariationStart: boolean
  isVariationEnd: boolean
  isComment: boolean
}

/**
 * 把 movetext 切分为词元，正确区分嵌套括号、注释、回合号、结果 token。
 * 按字符扫描而不是按空白切分，保证 `{...}` 内的空格不会拆开注释。
 */
function tokenizeMovetext(movetext: string): Word[] {
  const words: Word[] = []
  let i = 0
  while (i < movetext.length) {
    const ch = movetext[i]!
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '(') {
      words.push({ value: '(', isVariationStart: true, isVariationEnd: false, isComment: false })
      i++
      continue
    }
    if (ch === ')') {
      words.push({ value: ')', isVariationStart: false, isVariationEnd: true, isComment: false })
      i++
      continue
    }
    if (ch === '{') {
      const end = movetext.indexOf('}', i + 1)
      if (end < 0) break // 未闭合注释：忽略剩余部分（简单兜底）
      const comment = movetext.slice(i + 1, end).trim()
      if (comment) {
        words.push({ value: comment, isVariationStart: false, isVariationEnd: false, isComment: true })
      }
      i = end + 1
      continue
    }
    const match = movetext.slice(i).match(/^[^(){} \t\r\n]+/)
    if (!match) {
      i++
      continue
    }
    const value = match[0]
    words.push({ value, isVariationStart: false, isVariationEnd: false, isComment: false })
    i += value.length
  }
  return words
}

/** 把注释挂到最近生成着法节点；若尚无着法则挂根注释 */
function attachComment(node: MoveNode, comment: string): void {
  node.comment = node.comment ? `${node.comment}\n${comment}` : comment
}

/** 解析 ICCS/中文着法 token → UCCI（不校验合法性） */
function parseMoveToken(token: string, board: Board): string | null {
  if (/^[a-iA-I]\d-?[a-iA-I]\d$/.test(token)) return token.replace('-', '').toLowerCase()
  return chineseToUcci(token, board)
}

/** token 能否在当前局面（含行棋方）下解析出合法着法 */
function canParse(token: string, board: Board): boolean {
  if (/^[a-iA-I]\d-?[a-iA-I]\d$/.test(token)) {
    const m = new Move(new Position(0, 0), new Position(0, 0), board)
    if (!m.fromUCCIString(token.replace('-', '').toLowerCase())) return false
    const piece = board.getPieceByPosition(m.fromPosition)
    if (!Piece.isValid(piece) || Piece.isRed(piece) !== board.bRedGo) return false
    return legalMoves(piece, m.fromPosition.x, m.fromPosition.y, board).some((p) => p.equals(m.toPosition))
  }
  return chineseToUcci(token, board) !== null
}

/** peek 变例内第一个着法 token（跳过回合号/注释）；遇到括号/结果返回 null */
function peekMoveToken(words: Word[], start: number): string | null {
  for (let i = start; i < words.length; i++) {
    const w = words[i]!
    if (w.isComment) continue
    if (w.isVariationStart || w.isVariationEnd) return null
    const t = w.value.replace(/^\d*\.+/, '')
    if (!t) continue
    if (RESULT_TOKENS.has(t) || /^\d+$/.test(t)) return null
    return t
  }
  return null
}

interface VariationFrame {
  /** 被替代/被延续的着法（`)` 后主变从此步之后继续） */
  substitute: MoveNode
  /** 变例结束时应恢复的棋盘（= substitute 落子后） */
  restoreBoard: Board
  /** 变例内容无法解析时跳过（仅做括号配对，不挂树） */
  skip: boolean
}

/**
 * 解析 PGN 文本，失败返回 null（返回主变 moves + headMove 树）。
 *
 * 变例语义（RAV 递归变例）：
 *   `( ... )` 是其**前一步**的替代分支——变例第一着与被替代步同色、同起点局面。
 *   进入时：解析第一着应使用「被替代步之前」的局面；若第一着无法在该局面解析
 *   （例如变例以反色着法开头，表示“前一步之后的另一续着”），则改用「被替代步
 *   之后」的局面，变例挂到被替代步之下。
 *   退出时：主变恢复到被替代步之后继续。
 * 结构上变例第一着与被替代步是兄弟（同挂被替代步的父节点下）。
 */
export function parsePgn(text: string): PgnManual | null {
  const headers: Record<string, string> = {}
  let movetext = ''

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith('[')) {
      const m = line.match(/\[(\w+)\s+"([^"]*)"\]/)
      if (m) headers[m[1]!.toLowerCase()] = m[2]!
      continue
    }

    // 注释统一交给 tokenizer 处理（可能内嵌空格，甚至跨行）
    movetext += line + ' '
  }

  let initFen = headers['fen'] ?? STANDARD_FEN
  const board = new Board()
  if (!board.restoreFromFEN(initFen)) {
    initFen = STANDARD_FEN
    board.restoreFromFEN(initFen)
  }
  const initBoard = board.clone()

  const root = makeNode(null, null, null)
  let result = '*'
  let current: MoveNode = root
  const frames: VariationFrame[] = []
  let skipDepth = 0
  /** 每步落子后的局面（变例进入/退出时恢复棋盘） */
  const boardAfter = new WeakMap<MoveNode, Board>()
  /** 主变链：每个节点的主变子节点（变例分支不设置） */
  const mainChild = new WeakMap<MoveNode, MoveNode>()
  const words = tokenizeMovetext(movetext)

  const setBoard = (b: Board): void => {
    board.piece = b.piece.map((row) => [...row])
    board.bRedGo = b.bRedGo
    board.rounds = b.rounds
    board.score = b.score
  }

  for (let wi = 0; wi < words.length; wi++) {
    const w = words[wi]!
    if (w.isComment) {
      if (skipDepth === 0) attachComment(current, w.value)
      continue
    }
    if (w.isVariationStart) {
      const substitute = current
      const restoreBoard = boardAfter.get(substitute) ?? initBoard
      if (skipDepth > 0) {
        frames.push({ substitute, restoreBoard, skip: true })
        skipDepth++
        continue
      }
      const first = peekMoveToken(words, wi + 1)
      let mode: 'replace' | 'continue' | 'skip' = 'skip'
      let replaceBoard: Board | null = null
      if (first) {
        if (substitute === root) {
          mode = canParse(first, board) ? 'continue' : 'skip'
        } else {
          const boardBefore = boardAfter.get(substitute.parent!) ?? initBoard
          if (canParse(first, boardBefore)) {
            mode = 'replace'
            replaceBoard = boardBefore
          } else if (canParse(first, boardAfter.get(substitute)!)) {
            mode = 'continue'
          }
        }
      }
      if (mode === 'skip') {
        frames.push({ substitute, restoreBoard, skip: true })
        skipDepth++
        continue
      }
      if (mode === 'replace') {
        current = substitute.parent ?? root
        setBoard(replaceBoard!)
      } else {
        // continue：变例从前一步之后开始（= 当前局面），挂到被替代步之下
        current = substitute
      }
      frames.push({ substitute, restoreBoard, skip: false })
      continue
    }
    if (w.isVariationEnd) {
      const f = frames.pop()
      if (!f) break
      if (f.skip) {
        skipDepth--
      } else {
        current = f.substitute
        setBoard(f.restoreBoard)
      }
      continue
    }

    const token = w.value.replace(/^\d*\.+/, '') // 剥掉回合号（1. / 1... / ...）
    if (!token) continue
    if (skipDepth > 0) continue
    if (RESULT_TOKENS.has(token)) {
      result = token
      break
    }
    if (/^\d+$/.test(token)) continue

    const ucci = parseMoveToken(token, board)
    if (!ucci) {
      if (frames.length > 0) {
        // 变例内出现无法解析的着法：跳过本变例剩余内容，主变不受影响
        const f = frames[frames.length - 1]!
        if (!f.skip) {
          f.skip = true
          current = f.substitute
          setBoard(f.restoreBoard)
        }
        skipDepth = 1
        continue
      }
      break
    }

    const mv = new Move(new Position(0, 0), new Position(0, 0), board)
    if (!mv.fromUCCIString(ucci)) break

    const node = makeNode(mv, current, token)
    current.nextMoves.push(node)
    if (frames.length === 0 && !mainChild.has(current)) {
      mainChild.set(current, node)
    }
    current = node

    board.tryMove(mv.fromPosition, mv.toPosition)
    board.bRedGo = !board.bRedGo
    boardAfter.set(node, board.clone())
  }

  // 主变子节点排到 nextMoves[0]（变例先于主变续着出现时修正）
  const visit = (n: MoveNode): void => {
    const mc = mainChild.get(n)
    if (mc && n.nextMoves[0] !== mc) {
      n.nextMoves = [mc, ...n.nextMoves.filter((c) => c !== mc)]
    }
    for (const c of n.nextMoves) visit(c)
  }
  visit(root)

  // 主变 = 沿 mainChild 链
  const mainMoves: { ucci: string; chs: string; comment?: string | null }[] = []
  let node: MoveNode = root
  for (;;) {
    const next = mainChild.get(node)
    if (!next) break
    const entry: { ucci: string; chs: string; comment?: string | null } = {
      ucci: next.move!.getUCCIString(),
      chs: next.chs ?? '',
    }
    if (next.comment) entry.comment = next.comment
    mainMoves.push(entry)
    node = next
  }

  if (root.nextMoves.length === 0) return null
  return {
    headers,
    initFen,
    moves: mainMoves,
    headMove: root,
    result,
    comment: root.comment ?? null,
  }
}