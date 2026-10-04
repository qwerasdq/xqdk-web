// 对局状态机，基于 chess-dike 的 gamelogic/Game.java 直译 + Web 版增强：
// - 重复局面判和（Zobrist 局面键计数，同一局面第 3 次出现判和）
// - 长将判负（一方连续将军 ≥8 步判负，MVP 简化规则）
// - 困毙判负（对方无合法着法且未被将军）
// - 终局（将死）判定

import { Position } from './position'
import { Board } from './board'
import { Move } from './move'
import * as Piece from './piece'
import { findJiangShuaiPos, isJiangShuaiInDanger, isJiangShuaiDead, isStalemated, isValidMove, legalMoves } from './rule'

export enum GameStatus {
  SELECT = 'SELECT', // 棋子被选择，或者取消选择
  MOVE = 'MOVE', // 棋子移动
  CHECK = 'CHECK', // 将军
  CHECKMATE = 'CHECKMATE', // 将死
  STALEMATE = 'STALEMATE', // 困毙
  DRAW = 'DRAW', // 和棋（重复局面）
  ILLEGAL = 'ILLEGAL', // 非法移动
  WIN = 'WIN', // 胜利
  LOSE = 'LOSE', // 失败
  PERPETUAL_CHECK = 'PERPETUAL_CHECK', // 长将判负
}

export interface HistoryRecord {
  move: Move
  ucciString: string
  chsString: string
  isRedMove: boolean
}

export interface GameState {
  status: GameStatus
  board: Board
  history: HistoryRecord[]
  check: boolean
  /** 长将方（被判负的一方），PERPETUAL_CHECK 时有值 */
  perpetualCheckSide?: 'red' | 'black'
}

const MAX_PERPETUAL_CHECK_STEPS = 8 // 长将判负：连续将军步数阈值（MVP 简化规则）
const DRAW_DEFER_CHECK_THRESHOLD = 4 // 连续将军达到该值时，重复判和推迟、优先等长将判定

export class Game {
  currentBoard: Board
  history: HistoryRecord[] = []
  startPos: Position | null = null
  endPos: Position | null = null
  possibleToPositions: Position[] = []
  isGameOver = false

  // 局面键计数：同一局面（含行棋方）第 3 次出现判和
  private positionCount = new Map<string, number>()
  // 将军方连续将军计数（用于长将判定；对方中间着法不打断累计）
  private consecutiveCheckCount = 0
  private lastCheckingMover: 'red' | 'black' | null = null
  // 初始局面（悔棋重放起点；FEN 开局时不是标准开局）
  private initialBoard: Board

  constructor(isRedGoFirst = true) {
    this.currentBoard = new Board()
    this.currentBoard.bRedGo = isRedGoFirst
    this.initialBoard = this.currentBoard.clone()
    this.recordPosition()
  }

  // 对局起始局面 FEN。
  // 引擎 position 命令必须用它：`position fen <startFen> moves <history>`。
  // 若改传「当前 FEN + 全历史」，历史着法在现局面中合法时会被重复应用（如马往返后）导致局面错误。
  get startFen(): string {
    return this.initialBoard.toFENString()
  }

  // 从 FEN 初始化
  restoreFromFEN(fen: string): boolean {
    const ok = this.currentBoard.restoreFromFEN(fen)
    if (ok) {
      this.history = []
      this.isGameOver = false
      this.positionCount.clear()
      this.consecutiveCheckCount = 0
      this.initialBoard = this.currentBoard.clone()
      this.recordPosition()
    }
    return ok
  }

  private recordPosition(): void {
    const key = this.currentBoard.getZobrist(this.currentBoard.bRedGo).toString()
    this.positionCount.set(key, (this.positionCount.get(key) ?? 0) + 1)
  }

  // 选中棋子，返回合法落点
  selectPosition(pos: Position): Position[] {
    const piece = this.currentBoard.getPieceByPosition(pos)
    if (!Piece.isValid(piece)) return []
    if (Piece.isRed(piece) !== this.currentBoard.bRedGo) return []
    this.startPos = pos
    this.possibleToPositions = legalMoves(piece, pos.x, pos.y, this.currentBoard)
    return this.possibleToPositions
  }

  // 走子（用户/AI 共用入口），返回走子后的对局状态
  movePiece(from: Position, to: Position): GameState {
    this.startPos = null
    this.possibleToPositions = []

    const piece = this.currentBoard.getPieceByPosition(from)
    if (!Piece.isValid(piece)) {
      return this.state(GameStatus.ILLEGAL)
    }
    if (Piece.isRed(piece) !== this.currentBoard.bRedGo) {
      return this.state(GameStatus.ILLEGAL)
    }
    if (!isValidMove(from, to, this.currentBoard)) {
      return this.state(GameStatus.ILLEGAL)
    }

    // 记录历史（走子前的棋盘用于悔棋）
    const boardBefore = this.currentBoard.clone()
    const move = new Move(new Position(from.x, from.y), new Position(to.x, to.y), boardBefore)
    const chsString = move.getChsString(boardBefore)
    const ucciString = move.getUCCIString()
    this.history.push({ move, ucciString, chsString, isRedMove: Piece.isRed(piece) })

    // 执行走子
    this.currentBoard.doMove(from, to)
    this.recordPosition()

    return this.updateGameStatus()
  }

