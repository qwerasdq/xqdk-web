// 棋子常量，直译自 chess-dike 的 gamelogic/Piece.java
// 红方以大写字元表达兵种，P A B N R C K 分别代表兵、仕、相、马、炮、车、帅
// 黑方以小写字元表达，     p a b n r c k 分别代表卒、士、象、马、炮、车、将
// https://www.xqbase.com/protocol/cchess_move.htm

export const EMPTY = 0
export const EMPTY_CHAR = ' '

export const WSHUAI = 1 // K, 帅
export const WSHI = 2 // A, 仕
export const WXIANG = 3 // B, 相
export const WMA = 4 // N, 马
export const WJU = 5 // R, 车
export const WPAO = 6 // C, 炮
export const WBING = 7 // P, 兵

export const BJIANG = 8 // k, 将
export const BSHI = 9 // a, 士
export const BXIANG = 10 // b, 象
export const BMA = 11 // n, 马
export const BJU = 12 // r, 车
export const BPAO = 13 // c, 炮
export const BZU = 14 // p, 卒

const pieceCharMap: Record<number, string> = {
  [WSHUAI]: 'K', [WSHI]: 'A', [WXIANG]: 'B', [WMA]: 'N', [WJU]: 'R', [WPAO]: 'C', [WBING]: 'P',
  [BJIANG]: 'k', [BSHI]: 'a', [BXIANG]: 'b', [BMA]: 'n', [BJU]: 'r', [BPAO]: 'c', [BZU]: 'p',
}

const pieceNameMap: Record<number, string> = {
  [WSHUAI]: '帅', [WSHI]: '仕', [WXIANG]: '相', [WMA]: '马', [WJU]: '车', [WPAO]: '炮', [WBING]: '兵',
  [BJIANG]: '将', [BSHI]: '士', [BXIANG]: '象', [BMA]: '马', [BJU]: '车', [BPAO]: '炮', [BZU]: '卒',
}

const pieceValueMap: Record<string, number> = {
  K: WSHUAI, A: WSHI, B: WXIANG, N: WMA, R: WJU, C: WPAO, P: WBING,
  k: BJIANG, a: BSHI, b: BXIANG, n: BMA, r: BJU, c: BPAO, p: BZU,
}

export function isRed(pType: number): boolean {
  return pType <= WBING && pType >= WSHUAI
}

export function isBlack(pType: number): boolean {
  return pType <= BZU && pType >= BJIANG
}

export function isValid(pType: number): boolean {
  return pType <= BZU && pType >= WSHUAI
}

export function isDiagonalPiece(pType: number): boolean {
  return (
    pType === WXIANG || pType === BXIANG || pType === WSHI || pType === BSHI ||
    pType === WMA || pType === BMA
  )
}

export function swapColor(pType: number): number {
  if (pType === EMPTY) return EMPTY
  return isRed(pType) ? pType + (BZU - WBING) : pType - (BZU - WBING)
}

export function getCharByValue(i: number): string {
  return pieceCharMap[i] ?? EMPTY_CHAR
}

export function getNameByValue(i: number): string {
  return pieceNameMap[i] ?? EMPTY_CHAR
}

export function getValueByChar(b: string): number {
  return pieceValueMap[b] ?? EMPTY
}
