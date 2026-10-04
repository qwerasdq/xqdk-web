// YOLO 类别表，移植自 Android assist/YoloDetections.kt
// 模型输出 [1,25200,20]：4 框参数 + 1 objectness + 15 类分（14 种棋子 + 1 整体棋盘框）
import * as Piece from '../xiangqi/piece'

export const LABEL_BOARD = 14
export const NUM_CLASSES = 15

// labelId 0..13 依次对应（与 VinXiangQi 训练定义一致）：
// b_ma b_xiang b_shi b_jiang b_che b_pao b_bing r_che r_ma r_shi r_jiang r_xiang r_pao r_bing
export const PIECE_CODES: readonly number[] = [
  Piece.BMA, Piece.BXIANG, Piece.BSHI, Piece.BJIANG, Piece.BJU, Piece.BPAO, Piece.BZU,
  Piece.WJU, Piece.WMA, Piece.WSHI, Piece.WSHUAI, Piece.WXIANG, Piece.WPAO, Piece.WBING,
  -1, // board
]
