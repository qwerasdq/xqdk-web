// XQF 棋谱解析器：直译自 Android 版 manuals/XQFParser.java + XQFKey.java + XQFManual.java
// 格式文档：D:\chess-dike\棋谱\XQF文件格式说明.TXT（XQStudio 1.0）
// 字节全部按无符号处理（Uint8Array），与 Java 的 byte + &0xFF 运算逐位等价

import { Board } from '../xiangqi/board'
import { Move } from '../xiangqi/move'
import { Position } from '../xiangqi/position'
import * as Piece from '../xiangqi/piece'

// 头部 JBBP 布局对应偏移（byte[2] szMagic; byte[1] szVersion; byte[13] szKeys; byte[32] szPiecePos;
// byte[16] szResult; byte[16] szSetUp; byte[64] szTitle; byte[64] szReserved1; byte[64] szEvent;
// byte[16] szDate; byte[16] szSite; byte[16] szRed; byte[16] szBlack; byte[64] szRuleTime;
// byte[16] szRedTime; byte[16] szBlackTime; byte[32] szReserved2; byte[16] szAnnotator; byte[16] szAuthor）
const OFF = {
  MAGIC: 0x0000,
  VERSION: 0x0002,
  KEYS: 0x0003,
  PIECE_POS: 0x0010,
  RESULT: 0x0030,
  SETUP: 0x0040,
  TITLE: 0x0050,
  EVENT: 0x00d0,
  DATE: 0x0110,
  SITE: 0x0120,
  RED: 0x0130,
  BLACK: 0x0140,
  RULE_TIME: 0x0150,
  RED_TIME: 0x0190,
  BLACK_TIME: 0x01a0,
  ANNOTATOR: 0x01d0,
  AUTHOR: 0x01e0,
  STEPS: 0x0400,
} as const

// 32 子顺序（格式文档"三、XQF文件中初始局面的表示"）：
// 01-16 红方 车马相士帅士相马车炮炮兵兵兵兵兵；17-32 黑方 车马象士将士象马车炮炮卒卒卒卒卒
const PIECE_KINDS = [
  Piece.WJU, Piece.WMA, Piece.WXIANG, Piece.WSHI, Piece.WSHUAI, Piece.WSHI, Piece.WXIANG, Piece.WMA, Piece.WJU,
  Piece.WPAO, Piece.WPAO,
  Piece.WBING, Piece.WBING, Piece.WBING, Piece.WBING, Piece.WBING,
  Piece.BJU, Piece.BMA, Piece.BXIANG, Piece.BSHI, Piece.BJIANG, Piece.BSHI, Piece.BXIANG, Piece.BMA, Piece.BJU,
  Piece.BPAO, Piece.BPAO, Piece.BZU, Piece.BZU, Piece.BZU, Piece.BZU, Piece.BZU,
]

export interface MoveNode {
  move: Move | null
  comment: string | null
  /** 中文着法（可选：PGN 变例展示用；XQF 可在主板中通过 Move 生成） */
  chs?: string | null
  nextMoves: MoveNode[]
  parent: MoveNode | null
}

export interface XqfManual {
  format: string
  version: number
  title: string
  event: string
  date: string
  site: string
  red: string
  black: string
  redDuration: string
  blackDuration: string
  annotator: string
  author: string
  result: string
  category: string
  /** 全局注解（第 0 条记录的评注） */
  annotation: string | null
  /** 开局局面 */
  board: Board
  /** 着法树根（move=null） */
  headMove: MoveNode
}

interface XqfKey {
  keyXY: number
  keyXYf: number
  keyXYt: number
  keyRMKSize: number
  f32Keys: Uint8Array
}

const gb18030 = new TextDecoder('gb18030')

// 长度前缀字符串："长度(1字节) + 数据"（照抄 readString）
function readLengthString(buf: Uint8Array, offset: number, maxLen: number): string {
  const length = Math.min(buf[offset] ?? 0, maxLen - 1)
  return gb18030.decode(buf.subarray(offset + 1, offset + 1 + length)).trim()
}

// XQF 棋盘坐标 → 内部坐标：XQF (x, y) 原点左下，内部 y=0 黑方顶部
function getPosFromValue(value: number): Position {
  const y = value % 10
  const x = Math.floor((value - y) / 10)
  return new Position(x, 9 - y)
}

// ---- 解密（直译 initDecryptKey / decryptPiecePos / decodeBuff）----

