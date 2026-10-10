// 棋规：走法生成、将军/将死判定，直译自 chess-dike 的 gamelogic/Rule.java
// Web 版增强：新增 legalMoves（完整合法着法 = 走后不送将 + 不照面）与
// isStalemated（困毙判定），补上 Android 版缺失的规则。

import { Position } from './position'
import * as Piece from './piece'
import { Board, BOARD_PIECE_WIDTH, BOARD_PIECE_HEIGHT } from './board'

// 区域表：0 棋盘外 1 黑盘 2 黑十字 3 红盘 4 红十字
const area: number[][] = [
  [1, 1, 1, 2, 2, 2, 1, 1, 1],
  [1, 1, 1, 2, 2, 2, 1, 1, 1],
  [1, 1, 1, 2, 2, 2, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1],
  [3, 3, 3, 3, 3, 3, 3, 3, 3],
  [3, 3, 3, 3, 3, 3, 3, 3, 3],
  [3, 3, 3, 4, 4, 4, 3, 3, 3],
  [3, 3, 3, 4, 4, 4, 3, 3, 3],
  [3, 3, 3, 4, 4, 4, 3, 3, 3],
]

const offsetX: number[][] = [
  [0, 0, 1, -1], // 帅 将
  [1, 1, -1, -1], // 仕 士
  [2, 2, -2, -2], // 相 象
  [1, 1, -1, -1], // 象眼
  [1, 1, -1, -1, 2, 2, -2, -2], // 马
  [0, 0, 0, 0, 1, 1, -1, -1], // 蹩马腿
  [0], // 卒
  [-1, 0, 1], // 过河卒
  [0], // 兵
  [-1, 0, 1], // 过河兵
  [1, 1, -1, -1, 1, 1, -1, -1], // 反向蹩马腿
]

const offsetY: number[][] = [
  [1, -1, 0, 0], // 帅 将
  [1, -1, 1, -1], // 仕 士
  [2, -2, 2, -2], // 相 象
  [1, -1, 1, -1], // 象眼
  [2, -2, 2, -2, 1, -1, 1, -1], // 马
  [1, -1, 1, -1, 0, 0, 0, 0], // 蹩马腿
  [1], // 卒
  [0, 1, 0], // 过河卒
  [-1], // 兵
  [0, -1, 0], // 过河兵
  [1, -1, 1, -1, 1, -1, 1, -1], // 反向蹩马腿
]

function inArea(x: number, y: number): number {
  if (x < 0 || x >= BOARD_PIECE_WIDTH || y < 0 || y >= BOARD_PIECE_HEIGHT) {
    return 0
  }
  return area[y][x]
}

function onSameSide(fromID: number, toID: number): boolean {
  if (!Piece.isValid(toID) || !Piece.isValid(fromID)) {
    return false
  }
  return Piece.isRed(fromID) === Piece.isRed(toID)
}

// 飞将：检查将帅是否在同一列且中间无遮挡。若是，返回对方将帅位置，否则返回 null
function flyKing(id: number, fromX: number, fromY: number, board: Board): Position | null {
  if (id === Piece.BJIANG) {
    for (let i = fromY + 1; i < BOARD_PIECE_HEIGHT; i++) {
      const pieceid = board.getPieceByXY(fromX, i)
      if (Piece.isValid(pieceid)) {
        return pieceid === Piece.WSHUAI ? new Position(fromX, i) : null
      }
    }
  } else if (id === Piece.WSHUAI) {
    for (let i = fromY - 1; i >= 0; i--) {
      const pieceid = board.getPieceByXY(fromX, i)
      if (Piece.isValid(pieceid)) {
        return pieceid === Piece.BJIANG ? new Position(fromX, i) : null
      }
    }
  }
  return null
}

// 在棋盘中找到将帅的位置（九宫内搜索）
export function findJiangShuaiPos(piece: number, board: Board): Position | null {
  if (piece === Piece.WSHUAI) {
    for (let y = 7; y <= 9; y++) {
      for (let x = 3; x <= 5; x++) {
        if (board.getPieceByXY(x, y) === Piece.WSHUAI) {
          return new Position(x, y)
        }
      }
    }
  } else if (piece === Piece.BJIANG) {
    for (let y = 0; y <= 2; y++) {
      for (let x = 3; x <= 5; x++) {
        if (board.getPieceByXY(x, y) === Piece.BJIANG) {
          return new Position(x, y)
        }
      }
    }
  }
  return null
}

