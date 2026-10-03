// 走法：UCCI 互转 + 中文记谱，直译自 chess-dike 的 gamelogic/Move.java
// https://www.xqbase.com/protocol/cchess_move.htm

import { Position } from './position'
import { Board, BOARD_PIECE_HEIGHT, isValidPosition } from './board'
import * as Piece from './piece'

// 阿拉伯数字 → 中文数字
const ARABIC_TO_CHINESE: Record<number, string> = {
  1: '一', 2: '二', 3: '三', 4: '四', 5: '五',
  6: '六', 7: '七', 8: '八', 9: '九',
}

export class Move {
  fromPosition: Position
  toPosition: Position
  piece = 0
  comment = ''

  constructor(fromPosition: Position, toPosition: Position, board?: Board) {
    this.fromPosition = fromPosition
    this.toPosition = toPosition
    if (board) {
      this.piece = board.getPieceByPosition(fromPosition)
    }
  }

  setBoard(board: Board): void {
    this.piece = board.getPieceByPosition(this.fromPosition)
  }

  // 'h2e2' → Position（a0 为左下角原点，与内部 y 轴相反）
  fromUCCIString(ucciString: string): boolean {
    if (!ucciString || ucciString.length !== 4) {
      return false
    }
    const sx = ucciString.charCodeAt(0) - 'a'.charCodeAt(0)
    const sy = 9 - (ucciString.charCodeAt(1) - '0'.charCodeAt(0))
    const ex = ucciString.charCodeAt(2) - 'a'.charCodeAt(0)
    const ey = 9 - (ucciString.charCodeAt(3) - '0'.charCodeAt(0))
    const from = new Position(sx, sy)
    const to = new Position(ex, ey)
    if (!isValidPosition(from) || !isValidPosition(to)) {
      return false
    }
    this.fromPosition = from
    this.toPosition = to
    return true
  }

  // → 'h2e2'
  getUCCIString(): string {
    return (
      String.fromCharCode('a'.charCodeAt(0) + this.fromPosition.x) +
      (9 - this.fromPosition.y) +
      String.fromCharCode('a'.charCodeAt(0) + this.toPosition.x) +
      (9 - this.toPosition.y)
    )
  }

  /*
   * 中文记谱描述，例如：车一进六, 炮七退七, 相七进九, 帅四平五, 帅五进一, 将五退一
   * 1. 横轴：红方从右到左数，黑方从左到右数
   * 2. 纵轴：红方从下到上是进，黑方从上到下是进
   * 3. 走直线的棋子：进退（末位数字是纵坐标差值）还是平移（末位数字是目标横坐标）
   * 4. 走斜线的棋子（马、相、士）：进退，末位数字是目标位置的横坐标
   * 5. 红方用中文数字，黑方用阿拉伯数字
   * 6. 同一列有相同棋子时用前/后来区分
   */
  getChsString(board: Board): string {
    const piece = board.getPieceByPosition(this.fromPosition)
    if (!Piece.isValid(piece)) {
      return '未知动作'
    }
    const name = Piece.getNameByValue(piece)
    let num1: string
    let action = '平'
    let num2: string

    if (Piece.isRed(piece)) {
      num1 = ARABIC_TO_CHINESE[9 - this.fromPosition.x]
      num2 = ARABIC_TO_CHINESE[Math.abs(this.toPosition.y - this.fromPosition.y)]
      if (this.toPosition.y > this.fromPosition.y) {
        action = '退'
      } else if (this.toPosition.y < this.fromPosition.y) {
        action = '进'
      } else {
        num2 = ARABIC_TO_CHINESE[9 - this.toPosition.x]
      }
      if (Piece.isDiagonalPiece(piece)) {
        num2 = ARABIC_TO_CHINESE[9 - this.toPosition.x]
      }
    } else {
      num1 = String(this.fromPosition.x + 1)
      num2 = String(Math.abs(this.toPosition.y - this.fromPosition.y))
      if (this.toPosition.y > this.fromPosition.y) {
        action = '进'
      } else if (this.toPosition.y < this.fromPosition.y) {
        action = '退'
      } else {
        num2 = String(this.toPosition.x + 1)
      }
      if (Piece.isDiagonalPiece(piece)) {
        num2 = String(this.toPosition.x + 1)
      }
    }

    const multiple = findPiecesOnSameVLine(piece, this.fromPosition, board)
    if (multiple == null) {
      return name + num1 + action + num2
    }
    return multiple + name + action + num2
  }

  toString(): string {
    return `Move{${this.fromPosition.toString()} => ${this.toPosition.toString()}, piece=${this.piece}, comment='${this.comment}'}`
  }
}

/*
 * 同一纵线上相同棋子的前/中/后消歧
 * https://www.xqbase.com/protocol/cchess_move.htm
 */
function findPiecesOnSameVLine(piece: number, pos: Position, board: Board): string | null {
  if (
    piece === Piece.BJIANG || piece === Piece.BXIANG || piece === Piece.BSHI ||
    piece === Piece.WSHUAI || piece === Piece.WXIANG || piece === Piece.WSHI
  ) {
    // 仕(士)和相(象)如果在同一纵线上，不用"前"和"后"区别，因为能退的一定在前，能进的一定在后
    return null
  }

  // 找到这一列里有多少相同的子（红方从上往下数、黑方从下往上数，符合"前"的视角）
  let start: number
  let end: number
  let step: number
  if (Piece.isRed(piece)) {
    start = 0
    end = BOARD_PIECE_HEIGHT
    step = 1
  } else {
    start = BOARD_PIECE_HEIGHT - 1
    end = -1
    step = -1
  }
  let count = 0
  let index = 0
  for (let i = start; i !== end; i += step) {
    const p = board.getPieceByXY(pos.x, i)
    if (p === piece) {
      count++
      if (pos.y === i) {
        index = count
      }
    }
  }

  if (count === 1) {
    return null
  }
  if (piece !== Piece.WBING && piece !== Piece.BZU) {
    // 非兵卒，这时 count 只能为 2
    return index === 1 ? '前' : '后'
  }

  // 兵卒：三条以下用"前/中/后"；三条以上用序号（红方中文数字，黑方阿拉伯数字）
  // 注：与 Android 版一致，这里假设其他纵线没有多于一个兵的情况
  // https://www.xqbase.com/protocol/cchess_move.htm
  if (index === 1 && count <= 3) {
    return '前'
  }
  if (index === count && count <= 3) {
    return '后'
  }
  if (index === 2 && count === 3) {
    return '中'
  }
  if (Piece.isRed(piece)) {
    return ARABIC_TO_CHINESE[index]
  }
  return String(index)
}

// UCCI 着法串（如 'h2e2'）→ 中文记谱，便捷函数
export function ucciToChinese(ucci: string, board: Board): string {
  const m = new Move(new Position(0, 0), new Position(0, 0), board)
  if (!m.fromUCCIString(ucci)) return '未知动作'
  m.setBoard(board)
  return m.getChsString(board)
}
