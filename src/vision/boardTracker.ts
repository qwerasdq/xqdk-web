// 稳定帧跟踪器，直译自 Android assist/RecognitionTypes.kt 的 BoardTracker
// 连续 confirmCount 帧出现同一局面才确认，并推断轮次/检测重开

import { equal, matchStartCount, movedSide } from './assistBoard'
import type { RecognitionResult, TrackerEvent } from './types'
import { isResultValid } from './types'

export class BoardTracker {
  /** 当前确认局面 */
  confirmed: RecognitionResult | null = null
  /** 红方走子方（提示用；Game 的 bRedGo 才是权威） */
  redGo = true
  /** 连续未确认帧数（用于提示） */
  unstableStreak = 0
  /** 最近一次确认新局面的移动方（由前后局面 diff 推断；非 NEW_BOARD 时为 null） */
  lastMovedSide: 'red' | 'black' | null = null

  private candidate: RecognitionResult | null = null
  private candidateHits = 0

  constructor(private readonly confirmCount = 3) {}

  reset(redGoFirst = true): void {
    this.confirmed = null
    this.candidate = null
    this.candidateHits = 0
    this.unstableStreak = 0
    this.redGo = redGoFirst
    this.lastMovedSide = null
  }

  /** 外部（悔棋/手动改盘后）重设确认局面，后续帧可正常重新确认 */
  restore(result: RecognitionResult, redGoSide: boolean): void {
    this.confirmed = result
    this.redGo = redGoSide
    this.candidate = null
    this.candidateHits = 0
    this.unstableStreak = 0
    this.lastMovedSide = null
  }

  onFrame(res: RecognitionResult): TrackerEvent {
    this.lastMovedSide = null
    const prev = this.confirmed
    if (!isResultValid(res)) {
      this.unstableStreak++
      return 'UNSTABLE'
    }

    if (prev === null) {
      // 首次确认：连续 confirmCount 帧完全一致才确认；确认时与开局完全一致视为全新对局
      if (this.candidate !== null && equal(res.canonical, this.candidate.canonical)) {
        this.candidateHits++
      } else {
        this.candidate = res
        this.candidateHits = 1
      }
      if (this.candidateHits >= this.confirmCount) {
        this.confirmed = this.candidate
        const first = this.candidate
        this.candidate = null
        this.candidateHits = 0
        this.unstableStreak = 0
        return matchStartCount(first.canonical) >= 32 ? 'NEW_GAME' : 'NEW_BOARD'
      }
      this.unstableStreak++
      return 'UNSTABLE'
    }

    // 重开检测：与开局完全一致（32 子）且不同于当前 → 新对局（放在子数跳变门限之前）
    if (matchStartCount(res.canonical) >= 32 && !equal(res.canonical, prev.canonical)) {
      this.confirmed = res
      this.redGo = true
      this.candidate = null
      this.candidateHits = 0
      this.unstableStreak = 0
      return 'NEW_GAME'
    }

    // 子数跳变门限：真实走子只 ±1（吃子 -1），检测噪声通常 ±2~3
    const tol = Math.max(2, Math.floor(prev.recognizedPieces / 10))
    if (Math.abs(res.recognizedPieces - prev.recognizedPieces) > tol) {
      this.candidate = null
      this.candidateHits = 0
      this.unstableStreak++
      return 'UNSTABLE'
    }

    const same = equal(res.canonical, prev.canonical)
    if (same) {
      this.candidate = null
      this.candidateHits = 0
      this.unstableStreak = 0
      return 'SAME_BOARD'
    }

    // 与候选一致则累计
    if (this.candidate !== null && equal(res.canonical, this.candidate.canonical)) {
      this.candidateHits++
    } else {
      this.candidate = res
      this.candidateHits = 1
    }
    if (this.candidateHits >= this.confirmCount) {
      const newBoard = this.candidate
      const moved = movedSide(prev.canonical, newBoard.canonical)
      if (moved !== null) {
        this.lastMovedSide = moved
        this.redGo = moved !== 'red' // 移动方是红 => 下一手是黑
      }
      this.confirmed = newBoard
      this.candidate = null
      this.candidateHits = 0
      this.unstableStreak = 0
      return 'NEW_BOARD'
    }
    this.unstableStreak++
    return 'UNSTABLE'
  }
}