// 生成棋子可到达的位置（不含"走后送将/照面"过滤，与 Android 版语义一致）
export function possibleToPositions(pieceId: number, fromX: number, fromY: number, board: Board): Position[] {
  const ret: Position[] = []
  let num: number
  switch (pieceId) {
    case Piece.BJIANG: // 黑将
      num = 0
      for (let i = 0; i < offsetX[num].length; i++) {
        const toX = fromX + offsetX[num][i]
        const toY = fromY + offsetY[num][i]
        if (inArea(toX, toY) === 2 && !onSameSide(pieceId, board.getPieceByXY(toX, toY))) {
          if (flyKing(Piece.BJIANG, toX, toY, board) == null) {
            ret.push(new Position(toX, toY))
          }
        }
      }
      break
    case Piece.BSHI: // 黑士
      num = 1
      for (let i = 0; i < offsetX[num].length; i++) {
        const toX = fromX + offsetX[num][i]
        const toY = fromY + offsetY[num][i]
        if (inArea(toX, toY) === 2 && !onSameSide(pieceId, board.getPieceByXY(toX, toY))) {
          ret.push(new Position(toX, toY))
        }
      }
      break
    case Piece.BXIANG: // 黑象
      num = 2
      for (let i = 0; i < offsetX[num].length; i++) {
        const toX = fromX + offsetX[num][i]
        const toY = fromY + offsetY[num][i]
        const blockX = fromX + offsetX[num + 1][i]
        const blockY = fromY + offsetY[num + 1][i]
        if (
          inArea(toX, toY) >= 1 && inArea(toX, toY) <= 2 &&
          !onSameSide(pieceId, board.getPieceByXY(toX, toY)) &&
          !Piece.isValid(board.getPieceByXY(blockX, blockY))
        ) {
          ret.push(new Position(toX, toY))
        }
      }
      break
    case Piece.BMA: // 黑马
    case Piece.WMA: // 红马
      num = 4
      for (let i = 0; i < offsetX[num].length; i++) {
        const toX = fromX + offsetX[num][i]
        const toY = fromY + offsetY[num][i]
        const blockX = fromX + offsetX[num + 1][i]
        const blockY = fromY + offsetY[num + 1][i]
        if (
          inArea(toX, toY) !== 0 &&
          !onSameSide(pieceId, board.getPieceByXY(toX, toY)) &&
          !Piece.isValid(board.getPieceByXY(blockX, blockY))
        ) {
          ret.push(new Position(toX, toY))
        }
      }
      break
    case Piece.BJU: // 黑车
    case Piece.WJU: // 红车
      for (let i = fromY + 1; i < BOARD_PIECE_HEIGHT; i++) {
        if (canMove(Piece.BJU, fromX, fromY, fromX, i, board)) {
          ret.push(new Position(fromX, i))
        } else {
          break
        }
      }
      for (let i = fromY - 1; i >= 0; i--) {
        if (canMove(Piece.BJU, fromX, fromY, fromX, i, board)) {
          ret.push(new Position(fromX, i))
        } else {
          break
        }
      }
      for (let j = fromX - 1; j >= 0; j--) {
        if (canMove(Piece.BJU, fromX, fromY, j, fromY, board)) {
          ret.push(new Position(j, fromY))
        } else {
          break
        }
      }
      for (let j = fromX + 1; j < BOARD_PIECE_WIDTH; j++) {
        if (canMove(Piece.BJU, fromX, fromY, j, fromY, board)) {
          ret.push(new Position(j, fromY))
        } else {
          break
        }
      }
      break
    case Piece.BPAO: // 黑炮
    case Piece.WPAO: // 红炮
      for (let i = fromY + 1; i < BOARD_PIECE_HEIGHT; i++) {
        if (canMove(Piece.BPAO, fromX, fromY, fromX, i, board)) {
          ret.push(new Position(fromX, i))
        }
      }
      for (let i = fromY - 1; i >= 0; i--) {
        if (canMove(Piece.BPAO, fromX, fromY, fromX, i, board)) {
          ret.push(new Position(fromX, i))
        }
      }
      for (let j = fromX - 1; j >= 0; j--) {
        if (canMove(Piece.BPAO, fromX, fromY, j, fromY, board)) {
          ret.push(new Position(j, fromY))
        }
      }
      for (let j = fromX + 1; j < BOARD_PIECE_WIDTH; j++) {
        if (canMove(Piece.BPAO, fromX, fromY, j, fromY, board)) {
          ret.push(new Position(j, fromY))
        }
      }
      break
    case Piece.BZU: // 黑卒
      if (inArea(fromX, fromY) === 1) {
        num = 6
        for (let i = 0; i < offsetX[num].length; i++) {
          const toX = fromX + offsetX[num][i]
          const toY = fromY + offsetY[num][i]
          if (inArea(toX, toY) !== 0 && !onSameSide(pieceId, board.getPieceByXY(toX, toY))) {
            ret.push(new Position(toX, toY))
          }
        }
      } else {
        // 过河卒
        num = 7
        for (let i = 0; i < offsetX[num].length; i++) {
          const toX = fromX + offsetX[num][i]
          const toY = fromY + offsetY[num][i]
          if (inArea(toX, toY) !== 0 && !onSameSide(pieceId, board.getPieceByXY(toX, toY))) {
            ret.push(new Position(toX, toY))
          }
        }
      }
      break
    case Piece.WSHUAI: // 红帅
      num = 0
      for (let i = 0; i < offsetX[num].length; i++) {
        const toX = fromX + offsetX[num][i]
        const toY = fromY + offsetY[num][i]
        if (inArea(toX, toY) === 4 && !onSameSide(pieceId, board.getPieceByXY(toX, toY))) {
          if (flyKing(Piece.WSHUAI, toX, toY, board) == null) {
            ret.push(new Position(toX, toY))
          }
        }
      }
      break
    case Piece.WSHI: // 红士
      num = 1
      for (let i = 0; i < offsetX[num].length; i++) {
        const toX = fromX + offsetX[num][i]
        const toY = fromY + offsetY[num][i]
        if (inArea(toX, toY) === 4 && !onSameSide(pieceId, board.getPieceByXY(toX, toY))) {
          ret.push(new Position(toX, toY))
        }
      }
      break
    case Piece.WXIANG: // 红象
      num = 2
      for (let i = 0; i < offsetX[num].length; i++) {
        const toX = fromX + offsetX[num][i]
        const toY = fromY + offsetY[num][i]
        const blockX = fromX + offsetX[num + 1][i]
        const blockY = fromY + offsetY[num + 1][i]
        if (
          inArea(toX, toY) >= 3 && inArea(toX, toY) <= 4 &&
          !onSameSide(pieceId, board.getPieceByXY(toX, toY)) &&
          !Piece.isValid(board.getPieceByXY(blockX, blockY))
        ) {
          ret.push(new Position(toX, toY))
        }
      }
      break
    case Piece.WBING: // 红兵
      if (inArea(fromX, fromY) === 3) {
        num = 8
        for (let i = 0; i < offsetX[num].length; i++) {
          const toX = fromX + offsetX[num][i]
          const toY = fromY + offsetY[num][i]
          if (inArea(toX, toY) !== 0 && !onSameSide(pieceId, board.getPieceByXY(toX, toY))) {
            ret.push(new Position(toX, toY))
          }
        }
      } else {
        // 过河兵
        num = 9
        for (let i = 0; i < offsetX[num].length; i++) {
          const toX = fromX + offsetX[num][i]
          const toY = fromY + offsetY[num][i]
          if (inArea(toX, toY) !== 0 && !onSameSide(pieceId, board.getPieceByXY(toX, toY))) {
            ret.push(new Position(toX, toY))
          }
        }
      }
      break
    default:
      break
  }
  return ret
}