function initDecryptKey(cryptKeys: Uint8Array): XqfKey {
  const headKeyMask = cryptKeys[0]!
  const headKeyOrA = cryptKeys[5]!
  const headKeyOrB = cryptKeys[6]!
  const headKeyOrC = cryptKeys[7]!
  const headKeyOrD = cryptKeys[8]!
  const headKeysSum = cryptKeys[9]!
  const headKeyXY = cryptKeys[10]!
  const headKeyXYf = cryptKeys[11]!
  const headKeyXYt = cryptKeys[12]!

  let bKey = headKeyXY
  const keyXY = (((((bKey * bKey * 3 + 9) * 3 + 8) * 2 + 1) * 3 + 8) * bKey) & 0xff
  bKey = headKeyXYf
  const keyXYf = (((((bKey * bKey * 3 + 9) * 3 + 8) * 2 + 1) * 3 + 8) * keyXY) & 0xff
  bKey = headKeyXYt
  const keyXYt = (((((bKey * bKey * 3 + 9) * 3 + 8) * 2 + 1) * 3 + 8) * keyXYf) & 0xff
  const keyRMKSize = (((headKeysSum * 256 + headKeyXY) % 32000) + 767) & 0xffff

  const fKeyBytes = new Uint8Array([
    (headKeysSum & headKeyMask) | headKeyOrA,
    (headKeyXY & headKeyMask) | headKeyOrB,
    (headKeyXYf & headKeyMask) | headKeyOrC,
    (headKeyXYt & headKeyMask) | headKeyOrD,
  ])

  // f32Keys 初值 "(C) Copyright Mr. Dong Shiwei."，逐字节 &= fKeyBytes[i % 4]
  const base = new TextEncoder().encode('[(C) Copyright Mr. Dong Shiwei.]')
  const f32Keys = new Uint8Array(base.length)
  for (let i = 0; i < base.length; i++) {
    f32Keys[i] = (base[i]! & fKeyBytes[i % 4]!) & 0xff
  }

  return { keyXY, keyXYf, keyXYt, keyRMKSize, f32Keys }
}

function decryptPiecePos(manStr: Uint8Array, version: number, keys: XqfKey | null): Uint8Array {
  const tmpMan = new Uint8Array(32)
  if (keys == null) {
    tmpMan.set(manStr.subarray(0, 32))
    return tmpMan
  }
  // 棋子顺序打乱恢复
  for (let i = 0; i < 32; i++) {
    if (version >= 12) {
      tmpMan[(keys.keyXY + i + 1) & 0x1f] = manStr[i]!
    } else {
      tmpMan[i] = manStr[i]!
    }
  }
  // 每个棋子位置调整
  for (let i = 0; i < 32; i++) {
    let v = (tmpMan[i]! - keys.keyXY) & 0xff
    if (v > 89) v = 0xff
    tmpMan[i] = v
  }
  return tmpMan
}

function decodeBuff(keys: XqfKey, buff: Uint8Array): Uint8Array {
  const deBuff = new Uint8Array(buff)
  for (let i = 0; i < buff.length; i++) {
    const keyByte = keys.f32Keys[(0x400 + i) % 32]!
    deBuff[i] = (deBuff[i]! - keyByte) & 0xff
  }
  return deBuff
}

// ---- 步记录读取（直译 readAnnotationInfo / readSteps）----

class StepReader {
  private buf: Uint8Array
  private index = 0

  constructor(buf: Uint8Array) {
    this.buf = buf
  }

  readBytes(size: number): Uint8Array {
    const start = this.index
    const stop = Math.min(this.index + size, this.buf.length)
    this.index = stop
    return this.buf.subarray(start, stop)
  }

  readInt(): number {
    const b = this.readBytes(4)
    return (b[0] ?? 0) + ((b[1] ?? 0) << 8) + ((b[2] ?? 0) << 16) + ((b[3] ?? 0) << 24)
  }

  readString(size: number): string {
    return gb18030.decode(this.readBytes(size))
  }

  get remaining(): number {
    return this.buf.length - this.index
  }
}

function parseResult(result: number): string {
  switch (result) {
    case 0x01:
      return '红胜'
    case 0x02:
      return '黑胜'
    case 0x03:
      return '平局'
    default:
      return '未知'
  }
}

function parseCategory(b: number): string | null {
  if (b === 0x00) return '全局'
  if (b === 0x01) return '布局'
  if (b === 0x02) return '中局'
  if (b === 0x03) return '残局'
  return null
}

