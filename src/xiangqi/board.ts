// 棋盘数据，直译自 chess-dike 的 gamelogic/Board.java
// 注意坐标约定：piece[y][x]，y=0 是黑方底线（黑将所在行），y=9 是红方底线
// UCCI/FEN 坐标以左下角为原点（a0），与内部 y 轴相反，转换见 Move / Board 的 FEN 方法

import { Position } from './position'
import * as Piece from './piece'
import { getZobristFromBoard } from './zobrist'

export const BOARD_PIECE_WIDTH = 9
export const BOARD_PIECE_HEIGHT = 10

const INITIAL_PIECES: number[][] = [
  [Piece.BJU, Piece.BMA, Piece.BXIANG, Piece.BSHI, Piece.BJIANG, Piece.BSHI, Piece.BXIANG, Piece.BMA, Piece.BJU],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, Piece.BPAO, 0, 0, 0, 0, 0, Piece.BPAO, 0],
  [Piece.BZU, 0, Piece.BZU, 0, Piece.BZU, 0, Piece.BZU, 0, Piece.BZU],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [Piece.WBING, 0, Piece.WBING, 0, Piece.WBING, 0, Piece.WBING, 0, Piece.WBING],
  [0, Piece.WPAO, 0, 0, 0, 0, 0, Piece.WPAO, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [Piece.WJU, Piece.WMA, Piece.WXIANG, Piece.WSHI, Piece.WSHUAI, Piece.WSHI, Piece.WXIANG, Piece.WMA, Piece.WJU],
]

export function isValidPosition(pos: Position | null): boolean {
  if (pos == null) return false
  return pos.x >= 0 && pos.x < BOARD_PIECE_WIDTH && pos.y >= 0 && pos.y < BOARD_PIECE_HEIGHT
}

export class Board {
  bRedGo = true
  rounds = 1
  score = 0
  /** 请勿直接访问（piece[y][x]），使用 getPieceByPosition / getPieceByXY */
  piece: number[][]

  constructor(b?: Board) {
    if (b) {
      this.bRedGo = b.bRedGo
      this.rounds = b.rounds
      this.score = b.score
      this.piece = b.piece.map((row) => [...row])
    } else {
      this.piece = INITIAL_PIECES.map((row) => [...row])
    }
  }

  clone(): Board {
    return new Board(this)
  }

  clear(): void {
    for (let y = 0; y < BOARD_PIECE_HEIGHT; y++) {
      for (let x = 0; x < BOARD_PIECE_WIDTH; x++) {
        this.piece[y][x] = Piece.EMPTY
      }
    }
  }

  doMove(from: Position, to: Position): boolean {
    if (!isValidPosition(from) || !isValidPosition(to)) return false
    const p = this.getPieceByPosition(from)
    if (!Piece.isValid(p)) return false
    this.setPieceByPosition(to, p)
    this.setPieceByPosition(from, Piece.EMPTY)
    this.bRedGo = !this.bRedGo
    this.rounds++
    return true
  }

  // 试走（不翻转行棋方、不增回合数），供将死/困毙判定使用
  tryMove(from: Position, to: Position): void {
    const p = this.getPieceByPosition(from)
    this.setPieceByPosition(to, p)
    this.setPieceByPosition(from, Piece.EMPTY)
  }

  setPieceByPosition(pos: Position | null, value: number): boolean {
    if (!isValidPosition(pos)) return false
    if (value === Piece.EMPTY || Piece.isValid(value)) {
      this.piece[pos!.y][pos!.x] = value
      return true
    }
    return false
  }

  setPieceByXY(x: number, y: number, value: number): boolean {
    if (x >= 0 && x < BOARD_PIECE_WIDTH && y >= 0 && y < BOARD_PIECE_HEIGHT) {
      if (value === Piece.EMPTY || Piece.isValid(value)) {
        this.piece[y][x] = value
        return true
      }
    }
    return false
  }

  // 越界返回 -1（与 Android 版一致，-1 不是合法棋子值）
  getPieceByPosition(pos: Position | null): number {
    if (isValidPosition(pos)) {
      return this.piece[pos!.y][pos!.x]
    }
    return -1
  }

  getPieceByXY(x: number, y: number): number {
    if (x >= 0 && x < BOARD_PIECE_WIDTH && y >= 0 && y < BOARD_PIECE_HEIGHT) {
      return this.piece[y][x]
    }
    return -1
  }

  // https://www.xqbase.com/protocol/pgnfen2.htm
  // 红方大写字母、黑方小写字母；a9-i9, a8-i8, ..., a0-i0 顺序
  toFENString(): string {
    let fen = ''
    for (let y = 0; y < BOARD_PIECE_HEIGHT; y++) {
      let row = ''
      let zeros = 0
      for (let x = 0; x < BOARD_PIECE_WIDTH; x++) {
        const p = this.getPieceByXY(x, y)
        if (p !== 0) {
          if (zeros > 0) {
            row += zeros
            zeros = 0
          }
          row += Piece.getCharByValue(p)
        } else {
          zeros++
        }
      }
      if (zeros > 0) {
        row += zeros
      }
      fen += row
      if (y < BOARD_PIECE_HEIGHT - 1) {
        fen += '/'
      }
    }
    return `${fen} ${this.bRedGo ? 'w' : 'b'} - - 0 ${this.rounds}`
  }

  getZobrist(redGo: boolean): bigint {
    return getZobristFromBoard(this.piece, redGo)
  }

  restoreFromFEN(fenString: string): boolean {
    if (!fenString) return false
    let fen = fenString.trim()

    // 补全缺失字段
    if (fen.endsWith('w') || fen.endsWith('b')) {
      fen += ' - - 0 1'
    }

    const parts = fen.split(' ')
    if (parts.length !== 6) {
      console.error('Failed to parse FEN string: ' + fenString)
      return false
    }

    const side = parts[1].toLowerCase()
    if (side === 'w' || side === 'r') {
      this.bRedGo = true
    } else if (side === 'b') {
      this.bRedGo = false
    } else {
      console.error('Failed to parse side from FEN string: ' + fenString)
      return false
    }

    const rounds = Number.parseInt(parts[5])
    if (Number.isNaN(rounds)) {
      console.error('Failed to parse rounds from FEN string: ' + fenString)
      return false
    }
    this.rounds = rounds

    const fenRows = parts[0]
    let x = 0
    let y = 0
    for (const c of fenRows) {
      if (c === '/') {
        x = 0
        y++
      } else if (c >= '0' && c <= '9') {
        for (let k = 0; k < c.charCodeAt(0) - '0'.charCodeAt(0); k++) {
          this.piece[y][x] = 0
          x++
        }
      } else {
        this.piece[y][x] = Piece.getValueByChar(c)
        x++
      }
    }
    return true
  }
}