// 完整合法着法：possibleToPositions 基础上过滤"走后本方将帅被将军"和"走后将帅照面"
// （Android 版只对将帅自身做了飞将过滤，其他棋子走后送将/照面由引擎兜底；
//  Web 端规则层独立，补上完整校验）
export function legalMoves(pieceId: number, fromX: number, fromY: number, board: Board): Position[] {
  const ret: Position[] = []
  const sideKing = Piece.isRed(pieceId) ? Piece.WSHUAI : Piece.BJIANG
  for (const to of possibleToPositions(pieceId, fromX, fromY, board)) {
    const b = board.clone()
    b.tryMove(new Position(fromX, fromY), to)
    // 将帅自身的照面已由 possibleToPositions 的 flyKing 检查，此处统一再查一遍
    const kingPos = findJiangShuaiPos(sideKing, b)
    if (kingPos == null) continue
    if (isJiangShuaiInDanger(sideKing, kingPos, b)) continue
    if (sideKing === Piece.WSHUAI && flyKing(Piece.WSHUAI, kingPos.x, kingPos.y, b) != null) continue
    if (sideKing === Piece.BJIANG && flyKing(Piece.BJIANG, kingPos.x, kingPos.y, b) != null) continue
    ret.push(to)
  }
  return ret
}

// 检查走法是否属于可到达位置（含"走后送将"过滤的完整校验用 legalMoves）
export function isValidMove(from: Position, to: Position, board: Board): boolean {
  if (from == null || to == null) return false
  const piece = board.getPieceByPosition(from)
  if (!Piece.isValid(piece)) return false
  return legalMoves(piece, from.x, from.y, board).some((pos) => pos.equals(to))
}