/** 解析 XQF 文件（Uint8Array），失败返回 null */
export function parseXqf(buffer: Uint8Array): XqfManual | null {
  if (buffer.length < 0x408) return null
  if (buffer[0] !== 0x58 /* X */ || buffer[1] !== 0x51 /* Q */) return null

  const version = buffer[OFF.VERSION]!
  const keys = version <= 0x0a ? null : initDecryptKey(buffer.subarray(OFF.KEYS, OFF.KEYS + 13))

  const piecePos = decryptPiecePos(buffer.subarray(OFF.PIECE_POS, OFF.PIECE_POS + 32), version, keys)

  // 重建开局局面
  const board = new Board()
  board.clear()
  for (let i = 0; i < 32; i++) {
    const value = piecePos[i]!
    if (value === 0xff) continue
    const pos = getPosFromValue(value)
    board.setPieceByPosition(pos, PIECE_KINDS[i]!)
  }

  const manual: XqfManual = {
    format: 'XQ',
    version,
    title: readLengthString(buffer, OFF.TITLE, 64),
    event: readLengthString(buffer, OFF.EVENT, 64),
    date: readLengthString(buffer, OFF.DATE, 16),
    site: readLengthString(buffer, OFF.SITE, 16),
    red: readLengthString(buffer, OFF.RED, 16),
    black: readLengthString(buffer, OFF.BLACK, 16),
    redDuration: readLengthString(buffer, OFF.RED_TIME, 16),
    blackDuration: readLengthString(buffer, OFF.BLACK_TIME, 16),
    annotator: readLengthString(buffer, OFF.ANNOTATOR, 16),
    author: readLengthString(buffer, OFF.AUTHOR, 16),
    result: parseResult(buffer[OFF.RESULT + 3]!),
    category: parseCategory(buffer[OFF.SETUP]!) ?? '',
    annotation: null,
    board,
    headMove: { move: null, comment: null, nextMoves: [], parent: null },
  }

  // 步记录区（高版本先解密）
  const stepRaw = buffer.subarray(OFF.STEPS)
  const stepBuff = keys ? decodeBuff(keys, stepRaw) : stepRaw
  const reader = new StepReader(stepBuff)

  // 第 0 条记录：全局注解
  manual.annotation = readAnnotationInfo(reader, version, keys)

  // 剩余着法树
  readSteps(reader, version, keys, manual.headMove)

  return manual
}

function readAnnotationInfo(reader: StepReader, version: number, keys: XqfKey | null): string | null {
  const stepInfo = reader.readBytes(4)
  if (stepInfo.length < 4) return null
  let annoteLen = 0
  if (version <= 0x0a) {
    annoteLen = reader.readInt()
  } else {
    const flag = stepInfo[2]! & 0xe0
    if ((flag & 0x20) !== 0) {
      annoteLen = reader.readInt() - (keys?.keyRMKSize ?? 0)
    }
  }
  if (annoteLen <= 0) return null
  const text = reader.readString(annoteLen).trim()
  return text.replace(/&nbsp;/g, ' ')
}

function readSteps(reader: StepReader, version: number, keys: XqfKey | null, node: MoveNode): void {
  if (reader.remaining < 4) return
  const stepInfo = reader.readBytes(4)
  if (stepInfo.length < 4) return

  let annoteLen = 0
  let hasNextStep = false
  let hasVarStep = false

  let moveFrom: number
  let moveTo: number
  if (version <= 0x0a) {
    // 低版本：走子数据后紧跟注释长度
    if ((stepInfo[2]! & 0xf0) !== 0) hasNextStep = true
    if ((stepInfo[2]! & 0x0f) !== 0) hasVarStep = true
    annoteLen = reader.readInt()
    moveFrom = (stepInfo[0]! - 0x18) & 0xff
    moveTo = (stepInfo[1]! - 0x20) & 0xff
  } else {
    // 高版本：flag 标记注释/后续/变招
    const flag = stepInfo[2]! & 0xe0
    if ((flag & 0x80) !== 0) hasNextStep = true
    if ((flag & 0x40) !== 0) hasVarStep = true
    if ((flag & 0x20) !== 0) {
      annoteLen = reader.readInt() - (keys?.keyRMKSize ?? 0)
    }
    moveFrom = ((stepInfo[0]! - 0x18) & 0xff) - (keys?.keyXYf ?? 0) & 0xff
    moveTo = ((stepInfo[1]! - 0x20) & 0xff) - (keys?.keyXYt ?? 0) & 0xff
  }

  const from = getPosFromValue(moveFrom)
  const to = getPosFromValue(moveTo)
  const move = new Move(from, to)
  const comment = annoteLen > 0 ? reader.readString(annoteLen).trim() : null

  const nextNode: MoveNode = { move, comment, nextMoves: [], parent: node }
  node.nextMoves.push(nextNode)

  if (hasNextStep) {
    readSteps(reader, version, keys, nextNode)
  }
  if (hasVarStep) {
    // 变招是当前节点的兄弟（同一父节点下的另一分支）
    readSteps(reader, version, keys, node)
  }
}

// ---- 着法树工具 ----

/** 主变着法序列（UCCI） */
export function mainLineMoves(head: MoveNode): string[] {
  const moves: string[] = []
  let node = head
  while (node.nextMoves.length > 0) {
    const next = node.nextMoves[0]!
    if (next.move) moves.push(next.move.getUCCIString())
    node = next
  }
  return moves
}

/** 统计总着法数（含变例） */
export function countMoves(head: MoveNode): number {
  let n = 0
  for (const next of head.nextMoves) {
    if (next.move) n += 1 + countMoves(next)
  }
  return n
}