  // 悔棋，返回被撤销的记录
  undoMove(): HistoryRecord | null {
    const record = this.history.pop()
    if (record) {
      // 从初始局面重放剩余历史，重建当前局面
      this.currentBoard = this.initialBoard.clone()
      for (const rec of this.history) {
        this.currentBoard.tryMove(rec.move.fromPosition, rec.move.toPosition)
        this.currentBoard.bRedGo = !this.currentBoard.bRedGo
        this.currentBoard.rounds++
      }
      this.isGameOver = false
      this.startPos = null
      this.possibleToPositions = []
      this.rebuildPositionCount()
    }
    return record ?? null
  }

  private rebuildPositionCount(): void {
    this.positionCount.clear()
    this.consecutiveCheckCount = 0
    const b = this.initialBoard.clone()
    const record = (board: Board) => {
      const key = board.getZobrist(board.bRedGo).toString()
      this.positionCount.set(key, (this.positionCount.get(key) ?? 0) + 1)
    }
    record(b)
    for (const rec of this.history) {
      b.tryMove(rec.move.fromPosition, rec.move.toPosition)
      b.bRedGo = !b.bRedGo
      b.rounds++
      record(b)
    }
  }

  // 走子后更新对局状态：将死 / 困毙 / 重复判和 / 长将判负 / 将军
  updateGameStatus(): GameState {
    // 检查对方（刚被走完一步后轮到行棋的一方）
    const sideToMove = this.currentBoard.bRedGo ? 'red' : 'black'
    const sideKing = this.currentBoard.bRedGo ? Piece.WSHUAI : Piece.BJIANG
    const kingPos = findJiangShuaiPos(sideKing, this.currentBoard)

    const isCheck = kingPos != null && isJiangShuaiInDanger(sideKing, kingPos, this.currentBoard)

    if (isCheck) {
      // 将军方 = 刚走完的一方
      const mover: 'red' | 'black' = this.currentBoard.bRedGo ? 'black' : 'red'
      this.consecutiveCheckCount = this.lastCheckingMover === mover ? this.consecutiveCheckCount + 1 : 1
      this.lastCheckingMover = mover
      if (kingPos != null && isJiangShuaiDead(sideKing, kingPos, this.currentBoard)) {
        this.isGameOver = true
        // 被将死：行棋方（被将军方）判负
        return this.state(GameStatus.CHECKMATE)
      }
      // 长将判负（优先于重复判和，符合亚洲规则"长将方判负"）：
      // 同一方连续将军达到阈值，且当前局面已出现循环（局面键 ≥3 次）
      const key = this.currentBoard.getZobrist(this.currentBoard.bRedGo).toString()
      if (this.consecutiveCheckCount >= MAX_PERPETUAL_CHECK_STEPS && (this.positionCount.get(key) ?? 0) >= 3) {
        this.isGameOver = true
        // 将军方（刚走完的一方）长将判负
        return this.state(GameStatus.PERPETUAL_CHECK, mover)
      }
      return this.state(GameStatus.CHECK)
    }

    // 本次不将军：若将军方自己中断了连续将军，则重置计数
    const mover: 'red' | 'black' = this.currentBoard.bRedGo ? 'black' : 'red'
    if (this.lastCheckingMover === mover) {
      this.consecutiveCheckCount = 0
      this.lastCheckingMover = null
    }

    // 重复局面判和：当前局面（含行棋方）第 3 次出现
    // 例外：对方正处于连续将军循环中（长将周期内被将军方来回躲避），
    // 推迟判和，等将军计数达到阈值时按长将判负（亚洲规则：长将方判负优先于判和）
    const key = this.currentBoard.getZobrist(this.currentBoard.bRedGo).toString()
    if ((this.positionCount.get(key) ?? 0) >= 3) {
      if (this.consecutiveCheckCount < DRAW_DEFER_CHECK_THRESHOLD) {
        this.isGameOver = true
        return this.state(GameStatus.DRAW)
      }
    }

    // 困毙判负：行棋方无合法着法且未被将军
    if (isStalemated(sideKing, this.currentBoard)) {
      this.isGameOver = true
      return this.state(GameStatus.STALEMATE)
    }

    return this.state(GameStatus.MOVE)
  }

  private state(status: GameStatus, perpetualCheckSide?: 'red' | 'black'): GameState {
    return {
      status,
      board: this.currentBoard.clone(),
      history: [...this.history],
      check: status === GameStatus.CHECK || status === GameStatus.CHECKMATE,
      perpetualCheckSide,
    }
  }
}

// 便捷：取某方将帅是否被将军
export function isSideInCheck(board: Board, redSide: boolean): boolean {
  const king = redSide ? Piece.WSHUAI : Piece.BJIANG
  const pos = findJiangShuaiPos(king, board)
  if (pos == null) return false
  return isJiangShuaiInDanger(king, pos, board)
}