// 判断将帅是否被将军
export function isJiangShuaiInDanger(piece: number, pos: Position, board: Board): boolean {
  const num = 4 // 马的攻击和别腿
  const opBlockNum = 10 // 反向蹩马腿

  if (piece === Piece.WSHUAI) {
    const x = pos.x
    const y = pos.y
    // 被黑马攻击
    for (let i = 0; i < offsetX[num].length; i++) {
      const toX = x + offsetX[num][i]
      const toY = y + offsetY[num][i]
      const blockX = x + offsetX[opBlockNum][i]
      const blockY = y + offsetY[opBlockNum][i]
      if (
        inArea(toX, toY) !== 0 &&
        board.getPieceByXY(toX, toY) === Piece.BMA &&
        !Piece.isValid(board.getPieceByXY(blockX, blockY))
      ) {
        return true
      }
    }
    // 被黑车/黑炮攻击
    if (attackableByJuPao(Piece.BJU, x, y, board)) return true
    if (attackableByJuPao(Piece.BPAO, x, y, board)) return true
    // 被黑卒攻击
    if (
      board.getPieceByXY(x - 1, y) === Piece.BZU ||
      board.getPieceByXY(x + 1, y) === Piece.BZU ||
      board.getPieceByXY(x, y - 1) === Piece.BZU
    ) {
      return true
    }
  } else if (piece === Piece.BJIANG) {
    const x = pos.x
    const y = pos.y
    // 被红马攻击
    for (let i = 0; i < offsetX[num].length; i++) {
      const toX = x + offsetX[num][i]
      const toY = y + offsetY[num][i]
      const blockX = x + offsetX[opBlockNum][i]
      const blockY = y + offsetY[opBlockNum][i]
      if (
        inArea(toX, toY) !== 0 &&
        board.getPieceByXY(toX, toY) === Piece.WMA &&
        !Piece.isValid(board.getPieceByXY(blockX, blockY))
      ) {
        return true
      }
    }
    // 被红车/红炮攻击
    if (attackableByJuPao(Piece.WJU, x, y, board)) return true
    if (attackableByJuPao(Piece.WPAO, x, y, board)) return true
    // 被红兵攻击
    if (
      board.getPieceByXY(x - 1, y) === Piece.WBING ||
      board.getPieceByXY(x + 1, y) === Piece.WBING ||
      board.getPieceByXY(x, y + 1) === Piece.WBING
    ) {
      return true
    }
  }
  return false
}

/** 坐标 → UCCI 着法串（列 a-i，行 0-9，a0 为左下），与 Move.getUCCIString 同口径 */
function toUcci(fx: number, fy: number, tx: number, ty: number): string {
  return (
    String.fromCharCode(97 + fx) + (9 - fy) + String.fromCharCode(97 + tx) + (9 - ty)
  )
}

/**
 * 当前行棋方的全部合法着法（UCCI 串数组）。
 * 用途：UCI 没有「排除着法」指令，searchmoves 是「只搜这些」，
 * 需要排除某步时必须传「全部合法着法 − 排除项」。
 */
export function allLegalMoves(board: Board): string[] {
  const result: string[] = []
  const redSide = board.bRedGo
  for (let y = 0; y < BOARD_PIECE_HEIGHT; y++) {
    for (let x = 0; x < BOARD_PIECE_WIDTH; x++) {
      const piece = board.getPieceByXY(x, y)
      if (!Piece.isValid(piece)) continue
      if (Piece.isRed(piece) !== redSide) continue
      for (const to of legalMoves(piece, x, y, board)) {
        result.push(toUcci(x, y, to.x, to.y))
      }
    }
  }
  return result
}

// 判断将帅是否被将死：枚举己方全部着法逐一尝试解将，全部失败则为将死
export function isJiangShuaiDead(piece: number, bossPos: Position, board: Board): boolean {
  const b = board.clone()
  const isRedSide = piece === Piece.WSHUAI
  for (let y = 0; y < BOARD_PIECE_HEIGHT; y++) {
    for (let x = 0; x < BOARD_PIECE_WIDTH; x++) {
      const pieceId = b.getPieceByXY(x, y)
      if (isRedSide ? Piece.isRed(pieceId) : Piece.isBlack(pieceId)) {
        for (const to of possibleToPositions(pieceId, x, y, b)) {
          const tempPieceId = b.getPieceByPosition(to)
          b.tryMove(new Position(x, y), to)
          const result =
            pieceId === piece
              ? isJiangShuaiInDanger(piece, to, b)
              : isJiangShuaiInDanger(piece, bossPos, b)
          if (!result) {
            return false
          }
          // revert
          b.setPieceByXY(x, y, pieceId)
          b.setPieceByPosition(to, tempPieceId)
        }
      }
    }
  }
  return true
}

// 困毙判定（Web 版新增，Android 版缺失）：
// 对方无任何合法着法（所有着法都会导致本方将帅被将军/照面）且当前未被将军 → 困毙判负
// 注意：若对方连将帅都没有（残局摆棋），视为无着可走 → 判困毙
export function isStalemated(sideKing: number, board: Board): boolean {
  const kingPos = findJiangShuaiPos(sideKing, board)
  if (kingPos == null) return true
  if (isJiangShuaiInDanger(sideKing, kingPos, board)) return false
  return isJiangShuaiDead(sideKing, kingPos, board)
}

// 判断 (x,y) 是否被 piece 攻击，piece 只能是车或炮
function attackableByJuPao(piece: number, x: number, y: number, board: Board): boolean {
  if (!(piece === Piece.BJU || piece === Piece.BPAO || piece === Piece.WJU || piece === Piece.WPAO)) {
    return false
  }
  for (const pos of possibleToPositions(piece, x, y, board)) {
    if (board.getPieceByPosition(pos) === piece) {
      return true
    }
  }
  return false
}

function canMove(id: number, fromX: number, fromY: number, toX: number, toY: number, board: Board): boolean {
  if (
    fromX < 0 || fromX >= BOARD_PIECE_WIDTH || fromY < 0 || fromY >= BOARD_PIECE_HEIGHT ||
    toX < 0 || toX >= BOARD_PIECE_WIDTH || toY < 0 || toY >= BOARD_PIECE_HEIGHT
  ) {
    return false
  }
  if (fromX === toX && fromY === toY) {
    return false
  }
  if (onSameSide(board.getPieceByXY(fromX, fromY), board.getPieceByXY(toX, toY))) {
    return false
  }

  if (id === Piece.BJU || id === Piece.WJU) {
    // 车：已验证终点和自己非同一颜色，验证中间无子即可
    let start: number
    let finish: number
    if (fromX === toX) {
      // 进退
      if (fromY < toY) {
        start = fromY + 1
        finish = toY
      } else {
        start = toY + 1
        finish = fromY
      }
      for (let i = start; i < finish; i++) {
        if (Piece.isValid(board.getPieceByXY(fromX, i))) {
          return false
        }
      }
    } else {
      // 平移
      if (fromX < toX) {
        start = fromX + 1
        finish = toX
      } else {
        start = toX + 1
        finish = fromX
      }
      for (let i = start; i < finish; i++) {
        if (Piece.isValid(board.getPieceByXY(i, fromY))) {
          return false
        }
      }
    }
  } else if (id === Piece.BPAO || id === Piece.WPAO) {
    // 炮
    if (!Piece.isValid(board.getPieceByXY(toX, toY))) {
      // 终点无子，属于移动，验证中间无子即可
      let start: number
      let finish: number
      if (fromX === toX) {
        if (fromY < toY) {
          start = fromY + 1
          finish = toY
        } else {
          start = toY + 1
          finish = fromY
        }
        for (let i = start; i < finish; i++) {
          if (Piece.isValid(board.getPieceByXY(fromX, i))) {
            return false
          }
        }
      } else {
        if (fromX < toX) {
          start = fromX + 1
          finish = toX
        } else {
          start = toX + 1
          finish = fromX
        }
        for (let i = start; i < finish; i++) {
          if (Piece.isValid(board.getPieceByXY(i, fromY))) {
            return false
          }
        }
      }
    } else {
      // 终点有子，属于吃子，验证中间只有一子
      let start: number
      let finish: number
      let count = 0
      if (fromX === toX) {
        if (fromY < toY) {
          start = fromY + 1
          finish = toY
        } else {
          start = toY + 1
          finish = fromY
        }
        for (let i = start; i < finish; i++) {
          if (Piece.isValid(board.getPieceByXY(fromX, i))) {
            count++
          }
        }
      } else {
        if (fromX < toX) {
          start = fromX + 1
          finish = toX
        } else {
          start = toX + 1
          finish = fromX
        }
        for (let i = start; i < finish; i++) {
          if (Piece.isValid(board.getPieceByXY(i, fromY))) {
            count++
          }
        }
      }
      if (count !== 1) {
        return false
      }
    }
  }
  return true
}
